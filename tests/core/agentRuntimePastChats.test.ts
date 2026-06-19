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
  type AgentMemorySource,
  type AgentPersistedContent,
  type AgentPrincipal,
} from '../../src/core/agentEventLog';
import { LIN_AGENT_EVENT_CHANNEL, type AgentRuntimeEvent } from '../../src/core/agentTypes';
import { AgentEventStore } from '../../src/main/agentEventStore';
import type { OutlinerToolHost } from '../../src/main/agentNodeTools';

const BELIEVER_PRINCIPAL: AgentPrincipal = { type: 'agent', agentId: 'built-in:tenon:assistant' };

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
    expect(tools).toContain('runtime_status');
    expect(tools).toContain('doctor');
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

  test('legacy memory entries are not passively injected into the model context', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-no-briefing-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-no-briefing-data-'));
    roots.push(localRoot, dataRoot);
    await new AgentEventStore(dataRoot).addMemoryEntry(BELIEVER_PRINCIPAL, {
      id: 'memory-no-passive-briefing',
      fact: 'forbidden passive briefing phrase should stay out of model context',
      originWorkspace: 'workspace:test',
      sources: [conversationSource('legacy-memory-source')],
    });
    const calls: Array<{ text: string; tools: string[] }> = [];
    const script = scriptedStream(
      [fauxAssistantMessage(fauxText('No passive memory.'))],
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
    await runtime.sendMessage(created.conversationId, 'Please answer directly.');

    expect(script.pendingCount()).toBe(0);
    expect(calls.map((call) => call.text).join('\n')).not.toContain('forbidden passive briefing phrase');
  });

  test('scheduled Dream invokes the private memory-dream skill through a restricted child run', async () => {
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
            outline: '- Dream memory\n  - User prefers cobalt focus rings',
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
    await runtime.runScheduledDreamsForTest(new Date('2026-01-02T04:00:00Z'));

    const dreamCall = calls.find((call) => call.text.includes('<memory-dream-run>'));
    const dreamState = await new AgentEventStore(dataRoot).readDreamState(BELIEVER_PRINCIPAL);

    expect(script.pendingCount()).toBe(0);
    expect(sink.events.some((event) => event.type === 'error')).toBe(false);
    expect(dreamCall).toBeDefined();
    expect(dreamCall?.tools.sort()).toEqual([
      'node_create',
      'node_edit',
      'node_read',
      'node_search',
      'past_chats',
    ].sort());
    expect(dreamCall?.text).toContain("Tenon's private memory consolidation pass");
    expect(dreamCall?.text).toContain('Read and consolidate only these sources');
    expect(dreamCall?.text).toContain('"past_chats"');
    expect(dreamCall?.text).toContain('total_char_count');
    expect(dreamCall?.text).toContain('[[chat:source-1^conversation:');
    expect(dreamState.lastCompleted?.trigger).toBe('schedule');
    expect(dreamState.lastCompleted?.processed.totalCharCount).toBeGreaterThan(1000);
    expect(dreamState.lastCompleted?.changes.added).toBeGreaterThan(0);
    expect(dreamState.watermark.conversations[created.conversationId]?.seq).toBeGreaterThan(0);
    expect((await runtime.listConversations()).map((entry) => entry.id)).not.toContain('lin-agent-memory-dream');
  });

  test('scheduled Dream does not advance the watermark when the child writes no memory nodes', async () => {
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
    const longEvidence = `Memory Dream should retry this evidence later. ${'memory-dream-empty '.repeat(80)}`;
    await runtime.sendMessage(created.conversationId, longEvidence);
    await runtime.runScheduledDreamsForTest(new Date('2026-01-02T04:00:00Z'));

    const dreamState = await new AgentEventStore(dataRoot).readDreamState(BELIEVER_PRINCIPAL);
    expect(script.pendingCount()).toBe(0);
    expect(dreamState.lastCompleted).toBeNull();
    expect(dreamState.watermark.conversations[created.conversationId]?.seq ?? 0).toBe(0);
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
    await runtime.runScheduledDreamsForTest(new Date('2026-01-02T04:00:00Z'));

    const dreamState = await new AgentEventStore(dataRoot).readDreamState(BELIEVER_PRINCIPAL);
    expect(script.pendingCount()).toBe(0);
    expect(core.state().nodes[previewTarget]!.children).toEqual([]);
    expect(dreamState.lastCompleted).toBeNull();
    expect(dreamState.watermark.conversations[created.conversationId]?.seq ?? 0).toBe(0);
  });
});
