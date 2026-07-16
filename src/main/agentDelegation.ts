import { Agent, type AfterToolCallResult, type AgentEvent } from '@earendil-works/pi-agent-core';
import { isContextOverflow } from '@earendil-works/pi-ai';
import type { Api, AssistantMessage, ImageContent, Model, TextContent, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  coerceString,
  parsePositiveInteger,
} from '../core/agentMarkdown';
import type {
  AgentMessage,
  AgentRunActionResult,
  AgentSubRunStatus,
  AgentRunFileChanges,
  AgentRunNodeChanges,
} from '../core/agentTypes';
import { systemReminder } from '../core/agentAttachments';
import type {
  DelegationRunRecord,
  AgentRunContextMode,
  AgentObjectiveStatus,
  AgentRunBudget,
  AgentRunObjectiveRole,
  AgentRunProfileId,
  AgentRunPurpose,
  AgentRunSubmissionProjection,
  AgentRunSubmissionSource,
  AgentRunScope,
  DelegationDetail,
  AgentPayloadRef,
} from '../core/agentEventLog';
import type { ErrorReport } from '../core/errorObservability';
import type { AgentPermissionMode, AgentReasoningLevel, AgentRuntimeSettings, AgentDefinition } from '../core/types';
import { normalizeAgentToolNames } from './agentToolRules';
import { createAgentLocalWorkspaceContext, restorePostCompactReadFiles, scratchRootForWorkdir, type AgentLocalWorkspaceContext } from './agentLocalTools';
import { AgentSkillRuntime } from './agentSkills';
import { createAgentSkillProvenanceStore } from './agentSkillProvenanceStore';
import {
  createPostCompactMessage,
  createPostCompactRestoredFilesReminder,
} from './agentCompaction';
import {
  collectAgentMessageToolResultBudgetSelections,
  createToolResultBudgetState,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  MAX_TOOL_RESULTS_PER_BATCH_CHARS,
  piToolResultTextContent,
  restoreToolResultBudgetStateFromAgentMessages,
  type ToolResultBudgetState,
} from './agentToolOutputSlimming';
import { agentMessagesAutoCompactTokens, autoCompactThreshold } from './agentRuntimeContext';
import { NEVA_AGENT_PERSONA } from './agentSystemPrompt';
import { isAbortError, throwIfAborted } from './agentAwaitWithAbort';
import { chainAbortSignals } from './agentStreamAbort';
import {
  agentDefinitionAgentId,
  memoryWorkspaceIdForRoot,
} from './agentDelegationIdentity';
import {
  isRunProfileId,
  resolveRunProfile,
  runProfileForIsolatedSkill,
  runProfileForPurpose,
} from './agentRunProfiles';
import { readOnlyAgentToolNames } from '../core/agentPermissionModel';
import {
  admitRunBudget,
  formatRunBudgetForPrompt,
  formatRunScopeForPrompt,
  narrowRunScope,
  normalizeRunBudgetInput,
  normalizeRunScope,
  prepareRunBudgetAmendment,
  releaseAdmittedRunBudget,
  remainingBudgetMs,
  retryBudgetSlice,
  scopedAllowedToolNames,
  settleRunBudget,
  verifierAllowedToolNames,
  verifierBudgetForRun,
  verifierRunScope,
} from './agentDelegationRunPolicy';
import {
  buildControllerReplanPrompt,
  buildReplacementWorkerObjective,
  buildVerifierObjective,
  captureWorkingSetSnapshot,
  compactFileChanges,
  compactNodeChanges,
  latestRunSubmissionSummary,
  parseVerifierVerdict,
  recordFileToolChanges,
  recordNodeToolChanges,
  recordToolTrace,
  recordWorkingSetDiff,
  sameTailCount,
  type AgentRunToolTraceEntry,
  verifierGapSignature,
} from './agentDelegationVerificationPolicy';

export { recordNodeToolChanges } from './agentDelegationVerificationPolicy';

export const INTERNAL_DELEGATION_ACTOR_TOOL_NAME = 'internal_delegation';

const AGENT_LISTING_CONTEXT_PERCENT = 0.01;
const CHARS_PER_TOKEN = 4;
const DEFAULT_AGENT_LISTING_CHAR_BUDGET = 8_000;
const MAX_LISTING_DESCRIPTION_CHARS = 250;
const MAX_CONCURRENT_SUB_RUNS = 4;
const DEFAULT_MAX_DELEGATION_DEPTH = 12;
const FORK_AGENT_TYPE = 'fork';
const FORK_BOILERPLATE_TAG = 'lin-fork-child';
const FORK_PLACEHOLDER_RESULT = 'Fork started - processing in background.';
export const TENON_ASSISTANT_AGENT_NAME = 'assistant';
export const TENON_ASSISTANT_AGENT_DISPLAY_NAME = 'Neva';
const AGENT_LISTING_STATE_MARKER = 'The following agents have already been listed to the agent in this session:';
const CHILD_RUN_TOOL_RESULT_BUDGET_SKIP_TOOLS = new Set(['file_read']);
const MAX_CHILD_RUN_AUTO_COMPACT_FAILURES = 3;
const CHILD_RUN_POST_COMPACT_MAX_FILES_TO_RESTORE = 5;
const CHILD_RUN_POST_COMPACT_MAX_CHARS_PER_FILE = 20_000;
const CHILD_RUN_POST_COMPACT_TOTAL_RESTORED_FILE_CHARS = 200_000;
const DEFAULT_VERIFIER_RETRY_LIMIT = 2;
const DEFAULT_VERIFIER_LIVELOCK_REPEAT_LIMIT = 2;
// `setTimeout` stores its delay in a 32-bit int; a larger delay overflows and
// fires (near-)immediately, so any timer is armed in clamped re-arming hops.
const MAX_SETTIMEOUT_DELAY_MS = 2_147_483_647;

export type AgentDelegateToolData = AgentRunActionResult;

export interface AgentChildAgentCreateInput {
  runId: string;
  conversationId: string;
  messages: AgentMessage[];
  systemPrompt: string;
  executingAgentId: string;
  parentAgentId: string;
  /**
   * The consultee to attribute this run's gated/denied approvals to (its own id
   * for a fresh consult, the inherited consultee for a fork, undefined for the
   * user's own agent). Resolved to a mention token by the approval card.
   */
  requestedByAgentId?: string;
  memoryOwnerAgentId: string;
  memoryOriginWorkspace?: string;
  model?: string;
  effort?: string;
  permissionMode?: AgentPermissionMode;
  maxTurns?: number;
  skillRuntime: AgentSkillRuntime;
  localWorkspace: AgentLocalWorkspaceContext;
  delegationRuntime: AgentDelegationRuntime;
  scope?: AgentRunScope;
  allowedTools?: string[];
  disallowedTools?: string[];
  preapprovedToolRules?: string[];
  scopePreauthorized?: boolean;
  l0CacheBreakpointEnabled?: boolean;
  /**
   * Run with no interactive approval channel. A tool needing approval is denied
   * and surfaced instead of waiting for a human; globally always-allowed tools
   * still run. Set only by runtime-owned unattended execution paths.
   */
  unattended?: boolean;
  blockForInput?: (reason: string) => void;
  afterToolResult?: (
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
  ) => Promise<AfterToolCallResult | undefined> | AfterToolCallResult | undefined;
}

