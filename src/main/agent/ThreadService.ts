import type { Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
decodeAgentCoreRequest,
decodeAgentCoreResponse,
decodeThreadResourceReference,
} from '../../core/agent/codec';
import type { EffectiveThreadConfiguration } from '../../core/agent/configuration';
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
AgentIdentityEntry,
PrivilegedTurnStartRequest,
RendererTurnStartRequest,
RendererTurnSteerRequest,
RendererTurnSubmitRequest,
RequestUserInputResponse,
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
ThreadItem,
ThreadItemOutputReadRequest,
ThreadItemOutputReadResponse,
ThreadItemsListRequest,
ThreadItemsListResponse,
ThreadListRequest,
ThreadListResponse,
ThreadReadRequest,
ThreadReadResponse,
ThreadReferenceResolveRequest,
ThreadReferenceResolveResponse,
ThreadReferenceSearchRequest,
ThreadReferenceSearchResponse,
ThreadToolTasksRequest,
ThreadToolTasksResponse,
ToolTaskReadRequest,
ToolTaskReadResponse,
ThreadImageArtifactReference,
ThreadResourceReference,
ThreadRollbackRequest,
ThreadStartRequest,
ThreadStartResponse,
ThreadTrajectoryDetailReadRequest,
ThreadTrajectoryDetailReadResponse,
ThreadTrajectoryReadRequest,
ThreadTrajectoryReadResponse,
ThreadTurnDetailsReadRequest,
ThreadTurnDetailsReadResponse,
ThreadTurnsListRequest,
ThreadTurnsListResponse,
ThreadUserContent,
Turn,
TurnId,
TurnStartResponse,
TurnSubmitResponse,
TurnSteerResponse,
TurnContinueRequest,
TurnContinueResponse,
TurnRecoveryReadRequest,
TurnRecoveryReadResponse,
TurnRerunRequest,
TurnRerunResponse
} from '../../core/agent/protocol';
import { isRerunnableTurn } from '../../core/agent/turnRerun';
import type { DelegationSessionBinding } from './delegation/delegationSessionTypes';
import type { DelegationCoordinator } from './delegation/DelegationCoordinator';
import { delegationTaskReconciliation } from './delegation/DelegationCoordinator';
import { decodeDelegateExecutionResult } from '../../delegate/contract';
import {
normalizeUpdatePlanToolInput,
type ModelToolIdentity,
type UpdatePlanToolInput
} from '../../core/agent/tools';
import type { DocumentProjection } from '../../core/types';
import type { ErrorReport } from '../../core/errorObservability';
import {
defaultEffectiveThreadConfiguration,
type AgentConfigurationReadFailureReporter,
} from './AgentConfigurationLoader';
import type { ReferencedAssetResolution } from './capabilities/agentReferencedAssets';
import {
  AgentStartupContextResolver,
  AgentStartupContextStore,
  type AgentStartupContextSnapshot,
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
import { AgentResourceStore } from './persistence/AgentResourceStore';
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
import { ThreadCatalogOps } from './thread/ThreadCatalogOps';
import { ThreadCore,type NotificationListener } from './thread/ThreadCore';
import { ThreadResourceOps } from './thread/ThreadResourceOps';
import {
  ThreadHistoryReferenceService,
  type AgentThreadReadInput,
  type AgentThreadReadResult,
  type AgentThreadSearchInput,
  type AgentThreadSearchResult,
} from './thread/ThreadHistoryReference';
import { ThreadTrajectoryProjection } from './thread/ThreadTrajectoryProjection';
import { threadTranscriptRoot } from './thread/ThreadTranscriptArtifact';
import { ThreadTranscriptExclusions } from './thread/ThreadTranscriptExclusions';
import { ThreadTranscriptIndex } from './thread/ThreadTranscriptIndex';
import { rootTranscriptSubject,ThreadTranscriptWriter } from './thread/ThreadTranscriptWriter';
import type { TranscriptSubject } from './thread/TranscriptRenderer';
import {
  TurnLifecycle,
  type CanonicalTurnRerunInputBatch,
  type StagedContextEvidence,
} from './thread/TurnLifecycle';
import { ToolTaskService } from './tasks/ToolTaskService';
import { ToolTaskStore } from './tasks/ToolTaskStore';
import type { ToolTaskSupervisorRuntime } from './tasks/toolTaskRuntime';
import {
  collectDeclaredOutputArtifacts,
  decodeDeclaredOutputArtifactPlan,
} from './capabilities/agentDeclaredOutputArtifacts';
import type { ToolArtifactSink } from './runtime/ToolArtifactSink';

const THREAD_SERVICE_CLOSE_DRAIN_TIMEOUT_MS = 2_000;

/** Shared empty result, so "no drift" allocates nothing on the common path. */
const NO_DOCUMENT_DRIFT = Object.freeze({ context: null, settle: () => undefined });

export interface AgentCorePaths {
  readonly root: string;
  readonly rollouts: string;
  readonly state: string;
  readonly history: string;
  readonly goals: string;
  readonly payloads: string;
  readonly resourceReferences: string;
  /** Thread transcript artifacts. A sibling of `agent/`, directly under userData. */
  readonly transcripts: string;
  readonly toolTasks: string;
}

export interface ThreadServiceStores {
  readonly metadata: ThreadMetadataStore;
  readonly history: ThreadHistoryProjectionStore;
  readonly rollout: RolloutStore;
  readonly goals: GoalStore;
  readonly agentStartupContexts: AgentStartupContextStore;
  readonly payloads: ToolPayloadStore;
  readonly resources: AgentResourceStore;
  readonly toolTasks: ToolTaskStore;
}

export interface ThreadServiceOptions {
  readonly stores: ThreadServiceStores;
  readonly executor: TurnExecutor;
  readonly attachmentScratchRoot: string;
  readonly resolveRootWorkspace?: (
    threadId: ThreadId,
  ) => string | Promise<string>;
  readonly cleanupRootWorkspace?: (
    threadId: ThreadId,
    cwd: string,
  ) => void | Promise<void>;
  readonly ownsRootWorkspace?: (threadId: ThreadId, cwd: string) => boolean;
  /** App-owned root for Thread transcript artifacts. Never a workspace path. */
  readonly transcriptRoot: string;
  readonly nameGenerator?: ThreadNameGenerator;
  readonly extensions: ExtensionRegistry;
  readonly resolveConfiguration?: (
    request: ThreadStartRequest,
  ) => EffectiveThreadConfiguration | Promise<EffectiveThreadConfiguration>;
  readonly resolveRendererStartDefaults?: (
    request: AgentCoreRequestByMethod['thread/start'],
  ) =>
    | RendererThreadStartDefaults
    | Promise<RendererThreadStartDefaults>;
  readonly validateRendererConfiguration?: (
    configuration: ThreadConfigurationSummary,
  ) => void | Promise<void>;
  readonly onRendererConfigurationCommitted?: (
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
  readonly resolveIdentityCatalog?: (
    cwd: string,
    reportFailure?: AgentConfigurationReadFailureReporter,
  ) => readonly AgentIdentityEntry[];
  /**
   * The name a Thread's agent answers to. Resolved per Turn rather than read
   * from the recorded configuration, so a rename reaches the next Turn.
   */
  readonly resolvePersona?: (
    thread: Thread,
    reportFailure?: AgentConfigurationReadFailureReporter,
  ) => string;
  readonly resolveAgentStartupContext?: (
    parent: Pick<Thread, 'id' | 'sessionId' | 'cwd'>,
  ) => AgentStartupContextSnapshot | null | Promise<AgentStartupContextSnapshot | null>;
  readonly reportError?: (report: ErrorReport) => void | Promise<void>;
  readonly normalizeOutputImage?: OutputImageObservationNormalizer;
  readonly beforeInitialTurnAdmission?: () => void | Promise<void>;
  readonly toolTaskSupervisorRuntime?: ToolTaskSupervisorRuntime;
  readonly toolTaskDetailRoot?: string;
  readonly delegationCoordinator?: () => DelegationCoordinator | null;
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

export type RendererThreadStartDefaults =
  | {
      readonly modelProvider: string;
      readonly cwd: string;
      readonly executionSelection?: never;
    }
  | {
      readonly modelProvider?: never;
      readonly cwd: string;
      readonly executionSelection: ThreadConfigurationSummary;
    };

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
  readonly entryKind: 'file' | 'directory';
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

export class ThreadService implements ThreadServiceExtensionHost {
  private readonly core: ThreadCore;
  private readonly executor: TurnExecutor;
  private readonly extensions: ExtensionRegistry;
  private readonly getDocumentProjection: () => DocumentProjection | null;
  private readonly resolveReferencedAsset?: (assetId: string) => Promise<ReferencedAssetResolution | null>;
  private readonly resolveSkillAdmission: (
    input: SkillAdmissionResolutionInput,
  ) => Promise<SkillAdmissionResolution>;
  private readonly resolveIdentityCatalog: (cwd: string) => readonly AgentIdentityEntry[];
  private readonly resolvePersona: (thread: Thread) => string | null;
  private readonly resolveAgentStartupContext: (
    parent: Pick<Thread, 'id' | 'sessionId' | 'cwd'>,
  ) => Promise<AgentStartupContextSnapshot | null>;
  private readonly beforeInitialTurnAdmission: () => void | Promise<void>;
  private readonly now: () => number;
  private readonly goals: GoalExtension;
  private readonly goalStore: GoalStore;
  private readonly toolTasks: ToolTaskService;
  private readonly delegationCoordinator: () => DelegationCoordinator | null;
  private readonly reportError: (report: ErrorReport) => Promise<void>;
  private readonly startupQuarantinedThreadIds = new Set<ThreadId>();
  /**
   * The subset quarantined because their recorded history does not decode. Kept
   * apart from the admission-recovery quarantine above: those Threads read fine
   * and were held back over a worktree, so answering their history reads with
   * "could not be read" would be a lie.
   */
  private readonly unreadableThreadIds = new Set<ThreadId>();
  private readonly resourceOps: ThreadResourceOps;
  private readonly historyReferences: ThreadHistoryReferenceService;
  private readonly catalogOps: ThreadCatalogOps;
  private readonly trajectory: ThreadTrajectoryProjection;
  private readonly transcripts: ThreadTranscriptWriter;
  private readonly transcriptIndex: ThreadTranscriptIndex;
  private readonly transcriptExclusions: ThreadTranscriptExclusions;
  private readonly turnLifecycle: TurnLifecycle;
  private readonly rendererSubmissionMutex = new KeyedMutex();
  private readonly pendingRendererSubmissions = new Set<Promise<unknown>>();
  private initialized = false;
  private closing = false;

  private get threadMutex() { return this.core.threadMutex; }
  private get activeTurns() { return this.turnLifecycle.activeTurnsForInspection(); }
  private get pendingUserInputs() { return this.turnLifecycle.pendingUserInputsForInspection(); }
  constructor(options: ThreadServiceOptions) {
    this.executor = options.executor;
    this.extensions = options.extensions;
    this.core = new ThreadCore(
      options.stores.metadata,
      options.stores.history,
      options.stores.rollout,
      options.stores.payloads,
      options.stores.resources,
      this.extensions,
    );
    this.reportError = async (report) => { await options.reportError?.(report); };
    this.getDocumentProjection = options.getDocumentProjection ?? (() => null);
    this.resolveReferencedAsset = options.resolveReferencedAsset;
    this.resolveSkillAdmission = async (input) => await options.resolveSkillAdmission?.(input) ?? {
      catalogSnapshot: null,
      preloadedInvocations: [],
      invocation: null,
    };
    const reportConfigurationReadFailure: AgentConfigurationReadFailureReporter = (report) => {
      void this.reportError(report).catch((error) => {
        console.warn('[agent] Failed to report a degraded configuration read', error);
      });
    };
    this.resolveIdentityCatalog = (cwd) => (
      options.resolveIdentityCatalog?.(cwd, reportConfigurationReadFailure) ?? []
    );
    // Null when nothing resolves it: the environment then says what it said
    // before there was a configured name, rather than inventing one.
    this.resolvePersona = (thread) => (
      options.resolvePersona?.(thread, reportConfigurationReadFailure) ?? null
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
    this.delegationCoordinator = options.delegationCoordinator ?? (() => null);
    this.goalStore = options.stores.goals;
    this.toolTasks = new ToolTaskService(
      options.stores.toolTasks,
      options.toolTaskDetailRoot ?? join(options.transcriptRoot, '..', 'tool-tasks'),
      options.toolTaskSupervisorRuntime,
      this.now,
    );
    this.resourceOps = new ThreadResourceOps(
      this.core,
      options.stores.resources,
      options.attachmentScratchRoot,
      options.resolveUserContent ?? ((content) => content),
    );
    this.historyReferences = new ThreadHistoryReferenceService(
      this.core,
      this.resourceOps,
      (threadId) => !this.unreadableThreadIds.has(threadId),
      this.now,
    );
    this.transcriptExclusions = new ThreadTranscriptExclusions(options.transcriptRoot);
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
        readInternalTextProjection: (ref, maxPrefixChars) => (
          this.core.payloads.readInternalTextProjection(threadId, ref, maxPrefixChars)
        ),
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
        replaceLatestTurnForRerunWithLocksHeld: (...args) => (
          this.catalogOps.replaceLatestTurnForRerunWithLocksHeld(...args)
        ),
      },
      { enqueueTurn: (...args) => this.transcripts.enqueueTurn(...args) },
      { noticeFor: async () => NO_DOCUMENT_DRIFT },
      this.executor,
      this.extensions,
      this.getDocumentProjection,
      this.resolveReferencedAsset,
      this.resolveSkillAdmission,
      (thread) => this.resolvePersona(thread),
      { addUsage: (...args) => this.goals.addUsage(...args) },
      options.normalizeOutputImage,
      this.now,
      (message, rendererSubmissionRetryable) => new ThreadBusyError(message, rendererSubmissionRetryable),
      (error) => error instanceof ThreadBusyError,
    );
    this.trajectory = new ThreadTrajectoryProjection(
      this.core,
      this.now,
      (threadId, turnId) => this.turnLifecycle.activeTurnDiagnosticsForInspection(threadId, turnId),
    );
    this.catalogOps = new ThreadCatalogOps(
      this.core,
      this.resourceOps,
      this.extensions,
      options.nameGenerator ?? null,
      options.resolveConfiguration ?? defaultConfiguration,
      options.resolveRendererStartDefaults ?? missingRendererStartDefaults,
      options.resolveRootWorkspace,
      options.cleanupRootWorkspace,
      options.ownsRootWorkspace,
      options.validateRendererConfiguration ?? (() => undefined),
      options.onRendererConfigurationCommitted,
      this.now,
      () => this.closing,
      this.turnLifecycle,
      (threadId) => options.stores.toolTasks.hasBlockingWork(threadId),
      {
        delete: (threadId) => this.transcripts.delete(threadId),
        forgetExclusions: (sessionIds) => this.transcriptExclusions.forget(sessionIds),
      },
      (threadId) => this.goals.clear(threadId),
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
    this.extensions.register(this.goals, { applicationInstructions: true });
    this.toolTasks.bindHost({
      ownerExists: (threadId) => this.core.metadata.read(threadId) !== null || this.core.ephemeral.has(threadId),
      readDeliveryAdmission: async (threadId, turnId) => {
        const rollout = await this.core.rollout.read(threadId);
        for (const entry of [...rollout].reverse()) {
          const event = entry.event.type === 'history/rerun' ? entry.event.replacement : entry.event;
          if (event.type === 'turn/started' && event.turnId === turnId) {
            return event.toolTaskAdmission ?? null;
          }
        }
        return null;
      },
      reconcileTask: async (task, _producerContext, receipt) => {
        if (task.producer !== 'delegate') return { outcome: 'preserve' };
        const coordinator = options.delegationCoordinator?.();
        if (!coordinator) {
          return {
            outcome: 'replace',
            state: 'failed',
            reason: 'delegation_coordination_failed',
            error: 'Delegation coordinator is unavailable.',
          };
        }
        return delegationTaskReconciliation(await coordinator.settleFinalReceipt({
          taskId: task.taskId,
          preparedResultDigest: receipt.preparedResultDigest,
          receiptDigest: receipt.receiptDigest,
        }));
      },
      beforeStop: async (task, sourceTurnId) => {
        if (task.producer !== 'delegate') return;
        const coordinator = options.delegationCoordinator?.();
        if (!coordinator) throw new Error('Delegation coordinator is unavailable.');
        if (!sourceTurnId) throw new Error('Delegated Tool Task stop requires its source root Turn.');
        const source = this.delegationAdmissionContext(task.ownerThreadId, sourceTurnId);
        if (source.rootUserIntentRevision === null) {
          throw new Error('Delegated Tool Task stop requires a user-authored root Turn.');
        }
        await coordinator.fenceUserStop({
          taskId: task.taskId,
          ownerThreadId: task.ownerThreadId,
          stoppedByRootTurnId: sourceTurnId,
          currentRootIntentRevision: source.rootUserIntentRevision,
        });
      },
      startCompletionTurn: async (input) => Boolean(await this.turnLifecycle.tryStartTurnIfIdle({
        threadId: input.threadId,
        turnId: input.turnId,
        input: [],
        clientUserMessageId: input.clientId,
        additionalContext: input.additionalContext,
        additionalContextResourceRefs: input.additionalContextResourceRefs,
        additionalContextSource: `tool-task-delivery:${input.admission.batchId}`,
        author: { kind: 'host' },
        trigger: { kind: 'feature', feature: 'tool-task-completion', ref: input.admission.batchId },
        toolTaskAdmission: input.admission,
      })),
      settleTask: async (task, producerContext, maxArtifactBytes) => {
        if (task.producer === 'delegate') {
          const bytes = await this.toolTasks.readPreparedResult(task.taskId, task.ownerThreadId);
          if (!bytes) return { artifacts: [], warnings: ['Delegation result evidence is unavailable.'] };
          const result = decodeDelegateExecutionResult(JSON.parse(bytes.toString('utf8')) as unknown);
          const artifacts = [];
          const warnings: string[] = [];
          let artifactBytes = 0;
          for (const artifact of result.artifacts) {
            try {
              const ref = decodeThreadResourceReference(JSON.parse(artifact.ref) as unknown, 'delegate.artifact.ref');
              const available = await this.readThreadResource(task.ownerThreadId, ref);
              if (!available) {
                warnings.push(`Delegation ${artifact.kind} artifact is unavailable.`);
                continue;
              }
              if (artifactBytes + ref.byteLength > maxArtifactBytes) {
                warnings.push(`Delegation ${artifact.kind} artifact exceeds the task detail limit.`);
                continue;
              }
              artifactBytes += ref.byteLength;
              const resolved = await this.resolveThreadResourceFile(task.ownerThreadId, ref);
              artifacts.push({
                ref,
                readablePath: resolved?.path ?? null,
                label: artifact.kind === 'patch' ? 'Delegation patch' : `Delegation ${artifact.kind}`,
              });
            } catch {
              warnings.push(`Delegation ${artifact.kind} artifact reference is invalid.`);
            }
          }
          return { artifacts, warnings };
        }
        const plan = decodeDeclaredOutputArtifactPlan(producerContext);
        if (!plan) {
          return producerContext === null
            ? { artifacts: [], warnings: [] }
            : { artifacts: [], warnings: ['Background task artifact metadata was invalid.'] };
        }
        const artifactSink: ToolArtifactSink = {
          persistBytes: async (input) => {
            const ref = await this.writeThreadResource(
              task.ownerThreadId,
              input.bytes,
              input.mimeType,
              input.fileName,
            );
            const resolved = await this.resolveThreadResourceFile(task.ownerThreadId, ref);
            return { ref, readablePath: resolved?.path ?? null };
          },
          persistFile: async (input) => {
            const ref = await this.captureThreadLocalFile(
              task.ownerThreadId,
              input.path,
              input.mimeType,
              input.fileName,
            );
            const resolved = await this.resolveThreadResourceFile(task.ownerThreadId, ref);
            return { ref, readablePath: resolved?.path ?? null };
          },
        };
        return collectDeclaredOutputArtifacts(
          plan.roots,
          plan.snapshot,
          artifactSink,
          { maxTotalBytes: maxArtifactBytes },
        );
      },
      taskDetailsExpired: async (threadId) => {
        if (!this.core.metadata.read(threadId) && !this.core.ephemeral.has(threadId)) return;
        const canonical = this.resourceOps.threadStorageReferences(threadId).resources;
        await this.core.resources.setThreadReferences(
          threadId,
          [...canonical, ...this.toolTasks.store.artifactReferences(threadId)],
        );
      },
      taskChanged: (task) => {
        if (!this.core.metadata.read(task.ownerThreadId) && !this.core.ephemeral.has(task.ownerThreadId)) return;
        this.core.emitTransientNotification({
          type: 'toolTask/changed',
          threadId: task.ownerThreadId,
          task,
        });
      },
    });
    this.core.subscribe((notification) => {
      if (notification.type === 'turn/completed' || notification.type === 'thread/status/changed') {
        this.toolTasks.wakeDelivery(notification.threadId);
      }
    });
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
        toolTasks: new ToolTaskStore(goalsDatabase),
        agentStartupContexts,
        payloads: new ToolPayloadStore(paths.payloads),
        resources: new AgentResourceStore(
          paths.resourceReferences,
          join(userDataPath, 'content'),
          options.attachmentScratchRoot,
          options.now ?? Date.now,
        ),
      },
      toolTaskDetailRoot: paths.toolTasks,
    });
  }
  async initialize(): Promise<void> {
    if (this.initialized) return;
    // Before any Turn can complete: the subject resolver reads this synchronously.
    await this.transcriptExclusions.load();
    const knownThreadIds: ThreadId[] = [];
    const reconciledThreadIds: ThreadId[] = [];
    const resumableThreadIds: ThreadId[] = [];
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      do {
        const page = this.core.metadata.list({ archived, cursor, limit: 100 });
        for (const thread of page.data) {
          knownThreadIds.push(thread.id);
          let reconciled = false;
          try {
            await this.catalogOps.reconcileThread(thread.id);
            reconciled = true;
          } catch (error) {
            console.error(`[agent] failed to reconcile Thread ${thread.id}`, error);
          }
          // Reconciliation failing is survivable and deliberately not disqualifying:
          // a torn rollout leaves a Thread that no longer advances but still reads
          // out of its projection, and that history stays browsable. What the launch
          // cannot survive is a Thread whose history does not READ, because the
          // startup fan-out over Threads is not guarded per Thread. So the question
          // asked here is exactly the one that matters — does this Thread decode? —
          // and only a Thread that fails it is quarantined (A12).
          //
          // This runs BEFORE the Thread joins either list, and both lists are then
          // gated on the verdict: reconciliation decodes every Item but only the
          // newest Turn row, so a Thread can reconcile and still fail to read. The
          // payload-prune fan-out below walks `allTurns` for every reconciled id
          // with no guard of its own, and resume refuses a quarantined Thread — so
          // admitting one to either list is how a caught failure becomes an
          // uncaught one.
          await this.quarantineThreadIfUnreadable(thread.id);
          if (!reconciled || this.startupQuarantinedThreadIds.has(thread.id)) continue;
          reconciledThreadIds.push(thread.id);
          if (!archived) resumableThreadIds.push(thread.id);
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    const knownThreads = new Set(knownThreadIds);
    const liveResourceReferences = new Map<ThreadId, readonly ThreadResourceReference[]>();
    let resourceSnapshotComplete = true;
    for (const threadId of knownThreadIds) {
      if (this.startupQuarantinedThreadIds.has(threadId)) {
        resourceSnapshotComplete = false;
        continue;
      }
      try {
        liveResourceReferences.set(threadId, [
          ...this.resourceOps.threadResourceReferences(threadId),
          ...this.toolTasks.store.artifactReferences(threadId),
        ]);
      } catch (error) {
        resourceSnapshotComplete = false;
        console.warn(`[agent] Resource reference reconciliation deferred for Thread ${threadId}`, error);
      }
    }
    await this.core.resources.initialize(liveResourceReferences, { complete: resourceSnapshotComplete });
    await Promise.all([
      // Transcript reclamation is the same kind of work as payload pruning, so it
      // joins the same startup batch rather than adding a serial step.
      this.transcripts.sweepOrphans((threadId) => (
          // Reconciliation, not just reclamation: an artifact whose removal
          // failed or was interrupted mid-exclusion is still on disk, and
          // nothing else would ever come back for it — the Thread is excluded,
          // so it never rewrites the file that would notice.
          knownThreads.has(threadId) && !this.isSessionExcluded(threadId)
        ))
        // Rebuild the index once the artifact set has settled: it is a
        // projection of that set, so recomputing it earlier would only describe
        // a directory that is about to change.
        .then(() => { this.transcriptIndex.schedule(); }),
      ...reconciledThreadIds.flatMap((threadId) => {
        const references = this.resourceOps.threadStorageReferences(threadId);
        return [
          this.core.resources.setThreadReferences(threadId, references.resources),
          this.core.payloads.pruneUnreferencedContexts(threadId, references.contexts, references.internalTexts),
          this.core.payloads.pruneUnreferencedTurnDiagnostics(threadId, references.diagnostics),
          this.core.payloads.pruneUnreferencedTextOutputs(threadId, references.textOutputs),
        ];
      }),
    ]);
    const resumableThreads: Thread[] = [];
    for (const threadId of resumableThreadIds) {
      try {
        const { thread } = await this.resumeThread(threadId);
        resumableThreads.push(thread);
      } catch (error) {
        // Same blast radius as reconciliation above: resume reads the Thread's
        // history, so a Thread that reconciled but cannot be projected still has
        // to cost only itself.
        console.error(`[agent] failed to resume Thread ${threadId}`, error);
        // Already quarantined means this Thread was swept up in an ancestor's
        // subtree between passing its own probe and being resumed — a background
        // delegated Agent sorts ahead of its parent under `updated_at DESC`, so
        // this happens. The refusal it hit is an availability check, not a decode
        // failure, and reporting it would name a perfectly readable Thread in the
        // one durable trace quarantine leaves.
        if (this.startupQuarantinedThreadIds.has(threadId)) continue;
        this.markThreadUnreadable(threadId);
        await this.reportUnreadableThread(threadId, 'resume', error);
      }
    }
    await this.toolTasks.initialize();
    await this.beforeInitialTurnAdmission();
    this.initialized = true;
    for (const thread of resumableThreads) {
      if (thread.status.type === 'idle') {
        await this.extensions.threadIdle(this.core.requireThread(thread.id).thread);
      }
    }
  }

  private async quarantineThreadIfUnreadable(threadId: ThreadId): Promise<void> {
    if (this.unreadableThreadIds.has(threadId)) return;
    try {
      // Page and discard rather than `readThread({ includeTurns: true })`: the
      // check needs every Turn and Item decoded, but nothing needs them all
      // resident at once, and this runs for every Thread on the launch path (A9).
      let cursor: string | null = null;
      do {
        const page: ThreadTurnsListResponse = this.core.history.listTurns({
          threadId,
          cursor,
          limit: 50,
          itemsView: 'full',
        });
        cursor = page.nextCursor;
      } while (cursor);
    } catch (error) {
      console.error(`[agent] quarantined unreadable Thread ${threadId}`, error);
      this.markThreadUnreadable(threadId);
      await this.reportUnreadableThread(threadId, 'read', error);
    }
  }

  /**
   * The only durable trace a quarantined Thread leaves. Quarantine is in-memory
   * and recomputed every launch, so nothing on disk records that this happened —
   * without this report a Thread would just quietly stop appearing.
   */
  private async reportUnreadableThread(
    threadId: ThreadId,
    operation: 'read' | 'resume',
    error: unknown,
  ): Promise<void> {
    try {
      await this.reportError({
        domain: 'persistence',
        severity: 'error',
        code: 'thread-history-unreadable',
        message: 'A Thread\'s recorded history could not be read and the Thread was quarantined for this session.',
        context: { operation: `startup-${operation}`, threadId },
        error,
      });
    } catch {
      console.warn(`[agent] Failed to report an unreadable Thread: ${threadId}`);
    }
  }

  /**
   * The single writer of unreadability. Both quarantine sets are always set
   * together here, because the read guard keys off one and the root enumeration
   * off the other, and updating only one is what previously let a session-scoped
   * quarantine become a permanent delete.
   */
  private markThreadUnreadable(threadId: ThreadId): void {
    this.unreadableThreadIds.add(threadId);
    this.quarantineStartupSubtree(threadId);
  }

  private quarantineStartupSubtree(threadId: ThreadId): void {
    this.startupQuarantinedThreadIds.add(threadId);
    if (!this.core.metadata.read(threadId)) return;
    for (const edge of this.core.metadata.childEdges(threadId, true)) {
      this.startupQuarantinedThreadIds.add(edge.childThreadId);
    }
  }

  /** History reads use the narrow unreadable-history quarantine. */
  private assertThreadHistoryReadable(threadId: ThreadId): void {
    if (!this.unreadableThreadIds.has(threadId)) return;
    throw new ThreadBusyError(
      `Thread history could not be read and the Thread is quarantined for this session: ${threadId}`,
    );
  }

  private assertStartupThreadAvailable(threadId: ThreadId): void {
    if (this.startupQuarantinedThreadIds.has(threadId)) {
      throw new ThreadBusyError(`Thread is quarantined because its history is unreadable: ${threadId}`);
    }
  }
  async close(drainTimeoutMs = THREAD_SERVICE_CLOSE_DRAIN_TIMEOUT_MS): Promise<void> {
    this.closing = true;
    await this.toolTasks.close(drainTimeoutMs);
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
    while (Date.now() < drainDeadline) {
      const active = [...this.activeTurns.values()];
      for (const turn of active) turn.controller.abort();
      const turnsDrained = await settleBeforeDeadline(
        Promise.allSettled(active.map((turn) => turn.completion)),
        drainDeadline,
      );
      if (!turnsDrained) break;
      if (this.activeTurns.size === 0) break;
    }
    if (this.activeTurns.size > 0) {
      for (const turn of this.activeTurns.values()) turn.controller.abort();
      console.warn(`[agent] Thread shutdown timed out with ${this.activeTurns.size} active Turn(s)`);
    }
    if (!await this.transcripts.flushAll(drainDeadline)) {
      console.warn('[agent] Thread shutdown timed out with transcript writes pending');
    }
    await this.transcriptIndex.flush();
    const failures: unknown[] = [];
    const operations = await Promise.allSettled([
      this.core.flush(),
      this.core.rollbackRecovery.close(),
      (async () => {
        await this.core.resources.abortAllUploads();
        await Promise.all([...this.core.ephemeral.keys()].map(async (threadId) => {
          await this.core.payloads.deleteThread(threadId);
          await this.core.resources.deleteThread(threadId);
        }));
        await this.core.resources.close();
      })(),
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
  subscribeRenderer(listener: NotificationListener): () => void {
    return this.core.subscribe((notification) => {
      const hidden = notification.type === 'thread/started'
        ? notification.thread.threadSource === 'delegation'
        : this.isDelegationThread(notification.threadId);
      if (!hidden) listener(notification);
    });
  }
  async waitForIdle(threadId: ThreadId): Promise<void> { return this.turnLifecycle.waitForIdle(threadId); }
  /**
   * Host-facing enumeration, so it must exclude quarantined Threads: extensions
   * fan out over this list and read each Thread's turns, and `MemoryExtension`
   * does so during `beforeInitialTurnAdmission` — inside `initialize`, with no
   * per-Thread guard. That is the path on which one unreadable Thread used to
   * take the process down at launch, after reconciliation had already caught the
   * same failure and moved on.
   */
  persistentRootThreads(): readonly Thread[] {
    return this.catalogOps.persistentRootThreads()
      .filter((thread) => !this.isHiddenFromRootEnumeration(thread.id));
  }

  /**
   * Whether this session is enumerating an incomplete view of the root Threads.
   * Consumers that delete on absence — the memory orphan-admission sweep — must
   * not read a hidden Thread's Turns as gone.
   *
   * Deliberately asks the same predicate `persistentRootThreads()` filters on,
   * rather than tracking a parallel set: the first version of this pair kept two
   * sets and they promptly diverged, which is how a session-scoped quarantine
   * turned into a permanent delete. One predicate cannot disagree with itself.
   */
  hasHiddenRootThreads(): boolean {
    return this.catalogOps.persistentRootThreads()
      .some((thread) => this.isHiddenFromRootEnumeration(thread.id));
  }

  private isHiddenFromRootEnumeration(threadId: ThreadId): boolean {
    return this.startupQuarantinedThreadIds.has(threadId);
  }
  persistentThreadExecutionContext(threadId: ThreadId): PersistentThreadExecutionContext { return this.catalogOps.persistentThreadExecutionContext(threadId); }
  readTurnForHost(threadId: ThreadId, turnId: TurnId): Turn | null { return this.core.readTurn(threadId, turnId); }
  delegationAdmissionContext(threadId: ThreadId, turnId: TurnId): {
    readonly thread: Thread;
    readonly configuration: EffectiveThreadConfiguration;
    readonly rootUserIntentRevision: number | null;
  } {
    const record = this.core.requireThread(threadId);
    if (record.archived || record.thread.parentThreadId !== null || record.thread.threadSource !== 'user') {
      throw new Error('Delegation may be launched only by an active root Thread.');
    }
    const turns = this.core.allTurns(threadId);
    const sourceIndex = turns.findIndex((turn) => turn.id === turnId);
    if (sourceIndex < 0) throw new Error(`Delegation source Turn is unavailable: ${turnId}`);
    const rootUserIntentRevision = turns.slice(0, sourceIndex + 1)
      .filter((turn) => turn.provenance.trigger.kind === 'user').length || null;
    return { thread: record.thread, configuration: record.configuration, rootUserIntentRevision };
  }
  async ensureDelegationThread(session: DelegationSessionBinding): Promise<Thread> {
    const cwd = delegationSessionCwd(session);
    const existing = this.core.metadata.read(session.sessionId);
    if (existing) {
      if (existing.archived
        || existing.thread.parentThreadId !== session.ownerThreadId
        || existing.thread.threadSource !== 'delegation'
        || existing.thread.cwd !== cwd) {
        throw new Error(`Existing Thread does not match the Delegation Session: ${session.sessionId}`);
      }
      return existing.thread;
    }
    const owner = this.core.requireThread(session.ownerThreadId);
    const configuration = Object.freeze({
      ...owner.configuration,
      model: session.policy.modelId ?? owner.configuration.model,
      reasoningEffort: session.policy.effort ?? owner.configuration.reasoningEffort,
      preloadedSkills: Object.freeze([]),
    });
    return this.catalogOps.createThread({
      id: session.sessionId,
      name: 'Delegated session',
      ephemeral: false,
      source: 'agent.delegation',
      threadSource: 'delegation',
      modelProvider: session.policy.modelProvider ?? owner.thread.modelProvider,
      cwd,
    }, {
      sessionId: session.sessionId,
      parentThreadId: session.ownerThreadId,
      forkedFromId: null,
      configuration,
      toolCeiling: owner.toolCeiling,
      taskPath: `/delegation/${session.sessionId}`,
      nameOrigin: 'derived',
      hidden: true,
    });
  }
  async interruptDelegationTurn(threadId: ThreadId, turnId: TurnId): Promise<void> {
    await this.turnLifecycle.interruptTurn(threadId, turnId);
  }
  async closeDelegationThread(threadId: ThreadId): Promise<void> {
    const thread = this.core.metadata.read(threadId)?.thread ?? this.core.ephemeral.get(threadId)?.record.thread;
    if (!thread) return;
    if (thread.threadSource !== 'delegation') throw new Error(`Thread is not a Delegation Session: ${threadId}`);
    await this.waitForIdle(threadId);
  }
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
    if (method === 'thread/start') {
      const source = (decoded as AgentCoreRequestByMethod['thread/start']).threadSource;
      if (source !== undefined && source !== 'user') {
        throw new Error('Renderer-created Threads must use the user Thread source');
      }
    } else {
      const threadId = rendererRequestThreadId(decoded);
      if (threadId !== null && this.isDelegationThread(threadId)) {
        throw new Error('Delegation Threads are available only to privileged Host operations.');
      }
    }
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
      case 'thread/references/search':
        return this.searchThreadReferences(
          decoded as AgentCoreRequestByMethod['thread/references/search'],
        ) as AgentCoreResponseByMethod[Method];
      case 'thread/references/resolve':
        return this.resolveThreadReferences(
          decoded as AgentCoreRequestByMethod['thread/references/resolve'],
        ) as AgentCoreResponseByMethod[Method];
      case 'thread/tasks/list':
        return this.listThreadToolTasks(
          decoded as AgentCoreRequestByMethod['thread/tasks/list'],
        ) as AgentCoreResponseByMethod[Method];
      case 'thread/read':
        return this.readThread(decoded as AgentCoreRequestByMethod['thread/read']) as AgentCoreResponseByMethod[Method];
      case 'task/read': {
        const request = decoded as AgentCoreRequestByMethod['task/read'];
        return await this.readToolTask(request) as AgentCoreResponseByMethod[Method];
      }
      case 'task/stop': {
        const request = decoded as AgentCoreRequestByMethod['task/stop'];
        const task = await this.toolTasks.stop(request.taskId, request.threadId);
        if (!task) throw new Error(`Tool Task not found: ${request.taskId}`);
        return { task: this.toolTasks.read(task.taskId, request.threadId)! } as AgentCoreResponseByMethod[Method];
      }
      case 'task/details/clear': {
        const request = decoded as AgentCoreRequestByMethod['task/details/clear'];
        const result = await this.toolTasks.clearEligibleDetails(request.threadId);
        return { data: result.tasks, reclaimedBytes: result.reclaimedBytes } as AgentCoreResponseByMethod[Method];
      }
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
      case 'identities/get': {
        const request = decoded as AgentCoreRequestByMethod['identities/get'];
        // A Thread names the project layer to read. An unreadable or absent
        // Thread is not an error here: the user layer alone is a complete
        // answer, and a dock that cannot name its participants is worse than
        // one that names them from built-ins.
        const cwd = request.threadId === null
          ? null
          : this.core.metadata.read(request.threadId)?.thread.cwd ?? null;
        return {
          entries: this.resolveIdentityCatalog(cwd ?? homedir()),
        } as AgentCoreResponseByMethod[Method];
      }
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
      case 'thread/item/arguments/read':
        return await this.resourceOps.readItemArguments(
          decoded as AgentCoreRequestByMethod['thread/item/arguments/read'],
        ) as AgentCoreResponseByMethod[Method];
      case 'thread/context/read':
        return await this.readContextPayload(
          decoded as AgentCoreRequestByMethod['thread/context/read'],
        ) as AgentCoreResponseByMethod[Method];
      case 'thread/turn/details/read':
        return await this.readTurnDetails(
          decoded as AgentCoreRequestByMethod['thread/turn/details/read'],
        ) as AgentCoreResponseByMethod[Method];
      case 'thread/trajectory/read':
        return await this.readTrajectory(
          decoded as AgentCoreRequestByMethod['thread/trajectory/read'],
        ) as AgentCoreResponseByMethod[Method];
      case 'thread/trajectory/detail/read':
        return await this.readTrajectoryDetail(
          decoded as AgentCoreRequestByMethod['thread/trajectory/detail/read'],
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
      case 'turn/recovery/read':
        return await this.readTurnRecovery(
          decoded as AgentCoreRequestByMethod['turn/recovery/read'],
        ) as AgentCoreResponseByMethod[Method];
      case 'turn/continue':
        return await this.continueTurn(
          decoded as AgentCoreRequestByMethod['turn/continue'],
        ) as AgentCoreResponseByMethod[Method];
      case 'turn/rerun':
        return await this.rerunTurn(
          decoded as AgentCoreRequestByMethod['turn/rerun'],
        ) as AgentCoreResponseByMethod[Method];
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
    this.assertThreadHistoryReadable(request.threadId);
    return this.catalogOps.listTurns(request);
  }
  searchThreadReferences(request: ThreadReferenceSearchRequest): ThreadReferenceSearchResponse {
    return this.historyReferences.searchReferences(request);
  }
  resolveThreadReferences(request: ThreadReferenceResolveRequest): ThreadReferenceResolveResponse {
    return this.historyReferences.resolveReferences(request);
  }
  searchThreadHistoryForAgent(input: AgentThreadSearchInput): readonly AgentThreadSearchResult[] {
    return this.historyReferences.searchForAgent(input);
  }
  async readThreadHistoryForAgent(input: AgentThreadReadInput): Promise<AgentThreadReadResult> {
    return this.historyReferences.readForAgent(input);
  }
  async readItemOutput(request: ThreadItemOutputReadRequest): Promise<ThreadItemOutputReadResponse> { return this.resourceOps.readItemOutput(request); }
  async readContextPayload(request: ThreadContextReadRequest): Promise<ThreadContextReadResponse> { return this.resourceOps.readContextPayload(request); }
  async readTurnDetails(request: ThreadTurnDetailsReadRequest): Promise<ThreadTurnDetailsReadResponse> { return this.resourceOps.readTurnDetails(request); }
  async readTrajectory(request: ThreadTrajectoryReadRequest): Promise<ThreadTrajectoryReadResponse> {
    this.assertThreadHistoryReadable(request.threadId);
    return await this.trajectory.read(request);
  }
  async readTrajectoryDetail(
    request: ThreadTrajectoryDetailReadRequest,
  ): Promise<ThreadTrajectoryDetailReadResponse> {
    this.assertThreadHistoryReadable(request.threadId);
    return await this.trajectory.readDetail(request);
  }
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
  async resolveThreadResourceSource(
    threadId: ThreadId,
    ref: ThreadResourceReference,
  ): Promise<ResolvedThreadResourceFile | null> {
    return this.resourceOps.resolveThreadResourceSource(threadId, ref);
  }
  async resolveImageArtifactFile(
    threadId: ThreadId,
    artifact: ThreadImageArtifactReference,
  ): Promise<ResolvedThreadImageArtifactFile | null> {
    return this.resourceOps.resolveImageArtifactFile(threadId, artifact);
  }
  async captureThreadLocalFile(
    threadId: ThreadId,
    sourcePath: string,
    mimeType: string,
    fileName: string,
  ): Promise<ThreadResourceReference> {
    this.core.requireThread(threadId);
    return (await this.core.resources.capturePath({
      threadId,
      sourcePath,
      mimeType,
      fileName,
    })).ref;
  }
  listItems(request: ThreadItemsListRequest): ThreadItemsListResponse {
    this.assertThreadHistoryReadable(request.threadId);
    return this.catalogOps.listItems(request);
  }
  listThreads(request: ThreadListRequest = {}): ThreadListResponse { return this.catalogOps.listThreads(request); }
  readThread(request: ThreadReadRequest): ThreadReadResponse {
    // Only the history read is refused. A metadata-only read never touches the
    // codec, and the sidebar still has to name the Thread it cannot open.
    if (request.includeTurns) this.assertThreadHistoryReadable(request.threadId);
    return this.catalogOps.readThread(request);
  }
  listThreadToolTasks(request: ThreadToolTasksRequest): ThreadToolTasksResponse {
    this.core.requireThread(request.threadId);
    return { data: this.toolTasks.list(request.threadId) };
  }
  async readToolTask(request: ToolTaskReadRequest): Promise<ToolTaskReadResponse> {
    this.core.requireThread(request.threadId);
    const task = this.toolTasks.read(request.taskId, request.threadId);
    if (!task) throw new Error(`Tool Task not found: ${request.taskId}`);
    return { task, output: await this.toolTasks.output(request.taskId, request.threadId) };
  }
  toolTaskService(): ToolTaskService { return this.toolTasks; }
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
    const subtreeIds = this.threadSubtreeIds(threadId);
    if (archived && subtreeIds.some((candidate) => this.toolTasks.store.hasBlockingWork(candidate))) {
      throw new ThreadBusyError('Cannot archive a Thread with active or undelivered Tool Tasks');
    }
    if (archived) await this.delegationCoordinator()?.closeOwnerSessions(threadId);
    await this.catalogOps.setThreadArchived(threadId, archived);
    this.transcriptIndex.schedule();
  }
  async deleteThread(threadId: ThreadId): Promise<void> {
    const subtreeIds = this.threadSubtreeIds(threadId);
    if (subtreeIds.some((candidate) => this.toolTasks.store.hasBlockingWork(candidate))) {
      throw new ThreadBusyError('Cannot delete a Thread with active or undelivered Tool Tasks');
    }
    const delegation = this.delegationCoordinator();
    await delegation?.prepareOwnerDeletion(threadId);
    await this.catalogOps.deleteThread(threadId);
    for (const candidate of subtreeIds) await this.toolTasks.deleteOwner(candidate);
    delegation?.deleteOwnerSessions(threadId);
  }

  private threadSubtreeIds(threadId: ThreadId): readonly ThreadId[] {
    return [
      threadId,
      ...this.core.metadata.childEdges(threadId, true).map((edge) => edge.childThreadId),
    ];
  }
  async startRendererTurn(request: RendererTurnStartRequest): Promise<TurnStartResponse> {
    this.assertStartupThreadAvailable(request.threadId);
    return this.turnLifecycle.startRendererTurn(request);
  }
  async submitRendererInput(request: RendererTurnSubmitRequest): Promise<TurnSubmitResponse> {
    this.assertStartupThreadAvailable(request.threadId);
    const submission = this.rendererSubmissionMutex.run(request.threadId, async () => {
      this.assertRendererSubmissionOpen();
      if (this.turnLifecycle.isRendererContextCommand(request.input)) {
        const response = await this.turnLifecycle.startRendererTurn(
          request,
          undefined,
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
            const response = await this.turnLifecycle.steerRendererTurn({
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
          const response = await this.turnLifecycle.startRendererTurn(
            request,
            undefined,
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
  async readTurnRecovery(request: TurnRecoveryReadRequest): Promise<TurnRecoveryReadResponse> {
    this.assertStartupThreadAvailable(request.threadId);
    await this.waitForTurnRecoveryFinalization(request);
    return this.readTurnRecoveryNow(request);
  }
  private async waitForTurnRecoveryFinalization(request: TurnRecoveryReadRequest): Promise<void> {
    const observedTarget = this.core.allTurns(request.threadId).at(-1);
    if (
      observedTarget?.id === request.turnId
      && observedTarget.status !== 'inProgress'
      && this.turnLifecycle.activeTurnId(request.threadId) === request.turnId
    ) {
      await this.turnLifecycle.waitForTurnCompletion(request.threadId, request.turnId);
    }
  }
  private async readTurnRecoveryNow(request: TurnRecoveryReadRequest): Promise<TurnRecoveryReadResponse> {
    this.assertStartupThreadAvailable(request.threadId);
    const record = this.core.requireThread(request.threadId);
    const target = this.core.allTurns(request.threadId).at(-1);
    const available = target?.id === request.turnId
      && record.thread.parentThreadId === null
      && record.thread.threadSource === 'user'
      && !record.thread.ephemeral
      && !record.archived
      && !this.core.stoppingThreads.has(request.threadId)
      && !this.turnLifecycle.hasActiveTurn(request.threadId)
      && record.thread.status.type === 'idle';
    if (!available || !target) {
      return { canContinue: false, canRerun: false, rerunRequiresConfirmation: false };
    }
    const canRerun = isRerunnableTurn(target)
      && target.items.some((item) => item.type === 'userMessage');
    const rerunRequiresConfirmation = canRerun && turnHasSettledTool(target);
    if (target.status !== 'failed') {
      return { canContinue: false, canRerun, rerunRequiresConfirmation };
    }
    let canContinue = false;
    try {
      canContinue = await this.turnLifecycle.canContinueFromFailure(request.threadId, target);
    } catch (error) {
      console.warn(`[agent] Continue-from-failure projection unavailable for ${target.id}`, error);
    }
    return { canContinue, canRerun, rerunRequiresConfirmation };
  }
  async continueTurn(request: TurnContinueRequest): Promise<TurnContinueResponse> {
    this.assertStartupThreadAvailable(request.threadId);
    const continuation = this.rendererSubmissionMutex.run(request.threadId, async () => {
      this.assertRendererSubmissionOpen();
      await this.waitForTurnRecoveryFinalization(request);
      this.assertRendererSubmissionOpen();
      return this.core.hostRootMutex.run(async () => {
        this.assertRendererSubmissionOpen();
        const recovery = await this.readTurnRecoveryNow(request);
        if (!recovery.canContinue) throw new Error('This Turn cannot continue from failure');
        const target = this.core.allTurns(request.threadId).at(-1);
        if (!target || target.id !== request.turnId) throw new Error('Only the latest failed Turn can be continued');
        const started = await this.turnLifecycle.startContinuedRootTurnWithHostLock(
          request.threadId,
          target.id,
          () => this.assertRendererSubmissionOpen(),
        );
        return {
          thread: this.core.requireThread(request.threadId).thread,
          turn: started.turn,
          sourceTurnId: target.id,
        };
      });
    });
    this.pendingRendererSubmissions.add(continuation);
    try {
      return await continuation;
    } finally {
      this.pendingRendererSubmissions.delete(continuation);
    }
  }
  async rerunTurn(request: TurnRerunRequest): Promise<TurnRerunResponse> {
    this.assertStartupThreadAvailable(request.threadId);
    const rerun = this.rendererSubmissionMutex.run(request.threadId, async () => (
      this.core.hostRootMutex.run(async () => {
        this.assertRendererSubmissionOpen();
        const record = this.core.requireThread(request.threadId);
        if (record.thread.parentThreadId !== null
          || record.thread.threadSource !== 'user'
          || record.thread.ephemeral
          || record.archived) {
          throw new Error('Only a persistent root user Thread can rerun a Turn');
        }
        const turns = this.core.allTurns(request.threadId);
        const target = turns.at(-1);
        if (!target || target.id !== request.turnId) {
          throw new Error('Only the latest Turn can be rerun');
        }
        if (this.turnLifecycle.hasActiveTurn(request.threadId) || record.thread.status.type !== 'idle') {
          throw new ThreadBusyError('Cannot rerun a Thread with active work');
        }
        if (!isRerunnableTurn(target)) throw new Error('This Turn cannot be rerun');
        if (turnHasSettledTool(target) && !request.confirmToolReplay) {
          throw new Error('Rerun confirmation is required because actions may repeat');
        }
        const inputBatches: CanonicalTurnRerunInputBatch[] = [];
        let pendingEvidence: Array<Extract<ThreadItem, { readonly type: 'contextEvidence' }>> = [];
        for (const item of target.items) {
          if (item.type === 'contextEvidence') {
            // Every persistent input admission starts with turnEnvironment.
            // Drop runtime-only evidence accumulated after the prior input when
            // the next atomic admission batch begins.
            if (item.kind === 'turnEnvironment' && inputBatches.length > 0) pendingEvidence = [];
            pendingEvidence.push(item);
            continue;
          }
          if (item.type !== 'userMessage') {
            pendingEvidence = [];
            continue;
          }
          const stagedContextEvidence: StagedContextEvidence[] = [];
          for (const evidence of pendingEvidence) {
            const payload = await this.core.payloads.readContext(request.threadId, evidence.payloadRef);
            if (!payload || payload.kind !== evidence.kind) {
              throw new Error(`Rerun context evidence is unavailable: ${evidence.id}`);
            }
            stagedContextEvidence.push({
              payload: payload as StagedContextEvidence['payload'],
              payloadRef: evidence.payloadRef,
              contextRefs: evidence.contextRefs,
              internalTextRefs: evidence.internalTextRefs,
              resourceRefs: evidence.resourceRefs,
              outputRefs: evidence.outputRefs,
              summary: evidence.summary,
            });
          }
          inputBatches.push({
            author: item.author,
            input: item.content,
            clientUserMessageId: item.clientId,
            acceptedAt: item.acceptedAt,
            stagedContextEvidence,
          });
          pendingEvidence = [];
        }
        if (inputBatches.length === 0) throw new Error('Rerun input is missing from the canonical Turn');

        const started = await this.turnLifecycle.startRerunRootTurnWithHostLock({
          threadId: request.threadId,
          trigger: target.provenance.trigger,
          inputBatches,
          replacedTurn: target,
        }, () => this.assertRendererSubmissionOpen());
        return {
          thread: this.core.requireThread(request.threadId).thread,
          turn: started.turn,
          replacedTurnId: target.id,
        };
      })
    ));
    this.pendingRendererSubmissions.add(rerun);
    try {
      return await rerun;
    } finally {
      this.pendingRendererSubmissions.delete(rerun);
    }
  }
  async tryStartTurnIfIdle(request: PrivilegedTurnStartRequest): Promise<Turn | null> {
    this.assertStartupThreadAvailable(request.threadId);
    return this.turnLifecycle.tryStartTurnIfIdle(request);
  }
  async steerTurn(
    request: RendererTurnSteerRequest,
    deliveryFailureMode: 'fatal' | 'advisory' = 'fatal',
  ): Promise<TurnSteerResponse> {
    this.assertStartupThreadAvailable(request.threadId);
    return this.turnLifecycle.steerRendererTurn(request, deliveryFailureMode);
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
    await this.turnLifecycle.interruptTurn(threadId, turnId);
  }
  /** Stop reaches only a user's own conversations. */
  private assertUserOwnedLineage(threadId: ThreadId): void {
    const thread = this.core.requireThread(threadId).thread;
    if (thread.parentThreadId !== null || thread.threadSource !== 'user') {
      throw new Error(`Thread is not a user conversation: ${threadId}`);
    }
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
  /** Test seam: settle a Thread's pending transcript appends. */
  async flushThreadTranscript(threadId: ThreadId): Promise<void> { return this.transcripts.flush(threadId); }
  /** Account layer for a Thread that keeps one: the artifact path, or null when it is not on disk (A12). */
  async threadTranscriptPath(threadId: ThreadId): Promise<string | null> { return this.transcripts.pathForReader(threadId); }
  /** Where past sessions are discoverable. Named by the discovery doctrine, read with the file tools. */
  get threadTranscriptIndexPath(): string { return this.transcriptIndex.path; }
  /** Test seam: settle the index rewrite in flight and anything it owes. */
  async flushThreadTranscriptIndex(): Promise<void> { return this.transcriptIndex.flush(); }
  private transcriptSubject(thread: Thread): TranscriptSubject | null {
    if (this.transcriptExclusions.isExcluded(thread.sessionId)) return null;
    return rootTranscriptSubject(thread);
  }

  /**
   * Whether an artifact's Thread belongs to an excluded session, answered from
   * the Thread id alone because the index only ever has the filename.
   */
  private isSessionExcluded(threadId: ThreadId): boolean {
    const sessionId = this.core.metadata.read(threadId)?.thread.sessionId;
    return sessionId === undefined ? false : this.transcriptExclusions.isExcluded(sessionId);
  }

  /** Whether this Thread is kept in the readable records. */
  isThreadRecorded(threadId: ThreadId): boolean {
    return !this.isSessionExcluded(threadId);
  }

  /** Take a conversation out of the records, or put it back. */
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
  async withThreadAdmissionBarrier<T>(
    threadId: ThreadId,
    operation: (snapshot: ThreadAdmissionBarrierSnapshot) => Promise<T>,
  ): Promise<T> { return this.core.withThreadAdmissionBarrier(threadId, operation); }

  async withHostRootTurnAdmissionBarrier<T>(
    operation: (snapshot: HostRootTurnAdmissionBarrierSnapshot) => Promise<T>,
  ): Promise<T> { return this.core.withHostRootTurnAdmissionBarrier(operation); }

  private isDelegationThread(threadId: ThreadId): boolean {
    const thread = this.core.metadata.read(threadId)?.thread
      ?? this.core.ephemeral.get(threadId)?.record.thread;
    return thread?.threadSource === 'delegation';
  }

}

function delegationSessionCwd(session: DelegationSessionBinding): string {
  if (session.policy.worktreePolicy === 'none') return session.policy.cwd;
  if (session.worktree.kind === 'active' || session.worktree.kind === 'unchanged'
    || session.worktree.kind === 'changed' || session.worktree.kind === 'retained') {
    return session.worktree.metadata.path;
  }
  throw new Error(`Delegation Session has no usable worktree: ${session.sessionId}`);
}

function rendererRequestThreadId(value: unknown): ThreadId | null {
  if (!value || typeof value !== 'object' || !('threadId' in value)) return null;
  const threadId = (value as { readonly threadId?: unknown }).threadId;
  return typeof threadId === 'string' ? threadId : null;
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

function turnHasSettledTool(turn: Turn): boolean {
  return turn.items.some((item) => (
    (item.type === 'commandExecution'
      || item.type === 'fileChange'
      || item.type === 'mcpToolCall'
      || item.type === 'dynamicToolCall'
      || item.type === 'webSearch')
    && item.status !== 'inProgress'
  ));
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
    resourceReferences: join(root, 'resource_references.sqlite'),
    transcripts: threadTranscriptRoot(userDataPath),
    toolTasks: join(root, 'tool-tasks'),
  };
}

function defaultConfiguration(request: ThreadStartRequest): EffectiveThreadConfiguration {
  return defaultEffectiveThreadConfiguration(request.configurationProfile ?? 'default');
}

function missingRendererStartDefaults(): never {
  throw new Error('Thread start requires a model provider and working directory.');
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
