import type { Stats } from 'node:fs';
import { join } from 'node:path';
import {
decodeAgentCoreRequest,
decodeAgentCoreResponse
} from '../../core/agent/codec';
import type { AgentRole,EffectiveThreadConfiguration } from '../../core/agent/configuration';
import {
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
EmptyAgentCoreResponse,
JsonValue,
PrivilegedTurnStartRequest,
RendererTurnStartRequest,
RendererTurnSubmitRequest,
RequestUserInputResponse,
RoleCatalogContextPayload,
SkillCatalogContextPayload,
SkillInvocationContextPayload,
Thread,
ThreadAttachmentContent,
ThreadConfigurationResponse,
ThreadConfigurationSetRequest,
ThreadConfigurationSummary,
ThreadContextReadRequest,
ThreadContextReadResponse,
ThreadFeatureSource,
ThreadForkRequest,
ThreadId,
ThreadItemOutputReadRequest,
ThreadItemOutputReadResponse,
ThreadItemsListRequest,
ThreadItemsListResponse,
ThreadListRequest,
ThreadDescendantsRequest,
ThreadDescendantsResponse,
ThreadListResponse,
ThreadReadRequest,
ThreadReadResponse,
ThreadSubagentsRequest,
ThreadSubagentsResponse,
SubagentExecutionProjection,
ThreadImageArtifactReference,
ThreadResourceReference,
ThreadRollbackRequest,
ThreadStartRequest,
ThreadStartResponse,
ThreadTurnDetailsReadRequest,
ThreadTurnDetailsReadResponse,
ThreadTurnsListRequest,
ThreadTurnsListResponse,
ThreadUserContent,
Turn,
TurnId,
TurnStartResponse,
TurnSubmitResponse,
TurnSteerRequest,
TurnSteerResponse
} from '../../core/agent/protocol';
import {
normalizeUpdatePlanToolInput,
type ModelToolIdentity,
type UpdatePlanToolInput
} from '../../core/agent/tools';
import type { DocumentProjection } from '../../core/types';
import type { ErrorReport } from '../../core/errorObservability';
import {
BUILT_IN_AGENT_ROLE_DEFINITIONS,
defaultEffectiveThreadConfiguration,
type ResolvedAgentType,
} from './AgentConfigurationLoader';
import type { ReferencedAssetResolution } from './capabilities/agentReferencedAssets';
import {
  AgentStartupContextResolver,
  AgentStartupContextStore,
} from './context/AgentStartupContext';
import { ExtensionRegistry } from './ExtensionRegistry';
import { GoalExtension } from './extensions/goal/GoalExtension';
import { GoalStore } from './extensions/goal/GoalStore';
import { KeyedMutex } from './Mutex';
import {
RolloutStore,
type ThreadHistoryRollbackMarker
} from './persistence/RolloutStore';
import { openSqlite } from './persistence/sqlite';
import {
requestPoolIdForTurn,
SubagentRequestLedger
} from './persistence/SubagentRequestLedger';
import {
  type AgentStartupContextSnapshot,
  SubagentExecutionLedger,
  type SubagentExecutionRecord,
  type SubagentRecordedToolPolicy,
} from './persistence/SubagentExecutionLedger';
import { projectSubagentExecution } from './thread/subagentExecutionProjection';
import type {
AgentWorktreeMetadata,
AgentWorktreeIntentInput,
AgentWorktreeRecoveryInput,
AgentWorktreeRecoveryIntent,
AgentWorktreeRecoveryResult,
SettleAgentWorktreeOptions
} from './worktree/AgentWorktree';
import { ThreadHistoryProjectionStore } from './persistence/ThreadHistoryProjectionStore';
import {
ThreadMetadataStore
} from './persistence/ThreadMetadataStore';
import { ToolPayloadStore } from './persistence/ToolPayloadStore';
import type {
OutputImageObservationNormalizer,
ThreadNameGenerator,
TurnExecutor
} from './runtime/types';
import type { AgentTool } from './runtime/kernel/types';
import { SubagentCollaboration } from './thread/SubagentCollaboration';
import { ThreadCatalogOps } from './thread/ThreadCatalogOps';
import { ThreadCore,type NotificationListener } from './thread/ThreadCore';
import { ThreadResourceOps } from './thread/ThreadResourceOps';
import { threadTranscriptRoot } from './thread/ThreadTranscriptArtifact';
import { documentDriftNotice,driftAttribution,DRIFT_ATTRIBUTION_SCAN,DRIFT_NOTICE_NODE_LIMIT,type DocumentDriftAttribution } from './context/documentDriftNotice';
import { beliefsFromToolResult,isBeliefBearingTool,type DocumentBelief } from './context/DocumentBeliefs';
import { ThreadDocumentBeliefs } from './context/ThreadDocumentBeliefs';
import { indexProjection } from './capabilities/agentNodeToolProjection';
import { ThreadTranscriptExclusions } from './thread/ThreadTranscriptExclusions';
import { ThreadTranscriptIndex } from './thread/ThreadTranscriptIndex';
import { rootTranscriptSubject,ThreadTranscriptWriter } from './thread/ThreadTranscriptWriter';
import type { TranscriptSubject } from './thread/TranscriptRenderer';
import { TurnLifecycle } from './thread/TurnLifecycle';

const THREAD_SERVICE_CLOSE_DRAIN_TIMEOUT_MS = 2_000;

/** What the drift attribution needs of a journal entry, and nothing more. */
export interface DocumentOperationRecord {
  readonly origin: string;
  readonly createdAt?: string;
  readonly affectedNodeIds?: readonly string[];
  readonly causation?: { readonly threadId: string };
}

/** Shared empty result, so "no drift" allocates nothing on the common path. */
const NO_DOCUMENT_DRIFT = Object.freeze({ context: null, settle: () => undefined });

export interface AgentCorePaths {
  readonly root: string;
  readonly rollouts: string;
  readonly state: string;
  readonly history: string;
  readonly goals: string;
  readonly payloads: string;
  /** Thread transcript artifacts. A sibling of `agent/`, directly under userData. */
  readonly transcripts: string;
}

export interface ThreadServiceStores {
  readonly metadata: ThreadMetadataStore;
  readonly history: ThreadHistoryProjectionStore;
  readonly rollout: RolloutStore;
  readonly goals: GoalStore;
  readonly subagentBudgets: SubagentRequestLedger;
  readonly subagentExecutions: SubagentExecutionLedger;
  readonly agentStartupContexts: AgentStartupContextStore;
  readonly payloads: ToolPayloadStore;
}

export interface ThreadServiceOptions {
  readonly stores: ThreadServiceStores;
  readonly executor: TurnExecutor;
  readonly attachmentScratchRoot: string;
  /** App-owned root for Thread transcript artifacts. Never a workspace path. */
  readonly transcriptRoot: string;
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
  /**
   * The journal as it stands, without waiting on the mutation queue. Attribution
   * only — the drift check itself never reads it, so an install that cannot
   * answer simply drops one clause.
   */
  readonly getRecentDocumentOperations?: (limit: number) => readonly DocumentOperationRecord[];
  readonly resolveReferencedAsset?: (assetId: string) => Promise<ReferencedAssetResolution | null>;
  readonly resolveSkillAdmission?: (
    input: SkillAdmissionResolutionInput,
  ) => SkillAdmissionResolution | Promise<SkillAdmissionResolution>;
  readonly resolveRole?: (name: string, cwd: string) => AgentRole;
  readonly resolveAgentType?: (name: string | undefined, cwd: string) => ResolvedAgentType;
  readonly resolveRoleCatalog?: (
    cwd: string,
  ) => RoleCatalogContextPayload | Promise<RoleCatalogContextPayload>;
  readonly resolveProviderModelIds?: (
    providerId: string,
  ) => readonly string[] | Promise<readonly string[]>;
  readonly resolveSubagentTokenBudget?: () => number | null | Promise<number | null>;
  readonly resolveSubagentLimits?: () => {
    readonly maxDepth: number;
    readonly maxConcurrent: number;
  } | Promise<{ readonly maxDepth: number; readonly maxConcurrent: number }>;
  readonly resolveAgentStartupContext?: (
    parent: Pick<Thread, 'id' | 'sessionId' | 'cwd'>,
  ) => AgentStartupContextSnapshot | null | Promise<AgentStartupContextSnapshot | null>;
  readonly planAgentWorktree?: (
    input: AgentWorktreeIntentInput,
  ) => Promise<AgentWorktreeRecoveryIntent>;
  readonly prepareAgentWorktree?: (input: {
    readonly agentId: ThreadId;
    readonly intent: AgentWorktreeRecoveryIntent;
    readonly worktree: AgentWorktreeMetadata | null;
  }) => Promise<{ readonly cwd: string; readonly worktree: AgentWorktreeMetadata }>;
  readonly settleAgentWorktree?: (
    worktree: AgentWorktreeMetadata,
    options?: SettleAgentWorktreeOptions,
  ) => Promise<{
    readonly worktree: AgentWorktreeMetadata;
    readonly retained: boolean;
  }>;
  readonly recoverAgentWorktree?: (
    input: AgentWorktreeRecoveryInput,
  ) => Promise<AgentWorktreeRecoveryResult>;
  readonly cleanupResidualAgentWorktree?: (
    input: AgentWorktreeRecoveryInput,
  ) => Promise<AgentWorktreeRecoveryResult>;
  readonly reportError?: (report: ErrorReport) => void | Promise<void>;
  readonly normalizeOutputImage?: OutputImageObservationNormalizer;
  readonly beforeInitialTurnAdmission?: () => void | Promise<void>;
  readonly now?: () => number;
}

