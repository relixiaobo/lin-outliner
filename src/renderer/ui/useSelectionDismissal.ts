import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { UiState } from '../state/document';
import { clearFocusState } from './focus/focusModel';
import {
  shouldClearSelectionOnFocusIn,
  shouldClearSelectionOnPointerDown,
  shouldPreserveSelectionForModifierGesture,
} from './interactions/selectionDismiss';

export function useSelectionDismissal(setUi: Dispatch<SetStateAction<UiState>>) {
  useEffect(() => {
    const clearBlockSelection = () => {
      setUi((prev) => {
        if (prev.focusedId || prev.selectedIds.size === 0) return prev;
        return {
          ...clearFocusState(prev),
          selectedId: null,
          selectedIds: new Set(),
          selectionAnchorId: null,
          selectionRootId: null,
          selectionSource: null,
          batchTagSelectorOpen: false,
        };
      });
    };

    const onPointerOrMouseDown = (event: PointerEvent | MouseEvent) => {
      if (shouldPreserveSelectionForModifierGesture(event)) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearSelectionOnPointerDown(target)) return;
      clearBlockSelection();
    };

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearSelectionOnFocusIn(target)) return;
      clearBlockSelection();
    };

    window.addEventListener('pointerdown', onPointerOrMouseDown, true);
    window.addEventListener('mousedown', onPointerOrMouseDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerOrMouseDown, true);
      window.removeEventListener('mousedown', onPointerOrMouseDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }, [setUi]);
}
