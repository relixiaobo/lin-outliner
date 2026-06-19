import { useCallback, useRef } from 'react';

export interface DisclosureScrollAnchorSnapshot {
  readonly element: HTMLElement;
  readonly resolveElement?: () => HTMLElement | null;
  readonly scroller: HTMLElement;
  readonly top: number;
}

export interface DisclosureScrollAnchorRestoreResult {
  readonly moved: boolean;
  readonly restored: boolean;
}

export function nearestScrollContainer(element: HTMLElement | null, fallback?: HTMLElement | null): HTMLElement | null {
  let current = element?.parentElement ?? null;
  while (current) {
    const style = getComputedStyle(current);
    if (
      (style.overflowY === 'auto' || style.overflowY === 'scroll')
      && current.scrollHeight > current.clientHeight
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return fallback ?? null;
}

export function captureDisclosureScrollAnchor(
  element: HTMLElement | null,
  scroller: HTMLElement | null = element ? nearestScrollContainer(element) : null,
  resolveElement?: () => HTMLElement | null,
): DisclosureScrollAnchorSnapshot | null {
  if (!element || !scroller || !scroller.contains(element)) return null;
  return {
    element,
    resolveElement,
    scroller,
    top: element.getBoundingClientRect().top,
  };
}

export function restoreDisclosureScrollAnchor(
  snapshot: DisclosureScrollAnchorSnapshot | null,
): DisclosureScrollAnchorRestoreResult {
  if (!snapshot || !snapshot.scroller.isConnected) return { moved: false, restored: false };
  const element = snapshot.element.isConnected
    ? snapshot.element
    : snapshot.resolveElement?.() ?? null;
  if (!element || !snapshot.scroller.contains(element)) return { moved: false, restored: false };
  const delta = element.getBoundingClientRect().top - snapshot.top;
  if (Math.abs(delta) < 1) return { moved: false, restored: true };
  snapshot.scroller.scrollTop += delta;
  return { moved: true, restored: true };
}

export function usePendingDisclosureAnchor(onRestore?: () => void) {
  const pendingAnchorRef = useRef<DisclosureScrollAnchorSnapshot | null>(null);

  const capturePendingAnchor = useCallback((snapshot: DisclosureScrollAnchorSnapshot | null) => {
    pendingAnchorRef.current = snapshot;
  }, []);

  const restorePendingAnchor = useCallback(() => {
    const anchor = pendingAnchorRef.current;
    pendingAnchorRef.current = null;
    const result = restoreDisclosureScrollAnchor(anchor);
    if (!result.restored || !anchor) return undefined;
    onRestore?.();
    if (!result.moved) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const nextResult = restoreDisclosureScrollAnchor(anchor);
      if (nextResult.restored) onRestore?.();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [onRestore]);

  return { capturePendingAnchor, restorePendingAnchor };
}
