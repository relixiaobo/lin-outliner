import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { EffectiveThreadConfiguration } from '../../src/core/agent/configuration';
import type { AgentCoreNotification, Thread, ThreadItem, Turn } from '../../src/core/agent/protocol';
import { GoalStore } from '../../src/main/agent/extensions/goal/GoalStore';
import { RolloutStore } from '../../src/main/agent/persistence/RolloutStore';
import { ThreadHistoryProjectionStore } from '../../src/main/agent/persistence/ThreadHistoryProjectionStore';
import { ThreadMetadataStore } from '../../src/main/agent/persistence/ThreadMetadataStore';
import { uuidV7 } from '../../src/main/agent/uuid';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-agent-core-'));
  roots.push(root);
  return root;
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
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: null,
  },
};

function testDatabase(path: string): SqliteDatabase {
  return new Database(path) as unknown as SqliteDatabase;
}

function thread(id: string, updatedAt: number, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    sessionId: overrides.sessionId ?? uuidV7(updatedAt),
    parentThreadId: null,
    forkedFromId: null,
    agentNickname: null,
    agentRole: null,
    name: `Thread ${updatedAt}`,
    preview: '',
    ephemeral: false,
    source: 'app',
    threadSource: 'user',
    modelProvider: 'openai',
    cwd: '/tmp/project',
    createdAt: updatedAt,
    updatedAt,
    status: { type: 'idle' },
    historyMode: 'paginated',
    ...overrides,
  };
}

