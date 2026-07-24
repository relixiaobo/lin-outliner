import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgentToolPathValue, pathSegments } from './agentToolPath';
import { getAgentProcessExecutor } from './agentProcessExecutor';

export type RipgrepMode = 'env' | 'bundled' | 'system';

export interface ResolvedRipgrepCommand {
  command: string;
  argsPrefix: string[];
  mode: RipgrepMode;
  binDir?: string;
  source: string;
  version: string;
}

const RIPGREP_COMMAND_ENV = 'LIN_AGENT_RIPGREP_COMMAND';
const RIPGREP_VENDOR_ROOT_ENV = 'LIN_AGENT_RIPGREP_VENDOR_ROOT';
const RIPGREP_PROBE_TIMEOUT_MS = 5_000;

let cachedResolution: { signature: string; promise: Promise<ResolvedRipgrepCommand> } | undefined;

export async function resolveRipgrepCommand(cwd: string): Promise<ResolvedRipgrepCommand> {
  const signature = ripgrepResolutionSignature();
  if (cachedResolution?.signature === signature) return cachedResolution.promise;
  const promise = resolveRipgrepCommandUncached(cwd);
  cachedResolution = { signature, promise };
  try {
    return await promise;
  } catch (error) {
    if (cachedResolution?.promise === promise) cachedResolution = undefined;
    throw error;
  }
}

export function getBundledRipgrepBinDirForPath(): string | undefined {
  const executablePath = getBundledRipgrepExecutablePath();
  return executablePath ? path.dirname(executablePath) : undefined;
}

export function getBundledRipgrepExecutablePath(): string | undefined {
  for (const root of bundledRipgrepRoots()) {
    const candidate = path.join(root, platformDirectoryName(), ripgrepExecutableName());
    if (isExecutableFileSync(candidate)) return candidate;
  }
  return undefined;
}

export function clearRipgrepCommandCacheForTests(): void {
  cachedResolution = undefined;
}

async function resolveRipgrepCommandUncached(cwd: string): Promise<ResolvedRipgrepCommand> {
  const attempts: string[] = [];
  const envCommand = process.env[RIPGREP_COMMAND_ENV]?.trim();
  if (envCommand) {
    try {
      const [command, ...argsPrefix] = parseCommandLine(envCommand);
      if (!command) throw new Error(`${RIPGREP_COMMAND_ENV} did not contain an executable.`);
      return await probeRipgrepCommand({
        command,
        argsPrefix,
        mode: 'env',
        binDir: path.isAbsolute(command) ? path.dirname(command) : undefined,
        source: RIPGREP_COMMAND_ENV,
      }, cwd);
    } catch (error) {
      attempts.push(`env: ${errorMessage(error)}`);
    }
  }

  const bundledExecutable = getBundledRipgrepExecutablePath();
  if (bundledExecutable) {
    try {
      return await probeRipgrepCommand({
        command: bundledExecutable,
        argsPrefix: [],
        mode: 'bundled',
        binDir: path.dirname(bundledExecutable),
        source: bundledExecutable,
      }, cwd);
    } catch (error) {
      attempts.push(`bundled: ${errorMessage(error)}`);
    }
  } else {
    attempts.push(`bundled: no executable found at ${bundledRipgrepRoots().map((root) => path.join(root, platformDirectoryName(), ripgrepExecutableName())).join(', ')}`);
  }

  const systemRipgrep = findExecutableOnPath('rg', buildAgentToolPathValue());
  if (systemRipgrep) {
    try {
      return await probeRipgrepCommand({
        command: systemRipgrep,
        argsPrefix: [],
        mode: 'system',
        binDir: path.dirname(systemRipgrep),
        source: systemRipgrep,
      }, cwd);
    } catch (error) {
      attempts.push(`system: ${errorMessage(error)}`);
    }
  } else {
    attempts.push('system: rg was not found on PATH.');
  }

  throw new Error(`Tenon could not resolve a working ripgrep provider. Attempts: ${attempts.join(' ')}`);
}

