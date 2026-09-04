import { nodeFieldSlots, type FieldSlotSource } from './fieldSlots';
import type { DefConfigKey, NodeId, NodeType, ViewMode } from './types';

export const RENDERABLE_VIEW_MODES = ['list', 'table'] as const satisfies readonly ViewMode[];
export type RenderableViewMode = (typeof RENDERABLE_VIEW_MODES)[number];

const RENDERABLE_VIEW_MODE_SET: ReadonlySet<string> = new Set(RENDERABLE_VIEW_MODES);

export function isRenderableViewMode(value: string): value is RenderableViewMode {
  return RENDERABLE_VIEW_MODE_SET.has(value);
}

export interface ViewTreeNode {
  id: NodeId;
  type?: NodeType;
  children: readonly NodeId[];
}

export interface TableViewTreeNode extends ViewTreeNode {
  parentId?: NodeId | null;
  tags?: readonly NodeId[];
  targetId?: NodeId;
  fieldDefId?: NodeId;
  configKey?: DefConfigKey;
  displayField?: NodeId;
  displayOrder?: number;
}

type ViewNodeIndex<T extends ViewTreeNode> =
  | ReadonlyMap<NodeId, T>
  | Readonly<Record<NodeId, T | undefined>>;

function indexResolver<T extends ViewTreeNode>(
  byId: ViewNodeIndex<T>,
): (id: NodeId) => T | undefined {
  if (byId instanceof Map) return (id) => byId.get(id);
  const nodes = byId as Readonly<Record<NodeId, T | undefined>>;
  return (id) => nodes[id];
}

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
  const resolve = indexResolver(byId);
  return owner.children
    .map(resolve)
    .find((child): child is T => child?.type === 'viewDef');
}

/** Explicit view configuration wins; Search only changes the unset default. */
export function resolveViewToolbarVisible(
  owner: Pick<ViewTreeNode, 'type'> | undefined,
  configured: boolean | undefined,
): boolean {
  return configured ?? (owner?.type === 'search');
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
  const resolve = indexResolver(byId);
  let current: T | undefined = node;
  const visited = new Set<NodeId>();
  while (current?.type === 'reference') {
    if (visited.has(current.id) || !current.targetId) return undefined;
    visited.add(current.id);
    current = resolve(current.targetId);
  }
  return current;
}

export function orderedByFiniteOrder<T extends { id: NodeId }>(
  items: readonly T[],
  orderOf: (item: T) => number | undefined,
): T[] {
  return items
    .map((item, sourceIndex) => ({ item, sourceIndex, order: orderOf(item) }))
    .sort((left, right) => {
      const leftOrder = Number.isFinite(left.order)
        ? left.order!
        : Number.POSITIVE_INFINITY;
      const rightOrder = Number.isFinite(right.order)
        ? right.order!
        : Number.POSITIVE_INFINITY;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      if (left.sourceIndex !== right.sourceIndex) return left.sourceIndex - right.sourceIndex;
      return left.item.id.localeCompare(right.item.id);
    })
    .map(({ item }) => item);
}

export function orderedDisplayFields<T extends { id: NodeId; displayOrder?: number }>(
  displayFields: readonly T[],
): T[] {
  return orderedByFiniteOrder(displayFields, (field) => field.displayOrder);
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
}): TableDisplayFieldInitialization<T> | null {
  const { byId, owner, schema } = params;
  const resolve = indexResolver(byId);
  const viewDef = findViewDef(byId, owner);
  if (!viewDef || !schema) return null;

  const displayFields = viewDef.children
    .map(resolve)
    .filter((child): child is T & { type: 'displayField'; displayOrder?: number } => child?.type === 'displayField');
  const configuredFields = new Set(displayFields.flatMap((display) => (
    display.displayField ? [display.displayField] : []
  )));
  const usedFields = new Set<NodeId>();
  const slotSource = (byId instanceof Map
    ? byId
    : { nodes: byId }) as FieldSlotSource;
  for (const childId of owner.children) {
    const child = resolve(childId);
    if (!child || !isViewRecordNode(child)) continue;
    const record = resolveViewRecordNode(byId, child);
    if (!record) continue;
    for (const slot of nodeFieldSlots(slotSource, record.id)) usedFields.add(slot.fieldDefId);
  }

  const missingFieldIds = schema.children.filter((fieldId) => {
    const field = resolve(fieldId);
    return field?.type === 'fieldDef'
      && usedFields.has(fieldId)
      && !configuredFields.has(fieldId);
  });
  return { viewDef, displayFields, missingFieldIds };
}
