import type { Dispatch, SetStateAction } from 'react';
import { api } from '../../api/client';
import type { NodeId } from '../../api/types';
import type { UiState } from '../../state/document';
import { clearFocusState, cursorOffset, requestFocusState, rowFocusTarget } from '../focus/focusModel';
import type { CommandRunner } from '../shared';

export function armReferenceTypeAhead(params: {
  referenceId: NodeId;
  parentId: NodeId;
  targetId: NodeId;
  panelId: string | null;
  selectionRootId: NodeId;
  initialText?: string;
  run: CommandRunner;
  setUi: Dispatch<SetStateAction<UiState>>;
}) {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }

  params.setUi((prev) => ({
    ...clearFocusState(prev),
    selectedId: params.referenceId,
    selectedIds: new Set([params.referenceId]),
    selectionAnchorId: params.referenceId,
    selectionRootId: params.selectionRootId,
    selectionSource: 'ref-click',
    pendingReferenceConversion: null,
    pendingReferenceTypeAhead: {
      nodeId: params.referenceId,
      parentId: params.parentId,
      targetId: params.targetId,
    },
  }));

  void params.run(
    () => api.convertReferenceToInlineNode(params.referenceId),
    { applyFocus: false },
  ).then(async (result) => {
    if (!result || !('focus' in result)) return;
    const inlineNodeId = result.focus?.nodeId;
    const inlineParentId = result.focus?.parentId ?? params.parentId;
    if (!inlineNodeId) return;

    let cursorTextLength = 0;
    const initialText = params.initialText ?? '';
    if (initialText) {
      const convertedNode = result.projection.nodes.find((node) => node.id === inlineNodeId);
      if (convertedNode) {
        cursorTextLength = initialText.length;
        await params.run(() => api.replaceNodeText(inlineNodeId, {
          ...convertedNode.content,
          marks: [],
          text: initialText,
        }), { applyFocus: false });
      }
    }

    window.requestAnimationFrame(() => {
      params.setUi((prev) => {
        const target = rowFocusTarget(inlineNodeId, inlineParentId, params.panelId);
        return {
          ...requestFocusState(
            prev,
            target,
            cursorOffset(cursorTextLength, 'after'),
          ),
          pendingReferenceConversion: {
            nodeId: inlineNodeId,
            parentId: inlineParentId,
            targetId: params.targetId,
          },
          pendingReferenceTypeAhead: null,
        };
      });
    });
  });
}
