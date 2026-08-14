import { useSyncExternalStore } from 'react';
import {
  acknowledgeThreadComposerContext,
  pendingComposerAdditionalContext,
} from '../agentReveal';
import type { ThreadGoal } from '../../../core/agent/goal';
import type {
  AgentCoreNotification,
  ProviderRetryStatus,
  RequestUserInputAnswer,
  RequestUserInputRequest,
  JsonValue,
  RendererUserViewHints,
  Thread,
  ThreadConfigurationSummary,
  ThreadForkResponse,
  ThreadId,
  ThreadItem,
  ThreadItemDelta,
  ThreadListResponse,
  SubagentExecutionProjection,
  ThreadSubagentsResponse,
  TurnPlanSnapshot,
  TurnId,
  ThreadUserContent,
  ThreadTurnsListResponse,
  Turn,
} from '../../../core/agent/protocol';
import {
  boundedToolArgumentsForDisplay,
  modelCallArgumentSource,
} from '../../../core/agent/modelCallHistory';
import { threadPreviewFromContent } from '../../../core/agent/threadPreview';
import { api } from '../../api/client';

export interface ActiveTurnPlan extends TurnPlanSnapshot {
  readonly turnId: TurnId;
}

export interface ThreadDescendantsView {
  readonly threads: readonly Thread[];
  /** Children holding queued work that has not started a Turn yet. */
  readonly queuedWorkThreadIds: ReadonlySet<ThreadId>;
}

export interface ThreadStoreSnapshot {
  readonly threads: readonly Thread[];
  readonly selectedThreadId: ThreadId | null;
  readonly turnsByThread: ReadonlyMap<ThreadId, readonly Turn[]>;
  readonly latestTurnByThread: ReadonlyMap<ThreadId, Turn>;
  readonly configurationsByThread: ReadonlyMap<ThreadId, ThreadConfigurationSummary>;
  readonly goalsByThread: ReadonlyMap<ThreadId, ThreadGoal>;
  readonly userInputByThread: ReadonlyMap<ThreadId, RequestUserInputRequest>;
  readonly providerRetryByThread: ReadonlyMap<ThreadId, { readonly turnId: string; readonly status: ProviderRetryStatus }>;
  readonly planByThread: ReadonlyMap<ThreadId, ActiveTurnPlan>;
  /**
   * Canonical Agent execution records for the loaded conversations, keyed by
   * the stable Agent ID. This is the registry's input: a delegated child spans
   * many Turns, so its lifecycle cannot be read off the Turn that spawned it.
   */
  readonly subagentExecutionsByAgentId: ReadonlyMap<ThreadId, SubagentExecutionProjection>;
  readonly loading: boolean;
  readonly error: string | null;
}

const EMPTY_SNAPSHOT: ThreadStoreSnapshot = {
  threads: [],
  selectedThreadId: null,
  turnsByThread: new Map(),
  latestTurnByThread: new Map(),
  configurationsByThread: new Map(),
  goalsByThread: new Map(),
  userInputByThread: new Map(),
  providerRetryByThread: new Map(),
  planByThread: new Map(),
  subagentExecutionsByAgentId: new Map(),
  loading: true,
  error: null,
};

const MAX_CACHED_TOOL_OUTPUTS = 64;
const LISTENER_FALLBACK_DELAY_MS = 16;

export type ThreadStoreListenerScheduler = (flush: () => void) => void;
type ThreadStoreListenerDelivery = 'immediate' | 'frame';

export class ThreadStore {
  private snapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private unsubscribeNotifications: (() => void) | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly loadGenerations = new Map<ThreadId, number>();
  private readonly historyRevisions = new Map<ThreadId, number>();
  private readonly configurationRevisions = new Map<ThreadId, number>();
  private readonly outputTextCache = new Map<string, Promise<string | null>>();
  private readonly toolArgumentsCache = new Map<string, Promise<JsonValue | null>>();
  private listenerFlushScheduled = false;
  private listenerFlushGeneration = 0;

