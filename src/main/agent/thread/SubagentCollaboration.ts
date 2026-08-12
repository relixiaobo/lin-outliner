import type { TSchema } from 'typebox';
import { resolveChildConfiguration,type AgentRole,type EffectiveThreadConfiguration } from '../../../core/agent/configuration';
import type { ContextCursor,ContextEvidenceKind,InheritedContextPayload,JsonValue,Thread,ThreadContextPayload,ThreadContextPayloadReference,ThreadId,ThreadItem,ThreadItemOutputReference,ThreadResourceReference,ThreadUserContent,Turn,TurnId } from '../../../core/agent/protocol';
import {
  AGENT_MESSAGE_INPUT_SCHEMA,
  agentInputSchema,
  modelToolContract,
  normalizeAgentMessageToolInput,
  normalizeAgentToolInput,
} from '../../../core/agent/tools';
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
  DEFAULT_MAX_CONCURRENT_SUBAGENTS,
  MAX_SUBAGENT_DEPTH,
  MIN_SUBAGENT_TOKEN_CAP,
  requestPoolIdForTurn,
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
import { filterSubagentToolKeys } from '../capabilities/subagentToolPolicy';
import type { AgentWorktreeMetadata } from '../worktree/AgentWorktree';
import type { AgentTool,AgentToolResult } from '../runtime/kernel/types';
import { SubagentDepthLimitError,SubagentSpawnLimitError } from '../SubagentStructuralLimitError';
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

interface AgentSpawnResult {
  readonly agentId: ThreadId;
  readonly runMode: 'foreground' | 'background';
  readonly report: string | null;
  readonly usage: string | null;
  readonly outputFile: string | null;
}

