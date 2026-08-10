import { decodePrivilegedTurnStartRequest,decodeThread,decodeThreadItem,decodeTurn } from '../../../core/agent/codec';
import type { EffectiveThreadConfiguration } from '../../../core/agent/configuration';
import { createHostRootTurnAdmissionBarrierSnapshot,createThreadAdmissionBarrierSnapshot } from '../../../core/agent/extensions';
import { RUNTIME_FAILURE_ERROR_CODE,normalizeTurnErrorCode,type ContextCompactionThreadItem,type ContextCursor,type ContextEvidenceKind,type ContextEvidenceThreadItem,type PrivilegedTurnStartRequest,type RendererTurnStartRequest,type RequestUserInputRequest,type RequestUserInputResponse,type RoleCatalogContextPayload,type Thread,type ThreadContextPayload,type ThreadContextPayloadReference,type ThreadId,type ThreadItem,type ThreadResourceReference,type ThreadStatus,type ThreadUserContent,type Turn,type TurnError,type TurnErrorCode,type TurnId,type TurnStartResponse,type TurnStatus,type TurnSteerRequest,type TurnSteerResponse } from '../../../core/agent/protocol';
import { threadPreviewFromContent } from '../../../core/agent/threadPreview';
import { normalizeRequestUserInputToolInput } from '../../../core/agent/tools';
import { MAX_PROMPT_IMAGE_BYTES,MAX_PROMPT_IMAGE_DIMENSION } from '../../../core/agentAttachmentLimits';
import type { DocumentProjection } from '../../../core/types';
import { planContextCompaction } from '../context/ContextCompaction';
import { assertContextPayloadDependencies } from '../context/contextDependencies';
import { cursorFor,selectEffectiveContext } from '../context/ContextEpoch';
import { admitContextEvidence,contextEvidenceItem } from '../context/evidenceAdmission';
import { planRoleCatalogEvidence } from '../context/RoleContextReducer';
import { observedSkillFilePaths,planSkillCatalogEvidence } from '../context/SkillContextReducer';
import type { ExtensionRegistry } from '../ExtensionRegistry';
import { readAgentImageDimensions } from '../capabilities/agentLocalTools';
import { ImageObservationNormalizationError } from '../imageArtifacts';
import { cappedChildPoolId,requestPoolIdForTurn,type SubagentRequestLedger,type SubagentRequestMember,type SubagentRequestPool,type SubagentRequestPoolId } from '../persistence/SubagentRequestLedger';
import type { ThreadCatalogRecord } from '../persistence/ThreadMetadataStore';
import { ItemRecorder } from '../runtime/ItemRecorder';
import type { OutputImageObservationNormalizer,PreparedOutputImageObservation,StagedContextCompaction,SteeredTurnInput,TurnExecutionResult,TurnExecutor } from '../runtime/types';
import { SubagentBudgetExhaustedError } from '../SubagentBudgetExhaustedError';
import { SubagentRequestClosedError } from '../SubagentRequestClosedError';
import type { SkillAdmissionResolution,SkillAdmissionResolutionInput } from '../ThreadService';
import { uuidV7 } from '../uuid';
import type { PendingSubagentActivity,StagedContextEvidence } from './SubagentCollaboration';
import { ThreadCore } from './ThreadCore';
import type { ThreadResourceOps } from './ThreadResourceOps';
interface ActiveTurn {
  readonly threadId: ThreadId; readonly turnId: string;
  readonly controller: AbortController; readonly recorder: ItemRecorder;
  readonly configuration: EffectiveThreadConfiguration; readonly startedAt: number;
  fatalError: Error | null; finishing: boolean;
  steeringHandler: ((input: SteeredTurnInput) => void | Promise<void>) | null;
  readonly queuedSteering: SteeredTurnInput[]; steeringDelivery: Promise<void>;
  readonly completion: Promise<void>; readonly resolveCompletion: () => void;
  recordedExecution: Turn['execution'] | null; budgetUsageAccrued: boolean;
  modelCallTokens: number; inFlightPoolId: SubagentRequestPoolId | null;
}
interface PendingUserInput { readonly request: RequestUserInputRequest; readonly resolve: (response: RequestUserInputResponse) => void;
  readonly reject: (error: Error) => void; readonly abort: () => void; timer: ReturnType<typeof setTimeout> | null; }