  constructor(
    private readonly client: Pick<typeof api, 'agentCoreRequest' | 'onAgentCoreNotification'> = api,
    private readonly scheduleListenerFlush: ThreadStoreListenerScheduler = scheduleOnNextFrame,
  ) {}

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
    // Captured before the round trips: a retry that arrives while they are in
    // flight is a different entry and must survive the clear below.
    const staleRetries = new Map(this.snapshot.providerRetryByThread);
    const threads: Thread[] = [];
    let cursor: string | null = null;
    do {
      const page: ThreadListResponse = await this.client.agentCoreRequest('thread/list', { cursor, limit: 100 });
      threads.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    // `thread/list` is root conversations only, but the store's Thread map is
    // the renderer's catalog, not the list: child Threads already known stay,
    // or every Subagent row in the open transcript would lose its identity and
    // live status on a reload.
    const known = [...threads, ...this.snapshot.threads.filter((thread) => (
      thread.parentThreadId !== null && !threads.some((root) => root.id === thread.id)
    ))];
    const selected = this.snapshot.selectedThreadId && known.some((thread) => thread.id === this.snapshot.selectedThreadId)
      ? this.snapshot.selectedThreadId
      : threads[0]?.id ?? null;
    this.patch({
      threads: sortThreads(known),
      selectedThreadId: selected,
      latestTurnByThread: filterMapKeys(this.snapshot.latestTurnByThread, new Set(known.map((thread) => thread.id))),
      planByThread: new Map(),
      // A reload rebuilds from the server's view, so a banner recorded before
      // it describes an attempt that no longer exists — but only those.
      providerRetryByThread: retriesOutliving(staleRetries, this.snapshot.providerRetryByThread),
      loading: false,
      error: null,
    });
    if (selected) await this.loadTurns(selected);
  }

  async selectThread(threadId: ThreadId): Promise<void> {
    if (!this.snapshot.threads.some((thread) => thread.id === threadId)) throw new Error(`Thread not found: ${threadId}`);
    this.patch({ selectedThreadId: threadId, error: null });
    // Children are no longer listed, so a fresh renderer knows none of them and
    // every Subagent row in this transcript would read "Not found" for a child
    // that merely finished. One subtree read per selection restores the catalog
    // this conversation needs, and prunes children the server no longer has.
    void this.listDescendants(threadId).catch(() => undefined);
    void this.loadSubagentExecutions(threadId).catch(() => undefined);
    await this.loadTurns(threadId);
  }

  /**
   * The conversation's Agent registry input, read once per selection.
   *
   * Live changes arrive as `subagent/execution/changed`, so this read is the
   * cold-start half only: a conversation reopened days later still knows which
   * Agents it delegated, which of them the user stopped, and which left a
   * worktree behind.
   */
  async loadSubagentExecutions(threadId: ThreadId): Promise<void> {
    const response: ThreadSubagentsResponse = await this.client.agentCoreRequest(
      'thread/subagents/list',
      { threadId },
    );
    const subagentExecutionsByAgentId = new Map(this.snapshot.subagentExecutionsByAgentId);
    for (const execution of response.data) subagentExecutionsByAgentId.set(execution.agentId, execution);
    this.patch({ subagentExecutionsByAgentId });
  }

  async openThreadById(threadId: ThreadId): Promise<void> {
    await this.ensureThreadRecord(threadId);
    await this.selectThread(threadId);
  }

  /**
   * Load a Thread's history WITHOUT making it the selected conversation.
   *
   * A delegated child is read in place, inside its parent conversation, so the
   * parent stays selected and mounted: its transcript keeps the scroll position
   * the reader left it at, with no snapshot to restore and nothing to re-anchor.
   * Live notifications already reach any Thread whose history is loaded — they
   * gate on `turnsByThread`, not on selection — so the child streams while the
   * parent is still the conversation the composer talks to.
   */
  async ensureThreadHistory(threadId: ThreadId): Promise<void> {
    await this.ensureThreadRecord(threadId);
    await this.loadTurns(threadId);
  }

