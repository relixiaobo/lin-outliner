/**
 * The terminal transcript artifact: where a delegated child's account layer
 * lands on disk, and how it is named and removed.
 *
 * The file lives under the child's own working directory — children copy the
 * parent's `cwd`, so the parent reads it with the existing `file_read` /
 * `file_grep` and no capability is widened for the account layer.
 *
 * Artifacts are disposable and rebuildable: canonical truth stays in the
 * rollout log and the payload store, and `agent:dump` can reproduce this text
 * for any Thread at any time.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ThreadId } from '../../../core/agent/protocol';

export const SUBAGENT_TRANSCRIPT_DIRECTORY = 'subagent-transcripts';

/**
 * `<cwd>/subagent-transcripts/<task-path-with-dashes>-<thread suffix>.md`.
 *
 * The task path alone is unique only WITHIN a session, and sibling sessions
 * share one workspace `cwd` — so the Thread id suffix is what actually keeps
 * two concurrent `/root/audit` children from overwriting each other's account.
 * It is derived, not random: re-materializing the same child always resolves to
 * the same path, which is what makes the write idempotent after a crash.
 */
export function subagentTranscriptPath(cwd: string, taskPath: string, threadId: ThreadId): string {
  const slug = taskPath.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'subagent';
  const suffix = threadId.replace(/-/g, '').slice(-12);
  return join(cwd, SUBAGENT_TRANSCRIPT_DIRECTORY, `${slug}-${suffix}.md`);
}

/** Overwrites by path, so a re-run after a crash converges instead of piling up. */
export async function writeSubagentTranscript(
  path: string,
  transcript: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, transcript, 'utf8');
}

export async function removeSubagentTranscript(path: string): Promise<void> {
  await rm(path, { force: true });
}
