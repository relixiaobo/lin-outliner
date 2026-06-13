import type { NodeId, NodeProjection, RichText } from '../../api/types';
import type { UiState } from '../../state/document';
import { buildSelectableRows } from '../../state/selectableRows';
import { formatTag } from '../../../core/textSyntax';

export type SelectionDirection = 'up' | 'down';

export function orderedSelectedRows(rows: NodeId[], selectedIds: Set<NodeId>): NodeId[] {
  return rows.filter((id) => selectedIds.has(id));
}

export function visibleSelectedIds(rows: NodeId[], selectedIds: Set<NodeId>): Set<NodeId> {
  return new Set(orderedSelectedRows(rows, selectedIds));
}

export function toggleVisibleSelection(
  rows: NodeId[],
  selectedIds: Set<NodeId>,
  rowId: NodeId,
): Set<NodeId> {
  const next = visibleSelectedIds(rows, selectedIds);
  if (next.has(rowId)) next.delete(rowId);
  else next.add(rowId);
  return next;
}

export function resolveSelectionAnchor(params: {
  rows: NodeId[];
  selectedIds: Set<NodeId>;
  selectedId: NodeId | null;
  selectionAnchorId: NodeId | null;
}): NodeId | null {
  const orderedSelected = orderedSelectedRows(params.rows, params.selectedIds);
  if (params.selectionAnchorId && params.rows.includes(params.selectionAnchorId)) {
    return params.selectionAnchorId;
  }
  return orderedSelected[0] ?? params.selectedId ?? params.rows[0] ?? null;
}

export function extendSelection(
  rows: NodeId[],
  selectedIds: Set<NodeId>,
  anchorId: NodeId,
  direction: SelectionDirection,
): Set<NodeId> {
  const anchorIndex = rows.indexOf(anchorId);
  if (anchorIndex < 0) return selectedIds;
  const selectedIndexes = rows
    .map((id, index) => (selectedIds.has(id) ? index : -1))
    .filter((index) => index >= 0);
  const firstIndex = selectedIndexes.length > 0 ? Math.min(...selectedIndexes) : anchorIndex;
  const lastIndex = selectedIndexes.length > 0 ? Math.max(...selectedIndexes) : anchorIndex;
  const extentIndex = anchorIndex <= firstIndex
    ? lastIndex
    : anchorIndex >= lastIndex
      ? firstIndex
      : direction === 'down'
        ? lastIndex
        : firstIndex;
  const nextExtent = direction === 'down'
    ? Math.min(rows.length - 1, extentIndex + 1)
    : Math.max(0, extentIndex - 1);
  const start = Math.min(anchorIndex, nextExtent);
  const end = Math.max(anchorIndex, nextExtent);
  return new Set(rows.slice(start, end + 1));
}

export function navigationTarget(
  rows: NodeId[],
  selectedIds: Set<NodeId>,
  anchorId: NodeId,
  direction: SelectionDirection,
): NodeId | null {
  const selectedIndexes = rows
    .map((id, index) => (selectedIds.has(id) ? index : -1))
    .filter((index) => index >= 0);
  const anchorIndex = rows.indexOf(anchorId);
  if (anchorIndex < 0 && selectedIndexes.length === 0) return null;
  const from = direction === 'down'
    ? (selectedIndexes.length > 0 ? Math.max(...selectedIndexes) : anchorIndex)
    : (selectedIndexes.length > 0 ? Math.min(...selectedIndexes) : anchorIndex);
  return rows[from + (direction === 'down' ? 1 : -1)] ?? null;
}

export function selectedRootIds(
  ids: NodeId[],
  byId: Map<NodeId, NodeProjection>,
  parentIdForRow: (id: NodeId) => NodeId | null | undefined = (id) => byId.get(id)?.parentId,
): NodeId[] {
  const selected = new Set(ids);
  return ids.filter((id) => {
    let parentId = parentIdForRow(id);
    while (parentId) {
      if (selected.has(parentId)) return false;
      parentId = parentIdForRow(parentId);
    }
    return true;
  });
}

export function appendText(content: RichText, text: string): RichText {
  return {
    ...content,
    text: `${content.text}${text}`,
  };
}

export function serializeSelectedRows(
  rows: NodeId[],
  selectedIds: Set<NodeId>,
  byId: Map<NodeId, NodeProjection>,
): string {
  const selectedRows = orderedSelectedRows(rows, selectedIds);
  const selected = new Set(selectedRows);
  return selectedRows
    .map((id) => {
      const depth = selectedAncestorDepth(id, selected, byId);
      return `${'  '.repeat(depth)}- ${rowClipboardLabel(id, byId, selected)}`;
    })
    .join('\n');
}

export function selectVisibleRowsState(
  state: UiState,
  params: {
    byId: Map<NodeId, NodeProjection>;
    selectionRootId: NodeId;
  },
): UiState {
  const rows = buildSelectableRows(params.selectionRootId, params.byId, {
    expanded: state.expanded,
    expandedHiddenFields: state.expandedHiddenFields,
  }).map((row) => row.id);
  const first = rows[0] ?? null;
  return {
    ...state,
    focusedId: null,
    focusedParentId: null,
    focusedPanelId: null,
    focusSurface: null,
    focusRequest: null,
    pendingInputChar: null,
    pendingReferenceTypeAhead: null,
    trailingDraftPlacement: null,
    selectedId: first,
    selectedIds: new Set(rows),
    selectionAnchorId: first,
    selectionRootId: params.selectionRootId,
    selectionSource: 'global',
  };
}

function selectedAncestorDepth(
  nodeId: NodeId,
  selectedIds: Set<NodeId>,
  byId: Map<NodeId, NodeProjection>,
): number {
  let depth = 0;
  let parentId = byId.get(nodeId)?.parentId;
  while (parentId) {
    if (selectedIds.has(parentId)) depth += 1;
    parentId = byId.get(parentId)?.parentId;
  }
  return depth;
}

function rowClipboardLabel(
  nodeId: NodeId,
  byId: Map<NodeId, NodeProjection>,
  selectedIds: ReadonlySet<NodeId>,
): string {
  const node = byId.get(nodeId);
  if (!node) return nodeId;
  if (node.type === 'fieldEntry') {
    const fieldName = node.fieldDefId ? byId.get(node.fieldDefId)?.content.text : undefined;
    if (node.children.some((childId) => selectedIds.has(childId))) {
      return `>${fieldName || 'Field'}`;
    }
    const values = node.children
      .map((childId) => byId.get(childId)?.content.text)
      .filter((text): text is string => Boolean(text));
    return `>${fieldName || 'Field'}${values.length > 0 ? `: ${values.join(', ')}` : ''}`;
  }
  if (node.type === 'reference' && node.targetId) {
    return `@${byId.get(node.targetId)?.content.text || node.targetId}`;
  }
  if (node.type === 'tagDef') {
    return formatTag(node.content.text || 'Untitled');
  }
  return node.content.text || 'Untitled';
}
