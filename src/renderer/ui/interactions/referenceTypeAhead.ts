import type { Dispatch, SetStateAction } from 'react';
import { freshNodeId } from '../../../core/nodeId';
import { api } from '../../api/client';
import { nodeReferenceTarget, type NodeId, type RichText } from '../../api/types';
import type { UiState } from '../../state/document';
import { richTextEquals } from '../editor/richTextCodec';
import { clearFocusState, cursorOffset } from '../focus/focusModel';
import { makeDraftNode } from '../outliner/draftRow';
import {
  addOptimisticRemovals,
  clearOptimisticRemovals,
  optimisticReplacementAnchors,
  startOptimisticStructuralEdit,
} from '../outliner/optimisticStructuralEdit';
import type { CommandRunner } from '../shared';

export function armReferenceTypeAhead(params: {
  referenceId: NodeId;
  parentId: NodeId;
  targetId: NodeId;
  targetDisplayName?: string;
  siblingIds: readonly NodeId[];
  panelId: string;
  selectionRootId: NodeId;
  initialText?: string;
  run: CommandRunner;
  setUi: Dispatch<SetStateAction<UiState>>;
}) {
  const replacementId = freshNodeId();
  const initialContent: RichText = {
    text: params.initialText ?? '',
    marks: [],
    inlineRefs: [{
      offset: 0,
      target: nodeReferenceTarget(params.targetId),
      ...(params.targetDisplayName ? { displayName: params.targetDisplayName } : {}),
    }],
  };
  const anchors = optimisticReplacementAnchors(params.siblingIds, params.referenceId);
  const restoreSourceSelection = () => {
    params.setUi((previous) => {
      const restored = clearOptimisticRemovals(previous, [params.referenceId]);
      return {
        ...clearFocusState(restored),
        selectedId: params.referenceId,
        selectedIds: new Set([params.referenceId]),
        selectionAnchorId: params.referenceId,
        selectionRootId: params.selectionRootId,
        selectionSource: 'ref-click',
        pendingReferenceConversion: restored.pendingReferenceConversion?.nodeId === replacementId
          ? null
          : restored.pendingReferenceConversion,
      };
    });
  };

  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

  return startOptimisticStructuralEdit({
    panelId: params.panelId,
    setUi: params.setUi,
    input: {
      id: replacementId,
      parentId: params.parentId,
      ...anchors,
      content: initialContent,
      nodeOverride: makeDraftNode(replacementId, params.parentId, initialContent),
      placement: cursorOffset(initialContent.text.length, 'after'),
      updateUi: (previous) => ({
        ...addOptimisticRemovals(previous, [params.referenceId]),
        pendingReferenceConversion: {
          nodeId: replacementId,
          parentId: params.parentId,
          targetId: params.targetId,
        },
      }),
    },
    command: () => params.run(
      () => api.convertReferenceToInlineNode(params.referenceId, replacementId),
      { applyFocus: false },
    ),
    reconcile: async (_result, change) => {
      if (!richTextEquals(change.latestContent.current, initialContent)) {
        const reconciled = await params.run(
          () => api.replaceNodeText(change.id, change.latestContent.current),
          { applyFocus: false },
        );
        if (reconciled === null) return false;
      }
      params.setUi((previous) => clearOptimisticRemovals(previous, [params.referenceId]));
      return true;
    },
    onRejected: restoreSourceSelection,
    onFailed: restoreSourceSelection,
  });
}
