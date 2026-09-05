import { decodePrivilegedTurnStartRequest,decodePrivilegedTurnSteerRequest,decodeThread,decodeThreadItem,decodeTurn } from '../../../core/agent/codec';
import type { EffectiveThreadConfiguration } from '../../../core/agent/configuration';
import { createHostRootTurnAdmissionBarrierSnapshot,createThreadAdmissionBarrierSnapshot } from '../../../core/agent/extensions';
import { RUNTIME_FAILURE_ERROR_CODE,normalizeTurnErrorCode,type AdditionalContext,type ContextCompactionThreadItem,type ContextCursor,type ContextEvidenceKind,type ContextEvidenceThreadItem,type PrivilegedTurnStartRequest,type PrivilegedTurnSteerRequest,type RendererTurnStartRequest,type RendererTurnSteerRequest,type RequestUserInputRequest,type RequestUserInputResponse,type Thread,type ThreadContextPayload,type ThreadContextPayloadReference,type ThreadId,type ThreadInputAuthor,type ThreadItem,type ThreadItemOutputReference,type ThreadResourceReference,type ThreadStatus,type ThreadUserContent,type Turn,type TurnDiagnosticsPayload,type TurnError,type TurnErrorCode,type TurnId,type TurnStartResponse,type TurnStatus,type TurnSteerResponse } from '../../../core/agent/protocol';
import { threadPreviewFromContent } from '../../../core/agent/threadPreview';
import { normalizeRequestUserInputToolInput } from '../../../core/agent/tools';
import { MAX_PROMPT_IMAGE_BYTES,MAX_PROMPT_IMAGE_DIMENSION } from '../../../core/agentAttachmentLimits';
import type { DocumentProjection } from '../../../core/types';
import { planContextCompaction } from '../context/ContextCompaction';
import { assertContextPayloadDependencies, contextPayloadDependencies } from '../context/contextDependencies';
import { cursorFor,selectEffectiveContext } from '../context/ContextEpoch';
import { admitContextEvidence,contextEvidenceItem } from '../context/evidenceAdmission';
import { observedSkillFilePaths,planSkillCatalogEvidence } from '../context/SkillContextReducer';
import { assertCanonicalUserContent } from '../context/userContentIntegrity';
import type { ExtensionRegistry } from '../ExtensionRegistry';
import { readAgentImageDimensions } from '../capabilities/agentLocalTools';
import { ImageObservationNormalizationError } from '../imageArtifacts';
import type { ThreadCatalogRecord } from '../persistence/ThreadMetadataStore';
import { ItemRecorder } from '../runtime/ItemRecorder';
import { factorLargeTextArguments } from '../runtime/largeTextArguments';
import type { OutputImageObservationNormalizer,PreparedOutputImageObservation,StagedContextCompaction,SteeredTurnInput,TurnExecutionContext,TurnExecutionResult,TurnExecutor } from '../runtime/types';
import type { SkillAdmissionResolution,SkillAdmissionResolutionInput } from '../ThreadService';
import { uuidV7 } from '../uuid';
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
  recordedExecution: Turn['execution'] | null;
  lifecyclePublished: boolean;
  diagnosticsSnapshot: (() => TurnDiagnosticsPayload | null) | null;
}
interface PendingUserInput { readonly request: RequestUserInputRequest; readonly resolve: (response: RequestUserInputResponse) => void;
  readonly reject: (error: Error) => void; readonly abort: () => void; timer: ReturnType<typeof setTimeout> | null; }
