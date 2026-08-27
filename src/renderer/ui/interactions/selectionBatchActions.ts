import { canDuplicateRow } from '../../../core/actions/rowFacets';
import type { NodeId, NodeProjection } from '../../api/types';
import { api } from '../../api/client';
import {
  selectableRowForId,
  type SelectableRow,
  type SelectableRowActionPolicy,
} from '../../state/selectableRows';
import { commandRunnerNoop, type CommandRunnerResult } from '../shared';

export type SelectionCommandResult = CommandRunnerResult;

export interface SelectionSiblingMovePlacement {
  id: NodeId;
  parentId: NodeId;
  beforeId?: NodeId;
  afterId?: NodeId;
}

type SelectionActionKey = keyof SelectableRowActionPolicy;

export interface SelectionDeletePlan {
  hardDeleteId: NodeId | null;
  trashIds: NodeId[];
  fieldValueIds: NodeId[];
}

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

export function idsAllowedForStructuralIndentBatch(params: {
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
    return Boolean(row?.mutable);
  });
}

export function idsAllowedForStructuralOutdentBatch(params: {
  ids: readonly NodeId[];
  panelRootId: NodeId;
  byId: Map<NodeId, NodeProjection>;
  rowMap?: ReadonlyMap<NodeId, SelectableRow>;
}): NodeId[] {
  return idsAllowedForStructuralBatch(params).filter((id) => {
    const row = resolveSelectableRow({
      id,
      panelRootId: params.panelRootId,
      byId: params.byId,
      rowMap: params.rowMap,
    });
    if (!row) return false;
    return row.parentId !== params.panelRootId;
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

export function idsAllowedForDuplicate(params: {
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
    if (!row || row.actionPolicy.duplicate !== 'node-clone') return false;
    return canDuplicateRow(row, params.byId);
  });
}

export async function runSelectionDelete(params: {
  ids: readonly NodeId[];
  panelRootId: NodeId;
  byId: Map<NodeId, NodeProjection>;
  rowMap?: ReadonlyMap<NodeId, SelectableRow>;
  hardDeleteSingleReferenceId?: NodeId;
}): Promise<SelectionCommandResult> {
  const plan = planSelectionDelete(params);
  if (plan.hardDeleteId) return api.deleteNode(plan.hardDeleteId);

  if (plan.trashIds.length === 0 && plan.fieldValueIds.length === 0) return commandRunnerNoop();
  return api.batchDeleteRows(plan.trashIds, plan.fieldValueIds);
}

export function planSelectionDelete(params: {
  ids: readonly NodeId[];
  panelRootId: NodeId;
  byId: Map<NodeId, NodeProjection>;
  rowMap?: ReadonlyMap<NodeId, SelectableRow>;
  hardDeleteSingleReferenceId?: NodeId;
}): SelectionDeletePlan {
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
    const node = params.byId.get(id);
    if (
      params.hardDeleteSingleReferenceId === id
      && params.ids.length === 1
      && row.kind !== 'fieldValue'
      && row.kind !== 'syntheticSystemValue'
      && node?.type === 'reference'
    ) {
      return { hardDeleteId: id, trashIds: [], fieldValueIds: [] };
    }
    if (row.actionPolicy.delete === 'field-value-remove') fieldValueIds.push(id);
    else if (row.actionPolicy.delete === 'node-trash') trashIds.push(id);
  }
  return { hardDeleteId: null, trashIds, fieldValueIds };
}

export async function runSelectionDuplicate(params: {
  ids: readonly NodeId[];
  panelRootId: NodeId;
  byId: Map<NodeId, NodeProjection>;
  rowMap?: ReadonlyMap<NodeId, SelectableRow>;
}): Promise<SelectionCommandResult> {
  const duplicateIds = idsAllowedForDuplicate(params);
  return duplicateIds.length > 0
    ? api.batchDuplicateNodes(duplicateIds)
    : commandRunnerNoop();
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
  if (moveIds.length === 0) return commandRunnerNoop();
  return params.direction === 'up'
    ? api.batchMoveNodesUp(moveIds)
    : api.batchMoveNodesDown(moveIds);
}

export function planSelectionSiblingMoves(params: {
  ids: readonly NodeId[];
  direction: 'up' | 'down';
  panelRootId: NodeId;
  byId: Map<NodeId, NodeProjection>;
  rowMap?: ReadonlyMap<NodeId, SelectableRow>;
}): SelectionSiblingMovePlacement[] {
  const moveIds = idsEnabledForSelectionAction({
    ids: params.ids,
    action: 'move',
    panelRootId: params.panelRootId,
    byId: params.byId,
    rowMap: params.rowMap,
  });
  const selected = new Set(moveIds);
  const parentIds = [...new Set(moveIds.map((id) => params.byId.get(id)?.parentId))]
    .filter((id): id is NodeId => Boolean(id));
  const placements: SelectionSiblingMovePlacement[] = [];
  for (const parentId of parentIds) {
    const final = [...(params.byId.get(parentId)?.children ?? [])];
    if (params.direction === 'up') {
      for (let index = 1; index < final.length; index += 1) {
        if (selected.has(final[index]!) && !selected.has(final[index - 1]!)) {
          [final[index - 1], final[index]] = [final[index]!, final[index - 1]!];
        }
      }
    } else {
      for (let index = final.length - 2; index >= 0; index -= 1) {
        if (selected.has(final[index]!) && !selected.has(final[index + 1]!)) {
          [final[index], final[index + 1]] = [final[index + 1]!, final[index]!];
        }
      }
    }
    for (let index = 0; index < final.length; index += 1) {
      const id = final[index]!;
      if (!selected.has(id)) continue;
      const previousId = final[index - 1];
      const nextUnselectedId = final.slice(index + 1).find((candidate) => !selected.has(candidate));
      placements.push({
        id,
        parentId,
        ...(previousId ? { afterId: previousId } : nextUnselectedId ? { beforeId: nextUnselectedId } : {}),
      });
    }
  }
  return placements;
}
