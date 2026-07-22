import { describe, expect, test } from 'bun:test';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import { decodeThread, decodeTurn } from '../../src/core/agent/codec';
import type { AgentCoreNotification } from '../../src/core/agent/protocol';
import { ItemRecorder } from '../../src/main/agent/runtime/ItemRecorder';
import {
  MAX_PERSISTED_TOOL_ARGUMENT_CHARS,
  MAX_PERSISTED_TOOL_OUTPUT_CHARS,
  MAX_PERSISTED_TOOL_OUTPUT_IMAGES,
  PiEventNormalizer,
  PiTurnExecutor,
  historyMessages,
  modelUserMessage,
} from '../../src/main/agent/runtime/PiTurnExecutor';
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

  test('gives the model a readable path for non-image attachments', () => {
    const message = modelUserMessage([{
      type: 'attachment',
      id: 'attachment-1',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 512,
      source: { kind: 'localFile', path: '/workspace/agent-attachments/report.pdf' },
    }], 1_720_000_000_000);

    expect(message.content).toEqual([{
      type: 'text',
      text: '[Attachment: report.pdf, application/pdf, 512 bytes]\nReadable path: /workspace/agent-attachments/report.pdf\nUse file_read with this path to inspect the attachment.',
    }]);
  });

  test('does not create an Agent when Stop arrives during any async initialization stage', async () => {
    for (const stage of ['runtime', 'tools', 'skills', 'systemPrompt'] as const) {
      const fixture = createContext();
      const controller = new AbortController();
      const entered = deferred<void>();
      const release = deferred<void>();
      let agentCreations = 0;
      const waitAt = async (candidate: typeof stage) => {
        if (candidate !== stage) return;
        entered.resolve();
        await release.promise;
      };
      const executor = new PiTurnExecutor({
        resolveRuntime: async () => {
          await waitAt('runtime');
          return runtimeSelection();
        },
        createTools: async () => {
          await waitAt('tools');
          return [];
        },
        skillListing: async () => {
          await waitAt('skills');
          return null;
        },
        systemPrompt: async () => {
          await waitAt('systemPrompt');
          return 'system';
        },
        createAgent: () => {
          agentCreations += 1;
          throw new Error('Agent must not be created after Stop');
        },
      });
      const execution = executor.execute({ ...fixture.context, signal: controller.signal });
      await entered.promise;
      controller.abort();
      release.resolve();

      await expect(execution).resolves.toEqual({ status: 'interrupted' });
      expect(agentCreations).toBe(0);
    }
  });

  test('reconstructs canonical tool calls, results, and reasoning for later Turns', () => {
    const fixture = createContext();
    const threadId = fixture.context.thread.id;
    const turnId = fixture.context.turn.id;
    const provenance = (id: string) => ({ originThreadId: threadId, originTurnId: turnId, originItemId: id });
    const context: TurnExecutionContext = {
      ...fixture.context,
      historyBeforeTurn: [{
        ...fixture.context.turn,
        status: 'completed',
        completedAt: 1_720_000_000_200,
        durationMs: 100,
        items: [
          { type: 'userMessage', id: 'user-1', provenance: provenance('user-1'), clientId: null, content: [{ type: 'text', text: 'Inspect it' }] },
          { type: 'agentMessage', id: 'agent-1', provenance: provenance('agent-1'), text: 'Checking.', phase: 'commentary', memoryCitation: null },
          { type: 'reasoning', id: 'reason-1', provenance: provenance('reason-1'), summary: ['Need evidence'], content: ['Inspect the workspace'] },
          {
            type: 'commandExecution',
            id: 'call-1',
            provenance: provenance('call-1'),
            command: 'pwd',
            cwd: '/workspace',
            processId: null,
            status: 'completed',
            commandActions: [],
            aggregatedOutput: '/workspace',
            exitCode: 0,
            durationMs: 5,
          },
          {
            type: 'mcpToolCall',
            id: 'call-2',
            provenance: provenance('call-2'),
            server: 'docs',
            tool: 'search',
            status: 'completed',
            arguments: { query: 'Thread' },
            pluginId: null,
            result: { matches: 2 },
            error: null,
            durationMs: 7,
          },
        ],
      }],
    };

    const messages = historyMessages(context, testModel);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult', 'toolResult']);
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      stopReason: 'toolUse',
      content: [
        { type: 'text', text: 'Checking.' },
        { type: 'text', text: '[Reasoning]\nNeed evidence\nInspect the workspace' },
        { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pwd', cwd: '/workspace' } },
        { type: 'toolCall', id: 'call-2', name: 'docs__search', arguments: { query: 'Thread' } },
      ],
    });
    expect(messages[2]).toMatchObject({ role: 'toolResult', toolCallId: 'call-1', content: [{ text: '/workspace' }] });
    expect(messages[3]).toMatchObject({ role: 'toolResult', toolCallId: 'call-2', content: [{ text: '{"matches":2}' }] });
  });

  test('bounds persisted tool projections and stores image paths instead of base64', async () => {
    const fixture = createContext();
    const normalizer = new PiEventNormalizer(fixture.context);
    const oversized = 'x'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS * 3);
    normalizer.handle({
      type: 'tool_execution_start',
      toolCallId: 'call-file-1',
      toolName: 'file_read',
      args: { file_path: '/workspace/large.png', echoed: oversized },
    });
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-file-1',
      toolName: 'file_read',
      result: {
        content: [
          { type: 'text', text: oversized },
          { type: 'image', data: 'base64-image-secret', mimeType: 'image/png' },
        ],
        details: {
          ok: true,
          tool: 'file_read',
          version: 1,
          status: 'success',
          data: { type: 'image', file: { filePath: '/workspace/large.png', base64: 'base64-image-secret' } },
        },
      },
      isError: false,
    });
    normalizer.handle({
      type: 'tool_execution_start',
      toolCallId: 'call-bash-2',
      toolName: 'bash',
      args: { command: 'produce output' },
    });
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-bash-2',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: oversized }], details: { data: { exitCode: 0 } } },
      isError: false,
    });
    normalizer.handle({
      type: 'tool_execution_start',
      toolCallId: 'call-images-3',
      toolName: 'inspect_images',
      args: {},
    });
    normalizer.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-images-3',
      toolName: 'inspect_images',
      result: {
        content: Array.from({ length: MAX_PERSISTED_TOOL_OUTPUT_IMAGES + 5 }, (_, index) => ({
          type: 'image' as const,
          data: `base64-image-${index}`,
          mimeType: 'image/png',
        })),
      },
      isError: false,
    });
    await normalizer.flush();

    const [fileRead, command, images] = fixture.recorder.orderedItems();
    expect(fileRead).toMatchObject({
      type: 'dynamicToolCall',
      contentItems: [
        { type: 'text' },
        { type: 'image', imageRef: '/workspace/large.png' },
      ],
    });
    expect(JSON.stringify(fileRead)).not.toContain('base64-image-secret');
    expect(JSON.stringify((fileRead as Extract<typeof fileRead, { type: 'dynamicToolCall' }>).arguments).length)
      .toBeLessThanOrEqual(MAX_PERSISTED_TOOL_ARGUMENT_CHARS);
    expect(command).toMatchObject({ type: 'commandExecution', status: 'completed' });
    const output = (command as Extract<typeof command, { type: 'commandExecution' }>).aggregatedOutput!;
    expect(output.length).toBeLessThanOrEqual(MAX_PERSISTED_TOOL_OUTPUT_CHARS);
    expect(output).toContain('chars omitted');
    expect(images).toMatchObject({ type: 'dynamicToolCall', status: 'completed' });
    expect((images as Extract<typeof images, { type: 'dynamicToolCall' }>).contentItems)
      .toHaveLength(MAX_PERSISTED_TOOL_OUTPUT_IMAGES);
    expect(JSON.stringify(images)).not.toContain('base64-image-');
  });
});

const testModel = {
  id: 'test-model',
  name: 'Test Model',
  api: 'openai-responses',
  provider: 'openai',
  baseUrl: 'https://example.test',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as Model<Api>;

function runtimeSelection() {
  return {
    model: testModel,
    thinkingLevel: 'medium' as const,
    getApiKey: async () => undefined,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

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
    persistOutputImage: async () => '/workspace/tool-output.png',
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
