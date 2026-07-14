import { useEffect, useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { focusableElements } from './focusable';

interface DialogProps {
  backdropClassName: string;
  children: ReactNode;
  label?: string;
  labelledBy?: string;
  surfaceClassName: string;
  focusKey?: string | number;
  initialFocus?: () => HTMLElement | null;
  restoreFocus?: () => HTMLElement | null;
  onBackdropMouseDown?: () => void;
  onEscapeKeyDown?: () => void;
}

export function Dialog({
  backdropClassName,
  children,
  focusKey,
  initialFocus,
  label,
  labelledBy,
  onBackdropMouseDown,
  onEscapeKeyDown,
  restoreFocus,
  surfaceClassName,
}: DialogProps) {
  const surfaceRef = useRef<HTMLElement | null>(null);
  const initialFocusRef = useRef(initialFocus);
  const restoreFocusRef = useRef(restoreFocus);
  const focusKeyMountedRef = useRef(false);

  useEffect(() => {
    initialFocusRef.current = initialFocus;
    restoreFocusRef.current = restoreFocus;
  }, [initialFocus, restoreFocus]);

  useEffect(() => {
    const fallbackRestoreTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = initialFocusRef.current?.() ?? surfaceRef.current;
    target?.focus({ preventScroll: true });

    return () => {
      const explicitRestoreTarget = restoreFocusRef.current?.() ?? null;
      const restoreTarget = explicitRestoreTarget && document.contains(explicitRestoreTarget)
        ? explicitRestoreTarget
        : fallbackRestoreTarget;
      if (restoreTarget && document.contains(restoreTarget)) {
        restoreTarget.focus({ preventScroll: true });
      }
    };
  }, []);

  useLayoutEffect(() => {
    if (!focusKeyMountedRef.current) {
      focusKeyMountedRef.current = true;
      return;
    }
    const surface = surfaceRef.current;
    if (!surface || surface.contains(document.activeElement)) return;
    const target = initialFocusRef.current?.() ?? surface;
    target.focus({ preventScroll: true });
  }, [focusKey]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onEscapeKeyDown?.();
      return;
    }
    if (event.key !== 'Tab') return;

    const surface = surfaceRef.current;
    if (!surface) return;
    const focusable = focusableElements(surface);
    if (focusable.length === 0) {
      event.preventDefault();
      surface.focus({ preventScroll: true });
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === surface || !surface.contains(active))) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && (active === last || active === surface || !surface.contains(active))) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  };

  return (
    <div
      className={backdropClassName}
      onMouseDown={(event) => {
        const target = event.target as Node;
        if (surfaceRef.current?.contains(target)) return;
        onBackdropMouseDown?.();
      }}
    >
      <section
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-modal="true"
        className={surfaceClassName}
        onKeyDown={handleKeyDown}
        ref={surfaceRef}
        role="dialog"
        tabIndex={-1}
      >
        {children}
      </section>
    </div>
  );
}
