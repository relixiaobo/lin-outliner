import { useMemo, useRef, useState } from 'react';
import type {
  DocumentProjection,
  FocusPlacement,
  FocusSurface as CoreFocusSurface,
  InlineRefCursorBias as CoreInlineRefCursorBias,
  NodeId,
  NodeProjection,
} from '../api/types';
import { collectChangedNodes, nextRevisions, nodeSignatures, propagateDirty, type SignatureMap } from './renderRev';
import { measureRenderIndex } from '../ui/outliner/renderProbe';
import {
  resolveSelectableReferenceTargetId,
  selectableChildParentId,
} from './selectableRows';
import { buildOutlinerRows } from './outlinerRows';

export interface DocumentIndex {
  projection: DocumentProjection;
  byId: Map<NodeId, NodeProjection>;
  // Per-node data revision, used by OutlinerItem's React.memo to skip rows whose
  // data did not change. Optional because `buildIndex` (tests, non-outliner
  // callers) does not track it; the live app always supplies it through
  // `useRenderIndex`. UI state (focus/selection/…) is compared per-row in the
  // memo from the `ui` prop, not carried here.
  renderRev?: ReadonlyMap<NodeId, number>;
}

export type FocusSurface = CoreFocusSurface;
export type CursorPlacement = FocusPlacement;
export type InlineRefCursorBias = CoreInlineRefCursorBias;
export type SelectionSource = 'global' | 'ref-click';

export function buildIndex(projection: DocumentProjection): DocumentIndex {
  return {
    projection,
    byId: new Map(projection.nodes.map((node) => [node.id, node])),
  };
}

interface RenderIndexCache {
  projection: DocumentProjection;
  byId: Map<NodeId, NodeProjection>;
  signatures: SignatureMap;
  renderRev: Map<NodeId, number>;
}

// Like buildIndex, but also tracks `renderRev` (per-node data revisions) across
// renders so OutlinerItem can memoize: data changes (typing) bump only the
// touched subtree's revisions, so unaffected rows skip re-render. The index does
// not depend on UI state — focus/selection/drag are compared per-row in the memo
// comparator (see rowUiState), so this only recomputes when the projection moves.
export function useRenderIndex(projection: DocumentProjection | null): DocumentIndex | null {
  const cacheRef = useRef<RenderIndexCache | null>(null);
  return useMemo(() => measureRenderIndex((): DocumentIndex | null => {
    if (!projection) {
      cacheRef.current = null;
      return null;
    }
    const previous = cacheRef.current;
    const { byId } = buildIndex(projection);
    const signatures = nodeSignatures(byId);
    const changed = collectChangedNodes(previous?.signatures ?? null, signatures);
    const affected = propagateDirty(changed, byId);
    const renderRev = nextRevisions(previous?.renderRev ?? null, affected, byId.keys());
    cacheRef.current = { projection, byId, signatures, renderRev };
    return { projection, byId, renderRev };
  }), [projection]);
}

export interface UiState {
  focusedId: NodeId | null;
  focusedParentId: NodeId | null;
  focusedPanelId: string | null;
  focusSurface: FocusSurface | null;
  selectedId: NodeId | null;
  selectedIds: Set<NodeId>;
  selectionAnchorId: NodeId | null;
  selectionRootId: NodeId | null;
  selectionSource: SelectionSource | null;
  focusRequest: FocusRequest | null;
  pendingInputChar: PendingInputChar | null;
  pendingReferenceConversion: PendingReferenceConversion | null;
  pendingReferenceTypeAhead: PendingReferenceTypeAhead | null;
  expanded: Set<NodeId>;
  expandedHiddenFields: Set<string>;
  editingDescriptionId: NodeId | null;
  commandOpen: boolean;
  batchTagSelectorOpen: boolean;
  toolbarDropdownRequest: ToolbarDropdownRequest | null;
}

export interface FocusTarget {
  nodeId: NodeId;
  parentId: NodeId | null;
  panelId: string | null;
  surface: FocusSurface;
}

export interface FocusRequest {
  target: FocusTarget;
  placement: CursorPlacement;
}

export interface PendingInputChar {
  target: FocusTarget;
  char: string;
}

export interface PendingReferenceConversion {
  nodeId: NodeId;
  parentId: NodeId;
  targetId: NodeId;
}

export interface PendingReferenceTypeAhead {
  nodeId: NodeId;
  parentId: NodeId;
  targetId: NodeId;
}

export type ToolbarDropdownSection = 'sort' | 'filter' | 'group' | 'display';

export interface ToolbarDropdownRequest {
  nodeId: NodeId;
  section: ToolbarDropdownSection;
  nonce: number;
}

export function useUiState() {
  return useState<UiState>({
    focusedId: null,
    focusedParentId: null,
    focusedPanelId: null,
    focusSurface: null,
    selectedId: null,
    selectedIds: new Set<NodeId>(),
    selectionAnchorId: null,
    selectionRootId: null,
    selectionSource: null,
    focusRequest: null,
    pendingInputChar: null,
    pendingReferenceConversion: null,
    pendingReferenceTypeAhead: null,
    expanded: new Set<NodeId>(),
    expandedHiddenFields: new Set<string>(),
    editingDescriptionId: null,
    commandOpen: false,
    batchTagSelectorOpen: false,
    toolbarDropdownRequest: null,
  });
}

export function flattenVisibleRows(
  rootId: NodeId,
  byId: Map<NodeId, NodeProjection>,
  expanded: Set<NodeId>,
  expandedHiddenFields: Set<string> = new Set(),
): NodeId[] {
  const result: NodeId[] = [];
  const visit = (parentId: NodeId, referencePath: NodeId[]) => {
    const parent = byId.get(parentId);
    if (!parent) return;
    const rows = buildOutlinerRows(parent, byId, { expandedHiddenFields });
    for (const row of rows) {
      if (row.type !== 'field' && row.type !== 'content') continue;
      result.push(row.id);
      if (!expanded.has(row.id)) continue;
      const childParentId = outlinerChildParentId(row.id, byId);
      if (!childParentId || referencePath.includes(childParentId)) continue;
      visit(childParentId, [...referencePath, childParentId]);
    }
  };
  visit(rootId, [rootId]);
  return result;
}

export function outlinerChildParentId(
  rowId: NodeId,
  byId: Map<NodeId, NodeProjection>,
): NodeId | null {
  return selectableChildParentId(rowId, byId);
}

export function resolveReferenceTargetId(
  targetId: NodeId,
  byId: Map<NodeId, NodeProjection>,
): NodeId | null {
  return resolveSelectableReferenceTargetId(targetId, byId);
}
