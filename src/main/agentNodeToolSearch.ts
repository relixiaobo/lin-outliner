import {
  QUERY_OPS,
  type NodeProjection,
  type QueryLogic,
  type QueryOp,
  type SearchNodeConfig,
  type SearchQueryExpr,
  type SearchQueryOperand,
  type SearchQueryRule,
} from '../core/types';
import {
  SEARCH_EXECUTABLE_QUERY_OPS,
  runSearchExpr,
  searchNodeHasRules,
  searchNodeQueryTerms,
  searchNodeToQueryExpr,
  searchQueryHasRules,
  searchQueryTerms,
} from '../core/searchEngine';
import { parseLinOutline, type OutlineDocument, type OutlineNode, type OutlineValue } from './agentOutlineParser';
import {
  NODE_REFERENCE_GUIDANCE,
  SEARCH_OPERATOR_REFERENCE,
  SEARCH_QUERY_SHAPE_GUIDANCE,
} from './agentNodeToolGuidance';
import {
  checkedState,
  fieldReads,
  isInTrash,
  nodeKind,
  nodeTitle,
  normalChildIds,
  parentRef,
  snippetFor,
  tagLabel,
  tagLabels,
} from './agentNodeToolProjection';
import type {
  NodeSearchItem,
  NodeToolIssue,
  NormalizedSearchParams,
  ProjectionIndex,
  ResolvedSearchSpec,
} from './agentNodeToolTypes';
import { asRecord, clampInteger } from './agentNodeToolUtils';

const QUERY_LOGICS = new Set<QueryLogic>(['AND', 'OR', 'NOT']);
const QUERY_OP_SET = new Set<QueryOp>(QUERY_OPS);
const EXECUTABLE_QUERY_OP_SET = new Set<QueryOp>(SEARCH_EXECUTABLE_QUERY_OPS);

const FIELD_OPERAND_OPS = new Set<QueryOp>([
  'FIELD_IS',
  'FIELD_IS_NOT',
  'IS_EMPTY',
  'IS_NOT_EMPTY',
  'FIELD_CONTAINS',
  'LT',
  'GT',
  'HAS_FIELD',
  'DATE_OVERLAPS',
  'OVERDUE',
  'FIELD_IS_SET',
  'FIELD_IS_NOT_SET',
  'FIELD_IS_DEFINED',
  'FIELD_IS_NOT_DEFINED',
]);

const VALUE_OPERAND_OPS = new Set<QueryOp>([
  'STRING_MATCH',
  'FIELD_IS',
  'FIELD_IS_NOT',
  'FIELD_CONTAINS',
  'LT',
  'GT',
  'REGEXP_MATCH',
  'IS_TYPE',
  'FOR_DATE',
  'FOR_RELATIVE_DATE',
  'DATE_OVERLAPS',
  'SIBLING_NAMED',
  'CREATED_LAST_DAYS',
  'EDITED_LAST_DAYS',
  'DONE_LAST_DAYS',
]);

const TARGET_OPERAND_OPS = new Set<QueryOp>([
  'LINKS_TO',
  'CHILD_OF',
  'OWNED_BY',
  'DESCENDANT_OF',
  'DESCENDANT_OF_WITH_REFS',
]);

const ALLOWED_RULE_FIELD_NAMES = new Set(['field', 'tag', 'target', 'value', 'operand']);

export function normalizeSearchParams(rawParams: unknown): NormalizedSearchParams {
  const input = asRecord(rawParams);
  const outline = typeof input.outline === 'string' && input.outline.trim() ? input.outline.trim() : undefined;
  const searchNodeId = typeof input.search_node_id === 'string' && input.search_node_id.trim() ? input.search_node_id.trim() : undefined;
  const provided = [outline, searchNodeId].filter(Boolean).length;
  return {
    outline,
    searchNodeId,
    limit: clampInteger(input.limit, 1, 50, 20),
    offset: clampInteger(input.offset, 0, Number.MAX_SAFE_INTEGER, 0),
    count: input.count === true,
    error: provided === 1 ? undefined : 'Exactly one of outline or search_node_id is required.',
  };
}

