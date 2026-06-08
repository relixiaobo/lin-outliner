import { Agent, type AfterToolCallResult, type AgentEvent, type AgentTool } from '@earendil-works/pi-agent-core';
import { isContextOverflow } from '@earendil-works/pi-ai';
import type { Api, AssistantMessage, ImageContent, Model, TextContent, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentMessage, AgentSubagentActionResult } from '../core/agentTypes';
import { systemReminder } from '../core/agentAttachments';
import type { AgentPayloadRef, AgentSubagentRunRecord } from '../core/agentEventLog';
import type { AgentPermissionMode, AgentReasoningLevel, AgentRuntimeSettings, AgentDefinition } from '../core/types';
import { createAgentLocalWorkspaceContext, restorePostCompactReadFiles, type AgentLocalWorkspaceContext } from './agentLocalTools';
import { AgentSkillRuntime } from './agentSkills';
import {
  createPostCompactMessage,
  createPostCompactRestoredFilesReminder,
} from './agentCompaction';
import {
  agentToolResult,
  errorEnvelope,
  successEnvelope,
  type ToolEnvelope,
} from './agentToolEnvelope';
import {
  collectAgentMessageToolResultBudgetSelections,
  createToolResultBudgetState,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  estimateAgentMessagesTokens,
  MAX_TOOL_RESULTS_PER_BATCH_CHARS,
  piToolResultTextContent,
  restoreToolResultBudgetStateFromAgentMessages,
  type ToolResultBudgetState,
} from './agentToolOutputSlimming';
import { autoCompactThreshold } from './agentRuntimeContext';
import { LIN_SUBAGENT_CORE_PROMPT } from './agentSystemPrompt';
import { isAbortError, throwIfAborted } from './agentAwaitWithAbort';
import {
  agentDefinitionAgentId,
  memoryWorkspaceIdForRoot,
  resolveSubagentMemoryOwner,
} from './agentSubagentIdentity';

export const AGENT_SUBAGENT_TOOL_NAME = 'Agent';
export const AGENT_STATUS_TOOL_NAME = 'AgentStatus';
export const AGENT_SEND_TOOL_NAME = 'AgentSend';
export const AGENT_STOP_TOOL_NAME = 'AgentStop';

const AGENT_FILE_NAME = 'AGENT.md';
const AGENT_LISTING_CONTEXT_PERCENT = 0.01;
const CHARS_PER_TOKEN = 4;
const DEFAULT_AGENT_LISTING_CHAR_BUDGET = 8_000;
const MAX_LISTING_DESCRIPTION_CHARS = 250;
const MAX_CONCURRENT_SUBAGENTS = 4;
const DEFAULT_MAX_SUBAGENT_DEPTH = 3;
const FORK_SUBAGENT_TYPE = 'fork';
const FORK_BOILERPLATE_TAG = 'lin-fork-subagent';
const FORK_PLACEHOLDER_RESULT = 'Fork started - processing in background.';
const AGENT_LISTING_STATE_MARKER = 'The following agents have already been listed to the agent in this session:';
const SUBAGENT_TOOL_RESULT_BUDGET_SKIP_TOOLS = new Set(['file_read']);
const MAX_SUBAGENT_AUTO_COMPACT_FAILURES = 3;
const SUBAGENT_POST_COMPACT_MAX_FILES_TO_RESTORE = 5;
const SUBAGENT_POST_COMPACT_MAX_CHARS_PER_FILE = 20_000;
const SUBAGENT_POST_COMPACT_TOTAL_RESTORED_FILE_CHARS = 200_000;

const AGENT_TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['description', 'prompt'],
  properties: {
    description: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'A short 3-5 word description of the task.',
    },
    prompt: {
      type: 'string',
      minLength: 1,
      description: 'The task for the agent to perform.',
    },
    subagent_type: {
      type: 'string',
      minLength: 1,
      description: 'Optional specialized agent type. If omitted, Tenon starts a fork subagent with the current conversation context.',
    },
    model: {
      type: 'string',
      minLength: 1,
      description: 'Optional model override. Takes precedence over the agent definition model. If omitted, uses the agent definition model or inherits the parent model.',
    },
    run_in_background: {
      type: 'boolean',
      description: 'Set to true to run this agent in the background. Use AgentStatus, AgentSend, or AgentStop with the returned agent_id.',
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
    agent_id: { type: 'string', minLength: 1, description: 'The agent id returned by Agent.' },
    name: { type: 'string', minLength: 1, description: 'The same-session agent name passed to Agent.' },
    wait: { type: 'boolean', description: 'If true, wait briefly for a running background agent to finish.' },
    timeout_ms: { type: 'integer', minimum: 1, maximum: 120000, description: 'Maximum wait time when wait is true. Default 30000.' },
  },
};

const AGENT_SEND_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['message'],
  properties: {
    agent_id: { type: 'string', minLength: 1, description: 'The agent id returned by Agent.' },
    name: { type: 'string', minLength: 1, description: 'The same-session agent name passed to Agent.' },
    message: { type: 'string', minLength: 1, description: 'Message to send to the existing background agent.' },
  },
};

const AGENT_STOP_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent_id: { type: 'string', minLength: 1, description: 'The agent id returned by Agent.' },
    name: { type: 'string', minLength: 1, description: 'The same-session agent name passed to Agent.' },
  },
};



export type AgentSubagentToolData = AgentSubagentActionResult;

export interface AgentSubagentCreateInput {
  sessionId: string;
  messages: AgentMessage[];
  systemPrompt: string;
  executingAgentId: string;
  parentAgentId: string;
  memoryOwnerAgentId: string;
  memoryOriginWorkspace?: string;
  model?: string;
  effort?: string;
  permissionMode?: AgentPermissionMode;
  maxTurns?: number;
  skillRuntime: AgentSkillRuntime;
  localWorkspace: AgentLocalWorkspaceContext;
  subagentRuntime: AgentSubagentRuntime;
  allowedTools?: string[];
  disallowedTools?: string[];
  preapprovedToolRules?: string[];
  afterToolResult?: (
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
  ) => Promise<AfterToolCallResult | undefined> | AfterToolCallResult | undefined;
}

