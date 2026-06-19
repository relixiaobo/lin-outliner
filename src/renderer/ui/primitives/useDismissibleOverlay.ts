import { useEffect, type RefObject } from 'react';

const EMPTY_IGNORE_REFS: Array<RefObject<HTMLElement | null>> = [];

interface DismissibleOverlayOptions {
  disabled?: boolean;
  ignoreRefs?: Array<RefObject<HTMLElement | null>>;
  // Leave Escape to a more specific owner (e.g. `useMenuKeyboard`, which scopes ESC
  // to the focused surface and restores focus). When false, this hook only handles
  // outside-pointer dismissal. Defaults to true (outside-pointer + Escape).
  escape?: boolean;
}

export function useDismissibleOverlay(
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  options: DismissibleOverlayOptions = {},
) {
  const escape = options.escape ?? true;
  const ignoreRefs = options.ignoreRefs ?? EMPTY_IGNORE_REFS;
  useEffect(() => {
    if (options.disabled) return undefined;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target)) return;
      if (ignoreRefs.some((ignoreRef) => ignoreRef.current?.contains(target))) return;
      onDismiss();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('pointerdown', closeOnOutsidePointerDown, true);
    if (escape) document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointerDown, true);
      if (escape) document.removeEventListener('keydown', closeOnEscape);
    };
  }, [escape, ignoreRefs, onDismiss, options.disabled, ref]);
}
