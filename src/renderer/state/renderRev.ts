import { inlineRefNodeId, type NodeId, type NodeProjection } from '../api/types';
import { addToSetMap } from '../../core/setUtils';

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
// The reverse-edge categories, each an independent `target -> referrers` map:
//   references      — target node      -> reference nodes pointing at it (targetId)
//   taggers         — tag definition   -> nodes carrying that tag
//   inlineReferrers — inline-ref target -> nodes whose content links to it
// They are keyed and patched identically, so every operation below iterates this
// tuple rather than spelling the three out by hand.
const REVERSE_CATEGORIES = ['references', 'taggers', 'inlineReferrers'] as const;
type ReverseCategory = (typeof REVERSE_CATEGORIES)[number];

export type ReverseEdges = {
  [Category in ReverseCategory]: Map<NodeId, Set<NodeId>>;
};

export function emptyReverseEdges(): ReverseEdges {
  return { references: new Map(), taggers: new Map(), inlineReferrers: new Map() };
}

// The reverse-edge keys a single node contributes, by category. The returned
// arrays are only ever iterated and length/element-compared (never mutated), so
// `taggers` aliases the node's own `tags` rather than copying it — a per-node
// allocation saved on the per-keystroke path.
function nodeReverseKeys(node: NodeProjection): Record<ReverseCategory, readonly NodeId[]> {
  const inlineReferrers: NodeId[] = [];
  for (const inlineRef of node.content.inlineRefs) {
    const nodeId = inlineRefNodeId(inlineRef);
    if (nodeId) inlineReferrers.push(nodeId);
  }
  return {
    references: node.type === 'reference' && node.targetId ? [node.targetId] : [],
    taggers: node.tags,
    inlineReferrers,
  };
}

export function buildReverseEdges(byId: ReadonlyMap<NodeId, NodeProjection>): ReverseEdges {
  const edges = emptyReverseEdges();
  for (const [id, node] of byId) {
    const keys = nodeReverseKeys(node);
    for (const category of REVERSE_CATEGORIES) {
      for (const key of keys[category]) addToSetMap(edges[category], key, id);
    }
  }
  return edges;
}

// Incrementally fold a delta into the reverse-edge index, returning a NEW index
// and leaving `prev` untouched (copy-on-write at BOTH levels: a category's map is
// cloned on its first write — O(distinct targets), not O(nodes) — and each
// affected target's member set is copied at most once per patch before it is
// mutated). For every removed or changed node we strip the edges it contributed in
// `prevById`; for every changed node we add the edges it contributes now. A changed
// node whose edge keys are identical is skipped, so a delta that changes no edges
// (the common plain text edit) mutates nothing and returns `prev` as-is — zero
// allocation.
export function patchReverseEdges(
  prev: ReverseEdges,
  prevById: ReadonlyMap<NodeId, NodeProjection>,
  changedNodes: readonly NodeProjection[],
  removedIds: readonly NodeId[],
): ReverseEdges {
  const next: ReverseEdges = { ...prev };
  const copiedMaps = new Set<ReverseCategory>();
  const ownedSets = new WeakSet<Set<NodeId>>();
  // The category's map, cloned on its first write so `prev`'s map is never touched.
  const mapFor = (category: ReverseCategory): Map<NodeId, Set<NodeId>> => {
    if (!copiedMaps.has(category)) { next[category] = new Map(next[category]); copiedMaps.add(category); }
    return next[category];
  };
  // The member set for `key`, cloned once per patch before its first mutation so
  // `prev`'s sets are never touched.
  const ownedSet = (category: ReverseCategory, key: NodeId): Set<NodeId> => {
    const map = mapFor(category);
    let set = map.get(key);
    if (!set) { set = new Set(); map.set(key, set); ownedSets.add(set); return set; }
    if (!ownedSets.has(set)) { set = new Set(set); map.set(key, set); ownedSets.add(set); }
    return set;
  };
  const addKey = (category: ReverseCategory, key: NodeId, id: NodeId) => ownedSet(category, key).add(id);
  const removeKey = (category: ReverseCategory, key: NodeId, id: NodeId) => {
    if (!next[category].has(key)) return; // read-only probe; safe before the map is cloned
    const set = ownedSet(category, key);
    set.delete(id);
    if (set.size === 0) mapFor(category).delete(key);
  };
  const removeNode = (id: NodeId, keys: Record<ReverseCategory, readonly NodeId[]>) => {
    for (const category of REVERSE_CATEGORIES) {
      for (const key of keys[category]) removeKey(category, key, id);
    }
  };

  for (const id of removedIds) {
    const old = prevById.get(id);
    if (old) removeNode(id, nodeReverseKeys(old));
  }
  for (const node of changedNodes) {
    const old = prevById.get(node.id);
    const oldKeys = old ? nodeReverseKeys(old) : null;
    const keys = nodeReverseKeys(node);
    if (oldKeys && sameReverseKeys(oldKeys, keys)) continue; // edges unchanged — skip
    if (oldKeys) removeNode(node.id, oldKeys);
    for (const category of REVERSE_CATEGORIES) {
      for (const key of keys[category]) addKey(category, key, node.id);
    }
  }
  // No edge moved (e.g. a pure text edit): hand back `prev` so the store keeps the
  // same index object and the keystroke allocates nothing.
  return copiedMaps.size === 0 ? prev : next;
}

function sameReverseKeys(
  a: Record<ReverseCategory, readonly NodeId[]>,
  b: Record<ReverseCategory, readonly NodeId[]>,
): boolean {
  return REVERSE_CATEGORIES.every((category) => sameList(a[category], b[category]));
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
  const enqueueViewOwnerRows = (node: NodeProjection | undefined) => {
    if (!node) return;
    const viewDef = node.type === 'viewDef'
      ? node
      : node.parentId
        ? byId.get(node.parentId)
        : undefined;
    if (viewDef?.type !== 'viewDef' || !viewDef.parentId) return;
    const owner = byId.get(viewDef.parentId);
    if (!owner) return;
    for (const childId of owner.children) {
      const child = byId.get(childId);
      if (!child || child.type === 'viewDef' || child.type === 'sortRule' || child.type === 'filterRule' || child.type === 'displayField') continue;
      if (!affected.has(childId)) stack.push(childId);
    }
  };
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (affected.has(id)) continue;
    affected.add(id);
    const node = byId.get(id);
    if (node?.type === 'viewDef' || node?.type === 'sortRule' || node?.type === 'filterRule' || node?.type === 'displayField') {
      enqueueViewOwnerRows(node);
    }
    if (node?.parentId && !affected.has(node.parentId)) stack.push(node.parentId);
    for (const category of REVERSE_CATEGORIES) enqueue(edges[category].get(id));
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
