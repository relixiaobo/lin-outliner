import type { NodeId, NodeProjection } from '../api/types';
import type { DocumentIndex } from '../state/document';

interface PanelBreadcrumb {
  collapsed: boolean;
  hiddenNodes: NodeProjection[];
  nodes: NodeProjection[];
}

export function buildPanelBreadcrumb(rootNode: NodeProjection | undefined, index: DocumentIndex): PanelBreadcrumb {
  if (!rootNode) return { collapsed: false, hiddenNodes: [], nodes: [] };

  const hiddenAncestorIds = new Set<NodeId>([
    index.projection.workspaceId,
    index.projection.rootId,
  ]);
  const chain: NodeProjection[] = [];
  const seen = new Set<NodeId>();
  let current = rootNode.parentId ? index.byId.get(rootNode.parentId) : undefined;

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    if (!current.parentId) break;
    current = index.byId.get(current.parentId);
  }

  const visible = chain.filter((node) => !hiddenAncestorIds.has(node.id));
  if (visible.length <= 3) {
    return { collapsed: false, hiddenNodes: [], nodes: visible };
  }

  return {
    collapsed: true,
    hiddenNodes: visible.slice(1, -2),
    nodes: [visible[0], ...visible.slice(-2)],
  };
}