export interface AgentDelegationRuntimeHost {
  createChildAgent(input: AgentChildAgentCreateInput): Agent;
  getParentMessages(): AgentMessage[];
  getParentSystemPrompt(): string;
  /** The agent that is delegating right now. Defaults to this runtime's configured agent. */
  getParentAgentId?(): string | null;
  /** Memory owner for a forked child of the current parent. Defaults to the runtime memory owner. */
  getParentMemoryOwnerAgentId?(): string | null;
  /** The parent run currently executing (the delegating side of the run tree). */
  getActiveRunId(): string | null;
  getRuntimeSettings(): Promise<AgentRuntimeSettings>;
  /**
   * A sub-run started: update Run metadata and seed the run's OWN ledger
   * ([[agent-run-unification]] Design 1) — context messages (fork prefix)
   * before `run.started`, the directive after it.
   */
  runStarted(
    snapshot: AgentRunSnapshot,
    seed: { contextMessages: readonly AgentMessage[]; evidenceMessages: readonly AgentMessage[] },
  ): Promise<void>;
  /** A completed child message (user / assistant / toolResult) → child ledger. */
  runMessage(snapshot: AgentRunSnapshot, message: AgentMessage): Promise<void>;
  /** A slimming replacement of an earlier tool result → `tool_result.replaced` in the child ledger. */
  runToolResultReplaced(snapshot: AgentRunSnapshot, toolCallId: string, text: string): Promise<void>;
  /** Event-sourced run compaction (Design 4). */
  runCompacted(
    snapshot: AgentRunSnapshot,
    input: { postCompactMessage: AgentMessage; summary: string; trigger: 'auto' | 'reactive' },
  ): Promise<void>;
  runResultSubmitted(
    snapshot: AgentRunSnapshot,
    input: { summary: string; source: AgentRunSubmissionSource },
  ): Promise<AgentRunSubmissionProjection | null>;
  readLatestRunSubmission?(runId: string): Promise<AgentRunSubmissionProjection | undefined>;
  /** Status transition: Run metadata + run lifecycle event in the run ledger. */
  runStatusChanged(snapshot: AgentRunSnapshot, durableMessage?: AgentMessage): Promise<void>;
  /** A live execution frame started; forwarded through nested runtimes. */
  runExecutionStarted?(snapshot: AgentRunSnapshot): void;
  /** The current execution frame finished after its terminal persistence settled. */
  runExecutionSettled?(snapshot: AgentRunSnapshot): Promise<void> | void;
  notifyRun(snapshot: AgentRunSnapshot): Promise<void>;
  reportError?(report: ErrorReport): void;
  /**
   * Re-register the run's ledger writer and re-derive its transcript from the
   * run's OWN ledger — the resume path's restore (restore-on-open is records
   * only; transcripts load lazily here). Null when no ledger exists; the
   * writer is then registered empty so the continuation can still record.
   */
  restoreRunLedger(runId: string): Promise<AgentMessage[] | null>;
  persistToolOutputPayload(
    toolCallId: string,
    toolName: string,
    text: string,
  ): Promise<{ payload: AgentPayloadRef; label: string }>;
  completeCompactSummary(
    conversationId: string,
    messages: readonly AgentMessage[],
    model: Model<Api>,
    customInstructions?: string,
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface AgentDelegationRuntimeOptions {
  conversationId: string;
  executingAgentId: string;
  memoryOwnerAgentId?: string;
  localRoot?: string;
  scratchRoot?: string;
  protectedStoreRoot?: string;
  depth?: number;
  ancestry?: string[];
  maxDepth?: number;
  scope?: AgentRunScope;
  budget?: AgentRunBudget;
  /**
   * The consultee this runtime executes as, for approval attribution — set when
   * this runtime IS a consulted agent (a fresh child) or a fork descending from
   * one; undefined for the user's own top agent. A run's forks inherit it.
   */
  requestedByAgentId?: string;
  host: AgentDelegationRuntimeHost;
}

// The live runtime record: the canonical {@link DelegationDetail} (id, status,
// the descriptive fields, the persisted `unattended` flag) plus the in-memory
// execution state that never persists (the live agent, the message buffer, the
// completion promise). The descriptive half is the SAME shape the durable record
// and IPC snapshot derive from — the convergence's single source.
interface DelegationRunState extends DelegationDetail {
  definition: AgentDefinition | null;
  depth: number;
  agent?: Agent;
  messages: AgentMessage[];
  /**
   * Messages the ledger was seeded with at spawn — the subscription must not
   * re-append them when the loop re-emits `message_end` for its prompt inputs
   * (which it does; the old snapshot path double-recorded them).
   */
  ledgerSeededMessages: WeakSet<AgentMessage>;
  /** System follow-ups whose message_end listener must durably append before the loop may continue. */
  durableFollowUpMessages: WeakSet<AgentMessage>;
  /** Exact durable follow-up payloads that compaction must carry until a completed terminal is persisted. */
  activeDurableFollowUpTexts: Set<string>;
  /** A continuation is rebuilding/announcing before its agent loop starts. */
  startupInFlight: boolean;
  /** Number of runChildAgent frames that have not settled their terminal persistence yet. */
  executionInFlightCount: number;
  /**
   * Index into `agent.state.messages` marking where the CURRENT live span
   * begins — reset on resume (the restored history seed) and on compaction (the
   * folded-away span). `stop` salvages partial assistant text only from here on,
   * so a resumed run that is stopped before it produces NEW output cannot report
   * the previous round's text (the completion path, which legitimately returns
   * the conversation's final answer, scans the whole array instead).
   */
  salvageFromIndex?: number;
  completion?: Promise<AgentDelegateToolData | void>;
  detached: boolean;
  terminalNotificationSent: boolean;
  turnCount: number;
  verify: boolean;
  verificationAttemptBase: number;
  verificationAttempts: number;
  verifierRunIds: string[];
  hasWorkChildren?: boolean;
  latestVerifierGap?: string;
  parentBudgetRef?: AgentRunBudget;
  budgetSettled?: boolean;
  /** Re-arms the live execution frame's wall-clock deadline after a budget amendment. */
  budgetTimerRefresh?: () => void;
  /** Set when a 'completed' run was actually cut off (maxTurns / unresolved overflow). */
  incomplete?: boolean;
  preapprovedToolRules?: string[];
  toolResultBudgetState: ToolResultBudgetState;
  nodeChanges: AgentRunNodeChanges;
  fileChanges: AgentRunFileChanges;
  toolTrace: AgentRunToolTraceEntry[];
  verifierGapSignatures: string[];
  verificationAbortController?: AbortController;
  /** Invalidates async verifier/re-plan frames when stop, resume, or a contract amendment wins. */
  lifecycleEpoch: number;
  latestSubmission?: AgentRunSubmissionProjection;
  submittedResult?: string;
  summarizedDetachedChildRunKey?: string;
  processedControllerDeliveryCount: number;
  autoCompactConsecutiveFailures: number;
  autoCompactInProgress: boolean;
  skillRuntime?: AgentSkillRuntime;
  localWorkspace?: AgentLocalWorkspaceContext;
  subRunRuntime?: AgentDelegationRuntime;
  observedOnly?: boolean;
}

type RunningSlotReservation = () => void;

/**
 * The IPC-facing view of a delegated run — the {@link DelegationDetail} verbatim
 * (the runtime record's persistable half), carried to the host callbacks that
 * write the conversation markers and notifications.
 */
export type AgentRunSnapshot = DelegationDetail;

export type AgentRunAcceptedCallback = (
  snapshot: AgentRunSnapshot,
) => Promise<void> | void;

interface AgentToolParams {
  objective: string;
  criteria?: string[];
  verify: boolean;
  description: string;
  runPrompt: string;
  purpose: AgentRunPurpose;
  objectiveRole?: AgentRunObjectiveRole;
  scope?: AgentRunScope;
  budget?: AgentRunBudget;
  context: AgentRunContextMode;
  runProfile?: AgentRunProfileId;
  detach?: boolean;
  model?: string;
  effort?: string;
  name?: string;
  allowedTools?: string[];
  preapprovedToolRules?: string[];
  parentRunId?: string;
  parentBudget?: AgentRunBudget;
  scopePreauthorized?: boolean;
  inheritedVerificationAttempts?: number;
  inheritedVerifierGapSignatures?: string[];
  inheritedVerifierRunIds?: string[];
  /**
   * Run with no interactive approval channel: a tool needing approval is denied
   * (and surfaced) instead of waiting for a human. Set for unattended scheduled
   * command runs so an approval-gated tool can never hang an unwatched run.
   * Tools covered by the global always-allow rules still run (they resolve to
   * `allow` before any approval is sought). Internal-only — not part of the
   * agent-facing Agent tool schema.
   */
  unattended?: boolean;
}

export interface AgentRunSkillInput {
  skillName: string;
  description: string;
  renderedContent: string;
  model?: string;
  effort?: string;
  allowedTools?: string[];
  readOnlyIsolated?: boolean;
}

export class AgentDelegationRuntime {
  private readonly registry: AgentDefinitionRegistry;
  private readonly conversationId: string;
  private readonly localRoot: string;
  private readonly scratchRoot: string;
  private readonly protectedStoreRoot?: string;
  private readonly depth: number;
  private readonly maxDepth: number;
  private readonly ancestry: string[];
  private readonly executingAgentId: string;
  private readonly memoryOwnerAgentId: string;
  private readonly requestedByAgentId?: string;
  private readonly inheritedScope?: AgentRunScope;
  private readonly inheritedBudget?: AgentRunBudget;
  private readonly host: AgentDelegationRuntimeHost;
  private readonly runs = new Map<string, DelegationRunState>();
  private readonly names = new Map<string, string>();
  private readonly listedAgents = new Map<string, string | null>();
  private reservedRunningSlots = 0;
  private disabledAgents: string[] = [];

  constructor(options: AgentDelegationRuntimeOptions) {
    this.conversationId = options.conversationId;
    this.localRoot = path.resolve(options.localRoot ?? process.cwd());
    this.scratchRoot = scratchRootForWorkdir(this.localRoot, options.scratchRoot);
    this.protectedStoreRoot = options.protectedStoreRoot;
    this.depth = options.depth ?? 0;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DELEGATION_DEPTH;
    this.ancestry = options.ancestry ?? [];
    this.executingAgentId = options.executingAgentId;
    this.memoryOwnerAgentId = options.memoryOwnerAgentId ?? options.executingAgentId;
    this.requestedByAgentId = options.requestedByAgentId;
    this.inheritedScope = options.scope;
    this.inheritedBudget = options.budget;
    this.host = options.host;
    this.registry = new AgentDefinitionRegistry();
  }

  updateDisabledAgents(disabledAgents: string[]): void {
    this.disabledAgents = disabledAgents;
  }

  /** Invalidate this runtime's agent-definition cache (after an authoring write). */
  reloadAgentDefinitions(): void {
    this.registry.reload();
  }

  forgetRun(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.agent?.abort();
    this.runs.delete(runId);
    if (run.name && this.names.get(run.name) === runId) this.names.delete(run.name);
  }

  private blockRunForInput(runId: string, reason: string): void {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'running') return;
    run.status = 'failed';
    run.objectiveStatus = 'blocked';
    run.error = reason;
    run.blockedReason = reason;
    run.completedAt = Math.max(Date.now(), run.updatedAt + 1);
    run.updatedAt = run.completedAt;
    run.agent?.abort();
  }

  async listAllAgentDefinitions(): Promise<AgentDefinition[]> {
    return this.registry.listAgents();
  }

  async reserveAgentListingReminderText(contextWindowTokens?: number | null): Promise<string | null> {
    const agents = await this.registry.listAgents();
    const newAgents = agents.filter((agent) => !this.isAgentListed(agent) && !this.disabledAgents.includes(agentDefinitionAgentId(agent)));
    if (newAgents.length === 0) return null;
    const listing = formatAgentListing(newAgents, contextWindowTokens ?? undefined);
    if (!listing) return null;
    for (const agent of newAgents) this.listedAgents.set(agent.name, agentListingIdentity(agent));
    return [
      'You are operating with these available agent definitions for Issue and Agent Session work:',
      '',
      listing,
    ].join('\n');
  }

  restoreListedAgentsFromMessages(messages: readonly AgentMessage[]): void {
    for (const message of messages) {
      for (const text of messageTextParts(message)) {
        for (const entry of parsePersistedAgentListingStateEntries(text)) {
          this.listedAgents.set(entry.name, entry.identity ?? null);
        }
        for (const name of parseLiveAgentListing(text)) {
          this.listedAgents.set(name, null);
        }
      }
    }
  }

  createAgentListingStateReminder(): UserMessage | null {
    const entries = [...this.listedAgents.entries()]
      .map(([name, identity]) => ({ name, identity }))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (entries.length === 0) return null;
    return createHiddenUserMessage([
      AGENT_LISTING_STATE_MARKER,
      '',
      ...entries.map(formatPersistedAgentListingStateEntry),
    ].join('\n'));
  }

  private isAgentListed(agent: AgentDefinition): boolean {
    const current = this.listedAgents.get(agent.name);
    if (current === undefined) return false;
    return current === null || current === agentListingIdentity(agent);
  }

  /**
   * Register persisted delegated Run records on conversation restore. Records only
   * — no transcript IO: a run's messages are replayed from its own ledger
   * lazily, on first resume (`send` → host.restoreRunLedger). Drill-in
   * reads never touch this state (they replay the ledger directly).
   */
  restorePersistedRuns(records: readonly DelegationRunRecord[]): void {
    for (const record of records) {
      if (this.runs.has(record.id)) continue;
      // The descriptive half carries over verbatim — the durable record IS a
      // DelegationDetail. Only `memoryOriginWorkspace` is re-derived when absent
      // (older detached runs may predate the field) and the live execution state
      // is initialized fresh (no agent, empty buffer; resume rebuilds it).
      const run: DelegationRunState = {
        ...record,
        memoryOriginWorkspace: record.memoryOriginWorkspace ?? memoryWorkspaceIdForRoot(this.localRoot),
        definition: null,
        depth: this.depth + 1,
        messages: [],
        ledgerSeededMessages: new WeakSet(),
        durableFollowUpMessages: new WeakSet(),
        activeDurableFollowUpTexts: new Set(),
        startupInFlight: false,
        executionInFlightCount: 0,
        detached: false,
        terminalNotificationSent: true,
        turnCount: 0,
        verify: record.verify === true,
        verificationAttemptBase: record.verificationAttemptBase ?? 0,
        verificationAttempts: record.verificationAttemptBase ?? 0,
        verifierRunIds: [],
        hasWorkChildren: false,
        latestVerifierGap: record.latestVerifierGap,
        processedControllerDeliveryCount: 0,
        toolResultBudgetState: createToolResultBudgetState(),
        nodeChanges: {},
        fileChanges: {},
        toolTrace: [],
        verifierGapSignatures: [...(record.verifierGapSignatures ?? [])],
        lifecycleEpoch: 0,
        autoCompactConsecutiveFailures: 0,
        autoCompactInProgress: false,
      };
      this.runs.set(run.id, run);
      if (run.name) this.names.set(run.name, run.id);
    }
    for (const record of records) {
      if (!record.parentRunId) continue;
      const parent = this.runs.get(record.parentRunId);
      if (!parent) continue;
      if (record.purpose === 'verify') {
        parent.verifierRunIds.push(record.id);
        parent.verificationAttempts = parent.verificationAttemptBase + parent.verifierRunIds.length;
      } else {
        parent.hasWorkChildren = true;
      }
    }
  }

  async controllingRuntimeForRun(runId: string): Promise<AgentDelegationRuntime | null> {
    return this.findControllingRuntimeForRun(runId, new Set());
  }

  private async findControllingRuntimeForRun(
    runId: string,
    visited: Set<string>,
  ): Promise<AgentDelegationRuntime | null> {
    const visitKey = `${this.conversationId}\u0000${runId}`;
    if (visited.has(visitKey)) return null;
    visited.add(visitKey);

    const local = this.runs.get(runId);
    if (local && !local.observedOnly) return this;
    if (local?.parentRunId) {
      const parentRuntime = await this.findControllingRuntimeForRun(local.parentRunId, visited);
      const parentRun = parentRuntime?.runs.get(local.parentRunId);
      if (parentRuntime && parentRun) {
        await parentRuntime.ensureLiveAgent(parentRun);
        const nested = parentRun.subRunRuntime;
        if (nested) {
          if (!nested.runs.has(runId)) nested.restorePersistedRuns([snapshotRun(local)]);
          return nested.findControllingRuntimeForRun(runId, visited);
        }
      }
    }

    for (const run of this.runs.values()) {
      const nested = run.subRunRuntime;
      if (!nested) continue;
      const owner = await nested.findControllingRuntimeForRun(runId, visited);
      if (owner) return owner;
    }
    return null;
  }

  async invokeAgent(
    rawParams: unknown,
    signal?: AbortSignal,
    parentToolCallId?: string,
    onAccepted?: AgentRunAcceptedCallback,
    objectiveRole?: AgentRunObjectiveRole,
    scopePreauthorized = false,
  ): Promise<AgentDelegateToolData> {
    const params = normalizeAgentToolParams(rawParams);
    params.objectiveRole = objectiveRole;
    params.scopePreauthorized = scopePreauthorized;
    const releaseStartupSlot = this.reserveRunningSlot();
    try {
      return await this.startAgent(params, releaseStartupSlot, signal, parentToolCallId, onAccepted);
    } catch (error) {
      releaseStartupSlot();
      throw error;
    }
  }

  async invokeSkillChildAgent(
    input: AgentRunSkillInput,
    signal?: AbortSignal,
    parentToolCallId?: string,
  ): Promise<AgentDelegateToolData> {
    const releaseStartupSlot = this.reserveRunningSlot();
    try {
      return await this.startAgent({
        objective: input.renderedContent,
        criteria: undefined,
        verify: false,
        description: compactInlineText(input.description) || `skill ${input.skillName}`,
        runPrompt: input.renderedContent,
        purpose: 'work',
        context: 'none',
        runProfile: runProfileForIsolatedSkill(input.readOnlyIsolated),
        model: input.model,
        effort: input.effort,
        allowedTools: input.readOnlyIsolated ? readOnlyAgentToolNames(input.allowedTools) : undefined,
        preapprovedToolRules: input.allowedTools,
      }, releaseStartupSlot, signal, parentToolCallId);
    } catch (error) {
      releaseStartupSlot();
      throw error;
    }
  }

  async status(rawParams: unknown): Promise<AgentDelegateToolData> {
    const params = normalizeRunSelector(rawParams);
    const run = this.resolveRun(params);
    if (params.wait && run.status === 'running') {
      await waitWithTimeout(run.completion ?? Promise.resolve(), params.timeout_ms ?? 30000);
    }
    await this.hydrateLatestSubmission(run);
    return runToToolData(run, this.directChildrenOf(run), liveRunPartialResult(run));
  }

  hasLiveRun(runId: string): boolean {
    const run = this.runs.get(runId);
    return Boolean(run && (run.startupInFlight || run.executionInFlightCount > 0));
  }

  async send(rawParams: unknown): Promise<AgentDelegateToolData> {
    const params = normalizeSendParams(rawParams);
    const run = this.resolveRun(params);
    this.assertRunControllable(run, 'steer');
    const message = createUserMessage(params.message);
    if (run.status === 'running' && run.agent) {
      this.markDurableFollowUp(run, message);
      run.agent.followUp(message);
      run.updatedAt = Date.now();
      // The follow-up reaches the ledger through the message_end subscription
      // when the loop drains it — no status change to record here.
      return { ...runToToolData(run), status: 'queued', instructions: 'Message queued for the running background agent.' };
    }

    return this.startContinuation(run, [message], 'Agent continuation started in the background.');
  }

  /** Queue guidance only when the execution is currently live; never revive a terminal Run. */
  async sendLive(rawParams: unknown): Promise<AgentDelegateToolData> {
    const params = normalizeSendParams(rawParams);
    const run = this.resolveRun(params);
    this.assertRunControllable(run, 'steer');
    if (run.status !== 'running' || !run.agent || !this.hasLiveRun(run.id)) {
      throw new Error(`Agent ${run.id} is no longer running and cannot receive live Session guidance.`);
    }
    const message = createUserMessage(params.message);
    this.markDurableFollowUp(run, message);
    run.agent.followUp(message);
    run.updatedAt = Date.now();
    return {
      ...runToToolData(run),
      status: 'queued',
      instructions: 'Message queued for the running background agent.',
    };
  }

  /** Persist a system follow-up before exposing it to the model. */
  async enqueuePersistedFollowUp(rawParams: unknown): Promise<AgentDelegateToolData> {
    const params = normalizeSendParams(rawParams);
    const run = this.resolveRun(params);
    this.assertRunControllable(run, 'steer');
    const message = createHiddenUserMessage(params.message);
    if (run.status === 'running' && run.agent) {
      this.markDurableFollowUp(run, message);
      run.agent.followUp(message);
      run.updatedAt = Date.now();
      return { ...runToToolData(run), status: 'queued', instructions: 'Message queued for the running background agent.' };
    }

    return this.startContinuation(
      run,
      null,
      'Agent continuation started from the persisted follow-up.',
      message,
    );
  }

  /** Resume a persisted tail message without appending it a second time. */
  async resumePersistedFollowUp(rawParams: unknown): Promise<AgentDelegateToolData> {
    const params = normalizeRunSelector(rawParams);
    const durableFollowUpMarkers = isPlainRecord(rawParams)
      ? coerceStringArray(rawParams.durableFollowUpMarkers)
      : undefined;
    const run = this.resolveRun(params);
    this.assertRunControllable(run, 'steer');
    if (run.status === 'running' && run.agent) {
      return { ...runToToolData(run), status: 'queued', instructions: 'Persisted message is already assigned to the running background agent.' };
    }

    return this.startContinuation(
      run,
      [createHiddenUserMessage(
        'Resume processing the pending durable follow-up already present in this Agent Session transcript.',
      )],
      'Agent continuation resumed from the existing persisted tail.',
      undefined,
      durableFollowUpMarkers,
    );
  }

  private async startContinuation(
    run: DelegationRunState,
    messages: AgentMessage[] | null,
    instructions: string,
    persistedMessage?: AgentMessage,
    restoredDurableFollowUpMarkers?: readonly string[],
  ): Promise<AgentDelegateToolData> {
    const releaseStartupSlot = this.reserveRunningSlot();
    const previousUpdatedAt = run.updatedAt;
    run.startupInFlight = true;
    try {
      this.invalidateVerificationFrame(run, `Run ${run.id} verification was invalidated by continuation.`);
      await this.stopLiveVerifierChildren(run);
      // A terminal Run can still have its previous execution frame unwinding.
      // Always rebuild from the ledger so the old frame loses the agent-identity
      // guard and cannot persist over the new continuation.
      run.agent?.abort();
      run.agent = undefined;
      // No live agent (restart restore, or a stopped run): rebuild the
      // continuation context from the run's OWN ledger and re-register its
      // writer — restore-on-open is records-only, so this is where the
      // transcript actually loads. A missing ledger degrades to an empty
      // context (the writer is registered empty), keeping the run resumable.
      if (!run.agent) {
        const restored = await this.host.restoreRunLedger(run.id);
        run.messages = (restored ?? []).map(cloneAgentMessage);
        run.toolResultBudgetState = restoreToolResultBudgetStateFromAgentMessages(run.messages);
        run.activeDurableFollowUpTexts.clear();
        const markerSet = new Set(restoredDurableFollowUpMarkers ?? []);
        for (const message of run.messages) {
          if (message.role !== 'user') continue;
          const texts = messageTextParts(message);
          const carriesPendingDelivery = markerSet.size > 0
            ? texts.some((text) => [...markerSet].some((marker) => text.includes(marker)))
            : texts.some((text) => text.includes('tenon-issue-delivery:'));
          if (!carriesPendingDelivery) continue;
          for (const text of texts) run.activeDurableFollowUpTexts.add(text);
        }
      }
      if (persistedMessage) await this.persistFollowUp(run, persistedMessage);
      // Rebuild the live agent BEFORE mutating run state: if the harness build
      // throws, the run keeps its prior terminal (result + status) instead of
      // being stranded as `running` with no agent and its result wiped.
      await this.ensureLiveAgent(run);
      const liveAgent = run.agent as Agent | undefined;
      if (!liveAgent) throw new Error(`Agent ${run.id} could not be restored for continuation.`);
      const updatedAt = Math.max(Date.now(), previousUpdatedAt + 1);
      const runningSnapshot: AgentRunSnapshot = {
        ...snapshotRun(run),
        status: 'running',
        objectiveStatus: 'active',
        error: undefined,
        blockedReason: undefined,
        result: undefined,
        completedAt: undefined,
        updatedAt,
      };
      await this.host.runStatusChanged(runningSnapshot);
      run.status = 'running';
      run.objectiveStatus = 'active';
      run.error = undefined;
      run.blockedReason = undefined;
      // Clear the prior terminal's salvaged/completed result so a resumed run
      // that stops or fails again cannot surface the previous run's stale output.
      run.result = undefined;
      run.latestSubmission = undefined;
      run.submittedResult = undefined;
      run.completedAt = undefined;
      run.incomplete = undefined;
      run.detached = true;
      run.terminalNotificationSent = false;
      run.updatedAt = updatedAt;
      // The restored history is the continuation seed, not this run's output:
      // salvage on a later `stop` starts after it (the new prompt + response
      // appended by `runChildAgent` below come after this floor).
      run.salvageFromIndex = liveAgent.state.messages.length;
      for (const message of messages ?? []) this.markDurableFollowUp(run, message);
      // The continuation call itself processes every delivery marker already on
      // the restored active path. Only markers that arrive after it starts need
      // an extra `agent.continue()` from the detached-child waiter.
      run.processedControllerDeliveryCount = this.activeIssueDeliveryCount(run);
      releaseStartupSlot();
      run.startupInFlight = false;
      run.completion = this.runChildAgent(run, messages, undefined, true);
      return { ...runToToolData(run), status: 'queued', instructions };
    } catch (error) {
      run.startupInFlight = false;
      run.agent?.abort();
      run.agent = undefined;
      releaseStartupSlot();
      throw error;
    }
  }

  private async persistFollowUp(run: DelegationRunState, message: AgentMessage): Promise<void> {
    await this.host.runMessage(snapshotRun(run), message);
    run.messages.push(cloneAgentMessage(message));
    run.ledgerSeededMessages.add(message);
    for (const text of messageTextParts(message)) run.activeDurableFollowUpTexts.add(text);
  }

  private markDurableFollowUp(run: DelegationRunState, message: AgentMessage): void {
    run.durableFollowUpMessages.add(message);
    for (const text of messageTextParts(message)) run.activeDurableFollowUpTexts.add(text);
  }

  private invalidateVerificationFrame(run: DelegationRunState, reason: string): AbortController | undefined {
    run.lifecycleEpoch += 1;
    const controller = run.verificationAbortController;
    run.verificationAbortController = undefined;
    controller?.abort(new Error(reason));
    return controller;
  }

  private async stopLiveVerifierChildren(run: DelegationRunState): Promise<void> {
    const liveVerifierChildren = this.directChildrenOf(run).filter((child) => (
      child.purpose === 'verify'
      && (child.status === 'running' || child.startupInFlight || child.executionInFlightCount > 0)
    ));
    await Promise.all(liveVerifierChildren.map((child) => this.stopRun(child)));
  }

  private activeIssueDeliveryCount(run: DelegationRunState): number {
    return [...run.activeDurableFollowUpTexts]
      .filter((text) => text.includes('tenon-issue-delivery:'))
      .length;
  }

  async amend(rawParams: unknown): Promise<AgentDelegateToolData> {
    const params = normalizeAmendParams(rawParams);
    const run = this.resolveRun({ runId: params.runId });
    this.assertRunControllable(run, 'amend');
    const contractChanged = params.changes.objective !== undefined || params.changes.criteria !== undefined;
    const budgetAmendment = params.changes.budget !== undefined
      ? prepareRunBudgetAmendment(
          params.changes.budget,
          run.budget,
          run.parentBudgetRef,
          run.budgetSettled === true,
          Date.now(),
        )
      : undefined;
    const verificationAbortController = contractChanged
      ? this.invalidateVerificationFrame(run, `Run ${run.id} verification was invalidated by amendment.`)
      : undefined;
    if (contractChanged && verificationAbortController && run.status === 'running') {
      run.agent?.abort();
      run.agent = undefined;
      run.status = 'completed';
      run.result = undefined;
      run.completedAt = Math.max(Date.now(), run.updatedAt + 1);
      run.updatedAt = run.completedAt;
      settleRunBudget(run);
    }
    if (contractChanged) await this.stopLiveVerifierChildren(run);
    if (params.changes.objective !== undefined) {
      run.objective = params.changes.objective;
      run.description = compactInlineText(run.objective).slice(0, 200) || run.description;
    }
    if (params.changes.criteria !== undefined) run.criteria = params.changes.criteria;
    if (contractChanged && run.objective) run.prompt = buildObjectivePrompt(run.objective, run.criteria);
    if (budgetAmendment) {
      if (budgetAmendment.parentReservedTokens !== undefined && run.parentBudgetRef) {
        run.parentBudgetRef.reservedTokens = budgetAmendment.parentReservedTokens;
      }
      run.budget = budgetAmendment.budget;
    }
    if (contractChanged) {
      run.objectiveStatus = 'active';
      run.blockedReason = undefined;
      run.latestVerifierGap = undefined;
      run.verifierGapSignatures = [];
    }
    if (budgetAmendment) run.budgetTimerRefresh?.();
    run.updatedAt = Date.now();
    const amendmentMessage = createHiddenUserMessage(buildRunAmendmentPrompt(run, params.changes));
    // Persist the amended metadata and model-facing reminder in one ledger
    // append so recovery can never observe a new contract with old context.
    await this.host.runStatusChanged(snapshotRun(run), amendmentMessage);
    run.messages.push(cloneAgentMessage(amendmentMessage));
    run.ledgerSeededMessages.add(amendmentMessage);
    for (const text of messageTextParts(amendmentMessage)) run.activeDurableFollowUpTexts.add(text);
    if (run.status === 'running' && run.agent) {
      run.agent.followUp(amendmentMessage);
    } else if (contractChanged) {
      run.agent?.abort();
      run.agent = undefined;
    }
    return {
      ...runToToolData(run),
      instructions: contractChanged
        ? 'Execution contract was amended durably. Existing verifier conclusions were invalidated; use Agent Session messaging for execution guidance if needed.'
        : 'Execution budget was amended durably without invalidating the current verifier conclusion.',
    };
  }

  async stop(rawParams: unknown): Promise<AgentDelegateToolData> {
    const params = normalizeRunSelector(rawParams);
    const run = this.resolveRun(params);
    this.assertRunControllable(run, 'stop');
    await this.stopRun(run);
    return runToToolData(run);
  }

  private async stopRun(run: DelegationRunState): Promise<void> {
    const verifying = run.status === 'completed' && run.objectiveStatus === 'verifying';
    if (run.status !== 'running' && !verifying) return;

    const wasDetached = run.detached;
    if (run.status === 'running') run.status = 'cancelled';
    run.objectiveStatus = 'stopped';
    run.completedAt = Math.max(Date.now(), run.updatedAt + 1);
    run.updatedAt = run.completedAt;
    // Salvage whatever the CURRENT live span produced before we abort, so the
    // synchronous tool result and the terminal notification carry the partial
    // work instead of an empty result. Scan only from `salvageFromIndex` (the
    // resume/compaction floor) so a resumed run stopped before it produces new
    // output reports nothing stale — the prior round's text sits below the
    // floor. Completion uses the same span boundary and adds its explicit
    // no-text fallback; stop keeps the raw partial semantics.
    if (run.status === 'cancelled' && run.agent) {
      const since = run.salvageFromIndex ?? 0;
      const liveSpan = (run.agent.state.messages as AgentMessage[]).slice(since);
      const partial = extractPartialAssistantText(liveSpan);
      if (partial !== undefined) run.result = partial;
    }
    run.agent?.abort();
    run.agent = undefined;
    this.invalidateVerificationFrame(run, `Run ${run.id} verification was stopped.`);
    // Mark the controller stopped before aborting its verifier so the awaiting
    // verification frame cannot overwrite the stop with a late verdict.
    await this.stopLiveVerifierChildren(run);
    run.objectiveStatus = 'stopped';
    run.updatedAt = Math.max(Date.now(), run.updatedAt);
    run.completedAt = Math.max(run.completedAt ?? 0, run.updatedAt);
    // Nulling `run.agent` makes runChildAgent's finally guard fail, so settle the
    // parent reservation here instead of waiting for that frame.
    settleRunBudget(run);
    await this.host.runStatusChanged(snapshotRun(run));
    if (run.status === 'cancelled' && wasDetached) {
      void this.notifyTerminalRun(run).catch(() => undefined);
    }
  }

  private async startAgent(
    params: AgentToolParams,
    releaseStartupSlot: RunningSlotReservation,
    signal?: AbortSignal,
    parentToolCallId?: string,
    onAccepted?: AgentRunAcceptedCallback,
  ): Promise<AgentDelegateToolData> {
    throwIfAborted(signal);
    const contextMode = params.context;
    const scope = params.scopePreauthorized
      ? params.scope
      : narrowRunScope(this.inheritedScope, params.scope);
    const effectiveParams = { ...params, scope };
    const scopedAllowedTools = scopedAllowedToolNames(params.allowedTools, scope);
    const definition = restrictAgentDefinitionTools(createForkAgentDefinition(), scopedAllowedTools);

    this.assertCanDescend(definition.name);
    const name = params.name?.trim();
    if (name && this.names.has(name)) throw new Error(`Agent name is already in use in this session: ${name}`);

    const runId = `child-${randomUUID()}`;
    const parentAgentId = this.host.getParentAgentId?.() ?? this.executingAgentId;
    const parentMemoryOwnerAgentId = this.host.getParentMemoryOwnerAgentId?.() ?? this.memoryOwnerAgentId;
    // A fork runs AS its spawner (Neva): it inherits the parent's executing and
    // memory-owner identity, never its own.
    const executingAgentId = parentAgentId;
    const memoryOwnerAgentId = parentMemoryOwnerAgentId;
    const memoryOriginWorkspace = memoryWorkspaceIdForRoot(this.localRoot);
    const background = params.detach === true || definition.background === true;
    const now = Date.now();
    const parentBudget = params.parentBudget ?? this.inheritedBudget;
    const budget = admitRunBudget(parentBudget, params.budget, now, background);
    let run: DelegationRunState | null = null;
    let childAgentHarness;
    try {
      childAgentHarness = await this.buildChildAgentHarness({
        runId,
        definition,
        scope,
        budget,
        executingAgentId,
        parentAgentId,
        memoryOwnerAgentId,
        memoryOriginWorkspace,
        model: params.model,
        effort: params.effort,
        preapprovedToolRules: params.preapprovedToolRules,
        unattended: params.unattended,
        // The child consumes its prompt via `run.messages` + `runChildAgent`, not
        // through the agent's seed messages.
        initialMessages: [],
        afterToolResult: (toolCallId, toolName, result, isError) => (
          run ? this.afterRunToolResult(run, toolCallId, toolName, result, isError) : undefined
        ),
      });
      throwIfAborted(signal);
    } catch (error) {
      childAgentHarness?.childAgent.abort();
      // The run object never formed, so runChildAgent's finally can never settle
      // the parent reservation admitRunBudget made above — release it here.
      releaseAdmittedRunBudget(parentBudget, budget);
      throw error;
    }
    const { skillRuntime, localWorkspace, childAgent, subRunRuntime } = childAgentHarness;
    // The ledger seed split ([[agent-run-unification]]): the inherited fork-context
    // prefix lands BEFORE `run.started` and is excluded from Dream evidence; the
    // fork directive lands after it — the boundary `dreamEvidenceStartMessageIndex`
    // expresses positionally.
    const contextMessages = buildRunContextMessages(this.host.getParentMessages(), contextMode);
    const evidenceMessages = [createHiddenUserMessage(buildRunDirective(effectiveParams))];
    const promptMessages = [...contextMessages, ...evidenceMessages];

    const ledgerSeededMessages = new WeakSet<AgentMessage>();
    for (const message of promptMessages) ledgerSeededMessages.add(message);
    run = {
      id: runId,
      name,
      description: params.description,
      prompt: params.runPrompt,
      objective: params.objective,
      criteria: params.criteria,
      objectiveRole: params.objectiveRole,
      objectiveStatus: params.verify ? 'active' : undefined,
      purpose: params.purpose,
      scope,
      budget,
      disposition: background ? 'detached' : 'attended',
      agentType: definition.name,
      contextMode,
      runProfile: params.runProfile ?? runProfileForPurpose(params.purpose),
      definition,
      executingAgentId,
      parentAgentId,
      parentRunId: params.parentRunId ?? this.host.getActiveRunId() ?? undefined,
      memoryOwnerAgentId,
      memoryOriginWorkspace,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      depth: this.depth + 1,
      agent: childAgent,
      messages: [...promptMessages],
      ledgerSeededMessages,
      durableFollowUpMessages: new WeakSet(),
      activeDurableFollowUpTexts: new Set(),
      startupInFlight: false,
      executionInFlightCount: 0,
      completion: Promise.resolve(),
      detached: background,
      terminalNotificationSent: false,
      turnCount: 0,
      verify: params.verify,
      verificationAttemptBase: params.inheritedVerificationAttempts ?? 0,
      verificationAttempts: params.inheritedVerificationAttempts ?? 0,
      verifierRunIds: [...(params.inheritedVerifierRunIds ?? [])],
      hasWorkChildren: false,
      latestVerifierGap: undefined,
      processedControllerDeliveryCount: 0,
      parentBudgetRef: parentBudget,
      budgetSettled: false,
      parentToolCallId,
      preapprovedToolRules: params.preapprovedToolRules,
      unattended: params.unattended,
      toolResultBudgetState: createToolResultBudgetState(),
      nodeChanges: {},
      fileChanges: {},
      toolTrace: [],
      verifierGapSignatures: [...(params.inheritedVerifierGapSignatures ?? [])],
      lifecycleEpoch: 0,
      autoCompactConsecutiveFailures: 0,
      autoCompactInProgress: false,
      skillRuntime,
      localWorkspace,
      subRunRuntime,
    };
    this.runs.set(runId, run);
    if (name) this.names.set(name, runId);
    releaseStartupSlot();
    this.subscribeToChild(run);
    this.installRunContextTransform(run);
    let startAnnounced = false;
    try {
      throwIfAborted(signal);
      await onAccepted?.(snapshotRun(run));
      throwIfAborted(signal);
      await this.host.runStarted(snapshotRun(run), { contextMessages, evidenceMessages });
      startAnnounced = true;
    } catch (error) {
      // runChildAgent has not been wired yet, so settle here to avoid leaking the
      // parent reservation if the start announcement or acceptance hook throws.
      settleRunBudget(run);
      run.agent?.abort();
      run.agent = undefined;
      if (runWasStopped(run)) throw error;
      if (startAnnounced) {
        run.status = 'failed';
        run.error = error instanceof Error ? error.message : String(error);
        run.completedAt = Math.max(Date.now(), run.updatedAt + 1);
        run.updatedAt = run.completedAt;
        await this.host.runStatusChanged(snapshotRun(run)).catch(() => undefined);
      } else {
        this.runs.delete(run.id);
        if (name && this.names.get(name) === run.id) this.names.delete(name);
      }
      throw error;
    }

    run.completion = this.runChildAgent(run, promptMessages, background ? undefined : signal, background);
    if (background) {
      return {
        ...runToToolData(run),
        status: 'async_launched',
        instructions: 'The Agent Session is running in the background. Tenon will notify you automatically when it finishes; use Agent Session tools for explicit inspection or control.',
      };
    }

    const acceptedReplacement = await run.completion;
    return acceptedReplacement ?? runToToolData(run);
  }

  /**
   * Build the per-run agent harness — skill runtime, local workspace, nested
   * delegation runtime, and the live `Agent` — shared by the spawn (`startAgent`)
   * and resume (`ensureLiveAgent`) paths. One wiring means a setup step (e.g. the
   * disabled-skill/agent gates) can never be applied on spawn and silently missed
   * on resume — the fragile seam the run tree used to have. Resume therefore
   * honors the CURRENT disabled-skill/agent settings by design: a run resumed
   * after its skill/agent was disabled is denied that skill/agent (ratified).
   */
  private async buildChildAgentHarness(input: {
    runId: string;
    definition: AgentDefinition;
    scope?: AgentRunScope;
    budget?: AgentRunBudget;
    executingAgentId: string;
    parentAgentId: string;
    memoryOwnerAgentId: string;
    memoryOriginWorkspace?: string;
    model?: string;
    effort?: string;
    preapprovedToolRules?: string[];
    unattended?: boolean;
    initialMessages: AgentMessage[];
    afterToolResult: AgentChildAgentCreateInput['afterToolResult'];
  }): Promise<{
    skillRuntime: AgentSkillRuntime;
    localWorkspace: AgentLocalWorkspaceContext;
    childAgent: Agent;
    subRunRuntime: AgentDelegationRuntime;
  }> {
    const childConversationId = `${this.hostConversationPrefix()}-${input.runId}`;
    const runtimeSettings = await this.host.getRuntimeSettings();
    let subRunRuntime: AgentDelegationRuntime;
    let childAgent: Agent | null = null;
    const skillRuntime = new AgentSkillRuntime({
      localRoot: this.localRoot,
      additionalSkillDirectories: runtimeSettings.additionalSkillDirectories,
      provenanceStore: createAgentSkillProvenanceStore(),
      conversationId: childConversationId,
      executeIsolatedSkill: async ({ skill, renderedContent, parentToolCallId, readOnlyIsolated }) => {
        const data = await subRunRuntime.invokeSkillChildAgent({
          skillName: skill.name,
          description: skill.description,
          renderedContent,
          model: skill.model,
          effort: skill.effort,
          allowedTools: skill.allowedTools,
          readOnlyIsolated,
        }, undefined, parentToolCallId);
        return {
          runId: data.runId,
          runProfile: data.runProfile,
          status: data.status,
          result: data.result,
          error: data.error,
        };
      },
    });
    skillRuntime.updateDisabledSkills(runtimeSettings.disabledSkills ?? []);
    const localWorkspace = createAgentLocalWorkspaceContext(
      this.localRoot,
      this.scratchRoot,
      skillRuntime,
      this.protectedStoreRoot,
    );
    // A sub-run runs AS its spawner, so it inherits the spawner's approval
    // attribution. The nested runtime carries it so deeper sub-runs inherit it.
    const requestedByAgentId = this.requestedByAgentId;
    subRunRuntime = new AgentDelegationRuntime({
      conversationId: childConversationId,
      executingAgentId: input.executingAgentId,
      memoryOwnerAgentId: input.memoryOwnerAgentId,
      requestedByAgentId,
      localRoot: this.localRoot,
      scratchRoot: this.scratchRoot,
      protectedStoreRoot: this.protectedStoreRoot,
      depth: this.depth + 1,
      maxDepth: this.maxDepth,
      ancestry: [...this.ancestry, input.definition.name],
      scope: input.scope,
      budget: input.budget,
      // A nested sub-run's parent run is THIS Run; the run tree chains.
      host: this.buildChildHost(() => input.runId, () => childAgent),
    });
    subRunRuntime.updateDisabledAgents(runtimeSettings.disabledAgents ?? []);
    const systemPrompt = this.host.getParentSystemPrompt();
    childAgent = this.host.createChildAgent({
      runId: input.runId,
      conversationId: childConversationId,
      messages: input.initialMessages,
      systemPrompt,
      executingAgentId: input.executingAgentId,
      parentAgentId: input.parentAgentId,
      requestedByAgentId,
      memoryOwnerAgentId: input.memoryOwnerAgentId,
      memoryOriginWorkspace: input.memoryOriginWorkspace,
      model: input.model ?? input.definition.model,
      effort: input.effort ?? input.definition.effort,
      permissionMode: input.definition.permissionMode,
      maxTurns: input.definition.maxTurns,
      skillRuntime,
      localWorkspace,
      delegationRuntime: subRunRuntime,
      scope: input.scope,
      allowedTools: input.definition.tools,
      disallowedTools: input.definition.disallowedTools,
      preapprovedToolRules: input.preapprovedToolRules,
      l0CacheBreakpointEnabled: false,
      unattended: input.unattended,
      blockForInput: (reason) => this.blockRunForInput(input.runId, reason),
      afterToolResult: input.afterToolResult,
    });
    return { skillRuntime, localWorkspace, childAgent, subRunRuntime };
  }

  private async preloadAgentSkills(definition: AgentDefinition, skillRuntime: AgentSkillRuntime): Promise<UserMessage[]> {
    const messages: UserMessage[] = [];
    for (const skill of definition.skills ?? []) {
      const invocation = await skillRuntime.invokeSkill({ skill, trigger: 'agent' });
      if (invocation.ok) messages.push(invocation.message);
    }
    return messages;
  }

  private subscribeToChild(run: DelegationRunState): void {
    if (!run.agent) return;
    const subscribedAgent = run.agent;
    subscribedAgent.subscribe(async (event: AgentEvent) => {
      if (run.agent !== subscribedAgent) return;
      if (event.type === 'turn_end') {
        run.turnCount += 1;
        run.updatedAt = Date.now();
        if (run.definition?.maxTurns && run.turnCount >= run.definition.maxTurns && run.agent?.state.isStreaming) {
          // The model still wanted to continue but hit the turn cap: this is a
          // truncation, not a finish. Mark it so a caller that treats
          // "completed + empty" as a deliberate outcome (Dream's no-op) does not
          // advance past unfinished work. (A clean finish exactly AT the cap does
          // not stream after turn_end, so this branch does not fire for it.)
          run.incomplete = true;
          run.agent.abort();
        }
        return;
      }
      if (event.type === 'message_end') {
        // The loop re-emits message_end for its prompt INPUTS too — skip the
        // messages the ledger (and run.messages) were already seeded with at
        // spawn, so neither records them twice.
        if (run.ledgerSeededMessages.has(event.message as AgentMessage)) return;
        if (isRecordableAgentMessage(event.message)) {
          const message = event.message as AgentMessage;
          run.messages.push(cloneAgentMessage(message));
          run.updatedAt = Date.now();
          const durableBeforeContinue = run.durableFollowUpMessages.has(message);
          const persist = this.host.runMessage(snapshotRun(run), message).catch((error) => {
            const message = `Failed to append a Run message to the ${run.id} ledger: ${error instanceof Error ? error.message : String(error)}`;
            if (this.host.reportError) {
              this.host.reportError({
                domain: 'persistence',
                severity: 'warn',
                code: 'run-message-ledger-failed',
                message,
                context: { runId: run.id, operation: 'runMessage' },
                error,
              });
            } else {
              console.warn(message);
            }
            throw error;
          });
          if (durableBeforeContinue) {
            await persist;
            run.durableFollowUpMessages.delete(message);
          } else {
            // Ordinary transcript persistence remains best-effort. A durable
            // Issue-delivery marker is the exception above: the loop cannot
            // expose it to the model until its append has settled.
            void persist.catch(() => undefined);
          }
        }
      }
    });
  }

  private async runChildAgent(
    run: DelegationRunState,
    messages: AgentMessage[] | null,
    signal: AbortSignal | undefined,
    detached: boolean,
  ): Promise<AgentDelegateToolData | void> {
    if (!run.agent) throw new Error(`Agent ${run.id} is not live in this process.`);
    const agent = run.agent;
    run.executionInFlightCount += 1;
    this.host.runExecutionStarted?.(snapshotRun(run));
    const abort = () => agent.abort();
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const exhaustWallClockBudget = (message: string) => {
      if (run.agent !== agent || run.status !== 'running') return;
      run.status = 'failed';
      run.objectiveStatus = 'budget_exhausted';
      run.error = message;
      run.blockedReason = run.error;
      run.completedAt = Math.max(Date.now(), run.updatedAt + 1);
      run.updatedAt = run.completedAt;
      agent.abort();
    };
    const refreshBudgetTimer = () => {
      if (budgetTimer) clearTimeout(budgetTimer);
      budgetTimer = undefined;
      if (run.agent !== agent || run.status !== 'running') return;
      const remaining = remainingBudgetMs(run);
      if (remaining === null) return;
      if (remaining <= 0) {
        exhaustWallClockBudget('Run wall-clock budget exhausted.');
        return;
      }
      budgetTimer = setTimeout(() => {
        budgetTimer = undefined;
        if (run.agent !== agent || run.status !== 'running') return;
        const nextRemaining = remainingBudgetMs(run);
        if (nextRemaining !== null && nextRemaining > 0) {
          refreshBudgetTimer();
          return;
        }
        exhaustWallClockBudget('Run wall-clock budget exhausted.');
      }, Math.min(remaining, MAX_SETTIMEOUT_DELAY_MS));
    };
    run.budgetTimerRefresh = refreshBudgetTimer;
    const budgetDelayMs = remainingBudgetMs(run);
    if (signal && !detached) {
      if (signal.aborted) abort();
      signal.addEventListener('abort', abort, { once: true });
    }
    if (budgetDelayMs !== null) {
      if (budgetDelayMs <= 0) {
        exhaustWallClockBudget('Run budget exhausted before execution could start.');
      } else {
        // Re-arm in 32-bit-safe hops so a far-future deadline is honored at the
        // real time instead of overflowing setTimeout and killing the run early.
        refreshBudgetTimer();
      }
    }
    const workingSetSnapshot = run.verify && run.purpose !== 'verify'
      ? await captureWorkingSetSnapshot(this.localRoot, run.scope).catch(() => undefined)
      : undefined;
    const controllerRunIdsAtFrameStart = new Set(
      this.directChildrenOf(run)
        .filter((child) => child.objectiveRole === 'controller')
        .map((child) => child.id),
    );
    try {
      let nextMessages = messages;
      while (run.status === 'running') {
        throwIfAborted(signal);
        if (nextMessages === null) await agent.continue();
        else await agent.prompt(nextMessages);
        if (run.agent !== agent) return;
        const terminalAssistant = lastAssistantMessage(agent.state.messages as AgentMessage[]);
        if (terminalAssistant && isContextOverflow(terminalAssistant, agent.state.model.contextWindow)) {
          const compacted = await this.compactRunMessages(run, agent.state.messages as AgentMessage[], 'reactive', signal);
          if (compacted) {
            throwIfAborted(signal);
            await agent.continue();
            if (run.agent !== agent) return;
          }
        }
        const detachedChildContinuation = await this.completedDetachedChildRunContinuation(
          run,
          agent,
          signal,
          controllerRunIdsAtFrameStart,
        );
        if (!detachedChildContinuation) break;
        nextMessages = detachedChildContinuation === 'continue' ? null : detachedChildContinuation;
      }
      if (run.agent !== agent) return;
      if (run.status === 'running') {
        const errorMessage = agent.state.errorMessage;
        if (errorMessage) {
          run.status = 'failed';
          run.error = errorMessage;
        } else {
          run.status = 'completed';
          const since = run.salvageFromIndex ?? 0;
          run.result = extractFinalAssistantText((agent.state.messages as AgentMessage[]).slice(since));
          await this.submitCompletedRunResult(run);
          // A run can reach 'completed' without the model deciding it was done.
          // The maxTurns abort already flags run.incomplete inline (:814). The
          // other truncation is an unresolved context overflow: the final turn is
          // still over the window (reactive compaction declined, or a continuation
          // overflowed again). Flag it so a caller that treats "completed + empty"
          // as a deliberate outcome (Dream's no-op) does not mistake truncation
          // for a finish.
          const finalAssistant = lastAssistantMessage(agent.state.messages as AgentMessage[]);
          if (finalAssistant && isContextOverflow(finalAssistant, agent.state.model.contextWindow)) {
            run.incomplete = true;
          }
        }
        run.completedAt = Math.max(Date.now(), run.updatedAt + 1);
        run.updatedAt = run.completedAt;
      }
      if (run.agent === agent && workingSetSnapshot) {
        await recordWorkingSetDiff(run.fileChanges, this.localRoot, workingSetSnapshot, run.scope).catch(() => undefined);
      }
      if (run.agent === agent && run.status === 'completed') {
        return await this.verifyCompletedRun(run, signal, detached);
      }
    } catch (error) {
      if (run.agent !== agent) return;
      if (run.status === 'running') {
        run.status = 'failed';
        run.error = error instanceof Error ? error.message : String(error);
        run.completedAt = Math.max(Date.now(), run.updatedAt + 1);
        run.updatedAt = run.completedAt;
      }
    } finally {
      if (budgetTimer) clearTimeout(budgetTimer);
      if (run.budgetTimerRefresh === refreshBudgetTimer) run.budgetTimerRefresh = undefined;
      if (signal && !detached) signal.removeEventListener('abort', abort);
      if (run.agent === agent) {
        if (run.status !== 'running') settleRunBudget(run);
        let terminalPersisted = false;
        try {
          await this.host.runStatusChanged(snapshotRun(run));
          terminalPersisted = true;
        } catch {
          // The durable ledger/store remains authoritative. A failed terminal
          // write leaves follow-up payloads retained for a later retry.
        }
        if (terminalPersisted && run.status === 'completed') run.activeDurableFollowUpTexts.clear();
        if (detached) void this.notifyTerminalRun(run).catch(() => undefined);
      }
      run.executionInFlightCount = Math.max(0, run.executionInFlightCount - 1);
      try {
        await this.host.runExecutionSettled?.(snapshotRun(run));
      } catch {
        // Terminal persistence is already authoritative. A settlement hook is
        // best-effort coordination for follow-up work such as outbox retries.
      }
    }
  }

  private async submitCompletedRunResult(run: DelegationRunState): Promise<void> {
    if (run.status !== 'completed') return;
    if (run.purpose === 'verify') return;
    const summary = run.result?.trim();
    if (!summary) return;
    if (run.submittedResult === summary) return;
    try {
      const submission = await this.host.runResultSubmitted(snapshotRun(run), {
        summary,
        source: 'final_assistant_message',
      });
      if (!submission) return;
      run.latestSubmission = submission;
      run.submittedResult = summary;
    } catch (error) {
      this.host.reportError?.({
        domain: 'persistence',
        severity: 'warn',
        code: 'run-result-submission-ledger-failed',
        message: `Failed to append run result submission for ${run.id}: ${errorMessage(error)}`,
        context: { conversationId: this.conversationId, runId: run.id, operation: 'run.result.submitted' },
        error,
      });
    }
  }

  private async completedDetachedChildRunContinuation(
    run: DelegationRunState,
    agent: Agent,
    signal: AbortSignal | undefined,
    controllerRunIdsAtFrameStart: ReadonlySet<string>,
  ): Promise<AgentMessage[] | 'continue' | null> {
    const genericChildren = () => this.directChildrenOf(run).filter((child) => (
      child.purpose !== 'verify'
      && child.objectiveRole !== 'controller'
      && child.disposition === 'detached'
    ));
    const controllerChildren = () => this.directChildrenOf(run).filter((child) => (
      child.objectiveRole === 'controller'
      && child.disposition === 'detached'
      && !controllerRunIdsAtFrameStart.has(child.id)
    ));
    const issueDeliveryCount = () => this.activeIssueDeliveryCount(run);
    const deliveredControllerRunIds = () => issueDeliveryExecutionIds([
      ...run.messages,
      ...(run.agent?.state.messages as AgentMessage[] | undefined ?? []),
    ]);
    let children = genericChildren();
    let controllers = controllerChildren();
    const availableDeliveries = issueDeliveryCount();
    if (run.processedControllerDeliveryCount < availableDeliveries) {
      run.processedControllerDeliveryCount += 1;
      return 'continue';
    }
    if (children.length === 0 && controllers.length === 0) return null;

    while (
      run.agent === agent
      && run.status === 'running'
      && (
        children.some((child) => !isDetachedChildReadyForParentSummary(child))
        || controllers.some((child) => !isDetachedChildReadyForParentSummary(child))
        || controllers.some((child) => !deliveredControllerRunIds().has(child.id))
      )
    ) {
      throwIfAborted(signal);
      await delay(50);
      children = genericChildren();
      controllers = controllerChildren();
    }
    if (run.agent !== agent || run.status !== 'running') return null;

    const availableControllerDeliveries = issueDeliveryCount();
    if (run.processedControllerDeliveryCount < availableControllerDeliveries) {
      run.processedControllerDeliveryCount += 1;
      return 'continue';
    }

    const summaryChildren = children.filter((child) => !isSupersededDetachedChildAttempt(child));
    if (summaryChildren.length === 0) return null;

    for (const child of summaryChildren) await this.hydrateLatestSubmission(child);
    const summaryKey = detachedChildRunSummaryKey(summaryChildren);
    if (run.summarizedDetachedChildRunKey === summaryKey) return null;
    run.summarizedDetachedChildRunKey = summaryKey;

    return [createHiddenUserMessage(buildDetachedChildRunCompletionPrompt(summaryChildren))];
  }

  private async verifyCompletedRun(
    run: DelegationRunState,
    signal: AbortSignal | undefined,
    detached: boolean,
  ): Promise<AgentDelegateToolData | void> {
    if (run.purpose === 'verify') {
      run.objectiveStatus = 'verified';
      run.updatedAt = Date.now();
      return;
    }
    if (!run.verify) return;
    if (!run.criteria || run.criteria.length === 0) {
      run.objectiveStatus = 'blocked';
      run.blockedReason = 'Run verification is enabled but no acceptance criteria were provided.';
      run.updatedAt = Date.now();
      return;
    }
    if (run.objectiveStatus === 'verified') return;
    const lifecycleEpoch = run.lifecycleEpoch;
    const verificationAbortController = new AbortController();
    run.verificationAbortController = verificationAbortController;
    const verificationSignal = chainAbortSignals(signal, verificationAbortController);
    const verificationIsCurrent = () => (
      run.verificationAbortController === verificationAbortController
      && run.lifecycleEpoch === lifecycleEpoch
      && !verificationSignal?.aborted
      && !runWasStopped(run)
    );
    try {
      run.objectiveStatus = 'verifying';
      run.updatedAt = Date.now();
      await this.host.runStatusChanged(snapshotRun(run)).catch(() => undefined);
      if (!verificationIsCurrent()) return;

      run.verificationAttempts += 1;
      // The verifier runs AFTER the work completed, so the work run's wall-clock
      // deadline has been counting down the whole time: requesting the original
      // budget would exceed the parent's *remaining* time and be rejected at
      // admission. Request only what is left (capped at the default), so a budgeted
      // run can actually be verified instead of being marked blocked. A read-only
      // verifier must also stay within the controller's own capability scope, or
      // narrowing rejects the full read-only set as widening.
      let verifier: AgentDelegateToolData;
      let releaseStartupSlot: RunningSlotReservation | undefined;
      // Serializes nodeChanges/fileChanges + up to 40 tool-trace entries — build it
      // once and reuse it for both the objective and the prompt.
      const verifierObjective = buildVerifierObjective(run);
      try {
        releaseStartupSlot = this.reserveRunningSlot();
        verifier = await this.startAgent({
          objective: verifierObjective,
          criteria: ['Return a JSON verdict that independently checks every acceptance criterion.'],
          verify: false,
          description: `verify ${run.description}`,
          runPrompt: verifierObjective,
          purpose: 'verify',
          objectiveRole: 'verifier',
          context: 'none',
          runProfile: 'verify',
          scope: verifierRunScope(run.scope),
          budget: verifierBudgetForRun(run),
          allowedTools: verifierAllowedToolNames(run.scope, run.definition?.tools),
          parentRunId: run.id,
          parentBudget: run.budget,
          unattended: true,
        }, releaseStartupSlot, verificationSignal);
      } catch (error) {
        releaseStartupSlot?.();
        if (!verificationIsCurrent()) return;
        run.objectiveStatus = 'blocked';
        run.blockedReason = `Verifier failed to start: ${errorMessage(error)}`;
        run.updatedAt = Date.now();
        await this.host.runStatusChanged(snapshotRun(run)).catch(() => undefined);
        return;
      }

      run.verifierRunIds.push(verifier.runId);
      if (!verificationIsCurrent()) return;
      // A verifier that did not itself complete (model error, context overflow,
      // abort) produced no verdict. Treat that as inconclusive — block for triage
      // — never as a `fail` verdict, which would fabricate a phantom gap and burn
      // budget replanning/replacing against it.
      if (verifier.status !== 'completed' || !verifier.result?.trim()) {
        run.objectiveStatus = 'blocked';
        run.blockedReason = `Verification could not complete: ${verifier.error?.trim() || 'verifier returned no verdict'}.`;
        run.updatedAt = Date.now();
        await this.host.runStatusChanged(snapshotRun(run)).catch(() => undefined);
        return;
      }
      const verdict = parseVerifierVerdict(verifier.result);
      if (verdict.verdict === 'pass') {
        run.objectiveStatus = 'verified';
        run.blockedReason = undefined;
        run.latestVerifierGap = undefined;
        run.verifierGapSignatures = [];
        run.updatedAt = Date.now();
        return;
      }

      run.latestVerifierGap = verdict.gap || 'Verifier rejected the run result.';
      const gapSignature = verifierGapSignature(verdict.gap);
      run.verifierGapSignatures.push(gapSignature);
      if (sameTailCount(run.verifierGapSignatures, gapSignature) >= DEFAULT_VERIFIER_LIVELOCK_REPEAT_LIMIT) {
        run.objectiveStatus = 'blocked';
        run.blockedReason = `Verifier repeated the same gap: ${verdict.gap || 'unspecified gap'}`;
        run.updatedAt = Date.now();
        return;
      }

      if (run.verificationAttempts <= DEFAULT_VERIFIER_RETRY_LIMIT && run.status === 'completed' && remainingBudgetMs(run) !== 0) {
        if (this.isControllerRun(run)) {
          return await this.replanControllerInPlace(run, verdict.gap, verificationSignal, detached);
        }
        return await this.replaceFailedWorkerRun(run, verdict.gap, verificationSignal, detached);
      }

      run.objectiveStatus = remainingBudgetMs(run) === 0 ? 'budget_exhausted' : 'blocked';
      run.blockedReason = verdict.gap || 'Verifier rejected the run result.';
      run.updatedAt = Date.now();
    } finally {
      if (run.verificationAbortController === verificationAbortController) {
        run.verificationAbortController = undefined;
      }
    }
  }

  private isControllerRun(run: DelegationRunState): boolean {
    if (run.objectiveRole === 'controller' || run.hasWorkChildren === true) return true;
    if (run.objectiveRole === 'worker' || run.objectiveRole === 'verifier') return false;
    return Boolean(run.objectiveStatus && !run.parentRunId);
  }

  private async replanControllerInPlace(
    run: DelegationRunState,
    verifierGap: string,
    signal: AbortSignal | undefined,
    detached: boolean,
  ): Promise<AgentDelegateToolData | void> {
    const releaseStartupSlot = this.reserveRunningSlot();
    try {
      throwIfAborted(signal);
      if (!run.agent) {
        const restored = await this.host.restoreRunLedger(run.id);
        run.messages = (restored ?? []).map(cloneAgentMessage);
        run.toolResultBudgetState = restoreToolResultBudgetStateFromAgentMessages(run.messages);
      }
      await this.ensureLiveAgent(run);
      throwIfAborted(signal);
      if (runWasStopped(run)) return;
      run.status = 'running';
      run.objectiveStatus = 'active';
      run.error = undefined;
      run.blockedReason = undefined;
      run.result = undefined;
      run.latestSubmission = undefined;
      run.submittedResult = undefined;
      run.completedAt = undefined;
      run.incomplete = undefined;
      run.terminalNotificationSent = false;
      run.updatedAt = Date.now();
      run.salvageFromIndex = run.agent ? run.agent.state.messages.length : 0;
      await this.host.runStatusChanged(snapshotRun(run)).catch(() => undefined);
      throwIfAborted(signal);
      if (runWasStopped(run)) return;
      releaseStartupSlot();
      run.completion = this.runChildAgent(
        run,
        [createHiddenUserMessage(buildControllerReplanPrompt(run, verifierGap))],
        detached ? undefined : signal,
        detached,
      );
      return await run.completion;
    } catch (error) {
      releaseStartupSlot();
      if (signal?.aborted || runWasStopped(run)) return;
      run.objectiveStatus = 'blocked';
      run.blockedReason = `Verifier rejected this controller, and re-plan failed to start: ${errorMessage(error)}`;
      run.updatedAt = Date.now();
      await this.host.runStatusChanged(snapshotRun(run)).catch(() => undefined);
      return;
    }
  }

  private async replaceFailedWorkerRun(
    run: DelegationRunState,
    verifierGap: string,
    signal: AbortSignal | undefined,
    detached: boolean,
  ): Promise<AgentDelegateToolData | void> {
    const blockedReason = `Verifier rejected this worker attempt: ${verifierGap || 'unspecified gap'}`;
    settleRunBudget(run);

    const releaseStartupSlot = this.reserveRunningSlot();
    const objective = run.objective ?? run.prompt ?? run.description ?? 'Continue the verified run objective.';
    const retryObjective = buildReplacementWorkerObjective(objective, verifierGap);
    try {
      const replacement = await this.startAgent({
        objective: retryObjective,
        criteria: run.criteria,
        verify: true,
        description: run.description,
        runPrompt: buildObjectivePrompt(retryObjective, run.criteria),
        purpose: 'work',
        objectiveRole: run.objectiveRole,
        scope: run.scope,
        budget: retryBudgetSlice(run.budget),
        context: 'none',
        runProfile: run.runProfile,
        detach: detached,
        model: run.definition?.model === 'inherit' ? undefined : run.definition?.model,
        effort: run.definition?.effort,
        allowedTools: run.definition?.tools,
        preapprovedToolRules: run.preapprovedToolRules,
        parentRunId: run.parentRunId,
        inheritedVerificationAttempts: run.verificationAttempts,
        inheritedVerifierGapSignatures: run.verifierGapSignatures,
        inheritedVerifierRunIds: run.verifierRunIds,
        unattended: run.unattended,
      }, releaseStartupSlot, signal, run.parentToolCallId);
      if (signal?.aborted || runWasStopped(run)) {
        const replacementRun = this.runs.get(replacement.runId);
        if (replacementRun) await this.stopRun(replacementRun);
        return;
      }
      run.objectiveStatus = 'blocked';
      run.blockedReason = `${blockedReason}; replacement run ${replacement.runId} started.`;
      // The replacement carries the objective forward and will fire its own
      // terminal notification; suppress this superseded attempt's so the user is
      // not told a rejected run "completed" and then notified again.
      run.terminalNotificationSent = true;
      run.updatedAt = Date.now();
      await this.host.runStatusChanged(snapshotRun(run)).catch(() => undefined);
      return replacement;
    } catch (error) {
      releaseStartupSlot();
      if (signal?.aborted || runWasStopped(run)) return;
      run.objectiveStatus = 'blocked';
      run.blockedReason = `Verifier rejected this worker attempt, and replacement failed to start: ${errorMessage(error)}`;
      run.updatedAt = Date.now();
      await this.host.runStatusChanged(snapshotRun(run)).catch(() => undefined);
      return;
    }
  }

  private async notifyTerminalRun(run: DelegationRunState): Promise<void> {
    if (run.status === 'running') return;
    if (run.terminalNotificationSent) return;
    run.terminalNotificationSent = true;
    await this.host.notifyRun(snapshotRun(run));
  }

  private installRunContextTransform(run: DelegationRunState): void {
    if (!run.agent) return;
    run.agent.transformContext = async (_messages, signal) => this.prepareRunModelContext(run, signal);
  }

  private async afterRunToolResult(
    run: DelegationRunState,
    toolCallId: string,
    toolName: string,
    result: unknown,
  isError: boolean,
): Promise<AfterToolCallResult | undefined> {
  recordNodeToolChanges(run.nodeChanges, toolName, result, isError);
  recordFileToolChanges(run.fileChanges, toolName, result, isError);
  recordToolTrace(run.toolTrace, toolName, result, isError);
  if (!isPlainRecord(result) || !Array.isArray(result.content)) return undefined;
    const text = piToolResultTextContent(result.content as Array<TextContent | ImageContent>);
    if (!text || text.length <= DEFAULT_MAX_TOOL_RESULT_CHARS) return undefined;

    try {
      const persisted = await this.host.persistToolOutputPayload(runToolOutputPayloadId(run, toolCallId), toolName, text);
      run.toolResultBudgetState.seenIds.add(toolCallId);
      run.toolResultBudgetState.replacements.set(toolCallId, persisted.label);
      return {
        content: [{ type: 'text', text: persisted.label }],
      };
    } catch {
      run.toolResultBudgetState.seenIds.add(toolCallId);
      return undefined;
    }
  }

  private async prepareRunModelContext(run: DelegationRunState, signal?: AbortSignal): Promise<AgentMessage[]> {
    throwIfAborted(signal);
    const source = ((run.agent?.state.messages as unknown[]) ?? run.messages)
      .filter(isRecordableAgentMessage)
      .map(cloneAgentMessage);
    throwIfAborted(signal);
    const selection = collectAgentMessageToolResultBudgetSelections(source, run.toolResultBudgetState, {
      limit: MAX_TOOL_RESULTS_PER_BATCH_CHARS,
      skipToolNames: CHILD_RUN_TOOL_RESULT_BUDGET_SKIP_TOOLS,
    });
    if (selection.toPersist.length === 0 && selection.alreadyReplaced.length === 0) {
      return await this.autoCompactRunIfNeeded(run, source, signal) ?? source;
    }

    const nextMessages = source.map(cloneAgentMessage);
    let changed = false;

    for (const candidate of selection.alreadyReplaced) {
      const message = nextMessages[candidate.messageIndex];
      if (!message || message.role !== 'toolResult') continue;
      if (toolResultText(message) === candidate.replacement) continue;
      replaceToolResultText(message, candidate.replacement);
      void this.host.runToolResultReplaced(snapshotRun(run), candidate.toolCallId, candidate.replacement).catch(() => undefined);
      changed = true;
    }

    for (const candidate of selection.toPersist) {
      throwIfAborted(signal);
      const message = nextMessages[candidate.messageIndex];
      if (!message || message.role !== 'toolResult') continue;
      try {
        const persisted = await this.host.persistToolOutputPayload(
          runToolOutputPayloadId(run, candidate.toolCallId),
          candidate.toolName,
          candidate.contentText,
        );
        replaceToolResultText(message, persisted.label);
        run.toolResultBudgetState.seenIds.add(candidate.toolCallId);
        run.toolResultBudgetState.replacements.set(candidate.toolCallId, persisted.label);
        // The ledger records what the model sees from here on (`tool_result.replaced`).
        void this.host.runToolResultReplaced(snapshotRun(run), candidate.toolCallId, persisted.label).catch(() => undefined);
        changed = true;
      } catch {
        run.toolResultBudgetState.seenIds.add(candidate.toolCallId);
      }
    }

    throwIfAborted(signal);
    if (!changed) return await this.autoCompactRunIfNeeded(run, source, signal) ?? source;
    run.messages = nextMessages.map(cloneAgentMessage);
    if (run.agent) run.agent.state.messages = nextMessages as never;
    run.updatedAt = Date.now();
    return await this.autoCompactRunIfNeeded(run, nextMessages, signal) ?? nextMessages;
  }

  private async autoCompactRunIfNeeded(run: DelegationRunState, messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[] | null> {
    throwIfAborted(signal);
    if (run.autoCompactInProgress) return null;
    if (run.autoCompactConsecutiveFailures >= MAX_CHILD_RUN_AUTO_COMPACT_FAILURES) return null;
    if (messages.length < 2) return null;
    const settings = await this.host.getRuntimeSettings();
    throwIfAborted(signal);
    if (!settings.compactEnabled) return null;
    const model = run.agent?.state.model as Model<Api> | undefined;
    if (!model) return null;
    const threshold = autoCompactThreshold(model);
    if (!Number.isFinite(threshold) || threshold <= 0) return null;
    const systemPrompt = run.agent?.state.systemPrompt ?? '';
    if (agentMessagesAutoCompactTokens(messages, systemPrompt) < threshold) return null;
    return this.compactRunMessages(run, messages, 'auto', signal);
  }

  private async compactRunMessages(
    run: DelegationRunState,
    messages: AgentMessage[],
    trigger: 'auto' | 'reactive',
    signal?: AbortSignal,
  ): Promise<AgentMessage[] | null> {
    throwIfAborted(signal);
    if (run.autoCompactInProgress) return null;
    if (run.autoCompactConsecutiveFailures >= MAX_CHILD_RUN_AUTO_COMPACT_FAILURES) return null;
    if (messages.length < 2) return null;
    const settings = await this.host.getRuntimeSettings();
    if (!settings.compactEnabled) return null;
    const model = run.agent?.state.model as Model<Api> | undefined;
    if (!model) return null;

    run.autoCompactInProgress = true;
    try {
      run.skillRuntime?.restoreInvokedSkillsFromMessages(messages);
      const summary = await this.host.completeCompactSummary(
        `${this.conversationId}-${run.id}-${trigger}-compact`,
        messages,
        model,
        // Every sub-run follows the one-Neva invariant: omit copied parent
        // context that only predates the fork assignment; preserve the assignment,
        // sub-run actions, user follow-ups, and final result.
        'This is a same-agent sub-run transcript. Omit copied parent conversation context that only predates the sub-run assignment; preserve the sub-run assignment, sub-run actions, user follow-ups, and final result.',
        signal,
      );
      throwIfAborted(signal);
      const restoredFiles = run.localWorkspace
        ? await restorePostCompactReadFiles(run.localWorkspace, {
            maxFiles: CHILD_RUN_POST_COMPACT_MAX_FILES_TO_RESTORE,
            maxCharsPerFile: CHILD_RUN_POST_COMPACT_MAX_CHARS_PER_FILE,
            maxTotalChars: CHILD_RUN_POST_COMPACT_TOTAL_RESTORED_FILE_CHARS,
            preservedFilePaths: new Set<string>(),
          })
        : [];
      const postCompactMessage = createPostCompactMessage(
        summary,
        run.skillRuntime?.createInvokedSkillsReminder() ?? null,
        run.skillRuntime?.createSkillListingStateReminder() ?? null,
        null,
        createPostCompactRestoredFilesReminder(restoredFiles),
      );
      if (run.activeDurableFollowUpTexts.size > 0 && Array.isArray(postCompactMessage.content)) {
        postCompactMessage.content = [
          ...postCompactMessage.content,
          {
            type: 'text',
            text: systemReminder([
              'Durable follow-ups still owned by this continuation:',
              ...run.activeDurableFollowUpTexts,
            ].join('\n\n')),
          },
        ];
      }
      const compactedMessages = [postCompactMessage];
      run.messages = compactedMessages.map(cloneAgentMessage);
      if (run.agent) run.agent.state.messages = compactedMessages as never;
      run.toolResultBudgetState = restoreToolResultBudgetStateFromAgentMessages(compactedMessages);
      // The folded-away span is below the new floor: a stale pre-compaction
      // index would otherwise either hide real post-compaction output (index >
      // new length) or salvage the summary root. Only NEW output counts now.
      run.salvageFromIndex = compactedMessages.length;
      run.autoCompactConsecutiveFailures = 0;
      run.updatedAt = Date.now();
      // Event-sourced ([[agent-run-unification]] Design 4): the ledger appends a
      // compaction event + the post-compact message as a new root; the compacted
      // span stays in the ledger off-path. The in-memory working state above is
      // exactly its replay.
      await this.host.runCompacted(snapshotRun(run), {
        postCompactMessage,
        summary,
        trigger,
      }).catch(() => undefined);
      return compactedMessages;
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      run.autoCompactConsecutiveFailures += 1;
      return null;
    } finally {
      run.autoCompactInProgress = false;
    }
  }

  private async ensureLiveAgent(run: DelegationRunState): Promise<void> {
    if (run.agent) return;
    const definition = await this.resolveDefinitionForRun(run);
    const { skillRuntime, localWorkspace, childAgent, subRunRuntime } = await this.buildChildAgentHarness({
      runId: run.id,
      definition,
      scope: run.scope,
      budget: run.budget,
      executingAgentId: run.executingAgentId,
      parentAgentId: run.parentAgentId,
      memoryOwnerAgentId: run.memoryOwnerAgentId,
      memoryOriginWorkspace: run.memoryOriginWorkspace,
      preapprovedToolRules: run.preapprovedToolRules,
      unattended: run.unattended,
      // Resume continues from the run's restored transcript (the model + effort
      // come from the run's resolved definition, not a fresh override).
      initialMessages: run.messages.map(cloneAgentMessage),
      afterToolResult: (toolCallId, toolName, result, isError) => (
        this.afterRunToolResult(run, toolCallId, toolName, result, isError)
      ),
    });
    run.definition = definition;
    run.agent = childAgent;
    for (const message of childAgent.state.messages as AgentMessage[]) {
      run.ledgerSeededMessages.add(message);
    }
    run.skillRuntime = skillRuntime;
    run.localWorkspace = localWorkspace;
    run.subRunRuntime = subRunRuntime;
    run.nodeChanges = {};
    run.fileChanges = {};
    run.toolTrace = [];
    this.subscribeToChild(run);
    this.installRunContextTransform(run);
  }

  /**
   * The sub-run runtime's host: every callback forwards to THIS runtime's
   * host (one wiring, shared by the spawn and the restart-continuation paths —
   * a forwarder added in one and missed in the other would break only the
   * resume path, the one tests exercise least). Only the run identity and the
   * live-agent accessor differ per call site.
   */
  private buildChildHost(
    getRunId: () => string,
    getChildAgent: () => Agent | null,
  ): AgentDelegationRuntimeHost {
    return {
      createChildAgent: (input) => this.host.createChildAgent(input),
      getParentMessages: () => getChildAgent()?.state.messages as AgentMessage[] ?? [],
      getParentSystemPrompt: () => getChildAgent()?.state.systemPrompt ?? this.host.getParentSystemPrompt(),
      getActiveRunId: () => getRunId(),
      getRuntimeSettings: () => this.host.getRuntimeSettings(),
      runStarted: (snapshot, seed) => {
        if (snapshot.purpose !== 'verify') {
          const parent = this.runs.get(getRunId());
          if (parent) parent.hasWorkChildren = true;
        }
        this.upsertObservedRun(snapshot);
        return this.host.runStarted(snapshot, seed);
      },
      runMessage: (snapshot, message) => this.host.runMessage(snapshot, message),
      runToolResultReplaced: (snapshot, toolCallId, text) => this.host.runToolResultReplaced(snapshot, toolCallId, text),
      runCompacted: (snapshot, input) => this.host.runCompacted(snapshot, input),
      runResultSubmitted: (snapshot, input) => this.host.runResultSubmitted(snapshot, input),
      readLatestRunSubmission: (runId) => this.host.readLatestRunSubmission?.(runId) ?? Promise.resolve(undefined),
      runStatusChanged: (snapshot, durableMessage) => {
        this.upsertObservedRun(snapshot);
        return this.host.runStatusChanged(snapshot, durableMessage);
      },
      runExecutionStarted: (snapshot) => this.host.runExecutionStarted?.(snapshot),
      runExecutionSettled: (snapshot) => this.host.runExecutionSettled?.(snapshot),
      notifyRun: (snapshot) => this.host.notifyRun(snapshot),
      reportError: (report) => this.host.reportError?.(report),
      restoreRunLedger: (runId) => this.host.restoreRunLedger(runId),
      persistToolOutputPayload: (toolCallId, toolName, text) => (
        this.host.persistToolOutputPayload(toolCallId, toolName, text)
      ),
      completeCompactSummary: (conversationId, messages, model, customInstructions, signal) => (
        this.host.completeCompactSummary(conversationId, messages, model, customInstructions, signal)
      ),
    };
  }

  private async resolveDefinitionForRun(run: DelegationRunState): Promise<AgentDefinition> {
    if (run.definition) return run.definition;
    // Every sub-run is Neva continuing in isolation (the one-Neva invariant); there is no
    // by-name agent to resolve.
    return createForkAgentDefinition();
  }

  private reserveRunningSlot(): RunningSlotReservation {
    if (this.runningCount() + this.reservedRunningSlots >= MAX_CONCURRENT_SUB_RUNS) {
      throw new Error(`Too many sub-runs are already running in this session. Limit: ${MAX_CONCURRENT_SUB_RUNS}.`);
    }
    this.reservedRunningSlots += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservedRunningSlots = Math.max(0, this.reservedRunningSlots - 1);
    };
  }

  private runningCount(): number {
    return [...this.runs.values()].filter((run) => run.status === 'running').length;
  }

  private resolveRun(selector: { runId?: string; name?: string }): DelegationRunState {
    const id = selector.runId || (selector.name ? this.names.get(selector.name) : undefined);
    if (!id) throw new Error('Provide runId or name.');
    const run = this.runs.get(id);
    if (!run) throw new Error(`Unknown run: ${id}`);
    return run;
  }

  private assertRunControllable(run: DelegationRunState, action: 'steer' | 'amend' | 'stop'): void {
    if (!run.observedOnly) return;
    throw new Error(`Cannot ${action} run ${run.id} from this controller; steer, amend, or stop it through its direct parent controller.`);
  }

  private async hydrateLatestSubmission(run: DelegationRunState): Promise<void> {
    if (run.latestSubmission || run.status !== 'completed') return;
    const submission = await this.host.readLatestRunSubmission?.(run.id);
    if (!submission) return;
    run.latestSubmission = submission;
    run.submittedResult = submission.summary;
  }

  private directChildrenOf(run: DelegationRunState): DelegationRunState[] {
    return [...this.runs.values()]
      .filter((child) => child.parentRunId === run.id)
      .sort((left, right) => left.startedAt - right.startedAt);
  }

  private upsertObservedRun(snapshot: AgentRunSnapshot): void {
    const existing = this.runs.get(snapshot.id);
    if (existing) {
      Object.assign(existing, snapshot);
      if (snapshot.name) this.names.set(snapshot.name, snapshot.id);
    } else {
      const run: DelegationRunState = {
        ...snapshot,
        memoryOriginWorkspace: snapshot.memoryOriginWorkspace ?? memoryWorkspaceIdForRoot(this.localRoot),
        definition: null,
        depth: this.depth + 1,
        messages: [],
        ledgerSeededMessages: new WeakSet(),
        durableFollowUpMessages: new WeakSet(),
        activeDurableFollowUpTexts: new Set(),
        startupInFlight: false,
        executionInFlightCount: 0,
        detached: false,
        terminalNotificationSent: true,
        turnCount: 0,
        verify: snapshot.verify === true,
        verificationAttemptBase: snapshot.verificationAttemptBase ?? 0,
        verificationAttempts: snapshot.verificationAttemptBase ?? 0,
        verifierRunIds: [],
        hasWorkChildren: false,
        latestVerifierGap: snapshot.latestVerifierGap,
        processedControllerDeliveryCount: 0,
        toolResultBudgetState: createToolResultBudgetState(),
        nodeChanges: {},
        fileChanges: {},
        toolTrace: [],
        verifierGapSignatures: [...(snapshot.verifierGapSignatures ?? [])],
        lifecycleEpoch: 0,
        autoCompactConsecutiveFailures: 0,
        autoCompactInProgress: false,
        observedOnly: true,
      };
      this.runs.set(run.id, run);
      if (run.name) this.names.set(run.name, run.id);
    }

    if (snapshot.parentRunId && snapshot.purpose !== 'verify') {
      const parent = this.runs.get(snapshot.parentRunId);
      if (parent) parent.hasWorkChildren = true;
    }
  }

  private assertCanDescend(nextAgentName: string): void {
    if (this.depth >= this.maxDepth) {
      throw new Error(`Sub-run nesting limit reached (${this.maxDepth}). Complete the task directly.`);
    }
    void nextAgentName;
  }

  private hostConversationPrefix(): string {
    return this.conversationId;
  }
}

function issueDeliveryExecutionIds(messages: readonly AgentMessage[]): Set<string> {
  const executionIds = new Set<string>();
  for (const message of messages) {
    for (const text of messageTextParts(message)) {
      for (const match of text.matchAll(/<executionId>([^<]+)<\/executionId>/gu)) {
        if (match[1]) executionIds.add(match[1]);
      }
    }
  }
  return executionIds;
}

/**
 * The inherited fork context: the parent's live transcript (cloned) with
 * unresolved tool calls closed by placeholder results. The directive is NOT
 * part of this — it is the fork's first evidence message, after the ledger's
 * `run.started` boundary.
 */
export function buildForkContextMessages(parentMessages: readonly AgentMessage[]): AgentMessage[] {
  const messages = parentMessages.map(cloneAgentMessage);
  const unresolved = collectUnresolvedToolCalls(messages);
  for (const toolCall of unresolved) {
    messages.push({
      role: 'toolResult',
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: 'text', text: FORK_PLACEHOLDER_RESULT }],
      isError: false,
      timestamp: Date.now(),
    } satisfies ToolResultMessage);
  }
  return messages;
}

