import { join } from 'node:path';
import {
  createHostRootTurnAdmissionBarrierSnapshot,
  createThreadAdmissionBarrierSnapshot,
  type HostRootTurnAdmissionBarrierSnapshot,
  type ThreadAdmissionBarrierSnapshot,
  type ThreadServiceExtensionHost,
  type ExtensionToolContribution,
} from '../../core/agent/extensions';
import {
  decodeAgentCoreNotification,
  decodeAgentCoreRequest,
  decodeAgentCoreResponse,
  decodePrivilegedTurnStartRequest,
  decodeThread,
  decodeThreadItem,
  decodeTurn,
} from '../../core/agent/codec';
import {
  normalizeRequestUserInputToolInput,
  normalizeUpdatePlanToolInput,
  type RequestUserInputToolInput,
  type UpdatePlanToolInput,
  type ModelToolIdentity,
} from '../../core/agent/tools';
import {
  resolveChildConfiguration,
  type AgentRole,
  type EffectiveThreadConfiguration,
} from '../../core/agent/configuration';
import type {
  CreateGoalResponse,
  GetGoalResponse,
  UpdateGoalResponse,
} from '../../core/agent/goal';
import type {
  AgentCoreMethod,
  AgentCoreNotification,
  AgentCoreRequestByMethod,
  AgentCoreResponseByMethod,
  AdditionalContext,
  EmptyAgentCoreResponse,
  PrivilegedTurnStartRequest,
  RequestUserInputRequest,
  RequestUserInputResponse,
  RendererTurnStartRequest,
  Thread,
  ThreadConfigurationResponse,
  ThreadConfigurationSetRequest,
  ThreadConfigurationSummary,
  ThreadForkRequest,
  ThreadId,
  ThreadItem,
  ThreadItemOutputReadRequest,
  ThreadItemOutputReadResponse,
  ThreadItemEntry,
  ThreadItemsListRequest,
  ThreadItemsListResponse,
  ThreadListRequest,
  ThreadListResponse,
  ThreadReadRequest,
  ThreadReadResponse,
  ThreadStartRequest,
  ThreadStartResponse,
  ThreadStatus,
  ThreadTurnsListRequest,
  ThreadTurnsListResponse,
  ThreadUserContent,
  JsonValue,
  Turn,
  TurnInputRequest,
  TurnStartResponse,
  TurnSteerRequest,
  TurnSteerResponse,
} from '../../core/agent/protocol';
import { threadPreviewFromContent } from '../../core/agent/threadPreview';
import { ExtensionRegistry } from './ExtensionRegistry';
import { GoalExtension } from './extensions/goal/GoalExtension';
import { GoalStore } from './extensions/goal/GoalStore';
import { KeyedMutex, Mutex } from './Mutex';
import { RolloutStore } from './persistence/RolloutStore';
import { ThreadHistoryProjectionStore } from './persistence/ThreadHistoryProjectionStore';
import {
  decodeThreadCursor,
  encodeThreadListCursor,
  threadFollowsCursor,
  ThreadMetadataStore,
  type ThreadCatalogRecord,
} from './persistence/ThreadMetadataStore';
import { ToolPayloadStore } from './persistence/ToolPayloadStore';
import { ItemRecorder } from './runtime/ItemRecorder';
import { decodeCursor, encodeCursor, pageLimit } from './persistence/cursor';
import type {
  SteeredTurnInput,
  TurnExecutionResult,
  TurnExecutor,
} from './runtime/types';
import { uuidV7 } from './uuid';
import {
  BUILT_IN_AGENT_ROLE_DEFINITIONS,
  defaultEffectiveThreadConfiguration,
} from './AgentConfigurationLoader';
import { applyThreadItemDelta } from './itemDelta';

export interface AgentCorePaths {
  readonly root: string;
  readonly rollouts: string;
  readonly state: string;
  readonly history: string;
  readonly goals: string;
  readonly payloads: string;
}

export interface ThreadServiceStores {
  readonly metadata: ThreadMetadataStore;
  readonly history: ThreadHistoryProjectionStore;
  readonly rollout: RolloutStore;
  readonly goals: GoalStore;
  readonly payloads: ToolPayloadStore;
}

export interface ThreadServiceOptions {
  readonly stores: ThreadServiceStores;
  readonly executor: TurnExecutor;
  readonly extensions?: ExtensionRegistry;
  readonly resolveConfiguration?: (
    request: ThreadStartRequest,
  ) => EffectiveThreadConfiguration | Promise<EffectiveThreadConfiguration>;
  readonly resolveRendererStartDefaults?: () =>
    | RendererThreadStartDefaults
    | Promise<RendererThreadStartDefaults>;
  readonly validateRendererConfiguration?: (
    configuration: ThreadConfigurationSummary,
  ) => void | Promise<void>;
  readonly resolveUserContent?: (
    content: readonly ThreadUserContent[],
    context: ThreadUserContentResolutionContext,
  ) => readonly ThreadUserContent[] | Promise<readonly ThreadUserContent[]>;
  readonly resolveRole?: (name: string, cwd: string) => AgentRole;
  readonly now?: () => number;
}

export interface RendererThreadStartDefaults {
  readonly modelProvider: string;
  readonly cwd: string;
}

export interface ThreadUserContentResolutionContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
}

export interface SpawnChildThreadInput {
  readonly parentThreadId: ThreadId;
  readonly parentTurnId: string;
  readonly parentItemId: string;
  readonly prompt: string;
  readonly taskPath: string;
  readonly role?: string;
  readonly nickname?: string;
  readonly model?: string;
  readonly reasoningEffort?: EffectiveThreadConfiguration['reasoningEffort'];
  /** Additional child-only ceiling. Values absent from the parent/role result are ignored. */
  readonly allowedTools?: readonly string[];
  readonly additionalContext?: AdditionalContext;
}

export interface SpawnChildThreadResult {
  readonly thread: Thread;
  readonly turn: Turn;
  readonly taskPath: string;
}

export interface SpawnIsolatedSkillThreadInput {
  readonly parentThreadId: ThreadId;
  readonly parentTurnId: string;
  readonly parentItemId: string;
  readonly skillName: string;
  readonly prompt: string;
  readonly allowedTools: readonly string[];
  readonly model?: string;
  readonly reasoningEffort?: EffectiveThreadConfiguration['reasoningEffort'];
  readonly readOnly: boolean;
}

export interface CollaborationAgentView {
  readonly taskPath: string;
  readonly threadId: ThreadId;
  readonly parentThreadId: ThreadId;
  readonly nickname: string | null;
  readonly role: string | null;
  readonly status: 'pendingInit' | 'running' | 'interrupted' | 'completed' | 'errored';
}

