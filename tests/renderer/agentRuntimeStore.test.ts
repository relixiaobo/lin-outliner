import { describe, expect, test } from 'bun:test';
import {
  createAgentRuntimeStore,
  type AgentRuntimeClient,
} from '../../src/renderer/agent/runtime';
import type {
  AgentRuntimeEvent,
  AssistantMessage,
  UserMessage,
} from '../../src/core/agentTypes';
import type { AgentSession } from '../../src/core/types';
import type { AgentRenderProjection } from '../../src/core/agentRenderProjection';
import type { AgentPayloadRef, AgentPersistedContent } from '../../src/core/agentEventLog';

const EMPTY_USAGE = {
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

function userMessage(text: string, timestamp = 1): UserMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp,
  };
}

function assistantMessage(text: string, timestamp = 2): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp,
  };
}

interface ProjectionEntry {
  nodeId: string;
  message: UserMessage | AssistantMessage;
  branches: { ids: string[]; currentIndex: number } | null;
}

function projection(
  entries: ProjectionEntry[],
  options: { isStreaming?: boolean; streamingMessageId?: string; revision?: number } = {},
): AgentRenderProjection {
  return {
    sessionId: 'saved',
    revision: options.revision ?? 1,
    sessionTitle: 'Saved conversation',
    activeRunId: options.isStreaming ? 'run-1' : null,
    isStreaming: !!options.isStreaming,
    model: { id: 'test-model', provider: 'test' },
    thinkingLevel: 'off',
    pendingToolCallIds: [],
    errorMessage: null,
    rows: entries.map((entry) => ({
      id: `${entry.message.role}:${entry.nodeId}`,
      kind: 'message',
      messageId: entry.nodeId,
    })),
    entities: {
      messages: Object.fromEntries(entries.map((entry) => [entry.nodeId, {
        id: entry.nodeId,
        role: entry.message.role,
        status: options.streamingMessageId === entry.nodeId ? 'streaming' : 'completed',
        parentMessageId: null,
        content: persistedContent(entry.message),
        createdAt: entry.message.timestamp,
        updatedAt: entry.message.timestamp,
        branches: entry.branches,
        apiId: entry.message.role === 'assistant' ? entry.message.api : undefined,
        providerId: entry.message.role === 'assistant' ? entry.message.provider : undefined,
        modelId: entry.message.role === 'assistant' ? entry.message.model : undefined,
        stopReason: entry.message.role === 'assistant' ? entry.message.stopReason : undefined,
        usage: entry.message.role === 'assistant' ? entry.message.usage : undefined,
      }])),
    },
    streaming: options.streamingMessageId ? {
      messageId: options.streamingMessageId,
      rowId: `assistant:${options.streamingMessageId}`,
      text: entries
        .find((entry) => entry.nodeId === options.streamingMessageId)
        ?.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('') ?? '',
      updatedAt: Date.now(),
    } : null,
  };
}

function persistedContent(message: UserMessage | AssistantMessage): AgentPersistedContent[] {
  const content = typeof message.content === 'string'
    ? [{ type: 'text' as const, text: message.content }]
    : message.content.map((part): AgentPersistedContent => {
        if (part.type === 'text') return { type: 'text', text: part.text };
        if (part.type === 'thinking') return { type: 'thinking', thinking: part.thinking, redacted: part.redacted };
        if (part.type === 'toolCall') return { type: 'toolCall', id: part.id, name: part.name, arguments: part.arguments };
        return { type: 'text', text: `[image:${part.mimeType}]` };
      });
  return content;
}

