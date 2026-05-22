import { isImeComposingEvent } from './imeKeyboard';
import { matchesShortcutEvent } from './shortcutRegistry';

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

  if (matchesShortcutEvent(event, 'selection.move_up')) {
    return 'batch_move_up';
  }
  if (matchesShortcutEvent(event, 'selection.move_down')) {
    return 'batch_move_down';
  }
  if (matchesShortcutEvent(event, 'selection.extend_up')) {
    return 'extend_up';
  }
  if (matchesShortcutEvent(event, 'selection.extend_down')) {
    return 'extend_down';
  }
  if (matchesShortcutEvent(event, 'selection.select_all')) {
    return 'select_all';
  }
  if (matchesShortcutEvent(event, 'selection.copy')) {
    return 'batch_copy';
  }
  if (matchesShortcutEvent(event, 'selection.cut')) {
    return 'batch_cut';
  }
  if (matchesShortcutEvent(event, 'selection.duplicate')) {
    return 'batch_duplicate';
  }
  if (matchesShortcutEvent(event, 'selection.checkbox')) {
    return 'batch_checkbox';
  }
  if (matchesShortcutEvent(event, 'selection.delete')) {
    return 'batch_delete';
  }
  if (matchesShortcutEvent(event, 'selection.outdent')) {
    return 'batch_outdent';
  }
  if (matchesShortcutEvent(event, 'selection.indent')) {
    return 'batch_indent';
  }
  if (matchesShortcutEvent(event, 'selection.apply_tag')) {
    return 'batch_apply_tag';
  }
  if (matchesShortcutEvent(event, 'selection.navigate_up')) {
    return 'navigate_up';
  }
  if (matchesShortcutEvent(event, 'selection.navigate_down')) {
    return 'navigate_down';
  }
  if (matchesShortcutEvent(event, 'selection.convert_reference_right')) {
    return 'convert_reference_right';
  }
  if (matchesShortcutEvent(event, 'selection.enter_edit')) {
    return 'enter_edit';
  }
  if (matchesShortcutEvent(event, 'selection.clear')) {
    return 'clear_selection';
  }
  if (matchesShortcutEvent(event, 'selection.type_char')) {
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
