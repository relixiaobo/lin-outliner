import {
  useLayoutEffect,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';

type PopoverSelectionMode = 'clamp' | 'reset';

interface PopoverSelectionOptions {
  initialIndex?: number;
  itemCount: number;
  listRef: RefObject<HTMLElement | null>;
  mode?: PopoverSelectionMode;
  open?: boolean;
  selectionKey: string;
}

export function normalizedPopoverIndex(
  index: number,
  itemCount: number,
  minimumIndex = 0,
): number {
  if (itemCount <= 0) return minimumIndex;
  return Math.min(Math.max(index, minimumIndex), itemCount - 1);
}

/**
 * Keeps a transient listbox selection aligned with the list rendered for the
 * current query. Both reconciliation and scroll happen before paint so a new
 * result set never presents the previous result set's highlight for one frame.
 */
export function usePopoverSelection({
  initialIndex = 0,
  itemCount,
  listRef,
  mode = 'reset',
  open = true,
  selectionKey,
}: PopoverSelectionOptions): [number, Dispatch<SetStateAction<number>>] {
  const [selectedIndex, setSelectedIndex] = useState(() => (
    normalizedPopoverIndex(initialIndex, itemCount, initialIndex)
  ));

  useLayoutEffect(() => {
    setSelectedIndex((current) => {
      const next = mode === 'reset'
        ? normalizedPopoverIndex(initialIndex, itemCount, initialIndex)
        : normalizedPopoverIndex(current, itemCount, initialIndex);
      return next === current ? current : next;
    });
  }, [initialIndex, itemCount, mode, selectionKey]);

  useLayoutEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [itemCount, listRef, open, selectedIndex, selectionKey]);

  return [selectedIndex, setSelectedIndex];
}