function buildRunContextMessages(parentMessages: readonly AgentMessage[], contextMode: AgentRunContextMode): AgentMessage[] {
  if (contextMode === 'none') return [];
  if (contextMode === 'brief') return buildBriefRunContextMessages(parentMessages);
  return buildForkContextMessages(parentMessages);
}

export { normalizeAgentToolNames } from './agentToolRules';

function restrictAgentDefinitionTools(definition: AgentDefinition, allowedTools: readonly string[] | undefined): AgentDefinition {
  if (!allowedTools) return definition;
  const allowed = normalizeAgentToolNames(allowedTools) ?? [];
  const existing = normalizeAgentToolNames(definition.tools);
  const tools = !existing || existing.includes('*')
    ? allowed
    : existing.filter((tool) => allowed.includes(tool));
  return { ...definition, tools };
}

// The one-Neva invariant: the registry holds exactly one agent — the built-in
// Neva. No file-backed agents are scanned or loaded; the only "delegation target"
// besides Neva herself is the implicit fork pseudo-agent, which is never in this
// registry (it is constructed on demand in startAgent).
class AgentDefinitionRegistry {
  private loaded = false;
  private readonly agents = new Map<string, AgentDefinition>();

  /**
   * Drop the cached load so the next read rebuilds. Kept so an edit to the
   * built-in overlay is picked up without an app restart; it simply re-seeds Neva.
   */
  reload(): void {
    this.loaded = false;
    this.agents.clear();
  }

