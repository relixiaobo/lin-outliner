import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type Dispatch,
  type DragEvent,
  type MouseEvent,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { api } from '../../api/client';
import type { NodeId } from '../../api/types';
import type { DocumentIndex, UiState } from '../../state/document';
import { OUTLINER_NODE_DRAG_MIME, resolveOutlinerDropBatchMove } from '../interactions/dragDrop';
import { flattenVisibleRows, isRowExpanded } from '../../state/document';
import { buildSelectableRows } from '../../state/selectableRows';
import { resolveDropHoverPosition, type DropHoverPosition } from '../interactions/dropPosition';
import {
  resolveRowPointerSelectAction,
  shouldPreserveSelectedRowContextClick,
} from '../interactions/rowPointerSelection';
import { idsAllowedForStructuralBatch, selectableRowMap } from '../interactions/selectionBatchActions';
import { selectedRootIds, toggleVisibleSelection } from '../interactions/selectionActions';
import type { CommandRunner } from '../shared';
import {
  clearFocusState,
  cursorEnd,
  cursorStart,
  focusTarget,
  requestFocusState,
  rowFocusTarget,
  selectFocusState,
} from '../focus/focusModel';
import { buildOutlinerRows } from './row-model';
import { trailingDraftPlacementEquals } from '../../state/trailingDraftPlacement';
import { MAX_OUTLINE_INDENT_DEPTH } from '../workspaceResponsiveLayout';

interface UseOutlinerRowInteractionOptions {
  rowId: NodeId;
  parentId: NodeId;
  childParentId?: NodeId;
  panelId: string;
  rootId: NodeId;
  selectionRootId: NodeId;
  depth: number;
  childIds: NodeId[];
  index: DocumentIndex;
  ui: UiState;
  // Always-current ui, created by an ancestor that re-renders on every ui change.
  // Handlers read selection/expansion from here so a row that skips re-render
  // (per-row memo) still computes against live state, never a stale closure.
  uiRef: MutableRefObject<UiState>;
  setUi: Dispatch<SetStateAction<UiState>>;
  run: CommandRunner;
  locked?: boolean;
  // A file node (attachment/image) is a leaf, yet its expand toggle reveals an
  // inline preview block — not a child outline. When set, expanding only adds the
  // row to `ui.expanded` (the item renders the preview); it never focuses a
  // trailing child draft, and Down past it never descends into a phantom child.
  previewExpandable?: boolean;
  dragId: NodeId | null;
  setDragId: (nodeId: NodeId | null) => void;
  // A not-yet-materialized trailing draft tags its wrap with the parent it will
  // create under, so e2e (and any sibling lookup) can find the trailing editor by
  // `[data-trailing-parent-id]` the way the legacy TrailingInput row did.
  draft?: boolean;
  draftAfterId?: NodeId | null;
}

const DROP_TARGET_CHANGE_EVENT = 'lin:outliner-drop-target-change';

function announceDropTarget(key: string | null) {
  window.dispatchEvent(new CustomEvent<{ key: string | null }>(DROP_TARGET_CHANGE_EVENT, {
    detail: { key },
  }));
}

