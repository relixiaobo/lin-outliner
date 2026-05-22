import { isImeComposingEvent } from './imeKeyboard';
import { matchesShortcutEvent } from './shortcutRegistry';

export type SelectedReferenceShortcutAction =
  | 'delete'
  | 'convert_arrow_right'
  | 'convert_printable'
  | 'escape';

export function resolveSelectedReferenceShortcut(
  event: KeyboardEvent,
): SelectedReferenceShortcutAction | null {
  if (isImeComposingEvent(event)) return null;
  if (matchesShortcutEvent(event, 'selected_reference.delete')) return 'delete';
  if (matchesShortcutEvent(event, 'selected_reference.convert_arrow_right')) return 'convert_arrow_right';
  if (matchesShortcutEvent(event, 'selected_reference.escape')) return 'escape';
  if (matchesShortcutEvent(event, 'selected_reference.convert_printable')) return 'convert_printable';
  return null;
}
