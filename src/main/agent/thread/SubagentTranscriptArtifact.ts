/**
 * Where a delegated child's account layer lands on disk, and how it is named,
 * extended, and reclaimed.
 *
 * APP-OWNED STORAGE, NEVER THE WORKSPACE. Transcripts live under `userData`,
 * the pattern Claude Code and Codex both converge on. Git never sees them: no
 * gitignore entry to maintain, no workspace `file_glob`/`file_grep` noise, and
 * no path by which a secret echoed into a tool output becomes a committed file.
 * The parent still reads them with the existing `file_read` / `file_grep` —
 * the capability layer resolves absolute paths, so an app-owned location costs
 * no new tool and no permission change.
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
import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ThreadId } from '../../../core/agent/protocol';
import { atomicWriteFile } from '../../jsonFileStore';

export const SUBAGENT_TRANSCRIPT_DIRECTORY = 'subagent-transcripts';
const TRANSCRIPT_EXTENSION = '.md';

export function subagentTranscriptRoot(userDataPath: string): string {
  return join(userDataPath, SUBAGENT_TRANSCRIPT_DIRECTORY);
}

/**
 * `<transcriptRoot>/<threadId>.md`. The Thread id alone names the file: it is
 * globally unique, and it is derivable from the Thread record, so cleanup and
 * tooling can always reconstruct the path without consulting spawn metadata.
 */
export function subagentTranscriptPath(transcriptRoot: string, threadId: ThreadId): string {
  return join(transcriptRoot, `${threadId}${TRANSCRIPT_EXTENSION}`);
}

/** Byte length of the artifact, or null when it does not exist. */
export async function subagentTranscriptSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

export async function appendSubagentTranscript(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, text, 'utf8');
}

export async function rebuildSubagentTranscript(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, text);
}

export async function removeSubagentTranscript(path: string): Promise<void> {
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
