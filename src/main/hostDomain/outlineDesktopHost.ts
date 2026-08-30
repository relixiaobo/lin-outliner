import { randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import type { ErrorReport } from '../../core/errorObservability';
import type { NodeAccessSource } from '../../core/nodeAccessRanking';
import { TRASH_ID, type NodeProjection, type ProjectionSnapshot, type ProjectionUpdate } from '../../core/types';
import { OutlineClientSupervisor, type OutlineRuntimeLaunch } from '../../outline/client';
import type { AgentMutationCausation } from '../../core/agent/protocol';
import type { AgentShellProcessEnvironmentProvider } from '../agent/capabilities/agentLocalTools';
import type { TimelineMemoryHost } from '../agent/extensions/memory/TimelineMemoryStore';
import { NodeAccessStore } from '../nodeAccessStore';
import { DesktopOutlineClient } from '../outlineClient';
import { OutlineDesktopAssetService } from '../outlineDesktopAssetService';
import { OutlineDocumentService, type OutlineProjectionDelivery } from '../outlineDocumentService';
import { createOutlineAgentShellEnvironmentProvider } from '../outlineAgentShellEnvironment';
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
  readonly renderer: OutlineRendererCapability;
  readonly document: OutlineDocumentCapability;
  readonly assets: OutlineAssetCapability;
  readonly timeline: TimelineMemoryHost;
  readonly quit: OutlineQuitCapability;
  createAgentShellEnvironment(
    threadId: AgentMutationCausation['threadId'],
    turnId: AgentMutationCausation['turnId'],
    baseEnvironment: AgentShellProcessEnvironmentProvider,
  ): AgentShellProcessEnvironmentProvider;
  recordNodeAccess(nodeIds: readonly string[], source: NodeAccessSource): Promise<void>;
  initializeDocuments(): Promise<ProjectionSnapshot>;
  initializePersonalAccessRanking(): Promise<void>;
  observeProjection(listener: (delivery: OutlineProjectionDelivery) => void): () => void;
  flushDerivedState(): Promise<void>;
  close(): void;
}

export interface OutlineRendererCapability {
  request: DesktopOutlineClient['request'];
  commit: DesktopOutlineClient['commit'];
  subscribe: DesktopOutlineClient['subscribe'];
  cancel: DesktopOutlineClient['cancel'];
  releaseOwner: DesktopOutlineClient['releaseOwner'];
}

export interface OutlineDocumentCapability {
  getProjection: OutlineDocumentService['getProjection'];
  liveProjection: OutlineDocumentService['liveProjection'];
  projectionNodesByIds: OutlineDocumentService['projectionNodesByIds'];
  searchNodeHits: OutlineDocumentService['searchNodeHits'];
  runChanges: OutlineDocumentService['runChanges'];
}

export interface OutlineAssetCapability {
  ingest: OutlineDesktopAssetService['ingest'];
  lookup: OutlineDesktopAssetService['lookup'];
  pathFor: OutlineDesktopAssetService['pathFor'];
  serve: OutlineDesktopAssetService['serve'];
}

export interface OutlineQuitCapability {
  freezeAdmission: OutlineDocumentService['freezeMutationAdmission'];
  unfreezeAdmission: OutlineDocumentService['unfreezeMutationAdmission'];
  commitAdmissionFreeze: OutlineDocumentService['commitMutationAdmissionFreeze'];
  latestAcceptedRevision: OutlineDocumentService['latestAcceptedRevision'];
  durableRevision: OutlineDocumentService['durableRevision'];
  drainToRevision: OutlineDocumentService['drainToRevision'];
  shutdownRuntime(signal?: AbortSignal): Promise<void>;
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
  const renderer: OutlineRendererCapability = {
    request: (...args) => client.request(...args),
    commit: (...args) => client.commit(...args),
    subscribe: (...args) => client.subscribe(...args),
    cancel: (...args) => client.cancel(...args),
    releaseOwner: (...args) => client.releaseOwner(...args),
  };
  const document: OutlineDocumentCapability = {
    getProjection: () => documents.getProjection(),
    liveProjection: () => documents.liveProjection(),
    projectionNodesByIds: (nodeIds) => documents.projectionNodesByIds(nodeIds),
    searchNodeHits: (query, limit) => documents.searchNodeHits(query, limit),
    runChanges: (changes, mutationOptions) => documents.runChanges(changes, mutationOptions),
  };
  const assetsCapability: OutlineAssetCapability = {
    ingest: (input) => assets.ingest(input),
    lookup: (assetId) => assets.lookup(assetId),
    pathFor: (assetId) => assets.pathFor(assetId),
    serve: (assetId, request) => assets.serve(assetId, request),
  };
  const timeline: TimelineMemoryHost = {
    getProjection: () => documents.getProjection(),
    runChanges: (changes, mutationOptions) => documents.runChanges(changes, mutationOptions),
    runPlannedChanges: (build, mutationOptions) => documents.runPlannedChanges(build, mutationOptions),
    log: (input) => documents.log(input),
  };
  const quit: OutlineQuitCapability = {
    freezeAdmission: () => documents.freezeMutationAdmission(),
    unfreezeAdmission: () => documents.unfreezeMutationAdmission(),
    commitAdmissionFreeze: () => documents.commitMutationAdmissionFreeze(),
    latestAcceptedRevision: () => documents.latestAcceptedRevision(),
    durableRevision: () => documents.durableRevision(),
    drainToRevision: (revision) => documents.drainToRevision(revision),
    shutdownRuntime: (signal) => supervisor.shutdown(signal),
  };

