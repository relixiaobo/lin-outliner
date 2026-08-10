import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { EffectiveThreadConfiguration } from '../../src/core/agent/configuration';
import type { Thread, ThreadItem, Turn } from '../../src/core/agent/protocol';
import { ExtensionRegistry } from '../../src/main/agent/ExtensionRegistry';
import { RolloutStore } from '../../src/main/agent/persistence/RolloutStore';
import { ThreadHistoryProjectionStore } from '../../src/main/agent/persistence/ThreadHistoryProjectionStore';
import { ThreadMetadataStore } from '../../src/main/agent/persistence/ThreadMetadataStore';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';
import { ToolPayloadStore } from '../../src/main/agent/persistence/ToolPayloadStore';
import { ThreadCore } from '../../src/main/agent/thread/ThreadCore';
import { uuidV7 } from '../../src/main/agent/uuid';
import { replayableModelCall } from '../fixtures/agentToolCallHistory';

interface StreamingFixture {
  readonly root: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly agentOne: Extract<ThreadItem, { type: 'agentMessage' }>;
  readonly agentTwo: Extract<ThreadItem, { type: 'agentMessage' }>;
  readonly reasoning: Extract<ThreadItem, { type: 'reasoning' }>;
  readonly dynamicTool: Extract<ThreadItem, { type: 'dynamicToolCall' }>;
  readonly coreClock: ManualScheduler;
  readonly core: ThreadCore;
  readonly rollout: RolloutStore;
  readonly history: ThreadHistoryProjectionStore;
  readonly metadata: ThreadMetadataStore;
}

interface ManualScheduler {
  readonly pending: ReadonlySet<() => void>;
  readonly schedule: (callback: () => void) => unknown;
  readonly cancel: (handle: unknown) => void;
  readonly runAll: () => void;
}

const fixtures: StreamingFixture[] = [];
let fixtureSeed = 10_000;

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.core.flush();
    fixture.history.close();
    fixture.metadata.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

