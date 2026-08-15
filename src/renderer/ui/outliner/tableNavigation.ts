import { outlineChildIds } from '../../../core/actions/outlineStructure';
import type { NodeFieldSlot } from '../../../core/fieldSlots';
import type { NodeId, NodeProjection } from '../../../core/types';
import type { UiState } from '../../state/document';
import {
  cursorEnd,
  focusTarget,
  requestFocusState,
  requestPendingInputState,
  rowFocusTarget,
} from '../focus/focusModel';

export const TABLE_TITLE_COLUMN_ID = '__title__';

export interface TableCellAddress {
  rowId: string;
  columnId: string;
}

export type TableNavigationKey =
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Home'
  | 'End'
  | 'Tab';

export interface TableNavigationInput {
  rows: readonly string[];
  columns: readonly string[];
  current: TableCellAddress;
  key: TableNavigationKey;
  shiftKey?: boolean;
  primaryModifier?: boolean;
}

export function requestTableFieldSlotEditState(
  state: UiState,
  slot: NodeFieldSlot,
  byId: ReadonlyMap<NodeId, NodeProjection>,
  panelId: string | null,
  seed?: string,
): UiState {
  const entry = slot.entryId ? byId.get(slot.entryId) : undefined;
  const primaryValueId = outlineChildIds(entry, byId)[0];
  const parentId = entry?.type === 'fieldEntry' ? entry.id : slot.id;
  const target = primaryValueId
    ? rowFocusTarget(primaryValueId, parentId, panelId)
    : focusTarget(parentId, parentId, panelId, 'trailing');
  return seed === undefined
    ? requestFocusState(state, target, cursorEnd())
    : requestPendingInputState(state, target, seed, cursorEnd());
}

export function resolveTableCellNavigation(input: TableNavigationInput): TableCellAddress | null {
  const rowIndex = input.rows.indexOf(input.current.rowId);
  const columnIndex = input.columns.indexOf(input.current.columnId);
  if (rowIndex < 0 || columnIndex < 0 || input.rows.length === 0 || input.columns.length === 0) {
    return firstTableCell(input.rows, input.columns);
  }

  if (input.key === 'Tab') {
    const flatIndex = rowIndex * input.columns.length + columnIndex + (input.shiftKey ? -1 : 1);
    if (flatIndex < 0 || flatIndex >= input.rows.length * input.columns.length) return null;
    return {
      rowId: input.rows[Math.floor(flatIndex / input.columns.length)]!,
      columnId: input.columns[flatIndex % input.columns.length]!,
    };
  }

  let nextRow = rowIndex;
  let nextColumn = columnIndex;
  switch (input.key) {
    case 'ArrowUp':
      nextRow = Math.max(0, rowIndex - 1);
      break;
    case 'ArrowDown':
      nextRow = Math.min(input.rows.length - 1, rowIndex + 1);
      break;
    case 'ArrowLeft':
      nextColumn = Math.max(0, columnIndex - 1);
      break;
    case 'ArrowRight':
      nextColumn = Math.min(input.columns.length - 1, columnIndex + 1);
      break;
    case 'Home':
      nextColumn = 0;
      if (input.primaryModifier) nextRow = 0;
      break;
    case 'End':
      nextColumn = input.columns.length - 1;
      if (input.primaryModifier) nextRow = input.rows.length - 1;
      break;
    default:
      break;
  }

  return { rowId: input.rows[nextRow]!, columnId: input.columns[nextColumn]! };
}

export function nearestTableCell(
  rows: readonly string[],
  columns: readonly string[],
  current: TableCellAddress | null,
): TableCellAddress | null {
  if (rows.length === 0 || columns.length === 0) return null;
  if (!current) return firstTableCell(rows, columns);
  const rowId = rows.includes(current.rowId) ? current.rowId : rows[0]!;
  const columnId = columns.includes(current.columnId) ? current.columnId : columns.at(-1)!;
  return { rowId, columnId };
}

function firstTableCell(rows: readonly string[], columns: readonly string[]): TableCellAddress | null {
  if (rows.length === 0 || columns.length === 0) return null;
  return { rowId: rows[0]!, columnId: columns[0]! };
}