describe('Agent Core persistence', () => {
  test('generates canonical, ordered UUIDv7 identities', () => {
    const ids = Array.from({ length: 100 }, () => uuidV7(1_720_000_000_000));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  test('stores catalog metadata, pagination, spawn edges, and input idempotency', async () => {
    const root = await tempRoot();
    const statePath = join(root, 'state.sqlite');
    const store = new ThreadMetadataStore(statePath, testDatabase(statePath));
    const ids = [uuidV7(100), uuidV7(200), uuidV7(300)];
    store.create({
      thread: thread(ids[0]!, 100),
      archived: false,
      configuration,
      toolCeiling: null,
      modelOverride: null,
      reasoningEffortOverride: null,
    });
    store.create({
      thread: thread(ids[1]!, 200),
      archived: false,
      configuration,
      toolCeiling: null,
      modelOverride: null,
      reasoningEffortOverride: null,
    });
    store.create({
      thread: thread(ids[2]!, 300, { threadSource: 'memory_consolidation' }),
      archived: false,
      configuration,
      toolCeiling: null,
      modelOverride: null,
      reasoningEffortOverride: null,
    });

    const first = store.list({ limit: 2 });
    expect(first.data.map((entry) => entry.id)).toEqual([ids[2], ids[1]]);
    expect(first.nextCursor).not.toBeNull();
    expect(store.list({ limit: 2, cursor: first.nextCursor }).data.map((entry) => entry.id)).toEqual([ids[0]]);
    expect(store.list({ threadSources: ['user'] }).data.map((entry) => entry.id)).toEqual([ids[1], ids[0]]);

    const childId = uuidV7(400);
    const firstSessionId = store.require(ids[0]!).thread.sessionId;
    store.createChild({
      thread: thread(childId, 400, {
        sessionId: firstSessionId,
        parentThreadId: ids[0]!,
        threadSource: 'subagent',
        agentRole: 'worker',
      }),
      archived: false,
      configuration,
      toolCeiling: ['node_read'],
      modelOverride: 'worker-model',
      reasoningEffortOverride: 'high',
    }, {
      sessionId: firstSessionId,
      parentThreadId: ids[0]!,
      childThreadId: childId,
      taskPath: '/root/worker',
      createdAt: 400,
    });
    expect(store.childEdges(ids[0]!)).toEqual([{
      sessionId: firstSessionId,
      parentThreadId: ids[0],
      childThreadId: childId,
      taskPath: '/root/worker',
      createdAt: 400,
    }]);
    expect(store.require(childId).toolCeiling).toEqual(['node_read']);
    expect(store.require(childId).modelOverride).toBe('worker-model');
    expect(store.require(childId).reasoningEffortOverride).toBe('high');

    const secondSessionId = store.require(ids[1]!).thread.sessionId;
    const secondChildId = uuidV7(450);
    store.createChild({
      thread: thread(secondChildId, 450, {
        sessionId: secondSessionId,
        parentThreadId: ids[1]!,
        threadSource: 'subagent',
        agentRole: 'worker',
      }),
      archived: false,
      configuration,
      toolCeiling: null,
      modelOverride: null,
      reasoningEffortOverride: null,
    }, {
      sessionId: secondSessionId,
      parentThreadId: ids[1]!,
      childThreadId: secondChildId,
      taskPath: '/root/worker',
      createdAt: 450,
    });
    expect(store.spawnEdgeForPath(firstSessionId, '/root/worker')?.childThreadId).toBe(childId);
    expect(store.spawnEdgeForPath(secondSessionId, '/root/worker')?.childThreadId).toBe(secondChildId);

    const firstBinding = store.bindClientInput({
      threadId: ids[0]!,
      clientId: 'submit-1',
      turnId: uuidV7(500),
      itemId: 'item-1',
      createdAt: 500,
    });
    const retry = store.bindClientInput({
      threadId: ids[0]!,
      clientId: 'submit-1',
      turnId: uuidV7(600),
      itemId: 'item-2',
      createdAt: 600,
    });
    expect(retry).toEqual(firstBinding);
    store.close();
  });

  test('repairs a torn rollout tail and preserves strict append ordinals', async () => {
    const root = await tempRoot();
    const store = new RolloutStore(join(root, 'rollouts'));
    const threadId = uuidV7(1000);
    const notifications = lifecycle(threadId);
    await Promise.all(notifications.slice(0, 2).map((notification) => store.append(threadId, notification)));
    expect((await store.read(threadId)).map((entry) => entry.ordinal)).toEqual([0, 1]);

    await appendFile(store.pathFor(threadId), '{"torn":', 'utf8');
    expect((await store.read(threadId)).map((entry) => entry.ordinal)).toEqual([0, 1]);
    await store.append(threadId, notifications[2]!);
    expect((await store.read(threadId)).map((entry) => entry.ordinal)).toEqual([0, 1, 2]);
  });

  test('rebuilds paginated Turn and Item projections exactly from rollout JSONL', async () => {
    const root = await tempRoot();
    const rollout = new RolloutStore(join(root, 'rollouts'));
    const threadId = uuidV7(2000);
    for (const notification of lifecycle(threadId)) await rollout.append(threadId, notification);
    const entries = await rollout.read(threadId);

    const incrementalPath = join(root, 'thread_history.sqlite');
    const incremental = new ThreadHistoryProjectionStore(incrementalPath, testDatabase(incrementalPath));
    incremental.applyMany(entries);
    const incrementalTurns = incremental.listTurns({ threadId, itemsView: 'full' });
    const incrementalItems = incremental.listItems({ threadId, limit: 1 });
    expect(incrementalTurns.data).toHaveLength(1);
    expect(incrementalTurns.data[0]?.status).toBe('completed');
    expect(incrementalTurns.data[0]?.items.map((item) => item.type)).toEqual(['userMessage', 'agentMessage']);
    expect(incrementalItems.nextCursor).not.toBeNull();
    const secondItemPage = incremental.listItems({
      threadId,
      limit: 1,
      cursor: incrementalItems.nextCursor,
    });
    expect(secondItemPage.data[0]?.item).toMatchObject({ type: 'agentMessage', text: 'Done' });

    const rebuiltPath = join(root, 'thread_history_rebuilt.sqlite');
    const rebuilt = new ThreadHistoryProjectionStore(rebuiltPath, testDatabase(rebuiltPath));
    rebuilt.rebuildThread(threadId, entries);
    expect(rebuilt.listTurns({ threadId, itemsView: 'full' })).toEqual(incrementalTurns);
    expect(rebuilt.listItems({ threadId })).toEqual(incremental.listItems({ threadId }));
    expect(rebuilt.watermark(threadId)).toEqual(incremental.watermark(threadId));
    incremental.close();
    rebuilt.close();
  });

  test('replays an interrupted Turn with a completed partial stream exactly', async () => {
    const root = await tempRoot();
    const rollout = new RolloutStore(join(root, 'interrupted-rollouts'));
    const threadId = uuidV7(2_250);
    for (const notification of interruptedLifecycle(threadId, true)) {
      await rollout.append(threadId, notification);
    }
    const entries = await rollout.read(threadId);
    const incremental = new ThreadHistoryProjectionStore(
      join(root, 'interrupted-history.sqlite'),
      testDatabase(join(root, 'interrupted-history.sqlite')),
    );
    incremental.applyMany(entries);

    const projected = incremental.listTurns({ threadId, itemsView: 'full' });
    expect(projected.data[0]).toMatchObject({
      status: 'interrupted',
      error: { code: 'host_restart' },
    });
    expect(projected.data[0]?.items.at(-1)).toMatchObject({
      type: 'agentMessage',
      text: 'Partial output',
    });
    expect(incremental.unfinishedItems(threadId, projected.data[0]!.id)).toEqual([]);

    const rebuilt = new ThreadHistoryProjectionStore(
      join(root, 'interrupted-history-rebuilt.sqlite'),
      testDatabase(join(root, 'interrupted-history-rebuilt.sqlite')),
    );
    rebuilt.rebuildThread(threadId, entries);
    expect(rebuilt.listTurns({ threadId, itemsView: 'full' })).toEqual(projected);
    expect(rebuilt.listItems({ threadId })).toEqual(incremental.listItems({ threadId }));
    incremental.close();
    rebuilt.close();
  });

  test('rejects Item and Turn mutation after terminal lifecycle facts', async () => {
    const root = await tempRoot();
    const threadId = uuidV7(2_500);
    const notifications = lifecycle(threadId);
    const rollout = new RolloutStore(join(root, 'immutable-rollouts'));
    for (const notification of notifications) await rollout.append(threadId, notification);
    const entries = await rollout.read(threadId);
    const beforeTurnCompletion = entries.slice(0, -1);
    const store = new ThreadHistoryProjectionStore(
      join(root, 'immutable-history.sqlite'),
      testDatabase(join(root, 'immutable-history.sqlite')),
    );
    store.applyMany(beforeTurnCompletion);

    const agentCompletion = notifications.find((notification) => (
      notification.type === 'item/completed' && notification.item.type === 'agentMessage'
    ));
    if (!agentCompletion || agentCompletion.type !== 'item/completed') throw new Error('Missing agent completion fixture');
    expect(() => store.apply({
      ordinal: beforeTurnCompletion.length,
      byteOffset: 0,
      byteLength: 1,
      notification: {
        type: 'item/delta',
        threadId,
        turnId: agentCompletion.turnId,
        itemId: agentCompletion.itemId,
        delta: { type: 'agentMessageText', delta: ' late mutation' },
      },
    })).toThrow('Completed Thread Item is immutable');

    const terminal = notifications.at(-1)!;
    if (terminal.type !== 'turn/completed') throw new Error('Missing terminal Turn fixture');
    store.apply({
      ordinal: beforeTurnCompletion.length,
      byteOffset: 0,
      byteLength: 1,
      notification: terminal,
    });
    expect(() => store.apply({
      ordinal: entries.length,
      byteOffset: 1,
      byteLength: 1,
      notification: terminal,
    })).toThrow('Terminal Turn is immutable');
    store.close();
  });

  test('keeps Goal state authoritative with generations, accounting, and stale-deferral rejection', async () => {
    const root = await tempRoot();
    const goalsPath = join(root, 'goals.sqlite');
    const goals = new GoalStore(goalsPath, testDatabase(goalsPath));
    const threadId = uuidV7(3000);
    const first = goals.create(threadId, 'Ship Agent Core', 100, 10);
    expect(first.goal.status).toBe('active');
    expect(() => goals.create(threadId, 'Replace active work', null, 11)).toThrow('unfinished Goal');
    expect(goals.deferContinuation(threadId, first.generation, 'Thread is active', 12).generation).toBe(1);
    expect(goals.addUsage(threadId, 100, 5, 13).goal.status).toBe('budgetLimited');
    expect(goals.readDeferral(threadId)).toBeNull();
    goals.updateFromAgent(threadId, 'complete', 14);

    const replacement = goals.create(threadId, 'Verify Agent Core', null, 15);
    expect(replacement.generation).toBe(2);
    expect(replacement.goal.tokensUsed).toBe(0);
    expect(() => goals.deferContinuation(threadId, first.generation, 'stale', 16)).toThrow('stale');
    goals.close();
  });
});

function lifecycle(threadId: string): AgentCoreNotification[] {
  const turnId = uuidV7(4_000);
  const userItem: ThreadItem = {
    type: 'userMessage',
    id: 'item-user',
    provenance: {
      originThreadId: threadId,
      originTurnId: turnId,
      originItemId: 'item-user',
    },
    clientId: 'submit-1',
    content: [{ type: 'text', text: 'Start' }],
  };
  const startedAgentItem: ThreadItem = {
    type: 'agentMessage',
    id: 'item-agent',
    provenance: {
      originThreadId: threadId,
      originTurnId: turnId,
      originItemId: 'item-agent',
    },
    text: '',
    phase: 'final_answer',
    memoryCitation: null,
  };
  const completedAgentItem: ThreadItem = { ...startedAgentItem, text: 'Done' };
  const startedTurn: Turn = {
    id: turnId,
    items: [userItem],
    itemsView: 'full',
    provenance: {
      originThreadId: threadId,
      originTurnId: turnId,
      trigger: { kind: 'user' },
    },
    status: 'inProgress',
    error: null,
    execution: turnExecution,
    startedAt: 4_000,
    completedAt: null,
    durationMs: null,
  };
  const completedTurn: Turn = {
    ...startedTurn,
    items: [userItem, completedAgentItem],
    status: 'completed',
    completedAt: 4_100,
    durationMs: 100,
  };
  return [
    { type: 'turn/started', threadId, turnId, turn: startedTurn },
    {
      type: 'item/completed',
      threadId,
      turnId,
      itemId: userItem.id,
      item: userItem,
      completedAt: 4_000,
    },
    {
      type: 'item/started',
      threadId,
      turnId,
      itemId: startedAgentItem.id,
      item: startedAgentItem,
      startedAt: 4_010,
    },
    {
      type: 'item/delta',
      threadId,
      turnId,
      itemId: startedAgentItem.id,
      delta: { type: 'agentMessageText', delta: 'Do' },
    },
    {
      type: 'item/completed',
      threadId,
      turnId,
      itemId: completedAgentItem.id,
      item: completedAgentItem,
      completedAt: 4_090,
    },
    { type: 'turn/completed', threadId, turnId, turn: completedTurn },
  ];
}

function interruptedLifecycle(
  threadId: string,
  includeTerminalFacts: boolean,
): AgentCoreNotification[] {
  const turnId = uuidV7(4_500);
  const userItem: ThreadItem = {
    type: 'userMessage',
    id: 'item-interrupted-user',
    provenance: {
      originThreadId: threadId,
      originTurnId: turnId,
      originItemId: 'item-interrupted-user',
    },
    clientId: null,
    content: [{ type: 'text', text: 'Start streaming' }],
  };
  const startedAgentItem: ThreadItem = {
    type: 'agentMessage',
    id: 'item-interrupted-agent',
    provenance: {
      originThreadId: threadId,
      originTurnId: turnId,
      originItemId: 'item-interrupted-agent',
    },
    text: '',
    phase: 'final_answer',
    memoryCitation: null,
  };
  const partialAgentItem: ThreadItem = { ...startedAgentItem, text: 'Partial output' };
  const startedTurn: Turn = {
    id: turnId,
    items: [userItem],
    itemsView: 'full',
    provenance: {
      originThreadId: threadId,
      originTurnId: turnId,
      trigger: { kind: 'user' },
    },
    status: 'inProgress',
    error: null,
    execution: turnExecution,
    startedAt: 4_500,
    completedAt: null,
    durationMs: null,
  };
  const prefix: AgentCoreNotification[] = [
    { type: 'turn/started', threadId, turnId, turn: startedTurn },
    {
      type: 'item/completed',
      threadId,
      turnId,
      itemId: userItem.id,
      item: userItem,
      completedAt: 4_500,
    },
    {
      type: 'item/started',
      threadId,
      turnId,
      itemId: startedAgentItem.id,
      item: startedAgentItem,
      startedAt: 4_510,
    },
    {
      type: 'item/delta',
      threadId,
      turnId,
      itemId: startedAgentItem.id,
      delta: { type: 'agentMessageText', delta: 'Partial output' },
    },
  ];
  if (!includeTerminalFacts) return prefix;
  return [
    ...prefix,
    {
      type: 'item/completed',
      threadId,
      turnId,
      itemId: partialAgentItem.id,
      item: partialAgentItem,
      completedAt: 4_550,
    },
    {
      type: 'turn/completed',
      threadId,
      turnId,
      turn: {
        ...startedTurn,
        items: [userItem, partialAgentItem],
        status: 'interrupted',
        error: { message: 'Turn interrupted by host restart', code: 'host_restart' },
        completedAt: 4_550,
        durationMs: 50,
      },
    },
  ];
}
