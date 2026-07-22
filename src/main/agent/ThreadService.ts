import { join } from 'node:path';
import {
  createHostRootTurnAdmissionBarrierSnapshot,
  createThreadAdmissionBarrierSnapshot,
  type HostRootTurnAdmissionBarrierSnapshot,
  type ThreadAdmissionBarrierSnapshot,
  type ThreadServiceExtensionHost,
} from '../../core/agent/extensions';
import {
  decodeAgentCoreRequest,
  decodePrivilegedTurnStartRequest,
  decodeThread,
  decodeThreadItem,
  decodeTurn,
} from '../../core/agent/codec';
import {
  MODEL_TOOL_CATALOG,
  canonicalModelToolKey,
} from '../../core/agent/tools';
import type { EffectiveThreadConfiguration } from '../../core/agent/configuration';
import type {
  AgentCoreMethod,
  AgentCoreNotification,
  AgentCoreRequestByMethod,
  AgentCoreResponseByMethod,
  AdditionalContext,
  EmptyAgentCoreResponse,
  PrivilegedTurnStartRequest,
  RendererTurnStartRequest,
  Thread,
  ThreadForkRequest,
  ThreadId,
  ThreadItem,
  ThreadListRequest,
  ThreadListResponse,
  ThreadReadRequest,
  ThreadReadResponse,
  ThreadStartRequest,
  ThreadStartResponse,
  ThreadStatus,
  ThreadUserContent,
  Turn,
  TurnInputRequest,
  TurnStartResponse,
  TurnSteerRequest,
  TurnSteerResponse,
} from '../../core/agent/protocol';
import { ExtensionRegistry } from './ExtensionRegistry';
import { GoalExtension } from './extensions/goal/GoalExtension';
import { GoalStore } from './extensions/goal/GoalStore';
import { KeyedMutex, Mutex } from './Mutex';
import { RolloutStore } from './persistence/RolloutStore';
import { ThreadHistoryProjectionStore } from './persistence/ThreadHistoryProjectionStore';
import {
  ThreadMetadataStore,
  type ThreadCatalogRecord,
} from './persistence/ThreadMetadataStore';
import { ItemRecorder } from './runtime/ItemRecorder';
import type {
  SteeredTurnInput,
  TurnExecutionResult,
  TurnExecutor,
} from './runtime/types';
import { uuidV7 } from './uuid';

export interface AgentCorePaths {
  readonly root: string;
  readonly rollouts: string;
  readonly state: string;
  readonly history: string;
  readonly goals: string;
}

export interface ThreadServiceStores {
  readonly metadata: ThreadMetadataStore;
  readonly history: ThreadHistoryProjectionStore;
  readonly rollout: RolloutStore;
  readonly goals: GoalStore;
}

export interface ThreadServiceOptions {
  readonly stores: ThreadServiceStores;
  readonly executor: TurnExecutor;
  readonly extensions?: ExtensionRegistry;
  readonly resolveConfiguration?: (request: ThreadStartRequest) => EffectiveThreadConfiguration;
  readonly now?: () => number;
}

export interface SpawnChildThreadInput {
  readonly parentThreadId: ThreadId;
  readonly parentItemId: string;
  readonly prompt: string;
  readonly taskPath: string;
  readonly role?: string;
  readonly nickname?: string;
  readonly model?: string;
  readonly reasoningEffort?: EffectiveThreadConfiguration['reasoningEffort'];
}

export interface SpawnChildThreadResult {
  readonly thread: Thread;
  readonly turn: Turn;
  readonly taskPath: string;
}

interface EphemeralThreadState {
  record: ThreadCatalogRecord;
  turns: Turn[];
}

interface ActiveTurn {
  readonly threadId: ThreadId;
  readonly turnId: string;
  readonly controller: AbortController;
  readonly recorder: ItemRecorder;
  readonly configuration: EffectiveThreadConfiguration;
  readonly additionalContext?: AdditionalContext;
  readonly startedAt: number;
  steeringHandler: ((input: SteeredTurnInput) => void | Promise<void>) | null;
  readonly queuedSteering: SteeredTurnInput[];
  readonly completion: Promise<void>;
  readonly resolveCompletion: () => void;
}

interface AcceptedTurn {
  readonly response: TurnStartResponse;
  readonly thread: Thread;
  readonly active: ActiveTurn | null;
}

type NotificationListener = (notification: AgentCoreNotification) => void;

