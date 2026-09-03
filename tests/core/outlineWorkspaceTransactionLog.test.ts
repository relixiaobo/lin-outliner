import { afterAll, describe, expect, test } from 'bun:test';
import { appendFile, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CorePersistenceCapture, CoreTransactionPatch } from '../../src/core/core';
import { Core } from '../../src/core/core';
import { canonicalSha256 } from '../../src/outline/contract/canonical';
import { OutlineContractError } from '../../src/outline/contract/errors';
import type { Operation, OutlineEvent } from '../../src/outline/contract/schemas';
import { OUTLINE_PROTOCOL_VERSION, OUTLINE_STORAGE_VERSION } from '../../src/outline/contract/version';
import {
  createOutlineRecoveryPatch,
  WorkspaceTransactionLog,
  type OutlineAssetStage,
  type OutlineRecoveryPatch,
  type WorkspaceTransactionBatchInput,
  type WorkspaceTransactionInput,
} from '../../src/outline/runtime/storage';

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('WorkspaceTransactionLog', () => {
  test('rejects the superseded workspace format instead of reading or migrating it', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = await initializedStore(root, core);
    const snapshot = JSON.parse(await readFile(store.snapshotPath, 'utf8')) as Record<string, unknown>;
    const { checksum: _checksum, ...body } = snapshot;
    const superseded = { ...body, storageVersion: OUTLINE_STORAGE_VERSION - 1 };
    await writeFile(store.snapshotPath, JSON.stringify({
      ...superseded,
      checksum: canonicalSha256(superseded),
    }));

    await expect(new WorkspaceTransactionLog(root).load())
      .rejects.toThrow('Invalid outline workspace snapshot');
  });

  test('atomically replays document update Operation idempotency Event and recovery after restart', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = await initializedStore(root, core);
    const transaction = await createTransaction(core, 1, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Durable row');
    });

    const result = await store.append(transaction);
    expect(result.idempotent).toBe(false);
    const restarted = new WorkspaceTransactionLog(root);
    const loaded = await restarted.load();
    expect(loaded.inconsistent).toBeUndefined();
    expect(loaded.operations).toEqual([transaction.operation]);
    expect(loaded.events).toEqual([transaction.event]);
    const restored = Core.fromPersistenceState(loaded.snapshot!, loaded.replay, {
      installationId: core.persistenceIdentity().installationId,
    });
    expect(restored.state()).toEqual(core.state());
    expect(await restarted.recoveryPatch(transaction.operation.operationId)).toEqual(transaction.recoveryPatch);
  });

  test('rejects a transaction from a different workspace replica identity', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = await initializedStore(root, core);
    const transaction = await createTransaction(core, 1, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Foreign replica row');
    });

    await expect(store.append({
      ...transaction,
      persistence: {
        ...transaction.persistence,
        local: {
          ...transaction.persistence.local,
          replicaId: crypto.randomUUID(),
        },
      },
    })).rejects.toThrow('workspace replica identity changed');

    expect((await store.load()).operations).toEqual([]);
  });

  test('rejects persistence coordinates that do not extend the replay baseline', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = await initializedStore(root, core);
    const snapshot = JSON.parse(await readFile(store.snapshotPath, 'utf8')) as {
      document: { persistenceRevision: number };
    };
    const first = await createTransaction(core, 1, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Baseline row');
    });
    await expect(store.append({
      ...first,
      persistence: {
        ...first.persistence,
        persistenceRevision: snapshot.document.persistenceRevision,
      },
    })).rejects.toThrow('persistence ordering is not monotonic');
    await store.append(first);

    const second = await createTransaction(core, 2, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Backward metadata row');
    });
    await expect(store.append({
      ...second,
      persistence: {
        ...second.persistence,
        metadataSequence: Math.max(0, first.persistence.metadataSequence - 1),
      },
    })).rejects.toThrow('persistence ordering is not monotonic');
  });

  test('rejects malformed persistence bytes during replay and operation history before append', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = await initializedStore(root, core);
    const transaction = await createTransaction(core, 1, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Malformed persistence row');
    });

    await expect(store.append({
      ...transaction,
      persistence: {
        ...transaction.persistence,
        local: {
          ...transaction.persistence.local,
          operationHistoryUpserts: [{} as never],
        },
      },
    })).rejects.toThrow('Invalid encoded Core persistence capture');
    await store.append(transaction);
    const lines = (await readFile(store.transactionLogPath, 'utf8')).trimEnd().split('\n');
    const record = JSON.parse(lines[1]!) as Record<string, unknown>;
    (record.persistence as Record<string, unknown>).update = '***';
    const { checksum: _checksum, ...body } = record;
    record.checksum = canonicalSha256(body);
    await writeFile(store.transactionLogPath, `${lines[0]}\n${JSON.stringify(record)}\n`);

    const loaded = await new WorkspaceTransactionLog(root).load();
    expect(loaded.inconsistent?.message).toContain('Invalid encoded Core persistence capture');
    expect(loaded.operations).toEqual([]);
  });

  test('fails reconstruction when a replay update does not reach its declared Loro version', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = await initializedStore(root, core);
    const staleVersion = core.replicationVersionVector();
    const transaction = await createTransaction(core, 1, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Version mismatch row');
    });
    await store.append(transaction);
    const lines = (await readFile(store.transactionLogPath, 'utf8')).trimEnd().split('\n');
    const record = JSON.parse(lines[1]!) as Record<string, unknown>;
    (record.persistence as Record<string, unknown>).version = Buffer.from(staleVersion).toString('base64');
    const { checksum: _checksum, ...body } = record;
    record.checksum = canonicalSha256(body);
    await writeFile(store.transactionLogPath, `${lines[0]}\n${JSON.stringify(record)}\n`);

    const loaded = await new WorkspaceTransactionLog(root).load();
    expect(loaded.inconsistent).toBeUndefined();
    expect(() => Core.fromPersistenceState(loaded.snapshot!, loaded.replay, {
      installationId: core.persistenceIdentity().installationId,
    })).toThrow('workspace persistence replay version mismatch');
  });

  test('resolves a crash after log fsync and before acknowledgement through the idempotency key', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    let injected = false;
    const store = await initializedStore(root, core, {
      afterTransactionFsync: () => {
        if (!injected) {
          injected = true;
          throw new Error('injected crash after fsync');
        }
      },
    });
    const transaction = await createTransaction(core, 1, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Unknown acknowledgement');
    });

    await expect(store.append(transaction)).rejects.toThrow('injected crash after fsync');
    const restarted = new WorkspaceTransactionLog(root);
    const loaded = await restarted.load();
    expect(loaded.operations).toHaveLength(1);
    const retry = await restarted.append(transaction);
    expect(retry.idempotent).toBe(true);
    expect(retry.operation).toEqual(transaction.operation);

    await expect(restarted.append({
      ...transaction,
      idempotency: { ...transaction.idempotency!, payloadHash: 'f'.repeat(64) },
    })).rejects.toMatchObject({
      outlineError: { code: 'idempotency_conflict' },
    });
  });

  test('appends a transaction batch with one fsync and replays every record after restart', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    let fsyncCount = 0;
    const store = await initializedStore(root, core, {
      fsync: async (handle) => {
        await handle.sync();
        fsyncCount += 1;
      },
    });
    const first = await createTransaction(core, 1, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'First batched row');
    });
    const second = await createTransaction(core, 2, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Second batched row');
    });
    fsyncCount = 0;

    const results = await store.appendBatch([batchInput(first), batchInput(second)]);

    expect(fsyncCount).toBe(1);
    expect(results.map((result) => result.idempotent)).toEqual([false, false]);
    expect(results.map((result) => result.event.sequence)).toEqual([1, 2]);
    const restarted = new WorkspaceTransactionLog(root);
    const loaded = await restarted.load();
    expect(loaded.inconsistent).toBeUndefined();
    expect(loaded.operations).toEqual([first.operation, second.operation]);
    expect(loaded.events.map((event) => event.sequence)).toEqual([1, 2]);
    const restored = Core.fromPersistenceState(loaded.snapshot!, loaded.replay, {
      installationId: core.persistenceIdentity().installationId,
    });
    expect(restored.state()).toEqual(core.state());
  });

  test('rejects a load when the transaction log grows after its bytes are read', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const initialized = await initializedStore(root, core);
    const transaction = await createTransaction(core, 1, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Committed before concurrent growth');
    });
    await initialized.append(transaction);
    const restarted = new WorkspaceTransactionLog(root, {
      afterTransactionLogRead: () => appendFile(initialized.transactionLogPath, '{"concurrent":true}\n'),
    });

    await expect(restarted.load()).rejects.toThrow(
      'Outline transaction log changed while loading its verified prefix',
    );
  });

  test('rejects an append when the active transaction log inode was replaced at the same size', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = await initializedStore(root, core);
    const original = await readFile(store.transactionLogPath);
    const replacementPath = `${store.transactionLogPath}.replacement`;
    await writeFile(replacementPath, original);
    await rename(replacementPath, store.transactionLogPath);
    const transaction = await createTransaction(core, 1, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Rejected after replacement');
    });

    await expect(store.append(transaction)).rejects.toMatchObject({
      outlineError: { code: 'durability_failed', retryable: true },
    });

    const loaded = await new WorkspaceTransactionLog(root).load();
    expect(loaded.inconsistent).toBeUndefined();
    expect(loaded.operations).toEqual([]);
  });

  test('does not acknowledge an append when the log path is replaced during fsync', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const logPath = path.join(root, 'outline.transactions.jsonl');
    let replaceDuringFsync = false;
    let replacementBytes = Buffer.alloc(0);
    const store = await initializedStore(root, core, {
      fsync: async (handle) => {
        await handle.sync();
        if (!replaceDuringFsync) return;
        replaceDuringFsync = false;
        const replacementPath = `${logPath}.replacement`;
        await writeFile(replacementPath, replacementBytes);
        await rename(replacementPath, logPath);
      },
    });
    replacementBytes = await readFile(store.transactionLogPath);
    const transaction = await createTransaction(core, 1, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Unknown replacement settlement');
    });
    replaceDuringFsync = true;

    await expect(store.append(transaction)).rejects.toMatchObject({
      outlineError: { code: 'durability_failed', retryable: true },
    });

    const loaded = await new WorkspaceTransactionLog(root).load();
    expect(loaded.inconsistent).toBeUndefined();
    expect(loaded.operations).toEqual([]);
  });

  test('uses replayed record count and durable JSONL bytes for compaction thresholds', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = await initializedStore(root, core, { compactionRecords: 100 });
    const transaction = await createTransaction(core, 1, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Count the durable record envelope');
    });
    await store.append(transaction);

    const logBytes = (await stat(store.transactionLogPath)).size;
    expect(logBytes).toBeGreaterThan(transaction.persistence.update.byteLength);
    const replayCountStore = new WorkspaceTransactionLog(root, { compactionRecords: 1 });
    expect(await replayCountStore.needsCompaction()).toBe(true);

    const jsonlBytesStore = new WorkspaceTransactionLog(root, {
      compactionRecords: 100,
      compactionLogBytes: transaction.persistence.update.byteLength + 1,
    });
    expect(await jsonlBytesStore.needsCompaction()).toBe(true);
  });

  test('retries every record idempotently after a batched fsync acknowledgement failure', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    let failAcknowledgement = true;
    const store = await initializedStore(root, core, {
      afterTransactionFsync: () => {
        if (!failAcknowledgement) return;
        failAcknowledgement = false;
        throw new Error('injected batched acknowledgement failure');
      },
    });
    const first = await createTransaction(core, 1, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'First uncertain row');
    });
    const second = await createTransaction(core, 2, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Second uncertain row');
    });
    const batch = [batchInput(first), batchInput(second)];

    await expect(store.appendBatch(batch)).rejects.toThrow('injected batched acknowledgement failure');
    const retry = await store.appendBatch(batch);

    expect(retry.map((result) => result.idempotent)).toEqual([true, true]);
    expect(retry.map((result) => result.operation.operationId)).toEqual([
      first.operation.operationId,
      second.operation.operationId,
    ]);
    const loaded = await new WorkspaceTransactionLog(root).load();
    expect(loaded.inconsistent).toBeUndefined();
    expect(loaded.operations).toEqual([first.operation, second.operation]);
    expect(loaded.events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  test('keeps maintenance and Event sequences valid for mixed idempotent and new batch entries', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const now = new Date('2026-01-01T00:00:00.000Z');
    const store = await initializedStore(root, core, {
      minimumRetentionDays: 0,
      minimumRetentionOperations: 0,
      now: () => now,
    });
    const first = await createTransaction(core, 1, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Existing batch row');
    }, { createdAt: now.toISOString() });
    await store.appendBatch([batchInput(first)]);
    const second = await createTransaction(core, 2, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'New batch row');
    }, { createdAt: now.toISOString() });

    const mixed = await store.appendBatch([batchInput(first), batchInput(second)]);

    expect(mixed.map((result) => result.idempotent)).toEqual([true, false]);
    expect(mixed[1]?.event.sequence).toBe(3);
    expect(mixed[0]?.maintenanceEvents).toEqual([]);
    expect(mixed[1]?.maintenanceEvents).toEqual([expect.objectContaining({
      type: 'operation.recovery-expired',
      sequence: 2,
      revision: 1,
    })]);
    const loaded = await new WorkspaceTransactionLog(root).load();
    expect(loaded.inconsistent).toBeUndefined();
    expect(loaded.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(loaded.operations.map((operation) => operation.operationId)).toEqual([
      first.operation.operationId,
      second.operation.operationId,
    ]);

    const retry = await store.appendBatch([batchInput(first), batchInput(second)]);
    expect(retry.map((result) => result.idempotent)).toEqual([true, true]);
    expect((await store.load()).events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  test('reloads the asset-stage sequence after an uncertain fsync settlement', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    let failNextFsync = false;
    const store = await initializedStore(root, core, {
      fsync: async (handle) => {
        await handle.sync();
        if (failNextFsync) {
          failNextFsync = false;
          throw new Error('injected asset-stage fsync failure');
        }
      },
    });

    failNextFsync = true;
    await expect(store.stageAsset(assetStage('uncertain-stage'))).rejects.toMatchObject({
      outlineError: { code: 'durability_failed', retryable: true },
    });
    await store.stageAsset(assetStage('after-stage-reload'));

    const restarted = new WorkspaceTransactionLog(root);
    const loaded = await restarted.load();
    expect(loaded.inconsistent).toBeUndefined();
    expect((await restarted.assetRecords()).map((record) => record.metadata.originalFilename)).toEqual([
      'uncertain-stage.bin',
      'after-stage-reload.bin',
    ]);
  });

  test('reloads the asset-gc sequence after an uncertain fsync settlement', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    let failNextFsync = false;
    const store = await initializedStore(root, core, {
      fsync: async (handle) => {
        await handle.sync();
        if (failNextFsync) {
          failNextFsync = false;
          throw new Error('injected asset-gc fsync failure');
        }
      },
    });
    await store.stageAsset(assetStage('collected-before-reload'));

    failNextFsync = true;
    await expect(store.collectUnprotectedAssetRecords([], new Date('2031-01-01T00:00:00.000Z')))
      .rejects.toMatchObject({
        outlineError: { code: 'durability_failed', retryable: true },
      });
    expect(await store.collectUnprotectedAssetRecords([], new Date('2031-01-01T00:00:00.000Z'))).toEqual([]);
    await store.stageAsset(assetStage('after-gc-reload'));

    const restarted = new WorkspaceTransactionLog(root);
    const loaded = await restarted.load();
    expect(loaded.inconsistent).toBeUndefined();
    expect((await restarted.assetRecords()).map((record) => record.metadata.originalFilename))
      .toEqual(['after-gc-reload.bin']);
  });

  test('leaves an inert orphan when a recovery blob fsyncs before the transaction append', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = await initializedStore(root, core, {
      inlineRecoveryBytes: 0,
      afterRecoveryBlobFsync: () => { throw new Error('injected crash before log append'); },
    });
    const transaction = await createTransaction(core, 1, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Orphaned candidate');
    });

    await expect(store.append(transaction)).rejects.toThrow('injected crash before log append');
    const restarted = new WorkspaceTransactionLog(root, { inlineRecoveryBytes: 0 });
    const loaded = await restarted.load();
    expect(loaded.operations).toEqual([]);
    expect(loaded.replay).toEqual([]);
    expect(loaded.orphanRecoveryBlobs).toHaveLength(1);
    expect(await restarted.collectOrphanRecoveryBlobsNow()).toHaveLength(1);
    expect(await recoveryBlobNames(restarted)).toEqual([]);
  });

  test('discards an incomplete tail and truncates it before the next durable append', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = await initializedStore(root, core);
    const first = await createTransaction(core, 1, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'First');
    });
    await store.append(first);
    await appendFile(store.transactionLogPath, '{"kind":"outline.transaction"');

    const restarted = new WorkspaceTransactionLog(root);
    const torn = await restarted.load();
    expect(torn.tornTail).toBe(true);
    expect(torn.inconsistent).toBeUndefined();
    expect(torn.operations).toHaveLength(1);
    expect((await restarted.health()).transactionLog).toMatchObject({
      health: 'degraded',
      tornTail: true,
      maintenancePending: true,
    });
    await restarted.maintain({ instanceId: 'runtime:tail-repair', revision: 1 });
    expect((await restarted.health()).transactionLog).toMatchObject({
      health: 'healthy',
      tornTail: false,
      maintenancePending: false,
    });
    const second = await createTransaction(core, 2, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Second');
    });
    await restarted.append(second);

    const settled = await new WorkspaceTransactionLog(root).load();
    expect(settled.tornTail).toBe(false);
    expect(settled.operations.map((operation) => operation.operationId)).toEqual([
      first.operation.operationId,
      second.operation.operationId,
    ]);
  });

  test('keeps the verified prefix readable and blocks mutation after a complete-record checksum failure', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = await initializedStore(root, core);
    const first = await createTransaction(core, 1, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Verified prefix');
    });
    await store.append(first);
    const second = await createTransaction(core, 2, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Corrupt suffix');
    });
    await store.append(second);
    const lines = (await readFile(store.transactionLogPath, 'utf8')).trimEnd().split('\n');
    const corrupt = JSON.parse(lines[2]!) as Record<string, unknown>;
    corrupt.checksum = '0'.repeat(64);
    await writeFile(store.transactionLogPath, `${lines[0]}\n${lines[1]}\n${JSON.stringify(corrupt)}\n`);

    const restarted = new WorkspaceTransactionLog(root);
    const loaded = await restarted.load();
    expect(loaded.inconsistent).toBeDefined();
    expect((await restarted.health()).transactionLog).toMatchObject({
      health: 'blocked',
      inconsistent: true,
    });
    expect(loaded.operations.map((operation) => operation.operationId)).toEqual([first.operation.operationId]);
    const readable = Core.fromPersistenceState(loaded.snapshot!, loaded.replay, {
      installationId: core.persistenceIdentity().installationId,
    });
    expect(readable.projection().nodes.some((node) => node.content.text === 'Verified prefix')).toBe(true);
    expect(readable.projection().nodes.some((node) => node.content.text === 'Corrupt suffix')).toBe(false);
    await expect(restarted.append(second)).rejects.toMatchObject({
      outlineError: { code: 'recovery_inconsistent' },
    });
  });

  test('replays the committed document but blocks mutation when a referenced recovery blob is corrupt', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = await initializedStore(root, core, { inlineRecoveryBytes: 0 });
    const transaction = await createTransaction(core, 1, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Readable without recovery');
    });
    await store.append(transaction);
    const [blobName] = await recoveryBlobNames(store);
    await writeFile(path.join(store.recoveryDirectory, blobName!), '{"corrupt":true}');

    const restarted = new WorkspaceTransactionLog(root, { inlineRecoveryBytes: 0 });
    const loaded = await restarted.load();
    expect(loaded.inconsistent).toBeDefined();
    expect(loaded.replay).toHaveLength(1);
    const readable = Core.fromPersistenceState(loaded.snapshot!, loaded.replay, {
      installationId: core.persistenceIdentity().installationId,
    });
    expect(readable.projection().nodes.some((node) => node.content.text === 'Readable without recovery')).toBe(true);
    await expect(restarted.recoveryPatch(transaction.operation.operationId)).rejects.toThrow('checksum mismatch');
  });

  test('expires only recovery outside both retention floors before admitting more bytes', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const now = new Date('2026-01-01T00:00:00.000Z');
    const store = await initializedStore(root, core, {
      inlineRecoveryBytes: 0,
      minimumRetentionDays: 0,
      minimumRetentionOperations: 1,
      now: () => now,
    });
    const first = await createTransaction(core, 1, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'First retained');
    }, { createdAt: now.toISOString() });
    await store.append(first);
    const second = await createTransaction(core, 2, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Second retained');
    }, { createdAt: now.toISOString() });
    await store.append(second);
    const third = await createTransaction(core, 4, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Third retained');
    }, { createdAt: now.toISOString() });
    await store.append(third);

    expect((await store.operation(first.operation.operationId))?.recovery.state).toBe('expired');
    expect((await store.operation(second.operation.operationId))?.recovery.state).toBe('available');
    expect((await store.operation(third.operation.operationId))?.recovery.state).toBe('available');
    await expect(store.recoveryPatch(first.operation.operationId)).rejects.toMatchObject({
      outlineError: { code: 'recovery_expired' },
    });
    expect(await recoveryBlobNames(store)).toHaveLength(2);
    expect((await store.health()).recovery).toMatchObject({ available: 2, expired: 1 });
  });

  test('fails admission before append when every recovery patch is protected by the budget floor', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = await initializedStore(root, core, { recoveryBudgetBytes: 1 });
    const transaction = await createTransaction(core, 1, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Too large');
    });

    await expect(store.append(transaction)).rejects.toBeInstanceOf(OutlineContractError);
    await expect(store.append(transaction)).rejects.toMatchObject({
      outlineError: { code: 'recovery_capacity_exceeded' },
    });
    expect((await store.load()).operations).toEqual([]);
  });

  test('treats a snapshot rename before log reset as a complete compaction after restart', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    let snapshotRenames = 0;
    const store = await initializedStore(root, core, {
      afterSnapshotRename: () => {
        snapshotRenames += 1;
        if (snapshotRenames === 2) throw new Error('injected crash after snapshot rename');
      },
    });
    const transaction = await createTransaction(core, 1, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Compacted');
    });
    await store.append(transaction);

    await expect(store.compact(core.serializeState())).rejects.toThrow('injected crash after snapshot rename');
    const restarted = new WorkspaceTransactionLog(root);
    const loaded = await restarted.load();
    expect(loaded.inconsistent).toBeUndefined();
    expect(loaded.replay).toEqual([]);
    expect(loaded.operations).toEqual([transaction.operation]);
    expect(Core.fromState(loaded.snapshot!, {
      installationId: core.persistenceIdentity().installationId,
    }).state()).toEqual(core.state());
  });

  test('blocks a stale log whose complete records are newer than the snapshot', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = await initializedStore(root, core);
    const first = await createTransaction(core, 1, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'First compacted row');
    });
    await store.append(first);
    const second = await createTransaction(core, 2, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Second compacted row');
    });
    await store.append(second);
    const staleLines = (await readFile(store.transactionLogPath, 'utf8')).trimEnd().split('\n');
    await store.compact(core.serializeState());
    const third = await createTransaction(core, 3, (candidate) => {
      candidate.createNode(candidate.projection().todayId, null, 'Newer unabsorbed row');
    });
    await store.append(third);
    const currentLines = (await readFile(store.transactionLogPath, 'utf8')).trimEnd().split('\n');
    await writeFile(store.transactionLogPath, `${[
      ...staleLines,
      currentLines[1]!,
    ].join('\n')}\n`);

    const restarted = new WorkspaceTransactionLog(root);
    const loaded = await restarted.load();
    expect(loaded.inconsistent?.message).toContain('cannot be proven absorbed');
    expect(loaded.operations.map((operation) => operation.operationId)).toEqual([
      first.operation.operationId,
      second.operation.operationId,
    ]);
    await expect(restarted.append(third)).rejects.toMatchObject({
      outlineError: { code: 'recovery_inconsistent' },
    });
  });
});

