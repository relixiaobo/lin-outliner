import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DataBackupStore, decodeBackupManifest } from '../../src/main/dataLifecycle/BackupStore';
import { DataStoreRegistry } from '../../src/main/dataLifecycle/storeRegistry';
import { openLifecycleDatabase } from '../../src/main/dataLifecycle/sqlite';
import { fingerprint } from '../../src/main/dataLifecycle/durableFiles';
import { OutlineRuntimeWorkspace } from '../../src/outline/runtime';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tenon-backup-')); roots.push(root);
  const registry = new DataStoreRegistry();
  await registry.establishVersions(root, await registry.inspect(root));
  (await OutlineRuntimeWorkspace.open(join(root, 'outline-runtime/workspace'), { contentRoot: join(root, 'content') })).close();
  await mkdir(join(root, 'agent/user'), { recursive: true });
  await writeFile(join(root, 'agent/user/USER.md'), '# User\n\nRetain this exact text.\n');
  return { root, registry };
}

describe('verified data backups', () => {
  test('retains WAL-only commits and exact files without copying SQLite sidecars', async () => {
    const { root, registry } = await fixture();
    const live = openLifecycleDatabase(join(root, 'agent/memories.sqlite'), false);
    live.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO settings VALUES ('test-memory', 'retained')");
    try {
      const store = new DataBackupStore(root, registry);
      const backup = await store.create('0.8.0');
      expect(backup.files.some((file) => file.path.endsWith('-wal'))).toBe(false);
      expect(backup.excluded).toContain('agent/memories.sqlite-wal');
      const copied = openLifecycleDatabase(join(store.path(backup.id), 'files/agent/memories.sqlite'), true);
      try { expect(copied.prepare("SELECT value FROM settings WHERE key='test-memory'").get()).toEqual({ value: 'retained' }); }
      finally { copied.close(); }
      expect(await readFile(join(store.path(backup.id), 'files/agent/user/USER.md'), 'utf8')).toBe('# User\n\nRetain this exact text.\n');
      await expect(store.verify(backup)).resolves.toBeUndefined();
    } finally { live.close(); }
  });

  test('an interrupted backup has no completion marker and retry retains the same operation identity', async () => {
    const { root, registry } = await fixture();
    let interrupt = true;
    const store = new DataBackupStore(root, registry, { checkpoint: (name) => {
      if (name === 'before-backup-complete' && interrupt) { interrupt = false; throw new Error('interrupted'); }
    } });
    const id = randomUUID();
    await expect(store.create('0.8.0', id)).rejects.toThrow('interrupted');
    expect(await store.read(id)).toBeNull();
    const completed = await store.create('0.8.0', id);
    expect(completed.id).toBe(id);
    expect((await store.list()).map((entry) => entry.id)).toEqual([id]);
  });

  test('disk-full refusal preserves canonical data and cannot produce a valid backup', async () => {
    const { root, registry } = await fixture();
    const before = await fingerprint(join(root, 'agent/state.sqlite'));
    const store = new DataBackupStore(root, registry, { availableBytes: async () => 0 });
    await expect(store.create('0.8.0')).rejects.toThrow('Not enough free space');
    expect(await fingerprint(join(root, 'agent/state.sqlite'))).toEqual(before);
    expect(await store.list()).toEqual([]);
  });

  test('detects modified backup content instead of reporting its completion marker as verified data', async () => {
    const { root, registry } = await fixture();
    const store = new DataBackupStore(root, registry);
    const backup = await store.create('0.8.0');
    await writeFile(join(store.path(backup.id), 'files/agent/user/USER.md'), 'different');
    await expect(store.verify(backup)).rejects.toThrow('changed');
    expect((await store.list())[0]?.verified).toBe(false);
  });

  test('rejects persisted backup paths that escape the registered data roots', async () => {
    const { root, registry } = await fixture();
    const backup = await new DataBackupStore(root, registry).create('0.8.0');
    expect(() => decodeBackupManifest({ ...backup, files: [{ path: 'agent/../../outside', kind: 'file', bytes: 1, sha256: 'a'.repeat(64) }] })).toThrow();
  });

  test('retains working-material links without traversing their external targets', async () => {
    const { root, registry } = await fixture();
    const external = await mkdtemp(join(tmpdir(), 'tenon-link-target-')); roots.push(external);
    await writeFile(join(external, 'private.txt'), 'External bytes are not part of this backup');
    await mkdir(join(root, 'agent/workspaces/project'), { recursive: true });
    await symlink(external, join(root, 'agent/workspaces/project/external'));
    const store = new DataBackupStore(root, registry);
    const backup = await store.create('0.8.0');
    expect(backup.files.find((entry) => entry.path === 'agent/workspaces/project/external')?.kind).toBe('link');
    expect(backup.files.some((entry) => entry.path.endsWith('/private.txt'))).toBe(false);
    expect(await readlink(join(store.path(backup.id), 'files/agent/workspaces/project/external'))).toBe(external);
    const link = backup.files.find((entry) => entry.kind === 'link')!;
    expect(() => decodeBackupManifest({ ...backup, files: [...backup.files, { path: `${link.path}/escape.txt`, kind: 'file', bytes: 0, sha256: 'b'.repeat(64) }] })).toThrow('non-directory');
  });
});
