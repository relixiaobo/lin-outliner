import {
  isSyntheticSystemValueId,
  nodeRowFacetsFor,
  resolveReferenceChainTargetId,
  type NodeRowAction,
  type NodeRowActionPolicy,
  type NodeRowFacets,
  type NodeRowKind,
} from '../../core/actions/rowFacets';
import type { NodeId, NodeProjection } from '../api/types';
import {
  buildOutlinerRows,
  fieldEntryForViewCell,
  readViewConfig,
  visibleAuthoredTableFieldIds,
  type OutlinerRowItem,
} from './outlinerRows';
import { systemReferenceValueIds } from './systemReferenceRows';

// Row applicability derives from the projection alone and is shared with the
// core action registry (`core/actions/rowFacets.ts`); the pane root is the one
// renderer-owned addition, and only the keyboard-only outdent path reads it.
export type SelectableRowKind = NodeRowKind;
export type SelectableRowAction = NodeRowAction;
export type SelectableRowActionPolicy = NodeRowActionPolicy;

export interface SelectableRow extends NodeRowFacets {
  panelRootId: NodeId;
}

export interface SelectableRowsOptions {
  expanded: ReadonlySet<NodeId>;
  expandedHiddenFields?: Set<string>;
}

interface SelectableRowVisitor {
  onRow: (row: SelectableRow) => void;
  afterRow?: (parentId: NodeId, rowId: NodeId) => void;
  afterScope?: (parentId: NodeId) => void;
}

export function buildSelectableRows(
  panelRootId: NodeId,
  byId: Map<NodeId, NodeProjection>,
  options: SelectableRowsOptions,
): SelectableRow[] {
  const result: SelectableRow[] = [];
  visitSelectableRows(panelRootId, byId, options, {
    onRow: (row) => result.push(row),
  });
  return result;
}

// A renderer-only draft is absent from the selectable model. Mirror its rendered
// insertion point during the same depth-first walk, then return the first row
// visited after it; afterRow runs after descendants, matching the visual tree.
export function selectableRowAfterDraft(
  panelRootId: NodeId,
  byId: Map<NodeId, NodeProjection>,
  options: SelectableRowsOptions,
  placement: { parentId: NodeId; afterId: NodeId | null },
): SelectableRow | null {
  let passedDraft = false;
  let nextRow: SelectableRow | null = null;

  visitSelectableRows(panelRootId, byId, options, {
    onRow: (row) => {
      if (passedDraft && nextRow === null) nextRow = row;
    },
    afterRow: (parentId, rowId) => {
      if (
        !passedDraft
        && placement.afterId === rowId
        && placement.parentId === parentId
      ) {
        passedDraft = true;
      }
    },
    afterScope: (parentId) => {
      if (
        !passedDraft
        && placement.afterId === null
        && placement.parentId === parentId
      ) {
        passedDraft = true;
      }
    },
  });

  return nextRow;
}

function visitSelectableRows(
  panelRootId: NodeId,
  byId: Map<NodeId, NodeProjection>,
  options: SelectableRowsOptions,
  visitor: SelectableRowVisitor,
): void {
  const expandedHiddenFields = options.expandedHiddenFields ?? new Set<string>();

  const visit = (
    parentId: NodeId,
    referencePath: NodeId[],
    suppressFieldEntries = false,
  ) => {
    const parent = byId.get(parentId);
    if (!parent) return;
    const view = readViewConfig(parent, byId);
    const tableFieldDefIds = view.viewMode === 'table'
      ? visibleAuthoredTableFieldIds(view)
      : undefined;
    const rows = buildOutlinerRows(parent, byId, {
      expandedHiddenFields,
      suppressFieldEntries,
    });
    const visitRows = (currentRows: OutlinerRowItem[]) => {
      for (const row of currentRows) {
        if (row.type === 'filteredOut') {
          if (options.expanded.has(row.id)) visitRows(row.rows);
          continue;
        }
        if (row.type !== 'field' && row.type !== 'content') continue;
        visitor.onRow(selectableRowFor({
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
            visitor.onRow(selectableRowFor({
              id: syntheticId,
              parentId: row.id,
              panelRootId,
              byId,
            }));
          }
        }
        if (row.type === 'content' && tableFieldDefIds) {
          const rowNode = byId.get(row.id);
          for (const fieldDefId of tableFieldDefIds) {
            const entry = rowNode ? fieldEntryForViewCell(rowNode, fieldDefId, byId) : undefined;
            if (!entry || referencePath.includes(entry.id)) continue;
            visit(entry.id, [...referencePath, entry.id]);
          }
        }
        const shouldDescend = row.type === 'field' || options.expanded.has(row.id);
        if (shouldDescend) {
          const childParentId = selectableChildParentId(row.id, byId);
          if (childParentId && !referencePath.includes(childParentId)) {
            visit(
              childParentId,
              [...referencePath, childParentId],
              row.type === 'content' && tableFieldDefIds !== undefined,
            );
          }
        }
        visitor.afterRow?.(parentId, row.id);
      }
    };
    visitRows(rows);
    visitor.afterScope?.(parentId);
  };

  visit(panelRootId, [panelRootId]);
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
  return resolveReferenceChainTargetId(node.targetId, byId);
}

export { resolveReferenceChainTargetId as resolveSelectableReferenceTargetId };

function selectableRowFor(params: {
  id: NodeId;
  parentId: NodeId | null;
  panelRootId: NodeId;
  byId: Map<NodeId, NodeProjection>;
}): SelectableRow {
  return {
    ...nodeRowFacetsFor({ id: params.id, parentId: params.parentId, byId: params.byId }),
    panelRootId: params.panelRootId,
  };
}
