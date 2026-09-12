import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rm, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DATA_OPERATION_ID, type DataBackupSummary } from '../../core/dataLifecycle';
import { assertOwnedPath, copyDurably, fingerprint, missing, ownedPath, readPrivateJson, record,
  syncDirectory, writeDurableJson, type DataLifecycleCheckpoint, type FileFingerprint } from './durableFiles';
import { DataStoreRegistry } from './storeRegistry';
import { inspectManagedFiles, isManagedDataPath, MANAGED_DATA_ROOTS, MAX_BACKUP_FILES, type ManagedRoot } from './inventory';
import { verifyDatabase } from './sqlite';

export interface BackupFile extends FileFingerprint { readonly path: string; readonly kind: 'sqlite' | 'file' }
export interface DataBackupManifest {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: number;
  readonly applicationVersion: string;
  readonly storeVersions: Readonly<Record<string, number>>;
  readonly roots: readonly ManagedRoot[];
  readonly files: readonly BackupFile[];
  readonly excluded: readonly string[];
}

export interface BackupOptions {
  readonly checkpoint?: DataLifecycleCheckpoint;
  readonly progress?: (completed: number, total: number) => void;
  readonly availableBytes?: () => Promise<number>;
}

export class DataBackupStore {
  readonly root: string;
  constructor(readonly userData: string, private readonly registry: DataStoreRegistry, private readonly options: BackupOptions = {}) {
    this.root = join(userData, 'data-lifecycle', 'backups');
  }

  path(id: string): string {
    if (!DATA_OPERATION_ID.test(id)) throw new Error('Invalid backup identity');
    return ownedPath(this.root, id);
  }

