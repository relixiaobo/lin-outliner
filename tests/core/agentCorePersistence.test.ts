import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { EffectiveThreadConfiguration } from '../../src/core/agent/configuration';
import { createThreadHistoryRollbackContext } from '../../src/core/agent/extensions';
import type { AgentCoreNotification, Thread, ThreadItem, Turn } from '../../src/core/agent/protocol';
import { GoalStore } from '../../src/main/agent/extensions/goal/GoalStore';
import { RolloutStore } from '../../src/main/agent/persistence/RolloutStore';
import { SubagentRequestLedger, requestPoolIdForTurn } from '../../src/main/agent/persistence/SubagentRequestLedger';
import { ThreadHistoryProjectionStore } from '../../src/main/agent/persistence/ThreadHistoryProjectionStore';
import { ThreadMetadataStore } from '../../src/main/agent/persistence/ThreadMetadataStore';
import { uuidV7 } from '../../src/main/agent/uuid';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';
import { replayableModelCall } from '../fixtures/agentToolCallHistory';

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
      nameOrigin: 'manual',
      archived: false,
      configuration,
      toolCeiling: null,
      modelOverride: null,
      reasoningEffortOverride: null,
    });
    store.create({
      thread: thread(ids[1]!, 200),
      nameOrigin: 'manual',
      archived: false,
      configuration,
      toolCeiling: null,
      modelOverride: null,
      reasoningEffortOverride: null,
    });
    store.create({
      thread: thread(ids[2]!, 300, { threadSource: 'memory_consolidation' }),
      nameOrigin: 'manual',
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
      nameOrigin: 'manual',
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
      nameOrigin: 'manual',
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

  test('finalizes a Turn whose Items were persisted before the protocol grew a field', async () => {
    // A crashed Turn from an older build is finalized after upgrade. The Item
    // did not change, so the terminal-mutation invariant must not fire — it
    // compares canonical decoded Items, not stored bytes.
    const root = await tempRoot();
    const threadId = uuidV7(2_600);
    const path = join(root, 'thread_history.sqlite');
    const rollout = new RolloutStore(join(root, 'rollouts'));
    for (const notification of commandLifecycle(threadId)) await rollout.append(threadId, notification);
    const entries = await rollout.read(threadId);
    const store = new ThreadHistoryProjectionStore(path, testDatabase(path));
    store.applyMany(entries.slice(0, -1));
    store.close();

    // Rewrite the stored row exactly as an older build would have written it.
    const db = testDatabase(path);
    const row = db.prepare(
      'SELECT item_id, item_json FROM thread_items WHERE thread_id = ?',
    ).get(threadId) as { item_id: string; item_json: string };
    const legacy = JSON.parse(row.item_json) as Record<string, unknown>;
    expect(legacy.description).toBeNull();
    delete legacy.description;
    db.prepare('UPDATE thread_items SET item_json = ? WHERE thread_id = ? AND item_id = ?')
      .run(JSON.stringify(legacy), threadId, row.item_id);
    db.close();

    const reopened = new ThreadHistoryProjectionStore(path, testDatabase(path));
    expect(() => reopened.applyMany([entries.at(-1)!])).not.toThrow();
    const turns = reopened.listTurns({ threadId, itemsView: 'full' });
    expect(turns.data[0]?.status).toBe('completed');
    reopened.close();
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
    expect(incrementalTurns.data[0]?.items.map((item) => item.type)).toEqual([
      'userMessage',
      'userMessage',
      'agentMessage',
    ]);
    expect(incrementalItems.nextCursor).not.toBeNull();
    const secondItemPage = incremental.listItems({
      threadId,
      limit: 1,
      cursor: incrementalItems.nextCursor,
    });
    expect(secondItemPage.data[0]?.item).toMatchObject({
      type: 'userMessage',
      content: [{ type: 'text', text: 'Steer' }],
    });
    expect(secondItemPage.nextCursor).not.toBeNull();
    const thirdItemPage = incremental.listItems({
      threadId,
      limit: 1,
      cursor: secondItemPage.nextCursor,
    });
    expect(thirdItemPage.data[0]?.item).toMatchObject({ type: 'agentMessage', text: 'Done' });
    expect(thirdItemPage.nextCursor).toBeNull();

    const rebuiltPath = join(root, 'thread_history_rebuilt.sqlite');
    const rebuilt = new ThreadHistoryProjectionStore(rebuiltPath, testDatabase(rebuiltPath));
    rebuilt.rebuildThread(threadId, entries);
    expect(rebuilt.listTurns({ threadId, itemsView: 'full' })).toEqual(incrementalTurns);
    expect(rebuilt.listItems({ threadId })).toEqual(incremental.listItems({ threadId }));
    expect(rebuilt.watermark(threadId)).toEqual(incremental.watermark(threadId));
    incremental.close();
    rebuilt.close();
  });

  test('replays rollback markers without deleting immutable rollout facts', async () => {
    const root = await tempRoot();
    const rollout = new RolloutStore(join(root, 'rollback-rollouts'));
    const threadId = uuidV7(2_100);
    const firstLifecycle = lifecycle(threadId, 4_100);
    for (const notification of firstLifecycle) await rollout.append(threadId, notification);

    const incremental = new ThreadHistoryProjectionStore(
      join(root, 'rollback-history.sqlite'),
      testDatabase(join(root, 'rollback-history.sqlite')),
    );
    incremental.applyMany(await rollout.read(threadId));
    const firstTurnId = incremental.listTurns({ threadId }).data[0]!.id;
    const beforeFirstRollback = incremental.projectionVersion(threadId);
    const firstMarker = await rollout.appendHistoryRollback(createThreadHistoryRollbackContext(
      uuidV7(4_200),
      threadId,
      [firstTurnId],
      beforeFirstRollback,
      beforeFirstRollback + 1,
    ));
    incremental.apply(firstMarker);
    expect(incremental.listTurns({ threadId }).data).toEqual([]);

    for (const notification of lifecycle(threadId, 4_300)) {
      incremental.apply(await rollout.append(threadId, notification));
    }
    const replacementTurnId = incremental.listTurns({ threadId }).data[0]!.id;
    expect(replacementTurnId).not.toBe(firstTurnId);
    const beforeSecondRollback = incremental.projectionVersion(threadId);
    incremental.apply(await rollout.appendHistoryRollback(createThreadHistoryRollbackContext(
      uuidV7(4_400),
      threadId,
      [replacementTurnId],
      beforeSecondRollback,
      beforeSecondRollback + 1,
    )));

    const entries = await rollout.read(threadId);
    expect(entries.some((entry) => (
      entry.event.type === 'turn/completed' && entry.event.turnId === firstTurnId
    ))).toBe(true);
    expect(entries.filter((entry) => entry.event.type === 'history/rollback')).toHaveLength(2);
    expect(incremental.rollbackMarkers(threadId).map((marker) => marker.omittedTurnIds)).toEqual([
      [firstTurnId],
      [replacementTurnId],
    ]);

    const rebuilt = new ThreadHistoryProjectionStore(
      join(root, 'rollback-history-rebuilt.sqlite'),
      testDatabase(join(root, 'rollback-history-rebuilt.sqlite')),
    );
    rebuilt.rebuildThread(threadId, entries);
    expect(rebuilt.listTurns({ threadId })).toEqual(incremental.listTurns({ threadId }));
    expect(rebuilt.listItems({ threadId })).toEqual(incremental.listItems({ threadId }));
    expect(rebuilt.rollbackMarkers(threadId)).toEqual(incremental.rollbackMarkers(threadId));
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
      event: {
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
      event: terminal,
    });
    expect(() => store.apply({
      ordinal: entries.length,
      byteOffset: 1,
      byteLength: 1,
      event: terminal,
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

  test('persists one host-owned Subagent pool with independent member contributions', async () => {
    const root = await tempRoot();
    const goalsPath = join(root, 'goals.sqlite');
    const goalsDatabase = testDatabase(goalsPath);
    const goals = new GoalStore(goalsPath, goalsDatabase);
    const budgets = new SubagentRequestLedger(goalsDatabase);
    const persistentHolderId = uuidV7(3100);
    const persistentOriginTurnId = uuidV7(3150);
    const persistentPoolId = requestPoolIdForTurn(persistentOriginTurnId);
    const persistentChildId = uuidV7(3200);
    const persistentSiblingId = uuidV7(3300);
    const ephemeralHolderId = uuidV7(3400);
    const ephemeralOriginTurnId = uuidV7(3450);
    const ephemeralPoolId = requestPoolIdForTurn(ephemeralOriginTurnId);
    const ephemeralChildId = uuidV7(3500);

    goals.create(persistentChildId, 'Child-owned Goal', null, 10);
    budgets.createPool({
      poolId: persistentPoolId,
      scope: 'turn',
      originThreadId: persistentHolderId,
      originTurnId: persistentOriginTurnId,
      tokenBudget: 100,
    }, false);
    budgets.createMember({
      threadId: persistentChildId,
      poolId: persistentPoolId,
      originTurnId: persistentOriginTurnId,
      tokenCap: 60,
    }, false);
    budgets.createMember({
      threadId: persistentSiblingId,
      poolId: persistentPoolId,
      originTurnId: persistentOriginTurnId,
      tokenCap: null,
    }, false);
    budgets.addUsage(persistentChildId, persistentPoolId, 40);
    budgets.addUsage(persistentSiblingId, persistentPoolId, 10);
    budgets.recordSpawnCount(persistentHolderId, 2, false);
    budgets.createPool({
      poolId: ephemeralPoolId,
      scope: 'turn',
      originThreadId: ephemeralHolderId,
      originTurnId: ephemeralOriginTurnId,
      tokenBudget: 50,
    }, true);
    budgets.createMember({
      threadId: ephemeralChildId,
      poolId: ephemeralPoolId,
      originTurnId: ephemeralOriginTurnId,
      tokenCap: null,
    }, true);
    budgets.addUsage(ephemeralChildId, ephemeralPoolId, 10);
    budgets.recordSpawnCount(ephemeralHolderId, 1, true);
    expect(goals.read(persistentChildId)?.goal.objective).toBe('Child-owned Goal');
    expect(budgets.readPool(persistentPoolId)).toMatchObject({ tokenBudget: 100, tokensUsed: 50 });
    expect(budgets.readMember(persistentChildId)).toMatchObject({ tokenCap: 60, tokensUsed: 40 });
    expect(budgets.readMember(persistentSiblingId)).toMatchObject({ tokenCap: null, tokensUsed: 10 });
    expect(budgets.readSpawnCount(persistentHolderId)).toBe(2);
    expect(budgets.readPool(ephemeralPoolId)).toMatchObject({ tokenBudget: 50, tokensUsed: 10 });
    expect(budgets.readSpawnCount(ephemeralHolderId)).toBe(1);
    goals.close();

    const reopenedDatabase = testDatabase(goalsPath);
    const reopened = new SubagentRequestLedger(reopenedDatabase);
    expect(reopened.readPool(persistentPoolId)).toMatchObject({ tokenBudget: 100, tokensUsed: 50 });
    expect(reopened.readMember(persistentChildId)).toMatchObject({ tokenCap: 60, tokensUsed: 40 });
    expect(reopened.readSpawnCount(persistentHolderId)).toBe(2);
    expect(reopened.readPool(ephemeralPoolId)).toBeNull();
    expect(reopened.readSpawnCount(ephemeralHolderId)).toBe(0);
    expect(reopened.clearThread(persistentChildId)).toBe(true);
    expect(reopened.readPool(persistentPoolId)).toMatchObject({ tokenBudget: 100, tokensUsed: 50 });
    expect(reopened.readSpawnCount(persistentHolderId)).toBe(2);
    // Deleting the Thread that originated the pool takes the pool and every
    // remaining member with it.
    expect(reopened.clearThread(persistentHolderId)).toBe(true);
    expect(reopened.readPool(persistentPoolId)).toBeNull();
    expect(reopened.readMember(persistentSiblingId)).toBeNull();
    expect(reopened.readSpawnCount(persistentHolderId)).toBe(0);
    reopenedDatabase.close();
  });
});

function lifecycle(threadId: string, seed = 4_000): AgentCoreNotification[] {
  const turnId = uuidV7(seed);
  const userItem: ThreadItem = {
    type: 'userMessage',
    id: `item-user-${seed}`,
    provenance: {
      originThreadId: threadId,
      originTurnId: turnId,
      originItemId: `item-user-${seed}`,
    },
    clientId: 'submit-1',
    acceptedAt: seed,
    content: [{ type: 'text', text: 'Start' }],
  };
  const startedAgentItem: ThreadItem = {
    type: 'agentMessage',
    id: `item-agent-${seed}`,
    provenance: {
      originThreadId: threadId,
      originTurnId: turnId,
      originItemId: `item-agent-${seed}`,
    },
    text: '',
    phase: 'final_answer',
    memoryCitation: null,
  };
  const steeredUserItem: ThreadItem = {
    type: 'userMessage',
    id: `item-steer-${seed}`,
    provenance: {
      originThreadId: threadId,
      originTurnId: turnId,
      originItemId: `item-steer-${seed}`,
    },
    clientId: null,
    acceptedAt: 4_005,
    content: [{ type: 'text', text: 'Steer' }],
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
    items: [userItem, steeredUserItem, completedAgentItem],
    status: 'completed',
    completedAt: 4_100,
    durationMs: 100,
  };
  return [
    { type: 'turn/started', threadId, turnId, turn: startedTurn },
    {
      type: 'items/completed',
      threadId,
      turnId,
      items: [steeredUserItem],
      completedAt: 4_005,
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

function commandLifecycle(threadId: string): AgentCoreNotification[] {
  const turnId = uuidV7(2_601);
  const running: ThreadItem = {
    type: 'commandExecution',
    id: 'item-command-2601',
    provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: 'item-command-2601' },
    command: 'bun run typecheck',
    description: null,
    cwd: '/tmp/project',
    processId: null,
    status: 'inProgress',
    outputRef: null,
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
    modelCall: replayableModelCall('bash', { command: 'bun run typecheck' }),
  };
  const item: ThreadItem = { ...running, status: 'completed', exitCode: 0, durationMs: 10 };
  const startedTurn: Turn = {
    id: turnId,
    items: [],
    itemsView: 'full',
    provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
    status: 'inProgress',
    error: null,
    execution: turnExecution,
    startedAt: 2_600,
    completedAt: null,
    durationMs: null,
  };
  return [
    { type: 'turn/started', threadId, turnId, turn: startedTurn },
    { type: 'item/started', threadId, turnId, itemId: running.id, item: running, startedAt: 2_601 },
    { type: 'item/completed', threadId, turnId, itemId: item.id, item, completedAt: 2_602 },
    {
      type: 'turn/completed',
      threadId,
      turnId,
      turn: { ...startedTurn, items: [item], status: 'completed', completedAt: 2_603, durationMs: 3 },
    },
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
    acceptedAt: 4_500,
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
