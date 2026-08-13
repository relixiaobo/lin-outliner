import { afterEach, describe, expect, test } from 'bun:test';
import { copyFile, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core } from '../../src/core/core';
import {
  WorkspacePersistenceResnapshotRequiredError,
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

  test('requires a full resnapshot when the active log inode is replaced at the same size', async () => {
    const root = await makeRoot();
    const store = new WorkspacePersistenceStore(root);
    const core = Core.new({ installationId: crypto.randomUUID() });
    await store.compact(core.serializeState());
    const replacementPath = `${store.updateLogPath}.replacement`;
    await copyFile(store.updateLogPath, replacementPath);
    await rename(replacementPath, store.updateLogPath);

    core.createNode(core.projection().todayId, null, 'Replacement frontier');
    await expect(store.append(core.capturePersistenceUpdate(core.loadedPersistenceVersion(), 0)))
      .rejects.toBeInstanceOf(WorkspacePersistenceResnapshotRequiredError);
  });

  test('does not acknowledge an append when the log is replaced during fsync', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const initial = new WorkspacePersistenceStore(root);
    await initial.compact(core.serializeState());
    const racing = new WorkspacePersistenceStore(root, {
      fsync: async (handle) => {
        const replacementPath = `${racing.updateLogPath}.replacement`;
        await copyFile(racing.updateLogPath, replacementPath);
        await rename(replacementPath, racing.updateLogPath);
        await handle.sync();
      },
    });
    await racing.load();
    core.createNode(core.projection().todayId, null, 'Fsync replacement frontier');

    await expect(racing.append(core.capturePersistenceUpdate(core.loadedPersistenceVersion(), 0)))
      .rejects.toBeInstanceOf(WorkspacePersistenceResnapshotRequiredError);
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
    const restarted = new WorkspacePersistenceStore(root);
    await expect(restarted.append(core.capturePersistenceUpdate(core.loadedPersistenceVersion(), 0)))
      .resolves.toBeGreaterThan(0);
    expect((await restarted.load()).replay).toHaveLength(1);
  });

  test('quarantines a headerless log before appending a new update', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = new WorkspacePersistenceStore(root);
    await store.compact(core.serializeState());
    await writeFile(store.updateLogPath, '\n');

    core.createNode(core.projection().todayId, null, 'Recover blank log');
    const restarted = new WorkspacePersistenceStore(root);
    await expect(restarted.append(core.capturePersistenceUpdate(core.loadedPersistenceVersion(), 0)))
      .resolves.toBeGreaterThan(0);

    expect(await unreadableLogs(root)).toHaveLength(1);
    expect((await new WorkspacePersistenceStore(root).load()).replay).toHaveLength(1);
  });

  test('opens the snapshot and quarantines a whitespace-only update log', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = new WorkspacePersistenceStore(root);
    await store.compact(core.serializeState());
    await writeFile(store.updateLogPath, ' \n');

    const loaded = await store.load();
    expect(loaded.snapshot).not.toBeNull();
    expect(loaded.replay).toEqual([]);
    expect(loaded.recovery?.quarantinedLogPath).toContain('.unreadable-');
    expect(await unreadableLogs(root)).toHaveLength(1);
  });

  test('opens the snapshot and quarantines an empty update log', async () => {
    const root = await makeRoot();
    const core = Core.new({ installationId: crypto.randomUUID() });
    const store = new WorkspacePersistenceStore(root);
    await store.compact(core.serializeState());
    await writeFile(store.updateLogPath, '');

    const loaded = await store.load();
    expect(loaded.snapshot).not.toBeNull();
    expect(loaded.replay).toEqual([]);
    expect(loaded.recovery).toBeDefined();
    expect(await unreadableLogs(root)).toHaveLength(1);
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

  test('quarantines a complete but invalid final record without a trailing newline', async () => {
    const root = await makeRoot();
    const store = new WorkspacePersistenceStore(root);
    const core = Core.new({ installationId: crypto.randomUUID() });
    await store.compact(core.serializeState());
    const raw = await readFile(store.updateLogPath, 'utf8');
    await writeFile(store.updateLogPath, `${raw}{"kind":"wrong"}`);

    const loaded = await store.load();
    expect(loaded.snapshot).not.toBeNull();
    expect(loaded.replay).toEqual([]);
    expect(loaded.recovery).toBeDefined();
    expect(await unreadableLogs(root)).toHaveLength(1);
  });

  test('quarantines malformed base64 and operation-history metadata before replay', async () => {
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
    const malformedBase64 = await store.load();
    expect(malformedBase64.replay).toEqual([]);
    expect(malformedBase64.recovery).toBeDefined();

    record.update = JSON.parse(lines[1]!).update;
    record.local.operationHistoryUpserts = [{}];
    await writeFile(store.updateLogPath, `${lines[0]}\n${JSON.stringify(record)}\n`);
    const malformedHistory = await store.load();
    expect(malformedHistory.replay).toEqual([]);
    expect(malformedHistory.recovery).toBeDefined();
    expect(await unreadableLogs(root)).toHaveLength(2);
  });

  test('preserves a verified prefix while quarantining corruption after it', async () => {
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
    lines[2] = '{"kind":"update","broken"';
    await writeFile(store.updateLogPath, `${lines.join('\n')}`);
    const corrupted = await store.load();
    expect(corrupted.replay).toHaveLength(1);
    expect(corrupted.recovery).toBeDefined();
    const restored = Core.fromPersistenceState(corrupted.snapshot!, corrupted.replay, {
      installationId: core.persistenceIdentity().installationId,
    });
    expect(restored.projection().nodes.some((node) => node.content.text === 'First row')).toBe(true);
    expect(restored.projection().nodes.some((node) => node.content.text === 'Second row')).toBe(false);
    expect(await unreadableLogs(root)).toHaveLength(1);

    const repaired = `${raw.slice(0, raw.lastIndexOf('\n', raw.length - 2) + 1)}{"kind":"update","broken"`;
    await writeFile(store.updateLogPath, repaired);
    const loaded = await store.load();
    expect(loaded.replay).toHaveLength(1);
    expect(loaded.recovery).toBeUndefined();
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

  test('quarantines a stale log whose records are newer than the snapshot', async () => {
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

    const loaded = await new WorkspacePersistenceStore(root).load();
    expect(loaded.replay).toEqual([]);
    expect(loaded.recovery).toBeDefined();
    expect(await unreadableLogs(root)).toHaveLength(1);
  });

  test('quarantines a stale log whose version is not contained by the snapshot', async () => {
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

    const loaded = await new WorkspacePersistenceStore(root).load();
    expect(loaded.replay).toEqual([]);
    expect(loaded.recovery).toBeDefined();
    expect(await unreadableLogs(root)).toHaveLength(1);
  });

  test('quarantines a replay entry whose recorded version is not reached by its update', async () => {
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
    expect(loaded.replay).toEqual([]);
    expect(loaded.recovery).toBeDefined();
    expect(await unreadableLogs(root)).toHaveLength(1);
  });

  test('keeps the valid prefix before non-monotonic and identity-mismatched records', async () => {
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
    const nonMonotonic = await store.load();
    expect(nonMonotonic.replay).toHaveLength(1);
    expect(nonMonotonic.recovery).toBeDefined();

    record.local = {
      ...(record.local as object),
      replicaId: crypto.randomUUID(),
    };
    record.persistenceRevision = 3;
    await writeFile(store.updateLogPath, `${lines[0]}\n${lines[1]}\n${JSON.stringify(record)}\n`);
    const identityMismatch = await store.load();
    expect(identityMismatch.replay).toHaveLength(1);
    expect(identityMismatch.recovery).toBeDefined();
    expect(await unreadableLogs(root)).toHaveLength(2);
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

async function unreadableLogs(root: string): Promise<string[]> {
  return (await readdir(root)).filter((entry) => entry.startsWith('workspace.loro.updates.jsonl.unreadable-'));
}

function failOnCall(target: number): NonNullable<WorkspacePersistenceStoreOptions['fsync']> {
  let calls = 0;
  return async (handle) => {
    calls += 1;
    if (calls === target) throw new Error('injected fsync failure');
    await handle.sync();
  };
}
