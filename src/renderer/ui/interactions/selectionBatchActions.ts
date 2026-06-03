import { projectFieldConfig } from '../../../core/configProjection';
import type { CommandOutcome, DocumentProjection, NodeId, NodeProjection } from '../../api/types';
import { api } from '../../api/client';
import {
  selectableRowForId,
  type SelectableRow,
  type SelectableRowActionPolicy,
} from '../../state/selectableRows';
import { isOptionsFieldType } from '../fields/fieldTypeRegistry';

export type SelectionCommandResult = CommandOutcome | DocumentProjection;

type SelectionActionKey = keyof SelectableRowActionPolicy;

export function selectableRowMap(rows: readonly SelectableRow[]): Map<NodeId, SelectableRow> {
  return new Map(rows.map((row) => [row.id, row]));
}

function resolveSelectableRow(params: {
  id: NodeId;
  panelRootId: NodeId;
  byId: Map<NodeId, NodeProjection>;
  rowMap?: ReadonlyMap<NodeId, SelectableRow>;
}): SelectableRow | null {
  return params.rowMap?.get(params.id)
    ?? selectableRowForId(params.id, params.panelRootId, params.byId);
}

export function idsEnabledForSelectionAction(params: {
  ids: readonly NodeId[];
  action: SelectionActionKey;
  panelRootId: NodeId;
  byId: Map<NodeId, NodeProjection>;
  rowMap?: ReadonlyMap<NodeId, SelectableRow>;
}): NodeId[] {
  return params.ids.filter((id) => {
    const row = resolveSelectableRow({
      id,
      panelRootId: params.panelRootId,
      byId: params.byId,
      rowMap: params.rowMap,
    });
    return row ? row.actionPolicy[params.action] !== 'disabled' : false;
  });
}

export function idsAllowedForStructuralBatch(params: {
  ids: readonly NodeId[];
  panelRootId: NodeId;
  byId: Map<NodeId, NodeProjection>;
  rowMap?: ReadonlyMap<NodeId, SelectableRow>;
}): NodeId[] {
  return params.ids.filter((id) => {
    const row = resolveSelectableRow({
      id,
      panelRootId: params.panelRootId,
      byId: params.byId,
      rowMap: params.rowMap,
    });
    return Boolean(row?.mutable) && row?.kind !== 'fieldValue';
  });
}

export function idsAllowedForMoveTo(params: {
  ids: readonly NodeId[];
  panelRootId: NodeId;
  byId: Map<NodeId, NodeProjection>;
  rowMap?: ReadonlyMap<NodeId, SelectableRow>;
}): NodeId[] {
  return idsAllowedForStructuralBatch(params);
}

export async function runSelectionDelete(params: {
  ids: readonly NodeId[];
  panelRootId: NodeId;
  byId: Map<NodeId, NodeProjection>;
  rowMap?: ReadonlyMap<NodeId, SelectableRow>;
  hardDeleteSingleReferenceId?: NodeId;
}): Promise<SelectionCommandResult> {
  const trashIds: NodeId[] = [];
  const fieldValueIds: NodeId[] = [];
  for (const id of params.ids) {
    const row = resolveSelectableRow({
      id,
      panelRootId: params.panelRootId,
      byId: params.byId,
      rowMap: params.rowMap,
    });
    if (!row) continue;
    if (
      params.hardDeleteSingleReferenceId === id
      && params.ids.length === 1
      && row.actionPolicy.delete === 'node-trash'
    ) {
      return api.deleteNode(id);
    }
    if (row.actionPolicy.delete === 'field-value-remove') fieldValueIds.push(id);
    else if (row.actionPolicy.delete === 'node-trash') trashIds.push(id);
  }

  let lastResult: SelectionCommandResult | null = null;
  if (trashIds.length > 0) {
    lastResult = await api.batchTrashNodes(trashIds);
  }
  for (const id of fieldValueIds) {
    lastResult = await api.removeFieldValue(id);
  }
  return lastResult ?? api.getProjection();
}

export async function runSelectionDuplicate(params: {
  ids: readonly NodeId[];
  panelRootId: NodeId;
  byId: Map<NodeId, NodeProjection>;
  rowMap?: ReadonlyMap<NodeId, SelectableRow>;
}): Promise<SelectionCommandResult> {
  const duplicateIds = params.ids.filter((id) => {
    const row = resolveSelectableRow({
      id,
      panelRootId: params.panelRootId,
      byId: params.byId,
      rowMap: params.rowMap,
    });
    if (!row || row.actionPolicy.duplicate !== 'node-clone') return false;
    return canDuplicateSelectableRow(row, params.byId);
  });
  return duplicateIds.length > 0
    ? api.batchDuplicateNodes(duplicateIds)
    : api.getProjection();
}

export async function runSelectionMove(params: {
  ids: readonly NodeId[];
  direction: 'up' | 'down';
  panelRootId: NodeId;
  byId: Map<NodeId, NodeProjection>;
  rowMap?: ReadonlyMap<NodeId, SelectableRow>;
}): Promise<SelectionCommandResult> {
  const moveIds = idsEnabledForSelectionAction({
    ids: params.ids,
    action: 'move',
    panelRootId: params.panelRootId,
    byId: params.byId,
    rowMap: params.rowMap,
  });
  if (moveIds.length === 0) return api.getProjection();
  return params.direction === 'up'
    ? api.batchMoveNodesUp(moveIds)
    : api.batchMoveNodesDown(moveIds);
}

function canDuplicateSelectableRow(
  row: SelectableRow,
  byId: Map<NodeId, NodeProjection>,
): boolean {
  if (row.kind !== 'fieldValue') return true;
  const valueNode = byId.get(row.id);
  if (!valueNode || valueNode.type === 'reference') return false;
  const fieldEntry = row.parentId ? byId.get(row.parentId) : undefined;
  if (fieldEntry?.type !== 'fieldEntry') return false;
  const fieldDef = fieldEntry.fieldDefId ? byId.get(fieldEntry.fieldDefId) : undefined;
  const fieldType = fieldDef ? projectFieldConfig(byId, fieldDef).fieldType : undefined;
  if (isOptionsFieldType(fieldType) || fieldType === 'reference' || fieldType === 'checkbox') return false;
  return true;
}