export function useOutlinerRowInteraction(options: UseOutlinerRowInteractionOptions) {
  const {
    rowId,
    parentId,
    childParentId = rowId,
    panelId,
    rootId,
    selectionRootId,
    depth,
    childIds,
    index,
    ui,
    uiRef,
    setUi,
    run,
    locked,
    previewExpandable,
    dragId,
    setDragId,
    draft,
    draftAfterId,
  } = options;
  const byId = index.byId;
  const [dropPosition, setDropPosition] = useState<DropHoverPosition | null>(null);
  const expanded = isRowExpanded(rowId, byId, ui.expanded);
  const hasChildren = childIds.length > 0;
  const focused = ui.focusedId === rowId;
  const selected = !ui.focusedId && (
    ui.selectedIds.has(rowId)
    || ui.selectedId === rowId
  );
  const refClickSelected = selected
    && ui.selectionSource === 'ref-click'
    && ui.selectedIds.size <= 1;
  const rowSelected = selected && !refClickSelected;
  const dropTargetKey = `${panelId}:${parentId}:${rowId}:${draft ? 'draft' : 'row'}`;
  const clearDropState = useCallback(() => {
    setDropPosition(null);
    setDragId(null);
    announceDropTarget(null);
  }, [setDragId]);

  useEffect(() => {
    if (!dragId) setDropPosition(null);
  }, [dragId]);

  useEffect(() => {
    const handleDropTargetChange = (event: Event) => {
      const key = (event as CustomEvent<{ key: string | null }>).detail?.key ?? null;
      if (key !== dropTargetKey) setDropPosition(null);
    };
    window.addEventListener(DROP_TARGET_CHANGE_EVENT, handleDropTargetChange);
    return () => window.removeEventListener(DROP_TARGET_CHANGE_EVENT, handleDropTargetChange);
  }, [dropTargetKey]);

  const updateSelection = useCallback(() => {
    setUi((prev) => {
      const next = selectFocusState(prev, rowFocusTarget(rowId, parentId, panelId));
      if (!draft) return next;
      const placement = { parentId, afterId: draftAfterId ?? null, panelId };
      return {
        ...next,
        trailingDraftPlacement: trailingDraftPlacementEquals(prev.trailingDraftPlacement, placement)
          ? prev.trailingDraftPlacement
          : placement,
      };
    });
  }, [draft, draftAfterId, panelId, parentId, rowId, setUi]);

  const toggleExpandOrSelect = useCallback(() => {
    // A file node has no real children: its toggle flips the inline preview (the
    // `previewExpandable` branch below), never a trailing child draft.
    if (!hasChildren && !previewExpandable) {
      const shouldFocusTrailing = !expanded;
      setUi((prev) => {
        const expandedSet = new Set(prev.expanded);
        if (shouldFocusTrailing) expandedSet.add(rowId);
        else expandedSet.delete(rowId);
        const next = { ...prev, expanded: expandedSet };
        return shouldFocusTrailing
          ? requestFocusState(next, focusTarget(childParentId, childParentId, panelId, 'trailing'), cursorEnd())
          : selectFocusState(next, rowFocusTarget(rowId, parentId, panelId));
      });
      return;
    }
    setUi((prev) => {
      const expandedSet = new Set(prev.expanded);
      if (expandedSet.has(rowId)) expandedSet.delete(rowId);
      else expandedSet.add(rowId);
      return selectFocusState({
        ...prev,
        expanded: expandedSet,
      }, rowFocusTarget(rowId, parentId, panelId));
    });
  }, [childParentId, expanded, hasChildren, panelId, parentId, previewExpandable, rowId, setUi]);

  const moveFocus = useCallback((direction: 1 | -1) => {
    const scopeShowsTrailingInput = (scopeParentId: NodeId) => scopeParentId === rootId;

    // A file node's expanded state shows a preview, not children, so Down past it
    // must skip the trailing-child focus and fall through to the next visible row.
    if (direction === 1 && expanded && !previewExpandable) {
      const childRows = buildOutlinerRows(byId.get(childParentId), byId);
      if (childRows.length === 0) {
        setUi((prev) => requestFocusState(prev, focusTarget(childParentId, childParentId, panelId, 'trailing'), cursorEnd()));
        return;
      }
    }

    if (direction === 1) {
      const siblingRows = buildOutlinerRows(byId.get(parentId), byId);
      if (
        siblingRows[siblingRows.length - 1]?.id === rowId
        && scopeShowsTrailingInput(parentId)
      ) {
        setUi((prev) => requestFocusState(prev, focusTarget(parentId, parentId, panelId, 'trailing'), cursorEnd()));
        return;
      }
    }

    const liveUi = uiRef.current;
    const rows = flattenVisibleRows(rootId, byId, liveUi.expanded, liveUi.expandedHiddenFields);
    const at = rows.indexOf(rowId);
    const nextId = rows[at + direction];
    if (!nextId) {
      if (direction === 1) {
        if (scopeShowsTrailingInput(parentId)) {
          setUi((prev) => requestFocusState(prev, focusTarget(parentId, parentId, panelId, 'trailing'), cursorEnd()));
          return;
        }
      }
      return;
    }
    const nextNode = byId.get(nextId);
    setUi((prev) => requestFocusState(
      prev,
      rowFocusTarget(nextId, nextNode?.parentId ?? null, panelId),
      direction === 1 ? cursorStart() : cursorEnd(),
    ));
  }, [
    byId,
    childParentId,
    expanded,
    panelId,
    parentId,
    previewExpandable,
    rootId,
    rowId,
    setUi,
    uiRef,
  ]);

  const focusLastVisibleChild = useCallback(() => {
    const liveUi = uiRef.current;
    const rows = flattenVisibleRows(childParentId, byId, liveUi.expanded, liveUi.expandedHiddenFields);
    const last = rows[rows.length - 1] ?? childIds[childIds.length - 1];
    if (!last) return;
    const lastNode = byId.get(last);
    setUi((prev) => requestFocusState(
      prev,
      rowFocusTarget(last, lastNode?.parentId ?? rowId, panelId),
      cursorEnd(),
    ));
  }, [byId, childIds, childParentId, panelId, rowId, setUi, uiRef]);

  const collapseToSelf = useCallback(() => {
    setUi((prev) => {
      const expandedSet = new Set(prev.expanded);
      expandedSet.delete(rowId);
      return requestFocusState({
        ...prev,
        expanded: expandedSet,
      }, rowFocusTarget(rowId, parentId, panelId), cursorEnd());
    });
  }, [panelId, parentId, rowId, setUi]);

  const expandSelf = useCallback(() => {
    setUi((prev) => {
      if (prev.expanded.has(rowId)) return prev;
      const expandedSet = new Set(prev.expanded);
      expandedSet.add(rowId);
      return { ...prev, expanded: expandedSet };
    });
  }, [rowId, setUi]);

  const toggleDirectChildrenExpansion = useCallback(() => {
    if (childIds.length === 0) return;
    setUi((prev) => {
      const expandedSet = new Set(prev.expanded);
      const anyChildExpanded = childIds.some((childId) => expandedSet.has(childId));
      for (const childId of childIds) {
        if (anyChildExpanded) expandedSet.delete(childId);
        else expandedSet.add(childId);
      }
      return { ...prev, expanded: expandedSet };
    });
  }, [childIds, setUi]);

  const selectFromPointer = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const liveUi = uiRef.current;
    const target = event.target as HTMLElement;
    const nearestRowWrap = target.closest<HTMLElement>('[data-node-id][data-parent-id]');
    if (nearestRowWrap?.dataset.nodeId && nearestRowWrap.dataset.nodeId !== rowId) return;
    if (target.closest('[data-inline-ref], .inline-ref') && !event.shiftKey) return;
    if (target.closest('button')) return;
    if (shouldPreserveSelectedRowContextClick({
      button: event.button,
      rowSelected: liveUi.selectedIds.has(rowId),
    })) {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      setUi((prev) => ({
        ...clearFocusState(prev),
      }));
      return;
    }
    const isInput = Boolean(target.closest('input, textarea, select, .row-editor, .ProseMirror'));
    const action = resolveRowPointerSelectAction({
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      isEditing: isInput && !event.metaKey && !event.ctrlKey && !event.shiftKey,
      allowSingle: false,
    });
    if (!action) return;

    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    const rows = buildSelectableRows(selectionRootId, byId, {
      expanded: liveUi.expanded,
      expandedHiddenFields: liveUi.expandedHiddenFields,
    }).map((row) => row.id);
    const selectionMeta: Pick<UiState, 'selectionRootId' | 'selectionSource'> = {
      selectionRootId,
      selectionSource: 'global',
    };
    let appliedSelection: {
      selectedId: NodeId | null;
      selectedIds: Set<NodeId>;
      selectionAnchorId: NodeId;
    } | null = null;

    if (action === 'range') {
      const anchor = liveUi.selectionAnchorId && rows.includes(liveUi.selectionAnchorId)
        ? liveUi.selectionAnchorId
        : liveUi.selectedId ?? rowId;
      const from = rows.indexOf(anchor);
      const to = rows.indexOf(rowId);
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from];
        appliedSelection = {
          selectedId: rowId,
          selectedIds: new Set(rows.slice(start, end + 1)),
          selectionAnchorId: anchor,
        };
      }
    }
    if (!appliedSelection && action === 'toggle') {
      const selectedIds = toggleVisibleSelection(rows, liveUi.selectedIds, rowId);
      const selectedId = selectedIds.has(rowId)
        ? rowId
        : [...selectedIds].at(-1) ?? null;
      appliedSelection = {
        selectedId,
        selectedIds,
        selectionAnchorId: selectedIds.size > 0 ? selectedId ?? rowId : rowId,
      };
    }
    if (!appliedSelection) {
      appliedSelection = {
        selectedId: rowId,
        selectedIds: new Set([rowId]),
        selectionAnchorId: rowId,
      };
    }

    const selection = appliedSelection;
    const applySelection = (prev: UiState): UiState => ({
      ...clearFocusState(prev),
      focusedId: null,
      selectedId: selection.selectedId,
      selectedIds: new Set(selection.selectedIds),
      selectionAnchorId: selection.selectionAnchorId,
      ...selectionMeta,
    });

    setUi(applySelection);
  }, [byId, rowId, selectionRootId, setUi, uiRef]);

  const onDragStart = useCallback((event: DragEvent<HTMLElement>) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(OUTLINER_NODE_DRAG_MIME, rowId);
    event.dataTransfer.setData('text/plain', '');
    const rowElement = event.currentTarget.closest('.row');
    if (rowElement) {
      const rect = rowElement.getBoundingClientRect();
      event.dataTransfer.setDragImage(rowElement, event.clientX - rect.left, event.clientY - rect.top);
    }
    setDragId(rowId);
  }, [rowId, setDragId]);

  const onDragEnd = useCallback(() => {
    clearDropState();
  }, [clearDropState]);

  const dragNodeIds = useCallback((): NodeId[] => {
    const liveUi = uiRef.current;
    if (!liveUi.selectedIds.has(dragId ?? '')) return dragId ? [dragId] : [];

    const selectableRows = buildSelectableRows(selectionRootId, byId, {
      expanded: liveUi.expanded,
      expandedHiddenFields: liveUi.expandedHiddenFields,
    });
    const rowMap = selectableRowMap(selectableRows);
    const selectedRows = selectableRows
      .map((row) => row.id)
      .filter((id) => liveUi.selectedIds.has(id));
    const rootIds = selectedRootIds(
      selectedRows,
      byId,
      (id) => rowMap.get(id)?.parentId ?? byId.get(id)?.parentId,
    );
    const moveIds = idsAllowedForStructuralBatch({
      ids: rootIds,
      panelRootId: selectionRootId,
      byId,
      rowMap,
    });
    return moveIds.length > 0 ? moveIds : dragId ? [dragId] : [];
  }, [byId, dragId, selectionRootId, uiRef]);

  const resolveDropMove = useCallback((position: DropHoverPosition | null) => {
    const nodeIds = dragNodeIds();
    if (nodeIds.length === 0) return null;
    const siblings = byId.get(parentId)?.children ?? [];
    const targetIndex = draft ? siblings.length : siblings.indexOf(rowId);
    return resolveOutlinerDropBatchMove({
      dragNodeIds: nodeIds,
      targetNodeId: rowId,
      targetParentId: parentId,
      siblingIndex: targetIndex,
      dropPosition: draft ? 'before' : position,
      targetHasChildren: !draft && hasChildren,
      targetIsExpanded: !draft && expanded,
      parentIdForNode: (nodeId) => byId.get(nodeId)?.parentId,
      childrenForParent: (nodeId) => byId.get(nodeId)?.children ?? [],
    });
  }, [byId, dragNodeIds, draft, expanded, hasChildren, parentId, rowId]);

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dragId) {
      setDropPosition(null);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const nextPosition = draft ? 'before' : resolveDropHoverPosition({
      offsetY: event.clientY - rect.top,
      rowHeight: rect.height,
    });
    if (!resolveDropMove(nextPosition)) {
      event.dataTransfer.dropEffect = 'none';
      setDropPosition(null);
      announceDropTarget(null);
      return;
    }
    event.dataTransfer.dropEffect = 'move';
    announceDropTarget(dropTargetKey);
    setDropPosition(nextPosition);
  }, [draft, dragId, dropTargetKey, resolveDropMove]);

  const onDrop = useCallback(async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const position = dropPosition ?? 'before';
    setDropPosition(null);
    const move = resolveDropMove(position);
    if (!move) {
      clearDropState();
      return;
    }

    if (move.expandTargetId) {
      setUi((prev) => {
        const expandedSet = new Set(prev.expanded);
        expandedSet.add(move.expandTargetId!);
        return { ...prev, expanded: expandedSet };
      });
    }

    try {
      if (move.moves.length === 1) {
        const single = move.moves[0]!;
        await run(() => api.moveNode(single.nodeId, single.parentId, single.index), { applyFocus: false });
      } else {
        await run(() => api.batchMoveNodes(move.moves), { applyFocus: false });
      }
    } finally {
      clearDropState();
    }
  }, [clearDropState, dropPosition, resolveDropMove, run, setUi]);

  const wrapStyle: CSSProperties = { marginLeft: Math.min(depth, MAX_OUTLINE_INDENT_DEPTH) * 28 };

  return {
    expanded,
    hasChildren,
    selected,
    focused,
    dropPosition,
    updateSelection,
    toggleExpandOrSelect,
    moveFocus,
    focusLastVisibleChild,
    collapseToSelf,
    expandSelf,
    toggleDirectChildrenExpansion,
    selectFromPointer,
    wrapProps: {
      'data-node-id': rowId,
      'data-parent-id': parentId,
      ...(draft ? { 'data-trailing-parent-id': parentId } : {}),
      style: wrapStyle,
      onDragOver,
      onDragLeave: (event: DragEvent<HTMLDivElement>) => {
        if (dragId) event.stopPropagation();
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropPosition(null);
        announceDropTarget(null);
      },
      onDrop: (event: DragEvent<HTMLDivElement>) => void onDrop(event),
    },
    dragHandleProps: {
      draggable: !locked,
      onDragStart,
      onDragEnd,
    },
    rowClassName(extra = '') {
      return `row ${extra} ${rowSelected ? 'selected' : ''} ${refClickSelected ? 'ref-click-selected' : ''} ${focused ? 'focused' : ''} ${dragId === rowId ? 'dragging' : ''} ${dropPosition ? `drop-${dropPosition}` : ''}`.trim();
    },
  };
}
