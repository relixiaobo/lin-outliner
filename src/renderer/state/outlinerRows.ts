import { parseDateFieldValueRange, type FilterOperator, type NodeId, type NodeProjection, type SortDirection, type ViewMode } from '../api/types';
import { projectFieldConfig, projectFieldTypeById } from '../../core/configProjection';

export const NAME_FIELD = 'sys:name';
export const CREATED_FIELD = 'sys:createdAt';
export const UPDATED_FIELD = 'sys:updatedAt';
export const DONE_FIELD = 'sys:done';
export const DONE_AT_FIELD = 'sys:doneAt';
export const TAGS_FIELD = 'sys:tags';
export const REF_COUNT_FIELD = 'sys:refCount';

const INTERNAL_NODE_TYPES = new Set<NodeProjection['type']>([
  'queryCondition',
  'viewDef',
  'sortRule',
  'filterRule',
  'displayField',
  // config-as-nodes: definition config rows + system enum options are never
  // ordinary outliner children. The config surface renders defConfig rows
  // explicitly (opt-in); everything else excludes them here.
  'defConfig',
  'systemOption',
]);

export type OutlinerRowItem =
  | { id: NodeId; type: 'field' }
  // `draft` marks a renderer-only trailing row whose node is not in the
  // projection yet (eager materialization). `buildOutlinerRows` never emits it;
  // it is appended in the render layer so it stays out of nav/selection/agent
  // context until the user types and it materializes.
  | { id: NodeId; type: 'content'; draft?: boolean }
  | { id: string; type: 'group'; label: string }
  | { id: string; type: 'hiddenField'; fieldId: NodeId; label: string };

export interface RowBuildOptions {
  expandedHiddenFields?: Set<string>;
}

export interface ViewSortRule {
  id: NodeId;
  field: string;
  direction: SortDirection;
}

export interface ViewFilterRule {
  id: NodeId;
  field: string;
  operator: FilterOperator;
  valueLogic: 'all' | 'any';
  values: string[];
}

export interface ViewDisplayField {
  id: NodeId;
  field: string;
  visible: boolean;
  width?: number;
  label?: string;
  placement?: string;
}

export interface ViewConfig {
  viewDefId: NodeId | null;
  viewMode: ViewMode;
  toolbarVisible: boolean;
  groupField: string | null;
  sortRules: ViewSortRule[];
  filterRules: ViewFilterRule[];
  displayFields: ViewDisplayField[];
}

export function hiddenFieldKey(parentId: NodeId, fieldEntryId: NodeId): string {
  return `${parentId}:${fieldEntryId}`;
}

export function readViewConfig(parent: NodeProjection | undefined, byId: Map<NodeId, NodeProjection>): ViewConfig {
  const viewDef = directChildren(parent, byId)
    .find((child): child is Extract<NodeProjection, { type: 'viewDef' }> => child.type === 'viewDef');
  if (!viewDef) {
    return {
      viewDefId: null,
      viewMode: 'list',
      toolbarVisible: false,
      groupField: null,
      sortRules: [],
      filterRules: [],
      displayFields: [],
    };
  }

  const viewChildren = directChildren(viewDef, byId);
  return {
    viewDefId: viewDef.id,
    viewMode: viewDef.viewMode ?? 'list',
    toolbarVisible: Boolean(viewDef.toolbarVisible),
    groupField: viewDef.groupField ?? null,
    sortRules: viewChildren
      .filter((child): child is Extract<NodeProjection, { type: 'sortRule' }> => child.type === 'sortRule' && Boolean(child.sortField))
      .map((child) => ({
        id: child.id,
        field: child.sortField!,
        direction: child.sortDirection === 'desc' ? 'desc' : 'asc',
      })),
    filterRules: viewChildren
      .filter((child): child is Extract<NodeProjection, { type: 'filterRule' }> => child.type === 'filterRule' && Boolean(child.filterField))
      .map((child) => ({
        id: child.id,
        field: child.filterField!,
        operator: child.filterOperator ?? 'contains',
        valueLogic: child.filterValueLogic ?? 'any',
        values: child.filterValues ?? [],
      })),
    displayFields: viewChildren
      .filter((child): child is Extract<NodeProjection, { type: 'displayField' }> => child.type === 'displayField' && Boolean(child.displayField))
      .map((child) => ({
        id: child.id,
        field: child.displayField!,
        visible: child.displayVisible !== false,
        width: child.displayWidth,
        label: child.displayLabel,
        placement: child.displayPlacement,
      })),
  };
}

