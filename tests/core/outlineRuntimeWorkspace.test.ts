import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core } from '../../src/core/core';
import { canonicalSha256 } from '../../src/outline/contract/canonical';
import type { ProjectionResult, Selector } from '../../src/outline/contract/schemas';
import { decodeEventCursor, OutlineRuntimeWorkspace } from '../../src/outline/runtime';
import { OutlineRuntimeRouter } from '../../src/outline/runtime/server';
import { WorkspaceTransactionLog } from '../../src/outline/runtime/storage';

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('OutlineRuntimeWorkspace', () => {
  test('commits ordinary mutations against the live Core without forking the document', async () => {
    const root = await makeRoot();
    const workspace = await openWorkspace(root);
    const fork = spyOn(Core.prototype, 'forkForRuntime');

    try {
      await workspace.mutate(createRequest('Live Core mutation'));
      expect(fork).not.toHaveBeenCalled();
    } finally {
      fork.mockRestore();
    }
  });

  test('publishes a candidate only after the transaction record fsyncs', async () => {
    const root = await makeRoot();
    let workspace: OutlineRuntimeWorkspace | undefined;
    const revisionBefore = 0;
    const store = new WorkspaceTransactionLog(root, {
      afterTransactionFsync: async () => {
        expect(workspace?.revision()).toBe(revisionBefore);
        expect(workspace?.projection().nodes.some((node) => node.content.text === 'Published after fsync')).toBe(false);
        expect(workspace?.searchText('Published after fsync', 10)).toEqual([]);

        const response = await new OutlineRuntimeRouter(workspace!).handle({
          protocolVersion: 1,
          requestId: 'request:read-generation-before-publication',
          command: 'find',
          input: {
            mode: 'count',
            query: { kind: 'rule', op: 'STRING_MATCH', text: 'Published after fsync' },
          },
        }, { origin: 'local-user' });
        expect(response).toMatchObject({
          ok: true,
          revision: revisionBefore,
          data: {
            kind: 'outline.count',
            revision: revisionBefore,
            count: 0,
          },
        });
      },
    });
    workspace = await openWorkspace(root, { store, instanceId: 'runtime:publish-order' });

    const operation = await workspace.mutate(createRequest('Published after fsync'));

    expect(operation.revisionAfter).toBe(operation.revisionBefore + 1);
    expect(workspace.revision()).toBe(operation.revisionAfter);
    expect(workspace.projection().nodes.some((node) => node.content.text === 'Published after fsync')).toBe(true);
    expect(workspace.searchText('Published after fsync', 10)).toHaveLength(1);
    expect((await store.operations()).map((entry) => entry.operationId)).toEqual([operation.operationId]);
  });

  test('applies personal access only to transient desktop text ranking', async () => {
    const root = await makeRoot();
    const now = 10_000;
    const workspace = await openWorkspace(root, { now: () => new Date(now) });
    const nodeIds = [
      'node:00000000-0000-4000-8000-000000000001',
      'node:00000000-0000-4000-8000-000000000002',
    ];
    await workspace.mutate({
      ...createRequest('Create personal ranking fixtures'),
      execute: (core) => {
        const parentId = core.projection().todayId;
        core.createNode(parentId, null, 'Personal ranking needle', nodeIds[0]);
        core.createNode(parentId, null, 'Personal ranking needle', nodeIds[1]);
      },
    });

    const baseline = workspace.searchText('personal ranking needle', 10);
    expect(baseline.map((hit) => hit.nodeId)).toEqual(expect.arrayContaining(nodeIds));
    expect(baseline[0]?.nodeId).toBe(nodeIds[0]);

    workspace.replacePersonalAccessRanking(new Map([
      [nodeIds[1]!, { s: 20, tUpdate: now }],
    ]));
    const ranked = workspace.searchText('personal ranking needle', 10);
    expect(ranked[0]?.nodeId).toBe(nodeIds[1]);

    workspace.removePersonalAccessRanking([nodeIds[1]!]);
    const removed = workspace.searchText('personal ranking needle', 10);
    expect(removed[0]?.nodeId).toBe(nodeIds[0]);
  });

  test('keeps a committed mutation successful when the observer commit fails', async () => {
    const root = await makeRoot();
    const workspace = await openWorkspace(root, { instanceId: 'runtime:observer-failure' });
    const unsubscribeFailure = workspace.subscribe(() => {
      throw new Error('observer commit failed');
    });
    const deliveredOperationIds: string[] = [];
    const unsubscribeDelivery = workspace.subscribe((event) => {
      if (event.operation) deliveredOperationIds.push(event.operation.operationId);
    });

    const operation = await workspace.mutate(createRequest('Committed before observer failure'));

    expect(operation.revisionAfter).toBe(1);
    expect(deliveredOperationIds).toEqual([operation.operationId]);
    expect(workspace.projection().nodes.some(
      (node) => node.content.text === 'Committed before observer failure',
    )).toBe(true);
    unsubscribeFailure();
    unsubscribeDelivery();
    workspace.close();

    const restarted = await openWorkspace(root, { instanceId: 'runtime:observer-failure-restart' });
    expect(restarted.projection().nodes.some(
      (node) => node.content.text === 'Committed before observer failure',
    )).toBe(true);
    expect((await restarted.store.operations()).map((entry) => entry.operationId)).toEqual([
      operation.operationId,
    ]);
    restarted.close();
  });

  test('accepts desktop mutations before transaction-log fsync and drains the durable frontier', async () => {
    const root = await makeRoot();
    let blockFsync = false;
    let releaseFsync!: () => void;
    let signalFsync!: () => void;
    const fsyncEntered = new Promise<void>((resolve) => { signalFsync = resolve; });
    const fsyncGate = new Promise<void>((resolve) => { releaseFsync = resolve; });
    const store = new WorkspaceTransactionLog(root, {
      fsync: async (handle) => {
        if (blockFsync) {
          signalFsync();
          await fsyncGate;
        }
        await handle.sync();
      },
    });
    const workspace = await openWorkspace(root, { store, instanceId: 'runtime:accepted' });
    blockFsync = true;
    const request = createRequest('Accepted before fsync', {
      idempotencyKey: 'desktop:accepted',
      idempotencyPayloadHash: 'a'.repeat(64),
    });

    const accepted = await workspace.commitAcceptedPrepared(request, () => request);
    await fsyncEntered;

    expect(accepted.update).toMatchObject({ kind: 'delta', revision: 1 });
    expect(workspace.revision()).toBe(1);
    expect(workspace.durableRevision()).toBe(0);
    expect(workspace.projection().nodes.some((node) => node.content.text === 'Accepted before fsync')).toBe(true);

    releaseFsync();
    await workspace.drainDurability(1);
    expect(workspace.durableRevision()).toBe(1);
    expect((await store.operations()).map((operation) => operation.operationId)).toEqual([
      accepted.settlement.kind === 'outline.operation' ? accepted.settlement.operationId : '',
    ]);

    const restarted = await openWorkspace(root);
    expect(restarted.projection().nodes.some((node) => node.content.text === 'Accepted before fsync')).toBe(true);
  });

  test('freezes admission behind mutations already queued in the Runtime', async () => {
    const root = await makeRoot();
    const workspace = await openWorkspace(root);
    let releasePreparation!: () => void;
    let signalPreparation!: () => void;
    const preparationEntered = new Promise<void>((resolve) => { signalPreparation = resolve; });
    const preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
    const request = createRequest('Admitted before freeze', {
      idempotencyKey: 'desktop:before-freeze',
      idempotencyPayloadHash: 'e'.repeat(64),
    });

    const admitted = workspace.commitAcceptedPrepared(request, async () => {
      signalPreparation();
      await preparationGate;
      return request;
    });
    await preparationEntered;
    const freeze = workspace.freezeMutationAdmission();
    releasePreparation();

    const accepted = await admitted;
    expect(await freeze).toBe(accepted.update.revision);
    await expect(workspace.mutate(createRequest('Rejected after freeze'))).rejects.toMatchObject({
      outlineError: { code: 'runtime_unavailable' },
    });
    await workspace.drainDurability(accepted.update.revision);
    workspace.close();
  });

  test('coalesces sustained accepted edits at the maximum dirty age under one fsync', async () => {
    const root = await makeRoot();
    const clock = new TestClock();
    let fsyncCount = 0;
    let signalBatchFsync!: () => void;
    const batchFsync = new Promise<void>((resolve) => { signalBatchFsync = resolve; });
    const store = new WorkspaceTransactionLog(root, {
      fsync: async (handle) => {
        await handle.sync();
        fsyncCount += 1;
        if (fsyncCount > 2) signalBatchFsync();
      },
    });
    const workspace = await openWorkspace(root, {
      store,
      now: () => new Date(clock.nowValue),
      durabilityIdleDelayMs: 700,
      durabilityMaxWaitMs: 5_000,
      durabilitySchedule: clock.schedule,
      durabilityCancel: clock.cancel,
    });
    const baselineFsyncs = fsyncCount;

    for (let index = 0; index < 20; index += 1) {
      const request = createRequest(`Sustained ${index}`, {
        idempotencyKey: `desktop:sustained:${index}`,
        idempotencyPayloadHash: index.toString(16).padStart(64, '0'),
      });
      await workspace.commitAcceptedPrepared(request, () => request);
      await clock.advance(200);
    }

    expect(fsyncCount).toBe(baselineFsyncs);
    await clock.advance(999);
    expect(fsyncCount).toBe(baselineFsyncs);
    await clock.advance(1);
    await batchFsync;
    await workspace.drainDurability(20);

    expect(fsyncCount).toBe(baselineFsyncs + 1);
    expect(await store.operations()).toHaveLength(20);
    workspace.close();
  });

  test('freezes writes after deferred acknowledgement failure and retries without executing twice', async () => {
    const root = await makeRoot();
    let failAcknowledgement = true;
    let executions = 0;
    const store = new WorkspaceTransactionLog(root, {
      afterTransactionFsync: () => {
        if (!failAcknowledgement) return;
        failAcknowledgement = false;
        throw new Error('injected deferred acknowledgement failure');
      },
    });
    const workspace = await openWorkspace(root, { store });
    const publishedEvents: OutlineEvent[] = [];
    const unsubscribe = workspace.subscribe((event) => publishedEvents.push(event));
    const request = createRequest('Deferred retry', {
      idempotencyKey: 'desktop:deferred-retry',
      idempotencyPayloadHash: 'b'.repeat(64),
      onExecute: () => { executions += 1; },
    });
    const accepted = await workspace.commitAcceptedPrepared(request, () => request);

    await expect(workspace.drainDurability(accepted.update.revision)).rejects.toThrow(
      'injected deferred acknowledgement failure',
    );
    expect(publishedEvents).toEqual([]);
    await expect(workspace.mutate(createRequest('Blocked while dirty'))).rejects.toMatchObject({
      outlineError: { code: 'durability_failed' },
    });

    await workspace.drainDurability(accepted.update.revision);
    expect(executions).toBe(1);
    expect(workspace.durableRevision()).toBe(accepted.update.revision);
    expect(await store.operations()).toHaveLength(1);
    expect(publishedEvents).toEqual([
      expect.objectContaining({
        type: 'operation.committed',
        revision: accepted.update.revision,
        operation: expect.objectContaining({
          operationId: accepted.settlement.kind === 'outline.operation'
            ? accepted.settlement.operationId
            : '',
        }),
      }),
    ]);
    unsubscribe();
    workspace.close();
  });

  test('persists consecutive accepted mutations in revision and Event order across restart', async () => {
    const root = await makeRoot();
    let releaseFirstFsync!: () => void;
    const firstFsyncBlocked = new Promise<void>((resolve) => { releaseFirstFsync = resolve; });
    let fsyncCount = 0;
    const store = new WorkspaceTransactionLog(root, {
      afterTransactionFsync: async () => {
        fsyncCount += 1;
        if (fsyncCount === 1) await firstFsyncBlocked;
      },
    });
    const workspace = await openWorkspace(root, { store, instanceId: 'runtime:accepted-order' });
    const firstRequest = createRequest('Accepted first', {
      idempotencyKey: 'desktop:accepted-first',
      idempotencyPayloadHash: 'c'.repeat(64),
    });
    const secondRequest = createRequest('Accepted second', {
      idempotencyKey: 'desktop:accepted-second',
      idempotencyPayloadHash: 'd'.repeat(64),
    });

    const first = await workspace.commitAcceptedPrepared(firstRequest, () => firstRequest);
    const second = await workspace.commitAcceptedPrepared(secondRequest, () => secondRequest);

    expect(first.update.revision).toBe(1);
    expect(second.update.revision).toBe(2);
    expect(workspace.revision()).toBe(2);
    expect(workspace.durableRevision()).toBe(0);

    releaseFirstFsync();
    await workspace.drainDurability(2);

    expect(workspace.durableRevision()).toBe(2);
    expect((await store.operations()).map((operation) => operation.operationId)).toEqual([
      first.settlement.kind === 'outline.operation' ? first.settlement.operationId : '',
      second.settlement.kind === 'outline.operation' ? second.settlement.operationId : '',
    ]);
    expect((await store.eventsAfter(0)).map((event) => [event.sequence, event.revision])).toEqual([
      [1, 1],
      [2, 2],
    ]);

    workspace.close();
    const restarted = await openWorkspace(root, { instanceId: 'runtime:accepted-order-restart' });
    expect(restarted.revision()).toBe(2);
    expect(restarted.projection().nodes.map((node) => node.content.text)).toEqual(
      expect.arrayContaining(['Accepted first', 'Accepted second']),
    );
    restarted.close();
  });

  test('does not evict accepted idempotency results under sustained editing', async () => {
    const root = await makeRoot();
    const workspace = await openWorkspace(root);
    let firstExecutions = 0;
    const requests = Array.from({ length: 1_025 }, (_, index) => createNoChangeRequest(
      `Accepted no-change ${index}`,
      `desktop:no-change:${index}`,
      index === 0 ? () => { firstExecutions += 1; } : undefined,
    ));

    let firstResult: Awaited<ReturnType<OutlineRuntimeWorkspace['commitAcceptedPrepared']>> | undefined;
    for (const request of requests) {
      const result = await workspace.commitAcceptedPrepared(request, () => request);
      if (!firstResult) firstResult = result;
    }
    const retry = await workspace.commitAcceptedPrepared(requests[0]!, () => requests[0]!);

    expect(retry).toEqual(firstResult);
    expect(retry.update).toEqual({
      kind: 'delta',
      revision: 0,
      todayId: workspace.projection().todayId,
      changedNodes: [],
      removedIds: [],
    });
    expect(firstExecutions).toBe(1);
    expect(workspace.revision()).toBe(0);
    expect(await workspace.store.operations()).toEqual([]);
  });

  test('keeps Runtime Operation history out of Core local undo persistence', async () => {
    const root = await makeRoot();
    const workspace = await openWorkspace(root);

    await workspace.mutate(createRequest('Runtime-owned history'));

    const loaded = await workspace.store.load();
    expect(loaded.snapshot?.local.operationHistory).toEqual([]);
    expect(loaded.replay.every((entry) => (
      entry.local.operationHistoryUpserts.length === 0
      && entry.local.operationHistoryDeletes.length === 0
    ))).toBe(true);
    expect(loaded.operations).toHaveLength(1);
  });

  test('discards the candidate when recovery capacity rejects admission', async () => {
    const root = await makeRoot();
    const workspace = await openWorkspace(root, {
      storeOptions: { recoveryBudgetBytes: 1 },
    });
    const before = workspace.documentState();

    await expect(workspace.mutate(createRequest('Rejected candidate'))).rejects.toMatchObject({
      outlineError: { code: 'recovery_capacity_exceeded' },
    });

    expect(workspace.documentState()).toEqual(before);
    expect(await workspace.store.operations()).toEqual([]);
  });

  test('publishes resumable recovery-expiry Events during live maintenance', async () => {
    const root = await makeRoot();
    let nowMs = Date.parse('2035-01-01T00:00:00.000Z');
    const workspace = await openWorkspace(root, {
      instanceId: 'runtime:maintenance-live',
      now: () => new Date(nowMs),
      storeOptions: { minimumRetentionDays: 1, minimumRetentionOperations: 0 },
    });
    const operation = await workspace.mutate(createRequest('Expiring recovery'));
    const events: import('../../src/outline/contract').OutlineEvent[] = [];
    const unsubscribe = workspace.subscribe((event) => events.push(event));

    nowMs += 2 * 86_400_000;
    await workspace.maintain();
    unsubscribe();

    expect((await workspace.store.operation(operation.operationId))?.recovery.state).toBe('expired');
    expect(events).toEqual([expect.objectContaining({
      type: 'operation.recovery-expired',
      instanceId: workspace.instanceId,
      revision: workspace.revision(),
      recovery: {
        operationIds: [operation.operationId],
        recoveryPatchIds: [operation.recovery.recoveryPatchId],
      },
    })]);
    expect(decodeEventCursor(events[0]!.cursor, { instanceId: workspace.instanceId })).toMatchObject({
      sequence: events[0]!.sequence,
      revision: workspace.revision(),
    });
  });

  test('prunes eligible recovery during restarted maintenance with the new Runtime identity', async () => {
    const root = await makeRoot();
    let nowMs = Date.parse('2036-01-01T00:00:00.000Z');
    const options = {
      now: () => new Date(nowMs),
      storeOptions: { minimumRetentionDays: 1, minimumRetentionOperations: 0 },
    };
    const first = await openWorkspace(root, { ...options, instanceId: 'runtime:startup-first' });
    const operation = await first.mutate(createRequest('Startup expiry'));
    const baseline = (await first.store.health()).transactionLog.eventSequence;

    nowMs += 2 * 86_400_000;
    const restarted = await openWorkspace(root, { ...options, instanceId: 'runtime:startup-second' });
    await restarted.maintain();
    const [event] = await restarted.store.eventsAfter(baseline);

    expect((await restarted.store.operation(operation.operationId))?.recovery.state).toBe('expired');
    expect(event).toMatchObject({
      type: 'operation.recovery-expired',
      instanceId: 'runtime:startup-second',
      revision: restarted.revision(),
    });
    expect(decodeEventCursor(event!.cursor, { instanceId: restarted.instanceId })).not.toBeNull();
  });

  test('acknowledges mutations before post-commit compaction maintenance', async () => {
    const root = await makeRoot();
    let snapshotRenames = 0;
    let enterCompaction!: () => void;
    const compactionEntered = new Promise<void>((resolve) => { enterCompaction = resolve; });
    const store = new WorkspaceTransactionLog(root, {
      compactionRecords: 1,
      afterSnapshotRename: () => {
        snapshotRenames += 1;
        if (snapshotRenames === 2) enterCompaction();
      },
    });
    const workspace = await openWorkspace(root, { store });

    const mutation = workspace.mutate(createRequest('Acknowledged before compaction'));
    const firstSettlement = await Promise.race([
      mutation.then(() => 'mutation' as const),
      compactionEntered.then(() => 'compaction' as const),
    ]);

    expect(firstSettlement).toBe('mutation');
    const operation = await mutation;
    expect(operation.kind).toBe('outline.operation');
    expect(workspace.projection().nodes.some((node) => node.content.text === 'Acknowledged before compaction')).toBe(true);
    expect(snapshotRenames).toBe(1);
  });

  test('accepts a desktop mutation while an idle compaction is in flight', async () => {
    const root = await makeRoot();
    let snapshotRenames = 0;
    let enterCompaction!: () => void;
    let releaseCompaction!: () => void;
    const compactionEntered = new Promise<void>((resolve) => { enterCompaction = resolve; });
    const compactionGate = new Promise<void>((resolve) => { releaseCompaction = resolve; });
    const store = new WorkspaceTransactionLog(root, {
      compactionRecords: 1,
      afterSnapshotRename: async () => {
        snapshotRenames += 1;
        if (snapshotRenames !== 2) return;
        enterCompaction();
        await compactionGate;
      },
    });
    const workspace = await openWorkspace(root, { store });
    await workspace.mutate(createRequest('Durable before compaction'));

    const maintenance = workspace.maintain({ compactIfNeeded: true });
    await compactionEntered;
    const request = createRequest('Accepted during compaction', {
      idempotencyKey: 'desktop:during-compaction',
      idempotencyPayloadHash: 'c'.repeat(64),
    });
    const accepting = workspace.commitAcceptedPrepared(request, () => request);
    const firstSettlement = await Promise.race([
      accepting.then(() => 'mutation' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
    ]);

    releaseCompaction();
    await maintenance;
    expect(firstSettlement).toBe('mutation');
    const accepted = await accepting;
    expect(accepted.update).toMatchObject({ kind: 'delta', revision: 2 });
    await workspace.drainDurability(2);

    const restarted = await openWorkspace(root);
    expect(restarted.projection().nodes.map((node) => node.content.text)).toEqual(
      expect.arrayContaining(['Durable before compaction', 'Accepted during compaction']),
    );
  });

  test('retains a desktop mutation accepted while compaction fails after snapshot replacement', async () => {
    const root = await makeRoot();
    let snapshotRenames = 0;
    let enterCompaction!: () => void;
    let releaseCompaction!: () => void;
    const compactionEntered = new Promise<void>((resolve) => { enterCompaction = resolve; });
    const compactionGate = new Promise<void>((resolve) => { releaseCompaction = resolve; });
    const store = new WorkspaceTransactionLog(root, {
      compactionRecords: 1,
      afterSnapshotRename: async () => {
        snapshotRenames += 1;
        if (snapshotRenames !== 2) return;
        enterCompaction();
        await compactionGate;
        throw new Error('injected failure after snapshot replacement');
      },
    });
    const workspace = await openWorkspace(root, { store });
    const durableOperation = await workspace.mutate(createRequest('Durable before failed compaction'));

    const maintenance = workspace.maintain({ compactIfNeeded: true });
    await compactionEntered;
    const request = createRequest('Accepted during failed compaction', {
      idempotencyKey: 'desktop:during-failed-compaction',
      idempotencyPayloadHash: 'd'.repeat(64),
    });
    const accepted = await workspace.commitAcceptedPrepared(request, () => request);
    expect(accepted.update).toMatchObject({ kind: 'delta', revision: 2 });

    releaseCompaction();
    await expect(maintenance).rejects.toThrow('injected failure after snapshot replacement');
    await workspace.drainDurability(2);
    workspace.close();

    const restarted = await openWorkspace(root);
    expect(restarted.projection().nodes.map((node) => node.content.text)).toEqual(
      expect.arrayContaining(['Durable before failed compaction', 'Accepted during failed compaction']),
    );
    const acceptedOperationId = accepted.settlement.kind === 'outline.operation'
      ? accepted.settlement.operationId
      : '';
    const operations = await restarted.store.operations();
    expect(operations.map((operation) => operation.operationId)).toEqual([
      durableOperation.operationId,
      acceptedOperationId,
    ]);
    expect(new Set(operations.map((operation) => operation.operationId)).size).toBe(2);
    expect(operations.map((operation) => [operation.revisionBefore, operation.revisionAfter])).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(restarted.revision()).toBe(2);
    restarted.close();
  });

  test('does not reverse a durable Operation when later compaction maintenance fails', async () => {
    const root = await makeRoot();
    let snapshotRenames = 0;
    const store = new WorkspaceTransactionLog(root, {
      compactionRecords: 1,
      afterSnapshotRename: () => {
        snapshotRenames += 1;
        if (snapshotRenames === 2) throw new Error('injected maintenance failure');
      },
    });
    const workspace = await openWorkspace(root, { store });

    const first = await workspace.mutate(createRequest('Committed before maintenance failure'));
    expect(first.kind).toBe('outline.operation');
    expect(workspace.projection().nodes.some((node) => node.content.text === 'Committed before maintenance failure')).toBe(true);
    await expect(workspace.maintain({ compactIfNeeded: true })).rejects.toThrow('injected maintenance failure');
    expect(workspace.projection().nodes.some((node) => node.content.text === 'Committed before maintenance failure')).toBe(true);

    const second = await workspace.mutate(createRequest('Writable after maintenance reload'));
    expect(second.revisionBefore).toBe(first.revisionAfter);
    const restarted = await openWorkspace(root);
    expect(restarted.projection().nodes.some((node) => node.content.text === 'Committed before maintenance failure')).toBe(true);
    expect(restarted.projection().nodes.some((node) => node.content.text === 'Writable after maintenance reload')).toBe(true);
  });

  test('rejects an exact patch mismatch without changing live or durable state', async () => {
    const root = await makeRoot();
    const workspace = await openWorkspace(root);
    const before = workspace.documentState();

    await expect(workspace.mutate({
      ...createRequest('Mismatched candidate'),
      expectedPatchHash: '0'.repeat(64),
    })).rejects.toMatchObject({
      outlineError: { code: 'diff_mismatch' },
    });

    expect(workspace.documentState()).toEqual(before);
    expect(await workspace.store.operations()).toEqual([]);
  });

  test('keeps document revisions monotonic across Runtime restart', async () => {
    const root = await makeRoot();
    const firstRuntime = await openWorkspace(root, { instanceId: 'runtime:first' });
    const first = await firstRuntime.mutate(createRequest('Before restart'));

    const restarted = await openWorkspace(root, { instanceId: 'runtime:second' });
    expect(restarted.revision()).toBe(first.revisionAfter);
    const second = await restarted.mutate(createRequest('After restart'));

    expect(second.revisionBefore).toBe(first.revisionAfter);
    expect(second.revisionAfter).toBe(first.revisionAfter + 1);
    expect(restarted.projection().nodes.some((node) => node.content.text === 'Before restart')).toBe(true);
    expect(restarted.projection().nodes.some((node) => node.content.text === 'After restart')).toBe(true);
  });

  test('returns the original Operation for an idempotent request without executing twice', async () => {
    const root = await makeRoot();
    const workspace = await openWorkspace(root);
    let executions = 0;
    const request = createRequest('Idempotent row', {
      idempotencyKey: 'request:stable',
      idempotencyPayloadHash: 'a'.repeat(64),
      onExecute: () => { executions += 1; },
    });

    const first = await workspace.mutate(request);
    const retry = await workspace.mutate(request);

    expect(retry).toEqual(first);
    expect(executions).toBe(1);
    expect(await workspace.store.operations()).toHaveLength(1);
  });

  test('serializes concurrent mutations into one revision and Event sequence', async () => {
    const root = await makeRoot();
    const workspace = await openWorkspace(root, { instanceId: 'runtime:serialized' });

    const [first, second] = await Promise.all([
      workspace.mutate(createRequest('Concurrent first')),
      workspace.mutate(createRequest('Concurrent second')),
    ]);

    expect(first.revisionAfter).toBe(second.revisionBefore);
    expect((await workspace.store.eventsAfter(0)).map((event) => event.sequence)).toEqual([1, 2]);
    expect((await workspace.store.operations()).map((operation) => operation.operationId)).toEqual([
      first.operationId,
      second.operationId,
    ]);
  });

  test('persists guarded revert and revert-of-revert as new Operations', async () => {
    const root = await makeRoot();
    const nodeId = `node:${crypto.randomUUID()}`;
    const workspace = await openWorkspace(root, { instanceId: 'runtime:revert' });
    const created = await workspace.mutate(createRequest('Reversible row', { nodeId }));
    expect(created.effects).toEqual({
      createdNodeCount: 1,
      createdDefinitionCount: 0,
      updatedNodeCount: 1,
      deletedNodeCount: 0,
    });
    const createdState = workspace.documentState();

    const reverted = await workspace.revert(created.operationId, { origin: 'local-user' });
    expect(reverted.effects).toEqual({
      createdNodeCount: 0,
      createdDefinitionCount: 0,
      updatedNodeCount: 1,
      deletedNodeCount: 1,
    });
    expect(workspace.documentState().nodes[nodeId]).toBeUndefined();
    expect(reverted.revertsOperationId).toBe(created.operationId);
    const redone = await workspace.revert(reverted.operationId, { origin: 'local-user' });
    expect(redone.effects).toEqual(created.effects);

    expect(workspace.documentState()).toEqual(createdState);
    expect(redone.revertsOperationId).toBe(reverted.operationId);
    const operations = await workspace.store.operations();
    expect(operations.map((operation) => operation.recovery.state)).toEqual([
      'reverted',
      'reverted',
      'available',
    ]);
    const restarted = await openWorkspace(root);
    expect(restarted.documentState()).toEqual(createdState);
    expect((await restarted.store.operation(created.operationId))?.effects).toEqual(created.effects);
  });

  test('reconstructs consecutive undo and redo history across Runtime restart', async () => {
    const root = await makeRoot();
    const firstNodeId = `node:${crypto.randomUUID()}`;
    const secondNodeId = `node:${crypto.randomUUID()}`;
    const workspace = await openWorkspace(root);
    await workspace.mutate(createRequest('First history row', { nodeId: firstNodeId }));
    await workspace.mutate(createRequest('Second history row', { nodeId: secondNodeId }));

    await workspace.undo({ origin: 'local-user' });
    expect(workspace.documentState().nodes[secondNodeId]).toBeUndefined();
    expect(workspace.documentState().nodes[firstNodeId]).toBeDefined();
    await workspace.undo({ origin: 'local-user' });
    expect(workspace.documentState().nodes[firstNodeId]).toBeUndefined();

    const restarted = await openWorkspace(root);
    await restarted.redo({ origin: 'local-user' });
    expect(restarted.documentState().nodes[firstNodeId]).toBeDefined();
    expect(restarted.documentState().nodes[secondNodeId]).toBeUndefined();
    await restarted.redo({ origin: 'local-user' });
    expect(restarted.documentState().nodes[secondNodeId]).toBeDefined();
    await expect(restarted.redo({ origin: 'local-user' })).rejects.toMatchObject({
      outlineError: { code: 'not_found' },
    });

    const restartedAgain = await openWorkspace(root);
    await restartedAgain.undo({ origin: 'local-user' });
    expect(restartedAgain.documentState().nodes[firstNodeId]).toBeDefined();
    expect(restartedAgain.documentState().nodes[secondNodeId]).toBeUndefined();
  });

  test('undo reverts a materialized text-edit group as one user action', async () => {
    const root = await makeRoot();
    const nodeId = `node:${crypto.randomUUID()}`;
    const workspace = await openWorkspace(root);
    const undoGroup = {
      groupId: `undo-group:${crypto.randomUUID()}`,
      kind: 'text-edit' as const,
      nodeId,
    };
    const created = await workspace.mutate({ ...createRequest('A', { nodeId }), undoGroup });
    const edited = await workspace.mutate({
      ...textPatchRequest(nodeId, 'AB'),
      undoGroup,
    });

    const undo = await workspace.undo({ origin: 'local-user' });

    expect(workspace.documentState().nodes[nodeId]).toBeUndefined();
    expect(undo.revertsOperationId).toBe(edited.operationId);
    expect(undo.revertsOperationIds).toEqual([created.operationId, edited.operationId]);
    expect((await workspace.store.operations()).map((operation) => operation.recovery.state)).toEqual([
      'reverted',
      'reverted',
      'available',
    ]);

    const restarted = await openWorkspace(root);
    const redo = await restarted.redo({ origin: 'local-user' });
    expect(redo.revertsOperationId).toBe(undo.operationId);
    expect(restarted.documentState().nodes[nodeId]?.content.text).toBe('AB');
  });

  test('scopes undo by origin and guards the selected Operation', async () => {
    const root = await makeRoot();
    const workspace = await openWorkspace(root);
    const userNodeId = `node:${crypto.randomUUID()}`;
    const agentNodeId = `node:${crypto.randomUUID()}`;
    const newestUserNodeId = `node:${crypto.randomUUID()}`;
    await workspace.mutate(createRequest('User row', { nodeId: userNodeId }));
    await workspace.mutate(createRequest('Agent row', { nodeId: agentNodeId }));
    await workspace.mutate(createRequest('Newest user row', { nodeId: newestUserNodeId }));
    await workspace.mutate(updateRequest(userNodeId, 'Edited by user'));
    const agentOperation = await workspace.mutate({
      ...updateRequest(agentNodeId, 'Edited by agent'),
      origin: 'built-in-agent',
    });
    const newestUserOperation = await workspace.mutate(updateRequest(newestUserNodeId, 'Edited newest by user'));

    const operationsBeforeConflict = await workspace.store.operations();
    await expect(workspace.undo({
      origin: 'built-in-agent',
      selectionOrigin: 'built-in-agent',
      expectOperationId: newestUserOperation.operationId,
    })).rejects.toMatchObject({
      outlineError: {
        code: 'stale_revision',
        details: {
          expectedOperationId: newestUserOperation.operationId,
          actualOperationId: agentOperation.operationId,
        },
      },
    });
    expect(await workspace.store.operations()).toEqual(operationsBeforeConflict);

    const agentUndo = await workspace.undo({
      origin: 'local-user',
      selectionOrigin: 'built-in-agent',
      expectOperationId: agentOperation.operationId,
    });
    expect(agentUndo.revertsOperationId).toBe(agentOperation.operationId);
    expect(workspace.documentState().nodes[agentNodeId]?.description).toBeUndefined();
    expect(workspace.documentState().nodes[userNodeId]?.description).toBe('Edited by user');
    expect(workspace.documentState().nodes[newestUserNodeId]?.description).toBe('Edited newest by user');

    const restarted = await openWorkspace(root);
    const agentRedo = await restarted.redo({
      origin: 'local-user',
      selectionOrigin: 'built-in-agent',
      expectOperationId: agentUndo.operationId,
    });
    expect(agentRedo.revertsOperationId).toBe(agentUndo.operationId);
    expect(restarted.documentState().nodes[agentNodeId]?.description).toBe('Edited by agent');
    expect(restarted.documentState().nodes[userNodeId]?.description).toBe('Edited by user');
    expect(restarted.documentState().nodes[newestUserNodeId]?.description).toBe('Edited newest by user');

    const globalRoot = await makeRoot();
    const globalWorkspace = await openWorkspace(globalRoot);
    const globalUserNodeId = `node:${crypto.randomUUID()}`;
    const globalAgentNodeId = `node:${crypto.randomUUID()}`;
    await globalWorkspace.mutate(createRequest('Global user row', { nodeId: globalUserNodeId }));
    await globalWorkspace.mutate(createRequest('Global agent row', { nodeId: globalAgentNodeId }));
    await globalWorkspace.mutate(updateRequest(globalUserNodeId, 'Global user edit'));
    const globalAgentOperation = await globalWorkspace.mutate({
      ...updateRequest(globalAgentNodeId, 'Global agent edit'),
      origin: 'built-in-agent',
    });

    const globalUndo = await globalWorkspace.undo({
      origin: 'local-user',
      selectionOrigin: 'all',
      expectOperationId: globalAgentOperation.operationId,
    });
    expect(globalUndo.revertsOperationId).toBe(globalAgentOperation.operationId);
    expect(globalWorkspace.documentState().nodes[globalAgentNodeId]?.description).toBeUndefined();
    expect(globalWorkspace.documentState().nodes[globalUserNodeId]?.description).toBe('Global user edit');
  });

  test('rejects revert when one affected after value changed and writes no recovery Operation', async () => {
    const root = await makeRoot();
    const nodeId = `node:${crypto.randomUUID()}`;
    const workspace = await openWorkspace(root);
    const created = await workspace.mutate(createRequest('Conflict row', { nodeId }));
    await workspace.mutate(updateRequest(nodeId, 'Changed after original Operation'));

    await expect(workspace.revert(created.operationId, { origin: 'local-user' })).rejects.toMatchObject({
      outlineError: {
        code: 'revert_conflict',
        details: {
          conflictDiff: {
            kind: 'outline.revert-conflict-diff',
            operationId: created.operationId,
            currentRevision: workspace.revision(),
            changedPreconditions: [{
              id: nodeId,
              expectedAfterDigest: expect.any(String),
              actualDigest: canonicalSha256(workspace.documentState().nodes[nodeId]),
            }],
          },
        },
      },
    });

    expect(workspace.documentState().nodes[nodeId]?.description).toBe('Changed after original Operation');
    expect(await workspace.store.operations()).toHaveLength(2);
  });

  test('blocks the stale process after fsync-before-ack failure while restart publishes the committed state', async () => {
    const root = await makeRoot();
    let fail = true;
    const store = new WorkspaceTransactionLog(root, {
      afterTransactionFsync: () => {
        if (fail) {
          fail = false;
          throw new Error('injected acknowledgement crash');
        }
      },
    });
    const workspace = await openWorkspace(root, { store });

    await expect(workspace.mutate(createRequest('Committed without acknowledgement'))).rejects.toMatchObject({
      outlineError: { code: 'operation_settlement_unknown' },
    });
    expect(workspace.projection().nodes.some((node) => node.content.text === 'Committed without acknowledgement')).toBe(false);
    await expect(workspace.mutate(createRequest('Must not run on stale Core'))).rejects.toMatchObject({
      outlineError: { code: 'operation_settlement_unknown' },
    });

    const restarted = await openWorkspace(root);
    expect(restarted.projection().nodes.some((node) => node.content.text === 'Committed without acknowledgement')).toBe(true);
    expect(restarted.projection().nodes.some((node) => node.content.text === 'Must not run on stale Core')).toBe(false);
  });

  test('rehydrates and publishes the retained Event when the exact unknown settlement is retried', async () => {
    const root = await makeRoot();
    let fail = false;
    let executions = 0;
    const store = new WorkspaceTransactionLog(root, {
      afterTransactionFsync: () => {
        if (!fail) return;
        fail = false;
        throw new Error('injected acknowledgement crash');
      },
    });
    const workspace = await openWorkspace(root, { store });
    const earlierKey = 'runtime:earlier-settlement';
    const earlierHash = 'd'.repeat(64);
    await workspace.mutate(createRequest('Earlier durable write', {
      idempotencyKey: earlierKey,
      idempotencyPayloadHash: earlierHash,
    }));
    fail = true;
    const events: OutlineEvent[] = [];
    const unsubscribe = workspace.subscribe((event) => events.push(event));
    const idempotencyKey = 'runtime:recover-live-settlement';
    const payloadHash = 'e'.repeat(64);
    const request = createRequest('Recovered without restart', {
      idempotencyKey,
      idempotencyPayloadHash: payloadHash,
      onExecute: () => { executions += 1; },
    });

    await expect(workspace.mutate(request)).rejects.toMatchObject({
      outlineError: { code: 'operation_settlement_unknown' },
    });
    expect(workspace.revision()).toBe(1);
    expect(events).toEqual([]);
    await expect(workspace.settledOperation(earlierKey, earlierHash)).rejects.toMatchObject({
      outlineError: { code: 'operation_settlement_unknown' },
    });

    const operation = await workspace.settledOperation(idempotencyKey, payloadHash);
    expect(operation?.revisionAfter).toBe(2);
    expect(executions).toBe(1);
    expect(workspace.revision()).toBe(2);
    expect(workspace.durableRevision()).toBe(2);
    expect(workspace.projection().nodes.some((node) => node.content.text === 'Recovered without restart')).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'operation.committed',
        revision: 2,
        operation: expect.objectContaining({ operationId: operation?.operationId }),
      }),
    ]);

    expect(await workspace.settledOperation(idempotencyKey, payloadHash)).toEqual(operation);
    expect(events).toHaveLength(1);
    const next = await workspace.mutate(createRequest('Write after live recovery'));
    expect(next.revisionBefore).toBe(2);
    unsubscribe();
  });

  test('pages newest-first Operation history and filters trusted causation', async () => {
    const root = await makeRoot();
    const workspace = await openWorkspace(root);
    const first = await workspace.mutate({
      ...createRequest('Causation match'),
      origin: 'built-in-agent',
      causation: { threadId: 'thread:one', turnId: 'turn:one', itemId: 'item:one' },
    });
    const second = await workspace.mutate(createRequest('Newest Operation'));
    const router = new OutlineRuntimeRouter(workspace);

    const firstPage = await logPage(router, { limit: 1 });
    expect(firstPage.operations.map((operation) => operation.operationId)).toEqual([second.operationId]);
    expect(firstPage.cursor).toEqual(expect.any(String));
    const secondPage = await logPage(router, { limit: 1, cursor: firstPage.cursor });
    expect(secondPage.operations.map((operation) => operation.operationId)).toEqual([first.operationId]);
    expect(secondPage.cursor).toBeUndefined();

    const causal = await logPage(router, {
      threadId: 'thread:one',
      turnId: 'turn:one',
      itemId: 'item:one',
    });
    expect(causal.operations.map((operation) => operation.operationId)).toEqual([first.operationId]);
    await expect(logPage(router, {
      limit: 1,
      origin: 'local-user',
      cursor: firstPage.cursor,
    })).rejects.toMatchObject({ code: 'stale_revision' });
  });

  test('pages every affected Node ID from retained recovery data', async () => {
    const root = await makeRoot();
    const workspace = await openWorkspace(root);
    const operation = await workspace.mutate({
      origin: 'external-client',
      changeSetHash: canonicalSha256({ kind: 'bulk-create' }),
      diffHash: canonicalSha256({ kind: 'bulk-create-diff' }),
      summary: 'Created a large affected set.',
      execute: (core) => {
        const parentId = core.projection().todayId;
        for (let index = 0; index < 1_001; index += 1) {
          core.createNode(parentId, null, `Bulk ${index}`, `node:${crypto.randomUUID()}`);
        }
      },
    });
    expect(operation.affectedNodeIdsTruncated).toBe(true);
    expect(operation.affectedNodeIdsCursor).toEqual(expect.any(String));
    const router = new OutlineRuntimeRouter(workspace);

    const pages = [];
    let cursor: string | undefined;
    do {
      const page = await logPage(router, {
        operationId: operation.operationId,
        limit: 400,
        ...(cursor ? { cursor } : {}),
      });
      pages.push(...page.affectedNodeIds!.nodeIds);
      cursor = page.cursor;
    } while (cursor);
    expect(pages).toHaveLength(operation.affectedNodeCount);
    expect(canonicalSha256(pages)).toBe(operation.affectedNodeIdsHash);

    const resumed = await logPage(router, {
      operationId: operation.operationId,
      cursor: operation.affectedNodeIdsCursor,
      limit: 1,
    });
    expect(resumed.affectedNodeIds).toMatchObject({ offset: 1_000, totalCount: operation.affectedNodeCount });
    expect(resumed.affectedNodeIds?.nodeIds).toEqual(pages.slice(1_000, 1_001));
    expect(resumed.cursor).toEqual(expect.any(String));
  }, 15_000);

  test('derives bounded many defaults for every multi-target Runtime read selector', async () => {
    const root = await makeRoot();
    const workspace = await openWorkspace(root);
    const nodeIds = [`node:${crypto.randomUUID()}`, `node:${crypto.randomUUID()}`];
    const marker = `runtime-read-${crypto.randomUUID()}`;
    await workspace.mutate({
      ...createRequest('Create Runtime read fixtures'),
      execute: (core) => {
        const parentId = core.projection().todayId;
        core.createNode(parentId, null, `${marker} alpha`, nodeIds[0]);
        core.createNode(parentId, null, `${marker} beta`, nodeIds[1]);
      },
    });
    const searchId = `node:${crypto.randomUUID()}`;
    await workspace.mutate({
      ...createRequest('Create Runtime read Saved Search'),
      execute: (core) => {
        core.createSearchNode(core.projection().searchesId, null, {
          title: 'Bounded selector fixture',
          query: { kind: 'rule', op: 'STRING_MATCH', text: marker },
        }, undefined, searchId);
      },
    });
    const selectors: Array<{ selector: Selector; max: number }> = [
      { selector: { by: 'ids', ids: nodeIds }, max: 2 },
      {
        selector: {
          by: 'query',
          query: { kind: 'rule', op: 'STRING_MATCH', text: marker },
          limit: 10,
        },
        max: 10,
      },
      { selector: { by: 'search', id: searchId, limit: 10 }, max: 10 },
    ];
    const router = new OutlineRuntimeRouter(workspace);

    for (const command of ['get', 'export'] as const) {
      for (const { selector, max } of selectors) {
        const response = await router.handle({
          protocolVersion: 1,
          requestId: `request:${command}:${selector.by}`,
          command,
          input: { selector },
        }, { origin: 'local-user' });
        expect(response.ok).toBe(true);
        if (!response.ok) continue;
        const result = response.data as ProjectionResult;
        const resultIds = result.nodes
          .map((node) => (node as { id: string }).id)
          .filter((id) => nodeIds.includes(id));
        if (selector.by === 'ids') expect(resultIds).toEqual(nodeIds);
        else expect(new Set(resultIds)).toEqual(new Set(nodeIds));
        expect(result.projection.targets).toEqual({
          target: { selector, cardinality: 'many', max },
        });
      }
    }
  });

  test('accepts standalone read Projections and rejects conflicting duplicate selectors', async () => {
    const root = await makeRoot();
    const workspace = await openWorkspace(root);
    const firstId = `node:${crypto.randomUUID()}`;
    const secondId = `node:${crypto.randomUUID()}`;
    await workspace.mutate({
      ...createRequest('Create standalone Projection fixtures'),
      execute: (core) => {
        const parentId = core.projection().todayId;
        core.createNode(parentId, null, 'Standalone first', firstId);
        core.createNode(parentId, null, 'Standalone second', secondId);
      },
    });
    const router = new OutlineRuntimeRouter(workspace);
    const projection = {
      kind: 'summary' as const,
      targets: {
        target: {
          selector: { by: 'id' as const, id: firstId },
          cardinality: 'one' as const,
        },
      },
      page: { limit: 1 },
    };

    const standalone = await router.handle({
      protocolVersion: 1,
      requestId: 'request:standalone-projection',
      command: 'get',
      input: { projection },
    }, { origin: 'local-user' });
    expect(standalone.ok).toBe(true);
    if (standalone.ok) {
      expect((standalone.data as ProjectionResult).nodes).toEqual([
        expect.objectContaining({ id: firstId }),
      ]);
    }

    const conflicting = await router.handle({
      protocolVersion: 1,
      requestId: 'request:conflicting-projection',
      command: 'get',
      input: { selector: { by: 'id', id: secondId }, projection },
    }, { origin: 'local-user' });
    expect(conflicting).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_input',
        category: 'usage',
        message: 'get Selector conflicts with the Selector declared by --projection.',
      },
    });
  });

  test('rejects a handler result that violates the executable capability schema', async () => {
    const root = await makeRoot();
    const workspace = await openWorkspace(root);
    const router = new OutlineRuntimeRouter(workspace);
    router.register('get', () => ({ nodes: 'not-an-array' }));

    const response = await router.handle({
      protocolVersion: 1,
      requestId: 'request:invalid-handler-result',
      command: 'get',
      input: { selector: { by: 'alias', alias: 'today' } },
    }, { origin: 'local-user' });
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'internal_error', category: 'internal' },
    });
  });
});

