import { useEffect, type RefObject } from 'react';

interface DismissibleOverlayOptions {
  disabled?: boolean;
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
  useEffect(() => {
    if (options.disabled) return undefined;
    const closeOnOutsideMouseDown = (event: globalThis.MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      onDismiss();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('mousedown', closeOnOutsideMouseDown);
    if (escape) document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideMouseDown);
      if (escape) document.removeEventListener('keydown', closeOnEscape);
    };
  }, [escape, onDismiss, options.disabled, ref]);
}
