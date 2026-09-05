import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { EffectiveThreadConfiguration } from '../../src/core/agent/configuration';
import { createThreadHistoryRollbackContext } from '../../src/core/agent/extensions';
import type { AgentCoreNotification, Thread, ThreadItem, Turn } from '../../src/core/agent/protocol';
import { GoalStore } from '../../src/main/agent/extensions/goal/GoalStore';
import { RolloutStore } from '../../src/main/agent/persistence/RolloutStore';
import { ThreadHistoryProjectionStore } from '../../src/main/agent/persistence/ThreadHistoryProjectionStore';
import { ThreadMetadataStore } from '../../src/main/agent/persistence/ThreadMetadataStore';
import { uuidV7 } from '../../src/main/agent/uuid';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';
import { replayableModelCall } from '../fixtures/agentToolCallHistory';

const roots: string[] = [];
const rolloutStores: RolloutStore[] = [];

afterEach(async () => {
  await Promise.allSettled(rolloutStores.splice(0).map((store) => store.flush()));
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
  preloadedSkills: [],
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

function trackedRolloutStore(
  path: string,
  options?: ConstructorParameters<typeof RolloutStore>[1],
): RolloutStore {
  const store = new RolloutStore(path, options);
  rolloutStores.push(store);
  return store;
}

function thread(id: string, updatedAt: number, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    sessionId: overrides.sessionId ?? uuidV7(updatedAt),
    parentThreadId: null,
    forkedFromId: null,
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
    });
    store.create({
      thread: thread(ids[1]!, 200),
      nameOrigin: 'manual',
      archived: false,
      configuration,
      toolCeiling: null,
    });
    store.create({
      thread: thread(ids[2]!, 300, { threadSource: 'memory_consolidation' }),
      nameOrigin: 'manual',
      archived: false,
      configuration,
      toolCeiling: null,
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
        threadSource: 'delegation',
      }),
      nameOrigin: 'manual',
      archived: false,
      configuration,
      toolCeiling: ['file_read'],
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
    expect(store.require(childId).toolCeiling).toEqual(['file_read']);

    const secondSessionId = store.require(ids[1]!).thread.sessionId;
    const secondChildId = uuidV7(450);
    store.createChild({
      thread: thread(secondChildId, 450, {
        sessionId: secondSessionId,
        parentThreadId: ids[1]!,
        threadSource: 'delegation',
      }),
      nameOrigin: 'manual',
      archived: false,
      configuration,
      toolCeiling: null,
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

  test('invalidates decoded records through every Thread catalog record mutator', async () => {
    const root = await tempRoot();
    const statePath = join(root, 'state.sqlite');
    const store = new ThreadMetadataStore(statePath, testDatabase(statePath));
    const threadId = uuidV7(700);
    store.create({
      thread: thread(threadId, 700, { name: null }),
      nameOrigin: 'none',
      archived: false,
      configuration,
      toolCeiling: null,
    });

    let cached = store.require(threadId);
    const mutate = (name: string, operation: () => void) => {
      operation();
      const refreshed = store.require(threadId);
      expect(refreshed, name).not.toBe(cached);
      cached = refreshed;
    };

    mutate('setAutomaticNameIfEligible', () => {
      expect(store.setAutomaticNameIfEligible(threadId, 'Automatic')).toBe(true);
    });
    expect(cached).toMatchObject({ nameOrigin: 'automatic', thread: { name: 'Automatic' } });
    mutate('clearAutomaticName', () => {
      expect(store.clearAutomaticName(threadId)).toBe(true);
    });
    expect(cached).toMatchObject({ nameOrigin: 'none', thread: { name: null } });
    mutate('setManualName', () => store.setManualName(threadId, 'Manual'));
    expect(cached).toMatchObject({ nameOrigin: 'manual', thread: { name: 'Manual' } });
    mutate('setPreview', () => store.setPreview(threadId, 'Preview', 710));
    expect(cached.thread).toMatchObject({ preview: 'Preview', updatedAt: 710 });
    mutate('setStatus', () => store.setStatus(threadId, { type: 'active', activeFlags: [] }, 720));
    expect(cached.thread).toMatchObject({ status: { type: 'active', activeFlags: [] }, updatedAt: 720 });
    mutate('setCwd', () => store.setCwd(threadId, '/tmp/next', 730));
    expect(cached.thread).toMatchObject({ cwd: '/tmp/next', updatedAt: 730 });
    const nextConfiguration = { ...configuration, model: 'next-model' };
    mutate('setConfiguration', () => store.setConfiguration(threadId, nextConfiguration));
    expect(cached.configuration.model).toBe('next-model');
    const rootConfiguration = { ...configuration, reasoningEffort: 'high' as const };
    mutate('setRootConfiguration', () => {
      store.setRootConfiguration(threadId, 'anthropic', rootConfiguration, 740);
    });
    expect(cached).toMatchObject({
      configuration: { reasoningEffort: 'high' },
      thread: { modelProvider: 'anthropic', updatedAt: 740 },
    });
    mutate('setArchived', () => store.setArchived(threadId, true, 750));
    expect(cached.archived).toBe(true);

    const childId = uuidV7(760);
    store.createChild({
      thread: thread(childId, 760, {
        sessionId: cached.thread.sessionId,
        parentThreadId: threadId,
        threadSource: 'delegation',
      }),
      nameOrigin: 'none',
      archived: false,
      configuration,
      toolCeiling: null,
    }, {
      sessionId: cached.thread.sessionId,
      parentThreadId: threadId,
      childThreadId: childId,
      taskPath: '/root/cache-child',
      createdAt: 760,
    });
    store.require(childId);
    store.delete(threadId);
    expect(store.read(threadId)).toBeNull();
    expect(store.read(childId)).toBeNull();
    store.close();
  });

  test('reuses decoded records across catalog reads and bounds the LRU', () => {
    const store = new ThreadMetadataStore(':memory:', testDatabase(':memory:'));
    const threadId = uuidV7(800);
    store.create({
      thread: thread(threadId, 800),
      nameOrigin: 'none',
      archived: false,
      configuration,
      toolCeiling: null,
    });

    const cached = store.require(threadId);
    expect(store.readMany([threadId]).get(threadId)).toBe(cached);
    expect(store.list({ limit: 1 }).data[0]).toBe(cached.thread);

    for (let index = 0; index < 256; index += 1) {
      const nextId = uuidV7(801 + index);
      store.create({
        thread: thread(nextId, 801 + index),
        nameOrigin: 'none',
        archived: false,
        configuration,
        toolCeiling: null,
      });
      store.require(nextId);
    }
    expect(store.require(threadId)).not.toBe(cached);
    store.close();
  });

  test('repairs a torn rollout tail and preserves strict append ordinals', async () => {
    const root = await tempRoot();
    const store = trackedRolloutStore(join(root, 'rollouts'));
    const threadId = uuidV7(1000);
    const notifications = lifecycle(threadId);
    await Promise.all(notifications.slice(0, 2).map((notification) => store.append(threadId, notification)));
    expect((await store.read(threadId)).map((entry) => entry.ordinal)).toEqual([0, 1]);

    await appendFile(store.pathFor(threadId), '{"torn":', 'utf8');
    expect((await store.read(threadId)).map((entry) => entry.ordinal)).toEqual([0, 1]);
    await store.append(threadId, notifications[2]!);
    expect((await store.read(threadId)).map((entry) => entry.ordinal)).toEqual([0, 1, 2]);
  });

  test('rejects authorless rollout, restoration, rerun, and projection records', async () => {
    const root = await tempRoot();
    const threadId = uuidV7(1_050);
    const rollout = trackedRolloutStore(join(root, 'strict-author-rollouts'));
    const original = lifecycle(threadId, 5_000);
    const replacement = lifecycle(threadId, 5_100)[0];
    if (replacement?.type !== 'turn/started') throw new Error('Missing rerun replacement fixture');

    await expect(rollout.append(
      threadId,
      withoutUserMessageAuthors(original[0]!) as AgentCoreNotification,
    )).rejects.toThrow('item.author');

    const restoredRollout = trackedRolloutStore(join(root, 'strict-author-restored-rollouts'));
    await expect(restoredRollout.restoreMissing(threadId, [{
      event: withoutUserMessageAuthors(original[0]!) as AgentCoreNotification,
      recordedAt: 5_000,
    }])).rejects.toThrow('item.author');

    for (const notification of original) await rollout.append(threadId, notification);
    await rollout.appendHistoryRerun(createThreadHistoryRollbackContext(
      uuidV7(5_200),
      threadId,
      [original[0]!.turnId!],
      original.length,
      original.length + 1,
    ), replacement);
    await rollout.flush();

    const strictEntries = await rollout.read(threadId);
    const projectionPath = join(root, 'strict-author-history.sqlite');
    const projection = new ThreadHistoryProjectionStore(projectionPath, testDatabase(projectionPath));
    projection.rebuildThread(threadId, strictEntries);
    projection.close();

    const projectionDatabase = testDatabase(projectionPath);
    const rows = projectionDatabase.prepare(
      'SELECT item_id, item_json FROM thread_items WHERE thread_id = ? AND item_type = ?',
    ).all(threadId, 'userMessage') as Array<{ item_id: string; item_json: string }>;
    for (const row of rows) {
      projectionDatabase.prepare(
        'UPDATE thread_items SET item_json = ? WHERE thread_id = ? AND item_id = ?',
      ).run(
        JSON.stringify(withoutUserMessageAuthors(JSON.parse(row.item_json))),
        threadId,
        row.item_id,
      );
    }
    projectionDatabase.close();

    const reopenedProjection = new ThreadHistoryProjectionStore(
      projectionPath,
      testDatabase(projectionPath),
    );
    expect(() => reopenedProjection.listItems({ threadId })).toThrow('item.author');
    expect(() => reopenedProjection.rolloutSnapshot(threadId)).toThrow('item.author');
    reopenedProjection.close();

    const rolloutPath = rollout.pathFor(threadId);
    const authorlessLines = (await readFile(rolloutPath, 'utf8')).trimEnd().split('\n').map((line) => (
      JSON.stringify(withoutUserMessageAuthors(JSON.parse(line)))
    ));
    await writeFile(rolloutPath, `${authorlessLines.join('\n')}\n`, 'utf8');
    await expect(rollout.read(threadId)).rejects.toThrow('item.author');
  });

  test('group-commits streamed rollout writes and syncs lifecycle barriers', async () => {
    const root = await tempRoot();
    const scheduled = new Set<() => void>();
    let syncCount = 0;
    const store = trackedRolloutStore(join(root, 'grouped-rollouts'), {
      schedule: (callback) => {
        scheduled.add(callback);
        return callback;
      },
      cancelScheduled: (handle) => scheduled.delete(handle as () => void),
      onDidSync: () => { syncCount += 1; },
    });
    const threadId = uuidV7(1_100);
    const prefix = interruptedLifecycle(threadId, false);
    await store.append(threadId, prefix[0]!);
    await store.append(threadId, prefix[1]!);
    syncCount = 0;

    for (let index = 0; index < 8; index += 1) await store.append(threadId, prefix[2]!);
    expect(syncCount).toBe(0);
    expect(scheduled.size).toBe(1);
    const scheduledSync = scheduled.values().next().value!;
    scheduled.delete(scheduledSync);
    scheduledSync();
    await store.read(threadId);
    expect(syncCount).toBe(1);

    await store.append(threadId, prefix[2]!);
    const completion = interruptedLifecycle(threadId, true)[3]!;
    await store.append(threadId, completion);
    expect(syncCount).toBe(2);
    expect(scheduled.size).toBe(0);
  });

  test('syncs LRU evictions and flushes, but unlinks deleted rollouts without fsync', async () => {
    const root = await tempRoot();
    const scheduled = new Set<() => void>();
    const syncedThreadIds: string[] = [];
    const store = trackedRolloutStore(join(root, 'bounded-rollouts'), {
      openHandleLimit: 1,
      schedule: (callback) => {
        scheduled.add(callback);
        return callback;
      },
      cancelScheduled: (handle) => scheduled.delete(handle as () => void),
      onDidSync: (threadId) => syncedThreadIds.push(threadId),
    });
    const firstThreadId = uuidV7(1_200);
    const secondThreadId = uuidV7(1_300);
    const firstDelta = interruptedLifecycle(firstThreadId, false)[2]!;
    const secondDelta = interruptedLifecycle(secondThreadId, false)[2]!;

    await store.append(firstThreadId, firstDelta);
    await store.append(secondThreadId, secondDelta);
    expect(syncedThreadIds).toEqual([firstThreadId]);
    expect(scheduled.size).toBe(1);

    await store.append(firstThreadId, firstDelta);
    expect(syncedThreadIds).toEqual([firstThreadId, secondThreadId]);
    expect((await store.read(firstThreadId)).map((entry) => entry.ordinal)).toEqual([0, 1]);

    await store.delete(firstThreadId);
    expect(syncedThreadIds).toEqual([firstThreadId, secondThreadId]);
    expect(scheduled.size).toBe(0);
    expect(await store.read(firstThreadId)).toEqual([]);

    await store.append(secondThreadId, secondDelta);
    await store.flush();
    expect(syncedThreadIds).toEqual([firstThreadId, secondThreadId, secondThreadId]);
    expect(scheduled.size).toBe(0);
  });

  test('deletes a rollout even when closing its unlinked handle reports a failure', async () => {
    const root = await tempRoot();
    const backgroundErrors: Array<{ message: string; error: unknown }> = [];
    let syncCount = 0;
    let failClose = false;
    const store = trackedRolloutStore(join(root, 'delete-close-failure'), {
      syncFile: async (_threadId, handle) => {
        syncCount += 1;
        await handle.sync();
      },
      closeFile: async (_threadId, handle) => {
        await handle.close();
        if (failClose) throw new Error('simulated close failure');
      },
      onBackgroundError: (message, error) => backgroundErrors.push({ message, error }),
    });
    const threadId = uuidV7(1_350);
    await store.append(threadId, interruptedLifecycle(threadId, false)[2]!);
    failClose = true;

    await expect(store.delete(threadId)).resolves.toBeUndefined();

    expect(syncCount).toBe(0);
    expect(await store.read(threadId)).toEqual([]);
    expect(backgroundErrors.map(({ message }) => message)).toEqual([
      `[agent] failed to close deleted rollout for ${threadId}`,
    ]);
  });

  test('does not reject a successful append when LRU eviction fsync fails', async () => {
    const root = await tempRoot();
    const scheduled = new Set<() => void>();
    const backgroundErrors: Array<{ message: string; error: unknown }> = [];
    const firstThreadId = uuidV7(1_360);
    const secondThreadId = uuidV7(1_370);
    const store = trackedRolloutStore(join(root, 'lru-sync-failure'), {
      openHandleLimit: 1,
      schedule: (callback) => {
        scheduled.add(callback);
        return callback;
      },
      cancelScheduled: (handle) => scheduled.delete(handle as () => void),
      syncFile: async (threadId, handle) => {
        if (threadId === firstThreadId) throw new Error('simulated eviction fsync failure');
        await handle.sync();
      },
      onBackgroundError: (message, error) => backgroundErrors.push({ message, error }),
    });

    await store.append(firstThreadId, interruptedLifecycle(firstThreadId, false)[2]!);
    await expect(store.append(secondThreadId, interruptedLifecycle(secondThreadId, false)[2]!))
      .resolves.toMatchObject({ ordinal: 0 });

    expect((await store.read(secondThreadId)).map((entry) => entry.ordinal)).toEqual([0]);
    expect(backgroundErrors.map(({ message }) => message)).toEqual([
      '[agent] rollout LRU eviction failed',
    ]);
  });

  test('finalizes a Turn whose Items were persisted before the protocol grew a field', async () => {
    // A crashed Turn from an older build is finalized after upgrade. The Item
    // did not change, so the terminal-mutation invariant must not fire — it
    // compares canonical decoded Items, not stored bytes.
    const root = await tempRoot();
    const threadId = uuidV7(2_600);
    const path = join(root, 'thread_history.sqlite');
    const rollout = trackedRolloutStore(join(root, 'rollouts'));
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
    const rollout = trackedRolloutStore(join(root, 'rollouts'));
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
    const projectedTurn = incrementalTurns.data[0]!;
    expect(incremental.trajectoryTurnOverview(threadId)).toEqual({
      completedAt: projectedTurn.completedAt,
      diagnosticsUnavailable: true,
      startedAt: projectedTurn.startedAt,
      turnCount: 1,
      usage: {
        input: projectedTurn.execution.usage.input,
        output: projectedTurn.execution.usage.output,
        cacheRead: projectedTurn.execution.usage.cacheRead,
        cacheWrite: projectedTurn.execution.usage.cacheWrite,
        reasoning: null,
        totalTokens: projectedTurn.execution.usage.totalTokens,
        costUsd: projectedTurn.execution.usage.cost?.total ?? null,
      },
    });
    expect(incremental.trajectoryTurnPosition(threadId, projectedTurn.id)).toBe(0);
    expect(incremental.trajectoryTurnRange(threadId, 0, 1)).toEqual([{
      ...projectedTurn,
      items: [],
      itemsView: 'notLoaded',
    }]);
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

  test('exposes dense Trajectory Turn ranks over sparse rollout ordinals', async () => {
    const root = await tempRoot();
    const threadId = uuidV7(2_700);
    const rollout = trackedRolloutStore(join(root, 'dense-trajectory-ranks-rollouts'));
    const path = join(root, 'thread_history.sqlite');
    const db = testDatabase(path);
    const store = new ThreadHistoryProjectionStore(path, db);
    const firstLifecycle = lifecycle(threadId, 4_000);
    const secondLifecycle = lifecycle(threadId, 5_000);
    for (const notification of [...firstLifecycle, ...secondLifecycle]) {
      await rollout.append(threadId, notification);
    }
    store.applyMany(await rollout.read(threadId));
    const turns = store.listTurns({ threadId, itemsView: 'notLoaded' }).data;
    const rolloutPositions = db.prepare(`
      SELECT position FROM thread_turns WHERE thread_id = ? ORDER BY position
    `).all(threadId) as Array<{ position: number }>;

    expect(rolloutPositions.map((row) => row.position)).toEqual([0, firstLifecycle.length]);
    expect(store.trajectoryTurnPosition(threadId, turns[0]!.id)).toBe(0);
    expect(store.trajectoryTurnPosition(threadId, turns[1]!.id)).toBe(1);
    expect(store.trajectoryTurnPosition(threadId, uuidV7(6_000))).toBeNull();
    expect(store.trajectoryTurnRange(threadId, 0, 2).map((turn) => turn.id))
      .toEqual(turns.map((turn) => turn.id));
    expect(store.trajectoryTurnRange(threadId, 1, 2).map((turn) => turn.id))
      .toEqual([turns[1]!.id]);
    expect(store.trajectoryTurnRange(threadId, 2, 3)).toEqual([]);
    store.close();
  });

  test('shares bounded visible-history search rows fairly across candidate Threads', async () => {
    const root = await tempRoot();
    const rollout = trackedRolloutStore(join(root, 'fair-history-rollouts'));
    const longThreadId = uuidV7(2_010);
    const shortThreadId = uuidV7(2_020);
    for (const seed of [2_011, 2_012, 2_013]) {
      for (const notification of lifecycle(longThreadId, seed)) {
        await rollout.append(longThreadId, notification);
      }
    }
    for (const notification of lifecycle(shortThreadId, 2_021)) {
      await rollout.append(shortThreadId, notification);
    }
    const path = join(root, 'fair-history.sqlite');
    const database = testDatabase(path);
    const preparedSql: string[] = [];
    const observedDatabase: SqliteDatabase = {
      exec: (sql) => database.exec(sql),
      prepare: (sql) => {
        preparedSql.push(sql);
        return database.prepare(sql);
      },
      close: () => database.close(),
    };
    const store = new ThreadHistoryProjectionStore(path, observedDatabase);
    store.applyMany(await rollout.read(longThreadId));
    store.applyMany(await rollout.read(shortThreadId));

    preparedSql.length = 0;
    const entries = store.visibleHistoryEntries([longThreadId, shortThreadId], {
      maximum: 3,
      newestFirst: true,
    });
    expect(entries.map((entry) => entry.threadId)).toEqual([longThreadId, shortThreadId]);
    expect(entries.find((entry) => entry.threadId === shortThreadId)?.item).toMatchObject({
      type: 'agentMessage',
      text: 'Done',
    });
    const historyQuery = preparedSql.find((sql) => sql.includes('SELECT * FROM thread_items'));
    expect(historyQuery).toBeDefined();
    expect(historyQuery).not.toContain('ROW_NUMBER');
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${historyQuery!}`)
      .all(longThreadId, 1) as Array<{ readonly detail: string }>;
    const planDetails = plan.map((row) => row.detail).join('\n');
    expect(planDetails).toContain('thread_items_visible_history_idx');
    expect(planDetails).not.toContain('USE TEMP B-TREE');
    store.close();
  });

  test('keeps streamed Item rows unchanged while read surfaces use the in-memory overlay', async () => {
    const root = await tempRoot();
    const threadId = uuidV7(2_050);
    const rollout = trackedRolloutStore(join(root, 'overlay-rollouts'));
    const notifications = lifecycle(threadId);
    const started = notifications[0]!;
    if (started.type !== 'turn/started') throw new Error('Missing started Turn fixture');
    for (const notification of notifications.slice(0, 4)) await rollout.append(threadId, notification);
    const entries = await rollout.read(threadId);
    const path = join(root, 'overlay-history.sqlite');
    const database = testDatabase(path);
    const store = new ThreadHistoryProjectionStore(path, database);
    store.applyMany(entries.slice(0, -1));
    const before = database.prepare(
      'SELECT item_json FROM thread_items WHERE thread_id = ? AND item_id = ?',
    ).get(threadId, 'item-agent-4000') as { item_json: string };

    store.apply(entries.at(-1)!);
    const after = database.prepare(
      'SELECT item_json FROM thread_items WHERE thread_id = ? AND item_id = ?',
    ).get(threadId, 'item-agent-4000') as { item_json: string };
    expect(after.item_json).toBe(before.item_json);
    expect(store.readTurn(threadId, started.turnId, 'full')?.items.at(-1)).toMatchObject({
      type: 'agentMessage',
      text: 'Do',
    });
    expect(store.listItems({ threadId }).data.at(-1)?.item).toMatchObject({
      type: 'agentMessage',
      text: 'Do',
    });
    store.close();
  });

  test('restores the streaming overlay when a projection COMMIT fails', async () => {
    const root = await tempRoot();
    const threadId = uuidV7(2_075);
    const rollout = trackedRolloutStore(join(root, 'overlay-rollback-rollouts'));
    for (const notification of interruptedLifecycle(threadId, false)) {
      await rollout.append(threadId, notification);
    }
    const entries = await rollout.read(threadId);
    const started = entries[0]?.event;
    if (started?.type !== 'turn/started') throw new Error('Missing interrupted Turn fixture');
    const path = join(root, 'overlay-rollback-history.sqlite');
    const database = testDatabase(path);
    let failNextCommit = false;
    const failingDatabase: SqliteDatabase = {
      exec: (sql) => {
        if (failNextCommit && sql.trim() === 'COMMIT') {
          failNextCommit = false;
          throw new Error('simulated COMMIT failure');
        }
        database.exec(sql);
      },
      prepare: (sql) => database.prepare(sql),
      close: () => database.close(),
    };
    const store = new ThreadHistoryProjectionStore(path, failingDatabase);
    store.applyMany(entries);
    const streamed = store.readTurn(threadId, started.turnId, 'full')?.items.at(-1);
    if (streamed?.type !== 'agentMessage') throw new Error('Missing streamed agent Item');
    failNextCommit = true;

    expect(() => store.apply({
      ordinal: entries.length,
      byteOffset: entries.at(-1)!.byteOffset + entries.at(-1)!.byteLength,
      byteLength: 1,
      event: {
        type: 'item/completed',
        threadId,
        turnId: started.turnId,
        itemId: streamed.id,
        item: streamed,
        completedAt: 2_076,
      },
    })).toThrow('simulated COMMIT failure');

    expect(store.watermark(threadId).ordinal).toBe(entries.length - 1);
    expect(store.readTurn(threadId, started.turnId, 'full')?.items.at(-1)).toEqual(streamed);
    expect(store.unfinishedItems(threadId, started.turnId).at(-1)).toEqual(streamed);
    store.close();
  });

  test('replays rollback markers without deleting immutable rollout facts', async () => {
    const root = await tempRoot();
    const rollout = trackedRolloutStore(join(root, 'rollback-rollouts'));
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

  test('projects a failed Turn rerun as one atomic rollout event', async () => {
    const root = await tempRoot();
    const rollout = trackedRolloutStore(join(root, 'rerun-rollouts'));
    const threadId = uuidV7(2_200);
    const originalLifecycle = lifecycle(threadId, 4_500);
    for (const notification of originalLifecycle) await rollout.append(threadId, notification);

    const incremental = new ThreadHistoryProjectionStore(
      join(root, 'rerun-history.sqlite'),
      testDatabase(join(root, 'rerun-history.sqlite')),
    );
    incremental.applyMany(await rollout.read(threadId));
    const originalTurnId = incremental.listTurns({ threadId }).data[0]!.id;
    const replacementLifecycle = lifecycle(threadId, 4_600);
    const replacementStarted = replacementLifecycle[0];
    if (replacementStarted?.type !== 'turn/started') throw new Error('Missing replacement Turn start');
    const beforeRerun = incremental.projectionVersion(threadId);
    const rerun = await rollout.appendHistoryRerun(createThreadHistoryRollbackContext(
      uuidV7(4_700),
      threadId,
      [originalTurnId],
      beforeRerun,
      beforeRerun + 1,
    ), replacementStarted);

    incremental.apply(rerun);
    expect(incremental.listTurns({ threadId }).data.map((turn) => ({ id: turn.id, status: turn.status })))
      .toEqual([{ id: replacementStarted.turnId, status: 'inProgress' }]);
    expect(incremental.rollbackMarker(rerun.event.rollbackId)?.omittedTurnIds).toEqual([originalTurnId]);
    for (const notification of replacementLifecycle.slice(1)) {
      incremental.apply(await rollout.append(threadId, notification));
    }

    const entries = await rollout.read(threadId);
    expect(entries.filter((entry) => entry.event.type === 'history/rerun')).toHaveLength(1);
    const rebuilt = new ThreadHistoryProjectionStore(
      join(root, 'rerun-history-rebuilt.sqlite'),
      testDatabase(join(root, 'rerun-history-rebuilt.sqlite')),
    );
    rebuilt.rebuildThread(threadId, entries);
    expect(rebuilt.listTurns({ threadId })).toEqual(incremental.listTurns({ threadId }));
    expect(rebuilt.listItems({ threadId })).toEqual(incremental.listItems({ threadId }));
    expect(rebuilt.rollbackMarkers(threadId)).toEqual(incremental.rollbackMarkers(threadId));
    incremental.close();
    rebuilt.close();
  });

  test('replays an interrupted Turn with a completed partial stream exactly', async () => {
    const root = await tempRoot();
    const rollout = trackedRolloutStore(join(root, 'interrupted-rollouts'));
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

  test('restores streamed open Item content from rollout after the in-memory overlay is lost', async () => {
    const root = await tempRoot();
    const threadId = uuidV7(2_300);
    const rollout = trackedRolloutStore(join(root, 'crash-rollouts'));
    for (const notification of interruptedLifecycle(threadId, false)) {
      await rollout.append(threadId, notification);
    }
    const entries = await rollout.read(threadId);
    const started = entries[0]?.event;
    if (started?.type !== 'turn/started') throw new Error('Missing interrupted Turn fixture');
    const path = join(root, 'crash-history.sqlite');
    const initial = new ThreadHistoryProjectionStore(path, testDatabase(path));
    initial.applyMany(entries);
    const turnId = started.turnId;
    expect(initial.readTurn(threadId, turnId, 'full')?.items.at(-1)).toMatchObject({ text: 'Partial output' });
    initial.close();

    const reopened = new ThreadHistoryProjectionStore(path, testDatabase(path));
    expect(reopened.readTurn(threadId, turnId, 'full')?.items.at(-1)).toMatchObject({ text: '' });
    reopened.restoreOpenItemsFromRollout(threadId, turnId, entries);
    expect(reopened.unfinishedItems(threadId, turnId).at(-1)).toMatchObject({
      type: 'agentMessage',
      text: 'Partial output',
    });
    expect(reopened.readTurn(threadId, turnId, 'full')?.items.at(-1)).toMatchObject({ text: 'Partial output' });
    reopened.close();
  });

  test('rebuilds a projection that advanced past a lost unsynced rollout tail', async () => {
    const root = await tempRoot();
    const threadId = uuidV7(2_350);
    const rollout = trackedRolloutStore(join(root, 'lost-tail-rollouts'));
    for (const notification of interruptedLifecycle(threadId, false)) {
      await rollout.append(threadId, notification);
    }
    const entries = await rollout.read(threadId);
    const delta = entries.at(-1)!;
    const path = join(root, 'lost-tail-history.sqlite');
    const initial = new ThreadHistoryProjectionStore(path, testDatabase(path));
    initial.applyMany(entries);
    expect(initial.watermark(threadId).ordinal).toBe(delta.ordinal);
    initial.close();

    await rollout.flush();
    await truncate(rollout.pathFor(threadId), delta.byteOffset);
    const durableEntries = await rollout.read(threadId);
    const reopened = new ThreadHistoryProjectionStore(path, testDatabase(path));
    reopened.reconcileThread(threadId, durableEntries);

    expect(reopened.watermark(threadId)).toEqual({
      threadId,
      ordinal: delta.ordinal - 1,
      byteOffset: delta.byteOffset,
    });
    expect(reopened.listTurns({ threadId, itemsView: 'full' }).data[0]?.items.at(-1))
      .toMatchObject({ type: 'agentMessage', text: '' });
    reopened.close();
  });

  test('rejects Item and Turn mutation after terminal lifecycle facts', async () => {
    const root = await tempRoot();
    const threadId = uuidV7(2_500);
    const notifications = lifecycle(threadId);
    const rollout = trackedRolloutStore(join(root, 'immutable-rollouts'));
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
    expect(goals.readContinuationState(threadId)).toMatchObject({
      generation: 1,
      admittedCount: 0,
      wrapUpEligible: false,
      wrapUpAdmitted: false,
      pending: null,
    });
    expect(() => goals.create(threadId, 'Replace active work', null, 11)).toThrow('unfinished Goal');
    const continuationTurnId = uuidV7(3_001);
    expect(goals.reserveContinuation(threadId, first.generation, 'normal', continuationTurnId))
      .toEqual({ turnId: continuationTurnId, kind: 'normal', number: 1 });
    expect(goals.commitContinuation(threadId, first.generation, continuationTurnId)).toMatchObject({
      admittedCount: 1,
      pending: null,
    });
    expect(goals.deferContinuation(threadId, first.generation, 'Thread is active', 12).generation).toBe(1);
    expect(goals.addUsage(threadId, 100, 5, 13).goal.status).toBe('budgetLimited');
    expect(goals.readDeferral(threadId)).toBeNull();
    expect(goals.readContinuationState(threadId)).toMatchObject({
      admittedCount: 1,
      wrapUpEligible: true,
      wrapUpAdmitted: false,
    });
    const wrapUpTurnId = uuidV7(3_002);
    expect(goals.reserveContinuation(threadId, first.generation, 'budgetLimitedWrapUp', wrapUpTurnId))
      .toEqual({ turnId: wrapUpTurnId, kind: 'budgetLimitedWrapUp', number: 2 });
    expect(goals.commitContinuation(threadId, first.generation, wrapUpTurnId)).toMatchObject({
      admittedCount: 2,
      wrapUpEligible: false,
      wrapUpAdmitted: true,
      pending: null,
    });
    goals.updateFromAgent(threadId, 'complete', 14);
    expect(goals.addUsage(threadId, 1, 1, 15).goal.status).toBe('complete');

    const replacement = goals.create(threadId, 'Verify Agent Core', 5, 16);
    expect(replacement.generation).toBe(2);
    expect(replacement.goal.tokensUsed).toBe(0);
    expect(goals.readContinuationState(threadId)).toMatchObject({
      generation: 2,
      admittedCount: 0,
      wrapUpEligible: false,
      wrapUpAdmitted: false,
      pending: null,
    });
    expect(() => goals.deferContinuation(threadId, first.generation, 'stale', 17)).toThrow('stale');
    goals.updateFromAgent(threadId, 'blocked', 18);
    expect(goals.addUsage(threadId, 5, 1, 19).goal.status).toBe('budgetLimited');
    expect(goals.readContinuationState(threadId)?.wrapUpEligible).toBe(true);

    goals.setStatus(threadId, 'complete', 20);
    const interrupted = goals.create(threadId, 'Stop at the budget', 5, 21);
    expect(goals.addUsage(threadId, 5, 1, 22, 'interrupted').goal.status).toBe('budgetLimited');
    expect(goals.readContinuationState(threadId)).toMatchObject({
      generation: interrupted.generation,
      wrapUpEligible: false,
      wrapUpAdmitted: false,
    });
    goals.close();
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
    author: { kind: 'reader' },
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
    author: { kind: 'reader' },
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
    author: { kind: 'reader' },
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

function withoutUserMessageAuthors<T>(value: T): T {
  const clone = structuredClone(value);
  const visit = (candidate: unknown): void => {
    if (typeof candidate !== 'object' || candidate === null) return;
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    const record = candidate as Record<string, unknown>;
    if (record.type === 'userMessage') delete record.author;
    for (const entry of Object.values(record)) visit(entry);
  };
  visit(clone);
  return clone;
}
