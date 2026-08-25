import { decodePrivilegedTurnStartRequest,decodePrivilegedTurnSteerRequest,decodeThread,decodeThreadItem,decodeTurn } from '../../../core/agent/codec';
import type { EffectiveThreadConfiguration } from '../../../core/agent/configuration';
import { createHostRootTurnAdmissionBarrierSnapshot,createThreadAdmissionBarrierSnapshot } from '../../../core/agent/extensions';
import { RUNTIME_FAILURE_ERROR_CODE,SUBAGENT_DELIVERY_ADMISSION_ERROR_CODE,normalizeTurnErrorCode,type AdditionalContext,type AdditionalContextPayload,type ContextCompactionThreadItem,type ContextCursor,type ContextEvidenceKind,type ContextEvidenceThreadItem,type PrivilegedTurnStartRequest,type PrivilegedTurnSteerRequest,type RendererTurnStartRequest,type RendererTurnSteerRequest,type RequestUserInputRequest,type RequestUserInputResponse,type RoleCatalogContextPayload,type SubagentTurnAdmission,type Thread,type ThreadContextPayload,type ThreadContextPayloadReference,type ThreadId,type ThreadInputAuthor,type ThreadItem,type ThreadResourceReference,type ThreadStatus,type ThreadUserContent,type Turn,type TurnDiagnosticsPayload,type TurnError,type TurnErrorCode,type TurnId,type TurnStartResponse,type TurnStatus,type TurnSteerResponse } from '../../../core/agent/protocol';
import { threadPreviewFromContent } from '../../../core/agent/threadPreview';
import { normalizeRequestUserInputToolInput } from '../../../core/agent/tools';
import { MAX_PROMPT_IMAGE_BYTES,MAX_PROMPT_IMAGE_DIMENSION } from '../../../core/agentAttachmentLimits';
import type { DocumentProjection } from '../../../core/types';
import { planContextCompaction } from '../context/ContextCompaction';
import { ContextCapacityError,ContextCompactionRequiredError,estimateTextTokens } from '../context/ContextBudgetPlanner';
import { assertContextPayloadDependencies } from '../context/contextDependencies';
import { cursorFor,selectEffectiveContext } from '../context/ContextEpoch';
import { admitContextEvidence,contextEvidenceItem } from '../context/evidenceAdmission';
import { planRoleCatalogEvidence } from '../context/RoleContextReducer';
import { observedSkillFilePaths,planSkillCatalogEvidence } from '../context/SkillContextReducer';
import { assertCanonicalUserContent } from '../context/userContentIntegrity';
import type { ExtensionRegistry } from '../ExtensionRegistry';
import { readAgentImageDimensions } from '../capabilities/agentLocalTools';
import { ImageObservationNormalizationError } from '../imageArtifacts';
import type {
  SubagentExecutionLedger,
  SubagentExecutionRecord,
} from '../persistence/SubagentExecutionLedger';
import type { SubagentRequest,SubagentRequestLedger } from '../persistence/SubagentRequestLedger';
import type { ThreadCatalogRecord } from '../persistence/ThreadMetadataStore';
import { ItemRecorder } from '../runtime/ItemRecorder';
import type { OutputImageObservationNormalizer,PreparedOutputImageObservation,StagedContextCompaction,SteeredTurnInput,TurnExecutionContext,TurnExecutionResult,TurnExecutor } from '../runtime/types';
import { SubagentBudgetExhaustedError } from '../SubagentBudgetExhaustedError';
import { SubagentRequestClosedError } from '../SubagentRequestClosedError';
import type { SkillAdmissionResolution,SkillAdmissionResolutionInput } from '../ThreadService';
import { uuidV7 } from '../uuid';
import type { PendingSubagentActivity,StagedContextEvidence } from './SubagentCollaboration';
import {
  MAX_SUBAGENT_SETTLEMENT_BYTES,
  MAX_SUBAGENT_SETTLEMENT_TOKENS,
} from './subagentSettlementEnvelope';
import { RecordedNotificationProjectionError,ThreadCore } from './ThreadCore';
import type { ThreadResourceOps } from './ThreadResourceOps';
interface ActiveTurn {
  readonly threadId: ThreadId; readonly turnId: string;
  readonly initialTurn: Turn;
  readonly controller: AbortController; readonly recorder: ItemRecorder;
  readonly configuration: EffectiveThreadConfiguration; readonly startedAt: number;
  fatalError: Error | null; finishing: boolean;
  steeringHandler: ((input: SteeredTurnInput) => void | Promise<void>) | null;
  readonly queuedSteering: SteeredTurnInput[]; steeringDelivery: Promise<void>;
  readonly completion: Promise<void>; readonly resolveCompletion: () => void;
  recordedExecution: Turn['execution'] | null; budgetUsageAccrued: boolean;
  modelCallTokens: number;
  providerAttemptSerial: number;
  readonly mode: 'ordinary' | 'exhaustedSettlement';
  admissionCommitted: boolean;
  lifecyclePublished: boolean;
  diagnosticsSnapshot: (() => TurnDiagnosticsPayload | null) | null;
}
interface PendingUserInput { readonly request: RequestUserInputRequest; readonly resolve: (response: RequestUserInputResponse) => void;
  readonly reject: (error: Error) => void; readonly abort: () => void; timer: ReturnType<typeof setTimeout> | null; }
interface AcceptedTurn { readonly response: TurnStartResponse; readonly thread: Thread; readonly active: ActiveTurn | null; }
export interface ExplicitSubagentAdmissionPreparation {
  readonly admission: SubagentTurnAdmission & { readonly kind: 'explicitAdmission' };
  readonly sidecarText: string;
}
export type ExplicitSubagentAdmissionPreparer = (input: {
  readonly maxSidecarTokens: number;
  readonly maxSidecarBytes: number;
  readonly reservedSidecarItemId: string;
}) => Promise<ExplicitSubagentAdmissionPreparation>;
type InternalTurnStartRequest = Omit<PrivilegedTurnStartRequest, 'author'> & {
  readonly author: ThreadInputAuthor;
  readonly stagedContextEvidence?: readonly StagedContextEvidence[];
  readonly additionalContextResourceRefs?: readonly ThreadResourceReference[];
  readonly additionalContextSource?: string;
  readonly reuseStagedContextEvidenceOnly?: boolean;
  readonly retryReplacementTarget?: Turn;
  readonly retryInputBatches?: readonly CanonicalTurnRetryInputBatch[];
  readonly subagentAdmission?: SubagentTurnAdmission;
  readonly prepareExplicitSubagentAdmission?: ExplicitSubagentAdmissionPreparer;
  readonly bypassSubagentBudget?: boolean;
};
type InternalTurnSteerRequest = Omit<PrivilegedTurnSteerRequest, 'author'> & {
  readonly author: ThreadInputAuthor;
};
export interface CanonicalTurnRetryInputBatch {
  readonly author: ThreadInputAuthor;
  readonly input: readonly ThreadUserContent[];
  readonly clientUserMessageId: string | null;
  readonly acceptedAt: number;
  readonly stagedContextEvidence: readonly StagedContextEvidence[];
}
export type CanonicalTurnRetryAdmission = Pick<PrivilegedTurnStartRequest, 'threadId' | 'trigger'> & {
  readonly inputBatches: readonly CanonicalTurnRetryInputBatch[];
  readonly replacedTurn: Turn;
};
interface TurnLifecycleCatalog {
  createThread: import('./ThreadCatalogOps').ThreadCatalogOps['createThread']; deleteThread: import('./ThreadCatalogOps').ThreadCatalogOps['deleteThread'];
  setInitialPreview: import('./ThreadCatalogOps').ThreadCatalogOps['setInitialPreview']; scheduleAutomaticThreadName: import('./ThreadCatalogOps').ThreadCatalogOps['scheduleAutomaticThreadName'];
  hasPendingDelegatedThreadStart: import('./ThreadCatalogOps').ThreadCatalogOps['hasPendingDelegatedThreadStart'];
  publishDelegatedThreadStart: import('./ThreadCatalogOps').ThreadCatalogOps['publishDelegatedThreadStart'];
  replaceLatestTurnForRetryWithLocksHeld: import('./ThreadCatalogOps').ThreadCatalogOps['replaceLatestTurnForRetryWithLocksHeld'];
}
interface TurnLifecycleCollaboration {
  pendingActivities(threadId: ThreadId): readonly PendingSubagentActivity[]; hasPendingActivities(threadId: ThreadId): boolean;
  canSpawnAgent(threadId: ThreadId, configuration: EffectiveThreadConfiguration): boolean;
  materializePendingActivityItems(threadId: ThreadId, turnId: TurnId, activities: readonly PendingSubagentActivity[]): ThreadItem[]; consumePendingSubagentActivities(threadId: ThreadId, consumed: readonly PendingSubagentActivity[]): void;
  takePendingCollaborationActivity(threadId: ThreadId): boolean; signalCollaborationActivity(threadId: ThreadId): void;
  flushPendingSubagentActivities(threadId: ThreadId, turnId: TurnId): Promise<readonly PendingSubagentActivity[]>; prepareChildTerminalSettlement(thread: Thread, turn: Turn, failureOrigin?: 'providerFailure' | 'contextFailure' | 'hostFailure'): void; queueChildTurnActivity(thread: Thread, turn: Turn): void; threadBecameIdle(threadId: ThreadId): void;
  startupContextForTurn(threadId: ThreadId, turnId: TurnId): import('../context/AgentStartupContext').AgentStartupContextSnapshot | null;
  commitInitialAdmission(threadId: ThreadId, turnId: TurnId): Error | null;
  commitDeliveryAdmission(
    threadId: ThreadId,
    turnId: TurnId,
    admission: SubagentTurnAdmission,
  ): Promise<Error | null>;
  detachCarryForwardSidecarForOverflow(
    threadId: ThreadId,
    turnId: TurnId,
    batchId: string,
  ): Promise<boolean>;
}
/**
 * The account layer's hook. It is deliberately NOT part of the collaboration
 * bag: every Thread's completed Turn passes through here, and only some of them
 * are a delegated child's.
 */
