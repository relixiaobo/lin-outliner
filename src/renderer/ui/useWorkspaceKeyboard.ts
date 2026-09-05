import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { api } from '../api/client';
import {
  EMPTY_RICH_TEXT,
  isContentBearingNode,
  parseIsoLocalDate,
  todayIsoLocalDate,
  type NodeId,
  type RichText,
} from '../api/types';
import { resolveReferenceTargetId } from '../state/document';
import type { DocumentIndex, UiState } from '../state/document';
import { buildSelectableRows } from '../state/selectableRows';
import { targetIdsForRows } from './interactions/contextMenuSelection';
import { isImeComposingEvent } from './interactions/imeKeyboard';
import { batchIndentNodeIds, expandIndentTargets, indentTargetParentId } from './interactions/outlinerStructure';
import { armReferenceTypeAhead } from './interactions/referenceTypeAhead';
import {
  idsAllowedForStructuralIndentBatch,
  idsAllowedForStructuralOutdentBatch,
  idsEnabledForSelectionAction,
  planSelectionDelete,
  planSelectionSiblingMoves,
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
  selectVisibleRowsState,
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
  cursorEnd,
  requestFocusState,
  rowFocusTarget,
} from './focus/focusModel';
import { animateOutlinerRowMovementAfterNextCommit } from './outliner/rowMoveAnimation';
import { startOptimisticRemoval, startOptimisticStructuralBatch } from './outliner/optimisticStructuralEdit';
import {
  optimisticDonePatch,
  startOptimisticNodePatchBatch,
} from './outliner/optimisticNodePatch';
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

function isBracketPageHistoryShortcut(
  event: globalThis.KeyboardEvent,
  direction: 'back' | 'forward',
): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false;
  return direction === 'back'
    ? event.key === '[' || event.code === 'BracketLeft'
    : event.key === ']' || event.code === 'BracketRight';
}

function nodeContent(index: DocumentIndex, nodeId: NodeId): RichText {
  const node = index.byId.get(nodeId);
  return node && isContentBearingNode(node) ? node.content : EMPTY_RICH_TEXT;
}

