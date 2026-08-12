/**
 * The account layer's writer: one Thread's completed Turns, appended to one
 * readable artifact.
 *
 * ONE ANSWER TO "DOES THIS THREAD KEEP AN ACCOUNT". `resolveSubject` is that
 * answer and also the artifact's header — null means the Thread materializes
 * nothing. The two cannot drift apart, because they are the same call. This
 * used to be two independent answers (a `parentThreadId` check when a Turn was
 * enqueued, a spawn-edge lookup when it was appended), which is the shape two
 * answers eventually disagree in.
 *
 * The subject is resolved ONCE, when the Turn is enqueued, and carried down the
 * chain. Deletion is what un-materializes a Thread, and it is ordered to make
 * that safe: mark discarded, drain, then remove.
 */
import type { Thread, ThreadId, Turn, TurnId } from '../../../core/agent/protocol';
import {
  appendThreadTranscript,
  reclaimLegacyTranscriptDirectory,
  rebuildThreadTranscript,
  removeThreadTranscript,
  threadTranscriptPath,
  threadTranscriptSize,
  sweepOrphanTranscripts,
} from './ThreadTranscriptArtifact';
import { renderTranscript, renderTurn, type TranscriptPayloadReader, type TranscriptSubject } from './TranscriptRenderer';

/**
 * Ceiling on any filesystem wait the account layer puts in front of a reader.
 * Long enough that an ordinary slow volume still answers accurately, short
 * enough that a wedged one is a hiccup rather than a parked Turn.
 */
const TRANSCRIPT_READY_TIMEOUT_MS = 2_000;

interface TranscriptCursor {
  readonly turns: number;
  readonly bytes: number;
  /** Every Turn already in the file — not just the last, so a rebuild dedups what is queued behind it. */
  readonly turnIds: ReadonlySet<TurnId>;
}

export interface ThreadTranscriptWriterOptions {
  readonly transcriptRoot: string;
  /** Null when this Thread keeps no account; otherwise the artifact's header. */
  readonly resolveSubject: (thread: Thread) => TranscriptSubject | null;
  /** Every Turn of the Thread that is no longer running, in canonical order. */
  readonly completedTurns: (threadId: ThreadId) => readonly Turn[];
  readonly payloads: (threadId: ThreadId) => TranscriptPayloadReader;
  /**
   * The set of artifacts on disk changed. The writer does not know what anyone
   * derives from that set — it just says when the set moved, which is what keeps
   * the index out of this file and the direction of knowledge one-way.
   */
  readonly onArtifactsChanged?: () => void;
}

export class ThreadTranscriptWriter {
  /** Per Thread: how much of its account is already on disk. Compared against the file, never trusted alone. */
  private readonly cursors = new Map<ThreadId, TranscriptCursor>();
  /** Per Thread: the tail of its serialized append chain, so Turns land in order and deletion can drain it. */
  private readonly writes = new Map<ThreadId, Promise<void>>();
  /** Threads whose artifact was deleted. Thread ids are never reused, so this only ever grows by real deletions. */
  private readonly discarded = new Set<ThreadId>();

  constructor(private readonly options: ThreadTranscriptWriterOptions) {}

  /**
   * Serialize per Thread so Turns append in completion order, and so deletion
   * has one handle to drain. The chain never rejects: `appendTurn` owns the A12
   * guard, and this is deliberately not awaited by the Turn that produced it.
   *
   * THIS IS CALLED ON THE TURN-COMPLETION PATH, SYNCHRONOUSLY. `resolveSubject`
   * reads a store (a delegated subject is a spawn-edge lookup), so it has to be
   * guarded HERE and not only inside the chain: a throw escaping this call would
   * abandon the rest of the completion tail — the parent-visible activity row and
   * the idle notification — and a parent waiting on that child would park until
   * its own deadline. A12 exactly: the account is inspection-only and degrades,
   * the user's Turn does not die for it.
   */
  enqueueTurn(thread: Thread, turn: Turn): void {
    let subject: TranscriptSubject | null;
    try {
      subject = this.options.resolveSubject(thread);
    } catch (error) {
      console.warn(`[agent] Thread transcript subject was not resolved for ${thread.id}`, error);
      return;
    }
    if (!subject) return;
    const pending = (this.writes.get(thread.id) ?? Promise.resolve())
      .then(() => this.appendTurn(thread.id, subject, turn));
    this.writes.set(thread.id, pending);
    void pending.finally(() => {
      if (this.writes.get(thread.id) === pending) this.writes.delete(thread.id);
    });
  }