  async listAgents(): Promise<AgentDefinition[]> {
    this.ensureLoaded();
    return [...this.agents.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.agents.clear();
    const neva = createTenonAssistantAgentDefinition();
    this.agents.set(neva.name, neva);
  }
}

function createForkAgentDefinition(): AgentDefinition {
  return {
    name: FORK_AGENT_TYPE,
    source: 'built-in',
    rootDir: 'built-in',
    agentFile: 'built-in/fork',
    description: 'Implicit fork that inherits the current conversation context.',
    tools: ['*'],
    maxTurns: 200,
    model: 'inherit',
    body: '',
  };
}

export function createTenonAssistantAgentDefinition(): AgentDefinition {
  return {
    name: TENON_ASSISTANT_AGENT_NAME,
    displayName: TENON_ASSISTANT_AGENT_DISPLAY_NAME,
    source: 'built-in',
    rootDir: 'built-in',
    agentFile: 'built-in/assistant',
    description: 'Default Tenon assistant profile.',
    tools: ['*'],
    model: 'inherit',
    body: NEVA_AGENT_PERSONA,
  };
}

function buildBriefRunContextMessages(parentMessages: readonly AgentMessage[]): AgentMessage[] {
  const excerpts = parentMessages
    .slice(-8)
    .map((message) => {
      const text = compactInlineText(messageTextParts(message).join('\n'));
      if (!text) return null;
      return `${message.role}: ${truncate(text, 600)}`;
    })
    .filter((entry): entry is string => entry !== null);
  if (excerpts.length === 0) return [];
  return [createHiddenUserMessage([
    'Brief parent context for this child Run:',
    '',
    ...excerpts,
  ].join('\n'))];
}

function buildRunDirective(params: AgentToolParams): string {
  if (params.purpose === 'verify') return params.runPrompt;
  const criteria = params.criteria?.length
    ? params.criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join('\n')
    : 'No acceptance criteria were provided because verify is false.';
  const budget = formatRunBudgetForPrompt(params.budget);
  const scope = formatRunScopeForPrompt(params.scope);
  return [
    `<${FORK_BOILERPLATE_TAG}>`,
    'STOP. READ THIS FIRST.',
    '',
    'You are a Tenon Agent Session worker. Decompose short-lived steps inside your plan, evidence, and final report; use child Issues only for durable independently executed sub-outcomes.',
    '',
    'Controller rules:',
    '1. Stay strictly within the objective and acceptance criteria.',
    '2. Build ordinary internal decomposition in this Session plan, evidence, Activity, and final report. Create a child Issue only when a sub-outcome needs its own durable lifecycle or independent Agent Session; runtime derives its parent and routes the result back here.',
    '3. Use Issue relations only when another independently managed Issue is a true external blocker, duplicate, or related outcome.',
    '4. Verify sub-run results before accepting them as done; redo rejected work inside the Session plan when budget remains.',
    '5. Do not ask the user questions from this child Run; block with a concise reason if owner input is genuinely required.',
    '6. Keep the final report factual and concise, naming what was verified and any residual gaps.',
    `</${FORK_BOILERPLATE_TAG}>`,
    '',
    `Objective:\n${params.objective}`,
    '',
    `Acceptance criteria:\n${criteria}`,
    '',
    `Context mode: ${params.context}`,
    budget ? `Budget:\n${budget}` : '',
    scope ? `Scope:\n${scope}` : '',
  ].filter(Boolean).join('\n');
}

function buildObjectivePrompt(objective: string, criteria?: readonly string[]): string {
  if (!criteria?.length) return objective;
  return [
    objective,
    '',
    'Acceptance criteria:',
    ...criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
  ].join('\n');
}

function buildRunAmendmentPrompt(
  run: Pick<DelegationRunState, 'objective' | 'criteria' | 'budget'>,
  changes: { objective?: string; criteria?: string[]; budget?: AgentRunBudget },
): string {
  const changedFields = [
    changes.objective !== undefined ? 'objective' : '',
    changes.criteria !== undefined ? 'acceptance criteria' : '',
    changes.budget !== undefined ? 'budget' : '',
  ].filter(Boolean).join(', ');
  const criteria = run.criteria?.length
    ? run.criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join('\n')
    : 'No acceptance criteria are currently configured.';
  const budget = formatRunBudgetForPrompt(run.budget) || 'No explicit budget is currently configured.';
  return [
    'Run amendment (durable; supersedes earlier values for the changed fields).',
    `Changed fields: ${changedFields}.`,
    '',
    `Current objective:\n${run.objective ?? 'No objective is currently configured.'}`,
    '',
    `Current acceptance criteria:\n${criteria}`,
    '',
    `Current budget:\n${budget}`,
    '',
    changes.objective !== undefined || changes.criteria !== undefined
      ? 'Use this amended contract for all subsequent work and verification.'
      : 'The objective and acceptance criteria are unchanged; this budget-only amendment does not invalidate verification.',
  ].join('\n');
}

function collectUnresolvedToolCalls(messages: readonly AgentMessage[]): Array<{ id: string; name: string }> {
  const resolved = new Set<string>();
  for (const message of messages) {
    if (message.role === 'toolResult') resolved.add(message.toolCallId);
  }
  const unresolved: Array<{ id: string; name: string }> = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type === 'toolCall' && !resolved.has(part.id)) {
        unresolved.push({ id: part.id, name: part.name });
      }
    }
  }
  return unresolved;
}