interface TurnLifecycleTranscripts { enqueueTurn(thread: Thread, turn: Turn): void; }
/**
 * The drift check. Injected rather than reached for, so this file keeps knowing
 * nothing about beliefs beyond when to ask — admission is the moment, and it is
 * the only one.
 */
interface TurnLifecycleDocumentDrift {
  noticeFor(
    threadId: ThreadId,
    projection: DocumentProjection | null,
  ): Promise<{ readonly context: AdditionalContext | null; readonly settle: () => void }>;
}
interface TurnLifecycleGoalUsage { addUsage(threadId: ThreadId, tokens: number, elapsedSeconds: number, turnId: TurnId, terminalStatus: TurnStatus): Promise<void>; }

function specializedChildSkillCatalogOmitted(thread: Thread): boolean {
  return thread.parentThreadId !== null
    && (thread.agentRole === 'explorer' || thread.agentRole === 'plan');
}
export interface ResolvedSubagentBudget {
  readonly execution: SubagentExecutionRecord | null;
  readonly request: SubagentRequest | null;
  readonly resolutionFailed?: boolean;
}
export class TurnLifecycle {
  private readonly activeTurns = new Map<ThreadId, ActiveTurn>(); private readonly pendingUserInputs = new Map<ThreadId, PendingUserInput>();
  constructor(
    private readonly core: ThreadCore, private readonly resourceOps: ThreadResourceOps,
    private readonly catalog: TurnLifecycleCatalog, private readonly collaboration: TurnLifecycleCollaboration,
    private readonly transcripts: TurnLifecycleTranscripts,
    private readonly documentDrift: TurnLifecycleDocumentDrift,
    private readonly executor: TurnExecutor, private readonly extensions: ExtensionRegistry,
    private readonly subagentBudgets: SubagentRequestLedger,
    private readonly subagentExecutions: SubagentExecutionLedger,
    private readonly getDocumentProjection: () => DocumentProjection | null,
    private readonly resolveReferencedAsset: ((assetId: string) => Promise<import('../capabilities/agentReferencedAssets').ReferencedAssetResolution | null>) | undefined,
    private readonly resolveSkillAdmission: (input: SkillAdmissionResolutionInput) => Promise<SkillAdmissionResolution>,
    private readonly resolveRoleCatalog: (cwd: string) => Promise<RoleCatalogContextPayload | null>,
    /** The name this Thread's agent answers to, resolved per Turn. */
    private readonly resolvePersona: (thread: Thread) => string | null,
    private readonly goalUsage: TurnLifecycleGoalUsage,
    private readonly normalizeOutputImage: OutputImageObservationNormalizer | undefined,
    private readonly now: () => number,
    private readonly createThreadBusyError: (message: string, rendererSubmissionRetryable?: boolean) => Error,
    private readonly isThreadBusyError: (error: unknown) => boolean,
  ) {}
  activeTurnsForInspection(): Map<ThreadId, ActiveTurn> { return this.activeTurns; } pendingUserInputsForInspection(): Map<ThreadId, PendingUserInput> { return this.pendingUserInputs; }
  activeTurnDiagnosticsForInspection(threadId: ThreadId, turnId: TurnId): TurnDiagnosticsPayload | null {
    const active = this.activeTurns.get(threadId);
    if (!active || active.turnId !== turnId) return null;
    try {
      return active.diagnosticsSnapshot?.() ?? null;
    } catch {
      return null;
    }
  }
  activeTurnId(threadId: ThreadId): string | null { return this.activeTurns.get(threadId)?.turnId ?? null; } hasActiveTurn(threadId: ThreadId): boolean { return this.activeTurns.has(threadId); }
  isActiveTurnFinishing(threadId: ThreadId): boolean { return this.activeTurns.get(threadId)?.finishing ?? false; }
  async abortForSubtreeStop(threadId: ThreadId): Promise<void> {
    await this.core.threadMutex.run(threadId, async () => { this.activeTurns.get(threadId)?.controller.abort(); this.pendingUserInputs.get(threadId)?.abort(); });
  }
  async recordSubagentActivity(
    ownerThreadId: ThreadId,
    ownerTurnId: string,
    agentThreadId: ThreadId,
    agentTurnId: TurnId,
    agentPath: string,
    kind: PendingSubagentActivity['kind'],
    error: Turn['error'],
    completedAt: number,
    spawnItemId: string | null,
  ): Promise<void> {
    const active = this.requireActiveTurn(ownerThreadId, ownerTurnId);
    const id = active.recorder.createItemId();
    await active.recorder.completedImmediately({
      type: 'subAgentActivity',
      id,
      provenance: active.recorder.localProvenance(id),
      kind,
      agentThreadId,
      agentTurnId,
      agentPath,
      error,
      spawnItemId,
    }, completedAt);
  }
  async waitForIdle(threadId: ThreadId): Promise<void> {
      while (true) {
        const active = this.activeTurns.get(threadId);
        if (!active) return;
        await active.completion;
      }
    }
  async waitForTurnCompletion(threadId: ThreadId, turnId: TurnId): Promise<void> {
      const active = this.activeTurns.get(threadId);
      if (active?.turnId === turnId) await active.completion;
    }
  readTurnByClientUserMessageIdForHost(threadId: ThreadId, clientId: string): Turn | null {
      return this.readCanonicalClientBinding(threadId, clientId)?.turn ?? null;
    }
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
        preloadedSkills: Object.freeze([]),
        plugins: Object.freeze([]),
        mcpServers: Object.freeze([]),
      });
      const id = uuidV7(this.now());
      const thread = await this.catalog.createThread({
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
          author: { kind: 'feature', feature: 'memory' },
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
        await this.catalog.deleteThread(thread.id).catch(() => undefined);
      }
    }
  async startRendererTurn(
      request: RendererTurnStartRequest,
      reservedTurnId?: TurnId,
      admissionGuard?: () => void,
      prepareExplicitSubagentAdmission?: ExplicitSubagentAdmissionPreparer,
    ): Promise<TurnStartResponse> {
      const contextCommand = parseContextCommand(request.input);
      if (contextCommand) return this.startContextCommand(request, contextCommand, admissionGuard);
      const privileged: InternalTurnStartRequest = {
        ...request,
      ...(reservedTurnId === undefined ? {} : { turnId: reservedTurnId }),
      ...(prepareExplicitSubagentAdmission
        ? { prepareExplicitSubagentAdmission, bypassSubagentBudget: true }
        : {}),
      author: { kind: 'reader' },
      trigger: { kind: 'user' },
      };
      return (await this.acceptAndLaunch(privileged, false, admissionGuard)).response;
    }
  isRendererContextCommand(input: readonly ThreadUserContent[]): boolean {
      return parseContextCommand(input) !== null;
    }
  private async startContextCommand(
      request: RendererTurnStartRequest,
      command: ContextCommand,
      admissionGuard?: () => void,
    ): Promise<TurnStartResponse> { return this.core.threadMutex.run(request.threadId, async () => {
        admissionGuard?.();
        const record = this.core.requireThread(request.threadId);
        const existing = request.clientUserMessageId
          ? this.readCanonicalClientBinding(request.threadId, request.clientUserMessageId)
          : null;
        if (existing) return { turn: existing.turn, acceptedItemId: existing.itemId, deduplicated: true };
        if (this.core.stoppingThreads.has(request.threadId)) throw this.createThreadBusyError('Thread is stopping');
        if (record.archived) throw this.createThreadBusyError('Thread is archived');
        if (this.activeTurns.has(request.threadId)) throw this.createThreadBusyError('Thread already has an active Turn');
        if (record.thread.status.type !== 'idle') throw this.createThreadBusyError('Thread is not idle');
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
          admissionGuard?.();
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
  async startExplicitSubagentTurn(
    request: PrivilegedTurnStartRequest,
    prepareExplicitSubagentAdmission: ExplicitSubagentAdmissionPreparer,
  ): Promise<TurnStartResponse> {
    return (await this.acceptAndLaunch({
      ...decodePrivilegedTurnStartRequest(request),
      prepareExplicitSubagentAdmission,
      bypassSubagentBudget: true,
    })).response;
  }
  async startExhaustedSettlementTurn(
    request: PrivilegedTurnStartRequest,
    admission: SubagentTurnAdmission,
  ): Promise<TurnStartResponse> {
    if (admission.kind !== 'exhaustedSettlement') {
      throw new Error('Exhausted settlement admission kind does not match');
    }
    return (await this.acceptAndLaunch({
      ...decodePrivilegedTurnStartRequest(request),
      subagentAdmission: admission,
      bypassSubagentBudget: true,
    }, true)).response;
  }
  recoverCommittedExhaustedSettlementTurn(threadId: ThreadId, turn: Turn): boolean {
      if (turn.status !== 'inProgress' || this.activeTurns.has(threadId)) return false;
      const batch = this.subagentExecutions.deliveryBatchForTurn(threadId, turn.id);
      if (
        !batch
        || batch.kind !== 'exhaustedSettlement'
        || batch.state !== 'linked'
        || batch.providerAttempted
      ) return false;
      const record = this.core.requireThread(threadId);
      const recorder = new ItemRecorder(
        threadId,
        turn.id,
        turn.items,
        (notification) => this.core.recordNotification(notification),
      );
      let resolveCompletion!: () => void;
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      const active: ActiveTurn = {
        threadId,
        turnId: turn.id,
        initialTurn: turn,
        controller: new AbortController(),
        recorder,
        configuration: settlementConfiguration(record.configuration),
        startedAt: turn.startedAt,
        fatalError: null,
        finishing: false,
        steeringHandler: null,
        queuedSteering: [],
        steeringDelivery: Promise.resolve(),
        completion,
        resolveCompletion,
        recordedExecution: null,
        budgetUsageAccrued: false,
        modelCallTokens: 0,
        providerAttemptSerial: 0,
        mode: 'exhaustedSettlement',
        admissionCommitted: true,
        lifecyclePublished: true,
        diagnosticsSnapshot: null,
      };
      this.activeTurns.set(threadId, active);
      void this.executeActiveTurn(active)
        .catch((error) => this.failActiveTurn(
          active,
          error instanceof Error ? error : new Error(String(error)),
        ))
        .finally(resolveCompletion);
      return true;
    }
  crashedTurnRecoveryError(threadId: ThreadId, turnId: TurnId): TurnError | null {
      const batch = this.subagentExecutions.deliveryBatchForTurn(threadId, turnId);
      return batch?.state === 'admissionFailed'
        ? {
            code: SUBAGENT_DELIVERY_ADMISSION_ERROR_CODE,
            message: 'Subagent delivery admission did not match its durable batch',
          }
        : null;
    }
  async startRetriedRootTurnWithHostLock(
      request: CanonicalTurnRetryAdmission,
      admissionGuard?: () => void,
    ): Promise<TurnStartResponse> {
      const initialInput = request.inputBatches[0];
      if (!initialInput) throw new Error('Retry input is missing from the canonical Turn');
      for (const batch of request.inputBatches) assertCanonicalUserContent(batch.input);
      const canonicalRequest: InternalTurnStartRequest = {
        threadId: request.threadId,
        input: initialInput.input,
        clientUserMessageId: initialInput.clientUserMessageId,
        author: initialInput.author,
        trigger: request.trigger,
      };
      const accepted = await this.core.threadMutex.run(request.threadId, () => this.acceptTurn({
        ...canonicalRequest,
        stagedContextEvidence: initialInput.stagedContextEvidence,
        reuseStagedContextEvidenceOnly: true,
        retryReplacementTarget: request.replacedTurn,
        retryInputBatches: request.inputBatches,
      }, true, admissionGuard));
      this.scheduleAcceptedTurn(accepted);
      return accepted.response;
    }
  async tryStartTurnIfIdle(request: PrivilegedTurnStartRequest): Promise<Turn | null> {
      try {
        const accepted = await this.acceptAndLaunch(decodePrivilegedTurnStartRequest(request), true);
        return accepted.response.turn;
      } catch (error) {
        if (this.isThreadBusyError(error)) return null;
        throw error;
      }
    }
  async steerRendererTurn(
      request: RendererTurnSteerRequest,
      deliveryFailureMode: 'fatal' | 'advisory' = 'fatal',
      admissionGuard?: () => void,
    ): Promise<TurnSteerResponse> {
      return this.steerTurn({ ...request, author: { kind: 'reader' } }, deliveryFailureMode, admissionGuard);
    }
  async steerPrivilegedTurn(
      request: PrivilegedTurnSteerRequest,
      deliveryFailureMode: 'fatal' | 'advisory' = 'fatal',
      admissionGuard?: () => void,
    ): Promise<TurnSteerResponse> {
      return this.steerTurn(decodePrivilegedTurnSteerRequest(request), deliveryFailureMode, admissionGuard);
    }
  private async steerTurn(
      request: InternalTurnSteerRequest,
      deliveryFailureMode: 'fatal' | 'advisory' = 'fatal',
      admissionGuard?: () => void,
    ): Promise<TurnSteerResponse> { return this.core.threadMutex.run(request.threadId, async () => {
        admissionGuard?.();
        const existing = request.clientUserMessageId
          ? this.readCanonicalClientBinding(request.threadId, request.clientUserMessageId)
          : null;
        if (existing) {
          return { turnId: existing.turn.id, acceptedItemId: existing.itemId, deduplicated: true };
        }
        const active = this.activeTurns.get(request.threadId);
        if (!active || active.turnId !== request.expectedTurnId) {
          throw this.createThreadBusyError('Expected Turn is not active', true);
        }
        if (active.finishing || active.fatalError) {
          throw this.createThreadBusyError('Expected Turn is no longer accepting steering', true);
        }
        if (active.mode === 'exhaustedSettlement') {
          throw this.createThreadBusyError('The Agent is settling exhausted child output; retry after it stops');
        }
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
              ? { catalogSnapshot: null, preloadedInvocations: [], invocation: null }
              : await this.resolveSkillAdmission({
                thread,
                turnId: active.turnId,
                configuration: active.configuration,
                preloadedSkills: [],
                content: admission.content,
                acceptedAt,
                observedFilePaths: observedSkillFilePaths(canonicalTurns),
              });
          const skillCatalog = await planSkillCatalogEvidence({
            turns: canonicalTurns,
            snapshot: specializedChildSkillCatalogOmitted(thread)
              ? null
              : skillAdmission.catalogSnapshot,
            readContext: (ref) => this.core.payloads.readContext(thread.id, ref),
          });
          const roleCatalog = await planRoleCatalogEvidence({
            turns: canonicalTurns,
            snapshot: this.collaboration.canSpawnAgent(thread.id, active.configuration)
              ? await this.resolveRoleCatalog(thread.cwd)
              : null,
            readContext: (ref) => this.core.payloads.readContext(thread.id, ref),
          });
          const admissionProjection = this.getDocumentProjection();
          const evidence = await admitContextEvidence({
            thread,
            persona: this.resolvePersona(thread),
            turnId: active.turnId,
            acceptedAt,
            content: admission.content,
            userView: request.userView,
            // NO drift notice here. This is `steerTurn`: it admits into a Turn
            // that is already running, and the notice's whole contract is that it
            // arrives between Turns. Delivered here it would land while the model
            // is composing an edit and tell it not to revert changes it is itself
            // being asked to make.
            additionalContext: request.additionalContext,
            additionalContextSource: request.additionalContextSource,
            extensionContext,
            skillCatalog,
            roleCatalog,
            preloadedSkillInvocations: skillAdmission.preloadedInvocations,
            skillInvocation: skillAdmission.invocation,
            includeHostContext: !this.core.hiddenEphemeralThreads.has(request.threadId),
            projection: admissionProjection,
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
            request.author,
            admission.content,
            request.clientUserMessageId ?? null,
            acceptedAt,
          );
          admittedItems = [...evidence.items, item];
          admissionGuard?.();
          await active.recorder.completedImmediatelyBatch(admittedItems, acceptedAt);
        } catch (error) {
          const references = this.resourceOps.threadStorageReferences(thread.id);
          await this.resourceOps.discardCreatedResourcesAgainstReferences(
            thread.id,
            [...admission.createdResources, ...createdEvidenceResources],
            references.resources,
          );
          await this.core.payloads.pruneUnreferencedContexts(
            thread.id,
            references.contexts,
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
        if (!active || active.turnId !== turnId) throw this.createThreadBusyError('Expected Turn is not active');
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
  resolveSubagentBudget(threadId: ThreadId): ResolvedSubagentBudget | null {
      return this.resolveSubagentBudgetFrom(threadId, false);
    }
  assertSubagentBudgetAvailable(threadId: ThreadId): ResolvedSubagentBudget | null {
      const budget = this.resolveSubagentBudget(threadId);
      this.assertResolvedSubagentBudgetAvailable(threadId, budget);
      return budget;
    }
  assertSubagentRequestOpen(threadId: ThreadId): ResolvedSubagentBudget | null {
      const budget = this.resolveSubagentBudgetFrom(threadId, true);
      const closed = budget?.request?.closedAt;
      if (closed !== null && closed !== undefined) {
        throw new SubagentRequestClosedError(budget!.request!.originTurnId);
      }
      return budget;
    }
  subagentBudgetView(threadId: ThreadId): {
    readonly tokenBudget: number | null;
    readonly tokensUsed: number;
  } | null {
      const budget = this.resolveSubagentBudget(threadId);
      const execution = budget?.execution;
      return execution
        ? { tokenBudget: execution.tokenBudget, tokensUsed: execution.tokensUsed }
        : null;
    }
  private resolveSubagentBudgetFrom(
      threadId: ThreadId,
      markFailure: boolean,
    ): ResolvedSubagentBudget | null {
      try {
        const execution = this.subagentExecutions.read(threadId);
        const child = this.subagentBudgets.readChild(threadId);
        const request = child ? this.subagentBudgets.readRequest(child.originTurnId) : null;
        return execution || request ? { execution, request } : null;
      } catch (error) {
        this.auditSubagentBudgetFailure('generation budget resolution', threadId, error);
        return markFailure ? { execution: null, request: null, resolutionFailed: true } : null;
      }
    }
  /**
   * The single gate for delegated work: non-user Turn admission, spawn, and the
   * collaboration follow-up/message tools all pass through here. That is why
   * the closed-request check belongs here and nowhere else — and why the user
   * bright line holds for free, since a user-triggered Turn never reaches it.
   */
  private assertResolvedSubagentBudgetAvailable(
      threadId: ThreadId,
      budget: ResolvedSubagentBudget | null,
    ): void {
      const closedRequest = budget?.request;
      if (closedRequest?.closedAt !== null && closedRequest?.closedAt !== undefined) {
        throw new SubagentRequestClosedError(closedRequest.originTurnId);
      }
      const snapshot = this.subagentBudgetSnapshot(threadId, budget);
      if (snapshot && snapshot.tokensUsed >= snapshot.tokenBudget) {
        throw new SubagentBudgetExhaustedError(snapshot.tokensUsed, snapshot.tokenBudget);
      }
    }
  private subagentBudgetSnapshot(
      threadId: ThreadId,
      budget: ResolvedSubagentBudget | null,
    ): { readonly tokenBudget: number; readonly tokensUsed: number } | null {
      const execution = budget?.execution;
      if (!execution || execution.tokenBudget === null) return null;
      const active = this.activeTurns.get(threadId);
      return {
        tokenBudget: execution.tokenBudget,
        tokensUsed: execution.tokensUsed + (active?.modelCallTokens ?? 0),
      };
    }
  private subagentBudgetUsage(
      threadId: ThreadId,
      budget: ResolvedSubagentBudget | null,
    ): { readonly remaining: number; readonly total: number; readonly used: number } | null {
      const snapshot = this.subagentBudgetSnapshot(threadId, budget);
      return snapshot ? {
        remaining: snapshot.tokenBudget - snapshot.tokensUsed,
        total: snapshot.tokenBudget,
        used: snapshot.tokensUsed,
      } : null;
    }
  async acceptAndLaunch(
      request: InternalTurnStartRequest,
      onlyIfIdle = false,
      admissionGuard?: () => void,
    ): Promise<AcceptedTurn> {
      const record = this.core.requireThread(request.threadId);
      if (onlyIfIdle && record.thread.parentThreadId === null && this.core.isHostRootAdmissionBarrierActive()) {
        throw this.createThreadBusyError('Root Turn admission is temporarily paused');
      }
      const accept = () => this.core.threadMutex.run(
        request.threadId,
        () => this.acceptTurn(request, onlyIfIdle, admissionGuard),
      );
      const accepted = record.thread.parentThreadId === null
        ? await this.core.hostRootMutex.run(accept)
        : await accept();
      this.scheduleAcceptedTurn(accepted);
      return accepted;
    }
  private scheduleAcceptedTurn(accepted: AcceptedTurn): void {
      if (!accepted.active) return;
      void this.launchActiveTurn(accepted)
        .catch((error) => this.failActiveTurn(
          accepted.active!,
          error instanceof Error ? error : new Error(String(error)),
        ))
        .finally(accepted.active.resolveCompletion);
    }
  private async launchActiveTurn(accepted: AcceptedTurn): Promise<void> {
      if (!accepted.active) return;
      if (
        accepted.active.lifecyclePublished
        && !accepted.active.fatalError
        && !this.core.hiddenEphemeralThreads.has(accepted.thread.id)
      ) {
        await this.extensions.turnStarted(accepted.thread, accepted.response.turn);
      }
      await this.executeActiveTurn(accepted.active);
    }
  private async acceptTurn(
      request: InternalTurnStartRequest,
      onlyIfIdle: boolean,
      admissionGuard?: () => void,
    ): Promise<AcceptedTurn> {
      admissionGuard?.();
      const record = this.core.requireThread(request.threadId);
      if (request.retryReplacementTarget) {
        const clientIds = (request.retryInputBatches ?? [])
          .flatMap((batch) => batch.clientUserMessageId ? [batch.clientUserMessageId] : []);
        if (new Set(clientIds).size !== clientIds.length) {
          throw new Error('Retry input contains duplicate client ids');
        }
        for (const clientId of clientIds) {
          const retryBinding = this.readCanonicalClientBinding(request.threadId, clientId);
          if (retryBinding && retryBinding.turn.id !== request.retryReplacementTarget.id) {
            throw new Error('Retry client id is already bound to another Turn');
          }
        }
      } else if (request.clientUserMessageId) {
        const existing = this.readCanonicalClientBinding(request.threadId, request.clientUserMessageId);
        if (existing) {
          return {
            response: { turn: existing.turn, acceptedItemId: existing.itemId, deduplicated: true },
            thread: record.thread,
            active: null,
          };
        }
      }
      if (request.trigger.kind !== 'user' && request.bypassSubagentBudget !== true) {
        this.assertSubagentBudgetAvailable(request.threadId);
      }
      if (this.core.stoppingThreads.has(request.threadId)) throw this.createThreadBusyError('Thread is stopping');
      if (record.archived) throw this.createThreadBusyError('Thread is archived');
      if (this.activeTurns.has(request.threadId)) {
        throw this.createThreadBusyError('Thread already has an active Turn', true);
      }
      if (onlyIfIdle && record.thread.status.type !== 'idle') throw this.createThreadBusyError('Thread is not idle');
      const startedAt = this.now();
      const turnId = request.turnId ?? uuidV7(startedAt);
      const admission = request.retryInputBatches
        ? { content: request.input, createdResources: [] }
        : await this.resourceOps.resolveAdmissionContent(request.input, record.thread);
      const createdEvidenceResources: ThreadResourceReference[] = [];
      try {
        return await this.commitAcceptedTurn(
          request,
          record,
          turnId,
          startedAt,
          admission.content,
          (ref) => createdEvidenceResources.push(ref),
          admissionGuard,
        );
      } catch (error) {
        const references = this.resourceOps.threadStorageReferences(record.thread.id);
        await this.resourceOps.discardCreatedResourcesAgainstReferences(
          record.thread.id,
          [...admission.createdResources, ...createdEvidenceResources],
          references.resources,
        );
        await this.core.payloads.pruneUnreferencedContexts(
          record.thread.id,
          references.contexts,
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
      admissionGuard?: () => void,
    ): Promise<AcceptedTurn> {
      const preview = threadPreviewFromContent(input);
      const retryInputBatches = request.retryInputBatches ?? [];
      const initialRetryInput = retryInputBatches[0];
      const item = userMessage(
        request.threadId,
        turnId,
        initialRetryInput?.author ?? request.author,
        input,
        request.clientUserMessageId ?? null,
        initialRetryInput?.acceptedAt ?? startedAt,
      );
      const provenance = {
        originThreadId: request.threadId,
        originTurnId: turnId,
        trigger: request.trigger,
      } as const;
      const turnConfiguration = request.subagentAdmission?.kind === 'exhaustedSettlement'
        ? settlementConfiguration(record.configuration)
        : record.configuration;
      const provisionalTurn = decodeTurn({
        id: turnId,
        items: [item],
        itemsView: 'full',
        provenance,
        status: 'inProgress',
        error: null,
        execution: initialTurnExecution(record.thread, turnConfiguration),
        startedAt,
        completedAt: null,
        durationMs: null,
      });
      const materializeStagedEvidence = (stagedEvidence: readonly StagedContextEvidence[]) => (
        stagedEvidence.map((staged) => {
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
        })
      );
      const stagedItems = materializeStagedEvidence(request.stagedContextEvidence ?? []);
      const replayedInputs = retryInputBatches.slice(1).map((batch) => {
        const replayedUser = userMessage(
          request.threadId,
          turnId,
          batch.author,
          batch.input,
          batch.clientUserMessageId,
          batch.acceptedAt,
        );
        return {
          items: [...materializeStagedEvidence(batch.stagedContextEvidence), replayedUser],
          user: replayedUser,
        };
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
      const reuseCanonicalEvidence = request.reuseStagedContextEvidenceOnly === true;
      const extensionContext = reuseCanonicalEvidence || this.core.hiddenEphemeralThreads.has(request.threadId)
        ? []
        : await this.extensions.threadContext(record.thread);
      const priorTurns = this.core.allTurns(request.threadId);
      const canonicalTurns = [
        ...priorTurns,
        ...(stagedItems.length > 0 ? [{ ...provisionalTurn, items: stagedItems }] : []),
      ];
      const skillAdmission = reuseCanonicalEvidence || this.core.hiddenEphemeralThreads.has(request.threadId)
        ? { catalogSnapshot: null, preloadedInvocations: [], invocation: null }
        : await this.resolveSkillAdmission({
            thread: record.thread,
            turnId,
            configuration: record.configuration,
            preloadedSkills: priorTurns.length === 0
              ? record.configuration.preloadedSkills ?? []
              : [],
            content: input,
            acceptedAt: startedAt,
            observedFilePaths: observedSkillFilePaths(canonicalTurns),
          });
      const skillCatalog = reuseCanonicalEvidence ? null : await planSkillCatalogEvidence({
        turns: canonicalTurns,
        snapshot: specializedChildSkillCatalogOmitted(record.thread)
          ? null
          : skillAdmission.catalogSnapshot,
        readContext: (ref) => this.core.payloads.readContext(record.thread.id, ref),
      });
      const roleCatalog = reuseCanonicalEvidence ? null : await planRoleCatalogEvidence({
        turns: canonicalTurns,
        snapshot: this.collaboration.canSpawnAgent(record.thread.id, record.configuration)
          ? await this.resolveRoleCatalog(record.thread.cwd)
          : null,
        readContext: (ref) => this.core.payloads.readContext(record.thread.id, ref),
      });
      // One projection for both, so the notice and the evidence describe the
      // same instant rather than two moments a mutation could sit between.
      const admissionProjection = reuseCanonicalEvidence ? null : this.getDocumentProjection();
      const drift = reuseCanonicalEvidence
        ? { context: null, settle: () => undefined }
        : await this.documentDrift.noticeFor(record.thread.id, admissionProjection);
      const evidence = reuseCanonicalEvidence ? { items: [] } : await admitContextEvidence({
        thread: record.thread,
        persona: this.resolvePersona(record.thread),
        turnId,
        acceptedAt: startedAt,
        content: input,
        userView: request.userView,
        additionalContext: { ...request.additionalContext, ...drift.context },
        additionalContextResourceRefs: request.additionalContextResourceRefs,
        additionalContextSource: request.additionalContextSource,
        extensionContext,
        skillCatalog,
        roleCatalog,
        preloadedSkillInvocations: skillAdmission.preloadedInvocations,
        skillInvocation: skillAdmission.invocation,
        includeHostContext: !this.core.hiddenEphemeralThreads.has(request.threadId),
        projection: admissionProjection,
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
      const pendingSubagentActivities = reuseCanonicalEvidence
        ? []
        : this.collaboration.pendingActivities(request.threadId);
      const pendingSubagentItems = this.collaboration.materializePendingActivityItems(
        request.threadId,
        turnId,
        pendingSubagentActivities,
      );
      let initialItems = [
        ...pendingSubagentItems,
        ...stagedItems,
        ...evidence.items,
        item,
        ...replayedInputs.flatMap((batch) => batch.items),
      ];
      let turn = decodeTurn({ ...provisionalTurn, items: initialItems });
      let recorder = new ItemRecorder(
        request.threadId,
        turnId,
        initialItems,
        (notification) => this.core.recordNotification(notification),
      );
      let subagentAdmission = request.subagentAdmission;
      if (request.prepareExplicitSubagentAdmission) {
        if (subagentAdmission) throw new Error('Subagent Turn has two admission authorities');
        const remainingInputTokens = await this.planExplicitSidecarCapacity(
          record.thread,
          turn,
          turnConfiguration,
          recorder,
        );
        const reservedSidecarItemId = uuidV7();
        const prepared = await request.prepareExplicitSubagentAdmission({
          maxSidecarTokens: Math.max(
            0,
            Math.min(MAX_SUBAGENT_SETTLEMENT_TOKENS, remainingInputTokens - 13),
          ),
          maxSidecarBytes: MAX_SUBAGENT_SETTLEMENT_BYTES,
          reservedSidecarItemId,
        });
        if (prepared.admission.kind !== 'explicitAdmission') {
          throw new Error('Explicit Subagent admission returned the wrong kind');
        }
        if (
          Buffer.byteLength(prepared.sidecarText, 'utf8') > MAX_SUBAGENT_SETTLEMENT_BYTES
          || (prepared.sidecarText && estimateTextTokens(prepared.sidecarText) > Math.max(
            0,
            Math.min(MAX_SUBAGENT_SETTLEMENT_TOKENS, remainingInputTokens - 13),
          ))
        ) throw new Error('Explicit Subagent sidecar exceeds its planned capacity');
        subagentAdmission = prepared.admission;
        if (prepared.sidecarText) {
          const sidecarPayload: AdditionalContextPayload = {
            schemaVersion: 1,
            kind: 'additionalContext',
            turnEntries: [{
              key: 'subagent.settlement',
              source: `subagent-settlement:${prepared.admission.batchId}`,
              authority: 'untrusted',
              purpose: 'observation',
              text: prepared.sidecarText,
            }],
            threadState: null,
          };
          const sidecarRef = await this.core.payloads.writeContext(request.threadId, sidecarPayload);
          const sidecarItem = contextEvidenceItem(
            { thread: record.thread, turnId, createItemId: () => reservedSidecarItemId },
            'additionalContext',
            sidecarRef,
            'Subagent settlement observation',
            [],
          );
          initialItems = [...initialItems, sidecarItem];
          turn = decodeTurn({ ...provisionalTurn, items: initialItems });
          recorder = new ItemRecorder(
            request.threadId,
            turnId,
            initialItems,
            (notification) => this.core.recordNotification(notification),
          );
        }
      }
      let resolveCompletion!: () => void;
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      const delegatedAdmission = this.catalog.hasPendingDelegatedThreadStart(request.threadId);
      const active: ActiveTurn = {
        threadId: request.threadId,
        turnId,
        initialTurn: turn,
        controller: new AbortController(),
        recorder,
        configuration: turnConfiguration,
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
        modelCallTokens: 0,
        providerAttemptSerial: 0,
        mode: subagentAdmission?.kind === 'exhaustedSettlement'
          ? 'exhaustedSettlement'
          : 'ordinary',
        admissionCommitted: !delegatedAdmission,
        lifecyclePublished: !delegatedAdmission,
        diagnosticsSnapshot: null,
      };
      const startedNotification = {
        type: 'turn/started',
        threadId: request.threadId,
        turnId,
        turn,
        ...(subagentAdmission ? { subagentAdmission } : {}),
      } as const;
      let durableProjectionError: RecordedNotificationProjectionError | null = null;
      try {
        admissionGuard?.();
        if (request.retryReplacementTarget) {
          await this.catalog.replaceLatestTurnForRetryWithLocksHeld(
            request.threadId,
            request.retryReplacementTarget,
            startedNotification,
          );
        } else {
          await this.core.recordNotification(startedNotification, {
            deferObservers: !active.lifecyclePublished,
          });
        }
      } catch (error) {
        if (active.lifecyclePublished || !(error instanceof RecordedNotificationProjectionError)) throw error;
        durableProjectionError = error;
      }
      // From the durable child Turn onward, exactly one in-process owner must
      // terminalize it. No later marker, projection, or observer failure may
      // escape through spawn and strand an accepted Turn without a launch tail.
      this.activeTurns.set(request.threadId, active);
      const deliveryAdmissionError = subagentAdmission
        ? await this.collaboration.commitDeliveryAdmission(request.threadId, turnId, subagentAdmission)
        : null;
      // `turn/started` is the cross-store commit point for a fresh delegated
      // child. Flip its prepared execution intent before provider launch can
      // observe the child as an ordinary, policy-less Thread.
      const initialAdmissionError = this.collaboration.commitInitialAdmission(request.threadId, turnId);
      try {
        this.collaboration.consumePendingSubagentActivities(request.threadId, pendingSubagentActivities);
        if (!this.collaboration.hasPendingActivities(request.threadId)) {
          this.collaboration.takePendingCollaborationActivity(request.threadId);
        }
      } catch (error) {
        this.failCommittedActiveTurn(active, error);
      }
      if (initialAdmissionError) {
        this.failCommittedActiveTurn(active, initialAdmissionError);
      } else if (deliveryAdmissionError) {
        this.failCommittedActiveTurn(active, deliveryAdmissionError);
      } else if (!active.lifecyclePublished) {
        active.admissionCommitted = true;
        let startPublication: Awaited<ReturnType<TurnLifecycleCatalog['publishDelegatedThreadStart']>>;
        try {
          startPublication = await this.catalog.publishDelegatedThreadStart(request.threadId);
        } catch (error) {
          startPublication = {
            published: false,
            error: error instanceof Error ? error : new Error(String(error)),
          };
        }
        if (!startPublication.published) {
          this.failCommittedActiveTurn(
            active,
            startPublication.error ?? new Error(`Delegated Thread start publication failed: ${request.threadId}`),
          );
        } else {
          try {
            await this.core.publishRecordedNotification(startedNotification);
            active.lifecyclePublished = true;
          } catch (error) {
            this.failCommittedActiveTurn(active, error);
          }
          if (startPublication.error) this.failCommittedActiveTurn(active, startPublication.error);
        }
      }
      if (durableProjectionError) this.failCommittedActiveTurn(active, durableProjectionError);
      // Only now: the Turn carrying the notice is recorded and running, so the
      // beliefs it reported can be advanced. Everything above can still throw,
      // and a retry must find the same drift still there to report.
      try {
        drift.settle();
      } catch (error) {
        this.failCommittedActiveTurn(active, error);
      }
      if (!record.thread.preview.trim() && preview) {
        try {
          this.catalog.setInitialPreview(request.threadId, preview, startedAt);
        } catch (error) {
          this.failCommittedActiveTurn(active, error);
        }
      }
      try {
        await this.setStatus(
          request.threadId,
          { type: 'active', activeFlags: [] },
          { deferObservers: !active.lifecyclePublished },
        );
      } catch (error) {
        this.failCommittedActiveTurn(active, error);
      }
      const retryUserItems = retryInputBatches.length > 0
        ? [item, ...replayedInputs.map((batch) => batch.user)]
        : [item];
      const clientUserItems = retryUserItems.filter((candidate): candidate is typeof candidate & {
        readonly clientId: string;
      } => candidate.clientId !== null);
      if (clientUserItems.length > 0) {
        try {
          if (request.retryReplacementTarget && !this.core.ephemeral.has(request.threadId)) {
            for (const clientItem of clientUserItems) {
              this.core.metadata.deleteClientInput(request.threadId, clientItem.clientId);
            }
          }
          for (const clientItem of clientUserItems) {
            this.bindClientInput(request.threadId, clientItem.clientId, turnId, clientItem.id);
          }
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
  private async planExplicitSidecarCapacity(
    thread: Thread,
    turn: Turn,
    configuration: EffectiveThreadConfiguration,
    recorder: ItemRecorder,
  ): Promise<number> {
    if (!this.executor.planInputCapacity) return 0;
    const resourceObservation = this.resourceOps.createResourceObservation(thread.id, true);
    const unsupported = async (): Promise<never> => {
      throw new Error('Input capacity planning is read-only');
    };
    const context: TurnExecutionContext = {
      thread,
      turn,
      startupContext: this.collaboration.startupContextForTurn(thread.id, turn.id),
      historyBeforeTurn: this.core.allTurns(thread.id).filter((candidate) => candidate.id !== turn.id),
      configuration,
      signal: new AbortController().signal,
      recorder,
      readContext: (ref) => this.core.payloads.readContext(thread.id, ref),
      readOutput: (ref) => this.core.payloads.readTextReference(thread.id, ref),
      resolveResourceObservationPath: (ref) => resourceObservation.resolvePath(ref),
      resolveImageArtifactPath: (artifact) => resourceObservation.resolveArtifactPath(artifact),
      readResource: (ref) => this.core.payloads.readResource(thread.id, ref),
      persistOutputImage: unsupported,
      persistOutputResource: unsupported,
      persistOutputText: unsupported,
      persistToolCallArguments: unsupported,
      persistContextEvidence: unsupported,
      persistTurnDiagnostics: unsupported,
      onTurnDiagnosticsError: () => undefined,
      persistSkillCatalog: async () => null,
      compactContext: async () => null,
      stageContextCompaction: async () => null,
      onProviderRetry: () => undefined,
      onSteer: () => undefined,
    };
    try {
      const plan = await this.executor.planInputCapacity(context);
      if (!Number.isSafeInteger(plan.remainingInputTokens) || plan.remainingInputTokens < 0) {
        throw new Error('Input capacity planner returned an invalid remaining-token count');
      }
      return plan.remainingInputTokens;
    } finally {
      await resourceObservation.dispose().catch(() => undefined);
    }
  }
  private async executeActiveTurn(active: ActiveTurn): Promise<void> {
      let result: TurnExecutionResult = {};
      let thrown: Error | null = null;
      const initialTurn = this.core.readTurn(active.threadId, active.turnId) ?? active.initialTurn;
      const thread = this.core.requireThread(active.threadId).thread;
      const isDescendantThread = thread.parentThreadId !== null;
      const hidden = this.core.hiddenEphemeralThreads.has(active.threadId);
      const resourceObservation = this.resourceOps.createResourceObservation(active.threadId, true);
      const createdOutputResources: ThreadResourceReference[] = [];
      const deliveryBatch = this.subagentExecutions.deliveryBatchForTurn(active.threadId, active.turnId);
      const carryForwardSidecar = deliveryBatch?.kind === 'explicitAdmission'
        && deliveryBatch.sidecarItemId !== null
        ? {
            itemId: deliveryBatch.sidecarItemId,
            isDetached: () => (
              this.subagentExecutions.readDeliveryBatch(deliveryBatch.batchId)?.state
                === 'detachedForOverflow'
            ),
            detachForOverflow: async () => {
              const providerAttemptSerial = active.providerAttemptSerial;
              if (providerAttemptSerial < 1 || active.controller.signal.aborted) return null;
              const detached = await this.collaboration.detachCarryForwardSidecarForOverflow(
                active.threadId,
                active.turnId,
                deliveryBatch.batchId,
              );
              return detached ? { providerAttemptSerial } : null;
            },
            canRetryAfterDetach: (providerAttemptSerial: number) => (
              this.activeTurns.get(active.threadId) === active
              && !active.finishing
              && active.fatalError === null
              && !active.controller.signal.aborted
              && active.providerAttemptSerial === providerAttemptSerial
              && this.subagentExecutions.readDeliveryBatch(deliveryBatch.batchId)?.state
                === 'detachedForOverflow'
            ),
          }
        : null;
      try {
        if (active.fatalError) throw active.fatalError;
        result = await this.executor.execute({
          thread,
          turn: initialTurn,
          startupContext: this.collaboration.startupContextForTurn(active.threadId, active.turnId),
          historyBeforeTurn: this.core.allTurns(active.threadId).filter((turn) => turn.id !== active.turnId),
          configuration: active.configuration,
          signal: active.controller.signal,
          recorder: active.recorder,
          readContext: (ref) => this.core.payloads.readContext(active.threadId, ref),
          readOutput: (ref) => this.core.payloads.readTextReference(active.threadId, ref),
          resolveResourceObservationPath: (ref) => resourceObservation.resolvePath(ref),
          resolveImageArtifactPath: (artifact) => resourceObservation.resolveArtifactPath(artifact),
          readResource: (ref) => this.core.payloads.readResource(active.threadId, ref),
          persistOutputImage: async (bytes, mimeType) => {
            const sourceBytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const prepared = this.normalizeOutputImage
              ? await this.normalizeOutputImage({
                  bytes: sourceBytes,
                  mimeType,
                  signal: active.controller.signal,
                })
              : defaultOutputImageObservation(sourceBytes, mimeType);
            validatePreparedOutputImage(sourceBytes, mimeType, prepared);
            const observationBytes = Buffer.from(
              prepared.bytes.buffer,
              prepared.bytes.byteOffset,
              prepared.bytes.byteLength,
            );
            const written = await this.core.payloads.writeImageWithStatus(
              active.threadId,
              observationBytes.toString('base64'),
              prepared.mimeType,
            );
            if (written.created) createdOutputResources.push(written.ref);
            return {
              observation: written.ref,
              observationBytes,
              sourceDimensions: prepared.sourceDimensions,
              observationDimensions: prepared.observationDimensions,
            };
          },
          persistOutputResource: async (bytes, mimeType, fileName) => {
            const written = await this.core.payloads.writeResourceWithStatus(
              active.threadId,
              bytes,
              mimeType,
              fileName,
            );
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
          persistToolCallArguments: (value) => this.core.payloads.writeContext(active.threadId, {
            schemaVersion: 1,
            kind: 'toolCallArguments',
            value,
          }),
          persistContextEvidence: (payload, summary) => this.persistExecutionContextEvidence(
            active,
            thread,
            payload,
            summary,
          ),
          persistTurnDiagnostics: (payload) => this.core.payloads.writeTurnDiagnostics(active.threadId, payload),
          inspectTurnDiagnostics: (read) => {
            if (this.activeTurns.get(active.threadId) !== active) return () => undefined;
            active.diagnosticsSnapshot = read;
            return () => {
              if (this.activeTurns.get(active.threadId) === active && active.diagnosticsSnapshot === read) {
                active.diagnosticsSnapshot = null;
              }
            };
          },
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
          ...(this.subagentExecutions.deliveryBatchForTurn(active.threadId, active.turnId) ? {
            onProviderAttempt: () => this.markSubagentDeliveryProviderAttempt(active),
          } : {}),
          ...(carryForwardSidecar ? { carryForwardSidecar } : {}),
          onSteer: (handler) => {
            active.steeringHandler = handler;
            const queued = active.queuedSteering.splice(0);
            for (const input of queued) this.enqueueSteeringDelivery(active, input);
          },
          ...(isDescendantThread && active.mode === 'ordinary' ? {
            onModelCallUsage: (tokens: number) => this.recordSubagentInFlightUsage(active, tokens),
          } : {}),
          ...(isDescendantThread && active.mode === 'ordinary' ? {
            remainingTokenBudget: () => this.subagentBudgetUsage(
              active.threadId,
              this.resolveSubagentBudget(active.threadId),
            ),
            onBudgetWarning: (actuals: { readonly used: number; readonly total: number }) => (
              this.deliverSubagentBudgetWarning(active, actuals.used, actuals.total)
            ),
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
      if (active.lifecyclePublished) {
        this.collaboration.takePendingCollaborationActivity(active.threadId);
        await this.collaboration.flushPendingSubagentActivities(active.threadId, active.turnId);
      }
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
      const failureOrigin = executionError
        ? contextFailure(executionError)
          ? 'contextFailure' as const
          : active.fatalError
            ? 'hostFailure' as const
            : result.failureOrigin ?? 'hostFailure'
        : result.failureOrigin;
      const status = executionError ? 'failed' : aborted ? 'interrupted' : result.status ?? 'completed';
      // An Item the Turn finished without closing was cut off, not errored —
      // a completed Turn has no business painting a red failure mark on the
      // work it just succeeded at. A failed or interrupted Turn keeps its own
      // status for its open Items.
      await active.recorder.finishOpenItems(status === 'completed' ? 'interrupted' : status);
      const completedAt = this.now();
      let turn = decodeTurn({
        id: active.turnId,
        items: active.recorder.orderedItems(),
        itemsView: 'full',
        provenance: initialTurn.provenance,
        status,
        error: executionError
          ? turnErrorFromError(executionError)
          : normalizeTurnError(result.error),
        execution: result.execution ?? initialTurn.execution,
        startedAt: active.startedAt,
        completedAt,
        durationMs: Math.max(0, completedAt - active.startedAt),
      });
      const contributions = hidden || !active.lifecyclePublished ? [] : await this.extensions.turnItems(thread, turn);
      for (const contribution of contributions) {
        await active.recorder.completedImmediately(contribution.item, completedAt);
      }
      turn = decodeTurn({ ...turn, items: active.recorder.orderedItems() });
      await this.core.threadMutex.run(active.threadId, async () => {
        if (this.activeTurns.get(active.threadId) !== active) return;
        const completedNotification = {
          type: 'turn/completed',
          threadId: active.threadId,
          turnId: active.turnId,
          turn,
        } as const;
        let projectionReadable = true;
        try {
          await this.core.recordNotification(completedNotification, {
            deferObservers: !active.lifecyclePublished,
          });
        } catch (error) {
          if (!(error instanceof RecordedNotificationProjectionError)) throw error;
          projectionReadable = false;
          if (active.lifecyclePublished) {
            await this.core.publishRecordedNotification(completedNotification);
          }
        }
        // The rollout append above is the terminal commit. A broken derived
        // projection must not append a second terminal event, but it also cannot
        // safely drive reference-based garbage collection until startup rebuilds
        // it from the rollout.
        if (projectionReadable) {
          const resourceReferences = this.resourceOps.threadStorageReferences(active.threadId);
          await this.resourceOps.discardCreatedResourcesAgainstReferences(
            active.threadId,
            createdOutputResources,
            resourceReferences.resources,
          ).catch(() => undefined);
          const payloadReferences = this.resourceOps.threadStorageReferences(active.threadId);
          await Promise.all([
            this.core.payloads.pruneUnreferencedContexts(active.threadId, payloadReferences.contexts),
            this.core.payloads.pruneUnreferencedTurnDiagnostics(active.threadId, payloadReferences.diagnostics),
          ]).catch(() => undefined);
        }
        if (active.admissionCommitted) this.accrueSubagentBudgetUsage(active, thread, turn.execution);
        this.settleSubagentInFlightUsage(active);
        // Reserve the child terminal pipeline before releasing active-turn
        // ownership. Admission must keep the concurrency slot occupied across
        // the small idle-to-settlement window.
        if (active.admissionCommitted) this.collaboration.prepareChildTerminalSettlement(
          thread,
          turn,
          failureOrigin,
        );
        try {
          await this.setStatus(
            active.threadId,
            { type: 'idle' },
            { deferObservers: !active.lifecyclePublished },
          );
        } catch (error) {
          if (!(error instanceof RecordedNotificationProjectionError)) throw error;
          if (active.lifecyclePublished) {
            await this.core.publishRecordedNotification({
              type: 'thread/status/changed',
              threadId: active.threadId,
              status: { type: 'idle' },
              });
          }
        }
        if (this.activeTurns.get(active.threadId) === active) this.activeTurns.delete(active.threadId);
      });
      if (active.lifecyclePublished) {
        this.catalog.scheduleAutomaticThreadName(
          this.core.requireThread(active.threadId).thread,
          turn,
          active.configuration,
        );
      }
      if (!hidden && active.lifecyclePublished) {
        await this.goalUsage.addUsage(
          active.threadId,
          turn.execution.usage.totalTokens,
          Math.ceil((turn.durationMs ?? 0) / 1000),
          active.turnId,
          turn.status,
        );
        if (status === 'interrupted') await this.extensions.turnAborted(thread, turn);
        else if (executionError) await this.extensions.turnError(thread, turn, executionError);
        else await this.extensions.turnStopped(thread, turn);
      }
      if (active.admissionCommitted) {
        this.transcripts.enqueueTurn(thread, turn);
        this.collaboration.queueChildTurnActivity(thread, turn);
      }
      if (active.lifecyclePublished) {
        this.collaboration.threadBecameIdle(active.threadId);
        if (!hidden) await this.extensions.threadIdle(this.core.requireThread(active.threadId).thread);
      }
    }
  private accrueSubagentBudgetUsage(
      active: ActiveTurn,
      thread: Thread,
      execution: Turn['execution'],
    ): void {
      if (active.budgetUsageAccrued || thread.parentThreadId === null) return;
      try {
        const current = this.subagentExecutions.read(active.threadId);
        if (!current || current.currentTurnId !== active.turnId) return;
        this.subagentExecutions.addGenerationUsageIfCurrent({
          agentId: active.threadId,
          generation: current.generation,
          tokens: execution.usage.totalTokens,
          updatedAt: this.now(),
        });
      } catch (error) {
        this.auditSubagentBudgetFailure('usage accrual', active.threadId, error);
      } finally {
        active.budgetUsageAccrued = true;
      }
    }
  private recordSubagentInFlightUsage(active: ActiveTurn, tokens: number): void {
      if (!Number.isSafeInteger(tokens) || tokens < 0) {
        this.auditSubagentBudgetFailure(
          'model-call usage observation',
          active.threadId,
          new Error('Model-call token usage must be a non-negative safe integer'),
        );
        return;
      }
      active.modelCallTokens += tokens;
      if (!Number.isSafeInteger(active.modelCallTokens)) {
        this.auditSubagentBudgetFailure(
          'model-call usage observation',
          active.threadId,
          new Error('In-flight Subagent usage exceeds the safe integer range'),
        );
        active.modelCallTokens = Number.MAX_SAFE_INTEGER;
      }
    }

  private markSubagentDeliveryProviderAttempt(active: ActiveTurn): void {
      active.providerAttemptSerial += 1;
      if (!Number.isSafeInteger(active.providerAttemptSerial)) {
        throw new Error(`Subagent provider attempt serial overflowed: ${active.turnId}`);
      }
      const batch = this.subagentExecutions.deliveryBatchForTurn(active.threadId, active.turnId);
      if (batch?.state === 'detachedForOverflow') return;
      if (!batch || batch.state !== 'linked') {
        throw new Error(`Subagent delivery provider admission is unavailable: ${active.turnId}`);
      }
      if (batch.providerAttempted) return;
      if (this.subagentExecutions.markDeliveryBatchProviderAttempted(batch.batchId, this.now())) return;
      if (!this.subagentExecutions.readDeliveryBatch(batch.batchId)?.providerAttempted) {
        throw new Error(`Subagent delivery provider attempt marker raced: ${batch.batchId}`);
      }
    }
  private settleSubagentInFlightUsage(active: ActiveTurn): void {
      active.modelCallTokens = 0;
    }
  private auditSubagentBudgetFailure(operation: string, threadId: ThreadId, error: unknown): void {
      console.warn(`[agent][subagent-budget-audit] ${operation} failed`, { threadId, error });
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
      const execution = this.subagentExecutions.read(active.threadId);
      if (
        !execution
        || execution.currentTurnId !== active.turnId
        || !this.subagentExecutions.markBudgetWarningIfCurrent({
          agentId: execution.agentId,
          generation: execution.generation,
          updatedAt: this.now(),
        })
      ) return;
      await this.steerPrivilegedTurn({
        threadId: active.threadId,
        expectedTurnId: active.turnId,
        author: { kind: 'host' },
        input: [{
          type: 'text',
          text: `[Budget notice] ~80% of the token budget is consumed (${used} of ${budget}). `
            + 'Do not imply the assignment is complete merely because the limit is near. '
            + 'Preserve a concise handoff now: concrete progress, checks and evidence with actual results, '
            + 'remaining or uncertain work, and the next useful action.',
        }],
      }, 'advisory');
    }
  private failCommittedActiveTurn(active: ActiveTurn, value: unknown): void {
      if (active.fatalError) return;
      active.fatalError = value instanceof Error ? value : new Error(String(value));
      active.controller.abort();
    }
  /**
   * A Turn died. The THREAD is fine.
   *
   * This used to leave the Thread in `systemError`, which nothing ever cleared
   * and which persists — and both `rollbackThread` and Turn admission require
   * `idle`, so one failure here locked the conversation out of retrying AND out
   * of receiving a new message, permanently, across restarts. The only way
   * forward was to abandon it and start another.
   *
   * The failure is already recorded where it belongs: the Turn is `failed` and
   * carries its `TurnError`. A Thread-level status said the same thing in a
   * field that also happens to be a lock, and the sibling failure path
   * (`executeActiveTurn`) has always ended `idle` for exactly this reason. Two
   * routes to one outcome disagreeing about the Thread was the defect.
   */
  private async failActiveTurn(active: ActiveTurn, error: Error): Promise<void> {
      await this.rejectUserInput(active.threadId, error).catch(() => undefined);
      // This Turn no longer owns the Thread, so it has no business naming the
      // Thread's state. Completion releases ownership BEFORE its tail runs
      // (`activeTurns.delete` then `setStatus(idle)`, then awaited naming, Goal
      // usage, and extension hooks), and a new Turn can be admitted during that
      // window — a throw from the tail would then stamp `idle` over a Turn that
      // is actually running. Whoever owns the Thread has already set its status.
      if (this.activeTurns.get(active.threadId) !== active) return;
      await active.recorder.finishOpenItems('failed').catch(() => undefined);
      const initial = this.core.readTurn(active.threadId, active.turnId) ?? active.initialTurn;
      const thread = this.core.ephemeral.get(active.threadId)?.record.thread ?? this.core.metadata.read(active.threadId)?.thread;
      let failedTurn: Turn | null = null;
      if (initial) {
        const completedAt = this.now();
        const failed = decodeTurn({
          ...initial,
          items: active.recorder.orderedItems(),
          status: 'failed',
          error: turnErrorFromError(error),
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
        }, { deferObservers: !active.lifecyclePublished }).catch(() => undefined);
        if (active.lifecyclePublished && !this.core.hiddenEphemeralThreads.has(active.threadId)) {
          await this.extensions.turnError(this.core.requireThread(active.threadId).thread, failed, error).catch(() => undefined);
        }
      }
      await this.core.threadMutex.run(active.threadId, async () => {
        if (active.admissionCommitted && thread && failedTurn) {
          try {
            this.accrueSubagentBudgetUsage(active, thread, failedTurn.execution);
          } catch (budgetError) {
            console.error('[agent] failed to accrue Subagent usage during Turn failure', budgetError);
          }
        }
        this.settleSubagentInFlightUsage(active);
        if (active.admissionCommitted && thread && failedTurn) {
          // Register terminal settlement while this failed Turn still owns the
          // Thread, closing the same concurrency admission window as success.
          this.collaboration.prepareChildTerminalSettlement(
            thread,
            failedTurn,
            contextFailure(error) ? 'contextFailure' : 'hostFailure',
          );
        }
        const references = this.resourceOps.threadStorageReferences(active.threadId);
        await Promise.all([
          this.core.payloads.pruneUnreferencedContexts(
            active.threadId,
            references.contexts,
          ),
          this.core.payloads.pruneUnreferencedTurnDiagnostics(
            active.threadId,
            references.diagnostics,
          ),
        ]).catch(() => undefined);
        if (this.activeTurns.get(active.threadId) === active) this.activeTurns.delete(active.threadId);
        await this.setStatus(
          active.threadId,
          { type: 'idle' },
          { deferObservers: !active.lifecyclePublished },
        ).catch(() => undefined);
      }).catch(() => undefined);
      if (active.lifecyclePublished && thread && failedTurn) {
        this.catalog.scheduleAutomaticThreadName(thread, failedTurn, active.configuration);
      }
      if (active.admissionCommitted && thread && failedTurn) {
        this.transcripts.enqueueTurn(thread, failedTurn);
        this.collaboration.queueChildTurnActivity(thread, failedTurn);
      }
      if (active.lifecyclePublished) {
        // A failed child follows the same idle transition as a completed or
        // interrupted Turn. Parent delivery may have been deferred while the
        // failure was being finalized, so give the collaboration layer an
        // explicit retry edge after ownership is released.
        this.collaboration.threadBecameIdle(active.threadId);
      }
    }
  async setStatus(
      threadId: ThreadId,
      status: ThreadStatus,
      options: { readonly deferObservers?: boolean } = {},
    ): Promise<void> {
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
      await this.core.recordNotification(
        { type: 'thread/status/changed', threadId, status },
        options,
      );
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
  requireActiveTurn(threadId: ThreadId, turnId: string): ActiveTurn {
      const active = this.activeTurns.get(threadId);
      if (
        !active
        || active.turnId !== turnId
      ) throw this.createThreadBusyError('Expected Turn is not active');
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
  author: ThreadInputAuthor,
  content: readonly ThreadUserContent[],
  clientId: string | null,
  acceptedAt: number,
  reservedItemId?: string,
): Extract<ThreadItem, { readonly type: 'userMessage' }> {
  const id = reservedItemId ?? uuidV7();
  return decodeThreadItem({
    type: 'userMessage',
    id,
    provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: id },
    author,
    clientId,
    content,
    acceptedAt,
  }) as Extract<ThreadItem, { readonly type: 'userMessage' }>;
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

function defaultOutputImageObservation(bytes: Buffer, mimeType: string) {
  const dimensions = readAgentImageDimensions(bytes, mimeType);
  if (!dimensions) {
    throw new ImageObservationNormalizationError('Tool output image dimensions could not be decoded.');
  }
  if (bytes.byteLength > MAX_PROMPT_IMAGE_BYTES) {
    throw new ImageObservationNormalizationError('Tool output image requires normalization before model admission.');
  }
  if (dimensions.width > MAX_PROMPT_IMAGE_DIMENSION || dimensions.height > MAX_PROMPT_IMAGE_DIMENSION) {
    throw new ImageObservationNormalizationError('Tool output image dimensions require normalization before model admission.');
  }
  return {
    bytes,
    mimeType,
    sourceDimensions: dimensions,
    observationDimensions: dimensions,
  };
}

function validatePreparedOutputImage(
  sourceBytes: Buffer,
  sourceMimeType: string,
  prepared: PreparedOutputImageObservation,
): void {
  const observationBytes = Buffer.from(
    prepared.bytes.buffer,
    prepared.bytes.byteOffset,
    prepared.bytes.byteLength,
  );
  const sourceDimensions = readAgentImageDimensions(sourceBytes, sourceMimeType);
  const observationDimensions = readAgentImageDimensions(observationBytes, prepared.mimeType);
  if (
    !sourceDimensions
    || !observationDimensions
    || !validImageDimensions(sourceDimensions)
    || !validImageDimensions(observationDimensions)
  ) {
    throw new ImageObservationNormalizationError('Normalized tool output image dimensions could not be decoded.');
  }
  if (
    sourceDimensions.width !== prepared.sourceDimensions.width
    || sourceDimensions.height !== prepared.sourceDimensions.height
    || observationDimensions.width !== prepared.observationDimensions.width
    || observationDimensions.height !== prepared.observationDimensions.height
  ) {
    throw new ImageObservationNormalizationError('Normalized tool output image geometry does not match its bytes.');
  }
  if (observationBytes.byteLength === 0 || observationBytes.byteLength > MAX_PROMPT_IMAGE_BYTES) {
    throw new ImageObservationNormalizationError('Normalized tool output image exceeds the model-input byte budget.');
  }
  if (
    observationDimensions.width > MAX_PROMPT_IMAGE_DIMENSION
    || observationDimensions.height > MAX_PROMPT_IMAGE_DIMENSION
  ) {
    throw new ImageObservationNormalizationError('Normalized tool output image exceeds the model-input dimension budget.');
  }
}

function validImageDimensions(dimensions: { readonly width: number; readonly height: number }): boolean {
  return Number.isSafeInteger(dimensions.width)
    && dimensions.width > 0
    && Number.isSafeInteger(dimensions.height)
    && dimensions.height > 0;
}

function turnErrorFromError(error: Error): TurnError {
  return { message: error.message, code: errorCode(error) ?? RUNTIME_FAILURE_ERROR_CODE };
}

function normalizeTurnError(error: TurnError | null | undefined): TurnError | null {
  return error ? { ...error, code: normalizeTurnErrorCode(error.code) } : null;
}

function errorCode(error: Error): TurnErrorCode | undefined {
  const code = (error as Error & { readonly code?: unknown }).code;
  return typeof code === 'string' && code ? normalizeTurnErrorCode(code) : undefined;
}

function contextFailure(error: Error): boolean {
  return error instanceof ContextCapacityError || error instanceof ContextCompactionRequiredError;
}

function settlementConfiguration(
  configuration: EffectiveThreadConfiguration,
): EffectiveThreadConfiguration {
  return Object.freeze({
    ...configuration,
    tools: Object.freeze([]),
    skills: Object.freeze([]),
    preloadedSkills: Object.freeze([]),
    plugins: Object.freeze([]),
    mcpServers: Object.freeze([]),
  });
}
