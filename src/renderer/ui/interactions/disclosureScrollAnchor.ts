import { useCallback, useRef } from 'react';

const DISCLOSURE_ANCHOR_RESTORE_FRAMES = 12;

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
  const activeAnchorRef = useRef<DisclosureScrollAnchorSnapshot | null>(null);
  const restoreFramesRemainingRef = useRef(0);
  const restoreFrameRef = useRef<number | null>(null);

  const cancelRestoreFrame = useCallback(() => {
    if (restoreFrameRef.current === null) return;
    window.cancelAnimationFrame(restoreFrameRef.current);
    restoreFrameRef.current = null;
  }, []);

  const clearActiveAnchor = useCallback(() => {
    activeAnchorRef.current = null;
    restoreFramesRemainingRef.current = 0;
    cancelRestoreFrame();
  }, [cancelRestoreFrame]);

  const restoreActiveAnchor = useCallback(() => {
    const anchor = activeAnchorRef.current;
    const result = restoreDisclosureScrollAnchor(anchor);
    if (!result.restored) {
      clearActiveAnchor();
      return result;
    }
    if (anchor) onRestore?.();
    return result;
  }, [clearActiveAnchor, onRestore]);

  const scheduleRestoreFrame = useCallback(() => {
    if (!activeAnchorRef.current || restoreFrameRef.current !== null) return;
    if (restoreFramesRemainingRef.current <= 0) {
      clearActiveAnchor();
      return;
    }
    restoreFrameRef.current = window.requestAnimationFrame(() => {
      restoreFrameRef.current = null;
      restoreFramesRemainingRef.current -= 1;
      const result = restoreActiveAnchor();
      if (result.restored && activeAnchorRef.current) scheduleRestoreFrame();
    });
  }, [clearActiveAnchor, restoreActiveAnchor]);

  const capturePendingAnchor = useCallback((snapshot: DisclosureScrollAnchorSnapshot | null) => {
    cancelRestoreFrame();
    activeAnchorRef.current = snapshot;
    restoreFramesRemainingRef.current = snapshot ? DISCLOSURE_ANCHOR_RESTORE_FRAMES : 0;
  }, [cancelRestoreFrame]);

  const restorePendingAnchor = useCallback(() => {
    if (!activeAnchorRef.current) return undefined;
    const result = restoreActiveAnchor();
    if (result.restored) scheduleRestoreFrame();
    return cancelRestoreFrame;
  }, [cancelRestoreFrame, restoreActiveAnchor, scheduleRestoreFrame]);

  return { capturePendingAnchor, restorePendingAnchor };
}