function lastAssistantMessage(messages: readonly AgentMessage[]): AssistantMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant') return message;
  }
  return null;
}

function runToToolData(
  run: DelegationRunState,
  children: readonly DelegationRunState[] = [],
  resultOverride?: string,
): AgentDelegateToolData {
  const nodeChanges = compactNodeChanges(run.nodeChanges);
  const fileChanges = compactFileChanges(run.fileChanges);
  const result = resultOverride ?? latestRunSubmissionSummary(run) ?? run.result;
  return {
    status: run.status,
    runId: run.id,
    name: run.name,
    description: run.description,
    objective: run.objective,
    criteria: run.criteria,
    objective_status: run.objectiveStatus,
    purpose: run.purpose,
    scope: run.scope,
    budget: run.budget,
    blocked_reason: run.blockedReason,
    runProfile: run.runProfile ?? runProfileForPurpose(run.purpose ?? 'work'),
    context_mode: run.contextMode,
    result,
    error: run.error,
    started_at: run.startedAt,
    updated_at: run.updatedAt,
    completed_at: run.completedAt,
    transcript_message_count: run.messages.length,
    ...(children.length > 0 ? { children: children.map(runToChildStatus) } : {}),
    ...(run.latestVerifierGap ? { latest_verifier_gap: run.latestVerifierGap } : {}),
    ...(nodeChanges ? { node_changes: nodeChanges } : {}),
    ...(fileChanges ? { file_changes: fileChanges } : {}),
    ...(run.incomplete ? { incomplete: true } : {}),
  };
}

