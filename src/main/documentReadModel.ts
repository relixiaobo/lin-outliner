import type {
  DocumentProjection,
  NodeProjection,
  ProjectionUpdate,
} from '../core/types';
import type { ProjectionIndex } from './agentNodeToolTypes';

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

  private constructor(
    private currentRevision: number,
    projection: DocumentProjection,
  ) {
    this.projectionView = projectionViewFrom(projection);
    const indexes = indexNodes(this.projectionView.nodes);
    this.nodesById = indexes.nodesById;
    this.nodeIndexById = indexes.nodeIndexById;
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

  get nodes(): Map<string, NodeProjection> {
    return this.nodesById;
  }

  node(nodeId: string): NodeProjection | undefined {
    return this.nodesById.get(nodeId);
  }

  asProjectionIndex(): ProjectionIndex {
    return {
      projection: this.projectionView,
      nodes: this.nodesById,
    };
  }

  applyUpdate(update: ProjectionUpdate): boolean {
    if (update.kind === 'full') {
      this.reseed(update.revision, update.projection);
      return true;
    }
    if (update.revision === this.currentRevision) return true;
    if (update.revision !== this.currentRevision + 1) return false;

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
    this.currentRevision = update.revision;
    return true;
  }

  reseed(revision: number, projection: DocumentProjection): void {
    this.currentRevision = revision;
    this.projectionView = projectionViewFrom(projection);
    const indexes = indexNodes(this.projectionView.nodes);
    this.nodesById = indexes.nodesById;
    this.nodeIndexById = indexes.nodeIndexById;
  }
}
