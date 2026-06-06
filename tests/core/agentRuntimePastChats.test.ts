import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type Usage,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core } from '../../src/core/core';
import {
  getAgentEventActivePath,
  type AgentActor,
  type AgentEvent,
  type AgentPersistedContent,
} from '../../src/core/agentEventLog';
import { LIN_AGENT_EVENT_CHANNEL, type AgentRuntimeEvent } from '../../src/core/agentTypes';
import { AgentEventStore } from '../../src/main/agentEventStore';
import type { OutlinerToolHost } from '../../src/main/agentNodeTools';

const EMPTY_USAGE: Usage = {
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

const electronUserDataRoot = path.join(tmpdir(), 'lin-agent-runtime-past-chats-test-user-data');

mock.module('electron', () => ({
  app: {
    getPath: () => electronUserDataRoot,
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  session: {
    fromPartition: () => ({
      clearStorageData: async () => undefined,
    }),
  },
}));

type RuntimeModule = typeof import('../../src/main/agentRuntime');

let runtimeModulePromise: Promise<RuntimeModule> | null = null;

async function loadRuntimeModule() {
  runtimeModulePromise ??= import('../../src/main/agentRuntime');
  return runtimeModulePromise;
}

function hostFor(core: Core): OutlinerToolHost {
  return {
    getProjection: () => core.projection(),
    transaction: async (_meta, fn) => fn(),
    operationHistory: async () => ({ entries: [], count: 0 }),
    handle: async () => {
      throw new Error('node tools are not used in this integration test');
    },
  };
}

function createWindowSink() {
  const events: AgentRuntimeEvent[] = [];
  return {
    events,
    window: {
      webContents: {
        send: (channel: string, event: AgentRuntimeEvent) => {
          if (channel === LIN_AGENT_EVENT_CHANNEL) events.push(event);
        },
      },
    },
  };
}

function scriptedStream(
  responses: Array<AssistantMessage | ((context: Context, options: SimpleStreamOptions | undefined, model: Model<Api>) => AssistantMessage)>,
  onCall: (model: Model<Api>, context: Context) => void,
): { streamFn: StreamFn; pendingCount: () => number } {
  const queue = [...responses];
  return {
    pendingCount: () => queue.length,
    streamFn: ((model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
      onCall(model, context);
      const stream = createAssistantMessageEventStream();
      const step = queue.shift();
      queueMicrotask(() => {
        const response = step
          ? typeof step === 'function'
            ? step(context, options, model)
            : step
          : fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'No more scripted responses queued.' });
        const message = normalizeAssistantMessage(response, model);
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          stream.push({ type: 'error', reason: message.stopReason, error: message });
          stream.end(message);
          return;
        }
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        stream.push({ type: 'done', reason: message.stopReason as Exclude<StopReason, 'error' | 'aborted'>, message });
        stream.end(message);
      });
      return stream;
    }) as StreamFn,
  };
}

function normalizeAssistantMessage(message: AssistantMessage, model: Model<Api>): AssistantMessage {
  return {
    ...message,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: message.usage ?? EMPTY_USAGE,
    timestamp: message.timestamp ?? Date.now(),
  };
}

function textFromContext(context: Context): string {
  return JSON.stringify({
    messages: context.messages,
    tools: context.tools?.map((tool) => tool.name),
  });
}

const systemActor: AgentActor = { type: 'system' };
const userActor: AgentActor = { type: 'user', userId: 'user-1' };
const agentActor: AgentActor = { type: 'agent', agentId: 'agent-1' };

function base(sessionId: string, seq: number, type: AgentEvent['type'], actor: AgentActor = systemActor) {
  return {
    v: 1 as const,
    eventId: `${sessionId}-event-${seq}`,
    seq,
    sessionId,
    type,
    createdAt: 1_800_000_000_000 + seq,
    actor,
  };
}

