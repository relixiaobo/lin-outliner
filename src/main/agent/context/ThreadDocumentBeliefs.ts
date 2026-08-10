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
import type { DocumentProjection, NodeProjection } from '../../../core/types';
import {
  beliefsFromToolResult,
  driftedNodes,
  DocumentBeliefSet,
  type DocumentDriftedNode,
} from './DocumentBeliefs';

export class ThreadDocumentBeliefs {
  private readonly byThread = new Map<ThreadId, DocumentBeliefSet>();

  /** Record whatever a tool result says about the document, if anything. */
  observe(threadId: ThreadId, tool: string, result: unknown): void {
    try {
      const beliefs = beliefsFromToolResult(tool, result);
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
   * Reporting a node is also forgetting it — the model is about to be told the
   * current state, so the belief has served its purpose, and keeping it would
   * make the next admission report the same drift again. What is NOT reported
   * keeps its belief and surfaces next time rather than being dropped on the
   * floor. Both numbers come from one traversal, so the count and the slice
   * cannot describe different moments.
   */
  takeDrift(
    threadId: ThreadId,
    projection: DocumentProjection | null,
    limit: number,
  ): { readonly reported: readonly DocumentDriftedNode[]; readonly total: number } {
    try {
      const set = this.byThread.get(threadId);
      if (!set || !projection) return { reported: [], total: 0 };
      const nodesById = new Map<string, NodeProjection>(projection.nodes.map((node) => [node.id, node]));
      const drifted = driftedNodes(set.beliefs(), nodesById);
      const reported = drifted.slice(-limit);
      set.forget(reported.map((entry) => entry.nodeId));
      return { reported, total: drifted.length };
    } catch (error) {
      console.warn(`[agent] Document drift was not computed for ${threadId}`, error);
      return { reported: [], total: 0 };
    }
  }

  forget(threadIds: readonly ThreadId[]): void {
    for (const threadId of threadIds) this.byThread.delete(threadId);
  }
}
