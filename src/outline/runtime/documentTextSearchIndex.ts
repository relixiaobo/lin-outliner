import {
  buildTextSearchRecordSnapshot,
  textSearchRecordForNodeMap,
  type NodeTextSearchRecord,
} from '../../core/searchEngine';
import { addToSetMap, removeFromSetMap } from '../../core/setUtils';
import { createTextSearchIndex, type MutableTextSearchIndex, type TextSearchIndex } from '../../core/textSearchIndex';
import { collectDescendantIds, nodeIsInSubtree } from '../../core/treeUtils';
import { TRASH_ID, type DocumentProjection, type NodeProjection } from '../../core/types';

interface SearchDependencies {
  readonly tagDefIds: string[];
  readonly fieldDefIds: string[];
  readonly referencedNodeIds: string[];
}

export class DocumentTextSearchIndex {
  private index: MutableTextSearchIndex;
  private revisionValue: number;
  private rootId: string;
  private libraryId: string;
  private readonly tagDependents = new Map<string, Set<string>>();
  private readonly fieldDependents = new Map<string, Set<string>>();
  private readonly referenceDependents = new Map<string, Set<string>>();
  private readonly dependenciesByNode = new Map<string, SearchDependencies>();

  constructor(revision: number, projection: DocumentProjection) {
    this.index = createTextSearchIndex();
    this.revisionValue = revision;
    this.rootId = projection.rootId;
    this.libraryId = projection.libraryId;
    this.reseed(revision, projection);
  }

  get revision(): number {
    return this.revisionValue;
  }

  get textIndex(): TextSearchIndex {
    return this.index;
  }

  reseed(revision: number, projection: DocumentProjection): void {
    const snapshot = buildTextSearchRecordSnapshot(projection);
    this.index = createTextSearchIndex(snapshot.records.map((entry) => entry.record));
    this.revisionValue = revision;
    this.rootId = snapshot.rootId;
    this.libraryId = snapshot.libraryId;
    this.tagDependents.clear();
    this.fieldDependents.clear();
    this.referenceDependents.clear();
    this.dependenciesByNode.clear();
    for (const entry of snapshot.records) this.trackDependencies(entry.record.id, entry.dependencies);
  }

  applyDelta(
    revision: number,
    changedNodeIds: ReadonlySet<string>,
    previousNodes: ReadonlyMap<string, NodeProjection>,
    nextNodes: ReadonlyMap<string, NodeProjection>,
    projection: DocumentProjection,
  ): boolean {
    if (revision === this.revisionValue) return true;
    if (revision !== this.revisionValue + 1 || changedNodeIds.size === 0) {
      this.reseed(revision, projection);
      return false;
    }

    const refreshIds = new Set(changedNodeIds);
    for (const nodeId of changedNodeIds) {
      const before = previousNodes.get(nodeId);
      const after = nextNodes.get(nodeId);
      this.addDependentRefreshIds(refreshIds, nodeId, before, after, previousNodes, nextNodes);

      if (before && !after) {
        for (const descendantId of collectDescendantIds(previousNodes, nodeId)) refreshIds.add(descendantId);
        continue;
      }
      if (before && after && isInTrash(previousNodes, nodeId) !== isInTrash(nextNodes, nodeId)) {
        for (const descendantId of collectDescendantIds(previousNodes, nodeId)) refreshIds.add(descendantId);
        for (const descendantId of collectDescendantIds(nextNodes, nodeId)) refreshIds.add(descendantId);
      }
    }

    for (const nodeId of refreshIds) {
      this.applyRecord(nodeId, textSearchRecordForNodeMap(
        nextNodes,
        this.rootId,
        this.libraryId,
        nodeId,
      ));
    }
    this.revisionValue = revision;
    return true;
  }

  async applyDeltaYielding(
    revision: number,
    changedNodeIds: ReadonlySet<string>,
    previousNodes: ReadonlyMap<string, NodeProjection>,
    nextNodes: ReadonlyMap<string, NodeProjection>,
    projection: DocumentProjection,
    options: { readonly yieldEveryNodes?: number; readonly yield?: () => Promise<void> } = {},
  ): Promise<boolean> {
    if (revision === this.revisionValue) return true;
    if (revision !== this.revisionValue + 1 || changedNodeIds.size === 0) {
      this.reseed(revision, projection);
      return false;
    }

    const refreshIds = this.collectRefreshIds(changedNodeIds, previousNodes, nextNodes);
    const recordChanges = new Map<string, NodeTextSearchRecord | null>();
    const yieldEveryNodes = Math.max(1, options.yieldEveryNodes ?? 250);
    const yieldOperation = options.yield ?? yieldToEventLoop;
    let processed = 0;
    for (const nodeId of refreshIds) {
      recordChanges.set(nodeId, textSearchRecordForNodeMap(
        nextNodes,
        this.rootId,
        this.libraryId,
        nodeId,
      ));
      processed += 1;
      if (processed % yieldEveryNodes === 0) await yieldOperation();
    }

    for (const [nodeId, entry] of recordChanges) this.applyRecord(nodeId, entry);
    this.revisionValue = revision;
    return true;
  }

  private collectRefreshIds(
    changedNodeIds: ReadonlySet<string>,
    previousNodes: ReadonlyMap<string, NodeProjection>,
    nextNodes: ReadonlyMap<string, NodeProjection>,
  ): Set<string> {
    const refreshIds = new Set(changedNodeIds);
    for (const nodeId of changedNodeIds) {
      const before = previousNodes.get(nodeId);
      const after = nextNodes.get(nodeId);
      this.addDependentRefreshIds(refreshIds, nodeId, before, after, previousNodes, nextNodes);
      if (before && !after) {
        for (const descendantId of collectDescendantIds(previousNodes, nodeId)) refreshIds.add(descendantId);
      } else if (before && after && isInTrash(previousNodes, nodeId) !== isInTrash(nextNodes, nodeId)) {
        for (const descendantId of collectDescendantIds(previousNodes, nodeId)) refreshIds.add(descendantId);
        for (const descendantId of collectDescendantIds(nextNodes, nodeId)) refreshIds.add(descendantId);
      }
    }
    return refreshIds;
  }

