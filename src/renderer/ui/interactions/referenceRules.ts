import type { NodeId, NodeProjection } from '../../api/types';
import { isContentNode } from '../shared';

export type TreeReferenceBlockReason =
  | 'missing_parent'
  | 'missing_target'
  | 'self_parent'
  | 'would_create_display_cycle';

function effectiveNodeId(
  nodeId: NodeId,
  byId: Map<NodeId, NodeProjection>,
): NodeId | null {
  const node = byId.get(nodeId);
  if (!node) return null;
  if (node.type === 'reference' && node.targetId) return effectiveNodeId(node.targetId, byId);
  return nodeId;
}

function canReachInDisplayGraph(
  fromEffectiveNodeId: NodeId,
  targetEffectiveNodeId: NodeId,
  byId: Map<NodeId, NodeProjection>,
): boolean {
  const visited = new Set<NodeId>();
  const stack: NodeId[] = [fromEffectiveNodeId];
  while (stack.length > 0) {
    const currentId = stack.pop();
    if (!currentId || visited.has(currentId)) continue;
    visited.add(currentId);
    const current = byId.get(currentId);
    if (!current) continue;
    for (const childId of current.children) {
      const child = byId.get(childId);
      if (!child) continue;
      const nextEffectiveId = child.type === 'reference' && child.targetId
        ? effectiveNodeId(child.targetId, byId)
        : isContentNode(child)
          ? child.id
          : null;
      if (!nextEffectiveId) continue;
      if (nextEffectiveId === targetEffectiveNodeId) return true;
      if (!visited.has(nextEffectiveId)) stack.push(nextEffectiveId);
    }
  }
  return false;
}

export function getTreeReferenceBlockReason(params: {
  parentId: NodeId;
  targetId: NodeId;
  byId: Map<NodeId, NodeProjection>;
}): TreeReferenceBlockReason | null {
  const { parentId, targetId, byId } = params;
  if (!parentId || !byId.has(parentId)) return 'missing_parent';
  if (!targetId || !byId.has(targetId)) return 'missing_target';
  const effectiveTargetId = effectiveNodeId(targetId, byId);
  if (!effectiveTargetId || !byId.has(effectiveTargetId)) return 'missing_target';
  if (parentId === effectiveTargetId) return 'self_parent';
  if (canReachInDisplayGraph(effectiveTargetId, parentId, byId)) {
    return 'would_create_display_cycle';
  }
  return null;
}

export function getTreeReferenceBlockMessage(reason: TreeReferenceBlockReason | null): string | null {
  if (!reason) return null;
  if (reason === 'self_parent') return 'Cannot reference this node here';
  if (reason === 'would_create_display_cycle') return 'Would create a display cycle';
  return 'Unavailable here';
}
