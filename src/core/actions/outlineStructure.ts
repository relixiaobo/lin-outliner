// The structural predicates behind Indent / Outdent, and the outline-state
// adjustments they require.
//
// These are pure over the projection, so the shipped keyboard path and the
// registry answer from ONE implementation. That matters more here than
// elsewhere: a command-only Indent/Outdent silently drops the selection
// restoration and expansion adjustment the keyboard path performs, and the
// difference is invisible until a user tries it.

import { isInternalConfigNode } from '../configSchema';
import { type NodeId, type NodeProjection } from '../types';

const NON_OUTLINE_CHILD_TYPES = new Set([
  'queryCondition',
  'viewDef',
  'sortRule',
  'filterRule',
  'displayField',
]);

/** A node's children as the outliner shows them (config subtrees excluded). */
export function outlineChildIds(
  node: NodeProjection | undefined,
  byId: ReadonlyMap<NodeId, NodeProjection>,
): NodeId[] {
  if (!node) return [];
  return node.children.filter((childId) => {
    const child = byId.get(childId);
    if (!child || isInternalConfigNode(child)) return false;
    return !NON_OUTLINE_CHILD_TYPES.has(child.type ?? '');
  });
}

/** The previous sibling an indent would move `nodeId` under, if any. */
export function indentTargetParentId(
  nodeId: NodeId,
  byId: ReadonlyMap<NodeId, NodeProjection>,
): NodeId | null {
  const node = byId.get(nodeId);
  const parentId = node?.parentId;
  if (!parentId) return null;
  const parent = byId.get(parentId);
  if (!parent) return null;
  const siblings = outlineChildIds(parent, byId);
  const index = siblings.indexOf(nodeId);
  if (index <= 0) return null;
  return siblings[index - 1] ?? null;
}

/**
 * The rows a batch indent actually moves: one whose previous sibling is inside
 * the same selection has nowhere of its own to go — its run moves as a unit.
 */
export function batchIndentNodeIds(
  nodeIds: readonly NodeId[],
  byId: ReadonlyMap<NodeId, NodeProjection>,
): NodeId[] {
  const batch = new Set(nodeIds);
  return nodeIds.filter((nodeId) => selectedRunHasExternalPreviousSibling(nodeId, batch, byId));
}

function selectedRunHasExternalPreviousSibling(
  nodeId: NodeId,
  batch: ReadonlySet<NodeId>,
  byId: ReadonlyMap<NodeId, NodeProjection>,
): boolean {
  let currentId: NodeId | undefined = nodeId;
  while (currentId) {
    const node = byId.get(currentId);
    const parentId = node?.parentId;
    const parent = parentId ? byId.get(parentId) : undefined;
    const siblings: NodeId[] = parent ? outlineChildIds(parent, byId) : [];
    const index: number = siblings.indexOf(currentId);
    if (!parent || index <= 0) return false;

    const previousSiblingId: NodeId | undefined = siblings[index - 1];
    if (!previousSiblingId) return false;
    if (!batch.has(previousSiblingId)) return true;
    currentId = previousSiblingId;
  }
  return false;
}

/**
 * The parents an indent should expand, so the moved rows stay visible.
 * Computed from the PRE-command tree and applied BEFORE the command: the target
 * is about to gain children, and expanding it early shows only the children it
 * already had — usually none, so nothing moves on screen.
 */
export function indentExpansionTargets(
  nodeIds: readonly NodeId[],
  byId: ReadonlyMap<NodeId, NodeProjection>,
): NodeId[] {
  const batch = new Set(nodeIds);
  const targets: NodeId[] = [];
  for (const nodeId of nodeIds) {
    const targetParentId = indentTargetParentId(nodeId, byId);
    if (targetParentId && !batch.has(targetParentId) && !targets.includes(targetParentId)) {
      targets.push(targetParentId);
    }
  }
  return targets;
}

/**
 * The parents an outdent will leave empty. Computed from the PRE-command tree
 * but applied AFTER the command: collapsing a parent that still holds the rows
 * would hide them for a frame and then show them again one level out. Once the
 * parent is genuinely empty, collapsing it is visually a no-op.
 */
export function parentIdsEmptiedByOutdent(
  nodeIds: readonly NodeId[],
  byId: ReadonlyMap<NodeId, NodeProjection>,
  rootId?: NodeId | null,
): NodeId[] {
  const movedIds = new Set(nodeIds);
  const candidateParentIds = new Set<NodeId>();
  for (const nodeId of nodeIds) {
    const parentId = byId.get(nodeId)?.parentId;
    if (!parentId || parentId === rootId) continue;
    const parent = byId.get(parentId);
    if (!parent?.parentId) continue;
    candidateParentIds.add(parentId);
  }

  const emptied: NodeId[] = [];
  for (const parentId of candidateParentIds) {
    const children = outlineChildIds(byId.get(parentId), byId);
    if (children.length > 0 && children.every((childId) => movedIds.has(childId))) {
      emptied.push(parentId);
    }
  }
  return emptied;
}
