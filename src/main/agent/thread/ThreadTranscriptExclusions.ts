/**
 * Which Threads the user has taken out of the records.
 *
 * The state lives beside the records it governs rather than on the Thread
 * record. Whether a conversation is kept in readable form is a property of this
 * subsystem, not of the conversation's identity, and the subsystem's other
 * questions — what exists, what to sweep, what to index — are all already
 * answered by this directory. Keeping the switch here means one place answers
 * all of them, and the writer, the sweep and the index need no store read to
 * agree.
 *
 * KEYED BY SESSION, NOT BY THREAD. Excluding a conversation has to cover the
 * work it delegated: a root's Subagents write their own artifacts, and leaving
 * those behind would keep the excluded content readable and, worse, keep
 * advertising it in the index. Every Thread in a delegation subtree shares one
 * `sessionId`, so one entry covers the subtree and the check stays O(1) on the
 * turn-completion path — a parent walk would be a store read per Turn. A fork
 * starts a new session, which is right: it is a new conversation.
 *
 * It is a plain list of session ids, loaded once at startup and rewritten whole
 * and atomically on change. Exclusion has to be answerable SYNCHRONOUSLY — the
 * subject is resolved on the turn-completion path — so the set is held in
 * memory, and the file is only how it survives a restart.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../../jsonFileStore';

const EXCLUSIONS_FILE = 'excluded.txt';

export class ThreadTranscriptExclusions {
  private readonly excluded = new Set<string>();

  constructor(private readonly transcriptRoot: string) {}

  private get path(): string {
    return join(this.transcriptRoot, EXCLUSIONS_FILE);
  }

  /**
   * A12: an unreadable list means nothing is excluded, which errs toward
   * recording rather than toward silently dropping records the user still
   * expects. The alternative — refusing to start — is worse for a preference
   * file, and the next write repairs it.
   */
  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      this.excluded.clear();
      for (const line of text.split('\n')) {
        const id = line.trim();
        if (id && !id.startsWith('#')) this.excluded.add(id);
      }
    } catch {
      this.excluded.clear();
    }
  }

  isExcluded(sessionId: string): boolean {
    return this.excluded.has(sessionId);
  }

  /**
   * Record the choice, then report whether it changed anything. The caller owns
   * what follows — removing an artifact, restoring the writer — because those
   * belong to the writer, not to a preference.
   */
  async setExcluded(sessionId: string, excluded: boolean): Promise<boolean> {
    if (this.excluded.has(sessionId) === excluded) return false;
    if (excluded) this.excluded.add(sessionId);
    else this.excluded.delete(sessionId);
    await this.persist();
    return true;
  }

  /** Deletion takes the conversation with it; keeping its id here would leak forever. */
  async forget(sessionIds: readonly string[]): Promise<void> {
    let changed = false;
    for (const sessionId of sessionIds) changed = this.excluded.delete(sessionId) || changed;
    if (changed) await this.persist();
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(this.transcriptRoot, { recursive: true });
      await atomicWriteFile(this.path, `${[
        '# Sessions excluded from the transcript records, one id per line.',
        ...[...this.excluded].sort(),
      ].join('\n')}\n`);
    } catch (error) {
      // The in-memory set is already authoritative for this session, so the
      // user's choice holds now and is only at risk of being forgotten across a
      // restart. Failing their action over that would be the worse trade (A12).
      console.warn('[agent] Thread transcript exclusions were not persisted', error);
    }
  }
}
