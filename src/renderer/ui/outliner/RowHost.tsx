import { Fragment, type ReactNode } from 'react';
import type { OutlinerRowItem } from './row-model';

interface RowHostProps {
  rows: OutlinerRowItem[];
  renderField: (row: Extract<OutlinerRowItem, { type: 'field' }>, index: number, rows: OutlinerRowItem[]) => ReactNode;
  renderContent: (row: Extract<OutlinerRowItem, { type: 'content' }>, index: number, rows: OutlinerRowItem[]) => ReactNode;
  renderFilteredOut?: (row: Extract<OutlinerRowItem, { type: 'filteredOut' }>, index: number, rows: OutlinerRowItem[]) => ReactNode;
  renderHiddenField?: (row: Extract<OutlinerRowItem, { type: 'hiddenField' }>, index: number, rows: OutlinerRowItem[]) => ReactNode;
  renderGroup?: (row: Extract<OutlinerRowItem, { type: 'group' }>, index: number, rows: OutlinerRowItem[]) => ReactNode;
  isFilteredOutExpanded?: (row: Extract<OutlinerRowItem, { type: 'filteredOut' }>) => boolean;
}

export function RowHost(props: RowHostProps) {
  const renderRow = (row: OutlinerRowItem, index: number) => {
    if (row.type === 'field') return props.renderField(row, index, props.rows);
    if (row.type === 'content') return props.renderContent(row, index, props.rows);
    if (row.type === 'filteredOut') {
      return (
        <>
          {props.renderFilteredOut?.(row, index, props.rows) ?? null}
          {props.isFilteredOutExpanded?.(row) ? (
            <RowHost
              {...props}
              rows={row.rows}
            />
          ) : null}
        </>
      );
    }
    if (row.type === 'hiddenField') {
      return props.renderHiddenField?.(row, index, props.rows) ?? null;
    }
    return props.renderGroup?.(row, index, props.rows) ?? null;
  };

  return (
    <>
      {props.rows.map((row, index) => (
        <Fragment key={row.id}>
          {renderRow(row, index)}
        </Fragment>
      ))}
    </>
  );
}