describe('Agent streaming delta pipeline', () => {
  test('coalesces a text burst into one downstream notification and flushes it from the injected timer', async () => {
    const fixture = await createFixture();
    let downstreamDeltaCount = 0;
    const unsubscribe = fixture.core.subscribe((notification) => {
      if (notification.type === 'item/delta') downstreamDeltaCount += 1;
    });
    const chunks = Array.from({ length: 100 }, (_, index) => `[${index}]`);
    for (const delta of chunks) {
      await fixture.core.recordNotification({
        type: 'item/delta',
        threadId: fixture.threadId,
        turnId: fixture.turnId,
        itemId: fixture.agentOne.id,
        delta: { type: 'agentMessageText', delta },
      });
    }
    expect(fixture.coreClock.pending.size).toBe(1);
    fixture.coreClock.runAll();
    await fixture.core.flushThreadNotifications(fixture.threadId);

    const deltas = (await fixture.rollout.read(fixture.threadId))
      .map((entry) => entry.event)
      .filter((event) => event.type === 'item/delta');
    expect(deltas).toEqual([{
      type: 'item/delta',
      threadId: fixture.threadId,
      turnId: fixture.turnId,
      itemId: fixture.agentOne.id,
      delta: { type: 'agentMessageText', delta: chunks.join('') },
    }]);
    expect(downstreamDeltaCount).toBe(1);
    expect(fixture.history.readTurn(fixture.threadId, fixture.turnId, 'full')?.items)
      .toContainEqual({ ...fixture.agentOne, text: chunks.join('') });
    unsubscribe();
  });

  test('flushes a pending delta before the Item completion barrier', async () => {
    const fixture = await createFixture();
    for (const delta of ['A', 'B']) {
      await fixture.core.recordNotification({
        type: 'item/delta',
        threadId: fixture.threadId,
        turnId: fixture.turnId,
        itemId: fixture.agentOne.id,
        delta: { type: 'agentMessageText', delta },
      });
    }
    await fixture.core.recordNotification({
      type: 'item/completed',
      threadId: fixture.threadId,
      turnId: fixture.turnId,
      itemId: fixture.agentOne.id,
      item: { ...fixture.agentOne, text: 'AB' },
      completedAt: fixtureSeed,
    });

    const itemEvents = (await fixture.rollout.read(fixture.threadId))
      .map((entry) => entry.event)
      .filter((event) => event.type === 'item/delta' || (
        event.type === 'item/completed' && event.itemId === fixture.agentOne.id
      ));
    expect(itemEvents.map((event) => event.type)).toEqual(['item/delta', 'item/completed']);
    expect(itemEvents[0]).toMatchObject({ delta: { type: 'agentMessageText', delta: 'AB' } });
  });

  test('does not merge deltas across Item or delta-type boundaries', async () => {
    const fixture = await createFixture();
    const notifications = [
      {
        itemId: fixture.agentOne.id,
        delta: { type: 'agentMessageText' as const, delta: 'first' },
      },
      {
        itemId: fixture.agentTwo.id,
        delta: { type: 'agentMessageText' as const, delta: 'second' },
      },
      {
        itemId: fixture.reasoning.id,
        delta: { type: 'reasoningSummary' as const, delta: 'summary' },
      },
      {
        itemId: fixture.reasoning.id,
        delta: { type: 'reasoningContent' as const, delta: 'content' },
      },
    ];
    for (const notification of notifications) {
      await fixture.core.recordNotification({
        type: 'item/delta',
        threadId: fixture.threadId,
        turnId: fixture.turnId,
        ...notification,
      });
    }
    await fixture.core.flushThreadNotifications(fixture.threadId);

    const deltas = (await fixture.rollout.read(fixture.threadId))
      .map((entry) => entry.event)
      .filter((event) => event.type === 'item/delta');
    expect(deltas.map((event) => [event.itemId, event.delta.type])).toEqual([
      [fixture.agentOne.id, 'agentMessageText'],
      [fixture.agentTwo.id, 'agentMessageText'],
      [fixture.reasoning.id, 'reasoningSummary'],
      [fixture.reasoning.id, 'reasoningContent'],
    ]);
  });

  test('passes dynamic tool output deltas through without merging discrete content', async () => {
    const fixture = await createFixture();
    for (const text of ['first', 'second']) {
      await fixture.core.recordNotification({
        type: 'item/delta',
        threadId: fixture.threadId,
        turnId: fixture.turnId,
        itemId: fixture.dynamicTool.id,
        delta: { type: 'dynamicToolOutput', delta: { type: 'text', text } },
      });
    }

    const deltas = (await fixture.rollout.read(fixture.threadId))
      .map((entry) => entry.event)
      .filter((event) => event.type === 'item/delta');
    expect(deltas).toHaveLength(2);
    expect(fixture.history.readTurn(fixture.threadId, fixture.turnId, 'full')?.items)
      .toContainEqual({
        ...fixture.dynamicTool,
        contentItems: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      });
  });
});

