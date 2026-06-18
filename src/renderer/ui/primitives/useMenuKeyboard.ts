import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { focusableElements } from './focusable';

// Keyboard + focus management for floating overlays built on `useAnchoredOverlay`
// (not `Dialog`). Those overlays hand-roll positioning and outside-pointer
// dismissal but never move focus in, trap it, restore it on close, or — for
// `role="menu"` surfaces — provide Arrow-key navigation. This hook layers exactly
// those behaviors on top of an existing anchored overlay, mirroring what
// `Dialog` already does for true modals:
//
//   - focus-in on open: focus the first item (menu) or the surface (dialog),
//     unless something inside is already focused (respecting a child `autoFocus`).
//   - focus-restore on close: return focus to the trigger (or the element that
//     held focus when the overlay opened).
//   - Escape closes the overlay and is scoped to it (stopPropagation), so it
//     never leaks to a global Escape handler underneath.
//   - `menu` kind: roving Arrow/Home/End across the focusable items; Tab closes.
//   - `dialog` kind: Tab/Shift+Tab focus-trap (heterogeneous form content).
//
// IME-guarded so CJK composition keystrokes are never hijacked.

export type MenuKeyboardKind = 'menu' | 'dialog';
export type MenuInitialFocus = 'auto' | 'surface';

interface UseMenuKeyboardOptions {
  // The overlay surface (the portaled menu/dialog div).
  surfaceRef: RefObject<HTMLElement | null>;
  // Close the overlay (Escape / Tab-out of a menu).
  onClose: () => void;
  // `menu` → roving item navigation; `dialog` → focus-trap.
  kind: MenuKeyboardKind;
  // The overlay is shown. For surfaces that mount only while open this is always
  // true; for an always-mounted surface that toggles via a prop, pass the open
  // state so focus-in / restore fire on the open↔close transition.
  active?: boolean;
  // The element to return focus to on close (the trigger). Falls back to whatever
  // held focus when the overlay opened. Captured by value at open time.
  getRestoreTarget?: () => HTMLElement | null;
  // Identity of the surface's *content*. For an always-mounted surface that swaps
  // its body in place (a menu's Back, a toolbar switching section) focus may end
  // up outside the surface after the swap; bumping this re-runs focus-in so Escape
  // and roving keep working. Restore (close) is unaffected — it keys on `active`.
  focusKey?: string | number;
  // `auto` keeps the native/menu default (menus focus their first item; dialog
  // popovers focus the surface). `surface` keeps keyboard handling scoped to the
  // overlay without showing an item focus ring on pointer-opened menus.
  initialFocus?: MenuInitialFocus;
}

// Pure roving-navigation resolver: given the pressed key, the focused item index
// (-1 when focus is on the surface itself), and the item count, return the next
// index to focus, or null when the key is not a navigation key. Wraps at the ends.
// Extracted so the navigation logic is unit-testable without a real focus model.
export function resolveMenuNavigation(
  key: string,
  currentIndex: number,
  count: number,
): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown':
      return currentIndex < 0 ? 0 : (currentIndex + 1) % count;
    case 'ArrowUp':
      return currentIndex < 0 ? count - 1 : (currentIndex - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

export function useMenuKeyboard({
  surfaceRef,
  onClose,
  kind,
  active = true,
  getRestoreTarget,
  focusKey,
  initialFocus = 'auto',
}: UseMenuKeyboardOptions): { onKeyDown: (event: KeyboardEvent<HTMLElement>) => void } {
  const onCloseRef = useRef(onClose);
  const kindRef = useRef(kind);
  const getRestoreTargetRef = useRef(getRestoreTarget);
  const initialFocusRef = useRef(initialFocus);
  onCloseRef.current = onClose;
  kindRef.current = kind;
  getRestoreTargetRef.current = getRestoreTarget;
  initialFocusRef.current = initialFocus;

  // Restore lifecycle: capture the pre-open focus on open, return focus to the
  // trigger (or that fallback) on close. Keyed on `active` only, so an in-place
  // content swap (`focusKey`) never triggers a spurious restore-then-refocus.
  useEffect(() => {
    if (!active) return undefined;
    const restoreFallback = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const explicit = getRestoreTargetRef.current?.() ?? null;
      const restoreTarget = explicit && document.contains(explicit) ? explicit : restoreFallback;
      if (restoreTarget && document.contains(restoreTarget)) {
        restoreTarget.focus({ preventScroll: true });
      }
    };
  }, [active]);

  // Focus-in: pull focus into the surface on open and again whenever `focusKey`
  // changes (content swapped in place), unless a child already holds it.
  useEffect(() => {
    if (!active) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    // A bare div surface must be programmatically focusable to receive focus-in
    // (and to be the focus-trap fallback) without forcing every call site to wire
    // `tabIndex={-1}`.
    if (!surface.hasAttribute('tabindex')) surface.setAttribute('tabindex', '-1');

    // Respect a child that already grabbed focus (e.g. an `autoFocus` input in a
    // dialog-kind popover); only move focus in when it sits outside the surface.
    if (!surface.contains(document.activeElement)) {
      const target = initialFocusRef.current === 'surface'
        ? surface
        : kindRef.current === 'menu'
        ? (focusableElements(surface)[0] ?? surface)
        : surface;
      target.focus({ preventScroll: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, focusKey]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (isImeComposingEvent(event)) return;
    const surface = surfaceRef.current;
    if (!surface) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
      return;
    }

    if (kindRef.current === 'menu') {
      if (event.key === 'Tab') {
        // A menu is not part of the Tab sequence: Tab dismisses it and focus
        // restores to the trigger, matching native menu behavior.
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      const items = focusableElements(surface);
      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      const nextIndex = resolveMenuNavigation(event.key, currentIndex, items.length);
      if (nextIndex === null) return;
      event.preventDefault();
      items[nextIndex]?.focus({ preventScroll: true });
      return;
    }

    // dialog kind: focus-trap (mirrors Dialog.tsx).
    if (event.key !== 'Tab') return;
    const focusable = focusableElements(surface);
    if (focusable.length === 0) {
      event.preventDefault();
      surface.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const activeElement = document.activeElement;
    if (event.shiftKey && (activeElement === first || activeElement === surface || !surface.contains(activeElement))) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && (activeElement === last || activeElement === surface || !surface.contains(activeElement))) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  };

  return { onKeyDown };
}
