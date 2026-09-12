import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { decodeDataLifecycleRequest } from '../../src/core/dataLifecycle';
import { assertOwnedPath, fingerprint, writeDurableJson } from '../../src/main/dataLifecycle/durableFiles';
import { databaseVersion, migrateDatabase, openLifecycleDatabase } from '../../src/main/dataLifecycle/sqlite';
import { DataStoreRegistry, PHYSICAL_SQLITE_STORES } from '../../src/main/dataLifecycle/storeRegistry';
import { ThreadMetadataStore } from '../../src/main/agent/persistence/ThreadMetadataStore';
import { ThreadHistoryProjectionStore } from '../../src/main/agent/persistence/ThreadHistoryProjectionStore';
import { GoalStore } from '../../src/main/agent/extensions/goal/GoalStore';
import { ToolTaskStore } from '../../src/main/agent/tasks/ToolTaskStore';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';

const roots: string[] = [];
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'tenon-data-lifecycle-')); roots.push(value); return value; }
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('data lifecycle storage boundaries', () => {
  test('rejects paths and stale-shaped renderer requests at the command boundary', () => {
    expect(() => decodeDataLifecycleRequest({ action: 'restore', path: '/tmp/a', revision: 0 })).toThrow();
    expect(() => decodeDataLifecycleRequest({ action: 'backup', storeId: 'other' })).toThrow();
    expect(() => decodeDataLifecycleRequest({ action: 'restore', backupId: '../outside', revision: 0 })).toThrow();
    expect(decodeDataLifecycleRequest({ action: 'inspect' })).toEqual({ action: 'inspect' });
  });

  test('failed file sync preserves the previously committed journal and never renames', async () => {
    const directory = await root();
    const path = join(directory, 'journal.json');
    await writeDurableJson(path, { generation: 'original' });
    const before = await fingerprint(path);
    await expect(writeDurableJson(path, { generation: 'replacement' }, (name) => {
      if (name === 'before-file-sync') throw new Error('injected I/O failure');
    })).rejects.toThrow('injected');
    expect(await fingerprint(path)).toEqual(before);
  });

  test('database transaction rollback retains both original data and schema version', async () => {
    const database = openLifecycleDatabase(':memory:', false);
    database.exec("CREATE TABLE notes(id TEXT PRIMARY KEY, body TEXT); INSERT INTO notes VALUES ('note', 'original'); PRAGMA user_version = 1");
    try {
      await expect(migrateDatabase(database, { from: 1, to: 2,
        apply: (db) => { db.exec("ALTER TABLE notes ADD COLUMN extra TEXT; UPDATE notes SET body = 'changed'"); },
        validate: () => undefined,
      }, (name) => { if (name === 'before-database-commit') throw new Error('interrupted'); })).rejects.toThrow('interrupted');
      expect(databaseVersion(database)).toBe(1);
      expect(database.prepare('SELECT body FROM notes').get()).toEqual({ body: 'original' });
      expect((database.prepare('PRAGMA table_info(notes)').all() as { name: string }[]).map((column) => column.name)).toEqual(['id', 'body']);
    } finally { database.close(); }
  });

  test('rejects an unknown future physical version without changing any database bytes', async () => {
    const directory = await root();
    const path = join(directory, 'future.sqlite');
    const database = openLifecycleDatabase(path, false);
    database.exec('CREATE TABLE future_data(id TEXT); PRAGMA user_version = 99'); database.close();
    const before = await fingerprint(path);
    const registry = new DataStoreRegistry([{ id: 'fixture', path: 'future.sqlite', domain: 'agent', version: 1, schema: 'CREATE TABLE fixture(id TEXT)' }]);
    const [inspection] = await registry.inspect(directory);
    expect(inspection?.issue?.reason).toBe('future-version');
    expect(await fingerprint(path)).toEqual(before);
  });

  test('establishes all physical versions and reopens shared databases through production owners', async () => {
    const directory = await root();
    const registry = new DataStoreRegistry();
    const initial = await registry.inspect(directory);
    expect(initial.every((entry) => !entry.exists && !entry.issue)).toBe(true);
    await registry.establishVersions(directory, initial);
    expect((await registry.inspect(directory, true)).every((entry) => entry.exists && !entry.issue && entry.observedVersion === entry.store.version)).toBe(true);
    const metadata = new ThreadMetadataStore(join(directory, 'agent/state.sqlite'), new Database(join(directory, 'agent/state.sqlite')) as unknown as SqliteDatabase);
    const history = new ThreadHistoryProjectionStore(join(directory, 'agent/thread_history.sqlite'), new Database(join(directory, 'agent/thread_history.sqlite')) as unknown as SqliteDatabase);
    const goalsDatabase = new Database(join(directory, 'agent/goals.sqlite')) as unknown as SqliteDatabase;
    const goals = new GoalStore(join(directory, 'agent/goals.sqlite'), goalsDatabase);
    new ToolTaskStore(goalsDatabase);
    metadata.close(); history.close(); goalsDatabase.close();
    expect((await registry.inspect(directory)).every((entry) => !entry.issue)).toBe(true);
    expect(new Set(PHYSICAL_SQLITE_STORES.map((store) => store.path)).size).toBe(PHYSICAL_SQLITE_STORES.length);
  });

  test('rejects symbolic-link traversal and never reads an external file through a managed path', async () => {
    const directory = await root(); const external = await root();
    await writeFile(join(external, 'data.json'), '{"secret":true}');
    await symlink(external, join(directory, 'linked'));
    await expect(assertOwnedPath(directory, 'linked/data.json')).rejects.toThrow('unowned path');
    await expect(assertOwnedPath(directory, '../data.json')).rejects.toThrow('Invalid managed');
  });
});