export interface AgentSubagentRuntimeHost {
  createChildAgent(input: AgentSubagentCreateInput): Agent;
  getParentMessages(): AgentMessage[];
  getParentSystemPrompt(): string;
  getRuntimeSettings(): Promise<AgentRuntimeSettings>;
  buildMemoryReminder(agentId: string, query: string, originWorkspace?: string): Promise<string | null>;
  persistSubagentRun(snapshot: AgentSubagentRunSnapshot): Promise<void>;
  notifySubagentRun(snapshot: AgentSubagentRunSnapshot): Promise<void>;
  persistToolOutputPayload(
    toolCallId: string,
    toolName: string,
    text: string,
  ): Promise<{ payload: AgentPayloadRef; label: string }>;
  completeCompactSummary(
    sessionId: string,
    messages: readonly AgentMessage[],
    model: Model<Api>,
    customInstructions?: string,
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface AgentSubagentRuntimeOptions {
  sessionId: string;
  executingAgentId: string;
  memoryOwnerAgentId?: string;
  localRoot?: string;
  additionalAgentDirectories?: string[];
  includeUserAgents?: boolean;
  depth?: number;
  ancestry?: string[];
  maxDepth?: number;
  host: AgentSubagentRuntimeHost;
}

interface AgentRunRecord {
  id: string;
  name?: string;
  description: string;
  prompt: string;
  subagentType: string;
  contextMode: 'fresh' | 'fork';
  definition: AgentDefinition | null;
  executingAgentId: string;
  parentAgentId: string;
  memoryOwnerAgentId: string;
  memoryOriginWorkspace?: string;
  dreamEvidenceStartMessageIndex: number;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  depth: number;
  agent?: Agent;
  messages: AgentMessage[];
  result?: string;
  error?: string;
  completion?: Promise<void>;
  detached: boolean;
  terminalNotificationSent: boolean;
  turnCount: number;
  parentToolCallId?: string;
  preapprovedToolRules?: string[];
  toolResultBudgetState: ToolResultBudgetState;
  autoCompactConsecutiveFailures: number;
  autoCompactInProgress: boolean;
  pendingPersist?: Promise<void>;
  skillRuntime?: AgentSkillRuntime;
  localWorkspace?: AgentLocalWorkspaceContext;
  memoryReminderCache?: { key: string; text: string | null };
}

type RunningSlotReservation = () => void;

export interface AgentSubagentRunSnapshot {
  id: string;
  name?: string;
  description: string;
  prompt: string;
  subagentType: string;
  contextMode: 'fresh' | 'fork';
  executingAgentId: string;
  parentAgentId: string;
  memoryOwnerAgentId: string;
  memoryOriginWorkspace?: string;
  dreamEvidenceStartMessageIndex: number;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  transcriptMessages: AgentMessage[];
  parentToolCallId?: string;
}

export interface AgentSubagentRestoredRun {
  record: AgentSubagentRunRecord;
  transcriptMessages: AgentMessage[];
}

interface AgentToolParams {
  description: string;
  prompt: string;
  subagent_type?: string;
  model?: string;
  effort?: string;
  run_in_background?: boolean;
  name?: string;
  preapprovedToolRules?: string[];
}

export interface AgentSubagentSkillRunInput {
  skillName: string;
  description: string;
  renderedContent: string;
  agent?: string;
  model?: string;
  effort?: string;
  allowedTools?: string[];
}

export class AgentSubagentRuntime {
  private readonly registry: AgentDefinitionRegistry;
  private readonly sessionId: string;
  private readonly localRoot: string;
  private additionalAgentDirectories: string[];
  private readonly depth: number;
  private readonly maxDepth: number;
  private readonly ancestry: string[];
  private readonly executingAgentId: string;
  private readonly memoryOwnerAgentId: string;
  private readonly host: AgentSubagentRuntimeHost;
  private readonly runs = new Map<string, AgentRunRecord>();
  private readonly names = new Map<string, string>();
  private readonly listedAgents = new Map<string, string | null>();
  private reservedRunningSlots = 0;
  private disabledAgents: string[] = [];

  constructor(options: AgentSubagentRuntimeOptions) {
    this.sessionId = options.sessionId;
    this.localRoot = path.resolve(options.localRoot ?? process.cwd());
    this.additionalAgentDirectories = normalizeConfiguredDirectories(options.additionalAgentDirectories, this.localRoot);
    this.depth = options.depth ?? 0;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
    this.ancestry = options.ancestry ?? [];
    this.executingAgentId = options.executingAgentId;
    this.memoryOwnerAgentId = options.memoryOwnerAgentId ?? options.executingAgentId;
    this.host = options.host;
    this.registry = new AgentDefinitionRegistry({
      localRoot: this.localRoot,
      includeUserAgents: options.includeUserAgents ?? true,
      additionalAgentDirectories: this.additionalAgentDirectories,
    });
  }

  updateAdditionalAgentDirectories(directories: readonly string[]): void {
    const normalized = normalizeConfiguredDirectories(directories, this.localRoot);
    if (sameStringList(this.additionalAgentDirectories, normalized)) return;
    this.additionalAgentDirectories = normalized;
    this.registry.updateAdditionalAgentDirectories(normalized);
  }

  updateDisabledAgents(disabledAgents: string[]): void {
    this.disabledAgents = disabledAgents;
  }

  /** Invalidate this runtime's agent-definition cache (after an authoring write). */
  reloadAgentDefinitions(): void {
    this.registry.reload();
  }

  clearMemoryReminderCache(): void {
    for (const run of this.runs.values()) {
      run.memoryReminderCache = undefined;
    }
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
      `The following agents are available for use with the ${AGENT_SUBAGENT_TOOL_NAME} tool:`,
      '',
      listing,
      '',
      `To fork from the current conversation context, call ${AGENT_SUBAGENT_TOOL_NAME} without subagent_type.`,
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

  restorePersistedRuns(restoredRuns: readonly AgentSubagentRestoredRun[]): void {
    for (const { record, transcriptMessages } of restoredRuns) {
      if (this.runs.has(record.id)) continue;
      const executingAgentId = record.executingAgentId ?? this.executingAgentId;
      const parentAgentId = record.parentAgentId ?? this.executingAgentId;
      const memoryOwnerAgentId = resolveSubagentMemoryOwner({
        ...record,
        executingAgentId,
        parentAgentId,
      }, this.memoryOwnerAgentId);
      const memoryOriginWorkspace = record.memoryOriginWorkspace ?? memoryWorkspaceIdForRoot(this.localRoot);
      const run: AgentRunRecord = {
        id: record.id,
        name: record.name,
        description: record.description,
        prompt: record.prompt,
        subagentType: record.subagentType,
        contextMode: record.contextMode,
        definition: null,
        executingAgentId,
        parentAgentId,
        memoryOwnerAgentId,
        memoryOriginWorkspace,
        status: record.status,
        startedAt: record.startedAt,
        updatedAt: record.updatedAt,
        completedAt: record.completedAt,
        depth: this.depth + 1,
        messages: transcriptMessages.map(cloneAgentMessage),
        result: record.result,
        error: record.error,
        detached: false,
        terminalNotificationSent: true,
        turnCount: 0,
        parentToolCallId: record.parentToolCallId,
        toolResultBudgetState: restoreToolResultBudgetStateFromAgentMessages(transcriptMessages),
        autoCompactConsecutiveFailures: 0,
        autoCompactInProgress: false,
        dreamEvidenceStartMessageIndex: record.dreamEvidenceStartMessageIndex ?? (
          record.contextMode === 'fork' ? transcriptMessages.length : 0
        ),
      };
      this.runs.set(run.id, run);
      if (run.name) this.names.set(run.name, run.id);
    }
  }

  async invokeAgent(rawParams: unknown, signal?: AbortSignal, parentToolCallId?: string): Promise<AgentSubagentToolData> {
    const params = normalizeAgentToolParams(rawParams);
    const releaseStartupSlot = this.reserveRunningSlot();
    try {
      return await this.startAgent(params, releaseStartupSlot, signal, parentToolCallId);
    } catch (error) {
      releaseStartupSlot();
      throw error;
    }
  }

  async invokeSkillSubagent(
    input: AgentSubagentSkillRunInput,
    signal?: AbortSignal,
    parentToolCallId?: string,
  ): Promise<AgentSubagentToolData> {
    const releaseStartupSlot = this.reserveRunningSlot();
    try {
      return await this.startAgent({
        description: compactInlineText(input.description) || `skill ${input.skillName}`,
        prompt: input.renderedContent,
        subagent_type: await this.resolveSkillSubagentType(input.agent),
        model: input.model,
        effort: input.effort,
        run_in_background: false,
        preapprovedToolRules: input.allowedTools,
      }, releaseStartupSlot, signal, parentToolCallId);
    } catch (error) {
      releaseStartupSlot();
      throw error;
    }
  }

  async status(rawParams: unknown): Promise<AgentSubagentToolData> {
    const params = normalizeRunSelector(rawParams);
    const run = this.resolveRun(params);
    if (params.wait && run.status === 'running') {
      await waitWithTimeout(run.completion ?? Promise.resolve(), params.timeout_ms ?? 30000);
    }
    return runToToolData(run);
  }

  async send(rawParams: unknown): Promise<AgentSubagentToolData> {
    const params = normalizeSendParams(rawParams);
    const run = this.resolveRun(params);
    const message = createUserMessage(params.message);
    if (run.status === 'running') {
      if (!run.agent) throw new Error(`Agent ${run.id} is not live in this process. Start a continuation instead.`);
      run.agent.followUp(message);
      run.updatedAt = Date.now();
      await this.queuePersistRunUpdate(run);
      return { ...runToToolData(run), status: 'queued', instructions: 'Message queued for the running background agent.' };
    }

    const releaseStartupSlot = this.reserveRunningSlot();
    try {
      const wasStopped = run.status === 'stopped';
      run.status = 'running';
      run.error = undefined;
      run.completedAt = undefined;
      run.detached = true;
      run.terminalNotificationSent = false;
      if (wasStopped) run.agent = undefined;
      run.updatedAt = Date.now();
      await this.ensureLiveAgent(run);
      await this.queuePersistRunUpdate(run);
      releaseStartupSlot();
      run.completion = this.runChildAgent(run, [message], undefined, true);
      return { ...runToToolData(run), status: 'queued', instructions: 'Agent continuation started in the background.' };
    } catch (error) {
      releaseStartupSlot();
      throw error;
    }
  }

  async stop(rawParams: unknown): Promise<AgentSubagentToolData> {
    const params = normalizeRunSelector(rawParams);
    const run = this.resolveRun(params);
    if (run.status === 'running') {
      run.status = 'stopped';
      run.completedAt = Date.now();
      run.updatedAt = run.completedAt;
      run.agent?.abort();
      run.agent = undefined;
      await this.queuePersistRunUpdate(run);
      if (run.detached) void this.notifyTerminalRun(run).catch(() => undefined);
    }
    return runToToolData(run);
  }

  private async startAgent(
    params: AgentToolParams,
    releaseStartupSlot: RunningSlotReservation,
    signal?: AbortSignal,
    parentToolCallId?: string,
  ): Promise<AgentSubagentToolData> {
    const contextMode = params.subagent_type ? 'fresh' : 'fork';
    const definition = contextMode === 'fork'
      ? createForkAgentDefinition()
      : await this.resolveFreshAgent(params.subagent_type);

    if (contextMode !== 'fork' && this.disabledAgents.includes(agentDefinitionAgentId(definition))) {
      throw new Error(`Agent '${definition.name}' is currently disabled in settings.`);
    }

    if (contextMode === 'fork') this.assertCanFork();
    this.assertCanDescend(definition.name);
    const name = params.name?.trim();
    if (name && this.names.has(name)) throw new Error(`Agent name is already in use in this session: ${name}`);

    const runId = `subagent-${randomUUID()}`;
    const subagentSessionId = `${this.hostSessionPrefix()}-${runId}`;
    const parentAgentId = this.executingAgentId;
    const executingAgentId = contextMode === 'fork'
      ? this.executingAgentId
      : agentDefinitionAgentId(definition);
    const memoryOwnerAgentId = contextMode === 'fork'
      ? this.memoryOwnerAgentId
      : executingAgentId;
    const memoryOriginWorkspace = memoryWorkspaceIdForRoot(this.localRoot);
    let childRuntime: AgentSubagentRuntime;
    const runtimeSettings = await this.host.getRuntimeSettings();
    const skillRuntime = new AgentSkillRuntime({
      localRoot: this.localRoot,
      additionalSkillDirectories: runtimeSettings.additionalSkillDirectories,
      sessionId: subagentSessionId,
      executeForkedSkill: async ({ skill, renderedContent, parentToolCallId }) => {
        const data = await childRuntime.invokeSkillSubagent({
          skillName: skill.name,
          description: skill.description,
          renderedContent,
          agent: skill.agent,
          model: skill.model,
          effort: skill.effort,
          allowedTools: skill.allowedTools,
        }, undefined, parentToolCallId);
        return {
          agentId: data.agent_id,
          subagentType: data.subagent_type,
          status: data.status,
          result: data.result,
          error: data.error,
        };
      },
    });
    skillRuntime.updateDisabledSkills(runtimeSettings.disabledSkills ?? []);

    const localWorkspace = createAgentLocalWorkspaceContext(this.localRoot, skillRuntime);
    let childAgent: Agent | null = null;
    let run: AgentRunRecord | null = null;
    childRuntime = new AgentSubagentRuntime({
      sessionId: subagentSessionId,
      executingAgentId,
      memoryOwnerAgentId,
      localRoot: this.localRoot,
      additionalAgentDirectories: this.additionalAgentDirectories,
      depth: this.depth + 1,
      maxDepth: this.maxDepth,
      ancestry: [...this.ancestry, definition.name],
      host: {
        createChildAgent: (input) => this.host.createChildAgent(input),
        getParentMessages: () => childAgent?.state.messages as AgentMessage[] ?? [],
        getParentSystemPrompt: () => childAgent?.state.systemPrompt ?? this.host.getParentSystemPrompt(),
        getRuntimeSettings: () => this.host.getRuntimeSettings(),
        buildMemoryReminder: (agentId, query, originWorkspace) => this.host.buildMemoryReminder(agentId, query, originWorkspace),
        persistSubagentRun: (snapshot) => this.host.persistSubagentRun(snapshot),
        notifySubagentRun: (snapshot) => this.host.notifySubagentRun(snapshot),
        persistToolOutputPayload: (toolCallId, toolName, text) => (
          this.host.persistToolOutputPayload(toolCallId, toolName, text)
        ),
        completeCompactSummary: (sessionId, messages, model, customInstructions, signal) => (
          this.host.completeCompactSummary(sessionId, messages, model, customInstructions, signal)
        ),
      },
    });
    childRuntime.updateDisabledAgents(runtimeSettings.disabledAgents ?? []);
    const preloadMessages = await this.preloadAgentSkills(definition, skillRuntime);
    const promptMessages = contextMode === 'fork'
      ? buildForkSubagentMessages(this.host.getParentMessages(), params.prompt)
      : [...preloadMessages, createUserMessage(params.prompt)];
    const dreamEvidenceStartMessageIndex = contextMode === 'fork'
      ? Math.max(0, promptMessages.length - 1)
      : 0;
    const systemPrompt = contextMode === 'fork'
      ? this.host.getParentSystemPrompt()
      : buildFreshAgentSystemPrompt(definition);
    childAgent = this.host.createChildAgent({
      sessionId: subagentSessionId,
      messages: [],
      systemPrompt,
      executingAgentId,
      parentAgentId,
      memoryOwnerAgentId,
      memoryOriginWorkspace,
      model: params.model ?? definition.model,
      effort: params.effort ?? definition.effort,
      permissionMode: definition.permissionMode,
      maxTurns: definition.maxTurns,
      skillRuntime,
      localWorkspace,
      subagentRuntime: childRuntime,
      allowedTools: definition.tools,
      disallowedTools: definition.disallowedTools,
      preapprovedToolRules: params.preapprovedToolRules,
      afterToolResult: (toolCallId, toolName, result, isError) => (
        run ? this.afterRunToolResult(run, toolCallId, toolName, result, isError) : undefined
      ),
    });

    const background = params.run_in_background === true || definition.background === true;
    const now = Date.now();
    run = {
      id: runId,
      name,
      description: params.description,
      prompt: params.prompt,
      subagentType: definition.name,
      contextMode,
      definition,
      executingAgentId,
      parentAgentId,
      memoryOwnerAgentId,
      memoryOriginWorkspace,
      dreamEvidenceStartMessageIndex,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      depth: this.depth + 1,
      agent: childAgent,
      messages: [...promptMessages],
      completion: Promise.resolve(),
      detached: background,
      terminalNotificationSent: false,
      turnCount: 0,
      parentToolCallId,
      preapprovedToolRules: params.preapprovedToolRules,
      toolResultBudgetState: createToolResultBudgetState(),
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
    await this.persistRunStarted(run);

    run.completion = this.runChildAgent(run, promptMessages, background ? undefined : signal, background);
    if (background) {
      return {
        ...runToToolData(run),
        status: 'async_launched',
        instructions: `The agent is running in the background. Tenon will notify you automatically when it finishes. Use ${AGENT_STATUS_TOOL_NAME} with agent_id "${run.id}" only when you need an explicit progress check, ${AGENT_SEND_TOOL_NAME} to continue it, or ${AGENT_STOP_TOOL_NAME} to stop it.`,
      };
    }

    await run.completion;
    return runToToolData(run);
  }

  private async resolveFreshAgent(subagentType: string | undefined): Promise<AgentDefinition> {
    const normalized = normalizeAgentName(subagentType ?? '');
    if (!normalized) throw new Error('subagent_type is required for a fresh subagent. Omit subagent_type only when you want to fork the current context.');
    const definition = await this.registry.resolve(normalized);
    if (!definition) {
      const names = (await this.registry.listAgents()).map((agent) => agent.name).join(', ');
      throw new Error(`Agent type '${normalized}' not found. Available agents: ${names || 'none'}`);
    }
    return definition;
  }

  private async preloadAgentSkills(definition: AgentDefinition, skillRuntime: AgentSkillRuntime): Promise<UserMessage[]> {
    const messages: UserMessage[] = [];
    for (const skill of definition.skills ?? []) {
      const invocation = await skillRuntime.invokeSkill({ skill, trigger: 'agent' });
      if (invocation.ok) messages.push(invocation.message);
    }
    return messages;
  }

  private subscribeToChild(run: AgentRunRecord): void {
    if (!run.agent) return;
    const subscribedAgent = run.agent;
    subscribedAgent.subscribe((event: AgentEvent) => {
      if (run.agent !== subscribedAgent) return;
      if (event.type === 'turn_end') {
        run.turnCount += 1;
        run.updatedAt = Date.now();
        if (run.definition?.maxTurns && run.turnCount >= run.definition.maxTurns && run.agent?.state.isStreaming) {
          run.agent.abort();
        }
        return;
      }
      if (event.type === 'message_end') {
        if (isRecordableAgentMessage(event.message)) {
          run.messages.push(cloneAgentMessage(event.message));
          run.updatedAt = Date.now();
          void this.queuePersistRunUpdate(run).catch(() => undefined);
        }
      }
    });
  }

  private async runChildAgent(
    run: AgentRunRecord,
    messages: AgentMessage[],
    signal: AbortSignal | undefined,
    detached: boolean,
  ): Promise<void> {
    if (!run.agent) throw new Error(`Agent ${run.id} is not live in this process.`);
    const agent = run.agent;
    const abort = () => agent.abort();
    if (signal && !detached) {
      if (signal.aborted) abort();
      signal.addEventListener('abort', abort, { once: true });
    }
    try {
      await agent.prompt(messages);
      if (run.agent !== agent) return;
      const terminalAssistant = lastAssistantMessage(agent.state.messages as AgentMessage[]);
      if (terminalAssistant && isContextOverflow(terminalAssistant, agent.state.model.contextWindow)) {
        const compacted = await this.compactRunMessages(run, agent.state.messages as AgentMessage[], 'reactive', signal);
        if (compacted) {
          await agent.continue();
          if (run.agent !== agent) return;
        }
      }
      if (run.status !== 'stopped') {
        const errorMessage = agent.state.errorMessage;
        if (errorMessage) {
          run.status = 'failed';
          run.error = errorMessage;
        } else {
          run.status = 'completed';
          run.result = extractFinalAssistantText(agent.state.messages as AgentMessage[]);
        }
        run.completedAt = Date.now();
        run.updatedAt = run.completedAt;
      }
    } catch (error) {
      if (run.agent !== agent) return;
      if (run.status !== 'stopped') {
        run.status = 'failed';
        run.error = error instanceof Error ? error.message : String(error);
        run.completedAt = Date.now();
        run.updatedAt = run.completedAt;
      }
    } finally {
      if (signal && !detached) signal.removeEventListener('abort', abort);
      if (run.agent === agent) {
        await this.queuePersistRunUpdate(run).catch(() => undefined);
        if (detached) void this.notifyTerminalRun(run).catch(() => undefined);
      }
    }
  }

  private async notifyTerminalRun(run: AgentRunRecord): Promise<void> {
    if (run.status === 'running') return;
    if (run.terminalNotificationSent) return;
    run.terminalNotificationSent = true;
    await this.host.notifySubagentRun(snapshotRun(run));
  }

  private installRunContextTransform(run: AgentRunRecord): void {
    if (!run.agent) return;
    run.agent.transformContext = async (_messages, signal) => this.prepareRunModelContext(run, signal);
  }

  private async afterRunToolResult(
    run: AgentRunRecord,
    toolCallId: string,
    toolName: string,
    result: unknown,
    _isError: boolean,
  ): Promise<AfterToolCallResult | undefined> {
    if (!isPlainRecord(result) || !Array.isArray(result.content)) return undefined;
    const text = piToolResultTextContent(result.content as Array<TextContent | ImageContent>);
    if (!text || text.length <= DEFAULT_MAX_TOOL_RESULT_CHARS) return undefined;

    try {
      const persisted = await this.host.persistToolOutputPayload(subagentToolOutputPayloadId(run, toolCallId), toolName, text);
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

  private async prepareRunModelContext(run: AgentRunRecord, signal?: AbortSignal): Promise<AgentMessage[]> {
    throwIfAborted(signal);
    const source = ((run.agent?.state.messages as unknown[]) ?? run.messages)
      .filter(isRecordableAgentMessage)
      .map(cloneAgentMessage);
    const memoryReminder = await this.runMemoryReminder(run, latestUserQuery(source) ?? run.prompt);
    throwIfAborted(signal);
    const selection = collectAgentMessageToolResultBudgetSelections(source, run.toolResultBudgetState, {
      limit: MAX_TOOL_RESULTS_PER_BATCH_CHARS,
      skipToolNames: SUBAGENT_TOOL_RESULT_BUDGET_SKIP_TOOLS,
    });
    if (selection.toPersist.length === 0 && selection.alreadyReplaced.length === 0) {
      return withMemoryReminder(await this.autoCompactRunIfNeeded(run, source, signal) ?? source, memoryReminder);
    }

    const nextMessages = source.map(cloneAgentMessage);
    let changed = false;

    for (const candidate of selection.alreadyReplaced) {
      const message = nextMessages[candidate.messageIndex];
      if (!message || message.role !== 'toolResult') continue;
      if (toolResultText(message) === candidate.replacement) continue;
      replaceToolResultText(message, candidate.replacement);
      changed = true;
    }

    for (const candidate of selection.toPersist) {
      throwIfAborted(signal);
      const message = nextMessages[candidate.messageIndex];
      if (!message || message.role !== 'toolResult') continue;
      try {
        const persisted = await this.host.persistToolOutputPayload(
          subagentToolOutputPayloadId(run, candidate.toolCallId),
          candidate.toolName,
          candidate.contentText,
        );
        replaceToolResultText(message, persisted.label);
        run.toolResultBudgetState.seenIds.add(candidate.toolCallId);
        run.toolResultBudgetState.replacements.set(candidate.toolCallId, persisted.label);
        changed = true;
      } catch {
        run.toolResultBudgetState.seenIds.add(candidate.toolCallId);
      }
    }

    throwIfAborted(signal);
    if (!changed) return withMemoryReminder(await this.autoCompactRunIfNeeded(run, source, signal) ?? source, memoryReminder);
    run.messages = nextMessages.map(cloneAgentMessage);
    if (run.agent) run.agent.state.messages = nextMessages as never;
    run.updatedAt = Date.now();
    await this.queuePersistRunUpdate(run).catch(() => undefined);
    return withMemoryReminder(await this.autoCompactRunIfNeeded(run, nextMessages, signal) ?? nextMessages, memoryReminder);
  }

  private async runMemoryReminder(run: AgentRunRecord, query: string): Promise<string | null> {
    const key = JSON.stringify([run.memoryOwnerAgentId, run.memoryOriginWorkspace ?? null, query]);
    if (run.memoryReminderCache?.key === key) return run.memoryReminderCache.text;
    const text = await this.host.buildMemoryReminder(run.memoryOwnerAgentId, query, run.memoryOriginWorkspace);
    run.memoryReminderCache = { key, text };
    return text;
  }

  private async autoCompactRunIfNeeded(run: AgentRunRecord, messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[] | null> {
    throwIfAborted(signal);
    if (run.autoCompactInProgress) return null;
    if (run.autoCompactConsecutiveFailures >= MAX_SUBAGENT_AUTO_COMPACT_FAILURES) return null;
    if (messages.length < 2) return null;
    const settings = await this.host.getRuntimeSettings();
    throwIfAborted(signal);
    if (!settings.compactEnabled) return null;
    const model = run.agent?.state.model as Model<Api> | undefined;
    if (!model) return null;
    const threshold = autoCompactThreshold(model);
    if (!Number.isFinite(threshold) || threshold <= 0) return null;
    const systemPrompt = run.agent?.state.systemPrompt ?? '';
    if (estimateAgentMessagesTokens(messages, systemPrompt) < threshold) return null;
    return this.compactRunMessages(run, messages, 'auto', signal);
  }

  private async compactRunMessages(
    run: AgentRunRecord,
    messages: AgentMessage[],
    trigger: 'auto' | 'reactive',
    signal?: AbortSignal,
  ): Promise<AgentMessage[] | null> {
    throwIfAborted(signal);
    if (run.autoCompactInProgress) return null;
    if (run.autoCompactConsecutiveFailures >= MAX_SUBAGENT_AUTO_COMPACT_FAILURES) return null;
    if (messages.length < 2) return null;
    const settings = await this.host.getRuntimeSettings();
    if (!settings.compactEnabled) return null;
    const model = run.agent?.state.model as Model<Api> | undefined;
    if (!model) return null;

    run.autoCompactInProgress = true;
    try {
      run.skillRuntime?.restoreInvokedSkillsFromMessages(messages);
      const summary = await this.host.completeCompactSummary(
        `${this.sessionId}-${run.id}-${trigger}-compact`,
        messages,
        model,
        run.contextMode === 'fork'
          ? 'This is a fork subagent transcript. Omit copied parent conversation context that only predates the fork assignment; preserve the fork assignment, subagent actions, user follow-ups, and final result.'
          : undefined,
        signal,
      );
      throwIfAborted(signal);
      const restoredFiles = run.localWorkspace
        ? await restorePostCompactReadFiles(run.localWorkspace, {
            maxFiles: SUBAGENT_POST_COMPACT_MAX_FILES_TO_RESTORE,
            maxCharsPerFile: SUBAGENT_POST_COMPACT_MAX_CHARS_PER_FILE,
            maxTotalChars: SUBAGENT_POST_COMPACT_TOTAL_RESTORED_FILE_CHARS,
            preservedFilePaths: new Set<string>(),
          })
        : [];
      const compactedMessages = [
        createPostCompactMessage(
          summary,
          run.skillRuntime?.createInvokedSkillsReminder() ?? null,
          run.skillRuntime?.createSkillListingStateReminder() ?? null,
          null,
          createPostCompactRestoredFilesReminder(restoredFiles),
        ),
      ];
      run.messages = compactedMessages.map(cloneAgentMessage);
      run.dreamEvidenceStartMessageIndex = 0;
      if (run.agent) run.agent.state.messages = compactedMessages as never;
      run.toolResultBudgetState = restoreToolResultBudgetStateFromAgentMessages(compactedMessages);
      run.autoCompactConsecutiveFailures = 0;
      run.updatedAt = Date.now();
      await this.queuePersistRunUpdate(run).catch(() => undefined);
      return compactedMessages;
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      run.autoCompactConsecutiveFailures += 1;
      return null;
    } finally {
      run.autoCompactInProgress = false;
    }
  }

  private async ensureLiveAgent(run: AgentRunRecord): Promise<void> {
    if (run.agent) return;
    const definition = await this.resolveDefinitionForRun(run);
    let childRuntime: AgentSubagentRuntime;
    const skillRuntime = new AgentSkillRuntime({
      localRoot: this.localRoot,
      additionalSkillDirectories: (await this.host.getRuntimeSettings()).additionalSkillDirectories,
      sessionId: `${this.hostSessionPrefix()}-${run.id}`,
      executeForkedSkill: async ({ skill, renderedContent, parentToolCallId }) => {
        const data = await childRuntime.invokeSkillSubagent({
          skillName: skill.name,
          description: skill.description,
          renderedContent,
          agent: skill.agent,
          model: skill.model,
          effort: skill.effort,
          allowedTools: skill.allowedTools,
        }, undefined, parentToolCallId);
        return {
          agentId: data.agent_id,
          subagentType: data.subagent_type,
          status: data.status,
          result: data.result,
          error: data.error,
        };
      },
    });
    const localWorkspace = createAgentLocalWorkspaceContext(this.localRoot, skillRuntime);
    let childAgent: Agent | null = null;
    childRuntime = new AgentSubagentRuntime({
      sessionId: `${this.hostSessionPrefix()}-${run.id}`,
      executingAgentId: run.executingAgentId,
      memoryOwnerAgentId: run.memoryOwnerAgentId,
      localRoot: this.localRoot,
      additionalAgentDirectories: this.additionalAgentDirectories,
      depth: this.depth + 1,
      maxDepth: this.maxDepth,
      ancestry: [...this.ancestry, definition.name],
      host: {
        createChildAgent: (input) => this.host.createChildAgent(input),
        getParentMessages: () => childAgent?.state.messages as AgentMessage[] ?? [],
        getParentSystemPrompt: () => childAgent?.state.systemPrompt ?? this.host.getParentSystemPrompt(),
        getRuntimeSettings: () => this.host.getRuntimeSettings(),
        buildMemoryReminder: (agentId, query, originWorkspace) => this.host.buildMemoryReminder(agentId, query, originWorkspace),
        persistSubagentRun: (snapshot) => this.host.persistSubagentRun(snapshot),
        notifySubagentRun: (snapshot) => this.host.notifySubagentRun(snapshot),
        persistToolOutputPayload: (toolCallId, toolName, text) => (
          this.host.persistToolOutputPayload(toolCallId, toolName, text)
        ),
        completeCompactSummary: (sessionId, messages, model, customInstructions, signal) => (
          this.host.completeCompactSummary(sessionId, messages, model, customInstructions, signal)
        ),
      },
    });
    const systemPrompt = run.contextMode === 'fork'
      ? this.host.getParentSystemPrompt()
      : buildFreshAgentSystemPrompt(definition);
    childAgent = this.host.createChildAgent({
      sessionId: `${this.hostSessionPrefix()}-${run.id}`,
      messages: run.messages.map(cloneAgentMessage),
      systemPrompt,
      executingAgentId: run.executingAgentId,
      parentAgentId: run.parentAgentId,
      memoryOwnerAgentId: run.memoryOwnerAgentId,
      memoryOriginWorkspace: run.memoryOriginWorkspace,
      model: definition.model,
      effort: definition.effort,
      permissionMode: definition.permissionMode,
      maxTurns: definition.maxTurns,
      skillRuntime,
      localWorkspace,
      subagentRuntime: childRuntime,
      allowedTools: definition.tools,
      disallowedTools: definition.disallowedTools,
      preapprovedToolRules: run.preapprovedToolRules,
      afterToolResult: (toolCallId, toolName, result, isError) => (
        this.afterRunToolResult(run, toolCallId, toolName, result, isError)
      ),
    });
    run.definition = definition;
    run.agent = childAgent;
    run.skillRuntime = skillRuntime;
    run.localWorkspace = localWorkspace;
    this.subscribeToChild(run);
    this.installRunContextTransform(run);
  }

  private async resolveDefinitionForRun(run: AgentRunRecord): Promise<AgentDefinition> {
    if (run.definition) return run.definition;
    if (run.contextMode === 'fork') return createForkAgentDefinition();
    const definition = await this.registry.resolve(run.subagentType);
    if (definition) return definition;
    return {
      ...createGeneralAgentDefinition(),
      name: run.subagentType,
      description: `${run.subagentType} agent definition was not found; continuing with general subagent behavior.`,
    };
  }

  private async resolveSkillSubagentType(agentName: string | undefined): Promise<string> {
    const normalized = normalizeAgentName(agentName ?? '');
    if (!normalized) return 'general';
    const definition = await this.registry.resolve(normalized);
    if (definition) return definition.name;
    const names = (await this.registry.listAgents()).map((agent) => agent.name).join(', ');
    throw new Error(`Agent type '${normalized}' not found. Available agents: ${names || 'none'}`);
  }

  private persistRunStarted(run: AgentRunRecord): Promise<void> {
    return this.host.persistSubagentRun(snapshotRun(run));
  }

  private persistRunUpdate(run: AgentRunRecord): Promise<void> {
    return this.host.persistSubagentRun(snapshotRun(run));
  }

  private queuePersistRunUpdate(run: AgentRunRecord): Promise<void> {
    const previous = run.pendingPersist?.catch(() => undefined) ?? Promise.resolve();
    const next = previous.then(() => this.persistRunUpdate(run));
    run.pendingPersist = next.then(() => undefined, () => undefined);
    return next;
  }

  private reserveRunningSlot(): RunningSlotReservation {
    if (this.runningCount() + this.reservedRunningSlots >= MAX_CONCURRENT_SUBAGENTS) {
      throw new Error(`Too many subagents are already running in this session. Limit: ${MAX_CONCURRENT_SUBAGENTS}.`);
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

  private resolveRun(selector: { agent_id?: string; name?: string }): AgentRunRecord {
    const id = selector.agent_id || (selector.name ? this.names.get(selector.name) : undefined);
    if (!id) throw new Error('Provide agent_id or name.');
    const run = this.runs.get(id);
    if (!run) throw new Error(`Unknown agent: ${id}`);
    return run;
  }

  private assertCanDescend(nextAgentName: string): void {
    if (this.depth >= this.maxDepth) {
      throw new Error(`Subagent nesting limit reached (${this.maxDepth}). Complete the task directly.`);
    }
    if (this.ancestry.includes(nextAgentName)) {
      throw new Error(`Recursive subagent cycle detected for '${nextAgentName}'. Complete the task directly.`);
    }
  }

  private assertCanFork(): void {
    if (this.ancestry.includes(FORK_SUBAGENT_TYPE) || parentMessagesContainForkTag(this.host.getParentMessages())) {
      throw new Error('Fork is not available inside a forked agent. Complete the task directly.');
    }
  }

  private hostSessionPrefix(): string {
    return this.sessionId;
  }
}

export function createAgentSubagentTools(runtime: AgentSubagentRuntime): AgentTool<any, ToolEnvelope<AgentSubagentToolData>>[] {
  return [
    {
      name: AGENT_SUBAGENT_TOOL_NAME,
      label: 'Agent',
      description: [
        'Start a focused subagent for isolated task execution.',
        'Use subagent_type for a fresh specialized agent from the available agent listing.',
        'Omit subagent_type to fork the current conversation context into an isolated worker.',
        'Launch multiple agents in the same turn when independent work can run in parallel.',
        'For long work, set run_in_background and use AgentStatus, AgentSend, or AgentStop with the returned agent_id.',
      ].join('\n'),
      parameters: AGENT_TOOL_PARAMETERS,
      executionMode: 'parallel',
      execute: async (toolCallId, rawParams, signal) => {
        try {
          return subagentToolResult(AGENT_SUBAGENT_TOOL_NAME, await runtime.invokeAgent(rawParams, signal, toolCallId));
        } catch (error) {
          return agentToolResult(errorEnvelope(AGENT_SUBAGENT_TOOL_NAME, 'agent_failed', errorMessage(error)));
        }
      },
    },
    {
      name: AGENT_STATUS_TOOL_NAME,
      label: 'Agent Status',
      description: 'Check a same-session background subagent by agent_id or name.',
      parameters: AGENT_STATUS_PARAMETERS,
      executionMode: 'parallel',
      execute: async (_toolCallId, rawParams) => {
        try {
          return subagentToolResult(AGENT_STATUS_TOOL_NAME, await runtime.status(rawParams));
        } catch (error) {
          return agentToolResult(errorEnvelope(AGENT_STATUS_TOOL_NAME, 'agent_status_failed', errorMessage(error)));
        }
      },
    },
    {
      name: AGENT_SEND_TOOL_NAME,
      label: 'Agent Send',
      description: 'Send a follow-up message to an existing same-session background subagent.',
      parameters: AGENT_SEND_PARAMETERS,
      executionMode: 'parallel',
      execute: async (_toolCallId, rawParams) => {
        try {
          return subagentToolResult(AGENT_SEND_TOOL_NAME, await runtime.send(rawParams));
        } catch (error) {
          return agentToolResult(errorEnvelope(AGENT_SEND_TOOL_NAME, 'agent_send_failed', errorMessage(error)));
        }
      },
    },
    {
      name: AGENT_STOP_TOOL_NAME,
      label: 'Agent Stop',
      description: 'Stop a running same-session background subagent.',
      parameters: AGENT_STOP_PARAMETERS,
      executionMode: 'parallel',
      execute: async (_toolCallId, rawParams) => {
        try {
          return subagentToolResult(AGENT_STOP_TOOL_NAME, await runtime.stop(rawParams));
        } catch (error) {
          return agentToolResult(errorEnvelope(AGENT_STOP_TOOL_NAME, 'agent_stop_failed', errorMessage(error)));
        }
      },
    },
  ];
}

export function buildForkSubagentMessages(parentMessages: readonly AgentMessage[], directive: string): AgentMessage[] {
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
  messages.push(createHiddenUserMessage(buildForkDirective(directive)));
  return messages;
}

export function normalizeAgentToolNames(rules: readonly string[] | undefined): string[] | undefined {
  if (!rules) return undefined;
  const names = rules
    .map((rule) => normalizeToolRuleName(rule))
    .filter((name): name is string => Boolean(name));
  return names.includes('*') ? ['*'] : [...new Set(names)];
}

class AgentDefinitionRegistry {
  private readonly localRoot: string;
  private readonly includeUserAgents: boolean;
  private additionalAgentDirectories: string[];
  private loaded = false;
  private readonly agents = new Map<string, AgentDefinition>();
  private readonly seenAgentFileIds = new Set<string>();

  constructor(options: { localRoot: string; includeUserAgents: boolean; additionalAgentDirectories: readonly string[] }) {
    this.localRoot = path.resolve(options.localRoot);
    this.includeUserAgents = options.includeUserAgents;
    this.additionalAgentDirectories = normalizeConfiguredDirectories(options.additionalAgentDirectories, this.localRoot);
  }

  updateAdditionalAgentDirectories(directories: readonly string[]): void {
    const normalized = normalizeConfiguredDirectories(directories, this.localRoot);
    if (sameStringList(this.additionalAgentDirectories, normalized)) return;
    this.additionalAgentDirectories = normalized;
    this.reload();
  }

  /**
   * Drop the startup-cached scan so the next read re-scans the agents dirs. Used
   * after an authoring write so a new/edited/deleted agent is live without an app
   * restart. A run already resolved its definition at spawn, so live runs are
   * unaffected — only future spawns see the change.
   */
  reload(): void {
    this.loaded = false;
    this.agents.clear();
    this.seenAgentFileIds.clear();
  }

  async listAgents(): Promise<AgentDefinition[]> {
    await this.ensureLoaded();
    return [...this.agents.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  listKnownNames(): string[] {
    return [...this.agents.keys()].sort();
  }

  async resolve(name: string): Promise<AgentDefinition | null> {
    await this.ensureLoaded();
    const normalized = normalizeAgentName(name);
    const lookupName = normalized === 'general-purpose' ? 'general' : normalized;
    return this.agents.get(lookupName)
      ?? [...this.agents.values()].find((agent) => agent.displayName === normalized)
      ?? null;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    this.agents.clear();
    this.seenAgentFileIds.clear();
    await this.addLoadedAgent(createGeneralAgentDefinition());
    for (const { dir, source } of agentSearchDirs(this.localRoot, this.includeUserAgents, this.additionalAgentDirectories)) {
      for (const agent of await loadAgentsFromDir(dir, source)) {
        await this.addLoadedAgent(agent);
      }
    }
  }

  private async addLoadedAgent(agent: AgentDefinition): Promise<void> {
    const fileId = await agentFileIdentity(agent.agentFile);
    if (this.seenAgentFileIds.has(fileId)) return;
    this.seenAgentFileIds.add(fileId);
    this.agents.set(agent.name, agent);
  }
}

function createGeneralAgentDefinition(): AgentDefinition {
  // `general` is the zero-persona default: it adds no body of its own, so a fresh
  // `general` run is simply the base Tenon agent in headless/subagent mode (the
  // identity + directive + shared core that `buildFreshAgentSystemPrompt` supplies
  // to every fresh subagent). A user agent specializes by adding a persona body.
  return {
    name: 'general',
    source: 'built-in',
    rootDir: 'built-in',
    agentFile: 'built-in/general',
    description: 'General-purpose focused subagent for research, analysis, and execution.',
    body: '',
  };
}

function createForkAgentDefinition(): AgentDefinition {
  return {
    name: FORK_SUBAGENT_TYPE,
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

function agentSearchDirs(
  root: string,
  includeUserAgents: boolean,
  additionalAgentDirectories: readonly string[] = [],
): Array<{ dir: string; source: AgentDefinition['source'] }> {
  const dirs: Array<{ dir: string; source: AgentDefinition['source'] }> = [
    ...(includeUserAgents ? [{ dir: path.join(homedir(), '.agents', 'agents'), source: 'user' as const }] : []),
    { dir: path.join(root, '.agents', 'agents'), source: 'project' },
    ...additionalAgentDirectories.map((dir): { dir: string; source: AgentDefinition['source'] } => ({
      dir,
      source: isPathInside(dir, root) ? 'project' : 'user',
    })),
  ];
  const seen = new Set<string>();
  return dirs.filter((entry) => {
    const normalized = path.resolve(entry.dir);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

async function loadAgentsFromDir(agentsDir: string, source: AgentDefinition['source']): Promise<AgentDefinition[]> {
  let entries;
  try {
    entries = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const rootDir = path.join(agentsDir, entry.name);
    const agentFile = path.join(rootDir, AGENT_FILE_NAME);
    let raw: string;
    try {
      raw = await readFile(agentFile, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseAgentMarkdown(raw);
    agents.push(createAgentDefinition({
      name: entry.name,
      rootDir,
      agentFile,
      source,
      body: parsed.body,
      frontmatter: parsed.frontmatter,
    }));
  }
  return agents;
}

export function createAgentDefinition(input: {
  name: string;
  rootDir: string;
  agentFile: string;
  source: AgentDefinition['source'];
  body: string;
  frontmatter: Record<string, unknown>;
}): AgentDefinition {
  const description = compactInlineText(
    coerceString(input.frontmatter.description)
      ?? extractDescriptionFromMarkdown(input.body)
      ?? `${input.name} agent`,
  );
  return {
    name: normalizeAgentName(coerceString(input.frontmatter.name) ?? input.name) || input.name,
    displayName: normalizeAgentName(coerceString(input.frontmatter.name) ?? ''),
    source: input.source,
    rootDir: input.rootDir,
    agentFile: input.agentFile,
    description,
    tools: parseStringList(input.frontmatter.tools),
    disallowedTools: parseStringList(input.frontmatter['disallowed-tools'] ?? input.frontmatter.disallowedTools),
    model: normalizeModelField(coerceString(input.frontmatter.model)),
    effort: coerceString(input.frontmatter.effort),
    permissionMode: parsePermissionMode(input.frontmatter['permission-mode'] ?? input.frontmatter.permissionMode),
    maxTurns: parsePositiveInteger(input.frontmatter['max-turns'] ?? input.frontmatter.maxTurns),
    skills: parseStringList(input.frontmatter.skills),
    background: parseBoolean(input.frontmatter.background),
    body: input.body.trim(),
  };
}

export function parseAgentMarkdown(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = raw.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    return { frontmatter: {}, body: normalized };
  }
  const lineEnd = normalized.startsWith('---\r\n') ? '\r\n' : '\n';
  const endMarker = `${lineEnd}---${lineEnd}`;
  const end = normalized.indexOf(endMarker, 3);
  if (end < 0) return { frontmatter: {}, body: normalized };
  const frontmatterText = normalized.slice(3 + lineEnd.length, end).trim();
  const body = normalized.slice(end + endMarker.length);
  return {
    frontmatter: parseFrontmatter(frontmatterText),
    body,
  };
}

function parseFrontmatter(text: string): Record<string, unknown> {
  try {
    const parsed = parseYaml(text);
    return isPlainRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// A fresh subagent is the SAME Tenon agent in headless mode, not a separate
// dumbed-down persona: it reuses the shared-core system prompt (capabilities,
// tool conventions, safety — `LIN_SUBAGENT_CORE_PROMPT`) and layers a subagent
// identity + directive on top, then the definition's own persona body. `general`
// carries an empty body, so it is just "the base agent, headless, zero persona";
// a custom definition's body is the additive specialization. (Fork takes a
// different path — it reuses the parent's full prompt + a fork directive.)
export function buildFreshAgentSystemPrompt(definition: AgentDefinition): string {
  const header = [
    'You are a Tenon subagent — a focused worker the main Tenon agent spawned to complete one task and report back.',
    '',
    `Agent type: ${definition.name}`,
    `Agent description: ${definition.description}`,
    '',
    '# Subagent rules',
    '- Complete only the assigned task and return a concise final result to the parent agent.',
    '- You run headless: never ask the user questions. If a required decision is missing, make a reasonable assumption and state it in your result.',
    '- Use tools directly when useful. Keep intermediate reasoning and tool chatter out of the final result unless the parent asked for it.',
    '- Stay inside the assigned scope; note adjacent work briefly instead of expanding into it.',
    '- Do not claim work that you did not do.',
  ].join('\n');
  return [
    header,
    LIN_SUBAGENT_CORE_PROMPT,
    definition.body.trim() ? `# Agent instructions\n${definition.body.trim()}` : null,
  ].filter(Boolean).join('\n\n');
}

function buildForkDirective(directive: string): string {
  return [
    `<${FORK_BOILERPLATE_TAG}>`,
    'STOP. READ THIS FIRST.',
    '',
    'You are a forked Tenon worker. You inherited the parent conversation context, but your execution is isolated from the parent context.',
    '',
    'Rules:',
    '1. Do not fork again.',
    '2. Stay strictly within the directive.',
    '3. Use tools directly when useful.',
    '4. Do not ask the user questions.',
    '5. Keep the final report factual and concise.',
    `</${FORK_BOILERPLATE_TAG}>`,
    '',
    `Directive: ${directive}`,
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

function parentMessagesContainForkTag(messages: readonly AgentMessage[]): boolean {
  return messages.some((message) => messageTextParts(message).some((text) => text.includes(`<${FORK_BOILERPLATE_TAG}>`)));
}

function lastAssistantMessage(messages: readonly AgentMessage[]): AssistantMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant') return message;
  }
  return null;
}

export function subagentToolResult(toolName: string, data: AgentSubagentToolData) {
  // Next-step guidance is an envelope concern, not data: lift data.instructions
  // to the envelope's instructions field so it sits beside status/error like
  // every other tool, rather than nested inside the result payload.
  const envelope = successEnvelope(toolName, data, data.instructions ? { instructions: data.instructions } : {});
  return agentToolResult(envelope, visibleSubagentResult(data));
}

// Model-visible projection. The full AgentSubagentToolData stays on the envelope
// (details); the parent agent only needs the lifecycle status, the id to address
// follow-ups, and the produced result/error. Next-step instructions are carried
// by the envelope's instructions field. Echoed launch arguments (prompt,
// description, subagent_type, context_mode) and timestamps/transcript counts are
// dropped.
export function visibleSubagentResult(data: AgentSubagentToolData): unknown {
  const visible: Record<string, unknown> = {
    status: data.status,
    agent_id: data.agent_id,
  };
  if (data.name) visible.name = data.name;
  if (data.result !== undefined) visible.result = data.result;
  if (data.error !== undefined) visible.error = data.error;
  return visible;
}

function runToToolData(run: AgentRunRecord): AgentSubagentToolData {
  return {
    status: run.status,
    agent_id: run.id,
    name: run.name,
    description: run.description,
    prompt: run.prompt,
    subagent_type: run.subagentType,
    context_mode: run.contextMode,
    executing_agent_id: run.executingAgentId,
    parent_agent_id: run.parentAgentId,
    memory_owner_agent_id: run.memoryOwnerAgentId,
    result: run.result,
    error: run.error,
    started_at: run.startedAt,
    updated_at: run.updatedAt,
    completed_at: run.completedAt,
    transcript_message_count: run.messages.length,
  };
}

function snapshotRun(run: AgentRunRecord): AgentSubagentRunSnapshot {
  return {
    id: run.id,
    name: run.name,
    description: run.description,
    prompt: run.prompt,
    subagentType: run.subagentType,
    contextMode: run.contextMode,
    executingAgentId: run.executingAgentId,
    parentAgentId: run.parentAgentId,
    memoryOwnerAgentId: run.memoryOwnerAgentId,
    memoryOriginWorkspace: run.memoryOriginWorkspace,
    dreamEvidenceStartMessageIndex: run.dreamEvidenceStartMessageIndex,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    result: run.result,
    error: run.error,
    transcriptMessages: run.messages.map(cloneAgentMessage),
    parentToolCallId: run.parentToolCallId,
  };
}

function subagentToolOutputPayloadId(run: AgentRunRecord, toolCallId: string): string {
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

function withMemoryReminder(messages: AgentMessage[], memoryReminder: string | null): AgentMessage[] {
  if (!memoryReminder) return messages;
  return [createHiddenUserMessage(memoryReminder), ...messages.map(cloneAgentMessage)];
}

function latestUserQuery(messages: readonly AgentMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const text = messageTextParts(message).join('\n').trim();
    if (text) return text;
  }
  return null;
}

function extractFinalAssistantText(messages: readonly AgentMessage[]): string {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'assistant') continue;
    const text = message.content
      .filter((part): part is TextContent => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return 'Subagent completed without a text result.';
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
  const description = coerceString(raw.description)?.trim();
  const prompt = coerceString(raw.prompt)?.trim();
  if (!description) throw new Error('Agent input requires description.');
  if (!prompt) throw new Error('Agent input requires prompt.');
  return {
    description,
    prompt,
    subagent_type: coerceString(raw.subagent_type),
    model: coerceString(raw.model),
    run_in_background: raw.run_in_background === true,
    name: coerceString(raw.name),
  };
}

function normalizeRunSelector(raw: unknown): { agent_id?: string; name?: string; wait?: boolean; timeout_ms?: number } {
  if (!isPlainRecord(raw)) return {};
  return {
    agent_id: coerceString(raw.agent_id),
    name: coerceString(raw.name),
    wait: raw.wait === true,
    timeout_ms: parsePositiveInteger(raw.timeout_ms),
  };
}

function normalizeSendParams(raw: unknown): { agent_id?: string; name?: string; message: string } {
  if (!isPlainRecord(raw)) throw new Error('AgentSend input must be an object.');
  const message = coerceString(raw.message)?.trim();
  if (!message) throw new Error('AgentSend input requires message.');
  return {
    agent_id: coerceString(raw.agent_id),
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
  if (!body.includes(`The following agents are available for use with the ${AGENT_SUBAGENT_TOOL_NAME} tool:`)) {
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
  const override = Number(process.env.AGENT_SUBAGENT_LISTING_CHAR_BUDGET);
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

function normalizeConfiguredDirectories(value: readonly string[] | undefined, root: string): string[] {
  if (!value?.length) return [];
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const item of value) {
    const expanded = expandConfiguredPath(item, root);
    if (!expanded || seen.has(expanded)) continue;
    seen.add(expanded);
    dirs.push(expanded);
  }
  return dirs;
}

function expandConfiguredPath(value: string, root: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return path.join(homedir(), trimmed.slice(2));
  if (trimmed.startsWith('$HOME/')) return path.join(homedir(), trimmed.slice('$HOME/'.length));
  if (trimmed.startsWith('${HOME}/')) return path.join(homedir(), trimmed.slice('${HOME}/'.length));
  return path.resolve(root, trimmed);
}

async function agentFileIdentity(agentFile: string): Promise<string> {
  if (agentFile.startsWith('built-in/')) return agentFile;
  try {
    return await realpath(agentFile);
  } catch {
    return path.resolve(agentFile);
  }
}

function normalizeAgentName(name: string): string {
  const normalized = name.trim().replace(/^\//, '');
  if (!normalized) return '';
  return normalized.replace(/\s+/g, '-');
}

function normalizeModelField(value: string | undefined): string | undefined {
  if (!value || value === 'inherit') return undefined;
  return value;
}

function normalizeToolRuleName(rule: string): string | null {
  const raw = rule.trim();
  if (!raw) return null;
  if (raw === '*') return '*';
  const name = raw.split('(')[0]!.trim().toLowerCase().replace(/-/g, '_');
  const aliases: Record<string, string> = {
    read: 'file_read',
    glob: 'file_glob',
    grep: 'file_grep',
    edit: 'file_edit',
    write: 'file_write',
  };
  return aliases[name] ?? name;
}

function parseStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => typeof item === 'string' ? item.trim() : '')
      .filter(Boolean);
    return items.length > 0 ? [...new Set(items)] : undefined;
  }
  if (typeof value === 'string') {
    const items = value.split(',').map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? [...new Set(items)] : undefined;
  }
  return undefined;
}

function parsePermissionMode(value: unknown): AgentPermissionMode | undefined {
  if (value === 'trusted' || value === 'restricted') return value;
  return undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', '1'].includes(normalized)) return true;
  if (['false', 'no', '0'].includes(normalized)) return false;
  return undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isInteger(numeric) || numeric <= 0) return undefined;
  return numeric;
}

function extractDescriptionFromMarkdown(body: string): string | undefined {
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find(Boolean);
}

function compactInlineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function coerceString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPathInside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizePathForPrompt(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
