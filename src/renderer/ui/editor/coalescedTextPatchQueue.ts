import type { RichText, RichTextPatch } from '../../api/types';
import { replaceAllRichTextPatch } from '../../api/types';

interface QueuedTextPatch {
  key: string;
  patch: RichTextPatch;
  send: (patch: RichTextPatch) => Promise<unknown>;
}

/**
 * Keeps editor input local while bounding persistence to one in-flight write.
 * Consecutive edits for the same target collapse to one latest-state replace.
 */
export class CoalescedTextPatchQueue {
  private active = false;
  private queued: QueuedTextPatch[] = [];
  private idlePromise: Promise<void> = Promise.resolve();

  isBusy(): boolean {
    return this.active;
  }

  waitForIdle(): Promise<void> {
    return this.idlePromise;
  }

  enqueue(input: {
    key: string;
    patch: RichTextPatch;
    latestContent: RichText;
    send: (patch: RichTextPatch) => Promise<unknown>;
  }): Promise<void> {
    if (!this.active) {
      this.active = true;
      this.idlePromise = this.drain({
        key: input.key,
        patch: input.patch,
        send: input.send,
      });
      // Callers may observe waitForIdle(), but enqueue itself must never create an
      // unhandled rejection if an unexpected sender failure occurs.
      void this.idlePromise.catch(() => undefined);
      return this.idlePromise;
    }

    const replacement: QueuedTextPatch = {
      key: input.key,
      patch: replaceAllRichTextPatch(input.latestContent),
      send: input.send,
    };
    const tail = this.queued.at(-1);
    if (tail?.key === input.key) this.queued[this.queued.length - 1] = replacement;
    else this.queued.push(replacement);
    return this.idlePromise;
  }

  private async drain(first: QueuedTextPatch): Promise<void> {
    let current: QueuedTextPatch | undefined = first;
    let firstError: unknown;
    try {
      while (current) {
        try {
          await current.send(current.patch);
        } catch (error) {
          firstError ??= error;
        }
        current = this.queued.shift();
      }
    } finally {
      this.active = false;
    }
    if (firstError !== undefined) throw firstError;
  }
}
