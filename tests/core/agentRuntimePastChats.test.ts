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
import { createHash } from 'node:crypto';
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

function latestProjectionEvent(events: readonly AgentRuntimeEvent[]) {
  return [...events].reverse().find((event): event is Extract<AgentRuntimeEvent, { type: 'projection' }> => (
    event.type === 'projection'
  )) ?? null;
}

async function flushProjectionCoalescing() {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
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
      content: [{ type: 'text', text: 'We chose cobalt blue for focus rings in the agent UI.' }],
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

function memoryOriginWorkspace(localRoot: string): string {
  return `workspace:${createHash('sha256').update(path.resolve(localRoot)).digest('hex').slice(0, 16)}`;
}

describe('agent runtime past chats integration', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  test('runtime setting refresh keeps M1 tools in the live model tool set', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-tools-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-tools-data-'));
    roots.push(localRoot, dataRoot);
    const contexts: string[] = [];
    const script = scriptedStream(
      [fauxAssistantMessage(fauxText('Ready.'))],
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
          memoryIsolation: 'global',
          additionalSkillDirectories: [],
          additionalAgentDirectories: [],
        }),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.createConversation();
    await runtime.sendMessage(created.conversationId, 'Which tools are live?');
    const contextText = contexts.join('\n');

    expect(script.pendingCount()).toBe(0);
    expect(contextText).toContain('"ask_user_question"');
    expect(contextText).toContain('"runtime_status"');
    expect(contextText).toContain('"config"');
    expect(contextText).toContain('"doctor"');
    expect(contextText).toContain('"recall"');
    expect(contextText).toContain('"dream"');
    expect(contextText).not.toContain('"past_chats"');
  });

  test('agent can request Dream through the foreground tool surface', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-tool-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-tool-data-'));
    roots.push(localRoot, dataRoot);
    const dreamRequests: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('dream', { reason: 'test Dream memory' }, { id: 'tool-dream-test' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Dream test completed.')),
      ],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        dreamMemoryExtractionEnabled: true,
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
          memoryIsolation: 'global',
          additionalSkillDirectories: [],
          additionalAgentDirectories: [],
        }),
        streamFn: script.streamFn,
        completeSimpleFn: async (model, context) => {
          dreamRequests.push(textFromContext(context));
          return normalizeAssistantMessage(
            fauxAssistantMessage(JSON.stringify({
              actions: [{ type: 'add', fact: 'User is testing the Dream memory feature.' }],
            })),
            model as Model<Api>,
          );
        },
      },
    );

    const created = await runtime.createConversation();
    const sendPromise = runtime.sendMessage(created.conversationId, 'I want to test the Dream feature.');
    await waitFor(() => sink.events.some((event) => event.type === 'approval_request'));
    const approvalEvent = sink.events.find((event): event is Extract<AgentRuntimeEvent, { type: 'approval_request' }> => (
      event.type === 'approval_request'
    ));
    if (!approvalEvent) throw new Error('Expected Dream approval request.');
    expect(approvalEvent.request.toolName).toBe('dream');
    expect(approvalEvent.request.title).toBe('Approve Memory Dream?');
    await runtime.resolveApproval(created.conversationId, approvalEvent.requestId, true);
    await sendPromise;

    const replay = await new AgentEventStore(dataRoot).replay(created.conversationId);
    const activePath = getAgentEventActivePath(replay);
    const toolCalls = activePath.flatMap((message) => (
      message.content
        .filter((part): part is Extract<AgentPersistedContent, { type: 'toolCall' }> => part.type === 'toolCall')
        .map((part) => ({ name: part.name, arguments: part.arguments }))
    ));
    const toolResults = activePath.filter((message) => message.role === 'toolResult');
    const entries = await new AgentEventStore(dataRoot).listMemoryEntries('built-in:tenon:assistant');

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(toolCalls).toEqual([{ name: 'dream', arguments: { reason: 'test Dream memory' } }]);
    expect(toolResults.map((message) => message.toolName)).toEqual(['dream']);
    expect(persistedText(toolResults[0]?.content ?? [])).toContain('"status": "completed"');
    expect(persistedText(toolResults[0]?.content ?? [])).toContain('"run_id": "dream-run-');
    expect(entries.map((entry) => entry.fact)).toEqual(['User is testing the Dream memory feature.']);
    expect(dreamRequests.join('\n')).toContain('I want to test the Dream feature.');
    expect(dreamRequests.join('\n')).toContain('"tools":[]');
  });

  test('recalls durable memory with nested source evidence', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-past-chats-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-past-chats-data-'));
    roots.push(localRoot, dataRoot);
    await seedPastSession(dataRoot);
    await new AgentEventStore(dataRoot).addMemoryEntry('built-in:tenon:assistant', {
      id: 'memory-focus-ring',
      fact: 'Cobalt blue was chosen for focus rings.',
      sources: [{
        conversationId: 'past-session-focus',
        messageRange: ['past-user-focus', 'past-assistant-focus'],
        runId: 'past-run-focus',
        eventId: 'past-session-focus-event-4',
      }],
      createdAt: 30,
    });

    const contexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('recall', {
            query: 'cobalt focus rings',
            include_evidence: true,
          }, { id: 'tool-recall-search' }),
        ], { stopReason: 'toolUse' }),
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
      {
        name: 'recall',
        arguments: {
          query: 'cobalt focus rings',
          include_evidence: true,
        },
      },
    ]);
    expect(toolResults.map((message) => message.toolName)).toEqual(['recall']);
    expect(contextText).toContain('"recall"');
    expect(contextText).toContain('memory-focus-ring');
    expect(contextText).toContain('evidence');
    expect(contextText).toContain('past-user-focus');
    expect(contextText).toContain('We chose cobalt blue for focus rings in the agent UI.');
    expect(contextText).toContain('Cobalt blue is the recorded focus-ring choice.');
    expect(finalAssistantText).toBe('We chose cobalt blue for focus rings.');
  });

  test('injects remembered facts into the next user prompt context', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-data-'));
    roots.push(localRoot, dataRoot);
    await new AgentEventStore(dataRoot).addMemoryEntry('built-in:tenon:assistant', {
      id: 'memory-direct-style',
      fact: 'User prefers direct, concise engineering answers.',
      sources: [{ conversationId: 'past-conversation' }],
      createdAt: 30,
    });

    const contexts: string[] = [];
    const script = scriptedStream(
      [fauxAssistantMessage(fauxText('Acknowledged.'))],
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
    await runtime.sendMessage(created.conversationId, 'Please answer directly.');
    const contextText = contexts.join('\n');

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(contextText).toContain('"recall"');
    expect(contextText).toContain('<agent-memory>');
    expect(contextText).toContain('memory-direct-style');
    expect(contextText).toContain('User prefers direct, concise engineering answers.');
  });

  test('isolated memory mode injects only current-workspace memories', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-isolated-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-isolated-data-'));
    roots.push(localRoot, dataRoot);
    const store = new AgentEventStore(dataRoot);
    await store.addMemoryEntry('built-in:tenon:assistant', {
      id: 'memory-current-workspace',
      fact: 'Current workspace uses slate focus rings.',
      originWorkspace: memoryOriginWorkspace(localRoot),
      sources: [{ conversationId: 'current-workspace-conversation' }],
      createdAt: 30,
    });
    await store.addMemoryEntry('built-in:tenon:assistant', {
      id: 'memory-other-workspace',
      fact: 'Other workspace uses amber focus rings.',
      originWorkspace: 'workspace:other',
      sources: [{ conversationId: 'other-workspace-conversation' }],
      createdAt: 31,
    });

    const contexts: string[] = [];
    const script = scriptedStream(
      [fauxAssistantMessage(fauxText('Acknowledged.'))],
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
          memoryIsolation: 'isolated',
          additionalSkillDirectories: [],
          additionalAgentDirectories: [],
        }),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.createConversation();
    await runtime.sendMessage(created.conversationId, 'Which focus rings should I use here?');
    const contextText = contexts.join('\n');

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(contextText).toContain('memory-current-workspace');
    expect(contextText).toContain('Current workspace uses slate focus rings.');
    expect(contextText).not.toContain('memory-other-workspace');
    expect(contextText).not.toContain('Other workspace uses amber focus rings.');
  });

  test('recall tool respects isolated workspace and invalidated memory', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-recall-isolated-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-recall-isolated-data-'));
    roots.push(localRoot, dataRoot);
    const store = new AgentEventStore(dataRoot);
    await store.addMemoryEntry('built-in:tenon:assistant', {
      id: 'memory-current-recall',
      fact: 'Current workspace recall fact mentions teal focus rings.',
      originWorkspace: memoryOriginWorkspace(localRoot),
      sources: [{ conversationId: 'current-recall-conversation' }],
      createdAt: 30,
    });
    await store.addMemoryEntry('built-in:tenon:assistant', {
      id: 'memory-other-recall',
      fact: 'Other workspace recall fact mentions amber focus rings.',
      originWorkspace: 'workspace:other',
      sources: [{ conversationId: 'other-recall-conversation' }],
      createdAt: 31,
    });
    await store.addMemoryEntry('built-in:tenon:assistant', {
      id: 'memory-unscoped-recall',
      fact: 'Unscoped recall fact mentions violet focus rings.',
      sources: [{ conversationId: 'unscoped-recall-conversation' }],
      createdAt: 32,
    });
    await store.addMemoryEntry('built-in:tenon:assistant', {
      id: 'memory-invalidated-recall',
      fact: 'Invalidated recall fact mentions orange focus rings.',
      originWorkspace: memoryOriginWorkspace(localRoot),
      sources: [{ conversationId: 'invalidated-recall-conversation' }],
      createdAt: 33,
    });
    await store.removeMemoryEntry('built-in:tenon:assistant', 'memory-invalidated-recall', 'test');

    const contexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('recall', {
            query: 'focus rings',
            include_evidence: true,
          }, { id: 'tool-recall-isolated' }),
        ], { stopReason: 'toolUse' }),
        (context) => {
          contexts.push(textFromContext(context));
          return fauxAssistantMessage(fauxText('Only the current workspace memory applies.'));
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
          memoryIsolation: 'isolated',
          additionalSkillDirectories: [],
          additionalAgentDirectories: [],
        }),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.createConversation();
    await runtime.sendMessage(created.conversationId, 'Recall focus-ring memories for this workspace.');

    const replay = await new AgentEventStore(dataRoot).replay(created.conversationId);
    const activePath = getAgentEventActivePath(replay);
    const toolResults = activePath.filter((message) => message.role === 'toolResult');
    const recallResult = JSON.parse(persistedText(toolResults[0]?.content ?? [])) as {
      data?: {
        entries?: Array<{ memory_id?: string; fact?: string }>;
        total_entries?: number;
      };
    };
    const postRecallContext = contexts.at(-1) ?? '';

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(toolResults.map((message) => message.toolName)).toEqual(['recall']);
    expect(recallResult.data?.total_entries).toBe(1);
    expect(recallResult.data?.entries?.map((entry) => ({
      memory_id: entry.memory_id,
      fact: entry.fact,
    }))).toEqual([{
      memory_id: 'memory-current-recall',
      fact: 'Current workspace recall fact mentions teal focus rings.',
    }]);
    expect(postRecallContext).toContain('memory-current-recall');
    expect(postRecallContext).toContain('Current workspace recall fact mentions teal focus rings.');
    expect(postRecallContext).not.toContain('memory-other-recall');
    expect(postRecallContext).not.toContain('Other workspace recall fact mentions amber focus rings.');
    expect(postRecallContext).not.toContain('memory-unscoped-recall');
    expect(postRecallContext).not.toContain('Unscoped recall fact mentions violet focus rings.');
    expect(postRecallContext).not.toContain('memory-invalidated-recall');
    expect(postRecallContext).not.toContain('Invalidated recall fact mentions orange focus rings.');
  });

  test('manual /dream saves durable memory from raw evidence since the watermark', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-data-'));
    roots.push(localRoot, dataRoot);
    const dreamRequests: string[] = [];
    const script = scriptedStream(
      [fauxAssistantMessage(fauxText('I will keep future engineering answers concise.'))],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        dreamMemoryExtractionEnabled: true,
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
          memoryIsolation: 'global',
          additionalSkillDirectories: [],
          additionalAgentDirectories: [],
        }),
        streamFn: script.streamFn,
        completeSimpleFn: async (model, context) => {
          dreamRequests.push(textFromContext(context));
          return normalizeAssistantMessage(
            fauxAssistantMessage(JSON.stringify({
              actions: [{ type: 'add', fact: 'User prefers concise engineering answers.' }],
            })),
            model as Model<Api>,
          );
        },
      },
    );

    const created = await runtime.createConversation();
    await runtime.sendMessage(created.conversationId, 'Please keep engineering answers concise from now on.');
    expect(await new AgentEventStore(dataRoot).listMemoryEntries('built-in:tenon:assistant')).toEqual([]);
    await runtime.sendMessage(created.conversationId, '/dream');
    await runtime.drainDreamMemoryExtractionForTest();

    const entries = await new AgentEventStore(dataRoot).listMemoryEntries('built-in:tenon:assistant');
    const source = entries[0]?.sources[0];

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(entries.map((entry) => entry.fact)).toEqual(['User prefers concise engineering answers.']);
    expect(entries[0]?.originWorkspace).toBe(memoryOriginWorkspace(localRoot));
    expect(source?.conversationId).toBe(created.conversationId);
    expect(typeof source?.eventId).toBe('string');
    expect(source?.messageRange?.length).toBe(2);
    expect(dreamRequests.join('\n')).toContain('Please keep engineering answers concise from now on.');
    expect(dreamRequests.join('\n')).toContain('I will keep future engineering answers concise.');
    expect(dreamRequests.join('\n')).toContain('"tools":[]');
    expect((await new AgentEventStore(dataRoot).readDreamState('built-in:tenon:assistant')).watermark.conversations[created.conversationId]?.seq).toBeGreaterThan(0);
    const projection = latestProjectionEvent(sink.events)?.renderProjection;
    const dreamRow = projection?.transcriptRows.find((row) => row.kind === 'dream');
    expect(dreamRow?.kind).toBe('dream');
    if (dreamRow?.kind === 'dream') {
      expect(typeof projection?.entities.dreams[dreamRow.dreamId]?.runId).toBe('string');
      expect(projection?.entities.dreams[dreamRow.dreamId]).toMatchObject({
        status: 'completed',
        processed: { totalMessageCount: 2 },
        changes: { added: 1, updated: 0, forgotten: 0, skipped: 0 },
      });
    }
  });

  test('scheduled dream skips thin evidence while manual /dream forces it', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-schedule-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-schedule-data-'));
    roots.push(localRoot, dataRoot);
    let dreamCalls = 0;
    const script = scriptedStream(
      [fauxAssistantMessage(fauxText('Noted.'))],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        dreamMemoryExtractionEnabled: true,
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
          memoryIsolation: 'global',
          additionalSkillDirectories: [],
          additionalAgentDirectories: [],
        }),
        streamFn: script.streamFn,
        completeSimpleFn: async (model) => {
          dreamCalls += 1;
          return normalizeAssistantMessage(
            fauxAssistantMessage(JSON.stringify({
              actions: [{ type: 'add', fact: 'User prefers compact acknowledgements.' }],
            })),
            model as Model<Api>,
          );
        },
      },
    );

    const created = await runtime.createConversation();
    await runtime.sendMessage(created.conversationId, 'Prefer compact acknowledgements.');
    await runtime.runScheduledDreamsForTest(new Date('2026-01-02T04:00:00'));
    expect(dreamCalls).toBe(0);
    expect(await new AgentEventStore(dataRoot).listMemoryEntries('built-in:tenon:assistant')).toEqual([]);

    await runtime.sendMessage(created.conversationId, '/dream');
    await runtime.drainDreamMemoryExtractionForTest();

    const entries = await new AgentEventStore(dataRoot).listMemoryEntries('built-in:tenon:assistant');
    const dreamState = await new AgentEventStore(dataRoot).readDreamState('built-in:tenon:assistant');

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(dreamCalls).toBe(1);
    expect(entries.map((entry) => entry.fact)).toEqual(['User prefers compact acknowledgements.']);
    expect(dreamState.lastCompleted?.trigger).toBe('manual');
  });

  test('scheduled dream fires for enough new evidence and records an agent-anchored run', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-auto-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-auto-data-'));
    roots.push(localRoot, dataRoot);
    let dreamCalls = 0;
    const longPreference = `Please remember this durable collaboration preference: ${'concise evidence '.repeat(90)}`;
    const script = scriptedStream(
      [fauxAssistantMessage(fauxText(`I will remember the collaboration preference. ${'grounded reply '.repeat(90)}`))],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        dreamMemoryExtractionEnabled: true,
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
          memoryIsolation: 'global',
          additionalSkillDirectories: [],
          additionalAgentDirectories: [],
        }),
        streamFn: script.streamFn,
        completeSimpleFn: async (model) => {
          dreamCalls += 1;
          return normalizeAssistantMessage(
            fauxAssistantMessage(JSON.stringify({
              actions: [{ type: 'add', fact: 'User has a durable collaboration preference for concise evidence.' }],
            })),
            model as Model<Api>,
          );
        },
      },
    );

    const created = await runtime.createConversation();
    await runtime.sendMessage(created.conversationId, longPreference);
    await runtime.runScheduledDreamsForTest(new Date('2026-01-02T04:00:00'));
    await flushProjectionCoalescing();

    const store = new AgentEventStore(dataRoot);
    const entries = await store.listMemoryEntries('built-in:tenon:assistant');
    const dreamState = await store.readDreamState('built-in:tenon:assistant');
    const runId = dreamState.lastCompleted?.runId;
    const runMeta = runId ? await store.readRunMetaProjection(runId) : null;
    const projection = latestProjectionEvent(sink.events)?.renderProjection;
    const dreamTaskId = projection?.taskIds.find((taskId) => projection.entities.tasks[taskId]?.kind === 'dream');
    const dreamTask = dreamTaskId ? projection?.entities.tasks[dreamTaskId] : null;

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(dreamCalls).toBe(1);
    expect(entries.map((entry) => entry.fact)).toEqual(['User has a durable collaboration preference for concise evidence.']);
    expect(dreamState.lastCompleted?.trigger).toBe('schedule');
    expect(runMeta?.anchor).toEqual({ type: 'agent', agentId: 'built-in:tenon:assistant' });
    expect(runMeta?.kind).toBe('reflective');
    expect(dreamTask).toMatchObject({
      id: `dream:${runId}`,
      kind: 'dream',
      status: 'completed',
      trigger: 'schedule',
      runId,
      processed: {
        totalMessageCount: 2,
        consolidateOnly: false,
      },
      changes: { added: 1 },
    });
  });

  test('manual /dream with no new evidence consolidates memory without replaying old raw evidence', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-consolidate-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-consolidate-data-'));
    roots.push(localRoot, dataRoot);
    await new AgentEventStore(dataRoot).addMemoryEntry('built-in:tenon:assistant', {
      id: 'memory-stable',
      fact: 'User prefers stable concise memory.',
      originWorkspace: memoryOriginWorkspace(localRoot),
      sources: [{ conversationId: 'old-conversation' }],
      createdAt: 30,
    });
    const dreamRequests: string[] = [];
    let dreamCall = 0;
    const script = scriptedStream(
      [fauxAssistantMessage(fauxText('I will remember the stable preference.'))],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        dreamMemoryExtractionEnabled: true,
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
          memoryIsolation: 'global',
          additionalSkillDirectories: [],
          additionalAgentDirectories: [],
        }),
        streamFn: script.streamFn,
        completeSimpleFn: async (model, context) => {
          dreamRequests.push(textFromContext(context));
          dreamCall += 1;
          return normalizeAssistantMessage(
            fauxAssistantMessage(JSON.stringify({
              actions: dreamCall === 1
                ? []
                : [{ type: 'update', memory_id: 'memory-stable', fact: 'User prefers stable, concise memory.' }],
            })),
            model as Model<Api>,
          );
        },
      },
    );

    const created = await runtime.createConversation();
    await runtime.sendMessage(created.conversationId, 'Stable concise memory is preferred.');
    await runtime.sendMessage(created.conversationId, '/dream');
    await runtime.sendMessage(created.conversationId, '/dream');

    const updated = await new AgentEventStore(dataRoot).getMemoryEntry('built-in:tenon:assistant', 'memory-stable');
    const secondRequest = dreamRequests[1] ?? '';

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(dreamRequests).toHaveLength(2);
    expect(updated?.fact).toBe('User prefers stable, concise memory.');
    expect(secondRequest).toContain('(no new raw evidence)');
    expect(secondRequest).not.toContain('Stable concise memory is preferred.');
  });

  test('manual /dream only updates memory visible to the current isolation tier', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-isolated-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-isolated-data-'));
    roots.push(localRoot, dataRoot);
    const store = new AgentEventStore(dataRoot);
    await store.addMemoryEntry('built-in:tenon:assistant', {
      id: 'memory-current-style',
      fact: 'Current workspace prefers verbose answers.',
      originWorkspace: memoryOriginWorkspace(localRoot),
      sources: [{ conversationId: 'old-current-conversation' }],
      createdAt: 30,
    });
    await store.addMemoryEntry('built-in:tenon:assistant', {
      id: 'memory-other-style',
      fact: 'Other workspace prefers terse answers.',
      originWorkspace: 'workspace:other',
      sources: [{ conversationId: 'old-other-conversation' }],
      createdAt: 31,
    });
    const script = scriptedStream(
      [fauxAssistantMessage(fauxText('This workspace now prefers short answers.'))],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        dreamMemoryExtractionEnabled: true,
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
          memoryIsolation: 'isolated',
          additionalSkillDirectories: [],
          additionalAgentDirectories: [],
        }),
        streamFn: script.streamFn,
        completeSimpleFn: async (model) => normalizeAssistantMessage(
          fauxAssistantMessage(JSON.stringify({
            actions: [
              {
                type: 'update',
                memory_id: 'memory-current-style',
                fact: 'Current workspace prefers short answers.',
              },
              {
                type: 'forget',
                memory_id: 'memory-other-style',
                reason: 'not visible in this isolated workspace',
              },
            ],
          })),
          model as Model<Api>,
        ),
      },
    );

    const created = await runtime.createConversation();
    await runtime.sendMessage(created.conversationId, 'For this workspace, prefer short answers.');
    await runtime.sendMessage(created.conversationId, '/dream');
    await runtime.drainDreamMemoryExtractionForTest();

    const entries = await new AgentEventStore(dataRoot).listMemoryEntries('built-in:tenon:assistant', {
      includeInvalidated: true,
      limit: 10,
    });
    const current = entries.find((entry) => entry.id === 'memory-current-style');
    const other = entries.find((entry) => entry.id === 'memory-other-style');

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(current?.fact).toBe('Current workspace prefers short answers.');
    expect(current?.sources.some((source) => source.conversationId === created.conversationId)).toBe(true);
    expect(other?.status).toBe('active');
    expect(other?.fact).toBe('Other workspace prefers terse answers.');
  });

  test('manual /dream treats same-key updates as no-ops but records completion', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-noop-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-noop-data-'));
    roots.push(localRoot, dataRoot);
    const store = new AgentEventStore(dataRoot);
    await store.addMemoryEntry('built-in:tenon:assistant', {
      id: 'memory-style',
      fact: 'User prefers concise engineering answers.',
      originWorkspace: memoryOriginWorkspace(localRoot),
      sources: [{ conversationId: 'old-conversation' }],
      createdAt: 30,
    });
    const script = scriptedStream(
      [fauxAssistantMessage(fauxText('Concise engineering answers still apply.'))],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        dreamMemoryExtractionEnabled: true,
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
          memoryIsolation: 'isolated',
          additionalSkillDirectories: [],
          additionalAgentDirectories: [],
        }),
        streamFn: script.streamFn,
        completeSimpleFn: async (model) => normalizeAssistantMessage(
          fauxAssistantMessage(JSON.stringify({
            actions: [{
              type: 'update',
              memory_id: 'memory-style',
              fact: 'User prefers concise engineering answers.',
            }],
          })),
          model as Model<Api>,
        ),
      },
    );

    const created = await runtime.createConversation();
    await runtime.sendMessage(created.conversationId, 'Keep answers concise.');
    await runtime.sendMessage(created.conversationId, '/dream');
    await runtime.drainDreamMemoryExtractionForTest();

    const events = await new AgentEventStore(dataRoot).readMemoryEvents('built-in:tenon:assistant');
    const entry = await new AgentEventStore(dataRoot).getMemoryEntry('built-in:tenon:assistant', 'memory-style');

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(events.map((event) => event.type)).toEqual(['memory.entry_added', 'dream.completed']);
    expect(entry?.sources).toEqual([{ conversationId: 'old-conversation' }]);
  });

  test('manual /dream is disabled for read-only-global memory isolation', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-readonly-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-readonly-data-'));
    roots.push(localRoot, dataRoot);
    let dreamCalls = 0;
    const script = scriptedStream(
      [fauxAssistantMessage(fauxText('Understood.'))],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(Core.new()),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        dreamMemoryExtractionEnabled: true,
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
          memoryIsolation: 'read-only-global',
          additionalSkillDirectories: [],
          additionalAgentDirectories: [],
        }),
        streamFn: script.streamFn,
        completeSimpleFn: async (model) => {
          dreamCalls += 1;
          return normalizeAssistantMessage(
            fauxAssistantMessage(JSON.stringify({
              actions: [{ type: 'add', fact: 'This should not be saved.' }],
            })),
            model as Model<Api>,
          );
        },
      },
    );

    const created = await runtime.createConversation();
    await runtime.sendMessage(created.conversationId, 'Do not write memories in this workspace.');
    await runtime.sendMessage(created.conversationId, '/dream');
    await runtime.drainDreamMemoryExtractionForTest();

    const entries = await new AgentEventStore(dataRoot).listMemoryEntries('built-in:tenon:assistant');

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(dreamCalls).toBe(0);
    expect(entries).toEqual([]);
  });

});
