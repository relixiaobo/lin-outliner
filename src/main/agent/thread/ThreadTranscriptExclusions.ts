/**
 * Canonical recording exclusions, keyed by session ID and loaded synchronously
 * for publication eligibility. Forks start a new session. The plain ID list is
 * atomically replaced on change and retains its original storage location;
 * deleting or rebuilding the derived record tree must not reset user exclusions.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../../jsonFileStore';

const EXCLUSIONS_FILE = 'excluded.txt';

export class ThreadTranscriptExclusions {
  private readonly excluded = new Set<string>();

  constructor(private readonly recordRoot: string) {}

  private get path(): string {
    return join(this.recordRoot, EXCLUSIONS_FILE);
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
      await mkdir(this.recordRoot, { recursive: true });
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