  private addDependentRefreshIds(
    refreshIds: Set<string>,
    nodeId: string,
    before: NodeProjection | undefined,
    after: NodeProjection | undefined,
    previousNodes: ReadonlyMap<string, NodeProjection>,
    nextNodes: ReadonlyMap<string, NodeProjection>,
  ): void {
    this.addSchemaDefinitionDependents(refreshIds, before, previousNodes);
    this.addSchemaDefinitionDependents(refreshIds, after, nextNodes);
    for (const dependentId of this.referenceDependents.get(nodeId) ?? []) refreshIds.add(dependentId);
  }

  private addSchemaDefinitionDependents(
    refreshIds: Set<string>,
    start: NodeProjection | undefined,
    nodes: ReadonlyMap<string, NodeProjection>,
  ): void {
    let current = start;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.type === 'tagDef') {
        for (const dependentId of this.tagDependents.get(current.id) ?? []) refreshIds.add(dependentId);
      }
      if (current.type === 'fieldDef') {
        for (const dependentId of this.fieldDependents.get(current.id) ?? []) refreshIds.add(dependentId);
      }
      current = current.parentId ? nodes.get(current.parentId) : undefined;
    }
  }

  private applyRecord(nodeId: string, entry: NodeTextSearchRecord | null): void {
    this.clearDependencies(nodeId);
    if (!entry) {
      this.index.remove(nodeId);
      return;
    }
    this.index.upsert(entry.record);
    this.trackDependencies(nodeId, entry.dependencies);
  }

  private trackDependencies(nodeId: string, dependencies: SearchDependencies): void {
    this.dependenciesByNode.set(nodeId, dependencies);
    for (const tagDefId of dependencies.tagDefIds) addToSetMap(this.tagDependents, tagDefId, nodeId);
    for (const fieldDefId of dependencies.fieldDefIds) addToSetMap(this.fieldDependents, fieldDefId, nodeId);
    for (const referencedNodeId of dependencies.referencedNodeIds) {
      addToSetMap(this.referenceDependents, referencedNodeId, nodeId);
    }
  }

  private clearDependencies(nodeId: string): void {
    const dependencies = this.dependenciesByNode.get(nodeId);
    if (!dependencies) return;
    for (const tagDefId of dependencies.tagDefIds) removeFromSetMap(this.tagDependents, tagDefId, nodeId);
    for (const fieldDefId of dependencies.fieldDefIds) removeFromSetMap(this.fieldDependents, fieldDefId, nodeId);
    for (const referencedNodeId of dependencies.referencedNodeIds) {
      removeFromSetMap(this.referenceDependents, referencedNodeId, nodeId);
    }
    this.dependenciesByNode.delete(nodeId);
  }
}

function isInTrash(nodes: ReadonlyMap<string, NodeProjection>, nodeId: string): boolean {
  return nodeIsInSubtree(nodes, nodeId, TRASH_ID);
}

export class BeforeStateNodeMap implements ReadonlyMap<string, NodeProjection> {
  constructor(
    private readonly current: ReadonlyMap<string, NodeProjection>,
    private readonly before: ReadonlyMap<string, NodeProjection | undefined>,
  ) {}

  get size(): number { return this.current.size; }
  get(key: string): NodeProjection | undefined {
    return this.before.has(key) ? this.before.get(key) : this.current.get(key);
  }
  has(key: string): boolean { return this.get(key) !== undefined; }
  entries(): MapIterator<[string, NodeProjection]> { return this.current.entries(); }
  keys(): MapIterator<string> { return this.current.keys(); }
  values(): MapIterator<NodeProjection> { return this.current.values(); }
  forEach(
    callbackfn: (value: NodeProjection, key: string, map: ReadonlyMap<string, NodeProjection>) => void,
    thisArg?: unknown,
  ): void {
    this.current.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }
  [Symbol.iterator](): MapIterator<[string, NodeProjection]> { return this.entries(); }
}

export class SparseOverlayNodeMap implements ReadonlyMap<string, NodeProjection> {
  constructor(
    private readonly base: ReadonlyMap<string, NodeProjection>,
    private readonly changes: ReadonlyMap<string, NodeProjection | undefined>,
  ) {}

  get size(): number { return this.materialize().size; }
  get(key: string): NodeProjection | undefined {
    return this.changes.has(key) ? this.changes.get(key) : this.base.get(key);
  }
  has(key: string): boolean { return this.get(key) !== undefined; }
  entries(): MapIterator<[string, NodeProjection]> { return this.materialize().entries(); }
  keys(): MapIterator<string> { return this.materialize().keys(); }
  values(): MapIterator<NodeProjection> { return this.materialize().values(); }
  forEach(
    callbackfn: (value: NodeProjection, key: string, map: ReadonlyMap<string, NodeProjection>) => void,
    thisArg?: unknown,
  ): void {
    this.materialize().forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }
  [Symbol.iterator](): MapIterator<[string, NodeProjection]> { return this.entries(); }

  private materialize(): Map<string, NodeProjection> {
    const merged = new Map(this.base);
    for (const [key, value] of this.changes) {
      if (value) merged.set(key, value);
      else merged.delete(key);
    }
    return merged;
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
