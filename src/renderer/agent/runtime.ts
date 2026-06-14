import { useSyncExternalStore } from 'react';
import { api } from '../api/client';
import { isSystemReminderBlock } from '../../core/agentAttachments';
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
  AgentRenderActivityEntry,
  AgentPovInspectorView,
  AgentRenderCompactionEntity,
  AgentRenderDreamEntity,
  AgentRenderMemberView,
  AgentRenderMessageEntity,
  AgentRenderProjection,
  AgentRenderChildRunEntity,
  AgentRenderTaskEntity,
  AgentRenderTaskStatus,
} from '../../core/agentRenderProjection';
import type { AgentActor, AgentPersistedContent } from '../../core/agentEventLog';

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
  /** Wall-clock the producing run took, for the collapsed "Worked for …" header; null when unknown. */
  runDurationMs: number | null;
  /** The message that addressed this reply, when the projection can derive it. */
  addressedByMessageId: string | null;
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

// A child run surfaced inline in the transcript as a boundary — the permanent
// record of the run in its conversation (its final result lives on the entity).
export interface AgentChildRunEntry {
  id: string;
  kind: 'child-run';
  childRun: AgentRenderChildRunEntity;
}

export type AgentConversationEntry =
  | AgentMessageEntry
  | AgentCompactionEntry
  | AgentDreamEntry
  | AgentChildRunEntry;

export type AgentTurnPhase = 'idle' | 'streaming_text' | 'waiting_for_tool' | 'resuming_after_tool';

export type AgentTaskEntry =
  | (Extract<AgentRenderTaskEntity, { kind: 'child-run' }> & { childRun: AgentRenderChildRunEntity })
  | Extract<AgentRenderTaskEntity, { kind: 'dream' }>;

const EMPTY_PROJECTION: AgentRenderProjection = {
  conversationId: '',
  revision: 0,
  conversationTitle: null,
  members: [],
  activeRuns: [],
  activeRunId: null,
  channelActivityEntries: [],
  povInspectors: {},
  activeCompaction: null,
  activeDream: null,
  dmRunActive: false,
  channelRunsActive: false,
  model: {},
  thinkingLevel: 'off',
  pendingToolCallIds: [],
  errorMessage: null,
  rows: [],
  transcriptRows: [],
  taskIds: [],
  childRunIds: [],
  entities: { messages: {}, childRuns: {}, compactions: {}, dreams: {}, tasks: {} },
  dmStreaming: null,
};

const EMPTY_MEMBERS: AgentRenderMemberView[] = [];
const EMPTY_ACTIVITY_ENTRIES: AgentRenderActivityEntry[] = [];
const EMPTY_POV_INSPECTORS: Record<string, AgentPovInspectorView> = {};

const EMPTY_USAGE: Usage = {
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
      const childRun = projection.entities.childRuns[row.childRunId];
      if (childRun) entries.push({ id: row.id, kind: 'child-run', childRun });
      continue;
    }

    const entity = projection.entities.messages[row.messageId];
    if (!entity || (entity.role !== 'user' && entity.role !== 'assistant')) continue;
    if (entity.role === 'user' && isHiddenOnlySystemReminder(entity)) continue;
    const streaming = projection.dmStreaming?.messageId === entity.id;
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
      runDurationMs: entity.runDurationMs ?? null,
      addressedByMessageId: entity.addressedByMessageId ?? null,
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
  if (projection.dmRunActive) {
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
    && projection.dmRunActive
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
      runDurationMs: null,
      addressedByMessageId: null,
    });
  }

  return { entries, turnPhase };
}

const TASK_STATUS_RANK: Record<AgentRenderTaskStatus, number> = {
  running: 0,
  failed: 1,
  stopped: 2,
  completed: 3,
};

