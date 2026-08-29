import type {
  DocumentProjection,
  NodeProjection,
  ProjectionUpdate,
} from '../../core/types';
import type { TextSearchIndex } from '../../core/textSearchIndex';
import {
  BeforeStateNodeMap,
  DocumentTextSearchIndex,
  SparseOverlayNodeMap,
} from './documentTextSearchIndex';
import { collectDescendantIds } from '../../core/treeUtils';

function projectionViewFrom(projection: DocumentProjection): DocumentProjection {
  return {
    workspaceId: projection.workspaceId,
    rootId: projection.rootId,
    libraryId: projection.libraryId,
    dailyNotesId: projection.dailyNotesId,
    schemaId: projection.schemaId,
    searchesId: projection.searchesId,
    recentsId: projection.recentsId,
    trashId: projection.trashId,
    todayId: projection.todayId,
    nodes: [...projection.nodes],
  };
}

function indexNodes(nodes: readonly NodeProjection[]): {
  nodeIndexById: Map<string, number>;
  nodesById: Map<string, NodeProjection>;
} {
  const nodesById = new Map<string, NodeProjection>();
  const nodeIndexById = new Map<string, number>();
  for (const [index, node] of nodes.entries()) {
    nodesById.set(node.id, node);
    nodeIndexById.set(node.id, index);
  }
  return { nodeIndexById, nodesById };
}

function sortedNodeInsertionIndex(nodes: readonly NodeProjection[], nodeId: string): number {
  let low = 0;
  let high = nodes.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (nodes[mid]!.id < nodeId) low = mid + 1;
    else high = mid;
  }
  return low;
}

export class DocumentReadModel {
  private projectionView: DocumentProjection;
  private nodesById: Map<string, NodeProjection>;
  private nodeIndexById: Map<string, number>;
  private readonly searchIndex: DocumentTextSearchIndex;

  private constructor(
    private currentRevision: number,
    projection: DocumentProjection,
  ) {
    this.projectionView = projectionViewFrom(projection);
    const indexes = indexNodes(this.projectionView.nodes);
    this.nodesById = indexes.nodesById;
    this.nodeIndexById = indexes.nodeIndexById;
    this.searchIndex = new DocumentTextSearchIndex(currentRevision, this.projectionView);
  }

  static fromProjection(revision: number, projection: DocumentProjection): DocumentReadModel {
    return new DocumentReadModel(revision, projection);
  }

  get revision(): number {
    return this.currentRevision;
  }

  get projection(): DocumentProjection {
    return this.projectionView;
  }

  get nodes(): ReadonlyMap<string, NodeProjection> {
    return this.nodesById;
  }

  get textIndex(): TextSearchIndex {
    return this.searchIndex.textIndex;
  }

  node(nodeId: string): NodeProjection | undefined {
    return this.nodesById.get(nodeId);
  }

  applyUpdate(update: ProjectionUpdate): boolean {
    if (update.kind === 'full') {
      this.reseed(update.revision, update.projection);
      return true;
    }
    if (update.revision === this.currentRevision) return true;
    if (update.revision !== this.currentRevision + 1) return false;

    const changedNodeIds = new Set([
      ...update.removedIds,
      ...update.changedNodes.map((node) => node.id),
    ]);
    const beforeValues = new Map<string, NodeProjection | undefined>();
    for (const nodeId of changedNodeIds) beforeValues.set(nodeId, this.nodesById.get(nodeId));

    let membershipChanged = false;
    if (update.removedIds.length > 0) {
      const removedIndexes: number[] = [];
      for (const nodeId of update.removedIds) {
        this.nodesById.delete(nodeId);
        const index = this.nodeIndexById.get(nodeId);
        if (index !== undefined) removedIndexes.push(index);
      }
      if (removedIndexes.length > 0) {
        removedIndexes.sort((left, right) => right - left);
        for (const index of removedIndexes) this.projectionView.nodes.splice(index, 1);
        this.nodeIndexById = indexNodes(this.projectionView.nodes).nodeIndexById;
        membershipChanged = true;
      }
    }

    const addedNodes = new Map<string, NodeProjection>();
    for (const node of update.changedNodes) {
      const index = this.nodeIndexById.get(node.id);
      if (index === undefined) {
        addedNodes.set(node.id, node);
      } else {
        this.projectionView.nodes[index] = node;
      }
      this.nodesById.set(node.id, node);
    }
    for (const node of addedNodes.values()) {
      this.projectionView.nodes.splice(sortedNodeInsertionIndex(this.projectionView.nodes, node.id), 0, node);
      membershipChanged = true;
    }
    if (membershipChanged) this.nodeIndexById = indexNodes(this.projectionView.nodes).nodeIndexById;

    this.projectionView.todayId = update.todayId;
    this.searchIndex.applyDelta(
      update.revision,
      changedNodeIds,
      new BeforeStateNodeMap(this.nodesById, beforeValues),
      this.nodesById,
      this.projectionView,
    );
    this.currentRevision = update.revision;
    return true;
  }

