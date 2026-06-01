import type { NodeId } from '../api/types';
import type { TriggerState } from '../ui/shared';
import type {
  FocusRequest,
  FocusTarget,
  PendingInputChar,
  PendingReferenceConversion,
  PendingReferenceTypeAhead,
  UiState,
} from './document';

// The slice of UI state that changes what a single outliner row renders. Used by
// OutlinerItem's React.memo to re-render a row only when *its own* UI state moved,
// instead of re-rendering every mounted row on any UI change (the old global
// `uiGen`). Everything an OutlinerItem reads from `ui` for its visual output must
// be captured here, or that row will fail to update. Behavioural-only UI reads
// (handlers that compute from the latest selection/expansion) are deliberately
// NOT here — those read the live ui through a ref so a skipped row stays correct.
export interface RowMemoState {
  focused: boolean;
  selected: boolean;
  refClickSelected: boolean;
  rowEditorFocused: boolean;
  trailingFocused: boolean;
  expanded: boolean;
  // Identity of a row-targeting request, or null when it does not target this row.
  // Comparing by identity re-renders the row when a fresh request arrives or clears.
  focusRequest: FocusRequest | null;
  pendingInput: PendingInputChar | null;
  pendingRefConversion: PendingReferenceConversion | null;
  pendingRefTypeAhead: PendingReferenceTypeAhead | null;
  trigger: TriggerState | null;
}

export function deriveRowMemoState(
  ui: UiState,
  trigger: TriggerState,
  rowId: NodeId,
  parentId: NodeId,
  panelId: string,
): RowMemoState {
  // `selected` mirrors useOutlinerRowInteraction: a row is selected only when
  // nothing is focused, so gaining/losing focus flips the selected look of any
  // currently-selected row (captured because `selected` reads `focusedId`).
  const selected = !ui.focusedId && (ui.selectedIds.has(rowId) || ui.selectedId === rowId);
  // Mirror focusTargetMatches: a null panelId on the request is a wildcard that
  // matches any panel. Command-outcome focus (applyOutcomeFocus) emits requests
  // with panelId=null, so the capture predicate here MUST treat null as a
  // wildcard too — otherwise the row that owns the target node never re-renders,
  // its editor never sees the request, and focus is silently dropped to <body>.
  const targetsRow = (target: FocusTarget): boolean => (
    (target.panelId === null || target.panelId === panelId)
    && (target.nodeId === rowId || (target.nodeId === parentId && target.surface === 'trailing'))
  );
  return {
    focused: ui.focusedId === rowId,
    selected,
    refClickSelected: selected && ui.selectionSource === 'ref-click' && ui.selectedIds.size <= 1,
    rowEditorFocused: ui.focusedId === rowId && ui.focusSurface === 'row' && ui.focusedPanelId === panelId,
    trailingFocused: ui.focusedId === parentId && ui.focusSurface === 'trailing' && ui.focusedPanelId === panelId,
    expanded: ui.expanded.has(rowId),
    focusRequest: ui.focusRequest && targetsRow(ui.focusRequest.target) ? ui.focusRequest : null,
    pendingInput: ui.pendingInputChar && targetsRow(ui.pendingInputChar.target) ? ui.pendingInputChar : null,
    pendingRefConversion: ui.pendingReferenceConversion?.nodeId === rowId ? ui.pendingReferenceConversion : null,
    pendingRefTypeAhead: ui.pendingReferenceTypeAhead?.nodeId === rowId ? ui.pendingReferenceTypeAhead : null,
    trigger: trigger?.nodeId === rowId ? trigger : null,
  };
}

export function rowMemoStateEqual(a: RowMemoState, b: RowMemoState): boolean {
  return a.focused === b.focused
    && a.selected === b.selected
    && a.refClickSelected === b.refClickSelected
    && a.rowEditorFocused === b.rowEditorFocused
    && a.trailingFocused === b.trailingFocused
    && a.expanded === b.expanded
    && a.focusRequest === b.focusRequest
    && a.pendingInput === b.pendingInput
    && a.pendingRefConversion === b.pendingRefConversion
    && a.pendingRefTypeAhead === b.pendingRefTypeAhead
    && a.trigger === b.trigger;
}