export function buildSearchItem(index: ProjectionIndex, nodeId: string, queryTerms: string[]): NodeSearchItem {
  const node = requiredSearchNode(index, nodeId);
  const children = normalChildIds(index, nodeId, false);
  return {
    nodeId,
    title: nodeTitle(index, node),
    description: node.description ?? null,
    type: nodeKind(node),
    tags: tagLabels(index, node),
    snippet: snippetFor(node, queryTerms),
    parent: parentRef(index, node),
    fields: Object.fromEntries(fieldReads(index, node, false).map((field) => {
      const values = field.values.map((value) => value.text);
      return [field.name, values.length === 1 ? values[0] : values];
    })),
    checked: checkedState(node),
    hasChildren: children.length > 0,
    childCount: children.length,
    updatedAt: new Date(node.updatedAt).toISOString(),
  };
}

export function resolveSearchSpecFromOutlineNode(index: ProjectionIndex, node: OutlineNode): ResolvedSearchSpec | NodeToolIssue {
  if (!node.search) {
    return {
      code: 'invalid_search_node',
      error: 'Search outline root must include %%search%%.',
      instructions: SEARCH_QUERY_SHAPE_GUIDANCE,
    };
  }
  if (node.fields.length > 0) {
    return {
      code: 'invalid_search_condition',
      error: 'Search node root cannot contain fields; fields belong on rule nodes.',
      instructions: `Put field::, tag::, target::, value::, and operand:: under a query rule child. ${SEARCH_QUERY_SHAPE_GUIDANCE}`,
    };
  }
  if (node.children.length !== 1) {
    return {
      code: 'invalid_search_condition',
      error: 'Search node must contain exactly one query root child.',
      instructions: `Use an AND group when the search has multiple rules. ${SEARCH_QUERY_SHAPE_GUIDANCE}`,
    };
  }
  const query = queryExprFromOutlineNode(index, node.children[0]!);
  if ('error' in query) return query;
  return {
    title: node.title.trim() || 'Search',
    view: node.view,
    query,
    warnings: [],
  };
}

export function searchNodeConfigFromSpec(spec: ResolvedSearchSpec): SearchNodeConfig {
  return {
    title: spec.title,
    viewMode: spec.view,
    query: spec.query,
  };
}

export function searchSpecFromSavedSearch(index: ProjectionIndex, node: NodeProjection): ResolvedSearchSpec | NodeToolIssue {
  const resolved = searchNodeToQueryExpr(index.projection, node.id);
  if (!resolved.ok) {
    return {
      code: resolved.issue.code,
      error: resolved.issue.message,
      instructions: 'Fix the saved search query tree, or recreate it from a canonical search outline.',
    };
  }
  if (!resolved.query) {
    return {
      code: 'empty_search',
      error: 'Saved search has no query rules.',
      instructions: 'Add one query root child under the search node.',
    };
  }
  return {
    title: node.content.text.trim() || 'Search',
    view: node.viewMode,
    query: resolved.query,
    warnings: [],
  };
}

export function resolveSearch(index: ProjectionIndex, params: NormalizedSearchParams): {
  source: 'temporary' | 'saved';
  title?: string;
  view?: string;
  searchNodeId?: string;
  outline?: string;
  query: SearchQueryExpr;
  queryTerms: string[];
  warnings: string[];
  hasExecutableRules: boolean;
} | NodeToolIssue {
  if (params.outline) {
    const spec = parseSearchOutline(index, params.outline);
    if ('error' in spec) return spec;
    return {
      source: 'temporary',
      title: spec.title,
      view: spec.view,
      outline: params.outline,
      query: spec.query,
      queryTerms: searchQueryTerms(spec.query),
      warnings: spec.warnings,
      hasExecutableRules: searchQueryHasRules(spec.query),
    };
  }

  const searchNodeId = params.searchNodeId!;
  const node = index.nodes.get(searchNodeId);
  if (!node) return { code: 'node_not_found', error: `Search node not found: ${searchNodeId}`, instructions: 'Use a temporary search outline or locate the saved search id first.' };
  if (isInTrash(index, searchNodeId)) return { code: 'node_in_trash', error: `Search node is in Trash: ${searchNodeId}`, instructions: 'Use a non-deleted saved search node.' };
  if (node.type !== 'search') {
    return { code: 'invalid_search_node', error: `Node is not a search node: ${searchNodeId}`, instructions: 'Use node_search with a temporary search outline for keyword search.' };
  }
  const spec = searchSpecFromSavedSearch(index, node);
  if ('error' in spec) return spec;
  return {
    source: 'saved',
    title: node.content.text.trim() || 'Search',
    view: node.viewMode,
    searchNodeId,
    query: spec.query,
    queryTerms: searchNodeQueryTerms(index.projection, searchNodeId),
    warnings: spec.warnings,
    hasExecutableRules: searchNodeHasRules(index.projection, searchNodeId),
  };
}

