import {
  isContentBearingNode,
  parseDateFieldValueRange,
  type ContentBearingNodeProjection,
  type FilterOperator,
  type NodeId,
  type NodeProjection,
  type SortDirection,
  type ViewMode,
} from '../api/types';
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
import { isDescendantOf, resolveReferenceChainTargetId } from '../../core/actions/rowFacets';
import { TRASH_ID } from '../../core/types';
import {
  INTERNAL_VIEW_NODE_TYPES,
  orderedByFiniteOrder,
  resolveViewToolbarVisible,
} from '../../core/viewConfig';
import { fieldSlotValueSource, nodeFieldSlots, type NodeFieldSlot } from '../../core/fieldSlots';

export type OutlinerRowItem =
  | { id: NodeId; type: 'field'; slot: NodeFieldSlot }
  // `draft` marks a renderer-only trailing row whose node is not in the
  // projection yet (eager materialization). `buildOutlinerRows` never emits it;
  // it is appended in the render layer so it stays out of nav/selection/agent
  // context until the user types and it materializes.
  | { id: NodeId; type: 'content'; draft?: boolean; beforeId?: NodeId | null; afterId?: NodeId | null }
  | { id: string; type: 'group'; label: string }
  | { id: string; type: 'filteredOut'; count: number; rows: OutlinerRowItem[] }
  | { id: string; type: 'hiddenField'; fieldId: NodeId; label: string };

export interface RowBuildOptions {
  expandedHiddenFields?: Set<string>;
  suppressFieldEntries?: boolean;
  pendingRemovalIds?: ReadonlySet<NodeId>;
  systemFieldContext?: SystemFieldContext;
  fieldSlots?: (nodeId: NodeId) => readonly NodeFieldSlot[];
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
  order?: number;
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
      toolbarVisible: resolveViewToolbarVisible(parent, undefined),
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
    toolbarVisible: resolveViewToolbarVisible(parent, viewDef.toolbarVisible),
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
    displayFields: orderedByFiniteOrder(
      viewChildren
        .filter((child): child is Extract<NodeProjection, { type: 'displayField' }> => child.type === 'displayField' && Boolean(child.displayField))
        .map((child) => ({
          id: child.id,
          field: child.displayField!,
          visible: child.displayVisible !== false,
          width: child.displayWidth,
          order: child.displayOrder,
          label: child.displayLabel,
          placement: child.displayPlacement,
        })),
      (field) => field.order,
    ),
  };
}

export function showsResultViewControls(
  node: NodeProjection | undefined,
  view: Pick<ViewConfig, 'toolbarVisible'> | null | undefined,
): boolean {
  return Boolean(node && view?.toolbarVisible);
}

function directChildren(parent: NodeProjection | undefined, byId: Map<NodeId, NodeProjection>): NodeProjection[] {
  return parent?.children
    .map((childId) => byId.get(childId))
    .filter((child): child is NodeProjection => Boolean(child)) ?? [];
}

function nodeTitle(node: NodeProjection | undefined): string {
  return node && isContentBearingNode(node) ? node.content.text || 'Untitled' : 'Untitled';
}

function displayNode(
  node: NodeProjection,
  byId: Map<NodeId, NodeProjection>,
): ContentBearingNodeProjection | undefined {
  if (!isContentBearingNode(node)) return undefined;
  if (node.type !== 'reference') return node;
  if (!node.targetId) return undefined;
  const targetId = resolveReferenceChainTargetId(node.targetId, byId);
  const target = targetId ? byId.get(targetId) : undefined;
  return target && isContentBearingNode(target) ? target : undefined;
}

function displayNodeOrSelf(
  node: ContentBearingNodeProjection,
  byId: Map<NodeId, NodeProjection>,
): ContentBearingNodeProjection {
  return displayNode(node, byId) ?? node;
}

function fieldLabel(slot: NodeFieldSlot, byId: Map<NodeId, NodeProjection>): string {
  return nodeTitle(byId.get(slot.fieldDefId)) || 'Field';
}

function slotsForNode(
  nodeId: NodeId,
  byId: Map<NodeId, NodeProjection>,
  resolver?: (nodeId: NodeId) => readonly NodeFieldSlot[],
): readonly NodeFieldSlot[] {
  return resolver?.(nodeId) ?? nodeFieldSlots(byId, nodeId);
}