interface AcceptedTurn { readonly response: TurnStartResponse; readonly thread: Thread; readonly active: ActiveTurn | null; }
type InternalTurnStartRequest = PrivilegedTurnStartRequest & { readonly stagedContextEvidence?: readonly StagedContextEvidence[]; };
interface TurnLifecycleCatalog {
  createThread: import('./ThreadCatalogOps').ThreadCatalogOps['createThread']; deleteThread: import('./ThreadCatalogOps').ThreadCatalogOps['deleteThread'];
  setInitialPreview: import('./ThreadCatalogOps').ThreadCatalogOps['setInitialPreview']; scheduleAutomaticThreadName: import('./ThreadCatalogOps').ThreadCatalogOps['scheduleAutomaticThreadName'];
}
interface TurnLifecycleCollaboration {
  pendingActivities(threadId: ThreadId): readonly PendingSubagentActivity[]; hasPendingActivities(threadId: ThreadId): boolean;
  materializePendingActivityItems(threadId: ThreadId, turnId: TurnId, activities: readonly PendingSubagentActivity[]): ThreadItem[]; consumePendingSubagentActivities(threadId: ThreadId, consumed: readonly PendingSubagentActivity[]): void;
  takePendingCollaborationActivity(threadId: ThreadId): boolean; signalCollaborationActivity(threadId: ThreadId): void;
  flushPendingSubagentActivities(threadId: ThreadId, turnId: TurnId): Promise<readonly PendingSubagentActivity[]>; queueChildTurnActivity(thread: Thread, turn: Turn): void;
}
/**
 * The account layer's hook. It is deliberately NOT part of the collaboration
 * bag: every Thread's completed Turn passes through here, and only some of them
 * are a delegated child's.
 */
