import type { NodeId, NodeProjection } from '../api/types';
import { TRASH_ID } from '../../core/types';
import { SparseProjectionMap } from './sparseProjectionMap';

export interface ProjectionSemanticRevisions {
  readonly structure: number;
  readonly referenceGraph: number;
  readonly tagDefinitions: number;
  readonly trashMembership: number;
}

export interface ProjectionDeltaFacts {
  readonly changedIds: ReadonlySet<NodeId>;
  readonly dirtyIds: ReadonlySet<NodeId>;
  readonly removedIds: readonly NodeId[];
  readonly structureChanged: boolean;
  readonly trashMembershipChangedIds: ReadonlySet<NodeId>;
}

export class SparseNodeIdSet implements ReadonlySet<NodeId> {
  private constructor(private readonly valuesById: SparseProjectionMap<true>) {}

  static from(values: Iterable<NodeId>): SparseNodeIdSet {
    return new SparseNodeIdSet(SparseProjectionMap.fromEntries((function* entries() {
      for (const value of values) yield [value, true] as const;
    }())));
  }

  get size(): number {
    return this.valuesById.size;
  }

  has(value: NodeId): boolean {
    return this.valuesById.has(value);
  }

  entries(): SetIterator<[NodeId, NodeId]> {
    return mapIterator(this.valuesById.keys(), (value) => [value, value]);
  }

  keys(): SetIterator<NodeId> {
    return this.valuesById.keys() as SetIterator<NodeId>;
  }

  values(): SetIterator<NodeId> {
    return this.valuesById.keys() as SetIterator<NodeId>;
  }

  forEach(
    callbackfn: (value: NodeId, value2: NodeId, set: ReadonlySet<NodeId>) => void,
    thisArg?: unknown,
  ): void {
    for (const value of this.valuesById.keys()) callbackfn.call(thisArg, value, value, this);
  }

  [Symbol.iterator](): SetIterator<NodeId> {
    return this.values();
  }

  patch(addedIds: Iterable<NodeId>, removedIds: Iterable<NodeId>): SparseNodeIdSet {
    const additions = [...addedIds].map((id) => [id, true] as const);
    const removals = [...removedIds];
    if (additions.length === 0 && removals.length === 0) return this;
    return new SparseNodeIdSet(this.valuesById.patch(additions, removals));
  }
}

export function buildTrashNodeIds(
  byId: ReadonlyMap<NodeId, NodeProjection>,
  trashId: NodeId,
): SparseNodeIdSet {
  return SparseNodeIdSet.from(subtreeIds(byId, trashId));
}

export function patchTrashNodeIds(params: {
  readonly previous: SparseNodeIdSet;
  readonly previousById: ReadonlyMap<NodeId, NodeProjection>;
  readonly nextById: ReadonlyMap<NodeId, NodeProjection>;
  readonly changedNodes: readonly NodeProjection[];
  readonly removedIds: readonly NodeId[];
  readonly trashId: NodeId;
}): { readonly nodeIds: SparseNodeIdSet; readonly changedIds: ReadonlySet<NodeId> } {
  const additions = new Set<NodeId>();
  const removals = new Set<NodeId>();
  const setMembership = (nodeId: NodeId, included: boolean) => {
    const wasIncluded = params.previous.has(nodeId);
    if (included === wasIncluded) return;
    if (included) additions.add(nodeId);
    else removals.add(nodeId);
  };

  for (const nodeId of params.removedIds) setMembership(nodeId, false);
  for (const node of params.changedNodes) {
    const wasIncluded = params.previous.has(node.id);
    const isIncluded = nodeIsInSubtree(params.nextById, node.id, params.trashId);
    if (wasIncluded === isIncluded) continue;
    const source = params.nextById.has(node.id) ? params.nextById : params.previousById;
    for (const descendantId of subtreeIds(source, node.id)) {
      setMembership(descendantId, isIncluded && params.nextById.has(descendantId));
    }
  }

  const changedIds = new Set<NodeId>([...additions, ...removals]);
  return {
    nodeIds: params.previous.patch(additions, removals),
    changedIds,
  };
}

export function projectionStructureChanged(
  previousById: ReadonlyMap<NodeId, NodeProjection>,
  changedNodes: readonly NodeProjection[],
  removedIds: readonly NodeId[],
): boolean {
  if (removedIds.length > 0) return true;
  return changedNodes.some((node) => {
    const previous = previousById.get(node.id);
    return !previous
      || previous.parentId !== node.parentId
      || previous.type !== node.type
      || !sameList(previous.children, node.children);
  });
}

