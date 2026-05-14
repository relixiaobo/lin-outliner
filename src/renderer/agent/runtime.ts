import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type {
  AgentConversationMessage,
  AgentMessage,
  AgentSnapshotState,
  AgentWorkerEvent,
  AssistantMessage,
  TextContent,
  ToolResultMessage,
} from './types';

export interface AgentMessageEntry {
  id: string;
  kind: 'message';
  message: AgentConversationMessage;
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
  systemPrompt: '',
  model: {},
  thinkingLevel: 'off',
  messages: [],
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
  const entries: AgentConversationEntry[] = snapshot.messages
    .filter(isConversationMessage)
    .map((message, index) => ({
      id: messageId(message, index, false),
      kind: 'message',
      message,
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
        message: streamingMessage,
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
      createSessionPromiseRef.current = api.agentCreateSession().then((session) => {
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

    const dispose = window.lin?.onAgentEvent((payload: AgentWorkerEvent) => {
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
      revision: `${sessionId ?? 'pending'}-${snapshot.messages.length}-${snapshot.pendingToolCallIds.join(',')}`,
      sessionId,
      toolResults,
      turnPhase,
      sendMessage: async (prompt: string) => {
        const trimmed = prompt.trim();
        if (!trimmed) return;
        const currentSessionId = await ensureSession();
        await api.agentSendMessage(currentSessionId, trimmed);
      },
      stop: () => {
        const currentSessionId = sessionIdRef.current;
        if (!currentSessionId) return;
        void api.agentStopSession(currentSessionId).catch((caught) => {
          setError(caught instanceof Error ? caught.message : String(caught));
        });
      },
      reset: () => {
        const currentSessionId = sessionIdRef.current;
        if (!currentSessionId) return;
        setSnapshot(EMPTY_SNAPSHOT);
        void api.agentResetSession(currentSessionId).catch((caught) => {
          setError(caught instanceof Error ? caught.message : String(caught));
        });
      },
      seedUserMessage: (message: string) => ({
        role: 'user',
        content: textContent(message),
        timestamp: Date.now(),
      }),
    };
  }, [ensureSession, error, sessionId, snapshot]);
}