function liveRunPartialResult(run: DelegationRunState): string | undefined {
  if (run.status !== 'running' || !run.agent) return undefined;
  const since = run.salvageFromIndex ?? 0;
  return extractPartialAssistantText((run.agent.state.messages as AgentMessage[]).slice(since));
}

function runToChildStatus(run: DelegationRunState): AgentSubRunStatus {
  return {
    runId: run.id,
    role: derivedRunRole(run),
    objectiveStatus: run.objectiveStatus,
    executionStatus: run.status,
    name: run.name,
    description: run.description,
    objective: run.objective,
  };
}

function derivedRunRole(run: DelegationRunState): AgentSubRunStatus['role'] {
  if (run.purpose === 'verify') return 'verifier';
  if (run.objectiveRole === 'controller' || run.hasWorkChildren) return 'controller';
  return run.objectiveRole ?? 'worker';
}

function runWasStopped(run: Pick<DelegationRunState, 'status' | 'objectiveStatus'>): boolean {
  return run.status === 'cancelled' || run.objectiveStatus === 'stopped';
}

function snapshotRun(run: DelegationRunState): AgentRunSnapshot {
  return {
    id: run.id,
    name: run.name,
    description: run.description,
    prompt: run.prompt,
    objective: run.objective,
    criteria: run.criteria,
    objectiveRole: run.objectiveRole,
    objectiveStatus: run.objectiveStatus,
    ...(run.verify ? { verify: true } : {}),
    verificationAttemptBase: run.verificationAttemptBase,
    verifierGapSignatures: [...run.verifierGapSignatures],
    purpose: run.purpose,
    scope: run.scope,
    budget: run.budget,
    disposition: run.disposition,
    agentType: run.agentType,
    contextMode: run.contextMode,
    runProfile: run.runProfile,
    executingAgentId: run.executingAgentId,
    parentAgentId: run.parentAgentId,
    parentRunId: run.parentRunId,
    memoryOwnerAgentId: run.memoryOwnerAgentId,
    memoryOriginWorkspace: run.memoryOriginWorkspace,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    result: run.result,
    error: run.error,
    blockedReason: run.blockedReason,
    latestVerifierGap: run.latestVerifierGap,
    parentToolCallId: run.parentToolCallId,
    unattended: run.unattended,
  };
}

