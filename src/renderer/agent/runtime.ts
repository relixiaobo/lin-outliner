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
  AgentUserViewContext,
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from '../../core/agentTypes';
import type { AgentSession } from '../../core/types';
import type {
  AgentRenderActiveCompaction,
  AgentRenderCompactionEntity,
  AgentRenderMessageEntity,
  AgentRenderProjection,
  AgentRenderSubagentEntity,
} from '../../core/agentRenderProjection';
import type { AgentPersistedContent } from '../../core/agentEventLog';

export interface AgentMessageEntry {
  id: string;
  kind: 'message';
  nodeId: string | null;
  message: AgentConversationMessage;
  branches: AgentMessageBranchState | null;
  streaming: boolean;
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

export type AgentConversationEntry = AgentMessageEntry | AgentCompactionEntry;

export type AgentTurnPhase = 'idle' | 'streaming_text' | 'waiting_for_tool' | 'resuming_after_tool';

const EMPTY_PROJECTION: AgentRenderProjection = {
  sessionId: '',
  revision: 0,
  sessionTitle: null,
  activeRunId: null,
  activeCompaction: null,
  isStreaming: false,
  model: {},
  thinkingLevel: 'off',
  pendingToolCallIds: [],
  errorMessage: null,
  rows: [],
  transcriptRows: [],
  subagentRunIds: [],
  entities: { messages: {}, subagents: {}, compactions: {} },
  streaming: null,
};

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

