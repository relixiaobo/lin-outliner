import {
  contentTargetIdForRow,
  contentTargetIdsForRows,
} from '../../../core/actions/rowFacets';
import type { NodeId, NodeProjection } from '../../api/types';
import { selectedRootIds } from './selectionActions';

export interface ActiveNodeSelection {
  nodeIds: NodeId[];
  targetIds: NodeId[];
  isBatch: boolean;
  labelPrefix: string;
}

// The row -> content-target resolution is the action registry's `content` facet
// (`core/actions/rowFacets.ts`); these names stay as the renderer's call sites.
export const targetIdForRow = contentTargetIdForRow;
export const targetIdsForRows = contentTargetIdsForRows;
export { commonTagIdsForTargets } from '../../../core/actions/rowFacets';

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
