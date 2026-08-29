import { memoryTagId } from '../../../../core/agent/memory';
import {
  TAG_DAY_ID,
  isContentBearingNode,
  type DocumentProjection,
  type NodeId,
  type NodeProjection,
  type ProjectionUpdate,
} from '../../../../core/types';
import { collectDescendantIds } from '../../../../core/treeUtils';
import {
  canonicalMemoryGraph,
  canonicalMemoryContainerAncestorFromIndex,
  canonicalMemoryNodeFromIndex,
  timelineNodeFingerprint,
  type CanonicalMemoryNode,
} from './TimelineMemoryStore';

export interface MemoryMutationIndexDelta {
  readonly changedNodes: readonly NodeProjection[];
  readonly removedIds: readonly NodeId[];
}

export interface MemoryMutationIndexUpdate {
  readonly affectedCanonicalNodeIds: ReadonlySet<NodeId>;
  readonly fullRebuild: boolean;
}

const HIERARCHY_TAG_IDS: ReadonlySet<NodeId> = new Set([
  TAG_DAY_ID,
  memoryTagId('memory'),
  memoryTagId('episode'),
]);

export class MemoryMutationIndex {
  private nodes = new Map<NodeId, NodeProjection>();
  private readonly owned = new Set<NodeId>();
  private readonly canonicalById = new Map<NodeId, CanonicalMemoryNode>();
  private readonly canonicalDependenciesById = new Map<NodeId, readonly NodeId[]>();
  private readonly canonicalDependentsByAncestor = new Map<NodeId, Set<NodeId>>();
  private fullRebuilds = 0;
  private currentRevision = 0;

  constructor(projection: DocumentProjection) {
    this.rebuild(projection);
  }

  fullRebuildCount(): number {
    return this.fullRebuilds;
  }

  revision(): number {
    return this.currentRevision;
  }

  applyProjectionUpdate(update: ProjectionUpdate): MemoryMutationIndexUpdate {
    if (update.kind === 'full') {
      const affected = new Set<NodeId>(this.canonicalById.keys());
      this.rebuild(update.projection);
      for (const nodeId of this.canonicalById.keys()) affected.add(nodeId);
      return { affectedCanonicalNodeIds: affected, fullRebuild: true };
    }
    return this.applyDelta(update);
  }

  canonicalNode(nodeId: NodeId): CanonicalMemoryNode | undefined {
    return this.canonicalById.get(nodeId);
  }

  allCanonicalNodeIds(): ReadonlySet<NodeId> {
    return new Set(this.canonicalById.keys());
  }

  expandReferences(nodeIds: ReadonlySet<NodeId>): ReadonlySet<NodeId> {
    const expanded = new Set<NodeId>();
    for (const nodeId of nodeIds) {
      expanded.add(nodeId);
      for (const descendantId of collectDescendantIds(this.nodes, nodeId)) expanded.add(descendantId);
      for (const ancestorId of ancestorIds(nodeId, this.nodes)) expanded.add(ancestorId);
    }
    return expanded;
  }

  canonicalNodesInGraphOrder(): readonly CanonicalMemoryNode[] {
    const containers = [...this.canonicalById.values()]
      .filter((entry) => entry.category === 'memory')
      .sort((left, right) => left.node.id.localeCompare(right.node.id));
    const ordered: CanonicalMemoryNode[] = [];
    for (const container of containers) {
      ordered.push(container);
      for (const episodeId of container.node.children) {
        const episode = this.canonicalById.get(episodeId);
        if (
          !episode
          || episode.category !== 'episode'
          || episode.containerId !== container.node.id
        ) continue;
        ordered.push(episode);
        const queue = [...episode.node.children];
        const visited = new Set<NodeId>();
        while (queue.length > 0) {
          const nodeId = queue.shift()!;
          if (visited.has(nodeId)) continue;
          visited.add(nodeId);
          const node = this.nodes.get(nodeId);
          if (!node) continue;
          queue.push(...node.children);
          const entry = this.canonicalById.get(nodeId);
          if (
            entry
            && entry.category !== 'memory'
            && entry.category !== 'episode'
            && entry.containerId === container.node.id
            && entry.episodeId === episode.node.id
          ) ordered.push(entry);
        }
      }
    }
    return ordered;
  }

