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

export interface OutlinerDropBatchMove {
  nodeId: NodeId;
  parentId: NodeId;
  index: number;
}

export interface ResolveOutlinerDropBatchMoveInput {
  dragNodeIds: readonly NodeId[];
  targetNodeId: NodeId;
  targetParentId: NodeId | null | undefined;
  siblingIndex: number;
  dropPosition: DropHoverPosition | null;
  targetHasChildren: boolean;
  targetIsExpanded: boolean;
  parentIdForNode: (nodeId: NodeId) => NodeId | null | undefined;
  childrenForParent: (parentId: NodeId) => readonly NodeId[];
}

export interface ResolvedOutlinerDropBatchMove {
  moves: OutlinerDropBatchMove[];
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

export function resolveOutlinerDropBatchMove(input: ResolveOutlinerDropBatchMoveInput): ResolvedOutlinerDropBatchMove | null {
  const dragNodeIds = [...new Set(input.dragNodeIds)].filter(Boolean);
  if (dragNodeIds.length === 0 || dragNodeIds.includes(input.targetNodeId)) return null;

  const target = resolveOutlinerDropTarget(input);
  if (!target) return null;

  const selected = new Set(dragNodeIds);
  for (let parentId: NodeId | null | undefined = target.parentId; parentId; parentId = input.parentIdForNode(parentId)) {
    if (selected.has(parentId)) return null;
  }

  const targetChildren = input.childrenForParent(target.parentId);
  const currentIndexes = new Map<NodeId, number>();
  for (const nodeId of dragNodeIds) {
    if (input.parentIdForNode(nodeId) === target.parentId) {
      currentIndexes.set(nodeId, targetChildren.indexOf(nodeId));
    }
  }
  const removedBeforeTarget = [...currentIndexes.values()]
    .filter((index) => index >= 0 && index < target.index)
    .length;
  const insertIndex = Math.max(0, target.index - removedBeforeTarget);
  const allFromTargetParent = dragNodeIds.every((nodeId) => input.parentIdForNode(nodeId) === target.parentId);
  const movingLaterInSameParent = allFromTargetParent
    && [...currentIndexes.values()].some((index) => index >= 0 && index < target.index);

  const moves = movingLaterInSameParent
    ? [...dragNodeIds].reverse().map((nodeId, reverseIndex) => ({
      nodeId,
      parentId: target.parentId,
      index: insertIndex + (dragNodeIds.length - 1 - reverseIndex),
    }))
    : dragNodeIds.map((nodeId, index) => ({
      nodeId,
      parentId: target.parentId,
      index: insertIndex + index,
    }));

  return { moves, expandTargetId: target.expandTargetId };
}

function resolveOutlinerDropTarget(input: {
  targetNodeId: NodeId;
  targetParentId: NodeId | null | undefined;
  siblingIndex: number;
  dropPosition: DropHoverPosition | null;
  targetHasChildren: boolean;
  targetIsExpanded: boolean;
}): OutlinerDropMove | null {
  const {
    targetNodeId,
    targetParentId,
    siblingIndex,
    dropPosition,
    targetHasChildren,
    targetIsExpanded,
  } = input;

  if (!targetParentId || siblingIndex < 0) return null;

  if (dropPosition === 'inside') {
    return { parentId: targetNodeId, index: 0, expandTargetId: targetNodeId };
  }
  if (dropPosition === 'after' && targetHasChildren && targetIsExpanded) {
    return { parentId: targetNodeId, index: 0, expandTargetId: undefined };
  }
  return {
    parentId: targetParentId,
    index: siblingIndex + (dropPosition === 'after' ? 1 : 0),
    expandTargetId: undefined,
  };
}
