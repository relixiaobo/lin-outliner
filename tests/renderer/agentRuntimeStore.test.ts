import { describe, expect, test } from 'bun:test';
import {
  createAgentRuntimeStore,
  type AgentRuntimeClient,
} from '../../src/renderer/agent/runtime';
import type {
  AgentRuntimeEvent,
  AgentUserViewContext,
  AssistantMessage,
  UserMessage,
} from '../../src/core/agentTypes';
import type { AgentSession } from '../../src/core/types';
import type {
  AgentRenderActiveCompaction,
  AgentRenderProjection,
  AgentRenderSubagentEntity,
} from '../../src/core/agentRenderProjection';
import type { AgentPayloadRef, AgentPersistedContent } from '../../src/core/agentEventLog';
import { systemReminder } from '../../src/core/agentAttachments';

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
  options: {
    isStreaming?: boolean;
    revision?: number;
    streamingMessageId?: string;
    activeCompaction?: AgentRenderActiveCompaction | null;
    subagents?: Record<string, AgentRenderSubagentEntity>;
    subagentRunIds?: string[];
  } = {},
): AgentRenderProjection {
  return {
    sessionId: 'saved',
    revision: options.revision ?? 1,
    sessionTitle: 'Saved conversation',
    activeRunId: options.isStreaming ? 'run-1' : null,
    activeCompaction: options.activeCompaction ?? null,
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
    subagentRunIds: options.subagentRunIds ?? Object.keys(options.subagents ?? {}),
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
      subagents: options.subagents ?? {},
      compactions: {},
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
    queueFollowUp: [] as Array<{ sessionId: string; message: string; userViewContext?: AgentUserViewContext | null }>,
    steerSession: [] as Array<{ sessionId: string; message: string }>,
    sendMessage: [] as Array<{
      sessionId: string;
      message: string;
      userViewContext?: AgentUserViewContext | null;
    }>,
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
    sendMessage: async (sessionId, message, _attachments, userViewContext) => {
      calls.sendMessage.push({ sessionId, message, userViewContext });
    },
    editMessage: async () => {},
    regenerateMessage: async () => {},
    retryMessage: async () => {},
    switchBranch: async () => {},
    queueFollowUp: async (sessionId, message, userViewContext) => {
      calls.queueFollowUp.push({ sessionId, message, userViewContext });
      return { queued: true };
    },
    clearFollowUp: async () => {},
    steerSession: async (sessionId, message) => {
      calls.steerSession.push({ sessionId, message });
      return { queued: true };
    },
    clearSteer: async () => {},
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

  test('filters hidden system reminder user rows from the visible conversation', async () => {
    const restored = session('saved', projection([
      { nodeId: 'system-notification', message: userMessage(systemReminder('Background subagent completed.')), branches: null },
      { nodeId: 'a1', message: assistantMessage('handled notification'), branches: null },
    ]));
    const fake = createFakeClient({ latestSession: restored });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});

    await flushMicrotasks();

    expect(store.getSnapshot().entries.map((entry) => entry.nodeId)).toEqual(['a1']);
    unsubscribe();
  });

  test('keeps compaction rows as visible boundary entries with summaries', async () => {
    const restoredProjection = projection([]);
    restoredProjection.rows = [{
      id: 'compaction:compact-root',
      kind: 'compaction',
      messageId: 'compact-root',
      compactionId: 'compact-1',
    }];
    restoredProjection.entities.messages['compact-root'] = {
      id: 'compact-root',
      role: 'user',
      status: 'completed',
      parentMessageId: null,
      content: [
        { type: 'text', text: 'Conversation compacted.' },
        { type: 'text', text: systemReminder('Hidden compact summary.') },
      ],
      createdAt: 10,
      updatedAt: 10,
      branches: null,
    };
    restoredProjection.entities.compactions['compact-1'] = {
      id: 'compact-1',
      messageId: 'compact-root',
      summary: 'Visible compact summary.',
      compactedThroughMessageId: 'a1',
      trigger: 'auto',
      createdAt: 10,
    };
    const fake = createFakeClient({ latestSession: session('saved', restoredProjection) });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});

    await flushMicrotasks();

    expect(store.getSnapshot().entries).toEqual([{
      id: 'compaction:compact-root',
      kind: 'compaction',
      status: 'completed',
      compaction: restoredProjection.entities.compactions['compact-1'],
    }]);
    unsubscribe();
  });

  test('keeps active compaction as a visible boundary entry', async () => {
    const restoredProjection = projection([
      { nodeId: 'u1', message: userMessage('compact this'), branches: null },
    ], {
      isStreaming: true,
      activeCompaction: {
        id: 'active-compact-1',
        trigger: 'manual',
        startedAt: 20,
      },
    });
    const fake = createFakeClient({ latestSession: session('saved', restoredProjection) });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});

    await flushMicrotasks();

    expect(store.getSnapshot().entries.at(-1)).toEqual({
      id: 'active-compaction:active-compact-1',
      kind: 'compaction',
      status: 'active',
      compaction: restoredProjection.activeCompaction,
    });
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

  test('indexes subagents by parent tool call id for renderer lookup', async () => {
    const subagent = {
      id: 'subagent-1',
      description: 'Inspect subagent UI',
      prompt: 'Inspect the current UI.',
      subagentType: 'explorer',
      contextMode: 'fork',
      status: 'completed',
      startedAt: 100,
      updatedAt: 250,
      completedAt: 250,
      result: 'Found the relevant UI path.',
      transcriptPayloadId: 'subagent-transcript-1',
      transcriptMessageCount: 4,
      parentToolCallId: 'tool-agent-1',
    } satisfies AgentRenderSubagentEntity;
    const restored = session('saved', projection([
      { nodeId: 'u1', message: userMessage('inspect'), branches: null },
      {
        nodeId: 'a1',
        message: {
          ...assistantMessage('', 2),
          content: [{
            type: 'toolCall',
            id: 'tool-agent-1',
            name: 'Agent',
            arguments: {
              description: 'Inspect subagent UI',
              prompt: 'Inspect the current UI.',
            },
          }],
        },
        branches: null,
      },
    ], {
      subagents: { [subagent.id]: subagent },
      subagentRunIds: [subagent.id],
    }));
    const fake = createFakeClient({ latestSession: restored });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});

    await flushMicrotasks();

    const snapshot = store.getSnapshot();
    expect(snapshot.subagentRunIds).toEqual(['subagent-1']);
    expect(snapshot.subagents['subagent-1']).toEqual(subagent);
    expect(snapshot.subagentsByParentToolCallId.get('tool-agent-1')).toEqual(subagent);
    unsubscribe();
  });

  test('passes user view context through user turns and queued follow-ups', async () => {
    const restored = session('saved', projection([]));
    const userViewContext: AgentUserViewContext = {
      activePanelId: 'panel-1',
      focusedPanelId: 'panel-1',
      focusSurface: 'row',
      focusedNode: {
        nodeId: 'node-1',
        title: 'Focused node',
        panelId: 'panel-1',
        surface: 'row',
      },
      nodePanels: [{
        panelId: 'panel-1',
        rootNodeId: 'root-1',
        rootTitle: 'Today',
        rootType: 'outline',
        active: true,
        focused: true,
        order: 1,
        childCount: 3,
        breadcrumb: [],
        visibleOutline: [
          { nodeId: 'root-1', title: 'Today', depth: 0 },
          { nodeId: 'node-1', title: 'Focused node', depth: 1, focused: true },
        ],
        visibleOutlineTruncated: false,
      }],
    };
    const fake = createFakeClient({ latestSession: restored });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});
    await flushMicrotasks();

    await store.getSnapshot().sendMessage('hello', [], userViewContext);
    await store.getSnapshot().queueFollowUp('next', userViewContext);
    await store.getSnapshot().steer('correct course');

    expect(fake.calls.sendMessage).toEqual([{
      sessionId: 'saved',
      message: 'hello',
      userViewContext,
    }]);
    expect(fake.calls.queueFollowUp).toEqual([{
      sessionId: 'saved',
      message: 'next',
      userViewContext,
    }]);
    expect(fake.calls.steerSession).toEqual([{
      sessionId: 'saved',
      message: 'correct course',
    }]);
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