  let turnPhase: AgentTurnPhase = 'idle';
  const streamingEntry = entries.find((entry): entry is AgentMessageEntry => (
    entry.kind === 'message' && entry.streaming && entry.message.role === 'assistant'
  ));
  if (projection.isStreaming) {
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
    && projection.isStreaming
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
    .map((row) => projection.entities.messages[row.messageId])
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

function sessionCost(projection: AgentRenderProjection): number {
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
  const parts = toVisibleContent(content);
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
  restoreLatestSession: () => Promise<AgentSession>;
  restoreSession: (sessionId: string) => Promise<AgentSession>;
  createSession: () => Promise<AgentSession>;
  closeSession: (sessionId: string) => Promise<void>;
  sendMessage: (
    sessionId: string,
    message: string,
    attachments?: AgentMessageAttachmentInput[],
    userViewContext?: AgentUserViewContext | null,
  ) => Promise<void>;
  editMessage: (sessionId: string, nodeId: string, message: string) => Promise<void>;
  regenerateMessage: (sessionId: string, nodeId: string) => Promise<void>;
  retryMessage: (sessionId: string, nodeId: string) => Promise<void>;
  switchBranch: (sessionId: string, nodeId: string) => Promise<void>;
  queueFollowUp: (
    sessionId: string,
    message: string,
    userViewContext?: AgentUserViewContext | null,
  ) => Promise<{ queued: boolean }>;
  clearFollowUp: (sessionId: string) => Promise<void>;
  steerSession: (sessionId: string, message: string) => Promise<{ queued: boolean }>;
  clearSteer: (sessionId: string) => Promise<void>;
  resolveApproval: (
    sessionId: string,
    requestId: string,
    approved: boolean,
    scope?: AgentApprovalResolutionScope,
  ) => Promise<{ resolved: boolean }>;
  stopSession: (sessionId: string) => Promise<void>;
  onEvent: (listener: (event: AgentRuntimeEvent) => void) => (() => void) | null;
}

export interface LinAgentRuntimeView {
  entries: AgentConversationEntry[];
  error: string | null;
  isStreaming: boolean;
  modelId: string | null;
  providerId: string | null;
  pendingToolCallIds: Set<string>;
  reasoningLevel: string;
  revision: string;
  sessionId: string | null;
  sessionTitle: string | null;
  sessionCost: number;
  subagentRunIds: string[];
  subagents: Record<string, AgentRenderSubagentEntity>;
  subagentsByParentToolCallId: Map<string, AgentRenderSubagentEntity>;
  pendingApproval: AgentApprovalRequestView | null;
  toolResults: Map<string, AgentToolResultWithPayloads>;
  turnPhase: AgentTurnPhase;
  selectSession: (targetSessionId: string) => Promise<void>;
  newSession: () => Promise<void>;
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
  stop: () => void;
  reset: () => void;
  reloadSession: () => Promise<void>;
  seedUserMessage: (message: string) => UserMessage;
}

const defaultAgentRuntimeClient: AgentRuntimeClient = {
  restoreLatestSession: () => api.agentRestoreLatestSession(),
  restoreSession: (sessionId) => api.agentRestoreSession(sessionId),
  createSession: () => api.agentCreateSession(),
  closeSession: (sessionId) => api.agentCloseSession(sessionId),
  sendMessage: (sessionId, message, attachments = [], userViewContext = null) =>
    api.agentSendMessage(sessionId, message, attachments, userViewContext),
  editMessage: (sessionId, nodeId, message) => api.agentEditMessage(sessionId, nodeId, message),
  regenerateMessage: (sessionId, nodeId) => api.agentRegenerateMessage(sessionId, nodeId),
  retryMessage: (sessionId, nodeId) => api.agentRetryMessage(sessionId, nodeId),
  switchBranch: (sessionId, nodeId) => api.agentSwitchBranch(sessionId, nodeId),
  queueFollowUp: (sessionId, message, userViewContext = null) =>
    api.agentQueueFollowUp(sessionId, message, userViewContext),
  clearFollowUp: (sessionId) => api.agentClearFollowUp(sessionId),
  steerSession: (sessionId, message) => api.agentSteerSession(sessionId, message),
  clearSteer: (sessionId) => api.agentClearSteer(sessionId),
  resolveApproval: (sessionId, requestId, approved, scope = 'once') =>
    api.agentResolveApproval(sessionId, requestId, approved, scope),
  stopSession: (sessionId) => api.agentStopSession(sessionId),
  onEvent: (listener) => typeof window === 'undefined' ? null : window.lin?.onAgentEvent(listener) ?? null,
};

export class AgentRuntimeStore {
  private readonly listeners = new Set<() => void>();
  private projection: AgentRenderProjection = EMPTY_PROJECTION;
  private sessionId: string | null = null;
  private error: string | null = null;
  private readonly pendingApprovals = new Map<string, AgentApprovalRequestView>();
  private pendingApprovalOrder: string[] = [];
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

  selectSession = async (targetSessionId: string) => {
    if (!targetSessionId || targetSessionId === this.sessionId) return;
    const previousSessionId = this.sessionId;
    const requestVersion = this.beginSessionRequest();
    this.sessionId = targetSessionId;
    this.projection = EMPTY_PROJECTION;
    this.error = null;
    this.clearPendingApprovalState();
    this.publish();
    try {
      const session = await this.client.restoreSession(targetSessionId);
      if (!this.isCurrentRequest(requestVersion)) return;
      this.hydrateSession(session);
      await this.closePreviousSession(previousSessionId, session.sessionId);
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  newSession = async () => {
    const previousSessionId = this.sessionId;
    const requestVersion = this.beginSessionRequest();
    this.sessionId = null;
    this.projection = EMPTY_PROJECTION;
    this.error = null;
    this.clearPendingApprovalState();
    this.publish();
    try {
      const session = await this.client.createSession();
      if (!this.isCurrentRequest(requestVersion)) return;
      this.hydrateSession(session);
      await this.closePreviousSession(previousSessionId, session.sessionId);
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
      const currentSessionId = await this.ensureSession();
      await this.client.sendMessage(currentSessionId, trimmed, attachments, userViewContext);
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  editMessage = async (nodeId: string, prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed || !this.sessionId) return;
    try {
      await this.client.editMessage(this.sessionId, nodeId, trimmed);
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  regenerateMessage = async (nodeId: string) => {
    if (!this.sessionId) return;
    try {
      await this.client.regenerateMessage(this.sessionId, nodeId);
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  retryMessage = async (nodeId: string) => {
    if (!this.sessionId) return;
    try {
      await this.client.retryMessage(this.sessionId, nodeId);
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  switchBranch = async (nodeId: string) => {
    if (!this.sessionId) return;
    try {
      await this.client.switchBranch(this.sessionId, nodeId);
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  queueFollowUp = async (prompt: string, userViewContext: AgentUserViewContext | null = null) => {
    const trimmed = prompt.trim();
    if (!trimmed) return false;
    try {
      const currentSessionId = await this.ensureSession();
      const result = await this.client.queueFollowUp(currentSessionId, trimmed, userViewContext);
      return result.queued;
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  clearFollowUp = async () => {
    if (!this.sessionId) return;
    try {
      await this.client.clearFollowUp(this.sessionId);
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  steer = async (prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed) return false;
    try {
      const currentSessionId = await this.ensureSession();
      const result = await this.client.steerSession(currentSessionId, trimmed);
      return result.queued;
    } catch (caught) {
      this.reportError(caught);
      throw caught;
    }
  };

  clearSteer = async () => {
    if (!this.sessionId) return;
    try {
      await this.client.clearSteer(this.sessionId);
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
    if (!this.sessionId) return false;
    try {
      const result = await this.client.resolveApproval(this.sessionId, requestId, approved, scope);
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

  stop = () => {
    if (!this.sessionId) return;
    void this.client.stopSession(this.sessionId).catch((caught) => {
      this.reportError(caught);
    });
  };

  reset = () => {
    void this.newSession();
  };

  reloadSession = async () => {
    const currentSessionId = this.sessionId;
    const requestVersion = this.beginSessionRequest();
    this.projection = EMPTY_PROJECTION;
    this.error = null;
    this.clearPendingApprovalState();
    this.publish();
    try {
      if (currentSessionId) {
        this.sessionId = currentSessionId;
        this.publish();
        const session = await this.client.restoreSession(currentSessionId);
        if (this.isCurrentRequest(requestVersion)) this.hydrateSession(session);
        return;
      }
      await this.ensureSession();
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
    void this.ensureSession().catch((caught) => {
      this.reportError(caught);
    });
  }

  private ensureSession() {
    if (this.sessionId) return Promise.resolve(this.sessionId);
    if (!this.restorePromise) {
      const requestVersion = this.requestVersion;
      this.restorePromise = this.client.restoreLatestSession()
        .then((session) => {
          if (!this.isCurrentRequest(requestVersion)) {
            return this.sessionId ?? session.sessionId;
          }
          this.hydrateSession(session);
          return session.sessionId;
        })
        .catch((caught) => {
          this.restorePromise = null;
          throw caught;
        });
    }
    return this.restorePromise;
  }

  private hydrateSession(session: AgentSession) {
    this.sessionId = session.sessionId;
    this.projection = session.renderProjection;
    this.error = session.renderProjection.errorMessage;
    this.clearPendingApprovalState();
    this.publish();
  }

  private handleEvent = (payload: AgentRuntimeEvent) => {
    if (payload.type === 'ready') return;

    if (payload.type === 'closed') {
      if (payload.sessionId === this.sessionId) {
        this.beginSessionRequest();
        this.sessionId = null;
        this.restorePromise = null;
        this.projection = EMPTY_PROJECTION;
        this.error = null;
        this.clearPendingApprovalState();
        this.publish();
      }
      return;
    }

    if (payload.type === 'error') {
      if (!this.sessionId || payload.sessionId === this.sessionId) {
        this.error = payload.error;
        this.publish();
      }
      return;
    }

    if (payload.type === 'approval_request') {
      if (!this.sessionId) {
        this.sessionId = payload.sessionId;
      }
      if (payload.sessionId !== this.sessionId) return;
      this.addPendingApproval(payload.request);
      this.publish();
      return;
    }

    if (payload.type === 'approval_resolved') {
      if (payload.sessionId !== this.sessionId) return;
      if (this.pendingApprovals.has(payload.requestId)) {
        this.removePendingApproval(payload.requestId);
        this.publish();
      }
      return;
    }

    if (payload.type === 'projection') {
      if (!this.sessionId) {
        this.sessionId = payload.sessionId;
      }
      if (payload.sessionId !== this.sessionId) return;
      this.projection = payload.renderProjection;
      this.error = payload.renderProjection.errorMessage;
      this.publish();
    }
  };

  private async closePreviousSession(previousSessionId: string | null, nextSessionId: string) {
    if (!previousSessionId || previousSessionId === nextSessionId) return;
    await this.client.closeSession(previousSessionId);
  }

  private beginSessionRequest() {
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
    const subagents = this.projection.entities.subagents ?? {};
    const subagentsByParentToolCallId = new Map<string, AgentRenderSubagentEntity>();
    for (const subagent of Object.values(subagents)) {
      if (subagent.parentToolCallId) subagentsByParentToolCallId.set(subagent.parentToolCallId, subagent);
    }
    return {
      entries,
      error: this.error,
      isStreaming: this.projection.isStreaming,
      modelId: projectionModelValue(this.projection, 'id'),
      providerId: projectionModelValue(this.projection, 'provider'),
      pendingToolCallIds: new Set(this.projection.pendingToolCallIds),
      reasoningLevel: this.projection.thinkingLevel,
      revision: `${this.sessionId ?? 'pending'}-${this.projection.revision}-${this.projection.rows.length}-${this.projection.transcriptRows.length}-${this.projection.pendingToolCallIds.join(',')}`,
      sessionId: this.sessionId,
      sessionTitle: this.projection.sessionTitle,
      sessionCost: sessionCost(this.projection),
      subagentRunIds: this.projection.subagentRunIds,
      subagents,
      subagentsByParentToolCallId,
      pendingApproval: this.currentPendingApproval(),
      toolResults,
      turnPhase,
      selectSession: this.selectSession,
      newSession: this.newSession,
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
      stop: this.stop,
      reset: this.reset,
      reloadSession: this.reloadSession,
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
  }

  private currentPendingApproval(): AgentApprovalRequestView | null {
    while (this.pendingApprovalOrder.length > 0) {
      const request = this.pendingApprovals.get(this.pendingApprovalOrder[0]);
      if (request) return request;
      this.pendingApprovalOrder.shift();
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
