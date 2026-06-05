import type { Stats } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isPathInside } from './agentAttachmentMaterialization';

// A denylist is inherently incomplete against the open-ended set of types macOS
// (and other OSes) will auto-run or redirect through; an allowlist of inert
// document/media types would be stronger, but that is a product trade-off (it
// would block legitimate file types). Until then, block the known-dangerous
// classes:
//   - executables / installers / app + automation bundles, and
//   - "location" / shortcut files that resolve to an arbitrary URL or path and
//     would let a click on an in-root reference escape the trusted root entirely
//     (e.g. a .fileloc pointing at /Applications/...; .webloc/.inetloc → URLs).
// The executable-bit check below does NOT catch the location files (they are
// plain, non-executable plists), so they must be denied here by extension.
const BLOCKED_OPEN_EXTENSIONS = new Set([
  '.action',
  '.app',
  '.applescript',
  '.command',
  '.desktop',
  '.dmg',
  '.fileloc',
  '.inetloc',
  '.jar',
  '.mpkg',
  '.pkg',
  '.scpt',
  '.scptd',
  '.shortcut',
  '.terminal',
  '.tool',
  '.url',
  '.webloc',
  '.wflow',
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
