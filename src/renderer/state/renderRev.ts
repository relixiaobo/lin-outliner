import { inlineRefNodeId, type NodeId, type NodeProjection } from '../api/types';

// Per-node "data revision" support for memoizing the outliner.
//
// Core hands the renderer the exact set of changed node ids per edit (a
// `ProjectionUpdate` delta), so the renderer never re-`JSON.stringify`s the whole
// document to rediscover what changed. From that change set we propagate to every
// node that must re-render to reflect it. A node must re-render when:
//   - its own data changed, or
//   - a node it transcludes / displays changed (reference target, applied tag
//     definition, inline-reference target), or
//   - a descendant changed (so React can descend to it — reachability up the
//     structural parent chain).
// Bumping a per-node counter for exactly that set lets `React.memo` skip every
// untouched subtree. Pure functions, unit-tested in renderRev.test.ts.
//
// The "who displays whom" reverse-edge index is held across edits and patched
// from each delta (`patchReverseEdges`) instead of rebuilt — retiring the last
// O(N) per-keystroke scan.

// The "who displays whom" index, inverted so `propagateDirty` can answer "which
// nodes must re-render because node X changed?" in O(referrers) instead of
// scanning the document. Held across edits in the projection store and patched
// from each delta (see `patchReverseEdges`) rather than rebuilt — that rebuild was
// the last O(N) per-keystroke pass.
export interface ReverseEdges {
  // target node -> reference nodes pointing at it (immediate targetId).
  references: Map<NodeId, Set<NodeId>>;
  // tag definition -> nodes carrying that tag.
  taggers: Map<NodeId, Set<NodeId>>;
  // inline-reference target -> nodes whose content links to it.
  inlineReferrers: Map<NodeId, Set<NodeId>>;
}

export function emptyReverseEdges(): ReverseEdges {
  return { references: new Map(), taggers: new Map(), inlineReferrers: new Map() };
}

// The reverse-edge keys a single node contributes, by category. A node points at
// its reference target, every tag it carries, and every inline-ref target in its
// content.
function nodeReverseKeys(node: NodeProjection): { references: NodeId[]; taggers: NodeId[]; inlineReferrers: NodeId[] } {
  const inline: NodeId[] = [];
  for (const inlineRef of node.content.inlineRefs) {
    const nodeId = inlineRefNodeId(inlineRef);
    if (nodeId) inline.push(nodeId);
  }
  return {
    references: node.type === 'reference' && node.targetId ? [node.targetId] : [],
    taggers: node.tags.slice(),
    inlineReferrers: inline,
  };
}

export function buildReverseEdges(byId: ReadonlyMap<NodeId, NodeProjection>): ReverseEdges {
  const edges = emptyReverseEdges();
  const add = (map: Map<NodeId, Set<NodeId>>, key: NodeId, value: NodeId) => {
    const set = map.get(key);
    if (set) set.add(value);
    else map.set(key, new Set([value]));
  };
  for (const [id, node] of byId) {
    const keys = nodeReverseKeys(node);
    for (const key of keys.references) add(edges.references, key, id);
    for (const key of keys.taggers) add(edges.taggers, key, id);
    for (const key of keys.inlineReferrers) add(edges.inlineReferrers, key, id);
  }
  return edges;
}

// Incrementally fold a delta into the reverse-edge index, returning a NEW index
// and leaving `prev` untouched (copy-on-write: the three top-level maps are
// shallow-copied — O(distinct targets), not O(nodes) — and each affected target's
// member set is copied at most once per patch before it is mutated). For every
// removed or changed node we strip the edges it contributed in `prevById`; for
// every changed node we add the edges it contributes now. A changed node whose
// edge keys are identical is skipped, so a plain text edit touches nothing.
export function patchReverseEdges(
  prev: ReverseEdges,
  prevById: ReadonlyMap<NodeId, NodeProjection>,
  changedNodes: readonly NodeProjection[],
  removedIds: readonly NodeId[],
): ReverseEdges {
  const next: ReverseEdges = {
    references: new Map(prev.references),
    taggers: new Map(prev.taggers),
    inlineReferrers: new Map(prev.inlineReferrers),
  };
  const owned = new WeakSet<Set<NodeId>>();
  // The member set for `key`, copied once per patch before its first mutation so
  // `prev`'s sets are never touched.
  const editable = (map: Map<NodeId, Set<NodeId>>, key: NodeId): Set<NodeId> => {
    let set = map.get(key);
    if (!set) { set = new Set(); map.set(key, set); owned.add(set); return set; }
    if (!owned.has(set)) { set = new Set(set); map.set(key, set); owned.add(set); }
    return set;
  };
  const removeEdge = (map: Map<NodeId, Set<NodeId>>, key: NodeId, value: NodeId) => {
    if (!map.has(key)) return;
    const set = editable(map, key);
    set.delete(value);
    if (set.size === 0) map.delete(key);
  };
  const removeNode = (id: NodeId) => {
    const old = prevById.get(id);
    if (!old) return;
    const keys = nodeReverseKeys(old);
    for (const key of keys.references) removeEdge(next.references, key, id);
    for (const key of keys.taggers) removeEdge(next.taggers, key, id);
    for (const key of keys.inlineReferrers) removeEdge(next.inlineReferrers, key, id);
  };

  for (const id of removedIds) removeNode(id);
  for (const node of changedNodes) {
    const old = prevById.get(node.id);
    const keys = nodeReverseKeys(node);
    if (old && sameReverseKeys(nodeReverseKeys(old), keys)) continue; // edges unchanged — skip
    if (old) removeNode(node.id);
    for (const key of keys.references) editable(next.references, key).add(node.id);
    for (const key of keys.taggers) editable(next.taggers, key).add(node.id);
    for (const key of keys.inlineReferrers) editable(next.inlineReferrers, key).add(node.id);
  }
  return next;
}

function sameReverseKeys(
  a: { references: NodeId[]; taggers: NodeId[]; inlineReferrers: NodeId[] },
  b: { references: NodeId[]; taggers: NodeId[]; inlineReferrers: NodeId[] },
): boolean {
  return sameList(a.references, b.references)
    && sameList(a.taggers, b.taggers)
    && sameList(a.inlineReferrers, b.inlineReferrers);
}

function sameList(a: readonly NodeId[], b: readonly NodeId[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

// Closure of `changed` over "must re-render": every node that displays a changed
// node's data, plus the structural ancestors needed to render down to them. The
// reverse-edge index is supplied (held across edits), not rebuilt here.
export function propagateDirty(
  changed: ReadonlySet<NodeId>,
  byId: ReadonlyMap<NodeId, NodeProjection>,
  edges: ReverseEdges,
): Set<NodeId> {
  const affected = new Set<NodeId>();
  if (changed.size === 0) return affected;
  const stack = [...changed];
  const enqueue = (ids: ReadonlySet<NodeId> | undefined) => {
    if (!ids) return;
    for (const id of ids) if (!affected.has(id)) stack.push(id);
  };
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (affected.has(id)) continue;
    affected.add(id);
    const node = byId.get(id);
    if (node?.parentId && !affected.has(node.parentId)) stack.push(node.parentId);
    enqueue(edges.references.get(id));
    enqueue(edges.taggers.get(id));
    enqueue(edges.inlineReferrers.get(id));
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
