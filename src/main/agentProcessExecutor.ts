import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  createFolderCapabilitySnapshot,
  isPathInside,
  type FolderCapabilitySnapshot,
} from './agentFolderCapabilities';
import type { FolderCapabilityService } from './agentFolderCapabilities';

export interface AgentProcessSpawnInput {
  command: string;
  args?: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  capabilities?: FolderCapabilitySnapshot;
  detached?: boolean;
  stdio?: SpawnOptions['stdio'];
  windowsHide?: boolean;
}

interface ActiveAgentProcess {
  child: ChildProcess;
  capabilities: FolderCapabilitySnapshot;
}

export class MacOSFileSandboxAdapter {
  private probe: Promise<void> | null = null;

  async prepare(input: Required<Pick<AgentProcessSpawnInput, 'command' | 'cwd'>> & {
    args: readonly string[];
    capabilities: FolderCapabilitySnapshot;
  }): Promise<{ command: string; args: string[] }> {
    if (process.platform !== 'darwin') return { command: input.command, args: [...input.args] };
    await this.ensureAvailable(input.cwd);
    const profile = macOSSeatbeltProfile(input.capabilities);
    return {
      command: '/usr/bin/sandbox-exec',
      args: ['-p', profile, input.command, ...input.args],
    };
  }

  private async ensureAvailable(cwd: string): Promise<void> {
    this.probe ??= probeMacOSSandbox(cwd).catch((error) => {
      this.probe = null;
      throw error;
    });
    return this.probe;
  }
}

export class AgentProcessExecutor {
  private readonly active = new Map<number, ActiveAgentProcess>();
  private readonly sandbox = new MacOSFileSandboxAdapter();

  async spawn(input: AgentProcessSpawnInput): Promise<ChildProcess> {
    const cwd = path.resolve(input.cwd);
    const capabilities = input.capabilities ?? createFolderCapabilitySnapshot({
      workspaceRoot: cwd,
      includeSystemRoots: true,
    }, []);
    const prepared = await this.sandbox.prepare({
      command: input.command,
      args: input.args ?? [],
      cwd,
      capabilities,
    });
    const child = spawn(prepared.command, prepared.args, {
      cwd,
      env: sanitizeAgentProcessEnv(input.env ?? process.env),
      shell: false,
      stdio: input.stdio ?? ['ignore', 'pipe', 'pipe'],
      detached: input.detached,
      windowsHide: input.windowsHide,
    });
    if (child.pid) {
      this.active.set(child.pid, { child, capabilities });
      const release = () => {
        if (child.pid) this.active.delete(child.pid);
      };
      child.once('close', release);
      child.once('error', release);
    }
    return child;
  }

  async spawnShell(input: Omit<AgentProcessSpawnInput, 'command' | 'args'> & { command: string }): Promise<ChildProcess> {
    if (process.platform === 'win32') {
      return this.spawn({ ...input, command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', input.command] });
    }
    const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
    return this.spawn({ ...input, command: shell, args: ['-c', input.command] });
  }

  terminate(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
    terminateProcessTree(child, signal);
  }

  async terminateProcessesUsingFolder(folderInput: string): Promise<void> {
    const folder = path.resolve(folderInput);
    const matches = [...this.active.values()].filter(({ capabilities }) => (
      capabilities.roots.some((entry) => entry.origin === 'user' && (
        isPathInside(folder, entry.root) || isPathInside(entry.root, folder)
      ))
    ));
    await Promise.allSettled(matches.map(async ({ child }) => {
      terminateProcessTree(child, 'SIGTERM');
      await waitForExit(child, 1_000);
      if (child.exitCode === null && child.signalCode === null) terminateProcessTree(child, 'SIGKILL');
    }));
  }
}

let executor: AgentProcessExecutor | null = null;

export function getAgentProcessExecutor(): AgentProcessExecutor {
  executor ??= new AgentProcessExecutor();
  return executor;
}

export function bindAgentProcessRevocation(service: FolderCapabilityService): () => void {
  return service.onRevoked((folder) => getAgentProcessExecutor().terminateProcessesUsingFolder(folder));
}

export function resetAgentProcessExecutorForTests(): void {
  executor = null;
}

export function sanitizeAgentProcessEnv(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || isSecretEnvironmentName(key)) continue;
    result[key] = value;
  }
  return result;
}

export function macOSSeatbeltProfile(snapshot: FolderCapabilitySnapshot): string {
  const writeRules = snapshot.writeRoots.map((root) => `(subpath ${seatbeltString(root)})`).join(' ');
  const deniedWrites = snapshot.deniedWrites.map((entry) => (
    `(${entry.recursive ? 'subpath' : 'literal'} ${seatbeltString(entry.path)})`
  )).join(' ');
  return [
    '(version 1)',
    '(allow default)',
    ...macOSReadDenyRules(snapshot.readRoots),
    '(deny file-write*)',
    `(allow file-write* (literal "/dev/null") (literal "/dev/tty") ${writeRules})`,
    ...(deniedWrites ? [`(deny file-write* ${deniedWrites})`] : []),
  ].join('\n');
}

export function processSandboxDenied(stderr: string): boolean {
  return /operation not permitted|sandbox(?:-exec)?:|deny\(1\)/i.test(stderr);
}

async function probeMacOSSandbox(cwd: string): Promise<void> {
  if (!existsSync('/usr/bin/sandbox-exec')) {
    throw new Error('macOS process sandbox is unavailable; agent processes are disabled.');
  }
  const capabilities = createFolderCapabilitySnapshot({
    workspaceRoot: cwd,
    includeSystemRoots: true,
  }, []);
  const profile = macOSSeatbeltProfile(capabilities);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/true'], {
      cwd,
      env: sanitizeAgentProcessEnv(process.env),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`macOS process sandbox health probe failed${stderr.trim() ? `: ${stderr.trim()}` : ` with exit code ${code}`}.`));
    });
  });
}

function seatbeltString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function macOSReadDenyRules(allowedRoots: readonly string[]): string[] {
  const containers = [homedir(), '/Volumes'];
  const rules: string[] = [];
  for (const container of containers) {
    if (!existsSync(container)) continue;
    for (const denied of deniedChildren(container, allowedRoots)) {
      const matcher = isDirectory(denied) ? 'subpath' : 'literal';
      rules.push(`(deny file-read* (${matcher} ${seatbeltString(denied)}))`);
    }
  }
  return rules;
}

function deniedChildren(containerInput: string, allowedRoots: readonly string[]): string[] {
  const container = path.resolve(containerInput);
  if (allowedRoots.some((root) => isPathInside(root, container))) return [];
  const relevant = allowedRoots.filter((root) => isPathInside(container, root));
  if (relevant.length === 0) return [container];
  let entries: string[];
  try {
    entries = readdirSync(container);
  } catch {
    return [container];
  }
  const denied: string[] = [];
  for (const entry of entries) {
    const child = path.join(container, entry);
    if (relevant.some((root) => isPathInside(child, root))) {
      denied.push(...deniedChildren(child, relevant));
    } else {
      denied.push(child);
    }
  }
  return denied;
}

function isDirectory(inputPath: string): boolean {
  try {
    return statSync(inputPath).isDirectory();
  } catch {
    return false;
  }
}

function isSecretEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase();
  if (normalized === 'PATH' || normalized === 'HOME' || normalized === 'SHELL') return false;
  return /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|PRIVATE_?KEY)(?:$|_)/.test(normalized)
    || /^(?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|OPENROUTER|AWS|AZURE|GITHUB|GITLAB)_/.test(normalized);
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through when the process is not a group leader.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process can exit between lookup and termination.
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
