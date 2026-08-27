import { parseNodeReferenceMarkers } from './referenceMarkup';
import {
  SEARCH_EXECUTABLE_QUERY_OPS,
} from './searchEngine';
import {
  SEARCH_QUERY_COMPLEXITY_LIMITS,
  compileSearchQueryExpr,
} from './searchQueryCompiler';
import { decodeSemanticEscapes } from './semanticIngest/inlineScanner';
import {
  QUERY_OPS,
  type DocumentProjection,
  type NodeProjection,
  type QueryLogic,
  type QueryOp,
  type SearchQueryExpr,
  type SearchQueryOperand,
  type SearchQueryRule,
} from './types';

export type SearchQueryOutlineResult =
  | { readonly ok: true; readonly query: SearchQueryExpr }
  | { readonly ok: false; readonly message: string };

interface ParsedQueryNode {
  readonly title: string;
  readonly line: number;
  readonly operands: ParsedOperand[];
  readonly children: ParsedQueryNode[];
}

interface ParsedOperand {
  readonly name: 'field' | 'tag' | 'target' | 'value' | 'operand';
  readonly value: string;
  readonly line: number;
}

const QUERY_LOGICS = new Set<QueryLogic>(['AND', 'OR', 'NOT']);
const QUERY_OP_SET = new Set<QueryOp>(QUERY_OPS);
const EXECUTABLE_QUERY_OP_SET = new Set<QueryOp>(SEARCH_EXECUTABLE_QUERY_OPS);
const OPERAND_NAMES = new Set<ParsedOperand['name']>(['field', 'tag', 'target', 'value', 'operand']);

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

export function parseSearchQueryOutline(
  projection: DocumentProjection,
  queryOutline: string,
): SearchQueryOutlineResult {
  const parsed = parseOutlineTree(queryOutline);
  if (!parsed.ok) return parsed;
  const byId = new Map(projection.nodes.map((node) => [node.id, node]));
  return queryFromTree(parsed.root, projection.trashId, byId);
}

function parseOutlineTree(
  queryOutline: string,
): { readonly ok: true; readonly root: ParsedQueryNode } | { readonly ok: false; readonly message: string } {
  if (!queryOutline.trim()) return issue('Search query cannot be empty.');
  const roots: ParsedQueryNode[] = [];
  const stack: Array<{ readonly level: number; readonly node: ParsedQueryNode }> = [];
  const rawLines = queryOutline.replace(/\r\n?/g, '\n').split('\n');
  let parsedLineCount = 0;

  for (const [index, rawLine] of rawLines.entries()) {
    if (!rawLine.trim()) continue;
    parsedLineCount += 1;
    if (parsedLineCount > SEARCH_QUERY_COMPLEXITY_LIMITS.maxNodes * 2) {
      return issue(`Search query is too large; maximum node count is ${SEARCH_QUERY_COMPLEXITY_LIMITS.maxNodes}.`);
    }
    const line = index + 1;
    if (rawLine.includes('\t')) return lineIssue(line, 'Tabs are not allowed.');
    const leading = rawLine.match(/^ */)?.[0].length ?? 0;
    if (leading % 2 !== 0) return lineIssue(line, 'Indentation must use exactly 2 spaces per level.');
    const level = leading / 2;
    if (level > SEARCH_QUERY_COMPLEXITY_LIMITS.maxDepth) {
      return lineIssue(line, `Search query is too deep; maximum depth is ${SEARCH_QUERY_COMPLEXITY_LIMITS.maxDepth}.`);
    }
    const rest = rawLine.slice(leading);
    if (!rest.startsWith('- ')) return lineIssue(line, 'Every non-empty line must start with "- ".');
    const body = rest.slice(2).trim();
    if (!body) return lineIssue(line, 'Search query lines cannot be empty.');

    while (stack.length > 0 && stack.at(-1)!.level >= level) stack.pop();
    if (level > 0 && (stack.length === 0 || stack.at(-1)!.level !== level - 1)) {
      return lineIssue(line, 'Search query indentation skipped a parent level.');
    }
    const operand = parseOperand(body, line);
    if (operand) {
      const parent = stack.at(-1)?.node;
      if (!parent || level === 0) return lineIssue(line, 'Search operands require a parent rule.');
      parent.operands.push(operand);
      continue;
    }
    if (body.includes('::')) return lineIssue(line, 'Use only field::, tag::, target::, value::, or operand::.');
    if (body.includes('%%')) return lineIssue(line, 'Search query fragments cannot contain directives.');
    const node: ParsedQueryNode = { title: body, line, operands: [], children: [] };
    const parent = stack.at(-1)?.node;
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push({ level, node });
  }

  if (roots.length !== 1) return issue('Search query must contain exactly one root rule or group.');
  return { ok: true, root: roots[0]! };
}