async function logPage(router: OutlineRuntimeRouter, input: Record<string, unknown>) {
  const response = await router.handle({
    protocolVersion: 1,
    requestId: `request:${crypto.randomUUID()}`,
    command: 'history',
    input,
  }, { origin: 'local-user' });
  if (!response.ok) throw response.error;
  return response.data as import('../../src/outline/contract').OperationLogPage;
}

interface CreateRequestOptions {
  readonly nodeId?: string;
  readonly idempotencyKey?: string;
  readonly idempotencyPayloadHash?: string;
  readonly onExecute?: () => void;
}

function createRequest(text: string, options: CreateRequestOptions = {}) {
  const payload = {
    kind: 'create',
    text,
    ...(options.nodeId ? { nodeId: options.nodeId } : {}),
  };
  return {
    origin: 'local-user' as const,
    changeSetHash: canonicalSha256(payload),
    diffHash: canonicalSha256({ ...payload, kind: 'diff' }),
    summary: `Created ${text}.`,
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    ...(options.idempotencyPayloadHash ? { idempotencyPayloadHash: options.idempotencyPayloadHash } : {}),
    execute: (core: Parameters<Parameters<OutlineRuntimeWorkspace['mutate']>[0]['execute']>[0]) => {
      options.onExecute?.();
      core.createNode(core.projection().todayId, null, text, options.nodeId);
    },
  };
}

