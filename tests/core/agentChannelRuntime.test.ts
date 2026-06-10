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

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], goal: 'Relay test' });
    await runtime.sendMessage(channel.conversationId, 'someone take a look');

    expect(calls).toHaveLength(4);
    expect(script.pendingCount()).toBe(0);
    expect(calls[1]!.systemPrompt).toContain('REVIEWER_AGENT_BODY');
    expect(calls[2]!.systemPrompt).not.toContain('REVIEWER_AGENT_BODY');
    expect(calls[3]!.systemPrompt).toContain('REVIEWER_AGENT_BODY');
    // Hand-off context: the reviewer sees the coordinator's reply as a preambled user block.
    expect(calls[1]!.serialized).toContain('@assistant (agent');
    expect(calls[1]!.serialized).toContain('Tenon Assistant');
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
    const { runtime, calls, reviewerAgentId, dataRoot } = fixture;

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], goal: 'Independent takes' });
    await runtime.sendMessage(channel.conversationId, '@assistant @reviewer give me independent takes');

    expect(calls).toHaveLength(2);
    // Independence cut: the second addressee never sees its sibling's same-round reply.
    expect(calls[1]!.serialized).toContain('independent takes');
    expect(calls[1]!.serialized).not.toContain('MAIN_TAKE_ALPHA');

    const state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    const userRecord = Object.values(state.messages).find((record) => record.role === 'user');
    expect(userRecord?.addressedTo).toEqual([agentPrincipal(MAIN_AGENT_ID), agentPrincipal(reviewerAgentId)]);
    // Both replies still land in the shared thread as messages.
    const texts = Object.values(state.messages).map((record) => JSON.stringify(record.content)).join('\n');
    expect(texts).toContain('MAIN_TAKE_ALPHA');
    expect(texts).toContain('REVIEWER_TAKE_BETA');
  });

  test('one addressee failing leaves its trace and never skips siblings', async () => {
    const fixture = await setupChannelFixture([
      fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'scripted coordinator failure' }),
      fauxAssistantMessage(fauxText('REVIEWER_STILL_RAN.')),
    ]);
    const { runtime, calls, reviewerAgentId, dataRoot } = fixture;

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], goal: 'Failure isolation' });
    await runtime.sendMessage(channel.conversationId, '@assistant @reviewer both of you');

    expect(calls).toHaveLength(2);
    expect(calls[1]!.systemPrompt).toContain('REVIEWER_AGENT_BODY');
    const state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    const texts = Object.values(state.messages).map((record) => JSON.stringify(record.content)).join('\n');
    expect(texts).toContain('REVIEWER_STILL_RAN');
    const runStatuses = Object.values(state.runs).map((run) => run.status);
    expect(runStatuses).toContain('failed');
    expect(runStatuses).toContain('completed');
  });

  test('a user message during an active round queues (no steer) and routes when the round ends', async () => {
    const holder: { runtime?: Awaited<ReturnType<typeof createRuntime>>['runtime']; channelId?: string; secondSend?: Promise<void> } = {};
    const fixture = await setupChannelFixture([
      () => {
        // Fired mid-round, while this first turn is still streaming: must queue,
        // never steer-inject into the live run.
        holder.secondSend = holder.runtime!.sendMessage(holder.channelId!, 'second message please') as Promise<void>;
        return fauxAssistantMessage(fauxText('FIRST_REPLY_OK.'));
      },
      fauxAssistantMessage(fauxText('SECOND_REPLY_OK.')),
    ]);
    const { runtime, calls, reviewerAgentId, dataRoot } = fixture;
    holder.runtime = runtime;

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], goal: 'Queue test' });
    holder.channelId = channel.conversationId;
    await runtime.sendMessage(channel.conversationId, 'first message');
    await holder.secondSend;

    // Two separate runs — the second message produced its own coordinator turn
    // whose context includes the settled first reply (cut at the second message).
    expect(calls).toHaveLength(2);
    expect(calls[0]!.serialized).not.toContain('second message please');
    expect(calls[1]!.serialized).toContain('FIRST_REPLY_OK');
    expect(calls[1]!.serialized).toContain('second message please');
    const state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    expect(Object.values(state.runs)).toHaveLength(2);
  });

  test('stop ends the round: unstarted turns discarded with a trace; queued messages persist unrouted', async () => {
    const holder: { runtime?: Awaited<ReturnType<typeof createRuntime>>['runtime']; channelId?: string; secondSend?: Promise<void> } = {};
    const fixture = await setupChannelFixture([
      () => {
        // Queue a message mid-round, then stop: the stopped round must persist
        // it into the thread (the user typed it) without ever routing it.
        holder.secondSend = holder.runtime!.sendMessage(holder.channelId!, 'QUEUED_BEHIND_STOP message') as Promise<void>;
        holder.runtime!.stopConversation(holder.channelId!);
        return fauxAssistantMessage(fauxText('Coordinator reply racing the stop.'));
      },
      fauxAssistantMessage(fauxText('This sibling turn must never be requested.')),
    ]);
    const { runtime, calls, script, reviewerAgentId, dataRoot } = fixture;
    holder.runtime = runtime;

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], goal: 'Stop test' });
    holder.channelId = channel.conversationId;
    await runtime.sendMessage(channel.conversationId, '@assistant @reviewer both of you');
    await holder.secondSend;

    expect(calls).toHaveLength(1);
    expect(script.pendingCount()).toBe(1);
    const state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    const runAgents = Object.values(state.runs).map((run) => run.agentId);
    expect(runAgents).toEqual([MAIN_AGENT_ID]);
    const texts = Object.values(state.messages).map((record) => JSON.stringify(record.content)).join('\n');
    expect(texts).toContain('The user stopped this round.');
    expect(texts).toContain('unstarted turn(s) were discarded');
    expect(texts).toContain('queued message(s) were not routed');
    expect(texts).toContain('QUEUED_BEHIND_STOP');
  });

  test('a non-round Channel run (regenerate) gates sends: the message queues and routes after it settles', async () => {
    const holder: { runtime?: Awaited<ReturnType<typeof createRuntime>>['runtime']; channelId?: string; midSend?: Promise<void> } = {};
    const fixture = await setupChannelFixture([
      fauxAssistantMessage(fauxText('Reviewer original take.')),
      () => {
        // Fired while the regenerated (non-round) turn streams: channelRound is
        // null here — the gate must still queue, never fork the leaf.
        holder.midSend = holder.runtime!.sendMessage(holder.channelId!, 'sent during the regenerate') as Promise<void>;
        return fauxAssistantMessage(fauxText('REVIEWER_REGEN_TAKE.'));
      },
      fauxAssistantMessage(fauxText('Coordinator answers the queued message.')),
    ]);
    const { runtime, calls, reviewerAgentId, dataRoot } = fixture;
    holder.runtime = runtime;

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], goal: 'Gate test' });
    holder.channelId = channel.conversationId;
    await runtime.sendMessage(channel.conversationId, '@reviewer take one');
    let state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    const reviewerReply = Object.values(state.messages).find((record) => record.role === 'assistant')!;
    await runtime.regenerateMessage(channel.conversationId, reviewerReply.id);
    await holder.midSend;

    expect(calls).toHaveLength(3);
    // The queued message routed AFTER the regenerated turn settled, with the
    // regenerated reply on its context path — the leaf was never forked.
    expect(calls[2]!.serialized).toContain('REVIEWER_REGEN_TAKE');
    expect(calls[2]!.serialized).toContain('sent during the regenerate');
    state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    const runAgents = Object.values(state.runs).map((run) => run.agentId);
    expect(runAgents).toEqual([reviewerAgentId, reviewerAgentId, MAIN_AGENT_ID]);
  });

  test('drainPendingWrites persists queued Channel messages so they survive quit mid-round', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-root-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-channel-data-'));
    roots.push(localRoot, dataRoot);
    const reviewerDir = await createAgentDefinition(localRoot, 'reviewer', '---\ndescription: r\n---\nbody');
    const reviewerAgentId = projectAgentId(reviewerDir, 'reviewer');
    // The turn hangs forever (a stream that never emits), exactly the state a
    // quit interrupts: the round is live, the queue holds an unrouted message.
    let streamCalls = 0;
    const hangingStream: StreamFn = (() => {
      streamCalls += 1;
      return createAssistantMessageEventStream();
    }) as StreamFn;
    const { runtime } = await createRuntime(dataRoot, localRoot, hangingStream);

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], goal: 'Quit flush test' });
    const hungSend = runtime.sendMessage(channel.conversationId, '@reviewer long task') as Promise<void>;
    while (streamCalls === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    // Round active → this queues in memory only.
    await runtime.sendMessage(channel.conversationId, 'TYPED_BEFORE_QUIT message');
    await runtime.drainPendingWrites();
    void hungSend; // abandoned mid-stream, as a real quit would leave it

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

    const dm = await runtime.restoreLatestConversation();
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

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], goal: 'Edit and regenerate' });
    await runtime.sendMessage(channel.conversationId, '@reviewer please review');
    expect(calls[0]!.systemPrompt).toContain('REVIEWER_AGENT_BODY');

    // Edit drops the mention: the replacement message re-resolves to the
    // coordinator (finding #5 — addressedTo must not silently carry over).
    let state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    const originalUser = Object.values(state.messages).find((record) => record.role === 'user')!;
    await runtime.editMessage(channel.conversationId, originalUser.id, 'actually, coordinator: summarize instead');
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
    const { runtime, reviewerAgentId, dataRoot } = fixture;
    const reviewer = agentPrincipal(reviewerAgentId);

    const channel = await runtime.createConversation({ agentIds: [reviewerAgentId], goal: 'Fold test' });
    await runtime.sendMessage(channel.conversationId, '@reviewer say something');
    await runtime.removeConversationMember(channel.conversationId, reviewerAgentId);
    // Later events carry no membership change: the fold must not resurrect the
    // removed member from ordinary event actors (finding #6).
    await runtime.sendMessage(channel.conversationId, 'carry on');

    const listed = await runtime.listConversations();
    const entry = listed.find((candidate) => candidate.id === channel.conversationId);
    expect(entry?.members).not.toContainEqual(reviewer);
    expect(entry?.members).toContainEqual(agentPrincipal(MAIN_AGENT_ID));
    const state = await new AgentEventStore(dataRoot).replay(channel.conversationId);
    expect(state.conversation?.members).not.toContainEqual(reviewer);
  });

  test('a mention-token collision is rejected at member-add time', async () => {
    const fixture = await setupChannelFixture([]);
    const { runtime, localRoot } = fixture;
    // A project agent named "assistant" collides with the coordinator's token.
    const impostorDir = await createAgentDefinition(localRoot, 'assistant', [
      '---',
      'description: Token impostor.',
      '---',
      'IMPOSTOR_BODY',
    ].join('\n'));
    const impostorAgentId = projectAgentId(impostorDir, 'assistant');

    const channel = await runtime.createConversation({ goal: 'Collision test' });
    await expect(runtime.addConversationMember(channel.conversationId, impostorAgentId))
      .rejects.toThrow('already addresses');
    await expect(runtime.createConversation({ agentIds: [impostorAgentId], goal: 'Collision at create' }))
      .rejects.toThrow('already addresses');
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