  debugSnapshot(): {
    readonly owned: readonly NodeId[];
    readonly canonical: readonly NodeId[];
    readonly canonicalFingerprints: readonly (readonly [NodeId, string])[];
  } {
    return {
      owned: [...this.owned].sort(),
      canonical: [...this.canonicalById.keys()].sort(),
      canonicalFingerprints: [...this.canonicalById]
        .map(([nodeId, entry]) => [nodeId, timelineNodeFingerprint(entry)] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    };
  }

  private rebuild(projection: DocumentProjection): void {
    this.nodes = new Map(projection.nodes.map((node) => [node.id, node]));
    this.owned.clear();
    this.canonicalById.clear();
    this.canonicalDependenciesById.clear();
    this.canonicalDependentsByAncestor.clear();

    const graph = canonicalMemoryGraph(projection);
    for (const container of graph.containers) {
      for (const nodeId of nodeAndDescendantIds(this.nodes, container.node.id)) this.owned.add(nodeId);
    }
    for (const entry of graph.nodes) this.addCanonicalEntry(entry);
    this.fullRebuilds += 1;
    this.currentRevision += 1;
  }

  private applyDelta(delta: MemoryMutationIndexDelta): MemoryMutationIndexUpdate {
    if (delta.changedNodes.length === 0 && delta.removedIds.length === 0) {
      return { affectedCanonicalNodeIds: new Set(), fullRebuild: false };
    }
    const changedById = new Map(delta.changedNodes.map((node) => [node.id, node]));
    const directIds = new Set<NodeId>([...changedById.keys(), ...delta.removedIds]);
    const subtreeRoots = new Set<NodeId>();
    const affectedNodeIds = new Set<NodeId>(directIds);
    const affectedCanonicalNodeIds = this.canonicalDependents(directIds);

    for (const nodeId of directIds) {
      const before = this.nodes.get(nodeId);
      const after = changedById.get(nodeId);
      if (subtreeIdentityChanged(before, after)) subtreeRoots.add(nodeId);
      for (const childId of changedChildIds(before, after)) subtreeRoots.add(childId);
    }
    for (const rootId of subtreeRoots) {
      for (const nodeId of nodeAndDescendantIds(this.nodes, rootId)) affectedNodeIds.add(nodeId);
    }

    for (const nodeId of delta.removedIds) this.nodes.delete(nodeId);
    for (const node of delta.changedNodes) this.nodes.set(node.id, node);

    for (const rootId of subtreeRoots) {
      for (const nodeId of nodeAndDescendantIds(this.nodes, rootId)) affectedNodeIds.add(nodeId);
    }
    for (const nodeId of affectedNodeIds) this.removeDerivedState(nodeId);
    for (const nodeId of affectedNodeIds) {
      const node = this.nodes.get(nodeId);
      if (node) this.addDerivedState(node);
    }
    for (const nodeId of this.canonicalDependents(directIds)) affectedCanonicalNodeIds.add(nodeId);
    for (const nodeId of directIds) affectedCanonicalNodeIds.add(nodeId);
    this.currentRevision += 1;

    return { affectedCanonicalNodeIds, fullRebuild: false };
  }

  private addDerivedState(node: NodeProjection): void {
    if (this.canonicalContainerAncestor(node.id)) this.owned.add(node.id);
    if (!isContentBearingNode(node)) return;
    const canonical = canonicalMemoryNodeFromIndex(node, this.nodes);
    if (canonical) this.addCanonicalEntry(canonical);
  }

  private removeDerivedState(nodeId: NodeId): void {
    this.owned.delete(nodeId);
    this.removeCanonicalEntry(nodeId);
  }

  private addCanonicalEntry(entry: CanonicalMemoryNode): void {
    this.canonicalById.set(entry.node.id, entry);
    const dependencies = [entry.node.id, ...ancestorIds(entry.node.id, this.nodes)];
    this.canonicalDependenciesById.set(entry.node.id, dependencies);
    for (const ancestorId of dependencies) addToSetMap(this.canonicalDependentsByAncestor, ancestorId, entry.node.id);
  }

  private removeCanonicalEntry(nodeId: NodeId): void {
    this.canonicalById.delete(nodeId);
    const dependencies = this.canonicalDependenciesById.get(nodeId);
    if (!dependencies) return;
    for (const ancestorId of dependencies) removeFromSetMap(this.canonicalDependentsByAncestor, ancestorId, nodeId);
    this.canonicalDependenciesById.delete(nodeId);
  }

  private canonicalDependents(nodeIds: Iterable<NodeId>): Set<NodeId> {
    const dependents = new Set<NodeId>();
    for (const nodeId of nodeIds) {
      for (const dependentId of this.canonicalDependentsByAncestor.get(nodeId) ?? []) dependents.add(dependentId);
    }
    return dependents;
  }

  private canonicalContainerAncestor(nodeId: NodeId): NodeProjection | null {
    const node = this.nodes.get(nodeId);
    return node ? canonicalMemoryContainerAncestorFromIndex(node, this.nodes)?.node ?? null : null;
  }

}

function subtreeIdentityChanged(before: NodeProjection | undefined, after: NodeProjection | undefined): boolean {
  if (!before || !after) return true;
  if (before.parentId !== after.parentId) return true;
  if (!isContentBearingNode(before) || !isContentBearingNode(after)) return false;
  if (before.content.text !== after.content.text && (before.tags.includes(TAG_DAY_ID) || after.tags.includes(TAG_DAY_ID))) {
    return true;
  }
  return !sameFilteredTags(before.tags, after.tags, HIERARCHY_TAG_IDS);
}

function changedChildIds(before: NodeProjection | undefined, after: NodeProjection | undefined): NodeId[] {
  const beforeChildren = new Set(before?.children ?? []);
  const afterChildren = new Set(after?.children ?? []);
  return [...beforeChildren, ...afterChildren].filter((nodeId) => beforeChildren.has(nodeId) !== afterChildren.has(nodeId));
}

function sameFilteredTags(
  before: readonly string[],
  after: readonly string[],
  relevant: ReadonlySet<string>,
): boolean {
  const beforeRelevant = before.filter((tagId) => relevant.has(tagId));
  const afterRelevant = after.filter((tagId) => relevant.has(tagId));
  if (beforeRelevant.length !== afterRelevant.length) return false;
  return beforeRelevant.every((tagId) => afterRelevant.includes(tagId));
}

function nodeAndDescendantIds(nodes: ReadonlyMap<NodeId, NodeProjection>, rootId: NodeId): Set<NodeId> {
  return new Set([rootId, ...collectDescendantIds(nodes, rootId)]);
}

function ancestorIds(nodeId: NodeId, nodes: ReadonlyMap<NodeId, NodeProjection>): NodeId[] {
  const ancestors: NodeId[] = [];
  const visited = new Set<NodeId>([nodeId]);
  let current = nodes.get(nodeId);
  while (current?.parentId && !visited.has(current.parentId)) {
    ancestors.push(current.parentId);
    visited.add(current.parentId);
    current = nodes.get(current.parentId);
  }
  return ancestors;
}

function addToSetMap<Key, Value>(map: Map<Key, Set<Value>>, key: Key, value: Value): void {
  const values = map.get(key);
  if (values) values.add(value);
  else map.set(key, new Set([value]));
}

function removeFromSetMap<Key, Value>(map: Map<Key, Set<Value>>, key: Key, value: Value): void {
  const values = map.get(key);
  if (!values) return;
  values.delete(value);
  if (values.size === 0) map.delete(key);
}