function parseOperand(body: string, line: number): ParsedOperand | null {
  const separator = body.indexOf('::');
  if (separator < 0) return null;
  const name = body.slice(0, separator).trim().toLowerCase() as ParsedOperand['name'];
  if (!OPERAND_NAMES.has(name)) return null;
  return { name, value: decodeSemanticEscapes(body.slice(separator + 2).trim()), line };
}

function queryFromTree(
  root: ParsedQueryNode,
  trashId: string,
  byId: ReadonlyMap<string, NodeProjection>,
): SearchQueryOutlineResult {
  type Frame = {
    readonly node: ParsedQueryNode;
    readonly logic: QueryLogic;
    readonly children: SearchQueryExpr[];
    nextChild: number;
    readonly depth: number;
  };
  const stack: Frame[] = [];
  let nodeCount = 0;
  let result: SearchQueryExpr | null = null;
  const complete = (query: SearchQueryExpr) => {
    const parent = stack.at(-1);
    if (parent) parent.children.push(query);
    else result = query;
  };
  const push = (node: ParsedQueryNode, depth: number): SearchQueryOutlineResult | null => {
    nodeCount += 1;
    if (nodeCount > SEARCH_QUERY_COMPLEXITY_LIMITS.maxNodes) {
      return issue(`Search query is too large; maximum node count is ${SEARCH_QUERY_COMPLEXITY_LIMITS.maxNodes}.`);
    }
    const token = node.title.trim().toUpperCase();
    if (QUERY_LOGICS.has(token as QueryLogic)) {
      if (node.operands.length > 0) return lineIssue(node.line, `Search group "${token}" cannot contain operands.`);
      if (node.children.length === 0) return lineIssue(node.line, `Search group "${token}" has no child rules.`);
      if (node.children.length > SEARCH_QUERY_COMPLEXITY_LIMITS.maxChildrenPerGroup) {
        return lineIssue(node.line, `Search group "${token}" has too many child rules.`);
      }
      stack.push({ node, logic: token as QueryLogic, children: [], nextChild: 0, depth });
      return null;
    }
    const rule = ruleFromNode(node, trashId, byId, token);
    if (!rule.ok) return rule;
    complete(rule.query);
    return null;
  };

  const firstIssue = push(root, 1);
  if (firstIssue) return firstIssue;
  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    if (frame.nextChild >= frame.node.children.length) {
      stack.pop();
      complete({ kind: 'group', logic: frame.logic, children: frame.children });
      continue;
    }
    const child = frame.node.children[frame.nextChild++]!;
    const childIssue = push(child, frame.depth + 1);
    if (childIssue) return childIssue;
  }

  if (!result) return issue('Search query is empty.');
  const compiled = compileSearchQueryExpr(result);
  if (!compiled.ok) return issue(compiled.issue.message);
  return { ok: true, query: result };
}

function ruleFromNode(
  node: ParsedQueryNode,
  trashId: string,
  byId: ReadonlyMap<string, NodeProjection>,
  token: string,
): SearchQueryOutlineResult {
  if (!QUERY_OP_SET.has(token as QueryOp)) return lineIssue(node.line, `Unknown search rule "${node.title}".`);
  const op = token as QueryOp;
  if (!EXECUTABLE_QUERY_OP_SET.has(op)) return lineIssue(node.line, `Search rule "${op}" is not supported.`);
  if (node.children.length > 0) return lineIssue(node.line, `Search rule "${op}" cannot contain child rules.`);
  if (node.operands.length > SEARCH_QUERY_COMPLEXITY_LIMITS.maxOperandsPerRule) {
    return lineIssue(node.line, `Search rule "${op}" has too many operands.`);
  }

  const fieldDefId = referencedOperand(node, 'field', 'fieldDef', trashId, byId);
  if (typeof fieldDefId !== 'string' && fieldDefId !== undefined) return fieldDefId;
  const tagDefId = referencedOperand(node, 'tag', 'tagDef', trashId, byId);
  if (typeof tagDefId !== 'string' && tagDefId !== undefined) return tagDefId;
  const targetId = referencedOperand(node, 'target', undefined, trashId, byId);
  if (typeof targetId !== 'string' && targetId !== undefined) return targetId;
  const operands = valueOperands(node, trashId, byId);
  if (!Array.isArray(operands)) return operands;
  const text = operands.map((operand) => operand.text?.trim()).find((value): value is string => Boolean(value));
  const rule: SearchQueryRule = {
    kind: 'rule',
    op,
    ...(text ? { text } : {}),
    ...(fieldDefId ? { fieldDefId } : {}),
    ...(tagDefId ? { tagDefId } : {}),
    ...(targetId ? { targetId } : {}),
    ...(operands.length > 0 ? { operands } : {}),
  };
  const missing = missingOperand(rule);
  return missing ? lineIssue(node.line, missing) : { ok: true, query: rule };
}

