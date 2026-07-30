import { lstat, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Stats } from 'node:fs';
import type { DocumentProjection } from '../../core/types';
import {
  createHostRootTurnAdmissionBarrierSnapshot,
  createThreadAdmissionBarrierSnapshot,
  createThreadHistoryRollbackContext,
  type AgentCoreExtension,
  type HostRootTurnAdmissionBarrierSnapshot,
  type ThreadAdmissionBarrierSnapshot,
  type ThreadServiceExtensionHost,
  type ExtensionToolContribution,
  type ThreadHistoryRollbackContext,
} from '../../core/agent/extensions';
import {
  decodeAgentCoreRecordedNotification,
  decodeAgentCoreRequest,
  decodeAgentCoreResponse,
  decodeAgentCoreTransientNotification,
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
  AgentCoreRecordedNotification,
  AgentCoreTransientNotification,
  AgentCoreRequestByMethod,
  AgentCoreResponseByMethod,
  AdditionalContext,
  ContextCursor,
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
  ThreadFeatureSource,
  ThreadRollbackRequest,
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
  ThreadAttachmentContent,
  ContextEvidenceThreadItem,
  ContextCompactionThreadItem,
  InheritedContextPayload,
  ContextEvidenceKind,
  ThreadContextPayload,
  ThreadContextPayloadReference,
  ThreadContextReadRequest,
  ThreadContextReadResponse,
  ThreadTurnDetailsReadRequest,
  ThreadTurnDetailsReadResponse,
  ThreadItemOutputReference,
  ThreadResourceReference,
  RoleCatalogContextPayload,
  SkillCatalogContextPayload,
  SkillInvocationContextPayload,
  JsonValue,
  Turn,
  TurnDiagnosticsPayload,
  TurnDiagnosticsPayloadReference,
  TurnId,
  TurnInputRequest,
  TurnStartResponse,
  TurnSteerRequest,
  TurnSteerResponse,
} from '../../core/agent/protocol';
import { threadPreviewFromContent } from '../../core/agent/threadPreview';
import {
  createManagedAttachmentObservation,
  type ManagedAttachmentObservation,
} from './capabilities/agentAttachmentMaterialization';
import { ExtensionRegistry } from './ExtensionRegistry';
import { GoalExtension } from './extensions/goal/GoalExtension';
import { GoalStore } from './extensions/goal/GoalStore';
import { KeyedMutex, Mutex } from './Mutex';
import { SubagentBudgetExhaustedError } from './SubagentBudgetExhaustedError';
import {
  RolloutStore,
  type RolloutEntry,
  type ThreadHistoryRollbackMarker,
} from './persistence/RolloutStore';
import {
  SubagentBudgetLedger,
  type SubagentBudgetRecord,
} from './persistence/SubagentBudgetLedger';
import { ThreadHistoryProjectionStore } from './persistence/ThreadHistoryProjectionStore';
import {
  decodeThreadCursor,
  encodeThreadListCursor,
  threadFollowsCursor,
  ThreadMetadataStore,
  type ThreadCatalogRecord,
  type ThreadNameOrigin,
} from './persistence/ThreadMetadataStore';
import {
  referencesSameResourceFile,
  ToolPayloadStore,
} from './persistence/ToolPayloadStore';
import { openSqlite } from './persistence/sqlite';
import { ItemRecorder } from './runtime/ItemRecorder';
import { admitContextEvidence, contextEvidenceItem } from './context/evidenceAdmission';
import {
  observedSkillFilePaths,
  planSkillCatalogEvidence,
  reduceSkillContext,
} from './context/SkillContextReducer';
import { planRoleCatalogEvidence, reduceRoleContext } from './context/RoleContextReducer';
import { planContextCompaction } from './context/ContextCompaction';
import { cursorFor, selectEffectiveContext } from './context/ContextEpoch';
import { assertCanonicalUserContent } from './context/userContentIntegrity';
import {
  assertContextPayloadDependencies,
  contextPayloadReferenceKey,
  itemContextPayloadReferences,
  itemOutputReferences,
  itemResourceReferences,
  outputReferenceKey,
  resourceReferenceKey,
} from './context/contextDependencies';
import type { ReferencedAssetResolution } from './capabilities/agentReferencedAssets';
import { decodeCursor, encodeCursor, pageLimit } from './persistence/cursor';
import type {
  SteeredTurnInput,
  StagedContextCompaction,
  ThreadNameGenerator,
  TurnExecutionResult,
  TurnExecutor,
} from './runtime/types';
import { uuidV7 } from './uuid';
import {
  BUILT_IN_AGENT_ROLE_DEFINITIONS,
  defaultEffectiveThreadConfiguration,
} from './AgentConfigurationLoader';
import { applyThreadItemDelta } from './itemDelta';
import { RollbackHookRecoveryQueue, type RollbackHookRecoveryTarget } from './RollbackHookRecoveryQueue';

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

interface PendingSubagentActivity {
  readonly agentThreadId: ThreadId;
  readonly agentTurnId: TurnId;
  readonly agentPath: string;
  readonly kind: 'started' | 'completed' | 'interrupted' | 'errored';
}

interface PendingThreadNameGeneration {
  readonly turnId: string;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
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

interface StagedContextEvidence {
  readonly payload: Extract<ThreadContextPayload, { readonly kind: ContextEvidenceKind }>;
  readonly payloadRef: ThreadContextPayloadReference;
  readonly contextRefs: readonly ThreadContextPayloadReference[];
  readonly resourceRefs: readonly ThreadResourceReference[];
  readonly outputRefs: readonly ThreadItemOutputReference[];
  readonly summary: string;
}

type InternalTurnStartRequest = PrivilegedTurnStartRequest & {
  readonly stagedContextEvidence?: readonly StagedContextEvidence[];
};

type NotificationListener = (notification: AgentCoreNotification) => void;

export class ThreadService implements ThreadServiceExtensionHost {
  private readonly metadata: ThreadMetadataStore;
  private readonly history: ThreadHistoryProjectionStore;
  private readonly rollout: RolloutStore;
  private readonly payloads: ToolPayloadStore;
  private readonly attachmentScratchRoot: string;
  private readonly executor: TurnExecutor;
  private readonly nameGenerator: ThreadNameGenerator | null;
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
  private readonly getDocumentProjection: () => DocumentProjection | null;
  private readonly resolveReferencedAsset?: (assetId: string) => Promise<ReferencedAssetResolution | null>;
  private readonly resolveSkillAdmission: (
    input: SkillAdmissionResolutionInput,
  ) => Promise<SkillAdmissionResolution>;
  private readonly resolveRole: (name: string, cwd: string) => AgentRole;
  private readonly resolveRoleCatalog: (
    cwd: string,
  ) => Promise<RoleCatalogContextPayload | null>;
  private readonly resolveSubagentTokenBudget: () => Promise<number | null>;
  private readonly beforeInitialTurnAdmission: () => void | Promise<void>;
  private readonly now: () => number;
  private readonly goals: GoalExtension;
  private readonly goalStore: GoalStore;
  private readonly subagentBudgets: SubagentBudgetLedger;
  private readonly ephemeral = new Map<ThreadId, EphemeralThreadState>();
  private readonly activeTurns = new Map<ThreadId, ActiveTurn>();
  private readonly pendingThreadNames = new Map<ThreadId, PendingThreadNameGeneration>();
  private readonly pendingUserInputs = new Map<ThreadId, PendingUserInput>();
  private readonly mailbox = new Map<ThreadId, Array<{ readonly content: readonly ThreadUserContent[] }>>();
  private readonly ephemeralSpawnEdges = new Map<ThreadId, {
    sessionId: string;
    parentThreadId: ThreadId;
    taskPath: string;
    createdAt: number;
  }>();
  private readonly pendingSubagentActivities = new Map<ThreadId, PendingSubagentActivity[]>();
  private readonly detachedResourceObservations = new Map<string, {
    readonly observation: ManagedAttachmentObservation;
    readonly path: Promise<string | null>;
  }>();
  private readonly hiddenEphemeralThreads = new Set<ThreadId>();
  private readonly collaborationActivity = new Map<ThreadId, CollaborationActivityState>();
  private readonly stoppingThreads = new Set<ThreadId>();
  private readonly listeners = new Set<NotificationListener>();
  private readonly threadMutex = new KeyedMutex();
  private readonly hostRootMutex = new Mutex();
  private readonly threadTreeMutex = new Mutex();
  private readonly rollbackRecovery = new RollbackHookRecoveryQueue();
  private readonly threadBarrierGenerations = new Map<ThreadId, number>();
  private hostBarrierGeneration = 0;
  private hostRootAdmissionBarrierActive = false;
  private initialized = false;
  private closing = false;

