/**
 * Where a Thread's account layer lands on disk, and how it is named, extended,
 * and reclaimed.
 *
 * APP-OWNED STORAGE, NEVER THE WORKSPACE. Transcripts live under `userData`,
 * the pattern Claude Code and Codex both converge on. Git never sees them: no
 * gitignore entry to maintain, no workspace `file_glob`/`file_grep` noise, and
 * no path by which a secret echoed into a tool output becomes a committed file.
 * A reader still reads them with the existing `file_read` / `file_grep` — the
 * capability layer resolves absolute paths, so an app-owned location costs no
 * new tool and no permission change.
 *
 * APPEND-ONLY. A completed Turn is immutable in the event-sourced store, so the
 * artifact only ever grows by whole completed Turns. That is what makes a
 * concurrent read safe without locking: a reader either sees a Turn or does
 * not, never half of one. The rebuild path (cold cursor, or a file that
 * disagrees with it) goes through `atomicWriteFile` for the same reason —
 * tmp+rename, so readers see old-or-new and never a truncated file.
 *
 * Artifacts are disposable and rebuildable: canonical truth stays in the
 * rollout log and the payload store, and `agent:dump` can reproduce this text
 * for any Thread at any time.
 */
import { appendFile, mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ThreadId } from '../../../core/agent/protocol';
import { atomicWriteFile } from '../../jsonFileStore';

export const THREAD_TRANSCRIPT_DIRECTORY = 'thread-transcripts';
/**
 * The directory transcripts lived in while only delegated children had one.
 * Nothing computes this path any more, which is exactly why it must be reclaimed
 * rather than left alone: artifacts inside it are unreachable by the deletion
 * cascade and by the orphan sweep, so a Thread the user deletes would keep its
 * full record on disk with nothing left that could ever remove it.
 */
const LEGACY_SUBAGENT_TRANSCRIPT_DIRECTORY = 'subagent-transcripts';
const TRANSCRIPT_EXTENSION = '.md';

export function threadTranscriptRoot(userDataPath: string): string {
  return join(userDataPath, THREAD_TRANSCRIPT_DIRECTORY);
}

/**
 * `<transcriptRoot>/<threadId>.md`. The Thread id alone names the file: it is
 * globally unique, and it is derivable from the Thread record, so cleanup and
 * tooling can always reconstruct the path without consulting spawn metadata.
 */
export function threadTranscriptPath(transcriptRoot: string, threadId: ThreadId): string {
  return join(transcriptRoot, `${threadId}${TRANSCRIPT_EXTENSION}`);
}

/** Byte length of the artifact, or null when it does not exist. */
export async function threadTranscriptSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

export async function appendThreadTranscript(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, text, 'utf8');
}

export async function rebuildThreadTranscript(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, text);
}

export async function removeThreadTranscript(path: string): Promise<void> {
  await rm(path, { force: true });
}

/**
 * Startup reclamation. A11: the work queue is derived from disk, not from a
 * remembered list, so an interrupted sweep resumes correctly for free.
 * Accumulation here is an app-retention concern; git is never involved.
 */
export async function sweepOrphanTranscripts(
  transcriptRoot: string,
  isKnownThread: (threadId: ThreadId) => boolean,
): Promise<readonly string[]> {
  let entries: string[];
  try {
    entries = await readdir(transcriptRoot);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(TRANSCRIPT_EXTENSION)) continue;
    if (isKnownThread(entry.slice(0, -TRANSCRIPT_EXTENSION.length))) continue;
    const path = join(transcriptRoot, entry);
    try {
      await rm(path, { force: true });
      removed.push(path);
    } catch {
      // A retention miss is not worth failing startup over; the next sweep retries.
    }
  }
  return removed;
}

/**
 * Move the pre-rename artifacts under the current root, then drop the emptied
 * directory. The legacy directory is a sibling of the current root — both sit
 * directly under `userData` — so the root is the only path this needs.
 *
 * MOVE, DO NOT DELETE. Reclaiming the directory is necessary because after the
 * rename nothing computes that path, so neither the deletion cascade nor the
 * orphan sweep can reach inside it and a deleted Thread would keep its record
 * forever. But this is `userData` a released build already wrote: deleting would
 * destroy real conversation content, and a completed Thread never appends again,
 * so nothing would ever rebuild it. Relocating satisfies the reachability
 * requirement without spending the user's data — and the sweep that runs next
 * then reclaims exactly the ones whose Thread is gone, which is the outcome
 * deleting only appeared to produce.
 *
 * Best-effort and idempotent per A11: the queue is the directory listing, so an
 * interrupted run resumes for free and later launches find nothing to do.
 */
export async function reclaimLegacyTranscriptDirectory(transcriptRoot: string): Promise<readonly string[]> {
  const legacy = join(dirname(transcriptRoot), LEGACY_SUBAGENT_TRANSCRIPT_DIRECTORY);
  let entries: string[];
  try {
    entries = await readdir(legacy);
  } catch {
    return [];
  }
  const moved: string[] = [];
  await mkdir(transcriptRoot, { recursive: true });
  for (const entry of entries) {
    if (!entry.endsWith(TRANSCRIPT_EXTENSION)) continue;
    try {
      const target = join(transcriptRoot, entry);
      // The current root wins a collision: what this build wrote is the live
      // artifact, and the legacy copy under it is by definition the older one.
      if (await threadTranscriptSize(target) === null) {
        await rename(join(legacy, entry), target);
        moved.push(target);
      } else {
        await rm(join(legacy, entry), { force: true });
      }
    } catch {
      // One unmovable file is not worth failing startup over, and leaving it
      // keeps the directory non-empty so the next launch tries again.
    }
  }
  // Non-recursive on purpose: this removes the directory only once it is empty,
  // so a file this could not move is never destroyed as a side effect.
  await rmdir(legacy).catch(() => undefined);
  return moved;
}
