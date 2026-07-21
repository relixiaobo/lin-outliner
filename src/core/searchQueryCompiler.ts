import type {
  NodeId,
  QueryLogic,
  QueryOp,
  SearchQueryExpr,
  SearchQueryRule,
} from './types';

export const SEARCH_QUERY_COMPLEXITY_LIMITS = {
  maxDepth: 1_024,
  maxNodes: 10_000,
  maxOperandsPerRule: 256,
  maxChildrenPerGroup: 1_024,
} as const;

export type SearchQueryComplexityIssueCode =
  | 'invalid_search_condition'
  | 'unsupported_search_logic'
  | 'unsupported_search_rule';

export interface SearchQueryComplexityIssue {
  code: SearchQueryComplexityIssueCode;
  message: string;
  nodeId?: NodeId;
  queryLogic?: QueryLogic;
  queryOp?: QueryOp;
}

export type SearchQueryCompileResult =
  | { ok: true; query: CompiledSearchQuery }
  | { ok: false; issue: SearchQueryComplexityIssue };

export interface CompiledSearchQuery {
  rootId: number;
  nodes: CompiledSearchQueryNode[];
  terms: string[];
  hasRules: boolean;
  referencedFieldIds: string[];
  referencedTagIds: string[];
  referencedTargetIds: string[];
  maxDepth: number;
  nodeCount: number;
}

export type CompiledSearchQueryNode =
  | CompiledSearchQueryGroup
  | CompiledSearchQueryRule;

export interface CompiledSearchQueryGroup {
  id: number;
  kind: 'group';
  logic: QueryLogic;
  children: number[];
  depth: number;
}

export interface CompiledSearchQueryRule {
  id: number;
  kind: 'rule';
  rule: SearchQueryRule;
  depth: number;
}

type CompileFrame =
  | {
    phase: 'enter';
    query: SearchQueryExpr;
    parentId: number | null;
    depth: number;
  }
  | {
    phase: 'exit';
    query: object;
  };

const QUERY_LOGICS = new Set<QueryLogic>(['AND', 'OR', 'NOT']);