interface EphemeralThreadState {
  record: ThreadCatalogRecord;
  turns: Turn[];
  completedItemIds: Set<string>;
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

interface PendingUserInput {
  readonly request: RequestUserInputRequest;
  readonly resolve: (response: RequestUserInputResponse) => void;
  readonly reject: (error: Error) => void;
  readonly abort: () => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface PendingSubagentActivity {
  readonly agentThreadId: ThreadId;
  readonly agentPath: string;
  readonly kind: 'started' | 'completed' | 'interrupted' | 'errored';
}

interface CollaborationActivityState {
  pending: boolean;
  readonly waiters: Set<() => void>;
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
  private readonly payloads: ToolPayloadStore;
  private readonly executor: TurnExecutor;
  private readonly extensions: ExtensionRegistry;
  private readonly resolveConfiguration: (
    request: ThreadStartRequest,
  ) => EffectiveThreadConfiguration | Promise<EffectiveThreadConfiguration>;
  private readonly resolveRendererStartDefaults: () =>
    RendererThreadStartDefaults | Promise<RendererThreadStartDefaults>;
  private readonly validateRendererConfiguration: (
    configuration: ThreadConfigurationSummary,
  ) => void | Promise<void>;
  private readonly resolveUserContent: (
    content: readonly ThreadUserContent[],
    context: ThreadUserContentResolutionContext,
  ) => readonly ThreadUserContent[] | Promise<readonly ThreadUserContent[]>;
  private readonly resolveRole: (name: string, cwd: string) => AgentRole;
  private readonly now: () => number;
  private readonly goals: GoalExtension;
  private readonly goalStore: GoalStore;
  private readonly ephemeral = new Map<ThreadId, EphemeralThreadState>();
  private readonly activeTurns = new Map<ThreadId, ActiveTurn>();
  private readonly pendingUserInputs = new Map<ThreadId, PendingUserInput>();
  private readonly mailbox = new Map<ThreadId, SteeredTurnInput[]>();
  private readonly ephemeralSpawnEdges = new Map<ThreadId, {
    sessionId: string;
    parentThreadId: ThreadId;
    taskPath: string;
    createdAt: number;
  }>();
  private readonly pendingSubagentActivities = new Map<ThreadId, PendingSubagentActivity[]>();
  private readonly collaborationActivity = new Map<ThreadId, CollaborationActivityState>();
  private readonly stoppingThreads = new Set<ThreadId>();
  private readonly listeners = new Set<NotificationListener>();
  private readonly threadMutex = new KeyedMutex();
  private readonly hostRootMutex = new Mutex();
  private readonly threadTreeMutex = new Mutex();
  private readonly threadBarrierGenerations = new Map<ThreadId, number>();
  private hostBarrierGeneration = 0;
  private initialized = false;

  constructor(options: ThreadServiceOptions) {
    this.metadata = options.stores.metadata;
    this.history = options.stores.history;
    this.rollout = options.stores.rollout;
    this.payloads = options.stores.payloads;
    this.executor = options.executor;
    this.extensions = options.extensions ?? new ExtensionRegistry();
    this.resolveConfiguration = options.resolveConfiguration ?? defaultConfiguration;
    this.resolveRendererStartDefaults = options.resolveRendererStartDefaults ?? missingRendererStartDefaults;
    this.validateRendererConfiguration = options.validateRendererConfiguration ?? (() => undefined);
    this.resolveUserContent = options.resolveUserContent ?? ((content) => content);
    this.resolveRole = options.resolveRole ?? defaultAgentRole;
    this.now = options.now ?? Date.now;
    this.goalStore = options.stores.goals;
    this.goals = new GoalExtension(this.goalStore, (notification) => this.recordNotification(notification));
    this.goals.bindHost(this, (threadId) => this.requireThread(threadId).thread);
    this.extensions.register(this.goals);
  }

