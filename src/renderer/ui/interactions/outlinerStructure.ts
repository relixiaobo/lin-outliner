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
  for (const nodeId of nodeIds) {
    const targetParentId = indentTargetParentId(nodeId, byId);
    if (targetParentId) next.add(targetParentId);
  }
  return next;
}

export function previousVisibleRowId(
  visibleRows: readonly NodeId[],
  nodeId: NodeId,
): NodeId | null {
  const index = visibleRows.indexOf(nodeId);
  if (index <= 0) return null;
  return visibleRows[index - 1] ?? null;
}