  async create(applicationVersion: string, id: string = randomUUID()): Promise<DataBackupManifest> {
    await assertOwnedPath(this.userData, 'data-lifecycle/backups');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const existing = await this.read(id).catch((error: unknown) => { if (missing(error)) return null; throw error; });
    if (existing) { await this.verify(existing); return existing; }
    const inventory = await inspectManagedFiles(this.userData, this.registry);
    const size = inventory.files.reduce((total, file) => total + file.bytes, 0);
    const filesystem = await statfs(this.userData);
    const available = this.options.availableBytes ? await this.options.availableBytes() : filesystem.bavail * filesystem.bsize;
    if (available < size * 3 + 16 * 1024 * 1024) throw Object.assign(new Error('Not enough free space to retain and restore a verified backup.'), { code: 'ENOSPC' });
    const directory = this.path(id);
    // This ID belongs to the current journal. No complete backup can be removed here.
    await rm(directory, { recursive: true, force: true });
    await mkdir(join(directory, 'files'), { recursive: true, mode: 0o700 });
    const inspection = await this.registry.inspect(this.userData, true);
    const invalid = inspection.find((entry) => entry.issue);
    if (invalid) throw new Error(`Cannot snapshot ${invalid.store.id}: ${invalid.issue!.message}`);
    const files: BackupFile[] = [];
    for (const [index, source] of inventory.files.entries()) {
      const sourcePath = await assertOwnedPath(this.userData, source.path);
      const target = ownedPath(join(directory, 'files'), source.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      let retained: FileFingerprint;
      if (source.kind === 'sqlite') {
        // The coordinator owns the writer barrier. VACUUM INTO includes committed WAL.
        const database = this.registry.openDatabase(sourcePath, false);
        try { database.prepare('VACUUM INTO ?').run(target); }
        finally { database.close(); }
        const snapshot = this.registry.openDatabase(target, false);
        try { verifyDatabase(snapshot, true); snapshot.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
        finally { snapshot.close(); }
        const file = await open(target, 'r');
        try { await file.chmod(0o600); await this.options.checkpoint?.('before-backup-file-sync'); await file.sync(); }
        finally { await file.close(); }
        await syncDirectory(dirname(target), this.options.checkpoint);
        retained = await fingerprint(target);
      } else retained = await copyDurably(sourcePath, target, this.options.checkpoint);
      files.push({ path: source.path, kind: source.kind, ...retained });
      this.options.progress?.(index + 1, inventory.files.length);
      await this.options.checkpoint?.(`backup-file:${index}`);
    }
    const manifest: DataBackupManifest = { version: 1, id, createdAt: Date.now(), applicationVersion,
      storeVersions: Object.fromEntries(inspection.filter((entry) => entry.exists).map((entry) => [entry.store.id, entry.observedVersion])),
      roots: inventory.roots, files, excluded: inventory.excluded };
    await writeDurableJson(join(directory, 'manifest.json'), manifest, this.options.checkpoint);
    await this.verify(manifest, false);
    await this.options.checkpoint?.('before-backup-complete');
    await writeDurableJson(join(directory, 'complete.json'), { version: 1, digest: backupDigest(manifest) }, this.options.checkpoint);
    await syncDirectory(this.root, this.options.checkpoint);
    return manifest;
  }

  async read(id: string): Promise<DataBackupManifest | null> {
    const directory = this.path(id);
    await assertOwnedPath(this.userData, `data-lifecycle/backups/${id}/complete.json`);
    const complete = await readPrivateJson(join(directory, 'complete.json'));
    if (complete === null) return null;
    const value = await readPrivateJson(join(directory, 'manifest.json'), 64 * 1024 * 1024);
    const manifest = decodeBackupManifest(value);
    if (manifest.id !== id || !record(complete) || complete.version !== 1 || complete.digest !== backupDigest(manifest)) {
      throw new Error('Backup completion does not match its manifest');
    }
    return manifest;
  }

  async verify(manifest: DataBackupManifest, requireComplete = true): Promise<void> {
    decodeBackupManifest(manifest);
    if (requireComplete && !(await this.read(manifest.id))) throw new Error('Backup is incomplete');
    const root = join(this.path(manifest.id), 'files');
    for (const file of manifest.files) {
      const source = await assertOwnedPath(root, file.path);
      const actual = await fingerprint(source);
      if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) throw new Error('Backup file is missing or changed');
    }
  }

  async list(pinned: ReadonlySet<string> = new Set()): Promise<readonly DataBackupSummary[]> {
    const names = await readdir(this.root).catch((error: unknown) => { if (missing(error)) return []; throw error; });
    const results: DataBackupSummary[] = [];
    for (const id of names.filter((name) => DATA_OPERATION_ID.test(name))) {
      const manifest = await this.read(id).catch(() => null);
      if (!manifest) continue;
      const verified = await this.verify(manifest).then(() => true, () => false);
      results.push({ id, createdAt: manifest.createdAt, applicationVersion: manifest.applicationVersion,
        bytes: manifest.files.reduce((total, file) => total + file.bytes, 0), fileCount: manifest.files.length,
        verified, pinned: pinned.has(id) });
    }
    return results.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }

  async prune(pinned: ReadonlySet<string>): Promise<void> {
    const backups = await this.list(pinned);
    for (const backup of backups.filter((entry) => entry.verified).slice(3)) {
      if (!pinned.has(backup.id)) await rm(this.path(backup.id), { recursive: true, force: true });
    }
    if (backups.length > 3) await syncDirectory(this.root);
  }
}

function backupDigest(manifest: DataBackupManifest): string { return createHash('sha256').update(JSON.stringify(manifest)).digest('hex'); }

export function decodeBackupManifest(value: unknown): DataBackupManifest {
  if (!record(value) || value.version !== 1 || typeof value.id !== 'string' || !DATA_OPERATION_ID.test(value.id)
    || !Number.isSafeInteger(value.createdAt) || typeof value.applicationVersion !== 'string'
    || value.applicationVersion.length > 100 || !record(value.storeVersions)
    || !Array.isArray(value.roots) || value.roots.length !== MANAGED_DATA_ROOTS.length
    || !Array.isArray(value.files) || value.files.length > MAX_BACKUP_FILES || !Array.isArray(value.excluded)) {
    throw new Error('Invalid backup manifest');
  }
  const roots = new Set<string>();
  for (const root of value.roots) {
    if (!record(root) || typeof root.path !== 'string' || !(MANAGED_DATA_ROOTS as readonly string[]).includes(root.path)
      || !['directory', 'file', 'missing'].includes(String(root.kind)) || roots.has(root.path)) throw new Error('Invalid backup root');
    roots.add(root.path);
  }
  const paths = new Set<string>();
  for (const file of value.files) {
    if (!record(file) || typeof file.path !== 'string' || !isManagedDataPath(file.path) || paths.has(file.path)
      || !['sqlite', 'file'].includes(String(file.kind)) || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0) throw new Error('Invalid backup file entry');
    ownedPath('/managed', file.path);
    paths.add(file.path);
  }
  for (const [key, version] of Object.entries(value.storeVersions)) {
    if (!/^[a-z][a-z0-9-]{0,100}$/.test(key) || !Number.isSafeInteger(version) || (version as number) < 0) throw new Error('Invalid backup Store version');
  }
  return value as unknown as DataBackupManifest;
}