  private async ensureThreadRecord(threadId: ThreadId): Promise<void> {
    if (this.snapshot.threads.some((thread) => thread.id === threadId)) return;
    const response = await this.client.agentCoreRequest('thread/read', { threadId, includeTurns: false });
    this.patch({ threads: sortThreads(upsertById(this.snapshot.threads, response.thread)) });
  }

  /**
   * The parent-side browse surface for children, which are no longer list rows.
   * Results are folded into the catalog so their names and live status are
   * available to the transcript without a second read.
   *
   * It is also the only thing that can retire a child record: `thread/list`
   * never mentions children, so absence from a subtree read is the sole
   * evidence one is gone — a spawn that failed after broadcasting
   * `thread/started` would otherwise leave a row that never dies. Only records
   * that existed BEFORE the request are eligible, so a child created while it
   * was in flight is never pruned by a snapshot that predates it.
   */
  async listDescendants(threadId: ThreadId): Promise<ThreadDescendantsView> {
    const knownBefore = descendantThreadIds(this.snapshot.threads, threadId);
    const response = await this.client.agentCoreRequest('thread/descendants', { threadId });
    const returned = new Set(response.data.map((thread) => thread.id));
    let threads = this.snapshot.threads.filter((thread) => (
      thread.id === threadId || !knownBefore.has(thread.id) || returned.has(thread.id)
    ));
    for (const thread of response.data) threads = upsertById(threads, thread);
    if (threads.length !== this.snapshot.threads.length || response.data.length > 0) {
      this.patch({ threads: sortThreads(threads) });
    }
    return { threads: response.data, queuedWorkThreadIds: new Set(response.queuedWorkThreadIds) };
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

  /** Whether this Thread is kept in the readable transcript records. */
  async readThreadRecorded(threadId: ThreadId): Promise<boolean> {
    return (await this.client.agentCoreRequest('thread/records/get', { threadId })).recorded;
  }

  /** Main owns the effect — removing the artifact, or letting it be written again. */
  async setThreadRecorded(threadId: ThreadId, recorded: boolean): Promise<boolean> {
    return (await this.client.agentCoreRequest('thread/records/set', { threadId, recorded })).recorded;
  }

  async deleteThread(threadId: ThreadId): Promise<void> {
    await this.client.agentCoreRequest('thread/delete', { threadId });
    const deletedIds = descendantThreadIds(this.snapshot.threads, threadId);
    const threads = this.snapshot.threads.filter((thread) => !deletedIds.has(thread.id));
    const turnsByThread = new Map(this.snapshot.turnsByThread);
    const latestTurnByThread = new Map(this.snapshot.latestTurnByThread);
    const configurationsByThread = new Map(this.snapshot.configurationsByThread);
    const goalsByThread = new Map(this.snapshot.goalsByThread);
    const userInputByThread = new Map(this.snapshot.userInputByThread);
    const providerRetryByThread = new Map(this.snapshot.providerRetryByThread);
    const planByThread = new Map(this.snapshot.planByThread);
    const subagentExecutionsByAgentId = new Map(this.snapshot.subagentExecutionsByAgentId);
    for (const deletedId of deletedIds) {
      this.loadGenerations.set(deletedId, (this.loadGenerations.get(deletedId) ?? 0) + 1);
      turnsByThread.delete(deletedId);
      latestTurnByThread.delete(deletedId);
      configurationsByThread.delete(deletedId);
      goalsByThread.delete(deletedId);
      userInputByThread.delete(deletedId);
      providerRetryByThread.delete(deletedId);
      planByThread.delete(deletedId);
      subagentExecutionsByAgentId.delete(deletedId);
    }
    const selectedThreadWasDeleted = Boolean(
      this.snapshot.selectedThreadId && deletedIds.has(this.snapshot.selectedThreadId),
    );
    // The catalog retains children, so the first entry can be a Subagent that
    // just ran. Falling back to one would open a Thread the user never chose,
    // with no matching row in the roots-only history list.
    const replacementThreadId = selectedThreadWasDeleted
      ? threads.find((thread) => thread.parentThreadId === null)?.id ?? null
      : this.snapshot.selectedThreadId;
    this.patch({
      threads,
      turnsByThread,
      latestTurnByThread,
      configurationsByThread,
      goalsByThread,
      userInputByThread,
      providerRetryByThread,
      planByThread,
      subagentExecutionsByAgentId,
      selectedThreadId: replacementThreadId,
    });
    if (selectedThreadWasDeleted && replacementThreadId) await this.loadTurns(replacementThreadId);
  }

  async send(
    contentInput: readonly ThreadUserContent[],
    userView?: RendererUserViewHints,
  ): Promise<Turn | null> {
    const threadId = this.snapshot.selectedThreadId;
    if (!threadId) return null;
    const content = normalizeUserContent(contentInput);
    if (content.length === 0) return null;
    // Contexts staged onto the composer (the command surface's page handoff)
    // ride along as UNTRUSTED additional context — the only kind a renderer may
    // author — and are cleared once the turn has taken them, so a later turn
    // does not silently re-send a page the user has moved on from.
    const additionalContext = pendingComposerAdditionalContext();
    const stagedKeys = Object.keys(additionalContext);
    const result = await this.sendToThread(threadId, content, userView, additionalContext);
    for (const key of stagedKeys) acknowledgeThreadComposerContext(key);
    return result;
  }

  /**
   * Submit user-authored work to a specific Thread without selecting it.
   *
   * Agent transcripts are embedded in their parent conversation, so selecting
   * the child would navigate the dock away from the user's conversation. A
   * deliberate message here still uses the ordinary renderer Turn boundary;
   * the host can therefore distinguish it from model-authored `agent_message`
   * traffic and clear user-stop provenance for this Agent only.
   */
  async sendToThread(
    threadId: ThreadId,
    contentInput: readonly ThreadUserContent[],
    userView?: RendererUserViewHints,
    additionalContext: Readonly<Record<string, { readonly value: string; readonly kind: 'untrusted' }>> = {},
  ): Promise<Turn | null> {
    const content = normalizeUserContent(contentInput);
    if (content.length === 0) return null;
    const withContext = Object.keys(additionalContext).length > 0 ? { additionalContext } : {};
    const response = await this.client.agentCoreRequest('turn/submit', {
      threadId,
      input: content,
      clientUserMessageId: crypto.randomUUID(),
      ...(userView ? { userView } : {}),
      ...withContext,
    });
    return response.turn;
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

  /**
   * Stop one delegated child, from the card or from its own Thread header.
   *
   * The Turn id comes from the retained latest-Turn cache when that child's
   * history is not loaded — which is the normal case for a card line. It is
   * still sent explicitly: the host refuses a Turn that is no longer the active
   * one, so a stale click can never stop newer work than the user was looking at.
   */
  async interruptThread(threadId: ThreadId): Promise<void> {
    const loaded = findLastInProgressTurn(this.turns(threadId));
    const latest = this.snapshot.latestTurnByThread.get(threadId);
    const active = loaded ?? (latest?.status === 'inProgress' ? latest : undefined);
    // Reported rather than swallowed: a Stop that resolves without issuing a
    // request looks identical to one that worked, which is the worst of the
    // three outcomes. The caller surfaces this.
    if (!active) throw new Error(`No active Turn to interrupt: ${threadId}`);
    await this.client.agentCoreRequest('turn/interrupt', { threadId, turnId: active.id });
  }

  async continueInNewChat(threadId: ThreadId, turnId: string): Promise<Thread> {
    let response: ThreadForkResponse;
    try {
      response = await this.client.agentCoreRequest('thread/fork', {
        threadId,
        boundary: { kind: 'afterTurn', turnId },
      });
    } catch (error) {
      await this.reloadThreads();
      throw error;
    }
    this.patch({ threads: sortThreads(upsertById(this.snapshot.threads, response.thread)) });
    await this.selectThread(response.thread.id);
    return response.thread;
  }

  async rollbackAndSend(
    threadId: ThreadId,
    contentInput: readonly ThreadUserContent[],
    userView?: RendererUserViewHints,
  ): Promise<void> {
    const content = normalizeUserContent(contentInput);
    if (content.length === 0) return;
    const response = await this.client.agentCoreRequest('thread/rollback', { threadId, numTurns: 1 });
    this.loadGenerations.set(threadId, (this.loadGenerations.get(threadId) ?? 0) + 1);
    this.historyRevisions.set(threadId, (this.historyRevisions.get(threadId) ?? 0) + 1);
    const turnsByThread = new Map(this.snapshot.turnsByThread);
    turnsByThread.set(threadId, (turnsByThread.get(threadId) ?? []).slice(0, -1));
    const latestTurnByThread = new Map(this.snapshot.latestTurnByThread);
    const latestRemaining = turnsByThread.get(threadId)?.at(-1);
    if (latestRemaining) latestTurnByThread.set(threadId, latestRemaining);
    else latestTurnByThread.delete(threadId);
    this.patch({
      threads: sortThreads(upsertById(this.snapshot.threads, response.thread)),
      turnsByThread,
      latestTurnByThread,
    });
    await this.client.agentCoreRequest('turn/submit', {
      threadId,
      input: content,
      clientUserMessageId: crypto.randomUUID(),
      ...(userView ? { userView } : {}),
    });
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
    if (item.type === 'collabAgentToolCall') return Promise.resolve(null);
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

  readToolArguments(threadId: ThreadId, turnId: string, item: ThreadItem): Promise<JsonValue | null> {
    if (!('modelCall' in item)) return Promise.resolve(null);
    if (item.modelCall.disposition === 'evidenceOnly') {
      return Promise.resolve(item.modelCall.redactedArgumentsSummary);
    }
    const source = modelCallArgumentSource(item.modelCall);
    if (source.storage === 'inline') return Promise.resolve(source.value);
    const key = `${threadId}:${source.ref.id}`;
    let pending = this.toolArgumentsCache.get(key);
    if (!pending) {
      pending = this.client.agentCoreRequest('thread/context/read', {
        threadId,
        turnId,
        itemId: item.id,
        contextId: source.ref.id,
      }).then((response) => {
        const context = response.context;
        return context?.ref.id === source.ref.id && context.payload.kind === 'toolCallArguments'
          ? boundedToolArgumentsForDisplay(context.payload.value)
          : null;
      }).catch(() => {
        this.toolArgumentsCache.delete(key);
        return null;
      });
      this.toolArgumentsCache.set(key, pending);
      while (this.toolArgumentsCache.size > MAX_CACHED_TOOL_OUTPUTS) {
        const oldestKey = this.toolArgumentsCache.keys().next().value;
        if (oldestKey === undefined) break;
        this.toolArgumentsCache.delete(oldestKey);
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
    const latestTurnByThread = new Map(this.snapshot.latestTurnByThread);
    const loadedLatest = turns.at(-1);
    if (loadedLatest) {
      latestTurnByThread.set(
        threadId,
        newerTurn(latestTurnByThread.get(threadId), loadedLatest),
      );
    }
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
      latestTurnByThread,
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
      || notification.type === 'items/completed'
      || notification.type === 'item/delta'
    );
    const historyLoaded = historyNotification
      && this.snapshot.turnsByThread.has(notification.threadId);
    if (historyLoaded) {
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
      case 'thread/name/updated':
        this.updateThread(notification.threadId, (thread) => ({
          ...thread,
          name: notification.threadName ?? null,
        }));
        return;
      case 'thread/status/changed':
        this.updateThread(notification.threadId, (thread) => ({ ...thread, status: notification.status }));
        return;
      case 'turn/started': {
        const planByThread = new Map(this.snapshot.planByThread);
        // A new Turn means the previous Turn's reconnect banner is stale; it
        // would otherwise keep spinning over work that has already moved on.
        const providerRetryByThread = new Map(this.snapshot.providerRetryByThread);
        providerRetryByThread.delete(notification.threadId);
        const latestTurnByThread = new Map(this.snapshot.latestTurnByThread);
        latestTurnByThread.set(notification.threadId, notification.turn);
        planByThread.delete(notification.threadId);
        const preview = threadPreviewFromTurn(notification.turn);
        this.updateThread(notification.threadId, (thread) => ({
          ...thread,
          preview: thread.preview.trim() ? thread.preview : preview,
          updatedAt: Math.max(thread.updatedAt, notification.turn.startedAt),
        }));
        if (historyLoaded) {
          this.updateTurn(notification.threadId, notification.turn, {
            latestTurnByThread,
            planByThread,
            providerRetryByThread,
          });
        } else this.patch({ latestTurnByThread, planByThread, providerRetryByThread });
        return;
      }
      case 'turn/completed': {
        const providerRetryByThread = new Map(this.snapshot.providerRetryByThread);
        const planByThread = new Map(this.snapshot.planByThread);
        const latestTurnByThread = new Map(this.snapshot.latestTurnByThread);
        latestTurnByThread.set(notification.threadId, notification.turn);
        if (providerRetryByThread.get(notification.threadId)?.turnId === notification.turnId) {
          providerRetryByThread.delete(notification.threadId);
        }
        if (planByThread.get(notification.threadId)?.turnId === notification.turnId) {
          planByThread.delete(notification.threadId);
        }
        this.updateThread(notification.threadId, (thread) => ({
          ...thread,
          updatedAt: Math.max(thread.updatedAt, notification.turn.completedAt ?? notification.turn.startedAt),
        }));
        if (historyLoaded) this.updateTurn(notification.threadId, notification.turn, {
          planByThread,
          providerRetryByThread,
          latestTurnByThread,
        });
        else this.patch({ latestTurnByThread, planByThread, providerRetryByThread });
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
      case 'turn/plan/updated': {
        const planByThread = new Map(this.snapshot.planByThread);
        planByThread.set(notification.threadId, {
          turnId: notification.turnId,
          ...(notification.explanation === undefined ? {} : { explanation: notification.explanation }),
          plan: notification.plan,
        });
        this.patch({ planByThread });
        return;
      }
      case 'item/started':
      case 'item/completed':
        if (!historyLoaded) return;
        this.updateItem(notification.threadId, notification.turnId, notification.item);
        return;
      case 'items/completed':
        if (!historyLoaded) return;
        this.updateTurnItems(notification.threadId, notification.turnId, (currentItems) => (
          notification.items.reduce<readonly ThreadItem[]>(
            (items, item) => upsertById(items, item),
            currentItems,
          )
        ));
        return;
      case 'item/delta':
        if (!historyLoaded) return;
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
      case 'subagent/execution/changed': {
        const current = this.snapshot.subagentExecutionsByAgentId.get(notification.execution.agentId);
        // Field-equal records keep their identity so the registry — and every
        // memoized row projected from it — sees no change at all.
        if (current && subagentExecutionEqual(current, notification.execution)) return;
        const subagentExecutionsByAgentId = new Map(this.snapshot.subagentExecutionsByAgentId);
        subagentExecutionsByAgentId.set(notification.execution.agentId, notification.execution);
        this.patch({ subagentExecutionsByAgentId });
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
    )), 'frame');
  }

  private updateTurnItems(
    threadId: ThreadId,
    turnId: string,
    update: (items: readonly ThreadItem[]) => readonly ThreadItem[],
    delivery: ThreadStoreListenerDelivery = 'immediate',
  ): void {
    const turnsByThread = new Map(this.snapshot.turnsByThread);
    turnsByThread.set(threadId, (turnsByThread.get(threadId) ?? []).map((turn) => (
      turn.id === turnId ? { ...turn, items: update(turn.items) } : turn
    )));
    this.patch({ turnsByThread }, delivery);
  }

  private patch(
    patch: Partial<ThreadStoreSnapshot>,
    delivery: ThreadStoreListenerDelivery = 'immediate',
  ): void {
    this.snapshot = { ...this.snapshot, ...patch };
    if (delivery === 'immediate') {
      this.listenerFlushScheduled = false;
      this.listenerFlushGeneration += 1;
      for (const listener of this.listeners) listener();
      return;
    }
    if (this.listeners.size === 0 || this.listenerFlushScheduled) return;
    this.listenerFlushScheduled = true;
    const generation = this.listenerFlushGeneration;
    this.scheduleListenerFlush(() => {
      if (!this.listenerFlushScheduled || generation !== this.listenerFlushGeneration) return;
      this.listenerFlushScheduled = false;
      for (const listener of this.listeners) listener();
    });
  }
}

export const threadStore = new ThreadStore();

export function useThreadStore(): ThreadStoreSnapshot {
  return useSyncExternalStore(threadStore.subscribe, threadStore.getSnapshot, threadStore.getSnapshot);
}

function scheduleOnNextFrame(flush: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => flush());
    return;
  }
  setTimeout(flush, LISTENER_FALLBACK_DELAY_MS);
}

function threadPreviewFromTurn(turn: Turn): string {
  const content = turn.items
    .filter((item) => item.type === 'userMessage')
    .flatMap((item) => item.content);
  return threadPreviewFromContent(content);
}

function normalizeUserContent(content: readonly ThreadUserContent[]): ThreadUserContent[] {
  const firstTextIndex = content.findIndex((part) => part.type === 'text');
  let lastTextIndex = -1;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    if (content[index]?.type === 'text') {
      lastTextIndex = index;
      break;
    }
  }
  return content.flatMap((part, index): ThreadUserContent[] => {
    if (part.type !== 'text') return [part];
    const text = index === firstTextIndex && index === lastTextIndex
      ? part.text.trim()
      : index === firstTextIndex
        ? part.text.trimStart()
        : index === lastTextIndex
          ? part.text.trimEnd()
          : part.text;
    return text ? [{ ...part, text }] : [];
  });
}

function upsertById<T extends { readonly id: string }>(values: readonly T[], value: T): T[] {
  const index = values.findIndex((candidate) => candidate.id === value.id);
  if (index < 0) return [...values, value];
  const next = [...values];
  next[index] = value;
  return next;
}

function filterMapKeys<Key, Value>(
  values: ReadonlyMap<Key, Value>,
  keys: ReadonlySet<Key>,
): Map<Key, Value> {
  return new Map([...values].filter(([key]) => keys.has(key)));
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

/** Drops the retry entries that were present before a reload started, keeping
 *  any that arrived while it was in flight. */
function retriesOutliving<K, V>(stale: ReadonlyMap<K, V>, current: ReadonlyMap<K, V>): Map<K, V> {
  const next = new Map(current);
  for (const [key, value] of stale) {
    if (next.get(key) === value) next.delete(key);
  }
  return next;
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

function newerTurn(current: Turn | undefined, candidate: Turn): Turn {
  if (!current) return candidate;
  if (current.id === candidate.id) return mergeLoadedTurn(candidate, current);
  return candidate.startedAt > current.startedAt
    || (candidate.startedAt === current.startedAt && candidate.id > current.id)
    ? candidate
    : current;
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

function subagentExecutionEqual(
  left: SubagentExecutionProjection,
  right: SubagentExecutionProjection,
): boolean {
  return left.agentId === right.agentId
    && left.parentThreadId === right.parentThreadId
    && left.description === right.description
    && left.agentType === right.agentType
    && left.runMode === right.runMode
    && left.generation === right.generation
    && left.currentTurnId === right.currentTurnId
    && left.stopProvenance === right.stopProvenance
    && left.notificationState === right.notificationState
    && left.worktree?.branch === right.worktree?.branch
    && left.worktree?.path === right.worktree?.path
    && left.createdAt === right.createdAt;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
