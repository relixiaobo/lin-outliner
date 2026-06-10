import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { api } from '../api/client';
import { parseIsoLocalDate, todayIsoLocalDate, type NodeId } from '../api/types';
import { resolveReferenceTargetId } from '../state/document';
import type { DocumentIndex, UiState } from '../state/document';
import { buildSelectableRows } from '../state/selectableRows';
import { targetIdsForRows } from './interactions/contextMenuSelection';
import { isImeComposingEvent } from './interactions/imeKeyboard';
import { expandIndentTargets } from './interactions/outlinerStructure';
import { armReferenceTypeAhead } from './interactions/referenceTypeAhead';
import {
  idsAllowedForStructuralBatch,
  idsEnabledForSelectionAction,
  runSelectionDelete,
  runSelectionDuplicate,
  runSelectionMove,
  selectableRowMap,
} from './interactions/selectionBatchActions';
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
import { matchesShortcutEvent } from './interactions/shortcutRegistry';
import {
  clearFocusState,
  cursorOffset,
  requestFocusState,
  rowFocusTarget,
} from './focus/focusModel';
import { collapseExpandedParentIds, parentIdsEmptiedByOutdent, type CommandRunner } from './shared';

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
  onGoToRoot: (nodeId: NodeId) => void;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  onOpenPanel: () => void;
  requestEditFocus: (nodeId: NodeId, parentId?: NodeId | null) => void;
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
  onGoToRoot,
  onNavigateBack,
  onNavigateForward,
  onOpenPanel,
  requestEditFocus,
  rootId,
  run,
  setCommandOpen,
  setError,
  setUi,
  ui,
}: UseWorkspaceKeyboardOptions) {
  const latestStateRef = useRef({ index, rootId, ui });
  latestStateRef.current = { index, rootId, ui };

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const {
        index: currentIndex,
        rootId: currentRootId,
        ui: currentUi,
      } = latestStateRef.current;
      const focusSelectedRowForTextInput = () => {
        if (!currentRootId || !currentIndex || currentUi.focusedId || currentUi.selectedIds.size === 0) return;
        if (
          event.target instanceof HTMLElement
          && event.target.closest('[data-preserve-selection]')
        ) {
          return;
        }
        if (shouldIgnoreSelectionKeyboardTarget(event.target, {
          allowContentEditable: currentUi.selectedIds.size > 1,
        })) {
          return;
        }
        const selectionRootId = resolveKeyboardSelectionRoot(currentUi, currentIndex, currentRootId);
        const selectableRows = buildSelectableRows(selectionRootId, currentIndex.byId, {
          expanded: currentUi.expanded,
          expandedHiddenFields: currentUi.expandedHiddenFields,
        });
        const rows = selectableRows.map((row) => row.id);
        const rowsById = selectableRowMap(selectableRows);
        const orderedSelected = orderedSelectedRows(rows, currentUi.selectedIds);
        const anchor = resolveSelectionAnchor({
          rows,
          selectedIds: currentUi.selectedIds,
          selectedId: currentUi.selectedId,
          selectionAnchorId: currentUi.selectionAnchorId,
        });
        if (!anchor) return;
        const singleSelectedId = orderedSelected.length === 1
          ? orderedSelected[0]
          : currentUi.selectedIds.size === 1
            ? anchor
            : null;
        const singleSelectedNode = singleSelectedId ? currentIndex.byId.get(singleSelectedId) : null;
        const selectedReferenceTargetId = singleSelectedNode?.type === 'reference' && singleSelectedNode.targetId
          ? resolveReferenceTargetId(singleSelectedNode.targetId, currentIndex.byId) ?? singleSelectedNode.targetId
          : null;
        if (singleSelectedId && singleSelectedNode && selectedReferenceTargetId) {
          const parentId = singleSelectedNode.parentId;
          if (!parentId) return;
          armReferenceTypeAhead({
            referenceId: singleSelectedId,
            parentId,
            targetId: selectedReferenceTargetId,
            panelId: null,
            selectionRootId,
            run,
            setUi,
          });
          return;
        }
        const editId = orderedSelected[0] ?? anchor;
        requestEditFocus(editId, rowsById.get(editId)?.parentId);
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
      const targetIsEditable = shouldIgnoreSelectionKeyboardTarget(event.target);
      if (matchesShortcutEvent(event, 'global.command_palette')) {
        event.preventDefault();
        setCommandOpen(true);
        return;
      }
      if (matchesShortcutEvent(event, 'global.open_agent_panel')) {
        event.preventDefault();
        onOpenPanel();
        return;
      }
      if (
        matchesShortcutEvent(event, 'global.go_to_today')
        && currentIndex
        && currentUi.selectedIds.size === 0
        && !targetIsEditable
      ) {
        const today = parseIsoLocalDate(todayIsoLocalDate());
        if (!today) return;
        event.preventDefault();
        void run(() => api.ensureDateNode(
          today.getFullYear(),
          today.getMonth() + 1,
          today.getDate(),
        )).then((result) => {
          if (result && 'focus' in result && result.focus?.nodeId) {
            onGoToRoot(result.focus.nodeId);
          }
        });
        return;
      }
      if (matchesShortcutEvent(event, 'global.nav_back') && !targetIsEditable) {
        event.preventDefault();
        onNavigateBack();
        return;
      }
      if (matchesShortcutEvent(event, 'global.nav_forward') && !targetIsEditable) {
        event.preventDefault();
        onNavigateForward();
        return;
      }
      if (matchesShortcutEvent(event, 'global.redo')) {
        event.preventDefault();
        void run(() => api.redo());
        return;
      }
      if (matchesShortcutEvent(event, 'global.undo')) {
        event.preventDefault();
        void run(() => api.undo());
        return;
      }
      if (!currentRootId || !currentIndex || currentUi.focusedId) {
        return;
      }
      if (shouldIgnoreSelectionKeyboardTarget(event.target, {
        allowContentEditable: currentUi.selectedIds.size > 1,
      })) {
        return;
      }
      const action = resolveSelectionKeyboardAction(event);
      if (!action) {
        return;
      }

      const selectionRootId = resolveKeyboardSelectionRoot(currentUi, currentIndex, currentRootId);
      const selectableRows = buildSelectableRows(selectionRootId, currentIndex.byId, {
        expanded: currentUi.expanded,
        expandedHiddenFields: currentUi.expandedHiddenFields,
      });
      const rows = selectableRows.map((row) => row.id);
      const rowsById = selectableRowMap(selectableRows);
      const orderedSelected = orderedSelectedRows(rows, currentUi.selectedIds);
      const anchor = resolveSelectionAnchor({
        rows,
        selectedIds: currentUi.selectedIds,
        selectedId: currentUi.selectedId,
        selectionAnchorId: currentUi.selectionAnchorId,
      });
      if (currentUi.selectedIds.size === 0 && action !== 'select_all') {
        return;
      }
      if (!anchor && action !== 'select_all') {
        return;
      }

      event.preventDefault();
      const singleSelectedId = orderedSelected.length === 1
        ? orderedSelected[0]
        : currentUi.selectedIds.size === 1
          ? anchor
          : null;
      const singleSelectedNode = singleSelectedId ? currentIndex.byId.get(singleSelectedId) : null;
      const selectedReferenceTargetId = singleSelectedNode?.type === 'reference' && singleSelectedNode.targetId
        ? resolveReferenceTargetId(singleSelectedNode.targetId, currentIndex.byId) ?? singleSelectedNode.targetId
        : null;
      const convertSelectedReferenceToInline = () => {
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
              return {
                ...requestFocusState(prev, target, cursorOffset(0, 'after')),
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
        if (!anchor) return;
        const editId = orderedSelected[0] ?? anchor;
        requestEditFocus(editId, rowsById.get(editId)?.parentId);
        return;
      }
      if (action === 'type_char') {
        if (selectedReferenceTargetId) {
          const parentId = singleSelectedNode?.parentId;
          if (!singleSelectedId || !parentId) return;
          armReferenceTypeAhead({
            referenceId: singleSelectedId,
            parentId,
            targetId: selectedReferenceTargetId,
            panelId: null,
            selectionRootId,
            initialText: event.key,
            run,
            setUi,
          });
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
        if (!anchor) return;
        const selectedIds = extendSelection(
          rows,
          currentUi.selectedIds,
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
        if (!anchor) return;
        const next = navigationTarget(
          rows,
          currentUi.selectedIds,
          anchor,
          action === 'navigate_down' ? 'down' : 'up',
        );
        if (next) {
          requestEditFocus(next, rowsById.get(next)?.parentId);
        }
        return;
      }

      if (!anchor) return;
      const parentIdForSelectedRow = (id: NodeId) => rowsById.get(id)?.parentId ?? currentIndex.byId.get(id)?.parentId;
      const batchIds = selectedRootIds(
        orderedSelected.length > 0 ? orderedSelected : [anchor],
        currentIndex.byId,
        parentIdForSelectedRow,
      );
      if (action === 'batch_copy' || action === 'batch_cut') {
        const clipboardText = serializeSelectedRows(rows, currentUi.selectedIds, currentIndex.byId);
        void writeClipboardText(clipboardText).then((ok) => {
          if (!ok) {
            setError('Could not write selection to clipboard.');
            return;
          }
          if (action === 'batch_copy') return;
          const previous = rows[Math.max(0, rows.indexOf(batchIds[0]) - 1)];
          void run(() => runSelectionDelete({
            ids: batchIds,
            panelRootId: selectionRootId,
            byId: currentIndex.byId,
            rowMap: rowsById,
          })).then(() => {
            if (previous && !batchIds.includes(previous)) requestEditFocus(previous, rowsById.get(previous)?.parentId);
            else setUi(clearKeyboardSelectionState);
          });
        });
        return;
      }
      if (action === 'batch_delete') {
        const previous = rows[Math.max(0, rows.indexOf(batchIds[0]) - 1)];
        void run(() => runSelectionDelete({
          ids: batchIds,
          panelRootId: selectionRootId,
          byId: currentIndex.byId,
          rowMap: rowsById,
          hardDeleteSingleReferenceId: currentUi.selectionSource === 'ref-click' && selectedReferenceTargetId
            ? singleSelectedId ?? undefined
            : undefined,
        })).then(() => {
          if (previous && !batchIds.includes(previous)) requestEditFocus(previous, rowsById.get(previous)?.parentId);
          else setUi(clearKeyboardSelectionState);
        });
        return;
      }
      if (action === 'batch_duplicate') {
        void run(() => runSelectionDuplicate({
          ids: batchIds,
          panelRootId: selectionRootId,
          byId: currentIndex.byId,
          rowMap: rowsById,
        }));
        return;
      }
      if (action === 'batch_move_up' || action === 'batch_move_down') {
        void run(() => runSelectionMove({
          ids: batchIds,
          direction: action === 'batch_move_up' ? 'up' : 'down',
          panelRootId: selectionRootId,
          byId: currentIndex.byId,
          rowMap: rowsById,
        })).then(() => {
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
        const taggableIds = idsEnabledForSelectionAction({
          ids: batchIds,
          action: 'tag',
          panelRootId: selectionRootId,
          byId: currentIndex.byId,
          rowMap: rowsById,
        });
        if (taggableIds.length === 0) return;
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
        const operationRowIds = action === 'batch_checkbox'
          ? idsEnabledForSelectionAction({
            ids: batchIds,
            action: 'checkbox',
            panelRootId: selectionRootId,
            byId: currentIndex.byId,
            rowMap: rowsById,
          })
          : idsAllowedForStructuralBatch({
            ids: batchIds,
            panelRootId: selectionRootId,
            byId: currentIndex.byId,
            rowMap: rowsById,
          });
        const operationIds = action === 'batch_checkbox'
          ? targetIdsForRows(operationRowIds, currentIndex.byId)
          : operationRowIds;
        if (operationIds.length === 0) return;
        const emptiedParentIds = action === 'batch_outdent'
          ? parentIdsEmptiedByOutdent(operationIds, currentIndex.byId, selectionRootId)
          : new Set<NodeId>();
        const structuralAction = action === 'batch_indent' || action === 'batch_outdent';
        void run(() => batchOperation(operationIds), {
          applyFocus: false,
          beforeApply: structuralAction
            ? () => {
              if (action === 'batch_indent') {
                setUi((prev) => ({
                  ...prev,
                  expanded: expandIndentTargets(prev.expanded, operationIds, currentIndex.byId),
                }));
              }
              if (action === 'batch_outdent' && emptiedParentIds.size > 0) {
                setUi((prev) => ({
                  ...prev,
                  expanded: collapseExpandedParentIds(prev.expanded, emptiedParentIds),
                }));
              }
              requestEditFocus(anchor);
            }
            : undefined,
        }).then((result) => {
          if (!result) return;
          if (action === 'batch_checkbox') {
            setUi((prev) => selectKeyboardRowsState(prev, {
              selectedId: anchor,
              selectedIds: new Set(batchIds),
              selectionAnchorId: anchor,
              selectionRootId,
            }));
            return;
          }
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    appendTypedCharToRow,
    index,
    onGoToRoot,
    onNavigateBack,
    onNavigateForward,
    onOpenPanel,
    requestEditFocus,
    rootId,
    run,
    setCommandOpen,
    setError,
    setUi,
    ui,
  ]);
}