function referencedOperand(
  node: ParsedQueryNode,
  name: 'field' | 'tag' | 'target',
  expectedType: NodeProjection['type'] | undefined,
  trashId: string,
  byId: ReadonlyMap<string, NodeProjection>,
): string | undefined | SearchQueryOutlineResult {
  const values = node.operands.filter((operand) => operand.name === name);
  if (values.length === 0) return undefined;
  if (values.length !== 1) return lineIssue(node.line, `Search operand "${name}" must have exactly one value.`);
  const value = values[0]!;
  const references = parseNodeReferenceMarkers(value.value);
  const exactReference = references.length === 1 && references[0]!.raw === value.value
    ? references[0]!.nodeId
    : undefined;
  const targetId = exactReference ?? (byId.has(value.value) ? value.value : undefined);
  if (!targetId) return lineIssue(value.line, `Search operand "${name}" must be a node reference or exact node id.`);
  const target = byId.get(targetId);
  if (!target) return lineIssue(value.line, `Search operand "${name}" references a missing node.`);
  if (isInTrash(targetId, trashId, byId)) return lineIssue(value.line, `Search operand "${name}" references a trashed node.`);
  if (expectedType && target.type !== expectedType) {
    return lineIssue(value.line, `Search operand "${name}" must reference a ${expectedType} node.`);
  }
  return targetId;
}

function valueOperands(
  node: ParsedQueryNode,
  trashId: string,
  byId: ReadonlyMap<string, NodeProjection>,
): SearchQueryOperand[] | SearchQueryOutlineResult {
  const result: SearchQueryOperand[] = [];
  const seen = new Set<string>();
  for (const value of node.operands.filter((operand) => operand.name === 'value' || operand.name === 'operand')) {
    const references = parseNodeReferenceMarkers(value.value);
    const reference = references.length === 1 && references[0]!.raw === value.value ? references[0] : undefined;
    if (reference) {
      const target = byId.get(reference.nodeId);
      if (!target) return lineIssue(value.line, 'Search value references a missing node.');
      if (isInTrash(reference.nodeId, trashId, byId)) return lineIssue(value.line, 'Search value references a trashed node.');
      const text = target.content.text.trim() || undefined;
      const key = `${reference.nodeId}:${text?.toLowerCase() ?? ''}`;
      if (!seen.has(key)) result.push({ targetId: reference.nodeId, ...(text ? { text } : {}) });
      seen.add(key);
      continue;
    }
    const text = value.value.trim();
    if (!text) continue;
    const key = `:${text.toLowerCase()}`;
    if (!seen.has(key)) result.push({ text });
    seen.add(key);
  }
  return result;
}

function missingOperand(rule: SearchQueryRule): string | null {
  if (FIELD_OPERAND_OPS.has(rule.op) && !rule.fieldDefId && rule.op !== 'HAS_FIELD' && rule.op !== 'OVERDUE') {
    return `Search rule "${rule.op}" requires field::.`;
  }
  if (rule.op === 'HAS_TAG' && !rule.tagDefId) return 'Search rule "HAS_TAG" requires tag::.';
  if (TARGET_OPERAND_OPS.has(rule.op) && !rule.targetId) return `Search rule "${rule.op}" requires target::.`;
  if (VALUE_OPERAND_OPS.has(rule.op) && !rule.text && (!rule.operands || rule.operands.length === 0)) {
    return `Search rule "${rule.op}" requires value:: or operand::.`;
  }
  return null;
}

function isInTrash(
  nodeId: string,
  trashId: string,
  byId: ReadonlyMap<string, NodeProjection>,
): boolean {
  const visited = new Set<string>();
  let currentId: string | undefined = nodeId;
  while (currentId && !visited.has(currentId)) {
    if (currentId === trashId) return true;
    visited.add(currentId);
    currentId = byId.get(currentId)?.parentId;
  }
  return false;
}

function issue(message: string): { readonly ok: false; readonly message: string } {
  return { ok: false, message };
}

function lineIssue(line: number, message: string): { readonly ok: false; readonly message: string } {
  return issue(`${message} Line ${line}.`);
}
