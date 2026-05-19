import { isImeComposingEvent } from './imeKeyboard';

export type SelectionKeyboardAction =
  | 'navigate_up'
  | 'navigate_down'
  | 'convert_reference_right'
  | 'extend_up'
  | 'extend_down'
  | 'enter_edit'
  | 'type_char'
  | 'clear_selection'
  | 'select_all'
  | 'batch_copy'
  | 'batch_cut'
  | 'batch_duplicate'
  | 'batch_delete'
  | 'batch_indent'
  | 'batch_outdent'
  | 'batch_checkbox'
  | 'batch_apply_tag'
  | 'batch_move_up'
  | 'batch_move_down';

export function resolveSelectionKeyboardAction(event: KeyboardEvent): SelectionKeyboardAction | null {
  if (isImeComposingEvent(event)) return null;

  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.shiftKey && !event.altKey && event.key === 'ArrowUp') {
    return 'batch_move_up';
  }
  if (mod && event.shiftKey && !event.altKey && event.key === 'ArrowDown') {
    return 'batch_move_down';
  }
  if (event.shiftKey && !mod && !event.altKey && event.key === 'ArrowUp') {
    return 'extend_up';
  }
  if (event.shiftKey && !mod && !event.altKey && event.key === 'ArrowDown') {
    return 'extend_down';
  }
  if (mod && event.key.toLowerCase() === 'a' && !event.shiftKey && !event.altKey) {
    return 'select_all';
  }
  if (mod && event.key.toLowerCase() === 'c' && !event.shiftKey && !event.altKey) {
    return 'batch_copy';
  }
  if (mod && event.key.toLowerCase() === 'x' && !event.shiftKey && !event.altKey) {
    return 'batch_cut';
  }
  if (mod && event.key.toLowerCase() === 'd' && event.shiftKey && !event.altKey) {
    return 'batch_duplicate';
  }
  if (mod && event.key === 'Enter' && !event.shiftKey && !event.altKey) {
    return 'batch_checkbox';
  }
  if (event.key === 'Backspace' || event.key === 'Delete') {
    if (!mod && !event.shiftKey && !event.altKey) return 'batch_delete';
  }
  if (event.key === 'Tab' && event.shiftKey && !mod && !event.altKey) {
    return 'batch_outdent';
  }
  if (event.key === 'Tab' && !event.shiftKey && !mod && !event.altKey) {
    return 'batch_indent';
  }
  if (event.key === '#' && !mod && !event.altKey) {
    return 'batch_apply_tag';
  }
  if (event.key === 'ArrowUp' && !event.shiftKey && !mod && !event.altKey) {
    return 'navigate_up';
  }
  if (event.key === 'ArrowDown' && !event.shiftKey && !mod && !event.altKey) {
    return 'navigate_down';
  }
  if (event.key === 'ArrowRight' && !event.shiftKey && !mod && !event.altKey) {
    return 'convert_reference_right';
  }
  if (event.key === 'Enter' && !event.shiftKey && !mod && !event.altKey) {
    return 'enter_edit';
  }
  if (event.key === 'Escape') {
    return 'clear_selection';
  }
  if (event.key.length === 1 && !mod && !event.altKey) {
    return 'type_char';
  }

  return null;
}

export function shouldIgnoreSelectionKeyboardTarget(
  target: EventTarget | null,
  options: { allowContentEditable?: boolean } = {},
): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  return target.isContentEditable && !options.allowContentEditable;
}
