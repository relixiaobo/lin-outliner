import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { TRANSIENT_TEXT_SENTINEL } from './richTextCodec';

export function setDomSelectionAtDocSide(view: EditorView, position: number, side: 'before' | 'after') {
  try {
    const domPosition = view.domAtPos(position, side === 'after' ? 1 : -1);
    const selection = view.dom.ownerDocument.getSelection();
    selection?.collapse(domPosition.node, domPosition.offset);
  } catch {
    // The state selection is already correct; this only picks the visual DOM
    // side at a mark boundary when the browser exposes one.
  }
}

function closestInlineCodeElement(node: Node | null): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node?.parentElement;
  return element?.closest<HTMLElement>('code.pm-code') ?? null;
}

function textOffsetWithinElement(element: HTMLElement, node: Node, offset: number): number | null {
  try {
    const range = element.ownerDocument.createRange();
    range.setStart(element, 0);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

function childOffsetOf(parent: Node, child: Node): number {
  return Array.prototype.indexOf.call(parent.childNodes, child) as number;
}

function isProseMirrorTrailingBreak(node: Node | null): boolean {
  return node instanceof HTMLElement
    && node.nodeName === 'BR'
    && node.classList.contains('ProseMirror-trailingBreak');
}

function isEditableBoundarySibling(node: Node | null): boolean {
  if (!node || isProseMirrorTrailingBreak(node)) return false;
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').length > 0;
  return true;
}

export function moveInlineCodeCaretAcrossBoundary(view: EditorView, direction: 'left' | 'right'): boolean {
  const selection = view.dom.ownerDocument.getSelection();
  if (!selection?.isCollapsed || !selection.anchorNode) return false;

  const codeElement = closestInlineCodeElement(selection.anchorNode);
  if (!codeElement || !view.dom.contains(codeElement)) return false;

  const offset = textOffsetWithinElement(codeElement, selection.anchorNode, selection.anchorOffset);
  if (offset === null) return false;

  const textLength = codeElement.textContent?.length ?? 0;
  if (direction === 'left' && offset !== 0) return false;
  if (direction === 'right' && offset !== textLength) return false;

  const parent = codeElement.parentNode;
  if (!parent) return false;

  const childOffset = childOffsetOf(parent, codeElement);
  if (childOffset < 0) return false;
  const domOffset = direction === 'right' ? childOffset + 1 : childOffset;
  const hasOutsideDomPosition = direction === 'right'
    ? isEditableBoundarySibling(codeElement.nextSibling)
    : isEditableBoundarySibling(codeElement.previousSibling);

  let position: number;
  try {
    position = view.posAtDOM(parent, domOffset, direction === 'right' ? 1 : -1);
  } catch {
    return false;
  }

  let tr = view.state.tr;
  if (hasOutsideDomPosition) {
    tr = tr.setSelection(TextSelection.create(tr.doc, position));
  } else {
    tr = tr.insert(position, view.state.schema.text(TRANSIENT_TEXT_SENTINEL));
    tr = tr.setSelection(TextSelection.create(tr.doc, position + TRANSIENT_TEXT_SENTINEL.length));
  }
  tr = tr.setStoredMarks([]).scrollIntoView();
  view.dispatch(tr);
  queueMicrotask(() => {
    if (view.isDestroyed) return;
    if (hasOutsideDomPosition) {
      setDomSelectionAtDocSide(view, position, direction === 'right' ? 'after' : 'before');
    } else {
      setDomSelectionAtDocSide(view, position + TRANSIENT_TEXT_SENTINEL.length, direction === 'right' ? 'after' : 'before');
    }
  });
  return true;
}