export function buildAgentTaskEntries(projection: AgentRenderProjection): AgentTaskEntry[] {
  const tasks = projection.taskIds.flatMap((id): AgentTaskEntry[] => {
    const task = projection.entities.tasks[id];
    if (!task) return [];
    if (task.kind === 'child-run') {
      const childRun = projection.entities.childRuns[task.childRunId];
      if (!childRun) return [];
      return [{ ...task, childRun }];
    }
    return [{ ...task }];
  });

  return tasks.sort((left, right) => (
    TASK_STATUS_RANK[left.status] - TASK_STATUS_RANK[right.status]
    || right.updatedAt - left.updatedAt
    || left.id.localeCompare(right.id)
  ));
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
  return {
    role: 'assistant',
    content: [],
    api: projectionModelValue(projection, 'api') ?? '',
    provider: projectionModelValue(projection, 'provider') ?? '',
    model: projectionModelValue(projection, 'id') ?? '',
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp: activeAssistantAnchorTimestamp(entries, projection),
  };
}

function textContent(text: string): TextContent[] {
  return [{ type: 'text', text }];
}

function projectionModelValue(projection: AgentRenderProjection, key: string): string | null {
  const value = projection.model[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function conversationCost(projection: AgentRenderProjection): number {
  return Object.values(projection.entities.messages).reduce((total, message) => {
    if (message.role !== 'assistant') return total;
    return total + (message.usage?.cost?.total ?? 0);
  }, 0);
}

function conversationMessageFromEntity(entity: AgentRenderMessageEntity): AgentConversationMessage {
  if (entity.role === 'user') {
    return {
      role: 'user',
      content: toUserContent(entity.content),
      timestamp: entity.createdAt,
    };
  }
  return {
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

function toolResultFromEntity(entity: AgentRenderMessageEntity): AgentToolResultWithPayloads {
  return {
    role: 'toolResult',
    toolCallId: entity.toolCallId ?? entity.id,
    toolName: entity.toolName ?? 'unknown',
    content: toToolResultContent(entity.content),
    payloadRefs: payloadRefsFromContent(entity.content),
    isError: !!entity.isError,
    timestamp: entity.createdAt,
  };
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
  /** DM (or single-agent) composer run state: drives the composer's stop/steer affordance. Always false in a multi-agent Channel. */
  dmRunActive: boolean;
  /** True while any addressed Channel run is active or pending (the async work surface). */
  channelRunsActive: boolean;
  modelId: string | null;
  providerId: string | null;
  pendingToolCallIds: Set<string>;
  reasoningLevel: string;
  revision: string;
  conversationId: string | null;
  conversationTitle: string | null;
  conversationCost: number;
  /** Conversation members (user + agents); Channel rows are named rooms, DMs are canonical one-agent rows. */
  members: AgentRenderMemberView[];
  /** Per-run Channel activity: one entry per active or pending addressed run (the async work surface). */
  channelActivityEntries: AgentRenderActivityEntry[];
  /** Read-only per-agent Channel POV projections keyed by agentId. */
  povInspectors: Record<string, AgentPovInspectorView>;
  /** Folded per-conversation unread count for conversation-list badges. */
  unreadByConversationId: ReadonlyMap<string, number>;
  tasks: AgentTaskEntry[];
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

  constructor(private readonly client: AgentRuntimeClient) {
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
    const previousConversationId = this.conversationId;
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
      await this.closePreviousConversation(previousConversationId, conversation.conversationId);
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  newConversation = async (options: AgentCreateConversationOptions) => {
    const previousConversationId = this.conversationId;
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
      await this.closePreviousConversation(previousConversationId, conversation.conversationId);
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  openDefaultConversation = async () => {
    const previousConversationId = this.conversationId;
    const requestVersion = this.beginConversationRequest();
    this.conversationId = null;
    this.projection = EMPTY_PROJECTION;
    this.error = null;
    this.restorePromise = null;
    this.clearPendingApprovalState();
    this.publish();
    try {
      const conversation = await this.client.restoreLatestConversation();
      if (!this.isCurrentRequest(requestVersion)) return;
      this.hydrateConversation(conversation);
      // Reveal the default/latest conversation → clear unread only if actually viewed.
      this.markCurrentConversationReadIfViewing();
      await this.closePreviousConversation(previousConversationId, conversation.conversationId);
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
      this.restorePromise = this.client.restoreLatestConversation()
        .then((conversation) => {
          if (!this.isCurrentRequest(requestVersion)) {
            return this.conversationId ?? conversation.conversationId;
          }
          this.hydrateConversation(conversation);
          // Startup may reveal this conversation → clear its unread only if the dock
          // is actually open + focused (setDockVisible re-checks once the App reports
          // the rail state, covering the mount-order race).
          this.markCurrentConversationReadIfViewing();
          return conversation.conversationId;
        })
        .catch((caught) => {
          this.restorePromise = null;
          throw caught;
        });
    }
    return this.restorePromise;
  }

  private hydrateConversation(conversation: AgentConversation) {
    this.conversationId = conversation.conversationId;
    this.projection = conversation.renderProjection;
    this.error = conversation.renderProjection.errorMessage;
    this.clearPendingApprovalState();
    if (conversation.pendingUserQuestion) this.addPendingUserQuestion(conversation.pendingUserQuestion);
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
    }
  };

  private async closePreviousConversation(previousConversationId: string | null, nextConversationId: string) {
    if (!previousConversationId || previousConversationId === nextConversationId) return;
    await this.client.closeConversation(previousConversationId);
  }

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

  private buildView(): LinAgentRuntimeView {
    const toolResults = buildToolResultMap(this.projection);
    const { entries, turnPhase } = buildEntries(this.projection, toolResults);
    const childRuns = this.projection.entities.childRuns ?? {};
    const childRunsByParentToolCallId = new Map<string, AgentRenderChildRunEntity>();
    for (const childRun of Object.values(childRuns)) {
      if (childRun.parentToolCallId) childRunsByParentToolCallId.set(childRun.parentToolCallId, childRun);
    }
    return {
      entries,
      error: this.error,
      dmRunActive: this.projection.dmRunActive,
      channelRunsActive: this.projection.channelRunsActive,
      modelId: projectionModelValue(this.projection, 'id'),
      providerId: projectionModelValue(this.projection, 'provider'),
      pendingToolCallIds: new Set(this.projection.pendingToolCallIds),
      reasoningLevel: this.projection.thinkingLevel,
      revision: `${this.conversationId ?? 'pending'}-${this.projection.revision}-${this.projection.rows.length}-${this.projection.transcriptRows.length}-${this.projection.pendingToolCallIds.join(',')}`,
      conversationId: this.conversationId,
      conversationTitle: this.projection.conversationTitle,
      conversationCost: conversationCost(this.projection),
      // Defensive fallbacks: projections from a mock/older main process without
      // these fields must degrade to a DM view, never crash the panel at mount.
      // The shared empty constants keep the reference stable across rebuilds so
      // member-derived memos don't recompute on every projection tick.
      members: this.projection.members ?? EMPTY_MEMBERS,
      channelActivityEntries: this.projection.channelActivityEntries ?? EMPTY_ACTIVITY_ENTRIES,
      povInspectors: this.projection.povInspectors ?? EMPTY_POV_INSPECTORS,
      unreadByConversationId: new Map(this.unreadByConversationId),
      tasks: buildAgentTaskEntries(this.projection),
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

export function createAgentRuntimeStore(client: AgentRuntimeClient) {
  return new AgentRuntimeStore(client);
}

export const linAgentRuntimeStore = createAgentRuntimeStore(defaultAgentRuntimeClient);

export function useLinAgentRuntime() {
  return useSyncExternalStore(
    linAgentRuntimeStore.subscribe,
    linAgentRuntimeStore.getSnapshot,
    linAgentRuntimeStore.getSnapshot,
  );
}
