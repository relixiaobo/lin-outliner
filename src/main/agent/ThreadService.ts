import type { Stats } from 'node:fs';
import { join } from 'node:path';
import {
decodeAgentCoreRequest,
decodeAgentCoreResponse
} from '../../core/agent/codec';
import {
type AgentRole,
type EffectiveThreadConfiguration
} from '../../core/agent/configuration';
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
InheritedContextPayload,
JsonValue,
PrivilegedTurnStartRequest,
RendererTurnStartRequest,
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
ThreadListResponse,
ThreadReadRequest,
ThreadReadResponse,
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
TurnSteerRequest,
TurnSteerResponse
} from '../../core/agent/protocol';
import {
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
import { ExtensionRegistry } from './ExtensionRegistry';
import { GoalExtension } from './extensions/goal/GoalExtension';
import { GoalStore } from './extensions/goal/GoalStore';
import {
RolloutStore,
type ThreadHistoryRollbackMarker
} from './persistence/RolloutStore';
import { openSqlite } from './persistence/sqlite';
import {
SubagentBudgetLedger
} from './persistence/SubagentBudgetLedger';
import { ThreadHistoryProjectionStore } from './persistence/ThreadHistoryProjectionStore';
import {
ThreadMetadataStore
} from './persistence/ThreadMetadataStore';
import { ToolPayloadStore } from './persistence/ToolPayloadStore';
import type {
ThreadNameGenerator,
TurnExecutor
} from './runtime/types';
import type { AgentTool } from './runtime/kernel/types';
import { SubagentCollaboration } from './thread/SubagentCollaboration';
import { subagentTranscriptRoot } from './thread/SubagentTranscriptArtifact';
import { ThreadCatalogOps } from './thread/ThreadCatalogOps';
import { ThreadCore,type NotificationListener } from './thread/ThreadCore';
import { ThreadResourceOps } from './thread/ThreadResourceOps';
import { TurnLifecycle } from './thread/TurnLifecycle';

export interface AgentCorePaths {
  readonly root: string;
  readonly rollouts: string;
  readonly state: string;
  readonly history: string;
  readonly goals: string;
  readonly payloads: string;
  /** Subagent transcript artifacts. A sibling of `agent/`, directly under userData. */
  readonly transcripts: string;
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
  /** App-owned root for Subagent transcript artifacts. Never a workspace path. */
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
  /** Account layer: the materialized transcript, or null when the write failed (A12). */
  readonly transcriptPath: string | null;
  readonly error: string | null;
}

export interface CollaborationWaitResult {
  readonly reason: 'terminal' | 'steering' | 'idle';
  readonly updates: readonly CollaborationTerminalOutcome[];
  readonly agents: readonly CollaborationAgentView[];
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
  private readonly turnLifecycle: TurnLifecycle;
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
    this.turnLifecycle = new TurnLifecycle(
      this.core,
      this.resourceOps,
      {
        createThread: (...args) => this.catalogOps.createThread(...args),
        deleteThread: (threadId) => this.catalogOps.deleteThread(threadId),
        setInitialPreview: (...args) => this.catalogOps.setInitialPreview(...args),
        scheduleAutomaticThreadName: (...args) => this.catalogOps.scheduleAutomaticThreadName(...args),
      },
      {
        pendingActivities: (threadId) => this.collaboration.pendingActivities(threadId),
        materializePendingActivityItems: (...args) => this.collaboration.materializePendingActivityItems(...args),
        consumePendingSubagentActivities: (...args) => this.collaboration.consumePendingSubagentActivities(...args),
        hasPendingActivities: (threadId) => this.collaboration.hasPendingActivities(threadId),
        takePendingCollaborationActivity: (threadId) => this.collaboration.takePendingCollaborationActivity(threadId),
        signalCollaborationActivity: (threadId) => this.collaboration.signalCollaborationActivity(threadId),
        flushPendingSubagentActivities: (...args) => this.collaboration.flushPendingSubagentActivities(...args),
        queueChildTurnActivity: (...args) => this.collaboration.queueChildTurnActivity(...args),
      },
      this.executor,
      this.extensions,
      this.subagentBudgets,
      this.getDocumentProjection,
      this.resolveReferencedAsset,
      this.resolveSkillAdmission,
      this.resolveRoleCatalog,
      { addUsage: (...args) => this.goals.addUsage(...args) },
      this.now,
      (message) => new ThreadBusyError(message),
      (error) => error instanceof ThreadBusyError,
    );
    this.collaboration = new SubagentCollaboration(
      this.core,
      {
        createThread: (...args) => this.catalogOps.createThread(...args),
        deleteThread: (threadId) => this.catalogOps.deleteThread(threadId),
      },
      this.turnLifecycle,
      this.subagentBudgets,
      resolveRole,
      async () => await options.resolveSubagentTokenBudget?.() ?? null,
      this.now,
      applyToolCeiling,
      (message) => new ThreadBusyError(message),
      options.transcriptRoot,
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
      this.turnLifecycle,
      this.collaboration,
      (threadId) => this.goals.clear(threadId),
      (threadId) => { this.subagentBudgets.clearThread(threadId); },
      (message) => new ThreadBusyError(message),
    );
    this.goals = new GoalExtension(this.goalStore, (notification) => this.core.recordNotification(notification));
    this.goals.bindHost(this, (threadId) => this.core.requireThread(threadId).thread);
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
    return new ThreadService({
      executor,
      ...options,
      transcriptRoot: paths.transcripts,
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
    const knownThreads = new Set(knownThreadIds);
    await Promise.all([
      // Transcript reclamation is the same kind of work as payload pruning, so it
      // joins the same startup batch rather than adding a serial step.
      this.collaboration.sweepOrphanTranscripts((threadId) => knownThreads.has(threadId)),
      ...knownThreadIds.flatMap((threadId) => [
        this.core.payloads.pruneUnreferencedResources(threadId, this.resourceOps.threadResourceReferences(threadId)),
        this.core.payloads.pruneUnreferencedContexts(threadId, this.resourceOps.threadContextPayloadReferences(threadId)),
        this.core.payloads.pruneUnreferencedTurnDiagnostics(threadId, this.resourceOps.threadTurnDiagnosticsReferences(threadId)),
        this.core.payloads.pruneUnreferencedTextOutputs(threadId, this.resourceOps.threadTextPayloadReferences(threadId)),
      ]),
    ]);
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
  async waitForIdle(threadId: ThreadId): Promise<void> { return this.turnLifecycle.waitForIdle(threadId); }
  persistentRootThreads(): readonly Thread[] { return this.catalogOps.persistentRootThreads(); }
  persistentThreadExecutionContext(threadId: ThreadId): PersistentThreadExecutionContext { return this.catalogOps.persistentThreadExecutionContext(threadId); }
  readTurnForHost(threadId: ThreadId, turnId: TurnId): Turn | null { return this.core.readTurn(threadId, turnId); }
  readTurnByClientUserMessageIdForHost(threadId: ThreadId, clientId: string): Turn | null { return this.turnLifecycle.readTurnByClientUserMessageIdForHost(threadId, clientId); }
  async ensureFeatureRootThread(input: FeatureRootThreadInput): Promise<Thread> { return this.catalogOps.ensureFeatureRootThread(input); }
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
  async startRendererTurn(request: RendererTurnStartRequest): Promise<TurnStartResponse> { return this.turnLifecycle.startRendererTurn(request); }
  async startPrivilegedTurn(request: PrivilegedTurnStartRequest): Promise<TurnStartResponse> { return this.turnLifecycle.startPrivilegedTurn(request); }
  async tryStartTurnIfIdle(request: PrivilegedTurnStartRequest): Promise<Turn | null> { return this.turnLifecycle.tryStartTurnIfIdle(request); }
  async steerTurn(
    request: TurnSteerRequest,
    deliveryFailureMode: 'fatal' | 'advisory' = 'fatal',
  ): Promise<TurnSteerResponse> { return this.turnLifecycle.steerTurn(request, deliveryFailureMode); }
  async interruptTurn(threadId: ThreadId, turnId: string): Promise<void> { return this.turnLifecycle.interruptTurn(threadId, turnId); }
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
  async spawnChild(input: SpawnChildThreadInput): Promise<SpawnChildThreadResult> { return this.collaboration.spawnChild(input); }
  async spawnIsolatedSkillThread(input: SpawnIsolatedSkillThreadInput): Promise<SpawnChildThreadResult> { return this.collaboration.spawnIsolatedSkillThread(input); }
  /** Test seam: settle a child's pending transcript appends. */
  async flushSubagentTranscript(threadId: ThreadId): Promise<void> { return this.collaboration.flushTranscriptWrites(threadId); }
  /** Account layer for a delegated child: the artifact path, or null when it is not on disk (A12). */
  async subagentTranscriptPath(threadId: ThreadId): Promise<string | null> { return this.collaboration.transcriptPathForReader(threadId); }
  collaborationToolContributions(turn: { threadId: ThreadId; turnId: string }): readonly AgentTool[] { return this.collaboration.collaborationToolContributions(turn); }
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

}

type ContextCommand =
  | { readonly kind: 'clear' }
  | { readonly kind: 'compact'; readonly instructions: string };

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
    transcripts: subagentTranscriptRoot(userDataPath),
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