function createNoChangeRequest(text: string, idempotencyKey: string, onExecute?: () => void) {
  const changeSetHash = canonicalSha256({ kind: 'no-change', text });
  const diffHash = canonicalSha256({ kind: 'no-change-diff', text });
  return {
    origin: 'desktop' as const,
    changeSetHash,
    diffHash,
    summary: `${text}.`,
    idempotencyKey,
    idempotencyPayloadHash: canonicalSha256({ kind: 'no-change-payload', text }),
    execute: () => { onExecute?.(); },
    noChangeResult: (core: Core) => ({
      protocolVersion: 1 as const,
      kind: 'outline.no-change' as const,
      changeSetHash,
      diffHash,
      revision: core.revision(),
      affectedNodeCount: 0 as const,
      recovery: { state: 'not-required' as const },
    }),
  };
}

function updateRequest(nodeId: string, description: string) {
  const payload = { kind: 'update', nodeId, description };
  return {
    origin: 'local-user' as const,
    changeSetHash: canonicalSha256(payload),
    diffHash: canonicalSha256({ ...payload, kind: 'diff' }),
    summary: `Updated ${nodeId}.`,
    execute: (core: Parameters<Parameters<OutlineRuntimeWorkspace['mutate']>[0]['execute']>[0]) => {
      core.updateNodeDescription(nodeId, description);
    },
  };
}

