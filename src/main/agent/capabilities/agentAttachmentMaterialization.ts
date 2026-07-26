import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

export const AGENT_GENERATED_IMAGE_DIR = 'generated-images';
export const AGENT_SCRATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Bound the whole scratch root by age. Scratch is app-owned ephemeral data (web-fetch binaries,
// bash overflow logs, PDF page images); none of it is durable,
// so anything untouched past the TTL is removed. Pruning the entries WITHIN each scratch subdir
// (by per-entry mtime) rather than the subdirs themselves keeps actively-written areas intact
// while still reclaiming stale files. Best-effort; called once at startup.
export async function pruneAgentScratch(
  scratchRoot: string,
  now = Date.now(),
  ttlMs = AGENT_SCRATCH_TTL_MS,
): Promise<void> {
  const root = path.resolve(scratchRoot);
  let subdirs: string[];
  try {
    subdirs = await readdir(root);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(subdirs.map((entry) => {
    if (entry === AGENT_GENERATED_IMAGE_DIR) return undefined;
    return pruneDirEntriesByTtl(path.join(root, entry), now, ttlMs);
  }));
}

async function pruneDirEntriesByTtl(dir: string, now: number, ttlMs: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return;
    throw error;
  }

  await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(dir, entry);
    try {
      const entryStat = await lstat(entryPath);
      if (now - entryStat.mtimeMs <= ttlMs) return;
      await rm(entryPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup should never block attachment handling.
    }
  }));
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === 'object' && 'code' in error;
}
