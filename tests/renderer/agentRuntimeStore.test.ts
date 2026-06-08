import { describe, expect, test } from 'bun:test';
import {
  createAgentRuntimeStore,
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
import type { AgentConversation } from '../../src/core/types';
import type {
  AgentRenderActiveCompaction,
  AgentRenderActiveDream,
  AgentRenderDreamEntity,
  AgentRenderProjection,
  AgentRenderSubagentEntity,
  AgentRenderTaskEntity,
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
    activeDream?: AgentRenderActiveDream | null;
    dreams?: Record<string, AgentRenderDreamEntity>;
    subagents?: Record<string, AgentRenderSubagentEntity>;
    subagentRunIds?: string[];
    tasks?: Record<string, AgentRenderTaskEntity>;
    taskIds?: string[];
  } = {},
): AgentRenderProjection {
  const rows = entries.map((entry) => ({
    id: `${entry.message.role}:${entry.nodeId}`,
    kind: 'message' as const,
    messageId: entry.nodeId,
  }));
  const subagentTasks = Object.values(options.subagents ?? {}).map((subagent) => ({
    id: `subagent:${subagent.id}`,
    kind: 'subagent' as const,
    status: subagent.status,
    title: subagent.description.trim() || subagent.name?.trim() || subagent.id,
    subtitle: `${subagent.contextMode} · ${subagent.subagentType}`,
    startedAt: subagent.startedAt,
    updatedAt: subagent.updatedAt,
    completedAt: subagent.completedAt,
    subagentId: subagent.id,
  }));
  const tasks = {
    ...Object.fromEntries(subagentTasks.map((task) => [task.id, task])),
    ...(options.tasks ?? {}),
  };
  return {
    conversationId: 'saved',
    revision: options.revision ?? 1,
    conversationTitle: 'Saved conversation',
    activeRunId: options.isStreaming ? 'run-1' : null,
    activeCompaction: options.activeCompaction ?? null,
    activeDream: options.activeDream ?? null,
    isStreaming: !!options.isStreaming,
    model: { id: 'test-model', provider: 'test' },
    thinkingLevel: 'off',
    pendingToolCallIds: [],
    errorMessage: null,
    rows,
    transcriptRows: rows,
    taskIds: options.taskIds ?? Object.keys(tasks),
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
      dreams: options.dreams ?? {},
      tasks,
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

function subagentEntity(
  patch: Partial<AgentRenderSubagentEntity> & Pick<AgentRenderSubagentEntity, 'id'>,
): AgentRenderSubagentEntity {
  return {
    description: 'Inspect subagent UI',
    prompt: 'Inspect the current UI.',
    subagentType: 'explorer',
    contextMode: 'fork',
    status: 'completed',
    startedAt: 100,
    updatedAt: 260,
    completedAt: 260,
    result: 'Found the relevant UI path.',
    transcriptPayloadId: 'subagent-transcript-1',
    transcriptMessageCount: 4,
    parentToolCallId: 'tool-agent-1',
    ...patch,
  };
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
  await Promise.resolve();
  await Promise.resolve();
}

function createFakeClient(options: {
  latestConversation: Promise<AgentConversation> | AgentConversation;
  createdConversation?: AgentConversation;
}) {
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  const calls = {
    closeConversation: [] as string[],
    createConversation: 0,
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
  };

  const client: AgentRuntimeClient = {
    restoreLatestConversation: async () => {
      calls.restoreLatestConversation += 1;
      return options.latestConversation;
    },
    restoreConversation: async (conversationId) => {
      calls.restoreConversation.push(conversationId);
      return conversation(conversationId, projection([]));
    },
    markConversationRead: async (conversationId) => {
      calls.markConversationRead.push(conversationId);
    },
    createConversation: async () => {
      calls.createConversation += 1;
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
    const restored = conversation('saved', projection([
      { nodeId: 'u1', message: userMessage('hello'), branches: null },
      { nodeId: 'a1', message: assistantMessage('hi'), branches: null },
    ]));
    const fake = createFakeClient({ latestConversation: restored });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});

    await flushMicrotasks();

    expect(fake.calls.restoreLatestConversation).toBe(1);
    expect(store.getSnapshot().conversationId).toBe('saved');
    expect(store.getSnapshot().entries.map((entry) => entry.nodeId))
      .toEqual(['u1', 'a1']);
    expect(fake.calls.closeConversation).toEqual([]);
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

  test('derives task entries from subagent runs with running work first', async () => {
    const completed = subagentEntity({
      id: 'subagent-completed',
      description: 'Finished audit',
      status: 'completed',
      updatedAt: 300,
      completedAt: 300,
    });
    const running = subagentEntity({
      id: 'subagent-running',
      description: 'Long research',
      status: 'running',
      updatedAt: 200,
      completedAt: undefined,
    });
    const restored = conversation('saved', projection([], {
      subagentRunIds: [completed.id, running.id],
      subagents: {
        [completed.id]: completed,
        [running.id]: running,
      },
    }));
    const fake = createFakeClient({ latestConversation: restored });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});

    await flushMicrotasks();

    expect(store.getSnapshot().tasks.map((task) => ({
      id: task.id,
      status: task.status,
      title: task.title,
      subtitle: task.subtitle,
      subagentId: task.subagentId,
    }))).toEqual([
      {
        id: 'subagent:subagent-running',
        status: 'running',
        title: 'Long research',
        subtitle: 'fork · explorer',
        subagentId: 'subagent-running',
      },
      {
        id: 'subagent:subagent-completed',
        status: 'completed',
        title: 'Finished audit',
        subtitle: 'fork · explorer',
        subagentId: 'subagent-completed',
      },
    ]);
    unsubscribe();
  });

  test('derives Dream task entries from agent-level task projection', async () => {
    const dreamTask: AgentRenderTaskEntity = {
      id: 'dream:dream-run-1',
      kind: 'dream',
      status: 'completed',
      trigger: 'schedule',
      startedAt: 100,
      updatedAt: 150,
      completedAt: 150,
      runId: 'dream-run-1',
      processed: { totalMessageCount: 4, totalCharCount: 1200, consolidateOnly: false },
      changes: { added: 1, updated: 1, forgotten: 0, skipped: 0 },
    };
    const restored = conversation('saved', projection([], {
      taskIds: [dreamTask.id],
      tasks: { [dreamTask.id]: dreamTask },
    }));
    const fake = createFakeClient({ latestConversation: restored });
    const store = createAgentRuntimeStore(fake.client);
    const unsubscribe = store.subscribe(() => {});

    await flushMicrotasks();

    expect(store.getSnapshot().tasks).toEqual([dreamTask]);
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
      { nodeId: 'system-notification', message: userMessage(systemReminder('Background subagent completed.')), branches: null },
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

  test('keeps the restored session through unsubscribe and resubscribe races', async () => {
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

    expect(fake.calls.restoreLatestConversation).toBe(1);
    expect(fake.calls.closeConversation).toEqual([]);
    expect(store.getSnapshot().conversationId).toBe('saved');
    expect(store.getSnapshot().entries).toHaveLength(1);
    unsubscribeSecond();
  });

  test('closes the previous runtime session only on explicit new session', async () => {
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

    await store.getSnapshot().newConversation();

    expect(fake.calls.createConversation).toBe(1);
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
      conversationId: 'saved',
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
    const fake = createFakeClient({ latestConversation: conversation('saved', restoredProjection) });
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
    const fake = createFakeClient({ latestConversation: restored });
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

  test('ignores stale initial restore after an explicit session change', async () => {
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

    await store.getSnapshot().newConversation();
    restore.resolve(restored);
    await flushMicrotasks();

    expect(fake.calls.restoreLatestConversation).toBe(1);
    expect(fake.calls.createConversation).toBe(1);
    expect(store.getSnapshot().conversationId).toBe('created');
    expect(store.getSnapshot().entries.map((entry) => entry.nodeId))
      .toEqual(['u2']);
    unsubscribe();
  });
});
