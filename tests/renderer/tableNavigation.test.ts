import { describe, expect, test } from 'bun:test';
import {
  nearestTableCell,
  resolveTableCellNavigation,
  TABLE_TITLE_COLUMN_ID,
} from '../../src/renderer/ui/outliner/tableNavigation';

const rows = ['row-a', 'row-b', 'row-c'];
const columns = [TABLE_TITLE_COLUMN_ID, 'status', 'due'];

describe('table cell navigation', () => {
  test('moves in two dimensions and clamps arrow keys at edges', () => {
    expect(resolveTableCellNavigation({
      rows,
      columns,
      current: { rowId: 'row-b', columnId: 'status' },
      key: 'ArrowUp',
    })).toEqual({ rowId: 'row-a', columnId: 'status' });
    expect(resolveTableCellNavigation({
      rows,
      columns,
      current: { rowId: 'row-a', columnId: TABLE_TITLE_COLUMN_ID },
      key: 'ArrowLeft',
    })).toEqual({ rowId: 'row-a', columnId: TABLE_TITLE_COLUMN_ID });
  });

  test('tabs across rows and lets focus leave at either boundary', () => {
    expect(resolveTableCellNavigation({
      rows,
      columns,
      current: { rowId: 'row-a', columnId: 'due' },
      key: 'Tab',
    })).toEqual({ rowId: 'row-b', columnId: TABLE_TITLE_COLUMN_ID });
    expect(resolveTableCellNavigation({
      rows,
      columns,
      current: { rowId: 'row-a', columnId: TABLE_TITLE_COLUMN_ID },
      key: 'Tab',
      shiftKey: true,
    })).toBeNull();
    expect(resolveTableCellNavigation({
      rows,
      columns,
      current: { rowId: 'row-c', columnId: 'due' },
      key: 'Tab',
    })).toBeNull();
  });

  test('supports row and grid Home/End semantics', () => {
    expect(resolveTableCellNavigation({
      rows,
      columns,
      current: { rowId: 'row-b', columnId: 'status' },
      key: 'Home',
    })).toEqual({ rowId: 'row-b', columnId: TABLE_TITLE_COLUMN_ID });
    expect(resolveTableCellNavigation({
      rows,
      columns,
      current: { rowId: 'row-b', columnId: 'status' },
      key: 'End',
      primaryModifier: true,
    })).toEqual({ rowId: 'row-c', columnId: 'due' });
  });

  test('recovers to a surviving logical cell after projection changes', () => {
    expect(nearestTableCell(rows, [TABLE_TITLE_COLUMN_ID, 'status'], {
      rowId: 'removed',
      columnId: 'due',
    })).toEqual({ rowId: 'row-a', columnId: 'status' });
    expect(nearestTableCell([], columns, null)).toBeNull();
  });
});
