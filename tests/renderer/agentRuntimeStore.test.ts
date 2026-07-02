import { describe, expect, test } from 'bun:test';
import {
  createAgentRuntimeStore,
  type AgentConversationPreferenceStore,
  type AgentRuntimeClient,
} from '../../src/renderer/agent/runtime';
import type {
  AgentApprovalResolutionScope,
  AgentRuntimeEvent,
  AgentUserViewContext,
  AskUserQuestionResult,
  AssistantMessage,
  UserMessage,
} from '../../src/core/agentTypes';
import type { AgentConversation, AgentCreateConversationOptions } from '../../src/core/types';
import { DEFAULT_GENERAL_CHANNEL_ID } from '../../src/core/agentChannel';
import type {
  AgentRenderActiveCompaction,
  AgentRenderActiveRun,
  AgentRenderActiveDream,
  AgentRenderDreamEntity,
  AgentRenderProjection,
  AgentRenderRunEntity,
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
    activeRuns?: AgentRenderActiveRun[];
    activeRunId?: string | null;
    activeDream?: AgentRenderActiveDream | null;
    dreams?: Record<string, AgentRenderDreamEntity>;
    runs?: Record<string, AgentRenderRunEntity>;
    runIds?: string[];
  } = {},
): AgentRenderProjection {
  const rows = entries.map((entry) => ({
    id: `${entry.message.role}:${entry.nodeId}`,
    kind: 'message' as const,
    messageId: entry.nodeId,
  }));
  return {
    conversationId: 'saved',
    revision: options.revision ?? 1,
    conversationTitle: 'Saved conversation',
    activeRuns: options.activeRuns ?? [],
    activeRunId: options.activeRunId ?? (options.isStreaming ? 'run-1' : null),
    activeCompaction: options.activeCompaction ?? null,
    activeDream: options.activeDream ?? null,
    runActive: !!options.isStreaming,
    model: { id: 'test-model', provider: 'test' },
    thinkingLevel: 'off',
    pendingToolCallIds: [],
    errorMessage: null,
    rows,
    transcriptRows: rows,
    runIds: options.runIds ?? Object.keys(options.runs ?? {}),
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
      runs: options.runs ?? {},
      compactions: {},
      contextClears: {},
      dreams: options.dreams ?? {},
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
    : message.content.map((part, index): AgentPersistedContent => {
        if (part.type === 'text') return { type: 'text', text: part.text };
        if (part.type === 'thinking') return { type: 'thinking', thinking: part.thinking, redacted: part.redacted };
        if (part.type === 'toolCall') return { type: 'toolCall', id: part.id, name: part.name, arguments: part.arguments };
        return {
          type: 'image',
          alt: 'Image attachment',
          imageRef: {
            kind: 'payload_ref',
            id: `image-${index}`,
            storage: 'file',
            mimeType: part.mimeType,
            byteLength: 0,
            sha256: `image-${index}`,
            role: 'source',
            summary: 'Image attachment',
          },
        };
      });
  return content;
}

function conversation(conversationId: string, renderProjection: AgentRenderProjection): AgentConversation {
  return {
    conversationId,
    renderProjection: { ...renderProjection, conversationId },
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
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

function createFakeClient(options: {
  latestConversation: Promise<AgentConversation> | AgentConversation;
  defaultConversation?: Promise<AgentConversation> | AgentConversation;
  createdConversation?: AgentConversation;
  restoreConversation?: (conversationId: string) => Promise<AgentConversation> | AgentConversation;
}) {
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  const calls = {
    closeConversation: [] as string[],
    createConversation: [] as AgentCreateConversationOptions[],
    restoreLatestConversation: 0,
    restoreConversation: [] as string[],
    markConversationRead: [] as string[],
    queueFollowUp: [] as Array<{ conversationId: string; message: string; userViewContext?: AgentUserViewContext | null }>,
    resolveApproval: [] as Array<{ conversationId: string; requestId: string; approved: boolean; scope: AgentApprovalResolutionScope | undefined }>,
    resolveUserQuestion: [] as Array<{ conversationId: string; requestId: string; result: AskUserQuestionResult }>,
    steerConversation: [] as Array<{ conversationId: string; message: string }>,
    sendMessage: [] as Array<{
      conversationId: string;
      message: string;
      userViewContext?: AgentUserViewContext | null;
    }>,
    stopRun: [] as Array<{ conversationId: string; runId: string }>,
  };

  const client: AgentRuntimeClient = {
    restoreLatestConversation: async () => {
      calls.restoreLatestConversation += 1;
      return options.latestConversation;
    },
    restoreConversation: async (conversationId) => {
      calls.restoreConversation.push(conversationId);
      if (options.restoreConversation) return options.restoreConversation(conversationId);
      if (conversationId === DEFAULT_GENERAL_CHANNEL_ID) {
        return options.defaultConversation ?? options.latestConversation;
      }
      return conversation(conversationId, projection([]));
    },
    markConversationRead: async (conversationId) => {
      calls.markConversationRead.push(conversationId);
    },
    createConversation: async (createOptions) => {
      calls.createConversation.push(createOptions);
      return options.createdConversation ?? conversation('created', projection([]));
    },
    closeConversation: async (conversationId) => {
      calls.closeConversation.push(conversationId);
    },
    sendMessage: async (conversationId, message, _attachments, userViewContext) => {
      calls.sendMessage.push({ conversationId, message, userViewContext });
    },
    editMessage: async () => {},
    regenerateMessage: async () => {},
    retryMessage: async () => {},
    switchBranch: async () => {},
    queueFollowUp: async (conversationId, message, userViewContext) => {
      calls.queueFollowUp.push({ conversationId, message, userViewContext });
      return { queued: true };
    },
    clearFollowUp: async () => {},
    steerConversation: async (conversationId, message) => {
      calls.steerConversation.push({ conversationId, message });
      return { queued: true };
    },
    clearSteer: async () => {},
    resolveApproval: async (conversationId, requestId, approved, scope) => {
      calls.resolveApproval.push({ conversationId, requestId, approved, scope });
      return { resolved: true };
    },
    resolveUserQuestion: async (conversationId, requestId, result) => {
      calls.resolveUserQuestion.push({ conversationId, requestId, result });
      return { resolved: true };
    },
    stopConversation: async () => {},
    stopRun: async (conversationId, runId) => {
      calls.stopRun.push({ conversationId, runId });
    },
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

function memoryConversationPreferenceStore(initial: string | null = null): AgentConversationPreferenceStore & {
  value: () => string | null;
  writes: () => Array<string | null>;
} {
  let value = initial;
  const writes: Array<string | null> = [];
  return {
    readLastConversationId: () => value,
    writeLastConversationId: (conversationId) => {
      value = conversationId;
      writes.push(conversationId);
    },
    value: () => value,
    writes: () => writes.slice(),
  };
}

describe('agent runtime store', () => {
  test('hydrates conversation from restore command response without waiting for an event', async () => {
    const restored = conversation('saved', projection([
      { nodeId: 'u1', message: userMessage('hello'), branches: null },
      { nodeId: 'a1', message: assistantMessage('hi'), branches: null },
    ]));
    const fake = createFakeClient({ latestConversation: restored });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});

    await flushMicrotasks();

    expect(fake.calls.restoreConversation).toEqual([DEFAULT_GENERAL_CHANNEL_ID]);
    expect(fake.calls.restoreLatestConversation).toBe(0);
    expect(store.getSnapshot().conversationId).toBe('saved');
    expect(store.getSnapshot().entries.map((entry) => entry.nodeId))
      .toEqual(['u1', 'a1']);
    expect(fake.calls.closeConversation).toEqual([]);
    unsubscribe();
  });

  test('restores the remembered conversation before falling back to #General', async () => {
    const preferenceStore = memoryConversationPreferenceStore('remembered-channel');
    const fake = createFakeClient({ latestConversation: conversation(DEFAULT_GENERAL_CHANNEL_ID, projection([])) });
    const store = createAgentRuntimeStore(fake.client, { conversationPreferenceStore: preferenceStore });
    const unsubscribe = store.subscribe(() => {});

    await flushMicrotasks();

    expect(fake.calls.restoreConversation).toEqual(['remembered-channel']);
    expect(fake.calls.restoreLatestConversation).toBe(0);
    expect(store.getSnapshot().conversationId).toBe('remembered-channel');
    expect(preferenceStore.value()).toBe('remembered-channel');
    unsubscribe();
  });

  test('falls back to latest when remembered and #General no longer restore', async () => {
    const preferenceStore = memoryConversationPreferenceStore('deleted-channel');
    const fake = createFakeClient({
      latestConversation: conversation(DEFAULT_GENERAL_CHANNEL_ID, projection([])),
      restoreConversation: async (conversationId) => {
        throw new Error(`Missing conversation: ${conversationId}`);
      },
    });
    const store = createAgentRuntimeStore(fake.client, { conversationPreferenceStore: preferenceStore });
    const unsubscribe = store.subscribe(() => {});

    await flushMicrotasks();

    expect(fake.calls.restoreConversation).toEqual(['deleted-channel', DEFAULT_GENERAL_CHANNEL_ID]);
    expect(fake.calls.restoreLatestConversation).toBe(1);
    expect(store.getSnapshot().conversationId).toBe(DEFAULT_GENERAL_CHANNEL_ID);
    expect(preferenceStore.value()).toBe(DEFAULT_GENERAL_CHANNEL_ID);
    unsubscribe();
  });

  test('remembers explicit conversation switches and newly created conversations', async () => {
    const preferenceStore = memoryConversationPreferenceStore();
    const created = conversation('created-channel', projection([
      { nodeId: 'u-created', message: userMessage('new'), branches: null },
    ]));
    const fake = createFakeClient({
      latestConversation: conversation('saved', projection([])),
      createdConversation: created,
    });
    const store = createAgentRuntimeStore(fake.client, { conversationPreferenceStore: preferenceStore });
    const unsubscribe = store.subscribe(() => {});

    await flushMicrotasks();
    expect(preferenceStore.value()).toBe('saved');

    await store.getSnapshot().selectConversation('other-dm');
    await flushMicrotasks();
    expect(preferenceStore.value()).toBe('other-dm');

    await store.getSnapshot().newConversation({ title: 'Created channel' });
    await flushMicrotasks();
    expect(preferenceStore.value()).toBe('created-channel');
    unsubscribe();
  });

  test('omits persisted user image summaries from visible message text', async () => {
    const user: UserMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'Review [[file:shot.png^%2Ftmp%2Fshot.png]].' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      ],
      timestamp: 1,
    };
    const restored = conversation('saved', projection([
      { nodeId: 'u1', message: user, branches: null },
    ]));
    const fake = createFakeClient({ latestConversation: restored });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});

    await flushMicrotasks();

    const entry = store.getSnapshot().entries[0];
    expect(entry?.kind).toBe('message');
    expect(entry?.message.role).toBe('user');
    expect(entry?.message.content).toEqual([
      { type: 'text', text: 'Review [[file:shot.png^%2Ftmp%2Fshot.png]].' },
    ]);
    unsubscribe();
  });

  test('tracks pending approval requests and clears them after resolve', async () => {
    const fake = createFakeClient({ latestConversation: conversation('saved', projection([], { isStreaming: true })) });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});

    await flushMicrotasks();

    fake.emit({
      type: 'approval_request',
      conversationId: 'saved',
      requestId: 'approval-1',
      request: {
        requestId: 'approval-1',
        conversationId: 'saved',
        kind: 'tool_permission',
        toolCallId: 'tool-1',
        toolName: 'bash',
        title: 'Approve GitHub push?',
        target: 'git push origin codex/foo',
        reason: 'This changes external state on a git remote.',
        details: [{ label: 'Command', value: 'git push origin codex/foo' }],
      },
      timestamp: 10,
    });

    expect(store.getSnapshot().pendingApproval?.requestId).toBe('approval-1');

    await store.getSnapshot().resolveApproval('approval-1', true, 'once');

    expect(fake.calls.resolveApproval).toEqual([{
      conversationId: 'saved',
      requestId: 'approval-1',
      approved: true,
      scope: 'once',
    }]);
    expect(store.getSnapshot().pendingApproval).toBeNull();
    unsubscribe();
  });

  test('threads cross-conversation unread attention and clears it on zero', async () => {
    const fake = createFakeClient({ latestConversation: conversation('saved', projection([])) });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});

    await flushMicrotasks();

    // Attention for a conversation other than the active one still updates (badges
    // are cross-conversation, unlike projection/approval events).
    fake.emit({
      type: 'conversation_attention',
      conversationId: 'other',
      unreadCount: 3,
      timestamp: 10,
    });
    expect(store.getSnapshot().unreadByConversationId.get('other')).toBe(3);

    fake.emit({
      type: 'conversation_attention',
      conversationId: 'other',
      unreadCount: 0,
      timestamp: 11,
    });
    expect(store.getSnapshot().unreadByConversationId.has('other')).toBe(false);
    unsubscribe();
  });

  test('marks read only when the dock is open, on genuine open, never on reload', async () => {
    const fake = createFakeClient({ latestConversation: conversation('saved', projection([])) });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});

    await flushMicrotasks();
    // Dock collapsed (default): startup does NOT clear unread (the conversation is
    // loaded but not visible — review N2).
    expect(fake.calls.markConversationRead).toEqual([]);

    // Opening the dock reads the conversation it reveals.
    store.setDockVisible(true);
    expect(fake.calls.markConversationRead).toEqual(['saved']);

    // Switching to another conversation while the dock is open is a genuine open.
    await store.getSnapshot().selectConversation('other');
    await flushMicrotasks();
    expect(fake.calls.markConversationRead).toEqual(['saved', 'other']);

    // A config reload re-restores the same conversation but must NOT mark it read
    // (that would clear unread on every model/settings toggle — review #6).
    await store.getSnapshot().reloadConversation();
    await flushMicrotasks();
    expect(fake.calls.markConversationRead).toEqual(['saved', 'other']);
    expect(fake.calls.restoreConversation).toContain('other');

    // Collapsing the dock then a switch does NOT clear unread (review N2).
    store.setDockVisible(false);
    await store.getSnapshot().selectConversation('third');
    await flushMicrotasks();
    expect(fake.calls.markConversationRead).toEqual(['saved', 'other']);
    unsubscribe();
  });

  test('queues multiple pending approval requests and shows the next one after resolution', async () => {
    const fake = createFakeClient({ latestConversation: conversation('saved', projection([], { isStreaming: true })) });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});

    await flushMicrotasks();

    const request = (requestId: string, target: string): AgentRuntimeEvent => ({
      type: 'approval_request',
      conversationId: 'saved',
      requestId,
      request: {
        requestId,
        conversationId: 'saved',
        kind: 'tool_permission',
        toolCallId: `tool-${requestId}`,
        toolName: 'bash',
        title: 'Approve command?',
        target,
        reason: 'This needs approval.',
        details: [{ label: 'Command', value: target }],
      },
      timestamp: 10,
    });

    fake.emit(request('approval-1', 'git push origin codex/foo'));
    fake.emit(request('approval-2', 'npm publish'));

    expect(store.getSnapshot().pendingApproval?.requestId).toBe('approval-1');

    await store.getSnapshot().resolveApproval('approval-1', true, 'once');

    expect(store.getSnapshot().pendingApproval?.requestId).toBe('approval-2');

    fake.emit({
      type: 'approval_resolved',
      conversationId: 'saved',
      requestId: 'approval-2',
      approved: false,
      timestamp: 20,
    });

    expect(store.getSnapshot().pendingApproval).toBeNull();
    unsubscribe();
  });

  test('tracks pending user questions and resolves structured answers', async () => {
    const fake = createFakeClient({ latestConversation: conversation('saved', projection([], { isStreaming: true })) });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});

    await flushMicrotasks();

    fake.emit({
      type: 'user_question_request',
      conversationId: 'saved',
      requestId: 'question-1',
      question: {
        requestId: 'question-1',
        conversationId: 'saved',
        runId: 'run-1',
        toolCallId: 'tool-question-1',
        request: {
          questions: [{
            id: 'direction',
            type: 'single_choice',
            question: 'Which path?',
            options: [
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B' },
            ],
          }],
        },
      },
      timestamp: 10,
    });

    expect(store.getSnapshot().pendingUserQuestion?.requestId).toBe('question-1');

    await store.getSnapshot().resolveUserQuestion('question-1', {
      requestId: 'question-1',
      answers: [{ questionId: 'direction', selectedOptionIds: ['b'] }],
    });

    expect(fake.calls.resolveUserQuestion).toEqual([{
      conversationId: 'saved',
      requestId: 'question-1',
      result: {
        requestId: 'question-1',
        answers: [{ questionId: 'direction', selectedOptionIds: ['b'] }],
      },
    }]);
    expect(store.getSnapshot().pendingUserQuestion).toBeNull();
    unsubscribe();
  });

  test('filters hidden system reminder user rows from the visible conversation', async () => {
    const restored = conversation('saved', projection([
      { nodeId: 'system-notification', message: userMessage(systemReminder('Background child run completed.')), branches: null },
      { nodeId: 'a1', message: assistantMessage('handled notification'), branches: null },
    ]));
    const fake = createFakeClient({ latestConversation: restored });
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
    restoredProjection.transcriptRows = restoredProjection.rows;
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
      source: { fromMessageId: 'u1', throughMessageId: 'a1' },
      trigger: 'auto',
      createdAt: 10,
    };
    const fake = createFakeClient({ latestConversation: conversation('saved', restoredProjection) });
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

  test('keeps context clear rows as visible boundary entries', async () => {
    const restoredProjection = projection([]);
    restoredProjection.rows = [{
      id: 'context-clear:clear-root',
      kind: 'context-clear',
      messageId: 'clear-root',
      contextClearId: 'clear-1',
    }];
    restoredProjection.transcriptRows = restoredProjection.rows;
    restoredProjection.entities.messages['clear-root'] = {
      id: 'clear-root',
      role: 'user',
      status: 'completed',
      parentMessageId: null,
      content: [{ type: 'text', text: 'Context cleared.' }],
      createdAt: 10,
      updatedAt: 10,
      branches: null,
    };
    restoredProjection.entities.contextClears['clear-1'] = {
      id: 'clear-1',
      messageId: 'clear-root',
      source: { fromMessageId: 'u1', throughMessageId: 'a1' },
      createdAt: 10,
    };
    const fake = createFakeClient({ latestConversation: conversation('saved', restoredProjection) });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});

    await flushMicrotasks();

    expect(store.getSnapshot().entries).toEqual([{
      id: 'context-clear:clear-root',
      kind: 'context-clear',
      contextClear: restoredProjection.entities.contextClears['clear-1'],
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
    const fake = createFakeClient({ latestConversation: conversation('saved', restoredProjection) });
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

  test('keeps Dream rows as visible boundary entries', async () => {
    const restoredProjection = projection([]);
    restoredProjection.rows = [{
      id: 'dream:dream-anchor',
      kind: 'dream',
      messageId: 'dream-anchor',
      dreamId: 'dream-1',
    }];
    restoredProjection.transcriptRows = restoredProjection.rows;
    restoredProjection.entities.messages['dream-anchor'] = {
      id: 'dream-anchor',
      role: 'user',
      status: 'completed',
      parentMessageId: null,
      content: [{ type: 'text', text: systemReminder('Memory Dream completed.') }],
      createdAt: 20,
      updatedAt: 20,
      branches: null,
    };
    restoredProjection.entities.dreams['dream-1'] = {
      id: 'dream-1',
      messageId: 'dream-anchor',
      agentId: 'built-in:tenon:assistant',
      runId: 'dream-run-1',
      trigger: 'manual',
      status: 'completed',
      startedAt: 10,
      completedAt: 20,
      createdAt: 20,
      processed: { totalMessageCount: 2, totalCharCount: 240, consolidateOnly: false, conversations: {} },
      changes: { added: 1, updated: 0, forgotten: 0, skipped: 0 },
    };
    const fake = createFakeClient({ latestConversation: conversation('saved', restoredProjection) });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});

    await flushMicrotasks();

    expect(store.getSnapshot().entries).toEqual([{
      id: 'dream:dream-anchor',
      kind: 'dream',
      status: 'completed',
      dream: restoredProjection.entities.dreams['dream-1'],
    }]);
    unsubscribe();
  });

  test('keeps active Dream as a visible boundary entry', async () => {
    const restoredProjection = projection([
      { nodeId: 'u1', message: userMessage('dream this'), branches: null },
    ], {
      activeDream: {
        id: 'active-dream-1',
        trigger: 'manual',
        startedAt: 30,
      },
    });
    const fake = createFakeClient({ latestConversation: conversation('saved', restoredProjection) });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});

    await flushMicrotasks();

    expect(store.getSnapshot().entries.at(-1)).toEqual({
      id: 'active-dream:active-dream-1',
      kind: 'dream',
      status: 'active',
      dream: restoredProjection.activeDream,
    });
    unsubscribe();
  });

  test('keeps the restored conversation through unsubscribe and resubscribe races', async () => {
    const restore = deferred<AgentConversation>();
    const restored = conversation('saved', projection([
      { nodeId: 'u1', message: userMessage('persisted'), branches: null },
    ]));
    const fake = createFakeClient({ latestConversation: restore.promise });
    const store = createAgentRuntimeStore(fake.client);

    const unsubscribeFirst = store.subscribe(() => {});
    unsubscribeFirst();
    const unsubscribeSecond = store.subscribe(() => {});
    restore.resolve(restored);
    await flushMicrotasks();

    expect(fake.calls.restoreConversation).toEqual([DEFAULT_GENERAL_CHANNEL_ID]);
    expect(fake.calls.restoreLatestConversation).toBe(0);
    expect(fake.calls.closeConversation).toEqual([]);
    expect(store.getSnapshot().conversationId).toBe('saved');
    expect(store.getSnapshot().entries).toHaveLength(1);
    unsubscribeSecond();
  });

  test('closes the previous runtime conversation only on explicit new conversation', async () => {
    const restored = conversation('saved', projection([
      { nodeId: 'u1', message: userMessage('old'), branches: null },
    ]));
    const created = conversation('created', projection([
      { nodeId: 'u2', message: userMessage('new'), branches: null },
    ]));
    const fake = createFakeClient({ latestConversation: restored, createdConversation: created });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});
    await flushMicrotasks();

    await store.getSnapshot().newConversation({
      agentIds: ['built-in:tenon:assistant', 'user:mock:self'],
      title: 'New channel',
    });

    expect(fake.calls.createConversation).toHaveLength(1);
    expect(fake.calls.closeConversation).toEqual(['saved']);
    expect(store.getSnapshot().conversationId).toBe('created');
    expect(store.getSnapshot().entries.map((entry) => entry.nodeId))
      .toEqual(['u2']);
    unsubscribe();
  });

  test('keeps a stable assistant entry while a streamed turn starts producing text', async () => {
    const user = userMessage('hello', 42);
    const restored = conversation('saved', projection([
      { nodeId: 'u1', message: user, branches: null },
    ]));
    const fake = createFakeClient({ latestConversation: restored });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});
    await flushMicrotasks();

    fake.emit({
      type: 'projection',
      conversationId: 'saved',
      lastEventType: null,
      revision: 1,
      renderProjection: projection([{ nodeId: 'u1', message: user, branches: null }], {
        activeRuns: [{ runId: 'run-1', agentId: 'agent-1', startedAt: 45 }],
        isStreaming: true,
        revision: 1,
      }),
      timestamp: 100,
    });

    const pendingAssistant = store.getSnapshot().entries[1];
    expect(pendingAssistant?.kind).toBe('message');
    expect(pendingAssistant?.id).toBe('active-assistant:run-1');
    expect(pendingAssistant?.runStartedAtMs).toBe(45);
    expect(pendingAssistant?.message.role).toBe('assistant');
    expect(pendingAssistant?.message.content).toEqual([]);

    fake.emit({
      type: 'projection',
      conversationId: 'saved',
      lastEventType: null,
      revision: 2,
      renderProjection: projection([
        { nodeId: 'u1', message: user, branches: null },
        { nodeId: 'assistant-stream', message: assistantMessage('hi', 50), branches: null },
      ], {
        activeRuns: [{ runId: 'run-1', agentId: 'agent-1', startedAt: 45 }],
        isStreaming: true,
        streamingMessageId: 'assistant-stream',
        revision: 2,
      }),
      timestamp: 101,
    });

    const streamingAssistant = store.getSnapshot().entries[1];
    expect(streamingAssistant?.id).toBe('active-assistant:run-1');
    expect(streamingAssistant?.message.role).toBe('assistant');
    expect(streamingAssistant?.message.content).toEqual([{ type: 'text', text: 'hi' }]);
    unsubscribe();
  });

  test('anchors a retry placeholder to the active run instead of the old user message timestamp', async () => {
    const user = userMessage('hello', 42);
    const restored = conversation('saved', projection([
      { nodeId: 'u1', message: user, branches: null },
    ]));
    const fake = createFakeClient({ latestConversation: restored });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});
    await flushMicrotasks();

    fake.emit({
      type: 'projection',
      conversationId: 'saved',
      lastEventType: 'message_retry_started',
      revision: 2,
      renderProjection: projection([{ nodeId: 'u1', message: user, branches: null }], {
        activeRunId: 'retry-run',
        activeRuns: [{ runId: 'retry-run', agentId: 'agent-1', startedAt: 5_000 }],
        isStreaming: true,
        revision: 2,
      }),
      timestamp: 100,
    });

    const pendingAssistant = store.getSnapshot().entries[1];
    expect(pendingAssistant?.kind).toBe('message');
    expect(pendingAssistant?.id).toBe('active-assistant:retry-run');
    expect(pendingAssistant?.runStartedAtMs).toBe(5_000);
    expect(pendingAssistant?.message.timestamp).toBe(5_000);
    unsubscribe();
  });

  test('folds streaming projection patches without replacing unchanged derived objects', async () => {
    const user = userMessage('hello', 42);
    const streamed = assistantMessage('h', 50);
    const restoredProjection = projection([
      { nodeId: 'u1', message: user, branches: null },
      { nodeId: 'assistant-stream', message: streamed, branches: null },
    ], { isStreaming: true, streamingMessageId: 'assistant-stream', revision: 1 });
    const fake = createFakeClient({ latestConversation: conversation('saved', restoredProjection) });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});
    await flushMicrotasks();

    const before = store.getSnapshot();
    const userMessageRef = before.entries[0]?.kind === 'message' ? before.entries[0].message : null;
    const toolResultsRef = before.toolResults;
    const pendingToolCallIdsRef = before.pendingToolCallIds;
    const nextAssistant = {
      ...restoredProjection.entities.messages['assistant-stream']!,
      content: [{ type: 'text' as const, text: 'hi' }],
      updatedAt: 51,
    };

    fake.emit({
      type: 'projection_patch',
      conversationId: 'saved',
      lastEventType: 'message_update',
      revision: 2,
      patch: {
        baseRevision: 1,
        revision: 2,
        entities: { messages: { 'assistant-stream': nextAssistant } },
        streaming: {
          messageId: 'assistant-stream',
          rowId: 'assistant:assistant-stream',
          text: 'hi',
          updatedAt: 51,
        },
      },
      timestamp: 101,
    });

    const after = store.getSnapshot();
    expect(after.entries[0]?.kind === 'message' ? after.entries[0].message : null).toBe(userMessageRef);
    expect(after.toolResults).toBe(toolResultsRef);
    expect(after.pendingToolCallIds).toBe(pendingToolCallIdsRef);
    const streamingAssistant = after.entries[1];
    expect(streamingAssistant?.kind).toBe('message');
    expect(streamingAssistant?.id).toBe('active-assistant-42');
    expect(streamingAssistant?.message.role).toBe('assistant');
    expect(streamingAssistant?.message.content).toEqual([{ type: 'text', text: 'hi' }]);
    unsubscribe();
  });

  test('reloads the target conversation when a projection patch arrives before the baseline projection', async () => {
    const initial = deferred<AgentConversation>();
    const restoredProjection = projection([
      { nodeId: 'u1', message: userMessage('hello'), branches: null },
    ], { revision: 2 });
    const fake = createFakeClient({
      latestConversation: initial.promise,
      restoreConversation: (conversationId) => conversation(conversationId, restoredProjection),
    });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});

    fake.emit({
      type: 'projection_patch',
      conversationId: 'saved',
      lastEventType: 'message_update',
      revision: 2,
      patch: {
        baseRevision: 1,
        revision: 2,
      },
      timestamp: 101,
    });
    await flushMicrotasks();

    expect(fake.calls.restoreConversation).toEqual([DEFAULT_GENERAL_CHANNEL_ID, 'saved']);
    expect(store.getSnapshot().conversationId).toBe('saved');
    expect(store.getSnapshot().entries.map((entry) => entry.nodeId)).toEqual(['u1']);
    unsubscribe();
  });

  test('coalesces repeated projection patch mismatches into one conversation reload', async () => {
    const user = userMessage('hello', 42);
    const restoredProjection = projection([
      { nodeId: 'u1', message: user, branches: null },
    ], { revision: 1 });
    const reload = deferred<AgentConversation>();
    const fake = createFakeClient({
      latestConversation: conversation('saved', restoredProjection),
      restoreConversation: () => reload.promise,
    });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});
    await flushMicrotasks();

    const mismatchedPatch = {
      type: 'projection_patch' as const,
      conversationId: 'saved',
      lastEventType: 'message_update',
      revision: 3,
      patch: {
        baseRevision: 2,
        revision: 3,
      },
      timestamp: 101,
    };
    fake.emit(mismatchedPatch);
    fake.emit({ ...mismatchedPatch, revision: 4, patch: { baseRevision: 3, revision: 4 }, timestamp: 102 });
    await flushMicrotasks();

    expect(fake.calls.restoreConversation).toEqual([DEFAULT_GENERAL_CHANNEL_ID, 'saved']);
    reload.resolve(conversation('saved', restoredProjection));
    await flushMicrotasks();
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
    const fake = createFakeClient({ latestConversation: conversation('saved', restoredProjection) });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});
    await flushMicrotasks();

    const result = store.getSnapshot().toolResults.get('tool-1');
    expect(result?.content).toEqual([{ type: 'text', text: label }]);
    expect(result?.payloadRefs).toEqual([{ contentIndex: 0, payload, label }]);
    unsubscribe();
  });

  test('indexes sub-runs by parent tool call id for renderer lookup', async () => {
    const subRun = {
      id: 'run-1',
      agentId: 'built-in:test:neva',
      anchor: { type: 'conversation', agentId: 'built-in:test:neva', conversationId: 'saved' },
      conversationId: 'saved',
      title: 'Inspect child run UI',
      parentRunId: 'parent-run-1',
      parentToolCallId: 'tool-agent-1',
      runProfile: 'default',
      runProfileLabel: 'Default',
      status: 'completed',
      objectiveStatus: 'verified',
      objectiveRole: 'worker',
      context: 'full',
      startedAt: 100,
      updatedAt: 250,
      completedAt: 250,
    } satisfies AgentRenderRunEntity;
    const restored = conversation('saved', projection([
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
              description: 'Inspect child run UI',
              prompt: 'Inspect the current UI.',
            },
          }],
        },
        branches: null,
      },
    ], {
      runs: { [subRun.id]: subRun },
      runIds: [subRun.id],
    }));
    const fake = createFakeClient({ latestConversation: restored });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});

    await flushMicrotasks();

    const snapshot = store.getSnapshot();
    expect(snapshot.runIds).toEqual(['run-1']);
    expect(snapshot.subRuns['run-1']).toEqual(subRun);
    expect(snapshot.subRunsByParentToolCallId.get('tool-agent-1')).toEqual(subRun);
    unsubscribe();
  });

  test('passes user view context through user turns and queued follow-ups', async () => {
    const restored = conversation('saved', projection([]));
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
    const fake = createFakeClient({ latestConversation: restored });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});
    await flushMicrotasks();

    await store.getSnapshot().sendMessage('hello', [], userViewContext);
    await store.getSnapshot().queueFollowUp('next', userViewContext);
    await store.getSnapshot().steer('correct course');

    expect(fake.calls.sendMessage).toEqual([{
      conversationId: 'saved',
      message: 'hello',
      userViewContext,
    }]);
    expect(fake.calls.queueFollowUp).toEqual([{
      conversationId: 'saved',
      message: 'next',
      userViewContext,
    }]);
    expect(fake.calls.steerConversation).toEqual([{
      conversationId: 'saved',
      message: 'correct course',
    }]);
    unsubscribe();
  });

  test('ignores stale initial restore after an explicit conversation change', async () => {
    const restore = deferred<AgentConversation>();
    const restored = conversation('saved', projection([
      { nodeId: 'u1', message: userMessage('old'), branches: null },
    ]));
    const created = conversation('created', projection([
      { nodeId: 'u2', message: userMessage('new'), branches: null },
    ]));
    const fake = createFakeClient({ latestConversation: restore.promise, createdConversation: created });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});

    await store.getSnapshot().newConversation({
      agentIds: ['built-in:tenon:assistant', 'user:mock:self'],
      title: 'New channel',
    });
    restore.resolve(restored);
    await flushMicrotasks();

    expect(fake.calls.restoreConversation).toEqual([DEFAULT_GENERAL_CHANNEL_ID]);
    expect(fake.calls.restoreLatestConversation).toBe(0);
    expect(fake.calls.createConversation).toHaveLength(1);
    expect(store.getSnapshot().conversationId).toBe('created');
    expect(store.getSnapshot().entries.map((entry) => entry.nodeId))
      .toEqual(['u2']);
    unsubscribe();
  });
});
