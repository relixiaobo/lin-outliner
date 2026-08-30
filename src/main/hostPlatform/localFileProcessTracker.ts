import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export type LocalFileSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface LocalFileProcessTracker {
  spawn(
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ): ChildProcess | null;
  close(): Promise<void>;
}

export function createLocalFileProcessTracker(
  spawnProcess: LocalFileSpawn = (command, args, options) => spawn(command, [...args], options),
): LocalFileProcessTracker {
  const activeProcesses = new Map<ChildProcess, Promise<void>>();
  let closing = false;
  let closePromise: Promise<void> | null = null;

  const spawnTrackedProcess: LocalFileProcessTracker['spawn'] = (command, args, options) => {
    if (closing) return null;
    const child = spawnProcess(command, args, options);
    const settlement = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('error', finish);
      child.once('close', finish);
    });
    activeProcesses.set(child, settlement);
    void settlement.finally(() => activeProcesses.delete(child));
    return child;
  };

  return {
    spawn: spawnTrackedProcess,
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      const active = [...activeProcesses.entries()];
      closePromise = Promise.all(active.map(([, settlement]) => settlement)).then(() => undefined);
      for (const [child] of active) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        child.unref();
      }
      return closePromise;
    },
  };
}
