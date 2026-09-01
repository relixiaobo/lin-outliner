import {
decodeAgentCoreRecordedNotification,
decodeAgentCoreTransientNotification,
decodeTurn,
} from '../../../core/agent/codec';
import {
createHostRootTurnAdmissionBarrierSnapshot,
createThreadAdmissionBarrierSnapshot,
type HostRootTurnAdmissionBarrierSnapshot,
type ThreadAdmissionBarrierSnapshot,
type ThreadHistoryRollbackContext,
} from '../../../core/agent/extensions';
import type {
AgentCoreNotification,
AgentCoreRecordedNotification,
AgentCoreTransientNotification,
ThreadId,
ThreadItemDelta,
Turn
} from '../../../core/agent/protocol';
import { ExtensionRegistry } from '../ExtensionRegistry';
import { applyThreadItemDelta } from '../itemDelta';
import { KeyedMutex,Mutex } from '../Mutex';
import { RolloutStore } from '../persistence/RolloutStore';
import { ThreadHistoryProjectionStore } from '../persistence/ThreadHistoryProjectionStore';
import { ThreadMetadataStore,type ThreadCatalogRecord } from '../persistence/ThreadMetadataStore';
import { ToolPayloadStore } from '../persistence/ToolPayloadStore';
import { AgentResourceStore } from '../persistence/AgentResourceStore';
import { RollbackHookRecoveryQueue } from '../RollbackHookRecoveryQueue';
export interface EphemeralThreadState {
  record: ThreadCatalogRecord;
  turns: Turn[];
  completedItemIds: Set<string>;
}

export type NotificationListener = (notification: AgentCoreNotification) => void;
type RecordedItemDelta = Extract<AgentCoreRecordedNotification, { type: 'item/delta' }>;
type StringItemDelta = Extract<ThreadItemDelta, { delta: string }>;

export interface ThreadCoreOptions {
  readonly deltaCoalesceDelayMs?: number;
  readonly schedule?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelScheduled?: (handle: unknown) => void;
  readonly onNotificationError?: (message: string, error: unknown) => void;
}

interface PendingItemDelta {
  readonly threadId: ThreadId;
  readonly turnId: string;
  readonly itemId: string;
  readonly deltaType: StringItemDelta['type'];
  readonly ephemeral: boolean;
  delta: string;
  scheduledFlush: unknown | null;
}

const ITEM_DELTA_COALESCE_DELAY_MS = 40;

export class RecordedNotificationProjectionError extends Error {
  readonly projectionErrors: readonly unknown[];

  constructor(projectionErrors: readonly unknown[]) {
    super('Recorded notification projection failed after the durable rollout append');
    this.name = 'RecordedNotificationProjectionError';
    this.projectionErrors = projectionErrors;
  }
}

export class ThreadCore {
  readonly ephemeral = new Map<ThreadId, EphemeralThreadState>();
  readonly hiddenEphemeralThreads = new Set<ThreadId>();
  readonly stoppingThreads = new Set<ThreadId>();
  readonly threadMutex = new KeyedMutex();
  readonly hostRootMutex = new Mutex();
  readonly threadTreeMutex = new Mutex();
  readonly rollbackRecovery = new RollbackHookRecoveryQueue();
  private readonly listeners = new Set<NotificationListener>();
  private readonly threadBarrierGenerations = new Map<ThreadId, number>();
  private readonly pendingItemDeltas = new Map<ThreadId, PendingItemDelta>();
  private readonly notificationQueues = new Map<ThreadId, Promise<unknown>>();
  private readonly deltaCoalesceDelayMs: number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelScheduled: (handle: unknown) => void;
  private readonly onNotificationError: (message: string, error: unknown) => void;
  private hostBarrierGeneration = 0;
  private hostRootAdmissionBarrierActive = false;
  constructor(
    readonly metadata: ThreadMetadataStore,
    readonly history: ThreadHistoryProjectionStore,
    readonly rollout: RolloutStore,
    readonly payloads: ToolPayloadStore,
    readonly resources: AgentResourceStore,
    readonly extensions: ExtensionRegistry,
    options: ThreadCoreOptions = {},
  ) {
    this.deltaCoalesceDelayMs = options.deltaCoalesceDelayMs ?? ITEM_DELTA_COALESCE_DELAY_MS;
    if (!Number.isFinite(this.deltaCoalesceDelayMs) || this.deltaCoalesceDelayMs < 0) {
      throw new Error('Item delta coalescing delay must be a non-negative finite number');
    }
    this.schedule = options.schedule ?? scheduleTimer;
    this.cancelScheduled = options.cancelScheduled ?? cancelTimer;
    this.onNotificationError = options.onNotificationError ?? ((message, error) => console.error(message, error));
  }
  subscribe(listener: NotificationListener): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