function rowNodeForView(
  row: Extract<OutlinerRowItem, { type: 'content' | 'field' }>,
  byId: Map<NodeId, NodeProjection>,
): ContentBearingNodeProjection | undefined {
  const nodeId = row.type === 'field' ? row.slot.entryId : row.id;
  const node = nodeId ? byId.get(nodeId) : undefined;
  return node && isContentBearingNode(node) ? node : undefined;
}

function childText(node: NodeProjection | undefined, byId: Map<NodeId, NodeProjection>): string {
  if (!node || !isContentBearingNode(node)) return '';
  const displayed = displayNodeOrSelf(node, byId);
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
  if (fieldId === NAME_FIELD) return viewFieldValuesFor(rowNode, fieldId, byId, systemFieldContext);
  const displayed = displayNode(rowNode, byId);
  if (!displayed) return [];
  if (!isSystemFieldId(fieldId)) return viewFieldValuesFor(rowNode, fieldId, byId, systemFieldContext);

  const display = systemFieldDisplay(displayed, fieldId, byId, systemFieldContext);
  switch (display.kind) {
    case 'done':
      return [display.checked ? 'Done' : 'Not done'];
    case 'date':
      return display.text ? [display.text] : [];
    case 'dayRef':
      return display.text ? [display.text] : [];
    case 'tags':
      return display.tagIds.map((tagId) => nodeTitle(byId.get(tagId)) || tagId).filter(Boolean);
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
  return resolvedViewFieldValuesFor(rowNode, fieldId, byId, systemFieldContext);
}

function resolvedViewFieldValuesFor(
  rowNode: NodeProjection,
  fieldId: string,
  byId: Map<NodeId, NodeProjection>,
  systemFieldContext?: SystemFieldContext,
  resolveDisplayNode?: (node: NodeProjection) => ContentBearingNodeProjection | undefined,
): string[] {
  const displayed = resolveDisplayNode ? resolveDisplayNode(rowNode) : displayNode(rowNode, byId);
  if (fieldId === NAME_FIELD) return [childText(displayed ?? rowNode, byId)].filter(Boolean);
  if (!displayed) return [];
  // Name reads the node's own (possibly nested) text; every other system field is
  // a computed projection resolved by the shared `systemFields` module.
  if (isSystemFieldId(fieldId)) return systemFieldValues(displayed, fieldId, byId, systemFieldContext);

  const slot = nodeFieldSlots(byId, displayed.id)
    .find((candidate) => candidate.fieldDefId === fieldId);
  const entryId = slot ? fieldSlotValueSource(byId, slot)?.entryId : undefined;
  const fieldEntry = entryId ? byId.get(entryId) : undefined;
  if (fieldEntry?.type !== 'fieldEntry') return [];

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
  resolveDisplayNode?: (node: NodeProjection) => ContentBearingNodeProjection | undefined,
): string {
  return resolvedViewFieldValuesFor(rowNode, fieldId, byId, systemFieldContext, resolveDisplayNode).join(' ');
}

function fieldNumberFor(
  rowNode: NodeProjection,
  fieldId: string,
  byId: Map<NodeId, NodeProjection>,
  systemFieldContext?: SystemFieldContext,
  resolveDisplayNode?: (node: NodeProjection) => ContentBearingNodeProjection | undefined,
): number | null {
  const value = resolvedViewFieldValuesFor(rowNode, fieldId, byId, systemFieldContext, resolveDisplayNode)[0];
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

function isHiddenFieldSlot(slot: NodeFieldSlot, byId: Map<NodeId, NodeProjection>): boolean {
  const field = byId.get(slot.fieldDefId);
  const mode = field ? projectFieldConfig(byId, field).hideField : undefined;
  if (mode === 'always' || mode === 'hidden') return true;
  const valueSource = fieldSlotValueSource(byId, slot);
  const entry = valueSource ? byId.get(valueSource.entryId) : undefined;
  const value = entry ? hiddenFieldValue(entry, byId).trim() : '';
  if (mode === 'empty') return value.length === 0;
  if (mode === 'not_empty') return value.length > 0;
  if (mode === 'value_is_default') {
    const templateEntry = slot.templateEntryId ? byId.get(slot.templateEntryId) : undefined;
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
  resolveDisplayNode?: (node: NodeProjection) => ContentBearingNodeProjection | undefined,
): number | null {
  if (!isViewDateField(fieldId, byId)) return null;
  const value = resolvedViewFieldValuesFor(rowNode, fieldId, byId, systemFieldContext, resolveDisplayNode)[0];
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
  resolveDisplayNode?: (node: NodeProjection) => ContentBearingNodeProjection | undefined,
): number {
  if (left.type !== 'content' && left.type !== 'field') return 1;
  if (right.type !== 'content' && right.type !== 'field') return -1;
  const leftNode = rowNodeForView(left, byId);
  const rightNode = rowNodeForView(right, byId);
  if (!leftNode || !rightNode) return 0;

  if (isViewDateField(fieldId, byId)) {
    const leftDate = fieldDateFor(leftNode, fieldId, byId, systemFieldContext, resolveDisplayNode) ?? Number.POSITIVE_INFINITY;
    const rightDate = fieldDateFor(rightNode, fieldId, byId, systemFieldContext, resolveDisplayNode) ?? Number.POSITIVE_INFINITY;
    return leftDate - rightDate;
  }
  if (isViewNumberField(fieldId, byId)) {
    const leftNumber = fieldNumberFor(leftNode, fieldId, byId, systemFieldContext, resolveDisplayNode) ?? Number.POSITIVE_INFINITY;
    const rightNumber = fieldNumberFor(rightNode, fieldId, byId, systemFieldContext, resolveDisplayNode) ?? Number.POSITIVE_INFINITY;
    return leftNumber - rightNumber;
  }
  if (fieldId === DONE_FIELD) {
    const leftDone = (resolveDisplayNode ? resolveDisplayNode(leftNode) : displayNode(leftNode, byId))?.completedAt ? 1 : 0;
    const rightDone = (resolveDisplayNode ? resolveDisplayNode(rightNode) : displayNode(rightNode, byId))?.completedAt ? 1 : 0;
    return leftDone - rightDone;
  }

  const leftText = fieldTextFor(leftNode, fieldId, byId, systemFieldContext, resolveDisplayNode).toLocaleLowerCase();
  const rightText = fieldTextFor(rightNode, fieldId, byId, systemFieldContext, resolveDisplayNode).toLocaleLowerCase();
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
    const node = rowNodeForView(row, byId);
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
  const displayedRows = new Map<NodeId, ContentBearingNodeProjection | undefined>();
  for (const row of rows) {
    if (row.type !== 'content' && row.type !== 'field') continue;
    const node = rowNodeForView(row, byId);
    if (node) displayedRows.set(node.id, displayNode(node, byId));
  }
  const resolveDisplayNode = (node: NodeProjection) => (
    displayedRows.has(node.id) ? displayedRows.get(node.id) : displayNode(node, byId)
  );
  const sortedRows = [...rows];
  sortedRows.sort((left, right) => {
    for (const rule of view.sortRules) {
      const result = compareRowsByField(
        left,
        right,
        byId,
        rule.field,
        systemFieldContext,
        resolveDisplayNode,
      );
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
    const node = rowNodeForView(row, byId);
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
  const projectedSlots = slotsForNode(parent.id, byId, options.fieldSlots);
  const ownerIsTrashed = parent.id === TRASH_ID || isDescendantOf(byId, parent.id, TRASH_ID);
  const slots = projectedSlots.length === 0 && ownerIsTrashed
    ? parent.children.flatMap((childId): NodeFieldSlot[] => {
      const child = byId.get(childId);
      if (child?.type !== 'fieldEntry' || !child.fieldDefId) return [];
      return [{
        id: child.id,
        fieldDefId: child.fieldDefId,
        source: 'own',
        entryId: child.id,
      }];
    })
    : projectedSlots;
  const tagSlots = slots.filter((slot) => slot.source === 'tag');
  const consumedEntryIds = new Set(tagSlots.flatMap((slot) => slot.entryId ? [slot.entryId] : []));
  const ownSlotsByEntryId = new Map(
    slots.flatMap((slot) => slot.source === 'own' && slot.entryId ? [[slot.entryId, slot] as const] : []),
  );

  const appendFieldSlot = (slot: NodeFieldSlot) => {
    if (options.suppressFieldEntries && isActiveTableFieldSlot(slot, byId)) return;
    if (
      !options.suppressFieldEntries
      && isHiddenFieldSlot(slot, byId)
      && !options.expandedHiddenFields?.has(hiddenFieldKey(parent.id, slot.id))
    ) {
      rows.push({
        id: `hidden:${parent.id}:${slot.id}`,
        type: 'hiddenField',
        fieldId: slot.id,
        label: fieldLabel(slot, byId),
      });
      return;
    }
    rows.push({ id: slot.id, type: 'field', slot });
  };

  for (const slot of tagSlots) appendFieldSlot(slot);
  for (const childId of parent.children) {
    if (options.pendingRemovalIds?.has(childId)) continue;
    const child = byId.get(childId);
    if (!child) continue;
    if (!isContentBearingNode(child)) continue;
    if (child.type && INTERNAL_VIEW_NODE_TYPES.has(child.type)) continue;
    if (child.type === 'fieldEntry') {
      if (consumedEntryIds.has(child.id)) continue;
      const slot = ownSlotsByEntryId.get(child.id);
      if (slot) appendFieldSlot(slot);
      continue;
    }
    rows.push({ id: childId, type: 'content' });
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
  if (view.viewMode === 'table') {
    const fieldRows = rows.filter((row) => row.type === 'field' || row.type === 'hiddenField');
    const contentRows = rows.filter((row) => row.type !== 'field' && row.type !== 'hiddenField');
    const sortedRows = sortRows(view, contentRows, byId, systemFieldContext);
    const { visible, filteredOut } = partitionFilterRows(view, sortedRows, byId, systemFieldContext);
    const groupedVisible = groupRows(parent, view, visible, byId, systemFieldContext);
    if (filteredOut.length === 0) return [...fieldRows, ...groupedVisible];
    const ruleKey = view.filterRules.map((rule) => rule.id).join('|');
    return [
      ...fieldRows,
      ...groupedVisible,
      {
        id: `filtered:${parent.id}:${ruleKey}`,
        type: 'filteredOut',
        count: filteredOut.length,
        rows: filteredOut,
      },
    ];
  }
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

export function visibleAuthoredTableFieldIds(view: ViewConfig): Set<string> {
  return new Set(visibleDisplayFields(view).flatMap((field) => (
    isSystemFieldId(field.field) ? [] : [field.field]
  )));
}

export function fieldEntryForViewCell(
  rowNode: NodeProjection,
  fieldId: string,
  byId: Map<NodeId, NodeProjection>,
): NodeProjection | undefined {
  const entryId = fieldSlotForViewCell(rowNode, fieldId, byId)?.entryId;
  return entryId ? byId.get(entryId) : undefined;
}

export function fieldSlotForViewCell(
  rowNode: NodeProjection,
  fieldId: string,
  byId: Map<NodeId, NodeProjection>,
): NodeFieldSlot | undefined {
  if (isSystemFieldId(fieldId)) return undefined;
  const displayed = displayNode(rowNode, byId);
  if (!displayed) return undefined;
  return nodeFieldSlots(byId, displayed.id).find((slot) => slot.fieldDefId === fieldId);
}

export function collectViewFieldChoices(
  parent: NodeProjection,
  byId: Map<NodeId, NodeProjection>,
  referenceSummary: ReferenceSummary,
): Array<{ id: string; label: string; section: 'System fields' | 'Fields' }> {
  const choices = new Map<string, { label: string; section: 'System fields' | 'Fields' }>();
  const candidateRows = fieldCandidateRows(parent, byId, false);

  for (const system of SYSTEM_VIEW_FIELD_CHOICES) {
    if (systemFieldPresentInRows(system.id, candidateRows, byId, referenceSummary)) {
      choices.set(system.id, { label: system.label, section: 'System fields' });
    }
  }

  for (const child of candidateRows) {
    const displayed = displayNode(child, byId);
    if (!displayed) continue;
    for (const slot of nodeFieldSlots(byId, displayed.id)) {
      if (isSystemFieldId(slot.fieldDefId)) continue;
      choices.set(slot.fieldDefId, { label: fieldChoiceLabel(slot.fieldDefId, byId), section: 'Fields' });
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

function fieldCandidateRows(
  parent: NodeProjection,
  byId: Map<NodeId, NodeProjection>,
  includeOwnerFieldEntries: boolean,
): ContentBearingNodeProjection[] {
  const rows: ContentBearingNodeProjection[] = [];
  for (const childId of parent.children) {
    const child = byId.get(childId);
    if (!child || !isContentBearingNode(child)) continue;
    if (child.type && INTERNAL_VIEW_NODE_TYPES.has(child.type)) continue;
    if (!includeOwnerFieldEntries && child.type === 'fieldEntry') continue;
    rows.push(child);
  }
  return rows;
}

export function customViewFieldIdsOnRows(parent: NodeProjection, byId: Map<NodeId, NodeProjection>): Set<string> {
  return customFieldIdsOnRows(parent, byId, false);
}

export function customFilterFieldIdsOnRows(parent: NodeProjection, byId: Map<NodeId, NodeProjection>): Set<string> {
  return customFieldIdsOnRows(parent, byId, true);
}

function customFieldIdsOnRows(
  parent: NodeProjection,
  byId: Map<NodeId, NodeProjection>,
  includeOwnerFieldEntries: boolean,
): Set<string> {
  const fields = new Set<string>();
  for (const child of fieldCandidateRows(parent, byId, includeOwnerFieldEntries)) {
    const displayed = displayNode(child, byId);
    if (!displayed) continue;
    for (const slot of nodeFieldSlots(byId, displayed.id)) {
      if (isSystemFieldId(slot.fieldDefId)) continue;
      fields.add(slot.fieldDefId);
    }
  }
  return fields;
}

export function isActiveTableFieldEntry(
  entry: NodeProjection,
  byId: Map<NodeId, NodeProjection>,
): boolean {
  if (entry.type !== 'fieldEntry') return false;
  if (!entry.fieldDefId) return false;
  if (isSystemFieldId(entry.fieldDefId)) return true;
  const field = byId.get(entry.fieldDefId);
  return field?.type === 'fieldDef' && !isDescendantOf(byId, field.id, TRASH_ID);
}

function isActiveTableFieldSlot(
  slot: NodeFieldSlot,
  byId: Map<NodeId, NodeProjection>,
): boolean {
  if (isSystemFieldId(slot.fieldDefId)) return true;
  const field = byId.get(slot.fieldDefId);
  return field?.type === 'fieldDef' && !isDescendantOf(byId, field.id, TRASH_ID);
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
  rows: ContentBearingNodeProjection[],
  byId: Map<NodeId, NodeProjection>,
  referenceSummary: ReferenceSummary,
): boolean {
  if (fieldId === NAME_FIELD || fieldId === CREATED_FIELD || fieldId === UPDATED_FIELD) return rows.length > 0;
  if (fieldId === OWNER_FIELD) return rows.some((row) => Boolean(displayNode(row, byId)?.parentId));
  if (fieldId === DONE_FIELD) return rows.some((row) => {
    const displayed = displayNode(row, byId);
    return displayed ? nodeShowsCheckbox(byId, displayed) : false;
  });
  if (fieldId === TAGS_FIELD) return rows.some((row) => (displayNode(row, byId)?.tags.length ?? 0) > 0);
  if (fieldId === DONE_AT_FIELD) return rows.some((row) => {
    const completedAt = displayNode(row, byId)?.completedAt;
    return completedAt !== undefined && completedAt > 0;
  });
  if (fieldId === DAY_FIELD) {
    return rows.some((row) => viewFieldValuesFor(row, DAY_FIELD, byId).length > 0);
  }
  if (fieldId === REF_COUNT_FIELD) {
    return rows.some((row) => {
      const displayed = displayNode(row, byId);
      return displayed
        ? (referenceSummary.countsByTarget.get(displayed.id)?.linked ?? 0) > 0
        : false;
    });
  }
  return false;
}