  static open(
    userDataPath: string,
    executor: TurnExecutor,
    options: Omit<ThreadServiceOptions, 'stores' | 'executor'> = {},
  ): ThreadService {
    const paths = agentCorePaths(userDataPath);
    return new ThreadService({
      executor,
      ...options,
      stores: {
        metadata: new ThreadMetadataStore(paths.state),
        history: new ThreadHistoryProjectionStore(paths.history),
        rollout: new RolloutStore(paths.rollouts),
        goals: new GoalStore(paths.goals),
        payloads: new ToolPayloadStore(paths.payloads),
      },
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const resumableThreadIds: ThreadId[] = [];
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      do {
        const page = this.metadata.list({ archived, cursor, limit: 100 });
        for (const thread of page.data) {
          await this.reconcileThread(thread.id);
          if (!archived) resumableThreadIds.push(thread.id);
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    const resumableThreads: Thread[] = [];
    for (const threadId of resumableThreadIds) {
      const { thread } = await this.resumeThread(threadId);
      resumableThreads.push(thread);
    }
    this.initialized = true;
    for (const thread of resumableThreads) {
      if (thread.status.type === 'idle') {
        await this.extensions.threadIdle(this.requireThread(thread.id).thread);
      }
    }
  }

  async close(): Promise<void> {
    const active = [...this.activeTurns.values()];
    for (const turn of active) turn.controller.abort();
    for (const pending of this.pendingUserInputs.values()) pending.abort();
    await Promise.all(active.map((turn) => turn.completion));
    await this.rollout.flush();
    await Promise.all([...this.ephemeral.keys()].map((threadId) => this.payloads.deleteThread(threadId)));
    this.metadata.close();
    this.history.close();
    this.goalStore.close();
  }

  subscribe(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async waitForIdle(threadId: ThreadId): Promise<void> {
    while (true) {
      const active = this.activeTurns.get(threadId);
      if (!active) return;
      await active.completion;
    }
  }

  async extensionToolContributions(threadId: ThreadId): Promise<readonly ExtensionToolContribution[]> {
    return this.extensions.tools(this.requireThread(threadId).thread);
  }

  async request<Method extends AgentCoreMethod>(
    method: Method,
    input: AgentCoreRequestByMethod[Method],
  ): Promise<AgentCoreResponseByMethod[Method]> {
    const decoded = decodeAgentCoreRequest(method, input);
    const response = await this.dispatchRequest(method, decoded);
    return decodeAgentCoreResponse(method, response);
  }

  private async dispatchRequest<Method extends AgentCoreMethod>(
    method: Method,
    decoded: AgentCoreRequestByMethod[Method],
  ): Promise<AgentCoreResponseByMethod[Method]> {
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
      case 'thread/configuration/get':
        return this.getThreadConfiguration(
          (decoded as AgentCoreRequestByMethod['thread/configuration/get']).threadId,
        ) as AgentCoreResponseByMethod[Method];
      case 'thread/configuration/set':
        return await this.setThreadConfiguration(
          decoded as AgentCoreRequestByMethod['thread/configuration/set'],
        ) as AgentCoreResponseByMethod[Method];
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
        return this.listTurns(decoded as AgentCoreRequestByMethod['thread/turns/list']) as AgentCoreResponseByMethod[Method];
      case 'thread/items/list':
        return this.listItems(decoded as AgentCoreRequestByMethod['thread/items/list']) as AgentCoreResponseByMethod[Method];
      case 'thread/item/output/read':
        return await this.readItemOutput(
          decoded as AgentCoreRequestByMethod['thread/item/output/read'],
        ) as AgentCoreResponseByMethod[Method];
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
        await this.respondUserInput(decoded as AgentCoreRequestByMethod['userInput/respond']);
        return emptyResponse() as AgentCoreResponseByMethod[Method];
    }
  }

  listTurns(request: ThreadTurnsListRequest): ThreadTurnsListResponse {
    const state = this.ephemeral.get(request.threadId);
    if (!state) return this.history.listTurns(request);
    const direction = request.sortDirection ?? 'asc';
    const selected = pageEphemeralTurns(state.turns, request, direction);
    return {
      data: selected.data.map((turn) => request.itemsView === 'notLoaded'
        ? decodeTurn({ ...turn, items: [], itemsView: 'notLoaded' })
        : turn),
      nextCursor: selected.nextCursor,
      backwardsCursor: selected.backwardsCursor,
    };
  }

  async readItemOutput(request: ThreadItemOutputReadRequest): Promise<ThreadItemOutputReadResponse> {
    const turn = this.readTurn(request.threadId, request.turnId);
    if (!turn) return { output: null };
    const item = turn.items.find((candidate) => candidate.id === request.itemId);
    if (!item || !('outputRef' in item) || !item.outputRef || item.outputRef.id !== request.outputId) {
      return { output: null };
    }
    const text = await this.payloads.readText(item.provenance.originThreadId, request.outputId);
    if (text === null || Buffer.byteLength(text, 'utf8') !== item.outputRef.byteLength) return { output: null };
    return { output: { ref: item.outputRef, text } };
  }

  listItems(request: ThreadItemsListRequest): ThreadItemsListResponse {
    const state = this.ephemeral.get(request.threadId);
    if (!state) return this.history.listItems(request);
    const entries = state.turns.flatMap((turn): ThreadItemEntry[] => (
      request.turnId && request.turnId !== turn.id
        ? []
        : turn.items.map((item) => ({ turnId: turn.id, item }))
    ));
    return pageEphemeralItems(entries, request);
  }

  listThreads(request: ThreadListRequest = {}): ThreadListResponse {
    const direction = request.sortDirection ?? 'desc';
    const limit = pageLimit(request.limit);
    const cursor = decodeThreadCursor(request.cursor, direction);
    const persisted = this.metadata.list({ ...request, limit });
    const ephemeral = request.archived === true ? [] : [...this.ephemeral.values()]
      .filter((state) => state.record.archived === (request.archived ?? false))
      .map((state) => state.record.thread)
      .filter((thread) => !request.threadSources || request.threadSources.includes(thread.threadSource))
      .filter((thread) => threadFollowsCursor(thread, cursor, direction));
    const candidates = [...persisted.data, ...ephemeral]
      .sort((left, right) => direction === 'desc'
        ? right.updatedAt - left.updatedAt || right.id.localeCompare(left.id)
        : left.updatedAt - right.updatedAt || left.id.localeCompare(right.id));
    const data = candidates.slice(0, limit);
    const hasNext = candidates.length > limit || persisted.nextCursor !== null;
    const last = data.at(-1);
    return {
      data,
      nextCursor: hasNext && last
        ? encodeThreadListCursor({ updatedAt: last.updatedAt, id: last.id }, direction)
        : null,
    };
  }

  readThread(request: ThreadReadRequest): ThreadReadResponse {
    const record = this.requireThread(request.threadId);
    if (!request.includeTurns) return { thread: record.thread };
    return { thread: decodeThread({ ...record.thread, turns: this.allTurns(request.threadId) }) };
  }

  getThreadConfiguration(threadId: ThreadId): ThreadConfigurationResponse {
    const record = this.requireRendererConfigurableThread(threadId);
    return {
      thread: record.thread,
      configuration: threadConfigurationSummary(record),
    };
  }

  async setThreadConfiguration(request: ThreadConfigurationSetRequest): Promise<ThreadConfigurationResponse> {
    return this.threadMutex.run(request.threadId, async () => {
      const record = this.requireRendererConfigurableThread(request.threadId);
      if (this.activeTurns.has(request.threadId)) {
        throw new ThreadBusyError('Cannot change Thread configuration during an active Turn');
      }
      const configuration: ThreadConfigurationSummary = {
        modelProvider: request.modelProvider,
        model: request.model,
        reasoningEffort: request.reasoningEffort,
      };
      await this.validateRendererConfiguration(configuration);
      const effectiveConfiguration: EffectiveThreadConfiguration = Object.freeze({
        ...record.configuration,
        model: configuration.model,
        reasoningEffort: configuration.reasoningEffort,
      });
      const now = this.now();
      const thread = decodeThread({
        ...record.thread,
        modelProvider: configuration.modelProvider,
        updatedAt: now,
      });
      const state = this.ephemeral.get(request.threadId);
      if (state) {
        state.record = { ...record, thread, configuration: effectiveConfiguration };
      } else {
        this.metadata.setRootConfiguration(
          request.threadId,
          configuration.modelProvider,
          effectiveConfiguration,
          now,
        );
      }
      return { thread, configuration };
    });
  }

  async startThread(requestInput: AgentCoreRequestByMethod['thread/start']): Promise<ThreadStartResponse> {
    const defaults = requestInput.modelProvider && requestInput.cwd
      ? null
      : await this.resolveRendererStartDefaults();
    const request: ThreadStartRequest = {
      ...requestInput,
      source: requestInput.source ?? 'app',
      threadSource: requestInput.threadSource ?? 'user',
      modelProvider: requestInput.modelProvider ?? defaults?.modelProvider ?? '',
      cwd: requestInput.cwd ?? defaults?.cwd ?? '',
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
    return this.threadMutex.run(threadId, async () => {
      const record = this.requireThread(threadId);
      if (record.thread.parentThreadId && record.thread.agentRole) {
        const parent = this.requireThread(record.thread.parentThreadId);
        const role = this.resolveRole(record.thread.agentRole, record.thread.cwd);
        const resolved = resolveChildConfiguration(parent.configuration, {
          role,
          ...(record.modelOverride === null ? {} : { model: record.modelOverride }),
          ...(record.reasoningEffortOverride === null
            ? {}
            : { reasoningEffort: record.reasoningEffortOverride }),
        });
        const configuration = applyToolCeiling(resolved, record.toolCeiling);
        if (record.thread.ephemeral) {
          const state = this.ephemeral.get(threadId)!;
          state.record = { ...record, configuration };
        } else {
          this.metadata.setConfiguration(threadId, configuration);
        }
      }
      const thread = this.requireThread(threadId).thread;
      await this.extensions.threadResumed(thread);
      return { thread };
    });
  }

  async forkThread(request: ThreadForkRequest): Promise<{ thread: Thread }> {
    return this.hostRootMutex.run(async () => this.threadMutex.run(request.threadId, async () => {
      const sourceRecord = this.requireThread(request.threadId);
      const source = sourceRecord.thread;
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
        configuration: sourceRecord.configuration,
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
    if (!archived) {
      await this.threadMutex.run(threadId, async () => this.updateThreadArchived(threadId, false));
      return;
    }
    const subtree = await this.beginThreadSubtreeStop(threadId);
    try {
      await this.stopThreadSubtree(subtree.threadIds);
      await this.threadTreeMutex.run(async () => {
        for (const descendantId of subtree.threadIds) this.updateThreadArchived(descendantId, true);
        this.clearThreadCoordinationState(subtree.threadIds);
      });
      for (const record of [...subtree.records].reverse()) {
        await this.extensions.threadStopped(record.thread);
      }
    } finally {
      this.finishThreadSubtreeStop(subtree.threadIds);
    }
  }

  async deleteThread(threadId: ThreadId): Promise<void> {
    const subtree = await this.beginThreadSubtreeStop(threadId);
    try {
      await this.stopThreadSubtree(subtree.threadIds);
      for (const descendantId of [...subtree.threadIds].reverse()) {
        await this.goals.clear(descendantId);
        this.history.deleteThread(descendantId);
        await this.rollout.delete(descendantId);
        await this.payloads.deleteThread(descendantId);
      }
      for (const record of [...subtree.records].reverse()) {
        await this.extensions.threadStopped(record.thread);
      }
      await this.threadTreeMutex.run(async () => {
        if (subtree.records[0]?.thread.ephemeral) {
          for (const descendantId of [...subtree.threadIds].reverse()) {
            this.ephemeralSpawnEdges.delete(descendantId);
            this.ephemeral.delete(descendantId);
          }
        } else {
          this.metadata.delete(threadId);
        }
        this.clearThreadCoordinationState(subtree.threadIds);
      });
    } finally {
      this.finishThreadSubtreeStop(subtree.threadIds);
    }
  }

  private async beginThreadSubtreeStop(threadId: ThreadId): Promise<{
    readonly threadIds: readonly ThreadId[];
    readonly records: readonly ThreadCatalogRecord[];
  }> {
    return this.threadTreeMutex.run(async () => {
      const threadIds = this.threadSubtreeIds(threadId);
      if (threadIds.some((id) => this.stoppingThreads.has(id))) {
        throw new ThreadBusyError('Thread subtree is already stopping');
      }
      const records = threadIds.map((id) => this.requireThread(id));
      for (const id of threadIds) this.stoppingThreads.add(id);
      return { threadIds, records };
    });
  }

  private async stopThreadSubtree(threadIds: readonly ThreadId[]): Promise<void> {
    for (const id of threadIds) {
      await this.threadMutex.run(id, async () => {
        this.activeTurns.get(id)?.controller.abort();
        this.pendingUserInputs.get(id)?.abort();
      });
    }
    await Promise.all(threadIds.map((id) => this.waitForIdle(id)));
  }

  private finishThreadSubtreeStop(threadIds: readonly ThreadId[]): void {
    for (const id of threadIds) this.stoppingThreads.delete(id);
  }

  private threadSubtreeIds(threadId: ThreadId): ThreadId[] {
    const root = this.requireThread(threadId).thread;
    if (!root.ephemeral) {
      return [threadId, ...this.metadata.childEdges(threadId, true).map((edge) => edge.childThreadId)];
    }
    const ids = [threadId];
    for (let index = 0; index < ids.length; index += 1) {
      const parentId = ids[index]!;
      for (const [childId, edge] of this.ephemeralSpawnEdges) {
        if (edge.parentThreadId === parentId) ids.push(childId);
      }
    }
    return ids;
  }

  private updateThreadArchived(threadId: ThreadId, archived: boolean): void {
    const state = this.ephemeral.get(threadId);
    const now = this.now();
    if (state) {
      state.record = {
        ...state.record,
        archived,
        thread: decodeThread({ ...state.record.thread, updatedAt: now }),
      };
    } else {
      this.metadata.setArchived(threadId, archived, now);
    }
  }

  private clearThreadCoordinationState(threadIds: readonly ThreadId[]): void {
    for (const id of threadIds) {
      this.mailbox.delete(id);
      this.pendingSubagentActivities.delete(id);
      this.collaborationActivity.delete(id);
      this.threadBarrierGenerations.delete(id);
    }
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
      const thread = this.requireThread(request.threadId).thread;
      const input = await this.resolveUserContent(request.input, {
        threadId: thread.id,
        cwd: thread.cwd,
      });
      const item = userMessage(request.threadId, active.turnId, input, request.clientUserMessageId ?? null);
      await active.recorder.completedImmediately(item, this.now());
      if (request.clientUserMessageId) this.bindClientInput(request.threadId, request.clientUserMessageId, active.turnId, item.id);
      const steered = { content: input, additionalContext: request.additionalContext };
      if (active.steeringHandler) await active.steeringHandler(steered);
      else active.queuedSteering.push(steered);
      this.signalCollaborationActivity(request.threadId);
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

  async requestUserInput(
    threadId: ThreadId,
    turnId: string,
    itemId: string,
    inputValue: unknown,
    signal?: AbortSignal,
  ): Promise<RequestUserInputResponse> {
    const input = normalizeRequestUserInputToolInput(inputValue);
    const active = this.requireActiveTurn(threadId, turnId);
    if (this.requireThread(threadId).thread.parentThreadId !== null) {
      throw new Error('request_user_input is available only in a root Thread');
    }
    if (this.pendingUserInputs.has(threadId)) {
      throw new Error('This Thread already has a pending request_user_input call');
    }
    const request: RequestUserInputRequest = {
      threadId,
      turnId,
      itemId,
      questions: input.questions,
      ...(input.autoResolutionMs === undefined ? {} : { autoResolutionMs: input.autoResolutionMs }),
    };
    let resolve!: (response: RequestUserInputResponse) => void;
    let reject!: (error: Error) => void;
    const response = new Promise<RequestUserInputResponse>((resolveValue, rejectValue) => {
      resolve = resolveValue;
      reject = rejectValue;
    });
    const abort = () => {
      void this.rejectUserInput(threadId, new Error('request_user_input was interrupted'));
    };
    const pending: PendingUserInput = { request, resolve, reject, abort, timer: null };
    this.pendingUserInputs.set(threadId, pending);
    active.controller.signal.addEventListener('abort', abort, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await this.setStatus(threadId, { type: 'active', activeFlags: ['waitingOnUserInput'] });
      await this.recordNotification({ type: 'userInput/requested', threadId, turnId, itemId, request });
      if (input.autoResolutionMs !== undefined) {
        pending.timer = setTimeout(() => {
          const autoResponse: RequestUserInputResponse = {
            threadId,
            turnId,
            itemId,
            answers: input.questions.map((question) => ({
              questionId: question.id,
              otherText: 'No response before timeout; continue with best judgment.',
            })),
            autoResolved: true,
          };
          void this.resolveUserInput(autoResponse);
        }, input.autoResolutionMs);
      }
    } catch (error) {
      this.pendingUserInputs.delete(threadId);
      active.controller.signal.removeEventListener('abort', abort);
      signal?.removeEventListener('abort', abort);
      throw error;
    }
    return response.finally(() => {
      active.controller.signal.removeEventListener('abort', abort);
      signal?.removeEventListener('abort', abort);
    });
  }

  async respondUserInput(response: RequestUserInputResponse): Promise<void> {
    if (response.autoResolved) throw new Error('Only the host may auto-resolve request_user_input');
    await this.resolveUserInput(response);
  }

  async recordPlan(threadId: ThreadId, turnId: string, inputValue: unknown): Promise<{ text: string }> {
    const input = normalizeUpdatePlanToolInput(inputValue);
    const active = this.requireActiveTurn(threadId, turnId);
    const id = active.recorder.createItemId();
    const text = formatPlan(input);
    await active.recorder.completedImmediately({
      type: 'plan',
      id,
      provenance: active.recorder.localProvenance(id),
      text,
    }, this.now());
    return { text };
  }

  getGoalForTurn(threadId: ThreadId, turnId: string): GetGoalResponse {
    this.requireActiveTurn(threadId, turnId);
    return this.goals.get({ threadId });
  }

  async createGoalForTurn(
    threadId: ThreadId,
    turnId: string,
    objective: string,
    tokenBudget?: number,
  ): Promise<CreateGoalResponse> {
    this.requireActiveTurn(threadId, turnId);
    return this.goals.create({ threadId, objective, ...(tokenBudget === undefined ? {} : { tokenBudget }) }, turnId);
  }

  async updateGoalForTurn(
    threadId: ThreadId,
    turnId: string,
    status: 'blocked' | 'complete',
  ): Promise<UpdateGoalResponse> {
    this.requireActiveTurn(threadId, turnId);
    return this.goals.update({ threadId, status }, turnId);
  }

  async notifyToolStarted(
    threadId: ThreadId,
    turnId: string,
    itemId: string,
    identity: ModelToolIdentity,
    args: JsonValue,
  ): Promise<void> {
    this.requireActiveTurn(threadId, turnId);
    await this.extensions.toolStarted({ threadId, turnId, itemId, identity, arguments: args });
  }

  async notifyToolCompleted(
    threadId: ThreadId,
    turnId: string,
    itemId: string,
    identity: ModelToolIdentity,
    args: JsonValue,
    result: JsonValue | null,
    error: string | null,
  ): Promise<void> {
    await this.extensions.toolCompleted({
      threadId,
      turnId,
      itemId,
      identity,
      arguments: args,
      result,
      error,
    });
  }

  async spawnChild(input: SpawnChildThreadInput): Promise<SpawnChildThreadResult> {
    this.requireActiveTurn(input.parentThreadId, input.parentTurnId);
    const result = await this.threadTreeMutex.run(async () => {
      if (this.stoppingThreads.has(input.parentThreadId)) throw new ThreadBusyError('Parent Thread is stopping');
      const parent = this.requireThread(input.parentThreadId);
      const role = this.resolveRole(input.role ?? 'default', parent.thread.cwd);
      const resolvedConfiguration = resolveChildConfiguration(parent.configuration, {
        role,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      });
      const toolCeiling = input.allowedTools === undefined ? null : Object.freeze([...new Set(input.allowedTools)]);
      const configuration = applyToolCeiling(resolvedConfiguration, toolCeiling);
      const thread = await this.createThread({
        name: input.taskPath.split('/').at(-1) ?? 'Subagent',
        ephemeral: parent.thread.ephemeral,
        source: 'collaboration',
        threadSource: 'subagent',
        modelProvider: parent.thread.modelProvider,
        cwd: parent.thread.cwd,
      }, {
        sessionId: parent.thread.sessionId,
        parentThreadId: parent.thread.id,
        forkedFromId: null,
        agentRole: role.name,
        agentNickname: input.nickname ?? role.nicknameCandidates?.[0] ?? null,
        configuration,
        toolCeiling,
        modelOverride: input.model ?? null,
        reasoningEffortOverride: input.reasoningEffort ?? null,
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
        ...(input.additionalContext === undefined ? {} : { additionalContext: input.additionalContext }),
      });
      return { thread, turn: response.turn, taskPath: input.taskPath };
    });
    await this.recordSubagentActivity(
      input.parentThreadId,
      input.parentTurnId,
      result.thread.id,
      result.taskPath,
      'started',
    );
    return result;
  }

  async spawnIsolatedSkillThread(input: SpawnIsolatedSkillThreadInput): Promise<SpawnChildThreadResult> {
    this.requireActiveTurn(input.parentThreadId, input.parentTurnId);
    const parentPath = this.taskPathForThread(input.parentThreadId) ?? '/root';
    const skillSlug = input.skillName.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'skill';
    const identity = uuidV7(this.now()).replace(/-/g, '').slice(-12);
    return this.spawnChild({
      parentThreadId: input.parentThreadId,
      parentTurnId: input.parentTurnId,
      parentItemId: input.parentItemId,
      prompt: input.prompt,
      taskPath: `${parentPath}/skill_${skillSlug}_${identity}`,
      role: input.readOnly ? 'explorer' : 'worker',
      allowedTools: input.allowedTools,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    });
  }

  async spawnCollaborationAgent(input: {
    senderThreadId: ThreadId;
    senderTurnId: string;
    parentItemId: string;
    taskName: string;
    message: string;
    role?: string;
    model?: string;
    reasoningEffort?: EffectiveThreadConfiguration['reasoningEffort'];
    forkTurns?: string;
  }): Promise<SpawnChildThreadResult> {
    this.requireActiveTurn(input.senderThreadId, input.senderTurnId);
    if (!/^[a-z][a-z0-9_]*$/.test(input.taskName)) {
      throw new Error('Subagent task_name must use lowercase letters, digits, and underscores');
    }
    const parentPath = this.taskPathForThread(input.senderThreadId) ?? '/root';
    const taskPath = `${parentPath}/${input.taskName}`;
    const sessionId = this.requireThread(input.senderThreadId).thread.sessionId;
    if (this.findSpawnEdgeByPath(sessionId, taskPath)) throw new Error(`Subagent task path already exists: ${taskPath}`);
    const additionalContext = collaborationHistoryContext(this.allTurns(input.senderThreadId), input.forkTurns);
    const result = await this.spawnChild({
      parentThreadId: input.senderThreadId,
      parentTurnId: input.senderTurnId,
      parentItemId: input.parentItemId,
      prompt: input.message,
      taskPath,
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      ...(additionalContext === undefined ? {} : { additionalContext }),
    });
    return result;
  }

  async sendCollaborationMessage(
    senderThreadId: ThreadId,
    senderTurnId: string,
    target: string,
    message: string,
  ): Promise<CollaborationAgentView> {
    this.requireActiveTurn(senderThreadId, senderTurnId);
    const targetThread = this.resolveCollaborationTarget(senderThreadId, target);
    const active = this.activeTurns.get(targetThread.id);
    const content = [{ type: 'text' as const, text: nonEmpty(message, 'message') }];
    if (active) {
      await this.steerTurn({ threadId: targetThread.id, expectedTurnId: active.turnId, input: content });
    } else {
      const queued = this.mailbox.get(targetThread.id) ?? [];
      queued.push({ content });
      this.mailbox.set(targetThread.id, queued);
    }
    this.signalCollaborationActivity(targetThread.id);
    return this.collaborationView(targetThread.id);
  }

  async followupCollaborationTask(
    senderThreadId: ThreadId,
    senderTurnId: string,
    parentItemId: string,
    target: string,
    message: string,
  ): Promise<CollaborationAgentView> {
    this.requireActiveTurn(senderThreadId, senderTurnId);
    const targetThread = this.resolveCollaborationTarget(senderThreadId, target);
    const active = this.activeTurns.get(targetThread.id);
    const content = [{ type: 'text' as const, text: nonEmpty(message, 'message') }];
    if (active) {
      await this.steerTurn({ threadId: targetThread.id, expectedTurnId: active.turnId, input: content });
    } else {
      const queued = this.mailbox.get(targetThread.id) ?? [];
      this.mailbox.delete(targetThread.id);
      await this.startPrivilegedTurn({
        threadId: targetThread.id,
        input: [...queued.flatMap((entry) => entry.content), ...content],
        trigger: {
          kind: 'subagent',
          parentThreadId: senderThreadId,
          parentItemId,
        },
      });
    }
    this.signalCollaborationActivity(targetThread.id);
    return this.collaborationView(targetThread.id);
  }

  listCollaborationAgents(senderThreadId: ThreadId, pathPrefix?: string): readonly CollaborationAgentView[] {
    const sender = this.requireThread(senderThreadId).thread;
    const persisted = this.metadata.childEdges(rootThreadId(sender, (id) => this.requireThread(id).thread), true);
    const ephemeral = [...this.ephemeralSpawnEdges.entries()].map(([childThreadId, edge]) => ({ childThreadId, ...edge }));
    return [...persisted, ...ephemeral]
      .filter((edge) => this.requireThread(edge.childThreadId).thread.sessionId === sender.sessionId)
      .filter((edge) => !pathPrefix || edge.taskPath.startsWith(pathPrefix))
      .map((edge) => this.collaborationView(edge.childThreadId));
  }

  async interruptCollaborationAgent(
    senderThreadId: ThreadId,
    senderTurnId: string,
    target: string,
  ): Promise<CollaborationAgentView> {
    this.requireActiveTurn(senderThreadId, senderTurnId);
    const thread = this.resolveCollaborationTarget(senderThreadId, target);
    const active = this.activeTurns.get(thread.id);
    if (active) await this.interruptTurn(thread.id, active.turnId);
    return this.collaborationView(thread.id);
  }

  async waitForCollaborationActivity(
    senderThreadId: ThreadId,
    senderTurnId: string,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<readonly CollaborationAgentView[]> {
    this.requireActiveTurn(senderThreadId, senderTurnId);
    if (signal?.aborted) throw new Error('Collaboration wait was interrupted');
    const bounded = Math.max(0, Math.min(timeoutMs ?? 30_000, 60_000));
    if (this.takePendingCollaborationActivity(senderThreadId)) {
      await this.flushPendingSubagentActivities(senderThreadId, senderTurnId);
      return this.listCollaborationAgents(senderThreadId);
    }
    const state = this.collaborationActivityState(senderThreadId);
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        if (timer) clearTimeout(timer);
        state.waiters.delete(done);
        signal?.removeEventListener('abort', aborted);
        resolve();
      };
      const aborted = () => {
        if (timer) clearTimeout(timer);
        state.waiters.delete(done);
        reject(new Error('Collaboration wait was interrupted'));
      };
      state.waiters.add(done);
      signal?.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(done, bounded);
    });
    this.takePendingCollaborationActivity(senderThreadId);
    await this.flushPendingSubagentActivities(senderThreadId, senderTurnId);
    return this.listCollaborationAgents(senderThreadId);
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
      void this.launchActiveTurn(accepted)
        .catch((error) => this.failActiveTurn(
          accepted.active!,
          error instanceof Error ? error : new Error(String(error)),
        ))
        .finally(accepted.active.resolveCompletion);
    }
    return accepted;
  }

  private async launchActiveTurn(accepted: AcceptedTurn): Promise<void> {
    if (!accepted.active) return;
    await this.extensions.turnStarted(accepted.thread, accepted.response.turn);
    await this.executeActiveTurn(accepted.active);
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
    if (this.stoppingThreads.has(request.threadId)) throw new ThreadBusyError('Thread is stopping');
    if (record.archived) throw new ThreadBusyError('Thread is archived');
    if (this.activeTurns.has(request.threadId)) throw new ThreadBusyError('Thread already has an active Turn');
    if (onlyIfIdle && record.thread.status.type !== 'idle') throw new ThreadBusyError('Thread is not idle');

    const startedAt = this.now();
    const turnId = request.turnId ?? uuidV7(startedAt);
    const input = await this.resolveUserContent(request.input, {
      threadId: record.thread.id,
      cwd: record.thread.cwd,
    });
    const preview = threadPreviewFromContent(input);
    const item = userMessage(request.threadId, turnId, input, request.clientUserMessageId ?? null);
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
      execution: initialTurnExecution(record.thread, record.configuration),
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

    if (!record.thread.preview.trim() && preview) {
      this.setInitialPreview(request.threadId, preview, startedAt);
    }
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
    this.takePendingCollaborationActivity(active.threadId);
    await this.flushPendingSubagentActivities(active.threadId, active.turnId);
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
        persistOutputImage: (itemId, index, dataBase64, mimeType) => this.payloads.writeImage(
          active.threadId,
          itemId,
          index,
          dataBase64,
          mimeType,
        ),
        persistOutputText: (itemId, text, mimeType, summary) => this.payloads.writeText(
          active.threadId,
          itemId,
          text,
          mimeType,
          summary,
        ),
        onProviderRetry: (retryStatus) => this.emitTransientNotification({
          type: 'turn/providerRetry/changed',
          threadId: active.threadId,
          turnId: active.turnId,
          status: retryStatus,
        }),
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

    this.takePendingCollaborationActivity(active.threadId);
    await this.flushPendingSubagentActivities(active.threadId, active.turnId);
    const aborted = active.controller.signal.aborted;
    const status = aborted ? 'interrupted' : thrown ? 'failed' : result.status ?? 'completed';
    await active.recorder.finishOpenItems(status === 'completed' ? 'failed' : status);
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
      execution: result.execution ?? initialTurn.execution,
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
      turn.execution.usage.totalTokens,
      Math.ceil((turn.durationMs ?? 0) / 1000),
      active.turnId,
    );
    if (status === 'interrupted') await this.extensions.turnAborted(thread, turn);
    else if (thrown) await this.extensions.turnError(thread, turn, thrown);
    else await this.extensions.turnStopped(thread, turn);
    this.queueChildTurnActivity(thread, status);
    await this.extensions.threadIdle(this.requireThread(active.threadId).thread);
  }

  private async failActiveTurn(active: ActiveTurn, error: Error): Promise<void> {
    await this.rejectUserInput(active.threadId, error).catch(() => undefined);
    if (this.activeTurns.get(active.threadId) !== active) {
      await this.setStatus(active.threadId, { type: 'systemError', message: error.message }).catch(() => undefined);
      return;
    }
    await active.recorder.finishOpenItems('failed').catch(() => undefined);
    const initial = this.readTurn(active.threadId, active.turnId);
    if (initial) {
      const completedAt = this.now();
      const failed = decodeTurn({
        ...initial,
        items: active.recorder.orderedItems(),
        status: 'failed',
        error: { message: error.message, code: 'runtime_failure' },
        completedAt,
        durationMs: Math.max(0, completedAt - active.startedAt),
      });
      await this.recordNotification({
        type: 'turn/completed',
        threadId: active.threadId,
        turnId: active.turnId,
        turn: failed,
      }).catch(() => undefined);
      await this.extensions.turnError(this.requireThread(active.threadId).thread, failed, error).catch(() => undefined);
    }
    this.activeTurns.delete(active.threadId);
    await this.setStatus(active.threadId, { type: 'systemError', message: error.message }).catch(() => undefined);
    const thread = this.ephemeral.get(active.threadId)?.record.thread ?? this.metadata.read(active.threadId)?.thread;
    if (thread) this.queueChildTurnActivity(thread, 'failed');
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
      toolCeiling?: readonly string[] | null;
      modelOverride?: string | null;
      reasoningEffortOverride?: EffectiveThreadConfiguration['reasoningEffort'] | null;
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
    const configuration = lineage.configuration ?? await this.resolveConfiguration(request);
    const record = {
      thread,
      archived: false,
      configuration,
      toolCeiling: lineage.toolCeiling ?? null,
      modelOverride: lineage.modelOverride ?? null,
      reasoningEffortOverride: lineage.reasoningEffortOverride ?? null,
    };
    if (thread.ephemeral) {
      this.ephemeral.set(thread.id, { record, turns: [], completedItemIds: new Set() });
      if (thread.parentThreadId) {
        this.ephemeralSpawnEdges.set(thread.id, {
          sessionId: thread.sessionId,
          parentThreadId: thread.parentThreadId,
          taskPath: lineage.taskPath ?? `/root/${thread.id}`,
          createdAt: now,
        });
      }
    } else if (thread.parentThreadId) {
      this.metadata.createChild(record, {
        sessionId: thread.sessionId,
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

  private requireRendererConfigurableThread(threadId: ThreadId): ThreadCatalogRecord {
    const record = this.requireThread(threadId);
    if (record.thread.parentThreadId || record.thread.threadSource !== 'user') {
      throw new Error('Only root user Threads have renderer-editable configuration');
    }
    return record;
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

  private setInitialPreview(threadId: ThreadId, preview: string, updatedAt: number): void {
    const state = this.ephemeral.get(threadId);
    if (state) {
      if (state.record.thread.preview.trim()) return;
      state.record = {
        ...state.record,
        thread: decodeThread({ ...state.record.thread, preview, updatedAt }),
      };
      return;
    }
    if (this.metadata.require(threadId).thread.preview.trim()) return;
    this.metadata.setPreview(threadId, preview, updatedAt);
  }

  private async recordNotification(notification: AgentCoreNotification): Promise<void> {
    const decoded = decodeAgentCoreNotification(notification);
    const record = this.requireThread(decoded.threadId);
    if (record.thread.ephemeral) {
      this.applyEphemeralNotification(decoded);
    } else {
      const entry = await this.rollout.append(decoded.threadId, decoded);
      this.history.apply(entry);
    }
    for (const listener of this.listeners) listener(decoded);
    await this.extensions.notification(decoded);
  }

  private emitTransientNotification(notification: AgentCoreNotification): void {
    const decoded = decodeAgentCoreNotification(notification);
    this.requireThread(decoded.threadId);
    for (const listener of this.listeners) listener(decoded);
  }

  private applyEphemeralNotification(notification: AgentCoreNotification): void {
    const state = this.ephemeral.get(notification.threadId);
    if (!state) throw new Error(`Ephemeral Thread not found: ${notification.threadId}`);
    switch (notification.type) {
      case 'turn/started':
        if (state.turns.some((turn) => turn.id === notification.turnId)) {
          throw new Error(`Turn was already started: ${notification.turnId}`);
        }
        state.turns.push(notification.turn);
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

  private requireActiveTurn(threadId: ThreadId, turnId: string): ActiveTurn {
    const active = this.activeTurns.get(threadId);
    if (!active || active.turnId !== turnId) throw new ThreadBusyError('Expected Turn is not active');
    return active;
  }

  private async resolveUserInput(response: RequestUserInputResponse): Promise<void> {
    const pending = this.pendingUserInputs.get(response.threadId);
    if (!pending) throw new Error('No request_user_input call is waiting for a response');
    const request = pending.request;
    if (request.turnId !== response.turnId || request.itemId !== response.itemId) {
      throw new Error('request_user_input response does not match the pending request');
    }
    validateUserInputAnswers(request, response);
    this.pendingUserInputs.delete(response.threadId);
    if (pending.timer) clearTimeout(pending.timer);
    try {
      await this.recordNotification({
        type: 'userInput/resolved',
        threadId: response.threadId,
        turnId: response.turnId,
        itemId: response.itemId,
        response,
      });
      if (this.activeTurns.get(response.threadId)?.turnId === response.turnId) {
        await this.setStatus(response.threadId, { type: 'active', activeFlags: [] });
      }
      pending.resolve(response);
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private async rejectUserInput(threadId: ThreadId, error: Error): Promise<void> {
    const pending = this.pendingUserInputs.get(threadId);
    if (!pending) return;
    this.pendingUserInputs.delete(threadId);
    if (pending.timer) clearTimeout(pending.timer);
    if (this.activeTurns.get(threadId)?.turnId === pending.request.turnId) {
      await this.setStatus(threadId, { type: 'active', activeFlags: [] }).catch(() => undefined);
    }
    pending.reject(error);
  }

  private taskPathForThread(threadId: ThreadId): string | null {
    return this.ephemeralSpawnEdges.get(threadId)?.taskPath
      ?? this.metadata.spawnEdgeForChild(threadId)?.taskPath
      ?? null;
  }

  private findSpawnEdgeByPath(
    sessionId: string,
    taskPath: string,
  ): { childThreadId: ThreadId; taskPath: string } | null {
    const persisted = this.metadata.spawnEdgeForPath(sessionId, taskPath);
    if (persisted) return persisted;
    for (const [childThreadId, edge] of this.ephemeralSpawnEdges) {
      if (edge.sessionId === sessionId && edge.taskPath === taskPath) return { childThreadId, taskPath };
    }
    return null;
  }

  private resolveCollaborationTarget(senderThreadId: ThreadId, targetInput: string): Thread {
    const target = nonEmpty(targetInput, 'target');
    const sender = this.requireThread(senderThreadId).thread;
    const senderPath = this.taskPathForThread(senderThreadId) ?? '/root';
    const path = target.startsWith('/') ? target : `${senderPath}/${target}`;
    const edge = this.findSpawnEdgeByPath(sender.sessionId, path);
    if (!edge) throw new Error(`Subagent task path not found: ${target}`);
    const thread = this.requireThread(edge.childThreadId).thread;
    if (thread.sessionId !== sender.sessionId) throw new Error('Subagent target is outside the current Thread tree');
    return thread;
  }

  private collaborationView(threadId: ThreadId): CollaborationAgentView {
    const thread = this.requireThread(threadId).thread;
    const edge = this.ephemeralSpawnEdges.get(threadId) ?? this.metadata.spawnEdgeForChild(threadId);
    if (!edge || !thread.parentThreadId) throw new Error(`Thread is not a Subagent: ${threadId}`);
    const latest = this.allTurns(threadId).at(-1);
    const status: CollaborationAgentView['status'] = this.activeTurns.has(threadId)
      ? 'running'
      : !latest
        ? 'pendingInit'
        : latest.status === 'failed'
          ? 'errored'
          : latest.status === 'interrupted'
            ? 'interrupted'
            : 'completed';
    return {
      taskPath: edge.taskPath,
      threadId,
      parentThreadId: thread.parentThreadId,
      nickname: thread.agentNickname,
      role: thread.agentRole,
      status,
    };
  }

  private async recordSubagentActivity(
    ownerThreadId: ThreadId,
    ownerTurnId: string,
    agentThreadId: ThreadId,
    agentPath: string,
    kind: PendingSubagentActivity['kind'],
  ): Promise<void> {
    const active = this.requireActiveTurn(ownerThreadId, ownerTurnId);
    const id = active.recorder.createItemId();
    await active.recorder.completedImmediately({
      type: 'subAgentActivity',
      id,
      provenance: active.recorder.localProvenance(id),
      kind,
      agentThreadId,
      agentPath,
    }, this.now());
  }

  private queueChildTurnActivity(thread: Thread, status: Turn['status']): void {
    if (!thread.parentThreadId) return;
    const agentPath = this.taskPathForThread(thread.id);
    if (!agentPath) return;
    const kind: PendingSubagentActivity['kind'] = status === 'completed'
      ? 'completed'
      : status === 'interrupted'
        ? 'interrupted'
        : 'errored';
    const queued = this.pendingSubagentActivities.get(thread.parentThreadId) ?? [];
    queued.push({ agentThreadId: thread.id, agentPath, kind });
    this.pendingSubagentActivities.set(thread.parentThreadId, queued);
    this.signalCollaborationActivity(thread.parentThreadId);
  }

  private async flushPendingSubagentActivities(threadId: ThreadId, turnId: string): Promise<void> {
    const queued = this.pendingSubagentActivities.get(threadId);
    if (!queued || queued.length === 0) return;
    this.pendingSubagentActivities.delete(threadId);
    let index = 0;
    try {
      for (; index < queued.length; index += 1) {
        const activity = queued[index]!;
        await this.recordSubagentActivity(
          threadId,
          turnId,
          activity.agentThreadId,
          activity.agentPath,
          activity.kind,
        );
      }
    } catch (error) {
      const remaining = queued.slice(index);
      if (remaining.length > 0) {
        this.pendingSubagentActivities.set(threadId, [
          ...remaining,
          ...(this.pendingSubagentActivities.get(threadId) ?? []),
        ]);
      }
      throw error;
    }
  }

  private collaborationActivityState(threadId: ThreadId): CollaborationActivityState {
    let state = this.collaborationActivity.get(threadId);
    if (!state) {
      state = { pending: false, waiters: new Set() };
      this.collaborationActivity.set(threadId, state);
    }
    return state;
  }

  private signalCollaborationActivity(threadId: ThreadId): void {
    const state = this.collaborationActivityState(threadId);
    state.pending = true;
    for (const resolve of [...state.waiters]) resolve();
  }

  private takePendingCollaborationActivity(threadId: ThreadId): boolean {
    const state = this.collaborationActivity.get(threadId);
    if (!state?.pending) return false;
    state.pending = false;
    return true;
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
    const unfinishedItemIds = new Set(
      this.history.unfinishedItems(threadId, turn.id).map((item) => item.id),
    );
    const items = turn.items.map((item) => {
      if (!unfinishedItemIds.has(item.id) || !('status' in item) || item.status !== 'inProgress') return item;
      return decodeThreadItem({ ...item, status: 'interrupted' });
    });
    for (const item of items) {
      if (!unfinishedItemIds.has(item.id)) continue;
      await this.recordNotification({
        type: 'item/completed',
        threadId,
        turnId: turn.id,
        itemId: item.id,
        item,
        completedAt,
      });
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
    payloads: join(root, 'payloads'),
  };
}

function defaultConfiguration(request: ThreadStartRequest): EffectiveThreadConfiguration {
  return defaultEffectiveThreadConfiguration(request.configurationProfile ?? 'default');
}

function threadConfigurationSummary(record: ThreadCatalogRecord): ThreadConfigurationSummary {
  return Object.freeze({
    modelProvider: record.thread.modelProvider,
    model: record.configuration.model,
    reasoningEffort: record.configuration.reasoningEffort,
  });
}

function missingRendererStartDefaults(): never {
  throw new Error('Thread start requires a model provider and working directory.');
}

function defaultAgentRole(name: string): AgentRole {
  const role = BUILT_IN_AGENT_ROLE_DEFINITIONS[name];
  if (!role) throw new Error(`Unknown Agent Role: ${name}`);
  return role;
}

function formatPlan(input: UpdatePlanToolInput): string {
  const lines = input.plan.map((entry) => {
    const marker = entry.status === 'completed' ? '[x]' : entry.status === 'in_progress' ? '[>]' : '[ ]';
    return `${marker} ${entry.step}`;
  });
  return [...(input.explanation ? [input.explanation, ''] : []), ...lines].join('\n');
}

function validateUserInputAnswers(request: RequestUserInputRequest, response: RequestUserInputResponse): void {
  if (response.answers.length !== request.questions.length) {
    throw new Error('request_user_input response must answer every question exactly once');
  }
  const questions = new Map(request.questions.map((question) => [question.id, question]));
  for (const answer of response.answers) {
    const question = questions.get(answer.questionId);
    if (!question) throw new Error(`Unknown request_user_input question: ${answer.questionId}`);
    if (answer.optionLabel !== undefined && !question.options.some((option) => option.label === answer.optionLabel)) {
      throw new Error(`Unknown option for request_user_input question ${answer.questionId}: ${answer.optionLabel}`);
    }
    questions.delete(answer.questionId);
  }
  if (questions.size > 0) throw new Error('request_user_input response omitted a question');
}

function rootThreadId(thread: Thread, read: (threadId: ThreadId) => Thread): ThreadId {
  let current = thread;
  const visited = new Set<ThreadId>();
  while (current.parentThreadId) {
    if (visited.has(current.id)) throw new Error('Thread parent lineage contains a cycle');
    visited.add(current.id);
    current = read(current.parentThreadId);
  }
  return current.id;
}

function collaborationHistoryContext(turns: readonly Turn[], forkTurns = 'all'): AdditionalContext | undefined {
  const normalized = forkTurns.trim() || 'all';
  if (normalized === 'none') return undefined;
  const count = normalized === 'all'
    ? turns.length
    : /^[1-9]\d*$/.test(normalized)
      ? Number(normalized)
      : NaN;
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error('fork_turns must be none, all, or a positive integer string');
  }
  const selected = turns.slice(-count);
  const lines = selected.flatMap((turn) => turn.items.flatMap((item) => {
    if (item.type === 'userMessage') {
      return [`User: ${item.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')}`];
    }
    if (item.type === 'agentMessage' && item.text) return [`Assistant: ${item.text}`];
    return [];
  }));
  if (lines.length === 0) return undefined;
  return {
    parent_thread_history: {
      kind: 'application',
      value: lines.join('\n\n').slice(-50_000),
    },
  };
}

function pageEphemeralTurns(
  turns: readonly Turn[],
  request: ThreadTurnsListRequest,
  direction: 'asc' | 'desc',
): { data: readonly Turn[]; nextCursor: string | null; backwardsCursor: string | null } {
  const positioned = turns.map((turn, position) => ({ value: turn, position, id: turn.id }));
  return pageEphemeral(positioned, request.cursor, request.limit, direction, 'ephemeralTurn');
}

function pageEphemeralItems(
  entries: readonly ThreadItemEntry[],
  request: ThreadItemsListRequest,
): ThreadItemsListResponse {
  const positioned = entries.map((entry, position) => ({ value: entry, position, id: entry.item.id }));
  const page = pageEphemeral(
    positioned,
    request.cursor,
    request.limit,
    request.sortDirection ?? 'asc',
    'ephemeralItem',
  );
  return page;
}

function pageEphemeral<T>(
  values: readonly { value: T; position: number; id: string }[],
  cursorInput: string | null | undefined,
  limitInput: number | null | undefined,
  direction: 'asc' | 'desc',
  kind: string,
): { data: readonly T[]; nextCursor: string | null; backwardsCursor: string | null } {
  const cursor = decodeCursor(cursorInput);
  if (cursor && (
    cursor.kind !== kind
    || cursor.direction !== direction
    || typeof cursor.position !== 'number'
    || !Number.isSafeInteger(cursor.position)
    || typeof cursor.id !== 'string'
  )) throw new Error('Invalid ephemeral history cursor');
  const cursorPosition = cursor?.position as number | undefined;
  const cursorId = cursor?.id as string | undefined;
  const filtered = values
    .filter((entry) => cursorPosition === undefined || cursorId === undefined || (direction === 'asc'
      ? entry.position > cursorPosition || (entry.position === cursorPosition && entry.id > cursorId)
      : entry.position < cursorPosition || (entry.position === cursorPosition && entry.id < cursorId)))
    .sort((left, right) => direction === 'asc'
      ? left.position - right.position || left.id.localeCompare(right.id)
      : right.position - left.position || right.id.localeCompare(left.id));
  const limit = pageLimit(limitInput);
  const page = filtered.slice(0, limit);
  const first = page[0];
  const last = page.at(-1);
  return {
    data: page.map((entry) => entry.value),
    nextCursor: filtered.length > limit && last
      ? encodeCursor({ kind, position: last.position, id: last.id, direction })
      : null,
    backwardsCursor: first
      ? encodeCursor({
          kind,
          position: first.position,
          id: first.id,
          direction: direction === 'asc' ? 'desc' : 'asc',
        })
      : null,
  };
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be non-empty`);
  return normalized;
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

function initialTurnExecution(
  thread: Thread,
  configuration: EffectiveThreadConfiguration,
): Turn['execution'] {
  return {
    modelProvider: thread.modelProvider,
    model: configuration.model,
    reasoningEffort: configuration.reasoningEffort,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: null,
    },
  };
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

function applyToolCeiling(
  configuration: EffectiveThreadConfiguration,
  toolCeiling: readonly string[] | null,
): EffectiveThreadConfiguration {
  if (toolCeiling === null) return configuration;
  const allowed = new Set(toolCeiling);
  return Object.freeze({
    ...configuration,
    tools: Object.freeze(configuration.tools.filter((tool) => allowed.has(tool))),
  });
}

function emptyResponse(): EmptyAgentCoreResponse {
  return Object.freeze({});
}