function textPatchRequest(nodeId: string, text: string) {
  const payload = { kind: 'text-patch', nodeId, text };
  return {
    origin: 'local-user' as const,
    changeSetHash: canonicalSha256(payload),
    diffHash: canonicalSha256({ ...payload, kind: 'diff' }),
    summary: `Edited ${nodeId}.`,
    execute: (core: Parameters<Parameters<OutlineRuntimeWorkspace['mutate']>[0]['execute']>[0]) => {
      core.applyNodeTextPatch(nodeId, {
        ops: [{ type: 'replace_all', content: { text, marks: [], inlineRefs: [] } }],
      });
    },
  };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-outline-runtime-workspace-'));
  roots.push(root);
  return root;
}
type WorkspaceOpenOptions = NonNullable<Parameters<typeof OutlineRuntimeWorkspace.open>[1]>;

function openWorkspace(
  root: string,
  options: WorkspaceOpenOptions = {},
): Promise<OutlineRuntimeWorkspace> {
  return OutlineRuntimeWorkspace.open(root, {
    ...options,
    contentRoot: options.contentRoot ?? path.join(root, 'content'),
  });
}

interface ScheduledTask {
  readonly callback: () => void;
  readonly due: number;
  canceled: boolean;
}

class TestClock {
  nowValue = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, ScheduledTask>();

  schedule = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId++;
    this.tasks.set(id, { callback, due: this.nowValue + delayMs, canceled: false });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  cancel = (timer: ReturnType<typeof setTimeout>): void => {
    const task = this.tasks.get(timer as unknown as number);
    if (task) task.canceled = true;
  };

  async advance(ms: number): Promise<void> {
    this.nowValue += ms;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => !task.canceled && task.due <= this.nowValue)
        .sort(([, left], [, right]) => left.due - right.due)[0];
      if (!next) return;
      this.tasks.delete(next[0]);
      next[1].callback();
      await Promise.resolve();
    }
  }
}
