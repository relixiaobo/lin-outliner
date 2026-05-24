import type { AfterToolCallResult } from '@earendil-works/pi-agent-core';
import { completeSimple, isContextOverflow } from '@earendil-works/pi-ai';
import type {
  Api,
  AssistantMessage,
  ImageContent as PiImageContent,
  Model,
  ProviderResponse,
  TextContent as PiTextContent,
} from '@earendil-works/pi-ai';
import type { AgentMessage, UserMessage } from '../core/agentTypes';
import {
  getAgentEventActivePath,
  type AgentActor,
  type AgentCompactionTrigger,
  type AgentEventReplayState,
  type AgentEventType,
  type AgentPayloadRef,
} from '../core/agentEventLog';
import { LIN_AGENT_SYSTEM_PROMPT } from './agentSystemPrompt';
import type { AgentSkillRuntime } from './agentSkills';
import type { AgentLocalWorkspaceContext } from './agentLocalTools';
import { restorePostCompactReadFiles } from './agentLocalTools';
import {
  assistantMessageText,
  buildCompactSummaryRequest,
  collectPreservedFileReadPaths,
  createPostCompactMessage,
  createPostCompactRestoredFilesReminder,
  formatCompactSummary,
  splitReactiveCompactMessages,
  truncateCompactMessagesForPromptTooLongRetry,
} from './agentCompaction';
import {
  collectMicrocompactCandidates,
  collectToolResultBudgetSelections,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  estimateAgentMessagesTokens,
  MAX_TOOL_RESULTS_PER_BATCH_CHARS,
  OLD_TOOL_RESULT_CLEARED_MESSAGE,
  piToolResultTextContent,
  restoreToolResultBudgetStateFromMessages,
  summarizeTextPayload,
  type ToolResultBudgetState,
} from './agentToolOutputSlimming';
import { providerStreamOptionsFromRuntimeSettings, type AgentProviderRuntimeConfig } from './agentSettings';
import type { AgentRuntimeSettings } from '../core/types';
import { awaitWithAbort, isAbortError, throwIfAborted } from './agentAwaitWithAbort';

type CompleteSimpleFn = typeof completeSimple;

const AUTO_COMPACT_RESERVED_OUTPUT_TOKENS = 20_000;
const AUTO_COMPACT_BUFFER_TOKENS = 13_000;
const AUTO_COMPACT_MAX_FAILURES = 3;
const COMPACT_MAX_PTL_RETRIES = 3;
const COMPACT_SUMMARY_MAX_OUTPUT_TOKENS = 20_000;
const POST_COMPACT_MAX_FILES_TO_RESTORE = 5;
const POST_COMPACT_MAX_CHARS_PER_FILE = 20_000;
const POST_COMPACT_TOTAL_RESTORED_FILE_CHARS = 200_000;
const TIME_BASED_MICROCOMPACT_GAP_MS = 30 * 60_000;
const TIME_BASED_MICROCOMPACT_KEEP_RECENT = 3;
const TOOL_RESULT_BUDGET_SKIP_TOOLS = new Set(['file_read']);

export interface AgentRuntimeContextSession {
  agent: {
    state: {
      isStreaming: boolean;
      messages: unknown[];
    };
    continue(): Promise<void>;
  };
  autoCompactConsecutiveFailures: number;
  autoCompactInProgress: boolean;
  eventState: AgentEventReplayState;
  lastSubmittedUserPrompt: UserMessage | null;
  reactiveCompactRequested: boolean;
  runtimeSettings: AgentRuntimeSettings;
  skillRuntime: AgentSkillRuntime;
  subagentRuntime?: {
    createAgentListingStateReminder(): UserMessage | null;
  };
  localWorkspace: AgentLocalWorkspaceContext;
  toolOutputPayloads: Map<string, { payload: AgentPayloadRef; label: string }>;
  toolResultBudgetState: ToolResultBudgetState;
}

export type AgentRuntimeContextEventInput = {
  type: AgentEventType;
  actor: AgentActor;
  createdAt?: number;
  [key: string]: unknown;
};

