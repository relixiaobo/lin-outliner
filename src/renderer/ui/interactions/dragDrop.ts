import type { BatchMoveNodeInput, NodeId } from '../../api/types';
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
  moves: BatchMoveNodeInput[];
  expandTargetId?: NodeId;
}

export interface OptimisticBatchMovePlacement {
  id: NodeId;
  sourceParentId: NodeId;
  targetParentId: NodeId;
  beforeId?: NodeId;
  afterId?: NodeId;
}

export interface OutlinerDropAnchor {
  readonly targetNodeId: NodeId;
  readonly targetParentId: NodeId;
  readonly siblingIndex: number;
}

export const OUTLINER_NODE_DRAG_MIME = 'application/x-lin-outliner-node-id';

/** Set while dragging an already-pinned sidebar node to reorder it within the
 *  pinned list (distinct from OUTLINER_NODE_DRAG_MIME, which adds a new pin). */
export const PINNED_NODE_REORDER_MIME = 'application/x-lin-pinned-node-id';

/** Set while dragging a workspace pane by its breadcrumb header to reorder the
 *  canvas panes left/right. Carries the pane id. */
export const WORKSPACE_PANEL_REORDER_MIME = 'application/x-lin-workspace-panel-id';

export function resolveOutlinerDropAnchor(input: {
  readonly rowId: NodeId;
  readonly backingNodeId?: NodeId;
  readonly parentId: NodeId;
  readonly siblingIds: readonly NodeId[];
  readonly draft?: boolean;
}): OutlinerDropAnchor {
  const targetNodeId = input.backingNodeId ?? input.rowId;
  return {
    targetNodeId,
    targetParentId: input.parentId,
    siblingIndex: input.draft ? input.siblingIds.length : input.siblingIds.indexOf(targetNodeId),
  };
}

/** Remove-then-insert list reorder shared by pinned-node and pane reordering
 *  (and the pane drag's arrangement preview, so preview and commit can never
 *  disagree): `insertIndex` is interpreted against the CURRENT list, so a move
 *  lands exactly where the insertion point showed. An absent item is inserted.
 *  Returns the input list object when the move is a no-op. */
export function listWithItemMovedToIndex<T>(list: readonly T[], item: T, insertIndex: number): readonly T[] {
  const currentIndex = list.indexOf(item);
  const without = list.filter((entry) => entry !== item);
  let target = insertIndex;
  if (currentIndex !== -1 && currentIndex < insertIndex) target -= 1;
  target = Math.max(0, Math.min(target, without.length));
  if (currentIndex === target && currentIndex !== -1) return list;
  return [...without.slice(0, target), item, ...without.slice(target)];
}

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

export function optimisticBatchMovePlacements(input: {
  moves: readonly BatchMoveNodeInput[];
  parentIdForNode: (nodeId: NodeId) => NodeId | null | undefined;
  childrenForParent: (parentId: NodeId) => readonly NodeId[];
}): OptimisticBatchMovePlacement[] {
  const movedIds = new Set(input.moves.map((move) => move.nodeId));
  const initialParents = new Map<NodeId, NodeId>();
  const currentParents = new Map<NodeId, NodeId>();
  const children = new Map<NodeId, NodeId[]>();
  const mutableChildren = (parentId: NodeId) => {
    const existing = children.get(parentId);
    if (existing) return existing;
    const next = [...input.childrenForParent(parentId)];
    children.set(parentId, next);
    return next;
  };
  for (const move of input.moves) {
    const sourceParentId = currentParents.get(move.nodeId) ?? input.parentIdForNode(move.nodeId);
    if (!sourceParentId) continue;
    if (!initialParents.has(move.nodeId)) initialParents.set(move.nodeId, sourceParentId);
    const sourceChildren = mutableChildren(sourceParentId);
    const sourceIndex = sourceChildren.indexOf(move.nodeId);
    if (sourceIndex >= 0) sourceChildren.splice(sourceIndex, 1);
    const targetChildren = mutableChildren(move.parentId);
    const targetIndex = typeof move.index === 'number'
      ? Math.max(0, Math.min(move.index, targetChildren.length))
      : targetChildren.length;
    targetChildren.splice(targetIndex, 0, move.nodeId);
    currentParents.set(move.nodeId, move.parentId);
  }

  const placements: OptimisticBatchMovePlacement[] = [];
  for (const [targetParentId, finalChildren] of children) {
    for (let index = 0; index < finalChildren.length; index += 1) {
      const id = finalChildren[index]!;
      const sourceParentId = initialParents.get(id);
      if (!sourceParentId || !movedIds.has(id)) continue;
      const previousId = finalChildren[index - 1];
      const nextUnmovedId = finalChildren.slice(index + 1).find((candidate) => !movedIds.has(candidate));
      placements.push({
        id,
        sourceParentId,
        targetParentId,
        ...(previousId ? { afterId: previousId } : nextUnmovedId ? { beforeId: nextUnmovedId } : {}),
      });
    }
  }
  return placements;
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
