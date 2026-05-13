import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { DocumentProjection, FocusHint, NodeId } from '../api/types';
import { flattenVisibleRows, useDocumentIndex, useUiState } from '../state/document';
import { CommandPalette } from './CommandPalette';
import { NodePanel } from './NodePanel';
import { TopBar } from './TopBar';
import { CloseIcon, ICON_SIZE } from './icons';
import { targetIdsForRows } from './interactions/contextMenuSelection';
import { useDragSelection } from './interactions/dragSelection';
import {
  shouldClearSelectionOnFocusIn,
  shouldClearSelectionOnPointerDown,
  shouldPreserveSelectionForModifierGesture,
} from './interactions/selectionDismiss';
import {
  resolveSelectionKeyboardAction,
  shouldIgnoreSelectionKeyboardTarget,
} from './interactions/selectionKeyboard';
import { isImeComposingEvent } from './interactions/imeKeyboard';
import {
  appendText,
  extendSelection,
  navigationTarget,
  orderedSelectedRows,
  resolveSelectionAnchor,
  selectedRootIds,
  serializeSelectedRows,
} from './interactions/selectionActions';
import { expandIndentTargets } from './interactions/outlinerStructure';
import { BatchTagSelector } from './outliner/BatchTagSelector';
import type { TriggerState } from './shared';
import { textOf, useCommandRunner } from './shared';

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