export interface AgentRuntimeContextHost<TSession extends AgentRuntimeContextSession> {
  refreshRuntimeSettings(session: TSession): Promise<AgentRuntimeSettings>;
  deriveRuntimePiMessages(sessionId: string, eventState: AgentEventReplayState): Promise<AgentMessage[]>;
  appendSessionEvents(sessionId: string, session: TSession, inputs: AgentRuntimeContextEventInput[]): Promise<void>;
  appendCompactionRootEvent(
    sessionId: string,
    session: TSession,
    prompt: UserMessage,
    summary: string,
    compactedThroughMessageId: string,
    trigger: AgentCompactionTrigger,
    preservedMessages: readonly AgentMessage[],
  ): Promise<void>;
  persistToolOutputPayload(
    sessionId: string,
    toolCallId: string,
    toolName: string,
    text: string,
  ): Promise<{ payload: AgentPayloadRef; label: string }>;
  captureDebugPayload(sessionId: string, payload: unknown, model: Model<any>): Promise<void>;
  captureDebugResponse(sessionId: string, response: ProviderResponse, model: Model<any>): Promise<void>;
  emitError(sessionId: string, message: string): void;
  getActiveProviderConfig(): Promise<AgentProviderRuntimeConfig | null>;
  getProviderApiKey(providerId: string): Promise<string | undefined> | string | undefined;
  resolveProviderModel(providerConfig: AgentProviderRuntimeConfig): Model<Api>;
  beginCompaction(sessionId: string, session: TSession, trigger: AgentCompactionTrigger): string;
  finishCompaction(sessionId: string, session: TSession, compactionId: string, lastEventType: string): void;
  startReactiveRetryRun(sessionId: string, session: TSession): Promise<void>;
  completeSimpleFn?: CompleteSimpleFn;
}

export class AgentRuntimeContextManager<TSession extends AgentRuntimeContextSession> {
  constructor(private readonly host: AgentRuntimeContextHost<TSession>) {}

  async afterToolResultForModelContext(
    sessionId: string,
    session: TSession,
    toolCallId: string,
    toolName: string,
    result: unknown,
    _isError: boolean,
  ): Promise<AfterToolCallResult | undefined> {
    if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
    const text = piToolResultTextContent(result.content as Array<PiTextContent | PiImageContent>);
    if (!text || text.length <= DEFAULT_MAX_TOOL_RESULT_CHARS) return undefined;

    let persisted: { payload: AgentPayloadRef; label: string };
    try {
      persisted = await this.host.persistToolOutputPayload(sessionId, toolCallId, toolName, text);
    } catch (error) {
      this.host.emitError(sessionId, error instanceof Error ? error.message : String(error));
      return undefined;
    }
    session.toolOutputPayloads.set(toolCallId, persisted);
    return {
      content: [{ type: 'text', text: persisted.label }],
    };
  }

  async prepareModelContext(sessionId: string, session: TSession, signal?: AbortSignal): Promise<AgentMessage[]> {
    try {
      throwIfAborted(signal);
      await this.host.refreshRuntimeSettings(session);
      throwIfAborted(signal);
      let changed = false;
      if (session.runtimeSettings.compactEnabled) {
        changed = await this.applyToolResultBudget(sessionId, session) || changed;
        throwIfAborted(signal);
        changed = await this.applyTimeBasedMicrocompact(sessionId, session) || changed;
        throwIfAborted(signal);
      }

      let messages = await this.host.deriveRuntimePiMessages(sessionId, session.eventState);
      throwIfAborted(signal);
      if (session.runtimeSettings.compactEnabled && await this.shouldAutoCompact(session, messages)) {
        const compacted = await this.tryAutoCompact(sessionId, session, signal);
        if (compacted) {
          changed = true;
          messages = compacted;
        }
      }
      throwIfAborted(signal);
      if (changed && !session.agent.state.isStreaming) {
        session.agent.state.messages = messages as never;
      }
      return messages;
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      this.host.emitError(sessionId, error instanceof Error ? error.message : String(error));
      return this.host.deriveRuntimePiMessages(sessionId, session.eventState);
    }
  }

