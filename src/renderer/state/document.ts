import { useMemo, useRef, useState } from 'react';
import type {
  DocumentProjection,
  FocusPlacement,
  FocusSurface as CoreFocusSurface,
  InlineRefCursorBias as CoreInlineRefCursorBias,
  NodeId,
  NodeProjection,
} from '../api/types';
import type { TriggerState } from '../ui/shared';
import { buildOutlinerRows } from './outlinerRows';
import { collectChangedNodes, nextRevisions, nodeSignatures, propagateDirty, type SignatureMap } from './renderRev';
import { measureRenderIndex } from '../ui/outliner/renderProbe';

export interface DocumentIndex {
  projection: DocumentProjection;
  byId: Map<NodeId, NodeProjection>;
  // Per-node data revision and a global UI generation, used by OutlinerItem's
  // React.memo to skip untouched subtrees. Optional because `buildIndex` (tests,
  // non-outliner callers) does not track them; the live app always supplies them
  // through `useRenderIndex`.
  renderRev?: ReadonlyMap<NodeId, number>;
  uiGen?: number;
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
  ui: UiState;
  trigger: TriggerState;
  dragId: NodeId | null;
  uiGen: number;
}

// Like buildIndex, but also tracks `renderRev` (per-node data revisions) and
// `uiGen` (a counter bumped on any UI change) across renders so OutlinerItem can
// memoize. Data changes (typing) bump only the touched subtree's revisions; any
// UI change bumps uiGen so every row re-renders — matching today's behaviour for
// focus/selection/drag and keeping the memo decision provably correct (a skipped
// row can never hold stale UI, because UI changes never skip).
export function useRenderIndex(
  projection: DocumentProjection | null,
  ui: UiState,
  trigger: TriggerState,
  dragId: NodeId | null,
): DocumentIndex | null {
  const cacheRef = useRef<RenderIndexCache | null>(null);
  return useMemo(() => measureRenderIndex((): DocumentIndex | null => {
    if (!projection) {
      cacheRef.current = null;
      return null;
    }
    const previous = cacheRef.current;
    const uiChanged = !previous || previous.ui !== ui || previous.trigger !== trigger || previous.dragId !== dragId;

    // UI-only change: the projection object is unchanged, so no node data moved.
    // Reuse the data revisions and only bump the global UI generation.
    if (previous && previous.projection === projection) {
      const uiGen = uiChanged ? previous.uiGen + 1 : previous.uiGen;
      cacheRef.current = { ...previous, ui, trigger, dragId, uiGen };
      return { projection, byId: previous.byId, renderRev: previous.renderRev, uiGen };
    }

    const { byId } = buildIndex(projection);
    const signatures = nodeSignatures(byId);
    const changed = collectChangedNodes(previous?.signatures ?? null, signatures);
    const affected = propagateDirty(changed, byId);
    const renderRev = nextRevisions(previous?.renderRev ?? null, affected, byId.keys());
    const uiGen = previous ? (uiChanged ? previous.uiGen + 1 : previous.uiGen) : 0;
    cacheRef.current = { projection, byId, signatures, renderRev, ui, trigger, dragId, uiGen };
    return { projection, byId, renderRev, uiGen };
  }), [projection, ui, trigger, dragId]);
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
      if (expanded.has(row.id)) {
        const childParentId = outlinerChildParentId(row.id, byId);
        if (!childParentId || referencePath.includes(childParentId)) continue;
        visit(childParentId, [...referencePath, childParentId]);
      }
    }
  };
  visit(rootId, [rootId]);
  return result;
}

export function outlinerChildParentId(
  rowId: NodeId,
  byId: Map<NodeId, NodeProjection>,
): NodeId | null {
  const node = byId.get(rowId);
  if (!node) return null;
  if (node.type !== 'reference' || !node.targetId) return rowId;
  return resolveReferenceTargetId(node.targetId, byId);
}

export function resolveReferenceTargetId(
  targetId: NodeId,
  byId: Map<NodeId, NodeProjection>,
): NodeId | null {
  let currentId: NodeId | undefined = targetId;
  const visited = new Set<NodeId>();
  while (currentId) {
    if (visited.has(currentId)) return null;
    visited.add(currentId);
    const current = byId.get(currentId);
    if (!current) return null;
    if (current.type !== 'reference') return current.id;
    currentId = current.targetId;
  }
  return null;
}
