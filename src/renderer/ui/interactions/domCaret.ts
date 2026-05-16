export function textOffsetFromPoint(container: HTMLElement, clientX: number, clientY: number): number | null {
  const doc = container.ownerDocument;
  const caretDocument = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => CaretPosition | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };

  let startContainer: Node | null = null;
  let startOffset = 0;

  try {
    const position = caretDocument.caretPositionFromPoint?.(clientX, clientY);
    if (position) {
      startContainer = position.offsetNode;
      startOffset = position.offset;
    } else {
      const range = caretDocument.caretRangeFromPoint?.(clientX, clientY);
      if (range) {
        startContainer = range.startContainer;
        startOffset = range.startOffset;
      }
    }
  } catch {
    return null;
  }

  if (!startContainer || !container.contains(startContainer)) return null;

  try {
    const range = doc.createRange();
    range.setStart(container, 0);
    range.setEnd(startContainer, startOffset);
    return range.toString().length;
  } catch {
    return null;
  }
}

export function renderedTextRightEdge(container: HTMLElement): number | null {
  const doc = container.ownerDocument;
  try {
    let maxRight = -Infinity;
    const walker = doc.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            return (node.textContent ?? '').length > 0
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_REJECT;
          }
          const element = node as HTMLElement;
          if (element === container) return NodeFilter.FILTER_SKIP;
          if (element.matches('[data-inline-ref], .inline-ref, .inline-reference')) {
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_SKIP;
        },
      },
    );

    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const range = doc.createRange();
        range.selectNodeContents(node);
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width > 0 || rect.height > 0) maxRight = Math.max(maxRight, rect.right);
        }
      } else if (node instanceof HTMLElement) {
        const rect = node.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) maxRight = Math.max(maxRight, rect.right);
      }
      node = walker.nextNode();
    }

    return Number.isFinite(maxRight) ? maxRight : null;
  } catch {
    return null;
  }
}

export function resolveTextOffsetFromPoint(params: {
  container: HTMLElement;
  clientX: number;
  clientY: number;
  textLength: number;
}): number {
  const { container, clientX, clientY, textLength } = params;
  const textOffset = textOffsetFromPoint(container, clientX, clientY);
  const rightEdge = renderedTextRightEdge(container);
  if (rightEdge !== null && clientX > rightEdge + 1) return textLength;
  if (textOffset !== null) return Math.max(0, Math.min(textLength, textOffset));

  const rect = container.getBoundingClientRect();
  if (clientX <= rect.left + 2) return 0;
  return textLength;
}

