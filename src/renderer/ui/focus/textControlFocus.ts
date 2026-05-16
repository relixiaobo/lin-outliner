import type { CursorPlacement } from '../../state/document';

export type TextControlElement = HTMLInputElement | HTMLTextAreaElement;

export function isTextControlElement(element: Element | null): element is TextControlElement {
  if (element instanceof HTMLTextAreaElement) return true;
  if (!(element instanceof HTMLInputElement)) return false;
  return [
    'email',
    'password',
    'search',
    'tel',
    'text',
    'url',
    'number',
  ].includes(element.type);
}

export function setTextControlCursor(element: TextControlElement, placement: CursorPlacement) {
  if (placement.kind === 'preserve') return;
  if (placement.kind === 'all') {
    element.select();
    return;
  }

  const cursor = placement.kind === 'start'
    ? 0
    : placement.kind === 'text-offset'
      ? placement.offset
      : element.value.length;
  const bounded = Math.max(0, Math.min(element.value.length, cursor));
  element.setSelectionRange(bounded, bounded);
}

export function insertTextIntoControlValue(params: {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  text: string;
}): { value: string; cursor: number } {
  const { value, selectionStart, selectionEnd, text } = params;
  const from = Math.max(0, Math.min(value.length, selectionStart ?? value.length));
  const to = Math.max(from, Math.min(value.length, selectionEnd ?? from));
  return {
    value: `${value.slice(0, from)}${text}${value.slice(to)}`,
    cursor: from + text.length,
  };
}
