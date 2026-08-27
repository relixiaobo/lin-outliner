import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { OutlineRuntimePaths } from '../../runtimePaths';

export { resolveOutlineRuntimePaths, type OutlineRuntimePaths } from '../../runtimePaths';

const LOCK_STALE_GRACE_MS = 10_000;

export interface RuntimeLockOwner {
  readonly pid: number;
  readonly instanceId: string;
  readonly createdAt: string;
}

export class OutlineRuntimeLock {
  private released = false;

  private constructor(
    readonly path: string,
    readonly owner: RuntimeLockOwner,
  ) {}

  static async acquire(paths: OutlineRuntimePaths, owner: RuntimeLockOwner): Promise<OutlineRuntimeLock | null> {
    await ensurePrivateDirectory(paths.root);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await mkdir(paths.lockPath, { mode: 0o700 });
        const lock = new OutlineRuntimeLock(paths.lockPath, owner);
        try {
          await writePrivateJson(path.join(paths.lockPath, 'owner.json'), owner);
          return lock;
        } catch (error) {
          await lock.release();
          throw error;
        }
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
      if (await activeLockOwner(paths.lockPath)) return null;
      const stalePath = `${paths.lockPath}.stale-${crypto.randomUUID()}`;
      try {
        await rename(paths.lockPath, stalePath);
        await rm(stalePath, { recursive: true, force: true });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    return null;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const owner = await readLockOwner(this.path);
    if (owner?.pid === this.owner.pid && owner.instanceId === this.owner.instanceId) {
      await rm(this.path, { recursive: true, force: true });
    }
  }
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const value = await lstat(directory);
  if (!value.isDirectory() || value.isSymbolicLink()) {
    throw new Error(`Outline Runtime path is not a private directory: ${directory}`);
  }
  await chmod(directory, 0o700);
}

export async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  const handle = await open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rename(tempPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function activeLockOwner(lockPath: string): Promise<RuntimeLockOwner | null> {
  const owner = await readLockOwner(lockPath);
  if (owner && processIsAlive(owner.pid)) return owner;
  const lockStat = await stat(lockPath).catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  if (lockStat && Date.now() - lockStat.mtimeMs < LOCK_STALE_GRACE_MS) {
    return owner ?? { pid: 0, instanceId: 'runtime:starting', createdAt: new Date(lockStat.mtimeMs).toISOString() };
  }
  return null;
}

async function readLockOwner(lockPath: string): Promise<RuntimeLockOwner | null> {
  try {
    const value = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8')) as unknown;
    if (!isRecord(value)
      || !Number.isSafeInteger(value.pid)
      || (value.pid as number) < 1
      || typeof value.instanceId !== 'string'
      || typeof value.createdAt !== 'string') return null;
    return value as unknown as RuntimeLockOwner;
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  if (pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === 'EPERM';
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle: FileHandle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === 'EEXIST';
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
