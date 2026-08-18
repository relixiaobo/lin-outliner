import { formatNodeReferenceMarker } from '../../../core/referenceMarkup';
import { escapeSemanticText } from '../../../core/semanticIngest/inlineScanner';
import type {
  DisplayFieldNode,
  FilterOperator,
  FilterRuleNode,
  FilterValueLogic,
  NodeProjection,
  SortDirection,
  SortRuleNode,
  ViewFieldRef,
} from '../../../core/types';
import { findViewDef, orderedDisplayFields } from '../../../core/viewConfig';
import type {
  OutlineDocument,
  OutlineField,
  OutlineNode,
  OutlineValue,
  OutlineViewConfigLine,
} from './agentOutlineParser';
import { isInTrash, nodeTitle } from './agentNodeToolProjection';
import type { NodeToolIssue, ProjectionIndex } from './agentNodeToolTypes';

const VIEW_SYSTEM_FIELDS = new Set<ViewFieldRef>([
  'sys:name',
  'sys:createdAt',
  'sys:updatedAt',
  'sys:done',
  'sys:doneAt',
  'sys:tags',
  'sys:refCount',
]);

const FILTER_OPERATORS = new Set<FilterOperator>([
  'is',
  'is_not',
  'contains',
  'not_contains',
  'is_empty',
  'is_not_empty',
  'gt',
  'lt',
  'before',
  'after',
]);

const CONFIG_FIELD_NAMES = {
  sort: new Set(['field', 'direction']),
  filter: new Set(['field', 'operator', 'logic', 'value']),
  group: new Set(['field']),
  display: new Set(['field', 'label', 'width', 'visible', 'order']),
} as const;

export const VIEW_CONFIG_OUTLINE_GUIDANCE = [
  'View configuration lines are direct children of the owner.',
  'A configuration header contains only its %%view-*%% directive and, in node_read output, an optional %%node:id%% marker.',
  'Use %%view-sort%% with field:: and direction:: asc|desc.',
  'Use %%view-filter%% with field::, operator::, logic:: any|all, and zero or more value:: lines.',
  'Use at most one %%view-group%% with field::.',
  'Use %%view-display%% with field:: plus optional label::, width::, visible:: true|false, and order::.',
  'Custom fields use [[node:Field name^field-definition-id]]; supported system fields use sys:name, sys:createdAt, sys:updatedAt, sys:done, sys:doneAt, sys:tags, or sys:refCount.',
].join(' ');

export interface ResolvedViewSortRule {
  nodeId?: string;
  field: ViewFieldRef;
  direction: SortDirection;
}

export interface ResolvedViewFilterRule {
  nodeId?: string;
  field: ViewFieldRef;
  operator: FilterOperator;
  logic: FilterValueLogic;
  values: string[];
}

export interface ResolvedViewDisplayField {
  nodeId?: string;
  field: ViewFieldRef;
  visible: boolean;
  width?: number;
  order?: number;
  label?: string;
}

export interface ResolvedViewConfig {
  sortRules: ResolvedViewSortRule[];
  filterRules: ResolvedViewFilterRule[];
  groupField: ViewFieldRef | null;
  displayFields: ResolvedViewDisplayField[];
}

export function hasOutlineViewConfig(node: OutlineNode): boolean {
  return Boolean(node.viewConfig?.length);
}

export function documentHasOutlineViewConfig(document: OutlineDocument): boolean {
  const stack = [...document.roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (hasOutlineViewConfig(node)) return true;
    stack.push(...node.children);
  }
  return false;
}

export function hasPersistedViewConfig(index: ProjectionIndex, owner: NodeProjection): boolean {
  const viewDef = findViewDef(index.nodes, owner);
  if (viewDef?.type !== 'viewDef') return false;
  if (Object.prototype.hasOwnProperty.call(viewDef, 'groupField')) return true;
  return viewDef.children.some((childId) => {
    const child = index.nodes.get(childId);
    return child?.type === 'sortRule' || child?.type === 'filterRule' || child?.type === 'displayField';
  });
}

