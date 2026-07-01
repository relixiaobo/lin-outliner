import { useSyncExternalStore } from 'react';
import { api } from '../api/client';
import { isSystemReminderBlock } from '../../core/agentAttachments';
import { DEFAULT_GENERAL_CHANNEL_ID } from '../../core/agentChannel';
import type {
  AgentConversationMessage,
  AgentApprovalRequestView,
  AgentApprovalResolutionScope,
  AgentMessageAttachmentInput,
  AgentMessageBranchState,
  AgentRuntimeEvent,
  AgentToolResultWithPayloads,
  AgentUserQuestionPendingView,
  AgentUserViewContext,
  AskUserQuestionResult,
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from '../../core/agentTypes';
import type { AgentConversation, AgentCreateConversationOptions } from '../../core/types';
import type {
  AgentRenderActiveCompaction,
  AgentRenderActiveDream,
  AgentRenderCompactionEntity,
  AgentRenderContextClearEntity,
  AgentRenderDreamEntity,
  AgentRenderMemberView,
  AgentRenderMessageEntity,
  AgentRenderProjection,
  AgentRenderProjectionPatch,
  AgentRenderChildRunEntity,
} from '../../core/agentRenderProjection';
import { applyAgentRenderProjectionPatch } from '../../core/agentRenderProjection';
import type { AgentActor, AgentPersistedContent, AgentToolCallOutcome } from '../../core/agentEventLog';

export interface AgentMessageEntry {
  id: string;
  kind: 'message';
  nodeId: string | null;
  message: AgentConversationMessage;
  branches: AgentMessageBranchState | null;
  streaming: boolean;
  /** Who produced this message (Channel attribution); null for the streaming placeholder. */
  actor: AgentActor | null;
  /** Run that produced this message, when known. */
  runId: string | null;
  /** Aggregated usage for the producing run; falls back to message usage when unavailable. */
  runUsage?: Usage;
  /** First event seq that represents this message as source evidence. */
  sourceSeq?: number;
  /** Every event seq that represents this message as source evidence. */
  sourceSeqs?: number[];
  /**
   * Settled outcome per tool call (toolCallId → completed/failed), derived from
   * the entity's persisted content. The pi `AssistantMessage` above drops it, so
   * the process timeline reads it from here to stop a completed-but-resultless
   * tool call from spinning forever. Omitted when no call has settled.
   */
  toolCallOutcomes?: ReadonlyMap<string, AgentToolCallOutcome>;
  /** Wall-clock the producing run took, for the collapsed "Worked for …" header; null when unknown. */
  runDurationMs: number | null;
  /** Producing run's start, for the live "Working for {t}" ticker; null unless the run is still running. */
  runStartedAtMs: number | null;
  /**
   * Authoritative interrupted verdict from the producing run's real status (core
   * stamps it). Drives the "Interrupted" process header; a cleanly `completed`
   * turn is never interrupted even without trailing prose. Never inferred from
   * block structure — see the projection's `turnInterrupted`.
   */
  turnInterrupted: boolean;
}

export interface AgentCompletedCompactionEntry {
  id: string;
  kind: 'compaction';
  status: 'completed';
  compaction: AgentRenderCompactionEntity;
}

export interface AgentActiveCompactionEntry {
  id: string;
  kind: 'compaction';
  status: 'active';
  compaction: AgentRenderActiveCompaction;
}

export type AgentCompactionEntry = AgentCompletedCompactionEntry | AgentActiveCompactionEntry;

export interface AgentContextClearEntry {
  id: string;
  kind: 'context-clear';
  contextClear: AgentRenderContextClearEntity;
}

export interface AgentCompletedDreamEntry {
  id: string;
  kind: 'dream';
  status: 'completed';
  dream: AgentRenderDreamEntity;
}

export interface AgentActiveDreamEntry {
  id: string;
  kind: 'dream';
  status: 'active';
  dream: AgentRenderActiveDream;
}

export type AgentDreamEntry = AgentCompletedDreamEntry | AgentActiveDreamEntry;

// Child-run entries stay in the type for replay/projection compatibility, but
// the live transcript no longer renders them as standalone boundary rows. Runs
// surface through their ordinary spawn/run_* tool calls plus the Work/Runs view.
export interface AgentChildRunEntry {
  id: string;
  kind: 'child-run';
  childRun: AgentRenderChildRunEntity;
}

export type AgentConversationEntry =
  | AgentMessageEntry
  | AgentCompactionEntry
  | AgentContextClearEntry
  | AgentDreamEntry
  | AgentChildRunEntry;

export type AgentTurnPhase = 'idle' | 'streaming_text' | 'waiting_for_tool' | 'resuming_after_tool';

const EMPTY_PROJECTION: AgentRenderProjection = {
  conversationId: '',
  revision: 0,
  conversationTitle: null,
  members: [],
  activeRuns: [],
  activeRunId: null,
  activeCompaction: null,
  activeDream: null,
  runActive: false,
  model: {},
  thinkingLevel: 'off',
  pendingToolCallIds: [],
  errorMessage: null,
  rows: [],
  transcriptRows: [],
  childRunIds: [],
  entities: { messages: {}, childRuns: {}, compactions: {}, contextClears: {}, dreams: {} },
  streaming: null,
};

const EMPTY_MEMBERS: AgentRenderMemberView[] = [];
const CONVERSATION_MESSAGE_CACHE = new WeakMap<AgentRenderMessageEntity, AgentConversationMessage>();
const TOOL_RESULT_CACHE = new WeakMap<AgentRenderMessageEntity, AgentToolResultWithPayloads>();
// The pi `AssistantMessage` the renderer consumes drops the persisted toolCall
// `outcome`, so derive the per-call settled state straight off the entity's
// persisted content (cached per entity so its identity is stable across rebuilds
// until the entity's content actually changes). undefined when no call has settled.
const TOOL_CALL_OUTCOME_CACHE = new WeakMap<AgentRenderMessageEntity, ReadonlyMap<string, AgentToolCallOutcome>>();

function toolCallOutcomesFromEntity(
  entity: AgentRenderMessageEntity,
): ReadonlyMap<string, AgentToolCallOutcome> | undefined {
  const cached = TOOL_CALL_OUTCOME_CACHE.get(entity);
  if (cached) return cached.size > 0 ? cached : undefined;
  const map = new Map<string, AgentToolCallOutcome>();
  for (const part of entity.content) {
    if (part.type === 'toolCall' && part.outcome) map.set(part.id, part.outcome);
  }
  TOOL_CALL_OUTCOME_CACHE.set(entity, map);
  return map.size > 0 ? map : undefined;
}

export const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

export function createAssistantPlaceholderFromModel(
  model: AgentRenderProjection['model'],
  timestamp: number,
  content: AssistantMessage['content'] = [],
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: modelValue(model, 'api') ?? '',
    provider: modelValue(model, 'provider') ?? '',
    model: modelValue(model, 'id') ?? '',
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp,
  };
}

