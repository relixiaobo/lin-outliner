import { resolveChildConfiguration,type AgentRole,type EffectiveThreadConfiguration } from '../../../core/agent/configuration';
import type { ContextCursor,ContextEvidenceKind,InheritedContextPayload,PrivilegedTurnStartRequest,Thread,ThreadContextPayload,ThreadContextPayloadReference,ThreadId,ThreadItem,ThreadItemOutputReference,ThreadResourceReference,ThreadUserContent,Turn,TurnId,TurnStartResponse,TurnSteerRequest,TurnSteerResponse } from '../../../core/agent/protocol';
import { contextPayloadReferenceKey,itemContextPayloadReferences,itemOutputReferences,itemResourceReferences,outputReferenceKey,resourceReferenceKey } from '../context/contextDependencies';
import { cursorFor } from '../context/ContextEpoch';
import { reduceRoleContext } from '../context/RoleContextReducer';
import { reduceSkillContext } from '../context/SkillContextReducer';
import type { SubagentBudgetLedger,SubagentBudgetRecord } from '../persistence/SubagentBudgetLedger';
import type { CollaborationAgentView,CollaborationTerminalOutcome,CollaborationWaitResult,SpawnChildThreadInput,SpawnChildThreadResult,SpawnIsolatedSkillThreadInput } from '../ThreadService';
import { uuidV7 } from '../uuid';
import type { ThreadCatalogOps } from './ThreadCatalogOps';
import { ThreadCore } from './ThreadCore';

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
interface CollaborationActivityState {
  pending: boolean;
  readonly waiters: Set<() => void>;
}
export interface SubagentTurnLifecycle {
  assertActiveTurn(threadId: ThreadId, turnId: string): void;
  activeTurnId(threadId: ThreadId): string | null;
  assertSubagentBudgetAvailable(threadId: ThreadId): SubagentBudgetRecord | null;
  acceptAndLaunch(request: PrivilegedTurnStartRequest & { readonly stagedContextEvidence?: readonly StagedContextEvidence[] }): Promise<{ readonly response: TurnStartResponse }>;
  startPrivilegedTurn(request: PrivilegedTurnStartRequest): Promise<TurnStartResponse>;
  steerTurn(request: TurnSteerRequest): Promise<TurnSteerResponse>;
  interruptTurn(threadId: ThreadId, turnId: string): Promise<void>;
  recordSubagentActivity(ownerThreadId: ThreadId, ownerTurnId: string, agentThreadId: ThreadId, agentPath: string, kind: PendingSubagentActivity['kind'], completedAt: number): Promise<void>;
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
    private readonly catalog: SubagentCatalog,
    private readonly turnLifecycle: SubagentTurnLifecycle,
    private readonly subagentBudgets: SubagentBudgetLedger,
    private readonly resolveRole: (name: string, cwd: string) => AgentRole,
    private readonly resolveSubagentTokenBudget: () => Promise<number | null>,
    private readonly now: () => number,
    private readonly applyToolCeiling: (configuration: EffectiveThreadConfiguration, toolCeiling: readonly string[] | null) => EffectiveThreadConfiguration,
    private readonly createThreadBusyError: (message: string) => Error,
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
    }
  }
  pendingActivities(threadId: ThreadId): readonly PendingSubagentActivity[] {
    return [...(this.pendingSubagentActivities.get(threadId) ?? [])];
  }
  hasPendingActivities(threadId: ThreadId): boolean {
    return this.pendingSubagentActivities.has(threadId);
  }
  materializePendingActivityItems(threadId: ThreadId, turnId: TurnId, activities: readonly PendingSubagentActivity[]): ThreadItem[] {
    return activities.map((activity) => subagentActivityItem(threadId, turnId, activity));
  }
  async spawnChild(input: SpawnChildThreadInput): Promise<SpawnChildThreadResult> {
      this.turnLifecycle.assertActiveTurn(input.parentThreadId, input.parentTurnId);
      const parentBudget = this.turnLifecycle.assertSubagentBudgetAvailable(input.parentThreadId);
      const tokenBudget = await this.childTokenBudget(input.maxTotalTokens, parentBudget);
      let stagedThreadId: ThreadId | null = null;
      let result: SpawnChildThreadResult;
      try {
        result = await this.core.threadTreeMutex.run(async () => {
        if (this.core.stoppingThreads.has(input.parentThreadId)) throw this.createThreadBusyError('Parent Thread is stopping');
        const parent = this.core.requireThread(input.parentThreadId);
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
        if (tokenBudget !== null) {
          this.subagentBudgets.create(thread.id, tokenBudget, thread.ephemeral);
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
        return { thread, turn: accepted.response.turn, taskPath: input.taskPath };
        });
      } catch (error) {
        if (stagedThreadId) await this.catalog.deleteThread(stagedThreadId).catch(() => undefined);
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
      this.turnLifecycle.assertActiveTurn(input.parentThreadId, input.parentTurnId);
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
      this.turnLifecycle.assertActiveTurn(input.senderThreadId, input.senderTurnId);
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
  async sendCollaborationMessage(
      senderThreadId: ThreadId,
      senderTurnId: string,
      target: string,
      message: string,
    ): Promise<CollaborationAgentView> {
      this.turnLifecycle.assertActiveTurn(senderThreadId, senderTurnId);
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
      this.turnLifecycle.assertActiveTurn(senderThreadId, senderTurnId);
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
      this.turnLifecycle.assertActiveTurn(senderThreadId, senderTurnId);
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
      this.turnLifecycle.assertActiveTurn(senderThreadId, senderTurnId);
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
      const budget = this.subagentBudgets.read(threadId);
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