interface TurnLifecycleTranscripts { enqueueTurn(thread: Thread, turn: Turn): void; }
interface TurnLifecycleGoalUsage { addUsage(threadId: ThreadId, tokens: number, elapsedSeconds: number, turnId: TurnId, terminalStatus: TurnStatus): Promise<void>; }
export interface ResolvedSubagentBudget {
  readonly member: SubagentRequestMember | null;
  readonly pool: SubagentRequestPool | null;
  readonly resolutionFailed?: boolean;
}
export class TurnLifecycle {
  private readonly activeTurns = new Map<ThreadId, ActiveTurn>(); private readonly pendingUserInputs = new Map<ThreadId, PendingUserInput>();
  private readonly inFlightPoolUsage = new Map<SubagentRequestPoolId, Map<ThreadId, number>>();
  constructor(
    private readonly core: ThreadCore, private readonly resourceOps: ThreadResourceOps,
    private readonly catalog: TurnLifecycleCatalog, private readonly collaboration: TurnLifecycleCollaboration,
    private readonly transcripts: TurnLifecycleTranscripts,
    private readonly executor: TurnExecutor, private readonly extensions: ExtensionRegistry,
    private readonly subagentBudgets: SubagentRequestLedger,
    private readonly getDocumentProjection: () => DocumentProjection | null,
    private readonly resolveReferencedAsset: ((assetId: string) => Promise<import('../capabilities/agentReferencedAssets').ReferencedAssetResolution | null>) | undefined,
    private readonly resolveSkillAdmission: (input: SkillAdmissionResolutionInput) => Promise<SkillAdmissionResolution>,
    private readonly resolveRoleCatalog: (cwd: string) => Promise<RoleCatalogContextPayload | null>, private readonly goalUsage: TurnLifecycleGoalUsage,
    private readonly normalizeOutputImage: OutputImageObservationNormalizer | undefined,
    private readonly now: () => number, private readonly createThreadBusyError: (message: string) => Error,
    private readonly isThreadBusyError: (error: unknown) => boolean,
  ) {}
  activeTurnsForInspection(): Map<ThreadId, ActiveTurn> { return this.activeTurns; } pendingUserInputsForInspection(): Map<ThreadId, PendingUserInput> { return this.pendingUserInputs; }
  activeTurnId(threadId: ThreadId): string | null { return this.activeTurns.get(threadId)?.turnId ?? null; } hasActiveTurn(threadId: ThreadId): boolean { return this.activeTurns.has(threadId); }
  async abortForSubtreeStop(threadId: ThreadId): Promise<void> {
    await this.core.threadMutex.run(threadId, async () => { this.activeTurns.get(threadId)?.controller.abort(); this.pendingUserInputs.get(threadId)?.abort(); });
  }
  async recordSubagentActivity(
    ownerThreadId: ThreadId,
    ownerTurnId: string,
    agentThreadId: ThreadId,
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
        if (this.isThreadBusyError(error)) return null;
        throw error;
      }
    }
  async steerTurn(
      request: TurnSteerRequest,
      deliveryFailureMode: 'fatal' | 'advisory' = 'fatal',
    ): Promise<TurnSteerResponse> { return this.core.threadMutex.run(request.threadId, async () => {
        const existing = request.clientUserMessageId
          ? this.readCanonicalClientBinding(request.threadId, request.clientUserMessageId)
          : null;
        if (existing) {
          return { turnId: existing.turn.id, acceptedItemId: existing.itemId, deduplicated: true };
        }
        const active = this.activeTurns.get(request.threadId);
        if (!active || active.turnId !== request.expectedTurnId) throw this.createThreadBusyError('Expected Turn is not active');
        if (active.finishing || active.fatalError) throw this.createThreadBusyError('Expected Turn is no longer accepting steering');
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
                turnId: active.turnId,
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
  /**
   * The pool a child spawned by `parentThreadId` inside `parentTurnId` joins:
   * the parent's own coverage first, then this delegating Turn's pool. A Turn
   * with neither resolves to nothing, and the spawn creates the Turn's pool —
   * which is why a new user Turn can always delegate again.
   */
  resolveSubagentSpawnBudget(parentThreadId: ThreadId, parentTurnId: TurnId): ResolvedSubagentBudget | null {
      const inherited = this.resolveSubagentBudgetFrom(parentThreadId, true);
      if (inherited?.pool || inherited?.resolutionFailed) return inherited;
      const turnPool = this.subagentBudgets.readPool(requestPoolIdForTurn(parentTurnId));
      if (!turnPool) return inherited;
      return { member: inherited?.member ?? null, pool: turnPool };
    }
  assertSubagentBudgetAvailable(threadId: ThreadId): ResolvedSubagentBudget | null {
      const budget = this.resolveSubagentBudget(threadId);
      this.assertResolvedSubagentBudgetAvailable(threadId, budget);
      return budget;
    }
  assertSubagentSpawnBudgetAvailable(threadId: ThreadId, turnId: TurnId): ResolvedSubagentBudget | null {
      const budget = this.resolveSubagentSpawnBudget(threadId, turnId);
      this.assertResolvedSubagentBudgetAvailable(threadId, budget);
      return budget;
    }
  /**
   * What the collaboration views report. A child whose request pool has been
   * reclaimed is no longer bounded by anything, but it did spend: report its
   * recorded contribution with a null budget rather than a zero that reads as
   * "this child has done nothing".
   */
  subagentBudgetView(threadId: ThreadId): {
    readonly tokenBudget: number | null;
    readonly tokensUsed: number;
  } | null {
      const budget = this.resolveSubagentBudget(threadId);
      const snapshot = this.subagentBudgetSnapshot(threadId, budget);
      if (snapshot) return snapshot;
      const recorded = budget?.member?.tokensUsed ?? 0;
      return recorded > 0 ? { tokenBudget: null, tokensUsed: recorded } : null;
    }
  refreshActiveSubagentBudgetCoverage(): void {
      for (const active of this.activeTurns.values()) {
        const poolId = this.resolveSubagentBudget(active.threadId)?.pool?.poolId ?? null;
        this.bindSubagentInFlightPool(active, poolId);
      }
    }
  private resolveSubagentBudgetFrom(
      threadId: ThreadId,
      markFailure: boolean,
    ): ResolvedSubagentBudget | null {
      try {
        let member = this.subagentBudgets.readMember(threadId);
        const pool = this.authoritativeSubagentPool(threadId, member);
        const resolvedPoolId = pool?.poolId ?? null;
        if (member && member.poolId !== resolvedPoolId) {
          const recordedPoolId = member.poolId;
          member = this.subagentBudgets.rebindMemberPool(threadId, resolvedPoolId);
          console.warn(
            '[agent][subagent-budget-audit] corrected member pool binding',
            { threadId, recordedPoolId, resolvedPoolId },
          );
          if (!member) throw new Error(`Subagent budget member disappeared during re-bind: ${threadId}`);
        }
        return member || pool ? { member, pool } : null;
      } catch (error) {
        this.auditSubagentBudgetFailure('ancestor pool resolution', threadId, error);
        return markFailure ? { member: null, pool: null, resolutionFailed: true } : null;
      }
    }
  /**
   * The pool a Thread's own Turns debit. The spawn binding is authoritative;
   * a member recorded before its request had a pool heals to that request's
   * pool, never to a later one — healing forward would migrate a fire-and-forget
   * child onto a budget the user never spent on it. The ancestor walk stays as
   * the guarded fallback for a Thread whose own member row is missing.
   */
  private authoritativeSubagentPool(
      threadId: ThreadId,
      member: SubagentRequestMember | null,
    ): SubagentRequestPool | null {
      if (member) {
        const bound = member.poolId === null ? null : this.subagentBudgets.readPool(member.poolId);
        if (bound) return bound;
        const originPool = this.subagentBudgets.readPool(requestPoolIdForTurn(member.originTurnId));
        if (originPool) return originPool;
      }
      const visited = new Set<ThreadId>();
      let currentThreadId = this.core.requireThread(threadId).thread.parentThreadId;
      while (currentThreadId !== null && !visited.has(currentThreadId)) {
        visited.add(currentThreadId);
        const ancestor = this.subagentBudgets.readMember(currentThreadId);
        const ancestorPool = ancestor?.poolId === undefined || ancestor.poolId === null
          ? null
          : this.subagentBudgets.readPool(ancestor.poolId);
        if (ancestorPool) return ancestorPool;
        const anchored = this.subagentBudgets.readPool(cappedChildPoolId(currentThreadId));
        if (anchored) return anchored;
        currentThreadId = this.core.requireThread(currentThreadId).thread.parentThreadId;
      }
      return null;
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
      const closedRequest = this.closedRequestFor(threadId, budget);
      if (closedRequest) throw new SubagentRequestClosedError(closedRequest.originTurnId);
      const snapshot = this.subagentBudgetSnapshot(threadId, budget);
      if (snapshot && snapshot.tokensUsed >= snapshot.tokenBudget) {
        throw new SubagentBudgetExhaustedError(snapshot.tokensUsed, snapshot.tokenBudget);
      }
    }
  /**
   * The request that owns this Thread, when the user has closed it. Read by
   * provenance rather than by spend binding: a capped child's spend binds to its
   * own pool, but the request it belongs to is still the one that spawned it.
   */
  private closedRequestFor(
      threadId: ThreadId,
      budget: ResolvedSubagentBudget | null,
    ): SubagentRequestPool | null {
      try {
        if (budget?.pool?.closedAt !== null && budget?.pool?.closedAt !== undefined) return budget.pool;
        // Only the already-resolved member: `budget` came through the guarded
        // walk, and a second unguarded read here would let a ledger fault fail
        // the Turn instead of degrading (A12).
        const originTurnId = budget?.member?.originTurnId ?? null;
        if (originTurnId === null) return null;
        const request = this.subagentBudgets.readPool(requestPoolIdForTurn(originTurnId));
        return request?.closedAt === null || request === null ? null : request;
      } catch (error) {
        // Degrade OPEN: refusing work on unreadable state would invent a stop
        // the user never pressed. Fail-closed is for write boundaries.
        this.auditSubagentBudgetFailure('closed-request resolution', threadId, error);
        return null;
      }
    }
  private subagentBudgetSnapshot(
      threadId: ThreadId,
      budget: ResolvedSubagentBudget | null,
    ): { readonly tokenBudget: number; readonly tokensUsed: number } | null {
      const active = this.activeTurns.get(threadId);
      const currentInFlight = active?.modelCallTokens ?? 0;
      const poolInFlight = budget?.pool
        ? this.inFlightTokensForPool(budget.pool.poolId)
        : 0;
      // A request with no budget is unbounded, not exhausted: it must contribute
      // no constraint at all rather than let `null` into the arithmetic.
      const boundedPool = budget?.pool && budget.pool.tokenBudget !== null
        ? { ...budget.pool, tokenBudget: budget.pool.tokenBudget }
        : null;
      const poolUsed = boundedPool ? boundedPool.tokensUsed + poolInFlight : Number.POSITIVE_INFINITY;
      const poolRemaining = boundedPool ? boundedPool.tokenBudget - poolUsed : Number.POSITIVE_INFINITY;
      const capInFlight = currentInFlight;
      const capUsed = budget?.member?.tokenCap === null || budget?.member?.tokenCap === undefined
        ? Number.POSITIVE_INFINITY
        : budget.member.tokensUsed + capInFlight;
      const capRemaining = budget?.member?.tokenCap === null || budget?.member?.tokenCap === undefined
        ? Number.POSITIVE_INFINITY
        : budget.member.tokenCap - capUsed;
      if (!Number.isFinite(poolRemaining) && !Number.isFinite(capRemaining)) return null;
      if (
        capRemaining <= poolRemaining
        && budget?.member?.tokenCap !== null
        && budget?.member?.tokenCap !== undefined
      ) {
        return { tokenBudget: budget.member.tokenCap, tokensUsed: capUsed };
      }
      return boundedPool ? { tokenBudget: boundedPool.tokenBudget, tokensUsed: poolUsed } : null;
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
    ): Promise<AcceptedTurn> {
      const record = this.core.requireThread(request.threadId);
      if (onlyIfIdle && record.thread.parentThreadId === null && this.core.isHostRootAdmissionBarrierActive()) {
        throw this.createThreadBusyError('Root Turn admission is temporarily paused');
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
      if (this.core.stoppingThreads.has(request.threadId)) throw this.createThreadBusyError('Thread is stopping');
      if (record.archived) throw this.createThreadBusyError('Thread is archived');
      if (this.activeTurns.has(request.threadId)) throw this.createThreadBusyError('Thread already has an active Turn');
      if (onlyIfIdle && record.thread.status.type !== 'idle') throw this.createThreadBusyError('Thread is not idle');
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
            turnId,
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
        modelCallTokens: 0,
        inFlightPoolId: null,
      };
      await this.core.recordNotification({ type: 'turn/started', threadId: request.threadId, turnId, turn });
      this.collaboration.consumePendingSubagentActivities(request.threadId, pendingSubagentActivities);
      if (!this.collaboration.hasPendingActivities(request.threadId)) {
        this.collaboration.takePendingCollaborationActivity(request.threadId);
      }
      this.activeTurns.set(request.threadId, active);
      if (!record.thread.preview.trim() && preview) {
        try {
          this.catalog.setInitialPreview(request.threadId, preview, startedAt);
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
      const isDescendantThread = thread.parentThreadId !== null;
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
          ...(isDescendantThread ? {
            onModelCallUsage: (tokens: number) => this.recordSubagentInFlightUsage(active, tokens),
          } : {}),
          ...(isDescendantThread && initialTurn.provenance.trigger.kind !== 'user' ? {
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
        this.settleSubagentInFlightUsage(active);
        this.activeTurns.delete(active.threadId);
        this.reapSettledSubagentPools(active.threadId, active.turnId);
        await this.setStatus(active.threadId, { type: 'idle' });
      });
      this.catalog.scheduleAutomaticThreadName(
        this.core.requireThread(active.threadId).thread,
        turn,
        active.configuration,
      );
      if (!hidden) {
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
      this.collaboration.queueChildTurnActivity(thread, turn);
      if (!hidden) await this.extensions.threadIdle(this.core.requireThread(active.threadId).thread);
    }
  private accrueSubagentBudgetUsage(
      active: ActiveTurn,
      thread: Thread,
      execution: Turn['execution'],
    ): void {
      if (active.budgetUsageAccrued || thread.parentThreadId === null) return;
      try {
        const budget = this.resolveSubagentBudget(active.threadId);
        if (!budget?.member && !budget?.pool) return;
        this.subagentBudgets.addUsage(
          active.threadId,
          budget.pool?.poolId ?? null,
          execution.usage.totalTokens,
        );
      } catch (error) {
        this.auditSubagentBudgetFailure('usage accrual', active.threadId, error);
      } finally {
        active.budgetUsageAccrued = true;
      }
    }
  /**
   * Reclaim the delegating Turn's pool once the request it belongs to is
   * genuinely over: its originating Turn has ended and no member Thread is still
   * running. The pool deliberately outlives its Turn until then — a
   * fire-and-forget child keeps charging the request that asked for it.
   *
   * Bookkeeping, not enforcement (A12): a reap that throws must never take the
   * settling Turn down with it.
   */
  private reapSettledSubagentPools(threadId: ThreadId, settledTurnId: TurnId): void {
      try {
        // Either end of the request can be the last to settle: a member Thread,
        // or the delegating Turn itself when its children finished first.
        this.reapSubagentPoolIfSettled(this.subagentBudgets.readMember(threadId)?.poolId ?? null);
        this.reapSubagentPoolIfSettled(requestPoolIdForTurn(settledTurnId));
      } catch (error) {
        this.auditSubagentBudgetFailure('settled pool reclamation', threadId, error);
      }
    }
  private reapSubagentPoolIfSettled(poolId: SubagentRequestPoolId | null): void {
      if (poolId === null) return;
      const pool = this.subagentBudgets.readPool(poolId);
      if (!pool || pool.scope !== 'turn') return;
      // A closed request is kept as a tombstone: reclaiming it would erase the
      // fact that the user stopped this work, and its members would silently
      // become admissible again. It goes with the Thread subtree instead.
      if (pool.closedAt !== null) return;
      if (this.activeTurns.get(pool.originThreadId)?.turnId === pool.originTurnId) return;
      const members = this.subagentBudgets.membersForPool(poolId);
      if (members.some((member) => this.activeTurns.has(member.threadId))) return;
      this.subagentBudgets.reapPool(poolId);
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
      this.bindSubagentInFlightPool(
        active,
        this.resolveSubagentBudget(active.threadId)?.pool?.poolId ?? null,
      );
    }
  private bindSubagentInFlightPool(active: ActiveTurn, poolId: SubagentRequestPoolId | null): void {
      if (active.inFlightPoolId !== poolId) this.clearSubagentInFlightUsage(active);
      active.inFlightPoolId = poolId;
      if (poolId === null || active.modelCallTokens === 0) return;
      const poolUsage = this.inFlightPoolUsage.get(poolId) ?? new Map<ThreadId, number>();
      poolUsage.set(active.threadId, active.modelCallTokens);
      this.inFlightPoolUsage.set(poolId, poolUsage);
    }
  private clearSubagentInFlightUsage(active: ActiveTurn): void {
      if (active.inFlightPoolId === null) return;
      const poolUsage = this.inFlightPoolUsage.get(active.inFlightPoolId);
      poolUsage?.delete(active.threadId);
      if (poolUsage?.size === 0) this.inFlightPoolUsage.delete(active.inFlightPoolId);
      active.inFlightPoolId = null;
    }
  private settleSubagentInFlightUsage(active: ActiveTurn): void {
      this.clearSubagentInFlightUsage(active);
      active.modelCallTokens = 0;
    }
  private inFlightTokensForPool(poolId: SubagentRequestPoolId): number {
      let total = 0;
      for (const tokens of this.inFlightPoolUsage.get(poolId)?.values() ?? []) total += tokens;
      return total;
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
      const initial = this.core.readTurn(active.threadId, active.turnId);
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
        this.settleSubagentInFlightUsage(active);
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
        this.reapSettledSubagentPools(active.threadId, active.turnId);
        await this.setStatus(active.threadId, { type: 'idle' }).catch(() => undefined);
      }).catch(() => undefined);
      if (thread && failedTurn) this.catalog.scheduleAutomaticThreadName(thread, failedTurn, active.configuration);
      if (thread && failedTurn) {
        this.transcripts.enqueueTurn(thread, failedTurn);
        this.collaboration.queueChildTurnActivity(thread, failedTurn);
      }
    }
  async setStatus(threadId: ThreadId, status: ThreadStatus): Promise<void> {
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
  requireActiveTurn(threadId: ThreadId, turnId: string): ActiveTurn {
      const active = this.activeTurns.get(threadId);
      if (!active || active.turnId !== turnId) throw this.createThreadBusyError('Expected Turn is not active');
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
