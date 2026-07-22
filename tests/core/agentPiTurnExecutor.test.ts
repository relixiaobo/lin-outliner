import { describe, expect, test } from 'bun:test';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { decodeThread, decodeTurn } from '../../src/core/agent/codec';
import type { AgentCoreNotification } from '../../src/core/agent/protocol';
import { ItemRecorder } from '../../src/main/agent/runtime/ItemRecorder';
import { PiEventNormalizer } from '../../src/main/agent/runtime/PiTurnExecutor';
import type { TurnExecutionContext } from '../../src/main/agent/runtime/types';
import { uuidV7 } from '../../src/main/agent/uuid';

describe('PiTurnExecutor event normalization', () => {
  test('serializes stream events and records authoritative message and command Items', async () => {
    const fixture = createContext();
    const normalizer = new PiEventNormalizer(fixture.context);
    const assistant = assistantMessage([{ type: 'text', text: 'Done' }]);

    normalizer.handle({ type: 'message_start', message: assistant });
    normalizer.handle({
      type: 'message_update',
      message: assistant,
      assistantMessageEvent: { type: 'text_delta', delta: 'Done' },
    } as AgentEvent);
    normalizer.handle({ type: 'message_end', message: assistant });
    normalizer.handle({
      type: 'tool_execution_start',
      toolCallId: 'call-bash-1',
      toolName: 'bash',
      args: { command: 'pwd' },
    });
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-bash-1',
      toolName: 'bash',
      result: {
        content: [{ type: 'text', text: '/workspace' }],
        details: { data: { exitCode: 0 } },
      },
      isError: false,
    });
    normalizer.handle({ type: 'agent_end', messages: [assistant] });
    await normalizer.flush();

    expect(fixture.notifications.map((notification) => notification.type)).toEqual([
      'item/started',
      'item/delta',
      'item/completed',
      'item/started',
      'item/completed',
    ]);
    expect(fixture.recorder.orderedItems()).toMatchObject([
      { type: 'agentMessage', text: 'Done', phase: 'final_answer' },
      {
        type: 'commandExecution',
        id: 'call-bash-1',
        command: 'pwd',
        status: 'completed',
        aggregatedOutput: '/workspace',
        exitCode: 0,
      },
    ]);
    expect(normalizer.tokensUsed).toBe(7);
    expect(normalizer.stopReason).toBe('stop');
  });

  test('uses the provider call id for collaboration control-plane identity', async () => {
    const fixture = createContext();
    const normalizer = new PiEventNormalizer(fixture.context);
    normalizer.handle({
      type: 'tool_execution_start',
      toolCallId: 'call-collab-1',
      toolName: 'collaboration__spawn_agent',
      args: { task_name: 'worker', message: 'Inspect it' },
    });
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-collab-1',
      toolName: 'collaboration__spawn_agent',
      result: {
        content: [{ type: 'text', text: 'spawned' }],
        details: { task_name: '/root/worker', thread_id: uuidV7(1_720_000_001_000), nickname: null },
      },
      isError: false,
    });
    await normalizer.flush();
    expect(fixture.recorder.orderedItems()[0]).toMatchObject({
      type: 'collabAgentToolCall',
      id: 'call-collab-1',
      tool: 'spawn_agent',
      status: 'completed',
      prompt: 'Inspect it',
    });
  });

  test('keeps completed Items immutable in the authoritative recorder', async () => {
    const fixture = createContext();
    const itemId = fixture.recorder.createItemId();
    const started = {
      type: 'agentMessage' as const,
      id: itemId,
      provenance: fixture.recorder.localProvenance(itemId),
      text: '',
      phase: 'final_answer' as const,
      memoryCitation: null,
    };
    const completed = { ...started, text: 'Done' };
    await fixture.recorder.started(started);
    await fixture.recorder.completed(completed);

    await expect(fixture.recorder.delta(itemId, {
      type: 'agentMessageText',
      delta: ' late mutation',
    })).rejects.toThrow('Completed Thread Item is immutable');
    await expect(fixture.recorder.completed(completed)).rejects.toThrow('already completed');
    expect(fixture.notifications.map((notification) => notification.type)).toEqual([
      'item/started',
      'item/completed',
    ]);
  });

  test('preserves partial stream content when an open Item is failed', async () => {
    const fixture = createContext();
    const itemId = fixture.recorder.createItemId();
    await fixture.recorder.started({
      type: 'agentMessage',
      id: itemId,
      provenance: fixture.recorder.localProvenance(itemId),
      text: '',
      phase: null,
      memoryCitation: null,
    });
    await fixture.recorder.delta(itemId, { type: 'agentMessageText', delta: 'Partial output' });

    await fixture.recorder.finishOpenItems('failed');

    expect(fixture.recorder.item(itemId)).toMatchObject({
      type: 'agentMessage',
      text: 'Partial output',
    });
    expect(fixture.notifications.at(-1)).toMatchObject({
      type: 'item/completed',
      item: { type: 'agentMessage', text: 'Partial output' },
    });
  });
});

function createContext(): {
  context: TurnExecutionContext;
  recorder: ItemRecorder;
  notifications: AgentCoreNotification[];
} {
  const threadId = uuidV7(1_720_000_000_000);
  const turnId = uuidV7(1_720_000_000_100);
  const thread = decodeThread({
    id: threadId,
    sessionId: uuidV7(1_720_000_000_001),
    parentThreadId: null,
    forkedFromId: null,
    agentNickname: null,
    agentRole: null,
    name: null,
    preview: '',
    ephemeral: true,
    source: 'app',
    threadSource: 'user',
    modelProvider: 'openai',
    cwd: '/workspace',
    createdAt: 1_720_000_000_000,
    updatedAt: 1_720_000_000_000,
    status: { type: 'active', activeFlags: [] },
    historyMode: 'paginated',
  });
  const turn = decodeTurn({
    id: turnId,
    items: [],
    itemsView: 'full',
    provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
    status: 'inProgress',
    error: null,
    startedAt: 1_720_000_000_100,
    completedAt: null,
    durationMs: null,
  });
  const notifications: AgentCoreNotification[] = [];
  const recorder = new ItemRecorder(threadId, turnId, [], async (notification) => {
    notifications.push(notification);
  });
  const context: TurnExecutionContext = {
    thread,
    turn,
    historyBeforeTurn: [],
    configuration: {
      profileName: 'default',
      developerInstructions: [],
      model: 'test-model',
      reasoningEffort: 'medium',
      tools: ['bash', 'collaboration.spawn_agent'],
      skills: [],
      plugins: [],
      mcpServers: [],
    },
    systemContext: [],
    signal: new AbortController().signal,
    recorder,
    onSteer: () => undefined,
  };
  return { context, recorder, notifications };
}

function assistantMessage(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-responses',
    provider: 'openai',
    model: 'test-model',
    usage: {
      input: 3,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 7,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 1_720_000_000_200,
  };
}
