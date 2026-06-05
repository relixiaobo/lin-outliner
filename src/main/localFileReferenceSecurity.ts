import type { Stats } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isPathInside } from './agentAttachmentMaterialization';

const BLOCKED_OPEN_EXTENSIONS = new Set([
  '.app',
  '.applescript',
  '.command',
  '.dmg',
  '.jar',
  '.mpkg',
  '.pkg',
  '.scpt',
  '.terminal',
  '.tool',
  '.webloc',
  '.workflow',
]);

export interface TrustedLocalFileReference {
  entryKind: 'file' | 'directory';
  path: string;
  stats: Stats;
}

export async function resolveTrustedLocalFileReference(
  value: unknown,
  allowedRoots: readonly string[],
): Promise<TrustedLocalFileReference | null> {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.includes('\0') || !path.isAbsolute(value)) return null;

  const candidatePath = path.resolve(value);
  let candidateRealPath: string;
  let candidateStats: Stats;
  try {
    candidateRealPath = await realpath(candidatePath);
    candidateStats = await stat(candidateRealPath);
  } catch {
    return null;
  }

  const entryKind = candidateStats.isDirectory() ? 'directory' : candidateStats.isFile() ? 'file' : null;
  if (!entryKind) return null;

  for (const root of allowedRoots) {
    const trustedRoot = await trustedRootRealPath(root);
    if (trustedRoot && isPathInside(trustedRoot, candidateRealPath)) {
      return {
        entryKind,
        path: candidateRealPath,
        stats: candidateStats,
      };
    }
  }

  return null;
}

export function isSafeLocalFileOpenTarget(file: TrustedLocalFileReference): boolean {
  const extension = path.extname(file.path).toLowerCase();
  if (BLOCKED_OPEN_EXTENSIONS.has(extension)) return false;
  if (file.entryKind === 'file' && (file.stats.mode & 0o111) !== 0) return false;
  return true;
}

async function trustedRootRealPath(root: string): Promise<string | null> {
  try {
    const rootRealPath = await realpath(path.resolve(root));
    if (path.parse(rootRealPath).root === rootRealPath) return null;
    return rootRealPath;
  } catch {
    return null;
  }
}
