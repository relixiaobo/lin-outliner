import type { TSchema } from 'typebox';
import { resolveChildConfiguration,type AgentRole,type EffectiveThreadConfiguration,type ReasoningEffort } from '../../../core/agent/configuration';
import type { ContextCursor,ContextEvidenceKind,InheritedContextPayload,JsonValue,Thread,ThreadContextPayload,ThreadContextPayloadReference,ThreadId,ThreadItem,ThreadItemOutputReference,ThreadResourceReference,ThreadUserContent,Turn,TurnId } from '../../../core/agent/protocol';
import { modelToolContract } from '../../../core/agent/tools';
import { turnTerminalAnswer } from '../../../core/agent/turnAnswer';
import { isolatedSkillIdentity, isolatedSkillTaskName } from '../../../core/agent/subagentTaskPath';
import {
  contextPayloadReferenceKey,
  itemOutputReferences,
  itemRequiredContextPayloadReferences,
  itemResourceReferences,
  itemToolArgumentPayloadReferences,
  outputReferenceKey,
  resourceReferenceKey,
} from '../context/contextDependencies';
import { cursorFor } from '../context/ContextEpoch';
import { reduceRoleContext } from '../context/RoleContextReducer';
import { reduceSkillContext } from '../context/SkillContextReducer';
import {
  cappedChildPoolId,
  MAX_SUBAGENT_DEPTH,
  MIN_SUBAGENT_TOKEN_CAP,
  MAX_SUBAGENT_SPAWNS_PER_THREAD,
  requestPoolIdForTurn,
  type SubagentRequestLedger,
  type SubagentRequestPoolId,
} from '../persistence/SubagentRequestLedger';
import type { AgentTool,AgentToolResult } from '../runtime/kernel/types';
import { SubagentDepthLimitError,SubagentSpawnLimitError } from '../SubagentStructuralLimitError';
import type { CollaborationAgentView,CollaborationTerminalOutcome,CollaborationWaitResult,SpawnChildThreadInput,SpawnChildThreadResult,SpawnIsolatedSkillThreadInput } from '../ThreadService';
import { uuidV7 } from '../uuid';
import type { ThreadCatalogOps } from './ThreadCatalogOps';
import { ThreadCore } from './ThreadCore';
import type { ThreadResourceOps } from './ThreadResourceOps';
import type { ThreadTranscriptWriter } from './ThreadTranscriptWriter';
import type { TranscriptSubject } from './TranscriptRenderer';
import type { TurnLifecycle } from './TurnLifecycle';

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
   * activity, but only `collaboration` is deliverable through the collaboration
   * result channel — an isolated Skill's outcome belongs to its `skill` tool row
   * alone, and must never surface again as `wait_agent` work.
   */
  readonly form: 'collaboration' | 'isolatedSkill';
}
interface CollaborationActivityState {
  pending: boolean;
  readonly waiters: Set<() => void>;
}
interface SubagentCatalog {
  createThread: ThreadCatalogOps['createThread'];
  deleteThread: ThreadCatalogOps['deleteThread'];
}

