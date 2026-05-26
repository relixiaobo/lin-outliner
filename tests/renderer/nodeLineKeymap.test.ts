import { describe, expect, test } from 'bun:test';
import {
  resolveNodeLineKeyAction,
  type NodeLineKeyContext,
  type NodeLineKeyEvent,
} from '../../src/renderer/ui/interactions/nodeLineKeymap';

function ev(key: string, mods: Partial<NodeLineKeyEvent> = {}): NodeLineKeyEvent {
  return { key, shiftKey: false, metaKey: false, ctrlKey: false, ...mods };
}

function ctx(over: Partial<NodeLineKeyContext> = {}): NodeLineKeyContext {
  return { from: 2, to: 2, textLength: 5, hasShiftArrow: true, ...over };
}

describe('resolveNodeLineKeyAction', () => {
  test('Enter splits; Shift+Enter falls through', () => {
    expect(resolveNodeLineKeyAction(ev('Enter'), ctx())).toEqual({ type: 'split' });
    expect(resolveNodeLineKeyAction(ev('Enter', { shiftKey: true }), ctx())).toBeNull();
  });

  test('Backspace intercepts only at a collapsed start', () => {
    expect(resolveNodeLineKeyAction(ev('Backspace'), ctx({ from: 0, to: 0 }))).toEqual({ type: 'backspaceAtStart' });
    expect(resolveNodeLineKeyAction(ev('Backspace'), ctx({ from: 3, to: 3 }))).toBeNull();
    // a selection that starts at 0 but is non-empty deletes normally
    expect(resolveNodeLineKeyAction(ev('Backspace'), ctx({ from: 0, to: 3 }))).toBeNull();
  });

  test('Tab indents, Shift+Tab outdents', () => {
    expect(resolveNodeLineKeyAction(ev('Tab'), ctx())).toEqual({ type: 'indent', shiftKey: false });
    expect(resolveNodeLineKeyAction(ev('Tab', { shiftKey: true }), ctx())).toEqual({ type: 'indent', shiftKey: true });
  });

  test('Shift+Arrow extends selection when a handler is wired', () => {
    expect(resolveNodeLineKeyAction(ev('ArrowUp', { shiftKey: true }), ctx())).toEqual({ type: 'shiftArrow', direction: 'up' });
    expect(resolveNodeLineKeyAction(ev('ArrowDown', { shiftKey: true }), ctx())).toEqual({ type: 'shiftArrow', direction: 'down' });
  });

  test('Shift+Arrow without a handler is inert and does NOT fall through to plain Arrow nav', () => {
    // The load-bearing case: at offset 0, plain ArrowUp would navigate, but
    // Shift+ArrowUp with no onShiftArrow must return null (not navigateUpAtStart).
    expect(resolveNodeLineKeyAction(ev('ArrowUp', { shiftKey: true }), ctx({ from: 0, to: 0, hasShiftArrow: false }))).toBeNull();
  });

  test('Mod+Shift+Arrow skips the shift-arrow branch (mod set) and uses boundary nav', () => {
    // shiftKey && !mod is false, so it falls to the plain ArrowUp branch.
    expect(resolveNodeLineKeyAction(ev('ArrowUp', { shiftKey: true, metaKey: true }), ctx({ from: 0, to: 0 }))).toEqual({ type: 'navigateUpAtStart' });
  });

  test('ArrowUp navigates out only at the start', () => {
    expect(resolveNodeLineKeyAction(ev('ArrowUp'), ctx({ from: 0, to: 0 }))).toEqual({ type: 'navigateUpAtStart' });
    expect(resolveNodeLineKeyAction(ev('ArrowUp'), ctx({ from: 2, to: 2 }))).toBeNull();
  });

  test('ArrowDown navigates out only at the end', () => {
    expect(resolveNodeLineKeyAction(ev('ArrowDown'), ctx({ to: 5, textLength: 5 }))).toEqual({ type: 'navigateDownAtEnd' });
    expect(resolveNodeLineKeyAction(ev('ArrowDown'), ctx({ to: 3, textLength: 5 }))).toBeNull();
  });

  test('Escape escapes; ordinary keys fall through', () => {
    expect(resolveNodeLineKeyAction(ev('Escape'), ctx())).toEqual({ type: 'escape' });
    expect(resolveNodeLineKeyAction(ev('a'), ctx())).toBeNull();
    expect(resolveNodeLineKeyAction(ev('x', { metaKey: true }), ctx())).toBeNull();
  });
});
