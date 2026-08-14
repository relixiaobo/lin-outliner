import type { NodeId, NodeProjection } from '../api/types';
import type { DocumentIndex } from './document';
import type {
  EffectiveNodeResolution,
  TreeReferenceReachability,
} from '../ui/interactions/referenceRules';

export interface DisplayReachabilityResult extends TreeReferenceReachability {
  readonly graphNodesVisited: number;
}

const reachabilityCache = new WeakMap<object, Map<NodeId, Promise<DisplayReachabilityResult>>>();
const BUILD_CHUNK_SIZE = 128;

export function displayReachabilityForParent(
  index: DocumentIndex,
  parentId: NodeId,
): Promise<DisplayReachabilityResult> {
  const cacheKey = index.displayGraphCacheKey ?? index;
  let byParent = reachabilityCache.get(cacheKey);
  if (!byParent) {
    byParent = new Map();
    reachabilityCache.set(cacheKey, byParent);
  }
  const cached = byParent.get(parentId);
  if (cached) return cached;
  const pending = buildDisplayReachability(index.byId, parentId);
  byParent.set(parentId, pending);
  return pending;
}

async function buildDisplayReachability(
  byId: Map<NodeId, NodeProjection>,
  parentId: NodeId,
): Promise<DisplayReachabilityResult> {
  await yieldToRenderer();
  const effectiveNodeIds = new Map<NodeId, EffectiveNodeResolution>();
  const reverseDisplayEdges = new Map<NodeId, Set<NodeId>>();
  const cyclicParents = new Set<NodeId>();
  let graphNodesVisited = 0;

  const nodes = byId.values();
  let childParent: NodeProjection | null = null;
  let childIndex = 0;
  let exhausted = false;
  while (!exhausted) {
    for (let count = 0; count < BUILD_CHUNK_SIZE; count += 1) {
      if (childParent) {
        const childId = childParent.children[childIndex++]!;
        const child = byId.get(childId);
        if (child) {
          const resolution = child.type === 'reference' && child.targetId
            ? resolveEffectiveNodeIdCached(child.targetId, byId, effectiveNodeIds)
            : isDisplayContentNode(child)
              ? { ok: true as const, nodeId: child.id }
              : null;
          if (resolution) {
            if (!resolution.ok) {
              if (resolution.reason === 'would_create_display_cycle') cyclicParents.add(childParent.id);
            } else {
              const parents = reverseDisplayEdges.get(resolution.nodeId) ?? new Set<NodeId>();
              parents.add(childParent.id);
              reverseDisplayEdges.set(resolution.nodeId, parents);
            }
          }
        }
        if (childIndex >= childParent.children.length) childParent = null;
        continue;
      }
      const next = nodes.next();
      if (next.done) {
        exhausted = true;
        break;
      }
      const node = next.value;
      graphNodesVisited += 1;
      if (isDisplayContentNode(node) && node.children.length > 0) {
        childParent = node;
        childIndex = 0;
      }
    }
    if (!exhausted) await yieldToRenderer();
  }

  const directAlreadyEffectiveNodeIds = new Set<NodeId>();
  let directChildCycle = false;
  const parent = byId.get(parentId);
  const directChildren = parent?.children ?? [];
  for (let index = 0; index < directChildren.length; index += 1) {
    const childId = directChildren[index]!;
    const resolution = resolveEffectiveNodeIdCached(childId, byId, effectiveNodeIds);
    if (!resolution.ok) {
      if (resolution.reason === 'would_create_display_cycle') directChildCycle = true;
      break;
    }
    directAlreadyEffectiveNodeIds.add(resolution.nodeId);
    if ((index + 1) % BUILD_CHUNK_SIZE === 0 && index + 1 < directChildren.length) {
      await yieldToRenderer();
    }
  }

  const reachesParentEffectiveNodeIds = await reverseReachableSet(
    reverseDisplayEdges,
    [parentId],
    () => { graphNodesVisited += 1; },
  );
  reachesParentEffectiveNodeIds.delete(parentId);
  const cyclicEffectiveNodeIds = await reverseReachableSet(
    reverseDisplayEdges,
    cyclicParents,
    () => { graphNodesVisited += 1; },
  );

  return {
    cyclicEffectiveNodeIds,
    directAlreadyEffectiveNodeIds,
    directChildCycle,
    effectiveNodeIds,
    graphNodesVisited,
    parentId,
    reachesParentEffectiveNodeIds,
  };
}

function resolveEffectiveNodeIdCached(
  nodeId: NodeId,
  byId: ReadonlyMap<NodeId, NodeProjection>,
  cache: Map<NodeId, EffectiveNodeResolution>,
): EffectiveNodeResolution {
  const cached = cache.get(nodeId);
  if (cached) return cached;

  const path: NodeId[] = [];
  const pathIndexes = new Map<NodeId, number>();
  let currentId: NodeId | undefined = nodeId;
  let result: EffectiveNodeResolution;
  while (currentId) {
    const resolved = cache.get(currentId);
    if (resolved) {
      result = resolved;
      break;
    }
    if (pathIndexes.has(currentId)) {
      result = { ok: false, reason: 'would_create_display_cycle' };
      break;
    }
    pathIndexes.set(currentId, path.length);
    path.push(currentId);
    const node = byId.get(currentId);
    if (!node) {
      result = { ok: false, reason: 'missing_target' };
      break;
    }
    if (node.type === 'reference' && node.targetId) {
      currentId = node.targetId;
      continue;
    }
    result = { ok: true, nodeId: currentId };
    break;
  }
  result ??= { ok: false, reason: 'missing_target' };
  for (const pathId of path) cache.set(pathId, result);
  return result;
}

async function reverseReachableSet(
  reverseEdges: ReadonlyMap<NodeId, ReadonlySet<NodeId>>,
  roots: Iterable<NodeId>,
  visit: () => void,
): Promise<Set<NodeId>> {
  const reachable = new Set<NodeId>();
  const stack = [...roots];
  while (stack.length > 0) {
    for (let count = 0; count < BUILD_CHUNK_SIZE && stack.length > 0; count += 1) {
      const nodeId = stack.pop()!;
      if (reachable.has(nodeId)) continue;
      reachable.add(nodeId);
      visit();
      for (const sourceId of reverseEdges.get(nodeId) ?? []) {
        if (!reachable.has(sourceId)) stack.push(sourceId);
      }
    }
    if (stack.length > 0) await yieldToRenderer();
  }
  return reachable;
}

function isDisplayContentNode(node: NodeProjection | undefined): node is NodeProjection {
  return Boolean(node && (!node.type || node.type === 'codeBlock'));
}

function yieldToRenderer(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
