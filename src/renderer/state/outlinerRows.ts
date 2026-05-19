import type { NodeId, NodeProjection } from '../api/types';

export const NAME_FIELD = '__name';

export type OutlinerRowItem =
  | { id: NodeId; type: 'field' }
  | { id: NodeId; type: 'content' }
  | { id: string; type: 'group'; label: string }
  | { id: string; type: 'hiddenField'; fieldId: NodeId; label: string };

export interface RowBuildOptions {
  expandedHiddenFields?: Set<string>;
}

export function hiddenFieldKey(parentId: NodeId, fieldEntryId: NodeId): string {
  return `${parentId}:${fieldEntryId}`;
}

function nodeTitle(node: NodeProjection | undefined): string {
  return node?.content.text || 'Untitled';
}

function displayNode(node: NodeProjection, byId: Map<NodeId, NodeProjection>): NodeProjection {
  if (node.type === 'reference' && node.targetId) {
    return byId.get(node.targetId) ?? node;
  }
  return node;
}

function fieldLabel(entry: NodeProjection, byId: Map<NodeId, NodeProjection>): string {
  const field = entry.fieldDefId ? byId.get(entry.fieldDefId) : undefined;
  return nodeTitle(field) || nodeTitle(entry) || 'Field';
}

function childText(node: NodeProjection | undefined, byId: Map<NodeId, NodeProjection>): string {
  if (!node) return '';
  const displayed = displayNode(node, byId);
  const own = displayed.content.text;
  if (own) return own;
  return node.children
    .map((childId) => childText(byId.get(childId), byId))
    .filter(Boolean)
    .join(' ');
}

function fieldValueFor(rowNode: NodeProjection, fieldId: string, byId: Map<NodeId, NodeProjection>): string {
  if (fieldId === NAME_FIELD) {
    return childText(rowNode, byId);
  }

  const fieldEntry = rowNode.children
    .map((childId) => byId.get(childId))
    .find((child) => child?.type === 'fieldEntry' && child.fieldDefId === fieldId);
  if (!fieldEntry) return '';

  const valueText = fieldEntry.children
    .map((childId) => childText(byId.get(childId), byId))
    .filter(Boolean)
    .join(' ');
  return valueText || childText(fieldEntry, byId);
}

function hiddenFieldValue(entry: NodeProjection, byId: Map<NodeId, NodeProjection>): string {
  return entry.children
    .map((childId) => childText(byId.get(childId), byId))
    .filter(Boolean)
    .join(' ');
}

function isHiddenFieldEntry(entry: NodeProjection, byId: Map<NodeId, NodeProjection>): boolean {
  if (entry.type !== 'fieldEntry') return false;
  const field = entry.fieldDefId ? byId.get(entry.fieldDefId) : undefined;
  const mode = entry.hideField ?? field?.hideField;
  if (mode === 'always' || mode === 'hidden') return true;
  const value = hiddenFieldValue(entry, byId).trim();
  if (mode === 'empty') return value.length === 0;
  if (mode === 'not_empty') return value.length > 0;
  if (mode === 'value_is_default') {
    const templateEntry = entry.templateId ? byId.get(entry.templateId) : undefined;
    const defaultValue = templateEntry ? hiddenFieldValue(templateEntry, byId).trim() : '';
    return defaultValue.length > 0 && value === defaultValue;
  }
  return false;
}

function rowSortText(row: OutlinerRowItem, byId: Map<NodeId, NodeProjection>, fieldId: string): string {
  if (row.type !== 'content' && row.type !== 'field') return '';
  const node = byId.get(row.id);
  return node ? fieldValueFor(node, fieldId, byId).toLocaleLowerCase() : '';
}

function filterRows(
  parent: NodeProjection,
  rows: OutlinerRowItem[],
  byId: Map<NodeId, NodeProjection>,
): OutlinerRowItem[] {
  const fieldId = parent.filterField;
  const values = parent.filterValues.map((value) => value.trim().toLocaleLowerCase()).filter(Boolean);
  if (!fieldId || values.length === 0) return rows;

  const op = parent.filterOp ?? 'all';
  return rows.filter((row) => {
    if (row.type !== 'content' && row.type !== 'field') return true;
    const node = byId.get(row.id);
    if (!node) return false;
    const haystack = fieldValueFor(node, fieldId, byId).toLocaleLowerCase();
    return op === 'any'
      ? values.some((value) => haystack.includes(value))
      : values.every((value) => haystack.includes(value));
  });
}

