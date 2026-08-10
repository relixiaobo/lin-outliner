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
} from '../../../core/agent/extensions';
import type {
AgentCoreNotification,
AgentCoreRecordedNotification,
AgentCoreTransientNotification,
ThreadId,
Turn,
TurnItemsView,
} from '../../../core/agent/protocol';
import { ExtensionRegistry } from '../ExtensionRegistry';
import { applyThreadItemDelta } from '../itemDelta';
import { KeyedMutex,Mutex } from '../Mutex';
import { RolloutStore } from '../persistence/RolloutStore';
import { ThreadHistoryProjectionStore } from '../persistence/ThreadHistoryProjectionStore';
import { ThreadMetadataStore,type ThreadCatalogRecord } from '../persistence/ThreadMetadataStore';
import { ToolPayloadStore } from '../persistence/ToolPayloadStore';
import { RollbackHookRecoveryQueue } from '../RollbackHookRecoveryQueue';
export interface EphemeralThreadState {
  record: ThreadCatalogRecord;
  turns: Turn[];
  completedItemIds: Set<string>;
}

export type NotificationListener = (notification: AgentCoreNotification) => void;
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
  private hostBarrierGeneration = 0;
  private hostRootAdmissionBarrierActive = false;
  constructor(
    readonly metadata: ThreadMetadataStore,
    readonly history: ThreadHistoryProjectionStore,
    readonly rollout: RolloutStore,
    readonly payloads: ToolPayloadStore,
    readonly extensions: ExtensionRegistry,
  ) {}
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
  async recordNotification(notification: AgentCoreRecordedNotification): Promise<void> {
      const decoded = decodeAgentCoreRecordedNotification(notification);
      const record = this.requireThread(decoded.threadId);
      if (record.thread.ephemeral) {
        this.applyEphemeralNotification(decoded);
      } else {
        const entry = await this.rollout.append(decoded.threadId, decoded);
        try {
          this.history.apply(entry);
        } catch (error) {
          try {
            this.history.rebuildThread(decoded.threadId, await this.rollout.read(decoded.threadId));
          } catch {
            throw error;
          }
        }
      }
      if (!this.hiddenEphemeralThreads.has(decoded.threadId)) {
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
    }
  emitTransientNotification(notification: AgentCoreTransientNotification): void {
      const decoded = decodeAgentCoreTransientNotification(notification);
      this.requireThread(decoded.threadId);
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
          state.turns[index] = decodeTurn({ ...turn, items });
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
  allTurns(threadId: ThreadId, itemsView: TurnItemsView = 'full'): Turn[] {
      const ephemeral = this.ephemeral.get(threadId);
      if (ephemeral) return [...ephemeral.turns];
      return this.history.allTurns(threadId, itemsView);
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
