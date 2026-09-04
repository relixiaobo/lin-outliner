import path from 'node:path';

export interface ToolTaskSupervisorRuntime {
  readonly executable: string;
  readonly argsPrefix: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly entry: string;
  readonly packaged: boolean;
}

export interface ToolTaskSupervisorRuntimeOptions {
  readonly isPackaged: boolean;
  readonly moduleDir: string;
  readonly resourcesPath: string;
  readonly processExecPath: string;
}

export function resolveToolTaskSupervisorRuntime(
  options: ToolTaskSupervisorRuntimeOptions,
): ToolTaskSupervisorRuntime {
  if (options.isPackaged) {
    const entry = path.join(options.resourcesPath, 'tool-task', 'tool-task-supervisor.mjs');
    return {
      executable: options.processExecPath,
      argsPrefix: [entry],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      entry,
      packaged: true,
    };
  }
  const repositoryRoot = path.resolve(options.moduleDir, '../..');
  const entry = path.join(repositoryRoot, 'src', 'main', 'agent', 'tasks', 'toolTaskSupervisor.ts');
  return {
    executable: 'bun',
    argsPrefix: [entry],
    env: {},
    entry,
    packaged: false,
  };
}

export function defaultToolTaskSupervisorRuntime(): ToolTaskSupervisorRuntime {
  return resolveToolTaskSupervisorRuntime({
    isPackaged: false,
    moduleDir: path.resolve(import.meta.dirname, '../..'),
    resourcesPath: '',
    processExecPath: process.execPath,
  });
}