function sortRows(
  parent: NodeProjection,
  rows: OutlinerRowItem[],
  byId: Map<NodeId, NodeProjection>,
): OutlinerRowItem[] {
  const fieldId = parent.sortField;
  if (!fieldId) return rows;

  const direction = parent.sortDirection ?? 'asc';
  const sortedRows = [...rows];
  sortedRows.sort((a, b) => {
    if (a.type === 'hiddenField' || a.type === 'group') return 1;
    if (b.type === 'hiddenField' || b.type === 'group') return -1;
    const left = rowSortText(a, byId, fieldId);
    const right = rowSortText(b, byId, fieldId);
    const result = left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
    return direction === 'desc' ? -result : result;
  });
  return sortedRows;
}

function groupRows(
  parent: NodeProjection,
  rows: OutlinerRowItem[],
  byId: Map<NodeId, NodeProjection>,
): OutlinerRowItem[] {
  const fieldId = parent.groupField;
  if (!fieldId) return rows;

  const result: OutlinerRowItem[] = [];
  let currentGroup: string | null = null;
  for (const row of rows) {
    if (row.type !== 'content' && row.type !== 'field') {
      result.push(row);
      continue;
    }

    const node = byId.get(row.id);
    const value = node ? fieldValueFor(node, fieldId, byId).trim() : '';
    const group = value || 'No group';
    if (group !== currentGroup) {
      currentGroup = group;
      result.push({
        id: `group:${parent.id}:${fieldId}:${group}`,
        type: 'group',
        label: group,
      });
    }
    result.push(row);
  }
  return result;
}

function buildChildRows(
  parent: NodeProjection | undefined,
  byId: Map<NodeId, NodeProjection>,
  options: RowBuildOptions = {},
): OutlinerRowItem[] {
  if (!parent) return [];
  const rows: OutlinerRowItem[] = [];
  for (const childId of parent.children) {
    const child = byId.get(childId);
    if (!child) continue;
    if (
      child.type === 'fieldEntry'
      && isHiddenFieldEntry(child, byId)
      && !options.expandedHiddenFields?.has(hiddenFieldKey(parent.id, child.id))
    ) {
      rows.push({
        id: `hidden:${parent.id}:${child.id}`,
        type: 'hiddenField',
        fieldId: child.id,
        label: fieldLabel(child, byId),
      });
      continue;
    }
    rows.push({
      id: childId,
      type: child.type === 'fieldEntry' ? 'field' : 'content',
    });
  }

  return rows;
}

function applyViewSettings(
  parent: NodeProjection,
  rows: OutlinerRowItem[],
  byId: Map<NodeId, NodeProjection>,
): OutlinerRowItem[] {
  return groupRows(parent, sortRows(parent, filterRows(parent, rows, byId), byId), byId);
}

export function buildOutlinerRows(
  parent: NodeProjection | undefined,
  byId: Map<NodeId, NodeProjection>,
  options: RowBuildOptions = {},
): OutlinerRowItem[] {
  if (!parent) return [];
  return applyViewSettings(parent, buildChildRows(parent, byId, options), byId);
}

export function shouldShowTrailingInput(
  rows: OutlinerRowItem[],
  options: { mode?: 'body' | 'fieldValue' } = {},
): boolean {
  if (options.mode !== 'fieldValue') return true;

  const lastNodeRow = rows.filter((row) => row.type === 'field' || row.type === 'content').at(-1);
  if (!lastNodeRow) return true;
  return lastNodeRow.type === 'field';
}

export function fieldChoiceLabel(fieldId: string, byId: Map<NodeId, NodeProjection>): string {
  if (fieldId === NAME_FIELD) return 'Name';
  return nodeTitle(byId.get(fieldId)) || 'Field';
}

export function collectViewFieldChoices(
  parent: NodeProjection,
  byId: Map<NodeId, NodeProjection>,
): Array<{ id: string; label: string }> {
  const choices = new Map<string, string>([[NAME_FIELD, 'Name']]);
  for (const childId of parent.children) {
    const child = byId.get(childId);
    if (!child) continue;
    for (const nestedId of child.children) {
      const nested = byId.get(nestedId);
      if (nested?.type !== 'fieldEntry' || !nested.fieldDefId) continue;
      choices.set(nested.fieldDefId, fieldChoiceLabel(nested.fieldDefId, byId));
    }
  }
  for (const node of byId.values()) {
    if (node.type === 'fieldDef') {
      choices.set(node.id, fieldChoiceLabel(node.id, byId));
    }
  }
  return [...choices.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}
