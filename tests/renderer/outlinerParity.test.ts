import { describe, expect, test } from 'bun:test';
import {
  resolveActiveNodeSelection,
  targetIdsForRows,
} from '../../src/renderer/ui/interactions/contextMenuSelection';
import { shouldPreserveSelectedRowContextClick } from '../../src/renderer/ui/interactions/rowPointerSelection';
import {
  orderedSelectedRows,
  selectedRootIds,
  toggleVisibleSelection,
} from '../../src/renderer/ui/interactions/selectionActions';
import {
  resolveSelectionKeyboardAction,
  type SelectionKeyboardAction,
} from '../../src/renderer/ui/interactions/selectionKeyboard';
import {
  shouldClearSelectionOnFocusIn,
  shouldClearSelectionOnPointerDown,
  shouldPreserveSelectionForModifierGesture,
} from '../../src/renderer/ui/interactions/selectionDismiss';
import { flattenVisibleRows } from '../../src/renderer/state/document';

function keyboardEvent(params: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    ...params,
  } as KeyboardEvent;
}

function node(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    children: [],
    content: { text: id, marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    locked: false,
    showCheckbox: false,
    doneStateEnabled: false,
    autocollectOptions: false,
    autoCollected: false,
    toolbarVisible: false,
    filterValues: [],
    ...overrides,
  };
}

function fakeTarget(options: { preserved?: boolean; row?: boolean } = {}): HTMLElement {
  return {
    closest: (selector: string) => {
      if (options.preserved && selector === '[data-preserve-selection]') return {};
      if (options.row && selector === '[data-node-id][data-parent-id]') return {};
      return null;
    },
  } as HTMLElement;
}