interface TransactionOptions {
  readonly createdAt?: string;
}

async function createTransaction(
  core: Core,
  eventSequence: number,
  mutate: (core: Core) => void,
  options: TransactionOptions = {},
): Promise<WorkspaceTransactionInput> {
  const operationId = `operation:${crypto.randomUUID()}`;
  const changeSetHash = canonicalSha256({ operationId, kind: 'changeset' });
  const diffHash = canonicalSha256({ operationId, kind: 'diff' });
  const fromVersion = core.replicationVersionVector();
  const afterMetadataSequence = core.persistenceMetadataSequence();
  const { patch } = await core.transactionWithPatch('user', () => mutate(core), {
    operationId,
    command: 'outline_apply',
  });
  const persistence = core.capturePersistenceUpdate(fromVersion, afterMetadataSequence);
  const createdAt = options.createdAt ?? new Date().toISOString();
  const recoveryPatch = createOutlineRecoveryPatch({
    operationId,
    origin: 'local-user',
    changeSetHash,
    diffHash,
    corePatch: patch,
    createdAt,
    minimumRetentionDays: 0,
  });
  const affectedNodeIds = patch.nodes.map((entry) => entry.id);
  const operation: Operation = {
    protocolVersion: OUTLINE_PROTOCOL_VERSION,
    kind: 'outline.operation',
    operationId,
    intentHash: changeSetHash,
    changeSetHash,
    diffHash,
    origin: 'local-user',
    summary: 'Applied outline changes.',
    affectedNodeIds,
    affectedNodeCount: affectedNodeIds.length,
    affectedNodeIdsHash: canonicalSha256(affectedNodeIds),
    revisionBefore: patch.revisionBefore,
    revisionAfter: patch.revisionAfter,
    createdAt,
    recovery: {
      recoveryPatchId: recoveryPatch.recoveryPatchId,
      state: 'available',
      retainedUntilAtLeast: recoveryPatch.retainedUntilAtLeast,
    },
  };
  const event: OutlineEvent = {
    protocolVersion: OUTLINE_PROTOCOL_VERSION,
    kind: 'outline.event',
    type: 'operation.committed',
    instanceId: 'runtime:test',
    sequence: eventSequence,
    revision: operation.revisionAfter,
    cursor: `event:${eventSequence}`,
    operation,
  };
  return {
    persistence,
    operation,
    recoveryPatch,
    event,
    idempotency: {
      key: `idempotency:${operationId}`,
      payloadHash: changeSetHash,
      operationId,
    },
  };
}