export function runSearch(index: ProjectionIndex, search: {
  searchNodeId?: string;
  query: SearchQueryExpr;
}): string[] | NodeToolIssue {
  const result = runSearchExpr(index.projection, search.query, { searchNodeId: search.searchNodeId });
  if (!result.ok) {
    return {
      code: result.issue.code,
      error: result.issue.message,
      instructions: 'Fix the canonical search query tree and retry.',
    };
  }
  return result.hits.map((hit) => hit.nodeId);
}

export function validateReferenceTargetIds(index: ProjectionIndex, targetIds: string[]): NodeToolIssue | null {
  const missing = targetIds.find((targetId) => !index.nodes.has(targetId));
  if (missing) {
    return {
      code: 'node_not_found',
      error: `Reference target not found: ${missing}`,
      instructions: 'Use node_search to locate the target id, then retry with a reference marker like [[Display^node:...]].',
    };
  }
  const trashed = targetIds.find((targetId) => isInTrash(index, targetId));
  if (trashed) {
    return {
      code: 'node_in_trash',
      error: `Reference target is in Trash: ${trashed}`,
      instructions: 'Choose a non-deleted target node or restore the target first.',
    };
  }
  return null;
}

export function validateSearchNodes(index: ProjectionIndex, document: OutlineDocument): NodeToolIssue | null {
  for (const root of document.roots) {
    const validation = validateSearchNode(index, root);
    if (validation) return validation;
  }
  return null;
}

export function searchQueryOutlineLines(index: ProjectionIndex, node: NodeProjection, level: number): string[] {
  const indent = '  '.repeat(level);
  const spec = searchSpecFromSavedSearch(index, node);
  if ('error' in spec) return [`${indent}- Invalid search query: ${spec.error}`];
  return serializeQueryExprOutlineLines(index, spec.query, level);
}

function validateSearchNode(index: ProjectionIndex, node: OutlineNode): NodeToolIssue | null {
  if (node.search) {
    const spec = resolveSearchSpecFromOutlineNode(index, node);
    if ('error' in spec) return spec;
  }
  for (const child of node.children) {
    const validation = validateSearchNode(index, child);
    if (validation) return validation;
  }
  return null;
}

function parseSearchOutline(index: ProjectionIndex, outline: string): ResolvedSearchSpec | NodeToolIssue {
  const parsed = parseLinOutline(outline);
  if (!parsed.ok) {
    return {
      code: 'parse_error',
      error: `${parsed.error.message} Line ${parsed.error.line}, column ${parsed.error.column}.`,
      instructions: 'Fix the search outline so every non-empty line uses "- " and 2-space indentation.',
    };
  }
  if (parsed.document.roots.length !== 1) {
    return {
      code: 'ambiguous_search',
      error: 'Search outline must contain exactly one root search node.',
      instructions: 'Use one root line like "- %%search%% Open work".',
    };
  }
  return resolveSearchSpecFromOutlineNode(index, parsed.document.roots[0]!);
}

