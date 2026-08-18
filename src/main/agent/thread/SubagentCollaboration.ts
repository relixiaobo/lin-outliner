import type { TSchema } from 'typebox';
import { resolveChildConfiguration,type AgentRole,type EffectiveThreadConfiguration } from '../../../core/agent/configuration';
import type { ContextEvidenceKind,JsonValue,RendererTurnStartRequest,Thread,ThreadContextPayload,ThreadContextPayloadReference,ThreadId,ThreadItem,ThreadItemOutputReference,ThreadResourceReference,ThreadUserContent,Turn,TurnId,TurnStartResponse } from '../../../core/agent/protocol';
import {
  AGENT_MESSAGE_INPUT_SCHEMA,
  agentInputSchema,
  modelToolContract,
  normalizeAgentMessageToolInput,
  normalizeAgentToolInput,
} from '../../../core/agent/tools';
import { isolatedSkillIdentity, isolatedSkillTaskName } from '../../../core/agent/subagentTaskPath';
import {
  cappedChildPoolId,
  DEFAULT_MAX_CONCURRENT_SUBAGENTS,
  MAX_SUBAGENT_DEPTH,
  requestPoolIdForTurn,
  type CreateSubagentRequestPoolInput,
  type SubagentRequestLedger,
  type SubagentRequestPoolId,
} from '../persistence/SubagentRequestLedger';
import {
  type SubagentExecutionRecord,
  SubagentExecutionLedger,
  type AgentStartupContextSnapshot,
  type SubagentRecordedToolPolicy,
  type SubagentPendingNotification,
} from '../persistence/SubagentExecutionLedger';
import type { ResolvedAgentType } from '../AgentConfigurationLoader';
import { throwIfAborted } from '../capabilities/agentAwaitWithAbort';
import { filterSubagentToolKeys,subagentToolAllowed } from '../capabilities/subagentToolPolicy';
import type {
  AgentWorktreeIntentInput,
  AgentWorktreeMetadata,
  AgentWorktreeRecoveryIntent,
  SettleAgentWorktreeOptions,
} from '../worktree/AgentWorktree';
import type { AgentTool,AgentToolResult } from '../runtime/kernel/types';
import { SubagentDepthLimitError } from '../SubagentStructuralLimitError';
import type { SpawnChildThreadInput,SpawnChildThreadResult,SpawnIsolatedSkillThreadInput } from '../ThreadService';
import { uuidV7 } from '../uuid';
import type { ThreadCatalogOps } from './ThreadCatalogOps';
import { ThreadCore } from './ThreadCore';
import type { ThreadResourceOps } from './ThreadResourceOps';
import type { ThreadTranscriptWriter } from './ThreadTranscriptWriter';
import type { TranscriptSubject } from './TranscriptRenderer';
import type { TurnLifecycle } from './TurnLifecycle';
import {
  agentMessageToMainText,
  backgroundLaunchText,
  foregroundUsageText,
  subagentTurnResult,
  taskNotificationText,
} from './subagentOutput';

const MAX_TERMINAL_SETTLEMENT_RETRIES = 4;
const TERMINAL_SETTLEMENT_RETRY_EXHAUSTED_MESSAGE =
  `Agent terminal settlement failed after ${MAX_TERMINAL_SETTLEMENT_RETRIES + 1} attempts. `
  + 'Restart Tenon to retry durable recovery.';

type TerminalSettlementOutcome = 'settled' | 'deferredForDescendants';

export interface StagedContextEvidence {
  readonly payload: Extract<ThreadContextPayload, { readonly kind: ContextEvidenceKind }>;
  readonly payloadRef: ThreadContextPayloadReference;
  readonly contextRefs: readonly ThreadContextPayloadReference[];
  readonly resourceRefs: readonly ThreadResourceReference[];
  readonly outputRefs: readonly ThreadItemOutputReference[];
  readonly summary: string;
}
export interface PendingSubagentActivity {
  readonly agentThreadId: ThreadId;
  readonly agentTurnId: TurnId;
  readonly agentPath: string;
  readonly kind: 'started' | 'completed' | 'interrupted' | 'errored';
  readonly error: Turn['error'];
  /**
   * Which delegated form produced this. Every form is recorded as parent-visible
   * activity, but only `collaboration` enters Agent notification delivery — an
   * isolated Skill's outcome belongs to its `skill` tool row alone.
   */
  readonly form: 'collaboration' | 'isolatedSkill';
}
interface CollaborationActivityState {
  pending: boolean;
}
interface TerminalSettlementDeferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}
interface TerminalSettlementReservation {
  readonly key: string;
  execution: SubagentExecutionRecord;
  turn: Turn;
  notifyParent: boolean;
  revision: number;
  worktreeSettled: boolean;
  pipeline: Promise<void> | null;
  retryAttempt: number;
  retryExhausted: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
}
interface SubagentCatalog {
  createThread: ThreadCatalogOps['createThread'];
  deleteThread: ThreadCatalogOps['deleteThread'];
}

interface AgentSpawnResult {
  readonly agentId: ThreadId;
  readonly runMode: 'foreground' | 'background';
  readonly report: string | null;
  readonly usage: string | null;
  readonly outputFile: string | null;
}
interface PreparedResumeWorktree {
  readonly previous: AgentWorktreeMetadata | null;
  readonly prepared: AgentWorktreeMetadata | null;
}

export class SubagentCollaboration {
  private readonly ephemeralSpawnEdges = new Map<ThreadId, { sessionId: string; parentThreadId: ThreadId; taskPath: string; createdAt: number }>();
  private readonly pendingSubagentActivities = new Map<ThreadId, PendingSubagentActivity[]>();
  private readonly collaborationActivity = new Map<ThreadId, CollaborationActivityState>();
  private readonly terminalPipelines = new Map<string, Promise<void>>();
  /** Keeps a delegated child live from Turn completion until its ledger row is durable. */
  private readonly terminalSettlementReservations = new Map<string, TerminalSettlementReservation>();
  /** One completion authority for each foreground Agent generation awaiting its tool result. */
  private readonly terminalSettlementDeferreds = new Map<string, TerminalSettlementDeferred>();
  /** Lets a terminal reservation create the deferred before spawn admission returns. */
  private readonly foregroundSettlementWaits = new Set<string>();
  private readonly parentDeliveryPipelines = new Map<ThreadId, Promise<void>>();
  private readonly resumePipelines = new Map<ThreadId, Promise<unknown>>();
  private readonly deletingThreadIds = new Set<ThreadId>();
  /** Pipeline handles survive per-Thread coordination teardown so close can drain them. */
  private readonly inFlightForClose = new Set<Promise<unknown>>();
  private readonly closeAttemptedTerminalRevisions = new Map<string, number>();
  private closing = false;
  constructor(
    private readonly core: ThreadCore,
    private readonly resourceOps: ThreadResourceOps,
    private readonly catalog: SubagentCatalog,
    private readonly turnLifecycle: TurnLifecycle,
    private readonly subagentBudgets: SubagentRequestLedger,
    private readonly executions: SubagentExecutionLedger,
    private readonly resolveRole: (name: string, cwd: string) => AgentRole,
    private readonly resolveAgentType: (name: string | undefined, cwd: string) => ResolvedAgentType,
    private readonly resolveSubagentTokenBudget: () => Promise<number | null>,
    private readonly resolveSubagentLimits: () => Promise<{
      readonly maxDepth: number;
      readonly maxConcurrent: number;
    }>,
    private readonly resolveAgentStartupContext: (
      parent: Pick<Thread, 'id' | 'sessionId' | 'cwd'>,
    ) => Promise<AgentStartupContextSnapshot | null>,
    private readonly planAgentWorktree: ((
      input: AgentWorktreeIntentInput,
    ) => Promise<AgentWorktreeRecoveryIntent>) | undefined,
    private readonly prepareAgentWorktree: ((input: {
      readonly agentId: ThreadId;
      readonly intent: AgentWorktreeRecoveryIntent;
      readonly worktree: AgentWorktreeMetadata | null;
    }) => Promise<{ readonly cwd: string; readonly worktree: AgentWorktreeMetadata }>) | undefined,
    private readonly settleAgentWorktree: ((
      worktree: AgentWorktreeMetadata,
      options?: SettleAgentWorktreeOptions,
    ) => Promise<{
      readonly worktree: AgentWorktreeMetadata;
      readonly retained: boolean;
    }>) | undefined,
    private readonly now: () => number,
    private readonly applyToolCeiling: (configuration: EffectiveThreadConfiguration, toolCeiling: readonly string[] | null) => EffectiveThreadConfiguration,
    private readonly assertThreadAvailable: (threadId: ThreadId) => void,
    private readonly createThreadBusyError: (message: string, rendererSubmissionRetryable?: boolean) => Error,
    private readonly transcripts: ThreadTranscriptWriter,
  ) {}
  execution(threadId: ThreadId): SubagentExecutionRecord | null {
    return this.executions.read(threadId);
  }
  canSpawnAgent(threadId: ThreadId, configuration: EffectiveThreadConfiguration): boolean {
    if (!configuration.tools.includes('agent')) return false;
    const thread = this.core.requireThread(threadId).thread;
    if (thread.parentThreadId === null) return true;
    const execution = this.executions.read(threadId);
    if (execution?.initialAdmissionState !== 'committed') return false;
    const policy = execution.toolPolicy;
    const contract = modelToolContract('agent');
    if (!policy || !contract || !subagentToolAllowed(contract, policy)) return false;
    return policy.requestedTools === null
      || policy.requestedTools.includes('*')
      || policy.requestedTools.includes('agent');
  }
  async startRendererTurn(
    request: RendererTurnStartRequest,
    admissionGuard?: () => void,
  ): Promise<TurnStartResponse> {
    const thread = this.core.requireThread(request.threadId).thread;
    const initial = this.executions.read(request.threadId);
    if (thread.threadSource === 'subagent') {
      if (!initial) {
        throw this.createThreadBusyError(`Delegated Agent execution is unavailable: ${request.threadId}`);
      }
      if (initial.initialAdmissionState !== 'committed') {
        throw this.createThreadBusyError(`Delegated Agent admission is incomplete: ${request.threadId}`);
      }
    }
    if (!initial) return this.turnLifecycle.startRendererTurn(request, undefined, admissionGuard);

    if (this.turnLifecycle.isRendererContextCommand(request.input)) {
      const response = await this.turnLifecycle.startRendererTurn(request, undefined, admissionGuard);
      if (!response.deduplicated) this.clearUserStop(request.threadId);
      return response;
    }

    return this.withResumeLock(request.threadId, async () => {
      if (this.closing) throw this.createThreadBusyError('Agent service is shutting down');
      if (
        request.clientUserMessageId
        && this.turnLifecycle.readTurnByClientUserMessageIdForHost(
          request.threadId,
          request.clientUserMessageId,
        )
      ) return this.turnLifecycle.startRendererTurn(request, undefined, admissionGuard);

      await this.ensureTerminalPipeline(initial.agentId, initial.generation);
      if (this.closing) throw this.createThreadBusyError('Agent service is shutting down');
      const current = this.executions.require(request.threadId);
      if (this.turnLifecycle.hasActiveTurn(current.agentId)) {
        throw this.createThreadBusyError('Thread already has an active Turn', true);
      }
      const snapshot = this.executions.generationSnapshot(current.agentId);
      const worktree = await this.prepareWorktreeForResume(current);
      const nextTurnId = uuidV7(this.now());
      const next = this.executions.beginUserGenerationIfCurrent({
        agentId: current.agentId,
        expectedGeneration: snapshot.generation,
        expectedTurnId: snapshot.currentTurnId,
        turnId: nextTurnId,
        previous: snapshot,
        updatedAt: this.now(),
      });
      if (!next) {
        await this.rollbackPreparedResumeWorktree(current.agentId, worktree, snapshot);
        throw this.createThreadBusyError(`Agent ${current.agentId} changed while resuming`);
      }
      let admitted = false;
      try {
        const response = await this.turnLifecycle.startRendererTurn(request, nextTurnId, admissionGuard);
        if (response.deduplicated || response.turn.id !== nextTurnId) {
          throw new Error(`Renderer Agent resume did not admit its reserved Turn: ${current.agentId}`);
        }
        admitted = true;
        this.executions.completeGenerationAdmissionIfCurrent(
          next.agentId,
          next.generation,
          next.currentTurnId,
        );
        return response;
      } catch (error) {
        const rolledBack = !admitted && this.executions.rollbackGeneration(
          next.agentId,
          next.generation,
          next.currentTurnId,
        );
        if (rolledBack) {
          await this.rollbackPreparedResumeWorktree(current.agentId, worktree, snapshot);
        }
        throw error;
      }
    });
  }
  worktreeForThread(threadId: ThreadId): AgentWorktreeMetadata | null {
    let current = this.core.requireThread(threadId).thread;
    const visited = new Set<ThreadId>();
    let mismatched: AgentWorktreeMetadata | null = null;
    while (!visited.has(current.id)) {
      visited.add(current.id);
      const worktree = this.executions.read(current.id)?.worktree ?? null;
      if (worktree) {
        if (worktree.removedAt !== null) return worktree;
        if (current.cwd === worktree.path) return worktree;
        mismatched ??= worktree;
        console.warn(`[agent] Agent worktree metadata does not match Thread cwd for ${current.id}`);
      }
      if (!current.parentThreadId) return mismatched;
      current = this.core.requireThread(current.parentThreadId).thread;
    }
    console.warn(`[agent] Ignoring cyclic Thread parent lineage while resolving Agent worktree: ${threadId}`);
    return mismatched;
  }
  recordEphemeralSpawnEdge(threadId: ThreadId, edge: { readonly sessionId: string; readonly parentThreadId: ThreadId; readonly taskPath: string; readonly createdAt: number }): void {
    this.ephemeralSpawnEdges.set(threadId, edge);
  }
  deleteEphemeralSpawnEdge(threadId: ThreadId): void { this.ephemeralSpawnEdges.delete(threadId); }
  ephemeralChildThreadIds(parentThreadId: ThreadId): readonly ThreadId[] {
    return [...this.ephemeralSpawnEdges].flatMap(([threadId, edge]) => edge.parentThreadId === parentThreadId ? [threadId] : []);
  }
  clearThreadCoordinationState(threadIds: readonly ThreadId[]): void {
    for (const threadId of threadIds) {
      this.pendingSubagentActivities.delete(threadId);
      this.collaborationActivity.delete(threadId);
      this.transcripts.forgetCursor(threadId);
      for (const key of [...this.terminalPipelines.keys()]) {
        if (key.startsWith(`${threadId}:`)) this.terminalPipelines.delete(key);
      }
      for (const key of [...this.terminalSettlementReservations.keys()]) {
        if (!key.startsWith(`${threadId}:`)) continue;
        const reservation = this.terminalSettlementReservations.get(key);
        if (reservation?.retryTimer) clearTimeout(reservation.retryTimer);
        this.terminalSettlementDeferreds.get(key)?.resolve();
        this.terminalSettlementDeferreds.delete(key);
        this.foregroundSettlementWaits.delete(key);
        this.terminalSettlementReservations.delete(key);
      }
      for (const key of [...this.foregroundSettlementWaits]) {
        if (!key.startsWith(`${threadId}:`)) continue;
        this.terminalSettlementDeferreds.get(key)?.resolve();
        this.terminalSettlementDeferreds.delete(key);
        this.foregroundSettlementWaits.delete(key);
      }
      this.parentDeliveryPipelines.delete(threadId);
      this.resumePipelines.delete(threadId);
      this.deletingThreadIds.delete(threadId);
    }
  }

