import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { api } from '../api/client';
import type { NodeId } from '../api/types';
import { flattenVisibleRows, resolveReferenceTargetId } from '../state/document';
import type { DocumentIndex, UiState } from '../state/document';
import { targetIdsForRows } from './interactions/contextMenuSelection';
import { isImeComposingEvent } from './interactions/imeKeyboard';
import { expandIndentTargets } from './interactions/outlinerStructure';
import {
  extendSelection,
  navigationTarget,
  orderedSelectedRows,
  resolveSelectionAnchor,
  selectedRootIds,
  serializeSelectedRows,
} from './interactions/selectionActions';
import {
  resolveSelectionKeyboardAction,
  shouldIgnoreSelectionKeyboardTarget,
} from './interactions/selectionKeyboard';
import {
  clearFocusState,
  cursorOffset,
  requestFocusState,
  requestPendingInputState,
  rowFocusTarget,
} from './focus/focusModel';
import type { CommandRunner } from './shared';

async function writeClipboardText(text: string): Promise<boolean> {
  if (!text) return true;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  }
}

function resolveKeyboardSelectionRoot(ui: UiState, index: DocumentIndex, rootId: NodeId): NodeId {
  return ui.selectionRootId && index.byId.has(ui.selectionRootId)
    ? ui.selectionRootId
    : rootId;
}

function clearKeyboardSelectionState(state: UiState): UiState {
  return {
    ...clearFocusState(state),
    focusedId: null,
    selectedId: null,
    selectedIds: new Set(),
    selectionAnchorId: null,
    selectionRootId: null,
    selectionSource: null,
    batchTagSelectorOpen: false,
  };
}

function selectKeyboardRowsState(
  state: UiState,
  params: {
    selectedId: NodeId | null;
    selectedIds: Set<NodeId>;
    selectionAnchorId: NodeId | null;
    selectionRootId: NodeId;
  },
): UiState {
  return {
    ...clearFocusState(state),
    focusedId: null,
    selectedId: params.selectedId,
    selectedIds: params.selectedIds,
    selectionAnchorId: params.selectionAnchorId,
    selectionRootId: params.selectionRootId,
    selectionSource: 'global',
  };
}

interface UseWorkspaceKeyboardOptions {
  appendTypedCharToRow: (rowId: NodeId, char: string) => void;
  index: DocumentIndex | null;
  onOpenPanel: () => void;
  requestEditFocus: (nodeId: NodeId) => void;
  rootId: NodeId | null;
  run: CommandRunner;
  setCommandOpen: (commandOpen: boolean) => void;
  setError: (message: string | null) => void;
  setUi: Dispatch<SetStateAction<UiState>>;
  ui: UiState;
}