interface AcceptedTurn { readonly response: TurnStartResponse; readonly thread: Thread; readonly active: ActiveTurn | null; }
export interface StagedContextEvidence {
  readonly payload: Extract<ThreadContextPayload, { readonly kind: ContextEvidenceKind }>;
  readonly payloadRef: ThreadContextPayloadReference;
  readonly contextRefs: readonly ThreadContextPayloadReference[];
  readonly internalTextRefs: readonly import('../../../core/agent/protocol').ThreadInternalTextPayloadReference[];
  readonly resourceRefs: readonly ThreadResourceReference[];
  readonly outputRefs: readonly ThreadItemOutputReference[];
  readonly summary: string;
}
type InternalTurnStartRequest = Omit<PrivilegedTurnStartRequest, 'author'> & {
  readonly author: ThreadInputAuthor;
  readonly stagedContextEvidence?: readonly StagedContextEvidence[];
  readonly additionalContextResourceRefs?: readonly ThreadResourceReference[];
  readonly additionalContextSource?: string;
  readonly reuseStagedContextEvidenceOnly?: boolean;
  readonly rerunReplacementTarget?: Turn;
  readonly rerunInputBatches?: readonly CanonicalTurnRerunInputBatch[];
};
type InternalTurnSteerRequest = Omit<PrivilegedTurnSteerRequest, 'author'> & {
  readonly author: ThreadInputAuthor;
};
export interface CanonicalTurnRerunInputBatch {
  readonly author: ThreadInputAuthor;
  readonly input: readonly ThreadUserContent[];
  readonly clientUserMessageId: string | null;
  readonly acceptedAt: number;
  readonly stagedContextEvidence: readonly StagedContextEvidence[];
}
export type CanonicalTurnRerunAdmission = Pick<PrivilegedTurnStartRequest, 'threadId' | 'trigger'> & {
  readonly inputBatches: readonly CanonicalTurnRerunInputBatch[];
  readonly replacedTurn: Turn;
};