  beginThreadDeletion(threadIds: readonly ThreadId[]): void {
    for (const threadId of threadIds) this.deletingThreadIds.add(threadId);
    for (const reservation of this.terminalSettlementReservations.values()) {
      if (this.deletingThreadIds.has(reservation.execution.agentId)) reservation.notifyParent = false;
    }
  }

  finishThreadDeletion(threadIds: readonly ThreadId[]): void {
    for (const threadId of threadIds) this.deletingThreadIds.delete(threadId);
    const parents = new Set<ThreadId>();
    for (const threadId of threadIds) {
      const execution = this.executions.read(threadId);
      if (!execution || execution.runMode !== 'background') continue;
      parents.add(execution.parentThreadId);
      const reservation = this.terminalSettlementReservations.get(
        executionKey(execution.agentId, execution.generation),
      );
      if (reservation) {
        reservation.notifyParent = true;
        this.startReservedTerminalSettlement(reservation);
        continue;
      }
      try {
        const turn = this.core.readTurn(execution.agentId, execution.currentTurnId);
        if (turn && turn.status !== 'inProgress') {
          this.persistAgentTerminal(this.core.requireThread(execution.agentId).thread, turn);
        }
      } catch (error) {
        console.warn(`[agent] Failed to restore Agent terminal delivery after deletion abort: ${threadId}`, error);
      }
    }
    for (const parentThreadId of parents) {
      void this.deliverParentWork(parentThreadId).catch((error) => {
        console.warn(`[agent] Agent parent delivery deferred after deletion abort: ${parentThreadId}`, error);
      });
    }
  }

  async drainTerminalSettlements(threadIds: readonly ThreadId[]): Promise<void> {
    for (const threadId of [...threadIds].reverse()) {
      const execution = this.executions.read(threadId);
      if (!execution) continue;
      const reservation = this.terminalSettlementReservations.get(
        executionKey(execution.agentId, execution.generation),
      );
      if (reservation) reservation.notifyParent = false;
      await this.ensureTerminalPipeline(execution.agentId, execution.generation);
    }
  }

  beginClose(): void {
    if (this.closing) return;
    this.closing = true;
    for (const reservation of this.terminalSettlementReservations.values()) {
      if (reservation.retryTimer) {
        clearTimeout(reservation.retryTimer);
        reservation.retryTimer = null;
      }
      if (reservation.pipeline) {
        this.closeAttemptedTerminalRevisions.set(reservation.key, reservation.revision);
      }
    }
    for (const deferred of this.terminalSettlementDeferreds.values()) deferred.resolve();
  }

  /**
   * Wait for shutdown-owned tails to become quiescent. A failed terminal
   * reservation gets at most one close-time attempt and remains durable for
   * startup recovery instead of turning shutdown into an unbounded retry loop.
   */
  async drainForClose(deadline: number): Promise<boolean> {
    this.beginClose();
    for (;;) {
      for (const reservation of this.terminalSettlementReservations.values()) {
        if (reservation.retryTimer) {
          clearTimeout(reservation.retryTimer);
          reservation.retryTimer = null;
        }
        if (reservation.pipeline) {
          this.closeAttemptedTerminalRevisions.set(reservation.key, reservation.revision);
          continue;
        }
        if (this.closeAttemptedTerminalRevisions.get(reservation.key) === reservation.revision) continue;
        this.closeAttemptedTerminalRevisions.set(reservation.key, reservation.revision);
        this.startReservedTerminalSettlement(reservation);
      }
      const pending = [...this.inFlightForClose];
      if (pending.length === 0) return true;
      if (!await settleBeforeDeadline(Promise.allSettled(pending), deadline)) return false;
    }
  }

  /**
   * Called after any Thread reaches idle. A child can finish while its parent
   * is still in a provider Turn; the completion path will intentionally defer
   * delivery in that case, so the parent's next idle edge must retry it.
   */
  threadBecameIdle(threadId: ThreadId): void {
    if (this.closing) return;
    this.retryTerminalSettlements();
    void this.deliverParentWork(threadId).catch((error) => {
      console.warn(`[agent] Parent Agent work delivery deferred for ${threadId}`, error);
    });
  }
  prepareChildTerminalSettlement(thread: Thread, turn: Turn): void {
    if (thread.parentThreadId === null || thread.source !== 'collaboration') return;
    const execution = this.executions.read(thread.id);
    if (!execution || execution.currentTurnId !== turn.id) return;
    this.reserveTerminalSettlement(execution, turn);
  }
  pendingActivities(threadId: ThreadId): readonly PendingSubagentActivity[] {
    return [...(this.pendingSubagentActivities.get(threadId) ?? [])];
  }
  hasPendingActivities(threadId: ThreadId): boolean {
    return this.pendingSubagentActivities.has(threadId);
  }
  collaborationToolContributions(turn: {
    threadId: ThreadId;
    turnId: string;
  }, modelIds: readonly string[]): readonly AgentTool[] {
    const threadId = turn.threadId;
    const turnId = turn.turnId;
    return [
      agentTool('agent', 'Agent', async (itemId, params, signal) => {
        const input = normalizeAgentToolInput(params);
        const result = await this.spawnAgent({
          senderThreadId: threadId,
          senderTurnId: turnId,
          parentItemId: itemId,
          description: input.description,
          prompt: input.prompt,
          agentType: input.subagent_type,
          ...(input.model === undefined ? {} : { model: input.model }),
          runInBackground: input.run_in_background !== false,
          isolation: input.isolation === 'worktree' ? 'worktree' : null,
          signal,
        });
        if (result.runMode === 'background') {
          return rawTextToolResult(backgroundLaunchText({
            agentId: result.agentId,
            outputFile: result.outputFile,
          }), { agentId: result.agentId, outputFile: result.outputFile });
        }
        const content = [result.report, result.usage]
          .filter((text): text is string => typeof text === 'string' && text.length > 0);
        if (content.length === 0) content.push('Agent finished without text output.');
        return rawTextBlocksToolResult(content, { agentId: result.agentId });
      }, agentInputSchema(modelIds), normalizeAgentToolInput),
      agentTool('agent_message', 'Agent Message', async (itemId, params) => {
        const input = normalizeAgentMessageToolInput(params);
        return rawJsonToolResult(await this.sendAgentMessage(
          threadId,
          turnId,
          itemId,
          input.to,
          input.message,
          input.summary,
        ));
      }, AGENT_MESSAGE_INPUT_SCHEMA, normalizeAgentMessageToolInput),
    ];
  }
  materializePendingActivityItems(threadId: ThreadId, turnId: TurnId, activities: readonly PendingSubagentActivity[]): ThreadItem[] {
    return activities.map((activity) => subagentActivityItem(threadId, turnId, activity));
  }

  private assertSpawnParentActive(
    parentThreadId: ThreadId,
    parentTurnId: TurnId,
    signal?: AbortSignal,
  ): void {
      throwIfAborted(signal);
      this.turnLifecycle.requireActiveTurn(parentThreadId, parentTurnId);
  }

