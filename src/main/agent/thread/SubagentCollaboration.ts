import type { TSchema } from 'typebox';
import { resolveChildConfiguration,type AgentRole,type EffectiveThreadConfiguration,type ReasoningEffort } from '../../../core/agent/configuration';
import type { ContextCursor,ContextEvidenceKind,InheritedContextPayload,JsonValue,Thread,ThreadContextPayload,ThreadContextPayloadReference,ThreadId,ThreadItem,ThreadItemOutputReference,ThreadResourceReference,ThreadUserContent,Turn,TurnId } from '../../../core/agent/protocol';
import { modelToolContract } from '../../../core/agent/tools';
import { contextPayloadReferenceKey,itemContextPayloadReferences,itemOutputReferences,itemResourceReferences,outputReferenceKey,resourceReferenceKey } from '../context/contextDependencies';
import { cursorFor } from '../context/ContextEpoch';
import { reduceRoleContext } from '../context/RoleContextReducer';
import { reduceSkillContext } from '../context/SkillContextReducer';
import {
  MAX_SUBAGENT_DEPTH,
  MAX_SUBAGENT_SPAWNS_PER_THREAD,
  type SubagentBudgetLedger,
} from '../persistence/SubagentBudgetLedger';
import type { AgentTool,AgentToolResult } from '../runtime/kernel/types';
import { SubagentDepthLimitError,SubagentSpawnLimitError } from '../SubagentStructuralLimitError';
import type { CollaborationAgentView,CollaborationTerminalOutcome,CollaborationWaitResult,SpawnChildThreadInput,SpawnChildThreadResult,SpawnIsolatedSkillThreadInput } from '../ThreadService';
import { uuidV7 } from '../uuid';
import { appendSubagentTranscript,rebuildSubagentTranscript,removeSubagentTranscript,subagentTranscriptPath,subagentTranscriptSize,sweepOrphanTranscripts } from './SubagentTranscriptArtifact';
import type { ThreadCatalogOps } from './ThreadCatalogOps';
import { ThreadCore } from './ThreadCore';
import { renderTranscript,renderTurn,type TranscriptPayloadReader } from './TranscriptRenderer';
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
}
/**
 * Ceiling on any filesystem wait the account layer puts in front of a delegator.
 * Long enough that an ordinary slow volume still answers accurately, short enough
 * that a wedged one is a hiccup rather than a parked Turn.
 */
const TRANSCRIPT_READY_TIMEOUT_MS = 2_000;

