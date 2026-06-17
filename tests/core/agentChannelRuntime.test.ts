import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
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
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core } from '../../src/core/core';
import { LIN_AGENT_EVENT_CHANNEL, type AgentRuntimeEvent } from '../../src/core/agentTypes';
import { replayAgentEvents } from '../../src/core/agentEventLog';
import type { AgentEvent, AgentMemoryStreamSource, AgentPrincipal } from '../../src/core/agentEventLog';
import { buildAgentRenderProjection } from '../../src/core/agentRenderProjection';
import { AgentEventStore } from '../../src/main/agentEventStore';
import { ASK_USER_QUESTION_TOOL_NAME } from '../../src/main/agentAskUserQuestionTool';
import type { OutlinerToolHost } from '../../src/main/agentNodeTools';
import type { AgentRenderProjection, AgentRenderActiveRun } from '../../src/core/agentRenderProjection';
import { AGENT_L0_FIRMWARE_PROMPT } from '../../src/main/agentSystemPrompt';

const MAIN_AGENT_ID = 'built-in:tenon:assistant';

const agentPrincipal = (agentId: string): AgentPrincipal => ({ type: 'agent', agentId });

const conversationSource = (conversationId: string): AgentMemoryStreamSource => ({
  stream: 'conversation',
  streamId: conversationId,
  range: {
    fromSeqExclusive: 0,
    throughSeq: 1,
    throughEventId: `${conversationId}-event-1`,
  },
});

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const ANTHROPIC_TEST_MODEL: Model<Api> = {
  id: 'claude-test',
  name: 'Claude Test',
  provider: 'anthropic',
  api: 'anthropic-messages',
  baseUrl: 'https://api.anthropic.com',
  reasoning: false,
  input: ['text'],
  contextWindow: 200_000,
  maxTokens: 8_192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const electronUserDataRoot = path.join(tmpdir(), 'lin-agent-channel-runtime-test-user-data');

mock.module('electron', () => ({
  app: {
    getPath: () => electronUserDataRoot,
    getVersion: () => 'test',
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

async function createAgentDefinition(root: string, name: string, body: string) {
  const agentDir = path.join(root, '.agents', 'agents', name);
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, 'AGENT.md'), body);
  return agentDir;
}

function projectAgentId(agentDir: string, name: string): string {
  const agentFile = path.join(agentDir, 'AGENT.md');
  return `project:${createHash('sha256').update(path.resolve(agentFile)).digest('hex').slice(0, 16)}:${name}`;
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

function latestRenderProjection(events: AgentRuntimeEvent[]): AgentRenderProjection {
  const projection = [...events].reverse().find((event) => event.type === 'projection')?.renderProjection;
  if (!projection) throw new Error('No render projection emitted.');
  return projection;
}

async function waitForPovInspectorProjection(
  events: AgentRuntimeEvent[],
  agentId: string,
  expectedMemoryText: string,
): Promise<AgentRenderProjection> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const projection = [...events].reverse().find((event) => event.type === 'projection')?.renderProjection;
    const inspector = projection?.povInspectors?.[agentId];
    if (inspector?.memoryBriefing?.includes(expectedMemoryText)) return projection;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`No POV inspector memory projection for ${agentId}`);
}

async function memoryAccessEventCount(
  store: AgentEventStore,
  principal: AgentPrincipal,
): Promise<number> {
  return (await store.readMemoryEvents(principal))
    .filter((event) => event.type === 'memory.accessed')
    .length;
}

interface RecordedCall {
  systemPrompt: string;
  serialized: string;
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

function scriptedStream(
  responses: Array<AssistantMessage | ((context: Context) => AssistantMessage)>,
  calls: RecordedCall[],
): { streamFn: StreamFn; pendingCount: () => number } {
  const queue = [...responses];
  const streamFn = ((model: Model<Api>, context: Context, _options?: SimpleStreamOptions) => {
    calls.push({
      systemPrompt: context.systemPrompt ?? '',
      serialized: JSON.stringify({ systemPrompt: context.systemPrompt, messages: context.messages }),
    });
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const step = queue.shift();
      const raw = step
        ? (typeof step === 'function' ? step(context) : step)
        : fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'No more scripted responses queued.' });
      const message = normalizeAssistantMessage(raw, model);
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
  }) as StreamFn;
  return { streamFn, pendingCount: () => queue.length };
}

function providerPayloadForSystemPrompt(systemPrompt: string) {
  const cacheControl = () => ({ type: 'ephemeral' });
  return {
    system: [{ type: 'text', text: systemPrompt, cache_control: cacheControl() }],
    tools: [{ name: 'node_read', cache_control: cacheControl() }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello', cache_control: cacheControl() }] }],
  };
}

function countCacheControls(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((total, item) => total + countCacheControls(item), 0);
  if (!value || typeof value !== 'object') return 0;
  const record = value as Record<string, unknown>;
  return ('cache_control' in record ? 1 : 0)
    + Object.values(record).reduce((total, item) => total + countCacheControls(item), 0);
}

function controlledStream(calls: RecordedCall[]) {
  const pending = new Map<string, { stream: ReturnType<typeof createAssistantMessageEventStream>; model: Model<Api> }>();
  const streamFn = ((model: Model<Api>, context: Context, _options?: SimpleStreamOptions) => {
    calls.push({
      systemPrompt: context.systemPrompt ?? '',
      serialized: JSON.stringify({ systemPrompt: context.systemPrompt, messages: context.messages }),
    });
    const key = (context.systemPrompt ?? '').includes('REVIEWER_AGENT_BODY') ? 'reviewer' : 'main';
    const stream = createAssistantMessageEventStream();
    pending.set(key, { stream, model });
    return stream;
  }) as StreamFn;
  const complete = (key: string, text: string) => {
    const entry = pending.get(key);
    if (!entry) throw new Error(`No pending stream for ${key}`);
    const message = normalizeAssistantMessage(fauxAssistantMessage(fauxText(text)), entry.model);
    entry.stream.push({ type: 'start', partial: { ...message, content: [] } });
    entry.stream.push({ type: 'done', reason: 'stop', message });
    entry.stream.end(message);
  };
  return { streamFn, complete };
}

async function createRuntime(
  dataRoot: string,
  localRoot: string,
  streamFn: StreamFn,
  options: {
    providerConfigLoader?: () => Promise<{
      providerId: string;
      enabled: boolean;
      apiKey: string;
    }>;
    providerModelResolver?: () => Model<Api>;
  } = {},
) {
  const { AgentRuntime } = await loadRuntimeModule();
  const sink = createWindowSink();
  const runtime = new AgentRuntime(
    () => sink.window as never,
    hostFor(Core.new()),
    {
      agentDataRoot: dataRoot,
      localFileRoot: localRoot,
      providerConfigLoader: options.providerConfigLoader ?? (async () => ({
        providerId: 'openai',
        enabled: true,
        apiKey: 'test-key',
      })),
      providerModelResolver: options.providerModelResolver,
      streamFn,
    },
  );
  return { runtime, sink };
}

async function sendMessageApprovingAgent(
  runtime: {
    sendMessage: (conversationId: string, message: string) => Promise<unknown>;
    resolveApproval: (conversationId: string, requestId: string, approved: boolean) => Promise<unknown>;
    drainChannelTurnsForTest: (conversationId: string) => Promise<void>;
  },
  conversationId: string,
  message: string,
  sink: ReturnType<typeof createWindowSink>,
) {
  // A Channel send returns on acceptance, so we approve against the explicit
  // drain (which spans the addressed runs) rather than the send promise.
  await runtime.sendMessage(conversationId, message);
  const drainPromise = runtime.drainChannelTurnsForTest(conversationId);
  const resolved = new Set<string>();
  let settled = false;
  drainPromise.finally(() => {
    settled = true;
  }).catch(() => undefined);

  while (!settled) {
    const approval = sink.events.find((event): event is Extract<AgentRuntimeEvent, { type: 'approval_request' }> => (
      event.type === 'approval_request' && !resolved.has(event.requestId)
    ));
    if (approval) {
      resolved.add(approval.requestId);
      await runtime.resolveApproval(conversationId, approval.requestId, true);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  await drainPromise;
}

describe('agent channel runtime', () => {
  let roots: string[] = [];

  beforeEach(() => {
    roots = [];
  });

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  async function setupChannelFixture(streamResponses: Array<AssistantMessage | ((context: Context) => AssistantMessage)>) {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-data-'));
    roots.push(localRoot, dataRoot);
    const reviewerDir = await createAgentDefinition(localRoot, 'reviewer', [
      '---',
      'description: Reviews drafts with a critical eye.',
      '---',
      'REVIEWER_AGENT_BODY: always review thoroughly.',
    ].join('\n'));
    const reviewerAgentId = projectAgentId(reviewerDir, 'reviewer');
    const observerDir = await createAgentDefinition(localRoot, 'observer', [
      '---',
      'description: Observes channel work.',
      '---',
      'OBSERVER_AGENT_BODY: observe quietly.',
    ].join('\n'));
    const observerAgentId = projectAgentId(observerDir, 'observer');
    const calls: RecordedCall[] = [];
    const script = scriptedStream(streamResponses, calls);
    const { runtime, sink } = await createRuntime(dataRoot, localRoot, script.streamFn);
    return { runtime, sink, calls, script, reviewerAgentId, observerAgentId, dataRoot, localRoot };
  }

  test('@member routes the turn to that member, which runs as itself', async () => {
    const fixture = await setupChannelFixture([fauxAssistantMessage(fauxText('Reviewed: ship it.'))]);
    const { runtime, sink, calls, reviewerAgentId, dataRoot } = fixture;

    const store = new AgentEventStore(dataRoot);
    await store.addMemoryEntry(agentPrincipal(reviewerAgentId), {
      id: 'memory-reviewer-own',
      fact: 'Reviewer prefers terse verdicts.',
      sources: [conversationSource('seed-reviewer')],
    });
    await store.addMemoryEntry(agentPrincipal(MAIN_AGENT_ID), {
      id: 'memory-main-co-member',
      fact: 'Assistant tracks architecture seams for handoffs.',
      sources: [conversationSource('seed-main')],
    });
    await store.addMemoryEntry(agentPrincipal('built-in:tenon:outsider'), {
      id: 'memory-outsider',
      fact: 'Outsider memory must not enter member briefings.',
      sources: [conversationSource('seed-outsider')],
    });

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], title: 'Review work' });
    await runtime.sendMessage(channel.conversationId, '@reviewer please review the draft');
    await runtime.drainChannelTurnsForTest(channel.conversationId);

    // The peer ran as itself: member-voiced system prompt with its body, not the main prompt.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.systemPrompt).toContain('REVIEWER_AGENT_BODY');
    expect(calls[0]!.systemPrompt).toContain('@reviewer');
    // §8 flatten: the user turn arrives with an identity preamble.
    expect(calls[0]!.serialized).toContain('@user (the human user) said:');
    // The peer's own memory line is injected transiently into the assembled context.
    expect(calls[0]!.serialized).toContain('Reviewer prefers terse verdicts.');
    // M3-B: agent co-member pools are visible by membership; non-member pools are not.
    expect(calls[0]!.serialized).toContain('Assistant tracks architecture seams for handoffs.');
    expect(calls[0]!.serialized).not.toContain('Outsider memory must not enter member briefings.');
    // Channel framing + communication norms ride the per-turn environment
    // reminder, never the identity-only system prompt (kept cacheable across DM
    // and Channel).
    expect(calls[0]!.systemPrompt).not.toContain('# Channel rules');
    expect(calls[0]!.systemPrompt).not.toContain('shared multi-agent conversation');
    expect(calls[0]!.serialized).toContain('conversation-environment');
    expect(calls[0]!.serialized).toContain('Only your final message is shared with the other members');

    const state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    expect(state.conversation?.members).toEqual([
      { type: 'user', userId: 'local-user' },
      { type: 'agent', agentId: MAIN_AGENT_ID },
      { type: 'agent', agentId: reviewerAgentId },
    ]);
    const records = Object.values(state.messages);
    const userRecord = records.find((record) => record.role === 'user');
    const assistantRecord = records.find((record) => record.role === 'assistant');
    // addressedTo written and read back; actor stamped with the peer principal.
    expect(userRecord?.addressedTo).toEqual([agentPrincipal(reviewerAgentId)]);
    // Reader-neutral log: the peer's memory line is NOT persisted into the shared message.
    expect(JSON.stringify(userRecord?.content)).not.toContain('Reviewer prefers terse verdicts.');
    expect(assistantRecord?.actor).toEqual({ type: 'agent', agentId: reviewerAgentId });
    const run = Object.values(state.runs).find((candidate) => candidate.status === 'completed');
    expect(run?.agentId).toBe(reviewerAgentId);

    const reviewerAccessCount = await memoryAccessEventCount(store, agentPrincipal(reviewerAgentId));
    const mainAccessCount = await memoryAccessEventCount(store, agentPrincipal(MAIN_AGENT_ID));
    const projection = await waitForPovInspectorProjection(
      sink.events,
      reviewerAgentId,
      'Reviewer prefers terse verdicts.',
    );
    const inspector = projection.povInspectors[reviewerAgentId]!;
    expect(inspector.memoryBriefing).toContain('Reviewer prefers terse verdicts.');
    expect(inspector.memoryBriefing).toContain('Assistant tracks architecture seams for handoffs.');
    expect(inspector.memoryBriefing).not.toContain('Outsider memory must not enter member briefings.');
    expect(inspector.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(inspector.messages[0]?.parts[0]?.preamble).toBe('@user (the human user) said:');
    expect(inspector.messages[0]?.sourceMessageIds).toEqual([userRecord?.id]);
    expect(inspector.messages[1]?.sourceMessageIds).toEqual([assistantRecord?.id]);
    expect(await memoryAccessEventCount(store, agentPrincipal(reviewerAgentId))).toBe(reviewerAccessCount);
    expect(await memoryAccessEventCount(store, agentPrincipal(MAIN_AGENT_ID))).toBe(mainAccessCount);

    await runtime.updateMemory('memory-main-co-member', 'Assistant tracks refreshed architecture seams.');
    const refreshed = await waitForPovInspectorProjection(
      sink.events,
      reviewerAgentId,
      'Assistant tracks refreshed architecture seams.',
    );
    expect(refreshed.povInspectors[reviewerAgentId]?.memoryBriefing).toContain('Assistant tracks refreshed architecture seams.');
    expect(await memoryAccessEventCount(store, agentPrincipal(reviewerAgentId))).toBe(reviewerAccessCount);
    expect(await memoryAccessEventCount(store, agentPrincipal(MAIN_AGENT_ID))).toBe(mainAccessCount);
  });

  test('multi-agent Channel member runs split Anthropic provider payload at the L0 cache breakpoint', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-cache-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-cache-data-'));
    roots.push(localRoot, dataRoot);

    const reviewerDir = await createAgentDefinition(localRoot, 'reviewer', [
      '---',
      'description: Reviews cache behavior.',
      '---',
      'REVIEWER_AGENT_BODY: check channel cache breakpoint wiring.',
    ].join('\n'));
    const reviewerAgentId = projectAgentId(reviewerDir, 'reviewer');
    const sentPayloads: unknown[] = [];
    const payloadReturns: unknown[] = [];
    const streamFn = ((model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        const payload = providerPayloadForSystemPrompt(context.systemPrompt ?? '');
        const payloadResult = await options?.onPayload?.(
          payload,
          model,
        );
        sentPayloads.push(payload);
        payloadReturns.push(payloadResult);
        const message = normalizeAssistantMessage(fauxAssistantMessage(fauxText('Channel reviewer done.')), model);
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end(message);
      });
      return stream;
    }) as StreamFn;
    const { runtime } = await createRuntime(dataRoot, localRoot, streamFn, {
      providerConfigLoader: async () => ({
        providerId: 'anthropic',
        modelId: ANTHROPIC_TEST_MODEL.id,
        reasoningLevel: 'low',
        enabled: true,
        apiKey: 'test-key',
      }),
      providerModelResolver: () => ANTHROPIC_TEST_MODEL,
    });

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], title: 'Cache breakpoint' });
    await runtime.sendMessage(channel.conversationId, '@reviewer check the cache breakpoint');
    await runtime.drainChannelTurnsForTest(channel.conversationId);

    expect(payloadReturns).toHaveLength(1);
    expect(payloadReturns[0]).toBe(sentPayloads[0]);
    const payload = sentPayloads[0] as { system?: Array<{ text?: unknown; cache_control?: unknown }> } | undefined;
    expect(payload?.system).toHaveLength(2);
    expect(payload?.system?.[0]).toMatchObject({ type: 'text', text: AGENT_L0_FIRMWARE_PROMPT });
    expect(payload?.system?.[0]).toHaveProperty('cache_control');
    expect(payload?.system?.[1]).toHaveProperty('cache_control');
    expect(String(payload?.system?.[1]?.text)).toContain('REVIEWER_AGENT_BODY');
    expect(countCacheControls(payload)).toBe(4);
  });

  test('a coordinator-only Channel still serializes the Channel environment block, not the DM block', async () => {
    // Regression the gate flagged: DM-vs-Channel is conversation identity (the
    // `lin-agent-channel-` id prefix), NOT live agent headcount. A Channel
    // created with no extra agents has only its coordinator as an agent member —
    // `isMultiAgentConversation` is false — yet must still be framed as a Channel.
    // The old headcount-keyed code wrongly served such a room the DM block.
    const fixture = await setupChannelFixture([fauxAssistantMessage(fauxText('On it.'))]);
    const { runtime, calls, dataRoot } = fixture;

    const channel = await runtime.createConversation({ title: 'Solo room' });
    await runtime.sendMessage(channel.conversationId, 'kick things off');
    await runtime.drainChannelTurnsForTest(channel.conversationId);

    // The no-@ turn ran the coordinator (the only agent member), once.
    expect(calls).toHaveLength(1);
    // It carried the Channel environment block — keyed off identity, so a
    // coordinator-only room is still a Channel — never the DM 1:1 framing.
    expect(calls[0]!.serialized).toContain('conversation-environment');
    expect(calls[0]!.serialized).toContain('Only your final message is shared with the other members');
    expect(calls[0]!.serialized).not.toContain('direct 1:1 conversation');

    // It really is coordinator-only: the user plus the coordinator, no other agent.
    const state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    expect(state.conversation?.members).toEqual([
      { type: 'user', userId: 'local-user' },
      { type: 'agent', agentId: MAIN_AGENT_ID },
    ]);
  });

  test('a coordinator-only Channel exposes active work as Channel activity, not DM streaming', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-data-'));
    roots.push(localRoot, dataRoot);
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: RecordedCall[] = [];
    const streamFn = ((model: Model<Api>, context: Context, _options?: SimpleStreamOptions) => {
      calls.push({
        systemPrompt: context.systemPrompt ?? '',
        serialized: JSON.stringify({ systemPrompt: context.systemPrompt, messages: context.messages }),
      });
      const stream = createAssistantMessageEventStream();
      void started.then(() => {
        const message = normalizeAssistantMessage(fauxAssistantMessage(fauxText('Finished in the Channel.')), model);
        stream.push({ type: 'start', partial: { ...message, content: [] } });
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end(message);
      });
      return stream;
    }) as StreamFn;
    const { runtime, sink } = await createRuntime(dataRoot, localRoot, streamFn);

    const channel = await runtime.createConversation({ title: 'Solo activity room' });
    await runtime.sendMessage(channel.conversationId, 'show this as Channel activity');

    let projection: AgentRenderProjection | null = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      projection = latestRenderProjection(sink.events);
      const activeEntry = projection.channelActivityEntries.find((entry) => entry.runId);
      if (calls.length === 1 && projection.channelRunsActive && activeEntry) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(calls).toHaveLength(1);
    expect(projection?.dmRunActive).toBe(false);
    expect(projection?.dmStreaming).toBeNull();
    expect(projection?.channelRunsActive).toBe(true);
    expect(projection?.channelActivityEntries).toHaveLength(1);
    expect(projection?.channelActivityEntries[0]).toMatchObject({
      agentId: MAIN_AGENT_ID,
      runId: expect.any(String),
      state: 'thinking',
    });

    release();
    await runtime.drainChannelTurnsForTest(channel.conversationId);
  });

  test('no-@ routes to the coordinator; a hand-off chain is unbounded and ends when a reply stops mentioning', async () => {
    // Four runs — past the old relay budget of 3; the chain ends only because the
    // last reply mentions nobody (stop is the sole circuit breaker otherwise).
    const fixture = await setupChannelFixture([
      (context) => {
        expect(context.systemPrompt ?? '').not.toContain('REVIEWER_AGENT_BODY');
        return fauxAssistantMessage(fauxText('@reviewer your call.'));
      },
      fauxAssistantMessage(fauxText('@assistant back to you.')),
      fauxAssistantMessage(fauxText('@reviewer once more.')),
      fauxAssistantMessage(fauxText('Done; no further hand-off.')),
    ]);
    const { runtime, calls, script, reviewerAgentId, dataRoot } = fixture;

    await new AgentEventStore(dataRoot).addMemoryEntry(agentPrincipal(reviewerAgentId), {
      id: 'memory-reviewer-co-member',
      fact: 'Reviewer watches for brittle hand-off assumptions.',
      sources: [conversationSource('seed-reviewer')],
    });

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], title: 'Relay test' });
    await runtime.sendMessage(channel.conversationId, 'someone take a look');
    await runtime.drainChannelTurnsForTest(channel.conversationId);

    expect(calls).toHaveLength(4);
    expect(script.pendingCount()).toBe(0);
    expect(calls[1]!.systemPrompt).toContain('REVIEWER_AGENT_BODY');
    expect(calls[2]!.systemPrompt).not.toContain('REVIEWER_AGENT_BODY');
    expect(calls[3]!.systemPrompt).toContain('REVIEWER_AGENT_BODY');
    // Coordinator reads the peer agent's distilled pool by the same membership rule.
    expect(calls[0]!.serialized).toContain('Reviewer watches for brittle hand-off assumptions.');
    // Hand-off context: the reviewer sees the coordinator's reply as a preambled user block.
    expect(calls[1]!.serialized).toContain('@assistant (agent');
    expect(calls[1]!.serialized).toContain('Neva');
    expect(calls[1]!.serialized).not.toContain('\\"role\\":\\"assistant\\"');

    const state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    const runAgents = Object.values(state.runs).map((run) => run.agentId);
    expect(runAgents).toEqual([MAIN_AGENT_ID, reviewerAgentId, MAIN_AGENT_ID, reviewerAgentId]);
    const userRecord = Object.values(state.messages).find((record) => record.role === 'user');
    expect(userRecord?.addressedTo).toEqual([agentPrincipal(MAIN_AGENT_ID)]);
    // Hand-off addressing is persisted on the handing-off reply itself — the
    // routing is visible in the log, not just runtime behavior.
    const assistantRecords = Object.values(state.messages)
      .filter((record) => record.role === 'assistant')
      .sort((left, right) => left.createdAt - right.createdAt);
    expect(assistantRecords[0]!.addressedTo).toEqual([agentPrincipal(reviewerAgentId)]);
    expect(assistantRecords[3]!.addressedTo ?? []).toEqual([]);
  });

  test('multi-@ runs every addressee with contexts cut at the user message (independent answers)', async () => {
    const fixture = await setupChannelFixture([
      fauxAssistantMessage(fauxText('MAIN_TAKE_ALPHA — coordinator view.')),
      fauxAssistantMessage(fauxText('REVIEWER_TAKE_BETA — reviewer view.')),
    ]);
    const { runtime, sink, calls, reviewerAgentId, dataRoot } = fixture;

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], title: 'Independent takes' });
    await runtime.sendMessage(channel.conversationId, '@assistant @reviewer give me independent takes');
    await runtime.drainChannelTurnsForTest(channel.conversationId);

    expect(calls).toHaveLength(2);
    // Independence cut: the second addressee never sees its sibling's same-round reply.
    expect(calls[1]!.serialized).toContain('independent takes');
    expect(calls[1]!.serialized).not.toContain('MAIN_TAKE_ALPHA');

    const state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    const userRecord = Object.values(state.messages).find((record) => record.role === 'user');
    expect(userRecord?.addressedTo).toEqual([agentPrincipal(MAIN_AGENT_ID), agentPrincipal(reviewerAgentId)]);
    const runRecords = Object.values(state.runs).sort((left, right) => left.startedAt - right.startedAt);
    expect(runRecords.map((record) => record.addressedByMessageId)).toEqual([
      userRecord?.id,
      userRecord?.id,
    ]);
    // Both replies still land in the shared thread as messages.
    const texts = Object.values(state.messages).map((record) => JSON.stringify(record.content)).join('\n');
    expect(texts).toContain('MAIN_TAKE_ALPHA');
    expect(texts).toContain('REVIEWER_TAKE_BETA');
    const assistantRecords = Object.values(state.messages)
      .filter((record) => record.role === 'assistant')
      .sort((left, right) => left.createdAt - right.createdAt);
    expect(assistantRecords.map((record) => record.addressedByMessageId)).toEqual([
      userRecord?.id,
      userRecord?.id,
    ]);
    const projection = latestRenderProjection(sink.events);
    expect(assistantRecords.map((record) => projection.entities.messages[record.id]?.addressedByMessageId)).toEqual([
      userRecord?.id,
      userRecord?.id,
    ]);
    const visibleMessageIds = projection.transcriptRows
      .filter((row) => row.kind === 'message')
      .map((row) => row.messageId);
    expect(visibleMessageIds).toEqual([
      userRecord?.id,
      assistantRecords[0]?.id,
      assistantRecords[1]?.id,
    ]);
  });

  test('co-addressee replies land in completion order, not dispatch order', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-data-'));
    roots.push(localRoot, dataRoot);
    const reviewerDir = await createAgentDefinition(localRoot, 'reviewer', [
      '---',
      'description: Reviews drafts with a critical eye.',
      '---',
      'REVIEWER_AGENT_BODY: always review thoroughly.',
    ].join('\n'));
    const reviewerAgentId = projectAgentId(reviewerDir, 'reviewer');
    const calls: RecordedCall[] = [];
    const control = controlledStream(calls);
    const { runtime } = await createRuntime(dataRoot, localRoot, control.streamFn);

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], title: 'Completion order' });
    await runtime.sendMessage(channel.conversationId, '@assistant @reviewer answer independently');
    while (calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    control.complete('reviewer', 'REVIEWER_FAST');
    control.complete('main', 'MAIN_SLOW');
    await runtime.drainChannelTurnsForTest(channel.conversationId);

    const events = await new AgentEventStore(dataRoot).readEvents(channel.conversationId);
    const completedTexts = events
      .filter((event): event is Extract<AgentEvent, { type: 'assistant_message.completed' }> => (
        event.type === 'assistant_message.completed'
      ))
      .map((event) => JSON.stringify(event.content));
    expect(completedTexts).toEqual([
      expect.stringContaining('REVIEWER_FAST'),
      expect.stringContaining('MAIN_SLOW'),
    ]);
  });

  test('an in-progress Channel turn is suppressed only while its run is LIVE, never when orphaned', async () => {
    // Atomic delivery (spec): a running Channel turn is "never a transcript row".
    // Suppression is keyed off the LIVE active-run set, NOT persisted status — so a
    // turn hides while genuinely in flight, but a run orphaned `running` by a crash
    // still renders (its interrupted turn must not silently vanish).
    const reply = (context: Context) => fauxAssistantMessage(fauxText(
      (context.systemPrompt ?? '').includes('REVIEWER_AGENT_BODY') ? 'REVIEWER_ANSWER.' : 'MAIN_ANSWER.',
    ));
    const fixture = await setupChannelFixture([reply, reply]);
    const { runtime, reviewerAgentId, dataRoot } = fixture;

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], title: 'Atomic delivery' });
    await runtime.sendMessage(channel.conversationId, '@assistant @reviewer answer independently');
    await runtime.drainChannelTurnsForTest(channel.conversationId);

    const events = await new AgentEventStore(dataRoot).readEvents(channel.conversationId);
    const sealed = replayAgentEvents(events);
    const transcriptText = (
      state: ReturnType<typeof replayAgentEvents>,
      activeRuns: AgentRenderActiveRun[] = [],
    ) => {
      const projection = buildAgentRenderProjection(state, { revision: 1, activeRuns });
      return projection.transcriptRows
        .filter((row) => row.kind === 'message')
        .map((row) => JSON.stringify(projection.entities.messages[row.messageId]?.content ?? ''))
        .join('\n');
    };

    // Exactly one reviewer run (don't take an arbitrary one).
    const reviewerRuns = Object.values(sealed.runs).filter((run) => run.agentId === reviewerAgentId);
    expect(reviewerRuns).toHaveLength(1);
    const reviewerRun = reviewerRuns[0]!;

    // No live runs → both turns are transcript rows.
    expect(transcriptText(sealed)).toContain('MAIN_ANSWER');
    expect(transcriptText(sealed)).toContain('REVIEWER_ANSWER');

    // Reviewer run marked LIVE → its whole turn drops out; the coordinator stays.
    const liveText = transcriptText(sealed, [{
      runId: reviewerRun.id,
      agentId: reviewerAgentId,
      addressedByMessageId: reviewerRun.addressedByMessageId ?? null,
      startedAt: reviewerRun.startedAt,
    }]);
    expect(liveText).toContain('MAIN_ANSWER');
    expect(liveText).not.toContain('REVIEWER_ANSWER');

    // Regression guard (crash/quit): a run orphaned `running` — status running but
    // NOT in the live set — must STILL render rather than vanish.
    const orphaned = replayAgentEvents(
      events.filter((event) => !(event.type === 'run.completed' && event.runId === reviewerRun.id)),
    );
    expect(orphaned.runs[reviewerRun.id]?.status).toBe('running');
    expect(transcriptText(orphaned)).toContain('REVIEWER_ANSWER');
  });

  test('one addressee failing leaves its trace and never skips siblings', async () => {
    const fixture = await setupChannelFixture([
      fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'scripted coordinator failure' }),
      fauxAssistantMessage(fauxText('REVIEWER_STILL_RAN.')),
    ]);
    const { runtime, calls, reviewerAgentId, dataRoot } = fixture;

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], title: 'Failure isolation' });
    await runtime.sendMessage(channel.conversationId, '@assistant @reviewer both of you');
    await runtime.drainChannelTurnsForTest(channel.conversationId);

    expect(calls).toHaveLength(2);
    expect(calls[1]!.systemPrompt).toContain('REVIEWER_AGENT_BODY');
    const state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    const texts = Object.values(state.messages).map((record) => JSON.stringify(record.content)).join('\n');
    expect(texts).toContain('REVIEWER_STILL_RAN');
    const runStatuses = Object.values(state.runs).map((run) => run.status);
    expect(runStatuses).toContain('failed');
    expect(runStatuses).toContain('completed');
  });

  test('a user message during in-flight Channel runs persists and dispatches immediately', async () => {
    const holder: { runtime?: Awaited<ReturnType<typeof createRuntime>>['runtime']; channelId?: string; secondSend?: Promise<void> } = {};
    const fixture = await setupChannelFixture([
      () => {
        // Fired mid-run: Channel does not steer into the live run. The new
        // message becomes its own addressed turn immediately.
        holder.secondSend = holder.runtime!.sendMessage(holder.channelId!, 'second message please') as Promise<void>;
        return fauxAssistantMessage(fauxText('FIRST_REPLY_OK.'));
      },
      fauxAssistantMessage(fauxText('SECOND_REPLY_OK.')),
    ]);
    const { runtime, calls, reviewerAgentId, dataRoot } = fixture;
    holder.runtime = runtime;

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], title: 'Queue test' });
    holder.channelId = channel.conversationId;
    await runtime.sendMessage(channel.conversationId, 'first message');
    await holder.secondSend;
    await runtime.drainChannelTurnsForTest(channel.conversationId);

    // Two separate runs — the second message produced its own coordinator turn
    // immediately. Its context cuts at the second message, so it does not see
    // the earlier in-flight reply even though that reply finishes first here.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.serialized).not.toContain('second message please');
    expect(calls[1]!.serialized).not.toContain('FIRST_REPLY_OK');
    expect(calls[1]!.serialized).toContain('second message please');
    const state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    expect(Object.values(state.runs)).toHaveLength(2);
  });

  test('a Channel send resolves on acceptance, before the addressed run finishes', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-data-'));
    roots.push(localRoot, dataRoot);
    const reviewerDir = await createAgentDefinition(localRoot, 'reviewer', [
      '---',
      'description: Reviews drafts with a critical eye.',
      '---',
      'REVIEWER_AGENT_BODY: always review thoroughly.',
    ].join('\n'));
    const reviewerAgentId = projectAgentId(reviewerDir, 'reviewer');
    const calls: RecordedCall[] = [];
    const control = controlledStream(calls);
    const { runtime } = await createRuntime(dataRoot, localRoot, control.streamFn);

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], title: 'Async send' });
    // The send resolves even though the addressed run never produced a reply yet
    // (the controlled stream is still open). This is the core async-bus contract:
    // send returns when the message is accepted, not when the runs drain.
    await runtime.sendMessage(channel.conversationId, '@reviewer take your time');
    while (calls.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));

    const inflight = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    expect(Object.values(inflight.messages).some((record) => record.role === 'user')).toBe(true);
    expect(Object.values(inflight.runs).some((run) => run.status === 'running')).toBe(true);
    expect(Object.values(inflight.messages).some(
      (record) => record.role === 'assistant' && record.status === 'completed',
    )).toBe(false);

    // Completing the run and draining settles the Channel as usual.
    control.complete('reviewer', 'REVIEWER_REPLIED_LATER');
    await runtime.drainChannelTurnsForTest(channel.conversationId);
    const settled = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    const texts = Object.values(settled.messages).map((record) => JSON.stringify(record.content)).join('\n');
    expect(texts).toContain('REVIEWER_REPLIED_LATER');
  });

  test('conversation stop cancels in-flight Channel runs and discards capped pending turns with a trace', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-data-'));
    roots.push(localRoot, dataRoot);
    const agentIds: string[] = [];
    for (const name of ['agent1', 'agent2', 'agent3', 'agent4', 'agent5']) {
      const dir = await createAgentDefinition(localRoot, name, `---\ndescription: ${name}\n---\n${name} body`);
      agentIds.push(projectAgentId(dir, name));
    }
    let streamCalls = 0;
    const hangingStream: StreamFn = (() => {
      streamCalls += 1;
      return createAssistantMessageEventStream();
    }) as StreamFn;
    const { runtime } = await createRuntime(dataRoot, localRoot, hangingStream);

    const channel = await runtime.createConversation({ agentIds, title: 'Stop cap test' });
    const send = runtime.sendMessage(channel.conversationId, '@agent1 @agent2 @agent3 @agent4 @agent5 all run') as Promise<void>;
    while (streamCalls < 4) await new Promise((resolve) => setTimeout(resolve, 5));
    runtime.stopConversation(channel.conversationId);
    for (let i = 0; i < 100; i += 1) {
      const snapshot = await new AgentEventStore(dataRoot).replay(channel.conversationId);
      const texts = Object.values(snapshot.messages).map((record) => JSON.stringify(record.content)).join('\n');
      if (texts.includes('unstarted turn(s) were discarded')) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    void send;

    expect(streamCalls).toBe(4);
    const state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    const texts = Object.values(state.messages).map((record) => JSON.stringify(record.content)).join('\n');
    expect(texts).toContain('The user stopped this round.');
    expect(texts).toContain('unstarted turn(s) were discarded');
    expect(Object.values(state.runs)).toHaveLength(4);
  });

  test('conversation stop during Channel startup prevents a late run from starting', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-data-'));
    roots.push(localRoot, dataRoot);
    const reviewerDir = await createAgentDefinition(localRoot, 'reviewer', '---\ndescription: r\n---\nbody');
    const reviewerAgentId = projectAgentId(reviewerDir, 'reviewer');
    const calls: RecordedCall[] = [];
    const script = scriptedStream([fauxAssistantMessage(fauxText('AFTER_STOP_OK'))], calls);
    let releaseProvider!: () => void;
    let holdProvider = true;
    let providerRequests = 0;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const { runtime } = await createRuntime(dataRoot, localRoot, script.streamFn, {
      providerConfigLoader: async () => {
        providerRequests += 1;
        if (providerRequests > 1 && holdProvider) await providerGate;
        return {
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        };
      },
    });

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], title: 'Stop startup test' });
    const send = runtime.sendMessage(channel.conversationId, 'first message') as Promise<void>;
    while (providerRequests < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    runtime.stopConversation(channel.conversationId);
    holdProvider = false;
    releaseProvider();
    await send;

    let state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    expect(Object.values(state.runs)).toHaveLength(0);
    expect(calls).toHaveLength(0);

    await runtime.sendMessage(channel.conversationId, 'after stop');
    await runtime.drainChannelTurnsForTest(channel.conversationId);
    state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    expect(Object.values(state.runs)).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const texts = Object.values(state.messages).map((record) => JSON.stringify(record.content)).join('\n');
    expect(texts).toContain('AFTER_STOP_OK');
  });

  test('a send that lands while a stopped round is still draining resumes the Channel (no deadlock)', async () => {
    // Regression: async-accept means a Channel send can enqueue a pending turn
    // WHILE channelStopRequested is still set (a stop whose runs have not finished
    // draining). maybeClearChannelStopRequested must clear once the runs drain, NOT
    // gate on pending being empty — otherwise the late send is pinned in
    // pendingChannelTurns forever and the Channel deadlocks (channelRunsActive stuck
    // true, no run ever launches). Deterministic: the provider gate holds the first
    // turn in startup so the second send is provably enqueued before the stop drains.
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-data-'));
    roots.push(localRoot, dataRoot);
    const reviewerDir = await createAgentDefinition(localRoot, 'reviewer', '---\ndescription: r\n---\nbody');
    const reviewerAgentId = projectAgentId(reviewerDir, 'reviewer');
    const calls: RecordedCall[] = [];
    const script = scriptedStream([fauxAssistantMessage(fauxText('RESUMED_OK'))], calls);
    let releaseProvider!: () => void;
    let holdProvider = true;
    let providerRequests = 0;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const { runtime } = await createRuntime(dataRoot, localRoot, script.streamFn, {
      providerConfigLoader: async () => {
        providerRequests += 1;
        if (providerRequests > 1 && holdProvider) await providerGate;
        return {
          providerId: 'openai',
          enabled: true,
          apiKey: 'test-key',
        };
      },
    });

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], title: 'Resume after stop' });
    // First addressed turn parks in startup behind the provider gate.
    void (runtime.sendMessage(channel.conversationId, '@reviewer first') as Promise<void>);
    while (providerRequests < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    // Stop the round, then enqueue a NEW send while the stop is still draining.
    // Awaiting the send (it resolves on acceptance) guarantees the pending turn is
    // queued with channelStopRequested still set, before the held turn unwinds.
    runtime.stopConversation(channel.conversationId);
    await runtime.sendMessage(channel.conversationId, '@reviewer after stop');
    // Release the held first turn: it bails on the stop flag; the flag must then
    // clear (its run drained) so the pending second turn pumps and completes.
    holdProvider = false;
    releaseProvider();
    await runtime.drainChannelTurnsForTest(channel.conversationId);

    const state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    const completed = Object.values(state.runs).filter((run) => run.status === 'completed');
    expect(completed).toHaveLength(1);
    const texts = Object.values(state.messages).map((record) => JSON.stringify(record.content)).join('\n');
    expect(texts).toContain('RESUMED_OK');
  });

  test('a peer reply bumps unread for a backgrounded Channel, but not while it is viewed', async () => {
    // Plan §5: switching away from an active Channel is allowed, and a completed
    // reply increments unread for that conversation — via the existing
    // notification.created / conversation_attention fold (badge-only, no OS ding).
    const fixture = await setupChannelFixture([
      fauxAssistantMessage(fauxText('Reply while backgrounded.')),
      fauxAssistantMessage(fauxText('Reply while viewed.')),
    ]);
    const { runtime, reviewerAgentId, dataRoot } = fixture;
    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], title: 'Unread test' });

    // Backgrounded (user is elsewhere / dock collapsed): the reply raises unread.
    runtime.setViewedConversation(null);
    await runtime.sendMessage(channel.conversationId, '@reviewer one');
    await runtime.drainChannelTurnsForTest(channel.conversationId);
    let state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    expect(state.attentionByConversationId[channel.conversationId]?.unreadCount ?? 0).toBe(1);

    // Viewed: a reply does NOT raise unread (the user is reading it) — still 1.
    runtime.setViewedConversation(channel.conversationId);
    await runtime.sendMessage(channel.conversationId, '@reviewer two');
    await runtime.drainChannelTurnsForTest(channel.conversationId);
    state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    expect(state.attentionByConversationId[channel.conversationId]?.unreadCount ?? 0).toBe(1);
  });

  test('per-run stop cancels one Channel run without stopping siblings', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-data-'));
    roots.push(localRoot, dataRoot);
    const reviewerDir = await createAgentDefinition(localRoot, 'reviewer', [
      '---',
      'description: Reviews drafts with a critical eye.',
      '---',
      'REVIEWER_AGENT_BODY: always review thoroughly.',
    ].join('\n'));
    const reviewerAgentId = projectAgentId(reviewerDir, 'reviewer');
    const calls: RecordedCall[] = [];
    const control = controlledStream(calls);
    const { runtime } = await createRuntime(dataRoot, localRoot, control.streamFn);

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], title: 'Scoped stop' });
    await runtime.sendMessage(channel.conversationId, '@assistant @reviewer both run');
    while (calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    let state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    const reviewerRun = Object.values(state.runs).find((run) => run.agentId === reviewerAgentId)!;
    expect(runtime.stopRun(channel.conversationId, reviewerRun.id)).toEqual({ stopped: true });
    control.complete('main', 'MAIN_STILL_COMPLETED');
    await runtime.drainChannelTurnsForTest(channel.conversationId);

    state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    expect(state.runs[reviewerRun.id]?.status).toBe('cancelled');
    const mainRun = Object.values(state.runs).find((run) => run.agentId === MAIN_AGENT_ID)!;
    expect(mainRun.status).toBe('completed');
    const texts = Object.values(state.messages).map((record) => JSON.stringify(record.content)).join('\n');
    expect(texts).toContain('MAIN_STILL_COMPLETED');
  });

  test('concurrent Channel runs keep run-scoped pending questions; stopping one clears only its own', async () => {
    const askToolCall = (toolCallId: string) => fauxAssistantMessage([
      fauxToolCall(ASK_USER_QUESTION_TOOL_NAME, {
        questions: [{
          id: 'direction',
          type: 'single_choice',
          header: 'Direction',
          question: 'Which way?',
          options: [
            { id: 'left', label: 'Left' },
            { id: 'right', label: 'Right' },
          ],
        }],
      }, { id: toolCallId }),
    ], { stopReason: 'toolUse' });
    // Both co-addressed runs ask a question first (order-independent: each run
    // shifts one of the two identical tool-call responses), then reply once their
    // own question resolves.
    const fixture = await setupChannelFixture([
      askToolCall('ask-a'),
      askToolCall('ask-b'),
      fauxAssistantMessage(fauxText('REPLY_AFTER_ANSWER.')),
      fauxAssistantMessage(fauxText('UNREACHED_AFTER_STOP.')),
    ]);
    const { runtime, sink, reviewerAgentId, dataRoot } = fixture;

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], title: 'Concurrent questions' });
    await runtime.sendMessage(channel.conversationId, '@assistant @reviewer both decide');

    const questionEvents = () => sink.events.filter(
      (event): event is Extract<AgentRuntimeEvent, { type: 'user_question_request' }> => event.type === 'user_question_request',
    );
    while (questionEvents().length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    const questions = questionEvents();

    // Both requests are retained, keyed by distinct runIds — neither run's
    // pending question overwrote the other's.
    expect(new Set(questions.map((event) => event.question.runId)).size).toBe(2);
    expect(new Set(questions.map((event) => event.requestId)).size).toBe(2);

    const state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    const reviewerRun = Object.values(state.runs).find((run) => run.agentId === reviewerAgentId)!;
    const reviewerQuestion = questions.find((event) => event.question.runId === reviewerRun.id)!;
    const survivingQuestion = questions.find((event) => event.question.runId !== reviewerRun.id)!;

    // Stopping the reviewer run clears ONLY its pending question.
    expect(runtime.stopRun(channel.conversationId, reviewerRun.id)).toEqual({ stopped: true });
    const resolvedFor = (requestId: string) => sink.events.some(
      (event) => event.type === 'user_question_resolved' && event.requestId === requestId,
    );
    for (let attempt = 0; attempt < 100 && !resolvedFor(reviewerQuestion.requestId); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(resolvedFor(reviewerQuestion.requestId)).toBe(true);
    expect(resolvedFor(survivingQuestion.requestId)).toBe(false);

    // The surviving run's question still resolves independently and lets it finish.
    await runtime.resolveUserQuestion(channel.conversationId, survivingQuestion.requestId, {
      outcome: 'discussed',
      message: 'go left',
    });
    await runtime.drainChannelTurnsForTest(channel.conversationId);
    const settled = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    expect(settled.runs[reviewerRun.id]?.status).toBe('cancelled');
    expect(Object.values(settled.runs).some((run) => run.status === 'completed')).toBe(true);
  });

  test('Channel peer delegation is parented to the peer run, not the coordinator', async () => {
    const fixture = await setupChannelFixture([
      fauxAssistantMessage([
        fauxToolCall('Agent', {
          description: 'fork from reviewer',
          prompt: 'Inspect from the reviewer context.',
        }, { id: 'tool-reviewer-fork' }),
      ], { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxText('Child result.')),
      fauxAssistantMessage(fauxText('Reviewer used child result.')),
    ]);
    const { runtime, sink, reviewerAgentId, dataRoot } = fixture;

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], title: 'Delegation parent test' });
    await sendMessageApprovingAgent(runtime, channel.conversationId, '@reviewer fork a child', sink);

    const state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    const reviewerRun = Object.values(state.runs).find((run) => run.agentId === reviewerAgentId);
    expect(reviewerRun).toBeDefined();
    const childRun = Object.values(state.childRuns)[0];
    expect(childRun).toBeDefined();
    expect(childRun.parentRunId).toBe(reviewerRun!.id);
    expect(childRun.parentAgentId).toBe(reviewerAgentId);
    expect(childRun.executingAgentId).toBe(reviewerAgentId);
  });

  test('a message sent during a regenerate dispatches immediately with its own context cut', async () => {
    const holder: { runtime?: Awaited<ReturnType<typeof createRuntime>>['runtime']; channelId?: string; midSend?: Promise<void> } = {};
    const fixture = await setupChannelFixture([
      fauxAssistantMessage(fauxText('Reviewer original take.')),
      () => {
        // Fired while the regenerated turn streams: the new message dispatches
        // immediately and cuts context at itself.
        holder.midSend = holder.runtime!.sendMessage(holder.channelId!, 'sent during the regenerate') as Promise<void>;
        return fauxAssistantMessage(fauxText('REVIEWER_REGEN_TAKE.'));
      },
      fauxAssistantMessage(fauxText('Coordinator answers the queued message.')),
    ]);
    const { runtime, calls, reviewerAgentId, dataRoot } = fixture;
    holder.runtime = runtime;

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], title: 'Gate test' });
    holder.channelId = channel.conversationId;
    await runtime.sendMessage(channel.conversationId, '@reviewer take one');
    await runtime.drainChannelTurnsForTest(channel.conversationId);
    let state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    const reviewerReply = Object.values(state.messages).find((record) => record.role === 'assistant')!;
    await runtime.regenerateMessage(channel.conversationId, reviewerReply.id);
    await holder.midSend;
    await runtime.drainChannelTurnsForTest(channel.conversationId);

    expect(calls).toHaveLength(3);
    // The concurrent message does not wait for the regenerated reply.
    expect(calls[2]!.serialized).not.toContain('REVIEWER_REGEN_TAKE');
    expect(calls[2]!.serialized).toContain('sent during the regenerate');
    state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    const runAgents = Object.values(state.runs).map((run) => run.agentId);
    expect(runAgents).toEqual([reviewerAgentId, reviewerAgentId, MAIN_AGENT_ID]);
  });

  test('a mid-flight Channel message is already persisted before quit flushing', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-data-'));
    roots.push(localRoot, dataRoot);
    const reviewerDir = await createAgentDefinition(localRoot, 'reviewer', '---\ndescription: r\n---\nbody');
    const reviewerAgentId = projectAgentId(reviewerDir, 'reviewer');
    // The turn hangs forever (a stream that never emits), exactly the state a
    // quit interrupts. The second message must already be in the log; there is
    // no in-memory Channel message queue to flush anymore.
    let streamCalls = 0;
    const hangingStream: StreamFn = (() => {
      streamCalls += 1;
      return createAssistantMessageEventStream();
    }) as StreamFn;
    const { runtime } = await createRuntime(dataRoot, localRoot, hangingStream);

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], title: 'Quit flush test' });
    const hungSend = runtime.sendMessage(channel.conversationId, '@reviewer long task') as Promise<void>;
    while (streamCalls === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const secondSend = runtime.sendMessage(channel.conversationId, 'TYPED_BEFORE_QUIT message') as Promise<void>;
    while (streamCalls < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    await runtime.drainPendingWrites();
    void hungSend; // abandoned mid-stream, as a real quit would leave it
    void secondSend;

    const state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    const texts = Object.values(state.messages).map((record) => JSON.stringify(record.content)).join('\n');
    expect(texts).toContain('TYPED_BEFORE_QUIT');
    const queuedRecord = Object.values(state.messages).find(
      (record) => JSON.stringify(record.content).includes('TYPED_BEFORE_QUIT'),
    );
    expect(queuedRecord?.addressedTo).toEqual([agentPrincipal(MAIN_AGENT_ID)]);
  });

  test('a run that dies without agent_end never wedges the conversation', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-data-'));
    roots.push(localRoot, dataRoot);
    await createAgentDefinition(localRoot, 'reviewer', '---\ndescription: r\n---\nbody');
    const calls: RecordedCall[] = [];
    const script = scriptedStream([fauxAssistantMessage(fauxText('Recovered fine.'))], calls);
    let threw = false;
    const throwingOnce: StreamFn = ((model, context, options) => {
      if (!threw) {
        threw = true;
        throw new Error('synchronous stream construction failure');
      }
      return (script.streamFn as (...args: unknown[]) => ReturnType<StreamFn>)(model, context, options);
    }) as StreamFn;
    const { runtime, sink } = await createRuntime(dataRoot, localRoot, throwingOnce);

    const dmRow = (await runtime.listConversations())
      .find((entry) => entry.canonicalDmAgentId === MAIN_AGENT_ID);
    expect(dmRow).toBeDefined();
    const dm = await runtime.restoreConversation(dmRow!.id);
    await runtime.sendMessage(dm.conversationId, 'first message hits the throwing stream');
    // Without recovery this second send would die on 'A run is already active'.
    await runtime.sendMessage(dm.conversationId, 'second message must still run');

    expect(calls).toHaveLength(1);
    const wedgeErrors = sink.events.filter(
      (event) => event.type === 'error' && String((event as { message?: string }).message ?? '').includes('already active'),
    );
    expect(wedgeErrors).toHaveLength(0);
    const state = await new AgentEventStore(dataRoot).replay(dm.conversationId);
    const statuses = Object.values(state.runs).map((run) => run.status).sort();
    expect(statuses).toEqual(['completed', 'failed']);
  });

  test('edit re-resolves addressing; regenerate re-runs as the original speaker', async () => {
    const fixture = await setupChannelFixture([
      fauxAssistantMessage(fauxText('Reviewer first take.')),
      fauxAssistantMessage(fauxText('Coordinator take after the edit.')),
      fauxAssistantMessage(fauxText('Reviewer regenerated take.')),
    ]);
    const { runtime, calls, reviewerAgentId, dataRoot } = fixture;

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], title: 'Edit and regenerate' });
    await runtime.sendMessage(channel.conversationId, '@reviewer please review');
    await runtime.drainChannelTurnsForTest(channel.conversationId);
    expect(calls[0]!.systemPrompt).toContain('REVIEWER_AGENT_BODY');

    // Edit drops the mention: the replacement message re-resolves to the
    // coordinator (finding #5 — addressedTo must not silently carry over).
    let state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    const originalUser = Object.values(state.messages).find((record) => record.role === 'user')!;
    await runtime.editMessage(channel.conversationId, originalUser.id, 'actually, coordinator: summarize instead');
    await runtime.drainChannelTurnsForTest(channel.conversationId);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.systemPrompt).not.toContain('REVIEWER_AGENT_BODY');
    state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    const editedUser = Object.values(state.messages).find(
      (record) => record.role === 'user' && record.id !== originalUser.id,
    );
    expect(editedUser?.addressedTo).toEqual([agentPrincipal(MAIN_AGENT_ID)]);

    // Regenerating the reviewer's settled reply re-runs AS the reviewer (finding
    // #5 — identity from the record, not the coordinator default).
    const reviewerRun = Object.values(state.runs).find((run) => run.agentId === reviewerAgentId)!;
    const reviewerReply = Object.values(state.messages).find(
      (record) => record.role === 'assistant' && record.runId === reviewerRun.id,
    )!;
    await runtime.switchBranch(channel.conversationId, originalUser.id);
    await runtime.regenerateMessage(channel.conversationId, reviewerReply.id);
    await runtime.drainChannelTurnsForTest(channel.conversationId);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.systemPrompt).toContain('REVIEWER_AGENT_BODY');
    state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    const regeneratedRun = Object.values(state.runs).at(-1);
    expect(regeneratedRun?.agentId).toBe(reviewerAgentId);
  });

  test('a removed member stays removed in the list index even after later activity (fold regression)', async () => {
    const fixture = await setupChannelFixture([
      fauxAssistantMessage(fauxText('Reviewer spoke once.')),
      fauxAssistantMessage(fauxText('Coordinator continues without the reviewer.')),
    ]);
    const { runtime, reviewerAgentId, observerAgentId, dataRoot } = fixture;
    const reviewer = agentPrincipal(reviewerAgentId);

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId, observerAgentId], title: 'Fold test' });
    await runtime.sendMessage(channel.conversationId, '@reviewer say something');
    await runtime.drainChannelTurnsForTest(channel.conversationId);
    await runtime.removeConversationMember(channel.conversationId, reviewerAgentId);
    // Later events carry no membership change: the fold must not resurrect the
    // removed member from ordinary event actors (finding #6).
    await runtime.sendMessage(channel.conversationId, 'carry on');
    await runtime.drainChannelTurnsForTest(channel.conversationId);

    const listed = await runtime.listConversations();
    const entry = listed.find((candidate) => candidate.id === channel.conversationId);
    expect(entry?.members).not.toContainEqual(reviewer);
    expect(entry?.members).toContainEqual(agentPrincipal(MAIN_AGENT_ID));
    expect(entry?.members).toContainEqual(agentPrincipal(observerAgentId));
    const state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    expect(state.conversation?.members).not.toContainEqual(reviewer);
  });

  test('a mention-token collision is rejected at member-add time', async () => {
    const fixture = await setupChannelFixture([]);
    const { runtime, localRoot, reviewerAgentId } = fixture;
    // A project agent named "assistant" collides with the coordinator's token.
    const impostorDir = await createAgentDefinition(localRoot, 'assistant', [
      '---',
      'description: Token impostor.',
      '---',
      'IMPOSTOR_BODY',
    ].join('\n'));
    const impostorAgentId = projectAgentId(impostorDir, 'assistant');

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], title: 'Collision test' });
    await expect(runtime.addConversationMember(channel.conversationId, impostorAgentId))
      .rejects.toThrow('already addresses');
    await expect(runtime.createConversation({ agentIds: [impostorAgentId], title: 'Collision at create' }))
      .rejects.toThrow('already addresses');
  });

  test('DM behavior is unchanged: no routing, no addressedTo, main agent prompt', async () => {
    const fixture = await setupChannelFixture([fauxAssistantMessage(fauxText('Hello from the DM.'))]);
    const { runtime, calls, dataRoot } = fixture;

    const dmRow = (await runtime.listConversations())
      .find((entry) => entry.canonicalDmAgentId === MAIN_AGENT_ID);
    expect(dmRow).toBeDefined();
    const dm = await runtime.restoreConversation(dmRow!.id);
    await runtime.sendMessage(dm.conversationId, 'hello @reviewer');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.systemPrompt).not.toContain('REVIEWER_AGENT_BODY');
    expect(calls[0]!.serialized).not.toContain('the human user) said:');

    const state = await new AgentEventStore(dataRoot).replay(dm.conversationId);
    const userRecord = Object.values(state.messages).find((record) => record.role === 'user');
    expect(userRecord?.addressedTo).toBeUndefined();
    const run = Object.values(state.runs)[0];
    expect(run?.agentId).toBe(MAIN_AGENT_ID);
  });

  test('a non-coordinator canonical DM uses a DM prompt, not the Channel peer prompt', async () => {
    const fixture = await setupChannelFixture([fauxAssistantMessage(fauxText('Hello from reviewer DM.'))]);
    const { runtime, calls, reviewerAgentId, dataRoot } = fixture;

    const reviewerDm = (await runtime.listConversations())
      .find((entry) => entry.canonicalDmAgentId === reviewerAgentId);
    expect(reviewerDm).toBeDefined();

    const dm = await runtime.restoreConversation(reviewerDm!.id);
    await runtime.sendMessage(dm.conversationId, 'hello @reviewer');

    expect(calls).toHaveLength(1);
    // Identity stays in the system prompt; DM framing moves to the per-turn
    // environment reminder, so the prompt is identical (and cacheable) in a DM
    // and a Channel.
    expect(calls[0]!.systemPrompt).toContain('REVIEWER_AGENT_BODY');
    expect(calls[0]!.systemPrompt).not.toContain('# Direct message rules');
    expect(calls[0]!.systemPrompt).not.toContain('direct 1:1 conversation');
    expect(calls[0]!.systemPrompt).not.toContain('# Channel rules');
    expect(calls[0]!.systemPrompt).not.toContain('shared multi-agent conversation');
    expect(calls[0]!.serialized).toContain('conversation-environment');
    expect(calls[0]!.serialized).toContain('direct 1:1 conversation with the user');
    expect(calls[0]!.serialized).not.toContain('the human user) said:');

    const state = await new AgentEventStore(dataRoot).replay(dm.conversationId);
    const userRecord = Object.values(state.messages).find((record) => record.role === 'user');
    expect(userRecord?.addressedTo).toBeUndefined();
    const run = Object.values(state.runs)[0];
    expect(run?.agentId).toBe(reviewerAgentId);
  });

  test('membership changes are real events: add/remove replay and survive restart; DMs stay immutable', async () => {
    const fixture = await setupChannelFixture([]);
    const { runtime, reviewerAgentId, observerAgentId, dataRoot } = fixture;
    const reviewer = agentPrincipal(reviewerAgentId);

    // Channel add → member.added; idempotent re-add appends nothing.
    const channel = await runtime.createConversation({ agentIds: [observerAgentId], title: 'Membership test' });
    await runtime.addConversationMember(channel.conversationId, reviewerAgentId);
    await runtime.addConversationMember(channel.conversationId, reviewerAgentId);
    let state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    expect(state.conversation?.members).toContainEqual(reviewer);
    expect(Object.values(state.messages)).toHaveLength(0);

    // Restart (fresh store replay) keeps the roster — the round-trip acceptance.
    const reopened = await runtime.restoreConversation(channel.conversationId);
    expect(reopened.renderProjection.members.map((member) => member.principal)).toContainEqual(reviewer);

    // Removal drops it, durably.
    await runtime.removeConversationMember(channel.conversationId, reviewerAgentId);
    state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    expect(state.conversation?.members).not.toContainEqual(reviewer);

    // The conversation list index follows membership (incremental fold, no rebuild).
    const listed = await runtime.listConversations();
    const entry = listed.find((candidate) => candidate.id === channel.conversationId);
    expect(entry?.members).not.toContainEqual(reviewer);
    expect(entry?.members).toContainEqual(agentPrincipal(observerAgentId));

    // DMs never convert or accept membership edits.
    const dmRow = (await runtime.listConversations())
      .find((entry) => entry.canonicalDmAgentId === MAIN_AGENT_ID);
    expect(dmRow).toBeDefined();
    const dm = await runtime.restoreConversation(dmRow!.id);
    await expect(runtime.addConversationMember(dm.conversationId, reviewerAgentId)).rejects.toThrow('DM');
    const dmState = await new AgentEventStore(dataRoot).replay(dm.conversationId);
    expect(dmState.conversation?.members).toEqual([
      { type: 'user', userId: 'local-user' },
      agentPrincipal(MAIN_AGENT_ID),
    ]);

    // Guards: the coordinator and DM rosters are immovable.
    await expect(runtime.removeConversationMember(channel.conversationId, MAIN_AGENT_ID)).rejects.toThrow('coordinator');
    await expect(runtime.removeConversationMember(dm.conversationId, reviewerAgentId)).rejects.toThrow('DM');
    const singleInviteChannel = await runtime.createConversation({ agentIds: [reviewerAgentId], title: 'Single invite removal test' });
    await runtime.removeConversationMember(singleInviteChannel.conversationId, reviewerAgentId);
    const singleInviteState = await new AgentEventStore(dataRoot).replay(singleInviteChannel.conversationId);
    expect(singleInviteState.conversation?.members).toEqual([
      { type: 'user', userId: 'local-user' },
      agentPrincipal(MAIN_AGENT_ID),
    ]);
    await expect(runtime.addConversationMember(channel.conversationId, 'project:nope:ghost')).rejects.toThrow('not found');
  });
});
