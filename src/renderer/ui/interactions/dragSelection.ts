import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { NodeId } from '../../api/types';
import { flattenVisibleRows, type DocumentIndex, type UiState } from '../../state/document';
import { clearFocusState } from '../focus/focusModel';

const DRAG_SELECT_THRESHOLD_PX = 5;

export const dragSelectionState = {
  justDragged: false,
};

interface DragSelectionContext {
  rootId: NodeId | null;
  index: DocumentIndex | null;
  ui: UiState;
}

interface UseDragSelectionOptions extends DragSelectionContext {
  setUi: Dispatch<SetStateAction<UiState>>;
}

function rowIdFromPoint(x: number, y: number): NodeId | null {
  const element = document.elementFromPoint(x, y);
  if (!(element instanceof HTMLElement)) return null;
  const row = element.closest<HTMLElement>('[data-node-id][data-parent-id]');
  return row?.dataset.nodeId ?? null;
}

function isInteractiveDragSelectionTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true;
  return Boolean(target.closest([
    'button',
    '[role="button"]',
    '[draggable="true"]',
    '[data-preserve-selection]',
    'select',
    'textarea',
  ].join(',')));
}

function isTextSelectionTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return true;
  return Boolean(target.closest('.ProseMirror, [contenteditable="true"]'));
}

function selectedRange(rows: NodeId[], startId: NodeId, endId: NodeId): NodeId[] {
  const startIndex = rows.indexOf(startId);
  const endIndex = rows.indexOf(endId);
  if (startIndex < 0 || endIndex < 0) return [];
  const [from, to] = startIndex <= endIndex
    ? [startIndex, endIndex]
    : [endIndex, startIndex];
  return rows.slice(from, to + 1);
}

function visibleRows(context: DragSelectionContext): NodeId[] {
  if (!context.rootId || !context.index) return [];
  return flattenVisibleRows(
    context.rootId,
    context.index.byId,
    context.ui.expanded,
    context.ui.expandedHiddenFields,
  );
}

export function useDragSelection(options: UseDragSelectionOptions) {
  const contextRef = useRef<DragSelectionContext>({
    rootId: options.rootId,
    index: options.index,
    ui: options.ui,
  });
  contextRef.current = {
    rootId: options.rootId,
    index: options.index,
    ui: options.ui,
  };

  const setUiRef = useRef(options.setUi);
  setUiRef.current = options.setUi;

  const dragRef = useRef({
    active: false,
    startX: 0,
    startY: 0,
    startId: null as NodeId | null,
    startedOnText: false,
  });

  useEffect(() => {
    const cleanup = () => {
      dragRef.current.active = false;
      dragRef.current.startId = null;
      document.body.classList.remove('drag-selecting');
    };

    const applySelection = (hoverId: NodeId) => {
      const startId = dragRef.current.startId;
      if (!startId) return;
      const rows = visibleRows(contextRef.current);
      const range = selectedRange(rows, startId, hoverId);
      if (range.length === 0) return;
      setUiRef.current((prev) => ({
        ...clearFocusState(prev),
        selectedId: hoverId,
        selectedIds: new Set(range),
        selectionAnchorId: startId,
        batchTagSelectorOpen: false,
      }));
    };

    const onMouseDown = (event: MouseEvent) => {
      if (
        event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.shiftKey
        || event.altKey
        || isInteractiveDragSelectionTarget(event.target)
      ) {
        return;
      }

      const startId = rowIdFromPoint(event.clientX, event.clientY);
      if (!startId || !visibleRows(contextRef.current).includes(startId)) return;

      dragRef.current = {
        active: false,
        startX: event.clientX,
        startY: event.clientY,
        startId,
        startedOnText: isTextSelectionTarget(event.target),
      };
    };

    const onMouseMove = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag.startId || event.buttons !== 1) return;

      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (!drag.active && distance < DRAG_SELECT_THRESHOLD_PX) return;

      const hoverId = rowIdFromPoint(event.clientX, event.clientY);
      if (!hoverId) return;

      if (!drag.active && drag.startedOnText && hoverId === drag.startId) {
        const hoverElement = document.elementFromPoint(event.clientX, event.clientY);
        if (isTextSelectionTarget(hoverElement)) {
          const textSelection = window.getSelection();
          if (textSelection && !textSelection.isCollapsed) return;
          return;
        }
      }

      if (!drag.active) {
        drag.active = true;
        window.getSelection()?.removeAllRanges();
        document.body.classList.add('drag-selecting');
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        applySelection(drag.startId);
      }

      event.preventDefault();
      applySelection(hoverId);
    };

    const onMouseUp = () => {
      if (dragRef.current.active) {
        dragSelectionState.justDragged = true;
        window.setTimeout(() => {
          dragSelectionState.justDragged = false;
        }, 0);
      }
      cleanup();
    };

    const onClick = (event: MouseEvent) => {
      if (!dragSelectionState.justDragged) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('click', onClick, true);
      cleanup();
    };
  }, []);
}