  async spawnAgent(input: {
    readonly senderThreadId: ThreadId;
    readonly senderTurnId: TurnId;
    readonly parentItemId: string;
    readonly description: string;
    readonly prompt: string;
    readonly agentType: string;
    readonly model?: string;
    readonly runInBackground: boolean;
    readonly isolation: 'worktree' | null;
    readonly signal?: AbortSignal;
  }): Promise<AgentSpawnResult> {
    if (this.closing) throw this.createThreadBusyError('Agent service is shutting down');
    this.assertSpawnParentActive(input.senderThreadId, input.senderTurnId, input.signal);
    this.assertAgentSpawnItemBoundary(
      input.senderThreadId,
      input.senderTurnId,
      input.parentItemId,
    );
    if (input.isolation === 'worktree' && (!this.planAgentWorktree || !this.prepareAgentWorktree)) {
      throw new Error('Agent worktree isolation is unavailable');
    }
    const parent = this.core.requireThread(input.senderThreadId).thread;
    const inheritedWorktreeIsolation = parent.parentThreadId !== null && (
      this.executions.read(parent.id)?.toolPolicy.worktree === true
      || this.worktreeForThread(parent.id) !== null
    );
    const selected = this.resolveAgentType(input.agentType, parent.cwd);
    const limits = await this.resolveSubagentLimits();
    assertSubagentLimits(limits);
    const startupContext = selected.kind === 'explore' || selected.kind === 'plan'
      ? null
      : await this.resolveAgentStartupContext(parent);
    this.assertSpawnParentActive(input.senderThreadId, input.senderTurnId, input.signal);
    const parentPath = this.taskPathForThread(input.senderThreadId) ?? '/root';
    const agentId = uuidV7(this.now());
    const turnId = uuidV7(this.now());
    const taskPath = `${parentPath}/${agentId}`;
    const foregroundSettlementKey = input.runInBackground
      ? null
      : executionKey(agentId, 1);
    if (foregroundSettlementKey) this.foregroundSettlementWaits.add(foregroundSettlementKey);
    let result: SpawnChildThreadResult;
    let execution: SubagentExecutionRecord;
    try {
      result = await this.spawnChild({
        id: agentId,
        parentThreadId: input.senderThreadId,
        parentTurnId: input.senderTurnId,
        parentItemId: input.parentItemId,
        prompt: input.prompt,
        taskPath,
        displayName: input.description,
        role: selected.role,
        childKind: 'collaboration',
        cwd: parent.cwd,
        turnId,
        execution: {
          description: input.description,
          agentType: selected.canonicalType,
          runMode: input.runInBackground ? 'background' : 'foreground',
          worktree: null,
          initialWorktreeCwd: input.isolation === 'worktree' ? parent.cwd : null,
          toolPolicy: {
            kind: selected.kind,
            runInBackground: input.runInBackground,
            worktree: inheritedWorktreeIsolation || input.isolation === 'worktree',
            allowNesting: this.agentDepth(input.senderThreadId) + 1 < limits.maxDepth,
            requestedTools: normalizedRequestedTools(selected.role.overrides?.tools),
          },
          startupContext,
        },
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.signal === undefined ? {} : { parentSignal: input.signal }),
      });
      execution = this.executions.require(result.thread.id);
    } catch (error) {
      if (foregroundSettlementKey) {
        this.foregroundSettlementWaits.delete(foregroundSettlementKey);
        this.terminalSettlementDeferreds.delete(foregroundSettlementKey);
      }
      throw error;
    }
    if (input.runInBackground) {
      return {
        agentId: execution.agentId,
        runMode: 'background',
        report: null,
        usage: null,
        outputFile: this.transcripts.pathForPendingReader(execution.agentId),
      };
    }
    const abort = () => {
      const turnId = this.turnLifecycle.activeTurnId(execution.agentId);
      if (turnId) void this.turnLifecycle.interruptTurn(execution.agentId, turnId).catch(() => undefined);
    };
    input.signal?.addEventListener('abort', abort, { once: true });
    const key = executionKey(execution.agentId, execution.generation);
    const settlement = this.terminalSettlementDeferred(key);
    try {
      await settlement.promise;
    } finally {
      input.signal?.removeEventListener('abort', abort);
      this.foregroundSettlementWaits.delete(key);
      if (this.terminalSettlementDeferreds.get(key) === settlement) {
        this.terminalSettlementDeferreds.delete(key);
      }
    }
    // A foreground child may send `agent_message("main")` while its provider
    // turn is running. Deliver that envelope only after the ordinary Agent
    // result is ready, so the parent consumes it immediately before its next
    // provider request rather than as an unsolicited root Turn.
    await this.deliverParentMessages(this.rootThreadIdFor(execution.parentThreadId), {
      senderAgentId: execution.agentId,
      generation: execution.generation,
    });
    const settled = this.executions.require(execution.agentId);
    const terminal = this.core.readTurn(execution.agentId, settled.currentTurnId);
    if (!terminal) throw new Error(`Foreground Agent Turn was not recorded: ${settled.currentTurnId}`);
    return {
      agentId: execution.agentId,
      runMode: 'foreground',
      report: subagentTurnResult(terminal),
      usage: selected.kind === 'explore' || selected.kind === 'plan'
        ? null
        : foregroundUsageText({ agentId: execution.agentId, turn: terminal, worktree: settled.worktree }),
      outputFile: await this.transcripts.pathForReader(execution.agentId),
    };
  }

  private async ensureTerminalPipeline(agentId: ThreadId, generation: number): Promise<void> {
    const key = executionKey(agentId, generation);
    for (;;) {
      const existing = this.terminalPipelines.get(key);
      if (existing) {
        try {
          await existing;
        } catch (error) {
          if (this.terminalSettlementReservations.get(key)?.retryExhausted) {
            throw new Error(TERMINAL_SETTLEMENT_RETRY_EXHAUSTED_MESSAGE);
          }
          throw error;
        }
        if (!this.terminalSettlementReservations.has(key)) return;
        continue;
      }
      const reservation = this.terminalSettlementReservations.get(key);
      if (reservation) {
        if (reservation.retryExhausted) {
          throw new Error(TERMINAL_SETTLEMENT_RETRY_EXHAUSTED_MESSAGE);
        }
        this.startReservedTerminalSettlement(reservation);
        if (reservation.pipeline) {
          try {
            await reservation.pipeline;
          } catch (error) {
            if (reservation.retryExhausted) {
              throw new Error(TERMINAL_SETTLEMENT_RETRY_EXHAUSTED_MESSAGE);
            }
            throw error;
          }
          if (!this.terminalSettlementReservations.has(key)) return;
          continue;
        }
        return;
      }
      const execution = this.executions.read(agentId);
      if (!execution || execution.generation !== generation) return;
      const turn = this.core.readTurn(agentId, execution.currentTurnId);
      if (!turn || turn.status === 'inProgress') return;
      this.persistAgentTerminal(this.core.requireThread(agentId).thread, turn);
      const started = this.terminalPipelines.get(key);
      if (started) await started;
      return;
    }
  }

  async sendAgentMessage(
    senderThreadId: ThreadId,
    senderTurnId: TurnId,
    itemId: string,
    targetInput: string,
    message: string,
    _summary: string,
  ): Promise<JsonValue> {
    this.turnLifecycle.requireActiveTurn(senderThreadId, senderTurnId);
    if (this.closing) return agentServiceClosingResult();
    if (targetInput === senderThreadId) {
      return { success: false, message: 'An Agent cannot send a message to itself.' };
    }
    if (!this.hasCommittedCollaborationAdmission(senderThreadId)) {
      return { success: false, message: 'Agent admission is incomplete; messaging is unavailable.' };
    }
    if (targetInput === 'main') {
      return this.sendAgentMessageToMain(senderThreadId, message);
    }
    const execution = this.reachableExecution(senderThreadId, targetInput);
    if (!execution) {
      return {
        success: false,
        message: `No agent with ID '${targetInput}' is reachable.\nUse the agent ID from a background agent's spawn result.`,
      };
    }
    const content = [{ type: 'text' as const, text: message }];
    const activeTurnId = this.turnLifecycle.activeTurnId(execution.agentId);
    if (activeTurnId) {
      await this.turnLifecycle.steerTurn({
        threadId: execution.agentId,
        expectedTurnId: activeTurnId,
        input: content,
      }, 'advisory');
      return agentMessageQueuedResult(execution.agentId);
    }
    return this.withResumeLock(execution.agentId, async () => {
      if (this.closing) return agentServiceClosingResult();
      // Terminal accounting may still be flushing when the child Turn becomes
      // idle. Wait for that generation before admitting a new one; otherwise
      // the old pipeline could settle the new generation's worktree or stop
      // provenance after the resume update.
      await this.ensureTerminalPipeline(execution.agentId, execution.generation);
      if (this.closing) return agentServiceClosingResult();
      const current = this.executions.read(execution.agentId);
      if (current?.initialAdmissionState !== 'committed') {
        return {
          success: false,
          message: `No agent with ID '${targetInput}' is reachable.\nUse the agent ID from a background agent's spawn result.`,
        };
      }
      const resumedTurnId = this.turnLifecycle.activeTurnId(current.agentId);
      if (resumedTurnId) {
        await this.turnLifecycle.steerTurn({
          threadId: current.agentId,
          expectedTurnId: resumedTurnId,
          input: content,
        }, 'advisory');
        return agentMessageQueuedResult(current.agentId);
      }
      if (current.stopProvenance === 'user') {
        return { success: false, message: 'A user-stopped Agent cannot be resumed by another Agent.' };
      }
      this.turnLifecycle.assertSubagentBudgetAvailable(current.agentId);
      const snapshot = this.executions.generationSnapshot(current.agentId);
      const worktree = await this.prepareWorktreeForResume(current);
      if (this.closing) {
        await this.rollbackPreparedResumeWorktree(current.agentId, worktree, snapshot);
        return agentServiceClosingResult();
      }
      const nextTurnId = uuidV7(this.now());
      const next = this.executions.beginNextGenerationIfCurrent({
        agentId: current.agentId,
        expectedGeneration: snapshot.generation,
        expectedTurnId: snapshot.currentTurnId,
        turnId: nextTurnId,
        toolUseId: itemId,
        runMode: 'background',
        previous: snapshot,
        updatedAt: this.now(),
      });
      if (!next) {
        await this.rollbackPreparedResumeWorktree(current.agentId, worktree, snapshot);
        return { success: false, message: `Agent ${current.agentId} changed while resuming; retry the message.` };
      }
      if (this.closing) {
        if (this.executions.rollbackGeneration(
          next.agentId,
          next.generation,
          next.currentTurnId,
        )) {
          await this.rollbackPreparedResumeWorktree(current.agentId, worktree, snapshot);
        }
        return agentServiceClosingResult();
      }
      let admitted = false;
      try {
        await this.turnLifecycle.startPrivilegedTurn({
          threadId: current.agentId,
          turnId: nextTurnId,
          input: content,
          trigger: { kind: 'subagent', parentThreadId: senderThreadId, parentItemId: itemId },
        });
        admitted = true;
        this.executions.completeGenerationAdmissionIfCurrent(
          next.agentId,
          next.generation,
          next.currentTurnId,
        );
      } catch (error) {
        if (!admitted && this.executions.rollbackGeneration(
          next.agentId,
          next.generation,
          next.currentTurnId,
        )) {
          await this.rollbackPreparedResumeWorktree(current.agentId, worktree, snapshot);
        }
        throw error;
      }
      const outputFile = await this.transcripts.pathForReader(current.agentId);
      return {
        success: true,
        message: `Agent "${current.agentId}" was stopped (${terminalStatus(this.core.allTurns(current.agentId).at(-2))}); resumed it in the background with your message. You'll be notified when it finishes. Output: ${outputFile ?? '(unavailable)'}`,
        resumedAgentId: current.agentId,
        pin: agentPin(current.agentId),
      };
    });
  }

  async stopAgentTask(
    senderThreadId: ThreadId,
    senderTurnId: TurnId,
    agentId: string,
  ): Promise<JsonValue | null> {
    this.turnLifecycle.requireActiveTurn(senderThreadId, senderTurnId);
    if (agentId === senderThreadId) throw new Error('An Agent cannot stop itself.');
    const execution = this.reachableExecution(senderThreadId, agentId);
    if (!execution) return null;
    const activeTurnId = this.turnLifecycle.activeTurnId(execution.agentId);
    if (!activeTurnId) {
      const status = terminalStatus(this.core.allTurns(execution.agentId).at(-1));
      throw new Error(`Task ${agentId} is not running (status: ${status})`);
    }
    if (activeTurnId !== execution.currentTurnId) {
      throw this.createThreadBusyError(`Task ${agentId} changed while stopping`);
    }
    await this.turnLifecycle.interruptTurn(execution.agentId, execution.currentTurnId);
    this.executions.recordStopIfCurrent({
      agentId: execution.agentId,
      generation: execution.generation,
      turnId: execution.currentTurnId,
      provenance: 'model',
      updatedAt: this.now(),
    });
    return {
      message: `Successfully stopped task: ${execution.agentId} (${execution.description})`,
      task_id: execution.agentId,
      task_type: 'local_agent',
      command: execution.description,
    };
  }

  hasAgentTask(senderThreadId: ThreadId, agentId: string): boolean {
    return this.reachableExecution(senderThreadId, agentId) !== null;
  }

  recordUserStopIfCurrent(
    execution: Pick<SubagentExecutionRecord, 'agentId' | 'generation' | 'currentTurnId'>,
  ): void {
    this.executions.recordStopIfCurrent({
      agentId: execution.agentId,
      generation: execution.generation,
      turnId: execution.currentTurnId,
      provenance: 'user',
      updatedAt: this.now(),
    });
  }

  clearUserStop(agentId: ThreadId): void {
    if (this.executions.read(agentId)?.stopProvenance === 'user') {
      this.executions.clearUserStop(agentId, this.now());
    }
  }

  commitInitialAdmission(agentId: ThreadId, turnId: TurnId): Error | null {
    try {
      const execution = this.executions.read(agentId);
      if (!execution) {
        return this.core.requireThread(agentId).thread.threadSource === 'subagent'
          ? new Error(`Delegated Agent execution is unavailable: ${agentId}`)
          : null;
      }
      if (execution.initialAdmissionState === 'committed') return null;
      if (this.executions.completeInitialAdmissionIfCurrent(agentId, turnId, this.now())) return null;
      if (this.executions.read(agentId)?.initialAdmissionState === 'committed') return null;
      return new Error(`Agent initial admission commit raced for ${agentId}`);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  async spawnChild(
    input: SpawnChildThreadInput & { readonly parentSignal?: AbortSignal },
  ): Promise<SpawnChildThreadResult> {
      if (this.closing) throw this.createThreadBusyError('Agent service is shutting down');
      this.assertSpawnParentActive(input.parentThreadId, input.parentTurnId, input.parentSignal);
      const tokenCap = this.childTokenCap(input.maxTotalTokens);
      // Read unconditionally: the request's grant is the runtime default even
      // when THIS spawn carries a cap. Skipping the read for a capped spawn
      // opened the request unbounded, and every later uncapped child in the same
      // Turn inherited that — the breaker silently never fired.
      const configuredPoolBudget = await this.configuredPoolBudget();
      this.assertSpawnParentActive(input.parentThreadId, input.parentTurnId, input.parentSignal);
      const agentId = input.id ?? uuidV7(this.now());
      const turnId = input.turnId ?? uuidV7(this.now());
      let stagedWorktree: AgentWorktreeMetadata | null = null;
      let initialWorktreeIntent: AgentWorktreeRecoveryIntent | null = null;
      let admissionStarted = false;
      let createdPoolId: SubagentRequestPoolId | null = null;
      let createdCappedPoolId: SubagentRequestPoolId | null = null;
      let createdMemberThreadId: ThreadId | null = null;
      let result: SpawnChildThreadResult;
      try {
        result = await this.core.threadTreeMutex.run(async () => {
          this.assertSpawnParentActive(input.parentThreadId, input.parentTurnId, input.parentSignal);
          if (this.core.stoppingThreads.has(input.parentThreadId)) throw this.createThreadBusyError('Parent Thread is stopping');
          const parent = this.core.requireThread(input.parentThreadId);
            const collaborationChild = input.childKind !== 'isolatedSkill';
            if (collaborationChild) await this.assertNewAgentAdmission(input.parentThreadId);
            this.assertSpawnParentActive(input.parentThreadId, input.parentTurnId, input.parentSignal);
            const inheritedBudget = this.turnLifecycle.assertSubagentSpawnBudgetAvailable(
              input.parentThreadId,
              input.parentTurnId,
            );
            const role = typeof input.role === 'string'
              ? this.resolveRole(input.role, parent.thread.cwd)
              : input.role ?? this.resolveRole('default', parent.thread.cwd);
            const resolvedConfiguration = resolveChildConfiguration(parent.configuration, {
              role,
              ...(input.model === undefined ? {} : { model: input.model }),
              ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
            });
            // The model/extension registry is assembled after Thread admission.
            // Persist the selected Role's raw names and let ToolRuntime apply the
            // capability policy against the complete registry; filtering here
            // would silently discard MCP/extension contributions.
            const policyTools = resolvedConfiguration.tools;
            // Generic Agent spawns may omit this field to inherit the policy
            // pool. The isolated-Skill wrapper requires an array, so omitted
            // `allowed-tools` authoring reaches this seam as an explicit `[]`.
            const requestedCeiling = input.allowedTools === undefined
              ? policyTools
              : policyTools.filter((tool) => new Set(input.allowedTools).has(tool));
            const toolCeiling = Object.freeze([...new Set(requestedCeiling)]);
            const configuration = this.applyToolCeiling(resolvedConfiguration, toolCeiling);
            const createdAt = this.now();
            if (input.execution.initialWorktreeCwd !== null) {
              if (!this.planAgentWorktree || !this.prepareAgentWorktree) {
                throw new Error('Agent worktree isolation is unavailable');
              }
              initialWorktreeIntent = await this.planAgentWorktree({
                agentId,
                cwd: input.execution.initialWorktreeCwd,
                previous: input.execution.worktree,
              });
            }
            this.executions.beginInitialAdmission({
              agentId,
              parentThreadId: parent.thread.id,
              description: input.execution.description,
              agentType: input.execution.agentType,
              runMode: input.execution.runMode,
              currentTurnId: turnId,
              toolUseId: input.parentItemId,
              worktree: input.execution.worktree,
              toolPolicy: input.execution.toolPolicy,
              startupContext: input.execution.startupContext,
              initialWorktreeIntent,
              createdAt,
              updatedAt: createdAt,
            });
            admissionStarted = true;
            let childCwd = input.cwd ?? parent.thread.cwd;
            if (initialWorktreeIntent !== null) {
              if (!this.prepareAgentWorktree) throw new Error('Agent worktree isolation is unavailable');
              const prepared = await this.prepareAgentWorktree({
                agentId,
                intent: initialWorktreeIntent,
                worktree: input.execution.worktree,
              });
              stagedWorktree = prepared.worktree;
              childCwd = prepared.cwd;
              if (!this.executions.recordInitialWorktreeIfPending({
                agentId,
                turnId,
                worktree: prepared.worktree,
                updatedAt: this.now(),
              })) {
                throw new Error(`Agent initial worktree admission raced for ${agentId}`);
              }
            }
            const thread = await this.catalog.createThread({
              id: agentId,
              name: input.displayName ?? input.taskPath.split('/').at(-1) ?? 'Subagent',
              ephemeral: parent.thread.ephemeral,
              source: input.childKind === 'isolatedSkill' ? 'agent.skill' : 'collaboration',
              threadSource: 'subagent',
              modelProvider: parent.thread.modelProvider,
              cwd: childCwd,
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
            let memberPoolId = inheritedBudget?.pool?.poolId ?? null;
            const createdPools: CreateSubagentRequestPoolInput[] = [];
            if (!inheritedBudget?.resolutionFailed) {
              // The request exists whether or not anyone put a number on it:
              // ownership is a property of delegation, and a budget is one
              // optional attribute of the owner. Without this row an unbudgeted
              // delegation would have no identity for Stop to close.
              const requestPoolId = requestPoolIdForTurn(input.parentTurnId);
              const request = this.subagentBudgets.readPool(requestPoolId);
              if (memberPoolId === null && !request) {
                createdPools.push({
                  poolId: requestPoolId,
                  scope: 'turn',
                  originThreadId: parent.thread.id,
                  originTurnId: input.parentTurnId,
                  tokenBudget: configuredPoolBudget,
                });
                createdPoolId = requestPoolId;
                if (tokenCap === null) memberPoolId = requestPoolId;
              } else if (memberPoolId === null && tokenCap === null) {
                memberPoolId = request?.poolId ?? null;
              }
              // An explicit cap with no inherited pool still anchors its own
              // pool at the child, so the cap keeps bounding that child's own
              // descendants. Its spend binds there; its ownership stays the
              // request, recorded on the member below.
              if (memberPoolId === null && tokenCap !== null) {
                const cappedPoolId = cappedChildPoolId(thread.id);
                createdPools.push({
                  poolId: cappedPoolId,
                  scope: 'thread',
                  originThreadId: thread.id,
                  originTurnId: input.parentTurnId,
                  tokenBudget: tokenCap,
                });
                createdCappedPoolId = cappedPoolId;
                memberPoolId = cappedPoolId;
              }
            }
            // Recorded even with no pool and no cap: the member carries the
            // delegating Turn, so a child spawned before its request had a pool
            // can still join THAT request's pool later, and never a later one's.
            this.subagentBudgets.createAdmission({
              pools: createdPools,
              member: {
                threadId: thread.id,
                poolId: memberPoolId,
                originTurnId: input.parentTurnId,
                tokenCap,
              },
            }, thread.ephemeral);
            createdMemberThreadId = thread.id;
            if (createdPools.length > 0) this.turnLifecycle.refreshActiveSubagentBudgetCoverage();
            const accepted = await this.turnLifecycle.acceptAndLaunch({
              threadId: thread.id,
              turnId,
              input: [{ type: 'text', text: input.prompt }],
              trigger: {
                kind: 'subagent',
                parentThreadId: parent.thread.id,
                parentItemId: input.parentItemId,
              },
              ...(input.additionalContext === undefined ? {} : { additionalContext: input.additionalContext }),
            });
          return { thread, turn: accepted.response.turn, taskPath: input.taskPath };
        });
      } catch (error) {
        const committed = admissionStarted && await this.initialTurnCommitted(agentId, turnId);
        if (!committed) {
          const worktreeSettled = await this.rollbackInitialWorktree(
            agentId,
            stagedWorktree,
            input.execution.initialWorktreeCwd !== null,
          );
          if (worktreeSettled) {
            const threadExists = this.core.ephemeral.has(agentId) || this.core.metadata.read(agentId) !== null;
            let threadSettled = !threadExists;
            if (threadExists) {
              threadSettled = await this.catalog.deleteThread(agentId).then(
                () => true,
                (rollbackError) => {
                  console.warn(`[agent] failed to roll back staged Agent Thread ${agentId}`, rollbackError);
                  return false;
                },
              );
            }
            if (threadSettled) {
              await this.core.threadTreeMutex.run(async () => {
                if (createdMemberThreadId) this.subagentBudgets.deleteMember(createdMemberThreadId);
                if (!threadExists && admissionStarted) this.executions.deleteAgentOnly(agentId);
                if (
                  createdCappedPoolId
                  && this.subagentBudgets.membersForPool(createdCappedPoolId).length === 0
                ) this.subagentBudgets.deletePoolRecord(createdCappedPoolId);
                if (
                  createdPoolId
                  && this.subagentBudgets.membersForPool(createdPoolId).length === 0
                ) this.subagentBudgets.deletePoolRecord(createdPoolId);
                if (createdPoolId || createdCappedPoolId) {
                  this.turnLifecycle.refreshActiveSubagentBudgetCoverage();
                }
              }).catch((rollbackError) => {
                console.warn('[agent][subagent-budget-audit] failed to roll back staged budget rows', {
                  memberThreadId: createdMemberThreadId,
                  poolId: createdPoolId,
                  cappedPoolId: createdCappedPoolId,
                  error: rollbackError,
                });
              });
            }
          }
        }
        throw error;
      }
      // Every delegated form gets a per-child row, not only collaboration: an
      // isolated Skill otherwise runs behind one in-progress `skill` row with no
      // sign that a delegated agent is working and no way in.
      try {
        await this.recordSubagentActivity(
          input.parentThreadId,
          input.parentTurnId,
          result.thread.id,
          result.turn.id,
          result.taskPath,
          'started',
          null,
          // The call that delegated: this row stands in for it, so the reader
          // sees one delegation at the position where it was decided.
          input.parentItemId,
        );
      } catch (error) {
        // Child admission is already committed. A parent Stop can win after
        // that commit but before this presentation-only activity row; do not
        // misreport the spawn as failed or reclaim its workspace.
        console.warn(`[agent] Subagent start activity unavailable for ${result.thread.id}`, error);
      }
      return result;
    }

  async spawnIsolatedSkillThread(input: SpawnIsolatedSkillThreadInput): Promise<SpawnChildThreadResult> {
      this.turnLifecycle.requireActiveTurn(input.parentThreadId, input.parentTurnId);
      const parentPath = this.taskPathForThread(input.parentThreadId) ?? '/root';
      const taskName = isolatedSkillTaskName(input.skillName, isolatedSkillIdentity(uuidV7(this.now())));
      const parentExecution = this.executions.read(input.parentThreadId);
      return this.spawnChild({
        parentThreadId: input.parentThreadId,
        parentTurnId: input.parentTurnId,
        parentItemId: input.parentItemId,
        prompt: input.prompt,
        taskPath: `${parentPath}/${taskName}`,
        // The task path is a session address; the Skill's own name is what a
        // reader is owed. Recorded on the Thread and as the nickname so the
        // child is named the same in its own header, in Thread Details, and in
        // the parent's delegation row — including after the slug has folded
        // case and spaces away.
        displayName: input.skillName,
        nickname: input.skillName,
        role: 'default',
        allowedTools: input.allowedTools,
        childKind: 'isolatedSkill',
        turnId: uuidV7(this.now()),
        execution: {
          description: input.skillName,
          agentType: 'isolated-skill',
          runMode: 'foreground',
          worktree: null,
          initialWorktreeCwd: null,
          toolPolicy: {
            kind: parentExecution?.toolPolicy.kind ?? 'general-purpose',
            runInBackground: false,
            worktree: parentExecution?.toolPolicy.worktree === true
              || this.worktreeForThread(input.parentThreadId) !== null,
            allowNesting: parentExecution?.toolPolicy.allowNesting ?? true,
            requestedTools: normalizedRequestedTools(input.allowedTools),
          },
          startupContext: null,
        },
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      });
    }

  private async rollbackInitialWorktree(
    agentId: ThreadId,
    worktree: AgentWorktreeMetadata | null,
    requested: boolean,
  ): Promise<boolean> {
    if (!worktree) return !requested;
    if (!this.settleAgentWorktree) return false;
    try {
      const settled = await this.settleAgentWorktree(worktree);
      if (settled.retained) {
        console.warn(`[agent] retained modified worktree for incomplete Agent admission ${agentId}`);
        return false;
      }
      return true;
    } catch (error) {
      console.warn(`[agent] deferred worktree rollback for incomplete Agent admission ${agentId}`, error);
      return false;
    }
  }

  private async initialTurnCommitted(agentId: ThreadId, turnId: TurnId): Promise<boolean> {
    const ephemeral = this.core.ephemeral.get(agentId);
    if (ephemeral) return ephemeral.turns.some((turn) => turn.id === turnId);
    try {
      return (await this.core.rollout.read(agentId)).some((entry) => (
        entry.event.type === 'turn/started' && entry.event.turnId === turnId
      ));
    } catch (error) {
      console.warn(`[agent] could not verify initial Agent Turn ${turnId}`, error);
      return true;
    }
  }

  private assertAgentSpawnItemBoundary(
    parentThreadId: ThreadId,
    parentTurnId: TurnId,
    parentItemId: string,
  ): void {
    const turn = this.core.readTurn(parentThreadId, parentTurnId);
    const item = turn?.items.find((candidate) => candidate.id === parentItemId);
    if (!item) throw new Error('Agent spawn Item is outside the active parent Turn');
    if (item.type !== 'collabAgentToolCall' || item.tool !== 'agent' || item.status !== 'inProgress') {
      throw new Error('Agent spawn boundary must reference an in-progress agent Item');
    }
  }
  /**
   * A model-named `max_total_tokens`, or nothing when it names no real budget.
   *
   * A cap is a circuit breaker sized at definitely-anomalous, and a model
   * guessing at one guesses low — caps in the thousands starved children
   * mid-answer and handed the parent a refusal instead of the work it delegated.
   * Below the floor the cap is DROPPED rather than raised to it, because any cap
   * detaches the child into its own pool: raising it would hand each capped
   * child a private million-token budget and step straight over the
   * `subagentTokenBudget` the user configured. Dropping it puts the child back
   * in the request's shared pool, which is the only ceiling the user set.
   *
   * Validated first, so a malformed argument still teaches the model what it
   * sent: a floor applied before the check would swallow `0`, `1.5` and `"5000"`
   * and answer every one of them with a million.
   */
  private childTokenCap(maxTotalTokens: number | undefined): number | null {
      if (maxTotalTokens !== undefined) {
        if (!Number.isSafeInteger(maxTotalTokens) || maxTotalTokens < 1) {
          throw new Error('max_total_tokens must be a positive integer');
        }
        return maxTotalTokens;
      }
      return null;
    }
  private async configuredPoolBudget(): Promise<number | null> {
      const tokenBudget = await this.resolveSubagentTokenBudget();
      if (tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1)) {
        throw new Error('subagentTokenBudget must be a positive integer or null');
      }
      return tokenBudget;
    }
  private assertSpawnStructure(parentThreadId: ThreadId, maxDepth: number): void {
      const parentDepth = this.agentDepth(parentThreadId);
      if (parentDepth >= maxDepth) throw new SubagentDepthLimitError(maxDepth);
    }
  private agentDepth(threadId: ThreadId): number {
      let depth = 0;
      let current = this.core.requireThread(threadId).thread;
      const visited = new Set<ThreadId>();
      while (current.parentThreadId !== null && !visited.has(current.id)) {
        visited.add(current.id);
        if (current.source === 'collaboration') depth += 1;
        current = this.core.requireThread(current.parentThreadId).thread;
      }
      return depth;
    }
  private hasOutstandingChildren(parentThreadId: ThreadId): boolean {
      const pending = new Set(
        this.executions.pendingForParent(parentThreadId).map((notification) => notification.agentId),
      );
      return this.executions.listByParent(parentThreadId).some((child) => (
        child.runMode === 'background'
        && !(this.deletingThreadIds.has(parentThreadId) && this.deletingThreadIds.has(child.agentId))
        && (
          this.turnLifecycle.hasActiveTurn(child.agentId)
          || pending.has(child.agentId)
          || this.terminalPipelines.has(executionKey(child.agentId, child.generation))
          || this.terminalSettlementReservations.has(executionKey(child.agentId, child.generation))
        )
      ));
  }
  private async assertNewAgentAdmission(senderThreadId: ThreadId): Promise<void> {
      const limits = await this.resolveSubagentLimits();
      assertSubagentLimits(limits);
      this.assertSpawnStructure(senderThreadId, limits.maxDepth);
      const sender = this.core.requireThread(senderThreadId).thread;
      const root = rootThreadId(sender, (id) => this.core.requireThread(id).thread);
      // A child remains a live member until its terminal account/worktree
      // pipeline settles. Build one identity set first: persisted and
      // ephemeral edges can describe the same child during admission/recovery,
      // and counting both would consume two slots.
      const childIds = new Set<ThreadId>();
      for (const edge of this.core.metadata.childEdges(root, true)) {
        if (this.core.requireThread(edge.childThreadId).thread.source === 'collaboration') {
          childIds.add(edge.childThreadId);
        }
      }
      for (const [threadId, edge] of this.ephemeralSpawnEdges) {
        if (rootThreadId(
          this.core.requireThread(edge.parentThreadId).thread,
          (id) => this.core.requireThread(id).thread,
        ) !== root) continue;
        if (this.core.requireThread(threadId).thread.source === 'collaboration') childIds.add(threadId);
      }
      const live = [...childIds].filter((threadId) => (
        this.turnLifecycle.activeTurnId(threadId) !== null
        || [...this.terminalPipelines.keys()].some((key) => key.startsWith(`${threadId}:`))
        || [...this.terminalSettlementReservations.keys()].some((key) => key.startsWith(`${threadId}:`))
      )).length;
      if (live >= limits.maxConcurrent) {
        throw new Error(
          `Concurrent subagent limit reached. You can run ${limits.maxConcurrent} subagents at once. `
          + 'Do not retry. If the user wants more concurrent subagents, ask them to increase the Tenon maximum concurrent Agents setting.',
        );
      }
    }
  /**
   * Re-delegating to an idle child is a NEW request, so it joins the pool of the
   * Turn delegating now — the same rule that binds a fresh spawn. This is not
   * orphan migration: a live member is never moved, and this path is reached
   * only once every member of the old pool settled and the pool was reclaimed.
   * Without it a re-driven child would run uncovered, which is the one hole the
   * request-scoped pool could otherwise open.
   */
  private liveRequestFor(threadId: ThreadId): boolean {
      const pool = this.turnLifecycle.resolveSubagentBudget(threadId)?.pool;
      return Boolean(pool && pool.closedAt === null);
    }
  private taskPathForThread(threadId: ThreadId): string | null { return this.ephemeralSpawnEdges.get(threadId)?.taskPath
        ?? this.core.metadata.spawnEdgeForChild(threadId)?.taskPath
        ?? null; }
  /**
   * The delegated Thread's identity, and by returning it at all, the answer to
   * whether that Thread keeps an account. Spawn metadata is the authority here,
   * so this lookup belongs to whoever owns spawn edges rather than to the
   * writer: an ephemeral edge and a persisted one are both a delegation, and a
   * Thread with neither is not one no matter what its parent field says.
   */
  delegatedTranscriptSubject(thread: Thread): TranscriptSubject | null {
      if (!thread.parentThreadId) return null;
      const taskPath = this.taskPathForThread(thread.id);
      if (!taskPath) return null;
      return {
        threadId: thread.id,
        taskPath,
        parentThreadId: thread.parentThreadId,
        role: thread.agentRole,
        nickname: thread.agentNickname,
        cwd: thread.cwd,
      };
    }

  private async recordSubagentActivity(
      ownerThreadId: ThreadId,
      ownerTurnId: string,
      agentThreadId: ThreadId,
      agentTurnId: TurnId,
      agentPath: string,
      kind: PendingSubagentActivity['kind'],
      error: Turn['error'],
      spawnItemId: string | null,
    ): Promise<void> {
      await this.turnLifecycle.recordSubagentActivity(
        ownerThreadId,
        ownerTurnId,
        agentThreadId,
        agentTurnId,
        agentPath,
        kind,
        error,
        this.now(),
        spawnItemId,
      );
    }
  queueChildTurnActivity(thread: Thread, turn: Turn): void {
      // Every delegated form gets a parent-visible row; only collaboration gets
      // the result channel. The account is written from the same Turn-completion
      // point, but by the writer, which serves every Thread kind and not only a
      // child.
      if (!thread.parentThreadId) return;
      const agentPath = this.taskPathForThread(thread.id);
      if (!agentPath) return;
      const kind: PendingSubagentActivity['kind'] = turn.status === 'completed'
        ? 'completed'
        : turn.status === 'interrupted'
          ? 'interrupted'
          : 'errored';
      const form: PendingSubagentActivity['form'] = thread.source === 'collaboration'
        ? 'collaboration'
        : 'isolatedSkill';
      // This provider Turn is only an intermediate result. Its descendants must
      // first return through a continuation so the ancestor sees one synthesized
      // terminal transition for this Agent generation.
      if (form === 'collaboration' && this.hasOutstandingChildren(thread.id)) return;
      const queued = this.pendingSubagentActivities.get(thread.parentThreadId) ?? [];
      queued.push({ agentThreadId: thread.id, agentTurnId: turn.id, agentPath, kind, error: turn.error, form });
      this.pendingSubagentActivities.set(thread.parentThreadId, queued);
      // An isolated Skill has no Agent notification lifecycle, so its terminal
      // transition must not wake a parent blocked on Agent children; the
      // `skill` call that is already awaiting it owns its outcome.
      if (form === 'collaboration') {
        this.signalCollaborationActivity(thread.parentThreadId);
        const execution = this.executions.read(thread.id);
        if (execution && execution.currentTurnId === turn.id) {
          const reservation = this.terminalSettlementReservations.get(
            executionKey(execution.agentId, execution.generation),
          );
          if (reservation) this.startReservedTerminalSettlement(reservation);
          else this.persistAgentTerminal(thread, turn);
        }
      }
    }

  async recoverPendingNotifications(): Promise<void> {
      await this.recoverPendingGenerationAdmissions();
      const parents = new Set<ThreadId>();
      for (const execution of this.executions.all()) {
        try {
          this.assertThreadAvailable(execution.agentId);
          const turn = this.core.readTurn(execution.agentId, execution.currentTurnId);
          if (turn && turn.status !== 'inProgress') {
            this.persistAgentTerminal(this.core.requireThread(execution.agentId).thread, turn);
          }
          if (execution.runMode === 'background') parents.add(execution.parentThreadId);
        } catch (error) {
          console.warn(`[agent] Skipping orphaned Agent execution during recovery: ${execution.agentId}`, error);
        }
      }
      for (const parentThreadId of [
        ...parents,
        ...this.executions.parentsWithPending(),
        ...this.executions.parentsWithPendingMessages(),
      ]) {
        await this.deliverParentWork(parentThreadId).catch((error) => {
          console.warn(`[agent] Skipping unavailable Agent parent during recovery: ${parentThreadId}`, error);
        });
      }
      // Foreground main-route envelopes are tied to the parent Turn that
      // invoked the child. They cannot be resumed after a host restart: doing
      // so would inject stale model-authored input into a later user Turn.
      // Sweep them explicitly because the normal recovery path intentionally
      // delivers background messages only.
      await this.discardStaleForegroundParentMessages();
    }

    private async recoverPendingGenerationAdmissions(): Promise<void> {
      for (const { execution, previous } of this.executions.pendingGenerationAdmissions()) {
        try {
          if (this.core.readTurn(execution.agentId, execution.currentTurnId)) {
            this.executions.completeGenerationAdmissionIfCurrent(
              execution.agentId,
              execution.generation,
              execution.currentTurnId,
            );
            continue;
          }
          if (!this.executions.rollbackGeneration(
            execution.agentId,
            execution.generation,
            execution.currentTurnId,
          )) continue;
          await this.rollbackPreparedResumeWorktree(execution.agentId, {
            previous: previous.worktree,
            prepared: execution.worktree,
          }, previous);
        } catch (error) {
          console.warn(`[agent] Skipping orphaned Agent generation admission during recovery: ${execution.agentId}`, error);
        }
      }
    }

    private async discardStaleForegroundParentMessages(): Promise<void> {
      for (const parentThreadId of this.executions.parentsWithPendingMessages()) {
        for (const message of this.executions.pendingParentMessages(parentThreadId)) {
          if (message.deliveryMode !== 'foreground') continue;
          try {
            this.assertThreadAvailable(parentThreadId);
            this.assertThreadAvailable(message.senderAgentId);
          } catch {
            continue;
          }
          if (!this.executions.claimParentMessage(message.id)) continue;
          this.executions.discardParentMessage(message.id);
          console.warn(`[agent] Discarded stale foreground Agent main-route message during recovery: ${message.senderAgentId}`);
        }
      }
    }

  private persistAgentTerminal(thread: Thread, turn: Turn): void {
      const execution = this.executions.read(thread.id);
      if (!execution || execution.currentTurnId !== turn.id) return;
      const key = executionKey(execution.agentId, execution.generation);
      if (this.terminalPipelines.has(key)) return;
      this.reserveTerminalSettlement(execution, turn);
      const reservation = this.terminalSettlementReservations.get(key);
      if (reservation) this.startReservedTerminalSettlement(reservation);
    }

  private reserveTerminalSettlement(execution: SubagentExecutionRecord, turn: Turn): void {
    const key = executionKey(execution.agentId, execution.generation);
    if (this.foregroundSettlementWaits.has(key)) this.terminalSettlementDeferred(key);
    const existing = this.terminalSettlementReservations.get(key);
    if (existing) {
      if (existing.turn.id === turn.id) return;
      existing.execution = execution;
      existing.turn = turn;
      existing.notifyParent = execution.runMode === 'background'
        && !this.deletingThreadIds.has(execution.agentId);
      existing.revision += 1;
      existing.worktreeSettled = false;
      existing.retryAttempt = 0;
      existing.retryExhausted = false;
      if (existing.retryTimer) {
        clearTimeout(existing.retryTimer);
        existing.retryTimer = null;
      }
      return;
    }
    if (this.terminalPipelines.has(key)) return;
    this.terminalSettlementReservations.set(key, {
      key,
      execution,
      turn,
      notifyParent: execution.runMode === 'background'
        && !this.deletingThreadIds.has(execution.agentId),
      revision: 0,
      worktreeSettled: false,
      pipeline: null,
      retryAttempt: 0,
      retryExhausted: false,
      retryTimer: null,
    });
  }
  private startReservedTerminalSettlement(reservation: TerminalSettlementReservation): void {
    if (reservation.pipeline || reservation.retryExhausted) return;
    // A provider Turn that delegated background work is intermediate. Keep its
    // reservation durable, but do not create a pipeline that can only fail
    // until every direct child result has been consumed.
    if (this.hasOutstandingChildren(reservation.execution.agentId)) return;
    if (reservation.retryTimer) {
      clearTimeout(reservation.retryTimer);
      reservation.retryTimer = null;
    }
    const revision = reservation.revision;
    if (this.closing) this.closeAttemptedTerminalRevisions.set(reservation.key, revision);
    const execution = reservation.execution;
    const turn = reservation.turn;
    const rawPipeline = this.runTerminalPipeline(
      execution,
      turn,
      reservation,
    );
    let outcome: TerminalSettlementOutcome | null = null;
    const pipeline = rawPipeline.then((result) => {
      outcome = result;
      if (result === 'deferredForDescendants') return;
      if (
        this.terminalSettlementReservations.get(reservation.key) === reservation
        && reservation.revision === revision
      ) {
        if (reservation.retryTimer) clearTimeout(reservation.retryTimer);
        this.terminalSettlementReservations.delete(reservation.key);
        this.terminalSettlementDeferreds.get(reservation.key)?.resolve();
      }
    });
    reservation.pipeline = pipeline;
    this.terminalPipelines.set(reservation.key, pipeline);
    this.trackForClose(pipeline);
    void pipeline.then(() => {
      if (this.terminalPipelines.get(reservation.key) === pipeline) this.terminalPipelines.delete(reservation.key);
      reservation.pipeline = null;
      if (
        this.terminalSettlementReservations.get(reservation.key) === reservation
        && reservation.revision !== revision
      ) {
        this.startReservedTerminalSettlement(reservation);
      } else if (outcome === 'deferredForDescendants') {
        // A descendant can be admitted while the terminal transcript flush is
        // in flight. This is normal orchestration, not a settlement failure.
        // The descendant's completion/idle edge will restart this reservation.
        return;
      } else if (
        reservation.notifyParent
        && !this.closing
        && !this.turnLifecycle.hasActiveTurn(reservation.execution.parentThreadId)
      ) {
        reservation.retryAttempt = 0;
        reservation.retryExhausted = false;
        // Delivery may have observed this pipeline while its durable
        // notification was already ready. Retry after the pipeline identity is
        // gone so a sibling cannot leave the parent parked indefinitely.
        void this.deliverParentWork(reservation.execution.parentThreadId).catch((error) => {
          console.warn(`[agent] Subagent parent delivery deferred for ${reservation.execution.agentId}`, error);
        });
      }
    }, (error) => {
      if (this.terminalPipelines.get(reservation.key) === pipeline) this.terminalPipelines.delete(reservation.key);
      reservation.pipeline = null;
      console.warn(`[agent] Subagent terminal pipeline deferred for ${reservation.execution.agentId}`, error);
      if (
        this.terminalSettlementReservations.get(reservation.key) === reservation
        && reservation.revision !== revision
      ) {
        this.startReservedTerminalSettlement(reservation);
      } else {
        this.scheduleTerminalSettlementRetry(reservation);
      }
    });
  }

  private scheduleTerminalSettlementRetry(reservation: TerminalSettlementReservation): void {
    if (
      this.closing
      ||
      reservation.retryTimer
      || this.terminalSettlementReservations.get(reservation.key) !== reservation
    ) return;
    if (reservation.retryAttempt >= MAX_TERMINAL_SETTLEMENT_RETRIES) {
      reservation.retryExhausted = true;
      this.terminalSettlementDeferreds.get(reservation.key)?.reject(
        new Error(TERMINAL_SETTLEMENT_RETRY_EXHAUSTED_MESSAGE),
      );
      console.warn(
        `[agent] Subagent terminal settlement retry budget exhausted for ${reservation.execution.agentId}; startup recovery required`,
      );
      return;
    }
    const delayMs = Math.min(1_000 * 2 ** reservation.retryAttempt, 30_000);
    reservation.retryAttempt += 1;
    reservation.retryTimer = setTimeout(() => {
      reservation.retryTimer = null;
      this.startReservedTerminalSettlement(reservation);
    }, delayMs);
    reservation.retryTimer.unref?.();
  }

  private retryTerminalSettlements(): void {
    if (this.closing) return;
    for (const reservation of [...this.terminalSettlementReservations.values()]) {
      const current = this.executions.read(reservation.execution.agentId);
      if (
        !current
        || current.generation !== reservation.execution.generation
        || current.currentTurnId !== reservation.execution.currentTurnId
      ) {
        if (reservation.retryTimer) clearTimeout(reservation.retryTimer);
        this.terminalSettlementReservations.delete(reservation.key);
        this.terminalSettlementDeferreds.get(reservation.key)?.resolve();
        continue;
      }
      this.startReservedTerminalSettlement(reservation);
    }
  }

  private async runTerminalPipeline(
      execution: SubagentExecutionRecord,
      turn: Turn,
      reservation?: TerminalSettlementReservation,
    ): Promise<TerminalSettlementOutcome> {
      // Account and workspace cleanup are best-effort runtime work. Neither
      // may suppress the terminal notification: the parent still needs the
      // child's result even when an artifact or worktree operation fails.
      try {
        await this.transcripts.flushForTerminalSettlement(execution.agentId);
      } catch (error) {
        console.warn(`[agent] Subagent transcript flush deferred for ${execution.agentId}`, error);
      }

      // Keep this record immutable for the whole pipeline. A resume can advance
      // the ledger while account I/O is in flight; every write below is guarded
      // by this generation/Turn pair and must never follow the newer record.
      let refreshed: SubagentExecutionRecord | null = execution;
      if (turn.error?.code === 'subagent_budget_exhausted') {
        refreshed = this.executions.recordStopIfCurrent({
          agentId: execution.agentId,
          generation: execution.generation,
          turnId: execution.currentTurnId,
          provenance: 'budget',
          updatedAt: this.now(),
        });
      } else if (turn.error?.code === 'host_restart') {
        refreshed = this.executions.recordStopIfCurrent({
          agentId: execution.agentId,
          generation: execution.generation,
          turnId: execution.currentTurnId,
          provenance: 'hostRestart',
          updatedAt: this.now(),
        });
      }

      if (refreshed === null) return 'settled';
      const terminalRecord = refreshed;

      if (this.hasOutstandingChildren(execution.agentId)) {
        return 'deferredForDescendants';
      }

      if (execution.worktree && this.settleAgentWorktree && reservation && !reservation.worktreeSettled) {
        try {
          const current = this.executions.read(execution.agentId);
          if (
            !current
            || current.generation !== execution.generation
            || current.currentTurnId !== execution.currentTurnId
          ) return 'settled';
          if (current.worktree && current.worktree.removedAt !== null && current.worktreeCleanupStartedAt === null) {
            await this.persistThreadCwd(execution.agentId, current.worktree);
            reservation.worktreeSettled = true;
          } else {
            const worktree = current.worktree ?? execution.worktree;
            const settled = await this.settleAgentWorktree(worktree, {
              cleanupStarted: current.worktreeCleanupStartedAt !== null,
              beforeCleanRemoval: async () => {
                const started = this.executions.beginWorktreeCleanupIfCurrent({
                  agentId: execution.agentId,
                  generation: execution.generation,
                  turnId: execution.currentTurnId,
                  worktree,
                  startedAt: this.now(),
                });
                if (!started) throw new Error(`Agent worktree cleanup admission raced for ${execution.agentId}`);
              },
            });
            refreshed = settled.retained
              ? current.worktreeCleanupStartedAt === null
                ? this.executions.setWorktreeIfCurrent({
                  agentId: execution.agentId,
                  generation: execution.generation,
                  turnId: execution.currentTurnId,
                  worktree: settled.worktree,
                  updatedAt: this.now(),
                })
                : this.executions.cancelWorktreeCleanupIfCurrent({
                  agentId: execution.agentId,
                  generation: execution.generation,
                  turnId: execution.currentTurnId,
                  worktree: settled.worktree,
                  updatedAt: this.now(),
                })
              : this.executions.completeWorktreeCleanupIfCurrent({
                agentId: execution.agentId,
                generation: execution.generation,
                turnId: execution.currentTurnId,
                expectedWorktree: worktree,
                worktree: settled.worktree,
                updatedAt: this.now(),
              });
            if (refreshed === null) return 'settled';
            await this.persistThreadCwd(execution.agentId, settled.worktree);
            reservation.worktreeSettled = true;
          }
        } catch (error) {
          // Cleanup state is durable independently from result delivery. Leave
          // the last truthful metadata (including an in-progress cleanup
          // marker) for resume/startup reconciliation, but never strand the
          // parent behind an inspection-only workspace failure.
          console.warn(`[agent] Subagent worktree cleanup deferred for ${execution.agentId}`, error);
        }
      }

      // Recorded for EVERY settled generation, not only the ones that notify a
      // parent. The durable status is what a reopened conversation reads when
      // no child Turn is loaded, and gating it on notification left a settled
      // foreground Agent reading as `Idle` — or `Starting` — for work that had
      // verifiably finished.
      {
        const recorded = this.executions.recordTerminal({
          agentId: execution.agentId,
          generation: execution.generation,
          parentThreadId: execution.parentThreadId,
          turnId: turn.id,
          toolUseId: execution.toolUseId,
          status: terminalRecord.stopProvenance === 'model'
            ? 'killed'
            : turn.status === 'completed'
              ? 'completed'
              : turn.status === 'failed'
                ? 'failed'
                : 'interrupted',
          createdAt: this.now(),
        }, reservation?.notifyParent === true);
        if (!recorded) return 'settled';
      }

      if (reservation?.notifyParent === true) {
        await this.deliverParentWork(execution.parentThreadId).catch((error) => {
          console.warn(`[agent] Subagent parent delivery deferred for ${execution.agentId}`, error);
        });
      }
      return 'settled';
    }

  private async withResumeLock<T>(agentId: ThreadId, work: () => Promise<T>): Promise<T> {
    const previous = this.resumePipelines.get(agentId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.resumePipelines.set(agentId, current);
    this.trackForClose(current);
    try {
      return await current;
    } finally {
      if (this.resumePipelines.get(agentId) === current) this.resumePipelines.delete(agentId);
    }
  }

  private async persistThreadCwd(threadId: ThreadId, worktree: AgentWorktreeMetadata): Promise<void> {
      const record = this.core.requireThread(threadId);
      const cwd = worktree.removedAt === null ? worktree.path : worktree.sourceCwd;
      if (record.thread.ephemeral) {
        const state = this.core.ephemeral.get(threadId);
        if (state) state.record = { ...state.record, thread: { ...state.record.thread, cwd } };
      } else {
        this.core.metadata.setCwd(threadId, cwd, this.now());
      }
    }

  private async deliverParentWork(parentThreadId: ThreadId): Promise<void> {
      if (this.closing) return;
      const previous = this.parentDeliveryPipelines.get(parentThreadId) ?? Promise.resolve();
      const current = previous
        .catch(() => undefined)
        .then(async () => {
          if (this.closing) return;
          this.assertThreadAvailable(parentThreadId);
          await this.deliverPendingNotifications(parentThreadId);
          await this.deliverParentMessages(parentThreadId);
        });
      this.parentDeliveryPipelines.set(parentThreadId, current);
      this.trackForClose(current);
      try {
        await current;
      } finally {
        if (this.parentDeliveryPipelines.get(parentThreadId) === current) {
          this.parentDeliveryPipelines.delete(parentThreadId);
        }
      }
    }

  private rootThreadIdFor(threadId: ThreadId): ThreadId {
    return rootThreadId(
      this.core.requireThread(threadId).thread,
      (id) => this.core.requireThread(id).thread,
    );
  }

  private async deliverPendingNotifications(parentThreadId: ThreadId): Promise<void> {
      if (this.closing) return;
      this.assertThreadAvailable(parentThreadId);
      if (this.turnLifecycle.hasActiveTurn(parentThreadId)) return;
      const pending = this.executions.pendingForParent(parentThreadId);
      for (const notification of pending) {
        if (this.closing) return;
        if (this.deletingThreadIds.has(notification.agentId)) continue;
        if (this.shouldDeferNotification(parentThreadId, notification)) return;
        try {
          this.assertThreadAvailable(notification.agentId);
        } catch {
          continue;
        }
        if (!this.executions.claim(notification.agentId, notification.generation)) continue;
        let continuationReservation: {
          readonly snapshot: ReturnType<SubagentExecutionLedger['generationSnapshot']>;
          readonly turnId: TurnId;
        } | null = null;
        try {
          if (this.deletingThreadIds.has(notification.agentId)) {
            this.executions.release(notification.agentId, notification.generation);
            continue;
          }
          const execution = this.executions.require(notification.agentId);
          const turn = this.core.readTurn(notification.agentId, notification.turnId);
          if (!turn) throw new Error(`Agent notification Turn not found: ${notification.turnId}`);
          let outputFile: string | null = null;
          try {
            outputFile = await this.transcripts.pathForReader(notification.agentId);
          } catch (error) {
            // The transcript is an inspection/account artifact. A missing path
            // must degrade to the explicit null form while the terminal result
            // still reaches the parent.
            console.warn(`[agent] Subagent transcript path unavailable for ${notification.agentId}`, error);
          }
          if (this.closing) {
            this.executions.release(notification.agentId, notification.generation);
            return;
          }
          if (this.deletingThreadIds.has(notification.agentId)) {
            this.executions.release(notification.agentId, notification.generation);
            continue;
          }
          const clientUserMessageId = notificationClientId(notification);
          const committed = this.turnLifecycle.readTurnByClientUserMessageIdForHost(
            parentThreadId,
            clientUserMessageId,
          );
          if (committed) {
            // The process can stop after the notification Turn commits but
            // before the notification row is marked delivered. Its stable
            // client ID is the recovery authority; reserving another
            // continuation here would point the Agent ledger at a Turn that
            // idempotent admission never creates.
            this.executions.markDelivered(notification.agentId, notification.generation, this.now());
            continue;
          }
          const parentExecution = this.executions.read(parentThreadId);
          const continuation = parentExecution ? this.executions.generationSnapshot(parentThreadId) : null;
          const continuationTurnId = parentExecution ? uuidV7(this.now()) : undefined;
          if (parentExecution && continuation && continuationTurnId !== undefined && !this.executions.continueGeneration({
            agentId: parentThreadId,
            expectedGeneration: continuation.generation,
            expectedTurnId: continuation.currentTurnId,
            turnId: continuationTurnId,
            updatedAt: this.now(),
          })) throw new Error(`Parent Agent continuation admission raced for ${parentThreadId}`);
          if (continuation && continuationTurnId !== undefined) {
            continuationReservation = { snapshot: continuation, turnId: continuationTurnId };
          }
          const accepted = await this.turnLifecycle.tryStartTurnIfIdle({
            threadId: parentThreadId,
            ...(continuationTurnId === undefined ? {} : { turnId: continuationTurnId }),
            input: [{
              type: 'text',
              text: taskNotificationText({ execution, notification, turn, outputFile }),
            }],
            clientUserMessageId,
            trigger: {
              kind: 'subagent',
              parentThreadId: execution.parentThreadId,
              parentItemId: notification.toolUseId,
            },
          });
          if (!accepted) {
            this.rollbackContinuation(parentThreadId, continuationReservation);
            this.executions.release(notification.agentId, notification.generation);
            return;
          }
          continuationReservation = null;
          this.executions.markDelivered(notification.agentId, notification.generation, this.now());
        } catch (error) {
          this.rollbackContinuation(parentThreadId, continuationReservation);
          this.executions.release(notification.agentId, notification.generation);
          console.warn(`[agent] Subagent notification delivery deferred for ${notification.agentId}`, error);
          continue;
        }
      }
    }

  private rollbackContinuation(
    parentThreadId: ThreadId,
    reservation: {
      readonly snapshot: ReturnType<SubagentExecutionLedger['generationSnapshot']>;
      readonly turnId: TurnId;
    } | null,
  ): void {
    if (!reservation) return;
    this.executions.rollbackContinuation({
      agentId: parentThreadId,
      expectedGeneration: reservation.snapshot.generation,
      expectedTurnId: reservation.turnId,
      snapshot: reservation.snapshot,
    });
  }

  private shouldDeferNotification(
    parentThreadId: ThreadId,
    notification: Pick<SubagentPendingNotification, 'agentId' | 'generation'>,
  ): boolean {
      if (this.hasOutstandingChildren(notification.agentId)) return true;
      // A root consumes each completed child independently. An Agent parent,
      // however, aggregates its direct children before the continuation that
      // lets it synthesize a single result for its own parent.
      if (!this.executions.read(parentThreadId)) return false;
      return this.hasBlockingBackgroundChildren(
        parentThreadId,
        executionKey(notification.agentId, notification.generation),
      );
    }

  private hasBlockingBackgroundChildren(parentThreadId: ThreadId, excludedExecutionKey?: string): boolean {
      const ready = new Set(
        this.executions.pendingForParent(parentThreadId).map((notification) => (
          executionKey(notification.agentId, notification.generation)
        )),
      );
      return this.executions.listByParent(parentThreadId).some((child) => {
        const childExecutionKey = executionKey(child.agentId, child.generation);
        return child.runMode === 'background'
        && childExecutionKey !== excludedExecutionKey
        // A durable pending notification is terminal output waiting to be
        // consumed, not live work. Counting it together with its still-closing
        // pipeline makes two completed siblings block each other forever.
        && !ready.has(childExecutionKey)
        && (
          this.turnLifecycle.hasActiveTurn(child.agentId)
          || this.terminalPipelines.has(childExecutionKey)
          || this.terminalSettlementReservations.has(childExecutionKey)
        );
      });
    }

  private async deliverParentMessages(
    parentThreadId: ThreadId,
    foreground?: { readonly senderAgentId: ThreadId; readonly generation: number },
  ): Promise<void> {
      if (this.closing) return;
      this.assertThreadAvailable(parentThreadId);
      const directRootForeground = foreground
        ? this.isDirectRootForeground(foreground.senderAgentId, parentThreadId)
        : false;
      const pending = !foreground
        ? this.executions.pendingParentMessages(parentThreadId)
          .filter((message) => message.deliveryMode === 'background')
        : directRootForeground
          ? this.executions.pendingForegroundParentMessages(
            parentThreadId,
            foreground.senderAgentId,
            foreground.generation,
          )
          : this.executions.pendingParentMessages(parentThreadId).filter((message) => (
            message.deliveryMode === 'background'
            && message.senderAgentId === foreground.senderAgentId
            && message.generation === foreground.generation
          ));
      for (const message of pending) {
        if (this.closing) return;
        if (this.isForegroundMessageSenderActive(message)) continue;
        try {
          this.assertThreadAvailable(message.senderAgentId);
        } catch {
          continue;
        }
        if (!this.executions.claimParentMessage(message.id)) continue;
        try {
          const content = [{ type: 'text' as const, text: message.content }];
          const activeTurnId = this.turnLifecycle.activeTurnId(parentThreadId);
          if (activeTurnId) {
            await this.turnLifecycle.steerTurn({
              threadId: parentThreadId,
              expectedTurnId: activeTurnId,
              input: content,
              clientUserMessageId: message.id,
            }, 'advisory');
          } else if (directRootForeground) {
            // A foreground envelope belongs to the invoking parent Turn. If
            // that Turn was cancelled or already settled, discard the stale
            // envelope rather than starting an unsolicited root Turn or
            // leaving a queue item that can never be admitted.
            this.executions.discardParentMessage(message.id);
            console.warn(`[agent] Foreground Agent main-route message discarded after parent Turn settled: ${message.senderAgentId}`);
            continue;
          } else {
            const accepted = await this.turnLifecycle.tryStartTurnIfIdle({
              threadId: parentThreadId,
              input: content,
              clientUserMessageId: message.id,
              trigger: {
                kind: 'subagent',
                parentThreadId: message.senderAgentId,
                parentItemId: this.executions.require(message.senderAgentId).toolUseId,
              },
            });
            if (!accepted) {
              this.executions.releaseParentMessage(message.id);
              return;
            }
          }
          this.executions.markParentMessageDelivered(message.id, this.now());
        } catch (error) {
          if (message.deliveryMode === 'foreground') {
            // A foreground envelope has no independent retry lifecycle. The
            // invoking Turn is already finishing; retaining the claimed row
            // would leak stale model-authored input forever.
            this.executions.discardParentMessage(message.id);
          } else {
            this.executions.releaseParentMessage(message.id);
          }
          console.warn(`[agent] Agent main-route message delivery deferred for ${message.senderAgentId}`, error);
          return;
        }
      }
    }

  private isForegroundMessageSenderActive(message: {
    readonly senderAgentId: ThreadId;
    readonly generation: number;
  }): boolean {
      const execution = this.executions.read(message.senderAgentId);
      return execution?.runMode === 'foreground'
        && execution.generation === message.generation
        && this.turnLifecycle.hasActiveTurn(message.senderAgentId);
    }

  private isDirectRootForeground(senderAgentId: ThreadId, rootThreadId: ThreadId): boolean {
      const execution = this.executions.read(senderAgentId);
      return execution?.runMode === 'foreground' && execution.parentThreadId === rootThreadId;
    }

  private async sendAgentMessageToMain(senderThreadId: ThreadId, message: string): Promise<JsonValue> {
      if (this.closing) return agentServiceClosingResult();
      const execution = this.executions.read(senderThreadId);
      if (!execution) {
        return { success: false, message: 'Only an Agent can send to the main conversation.' };
      }
      if (execution.initialAdmissionState !== 'committed') {
        return { success: false, message: 'Agent admission is incomplete; messaging is unavailable.' };
      }
      const rootThreadId = this.rootThreadIdFor(senderThreadId);
      // Only a direct foreground child has an adjacent Agent result in the
      // root Turn. A nested foreground child still addresses root, but its
      // envelope follows the durable background-delivery path after it settles.
      const directRootForeground = execution.runMode === 'foreground'
        && execution.parentThreadId === rootThreadId;
      const deliveryMode = directRootForeground ? 'foreground' : 'background';
      const id = `agent-message:${execution.agentId}:${uuidV7(this.now())}`;
      this.executions.enqueueParentMessage({
        id,
        senderAgentId: senderThreadId,
        parentThreadId: rootThreadId,
        generation: execution.generation,
        content: agentMessageToMainText(
          execution.agentType,
          message,
          directRootForeground,
        ),
        deliveryMode,
        createdAt: this.now(),
      });
      if (execution.runMode === 'background') {
        await this.trackForClose(this.deliverParentMessages(rootThreadId));
      }
      return { success: true, message: "Message queued for the main conversation's next turn." };
    }

  private reachableExecution(senderThreadId: ThreadId, targetInput: string): SubagentExecutionRecord | null {
      if (targetInput === senderThreadId) return null;
      const execution = this.executions.read(targetInput);
      if (execution?.initialAdmissionState !== 'committed') return null;
      const sender = this.core.requireThread(senderThreadId).thread;
      if (
        sender.parentThreadId !== null
        && this.executions.read(senderThreadId)?.initialAdmissionState !== 'committed'
      ) return null;
      if (
        execution.runMode === 'foreground'
        && (execution.toolPolicy.kind === 'explore' || execution.toolPolicy.kind === 'plan')
      ) return null;
      const target = this.core.requireThread(execution.agentId).thread;
      if (target.source !== 'collaboration') return null;
      if (sender.sessionId !== target.sessionId) return null;
      if (execution.parentThreadId === senderThreadId || this.isReachableDescendant(senderThreadId, target.id)) {
        return execution;
      }
      // A child may steer/resume its siblings only through their shared parent.
      if (sender.parentThreadId && sender.parentThreadId === execution.parentThreadId) return execution;
      return null;
    }

  private hasCommittedCollaborationAdmission(threadId: ThreadId): boolean {
      const thread = this.core.requireThread(threadId).thread;
      return thread.parentThreadId === null
        || this.executions.read(threadId)?.initialAdmissionState === 'committed';
    }
  async flushPendingSubagentActivities(
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
            activity.agentTurnId,
            activity.agentPath,
            activity.kind,
            activity.error,
            // A terminal activity can be flushed into a later parent Turn,
            // where the delegating call is not among the Items. Claiming a slot
            // there would suppress an unrelated row.
            null,
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
  consumePendingSubagentActivities(
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
        state = { pending: false };
        this.collaborationActivity.set(threadId, state);
      }
      return state;
    }
  signalCollaborationActivity(threadId: ThreadId): void {
      const state = this.collaborationActivityState(threadId);
      state.pending = true;
    }
  takePendingCollaborationActivity(threadId: ThreadId): boolean {
      const state = this.collaborationActivity.get(threadId);
      if (!state?.pending) return false;
      state.pending = false;
      return true;
    }

  private terminalSettlementDeferred(key: string): TerminalSettlementDeferred {
      const existing = this.terminalSettlementDeferreds.get(key);
      if (existing) return existing;
      let settled = false;
      let resolvePromise!: () => void;
      let rejectPromise!: (error: Error) => void;
      const promise = new Promise<void>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      // A reservation can reach retry exhaustion before the spawning call has
      // returned far enough to await it. Keep that early rejection observed.
      void promise.catch(() => undefined);
      const deferred: TerminalSettlementDeferred = {
        promise,
        resolve: () => {
          if (settled) return;
          settled = true;
          resolvePromise();
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          rejectPromise(error);
        },
      };
      this.terminalSettlementDeferreds.set(key, deferred);
      if (this.closing) deferred.resolve();
      return deferred;
    }

  private async prepareWorktreeForResume(execution: SubagentExecutionRecord): Promise<PreparedResumeWorktree> {
    if (!execution.worktree || !this.planAgentWorktree || !this.prepareAgentWorktree) {
      return { previous: execution.worktree, prepared: execution.worktree };
    }
    const intent = await this.planAgentWorktree({
      agentId: execution.agentId,
      cwd: execution.worktree.sourceCwd,
      previous: execution.worktree,
    });
    const prepared = await this.prepareAgentWorktree({
      agentId: execution.agentId,
      intent,
      worktree: execution.worktree,
    });
    const next = this.executions.setWorktreeIfCurrent({
      agentId: execution.agentId,
      generation: execution.generation,
      turnId: execution.currentTurnId,
      worktree: prepared.worktree,
      updatedAt: this.now(),
    });
    if (!next) {
      await this.discardUnrecordedResumeWorktree(execution.agentId, {
        previous: execution.worktree,
        prepared: prepared.worktree,
      });
      throw this.createThreadBusyError(`Agent ${execution.agentId} changed while preparing its worktree`);
    }
    await this.persistThreadCwd(execution.agentId, prepared.worktree);
    return { previous: execution.worktree, prepared: next.worktree };
  }

  private isReachableDescendant(senderThreadId: ThreadId, childThreadId: ThreadId): boolean {
    const visited = new Set<ThreadId>();
    let current = this.core.requireThread(childThreadId).thread;
    while (current.parentThreadId !== null && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.parentThreadId === senderThreadId) return true;
      current = this.core.requireThread(current.parentThreadId).thread;
    }
    return false;
  }

  private async rollbackPreparedResumeWorktree(
    agentId: ThreadId,
    worktree: PreparedResumeWorktree,
    owner: Pick<SubagentExecutionRecord, 'generation' | 'currentTurnId'>,
  ): Promise<void> {
    if (!worktree.prepared || worktree.prepared === worktree.previous) return;
    const newlyCreated = worktree.previous !== null
      && worktree.previous.removedAt !== null
      && worktree.prepared.removedAt === null;
    if (!newlyCreated || !this.settleAgentWorktree || !worktree.previous) return;

    const started = this.executions.beginWorktreeCleanupIfCurrent({
      agentId,
      generation: owner.generation,
      turnId: owner.currentTurnId,
      worktree: worktree.prepared,
      startedAt: this.now(),
    });
    if (!started) return;

    try {
      const settled = await this.settleAgentWorktree(worktree.prepared, { cleanupStarted: true });
      if (settled.retained) {
        this.executions.cancelWorktreeCleanupIfCurrent({
          agentId,
          generation: owner.generation,
          turnId: owner.currentTurnId,
          worktree: worktree.prepared,
          updatedAt: this.now(),
        });
        return;
      }
      const restored = this.executions.completeWorktreeCleanupIfCurrent({
        agentId,
        generation: owner.generation,
        turnId: owner.currentTurnId,
        expectedWorktree: worktree.prepared,
        worktree: worktree.previous,
        updatedAt: this.now(),
      });
      if (restored) await this.persistThreadCwd(agentId, worktree.previous);
    } catch (error) {
      console.warn(`[agent] Failed to remove prepared Agent worktree during resume rollback ${agentId}`, error);
    }
  }

  private async discardUnrecordedResumeWorktree(
    agentId: ThreadId,
    worktree: PreparedResumeWorktree,
  ): Promise<void> {
    const newlyCreated = worktree.previous !== null
      && worktree.previous.removedAt !== null
      && worktree.prepared?.removedAt === null;
    if (!newlyCreated || !worktree.prepared || !this.settleAgentWorktree) return;
    try {
      const settled = await this.settleAgentWorktree(worktree.prepared);
      if (settled.retained) {
        console.warn(`[agent] Unrecorded Agent worktree changed before cleanup ${agentId}`);
      }
    } catch (error) {
      console.warn(`[agent] Failed to remove unrecorded Agent worktree ${agentId}`, error);
    }
  }

  private trackForClose<T>(work: Promise<T>): Promise<T> {
    this.inFlightForClose.add(work);
    void work.then(
      () => { this.inFlightForClose.delete(work); },
      () => { this.inFlightForClose.delete(work); },
    );
    return work;
  }
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

function agentServiceClosingResult(): JsonValue {
  return { success: false, message: 'Agent service is shutting down.' };
}

function agentTool(
  name: 'agent' | 'agent_message',
  label: string,
  execute: (itemId: string, params: unknown, signal?: AbortSignal) => Promise<AgentToolResult<JsonValue>>,
  parameters: Readonly<Record<string, unknown>>,
  prepareArguments: (value: unknown) => unknown,
): AgentTool {
  const contract = modelToolContract(name);
  if (!contract) throw new Error(`Missing Core model-tool contract: ${name}`);
  return {
    name,
    label,
    description: contract.description,
    parameters: parameters as TSchema,
    prepareArguments,
    executionMode: 'sequential',
    execute,
  };
}

function rawTextToolResult(text: string, details: JsonValue): AgentToolResult<JsonValue> {
  return { content: [{ type: 'text', text }], details };
}

function rawTextBlocksToolResult(texts: readonly string[], details: JsonValue): AgentToolResult<JsonValue> {
  return { content: texts.map((text) => ({ type: 'text' as const, text })), details };
}

function rawJsonToolResult(value: JsonValue): AgentToolResult<JsonValue> {
  return rawTextToolResult(JSON.stringify(value), value);
}

function agentMessageQueuedResult(agentId: ThreadId): JsonValue {
  return {
    success: true,
    message: `Message queued for delivery to ${agentId} at its next tool round.`,
    pin: agentPin(agentId),
  };
}

function agentPin(agentId: ThreadId): JsonValue {
  return { id: agentId, name: agentId, ref: agentId.slice(0, 8) };
}

function terminalStatus(turn: Turn | undefined): string {
  if (!turn) return 'notFound';
  return turn.status === 'failed' ? 'errored' : turn.status;
}

function assertSubagentLimits(limits: { readonly maxDepth: number; readonly maxConcurrent: number }): void {
  if (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 1) {
    throw new Error('Subagent maximum depth must be a positive integer');
  }
  if (!Number.isSafeInteger(limits.maxConcurrent) || limits.maxConcurrent < 1) {
    throw new Error('Subagent maximum concurrency must be a positive integer');
  }
}

function normalizedRequestedTools(tools: readonly string[] | undefined): readonly string[] | null {
  if (tools === undefined || tools.includes('*')) return null;
  return Object.freeze([...new Set(tools)]);
}

function notificationClientId(notification: SubagentPendingNotification): string {
  return `task-notification:${notification.agentId}:${notification.generation}`;
}

function executionKey(agentId: ThreadId, generation: number): string {
  return `${agentId}:${generation}`;
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
    agentTurnId: activity.agentTurnId,
    agentPath: activity.agentPath,
    error: activity.error,
    // Materialized from the queue, so this is always a terminal activity: see
    // the flush path for why those claim nothing.
    spawnItemId: null,
  };
}