interface TranscriptCursor {
  readonly turns: number;
  readonly bytes: number;
  /** Every Turn already in the file — not just the last, so a rebuild dedups what is queued behind it. */
  readonly turnIds: ReadonlySet<TurnId>;
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
  /** Per child: how much of its account is already on disk. Compared against the file, never trusted alone. */
  private readonly transcriptCursors = new Map<ThreadId, TranscriptCursor>();
  /** Per child: the tail of its serialized append chain, so Turns land in order and deletion can drain it. */
  private readonly transcriptWrites = new Map<ThreadId, Promise<void>>();
  /** Children whose artifact was deleted. Thread ids are never reused, so this only ever grows by real deletions. */
  private readonly discardedTranscripts = new Set<ThreadId>();
  constructor(
    private readonly core: ThreadCore,
    private readonly catalog: SubagentCatalog,
    private readonly turnLifecycle: TurnLifecycle,
    private readonly subagentBudgets: SubagentBudgetLedger,
    private readonly resolveRole: (name: string, cwd: string) => AgentRole,
    private readonly resolveSubagentTokenBudget: () => Promise<number | null>,
    private readonly now: () => number,
    private readonly applyToolCeiling: (configuration: EffectiveThreadConfiguration, toolCeiling: readonly string[] | null) => EffectiveThreadConfiguration,
    private readonly createThreadBusyError: (message: string) => Error,
    private readonly transcriptRoot: string,
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
      this.transcriptCursors.delete(threadId);
      // `transcriptWrites` is deliberately NOT cleared here: deletion drains it
      // after this teardown runs, and a chain removed early cannot be drained.
      // The chain removes its own entry when it settles.
    }
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
          ...(input.max_total_tokens === undefined ? {} : { maxTotalTokens: input.max_total_tokens as number }),
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
      let stagedThreadId: ThreadId | null = null;
      let createdPoolThreadId: ThreadId | null = null;
      let result: SpawnChildThreadResult;
      try {
        result = await this.core.threadTreeMutex.run(async () => {
        if (this.core.stoppingThreads.has(input.parentThreadId)) throw this.createThreadBusyError('Parent Thread is stopping');
        const parent = this.core.requireThread(input.parentThreadId);
        const collaborationChild = input.childKind !== 'isolatedSkill';
        const nextSpawnCount = collaborationChild ? this.assertSpawnStructure(input.parentThreadId) : null;
        const inheritedBudget = this.turnLifecycle.assertSubagentSpawnBudgetAvailable(input.parentThreadId);
        const role = this.resolveRole(input.role ?? 'default', parent.thread.cwd);
        const resolvedConfiguration = resolveChildConfiguration(parent.configuration, {
          role,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
        });
        const toolCeiling = input.allowedTools === undefined ? null : Object.freeze([...new Set(input.allowedTools)]);
        const configuration = this.applyToolCeiling(resolvedConfiguration, toolCeiling);
        const thread = await this.catalog.createThread({
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
        let pool = inheritedBudget?.pool ?? null;
        if (!pool && !inheritedBudget?.resolutionFailed) {
          const poolBudget = tokenCap ?? await this.configuredPoolBudget();
          if (poolBudget !== null) {
            const poolThreadId = tokenCap === null ? parent.thread.id : thread.id;
            pool = this.subagentBudgets.createPool(poolThreadId, poolBudget, parent.thread.ephemeral);
            createdPoolThreadId = poolThreadId;
            this.turnLifecycle.refreshActiveSubagentBudgetCoverage();
          }
        }
        if (pool || tokenCap !== null) {
          this.subagentBudgets.createMember(thread.id, pool?.poolThreadId ?? null, tokenCap, thread.ephemeral);
        }
        const stagedContextEvidence = input.inheritedContext
          ? [await this.copyInheritedContextToChild(input.parentThreadId, thread.id, input.inheritedContext)]
          : [];
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
        });
      } catch (error) {
        if (stagedThreadId) await this.catalog.deleteThread(stagedThreadId).catch(() => undefined);
        if (createdPoolThreadId) {
          try {
            this.subagentBudgets.deletePool(createdPoolThreadId);
          } catch (rollbackError) {
            console.warn('[agent][subagent-budget-audit] failed to roll back a staged pool', {
              poolThreadId: createdPoolThreadId,
              error: rollbackError,
            });
          }
        }
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
        if (!await this.core.payloads.copyContextToThread(sourceThreadId, targetThreadId, ref)) {
          throw new Error(`Missing inherited context payload: ${ref.id}`);
        }
      }
      for (const ref of resourceRefs) {
        if (!await this.core.payloads.copyResourceToThread(sourceThreadId, targetThreadId, ref)) {
          throw new Error(`Missing inherited managed resource: ${ref.id}`);
        }
      }
      for (const ref of outputRefs) {
        if (!await this.core.payloads.copyTextToThread(sourceThreadId, targetThreadId, ref)) {
          throw new Error(`Missing inherited tool output: ${ref.id}`);
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
      return this.collaborationWaitResult(
        senderThreadId,
        activities.length > 0 ? 'terminal' : 'steering',
        activities,
      );
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
        transcriptPath: await this.transcriptPathForReader(threadId),
      };
    }

  /**
   * The account layer is written where a completed Turn already exists, never
   * here: `wait_agent` renders nothing and only resolves whether the artifact is
   * on disk. It waits for the child's append chain so a Turn that just completed
   * is durable before its path is reported.
   *
   * Every wait is DEADLINE-BOUNDED. A12 protects against a throwing filesystem,
   * but not against a wedged one — an fs promise that never settles would park
   * the parent's Turn forever, which is precisely the failure mode A12 exists to
   * prevent. On timeout the in-session cursor decides: if this process appended a
   * Turn, the artifact exists and the path is reported anyway; otherwise null.
   * A stalled volume then costs the account layer accuracy, never the delegator
   * its result (A12), and never more than the deadline in latency (A9).
   */
  async transcriptPathForReader(threadId: ThreadId): Promise<string | null> {
      try {
        const path = subagentTranscriptPath(this.transcriptRoot, threadId);
        await settledWithin(this.transcriptWrites.get(threadId), TRANSCRIPT_READY_TIMEOUT_MS);
        // A Turn appended in this process is known to be on disk: no stat needed
        // on the common path, which is also the one a parent waits on.
        if (this.transcriptCursors.has(threadId)) return path;
        const size = await withDeadline(
          subagentTranscriptSize(path),
          TRANSCRIPT_READY_TIMEOUT_MS,
          null,
        );
        return size === null ? null : path;
      } catch (error) {
        console.warn(`[agent] Subagent transcript artifact was not resolved for ${threadId}`, error);
        return null;
      }
    }

  /**
   * Serialize per child so Turns append in completion order, and so deletion has
   * one handle to drain. The chain never rejects: `appendTranscriptTurn` owns
   * the A12 guard, and this is deliberately not awaited by the Turn that
   * produced it.
   */
  private enqueueTranscriptTurn(thread: Thread, turn: Turn): void {
      if (!thread.parentThreadId) return;
      const pending = (this.transcriptWrites.get(thread.id) ?? Promise.resolve())
        .then(() => this.appendTranscriptTurn(thread, turn));
      this.transcriptWrites.set(thread.id, pending);
      void pending.finally(() => {
        if (this.transcriptWrites.get(thread.id) === pending) this.transcriptWrites.delete(thread.id);
      });
    }

  /**
   * Extend the child's account by exactly the Turn that just completed.
   *
   * A completed Turn is immutable, so appending is monotonic and never rewrites
   * what a reader may already be reading. That is what dissolves both staleness
   * (nothing cached can go stale — history is never re-rendered) and write
   * atomicity (a concurrent read sees a whole-Turn prefix, never a torn file).
   *
   * A12 covers the WHOLE body, reads included: a spawn-edge or store read that
   * throws here must not escape into the Turn that produced it.
   */
  private async appendTranscriptTurn(thread: Thread, turn: Turn): Promise<void> {
      try {
        // Scoped to DELETION, not to any subtree stop. Stop and archive keep the
        // artifact, and the Turn they interrupt is the child's last one — skipping
        // it would leave a retained transcript ending mid-task while the store
        // says interrupted, with no later Turn to heal it.
        if (this.discardedTranscripts.has(thread.id)) return;
        if (!this.taskPathForThread(thread.id)) return;
        const path = subagentTranscriptPath(this.transcriptRoot, thread.id);
        const cursor = this.transcriptCursors.get(thread.id);
        // Membership, not "was it the last one": a rebuild folds in EVERY
        // completed Turn, so Turns still queued behind it are already on disk
        // and re-appending them would duplicate blocks under wrong ordinals.
        if (cursor?.turnIds.has(turn.id)) return;
        const size = cursor ? await subagentTranscriptSize(path) : null;
        // Cold cursor, a removed file, or bytes that disagree with what we
        // appended: rebuild once, atomically, and resume appending from there.
        if (!cursor || size !== cursor.bytes) {
          await this.rebuildTranscript(thread, path);
          return;
        }
        const text = await renderTurn(turn, this.transcriptReader(thread.id), {
          detail: 'brief',
          ordinal: cursor.turns + 1,
        });
        await appendSubagentTranscript(path, text);
        this.transcriptCursors.set(thread.id, {
          turns: cursor.turns + 1,
          bytes: cursor.bytes + Buffer.byteLength(text),
          turnIds: new Set(cursor.turnIds).add(turn.id),
        });
      } catch (error) {
        console.warn(`[agent] Subagent transcript Turn was not appended for ${thread.id}`, error);
      }
    }

  private async rebuildTranscript(thread: Thread, path: string): Promise<void> {
      const turns = this.core.allTurns(thread.id).filter((turn) => turn.status !== 'inProgress');
      const text = await renderTranscript(turns, this.transcriptReader(thread.id), {
        detail: 'brief',
        subject: {
          threadId: thread.id,
          taskPath: this.taskPathForThread(thread.id),
          parentThreadId: thread.parentThreadId,
          role: thread.agentRole,
          nickname: thread.agentNickname,
          cwd: thread.cwd,
        },
      });
      await rebuildSubagentTranscript(path, text);
      this.transcriptCursors.set(thread.id, {
        turns: turns.length,
        bytes: Buffer.byteLength(text),
        turnIds: new Set(turns.map((turn) => turn.id)),
      });
    }

  /**
   * Best-effort removal from the Thread-deletion descendant cascade.
   *
   * The order is the whole point. Mark the Thread discarded FIRST so nothing new
   * enqueues, then drain the append chain so an append already past its guard and
   * awaiting payload reads finishes BEFORE the `rm` — otherwise it lands behind
   * the removal and resurrects a transcript the user deleted. This owns the chain
   * entry's removal for the same reason: clearing it elsewhere first would leave
   * this draining `undefined`, which is a no-op wearing a drain's clothes.
   */
  async deleteTranscriptArtifact(threadId: ThreadId): Promise<void> {
      this.discardedTranscripts.add(threadId);
      try {
        await settledWithin(this.transcriptWrites.get(threadId), TRANSCRIPT_READY_TIMEOUT_MS);
        this.transcriptWrites.delete(threadId);
        this.transcriptCursors.delete(threadId);
        await removeSubagentTranscript(subagentTranscriptPath(this.transcriptRoot, threadId));
      } catch (error) {
        console.warn(`[agent] Subagent transcript artifact was not removed for ${threadId}`, error);
      }
    }

  /** Startup reclamation of transcripts whose Thread no longer exists. */
  async sweepOrphanTranscripts(isKnownThread: (threadId: ThreadId) => boolean): Promise<readonly string[]> {
      try {
        return await sweepOrphanTranscripts(this.transcriptRoot, isKnownThread);
      } catch (error) {
        console.warn('[agent] Subagent transcript orphan sweep failed', error);
        return [];
      }
    }

  /** Test seam: settle the child's pending appends. */
  async flushTranscriptWrites(threadId: ThreadId): Promise<void> {
      await this.transcriptWrites.get(threadId);
    }

  private transcriptReader(threadId: ThreadId): TranscriptPayloadReader {
      return {
        readOutput: (ref) => this.core.payloads.readTextReference(threadId, ref),
        readDiagnostics: (ref) => this.core.payloads.readTurnDiagnostics(threadId, ref),
      };
    }

  private async recordSubagentActivity(
      ownerThreadId: ThreadId,
      ownerTurnId: string,
      agentThreadId: ThreadId,
      agentPath: string,
      kind: PendingSubagentActivity['kind'],
    ): Promise<void> {
      await this.turnLifecycle.recordSubagentActivity(
        ownerThreadId,
        ownerTurnId,
        agentThreadId,
        agentPath,
        kind,
        this.now(),
      );
    }
  queueChildTurnActivity(thread: Thread, turn: Turn): void {
      // Every delegated form gets an account, so the append runs before the
      // collaboration-only activity queueing below: an isolated-Skill child is
      // not a `collaboration` source but is owed the same transcript.
      this.enqueueTranscriptTurn(thread, turn);
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

/**
 * Resolve with `fallback` if `work` has not settled in time. A rejection is the
 * caller's to handle; a promise that NEVER settles is the case this exists for.
 */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Await a bounded settle, treating "no chain" and "timed out" alike. */
async function settledWithin(work: Promise<unknown> | undefined, timeoutMs: number): Promise<void> {
  if (work === undefined) return;
  await withDeadline(work.then(() => undefined, () => undefined), timeoutMs, undefined);
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
  };
}
