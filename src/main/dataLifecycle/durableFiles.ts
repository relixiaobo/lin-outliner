import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export type DataLifecycleCheckpoint = (name: string) => void | Promise<void>;
export interface FileFingerprint { readonly sha256: string; readonly bytes: number }

export function missing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

export async function syncDirectory(path: string, checkpoint?: DataLifecycleCheckpoint): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await checkpoint?.('before-directory-sync');
    await file.sync();
  } finally { await file.close(); }
  await checkpoint?.('directory-synced');
}

/** File sync precedes rename; directory sync precedes any dependent mutation. */
export async function writeDurableFile(
  path: string, bytes: string | Uint8Array, checkpoint?: DataLifecycleCheckpoint,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await checkpoint?.('before-file-sync');
      await file.sync();
    } finally { await file.close(); }
    await checkpoint?.('file-synced');
    await rename(temporary, path);
    await checkpoint?.('file-renamed');
    await syncDirectory(dirname(path), checkpoint);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function writeDurableJson(path: string, value: unknown, checkpoint?: DataLifecycleCheckpoint): Promise<void> {
  return writeDurableFile(path, `${JSON.stringify(value, null, 2)}\n`, checkpoint);
}

export async function readPrivateJson(path: string, maximumBytes = 4 * 1024 * 1024): Promise<unknown | null> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (missing(error)) return null; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maximumBytes) throw new Error('Invalid or oversized lifecycle record');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > maximumBytes) throw new Error('Oversized lifecycle record');
      chunks.push(chunk as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await file.close(); }
}

/** The root is fixed by main; even persisted manifests cannot supply an absolute path. */
export function ownedPath(root: string, name: string): string {
  if (!name || name.length > 4096 || isAbsolute(name) || name.includes('\\')
    || name.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\0'))) {
    throw new Error('Invalid managed storage path');
  }
  const target = resolve(root, name);
  const rel = relative(resolve(root), target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Storage path escaped its owner');
  return target;
}

export async function assertOwnedPath(root: string, name: string): Promise<string> {
  ownedPath(root, name);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Managed storage root must be an owned directory');
  const actualRoot = await realpath(root);
  const target = ownedPath(actualRoot, name);
  let current = actualRoot;
  const parts = name.split('/');
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    const info = await lstat(current).catch((error: unknown) => { if (missing(error)) return null; throw error; });
    if (!info) break;
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) {
      throw new Error('Managed storage contains an unowned path');
    }
  }
  return target;
}

export async function fingerprint(path: string): Promise<FileFingerprint> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error('Expected an owned regular file');
    const digest = createHash('sha256');
    let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      digest.update(chunk); bytes += chunk.length;
    }
    const after = await file.stat();
    if (before.size !== bytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Storage changed while its checksum was being read');
    }
    return { sha256: digest.digest('hex'), bytes };
  } finally { await file.close(); }
}

export async function copyDurably(source: string, target: string, checkpoint?: DataLifecycleCheckpoint): Promise<FileFingerprint> {
  const before = await fingerprint(source);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await file.chmod(0o600); await checkpoint?.('before-file-sync'); await file.sync(); }
  finally { await file.close(); }
  const after = await fingerprint(source);
  const copied = await fingerprint(target);
  if (before.sha256 !== after.sha256 || before.sha256 !== copied.sha256 || before.bytes !== copied.bytes) {
    throw new Error('Storage changed while its backup was being copied');
  }
  await syncDirectory(dirname(target), checkpoint);
  return copied;
}

export function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