export function validateViewConfigs(index: ProjectionIndex, document: OutlineDocument): NodeToolIssue | null {
  for (const root of document.roots) {
    const issue = validateOwnerViewConfig(index, root);
    if (issue) return issue;
  }
  return null;
}

function validateOwnerViewConfig(index: ProjectionIndex, node: OutlineNode): NodeToolIssue | null {
  const resolved = resolveViewConfig(index, node);
  if ('error' in resolved) return resolved;
  if (node.search) {
    for (const queryRoot of node.children) {
      const nested = findNestedViewConfig(queryRoot);
      if (nested) {
        return viewConfigIssue(
          `${nested.directive} must be a direct child of the saved-search owner, not part of its query tree.`,
        );
      }
    }
    return null;
  }
  for (const child of node.children) {
    const issue = validateOwnerViewConfig(index, child);
    if (issue) return issue;
  }
  return null;
}

function findNestedViewConfig(node: OutlineNode): OutlineViewConfigLine | null {
  if (node.viewConfig?.[0]) return node.viewConfig[0];
  for (const child of node.children) {
    const nested = findNestedViewConfig(child);
    if (nested) return nested;
  }
  return null;
}

export function resolveViewConfig(
  index: ProjectionIndex,
  owner: OutlineNode,
): ResolvedViewConfig | NodeToolIssue {
  const lines = owner.viewConfig ?? [];
  const unknown = lines.find((line) => !line.kind);
  if (unknown) {
    return viewConfigIssue(`Unknown view configuration directive: ${unknown.directive}`);
  }
  for (const line of lines) {
    if (line.hasUnsupportedHeaderSyntax) {
      return viewConfigIssue(`${line.directive} header must not include tags, checkbox state, descriptions, search/view directives, references, or code-block syntax.`);
    }
    if (line.children.length > 0) {
      return viewConfigIssue(`${line.directive} accepts field lines only; nested rule nodes are not allowed.`);
    }
    const allowed = line.kind ? CONFIG_FIELD_NAMES[line.kind] : new Set<string>();
    const unsupported = line.fields.find((field) => !allowed.has(normalizedFieldName(field)));
    if (unsupported) {
      return viewConfigIssue(`${line.directive} does not support ${unsupported.name.trim()}::.`);
    }
    const annotatedOperand = line.fields.find((field) => (
      field.nodeId || field.values.some((value) => value.nodeId)
    ));
    if (annotatedOperand) {
      return viewConfigIssue(`${line.directive} operand lines must not carry %%node:id%% markers.`);
    }
    const annotationIssue = validateConfigAnnotation(index, owner, line);
    if (annotationIssue) return annotationIssue;
  }

  const groupLines = lines.filter((line) => line.kind === 'group');
  if (groupLines.length > 1) return viewConfigIssue('A view can contain at most one %%view-group%% line.');

  const sortRules: ResolvedViewSortRule[] = [];
  const filterRules: ResolvedViewFilterRule[] = [];
  const displayFields: ResolvedViewDisplayField[] = [];
  let groupField: ViewFieldRef | null = null;

  for (const line of lines) {
    if (line.kind === 'sort') {
      const field = requiredViewField(index, line);
      if ('error' in field) return field;
      const direction = optionalScalar(line, 'direction');
      if ('error' in direction) return direction;
      const normalizedDirection = direction.value ?? 'asc';
      if (normalizedDirection !== 'asc' && normalizedDirection !== 'desc') {
        return viewConfigIssue('%%view-sort%% direction:: must be asc or desc.');
      }
      sortRules.push({ ...(line.nodeId ? { nodeId: line.nodeId } : {}), field: field.value, direction: normalizedDirection });
      continue;
    }
    if (line.kind === 'filter') {
      const field = requiredViewField(index, line);
      if ('error' in field) return field;
      const operator = optionalScalar(line, 'operator');
      if ('error' in operator) return operator;
      const normalizedOperator = operator.value ?? 'contains';
      if (!FILTER_OPERATORS.has(normalizedOperator as FilterOperator)) {
        return viewConfigIssue(`Unsupported %%view-filter%% operator:: ${normalizedOperator}.`);
      }
      const logic = optionalScalar(line, 'logic');
      if ('error' in logic) return logic;
      const normalizedLogic = logic.value ?? 'any';
      if (normalizedLogic !== 'any' && normalizedLogic !== 'all') {
        return viewConfigIssue('%%view-filter%% logic:: must be any or all.');
      }
      const values = repeatedValues(line, 'value');
      if ('error' in values) return values;
      filterRules.push({
        ...(line.nodeId ? { nodeId: line.nodeId } : {}),
        field: field.value,
        operator: normalizedOperator as FilterOperator,
        logic: normalizedLogic,
        values: values.values,
      });
      continue;
    }
    if (line.kind === 'group') {
      const field = requiredViewField(index, line);
      if ('error' in field) return field;
      groupField = field.value;
      continue;
    }
    if (line.kind === 'display') {
      const field = requiredViewField(index, line);
      if ('error' in field) return field;
      const visible = optionalScalar(line, 'visible');
      if ('error' in visible) return visible;
      if (visible.value !== undefined && visible.value !== 'true' && visible.value !== 'false') {
        return viewConfigIssue('%%view-display%% visible:: must be true or false.');
      }
      const width = optionalNumber(line, 'width', {});
      if ('error' in width) return width;
      const order = optionalNumber(line, 'order', {});
      if ('error' in order) return order;
      const label = optionalScalar(line, 'label', { allowClear: true });
      if ('error' in label) return label;
      displayFields.push({
        ...(line.nodeId ? { nodeId: line.nodeId } : {}),
        field: field.value,
        visible: visible.value !== 'false',
        ...(width.value !== undefined ? { width: width.value } : {}),
        ...(order.value !== undefined ? { order: order.value } : {}),
        ...(label.value ? { label: label.value } : {}),
      });
    }
  }

  const duplicateDisplay = firstDuplicate(displayFields.map((display) => display.field));
  if (duplicateDisplay) {
    return viewConfigIssue(`Duplicate %%view-display%% field:: ${duplicateDisplay}.`);
  }

  return { sortRules, filterRules, groupField, displayFields };
}

