import type { NodeId, NodeProjection } from '../api/types';

// Per-node "data revision" support for memoizing the outliner.
//
// The projection is structure-cloned across IPC, so every node object is fresh
// on every command and reference identity tells us nothing. Instead we hash each
// node and diff hashes against the previous projection to find the nodes whose
// data actually changed, then propagate that to every node that must re-render
// to reflect the change. A node must re-render when:
//   - its own data changed, or
//   - a node it transcludes / displays changed (reference target, applied tag
//     definition, inline-reference target), or
//   - a descendant changed (so React can descend to it — reachability up the
//     structural parent chain).
// Bumping a per-node counter for exactly that set lets `React.memo` skip every
// untouched subtree. Pure functions, unit-tested in renderRev.test.ts.

export type SignatureMap = Map<NodeId, string>;

export function nodeSignatures(byId: ReadonlyMap<NodeId, NodeProjection>): SignatureMap {
  const signatures: SignatureMap = new Map();
  for (const [id, node] of byId) signatures.set(id, JSON.stringify(node));
  return signatures;
}

// Nodes whose serialized form differs from the previous projection. A removed
// node needs no entry: its parent's children list changed, so the parent is
// itself reported as changed and re-renders without it.
export function collectChangedNodes(previous: SignatureMap | null, next: SignatureMap): Set<NodeId> {
  const changed = new Set<NodeId>();
  if (!previous) {
    for (const id of next.keys()) changed.add(id);
    return changed;
  }
  for (const [id, signature] of next) {
    if (previous.get(id) !== signature) changed.add(id);
  }
  return changed;
}

interface ReverseEdges {
  // target node -> reference nodes pointing at it (immediate targetId).
  references: Map<NodeId, NodeId[]>;
  // tag definition -> nodes carrying that tag.
  taggers: Map<NodeId, NodeId[]>;
  // inline-reference target -> nodes whose content links to it.
  inlineReferrers: Map<NodeId, NodeId[]>;
}

function buildReverseEdges(byId: ReadonlyMap<NodeId, NodeProjection>): ReverseEdges {
  const references = new Map<NodeId, NodeId[]>();
  const taggers = new Map<NodeId, NodeId[]>();
  const inlineReferrers = new Map<NodeId, NodeId[]>();
  const add = (map: Map<NodeId, NodeId[]>, key: NodeId, value: NodeId) => {
    const existing = map.get(key);
    if (existing) existing.push(value);
    else map.set(key, [value]);
  };
  for (const [id, node] of byId) {
    if (node.type === 'reference' && node.targetId) add(references, node.targetId, id);
    for (const tagId of node.tags) add(taggers, tagId, id);
    for (const inlineRef of node.content.inlineRefs) add(inlineReferrers, inlineRef.targetNodeId, id);
  }
  return { references, taggers, inlineReferrers };
}

// Closure of `changed` over "must re-render": every node that displays a changed
// node's data, plus the structural ancestors needed to render down to them.
export function propagateDirty(
  changed: ReadonlySet<NodeId>,
  byId: ReadonlyMap<NodeId, NodeProjection>,
): Set<NodeId> {
  const affected = new Set<NodeId>();
  if (changed.size === 0) return affected;
  const { references, taggers, inlineReferrers } = buildReverseEdges(byId);
  const stack = [...changed];
  const enqueue = (ids: NodeId[] | undefined) => {
    if (!ids) return;
    for (const id of ids) if (!affected.has(id)) stack.push(id);
  };
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (affected.has(id)) continue;
    affected.add(id);
    const node = byId.get(id);
    if (node?.parentId && !affected.has(node.parentId)) stack.push(node.parentId);
    enqueue(references.get(id));
    enqueue(taggers.get(id));
    enqueue(inlineReferrers.get(id));
  }
  return affected;
}

// Build the next per-node revision map: bump every affected node, carry the rest
// forward unchanged so a fresh map still compares equal for untouched nodes.
export function nextRevisions(
  previous: ReadonlyMap<NodeId, number> | null,
  affected: ReadonlySet<NodeId>,
  ids: Iterable<NodeId>,
): Map<NodeId, number> {
  const revisions = new Map<NodeId, number>();
  for (const id of ids) {
    const base = previous?.get(id) ?? 0;
    revisions.set(id, affected.has(id) ? base + 1 : base);
  }
  return revisions;
}
