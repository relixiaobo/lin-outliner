import path from 'node:path';
import { EXTRA_TOOL_PATH_ENV, pathSegments } from './agentToolPath';

export interface TenonImportRuntimeConfig {
  binDir: string;
  cliEntry: string;
  cliRuntime: string;
  runAsNode: boolean;
}

export interface TenonImportRuntimeOptions {
  isPackaged: boolean;
  moduleDir: string;
  resourcesPath: string;
  processExecPath: string;
  descriptorPath: string;
}

export const TENON_IMPORT_API_DESCRIPTOR_ENV = 'TENON_IMPORT_API_DESCRIPTOR';
export const TENON_IMPORT_CLI_ENTRY_ENV = 'TENON_IMPORT_CLI_ENTRY';
export const TENON_IMPORT_CLI_RUNTIME_ENV = 'TENON_IMPORT_CLI_RUNTIME';
export const TENON_IMPORT_RUN_AS_NODE_ENV = 'TENON_IMPORT_RUN_AS_NODE';

export function configureTenonImportRuntime(options: TenonImportRuntimeOptions): TenonImportRuntimeConfig {
  const config = resolveTenonImportRuntime(options);
  process.env[TENON_IMPORT_API_DESCRIPTOR_ENV] = options.descriptorPath;
  process.env[TENON_IMPORT_CLI_ENTRY_ENV] = config.cliEntry;
  process.env[TENON_IMPORT_CLI_RUNTIME_ENV] = config.cliRuntime;
  if (config.runAsNode) process.env[TENON_IMPORT_RUN_AS_NODE_ENV] = '1';
  else delete process.env[TENON_IMPORT_RUN_AS_NODE_ENV];
  prependProcessToolPath(config.binDir);
  return config;
}

export function resolveTenonImportRuntime(options: Omit<TenonImportRuntimeOptions, 'descriptorPath'>): TenonImportRuntimeConfig {
  if (options.isPackaged) {
    const cliRoot = path.join(options.resourcesPath, 'tenon-import');
    const skillRoot = path.join(options.resourcesPath, 'built-in-skills', 'data-cleanup');
    return {
      binDir: path.join(skillRoot, 'bin'),
      cliEntry: path.join(cliRoot, 'tenon-import.mjs'),
      cliRuntime: options.processExecPath,
      runAsNode: true,
    };
  }
  const repoRoot = path.resolve(options.moduleDir, '../..');
  const root = path.join(repoRoot, 'src', 'main', 'builtInSkills', 'data-cleanup');
  return {
    binDir: path.join(root, 'bin'),
    cliEntry: path.join(root, 'scripts', 'tenon-import.ts'),
    cliRuntime: 'bun',
    runAsNode: false,
  };
}

function prependProcessToolPath(binDir: string): void {
  const segments = [binDir, ...pathSegments(process.env[EXTRA_TOOL_PATH_ENV])];
  const seen = new Set<string>();
  process.env[EXTRA_TOOL_PATH_ENV] = segments
    .filter((segment) => {
      const normalized = segment.trim();
      if (!normalized || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .join(path.delimiter);
}
