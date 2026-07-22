import { useSyncExternalStore } from 'react';
import type { ThreadGoal } from '../../../core/agent/goal';
import type {
  AgentCoreNotification,
  RequestUserInputAnswer,
  RequestUserInputRequest,
  Thread,
  ThreadId,
  ThreadItem,
  ThreadItemDelta,
  ThreadListResponse,
  ThreadUserContent,
  ThreadTurnsListResponse,
  Turn,
} from '../../../core/agent/protocol';
import { api } from '../../api/client';

export interface ThreadStoreSnapshot {
  readonly threads: readonly Thread[];
  readonly selectedThreadId: ThreadId | null;
  readonly turnsByThread: ReadonlyMap<ThreadId, readonly Turn[]>;
  readonly goalsByThread: ReadonlyMap<ThreadId, ThreadGoal>;
  readonly userInputByThread: ReadonlyMap<ThreadId, RequestUserInputRequest>;
  readonly loading: boolean;
  readonly error: string | null;
}

const EMPTY_SNAPSHOT: ThreadStoreSnapshot = {
  threads: [],
  selectedThreadId: null,
  turnsByThread: new Map(),
  goalsByThread: new Map(),
  userInputByThread: new Map(),
  loading: true,
  error: null,
};

export class ThreadStore {
  private snapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private unsubscribeNotifications: (() => void) | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly loadGenerations = new Map<ThreadId, number>();
  private readonly historyRevisions = new Map<ThreadId, number>();

  constructor(private readonly client: Pick<typeof api, 'agentCoreRequest' | 'onAgentCoreNotification'> = api) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ThreadStoreSnapshot => this.snapshot;

  initialize(): Promise<void> {
    if (!this.unsubscribeNotifications) {
      this.unsubscribeNotifications = this.client.onAgentCoreNotification((notification) => this.applyNotification(notification));
    }
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.reloadThreads().catch((error) => {
      this.patch({ loading: false, error: errorMessage(error) });
    });
    return this.initializePromise;
  }

  dispose(): void {
    this.unsubscribeNotifications?.();
    this.unsubscribeNotifications = null;
  }

