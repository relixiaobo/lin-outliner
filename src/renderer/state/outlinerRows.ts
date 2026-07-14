import { parseDateFieldValueRange, type FilterOperator, type NodeId, type NodeProjection, type SortDirection, type ViewMode } from '../api/types';
import { nodeShowsCheckbox, projectFieldConfig, projectFieldTypeById } from '../../core/configProjection';
import {
  CREATED_FIELD,
  DAY_FIELD,
  DONE_AT_FIELD,
  DONE_FIELD,
  NAME_FIELD,
  OWNER_FIELD,
  REF_COUNT_FIELD,
  TAGS_FIELD,
  UPDATED_FIELD,
  isSystemFieldId,
  systemFieldDisplay,
  systemFieldLabel,
  systemFieldValues,
  type SystemFieldContext,
} from '../../core/systemFields';
import type { ReferenceSummary } from '../../core/references';

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
  | { id: NodeId; type: 'content'; draft?: boolean; afterId?: NodeId | null }
  | { id: string; type: 'group'; label: string }
  | { id: string; type: 'filteredOut'; count: number; rows: OutlinerRowItem[] }
  | { id: string; type: 'hiddenField'; fieldId: NodeId; label: string };

export interface RowBuildOptions {
  expandedHiddenFields?: Set<string>;
  systemFieldContext?: SystemFieldContext;
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

export interface ViewFieldValue {
  id: NodeId;
  field: string;
  label: string;
  values: string[];
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
  const fieldDefId = entry.type === 'fieldEntry' ? entry.fieldDefId : undefined;
  const field = fieldDefId ? byId.get(fieldDefId) : undefined;
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

function displayFieldValuesFor(
  rowNode: NodeProjection,
  fieldId: string,
  byId: Map<NodeId, NodeProjection>,
  systemFieldContext?: SystemFieldContext,
): string[] {
  const displayed = displayNode(rowNode, byId);
  if (!isSystemFieldId(fieldId)) return viewFieldValuesFor(rowNode, fieldId, byId, systemFieldContext);
  if (fieldId === NAME_FIELD) return viewFieldValuesFor(rowNode, fieldId, byId, systemFieldContext);

  const display = systemFieldDisplay(displayed, fieldId, byId, systemFieldContext);
  switch (display.kind) {
    case 'done':
      return [display.checked ? 'Done' : 'Not done'];
    case 'date':
      return display.text ? [display.text] : [];
    case 'dayRef':
      return display.text ? [display.text] : [];
    case 'tags':
      return display.tagIds.map((tagId) => byId.get(tagId)?.content.text || tagId).filter(Boolean);
    case 'nodeRefs':
      return display.refs.map((ref) => ref.label).filter(Boolean);
    case 'text':
      return display.text ? [display.text] : [];
    default:
      return [];
  }
}

export function viewFieldValuesFor(
  rowNode: NodeProjection,
  fieldId: string,
  byId: Map<NodeId, NodeProjection>,
  systemFieldContext?: SystemFieldContext,
): string[] {
  const displayed = displayNode(rowNode, byId);
  // Name reads the node's own (possibly nested) text; every other system field is
  // a computed projection resolved by the shared `systemFields` module.
  if (fieldId === NAME_FIELD) return [childText(displayed, byId)].filter(Boolean);
  if (isSystemFieldId(fieldId)) return systemFieldValues(displayed, fieldId, byId, systemFieldContext);

  const fieldEntry = displayed.children
    .map((childId) => byId.get(childId))
    .find((child) => child?.type === 'fieldEntry' && child.fieldDefId === fieldId);
  if (!fieldEntry) return [];

  const values = fieldEntry.children
    .map((childId) => childText(byId.get(childId), byId))
    .filter(Boolean);
  return values.length > 0 ? values : [childText(fieldEntry, byId)].filter(Boolean);
}

function fieldTextFor(
  rowNode: NodeProjection,
  fieldId: string,
  byId: Map<NodeId, NodeProjection>,
  systemFieldContext?: SystemFieldContext,
): string {
  return viewFieldValuesFor(rowNode, fieldId, byId, systemFieldContext).join(' ');
}

function fieldNumberFor(
  rowNode: NodeProjection,
  fieldId: string,
  byId: Map<NodeId, NodeProjection>,
  systemFieldContext?: SystemFieldContext,
): number | null {
  const value = viewFieldValuesFor(rowNode, fieldId, byId, systemFieldContext)[0];
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

function isViewDateField(fieldId: string, byId: Map<NodeId, NodeProjection>): boolean {
  if (fieldId === CREATED_FIELD || fieldId === UPDATED_FIELD || fieldId === DONE_AT_FIELD || fieldId === DAY_FIELD) return true;
  return projectFieldTypeById(byId, fieldId) === 'date';
}

function parseDateValueSpan(value: string): { startMs: number; endExclusiveMs: number } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^-?\d+$/.test(trimmed)) {
    const ms = Number(trimmed);
    return Number.isFinite(ms) ? { startMs: ms, endExclusiveMs: ms + 1 } : null;
  }
  return parseDateFieldValueRange(trimmed);
}

function dateSpanForFieldValue(
  fieldId: string,
  value: string,
): { startMs: number; endExclusiveMs: number } | null {
  const span = parseDateValueSpan(value);
  if (span) return span;
  if (fieldId !== DAY_FIELD) return null;
  const match = value.trim().match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  return match ? parseDateValueSpan(match[0]) : null;
}

function fieldDateFor(
  rowNode: NodeProjection,
  fieldId: string,
  byId: Map<NodeId, NodeProjection>,
  systemFieldContext?: SystemFieldContext,
): number | null {
  if (!isViewDateField(fieldId, byId)) return null;
  const value = viewFieldValuesFor(rowNode, fieldId, byId, systemFieldContext)[0];
  if (value === undefined) return null;
  return dateSpanForFieldValue(fieldId, value)?.startMs ?? null;
}

function isViewNumberField(fieldId: string, byId: Map<NodeId, NodeProjection>): boolean {
  if (fieldId === REF_COUNT_FIELD) return true;
  return projectFieldTypeById(byId, fieldId) === 'number';
}

function compareRowsByField(
  left: OutlinerRowItem,
  right: OutlinerRowItem,
  byId: Map<NodeId, NodeProjection>,
  fieldId: string,
  systemFieldContext?: SystemFieldContext,
): number {
  if (left.type !== 'content' && left.type !== 'field') return 1;
  if (right.type !== 'content' && right.type !== 'field') return -1;
  const leftNode = byId.get(left.id);
  const rightNode = byId.get(right.id);
  if (!leftNode || !rightNode) return 0;

  if (isViewDateField(fieldId, byId)) {
    const leftDate = fieldDateFor(leftNode, fieldId, byId, systemFieldContext) ?? Number.POSITIVE_INFINITY;
    const rightDate = fieldDateFor(rightNode, fieldId, byId, systemFieldContext) ?? Number.POSITIVE_INFINITY;
    return leftDate - rightDate;
  }
  if (isViewNumberField(fieldId, byId)) {
    const leftNumber = fieldNumberFor(leftNode, fieldId, byId, systemFieldContext) ?? Number.POSITIVE_INFINITY;
    const rightNumber = fieldNumberFor(rightNode, fieldId, byId, systemFieldContext) ?? Number.POSITIVE_INFINITY;
    return leftNumber - rightNumber;
  }
  if (fieldId === DONE_FIELD) {
    const leftDone = displayNode(leftNode, byId).completedAt ? 1 : 0;
    const rightDone = displayNode(rightNode, byId).completedAt ? 1 : 0;
    return leftDone - rightDone;
  }

  const leftText = fieldTextFor(leftNode, fieldId, byId, systemFieldContext).toLocaleLowerCase();
  const rightText = fieldTextFor(rightNode, fieldId, byId, systemFieldContext).toLocaleLowerCase();
  return leftText.localeCompare(rightText, undefined, { numeric: true, sensitivity: 'base' });
}

function partitionFilterRows(
  view: ViewConfig,
  rows: OutlinerRowItem[],
  byId: Map<NodeId, NodeProjection>,
  systemFieldContext?: SystemFieldContext,
): { visible: OutlinerRowItem[]; filteredOut: OutlinerRowItem[] } {
  if (view.filterRules.length === 0) return { visible: rows, filteredOut: [] };
  const visible: OutlinerRowItem[] = [];
  const filteredOut: OutlinerRowItem[] = [];
  for (const row of rows) {
    if (row.type !== 'content' && row.type !== 'field') {
      visible.push(row);
      continue;
    }
    const node = byId.get(row.id);
    if (node && view.filterRules.every((rule) => rowMatchesFilter(node, rule, byId, systemFieldContext))) {
      visible.push(row);
    } else {
      filteredOut.push(row);
    }
  }
  return { visible, filteredOut };
}

function rowMatchesDateFilter(rule: ViewFilterRule, values: string[], expected: string[]): boolean {
  const fieldSpans = values
    .map((value) => dateSpanForFieldValue(rule.field, value))
    .filter((span): span is { startMs: number; endExclusiveMs: number } => span !== null);
  if (fieldSpans.length === 0) return false;
  const matchOne = (target: string) => {
    const span = parseDateValueSpan(target);
    if (!span) return false;
    if (rule.operator === 'before') return fieldSpans.some((field) => field.startMs < span.startMs);
    if (rule.operator === 'after') return fieldSpans.some((field) => field.startMs >= span.endExclusiveMs);
    const within = fieldSpans.some((field) => field.startMs >= span.startMs && field.startMs < span.endExclusiveMs);
    return rule.operator === 'is_not' ? !within : within;
  };
  return rule.valueLogic === 'all' ? expected.every(matchOne) : expected.some(matchOne);
}

function rowMatchesFilter(
  node: NodeProjection,
  rule: ViewFilterRule,
  byId: Map<NodeId, NodeProjection>,
  systemFieldContext?: SystemFieldContext,
): boolean {
  const values = viewFieldValuesFor(node, rule.field, byId, systemFieldContext);
  const normalizedValues = values.map((value) => value.toLocaleLowerCase());
  const expected = rule.values.map((value) => value.trim().toLocaleLowerCase()).filter(Boolean);

  if (rule.operator === 'is_empty') return values.length === 0 || values.every((value) => !value.trim());
  if (rule.operator === 'is_not_empty') return values.some((value) => value.trim());
  if (expected.length === 0) return true;

  if (isViewDateField(rule.field, byId)) {
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
  systemFieldContext?: SystemFieldContext,
): OutlinerRowItem[] {
  if (view.sortRules.length === 0) return rows;
  const sortedRows = [...rows];
  sortedRows.sort((left, right) => {
    for (const rule of view.sortRules) {
      const result = compareRowsByField(left, right, byId, rule.field, systemFieldContext);
      if (result !== 0) return rule.direction === 'desc' ? -result : result;
    }
    return 0;
  });
  return sortedRows;
}

function isBooleanGroupField(fieldId: string, byId: Map<NodeId, NodeProjection>): boolean {
  if (fieldId === DONE_FIELD) return true;
  const fieldType = projectFieldTypeById(byId, fieldId);
  return fieldType === 'checkbox';
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

  if (isViewDateField(fieldId, byId)) {
    const span = dateSpanForFieldValue(fieldId, trimmed[0]);
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
  systemFieldContext?: SystemFieldContext,
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
    const values = node ? viewFieldValuesFor(node, fieldId, byId, systemFieldContext) : [];
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
  options: RowBuildOptions,
): OutlinerRowItem[] {
  const view = readViewConfig(parent, byId);
  const systemFieldContext = options.systemFieldContext;
  const sortedRows = sortRows(view, rows, byId, systemFieldContext);
  const { visible, filteredOut } = partitionFilterRows(view, sortedRows, byId, systemFieldContext);
  const visibleRows = groupRows(
    parent,
    view,
    visible,
    byId,
    systemFieldContext,
  );
  if (filteredOut.length === 0) return visibleRows;
  const ruleKey = view.filterRules.map((rule) => rule.id).join('|');
  return [
    ...visibleRows,
    {
      id: `filtered:${parent.id}:${ruleKey}`,
      type: 'filteredOut',
      count: filteredOut.length,
      rows: filteredOut,
    },
  ];
}

export function buildOutlinerRows(
  parent: NodeProjection | undefined,
  byId: Map<NodeId, NodeProjection>,
  options: RowBuildOptions = {},
): OutlinerRowItem[] {
  if (!parent) return [];
  return applyViewSettings(parent, buildChildRows(parent, byId, options), byId, options);
}

export function flattenExpandedOutlinerRows(
  rows: readonly OutlinerRowItem[],
  expanded: ReadonlySet<string>,
): OutlinerRowItem[] {
  const out: OutlinerRowItem[] = [];
  const visitRows = (items: readonly OutlinerRowItem[]) => {
    for (const row of items) {
      if (row.type === 'filteredOut') {
        out.push(row);
        if (expanded.has(row.id)) visitRows(row.rows);
        continue;
      }
      out.push(row);
    }
  };
  visitRows(rows);
  return out;
}

// A field's display label: a fixed system-field label, else the def node's title.
export function fieldChoiceLabel(fieldId: string, byId: Map<NodeId, NodeProjection>): string {
  const viewSystemField = SYSTEM_VIEW_FIELD_CHOICES.find((choice) => choice.id === fieldId);
  if (viewSystemField) return viewSystemField.label;
  return systemFieldLabel(fieldId) ?? nodeTitle(byId.get(fieldId));
}

export function visibleDisplayFields(view: ViewConfig): ViewDisplayField[] {
  return view.displayFields.filter((field) => field.visible && field.field !== NAME_FIELD);
}

export function viewDisplayValuesFor(
  rowNode: NodeProjection,
  view: ViewConfig,
  byId: Map<NodeId, NodeProjection>,
  systemFieldContext?: SystemFieldContext,
): ViewFieldValue[] {
  return visibleDisplayFields(view).flatMap((displayField): ViewFieldValue[] => {
    const values = displayFieldValuesFor(rowNode, displayField.field, byId, systemFieldContext)
      .map((value) => value.trim())
      .filter(Boolean);
    if (values.length === 0) return [];
    return [{
      id: displayField.id,
      field: displayField.field,
      label: displayField.label?.trim() || fieldChoiceLabel(displayField.field, byId),
      values,
    }];
  });
}

export function collectViewFieldChoices(
  parent: NodeProjection,
  byId: Map<NodeId, NodeProjection>,
  referenceSummary: ReferenceSummary,
): Array<{ id: string; label: string; section: 'System fields' | 'Fields' }> {
  const choices = new Map<string, { label: string; section: 'System fields' | 'Fields' }>();
  const candidateRows = fieldCandidateRows(parent, byId);

  for (const system of SYSTEM_VIEW_FIELD_CHOICES) {
    if (systemFieldPresentInRows(system.id, candidateRows, byId, referenceSummary)) {
      choices.set(system.id, { label: system.label, section: 'System fields' });
    }
  }

  for (const child of candidateRows) {
    const displayed = displayNode(child, byId);
    for (const nestedId of displayed.children) {
      const nested = byId.get(nestedId);
      if (nested?.type !== 'fieldEntry' || !nested.fieldDefId || isSystemFieldId(nested.fieldDefId)) continue;
      choices.set(nested.fieldDefId, { label: fieldChoiceLabel(nested.fieldDefId, byId), section: 'Fields' });
    }
  }

  const view = readViewConfig(parent, byId);
  for (const fieldId of referencedViewFields(view)) {
    if (isSystemFieldId(fieldId)) {
      const system = SYSTEM_VIEW_FIELD_CHOICES.find((choice) => choice.id === fieldId);
      if (system) choices.set(system.id, { label: system.label, section: 'System fields' });
      continue;
    }
    choices.set(fieldId, { label: fieldChoiceLabel(fieldId, byId), section: 'Fields' });
  }

  return [...choices.entries()]
    .map(([id, choice]) => ({ id, ...choice }))
    .sort((a, b) => {
      if (a.section !== b.section) return a.section === 'System fields' ? -1 : 1;
      if (a.section === 'System fields') return (SYSTEM_VIEW_FIELD_ORDER.get(a.id) ?? 999) - (SYSTEM_VIEW_FIELD_ORDER.get(b.id) ?? 999);
      return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    });
}

const SYSTEM_VIEW_FIELD_CHOICES = [
  { id: NAME_FIELD, label: 'Name' },
  { id: CREATED_FIELD, label: 'Created time' },
  { id: DAY_FIELD, label: 'Date from calendar node' },
  { id: DONE_FIELD, label: 'Done' },
  { id: DONE_AT_FIELD, label: 'Done time' },
  { id: UPDATED_FIELD, label: 'Last edited time' },
  { id: REF_COUNT_FIELD, label: 'Number of references' },
  { id: OWNER_FIELD, label: 'Owner node' },
  { id: TAGS_FIELD, label: 'Tags' },
];

const SYSTEM_VIEW_FIELD_ORDER = new Map(SYSTEM_VIEW_FIELD_CHOICES.map((choice, index) => [choice.id, index]));

function fieldCandidateRows(parent: NodeProjection, byId: Map<NodeId, NodeProjection>): NodeProjection[] {
  const rows: NodeProjection[] = [];
  for (const childId of parent.children) {
    const child = byId.get(childId);
    if (!child) continue;
    if (child.type && INTERNAL_NODE_TYPES.has(child.type)) continue;
    rows.push(child);
  }
  return rows;
}

export function customViewFieldIdsOnRows(parent: NodeProjection, byId: Map<NodeId, NodeProjection>): Set<string> {
  const fields = new Set<string>();
  for (const child of fieldCandidateRows(parent, byId)) {
    const displayed = displayNode(child, byId);
    for (const nestedId of displayed.children) {
      const nested = byId.get(nestedId);
      if (nested?.type !== 'fieldEntry' || !nested.fieldDefId || isSystemFieldId(nested.fieldDefId)) continue;
      fields.add(nested.fieldDefId);
    }
  }
  return fields;
}

function referencedViewFields(view: ViewConfig): Set<string> {
  const fields = new Set<string>();
  for (const display of view.displayFields) {
    fields.add(display.field);
  }
  if (view.groupField) {
    fields.add(view.groupField);
  }
  for (const rule of view.sortRules) {
    fields.add(rule.field);
  }
  for (const rule of view.filterRules) {
    fields.add(rule.field);
  }
  return fields;
}

function systemFieldPresentInRows(
  fieldId: string,
  rows: NodeProjection[],
  byId: Map<NodeId, NodeProjection>,
  referenceSummary: ReferenceSummary,
): boolean {
  if (fieldId === NAME_FIELD || fieldId === CREATED_FIELD || fieldId === UPDATED_FIELD) return rows.length > 0;
  if (fieldId === OWNER_FIELD) return rows.some((row) => Boolean(displayNode(row, byId).parentId));
  if (fieldId === DONE_FIELD) return rows.some((row) => nodeShowsCheckbox(byId, displayNode(row, byId)));
  if (fieldId === TAGS_FIELD) return rows.some((row) => displayNode(row, byId).tags.length > 0);
  if (fieldId === DONE_AT_FIELD) return rows.some((row) => {
    const completedAt = displayNode(row, byId).completedAt;
    return completedAt !== undefined && completedAt > 0;
  });
  if (fieldId === DAY_FIELD) {
    return rows.some((row) => viewFieldValuesFor(row, DAY_FIELD, byId).length > 0);
  }
  if (fieldId === REF_COUNT_FIELD) {
    return rows.some((row) => {
      const displayed = displayNode(row, byId);
      return (referenceSummary.countsByTarget.get(displayed.id)?.linked ?? 0) > 0;
    });
  }
  return false;
}
