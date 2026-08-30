import { randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import type { ErrorReport } from '../../core/errorObservability';
import type { ProjectionSnapshot } from '../../core/types';
import { OutlineClientSupervisor, type OutlineRuntimeLaunch } from '../../outline/client';
import { NodeAccessStore } from '../nodeAccessStore';
import { DesktopOutlineClient } from '../outlineClient';
import { OutlineDesktopAssetService } from '../outlineDesktopAssetService';
import { OutlineDocumentService, type OutlineProjectionDelivery } from '../outlineDocumentService';
import { configureOutlineCliRuntime } from '../outlineRuntime';
import { createOutlineDesktopHostLifecycle } from './compositionLifecycle';

export interface OutlineDesktopHostOptions {
  readonly userDataDir: string;
  readonly moduleDir: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly execPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly reportError: (report: ErrorReport) => void;
}

export interface OutlineDesktopHost {
  readonly runtimeRoot: string;
  readonly contentRoot: string;
  readonly assetExportRoot: string;
  readonly supervisor: OutlineClientSupervisor;
  readonly client: DesktopOutlineClient;
  readonly documents: OutlineDocumentService;
  readonly assets: OutlineDesktopAssetService;
  readonly nodeAccess: NodeAccessStore;
  initializeDocuments(): Promise<ProjectionSnapshot>;
  initializePersonalAccessRanking(): Promise<void>;
  observeProjection(listener: (delivery: OutlineProjectionDelivery) => void): () => void;
  flushDerivedState(): Promise<void>;
  close(): void;
}

export function createOutlineDesktopHost(options: OutlineDesktopHostOptions): OutlineDesktopHost {
  const runtimeRoot = join(options.userDataDir, 'outline-runtime');
  const contentRoot = join(options.userDataDir, 'content');
  const assetExportRoot = join(options.userDataDir, 'outline-asset-exports');
  const developmentSessionId = options.isPackaged ? undefined : `desktop:${randomUUID()}`;
  const supervisor = new OutlineClientSupervisor({
    root: runtimeRoot,
    contentRoot,
    launch: desktopOutlineRuntimeLaunch(options, runtimeRoot, contentRoot),
    ...(developmentSessionId ? { expectedDevelopmentSessionId: developmentSessionId } : {}),
    origin: 'desktop',
  });
  const client = new DesktopOutlineClient({ connect: () => supervisor.connect() });
  const documents = new OutlineDocumentService(supervisor);
  documents.setDurabilityFailureHandler((error, revision) => options.reportError({
    domain: 'document',
    severity: 'error',
    code: 'workspace-save-failed',
    message: `Workspace save failed at revision ${revision}.`,
    context: { operation: 'workspace-save', revision },
    error,
  }));
  const assets = new OutlineDesktopAssetService(supervisor, assetExportRoot);
  const nodeAccess = new NodeAccessStore(join(options.userDataDir, 'node-access-stats.json'), {
    onError: (error, operation) => options.reportError({
      domain: 'node-access',
      severity: 'warn',
      code: `node-access-${operation}`,
      message: `Node access store ${operation} failed`,
      context: { operation },
      error,
    }),
  });

  configureOutlineCliRuntime({
    isPackaged: options.isPackaged,
    moduleDir: options.moduleDir,
    resourcesPath: options.resourcesPath,
    processExecPath: options.execPath,
  });
  const lifecycle = createOutlineDesktopHostLifecycle({
    documents,
    client,
    nodeAccess,
    reportError: options.reportError,
  });

  return {
    runtimeRoot,
    contentRoot,
    assetExportRoot,
    supervisor,
    client,
    documents,
    assets,
    nodeAccess,
    initializeDocuments: lifecycle.initializeDocuments,
    initializePersonalAccessRanking: lifecycle.initializePersonalAccessRanking,
    observeProjection: (listener) => documents.onProjectionChanged(listener),
    flushDerivedState: lifecycle.flushDerivedState,
    close: lifecycle.close,
  };
}

function desktopOutlineRuntimeLaunch(
  options: OutlineDesktopHostOptions,
  root: string,
  contentRoot: string,
): OutlineRuntimeLaunch {
  const environment = options.environment ?? process.env;
  const configuredEntry = environment.TENON_OUTLINE_RUNTIME_ENTRY;
  if (configuredEntry) {
    return {
      command: environment.TENON_OUTLINE_RUNTIME_COMMAND ?? options.execPath,
      args: [configuredEntry, '--root', root, '--content-root', contentRoot],
    };
  }
  if (options.isPackaged) {
    return {
      command: options.execPath,
      args: [join(options.resourcesPath, 'outline', 'outline-runtime.mjs'), '--root', root, '--content-root', contentRoot],
    };
  }
  const npmExecutable = environment.npm_execpath;
  const bunExecutable = npmExecutable && basename(npmExecutable) === 'bun' ? npmExecutable : 'bun';
  return {
    command: bunExecutable,
    args: [resolve(options.moduleDir, '../../src/outline/runtime/server/entry.ts'), '--root', root, '--content-root', contentRoot],
  };
}
