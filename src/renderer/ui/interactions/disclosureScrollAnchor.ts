import { useCallback, useEffect, useRef } from 'react';

const DISCLOSURE_ANCHOR_RESTORE_FRAMES = 12;
const DISCLOSURE_ANCHOR_HOLD_TIMEOUT_MS = 3_000;
const SCROLL_INTENT_KEYS = new Set(['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' ']);

export interface DisclosureScrollAnchorSnapshot {
  readonly element: HTMLElement;
  readonly resolveElement?: () => HTMLElement | null;
  readonly scroller: HTMLElement;
  readonly top: number;
}

export interface DisclosureScrollAnchorRestoreResult {
  readonly moved: boolean;
  readonly remainingDelta: number;
  readonly restored: boolean;
}

export interface DisclosureScrollAnchorHold {
  readonly settle: () => void;
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
  if (!snapshot || !snapshot.scroller.isConnected) {
    return { moved: false, remainingDelta: 0, restored: false };
  }
  const element = snapshot.element.isConnected
    ? snapshot.element
    : snapshot.resolveElement?.() ?? null;
  if (!element || !snapshot.scroller.contains(element)) {
    return { moved: false, remainingDelta: 0, restored: false };
  }
  const delta = element.getBoundingClientRect().top - snapshot.top;
  if (Math.abs(delta) < 1) return { moved: false, remainingDelta: 0, restored: true };
  const previousScrollTop = snapshot.scroller.scrollTop;
  snapshot.scroller.scrollTop += delta;
  return {
    moved: Math.abs(snapshot.scroller.scrollTop - previousScrollTop) >= 1,
    remainingDelta: element.getBoundingClientRect().top - snapshot.top,
    restored: true,
  };
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'select' || tagName === 'textarea';
}

function isScrollIntentKey(event: KeyboardEvent) {
  return SCROLL_INTENT_KEYS.has(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey && !isEditableTarget(event.target);
}

export function usePendingDisclosureAnchor(
  onRestore?: (result: DisclosureScrollAnchorRestoreResult) => void,
  onRelease?: () => void,
) {
  const activeAnchorRef = useRef<DisclosureScrollAnchorSnapshot | null>(null);
  const expectedScrollTopRef = useRef<number | null>(null);
  const interactionCleanupRef = useRef<(() => void) | null>(null);
  const holdCountRef = useRef(0);
  const holdTimeoutsRef = useRef(new Set<number>());
  const anchorGenerationRef = useRef(0);
  const onReleaseRef = useRef(onRelease);
  const onRestoreRef = useRef(onRestore);
  const restoringRef = useRef(false);
  const restoreFramesRemainingRef = useRef(0);
  const restoreFrameRef = useRef<number | null>(null);
  onReleaseRef.current = onRelease;
  onRestoreRef.current = onRestore;

  const cancelRestoreFrame = useCallback(() => {
    if (restoreFrameRef.current === null) return;
    window.cancelAnimationFrame(restoreFrameRef.current);
    restoreFrameRef.current = null;
  }, []);

  const clearInteractionListeners = useCallback(() => {
    interactionCleanupRef.current?.();
    interactionCleanupRef.current = null;
  }, []);

  const clearHoldTimeouts = useCallback(() => {
    for (const timeout of holdTimeoutsRef.current) window.clearTimeout(timeout);
    holdTimeoutsRef.current.clear();
  }, []);

  const clearActiveAnchor = useCallback(() => {
    const hadActiveAnchor = activeAnchorRef.current !== null;
    anchorGenerationRef.current += 1;
    activeAnchorRef.current = null;
    expectedScrollTopRef.current = null;
    holdCountRef.current = 0;
    restoreFramesRemainingRef.current = 0;
    cancelRestoreFrame();
    clearHoldTimeouts();
    clearInteractionListeners();
    if (hadActiveAnchor) onReleaseRef.current?.();
  }, [cancelRestoreFrame, clearHoldTimeouts, clearInteractionListeners]);

  const installInteractionListeners = useCallback((snapshot: DisclosureScrollAnchorSnapshot) => {
    clearInteractionListeners();
    const win = snapshot.scroller.ownerDocument.defaultView ?? window;
    const clearOnIntent = () => clearActiveAnchor();
    const clearOnScroll = () => {
      if (restoringRef.current) return;
      const anchor = activeAnchorRef.current;
      const expectedScrollTop = expectedScrollTopRef.current;
      if (!anchor || expectedScrollTop === null) return;
      if (Math.abs(anchor.scroller.scrollTop - expectedScrollTop) >= 1) clearActiveAnchor();
    };
    const clearOnKey = (event: KeyboardEvent) => {
      if (isScrollIntentKey(event)) clearActiveAnchor();
    };

    win.addEventListener('keydown', clearOnKey, { capture: true });
    win.addEventListener('pointerdown', clearOnIntent, { capture: true, passive: true });
    win.addEventListener('touchmove', clearOnIntent, { capture: true, passive: true });
    win.addEventListener('wheel', clearOnIntent, { capture: true, passive: true });
    win.addEventListener('scroll', clearOnScroll, { capture: true, passive: true });
    snapshot.scroller.addEventListener('scroll', clearOnScroll, { passive: true });

    interactionCleanupRef.current = () => {
      win.removeEventListener('keydown', clearOnKey, true);
      win.removeEventListener('pointerdown', clearOnIntent, true);
      win.removeEventListener('touchmove', clearOnIntent, true);
      win.removeEventListener('wheel', clearOnIntent, true);
      win.removeEventListener('scroll', clearOnScroll, true);
      snapshot.scroller.removeEventListener('scroll', clearOnScroll);
    };
  }, [clearActiveAnchor, clearInteractionListeners]);

  const restoreActiveAnchor = useCallback(() => {
    const anchor = activeAnchorRef.current;
    restoringRef.current = true;
    const result = restoreDisclosureScrollAnchor(anchor);
    restoringRef.current = false;
    if (!result.restored) {
      clearActiveAnchor();
      return result;
    }
    if (anchor) {
      onRestoreRef.current?.(result);
      expectedScrollTopRef.current = anchor.scroller.scrollTop;
    }
    return result;
  }, [clearActiveAnchor]);

  const scheduleRestoreFrame = useCallback(() => {
    if (!activeAnchorRef.current || restoreFrameRef.current !== null) return;
    if (restoreFramesRemainingRef.current <= 0) {
      if (holdCountRef.current > 0) return;
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
    if (!snapshot) {
      clearActiveAnchor();
      return;
    }
    cancelRestoreFrame();
    clearHoldTimeouts();
    anchorGenerationRef.current += 1;
    activeAnchorRef.current = snapshot;
    expectedScrollTopRef.current = snapshot.scroller.scrollTop;
    holdCountRef.current = 0;
    restoreFramesRemainingRef.current = DISCLOSURE_ANCHOR_RESTORE_FRAMES;
    installInteractionListeners(snapshot);
    scheduleRestoreFrame();
  }, [
    cancelRestoreFrame,
    clearActiveAnchor,
    clearHoldTimeouts,
    installInteractionListeners,
    scheduleRestoreFrame,
  ]);

  const holdUntilSettled = useCallback((): DisclosureScrollAnchorHold | null => {
    const anchor = activeAnchorRef.current;
    if (!anchor) return null;
    const generation = anchorGenerationRef.current;
    const win = anchor.scroller.ownerDocument.defaultView ?? window;
    let settled = false;
    let timeout: number | null = null;
    holdCountRef.current += 1;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (timeout !== null) {
        win.clearTimeout(timeout);
        holdTimeoutsRef.current.delete(timeout);
      }
      if (generation !== anchorGenerationRef.current || !activeAnchorRef.current) return;
      holdCountRef.current = Math.max(0, holdCountRef.current - 1);
      if (holdCountRef.current > 0) return;
      restoreFramesRemainingRef.current = DISCLOSURE_ANCHOR_RESTORE_FRAMES;
      scheduleRestoreFrame();
    };
    timeout = win.setTimeout(settle, DISCLOSURE_ANCHOR_HOLD_TIMEOUT_MS);
    holdTimeoutsRef.current.add(timeout);
    return { settle };
  }, [scheduleRestoreFrame]);

  const restorePendingAnchor = useCallback(() => {
    if (!activeAnchorRef.current) return undefined;
    const result = restoreActiveAnchor();
    if (result.restored) scheduleRestoreFrame();
    return cancelRestoreFrame;
  }, [cancelRestoreFrame, restoreActiveAnchor, scheduleRestoreFrame]);

  const hasPendingAnchor = useCallback(() => activeAnchorRef.current !== null, []);

  useEffect(() => () => {
    onReleaseRef.current = undefined;
    clearActiveAnchor();
  }, [clearActiveAnchor]);

  return {
    cancelPendingAnchor: clearActiveAnchor,
    capturePendingAnchor,
    hasPendingAnchor,
    holdUntilSettled,
    restorePendingAnchor,
  };
}