export function App() {
  const [projection, setProjection] = useState<DocumentProjection | null>(null);
  const [ui, setUi] = useUiState();
  const [rootId, setRootId] = useState<NodeId | null>(null);
  const [pendingFocus, setPendingFocus] = useState<FocusHint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trigger, setTrigger] = useState<TriggerState>(null);
  const [dragId, setDragId] = useState<NodeId | null>(null);
  const index = useDocumentIndex(projection);
  const run = useCommandRunner(setProjection, setPendingFocus, setError);
  useDragSelection({ rootId, index, ui, setUi });

  useEffect(() => {
    void run(async () => {
      const initial = await api.initWorkspace();
      setRootId(initial.todayId);
      setUi((prev) => ({
        ...prev,
        focusedId: initial.todayId,
        selectedId: initial.todayId,
        selectedIds: new Set([initial.todayId]),
        selectionAnchorId: initial.todayId,
      }));
      return initial;
    });
  }, [run, setUi]);

  const setCommandOpen = useCallback((commandOpen: boolean) => {
    setUi((prev) => ({ ...prev, commandOpen }));
  }, [setUi]);

  const focusNode = useCallback((nodeId: NodeId | null) => {
    setUi((prev) => ({
      ...prev,
      focusedId: nodeId,
      selectedId: nodeId ?? prev.selectedId,
      selectedIds: nodeId ? new Set([nodeId]) : prev.selectedIds,
      selectionAnchorId: nodeId ?? prev.selectionAnchorId,
    }));
  }, [setUi]);

  const requestEditFocus = useCallback((nodeId: NodeId) => {
    setUi((prev) => ({
      ...prev,
      focusedId: nodeId,
      selectedId: nodeId,
      selectedIds: new Set([nodeId]),
      selectionAnchorId: nodeId,
    }));
    setPendingFocus({ nodeId, selectAll: false });
  }, [setUi]);

  const appendTypedCharToRow = useCallback((rowId: NodeId, char: string) => {
    if (!index) return;
    const row = index.byId.get(rowId);
    if (!row) return;
    const targetId = row.type === 'fieldEntry' && row.fieldDefId
      ? row.fieldDefId
      : row.type === 'reference' && row.targetId
        ? row.targetId
        : row.id;
    const target = index.byId.get(targetId);
    if (!target) {
      requestEditFocus(rowId);
      return;
    }
    void run(() => api.updateNodeText(targetId, appendText(target.content, char)))
      .then(() => requestEditFocus(rowId));
  }, [index, requestEditFocus, run]);

  const applyOutcomeFocus = useCallback((focus: FocusHint | null) => {
    if (!focus) return;
    focusNode(focus.nodeId);
  }, [focusNode]);

  useEffect(() => {
    applyOutcomeFocus(pendingFocus);
  }, [applyOutcomeFocus, pendingFocus]);

  useEffect(() => {
    const clearBlockSelection = () => {
      setUi((prev) => {
        if (prev.focusedId || prev.selectedIds.size === 0) return prev;
        return {
          ...prev,
          selectedId: null,
          selectedIds: new Set(),
          selectionAnchorId: null,
          batchTagSelectorOpen: false,
        };
      });
    };

    const onPointerOrMouseDown = (event: PointerEvent | MouseEvent) => {
      if (shouldPreserveSelectionForModifierGesture(event)) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearSelectionOnPointerDown(target)) return;
      clearBlockSelection();
    };

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearSelectionOnFocusIn(target)) return;
      clearBlockSelection();
    };

    window.addEventListener('pointerdown', onPointerOrMouseDown, true);
    window.addEventListener('mousedown', onPointerOrMouseDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerOrMouseDown, true);
      window.removeEventListener('mousedown', onPointerOrMouseDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }, [setUi]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isImeComposingEvent(event)) return;
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
      }
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        void run(() => event.shiftKey ? api.redo() : api.undo());
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
          ...prev,
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
          ...prev,
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
            else setUi((prev) => ({ ...prev, focusedId: null, selectedIds: new Set(), selectionAnchorId: null }));
          });
        });
        return;
      }
      if (action === 'batch_delete') {
        const previous = rows[Math.max(0, rows.indexOf(batchIds[0]) - 1)];
        void run(() => api.batchTrashNodes(batchIds)).then(() => {
          if (previous && !batchIds.includes(previous)) requestEditFocus(previous);
          else setUi((prev) => ({ ...prev, focusedId: null, selectedIds: new Set(), selectionAnchorId: null }));
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
            ...prev,
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
          ...prev,
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
              ? api.batchToggleDone
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
          requestEditFocus(anchor);
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [appendTypedCharToRow, index, requestEditFocus, rootId, run, setCommandOpen, setUi, ui]);

  const navigateRoot = useCallback((nodeId: NodeId) => {
    setRootId(nodeId);
    focusNode(nodeId);
    setUi((prev) => {
      const expanded = new Set(prev.expanded);
      expanded.add(nodeId);
      return { ...prev, expanded };
    });
  }, [focusNode, setUi]);

  const newNodeUnderRoot = useCallback(() => {
    if (!rootId) return;
    void run(() => api.createNode(rootId, null, ''));
  }, [rootId, run]);

  if (!projection || !index || !rootId) {
    return <div className="app"><div className="main-panel">Loading...</div></div>;
  }

  const rootNode = index.byId.get(rootId);

  return (
    <div className="app">
      <TopBar
        projection={projection}
        rootId={rootId}
        rootName={textOf(rootNode)}
        onRoot={navigateRoot}
        onNew={newNodeUnderRoot}
        onUndo={() => void run(api.undo)}
        onRedo={() => void run(api.redo)}
        onCommand={() => setCommandOpen(true)}
      />

      <div className="shell">
        <NodePanel
          rootId={rootId}
          onRoot={navigateRoot}
          index={index}
          ui={ui}
          setUi={setUi}
          run={run}
          trigger={trigger}
          setTrigger={setTrigger}
          pendingFocus={pendingFocus}
          dragId={dragId}
          setDragId={setDragId}
        />
      </div>

      <BatchTagSelector
        open={ui.batchTagSelectorOpen}
        selectedIds={ui.selectedIds}
        index={index}
        run={run}
        close={() => setUi((prev) => ({ ...prev, batchTagSelectorOpen: false }))}
        clearSelection={() => setUi((prev) => ({
          ...prev,
          focusedId: null,
          selectedIds: new Set(),
          selectionAnchorId: null,
          batchTagSelectorOpen: false,
        }))}
      />

      {ui.commandOpen && (
        <CommandPalette
          projection={projection}
          index={index}
          onClose={() => setCommandOpen(false)}
          onFocus={focusNode}
          onRoot={navigateRoot}
          run={run}
        />
      )}

      {error && (
        <div className="error">
          <button className="icon-button" style={{ float: 'right' }} onClick={() => setError(null)}><CloseIcon size={ICON_SIZE.menu} /></button>
          {error}
        </div>
      )}
    </div>
  );
}
