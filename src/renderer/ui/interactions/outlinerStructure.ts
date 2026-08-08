import { indentExpansionTargets } from '../../../core/actions/outlineStructure';
import type { NodeId, NodeProjection } from '../../api/types';

export { indentTargetParentId, batchIndentNodeIds } from '../../../core/actions/outlineStructure';

export function expandIndentTargets(
  expanded: Set<NodeId>,
  nodeIds: readonly NodeId[],
  byId: Map<NodeId, NodeProjection>,
): Set<NodeId> {
  const next = new Set(expanded);
  for (const targetParentId of indentExpansionTargets(nodeIds, byId)) next.add(targetParentId);
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
