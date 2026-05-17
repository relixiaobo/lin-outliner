import { useSyncExternalStore } from 'react';
import { api } from '../api/client';
import type {
  AgentConversationSnapshotEntry,
  AgentConversationMessage,
  AgentMessageAttachmentInput,
  AgentMessageBranchState,
  AgentMessage,
  AgentRuntimeEvent,
  AgentSnapshotState,
  AssistantMessage,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from '../../core/agentTypes';
import type { AgentSession } from '../../core/types';

export interface AgentMessageEntry {
  id: string;
  kind: 'message';
  nodeId: string | null;
  message: AgentConversationMessage;
  branches: AgentMessageBranchState | null;
  streaming: boolean;
}

export interface ActiveAssistantEntry {
  id: string;
  kind: 'active_assistant';
  timestamp: number;
}

export type AgentConversationEntry = AgentMessageEntry | ActiveAssistantEntry;

export type AgentTurnPhase = 'idle' | 'streaming_text' | 'waiting_for_tool' | 'resuming_after_tool';

const EMPTY_SNAPSHOT: AgentSnapshotState = {
  sessionTitle: null,
  systemPrompt: '',
  model: {},
  thinkingLevel: 'off',
  messages: [],
  conversation: [],
  streamingMessage: null,
  isStreaming: false,
  pendingToolCallIds: [],
  errorMessage: null,
};

function isConversationMessage(message: AgentMessage | null | undefined): message is AgentConversationMessage {
  return message?.role === 'user' || message?.role === 'assistant';
}

function isToolResultMessage(message: AgentMessage | null | undefined): message is ToolResultMessage {
  return message?.role === 'toolResult';
}

function messageId(message: AgentConversationMessage, index: number, streaming: boolean): string {
  return `${streaming ? 'streaming' : 'message'}-${message.role}-${message.timestamp}-${index}`;
}

function sameConversationMessage(
  left: AgentConversationMessage | undefined,
  right: AgentConversationMessage | undefined,
): boolean {
  return !!left && !!right && left.role === right.role && left.timestamp === right.timestamp;
}

function assistantHasText(message: AssistantMessage | undefined): boolean {
  return message?.content.some((block) => block.type === 'text' && block.text.trim().length > 0) ?? false;
}

function assistantHasPendingToolCalls(
  message: AssistantMessage | undefined,
  toolResults: Map<string, ToolResultMessage>,
): boolean {
  if (!message) return false;
  return message.content.some((block) => block.type === 'toolCall' && !toolResults.has(block.id));
}

function buildToolResultMap(messages: AgentMessage[]): Map<string, ToolResultMessage> {
  const results = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    if (isToolResultMessage(message)) {
      results.set(message.toolCallId, message);
    }
  }
  return results;
}

function buildEntries(snapshot: AgentSnapshotState, toolResults: Map<string, ToolResultMessage>): {
  entries: AgentConversationEntry[];
  turnPhase: AgentTurnPhase;
} {
  const conversation = snapshot.conversation.length > 0
    ? snapshot.conversation
    : snapshot.messages
      .filter(isConversationMessage)
      .map((message): AgentConversationSnapshotEntry => ({
        nodeId: '',
        message,
        branches: null,
      }));
  const entries: AgentConversationEntry[] = conversation
    .map((entry, index) => ({
      id: entry.nodeId || messageId(entry.message, index, false),
      kind: 'message',
      nodeId: entry.nodeId || null,
      message: entry.message,
      branches: entry.branches,
      streaming: false,
    }));
  const streamingMessage = isConversationMessage(snapshot.streamingMessage)
    ? snapshot.streamingMessage
    : null;

  if (streamingMessage) {
    const lastEntry = entries[entries.length - 1];
    const lastMessage = lastEntry?.kind === 'message' ? lastEntry.message : undefined;
    if (!sameConversationMessage(lastMessage, streamingMessage)) {
      entries.push({
        id: messageId(streamingMessage, entries.length, true),
        kind: 'message',
        nodeId: null,
        message: streamingMessage,
        branches: null,
        streaming: true,
      });
    }
  }

  let turnPhase: AgentTurnPhase = 'idle';
  if (snapshot.isStreaming) {
    if (streamingMessage?.role === 'assistant') {
      turnPhase = assistantHasText(streamingMessage) ? 'streaming_text' : 'resuming_after_tool';
    } else {
      const latestAssistant = [...entries]
        .reverse()
        .find((entry): entry is AgentMessageEntry =>
          entry.kind === 'message' && entry.message.role === 'assistant')?.message as AssistantMessage | undefined;
      turnPhase = assistantHasPendingToolCalls(latestAssistant, toolResults)
        ? 'waiting_for_tool'
        : 'resuming_after_tool';
    }
  }

  const lastEntry = entries[entries.length - 1];
  const shouldAppendAssistantPlaceholder = snapshot.isStreaming
    && (
      !lastEntry
      || lastEntry.kind !== 'message'
      || lastEntry.message.role !== 'assistant'
    );

  if (shouldAppendAssistantPlaceholder) {
    entries.push({
      id: `active-${snapshot.messages.length}-${snapshot.pendingToolCallIds.join('-')}`,
      kind: 'active_assistant',
      timestamp: Date.now(),
    });
  }

  return { entries, turnPhase };
}

function textContent(text: string): TextContent[] {
  return [{ type: 'text', text }];
}

