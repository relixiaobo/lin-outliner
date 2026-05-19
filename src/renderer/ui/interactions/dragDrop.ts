import type { NodeId } from '../../api/types';
import type { DropHoverPosition } from './dropPosition';

export interface ResolveOutlinerDropMoveInput {
  dragNodeId: NodeId | null;
  targetNodeId: NodeId;
  targetParentId: NodeId | null | undefined;
  siblingIndex: number;
  dropPosition: DropHoverPosition | null;
  targetHasChildren: boolean;
  targetIsExpanded: boolean;
  currentParentId?: NodeId | null;
  currentIndex?: number;
}

export interface OutlinerDropMove {
  parentId: NodeId;
  index: number;
  expandTargetId?: NodeId;
}

export const OUTLINER_NODE_DRAG_MIME = 'application/x-lin-outliner-node-id';

export function resolveOutlinerDropMove(input: ResolveOutlinerDropMoveInput): OutlinerDropMove | null {
  const {
    dragNodeId,
    targetNodeId,
    targetParentId,
    siblingIndex,
    dropPosition,
    targetHasChildren,
    targetIsExpanded,
    currentParentId,
    currentIndex,
  } = input;

  if (!dragNodeId || dragNodeId === targetNodeId || !targetParentId || siblingIndex < 0) return null;

  let parentId: NodeId;
  let index: number;
  let expandTargetId: NodeId | undefined;

  if (dropPosition === 'inside') {
    parentId = targetNodeId;
    index = 0;
    expandTargetId = targetNodeId;
  } else if (dropPosition === 'after' && targetHasChildren && targetIsExpanded) {
    parentId = targetNodeId;
    index = 0;
  } else {
    parentId = targetParentId;
    index = siblingIndex + (dropPosition === 'after' ? 1 : 0);
  }

  if (
    currentParentId === parentId
    && typeof currentIndex === 'number'
    && currentIndex >= 0
    && currentIndex < index
  ) {
    index -= 1;
  }

  return { parentId, index, expandTargetId };
}
