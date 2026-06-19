export interface DisclosureScrollAnchorSnapshot {
  readonly element: HTMLElement;
  readonly resolveElement?: () => HTMLElement | null;
  readonly scroller: HTMLElement;
  readonly top: number;
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

export function restoreDisclosureScrollAnchor(snapshot: DisclosureScrollAnchorSnapshot | null): boolean {
  if (!snapshot || !snapshot.scroller.isConnected) return false;
  const element = snapshot.element.isConnected
    ? snapshot.element
    : snapshot.resolveElement?.() ?? null;
  if (!element || !snapshot.scroller.contains(element)) return false;
  const delta = element.getBoundingClientRect().top - snapshot.top;
  if (Math.abs(delta) < 1) return true;
  snapshot.scroller.scrollTop += delta;
  return true;
}
