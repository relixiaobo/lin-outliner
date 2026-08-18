/**
 * Per-Thread beliefs about the document, and the drift check that runs at Turn
 * admission.
 *
 * Observation happens at the one place every tool result passes: a node the
 * model was just shown becomes a belief at the moment it was shown. There is no
 * per-tool hook, so a node tool added later is covered without remembering to
 * call anything — and `node_search`, whose arguments never say which nodes the
 * model saw, is covered like every other, because its RESULTS are the rendering.
 *
 * A12 throughout. A belief is inspection-only: failing to record one costs a
 * later hint, and failing to compare costs a notice. Neither may cost the Turn
 * that was running when it happened.
 */
import type { ThreadId } from '../../../core/agent/protocol';
import type { DocumentProjection } from '../../../core/types';
import { indexProjection } from '../capabilities/agentNodeToolProjection';
import {
  beliefsFromToolResult,
  currentBelief,
  type DocumentBelief,
  driftedNodes,
  DocumentBeliefSet,
  isBeliefBearingTool,
  type DocumentDriftedNode,
} from './DocumentBeliefs';

export class ThreadDocumentBeliefs {
  private readonly byThread = new Map<ThreadId, DocumentBeliefSet>();

  /** Record whatever a tool result says about the document, if anything. */
  /**
   * @param rebuild Beliefs derived from the Thread's canonical record, for a set
   * this process has not built yet — a restart, or a fork inheriting a history it
   * never observed live. It runs through the same `beliefsFromToolResult` over
   * the same persisted bytes, which is what makes "in-session" and "rebuilt" the
   * same set rather than two that have to be reconciled.
   */
  constructor(
    private readonly now: () => number,
    private readonly rebuild: (threadId: ThreadId) => Promise<readonly DocumentBelief[]>,
  ) {}

  observe(threadId: ThreadId, tool: string, result: unknown, projection: DocumentProjection | null): void {
    try {
      if (!isBeliefBearingTool(tool)) return;
      const beliefs = beliefsFromToolResult(
        tool,
        result,
        projection ? indexProjection(projection) : null,
        this.now(),
      );
      if (beliefs.length === 0) return;
      const set = this.byThread.get(threadId) ?? new DocumentBeliefSet();
      set.record(beliefs);
      this.byThread.set(threadId, set);
    } catch (error) {
      console.warn(`[agent] Document belief was not recorded for ${threadId}`, error);
    }
  }

  /**
   * The beliefs that no longer hold: the newest `limit` of them to report, and
   * how many there were in total so the tail line can be honest.
   *
   * READ-ONLY. Settling is a separate call the caller makes only once the Turn
   * carrying the notice is durably recorded: admission can still throw after
   * this — a payload write, an asset resolution — and consuming the drift here
   * would mean the user's retry finds nothing left to report and the model
   * proceeds unaware the edit landed.
   *
   * Settling UPDATES a reported node's belief to what the model was just handed
   * — it does not drop it. Dropping was the earlier mistake and it inverted the whole
   * feature: the host stopped tracking a node the moment it told the model that
   * node's content, so a second edit while the Thread sat idle went unreported
   * and the model answered from, or wrote over, the version it had been given.
   * A node reported as gone is the one exception: there is nothing left to track.
   *
   * What is NOT reported keeps its belief and surfaces next time rather than
   * being dropped on the floor. Both numbers come from one traversal, so the
   * count and the slice cannot describe different moments.
   */
  async peekDrift(
    threadId: ThreadId,
    projection: DocumentProjection | null,
    limit: number,
  ): Promise<{ readonly reported: readonly DocumentDriftedNode[]; readonly total: number }> {
    try {
      if (!projection) return { reported: [], total: 0 };
      const set = await this.setFor(threadId);
      if (!set) return { reported: [], total: 0 };
      const drifted = driftedNodes(set.beliefs(), projection);
      return { reported: drifted.slice(-limit), total: drifted.length };
    } catch (error) {
      console.warn(`[agent] Document drift was not computed for ${threadId}`, error);
      return { reported: [], total: 0 };
    }
  }

  /**
   * Bring the reported nodes' beliefs up to what the model was just told, so the
   * next admission measures drift from there rather than from a version the
   * model no longer holds.
   */
  /**
   * The Thread's set, rebuilt from the record when this process has not built it
   * — which is what makes a restart and a fork need no special case. A rebuild
   * that fails yields an empty set rather than an exception: the notice is worth
   * less than the Turn.
   */
  private async setFor(threadId: ThreadId): Promise<DocumentBeliefSet | null> {
    const existing = this.byThread.get(threadId);
    if (existing) return existing;
    const set = new DocumentBeliefSet();
    try {
      set.record(await this.rebuild(threadId));
    } catch (error) {
      console.warn(`[agent] Document beliefs were not rebuilt for ${threadId}`, error);
    }
    this.byThread.set(threadId, set);
    return set;
  }

  settleReported(
    threadId: ThreadId,
    projection: DocumentProjection | null,
    reported: readonly DocumentDriftedNode[],
  ): void {
    try {
      const set = this.byThread.get(threadId);
      if (!set || !projection || reported.length === 0) return;
      this.settle(set, projection, reported);
    } catch (error) {
      console.warn(`[agent] Document beliefs were not settled for ${threadId}`, error);
    }
  }

  private settle(
    set: DocumentBeliefSet,
    projection: DocumentProjection,
    reported: readonly DocumentDriftedNode[],
  ): void {
    const index = indexProjection(projection);
    const gone: string[] = [];
    for (const entry of reported) {
      const existing = set.beliefs().find((belief) => belief.nodeId === entry.nodeId);
      // The belief is now as of THIS moment: the model has just been handed the
      // current content, so that is when it came to believe it.
      const refreshed = existing ? currentBelief(index, entry.nodeId, existing.basis, this.now()) : null;
      if (entry.kind === 'gone' || !refreshed) gone.push(entry.nodeId);
      else set.record([refreshed]);
    }
    set.forget(gone);
  }

/**
   * Release a Thread's beliefs, called with the rest of its in-session
   * coordination state when the Thread stops or is deleted.
   *
   * The set is only useful to a Thread that will admit another Turn, and the
   * rebuild path is what makes letting go of it safe — a Thread that runs again
   * reconstructs it from its record. Holding it for the process lifetime made a
   * long session's memory grow with every Thread that ever read a node, one
   * broad search adding fifty at a time.
   */
  forget(threadIds: readonly ThreadId[]): void {
    for (const threadId of threadIds) this.byThread.delete(threadId);
  }
}