  async applyUpdateYielding(
    update: ProjectionUpdate,
    options: { readonly yieldEveryNodes?: number; readonly yield?: () => Promise<void> } = {},
  ): Promise<boolean> {
    if (update.kind === 'full') {
      this.reseed(update.revision, update.projection);
      return true;
    }
    if (update.revision === this.currentRevision) return true;
    if (update.revision !== this.currentRevision + 1) return false;

    const changes = new Map<string, NodeProjection | undefined>();
    for (const nodeId of update.removedIds) changes.set(nodeId, undefined);
    for (const node of update.changedNodes) changes.set(node.id, node);
    for (const nodeId of update.removedIds) {
      for (const descendantId of collectDescendantIds(this.nodesById, nodeId)) {
        if (!changes.has(descendantId)) changes.set(descendantId, undefined);
      }
    }
    const nextNodes = new SparseOverlayNodeMap(this.nodesById, changes);
    const nextProjection: DocumentProjection = {
      ...this.projectionView,
      todayId: update.todayId,
      nodes: mergeProjectionNodes(this.projectionView.nodes, changes),
    };
    const applied = await this.searchIndex.applyDeltaYielding(
      update.revision,
      new Set(changes.keys()),
      this.nodesById,
      nextNodes,
      nextProjection,
      options,
    );

    for (const [nodeId, node] of changes) {
      if (node) this.nodesById.set(nodeId, node);
      else this.nodesById.delete(nodeId);
    }
    this.projectionView = nextProjection;
    this.nodeIndexById = indexNodes(nextProjection.nodes).nodeIndexById;
    this.currentRevision = update.revision;
    return applied;
  }

  reseed(revision: number, projection: DocumentProjection): void {
    this.currentRevision = revision;
    this.projectionView = projectionViewFrom(projection);
    const indexes = indexNodes(this.projectionView.nodes);
    this.nodesById = indexes.nodesById;
    this.nodeIndexById = indexes.nodeIndexById;
    this.searchIndex.reseed(revision, this.projectionView);
  }
}

function mergeProjectionNodes(
  current: readonly NodeProjection[],
  changes: ReadonlyMap<string, NodeProjection | undefined>,
): NodeProjection[] {
  const additions = new Map(changes);
  const retained: NodeProjection[] = [];
  for (const node of current) {
    if (!changes.has(node.id)) {
      retained.push(node);
      continue;
    }
    const changed = changes.get(node.id);
    if (changed) retained.push(changed);
    additions.delete(node.id);
  }
  const added = [...additions.values()]
    .filter((node): node is NodeProjection => Boolean(node))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const merged: NodeProjection[] = [];
  let retainedIndex = 0;
  let addedIndex = 0;
  while (retainedIndex < retained.length || addedIndex < added.length) {
    const retainedNode = retained[retainedIndex];
    const addedNode = added[addedIndex];
    if (!addedNode || (retainedNode && retainedNode.id < addedNode.id)) {
      merged.push(retainedNode!);
      retainedIndex += 1;
    } else {
      merged.push(addedNode);
      addedIndex += 1;
    }
  }
  return merged;
}