  constructor(options: ThreadServiceOptions) {
    this.metadata = options.stores.metadata;
    this.history = options.stores.history;
    this.rollout = options.stores.rollout;
    this.payloads = options.stores.payloads;
    this.attachmentScratchRoot = options.attachmentScratchRoot;
    this.executor = options.executor;
    this.nameGenerator = options.nameGenerator ?? null;
    this.extensions = options.extensions ?? new ExtensionRegistry();
    this.resolveConfiguration = options.resolveConfiguration ?? defaultConfiguration;
    this.resolveRendererStartDefaults = options.resolveRendererStartDefaults ?? missingRendererStartDefaults;
    this.validateRendererConfiguration = options.validateRendererConfiguration ?? (() => undefined);
    this.resolveUserContent = options.resolveUserContent ?? ((content) => content);
    this.getDocumentProjection = options.getDocumentProjection ?? (() => null);
    this.resolveReferencedAsset = options.resolveReferencedAsset;
    this.resolveSkillAdmission = async (input) => await options.resolveSkillAdmission?.(input) ?? {
      catalogSnapshot: null,
      invocation: null,
    };
    this.resolveRole = options.resolveRole ?? defaultAgentRole;
    this.resolveRoleCatalog = async (cwd) => await options.resolveRoleCatalog?.(cwd) ?? null;
    this.resolveSubagentTokenBudget = async () => await options.resolveSubagentTokenBudget?.() ?? null;
    this.beforeInitialTurnAdmission = options.beforeInitialTurnAdmission ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.goalStore = options.stores.goals;
    this.subagentBudgets = options.stores.subagentBudgets;
    this.goals = new GoalExtension(this.goalStore, (notification) => this.recordNotification(notification));
    this.goals.bindHost(this, (threadId) => this.requireThread(threadId).thread);
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
    await this.payloads.initialize();
    const knownThreadIds: ThreadId[] = [];
    const resumableThreadIds: ThreadId[] = [];
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      do {
        const page = this.metadata.list({ archived, cursor, limit: 100 });
        for (const thread of page.data) {
          await this.reconcileThread(thread.id);
          knownThreadIds.push(thread.id);
          if (!archived) resumableThreadIds.push(thread.id);
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    await Promise.all(knownThreadIds.flatMap((threadId) => [
      this.payloads.pruneUnreferencedResources(threadId, this.threadResourceReferences(threadId)),
      this.payloads.pruneUnreferencedContexts(threadId, this.threadContextPayloadReferences(threadId)),
      this.payloads.pruneUnreferencedTurnDiagnostics(threadId, this.threadTurnDiagnosticsReferences(threadId)),
      this.payloads.pruneUnreferencedTextOutputs(threadId, this.threadTextPayloadReferences(threadId)),
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
        await this.extensions.threadIdle(this.requireThread(thread.id).thread);
      }
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    const active = [...this.activeTurns.values()];
    const pendingNames = [...this.pendingThreadNames.values()];
    for (const turn of active) turn.controller.abort();
    for (const pending of pendingNames) pending.controller.abort();
    for (const pending of this.pendingUserInputs.values()) pending.abort();
    await Promise.allSettled([
      ...active.map((turn) => turn.completion),
      ...pendingNames.map((pending) => pending.completion),
    ]);
    const failures: unknown[] = [];
    const operations = await Promise.allSettled([
      this.rollout.flush(),
      this.rollbackRecovery.close(),
      this.payloads.abortAllResourceUploads(),
      Promise.all([...this.ephemeral.keys()].map((threadId) => this.payloads.deleteThread(threadId))),
    ]);
    for (const result of operations) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    for (const close of [
      () => this.metadata.close(),
      () => this.history.close(),
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

  persistentRootThreads(): readonly Thread[] {
    const threads: Thread[] = [];
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      do {
        const page = this.metadata.list({ archived, cursor, limit: 100 });
        threads.push(...page.data.filter((thread) => thread.parentThreadId === null && !thread.ephemeral));
        cursor = page.nextCursor;
      } while (cursor);
    }
    return threads;
  }

  persistentThreadExecutionContext(threadId: ThreadId): PersistentThreadExecutionContext {
    const record = this.requireThread(threadId);
    if (record.thread.ephemeral || record.archived || record.thread.parentThreadId !== null) {
      throw new Error(`Automation destination must be a persistent, active root Thread: ${threadId}`);
    }
    return { thread: record.thread, configuration: record.configuration };
  }

  readTurnForHost(threadId: ThreadId, turnId: TurnId): Turn | null {
    return this.readTurn(threadId, turnId);
  }

  readTurnByClientUserMessageIdForHost(threadId: ThreadId, clientId: string): Turn | null {
    return this.readCanonicalClientBinding(threadId, clientId)?.turn ?? null;
  }

  async ensureFeatureRootThread(input: FeatureRootThreadInput): Promise<Thread> {
    return this.hostRootMutex.run(async () => {
      const existing = this.metadata.read(input.id);
      if (existing) {
        const thread = existing.thread;
        if (
          existing.archived
          || thread.ephemeral
          || thread.parentThreadId !== null
          || thread.threadSource !== input.threadSource
          || thread.cwd !== input.cwd
          || thread.modelProvider !== input.modelProvider
          || JSON.stringify(existing.configuration) !== JSON.stringify(input.configuration)
        ) {
          throw new Error(`Existing Thread does not match the feature claim: ${input.id}`);
        }
        return thread;
      }
      return this.createThread({
        id: input.id,
        name: input.name,
        ephemeral: false,
        source: input.source,
        threadSource: input.threadSource,
        modelProvider: input.modelProvider,
        cwd: input.cwd,
      }, {
        sessionId: input.id,
        parentThreadId: null,
        forkedFromId: null,
        agentRole: null,
        agentNickname: null,
        configuration: input.configuration,
        nameOrigin: 'derived',
      });
    });
  }

  activeRootUserTurns(): readonly { threadId: ThreadId; turnId: TurnId }[] {
    const result: Array<{ threadId: ThreadId; turnId: TurnId }> = [];
    for (const active of this.activeTurns.values()) {
      const thread = this.requireThread(active.threadId).thread;
      if (thread.parentThreadId === null && thread.threadSource === 'user' && !thread.ephemeral) {
        result.push({ threadId: active.threadId, turnId: active.turnId });
      }
    }
    return result;
  }

  isThreadNavigable(threadId: ThreadId): boolean {
    const ephemeral = this.ephemeral.get(threadId);
    if (ephemeral) return !ephemeral.record.archived;
    const persisted = this.metadata.read(threadId);
    return Boolean(persisted && !persisted.archived);
  }

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
    const source = this.requireThread(input.sourceThreadId);
    const configuration: EffectiveThreadConfiguration = Object.freeze({
      ...source.configuration,
      developerInstructions: Object.freeze([input.systemPrompt]),
      tools: Object.freeze([]),
      skills: Object.freeze([]),
      plugins: Object.freeze([]),
      mcpServers: Object.freeze([]),
    });
    const id = uuidV7(this.now());
    const thread = await this.createThread({
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
      const completed = this.readTurn(thread.id, accepted.turn.id);
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
    if (this.hiddenEphemeralThreads.has(threadId)) return [];
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
    const text = await this.payloads.readTextReference(request.threadId, item.outputRef);
    if (text === null) return { output: null };
    return { output: { ref: item.outputRef, text } };
  }

  async readContextPayload(request: ThreadContextReadRequest): Promise<ThreadContextReadResponse> {
    const turn = this.readTurn(request.threadId, request.turnId);
    if (!turn) return { context: null };
    const item = turn.items.find((candidate) => candidate.id === request.itemId);
    if (item?.type !== 'contextEvidence' || item.payloadRef.id !== request.contextId) {
      return { context: null };
    }
    const payload = await this.payloads.readContext(request.threadId, item.payloadRef);
    if (!payload) return { context: null };
    assertContextPayloadDependencies(item, payload);
    return { context: { ref: item.payloadRef, payload } };
  }

  async readTurnDetails(request: ThreadTurnDetailsReadRequest): Promise<ThreadTurnDetailsReadResponse> {
    const thread = this.requireThread(request.threadId).thread;
    const turn = this.readTurn(request.threadId, request.turnId);
    if (!turn) throw new Error(`Unknown Turn: ${request.turnId}`);
    const ref = turn.execution.diagnosticsRef;
    if (!ref) return { thread, turn, diagnostics: null };
    const payload = await this.payloads.readTurnDiagnostics(request.threadId, ref).catch(() => null);
    if (!payload) {
      return {
        thread,
        turn: decodeTurn({ ...turn, execution: { ...turn.execution, diagnosticsRef: null } }),
        diagnostics: null,
      };
    }
    return { thread, turn, diagnostics: { ref, payload } };
  }

  async beginAttachmentUpload(input: {
    readonly threadId: ThreadId;
    readonly attachmentId: string;
    readonly expectedBytes: number;
    readonly mimeType: string;
    readonly fileName: string;
  }): Promise<string> {
    this.requireThread(input.threadId);
    return this.payloads.beginResourceUpload(input);
  }

  async appendAttachmentUpload(input: {
    readonly threadId: ThreadId;
    readonly attachmentId: string;
    readonly uploadId: string;
    readonly bytes: Uint8Array;
  }): Promise<void> {
    this.requireThread(input.threadId);
    await this.payloads.appendResourceUpload(
      input.threadId,
      input.attachmentId,
      input.uploadId,
      input.bytes,
    );
  }

  async finishAttachmentUpload(input: {
    readonly threadId: ThreadId;
    readonly attachmentId: string;
    readonly uploadId: string;
  }): Promise<ThreadResourceReference> {
    this.requireThread(input.threadId);
    return this.payloads.finishResourceUpload(input.threadId, input.attachmentId, input.uploadId);
  }

  async abortAttachmentUpload(input: {
    readonly threadId: ThreadId;
    readonly attachmentId: string;
    readonly uploadId: string;
  }): Promise<void> {
    await this.payloads.abortResourceUpload(input.threadId, input.attachmentId, input.uploadId);
  }

  async writeThreadResource(
    threadId: ThreadId,
    bytes: Uint8Array,
    mimeType: string,
    fileName: string,
  ): Promise<ThreadResourceReference> {
    this.requireThread(threadId);
    return this.payloads.writeResource(threadId, bytes, mimeType, fileName);
  }

  async writeThreadResourceWithStatus(
    threadId: ThreadId,
    bytes: Uint8Array,
    mimeType: string,
    fileName: string,
  ): Promise<{ readonly ref: ThreadResourceReference; readonly created: boolean }> {
    this.requireThread(threadId);
    return this.payloads.writeResourceWithStatus(threadId, bytes, mimeType, fileName);
  }

  async useThreadResourcePath<T>(
    threadId: ThreadId,
    ref: ThreadResourceReference,
    use: (path: string) => Promise<T>,
  ): Promise<T | null> {
    this.requireThread(threadId);
    return this.payloads.useResourcePath(threadId, ref, use);
  }

  async readThreadResource(
    threadId: ThreadId,
    ref: ThreadResourceReference,
  ): Promise<Buffer | null> {
    this.requireThread(threadId);
    return this.payloads.readResource(threadId, ref);
  }

  async readReferencedThreadResource(
    threadId: ThreadId,
    ref: ThreadResourceReference,
  ): Promise<Buffer | null> {
    this.requireThread(threadId);
    if (!this.threadResourceReferences(threadId).some((candidate) => (
      resourceReferenceKey(candidate) === resourceReferenceKey(ref)
    ))) {
      return null;
    }
    return this.payloads.readResource(threadId, ref);
  }

  async discardUnreferencedThreadResource(
    threadId: ThreadId,
    ref: ThreadResourceReference,
  ): Promise<boolean> {
    return this.threadMutex.run(threadId, async () => {
      this.requireThread(threadId);
      if (this.threadResourceReferences(threadId).some((candidate) => referencesSameResourceFile(candidate, ref))) {
        return false;
      }
      return this.payloads.deleteResource(threadId, ref);
    });
  }

  async resolveAttachmentFile(
    threadId: ThreadId,
    attachmentId: string,
  ): Promise<ResolvedThreadAttachmentFile | null> {
    this.requireThread(threadId);
    const matches = this.allTurns(threadId).flatMap((turn) => turn.items.flatMap((item) => (
      item.type === 'userMessage'
        ? item.content.flatMap((content) => (
            content.type === 'attachment' && content.id === attachmentId ? [content] : []
          ))
        : []
    )));
    if (matches.length === 0) return null;
    const attachment = matches[0]!;
    if (matches.some((candidate) => !attachmentSourcesEqual(candidate, attachment))) return null;
    const storedPath = attachment.source.kind === 'localFile'
      ? attachment.source.path
      : await this.detachedResourceObservationPath(
          threadId,
          `attachment:${attachmentId}`,
          attachment.source.ref,
        );
    if (!storedPath) return null;
    if (attachment.source.kind === 'threadPayload') {
      const storedStats = await lstat(storedPath).catch(() => null);
      if (!storedStats?.isFile() || storedStats.isSymbolicLink() || storedStats.nlink !== 1) {
        await this.discardDetachedResourceObservation(threadId, `attachment:${attachmentId}`);
        return null;
      }
    }
    const canonicalPath = await realpath(storedPath).catch(() => null);
    if (!canonicalPath) {
      if (attachment.source.kind === 'threadPayload') {
        await this.discardDetachedResourceObservation(threadId, `attachment:${attachmentId}`);
      }
      return null;
    }
    if (attachment.source.kind === 'threadPayload' && canonicalPath !== storedPath) {
      await this.discardDetachedResourceObservation(threadId, `attachment:${attachmentId}`);
      return null;
    }
    if (attachment.source.kind === 'localFile' && canonicalPath !== attachment.source.path) return null;
    const fileStats = await stat(canonicalPath).catch(() => null);
    const entryKind = fileStats?.isFile() ? 'file' : fileStats?.isDirectory() ? 'directory' : null;
    if (!fileStats || !entryKind) {
      if (attachment.source.kind === 'threadPayload') {
        await this.discardDetachedResourceObservation(threadId, `attachment:${attachmentId}`);
      }
      return null;
    }
    // Managed copies remain available to Preview/Open/Reveal until scratch TTL cleanup.
    return { attachment, entryKind, path: canonicalPath, stats: fileStats };
  }

  async resolveThreadResourceFile(
    threadId: ThreadId,
    ref: ThreadResourceReference,
  ): Promise<ResolvedThreadResourceFile | null> {
    this.requireThread(threadId);
    if (!this.threadResourceReferences(threadId).some((candidate) => (
      resourceReferenceKey(candidate) === resourceReferenceKey(ref)
    ))) {
      return null;
    }
    const identity = `resource:${ref.id}:${ref.fileName}`;
    const storedPath = await this.detachedResourceObservationPath(threadId, identity, ref);
    if (!storedPath) return null;
    const storedStats = await lstat(storedPath).catch(() => null);
    if (!storedStats?.isFile() || storedStats.isSymbolicLink() || storedStats.nlink !== 1) {
      await this.discardDetachedResourceObservation(threadId, identity);
      return null;
    }
    const canonicalPath = await realpath(storedPath).catch(() => null);
    if (!canonicalPath || canonicalPath !== storedPath) {
      await this.discardDetachedResourceObservation(threadId, identity);
      return null;
    }
    const fileStats = await stat(canonicalPath).catch(() => null);
    if (!fileStats?.isFile()) {
      await this.discardDetachedResourceObservation(threadId, identity);
      return null;
    }
    return { entryKind: 'file', path: canonicalPath, stats: fileStats, ref };
  }

  private async detachedResourceObservationPath(
    threadId: ThreadId,
    identity: string,
    ref: ThreadResourceReference,
  ): Promise<string | null> {
    const available = await this.payloads.useResourcePath(threadId, ref, async () => true);
    if (!available) {
      await this.discardDetachedResourceObservation(threadId, identity);
      return null;
    }
    const key = `${threadId}\0${identity}`;
    let entry = this.detachedResourceObservations.get(key);
    if (!entry) {
      const observation = this.createResourceObservation(threadId);
      entry = { observation, path: observation.resolvePath(ref) };
      this.detachedResourceObservations.set(key, entry);
    }
    try {
      const path = await entry.path;
      if (!path && this.detachedResourceObservations.get(key) === entry) {
        this.detachedResourceObservations.delete(key);
        await entry.observation.dispose();
      }
      return path;
    } catch (error) {
      if (this.detachedResourceObservations.get(key) === entry) {
        this.detachedResourceObservations.delete(key);
        await entry.observation.dispose();
      }
      throw error;
    }
  }

  private async discardDetachedResourceObservation(
    threadId: ThreadId,
    identity: string,
  ): Promise<void> {
    const key = `${threadId}\0${identity}`;
    const entry = this.detachedResourceObservations.get(key);
    if (!entry) return;
    this.detachedResourceObservations.delete(key);
    await entry.observation.dispose();
  }

  private createResourceObservation(
    threadId: ThreadId,
    stableProviderPath = false,
  ): ManagedAttachmentObservation {
    return createManagedAttachmentObservation(
      this.attachmentScratchRoot,
      (ref, targetDirectory) => this.payloads.copyResourceForObservation(
        threadId,
        ref,
        targetDirectory,
      ),
      stableProviderPath ? { stableWorkspaceKey: threadId } : {},
    );
  }

  private threadResourceReferences(threadId: ThreadId): ThreadResourceReference[] {
    return this.allTurns(threadId).flatMap((turn) => turn.items.flatMap(itemResourceReferences));
  }

  private threadContextPayloadReferences(threadId: ThreadId): ThreadContextPayloadReference[] {
    return this.allTurns(threadId).flatMap((turn) => turn.items.flatMap(itemContextPayloadReferences));
  }

  private threadTurnDiagnosticsReferences(threadId: ThreadId): TurnDiagnosticsPayloadReference[] {
    return this.allTurns(threadId).flatMap((turn) => (
      turn.execution.diagnosticsRef ? [turn.execution.diagnosticsRef] : []
    ));
  }

  private threadTextPayloadReferences(threadId: ThreadId): ThreadItemOutputReference[] {
    return this.allTurns(threadId).flatMap((turn) => turn.items.flatMap((item) => [
      ...('outputRef' in item && item.outputRef ? [item.outputRef] : []),
      ...(item.type === 'contextEvidence' || item.type === 'contextCompaction' ? item.outputRefs : []),
    ]));
  }

  private async resolveAdmissionContent(
    content: readonly ThreadUserContent[],
    thread: Thread,
  ): Promise<{
    readonly content: readonly ThreadUserContent[];
    readonly createdResources: readonly ThreadResourceReference[];
  }> {
    const createdResources: ThreadResourceReference[] = [];
    try {
      const resolved = await this.resolveUserContent(content, {
        threadId: thread.id,
        cwd: thread.cwd,
        recordCreatedResource: (ref) => createdResources.push(ref),
      });
      assertCanonicalUserContent(resolved);
      return { content: resolved, createdResources };
    } catch (error) {
      await this.discardUnreferencedCreatedResources(thread.id, createdResources);
      throw error;
    }
  }

  private async discardUnreferencedCreatedResources(
    threadId: ThreadId,
    resources: readonly ThreadResourceReference[],
  ): Promise<void> {
    const referenced = this.threadResourceReferences(threadId);
    const unique = resources.filter((ref, index) => (
      resources.findIndex((candidate) => referencesSameResourceFile(candidate, ref)) === index
      && !referenced.some((candidate) => referencesSameResourceFile(candidate, ref))
    ));
    await Promise.all(unique.map((ref) => this.payloads.deleteResource(threadId, ref)));
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
      .filter((state) => !this.hiddenEphemeralThreads.has(state.record.thread.id))
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
      const name = request.name ?? this.nextForkName(source);
      const thread = await this.createThread({
        name,
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
        nameOrigin: request.name === undefined ? 'derived' : 'manual',
      });
      try {
        const copiedTurns = inherited.map((turn) => copyTurn(turn, now));
        const cursorMap = forkedCursorMap(inherited, copiedTurns);
        for (let index = 0; index < copiedTurns.length; index += 1) {
          copiedTurns[index] = rewriteForkedContextCursors(copiedTurns[index]!, cursorMap);
          copiedTurns[index] = await this.copyForkedTurnPayloads(
            source.id,
            thread.id,
            inherited[index]!,
            copiedTurns[index]!,
          );
        }
        for (const copied of copiedTurns) {
          await this.recordNotification({
            type: 'turn/completed',
            threadId: thread.id,
            turnId: copied.id,
            turn: copied,
          });
        }
      } catch (error) {
        await this.deleteThread(thread.id);
        throw error;
      }
      return { thread: this.requireThread(thread.id).thread };
    }));
  }

  private async copyForkedTurnPayloads(
    sourceThreadId: ThreadId,
    targetThreadId: ThreadId,
    sourceTurn: Turn,
    copiedTurn: Turn,
  ): Promise<Turn> {
    let diagnosticsRef = copiedTurn.execution.diagnosticsRef;
    if (diagnosticsRef) {
      try {
        const payload = await this.payloads.readTurnDiagnostics(sourceThreadId, diagnosticsRef);
        if (!payload) {
          diagnosticsRef = null;
        } else {
          const itemIds = new Map(sourceTurn.items.map((item, index) => [item.id, copiedTurn.items[index]!.id]));
          diagnosticsRef = await this.payloads.writeTurnDiagnostics(
            targetThreadId,
            rewriteForkedTurnDiagnostics(payload, itemIds),
          );
        }
      } catch {
        diagnosticsRef = null;
      }
    }
    for (const item of copiedTurn.items) {
      for (const ref of itemResourceReferences(item)) {
        const copied = await this.payloads.copyResourceToThread(sourceThreadId, targetThreadId, ref);
        if (!copied) throw new Error(`Missing managed resource payload: ${ref.id}`);
      }
      if (item.type === 'contextEvidence' || item.type === 'contextCompaction') {
        const directContextRefs = item.type === 'contextEvidence'
          ? [item.payloadRef]
          : [item.summaryRef, item.restoredStateRef, ...(item.instructionsRef ? [item.instructionsRef] : [])];
        for (const ref of directContextRefs) {
          const payload = await this.payloads.readContext(sourceThreadId, ref);
          if (!payload) throw new Error(`Missing context payload: ${ref.id}`);
          assertContextPayloadDependencies(item, payload);
        }
        for (const ref of itemContextPayloadReferences(item)) {
          const payloadCopied = await this.payloads.copyContextToThread(sourceThreadId, targetThreadId, ref);
          if (!payloadCopied) throw new Error(`Missing context payload: ${ref.id}`);
        }
        for (const ref of item.outputRefs) {
          const outputCopied = await this.payloads.copyTextToThread(sourceThreadId, targetThreadId, ref);
          if (!outputCopied) throw new Error(`Missing context tool output payload: ${ref.id}`);
        }
      }
      if ('outputRef' in item && item.outputRef) {
        const payloadCopied = await this.payloads.copyTextToThread(
          sourceThreadId,
          targetThreadId,
          item.outputRef,
        );
        if (!payloadCopied) throw new Error(`Missing tool output payload: ${item.outputRef.id}`);
      }
    }
    return diagnosticsRef === copiedTurn.execution.diagnosticsRef
      ? copiedTurn
      : decodeTurn({ ...copiedTurn, execution: { ...copiedTurn.execution, diagnosticsRef } });
  }

  async rollbackThread(request: ThreadRollbackRequest): Promise<{ thread: Thread }> {
    return this.threadMutex.run(request.threadId, async () => {
      const record = this.requireThread(request.threadId);
      const thread = record.thread;
      if (thread.ephemeral || thread.parentThreadId !== null || thread.threadSource !== 'user') {
        throw new Error('History rollback is available only for persistent root user Threads');
      }
      if (record.archived || this.stoppingThreads.has(thread.id)) {
        throw new ThreadBusyError('Cannot roll back an archived or stopping Thread');
      }
      if (this.activeTurns.has(thread.id) || thread.status.type !== 'idle') {
        throw new ThreadBusyError('Cannot roll back a Thread with an active Turn');
      }
      const turns = this.allTurns(thread.id);
      if (request.numTurns > turns.length) {
        throw new Error('History rollback exceeds the current Turn count');
      }
      const omitted = turns.slice(-request.numTurns);
      if (omitted.some((turn) => turn.status === 'inProgress')) {
        throw new ThreadBusyError('History rollback requires terminal Turns');
      }
      const beforeProjectionVersion = this.history.projectionVersion(thread.id);
      const context = createThreadHistoryRollbackContext(
        uuidV7(this.now()),
        thread.id,
        omitted.map((turn) => turn.id),
        beforeProjectionVersion,
        beforeProjectionVersion + 1,
      );
      const prepared: AgentCoreExtension[] = [];
      try {
        for (const extension of this.extensions.historyRollbackExtensions()) {
          await this.extensions.invokeHistoryRollbackHook(extension, 'prepare', context);
          prepared.push(extension);
        }
      } catch (error) {
        await this.finalizeHistoryRollbackHooks([...prepared].reverse(), 'abort', context);
        throw error;
      }

      let markerEntry: RolloutEntry | undefined;
      try {
        markerEntry = await this.rollout.appendHistoryRollback(context, this.now());
      } catch (error) {
        markerEntry = (await this.rollout.read(thread.id)).find((entry) => (
          entry.event.type === 'history/rollback' && entry.event.rollbackId === context.rollbackId
        ));
        if (!markerEntry) {
          await this.finalizeHistoryRollbackHooks([...prepared].reverse(), 'abort', context);
          throw error;
        }
      }
      let projectionError: unknown = null;
      try {
        this.history.apply(markerEntry);
      } catch {
        try {
          this.history.rebuildThread(thread.id, await this.rollout.read(thread.id));
        } catch (error) {
          projectionError = error;
        }
      }
      await this.finalizeHistoryRollbackHooks(prepared, 'commit', context);
      if (projectionError) throw projectionError;
      // The rollback marker is already durable. Orphan cleanup is retried at startup
      // and must not turn a committed rollback into a reported operation failure.
      await Promise.all([
        this.payloads.pruneUnreferencedResources(thread.id, this.threadResourceReferences(thread.id)),
        this.payloads.pruneUnreferencedContexts(thread.id, this.threadContextPayloadReferences(thread.id)),
        this.payloads.pruneUnreferencedTurnDiagnostics(
          thread.id,
          this.threadTurnDiagnosticsReferences(thread.id),
        ),
        this.payloads.pruneUnreferencedTextOutputs(thread.id, this.threadTextPayloadReferences(thread.id)),
      ]).catch(() => undefined);
      if (request.numTurns === turns.length) this.clearAutomaticThreadName(thread.id);
      return { thread: this.requireThread(thread.id).thread };
    });
  }

  historyProjectionVersion(threadId: ThreadId): number {
    this.requireThread(threadId);
    return this.history.projectionVersion(threadId);
  }

  hasHistoryRollbackMarker(rollbackId: string): boolean {
    return this.history.hasRollbackMarker(rollbackId);
  }

  historyRollbackMarker(rollbackId: string): ThreadHistoryRollbackMarker | null {
    return this.history.rollbackMarker(rollbackId);
  }

  async setThreadName(threadId: ThreadId, name: string | null): Promise<void> {
    this.pendingThreadNames.get(threadId)?.controller.abort();
    await this.threadMutex.run(threadId, async () => {
      const state = this.ephemeral.get(threadId);
      if (state) {
        state.record = {
          ...state.record,
          nameOrigin: 'manual',
          thread: decodeThread({ ...state.record.thread, name }),
        };
      } else {
        this.metadata.setManualName(threadId, name);
      }
      this.emitTransientNotification({
        type: 'thread/name/updated',
        threadId,
        ...(name === null ? {} : { threadName: name }),
      });
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
        if (this.hiddenEphemeralThreads.has(record.thread.id)) continue;
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
        this.subagentBudgets.clear(descendantId);
        this.history.deleteThread(descendantId);
        await this.rollout.delete(descendantId);
        await this.payloads.deleteThread(descendantId);
      }
      for (const record of [...subtree.records].reverse()) {
        if (this.hiddenEphemeralThreads.has(record.thread.id)) continue;
        await this.extensions.threadStopped(record.thread);
      }
      await this.threadTreeMutex.run(async () => {
        if (subtree.records[0]?.thread.ephemeral) {
          for (const descendantId of [...subtree.threadIds].reverse()) {
            this.ephemeralSpawnEdges.delete(descendantId);
            this.ephemeral.delete(descendantId);
            this.hiddenEphemeralThreads.delete(descendantId);
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
    const pendingNames = threadIds.flatMap((id) => {
      const pending = this.pendingThreadNames.get(id);
      if (!pending) return [];
      pending.controller.abort();
      return [pending];
    });
    for (const id of threadIds) {
      await this.threadMutex.run(id, async () => {
        this.activeTurns.get(id)?.controller.abort();
        this.pendingUserInputs.get(id)?.abort();
      });
    }
    await Promise.all([
      ...threadIds.map((id) => this.waitForIdle(id)),
      ...pendingNames.map((pending) => pending.completion),
    ]);
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
    const contextCommand = parseContextCommand(request.input);
    if (contextCommand) return this.startContextCommand(request, contextCommand);
    const privileged: PrivilegedTurnStartRequest = { ...request, trigger: { kind: 'user' } };
    return (await this.acceptAndLaunch(privileged)).response;
  }

  private async startContextCommand(
    request: RendererTurnStartRequest,
    command: ContextCommand,
  ): Promise<TurnStartResponse> {
    return this.threadMutex.run(request.threadId, async () => {
      const record = this.requireThread(request.threadId);
      const existing = request.clientUserMessageId
        ? this.readCanonicalClientBinding(request.threadId, request.clientUserMessageId)
        : null;
      if (existing) return { turn: existing.turn, acceptedItemId: existing.itemId, deduplicated: true };
      if (this.stoppingThreads.has(request.threadId)) throw new ThreadBusyError('Thread is stopping');
      if (record.archived) throw new ThreadBusyError('Thread is archived');
      if (this.activeTurns.has(request.threadId)) throw new ThreadBusyError('Thread already has an active Turn');
      if (record.thread.status.type !== 'idle') throw new ThreadBusyError('Thread is not idle');

      const turns = this.allTurns(request.threadId);
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
            readContext: (ref) => this.payloads.readContext(request.threadId, ref),
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
          const summaryRef = await this.payloads.writeContext(request.threadId, plan.summary);
          createdContextRefs.push(summaryRef);
          const restoredStateRef = await this.payloads.writeContext(request.threadId, plan.restoredState);
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
            ? await this.payloads.writeContext(request.threadId, instructionsPayload)
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
        await this.recordNotification({ type: 'turn/started', threadId: request.threadId, turnId, turn: inProgress });
        const completedAt = this.now();
        const completed = decodeTurn({
          ...inProgress,
          status: 'completed',
          completedAt,
          durationMs: Math.max(0, completedAt - startedAt),
        });
        await this.recordNotification({ type: 'turn/completed', threadId: request.threadId, turnId, turn: completed });
        if (request.clientUserMessageId) {
          this.bindClientInput(request.threadId, request.clientUserMessageId, turnId, item.id);
        }
        return { turn: completed, acceptedItemId: item.id, deduplicated: false };
      } catch (error) {
        if (createdContextRefs.length > 0) {
          await this.payloads.pruneUnreferencedContexts(
            request.threadId,
            this.threadContextPayloadReferences(request.threadId),
          ).catch(() => undefined);
        }
        throw error;
      }
    });
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
      const existing = request.clientUserMessageId
        ? this.readCanonicalClientBinding(request.threadId, request.clientUserMessageId)
        : null;
      if (existing) {
        return { turnId: existing.turn.id, acceptedItemId: existing.itemId, deduplicated: true };
      }
      const active = this.activeTurns.get(request.threadId);
      if (!active || active.turnId !== request.expectedTurnId) throw new ThreadBusyError('Expected Turn is not active');
      if (active.finishing || active.fatalError) throw new ThreadBusyError('Expected Turn is no longer accepting steering');
      const thread = this.requireThread(request.threadId).thread;
      const admission = await this.resolveAdmissionContent(request.input, thread);
      const createdEvidenceResources: ThreadResourceReference[] = [];
      const acceptedAt = this.now();
      let item: ThreadItem;
      let admittedItems: readonly ThreadItem[];
      try {
        const extensionContext = this.hiddenEphemeralThreads.has(request.threadId)
          ? []
          : await this.extensions.threadContext(thread);
        const canonicalTurns = this.allTurns(request.threadId);
        const skillAdmission = this.hiddenEphemeralThreads.has(request.threadId)
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
          readContext: (ref) => this.payloads.readContext(thread.id, ref),
        });
        const roleCatalog = await planRoleCatalogEvidence({
          turns: canonicalTurns,
          snapshot: active.configuration.tools.includes('collaboration.spawn_agent')
            ? await this.resolveRoleCatalog(thread.cwd)
            : null,
          readContext: (ref) => this.payloads.readContext(thread.id, ref),
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
          includeHostContext: !this.hiddenEphemeralThreads.has(request.threadId),
          projection: this.getDocumentProjection(),
          createItemId: () => uuidV7(),
          writeContext: (payload) => this.payloads.writeContext(thread.id, payload),
          resolveAsset: this.resolveReferencedAsset,
          writeResource: (bytes, mimeType, fileName) => this.payloads.writeResourceWithStatus(
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
        await this.discardUnreferencedCreatedResources(
          thread.id,
          [...admission.createdResources, ...createdEvidenceResources],
        );
        await this.payloads.pruneUnreferencedContexts(
          thread.id,
          this.threadContextPayloadReferences(thread.id),
        );
        throw error;
      }
      try {
        if (request.clientUserMessageId) {
          this.bindClientInput(request.threadId, request.clientUserMessageId, active.turnId, item.id);
        }
        const steered = { items: admittedItems, acceptedAt };
        if (active.steeringHandler) {
          await this.enqueueSteeringDelivery(active, steered);
        } else {
          active.queuedSteering.push(steered);
        }
      } catch (error) {
        this.failCommittedActiveTurn(active, error);
      }
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

  updateTurnPlan(threadId: ThreadId, turnId: string, inputValue: unknown): UpdatePlanToolInput {
    const input = normalizeUpdatePlanToolInput(inputValue);
    this.requireActiveTurn(threadId, turnId);
    this.emitTransientNotification({
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
    if (this.hiddenEphemeralThreads.has(threadId)) return;
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
    if (this.hiddenEphemeralThreads.has(threadId)) return;
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
    const parentBudget = this.assertSubagentBudgetAvailable(input.parentThreadId);
    const tokenBudget = await this.childTokenBudget(input.maxTotalTokens, parentBudget);
    let stagedThreadId: ThreadId | null = null;
    let result: SpawnChildThreadResult;
    try {
      result = await this.threadTreeMutex.run(async () => {
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
        source: input.childKind === 'isolatedSkill' ? 'agent.skill' : 'collaboration',
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
      stagedThreadId = thread.id;
      if (tokenBudget !== null) {
        this.subagentBudgets.create(thread.id, tokenBudget, thread.ephemeral);
      }
      const stagedContextEvidence = input.inheritedContext
        ? [await this.copyInheritedContextToChild(input.parentThreadId, thread.id, input.inheritedContext)]
        : [];
      const accepted = await this.acceptAndLaunch({
        threadId: thread.id,
        input: [{ type: 'text', text: input.prompt }],
        trigger: {
          kind: 'subagent',
          parentThreadId: parent.thread.id,
          parentItemId: input.parentItemId,
        },
        ...(input.additionalContext === undefined ? {} : { additionalContext: input.additionalContext }),
        ...(stagedContextEvidence.length === 0 ? {} : { stagedContextEvidence }),
      });
      return { thread, turn: accepted.response.turn, taskPath: input.taskPath };
      });
    } catch (error) {
      if (stagedThreadId) await this.deleteThread(stagedThreadId).catch(() => undefined);
      throw error;
    }
    if (result.thread.source === 'collaboration') {
      await this.recordSubagentActivity(
        input.parentThreadId,
        input.parentTurnId,
        result.thread.id,
        result.taskPath,
        'started',
      );
    }
    return result;
  }

  private async copyInheritedContextToChild(
    sourceThreadId: ThreadId,
    targetThreadId: ThreadId,
    payload: InheritedContextPayload,
  ): Promise<StagedContextEvidence> {
    const contextRefs = uniqueContextReferences(payload.turns.flatMap((turn) => (
      turn.items.flatMap(itemContextPayloadReferences)
    )));
    const resourceRefs = uniqueResourceReferences(payload.turns.flatMap((turn) => (
      turn.items.flatMap(itemResourceReferences)
    )));
    const outputRefs = uniqueOutputReferences(payload.turns.flatMap((turn) => (
      turn.items.flatMap(itemOutputReferences)
    )));
    for (const ref of contextRefs) {
      if (!await this.payloads.copyContextToThread(sourceThreadId, targetThreadId, ref)) {
        throw new Error(`Missing inherited context payload: ${ref.id}`);
      }
    }
    for (const ref of resourceRefs) {
      if (!await this.payloads.copyResourceToThread(sourceThreadId, targetThreadId, ref)) {
        throw new Error(`Missing inherited managed resource: ${ref.id}`);
      }
    }
    for (const ref of outputRefs) {
      if (!await this.payloads.copyTextToThread(sourceThreadId, targetThreadId, ref)) {
        throw new Error(`Missing inherited tool output: ${ref.id}`);
      }
    }
    const payloadRef = await this.payloads.writeContext(targetThreadId, payload);
    return {
      payload,
      payloadRef,
      contextRefs,
      resourceRefs,
      outputRefs,
      summary: `Inherited parent context (${payload.turns.length} Turns)`,
    };
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
      childKind: 'isolatedSkill',
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
    maxTotalTokens?: number;
  }): Promise<SpawnChildThreadResult> {
    this.requireActiveTurn(input.senderThreadId, input.senderTurnId);
    if (!/^[a-z][a-z0-9_]*$/.test(input.taskName)) {
      throw new Error('Subagent task_name must use lowercase letters, digits, and underscores');
    }
    const parentPath = this.taskPathForThread(input.senderThreadId) ?? '/root';
    const taskPath = `${parentPath}/${input.taskName}`;
    const sessionId = this.requireThread(input.senderThreadId).thread.sessionId;
    if (this.findSpawnEdgeByPath(sessionId, taskPath)) throw new Error(`Subagent task path already exists: ${taskPath}`);
    const inheritedContext = await collaborationInheritedContext({
      turns: this.allTurns(input.senderThreadId),
      sourceThreadId: input.senderThreadId,
      activeTurnId: input.senderTurnId,
      spawnItemId: input.parentItemId,
      forkTurns: input.forkTurns,
      readContext: (ref) => this.payloads.readContext(input.senderThreadId, ref),
    });
    const result = await this.spawnChild({
      parentThreadId: input.senderThreadId,
      parentTurnId: input.senderTurnId,
      parentItemId: input.parentItemId,
      prompt: input.message,
      taskPath,
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      ...(input.maxTotalTokens === undefined ? {} : { maxTotalTokens: input.maxTotalTokens }),
      ...(inheritedContext === null ? {} : { inheritedContext }),
    });
    return result;
  }

  private async childTokenBudget(
    maxTotalTokens: number | undefined,
    parentBudget: SubagentBudgetRecord | null,
  ): Promise<number | null> {
    if (maxTotalTokens !== undefined) {
      if (!Number.isSafeInteger(maxTotalTokens) || maxTotalTokens < 1) {
        throw new Error('max_total_tokens must be a positive integer');
      }
      return maxTotalTokens;
    }
    const tokenBudget = await this.resolveSubagentTokenBudget();
    if (tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1)) {
      throw new Error('subagentTokenBudget must be a positive integer or null');
    }
    if (!parentBudget) return tokenBudget;
    const remaining = parentBudget.tokenBudget - parentBudget.tokensUsed;
    return tokenBudget === null ? remaining : Math.min(tokenBudget, remaining);
  }

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
  ): Promise<CollaborationAgentView> {
    this.requireActiveTurn(senderThreadId, senderTurnId);
    const targetThread = this.resolveCollaborationTarget(senderThreadId, target);
    const content = [{ type: 'text' as const, text: nonEmpty(message, 'message') }];
    const active = this.activeTurns.get(targetThread.id);
    if (active) {
      await this.steerTurn({ threadId: targetThread.id, expectedTurnId: active.turnId, input: content });
    } else {
      this.assertSubagentBudgetAvailable(targetThread.id);
      const queued = this.mailbox.get(targetThread.id) ?? [];
      queued.push({ content });
      this.mailbox.set(targetThread.id, queued);
    }
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
    const content = [{ type: 'text' as const, text: nonEmpty(message, 'message') }];
    const active = this.activeTurns.get(targetThread.id);
    if (active) {
      await this.steerTurn({ threadId: targetThread.id, expectedTurnId: active.turnId, input: content });
    } else {
      this.assertSubagentBudgetAvailable(targetThread.id);
      const queued = this.mailbox.get(targetThread.id) ?? [];
      this.mailbox.delete(targetThread.id);
      try {
        await this.startPrivilegedTurn({
          threadId: targetThread.id,
          input: [...queued.flatMap((entry) => entry.content), ...content],
          trigger: {
            kind: 'subagent',
            parentThreadId: senderThreadId,
            parentItemId,
          },
        });
      } catch (error) {
        if (queued.length > 0) {
          this.mailbox.set(targetThread.id, [...queued, ...(this.mailbox.get(targetThread.id) ?? [])]);
        }
        throw error;
      }
    }
    return this.collaborationView(targetThread.id);
  }

  listCollaborationAgents(senderThreadId: ThreadId, pathPrefix?: string): readonly CollaborationAgentView[] {
    const sender = this.requireThread(senderThreadId).thread;
    const senderPath = this.taskPathForThread(senderThreadId) ?? '/root';
    const descendantPrefix = `${senderPath}/`;
    const persisted = this.metadata.childEdges(rootThreadId(sender, (id) => this.requireThread(id).thread), true);
    const ephemeral = [...this.ephemeralSpawnEdges.entries()].map(([childThreadId, edge]) => ({ childThreadId, ...edge }));
    return [...persisted, ...ephemeral]
      .filter((edge) => this.requireThread(edge.childThreadId).thread.sessionId === sender.sessionId)
      .filter((edge) => edge.taskPath.startsWith(descendantPrefix))
      .filter((edge) => this.isCollaborationDescendant(senderThreadId, edge.childThreadId))
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
    signal?: AbortSignal,
  ): Promise<CollaborationWaitResult> {
    this.requireActiveTurn(senderThreadId, senderTurnId);
    if (signal?.aborted) throw new Error('Collaboration wait was interrupted');

    if ((this.pendingSubagentActivities.get(senderThreadId)?.length ?? 0) > 0) {
      this.takePendingCollaborationActivity(senderThreadId);
      const activities = await this.flushPendingSubagentActivities(senderThreadId, senderTurnId);
      return this.collaborationWaitResult(senderThreadId, 'terminal', activities);
    }
    if (this.takePendingCollaborationActivity(senderThreadId)) {
      return this.collaborationWaitResult(senderThreadId, 'steering', []);
    }
    const agents = this.listCollaborationAgents(senderThreadId);
    if (!agents.some((agent) => (
      agent.parentThreadId === senderThreadId
      && (agent.status === 'pendingInit' || agent.status === 'running')
    ))) {
      return {
        reason: 'idle',
        updates: agents.flatMap((agent) => (
          agent.status === 'completed' || agent.status === 'interrupted' || agent.status === 'errored'
            ? [this.collaborationTerminalOutcome(agent.threadId, agent.taskPath, agent.status)]
            : []
        )),
        agents,
      };
    }

    const state = this.collaborationActivityState(senderThreadId);
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        state.waiters.delete(done);
        signal?.removeEventListener('abort', aborted);
        resolve();
      };
      const aborted = () => {
        state.waiters.delete(done);
        reject(new Error('Collaboration wait was interrupted'));
      };
      state.waiters.add(done);
      signal?.addEventListener('abort', aborted, { once: true });
    });
    this.takePendingCollaborationActivity(senderThreadId);
    const activities = await this.flushPendingSubagentActivities(senderThreadId, senderTurnId);
    return this.collaborationWaitResult(
      senderThreadId,
      activities.length > 0 ? 'terminal' : 'steering',
      activities,
    );
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

  private async acceptAndLaunch(
    request: InternalTurnStartRequest,
    onlyIfIdle = false,
  ): Promise<AcceptedTurn> {
    const record = this.requireThread(request.threadId);
    if (onlyIfIdle && record.thread.parentThreadId === null && this.hostRootAdmissionBarrierActive) {
      throw new ThreadBusyError('Root Turn admission is temporarily paused');
    }
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
    if (!this.hiddenEphemeralThreads.has(accepted.thread.id)) {
      await this.extensions.turnStarted(accepted.thread, accepted.response.turn);
    }
    await this.executeActiveTurn(accepted.active);
  }

  private async acceptTurn(
    request: InternalTurnStartRequest,
    onlyIfIdle: boolean,
  ): Promise<AcceptedTurn> {
    const record = this.requireThread(request.threadId);
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
    if (this.stoppingThreads.has(request.threadId)) throw new ThreadBusyError('Thread is stopping');
    if (record.archived) throw new ThreadBusyError('Thread is archived');
    if (this.activeTurns.has(request.threadId)) throw new ThreadBusyError('Thread already has an active Turn');
    if (onlyIfIdle && record.thread.status.type !== 'idle') throw new ThreadBusyError('Thread is not idle');

    const startedAt = this.now();
    const turnId = request.turnId ?? uuidV7(startedAt);
    const admission = await this.resolveAdmissionContent(request.input, record.thread);
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
      await this.discardUnreferencedCreatedResources(
        record.thread.id,
        [...admission.createdResources, ...createdEvidenceResources],
      );
      await this.payloads.pruneUnreferencedContexts(
        record.thread.id,
        this.threadContextPayloadReferences(record.thread.id),
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
      this.threadBarrierGenerations.get(request.threadId) ?? 0,
    );
    const hostBarrier = createHostRootTurnAdmissionBarrierSnapshot(this.hostBarrierGeneration);
    if (!this.hiddenEphemeralThreads.has(request.threadId)) {
      await this.extensions.contributeAdmission({
        thread: record.thread,
        turnId,
        provenance: provisionalTurn.provenance,
        configuration: record.configuration,
        threadBarrier,
        hostBarrier,
      });
    }
    const extensionContext = this.hiddenEphemeralThreads.has(request.threadId)
      ? []
      : await this.extensions.threadContext(record.thread);
    const canonicalTurns = [
      ...this.allTurns(request.threadId),
      ...(stagedItems.length > 0 ? [{ ...provisionalTurn, items: stagedItems }] : []),
    ];
    const skillAdmission = this.hiddenEphemeralThreads.has(request.threadId)
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
      readContext: (ref) => this.payloads.readContext(record.thread.id, ref),
    });
    const roleCatalog = await planRoleCatalogEvidence({
      turns: canonicalTurns,
      snapshot: record.configuration.tools.includes('collaboration.spawn_agent')
        ? await this.resolveRoleCatalog(record.thread.cwd)
        : null,
      readContext: (ref) => this.payloads.readContext(record.thread.id, ref),
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
      includeHostContext: !this.hiddenEphemeralThreads.has(request.threadId),
      projection: this.getDocumentProjection(),
      createItemId: () => uuidV7(),
      writeContext: (payload) => this.payloads.writeContext(record.thread.id, payload),
      resolveAsset: this.resolveReferencedAsset,
      writeResource: (bytes, mimeType, fileName) => this.payloads.writeResourceWithStatus(
        record.thread.id,
        bytes,
        mimeType,
        fileName,
      ),
      onResourceCreated: recordCreatedEvidenceResource,
    });
    const pendingSubagentActivities = [
      ...(this.pendingSubagentActivities.get(request.threadId) ?? []),
    ];
    const pendingSubagentItems = pendingSubagentActivities.map((activity) => (
      subagentActivityItem(request.threadId, turnId, activity)
    ));
    const initialItems = [...pendingSubagentItems, ...stagedItems, ...evidence.items, item];
    const turn = decodeTurn({ ...provisionalTurn, items: initialItems });
    const recorder = new ItemRecorder(
      request.threadId,
      turnId,
      initialItems,
      (notification) => this.recordNotification(notification),
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

    await this.recordNotification({ type: 'turn/started', threadId: request.threadId, turnId, turn });
    this.consumePendingSubagentActivities(request.threadId, pendingSubagentActivities);
    if (!this.pendingSubagentActivities.has(request.threadId)) {
      this.takePendingCollaborationActivity(request.threadId);
    }
    this.activeTurns.set(request.threadId, active);
    if (!record.thread.preview.trim() && preview) {
      try {
        this.setInitialPreview(request.threadId, preview, startedAt);
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
      thread: this.requireThread(request.threadId).thread,
      active,
    };
  }

  private async executeActiveTurn(active: ActiveTurn): Promise<void> {
    let result: TurnExecutionResult = {};
    let thrown: Error | null = null;
    const initialTurn = this.readTurn(active.threadId, active.turnId)!;
    const thread = this.requireThread(active.threadId).thread;
    const budget = thread.parentThreadId === null
      ? null
      : this.subagentBudgets.read(active.threadId);
    const turnBudget = budget ? {
      ...budget,
      remaining: Math.max(0, budget.tokenBudget - budget.tokensUsed),
    } : null;
    const hidden = this.hiddenEphemeralThreads.has(active.threadId);
    const resourceObservation = this.createResourceObservation(active.threadId, true);
    const createdOutputResources: ThreadResourceReference[] = [];
    try {
      result = await this.executor.execute({
        thread,
        turn: initialTurn,
        historyBeforeTurn: this.allTurns(active.threadId).filter((turn) => turn.id !== active.turnId),
        configuration: active.configuration,
        signal: active.controller.signal,
        recorder: active.recorder,
        readContext: (ref) => this.payloads.readContext(active.threadId, ref),
        readOutput: (ref) => this.payloads.readTextReference(active.threadId, ref),
        resolveResourceObservationPath: (ref) => resourceObservation.resolvePath(ref),
        readResource: (ref) => this.payloads.readResource(active.threadId, ref),
        persistOutputImage: async (dataBase64, mimeType) => {
          const written = await this.payloads.writeImageWithStatus(active.threadId, dataBase64, mimeType);
          if (written.created) createdOutputResources.push(written.ref);
          return written.ref;
        },
        persistOutputText: (itemId, text, mimeType, summary) => this.payloads.writeText(
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
        persistTurnDiagnostics: (payload) => this.payloads.writeTurnDiagnostics(active.threadId, payload),
        onTurnDiagnosticsError: (error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[agent] Turn diagnostics persistence failed: ${message}`);
        },
        persistSkillCatalog: (snapshot) => this.threadMutex.run(active.threadId, async () => {
          const catalog = await planSkillCatalogEvidence({
            turns: this.allTurns(active.threadId),
            snapshot,
            readContext: (ref) => this.payloads.readContext(active.threadId, ref),
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
        onProviderRetry: (retryStatus) => this.emitTransientNotification({
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
          remainingTokenBudget: () => turnBudget.remaining,
          onBudgetWarning: () => this.deliverSubagentBudgetWarning(
            active,
            turnBudget.tokensUsed + Math.ceil(turnBudget.remaining * 0.8),
            turnBudget.tokenBudget,
          ),
        } : {}),
      });
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    } finally {
      await resourceObservation.dispose().catch(() => undefined);
    }
    if (result.execution) active.recordedExecution = result.execution;

    await this.threadMutex.run(active.threadId, async () => {
      if (this.activeTurns.get(active.threadId) === active) active.finishing = true;
    });
    await active.steeringDelivery;
    this.takePendingCollaborationActivity(active.threadId);
    await this.flushPendingSubagentActivities(active.threadId, active.turnId);
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

    await this.threadMutex.run(active.threadId, async () => {
      if (this.activeTurns.get(active.threadId) !== active) return;
      await this.recordNotification({
        type: 'turn/completed',
        threadId: active.threadId,
        turnId: active.turnId,
        turn,
      });
      await this.discardUnreferencedCreatedResources(active.threadId, createdOutputResources).catch(() => undefined);
      await this.payloads.pruneUnreferencedContexts(
        active.threadId,
        this.threadContextPayloadReferences(active.threadId),
      ).catch(() => undefined);
      await this.payloads.pruneUnreferencedTurnDiagnostics(
        active.threadId,
        this.threadTurnDiagnosticsReferences(active.threadId),
      ).catch(() => undefined);
      this.accrueSubagentBudgetUsage(active, thread, turn.execution);
      this.activeTurns.delete(active.threadId);
      await this.setStatus(active.threadId, { type: 'idle' });
    });
    this.scheduleAutomaticThreadName(
      this.requireThread(active.threadId).thread,
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
    this.queueChildTurnActivity(thread, turn);
    if (!hidden) await this.extensions.threadIdle(this.requireThread(active.threadId).thread);
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
  ): Promise<ContextEvidenceThreadItem> {
    return this.threadMutex.run(active.threadId, () => this.persistExecutionContextEvidenceLocked(
      active,
      thread,
      payload,
      summary,
    ));
  }

  private stageRuntimeContextCompaction(
    active: ActiveTurn,
    trigger: Extract<ContextCompactionThreadItem['trigger'], 'automaticPreflight' | 'providerOverflow'>,
    preserveFrom?: ContextCursor,
  ): Promise<StagedContextCompaction | null> {
    return this.threadMutex.run(active.threadId, async () => {
      const turns = this.allTurns(active.threadId).map((turn) => turn.id === active.turnId
        ? { ...turn, items: active.recorder.orderedItems() }
        : turn);
      const plan = await planContextCompaction({
        turns,
        preserveFrom: preserveFrom ?? firstTurnCursor(turns, active.turnId),
        readContext: (ref) => this.payloads.readContext(active.threadId, ref),
      });
      if (!plan) return null;
      const cleanupLocked = () => this.payloads.pruneUnreferencedContexts(
        active.threadId,
        this.threadContextPayloadReferences(active.threadId),
      ).catch(() => undefined);
      const cleanup = () => this.threadMutex.run(active.threadId, cleanupLocked);
      try {
        const summaryRef = await this.payloads.writeContext(active.threadId, plan.summary);
        const restoredStateRef = await this.payloads.writeContext(active.threadId, plan.restoredState);
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
              const committed = await this.threadMutex.run(active.threadId, async () => {
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
    });
  }

  private async persistExecutionContextEvidenceLocked(
    active: ActiveTurn,
    thread: Thread,
    payload: Extract<ThreadContextPayload, { readonly kind: ContextEvidenceKind }>,
    summary: string,
  ): Promise<ContextEvidenceThreadItem> {
    const payloadRef = await this.payloads.writeContext(active.threadId, payload);
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
      await this.payloads.pruneUnreferencedContexts(
        active.threadId,
        this.threadContextPayloadReferences(active.threadId),
      ).catch(() => undefined);
      throw error;
    }
  }

  private enqueueSteeringDelivery(active: ActiveTurn, input: SteeredTurnInput): Promise<void> {
    const handler = active.steeringHandler;
    if (!handler) throw new Error('Steering handler is not registered');
    active.steeringDelivery = active.steeringDelivery
      .then(async () => {
        if (!active.fatalError) await handler(input);
      })
      .catch((error) => {
        this.failCommittedActiveTurn(active, error);
      });
    return active.steeringDelivery;
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
    });
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
    const initial = this.readTurn(active.threadId, active.turnId);
    const thread = this.ephemeral.get(active.threadId)?.record.thread ?? this.metadata.read(active.threadId)?.thread;
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
      await this.recordNotification({
        type: 'turn/completed',
        threadId: active.threadId,
        turnId: active.turnId,
        turn: failed,
      }).catch(() => undefined);
      if (!this.hiddenEphemeralThreads.has(active.threadId)) {
        await this.extensions.turnError(this.requireThread(active.threadId).thread, failed, error).catch(() => undefined);
      }
    }
    await this.threadMutex.run(active.threadId, async () => {
      if (thread && failedTurn) {
        try {
          this.accrueSubagentBudgetUsage(active, thread, failedTurn.execution);
        } catch (budgetError) {
          console.error('[agent] failed to accrue Subagent usage during Turn failure', budgetError);
        }
      }
      await Promise.all([
        this.payloads.pruneUnreferencedContexts(
          active.threadId,
          this.threadContextPayloadReferences(active.threadId),
        ),
        this.payloads.pruneUnreferencedTurnDiagnostics(
          active.threadId,
          this.threadTurnDiagnosticsReferences(active.threadId),
        ),
      ]).catch(() => undefined);
      if (this.activeTurns.get(active.threadId) === active) this.activeTurns.delete(active.threadId);
      await this.setStatus(active.threadId, { type: 'systemError', message: error.message }).catch(() => undefined);
    }).catch(() => undefined);
    if (thread && failedTurn) this.scheduleAutomaticThreadName(thread, failedTurn, active.configuration);
    if (thread && failedTurn) this.queueChildTurnActivity(thread, failedTurn);
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
      nameOrigin?: ThreadNameOrigin;
      hidden?: boolean;
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
      nameOrigin: lineage.nameOrigin ?? (thread.name === null ? 'none' : 'manual'),
      archived: false,
      configuration,
      toolCeiling: lineage.toolCeiling ?? null,
      modelOverride: lineage.modelOverride ?? null,
      reasoningEffortOverride: lineage.reasoningEffortOverride ?? null,
    };
    if (thread.ephemeral) {
      this.ephemeral.set(thread.id, { record, turns: [], completedItemIds: new Set() });
      if (lineage.hidden) this.hiddenEphemeralThreads.add(thread.id);
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
    if (!this.hiddenEphemeralThreads.has(thread.id)) await this.extensions.threadStarted(thread);
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

  private nextForkName(source: Thread): string {
    const sourceRecord = this.requireThread(source.id);
    const displayed = source.name?.trim() || source.preview.trim() || 'Untitled Thread';
    const base = sourceRecord.nameOrigin === 'derived'
      ? displayed.replace(/\s+\(([1-9]\d*)\)$/, '').trim() || displayed
      : displayed;
    const names = source.ephemeral
      ? this.ephemeralForkFamilyNames(source.id)
      : this.metadata.forkFamilyNames(source.id);
    let highest = 0;
    for (const candidateValue of names) {
      const candidate = candidateValue?.trim();
      if (!candidate) continue;
      if (candidate === base) {
        highest = Math.max(highest, 0);
        continue;
      }
      if (!candidate.startsWith(`${base} (`) || !candidate.endsWith(')')) continue;
      const suffix = candidate.slice(base.length + 2, -1);
      const index = Number(suffix);
      if (/^[1-9]\d*$/.test(suffix) && Number.isSafeInteger(index)) highest = Math.max(highest, index);
    }
    return `${base} (${highest + 1})`;
  }

  private ephemeralForkFamilyNames(threadId: ThreadId): readonly (string | null)[] {
    let root = this.requireThread(threadId).thread;
    const visited = new Set<ThreadId>();
    while (root.forkedFromId) {
      if (visited.has(root.id)) throw new Error('Thread fork lineage contains a cycle');
      visited.add(root.id);
      root = this.requireThread(root.forkedFromId).thread;
    }
    const family = [root.id];
    for (let index = 0; index < family.length; index += 1) {
      const parentId = family[index]!;
      for (const [candidateId, state] of this.ephemeral) {
        if (state.record.thread.forkedFromId === parentId) family.push(candidateId);
      }
    }
    return family.map((id) => this.requireThread(id).thread.name);
  }

  private scheduleAutomaticThreadName(
    thread: Thread,
    turn: Turn,
    configuration: EffectiveThreadConfiguration,
  ): void {
    if (
      !this.nameGenerator
      || this.closing
      || this.stoppingThreads.has(thread.id)
      || thread.ephemeral
      || thread.parentThreadId !== null
      || thread.threadSource !== 'user'
      || turn.status === 'inProgress'
      || turn.provenance.trigger.kind !== 'user'
      || this.pendingThreadNames.has(thread.id)
    ) return;
    const record = this.requireThread(thread.id);
    const turns = this.allTurns(thread.id);
    if (record.thread.name !== null || record.nameOrigin !== 'none' || turns.length !== 1 || turns[0]?.id !== turn.id) {
      return;
    }
    const controller = new AbortController();
    let pending!: PendingThreadNameGeneration;
    const completion = Promise.resolve()
      .then(() => this.generateAutomaticThreadName(thread.id, turn, configuration, controller.signal))
      .catch((error) => {
        if (!controller.signal.aborted) console.warn('[agent] automatic Thread name generation failed', error);
      })
      .finally(() => {
        if (this.pendingThreadNames.get(thread.id) === pending) this.pendingThreadNames.delete(thread.id);
      });
    pending = { turnId: turn.id, controller, completion };
    this.pendingThreadNames.set(thread.id, pending);
  }

  private async generateAutomaticThreadName(
    threadId: ThreadId,
    turn: Turn,
    configuration: EffectiveThreadConfiguration,
    signal: AbortSignal,
  ): Promise<void> {
    const thread = this.requireThread(threadId).thread;
    const name = await this.nameGenerator!.generateName({ thread, turn, configuration, signal });
    if (!name || signal.aborted) return;
    await this.threadMutex.run(threadId, async () => {
      if (
        signal.aborted
        || this.stoppingThreads.has(threadId)
        || this.pendingThreadNames.get(threadId)?.turnId !== turn.id
      ) return;
      const record = this.requireThread(threadId);
      const turns = this.allTurns(threadId);
      if (
        record.thread.name !== null
        || record.nameOrigin !== 'none'
        || turns.length !== 1
        || turns[0]?.id !== turn.id
        || turns[0]?.status === 'inProgress'
      ) return;
      if (!this.metadata.setAutomaticNameIfEligible(threadId, name)) return;
      this.emitTransientNotification({ type: 'thread/name/updated', threadId, threadName: name });
    });
  }

  private clearAutomaticThreadName(threadId: ThreadId): void {
    if (!this.metadata.clearAutomaticName(threadId)) return;
    this.emitTransientNotification({ type: 'thread/name/updated', threadId });
  }

  private async recordNotification(notification: AgentCoreRecordedNotification): Promise<void> {
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

  private emitTransientNotification(notification: AgentCoreTransientNotification): void {
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

  private applyEphemeralNotification(notification: AgentCoreRecordedNotification): void {
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

  private readCanonicalClientBinding(
    threadId: ThreadId,
    clientId: string,
  ): { turn: Turn; itemId: string } | null {
    const binding = this.readClientBinding(threadId, clientId);
    if (binding) {
      const turn = this.readTurn(threadId, binding.turnId);
      const item = turn?.items.find((candidate) => (
        candidate.id === binding.itemId
        && itemMatchesClientBinding(turn, candidate, clientId)
      ));
      if (turn && item) return { turn, itemId: item.id };
      if (!this.ephemeral.has(threadId)) this.metadata.deleteClientInput(threadId, clientId);
    }
    for (const turn of this.allTurns(threadId)) {
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
    if (!this.isCollaborationDescendant(senderThreadId, thread.id)) {
      throw new Error('Subagent target is outside the sender collaboration subtree');
    }
    return thread;
  }

  private isCollaborationDescendant(senderThreadId: ThreadId, childThreadId: ThreadId): boolean {
    const visited = new Set<ThreadId>();
    let current = this.requireThread(childThreadId).thread;
    while (current.parentThreadId !== null && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.source !== 'collaboration') return false;
      if (current.parentThreadId === senderThreadId) return true;
      current = this.requireThread(current.parentThreadId).thread;
    }
    return false;
  }

  private collaborationView(threadId: ThreadId): CollaborationAgentView {
    const thread = this.requireThread(threadId).thread;
    const edge = this.ephemeralSpawnEdges.get(threadId) ?? this.metadata.spawnEdgeForChild(threadId);
    if (!edge || !thread.parentThreadId) throw new Error(`Thread is not a Subagent: ${threadId}`);
    const budget = this.subagentBudgets.read(threadId);
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
      tokensUsed: budget?.tokensUsed ?? 0,
      tokenBudget: budget?.tokenBudget ?? null,
    };
  }

  private collaborationWaitResult(
    senderThreadId: ThreadId,
    reason: CollaborationWaitResult['reason'],
    activities: readonly PendingSubagentActivity[],
  ): CollaborationWaitResult {
    return {
      reason,
      updates: activities.flatMap((activity) => activity.kind === 'started'
        ? []
        : [this.collaborationTerminalOutcome(
            activity.agentThreadId,
            activity.agentPath,
            activity.kind === 'errored' ? 'errored' : activity.kind,
            activity.agentTurnId,
          )]),
      agents: this.listCollaborationAgents(senderThreadId),
    };
  }

  private collaborationTerminalOutcome(
    threadId: ThreadId,
    taskPath: string,
    status: CollaborationTerminalOutcome['status'],
    turnId?: TurnId,
  ): CollaborationTerminalOutcome {
    const terminalTurn = turnId === undefined
      ? this.allTurns(threadId).at(-1)
      : this.readTurn(threadId, turnId);
    const result = terminalTurn?.items
      .flatMap((item) => item.type === 'agentMessage' && item.phase !== 'commentary'
        ? [item.text.trim()]
        : [])
      .filter(Boolean)
      .join('\n\n') ?? '';
    return {
      taskPath,
      threadId,
      status,
      result: result || null,
      error: terminalTurn?.error?.message ?? null,
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

  private queueChildTurnActivity(thread: Thread, turn: Turn): void {
    if (!thread.parentThreadId || thread.source !== 'collaboration') return;
    const agentPath = this.taskPathForThread(thread.id);
    if (!agentPath) return;
    const kind: PendingSubagentActivity['kind'] = turn.status === 'completed'
      ? 'completed'
      : turn.status === 'interrupted'
        ? 'interrupted'
        : 'errored';
    const queued = this.pendingSubagentActivities.get(thread.parentThreadId) ?? [];
    queued.push({ agentThreadId: thread.id, agentTurnId: turn.id, agentPath, kind });
    this.pendingSubagentActivities.set(thread.parentThreadId, queued);
    this.signalCollaborationActivity(thread.parentThreadId);
  }

  private async flushPendingSubagentActivities(
    threadId: ThreadId,
    turnId: string,
  ): Promise<readonly PendingSubagentActivity[]> {
    const queued = this.pendingSubagentActivities.get(threadId);
    if (!queued || queued.length === 0) return [];
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
    return queued;
  }

  private consumePendingSubagentActivities(
    threadId: ThreadId,
    consumed: readonly PendingSubagentActivity[],
  ): void {
    if (consumed.length === 0) return;
    const queued = this.pendingSubagentActivities.get(threadId);
    if (!queued) return;
    const consumedSet = new Set(consumed);
    const remaining = queued.filter((activity) => !consumedSet.has(activity));
    if (remaining.length > 0) this.pendingSubagentActivities.set(threadId, remaining);
    else this.pendingSubagentActivities.delete(threadId);
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
    for (const marker of this.history.rollbackMarkers(threadId)) {
      await this.finalizeHistoryRollbackHooks(this.extensions.historyRollbackExtensions(), 'commit', marker);
    }
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
    if (record.nameOrigin === 'automatic' && this.allTurns(threadId).length === 0) {
      this.clearAutomaticThreadName(threadId);
    }
    if (record.thread.status.type === 'active') await this.setStatus(threadId, { type: 'idle' });
  }

  private async finalizeHistoryRollbackHooks(
    extensions: readonly AgentCoreExtension[],
    target: RollbackHookRecoveryTarget,
    context: ThreadHistoryRollbackContext,
  ): Promise<void> {
    for (const extension of extensions) {
      try {
        await this.extensions.invokeHistoryRollbackHook(extension, target, context);
      } catch {
        this.rollbackRecovery.enqueue({
          extensionId: extension.id,
          rollbackId: context.rollbackId,
          target,
          run: () => this.extensions.invokeHistoryRollbackHook(extension, target, context),
        });
      }
    }
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

async function collaborationInheritedContext(input: {
  readonly turns: readonly Turn[];
  readonly sourceThreadId: ThreadId;
  readonly activeTurnId: TurnId;
  readonly spawnItemId: string;
  readonly forkTurns?: string;
  readonly readContext: (
    ref: ThreadContextPayloadReference,
  ) => Promise<ThreadContextPayload | null>;
}): Promise<InheritedContextPayload | null> {
  const requestedTurns = parseForkTurns(input.forkTurns);
  const epoch = turnsAfterLatestReset(input.turns);
  const activeIndex = epoch.findIndex((turn) => turn.id === input.activeTurnId);
  if (activeIndex < 0) throw new Error('Active parent Turn is outside the current context epoch');
  const active = epoch[activeIndex]!;
  const spawnIndex = active.items.findIndex((item) => item.id === input.spawnItemId);
  if (spawnIndex < 0) throw new Error('Subagent spawn Item is outside the active parent Turn');
  const spawnItem = active.items[spawnIndex]!;
  if (spawnItem.type !== 'collabAgentToolCall' || spawnItem.tool !== 'spawn_agent') {
    throw new Error('Subagent spawn boundary does not reference a spawn_agent Item');
  }
  if (requestedTurns === 'none') return null;
  const prefix = [
    ...epoch.slice(0, activeIndex),
    { ...active, items: active.items.slice(0, spawnIndex) },
  ].flatMap((turn) => {
    const items = turn.items.filter((item) => !('status' in item) || item.status !== 'inProgress');
    if (items.length === 0) return [];
    return [{
      ...turn,
      items,
      status: turn.status === 'inProgress' ? 'completed' as const : turn.status,
      completedAt: turn.completedAt ?? turn.startedAt,
      durationMs: turn.durationMs ?? 0,
    }];
  });
  if (prefix.length === 0) return null;
  let start = requestedTurns === 'all' ? 0 : Math.max(0, prefix.length - requestedTurns);
  start = await expandForContextDependencies(prefix, start, input.readContext);
  const selected = prefix.slice(start);
  const lastTurn = selected.at(-1)!;
  const lastItem = lastTurn.items.at(-1)!;
  return {
    schemaVersion: 1,
    kind: 'inheritedContext',
    sourceThreadId: input.sourceThreadId,
    coveredThrough: cursorFor(lastTurn, lastItem),
    requestedTurns,
    turns: selected,
  };
}

async function expandForContextDependencies(
  turns: readonly Turn[],
  initialStart: number,
  readContext: (
    ref: ThreadContextPayloadReference,
  ) => Promise<ThreadContextPayload | null>,
): Promise<number> {
  let start = expandForCompactionCursors(turns, initialStart);
  for (;;) {
    try {
      const selected = turns.slice(start);
      await Promise.all([
        reduceSkillContext(selected, readContext),
        reduceRoleContext(selected, readContext),
      ]);
      return start;
    } catch (error) {
      const kind = catalogJournalBoundaryKind(error);
      if (start === 0 || kind === null) throw error;
      const preceding = previousCatalogStateTurn(turns, start, kind);
      if (preceding < 0) throw error;
      start = expandForCompactionCursors(turns, preceding);
    }
  }
}

function catalogJournalBoundaryKind(
  error: unknown,
): Extract<ContextEvidenceKind, 'skillCatalog' | 'roleCatalog'> | null {
  if (!(error instanceof Error)) return null;
  if (error.message === 'Skill catalog journal does not continue from the canonical catalog hash.') {
    return 'skillCatalog';
  }
  if (error.message === 'Role catalog journal does not continue from the canonical catalog hash.') {
    return 'roleCatalog';
  }
  return null;
}

function previousCatalogStateTurn(
  turns: readonly Turn[],
  start: number,
  kind: Extract<ContextEvidenceKind, 'skillCatalog' | 'roleCatalog'>,
): number {
  for (let index = start - 1; index >= 0; index -= 1) {
    if (turns[index]!.items.some((item) => (
      item.type === 'contextCompaction'
      || (item.type === 'contextEvidence' && (
        item.kind === kind || item.kind === 'inheritedContext'
      ))
    ))) return index;
  }
  return -1;
}

function firstTurnCursor(turns: readonly Turn[], turnId: TurnId): ContextCursor {
  const turn = turns.find((candidate) => candidate.id === turnId);
  const item = turn?.items[0];
  if (!turn || !item) throw new Error(`Compaction preserve Turn is unreachable: ${turnId}`);
  return cursorFor(turn, item);
}

function parseForkTurns(value = 'all'): 'none' | 'all' | number {
  const normalized = value.trim() || 'all';
  if (normalized === 'none' || normalized === 'all') return normalized;
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error('fork_turns must be none, all, or a positive integer string');
  }
  const count = Number(normalized);
  if (!Number.isSafeInteger(count)) throw new Error('fork_turns is outside the safe integer range');
  return count;
}

function turnsAfterLatestReset(turns: readonly Turn[]): Turn[] {
  let resetTurnIndex = -1;
  let resetItemIndex = -1;
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    for (let itemIndex = 0; itemIndex < turns[turnIndex]!.items.length; itemIndex += 1) {
      if (turns[turnIndex]!.items[itemIndex]!.type !== 'contextReset') continue;
      resetTurnIndex = turnIndex;
      resetItemIndex = itemIndex;
    }
  }
  if (resetTurnIndex < 0) return [...turns];
  const first = turns[resetTurnIndex]!;
  const remaining = first.items.slice(resetItemIndex + 1);
  return [
    ...(remaining.length > 0 ? [{ ...first, items: remaining }] : []),
    ...turns.slice(resetTurnIndex + 1),
  ];
}

function expandForCompactionCursors(turns: readonly Turn[], initialStart: number): number {
  let start = initialStart;
  const turnIndexById = new Map(turns.map((turn, index) => [turn.id, index]));
  for (;;) {
    let expanded = start;
    for (const turn of turns.slice(start)) {
      for (const item of turn.items) {
        if (item.type !== 'contextCompaction') continue;
        for (const cursor of [item.coveredFrom, item.coveredThrough, item.preservedFrom].filter(
          (candidate): candidate is ContextCursor => candidate !== null,
        )) {
          const cursorTurnIndex = turnIndexById.get(cursor.turnId);
          if (cursorTurnIndex === undefined) throw new Error('Inherited compaction cursor is unreachable');
          expanded = Math.min(expanded, cursorTurnIndex);
        }
      }
    }
    if (expanded === start) return start;
    start = expanded;
  }
}

function uniqueContextReferences(
  refs: readonly ThreadContextPayloadReference[],
): ThreadContextPayloadReference[] {
  return [...new Map(refs.map((ref) => [contextPayloadReferenceKey(ref), ref])).values()];
}

function uniqueResourceReferences(refs: readonly ThreadResourceReference[]): ThreadResourceReference[] {
  return [...new Map(refs.map((ref) => [resourceReferenceKey(ref), ref])).values()];
}

function uniqueOutputReferences(refs: readonly ThreadItemOutputReference[]): ThreadItemOutputReference[] {
  return [...new Map(refs.map((ref) => [outputReferenceKey(ref), ref])).values()];
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

function attachmentSourcesEqual(
  left: ThreadAttachmentContent,
  right: ThreadAttachmentContent,
): boolean {
  if (
    left.name !== right.name
    || left.mimeType !== right.mimeType
    || left.sizeBytes !== right.sizeBytes
    || left.source.kind !== right.source.kind
  ) return false;
  if (left.source.kind === 'localFile' && right.source.kind === 'localFile') {
    if (left.source.path !== right.source.path) return false;
  } else if (left.source.kind === 'threadPayload' && right.source.kind === 'threadPayload') {
    if (resourceReferenceKey(left.source.ref) !== resourceReferenceKey(right.source.ref)) return false;
  } else {
    return false;
  }
  if (!left.promptImage || !right.promptImage) return left.promptImage === right.promptImage;
  return resourceReferenceKey(left.promptImage) === resourceReferenceKey(right.promptImage);
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

function subagentActivityItem(
  threadId: ThreadId,
  turnId: TurnId,
  activity: PendingSubagentActivity,
): ThreadItem {
  const id = uuidV7();
  return {
    type: 'subAgentActivity',
    id,
    provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: id },
    kind: activity.kind,
    agentThreadId: activity.agentThreadId,
    agentPath: activity.agentPath,
  };
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

function copyTurn(source: Turn, now: number): Turn {
  const id = uuidV7(now);
  return decodeTurn({
    ...source,
    id,
    items: source.items.map((item) => copyItem(item, now)),
    itemsView: 'full',
  });
}

function rewriteForkedTurnDiagnostics(
  payload: TurnDiagnosticsPayload,
  itemIds: ReadonlyMap<string, string>,
): TurnDiagnosticsPayload {
  const rewriteItemId = (itemId: string): string => {
    const copied = itemIds.get(itemId);
    if (!copied) throw new Error(`Turn diagnostics Item is outside the forked Turn: ${itemId}`);
    return copied;
  };
  return {
    ...payload,
    activities: payload.activities.map((activity) => {
      if (activity.type === 'acceptedInput') {
        return { ...activity, itemIds: activity.itemIds.map(rewriteItemId) };
      }
      if (activity.type === 'toolExecutionBatch') {
        return {
          ...activity,
          executions: activity.executions.map((execution) => ({
            ...execution,
            itemId: execution.itemId === null ? null : rewriteItemId(execution.itemId),
          })),
        };
      }
      if (activity.type === 'contextCompaction') {
        return { ...activity, itemId: rewriteItemId(activity.itemId) };
      }
      return activity;
    }),
  };
}

function forkedCursorMap(sourceTurns: readonly Turn[], copiedTurns: readonly Turn[]): Map<string, ContextCursor> {
  const cursors = new Map<string, ContextCursor>();
  for (let turnIndex = 0; turnIndex < sourceTurns.length; turnIndex += 1) {
    const sourceTurn = sourceTurns[turnIndex]!;
    const copiedTurn = copiedTurns[turnIndex]!;
    for (let itemIndex = 0; itemIndex < sourceTurn.items.length; itemIndex += 1) {
      const sourceItem = sourceTurn.items[itemIndex]!;
      const copiedItem = copiedTurn.items[itemIndex]!;
      cursors.set(contextCursorKey({ turnId: sourceTurn.id, itemId: sourceItem.id }), {
        turnId: copiedTurn.id,
        itemId: copiedItem.id,
      });
    }
  }
  return cursors;
}

function rewriteForkedContextCursors(turn: Turn, cursorMap: ReadonlyMap<string, ContextCursor>): Turn {
  return decodeTurn({
    ...turn,
    items: turn.items.map((item) => {
      if (item.type === 'contextReset') {
        return { ...item, clearedThrough: rewriteForkedContextCursor(item.clearedThrough, cursorMap) };
      }
      if (item.type === 'contextCompaction') {
        return {
          ...item,
          coveredFrom: rewriteForkedContextCursor(item.coveredFrom, cursorMap),
          coveredThrough: rewriteForkedContextCursor(item.coveredThrough, cursorMap),
          preservedFrom: item.preservedFrom
            ? rewriteForkedContextCursor(item.preservedFrom, cursorMap)
            : null,
        };
      }
      return item;
    }),
  });
}

function rewriteForkedContextCursor(
  cursor: ContextCursor,
  cursorMap: ReadonlyMap<string, ContextCursor>,
): ContextCursor {
  const copied = cursorMap.get(contextCursorKey(cursor));
  if (!copied) throw new Error(`Context cursor is outside the forked history: ${cursor.turnId}/${cursor.itemId}`);
  return copied;
}

function contextCursorKey(cursor: ContextCursor): string {
  return `${cursor.turnId}\0${cursor.itemId}`;
}

function copyItem(source: ThreadItem, now: number): ThreadItem {
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