function session(sessionId: string, renderProjection: AgentRenderProjection): AgentSession {
  return {
    sessionId,
    renderProjection: { ...renderProjection, sessionId },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function createFakeClient(options: {
  latestSession: Promise<AgentSession> | AgentSession;
  createdSession?: AgentSession;
}) {
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  const calls = {
    closeSession: [] as string[],
    createSession: 0,
    restoreLatestSession: 0,
    restoreSession: [] as string[],
  };

  const client: AgentRuntimeClient = {
    restoreLatestSession: async () => {
      calls.restoreLatestSession += 1;
      return options.latestSession;
    },
    restoreSession: async (sessionId) => {
      calls.restoreSession.push(sessionId);
      return session(sessionId, projection([]));
    },
    createSession: async () => {
      calls.createSession += 1;
      return options.createdSession ?? session('created', projection([]));
    },
    closeSession: async (sessionId) => {
      calls.closeSession.push(sessionId);
    },
    sendMessage: async () => {},
    editMessage: async () => {},
    regenerateMessage: async () => {},
    retryMessage: async () => {},
    switchBranch: async () => {},
    queueFollowUp: async () => ({ queued: true }),
    clearFollowUp: async () => {},
    stopSession: async () => {},
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    calls,
    client,
    emit: (event: AgentRuntimeEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

describe('agent runtime store', () => {
  test('hydrates conversation from restore command response without waiting for an event', async () => {
    const restored = session('saved', projection([
      { nodeId: 'u1', message: userMessage('hello'), branches: null },
      { nodeId: 'a1', message: assistantMessage('hi'), branches: null },
    ]));
    const fake = createFakeClient({ latestSession: restored });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});

    await flushMicrotasks();

    expect(fake.calls.restoreLatestSession).toBe(1);
    expect(store.getSnapshot().sessionId).toBe('saved');
    expect(store.getSnapshot().entries.map((entry) => entry.nodeId))
      .toEqual(['u1', 'a1']);
    expect(fake.calls.closeSession).toEqual([]);
    unsubscribe();
  });

  test('keeps the restored session through unsubscribe and resubscribe races', async () => {
    const restore = deferred<AgentSession>();
    const restored = session('saved', projection([
      { nodeId: 'u1', message: userMessage('persisted'), branches: null },
    ]));
    const fake = createFakeClient({ latestSession: restore.promise });
    const store = createAgentRuntimeStore(fake.client);

    const unsubscribeFirst = store.subscribe(() => {});
    unsubscribeFirst();
    const unsubscribeSecond = store.subscribe(() => {});
    restore.resolve(restored);
    await flushMicrotasks();

    expect(fake.calls.restoreLatestSession).toBe(1);
    expect(fake.calls.closeSession).toEqual([]);
    expect(store.getSnapshot().sessionId).toBe('saved');
    expect(store.getSnapshot().entries).toHaveLength(1);
    unsubscribeSecond();
  });

  test('closes the previous runtime session only on explicit new session', async () => {
    const restored = session('saved', projection([
      { nodeId: 'u1', message: userMessage('old'), branches: null },
    ]));
    const created = session('created', projection([
      { nodeId: 'u2', message: userMessage('new'), branches: null },
    ]));
    const fake = createFakeClient({ latestSession: restored, createdSession: created });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});
    await flushMicrotasks();

    await store.getSnapshot().newSession();

    expect(fake.calls.createSession).toBe(1);
    expect(fake.calls.closeSession).toEqual(['saved']);
    expect(store.getSnapshot().sessionId).toBe('created');
    expect(store.getSnapshot().entries.map((entry) => entry.nodeId))
      .toEqual(['u2']);
    unsubscribe();
  });

  test('keeps a stable assistant entry while a streamed turn starts producing text', async () => {
    const user = userMessage('hello', 42);
    const restored = session('saved', projection([
      { nodeId: 'u1', message: user, branches: null },
    ]));
    const fake = createFakeClient({ latestSession: restored });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});
    await flushMicrotasks();

    fake.emit({
      type: 'projection',
      sessionId: 'saved',
      lastEventType: null,
      revision: 1,
      renderProjection: projection([{ nodeId: 'u1', message: user, branches: null }], { isStreaming: true, revision: 1 }),
      timestamp: 100,
    });

    const pendingAssistant = store.getSnapshot().entries[1];
    expect(pendingAssistant?.kind).toBe('message');
    expect(pendingAssistant?.id).toBe('active-assistant-42');
    expect(pendingAssistant?.message.role).toBe('assistant');
    expect(pendingAssistant?.message.content).toEqual([]);

    fake.emit({
      type: 'projection',
      sessionId: 'saved',
      lastEventType: null,
      revision: 2,
      renderProjection: projection([
        { nodeId: 'u1', message: user, branches: null },
        { nodeId: 'assistant-stream', message: assistantMessage('hi', 50), branches: null },
      ], { isStreaming: true, streamingMessageId: 'assistant-stream', revision: 2 }),
      timestamp: 101,
    });

    const streamingAssistant = store.getSnapshot().entries[1];
    expect(streamingAssistant?.id).toBe('active-assistant-42');
    expect(streamingAssistant?.message.role).toBe('assistant');
    expect(streamingAssistant?.message.content).toEqual([{ type: 'text', text: 'hi' }]);
    unsubscribe();
  });

  test('preserves tool output payload refs for lazy renderer loading', async () => {
    const payload: AgentPayloadRef = {
      kind: 'payload_ref',
      id: 'tool-output-tool-1',
      storage: 'file',
      mimeType: 'text/plain',
      byteLength: 50_000,
      sha256: 'tool-sha',
      role: 'tool_output',
      summary: 'file_read output: long result...',
      truncated: true,
    };
    const label = '<persisted-output>\nPreview\n</persisted-output>';
    const assistant = assistantMessage('', 2);
    assistant.content = [{
      type: 'toolCall',
      id: 'tool-1',
      name: 'file_read',
      arguments: { path: 'notes.txt' },
    }];
    const restoredProjection = projection([
      { nodeId: 'u1', message: userMessage('read file'), branches: null },
      { nodeId: 'a1', message: assistant, branches: null },
    ]);
    restoredProjection.entities.messages['tool-result-1'] = {
      id: 'tool-result-1',
      role: 'toolResult',
      status: 'completed',
      parentMessageId: 'a1',
      content: [{ type: 'payload_ref', payload, label }],
      createdAt: 3,
      updatedAt: 3,
      branches: null,
      toolCallId: 'tool-1',
      toolName: 'file_read',
      isError: false,
    };
    const fake = createFakeClient({ latestSession: session('saved', restoredProjection) });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});
    await flushMicrotasks();

    const result = store.getSnapshot().toolResults.get('tool-1');
    expect(result?.content).toEqual([{ type: 'text', text: label }]);
    expect(result?.payloadRefs).toEqual([{ contentIndex: 0, payload, label }]);
    unsubscribe();
  });

  test('ignores stale initial restore after an explicit session change', async () => {
    const restore = deferred<AgentSession>();
    const restored = session('saved', projection([
      { nodeId: 'u1', message: userMessage('old'), branches: null },
    ]));
    const created = session('created', projection([
      { nodeId: 'u2', message: userMessage('new'), branches: null },
    ]));
    const fake = createFakeClient({ latestSession: restore.promise, createdSession: created });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});

    await store.getSnapshot().newSession();
    restore.resolve(restored);
    await flushMicrotasks();

    expect(fake.calls.restoreLatestSession).toBe(1);
    expect(fake.calls.createSession).toBe(1);
    expect(store.getSnapshot().sessionId).toBe('created');
    expect(store.getSnapshot().entries.map((entry) => entry.nodeId))
      .toEqual(['u2']);
    unsubscribe();
  });
});
