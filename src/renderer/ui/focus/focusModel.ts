import type {
  CursorPlacement,
  FocusRequest,
  FocusSurface,
  FocusTarget,
  InlineRefCursorBias,
  PendingInputChar,
  UiState,
} from '../../state/document';
import type { NodeId } from '../../api/types';

export function rowFocusTarget(nodeId: NodeId, parentId: NodeId | null, panelId: string | null): FocusTarget {
  return { nodeId, parentId, panelId, surface: 'row' };
}

export function focusTarget(
  nodeId: NodeId,
  parentId: NodeId | null,
  panelId: string | null,
  surface: FocusSurface,
): FocusTarget {
  return { nodeId, parentId, panelId, surface };
}

export function cursorStart(): CursorPlacement {
  return { kind: 'start' };
}

export function cursorEnd(): CursorPlacement {
  return { kind: 'end' };
}

export function cursorAll(): CursorPlacement {
  return { kind: 'all' };
}

export function cursorOffset(offset: number, inlineRefBias: InlineRefCursorBias = 'after'): CursorPlacement {
  return { kind: 'text-offset', offset, inlineRefBias };
}

export function requestFocusState(
  state: UiState,
  target: FocusTarget,
  placement: CursorPlacement = cursorEnd(),
): UiState {
  return {
    ...selectFocusState(state, target),
    focusRequest: { target, placement },
    pendingInputChar: null,
  };
}

export function selectFocusState(state: UiState, target: FocusTarget): UiState {
  return {
    ...state,
    focusedId: target.nodeId,
    focusedParentId: target.parentId,
    focusedPanelId: target.panelId,
    focusSurface: target.surface,
    selectedId: target.nodeId,
    selectedIds: new Set([target.nodeId]),
    selectionAnchorId: target.nodeId,
  };
}

export function requestPendingInputState(
  state: UiState,
  target: FocusTarget,
  char: string,
  placement: CursorPlacement = cursorEnd(),
): UiState {
  return {
    ...requestFocusState(state, target, placement),
    pendingInputChar: { target, char },
  };
}

export function clearFocusState(state: UiState): UiState {
  return {
    ...state,
    focusedId: null,
    focusedParentId: null,
    focusedPanelId: null,
    focusSurface: null,
    focusRequest: null,
    pendingInputChar: null,
  };
}

export function clearFocusRequestState(state: UiState, request: FocusRequest): UiState {
  return state.focusRequest === request ? { ...state, focusRequest: null } : state;
}

export function clearPendingInputState(state: UiState, input: PendingInputChar): UiState {
  return state.pendingInputChar === input ? { ...state, pendingInputChar: null } : state;
}

export function focusTargetMatches(requestTarget: FocusTarget, editorTarget: FocusTarget): boolean {
  if (requestTarget.nodeId !== editorTarget.nodeId) return false;
  if (requestTarget.surface !== editorTarget.surface) return false;
  if (requestTarget.parentId !== null && requestTarget.parentId !== editorTarget.parentId) return false;
  if (requestTarget.panelId !== null && requestTarget.panelId !== editorTarget.panelId) return false;
  return true;
}
