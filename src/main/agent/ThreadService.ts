import type { Stats } from 'node:fs';
import { join } from 'node:path';
import {
decodeAgentCoreRequest,
decodeAgentCoreResponse,
decodePrivilegedTurnStartRequest,
decodeThread,
decodeThreadItem,
decodeTurn,
} from '../../core/agent/codec';
import {
type AgentRole,
type EffectiveThreadConfiguration
} from '../../core/agent/configuration';
import {
createHostRootTurnAdmissionBarrierSnapshot,
createThreadAdmissionBarrierSnapshot,
type ExtensionToolContribution,
type HostRootTurnAdmissionBarrierSnapshot,
type ThreadAdmissionBarrierSnapshot,
type ThreadServiceExtensionHost
} from '../../core/agent/extensions';
import type {
CreateGoalResponse,
GetGoalResponse,
UpdateGoalResponse,
} from '../../core/agent/goal';
import type {
AdditionalContext,
AgentCoreMethod,
AgentCoreRequestByMethod,
AgentCoreResponseByMethod,
ContextCompactionThreadItem,
ContextCursor,
ContextEvidenceKind,
ContextEvidenceThreadItem,
EmptyAgentCoreResponse,
InheritedContextPayload,
JsonValue,
PrivilegedTurnStartRequest,
RendererTurnStartRequest,
RequestUserInputRequest,
RequestUserInputResponse,
RoleCatalogContextPayload,
SkillCatalogContextPayload,
SkillInvocationContextPayload,
Thread,
ThreadAttachmentContent,
ThreadConfigurationResponse,
ThreadConfigurationSetRequest,
ThreadConfigurationSummary,
ThreadContextPayload,
ThreadContextPayloadReference,
ThreadContextReadRequest,
ThreadContextReadResponse,
ThreadFeatureSource,
ThreadForkRequest,
ThreadId,
ThreadItem,
ThreadItemOutputReadRequest,
ThreadItemOutputReadResponse,
ThreadItemsListRequest,
ThreadItemsListResponse,
ThreadListRequest,
ThreadListResponse,
ThreadReadRequest,
ThreadReadResponse,
ThreadResourceReference,
ThreadRollbackRequest,
ThreadStartRequest,
ThreadStartResponse,
ThreadStatus,
ThreadTurnDetailsReadRequest,
ThreadTurnDetailsReadResponse,
ThreadTurnsListRequest,
ThreadTurnsListResponse,
ThreadUserContent,
Turn,
TurnId,
TurnStartResponse,
TurnSteerRequest,
TurnSteerResponse
} from '../../core/agent/protocol';
import { threadPreviewFromContent } from '../../core/agent/threadPreview';
import {
normalizeRequestUserInputToolInput,
normalizeUpdatePlanToolInput,
type ModelToolIdentity,
type UpdatePlanToolInput
} from '../../core/agent/tools';
import type { DocumentProjection } from '../../core/types';
import {
BUILT_IN_AGENT_ROLE_DEFINITIONS,
defaultEffectiveThreadConfiguration,
} from './AgentConfigurationLoader';
import type { ReferencedAssetResolution } from './capabilities/agentReferencedAssets';
import { planContextCompaction } from './context/ContextCompaction';
import {
assertContextPayloadDependencies
} from './context/contextDependencies';
import { cursorFor,selectEffectiveContext } from './context/ContextEpoch';
import { admitContextEvidence,contextEvidenceItem } from './context/evidenceAdmission';
import { planRoleCatalogEvidence } from './context/RoleContextReducer';
import {
observedSkillFilePaths,
planSkillCatalogEvidence
} from './context/SkillContextReducer';
import { ExtensionRegistry } from './ExtensionRegistry';
import { GoalExtension } from './extensions/goal/GoalExtension';
import { GoalStore } from './extensions/goal/GoalStore';
import {
RolloutStore,
type ThreadHistoryRollbackMarker
} from './persistence/RolloutStore';
import { openSqlite } from './persistence/sqlite';
import {
SubagentBudgetLedger,
type SubagentBudgetRecord,
} from './persistence/SubagentBudgetLedger';
import { ThreadHistoryProjectionStore } from './persistence/ThreadHistoryProjectionStore';
import {
ThreadMetadataStore,
type ThreadCatalogRecord
} from './persistence/ThreadMetadataStore';
import { ToolPayloadStore } from './persistence/ToolPayloadStore';
import { ItemRecorder } from './runtime/ItemRecorder';
import type {
StagedContextCompaction,
SteeredTurnInput,
ThreadNameGenerator,
TurnExecutionResult,
TurnExecutor,
} from './runtime/types';
import { SubagentBudgetExhaustedError } from './SubagentBudgetExhaustedError';
import { SubagentCollaboration,type StagedContextEvidence } from './thread/SubagentCollaboration';
import { ThreadCatalogOps } from './thread/ThreadCatalogOps';
import { ThreadCore,type NotificationListener } from './thread/ThreadCore';
import { ThreadResourceOps } from './thread/ThreadResourceOps';
import { uuidV7 } from './uuid';

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
  readonly subagentBudgets: SubagentBudgetLedger;
  readonly payloads: ToolPayloadStore;
}

export interface ThreadServiceOptions {
  readonly stores: ThreadServiceStores;
  readonly executor: TurnExecutor;
  readonly attachmentScratchRoot: string;
  readonly nameGenerator?: ThreadNameGenerator;
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
  readonly getDocumentProjection?: () => DocumentProjection;
  readonly resolveReferencedAsset?: (assetId: string) => Promise<ReferencedAssetResolution | null>;
  readonly resolveSkillAdmission?: (
    input: SkillAdmissionResolutionInput,
  ) => SkillAdmissionResolution | Promise<SkillAdmissionResolution>;
  readonly resolveRole?: (name: string, cwd: string) => AgentRole;
  readonly resolveRoleCatalog?: (
    cwd: string,
  ) => RoleCatalogContextPayload | Promise<RoleCatalogContextPayload>;
  readonly resolveSubagentTokenBudget?: () => number | null | Promise<number | null>;
  readonly beforeInitialTurnAdmission?: () => void | Promise<void>;
  readonly now?: () => number;
}

export interface SkillAdmissionResolutionInput {
  readonly thread: Thread;
  readonly configuration: EffectiveThreadConfiguration;
  readonly content: readonly ThreadUserContent[];
  readonly acceptedAt: number;
  readonly observedFilePaths: readonly string[];
}

export interface SkillAdmissionResolution {
  readonly catalogSnapshot: SkillCatalogContextPayload | null;
  readonly invocation: SkillInvocationContextPayload | null;
}

export interface RendererThreadStartDefaults {
  readonly modelProvider: string;
  readonly cwd: string;
}

export interface ThreadUserContentResolutionContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly recordCreatedResource: (ref: ThreadResourceReference) => void;
}

export interface ResolvedThreadAttachmentFile {
  readonly entryKind: 'file' | 'directory';
  readonly path: string;
  readonly stats: Stats;
  readonly attachment: ThreadAttachmentContent;
}

export interface ResolvedThreadResourceFile {
  readonly entryKind: 'file';
  readonly path: string;
  readonly stats: Stats;
  readonly ref: ThreadResourceReference;
}

export interface FeatureRootThreadInput {
  readonly id: ThreadId;
  readonly name: string;
  readonly source: string;
  readonly threadSource: ThreadFeatureSource;
  readonly modelProvider: string;
  readonly cwd: string;
  readonly configuration: EffectiveThreadConfiguration;
}

export interface PersistentThreadExecutionContext {
  readonly thread: Thread;
  readonly configuration: EffectiveThreadConfiguration;
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
  readonly inheritedContext?: InheritedContextPayload;
  readonly maxTotalTokens?: number;
  /** Selects the parent-facing result channel while retaining one child-Thread mechanism. */
  readonly childKind?: 'collaboration' | 'isolatedSkill';
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
  readonly tokensUsed: number;
  readonly tokenBudget: number | null;
}

export interface CollaborationTerminalOutcome {
  readonly taskPath: string;
  readonly threadId: ThreadId;
  readonly status: 'interrupted' | 'completed' | 'errored';
  readonly result: string | null;
  readonly error: string | null;
}

export interface CollaborationWaitResult {
  readonly reason: 'terminal' | 'steering' | 'idle';
  readonly updates: readonly CollaborationTerminalOutcome[];
  readonly agents: readonly CollaborationAgentView[];
}

interface ActiveTurn {
  readonly threadId: ThreadId;
  readonly turnId: string;
  readonly controller: AbortController;
  readonly recorder: ItemRecorder;
  readonly configuration: EffectiveThreadConfiguration;
  readonly startedAt: number;
  fatalError: Error | null;
  finishing: boolean;
  steeringHandler: ((input: SteeredTurnInput) => void | Promise<void>) | null;
  readonly queuedSteering: SteeredTurnInput[];
  steeringDelivery: Promise<void>;
  readonly completion: Promise<void>;
  readonly resolveCompletion: () => void;
  recordedExecution: Turn['execution'] | null;
  budgetUsageAccrued: boolean;
}

