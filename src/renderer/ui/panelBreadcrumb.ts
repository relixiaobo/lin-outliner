import {
  isContentBearingNode,
  type ContentBearingNodeProjection,
  type NodeId,
  type NodeProjection,
} from '../api/types';
import type { DocumentIndex } from '../state/document';

interface PanelBreadcrumb {
  collapsed: boolean;
  hiddenNodes: ContentBearingNodeProjection[];
  nodes: ContentBearingNodeProjection[];
}

export function buildPanelBreadcrumb(
  rootNode: ContentBearingNodeProjection | undefined,
  index: DocumentIndex,
): PanelBreadcrumb {
  if (!rootNode) return { collapsed: false, hiddenNodes: [], nodes: [] };

  const hiddenAncestorIds = new Set<NodeId>([
    index.projection.workspaceId,
  ]);
  const chain: ContentBearingNodeProjection[] = [];
  const seen = new Set<NodeId>();
  const parent = rootNode.parentId ? index.byId.get(rootNode.parentId) : undefined;
  let current = parent && isContentBearingNode(parent) ? parent : undefined;

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    if (!current.parentId) break;
    const next = index.byId.get(current.parentId);
    current = next && isContentBearingNode(next) ? next : undefined;
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
