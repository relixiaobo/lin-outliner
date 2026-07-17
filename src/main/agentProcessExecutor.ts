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
}

export class AgentProcessExecutor {
  async spawn(input: AgentProcessSpawnInput): Promise<ChildProcess> {
    return spawn(input.command, [...(input.args ?? [])], {
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
