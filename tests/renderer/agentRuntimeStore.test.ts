import { describe, expect, test } from 'bun:test';
import {
  createAgentRuntimeStore,
  type AgentRuntimeClient,
} from '../../src/renderer/agent/runtime';
import type {
  AgentConversationSnapshotEntry,
  AgentRuntimeEvent,
  AgentSnapshotState,
  AssistantMessage,
  UserMessage,
} from '../../src/core/agentTypes';
import type { AgentSession } from '../../src/core/types';

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

function snapshot(entries: AgentConversationSnapshotEntry[]): AgentSnapshotState {
  return {
    sessionTitle: 'Saved conversation',
    systemPrompt: '',
    model: { id: 'test-model', provider: 'test' },
    thinkingLevel: 'off',
    messages: entries.map((entry) => entry.message),
    conversation: entries,
    streamingMessage: null,
    isStreaming: false,
    pendingToolCallIds: [],
    errorMessage: null,
  };
}

function session(sessionId: string, state: AgentSnapshotState): AgentSession {
  return { sessionId, state };
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
      return session(sessionId, snapshot([]));
    },
    createSession: async () => {
      calls.createSession += 1;
      return options.createdSession ?? session('created', snapshot([]));
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
    const restored = session('saved', snapshot([
      { nodeId: 'u1', message: userMessage('hello'), branches: null },
      { nodeId: 'a1', message: assistantMessage('hi'), branches: null },
    ]));
    const fake = createFakeClient({ latestSession: restored });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});

    await flushMicrotasks();

    expect(fake.calls.restoreLatestSession).toBe(1);
    expect(store.getSnapshot().sessionId).toBe('saved');
    expect(store.getSnapshot().entries.map((entry) => entry.kind === 'message' ? entry.nodeId : null))
      .toEqual(['u1', 'a1']);
    expect(fake.calls.closeSession).toEqual([]);
    unsubscribe();
  });

  test('keeps the restored session through unsubscribe and resubscribe races', async () => {
    const restore = deferred<AgentSession>();
    const restored = session('saved', snapshot([
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
    const restored = session('saved', snapshot([
      { nodeId: 'u1', message: userMessage('old'), branches: null },
    ]));
    const created = session('created', snapshot([
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
    expect(store.getSnapshot().entries.map((entry) => entry.kind === 'message' ? entry.nodeId : null))
      .toEqual(['u2']);
    unsubscribe();
  });

  test('ignores stale initial restore after an explicit session change', async () => {
    const restore = deferred<AgentSession>();
    const restored = session('saved', snapshot([
      { nodeId: 'u1', message: userMessage('old'), branches: null },
    ]));
    const created = session('created', snapshot([
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
    expect(store.getSnapshot().entries.map((entry) => entry.kind === 'message' ? entry.nodeId : null))
      .toEqual(['u2']);
    unsubscribe();
  });
});