function directChildren(parent: NodeProjection | undefined, byId: Map<NodeId, NodeProjection>): NodeProjection[] {
  return parent?.children
    .map((childId) => byId.get(childId))
    .filter((child): child is NodeProjection => Boolean(child)) ?? [];
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
  return displayed.children
    .map((childId) => childText(byId.get(childId), byId))
    .filter(Boolean)
    .join(' ');
}

function fieldValuesFor(rowNode: NodeProjection, fieldId: string, byId: Map<NodeId, NodeProjection>): string[] {
  const displayed = displayNode(rowNode, byId);
  if (fieldId === NAME_FIELD) return [childText(displayed, byId)].filter(Boolean);
  if (fieldId === CREATED_FIELD) return [String(displayed.createdAt)];
  if (fieldId === UPDATED_FIELD) return [String(displayed.updatedAt)];
  if (fieldId === DONE_FIELD) return [displayed.completedAt ? 'true' : 'false'];
  if (fieldId === DONE_AT_FIELD) return displayed.completedAt ? [String(displayed.completedAt)] : [];
  if (fieldId === TAGS_FIELD) {
    return displayed.tags.map((tagId) => byId.get(tagId)?.content.text || tagId);
  }
  if (fieldId === REF_COUNT_FIELD) {
    let count = 0;
    for (const node of byId.values()) {
      if (node.type === 'reference' && node.targetId === displayed.id) count += 1;
    }
    return [String(count)];
  }

  const fieldEntry = displayed.children
    .map((childId) => byId.get(childId))
    .find((child) => child?.type === 'fieldEntry' && child.fieldDefId === fieldId);
  if (!fieldEntry) return [];

  const values = fieldEntry.children
    .map((childId) => childText(byId.get(childId), byId))
    .filter(Boolean);
  return values.length > 0 ? values : [childText(fieldEntry, byId)].filter(Boolean);
}

function fieldTextFor(rowNode: NodeProjection, fieldId: string, byId: Map<NodeId, NodeProjection>): string {
  return fieldValuesFor(rowNode, fieldId, byId).join(' ');
}

function fieldNumberFor(rowNode: NodeProjection, fieldId: string, byId: Map<NodeId, NodeProjection>): number | null {
  const value = fieldValuesFor(rowNode, fieldId, byId)[0];
  if (value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
  const mode = field ? projectFieldConfig(byId, field).hideField : undefined;
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

function compareRowsByField(
  left: OutlinerRowItem,
  right: OutlinerRowItem,
  byId: Map<NodeId, NodeProjection>,
  fieldId: string,
): number {
  if (left.type !== 'content' && left.type !== 'field') return 1;
  if (right.type !== 'content' && right.type !== 'field') return -1;
  const leftNode = byId.get(left.id);
  const rightNode = byId.get(right.id);
  if (!leftNode || !rightNode) return 0;

  if ([CREATED_FIELD, UPDATED_FIELD, DONE_AT_FIELD, REF_COUNT_FIELD].includes(fieldId)) {
    const leftNumber = fieldNumberFor(leftNode, fieldId, byId) ?? Number.POSITIVE_INFINITY;
    const rightNumber = fieldNumberFor(rightNode, fieldId, byId) ?? Number.POSITIVE_INFINITY;
    return leftNumber - rightNumber;
  }
  if (fieldId === DONE_FIELD) {
    const leftDone = displayNode(leftNode, byId).completedAt ? 1 : 0;
    const rightDone = displayNode(rightNode, byId).completedAt ? 1 : 0;
    return leftDone - rightDone;
  }

  const leftText = fieldTextFor(leftNode, fieldId, byId).toLocaleLowerCase();
  const rightText = fieldTextFor(rightNode, fieldId, byId).toLocaleLowerCase();
  return leftText.localeCompare(rightText, undefined, { numeric: true, sensitivity: 'base' });
}

function filterRows(
  view: ViewConfig,
  rows: OutlinerRowItem[],
  byId: Map<NodeId, NodeProjection>,
): OutlinerRowItem[] {
  if (view.filterRules.length === 0) return rows;
  return rows.filter((row) => {
    if (row.type !== 'content' && row.type !== 'field') return true;
    const node = byId.get(row.id);
    if (!node) return false;
    return view.filterRules.every((rule) => rowMatchesFilter(node, rule, byId));
  });
}

function isDateFilterField(fieldId: string, byId: Map<NodeId, NodeProjection>): boolean {
  if (fieldId === CREATED_FIELD || fieldId === UPDATED_FIELD || fieldId === DONE_AT_FIELD) return true;
  return projectFieldTypeById(byId, fieldId) === 'date';
}

// Resolves a date filter operand to an absolute [start, endExclusive) span. Handles
// both system date fields (stored as epoch-ms strings) and custom date fields
// (ISO local dates/ranges), so after/before/is compare uniformly across them.
function dateFilterSpan(value: string): { startMs: number; endExclusiveMs: number } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^-?\d+$/.test(trimmed)) {
    const ms = Number(trimmed);
    return Number.isFinite(ms) ? { startMs: ms, endExclusiveMs: ms + 1 } : null;
  }
  return parseDateFieldValueRange(trimmed);
}