export class ThreadService implements ThreadServiceExtensionHost {
  private readonly metadata: ThreadMetadataStore;
  private readonly history: ThreadHistoryProjectionStore;
  private readonly rollout: RolloutStore;
  private readonly executor: TurnExecutor;
  private readonly extensions: ExtensionRegistry;
  private readonly resolveConfiguration: (request: ThreadStartRequest) => EffectiveThreadConfiguration;
  private readonly now: () => number;
  private readonly goals: GoalExtension;
  private readonly goalStore: GoalStore;
  private readonly ephemeral = new Map<ThreadId, EphemeralThreadState>();
  private readonly activeTurns = new Map<ThreadId, ActiveTurn>();
  private readonly listeners = new Set<NotificationListener>();
  private readonly threadMutex = new KeyedMutex();
  private readonly hostRootMutex = new Mutex();
  private readonly threadBarrierGenerations = new Map<ThreadId, number>();
  private hostBarrierGeneration = 0;
  private initialized = false;

  constructor(options: ThreadServiceOptions) {
    this.metadata = options.stores.metadata;
    this.history = options.stores.history;
    this.rollout = options.stores.rollout;
    this.executor = options.executor;
    this.extensions = options.extensions ?? new ExtensionRegistry();
    this.resolveConfiguration = options.resolveConfiguration ?? defaultConfiguration;
    this.now = options.now ?? Date.now;
    this.goalStore = options.stores.goals;
    this.goals = new GoalExtension(this.goalStore, (notification) => this.recordNotification(notification));
    this.goals.bindHost(this, (threadId) => this.requireThread(threadId).thread);
    this.extensions.register(this.goals);
  }

