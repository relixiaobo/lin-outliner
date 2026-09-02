import path from 'node:path';
import { EXTRA_TOOL_PATH_ENV, pathSegments } from './agent/capabilities/agentToolPath';

export const TENON_OUTLINE_CLI_ENTRY_ENV = 'TENON_OUTLINE_CLI_ENTRY';
export const TENON_OUTLINE_IMPORT_ADAPTER_ENTRY_ENV = 'TENON_OUTLINE_IMPORT_ADAPTER_ENTRY';
export const TENON_OUTLINE_CLI_RUNTIME_ENV = 'TENON_OUTLINE_CLI_RUNTIME';
export const TENON_OUTLINE_RUNTIME_ENTRY_ENV = 'TENON_OUTLINE_RUNTIME_ENTRY';
export const TENON_OUTLINE_RUN_AS_NODE_ENV = 'TENON_OUTLINE_RUN_AS_NODE';
export const TENON_OUTLINE_PACKAGED_ENV = 'TENON_OUTLINE_PACKAGED';

export interface OutlineCliRuntimeConfig {
  readonly binDir: string;
  readonly cliEntry: string;
  readonly importAdapterEntry: string;
  readonly runtimeEntry: string;
  readonly cliRuntime: string;
  readonly runAsNode: boolean;
  readonly packaged: boolean;
}

export interface OutlineCliRuntimeOptions {
  readonly isPackaged: boolean;
  readonly moduleDir: string;
  readonly resourcesPath: string;
  readonly processExecPath: string;
}

export function configureOutlineCliRuntime(options: OutlineCliRuntimeOptions): OutlineCliRuntimeConfig {
  const config = resolveOutlineCliRuntime(options);
  process.env[TENON_OUTLINE_CLI_ENTRY_ENV] = config.cliEntry;
  process.env[TENON_OUTLINE_IMPORT_ADAPTER_ENTRY_ENV] = config.importAdapterEntry;
  process.env[TENON_OUTLINE_RUNTIME_ENTRY_ENV] = config.runtimeEntry;
  process.env[TENON_OUTLINE_CLI_RUNTIME_ENV] = config.cliRuntime;
  if (config.runAsNode) process.env[TENON_OUTLINE_RUN_AS_NODE_ENV] = '1';
  else delete process.env[TENON_OUTLINE_RUN_AS_NODE_ENV];
  if (config.packaged) process.env[TENON_OUTLINE_PACKAGED_ENV] = '1';
  else delete process.env[TENON_OUTLINE_PACKAGED_ENV];
  prependProcessToolPath(config.binDir);
  return config;
}

export function resolveOutlineCliRuntime(options: OutlineCliRuntimeOptions): OutlineCliRuntimeConfig {
  if (options.isPackaged) {
    const root = path.join(options.resourcesPath, 'outline');
    return {
      binDir: path.join(root, 'bin'),
      cliEntry: path.join(root, 'outline.mjs'),
      importAdapterEntry: path.join(root, 'import-adapters.mjs'),
      runtimeEntry: path.join(root, 'outline-runtime.mjs'),
      cliRuntime: options.processExecPath,
      runAsNode: true,
      packaged: true,
    };
  }
  const repositoryRoot = path.resolve(options.moduleDir, '../..');
  return {
    binDir: path.join(repositoryRoot, 'src', 'outline', 'bin'),
    cliEntry: path.join(repositoryRoot, 'src', 'outline', 'cli', 'entry.ts'),
    importAdapterEntry: path.join(
      repositoryRoot,
      'src',
      'outline',
      'import',
      'adapters',
      'source-adapters.ts',
    ),
    runtimeEntry: path.join(repositoryRoot, 'src', 'outline', 'runtime', 'server', 'entry.ts'),
    cliRuntime: 'bun',
    runAsNode: false,
    packaged: false,
  };
}

function prependProcessToolPath(binDir: string): void {
  const seen = new Set<string>();
  process.env[EXTRA_TOOL_PATH_ENV] = [binDir, ...pathSegments(process.env[EXTRA_TOOL_PATH_ENV])]
    .filter((segment) => {
      if (!segment || seen.has(segment)) return false;
      seen.add(segment);
      return true;
    })
    .join(path.delimiter);
}
