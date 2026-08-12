import { realpathSync } from 'node:fs';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';

export interface AgentProcessSpawnInput {
  command: string;
  args?: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  privateEnvKeys?: readonly string[];
  detached?: boolean;
  stdio?: SpawnOptions['stdio'];
  windowsHide?: boolean;
  sandbox?: AgentProcessWriteSandbox;
}

export interface AgentProcessWriteSandbox {
  readonly writablePaths: readonly string[];
  /** Shared Git object stores may create loose objects but never alter existing repository objects. */
  readonly protectedGitObjectStores?: readonly string[];
}

export class AgentProcessExecutor {
  async spawn(input: AgentProcessSpawnInput): Promise<ChildProcess> {
    const sandboxed = sandboxedCommand(input.command, input.args ?? [], input.sandbox);
    return spawn(sandboxed.command, [...sandboxed.args], {
      cwd: path.resolve(input.cwd),
      env: sanitizeAgentProcessEnv(input.env ?? process.env, input.privateEnvKeys),
      shell: false,
      stdio: input.stdio ?? ['ignore', 'pipe', 'pipe'],
      detached: input.detached,
      windowsHide: input.windowsHide,
    });
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
}

function sandboxedCommand(
  command: string,
  args: readonly string[],
  sandbox: AgentProcessWriteSandbox | undefined,
): { readonly command: string; readonly args: readonly string[] } {
  if (!sandbox) return { command, args };
  if (process.platform !== 'darwin') {
    throw new Error('Isolated Agent shell execution is supported only on macOS');
  }
  const writablePaths = [...new Set(sandbox.writablePaths.map(canonicalizePotentialPath))];
  if (writablePaths.length === 0) throw new Error('Isolated Agent shell requires at least one writable path');
  const protectedGitObjectStores = [...new Set(
    (sandbox.protectedGitObjectStores ?? []).map(canonicalizePotentialPath),
  )];
  const writable = `(require-any (literal "/dev/null") ${[...writablePaths, ...protectedGitObjectStores]
    .map((candidate) => `(subpath ${sandboxString(candidate)})`)
    .join(' ')})`;
  const profile = [
    '(version 1)',
    '(allow default)',
    `(deny file-write* (require-not ${writable}))`,
    ...protectedGitObjectStores.flatMap(gitObjectStoreProtectionRules),
  ].join('\n');
  return {
    command: '/usr/bin/sandbox-exec',
    args: ['-p', profile, '--', command, ...args],
  };
}

function gitObjectStoreProtectionRules(objectStore: string): string[] {
  const objectRoot = sandboxRegexLiteral(objectStore);
  const objectSuffix = `(${hexCharacters(38)}|${hexCharacters(62)}|tmp_obj_[A-Za-z0-9][A-Za-z0-9]*)`;
  const looseObjectCreatePattern = `^${objectRoot}/[0-9a-f][0-9a-f](/${objectSuffix})?$`;
  return [
    `(deny file-write-create (require-all (subpath ${sandboxString(objectStore)}) `
      + `(require-not (regex #${sandboxString(looseObjectCreatePattern)}))))`,
    `(deny file-write-data file-write-unlink file-write-mode file-write-owner `
      + `(subpath ${sandboxString(objectStore)}))`,
  ];
}

function hexCharacters(length: number): string {
  return '[0-9a-f]'.repeat(length);
}

function canonicalizePotentialPath(candidate: string): string {
  const resolved = path.resolve(candidate);
  const suffix: string[] = [];
  let cursor = resolved;
  while (true) {
    try {
      return path.join(realpathSync.native(cursor), ...suffix.reverse());
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function sandboxString(value: string): string {
  return JSON.stringify(value).replace(/\\u2028|\\u2029/g, '');
}

function sandboxRegexLiteral(value: string): string {
  return value.replace(/[\\.^$|?*+()[\]{}]/g, (character) => `[${character}]`);
}

let executor: AgentProcessExecutor | null = null;

export function getAgentProcessExecutor(): AgentProcessExecutor {
  executor ??= new AgentProcessExecutor();
  return executor;
}

export function resetAgentProcessExecutorForTests(): void {
  executor = null;
}

export function sanitizeAgentProcessEnv(
  input: NodeJS.ProcessEnv,
  privateEnvKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  const privateKeys = new Set(privateEnvKeys.map((key) => key.toUpperCase()));
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || privateKeys.has(key.toUpperCase())) continue;
    result[key] = value;
  }
  return result;
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    const args = ['/pid', String(pid), '/t'];
    if (signal === 'SIGKILL') args.push('/f');
    try {
      const killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
      killer.once('error', () => killChild(child, signal));
      killer.unref();
    } catch {
      killChild(child, signal);
    }
    return;
  }
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Fall through when the process is not a group leader.
  }
  killChild(child, signal);
}

function killChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // The process can exit between lookup and termination.
  }
}
