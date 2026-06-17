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
  type AgentMemorySource,
  type AgentPersistedContent,
  type AgentPrincipal,
} from '../../src/core/agentEventLog';
import { LIN_AGENT_EVENT_CHANNEL, type AgentRuntimeEvent } from '../../src/core/agentTypes';
import { AgentEventStore } from '../../src/main/agentEventStore';
import type { OutlinerToolHost } from '../../src/main/agentNodeTools';

const agentPrincipal = (agentId: string): AgentPrincipal => ({ type: 'agent', agentId });
// Mirrors LOCAL_USER_ID in agentRuntime — the single-user principal that owns the user pool.
const USER_PRINCIPAL: AgentPrincipal = { type: 'user', userId: 'local-user' };

function conversationSource(
  conversationId: string,
  options: { fromSeqExclusive?: number; throughSeq?: number; throughEventId?: string } = {},
): AgentMemorySource {
  const throughSeq = options.throughSeq ?? 1;
  return {
    stream: 'conversation',
    streamId: conversationId,
    range: {
      fromSeqExclusive: options.fromSeqExclusive ?? 0,
      throughSeq,
      throughEventId: options.throughEventId ?? `${conversationId}-event-${throughSeq}`,
    },
  };
}

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

function base(conversationId: string, seq: number, type: AgentEvent['type'], actor: AgentActor = systemActor) {
  return {
    v: 1 as const,
    eventId: `${conversationId}-event-${seq}`,
    seq,
    conversationId,
    type,
    createdAt: 1_800_000_000_000 + seq,
    actor,
  };
}

