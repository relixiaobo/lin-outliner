import { afterEach, describe, expect, test } from 'bun:test';
import { assertNoKeybindingConflicts, effectiveShortcutBindings } from '../../src/core/keybindings';
import {
  applyEffectiveShortcutBindings,
  formatConfigurableShortcutHint,
  matchesShortcutEvent,
  subscribeShortcutRegistry,
} from '../../src/renderer/ui/interactions/shortcutRegistry';

const keyboard = (key: string, init: Partial<KeyboardEvent> = {}) => ({
  key,
  code: '',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  isComposing: false,
  ...init,
} as KeyboardEvent);

afterEach(() => applyEffectiveShortcutBindings(effectiveShortcutBindings({})));

describe('configurable renderer shortcuts', () => {
  test('changes event matching and hints from one effective projection', () => {
    applyEffectiveShortcutBindings(effectiveShortcutBindings({
      'global.new_thread': 'Control+N',
      'global.toggle_page_translation': false,
    }));
    expect(matchesShortcutEvent(keyboard('o', { metaKey: true, shiftKey: true }), 'global.new_thread')).toBe(false);
    expect(matchesShortcutEvent(keyboard('n', { ctrlKey: true }), 'global.new_thread')).toBe(true);
    expect(formatConfigurableShortcutHint('global.new_thread')).toBe('⌃N');
    expect(matchesShortcutEvent(keyboard('a', { altKey: true }), 'global.toggle_page_translation')).toBe(false);
  });

  test('notifies hint consumers after a live projection change', () => {
    let changes = 0;
    const unsubscribe = subscribeShortcutRegistry(() => { changes += 1; });
    applyEffectiveShortcutBindings(effectiveShortcutBindings({ 'global.launcher': 'Control+L' }));
    unsubscribe();
    expect(changes).toBe(1);
    expect(formatConfigurableShortcutHint('global.launcher')).toBe('⌃L');
  });

  test('leaves fixed editing grammar immutable', () => {
    applyEffectiveShortcutBindings(effectiveShortcutBindings({ 'global.new_thread': 'Control+N' }));
    expect(matchesShortcutEvent(keyboard('z', { metaKey: true }), 'editor.undo')).toBe(true);
    expect(matchesShortcutEvent(keyboard('Backspace'), 'selection.delete')).toBe(true);
  });

  test('selection duplication remains reserved after its disjoint Today binding is disabled', () => {
    const duplicate = keyboard('D', { code: 'KeyD', metaKey: true, shiftKey: true });
    const bindings = effectiveShortcutBindings({ 'global.go_to_today': false });
    applyEffectiveShortcutBindings(bindings);
    expect(matchesShortcutEvent(duplicate, 'selection.duplicate')).toBe(true);
    expect(matchesShortcutEvent(duplicate, 'global.go_to_today')).toBe(false);
    expect(() => assertNoKeybindingConflicts({
      ...bindings, 'global.open_page_in_pane': ['CommandOrControl+Shift+D'],
    })).toThrow('selection.duplicate');
    expect(() => assertNoKeybindingConflicts(effectiveShortcutBindings({}))).not.toThrow();
  });
});