  async reloadThreads(): Promise<void> {
    this.patch({ loading: true, error: null });
    const threads: Thread[] = [];
    let cursor: string | null = null;
    do {
      const page: ThreadListResponse = await this.client.agentCoreRequest('thread/list', { cursor, limit: 100 });
      threads.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    const selected = this.snapshot.selectedThreadId && threads.some((thread) => thread.id === this.snapshot.selectedThreadId)
      ? this.snapshot.selectedThreadId
      : threads[0]?.id ?? null;
    this.patch({ threads: sortThreads(threads), selectedThreadId: selected, loading: false, error: null });
    if (selected) await this.loadTurns(selected);
  }

  async selectThread(threadId: ThreadId): Promise<void> {
    if (!this.snapshot.threads.some((thread) => thread.id === threadId)) throw new Error(`Thread not found: ${threadId}`);
    this.patch({ selectedThreadId: threadId, error: null });
    await this.loadTurns(threadId);
  }

  async createThread(input: { name?: string } = {}): Promise<Thread> {
    const response = await this.client.agentCoreRequest('thread/start', {
      source: 'app',
      threadSource: 'user',
      ...(input.name ? { name: input.name } : {}),
    });
    this.patch({ threads: sortThreads(upsertById(this.snapshot.threads, response.thread)) });
    await this.selectThread(response.thread.id);
    return response.thread;
  }

  async renameThread(threadId: ThreadId, name: string | null): Promise<void> {
    await this.client.agentCoreRequest('thread/name/set', { threadId, name });
    this.updateThread(threadId, (thread) => ({ ...thread, name }));
  }

  async deleteThread(threadId: ThreadId): Promise<void> {
    await this.client.agentCoreRequest('thread/delete', { threadId });
    const deletedIds = descendantThreadIds(this.snapshot.threads, threadId);
    const threads = this.snapshot.threads.filter((thread) => !deletedIds.has(thread.id));
    const turnsByThread = new Map(this.snapshot.turnsByThread);
    const goalsByThread = new Map(this.snapshot.goalsByThread);
    const userInputByThread = new Map(this.snapshot.userInputByThread);
    for (const deletedId of deletedIds) {
      this.loadGenerations.set(deletedId, (this.loadGenerations.get(deletedId) ?? 0) + 1);
      turnsByThread.delete(deletedId);
      goalsByThread.delete(deletedId);
      userInputByThread.delete(deletedId);
    }
    const selectedThreadWasDeleted = Boolean(
      this.snapshot.selectedThreadId && deletedIds.has(this.snapshot.selectedThreadId),
    );
    const replacementThreadId = selectedThreadWasDeleted
      ? threads[0]?.id ?? null
      : this.snapshot.selectedThreadId;
    this.patch({
      threads,
      turnsByThread,
      goalsByThread,
      userInputByThread,
      selectedThreadId: replacementThreadId,
    });
    if (selectedThreadWasDeleted && replacementThreadId) await this.loadTurns(replacementThreadId);
  }

  async send(contentInput: readonly ThreadUserContent[]): Promise<void> {
    const content = contentInput.flatMap((part): ThreadUserContent[] => {
      if (part.type !== 'text') return [part];
      const text = part.text.trim();
      return text ? [{ ...part, text }] : [];
    });
    const threadId = this.snapshot.selectedThreadId;
    if (!threadId || content.length === 0) return;
    const active = findLastInProgressTurn(this.turns(threadId));
    if (active) {
      await this.client.agentCoreRequest('turn/steer', {
        threadId,
        expectedTurnId: active.id,
        input: content,
        clientUserMessageId: crypto.randomUUID(),
      });
    } else {
      await this.client.agentCoreRequest('turn/start', {
        threadId,
        input: content,
        clientUserMessageId: crypto.randomUUID(),
      });
    }
  }

  async interrupt(threadId: ThreadId): Promise<void> {
    const active = findLastInProgressTurn(this.turns(threadId));
    if (!active) return;
    await this.client.agentCoreRequest('turn/interrupt', { threadId, turnId: active.id });
  }

  async fork(threadId: ThreadId, turnId: string, kind: 'beforeTurn' | 'afterTurn'): Promise<Thread> {
    const response = await this.client.agentCoreRequest('thread/fork', {
      threadId,
      boundary: { kind, turnId },
    });
    this.patch({ threads: sortThreads(upsertById(this.snapshot.threads, response.thread)) });
    await this.selectThread(response.thread.id);
    return response.thread;
  }

  async forkAndSend(
    threadId: ThreadId,
    turnId: string,
    kind: 'beforeTurn' | 'afterTurn',
    content: readonly ThreadUserContent[],
  ): Promise<Thread> {
    const thread = await this.fork(threadId, turnId, kind);
    await this.send(content);
    return thread;
  }

  async respondToUserInput(
    request: RequestUserInputRequest,
    answers: readonly RequestUserInputAnswer[],
  ): Promise<void> {
    await this.client.agentCoreRequest('userInput/respond', {
      threadId: request.threadId,
      turnId: request.turnId,
      itemId: request.itemId,
      answers,
      autoResolved: false,
    });
  }

  turns(threadId: ThreadId): readonly Turn[] {
    return this.snapshot.turnsByThread.get(threadId) ?? [];
  }

  private async loadTurns(threadId: ThreadId): Promise<void> {
    const generation = (this.loadGenerations.get(threadId) ?? 0) + 1;
    this.loadGenerations.set(threadId, generation);
    const startingRevision = this.historyRevisions.get(threadId) ?? 0;
    const turns: Turn[] = [];
    let cursor: string | null = null;
    do {
      const page: ThreadTurnsListResponse = await this.client.agentCoreRequest('thread/turns/list', {
        threadId,
        cursor,
        limit: 100,
        itemsView: 'full',
      });
      turns.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    if (this.loadGenerations.get(threadId) !== generation) return;
    if (!this.snapshot.threads.some((thread) => thread.id === threadId)) return;
    const turnsByThread = new Map(this.snapshot.turnsByThread);
    turnsByThread.set(
      threadId,
      (this.historyRevisions.get(threadId) ?? 0) === startingRevision
        ? turns
        : mergeLoadedTurns(turns, turnsByThread.get(threadId) ?? []),
    );
    this.patch({ turnsByThread });
    const goal = await this.client.agentCoreRequest('goal/get', { threadId });
    if (this.loadGenerations.get(threadId) !== generation) return;
    if (!this.snapshot.threads.some((thread) => thread.id === threadId)) return;
    const goalsByThread = new Map(this.snapshot.goalsByThread);
    if (goal.goal) goalsByThread.set(threadId, goal.goal);
    else goalsByThread.delete(threadId);
    this.patch({ goalsByThread });
  }

  private applyNotification(notification: AgentCoreNotification): void {
    if (
      notification.type === 'turn/started'
      || notification.type === 'turn/completed'
      || notification.type === 'item/started'
      || notification.type === 'item/completed'
      || notification.type === 'item/delta'
    ) {
      this.historyRevisions.set(
        notification.threadId,
        (this.historyRevisions.get(notification.threadId) ?? 0) + 1,
      );
    }
    switch (notification.type) {
      case 'thread/started':
        this.patch({
          threads: sortThreads(upsertById(this.snapshot.threads, notification.thread)),
          selectedThreadId: this.snapshot.selectedThreadId ?? notification.thread.id,
        });
        return;
      case 'thread/status/changed':
        this.updateThread(notification.threadId, (thread) => ({ ...thread, status: notification.status }));
        return;
      case 'turn/started':
      case 'turn/completed':
        this.updateTurn(notification.threadId, notification.turn);
        return;
      case 'item/started':
      case 'item/completed':
        this.updateItem(notification.threadId, notification.turnId, notification.item);
        return;
      case 'item/delta':
        this.updateItemDelta(notification.threadId, notification.turnId, notification.itemId, notification.delta);
        return;
      case 'userInput/requested': {
        const userInputByThread = new Map(this.snapshot.userInputByThread);
        userInputByThread.set(notification.threadId, notification.request);
        this.patch({ userInputByThread });
        return;
      }
      case 'userInput/resolved': {
        const userInputByThread = new Map(this.snapshot.userInputByThread);
        userInputByThread.delete(notification.threadId);
        this.patch({ userInputByThread });
        return;
      }
      case 'goal/updated': {
        const goalsByThread = new Map(this.snapshot.goalsByThread);
        goalsByThread.set(notification.threadId, notification.goal);
        this.patch({ goalsByThread });
        return;
      }
      case 'goal/cleared': {
        const goalsByThread = new Map(this.snapshot.goalsByThread);
        goalsByThread.delete(notification.threadId);
        this.patch({ goalsByThread });
        return;
      }
    }
  }

  private updateThread(threadId: ThreadId, update: (thread: Thread) => Thread): void {
    this.patch({ threads: sortThreads(this.snapshot.threads.map((thread) => thread.id === threadId ? update(thread) : thread)) });
  }

  private updateTurn(threadId: ThreadId, turn: Turn): void {
    const turnsByThread = new Map(this.snapshot.turnsByThread);
    turnsByThread.set(threadId, upsertById(turnsByThread.get(threadId) ?? [], turn));
    this.patch({ turnsByThread });
  }

  private updateItem(threadId: ThreadId, turnId: string, item: ThreadItem): void {
    this.updateTurnItems(threadId, turnId, (items) => upsertById(items, item));
  }

  private updateItemDelta(
    threadId: ThreadId,
    turnId: string,
    itemId: string,
    delta: ThreadItemDelta,
  ): void {
    this.updateTurnItems(threadId, turnId, (items) => items.map((item) => (
      item.id === itemId ? applyItemDelta(item, delta) : item
    )));
  }

  private updateTurnItems(
    threadId: ThreadId,
    turnId: string,
    update: (items: readonly ThreadItem[]) => readonly ThreadItem[],
  ): void {
    const turnsByThread = new Map(this.snapshot.turnsByThread);
    turnsByThread.set(threadId, (turnsByThread.get(threadId) ?? []).map((turn) => (
      turn.id === turnId ? { ...turn, items: update(turn.items) } : turn
    )));
    this.patch({ turnsByThread });
  }

  private patch(patch: Partial<ThreadStoreSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

export const threadStore = new ThreadStore();

export function useThreadStore(): ThreadStoreSnapshot {
  return useSyncExternalStore(threadStore.subscribe, threadStore.getSnapshot, threadStore.getSnapshot);
}

function upsertById<T extends { readonly id: string }>(values: readonly T[], value: T): T[] {
  const index = values.findIndex((candidate) => candidate.id === value.id);
  if (index < 0) return [...values, value];
  const next = [...values];
  next[index] = value;
  return next;
}

function descendantThreadIds(threads: readonly Thread[], rootThreadId: ThreadId): Set<ThreadId> {
  const deletedIds = new Set<ThreadId>([rootThreadId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const thread of threads) {
      if (thread.parentThreadId && deletedIds.has(thread.parentThreadId) && !deletedIds.has(thread.id)) {
        deletedIds.add(thread.id);
        changed = true;
      }
    }
  }
  return deletedIds;
}

function sortThreads(threads: readonly Thread[]): Thread[] {
  return [...threads].sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id));
}

function findLastInProgressTurn(turns: readonly Turn[]): Turn | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.status === 'inProgress') return turn;
  }
  return undefined;
}

