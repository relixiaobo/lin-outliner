import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core } from '../../src/core/core';
import {
  WorkspacePersistenceStore,
  type WorkspacePersistenceStoreOptions,
} from '../../src/main/workspacePersistenceStore';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('WorkspacePersistenceStore', () => {
  test('round-trips incremental updates and local history metadata', async () => {
    const root = await makeRoot();
    const store = new WorkspacePersistenceStore(root);
    const core = Core.new({ installationId: crypto.randomUUID() });
    const snapshot = core.serializeState();
    await store.compact(snapshot);
    const baseVersion = core.replicationVersionVector();

    core.createNode(core.projection().todayId, null, 'Incremental row');
    const capture = core.capturePersistenceUpdate(baseVersion, 0);
    const logBytes = await store.append(capture);
    expect(logBytes).toBe((await readFile(store.updateLogPath)).byteLength);

    const loaded = await store.load();
    expect(loaded.replay).toHaveLength(1);
    const restored = Core.fromPersistenceState(loaded.snapshot!, loaded.replay, {
      installationId: core.persistenceIdentity().installationId,
    });
    expect(restored.state()).toEqual(core.state());
    expect(restored.persistenceIdentity().replicaId).toBe(core.persistenceIdentity().replicaId);
  });

  test('appends again after a prior update grows the log beyond the header read limit', async () => {
    const root = await makeRoot();
    const store = new WorkspacePersistenceStore(root);
    const core = Core.new({ installationId: crypto.randomUUID() });
    await store.compact(core.serializeState());
    const baseVersion = core.replicationVersionVector();
    for (let index = 0; index < 450; index += 1) {
      core.createNode(core.projection().todayId, null, `Large update row ${index}`);
    }
    await store.append(core.capturePersistenceUpdate(baseVersion, 0));
    expect((await readFile(store.updateLogPath)).byteLength).toBeGreaterThan(64 * 1024);

    const nextVersion = core.replicationVersionVector();
    const metadataSequence = core.persistenceMetadataSequence();
    core.createNode(core.projection().todayId, null, 'Update after large record');
    await store.append(core.capturePersistenceUpdate(nextVersion, metadataSequence));

    expect((await store.load()).replay).toHaveLength(2);
  });

  test('retries a complete append idempotently after its fsync reports failure', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const initial = new WorkspacePersistenceStore(root);
    await initial.compact(core.serializeState());
    const baseVersion = core.replicationVersionVector();
    core.createNode(core.projection().todayId, null, 'Ambiguous durable append');
    const capture = core.capturePersistenceUpdate(baseVersion, 0);
    const retrying = new WorkspacePersistenceStore(root, { fsync: failOnCall(1) });

    await expect(retrying.append(capture)).rejects.toThrow('injected fsync failure');
    const writtenBytes = (await readFile(retrying.updateLogPath)).byteLength;
    await expect(retrying.append(capture)).resolves.toBe(writtenBytes);

    const loaded = await new WorkspacePersistenceStore(root).load();
    expect(loaded.replay).toHaveLength(1);
    await expect(retrying.append({
      ...capture,
      update: new Uint8Array([1]),
    })).rejects.toThrow('Conflicting workspace update log retry');
  });

  test('repairs a complete header that lost only its trailing newline', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = new WorkspacePersistenceStore(root);
    await store.compact(core.serializeState());
    const header = await readFile(store.updateLogPath, 'utf8');
    await writeFile(store.updateLogPath, header.slice(0, -1));

    core.createNode(core.projection().todayId, null, 'Header tail recovery');
    await expect(store.append(core.capturePersistenceUpdate(core.loadedPersistenceVersion(), 0))).resolves.toBeGreaterThan(0);
    expect((await store.load()).replay).toHaveLength(1);
  });

  test('fails closed on a non-empty update log without a header', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = new WorkspacePersistenceStore(root);
    await store.compact(core.serializeState());
    await writeFile(store.updateLogPath, '\n');

    core.createNode(core.projection().todayId, null, 'Reject blank log');
    await expect(store.append(core.capturePersistenceUpdate(core.loadedPersistenceVersion(), 0)))
      .rejects.toThrow('missing header');
  });

  test('fails closed on a whitespace-only update log during load', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = new WorkspacePersistenceStore(root);
    await store.compact(core.serializeState());
    await writeFile(store.updateLogPath, ' \n');

    await expect(store.load()).rejects.toThrow('Invalid workspace update log');
  });

  test('fails closed on an empty update log during load', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = new WorkspacePersistenceStore(root);
    await store.compact(core.serializeState());
    await writeFile(store.updateLogPath, '');

    await expect(store.load()).rejects.toThrow('Invalid workspace update log');
  });

  test('rejects a first append from a different replica identity', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = new WorkspacePersistenceStore(root);
    await store.compact(core.serializeState());
    core.createNode(core.projection().todayId, null, 'Identity boundary');
    const capture = core.capturePersistenceUpdate(core.loadedPersistenceVersion(), 0);

    await expect(store.append({
      ...capture,
      local: { ...capture.local, replicaId: crypto.randomUUID() },
    })).rejects.toThrow('replica identity mismatch');
  });

  test('rejects an append that does not extend the snapshot revision baseline', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = new WorkspacePersistenceStore(root);
    await store.compact(core.serializeState());

    await expect(store.append(core.capturePersistenceUpdate(core.loadedPersistenceVersion(), 0)))
      .rejects.toThrow('does not extend snapshot baseline');
  });

  test('accepts a complete final record without a trailing newline', async () => {
    const root = await makeRoot();
    const store = new WorkspacePersistenceStore(root);
    const core = Core.new({ installationId: crypto.randomUUID() });
    await store.compact(core.serializeState());
    const baseVersion = core.replicationVersionVector();
    core.createNode(core.projection().todayId, null, 'Complete tail');
    const capture = core.capturePersistenceUpdate(baseVersion, 0);
    await store.append(capture);
    const raw = await readFile(store.updateLogPath, 'utf8');
    await writeFile(store.updateLogPath, raw.slice(0, -1));

    expect((await store.load()).replay).toHaveLength(1);
  });

  test('rejects a complete but invalid final record without a trailing newline', async () => {
    const root = await makeRoot();
    const store = new WorkspacePersistenceStore(root);
    const core = Core.new({ installationId: crypto.randomUUID() });
    await store.compact(core.serializeState());
    const raw = await readFile(store.updateLogPath, 'utf8');
    await writeFile(store.updateLogPath, `${raw}{"kind":"wrong"}`);

    await expect(store.load()).rejects.toThrow('Invalid workspace update log record');
  });

  test('rejects malformed base64 and operation-history metadata in intact records', async () => {
    const root = await makeRoot();
    const store = new WorkspacePersistenceStore(root);
    const core = Core.new({ installationId: crypto.randomUUID() });
    await store.compact(core.serializeState());
    const baseVersion = core.replicationVersionVector();
    core.createNode(core.projection().todayId, null, 'Corrupt payload');
    await store.append(core.capturePersistenceUpdate(baseVersion, 0));
    const raw = await readFile(store.updateLogPath, 'utf8');
    const lines = raw.trimEnd().split('\n');
    const record = JSON.parse(lines[1]!) as {
      update: string;
      local: { operationHistoryUpserts: unknown[] };
    };
    record.update = 'not-base64';
    await writeFile(store.updateLogPath, `${lines[0]}\n${JSON.stringify(record)}\n`);
    await expect(store.load()).rejects.toThrow('Invalid workspace update log record');

    record.update = JSON.parse(lines[1]!).update;
    record.local.operationHistoryUpserts = [{}];
    await writeFile(store.updateLogPath, `${lines[0]}\n${JSON.stringify(record)}\n`);
    await expect(store.load()).rejects.toThrow('Invalid workspace update log record');
  });

  test('discards a torn final record but rejects corruption in the middle', async () => {
    const root = await makeRoot();
    const store = new WorkspacePersistenceStore(root);
    const core = Core.new({ installationId: crypto.randomUUID() });
    await store.compact(core.serializeState());
    const baseVersion = core.replicationVersionVector();
    core.createNode(core.projection().todayId, null, 'First row');
    await store.append(core.capturePersistenceUpdate(baseVersion, 0));
    const afterFirst = core.replicationVersionVector();
    core.createNode(core.projection().todayId, null, 'Second row');
    await store.append(core.capturePersistenceUpdate(afterFirst, 1));

    const raw = await readFile(store.updateLogPath, 'utf8');
    const lines = raw.split('\n');
    lines[1] = '{"kind":"update","broken"';
    await writeFile(store.updateLogPath, `${lines.join('\n')}`);
    await expect(store.load()).rejects.toThrow('Invalid workspace update log record');

    const repaired = `${raw.slice(0, raw.lastIndexOf('\n', raw.length - 2) + 1)}{"kind":"update","broken"`;
    await writeFile(store.updateLogPath, repaired);
    const loaded = await store.load();
    expect(loaded.replay).toHaveLength(1);
  });

  test('treats a stale log header as already absorbed by a newer snapshot', async () => {
    const root = await makeRoot();
    const store = new WorkspacePersistenceStore(root);
    const core = Core.new({ installationId: crypto.randomUUID() });
    await store.compact(core.serializeState());
    const baseVersion = core.replicationVersionVector();
    core.createNode(core.projection().todayId, null, 'Compacted row');
    await store.append(core.capturePersistenceUpdate(baseVersion, 0));
    const compacted = core.serializeState();
    await store.compact(compacted);

    const stale = JSON.stringify({
      kind: 'tenon-workspace-update-log',
      schemaVersion: 1,
      snapshotDigest: '0'.repeat(64),
    });
    await writeFile(store.updateLogPath, `${stale}\n`);
    expect((await store.load()).replay).toEqual([]);
  });

  test('rejects a stale log whose records are newer than the snapshot', async () => {
    const root = await makeRoot();
    const store = new WorkspacePersistenceStore(root);
    const core = Core.new({ installationId: crypto.randomUUID() });
    const originalSnapshot = core.serializeState();
    await store.compact(originalSnapshot);
    const baseVersion = core.replicationVersionVector();
    core.createNode(core.projection().todayId, null, 'Unabsorbed row');
    await store.append(core.capturePersistenceUpdate(baseVersion, 0));
    const raw = await readFile(store.updateLogPath, 'utf8');
    const lines = raw.trimEnd().split('\n');
    const header = JSON.parse(lines[0]!) as { snapshotDigest: string };
    header.snapshotDigest = '0'.repeat(64);
    await writeFile(store.updateLogPath, `${JSON.stringify(header)}\n${lines.slice(1).join('\n')}\n`);

    await expect(new WorkspacePersistenceStore(root).load())
      .rejects.toThrow('not absorbed by snapshot');
  });

  test('rejects a stale log whose version is not contained by the snapshot', async () => {
    const root = await makeRoot();
    const store = new WorkspacePersistenceStore(root);
    const core = Core.new({ installationId: crypto.randomUUID() });
    await store.compact(core.serializeState());
    const baseVersion = core.replicationVersionVector();
    core.createNode(core.projection().todayId, null, 'Version not absorbed');
    await store.append(core.capturePersistenceUpdate(baseVersion, 0));
    const raw = await readFile(store.updateLogPath, 'utf8');
    const lines = raw.trimEnd().split('\n');
    const header = JSON.parse(lines[0]!) as { snapshotDigest: string };
    const record = JSON.parse(lines[1]!) as { persistenceRevision: number; metadataSequence: number };
    header.snapshotDigest = '0'.repeat(64);
    record.persistenceRevision = 0;
    record.metadataSequence = 0;
    await writeFile(store.updateLogPath, `${JSON.stringify(header)}\n${JSON.stringify(record)}\n`);

    await expect(new WorkspacePersistenceStore(root).load())
      .rejects.toThrow('version is not absorbed by snapshot');
  });

  test('rejects a replay entry whose recorded version is not reached by its update', async () => {
    const root = await makeRoot();
    const store = new WorkspacePersistenceStore(root);
    const core = Core.new({ installationId: crypto.randomUUID() });
    await store.compact(core.serializeState());
    const baseVersion = core.replicationVersionVector();
    core.createNode(core.projection().todayId, null, 'Version mismatch');
    await store.append(core.capturePersistenceUpdate(baseVersion, 0));
    const raw = await readFile(store.updateLogPath, 'utf8');
    const lines = raw.trimEnd().split('\n');
    const record = JSON.parse(lines[1]!) as { version: string };
    record.version = Buffer.from(baseVersion).toString('base64');
    await writeFile(store.updateLogPath, `${lines[0]}\n${JSON.stringify(record)}\n`);

    const loaded = await store.load();
    expect(() => Core.fromPersistenceState(loaded.snapshot!, loaded.replay, {
      installationId: core.persistenceIdentity().installationId,
    })).toThrow('workspace persistence replay version mismatch');
  });

  test('rejects non-monotonic records and replica identity mismatches', async () => {
    const root = await makeRoot();
    const store = new WorkspacePersistenceStore(root);
    const core = Core.new({ installationId: crypto.randomUUID() });
    await store.compact(core.serializeState());
    const baseVersion = core.replicationVersionVector();
    core.createNode(core.projection().todayId, null, 'Identity row');
    await store.append(core.capturePersistenceUpdate(baseVersion, 0));
    const nextVersion = core.replicationVersionVector();
    core.createNode(core.projection().todayId, null, 'Identity row 2');
    await store.append(core.capturePersistenceUpdate(nextVersion, 1));
    const raw = await readFile(store.updateLogPath, 'utf8');
    const lines = raw.trimEnd().split('\n');
    const record = JSON.parse(lines[2]!) as Record<string, unknown>;
    record.persistenceRevision = 0;
    await writeFile(store.updateLogPath, `${lines[0]}\n${lines[1]}\n${JSON.stringify(record)}\n`);
    await expect(store.load()).rejects.toThrow('Non-monotonic');

    record.local = {
      ...(record.local as object),
      replicaId: crypto.randomUUID(),
    };
    record.persistenceRevision = 3;
    await writeFile(store.updateLogPath, `${lines[0]}\n${lines[1]}\n${JSON.stringify(record)}\n`);
    await expect(store.load()).rejects.toThrow('replica identity mismatch');
  });

  test('rejects persistence revisions and metadata sequences that move backward from the snapshot baseline', async () => {
    const root = await makeRoot();
    const store = new WorkspacePersistenceStore(root);
    const core = Core.new({ installationId: crypto.randomUUID() });
    await store.compact(core.serializeState());
    const baseVersion = core.replicationVersionVector();
    core.createNode(core.projection().todayId, null, 'Baseline ordering');
    const capture = core.capturePersistenceUpdate(baseVersion, 0);
    await expect(store.append({
      ...capture,
      persistenceRevision: Math.max(0, core.persistenceRevision() - 2),
      metadataSequence: Math.max(0, core.persistenceMetadataSequence() - 2),
    })).rejects.toThrow('does not extend snapshot baseline');
  });

  test('recovers when compaction fails before replacing the snapshot', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const initial = core.serializeState();
    const store = new WorkspacePersistenceStore(root);
    await store.compact(initial);

    core.createNode(core.projection().todayId, null, 'Before snapshot rename');
    const capture = core.capturePersistenceUpdate(core.loadedPersistenceVersion(), 0);
    await store.append(capture);
    const fsync = failOnCall(1);
    const failing = new WorkspacePersistenceStore(root, { fsync });
    await failing.load();
    await expect(failing.compact(core.serializeState())).rejects.toThrow('injected fsync failure');

    const loaded = await new WorkspacePersistenceStore(root).load();
    expect(loaded.snapshotRaw).toBe(initial);
    expect(loaded.replay).toHaveLength(1);
  });

  test('recovers when compaction fails after replacing the snapshot', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = new WorkspacePersistenceStore(root);
    await store.compact(core.serializeState());
    const baseVersion = core.replicationVersionVector();
    core.createNode(core.projection().todayId, null, 'After snapshot rename');
    await store.append(core.capturePersistenceUpdate(baseVersion, 0));
    const compacted = core.serializeState();
    const failing = new WorkspacePersistenceStore(root, {
      afterSnapshotRename: () => { throw new Error('injected post-rename crash'); },
    });
    await failing.load();
    await expect(failing.compact(compacted)).rejects.toThrow('injected post-rename crash');

    const loaded = await new WorkspacePersistenceStore(root).load();
    expect(loaded.snapshotRaw).toBe(compacted);
    expect(loaded.replay).toEqual([]);
  });

  test('recovers when compaction fails while resetting the update log', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = new WorkspacePersistenceStore(root);
    await store.compact(core.serializeState());
    const baseVersion = core.replicationVersionVector();
    core.createNode(core.projection().todayId, null, 'Before log reset');
    await store.append(core.capturePersistenceUpdate(baseVersion, 0));
    const compacted = core.serializeState();
    const failing = new WorkspacePersistenceStore(root, { fsync: failOnCall(3) });
    await failing.load();
    await expect(failing.compact(compacted)).rejects.toThrow('injected fsync failure');

    const loaded = await new WorkspacePersistenceStore(root).load();
    expect(loaded.snapshotRaw).toBe(compacted);
    expect(loaded.replay).toEqual([]);
  });
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-workspace-persistence-'));
  roots.push(root);
  return root;
}

function failOnCall(target: number): NonNullable<WorkspacePersistenceStoreOptions['fsync']> {
  let calls = 0;
  return async (handle) => {
    calls += 1;
    if (calls === target) throw new Error('injected fsync failure');
    await handle.sync();
  };
}
