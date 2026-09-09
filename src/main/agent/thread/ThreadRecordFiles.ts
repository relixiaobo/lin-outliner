import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Thread, ThreadId } from '../../../core/agent/protocol';

export const THREAD_RECORD_DIRECTORY = 'thread-records';
export function threadRecordRoot(userDataPath: string): string {
  return join(userDataPath, THREAD_RECORD_DIRECTORY);
}
export function threadRecordPath(root: string, threadId: ThreadId): string {
  return join(root, threadId, 'record.md');
}
export function recordEligible(thread: Thread): boolean {
  return !thread.ephemeral && thread.parentThreadId === null && thread.threadSource !== 'delegation';
}
export async function threadRecordSize(filePath: string): Promise<number | null> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return null;
  }
}
export async function sweepOrphanRecords(
  root: string,
  known: (id: ThreadId) => boolean,
): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || known(entry.name as ThreadId)) continue;
    const target = join(root, entry.name);
    try {
      await rm(target, { recursive: true, force: true });
      removed.push(target);
    } catch {
      /* Next startup retries retained derived directories. */
    }
  }
  return removed;
}