export function projectionReferenceGraphChanged(
  previousById: ReadonlyMap<NodeId, NodeProjection>,
  changedNodes: readonly NodeProjection[],
  removedIds: readonly NodeId[],
): boolean {
  if (removedIds.length > 0) return true;
  return changedNodes.some((node) => {
    const previous = previousById.get(node.id);
    if (!previous) return true;
    return previous.parentId !== node.parentId
      || previous.type !== node.type
      || referenceTargetId(previous) !== referenceTargetId(node)
      || referenceRole(previous) !== referenceRole(node)
      || !sameList(inlineReferenceTargetIds(previous), inlineReferenceTargetIds(node));
  });
}

export function projectionTagDefinitionsChanged(params: {
  readonly previousById: ReadonlyMap<NodeId, NodeProjection>;
  readonly nextById: ReadonlyMap<NodeId, NodeProjection>;
  readonly changedNodes: readonly NodeProjection[];
  readonly removedIds: readonly NodeId[];
  readonly trashMembershipChangedIds: ReadonlySet<NodeId>;
}): boolean {
  const touchedIds = new Set<NodeId>([
    ...params.changedNodes.map((node) => node.id),
    ...params.removedIds,
    ...params.trashMembershipChangedIds,
  ]);
  const candidateTagIds = new Set<NodeId>();
  const activeChangedFieldDefIds = new Set<NodeId>();
  for (const nodeId of touchedIds) {
    collectTagShapeCandidates(params.previousById, nodeId, candidateTagIds);
    collectTagShapeCandidates(params.nextById, nodeId, candidateTagIds);

    const wasActive = activeFieldDefinition(params.previousById, nodeId);
    const isActive = activeFieldDefinition(params.nextById, nodeId);
    if (wasActive !== isActive) activeChangedFieldDefIds.add(nodeId);
  }
  collectTagsUsingFieldDefinitions(params.previousById, activeChangedFieldDefIds, candidateTagIds);
  collectTagsUsingFieldDefinitions(params.nextById, activeChangedFieldDefIds, candidateTagIds);

  for (const tagId of candidateTagIds) {
    if (!sameTagSlotShape(
      tagSlotShape(params.previousById, tagId),
      tagSlotShape(params.nextById, tagId),
    )) return true;
  }
  return false;
}

export function projectionTagCandidatesChanged(params: {
  readonly previousById: ReadonlyMap<NodeId, NodeProjection>;
  readonly nextById: ReadonlyMap<NodeId, NodeProjection>;
  readonly changedNodes: readonly NodeProjection[];
  readonly removedIds: readonly NodeId[];
  readonly trashMembershipChangedIds: ReadonlySet<NodeId>;
}): boolean {
  const candidateIds = new Set<NodeId>([
    ...params.changedNodes.map((node) => node.id),
    ...params.removedIds,
    ...params.trashMembershipChangedIds,
  ]);
  for (const nodeId of candidateIds) {
    if (
      params.previousById.get(nodeId)?.type === 'tagDef'
      || params.nextById.get(nodeId)?.type === 'tagDef'
    ) return true;
  }
  return false;
}

interface TagSlotShape {
  readonly active: boolean;
  readonly extendsTargetId: NodeId | null;
  readonly templates: readonly {
    readonly entryId: NodeId;
    readonly fieldDefId: NodeId;
    readonly fieldDefActive: boolean;
  }[];
}

function collectTagShapeCandidates(
  byId: ReadonlyMap<NodeId, NodeProjection>,
  nodeId: NodeId,
  output: Set<NodeId>,
): void {
  const node = byId.get(nodeId);
  if (!node) return;
  if (node.type === 'tagDef') output.add(node.id);
  const parent = node.parentId ? byId.get(node.parentId) : undefined;
  if (
    (node.type === 'fieldEntry' || node.type === 'defConfig')
    && parent?.type === 'tagDef'
  ) output.add(parent.id);
  if (node.type !== 'reference' || parent?.type !== 'defConfig' || parent.configKey !== 'extends') return;
  const tag = parent.parentId ? byId.get(parent.parentId) : undefined;
  if (tag?.type === 'tagDef') output.add(tag.id);
}