  async compactSession(
    sessionId: string,
    session: TSession,
    options: {
      trigger: 'manual' | 'auto' | 'reactive';
      customInstructions?: string;
      updateAgentState: boolean;
      signal?: AbortSignal;
    },
  ): Promise<AgentMessage[]> {
    let activeCompactionId: string | null = null;
    try {
      throwIfAborted(options.signal);
      let activeMessages = await this.host.deriveRuntimePiMessages(sessionId, session.eventState);
      throwIfAborted(options.signal);
      if (options.trigger === 'reactive') {
        const liveMessages = session.agent.state.messages as AgentMessage[];
        if (liveMessages.length > activeMessages.length) activeMessages = liveMessages;
      }
      const selectedLeafMessageId = session.eventState.selectedLeafMessageId ?? session.eventState.latestMessageId;
      if (!selectedLeafMessageId || activeMessages.length < 2) {
        throw new Error('Not enough messages to compact.');
      }

      const runtimeSettings = await this.host.refreshRuntimeSettings(session);
      const providerConfig = await this.host.getActiveProviderConfig();
      if (!providerConfig) throw new Error('No enabled agent provider is configured.');
      const model = this.host.resolveProviderModel(providerConfig);
      const apiKey = providerConfig.apiKey ?? await this.host.getProviderApiKey(providerConfig.providerId);
      const compactPlan = options.trigger === 'reactive'
        ? splitReactiveCompactMessages(activeMessages)
        : { messagesToSummarize: activeMessages, messagesToKeep: [] as AgentMessage[] };
      if (
        options.trigger === 'reactive'
        && compactPlan.messagesToKeep.length === 0
        && session.lastSubmittedUserPrompt
      ) {
        compactPlan.messagesToKeep.push(session.lastSubmittedUserPrompt);
      }
      const compactedThroughMessageId = compactedThroughMessageIdForPlan(
        getAgentEventActivePath(session.eventState),
        compactPlan.messagesToSummarize.length,
      ) ?? selectedLeafMessageId;

      activeCompactionId = this.host.beginCompaction(sessionId, session, options.trigger);
      const response = await this.completeCompactSummaryWithRetries(sessionId, model, apiKey, {
        messagesToSummarize: compactPlan.messagesToSummarize,
        customInstructions: options.customInstructions,
        mode: compactPlan.messagesToKeep.length > 0 ? 'up_to' : 'full',
        signal: options.signal,
        runtimeSettings,
      });
      throwIfAborted(options.signal);
      const summary = formatCompactSummary(assistantMessageText(response));
      if (!summary) throw new Error('Compaction failed: no summary text returned.');

      session.skillRuntime.restoreInvokedSkillsFromMessages(activeMessages);
      const restoredFiles = await restorePostCompactReadFiles(session.localWorkspace, {
        maxFiles: POST_COMPACT_MAX_FILES_TO_RESTORE,
        maxCharsPerFile: POST_COMPACT_MAX_CHARS_PER_FILE,
        maxTotalChars: POST_COMPACT_TOTAL_RESTORED_FILE_CHARS,
        preservedFilePaths: collectPreservedFileReadPaths(compactPlan.messagesToKeep),
      });
      const compactMessage = createPostCompactMessage(
        summary,
        session.skillRuntime.createInvokedSkillsReminder(),
        session.skillRuntime.createSkillListingStateReminder(),
        session.subagentRuntime?.createAgentListingStateReminder() ?? null,
        createPostCompactRestoredFilesReminder(restoredFiles),
        { recentMessagesPreserved: compactPlan.messagesToKeep.length > 0 },
      );
      await this.host.appendCompactionRootEvent(
        sessionId,
        session,
        compactMessage,
        summary,
        compactedThroughMessageId,
        options.trigger,
        compactPlan.messagesToKeep,
      );
      const postCompactMessages = await this.host.deriveRuntimePiMessages(sessionId, session.eventState);
      session.toolResultBudgetState = restoreToolResultBudgetStateFromMessages(getAgentEventActivePath(session.eventState));
      if (options.updateAgentState) session.agent.state.messages = postCompactMessages as never;
      this.host.finishCompaction(sessionId, session, activeCompactionId, 'compaction.completed');
      activeCompactionId = null;
      return postCompactMessages;
    } finally {
      if (activeCompactionId) {
        this.host.finishCompaction(sessionId, session, activeCompactionId, 'compaction.finished');
      }
    }
  }

  async runReactiveCompactRetryIfNeeded(sessionId: string, session: TSession): Promise<void> {
    for (let attempt = 0; attempt < 2 && session.reactiveCompactRequested; attempt += 1) {
      session.reactiveCompactRequested = false;
      await this.host.refreshRuntimeSettings(session);
      if (!session.runtimeSettings.compactEnabled) return;
      if (session.autoCompactConsecutiveFailures >= AUTO_COMPACT_MAX_FAILURES) return;
      try {
        await this.compactSession(sessionId, session, {
          trigger: 'reactive',
          updateAgentState: true,
        });
        session.autoCompactConsecutiveFailures = 0;
        session.skillRuntime.resetRunPermissionRules();
        await this.host.startReactiveRetryRun(sessionId, session);
        await continueFromActivePath(session.agent);
      } catch (error) {
        session.autoCompactConsecutiveFailures += 1;
        this.host.emitError(sessionId, error instanceof Error ? error.message : String(error));
        return;
      }
    }
  }

