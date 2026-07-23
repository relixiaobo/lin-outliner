import { useSyncExternalStore } from 'react';
import type { ThreadGoal } from '../../../core/agent/goal';
import type {
  AgentCoreNotification,
  ProviderRetryStatus,
  RequestUserInputAnswer,
  RequestUserInputRequest,
  Thread,
  ThreadConfigurationSummary,
  ThreadId,
  ThreadItem,
  ThreadItemDelta,
  ThreadListResponse,
  ThreadUserContent,
  ThreadTurnsListResponse,
  Turn,
} from '../../../core/agent/protocol';
import { threadPreviewFromContent } from '../../../core/agent/threadPreview';
import { api } from '../../api/client';

export interface ThreadStoreSnapshot {
  readonly threads: readonly Thread[];
  readonly selectedThreadId: ThreadId | null;
  readonly turnsByThread: ReadonlyMap<ThreadId, readonly Turn[]>;
  readonly configurationsByThread: ReadonlyMap<ThreadId, ThreadConfigurationSummary>;
  readonly goalsByThread: ReadonlyMap<ThreadId, ThreadGoal>;
  readonly userInputByThread: ReadonlyMap<ThreadId, RequestUserInputRequest>;
  readonly providerRetryByThread: ReadonlyMap<ThreadId, { readonly turnId: string; readonly status: ProviderRetryStatus }>;
  readonly loading: boolean;
  readonly error: string | null;
}

const EMPTY_SNAPSHOT: ThreadStoreSnapshot = {
  threads: [],
  selectedThreadId: null,
  turnsByThread: new Map(),
  configurationsByThread: new Map(),
  goalsByThread: new Map(),
  userInputByThread: new Map(),
  providerRetryByThread: new Map(),
  loading: true,
  error: null,
};

const MAX_CACHED_TOOL_OUTPUTS = 64;

