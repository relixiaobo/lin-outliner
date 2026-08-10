/**
 * What this Thread was shown about the document, and whether it is still true.
 *
 * THE BELIEF IS THE REVISION THE MODEL ALREADY SAW. `node_read` returns
 * `items[].revision` and `node_search` returns `items[].updatedAt`, both of which
 * are the token `revisionOf` produces and the token `node_edit` compares for its
 * expected-revision check. So this layer invents no notion of "changed": the
 * question the write path asks about a revision the model sends back is the
 * question this asks about a revision the host remembered on its behalf. One
 * token, one meaning, two directions.
 *
 * That also settles what a belief is derived FROM. Beliefs are extracted from
 * tool result data by `beliefsFromToolResult`, and that one function serves both
 * the live path (called with the fresh result) and the rebuild path (called with
 * the same result decoded from its persisted payload). Live and rebuilt sets
 * cannot disagree, because they are the same extraction over the same bytes.
 *
 * NO CAP AND NO EVICTION POLICY of its own: the set is a projection of the
 * canonical record, so it inherits the record's bounds — payload pruning and
 * compaction — rather than introducing a number invented here.
 */
import type { NodeProjection } from '../../../core/types';
import { revisionOf } from '../capabilities/agentNodeToolProjection';

/** The node tools whose results say something about a node's current state. */
const BELIEF_BEARING_TOOLS = new Set(['node_read', 'node_search', 'node_edit', 'node_create']);

export interface DocumentBelief {
  readonly nodeId: string;
  /** `${nodeId}:${updatedAt}` — the same token the expected-revision check compares. */
  readonly revision: string;
}

export type DocumentDriftKind = 'changed' | 'gone';

export interface DocumentDriftedNode {
  readonly nodeId: string;
  readonly kind: DocumentDriftKind;
  /** The node as it is NOW, or null when it is gone. */
  readonly node: NodeProjection | null;
}

/**
 * Every belief a node tool's result expresses.
 *
 * Reads and searches state what the model was shown; edits state what it left
 * behind, and a Thread's own edit is a belief like any other — it is what the
 * model will answer from until something changes it. Unknown shapes yield
 * nothing rather than throwing: this runs behind a tool call and behind a
 * rebuild, and neither may fail over an unrecognised payload.
 */
export function beliefsFromToolResult(tool: string, result: unknown): readonly DocumentBelief[] {
  if (!BELIEF_BEARING_TOOLS.has(tool)) return [];
  const data = (result as { data?: unknown } | null)?.data;
  if (!isRecord(data)) return [];
  const beliefs: DocumentBelief[] = [];
  // node_read: items carry the revision token directly.
  for (const item of arrayOf(data.items)) {
    if (!isRecord(item)) continue;
    const nodeId = stringOf(item.nodeId);
    if (!nodeId) continue;
    const revision = stringOf(item.revision)
      // node_search reports `updatedAt` instead, which is the same fact under
      // another name — the token is derived rather than stored twice.
      ?? (stringOf(item.updatedAt) === undefined ? undefined : `${nodeId}:${stringOf(item.updatedAt)}`);
    if (revision) beliefs.push({ nodeId, revision });
  }
  // node_edit / node_create: an explicit map of what the mutation left behind.
  if (isRecord(data.revisions)) {
    for (const [nodeId, revision] of Object.entries(data.revisions)) {
      if (typeof revision === 'string' && revision) beliefs.push({ nodeId, revision });
    }
  }
  return beliefs;
}

/**
 * The beliefs that no longer hold, against the document as it is now.
 *
 * Order follows the belief set's own order — most recently observed last — and
 * the caller decides how many to carry. A node the projection does not have is
 * `gone`, which is the highest-signal outcome and the one a re-read cannot
 * recover on its own.
 */
export function driftedNodes(
  beliefs: Iterable<DocumentBelief>,
  nodesById: ReadonlyMap<string, NodeProjection>,
): readonly DocumentDriftedNode[] {
  const drifted: DocumentDriftedNode[] = [];
  for (const belief of beliefs) {
    const node = nodesById.get(belief.nodeId);
    if (!node) {
      drifted.push({ nodeId: belief.nodeId, kind: 'gone', node: null });
      continue;
    }
    if (revisionOf(node) !== belief.revision) {
      drifted.push({ nodeId: belief.nodeId, kind: 'changed', node });
    }
  }
  return drifted;
}

/**
 * One Thread's beliefs, newest observation last.
 *
 * Re-observing a node replaces its belief rather than adding one: the model's
 * belief about a node is whatever it was shown most recently, and keeping the
 * older one would report drift the model has already been told about.
 */
export class DocumentBeliefSet {
  private readonly revisions = new Map<string, string>();

  get size(): number {
    return this.revisions.size;
  }

  record(beliefs: Iterable<DocumentBelief>): void {
    for (const belief of beliefs) {
      // Delete first so re-observation moves the node to the end: the order is
      // the recency the notice's cap spends its slots on.
      this.revisions.delete(belief.nodeId);
      this.revisions.set(belief.nodeId, belief.revision);
    }
  }

  /** Forget a node entirely — used when the model has just been told about it. */
  forget(nodeIds: Iterable<string>): void {
    for (const nodeId of nodeIds) this.revisions.delete(nodeId);
  }

  beliefs(): readonly DocumentBelief[] {
    return [...this.revisions].map(([nodeId, revision]) => ({ nodeId, revision }));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