function queryExprFromOutlineNode(index: ProjectionIndex, node: OutlineNode): SearchQueryExpr | NodeToolIssue {
  const token = node.title.trim().toUpperCase();
  if (QUERY_LOGICS.has(token as QueryLogic)) {
    if (node.fields.length > 0) {
      return {
        code: 'invalid_search_condition',
        error: `Search group "${token}" cannot contain operand fields.`,
        instructions: 'Put operands under rule nodes, not group nodes.',
      };
    }
    if (node.children.length === 0) {
      return {
        code: 'invalid_search_condition',
        error: `Search group "${token}" has no child rules.`,
        instructions: 'Add at least one child rule under the group.',
      };
    }
    const children: SearchQueryExpr[] = [];
    for (const child of node.children) {
      const query = queryExprFromOutlineNode(index, child);
      if ('error' in query) return query;
      children.push(query);
    }
    return { kind: 'group', logic: token as QueryLogic, children };
  }

  if (!QUERY_OP_SET.has(token as QueryOp)) {
    return {
      code: 'unsupported_search_rule',
      error: `Unknown search rule "${node.title}".`,
      instructions: unsupportedRuleInstructions(token),
    };
  }

  const op = token as QueryOp;
  if (!EXECUTABLE_QUERY_OP_SET.has(op)) {
    return {
      code: 'unsupported_search_rule',
      error: `Search rule "${op}" is not supported by the engine.`,
      instructions: `Use a currently executable query operator.\n${SEARCH_OPERATOR_REFERENCE}`,
    };
  }
  if (node.children.length > 0) {
    return {
      code: 'invalid_search_condition',
      error: `Search rule "${op}" cannot contain child rule nodes.`,
      instructions: 'Represent rule operands as field::, tag::, target::, value::, or operand:: lines under the rule, not as child rule nodes.',
    };
  }

  const unknownField = node.fields.find((field) => !ALLOWED_RULE_FIELD_NAMES.has(normalizeFieldName(field.name)));
  if (unknownField) {
    return {
      code: 'invalid_search_condition',
      error: `Unsupported search rule operand "${unknownField.name}".`,
      instructions: 'Use only field::, tag::, target::, value::, or operand:: under query rule nodes.',
    };
  }

  const fieldDefId = referenceFromNamedField(index, node, 'field', 'fieldDef', op);
  if (isNodeToolIssue(fieldDefId)) return fieldDefId;
  const tagDefId = referenceFromNamedField(index, node, 'tag', 'tagDef', op);
  if (isNodeToolIssue(tagDefId)) return tagDefId;
  const targetId = referenceFromNamedField(index, node, 'target', undefined, op);
  if (isNodeToolIssue(targetId)) return targetId;
  const operands = valueOperandsFromRule(index, node);
  if ('error' in operands) return operands;

  const text = firstTextOperand(operands);
  const rule: SearchQueryRule = {
    kind: 'rule',
    op,
    ...(text ? { text } : {}),
    ...(fieldDefId ? { fieldDefId } : {}),
    ...(tagDefId ? { tagDefId } : {}),
    ...(targetId ? { targetId } : {}),
    ...(operands.length > 0 ? { operands } : {}),
  };
  const validation = validateRule(rule);
  if (validation) return validation;
  return rule;
}

function isNodeToolIssue(value: unknown): value is NodeToolIssue {
  return typeof value === 'object' && value !== null && 'error' in value;
}

function validateRule(rule: SearchQueryRule): NodeToolIssue | null {
  if (FIELD_OPERAND_OPS.has(rule.op) && !rule.fieldDefId && rule.op !== 'HAS_FIELD' && rule.op !== 'OVERDUE') {
    return missingRuleOperand(rule.op, 'field:: [[Field^node:...]]');
  }
  if (rule.op === 'HAS_TAG' && !rule.tagDefId) return missingRuleOperand(rule.op, 'tag:: [[#tag^node:...]]');
  if (TARGET_OPERAND_OPS.has(rule.op) && !rule.targetId) return missingRuleOperand(rule.op, 'target:: [[Target^node:...]]');
  if (VALUE_OPERAND_OPS.has(rule.op) && !rule.text && (!rule.operands || rule.operands.length === 0)) {
    return missingRuleOperand(rule.op, 'value:: ...');
  }
  return null;
}

function missingRuleOperand(op: QueryOp, operand: string): NodeToolIssue {
  return {
    code: 'invalid_search_condition',
    error: `Search rule "${op}" is missing ${operand}.`,
    instructions: `Add the required operand under the rule node. ${operandInstructionForOp(op)}`,
  };
}