function rowMatchesDateFilter(rule: ViewFilterRule, values: string[], expected: string[]): boolean {
  const fieldSpans = values.map(dateFilterSpan).filter((span): span is { startMs: number; endExclusiveMs: number } => span !== null);
  if (fieldSpans.length === 0) return false;
  const matchOne = (target: string) => {
    const span = dateFilterSpan(target);
    if (!span) return false;
    if (rule.operator === 'before') return fieldSpans.some((field) => field.startMs < span.startMs);
    if (rule.operator === 'after') return fieldSpans.some((field) => field.startMs >= span.endExclusiveMs);
    const within = fieldSpans.some((field) => field.startMs >= span.startMs && field.startMs < span.endExclusiveMs);
    return rule.operator === 'is_not' ? !within : within;
  };
  return rule.valueLogic === 'all' ? expected.every(matchOne) : expected.some(matchOne);
}

function rowMatchesFilter(node: NodeProjection, rule: ViewFilterRule, byId: Map<NodeId, NodeProjection>): boolean {
  const values = fieldValuesFor(node, rule.field, byId);
  const normalizedValues = values.map((value) => value.toLocaleLowerCase());
  const expected = rule.values.map((value) => value.trim().toLocaleLowerCase()).filter(Boolean);

  if (rule.operator === 'is_empty') return values.length === 0 || values.every((value) => !value.trim());
  if (rule.operator === 'is_not_empty') return values.some((value) => value.trim());
  if (expected.length === 0) return true;

  if (isDateFilterField(rule.field, byId)) {
    return rowMatchesDateFilter(rule, values, rule.values.map((value) => value.trim()).filter(Boolean));
  }

  const compareOne = (target: string) => {
    if (rule.operator === 'is') return normalizedValues.includes(target);
    if (rule.operator === 'is_not') return !normalizedValues.includes(target);
    if (rule.operator === 'contains') return normalizedValues.some((value) => value.includes(target));
    if (rule.operator === 'not_contains') return normalizedValues.every((value) => !value.includes(target));
    const numericTarget = Number(target);
    const numericValues = normalizedValues.map(Number).filter(Number.isFinite);
    if (rule.operator === 'gt' || rule.operator === 'after') return numericValues.some((value) => value > numericTarget);
    if (rule.operator === 'lt' || rule.operator === 'before') return numericValues.some((value) => value < numericTarget);
    return true;
  };

  return rule.valueLogic === 'all'
    ? expected.every(compareOne)
    : expected.some(compareOne);
}

function sortRows(
  view: ViewConfig,
  rows: OutlinerRowItem[],
  byId: Map<NodeId, NodeProjection>,
): OutlinerRowItem[] {
  if (view.sortRules.length === 0) return rows;
  const sortedRows = [...rows];
  sortedRows.sort((left, right) => {
    for (const rule of view.sortRules) {
      const result = compareRowsByField(left, right, byId, rule.field);
      if (result !== 0) return rule.direction === 'desc' ? -result : result;
    }
    return 0;
  });
  return sortedRows;
}

function isBooleanGroupField(fieldId: string, byId: Map<NodeId, NodeProjection>): boolean {
  if (fieldId === DONE_FIELD) return true;
  const fieldType = projectFieldTypeById(byId, fieldId);
  return fieldType === 'checkbox' || fieldType === 'boolean';
}