  /**
   * Resolve the artifact's path for a reader, waiting on the Thread's own
   * append chain so a Turn that just completed is durable before its path is
   * reported.
   *
   * Every wait is DEADLINE-BOUNDED. A12 protects against a throwing filesystem,
   * but not against a wedged one — an fs promise that never settles would park
   * the waiting Turn forever, which is precisely the failure mode A12 exists to
   * prevent. On timeout the in-session cursor decides: if this process appended
   * a Turn, the artifact exists and the path is reported anyway; otherwise null.
   * A stalled volume then costs the account layer accuracy, never the reader its
   * result (A12), and never more than the deadline in latency (A9).
   */
  async pathForReader(threadId: ThreadId): Promise<string | null> {
    try {
      const path = threadTranscriptPath(this.options.transcriptRoot, threadId);
      await settledWithin(this.writes.get(threadId), TRANSCRIPT_READY_TIMEOUT_MS);
      // A Turn appended in this process is known to be on disk: no stat needed
      // on the common path, which is also the one a reader waits on.
      if (this.cursors.has(threadId)) return path;
      const size = await withDeadline(threadTranscriptSize(path), TRANSCRIPT_READY_TIMEOUT_MS, null);
      return size === null ? null : path;
    } catch (error) {
      console.warn(`[agent] Thread transcript artifact was not resolved for ${threadId}`, error);
      return null;
    }
  }

  /**
   * Stable destination for a delegated transcript, even before its first Turn
   * has settled. The Agent launch contract exposes this path immediately; the
   * writer will materialize that same artifact when completion is appended.
   */
  pathForPendingReader(threadId: ThreadId): string {
    return threadTranscriptPath(this.options.transcriptRoot, threadId);
  }

  /**
   * Best-effort removal, driven by the Thread-deletion descendant cascade.
   *
   * The order is the whole point. Mark the Thread discarded FIRST so nothing new
   * enqueues, then drain the append chain so an append already past its guard and
   * awaiting payload reads finishes BEFORE the `rm` — otherwise it lands behind
   * the removal and resurrects a transcript the user deleted. This owns the chain
   * entry's removal for the same reason: clearing it elsewhere first would leave
   * this draining `undefined`, which is a no-op wearing a drain's clothes.
   *
   * A drain that TIMES OUT is not a drain that finished, and the two must not be
   * confused: an append merely slow in a payload read would otherwise still be
   * running when the `rm` lands and would write the file back afterwards, leaving
   * the deleted Thread's content on disk until the next launch's sweep. So the
   * timeout keeps the chain handle, and the write side re-checks `discarded`
   * immediately before touching the file — only the second one closes the window
   * completely.
   */
  async delete(threadId: ThreadId): Promise<void> {
    this.discarded.add(threadId);
    try {
      const settled = await settledWithin(this.writes.get(threadId), TRANSCRIPT_READY_TIMEOUT_MS);
      if (settled) this.writes.delete(threadId);
      this.cursors.delete(threadId);
      await removeThreadTranscript(threadTranscriptPath(this.options.transcriptRoot, threadId));
      this.options.onArtifactsChanged?.();
    } catch (error) {
      console.warn(`[agent] Thread transcript artifact was not removed for ${threadId}`, error);
    }
  }

  /**
   * Let a Thread keep records again after its artifact was removed on purpose.
   *
   * `discarded` is permanent for a DELETED Thread — ids are never reused, so it
   * only ever grows by real deletions — but an exclusion the user turns back off
   * is not a deletion, and without this the Thread would stay silently unwritable
   * for the rest of the session.
   */
  restore(threadId: ThreadId): void {
    this.discarded.delete(threadId);
  }

  /**
   * Materialize a Thread's whole record now, from canonical history.
   *
   * Re-including a conversation cannot wait for its next completed Turn: a
   * finished one will never have another, so the artifact would stay missing
   * while the UI reported the record as restored. Resolving the subject first
   * keeps the one-predicate rule — a Thread that no longer qualifies (still
   * excluded, ephemeral) rebuilds nothing.
   */
  async rebuildNow(thread: Thread): Promise<void> {
    let subject: TranscriptSubject | null;
    try {
      subject = this.options.resolveSubject(thread);
    } catch (error) {
      console.warn(`[agent] Thread transcript subject was not resolved for ${thread.id}`, error);
      return;
    }
    if (!subject) return;
    const pending = (this.writes.get(thread.id) ?? Promise.resolve()).then(async () => {
      try {
        await this.rebuild(thread.id, subject, threadTranscriptPath(this.options.transcriptRoot, thread.id));
      } catch (error) {
        console.warn(`[agent] Thread transcript was not rebuilt for ${thread.id}`, error);
      }
    });
    this.writes.set(thread.id, pending);
    void pending.finally(() => {
      if (this.writes.get(thread.id) === pending) this.writes.delete(thread.id);
    });
    await pending;
  }

  /** Startup reclamation of transcripts whose Thread no longer exists. */
  async sweepOrphans(isKnownThread: (threadId: ThreadId) => boolean): Promise<readonly string[]> {
    try {
      return await sweepOrphanTranscripts(this.options.transcriptRoot, isKnownThread);
    } catch (error) {
      console.warn('[agent] Thread transcript orphan sweep failed', error);
      return [];
    }
  }

  /**
   * Reclaim the pre-rename directory at startup, BEFORE the sweep: a relocated
   * artifact whose Thread is gone should be reclaimed on this launch rather than
   * waiting for the next one. For the same A12 reason as the sweep, it can only
   * log — startup does not fail over retention.
   */
  async reclaimLegacyDirectory(): Promise<readonly string[]> {
    try {
      return await reclaimLegacyTranscriptDirectory(this.options.transcriptRoot);
    } catch (error) {
      console.warn('[agent] Legacy transcript directory was not reclaimed', error);
      return [];
    }
  }