export class SubagentCollaboration {
  private readonly mailbox = new Map<ThreadId, Array<{ readonly content: readonly ThreadUserContent[] }>>();
  private readonly ephemeralSpawnEdges = new Map<ThreadId, { sessionId: string; parentThreadId: ThreadId; taskPath: string; createdAt: number }>();
  private readonly pendingSubagentActivities = new Map<ThreadId, PendingSubagentActivity[]>();
  private readonly collaborationActivity = new Map<ThreadId, CollaborationActivityState>();
  constructor(
    private readonly core: ThreadCore,
    private readonly resourceOps: ThreadResourceOps,
    private readonly catalog: SubagentCatalog,
    private readonly turnLifecycle: TurnLifecycle,
    private readonly subagentBudgets: SubagentRequestLedger,
    private readonly resolveRole: (name: string, cwd: string) => AgentRole,
    private readonly resolveSubagentTokenBudget: () => Promise<number | null>,
    private readonly now: () => number,
    private readonly applyToolCeiling: (configuration: EffectiveThreadConfiguration, toolCeiling: readonly string[] | null) => EffectiveThreadConfiguration,
    private readonly createThreadBusyError: (message: string) => Error,
    private readonly transcripts: ThreadTranscriptWriter,
  ) {}
  recordEphemeralSpawnEdge(threadId: ThreadId, edge: { readonly sessionId: string; readonly parentThreadId: ThreadId; readonly taskPath: string; readonly createdAt: number }): void {
    this.ephemeralSpawnEdges.set(threadId, edge);
  }
  deleteEphemeralSpawnEdge(threadId: ThreadId): void { this.ephemeralSpawnEdges.delete(threadId); }
  ephemeralChildThreadIds(parentThreadId: ThreadId): readonly ThreadId[] {
    return [...this.ephemeralSpawnEdges].flatMap(([threadId, edge]) => edge.parentThreadId === parentThreadId ? [threadId] : []);
  }
  clearThreadCoordinationState(threadIds: readonly ThreadId[]): void {
    for (const threadId of threadIds) {
      this.mailbox.delete(threadId);
      this.pendingSubagentActivities.delete(threadId);
      this.collaborationActivity.delete(threadId);
      this.transcripts.forgetCursor(threadId);
    }
  }
  /**
   * Work already accepted for a child that has not started a Turn yet. An idle
   * child holding a queued message is not finished, and deleting it would throw
   * that message away along with the parent's next `followup_task` target.
   */
  hasQueuedWork(threadId: ThreadId): boolean {
    return (this.mailbox.get(threadId)?.length ?? 0) > 0;
  }
  /**
   * Closing hygiene for a stopped request, not an admission gate — the closed
   * request already refuses new Turns. Without this, work the user stopped
   * survives in the mailbox and is prepended to some LATER request's
   * `followup_task`, which is the same trust violation displaced in time.
   * Nothing recorded is lost: the `send_message` call remains a canonical Item
   * in the sender's transcript, so the model can send it again.
   */
  dropQueuedWork(threadIds: readonly ThreadId[]): void {
    for (const threadId of threadIds) this.mailbox.delete(threadId);
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
  }): readonly AgentTool[] {
    const threadId = turn.threadId;
    const turnId = turn.turnId;
    return [
      collaborationTool('spawn_agent', 'Spawn Subagent', async (itemId, params) => {
        const input = record(params, 'collaboration.spawn_agent');
        const result = await this.spawnCollaborationAgent({
          senderThreadId: threadId,
          senderTurnId: turnId,
          parentItemId: itemId,
          taskName: requiredString(input.task_name, 'task_name'),
          message: requiredString(input.message, 'message'),
          ...(optionalString(input.agent_type) === undefined ? {} : { role: optionalString(input.agent_type) }),
          ...(optionalString(input.model) === undefined ? {} : { model: optionalString(input.model) }),
          ...(optionalReasoningEffort(input.reasoning_effort) === undefined
            ? {}
            : { reasoningEffort: optionalReasoningEffort(input.reasoning_effort) }),
          ...(optionalString(input.fork_turns) === undefined ? {} : { forkTurns: optionalString(input.fork_turns) }),
          ...(SubagentCollaboration.modelTokenCap(input.max_total_tokens) === undefined
            ? {}
            : { maxTotalTokens: SubagentCollaboration.modelTokenCap(input.max_total_tokens) }),
        });
        return {
          task_name: result.taskPath,
          thread_id: result.thread.id,
          nickname: result.thread.agentNickname,
        };
      }),
      collaborationTool('send_message', 'Send Subagent Message', async (_itemId, params) => {
        const input = record(params, 'collaboration.send_message');
        return this.sendCollaborationMessage(
          threadId,
          turnId,
          requiredString(input.target, 'target'),
          requiredString(input.message, 'message'),
        );
      }),
      collaborationTool('followup_task', 'Follow Up Subagent', async (itemId, params) => {
        const input = record(params, 'collaboration.followup_task');
        return this.followupCollaborationTask(
          threadId,
          turnId,
          itemId,
          requiredString(input.target, 'target'),
          requiredString(input.message, 'message'),
        );
      }),
      collaborationTool('wait_agent', 'Wait for Subagents', async (_itemId, _params, signal) => {
        return this.waitForCollaborationActivity(
          threadId,
          turnId,
          signal,
        );
      }),
      collaborationTool('list_agents', 'List Subagents', async (_itemId, params) => {
        const input = record(params, 'collaboration.list_agents');
        return this.listCollaborationAgents(threadId, optionalString(input.path_prefix));
      }),
      collaborationTool('interrupt_agent', 'Interrupt Subagent', async (_itemId, params) => {
        const input = record(params, 'collaboration.interrupt_agent');
        return this.interruptCollaborationAgent(
          threadId,
          turnId,
          requiredString(input.target, 'target'),
        );
      }),
    ];
  }
  materializePendingActivityItems(threadId: ThreadId, turnId: TurnId, activities: readonly PendingSubagentActivity[]): ThreadItem[] {
    return activities.map((activity) => subagentActivityItem(threadId, turnId, activity));
  }
  async spawnChild(input: SpawnChildThreadInput): Promise<SpawnChildThreadResult> {
      this.turnLifecycle.requireActiveTurn(input.parentThreadId, input.parentTurnId);
      const tokenCap = this.childTokenCap(input.maxTotalTokens);
      // Read unconditionally: the request's grant is the runtime default even
      // when THIS spawn carries a cap. Skipping the read for a capped spawn
      // opened the request unbounded, and every later uncapped child in the same
      // Turn inherited that — the breaker silently never fired.
      const configuredPoolBudget = await this.configuredPoolBudget();
      let stagedThreadId: ThreadId | null = null;
      let result: SpawnChildThreadResult;
      try {
        result = await this.core.threadTreeMutex.run(async () => {
          let createdPoolId: SubagentRequestPoolId | null = null;
          let createdCappedPoolId: SubagentRequestPoolId | null = null;
          let createdMemberThreadId: ThreadId | null = null;
          try {
            if (this.core.stoppingThreads.has(input.parentThreadId)) throw this.createThreadBusyError('Parent Thread is stopping');
            const parent = this.core.requireThread(input.parentThreadId);
            const collaborationChild = input.childKind !== 'isolatedSkill';
            const nextSpawnCount = collaborationChild ? this.assertSpawnStructure(input.parentThreadId) : null;
            const inheritedBudget = this.turnLifecycle.assertSubagentSpawnBudgetAvailable(
              input.parentThreadId,
              input.parentTurnId,
            );
            const role = this.resolveRole(input.role ?? 'default', parent.thread.cwd);
            const resolvedConfiguration = resolveChildConfiguration(parent.configuration, {
              role,
              ...(input.model === undefined ? {} : { model: input.model }),
              ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
            });
            const toolCeiling = input.allowedTools === undefined ? null : Object.freeze([...new Set(input.allowedTools)]);
            const configuration = this.applyToolCeiling(resolvedConfiguration, toolCeiling);
            const thread = await this.catalog.createThread({
              name: input.displayName ?? input.taskPath.split('/').at(-1) ?? 'Subagent',
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
            const stagedContextEvidence = input.inheritedContext
              ? [await this.copyInheritedContextToChild(input.parentThreadId, thread.id, input.inheritedContext)]
              : [];
            let pool = inheritedBudget?.pool ?? null;
            if (!inheritedBudget?.resolutionFailed) {
              // The request exists whether or not anyone put a number on it:
              // ownership is a property of delegation, and a budget is one
              // optional attribute of the owner. Without this row an unbudgeted
              // delegation would have no identity for Stop to close.
              const requestPoolId = requestPoolIdForTurn(input.parentTurnId);
              if (!pool && !this.subagentBudgets.readPool(requestPoolId)) {
                const request = this.subagentBudgets.createPool({
                  poolId: requestPoolId,
                  scope: 'turn',
                  originThreadId: parent.thread.id,
                  originTurnId: input.parentTurnId,
                  tokenBudget: configuredPoolBudget,
                }, parent.thread.ephemeral);
                createdPoolId = request.poolId;
                if (tokenCap === null) pool = request;
                this.turnLifecycle.refreshActiveSubagentBudgetCoverage();
              } else if (!pool && tokenCap === null) {
                pool = this.subagentBudgets.readPool(requestPoolId);
              }
              // An explicit cap with no inherited pool still anchors its own
              // pool at the child, so the cap keeps bounding that child's own
              // descendants. Its spend binds there; its ownership stays the
              // request, recorded on the member below.
              if (!pool && tokenCap !== null) {
                pool = this.subagentBudgets.createPool({
                  poolId: cappedChildPoolId(thread.id),
                  scope: 'thread',
                  originThreadId: thread.id,
                  originTurnId: input.parentTurnId,
                  tokenBudget: tokenCap,
                }, parent.thread.ephemeral);
                createdCappedPoolId = pool.poolId;
                this.turnLifecycle.refreshActiveSubagentBudgetCoverage();
              }
            }
            // Recorded even with no pool and no cap: the member carries the
            // delegating Turn, so a child spawned before its request had a pool
            // can still join THAT request's pool later, and never a later one's.
            this.subagentBudgets.createMember({
              threadId: thread.id,
              poolId: pool?.poolId ?? null,
              originTurnId: input.parentTurnId,
              tokenCap,
            }, thread.ephemeral);
            createdMemberThreadId = thread.id;
            const accepted = await this.turnLifecycle.acceptAndLaunch({
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
            if (nextSpawnCount !== null) {
              this.subagentBudgets.recordSpawnCount(parent.thread.id, nextSpawnCount, parent.thread.ephemeral);
            }
            return { thread, turn: accepted.response.turn, taskPath: input.taskPath };
          } catch (error) {
            try {
              if (createdMemberThreadId) this.subagentBudgets.deleteMember(createdMemberThreadId);
              if (createdCappedPoolId) this.subagentBudgets.deletePoolRecord(createdCappedPoolId);
              if (createdPoolId) this.subagentBudgets.deletePoolRecord(createdPoolId);
              if (createdPoolId || createdCappedPoolId) this.turnLifecycle.refreshActiveSubagentBudgetCoverage();
            } catch (rollbackError) {
              console.warn('[agent][subagent-budget-audit] failed to roll back staged budget rows', {
                memberThreadId: createdMemberThreadId,
                poolId: createdPoolId,
                cappedPoolId: createdCappedPoolId,
                error: rollbackError,
              });
            }
            throw error;
          }
        });
      } catch (error) {
        if (stagedThreadId) await this.catalog.deleteThread(stagedThreadId).catch(() => undefined);
        throw error;
      }
      // Every delegated form gets a per-child row, not only collaboration: an
      // isolated Skill otherwise runs behind one in-progress `skill` row with no
      // sign that a delegated agent is working and no way in.
      await this.recordSubagentActivity(
        input.parentThreadId,
        input.parentTurnId,
        result.thread.id,
        result.taskPath,
        'started',
        null,
        // The call that delegated: this row stands in for it, so the reader
        // sees one delegation at the position where it was decided.
        input.parentItemId,
      );
      return result;
    }

  private async copyInheritedContextToChild(
      sourceThreadId: ThreadId,
      targetThreadId: ThreadId,
      payload: InheritedContextPayload,
    ): Promise<StagedContextEvidence> {
      const requiredContextRefs = uniqueContextReferences(payload.turns.flatMap((turn) => (
        turn.items.flatMap(itemRequiredContextPayloadReferences)
      )));
      const requiredContextKeys = new Set(requiredContextRefs.map(contextPayloadReferenceKey));
      const toolArgumentRefs = uniqueContextReferences(payload.turns.flatMap((turn) => (
        turn.items.flatMap(itemToolArgumentPayloadReferences)
      )));
      const contextRefs = uniqueContextReferences([...requiredContextRefs, ...toolArgumentRefs]);
      const resourceRefs = uniqueResourceReferences(payload.turns.flatMap((turn) => (
        turn.items.flatMap(itemResourceReferences)
      )));
      const outputRefs = uniqueOutputReferences(payload.turns.flatMap((turn) => (
        turn.items.flatMap(itemOutputReferences)
      )));
      for (const ref of requiredContextRefs) {
        if (!await this.core.payloads.copyContextToThread(sourceThreadId, targetThreadId, ref)) {
          console.warn(`[agent] Child retained unavailable inherited context payload: ${ref.id}`);
        }
      }
      for (const ref of toolArgumentRefs) {
        if (requiredContextKeys.has(contextPayloadReferenceKey(ref))) continue;
        if (!await this.core.payloads.copyContextToThread(sourceThreadId, targetThreadId, ref)) {
          console.warn(`[agent] Child inherited unavailable tool-call arguments: ${ref.id}`);
        }
      }
      for (const ref of resourceRefs) {
        if (!await this.core.payloads.copyResourceToThread(sourceThreadId, targetThreadId, ref)) {
          console.warn(`[agent] Child retained unavailable inherited managed resource: ${ref.id}`);
        }
      }
      for (const ref of outputRefs) {
        if (!await this.core.payloads.copyTextToThread(sourceThreadId, targetThreadId, ref)) {
          console.warn(`[agent] Child inherited unavailable tool output: ${ref.id}`);
        }
      }
      const payloadRef = await this.core.payloads.writeContext(targetThreadId, payload);
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
      this.turnLifecycle.requireActiveTurn(input.parentThreadId, input.parentTurnId);
      const parentPath = this.taskPathForThread(input.parentThreadId) ?? '/root';
      const taskName = isolatedSkillTaskName(input.skillName, isolatedSkillIdentity(uuidV7(this.now())));
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
      this.turnLifecycle.requireActiveTurn(input.senderThreadId, input.senderTurnId);
      if (!/^[a-z][a-z0-9_]*$/.test(input.taskName)) {
        throw new Error('Subagent task_name must use lowercase letters, digits, and underscores');
      }
      const parentPath = this.taskPathForThread(input.senderThreadId) ?? '/root';
      const taskPath = `${parentPath}/${input.taskName}`;
      const sessionId = this.core.requireThread(input.senderThreadId).thread.sessionId;
      if (this.findSpawnEdgeByPath(sessionId, taskPath)) throw new Error(`Subagent task path already exists: ${taskPath}`);
      const inheritedContext = await collaborationInheritedContext({
        turns: this.core.allTurns(input.senderThreadId),
        sourceThreadId: input.senderThreadId,
        activeTurnId: input.senderTurnId,
        spawnItemId: input.parentItemId,
        forkTurns: input.forkTurns,
        readContext: (ref) => this.core.payloads.readContext(input.senderThreadId, ref),
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
  private static modelTokenCap(value: unknown): number | undefined {
      if (value === undefined) return undefined;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new Error('max_total_tokens must be a positive integer');
      }
      return value < MIN_SUBAGENT_TOKEN_CAP ? undefined : value;
    }
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
  private assertSpawnStructure(parentThreadId: ThreadId): number {
      const parentTaskPath = this.taskPathForThread(parentThreadId) ?? '/root';
      const parentDepth = parentTaskPath.split('/').filter(Boolean).length - 1;
      if (parentDepth >= MAX_SUBAGENT_DEPTH) throw new SubagentDepthLimitError(MAX_SUBAGENT_DEPTH);
      const persistentCount = this.core.metadata.childEdges(parentThreadId)
        .filter((edge) => this.core.requireThread(edge.childThreadId).thread.source === 'collaboration')
        .length;
      const ephemeralCount = this.ephemeralChildThreadIds(parentThreadId)
        .filter((threadId) => this.core.requireThread(threadId).thread.source === 'collaboration')
        .length;
      const spawnCount = Math.max(
        this.subagentBudgets.readSpawnCount(parentThreadId),
        persistentCount + ephemeralCount,
      );
      if (spawnCount >= MAX_SUBAGENT_SPAWNS_PER_THREAD) {
        throw new SubagentSpawnLimitError(MAX_SUBAGENT_SPAWNS_PER_THREAD);
      }
      return spawnCount + 1;
    }
  async sendCollaborationMessage(
      senderThreadId: ThreadId,
      senderTurnId: string,
      target: string,
      message: string,
    ): Promise<CollaborationAgentView> {
      this.turnLifecycle.requireActiveTurn(senderThreadId, senderTurnId);
      const targetThread = this.resolveCollaborationTarget(senderThreadId, target);
      const content = [{ type: 'text' as const, text: nonEmpty(message, 'message') }];
      const activeTurnId = this.turnLifecycle.activeTurnId(targetThread.id);
      if (activeTurnId) {
        await this.turnLifecycle.steerTurn({ threadId: targetThread.id, expectedTurnId: activeTurnId, input: content });
      } else {
        await this.adoptIdleChildIntoDelegatingPool(targetThread.id, senderThreadId, senderTurnId);
        this.turnLifecycle.assertSubagentBudgetAvailable(targetThread.id);
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
      this.turnLifecycle.requireActiveTurn(senderThreadId, senderTurnId);
      const targetThread = this.resolveCollaborationTarget(senderThreadId, target);
      const content = [{ type: 'text' as const, text: nonEmpty(message, 'message') }];
      const activeTurnId = this.turnLifecycle.activeTurnId(targetThread.id);
      if (activeTurnId) {
        await this.turnLifecycle.steerTurn({ threadId: targetThread.id, expectedTurnId: activeTurnId, input: content });
      } else {
        await this.adoptIdleChildIntoDelegatingPool(targetThread.id, senderThreadId, senderTurnId);
        this.turnLifecycle.assertSubagentBudgetAvailable(targetThread.id);
        const queued = this.mailbox.get(targetThread.id) ?? [];
        this.mailbox.delete(targetThread.id);
        try {
          await this.turnLifecycle.startPrivilegedTurn({
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
      const sender = this.core.requireThread(senderThreadId).thread;
      const senderPath = this.taskPathForThread(senderThreadId) ?? '/root';
      const descendantPrefix = `${senderPath}/`;
      const persisted = this.core.metadata.childEdges(rootThreadId(sender, (id) => this.core.requireThread(id).thread), true);
      const ephemeral = [...this.ephemeralSpawnEdges.entries()].map(([childThreadId, edge]) => ({ childThreadId, ...edge }));
      return [...persisted, ...ephemeral]
        .filter((edge) => this.core.requireThread(edge.childThreadId).thread.sessionId === sender.sessionId)
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
      this.turnLifecycle.requireActiveTurn(senderThreadId, senderTurnId);
      const thread = this.resolveCollaborationTarget(senderThreadId, target);
      const activeTurnId = this.turnLifecycle.activeTurnId(thread.id);
      if (activeTurnId !== null) await this.turnLifecycle.interruptTurn(thread.id, activeTurnId);
      return this.collaborationView(thread.id);
    }
  async waitForCollaborationActivity(
      senderThreadId: ThreadId,
      senderTurnId: string,
      signal?: AbortSignal,
    ): Promise<CollaborationWaitResult> {
      this.turnLifecycle.requireActiveTurn(senderThreadId, senderTurnId);
      if (signal?.aborted) throw new Error('Collaboration wait was interrupted');

      // Only collaboration activity can end a wait. Skill activity still flushes
      // into the transcript as rows, but it is not a deliverable outcome here.
      if (this.pendingCollaborationActivityCount(senderThreadId) > 0) {
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
        const updates: CollaborationTerminalOutcome[] = [];
        for (const agent of agents) {
          if (agent.status !== 'completed' && agent.status !== 'interrupted' && agent.status !== 'errored') continue;
          updates.push(await this.collaborationTerminalOutcome(agent.threadId, agent.taskPath, agent.status));
        }
        return { reason: 'idle', updates, agents };
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
      const collaboration = activities.filter((activity) => activity.form === 'collaboration');
      return this.collaborationWaitResult(
        senderThreadId,
        collaboration.length > 0 ? 'terminal' : 'steering',
        activities,
      );
    }
  private pendingCollaborationActivityCount(threadId: ThreadId): number {
      return (this.pendingSubagentActivities.get(threadId) ?? [])
        .filter((activity) => activity.form === 'collaboration')
        .length;
    }
  /**
   * Re-delegating to an idle child is a NEW request, so it joins the pool of the
   * Turn delegating now — the same rule that binds a fresh spawn. This is not
   * orphan migration: a live member is never moved, and this path is reached
   * only once every member of the old pool settled and the pool was reclaimed.
   * Without it a re-driven child would run uncovered, which is the one hole the
   * request-scoped pool could otherwise open.
   */
  private async adoptIdleChildIntoDelegatingPool(
      childThreadId: ThreadId,
      senderThreadId: ThreadId,
      senderTurnId: TurnId,
    ): Promise<void> {
      // A CLOSED request is not live coverage: the user stopped it, and a new
      // delegation is exactly how that child is legitimately re-driven. Without
      // this the stopped request would refuse the child forever.
      if (this.liveRequestFor(childThreadId)) return;
      const configuredPoolBudget = await this.configuredPoolBudget();
      await this.core.threadTreeMutex.run(async () => {
        if (this.liveRequestFor(childThreadId)) return;
        const sender = this.core.requireThread(senderThreadId).thread;
        const inherited = this.turnLifecycle.resolveSubagentSpawnBudget(senderThreadId, senderTurnId);
        if (inherited?.resolutionFailed) return;
        let pool = inherited?.pool ?? null;
        if (!pool) {
          // Opened whether or not a budget is configured, exactly as a spawn
          // does. Bailing out when the default is disabled left the child bound
          // to the CLOSED request it was stopped in, and every later attempt
          // refused — a temporary state made permanent by an unreachable reset.
          pool = this.subagentBudgets.createPool({
            poolId: requestPoolIdForTurn(senderTurnId),
            scope: 'turn',
            originThreadId: senderThreadId,
            originTurnId: senderTurnId,
            tokenBudget: configuredPoolBudget,
          }, sender.ephemeral);
          this.turnLifecycle.refreshActiveSubagentBudgetCoverage();
        }
        const child = this.core.requireThread(childThreadId).thread;
        if (this.subagentBudgets.readMember(childThreadId)) {
          this.subagentBudgets.rebindMemberPool(childThreadId, pool.poolId, senderTurnId);
        } else {
          this.subagentBudgets.createMember({
            threadId: childThreadId,
            poolId: pool.poolId,
            originTurnId: senderTurnId,
            tokenCap: null,
          }, child.ephemeral);
        }
      });
    }
  private liveRequestFor(threadId: ThreadId): boolean {
      const pool = this.turnLifecycle.resolveSubagentBudget(threadId)?.pool;
      return Boolean(pool && pool.closedAt === null);
    }
  private taskPathForThread(threadId: ThreadId): string | null { return this.ephemeralSpawnEdges.get(threadId)?.taskPath
        ?? this.core.metadata.spawnEdgeForChild(threadId)?.taskPath
        ?? null; }
  private findSpawnEdgeByPath(
      sessionId: string,
      taskPath: string,
    ): { childThreadId: ThreadId; taskPath: string } | null {
      const persisted = this.core.metadata.spawnEdgeForPath(sessionId, taskPath);
      if (persisted) return persisted;
      for (const [childThreadId, edge] of this.ephemeralSpawnEdges) {
        if (edge.sessionId === sessionId && edge.taskPath === taskPath) return { childThreadId, taskPath };
      }
      return null;
    }
  private resolveCollaborationTarget(senderThreadId: ThreadId, targetInput: string): Thread {
      const target = nonEmpty(targetInput, 'target');
      const sender = this.core.requireThread(senderThreadId).thread;
      const senderPath = this.taskPathForThread(senderThreadId) ?? '/root';
      const path = target.startsWith('/') ? target : `${senderPath}/${target}`;
      const edge = this.findSpawnEdgeByPath(sender.sessionId, path);
      if (!edge) throw new Error(`Subagent task path not found: ${target}`);
      const thread = this.core.requireThread(edge.childThreadId).thread;
      if (thread.sessionId !== sender.sessionId) throw new Error('Subagent target is outside the current Thread tree');
      if (!this.isCollaborationDescendant(senderThreadId, thread.id)) {
        throw new Error('Subagent target is outside the sender collaboration subtree');
      }
      return thread;
    }
  private isCollaborationDescendant(senderThreadId: ThreadId, childThreadId: ThreadId): boolean {
      const visited = new Set<ThreadId>();
      let current = this.core.requireThread(childThreadId).thread;
      while (current.parentThreadId !== null && !visited.has(current.id)) {
        visited.add(current.id);
        if (current.source !== 'collaboration') return false;
        if (current.parentThreadId === senderThreadId) return true;
        current = this.core.requireThread(current.parentThreadId).thread;
      }
      return false;
    }
  private collaborationView(threadId: ThreadId): CollaborationAgentView {
      const thread = this.core.requireThread(threadId).thread;
      const edge = this.ephemeralSpawnEdges.get(threadId) ?? this.core.metadata.spawnEdgeForChild(threadId);
      if (!edge || !thread.parentThreadId) throw new Error(`Thread is not a Subagent: ${threadId}`);
      const budget = this.turnLifecycle.subagentBudgetView(threadId);
      const latest = this.core.allTurns(threadId).at(-1);
      const status: CollaborationAgentView['status'] = this.turnLifecycle.activeTurnId(threadId) !== null
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
  private async collaborationWaitResult(
      senderThreadId: ThreadId,
      reason: CollaborationWaitResult['reason'],
      activities: readonly PendingSubagentActivity[],
    ): Promise<CollaborationWaitResult> {
      const updates: CollaborationTerminalOutcome[] = [];
      for (const activity of activities) {
        // An isolated Skill child is absent from this channel by contract: its
        // `skill` tool call is the single parent-facing owner of its outcome,
        // and replaying it here would offer the same work twice.
        if (activity.form !== 'collaboration') continue;
        if (activity.kind === 'started') continue;
        updates.push(await this.collaborationTerminalOutcome(
          activity.agentThreadId,
          activity.agentPath,
          activity.kind === 'errored' ? 'errored' : activity.kind,
          activity.agentTurnId,
        ));
      }
      return {
        reason,
        updates,
        agents: this.listCollaborationAgents(senderThreadId),
      };
    }
  private async collaborationTerminalOutcome(
      threadId: ThreadId,
      taskPath: string,
      status: CollaborationTerminalOutcome['status'],
      turnId?: TurnId,
    ): Promise<CollaborationTerminalOutcome> {
      // A queued activity names its Turn, so read that one Turn rather than
      // paging the child's whole history on the parent's wait path.
      const terminalTurn = turnId === undefined
        ? this.core.allTurns(threadId).at(-1)
        : this.core.readTurn(threadId, turnId);
      const result = terminalTurn ? turnTerminalAnswer(terminalTurn.items) : '';
      return {
        taskPath,
        threadId,
        status,
        result: result || null,
        error: terminalTurn?.error?.message ?? null,
        transcriptPath: await this.transcripts.pathForReader(threadId),
      };
    }

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
      agentPath: string,
      kind: PendingSubagentActivity['kind'],
      error: Turn['error'],
      spawnItemId: string | null,
    ): Promise<void> {
      await this.turnLifecycle.recordSubagentActivity(
        ownerThreadId,
        ownerTurnId,
        agentThreadId,
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
      const queued = this.pendingSubagentActivities.get(thread.parentThreadId) ?? [];
      queued.push({ agentThreadId: thread.id, agentTurnId: turn.id, agentPath, kind, error: turn.error, form });
      this.pendingSubagentActivities.set(thread.parentThreadId, queued);
      // An isolated Skill is absent from `wait_agent` by contract, so its
      // terminal transition must not wake a parent blocked on collaboration
      // children — the `skill` call that is already awaiting it owns its outcome.
      if (form === 'collaboration') this.signalCollaborationActivity(thread.parentThreadId);
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
        state = { pending: false, waiters: new Set() };
        this.collaborationActivity.set(threadId, state);
      }
      return state;
    }
  signalCollaborationActivity(threadId: ThreadId): void {
      const state = this.collaborationActivityState(threadId);
      state.pending = true;
      for (const resolve of [...state.waiters]) resolve();
    }
  takePendingCollaborationActivity(threadId: ThreadId): boolean {
      const state = this.collaborationActivity.get(threadId);
      if (!state?.pending) return false;
      state.pending = false;
      return true;
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
    const selected = turns.slice(start);
    const [skills, roles] = await Promise.all([
      reduceSkillContext(selected, readContext),
      reduceRoleContext(selected, readContext),
    ]);
    const kind = skills.degradations.some((entry) => (
      entry.code === 'journalDiscontinuity' && entry.source === 'skillCatalog'
    ))
      ? 'skillCatalog' as const
      : roles.degradations.some((entry) => (
          entry.code === 'journalDiscontinuity' && entry.source === 'roleCatalog'
        ))
        ? 'roleCatalog' as const
        : null;
    if (start === 0 || kind === null) return start;
    const preceding = previousCatalogStateTurn(turns, start, kind);
    if (preceding < 0) return start;
    start = expandForCompactionCursors(turns, preceding);
  }
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

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be non-empty`);
  return normalized;
}

function collaborationTool(
  name: string,
  label: string,
  execute: (itemId: string, params: unknown, signal?: AbortSignal) => unknown | Promise<unknown>,
): AgentTool {
  const canonical = `collaboration.${name}`;
  const contract = modelToolContract(canonical);
  if (!contract?.inputSchema) throw new Error(`Missing Core model-tool contract: ${canonical}`);
  return {
    name: `collaboration__${name}`,
    label,
    description: contract.description,
    parameters: contract.inputSchema as TSchema,
    executionMode: 'sequential',
    execute: async (itemId, params, signal) => toolResult(await execute(itemId, params, signal)),
  };
}

function toolResult(value: unknown): AgentToolResult<JsonValue> {
  const details = jsonValue(value);
  return {
    content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalReasoningEffort(value: unknown): ReasoningEffort | undefined {
  const normalized = optionalString(value);
  if (!normalized) return undefined;
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(normalized)) {
    throw new Error(`Unknown reasoning_effort: ${normalized}`);
  }
  return normalized as ReasoningEffort;
}

function jsonValue(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
  } catch {
    return String(value);
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
    agentPath: activity.agentPath,
    error: activity.error,
    // Materialized from the queue, so this is always a terminal activity: see
    // the flush path for why those claim nothing.
    spawnItemId: null,
  };
}
