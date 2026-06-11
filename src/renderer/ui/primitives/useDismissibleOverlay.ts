import { useEffect, type RefObject } from 'react';

interface DismissibleOverlayOptions {
  disabled?: boolean;
}

export function useDismissibleOverlay(
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  options: DismissibleOverlayOptions = {},
) {
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
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideMouseDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [onDismiss, options.disabled, ref]);
}
