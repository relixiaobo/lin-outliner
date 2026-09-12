import { decodeProfileResetTarget, type ProfileResetTarget } from '../../profile/ProfileFileStore';
import type { MemoryResetReview } from '../../../../core/agent/memoryOperations';
import type { DocumentProjection, NodeProjection } from '../../../../core/types';
import { AgentToolFailure } from '../../AgentToolFailure';
import { canonicalMemoryGraph, timelineDigest } from './TimelineMemoryStore';

export interface MemoryResetTarget {
  readonly profile?: ProfileResetTarget;
  readonly version: 1;
  readonly workspaceId: string;
  readonly rootId: string;
  readonly resetEpoch: number;
  readonly containerIds: readonly string[];
  readonly nodeCount: number;
  readonly ordinaryNodeCount: number;
  readonly fingerprint: string;
}

/** Host-private evidence. Only aggregate counts reach the native review. */
export function captureMemoryResetTarget(projection: DocumentProjection, resetEpoch: number): MemoryResetTarget {
  if (!isCount(resetEpoch) || !isIdentity(projection.workspaceId) || !isIdentity(projection.rootId)) throw invalidTarget();
  const index = new Map<string, NodeProjection>();
  const childrenByParent = new Map<string, Set<string>>();
  for (const node of projection.nodes) {
    if (index.has(node.id)) throw unavailableTarget();
    index.set(node.id, node);
    if (node.parentId) {
      const children = childrenByParent.get(node.parentId) ?? new Set<string>();
      children.add(node.id);
      childrenByParent.set(node.parentId, children);
    }
  }
  if (!index.has(projection.rootId)) throw unavailableTarget();
  const graph = canonicalMemoryGraph(projection);
  const containerIds = graph.containers.map((entry) => entry.node.id).sort();
  const canonicalIds = new Set(graph.nodes.map((entry) => entry.node.id));
  const owned = new Set<string>();
  const pending = [...containerIds];
  let ordinaryNodeCount = 0;
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (owned.has(id)) throw unavailableTarget();
    const node = index.get(id);
    if (!node) throw unavailableTarget();
    owned.add(id);
    if (!canonicalIds.has(id)) ordinaryNodeCount += 1;
    const childIds = new Set(node.children);
    const reverseChildren = childrenByParent.get(id) ?? new Set<string>();
    if (childIds.size !== node.children.length || childIds.size !== reverseChildren.size
      || [...childIds].some((childId) => !reverseChildren.has(childId))) throw unavailableTarget();
    for (const childId of node.children) pending.push(childId);
  }

  // Ancestor identity matters; unrelated siblings and ancestor display changes do not.
  const containers = graph.containers.map((entry) => ({
    id: entry.node.id,
    sourceDate: entry.sourceDate,
    ancestors: ancestry(entry.node, index, projection.rootId),
  })).sort((left, right) => left.id.localeCompare(right.id));
  const nodeFingerprints = [...owned].sort().map((id) => {
    // Match the JSON projection restored after restart, including absent optional fields.
    const persistedNode = JSON.parse(JSON.stringify(index.get(id)));
    return [id, timelineDigest(persistedNode)];
  });
  const target = {
    version: 1 as const,
    workspaceId: projection.workspaceId,
    rootId: projection.rootId,
    resetEpoch,
    containerIds: Object.freeze(containerIds),
    nodeCount: owned.size,
    ordinaryNodeCount,
  };
  return Object.freeze({ ...target, fingerprint: timelineDigest({ ...target, containers, nodeFingerprints }) });
}

export function memoryResetReview(target: MemoryResetTarget): MemoryResetReview {
  return Object.freeze({
    resetEpoch: target.resetEpoch,
    containerCount: target.containerIds.length,
    nodeCount: target.nodeCount,
    ordinaryNodeCount: target.ordinaryNodeCount,
    ...(target.profile ? { profileEntryCount: target.profile.keys.length } : {}),
  });
}

export function requireMatchingMemoryResetTarget(
  projection: DocumentProjection,
  resetEpoch: number,
  expected: MemoryResetTarget,
): void {
  const target = decodeMemoryResetTarget(expected);
  const current = captureMemoryResetTarget(projection, resetEpoch);
  const { profile: _profile, ...nodeTarget } = target;
  if (timelineDigest(current) !== timelineDigest(nodeTarget)) {
    throw new AgentToolFailure('stale_memory_reset', 'Memory changed after the Reset review.', 'Review Memory again before requesting a new Reset.');
  }
}

export function decodeMemoryResetTarget(value: unknown): MemoryResetTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidTarget();
  const record = value as Record<string, unknown>;
  const keys = ['version', 'workspaceId', 'rootId', 'resetEpoch', 'containerIds', 'nodeCount', 'ordinaryNodeCount', 'fingerprint', 'profile'];
  if (Object.keys(record).some((key) => !keys.includes(key)) || keys.filter((key) => key !== 'profile').some((key) => !Object.hasOwn(record, key))
    || record.version !== 1 || !isIdentity(record.workspaceId) || !isIdentity(record.rootId)
    || !isCount(record.resetEpoch) || !isCount(record.nodeCount) || !isCount(record.ordinaryNodeCount)
    || !Array.isArray(record.containerIds) || !record.containerIds.every(isIdentity)
    || record.containerIds.some((id, position, ids) => position > 0 && id <= ids[position - 1]!)
    || record.containerIds.length > record.nodeCount || record.ordinaryNodeCount > record.nodeCount - record.containerIds.length
    || (record.containerIds.length === 0 && record.nodeCount !== 0)
    || typeof record.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(record.fingerprint)) throw invalidTarget();
  return Object.freeze({
    version: 1,
    ...(record.profile === undefined ? {} : { profile: decodeProfileResetTarget(record.profile) }),
    workspaceId: record.workspaceId,
    rootId: record.rootId,
    resetEpoch: record.resetEpoch,
    containerIds: Object.freeze([...record.containerIds] as string[]),
    nodeCount: record.nodeCount,
    ordinaryNodeCount: record.ordinaryNodeCount,
    fingerprint: record.fingerprint,
  });
}

function ancestry(node: NodeProjection, index: ReadonlyMap<string, NodeProjection>, rootId: string): string[] {
  const ancestors: string[] = [];
  const visited = new Set([node.id]);
  let child = node;
  while (child.id !== rootId) {
    const parent = child.parentId ? index.get(child.parentId) : undefined;
    if (!parent || visited.has(parent.id) || parent.children.filter((id) => id === child.id).length !== 1) {
      throw unavailableTarget();
    }
    visited.add(parent.id);
    ancestors.push(parent.id);
    child = parent;
  }
  return ancestors;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}
function invalidTarget(): AgentToolFailure {
  return new AgentToolFailure('invalid_memory_reset', 'The Memory Reset target is invalid.', 'Do not replay an invalid Reset target. Inspect Memory and request a new review.');
}
function unavailableTarget(): AgentToolFailure {
  return new AgentToolFailure('memory_target_unavailable', 'The Memory Reset tree is inconsistent.', 'No Reset was admitted. Inspect the document before requesting another review.');
}
