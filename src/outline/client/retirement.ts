import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { resolveOutlineRuntimePaths } from '../runtimePaths';

const INCOMPLETE_CLAIM_GRACE_MS = 1_000;

interface RetirementClaimRecord {
  readonly pid: number;
  readonly claimId: string;
  readonly instanceId: string;
  readonly createdAt: string;
}

export interface OutlineRuntimeRetirementClaim {
  readonly owned: boolean;
  release(): Promise<void>;
}

export async function acquireOutlineRuntimeRetirementClaim(
  root: string,
  instanceId: string,
): Promise<OutlineRuntimeRetirementClaim> {
  const claimPath = resolveOutlineRuntimePaths(root).retirementPath;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record: RetirementClaimRecord = {
      pid: process.pid,
      claimId: `retirement:${crypto.randomUUID()}`,
      instanceId,
      createdAt: new Date().toISOString(),
    };
    try {
      const handle = await open(claimPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(claimPath).catch(() => undefined);
        throw error;
      }
      await handle.close();
      return {
        owned: true,
        release: async () => {
          const current = await readClaim(claimPath);
          if (current?.claimId === record.claimId) {
            await unlink(claimPath).catch((error: unknown) => {
              if (!isNotFound(error)) throw error;
            });
          }
        },
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }

    const existing = await readClaim(claimPath);
    if (existing && processIsAlive(existing.pid)) {
      return { owned: false, release: async () => undefined };
    }
    const value = await lstat(claimPath).catch((error: unknown) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    if (value && !existing && Date.now() - value.mtimeMs < INCOMPLETE_CLAIM_GRACE_MS) {
      return { owned: false, release: async () => undefined };
    }
    await unlink(claimPath).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
  }
  return { owned: false, release: async () => undefined };
}

async function readClaim(claimPath: string): Promise<RetirementClaimRecord | null> {
  try {
    const [value, raw] = await Promise.all([lstat(claimPath), readFile(claimPath, 'utf8')]);
    if (!value.isFile()
      || value.isSymbolicLink()
      || (process.platform !== 'win32' && (value.mode & 0o077) !== 0)
      || (process.platform !== 'win32'
        && typeof process.getuid === 'function'
        && value.uid !== process.getuid())) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)
      || !Number.isSafeInteger(parsed.pid)
      || (parsed.pid as number) < 1
      || typeof parsed.claimId !== 'string'
      || typeof parsed.instanceId !== 'string'
      || typeof parsed.createdAt !== 'string') return null;
    return parsed as unknown as RetirementClaimRecord;
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === 'EPERM';
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
