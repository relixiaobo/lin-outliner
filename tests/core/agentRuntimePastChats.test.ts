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
import { DEFAULT_DREAM_CHANNEL_ID } from '../../src/core/agentChannel';
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
    getTextSearchIndex: () => undefined,
    transaction: async (_meta, fn) => fn(),
    operationHistory: async () => ({ entries: [], count: 0 }),
    handle: async (command, args = {}) => {
      if (command === 'create_node') return core.createNode(String(args.parentId), nullableNumber(args.index), String(args.text ?? ''));
      if (command === 'create_rich_text_node') return core.createRichTextContentNode(String(args.parentId), nullableNumber(args.index), args.content as any);
      if (command === 'apply_node_text_patch') return core.applyNodeTextPatch(String(args.nodeId), args.patch as any);
      if (command === 'update_node_description') return core.updateNodeDescription(String(args.nodeId), nullableString(args.description));
      if (command === 'set_node_checkbox_visible') return core.setNodeCheckboxVisible(String(args.nodeId), Boolean(args.visible));
      if (command === 'toggle_done') return core.toggleDone(String(args.nodeId));
      if (command === 'create_tag') return core.createTag(String(args.name ?? ''));
      if (command === 'apply_tag') return core.applyTag(String(args.nodeId), String(args.tagId));
      if (command === 'remove_tag') return core.removeTag(String(args.nodeId), String(args.tagId));
      if (command === 'create_inline_field') return core.createInlineField(String(args.parentId), nullableNumber(args.index), String(args.name), 'plain');
      if (command === 'add_reference') return core.addReference(String(args.parentId), String(args.targetId), nullableNumber(args.index));
      if (command === 'set_reference_target') return core.setReferenceTarget(String(args.referenceId), String(args.targetId));
      if (command === 'trash_node') return core.trashNode(String(args.nodeId));
      if (command === 'batch_trash_nodes') return core.batchTrashNodes(arrayArg(args.nodeIds));
      if (command === 'move_node') return core.moveNode(String(args.nodeId), String(args.parentId), nullableNumber(args.index));
      if (command === 'create_search_node') return core.createSearchNode(String(args.parentId), nullableNumber(args.index), args.config as any);
      if (command === 'set_search_node') return core.setSearchNode(String(args.nodeId), args.config as any);
      if (command === 'set_view_mode') return core.setViewMode(String(args.nodeId), String(args.mode) as any);
      if (command === 'search_nodes') return core.searchNodes(String(args.query ?? ''));
      if (command === 'backlinks') return core.backlinks(String(args.targetId ?? ''));
      throw new Error(`unsupported test command: ${command}`);
    },
  };
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function arrayArg(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
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

function contextSnapshot(context: Context): { text: string; tools: string[] } {
  return {
    text: JSON.stringify({ messages: context.messages, tools: context.tools?.map((tool) => tool.name) }),
    tools: context.tools?.map((tool) => tool.name) ?? [],
  };
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

function runtimeSettings() {
  return {
    permissionMode: 'trusted' as const,
    automaticSkillsEnabled: false,
    slashSkillsEnabled: false,
    compactEnabled: true,
    additionalSkillDirectories: [],
    providerTimeoutMs: null,
    providerMaxRetries: null,
    providerMaxRetryDelayMs: 60_000,
    providerCacheRetention: 'short' as const,
    disabledSkills: [],
    disabledAgents: [],
  };
}

function scheduledTestNow(offsetDays = 0, hour = 4): Date {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  date.setHours(hour, 0, 0, 0);
  return date;
}

function localIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function previousLocalIsoDate(date: Date): string {
  const previous = new Date(date);
  previous.setDate(previous.getDate() - 1);
  return localIsoDate(previous);
}

async function latestDreamFinished(store: AgentEventStore): Promise<Extract<AgentEvent, { type: 'dream.finished' }> | null> {
  return (await store.readEvents(DEFAULT_DREAM_CHANNEL_ID))
    .filter((event): event is Extract<AgentEvent, { type: 'dream.finished' }> => event.type === 'dream.finished')
    .at(-1) ?? null;
}

describe('agent runtime past chats integration', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  test('runtime refresh exposes pull-only memory tools and removes recall/dream foreground tools', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-tools-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-tools-data-'));
    roots.push(localRoot, dataRoot);
    const calls: Array<{ text: string; tools: string[] }> = [];
    const script = scriptedStream(
      [fauxAssistantMessage(fauxText('Ready.'))],
      (_model, context) => calls.push(contextSnapshot(context)),
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
        runtimeSettingsLoader: async () => runtimeSettings(),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'Which tools are live?');
    const tools = calls[0]?.tools ?? [];

    expect(script.pendingCount()).toBe(0);
    expect(tools).toContain('past_chats');
    expect(tools).toContain('node_search');
    expect(tools).toContain('node_read');
    expect(tools).not.toContain('recall');
    expect(tools).not.toContain('dream');
  });

  test('past_chats reads prior chat spans through the runtime tool surface', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-past-chats-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-past-chats-data-'));
    roots.push(localRoot, dataRoot);
    await seedPastConversation(dataRoot);
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('past_chats', { query: 'cobalt focus rings', limit: 5 }, { id: 'tool-past-search' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage([
          fauxToolCall('past_chats', {
            source: {
              stream: 'conversation',
              stream_id: 'past-conversation-focus',
              from_seq_exclusive: 1,
              through_seq: 4,
              through_event_id: 'past-conversation-focus-event-4',
            },
            max_chars: 2000,
          }, { id: 'tool-past-source' }),
        ], { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Cobalt blue was the focus-ring choice.')),
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
        runtimeSettingsLoader: async () => runtimeSettings(),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    await runtime.sendMessage(created.conversationId, 'What did we decide about focus rings?');

    const replay = await new AgentEventStore(dataRoot).replay(created.conversationId);
    const toolResults = getAgentEventActivePath(replay).filter((message) => message.role === 'toolResult');
    const outputs = toolResults.map((message) => persistedText(message.content));

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(toolResults.map((message) => message.toolName)).toEqual(['past_chats', 'past_chats']);
    expect(outputs[0]).toContain('"mode": "search"');
    expect(outputs[0]).toContain('We chose <mark>cobalt</mark> blue');
    expect(outputs[1]).toContain('"mode": "source"');
    expect(outputs[1]).toContain('Cobalt blue is the recorded focus-ring choice.');
  });

  test('scheduled Dream invokes the private memory-dream skill through a restricted Dream channel run', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-dream-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-dream-data-'));
    roots.push(localRoot, dataRoot);
    const core = Core.new();
    const today = core.projection().todayId;
    const calls: Array<{ text: string; tools: string[] }> = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage(fauxText('Captured enough evidence.')),
        fauxAssistantMessage([
          fauxToolCall('node_create', {
            parent_id: today,
            outline: '- Focus ring preference #d-memory\n  - User prefers cobalt focus rings #d-belief\n  - Prefer narrow UI highlight scope when source clicks refer to a user message #d-guidance\n  - Whether cobalt remains the right focus color is still uncertain #d-question',
          }, { id: 'tool-memory-dream-node-create' }),
        ]),
        fauxAssistantMessage(fauxText('Memory Dream complete.')),
      ],
      (_model, context) => calls.push(contextSnapshot(context)),
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(core),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        dreamMemoryExtractionEnabled: true,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        runtimeSettingsLoader: async () => runtimeSettings(),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    const longEvidence = `Memory Dream should consolidate this prior chat evidence. ${'memory-dream-signal '.repeat(80)}`;
    await runtime.sendMessage(created.conversationId, longEvidence);
    const now = scheduledTestNow(1);
    const expectedWindowEnd = previousLocalIsoDate(now);
    await runtime.runScheduledDreamsForTest(now);

    const dreamCall = calls.find((call) => call.text.includes('<memory-dream-run>'));
    const store = new AgentEventStore(dataRoot);
    const dreamFinished = await latestDreamFinished(store);

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(dreamCall).toBeDefined();
    expect(dreamCall?.tools.sort()).toEqual([
      'node_create',
      'node_delete',
      'node_edit',
      'node_read',
      'node_search',
      'past_chats',
    ].sort());
    expect(dreamCall?.text).toContain("Tenon's private memory consolidation pass");
    expect(dreamCall?.text).toContain('Remembering nothing is a valid and common outcome');
    expect(dreamCall?.text).toContain('date_window:');
    expect(dreamCall?.text).toContain(expectedWindowEnd);
    expect(dreamCall?.text).toContain('from_created_at_inclusive');
    expect(dreamCall?.text).toContain('through_created_at_exclusive');
    expect(dreamCall?.text).toContain('When you do write memory, maintain exactly one direct child #d-memory container per source-date journal node');
    expect(dreamCall?.text).toContain('The #d-memory title must be a concise generated daily memory headline');
    expect(dreamCall?.text).toContain('human-dream cycle');
    expect(dreamCall?.text).toContain('replay salient fragments');
    expect(dreamCall?.text).toContain('consolidate_only');
    expect(dreamCall?.text).toContain('#d-question');
    expect(dreamCall?.text).toContain('#d-guidance');
    expect(dreamCall?.text).toContain('Apply the Valuable Memory Filter');
    expect(dreamCall?.text).toContain('future-relevant preferences, decisions, project facts, corrections, or recurring patterns');
    expect(dreamCall?.text).toContain('gather relevant outline context before writing');
    expect(dreamCall?.text).toContain('Treat prior Dream results as current beliefs, tensions, and guidance to reconcile');
    expect(dreamCall?.text).toContain('When sources are present, read and consolidate only these chat sources');
    expect(dreamCall?.text).toContain('Do not cite every line mechanically');
    expect(dreamCall?.text).toContain('one episode-level citation can cover child nodes');
    expect(dreamCall?.text).toContain('"past_chats"');
    expect(dreamCall?.text).toContain('total_char_count');
    expect(dreamCall?.text).toContain('\\"from_seq_exclusive\\": 0');
    expect(dreamCall?.text).toContain('chat_marker_template');
    expect(dreamCall?.text).toContain('[[chat:natural source phrase^conversation:');
    expect(dreamCall?.text).toContain('Do not use bookkeeping labels such as source-1');
    expect(dreamCall?.text).not.toContain('[[chat:source-1^conversation:');
    expect(dreamFinished).toMatchObject({
      type: 'dream.finished',
      trigger: 'schedule',
      status: 'completed',
      window: { end: expectedWindowEnd },
    });
    const readiness = await runtime.previewDreamReadiness();
    expect(readiness.window).toEqual({ start: expectedWindowEnd, end: expectedWindowEnd });
    expect(dreamFinished?.processed?.totalCharCount).toBeGreaterThan(1000);
    expect(dreamFinished?.processed?.conversations[created.conversationId]?.throughSeq ?? 0).toBeGreaterThan(0);
    expect(dreamFinished?.changes?.added).toBeGreaterThan(0);
    const conversationIds = (await runtime.listConversations()).map((entry) => entry.id);
    expect(conversationIds).toContain(DEFAULT_DREAM_CHANNEL_ID);
    expect(conversationIds).not.toContain('lin-agent-memory-dream');
    const dreamRunMeta = dreamFinished?.runId ? await store.readRunMetaProjection(dreamFinished.runId) : null;
    expect(dreamRunMeta?.status).toBe('completed');
    expect(dreamRunMeta?.latestSeq ?? 0).toBeGreaterThan(0);
    const { AgentPastChatsService } = await import('../../src/main/agentPastChats');
    const dreamSearch = await new AgentPastChatsService(store).search({
      query: 'Memory Dream complete',
      conversationIds: [DEFAULT_DREAM_CHANNEL_ID],
      includeCurrentConversation: true,
    });
    expect(dreamSearch.mode).toBe('search');
    if (dreamSearch.mode === 'search') expect(dreamSearch.totalHits).toBe(0);
  });

  test('manual Dream can consolidate outline context without new chat sources', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-dream-outline-only-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-dream-outline-only-data-'));
    roots.push(localRoot, dataRoot);
    const core = Core.new();
    const today = core.projection().todayId;
    const staleMemoryId = core.createNode(today, null, 'Stale unresolved question #d-question').focus!.nodeId;
    const calls: Array<{ text: string; tools: string[] }> = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage([
          fauxToolCall('node_delete', {
            node_id: staleMemoryId,
          }, { id: 'tool-memory-dream-outline-only-node-delete' }),
        ]),
        fauxAssistantMessage(fauxText('Memory Dream complete.')),
      ],
      (_model, context) => calls.push(contextSnapshot(context)),
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(core),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        dreamMemoryExtractionEnabled: true,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        runtimeSettingsLoader: async () => runtimeSettings(),
        streamFn: script.streamFn,
      },
    );

    await runtime.runDreamNow();
    const dreamCall = calls.find((call) => call.text.includes('<memory-dream-run>'));
    const dreamFinished = await latestDreamFinished(new AgentEventStore(dataRoot));

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(dreamCall?.tools).toContain('node_delete');
    expect(dreamCall?.text).toContain('sources');
    expect(dreamCall?.text).toContain('consolidate_only');
    expect(dreamCall?.text).toContain('true');
    expect(dreamCall?.text).toContain('do not call past_chats');
    expect(dreamCall?.text).toContain('outline context plus prior Dream memory');
    expect(dreamFinished?.trigger).toBe('manual');
    expect(dreamFinished?.processed?.consolidateOnly).toBe(true);
    expect(dreamFinished?.changes?.forgotten).toBe(1);
  });

  test('scheduled Dream retries a failed due at most three times', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-dream-retry-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-dream-retry-data-'));
    roots.push(localRoot, dataRoot);
    const core = Core.new();
    const calls: Array<{ text: string; tools: string[] }> = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage(fauxText('Captured enough evidence.')),
        {
          ...fauxAssistantMessage(fauxText('Too much backlog to hold in context.')),
          stopReason: 'stop' as const,
          usage: { ...EMPTY_USAGE, input: 10_000_000 },
        },
        {
          ...fauxAssistantMessage(fauxText('Too much backlog to hold in context.')),
          stopReason: 'stop' as const,
          usage: { ...EMPTY_USAGE, input: 10_000_000 },
        },
        {
          ...fauxAssistantMessage(fauxText('Too much backlog to hold in context.')),
          stopReason: 'stop' as const,
          usage: { ...EMPTY_USAGE, input: 10_000_000 },
        },
      ],
      (_model, context) => calls.push(contextSnapshot(context)),
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(core),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        dreamMemoryExtractionEnabled: true,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        runtimeSettingsLoader: async () => ({ ...runtimeSettings(), compactEnabled: false }),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    const longEvidence = `Memory Dream should retry failed due windows. ${'memory-dream-retry '.repeat(80)}`;
    await runtime.sendMessage(created.conversationId, longEvidence);

    const dueDay = scheduledTestNow(1);
    await runtime.runScheduledDreamsForTest(dueDay);
    expect(calls).toHaveLength(2);
    expect(script.pendingCount()).toBe(2);
    const store = new AgentEventStore(dataRoot);
    let dreamFinished = await latestDreamFinished(store);
    expect(dreamFinished).toMatchObject({ type: 'dream.finished', trigger: 'schedule', status: 'failed' });

    await runtime.runScheduledDreamsForTest(new Date(dueDay.getTime() + 5 * 60_000));
    await runtime.runScheduledDreamsForTest(new Date(dueDay.getTime() + 15 * 60_000));
    expect(calls).toHaveLength(4);
    expect(script.pendingCount()).toBe(0);
    dreamFinished = await latestDreamFinished(store);
    expect(dreamFinished).toMatchObject({ type: 'dream.finished', trigger: 'schedule', status: 'failed' });

    await runtime.runScheduledDreamsForTest(new Date(dueDay.getTime() + 6 * 60 * 60_000));
    expect(calls).toHaveLength(4);
    expect(script.pendingCount()).toBe(0);
  });

  test('manual Dream suppresses the scheduled Dream for the same date window', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-dream-manual-suppression-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-dream-manual-suppression-data-'));
    roots.push(localRoot, dataRoot);
    const core = Core.new();
    const today = core.projection().todayId;
    const calls: Array<{ text: string; tools: string[] }> = [];
    const script = scriptedStream(
      [
        fauxAssistantMessage(fauxText('Captured enough evidence.')),
        fauxAssistantMessage([
          fauxToolCall('node_create', {
            parent_id: today,
            outline: '- Manual Dream memory #d-memory\n  - Durable same-window evidence #d-episode',
          }, { id: 'tool-memory-dream-manual-suppression-node-create' }),
        ]),
        fauxAssistantMessage(fauxText('Memory Dream complete.')),
      ],
      (_model, context) => calls.push(contextSnapshot(context)),
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(core),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        dreamMemoryExtractionEnabled: true,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        runtimeSettingsLoader: async () => runtimeSettings(),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    const longEvidence = `Manual Dream should suppress the scheduled pass for this window. ${'memory-dream-manual-suppression '.repeat(80)}`;
    await runtime.sendMessage(created.conversationId, longEvidence);
    await runtime.runDreamNow();

    const expectedWindowEnd = localIsoDate(new Date());
    const store = new AgentEventStore(dataRoot);
    const dreamFinishedBeforeSchedule = (await store.readEvents(DEFAULT_DREAM_CHANNEL_ID))
      .filter((event) => event.type === 'dream.finished');
    expect(dreamFinishedBeforeSchedule).toHaveLength(1);
    expect(dreamFinishedBeforeSchedule[0]).toMatchObject({
      type: 'dream.finished',
      trigger: 'manual',
      status: 'completed',
      window: { start: expectedWindowEnd, end: expectedWindowEnd },
    });

    await runtime.runScheduledDreamsForTest(scheduledTestNow(1));

    const dreamFinishedAfterSchedule = (await store.readEvents(DEFAULT_DREAM_CHANNEL_ID))
      .filter((event) => event.type === 'dream.finished');
    const manualFinished = await latestDreamFinished(store);
    expect(calls).toHaveLength(3);
    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(dreamFinishedAfterSchedule).toHaveLength(1);
    expect(manualFinished?.trigger).toBe('manual');
    expect(manualFinished?.changes?.added).toBeGreaterThan(0);
  });

  test('scheduled Dream that finds nothing worth remembering completes as a no-op and records the completed window', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-dream-empty-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-dream-empty-data-'));
    roots.push(localRoot, dataRoot);
    const script = scriptedStream(
      [
        fauxAssistantMessage(fauxText('Captured enough evidence.')),
        fauxAssistantMessage(fauxText('Nothing durable to write.')),
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
        runtimeSettingsLoader: async () => runtimeSettings(),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    const longEvidence = `Memory Dream sees plenty of low-value chit-chat here. ${'memory-dream-empty '.repeat(80)}`;
    await runtime.sendMessage(created.conversationId, longEvidence);
    await runtime.runScheduledDreamsForTest(scheduledTestNow(1));

    const dreamFinished = await latestDreamFinished(new AgentEventStore(dataRoot));
    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    // Remembering nothing is a valid no-op: the run still completes with zero
    // change counts and records a clean window, so the considered-but-empty span
    // is not re-read on the next Dream.
    expect(dreamFinished?.trigger).toBe('schedule');
    expect(dreamFinished?.status).toBe('completed');
    expect(dreamFinished?.changes?.added).toBe(0);
    expect(dreamFinished?.changes?.updated).toBe(0);
    expect(dreamFinished?.changes?.forgotten).toBe(0);
    expect(dreamFinished?.processed?.conversations[created.conversationId]?.throughSeq ?? 0).toBeGreaterThan(0);
    expect((await runtime.listConversations()).map((entry) => entry.id)).not.toContain('lin-agent-memory-dream');
  });

  test('scheduled Dream does not count preview-only node edits as committed work', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-dream-preview-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-dream-preview-data-'));
    roots.push(localRoot, dataRoot);
    const core = Core.new();
    const today = core.projection().todayId;
    const previewTarget = core.createNode(today, null, 'Preview target').focus!.nodeId;
    const script = scriptedStream(
      [
        fauxAssistantMessage(fauxText('Captured enough evidence.')),
        fauxAssistantMessage([
          fauxToolCall('node_edit', {
            node_id: previewTarget,
            old_string: '*',
            new_string: `- %%node:${previewTarget}%% Preview target\n  - Proposed child`,
            preview_only: true,
          }, { id: 'tool-memory-dream-preview-node-edit' }),
        ]),
        fauxAssistantMessage(fauxText('Preview looked fine, but nothing was committed.')),
      ],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(core),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        dreamMemoryExtractionEnabled: true,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        runtimeSettingsLoader: async () => runtimeSettings(),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    const longEvidence = `Memory Dream should not count preview-only edits. ${'memory-dream-preview '.repeat(80)}`;
    await runtime.sendMessage(created.conversationId, longEvidence);
    await runtime.runScheduledDreamsForTest(scheduledTestNow(1));

    const dreamFinished = await latestDreamFinished(new AgentEventStore(dataRoot));
    expect(script.pendingCount()).toBe(0);
    expect(core.state().nodes[previewTarget]!.children).toEqual([]);
    // A preview-only edit commits nothing, so the Dream counts zero work — but it
    // is still a valid no-op completion that records a clean window.
    expect(dreamFinished?.trigger).toBe('schedule');
    expect(dreamFinished?.status).toBe('completed');
    expect(dreamFinished?.changes?.updated).toBe(0);
    expect(dreamFinished?.changes?.added).toBe(0);
    expect(dreamFinished?.processed?.conversations[created.conversationId]?.throughSeq ?? 0).toBeGreaterThan(0);
  });

  test('scheduled Dream truncated by context overflow is a failure, not a no-op: completed window not recorded', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-dream-truncated-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-memory-dream-truncated-data-'));
    roots.push(localRoot, dataRoot);
    const core = Core.new();
    const script = scriptedStream(
      [
        // Foreground reply to the evidence message (normal turn).
        fauxAssistantMessage(fauxText('Captured enough evidence.')),
        // The Dream run is a silent context overflow: it ends 'stop'
        // with input far over the window and writes no memory nodes. With
        // compaction disabled the overflow is never resolved, so the run
        // completes but is TRUNCATED — it did not decide there was nothing to
        // remember, it was cut off.
        {
          ...fauxAssistantMessage(fauxText('Too much backlog to hold in context.')),
          stopReason: 'stop' as const,
          usage: { ...EMPTY_USAGE, input: 10_000_000 },
        },
      ],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(core),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        dreamMemoryExtractionEnabled: true,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        // Disable compaction so the reactive overflow compaction declines and the
        // run stays truncated (the deterministic way to reach the incomplete path).
        runtimeSettingsLoader: async () => ({ ...runtimeSettings(), compactEnabled: false }),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();
    const longEvidence = `Memory Dream sees a large backlog here. ${'memory-dream-overflow '.repeat(80)}`;
    await runtime.sendMessage(created.conversationId, longEvidence);
    const dueDay = scheduledTestNow(1);
    const expectedWindowEnd = previousLocalIsoDate(dueDay);
    await runtime.runScheduledDreamsForTest(dueDay);

    const store = new AgentEventStore(dataRoot);
    const dreamEvents = (await store.readEvents(DEFAULT_DREAM_CHANNEL_ID))
      .filter((event): event is Extract<AgentEvent, { type: 'dream.finished' }> => event.type === 'dream.finished');
    const dreamFinished = dreamEvents.at(-1);
    // A truncated child with zero writes must NOT record a completed window — that
    // would silently drop the span's evidence forever. It is a failure to retry,
    // distinct from a clean "nothing worth remembering" no-op.
    expect(dreamEvents.some((event) => event.status === 'completed' && event.window?.end === expectedWindowEnd)).toBe(false);
    expect(dreamFinished).toMatchObject({
      type: 'dream.finished',
      status: 'failed',
      trigger: 'schedule',
    });
    expect(dreamFinished && 'errorMessage' in dreamFinished ? dreamFinished.errorMessage : '').toContain('context overflow');
    const dreamRunMeta = dreamFinished?.type === 'dream.finished' && dreamFinished.runId
      ? await store.readRunMetaProjection(dreamFinished.runId)
      : null;
    expect(dreamRunMeta?.status).toBe('failed');
    expect(dreamRunMeta?.latestSeq ?? 0).toBeGreaterThan(0);
  });

  test('previewDreamReadiness reports below-threshold for thin new evidence and clears once volume accrues', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-readiness-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-dream-readiness-data-'));
    roots.push(localRoot, dataRoot);
    const core = Core.new();
    const script = scriptedStream(
      [
        fauxAssistantMessage(fauxText('Ack.')),
        fauxAssistantMessage(fauxText('Ack.')),
      ],
      () => undefined,
    );

    const { AgentRuntime } = await loadRuntimeModule();
    const sink = createWindowSink();
    const runtime = new AgentRuntime(
      () => sink.window as never,
      hostFor(core),
      {
        agentDataRoot: dataRoot,
        localFileRoot: localRoot,
        dreamMemoryExtractionEnabled: true,
        providerConfigLoader: async () => ({
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        }),
        runtimeSettingsLoader: async () => runtimeSettings(),
        streamFn: script.streamFn,
      },
    );

    const created = await runtime.restoreLatestConversation();

    // No new evidence in the default manual window → below threshold.
    const empty = await runtime.previewDreamReadiness();
    expect(empty.thresholdChars).toBeGreaterThan(0);
    expect(empty.newMessageCount).toBe(0);
    expect(empty.belowThreshold).toBe(true);

    // A short exchange stays below the volume bar.
    await runtime.sendMessage(created.conversationId, 'hi there');
    const thin = await runtime.previewDreamReadiness();
    expect(thin.newMessageCount).toBeGreaterThan(0);
    expect(thin.newCharCount).toBeLessThan(thin.thresholdChars);
    expect(thin.belowThreshold).toBe(true);

    // A long exchange clears the bar, so a manual Dream is worth running.
    await runtime.sendMessage(created.conversationId, `durable project decisions: ${'consolidate this signal '.repeat(80)}`);
    const fat = await runtime.previewDreamReadiness();
    expect(fat.newCharCount).toBeGreaterThanOrEqual(fat.thresholdChars);
    expect(fat.belowThreshold).toBe(false);

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
  });
});