interface PendingUserInput {
  readonly request: RequestUserInputRequest;
  readonly resolve: (response: RequestUserInputResponse) => void;
  readonly reject: (error: Error) => void;
  readonly abort: () => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface AcceptedTurn {
  readonly response: TurnStartResponse;
  readonly thread: Thread;
  readonly active: ActiveTurn | null;
}

type InternalTurnStartRequest = PrivilegedTurnStartRequest & {
  readonly stagedContextEvidence?: readonly StagedContextEvidence[];
};

export class ThreadService implements ThreadServiceExtensionHost {
  private readonly core: ThreadCore;
  private readonly executor: TurnExecutor;
  private readonly extensions: ExtensionRegistry;
  private readonly getDocumentProjection: () => DocumentProjection | null;
  private readonly resolveReferencedAsset?: (assetId: string) => Promise<ReferencedAssetResolution | null>;
  private readonly resolveSkillAdmission: (
    input: SkillAdmissionResolutionInput,
  ) => Promise<SkillAdmissionResolution>;
  private readonly resolveRoleCatalog: (
    cwd: string,
  ) => Promise<RoleCatalogContextPayload | null>;
  private readonly beforeInitialTurnAdmission: () => void | Promise<void>;
  private readonly now: () => number;
  private readonly goals: GoalExtension;
  private readonly goalStore: GoalStore;
  private readonly subagentBudgets: SubagentBudgetLedger;
  private readonly resourceOps: ThreadResourceOps;
  private readonly catalogOps: ThreadCatalogOps;
  private readonly collaboration: SubagentCollaboration;
  private readonly activeTurns = new Map<ThreadId, ActiveTurn>();
  private readonly pendingUserInputs = new Map<ThreadId, PendingUserInput>();
  private initialized = false;
  private closing = false;

  private get threadMutex() { return this.core.threadMutex; }
  constructor(options: ThreadServiceOptions) {
    this.executor = options.executor;
    this.extensions = options.extensions ?? new ExtensionRegistry();
    this.core = new ThreadCore(
      options.stores.metadata,
      options.stores.history,
      options.stores.rollout,
      options.stores.payloads,
      this.extensions,
    );
    this.getDocumentProjection = options.getDocumentProjection ?? (() => null);
    this.resolveReferencedAsset = options.resolveReferencedAsset;
    this.resolveSkillAdmission = async (input) => await options.resolveSkillAdmission?.(input) ?? {
      catalogSnapshot: null,
      invocation: null,
    };
    const resolveRole = options.resolveRole ?? defaultAgentRole;
    this.resolveRoleCatalog = async (cwd) => await options.resolveRoleCatalog?.(cwd) ?? null;
    this.beforeInitialTurnAdmission = options.beforeInitialTurnAdmission ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.goalStore = options.stores.goals;
    this.subagentBudgets = options.stores.subagentBudgets;
    this.resourceOps = new ThreadResourceOps(
      this.core,
      options.attachmentScratchRoot,
      options.resolveUserContent ?? ((content) => content),
    );
    this.collaboration = new SubagentCollaboration(
      this.core,
      {
        createThread: (...args) => this.catalogOps.createThread(...args),
        deleteThread: (threadId) => this.catalogOps.deleteThread(threadId),
      },
      {
        assertActiveTurn: (threadId, turnId) => { this.requireActiveTurn(threadId, turnId); },
        activeTurnId: (threadId) => this.activeTurns.get(threadId)?.turnId ?? null,
        assertSubagentBudgetAvailable: (threadId) => this.assertSubagentBudgetAvailable(threadId),
        acceptAndLaunch: (request) => this.acceptAndLaunch(request),
        startPrivilegedTurn: (request) => this.startPrivilegedTurn(request),
        steerTurn: (request) => this.steerTurn(request),
        interruptTurn: (threadId, turnId) => this.interruptTurn(threadId, turnId),
        recordSubagentActivity: async (
          ownerThreadId,
          ownerTurnId,
          agentThreadId,
          agentPath,
          kind,
          completedAt,
        ) => {
          const active = this.requireActiveTurn(ownerThreadId, ownerTurnId);
          const id = active.recorder.createItemId();
          await active.recorder.completedImmediately({
            type: 'subAgentActivity',
            id,
            provenance: active.recorder.localProvenance(id),
            kind,
            agentThreadId,
            agentPath,
          }, completedAt);
        },
      },
      this.subagentBudgets,
      resolveRole,
      async () => await options.resolveSubagentTokenBudget?.() ?? null,
      this.now,
      applyToolCeiling,
      (message) => new ThreadBusyError(message),
    );
    this.catalogOps = new ThreadCatalogOps(
      this.core,
      this.resourceOps,
      this.extensions,
      options.nameGenerator ?? null,
      options.resolveConfiguration ?? defaultConfiguration,
      options.resolveRendererStartDefaults ?? missingRendererStartDefaults,
      options.validateRendererConfiguration ?? (() => undefined),
      resolveRole,
      this.now,
      () => this.closing,
      applyToolCeiling,
      {
        hasActiveTurn: (threadId) => this.activeTurns.has(threadId),
        abortForSubtreeStop: (threadId) => this.core.threadMutex.run(threadId, async () => {
          this.activeTurns.get(threadId)?.controller.abort();
          this.pendingUserInputs.get(threadId)?.abort();
        }),
        waitForIdle: (threadId) => this.waitForIdle(threadId),
        setStatus: (threadId, status) => this.setStatus(threadId, status),
      },
      this.collaboration,
      (threadId) => this.goals.clear(threadId),
      (threadId) => { this.subagentBudgets.clear(threadId); },
      (message) => new ThreadBusyError(message),
    );
    this.goals = new GoalExtension(this.goalStore, (notification) => this.core.recordNotification(notification));
    this.goals.bindHost(this, (threadId) => this.core.requireThread(threadId).thread);
    this.extensions.register(this.goals);
  }

