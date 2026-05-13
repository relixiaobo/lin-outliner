import type { NodeId, NodeProjection } from '../../api/types';
import { selectedRootIds } from './selectionActions';

export interface ActiveNodeSelection {
  nodeIds: NodeId[];
  targetIds: NodeId[];
  isBatch: boolean;
  labelPrefix: string;
}

export function targetIdForRow(
  rowId: NodeId,
  byId: Map<NodeId, NodeProjection>,
  fallbackTargetId: NodeId = rowId,
): NodeId {
  const row = byId.get(rowId);
  if (row?.type === 'reference' && row.targetId) return row.targetId;
  return row ? row.id : fallbackTargetId;
}

export function targetIdsForRows(
  rowIds: readonly NodeId[],
  byId: Map<NodeId, NodeProjection>,
): NodeId[] {
  const seen = new Set<NodeId>();
  const targetIds: NodeId[] = [];
  for (const rowId of rowIds) {
    const targetId = targetIdForRow(rowId, byId);
    if (seen.has(targetId)) continue;
    seen.add(targetId);
    targetIds.push(targetId);
  }
  return targetIds;
}

export function commonTagIdsForTargets(
  targetIds: readonly NodeId[],
  byId: Map<NodeId, NodeProjection>,
): NodeId[] {
  if (targetIds.length === 0) return [];
  const first = byId.get(targetIds[0]);
  if (!first) return [];
  const common = new Set(first.tags);
  for (const targetId of targetIds.slice(1)) {
    const tags = new Set(byId.get(targetId)?.tags ?? []);
    for (const tagId of [...common]) {
      if (!tags.has(tagId)) common.delete(tagId);
    }
  }
  return [...common];
}

export function resolveActiveNodeSelection(params: {
  nodeId: NodeId;
  targetId: NodeId;
  selectedIds: Set<NodeId>;
  byId: Map<NodeId, NodeProjection>;
}): ActiveNodeSelection {
  const isBatch = params.selectedIds.has(params.nodeId) && params.selectedIds.size > 1;
  const nodeIds = isBatch
    ? selectedRootIds([...params.selectedIds], params.byId)
    : [params.nodeId];
  const targetIds = isBatch
    ? targetIdsForRows(nodeIds, params.byId)
    : [params.targetId];

  return {
    nodeIds,
    targetIds,
    isBatch,
    labelPrefix: nodeIds.length > 1 ? `${nodeIds.length} nodes: ` : '',
  };
}