export interface SkillAdmissionResolutionInput {
  readonly thread: Thread;
  readonly turnId: TurnId;
  readonly configuration: EffectiveThreadConfiguration;
  readonly preloadedSkills: readonly string[];
  readonly content: readonly ThreadUserContent[];
  readonly acceptedAt: number;
  readonly observedFilePaths: readonly string[];
}

export interface SkillAdmissionResolution {
  readonly catalogSnapshot: SkillCatalogContextPayload | null;
  readonly preloadedInvocations: readonly SkillInvocationContextPayload[];
  readonly invocation: SkillInvocationContextPayload | null;
}

export interface RendererThreadStartDefaults {
  readonly modelProvider: string;
  readonly cwd: string;
}

const EMPTY_AGENT_STARTUP_CONTEXT: AgentStartupContextSnapshot = Object.freeze({
  repositoryInstructions: Object.freeze([]),
  gitStatus: null,
});

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

export interface ResolvedThreadImageArtifactFile {
  readonly artifact: ThreadImageArtifactReference;
  readonly entryKind: 'file';
  readonly path: string;
  readonly stats: Stats;
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
  readonly id?: ThreadId;
  readonly turnId?: TurnId;
  readonly parentThreadId: ThreadId;
  readonly parentTurnId: string;
  readonly parentItemId: string;
  readonly prompt: string;
  readonly taskPath: string;
  /**
   * What the child is called for a human reader. Defaults to the task path's
   * last segment, which is the readable answer for a collaboration child and
   * the WRONG one for an isolated Skill, whose segment carries a uniqueness
   * suffix that is host addressing rather than a name.
   */
  readonly displayName?: string;
  readonly cwd?: string;
  readonly role?: string | AgentRole;
  readonly nickname?: string;
  readonly model?: string;
  readonly reasoningEffort?: EffectiveThreadConfiguration['reasoningEffort'];
  /** Additional child-only ceiling. Values absent from the parent/role result are ignored. */
  readonly allowedTools?: readonly string[];
  readonly additionalContext?: AdditionalContext;
  readonly maxTotalTokens?: number;
  /** Selects the parent-facing result channel while retaining one child-Thread mechanism. */
  readonly childKind: 'collaboration' | 'isolatedSkill';
  /** Host-owned execution policy prepared before any child state is written. */
  readonly execution: {
    readonly description: string;
    readonly agentType: string;
    readonly runMode: 'foreground' | 'background';
    readonly worktree: AgentWorktreeMetadata | null;
    /** Requests a new managed worktree before the child Thread is admitted. */
    readonly initialWorktreeCwd: string | null;
    readonly toolPolicy: SubagentRecordedToolPolicy;
    readonly startupContext: AgentStartupContextSnapshot | null;
  };
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
}

export class ThreadService implements ThreadServiceExtensionHost {
  private readonly core: ThreadCore;
  private readonly executor: TurnExecutor;
  private readonly extensions: ExtensionRegistry;
  private readonly getDocumentProjection: () => DocumentProjection | null;
  private readonly getRecentDocumentOperations: ThreadServiceOptions['getRecentDocumentOperations'];
  private readonly resolveReferencedAsset?: (assetId: string) => Promise<ReferencedAssetResolution | null>;
  private readonly resolveSkillAdmission: (
    input: SkillAdmissionResolutionInput,
  ) => Promise<SkillAdmissionResolution>;
  private readonly resolveRoleCatalog: (
    cwd: string,
  ) => Promise<RoleCatalogContextPayload | null>;
  private readonly resolveProviderModelIds: (providerId: string) => Promise<readonly string[]>;
  private readonly resolveAgentStartupContext: (
    parent: Pick<Thread, 'id' | 'sessionId' | 'cwd'>,
  ) => Promise<AgentStartupContextSnapshot | null>;
  private readonly beforeInitialTurnAdmission: () => void | Promise<void>;
  private readonly now: () => number;
  private readonly goals: GoalExtension;
  private readonly goalStore: GoalStore;
  private readonly subagentBudgets: SubagentRequestLedger;
  private readonly subagentExecutions: SubagentExecutionLedger;
  private readonly recoverAgentWorktree: ThreadServiceOptions['recoverAgentWorktree'];
  private readonly cleanupResidualAgentWorktree: ThreadServiceOptions['cleanupResidualAgentWorktree'];
  private readonly settleAgentWorktree: ThreadServiceOptions['settleAgentWorktree'];
  private readonly reportError: (report: ErrorReport) => Promise<void>;
  private readonly startupQuarantinedThreadIds = new Set<ThreadId>();
  private readonly resourceOps: ThreadResourceOps;
  private readonly catalogOps: ThreadCatalogOps;
  private readonly collaboration: SubagentCollaboration;
  private readonly transcripts: ThreadTranscriptWriter;
  private readonly transcriptIndex: ThreadTranscriptIndex;
  private readonly transcriptExclusions: ThreadTranscriptExclusions;
  private readonly beliefs: ThreadDocumentBeliefs;
  private readonly turnLifecycle: TurnLifecycle;
  private readonly rendererSubmissionMutex = new KeyedMutex();
  private readonly pendingRendererSubmissions = new Set<Promise<TurnSubmitResponse>>();
  private initialized = false;
  private closing = false;

