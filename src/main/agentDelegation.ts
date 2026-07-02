import { Agent, type AfterToolCallResult, type AgentEvent, type AgentTool } from '@earendil-works/pi-agent-core';
import { isContextOverflow } from '@earendil-works/pi-ai';
import type { Api, AssistantMessage, ImageContent, Model, TextContent, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  coerceString,
  parsePositiveInteger,
} from '../core/agentMarkdown';
import type {
  AgentMessage,
  AgentChildRunActionResult,
  AgentChildRunChildStatus,
  AgentChildRunFileChanges,
  AgentChildRunNodeChanges,
} from '../core/agentTypes';
import { systemReminder } from '../core/agentAttachments';
import type {
  AgentChildRunRecord,
  AgentRunContextMode,
  AgentObjectiveStatus,
  AgentRunBudget,
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
  agentToolResult,
  errorEnvelope,
  isToolEnvelope,
  successEnvelope,
  type ToolEnvelope,
} from './agentToolEnvelope';
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
import {
  agentDefinitionAgentId,
  memoryWorkspaceIdForRoot,
} from './agentDelegationIdentity';
import {
  runProfileForIsolatedSkill,
  runProfileForPurpose,
} from './agentRunProfiles';
import { agentToolNamesForActionKindScope, isReadOnlyActionKind, normalizeAgentToolActionKinds, readOnlyAgentToolNames } from '../core/agentPermissionModel';

export const AGENT_DELEGATE_TOOL_NAME = 'spawn';
export const AGENT_STATUS_TOOL_NAME = 'run_status';
export const AGENT_SEND_TOOL_NAME = 'run_steer';
export const AGENT_AMEND_TOOL_NAME = 'run_amend';
export const AGENT_STOP_TOOL_NAME = 'run_stop';

const AGENT_LISTING_CONTEXT_PERCENT = 0.01;
const CHARS_PER_TOKEN = 4;
const DEFAULT_AGENT_LISTING_CHAR_BUDGET = 8_000;
const MAX_LISTING_DESCRIPTION_CHARS = 250;
const MAX_CONCURRENT_CHILD_RUNS = 4;
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
const DEFAULT_CHILD_WALL_CLOCK_MINUTES = 30;
const DEFAULT_VERIFIER_LIVELOCK_REPEAT_LIMIT = 2;
const MAX_RECORDED_TOOL_TRACE_ENTRIES = 40;
const MAX_WORKING_SET_SNAPSHOT_FILES = 500;
// `setTimeout` stores its delay in a 32-bit int; a larger delay overflows and
// fires (near-)immediately, so any timer is armed in clamped re-arming hops.
const MAX_SETTIMEOUT_DELAY_MS = 2_147_483_647;
const WORKING_SET_EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'release']);

const AGENT_TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['objective'],
  properties: {
    objective: {
      type: 'string',
      minLength: 1,
      description: 'The objective for the new Run to pursue. This is the work, not the acceptance criteria.',
    },
    criteria: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: 'Independent acceptance criteria the parent will verify. Required unless verify is false.',
    },
    verify: {
      type: 'boolean',
      description: 'Defaults to true. Set false only for an explicitly unverified throwaway run.',
    },
    scope: {
      type: 'object',
      additionalProperties: false,
      properties: {
        capabilities: { type: 'array', items: { type: 'string', minLength: 1 } },
        resources: {
          type: 'object',
          additionalProperties: false,
          properties: {
            docs: { type: 'array', items: { type: 'string', minLength: 1 } },
            paths: { type: 'array', items: { type: 'string', minLength: 1 } },
          },
        },
      },
      description: 'Optional narrowed capability/resource scope. It cannot widen the caller.',
    },
    budget: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tokens: { type: 'integer', minimum: 1 },
        wallClockMinutes: { type: 'integer', minimum: 1 },
      },
      description: 'Optional budget slice. Detached root goals should provide a ceiling.',
    },
    context: {
      type: 'string',
      enum: ['full', 'brief', 'none'],
      description: 'How much parent context the Run receives. Verifiers are always none.',
    },
    detach: {
      type: 'boolean',
      description: 'Run past the current turn and notify on outcome.',
    },
    description: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'Optional short 3-5 word description for the Work/Runs panel.',
    },
    prompt: {
      type: 'string',
      minLength: 1,
      description: 'Legacy alias for objective. Prefer objective.',
    },
    model: {
      type: 'string',
      minLength: 1,
      description: 'Optional model override. Takes precedence over the agent definition model. If omitted, uses the agent definition model or inherits the parent model.',
    },
    run_in_background: {
      type: 'boolean',
      description: 'Legacy alias for detach.',
    },
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 120,
      description: 'Optional same-session name for addressing this background agent.',
    },
  },
};

const AGENT_STATUS_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runId: { type: 'string', minLength: 1, description: 'The run id returned by spawn.' },
    agent_id: { type: 'string', minLength: 1, description: 'Legacy alias for runId.' },
    name: { type: 'string', minLength: 1, description: 'The same-session run name passed to spawn.' },
    wait: { type: 'boolean', description: 'If true, wait briefly for a running background agent to finish.' },
    timeout_ms: { type: 'integer', minimum: 1, maximum: 120000, description: 'Maximum wait time when wait is true. Default 30000.' },
  },
};

const AGENT_SEND_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['message'],
  properties: {
    runId: { type: 'string', minLength: 1, description: 'The run id returned by spawn.' },
    agent_id: { type: 'string', minLength: 1, description: 'Legacy alias for runId.' },
    name: { type: 'string', minLength: 1, description: 'The same-session run name passed to spawn.' },
    message: { type: 'string', minLength: 1, description: 'Soft steering message to send to the existing background run.' },
  },
};

const AGENT_STOP_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runId: { type: 'string', minLength: 1, description: 'The run id returned by spawn.' },
    agent_id: { type: 'string', minLength: 1, description: 'Legacy alias for runId.' },
    name: { type: 'string', minLength: 1, description: 'The same-session run name passed to spawn.' },
  },
};

const AGENT_AMEND_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['changes'],
  properties: {
    runId: { type: 'string', minLength: 1, description: 'The run id returned by spawn.' },
    agent_id: { type: 'string', minLength: 1, description: 'Legacy alias for runId.' },
    changes: {
      type: 'object',
      additionalProperties: false,
      properties: {
        objective: { type: 'string', minLength: 1 },
        criteria: { type: 'array', items: { type: 'string', minLength: 1 } },
        budget: AGENT_TOOL_PARAMETERS.properties.budget,
      },
    },
  },
};



export type AgentDelegateToolData = AgentChildRunActionResult;

export interface AgentChildAgentCreateInput {
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
  allowedTools?: string[];
  disallowedTools?: string[];
  preapprovedToolRules?: string[];
  l0CacheBreakpointEnabled?: boolean;
  /**
   * Run with no interactive approval channel (unattended). A tool needing
   * approval is denied + surfaced instead of waiting for a human; globally
   * always-allowed tools still run. Set for scheduled command runs.
   */
  unattended?: boolean;
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
  childRunStarted(
    snapshot: AgentChildRunSnapshot,
    seed: { contextMessages: readonly AgentMessage[]; evidenceMessages: readonly AgentMessage[] },
  ): Promise<void>;
  /** A completed child message (user / assistant / toolResult) → child ledger. */
  childRunMessage(snapshot: AgentChildRunSnapshot, message: AgentMessage): Promise<void>;
  /** A slimming replacement of an earlier tool result → `tool_result.replaced` in the child ledger. */
  childRunToolResultReplaced(snapshot: AgentChildRunSnapshot, toolCallId: string, text: string): Promise<void>;
  /** Event-sourced run compaction (Design 4). */
  childRunCompacted(
    snapshot: AgentChildRunSnapshot,
    input: { postCompactMessage: AgentMessage; summary: string; trigger: 'auto' | 'reactive' },
  ): Promise<void>;
  childRunResultSubmitted(
    snapshot: AgentChildRunSnapshot,
    input: { summary: string; source: AgentRunSubmissionSource },
  ): Promise<AgentRunSubmissionProjection | null>;
  readLatestRunSubmission?(runId: string): Promise<AgentRunSubmissionProjection | undefined>;
  /** Status transition: Run metadata + run lifecycle event in the run ledger. */
  childRunStatusChanged(snapshot: AgentChildRunSnapshot): Promise<void>;
  notifyChildRun(snapshot: AgentChildRunSnapshot): Promise<void>;
  reportError?(report: ErrorReport): void;
  /**
   * Re-register the run's ledger writer and re-derive its transcript from the
   * run's OWN ledger — the resume path's restore (restore-on-open is records
   * only; transcripts load lazily here). Null when no ledger exists; the
   * writer is then registered empty so the continuation can still record.
   */
  restoreChildRunLedger(runId: string): Promise<AgentMessage[] | null>;
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
  verificationAttempts: number;
  verifierRunIds: string[];
  hasWorkChildren?: boolean;
  latestVerifierGap?: string;
  parentBudgetRef?: AgentRunBudget;
  budgetSettled?: boolean;
  /** Set when a 'completed' run was actually cut off (maxTurns / unresolved overflow). */
  incomplete?: boolean;
  preapprovedToolRules?: string[];
  toolResultBudgetState: ToolResultBudgetState;
  nodeChanges: AgentChildRunNodeChanges;
  fileChanges: AgentChildRunFileChanges;
  toolTrace: AgentChildRunToolTraceEntry[];
  verifierGapSignatures: string[];
  latestSubmission?: AgentRunSubmissionProjection;
  submittedResult?: string;
  autoCompactConsecutiveFailures: number;
  autoCompactInProgress: boolean;
  skillRuntime?: AgentSkillRuntime;
  localWorkspace?: AgentLocalWorkspaceContext;
  observedOnly?: boolean;
}

