import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DataStoreRegistry } from '../../src/main/dataLifecycle/storeRegistry';
import { DataBackupStore } from '../../src/main/dataLifecycle/BackupStore';
import { DataOperationJournal, type DataOperation } from '../../src/main/dataLifecycle/OperationJournal';
import { DataRestoreSession } from '../../src/main/dataLifecycle/RestoreSession';
import { openLifecycleDatabase } from '../../src/main/dataLifecycle/sqlite';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tenon-restore-')); roots.push(root);
  const registry = new DataStoreRegistry();
  await registry.establishVersions(root, await registry.inspect(root));
  await mkdir(join(root, 'agent/user'), { recursive: true });
  await writeFile(join(root, 'agent/user/USER.md'), '# Original\n');
  const backups = new DataBackupStore(root, registry);
  const source = await backups.create('0.8.0');
  await writeFile(join(root, 'agent/user/USER.md'), '# Later\n');
  const operation: DataOperation = { version: 1, id: randomUUID(), kind: 'restore', phase: 'preparing',
    createdAt: Date.now(), backupId: randomUUID(), sourceBackupId: source.id, completedRoots: [], generation: randomUUID() };
  const journal = new DataOperationJournal(root);
  await journal.write(operation);
  return { root, registry, backups, operation, journal };
}

describe('journaled dataset restoration', () => {
  for (const boundary of ['restore-execution-fenced', 'operation:installing', 'retained-root:agent', 'installed-root:agent', 'restore-data-verified']) {
    test(`resumes after ${boundary} while retaining the original data and execution fence`, async () => {
      const { root, registry, backups, operation } = await fixture();
      let interrupt = true;
      const checkpoint = (name: string) => { if (name === boundary && interrupt) { interrupt = false; throw new Error('interrupted'); } };
      const journal = new DataOperationJournal(root, checkpoint);
      await expect(new DataRestoreSession(root, backups, journal, { checkpoint }).run(operation, '0.8.0')).rejects.toThrow('interrupted');
      const restartedJournal = new DataOperationJournal(root);
      const pending = await restartedJournal.read();
      const resumed = await new DataRestoreSession(root, backups, restartedJournal).run(pending!, '0.8.0');
      expect(resumed.phase).toBe('verifying');
      expect(await readFile(join(root, 'agent/user/USER.md'), 'utf8')).toBe('# Original\n');
      expect(await readFile(join(backups.path(operation.backupId), 'files/agent/user/USER.md'), 'utf8')).toBe('# Later\n');
      expect(JSON.parse(await readFile(join(root, 'data-lifecycle/execution-fence.json'), 'utf8'))).toMatchObject({ paused: true, generation: operation.generation });
      expect((await registry.inspect(root, true)).every((entry) => !entry.issue)).toBe(true);
    });
  }

  test('cannot replay a retained source WAL into the restored database', async () => {
    const { root, backups, journal, operation } = await fixture();
    const later = openLifecycleDatabase(join(root, 'agent/memories.sqlite'), false);
    later.exec("INSERT INTO settings VALUES ('later', 'external-effect-already-happened')"); later.close();
    await new DataRestoreSession(root, backups, journal).run(operation, '0.8.0');
    const restored = openLifecycleDatabase(join(root, 'agent/memories.sqlite'), true);
    try { expect(restored.prepare("SELECT value FROM settings WHERE key='later'").get()).toBeFalsy(); }
    finally { restored.close(); }
    expect(await journal.read()).toMatchObject({ id: operation.id, phase: 'verifying' });
  });
});
