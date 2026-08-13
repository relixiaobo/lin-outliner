import type { NodeId, NodeType, ViewMode } from './types';

export interface ViewTreeNode {
  id: NodeId;
  type?: NodeType;
  children: readonly NodeId[];
}

export interface TableViewTreeNode extends ViewTreeNode {
  targetId?: NodeId;
  fieldDefId?: NodeId;
  displayField?: NodeId;
  displayOrder?: number;
}

type ViewNodeIndex<T extends ViewTreeNode> =
  | ReadonlyMap<NodeId, T>
  | Readonly<Record<NodeId, T | undefined>>;

export const INTERNAL_VIEW_NODE_TYPES: ReadonlySet<NodeType> = new Set([
  'queryCondition',
  'viewDef',
  'sortRule',
  'filterRule',
  'displayField',
  'defConfig',
  'systemOption',
]);

const NON_RECORD_VIEW_NODE_TYPES: ReadonlySet<NodeType> = new Set([
  ...INTERNAL_VIEW_NODE_TYPES,
  'fieldEntry',
]);

export function findViewDef<T extends ViewTreeNode>(
  byId: ViewNodeIndex<T>,
  owner: T | undefined,
): T | undefined {
  if (!owner) return undefined;
  const resolve = byId instanceof Map
    ? (id: NodeId) => byId.get(id)
    : (id: NodeId) => (byId as Readonly<Record<NodeId, T | undefined>>)[id];
  return owner.children
    .map(resolve)
    .find((child): child is T => child?.type === 'viewDef');
}

export function entersTable(previousMode: ViewMode | undefined, nextMode: ViewMode): boolean {
  return nextMode === 'table' && (previousMode ?? 'list') !== 'table';
}

export function isViewRecordNode(node: Pick<ViewTreeNode, 'type'>): boolean {
  return node.type === undefined || !NON_RECORD_VIEW_NODE_TYPES.has(node.type);
}

export function resolveViewRecordNode<T extends TableViewTreeNode>(
  byId: ViewNodeIndex<T>,
  node: T,
): T | undefined {
  const resolve = byId instanceof Map
    ? (id: NodeId) => byId.get(id)
    : (id: NodeId) => (byId as Readonly<Record<NodeId, T | undefined>>)[id];
  let current: T | undefined = node;
  const visited = new Set<NodeId>();
  while (current?.type === 'reference') {
    if (visited.has(current.id) || !current.targetId) return undefined;
    visited.add(current.id);
    current = resolve(current.targetId);
  }
  return current;
}

export function orderedDisplayFields<T extends { id: NodeId; displayOrder?: number }>(
  displayFields: readonly T[],
): T[] {
  return displayFields
    .map((field, sourceIndex) => ({ field, sourceIndex }))
    .sort((left, right) => {
      const leftOrder = Number.isFinite(left.field.displayOrder)
        ? left.field.displayOrder!
        : Number.POSITIVE_INFINITY;
      const rightOrder = Number.isFinite(right.field.displayOrder)
        ? right.field.displayOrder!
        : Number.POSITIVE_INFINITY;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      if (left.sourceIndex !== right.sourceIndex) return left.sourceIndex - right.sourceIndex;
      return left.field.id.localeCompare(right.field.id);
    })
    .map(({ field }) => field);
}

export function missingDisplayOrderPlan<T extends { id: NodeId; displayOrder?: number }>(
  displayFields: readonly T[],
): { assignments: Array<{ field: T; order: number }>; nextOrder: number } {
  let nextOrder = displayFields.reduce((max, display) => (
    Number.isFinite(display.displayOrder) ? Math.max(max, display.displayOrder!) : max
  ), -1) + 1;
  const assignments = orderedDisplayFields(displayFields).flatMap((field) => {
    if (Number.isFinite(field.displayOrder)) return [];
    return [{ field, order: nextOrder++ }];
  });
  return { assignments, nextOrder };
}

export interface TableDisplayFieldInitialization<T extends TableViewTreeNode> {
  viewDef: T;
  displayFields: Array<T & { type: 'displayField'; displayOrder?: number }>;
  missingFieldIds: NodeId[];
}

export function tableDisplayFieldInitialization<T extends TableViewTreeNode>(params: {
  byId: ViewNodeIndex<T>;
  owner: T;
  schema: T | undefined;
  isActiveField: (field: T) => boolean;
}): TableDisplayFieldInitialization<T> | null {
  const { byId, owner, schema } = params;
  const resolve = byId instanceof Map
    ? (id: NodeId) => byId.get(id)
    : (id: NodeId) => (byId as Readonly<Record<NodeId, T | undefined>>)[id];
  const viewDef = findViewDef(byId, owner);
  if (!viewDef || !schema) return null;

  const displayFields = viewDef.children
    .map(resolve)
    .filter((child): child is T & { type: 'displayField'; displayOrder?: number } => child?.type === 'displayField');
  const configuredFields = new Set(displayFields.flatMap((display) => (
    display.displayField ? [display.displayField] : []
  )));
  const usedFields = new Set<NodeId>();
  for (const childId of owner.children) {
    const child = resolve(childId);
    if (!child || !isViewRecordNode(child)) continue;
    const record = resolveViewRecordNode(byId, child);
    if (!record) continue;
    for (const nestedId of record.children) {
      const nested = resolve(nestedId);
      if (nested?.type === 'fieldEntry' && nested.fieldDefId) usedFields.add(nested.fieldDefId);
    }
  }

  const missingFieldIds = schema.children.filter((fieldId) => {
    const field = resolve(fieldId);
    return field?.type === 'fieldDef'
      && usedFields.has(fieldId)
      && !configuredFields.has(fieldId)
      && params.isActiveField(field);
  });
  return { viewDef, displayFields, missingFieldIds };
}
