import type { NodeAccessStats } from '../../core/nodeAccessRanking';
import type { ErrorReport } from '../../core/errorObservability';
import type { DocumentProjection, ProjectionSnapshot } from '../../core/types';
import { closeAgentServices } from '../agent/closeAgentServices';

export interface AgentHostLifecycleDependencies {
  readonly delegation?: {
    start(): Promise<void>;
    initialize?(): Promise<void>;
    stop(): Promise<void>;
    closeStore(): void;
  };
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
  return {
    initialize: async (projection, assertActive = () => undefined) => {
      assertActive();
      if (!completed.has('memory-index')) {
        dependencies.memory.initializeMutationIndex(projection);
        completed.add('memory-index');
        assertActive();
      }
      if (!completed.has('threads')) {
        await dependencies.delegation?.start();
        await dependencies.threads.initialize();
        await dependencies.delegation?.initialize?.();
        completed.add('threads');
        assertActive();
      }
      if (!completed.has('memory-worker')) {
        await dependencies.memory.startWorker();
        completed.add('memory-worker');
        assertActive();
      }
      if (!completed.has('automations')) {
        await dependencies.automations.start();
        completed.add('automations');
        assertActive();
      }
    },
    close: async () => {
      const failures: unknown[] = [];
      try {
        await closeAgentServices(dependencies.memory, dependencies.threads, dependencies.automations);
      } catch (error) {
        failures.push(error);
      }
      try {
        await dependencies.delegation?.stop();
      } catch (error) {
        failures.push(error);
      }
      try {
        dependencies.delegation?.closeStore();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) throw new AggregateError(failures, 'Agent Host lifecycle failed to close cleanly');
    },
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
  return {
    initializeDocuments: () => dependencies.documents.init(),
    initializePersonalAccessRanking: async () => {
      await dependencies.nodeAccess.load().catch((error) => {
        dependencies.reportError({
          domain: 'node-access',
          severity: 'warn',
          code: 'node-access-startup-load',
          message: 'Node access store startup load failed',
          context: { operation: 'startup-load' },
          error,
        });
      });
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