function runToolOutputPayloadId(run: DelegationRunState, toolCallId: string): string {
  return `${run.id}-${toolCallId}`;
}

function createUserMessage(text: string): UserMessage {
  return {
    role: 'user',
    timestamp: Date.now(),
    content: [{ type: 'text', text }],
  };
}

function createHiddenUserMessage(text: string): UserMessage {
  return {
    role: 'user',
    timestamp: Date.now(),
    content: [{ type: 'text', text: systemReminder(text) }],
  };
}

/**
 * The last non-empty assistant text in a transcript, or `undefined` when the run
 * produced none. The salvage primitive: completion wraps it with a fallback
 * string; a stop reads it raw so a killed run's partial work is preserved instead
 * of a misleading "completed" fallback.
 */
export function extractPartialAssistantText(messages: readonly AgentMessage[]): string | undefined {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter((part): part is TextContent => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return undefined;
}

function extractFinalAssistantText(messages: readonly AgentMessage[]): string {
  return extractPartialAssistantText(messages) ?? 'Run completed without a text result.';
}

function isRecordableAgentMessage(message: unknown): message is AgentMessage {
  return isPlainRecord(message)
    && (message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult');
}

function cloneAgentMessage<T extends AgentMessage>(message: T): T {
  return JSON.parse(JSON.stringify(message)) as T;
}

function toolResultText(message: ToolResultMessage): string | null {
  return piToolResultTextContent(message.content);
}

function replaceToolResultText(message: ToolResultMessage, text: string): void {
  message.content = [{ type: 'text', text }];
}

function normalizeAgentToolParams(raw: unknown): AgentToolParams {
  if (!isPlainRecord(raw)) throw new Error('Delegation input must be an object.');
  const objective = coerceString(raw.objective)?.trim();
  if (!objective) throw new Error('Delegation input requires objective.');
  const verify = raw.verify !== false;
  const criteria = coerceStringArray(raw.criteria);
  if (verify && (!criteria || criteria.length === 0)) {
    throw new Error('Delegation input requires at least one criterion unless verify is false.');
  }
  const description = coerceString(raw.description)?.trim() || truncate(compactInlineText(objective), 120);
  const runPrompt = coerceString(raw.runPrompt)?.trim() || buildObjectivePrompt(objective, criteria);
  const allowedTools = Array.isArray(raw.allowedTools)
    ? normalizeAgentToolNames(raw.allowedTools) ?? []
    : undefined;
  return {
    objective,
    criteria,
    verify,
    description,
    runPrompt,
    purpose: normalizeRunPurpose(raw.purpose),
    scope: normalizeRunScope(raw.scope),
    budget: normalizeRunBudgetInput(raw.budget),
    runProfile: normalizeRequestedRunProfile(raw.runProfile),
    context: normalizeRunContext(raw.context),
    detach: raw.detach === true,
    model: coerceString(raw.model),
    name: coerceString(raw.name),
    allowedTools,
    preapprovedToolRules: coerceStringArray(raw.preapprovedToolRules),
    unattended: raw.unattended === true,
  };
}

function normalizeRunPurpose(value: unknown): AgentRunPurpose {
  return value === 'verify' ? 'verify' : 'work';
}

function normalizeRunContext(value: unknown): AgentRunContextMode {
  return value === 'none' || value === 'brief' || value === 'full' ? value : 'full';
}

function normalizeRequestedRunProfile(value: unknown): AgentRunProfileId | undefined {
  if (value === undefined) return undefined;
  const profileId = coerceString(value)?.trim();
  if (!profileId) return undefined;
  if (!isRunProfileId(profileId)) throw new Error(`Unknown runProfile: ${profileId}`);
  const profile = resolveRunProfile(profileId);
  if (profile.modelSelectable !== true) throw new Error(`Run profile is not model-selectable: ${profile.id}`);
  return profile.id;
}

function normalizeAmendParams(raw: unknown): { runId: string; changes: { objective?: string; criteria?: string[]; budget?: AgentRunBudget } } {
  if (!isPlainRecord(raw)) throw new Error('Delegation amend input must be an object.');
  const runId = coerceString(raw.runId)?.trim();
  if (!runId) throw new Error('Delegation amend input requires runId.');
  if (!isPlainRecord(raw.changes)) throw new Error('Delegation amend input requires changes.');
  const objective = coerceString(raw.changes.objective)?.trim();
  const criteria = raw.changes.criteria === undefined ? undefined : coerceStringArray(raw.changes.criteria) ?? [];
  const budget = raw.changes.budget === undefined ? undefined : normalizeRunBudgetInput(raw.changes.budget);
  if (objective === undefined && criteria === undefined && budget === undefined) {
    throw new Error('Delegation amend changes must include objective, criteria, or budget.');
  }
  return { runId, changes: { objective, criteria, budget } };
}

function coerceStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeRunSelector(raw: unknown): { runId?: string; name?: string; wait?: boolean; timeout_ms?: number } {
  if (!isPlainRecord(raw)) return {};
  return {
    runId: coerceString(raw.runId),
    name: coerceString(raw.name),
    wait: raw.wait === true,
    timeout_ms: parsePositiveInteger(raw.timeout_ms),
  };
}

function normalizeSendParams(raw: unknown): { runId?: string; name?: string; message: string } {
  if (!isPlainRecord(raw)) throw new Error('Delegation message input must be an object.');
  const message = coerceString(raw.message)?.trim();
  if (!message) throw new Error('Delegation message input requires message.');
  return {
    runId: coerceString(raw.runId),
    name: coerceString(raw.name),
    message,
  };
}

function formatAgentListing(agents: readonly AgentDefinition[], contextWindowTokens?: number): string {
  const budget = getAgentListingCharBudget(contextWindowTokens);
  const entries = agents.map((agent) => ({
    agent,
    full: `- ${agent.name}: ${truncate(agent.description, MAX_LISTING_DESCRIPTION_CHARS)}`,
  }));
  const fullTotal = entries.reduce((sum, entry) => sum + entry.full.length, 0) + entries.length - 1;
  if (fullTotal <= budget) return entries.map((entry) => entry.full).join('\n');
  const nameOverhead = agents.reduce((sum, agent) => sum + agent.name.length + 4, 0) + agents.length - 1;
  const maxDescription = Math.floor((budget - nameOverhead) / agents.length);
  if (maxDescription < 20) return agents.map((agent) => `- ${agent.name}`).join('\n');
  return agents.map((agent) => `- ${agent.name}: ${truncate(agent.description, maxDescription)}`).join('\n');
}

function agentListingIdentity(agent: AgentDefinition): string | null {
  return agent.source === 'built-in' ? agent.agentFile : normalizePathForPrompt(agent.agentFile);
}

function formatPersistedAgentListingStateEntry(entry: { name: string; identity: string | null }): string {
  return entry.identity
    ? `- ${entry.name} [agent-file: ${entry.identity}]`
    : `- ${entry.name}`;
}

function parsePersistedAgentListingStateEntries(text: string): Array<{ name: string; identity?: string }> {
  const body = unwrapSystemReminder(text);
  const start = body.indexOf(AGENT_LISTING_STATE_MARKER);
  if (start < 0) return [];
  return body
    .slice(start + AGENT_LISTING_STATE_MARKER.length)
    .split(/\r?\n/)
    .map(parsePersistedAgentListingStateLine)
    .filter((entry): entry is { name: string; identity?: string } => entry !== null);
}

function parsePersistedAgentListingStateLine(line: string): { name: string; identity?: string } | null {
  const match = /^-\s+([^\s\[]+)(?:\s+\[agent-file:\s*([^\]]+)\])?\s*$/.exec(line.trim());
  const name = normalizeAgentName(match?.[1] ?? '');
  if (!name) return null;
  const identity = match?.[2]?.trim();
  return identity ? { name, identity } : { name };
}

function parseLiveAgentListing(text: string): string[] {
  const body = unwrapSystemReminder(text);
  if (!body.includes('You are operating with these available agent definitions for Issue and Agent Session work:')) {
    return [];
  }
  return body
    .split(/\r?\n/)
    .map((line) => /^-\s+([^:\s]+)(?::|\s|$)/.exec(line)?.[1]?.trim() ?? '')
    .map(normalizeAgentName)
    .filter((name): name is string => Boolean(name));
}

function unwrapSystemReminder(text: string): string {
  const trimmed = text.trim();
  const start = '<system-reminder>';
  const end = '</system-reminder>';
  if (!trimmed.startsWith(start)) return trimmed;
  const endIndex = trimmed.lastIndexOf(end);
  return (endIndex >= 0 ? trimmed.slice(start.length, endIndex) : trimmed.slice(start.length)).trim();
}

function getAgentListingCharBudget(contextWindowTokens?: number): number {
  const override = Number(process.env.AGENT_DELEGATE_LISTING_CHAR_BUDGET);
  if (Number.isFinite(override) && override > 0) return override;
  if (!contextWindowTokens) return DEFAULT_AGENT_LISTING_CHAR_BUDGET;
  return Math.floor(contextWindowTokens * CHARS_PER_TOKEN * AGENT_LISTING_CONTEXT_PERCENT);
}

function waitWithTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    promise.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detachedChildRunSummaryKey(children: readonly DelegationRunState[]): string {
  return children
    .map((child) => [
      child.id,
      child.status,
      child.objectiveStatus ?? '',
      child.updatedAt,
      child.latestSubmission?.seq ?? '',
    ].join(':'))
    .join('|');
}

function isDetachedChildReadyForParentSummary(child: DelegationRunState): boolean {
  if (child.status === 'running') return false;
  if (child.status === 'failed' || child.status === 'cancelled') return true;
  if (!child.verify) return true;
  switch (child.objectiveStatus) {
    case 'verified':
    case 'blocked':
    case 'budget_exhausted':
    case 'stopped':
      return true;
    case 'active':
    case 'verifying':
      return false;
    default:
      return child.status !== 'completed';
  }
}

function isSupersededDetachedChildAttempt(child: DelegationRunState): boolean {
  return child.objectiveStatus === 'blocked'
    && /\breplacement run \S+ started\b/.test(child.blockedReason ?? '');
}

function buildDetachedChildRunCompletionPrompt(children: readonly DelegationRunState[]): string {
  const childResults = children.map((child) => ({
    runId: child.id,
    name: child.name,
    description: child.description,
    objective: child.objective,
    status: child.status,
    objective_status: child.objectiveStatus,
    result: latestRunSubmissionSummary(child) ?? child.result ?? null,
    error: child.error ?? null,
  }));
  return [
    'Detached sub-runs launched by this Run have now reached their parent-summary state.',
    'Use their results below to continue the original Run objective.',
    'Do not report only that sub-runs were started. Produce the final parent Run result, or explain the blocker if any sub-run failed or returned no usable result.',
    '',
    '<detached-sub-run-results>',
    JSON.stringify(childResults, null, 2),
    '</detached-sub-run-results>',
  ].join('\n');
}

function normalizeAgentName(name: string): string {
  const normalized = name.trim().replace(/^\//, '');
  if (!normalized) return '';
  return normalized.replace(/\s+/g, '-');
}

function compactInlineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePathForPrompt(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function messageTextParts(message: AgentMessage): string[] {
  if (message.role === 'assistant') {
    return message.content
      .filter((part): part is TextContent => part.type === 'text')
      .map((part) => part.text);
  }
  if (typeof message.content === 'string') return [message.content];
  return message.content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