export function useWorkspaceKeyboard({
  appendTypedCharToRow,
  index,
  onOpenPanel,
  requestEditFocus,
  rootId,
  run,
  setCommandOpen,
  setError,
  setUi,
  ui,
}: UseWorkspaceKeyboardOptions) {
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const focusSelectedRowForTextInput = () => {
        if (!rootId || !index || ui.focusedId || ui.selectedIds.size === 0) return;
        if (
          event.target instanceof HTMLElement
          && event.target.closest('[data-preserve-selection]')
        ) {
          return;
        }
        if (shouldIgnoreSelectionKeyboardTarget(event.target, {
          allowContentEditable: ui.selectedIds.size > 1,
        })) {
          return;
        }
        const selectionRootId = resolveKeyboardSelectionRoot(ui, index, rootId);
        const rows = flattenVisibleRows(selectionRootId, index.byId, ui.expanded, ui.expandedHiddenFields);
        const orderedSelected = orderedSelectedRows(rows, ui.selectedIds);
        const anchor = resolveSelectionAnchor({
          rows,
          selectedIds: ui.selectedIds,
          selectedId: ui.selectedId,
          selectionAnchorId: ui.selectionAnchorId,
        });
        if (!anchor) return;
        requestEditFocus(orderedSelected[0] ?? anchor);
      };

      if (isImeComposingEvent(event)) {
        focusSelectedRowForTextInput();
        return;
      }
      if (
        event.target instanceof HTMLElement
        && event.target.closest('[data-preserve-selection]')
      ) {
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen(true);
        return;
      }
      if (mod && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        onOpenPanel();
        return;
      }
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        void run(() => event.shiftKey ? api.redo() : api.undo());
        return;
      }
      if (!rootId || !index || ui.focusedId || ui.selectedIds.size === 0) {
        return;
      }
      if (shouldIgnoreSelectionKeyboardTarget(event.target, {
        allowContentEditable: ui.selectedIds.size > 1,
      })) {
        return;
      }
      const action = resolveSelectionKeyboardAction(event);
      if (!action) {
        return;
      }

      const selectionRootId = resolveKeyboardSelectionRoot(ui, index, rootId);
      const rows = flattenVisibleRows(selectionRootId, index.byId, ui.expanded, ui.expandedHiddenFields);
      const orderedSelected = orderedSelectedRows(rows, ui.selectedIds);
      const anchor = resolveSelectionAnchor({
        rows,
        selectedIds: ui.selectedIds,
        selectedId: ui.selectedId,
        selectionAnchorId: ui.selectionAnchorId,
      });
      if (!anchor) {
        return;
      }

      event.preventDefault();
      const singleSelectedId = orderedSelected.length === 1
        ? orderedSelected[0]
        : ui.selectedIds.size === 1
          ? anchor
          : null;
      const singleSelectedNode = singleSelectedId ? index.byId.get(singleSelectedId) : null;
      const selectedReferenceTargetId = singleSelectedNode?.type === 'reference' && singleSelectedNode.targetId
        ? resolveReferenceTargetId(singleSelectedNode.targetId, index.byId) ?? singleSelectedNode.targetId
        : null;
      const convertSelectedReferenceToInline = (char?: string) => {
        if (!singleSelectedId || !singleSelectedNode || !selectedReferenceTargetId) return;
        const parentId = singleSelectedNode.parentId;
        if (!parentId) return;
        void run(() => api.convertReferenceToInlineNode(singleSelectedId)).then((result) => {
          if (!result || !('focus' in result)) return;
          const inlineNodeId = result.focus?.nodeId;
          const inlineParentId = result.focus?.parentId ?? parentId;
          if (!inlineNodeId) return;
          window.requestAnimationFrame(() => {
            setUi((prev) => {
              const target = rowFocusTarget(inlineNodeId, inlineParentId, null);
              const placement = cursorOffset(0, 'after');
              const next = char
                ? requestPendingInputState(prev, target, char, placement)
                : requestFocusState(prev, target, placement);
              return {
                ...next,
                pendingReferenceConversion: {
                  nodeId: inlineNodeId,
                  parentId: inlineParentId,
                  targetId: selectedReferenceTargetId,
                },
              };
            });
          });
        });
      };

      if (action === 'convert_reference_right') {
        convertSelectedReferenceToInline();
        return;
      }
      if (action === 'clear_selection') {
        setUi(clearKeyboardSelectionState);
        return;
      }
      if (action === 'enter_edit') {
        requestEditFocus(orderedSelected[0] ?? anchor);
        return;
      }
      if (action === 'type_char') {
        if (selectedReferenceTargetId) {
          convertSelectedReferenceToInline(event.key);
          return;
        }
        appendTypedCharToRow(orderedSelected[0] ?? anchor, event.key);
        return;
      }
      if (action === 'select_all') {
        setUi((prev) => selectKeyboardRowsState(prev, {
          selectedId: rows[0] ?? prev.selectedId,
          selectedIds: new Set(rows),
          selectionAnchorId: rows[0] ?? prev.selectionAnchorId,
          selectionRootId,
        }));
        return;
      }
      if (action === 'extend_up' || action === 'extend_down') {
        const selectedIds = extendSelection(
          rows,
          ui.selectedIds,
          anchor,
          action === 'extend_down' ? 'down' : 'up',
        );
        setUi((prev) => selectKeyboardRowsState(prev, {
          selectedId: [...selectedIds].at(-1) ?? anchor,
          selectedIds,
          selectionAnchorId: anchor,
          selectionRootId,
        }));
        return;
      }
      if (action === 'navigate_up' || action === 'navigate_down') {
        const next = navigationTarget(
          rows,
          ui.selectedIds,
          anchor,
          action === 'navigate_down' ? 'down' : 'up',
        );
        if (next) {
          requestEditFocus(next);
        }
        return;
      }

      const batchIds = selectedRootIds(orderedSelected.length > 0 ? orderedSelected : [anchor], index.byId);
      const batchTargetIds = targetIdsForRows(batchIds, index.byId);
      if (action === 'batch_copy' || action === 'batch_cut') {
        const clipboardText = serializeSelectedRows(rows, ui.selectedIds, index.byId);
        void writeClipboardText(clipboardText).then((ok) => {
          if (!ok) {
            setError('Could not write selection to clipboard.');
            return;
          }
          if (action === 'batch_copy') return;
          const previous = rows[Math.max(0, rows.indexOf(batchIds[0]) - 1)];
          void run(() => api.batchTrashNodes(batchIds)).then(() => {
            if (previous && !batchIds.includes(previous)) requestEditFocus(previous);
            else setUi(clearKeyboardSelectionState);
          });
        });
        return;
      }
      if (action === 'batch_delete') {
        if (
          ui.selectionSource === 'ref-click'
          && singleSelectedId
          && selectedReferenceTargetId
          && batchIds.length === 1
          && batchIds[0] === singleSelectedId
        ) {
          void run(() => api.deleteNode(singleSelectedId)).then(() => {
            setUi(clearKeyboardSelectionState);
          });
          return;
        }
        const previous = rows[Math.max(0, rows.indexOf(batchIds[0]) - 1)];
        void run(() => api.batchTrashNodes(batchIds)).then(() => {
          if (previous && !batchIds.includes(previous)) requestEditFocus(previous);
          else setUi(clearKeyboardSelectionState);
        });
        return;
      }
      if (action === 'batch_duplicate') {
        void run(() => api.batchDuplicateNodes(batchIds));
        return;
      }
      if (action === 'batch_move_up' || action === 'batch_move_down') {
        const move = action === 'batch_move_up' ? api.batchMoveNodesUp : api.batchMoveNodesDown;
        void run(() => move(batchIds)).then(() => {
          setUi((prev) => selectKeyboardRowsState(prev, {
            selectedId: anchor,
            selectedIds: new Set(batchIds),
            selectionAnchorId: anchor,
            selectionRootId,
          }));
        });
        return;
      }
      if (action === 'batch_apply_tag') {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        setUi((prev) => ({
          ...clearFocusState(prev),
          focusedId: null,
          batchTagSelectorOpen: true,
        }));
        return;
      }
      const batchOperation =
        action === 'batch_indent'
          ? api.batchIndentNodes
          : action === 'batch_outdent'
            ? api.batchOutdentNodes
            : action === 'batch_checkbox'
              ? api.batchCycleDoneState
              : null;
      if (batchOperation) {
        const operationIds = action === 'batch_checkbox' ? batchTargetIds : batchIds;
        if (action === 'batch_indent') {
          setUi((prev) => ({
            ...prev,
            expanded: expandIndentTargets(prev.expanded, batchIds, index.byId),
          }));
        }
        void run(() => batchOperation(operationIds)).then((result) => {
          if (result && action === 'batch_indent') {
            setUi((prev) => ({
              ...prev,
              expanded: expandIndentTargets(prev.expanded, batchIds, index.byId),
            }));
          }
          if (action === 'batch_checkbox') {
            setUi((prev) => selectKeyboardRowsState(prev, {
              selectedId: anchor,
              selectedIds: new Set(batchIds),
              selectionAnchorId: anchor,
              selectionRootId,
            }));
            return;
          }
          requestEditFocus(anchor);
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [appendTypedCharToRow, index, onOpenPanel, requestEditFocus, rootId, run, setCommandOpen, setError, setUi, ui]);
}
