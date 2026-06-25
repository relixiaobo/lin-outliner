import type { NodeId, NodeProjection } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { selectedRootIds } from './selectionActions';
import { isNodeInTrash } from './nodeLocation';

export function trashRootChildIds(index: DocumentIndex): NodeId[] {
  return index.byId.get(index.projection.trashId)?.children ?? [];
}

export function permanentDeleteCandidateIds(params: {
  ids: readonly NodeId[];
  index: DocumentIndex;
  parentIdForRow?: (id: NodeId) => NodeId | null | undefined;
}): NodeId[] {
  const ids = params.ids.filter((nodeId) => nodeId !== params.index.projection.trashId);
  const roots = selectedRootIds(ids, params.index.byId, params.parentIdForRow);
  return roots.filter((nodeId) => (
    isMutableNode(params.index.byId.get(nodeId))
    && isNodeInTrash(params.index, nodeId)
  ));
}

function isMutableNode(node: NodeProjection | undefined): boolean {
  return Boolean(node && !node.locked);
}