  async withThreadAdmissionBarrier<T>(
      threadId: ThreadId,
      operation: (snapshot: ThreadAdmissionBarrierSnapshot) => Promise<T>,
    ): Promise<T> {
      return this.threadMutex.run(threadId, async () => {
        const generation = (this.threadBarrierGenerations.get(threadId) ?? 0) + 1;
        this.threadBarrierGenerations.set(threadId, generation);
        return operation(createThreadAdmissionBarrierSnapshot(threadId, generation));
      });
    }

  async withHostRootTurnAdmissionBarrier<T>(
      operation: (snapshot: HostRootTurnAdmissionBarrierSnapshot) => Promise<T>,
    ): Promise<T> {
      return this.hostRootMutex.run(async () => {
        this.hostBarrierGeneration += 1;
        this.hostRootAdmissionBarrierActive = true;
        try {
          return await operation(createHostRootTurnAdmissionBarrierSnapshot(this.hostBarrierGeneration));
        } finally {
          this.hostRootAdmissionBarrierActive = false;
        }
      });
    }
  async recordNotification(
    notification: AgentCoreRecordedNotification,
    options: { readonly deferObservers?: boolean } = {},
  ): Promise<void> {
      const decoded = decodeAgentCoreRecordedNotification(notification);
      const ephemeral = this.requireThread(decoded.threadId).thread.ephemeral;
      if (isStringItemDelta(decoded)) {
        this.enqueueDeferredNotification(
          decoded.threadId,
          () => this.acceptStringItemDelta(decoded, ephemeral),
          '[agent] deferred item delta failed',
        );
        return;
      }
      await this.enqueueNotification(decoded.threadId, async () => {
        await this.flushPendingItemDeltaBestEffort(decoded.threadId);
        await this.persistRecordedNotification(decoded, ephemeral);
        if (!options.deferObservers) await this.publishDecodedNotification(decoded);
      });
    }

  async persistHistoryRetry(
    context: ThreadHistoryRollbackContext,
    replacementInput: Extract<AgentCoreRecordedNotification, { readonly type: 'turn/started' }>,
  ): Promise<void> {
    const replacement = decodeAgentCoreRecordedNotification(replacementInput);
    if (replacement.type !== 'turn/started') throw new Error('History retry replacement must start a Turn');
    if (replacement.threadId !== context.threadId) {
      throw new Error('History retry replacement Thread does not match its rollback');
    }
    if (this.requireThread(context.threadId).thread.ephemeral) {
      throw new Error('History retry requires a persistent Thread');
    }
    await this.enqueueNotification(context.threadId, async () => {
      await this.flushPendingItemDeltaBestEffort(context.threadId);
      let entry;
      try {
        entry = await this.rollout.appendHistoryRetry(context, replacement);
      } catch (appendError) {
        entry = (await this.rollout.read(context.threadId)).find((candidate) => (
          candidate.event.type === 'history/retry'
          && candidate.event.rollbackId === context.rollbackId
        ));
        if (!entry) throw appendError;
      }
      try {
        this.history.apply(entry);
      } catch (projectionError) {
        try {
          this.history.rebuildThread(context.threadId, await this.rollout.read(context.threadId));
        } catch (rebuildError) {
          throw new RecordedNotificationProjectionError([projectionError, rebuildError]);
        }
      }
    });
  }

  async publishRecordedNotification(notification: AgentCoreRecordedNotification): Promise<void> {
      const decoded = decodeAgentCoreRecordedNotification(notification);
      this.requireThread(decoded.threadId);
      await this.enqueueNotification(decoded.threadId, async () => {
        await this.flushPendingItemDeltaBestEffort(decoded.threadId);
        await this.publishDecodedNotification(decoded);
      });
    }

