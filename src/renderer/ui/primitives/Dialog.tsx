import { useEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

interface DialogProps {
  backdropClassName: string;
  children: ReactNode;
  label?: string;
  labelledBy?: string;
  surfaceClassName: string;
  initialFocus?: () => HTMLElement | null;
  onBackdropMouseDown?: () => void;
  onEscapeKeyDown?: () => void;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true');
}

export function Dialog({
  backdropClassName,
  children,
  initialFocus,
  label,
  labelledBy,
  onBackdropMouseDown,
  onEscapeKeyDown,
  surfaceClassName,
}: DialogProps) {
  const surfaceRef = useRef<HTMLElement | null>(null);
  const initialFocusRef = useRef(initialFocus);

  useEffect(() => {
    const restoreTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = initialFocusRef.current?.() ?? surfaceRef.current;
    target?.focus({ preventScroll: true });

    return () => {
      if (restoreTarget && document.contains(restoreTarget)) {
        restoreTarget.focus({ preventScroll: true });
      }
    };
  }, []);

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
        if (event.target === event.currentTarget) onBackdropMouseDown?.();
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
