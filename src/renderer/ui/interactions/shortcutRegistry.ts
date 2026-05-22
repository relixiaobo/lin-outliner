import { isImeComposingEvent } from './imeKeyboard';

export type ShortcutScope =
  | 'editor'
  | 'trailing'
  | 'selection'
  | 'selected_reference'
  | 'global';

export type ShortcutId =
  | 'selection.navigate_up'
  | 'selection.navigate_down'
  | 'selection.convert_reference_right'
  | 'selection.extend_up'
  | 'selection.extend_down'
  | 'selection.enter_edit'
  | 'selection.type_char'
  | 'selection.clear'
  | 'selection.select_all'
  | 'selection.copy'
  | 'selection.cut'
  | 'selection.duplicate'
  | 'selection.delete'
  | 'selection.indent'
  | 'selection.outdent'
  | 'selection.checkbox'
  | 'selection.apply_tag'
  | 'selection.move_up'
  | 'selection.move_down'
  | 'selected_reference.delete'
  | 'selected_reference.convert_arrow_right'
  | 'selected_reference.convert_printable'
  | 'selected_reference.escape'
  | 'editor.description'
  | 'editor.undo'
  | 'editor.redo'
  | 'editor.checkbox'
  | 'editor.move_up'
  | 'editor.move_down'
  | 'trailing.description'
  | 'trailing.undo'
  | 'trailing.redo'
  | 'trailing.checkbox'
  | 'global.command_palette'
  | 'global.open_agent_panel'
  | 'global.undo'
  | 'global.redo';

type ModifierValue = boolean | 'any';

export interface ShortcutBinding {
  key?: string;
  printable?: boolean;
  mod?: ModifierValue;
  ctrl?: ModifierValue;
  meta?: ModifierValue;
  shift?: ModifierValue;
  alt?: ModifierValue;
}

export interface ShortcutDefinition {
  id: ShortcutId;
  scope: ShortcutScope;
  bindings: ShortcutBinding[];
  description: string;
}

function binding(
  key: string,
  modifiers: Omit<ShortcutBinding, 'key' | 'printable'> = {},
): ShortcutBinding {
  return { key, ...modifiers };
}

function printable(
  modifiers: Omit<ShortcutBinding, 'key' | 'printable'> = {},
): ShortcutBinding {
  return { printable: true, shift: 'any', ...modifiers };
}

