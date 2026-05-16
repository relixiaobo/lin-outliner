import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { api } from '../api/client';
import type { NodeId } from '../api/types';
import { flattenVisibleRows } from '../state/document';
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
import { clearFocusState } from './focus/focusModel';
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
        const rows = flattenVisibleRows(rootId, index.byId, ui.expanded, ui.expandedHiddenFields);
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

      const rows = flattenVisibleRows(rootId, index.byId, ui.expanded, ui.expandedHiddenFields);
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
      if (action === 'clear_selection' || action === 'enter_edit') {
        requestEditFocus(orderedSelected[0] ?? anchor);
        return;
      }
      if (action === 'type_char') {
        appendTypedCharToRow(orderedSelected[0] ?? anchor, event.key);
        return;
      }
      if (action === 'select_all') {
        setUi((prev) => ({
          ...clearFocusState(prev),
          focusedId: null,
          selectedId: rows[0] ?? prev.selectedId,
          selectedIds: new Set(rows),
          selectionAnchorId: rows[0] ?? prev.selectionAnchorId,
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
        setUi((prev) => ({
          ...clearFocusState(prev),
          focusedId: null,
          selectedId: [...selectedIds].at(-1) ?? anchor,
          selectedIds,
          selectionAnchorId: anchor,
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
            else setUi((prev) => ({
              ...clearFocusState(prev),
              focusedId: null,
              selectedIds: new Set(),
              selectionAnchorId: null,
            }));
          });
        });
        return;
      }
      if (action === 'batch_delete') {
        const previous = rows[Math.max(0, rows.indexOf(batchIds[0]) - 1)];
        void run(() => api.batchTrashNodes(batchIds)).then(() => {
          if (previous && !batchIds.includes(previous)) requestEditFocus(previous);
          else setUi((prev) => ({
            ...clearFocusState(prev),
            focusedId: null,
            selectedIds: new Set(),
            selectionAnchorId: null,
          }));
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
          setUi((prev) => ({
            ...clearFocusState(prev),
            focusedId: null,
            selectedId: anchor,
            selectedIds: new Set(batchIds),
            selectionAnchorId: anchor,
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
            setUi((prev) => ({
              ...clearFocusState(prev),
              focusedId: null,
              selectedId: anchor,
              selectedIds: new Set(batchIds),
              selectionAnchorId: anchor,
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