function validateConfigAnnotation(
  index: ProjectionIndex,
  owner: OutlineNode,
  line: OutlineViewConfigLine,
): NodeToolIssue | null {
  if (!line.nodeId) return null;
  if (line.kind === 'group') {
    return viewConfigIssue('%%view-group%% stores on the view owner and must not carry a %%node:id%% marker.');
  }
  const expectedType = line.kind === 'sort'
    ? 'sortRule'
    : line.kind === 'filter'
      ? 'filterRule'
      : line.kind === 'display'
        ? 'displayField'
        : undefined;
  const stored = index.nodes.get(line.nodeId);
  if (!expectedType || stored?.type !== expectedType) {
    return viewConfigIssue(`${line.directive} annotation ${line.nodeId} does not identify an existing ${expectedType ?? 'view configuration'} node.`);
  }
  const persistedOwner = owner.nodeId ? index.nodes.get(owner.nodeId) : undefined;
  const viewDef = findViewDef(index.nodes, persistedOwner);
  if (stored.parentId !== viewDef?.id) {
    return viewConfigIssue(`${line.directive} annotation ${line.nodeId} is not configuration for this owner.`);
  }
  return null;
}

function requiredViewField(
  index: ProjectionIndex,
  line: OutlineViewConfigLine,
): { value: ViewFieldRef } | NodeToolIssue {
  const scalar = optionalValue(line, 'field');
  if ('error' in scalar) return scalar;
  if (!scalar.present || !scalar.value) return viewConfigIssue(`${line.directive} requires exactly one field:: value.`);
  const candidate = scalar.value.targetId ?? scalar.value.text.trim();
  if (VIEW_SYSTEM_FIELDS.has(candidate as ViewFieldRef)) return { value: candidate as ViewFieldRef };
  const field = index.nodes.get(candidate);
  if (!field || field.type !== 'fieldDef' || isInTrash(index, candidate)) {
    return viewConfigIssue(`${line.directive} field:: must reference an active field definition or supported sys: field; received ${candidate || '(empty)'}.`);
  }
  return { value: candidate };
}