export class ThreadStore {
  private snapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private unsubscribeNotifications: (() => void) | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly loadGenerations = new Map<ThreadId, number>();
  private readonly historyRevisions = new Map<ThreadId, number>();
  private readonly configurationRevisions = new Map<ThreadId, number>();
  private readonly outputTextCache = new Map<string, Promise<string | null>>();

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
    const configurationsByThread = new Map(this.snapshot.configurationsByThread);
    const goalsByThread = new Map(this.snapshot.goalsByThread);
    const userInputByThread = new Map(this.snapshot.userInputByThread);
    const providerRetryByThread = new Map(this.snapshot.providerRetryByThread);
    for (const deletedId of deletedIds) {
      this.loadGenerations.set(deletedId, (this.loadGenerations.get(deletedId) ?? 0) + 1);
      turnsByThread.delete(deletedId);
      configurationsByThread.delete(deletedId);
      goalsByThread.delete(deletedId);
      userInputByThread.delete(deletedId);
      providerRetryByThread.delete(deletedId);
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
      configurationsByThread,
      goalsByThread,
      userInputByThread,
      providerRetryByThread,
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

  async setThreadConfiguration(
    threadId: ThreadId,
    configuration: ThreadConfigurationSummary,
  ): Promise<void> {
    const revision = (this.configurationRevisions.get(threadId) ?? 0) + 1;
    this.configurationRevisions.set(threadId, revision);
    const response = await this.client.agentCoreRequest('thread/configuration/set', {
      threadId,
      ...configuration,
    });
    if (this.configurationRevisions.get(threadId) !== revision) return;
    if (!this.snapshot.threads.some((thread) => thread.id === threadId)) return;
    const configurationsByThread = new Map(this.snapshot.configurationsByThread);
    configurationsByThread.set(threadId, response.configuration);
    const currentThread = this.snapshot.threads.find((thread) => thread.id === threadId);
    this.patch({
      configurationsByThread,
      threads: sortThreads(upsertById(
        this.snapshot.threads,
        mergeConfiguredThread(response.thread, currentThread),
      )),
    });
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

  readItemOutput(threadId: ThreadId, turnId: string, item: ThreadItem): Promise<string | null> {
    if (!('outputRef' in item) || !item.outputRef) return Promise.resolve(null);
    const key = `${item.provenance.originThreadId}:${item.outputRef.id}`;
    let pending = this.outputTextCache.get(key);
    if (!pending) {
      pending = this.client.agentCoreRequest('thread/item/output/read', {
        threadId,
        turnId,
        itemId: item.id,
        outputId: item.outputRef.id,
      }).then((response) => response.output?.text ?? null).catch(() => {
        this.outputTextCache.delete(key);
        return null;
      });
      this.outputTextCache.set(key, pending);
      while (this.outputTextCache.size > MAX_CACHED_TOOL_OUTPUTS) {
        const oldestKey = this.outputTextCache.keys().next().value;
        if (oldestKey === undefined) break;
        this.outputTextCache.delete(oldestKey);
      }
    }
    return pending;
  }

  turns(threadId: ThreadId): readonly Turn[] {
    return this.snapshot.turnsByThread.get(threadId) ?? [];
  }

  private async loadTurns(threadId: ThreadId): Promise<void> {
    const generation = (this.loadGenerations.get(threadId) ?? 0) + 1;
    this.loadGenerations.set(threadId, generation);
    if (!this.snapshot.turnsByThread.has(threadId)) {
      const turnsByThread = new Map(this.snapshot.turnsByThread);
      turnsByThread.set(threadId, []);
      this.patch({ turnsByThread });
    }
    const startingRevision = this.historyRevisions.get(threadId) ?? 0;
    const startingConfigurationRevision = this.configurationRevisions.get(threadId) ?? 0;
    const requestedThread = this.snapshot.threads.find((thread) => thread.id === threadId);
    const [turns, goal, configuration] = await Promise.all([
      this.loadAllTurns(threadId),
      this.client.agentCoreRequest('goal/get', { threadId }),
      requestedThread && isRendererConfigurableThread(requestedThread)
        ? this.client.agentCoreRequest('thread/configuration/get', { threadId })
        : Promise.resolve(null),
    ]);
    if (this.loadGenerations.get(threadId) !== generation) return;
    if (!this.snapshot.threads.some((thread) => thread.id === threadId)) return;
    const turnsByThread = new Map(this.snapshot.turnsByThread);
    turnsByThread.set(
      threadId,
      (this.historyRevisions.get(threadId) ?? 0) === startingRevision
        ? turns
        : mergeLoadedTurns(turns, turnsByThread.get(threadId) ?? []),
    );
    const goalsByThread = new Map(this.snapshot.goalsByThread);
    if (goal.goal) goalsByThread.set(threadId, goal.goal);
    else goalsByThread.delete(threadId);
    const configurationsByThread = new Map(this.snapshot.configurationsByThread);
    const configurationIsCurrent = Boolean(configuration)
      && (this.configurationRevisions.get(threadId) ?? 0) === startingConfigurationRevision;
    if (configuration && configurationIsCurrent) {
      configurationsByThread.set(threadId, configuration.configuration);
    }
    const currentThread = this.snapshot.threads.find((thread) => thread.id === threadId);
    this.patch({
      configurationsByThread,
      goalsByThread,
      threads: configuration && configurationIsCurrent
        ? sortThreads(upsertById(
          this.snapshot.threads,
          mergeConfiguredThread(configuration.thread, currentThread),
        ))
        : this.snapshot.threads,
      turnsByThread,
    });
  }

  private async loadAllTurns(threadId: ThreadId): Promise<Turn[]> {
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
    return turns;
  }

  private applyNotification(notification: AgentCoreNotification): void {
    const historyNotification = (
      notification.type === 'turn/started'
      || notification.type === 'turn/completed'
      || notification.type === 'item/started'
      || notification.type === 'item/completed'
      || notification.type === 'item/delta'
    );
    if (historyNotification) {
      if (!this.snapshot.turnsByThread.has(notification.threadId)) return;
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
      case 'turn/started': {
        const preview = threadPreviewFromTurn(notification.turn);
        this.updateThread(notification.threadId, (thread) => ({
          ...thread,
          preview: thread.preview.trim() ? thread.preview : preview,
          updatedAt: Math.max(thread.updatedAt, notification.turn.startedAt),
        }));
        this.updateTurn(notification.threadId, notification.turn);
        return;
      }
      case 'turn/completed': {
        const providerRetryByThread = new Map(this.snapshot.providerRetryByThread);
        if (providerRetryByThread.get(notification.threadId)?.turnId === notification.turnId) {
          providerRetryByThread.delete(notification.threadId);
        }
        this.updateThread(notification.threadId, (thread) => ({
          ...thread,
          updatedAt: Math.max(thread.updatedAt, notification.turn.completedAt ?? notification.turn.startedAt),
        }));
        this.updateTurn(notification.threadId, notification.turn, { providerRetryByThread });
        return;
      }
      case 'turn/providerRetry/changed': {
        const providerRetryByThread = new Map(this.snapshot.providerRetryByThread);
        if (notification.status) {
          providerRetryByThread.set(notification.threadId, {
            turnId: notification.turnId,
            status: notification.status,
          });
        } else if (providerRetryByThread.get(notification.threadId)?.turnId === notification.turnId) {
          providerRetryByThread.delete(notification.threadId);
        }
        this.patch({ providerRetryByThread });
        return;
      }
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

  private updateTurn(
    threadId: ThreadId,
    turn: Turn,
    patch: Partial<ThreadStoreSnapshot> = {},
  ): void {
    const turnsByThread = new Map(this.snapshot.turnsByThread);
    turnsByThread.set(threadId, upsertById(turnsByThread.get(threadId) ?? [], turn));
    this.patch({ ...patch, turnsByThread });
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

function threadPreviewFromTurn(turn: Turn): string {
  const content = turn.items
    .filter((item) => item.type === 'userMessage')
    .flatMap((item) => item.content);
  return threadPreviewFromContent(content);
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

function isRendererConfigurableThread(thread: Thread): boolean {
  return thread.parentThreadId === null && thread.threadSource === 'user';
}

function mergeConfiguredThread(loaded: Thread, current: Thread | undefined): Thread {
  if (!current || loaded.updatedAt >= current.updatedAt) return loaded;
  return { ...current, modelProvider: loaded.modelProvider };
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
  const items = loaded.items.map((item) => mergeLoadedItem(item, currentItems.get(item.id)));
  const loadedItemIds = new Set(loaded.items.map((item) => item.id));
  items.push(...current.items.filter((item) => !loadedItemIds.has(item.id)));
  return { ...loaded, ...current, items };
}

type ExecutableThreadItem = Extract<ThreadItem, {
  type:
    | 'commandExecution'
    | 'fileChange'
    | 'mcpToolCall'
    | 'dynamicToolCall'
    | 'collabAgentToolCall'
    | 'webSearch';
}>;

function mergeLoadedItem(loaded: ThreadItem, current: ThreadItem | undefined): ThreadItem {
  if (!current) return loaded;
  const loadedStatus = executableItemStatus(loaded);
  const currentStatus = executableItemStatus(current);
  if (loadedStatus && currentStatus) {
    if (currentStatus !== 'inProgress') return current;
    if (loadedStatus !== 'inProgress') return loaded;
  }
  return current;
}

function executableItemStatus(item: ThreadItem): ExecutableThreadItem['status'] | null {
  switch (item.type) {
    case 'commandExecution':
    case 'fileChange':
    case 'mcpToolCall':
    case 'dynamicToolCall':
    case 'collabAgentToolCall':
    case 'webSearch':
      return item.status;
    default:
      return null;
  }
}

function applyItemDelta(item: ThreadItem, delta: ThreadItemDelta): ThreadItem {
  switch (delta.type) {
    case 'agentMessageText':
      return item.type === 'agentMessage' ? { ...item, text: item.text + delta.delta } : item;
    case 'planText':
      return item.type === 'plan' ? { ...item, text: item.text + delta.delta } : item;
    case 'reasoningSummary':
      return item.type === 'reasoning' ? appendReasoningDelta(item, 'summary', delta.delta) : item;
    case 'reasoningContent':
      return item.type === 'reasoning' ? appendReasoningDelta(item, 'content', delta.delta) : item;
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

function appendReasoningDelta(
  item: Extract<ThreadItem, { type: 'reasoning' }>,
  key: 'summary' | 'content',
  delta: string,
): Extract<ThreadItem, { type: 'reasoning' }> {
  const values = [...item[key]];
  if (values.length === 0) values.push(delta);
  else values[values.length - 1] = values.at(-1)! + delta;
  return { ...item, [key]: values };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
