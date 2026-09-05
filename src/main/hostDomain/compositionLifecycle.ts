import type { NodeAccessStats } from '../../core/nodeAccessRanking';
import type { ErrorReport } from '../../core/errorObservability';
import type { DocumentProjection, ProjectionSnapshot } from '../../core/types';
import { closeAgentServices } from '../agent/closeAgentServices';

export interface AgentHostLifecycleDependencies {
  readonly memory: {
    initializeMutationIndex(projection: DocumentProjection): void;
    startWorker(): Promise<void>;
    stopWorker(): Promise<void>;
    closeStore(): void;
  };
  readonly threads: {
    initialize(): Promise<void>;
    close(): Promise<void>;
  };
  readonly automations: {
    start(): Promise<void>;
    stop(): Promise<void>;
    closeStore(): void;
  };
}

export interface AgentHostLifecycle {
  initialize(projection: DocumentProjection, assertActive?: () => void): Promise<void>;
  close(): Promise<void>;
}

export function createAgentHostLifecycle(
  dependencies: AgentHostLifecycleDependencies,
): AgentHostLifecycle {
  const completed = new Set<string>();
  let initialization: Promise<void> | null = null;
  const initialize = async (projection: DocumentProjection, assertActive: () => void) => {
    assertActive();
    if (!completed.has('memory-index')) {
      dependencies.memory.initializeMutationIndex(projection);
      completed.add('memory-index');
      assertActive();
    }
    if (!completed.has('threads')) {
      await dependencies.threads.initialize();
      completed.add('threads');
      assertActive();
    }
    const producers = [
      ['memory-worker', () => dependencies.memory.startWorker()],
      ['automations', () => dependencies.automations.start()],
    ] as const;
    const settlements = await Promise.allSettled(producers.map(async ([name, run]) => {
      if (completed.has(name)) return;
      assertActive();
      await run();
      completed.add(name);
      assertActive();
    }));
    for (const result of settlements) {
      if (result.status === 'rejected') throw result.reason;
    }
  };
  return {
    initialize: (projection, assertActive = () => undefined) => {
      initialization ??= initialize(projection, assertActive).catch((error) => {
        initialization = null;
        throw error;
      });
      return initialization;
    },
    close: () => closeAgentServices(
      dependencies.memory,
      dependencies.threads,
      dependencies.automations,
    ),
  };
}

export interface OutlineDesktopHostLifecycleDependencies {
  readonly documents: {
    init(): Promise<ProjectionSnapshot>;
    replacePersonalAccessRanking(entries: ReadonlyMap<string, NodeAccessStats>): Promise<void>;
    close(): void;
  };
  readonly client: { close(): void };
  readonly nodeAccess: {
    load(): Promise<void>;
    snapshot(): ReadonlyMap<string, NodeAccessStats>;
    flushNow(): Promise<void>;
  };
  readonly reportError: (report: ErrorReport) => void;
}

export function createOutlineDesktopHostLifecycle(
  dependencies: OutlineDesktopHostLifecycleDependencies,
) {
  let accessLoading: Promise<void> | null = null;
  let ranking: Promise<void> | null = null;
  const loadPersonalAccessRanking = () => {
    accessLoading ??= dependencies.nodeAccess.load().catch((error) => {
      dependencies.reportError({
        domain: 'node-access',
        severity: 'warn',
        code: 'node-access-startup-load',
        message: 'Node access store startup load failed',
        context: { operation: 'startup-load' },
        error,
      });
    });
    return accessLoading;
  };
  const initializeRanking = async () => {
    await loadPersonalAccessRanking();
    await dependencies.documents.init();
    await dependencies.documents.replacePersonalAccessRanking(dependencies.nodeAccess.snapshot()).catch((error) => {
      dependencies.reportError({
        domain: 'node-access',
        severity: 'warn',
        code: 'node-access-runtime-sync',
        message: 'Node access ranking Runtime sync failed',
        context: { operation: 'runtime-sync' },
        error,
      });
    });
  };
  return {
    initializeDocuments: () => dependencies.documents.init(),
    loadPersonalAccessRanking,
    initializePersonalAccessRanking: () => {
      ranking ??= initializeRanking().catch((error) => {
        ranking = null;
        throw error;
      });
      return ranking;
    },
    flushDerivedState: () => dependencies.nodeAccess.flushNow(),
    close: () => {
      dependencies.client.close();
      dependencies.documents.close();
    },
  };
}

export function assignOnce<T>(name: string): { readonly get: () => T; readonly set: (value: T) => void } {
  let assigned = false;
  let value: T;
  return {
    get: () => {
      if (!assigned) throw new Error(`${name} is unavailable before Agent Host composition completes.`);
      return value;
    },
    set: (next) => {
      if (assigned) throw new Error(`${name} is already assigned.`);
      value = next;
      assigned = true;
    },
  };
}