  private async applyToolResultBudget(sessionId: string, session: TSession): Promise<boolean> {
    const activePath = getAgentEventActivePath(session.eventState);
    const selection = collectToolResultBudgetSelections(activePath, session.toolResultBudgetState, {
      limit: MAX_TOOL_RESULTS_PER_BATCH_CHARS,
      skipToolNames: TOOL_RESULT_BUDGET_SKIP_TOOLS,
    });
    if (selection.toPersist.length === 0) return false;

    const inputs: AgentRuntimeContextEventInput[] = [];
    const persistedCandidates: Array<{
      candidate: (typeof selection.toPersist)[number];
      persisted: { payload: AgentPayloadRef; label: string };
    }> = [];
    for (const candidate of selection.toPersist) {
      let persisted: { payload: AgentPayloadRef; label: string };
      try {
        persisted = await this.host.persistToolOutputPayload(
          sessionId,
          candidate.toolCallId,
          candidate.toolName,
          candidate.contentText,
        );
      } catch (error) {
        session.toolResultBudgetState.seenIds.add(candidate.toolCallId);
        this.host.emitError(sessionId, error instanceof Error ? error.message : String(error));
        continue;
      }
      persistedCandidates.push({ candidate, persisted });
      inputs.push(
        {
          type: 'payload.created',
          actor: toolActor(candidate.toolName, candidate.toolCallId),
          payload: persisted.payload,
        },
        {
          type: 'tool_result.replaced',
          actor: systemActor(),
          messageId: candidate.messageId,
          toolCallId: candidate.toolCallId,
          content: [{ type: 'payload_ref', payload: persisted.payload, label: persisted.label }],
          outputSummary: summarizeTextPayload(candidate.contentText, `${candidate.toolName} output`),
          outputRef: persisted.payload,
        },
      );
    }

    if (inputs.length === 0) return false;
    await this.host.appendSessionEvents(sessionId, session, inputs);
    for (const { candidate, persisted } of persistedCandidates) {
      session.toolResultBudgetState.seenIds.add(candidate.toolCallId);
      session.toolResultBudgetState.replacements.set(candidate.toolCallId, persisted.label);
    }
    return true;
  }

  private async applyTimeBasedMicrocompact(sessionId: string, session: TSession): Promise<boolean> {
    const activePath = getAgentEventActivePath(session.eventState);
    const lastAssistant = [...activePath].reverse().find((message) => message.role === 'assistant');
    if (!lastAssistant || Date.now() - lastAssistant.updatedAt < TIME_BASED_MICROCOMPACT_GAP_MS) return false;
    const candidates = collectMicrocompactCandidates(activePath, TIME_BASED_MICROCOMPACT_KEEP_RECENT);
    if (candidates.length === 0) return false;
    await this.host.appendSessionEvents(sessionId, session, candidates.map((candidate): AgentRuntimeContextEventInput => ({
      type: 'tool_result.replaced',
      actor: systemActor(),
      messageId: candidate.messageId,
      toolCallId: candidate.toolCallId,
      content: [{ type: 'text', text: OLD_TOOL_RESULT_CLEARED_MESSAGE }],
      outputSummary: OLD_TOOL_RESULT_CLEARED_MESSAGE,
    })));
    return true;
  }

  private async shouldAutoCompact(session: TSession, messages: AgentMessage[]): Promise<boolean> {
    if (session.autoCompactInProgress) return false;
    if (session.autoCompactConsecutiveFailures >= AUTO_COMPACT_MAX_FAILURES) return false;
    if (messages.length < 2) return false;
    const providerConfig = await this.host.getActiveProviderConfig();
    if (!providerConfig) return false;
    const model = this.host.resolveProviderModel(providerConfig);
    const threshold = autoCompactThreshold(model);
    if (!Number.isFinite(threshold) || threshold <= 0) return false;
    const tokens = estimateAgentMessagesTokens(messages, LIN_AGENT_SYSTEM_PROMPT);
    return tokens >= threshold;
  }