const FAILURE_CONTINUATION_DIRECTIVE = [
  'Continue from the latest failed Turn.',
  'Treat its settled assistant and tool history as completed evidence.',
  'Do not repeat those tool calls unless the user explicitly asks you to.',
].join(' ');
interface TurnLifecycleCatalog {
  createThread: import('./ThreadCatalogOps').ThreadCatalogOps['createThread']; deleteThread: import('./ThreadCatalogOps').ThreadCatalogOps['deleteThread'];
  setInitialPreview: import('./ThreadCatalogOps').ThreadCatalogOps['setInitialPreview']; scheduleAutomaticThreadName: import('./ThreadCatalogOps').ThreadCatalogOps['scheduleAutomaticThreadName'];
  replaceLatestTurnForRerunWithLocksHeld: import('./ThreadCatalogOps').ThreadCatalogOps['replaceLatestTurnForRerunWithLocksHeld'];
}
/**
 * The account layer's hook. Every Thread's completed Turn passes through here,
 * including hidden feature-owned Threads.
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

export class TurnLifecycle {
  private readonly activeTurns = new Map<ThreadId, ActiveTurn>(); private readonly pendingUserInputs = new Map<ThreadId, PendingUserInput>();
  constructor(
    private readonly core: ThreadCore, private readonly resourceOps: ThreadResourceOps,
    private readonly catalog: TurnLifecycleCatalog,
    private readonly transcripts: TurnLifecycleTranscripts,
    private readonly documentDrift: TurnLifecycleDocumentDrift,
    private readonly executor: TurnExecutor, private readonly extensions: ExtensionRegistry,
    private readonly getDocumentProjection: () => DocumentProjection | null,
    private readonly resolveReferencedAsset: ((assetId: string) => Promise<import('../capabilities/agentReferencedAssets').ReferencedAssetResolution | null>) | undefined,
    private readonly resolveSkillAdmission: (input: SkillAdmissionResolutionInput) => Promise<SkillAdmissionResolution>,
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
    ): Promise<TurnStartResponse> {
      const contextCommand = parseContextCommand(request.input);
      if (contextCommand) return this.startContextCommand(request, contextCommand, admissionGuard);
      const privileged: InternalTurnStartRequest = {
        ...request,
      ...(reservedTurnId === undefined ? {} : { turnId: reservedTurnId }),
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
              readInternalTextProjection: (ref, maxPrefixChars) => (
                this.core.payloads.readInternalTextProjection(request.threadId, ref, maxPrefixChars)
              ),
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
              internalTextRefs: [],
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
              this.resourceOps.threadInternalTextPayloadReferences(request.threadId),
            ).catch(() => undefined);
          }
          throw error;
        }
      }); }
  async startPrivilegedTurn(request: PrivilegedTurnStartRequest): Promise<TurnStartResponse> {
      return (await this.acceptAndLaunch(decodePrivilegedTurnStartRequest(request))).response;
    }
  async startRerunRootTurnWithHostLock(
      request: CanonicalTurnRerunAdmission,
      admissionGuard?: () => void,
    ): Promise<TurnStartResponse> {
      const initialInput = request.inputBatches[0];
      if (!initialInput) throw new Error('Rerun input is missing from the canonical Turn');
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
        rerunReplacementTarget: request.replacedTurn,
        rerunInputBatches: request.inputBatches,
      }, true, admissionGuard));
      this.scheduleAcceptedTurn(accepted);
      return accepted.response;
    }
  async canContinueFromFailure(threadId: ThreadId, turn: Turn): Promise<boolean> {
      if (!this.executor.planFailureContinuation) return false;
      const record = this.core.requireThread(threadId);
      const resourceObservation = this.resourceOps.createResourceObservation(record.thread.id, true);
      const unsupported = async (): Promise<never> => {
        throw new Error('Failure continuation planning is read-only');
      };
      const recorder = new ItemRecorder(
        record.thread.id,
        turn.id,
        turn.items,
        unsupported,
      );
      const context: TurnExecutionContext = {
        thread: record.thread,
        turn,
        startupContext: null,
        historyBeforeTurn: this.core.allTurns(record.thread.id).filter((candidate) => candidate.id !== turn.id),
        configuration: record.configuration,
        signal: new AbortController().signal,
        recorder,
        readContext: (ref) => this.core.payloads.readContext(record.thread.id, ref),
        readInternalText: (ref) => this.core.payloads.readInternalText(record.thread.id, ref),
        readOutput: (ref) => this.core.payloads.readTextReference(record.thread.id, ref),
        resolveResourceObservationPath: (ref) => resourceObservation.resolvePath(ref),
        resolveImageArtifactPath: (artifact) => resourceObservation.resolveArtifactPath(artifact),
        readResource: (ref) => this.core.resources.readExact(ref),
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
        return await this.executor.planFailureContinuation(context);
      } finally {
        await resourceObservation.dispose().catch(() => undefined);
      }
    }
  async startContinuedRootTurnWithHostLock(
      threadId: ThreadId,
      sourceTurnId: TurnId,
      admissionGuard?: () => void,
    ): Promise<TurnStartResponse> {
      const accepted = await this.core.threadMutex.run(threadId, () => this.acceptTurn({
        threadId,
        input: [],
        author: { kind: 'host' },
        trigger: { kind: 'continuation', sourceTurnId },
        additionalContext: {
          continuation: {
            value: FAILURE_CONTINUATION_DIRECTIVE,
            kind: 'application',
            purpose: 'instruction',
          },
        },
        additionalContextSource: `turn-continuation:${sourceTurnId}`,
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
            snapshot: skillAdmission.catalogSnapshot,
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
            preloadedSkillInvocations: skillAdmission.preloadedInvocations,
            skillInvocation: skillAdmission.invocation,
            includeHostContext: !this.core.hiddenEphemeralThreads.has(request.threadId),
            projection: admissionProjection,
            createItemId: () => uuidV7(),
            writeContext: (payload) => this.core.payloads.writeContext(thread.id, payload),
            resolveAsset: this.resolveReferencedAsset,
            writeResource: (bytes, mimeType, fileName) => (
              this.core.resources.writeBytes(thread.id, bytes, mimeType, fileName)
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
            references.internalTexts,
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
      if (request.rerunReplacementTarget) {
        const clientIds = (request.rerunInputBatches ?? [])
          .flatMap((batch) => batch.clientUserMessageId ? [batch.clientUserMessageId] : []);
        if (new Set(clientIds).size !== clientIds.length) {
          throw new Error('Rerun input contains duplicate client ids');
        }
        for (const clientId of clientIds) {
          const rerunBinding = this.readCanonicalClientBinding(request.threadId, clientId);
          if (rerunBinding && rerunBinding.turn.id !== request.rerunReplacementTarget.id) {
            throw new Error('Rerun client id is already bound to another Turn');
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
      if (this.core.stoppingThreads.has(request.threadId)) throw this.createThreadBusyError('Thread is stopping');
      if (record.archived) throw this.createThreadBusyError('Thread is archived');
      if (this.activeTurns.has(request.threadId)) {
        throw this.createThreadBusyError('Thread already has an active Turn', true);
      }
      if (onlyIfIdle && record.thread.status.type !== 'idle') throw this.createThreadBusyError('Thread is not idle');
      const startedAt = this.now();
      const turnId = request.turnId ?? uuidV7(startedAt);
      const admission = request.rerunInputBatches
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
          references.internalTexts,
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
      const rerunInputBatches = request.rerunInputBatches ?? [];
      const initialRerunInput = rerunInputBatches[0];
      const item = userMessage(
        request.threadId,
        turnId,
        initialRerunInput?.author ?? request.author,
        input,
        request.clientUserMessageId ?? null,
        initialRerunInput?.acceptedAt ?? startedAt,
      );
      const provenance = {
        originThreadId: request.threadId,
        originTurnId: turnId,
        trigger: request.trigger,
      } as const;
      const turnConfiguration = record.configuration;
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
            internalTextRefs: staged.internalTextRefs,
            outputRefs: staged.outputRefs,
          });
          assertContextPayloadDependencies(stagedItem, staged.payload);
          return stagedItem;
        })
      );
      const stagedItems = materializeStagedEvidence(request.stagedContextEvidence ?? []);
      const replayedInputs = rerunInputBatches.slice(1).map((batch) => {
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
        snapshot: skillAdmission.catalogSnapshot,
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
        preloadedSkillInvocations: skillAdmission.preloadedInvocations,
        skillInvocation: skillAdmission.invocation,
        includeHostContext: !this.core.hiddenEphemeralThreads.has(request.threadId),
        projection: admissionProjection,
        createItemId: () => uuidV7(),
        writeContext: (payload) => this.core.payloads.writeContext(record.thread.id, payload),
        resolveAsset: this.resolveReferencedAsset,
        writeResource: (bytes, mimeType, fileName) => (
          this.core.resources.writeBytes(record.thread.id, bytes, mimeType, fileName)
        ),
        onResourceCreated: recordCreatedEvidenceResource,
      });
      const initialItems = [
        ...stagedItems,
        ...evidence.items,
        item,
        ...replayedInputs.flatMap((batch) => batch.items),
      ];
      const turn = decodeTurn({ ...provisionalTurn, items: initialItems });
      const recorder = new ItemRecorder(
        request.threadId,
        turnId,
        initialItems,
        (notification) => this.core.recordNotification(notification),
        (item) => this.bindFinalCitations(record.thread, item),
      );
      let resolveCompletion!: () => void;
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
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
        lifecyclePublished: true,
        diagnosticsSnapshot: null,
      };
      const startedNotification = {
        type: 'turn/started',
        threadId: request.threadId,
        turnId,
        turn,
        ...(request.toolTaskAdmission ? { toolTaskAdmission: request.toolTaskAdmission } : {}),
      } as const;
      try {
        admissionGuard?.();
        if (request.rerunReplacementTarget) {
          await this.catalog.replaceLatestTurnForRerunWithLocksHeld(
            request.threadId,
            request.rerunReplacementTarget,
            startedNotification,
          );
        } else {
          await this.core.recordNotification(startedNotification);
        }
      } catch (error) {
        throw error;
      }
      // From the durable Turn onward, exactly one in-process owner must
      // terminalize it. No later marker, projection, or observer failure may
      // escape through spawn and strand an accepted Turn without a launch tail.
      this.activeTurns.set(request.threadId, active);
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
      const rerunUserItems = rerunInputBatches.length > 0
        ? [item, ...replayedInputs.map((batch) => batch.user)]
        : [item];
      const clientUserItems = rerunUserItems.filter((candidate): candidate is typeof candidate & {
        readonly clientId: string;
      } => candidate.clientId !== null);
      if (clientUserItems.length > 0) {
        try {
          if (request.rerunReplacementTarget && !this.core.ephemeral.has(request.threadId)) {
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
  private async executeActiveTurn(active: ActiveTurn): Promise<void> {
      let result: TurnExecutionResult = {};
      let thrown: Error | null = null;
      const initialTurn = this.core.readTurn(active.threadId, active.turnId) ?? active.initialTurn;
      const thread = this.core.requireThread(active.threadId).thread;
      const hidden = this.core.hiddenEphemeralThreads.has(active.threadId);
      const resourceObservation = this.resourceOps.createResourceObservation(active.threadId, true);
      const createdOutputResources: ThreadResourceReference[] = [];
      try {
        if (active.fatalError) throw active.fatalError;
        result = await this.executor.execute({
          thread,
          turn: initialTurn,
          startupContext: null,
          historyBeforeTurn: this.core.allTurns(active.threadId).filter((turn) => turn.id !== active.turnId),
          configuration: active.configuration,
          signal: active.controller.signal,
          recorder: active.recorder,
          readContext: (ref) => this.core.payloads.readContext(active.threadId, ref),
          readInternalText: (ref) => this.core.payloads.readInternalText(active.threadId, ref),
          readOutput: (ref) => this.core.payloads.readTextReference(active.threadId, ref),
          resolveResourceObservationPath: (ref) => resourceObservation.resolvePath(ref),
          resolveImageArtifactPath: (artifact) => resourceObservation.resolveArtifactPath(artifact),
          readResource: (ref) => this.core.resources.readExact(ref),
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
            const written = await this.core.resources.writeBytes(
              active.threadId,
              observationBytes,
              prepared.mimeType,
              'tool-output-image',
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
            const written = await this.core.resources.writeBytes(
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
          persistToolCallArguments: async (value, selected) => {
            const refs = [];
            for (const binding of selected) {
              refs.push(await this.core.payloads.writeInternalText(active.threadId, binding.value));
            }
            const factored = factorLargeTextArguments(value, selected, refs);
            const ref = await this.core.payloads.writeContext(active.threadId, factored.payload);
            return { storage: 'payload', ref, internalTextRefs: factored.internalTextRefs };
          },
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
          onSteer: (handler) => {
            active.steeringHandler = handler;
            const queued = active.queuedSteering.splice(0);
            for (const input of queued) this.enqueueSteeringDelivery(active, input);
          },
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
            this.core.payloads.pruneUnreferencedContexts(
              active.threadId,
              payloadReferences.contexts,
              payloadReferences.internalTexts,
            ),
            this.core.payloads.pruneUnreferencedTurnDiagnostics(active.threadId, payloadReferences.diagnostics),
          ]).catch(() => undefined);
        }
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
      this.transcripts.enqueueTurn(thread, turn);
      if (active.lifecyclePublished) {
        if (!hidden) await this.extensions.threadIdle(this.core.requireThread(active.threadId).thread);
      }
    }
  private async bindFinalCitations(thread: Thread, item: ThreadItem): Promise<ThreadItem> {
    try {
      return await this.resourceOps.bindFinalCitations(thread, item);
    } catch (error) {
      console.warn(`[agent] Final citation binding degraded for ${thread.id}`, error);
      return item;
    }
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
          readInternalTextProjection: (ref, maxPrefixChars) => (
            this.core.payloads.readInternalTextProjection(active.threadId, ref, maxPrefixChars)
          ),
        });
        if (!plan) return null;
        const cleanupLocked = () => this.core.payloads.pruneUnreferencedContexts(
          active.threadId,
          this.resourceOps.threadContextPayloadReferences(active.threadId),
          this.resourceOps.threadInternalTextPayloadReferences(active.threadId),
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
            internalTextRefs: [],
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
        const dependencies = contextPayloadDependencies(payload);
        const item = contextEvidenceItem({
          thread,
          turnId: active.turnId,
          createItemId: () => active.recorder.createItemId(),
        }, payload.kind, payloadRef, summary, dependencies.resources, {
          contextRefs: dependencies.contexts,
          internalTextRefs: dependencies.internalTexts,
          outputRefs: dependencies.outputs,
        });
        assertContextPayloadDependencies(item, payload);
        return await active.recorder.completedImmediately(item, this.now()) as ContextEvidenceThreadItem;
      } catch (error) {
        await this.core.payloads.pruneUnreferencedContexts(
          active.threadId,
          this.resourceOps.threadContextPayloadReferences(active.threadId),
          this.resourceOps.threadInternalTextPayloadReferences(active.threadId),
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
        const references = this.resourceOps.threadStorageReferences(active.threadId);
        await Promise.all([
          this.core.payloads.pruneUnreferencedContexts(
            active.threadId,
            references.contexts,
            references.internalTexts,
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
      if (thread && failedTurn) this.transcripts.enqueueTurn(thread, failedTurn);
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
