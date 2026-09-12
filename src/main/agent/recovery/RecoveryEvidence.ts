import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { openSqlite, type SqliteDatabase } from '../persistence/sqlite';

interface RetainedFile { readonly path: string; readonly sha256: string; readonly bytes: number }
interface RetentionManifest { readonly version: 1; readonly files: readonly RetainedFile[] }

export function recoveryDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Recovery commits need durable file and directory entries, beyond atomic rename alone. */
export async function writeRecoveryFile(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    await syncRecoveryDirectory(dirname(path));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function syncRecoveryDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Private, operation-owned originals. A missing source is recorded, never silently repaired. */
export class RecoveryEvidence {
  private readonly files: RetainedFile[] = [];
  constructor(readonly root: string) {}

  private path(name: string): string {
    const path = resolve(this.root, name);
    const rel = relative(resolve(this.root), path);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Invalid retention path');
    return path;
  }

  async json(name: string, value: unknown): Promise<void> {
    const path = this.path(name);
    await writeRecoveryFile(path, `${JSON.stringify(value, null, 2)}\n`);
    this.files.push(await fingerprint(path, name));
  }

  async bytes(name: string, value: Uint8Array): Promise<void> {
    const path = this.path(name);
    await writeRecoveryFile(path, value);
    this.files.push(await fingerprint(path, name));
  }

  async file(name: string, source: string): Promise<void> {
    let info;
    try { info = await lstat(source); } catch (error) {
      if (!missing(error)) throw error;
      await this.json(`${name}.missing.json`, { source: 'unavailable' });
      return;
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Recovery source is not an owned regular file');
    const path = this.path(name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const before = await fingerprint(source, name);
    await copyFile(source, path);
    await chmod(path, 0o600);
    const handle = await open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    const retained = await fingerprint(path, name);
    const after = await fingerprint(source, name);
    if (before.sha256 !== retained.sha256 || before.sha256 !== after.sha256 || before.bytes !== after.bytes) {
      throw new Error('Recovery source changed while retaining its original');
    }
    await syncRecoveryDirectory(dirname(path));
    this.files.push(retained);
  }

  async directory(name: string, source: string): Promise<void> {
    let info;
    try { info = await lstat(source); } catch (error) {
      if (!missing(error)) throw error;
      await this.json(`${name}.missing.json`, { source: 'unavailable' });
      return;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Recovery directory is not owned storage');
    const entries = await readdir(source, { withFileTypes: true });
    await this.json(`${name}/directory.json`, { entries: entries.map((entry) => entry.name).sort() });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error('Recovery cannot retain a symbolic link as owned storage');
      if (entry.isDirectory()) await this.directory(`${name}/files/${entry.name}`, join(source, entry.name));
      else await this.file(`${name}/files/${entry.name}`, join(source, entry.name));
    }
  }

  /** SQLite's own snapshot includes committed WAL pages; copying the main file does not. */
  async sqlite(name: string, database: SqliteDatabase): Promise<void> {
    const path = this.path(name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await rm(path, { force: true });
    database.prepare('VACUUM INTO ?').run(path);
    await chmod(path, 0o600);
    const snapshot = openSqlite(path);
    try {
      const checks = snapshot.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>;
      if (checks.length !== 1 || checks[0]?.quick_check !== 'ok') throw new Error('Retained SQLite snapshot failed verification');
      snapshot.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } finally { snapshot.close(); }
    const file = await open(path, 'r');
    try { await file.sync(); } finally { await file.close(); }
    await syncRecoveryDirectory(dirname(path));
    this.files.push(await fingerprint(path, name));
  }

  async seal(): Promise<void> {
    const manifest: RetentionManifest = { version: 1, files: this.files };
    await writeRecoveryFile(join(this.root, 'retention.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await this.verify();
  }

  async verify(): Promise<void> {
    const manifest = JSON.parse(await readFile(join(this.root, 'retention.json'), 'utf8')) as RetentionManifest;
    if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid retained-original manifest');
    const paths = new Set<string>();
    for (const expected of manifest.files) {
      if (typeof expected.path !== 'string' || paths.has(expected.path)
        || !/^[a-f0-9]{64}$/.test(expected.sha256) || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0) {
        throw new Error('Invalid retained-original entry');
      }
      paths.add(expected.path);
      const actual = await fingerprint(this.path(expected.path), expected.path);
      if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) throw new Error('Retained original is missing or changed');
    }
  }
}

async function fingerprint(path: string, name: string): Promise<RetainedFile> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Retained original is not a regular file');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  return { path: name, sha256: hash.digest('hex'), bytes };
}

export function missing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