function optionalScalar(
  line: OutlineViewConfigLine,
  name: string,
  options: { allowClear?: boolean } = {},
): { value?: string } | NodeToolIssue {
  const parsed = optionalValue(line, name, options);
  if ('error' in parsed) return parsed;
  if (parsed.value?.targetId) {
    return viewConfigIssue(`${line.directive} ${name}:: must be literal text, not a node reference.`);
  }
  return { ...(parsed.value ? { value: parsed.value.text.trim() } : {}) };
}

function optionalNumber(
  line: OutlineViewConfigLine,
  name: string,
  options: { integer?: boolean; min?: number; max?: number },
): { value?: number } | NodeToolIssue {
  const parsed = optionalScalar(line, name);
  if ('error' in parsed) return parsed;
  if (parsed.value === undefined) return {};
  const value = Number(parsed.value);
  const invalid = !Number.isFinite(value)
    || (options.integer === true && !Number.isInteger(value))
    || (options.min !== undefined && value < options.min)
    || (options.max !== undefined && value > options.max);
  if (invalid) {
    const range = options.min !== undefined && options.max !== undefined
      ? `${options.min}-${options.max}`
      : options.min !== undefined
        ? `at least ${options.min}`
        : 'finite';
    return viewConfigIssue(`${line.directive} ${name}:: must be a ${options.integer ? 'whole number' : 'number'} ${range}.`);
  }
  return { value };
}

function optionalValue(
  line: OutlineViewConfigLine,
  name: string,
  options: { allowClear?: boolean } = {},
): { present: boolean; value?: OutlineValue } | NodeToolIssue {
  const fields = line.fields.filter((field) => normalizedFieldName(field) === name);
  if (fields.length === 0) return { present: false };
  if (fields.length !== 1) return viewConfigIssue(`${line.directive} accepts at most one ${name}:: line.`);
  const values = fields[0]!.values;
  if (values.length === 0 && options.allowClear) return { present: true };
  if (values.length !== 1) return viewConfigIssue(`${line.directive} ${name}:: requires exactly one value.`);
  return { present: true, value: values[0] };
}

function repeatedValues(
  line: OutlineViewConfigLine,
  name: string,
): { values: string[] } | NodeToolIssue {
  const values: string[] = [];
  for (const field of line.fields.filter((entry) => normalizedFieldName(entry) === name)) {
    if (field.values.length === 0) return viewConfigIssue(`${line.directive} ${name}:: cannot be empty.`);
    for (const value of field.values) {
      if (value.targetId) return viewConfigIssue(`${line.directive} ${name}:: must be literal text, not a node reference.`);
      const text = value.text.trim();
      if (!text) return viewConfigIssue(`${line.directive} ${name}:: cannot be empty.`);
      values.push(text);
    }
  }
  return { values };
}

function normalizedFieldName(field: OutlineField): string {
  return field.name.trim().toLowerCase();
}