async function seedPastConversation(dataRoot: string): Promise<void> {
  const store = new AgentEventStore(dataRoot);
  const conversationId = 'past-conversation-focus';
  await store.appendEvents(conversationId, [
    { ...base(conversationId, 1, 'conversation.created'), title: 'Focus ring decision' },
    {
      ...base(conversationId, 2, 'user_message.created', userActor),
      messageId: 'past-user-focus',
      parentMessageId: null,
      content: [{ type: 'text', text: 'We chose cobalt blue for focus rings in the agent UI.' }],
    },
    {
      ...base(conversationId, 3, 'assistant_message.started', agentActor),
      runId: 'past-run-focus',
      messageId: 'past-assistant-focus',
      parentMessageId: 'past-user-focus',
      providerId: 'test',
      modelId: 'test',
    },
    {
      ...base(conversationId, 4, 'assistant_message.completed', agentActor),
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

    const created = await runtime.restoreLatestConversation();
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
          fauxToolCall('dream', {}, { id: 'tool-dream-test' }),
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

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'I want to test the Dream feature.');
    expect(sink.events.some((event) => event.type === 'approval_request')).toBe(false);

    const replay = await new AgentEventStore(dataRoot).replay(created.conversationId);
    const activePath = getAgentEventActivePath(replay);
    const toolCalls = activePath.flatMap((message) => (
      message.content
        .filter((part): part is Extract<AgentPersistedContent, { type: 'toolCall' }> => part.type === 'toolCall')
        .map((part) => ({ name: part.name, arguments: part.arguments }))
    ));
    const toolResults = activePath.filter((message) => message.role === 'toolResult');
    // Conversation-derived facts land in the user pool (the user-Dream), not the agent pool.
    const entries = await new AgentEventStore(dataRoot).listMemoryEntries(USER_PRINCIPAL);

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(toolCalls).toEqual([{ name: 'dream', arguments: {} }]);
    expect(toolResults.map((message) => message.toolName)).toEqual(['dream']);
    expect(persistedText(toolResults[0]?.content ?? [])).toContain('"status": "completed"');
    expect(persistedText(toolResults[0]?.content ?? [])).toContain('"run_id": "dream-run-');
    expect(entries.map((entry) => entry.fact)).toEqual(['User is testing the Dream memory feature.']);
    expect(dreamRequests.join('\n')).toContain('I want to test the Dream feature.');
    expect(dreamRequests.join('\n')).toContain('"tools":[]');
    const dreamRow = latestProjectionEvent(sink.events)?.renderProjection.transcriptRows.find((row) => row.kind === 'dream');
    expect(dreamRow?.kind).toBe('dream');
  });

  test('recalls durable memory with nested source evidence', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-past-chats-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-past-chats-data-'));
    roots.push(localRoot, dataRoot);
    await seedPastConversation(dataRoot);
    await new AgentEventStore(dataRoot).addMemoryEntry(agentPrincipal('built-in:tenon:assistant'), {
      id: 'memory-focus-ring',
      fact: 'uses cobalt blue for focus rings',
      sources: [conversationSource('past-conversation-focus', {
        fromSeqExclusive: 1,
        throughSeq: 4,
        throughEventId: 'past-conversation-focus-event-4',
      })],
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

    const created = await runtime.restoreLatestConversation();
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

  test('recall keeps episode gist evidence when raw episode sources no longer resolve', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-recall-episode-gist-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-recall-episode-gist-data-'));
    roots.push(localRoot, dataRoot);
    const principal = agentPrincipal('built-in:tenon:assistant');
    const store = new AgentEventStore(dataRoot);
    const episode = await store.recordMemoryEpisode(principal, {
      id: 'episode-recall-raw-missing',
      gist: 'Durable gist survives raw loss in recall evidence.',
      sources: [conversationSource('missing-recall-conversation', {
        fromSeqExclusive: 1,
        throughSeq: 2,
        throughEventId: 'missing-recall-conversation-event-2',
      })],
      createdAt: 25,
    });
    await store.addMemoryEntry(principal, {
      id: 'memory-recall-raw-missing',
      fact: 'prefers recall to keep durable episode gist evidence',
      sources: [{ episodeId: episode.id }],
      createdAt: 30,
    });

    const contexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('recall', {
            query: 'durable episode gist',
            include_evidence: true,
            max_chars: 24,
          }, { id: 'tool-recall-episode-gist' }),
        ], { stopReason: 'toolUse' }),
        (context) => {
          contexts.push(textFromContext(context));
          return fauxAssistantMessage(fauxText('Recalled.'));
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

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Can you recall durable episode gist evidence?');
    const contextText = contexts.join('\n');

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(contextText).toContain('memory-recall-raw-missing');
    expect(contextText).toContain('episode_gist');
    expect(contextText).toContain('Durable gist survives ra');
    expect(contextText).toContain('evidence_truncated');
  });

  test('recall reaches the user pool distilled but gates raw evidence to the reader own pool', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-recall-gate-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-recall-gate-data-'));
    roots.push(localRoot, dataRoot);
    await seedPastConversation(dataRoot);
    const store = new AgentEventStore(dataRoot);
    // A second conversation whose raw text must NOT leak when the user-pool fact is recalled.
    const userEvidenceConversation = 'past-conversation-reviews';
    await store.appendEvents(userEvidenceConversation, [
      { ...base(userEvidenceConversation, 1, 'conversation.created'), title: 'Review style' },
      {
        ...base(userEvidenceConversation, 2, 'user_message.created', userActor),
        messageId: 'past-user-reviews',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Secret phrasing: I always want terse reviews from the start.' }],
      },
    ]);
    // Agent-pool fact → own pool, evidence dereferences. User-pool fact → cross-principal, distilled only.
    await store.addMemoryEntry(agentPrincipal('built-in:tenon:assistant'), {
      id: 'memory-focus-ring',
      fact: 'uses cobalt blue for focus rings',
      sources: [conversationSource('past-conversation-focus', {
        fromSeqExclusive: 1,
        throughSeq: 4,
        throughEventId: 'past-conversation-focus-event-4',
      })],
      createdAt: 30,
    });
    await store.addMemoryEntry(USER_PRINCIPAL, {
      id: 'memory-review-style',
      fact: 'prefers terse code reviews',
      sources: [conversationSource(userEvidenceConversation, {
        fromSeqExclusive: 1,
        throughSeq: 2,
        throughEventId: 'past-conversation-reviews-event-2',
      })],
      createdAt: 31,
    });

    const contexts: string[] = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('recall', { query: 'reviews focus rings', include_evidence: true }, { id: 'tool-recall-gate' }),
        ], { stopReason: 'toolUse' }),
        (context) => {
          contexts.push(textFromContext(context));
          return fauxAssistantMessage(fauxText('Recalled.'));
        },
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
        providerConfigLoader: async () => ({
          providerId: 'openai',
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

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'What do we know about reviews and focus rings?');
    const contextText = contexts.join('\n');

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    // Both pools are reachable: the agent's own fact and the co-member user fact appear.
    expect(contextText).toContain('- uses cobalt blue for focus rings');
    expect(contextText).toContain('prefers terse code reviews');
    // Own-pool evidence dereferences to raw transcript…
    expect(contextText).toContain('We chose cobalt blue for focus rings in the agent UI.');
    // …but a cross-principal (user) fact never leaks another principal's raw conversation.
    expect(contextText).toContain('evidence_refusal');
    expect(contextText).toContain('CROSS_PRINCIPAL_EVIDENCE');
    expect(contextText).not.toContain(userEvidenceConversation);
    expect(contextText).not.toContain('Secret phrasing: I always want terse reviews from the start.');
  });

  test('injects remembered facts into the next user prompt context', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-data-'));
    roots.push(localRoot, dataRoot);
    await new AgentEventStore(dataRoot).addMemoryEntry(agentPrincipal('built-in:tenon:assistant'), {
      id: 'memory-direct-style',
      fact: 'prefers direct, concise engineering answers',
      sources: [conversationSource('past-conversation')],
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

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Please answer directly.');
    const contextText = contexts.join('\n');

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(contextText).toContain('"recall"');
    expect(contextText).toContain('<memory>');
    expect(contextText).toContain('<self>');
    // The briefing renders zone-tagged bullets and hides storage scaffolding (the id).
    expect(contextText).not.toContain('memory-direct-style');
    expect(contextText).toContain('- prefers direct, concise engineering answers');
  });

  test('shares the user pool into an agent briefing as a third-person principal zone', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-user-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-user-data-'));
    roots.push(localRoot, dataRoot);
    const store = new AgentEventStore(dataRoot);
    // The user's self-model (user pool) and the agent's own pool both feed the briefing by
    // membership: the user is always a co-member, so its model is shared into every agent.
    await store.addMemoryEntry(USER_PRINCIPAL, {
      id: 'memory-user-pref',
      fact: 'prefers terse code reviews',
      sources: [conversationSource('past-conversation')],
      createdAt: 30,
    });
    await store.addMemoryEntry(agentPrincipal('built-in:tenon:assistant'), {
      id: 'memory-agent-habit',
      fact: 'verifies a worktree HEAD before trusting a gate run',
      sources: [conversationSource('past-conversation')],
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

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Please answer directly.');
    const contextText = contexts.join('\n');

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    // The reader's own pool renders as the <self> zone; the co-member user pool renders as a
    // named <principal> zone — both as verbatim bullet lists, no subject prepending (D-2).
    // (contextText is JSON, so attribute quotes are escaped.)
    expect(contextText).toContain('<self>');
    expect(contextText).toContain('- verifies a worktree HEAD before trusting a gate run');
    expect(contextText).toContain('<principal name=');
    expect(contextText).toContain('- prefers terse code reviews');
    expect(contextText).not.toContain('memory-user-pref');
  });

  test('the briefing injects one undivided pool regardless of origin workspace', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-pool-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-pool-data-'));
    roots.push(localRoot, dataRoot);
    const store = new AgentEventStore(dataRoot);
    // Memory is one self-model per principal — like a person, it is never partitioned by where
    // it was learned. `originWorkspace` is provenance metadata only.
    await store.addMemoryEntry(agentPrincipal('built-in:tenon:assistant'), {
      id: 'memory-current-workspace',
      fact: 'use slate focus rings in the current workspace',
      originWorkspace: memoryOriginWorkspace(localRoot),
      sources: [conversationSource('current-workspace-conversation')],
      createdAt: 30,
    });
    await store.addMemoryEntry(agentPrincipal('built-in:tenon:assistant'), {
      id: 'memory-other-workspace',
      fact: 'use amber focus rings in the other workspace',
      originWorkspace: 'workspace:other',
      sources: [conversationSource('other-workspace-conversation')],
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

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Which focus rings should I use here?');
    const contextText = contexts.join('\n');

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(contextText).toContain('use slate focus rings in the current workspace');
    expect(contextText).toContain('use amber focus rings in the other workspace');
    // Storage scaffolding (ids) stays hidden.
    expect(contextText).not.toContain('memory-current-workspace');
    expect(contextText).not.toContain('memory-other-workspace');
  });

  test('recall reads the whole pool across workspaces and excludes invalidated memory', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-recall-pool-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-recall-pool-data-'));
    roots.push(localRoot, dataRoot);
    const store = new AgentEventStore(dataRoot);
    await store.addMemoryEntry(agentPrincipal('built-in:tenon:assistant'), {
      id: 'memory-current-recall',
      fact: 'Current workspace recall fact mentions teal focus rings.',
      originWorkspace: memoryOriginWorkspace(localRoot),
      sources: [conversationSource('current-recall-conversation')],
      createdAt: 30,
    });
    await store.addMemoryEntry(agentPrincipal('built-in:tenon:assistant'), {
      id: 'memory-other-recall',
      fact: 'Other workspace recall fact mentions amber focus rings.',
      originWorkspace: 'workspace:other',
      sources: [conversationSource('other-recall-conversation')],
      createdAt: 31,
    });
    await store.addMemoryEntry(agentPrincipal('built-in:tenon:assistant'), {
      id: 'memory-unscoped-recall',
      fact: 'Unscoped recall fact mentions violet focus rings.',
      sources: [conversationSource('unscoped-recall-conversation')],
      createdAt: 32,
    });
    await store.addMemoryEntry(agentPrincipal('built-in:tenon:assistant'), {
      id: 'memory-invalidated-recall',
      fact: 'Invalidated recall fact mentions orange focus rings.',
      originWorkspace: memoryOriginWorkspace(localRoot),
      sources: [conversationSource('invalidated-recall-conversation')],
      createdAt: 33,
    });
    await store.removeMemoryEntry(agentPrincipal('built-in:tenon:assistant'), 'memory-invalidated-recall', 'test');

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
          return fauxAssistantMessage(fauxText('Every active memory applies.'));
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

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Recall focus-ring memories.');

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
    // The pool is one undivided self-model: every ACTIVE fact is reachable regardless of the
    // workspace it was learned in; only the invalidated entry is excluded.
    expect(recallResult.data?.total_entries).toBe(3);
    expect(recallResult.data?.entries?.map((entry) => entry.memory_id).sort()).toEqual([
      'memory-current-recall',
      'memory-other-recall',
      'memory-unscoped-recall',
    ]);
    expect(postRecallContext).toContain('Current workspace recall fact mentions teal focus rings.');
    expect(postRecallContext).toContain('Other workspace recall fact mentions amber focus rings.');
    expect(postRecallContext).toContain('Unscoped recall fact mentions violet focus rings.');
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
              actions: [{ type: 'add', fact: 'prefers concise engineering answers' }],
            })),
            model as Model<Api>,
          );
        },
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Please keep engineering answers concise from now on.');
    // Conversation evidence consolidates into the user pool (the user-Dream), not the agent pool.
    expect(await new AgentEventStore(dataRoot).listMemoryEntries(USER_PRINCIPAL)).toEqual([]);
    await runtime.sendMessage(created.conversationId, '/dream');
    await runtime.drainDreamMemoryExtractionForTest();

    const entries = await new AgentEventStore(dataRoot).listMemoryEntries(USER_PRINCIPAL);
    const source = entries[0]?.sources[0];
    const episode = source && 'episodeId' in source
      ? await new AgentEventStore(dataRoot).getMemoryEpisode(USER_PRINCIPAL, source.episodeId)
      : null;
    const rawSource = episode?.sources[0];

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(entries.map((entry) => entry.fact)).toEqual(['prefers concise engineering answers']);
    expect(entries[0]?.originWorkspace).toBe(memoryOriginWorkspace(localRoot));
    expect(source && 'episodeId' in source ? source.episodeId : '').toMatch(/^episode-/);
    expect(rawSource).toMatchObject({
      stream: 'conversation',
      streamId: created.conversationId,
    });
    expect(typeof rawSource?.range.throughEventId).toBe('string');
    expect(dreamRequests.join('\n')).toContain('Please keep engineering answers concise from now on.');
    expect(dreamRequests.join('\n')).toContain('I will keep future engineering answers concise.');
    expect(dreamRequests.join('\n')).toContain('"tools":[]');
    expect((await new AgentEventStore(dataRoot).readDreamState(USER_PRINCIPAL)).watermark.conversations[created.conversationId]?.seq).toBeGreaterThan(0);
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

  test('manual /dream skips cleanly when the same agent is already dreaming', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-conflict-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-conflict-data-'));
    roots.push(localRoot, dataRoot);
    let completeCalls = 0;
    let resolveFirstDreamReady: () => void = () => undefined;
    let releaseFirstDream: () => void = () => undefined;
    const firstDreamReady = new Promise<void>((resolve) => {
      resolveFirstDreamReady = resolve;
    });
    const firstDreamBlocker = new Promise<void>((resolve) => {
      releaseFirstDream = resolve;
    });

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
        streamFn: scriptedStream([], () => undefined).streamFn,
        completeSimpleFn: async (model) => {
          completeCalls += 1;
          resolveFirstDreamReady();
          await firstDreamBlocker;
          return normalizeAssistantMessage(
            fauxAssistantMessage(JSON.stringify({ actions: [] })),
            model as Model<Api>,
          );
        },
      },
    );

    const created = await runtime.restoreLatestConversation();
    const firstDream = runtime.sendMessage(created.conversationId, '/dream');
    await firstDreamReady;
    await runtime.sendMessage(created.conversationId, '/dream');
    releaseFirstDream();
    await firstDream;
    await runtime.drainDreamMemoryExtractionForTest();

    const replay = await new AgentEventStore(dataRoot).replay(created.conversationId);
    const dreamStatuses = Object.values(replay.dreamsByMessageId).map((dream) => dream.status);

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(completeCalls).toBe(1);
    expect(dreamStatuses).toContain('skipped');
    expect(dreamStatuses).toContain('completed');
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
              actions: [{ type: 'add', fact: 'prefers compact acknowledgements' }],
            })),
            model as Model<Api>,
          );
        },
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Prefer compact acknowledgements.');
    await runtime.runScheduledDreamsForTest(new Date('2026-01-02T04:00:00'));
    expect(dreamCalls).toBe(0);
    expect(await new AgentEventStore(dataRoot).listMemoryEntries(USER_PRINCIPAL)).toEqual([]);

    await runtime.sendMessage(created.conversationId, '/dream');
    await runtime.drainDreamMemoryExtractionForTest();

    const entries = await new AgentEventStore(dataRoot).listMemoryEntries(USER_PRINCIPAL);
    const dreamState = await new AgentEventStore(dataRoot).readDreamState(USER_PRINCIPAL);

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(dreamCalls).toBe(1);
    expect(entries.map((entry) => entry.fact)).toEqual(['prefers compact acknowledgements']);
    expect(dreamState.lastCompleted?.trigger).toBe('manual');
  });

  test('scheduled dream fires for enough new evidence and records a principal-anchored run', async () => {
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

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, longPreference);
    await runtime.runScheduledDreamsForTest(new Date('2026-01-02T04:00:00'));
    await flushProjectionCoalescing();

    const store = new AgentEventStore(dataRoot);
    // Scheduled dream consolidates conversation evidence into the user pool (the user-Dream).
    // Its run is ANCHORED to the user principal — the pool it maintains — while the executing
    // agent is recorded separately; run history and dream state are keyed by the same principal.
    const entries = await store.listMemoryEntries(USER_PRINCIPAL);
    const dreamState = await store.readDreamState(USER_PRINCIPAL);
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
    expect(runMeta?.anchor).toEqual({ type: 'principal', principal: USER_PRINCIPAL });
    expect(runMeta?.agentId).toBe('built-in:tenon:assistant');
    expect(runMeta?.kind).toBe('reflective');
    const userRuns = await store.listPrincipalRunMetaProjections(USER_PRINCIPAL);
    expect(userRuns.map((run) => run.id)).toContain(runId);
    expect(dreamTask).toMatchObject({
      id: `dream:${runId}`,
      kind: 'dream',
      status: 'completed',
      trigger: 'schedule',
      principal: USER_PRINCIPAL,
      runId,
      processed: {
        totalMessageCount: 2,
        consolidateOnly: false,
      },
      changes: { added: 1 },
    });
  });

  test('a failing scheduled dream backs off instead of re-firing every tick', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-backoff-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-backoff-data-'));
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
        // Every Dream completion throws — the persistent failure that, before the backoff,
        // re-fired on every scheduler tick and flooded the run list with `failed` records.
        completeSimpleFn: async () => {
          dreamCalls += 1;
          throw new Error('provider down');
        },
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, longPreference);

    // First scheduled tick: the Dream fires for the new evidence, the provider throws, the user
    // pool records a single `failed` run and arms its backoff window.
    await runtime.runScheduledDreamsForTest(new Date('2026-01-02T04:00:00'));
    const callsAfterFirst = dreamCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const store = new AgentEventStore(dataRoot);
    const failedUserRuns = async () => (await store.listPrincipalRunMetaProjections(USER_PRINCIPAL))
      .filter((run) => run.kind === 'reflective' && run.status === 'failed');
    expect(await failedUserRuns()).toHaveLength(1);
    // Absent the backoff the next tick WOULD re-fire: a failed Dream advances neither
    // lastSuccessAt nor the watermark, so the schedule and volume gates both still pass.
    expect((await store.readDreamState(USER_PRINCIPAL)).lastSuccessAt).toBeNull();

    // Second tick 30s later — inside the 5-minute backoff window: no new provider call and no
    // second `failed` run piles up.
    await runtime.runScheduledDreamsForTest(new Date('2026-01-02T04:00:30'));
    expect(dreamCalls).toBe(callsAfterFirst);
    expect(await failedUserRuns()).toHaveLength(1);
  });

  test('a manual /dream ignores the backoff window and its success records a completed run', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-manual-backoff-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-manual-backoff-data-'));
    roots.push(localRoot, dataRoot);
    let dreamCalls = 0;
    // The scheduled attempt fails (arming the backoff); the manual run that follows succeeds.
    let failDream = true;
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
          if (failDream) throw new Error('provider down');
          return normalizeAssistantMessage(
            fauxAssistantMessage(JSON.stringify({
              actions: [{ type: 'add', fact: 'prefers concise evidence' }],
            })),
            model as Model<Api>,
          );
        },
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, longPreference);

    // Scheduled tick: the Dream fires, the provider throws, the user pool arms its backoff window.
    await runtime.runScheduledDreamsForTest(new Date('2026-01-02T04:00:00'));
    const callsAfterScheduledFail = dreamCalls;
    expect(callsAfterScheduledFail).toBeGreaterThan(0);
    expect((await new AgentEventStore(dataRoot).readDreamState(USER_PRINCIPAL)).lastSuccessAt).toBeNull();

    // A scheduled tick inside the window is blocked — the backoff is genuinely armed.
    await runtime.runScheduledDreamsForTest(new Date('2026-01-02T04:00:30'));
    expect(dreamCalls).toBe(callsAfterScheduledFail);

    // A manual /dream, still inside that window, ignores the backoff and fires anyway (the user
    // asked for it now); this one succeeds, so its outcome flows through the completed branch.
    failDream = false;
    await runtime.sendMessage(created.conversationId, '/dream');
    await runtime.drainDreamMemoryExtractionForTest();

    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    // Manual ran despite the open backoff window.
    expect(dreamCalls).toBeGreaterThan(callsAfterScheduledFail);
    const stateAfterManual = await new AgentEventStore(dataRoot).readDreamState(USER_PRINCIPAL);
    expect(stateAfterManual.lastCompleted?.trigger).toBe('manual');
    expect(stateAfterManual.lastSuccessAt).not.toBeNull();
    expect((await new AgentEventStore(dataRoot).listMemoryEntries(USER_PRINCIPAL)).map((entry) => entry.fact))
      .toEqual(['prefers concise evidence']);
  });

  test('manual /dream with no new evidence consolidates memory without replaying old raw evidence', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-consolidate-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-consolidate-data-'));
    roots.push(localRoot, dataRoot);
    await new AgentEventStore(dataRoot).addMemoryEntry(USER_PRINCIPAL, {
      id: 'memory-stable',
      fact: 'prefers stable concise memory',
      originWorkspace: memoryOriginWorkspace(localRoot),
      sources: [conversationSource('old-conversation')],
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
                : [{ type: 'update', memory_id: 'memory-stable', fact: 'prefers stable, concise memory' }],
            })),
            model as Model<Api>,
          );
        },
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Stable concise memory is preferred.');
    await runtime.sendMessage(created.conversationId, '/dream');
    await runtime.sendMessage(created.conversationId, '/dream');

    const updated = await new AgentEventStore(dataRoot).getMemoryEntry(USER_PRINCIPAL, 'memory-stable');
    const secondRequest = dreamRequests[1] ?? '';

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(dreamRequests).toHaveLength(2);
    expect(updated?.fact).toBe('prefers stable, concise memory');
    expect(secondRequest).toContain('(no new raw evidence)');
    expect(secondRequest).not.toContain('Stable concise memory is preferred.');
  });

  test('manual /dream consolidates over the whole pool regardless of origin workspace', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-pool-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-pool-data-'));
    roots.push(localRoot, dataRoot);
    const store = new AgentEventStore(dataRoot);
    await store.addMemoryEntry(USER_PRINCIPAL, {
      id: 'memory-current-style',
      fact: 'Current workspace prefers verbose answers.',
      originWorkspace: memoryOriginWorkspace(localRoot),
      sources: [conversationSource('old-current-conversation')],
      createdAt: 30,
    });
    await store.addMemoryEntry(USER_PRINCIPAL, {
      id: 'memory-other-style',
      fact: 'Other workspace prefers terse answers.',
      originWorkspace: 'workspace:other',
      sources: [conversationSource('old-other-conversation')],
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
                reason: 'superseded preference',
              },
            ],
          })),
          model as Model<Api>,
        ),
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'For this workspace, prefer short answers.');
    await runtime.sendMessage(created.conversationId, '/dream');
    await runtime.drainDreamMemoryExtractionForTest();

    const entries = await new AgentEventStore(dataRoot).listMemoryEntries(USER_PRINCIPAL, {
      includeInvalidated: true,
      limit: 10,
    });
    const current = entries.find((entry) => entry.id === 'memory-current-style');
    const other = entries.find((entry) => entry.id === 'memory-other-style');

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(current?.fact).toBe('Current workspace prefers short answers.');
    const episodeSource = current?.sources.find((source) => 'episodeId' in source);
    const episode = episodeSource && 'episodeId' in episodeSource
      ? await new AgentEventStore(dataRoot).getMemoryEpisode(USER_PRINCIPAL, episodeSource.episodeId)
      : null;
    expect(episode?.sources.some((source) => (
      source.stream === 'conversation' && source.streamId === created.conversationId
    ))).toBe(true);
    // The pool is one undivided self-model: consolidation can reshape every entry, including
    // facts learned in another workspace — `originWorkspace` is provenance, not a write fence.
    expect(other?.status).toBe('invalidated');
  });

  test('manual /dream treats same-key updates as no-ops but records completion', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-noop-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-noop-data-'));
    roots.push(localRoot, dataRoot);
    const store = new AgentEventStore(dataRoot);
    await store.addMemoryEntry(USER_PRINCIPAL, {
      id: 'memory-style',
      fact: 'prefers concise engineering answers',
      originWorkspace: memoryOriginWorkspace(localRoot),
      sources: [conversationSource('old-conversation')],
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
              fact: 'prefers concise engineering answers',
            }],
          })),
          model as Model<Api>,
        ),
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Keep answers concise.');
    await runtime.sendMessage(created.conversationId, '/dream');
    await runtime.drainDreamMemoryExtractionForTest();

    const events = await new AgentEventStore(dataRoot).readMemoryEvents(USER_PRINCIPAL);
    const entry = await new AgentEventStore(dataRoot).getMemoryEntry(USER_PRINCIPAL, 'memory-style');

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(events.map((event) => event.type)).toEqual(['memory.entry_added', 'memory.accessed', 'dream.completed']);
    expect(entry?.sources).toEqual([conversationSource('old-conversation')]);
    expect(events.some((event) => event.type === 'memory.episode_recorded')).toBe(false);
  });

  test('the Settings management surface lists and forgets across the agent and user pools', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-manage-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-manage-data-'));
    roots.push(localRoot, dataRoot);
    const store = new AgentEventStore(dataRoot);
    // One fact in each managed pool. The user-Dream writes the user pool, so it must be
    // inspectable/editable through the same surface as the agent self-model (review #6).
    await store.addMemoryEntry(agentPrincipal('built-in:tenon:assistant'), {
      id: 'memory-agent-managed',
      fact: 'verify a worktree HEAD before trusting a gate run',
      sources: [conversationSource('past-conversation')],
      createdAt: 40,
    });
    await store.addMemoryEntry(USER_PRINCIPAL, {
      id: 'memory-user-managed',
      fact: 'prefers terse code reviews',
      sources: [conversationSource('past-conversation')],
      createdAt: 41,
    });

    const script = scriptedStream([], () => undefined);
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

    // listMemory unions both pools; each entry's principal distinguishes them.
    const listed = await runtime.listMemory();
    const byId = new Map(listed.map((entry) => [entry.id, entry]));
    expect(byId.get('memory-agent-managed')?.principal).toEqual(agentPrincipal('built-in:tenon:assistant'));
    expect(byId.get('memory-user-managed')?.principal).toEqual(USER_PRINCIPAL);

    // forgetMemory resolves the owning pool from the id — a user-pool id forgets in the user pool.
    const forgotten = await runtime.forgetMemory('memory-user-managed');
    expect(forgotten?.principal).toEqual(USER_PRINCIPAL);
    expect(forgotten?.status).toBe('invalidated');
    // Read disk truth through a fresh store (the seeding `store` has a stale projection cache).
    const disk = new AgentEventStore(dataRoot);
    const userActive = await disk.listMemoryEntries(USER_PRINCIPAL);
    expect(userActive.map((entry) => entry.id)).not.toContain('memory-user-managed');
    // The agent pool is untouched.
    const agentActive = await disk.listMemoryEntries(agentPrincipal('built-in:tenon:assistant'));
    expect(agentActive.map((entry) => entry.id)).toContain('memory-agent-managed');
  });

});
