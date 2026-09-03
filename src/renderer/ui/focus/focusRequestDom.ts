export function focusElementForRequest(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected) return false;
  element.focus({ preventScroll: true });
  return element.ownerDocument.activeElement === element;
}

export function focusIsUnclaimed(
  activeElement: Element | null,
  body: HTMLElement | null,
): boolean {
  return activeElement === null || activeElement === body;
}
