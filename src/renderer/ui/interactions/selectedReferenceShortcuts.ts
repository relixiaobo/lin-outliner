import { isImeComposingEvent } from './imeKeyboard';

export type SelectedReferenceShortcutAction =
  | 'delete'
  | 'convert_arrow_right'
  | 'convert_printable'
  | 'escape';

function isPrintableKey(event: KeyboardEvent): boolean {
  return event.key.length === 1
    && !event.ctrlKey
    && !event.metaKey
    && !event.altKey;
}

export function resolveSelectedReferenceShortcut(
  event: KeyboardEvent,
): SelectedReferenceShortcutAction | null {
  if (isImeComposingEvent(event)) return null;
  if (event.key === 'Backspace' || event.key === 'Delete') return 'delete';
  if (event.key === 'ArrowRight') return 'convert_arrow_right';
  if (event.key === 'Escape') return 'escape';
  if (isPrintableKey(event)) return 'convert_printable';
  return null;
}