  static open(userDataPath: string, executor: TurnExecutor): ThreadService {
    const paths = agentCorePaths(userDataPath);
    return new ThreadService({
      executor,
      stores: {
        metadata: new ThreadMetadataStore(paths.state),
        history: new ThreadHistoryProjectionStore(paths.history),
        rollout: new RolloutStore(paths.rollouts),
        goals: new GoalStore(paths.goals),
      },
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      do {
        const page = this.metadata.list({ archived, cursor, limit: 100 });
        for (const thread of page.data) await this.reconcileThread(thread.id);
        cursor = page.nextCursor;
      } while (cursor);
    }
    this.initialized = true;
  }

  async close(): Promise<void> {
    const active = [...this.activeTurns.values()];
    for (const turn of active) turn.controller.abort();
    await Promise.all(active.map((turn) => turn.completion));
    await this.rollout.flush();
    this.metadata.close();
    this.history.close();
    this.goalStore.close();
  }

  subscribe(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async waitForIdle(threadId: ThreadId): Promise<void> {
    await this.activeTurns.get(threadId)?.completion;
  }

  async request<Method extends AgentCoreMethod>(
    method: Method,
    input: AgentCoreRequestByMethod[Method],
  ): Promise<AgentCoreResponseByMethod[Method]> {
    const decoded = decodeAgentCoreRequest(method, input);
    switch (method) {
      case 'thread/list':
        return this.listThreads(decoded as AgentCoreRequestByMethod['thread/list']) as AgentCoreResponseByMethod[Method];
      case 'thread/read':
        return this.readThread(decoded as AgentCoreRequestByMethod['thread/read']) as AgentCoreResponseByMethod[Method];
      case 'thread/start':
        return await this.startThread(decoded as AgentCoreRequestByMethod['thread/start']) as AgentCoreResponseByMethod[Method];
      case 'thread/resume':
        return await this.resumeThread((decoded as AgentCoreRequestByMethod['thread/resume']).threadId) as AgentCoreResponseByMethod[Method];
      case 'thread/fork':
        return await this.forkThread(decoded as AgentCoreRequestByMethod['thread/fork']) as AgentCoreResponseByMethod[Method];
      case 'thread/name/set': {
        const request = decoded as AgentCoreRequestByMethod['thread/name/set'];
        await this.setThreadName(request.threadId, request.name);
        return emptyResponse() as AgentCoreResponseByMethod[Method];
      }
      case 'thread/archive':
        await this.setThreadArchived((decoded as AgentCoreRequestByMethod['thread/archive']).threadId, true);
        return emptyResponse() as AgentCoreResponseByMethod[Method];
      case 'thread/unarchive':
        await this.setThreadArchived((decoded as AgentCoreRequestByMethod['thread/unarchive']).threadId, false);
        return emptyResponse() as AgentCoreResponseByMethod[Method];
      case 'thread/delete':
        await this.deleteThread((decoded as AgentCoreRequestByMethod['thread/delete']).threadId);
        return emptyResponse() as AgentCoreResponseByMethod[Method];
      case 'thread/turns/list':
        return this.history.listTurns(decoded as AgentCoreRequestByMethod['thread/turns/list']) as AgentCoreResponseByMethod[Method];
      case 'thread/items/list':
        return this.history.listItems(decoded as AgentCoreRequestByMethod['thread/items/list']) as AgentCoreResponseByMethod[Method];
      case 'turn/start':
        return await this.startRendererTurn(decoded as AgentCoreRequestByMethod['turn/start']) as AgentCoreResponseByMethod[Method];
      case 'turn/steer':
        return await this.steerTurn(decoded as AgentCoreRequestByMethod['turn/steer']) as AgentCoreResponseByMethod[Method];
      case 'turn/interrupt': {
        const request = decoded as AgentCoreRequestByMethod['turn/interrupt'];
        await this.interruptTurn(request.threadId, request.turnId);
        return { turnId: request.turnId } as AgentCoreResponseByMethod[Method];
      }
      case 'goal/get':
        return this.goals.get(decoded as AgentCoreRequestByMethod['goal/get']) as AgentCoreResponseByMethod[Method];
      case 'goal/create':
        return await this.goals.create(decoded as AgentCoreRequestByMethod['goal/create']) as AgentCoreResponseByMethod[Method];
      case 'goal/update':
        return await this.goals.update(decoded as AgentCoreRequestByMethod['goal/update']) as AgentCoreResponseByMethod[Method];
      case 'userInput/respond':
        throw new Error('No request_user_input call is waiting for a response');
    }
  }

  listThreads(request: ThreadListRequest = {}): ThreadListResponse {
    const persisted = this.metadata.list(request);
    if (request.cursor || request.archived === true) return persisted;
    const ephemeral = [...this.ephemeral.values()]
      .filter((state) => !state.record.archived)
      .map((state) => state.record.thread)
      .filter((thread) => !request.threadSources || request.threadSources.includes(thread.threadSource));
    if (ephemeral.length === 0) return persisted;
    const direction = request.sortDirection ?? 'desc';
    const limit = request.limit ?? 50;
    const data = [...persisted.data, ...ephemeral]
      .sort((left, right) => direction === 'desc'
        ? right.updatedAt - left.updatedAt || right.id.localeCompare(left.id)
        : left.updatedAt - right.updatedAt || left.id.localeCompare(right.id))
      .slice(0, limit);
    return { data, nextCursor: persisted.nextCursor };
  }

  readThread(request: ThreadReadRequest): ThreadReadResponse {
    const record = this.requireThread(request.threadId);
    if (!request.includeTurns) return { thread: record.thread };
    return { thread: decodeThread({ ...record.thread, turns: this.allTurns(request.threadId) }) };
  }

  async startThread(requestInput: AgentCoreRequestByMethod['thread/start']): Promise<ThreadStartResponse> {
    const request: ThreadStartRequest = {
      ...requestInput,
      source: requestInput.source ?? 'app',
      threadSource: requestInput.threadSource ?? 'user',
    };
    return this.hostRootMutex.run(async () => {
      const thread = await this.createThread(request, {
        sessionId: uuidV7(this.now()),
        parentThreadId: null,
        forkedFromId: null,
        agentRole: null,
        agentNickname: null,
      });
      return { thread };
    });
  }

  async resumeThread(threadId: ThreadId): Promise<{ thread: Thread }> {
    const thread = this.requireThread(threadId).thread;
    await this.extensions.threadResumed(thread);
    return { thread };
  }

  async forkThread(request: ThreadForkRequest): Promise<{ thread: Thread }> {
    return this.hostRootMutex.run(async () => this.threadMutex.run(request.threadId, async () => {
      const source = this.requireThread(request.threadId).thread;
      const turns = this.allTurns(source.id);
      const boundaryIndex = turns.findIndex((turn) => turn.id === request.boundary.turnId);
      if (boundaryIndex < 0) throw new Error(`Fork boundary Turn not found: ${request.boundary.turnId}`);
      const inherited = turns.slice(0, request.boundary.kind === 'afterTurn' ? boundaryIndex + 1 : boundaryIndex);
      if (inherited.some((turn) => turn.status === 'inProgress')) throw new Error('Cannot fork through an active Turn');
      const now = this.now();
      const thread = await this.createThread({
        name: request.name ?? source.name ?? undefined,
        ephemeral: source.ephemeral,
        source: 'app',
        threadSource: 'user',
        modelProvider: source.modelProvider,
        cwd: source.cwd,
      }, {
        sessionId: uuidV7(now),
        parentThreadId: null,
        forkedFromId: source.id,
        agentRole: null,
        agentNickname: null,
      });
      for (const inheritedTurn of inherited) {
        const copied = copyTurn(inheritedTurn, thread.id, now);
        await this.recordNotification({
          type: 'turn/completed',
          threadId: thread.id,
          turnId: copied.id,
          turn: copied,
        });
      }
      return { thread: this.requireThread(thread.id).thread };
    }));
  }

  async setThreadName(threadId: ThreadId, name: string | null): Promise<void> {
    await this.threadMutex.run(threadId, async () => {
      const state = this.ephemeral.get(threadId);
      const now = this.now();
      if (state) {
        state.record = { ...state.record, thread: decodeThread({ ...state.record.thread, name, updatedAt: now }) };
      } else {
        this.metadata.setName(threadId, name, now);
      }
    });
  }

  async setThreadArchived(threadId: ThreadId, archived: boolean): Promise<void> {
    await this.threadMutex.run(threadId, async () => {
      const state = this.ephemeral.get(threadId);
      const now = this.now();
      if (state) state.record = { ...state.record, archived, thread: decodeThread({ ...state.record.thread, updatedAt: now }) };
      else this.metadata.setArchived(threadId, archived, now);
    });
  }

  async deleteThread(threadId: ThreadId): Promise<void> {
    await this.threadMutex.run(threadId, async () => {
      if (this.activeTurns.has(threadId)) throw new Error('Cannot delete a Thread with an active Turn');
      const ephemeral = this.ephemeral.get(threadId);
      if (ephemeral) {
        await this.goals.clear(threadId);
        this.ephemeral.delete(threadId);
        await this.extensions.threadStopped(ephemeral.record.thread);
        return;
      }
      const record = this.metadata.require(threadId);
      const descendants = this.metadata.childEdges(threadId, true).map((edge) => edge.childThreadId);
      for (const descendantId of [...descendants].reverse()) {
        await this.goals.clear(descendantId);
        this.history.deleteThread(descendantId);
        await this.rollout.delete(descendantId);
      }
      await this.goals.clear(threadId);
      this.metadata.delete(threadId);
      this.history.deleteThread(threadId);
      await this.rollout.delete(threadId);
      await this.extensions.threadStopped(record.thread);
    });
  }

  async startRendererTurn(request: RendererTurnStartRequest): Promise<TurnStartResponse> {
    const privileged: PrivilegedTurnStartRequest = { ...request, trigger: { kind: 'user' } };
    return (await this.acceptAndLaunch(privileged)).response;
  }

  async startPrivilegedTurn(request: PrivilegedTurnStartRequest): Promise<TurnStartResponse> {
    return (await this.acceptAndLaunch(decodePrivilegedTurnStartRequest(request))).response;
  }

  async tryStartTurnIfIdle(request: PrivilegedTurnStartRequest): Promise<Turn | null> {
    try {
      const accepted = await this.acceptAndLaunch(decodePrivilegedTurnStartRequest(request), true);
      return accepted.response.turn;
    } catch (error) {
      if (error instanceof ThreadBusyError) return null;
      throw error;
    }
  }

  async steerTurn(request: TurnSteerRequest): Promise<TurnSteerResponse> {
    return this.threadMutex.run(request.threadId, async () => {
      const active = this.activeTurns.get(request.threadId);
      if (!active || active.turnId !== request.expectedTurnId) throw new ThreadBusyError('Expected Turn is not active');
      const existing = request.clientUserMessageId
        ? this.readClientBinding(request.threadId, request.clientUserMessageId)
        : null;
      if (existing) {
        return { turnId: existing.turnId, acceptedItemId: existing.itemId, deduplicated: true };
      }
      const item = userMessage(request.threadId, active.turnId, request.input, request.clientUserMessageId ?? null);
      await active.recorder.completedImmediately(item, this.now());
      if (request.clientUserMessageId) this.bindClientInput(request.threadId, request.clientUserMessageId, active.turnId, item.id);
      const steered = { content: request.input, additionalContext: request.additionalContext };
      if (active.steeringHandler) await active.steeringHandler(steered);
      else active.queuedSteering.push(steered);
      return { turnId: active.turnId, acceptedItemId: item.id, deduplicated: false };
    });
  }

  async interruptTurn(threadId: ThreadId, turnId: string): Promise<void> {
    await this.threadMutex.run(threadId, async () => {
      const active = this.activeTurns.get(threadId);
      if (!active || active.turnId !== turnId) throw new ThreadBusyError('Expected Turn is not active');
      active.controller.abort();
    });
  }

  async spawnChild(input: SpawnChildThreadInput): Promise<SpawnChildThreadResult> {
    const parent = this.requireThread(input.parentThreadId);
    const now = this.now();
    const parentConfiguration = parent.configuration;
    const configuration: EffectiveThreadConfiguration = Object.freeze({
      ...parentConfiguration,
      model: input.model ?? parentConfiguration.model,
      reasoningEffort: input.reasoningEffort ?? parentConfiguration.reasoningEffort,
      developerInstructions: [...parentConfiguration.developerInstructions],
      tools: [...parentConfiguration.tools],
      skills: [...parentConfiguration.skills],
      plugins: [...parentConfiguration.plugins],
      mcpServers: [...parentConfiguration.mcpServers],
    });
    const thread = await this.createThread({
      name: input.taskPath.split('/').at(-1) ?? 'Subagent',
      source: 'collaboration',
      threadSource: 'subagent',
      modelProvider: parent.thread.modelProvider,
      cwd: parent.thread.cwd,
    }, {
      sessionId: parent.thread.sessionId,
      parentThreadId: parent.thread.id,
      forkedFromId: null,
      agentRole: input.role ?? 'default',
      agentNickname: input.nickname ?? null,
      configuration,
      taskPath: input.taskPath,
    });
    const response = await this.startPrivilegedTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: input.prompt }],
      trigger: {
        kind: 'subagent',
        parentThreadId: parent.thread.id,
        parentItemId: input.parentItemId,
      },
    });
    return { thread, turn: response.turn, taskPath: input.taskPath };
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
      return operation(createHostRootTurnAdmissionBarrierSnapshot(this.hostBarrierGeneration));
    });
  }

  private async acceptAndLaunch(
    request: PrivilegedTurnStartRequest,
    onlyIfIdle = false,
  ): Promise<AcceptedTurn> {
    const record = this.requireThread(request.threadId);
    const accept = () => this.threadMutex.run(request.threadId, () => this.acceptTurn(request, onlyIfIdle));
    const accepted = record.thread.parentThreadId === null
      ? await this.hostRootMutex.run(accept)
      : await accept();
    if (accepted.active) {
      await this.extensions.turnStarted(accepted.thread, accepted.response.turn);
      void this.executeActiveTurn(accepted.active)
        .catch(() => undefined)
        .finally(accepted.active.resolveCompletion);
    }
    return accepted;
  }

  private async acceptTurn(
    request: PrivilegedTurnStartRequest,
    onlyIfIdle: boolean,
  ): Promise<AcceptedTurn> {
    const record = this.requireThread(request.threadId);
    const existing = request.clientUserMessageId
      ? this.readClientBinding(request.threadId, request.clientUserMessageId)
      : null;
    if (existing) {
      const turn = this.readTurn(request.threadId, existing.turnId);
      if (!turn) {
        if (!record.thread.ephemeral) this.metadata.deleteClientInput(request.threadId, request.clientUserMessageId!);
      } else {
        return {
          response: { turn, acceptedItemId: existing.itemId, deduplicated: true },
          thread: record.thread,
          active: null,
        };
      }
    }
    if (this.activeTurns.has(request.threadId)) throw new ThreadBusyError('Thread already has an active Turn');
    if (onlyIfIdle && record.thread.status.type !== 'idle') throw new ThreadBusyError('Thread is not idle');

    const startedAt = this.now();
    const turnId = request.turnId ?? uuidV7(startedAt);
    const item = userMessage(request.threadId, turnId, request.input, request.clientUserMessageId ?? null);
    const turn = decodeTurn({
      id: turnId,
      items: [item],
      itemsView: 'full',
      provenance: {
        originThreadId: request.threadId,
        originTurnId: turnId,
        trigger: request.trigger,
      },
      status: 'inProgress',
      error: null,
      startedAt,
      completedAt: null,
      durationMs: null,
    });
    const threadBarrier = createThreadAdmissionBarrierSnapshot(
      request.threadId,
      this.threadBarrierGenerations.get(request.threadId) ?? 0,
    );
    const hostBarrier = createHostRootTurnAdmissionBarrierSnapshot(this.hostBarrierGeneration);
    await this.extensions.contributeAdmission({
      thread: record.thread,
      turnId,
      provenance: turn.provenance,
      configuration: record.configuration,
      threadBarrier,
      hostBarrier,
    });

    await this.setStatus(request.threadId, { type: 'active', activeFlags: [] });
    await this.recordNotification({ type: 'turn/started', threadId: request.threadId, turnId, turn });
    const recorder = new ItemRecorder(
      request.threadId,
      turnId,
      [item],
      (notification) => this.recordNotification(notification),
    );
    await recorder.completeInitial(item.id, startedAt);
    if (request.clientUserMessageId) {
      this.bindClientInput(request.threadId, request.clientUserMessageId, turnId, item.id);
    }
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const active: ActiveTurn = {
      threadId: request.threadId,
      turnId,
      controller: new AbortController(),
      recorder,
      configuration: record.configuration,
      additionalContext: request.additionalContext,
      startedAt,
      steeringHandler: null,
      queuedSteering: [],
      completion,
      resolveCompletion,
    };
    this.activeTurns.set(request.threadId, active);
    return {
      response: { turn, acceptedItemId: item.id, deduplicated: false },
      thread: this.requireThread(request.threadId).thread,
      active,
    };
  }

  private async executeActiveTurn(active: ActiveTurn): Promise<void> {
    let result: TurnExecutionResult = {};
    let thrown: Error | null = null;
    const initialTurn = this.readTurn(active.threadId, active.turnId)!;
    const thread = this.requireThread(active.threadId).thread;
    try {
      const systemContext = (await this.extensions.threadContext(thread))
        .map((contribution) => Object.entries(contribution.additionalContext)
          .map(([key, entry]) => `${key}: ${entry.value}`)
          .join('\n'))
        .filter(Boolean);
      result = await this.executor.execute({
        thread,
        turn: initialTurn,
        historyBeforeTurn: this.allTurns(active.threadId).filter((turn) => turn.id !== active.turnId),
        configuration: active.configuration,
        additionalContext: active.additionalContext,
        systemContext,
        signal: active.controller.signal,
        recorder: active.recorder,
        onSteer: (handler) => {
          active.steeringHandler = handler;
          const queued = active.queuedSteering.splice(0);
          void queued.reduce(
            (chain, input) => chain.then(() => handler(input)),
            Promise.resolve(),
          );
        },
      });
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    }

    const aborted = active.controller.signal.aborted;
    const status = aborted ? 'interrupted' : thrown ? 'failed' : result.status ?? 'completed';
    await active.recorder.finishInProgressItems(status === 'completed' ? 'failed' : status);
    const completedAt = this.now();
    let turn = decodeTurn({
      id: active.turnId,
      items: active.recorder.orderedItems(),
      itemsView: 'full',
      provenance: initialTurn.provenance,
      status,
      error: thrown
        ? { message: thrown.message }
        : result.error ?? null,
      startedAt: active.startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - active.startedAt),
    });
    const contributions = await this.extensions.turnItems(thread, turn);
    for (const contribution of contributions) {
      await active.recorder.completedImmediately(contribution.item, completedAt);
    }
    turn = decodeTurn({ ...turn, items: active.recorder.orderedItems() });

    await this.threadMutex.run(active.threadId, async () => {
      if (this.activeTurns.get(active.threadId) !== active) return;
      await this.recordNotification({
        type: 'turn/completed',
        threadId: active.threadId,
        turnId: active.turnId,
        turn,
      });
      this.activeTurns.delete(active.threadId);
      await this.setStatus(active.threadId, { type: 'idle' });
    });
    await this.goals.addUsage(
      active.threadId,
      result.tokensUsed ?? 0,
      Math.ceil((turn.durationMs ?? 0) / 1000),
      active.turnId,
    );
    if (status === 'interrupted') await this.extensions.turnAborted(thread, turn);
    else if (thrown) await this.extensions.turnError(thread, turn, thrown);
    else await this.extensions.turnStopped(thread, turn);
    await this.extensions.threadIdle(this.requireThread(active.threadId).thread);
  }

  private async createThread(
    request: ThreadStartRequest,
    lineage: {
      sessionId: string;
      parentThreadId: ThreadId | null;
      forkedFromId: ThreadId | null;
      agentRole: string | null;
      agentNickname: string | null;
      configuration?: EffectiveThreadConfiguration;
      taskPath?: string;
    },
  ): Promise<Thread> {
    const now = this.now();
    const id = request.id ?? uuidV7(now);
    const thread = decodeThread({
      id,
      sessionId: lineage.sessionId,
      parentThreadId: lineage.parentThreadId,
      forkedFromId: lineage.forkedFromId,
      agentNickname: lineage.agentNickname,
      agentRole: lineage.agentRole,
      name: request.name ?? null,
      preview: '',
      ephemeral: request.ephemeral ?? false,
      source: request.source,
      threadSource: request.threadSource,
      modelProvider: request.modelProvider,
      cwd: request.cwd,
      createdAt: now,
      updatedAt: now,
      status: { type: 'idle' },
      historyMode: 'paginated',
    });
    const configuration = lineage.configuration ?? this.resolveConfiguration(request);
    const record = { thread, archived: false, configuration };
    if (thread.ephemeral) {
      this.ephemeral.set(thread.id, { record, turns: [] });
    } else if (thread.parentThreadId) {
      this.metadata.createChild(record, {
        parentThreadId: thread.parentThreadId,
        childThreadId: thread.id,
        taskPath: lineage.taskPath ?? `/root/${thread.id}`,
        createdAt: now,
      });
    } else {
      this.metadata.create(record);
    }
    await this.recordNotification({ type: 'thread/started', threadId: thread.id, thread });
    await this.extensions.threadStarted(thread);
    return thread;
  }

  private async setStatus(threadId: ThreadId, status: ThreadStatus): Promise<void> {
    const now = this.now();
    const state = this.ephemeral.get(threadId);
    if (state) {
      state.record = {
        ...state.record,
        thread: decodeThread({ ...state.record.thread, status, updatedAt: now }),
      };
    } else {
      this.metadata.setStatus(threadId, status, now);
    }
    await this.recordNotification({ type: 'thread/status/changed', threadId, status });
  }

  private async recordNotification(notification: AgentCoreNotification): Promise<void> {
    const record = this.requireThread(notification.threadId);
    if (record.thread.ephemeral) {
      this.applyEphemeralNotification(notification);
    } else {
      const entry = await this.rollout.append(notification.threadId, notification);
      this.history.apply(entry);
    }
    for (const listener of this.listeners) listener(notification);
    await this.extensions.notification(notification);
  }

  private applyEphemeralNotification(notification: AgentCoreNotification): void {
    const state = this.ephemeral.get(notification.threadId);
    if (!state) throw new Error(`Ephemeral Thread not found: ${notification.threadId}`);
    switch (notification.type) {
      case 'turn/started':
        state.turns.push(notification.turn);
        return;
      case 'item/started':
      case 'item/completed': {
        const index = state.turns.findIndex((turn) => turn.id === notification.turnId);
        if (index < 0) return;
        const turn = state.turns[index]!;
        const itemIndex = turn.items.findIndex((item) => item.id === notification.itemId);
        const items = [...turn.items];
        if (itemIndex < 0) items.push(notification.item);
        else items[itemIndex] = notification.item;
        state.turns[index] = decodeTurn({ ...turn, items });
        return;
      }
      case 'turn/completed': {
        const index = state.turns.findIndex((turn) => turn.id === notification.turnId);
        if (index < 0) state.turns.push(notification.turn);
        else state.turns[index] = notification.turn;
        return;
      }
      default:
        return;
    }
  }

  private requireThread(threadId: ThreadId): ThreadCatalogRecord {
    return this.ephemeral.get(threadId)?.record ?? this.metadata.require(threadId);
  }

  private allTurns(threadId: ThreadId): Turn[] {
    const ephemeral = this.ephemeral.get(threadId);
    if (ephemeral) return [...ephemeral.turns];
    const turns: Turn[] = [];
    let cursor: string | null = null;
    do {
      const page = this.history.listTurns({ threadId, cursor, limit: 100, itemsView: 'full' });
      turns.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return turns;
  }

  private readTurn(threadId: ThreadId, turnId: string): Turn | null {
    return this.ephemeral.get(threadId)?.turns.find((turn) => turn.id === turnId)
      ?? this.history.readTurn(threadId, turnId, 'full');
  }

  private readClientBinding(threadId: ThreadId, clientId: string): { turnId: string; itemId: string } | null {
    const ephemeral = this.ephemeral.get(threadId);
    if (ephemeral) {
      for (const turn of ephemeral.turns) {
        const item = turn.items.find((candidate) => candidate.type === 'userMessage' && candidate.clientId === clientId);
        if (item) return { turnId: turn.id, itemId: item.id };
      }
      return null;
    }
    return this.metadata.readClientInput(threadId, clientId);
  }

  private bindClientInput(threadId: ThreadId, clientId: string, turnId: string, itemId: string): void {
    if (this.ephemeral.has(threadId)) return;
    this.metadata.bindClientInput({ threadId, clientId, turnId, itemId, createdAt: this.now() });
  }

  private async reconcileThread(threadId: ThreadId): Promise<void> {
    const entries = await this.rollout.read(threadId);
    this.history.applyMany(entries.filter((entry) => entry.ordinal > this.history.watermark(threadId).ordinal));
    let cursor: string | null = null;
    do {
      const page = this.history.listItems({ threadId, cursor, limit: 100 });
      for (const entry of page.data) {
        if (entry.item.type === 'userMessage' && entry.item.clientId) {
          this.metadata.bindClientInput({
            threadId,
            clientId: entry.item.clientId,
            turnId: entry.turnId,
            itemId: entry.item.id,
            createdAt: this.requireThread(threadId).thread.createdAt,
          });
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    const latest = this.history.listTurns({ threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' }).data[0];
    if (latest?.status === 'inProgress') await this.finishCrashedTurn(threadId, latest);
    const record = this.metadata.require(threadId);
    if (record.thread.status.type === 'active') await this.setStatus(threadId, { type: 'idle' });
  }

  private async finishCrashedTurn(threadId: ThreadId, turn: Turn): Promise<void> {
    const completedAt = this.now();
    const items = turn.items.map((item) => {
      if (!('status' in item) || item.status !== 'inProgress') return item;
      return decodeThreadItem({ ...item, status: 'interrupted' });
    });
    for (const item of items) {
      const previous = turn.items.find((candidate) => candidate.id === item.id);
      if (previous && 'status' in previous && previous.status === 'inProgress') {
        await this.recordNotification({
          type: 'item/completed',
          threadId,
          turnId: turn.id,
          itemId: item.id,
          item,
          completedAt,
        });
      }
    }
    const interrupted = decodeTurn({
      ...turn,
      items,
      status: 'interrupted',
      error: { message: 'Turn interrupted by host restart', code: 'host_restart' },
      completedAt,
      durationMs: Math.max(0, completedAt - turn.startedAt),
    });
    await this.recordNotification({
      type: 'turn/completed',
      threadId,
      turnId: turn.id,
      turn: interrupted,
    });
  }

}

export class ThreadBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThreadBusyError';
  }
}

export function agentCorePaths(userDataPath: string): AgentCorePaths {
  const root = join(userDataPath, 'agent');
  return {
    root,
    rollouts: join(root, 'rollouts'),
    state: join(root, 'state.sqlite'),
    history: join(root, 'thread_history.sqlite'),
    goals: join(root, 'goals.sqlite'),
  };
}

function defaultConfiguration(request: ThreadStartRequest): EffectiveThreadConfiguration {
  return Object.freeze({
    profileName: request.configurationProfile ?? 'default',
    developerInstructions: Object.freeze([]),
    model: 'inherit',
    reasoningEffort: 'medium',
    tools: Object.freeze(MODEL_TOOL_CATALOG.map((tool) => canonicalModelToolKey(tool.identity))),
    skills: Object.freeze([]),
    plugins: Object.freeze([]),
    mcpServers: Object.freeze([]),
  });
}

function userMessage(
  threadId: ThreadId,
  turnId: string,
  content: readonly ThreadUserContent[],
  clientId: string | null,
): ThreadItem {
  const id = uuidV7();
  return decodeThreadItem({
    type: 'userMessage',
    id,
    provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: id },
    clientId,
    content,
  });
}

function copyTurn(source: Turn, targetThreadId: ThreadId, now: number): Turn {
  const id = uuidV7(now);
  return decodeTurn({
    ...source,
    id,
    items: source.items.map((item) => copyItem(item, targetThreadId, id, now)),
    itemsView: 'full',
  });
}

function copyItem(source: ThreadItem, _targetThreadId: ThreadId, _targetTurnId: string, now: number): ThreadItem {
  const id = uuidV7(now);
  return decodeThreadItem({
    ...source,
    id,
    ...(source.type === 'userMessage' ? { clientId: null } : {}),
  });
}

function emptyResponse(): EmptyAgentCoreResponse {
  return Object.freeze({});
}