async function seedPastSession(dataRoot: string): Promise<void> {
  const store = new AgentEventStore(dataRoot);
  const sessionId = 'past-session-focus';
  await store.appendEvents(sessionId, [
    { ...base(sessionId, 1, 'session.created'), title: 'Focus ring decision' },
    {
      ...base(sessionId, 2, 'user_message.created', userActor),
      messageId: 'past-user-focus',
      parentMessageId: null,
      content: [{ type: 'text', text: 'We chose cobalt blue for focus rings in the past chats tool UI.' }],
    },
    {
      ...base(sessionId, 3, 'assistant_message.started', agentActor),
      runId: 'past-run-focus',
      messageId: 'past-assistant-focus',
      parentMessageId: 'past-user-focus',
      providerId: 'test',
      modelId: 'test',
    },
    {
      ...base(sessionId, 4, 'assistant_message.completed', agentActor),
      messageId: 'past-assistant-focus',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Cobalt blue is the recorded focus-ring choice.' }],
    },
  ]);
}

function persistedText(content: AgentPersistedContent[]): string {
  return content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

describe('agent runtime past chats integration', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  test('recalls a prior session through search then read tool calls', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-past-chats-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-past-chats-data-'));
    roots.push(localRoot, dataRoot);
    await seedPastSession(dataRoot);

    const contexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('past_chats', { query: 'cobalt focus rings' }, { id: 'tool-past-search' }),
        ], { stopReason: 'toolUse' }),
        (context) => {
          contexts.push(textFromContext(context));
          return fauxAssistantMessage([
            fauxToolCall('past_chats', {
              message_id: 'past-user-focus',
              before_context: 0,
              after_context: 1,
            }, { id: 'tool-past-read' }),
          ], { stopReason: 'toolUse' });
        },
        (context) => {
          contexts.push(textFromContext(context));
          return fauxAssistantMessage(fauxText('We chose cobalt blue for focus rings.'));
        },
      ],
      (_model, context) => {
        contexts.push(textFromContext(context));
      },
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          modelId: 'gpt-4.1',
          reasoningLevel: 'low',
          enabled: true,
          apiKey: 'test-key',
        }),
        runtimeSettingsLoader: async () => ({
          permissionMode: 'trusted',
          automaticSkillsEnabled: false,
          slashSkillsEnabled: false,
          compactEnabled: true,
          additionalSkillDirectories: [],
          additionalAgentDirectories: [],
        }),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.createConversation();
    await runtime.sendMessage(created.conversationId, 'What did we decide last time about focus rings?');

    const replay = await new AgentEventStore(dataRoot).replay(created.conversationId);
    const activePath = getAgentEventActivePath(replay);
    const toolCalls = activePath.flatMap((message) => (
      message.content
        .filter((part): part is Extract<AgentPersistedContent, { type: 'toolCall' }> => part.type === 'toolCall')
        .map((part) => ({ name: part.name, arguments: part.arguments }))
    ));
    const toolResults = activePath.filter((message) => message.role === 'toolResult');
    const finalAssistantText = persistedText(activePath.at(-1)?.content ?? []);
    const contextText = contexts.join('\n');

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(toolCalls).toEqual([
      { name: 'past_chats', arguments: { query: 'cobalt focus rings' } },
      {
        name: 'past_chats',
        arguments: {
          message_id: 'past-user-focus',
          before_context: 0,
          after_context: 1,
        },
      },
    ]);
    expect(toolResults.map((message) => message.toolName)).toEqual(['past_chats', 'past_chats']);
    expect(contextText).toContain('"past_chats"');
    // Self-contained search result reaches the model with snippets...
    expect(contextText).toContain('snippet');
    expect(contextText).toContain('"past-user-focus"');
    // ...and the read result carries the full message text inline (no markdown block).
    expect(contextText).toContain('Cobalt blue is the recorded focus-ring choice.');
    expect(finalAssistantText).toBe('We chose cobalt blue for focus rings.');
  });
});
