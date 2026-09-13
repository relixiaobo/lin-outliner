import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, open, readlink, realpath, rename, rm, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export type DataLifecycleCheckpoint = (name: string) => void | Promise<void>;
export interface FileFingerprint { readonly sha256: string; readonly bytes: number }

export function missing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

export async function syncDirectory(path: string, checkpoint?: DataLifecycleCheckpoint): Promise<void> {
  // macOS exposes /tmp and /var through system aliases. Sync their real directory
  // after the caller has validated its managed path; never open the link itself.
  const file = await open(await realpath(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await checkpoint?.('before-directory-sync');
    await file.sync();
  } finally { await file.close(); }
  await checkpoint?.('directory-synced');
}

/** Persist every newly created directory entry before relying on a child record. */
export async function ensureDurableDirectory(path: string, checkpoint?: DataLifecycleCheckpoint): Promise<void> {
  const absent: string[] = [];
  let current = resolve(path);
  while (true) {
    const info = await lstat(current).catch((error: unknown) => { if (missing(error)) return null; throw error; });
    if (info) {
      const ancestorAlias = current !== resolve(path) && info.isSymbolicLink()
        && (await lstat(await realpath(current))).isDirectory();
      if (!info.isDirectory() && !ancestorAlias || info.isSymbolicLink() && !ancestorAlias) throw new Error('Durable storage requires an owned directory');
      break;
    }
    absent.push(current);
    const parent = dirname(current);
    if (parent === current) throw new Error('Durable storage parent is unavailable');
    current = parent;
  }
  for (const directory of absent.reverse()) {
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!record(error) || error.code !== 'EEXIST') throw error;
    });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Durable directory ownership changed');
    await syncDirectory(directory, checkpoint);
    await syncDirectory(dirname(directory), checkpoint);
  }
  // A prior attempt may have created the directory just before its sync failed.
  if (dirname(resolve(path)) !== resolve(path)) await syncDirectory(dirname(resolve(path)), checkpoint);
}

/** File sync precedes rename; directory sync precedes any dependent mutation. */
export async function writeDurableFile(
  path: string, bytes: string | Uint8Array, checkpoint?: DataLifecycleCheckpoint,
): Promise<void> {
  await ensureDurableDirectory(dirname(path), checkpoint);
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
    const content = Buffer.alloc(info.size + 1);
    let bytes = 0;
    while (bytes < content.length) {
      const result = await file.read(content, bytes, content.length - bytes, bytes);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    if (bytes !== info.size) throw new Error('Lifecycle record changed during inspection');
    return JSON.parse(content.subarray(0, bytes).toString('utf8')) as unknown;
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

export async function assertOwnedPath(root: string, name: string, allowFinalLink = false): Promise<string> {
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
    if (info.isSymbolicLink() && !(allowFinalLink && index === parts.length - 1)
      || index < parts.length - 1 && !info.isDirectory()) {
      throw new Error('Managed storage contains an unowned path');
    }
  }
  return target;
}

export async function fingerprintLink(path: string): Promise<FileFingerprint & { readonly linkTarget: string }> {
  if (!(await lstat(path)).isSymbolicLink()) throw new Error('Expected a retained symbolic link');
  const linkTarget = await readlink(path);
  return { linkTarget, bytes: Buffer.byteLength(linkTarget), sha256: createHash('sha256').update(linkTarget).digest('hex') };
}

/** Preserve a working-material reference without reading or writing its target. */
export async function copyLinkDurably(source: string, target: string, checkpoint?: DataLifecycleCheckpoint): Promise<FileFingerprint & { readonly linkTarget: string }> {
  const before = await fingerprintLink(source);
  await ensureDurableDirectory(dirname(target), checkpoint);
  await symlink(before.linkTarget, target);
  const after = await fingerprintLink(source);
  if (before.sha256 !== after.sha256) throw new Error('Working-material link changed during retention');
  await syncDirectory(dirname(target), checkpoint);
  return before;
}

export async function fingerprint(path: string): Promise<FileFingerprint> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error('Expected an owned regular file');
    const digest = createHash('sha256');
    let bytes = 0;
    const buffer = Buffer.alloc(64 * 1024);
    // The handle has one close owner. Explicit reads avoid sharing descriptor lifetime
    // with a stream and keep bounded inspection under one close owner.
    while (true) {
      const result = await file.read(buffer, 0, buffer.length, bytes);
      if (!result.bytesRead) break;
      digest.update(buffer.subarray(0, result.bytesRead)); bytes += result.bytesRead;
      if (bytes > before.size) throw new Error('Storage grew while its checksum was being read');
    }
    const after = await file.stat();
    if (before.size !== bytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Storage changed while its checksum was being read');
    }
    return { sha256: digest.digest('hex'), bytes };
  } finally { await file.close(); }
}

export async function copyDurably(source: string, target: string, checkpoint?: DataLifecycleCheckpoint, mode = 0o600): Promise<FileFingerprint> {
  if (mode !== 0o600 && mode !== 0o700) throw new Error('Unsupported private file permissions');
  const before = await fingerprint(source);
  await ensureDurableDirectory(dirname(target), checkpoint);
  await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await file.chmod(mode); await checkpoint?.('before-file-sync'); await file.sync(); }
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