  static open(
    userDataPath: string,
    executor: TurnExecutor,
    options: Omit<ThreadServiceOptions, 'stores' | 'executor'>,
  ): ThreadService {
    const paths = agentCorePaths(userDataPath);
    const metadata = new ThreadMetadataStore(paths.state);
    const goalsDatabase = openSqlite(paths.goals);
    return new ThreadService({
      executor,
      ...options,
      stores: {
        metadata,
        history: new ThreadHistoryProjectionStore(paths.history),
        rollout: new RolloutStore(paths.rollouts),
        goals: new GoalStore(paths.goals, goalsDatabase),
        subagentBudgets: new SubagentBudgetLedger(goalsDatabase),
        payloads: new ToolPayloadStore(paths.payloads),
      },
    });
  }
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.core.payloads.initialize();
    const knownThreadIds: ThreadId[] = [];
    const resumableThreadIds: ThreadId[] = [];
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      do {
        const page = this.core.metadata.list({ archived, cursor, limit: 100 });
        for (const thread of page.data) {
          await this.catalogOps.reconcileThread(thread.id);
          knownThreadIds.push(thread.id);
          if (!archived) resumableThreadIds.push(thread.id);
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    await Promise.all(knownThreadIds.flatMap((threadId) => [
      this.core.payloads.pruneUnreferencedResources(threadId, this.resourceOps.threadResourceReferences(threadId)),
      this.core.payloads.pruneUnreferencedContexts(threadId, this.resourceOps.threadContextPayloadReferences(threadId)),
      this.core.payloads.pruneUnreferencedTurnDiagnostics(threadId, this.resourceOps.threadTurnDiagnosticsReferences(threadId)),
      this.core.payloads.pruneUnreferencedTextOutputs(threadId, this.resourceOps.threadTextPayloadReferences(threadId)),
    ]));
    const resumableThreads: Thread[] = [];
    for (const threadId of resumableThreadIds) {
      const { thread } = await this.resumeThread(threadId);
      resumableThreads.push(thread);
    }
    await this.beforeInitialTurnAdmission();
    this.initialized = true;
    for (const thread of resumableThreads) {
      if (thread.status.type === 'idle') {
        await this.extensions.threadIdle(this.core.requireThread(thread.id).thread);
      }
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    const active = [...this.activeTurns.values()];
    const pendingNames = this.catalogOps.pendingNameShutdownHandles();
    for (const turn of active) turn.controller.abort();
    for (const pending of pendingNames) pending.abort();
    for (const pending of this.pendingUserInputs.values()) pending.abort();
    await Promise.allSettled([
      ...active.map((turn) => turn.completion),
      ...pendingNames.map((pending) => pending.completion),
    ]);
    const failures: unknown[] = [];
    const operations = await Promise.allSettled([
      this.core.rollout.flush(),
      this.core.rollbackRecovery.close(),
      this.core.payloads.abortAllResourceUploads(),
      Promise.all([...this.core.ephemeral.keys()].map((threadId) => this.core.payloads.deleteThread(threadId))),
    ]);
    for (const result of operations) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    for (const close of [
      () => this.core.metadata.close(),
      () => this.core.history.close(),
      () => this.goalStore.close(),
    ]) {
      try {
        close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'ThreadService failed to close cleanly');
  }
  subscribe(listener: NotificationListener): () => void { return this.core.subscribe(listener); }
  async waitForIdle(threadId: ThreadId): Promise<void> {
    while (true) {
      const active = this.activeTurns.get(threadId);
      if (!active) return;
      await active.completion;
    }
  }
  persistentRootThreads(): readonly Thread[] { return this.catalogOps.persistentRootThreads(); }
  persistentThreadExecutionContext(threadId: ThreadId): PersistentThreadExecutionContext { return this.catalogOps.persistentThreadExecutionContext(threadId); }
  readTurnForHost(threadId: ThreadId, turnId: TurnId): Turn | null { return this.core.readTurn(threadId, turnId); }
  readTurnByClientUserMessageIdForHost(threadId: ThreadId, clientId: string): Turn | null {
    return this.readCanonicalClientBinding(threadId, clientId)?.turn ?? null;
  }
  async ensureFeatureRootThread(input: FeatureRootThreadInput): Promise<Thread> { return this.catalogOps.ensureFeatureRootThread(input); }
  activeRootUserTurns(): readonly { threadId: ThreadId; turnId: TurnId }[] {
    const result: Array<{ threadId: ThreadId; turnId: TurnId }> = [];
    for (const active of this.activeTurns.values()) {
      const thread = this.core.requireThread(active.threadId).thread;
      if (thread.parentThreadId === null && thread.threadSource === 'user' && !thread.ephemeral) {
        result.push({ threadId: active.threadId, turnId: active.turnId });
      }
    }
    return result;
  }
  isThreadNavigable(threadId: ThreadId): boolean { return this.catalogOps.isThreadNavigable(threadId); }
  async interruptRootTurns(turns: readonly { threadId: ThreadId; turnId: TurnId }[]): Promise<void> {
    await Promise.all(turns.map(async ({ threadId, turnId }) => {
      const active = this.activeTurns.get(threadId);
      if (active?.turnId === turnId) active.controller.abort();
    }));
    await Promise.all(turns.map(({ threadId }) => this.waitForIdle(threadId)));
  }
  async runInternalMemoryTurn(input: {
    readonly sourceThreadId: ThreadId;
    readonly name: string;
    readonly systemPrompt: string;
    readonly prompt: string;
    readonly signal: AbortSignal;
  }): Promise<string> {
    const source = this.core.requireThread(input.sourceThreadId);
    const configuration: EffectiveThreadConfiguration = Object.freeze({
      ...source.configuration,
      developerInstructions: Object.freeze([input.systemPrompt]),
      tools: Object.freeze([]),
      skills: Object.freeze([]),
      plugins: Object.freeze([]),
      mcpServers: Object.freeze([]),
    });
    const id = uuidV7(this.now());
    const thread = await this.catalogOps.createThread({
      id,
      name: input.name,
      ephemeral: true,
      source: 'agent.memory',
      threadSource: 'memory_consolidation',
      modelProvider: source.thread.modelProvider,
      cwd: source.thread.cwd,
    }, {
      sessionId: id,
      parentThreadId: null,
      forkedFromId: null,
      agentRole: null,
      agentNickname: null,
      configuration,
      hidden: true,
    });
    let acceptedTurnId: string | null = null;
    const interrupt = () => {
      if (acceptedTurnId) void this.interruptTurn(thread.id, acceptedTurnId).catch(() => undefined);
    };
    input.signal.addEventListener('abort', interrupt, { once: true });
    try {
      if (input.signal.aborted) throw createAbortError('Internal Memory Turn was interrupted');
      const accepted = await this.startPrivilegedTurn({
        threadId: thread.id,
        input: [{ type: 'text', text: input.prompt }],
        trigger: { kind: 'feature', feature: 'memory' },
      });
      acceptedTurnId = accepted.turn.id;
      if (input.signal.aborted) interrupt();
      await this.waitForIdle(thread.id);
      const completed = this.core.readTurn(thread.id, accepted.turn.id);
      if (!completed || completed.status !== 'completed') {
        throw new Error(completed?.error?.message ?? 'Internal Memory Turn did not complete');
      }
      return completed.items
        .flatMap((item) => item.type === 'agentMessage' && (item.phase === 'final_answer' || item.phase === null)
          ? [item.text]
          : [])
        .join('\n')
        .trim();
    } finally {
      input.signal.removeEventListener('abort', interrupt);
      await this.deleteThread(thread.id).catch(() => undefined);
    }
  }
  async extensionToolContributions(threadId: ThreadId): Promise<readonly ExtensionToolContribution[]> {
    if (this.core.hiddenEphemeralThreads.has(threadId)) return [];
    return this.extensions.tools(this.core.requireThread(threadId).thread);
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
      case 'thread/rollback':
        return await this.rollbackThread(
          decoded as AgentCoreRequestByMethod['thread/rollback'],
        ) as AgentCoreResponseByMethod[Method];
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
      case 'thread/context/read':
        return await this.readContextPayload(
          decoded as AgentCoreRequestByMethod['thread/context/read'],
        ) as AgentCoreResponseByMethod[Method];
      case 'thread/turn/details/read':
        return await this.readTurnDetails(
          decoded as AgentCoreRequestByMethod['thread/turn/details/read'],
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
  listTurns(request: ThreadTurnsListRequest): ThreadTurnsListResponse { return this.catalogOps.listTurns(request); }
  async readItemOutput(request: ThreadItemOutputReadRequest): Promise<ThreadItemOutputReadResponse> { return this.resourceOps.readItemOutput(request); }
  async readContextPayload(request: ThreadContextReadRequest): Promise<ThreadContextReadResponse> { return this.resourceOps.readContextPayload(request); }
  async readTurnDetails(request: ThreadTurnDetailsReadRequest): Promise<ThreadTurnDetailsReadResponse> { return this.resourceOps.readTurnDetails(request); }
  async beginAttachmentUpload(input: {
    readonly threadId: ThreadId;
    readonly attachmentId: string;
    readonly expectedBytes: number;
    readonly mimeType: string;
    readonly fileName: string;
  }): Promise<string> { return this.resourceOps.beginAttachmentUpload(input); }
  async appendAttachmentUpload(input: {
    readonly threadId: ThreadId;
    readonly attachmentId: string;
    readonly uploadId: string;
    readonly bytes: Uint8Array;
  }): Promise<void> { return this.resourceOps.appendAttachmentUpload(input); }
  async finishAttachmentUpload(input: {
    readonly threadId: ThreadId;
    readonly attachmentId: string;
    readonly uploadId: string;
  }): Promise<ThreadResourceReference> { return this.resourceOps.finishAttachmentUpload(input); }
  async abortAttachmentUpload(input: {
    readonly threadId: ThreadId;
    readonly attachmentId: string;
    readonly uploadId: string;
  }): Promise<void> { return this.resourceOps.abortAttachmentUpload(input); }
  async writeThreadResource(
    threadId: ThreadId,
    bytes: Uint8Array,
    mimeType: string,
    fileName: string,
  ): Promise<ThreadResourceReference> { return this.resourceOps.writeThreadResource(threadId, bytes, mimeType, fileName); }
  async writeThreadResourceWithStatus(
    threadId: ThreadId,
    bytes: Uint8Array,
    mimeType: string,
    fileName: string,
  ): Promise<{ readonly ref: ThreadResourceReference; readonly created: boolean }> { return this.resourceOps.writeThreadResourceWithStatus(threadId, bytes, mimeType, fileName); }

  async useThreadResourcePath<T>(
    threadId: ThreadId,
    ref: ThreadResourceReference,
    use: (path: string) => Promise<T>,
  ): Promise<T | null> { return this.resourceOps.useThreadResourcePath(threadId, ref, use); }
  async readThreadResource(
    threadId: ThreadId,
    ref: ThreadResourceReference,
  ): Promise<Buffer | null> { return this.resourceOps.readThreadResource(threadId, ref); }
  async readReferencedThreadResource(
    threadId: ThreadId,
    ref: ThreadResourceReference,
  ): Promise<Buffer | null> { return this.resourceOps.readReferencedThreadResource(threadId, ref); }
  async discardUnreferencedThreadResource(
    threadId: ThreadId,
    ref: ThreadResourceReference,
  ): Promise<boolean> { return this.resourceOps.discardUnreferencedThreadResource(threadId, ref); }
  async resolveAttachmentFile(
    threadId: ThreadId,
    attachmentId: string,
  ): Promise<ResolvedThreadAttachmentFile | null> { return this.resourceOps.resolveAttachmentFile(threadId, attachmentId); }
  async resolveThreadResourceFile(
    threadId: ThreadId,
    ref: ThreadResourceReference,
  ): Promise<ResolvedThreadResourceFile | null> { return this.resourceOps.resolveThreadResourceFile(threadId, ref); }
  listItems(request: ThreadItemsListRequest): ThreadItemsListResponse { return this.catalogOps.listItems(request); }
  listThreads(request: ThreadListRequest = {}): ThreadListResponse { return this.catalogOps.listThreads(request); }
  readThread(request: ThreadReadRequest): ThreadReadResponse { return this.catalogOps.readThread(request); }
  getThreadConfiguration(threadId: ThreadId): ThreadConfigurationResponse { return this.catalogOps.getThreadConfiguration(threadId); }
  async setThreadConfiguration(request: ThreadConfigurationSetRequest): Promise<ThreadConfigurationResponse> { return this.catalogOps.setThreadConfiguration(request); }
  async startThread(requestInput: AgentCoreRequestByMethod['thread/start']): Promise<ThreadStartResponse> { return this.catalogOps.startThread(requestInput); }
  async resumeThread(threadId: ThreadId): Promise<{ thread: Thread }> { return this.catalogOps.resumeThread(threadId); }
  async forkThread(request: ThreadForkRequest): Promise<{ thread: Thread }> { return this.catalogOps.forkThread(request); }
  async rollbackThread(request: ThreadRollbackRequest): Promise<{ thread: Thread }> { return this.catalogOps.rollbackThread(request); }
  historyProjectionVersion(threadId: ThreadId): number { return this.catalogOps.historyProjectionVersion(threadId); }
  hasHistoryRollbackMarker(rollbackId: string): boolean { return this.catalogOps.hasHistoryRollbackMarker(rollbackId); }
  historyRollbackMarker(rollbackId: string): ThreadHistoryRollbackMarker | null { return this.catalogOps.historyRollbackMarker(rollbackId); }
  async setThreadName(threadId: ThreadId, name: string | null): Promise<void> { return this.catalogOps.setThreadName(threadId, name); }
  async setThreadArchived(threadId: ThreadId, archived: boolean): Promise<void> { return this.catalogOps.setThreadArchived(threadId, archived); }
  async deleteThread(threadId: ThreadId): Promise<void> { return this.catalogOps.deleteThread(threadId); }
  async startRendererTurn(request: RendererTurnStartRequest): Promise<TurnStartResponse> {
    const contextCommand = parseContextCommand(request.input);
    if (contextCommand) return this.startContextCommand(request, contextCommand);
    const privileged: PrivilegedTurnStartRequest = { ...request, trigger: { kind: 'user' } };
    return (await this.acceptAndLaunch(privileged)).response;
  }

  private async startContextCommand(
    request: RendererTurnStartRequest,
    command: ContextCommand,
  ): Promise<TurnStartResponse> { return this.core.threadMutex.run(request.threadId, async () => {
      const record = this.core.requireThread(request.threadId);
      const existing = request.clientUserMessageId
        ? this.readCanonicalClientBinding(request.threadId, request.clientUserMessageId)
        : null;
      if (existing) return { turn: existing.turn, acceptedItemId: existing.itemId, deduplicated: true };
      if (this.core.stoppingThreads.has(request.threadId)) throw new ThreadBusyError('Thread is stopping');
      if (record.archived) throw new ThreadBusyError('Thread is archived');
      if (this.activeTurns.has(request.threadId)) throw new ThreadBusyError('Thread already has an active Turn');
      if (record.thread.status.type !== 'idle') throw new ThreadBusyError('Thread is not idle');

      const turns = this.core.allTurns(request.threadId);
      const selected = selectEffectiveContext(turns);
      if (command.kind === 'clear' && selected.latestReset && !hasContextSinceBoundary(selected.turns)) {
        const prior = findItemOwner(turns, selected.latestReset.id);
        if (!prior) throw new Error('The latest context reset is unreachable.');
        if (request.clientUserMessageId) {
          this.bindClientInput(request.threadId, request.clientUserMessageId, prior.id, selected.latestReset.id);
        }
        return { turn: prior, acceptedItemId: selected.latestReset.id, deduplicated: true };
      }

      const startedAt = this.now();
      const turnId = uuidV7(startedAt);
      const itemId = uuidV7(startedAt + 1);
      const provenance = {
        originThreadId: request.threadId,
        originTurnId: turnId,
        originItemId: itemId,
      } as const;
      let item: ThreadItem;
      const createdContextRefs: ThreadContextPayloadReference[] = [];
      try {
        if (command.kind === 'clear') {
          const last = turns.flatMap((turn) => turn.items.map((candidate) => ({ turn, item: candidate }))).at(-1);
          if (!last) throw new Error('There is no context to clear.');
          item = {
            type: 'contextReset',
            id: itemId,
            provenance,
            clearedThrough: cursorFor(last.turn, last.item),
          };
        } else {
          const plan = await planContextCompaction({
            turns,
            readContext: (ref) => this.core.payloads.readContext(request.threadId, ref),
          });
          if (!plan) {
            const prior = selected.latestCompaction
              ? findItemOwner(turns, selected.latestCompaction.id)
              : null;
            if (!prior || !selected.latestCompaction) throw new Error('There is no context to compact.');
            if (request.clientUserMessageId) {
              this.bindClientInput(request.threadId, request.clientUserMessageId, prior.id, selected.latestCompaction.id);
            }
            return { turn: prior, acceptedItemId: selected.latestCompaction.id, deduplicated: true };
          }
          const summaryRef = await this.core.payloads.writeContext(request.threadId, plan.summary);
          createdContextRefs.push(summaryRef);
          const restoredStateRef = await this.core.payloads.writeContext(request.threadId, plan.restoredState);
          createdContextRefs.push(restoredStateRef);
          const instructionsPayload = command.instructions
            ? {
                schemaVersion: 1 as const,
                kind: 'compactionInstructions' as const,
                entries: [{
                  key: 'manual_compaction_instructions',
                  source: 'user',
                  authority: 'application' as const,
                  purpose: 'instruction' as const,
                  text: command.instructions,
                }],
              }
            : null;
          const instructionsRef = instructionsPayload
            ? await this.core.payloads.writeContext(request.threadId, instructionsPayload)
            : null;
          if (instructionsRef) createdContextRefs.push(instructionsRef);
          item = {
            type: 'contextCompaction',
            id: itemId,
            provenance,
            trigger: 'manual',
            coveredFrom: plan.coveredFrom,
            coveredThrough: plan.coveredThrough,
            preservedFrom: plan.preservedFrom,
            summaryRef,
            restoredStateRef,
            instructionsRef,
            contextRefs: plan.contextRefs,
            resourceRefs: [],
            outputRefs: plan.outputRefs,
          };
          assertContextPayloadDependencies(item, plan.summary);
          assertContextPayloadDependencies(item, plan.restoredState);
          if (instructionsPayload) assertContextPayloadDependencies(item, instructionsPayload);
        }

        const trigger = {
          kind: 'feature' as const,
          feature: command.kind === 'clear' ? 'context.clear' : 'context.compact',
          ...(request.clientUserMessageId ? { ref: request.clientUserMessageId } : {}),
        };
        const inProgress = decodeTurn({
          id: turnId,
          items: [item],
          itemsView: 'full',
          provenance: { originThreadId: request.threadId, originTurnId: turnId, trigger },
          status: 'inProgress',
          error: null,
          execution: initialTurnExecution(record.thread, record.configuration),
          startedAt,
          completedAt: null,
          durationMs: null,
        });
        await this.core.recordNotification({ type: 'turn/started', threadId: request.threadId, turnId, turn: inProgress });
        const completedAt = this.now();
        const completed = decodeTurn({
          ...inProgress,
          status: 'completed',
          completedAt,
          durationMs: Math.max(0, completedAt - startedAt),
        });
        await this.core.recordNotification({ type: 'turn/completed', threadId: request.threadId, turnId, turn: completed });
        if (request.clientUserMessageId) {
          this.bindClientInput(request.threadId, request.clientUserMessageId, turnId, item.id);
        }
        return { turn: completed, acceptedItemId: item.id, deduplicated: false };
      } catch (error) {
        if (createdContextRefs.length > 0) {
          await this.core.payloads.pruneUnreferencedContexts(
            request.threadId,
            this.resourceOps.threadContextPayloadReferences(request.threadId),
          ).catch(() => undefined);
        }
        throw error;
      }
    }); }
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
  async steerTurn(
    request: TurnSteerRequest,
    deliveryFailureMode: 'fatal' | 'advisory' = 'fatal',
  ): Promise<TurnSteerResponse> {
    return this.core.threadMutex.run(request.threadId, async () => {
      const existing = request.clientUserMessageId
        ? this.readCanonicalClientBinding(request.threadId, request.clientUserMessageId)
        : null;
      if (existing) {
        return { turnId: existing.turn.id, acceptedItemId: existing.itemId, deduplicated: true };
      }
      const active = this.activeTurns.get(request.threadId);
      if (!active || active.turnId !== request.expectedTurnId) throw new ThreadBusyError('Expected Turn is not active');
      if (active.finishing || active.fatalError) throw new ThreadBusyError('Expected Turn is no longer accepting steering');
      const thread = this.core.requireThread(request.threadId).thread;
      const admission = await this.resourceOps.resolveAdmissionContent(request.input, thread);
      const createdEvidenceResources: ThreadResourceReference[] = [];
      const acceptedAt = this.now();
      let item: ThreadItem;
      let admittedItems: readonly ThreadItem[];
      try {
        const extensionContext = this.core.hiddenEphemeralThreads.has(request.threadId)
          ? []
          : await this.extensions.threadContext(thread);
        const canonicalTurns = this.core.allTurns(request.threadId);
        const skillAdmission = this.core.hiddenEphemeralThreads.has(request.threadId)
          ? { catalogSnapshot: null, invocation: null }
          : await this.resolveSkillAdmission({
              thread,
              configuration: active.configuration,
              content: admission.content,
              acceptedAt,
              observedFilePaths: observedSkillFilePaths(canonicalTurns),
            });
        const skillCatalog = await planSkillCatalogEvidence({
          turns: canonicalTurns,
          snapshot: skillAdmission.catalogSnapshot,
          readContext: (ref) => this.core.payloads.readContext(thread.id, ref),
        });
        const roleCatalog = await planRoleCatalogEvidence({
          turns: canonicalTurns,
          snapshot: active.configuration.tools.includes('collaboration.spawn_agent')
            ? await this.resolveRoleCatalog(thread.cwd)
            : null,
          readContext: (ref) => this.core.payloads.readContext(thread.id, ref),
        });
        const evidence = await admitContextEvidence({
          thread,
          turnId: active.turnId,
          acceptedAt,
          content: admission.content,
          userView: request.userView,
          additionalContext: request.additionalContext,
          extensionContext,
          skillCatalog,
          roleCatalog,
          skillInvocation: skillAdmission.invocation,
          includeHostContext: !this.core.hiddenEphemeralThreads.has(request.threadId),
          projection: this.getDocumentProjection(),
          createItemId: () => uuidV7(),
          writeContext: (payload) => this.core.payloads.writeContext(thread.id, payload),
          resolveAsset: this.resolveReferencedAsset,
          writeResource: (bytes, mimeType, fileName) => this.core.payloads.writeResourceWithStatus(
            thread.id,
            bytes,
            mimeType,
            fileName,
          ),
          onResourceCreated: (ref) => createdEvidenceResources.push(ref),
        });
        item = userMessage(
          request.threadId,
          active.turnId,
          admission.content,
          request.clientUserMessageId ?? null,
          acceptedAt,
        );
        admittedItems = [...evidence.items, item];
        await active.recorder.completedImmediatelyBatch(admittedItems, acceptedAt);
      } catch (error) {
        await this.resourceOps.discardUnreferencedCreatedResources(
          thread.id,
          [...admission.createdResources, ...createdEvidenceResources],
        );
        await this.core.payloads.pruneUnreferencedContexts(
          thread.id,
          this.resourceOps.threadContextPayloadReferences(thread.id),
        );
        throw error;
      }
      try {
        if (request.clientUserMessageId) {
          this.bindClientInput(request.threadId, request.clientUserMessageId, active.turnId, item.id);
        }
        const steered = { items: admittedItems, acceptedAt };
        if (active.steeringHandler) {
          await this.enqueueSteeringDelivery(active, steered, deliveryFailureMode);
        } else {
          active.queuedSteering.push(steered);
        }
      } catch (error) {
        if (deliveryFailureMode === 'advisory') throw error;
        this.failCommittedActiveTurn(active, error);
      }
      this.collaboration.signalCollaborationActivity(request.threadId);
      return { turnId: active.turnId, acceptedItemId: item.id, deduplicated: false };
    }); }
  async interruptTurn(threadId: ThreadId, turnId: string): Promise<void> {
    await this.core.threadMutex.run(threadId, async () => {
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
    if (this.core.requireThread(threadId).thread.parentThreadId !== null) {
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
      await this.core.recordNotification({ type: 'userInput/requested', threadId, turnId, itemId, request });
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
  updateTurnPlan(threadId: ThreadId, turnId: string, inputValue: unknown): UpdatePlanToolInput {
    const input = normalizeUpdatePlanToolInput(inputValue);
    this.requireActiveTurn(threadId, turnId);
    this.core.emitTransientNotification({
      type: 'turn/plan/updated',
      threadId,
      turnId,
      ...input,
    });
    return input;
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
    if (this.core.hiddenEphemeralThreads.has(threadId)) return;
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
    if (this.core.hiddenEphemeralThreads.has(threadId)) return;
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
  async spawnChild(input: SpawnChildThreadInput): Promise<SpawnChildThreadResult> { return this.collaboration.spawnChild(input); }
  async spawnIsolatedSkillThread(input: SpawnIsolatedSkillThreadInput): Promise<SpawnChildThreadResult> { return this.collaboration.spawnIsolatedSkillThread(input); }
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
    maxTotalTokens?: number;
  }): Promise<SpawnChildThreadResult> { return this.collaboration.spawnCollaborationAgent(input); }
  private assertSubagentBudgetAvailable(threadId: ThreadId): SubagentBudgetRecord | null {
    const budget = this.subagentBudgets.read(threadId);
    if (!budget || budget.tokensUsed < budget.tokenBudget) return budget;
    throw new SubagentBudgetExhaustedError(budget.tokensUsed, budget.tokenBudget);
  }
  async sendCollaborationMessage(
    senderThreadId: ThreadId,
    senderTurnId: string,
    target: string,
    message: string,
  ): Promise<CollaborationAgentView> { return this.collaboration.sendCollaborationMessage(senderThreadId, senderTurnId, target, message); }
  async followupCollaborationTask(
    senderThreadId: ThreadId,
    senderTurnId: string,
    parentItemId: string,
    target: string,
    message: string,
  ): Promise<CollaborationAgentView> { return this.collaboration.followupCollaborationTask(senderThreadId, senderTurnId, parentItemId, target, message); }
  listCollaborationAgents(senderThreadId: ThreadId, pathPrefix?: string): readonly CollaborationAgentView[] { return this.collaboration.listCollaborationAgents(senderThreadId, pathPrefix); }
  async interruptCollaborationAgent(
    senderThreadId: ThreadId,
    senderTurnId: string,
    target: string,
  ): Promise<CollaborationAgentView> { return this.collaboration.interruptCollaborationAgent(senderThreadId, senderTurnId, target); }
  async waitForCollaborationActivity(
    senderThreadId: ThreadId,
    senderTurnId: string,
    signal?: AbortSignal,
  ): Promise<CollaborationWaitResult> { return this.collaboration.waitForCollaborationActivity(senderThreadId, senderTurnId, signal); }

  async withThreadAdmissionBarrier<T>(
    threadId: ThreadId,
    operation: (snapshot: ThreadAdmissionBarrierSnapshot) => Promise<T>,
  ): Promise<T> { return this.core.withThreadAdmissionBarrier(threadId, operation); }

  async withHostRootTurnAdmissionBarrier<T>(
    operation: (snapshot: HostRootTurnAdmissionBarrierSnapshot) => Promise<T>,
  ): Promise<T> { return this.core.withHostRootTurnAdmissionBarrier(operation); }

  private async acceptAndLaunch(
    request: InternalTurnStartRequest,
    onlyIfIdle = false,
  ): Promise<AcceptedTurn> {
    const record = this.core.requireThread(request.threadId);
    if (onlyIfIdle && record.thread.parentThreadId === null && this.core.isHostRootAdmissionBarrierActive()) {
      throw new ThreadBusyError('Root Turn admission is temporarily paused');
    }
    const accept = () => this.core.threadMutex.run(request.threadId, () => this.acceptTurn(request, onlyIfIdle));
    const accepted = record.thread.parentThreadId === null
      ? await this.core.hostRootMutex.run(accept)
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
    if (!this.core.hiddenEphemeralThreads.has(accepted.thread.id)) {
      await this.extensions.turnStarted(accepted.thread, accepted.response.turn);
    }
    await this.executeActiveTurn(accepted.active);
  }

  private async acceptTurn(
    request: InternalTurnStartRequest,
    onlyIfIdle: boolean,
  ): Promise<AcceptedTurn> {
    const record = this.core.requireThread(request.threadId);
    const existing = request.clientUserMessageId
      ? this.readCanonicalClientBinding(request.threadId, request.clientUserMessageId)
      : null;
    if (existing) {
      return {
        response: { turn: existing.turn, acceptedItemId: existing.itemId, deduplicated: true },
        thread: record.thread,
        active: null,
      };
    }
    if (request.trigger.kind !== 'user') this.assertSubagentBudgetAvailable(request.threadId);
    if (this.core.stoppingThreads.has(request.threadId)) throw new ThreadBusyError('Thread is stopping');
    if (record.archived) throw new ThreadBusyError('Thread is archived');
    if (this.activeTurns.has(request.threadId)) throw new ThreadBusyError('Thread already has an active Turn');
    if (onlyIfIdle && record.thread.status.type !== 'idle') throw new ThreadBusyError('Thread is not idle');

    const startedAt = this.now();
    const turnId = request.turnId ?? uuidV7(startedAt);
    const admission = await this.resourceOps.resolveAdmissionContent(request.input, record.thread);
    const createdEvidenceResources: ThreadResourceReference[] = [];
    try {
      return await this.commitAcceptedTurn(
        request,
        record,
        turnId,
        startedAt,
        admission.content,
        (ref) => createdEvidenceResources.push(ref),
      );
    } catch (error) {
      await this.resourceOps.discardUnreferencedCreatedResources(
        record.thread.id,
        [...admission.createdResources, ...createdEvidenceResources],
      );
      await this.core.payloads.pruneUnreferencedContexts(
        record.thread.id,
        this.resourceOps.threadContextPayloadReferences(record.thread.id),
      );
      throw error;
    }
  }

  private async commitAcceptedTurn(
    request: InternalTurnStartRequest,
    record: ThreadCatalogRecord,
    turnId: TurnId,
    startedAt: number,
    input: readonly ThreadUserContent[],
    recordCreatedEvidenceResource: (ref: ThreadResourceReference) => void,
  ): Promise<AcceptedTurn> {
    const preview = threadPreviewFromContent(input);
    const item = userMessage(request.threadId, turnId, input, request.clientUserMessageId ?? null, startedAt);
    const provenance = {
      originThreadId: request.threadId,
      originTurnId: turnId,
      trigger: request.trigger,
    } as const;
    const provisionalTurn = decodeTurn({
      id: turnId,
      items: [item],
      itemsView: 'full',
      provenance,
      status: 'inProgress',
      error: null,
      execution: initialTurnExecution(record.thread, record.configuration),
      startedAt,
      completedAt: null,
      durationMs: null,
    });
    const stagedItems = (request.stagedContextEvidence ?? []).map((staged) => {
      const stagedItem = contextEvidenceItem({
        thread: record.thread,
        turnId,
        createItemId: () => uuidV7(),
      }, staged.payload.kind, staged.payloadRef, staged.summary, staged.resourceRefs, {
        contextRefs: staged.contextRefs,
        outputRefs: staged.outputRefs,
      });
      assertContextPayloadDependencies(stagedItem, staged.payload);
      return stagedItem;
    });
    const threadBarrier = createThreadAdmissionBarrierSnapshot(
      request.threadId,
      this.core.threadBarrierGeneration(request.threadId),
    );
    const hostBarrier = createHostRootTurnAdmissionBarrierSnapshot(this.core.currentHostBarrierGeneration());
    if (!this.core.hiddenEphemeralThreads.has(request.threadId)) {
      await this.extensions.contributeAdmission({
        thread: record.thread,
        turnId,
        provenance: provisionalTurn.provenance,
        configuration: record.configuration,
        threadBarrier,
        hostBarrier,
      });
    }
    const extensionContext = this.core.hiddenEphemeralThreads.has(request.threadId)
      ? []
      : await this.extensions.threadContext(record.thread);
    const canonicalTurns = [
      ...this.core.allTurns(request.threadId),
      ...(stagedItems.length > 0 ? [{ ...provisionalTurn, items: stagedItems }] : []),
    ];
    const skillAdmission = this.core.hiddenEphemeralThreads.has(request.threadId)
      ? { catalogSnapshot: null, invocation: null }
      : await this.resolveSkillAdmission({
          thread: record.thread,
          configuration: record.configuration,
          content: input,
          acceptedAt: startedAt,
          observedFilePaths: observedSkillFilePaths(canonicalTurns),
        });
    const skillCatalog = await planSkillCatalogEvidence({
      turns: canonicalTurns,
      snapshot: skillAdmission.catalogSnapshot,
      readContext: (ref) => this.core.payloads.readContext(record.thread.id, ref),
    });
    const roleCatalog = await planRoleCatalogEvidence({
      turns: canonicalTurns,
      snapshot: record.configuration.tools.includes('collaboration.spawn_agent')
        ? await this.resolveRoleCatalog(record.thread.cwd)
        : null,
      readContext: (ref) => this.core.payloads.readContext(record.thread.id, ref),
    });
    const evidence = await admitContextEvidence({
      thread: record.thread,
      turnId,
      acceptedAt: startedAt,
      content: input,
      userView: request.userView,
      additionalContext: request.additionalContext,
      extensionContext,
      skillCatalog,
      roleCatalog,
      skillInvocation: skillAdmission.invocation,
      includeHostContext: !this.core.hiddenEphemeralThreads.has(request.threadId),
      projection: this.getDocumentProjection(),
      createItemId: () => uuidV7(),
      writeContext: (payload) => this.core.payloads.writeContext(record.thread.id, payload),
      resolveAsset: this.resolveReferencedAsset,
      writeResource: (bytes, mimeType, fileName) => this.core.payloads.writeResourceWithStatus(
        record.thread.id,
        bytes,
        mimeType,
        fileName,
      ),
      onResourceCreated: recordCreatedEvidenceResource,
    });
    const pendingSubagentActivities = this.collaboration.pendingActivities(request.threadId);
    const pendingSubagentItems = this.collaboration.materializePendingActivityItems(
      request.threadId,
      turnId,
      pendingSubagentActivities,
    );
    const initialItems = [...pendingSubagentItems, ...stagedItems, ...evidence.items, item];
    const turn = decodeTurn({ ...provisionalTurn, items: initialItems });
    const recorder = new ItemRecorder(
      request.threadId,
      turnId,
      initialItems,
      (notification) => this.core.recordNotification(notification),
    );
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
      startedAt,
      fatalError: null,
      finishing: false,
      steeringHandler: null,
      queuedSteering: [],
      steeringDelivery: Promise.resolve(),
      completion,
      resolveCompletion,
      recordedExecution: null,
      budgetUsageAccrued: false,
    };

    await this.core.recordNotification({ type: 'turn/started', threadId: request.threadId, turnId, turn });
    this.collaboration.consumePendingSubagentActivities(request.threadId, pendingSubagentActivities);
    if (!this.collaboration.hasPendingActivities(request.threadId)) {
      this.collaboration.takePendingCollaborationActivity(request.threadId);
    }
    this.activeTurns.set(request.threadId, active);
    if (!record.thread.preview.trim() && preview) {
      try {
        this.catalogOps.setInitialPreview(request.threadId, preview, startedAt);
      } catch (error) {
        this.failCommittedActiveTurn(active, error);
      }
    }
    try {
      await this.setStatus(request.threadId, { type: 'active', activeFlags: [] });
    } catch (error) {
      this.failCommittedActiveTurn(active, error);
    }
    if (request.clientUserMessageId) {
      try {
        this.bindClientInput(request.threadId, request.clientUserMessageId, turnId, item.id);
      } catch (error) {
        this.failCommittedActiveTurn(active, error);
      }
    }
    return {
      response: { turn, acceptedItemId: item.id, deduplicated: false },
      thread: this.core.requireThread(request.threadId).thread,
      active,
    };
  }

  private async executeActiveTurn(active: ActiveTurn): Promise<void> {
    let result: TurnExecutionResult = {};
    let thrown: Error | null = null;
    const initialTurn = this.core.readTurn(active.threadId, active.turnId)!;
    const thread = this.core.requireThread(active.threadId).thread;
    const budget = thread.parentThreadId === null
      ? null
      : this.subagentBudgets.read(active.threadId);
    const turnBudget = budget ? { ...budget } : null;
    const hidden = this.core.hiddenEphemeralThreads.has(active.threadId);
    const resourceObservation = this.resourceOps.createResourceObservation(active.threadId, true);
    const createdOutputResources: ThreadResourceReference[] = [];
    try {
      result = await this.executor.execute({
        thread,
        turn: initialTurn,
        historyBeforeTurn: this.core.allTurns(active.threadId).filter((turn) => turn.id !== active.turnId),
        configuration: active.configuration,
        signal: active.controller.signal,
        recorder: active.recorder,
        readContext: (ref) => this.core.payloads.readContext(active.threadId, ref),
        readOutput: (ref) => this.core.payloads.readTextReference(active.threadId, ref),
        resolveResourceObservationPath: (ref) => resourceObservation.resolvePath(ref),
        readResource: (ref) => this.core.payloads.readResource(active.threadId, ref),
        persistOutputImage: async (dataBase64, mimeType) => {
          const written = await this.core.payloads.writeImageWithStatus(active.threadId, dataBase64, mimeType);
          if (written.created) createdOutputResources.push(written.ref);
          return written.ref;
        },
        persistOutputText: (itemId, text, mimeType, summary) => this.core.payloads.writeText(
          active.threadId,
          itemId,
          text,
          mimeType,
          summary,
        ),
        persistContextEvidence: (payload, summary) => this.persistExecutionContextEvidence(
          active,
          thread,
          payload,
          summary,
        ),
        persistTurnDiagnostics: (payload) => this.core.payloads.writeTurnDiagnostics(active.threadId, payload),
        onTurnDiagnosticsError: (error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[agent] Turn diagnostics persistence failed: ${message}`);
        },
        persistSkillCatalog: (snapshot) => this.core.threadMutex.run(active.threadId, async () => {
          const catalog = await planSkillCatalogEvidence({
            turns: this.core.allTurns(active.threadId),
            snapshot,
            readContext: (ref) => this.core.payloads.readContext(active.threadId, ref),
          });
          if (!catalog) return null;
          return this.persistExecutionContextEvidenceLocked(
            active,
            thread,
            catalog,
            `Available Skills (${catalog.entries.length})`,
          );
        }),
        compactContext: async (trigger, preserveFromTurnId) => {
          const staged = await this.stageRuntimeContextCompaction(active, trigger, preserveFromTurnId);
          return staged ? await staged.commit() : null;
        },
        stageContextCompaction: (trigger, preserveFromTurnId) => this.stageRuntimeContextCompaction(
          active,
          trigger,
          preserveFromTurnId,
        ),
        onProviderRetry: (retryStatus) => this.core.emitTransientNotification({
          type: 'turn/providerRetry/changed',
          threadId: active.threadId,
          turnId: active.turnId,
          status: retryStatus,
        }),
        onSteer: (handler) => {
          active.steeringHandler = handler;
          const queued = active.queuedSteering.splice(0);
          for (const input of queued) this.enqueueSteeringDelivery(active, input);
        },
        ...(turnBudget ? {
          remainingTokenBudget: () => initialTurn.provenance.trigger.kind === 'user'
            ? null
            : { budget: turnBudget.tokenBudget, used: turnBudget.tokensUsed },
          ...(initialTurn.provenance.trigger.kind === 'user' ? {} : {
            onBudgetWarning: (actuals: { readonly used: number; readonly budget: number }) => (
              this.deliverSubagentBudgetWarning(active, actuals.used, actuals.budget)
            ),
          }),
        } : {}),
      });
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    } finally {
      await resourceObservation.dispose().catch(() => undefined);
    }
    if (result.execution) active.recordedExecution = result.execution;

    await this.core.threadMutex.run(active.threadId, async () => {
      if (this.activeTurns.get(active.threadId) === active) active.finishing = true;
    });
    await active.steeringDelivery;
    this.collaboration.takePendingCollaborationActivity(active.threadId);
    await this.collaboration.flushPendingSubagentActivities(active.threadId, active.turnId);
    if (result.refreshDiagnostics && result.execution) {
      const diagnosticsRef = await result.refreshDiagnostics();
      result = {
        ...result,
        execution: { ...result.execution, diagnosticsRef },
      };
      active.recordedExecution = result.execution ?? null;
    }
    const aborted = active.controller.signal.aborted;
    const executionError = active.fatalError ?? thrown;
    const status = executionError ? 'failed' : aborted ? 'interrupted' : result.status ?? 'completed';
    await active.recorder.finishOpenItems(status === 'completed' ? 'failed' : status);
    const completedAt = this.now();
    let turn = decodeTurn({
      id: active.turnId,
      items: active.recorder.orderedItems(),
      itemsView: 'full',
      provenance: initialTurn.provenance,
      status,
      error: executionError
        ? { message: executionError.message }
        : result.error ?? null,
      execution: result.execution ?? initialTurn.execution,
      startedAt: active.startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - active.startedAt),
    });
    const contributions = hidden ? [] : await this.extensions.turnItems(thread, turn);
    for (const contribution of contributions) {
      await active.recorder.completedImmediately(contribution.item, completedAt);
    }
    turn = decodeTurn({ ...turn, items: active.recorder.orderedItems() });

    await this.core.threadMutex.run(active.threadId, async () => {
      if (this.activeTurns.get(active.threadId) !== active) return;
      await this.core.recordNotification({
        type: 'turn/completed',
        threadId: active.threadId,
        turnId: active.turnId,
        turn,
      });
      await this.resourceOps.discardUnreferencedCreatedResources(active.threadId, createdOutputResources).catch(() => undefined);
      await this.core.payloads.pruneUnreferencedContexts(
        active.threadId,
        this.resourceOps.threadContextPayloadReferences(active.threadId),
      ).catch(() => undefined);
      await this.core.payloads.pruneUnreferencedTurnDiagnostics(
        active.threadId,
        this.resourceOps.threadTurnDiagnosticsReferences(active.threadId),
      ).catch(() => undefined);
      this.accrueSubagentBudgetUsage(active, thread, turn.execution);
      this.activeTurns.delete(active.threadId);
      await this.setStatus(active.threadId, { type: 'idle' });
    });
    this.catalogOps.scheduleAutomaticThreadName(
      this.core.requireThread(active.threadId).thread,
      turn,
      active.configuration,
    );
    if (!hidden) {
      await this.goals.addUsage(
        active.threadId,
        turn.execution.usage.totalTokens,
        Math.ceil((turn.durationMs ?? 0) / 1000),
        active.turnId,
      );
      if (status === 'interrupted') await this.extensions.turnAborted(thread, turn);
      else if (executionError) await this.extensions.turnError(thread, turn, executionError);
      else await this.extensions.turnStopped(thread, turn);
    }
    this.collaboration.queueChildTurnActivity(thread, turn);
    if (!hidden) await this.extensions.threadIdle(this.core.requireThread(active.threadId).thread);
  }
  private accrueSubagentBudgetUsage(
    active: ActiveTurn,
    thread: Thread,
    execution: Turn['execution'],
  ): void {
    if (active.budgetUsageAccrued || thread.parentThreadId === null) return;
    this.subagentBudgets.addUsage(active.threadId, execution.usage.totalTokens);
    active.budgetUsageAccrued = true;
  }
  private persistExecutionContextEvidence(
    active: ActiveTurn,
    thread: Thread,
    payload: Extract<ThreadContextPayload, { readonly kind: ContextEvidenceKind }>,
    summary: string,
  ): Promise<ContextEvidenceThreadItem> { return this.core.threadMutex.run(active.threadId, () => this.persistExecutionContextEvidenceLocked(
      active,
      thread,
      payload,
      summary,
    )); }
  private stageRuntimeContextCompaction(
    active: ActiveTurn,
    trigger: Extract<ContextCompactionThreadItem['trigger'], 'automaticPreflight' | 'providerOverflow'>,
    preserveFrom?: ContextCursor,
  ): Promise<StagedContextCompaction | null> { return this.core.threadMutex.run(active.threadId, async () => {
      const turns = this.core.allTurns(active.threadId).map((turn) => turn.id === active.turnId
        ? { ...turn, items: active.recorder.orderedItems() }
        : turn);
      const plan = await planContextCompaction({
        turns,
        preserveFrom: preserveFrom ?? firstTurnCursor(turns, active.turnId),
        readContext: (ref) => this.core.payloads.readContext(active.threadId, ref),
      });
      if (!plan) return null;
      const cleanupLocked = () => this.core.payloads.pruneUnreferencedContexts(
        active.threadId,
        this.resourceOps.threadContextPayloadReferences(active.threadId),
      ).catch(() => undefined);
      const cleanup = () => this.core.threadMutex.run(active.threadId, cleanupLocked);
      try {
        const summaryRef = await this.core.payloads.writeContext(active.threadId, plan.summary);
        const restoredStateRef = await this.core.payloads.writeContext(active.threadId, plan.restoredState);
        const id = active.recorder.createItemId();
        const item: ContextCompactionThreadItem = {
          type: 'contextCompaction',
          id,
          provenance: active.recorder.localProvenance(id),
          trigger,
          coveredFrom: plan.coveredFrom,
          coveredThrough: plan.coveredThrough,
          preservedFrom: plan.preservedFrom,
          summaryRef,
          restoredStateRef,
          instructionsRef: null,
          contextRefs: plan.contextRefs,
          resourceRefs: [],
          outputRefs: plan.outputRefs,
        };
        assertContextPayloadDependencies(item, plan.summary);
        assertContextPayloadDependencies(item, plan.restoredState);
        let state: 'staged' | 'committing' | 'committed' | 'discarded' = 'staged';
        return {
          item,
          commit: async () => {
            if (state !== 'staged') throw new Error('Context compaction is no longer staged.');
            state = 'committing';
            try {
              const committed = await this.core.threadMutex.run(active.threadId, async () => {
                if (this.activeTurns.get(active.threadId) !== active) {
                  throw new Error('Context compaction active Turn changed before commit.');
                }
                return await active.recorder.completedImmediately(
                  item,
                  this.now(),
                ) as ContextCompactionThreadItem;
              });
              state = 'committed';
              return committed;
            } catch (error) {
              state = 'discarded';
              await cleanup();
              throw error;
            }
          },
          discard: async () => {
            if (state !== 'staged') return;
            state = 'discarded';
            await cleanup();
          },
        };
      } catch (error) {
        await cleanupLocked();
        throw error;
      }
    }); }

  private async persistExecutionContextEvidenceLocked(
    active: ActiveTurn,
    thread: Thread,
    payload: Extract<ThreadContextPayload, { readonly kind: ContextEvidenceKind }>,
    summary: string,
  ): Promise<ContextEvidenceThreadItem> {
    const payloadRef = await this.core.payloads.writeContext(active.threadId, payload);
    try {
      const item = contextEvidenceItem({
        thread,
        turnId: active.turnId,
        createItemId: () => active.recorder.createItemId(),
      }, payload.kind, payloadRef, summary, [], {
        outputRefs: payload.kind === 'toolOutputProjection' ? [payload.outputRef] : [],
      });
      assertContextPayloadDependencies(item, payload);
      return await active.recorder.completedImmediately(item, this.now()) as ContextEvidenceThreadItem;
    } catch (error) {
      await this.core.payloads.pruneUnreferencedContexts(
        active.threadId,
        this.resourceOps.threadContextPayloadReferences(active.threadId),
      ).catch(() => undefined);
      throw error;
    }
  }
  private enqueueSteeringDelivery(
    active: ActiveTurn,
    input: SteeredTurnInput,
    failureMode: 'fatal' | 'advisory' = 'fatal',
  ): Promise<void> {
    const handler = active.steeringHandler;
    if (!handler) throw new Error('Steering handler is not registered');
    const delivery = active.steeringDelivery.then(async () => {
      if (!active.fatalError) await handler(input);
    });
    active.steeringDelivery = delivery
      .catch((error) => {
        if (failureMode === 'fatal') this.failCommittedActiveTurn(active, error);
      });
    return failureMode === 'advisory' ? delivery : active.steeringDelivery;
  }

  private async deliverSubagentBudgetWarning(
    active: ActiveTurn,
    used: number,
    budget: number,
  ): Promise<void> {
    await this.steerTurn({
      threadId: active.threadId,
      expectedTurnId: active.turnId,
      input: [{
        type: 'text',
        text: `[Budget notice] ~80% of the token budget is consumed (${used} of ${budget}). `
          + 'Synthesize your findings and conclude now.',
      }],
    }, 'advisory');
  }
  private failCommittedActiveTurn(active: ActiveTurn, value: unknown): void {
    if (active.fatalError) return;
    active.fatalError = value instanceof Error ? value : new Error(String(value));
    active.controller.abort();
  }

  private async failActiveTurn(active: ActiveTurn, error: Error): Promise<void> {
    await this.rejectUserInput(active.threadId, error).catch(() => undefined);
    if (this.activeTurns.get(active.threadId) !== active) {
      await this.setStatus(active.threadId, { type: 'systemError', message: error.message }).catch(() => undefined);
      return;
    }
    await active.recorder.finishOpenItems('failed').catch(() => undefined);
    const initial = this.core.readTurn(active.threadId, active.turnId);
    const thread = this.core.ephemeral.get(active.threadId)?.record.thread ?? this.core.metadata.read(active.threadId)?.thread;
    let failedTurn: Turn | null = null;
    if (initial) {
      const completedAt = this.now();
      const failed = decodeTurn({
        ...initial,
        items: active.recorder.orderedItems(),
        status: 'failed',
        error: { message: error.message, code: 'runtime_failure' },
        execution: active.recordedExecution ?? initial.execution,
        completedAt,
        durationMs: Math.max(0, completedAt - active.startedAt),
      });
      failedTurn = failed;
      await this.core.recordNotification({
        type: 'turn/completed',
        threadId: active.threadId,
        turnId: active.turnId,
        turn: failed,
      }).catch(() => undefined);
      if (!this.core.hiddenEphemeralThreads.has(active.threadId)) {
        await this.extensions.turnError(this.core.requireThread(active.threadId).thread, failed, error).catch(() => undefined);
      }
    }
    await this.core.threadMutex.run(active.threadId, async () => {
      if (thread && failedTurn) {
        try {
          this.accrueSubagentBudgetUsage(active, thread, failedTurn.execution);
        } catch (budgetError) {
          console.error('[agent] failed to accrue Subagent usage during Turn failure', budgetError);
        }
      }
      await Promise.all([
        this.core.payloads.pruneUnreferencedContexts(
          active.threadId,
          this.resourceOps.threadContextPayloadReferences(active.threadId),
        ),
        this.core.payloads.pruneUnreferencedTurnDiagnostics(
          active.threadId,
          this.resourceOps.threadTurnDiagnosticsReferences(active.threadId),
        ),
      ]).catch(() => undefined);
      if (this.activeTurns.get(active.threadId) === active) this.activeTurns.delete(active.threadId);
      await this.setStatus(active.threadId, { type: 'systemError', message: error.message }).catch(() => undefined);
    }).catch(() => undefined);
    if (thread && failedTurn) this.catalogOps.scheduleAutomaticThreadName(thread, failedTurn, active.configuration);
    if (thread && failedTurn) this.collaboration.queueChildTurnActivity(thread, failedTurn);
  }

  private async setStatus(threadId: ThreadId, status: ThreadStatus): Promise<void> {
    const now = this.now();
    const state = this.core.ephemeral.get(threadId);
    if (state) {
      state.record = {
        ...state.record,
        thread: decodeThread({ ...state.record.thread, status, updatedAt: now }),
      };
    } else {
      this.core.metadata.setStatus(threadId, status, now);
    }
    await this.core.recordNotification({ type: 'thread/status/changed', threadId, status });
  }
  private readClientBinding(threadId: ThreadId, clientId: string): { turnId: string; itemId: string } | null {
    const ephemeral = this.core.ephemeral.get(threadId);
    if (ephemeral) {
      for (const turn of ephemeral.turns) {
        const item = turn.items.find((candidate) => candidate.type === 'userMessage' && candidate.clientId === clientId);
        if (item) return { turnId: turn.id, itemId: item.id };
      }
      return null;
    }
    return this.core.metadata.readClientInput(threadId, clientId);
  }
  private readCanonicalClientBinding(
    threadId: ThreadId,
    clientId: string,
  ): { turn: Turn; itemId: string } | null {
    const binding = this.readClientBinding(threadId, clientId);
    if (binding) {
      const turn = this.core.readTurn(threadId, binding.turnId);
      const item = turn?.items.find((candidate) => (
        candidate.id === binding.itemId
        && itemMatchesClientBinding(turn, candidate, clientId)
      ));
      if (turn && item) return { turn, itemId: item.id };
      if (!this.core.ephemeral.has(threadId)) this.core.metadata.deleteClientInput(threadId, clientId);
    }
    for (const turn of this.core.allTurns(threadId)) {
      const item = turn.items.find((candidate) => (
        itemMatchesClientBinding(turn, candidate, clientId)
      ));
      if (!item) continue;
      this.bindClientInput(threadId, clientId, turn.id, item.id);
      return { turn, itemId: item.id };
    }
    return null;
  }
  private bindClientInput(threadId: ThreadId, clientId: string, turnId: string, itemId: string): void {
    if (this.core.ephemeral.has(threadId)) return;
    this.core.metadata.bindClientInput({ threadId, clientId, turnId, itemId, createdAt: this.now() });
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
      await this.core.recordNotification({
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

}

type ContextCommand =
  | { readonly kind: 'clear' }
  | { readonly kind: 'compact'; readonly instructions: string };

function parseContextCommand(input: readonly ThreadUserContent[]): ContextCommand | null {
  if (input.length !== 1 || input[0]?.type !== 'text') return null;
  const text = input[0].text.trim();
  if (text === '/clear') return { kind: 'clear' };
  const compact = /^\/compact(?:\s+([\s\S]*))?$/.exec(text);
  if (!compact) return null;
  return { kind: 'compact', instructions: compact[1]?.trim() ?? '' };
}

function hasContextSinceBoundary(turns: readonly Turn[]): boolean {
  return turns.some((turn) => turn.items.some((item) => (
    item.type !== 'contextReset'
    && item.type !== 'contextCompaction'
    && !(item.type === 'contextEvidence' && item.kind === 'toolOutputProjection')
  )));
}

function findItemOwner(turns: readonly Turn[], itemId: string): Turn | null {
  return turns.find((turn) => turn.items.some((item) => item.id === itemId)) ?? null;
}

function itemMatchesClientBinding(turn: Turn | undefined, item: ThreadItem, clientId: string): boolean {
  if (item.type === 'userMessage') return item.clientId === clientId;
  if (!turn || turn.provenance.trigger.kind !== 'feature' || turn.provenance.trigger.ref !== clientId) return false;
  return (turn.provenance.trigger.feature === 'context.clear' && item.type === 'contextReset')
    || (turn.provenance.trigger.feature === 'context.compact' && item.type === 'contextCompaction');
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
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

function missingRendererStartDefaults(): never {
  throw new Error('Thread start requires a model provider and working directory.');
}

function defaultAgentRole(name: string): AgentRole {
  const role = BUILT_IN_AGENT_ROLE_DEFINITIONS[name];
  if (!role) throw new Error(`Unknown Agent Role: ${name}`);
  return role;
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

function firstTurnCursor(turns: readonly Turn[], turnId: TurnId): ContextCursor {
  const turn = turns.find((candidate) => candidate.id === turnId);
  const item = turn?.items[0];
  if (!turn || !item) throw new Error(`Compaction preserve Turn is unreachable: ${turnId}`);
  return cursorFor(turn, item);
}

function userMessage(
  threadId: ThreadId,
  turnId: string,
  content: readonly ThreadUserContent[],
  clientId: string | null,
  acceptedAt: number,
): ThreadItem {
  const id = uuidV7();
  return decodeThreadItem({
    type: 'userMessage',
    id,
    provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: id },
    clientId,
    content,
    acceptedAt,
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
    diagnosticsRef: null,
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