  async flushThreadNotifications(threadId: ThreadId): Promise<void> {
      await this.enqueueNotification(threadId, () => this.flushPendingItemDelta(threadId));
    }

  async flush(): Promise<void> {
      const threadIds = new Set<ThreadId>([
        ...this.pendingItemDeltas.keys(),
        ...this.notificationQueues.keys(),
      ]);
      const results = await Promise.allSettled(
        [...threadIds].map((threadId) => this.flushThreadNotifications(threadId)),
      );
      results.push(...await Promise.allSettled([this.rollout.flush()]));
      const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length > 0) throw new AggregateError(failures, 'ThreadCore failed to flush notifications');
    }

  private async persistRecordedNotification(
    decoded: AgentCoreRecordedNotification,
    ephemeral: boolean,
  ): Promise<void> {
      if (ephemeral) {
        this.applyEphemeralNotification(decoded);
      } else {
        const entry = await this.rollout.append(decoded.threadId, decoded);
        try {
          this.history.apply(entry);
        } catch (error) {
          try {
            this.history.rebuildThread(decoded.threadId, await this.rollout.read(decoded.threadId));
          } catch (rebuildError) {
            throw new RecordedNotificationProjectionError([error, rebuildError]);
          }
        }
      }
    }

  private async publishDecodedNotification(decoded: AgentCoreRecordedNotification): Promise<void> {
      if (this.hiddenEphemeralThreads.has(decoded.threadId)) return;
      for (const listener of this.listeners) {
        try {
          listener(decoded);
        } catch (error) {
          console.error('[agent] recorded notification listener failed', error);
        }
      }
      await this.extensions.notification(decoded).catch((error) => {
        console.error('[agent] recorded notification observer failed', error);
      });
    }

  private async acceptStringItemDelta(
    notification: RecordedItemDelta & { readonly delta: StringItemDelta },
    ephemeral: boolean,
  ): Promise<void> {
      const pending = this.pendingItemDeltas.get(notification.threadId);
      if (
        pending
        && pending.turnId === notification.turnId
        && pending.itemId === notification.itemId
        && pending.deltaType === notification.delta.type
      ) {
        pending.delta += notification.delta.delta;
        return;
      }
      if (pending) await this.flushPendingItemDeltaBestEffort(notification.threadId);
      const next: PendingItemDelta = {
        threadId: notification.threadId,
        turnId: notification.turnId,
        itemId: notification.itemId,
        deltaType: notification.delta.type,
        ephemeral,
        delta: notification.delta.delta,
        scheduledFlush: null,
      };
      this.pendingItemDeltas.set(notification.threadId, next);
      next.scheduledFlush = this.schedule(() => {
        next.scheduledFlush = null;
        if (this.pendingItemDeltas.get(notification.threadId) !== next) return;
        this.enqueueDeferredNotification(
          notification.threadId,
          () => this.flushPendingItemDelta(notification.threadId),
          '[agent] deferred item delta failed',
        );
      }, this.deltaCoalesceDelayMs);
    }

  private async flushPendingItemDelta(threadId: ThreadId): Promise<void> {
      const pending = this.pendingItemDeltas.get(threadId);
      if (!pending) return;
      this.pendingItemDeltas.delete(threadId);
      if (pending.scheduledFlush !== null) {
        this.cancelScheduled(pending.scheduledFlush);
        pending.scheduledFlush = null;
      }
      const decoded = decodeAgentCoreRecordedNotification({
        type: 'item/delta',
        threadId: pending.threadId,
        turnId: pending.turnId,
        itemId: pending.itemId,
        delta: { type: pending.deltaType, delta: pending.delta },
      });
      await this.persistRecordedNotification(decoded, pending.ephemeral);
      await this.publishDecodedNotification(decoded);
    }

  private async flushPendingItemDeltaBestEffort(threadId: ThreadId): Promise<void> {
      try {
        await this.flushPendingItemDelta(threadId);
      } catch (error) {
        this.reportNotificationError('[agent] deferred item delta failed', error);
      }
    }

  private enqueueDeferredNotification(
    threadId: ThreadId,
    operation: () => Promise<void>,
    failureMessage: string,
  ): void {
      const queued = this.enqueueNotification(threadId, operation);
      void queued.catch((error) => this.reportNotificationError(failureMessage, error));
    }

  private enqueueNotification<T>(threadId: ThreadId, operation: () => Promise<T>): Promise<T> {
      const previous = this.notificationQueues.get(threadId) ?? Promise.resolve();
      const current = previous.then(operation, operation);
      this.notificationQueues.set(threadId, current);
      void current.finally(() => {
        if (this.notificationQueues.get(threadId) === current) this.notificationQueues.delete(threadId);
      }).catch(() => undefined);
      return current;
    }
  emitTransientNotification(notification: AgentCoreTransientNotification): void {
      const decoded = decodeAgentCoreTransientNotification(notification);
      this.requireThread(decoded.threadId);
      this.enqueueDeferredNotification(decoded.threadId, async () => {
        await this.flushPendingItemDeltaBestEffort(decoded.threadId);
        this.broadcastTransientNotification(decoded);
      }, '[agent] transient notification delivery failed');
    }

  private broadcastTransientNotification(decoded: AgentCoreTransientNotification): void {
      if (!this.hiddenEphemeralThreads.has(decoded.threadId)) {
        for (const listener of this.listeners) {
          try {
            listener(decoded);
          } catch (error) {
            console.error('[agent] transient notification listener failed', error);
          }
        }
      }
    }

  private reportNotificationError(message: string, error: unknown): void {
      try {
        this.onNotificationError(message, error);
      } catch (observerError) {
        console.error('[agent] notification error observer failed', observerError);
      }
    }
  applyEphemeralNotification(notification: AgentCoreRecordedNotification): void {
      const state = this.ephemeral.get(notification.threadId);
      if (!state) throw new Error(`Ephemeral Thread not found: ${notification.threadId}`);
      switch (notification.type) {
        case 'turn/started':
          if (state.turns.some((turn) => turn.id === notification.turnId)) {
            throw new Error(`Turn was already started: ${notification.turnId}`);
          }
          state.turns.push(notification.turn);
          for (const item of notification.turn.items) state.completedItemIds.add(item.id);
          return;
        case 'item/started': {
          const index = state.turns.findIndex((turn) => turn.id === notification.turnId);
          if (index < 0) throw new Error(`Item lifecycle precedes Turn start: ${notification.turnId}`);
          const turn = state.turns[index]!;
          if (turn.status !== 'inProgress') throw new Error(`Terminal Turn is immutable: ${notification.turnId}`);
          const itemIndex = turn.items.findIndex((item) => item.id === notification.itemId);
          if (itemIndex >= 0) throw new Error(`Thread Item was already started: ${notification.itemId}`);
          state.turns[index] = decodeTurn({ ...turn, items: [...turn.items, notification.item] });
          return;
        }
        case 'item/completed': {
          const index = state.turns.findIndex((turn) => turn.id === notification.turnId);
          if (index < 0) throw new Error(`Item lifecycle precedes Turn start: ${notification.turnId}`);
          const turn = state.turns[index]!;
          if (turn.status !== 'inProgress') throw new Error(`Terminal Turn is immutable: ${notification.turnId}`);
          const itemIndex = turn.items.findIndex((item) => item.id === notification.itemId);
          if (itemIndex < 0) throw new Error(`Item completion precedes item start: ${notification.itemId}`);
          if (state.completedItemIds.has(notification.itemId)) {
            throw new Error(`Completed Thread Item is immutable: ${notification.itemId}`);
          }
          const items = [...turn.items];
          items[itemIndex] = notification.item;
          state.turns[index] = decodeTurn({ ...turn, items });
          state.completedItemIds.add(notification.itemId);
          return;
        }
        case 'items/completed': {
          const index = state.turns.findIndex((turn) => turn.id === notification.turnId);
          if (index < 0) throw new Error(`Item lifecycle precedes Turn start: ${notification.turnId}`);
          const turn = state.turns[index]!;
          if (turn.status !== 'inProgress') throw new Error(`Terminal Turn is immutable: ${notification.turnId}`);
          const items = [...turn.items];
          for (const item of notification.items) {
            const itemIndex = items.findIndex((candidate) => candidate.id === item.id);
            const owner = state.turns.find((candidate) => candidate.items.some((existing) => existing.id === item.id));
            if (owner && owner.id !== notification.turnId) {
              throw new Error(`Thread Item does not belong to Turn: ${item.id}`);
            }
            if (state.completedItemIds.has(item.id)) {
              throw new Error(`Completed Thread Item is immutable: ${item.id}`);
            }
            if (itemIndex >= 0) {
              items[itemIndex] = item;
            } else {
              items.push(item);
            }
            state.completedItemIds.add(item.id);
          }
          state.turns[index] = decodeTurn({ ...turn, items });
          return;
        }
        case 'item/delta': {
          const index = state.turns.findIndex((turn) => turn.id === notification.turnId);
          if (index < 0) throw new Error(`Item delta precedes Turn start: ${notification.turnId}`);
          const turn = state.turns[index]!;
          if (turn.status !== 'inProgress') throw new Error(`Terminal Turn is immutable: ${notification.turnId}`);
          if (state.completedItemIds.has(notification.itemId)) {
            throw new Error(`Completed Thread Item is immutable: ${notification.itemId}`);
          }
          const itemIndex = turn.items.findIndex((item) => item.id === notification.itemId);
          if (itemIndex < 0) throw new Error(`Item delta precedes item start: ${notification.itemId}`);
          const items = [...turn.items];
          items[itemIndex] = applyThreadItemDelta(items[itemIndex]!, notification.delta);
          state.turns[index] = Object.freeze({ ...turn, items: Object.freeze(items) });
          return;
        }
        case 'turn/completed': {
          const index = state.turns.findIndex((turn) => turn.id === notification.turnId);
          if (index < 0) {
            state.turns.push(notification.turn);
            for (const item of notification.turn.items) state.completedItemIds.add(item.id);
            return;
          }
          const turn = state.turns[index]!;
          if (turn.status !== 'inProgress') throw new Error(`Terminal Turn is immutable: ${notification.turnId}`);
          if (
            turn.items.length !== notification.turn.items.length
            || turn.items.some((item, itemIndex) => JSON.stringify(item) !== JSON.stringify(notification.turn.items[itemIndex]))
          ) {
            throw new Error(`Terminal Turn Items do not match recorded Items: ${notification.turnId}`);
          }
          if (turn.items.some((item) => !state.completedItemIds.has(item.id))) {
            throw new Error(`Terminal Turn contains an unfinished Item: ${notification.turnId}`);
          }
          state.turns[index] = notification.turn;
          return;
        }
        default:
          return;
      }
    }
  requireThread(threadId: ThreadId): ThreadCatalogRecord {
      return this.ephemeral.get(threadId)?.record ?? this.metadata.require(threadId);
    }
  allTurns(threadId: ThreadId): Turn[] {
      const ephemeral = this.ephemeral.get(threadId);
      if (ephemeral) return [...ephemeral.turns];
      return this.history.allTurns(threadId);
    }
  readTurn(threadId: ThreadId, turnId: string): Turn | null {
      return this.ephemeral.get(threadId)?.turns.find((turn) => turn.id === turnId)
        ?? this.history.readTurn(threadId, turnId, 'full');
    }
  threadBarrierGeneration(threadId: ThreadId): number {
    return this.threadBarrierGenerations.get(threadId) ?? 0;
  }
  clearThreadAdmissionBarriers(threadIds: readonly ThreadId[]): void {
    for (const threadId of threadIds) this.threadBarrierGenerations.delete(threadId);
  }
  currentHostBarrierGeneration(): number {
    return this.hostBarrierGeneration;
  }
  isHostRootAdmissionBarrierActive(): boolean {
    return this.hostRootAdmissionBarrierActive;
  }
}

function isStringItemDelta(
  notification: AgentCoreRecordedNotification,
): notification is RecordedItemDelta & { readonly delta: StringItemDelta } {
  return notification.type === 'item/delta' && typeof notification.delta.delta === 'string';
}

function scheduleTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return timer;
}

function cancelTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}
