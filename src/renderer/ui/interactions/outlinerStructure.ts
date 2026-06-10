import type { NodeId, NodeProjection } from '../../api/types';

export function indentTargetParentId(
  nodeId: NodeId,
  byId: Map<NodeId, NodeProjection>,
): NodeId | null {
  const node = byId.get(nodeId);
  const parentId = node?.parentId;
  if (!parentId) return null;
  const parent = byId.get(parentId);
  if (!parent) return null;
  const index = parent.children.indexOf(nodeId);
  if (index <= 0) return null;
  return parent.children[index - 1] ?? null;
}

export function expandIndentTargets(
  expanded: Set<NodeId>,
  nodeIds: readonly NodeId[],
  byId: Map<NodeId, NodeProjection>,
): Set<NodeId> {
  const next = new Set(expanded);
  const batch = new Set(nodeIds);
  for (const nodeId of nodeIds) {
    const targetParentId = indentTargetParentId(nodeId, byId);
    if (targetParentId && !batch.has(targetParentId)) next.add(targetParentId);
  }
  return next;
}

export function batchIndentNodeIds(
  nodeIds: readonly NodeId[],
  byId: Map<NodeId, NodeProjection>,
): NodeId[] {
  const batch = new Set(nodeIds);
  return nodeIds.filter((nodeId) => selectedRunHasExternalPreviousSibling(nodeId, batch, byId));
}

function selectedRunHasExternalPreviousSibling(
  nodeId: NodeId,
  batch: ReadonlySet<NodeId>,
  byId: Map<NodeId, NodeProjection>,
): boolean {
  let currentId: NodeId | undefined = nodeId;
  while (currentId) {
    const node = byId.get(currentId);
    const parentId = node?.parentId;
    const parent = parentId ? byId.get(parentId) : undefined;
    const index: number = parent?.children.indexOf(currentId) ?? -1;
    if (!parent || index <= 0) return false;

    const previousSiblingId: NodeId | undefined = parent.children[index - 1];
    if (!previousSiblingId) return false;
    if (!batch.has(previousSiblingId)) return true;
    currentId = previousSiblingId;
  }
  return false;
}

export function previousVisibleRowId(
  visibleRows: readonly NodeId[],
  nodeId: NodeId,
): NodeId | null {
  const index = visibleRows.indexOf(nodeId);
  if (index <= 0) return null;
  return visibleRows[index - 1] ?? null;
}