function batchInput(transaction: WorkspaceTransactionInput): WorkspaceTransactionBatchInput {
  const { event, ...input } = transaction;
  return {
    ...input,
    createEvent: (sequence) => ({
      ...event,
      sequence,
      cursor: `event:${sequence}`,
    }),
  };
}

async function initializedStore(
  root: string,
  core: Core,
  options: ConstructorParameters<typeof WorkspaceTransactionLog>[1] = {},
): Promise<WorkspaceTransactionLog> {
  const store = new WorkspaceTransactionLog(root, options);
  await store.initialize(core.serializeState());
  return store;
}

function assetStage(name: string): OutlineAssetStage {
  const assetId = `asset:${crypto.randomUUID()}`;
  const metadata = {
    mimeType: 'application/octet-stream',
    byteSize: name.length,
    originalFilename: `${name}.bin`,
  };
  const exactRevision = { anchorId: `anchor:${crypto.randomUUID()}`, byteLength: name.length };
  return {
    record: {
      protocolVersion: OUTLINE_PROTOCOL_VERSION,
      kind: 'outline.asset',
      assetId,
      metadata,
      createdAt: '2030-01-01T00:00:00.000Z',
    },
    lease: {
      protocolVersion: OUTLINE_PROTOCOL_VERSION,
      leaseId: `lease:${crypto.randomUUID()}`,
      assetId,
      metadata,
      expiresAt: '2030-01-02T00:00:00.000Z',
    },
    exactRevision,
  };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-outline-transaction-log-'));
  roots.push(root);
  return root;
}

async function recoveryBlobNames(store: WorkspaceTransactionLog): Promise<string[]> {
  return (await readdir(store.recoveryDirectory).catch(() => []))
    .filter((entry) => entry.endsWith('.json'))
    .sort();
}