  /**
   * Drop the in-session cursor during coordination teardown. The append chain is
   * deliberately NOT dropped here: deletion drains it afterwards, and a chain
   * removed early cannot be drained. The chain removes its own entry when it
   * settles.
   */
  forgetCursor(threadId: ThreadId): void {
    this.cursors.delete(threadId);
  }

  /** Test seam: settle a Thread's pending appends. */
  async flush(threadId: ThreadId): Promise<void> {
    await this.writes.get(threadId);
  }

  /**
   * Extend the account by exactly the Turn that just completed.
   *
   * A completed Turn is immutable, so appending is monotonic and never rewrites
   * what a reader may already be reading. That is what dissolves both staleness
   * (nothing cached can go stale — history is never re-rendered) and write
   * atomicity (a concurrent read sees a whole-Turn prefix, never a torn file).
   *
   * A12 covers the WHOLE body, reads included: a store or payload read that
   * throws here must not escape into the Turn that produced it.
   */
  private async appendTurn(threadId: ThreadId, subject: TranscriptSubject, turn: Turn): Promise<void> {
    try {
      // Scoped to DELETION, not to any subtree stop. Stop and archive keep the
      // artifact, and the Turn they interrupt is the Thread's last one — skipping
      // it would leave a retained transcript ending mid-task while the store says
      // interrupted, with no later Turn to heal it.
      if (this.discarded.has(threadId)) return;
      const path = threadTranscriptPath(this.options.transcriptRoot, threadId);
      const cursor = this.cursors.get(threadId);
      // Membership, not "was it the last one": a rebuild folds in EVERY completed
      // Turn, so Turns still queued behind it are already on disk and re-appending
      // them would duplicate blocks under wrong ordinals.
      if (cursor?.turnIds.has(turn.id)) return;
      const size = cursor ? await threadTranscriptSize(path) : null;
      // Cold cursor, a removed file, or bytes that disagree with what we
      // appended: rebuild once, atomically, and resume appending from there.
      if (!cursor || size !== cursor.bytes) {
        await this.rebuild(threadId, subject, path);
        return;
      }
      const text = await renderTurn(turn, this.options.payloads(threadId), {
        detail: 'brief',
        ordinal: cursor.turns + 1,
      });
      // The last moment before the bytes land. Every await above (payload reads,
      // a size stat) is a window in which the user could have deleted this Thread
      // and its `rm` could already have run.
      if (this.discarded.has(threadId)) return;
      await appendThreadTranscript(path, text);
      this.cursors.set(threadId, {
        turns: cursor.turns + 1,
        bytes: cursor.bytes + Buffer.byteLength(text),
        turnIds: new Set(cursor.turnIds).add(turn.id),
      });
      this.options.onArtifactsChanged?.();
    } catch (error) {
      console.warn(`[agent] Thread transcript Turn was not appended for ${threadId}`, error);
    }
  }

  private async rebuild(threadId: ThreadId, subject: TranscriptSubject, path: string): Promise<void> {
    const turns = this.options.completedTurns(threadId);
    const text = await renderTranscript(turns, this.options.payloads(threadId), {
      detail: 'brief',
      subject,
    });
    if (this.discarded.has(threadId)) return;
    await rebuildThreadTranscript(path, text);
    this.cursors.set(threadId, {
      turns: turns.length,
      bytes: Buffer.byteLength(text),
      turnIds: new Set(turns.map((turn) => turn.id)),
    });
    this.options.onArtifactsChanged?.();
  }
}

/**
 * Any persistent root Thread, and null for everything else.
 *
 * The predicate needs no per-kind knowledge, which is the point: a root that is
 * not ephemeral keeps a record whether it is a user's conversation, an
 * Automation run, or a feature source that does not exist yet. Feature 1 needed
 * an Automation-shaped predicate and it lived beside the automations module for
 * that reason; generalizing dissolves the special case rather than moving it.
 * Ephemeral Threads — including the hidden memory-consolidation ones — are
 * excluded here, so no internal Thread materializes by accident.
 *
 * `name` is the name at the moment the header is written, and a header cannot be
 * revised once the file has grown past it. The index carries the live name; this
 * is the one it had when it first said something.
 */
export function rootTranscriptSubject(thread: Thread): TranscriptSubject | null {
  if (thread.ephemeral || thread.parentThreadId !== null) return null;
  return {
    threadId: thread.id,
    source: thread.threadSource,
    name: thread.name,
    cwd: thread.cwd,
  };
}

async function withDeadline<T>(work: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Await a bounded settle. "No chain" counts as settled — there was nothing to
 * wait for — but a TIMEOUT does not: a caller that has to know whether the work
 * is still running gets to tell the two apart.
 */
async function settledWithin(work: Promise<unknown> | undefined, timeoutMs: number): Promise<boolean> {
  if (work === undefined) return true;
  return withDeadline(work.then(() => true, () => true), timeoutMs, false);
}