function collectTagsUsingFieldDefinitions(
  byId: ReadonlyMap<NodeId, NodeProjection>,
  fieldDefIds: ReadonlySet<NodeId>,
  output: Set<NodeId>,
): void {
  if (fieldDefIds.size === 0) return;
  for (const node of byId.values()) {
    if (node.type !== 'tagDef') continue;
    if (node.children.some((childId) => {
      const child = byId.get(childId);
      return child?.type === 'fieldEntry'
        && Boolean(child.fieldDefId)
        && fieldDefIds.has(child.fieldDefId!);
    })) output.add(node.id);
  }
}

function tagSlotShape(
  byId: ReadonlyMap<NodeId, NodeProjection>,
  tagId: NodeId,
): TagSlotShape {
  const tag = byId.get(tagId);
  const active = tag?.type === 'tagDef' && !nodeIsInSubtree(byId, tagId, TRASH_ID);
  if (!tag || !active) return { active: false, extendsTargetId: null, templates: [] };

  const extendsRow = tag.children
    .map((childId) => byId.get(childId))
    .find((child) => child?.type === 'defConfig' && child.configKey === 'extends');
  const extendsValue = extendsRow?.children
    .map((childId) => byId.get(childId))
    .find((child) => child?.type === 'reference' && child.targetId);
  const extendsTargetId = extendsValue?.type === 'reference'
    ? extendsValue.targetId ?? null
    : null;
  const templates = tag.children.flatMap((childId): TagSlotShape['templates'][number][] => {
    const child = byId.get(childId);
    if (
      child?.type !== 'fieldEntry'
      || !child.fieldDefId
      || nodeIsInSubtree(byId, child.id, TRASH_ID)
    ) return [];
    return [{
      entryId: child.id,
      fieldDefId: child.fieldDefId,
      fieldDefActive: activeFieldDefinition(byId, child.fieldDefId),
    }];
  });
  return { active, extendsTargetId, templates };
}

function activeFieldDefinition(
  byId: ReadonlyMap<NodeId, NodeProjection>,
  nodeId: NodeId,
): boolean {
  if (nodeId.startsWith('sys:')) return true;
  const node = byId.get(nodeId);
  return node?.type === 'fieldDef' && !nodeIsInSubtree(byId, nodeId, TRASH_ID);
}

function sameTagSlotShape(left: TagSlotShape, right: TagSlotShape): boolean {
  if (
    left.active !== right.active
    || left.extendsTargetId !== right.extendsTargetId
    || left.templates.length !== right.templates.length
  ) return false;
  return left.templates.every((template, index) => {
    const other = right.templates[index];
    if (!other) return false;
    return template.entryId === other.entryId
      && template.fieldDefId === other.fieldDefId
      && template.fieldDefActive === other.fieldDefActive;
  });
}

function inlineReferenceTargetIds(node: NodeProjection): NodeId[] {
  const targets: NodeId[] = [];
  for (const inlineRef of node.content.inlineRefs) {
    if (inlineRef.target.kind === 'node') targets.push(inlineRef.target.nodeId);
  }
  return targets;
}

function referenceTargetId(node: NodeProjection): NodeId | undefined {
  return node.type === 'reference' ? node.targetId : undefined;
}

function referenceRole(node: NodeProjection) {
  return node.type === 'reference' ? node.refRole : undefined;
}

function nodeIsInSubtree(
  byId: ReadonlyMap<NodeId, NodeProjection>,
  nodeId: NodeId,
  ancestorId: NodeId,
): boolean {
  const visited = new Set<NodeId>();
  let current = byId.get(nodeId);
  while (current && !visited.has(current.id)) {
    if (current.id === ancestorId) return true;
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

function* subtreeIds(
  byId: ReadonlyMap<NodeId, NodeProjection>,
  rootId: NodeId,
): Generator<NodeId> {
  const visited = new Set<NodeId>();
  const stack = [rootId];
  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    if (visited.has(nodeId)) continue;
    const node = byId.get(nodeId);
    if (!node) continue;
    visited.add(nodeId);
    yield nodeId;
    for (const childId of node.children) stack.push(childId);
  }
}

function sameList<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function mapIterator<TInput, TOutput>(
  iterator: Iterator<TInput>,
  transform: (value: TInput) => TOutput,
): SetIterator<TOutput> {
  return {
    next(): IteratorResult<TOutput> {
      const next = iterator.next();
      return next.done ? { done: true, value: undefined } : { done: false, value: transform(next.value) };
    },
    [Symbol.iterator]() {
      return this;
    },
  } as SetIterator<TOutput>;
}