function snapshotModelValue(snapshot: AgentSnapshotState, key: string): string | null {
  const value = snapshot.model[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sessionCost(snapshot: AgentSnapshotState): number {
  return snapshot.messages.reduce((total, message) => {
    if (message.role !== 'assistant') return total;
    return total + (message.usage?.cost?.total ?? 0);
  }, 0);
}

export interface AgentRuntimeClient {
  restoreLatestSession: () => Promise<AgentSession>;
  restoreSession: (sessionId: string) => Promise<AgentSession>;
  createSession: () => Promise<AgentSession>;
  closeSession: (sessionId: string) => Promise<void>;
  sendMessage: (sessionId: string, message: string, attachments?: AgentMessageAttachmentInput[]) => Promise<void>;
  editMessage: (sessionId: string, nodeId: string, message: string) => Promise<void>;
  regenerateMessage: (sessionId: string, nodeId: string) => Promise<void>;
  retryMessage: (sessionId: string, nodeId: string) => Promise<void>;
  switchBranch: (sessionId: string, nodeId: string) => Promise<void>;
  queueFollowUp: (sessionId: string, message: string) => Promise<{ queued: boolean }>;
  clearFollowUp: (sessionId: string) => Promise<void>;
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
  toolResults: Map<string, ToolResultMessage>;
  turnPhase: AgentTurnPhase;
  selectSession: (targetSessionId: string) => Promise<void>;
  newSession: () => Promise<void>;
  sendMessage: (prompt: string, attachments?: AgentMessageAttachmentInput[]) => Promise<void>;
  editMessage: (nodeId: string, prompt: string) => Promise<void>;
  regenerateMessage: (nodeId: string) => Promise<void>;
  retryMessage: (nodeId: string) => Promise<void>;
  switchBranch: (nodeId: string) => Promise<void>;
  queueFollowUp: (prompt: string) => Promise<boolean>;
  clearFollowUp: () => Promise<void>;
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
  sendMessage: (sessionId, message, attachments = []) => api.agentSendMessage(sessionId, message, attachments),
  editMessage: (sessionId, nodeId, message) => api.agentEditMessage(sessionId, nodeId, message),
  regenerateMessage: (sessionId, nodeId) => api.agentRegenerateMessage(sessionId, nodeId),
  retryMessage: (sessionId, nodeId) => api.agentRetryMessage(sessionId, nodeId),
  switchBranch: (sessionId, nodeId) => api.agentSwitchBranch(sessionId, nodeId),
  queueFollowUp: (sessionId, message) => api.agentQueueFollowUp(sessionId, message),
  clearFollowUp: (sessionId) => api.agentClearFollowUp(sessionId),
  stopSession: (sessionId) => api.agentStopSession(sessionId),
  onEvent: (listener) => typeof window === 'undefined' ? null : window.lin?.onAgentEvent(listener) ?? null,
};

export class AgentRuntimeStore {
  private readonly listeners = new Set<() => void>();
  private snapshot: AgentSnapshotState = EMPTY_SNAPSHOT;
  private sessionId: string | null = null;
  private error: string | null = null;
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
    this.snapshot = EMPTY_SNAPSHOT;
    this.error = null;
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
    this.snapshot = EMPTY_SNAPSHOT;
    this.error = null;
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

  sendMessage = async (prompt: string, attachments: AgentMessageAttachmentInput[] = []) => {
    const trimmed = prompt.trim();
    if (!trimmed && attachments.length === 0) return;
    try {
      const currentSessionId = await this.ensureSession();
      await this.client.sendMessage(currentSessionId, trimmed, attachments);
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

  queueFollowUp = async (prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed) return false;
    try {
      const currentSessionId = await this.ensureSession();
      const result = await this.client.queueFollowUp(currentSessionId, trimmed);
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
    this.snapshot = EMPTY_SNAPSHOT;
    this.error = null;
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
    if (session.state) {
      this.snapshot = session.state;
      this.error = session.state.errorMessage;
    }
    this.publish();
  }

  private handleEvent = (payload: AgentRuntimeEvent) => {
    if (payload.type === 'ready') return;

    if (payload.type === 'closed') {
      if (payload.sessionId === this.sessionId) {
        this.beginSessionRequest();
        this.sessionId = null;
        this.restorePromise = null;
        this.snapshot = EMPTY_SNAPSHOT;
        this.error = null;
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

    if (payload.type === 'snapshot') {
      if (!this.sessionId) {
        this.sessionId = payload.sessionId;
      }
      if (payload.sessionId !== this.sessionId) return;
      this.snapshot = payload.state;
      this.error = payload.state.errorMessage;
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
    const toolResults = buildToolResultMap(this.snapshot.messages);
    const { entries, turnPhase } = buildEntries(this.snapshot, toolResults);
    return {
      entries,
      error: this.error,
      isStreaming: this.snapshot.isStreaming,
      modelId: snapshotModelValue(this.snapshot, 'id'),
      providerId: snapshotModelValue(this.snapshot, 'provider'),
      pendingToolCallIds: new Set(this.snapshot.pendingToolCallIds),
      reasoningLevel: this.snapshot.thinkingLevel,
      revision: `${this.sessionId ?? 'pending'}-${this.snapshot.messages.length}-${this.snapshot.pendingToolCallIds.join(',')}`,
      sessionId: this.sessionId,
      sessionTitle: this.snapshot.sessionTitle,
      sessionCost: sessionCost(this.snapshot),
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
      stop: this.stop,
      reset: this.reset,
      reloadSession: this.reloadSession,
      seedUserMessage: this.seedUserMessage,
    };
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
