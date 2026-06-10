import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxText,
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
import type { AgentPrincipal } from '../../src/core/agentEventLog';
import { AgentEventStore } from '../../src/main/agentEventStore';
import type { OutlinerToolHost } from '../../src/main/agentNodeTools';

const MAIN_AGENT_ID = 'built-in:tenon:assistant';

const agentPrincipal = (agentId: string): AgentPrincipal => ({ type: 'agent', agentId });

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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

async function createRuntime(dataRoot: string, localRoot: string, streamFn: StreamFn) {
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
      streamFn,
    },
  );
  return { runtime, sink };
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
    const calls: RecordedCall[] = [];
    const script = scriptedStream(streamResponses, calls);
    const { runtime, sink } = await createRuntime(dataRoot, localRoot, script.streamFn);
    return { runtime, sink, calls, script, reviewerAgentId, dataRoot, localRoot };
  }

  test('@member routes the turn to that member, which runs as itself', async () => {
    const fixture = await setupChannelFixture([fauxAssistantMessage(fauxText('Reviewed: ship it.'))]);
    const { runtime, calls, reviewerAgentId, dataRoot } = fixture;

    await new AgentEventStore(dataRoot).addMemoryEntry(agentPrincipal(reviewerAgentId), {
      id: 'memory-reviewer-own',
      fact: 'Reviewer prefers terse verdicts.',
      sources: [{ conversationId: 'seed-reviewer' }],
    });

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], goal: 'Review work' });
    await runtime.sendMessage(channel.conversationId, '@reviewer please review the draft');

    // The peer ran as itself: member-voiced system prompt with its body, not the main prompt.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.systemPrompt).toContain('REVIEWER_AGENT_BODY');
    expect(calls[0]!.systemPrompt).toContain('@reviewer');
    // §8 flatten: the user turn arrives with an identity preamble.
    expect(calls[0]!.serialized).toContain('@user (the human user) said:');
    // The peer's own memory line is injected transiently into the assembled context.
    expect(calls[0]!.serialized).toContain('Reviewer prefers terse verdicts.');

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
  });

  test('no-@ routes to the coordinator; a coordinator @member hand-off produces that member run; the budget caps the chain', async () => {
    // Every reply mentions the other member — without the budget this relays forever.
    const fixture = await setupChannelFixture([
      (context) => {
        expect(context.systemPrompt ?? '').not.toContain('REVIEWER_AGENT_BODY');
        return fauxAssistantMessage(fauxText('@reviewer your call.'));
      },
      fauxAssistantMessage(fauxText('@assistant back to you.')),
      fauxAssistantMessage(fauxText('@reviewer once more.')),
      fauxAssistantMessage(fauxText('This response must never be requested.')),
    ]);
    const { runtime, calls, script, reviewerAgentId, dataRoot } = fixture;

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], goal: 'Relay test' });
    await runtime.sendMessage(channel.conversationId, 'someone take a look');

    // CHANNEL_RELAY_RUN_BUDGET = 3: coordinator → reviewer → coordinator, then stop.
    expect(calls).toHaveLength(3);
    expect(script.pendingCount()).toBe(1);
    expect(calls[1]!.systemPrompt).toContain('REVIEWER_AGENT_BODY');
    expect(calls[2]!.systemPrompt).not.toContain('REVIEWER_AGENT_BODY');
    // Hand-off context: the reviewer sees the coordinator's reply as a preambled user block.
    expect(calls[1]!.serialized).toContain('@assistant (agent');
    expect(calls[1]!.serialized).toContain('Tenon Assistant');
    expect(calls[1]!.serialized).not.toContain('\\"role\\":\\"assistant\\"');

    const state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    const runAgents = Object.values(state.runs).map((run) => run.agentId);
    expect(runAgents).toEqual([MAIN_AGENT_ID, reviewerAgentId, MAIN_AGENT_ID]);
    const userRecord = Object.values(state.messages).find((record) => record.role === 'user');
    expect(userRecord?.addressedTo).toEqual([agentPrincipal(MAIN_AGENT_ID)]);
  });

  test('DM behavior is unchanged: no routing, no addressedTo, main agent prompt', async () => {
    const fixture = await setupChannelFixture([fauxAssistantMessage(fauxText('Hello from the DM.'))]);
    const { runtime, calls, dataRoot } = fixture;

    const dm = await runtime.restoreLatestConversation();
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

  test('membership changes are real events: add/remove replay and survive restart; DM add spawns a seeded Channel', async () => {
    const fixture = await setupChannelFixture([]);
    const { runtime, reviewerAgentId, dataRoot } = fixture;
    const reviewer = agentPrincipal(reviewerAgentId);

    // Channel add → member.added; idempotent re-add appends nothing.
    const channel = await runtime.createConversation({ goal: 'Membership test' });
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

    // DM never converts: adding an agent spawns a NEW seeded Channel.
    const dm = await runtime.restoreLatestConversation();
    const spawned = await runtime.addConversationMember(dm.conversationId, reviewerAgentId);
    expect(spawned.conversationId).not.toBe(dm.conversationId);
    expect(spawned.conversationId).toMatch(/^lin-agent-channel-/);
    const spawnedState = await new AgentEventStore(dataRoot).replay(spawned.conversationId);
    expect(spawnedState.conversation?.members).toContainEqual(reviewer);
    expect(spawnedState.conversation?.members).toContainEqual(agentPrincipal(MAIN_AGENT_ID));
    const seed = Object.values(spawnedState.messages).find((record) => record.role === 'user');
    expect(JSON.stringify(seed?.content ?? '')).toContain('spawned from');
    const dmState = await new AgentEventStore(dataRoot).replay(dm.conversationId);
    expect(dmState.conversation?.members).toEqual([
      { type: 'user', userId: 'local-user' },
      agentPrincipal(MAIN_AGENT_ID),
    ]);

    // Guards: the coordinator and DM rosters are immovable.
    await expect(runtime.removeConversationMember(channel.conversationId, MAIN_AGENT_ID)).rejects.toThrow('coordinator');
    await expect(runtime.removeConversationMember(dm.conversationId, reviewerAgentId)).rejects.toThrow('DM');
    await expect(runtime.addConversationMember(channel.conversationId, 'project:nope:ghost')).rejects.toThrow('not found');
  });
});