export const OUTLINER_SHORTCUTS: ShortcutDefinition[] = [
  { id: 'selection.move_up', scope: 'selection', bindings: [binding('ArrowUp', { mod: true, shift: true })], description: 'Move selected rows up' },
  { id: 'selection.move_down', scope: 'selection', bindings: [binding('ArrowDown', { mod: true, shift: true })], description: 'Move selected rows down' },
  { id: 'selection.extend_up', scope: 'selection', bindings: [binding('ArrowUp', { shift: true })], description: 'Extend selection upward' },
  { id: 'selection.extend_down', scope: 'selection', bindings: [binding('ArrowDown', { shift: true })], description: 'Extend selection downward' },
  { id: 'selection.select_all', scope: 'selection', bindings: [binding('a', { mod: true })], description: 'Select all visible rows' },
  { id: 'selection.copy', scope: 'selection', bindings: [binding('c', { mod: true })], description: 'Copy selected rows' },
  { id: 'selection.cut', scope: 'selection', bindings: [binding('x', { mod: true })], description: 'Cut selected rows' },
  { id: 'selection.duplicate', scope: 'selection', bindings: [binding('d', { mod: true, shift: true })], description: 'Duplicate selected rows' },
  { id: 'selection.checkbox', scope: 'selection', bindings: [binding('Enter', { mod: true })], description: 'Toggle selected row checkbox state' },
  { id: 'selection.delete', scope: 'selection', bindings: [binding('Backspace'), binding('Delete')], description: 'Delete selected rows' },
  { id: 'selection.outdent', scope: 'selection', bindings: [binding('Tab', { shift: true })], description: 'Outdent selected rows' },
  { id: 'selection.indent', scope: 'selection', bindings: [binding('Tab')], description: 'Indent selected rows' },
  { id: 'selection.apply_tag', scope: 'selection', bindings: [binding('#', { shift: 'any' })], description: 'Open batch tag selector' },
  { id: 'selection.navigate_up', scope: 'selection', bindings: [binding('ArrowUp')], description: 'Focus previous visible row' },
  { id: 'selection.navigate_down', scope: 'selection', bindings: [binding('ArrowDown')], description: 'Focus next visible row' },
  { id: 'selection.convert_reference_right', scope: 'selection', bindings: [binding('ArrowRight')], description: 'Convert selected reference to inline mode' },
  { id: 'selection.enter_edit', scope: 'selection', bindings: [binding('Enter')], description: 'Edit selected row' },
  { id: 'selection.clear', scope: 'selection', bindings: [binding('Escape')], description: 'Clear selection' },
  { id: 'selection.type_char', scope: 'selection', bindings: [printable()], description: 'Edit selected row and insert typed character' },

  { id: 'selected_reference.delete', scope: 'selected_reference', bindings: [binding('Backspace'), binding('Delete')], description: 'Delete selected reference link' },
  { id: 'selected_reference.convert_arrow_right', scope: 'selected_reference', bindings: [binding('ArrowRight')], description: 'Convert selected reference to inline mode' },
  { id: 'selected_reference.convert_printable', scope: 'selected_reference', bindings: [printable()], description: 'Convert selected reference and append typed character' },
  { id: 'selected_reference.escape', scope: 'selected_reference', bindings: [binding('Escape')], description: 'Clear selected reference' },

  { id: 'editor.description', scope: 'editor', bindings: [binding('i', { ctrl: true }), binding('Tab', { ctrl: true })], description: 'Edit node description' },
  { id: 'editor.undo', scope: 'editor', bindings: [binding('z', { mod: true })], description: 'Undo document edit' },
  { id: 'editor.redo', scope: 'editor', bindings: [binding('z', { mod: true, shift: true }), binding('y', { mod: true })], description: 'Redo document edit' },
  { id: 'editor.checkbox', scope: 'editor', bindings: [binding('Enter', { mod: true })], description: 'Toggle current node checkbox state' },
  { id: 'editor.move_up', scope: 'editor', bindings: [binding('ArrowUp', { mod: true, shift: true })], description: 'Move current row up' },
  { id: 'editor.move_down', scope: 'editor', bindings: [binding('ArrowDown', { mod: true, shift: true })], description: 'Move current row down' },

  { id: 'trailing.description', scope: 'trailing', bindings: [binding('i', { ctrl: true }), binding('Tab', { ctrl: true })], description: 'Create node and edit description' },
  { id: 'trailing.undo', scope: 'trailing', bindings: [binding('z', { mod: true })], description: 'Undo document edit' },
  { id: 'trailing.redo', scope: 'trailing', bindings: [binding('z', { mod: true, shift: true }), binding('y', { mod: true })], description: 'Redo document edit' },
  { id: 'trailing.checkbox', scope: 'trailing', bindings: [binding('Enter', { mod: true })], description: 'Create checkbox row' },

  { id: 'global.command_palette', scope: 'global', bindings: [binding('k', { mod: true })], description: 'Open command palette' },
  { id: 'global.open_agent_panel', scope: 'global', bindings: [binding('m', { mod: true })], description: 'Open agent panel' },
  { id: 'global.undo', scope: 'global', bindings: [binding('z', { mod: true })], description: 'Undo document edit' },
  { id: 'global.redo', scope: 'global', bindings: [binding('z', { mod: true, shift: true }), binding('y', { mod: true })], description: 'Redo document edit' },
];

const SHORTCUT_BY_ID = new Map(OUTLINER_SHORTCUTS.map((shortcut) => [shortcut.id, shortcut]));

function modifierMatches(expected: ModifierValue | undefined, actual: boolean): boolean {
  if (expected === 'any') return true;
  return actual === (expected ?? false);
}

function keyMatches(bindingKey: string | undefined, eventKey: string): boolean {
  if (!bindingKey) return false;
  return bindingKey.length === 1
    ? eventKey.toLowerCase() === bindingKey.toLowerCase()
    : eventKey === bindingKey;
}

export function matchesShortcutEvent(event: KeyboardEvent, shortcutId: ShortcutId): boolean {
  if (isImeComposingEvent(event)) return false;
  const shortcut = SHORTCUT_BY_ID.get(shortcutId);
  if (!shortcut) return false;

  return shortcut.bindings.some((candidate) => {
    if (candidate.printable && event.key.length !== 1) return false;
    if (!candidate.printable && !keyMatches(candidate.key, event.key)) return false;

    const modActual = event.metaKey || event.ctrlKey;
    if (candidate.mod !== undefined) {
      if (!modifierMatches(candidate.mod, modActual)) return false;
      if (candidate.ctrl !== undefined && !modifierMatches(candidate.ctrl, event.ctrlKey)) return false;
      if (candidate.meta !== undefined && !modifierMatches(candidate.meta, event.metaKey)) return false;
    } else {
      if (!modifierMatches(candidate.ctrl, event.ctrlKey)) return false;
      if (!modifierMatches(candidate.meta, event.metaKey)) return false;
    }
    if (!modifierMatches(candidate.shift, event.shiftKey)) return false;
    if (!modifierMatches(candidate.alt, event.altKey)) return false;
    return true;
  });
}

export function shortcutDefinitionsForScope(scope: ShortcutScope): ShortcutDefinition[] {
  return OUTLINER_SHORTCUTS.filter((shortcut) => shortcut.scope === scope);
}
