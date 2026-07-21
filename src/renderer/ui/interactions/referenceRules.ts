import type { NodeId, NodeProjection } from '../../api/types';
import { isContentNode } from '../shared';

export type TreeReferenceBlockReason =
  | 'missing_parent'
  | 'missing_target'
  | 'self_parent'
  | 'already_in_parent'
  | 'would_create_display_cycle';

const MAX_EFFECTIVE_REFERENCE_HOPS = 1_024;
const MAX_DISPLAY_GRAPH_VISITS = 10_000;

type EffectiveNodeResolution =
  | { ok: true; nodeId: NodeId }
  | { ok: false; reason: Extract<TreeReferenceBlockReason, 'missing_target' | 'would_create_display_cycle'> };

function resolveEffectiveNodeId(
  nodeId: NodeId,
  byId: Map<NodeId, NodeProjection>,
): EffectiveNodeResolution {
  let currentId: NodeId | undefined = nodeId;
  const visited = new Set<NodeId>();
  let hops = 0;

  while (currentId) {
    if (visited.has(currentId) || hops >= MAX_EFFECTIVE_REFERENCE_HOPS) {
      return { ok: false, reason: 'would_create_display_cycle' };
    }
    visited.add(currentId);
    hops += 1;

    const node = byId.get(currentId);
    if (!node) return { ok: false, reason: 'missing_target' };
    if (node.type === 'reference' && node.targetId) {
      currentId = node.targetId;
      continue;
    }
    return { ok: true, nodeId: currentId };
  }
  return { ok: false, reason: 'missing_target' };
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
    if (visited.size > MAX_DISPLAY_GRAPH_VISITS) return true;
    const current = byId.get(currentId);
    if (!current) continue;
    for (const childId of current.children) {
      const child = byId.get(childId);
      if (!child) continue;
      let nextEffectiveId: NodeId | null = null;
      if (child.type === 'reference' && child.targetId) {
        const resolved = resolveEffectiveNodeId(child.targetId, byId);
        if (!resolved.ok) {
          if (resolved.reason === 'would_create_display_cycle') return true;
          continue;
        }
        nextEffectiveId = resolved.nodeId;
      } else if (isContentNode(child)) {
        nextEffectiveId = child.id;
      }
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
  const effectiveTarget = resolveEffectiveNodeId(targetId, byId);
  if (!effectiveTarget.ok) return effectiveTarget.reason;
  const effectiveTargetId = effectiveTarget.nodeId;
  if (!byId.has(effectiveTargetId)) return 'missing_target';
  if (parentId === effectiveTargetId) return 'self_parent';
  const parent = byId.get(parentId);
  for (const childId of parent?.children ?? []) {
    const childEffective = resolveEffectiveNodeId(childId, byId);
    if (!childEffective.ok) {
      if (childEffective.reason === 'would_create_display_cycle') return 'would_create_display_cycle';
      continue;
    }
    if (childEffective.nodeId === effectiveTargetId) return 'already_in_parent';
  }
  if (canReachInDisplayGraph(effectiveTargetId, parentId, byId)) {
    return 'would_create_display_cycle';
  }
  return null;
}

export function getTreeReferenceBlockMessage(reason: TreeReferenceBlockReason | null): string | null {
  if (!reason) return null;
  if (reason === 'self_parent') return 'Cannot reference this node here';
  if (reason === 'already_in_parent') return 'Already in this list';
  if (reason === 'would_create_display_cycle') return 'Would create a display cycle';
  return 'Unavailable here';
}
