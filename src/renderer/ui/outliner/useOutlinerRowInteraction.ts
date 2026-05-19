import {
  useCallback,
  useState,
  type CSSProperties,
  type Dispatch,
  type DragEvent,
  type MouseEvent,
  type SetStateAction,
} from 'react';
import { api } from '../../api/client';
import type { NodeId } from '../../api/types';
import type { DocumentIndex, UiState } from '../../state/document';
import { OUTLINER_NODE_DRAG_MIME, resolveOutlinerDropMove } from '../interactions/dragDrop';
import { flattenVisibleRows } from '../../state/document';
import { resolveDropHoverPosition, type DropHoverPosition } from '../interactions/dropPosition';
import {
  resolveRowPointerSelectAction,
  shouldPreserveSelectedRowContextClick,
} from '../interactions/rowPointerSelection';
import { toggleVisibleSelection } from '../interactions/selectionActions';
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
import { buildOutlinerRows, shouldShowTrailingInput } from './row-model';

interface UseOutlinerRowInteractionOptions {
  rowId: NodeId;
  parentId: NodeId;
  childParentId?: NodeId;
  panelId: string;
  rootId: NodeId;
  depth: number;
  childIds: NodeId[];
  index: DocumentIndex;
  ui: UiState;
  setUi: Dispatch<SetStateAction<UiState>>;
  run: CommandRunner;
  locked?: boolean;
  dragId: NodeId | null;
  setDragId: (nodeId: NodeId | null) => void;
}

export function useOutlinerRowInteraction(options: UseOutlinerRowInteractionOptions) {
  const {
    rowId,
    parentId,
    childParentId = rowId,
    panelId,
    rootId,
    depth,
    childIds,
    index,
    ui,
    setUi,
    run,
    locked,
    dragId,
    setDragId,
  } = options;
  const byId = index.byId;
  const [dropPosition, setDropPosition] = useState<DropHoverPosition | null>(null);
  const expanded = ui.expanded.has(rowId);
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

  const updateSelection = useCallback(() => {
    setUi((prev) => selectFocusState(prev, rowFocusTarget(rowId, parentId, panelId)));
  }, [panelId, parentId, rowId, setUi]);

  const toggleExpandOrSelect = useCallback(() => {
    if (!hasChildren) {
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
  }, [childParentId, expanded, hasChildren, panelId, parentId, rowId, setUi]);

  const moveFocus = useCallback((direction: 1 | -1) => {
    const scopeShowsTrailingInput = (scopeParentId: NodeId) => {
      if (scopeParentId === rootId) return true;
      return shouldShowTrailingInput(buildOutlinerRows(byId.get(scopeParentId), byId));
    };

    if (direction === 1 && expanded) {
      const childRows = buildOutlinerRows(byId.get(childParentId), byId);
      if (childRows.length === 0 && shouldShowTrailingInput(childRows)) {
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

    const rows = flattenVisibleRows(rootId, byId, ui.expanded, ui.expandedHiddenFields);
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
  }, [byId, childParentId, expanded, panelId, parentId, rootId, rowId, setUi, ui.expanded, ui.expandedHiddenFields]);

  const focusLastVisibleChild = useCallback(() => {
    const rows = flattenVisibleRows(childParentId, byId, ui.expanded, ui.expandedHiddenFields);
    const last = rows[rows.length - 1] ?? childIds[childIds.length - 1];
    if (!last) return;
    const lastNode = byId.get(last);
    setUi((prev) => requestFocusState(
      prev,
      rowFocusTarget(last, lastNode?.parentId ?? rowId, panelId),
      cursorEnd(),
    ));
  }, [byId, childIds, childParentId, panelId, rowId, setUi, ui.expanded, ui.expandedHiddenFields]);

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
    const target = event.target as HTMLElement;
    if (target.closest('button')) return;
    if (shouldPreserveSelectedRowContextClick({
      button: event.button,
      rowSelected: ui.selectedIds.has(rowId),
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
    const rows = flattenVisibleRows(rootId, byId, ui.expanded, ui.expandedHiddenFields);
    const selectionMeta: Pick<UiState, 'selectionRootId' | 'selectionSource'> = {
      selectionRootId: rootId,
      selectionSource: 'global',
    };
    let appliedSelection: {
      selectedId: NodeId | null;
      selectedIds: Set<NodeId>;
      selectionAnchorId: NodeId;
    } | null = null;

    if (action === 'range') {
      const anchor = ui.selectionAnchorId && rows.includes(ui.selectionAnchorId)
        ? ui.selectionAnchorId
        : ui.selectedId ?? rowId;
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
      const selectedIds = toggleVisibleSelection(rows, ui.selectedIds, rowId);
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
  }, [
    byId,
    rootId,
    rowId,
    setUi,
    ui.expanded,
    ui.expandedHiddenFields,
    ui.selectedId,
    ui.selectedIds,
    ui.selectionAnchorId,
  ]);

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
    setDragId(null);
    setDropPosition(null);
  }, [setDragId]);

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!dragId || dragId === rowId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    setDropPosition(resolveDropHoverPosition({
      offsetY: event.clientY - rect.top,
      rowHeight: rect.height,
    }));
  }, [dragId, rowId]);

  const onDrop = useCallback(async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const position = dropPosition ?? 'before';
    setDropPosition(null);
    if (!dragId || dragId === rowId) return;

    const siblings = byId.get(parentId)?.children ?? [];
    const targetIndex = siblings.indexOf(rowId);
    const dragParentId = byId.get(dragId)?.parentId ?? null;
    const dragIndex = dragParentId === parentId
      ? siblings.indexOf(dragId)
      : byId.get(dragParentId ?? '')?.children.indexOf(dragId) ?? -1;
    const move = resolveOutlinerDropMove({
      dragNodeId: dragId,
      targetNodeId: rowId,
      targetParentId: parentId,
      siblingIndex: targetIndex,
      dropPosition: position,
      targetHasChildren: hasChildren,
      targetIsExpanded: expanded,
      currentParentId: dragParentId,
      currentIndex: dragIndex,
    });

    if (!move) {
      setDragId(null);
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
      await run(() => api.moveNode(dragId, move.parentId, move.index));
    } finally {
      setDragId(null);
    }
  }, [byId, dragId, dropPosition, expanded, hasChildren, parentId, rowId, run, setDragId, setUi]);

  const wrapStyle: CSSProperties = { marginLeft: depth * 28 };

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
      style: wrapStyle,
      onDragOver,
      onDragLeave: () => setDropPosition(null),
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