  return {
    runtimeRoot,
    contentRoot,
    assetExportRoot,
    renderer,
    document,
    assets: assetsCapability,
    timeline,
    quit,
    createAgentShellEnvironment: (threadId, turnId, baseEnvironment) => (
      createOutlineAgentShellEnvironmentProvider({
        threadId,
        turnId,
        runtimeRoot,
        contentRoot,
        supervisor,
        baseEnvironment,
      })
    ),
    recordNodeAccess: async (nodeIds, source) => {
      const uniqueIds = [...new Set(nodeIds.filter((nodeId) => nodeId.length > 0))];
      if (uniqueIds.length === 0) return;
      const existingIds = new Set(documents.projectionNodesByIds(uniqueIds).map((node) => node.id));
      const validIds = uniqueIds.filter((nodeId) => existingIds.has(nodeId));
      if (validIds.length === 0) return;
      const update = await nodeAccess.recordMany(validIds, source);
      await documents.upsertPersonalAccessRanking(update.upserted);
      if (update.removed.length > 0) await documents.removePersonalAccessRanking(update.removed);
    },
    initializeDocuments: lifecycle.initializeDocuments,
    initializePersonalAccessRanking: lifecycle.initializePersonalAccessRanking,
    observeProjection: (listener) => documents.onProjectionChanged((delivery) => {
      pruneNodeAccessForProjectionUpdate(delivery.update, documents, nodeAccess);
      listener(delivery);
    }),
    flushDerivedState: lifecycle.flushDerivedState,
    close: lifecycle.close,
  };
}

function pruneNodeAccessForProjectionUpdate(
  update: ProjectionUpdate,
  documents: OutlineDocumentService,
  nodeAccess: NodeAccessStore,
): void {
  if (update.kind === 'full') {
    void nodeAccess.retainOnly(update.projection.nodes.map((node) => node.id))
      .then(() => documents.replacePersonalAccessRanking(nodeAccess.snapshot()))
      .catch(() => undefined);
    return;
  }
  const trashedIds = update.changedNodes
    .filter((node) => node.parentId === TRASH_ID)
    .map((node) => node.id);
  const staleIds = new Set([...update.removedIds, ...trashedIds]);
  if (trashedIds.length > 0) {
    for (const descendantId of descendantProjectionIds(trashedIds, documents.getProjection().nodes)) {
      staleIds.add(descendantId);
    }
  }
  if (staleIds.size === 0) return;
  void nodeAccess.deleteMany([...staleIds])
    .then(() => documents.removePersonalAccessRanking([...staleIds]))
    .catch(() => undefined);
}

function descendantProjectionIds(rootIds: readonly string[], nodes: readonly NodeProjection[]): string[] {
  if (rootIds.length === 0) return [];
  const childrenByParent = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node.id);
    childrenByParent.set(node.parentId, children);
  }
  const descendants: string[] = [];
  const pending = [...rootIds];
  while (pending.length > 0) {
    const parentId = pending.pop()!;
    for (const childId of childrenByParent.get(parentId) ?? []) {
      descendants.push(childId);
      pending.push(childId);
    }
  }
  return descendants;
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