export function compileSearchQueryExpr(query: SearchQueryExpr): SearchQueryCompileResult {
  if (!isSearchQueryObject(query)) {
    return { ok: false, issue: invalidQueryIssue('Search query must be a rule or group object.') };
  }

  const nodes: CompiledSearchQueryNode[] = [];
  const active = new WeakSet<object>();
  const terms: string[] = [];
  const fieldIds: string[] = [];
  const tagIds: string[] = [];
  const targetIds: string[] = [];
  let hasRules = false;
  let maxDepth = 0;

  const stack: CompileFrame[] = [{
    phase: 'enter',
    query,
    parentId: null,
    depth: 1,
  }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.phase === 'exit') {
      active.delete(frame.query);
      continue;
    }

    const current = frame.query;
    if (!isSearchQueryObject(current)) {
      return { ok: false, issue: invalidQueryIssue('Search query child must be a rule or group object.') };
    }
    if (frame.depth > SEARCH_QUERY_COMPLEXITY_LIMITS.maxDepth) {
      return {
        ok: false,
        issue: invalidQueryIssue(
          `Search query is too deep; maximum depth is ${SEARCH_QUERY_COMPLEXITY_LIMITS.maxDepth}.`,
        ),
      };
    }
    if (nodes.length >= SEARCH_QUERY_COMPLEXITY_LIMITS.maxNodes) {
      return {
        ok: false,
        issue: invalidQueryIssue(
          `Search query is too large; maximum node count is ${SEARCH_QUERY_COMPLEXITY_LIMITS.maxNodes}.`,
        ),
      };
    }

    const nodeId = nodes.length;
    if (frame.parentId !== null) {
      const parent = nodes[frame.parentId];
      if (parent?.kind !== 'group') {
        return { ok: false, issue: invalidQueryIssue('Search query rule cannot contain child conditions.') };
      }
      parent.children.push(nodeId);
    }
    maxDepth = Math.max(maxDepth, frame.depth);

    if (current.kind === 'rule') {
      const operands = Array.isArray(current.operands) ? current.operands : [];
      if (operands.length > SEARCH_QUERY_COMPLEXITY_LIMITS.maxOperandsPerRule) {
        return {
          ok: false,
          issue: invalidQueryIssue(
            `Search rule "${String(current.op)}" has too many operands; maximum is ${SEARCH_QUERY_COMPLEXITY_LIMITS.maxOperandsPerRule}.`,
            current.op,
          ),
        };
      }
      nodes.push({
        id: nodeId,
        kind: 'rule',
        rule: current,
        depth: frame.depth,
      });
      hasRules = true;
      collectRuleMetadata(current, terms, fieldIds, tagIds, targetIds);
      continue;
    }

    if (current.kind !== 'group') {
      return { ok: false, issue: invalidQueryIssue('Search query node kind must be "rule" or "group".') };
    }
    if (!QUERY_LOGICS.has(current.logic)) {
      return {
        ok: false,
        issue: {
          code: 'unsupported_search_logic',
          message: `Search logic "${String(current.logic)}" is not supported yet.`,
          queryLogic: current.logic,
        },
      };
    }
    if (!Array.isArray(current.children) || current.children.length === 0) {
      return {
        ok: false,
        issue: {
          code: 'invalid_search_condition',
          message: `Search condition group has no child conditions.`,
          queryLogic: current.logic,
        },
      };
    }
    if (current.children.length > SEARCH_QUERY_COMPLEXITY_LIMITS.maxChildrenPerGroup) {
      return {
        ok: false,
        issue: invalidQueryIssue(
          `Search group "${current.logic}" has too many child conditions; maximum is ${SEARCH_QUERY_COMPLEXITY_LIMITS.maxChildrenPerGroup}.`,
        ),
      };
    }

    if (active.has(current)) {
      return { ok: false, issue: invalidQueryIssue('Search query contains a cycle.') };
    }
    active.add(current);
    nodes.push({
      id: nodeId,
      kind: 'group',
      logic: current.logic,
      children: [],
      depth: frame.depth,
    });
    stack.push({ phase: 'exit', query: current });
    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      stack.push({
        phase: 'enter',
        query: current.children[index]!,
        parentId: nodeId,
        depth: frame.depth + 1,
      });
    }
  }

  return {
    ok: true,
    query: {
      rootId: 0,
      nodes,
      terms: uniqueStrings(terms),
      hasRules,
      referencedFieldIds: uniqueStrings(fieldIds),
      referencedTagIds: uniqueStrings(tagIds),
      referencedTargetIds: uniqueStrings(targetIds),
      maxDepth,
      nodeCount: nodes.length,
    },
  };
}

function collectRuleMetadata(
  rule: SearchQueryRule,
  terms: string[],
  fieldIds: string[],
  tagIds: string[],
  targetIds: string[],
) {
  if (rule.fieldDefId) fieldIds.push(rule.fieldDefId);
  if (rule.tagDefId) tagIds.push(rule.tagDefId);
  if (rule.targetId) targetIds.push(rule.targetId);
  for (const operand of rule.operands ?? []) {
    if (operand.targetId) targetIds.push(operand.targetId);
  }
  if (rule.op !== 'STRING_MATCH') return;
  if (rule.text?.trim()) terms.push(rule.text.trim());
  for (const operand of rule.operands ?? []) {
    if (operand.text?.trim()) terms.push(operand.text.trim());
  }
}

function isSearchQueryObject(value: unknown): value is SearchQueryExpr {
  return typeof value === 'object' && value !== null;
}

function invalidQueryIssue(message: string, queryOp?: QueryOp): SearchQueryComplexityIssue {
  return {
    code: 'invalid_search_condition',
    message,
    ...(queryOp ? { queryOp } : {}),
  };
}

function uniqueStrings(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}
