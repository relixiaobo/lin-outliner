import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Thread } from '../../../core/agent/protocol';
import type { ThreadRecoveryPreview } from '../../../core/threadRecovery';
import { RolloutStore, type RolloutEntry } from '../persistence/RolloutStore';
import { ThreadHistoryProjectionStore } from '../persistence/ThreadHistoryProjectionStore';
import type { ThreadCore } from '../thread/ThreadCore';
import type { SqliteDatabase } from '../persistence/sqlite';
import { missing, recoveryDigest, type RecoveryEvidence } from './RecoveryEvidence';

export async function inspectRecoverySource(core: ThreadCore, thread: Thread): Promise<{
  readonly source: ThreadRecoveryPreview['source']; readonly unavailable: string | null;
}> {
  try {
    const entries = await core.rollout.readForRecovery(thread.id);
    const first = entries[0]?.event;
    if (!first || (first.type !== 'thread/started' && first.type !== 'history/recovered')) throw new Error('Rollout has no complete source preface');
    if (core.history.watermark(thread.id).ordinal >= entries.length) throw new Error('Rollout is shorter than the retained projection');
    verifyRecoveryHistory(thread.id, entries);
    return { source: 'rollout', unavailable: null };
  } catch {
    try {
      const snapshot = core.history.rolloutSnapshot(thread.id);
      if (!snapshot.length) throw new Error('Empty projection cannot prove a complete conversation source');
      verifyRecoveryHistory(thread.id, snapshot.map((record, ordinal) => ({ ...record, ordinal, byteOffset: ordinal, byteLength: 1 })));
      return { source: 'history-projection', unavailable: null };
    } catch {
      return { source: null, unavailable: 'Neither the original rollout nor the retained projection proves a complete settled conversation. Original evidence can still be retained during eligible removal.' };
    }
  }
}

export function verifyRecoveryHistory(threadId: string, entries: readonly RolloutEntry[], database?: SqliteDatabase): void {
  const staged = new ThreadHistoryProjectionStore(':memory:', database);
  try {
    if (entries.some((entry, ordinal) => entry.ordinal !== ordinal || entry.event.threadId !== threadId)) {
      throw new Error('Recovery source ordering or owner is invalid');
    }
    staged.rebuildThread(threadId, entries);
    let cursor: string | null = null;
    do {
      const page = staged.listTurns({ threadId, cursor, limit: 100, itemsView: 'full' });
      if (page.data.some((turn) => turn.status === 'inProgress')) throw new Error('Recovery source contains an unsettled Turn');
      cursor = page.nextCursor;
    } while (cursor);
  } finally { staged.close(); }
}

export async function recoveryRolloutDigests(core: ThreadCore, threadIds: readonly string[]): Promise<readonly unknown[]> {
  return Promise.all(threadIds.map(async (id) => {
    try { return { id, digest: recoveryDigest((await readFile(core.rollout.pathFor(id))).toString('base64')) }; }
    catch (error) { if (missing(error)) return { id, digest: null }; throw error; }
  }));
}

export async function retainRecoverySource(core: ThreadCore, threadId: string,
  source: Exclude<ThreadRecoveryPreview['source'], null>, evidence: RecoveryEvidence): Promise<void> {
  let entries: readonly RolloutEntry[];
  if (source === 'rollout') {
    entries = await core.rollout.readForRecovery(threadId);
    await evidence.file('source-rollout.jsonl', core.rollout.pathFor(threadId));
  } else {
    const path = join(evidence.root, 'staging');
    const staged = new RolloutStore(path);
    try {
      // A prior interrupted retention can be regenerated before mutation begins.
      await staged.delete(threadId);
      entries = await staged.restoreMissing(threadId, core.history.rolloutSnapshot(threadId));
      await staged.flush();
      await evidence.file('source-rollout.jsonl', staged.pathFor(threadId));
    } finally { await staged.flush(); await rm(path, { recursive: true, force: true }); }
  }
  verifyRecoveryHistory(threadId, entries);
  await evidence.json('source-entries.json', entries);
}