  private get threadMutex() { return this.core.threadMutex; }
  private get activeTurns() { return this.turnLifecycle.activeTurnsForInspection(); }
  private get pendingUserInputs() { return this.turnLifecycle.pendingUserInputsForInspection(); }
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
    this.getRecentDocumentOperations = options.getRecentDocumentOperations;
    this.resolveReferencedAsset = options.resolveReferencedAsset;
    this.resolveSkillAdmission = async (input) => await options.resolveSkillAdmission?.(input) ?? {
      catalogSnapshot: null,
      preloadedInvocations: [],
      invocation: null,
    };
    const resolveRole = options.resolveRole ?? defaultAgentRole;
    const resolveAgentType = options.resolveAgentType ?? defaultResolvedAgentType;
    this.resolveRoleCatalog = async (cwd) => await options.resolveRoleCatalog?.(cwd) ?? null;
    this.resolveProviderModelIds = async (providerId) => (
      await options.resolveProviderModelIds?.(providerId) ?? []
    );
    const configuredStartupContextResolver = options.resolveAgentStartupContext;
    this.resolveAgentStartupContext = async (parent) => {
      if (!configuredStartupContextResolver) return null;
      try {
        const stored = options.stores.agentStartupContexts.read(parent.sessionId);
        if (stored) return nonEmptyAgentStartupContext(stored);
      } catch (error) {
        console.warn(`[agent] startup context unavailable for session ${parent.sessionId}`, error);
        try {
          options.stores.agentStartupContexts.delete([parent.sessionId]);
        } catch (deleteError) {
          console.warn(`[agent] startup context cleanup failed for session ${parent.sessionId}`, deleteError);
        }
      }
      try {
        const resolved = await configuredStartupContextResolver(parent);
        const frozen = options.stores.agentStartupContexts.writeOnce(
          parent.sessionId,
          resolved ?? EMPTY_AGENT_STARTUP_CONTEXT,
          this.now(),
        );
        return nonEmptyAgentStartupContext(frozen);
      } catch (error) {
        console.warn(`[agent] startup context unavailable for session ${parent.sessionId}`, error);
        try {
          options.stores.agentStartupContexts.writeOnce(
            parent.sessionId,
            EMPTY_AGENT_STARTUP_CONTEXT,
            this.now(),
          );
        } catch (writeError) {
          console.warn(`[agent] startup context tombstone failed for session ${parent.sessionId}`, writeError);
        }
        return null;
      }
    };
    this.beforeInitialTurnAdmission = options.beforeInitialTurnAdmission ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.goalStore = options.stores.goals;
    this.subagentBudgets = options.stores.subagentBudgets;
    this.subagentExecutions = options.stores.subagentExecutions;
    this.subagentExecutions.observeChanges((agentId) => this.publishSubagentExecution(agentId));
    this.recoverAgentWorktree = options.recoverAgentWorktree;
    this.cleanupResidualAgentWorktree = options.cleanupResidualAgentWorktree;
    this.settleAgentWorktree = options.settleAgentWorktree;
    this.reportError = async (report) => { await options.reportError?.(report); };
    this.resourceOps = new ThreadResourceOps(
      this.core,
      options.attachmentScratchRoot,
      options.resolveUserContent ?? ((content) => content),
    );
    options.stores.payloads.setImageRetentionInventoryProvider((threadId) => (
      this.resourceOps.threadImageRetentionInventory(threadId)
    ));
    this.transcriptExclusions = new ThreadTranscriptExclusions(options.transcriptRoot);
    this.beliefs = new ThreadDocumentBeliefs(this.now, (threadId) => this.rebuildDocumentBeliefs(threadId));
    this.transcriptIndex = new ThreadTranscriptIndex({
      transcriptRoot: options.transcriptRoot,
      readThreads: (threadIds) => new Map(
        [...this.core.metadata.readMany(threadIds)].map(([id, record]) => [id, record.thread]),
      ),
      // The index derives membership from disk, so it must apply the exclusion
      // itself: an artifact whose removal failed or was interrupted is still a
      // file, and listing it would advertise exactly what the user excluded.
      isExcluded: (threadId) => this.isSessionExcluded(threadId),
    });
    this.transcripts = new ThreadTranscriptWriter({
      transcriptRoot: options.transcriptRoot,
      onArtifactsChanged: () => this.transcriptIndex.schedule(),
      resolveSubject: (thread) => this.transcriptSubject(thread),
      completedTurns: (threadId) => this.core.allTurns(threadId).filter((turn) => turn.status !== 'inProgress'),
      payloads: (threadId) => ({
        readContext: (ref) => this.core.payloads.readContext(threadId, ref),
        readOutput: (ref) => this.core.payloads.readTextReference(threadId, ref),
        readDiagnostics: (ref) => this.core.payloads.readTurnDiagnostics(threadId, ref),
      }),
    });
    this.turnLifecycle = new TurnLifecycle(
      this.core,
      this.resourceOps,
      {
        createThread: (...args) => this.catalogOps.createThread(...args),
        deleteThread: (threadId) => this.catalogOps.deleteThread(threadId),
        setInitialPreview: (...args) => this.catalogOps.setInitialPreview(...args),
        scheduleAutomaticThreadName: (...args) => this.catalogOps.scheduleAutomaticThreadName(...args),
        hasPendingDelegatedThreadStart: (threadId) => this.catalogOps.hasPendingDelegatedThreadStart(threadId),
        publishDelegatedThreadStart: (threadId) => this.catalogOps.publishDelegatedThreadStart(threadId),
      },
      {
        pendingActivities: (threadId) => this.collaboration.pendingActivities(threadId),
        canSpawnAgent: (threadId, configuration) => this.collaboration.canSpawnAgent(threadId, configuration),
        materializePendingActivityItems: (...args) => this.collaboration.materializePendingActivityItems(...args),
        consumePendingSubagentActivities: (...args) => this.collaboration.consumePendingSubagentActivities(...args),
        hasPendingActivities: (threadId) => this.collaboration.hasPendingActivities(threadId),
        takePendingCollaborationActivity: (threadId) => this.collaboration.takePendingCollaborationActivity(threadId),
        signalCollaborationActivity: (threadId) => this.collaboration.signalCollaborationActivity(threadId),
        flushPendingSubagentActivities: (...args) => this.collaboration.flushPendingSubagentActivities(...args),
        queueChildTurnActivity: (...args) => this.collaboration.queueChildTurnActivity(...args),
        prepareChildTerminalSettlement: (...args) => this.collaboration.prepareChildTerminalSettlement(...args),
        threadBecameIdle: (threadId) => this.collaboration.threadBecameIdle(threadId),
        startupContextForTurn: (threadId, turnId) => options.stores.subagentExecutions.startupContextForTurn(threadId, turnId),
        commitInitialAdmission: (threadId, turnId) => this.collaboration.commitInitialAdmission(threadId, turnId),
      },
      { enqueueTurn: (...args) => this.transcripts.enqueueTurn(...args) },
      { noticeFor: (threadId, projection) => this.documentDriftContext(threadId, projection) },
      this.executor,
      this.extensions,
      this.subagentBudgets,
      this.getDocumentProjection,
      this.resolveReferencedAsset,
      this.resolveSkillAdmission,
      this.resolveRoleCatalog,
      { addUsage: (...args) => this.goals.addUsage(...args) },
      options.normalizeOutputImage,
      this.now,
      (message, rendererSubmissionRetryable) => new ThreadBusyError(message, rendererSubmissionRetryable),
      (error) => error instanceof ThreadBusyError,
    );
    this.collaboration = new SubagentCollaboration(
      this.core,
      this.resourceOps,
      {
        createThread: (...args) => this.catalogOps.createThread(...args),
        deleteThread: (threadId) => this.catalogOps.deleteThread(threadId),
      },
      this.turnLifecycle,
      this.subagentBudgets,
      options.stores.subagentExecutions,
      resolveRole,
      resolveAgentType,
      async () => await options.resolveSubagentTokenBudget?.() ?? null,
      async () => await options.resolveSubagentLimits?.() ?? {
        maxDepth: 3,
        maxConcurrent: 20,
      },
      this.resolveAgentStartupContext,
      options.planAgentWorktree,
      options.prepareAgentWorktree,
      options.settleAgentWorktree,
      this.now,
      applyToolCeiling,
      (threadId) => this.assertStartupThreadAvailable(threadId),
      (message, rendererSubmissionRetryable) => new ThreadBusyError(message, rendererSubmissionRetryable),
      this.transcripts,
    );
    this.catalogOps = new ThreadCatalogOps(
      this.core,
      this.resourceOps,
      this.extensions,
      options.nameGenerator ?? null,
      options.resolveConfiguration ?? defaultConfiguration,
      options.resolveRendererStartDefaults ?? missingRendererStartDefaults,
      options.validateRendererConfiguration ?? (() => undefined),
      this.now,
      () => this.closing,
      this.turnLifecycle,
      this.collaboration,
      (threadId) => options.stores.subagentExecutions.hasUndeliveredWork(threadId),
      {
        delete: (threadId) => this.transcripts.delete(threadId),
        forgetExclusions: (sessionIds) => this.transcriptExclusions.forget(sessionIds),
        // A deleted Thread's beliefs govern nothing; ids are never reused, so
        // keeping them would only be a set that grows and is never read.
        forgetBeliefs: (threadIds) => { this.beliefs.forget(threadIds); },
      },
      (threadId) => this.goals.clear(threadId),
      (threadId) => { this.subagentBudgets.clearThread(threadId); },
      (threadIds) => { options.stores.subagentExecutions.retireAgents(threadIds); },
      (sessionIds) => { options.stores.agentStartupContexts.delete(sessionIds); },
      async (thread) => { await this.resolveAgentStartupContext(thread); },
      (message) => new ThreadBusyError(message),
    );
    this.goals = new GoalExtension(this.goalStore, (notification) => this.core.recordNotification(notification));
    this.goals.bindHost(
      this,
      (threadId) => this.core.requireThread(threadId).thread,
      (threadId, turnId) => this.core.readTurn(threadId, turnId),
    );
    this.extensions.register(this.goals);
  }

  static open(
    userDataPath: string,
    executor: TurnExecutor,
    options: Omit<ThreadServiceOptions, 'stores' | 'executor' | 'transcriptRoot'>,
  ): ThreadService {
    const paths = agentCorePaths(userDataPath);
    const metadata = new ThreadMetadataStore(paths.state);
    const goalsDatabase = openSqlite(paths.goals);
    const agentStartupContexts = new AgentStartupContextStore(goalsDatabase);
    const startupContextResolver = new AgentStartupContextResolver(
      agentStartupContexts,
      undefined,
      options.now ?? Date.now,
    );
    return new ThreadService({
      executor,
      ...options,
      resolveAgentStartupContext: options.resolveAgentStartupContext
        ?? ((parent) => startupContextResolver.resolve(parent)),
      transcriptRoot: paths.transcripts,
      stores: {
        metadata,
        history: new ThreadHistoryProjectionStore(paths.history),
        rollout: new RolloutStore(paths.rollouts),
        goals: new GoalStore(paths.goals, goalsDatabase),
        subagentBudgets: new SubagentRequestLedger(goalsDatabase),
        subagentExecutions: new SubagentExecutionLedger(goalsDatabase),
        agentStartupContexts,
        payloads: new ToolPayloadStore(paths.payloads),
      },
    });
  }
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.core.payloads.initialize();
    // Before any Turn can complete: the subject resolver reads this synchronously.
    await this.transcriptExclusions.load();
    await this.recoverInitialSubagentAdmissions();
    await this.recoverOrphanSubagentExecutions();
    await this.removeDelegatedThreadsWithoutExecutions();
    const knownThreadIds: ThreadId[] = [];
    const reconciledThreadIds: ThreadId[] = [];
    const resumableThreadIds: ThreadId[] = [];
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      do {
        const page = this.core.metadata.list({ archived, cursor, limit: 100 });
        for (const thread of page.data) {
          knownThreadIds.push(thread.id);
          if (this.startupQuarantinedThreadIds.has(thread.id)) continue;
          try {
            await this.catalogOps.reconcileThread(thread.id);
            reconciledThreadIds.push(thread.id);
            if (!archived) resumableThreadIds.push(thread.id);
          } catch (error) {
            console.error(`[agent] failed to reconcile Thread ${thread.id}`, error);
          }
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    const knownThreads = new Set(knownThreadIds);
    try {
      this.subagentExecutions.sweepOrphanEnvelopes(knownThreads);
    } catch (error) {
      // Collaboration rows are secondary to the Thread catalog. Tombstoned
      // identities stay inert in this process and the next launch retries.
      console.warn('[agent] Agent ledger orphan cleanup deferred during startup', error);
    }
    await Promise.all([
      // Transcript reclamation is the same kind of work as payload pruning, so it
      // joins the same startup batch rather than adding a serial step.
      // Reclaim the pre-rename directory first, THEN sweep: the relocation is
      // what puts those artifacts back within reach of the sweep and of the
      // deletion cascade, so ordering them decides whether an orphan among them
      // is reclaimed on this launch or the next.
      this.transcripts.reclaimLegacyDirectory()
        .then(() => this.transcripts.sweepOrphans((threadId) => (
          // Reconciliation, not just reclamation: an artifact whose removal
          // failed or was interrupted mid-exclusion is still on disk, and
          // nothing else would ever come back for it — the Thread is excluded,
          // so it never rewrites the file that would notice.
          (knownThreads.has(threadId) || this.subagentExecutions.read(threadId) !== null)
          && !this.isSessionExcluded(threadId)
        )))
        // Rebuild the index once the artifact set has settled: it is a
        // projection of that set, so recomputing it earlier would only describe
        // a directory that is about to change.
        .then(() => { this.transcriptIndex.schedule(); }),
      ...reconciledThreadIds.flatMap((threadId) => {
        const references = this.resourceOps.threadStorageReferences(threadId);
        return [
          this.core.payloads.pruneUnreferencedResources(threadId, references.resources),
          this.core.payloads.pruneUnreferencedContexts(threadId, references.contexts),
          this.core.payloads.pruneUnreferencedTurnDiagnostics(threadId, references.diagnostics),
          this.core.payloads.pruneUnreferencedTextOutputs(threadId, references.textOutputs),
        ];
      }),
    ]);
    const resumableThreads: Thread[] = [];
    for (const threadId of resumableThreadIds) {
      const { thread } = await this.resumeThread(threadId);
      resumableThreads.push(thread);
    }
    await this.collaboration.recoverPendingNotifications();
    await this.beforeInitialTurnAdmission();
    this.initialized = true;
    for (const thread of resumableThreads) {
      if (thread.status.type === 'idle') {
        await this.extensions.threadIdle(this.core.requireThread(thread.id).thread);
      }
    }
  }

  private async recoverInitialSubagentAdmissions(): Promise<void> {
    for (const snapshot of this.subagentExecutions.pendingInitialAdmissions()) {
      const execution = this.subagentExecutions.read(snapshot.agentId);
      if (!execution || execution.initialAdmissionState !== 'pending') continue;
      try {
        const rollout = await this.core.rollout.read(execution.agentId);
        const committed = rollout.some((entry) => (
          entry.event.type === 'turn/started'
          && entry.event.threadId === execution.agentId
          && entry.event.turnId === execution.currentTurnId
          && entry.event.turn.id === execution.currentTurnId
        ));
        if (committed) {
          const completed = this.subagentExecutions.completeInitialAdmissionIfCurrent(
            execution.agentId,
            execution.currentTurnId,
            this.now(),
          );
          if (!completed && this.subagentExecutions.read(execution.agentId)?.initialAdmissionState !== 'committed') {
            throw new Error(`Agent initial admission recovery raced for ${execution.agentId}`);
          }
          continue;
        }
        if (!await this.removeStartupSubtree(execution.agentId)) {
          this.quarantineStartupSubtree(execution.agentId);
          await this.reportStartupQuarantine({
            threadId: execution.agentId,
            turnId: execution.currentTurnId,
          }, 'worktree-retained');
        }
      } catch (error) {
        this.quarantineStartupSubtree(execution.agentId);
        console.warn(`[agent] Initial Agent admission recovery deferred for ${execution.agentId}`);
        await this.reportStartupQuarantine({
          threadId: execution.agentId,
          turnId: execution.currentTurnId,
        }, 'cleanup-failed');
      }
    }
  }

  private async recoverOrphanSubagentExecutions(): Promise<void> {
    const knownThreads = new Set(this.persistentThreads().map((thread) => thread.id));
    for (const snapshot of this.subagentExecutions.orphanExecutions(knownThreads)) {
      const execution = this.subagentExecutions.read(snapshot.agentId);
      if (!execution) continue;
      // A failed pending-admission recovery already quarantined this identity
      // for this launch. Do not immediately retry it through the orphan pass:
      // the ledger is the next-startup retry authority, and a second attempt in
      // the same initialization would make quarantine timing depend on which
      // cleanup stage happened to fail first.
      if (this.startupQuarantinedThreadIds.has(execution.agentId)) continue;
      try {
        const thread = this.core.metadata.read(execution.agentId)?.thread ?? null;
        if (thread) {
          if (!await this.removeStartupSubtree(thread.id)) {
            this.quarantineStartupSubtree(thread.id);
            await this.reportStartupQuarantine({
              threadId: execution.agentId,
              turnId: execution.currentTurnId,
            }, 'worktree-retained');
          }
          continue;
        }
        if (!await this.settleRecordedStartupWorktree(execution)) {
          this.quarantineStartupSubtree(execution.agentId);
          await this.reportStartupQuarantine({
            threadId: execution.agentId,
            turnId: execution.currentTurnId,
          }, 'worktree-retained');
          continue;
        }
        await this.removeOrphanStartupArtifacts(execution.agentId);
      } catch (error) {
        this.quarantineStartupSubtree(execution.agentId);
        console.warn(`[agent] Orphan Agent recovery deferred for ${execution.agentId}`);
        await this.reportStartupQuarantine({
          threadId: execution.agentId,
          turnId: execution.currentTurnId,
        }, 'cleanup-failed');
      }
    }
  }

  private async removeDelegatedThreadsWithoutExecutions(): Promise<void> {
    for (const thread of this.persistentThreads()) {
      if (
        thread.parentThreadId === null
        || this.startupQuarantinedThreadIds.has(thread.id)
        || !this.core.metadata.read(thread.id)
        || this.subagentExecutions.read(thread.id)
      ) continue;
      try {
        if (!await this.removeStartupSubtree(thread.id)) {
          this.quarantineStartupSubtree(thread.id);
          await this.reportStartupQuarantine({ threadId: thread.id }, 'worktree-retained');
        }
      } catch (error) {
        this.quarantineStartupSubtree(thread.id);
        console.warn(`[agent] Delegated Thread without execution quarantined: ${thread.id}`);
        await this.reportStartupQuarantine({ threadId: thread.id }, 'cleanup-failed');
      }
    }
  }

  private async removeStartupSubtree(threadId: ThreadId): Promise<boolean> {
    const root = this.core.metadata.read(threadId)?.thread ?? null;
    if (!root) {
      const execution = this.subagentExecutions.read(threadId);
      if (!execution || !await this.settleRecordedStartupWorktree(execution)) return false;
      await this.removeOrphanStartupArtifacts(threadId);
      return true;
    }
    const subtreeIds = [
      threadId,
      ...this.core.metadata.childEdges(threadId, true).map((edge) => edge.childThreadId),
    ];
    for (const descendantId of [...subtreeIds].reverse()) {
      const execution = this.subagentExecutions.read(descendantId);
      if (execution) {
        if (!await this.settleRecordedStartupWorktree(execution)) return false;
        continue;
      }
      const descendant = this.core.metadata.read(descendantId)?.thread;
      if (!descendant?.parentThreadId) continue;
      const parent = this.core.metadata.read(descendant.parentThreadId)?.thread;
      if (parent && !this.unrecordedStartupWorktreeIsAbsent(descendant.cwd, parent.cwd)) return false;
    }
    try {
      // Recovery is deliberately separate from the user deletion lifecycle:
      // incomplete admissions must not run extension hooks or change the
      // surviving conversation's transcript-exclusion decision.
      for (const descendantId of [...subtreeIds].reverse()) {
        await this.transcripts.deleteForRecovery(descendantId);
        this.goalStore.clear(descendantId);
        this.core.history.deleteThread(descendantId);
        await this.core.rollout.delete(descendantId);
        await this.core.payloads.deleteThread(descendantId);
      }
      this.subagentBudgets.clearThreadsForRecovery(subtreeIds);
      this.core.metadata.delete(threadId);
      this.collaboration.clearThreadCoordinationState(subtreeIds);
      this.beliefs.forget(subtreeIds);
      this.core.clearThreadAdmissionBarriers(subtreeIds);
      // The execution rows are the cross-store retry authority and therefore
      // the final durable state removed by startup recovery.
      this.subagentExecutions.deleteAgents(subtreeIds);
      return true;
    } catch (error) {
      for (const descendantId of subtreeIds) this.startupQuarantinedThreadIds.add(descendantId);
      throw error;
    }
  }

  private async settleRecordedStartupWorktree(executionInput: SubagentExecutionRecord): Promise<boolean> {
    let execution = this.subagentExecutions.read(executionInput.agentId) ?? executionInput;
    if (execution.worktree?.removedAt !== null && execution.worktree !== null) return true;
    if (!execution.worktree && execution.initialWorktreeIntent !== null) {
      if (!this.recoverAgentWorktree) return false;
      const recoveryInput = {
        agentId: execution.agentId,
        intent: execution.initialWorktreeIntent,
        previous: null,
      } satisfies AgentWorktreeRecoveryInput;
      let recovered = await this.recoverAgentWorktree(recoveryInput);
      if (recovered.status === 'residual') {
        if (!this.cleanupResidualAgentWorktree) return false;
        recovered = await this.cleanupResidualAgentWorktree(recoveryInput);
      }
      if (recovered.status === 'residual') return false;
      if (recovered.status === 'absent') {
        this.subagentExecutions.clearInitialWorktreeIntentIfPending({
          agentId: execution.agentId,
          turnId: execution.currentTurnId,
          updatedAt: this.now(),
        });
        return true;
      }
      const recorded = this.subagentExecutions.recordInitialWorktreeIfPending({
        agentId: execution.agentId,
        turnId: execution.currentTurnId,
        worktree: recovered.prepared.worktree,
        updatedAt: this.now(),
      });
      if (!recorded) throw new Error(`Recovered Agent worktree admission raced for ${execution.agentId}`);
      execution = recorded;
    }
    if (!execution.worktree) return true;
    if (this.recoverAgentWorktree) {
      const recoveryInput = {
        agentId: execution.agentId,
        intent: worktreeRecoveryIntent(execution.worktree),
        previous: execution.worktree,
      } satisfies AgentWorktreeRecoveryInput;
      let recovered = await this.recoverAgentWorktree(recoveryInput);
      if (recovered.status === 'residual') {
        if (!this.cleanupResidualAgentWorktree) return false;
        await this.beginStartupWorktreeCleanup(execution, execution.worktree);
        recovered = await this.cleanupResidualAgentWorktree(recoveryInput);
      }
      if (recovered.status === 'residual') return false;
      if (recovered.status === 'absent') {
        await this.beginStartupWorktreeCleanup(execution, execution.worktree);
        this.completeStartupWorktreeCleanup(
          execution,
          execution.worktree,
          Object.freeze({ ...execution.worktree, removedAt: this.now() }),
        );
        return true;
      }
      execution = this.subagentExecutions.setWorktreeIfCurrent({
        agentId: execution.agentId,
        generation: execution.generation,
        turnId: execution.currentTurnId,
        worktree: recovered.prepared.worktree,
        updatedAt: this.now(),
      }) ?? execution;
    }
    if (!this.settleAgentWorktree) return false;
    const worktree = execution.worktree;
    if (!worktree) return true;
    const settled = await this.settleAgentWorktree(worktree, {
      cleanupStarted: execution.worktreeCleanupStartedAt !== null,
      beforeCleanRemoval: async () => {
        const started = this.subagentExecutions.beginWorktreeCleanupIfCurrent({
          agentId: execution.agentId,
          generation: execution.generation,
          turnId: execution.currentTurnId,
          worktree,
          startedAt: this.now(),
        });
        if (!started) throw new Error(`Agent worktree cleanup recovery raced for ${execution.agentId}`);
      },
    });
    if (settled.retained) {
      if (execution.worktreeCleanupStartedAt !== null) {
        this.subagentExecutions.cancelWorktreeCleanupIfCurrent({
          agentId: execution.agentId,
          generation: execution.generation,
          turnId: execution.currentTurnId,
          worktree: settled.worktree,
          updatedAt: this.now(),
        });
      }
      return false;
    }
    const current = this.subagentExecutions.read(execution.agentId);
    if (!current) return true;
    const updated = current.worktreeCleanupStartedAt !== null
      ? this.subagentExecutions.completeWorktreeCleanupIfCurrent({
        agentId: current.agentId,
        generation: current.generation,
        turnId: current.currentTurnId,
        expectedWorktree: worktree,
        worktree: settled.worktree,
        updatedAt: this.now(),
      })
      : this.subagentExecutions.setWorktreeIfCurrent({
        agentId: current.agentId,
        generation: current.generation,
        turnId: current.currentTurnId,
        worktree: settled.worktree,
        updatedAt: this.now(),
      });
    if (!updated) throw new Error(`Agent worktree cleanup completion raced for ${execution.agentId}`);
    return true;
  }

  private async beginStartupWorktreeCleanup(
    execution: SubagentExecutionRecord,
    worktree: AgentWorktreeMetadata,
  ): Promise<void> {
    const current = this.subagentExecutions.read(execution.agentId);
    if (!current || current.worktreeCleanupStartedAt !== null) return;
    if (!this.subagentExecutions.beginWorktreeCleanupIfCurrent({
      agentId: current.agentId,
      generation: current.generation,
      turnId: current.currentTurnId,
      worktree,
      startedAt: this.now(),
    })) throw new Error(`Agent worktree cleanup recovery raced for ${execution.agentId}`);
  }

  private completeStartupWorktreeCleanup(
    execution: SubagentExecutionRecord,
    expectedWorktree: AgentWorktreeMetadata,
    worktree: AgentWorktreeMetadata,
  ): void {
    const current = this.subagentExecutions.read(execution.agentId);
    if (!current) return;
    const updated = current.worktreeCleanupStartedAt !== null
      ? this.subagentExecutions.completeWorktreeCleanupIfCurrent({
        agentId: current.agentId,
        generation: current.generation,
        turnId: current.currentTurnId,
        expectedWorktree,
        worktree,
        updatedAt: this.now(),
      })
      : this.subagentExecutions.setWorktreeIfCurrent({
        agentId: current.agentId,
        generation: current.generation,
        turnId: current.currentTurnId,
        worktree,
        updatedAt: this.now(),
      });
    if (!updated) throw new Error(`Agent worktree cleanup completion raced for ${execution.agentId}`);
  }

  private unrecordedStartupWorktreeIsAbsent(childCwd: string, parentCwd: string): boolean {
    // Without a persisted recovery intent, deriving the base from the current
    // checkout could misclassify a crash-era worktree after HEAD advances.
    // Only equal parent/child cwd proves that this reverse orphan never entered
    // a separate checkout. Any distinct cwd stays visible and quarantined.
    return childCwd === parentCwd;
  }

  private async removeOrphanStartupArtifacts(threadId: ThreadId): Promise<void> {
    this.goalStore.clear(threadId);
    this.core.history.deleteThread(threadId);
    await this.core.rollout.delete(threadId);
    await this.core.payloads.deleteThread(threadId);
    await this.transcripts.deleteForRecovery(threadId);
    this.subagentBudgets.clearThreadsForRecovery([threadId]);
    this.subagentExecutions.deleteAgentOnly(threadId);
  }

  private async reportStartupQuarantine(
    subject: { readonly threadId: ThreadId; readonly turnId?: TurnId },
    status: 'worktree-retained' | 'cleanup-failed',
  ): Promise<void> {
    try {
      await this.reportError({
        domain: 'persistence',
        severity: 'warn',
        code: 'subagent-initial-admission-quarantined',
        message: 'Agent admission recovery retained incomplete state for a later retry.',
        context: {
          operation: 'recover-initial-subagent-admission',
          status,
          threadId: subject.threadId,
          ...(subject.turnId === undefined ? {} : { turnId: subject.turnId }),
        },
      });
    } catch {
      console.warn(`[agent] Failed to report Agent admission quarantine for ${subject.threadId}`);
    }
  }

  private persistentThreads(): readonly Thread[] {
    const threads: Thread[] = [];
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      do {
        const page = this.core.metadata.list({ archived, cursor, limit: 100 });
        threads.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
    }
    return threads;
  }

  private quarantineStartupSubtree(threadId: ThreadId): void {
    this.startupQuarantinedThreadIds.add(threadId);
    if (!this.core.metadata.read(threadId)) return;
    for (const edge of this.core.metadata.childEdges(threadId, true)) {
      this.startupQuarantinedThreadIds.add(edge.childThreadId);
    }
  }

  private assertStartupThreadAvailable(threadId: ThreadId): void {
    if (this.startupQuarantinedThreadIds.has(threadId)) {
      throw new ThreadBusyError(`Thread is quarantined pending Agent admission recovery: ${threadId}`);
    }
    const thread = this.core.requireThread(threadId).thread;
    if (thread.threadSource !== 'subagent') return;
    const execution = this.subagentExecutions.read(threadId);
    if (!execution) {
      throw new ThreadBusyError(`Delegated Agent execution is unavailable: ${threadId}`);
    }
    if (execution.initialAdmissionState !== 'committed') {
      throw new ThreadBusyError(`Delegated Agent admission is incomplete: ${threadId}`);
    }
  }
  async close(drainTimeoutMs = THREAD_SERVICE_CLOSE_DRAIN_TIMEOUT_MS): Promise<void> {
    this.closing = true;
    this.collaboration.beginClose();
    const drainDeadline = Date.now() + Math.max(0, drainTimeoutMs);
    const pendingNames = this.catalogOps.pendingNameShutdownHandles();
    for (const pending of pendingNames) pending.abort();
    for (const pending of this.pendingUserInputs.values()) pending.abort();
    for (const turn of this.activeTurns.values()) turn.controller.abort();
    const rendererSubmissions = [...this.pendingRendererSubmissions];
    if (!await settleBeforeDeadline(Promise.allSettled(rendererSubmissions), drainDeadline)) {
      console.warn(`[agent] Thread shutdown timed out with ${rendererSubmissions.length} renderer submission(s) pending`);
    }
    if (!await settleBeforeDeadline(
      Promise.allSettled(pendingNames.map((pending) => pending.completion)),
      drainDeadline,
    )) {
      console.warn(`[agent] Thread shutdown timed out with ${pendingNames.length} name generation(s) pending`);
    }
    let collaborationDrained: boolean | null = null;
    while (Date.now() < drainDeadline) {
      const active = [...this.activeTurns.values()];
      for (const turn of active) turn.controller.abort();
      const turnsDrained = await settleBeforeDeadline(
        Promise.allSettled(active.map((turn) => turn.completion)),
        drainDeadline,
      );
      if (!turnsDrained) break;
      collaborationDrained = await this.collaboration.drainForClose(drainDeadline);
      if (!collaborationDrained) break;
      if (this.activeTurns.size === 0) break;
    }
    collaborationDrained ??= await this.collaboration.drainForClose(drainDeadline);
    if (this.activeTurns.size > 0) {
      for (const turn of this.activeTurns.values()) turn.controller.abort();
      console.warn(`[agent] Thread shutdown timed out with ${this.activeTurns.size} active Turn(s)`);
    }
    if (!collaborationDrained) {
      console.warn('[agent] Thread shutdown timed out with collaboration work pending');
    }
    if (!await this.transcripts.flushAll(drainDeadline)) {
      console.warn('[agent] Thread shutdown timed out with transcript writes pending');
    }
    await this.transcriptIndex.flush();
    const failures: unknown[] = [];
    const operations = await Promise.allSettled([
      this.core.flush(),
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
  async waitForIdle(threadId: ThreadId): Promise<void> { return this.turnLifecycle.waitForIdle(threadId); }
  persistentRootThreads(): readonly Thread[] { return this.catalogOps.persistentRootThreads(); }
  persistentThreadExecutionContext(threadId: ThreadId): PersistentThreadExecutionContext { return this.catalogOps.persistentThreadExecutionContext(threadId); }
  readTurnForHost(threadId: ThreadId, turnId: TurnId): Turn | null { return this.core.readTurn(threadId, turnId); }
  readTurnByClientUserMessageIdForHost(threadId: ThreadId, clientId: string): Turn | null { return this.turnLifecycle.readTurnByClientUserMessageIdForHost(threadId, clientId); }
  async ensureFeatureRootThread(input: FeatureRootThreadInput): Promise<Thread> {
    return this.catalogOps.ensureFeatureRootThread(input);
  }
  activeRootUserTurns(): readonly { threadId: ThreadId; turnId: TurnId }[] { return this.turnLifecycle.activeRootUserTurns(); }
  isThreadNavigable(threadId: ThreadId): boolean { return this.catalogOps.isThreadNavigable(threadId); }
  async interruptRootTurns(turns: readonly { threadId: ThreadId; turnId: TurnId }[]): Promise<void> { return this.turnLifecycle.interruptRootTurns(turns); }
  async runInternalMemoryTurn(input: {
    readonly sourceThreadId: ThreadId;
    readonly name: string;
    readonly systemPrompt: string;
    readonly prompt: string;
    readonly signal: AbortSignal;
  }): Promise<string> { return this.turnLifecycle.runInternalMemoryTurn(input); }
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
      case 'thread/descendants':
        return this.listThreadDescendants(
          decoded as AgentCoreRequestByMethod['thread/descendants'],
        ) as AgentCoreResponseByMethod[Method];
      case 'thread/subagents/list':
        return this.listThreadSubagents(
          decoded as AgentCoreRequestByMethod['thread/subagents/list'],
        ) as AgentCoreResponseByMethod[Method];
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
      case 'thread/records/get':
        return {
          recorded: this.isThreadRecorded((decoded as AgentCoreRequestByMethod['thread/records/get']).threadId),
        } as AgentCoreResponseByMethod[Method];
      case 'thread/records/set': {
        const request = decoded as AgentCoreRequestByMethod['thread/records/set'];
        await this.setThreadRecorded(request.threadId, request.recorded);
        return { recorded: this.isThreadRecorded(request.threadId) } as AgentCoreResponseByMethod[Method];
      }
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
      case 'turn/submit':
        return await this.submitRendererInput(
          decoded as AgentCoreRequestByMethod['turn/submit'],
        ) as AgentCoreResponseByMethod[Method];
      case 'turn/start':
        return await this.startRendererTurn(decoded as AgentCoreRequestByMethod['turn/start']) as AgentCoreResponseByMethod[Method];
      case 'turn/steer':
        return await this.steerTurn(decoded as AgentCoreRequestByMethod['turn/steer']) as AgentCoreResponseByMethod[Method];
      case 'turn/interrupt': {
        const request = decoded as AgentCoreRequestByMethod['turn/interrupt'];
        await this.interruptUserWork(request.threadId, request.turnId);
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
  async resolveImageArtifactFile(
    threadId: ThreadId,
    artifact: ThreadImageArtifactReference,
  ): Promise<ResolvedThreadImageArtifactFile | null> {
    return this.resourceOps.resolveImageArtifactFile(threadId, artifact);
  }
  listItems(request: ThreadItemsListRequest): ThreadItemsListResponse { return this.catalogOps.listItems(request); }
  listThreads(request: ThreadListRequest = {}): ThreadListResponse { return this.catalogOps.listThreads(request); }
  listThreadDescendants(request: ThreadDescendantsRequest): ThreadDescendantsResponse {
    return this.catalogOps.listThreadDescendants(request);
  }
  /**
   * Every Agent this conversation has delegated, at any depth.
   *
   * Scoped to one conversation subtree rather than the installation: the
   * delegating conversation is the only place these Agents are addressable, so
   * a global roster would describe work no visible surface can act on.
   */
  listThreadSubagents(request: ThreadSubagentsRequest): ThreadSubagentsResponse {
    const subtree = this.catalogOps.subtreeThreadIds(request.threadId);
    const data = subtree
      .flatMap((threadId) => this.subagentExecutions.listByParent(threadId))
      // An uncommitted admission may still be rolled back, and the host
      // publishes no start for one; projecting it would put a chip in the
      // conversation for a delegation that never happened.
      .filter((record) => record.initialAdmissionState === 'committed')
      .map((record) => this.projectExecution(record))
      .sort((left, right) => left.createdAt - right.createdAt || left.agentId.localeCompare(right.agentId));
    return { data };
  }
  private projectExecution(record: SubagentExecutionRecord): SubagentExecutionProjection {
    return projectSubagentExecution(
      record,
      this.subagentExecutions.terminalNotification(record.agentId, record.generation),
    );
  }
  /**
   * Announces one Agent's execution state to the conversation that delegated
   * it. Transient by construction: the record is derived orchestration state,
   * while the Agent's canonical history is its own Thread, Turns, and Items.
   */
  private publishSubagentExecution(agentId: ThreadId): void {
    const record = this.subagentExecutions.read(agentId);
    if (!record || record.initialAdmissionState !== 'committed') return;
    if (!this.core.metadata.read(record.parentThreadId) && !this.core.ephemeral.has(record.parentThreadId)) return;
    try {
      this.core.emitTransientNotification({
        type: 'subagent/execution/changed',
        threadId: record.parentThreadId,
        execution: this.projectExecution(record),
      });
    } catch (error) {
      // Presentation state, never the write's problem: a parent that vanished
      // between the write and this publication has no surface left to update.
      console.warn(`[agent] Subagent execution notification skipped for ${agentId}`, error);
    }
  }
  readThread(request: ThreadReadRequest): ThreadReadResponse { return this.catalogOps.readThread(request); }
  getThreadConfiguration(threadId: ThreadId): ThreadConfigurationResponse { return this.catalogOps.getThreadConfiguration(threadId); }
  async setThreadConfiguration(request: ThreadConfigurationSetRequest): Promise<ThreadConfigurationResponse> { return this.catalogOps.setThreadConfiguration(request); }
  async startThread(requestInput: AgentCoreRequestByMethod['thread/start']): Promise<ThreadStartResponse> {
    return this.catalogOps.startThread(requestInput);
  }
  async resumeThread(threadId: ThreadId): Promise<{ thread: Thread }> {
    this.assertStartupThreadAvailable(threadId);
    return this.catalogOps.resumeThread(threadId);
  }
  async forkThread(request: ThreadForkRequest): Promise<{ thread: Thread }> {
    return this.catalogOps.forkThread(request);
  }
  async rollbackThread(request: ThreadRollbackRequest): Promise<{ thread: Thread }> { return this.catalogOps.rollbackThread(request); }
  historyProjectionVersion(threadId: ThreadId): number { return this.catalogOps.historyProjectionVersion(threadId); }
  hasHistoryRollbackMarker(rollbackId: string): boolean { return this.catalogOps.hasHistoryRollbackMarker(rollbackId); }
  historyRollbackMarker(rollbackId: string): ThreadHistoryRollbackMarker | null { return this.catalogOps.historyRollbackMarker(rollbackId); }
  /**
   * Three index columns are mutable Thread fields, not artifact facts — `name`,
   * `updatedAt`, `status` — so a rename or an archive moves a row without moving
   * a file. Without these the index would keep answering with the old name, and
   * a Thread renamed to what someone will actually search for would be
   * unfindable in the very file the doctrine sends them to.
   */
  async setThreadName(threadId: ThreadId, name: string | null): Promise<void> {
    await this.catalogOps.setThreadName(threadId, name);
    this.transcriptIndex.schedule();
  }
  async setThreadArchived(threadId: ThreadId, archived: boolean): Promise<void> {
    await this.catalogOps.setThreadArchived(threadId, archived);
    this.transcriptIndex.schedule();
  }
  async deleteThread(threadId: ThreadId): Promise<void> { return this.catalogOps.deleteThread(threadId); }
  async startRendererTurn(request: RendererTurnStartRequest): Promise<TurnStartResponse> {
    this.assertStartupThreadAvailable(request.threadId);
    return this.collaboration.startRendererTurn(request);
  }
  async submitRendererInput(request: RendererTurnSubmitRequest): Promise<TurnSubmitResponse> {
    this.assertStartupThreadAvailable(request.threadId);
    const submission = this.rendererSubmissionMutex.run(request.threadId, async () => {
      this.assertRendererSubmissionOpen();
      if (this.turnLifecycle.isRendererContextCommand(request.input)) {
        const response = await this.collaboration.startRendererTurn(
          request,
          () => this.assertRendererSubmissionOpen(),
        );
        return {
          turn: response.deduplicated ? null : response.turn,
          turnId: response.turn.id,
          acceptedItemId: response.acceptedItemId,
          deduplicated: response.deduplicated,
        };
      }
      for (;;) {
        this.assertRendererSubmissionOpen();
        const activeTurnId = this.turnLifecycle.activeTurnId(request.threadId);
        if (activeTurnId !== null) {
          try {
            const response = await this.turnLifecycle.steerTurn({
              ...request,
              expectedTurnId: activeTurnId,
            }, 'fatal', () => this.assertRendererSubmissionOpen());
            return { turn: null, ...response };
          } catch (error) {
            if (!(error instanceof ThreadBusyError) || !error.rendererSubmissionRetryable) throw error;
            this.assertRendererSubmissionRetryable(request.threadId, error);
            await this.turnLifecycle.waitForTurnCompletion(request.threadId, activeTurnId);
            continue;
          }
        }

        try {
          const response = await this.collaboration.startRendererTurn(
            request,
            () => this.assertRendererSubmissionOpen(),
          );
          return {
            turn: response.deduplicated ? null : response.turn,
            turnId: response.turn.id,
            acceptedItemId: response.acceptedItemId,
            deduplicated: response.deduplicated,
          };
        } catch (error) {
          if (!(error instanceof ThreadBusyError) || !error.rendererSubmissionRetryable) throw error;
          this.assertRendererSubmissionRetryable(request.threadId, error);
        }
      }
    });
    this.pendingRendererSubmissions.add(submission);
    try {
      return await submission;
    } finally {
      this.pendingRendererSubmissions.delete(submission);
    }
  }
  private assertRendererSubmissionRetryable(threadId: ThreadId, error: ThreadBusyError): void {
    if (this.closing) throw error;
    this.assertStartupThreadAvailable(threadId);
    const record = this.core.requireThread(threadId);
    if (record.archived || this.core.stoppingThreads.has(threadId)) throw error;
    if (this.turnLifecycle.activeTurnId(threadId) === null && record.thread.status.type !== 'idle') {
      throw error;
    }
  }
  private assertRendererSubmissionOpen(): void {
    if (this.closing) throw new ThreadBusyError('Agent service is shutting down');
  }
  async startPrivilegedTurn(request: PrivilegedTurnStartRequest): Promise<TurnStartResponse> {
    this.assertStartupThreadAvailable(request.threadId);
    return this.turnLifecycle.startPrivilegedTurn(request);
  }
  async tryStartTurnIfIdle(request: PrivilegedTurnStartRequest): Promise<Turn | null> {
    this.assertStartupThreadAvailable(request.threadId);
    return this.turnLifecycle.tryStartTurnIfIdle(request);
  }
  async steerTurn(
    request: TurnSteerRequest,
    deliveryFailureMode: 'fatal' | 'advisory' = 'fatal',
  ): Promise<TurnSteerResponse> {
    this.assertStartupThreadAvailable(request.threadId);
    return this.turnLifecycle.steerTurn(request, deliveryFailureMode);
  }
  /**
   * The user pressed Stop. One entry point for both affordances — the composer
   * and a per-child Stop on a delegation row — because they differ only in
   * which (Thread, Turn) is addressed.
   *
   * Stop closes the REQUEST: it settles the addressed Turn and every member of
   * that request which is a descendant of the addressed Thread. Addressed at
   * the delegating Turn that owns the request, "descendants of the addressed
   * Thread" is every member, so the composer needs no special case; addressed
   * at a child, it is that child's own subtree — its grandchildren would
   * otherwise keep running with an interrupted consumer.
   *
   * Only a Stop addressed at the request's originating Turn closes the request
   * itself. A per-child Stop leaves it open, because the delegator is still
   * running and may legitimately delegate again.
   */
  async interruptUserWork(threadId: ThreadId, turnId: string): Promise<void> {
    this.assertStartupThreadAvailable(threadId);
    this.assertUserOwnedLineage(threadId);
    let settling: readonly {
      readonly memberThreadId: ThreadId;
      readonly execution: SubagentExecutionRecord | null;
      readonly activeTurnId: string | null;
    }[] = [];
    await this.core.threadTreeMutex.run(async () => {
      const addressedExecution = this.collaboration.execution(threadId);
      // Spawn and Stop share this admission lock. A child committed first is in
      // this snapshot; a spawn arriving second observes the aborted parent and
      // is rejected by requireActiveTurn.
      await this.turnLifecycle.interruptTurn(threadId, turnId);
      if (addressedExecution) this.collaboration.recordUserStopIfCurrent(addressedExecution);
      const request = this.subagentBudgets.readPool(requestPoolIdForTurn(turnId));
      if (request && request.originTurnId === turnId) {
        this.subagentBudgets.closePool(request.poolId, this.now());
      }
      settling = this.requestMembersUnder(threadId, turnId).map((memberThreadId) => ({
        memberThreadId,
        execution: this.collaboration.execution(memberThreadId),
        activeTurnId: this.turnLifecycle.activeTurnId(memberThreadId),
      }));
    });
    // Stopped work stays stopped: a member holding only queued work has no Turn
    // to abort, and the queue would otherwise outlive the request.
    for (const { memberThreadId, execution, activeTurnId } of settling) {
      if (activeTurnId === null) {
        if (execution) this.collaboration.recordUserStopIfCurrent(execution);
        continue;
      }
      const interrupted = await this.turnLifecycle.interruptTurn(memberThreadId, activeTurnId)
        .then(() => true, () => false);
      if (interrupted && execution) this.collaboration.recordUserStopIfCurrent(execution);
    }
  }
  /**
   * The work the addressed Turn delegated, transitively.
   *
   * `originTurnId` records one hop, so the Turn's own members are its direct
   * children; a grandchild records ITS parent's Turn. Membership is therefore
   * the lineage closure of those direct members — not the raw per-hop set,
   * which would leave a grandchild running with an interrupted consumer, and
   * not raw pool membership, which a capped child escapes by binding its spend
   * to its own pool while the request still owns it.
   */
  private requestMembersUnder(threadId: ThreadId, turnId: string): readonly ThreadId[] {
    const direct = new Set(this.subagentBudgets.membersForOriginTurn(turnId)
      .map((member) => member.threadId)
      .filter((memberThreadId) => this.isSelfOrDescendant(memberThreadId, threadId)));
    if (direct.size === 0) return [];
    const subtree = this.catalogOps.listThreadDescendants({ threadId }).data;
    return [
      ...direct,
      ...subtree
        .map((thread) => thread.id)
        .filter((candidate) => !direct.has(candidate)
          && [...direct].some((member) => this.isSelfOrDescendant(candidate, member))),
    ];
  }
  /** Stop reaches only a user's own conversations, at any depth. */
  private assertUserOwnedLineage(threadId: ThreadId): void {
    const visited = new Set<ThreadId>();
    let thread = this.core.requireThread(threadId).thread;
    while (thread.parentThreadId !== null && !visited.has(thread.id)) {
      visited.add(thread.id);
      thread = this.core.requireThread(thread.parentThreadId).thread;
    }
    if (thread.parentThreadId !== null || thread.threadSource !== 'user') {
      throw new Error(`Thread is not part of a user conversation: ${threadId}`);
    }
  }
  private isSelfOrDescendant(threadId: ThreadId, ancestorThreadId: ThreadId): boolean {
    const visited = new Set<ThreadId>();
    let current: ThreadId | null = threadId;
    while (current !== null && !visited.has(current)) {
      if (current === ancestorThreadId) return true;
      visited.add(current);
      current = this.core.requireThread(current).thread.parentThreadId;
    }
    return false;
  }
  async requestUserInput(
    threadId: ThreadId,
    turnId: string,
    itemId: string,
    inputValue: unknown,
    signal?: AbortSignal,
  ): Promise<RequestUserInputResponse> { return this.turnLifecycle.requestUserInput(threadId, turnId, itemId, inputValue, signal); }
  async respondUserInput(response: RequestUserInputResponse): Promise<void> { return this.turnLifecycle.respondUserInput(response); }
  updateTurnPlan(threadId: ThreadId, turnId: string, inputValue: unknown): UpdatePlanToolInput {
    const input = normalizeUpdatePlanToolInput(inputValue);
    this.turnLifecycle.requireActiveTurn(threadId, turnId);
    this.core.emitTransientNotification({
      type: 'turn/plan/updated',
      threadId,
      turnId,
      ...input,
    });
    return input;
  }
  getGoalForTurn(threadId: ThreadId, turnId: string): GetGoalResponse {
    this.turnLifecycle.requireActiveTurn(threadId, turnId);
    return this.goals.get({ threadId });
  }
  async createGoalForTurn(
    threadId: ThreadId,
    turnId: string,
    objective: string,
    tokenBudget?: number,
  ): Promise<CreateGoalResponse> {
    this.turnLifecycle.requireActiveTurn(threadId, turnId);
    return this.goals.create({ threadId, objective, ...(tokenBudget === undefined ? {} : { tokenBudget }) }, turnId);
  }
  async updateGoalForTurn(
    threadId: ThreadId,
    turnId: string,
    status: 'blocked' | 'complete',
  ): Promise<UpdateGoalResponse> {
    this.turnLifecycle.requireActiveTurn(threadId, turnId);
    return this.goals.update({ threadId, status }, turnId);
  }
  async notifyToolStarted(
    threadId: ThreadId,
    turnId: string,
    itemId: string,
    identity: ModelToolIdentity,
    args: JsonValue,
  ): Promise<void> {
    this.turnLifecycle.requireActiveTurn(threadId, turnId);
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
    // Every tool result passes here exactly once, with the Thread in hand. A
    // node the model was just shown becomes a belief at the moment it was shown,
    // and this is the one place that moment exists for every node tool at once —
    // no per-tool hook, and nothing for a new node tool to remember to call.
    this.beliefs.observe(threadId, identity.name, result, this.getDocumentProjection());
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
  /**
   * Test seam: drop the in-session beliefs, so the next admission rebuilds them
   * from the canonical record — the same path a restart or a fork takes.
   */
  dropDocumentBeliefs(threadId: ThreadId): void { this.beliefs.forget([threadId]); }
  /** Test seam: settle a Thread's pending transcript appends. */
  async flushThreadTranscript(threadId: ThreadId): Promise<void> { return this.transcripts.flush(threadId); }
  /** Account layer for a Thread that keeps one: the artifact path, or null when it is not on disk (A12). */
  async threadTranscriptPath(threadId: ThreadId): Promise<string | null> { return this.transcripts.pathForReader(threadId); }
  /** Where past sessions are discoverable. Named by the discovery doctrine, read with the file tools. */
  get threadTranscriptIndexPath(): string { return this.transcriptIndex.path; }
  /** Test seam: settle the index rewrite in flight and anything it owes. */
  async flushThreadTranscriptIndex(): Promise<void> { return this.transcriptIndex.flush(); }
  /**
   * The ONE answer to whether a Thread keeps an account and what its header
   * says. Delegation is asked first because spawn metadata is the authority for
   * a child; the other branch is roots only, so the two can never both match —
   * and an orphaned child, whose spawn edge is gone, is not silently promoted
   * into a root.
   */
  private transcriptSubject(thread: Thread): TranscriptSubject | null {
    // The user's choice is the first word, ahead of every kind: a conversation
    // taken out of the records keeps none, and neither does the work it
    // delegated — the whole subtree shares this session.
    if (this.transcriptExclusions.isExcluded(thread.sessionId)) return null;
    return this.collaboration.delegatedTranscriptSubject(thread) ?? rootTranscriptSubject(thread);
  }

  /**
   * Whether an artifact's Thread belongs to an excluded session, answered from
   * the Thread id alone because the index only ever has the filename.
   */
  private isSessionExcluded(threadId: ThreadId): boolean {
    const sessionId = this.core.metadata.read(threadId)?.thread.sessionId;
    return sessionId === undefined ? false : this.transcriptExclusions.isExcluded(sessionId);
  }

  /**
   * The drift notice for this admission, or null when nothing the model was
   * shown has moved.
   *
   * It rides `additionalContext`, the channel `automation_info` already uses, so
   * two properties come free: "never mid-Turn" is true by construction, because
   * admission is when evidence is admitted; and the notice lands in the canonical
   * record, where a transcript reader can later audit what the model was told.
   */
  private async documentDriftContext(
    threadId: ThreadId,
    projection: DocumentProjection | null,
  ): Promise<{ readonly context: AdditionalContext | null; readonly settle: () => void }> {
    // A12 over the WHOLE composition, rendering included. `nodeTitle` and
    // `nodeContentText` walk rich text, and this is called inline while building
    // the admission argument, so a throw here would fail the user's Turn before
    // it started — inspection-only data killing the user's action.
    try {
      const drift = await this.beliefs.peekDrift(threadId, projection, DRIFT_NOTICE_NODE_LIMIT);
      if (drift.reported.length === 0) return NO_DOCUMENT_DRIFT;
      const notice = documentDriftNotice(
        drift.reported,
        drift.total,
        this.driftAttribution(threadId, drift.reported),
      );
      if (notice === null) return NO_DOCUMENT_DRIFT;
      return {
        context: { document_drift: { kind: 'application', value: notice } },
        // Only once the Turn carrying it is durably recorded.
        settle: () => this.beliefs.settleReported(threadId, projection, drift.reported),
      };
    } catch (error) {
      console.warn(`[agent] Document drift notice was not composed for ${threadId}`, error);
      return NO_DOCUMENT_DRIFT;
    }
  }

  /**
   * Beliefs a previous process, or the Thread this one was forked from, formed —
   * recovered from the persisted tool outputs that were the observation.
   *
   * The observation time is the Turn's, because an Item carries none; that is
   * monotonic with observation order, which is all attribution needs of it. A
   * payload that no longer decodes contributes nothing rather than a guess.
   */
  private async rebuildDocumentBeliefs(threadId: ThreadId): Promise<readonly DocumentBelief[]> {
    const projection = this.getDocumentProjection();
    let index: ReturnType<typeof indexProjection> | null | undefined;
    const beliefs: DocumentBelief[] = [];
    for (const turn of this.core.allTurns(threadId)) {
      const observedAt = turn.completedAt ?? turn.startedAt;
      for (const item of turn.items) {
        if (
          item.type !== 'dynamicToolCall'
          || !item.outputRef
          || !isBeliefBearingTool(item.tool)
        ) continue;
        index ??= projection ? indexProjection(projection) : null;
        const text = await this.core.payloads.readTextReference(threadId, item.outputRef).catch(() => null);
        if (!text) continue;
        try {
          beliefs.push(...beliefsFromToolResult(item.tool, JSON.parse(text), index ?? null, observedAt));
        } catch {
          // Not JSON, or truncated past parsing: no belief rather than a wrong one.
        }
      }
    }
    return beliefs;
  }

  /** A12: attribution is garnish, so a journal that cannot answer costs one clause. */
  private driftAttribution(
    threadId: ThreadId,
    drifted: readonly { readonly nodeId: string; readonly observedAt: number }[],
  ): DocumentDriftAttribution | null {
    try {
      const entries = this.getRecentDocumentOperations?.(DRIFT_ATTRIBUTION_SCAN) ?? [];
      return driftAttribution(drifted, entries, threadId);
    } catch {
      return null;
    }
  }

  /** Whether this Thread is kept in the readable records. */
  isThreadRecorded(threadId: ThreadId): boolean {
    return !this.isSessionExcluded(threadId);
  }

  /**
   * Take a conversation out of the records, or put it back.
   *
   * The unit is the SESSION, not the Thread: a root's Subagents write their own
   * artifacts, so excluding the root alone would leave the delegated work
   * readable and still listed in the index — the excluded content advertised to
   * every later Thread by the very doctrine this feature adds.
   *
   * Excluding removes what is already there, because a switch that only stopped
   * FUTURE appends would leave the conversation the user just excluded sitting
   * on disk. Re-including rebuilds each artifact from canonical history straight
   * away rather than waiting for a next Turn that a finished conversation will
   * never have — otherwise undoing an accidental exclusion would silently keep
   * nothing while the menu claimed the record was back.
   */
  async setThreadRecorded(threadId: ThreadId, recorded: boolean): Promise<void> {
    const thread = this.core.metadata.read(threadId)?.thread;
    if (!thread) return;
    if (!await this.transcriptExclusions.setExcluded(thread.sessionId, !recorded)) return;
    const subtree = this.catalogOps.recordedSessionThreads(threadId);
    for (const member of subtree) {
      if (recorded) {
        this.transcripts.restore(member.id);
        await this.transcripts.rebuildNow(member);
      } else {
        await this.transcripts.delete(member.id);
      }
    }
    this.transcriptIndex.schedule();
  }
  async collaborationToolContributions(
    turn: { threadId: ThreadId; turnId: string },
  ): Promise<readonly AgentTool[]> {
    const providerId = this.core.requireThread(turn.threadId).thread.modelProvider;
    return this.collaboration.collaborationToolContributions(
      turn,
      await this.resolveProviderModelIds(providerId),
    );
  }
  subagentExecution(threadId: ThreadId): SubagentExecutionRecord | null {
    return this.collaboration.execution(threadId);
  }
  agentWorktree(threadId: ThreadId): AgentWorktreeMetadata | null {
    return this.collaboration.worktreeForThread(threadId);
  }
  async stopAgentTask(
    senderThreadId: ThreadId,
    senderTurnId: TurnId,
    agentId: string,
  ): Promise<JsonValue | null> {
    return this.collaboration.stopAgentTask(senderThreadId, senderTurnId, agentId);
  }
  hasAgentTask(senderThreadId: ThreadId, agentId: string): boolean {
    return this.collaboration.hasAgentTask(senderThreadId, agentId);
  }
  async withThreadAdmissionBarrier<T>(
    threadId: ThreadId,
    operation: (snapshot: ThreadAdmissionBarrierSnapshot) => Promise<T>,
  ): Promise<T> { return this.core.withThreadAdmissionBarrier(threadId, operation); }

  async withHostRootTurnAdmissionBarrier<T>(
    operation: (snapshot: HostRootTurnAdmissionBarrierSnapshot) => Promise<T>,
  ): Promise<T> { return this.core.withHostRootTurnAdmissionBarrier(operation); }

}

type ContextCommand =
  | { readonly kind: 'clear' }
  | { readonly kind: 'compact'; readonly instructions: string };

export class ThreadBusyError extends Error {
  constructor(
    message: string,
    readonly rendererSubmissionRetryable = false,
  ) {
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
    transcripts: threadTranscriptRoot(userDataPath),
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

function defaultResolvedAgentType(name: string | undefined): ResolvedAgentType {
  const canonicalType = name ?? 'general-purpose';
  const backingRole = canonicalType === 'general-purpose'
    ? 'default'
    : canonicalType === 'explore'
      ? 'explorer'
      : canonicalType;
  const role = defaultAgentRole(backingRole);
  return {
    canonicalType,
    role,
    kind: canonicalType === 'general-purpose' || canonicalType === 'explore' || canonicalType === 'plan'
      ? canonicalType
      : 'role',
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

function nonEmptyAgentStartupContext(
  snapshot: AgentStartupContextSnapshot,
): AgentStartupContextSnapshot | null {
  return snapshot.repositoryInstructions.length === 0 && snapshot.gitStatus === null
    ? null
    : snapshot;
}

function emptyResponse(): EmptyAgentCoreResponse {
  return Object.freeze({});
}

function worktreeRecoveryIntent(
  worktree: AgentWorktreeMetadata,
): AgentWorktreeRecoveryIntent {
  return Object.freeze({
    sourceCwd: worktree.sourceCwd,
    path: worktree.path,
    branch: worktree.branch,
    baseCommit: worktree.baseCommit,
    gitCommonDir: worktree.gitCommonDir,
  });
}

async function settleBeforeDeadline(work: Promise<unknown>, deadline: number): Promise<boolean> {
  const remainingMs = Math.max(0, deadline - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), remainingMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