function referenceFromNamedField(
  index: ProjectionIndex,
  node: OutlineNode,
  name: 'field' | 'tag' | 'target',
  expectedType?: NodeProjection['type'],
  op?: QueryOp,
): string | undefined | NodeToolIssue {
  const values = valuesForField(node, name);
  if (values.length === 0) return undefined;
  if (values.length !== 1) {
    return {
      code: 'invalid_search_condition',
      error: `Search operand "${name}" must have exactly one value.`,
      instructions: `Use one ${name}:: reference under the rule. ${referenceOperandInstruction(name, op)}`,
    };
  }
  const value = values[0]!;
  const targetId = value.targetId ?? (index.nodes.has(value.text.trim()) ? value.text.trim() : undefined);
  if (!targetId) {
    return {
      code: 'invalid_search_condition',
      error: `Search operand "${name}" must be a node reference or exact node id.`,
      instructions: referenceOperandInstruction(name, op),
    };
  }
  const target = index.nodes.get(targetId);
  if (!target) {
    return {
      code: 'node_not_found',
      error: `Search operand "${name}" references missing node: ${targetId}`,
      instructions: 'Use node_search or node_read to locate the current node id.',
    };
  }
  if (isInTrash(index, targetId)) {
    return {
      code: 'node_in_trash',
      error: `Search operand "${name}" references a trashed node: ${targetId}`,
      instructions: 'Choose a non-deleted node.',
    };
  }
  if (expectedType && target.type !== expectedType) {
    return {
      code: 'invalid_search_condition',
      error: `Search operand "${name}" must reference a ${expectedType} node.`,
      instructions: `${referenceOperandInstruction(name, op)} The referenced node must have type ${expectedType}.`,
    };
  }
  return targetId;
}

function unsupportedRuleInstructions(token: string): string {
  if (['IS_DONE', 'COMPLETED', 'COMPLETE', 'DONE_TRUE'].includes(token)) {
    return 'Use DONE for all completed nodes, NOT_DONE for visible unchecked checkbox nodes, or DONE_LAST_DAYS with value:: N for nodes completed recently. Do not use FIELD_IS for done state.';
  }
  if (['DATE', 'DATE_RANGE', 'FIELD_DATE'].includes(token)) {
    return 'Use DATE_OVERLAPS for date field values, FOR_DATE/FOR_RELATIVE_DATE for date/calendar node matching, or CREATED_LAST_DAYS/EDITED_LAST_DAYS/DONE_LAST_DAYS for system timestamps.';
  }
  return `Use a supported query operator.\n${SEARCH_OPERATOR_REFERENCE}`;
}

function operandInstructionForOp(op: QueryOp): string {
  if (op === 'DONE_LAST_DAYS') return 'Use value:: N, for example value:: 7. DONE_LAST_DAYS uses the system completed timestamp, not a field.';
  if (op === 'CREATED_LAST_DAYS' || op === 'EDITED_LAST_DAYS') return 'Use value:: N, for example value:: 7.';
  if (op === 'DATE_OVERLAPS') return 'Use field:: [[Date field^node:...]] and value:: YYYY-MM-DD/YYYY-MM-DD. DATE_OVERLAPS searches date field values only.';
  if (
    op === 'FIELD_IS'
    || op === 'FIELD_IS_NOT'
    || op === 'FIELD_CONTAINS'
    || op === 'LT'
    || op === 'GT'
    || op === 'IS_EMPTY'
    || op === 'IS_NOT_EMPTY'
    || op === 'HAS_FIELD'
    || op === 'FIELD_IS_SET'
    || op === 'FIELD_IS_NOT_SET'
    || op === 'FIELD_IS_DEFINED'
    || op === 'FIELD_IS_NOT_DEFINED'
  ) {
    return 'Use field:: [[Field^node:...]] plus value:: ... for user-defined fields. For checkbox completion state, use DONE, NOT_DONE, TODO, or DONE_LAST_DAYS instead.';
  }
  if (op === 'HAS_TAG') return 'Use tag:: [[#tag^node:...]].';
  if (op === 'LINKS_TO' || op === 'CHILD_OF' || op === 'DESCENDANT_OF' || op === 'DESCENDANT_OF_WITH_REFS' || op === 'OWNED_BY') {
    return 'Use target:: [[Node^node:...]].';
  }
  return SEARCH_QUERY_SHAPE_GUIDANCE;
}