type RunningSlotReservation = () => void;

interface AgentChildRunToolTraceEntry {
  toolName: string;
  isError: boolean;
  status?: string;
  summary?: string;
}

interface WorkingSetFileSnapshot {
  filePath: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
}

interface WorkingSetSnapshot {
  files: Map<string, WorkingSetFileSnapshot>;
  truncated: boolean;
}

/**
 * The IPC-facing view of a delegated run — the {@link DelegationDetail} verbatim
 * (the runtime record's persistable half), carried to the host callbacks that
 * write the conversation markers and notifications.
 */
export type AgentChildRunSnapshot = DelegationDetail;

interface AgentToolParams {
  objective: string;
  criteria?: string[];
  verify: boolean;
  description: string;
  prompt: string;
  purpose: AgentRunPurpose;
  scope?: AgentRunScope;
  budget?: AgentRunBudget;
  context: AgentRunContextMode;
  runProfile?: AgentRunProfileId;
  detach?: boolean;
  model?: string;
  effort?: string;
  run_in_background?: boolean;
  name?: string;
  allowedTools?: string[];
  preapprovedToolRules?: string[];
  parentRunId?: string;
  parentBudget?: AgentRunBudget;
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

export interface AgentChildRunSkillInput {
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
      `You are operating as the agent below. Calling ${AGENT_DELEGATE_TOOL_NAME} forks the current conversation context into an isolated worker that runs as this same agent — it does not select or switch to a different agent:`,
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
   * Register persisted child-run records on conversation restore. Records only
   * — no transcript IO: a run's messages are replayed from its own ledger
   * lazily, on first resume (`send` → host.restoreChildRunLedger). Drill-in
   * reads never touch this state (they replay the ledger directly).
   */
  restorePersistedRuns(records: readonly AgentChildRunRecord[]): void {
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
        detached: false,
        terminalNotificationSent: true,
        turnCount: 0,
        verify: false,
        verificationAttempts: 0,
        verifierRunIds: [],
        hasWorkChildren: false,
        latestVerifierGap: record.latestVerifierGap,
        toolResultBudgetState: createToolResultBudgetState(),
        nodeChanges: {},
        fileChanges: {},
        toolTrace: [],
        verifierGapSignatures: [],
        autoCompactConsecutiveFailures: 0,
        autoCompactInProgress: false,
      };
      this.runs.set(run.id, run);
      if (run.name) this.names.set(run.name, run.id);
    }
    for (const record of records) {
      if (!record.parentRunId || record.purpose === 'verify') continue;
      const parent = this.runs.get(record.parentRunId);
      if (parent) parent.hasWorkChildren = true;
    }
  }

  async invokeAgent(rawParams: unknown, signal?: AbortSignal, parentToolCallId?: string): Promise<AgentDelegateToolData> {
    const params = normalizeAgentToolParams(rawParams);
    const releaseStartupSlot = this.reserveRunningSlot();
    try {
      return await this.startAgent(params, releaseStartupSlot, signal, parentToolCallId);
    } catch (error) {
      releaseStartupSlot();
      throw error;
    }
  }

  async invokeSkillChildAgent(
    input: AgentChildRunSkillInput,
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
        prompt: input.renderedContent,
        purpose: 'work',
        context: 'none',
        runProfile: runProfileForIsolatedSkill(input.readOnlyIsolated),
        model: input.model,
        effort: input.effort,
        run_in_background: false,
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
    return runToToolData(run, this.directChildrenOf(run));
  }

  async send(rawParams: unknown): Promise<AgentDelegateToolData> {
    const params = normalizeSendParams(rawParams);
    const run = this.resolveRun(params);
    this.assertRunControllable(run, 'steer');
    const message = createUserMessage(params.message);
    if (run.status === 'running') {
      if (!run.agent) throw new Error(`Agent ${run.id} is not live in this process. Start a continuation instead.`);
      run.agent.followUp(message);
      run.updatedAt = Date.now();
      // The follow-up reaches the ledger through the message_end subscription
      // when the loop drains it — no status change to record here.
      return { ...runToToolData(run), status: 'queued', instructions: 'Message queued for the running background agent.' };
    }

    const releaseStartupSlot = this.reserveRunningSlot();
    try {
      const wasStopped = run.status === 'cancelled';
      if (wasStopped) run.agent = undefined;
      // No live agent (restart restore, or a stopped run): rebuild the
      // continuation context from the run's OWN ledger and re-register its
      // writer — restore-on-open is records-only, so this is where the
      // transcript actually loads. A missing ledger degrades to an empty
      // context (the writer is registered empty), keeping the run resumable.
      if (!run.agent) {
        const restored = await this.host.restoreChildRunLedger(run.id);
        run.messages = (restored ?? []).map(cloneAgentMessage);
        run.toolResultBudgetState = restoreToolResultBudgetStateFromAgentMessages(run.messages);
      }
      // Rebuild the live agent BEFORE mutating run state: if the harness build
      // throws, the run keeps its prior terminal (result + status) instead of
      // being stranded as `running` with no agent and its result wiped.
      await this.ensureLiveAgent(run);
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
      run.detached = true;
      run.terminalNotificationSent = false;
      run.updatedAt = Date.now();
      // The restored history is the continuation seed, not this run's output:
      // salvage on a later `stop` starts after it (the new prompt + response
      // appended by `runChildAgent` below come after this floor).
      run.salvageFromIndex = run.agent ? run.agent.state.messages.length : 0;
      await this.host.childRunStatusChanged(snapshotRun(run));
      releaseStartupSlot();
      run.completion = this.runChildAgent(run, [message], undefined, true);
      return { ...runToToolData(run), status: 'queued', instructions: 'Agent continuation started in the background.' };
    } catch (error) {
      releaseStartupSlot();
      throw error;
    }
  }

  async amend(rawParams: unknown): Promise<AgentDelegateToolData> {
    const params = normalizeAmendParams(rawParams);
    const run = this.resolveRun({ agent_id: params.runId });
    this.assertRunControllable(run, 'amend');
    if (params.changes.objective !== undefined) {
      run.objective = params.changes.objective;
      run.prompt = buildObjectivePrompt(run.objective, run.criteria);
      run.description = compactInlineText(run.objective).slice(0, 200) || run.description;
    }
    if (params.changes.criteria !== undefined) run.criteria = params.changes.criteria;
    if (params.changes.budget !== undefined) {
      const nextBudget = normalizeRunBudget(params.changes.budget, run.budget, Date.now());
      // Keep the parent's token ledger in sync: a direct reassignment would leave
      // the original reservation in place while settleRunBudget later releases the
      // amended amount, corrupting the parent's headroom. Reconcile the delta
      // against the live reservation (with a headroom check on increases) unless
      // the run already settled.
      const parent = run.parentBudgetRef;
      if (parent?.tokens && !run.budgetSettled) {
        const previousTokens = run.budget?.tokens ?? 0;
        const nextTokens = nextBudget?.tokens ?? 0;
        const delta = nextTokens - previousTokens;
        if (delta > 0) {
          const headroom = Math.max(0, parent.tokens - (parent.reservedTokens ?? 0) - (parent.spentTokens ?? 0));
          if (delta > headroom) throw new Error('Amended run budget exceeds parent remaining token budget.');
        }
        if (delta !== 0) parent.reservedTokens = Math.max(0, (parent.reservedTokens ?? 0) + delta);
      }
      run.budget = nextBudget;
    }
    run.objectiveStatus = 'active';
    run.blockedReason = undefined;
    run.latestVerifierGap = undefined;
    run.updatedAt = Date.now();
    await this.host.childRunStatusChanged(snapshotRun(run));
    return {
      ...runToToolData(run),
      instructions: 'Run objective metadata was amended. Existing verifier conclusions are invalidated; use run_steer to provide execution guidance if needed.',
    };
  }

  async stop(rawParams: unknown): Promise<AgentDelegateToolData> {
    const params = normalizeRunSelector(rawParams);
    const run = this.resolveRun(params);
    this.assertRunControllable(run, 'stop');
    if (run.status === 'running') {
      run.status = 'cancelled';
      run.objectiveStatus = 'stopped';
      run.completedAt = Date.now();
      run.updatedAt = run.completedAt;
      // Salvage whatever the CURRENT live span produced before we abort, so the
      // synchronous tool result and the terminal notification carry the partial
      // work instead of an empty result. Scan only from `salvageFromIndex` (the
      // resume/compaction floor) so a resumed run stopped before it produces new
      // output reports nothing stale — the prior round's text sits below the
      // floor. Overwrite unconditionally when there IS a new partial, like the
      // completion path.
      if (run.agent) {
        const since = run.salvageFromIndex ?? 0;
        const liveSpan = (run.agent.state.messages as AgentMessage[]).slice(since);
        const partial = extractPartialAssistantText(liveSpan);
        if (partial !== undefined) run.result = partial;
      }
      run.agent?.abort();
      run.agent = undefined;
      // Settle here: nulling `run.agent` makes runChildAgent's finally guard
      // (`run.agent === agent`) fail, so its settleRunBudget never runs and the
      // parent's token reservation would otherwise leak permanently.
      settleRunBudget(run);
      await this.host.childRunStatusChanged(snapshotRun(run));
      if (run.detached) void this.notifyTerminalRun(run).catch(() => undefined);
    }
    return runToToolData(run);
  }

  private async startAgent(
    params: AgentToolParams,
    releaseStartupSlot: RunningSlotReservation,
    signal?: AbortSignal,
    parentToolCallId?: string,
  ): Promise<AgentDelegateToolData> {
    const contextMode = params.context;
    const scope = narrowRunScope(this.inheritedScope, params.scope);
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
    const background = params.detach === true || params.run_in_background === true || definition.background === true;
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
    } catch (error) {
      // The run object never formed, so runChildAgent's finally can never settle
      // the parent reservation admitRunBudget made above — release it here.
      releaseAdmittedRunBudget(parentBudget, budget);
      throw error;
    }
    const { skillRuntime, localWorkspace, childAgent } = childAgentHarness;
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
      prompt: params.prompt,
      objective: params.objective,
      criteria: params.criteria,
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
      completion: Promise.resolve(),
      detached: background,
      terminalNotificationSent: false,
      turnCount: 0,
      verify: params.verify,
      verificationAttempts: params.inheritedVerificationAttempts ?? 0,
      verifierRunIds: [...(params.inheritedVerifierRunIds ?? [])],
      hasWorkChildren: false,
      latestVerifierGap: undefined,
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
      autoCompactConsecutiveFailures: 0,
      autoCompactInProgress: false,
      skillRuntime,
      localWorkspace,
    };
    this.runs.set(runId, run);
    if (name) this.names.set(name, runId);
    releaseStartupSlot();
    this.subscribeToChild(run);
    this.installRunContextTransform(run);
    try {
      await this.host.childRunStarted(snapshotRun(run), { contextMessages, evidenceMessages });
    } catch (error) {
      // runChildAgent has not been wired yet, so settle here to avoid leaking the
      // parent reservation if the start announcement throws.
      settleRunBudget(run);
      throw error;
    }

    run.completion = this.runChildAgent(run, promptMessages, background ? undefined : signal, background);
    if (background) {
      return {
        ...runToToolData(run),
        status: 'async_launched',
        instructions: `The run is running in the background. Tenon will notify you automatically when it finishes. Use ${AGENT_STATUS_TOOL_NAME} with agent_id "${run.id}" only when you need an explicit progress check, ${AGENT_SEND_TOOL_NAME} to steer it, ${AGENT_AMEND_TOOL_NAME} to change objective/criteria/budget, or ${AGENT_STOP_TOOL_NAME} to stop it.`,
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
  }> {
    const childConversationId = `${this.hostConversationPrefix()}-${input.runId}`;
    const runtimeSettings = await this.host.getRuntimeSettings();
    let childRuntime: AgentDelegationRuntime;
    let childAgent: Agent | null = null;
    const skillRuntime = new AgentSkillRuntime({
      localRoot: this.localRoot,
      additionalSkillDirectories: runtimeSettings.additionalSkillDirectories,
      provenanceStore: createAgentSkillProvenanceStore(),
      conversationId: childConversationId,
      executeIsolatedSkill: async ({ skill, renderedContent, parentToolCallId, readOnlyIsolated }) => {
        const data = await childRuntime.invokeSkillChildAgent({
          skillName: skill.name,
          description: skill.description,
          renderedContent,
          model: skill.model,
          effort: skill.effort,
          allowedTools: skill.allowedTools,
          readOnlyIsolated,
        }, undefined, parentToolCallId);
        return {
          agentId: data.agent_id,
          agentType: data.agent_type,
          status: data.status,
          result: data.result,
          error: data.error,
        };
      },
    });
    skillRuntime.updateDisabledSkills(runtimeSettings.disabledSkills ?? []);
    const localWorkspace = createAgentLocalWorkspaceContext(this.localRoot, this.scratchRoot, skillRuntime);
    // A fork runs AS its spawner, so it INHERITS the spawner's approval attribution
    // (undefined when the spawner is the user's own top agent). The child's runtime
    // carries it so the child's OWN forks inherit it in turn.
    const requestedByAgentId = this.requestedByAgentId;
    childRuntime = new AgentDelegationRuntime({
      conversationId: childConversationId,
      executingAgentId: input.executingAgentId,
      memoryOwnerAgentId: input.memoryOwnerAgentId,
      requestedByAgentId,
      localRoot: this.localRoot,
      scratchRoot: this.scratchRoot,
      depth: this.depth + 1,
      maxDepth: this.maxDepth,
      ancestry: [...this.ancestry, input.definition.name],
      scope: input.scope,
      budget: input.budget,
      // A grandchild's parent run is THIS child run — the run tree chains.
      host: this.buildChildHost(() => input.runId, () => childAgent),
    });
    childRuntime.updateDisabledAgents(runtimeSettings.disabledAgents ?? []);
    const systemPrompt = this.host.getParentSystemPrompt();
    childAgent = this.host.createChildAgent({
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
      delegationRuntime: childRuntime,
      allowedTools: input.definition.tools,
      disallowedTools: input.definition.disallowedTools,
      preapprovedToolRules: input.preapprovedToolRules,
      l0CacheBreakpointEnabled: false,
      unattended: input.unattended,
      afterToolResult: input.afterToolResult,
    });
    return { skillRuntime, localWorkspace, childAgent };
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
    subscribedAgent.subscribe((event: AgentEvent) => {
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
          run.messages.push(cloneAgentMessage(event.message));
          run.updatedAt = Date.now();
          // Best-effort (a ledger write must not abort the live run), but never
          // silent: a persistently failing append means the drill-in transcript
          // and Dream evidence silently fall behind the live run.
          void this.host.childRunMessage(snapshotRun(run), event.message as AgentMessage).catch((error) => {
            const message = `Failed to append a child-run message to the ${run.id} ledger: ${error instanceof Error ? error.message : String(error)}`;
            if (this.host.reportError) {
              this.host.reportError({
                domain: 'persistence',
                severity: 'warn',
                code: 'child-run-message-ledger-failed',
                message,
                context: { runId: run.id, operation: 'childRunMessage' },
                error,
              });
            } else {
              console.warn(message);
            }
          });
        }
      }
    });
  }

  private async runChildAgent(
    run: DelegationRunState,
    messages: AgentMessage[],
    signal: AbortSignal | undefined,
    detached: boolean,
  ): Promise<AgentDelegateToolData | void> {
    if (!run.agent) throw new Error(`Agent ${run.id} is not live in this process.`);
    const agent = run.agent;
    const abort = () => agent.abort();
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const budgetDelayMs = remainingBudgetMs(run);
    if (signal && !detached) {
      if (signal.aborted) abort();
      signal.addEventListener('abort', abort, { once: true });
    }
    if (budgetDelayMs !== null) {
      if (budgetDelayMs <= 0) {
        run.status = 'failed';
        run.objectiveStatus = 'budget_exhausted';
        run.error = 'Run budget exhausted before execution could start.';
        run.blockedReason = run.error;
        run.completedAt = Date.now();
        run.updatedAt = run.completedAt;
        agent.abort();
      } else {
        // Re-arm in 32-bit-safe hops so a far-future deadline (large wall-clock
        // budget) is honored at the real time instead of overflowing setTimeout
        // and killing the run on the next tick.
        const armBudgetTimer = (delayMs: number) => {
          budgetTimer = setTimeout(() => {
            if (run.agent !== agent || run.status !== 'running') return;
            const remaining = remainingBudgetMs(run);
            if (remaining !== null && remaining > 0) {
              armBudgetTimer(remaining);
              return;
            }
            run.status = 'failed';
            run.objectiveStatus = 'budget_exhausted';
            run.error = 'Run wall-clock budget exhausted.';
            run.blockedReason = run.error;
            run.completedAt = Date.now();
            run.updatedAt = run.completedAt;
            agent.abort();
          }, Math.min(delayMs, MAX_SETTIMEOUT_DELAY_MS));
        };
        armBudgetTimer(budgetDelayMs);
      }
    }
    const workingSetSnapshot = run.verify && run.purpose !== 'verify'
      ? await captureWorkingSetSnapshot(this.localRoot, run.scope).catch(() => undefined)
      : undefined;
    try {
      if (run.status === 'running') await agent.prompt(messages);
      if (run.agent !== agent) return;
      const terminalAssistant = lastAssistantMessage(agent.state.messages as AgentMessage[]);
      if (terminalAssistant && isContextOverflow(terminalAssistant, agent.state.model.contextWindow)) {
        const compacted = await this.compactRunMessages(run, agent.state.messages as AgentMessage[], 'reactive', signal);
        if (compacted) {
          await agent.continue();
          if (run.agent !== agent) return;
        }
      }
      if (run.status === 'running') {
        const errorMessage = agent.state.errorMessage;
        if (errorMessage) {
          run.status = 'failed';
          run.error = errorMessage;
        } else {
          run.status = 'completed';
          run.result = extractFinalAssistantText(agent.state.messages as AgentMessage[]);
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
        run.completedAt = Date.now();
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
        run.completedAt = Date.now();
        run.updatedAt = run.completedAt;
      }
    } finally {
      if (budgetTimer) clearTimeout(budgetTimer);
      if (signal && !detached) signal.removeEventListener('abort', abort);
      if (run.agent === agent) {
        if (run.status !== 'running') settleRunBudget(run);
        await this.host.childRunStatusChanged(snapshotRun(run)).catch(() => undefined);
        if (detached) void this.notifyTerminalRun(run).catch(() => undefined);
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
      const submission = await this.host.childRunResultSubmitted(snapshotRun(run), {
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
    run.objectiveStatus = 'verifying';
    run.updatedAt = Date.now();
    await this.host.childRunStatusChanged(snapshotRun(run)).catch(() => undefined);

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
        prompt: verifierObjective,
        purpose: 'verify',
        context: 'none',
        runProfile: 'verify',
        scope: verifierRunScope(this.inheritedScope),
        budget: verifierBudgetForRun(run),
        run_in_background: false,
        allowedTools: readOnlyAgentToolNames(),
        parentRunId: run.id,
        parentBudget: run.budget,
        unattended: true,
      }, releaseStartupSlot, signal);
    } catch (error) {
      releaseStartupSlot?.();
      run.objectiveStatus = 'blocked';
      run.blockedReason = `Verifier failed to start: ${errorMessage(error)}`;
      run.updatedAt = Date.now();
      await this.host.childRunStatusChanged(snapshotRun(run)).catch(() => undefined);
      return;
    }

    run.verifierRunIds.push(verifier.agent_id);
    // A verifier that did not itself complete (model error, context overflow,
    // abort) produced no verdict. Treat that as inconclusive — block for triage
    // — never as a `fail` verdict, which would fabricate a phantom gap and burn
    // budget replanning/replacing against it.
    if (verifier.status !== 'completed' || !verifier.result?.trim()) {
      run.objectiveStatus = 'blocked';
      run.blockedReason = `Verification could not complete: ${verifier.error?.trim() || 'verifier returned no verdict'}.`;
      run.updatedAt = Date.now();
      await this.host.childRunStatusChanged(snapshotRun(run)).catch(() => undefined);
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
        return await this.replanControllerInPlace(run, verdict.gap, signal, detached);
      }
      return await this.replaceFailedWorkerRun(run, verdict.gap, signal, detached);
    }

    run.objectiveStatus = remainingBudgetMs(run) === 0 ? 'budget_exhausted' : 'blocked';
    run.blockedReason = verdict.gap || 'Verifier rejected the run result.';
    run.updatedAt = Date.now();
  }

  private isControllerRun(run: DelegationRunState): boolean {
    if (run.objectiveStatus && !run.parentRunId) return true;
    return run.hasWorkChildren === true;
  }

  private async replanControllerInPlace(
    run: DelegationRunState,
    verifierGap: string,
    signal: AbortSignal | undefined,
    detached: boolean,
  ): Promise<AgentDelegateToolData | void> {
    const releaseStartupSlot = this.reserveRunningSlot();
    try {
      if (!run.agent) {
        const restored = await this.host.restoreChildRunLedger(run.id);
        run.messages = (restored ?? []).map(cloneAgentMessage);
        run.toolResultBudgetState = restoreToolResultBudgetStateFromAgentMessages(run.messages);
      }
      await this.ensureLiveAgent(run);
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
      await this.host.childRunStatusChanged(snapshotRun(run)).catch(() => undefined);
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
      run.objectiveStatus = 'blocked';
      run.blockedReason = `Verifier rejected this controller, and re-plan failed to start: ${errorMessage(error)}`;
      run.updatedAt = Date.now();
      await this.host.childRunStatusChanged(snapshotRun(run)).catch(() => undefined);
      return;
    }
  }

  private async replaceFailedWorkerRun(
    run: DelegationRunState,
    verifierGap: string,
    signal: AbortSignal | undefined,
    detached: boolean,
  ): Promise<AgentDelegateToolData | void> {
    run.objectiveStatus = 'blocked';
    run.blockedReason = `Verifier rejected this worker attempt: ${verifierGap || 'unspecified gap'}`;
    run.updatedAt = Date.now();
    settleRunBudget(run);
    await this.host.childRunStatusChanged(snapshotRun(run)).catch(() => undefined);

    const releaseStartupSlot = this.reserveRunningSlot();
    const objective = run.objective ?? run.prompt ?? run.description ?? 'Continue the verified run objective.';
    const retryObjective = buildReplacementWorkerObjective(objective, verifierGap);
    try {
      const replacement = await this.startAgent({
        objective: retryObjective,
        criteria: run.criteria,
        verify: true,
        description: run.description,
        prompt: buildObjectivePrompt(retryObjective, run.criteria),
        purpose: 'work',
        scope: run.scope,
        budget: retryBudgetSlice(run.budget),
        context: 'none',
        runProfile: run.runProfile,
        detach: detached,
        model: run.definition?.model === 'inherit' ? undefined : run.definition?.model,
        effort: run.definition?.effort,
        run_in_background: detached,
        allowedTools: run.definition?.tools,
        preapprovedToolRules: run.preapprovedToolRules,
        parentRunId: run.parentRunId,
        inheritedVerificationAttempts: run.verificationAttempts,
        inheritedVerifierGapSignatures: run.verifierGapSignatures,
        inheritedVerifierRunIds: run.verifierRunIds,
        unattended: run.unattended,
      }, releaseStartupSlot, signal, run.parentToolCallId);
      run.blockedReason = `${run.blockedReason}; replacement run ${replacement.agent_id} started.`;
      // The replacement carries the objective forward and will fire its own
      // terminal notification; suppress this superseded attempt's so the user is
      // not told a rejected run "completed" and then notified again.
      run.terminalNotificationSent = true;
      run.updatedAt = Date.now();
      await this.host.childRunStatusChanged(snapshotRun(run)).catch(() => undefined);
      return replacement;
    } catch (error) {
      releaseStartupSlot();
      run.blockedReason = `Verifier rejected this worker attempt, and replacement failed to start: ${errorMessage(error)}`;
      run.updatedAt = Date.now();
      await this.host.childRunStatusChanged(snapshotRun(run)).catch(() => undefined);
      return;
    }
  }

  private async notifyTerminalRun(run: DelegationRunState): Promise<void> {
    if (run.status === 'running') return;
    if (run.terminalNotificationSent) return;
    run.terminalNotificationSent = true;
    await this.host.notifyChildRun(snapshotRun(run));
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
      const persisted = await this.host.persistToolOutputPayload(childRunToolOutputPayloadId(run, toolCallId), toolName, text);
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
      void this.host.childRunToolResultReplaced(snapshotRun(run), candidate.toolCallId, candidate.replacement).catch(() => undefined);
      changed = true;
    }

    for (const candidate of selection.toPersist) {
      throwIfAborted(signal);
      const message = nextMessages[candidate.messageIndex];
      if (!message || message.role !== 'toolResult') continue;
      try {
        const persisted = await this.host.persistToolOutputPayload(
          childRunToolOutputPayloadId(run, candidate.toolCallId),
          candidate.toolName,
          candidate.contentText,
        );
        replaceToolResultText(message, persisted.label);
        run.toolResultBudgetState.seenIds.add(candidate.toolCallId);
        run.toolResultBudgetState.replacements.set(candidate.toolCallId, persisted.label);
        // The ledger records what the model sees from here on (`tool_result.replaced`).
        void this.host.childRunToolResultReplaced(snapshotRun(run), candidate.toolCallId, persisted.label).catch(() => undefined);
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
        // Every child run is a fork (the one-Neva invariant): omit copied parent
        // context that only predates the fork assignment; preserve the assignment,
        // child run actions, user follow-ups, and final result.
        'This is a fork child run transcript. Omit copied parent conversation context that only predates the fork assignment; preserve the fork assignment, child run actions, user follow-ups, and final result.',
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
      await this.host.childRunCompacted(snapshotRun(run), {
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
    const { skillRuntime, localWorkspace, childAgent } = await this.buildChildAgentHarness({
      runId: run.id,
      definition,
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
    run.skillRuntime = skillRuntime;
    run.localWorkspace = localWorkspace;
    run.nodeChanges = {};
    run.fileChanges = {};
    run.toolTrace = [];
    run.verifierGapSignatures = [];
    this.subscribeToChild(run);
    this.installRunContextTransform(run);
  }

  /**
   * The grandchild runtime's host: every callback forwards to THIS runtime's
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
      childRunStarted: (snapshot, seed) => {
        if (snapshot.purpose !== 'verify') {
          const parent = this.runs.get(getRunId());
          if (parent) parent.hasWorkChildren = true;
        }
        this.upsertObservedRun(snapshot);
        return this.host.childRunStarted(snapshot, seed);
      },
      childRunMessage: (snapshot, message) => this.host.childRunMessage(snapshot, message),
      childRunToolResultReplaced: (snapshot, toolCallId, text) => this.host.childRunToolResultReplaced(snapshot, toolCallId, text),
      childRunCompacted: (snapshot, input) => this.host.childRunCompacted(snapshot, input),
      childRunResultSubmitted: (snapshot, input) => this.host.childRunResultSubmitted(snapshot, input),
      readLatestRunSubmission: (runId) => this.host.readLatestRunSubmission?.(runId) ?? Promise.resolve(undefined),
      childRunStatusChanged: (snapshot) => {
        this.upsertObservedRun(snapshot);
        return this.host.childRunStatusChanged(snapshot);
      },
      notifyChildRun: (snapshot) => this.host.notifyChildRun(snapshot),
      reportError: (report) => this.host.reportError?.(report),
      restoreChildRunLedger: (runId) => this.host.restoreChildRunLedger(runId),
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
    // Every child run is a fork of Neva (the one-Neva invariant) — there is no
    // by-name agent to resolve.
    return createForkAgentDefinition();
  }

  private reserveRunningSlot(): RunningSlotReservation {
    if (this.runningCount() + this.reservedRunningSlots >= MAX_CONCURRENT_CHILD_RUNS) {
      throw new Error(`Too many child runs are already running in this session. Limit: ${MAX_CONCURRENT_CHILD_RUNS}.`);
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

  private resolveRun(selector: { agent_id?: string; name?: string }): DelegationRunState {
    const id = selector.agent_id || (selector.name ? this.names.get(selector.name) : undefined);
    if (!id) throw new Error('Provide agent_id or name.');
    const run = this.runs.get(id);
    if (!run) throw new Error(`Unknown agent: ${id}`);
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

  private upsertObservedRun(snapshot: AgentChildRunSnapshot): void {
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
        detached: false,
        terminalNotificationSent: true,
        turnCount: 0,
        verify: snapshot.purpose !== 'verify' && (snapshot.criteria?.length ?? 0) > 0,
        verificationAttempts: 0,
        verifierRunIds: [],
        hasWorkChildren: false,
        latestVerifierGap: snapshot.latestVerifierGap,
        toolResultBudgetState: createToolResultBudgetState(),
        nodeChanges: {},
        fileChanges: {},
        toolTrace: [],
        verifierGapSignatures: [],
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
      throw new Error(`Child run nesting limit reached (${this.maxDepth}). Complete the task directly.`);
    }
    void nextAgentName;
  }

  private hostConversationPrefix(): string {
    return this.conversationId;
  }
}

export function createAgentDelegationTools(runtime: AgentDelegationRuntime): AgentTool<any, ToolEnvelope<AgentDelegateToolData>>[] {
  return [
    {
      name: AGENT_DELEGATE_TOOL_NAME,
      label: 'Spawn Run',
      description: [
        'Spawn an isolated child Run for a focused objective with explicit acceptance criteria.',
        'Use context to choose full, brief, or no inherited parent context.',
        'Launch multiple runs in the same turn when independent work can run in parallel.',
        `For long work, set detach and use ${AGENT_STATUS_TOOL_NAME}, ${AGENT_SEND_TOOL_NAME}, ${AGENT_AMEND_TOOL_NAME}, or ${AGENT_STOP_TOOL_NAME} with the returned runId.`,
      ].join('\n'),
      parameters: AGENT_TOOL_PARAMETERS,
      executionMode: 'parallel',
      execute: async (toolCallId, rawParams, signal) => {
        try {
          return delegateToolResult(AGENT_DELEGATE_TOOL_NAME, await runtime.invokeAgent(rawParams, signal, toolCallId));
        } catch (error) {
          return agentToolResult(errorEnvelope(AGENT_DELEGATE_TOOL_NAME, 'agent_failed', errorMessage(error)));
        }
      },
    },
    {
      name: AGENT_STATUS_TOOL_NAME,
      label: 'Run Status',
      description: 'Check a same-session background run by runId or name.',
      parameters: AGENT_STATUS_PARAMETERS,
      executionMode: 'parallel',
      execute: async (_toolCallId, rawParams) => {
        try {
          return delegateToolResult(AGENT_STATUS_TOOL_NAME, await runtime.status(rawParams));
        } catch (error) {
          return agentToolResult(errorEnvelope(AGENT_STATUS_TOOL_NAME, 'agent_status_failed', errorMessage(error)));
        }
      },
    },
    {
      name: AGENT_SEND_TOOL_NAME,
      label: 'Run Steer',
      description: 'Send a soft steering message to an existing same-session background run without changing its objective or criteria.',
      parameters: AGENT_SEND_PARAMETERS,
      executionMode: 'parallel',
      execute: async (_toolCallId, rawParams) => {
        try {
          return delegateToolResult(AGENT_SEND_TOOL_NAME, await runtime.send(rawParams));
        } catch (error) {
          return agentToolResult(errorEnvelope(AGENT_SEND_TOOL_NAME, 'agent_send_failed', errorMessage(error)));
        }
      },
    },
    {
      name: AGENT_AMEND_TOOL_NAME,
      label: 'Run Amend',
      description: 'Hard-amend an existing run objective, acceptance criteria, or budget. This invalidates prior verifier conclusions.',
      parameters: AGENT_AMEND_PARAMETERS,
      executionMode: 'parallel',
      execute: async (_toolCallId, rawParams) => {
        try {
          return delegateToolResult(AGENT_AMEND_TOOL_NAME, await runtime.amend(rawParams));
        } catch (error) {
          return agentToolResult(errorEnvelope(AGENT_AMEND_TOOL_NAME, 'agent_amend_failed', errorMessage(error)));
        }
      },
    },
    {
      name: AGENT_STOP_TOOL_NAME,
      label: 'Run Stop',
      description: 'Stop a running same-session background run.',
      parameters: AGENT_STOP_PARAMETERS,
      executionMode: 'parallel',
      execute: async (_toolCallId, rawParams) => {
        try {
          return delegateToolResult(AGENT_STOP_TOOL_NAME, await runtime.stop(rawParams));
        } catch (error) {
          return agentToolResult(errorEnvelope(AGENT_STOP_TOOL_NAME, 'agent_stop_failed', errorMessage(error)));
        }
      },
    },
  ];
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
  if (params.purpose === 'verify') return params.prompt;
  const criteria = params.criteria?.length
    ? params.criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join('\n')
    : 'No acceptance criteria were provided because verify is false.';
  const budget = formatRunBudgetForPrompt(params.budget);
  const scope = formatRunScopeForPrompt(params.scope);
  return [
    `<${FORK_BOILERPLATE_TAG}>`,
    'STOP. READ THIS FIRST.',
    '',
    'You are a Tenon child Run. You may decompose your objective by spawning child Runs when that is the most reliable way to finish.',
    '',
    'Controller rules:',
    '1. Stay strictly within the objective and acceptance criteria.',
    `2. When spawning child Runs, use ${AGENT_DELEGATE_TOOL_NAME} with explicit objective and criteria.`,
    '3. Verify child results before accepting them as done; spawn replacement work for rejected child results when budget remains.',
    '4. Do not ask the user questions from this child Run; block with a concise reason if owner input is genuinely required.',
    '5. Keep the final report factual and concise, naming what was verified and any residual gaps.',
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

function buildVerifierObjective(run: DelegationRunState): string {
  const nodeChanges = compactNodeChanges(run.nodeChanges) ?? {};
  const fileChanges = compactFileChanges(run.fileChanges) ?? {};
  return [
    'You are an independent verifier Run. Inspect the submitted child Run result and return only compact JSON with this exact shape:',
    '{"verdict":"pass"|"fail","gap":"short reason when fail"}',
    '',
    'Rules:',
    '1. Do not accept claims without evidence in the result or inspectable state.',
    '2. Use only read-only tools when inspection is needed.',
    '3. Fail if any acceptance criterion is incomplete, ambiguous, or unverifiable.',
    '4. Your final message MUST be the JSON object and nothing else — no prose, no code fences. A passing run REQUIRES "verdict":"pass"; any other final message is read as a failure.',
    '',
    `Run id: ${run.id}`,
    `Objective:\n${run.objective ?? run.prompt}`,
    '',
    'Acceptance criteria:',
    ...(run.criteria ?? []).map((criterion, index) => `${index + 1}. ${criterion}`),
    '',
    `Execution status: ${run.status}`,
    `Objective status before verification: ${run.objectiveStatus ?? 'unknown'}`,
    run.incomplete ? 'The worker was marked incomplete.' : '',
    run.error ? `Worker error:\n${run.error}` : '',
    '',
    `Worker result:\n${latestRunSubmissionSummary(run) ?? run.result ?? 'No text result.'}`,
    '',
    `Node changes:\n${JSON.stringify(nodeChanges, null, 2)}`,
    '',
    `File changes:\n${JSON.stringify(fileChanges, null, 2)}`,
    '',
    `Tool trace:\n${JSON.stringify(run.toolTrace, null, 2)}`,
  ].filter(Boolean).join('\n');
}

function buildControllerReplanPrompt(run: DelegationRunState, gap: string): string {
  return [
    'Your previous submission did not pass independent verification.',
    '',
    `Verifier gap: ${gap || 'The verifier rejected the result without a detailed gap.'}`,
    '',
    'Continue the same objective. Address the verifier gap directly, then submit a concise final result that maps to the acceptance criteria.',
    '',
    `Objective:\n${run.objective ?? run.prompt}`,
    '',
    'Acceptance criteria:',
    ...(run.criteria ?? []).map((criterion, index) => `${index + 1}. ${criterion}`),
  ].join('\n');
}

function buildReplacementWorkerObjective(objective: string, gap: string): string {
  return [
    objective,
    '',
    `Verifier gap from the previous worker attempt: ${gap || 'The verifier rejected the result without a detailed gap.'}`,
    'Produce a fresh result that directly closes this gap.',
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

export function delegateToolResult(toolName: string, data: AgentDelegateToolData) {
  // Next-step guidance is an envelope concern, not data: lift data.instructions
  // to the envelope's instructions field so it sits beside status/error like
  // every other tool, rather than nested inside the result payload.
  const envelope = successEnvelope(toolName, data, data.instructions ? { instructions: data.instructions } : {});
  return agentToolResult(envelope, visibleChildRunResult(data));
}

// Model-visible projection. The full AgentDelegateToolData stays on the envelope
// (details); the parent agent needs lifecycle state, addressability, verdict
// blockers, one-level child summaries for controllers, and produced result/error.
// Next-step instructions are carried by the envelope's instructions field.
// Echoed launch arguments (prompt, description, agent_type, context_mode) and
// timestamps/transcript counts are dropped.
export function visibleChildRunResult(data: AgentDelegateToolData): unknown {
  const visible: Record<string, unknown> = {
    status: data.status,
    agent_id: data.agent_id,
  };
  if (data.name) visible.name = data.name;
  if (data.objective_status) visible.objective_status = data.objective_status;
  if (data.budget) visible.budget = data.budget;
  if (data.children && data.children.length > 0) visible.children = data.children;
  if (data.latest_verifier_gap) visible.latest_verifier_gap = data.latest_verifier_gap;
  if (data.blocked_reason) visible.blocked_reason = data.blocked_reason;
  if (data.result !== undefined) visible.result = data.result;
  if (data.error !== undefined) visible.error = data.error;
  return visible;
}

export function recordNodeToolChanges(
  changes: AgentChildRunNodeChanges,
  toolName: string,
  result: unknown,
  isError: boolean,
): void {
  if (isError) return;
  if (toolName === 'node_delete') {
    const details = isPlainRecord(result) ? result.details : undefined;
    if (!isToolEnvelope(details) || !details.ok || details.status === 'unchanged' || !isPlainRecord(details.data)) return;
    appendUniqueNodeIds(changes, 'trashedNodeIds', stringArray(details.data.deletedNodeIds));
    appendUniqueNodeIds(changes, 'updatedNodeIds', stringArray(details.data.restoredNodeIds));
    return;
  }
  if (toolName !== 'node_create' && toolName !== 'node_edit') return;
  const details = isPlainRecord(result) ? result.details : undefined;
  if (!isToolEnvelope(details) || !details.ok || details.status === 'unchanged' || !isPlainRecord(details.data)) return;

  const created = stringArray(details.data.createdNodeIds);
  appendUniqueNodeIds(changes, 'createdNodeIds', created);

  if (toolName !== 'node_edit') return;
  if (details.data.status !== 'updated') return;
  const trashed = stringArray(details.data.trashedNodeIds);
  appendUniqueNodeIds(changes, 'trashedNodeIds', trashed);
  const changedExisting = stringArray(details.data.affectedNodeIds)
    .filter((nodeId) => !created.includes(nodeId) && !trashed.includes(nodeId));
  appendUniqueNodeIds(changes, 'updatedNodeIds', changedExisting);
}

function recordFileToolChanges(
  changes: AgentChildRunFileChanges,
  toolName: string,
  result: unknown,
  isError: boolean,
): void {
  if (isError) return;
  if (toolName !== 'file_edit' && toolName !== 'file_write' && toolName !== 'file_delete') return;
  const details = isPlainRecord(result) ? result.details : undefined;
  if (!isToolEnvelope(details) || !details.ok || details.status === 'unchanged' || !isPlainRecord(details.data)) return;

  const filePath = coerceString(details.data.filePath);
  if (!filePath) return;
  if (toolName === 'file_delete') {
    appendUniqueStrings(changes, 'deletedPaths', [filePath]);
    appendFilePatch(changes, {
      filePath,
      operation: 'delete',
      trashPath: coerceString(details.data.trashPath),
      kind: coerceString(details.data.kind),
    });
    return;
  }

  const operation = toolName === 'file_write' && details.data.type === 'create' ? 'create' : 'update';
  appendUniqueStrings(changes, operation === 'create' ? 'createdPaths' : 'updatedPaths', [filePath]);
  appendFilePatch(changes, {
    filePath,
    operation,
    structuredPatch: normalizeStructuredPatch(details.data.structuredPatch),
  });
}

function recordToolTrace(
  trace: AgentChildRunToolTraceEntry[],
  toolName: string,
  result: unknown,
  isError: boolean,
): void {
  const details = isPlainRecord(result) ? result.details : undefined;
  const entry: AgentChildRunToolTraceEntry = { toolName, isError };
  if (isToolEnvelope(details)) {
    entry.status = details.status;
    entry.summary = summarizeToolEnvelopeForVerifier(details);
  } else if (isPlainRecord(result) && Array.isArray(result.content)) {
    entry.summary = truncate(piToolResultTextContent(result.content as Array<TextContent | ImageContent>) ?? '', 500);
  }
  trace.push(entry);
  if (trace.length > MAX_RECORDED_TOOL_TRACE_ENTRIES) {
    trace.splice(0, trace.length - MAX_RECORDED_TOOL_TRACE_ENTRIES);
  }
}

function compactNodeChanges(changes: AgentChildRunNodeChanges): AgentChildRunNodeChanges | undefined {
  const compacted: AgentChildRunNodeChanges = {};
  if (changes.createdNodeIds?.length) compacted.createdNodeIds = changes.createdNodeIds;
  if (changes.updatedNodeIds?.length) compacted.updatedNodeIds = changes.updatedNodeIds;
  if (changes.trashedNodeIds?.length) compacted.trashedNodeIds = changes.trashedNodeIds;
  return Object.keys(compacted).length ? compacted : undefined;
}

function compactFileChanges(changes: AgentChildRunFileChanges): AgentChildRunFileChanges | undefined {
  const compacted: AgentChildRunFileChanges = {};
  if (changes.createdPaths?.length) compacted.createdPaths = changes.createdPaths;
  if (changes.updatedPaths?.length) compacted.updatedPaths = changes.updatedPaths;
  if (changes.deletedPaths?.length) compacted.deletedPaths = changes.deletedPaths;
  if (changes.patches?.length) compacted.patches = changes.patches;
  return Object.keys(compacted).length ? compacted : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function normalizeStructuredPatch(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 50).map((entry) => isPlainRecord(entry) ? { ...entry } : entry);
}

async function captureWorkingSetSnapshot(localRoot: string, scope: AgentRunScope | undefined): Promise<WorkingSetSnapshot> {
  const root = path.resolve(localRoot);
  const startPaths = scope?.resources?.paths?.length
    ? scope.resources.paths.map((entry) => resolveScopedPath(root, entry)).filter((entry): entry is string => entry !== null)
    : [root];
  const snapshot: WorkingSetSnapshot = { files: new Map(), truncated: false };
  for (const startPath of startPaths) {
    if (snapshot.truncated) break;
    await walkWorkingSetPath(root, startPath, snapshot);
  }
  return snapshot;
}

async function recordWorkingSetDiff(
  changes: AgentChildRunFileChanges,
  localRoot: string,
  before: WorkingSetSnapshot,
  scope: AgentRunScope | undefined,
): Promise<void> {
  const after = await captureWorkingSetSnapshot(localRoot, scope);
  if (before.truncated || after.truncated) {
    appendFilePatch(changes, {
      filePath: '<working-set-snapshot>',
      operation: 'update',
      structuredPatch: [{
        source: 'working-set-snapshot',
        warning: 'Snapshot file limit reached; indirect file evidence may be incomplete.',
        maxFiles: MAX_WORKING_SET_SNAPSHOT_FILES,
      }],
    });
  }

  // Files the file tools already recorded carry precise structured patches; the
  // snapshot exists only to surface out-of-band edits (shell scripts, etc.).
  // Skip the tool-recorded paths so the verifier isn't handed the same file twice
  // in two divergent formats. Tool paths and snapshot keys are both absolute.
  const toolRecorded = new Set<string>([
    ...(changes.createdPaths ?? []),
    ...(changes.updatedPaths ?? []),
    ...(changes.deletedPaths ?? []),
  ]);

  for (const [filePath, afterFile] of after.files) {
    if (toolRecorded.has(filePath)) continue;
    const beforeFile = before.files.get(filePath);
    if (!beforeFile) {
      appendUniqueStrings(changes, 'createdPaths', [filePath]);
      appendFilePatch(changes, {
        filePath,
        operation: 'create',
        structuredPatch: [workingSetPatch('created', undefined, afterFile)],
      });
      continue;
    }
    if (workingSetFileChanged(beforeFile, afterFile)) {
      appendUniqueStrings(changes, 'updatedPaths', [filePath]);
      appendFilePatch(changes, {
        filePath,
        operation: 'update',
        structuredPatch: [workingSetPatch('updated', beforeFile, afterFile)],
      });
    }
  }

  for (const [filePath, beforeFile] of before.files) {
    if (after.files.has(filePath) || toolRecorded.has(filePath)) continue;
    appendUniqueStrings(changes, 'deletedPaths', [filePath]);
    appendFilePatch(changes, {
      filePath,
      operation: 'delete',
      structuredPatch: [workingSetPatch('deleted', beforeFile, undefined)],
    });
  }
}

async function walkWorkingSetPath(root: string, targetPath: string, snapshot: WorkingSetSnapshot): Promise<void> {
  if (snapshot.truncated || !isInsidePath(root, targetPath)) return;
  let entryStat;
  try {
    entryStat = await stat(targetPath);
  } catch {
    return;
  }
  if (entryStat.isDirectory()) {
    if (WORKING_SET_EXCLUDED_DIRS.has(path.basename(targetPath))) return;
    let entries;
    try {
      entries = await readdir(targetPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (snapshot.truncated) return;
      if (entry.isDirectory() && WORKING_SET_EXCLUDED_DIRS.has(entry.name)) continue;
      await walkWorkingSetPath(root, path.join(targetPath, entry.name), snapshot);
    }
    return;
  }
  if (!entryStat.isFile()) return;
  if (snapshot.files.size >= MAX_WORKING_SET_SNAPSHOT_FILES) {
    snapshot.truncated = true;
    return;
  }
  const relativePath = path.relative(root, targetPath) || path.basename(targetPath);
  // Stat only — no content hashing. Hashing every file in the tree twice (before
  // and after each verified run) was the dominant snapshot cost; size + mtime is
  // a cheap, reliable change signal for the out-of-band edits this snapshot is
  // meant to catch (tool edits already carry precise patches and are deduped out).
  snapshot.files.set(targetPath, {
    filePath: targetPath,
    relativePath,
    size: entryStat.size,
    mtimeMs: Math.trunc(entryStat.mtimeMs),
  });
}

function resolveScopedPath(root: string, input: string): string | null {
  const resolved = path.resolve(path.isAbsolute(input) ? input : path.join(root, input));
  return isInsidePath(root, resolved) ? resolved : null;
}

function isInsidePath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function workingSetFileChanged(before: WorkingSetFileSnapshot, after: WorkingSetFileSnapshot): boolean {
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs;
}

function workingSetPatch(
  change: 'created' | 'updated' | 'deleted',
  before: WorkingSetFileSnapshot | undefined,
  after: WorkingSetFileSnapshot | undefined,
): Record<string, unknown> {
  return {
    source: 'working-set-snapshot',
    change,
    relativePath: after?.relativePath ?? before?.relativePath,
    before: before ? { size: before.size } : undefined,
    after: after ? { size: after.size } : undefined,
  };
}

function summarizeToolEnvelopeForVerifier(details: ToolEnvelope): string | undefined {
  if (details.error) return truncate(`${details.error.code}: ${details.error.message}`, 500);
  if (!isPlainRecord(details.data)) return undefined;
  const summary: Record<string, unknown> = {};
  for (const key of ['filePath', 'trashPath', 'type', 'kind', 'status', 'nodeId', 'createdNodeIds', 'affectedNodeIds', 'deletedNodeIds', 'restoredNodeIds']) {
    if (details.data[key] !== undefined) summary[key] = details.data[key];
  }
  if (Array.isArray(details.data.structuredPatch)) summary.structuredPatch = details.data.structuredPatch.slice(0, 10);
  return Object.keys(summary).length ? truncate(JSON.stringify(summary), 1_000) : undefined;
}

function appendUniqueStrings(
  changes: AgentChildRunFileChanges,
  key: 'createdPaths' | 'updatedPaths' | 'deletedPaths',
  values: readonly string[],
): void {
  if (values.length === 0) return;
  const current = changes[key] ?? [];
  const existing = new Set(current);
  const next = [...current];
  for (const value of values) {
    if (existing.has(value)) continue;
    existing.add(value);
    next.push(value);
  }
  changes[key] = next;
}

function appendFilePatch(
  changes: AgentChildRunFileChanges,
  patch: NonNullable<AgentChildRunFileChanges['patches']>[number],
): void {
  changes.patches ??= [];
  changes.patches.push(patch);
  if (changes.patches.length > 50) changes.patches.splice(0, changes.patches.length - 50);
}

function appendUniqueNodeIds(
  changes: AgentChildRunNodeChanges,
  key: keyof AgentChildRunNodeChanges,
  nodeIds: readonly string[],
): void {
  if (nodeIds.length === 0) return;
  const current = changes[key] ?? [];
  const existing = new Set(current);
  const next = [...current];
  for (const nodeId of nodeIds) {
    if (existing.has(nodeId)) continue;
    existing.add(nodeId);
    next.push(nodeId);
  }
  changes[key] = next;
}

function runToToolData(run: DelegationRunState, children: readonly DelegationRunState[] = []): AgentDelegateToolData {
  const nodeChanges = compactNodeChanges(run.nodeChanges);
  const fileChanges = compactFileChanges(run.fileChanges);
  const result = latestRunSubmissionSummary(run) ?? run.result;
  return {
    status: run.status,
    agent_id: run.id,
    name: run.name,
    description: run.description,
    prompt: run.prompt,
    objective: run.objective,
    criteria: run.criteria,
    objective_status: run.objectiveStatus,
    purpose: run.purpose,
    scope: run.scope,
    budget: run.budget,
    blocked_reason: run.blockedReason,
    agent_type: run.agentType,
    context_mode: run.contextMode,
    executing_agent_id: run.executingAgentId,
    parent_agent_id: run.parentAgentId,
    memory_owner_agent_id: run.memoryOwnerAgentId,
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

function latestRunSubmissionSummary(run: Pick<DelegationRunState, 'latestSubmission'>): string | undefined {
  return run.latestSubmission?.summary.trim() || undefined;
}

function runToChildStatus(run: DelegationRunState): AgentChildRunChildStatus {
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

function derivedRunRole(run: DelegationRunState): AgentChildRunChildStatus['role'] {
  if (run.purpose === 'verify') return 'verifier';
  if (run.hasWorkChildren) return 'controller';
  return 'worker';
}

function snapshotRun(run: DelegationRunState): AgentChildRunSnapshot {
  return {
    id: run.id,
    name: run.name,
    description: run.description,
    prompt: run.prompt,
    objective: run.objective,
    criteria: run.criteria,
    objectiveStatus: run.objectiveStatus,
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

function childRunToolOutputPayloadId(run: DelegationRunState, toolCallId: string): string {
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
  return extractPartialAssistantText(messages) ?? 'Child run completed without a text result.';
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
  if (!isPlainRecord(raw)) throw new Error('Agent input must be an object.');
  const objective = coerceString(raw.objective)?.trim() || coerceString(raw.prompt)?.trim();
  if (!objective) throw new Error('spawn input requires objective.');
  const verify = raw.verify !== false;
  const criteria = coerceStringArray(raw.criteria);
  if (verify && (!criteria || criteria.length === 0)) {
    throw new Error('spawn input requires at least one criterion unless verify is false.');
  }
  const description = coerceString(raw.description)?.trim() || truncate(compactInlineText(objective), 120);
  const prompt = coerceString(raw.prompt)?.trim() || buildObjectivePrompt(objective, criteria);
  const allowedTools = Array.isArray(raw.allowedTools)
    ? normalizeAgentToolNames(raw.allowedTools) ?? []
    : undefined;
  return {
    objective,
    criteria,
    verify,
    description,
    prompt,
    purpose: normalizeRunPurpose(raw.purpose),
    scope: normalizeRunScope(raw.scope),
    budget: normalizeRunBudgetInput(raw.budget),
    context: normalizeRunContext(raw.context),
    detach: raw.detach === true,
    model: coerceString(raw.model),
    run_in_background: raw.run_in_background === true,
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

function normalizeRunScope(value: unknown): AgentRunScope | undefined {
  if (!isPlainRecord(value)) return undefined;
  const capabilities = normalizeAgentToolActionKinds(coerceStringArray(value.capabilities));
  const resources = isPlainRecord(value.resources) ? {
    docs: coerceStringArray(value.resources.docs),
    paths: coerceStringArray(value.resources.paths),
  } : undefined;
  const compactResources = resources && (resources.docs?.length || resources.paths?.length)
    ? resources
    : undefined;
  return capabilities?.length || compactResources
    ? { capabilities, resources: compactResources }
    : undefined;
}

function normalizeRunBudgetInput(value: unknown): AgentRunBudget | undefined {
  if (!isPlainRecord(value)) return undefined;
  const tokens = parsePositiveInteger(value.tokens);
  const wallClockMinutes = parsePositiveInteger(value.wallClockMinutes);
  return tokens || wallClockMinutes ? { tokens, wallClockMinutes } : undefined;
}

function normalizeRunBudget(
  next: AgentRunBudget | undefined,
  existing: AgentRunBudget | undefined,
  now: number,
): AgentRunBudget | undefined {
  // Merge field-by-field, not by spread: `normalizeRunBudgetInput` yields explicit
  // `undefined` for the field a partial amend did not touch, and `{...existing,
  // ...next}` would let that `undefined` wipe the untouched limit (e.g. amending
  // only wallClockMinutes would erase the token cap, leaking its reservation).
  const budget: AgentRunBudget = { ...existing };
  if (next?.tokens !== undefined) budget.tokens = next.tokens;
  if (next?.wallClockMinutes !== undefined) budget.wallClockMinutes = next.wallClockMinutes;
  if (!budget.tokens && !budget.wallClockMinutes && !budget.reservedTokens && !budget.spentTokens) return undefined;
  budget.startedAt ??= now;
  if (budget.wallClockMinutes) {
    budget.deadlineAt = budget.startedAt + budget.wallClockMinutes * 60_000;
  }
  return budget;
}

function admitRunBudget(
  parent: AgentRunBudget | undefined,
  requested: AgentRunBudget | undefined,
  now: number,
  detached: boolean,
): AgentRunBudget | undefined {
  const parentRemainingWallClockMinutes = parent?.deadlineAt && parent.deadlineAt > now
    ? Math.max(1, Math.ceil((parent.deadlineAt - now) / 60_000))
    : undefined;
  if (
    parentRemainingWallClockMinutes !== undefined
    && requested?.wallClockMinutes
    && requested.wallClockMinutes > parentRemainingWallClockMinutes
  ) {
    throw new Error('Run budget exceeds parent remaining wall-clock budget.');
  }
  const fallback = requested
    ?? (parentRemainingWallClockMinutes ? { wallClockMinutes: parentRemainingWallClockMinutes } : undefined)
    ?? (detached ? { wallClockMinutes: DEFAULT_CHILD_WALL_CLOCK_MINUTES } : undefined);
  const budget = normalizeRunBudget(fallback, undefined, now);
  if (!budget) return undefined;
  if (parent?.deadlineAt && budget.deadlineAt && budget.deadlineAt > parent.deadlineAt) {
    budget.deadlineAt = parent.deadlineAt;
    if (parentRemainingWallClockMinutes !== undefined) budget.wallClockMinutes = parentRemainingWallClockMinutes;
  }
  if (parent?.tokens && budget.tokens) {
    const parentHeadroom = Math.max(0, parent.tokens - (parent.reservedTokens ?? 0) - (parent.spentTokens ?? 0));
    if (budget.tokens > parentHeadroom) throw new Error('Run budget exceeds parent remaining token budget.');
    parent.reservedTokens = (parent.reservedTokens ?? 0) + budget.tokens;
  }
  return budget;
}

// Reverse admitRunBudget's parent token reservation for a run that never came to
// exist (e.g. the harness build threw), so a setup failure cannot permanently
// inflate the parent's reservedTokens.
function releaseAdmittedRunBudget(parent: AgentRunBudget | undefined, budget: AgentRunBudget | undefined): void {
  if (parent?.tokens && budget?.tokens) {
    parent.reservedTokens = Math.max(0, (parent.reservedTokens ?? 0) - budget.tokens);
  }
}

function settleRunBudget(run: DelegationRunState): void {
  if (run.budgetSettled) return;
  if (!run.parentBudgetRef || !run.budget?.tokens) return;
  const reserved = run.parentBudgetRef.reservedTokens ?? 0;
  run.parentBudgetRef.reservedTokens = Math.max(0, reserved - run.budget.tokens);
  const spent = Math.min(run.budget.tokens, runUsageTokens(run));
  run.parentBudgetRef.spentTokens = (run.parentBudgetRef.spentTokens ?? 0) + spent;
  run.budgetSettled = true;
}

function runUsageTokens(run: DelegationRunState): number {
  let total = 0;
  for (const message of run.messages) {
    if (message.role === 'assistant') total += message.usage?.totalTokens ?? 0;
  }
  return total;
}

// A verifier reads to confirm the work; its capabilities are the read-only
// subset of the controller's own scope (or all read-only kinds when the
// controller is unrestricted), so narrowing never rejects it as widening.
function verifierRunScope(inheritedScope: AgentRunScope | undefined): AgentRunScope {
  const parentCapabilities = normalizeAgentToolActionKinds(inheritedScope?.capabilities);
  const capabilities = parentCapabilities?.length
    ? parentCapabilities.filter((kind) => isReadOnlyActionKind(kind))
    : normalizeAgentToolActionKinds(readOnlyAgentToolNames());
  return { capabilities: capabilities ?? [] };
}

// The verifier's wall-clock request must fit the parent run's *remaining* time
// (its deadline has been counting down since the work started), capped at the
// default, so admission never rejects a budgeted run's verification.
function verifierBudgetForRun(run: DelegationRunState): AgentRunBudget {
  const deadlineAt = run.budget?.deadlineAt;
  const remainingMinutes = deadlineAt && deadlineAt > Date.now()
    ? Math.max(1, Math.ceil((deadlineAt - Date.now()) / 60_000))
    : undefined;
  const wallClockMinutes = Math.min(
    DEFAULT_CHILD_WALL_CLOCK_MINUTES,
    run.budget?.wallClockMinutes ?? DEFAULT_CHILD_WALL_CLOCK_MINUTES,
    remainingMinutes ?? DEFAULT_CHILD_WALL_CLOCK_MINUTES,
  );
  return { wallClockMinutes };
}

function narrowRunScope(parent: AgentRunScope | undefined, requested: AgentRunScope | undefined): AgentRunScope | undefined {
  const parentCapabilities = normalizeAgentToolActionKinds(parent?.capabilities);
  const requestedCapabilities = normalizeAgentToolActionKinds(requested?.capabilities);
  const capabilities = parentCapabilities?.length
    ? (requestedCapabilities?.length ? assertScopeSubset(requestedCapabilities, parentCapabilities, 'capabilities') : parentCapabilities)
    : requestedCapabilities;
  const resources = narrowRunResources(parent?.resources, requested?.resources);
  return capabilities?.length || resources
    ? { capabilities, resources }
    : undefined;
}

function assertScopeSubset(values: readonly string[], parentValues: readonly string[], label: string): string[] {
  const parentSet = new Set(parentValues);
  const denied = values.filter((value) => !parentSet.has(value));
  if (denied.length > 0) {
    throw new Error(`Run scope cannot widen ${label}: ${denied.join(', ')}`);
  }
  return [...new Set(values)];
}

function narrowRunResources(parent: AgentRunScope['resources'] | undefined, requested: AgentRunScope['resources'] | undefined): AgentRunScope['resources'] | undefined {
  const docs = parent?.docs?.length
    ? (requested?.docs?.length ? assertScopeSubset(requested.docs, parent.docs, 'docs') : parent.docs)
    : requested?.docs;
  const paths = parent?.paths?.length
    ? (requested?.paths?.length ? assertScopeSubset(requested.paths, parent.paths, 'paths') : parent.paths)
    : requested?.paths;
  return docs?.length || paths?.length ? { docs, paths } : undefined;
}

function scopedAllowedToolNames(allowedTools: readonly string[] | undefined, scope: AgentRunScope | undefined): string[] | undefined {
  const scopeTools = agentToolNamesForActionKindScope(scope?.capabilities, allowedTools);
  if (scope?.capabilities?.length) return scopeTools ?? [];
  return allowedTools ? [...allowedTools] : undefined;
}

function remainingBudgetMs(run: DelegationRunState): number | null {
  const deadlineAt = run.budget?.deadlineAt;
  if (!deadlineAt) return null;
  return Math.max(0, deadlineAt - Date.now());
}

function retryBudgetSlice(budget: AgentRunBudget | undefined): AgentRunBudget | undefined {
  if (!budget) return undefined;
  const next: AgentRunBudget = {};
  if (budget.tokens) next.tokens = budget.tokens;
  if (budget.wallClockMinutes) next.wallClockMinutes = budget.wallClockMinutes;
  return next.tokens || next.wallClockMinutes ? next : undefined;
}

function formatRunBudgetForPrompt(budget: AgentRunBudget | undefined): string | null {
  if (!budget) return null;
  const lines: string[] = [];
  if (budget.tokens) lines.push(`- token budget: ${budget.tokens}`);
  if (budget.wallClockMinutes) lines.push(`- wall-clock budget: ${budget.wallClockMinutes} minutes`);
  return lines.length ? lines.join('\n') : null;
}

function formatRunScopeForPrompt(scope: AgentRunScope | undefined): string | null {
  if (!scope) return null;
  const lines: string[] = [];
  if (scope.capabilities?.length) lines.push(`- capabilities: ${scope.capabilities.join(', ')}`);
  if (scope.resources?.docs?.length) lines.push(`- docs: ${scope.resources.docs.join(', ')}`);
  if (scope.resources?.paths?.length) lines.push(`- paths: ${scope.resources.paths.join(', ')}`);
  return lines.length ? lines.join('\n') : null;
}

function parseVerifierVerdict(text: string): { verdict: 'pass' | 'fail'; gap: string } {
  const trimmed = text.trim();
  const jsonMatch = /\{[\s\S]*\}/.exec(trimmed);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as unknown;
      if (isPlainRecord(parsed)) {
        const verdict = coerceString(parsed.verdict)?.trim().toLowerCase();
        const gap = coerceString(parsed.gap)?.trim() ?? '';
        if (verdict === 'pass') return { verdict: 'pass', gap };
        if (verdict === 'fail') return { verdict: 'fail', gap };
      }
    } catch {
      // Fall through to the text heuristic.
    }
  }
  if (/\bverdict\s*[:=]\s*pass\b/i.test(trimmed) || /"verdict"\s*:\s*"pass"/i.test(trimmed)) {
    return { verdict: 'pass', gap: '' };
  }
  const gap = trimmed || 'Verifier did not return a parseable pass verdict.';
  return { verdict: 'fail', gap: truncate(gap, 1_000) };
}

function verifierGapSignature(gap: string): string {
  return gap.toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim().slice(0, 240) || 'unknown-gap';
}

function sameTailCount(values: readonly string[], value: string): number {
  let count = 0;
  for (let index = values.length - 1; index >= 0 && values[index] === value; index -= 1) {
    count += 1;
  }
  return count;
}

function normalizeAmendParams(raw: unknown): { runId: string; changes: { objective?: string; criteria?: string[]; budget?: AgentRunBudget } } {
  if (!isPlainRecord(raw)) throw new Error('run_amend input must be an object.');
  const runId = coerceString(raw.runId)?.trim() || coerceString(raw.agent_id)?.trim();
  if (!runId) throw new Error('run_amend input requires runId.');
  if (!isPlainRecord(raw.changes)) throw new Error('run_amend input requires changes.');
  const objective = coerceString(raw.changes.objective)?.trim();
  const criteria = raw.changes.criteria === undefined ? undefined : coerceStringArray(raw.changes.criteria) ?? [];
  const budget = raw.changes.budget === undefined ? undefined : normalizeRunBudgetInput(raw.changes.budget);
  if (objective === undefined && criteria === undefined && budget === undefined) {
    throw new Error('run_amend changes must include objective, criteria, or budget.');
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

function normalizeRunSelector(raw: unknown): { agent_id?: string; name?: string; wait?: boolean; timeout_ms?: number } {
  if (!isPlainRecord(raw)) return {};
  return {
    agent_id: coerceString(raw.runId) ?? coerceString(raw.agent_id),
    name: coerceString(raw.name),
    wait: raw.wait === true,
    timeout_ms: parsePositiveInteger(raw.timeout_ms),
  };
}

function normalizeSendParams(raw: unknown): { agent_id?: string; name?: string; message: string } {
  if (!isPlainRecord(raw)) throw new Error('run_steer input must be an object.');
  const message = coerceString(raw.message)?.trim();
  if (!message) throw new Error('run_steer input requires message.');
  return {
    agent_id: coerceString(raw.runId) ?? coerceString(raw.agent_id),
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
  if (!body.includes(`You are operating as the agent below. Calling ${AGENT_DELEGATE_TOOL_NAME} forks`)) {
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
