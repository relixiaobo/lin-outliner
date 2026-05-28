import { describe, expect, test } from 'bun:test';
import type { NodeId } from '../../src/core/types';
import type { FocusRequest, UiState } from '../../src/renderer/state/document';
import { deriveRowMemoState, rowMemoStateEqual } from '../../src/renderer/state/rowUiState';

function baseUi(patch: Partial<UiState> = {}): UiState {
  return {
    focusedId: null,
    focusedParentId: null,
    focusedPanelId: null,
    focusSurface: null,
    selectedId: null,
    selectedIds: new Set<NodeId>(),
    selectionAnchorId: null,
    selectionRootId: null,
    selectionSource: null,
    focusRequest: null,
    pendingInputChar: null,
    pendingReferenceConversion: null,
    pendingReferenceTypeAhead: null,
    expanded: new Set<NodeId>(),
    expandedHiddenFields: new Set<string>(),
    editingDescriptionId: null,
    commandOpen: false,
    batchTagSelectorOpen: false,
    toolbarDropdownRequest: null,
    ...patch,
  };
}

const PANEL = 'panel-1';

describe('deriveRowMemoState', () => {
  test('focus on the row sets focused + rowEditorFocused', () => {
    const ui = baseUi({ focusedId: 'a', focusSurface: 'row', focusedPanelId: PANEL });
    const state = deriveRowMemoState(ui, null, 'a', 'root', PANEL);
    expect(state.focused).toBe(true);
    expect(state.rowEditorFocused).toBe(true);
  });

  test('rowEditorFocused requires the matching panel', () => {
    const ui = baseUi({ focusedId: 'a', focusSurface: 'row', focusedPanelId: 'other' });
    const state = deriveRowMemoState(ui, null, 'a', 'root', PANEL);
    expect(state.rowEditorFocused).toBe(false);
  });

  test('selection only counts while nothing is focused', () => {
    const selectedOnly = deriveRowMemoState(baseUi({ selectedIds: new Set(['a']) }), null, 'a', 'root', PANEL);
    expect(selectedOnly.selected).toBe(true);
    const withFocus = deriveRowMemoState(
      baseUi({ selectedIds: new Set(['a']), focusedId: 'b' }),
      null,
      'a',
      'root',
      PANEL,
    );
    expect(withFocus.selected).toBe(false);
  });

  test('refClickSelected needs ref-click source and a single selection', () => {
    const single = deriveRowMemoState(
      baseUi({ selectedIds: new Set(['a']), selectionSource: 'ref-click' }),
      null,
      'a',
      'root',
      PANEL,
    );
    expect(single.refClickSelected).toBe(true);
    const many = deriveRowMemoState(
      baseUi({ selectedIds: new Set(['a', 'b']), selectionSource: 'ref-click' }),
      null,
      'a',
      'root',
      PANEL,
    );
    expect(many.refClickSelected).toBe(false);
  });

  test('trailing focus targets the parent surface (draft rows)', () => {
    const ui = baseUi({ focusedId: 'root', focusSurface: 'trailing', focusedPanelId: PANEL });
    const state = deriveRowMemoState(ui, null, 'draft', 'root', PANEL);
    expect(state.trailingFocused).toBe(true);
  });

  test('focusRequest is captured only when it targets this row', () => {
    const request: FocusRequest = {
      target: { nodeId: 'a', parentId: 'root', panelId: PANEL, surface: 'row' },
      placement: { type: 'end' } as FocusRequest['placement'],
    };
    expect(deriveRowMemoState(baseUi({ focusRequest: request }), null, 'a', 'root', PANEL).focusRequest).toBe(request);
    expect(deriveRowMemoState(baseUi({ focusRequest: request }), null, 'b', 'root', PANEL).focusRequest).toBeNull();
  });
});

describe('rowMemoStateEqual', () => {
  test('moving focus from one row to another only changes those two rows', () => {
    const prev = baseUi({ focusedId: 'a', focusSurface: 'row', focusedPanelId: PANEL });
    const next = baseUi({ focusedId: 'b', focusSurface: 'row', focusedPanelId: PANEL });
    const unchanged = (id: NodeId) => rowMemoStateEqual(
      deriveRowMemoState(prev, null, id, 'root', PANEL),
      deriveRowMemoState(next, null, id, 'root', PANEL),
    );
    expect(unchanged('a')).toBe(false); // loses focus
    expect(unchanged('b')).toBe(false); // gains focus
    expect(unchanged('c')).toBe(true); // untouched neighbour: no re-render
  });

  test('expanding one row does not re-render its siblings', () => {
    const prev = baseUi({ expanded: new Set<NodeId>() });
    const next = baseUi({ expanded: new Set(['a']) });
    expect(rowMemoStateEqual(
      deriveRowMemoState(prev, null, 'a', 'root', PANEL),
      deriveRowMemoState(next, null, 'a', 'root', PANEL),
    )).toBe(false);
    expect(rowMemoStateEqual(
      deriveRowMemoState(prev, null, 'b', 'root', PANEL),
      deriveRowMemoState(next, null, 'b', 'root', PANEL),
    )).toBe(true);
  });
});