export function mergeLoadedTurns(loaded: readonly Turn[], current: readonly Turn[]): Turn[] {
  const currentById = new Map(current.map((turn) => [turn.id, turn]));
  const merged = loaded.map((turn) => mergeLoadedTurn(turn, currentById.get(turn.id)));
  const loadedIds = new Set(loaded.map((turn) => turn.id));
  merged.push(...current.filter((turn) => !loadedIds.has(turn.id)));
  return merged.sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
}

function mergeLoadedTurn(loaded: Turn, current: Turn | undefined): Turn {
  if (!current) return loaded;
  if (current.status !== 'inProgress') return current;
  if (loaded.status !== 'inProgress') return loaded;
  const currentItems = new Map(current.items.map((item) => [item.id, item]));
  const items = loaded.items.map((item) => currentItems.get(item.id) ?? item);
  const loadedItemIds = new Set(loaded.items.map((item) => item.id));
  items.push(...current.items.filter((item) => !loadedItemIds.has(item.id)));
  return { ...loaded, ...current, items };
}

function applyItemDelta(item: ThreadItem, delta: ThreadItemDelta): ThreadItem {
  switch (delta.type) {
    case 'agentMessageText':
      return item.type === 'agentMessage' ? { ...item, text: item.text + delta.delta } : item;
    case 'planText':
      return item.type === 'plan' ? { ...item, text: item.text + delta.delta } : item;
    case 'reasoningSummary':
      return item.type === 'reasoning' ? { ...item, summary: [...item.summary, delta.delta] } : item;
    case 'reasoningContent':
      return item.type === 'reasoning' ? { ...item, content: [...item.content, delta.delta] } : item;
    case 'commandOutput':
      return item.type === 'commandExecution'
        ? { ...item, aggregatedOutput: (item.aggregatedOutput ?? '') + delta.delta }
        : item;
    case 'dynamicToolOutput':
      return item.type === 'dynamicToolCall'
        ? { ...item, contentItems: [...(item.contentItems ?? []), delta.delta] }
        : item;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