function assistantHasText(message: AssistantMessage | undefined): boolean {
  return message?.content.some((block) => block.type === 'text' && block.text.trim().length > 0) ?? false;
}

function assistantHasPendingToolCalls(
  message: AssistantMessage | undefined,
  toolResults: Map<string, AgentToolResultWithPayloads>,
): boolean {
  if (!message) return false;
  return message.content.some((block) => block.type === 'toolCall' && !toolResults.has(block.id));
}

function buildToolResultMap(projection: AgentRenderProjection): Map<string, AgentToolResultWithPayloads> {
  const results = new Map<string, AgentToolResultWithPayloads>();
  for (const entity of Object.values(projection.entities.messages)) {
    if (entity.role === 'toolResult') {
      const message = toolResultFromEntity(entity);
      results.set(message.toolCallId, message);
    }
  }
  return results;
}

function mapsHaveSameEntityValues<T>(left: ReadonlyMap<string, T>, right: ReadonlyMap<string, T>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

function patchLeavesToolResultsUnchanged(
  projection: AgentRenderProjection,
  patch: AgentRenderProjectionPatch,
): boolean {
  const messages = patch.entities?.messages;
  if (!messages) return true;
  return Object.entries(messages).every(([messageId, next]) => (
    next.role !== 'toolResult' && projection.entities.messages[messageId]?.role !== 'toolResult'
  ));
}

function buildEntries(projection: AgentRenderProjection, toolResults: Map<string, AgentToolResultWithPayloads>): {
  entries: AgentConversationEntry[];
  turnPhase: AgentTurnPhase;
} {
  const entries: AgentConversationEntry[] = [];
  const rows = projection.transcriptRows;
  for (const row of rows) {
    if (row.kind === 'compaction') {
      const compaction = projection.entities.compactions[row.compactionId];
      if (compaction) {
        entries.push({
          id: row.id,
          kind: 'compaction',
          status: 'completed',
          compaction,
        });
      }
      continue;
    }
    if (row.kind === 'context-clear') {
      const contextClear = projection.entities.contextClears[row.contextClearId];
      if (contextClear) {
        entries.push({
          id: row.id,
          kind: 'context-clear',
          contextClear,
        });
      }
      continue;
    }
    if (row.kind === 'dream') {
      const dream = projection.entities.dreams[row.dreamId];
      if (dream) {
        entries.push({
          id: row.id,
          kind: 'dream',
          status: 'completed',
          dream,
        });
      }
      continue;
    }

    if (row.kind === 'child-run') {
      // Keep child-run data available to Work and tool-call rows, but do
      // not add a second transcript boundary. The spawn/run_* tool row is the
      // interaction surface in the main conversation.
      continue;
    }

    const entity = projection.entities.messages[row.messageId];
    if (!entity || (entity.role !== 'user' && entity.role !== 'assistant')) continue;
    if (entity.role === 'user' && isHiddenOnlySystemReminder(entity)) continue;
    const streaming = projection.streaming?.messageId === entity.id;
    const message = conversationMessageFromEntity(entity);
    entries.push({
      id: streaming && entity.role === 'assistant' ? activeAssistantEntryId(entries, projection) : row.id,
      kind: 'message',
      nodeId: row.archived ? null : entity.id,
      message,
      branches: row.archived ? null : entity.branches,
      streaming,
      actor: entity.actor,
      runId: entity.runId ?? null,
      runUsage: entity.runUsage,
      sourceSeq: entity.sourceSeq,
      sourceSeqs: entity.sourceSeqs?.slice(),
      toolCallOutcomes: toolCallOutcomesFromEntity(entity),
      runDurationMs: entity.runDurationMs ?? null,
      runStartedAtMs: entity.runStartedAtMs ?? null,
      turnInterrupted: entity.turnInterrupted ?? false,
    });
  }

  if (projection.activeCompaction) {
    entries.push({
      id: `active-compaction:${projection.activeCompaction.id}`,
      kind: 'compaction',
      status: 'active',
      compaction: projection.activeCompaction,
    });
  }

  if (projection.activeDream) {
    entries.push({
      id: `active-dream:${projection.activeDream.id}`,
      kind: 'dream',
      status: 'active',
      dream: projection.activeDream,
    });
  }

  let turnPhase: AgentTurnPhase = 'idle';
  const streamingEntry = entries.find((entry): entry is AgentMessageEntry => (
    entry.kind === 'message' && entry.streaming && entry.message.role === 'assistant'
  ));
  if (projection.runActive) {
    if (streamingEntry?.message.role === 'assistant') {
      turnPhase = assistantHasText(streamingEntry.message) ? 'streaming_text' : 'resuming_after_tool';
    } else {
      const latestAssistant = [...entries]
        .reverse()
        .find((entry): entry is AgentMessageEntry => entry.kind === 'message' && entry.message.role === 'assistant')
        ?.message as AssistantMessage | undefined;
      turnPhase = assistantHasPendingToolCalls(latestAssistant, toolResults)
        ? 'waiting_for_tool'
        : 'resuming_after_tool';
    }
  }

  const lastEntry = entries[entries.length - 1];
  const shouldAppendAssistantPlaceholder = !projection.activeCompaction
    && !projection.activeDream
    && projection.runActive
    && (
      !lastEntry
      || lastEntry.kind !== 'message'
      || lastEntry.message.role !== 'assistant'
    );

  if (shouldAppendAssistantPlaceholder) {
    entries.push({
      id: activeAssistantEntryId(entries, projection),
      kind: 'message',
      nodeId: null,
      message: createActiveAssistantPlaceholder(projection, entries),
      branches: null,
      streaming: true,
      actor: null,
      runId: null,
      runUsage: undefined,
      runDurationMs: null,
      // No assistant entity yet → no run record; anchor the live "Working for {t}"
      // ticker to the turn-start timestamp (last user message) until the real
      // assistant entity (with its run `startedAt`) takes over.
      runStartedAtMs: activeAssistantAnchorTimestamp(entries, projection),
      turnInterrupted: false,
    });
  }

  return { entries, turnPhase };
}

function isHiddenOnlySystemReminder(entity: AgentRenderMessageEntity): boolean {
  return entity.content.length > 0
    && entity.content.every((part) => part.type === 'text' && isSystemReminderBlock(part.text));
}

function activeAssistantEntryId(entries: AgentConversationEntry[], projection: AgentRenderProjection): string {
  return `active-assistant-${activeAssistantAnchorTimestamp(entries, projection)}`;
}

function activeAssistantAnchorTimestamp(entries: AgentConversationEntry[], projection: AgentRenderProjection): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind === 'message' && entry.message.role === 'user') return entry.message.timestamp;
  }
  const lastUser = [...projection.rows]
    .reverse()
    .map((row) => (row.messageId ? projection.entities.messages[row.messageId] : undefined))
    .find((entity) => entity?.role === 'user');
  if (lastUser) return lastUser.createdAt;
  return 0;
}

