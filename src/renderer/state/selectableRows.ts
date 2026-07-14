import type { NodeId, NodeProjection } from '../api/types';
import { buildOutlinerRows, type OutlinerRowItem } from './outlinerRows';
import {
  isSyntheticSystemReferenceId,
  systemReferenceValueIds,
} from './systemReferenceRows';

export type SelectableRowKind =
  | 'content'
  | 'fieldEntry'
  | 'fieldValue'
  | 'syntheticSystemValue';

export type SelectableRowAction =
  | 'node-trash'
  | 'field-value-remove'
  | 'node-reorder'
  | 'node-clone'
  | 'target-node'
  | 'disabled';

export interface SelectableRowActionPolicy {
  delete: Extract<SelectableRowAction, 'node-trash' | 'field-value-remove' | 'disabled'>;
  move: Extract<SelectableRowAction, 'node-reorder' | 'disabled'>;
  duplicate: Extract<SelectableRowAction, 'node-clone' | 'disabled'>;
  tag: Extract<SelectableRowAction, 'target-node' | 'disabled'>;
  checkbox: Extract<SelectableRowAction, 'target-node' | 'disabled'>;
}

export interface SelectableRow {
  id: NodeId;
  parentId: NodeId | null;
  panelRootId: NodeId;
  kind: SelectableRowKind;
  stored: boolean;
  mutable: boolean;
  actionPolicy: SelectableRowActionPolicy;
}

export interface SelectableRowsOptions {
  expanded: ReadonlySet<NodeId>;
  expandedHiddenFields?: Set<string>;
}

const DISABLED_POLICY: SelectableRowActionPolicy = {
  delete: 'disabled',
  move: 'disabled',
  duplicate: 'disabled',
  tag: 'disabled',
  checkbox: 'disabled',
};

const NODE_POLICY: SelectableRowActionPolicy = {
  delete: 'node-trash',
  move: 'node-reorder',
  duplicate: 'node-clone',
  tag: 'target-node',
  checkbox: 'target-node',
};

const FIELD_VALUE_POLICY: SelectableRowActionPolicy = {
  delete: 'field-value-remove',
  move: 'node-reorder',
  duplicate: 'node-clone',
  tag: 'target-node',
  checkbox: 'target-node',
};

export function buildSelectableRows(
  panelRootId: NodeId,
  byId: Map<NodeId, NodeProjection>,
  options: SelectableRowsOptions,
): SelectableRow[] {
  const result: SelectableRow[] = [];
  const expandedHiddenFields = options.expandedHiddenFields ?? new Set<string>();

  const visit = (parentId: NodeId, referencePath: NodeId[]) => {
    const parent = byId.get(parentId);
    if (!parent) return;
    const rows = buildOutlinerRows(parent, byId, { expandedHiddenFields });
    const visitRows = (currentRows: OutlinerRowItem[]) => {
      for (const row of currentRows) {
        if (row.type === 'filteredOut') {
          if (options.expanded.has(row.id)) visitRows(row.rows);
          continue;
        }
        if (row.type !== 'field' && row.type !== 'content') continue;
        result.push(selectableRowFor({
          id: row.id,
          parentId,
          panelRootId,
          byId,
        }));
        if (row.type === 'field') {
          const fieldEntry = byId.get(row.id);
          const existingChildren = new Set(fieldEntry?.children ?? []);
          for (const syntheticId of systemReferenceValueIds(fieldEntry, byId)) {
            if (existingChildren.has(syntheticId)) continue;
            result.push(selectableRowFor({
              id: syntheticId,
              parentId: row.id,
              panelRootId,
              byId,
            }));
          }
        }
        const shouldDescend = row.type === 'field' || options.expanded.has(row.id);
        if (shouldDescend) {
          const childParentId = selectableChildParentId(row.id, byId);
          if (!childParentId || referencePath.includes(childParentId)) continue;
          visit(childParentId, [...referencePath, childParentId]);
        }
      }
    };
    visitRows(rows);
  };

  visit(panelRootId, [panelRootId]);
  return result;
}

export function selectableRowForId(
  id: NodeId,
  panelRootId: NodeId,
  byId: Map<NodeId, NodeProjection>,
): SelectableRow | null {
  const node = byId.get(id);
  if (!node && !isSyntheticSystemValueId(id)) return null;
  return selectableRowFor({
    id,
    parentId: node?.parentId ?? null,
    panelRootId,
    byId,
  });
}

export function selectableChildParentId(
  rowId: NodeId,
  byId: Map<NodeId, NodeProjection>,
): NodeId | null {
  const node = byId.get(rowId);
  if (!node) return null;
  if (node.type !== 'reference' || !node.targetId) return rowId;
  return resolveSelectableReferenceTargetId(node.targetId, byId);
}

export function resolveSelectableReferenceTargetId(
  targetId: NodeId,
  byId: Map<NodeId, NodeProjection>,
): NodeId | null {
  let currentId: NodeId | undefined = targetId;
  const visited = new Set<NodeId>();
  while (currentId) {
    if (visited.has(currentId)) return null;
    visited.add(currentId);
    const current = byId.get(currentId);
    if (!current) return null;
    if (current.type !== 'reference') return current.id;
    currentId = current.targetId;
  }
  return null;
}

function selectableRowFor(params: {
  id: NodeId;
  parentId: NodeId | null;
  panelRootId: NodeId;
  byId: Map<NodeId, NodeProjection>;
}): SelectableRow {
  const node = params.byId.get(params.id);
  const parent = params.parentId ? params.byId.get(params.parentId) : undefined;
  const synthetic = isSyntheticSystemValueId(params.id);
  const kind = selectableRowKind(params.id, node, parent);
  const stored = Boolean(node) && !synthetic;
  const mutable = stored && !(node?.locked ?? true);
  return {
    id: params.id,
    parentId: params.parentId,
    panelRootId: params.panelRootId,
    kind,
    stored,
    mutable,
    actionPolicy: actionPolicyFor(kind, mutable),
  };
}

function selectableRowKind(
  id: NodeId,
  node: NodeProjection | undefined,
  parent: NodeProjection | undefined,
): SelectableRowKind {
  if (isSyntheticSystemValueId(id)) return 'syntheticSystemValue';
  if (parent?.type === 'fieldEntry') return 'fieldValue';
  if (node?.type === 'fieldEntry') return 'fieldEntry';
  return 'content';
}

function actionPolicyFor(kind: SelectableRowKind, mutable: boolean): SelectableRowActionPolicy {
  if (!mutable || kind === 'syntheticSystemValue') return DISABLED_POLICY;
  if (kind === 'fieldValue') return FIELD_VALUE_POLICY;
  return NODE_POLICY;
}

function isSyntheticSystemValueId(id: NodeId): boolean {
  return isSyntheticSystemReferenceId(id);
}
