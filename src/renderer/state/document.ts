import { useMemo, useState } from 'react';
import type { DocumentProjection, NodeId, NodeProjection } from '../api/types';
import { buildOutlinerRows } from './outlinerRows';

export interface DocumentIndex {
  projection: DocumentProjection;
  byId: Map<NodeId, NodeProjection>;
}

export function buildIndex(projection: DocumentProjection): DocumentIndex {
  return {
    projection,
    byId: new Map(projection.nodes.map((node) => [node.id, node])),
  };
}

export function useDocumentIndex(projection: DocumentProjection | null): DocumentIndex | null {
  return useMemo(() => (projection ? buildIndex(projection) : null), [projection]);
}

export interface UiState {
  focusedId: NodeId | null;
  selectedId: NodeId | null;
  selectedIds: Set<NodeId>;
  selectionAnchorId: NodeId | null;
  focusOffset: { nodeId: NodeId; offset: number } | null;
  expanded: Set<NodeId>;
  expandedHiddenFields: Set<string>;
  editingDescriptionId: NodeId | null;
  commandOpen: boolean;
  batchTagSelectorOpen: boolean;
}

export function useUiState() {
  return useState<UiState>({
    focusedId: null,
    selectedId: null,
    selectedIds: new Set<NodeId>(),
    selectionAnchorId: null,
    focusOffset: null,
    expanded: new Set<NodeId>(),
    expandedHiddenFields: new Set<string>(),
    editingDescriptionId: null,
    commandOpen: false,
    batchTagSelectorOpen: false,
  });
}

export function flattenVisibleRows(
  rootId: NodeId,
  byId: Map<NodeId, NodeProjection>,
  expanded: Set<NodeId>,
  expandedHiddenFields: Set<string> = new Set(),
): NodeId[] {
  const result: NodeId[] = [];
  const visit = (id: NodeId) => {
    const node = byId.get(id);
    if (!node) return;
    const rows = buildOutlinerRows(node, byId, { expandedHiddenFields });
    for (const row of rows) {
      if (row.type !== 'field' && row.type !== 'content') continue;
      result.push(row.id);
      if (expanded.has(row.id)) {
        visit(row.id);
      }
    }
  };
  visit(rootId);
  return result;
}