function createActiveAssistantPlaceholder(
  projection: AgentRenderProjection,
  entries: AgentConversationEntry[],
): AssistantMessage {
  return createAssistantPlaceholderFromModel(projection.model, activeAssistantAnchorTimestamp(entries, projection));
}

function textContent(text: string): TextContent[] {
  return [{ type: 'text', text }];
}

function projectionModelValue(projection: AgentRenderProjection, key: string): string | null {
  return modelValue(projection.model, key);
}

function modelValue(model: AgentRenderProjection['model'], key: string): string | null {
  const value = model[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function conversationCost(projection: AgentRenderProjection): number {
  return Object.values(projection.entities.messages).reduce((total, message) => {
    if (message.role !== 'assistant') return total;
    return total + (message.usage?.cost?.total ?? 0);
  }, 0);
}

function conversationMessageFromEntity(entity: AgentRenderMessageEntity): AgentConversationMessage {
  const cached = CONVERSATION_MESSAGE_CACHE.get(entity);
  if (cached) return cached;
  let message: AgentConversationMessage;
  if (entity.role === 'user') {
    message = {
      role: 'user',
      content: toUserContent(entity.content),
      timestamp: entity.createdAt,
    };
  } else {
    message = {
      role: 'assistant',
      content: toAssistantContent(entity.content),
      api: entity.apiId ?? '',
      provider: entity.providerId ?? '',
      model: entity.modelId ?? '',
      usage: entity.usage ?? EMPTY_USAGE,
      stopReason: normalizeStopReason(entity.stopReason),
      errorMessage: entity.errorMessage,
      timestamp: entity.createdAt,
    } as AssistantMessage;
  }
  CONVERSATION_MESSAGE_CACHE.set(entity, message);
  return message;
}

function toolResultFromEntity(entity: AgentRenderMessageEntity): AgentToolResultWithPayloads {
  const cached = TOOL_RESULT_CACHE.get(entity);
  if (cached) return cached;
  const message: AgentToolResultWithPayloads = {
    role: 'toolResult',
    toolCallId: entity.toolCallId ?? entity.id,
    toolName: entity.toolName ?? 'unknown',
    content: toToolResultContent(entity.content),
    payloadRefs: payloadRefsFromContent(entity.content),
    isError: !!entity.isError,
    timestamp: entity.createdAt,
  };
  TOOL_RESULT_CACHE.set(entity, message);
  return message;
}

function toUserContent(content: AgentPersistedContent[]): UserMessage['content'] {
  const parts = content.flatMap((part): Array<TextContent | ImageContent> => {
    if (part.type === 'image') return [];
    if (part.type === 'text') return [{ type: 'text', text: part.text }];
    return [{ type: 'text', text: persistedContentSummary(part) }];
  });
  return parts.length > 0 ? parts : textContent('');
}

function toToolResultContent(content: AgentPersistedContent[]): ToolResultMessage['content'] {
  return toVisibleContent(content);
}

function toAssistantContent(content: AgentPersistedContent[]): AssistantMessage['content'] {
  return content.flatMap((part): Array<TextContent | ThinkingContent | ToolCall> => {
    if (part.type === 'text') return [{ type: 'text', text: part.text }];
    if (part.type === 'thinking') return [{ type: 'thinking', thinking: part.thinking, redacted: part.redacted }];
    if (part.type === 'toolCall') {
      return [{
        type: 'toolCall',
        id: part.id,
        name: part.name,
        arguments: part.arguments,
      }];
    }
    return [{ type: 'text', text: persistedContentSummary(part) }];
  });
}

function toVisibleContent(content: AgentPersistedContent[]): Array<TextContent | ImageContent> {
  const parts = content.map((part): TextContent | ImageContent => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    return { type: 'text', text: persistedContentSummary(part) };
  });
  return parts.length > 0 ? parts : textContent('');
}

function persistedContentSummary(content: AgentPersistedContent): string {
  if (content.type === 'text') return content.text;
  if (content.type === 'thinking') return content.thinking;
  if (content.type === 'toolCall') return `[tool:${content.name}]`;
  if (content.type === 'image') return content.alt || content.imageRef.summary || `[image:${content.imageRef.id}]`;
  return content.label || content.payload.summary || `[payload:${content.payload.id}]`;
}

function payloadRefsFromContent(content: AgentPersistedContent[]): AgentToolResultWithPayloads['payloadRefs'] {
  const refs = content.flatMap((part, index) => {
    if (part.type !== 'payload_ref') return [];
    return [{
      contentIndex: index,
      payload: part.payload,
      label: part.label,
    }];
  });
  return refs.length > 0 ? refs : undefined;
}

function normalizeStopReason(value: string | undefined): AssistantMessage['stopReason'] {
  if (value === 'stop' || value === 'length' || value === 'toolUse' || value === 'error' || value === 'aborted') {
    return value;
  }
  return 'stop';
}

export interface AgentRuntimeClient {
  restoreLatestConversation: () => Promise<AgentConversation>;
  restoreConversation: (conversationId: string) => Promise<AgentConversation>;
  /** Durably mark a conversation read (genuine user open / active+focused view). */
  markConversationRead: (conversationId: string) => Promise<void>;
  createConversation: (options: AgentCreateConversationOptions) => Promise<AgentConversation>;
  closeConversation: (conversationId: string) => Promise<void>;
  sendMessage: (
    conversationId: string,
    message: string,
    attachments?: AgentMessageAttachmentInput[],
    userViewContext?: AgentUserViewContext | null,
  ) => Promise<void>;
  editMessage: (conversationId: string, nodeId: string, message: string) => Promise<void>;
  regenerateMessage: (conversationId: string, nodeId: string) => Promise<void>;
  retryMessage: (conversationId: string, nodeId: string) => Promise<void>;
  switchBranch: (conversationId: string, nodeId: string) => Promise<void>;
  queueFollowUp: (
    conversationId: string,
    message: string,
    userViewContext?: AgentUserViewContext | null,
  ) => Promise<{ queued: boolean }>;
  clearFollowUp: (conversationId: string) => Promise<void>;
  steerConversation: (conversationId: string, message: string) => Promise<{ queued: boolean }>;
  clearSteer: (conversationId: string) => Promise<void>;
  resolveApproval: (
    conversationId: string,
    requestId: string,
    approved: boolean,
    scope?: AgentApprovalResolutionScope,
  ) => Promise<{ resolved: boolean }>;
  resolveUserQuestion: (
    conversationId: string,
    requestId: string,
    result: AskUserQuestionResult,
  ) => Promise<{ resolved: boolean }>;
  stopRun: (conversationId: string, runId: string) => Promise<{ stopped: boolean }>;
  stopConversation: (conversationId: string) => Promise<void>;
  onEvent: (listener: (event: AgentRuntimeEvent) => void) => (() => void) | null;
}

export interface LinAgentRuntimeView {
  entries: AgentConversationEntry[];
  error: string | null;
  /** Composer run state: drives the composer's stop/steer affordance. */
  runActive: boolean;
  modelApi: string | null;
  modelId: string | null;
  providerId: string | null;
  pendingToolCallIds: Set<string>;
  reasoningLevel: string;
  revision: string;
  conversationId: string | null;
  conversationTitle: string | null;
  conversationCost: number;
  /** Conversation members (user + agent). */
  members: AgentRenderMemberView[];
  /** Folded per-conversation unread count for conversation-list badges. */
  unreadByConversationId: ReadonlyMap<string, number>;
  childRunIds: string[];
  childRuns: Record<string, AgentRenderChildRunEntity>;
  childRunsByParentToolCallId: Map<string, AgentRenderChildRunEntity>;
  pendingApproval: AgentApprovalRequestView | null;
  pendingUserQuestion: AgentUserQuestionPendingView | null;
  toolResults: Map<string, AgentToolResultWithPayloads>;
  turnPhase: AgentTurnPhase;
  selectConversation: (targetConversationId: string) => Promise<void>;
  newConversation: (options: AgentCreateConversationOptions) => Promise<void>;
  openDefaultConversation: () => Promise<void>;
  sendMessage: (
    prompt: string,
    attachments?: AgentMessageAttachmentInput[],
    userViewContext?: AgentUserViewContext | null,
  ) => Promise<void>;
  editMessage: (nodeId: string, prompt: string) => Promise<void>;
  regenerateMessage: (nodeId: string) => Promise<void>;
  retryMessage: (nodeId: string) => Promise<void>;
  switchBranch: (nodeId: string) => Promise<void>;
  queueFollowUp: (prompt: string, userViewContext?: AgentUserViewContext | null) => Promise<boolean>;
  clearFollowUp: () => Promise<void>;
  steer: (prompt: string) => Promise<boolean>;
  clearSteer: () => Promise<void>;
  resolveApproval: (
    requestId: string,
    approved: boolean,
    scope?: AgentApprovalResolutionScope,
  ) => Promise<boolean>;
  resolveUserQuestion: (requestId: string, result: AskUserQuestionResult) => Promise<boolean>;
  stop: () => void;
  stopRun: (runId: string) => void;
  reset: () => void;
  reloadConversation: () => Promise<void>;
  seedUserMessage: (message: string) => UserMessage;
}

const defaultAgentRuntimeClient: AgentRuntimeClient = {
  restoreLatestConversation: () => api.agentRestoreLatestConversation(),
  restoreConversation: (conversationId) => api.agentRestoreConversation(conversationId),
  markConversationRead: (conversationId) => api.agentMarkConversationRead(conversationId),
  createConversation: (options) => api.agentCreateConversation(options),
  closeConversation: (conversationId) => api.agentCloseConversation(conversationId),
  sendMessage: (conversationId, message, attachments = [], userViewContext = null) =>
    api.agentSendMessage(conversationId, message, attachments, userViewContext),
  editMessage: (conversationId, nodeId, message) => api.agentEditMessage(conversationId, nodeId, message),
  regenerateMessage: (conversationId, nodeId) => api.agentRegenerateMessage(conversationId, nodeId),
  retryMessage: (conversationId, nodeId) => api.agentRetryMessage(conversationId, nodeId),
  switchBranch: (conversationId, nodeId) => api.agentSwitchBranch(conversationId, nodeId),
  queueFollowUp: (conversationId, message, userViewContext = null) =>
    api.agentQueueFollowUp(conversationId, message, userViewContext),
  clearFollowUp: (conversationId) => api.agentClearFollowUp(conversationId),
  steerConversation: (conversationId, message) => api.agentSteerConversation(conversationId, message),
  clearSteer: (conversationId) => api.agentClearSteer(conversationId),
  resolveApproval: (conversationId, requestId, approved, scope = 'once') =>
    api.agentResolveApproval(conversationId, requestId, approved, scope),
  resolveUserQuestion: (conversationId, requestId, result) =>
    api.agentResolveUserQuestion(conversationId, requestId, result),
  stopRun: (conversationId, runId) => api.agentStopRun(conversationId, runId),
  stopConversation: (conversationId) => api.agentStopConversation(conversationId),
  onEvent: (listener) => typeof window === 'undefined' ? null : window.lin?.onAgentEvent(listener) ?? null,
};

const LAST_CONVERSATION_STORAGE_KEY = 'lin-outliner:agent-last-conversation:v1';

export interface AgentConversationPreferenceStore {
  readLastConversationId(): string | null;
  writeLastConversationId(conversationId: string | null): void;
}

function browserConversationPreferenceStore(): AgentConversationPreferenceStore | null {
  if (typeof window === 'undefined') return null;
  return {
    readLastConversationId: () => {
      try {
        const value = window.localStorage.getItem(LAST_CONVERSATION_STORAGE_KEY);
        return value && value.trim() ? value : null;
      } catch {
        return null;
      }
    },
    writeLastConversationId: (conversationId) => {
      try {
        if (conversationId && conversationId.trim()) {
          window.localStorage.setItem(LAST_CONVERSATION_STORAGE_KEY, conversationId);
        } else {
          window.localStorage.removeItem(LAST_CONVERSATION_STORAGE_KEY);
        }
      } catch {
        // Best-effort UI preference; failing to persist should not block chat.
      }
    },
  };
}

export interface AgentRuntimeStoreOptions {
  conversationPreferenceStore?: AgentConversationPreferenceStore | null;
}

export class AgentRuntimeStore {
  private readonly listeners = new Set<() => void>();
  private projection: AgentRenderProjection = EMPTY_PROJECTION;
  private conversationId: string | null = null;
  private error: string | null = null;
  private readonly pendingApprovals = new Map<string, AgentApprovalRequestView>();
  private pendingApprovalOrder: string[] = [];
  private readonly pendingUserQuestions = new Map<string, AgentUserQuestionPendingView>();
  private pendingUserQuestionOrder: string[] = [];
  private readonly unreadByConversationId = new Map<string, number>();
  // Whether the agent dock is actually open (not the CSS-collapsed seed). The dock
  // keeps the panel mounted + the conversation loaded when collapsed, so "a
  // conversation is loaded" is NOT "the user is viewing it" — mark-read gates on this.
  private dockVisible = false;
  private restorePromise: Promise<string> | null = null;
  private requestVersion = 0;
  private started = false;
  private view: LinAgentRuntimeView;
  private toolResultsCache: {
    messages: Record<string, AgentRenderMessageEntity>;
    toolEntities: Map<string, AgentRenderMessageEntity>;
    toolResults: Map<string, AgentToolResultWithPayloads>;
  } | null = null;
  private projectionPatchReloadPromise: Promise<void> | null = null;
  private pendingToolCallCache: {
    ids: readonly string[];
    set: Set<string>;
  } | null = null;
  private childRunParentCache: {
    childRuns: Record<string, AgentRenderChildRunEntity>;
    map: Map<string, AgentRenderChildRunEntity>;
  } | null = null;
  private readonly conversationPreferenceStore: AgentConversationPreferenceStore | null;

  constructor(
    private readonly client: AgentRuntimeClient,
    options: AgentRuntimeStoreOptions = {},
  ) {
    this.conversationPreferenceStore = options.conversationPreferenceStore ?? null;
    this.view = this.buildView();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.start();
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.view;

  selectConversation = async (targetConversationId: string) => {
    if (!targetConversationId || targetConversationId === this.conversationId) return;
    const requestVersion = this.beginConversationRequest();
    this.conversationId = targetConversationId;
    this.projection = EMPTY_PROJECTION;
    this.error = null;
    this.clearPendingApprovalState();
    this.publish();
    try {
      const conversation = await this.client.restoreConversation(targetConversationId);
      if (!this.isCurrentRequest(requestVersion)) return;
      this.hydrateConversation(conversation);
      // Genuine open → clear its unread, but only if the dock is actually open (a
      // banner click can route here while collapsed). No-op if nothing unread.
      this.markCurrentConversationReadIfViewing();
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  newConversation = async (options: AgentCreateConversationOptions) => {
    const requestVersion = this.beginConversationRequest();
    this.conversationId = null;
    this.projection = EMPTY_PROJECTION;
    this.error = null;
    this.clearPendingApprovalState();
    this.publish();
    try {
      const conversation = await this.client.createConversation(options);
      if (!this.isCurrentRequest(requestVersion)) return;
      this.hydrateConversation(conversation);
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  openDefaultConversation = async () => {
    const requestVersion = this.beginConversationRequest();
    this.conversationId = null;
    this.projection = EMPTY_PROJECTION;
    this.error = null;
    this.restorePromise = null;
    this.clearPendingApprovalState();
    this.publish();
    try {
      const conversation = await this.restoreDefaultConversation();
      if (!this.isCurrentRequest(requestVersion)) return;
      this.hydrateConversation(conversation);
      // Reveal the default/latest conversation → clear unread only if actually viewed.
      this.markCurrentConversationReadIfViewing();
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  sendMessage = async (
    prompt: string,
    attachments: AgentMessageAttachmentInput[] = [],
    userViewContext: AgentUserViewContext | null = null,
  ) => {
    const trimmed = prompt.trim();
    if (!trimmed && attachments.length === 0) return;
    try {
      const currentConversationId = await this.ensureConversation();
      await this.client.sendMessage(currentConversationId, trimmed, attachments, userViewContext);
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  editMessage = async (nodeId: string, prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed || !this.conversationId) return;
    try {
      await this.client.editMessage(this.conversationId, nodeId, trimmed);
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  regenerateMessage = async (nodeId: string) => {
    if (!this.conversationId) return;
    try {
      await this.client.regenerateMessage(this.conversationId, nodeId);
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  retryMessage = async (nodeId: string) => {
    if (!this.conversationId) return;
    try {
      await this.client.retryMessage(this.conversationId, nodeId);
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  switchBranch = async (nodeId: string) => {
    if (!this.conversationId) return;
    try {
      await this.client.switchBranch(this.conversationId, nodeId);
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  queueFollowUp = async (prompt: string, userViewContext: AgentUserViewContext | null = null) => {
    const trimmed = prompt.trim();
    if (!trimmed) return false;
    try {
      const currentConversationId = await this.ensureConversation();
      const result = await this.client.queueFollowUp(currentConversationId, trimmed, userViewContext);
      return result.queued;
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  clearFollowUp = async () => {
    if (!this.conversationId) return;
    try {
      await this.client.clearFollowUp(this.conversationId);
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  steer = async (prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed) return false;
    try {
      const currentConversationId = await this.ensureConversation();
      const result = await this.client.steerConversation(currentConversationId, trimmed);
      return result.queued;
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  clearSteer = async () => {
    if (!this.conversationId) return;
    try {
      await this.client.clearSteer(this.conversationId);
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  resolveApproval = async (
    requestId: string,
    approved: boolean,
    scope: AgentApprovalResolutionScope = 'once',
  ) => {
    if (!this.conversationId) return false;
    try {
      const result = await this.client.resolveApproval(this.conversationId, requestId, approved, scope);
      if (result.resolved && this.pendingApprovals.has(requestId)) {
        this.removePendingApproval(requestId);
        this.publish();
      }
      return result.resolved;
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  resolveUserQuestion = async (requestId: string, result: AskUserQuestionResult) => {
    if (!this.conversationId) return false;
    try {
      const resolved = await this.client.resolveUserQuestion(this.conversationId, requestId, result);
      if (resolved.resolved && this.pendingUserQuestions.has(requestId)) {
        this.removePendingUserQuestion(requestId);
        this.publish();
      }
      return resolved.resolved;
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  stop = () => {
    if (!this.conversationId) return;
    void this.client.stopConversation(this.conversationId).catch((caught) => {
      this.reportError(caught);
    });
  };

  stopRun = (runId: string) => {
    if (!this.conversationId) return;
    void this.client.stopRun(this.conversationId, runId).catch((caught) => {
      this.reportError(caught);
    });
  };

  reset = () => {
    void this.openDefaultConversation();
  };

  reloadConversation = async () => {
    const currentConversationId = this.conversationId;
    const requestVersion = this.beginConversationRequest();
    this.error = null;
    this.clearPendingApprovalState();
    // Keep the CURRENT projection on screen while a same-conversation reload re-fetches
    // (e.g. after a model/reasoning config change, which doesn't alter the transcript).
    // Blanking to EMPTY_PROJECTION + publish here flashed the whole transcript empty for
    // one frame before re-hydrating — the dock flicker seen on every reasoning toggle.
    // hydrateConversation swaps in the fresh projection atomically below. Only the cold path
    // (no conversation yet) legitimately shows empty while a conversation is established.
    if (!currentConversationId) {
      this.projection = EMPTY_PROJECTION;
    }
    this.publish();
    try {
      if (currentConversationId) {
        const conversation = await this.client.restoreConversation(currentConversationId);
        if (this.isCurrentRequest(requestVersion)) this.hydrateConversation(conversation);
        return;
      }
      await this.ensureConversation();
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  seedUserMessage = (message: string): UserMessage => ({
    role: 'user',
    content: textContent(message),
    timestamp: Date.now(),
  });

  private start() {
    if (this.started) return;
    this.started = true;
    this.client.onEvent(this.handleEvent);
    void this.ensureConversation().catch((caught) => {
      this.reportError(caught);
    });
  }

  /**
   * Report whether the agent dock is actually open. The dock keeps the panel mounted
   * when collapsed, so this is the authority on "the user can see the conversation".
   * Opening the dock reads the conversation it reveals.
   */
  setDockVisible = (visible: boolean) => {
    if (this.dockVisible === visible) return;
    this.dockVisible = visible;
    if (visible) this.markCurrentConversationReadIfViewing();
  };

  /**
   * Durably clear the displayed conversation's unread IFF the user can actually see
   * it — i.e. the dock is open (not the CSS-collapsed seed). The window-focus
   * dimension is owned by main's OS-banner suppression, not the durable read cursor:
   * the badge for the current conversation is masked anyway, so clearing only governs
   * whether it resurfaces on the next restart, and a conversation open in the dock has
   * been seen. `markConversationRead` is a no-op in main when nothing is unread, so
   * this is cheap to over-call and correct even for the (unlisted) default DM.
   */
  markCurrentConversationReadIfViewing = () => {
    const conversationId = this.conversationId;
    if (!conversationId) return;
    if (!this.dockVisible) return;
    void this.client.markConversationRead(conversationId);
  };

  private ensureConversation() {
    if (this.conversationId) return Promise.resolve(this.conversationId);
    if (!this.restorePromise) {
      const requestVersion = this.requestVersion;
      this.restorePromise = this.restoreInitialConversation(requestVersion)
        .catch((caught) => {
          this.restorePromise = null;
          throw caught;
        });
    }
    return this.restorePromise;
  }

  private async restoreInitialConversation(requestVersion: number): Promise<string> {
    const rememberedConversationId = this.conversationPreferenceStore?.readLastConversationId();
    if (rememberedConversationId) {
      try {
        return await this.restoreInitialConversationById(rememberedConversationId, requestVersion);
      } catch {
        if (!this.isCurrentRequest(requestVersion)) {
          return this.conversationId ?? rememberedConversationId;
        }
        this.conversationPreferenceStore?.writeLastConversationId(null);
      }
    }

    const conversation = await this.restoreDefaultConversation();
    if (!this.isCurrentRequest(requestVersion)) {
      return this.conversationId ?? conversation.conversationId;
    }
    this.hydrateConversation(conversation);
    // Startup may reveal this conversation → clear its unread only if the dock
    // is actually open + focused (setDockVisible re-checks once the App reports
    // the rail state, covering the mount-order race).
    this.markCurrentConversationReadIfViewing();
    return conversation.conversationId;
  }

  private async restoreDefaultConversation(): Promise<AgentConversation> {
    try {
      return await this.client.restoreConversation(DEFAULT_GENERAL_CHANNEL_ID);
    } catch {
      return this.client.restoreLatestConversation();
    }
  }

  private async restoreInitialConversationById(
    conversationId: string,
    requestVersion: number,
  ): Promise<string> {
    const conversation = await this.client.restoreConversation(conversationId);
    if (!this.isCurrentRequest(requestVersion)) {
      return this.conversationId ?? conversation.conversationId;
    }
    this.hydrateConversation(conversation);
    this.markCurrentConversationReadIfViewing();
    return conversation.conversationId;
  }

  private hydrateConversation(conversation: AgentConversation) {
    this.conversationId = conversation.conversationId;
    this.projection = conversation.renderProjection;
    this.error = conversation.renderProjection.errorMessage;
    this.clearPendingApprovalState();
    if (conversation.pendingUserQuestion) this.addPendingUserQuestion(conversation.pendingUserQuestion);
    this.conversationPreferenceStore?.writeLastConversationId(conversation.conversationId);
    this.publish();
  }

  private handleEvent = (payload: AgentRuntimeEvent) => {
    if (payload.type === 'ready') return;

    if (payload.type === 'closed') {
      if (payload.conversationId === this.conversationId) {
        this.beginConversationRequest();
        this.conversationId = null;
        this.restorePromise = null;
        this.projection = EMPTY_PROJECTION;
        this.error = null;
        this.clearPendingApprovalState();
        this.conversationPreferenceStore?.writeLastConversationId(null);
        this.publish();
      }
      return;
    }

    if (payload.type === 'error') {
      if (!this.conversationId || payload.conversationId === this.conversationId) {
        this.error = payload.error;
        this.publish();
      }
      return;
    }

    if (payload.type === 'approval_request') {
      if (!this.conversationId) {
        this.conversationId = payload.conversationId;
      }
      if (payload.conversationId !== this.conversationId) return;
      this.addPendingApproval(payload.request);
      this.publish();
      return;
    }

    if (payload.type === 'approval_resolved') {
      if (payload.conversationId !== this.conversationId) return;
      if (this.pendingApprovals.has(payload.requestId)) {
        this.removePendingApproval(payload.requestId);
        this.publish();
      }
      return;
    }

    if (payload.type === 'user_question_request') {
      if (!this.conversationId) {
        this.conversationId = payload.conversationId;
      }
      if (payload.conversationId !== this.conversationId) return;
      this.addPendingUserQuestion(payload.question);
      this.publish();
      return;
    }

    if (payload.type === 'user_question_resolved') {
      if (payload.conversationId !== this.conversationId) return;
      if (this.pendingUserQuestions.has(payload.requestId)) {
        this.removePendingUserQuestion(payload.requestId);
        this.publish();
      }
      return;
    }

    if (payload.type === 'conversation_attention') {
      // Cross-conversation: badges track every conversation, not just the active one.
      const previous = this.unreadByConversationId.get(payload.conversationId) ?? 0;
      if (payload.unreadCount > 0) {
        this.unreadByConversationId.set(payload.conversationId, payload.unreadCount);
      } else {
        this.unreadByConversationId.delete(payload.conversationId);
      }
      if (previous !== payload.unreadCount) this.publish();
      // A task delivered into the conversation the user is actively viewing (dock
      // open + window focused) is already seen — clear it durably so it does not
      // resurface as a stale badge on the next restart. The UI masks the live badge
      // for the current conversation; this keeps the persisted state in step.
      if (payload.unreadCount > 0 && payload.conversationId === this.conversationId) {
        this.markCurrentConversationReadIfViewing();
      }
      return;
    }

    if (payload.type === 'projection') {
      if (!this.conversationId) {
        this.conversationId = payload.conversationId;
      }
      if (payload.conversationId !== this.conversationId) return;
      this.projection = payload.renderProjection;
      this.error = payload.renderProjection.errorMessage;
      this.publish();
      return;
    }

    if (payload.type === 'projection_patch') {
      if (!this.conversationId) {
        this.conversationId = payload.conversationId;
      }
      if (payload.conversationId !== this.conversationId) return;
      const previousProjection = this.projection;
      const nextProjection = applyAgentRenderProjectionPatch(this.projection, payload.patch);
      if (!nextProjection) {
        this.reloadAfterProjectionPatchMismatch();
        return;
      }
      const toolResultsCache = this.toolResultsCache;
      if (
        toolResultsCache
        && patchLeavesToolResultsUnchanged(previousProjection, payload.patch)
      ) {
        this.toolResultsCache = {
          ...toolResultsCache,
          messages: nextProjection.entities.messages,
        };
      }
      this.projection = nextProjection;
      this.error = nextProjection.errorMessage;
      this.publish();
    }
  };

  private beginConversationRequest() {
    this.requestVersion += 1;
    this.restorePromise = null;
    return this.requestVersion;
  }

  private isCurrentRequest(requestVersion: number) {
    return requestVersion === this.requestVersion;
  }

  private reportError(caught: unknown) {
    this.error = caught instanceof Error ? caught.message : String(caught);
    this.publish();
  }

  private publish() {
    this.view = this.buildView();
    for (const listener of this.listeners) {
      listener();
    }
  }

  private reloadAfterProjectionPatchMismatch() {
    if (this.projectionPatchReloadPromise) return;
    const reload = this.reloadConversation()
      .catch((caught) => this.reportError(caught))
      .finally(() => {
        if (this.projectionPatchReloadPromise === reload) {
          this.projectionPatchReloadPromise = null;
        }
      });
    this.projectionPatchReloadPromise = reload;
  }

  private toolResultsForProjection(): Map<string, AgentToolResultWithPayloads> {
    if (this.toolResultsCache?.messages === this.projection.entities.messages) {
      return this.toolResultsCache.toolResults;
    }
    const toolEntities = new Map<string, AgentRenderMessageEntity>();
    for (const entity of Object.values(this.projection.entities.messages)) {
      if (entity.role === 'toolResult') toolEntities.set(entity.id, entity);
    }
    if (this.toolResultsCache && mapsHaveSameEntityValues(this.toolResultsCache.toolEntities, toolEntities)) {
      this.toolResultsCache = {
        ...this.toolResultsCache,
        messages: this.projection.entities.messages,
      };
      return this.toolResultsCache.toolResults;
    }
    const toolResults = buildToolResultMap(this.projection);
    this.toolResultsCache = { messages: this.projection.entities.messages, toolEntities, toolResults };
    return toolResults;
  }

  private pendingToolCallSetForProjection(): Set<string> {
    const ids = this.projection.pendingToolCallIds;
    if (this.pendingToolCallCache?.ids === ids) return this.pendingToolCallCache.set;
    const set = new Set(ids);
    this.pendingToolCallCache = { ids, set };
    return set;
  }

  private childRunsByParentToolCallIdForProjection(
    childRuns: Record<string, AgentRenderChildRunEntity>,
  ): Map<string, AgentRenderChildRunEntity> {
    if (this.childRunParentCache?.childRuns === childRuns) return this.childRunParentCache.map;
    const map = new Map<string, AgentRenderChildRunEntity>();
    for (const childRun of Object.values(childRuns)) {
      if (childRun.parentToolCallId) map.set(childRun.parentToolCallId, childRun);
    }
    this.childRunParentCache = { childRuns, map };
    return map;
  }

  private buildView(): LinAgentRuntimeView {
    const toolResults = this.toolResultsForProjection();
    const { entries, turnPhase } = buildEntries(this.projection, toolResults);
    const childRuns = this.projection.entities.childRuns ?? {};
    const childRunsByParentToolCallId = this.childRunsByParentToolCallIdForProjection(childRuns);
    return {
      entries,
      error: this.error,
      runActive: this.projection.runActive,
      modelApi: projectionModelValue(this.projection, 'api'),
      modelId: projectionModelValue(this.projection, 'id'),
      providerId: projectionModelValue(this.projection, 'provider'),
      pendingToolCallIds: this.pendingToolCallSetForProjection(),
      reasoningLevel: this.projection.thinkingLevel,
      revision: `${this.conversationId ?? 'pending'}-${this.projection.revision}-${this.projection.rows.length}-${this.projection.transcriptRows.length}-${this.projection.pendingToolCallIds.join(',')}`,
      conversationId: this.conversationId,
      conversationTitle: this.projection.conversationTitle,
      conversationCost: conversationCost(this.projection),
      // Defensive fallback: a projection from a mock/older main process without
      // `members` must not crash the panel at mount. The shared empty constant
      // keeps the reference stable across rebuilds so member-derived memos don't
      // recompute on every projection tick.
      members: this.projection.members ?? EMPTY_MEMBERS,
      unreadByConversationId: new Map(this.unreadByConversationId),
      childRunIds: this.projection.childRunIds,
      childRuns,
      childRunsByParentToolCallId,
      pendingApproval: this.currentPendingApproval(),
      pendingUserQuestion: this.currentPendingUserQuestion(),
      toolResults,
      turnPhase,
      selectConversation: this.selectConversation,
      newConversation: this.newConversation,
      openDefaultConversation: this.openDefaultConversation,
      sendMessage: this.sendMessage,
      editMessage: this.editMessage,
      regenerateMessage: this.regenerateMessage,
      retryMessage: this.retryMessage,
      switchBranch: this.switchBranch,
      queueFollowUp: this.queueFollowUp,
      clearFollowUp: this.clearFollowUp,
      steer: this.steer,
      clearSteer: this.clearSteer,
      resolveApproval: this.resolveApproval,
      resolveUserQuestion: this.resolveUserQuestion,
      stop: this.stop,
      stopRun: this.stopRun,
      reset: this.reset,
      reloadConversation: this.reloadConversation,
      seedUserMessage: this.seedUserMessage,
    };
  }

  private addPendingApproval(request: AgentApprovalRequestView) {
    if (!this.pendingApprovals.has(request.requestId)) {
      this.pendingApprovalOrder.push(request.requestId);
    }
    this.pendingApprovals.set(request.requestId, request);
  }

  private removePendingApproval(requestId: string) {
    this.pendingApprovals.delete(requestId);
    this.pendingApprovalOrder = this.pendingApprovalOrder.filter((id) => id !== requestId);
  }

  private clearPendingApprovalState() {
    this.pendingApprovals.clear();
    this.pendingApprovalOrder = [];
    this.pendingUserQuestions.clear();
    this.pendingUserQuestionOrder = [];
  }

  private currentPendingApproval(): AgentApprovalRequestView | null {
    while (this.pendingApprovalOrder.length > 0) {
      const request = this.pendingApprovals.get(this.pendingApprovalOrder[0]);
      if (request) return request;
      this.pendingApprovalOrder.shift();
    }
    return null;
  }

  private addPendingUserQuestion(question: AgentUserQuestionPendingView) {
    if (!this.pendingUserQuestions.has(question.requestId)) {
      this.pendingUserQuestionOrder.push(question.requestId);
    }
    this.pendingUserQuestions.set(question.requestId, question);
  }

  private removePendingUserQuestion(requestId: string) {
    this.pendingUserQuestions.delete(requestId);
    this.pendingUserQuestionOrder = this.pendingUserQuestionOrder.filter((id) => id !== requestId);
  }

  private currentPendingUserQuestion(): AgentUserQuestionPendingView | null {
    while (this.pendingUserQuestionOrder.length > 0) {
      const question = this.pendingUserQuestions.get(this.pendingUserQuestionOrder[0]);
      if (question) return question;
      this.pendingUserQuestionOrder.shift();
    }
    return null;
  }
}

export function createAgentRuntimeStore(client: AgentRuntimeClient, options: AgentRuntimeStoreOptions = {}) {
  return new AgentRuntimeStore(client, options);
}

export const linAgentRuntimeStore = createAgentRuntimeStore(defaultAgentRuntimeClient, {
  conversationPreferenceStore: browserConversationPreferenceStore(),
});

export function useLinAgentRuntime() {
  return useSyncExternalStore(
    linAgentRuntimeStore.subscribe,
    linAgentRuntimeStore.getSnapshot,
    linAgentRuntimeStore.getSnapshot,
  );
}