export class SubagentCollaboration {
  private readonly ephemeralSpawnEdges = new Map<ThreadId, { sessionId: string; parentThreadId: ThreadId; taskPath: string; createdAt: number }>();
  private readonly pendingSubagentActivities = new Map<ThreadId, PendingSubagentActivity[]>();
  private readonly collaborationActivity = new Map<ThreadId, CollaborationActivityState>();
  private readonly terminalPipelines = new Map<string, Promise<void>>();
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
    private readonly prepareAgentWorktree: ((input: {
      readonly agentId: ThreadId;
      readonly cwd: string;
      readonly worktree: AgentWorktreeMetadata | null;
    }) => Promise<{ readonly cwd: string; readonly worktree: AgentWorktreeMetadata }>) | undefined,
    private readonly settleAgentWorktree: ((worktree: AgentWorktreeMetadata) => Promise<{
      readonly worktree: AgentWorktreeMetadata;
      readonly retained: boolean;
    }>) | undefined,
    private readonly now: () => number,
    private readonly applyToolCeiling: (configuration: EffectiveThreadConfiguration, toolCeiling: readonly string[] | null) => EffectiveThreadConfiguration,
    private readonly createThreadBusyError: (message: string) => Error,
    private readonly transcripts: ThreadTranscriptWriter,
  ) {}
  execution(threadId: ThreadId): SubagentExecutionRecord | null {
    return this.executions.read(threadId);
  }
  worktreeForThread(threadId: ThreadId): AgentWorktreeMetadata | null {
    let current = this.core.requireThread(threadId).thread;
    const visited = new Set<ThreadId>();
    while (!visited.has(current.id)) {
      visited.add(current.id);
      const worktree = this.executions.read(current.id)?.worktree ?? null;
      if (worktree?.removedAt === null) {
        if (current.cwd !== worktree.path) {
          throw new Error(`Agent worktree cwd mismatch: ${current.id}`);
        }
        return worktree;
      }
      if (!current.parentThreadId) return null;
      current = this.core.requireThread(current.parentThreadId).thread;
    }
    throw new Error('Thread parent lineage contains a cycle');
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
        const content = [result.report ?? ''];
        if (result.usage) content.push(result.usage);
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
    this.turnLifecycle.requireActiveTurn(input.senderThreadId, input.senderTurnId);
    if (input.isolation === 'worktree' && !this.prepareAgentWorktree) {
      throw new Error('Agent worktree isolation is unavailable');
    }
    const parent = this.core.requireThread(input.senderThreadId).thread;
    const selected = this.resolveAgentType(input.agentType, parent.cwd);
    const limits = await this.resolveSubagentLimits();
    assertSubagentLimits(limits);
    const startupContext = selected.kind === 'explore' || selected.kind === 'plan'
      ? null
      : await this.resolveAgentStartupContext(parent);
    const parentPath = this.taskPathForThread(input.senderThreadId) ?? '/root';
    const agentId = uuidV7(this.now());
    const turnId = uuidV7(this.now());
    const taskPath = `${parentPath}/${agentId}`;
    const workspace = input.isolation === 'worktree'
      ? await this.prepareAgentWorktree!({ agentId, cwd: parent.cwd, worktree: null })
      : { cwd: parent.cwd, worktree: null };
    let result: SpawnChildThreadResult;
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
        cwd: workspace.cwd,
        turnId,
          execution: {
          description: input.description,
          agentType: selected.canonicalType,
          runMode: input.runInBackground ? 'background' : 'foreground',
            worktree: workspace.worktree,
            toolPolicy: {
              kind: selected.kind,
              runInBackground: input.runInBackground,
              worktree: workspace.worktree !== null,
              allowNesting: this.agentDepth(input.senderThreadId) + 1 < limits.maxDepth,
              requestedTools: selected.role.overrides?.tools === undefined
                ? null
                : Object.freeze([...selected.role.overrides.tools]),
            },
            startupContext,
          },
        ...(input.model === undefined ? {} : { model: input.model }),
      });
    } catch (error) {
      if (workspace.worktree && this.settleAgentWorktree) {
        await this.settleAgentWorktree(workspace.worktree).catch(() => undefined);
      }
      throw error;
    }
    const execution = this.executions.require(result.thread.id);
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
    try {
      await this.waitForAgentSettlement(execution.agentId);
    } finally {
      input.signal?.removeEventListener('abort', abort);
    }
    await this.ensureTerminalPipeline(execution.agentId, execution.generation);
    // A foreground child may send `agent_message("main")` while its provider
    // turn is running. Deliver that envelope only after the ordinary Agent
    // result is ready, so the parent consumes it immediately before its next
    // provider request rather than as an unsolicited root Turn.
    await this.deliverParentMessages(execution.parentThreadId, {
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

  private async waitForAgentSettlement(agentId: ThreadId): Promise<void> {
    for (;;) {
      await this.turnLifecycle.waitForIdle(agentId);
      if (!this.hasOutstandingChildren(agentId)) return;
      await new Promise<void>((resolve) => {
        const state = this.collaborationActivityState(agentId);
        const done = () => {
          state.waiters.delete(done);
          resolve();
        };
        state.waiters.add(done);
        if (this.turnLifecycle.hasActiveTurn(agentId) || !this.hasOutstandingChildren(agentId)) done();
      });
    }
  }

  private async ensureTerminalPipeline(agentId: ThreadId, generation: number): Promise<void> {
    const key = executionKey(agentId, generation);
    const existing = this.terminalPipelines.get(key);
    if (existing) {
      await existing;
      return;
    }
    const execution = this.executions.read(agentId);
    if (!execution || execution.generation !== generation) return;
    const turn = this.core.readTurn(agentId, execution.currentTurnId);
    if (!turn || turn.status === 'inProgress') return;
    this.persistAgentTerminal(this.core.requireThread(agentId).thread, turn);
    await this.terminalPipelines.get(key);
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
    if (execution.stopProvenance === 'user') {
      return { success: false, message: 'A user-stopped Agent cannot be resumed by another Agent.' };
    }
    this.turnLifecycle.assertSubagentBudgetAvailable(execution.agentId);
    const snapshot = this.executions.generationSnapshot(execution.agentId);
    const prepared = await this.prepareWorktreeForResume(execution);
    const nextTurnId = uuidV7(this.now());
    const next = this.executions.beginNextGeneration({
      agentId: execution.agentId,
      turnId: nextTurnId,
      toolUseId: itemId,
      runMode: 'background',
      updatedAt: this.now(),
    });
    try {
      await this.turnLifecycle.startPrivilegedTurn({
        threadId: execution.agentId,
        turnId: nextTurnId,
        input: content,
        trigger: { kind: 'subagent', parentThreadId: senderThreadId, parentItemId: itemId },
      });
    } catch (error) {
      this.executions.rollbackGeneration(next.agentId, next.generation, snapshot);
      await this.rollbackPreparedResumeWorktree(execution, prepared);
      throw error;
    }
    const outputFile = await this.transcripts.pathForReader(execution.agentId);
    return {
      success: true,
      message: `Agent "${execution.agentId}" was stopped (${terminalStatus(this.core.allTurns(execution.agentId).at(-2))}); resumed it in the background with your message. You'll be notified when it finishes. Output: ${outputFile ?? '(unavailable)'}`,
      resumedAgentId: execution.agentId,
      pin: agentPin(execution.agentId),
    };
  }

  async stopAgentTask(
    senderThreadId: ThreadId,
    senderTurnId: TurnId,
    agentId: string,
  ): Promise<JsonValue | null> {
    this.turnLifecycle.requireActiveTurn(senderThreadId, senderTurnId);
    const execution = this.reachableExecution(senderThreadId, agentId);
    if (!execution) return null;
    const activeTurnId = this.turnLifecycle.activeTurnId(execution.agentId);
    if (!activeTurnId) {
      const status = terminalStatus(this.core.allTurns(execution.agentId).at(-1));
      throw new Error(`Task ${agentId} is not running (status: ${status})`);
    }
    this.executions.recordStop(execution.agentId, 'model', this.now());
    await this.turnLifecycle.interruptTurn(execution.agentId, activeTurnId);
    return {
      message: `Successfully stopped task: ${execution.agentId} (${execution.description})`,
      task_id: execution.agentId,
      task_type: 'local_agent',
      command: execution.description,
    };
  }

  recordUserStop(agentId: ThreadId): void {
    if (this.executions.read(agentId)) this.executions.recordStop(agentId, 'user', this.now());
  }

  clearUserStop(agentId: ThreadId): void {
    if (this.executions.read(agentId)?.stopProvenance === 'user') {
      this.executions.clearUserStop(agentId, this.now());
    }
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
            if (collaborationChild) await this.assertNewAgentAdmission(input.parentThreadId);
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
            const policyTools = input.execution
              ? resolvedConfiguration.tools
              : resolvedConfiguration.tools;
            const requestedCeiling = input.allowedTools === undefined
              ? policyTools
              : policyTools.filter((tool) => new Set(input.allowedTools).has(tool));
            const toolCeiling = input.execution || input.allowedTools !== undefined
              ? Object.freeze([...new Set(requestedCeiling)])
              : null;
            const configuration = this.applyToolCeiling(resolvedConfiguration, toolCeiling);
            const thread = await this.catalog.createThread({
              ...(input.id === undefined ? {} : { id: input.id }),
              name: input.displayName ?? input.taskPath.split('/').at(-1) ?? 'Subagent',
              ephemeral: parent.thread.ephemeral,
              source: input.childKind === 'isolatedSkill' ? 'agent.skill' : 'collaboration',
              threadSource: 'subagent',
              modelProvider: parent.thread.modelProvider,
              cwd: input.cwd ?? parent.thread.cwd,
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
            if (input.execution) {
              this.executions.create({
                agentId: thread.id,
                parentThreadId: parent.thread.id,
                description: input.execution.description,
                agentType: input.execution.agentType,
                runMode: input.execution.runMode,
                currentTurnId: input.turnId ?? uuidV7(this.now()),
                toolUseId: input.parentItemId,
                worktree: input.execution.worktree,
                toolPolicy: input.execution.toolPolicy,
                startupContext: input.execution.startupContext,
                createdAt: this.now(),
                updatedAt: this.now(),
              });
            }
            const accepted = await this.turnLifecycle.acceptAndLaunch({
              threadId: thread.id,
              ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
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
          } catch (error) {
            try {
              if (createdMemberThreadId) this.subagentBudgets.deleteMember(createdMemberThreadId);
              if (input.execution && stagedThreadId) this.executions.deleteAgent(stagedThreadId);
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
        role: 'default',
        allowedTools: input.allowedTools,
        childKind: 'isolatedSkill',
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      });
    }
  /** Host-only compatibility seam; never contributed to model tools. */
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
        child.runMode === 'background' && (
          this.turnLifecycle.hasActiveTurn(child.agentId)
          || pending.has(child.agentId)
          || this.terminalPipelines.has(executionKey(child.agentId, child.generation))
        )
      ));
  }
  private async assertNewAgentAdmission(senderThreadId: ThreadId): Promise<void> {
      const limits = await this.resolveSubagentLimits();
      assertSubagentLimits(limits);
      this.assertSpawnStructure(senderThreadId, limits.maxDepth);
      const sender = this.core.requireThread(senderThreadId).thread;
      const root = rootThreadId(sender, (id) => this.core.requireThread(id).thread);
      const live = this.core.metadata.childEdges(root, true)
        .filter((edge) => this.core.requireThread(edge.childThreadId).thread.source === 'collaboration')
        .filter((edge) => this.turnLifecycle.activeTurnId(edge.childThreadId) !== null)
        .length
        + [...this.ephemeralSpawnEdges]
          .filter(([, edge]) => rootThreadId(
            this.core.requireThread(edge.parentThreadId).thread,
            (id) => this.core.requireThread(id).thread,
          ) === root)
          .filter(([threadId]) => this.core.requireThread(threadId).thread.source === 'collaboration')
          .filter(([threadId]) => this.turnLifecycle.activeTurnId(threadId) !== null)
          .length;
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
      if (form === 'collaboration') {
        this.persistAgentTerminal(thread, turn);
      }
      const queued = this.pendingSubagentActivities.get(thread.parentThreadId) ?? [];
      queued.push({ agentThreadId: thread.id, agentTurnId: turn.id, agentPath, kind, error: turn.error, form });
      this.pendingSubagentActivities.set(thread.parentThreadId, queued);
      // An isolated Skill is absent from `wait_agent` by contract, so its
      // terminal transition must not wake a parent blocked on collaboration
      // children — the `skill` call that is already awaiting it owns its outcome.
      if (form === 'collaboration') this.signalCollaborationActivity(thread.parentThreadId);
    }

  async recoverPendingNotifications(): Promise<void> {
      const parents = new Set<ThreadId>();
      for (const execution of this.executions.all()) {
        const turn = this.core.readTurn(execution.agentId, execution.currentTurnId);
        if (execution.runMode === 'background' && turn && turn.status !== 'inProgress') {
          this.persistAgentTerminal(this.core.requireThread(execution.agentId).thread, turn);
        }
        if (execution.runMode === 'background') parents.add(execution.parentThreadId);
      }
      for (const parentThreadId of [
        ...parents,
        ...this.executions.parentsWithPending(),
        ...this.executions.parentsWithPendingMessages(),
      ]) {
        await this.deliverParentWork(parentThreadId);
      }
    }

  private persistAgentTerminal(thread: Thread, turn: Turn): void {
      const execution = this.executions.read(thread.id);
      if (!execution || execution.currentTurnId !== turn.id || execution.runMode !== 'background') return;
      const key = executionKey(execution.agentId, execution.generation);
      if (this.terminalPipelines.has(key)) return;
      const pipeline = this.runTerminalPipeline(execution, turn);
      this.terminalPipelines.set(key, pipeline);
      void pipeline.finally(() => {
        if (this.terminalPipelines.get(key) === pipeline) this.terminalPipelines.delete(key);
      });
    }

  private async runTerminalPipeline(execution: SubagentExecutionRecord, turn: Turn): Promise<void> {
      try {
        // The transcript is the durable child account. Notification admission
        // must never race its append or worktree settlement.
        await this.transcripts.flush(execution.agentId);
        let refreshed = this.executions.require(execution.agentId);
        if (turn.error?.code === 'subagent_budget_exhausted') {
          refreshed = this.executions.recordStop(execution.agentId, 'budget', this.now());
        } else if (turn.error?.code === 'host_restart') {
          refreshed = this.executions.recordStop(execution.agentId, 'hostRestart', this.now());
        }
        if (refreshed.worktree && this.settleAgentWorktree) {
          const settled = await this.settleAgentWorktree(refreshed.worktree);
          refreshed = this.executions.setWorktree(execution.agentId, settled.worktree, this.now());
          await this.persistThreadCwd(execution.agentId, settled.worktree);
        }
        this.executions.recordTerminal({
          agentId: refreshed.agentId,
          generation: refreshed.generation,
          parentThreadId: refreshed.parentThreadId,
          turnId: turn.id,
          toolUseId: refreshed.toolUseId,
          status: refreshed.stopProvenance === 'model'
            ? 'killed'
            : turn.status === 'completed'
              ? 'completed'
              : turn.status === 'failed'
                ? 'failed'
                : 'interrupted',
          createdAt: this.now(),
        });
        await this.deliverParentWork(refreshed.parentThreadId);
      } catch (error) {
        // A retryable pipeline failure remains visible through the execution
        // row; recovery will re-enter it after the host restarts/next idle edge.
        console.warn(`[agent] Subagent terminal pipeline deferred for ${execution.agentId}`, error);
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
      await this.deliverPendingNotifications(parentThreadId);
      await this.deliverParentMessages(parentThreadId);
    }

  private async deliverPendingNotifications(parentThreadId: ThreadId): Promise<void> {
      if (this.turnLifecycle.hasActiveTurn(parentThreadId)) return;
      const pending = this.executions.pendingForParent(parentThreadId);
      for (const notification of pending) {
        if (this.hasBlockingBackgroundChildren(parentThreadId, notification.agentId)) return;
        if (!this.executions.claim(notification.agentId, notification.generation)) continue;
        try {
          const execution = this.executions.require(notification.agentId);
          const turn = this.core.readTurn(notification.agentId, notification.turnId);
          if (!turn) throw new Error(`Agent notification Turn not found: ${notification.turnId}`);
          const outputFile = await this.transcripts.pathForReader(notification.agentId);
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
          const accepted = await this.turnLifecycle.tryStartTurnIfIdle({
            threadId: parentThreadId,
            ...(continuationTurnId === undefined ? {} : { turnId: continuationTurnId }),
            input: [{
              type: 'text',
              text: taskNotificationText({ execution, notification, turn, outputFile }),
            }],
            clientUserMessageId: notificationClientId(notification),
            trigger: {
              kind: 'subagent',
              parentThreadId: execution.parentThreadId,
              parentItemId: notification.toolUseId,
            },
          });
          if (!accepted) {
            if (parentExecution && continuation && continuationTurnId !== undefined) {
              this.executions.rollbackContinuation({
                agentId: parentThreadId,
                expectedGeneration: continuation.generation,
                expectedTurnId: continuationTurnId,
                snapshot: continuation,
              });
            }
            this.executions.release(notification.agentId, notification.generation);
            return;
          }
          this.executions.markDelivered(notification.agentId, notification.generation, this.now());
        } catch (error) {
          this.executions.release(notification.agentId, notification.generation);
          console.warn(`[agent] Subagent notification delivery deferred for ${notification.agentId}`, error);
          return;
        }
      }
    }

  private hasBlockingBackgroundChildren(parentThreadId: ThreadId, excludedAgentId?: ThreadId): boolean {
      const pending = this.executions.pendingForParent(parentThreadId)
        .filter((notification) => notification.agentId !== excludedAgentId)
        .map((notification) => notification.agentId);
      return this.executions.listByParent(parentThreadId).some((child) => (
        child.runMode === 'background'
        && child.agentId !== excludedAgentId
        && (
          this.turnLifecycle.hasActiveTurn(child.agentId)
          || pending.includes(child.agentId)
          || this.terminalPipelines.has(executionKey(child.agentId, child.generation))
        )
      ));
    }

  private async deliverParentMessages(
    parentThreadId: ThreadId,
    foreground?: { readonly senderAgentId: ThreadId; readonly generation: number },
  ): Promise<void> {
      const pending = foreground
        ? this.executions.pendingForegroundParentMessages(
          parentThreadId,
          foreground.senderAgentId,
          foreground.generation,
        )
        : this.executions.pendingParentMessages(parentThreadId)
          .filter((message) => message.deliveryMode === 'background');
      for (const message of pending) {
        if (message.deliveryMode === 'foreground' && this.isForegroundMessageSenderActive(message)) continue;
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
              if (foreground) {
                // A foreground envelope belongs to the invoking parent Turn.
                // The parent may have been cancelled or settled while the
                // child was finishing; do not retain stale input or create an
                // unsolicited root Turn.
                this.executions.discardParentMessage(message.id);
              } else {
                this.executions.releaseParentMessage(message.id);
              }
              return;
            }
          }
          this.executions.markParentMessageDelivered(message.id, this.now());
        } catch (error) {
          this.executions.releaseParentMessage(message.id);
          console.warn(`[agent] Agent main-route message delivery deferred for ${message.senderAgentId}`, error);
          return;
        }
      }
    }

  private isForegroundMessageSenderActive(message: {
    readonly senderAgentId: ThreadId;
    readonly generation: number;
  }): boolean {
      const active = this.turnLifecycle.hasActiveTurn(message.senderAgentId);
      if (!active) return false;
      const execution = this.executions.read(message.senderAgentId);
      return execution !== null && execution.generation === message.generation;
    }

  private async sendAgentMessageToMain(senderThreadId: ThreadId, message: string): Promise<JsonValue> {
      const execution = this.executions.read(senderThreadId);
      if (!execution) {
        return { success: false, message: 'Only an Agent can send to the main conversation.' };
      }
      const id = `agent-message:${execution.agentId}:${uuidV7(this.now())}`;
      this.executions.enqueueParentMessage({
        id,
        senderAgentId: senderThreadId,
        parentThreadId: execution.parentThreadId,
        generation: execution.generation,
        content: agentMessageToMainText(
          execution.agentType,
          message,
          execution.runMode === 'foreground',
        ),
        deliveryMode: execution.runMode,
        createdAt: this.now(),
      });
      if (execution.runMode === 'background') {
        await this.deliverParentMessages(execution.parentThreadId);
      }
      return { success: true, message: "Message queued for the main conversation's next turn." };
    }

  private reachableExecution(senderThreadId: ThreadId, targetInput: string): SubagentExecutionRecord | null {
      const execution = this.executions.read(targetInput);
      if (!execution) return null;
      const sender = this.core.requireThread(senderThreadId).thread;
      const target = this.core.requireThread(execution.agentId).thread;
      if (sender.sessionId !== target.sessionId) return null;
      if (execution.parentThreadId === senderThreadId || this.isReachableDescendant(senderThreadId, target.id)) {
        return execution;
      }
      // A child may steer/resume its siblings only through their shared parent.
      if (sender.parentThreadId && sender.parentThreadId === execution.parentThreadId) return execution;
      return null;
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

  private async prepareWorktreeForResume(execution: SubagentExecutionRecord): Promise<AgentWorktreeMetadata | null> {
    if (!execution.worktree || !this.prepareAgentWorktree) return execution.worktree;
    const prepared = await this.prepareAgentWorktree({
      agentId: execution.agentId,
      cwd: execution.worktree.sourceCwd,
      worktree: execution.worktree,
    });
    const next = this.executions.setWorktree(execution.agentId, prepared.worktree, this.now());
    await this.persistThreadCwd(execution.agentId, prepared.worktree);
    return next.worktree;
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
    execution: SubagentExecutionRecord,
    previous: AgentWorktreeMetadata | null,
  ): Promise<void> {
    if (!execution.worktree || !this.settleAgentWorktree) return;
    if (previous && previous.path === execution.worktree.path) {
      this.executions.setWorktree(execution.agentId, previous, this.now());
      await this.persistThreadCwd(execution.agentId, previous);
      return;
    }
    try {
      const settled = await this.settleAgentWorktree(execution.worktree);
      const restored = this.executions.setWorktree(execution.agentId, settled.worktree, this.now());
      if (restored.worktree) await this.persistThreadCwd(execution.agentId, restored.worktree);
    } catch (error) {
      console.warn(`[agent] Failed to roll back resumed Agent worktree ${execution.agentId}`, error);
    }
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
  if (spawnItem.type !== 'collabAgentToolCall' || spawnItem.tool !== 'agent') {
    throw new Error('Subagent spawn boundary does not reference an agent Item');
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

function notificationClientId(notification: SubagentPendingNotification): string {
  return `task-notification:${notification.agentId}:${notification.generation}`;
}

function executionKey(agentId: ThreadId, generation: number): string {
  return `${agentId}:${generation}`;
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
