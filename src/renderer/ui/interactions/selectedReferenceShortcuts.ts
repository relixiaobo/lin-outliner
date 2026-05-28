import { isImeComposingEvent } from './imeKeyboard';
import { matchesShortcutEvent } from './shortcutRegistry';

export type SelectedReferenceShortcutAction =
  | 'delete'
  | 'convert_arrow_right'
  | 'convert_printable'
  | 'options_up'
  | 'options_down'
  | 'options_confirm'
  | 'options_cancel'
  | 'escape';

interface SelectedReferenceShortcutOptions {
  optionsOpen?: boolean;
}

export function resolveSelectedReferenceShortcut(
  event: KeyboardEvent,
  options: SelectedReferenceShortcutOptions = {},
): SelectedReferenceShortcutAction | null {
  if (isImeComposingEvent(event)) return null;
  if (options.optionsOpen) {
    if (matchesShortcutEvent(event, 'selected_reference.options_up')) return 'options_up';
    if (matchesShortcutEvent(event, 'selected_reference.options_down')) return 'options_down';
    if (matchesShortcutEvent(event, 'selected_reference.options_confirm')) return 'options_confirm';
    if (matchesShortcutEvent(event, 'selected_reference.options_cancel')) return 'options_cancel';
  }
  if (matchesShortcutEvent(event, 'selected_reference.delete')) return 'delete';
  if (matchesShortcutEvent(event, 'selected_reference.convert_arrow_right')) return 'convert_arrow_right';
  if (matchesShortcutEvent(event, 'selected_reference.escape')) return 'escape';
  if (matchesShortcutEvent(event, 'selected_reference.convert_printable')) return 'convert_printable';
  return null;
}