function firstDuplicate<T>(values: readonly T[]): T | undefined {
  const seen = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

function viewConfigIssue(error: string): NodeToolIssue {
  return {
    code: 'invalid_view_config',
    error,
    instructions: `Call node_read for the current owner, keep the typed configuration lines well-formed, and retry. ${VIEW_CONFIG_OUTLINE_GUIDANCE}`,
  };
}

export function viewConfigOutlineLines(
  index: ProjectionIndex,
  owner: NodeProjection,
  level: number,
  options: { annotations?: boolean } = {},
): string[] {
  const viewDef = findViewDef(index.nodes, owner);
  if (viewDef?.type !== 'viewDef') return [];
  const children = viewDef.children.map((childId) => index.nodes.get(childId));
  const sortRules = children.filter((child): child is SortRuleNode => child?.type === 'sortRule');
  const filterRules = children.filter((child): child is FilterRuleNode => child?.type === 'filterRule');
  const displayFields = orderedDisplayFields(
    children.filter((child): child is DisplayFieldNode => child?.type === 'displayField'),
  );
  const lines: string[] = [];

  for (const rule of sortRules) {
    const field = serializedFieldReference(index, rule.sortField);
    if (!field) continue;
    lines.push(configHeader('%%view-sort%%', level, options.annotations ? rule.id : undefined));
    lines.push(configFieldLine(level, 'field', field));
    lines.push(configFieldLine(level, 'direction', rule.sortDirection === 'desc' ? 'desc' : 'asc'));
  }
  for (const rule of filterRules) {
    const field = serializedFieldReference(index, rule.filterField);
    if (!field) continue;
    const operator = FILTER_OPERATORS.has(rule.filterOperator as FilterOperator)
      ? rule.filterOperator as FilterOperator
      : 'contains';
    lines.push(configHeader('%%view-filter%%', level, options.annotations ? rule.id : undefined));
    lines.push(configFieldLine(level, 'field', field));
    lines.push(configFieldLine(level, 'operator', operator));
    lines.push(configFieldLine(level, 'logic', rule.filterValueLogic === 'all' ? 'all' : 'any'));
    for (const value of Array.isArray(rule.filterValues) ? rule.filterValues : []) {
      if (typeof value === 'string' && value.trim()) {
        lines.push(configFieldLine(level, 'value', escapeSemanticText(value)));
      }
    }
  }
  const groupField = serializedFieldReference(index, viewDef.groupField);
  if (groupField) {
    lines.push(configHeader('%%view-group%%', level));
    lines.push(configFieldLine(level, 'field', groupField));
  }
  const serializedDisplayFields = new Set<ViewFieldRef>();
  for (const display of displayFields) {
    const field = serializedFieldReference(index, display.displayField);
    if (!field || !display.displayField || serializedDisplayFields.has(display.displayField)) continue;
    serializedDisplayFields.add(display.displayField);
    lines.push(configHeader('%%view-display%%', level, options.annotations ? display.id : undefined));
    lines.push(configFieldLine(level, 'field', field));
    if (typeof display.displayLabel === 'string' && display.displayLabel) {
      lines.push(configFieldLine(level, 'label', escapeSemanticText(display.displayLabel)));
    }
    if (Number.isFinite(display.displayWidth)) lines.push(configFieldLine(level, 'width', String(display.displayWidth)));
    lines.push(configFieldLine(level, 'visible', display.displayVisible === false ? 'false' : 'true'));
    if (Number.isFinite(display.displayOrder)) lines.push(configFieldLine(level, 'order', String(display.displayOrder)));
  }
  return lines;
}

function serializedFieldReference(index: ProjectionIndex, fieldRef: ViewFieldRef | undefined): string | null {
  if (!fieldRef) return null;
  if (VIEW_SYSTEM_FIELDS.has(fieldRef)) return fieldRef;
  const field = index.nodes.get(fieldRef);
  if (!field || field.type !== 'fieldDef' || isInTrash(index, fieldRef)) return null;
  return formatNodeReferenceMarker(nodeTitle(index, field), fieldRef);
}

function configHeader(directive: string, level: number, nodeId?: string): string {
  const marker = nodeId ? `%%node:${nodeId}%% ` : '';
  return `${'  '.repeat(level)}- ${marker}${directive}`;
}

function configFieldLine(level: number, name: string, value: string): string {
  return `${'  '.repeat(level + 1)}- ${name}:: ${value}`;
}
