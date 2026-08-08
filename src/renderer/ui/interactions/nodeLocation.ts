import type { NodeId, NodeProjection } from '../../api/types';
import type { DocumentIndex } from '../../state/document';

export function isNodeInTrash(index: DocumentIndex, nodeId: NodeId): boolean {
  return isNodeInSubtree(index.byId, nodeId, index.projection.trashId);
}

export function isNodeInSubtree(
  byId: Map<NodeId, NodeProjection>,
  nodeId: NodeId,
  ancestorId: NodeId,
): boolean {
  let current: NodeProjection | undefined = byId.get(nodeId);
  const visited = new Set<NodeId>();
  while (current && !visited.has(current.id)) {
    if (current.id === ancestorId) return true;
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

export { isDescendantOf } from '../../../core/actions/rowFacets';