async function probeRipgrepCommand(
  input: Omit<ResolvedRipgrepCommand, 'version'>,
  cwd: string,
): Promise<ResolvedRipgrepCommand> {
  const result = await spawnProbe(
    input.command,
    [...input.argsPrefix, '--version'],
    cwd,
  );
  if (result.error) {
    throw new Error(`${input.mode} provider at ${input.source} failed to start: ${result.error.message}`);
  }
  if (result.timedOut) {
    throw new Error(`${input.mode} provider at ${input.source} timed out while probing --version.`);
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`${input.mode} provider at ${input.source} failed --version probe: ${detail}`);
  }
  const [versionLine] = result.stdout.trim().split(/\r?\n/);
  return { ...input, version: versionLine || 'ripgrep version unavailable' };
}

function spawnProbe(
  command: string,
  args: string[],
  cwd: string,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: Error;
  timedOut: boolean;
}> {
  return new Promise((resolve) => {
    const executor = getAgentProcessExecutor();
    void executor.spawn({
      command,
      args,
      cwd,
      env: { ...process.env, PATH: buildAgentToolPathValue() },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    }).then((child) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (result: {
        stdout: string;
        stderr: string;
        exitCode: number | null;
        error?: Error;
        timedOut: boolean;
      }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        executor.terminate(child, 'SIGTERM');
        killTimer = setTimeout(() => executor.terminate(child, 'SIGKILL'), 2_000);
      }, RIPGREP_PROBE_TIMEOUT_MS);
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => { stdout = appendProbeOutput(stdout, chunk); });
      child.stderr?.on('data', (chunk: string) => { stderr = appendProbeOutput(stderr, chunk); });
      child.once('error', (error) => {
        finish({ stdout, stderr, exitCode: null, error, timedOut });
      });
      child.once('close', (code) => {
        finish({ stdout, stderr, exitCode: code, timedOut });
      });
    }, (error: unknown) => {
      resolve({
        stdout: '',
        stderr: '',
        exitCode: null,
        error: error instanceof Error ? error : new Error(String(error)),
        timedOut: false,
      });
    });
  });
}

function appendProbeOutput(current: string, chunk: string): string {
  return current + chunk.slice(0, Math.max(0, 16_384 - current.length));
}

function bundledRipgrepRoots(): string[] {
  const roots = [
    process.env[RIPGREP_VENDOR_ROOT_ENV],
    packagedResourcesRipgrepRoot(),
    sourceVendorRipgrepRoot(),
  ].filter((root): root is string => Boolean(root));
  return [...new Set(roots)];
}

function packagedResourcesRipgrepRoot(): string | undefined {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return resourcesPath ? path.join(resourcesPath, 'ripgrep') : undefined;
}

function sourceVendorRipgrepRoot(): string {
  return fileURLToPath(new URL('../../vendor/ripgrep/', import.meta.url));
}

function platformDirectoryName(): string {
  return `${process.arch}-${process.platform}`;
}

function ripgrepExecutableName(): string {
  return process.platform === 'win32' ? 'rg.exe' : 'rg';
}

function isExecutableFileSync(filePath: string): boolean {
  try {
    if (!existsSync(filePath)) return false;
    if (!statSync(filePath).isFile()) return false;
    if (process.platform === 'win32') return true;
    return requireExecutableBit(filePath);
  } catch {
    return false;
  }
}

function requireExecutableBit(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutableOnPath(command: string, pathValue: string): string | undefined {
  const extensions = process.platform === 'win32'
    ? pathSegments(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    : [''];
  for (const directory of pathSegments(pathValue)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (isExecutableFileSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function parseCommandLine(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaping = false;
  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (escaping) current += '\\';
  if (quote) throw new Error(`Unterminated ${quote} quote in ${RIPGREP_COMMAND_ENV}.`);
  if (current) parts.push(current);
  return parts;
}

function ripgrepResolutionSignature(): string {
  return JSON.stringify({
    command: process.env[RIPGREP_COMMAND_ENV] ?? '',
    vendorRoot: process.env[RIPGREP_VENDOR_ROOT_ENV] ?? '',
    path: process.env.PATH ?? '',
    extraPath: process.env.LIN_AGENT_EXTRA_TOOL_PATH ?? '',
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? '',
    platform: process.platform,
    arch: process.arch,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