function referenceOperandInstruction(name: 'field' | 'tag' | 'target', op?: QueryOp): string {
  if (name === 'field') {
    const base = 'Use field:: [[Field^node:...]] or an exact field definition node id. Plain field names such as "date", "done", or "Status" are not enough.';
    if (op === 'DATE_OVERLAPS') return `${base} DATE_OVERLAPS searches date field values; for nodes completed recently use DONE_LAST_DAYS value:: N.`;
    if (op === 'OVERDUE') return `${base} OVERDUE may omit field:: to check all date fields, or include field:: to limit the date field.`;
    return `${base} For checkbox completion state, use DONE, NOT_DONE, TODO, or DONE_LAST_DAYS instead of FIELD_IS.`;
  }
  if (name === 'tag') return 'Use tag:: [[#tag^node:...]] or an exact tag definition node id. Plain tag names are not enough.';
  return `Use target:: [[Node^node:...]] or an exact target node id. ${NODE_REFERENCE_GUIDANCE}`;
}

function valueOperandsFromRule(index: ProjectionIndex, node: OutlineNode): SearchQueryOperand[] | NodeToolIssue {
  const values = [...valuesForField(node, 'value'), ...valuesForField(node, 'operand')];
  const operands: SearchQueryOperand[] = [];
  for (const value of values) {
    const text = value.text.trim();
    if (value.targetId) {
      const target = index.nodes.get(value.targetId);
      if (!target) {
        return {
          code: 'node_not_found',
          error: `Search value references missing node: ${value.targetId}`,
          instructions: 'Use node_search or node_read to locate the current node id.',
        };
      }
      operands.push({ targetId: value.targetId, text: text || nodeTitle(index, target) });
    } else if (text) {
      operands.push({ text });
    }
  }
  return uniqueOperands(operands);
}

function valuesForField(node: OutlineNode, name: string): OutlineValue[] {
  return node.fields
    .filter((field) => normalizeFieldName(field.name) === name)
    .flatMap((field) => field.values);
}

function normalizeFieldName(name: string): string {
  return name.trim().toLowerCase();
}

function firstTextOperand(operands: SearchQueryOperand[]): string | undefined {
  return operands.map((operand) => operand.text?.trim()).find((text): text is string => Boolean(text));
}

function uniqueOperands(operands: SearchQueryOperand[]): SearchQueryOperand[] {
  const result: SearchQueryOperand[] = [];
  const seen = new Set<string>();
  for (const operand of operands) {
    const text = operand.text?.trim() || undefined;
    const key = `${operand.targetId ?? ''}:${(text ?? '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...(text ? { text } : {}), ...(operand.targetId ? { targetId: operand.targetId } : {}) });
  }
  return result;
}

function serializeQueryExprOutlineLines(index: ProjectionIndex, query: SearchQueryExpr, level: number): string[] {
  const indent = '  '.repeat(level);
  if (query.kind === 'group') {
    return [
      `${indent}- ${query.logic}`,
      ...query.children.flatMap((child) => serializeQueryExprOutlineLines(index, child, level + 1)),
    ];
  }

  const lines = [`${indent}- ${query.op}`];
  if (query.fieldDefId) lines.push(`${indent}  - field:: ${nodeReference(index, query.fieldDefId)}`);
  if (query.tagDefId) lines.push(`${indent}  - tag:: ${nodeReference(index, query.tagDefId, tagLabel(index.nodes.get(query.tagDefId)) ?? undefined)}`);
  if (query.targetId) lines.push(`${indent}  - target:: ${nodeReference(index, query.targetId)}`);
  const operands = query.operands?.length ? query.operands : query.text ? [{ text: query.text }] : [];
  if (operands.length === 1) {
    lines.push(`${indent}  - value:: ${operandText(index, operands[0]!)}`);
  } else {
    for (const operand of operands) lines.push(`${indent}  - value:: ${operandText(index, operand)}`);
  }
  return lines;
}

function operandText(index: ProjectionIndex, operand: SearchQueryOperand): string {
  if (operand.targetId) return nodeReference(index, operand.targetId, operand.text);
  return operand.text ?? '';
}

function nodeReference(index: ProjectionIndex, nodeId: string, label?: string): string {
  const node = index.nodes.get(nodeId);
  return `[[${label ?? (node ? nodeTitle(index, node) : nodeId)}^${nodeId}]]`;
}

function requiredSearchNode(index: ProjectionIndex, nodeId: string): NodeProjection {
  const node = index.nodes.get(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  return node;
}
