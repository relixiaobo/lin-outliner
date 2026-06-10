import { afterEach, describe, expect, test } from 'bun:test';
import {
  beginComposition,
  endComposition,
  extractComposedInsertion,
  isCompositionLive,
  resetCompositionRelayForTests,
} from '../../src/renderer/ui/editor/compositionRelay';
import {
  cursorStart,
  relayCompositionHandoffState,
  requestFocusState,
  rowFocusTarget,
} from '../../src/renderer/ui/focus/focusModel';
import type { UiState } from '../../src/renderer/state/document';

afterEach(() => {
  resetCompositionRelayForTests();
});

describe('composition gate', () => {
  test('is live while any editor holds a composition', () => {
    const a = Symbol('a');
    const b = Symbol('b');
    expect(isCompositionLive()).toBe(false);
    beginComposition(a);
    beginComposition(b);
    expect(isCompositionLive()).toBe(true);
    endComposition(a);
    expect(isCompositionLive()).toBe(true);
    endComposition(b);
    expect(isCompositionLive()).toBe(false);
  });

  test('begin and end are idempotent per token', () => {
    const a = Symbol('a');
    beginComposition(a);
    beginComposition(a);
    endComposition(a);
    expect(isCompositionLive()).toBe(false);
    endComposition(a);
    expect(isCompositionLive()).toBe(false);
  });
});

describe('extractComposedInsertion', () => {
  test('recovers a composition inserted mid-text', () => {
    expect(extractComposedInsertion('beforeafter', 'before技能after')).toBe('技能');
  });

  test('recovers a composition at the end', () => {
    expect(extractComposedInsertion('hello ', 'hello 世界')).toBe('世界');
  });

  test('returns empty for a cancelled composition', () => {
    expect(extractComposedInsertion('beforeafter', 'beforeafter')).toBe('');
  });

  test('recovers the composed text when it replaced a wider selection', () => {
    // Selected "selected" was replaced by the single composed char "字" —
    // net-shorter, but the insertion is still the composed text.
    expect(extractComposedInsertion('a selected z', 'a 字 z')).toBe('字');
  });

  test('handles repeated neighboring characters without over-trimming', () => {
    expect(extractComposedInsertion('aaa', 'aaaa')).toBe('a');
    expect(extractComposedInsertion('ab', 'aXXb')).toBe('XX');
  });
});

function baseUiState(): UiState {
  return {
    focusedId: null,
    focusedParentId: null,
    focusedPanelId: null,
    focusSurface: null,
    selectedId: null,
    selectedIds: new Set(),
    selectionAnchorId: null,
    selectionRootId: null,
    selectionSource: null,
    focusRequest: null,
    pendingInputChar: null,
    pendingReferenceConversion: null,
    pendingReferenceTypeAhead: null,
    expanded: new Set(),
    expandedHiddenFields: new Set(),
    editingDescriptionId: null,
    commandOpen: false,
    batchTagSelectorOpen: false,
    toolbarDropdownRequest: null,
  };
}

describe('relayCompositionHandoffState', () => {
  const target = rowFocusTarget('node-new', 'parent', null);

  test('relays composed text through the pendingInput rail at the parked placement', () => {
    const parked = requestFocusState(baseUiState(), target, cursorStart());
    const relayed = relayCompositionHandoffState(parked, '技能');
    expect(relayed.pendingInputChar).toEqual({ target, char: '技能' });
    expect(relayed.focusRequest).toEqual({ target, placement: cursorStart() });
    // A fresh request object, so consumer effects re-fire.
    expect(relayed.focusRequest).not.toBe(parked.focusRequest);
  });

  test('re-issues a bare focus request for a cancelled composition', () => {
    const parked = requestFocusState(baseUiState(), target, cursorStart());
    const relayed = relayCompositionHandoffState(parked, '');
    expect(relayed.pendingInputChar).toBeNull();
    expect(relayed.focusRequest).toEqual({ target, placement: cursorStart() });
    expect(relayed.focusRequest).not.toBe(parked.focusRequest);
  });

  test('is a no-op without a parked request', () => {
    const state = baseUiState();
    expect(relayCompositionHandoffState(state, '技能')).toBe(state);
  });
});
