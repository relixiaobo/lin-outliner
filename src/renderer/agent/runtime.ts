import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
} from '../../core/agentTypes';

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

export function useLinAgentRuntime() {
  const [snapshot, setSnapshot] = useState<AgentSnapshotState>(EMPTY_SNAPSHOT);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const createSessionPromiseRef = useRef<Promise<string> | null>(null);

  const ensureSession = useCallback(async () => {
    if (sessionIdRef.current) {
      return sessionIdRef.current;
    }

    if (!createSessionPromiseRef.current) {
      createSessionPromiseRef.current = api.agentRestoreLatestSession().then((session) => {
        sessionIdRef.current = session.sessionId;
        setSessionId(session.sessionId);
        return session.sessionId;
      });
    }

    return createSessionPromiseRef.current;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    const dispose = window.lin?.onAgentEvent((payload: AgentRuntimeEvent) => {
      if (payload.type === 'ready') {
        return;
      }

      if (payload.type === 'closed') {
        if (payload.sessionId === sessionIdRef.current) {
          sessionIdRef.current = null;
          setSessionId(null);
          setSnapshot(EMPTY_SNAPSHOT);
        }
        return;
      }

      if (payload.type === 'error') {
        if (!sessionIdRef.current || payload.sessionId === sessionIdRef.current) {
          setError(payload.error);
        }
        return;
      }

      if (payload.type === 'snapshot') {
        if (!sessionIdRef.current) {
          sessionIdRef.current = payload.sessionId;
          setSessionId(payload.sessionId);
        }
        if (payload.sessionId !== sessionIdRef.current) {
          return;
        }
        setError(payload.state.errorMessage);
        setSnapshot(payload.state);
      }
    }) ?? null;
    unlisten = dispose;
    void ensureSession().then((createdSessionId) => {
      if (cancelled) {
        void api.agentCloseSession(createdSessionId);
      }
    }).catch((caught) => {
      setError(caught instanceof Error ? caught.message : String(caught));
    });

    return () => {
      cancelled = true;
      const currentSessionId = sessionIdRef.current;
      if (currentSessionId) {
        void api.agentCloseSession(currentSessionId);
      }
      unlisten?.();
    };
  }, [ensureSession]);

  return useMemo(() => {
    const toolResults = buildToolResultMap(snapshot.messages);
    const { entries, turnPhase } = buildEntries(snapshot, toolResults);

    return {
      entries,
      error,
      isStreaming: snapshot.isStreaming,
      modelId: snapshotModelValue(snapshot, 'id'),
      providerId: snapshotModelValue(snapshot, 'provider'),
      pendingToolCallIds: new Set(snapshot.pendingToolCallIds),
      reasoningLevel: snapshot.thinkingLevel,
      revision: `${sessionId ?? 'pending'}-${snapshot.messages.length}-${snapshot.pendingToolCallIds.join(',')}`,
      sessionId,
      sessionTitle: snapshot.sessionTitle,
      sessionCost: sessionCost(snapshot),
      toolResults,
      turnPhase,
      selectSession: async (targetSessionId: string) => {
        if (!targetSessionId || targetSessionId === sessionIdRef.current) return;
        const previousSessionId = sessionIdRef.current;
        createSessionPromiseRef.current = null;
        sessionIdRef.current = targetSessionId;
        setSessionId(targetSessionId);
        setSnapshot(EMPTY_SNAPSHOT);
        setError(null);
        await api.agentRestoreSession(targetSessionId);
        if (previousSessionId && previousSessionId !== targetSessionId) {
          await api.agentCloseSession(previousSessionId);
        }
      },
      newSession: async () => {
        const previousSessionId = sessionIdRef.current;
        createSessionPromiseRef.current = null;
        sessionIdRef.current = null;
        setSnapshot(EMPTY_SNAPSHOT);
        setError(null);
        const session = await api.agentCreateSession();
        sessionIdRef.current = session.sessionId;
        setSessionId(session.sessionId);
        if (previousSessionId && previousSessionId !== session.sessionId) {
          await api.agentCloseSession(previousSessionId);
        }
      },
      sendMessage: async (prompt: string, attachments: AgentMessageAttachmentInput[] = []) => {
        const trimmed = prompt.trim();
        if (!trimmed && attachments.length === 0) return;
        const currentSessionId = await ensureSession();
        await api.agentSendMessage(currentSessionId, trimmed, attachments);
      },
      editMessage: async (nodeId: string, prompt: string) => {
        const trimmed = prompt.trim();
        const currentSessionId = sessionIdRef.current;
        if (!trimmed || !currentSessionId) return;
        await api.agentEditMessage(currentSessionId, nodeId, trimmed);
      },
      regenerateMessage: async (nodeId: string) => {
        const currentSessionId = sessionIdRef.current;
        if (!currentSessionId) return;
        await api.agentRegenerateMessage(currentSessionId, nodeId);
      },
      retryMessage: async (nodeId: string) => {
        const currentSessionId = sessionIdRef.current;
        if (!currentSessionId) return;
        await api.agentRetryMessage(currentSessionId, nodeId);
      },
      switchBranch: async (nodeId: string) => {
        const currentSessionId = sessionIdRef.current;
        if (!currentSessionId) return;
        await api.agentSwitchBranch(currentSessionId, nodeId);
      },
      queueFollowUp: async (prompt: string) => {
        const trimmed = prompt.trim();
        if (!trimmed) return false;
        const currentSessionId = await ensureSession();
        const result = await api.agentQueueFollowUp(currentSessionId, trimmed);
        return result.queued;
      },
      clearFollowUp: async () => {
        const currentSessionId = sessionIdRef.current;
        if (!currentSessionId) return;
        await api.agentClearFollowUp(currentSessionId);
      },
      stop: () => {
        const currentSessionId = sessionIdRef.current;
        if (!currentSessionId) return;
        void api.agentStopSession(currentSessionId).catch((caught) => {
          setError(caught instanceof Error ? caught.message : String(caught));
        });
      },
      reset: () => {
        const previousSessionId = sessionIdRef.current;
        createSessionPromiseRef.current = null;
        sessionIdRef.current = null;
        setSnapshot(EMPTY_SNAPSHOT);
        void api.agentCreateSession().then((session) => {
          sessionIdRef.current = session.sessionId;
          setSessionId(session.sessionId);
          if (previousSessionId) void api.agentCloseSession(previousSessionId);
        }).catch((caught) => {
          setError(caught instanceof Error ? caught.message : String(caught));
        });
      },
      reloadSession: async () => {
        const currentSessionId = sessionIdRef.current;
        createSessionPromiseRef.current = null;
        setSnapshot(EMPTY_SNAPSHOT);
        setError(null);
        if (currentSessionId) {
          sessionIdRef.current = currentSessionId;
          setSessionId(currentSessionId);
          await api.agentRestoreSession(currentSessionId);
          return;
        }
        await ensureSession();
      },
      seedUserMessage: (message: string) => ({
        role: 'user',
        content: textContent(message),
        timestamp: Date.now(),
      }),
    };
  }, [ensureSession, error, sessionId, snapshot]);
}
