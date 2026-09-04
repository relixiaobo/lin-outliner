import path from 'node:path';

export const TENON_DELEGATE_CLI_ENTRY_ENV = 'TENON_DELEGATE_CLI_ENTRY';
export const TENON_DELEGATE_CLI_RUNTIME_ENV = 'TENON_DELEGATE_CLI_RUNTIME';
export const TENON_DELEGATE_RUN_AS_NODE_ENV = 'TENON_DELEGATE_RUN_AS_NODE';

export interface DelegateCliRuntimeConfig {
  readonly binDir: string;
  readonly cliEntry: string;
  readonly cliRuntime: string;
  readonly runAsNode: boolean;
  readonly packaged: boolean;
}

export interface DelegateCliRuntimeOptions {
  readonly isPackaged: boolean;
  readonly moduleDir: string;
  readonly resourcesPath: string;
  readonly processExecPath: string;
}

export function resolveDelegateCliRuntime(options: DelegateCliRuntimeOptions): DelegateCliRuntimeConfig {
  if (options.isPackaged) {
    const root = path.join(options.resourcesPath, 'delegate');
    return {
      binDir: path.join(root, 'bin'),
      cliEntry: path.join(root, 'delegate.mjs'),
      cliRuntime: options.processExecPath,
      runAsNode: true,
      packaged: true,
    };
  }
  const repositoryRoot = path.resolve(options.moduleDir, '../..');
  return {
    binDir: path.join(repositoryRoot, 'src', 'delegate', 'bin'),
    cliEntry: path.join(repositoryRoot, 'src', 'delegate', 'cli', 'entry.ts'),
    cliRuntime: 'bun',
    runAsNode: false,
    packaged: false,
  };
}

export function delegateLauncherEnvironment(
  runtime: DelegateCliRuntimeConfig,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...source,
    [TENON_DELEGATE_CLI_ENTRY_ENV]: runtime.cliEntry,
    [TENON_DELEGATE_CLI_RUNTIME_ENV]: runtime.cliRuntime,
    ...(runtime.runAsNode ? { [TENON_DELEGATE_RUN_AS_NODE_ENV]: '1' } : {}),
  };
}