function nodeContentText(index: DocumentIndex, nodeId: NodeId): string {
  return nodeContent(index, nodeId).text;
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
  panelId: string | null;
  requestEditFocus: (nodeId: NodeId, parentId?: NodeId | null) => void;
  rootId: NodeId | null;
  run: CommandRunner;
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
  panelId,
  requestEditFocus,
  rootId,
  run,
  setError,
  setUi,
  ui,
}: UseWorkspaceKeyboardOptions) {
  const latestStateRef = useRef({ index, rootId, ui });
  latestStateRef.current = { index, rootId, ui };

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
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
          if (!parentId || !panelId) return;
          armReferenceTypeAhead({
            referenceId: singleSelectedId,
            parentId,
            targetId: selectedReferenceTargetId,
            targetDisplayName: nodeContentText(currentIndex, selectedReferenceTargetId) || undefined,
            siblingIds: currentIndex.byId.get(parentId)?.children ?? [],
            panelId,
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
      if (
        matchesShortcutEvent(event, 'global.nav_back')
        && (!targetIsEditable || isBracketPageHistoryShortcut(event, 'back'))
      ) {
        event.preventDefault();
        onNavigateBack();
        return;
      }
      if (
        matchesShortcutEvent(event, 'global.nav_forward')
        && (!targetIsEditable || isBracketPageHistoryShortcut(event, 'forward'))
      ) {
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
      const convertSelectedReferenceToInline = (initialText?: string) => {
        if (!singleSelectedId || !singleSelectedNode || !selectedReferenceTargetId || !panelId) return;
        const parentId = singleSelectedNode.parentId;
        if (!parentId) return;
        armReferenceTypeAhead({
          referenceId: singleSelectedId,
          parentId,
          targetId: selectedReferenceTargetId,
          targetDisplayName: nodeContentText(currentIndex, selectedReferenceTargetId) || undefined,
          siblingIds: currentIndex.byId.get(parentId)?.children ?? [],
          panelId,
          selectionRootId,
          initialText,
          run,
          setUi,
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
          convertSelectedReferenceToInline(event.key);
          return;
        }
        appendTypedCharToRow(orderedSelected[0] ?? anchor, event.key);
        return;
      }
      if (action === 'select_all') {
        setUi((prev) => selectVisibleRowsState(prev, {
          byId: currentIndex.byId,
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
      const startSelectionDelete = (hardDeleteSingleReferenceId?: NodeId) => {
        const plan = planSelectionDelete({
          ids: batchIds,
          panelRootId: selectionRootId,
          byId: currentIndex.byId,
          rowMap: rowsById,
          hardDeleteSingleReferenceId,
        });
        const removalIds = plan.hardDeleteId
          ? [plan.hardDeleteId]
          : [...plan.trashIds, ...plan.fieldValueIds];
        if (removalIds.length === 0) return;
        const previous = rows[Math.max(0, rows.indexOf(batchIds[0]) - 1)];
        const restoreSelection = () => {
          setUi((state) => ({
            ...clearFocusState(state),
            focusedId: null,
            selectedId: currentUi.selectedId,
            selectedIds: new Set(currentUi.selectedIds),
            selectionAnchorId: currentUi.selectionAnchorId,
            selectionRootId: currentUi.selectionRootId,
            selectionSource: currentUi.selectionSource,
          }));
        };
        void startOptimisticRemoval({
          ids: removalIds,
          setUi,
          command: () => run(() => runSelectionDelete({
            ids: batchIds,
            panelRootId: selectionRootId,
            byId: currentIndex.byId,
            rowMap: rowsById,
            hardDeleteSingleReferenceId,
          })),
          onRejected: restoreSelection,
          onFailed: restoreSelection,
        });
        if (previous && !batchIds.includes(previous)) {
          requestEditFocus(previous, rowsById.get(previous)?.parentId);
        } else {
          setUi(clearKeyboardSelectionState);
        }
      };
      if (action === 'batch_copy' || action === 'batch_cut') {
        const clipboardText = serializeSelectedRows(rows, currentUi.selectedIds, currentIndex.byId);
        void writeClipboardText(clipboardText).then((ok) => {
          if (!ok) {
            setError('Could not write selection to clipboard.');
            return;
          }
          if (action === 'batch_copy') return;
          startSelectionDelete();
        });
        return;
      }
      if (action === 'batch_delete') {
        startSelectionDelete(
          currentUi.selectionSource === 'ref-click' && selectedReferenceTargetId
            ? singleSelectedId ?? undefined
            : undefined,
        );
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
        const direction = action === 'batch_move_up' ? 'up' : 'down';
        const placements = planSelectionSiblingMoves({
          ids: batchIds,
          direction,
          panelRootId: selectionRootId,
          byId: currentIndex.byId,
          rowMap: rowsById,
        });
        if (!panelId || placements.length === 0) return;
        animateOutlinerRowMovementAfterNextCommit();
        startOptimisticStructuralBatch({
          panelId,
          setUi,
          inputs: placements.map((placement) => ({
            id: placement.id,
            parentId: placement.parentId,
            sourceParentId: placement.parentId,
            beforeId: placement.beforeId,
            afterId: placement.afterId,
            content: nodeContent(currentIndex, placement.id),
            placement: cursorEnd(),
            preserveFocus: true,
          })),
          command: () => run(() => runSelectionMove({
            ids: batchIds,
            direction,
            panelRootId: selectionRootId,
            byId: currentIndex.byId,
            rowMap: rowsById,
          })),
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
          : action === 'batch_outdent'
            ? idsAllowedForStructuralOutdentBatch({
              ids: batchIds,
              panelRootId: selectionRootId,
              byId: currentIndex.byId,
              rowMap: rowsById,
            })
            : idsAllowedForStructuralIndentBatch({
              ids: batchIds,
              panelRootId: selectionRootId,
              byId: currentIndex.byId,
              rowMap: rowsById,
            });
        const operationIds = action === 'batch_checkbox'
          ? targetIdsForRows(operationRowIds, currentIndex.byId)
          : action === 'batch_indent'
            ? batchIndentNodeIds(operationRowIds, currentIndex.byId)
            : operationRowIds;
        if (operationIds.length === 0) return;
        if (action === 'batch_checkbox') {
          const now = Date.now();
          const patches = operationIds.flatMap((id) => {
            const node = currentIndex.byId.get(id);
            return node && isContentBearingNode(node) ? [optimisticDonePatch({
              index: currentIndex,
              node,
              ui: currentUi,
              transition: 'cycle',
              now,
            })] : [];
          });
          void startOptimisticNodePatchBatch({
            currentUi,
            setUi,
            patches,
            command: () => run(() => batchOperation(operationIds), { applyFocus: false }),
          });
          return;
        }
        if ((action === 'batch_indent' || action === 'batch_outdent') && panelId) {
          const emptiedParentIds = action === 'batch_outdent'
            ? parentIdsEmptiedByOutdent(operationIds, currentIndex.byId, selectionRootId)
            : new Set<NodeId>();
          const orderedIds = action === 'batch_outdent' ? [...operationIds].reverse() : operationIds;
          const placements = orderedIds.flatMap((id) => {
            const node = currentIndex.byId.get(id);
            const sourceParentId = node?.parentId;
            if (!node || !isContentBearingNode(node) || !sourceParentId) return [];
            const targetParentId = action === 'batch_indent'
              ? indentTargetParentId(id, currentIndex.byId)
              : currentIndex.byId.get(sourceParentId)?.parentId ?? null;
            if (!targetParentId) return [];
            return [{
              id,
              node,
              sourceParentId,
              targetParentId,
              afterId: action === 'batch_indent'
                ? currentIndex.byId.get(targetParentId)?.children.at(-1) ?? null
                : sourceParentId,
            }];
          });
          if (placements.length === 0) return;
          const restoreExpansion = () => {
            setUi((state) => ({ ...state, expanded: new Set(currentUi.expanded) }));
          };
          animateOutlinerRowMovementAfterNextCommit();
          startOptimisticStructuralBatch({
            panelId,
            setUi,
            inputs: placements.map((placement, index) => ({
              id: placement.id,
              sourceParentId: placement.sourceParentId,
              parentId: placement.targetParentId,
              afterId: placement.afterId,
              presentation: placement.node.type === 'fieldEntry' ? 'field' as const : 'content' as const,
              resolvedFieldDefId: placement.node.type === 'fieldEntry' ? placement.node.fieldDefId : undefined,
              content: placement.node.content,
              placement: cursorEnd(),
              preserveFocus: true,
              ...(index === 0
                ? {
                    updateUi: (state: UiState) => ({
                      ...state,
                      expanded: action === 'batch_indent'
                        ? expandIndentTargets(state.expanded, operationIds, currentIndex.byId)
                        : collapseExpandedParentIds(state.expanded, emptiedParentIds),
                    }),
                  }
                : {}),
            })),
            command: () => run(() => batchOperation(operationIds), { applyFocus: false }),
            onRejected: restoreExpansion,
            onFailed: restoreExpansion,
          });
          return;
        }
        void run(() => batchOperation(operationIds), {
          applyFocus: false,
        }).then((result) => {
          if (!result) return;
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    appendTypedCharToRow,
    onGoToRoot,
    onNavigateBack,
    onNavigateForward,
    onOpenPanel,
    panelId,
    requestEditFocus,
    run,
    setError,
    setUi,
  ]);
}