describe('nodex outliner parity matrix', () => {
  test.each([
    ['Escape', keyboardEvent({ key: 'Escape' }), 'clear_selection'],
    ['Enter', keyboardEvent({ key: 'Enter' }), 'enter_edit'],
    ['type char', keyboardEvent({ key: 'x' }), 'type_char'],
    ['ArrowUp', keyboardEvent({ key: 'ArrowUp' }), 'navigate_up'],
    ['ArrowDown', keyboardEvent({ key: 'ArrowDown' }), 'navigate_down'],
    ['ArrowRight', keyboardEvent({ key: 'ArrowRight' }), 'convert_reference_right'],
    ['Shift+ArrowUp', keyboardEvent({ key: 'ArrowUp', shiftKey: true }), 'extend_up'],
    ['Shift+ArrowDown', keyboardEvent({ key: 'ArrowDown', shiftKey: true }), 'extend_down'],
    ['Mod+A', keyboardEvent({ key: 'a', metaKey: true }), 'select_all'],
    ['Backspace', keyboardEvent({ key: 'Backspace' }), 'batch_delete'],
    ['Delete', keyboardEvent({ key: 'Delete' }), 'batch_delete'],
    ['Tab', keyboardEvent({ key: 'Tab' }), 'batch_indent'],
    ['Shift+Tab', keyboardEvent({ key: 'Tab', shiftKey: true }), 'batch_outdent'],
    ['Mod+Shift+D', keyboardEvent({ key: 'd', metaKey: true, shiftKey: true }), 'batch_duplicate'],
    ['Mod+Enter', keyboardEvent({ key: 'Enter', metaKey: true }), 'batch_checkbox'],
    ['#', keyboardEvent({ key: '#', shiftKey: true }), 'batch_apply_tag'],
    ['Mod+C', keyboardEvent({ key: 'c', metaKey: true }), 'batch_copy'],
    ['Mod+X', keyboardEvent({ key: 'x', metaKey: true }), 'batch_cut'],
  ] satisfies Array<[string, KeyboardEvent, SelectionKeyboardAction]>)('%s resolves like nodex selection mode', (_, event, action) => {
    expect(resolveSelectionKeyboardAction(event)).toBe(action);
  });

  test('batch operations use visible order and suppress nested selected rows', () => {
    const byId = new Map<string, any>([
      ['parent', node('parent')],
      ['child', node('child', { parentId: 'parent' })],
      ['sibling', node('sibling')],
    ]);
    const rows = ['parent', 'child', 'sibling'];
    const selectedIds = new Set(['child', 'parent', 'sibling']);

    expect(orderedSelectedRows(rows, selectedIds)).toEqual(['parent', 'child', 'sibling']);
    expect(selectedRootIds(orderedSelectedRows(rows, selectedIds), byId)).toEqual(['parent', 'sibling']);
  });

  test('modifier row selection drops hidden root/title selections outside the visible row scope', () => {
    expect([...toggleVisibleSelection(
      ['first', 'second'],
      new Set(['today-root', 'first']),
      'second',
    )]).toEqual(['first', 'second']);
  });

  test('reference batch target operations dedupe repeated target nodes', () => {
    const byId = new Map<string, any>([
      ['target', node('target')],
      ['ref-a', node('ref-a', { type: 'reference', targetId: 'target' })],
      ['ref-b', node('ref-b', { type: 'reference', targetId: 'target' })],
    ]);

    expect(targetIdsForRows(['ref-a', 'ref-b'], byId)).toEqual(['target']);
  });

  test('expanded reference rows expose target children in visible order', () => {
    const byId = new Map<string, any>([
      ['root', node('root', { children: ['ref'] })],
      ['target', node('target', { children: ['child'] })],
      ['child', node('child', { parentId: 'target' })],
      ['ref', node('ref', { parentId: 'root', type: 'reference', targetId: 'target' })],
    ]);

    expect(flattenVisibleRows('root', byId, new Set(['ref']))).toEqual(['ref', 'child']);
  });

  test('expanded reference rows stop when the target is already on the visible path', () => {
    const byId = new Map<string, any>([
      ['root', node('root', { children: ['ancestor'] })],
      ['ancestor', node('ancestor', { parentId: 'root', children: ['child'] })],
      ['child', node('child', { parentId: 'ancestor', children: ['ref'] })],
      ['ref', node('ref', { parentId: 'child', type: 'reference', targetId: 'ancestor' })],
    ]);

    expect(flattenVisibleRows('root', byId, new Set(['ancestor', 'child', 'ref']))).toEqual([
      'ancestor',
      'child',
      'ref',
    ]);
  });

  test('context menu resolves batch rows and target rows from the same selection source', () => {
    const byId = new Map<string, any>([
      ['parent', node('parent')],
      ['child', node('child', { parentId: 'parent' })],
      ['target', node('target')],
      ['ref', node('ref', { type: 'reference', targetId: 'target' })],
    ]);

    const selection = resolveActiveNodeSelection({
      nodeId: 'parent',
      targetId: 'parent',
      selectedIds: new Set(['parent', 'child', 'ref']),
      byId,
    });

    expect(selection.nodeIds).toEqual(['parent', 'ref']);
    expect(selection.targetIds).toEqual(['parent', 'target']);
    expect(selection.isBatch).toBe(true);
  });

  test('right-clicking an already selected row preserves batch selection before the context menu opens', () => {
    expect(shouldPreserveSelectedRowContextClick({ button: 2, rowSelected: true })).toBe(true);
    expect(shouldPreserveSelectedRowContextClick({ button: 0, rowSelected: true })).toBe(false);
    expect(shouldPreserveSelectedRowContextClick({ button: 2, rowSelected: false })).toBe(false);
  });

  test('global selection dismiss preserves modifier gestures and preserved popups', () => {
    expect(shouldPreserveSelectionForModifierGesture({
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    })).toBe(true);
    expect(shouldClearSelectionOnPointerDown(fakeTarget())).toBe(true);
    expect(shouldClearSelectionOnPointerDown(fakeTarget({ preserved: true }))).toBe(false);
    expect(shouldClearSelectionOnPointerDown(fakeTarget({ row: true }))).toBe(false);
    expect(shouldClearSelectionOnFocusIn(fakeTarget())).toBe(true);
    expect(shouldClearSelectionOnFocusIn(fakeTarget({ preserved: true }))).toBe(false);
    expect(shouldClearSelectionOnFocusIn(fakeTarget({ row: true }))).toBe(false);
  });
});
