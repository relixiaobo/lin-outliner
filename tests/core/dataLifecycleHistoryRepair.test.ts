import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { seedPopulatedDataFixture } from '../fixtures/dataLifecycle';
import { ThreadProjectionRebuilder } from '../../src/main/agent/recovery/ThreadProjectionRebuilder';
import { ThreadHistoryProjectionStore } from '../../src/main/agent/persistence/ThreadHistoryProjectionStore';
import { DataStoreRegistry } from '../../src/main/dataLifecycle/storeRegistry';
import { DataBackupStore } from '../../src/main/dataLifecycle/BackupStore';
import { DataOperationJournal, type DataOperation } from '../../src/main/dataLifecycle/OperationJournal';
import { HistoryRepairSession } from '../../src/main/dataLifecycle/HistoryRepairSession';
import { fingerprint } from '../../src/main/dataLifecycle/durableFiles';
import { openLifecycleDatabase } from '../../src/main/dataLifecycle/sqlite';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tenon-history-repair-')); roots.push(root);
  return { root, data: await seedPopulatedDataFixture(root), registry: new DataStoreRegistry() };
}

describe('verified derived history rebuild', () => {
  test('refuses a rebuild when a sibling Store is missing and preserves the original projection', async () => {
    const { root, registry } = await fixture();
    const before = await fingerprint(join(root, 'agent/thread_history.sqlite'));
    await rm(join(root, 'agent/goals.sqlite'));
    await expect(new ThreadProjectionRebuilder(root, registry).preview()).rejects.toThrow('agent-goals');
    expect(await fingerprint(join(root, 'agent/thread_history.sqlite'))).toEqual(before);
  });
  test('repairs corrupt projected items from complete events and resumes a lost installation receipt', async () => {
    const { root, data, registry } = await fixture();
    const path = join(root, 'agent/thread_history.sqlite');
    const database = openLifecycleDatabase(path, false);
    database.exec("UPDATE thread_items SET item_json = '{}'"); database.close();
    const before = await fingerprint(path);
    const rebuilder = new ThreadProjectionRebuilder(root, registry);
    const preview = await rebuilder.preview(); expect(preview.threads).toBe(1);
    const operation: DataOperation = { version: 1, id: randomUUID(), kind: 'repair-history', phase: 'preparing', createdAt: Date.now(), backupId: randomUUID(),
      sourceBackupId: null, completedRoots: [], generation: null, targetDigest: registry.contractDigest(), applicationVersion: '0.8.0', sourceDigest: preview.sourceDigest };
    const journal = new DataOperationJournal(root); await journal.write(operation);
    const backups = new DataBackupStore(root, registry);
    await expect(new HistoryRepairSession(root, rebuilder, backups, journal, (name) => {
      if (name === 'history-projection-installed') throw new Error('interrupted');
    }).run(operation, '0.8.0')).rejects.toThrow('interrupted');
    await new HistoryRepairSession(root, rebuilder, backups, journal).run((await journal.read())!, '0.8.0');
    expect(await fingerprint(join(root, 'data-lifecycle/operations', operation.id, 'history-repair/original.sqlite'))).toEqual(before);
    const history = new ThreadHistoryProjectionStore(path, openLifecycleDatabase(path, false));
    try { expect(history.listTurns({ threadId: data.threadId, cursor: null, limit: 10, itemsView: 'full' }).data[0]?.items.length).toBeGreaterThan(0); }
    finally { history.close(); }
  });

  test('rejects a valid event prefix that is shorter than the retained projection coverage', async () => {
    const { root, data, registry } = await fixture();
    const path = join(root, 'agent/rollouts', `${data.threadId}.jsonl`);
    await writeFile(path, (await readFile(path, 'utf8')).split('\n')[0] + '\n');
    const before = await fingerprint(join(root, 'agent/thread_history.sqlite'));
    await expect(new ThreadProjectionRebuilder(root, registry).preview()).rejects.toThrow('coverage');
    expect(await fingerprint(join(root, 'agent/thread_history.sqlite'))).toEqual(before);
  });
});