const GROUP_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Turns a row's raw field values into a display bucket. boolean → Done/Yes
// wording, date → one bucket per calendar day, everything else → the sorted
// values joined. sortKey orders the headers (chronological for dates, empty last).
function groupBucket(
  fieldId: string,
  values: string[],
  byId: Map<NodeId, NodeProjection>,
): { key: string; label: string; sortKey: string } {
  const trimmed = values.map((value) => value.trim()).filter(Boolean);
  if (trimmed.length === 0) return { key: '(empty)', label: '(Empty)', sortKey: '￿' };

  if (isBooleanGroupField(fieldId, byId)) {
    const isTrue = trimmed[0].toLocaleLowerCase() === 'true';
    const [onLabel, offLabel] = fieldId === DONE_FIELD ? ['Done', 'Not done'] : ['Yes', 'No'];
    return { key: isTrue ? 'true' : 'false', label: isTrue ? onLabel : offLabel, sortKey: isTrue ? '0' : '1' };
  }

  if (isDateFilterField(fieldId, byId)) {
    const span = dateFilterSpan(trimmed[0]);
    if (span) {
      const date = new Date(span.startMs);
      const dayKey = localDayKey(date);
      return { key: dayKey, label: GROUP_DATE_FORMAT.format(date), sortKey: dayKey };
    }
  }

  const label = trimmed.sort((a, b) => a.localeCompare(b)).join(', ');
  const key = label.toLocaleLowerCase();
  return { key, label, sortKey: key };
}

function groupRows(
  parent: NodeProjection,
  view: ViewConfig,
  rows: OutlinerRowItem[],
  byId: Map<NodeId, NodeProjection>,
): OutlinerRowItem[] {
  const fieldId = view.groupField;
  if (!fieldId) return rows;

  const groups = new Map<string, { label: string; sortKey: string; rows: OutlinerRowItem[] }>();
  const passthrough: OutlinerRowItem[] = [];
  for (const row of rows) {
    if (row.type !== 'content' && row.type !== 'field') {
      passthrough.push(row);
      continue;
    }
    const node = byId.get(row.id);
    const values = node ? fieldValuesFor(node, fieldId, byId) : [];
    const bucket = groupBucket(fieldId, values, byId);
    const group = groups.get(bucket.key) ?? { label: bucket.label, sortKey: bucket.sortKey, rows: [] };
    group.rows.push(row);
    groups.set(bucket.key, group);
  }

  const result = [...passthrough];
  for (const [key, group] of [...groups.entries()].sort((left, right) =>
    left[1].sortKey.localeCompare(right[1].sortKey),
  )) {
    result.push({
      id: `group:${parent.id}:${fieldId}:${key}`,
      type: 'group',
      label: group.label,
    });
    result.push(...group.rows);
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
    if (child.type && INTERNAL_NODE_TYPES.has(child.type)) continue;
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
  const view = readViewConfig(parent, byId);
  return groupRows(parent, view, sortRows(view, filterRows(view, rows, byId), byId), byId);
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
  if (fieldId === CREATED_FIELD) return 'Created';
  if (fieldId === UPDATED_FIELD) return 'Last edited';
  if (fieldId === DONE_FIELD) return 'Done';
  if (fieldId === DONE_AT_FIELD) return 'Done time';
  if (fieldId === TAGS_FIELD) return 'Tags';
  if (fieldId === REF_COUNT_FIELD) return 'References';
  return nodeTitle(byId.get(fieldId)) || 'Field';
}

export function collectViewFieldChoices(
  parent: NodeProjection,
  byId: Map<NodeId, NodeProjection>,
): Array<{ id: string; label: string; section: 'System fields' | 'Fields' }> {
  const choices = new Map<string, { label: string; section: 'System fields' | 'Fields' }>([
    [NAME_FIELD, { label: 'Name', section: 'System fields' }],
    [CREATED_FIELD, { label: 'Created', section: 'System fields' }],
    [UPDATED_FIELD, { label: 'Last edited', section: 'System fields' }],
    [DONE_FIELD, { label: 'Done', section: 'System fields' }],
    [DONE_AT_FIELD, { label: 'Done time', section: 'System fields' }],
    [TAGS_FIELD, { label: 'Tags', section: 'System fields' }],
    [REF_COUNT_FIELD, { label: 'References', section: 'System fields' }],
  ]);
  for (const childId of parent.children) {
    const child = byId.get(childId);
    if (!child) continue;
    const displayed = displayNode(child, byId);
    for (const nestedId of displayed.children) {
      const nested = byId.get(nestedId);
      if (nested?.type !== 'fieldEntry' || !nested.fieldDefId) continue;
      choices.set(nested.fieldDefId, { label: fieldChoiceLabel(nested.fieldDefId, byId), section: 'Fields' });
    }
  }
  for (const node of byId.values()) {
    if (node.type === 'fieldDef') {
      choices.set(node.id, { label: fieldChoiceLabel(node.id, byId), section: 'Fields' });
    }
  }
  return [...choices.entries()]
    .map(([id, choice]) => ({ id, ...choice }))
    .sort((a, b) => a.section.localeCompare(b.section) || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}