  private async tryAutoCompact(sessionId: string, session: TSession, signal?: AbortSignal): Promise<AgentMessage[] | null> {
    session.autoCompactInProgress = true;
    try {
      const compacted = await this.compactSession(sessionId, session, {
        trigger: 'auto',
        updateAgentState: false,
        signal,
      });
      session.autoCompactConsecutiveFailures = 0;
      return compacted;
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      session.autoCompactConsecutiveFailures += 1;
      if (session.autoCompactConsecutiveFailures >= AUTO_COMPACT_MAX_FAILURES) {
        this.host.emitError(sessionId, `Auto compact failed ${session.autoCompactConsecutiveFailures} times; continuing without automatic compact.`);
      }
      return null;
    } finally {
      session.autoCompactInProgress = false;
    }
  }

  private async completeCompactSummaryWithRetries(
    sessionId: string,
    model: Model<Api>,
    apiKey: string | undefined,
    options: {
      messagesToSummarize: AgentMessage[];
      customInstructions?: string;
      mode?: 'full' | 'up_to';
      runtimeSettings: AgentRuntimeSettings;
      signal?: AbortSignal;
    },
  ): Promise<AssistantMessage> {
    let messagesToSummarize = options.messagesToSummarize;
    for (let attempt = 0; ; attempt += 1) {
      throwIfAborted(options.signal);
      const request = buildCompactSummaryRequest(messagesToSummarize, options.customInstructions, {
        mode: options.mode,
      });
      const response = await awaitWithAbort((this.host.completeSimpleFn ?? completeSimple)(model, {
        messages: [request],
        tools: [],
      }, {
        ...providerStreamOptionsFromRuntimeSettings(options.runtimeSettings),
        apiKey,
        maxTokens: Math.min(model.maxTokens ?? COMPACT_SUMMARY_MAX_OUTPUT_TOKENS, COMPACT_SUMMARY_MAX_OUTPUT_TOKENS),
        sessionId,
        signal: options.signal,
        onPayload: async (payload, payloadModel) => {
          try {
            await this.host.captureDebugPayload(sessionId, payload, payloadModel);
          } catch (error) {
            this.host.emitError(sessionId, error instanceof Error ? error.message : String(error));
          }
          return undefined;
        },
        onResponse: async (responsePayload, responseModel) => {
          try {
            await this.host.captureDebugResponse(sessionId, responsePayload, responseModel);
          } catch (error) {
            this.host.emitError(sessionId, error instanceof Error ? error.message : String(error));
          }
        },
      }), { signal: options.signal });

      const canRetry = (response.stopReason === 'error' || response.stopReason === 'aborted')
        && isContextOverflow(response, model.contextWindow)
        && attempt < COMPACT_MAX_PTL_RETRIES;
      if (canRetry) {
        const errorText = response.errorMessage ?? assistantMessageText(response);
        const truncated = truncateCompactMessagesForPromptTooLongRetry(messagesToSummarize, errorText);
        if (truncated) {
          messagesToSummarize = truncated;
          continue;
        }
      }
      if (response.stopReason === 'error' || response.stopReason === 'aborted') {
        throw new Error(response.errorMessage || 'Compaction failed.');
      }
      return response;
    }
  }
}

export function autoCompactThreshold(model: Model<Api>): number {
  const contextWindow = model.contextWindow ?? 128000;
  const reservedOutput = Math.min(model.maxTokens ?? 8192, AUTO_COMPACT_RESERVED_OUTPUT_TOKENS);
  const effectiveWindow = Math.max(0, contextWindow - reservedOutput);
  return effectiveWindow - AUTO_COMPACT_BUFFER_TOKENS;
}

function compactedThroughMessageIdForPlan(
  activePath: readonly { id: string }[],
  summarizedMessageCount: number,
): string | null {
  if (activePath.length === 0 || summarizedMessageCount <= 0) return null;
  const index = Math.min(activePath.length, summarizedMessageCount) - 1;
  return activePath[index]?.id ?? null;
}

async function continueFromActivePath(agent: AgentRuntimeContextSession['agent']) {
  if (!canContinueFromMessage(agent.state.messages.at(-1) as AgentMessage | undefined)) {
    throw new Error('Cannot continue without a trailing user or tool result message.');
  }
  await agent.continue();
}

function canContinueFromMessage(message: AgentMessage | undefined): boolean {
  return message?.role === 'user' || message?.role === 'toolResult';
}

function systemActor(): AgentActor {
  return { type: 'system' };
}

function toolActor(toolName: string, toolCallId: string): AgentActor {
  return { type: 'tool', toolName, toolCallId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