async function createFixture(): Promise<StreamingFixture> {
  const seed = fixtureSeed;
  fixtureSeed += 100;
  const root = await mkdtemp(join(tmpdir(), 'tenon-streaming-pipeline-'));
  const threadId = uuidV7(seed);
  const turnId = uuidV7(seed + 1);
  const metadataPath = join(root, 'state.sqlite');
  const historyPath = join(root, 'history.sqlite');
  const metadata = new ThreadMetadataStore(metadataPath, testDatabase(metadataPath));
  const history = new ThreadHistoryProjectionStore(historyPath, testDatabase(historyPath));
  const rolloutClock = manualScheduler();
  const rollout = new RolloutStore(join(root, 'rollouts'), {
    schedule: rolloutClock.schedule,
    cancelScheduled: rolloutClock.cancel,
  });
  const coreClock = manualScheduler();
  const core = new ThreadCore(
    metadata,
    history,
    rollout,
    new ToolPayloadStore(join(root, 'payloads')),
    new ExtensionRegistry(),
    {
      schedule: coreClock.schedule,
      cancelScheduled: coreClock.cancel,
    },
  );
  const owner = thread(threadId, seed);
  metadata.create({
    thread: owner,
    nameOrigin: 'none',
    archived: false,
    configuration,
    toolCeiling: null,
    modelOverride: null,
    reasoningEffortOverride: null,
  });
  const provenance = (itemId: string) => ({
    originThreadId: threadId,
    originTurnId: turnId,
    originItemId: itemId,
  });
  const agentOne: StreamingFixture['agentOne'] = {
    type: 'agentMessage',
    id: 'agent-one',
    provenance: provenance('agent-one'),
    text: '',
    phase: 'final_answer',
    memoryCitation: null,
  };
  const agentTwo: StreamingFixture['agentTwo'] = {
    ...agentOne,
    id: 'agent-two',
    provenance: provenance('agent-two'),
  };
  const reasoning: StreamingFixture['reasoning'] = {
    type: 'reasoning',
    id: 'reasoning-one',
    provenance: provenance('reasoning-one'),
    summary: [],
    content: [],
  };
  const dynamicTool: StreamingFixture['dynamicTool'] = {
    type: 'dynamicToolCall',
    id: 'dynamic-one',
    provenance: provenance('dynamic-one'),
    namespace: null,
    tool: 'streaming_tool',
    arguments: {},
    status: 'inProgress',
    outputRef: null,
    contentItems: null,
    success: null,
    durationMs: null,
    modelCall: replayableModelCall('streaming_tool', {}),
  };
  const userItem: ThreadItem = {
    type: 'userMessage',
    id: 'user-one',
    provenance: provenance('user-one'),
    clientId: null,
    acceptedAt: seed,
    content: [{ type: 'text', text: 'Stream the response' }],
  };
  const startedTurn: Turn = {
    id: turnId,
    items: [userItem],
    itemsView: 'full',
    provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
    status: 'inProgress',
    error: null,
    execution: turnExecution,
    startedAt: seed,
    completedAt: null,
    durationMs: null,
  };
  await core.recordNotification({ type: 'turn/started', threadId, turnId, turn: startedTurn });
  const streamedItems = [agentOne, agentTwo, reasoning, dynamicTool];
  for (const [index, item] of streamedItems.entries()) {
    await core.recordNotification({
      type: 'item/started',
      threadId,
      turnId,
      itemId: item.id,
      item,
      startedAt: seed + index + 1,
    });
  }
  const fixture = {
    root,
    threadId,
    turnId,
    agentOne,
    agentTwo,
    reasoning,
    dynamicTool,
    coreClock,
    core,
    rollout,
    history,
    metadata,
  };
  fixtures.push(fixture);
  return fixture;
}

function manualScheduler(): ManualScheduler {
  const pending = new Set<() => void>();
  return {
    pending,
    schedule: (callback) => {
      pending.add(callback);
      return callback;
    },
    cancel: (handle) => {
      pending.delete(handle as () => void);
    },
    runAll: () => {
      for (const callback of [...pending]) {
        pending.delete(callback);
        callback();
      }
    },
  };
}

function testDatabase(path: string): SqliteDatabase {
  return new Database(path) as unknown as SqliteDatabase;
}

function thread(id: string, now: number): Thread {
  return {
    id,
    sessionId: uuidV7(now),
    parentThreadId: null,
    forkedFromId: null,
    agentNickname: null,
    agentRole: null,
    name: null,
    preview: '',
    ephemeral: false,
    source: 'app',
    threadSource: 'user',
    modelProvider: 'openai',
    cwd: '/tmp/project',
    createdAt: now,
    updatedAt: now,
    status: { type: 'idle' },
    historyMode: 'paginated',
  };
}

const configuration: EffectiveThreadConfiguration = {
  profileName: 'default',
  developerInstructions: [],
  model: 'test-model',
  reasoningEffort: 'medium',
  tools: [],
  skills: [],
  plugins: [],
  mcpServers: [],
};

const turnExecution: Turn['execution'] = {
  modelProvider: 'openai',
  model: 'openai/test-model',
  reasoningEffort: 'medium',
  diagnosticsRef: null,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: null,
  },
};
