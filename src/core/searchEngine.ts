import {
  DAILY_NOTES_ID,
  LIBRARY_ID,
  RECENTS_ID,
  SCHEMA_ID,
  SEARCHES_ID,
  SETTINGS_ID,
  type SortDirection,
  TAG_DAY_ID,
  TAG_WEEK_ID,
  TAG_YEAR_ID,
  TRASH_ID,
  WORKSPACE_ID,
  inlineRefNodeId,
  type DocumentProjection,
  type DocumentState,
  type FieldType,
  type Node,
  type NodeId,
  type NodeProjection,
  plainText,
  type QueryLogic,
  type QueryOp,
  type SearchHit,
  type SearchQueryExpr,
  type SearchQueryOperand,
} from './types';
import { projectFieldConfig, nodeIsDone, nodeShowsCheckbox } from './configProjection';
import {
  dateFieldValueRangesInText,
  parseDateFieldValueRange,
  type DateFieldValueRange,
} from './dateFieldValue';
import {
  addLocalDays as addDays,
  isoLocalDate,
  startOfLocalDay,
  startOfLocalWeek,
} from './localDate';
import { intersectSetList, unionSets } from './setUtils';
import {
  createTextSearchIndex,
  type MutableTextSearchIndex,
  type TextSearchField,
  type TextSearchIndex,
  type TextSearchRecord,
} from './textSearchIndex';
import { analyzeTextSearchQuery, type TextSearchQueryAnalysis } from './textSearchAnalyzer';
import { buildReferenceSummary, type ReferenceSummary } from './references';
import { cappedMultiplier } from './ranking';
import { nodeIsInSubtree } from './treeUtils';
import {
  nodeAccessRankingMultiplier,
  type NodeAccessStats,
} from './nodeAccessRanking';
import {
  CREATED_FIELD,
  DONE_AT_FIELD,
  DONE_FIELD,
  NAME_FIELD,
  REF_COUNT_FIELD,
  UPDATED_FIELD,
  displayNode,
  isSystemFieldId,
  systemFieldValues,
} from './systemFields';

type SearchDocument = DocumentState | DocumentProjection;
type SearchNode = Node | NodeProjection;
/** A node that carries query params — a `search` (inline rule) or a `queryCondition`. */
type QueryBearingNode = Extract<SearchNode, { type: 'search' } | { type: 'queryCondition' }>;

/** Narrow a looked-up node to its query-bearing variant, or undefined. */
function asQueryBearing(node: SearchNode | undefined): QueryBearingNode | undefined {
  return node && (node.type === 'search' || node.type === 'queryCondition') ? node : undefined;
}

/** The field's type, read from its defConfig subtree (config-as-nodes). */
function fieldTypeOf(index: SearchIndex, fieldDefId: NodeId | undefined): FieldType | undefined {
  if (!fieldDefId) return undefined;
  const fieldDef = index.nodes.get(fieldDefId);
  return fieldDef?.type === 'fieldDef' ? projectFieldConfig(index.nodes, fieldDef).fieldType : undefined;
}

const SYSTEM_IDS = new Set([
  WORKSPACE_ID,
  LIBRARY_ID,
  DAILY_NOTES_ID,
  SCHEMA_ID,
  SEARCHES_ID,
  RECENTS_ID,
  TRASH_ID,
  SETTINGS_ID,
  TAG_DAY_ID,
  TAG_WEEK_ID,
  TAG_YEAR_ID,
]);

const REFERENCE_AUTHORITY_WEIGHT = 0.04;
const REFERENCE_AUTHORITY_CAP = 0.25;

const QUERY_TEXT_CONTENT_OPS = new Set<QueryOp>([
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

export const SEARCH_EXECUTABLE_QUERY_OPS = [
  'STRING_MATCH',
  'HAS_TAG',
  'LINKS_TO',
  'FIELD_CONTAINS',
  'TODO',
  'DONE',
  'NOT_DONE',
  'FIELD_IS',
  'FIELD_IS_NOT',
  'IS_EMPTY',
  'IS_NOT_EMPTY',
  'LT',
  'GT',
  'CREATED_LAST_DAYS',
  'EDITED_LAST_DAYS',
  'DONE_LAST_DAYS',
  'HAS_FIELD',
  'REGEXP_MATCH',
  'CHILD_OF',
  'IS_TYPE',
  'FOR_DATE',
  'FOR_RELATIVE_DATE',
  'DATE_OVERLAPS',
  'DESCENDANT_OF',
  'DESCENDANT_OF_WITH_REFS',
  'PARENTS_DESCENDANTS',
  'GRANDPARENTS_DESCENDANTS',
  'PARENTS_DESCENDANTS_WITH_REFS',
  'GRANDPARENTS_DESCENDANTS_WITH_REFS',
  'SIBLING_NAMED',
  'IN_LIBRARY',
  'ON_DAY_NODE',
  'OWNED_BY',
  'OVERDUE',
  'HAS_MEDIA',
  'HAS_AUDIO',
  'HAS_VIDEO',
  'HAS_IMAGE',
  'FIELD_IS_SET',
  'FIELD_IS_NOT_SET',
  'FIELD_IS_DEFINED',
  'FIELD_IS_NOT_DEFINED',
] as const satisfies readonly QueryOp[];

export const SEARCH_UNSUPPORTED_QUERY_OPS = [
  'EDITED_BY',
] as const satisfies readonly QueryOp[];

export type SearchConditionIssueCode =
  | 'invalid_search_condition'
  | 'unsupported_search_logic'
  | 'unsupported_search_rule';

export interface SearchConditionIssue {
  code: SearchConditionIssueCode;
  message: string;
  nodeId?: NodeId;
  queryLogic?: QueryLogic;
  queryOp?: QueryOp;
}

export type SearchQueryResolution =
  | { ok: true; query: SearchQueryExpr | null }
  | { ok: false; issue: SearchConditionIssue };

export type SearchRunResult =
  | { ok: true; hits: SearchHit[] }
  | { ok: false; issue: SearchConditionIssue };

export interface SearchPersonalAccessRanking {
  getNodeAccessStats(nodeId: NodeId): NodeAccessStats | undefined;
  now?: number;
}

export interface TransientSearchOptions {
  personalAccessRanking?: SearchPersonalAccessRanking;
}

export interface SearchRunOptions {
  limit?: number;
  searchNodeId?: NodeId;
  textIndex?: TextSearchIndex;
}

export interface TransientSearchRunOptions extends SearchRunOptions, TransientSearchOptions {}

interface SearchIndex {
  rootId: NodeId;
  libraryId: NodeId;
  nodes: Map<NodeId, SearchNode>;
  allNodes: SearchNode[];
}

interface SearchContext {
  searchNode: SearchNode;
  references: ReferenceSummary;
  textIndex?: TextSearchIndex;
  textAnalysisByQuery?: Map<string, TextSearchQueryAnalysis>;
}

interface SearchOperand {
  text: string;
  normalizedText: string;
  nodeId?: NodeId;
  scalar?: number;
  dateRange?: DateRange;
}

interface DateRange {
  start: number;
  end: number;
  isoStart: string;
}

type CalendarRangeUnit = 'day' | 'week' | 'year';

interface CalendarNodeRange {
  range: DateRange;
  unit: CalendarRangeUnit;
}

interface OperandResolutionOptions {
  resolveRelativeDates: boolean;
}

export function runSearchExpr(
  document: SearchDocument,
  query: SearchQueryExpr,
  options: SearchRunOptions = {},
): SearchRunResult {
  return runSearchExprInternal(document, query, options);
}

export function runTransientSearchExpr(
  document: SearchDocument,
  query: SearchQueryExpr,
  options: TransientSearchRunOptions = {},
): SearchRunResult {
  const { personalAccessRanking, ...baseOptions } = options;
  return runSearchExprInternal(document, query, baseOptions, personalAccessRanking);
}

function runSearchExprInternal(
  document: SearchDocument,
  query: SearchQueryExpr,
  options: SearchRunOptions,
  personalAccessRanking?: SearchPersonalAccessRanking,
): SearchRunResult {
  const baseIndex = indexSearchDocument(document);
  const searchNode = options.searchNodeId
    ? baseIndex.nodes.get(options.searchNodeId)
    : undefined;
  if (options.searchNodeId && !searchNode) return { ok: false, issue: invalidSearchNode(options.searchNodeId) };

  const contextSearchNode = searchNode ?? virtualSearchNode();
  const references = referenceSummaryForSearchIndex(baseIndex);
  const evalIndex: SearchIndex = {
    ...baseIndex,
    nodes: new Map(baseIndex.nodes),
  };
  let virtualCounter = 0;
  const virtualTree = virtualConditionTreeFromQueryExpr(query, contextSearchNode.id, () => `virtual:query:${virtualCounter++}`);
  for (const node of virtualTree.nodes) evalIndex.nodes.set(node.id, node);

  const candidateIds = candidateIdsForQuery(query, options.textIndex);
  const candidateNodes = candidateIds
    ? [...candidateIds].map((nodeId) => evalIndex.nodes.get(nodeId)).filter((node): node is SearchNode => Boolean(node))
    : evalIndex.allNodes;

  const scored: SearchHit[] = [];
  const textAnalysisByQuery = options.textIndex ? new Map<string, TextSearchQueryAnalysis>() : undefined;
  for (const node of candidateNodes) {
    if ((searchNode && node.id === searchNode.id) || !isSearchCandidate(evalIndex, node.id)) continue;
    const evaluation = evaluateCondition(evalIndex, node, virtualTree.root, {
      searchNode: contextSearchNode,
      references,
      textIndex: options.textIndex,
      textAnalysisByQuery,
    });
    if (!evaluation.ok) return evaluation;
    if (evaluation.match) scored.push({ nodeId: node.id, score: evaluation.score });
  }

  const sorted = sortSearchHits(scored, evalIndex, contextSearchNode, references, personalAccessRanking);
  return { ok: true, hits: typeof options.limit === 'number' ? sorted.slice(0, options.limit) : sorted };
}

function sortSearchHits(
  hits: SearchHit[],
  index: SearchIndex,
  searchNode: SearchNode,
  references: ReferenceSummary,
  personalAccessRanking?: SearchPersonalAccessRanking,
): SearchHit[] {
  const sortRule = searchNodeSortRule(index, searchNode);
  if (sortRule) return sortSearchHitsByExplicitRule(hits, index, references, sortRule);
  const ranked = hits.map((hit) => ({
    hit,
    rankingScore: rankingScore(hit, references, personalAccessRanking),
  }));
  ranked.sort((left, right) =>
    right.rankingScore - left.rankingScore
    || right.hit.score - left.hit.score
    || left.hit.nodeId.localeCompare(right.hit.nodeId)
  );
  return ranked.map((entry) => entry.hit);
}

function sortSearchHitsByExplicitRule(
  hits: SearchHit[],
  index: SearchIndex,
  references: ReferenceSummary,
  sortRule: { field: string; direction: SortDirection },
): SearchHit[] {
  const factor = sortRule.direction === 'asc' ? 1 : -1;
  return hits.sort((left, right) => {
    const result = compareSearchHitsBySortField(left, right, index, references, sortRule.field);
    return result * factor
      || right.score - left.score
      || left.nodeId.localeCompare(right.nodeId);
  });
}

function compareSearchHitsBySortField(
  left: SearchHit,
  right: SearchHit,
  index: SearchIndex,
  references: ReferenceSummary,
  fieldId: string,
): number {
  const leftNode = index.nodes.get(left.nodeId);
  const rightNode = index.nodes.get(right.nodeId);
  if (!leftNode || !rightNode) return 0;
  if (fieldId === DONE_FIELD) {
    const leftDone = displayNode(leftNode, index.nodes).completedAt ? 1 : 0;
    const rightDone = displayNode(rightNode, index.nodes).completedAt ? 1 : 0;
    return leftDone - rightDone;
  }
  if (fieldId === REF_COUNT_FIELD) {
    return referenceSortCount(left.nodeId, references) - referenceSortCount(right.nodeId, references);
  }

  const fieldType = fieldTypeOf(index, fieldId);
  const leftValues = sortValuesForNode(index, leftNode, fieldId, references);
  const rightValues = sortValuesForNode(index, rightNode, fieldId, references);
  if (isNumericSortField(fieldId, fieldType)) {
    return numericSortValue(leftValues, fieldType) - numericSortValue(rightValues, fieldType);
  }

  const leftText = leftValues.join(' ').toLocaleLowerCase();
  const rightText = rightValues.join(' ').toLocaleLowerCase();
  return leftText.localeCompare(rightText, undefined, { numeric: true, sensitivity: 'base' });
}

function rankingScore(
  hit: SearchHit,
  references: ReferenceSummary,
  personalAccessRanking?: SearchPersonalAccessRanking,
): number {
  let score = hit.score * referenceAuthorityMultiplier(hit.nodeId, references);
  if (personalAccessRanking) {
    score *= nodeAccessRankingMultiplier(
      personalAccessRanking.getNodeAccessStats(hit.nodeId),
      personalAccessRanking.now ?? Date.now(),
    );
  }
  return score;
}

function referenceAuthorityMultiplier(nodeId: NodeId, references: ReferenceSummary): number {
  return cappedMultiplier(
    Math.log1p(referenceAuthoritySourceCount(nodeId, references)),
    REFERENCE_AUTHORITY_WEIGHT,
    REFERENCE_AUTHORITY_CAP,
  );
}

function referenceAuthoritySourceCount(nodeId: NodeId, references: ReferenceSummary): number {
  const sources = references.byTarget.get(nodeId) ?? [];
  const sourceNodeIds = new Set<NodeId>();
  for (const source of sources) {
    if (source.kind === 'unlinked') continue;
    sourceNodeIds.add(source.sourceNodeId);
  }
  return sourceNodeIds.size;
}

function referenceSortCount(nodeId: NodeId, references: ReferenceSummary): number {
  return references.countsByTarget.get(nodeId)?.linked ?? 0;
}

function sortValuesForNode(index: SearchIndex, node: SearchNode, fieldId: string, references: ReferenceSummary): string[] {
  const displayed = displaySearchNode(index, node);
  if (fieldId === NAME_FIELD) return [nodeTreeText(index, displayed)].filter(Boolean);
  if (isSystemFieldId(fieldId)) {
    return systemFieldValues(displayed, fieldId, index.nodes, { referenceSummary: references });
  }

  const fieldEntry = fieldEntryNodes(index, displayed).find((entry) => entry.fieldDefId === fieldId);
  if (!fieldEntry) return [];
  const values = fieldEntry.children
    .map((childId) => index.nodes.get(childId))
    .filter((value): value is SearchNode => value !== undefined && !isInTrash(index, value.id))
    .map((value) => fieldValueText(index, value))
    .filter(Boolean);
  return values.length > 0 ? values : [nodeTreeText(index, fieldEntry)].filter(Boolean);
}

function nodeTreeText(index: SearchIndex, node: SearchNode | undefined): string {
  if (!node) return '';
  const displayed = displaySearchNode(index, node);
  if (displayed.content.text) return displayed.content.text;
  return displayed.children
    .map((childId) => nodeTreeText(index, index.nodes.get(childId)))
    .filter(Boolean)
    .join(' ');
}

function displaySearchNode(index: SearchIndex, node: SearchNode): SearchNode {
  const displayed = displayNode(node, index.nodes);
  return index.nodes.get(displayed.id) ?? node;
}

function isNumericSortField(fieldId: string, fieldType: FieldType | undefined): boolean {
  return fieldType === 'number'
    || fieldType === 'date'
    || fieldId === CREATED_FIELD
    || fieldId === UPDATED_FIELD
    || fieldId === DONE_AT_FIELD
    || fieldId === REF_COUNT_FIELD;
}

function numericSortValue(values: string[], fieldType: FieldType | undefined): number {
  const value = values[0]?.trim();
  if (!value) return Number.POSITIVE_INFINITY;
  if (fieldType === 'date') {
    const range = parseDateFieldValueRange(value);
    if (range) return range.startMs;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function searchNodeSortRule(index: SearchIndex, searchNode: SearchNode): { field: string; direction: SortDirection } | null {
  const viewDef = searchNode.children
    .map((childId) => index.nodes.get(childId))
    .find((child): child is Extract<SearchNode, { type: 'viewDef' }> => child?.type === 'viewDef');
  const sortRule = viewDef?.children
    .map((childId) => index.nodes.get(childId))
    .find((child): child is Extract<SearchNode, { type: 'sortRule' }> => child?.type === 'sortRule' && Boolean(child.sortField));
  return sortRule?.sortField
    ? { field: sortRule.sortField, direction: sortRule.sortDirection === 'desc' ? 'desc' : 'asc' }
    : null;
}

export function runSearchNode(
  document: SearchDocument,
  searchNodeId: NodeId,
  options: Omit<SearchRunOptions, 'searchNodeId'> = {},
): SearchRunResult {
  const resolved = searchNodeToQueryExpr(document, searchNodeId);
  if (!resolved.ok) return { ok: false, issue: resolved.issue };
  if (!resolved.query) return { ok: true, hits: [] };
  return runSearchExpr(document, resolved.query, { ...options, searchNodeId });
}

export function searchNodeToQueryExpr(document: SearchDocument, searchNodeId: NodeId): SearchQueryResolution {
  const index = indexSearchDocument(document);
  const searchNode = index.nodes.get(searchNodeId);
  if (!searchNode) return { ok: false, issue: invalidSearchNode(searchNodeId) };

  const conditionNodes = searchNode.children
    .map((childId) => index.nodes.get(childId))
    .filter((child): child is QueryBearingNode => child?.type === 'queryCondition' && !isInTrash(index, child.id));

  if (conditionNodes.length === 0) {
    const inlineRule = asQueryBearing(searchNode);
    if (!inlineRule?.queryOp) return { ok: true, query: null };
    return queryExprFromConditionNode(index, inlineRule);
  }

  const children: SearchQueryExpr[] = [];
  for (const conditionNode of conditionNodes) {
    const resolved = queryExprFromConditionNode(index, conditionNode);
    if (!resolved.ok) return resolved;
    if (resolved.query) children.push(resolved.query);
  }

  if (children.length === 0) return { ok: true, query: null };
  if (children.length === 1) return { ok: true, query: children[0]! };
  return { ok: true, query: { kind: 'group', logic: 'AND', children } };
}

export function searchNodeHasRules(document: SearchDocument, searchNodeId: NodeId): boolean {
  const resolved = searchNodeToQueryExpr(document, searchNodeId);
  return resolved.ok && searchQueryHasRules(resolved.query);
}

export function searchQueryHasRules(query: SearchQueryExpr | null | undefined): boolean {
  if (!query) return false;
  if (query.kind === 'rule') return true;
  return query.children.some(searchQueryHasRules);
}

export function searchNodeQueryTerms(document: SearchDocument, searchNodeId: NodeId): string[] {
  const resolved = searchNodeToQueryExpr(document, searchNodeId);
  return resolved.ok ? searchQueryTerms(resolved.query) : [];
}

export function searchQueryTerms(query: SearchQueryExpr | null | undefined): string[] {
  const terms: string[] = [];
  collectQueryExprTerms(query, terms);
  return uniqueStrings(terms);
}

export function isCoreSearchCandidate(document: SearchDocument, nodeId: NodeId): boolean {
  return isSearchCandidate(indexSearchDocument(document), nodeId);
}

export function scoreSearchTerm(document: SearchDocument, nodeId: NodeId, term: string): number {
  const index = indexSearchDocument(document);
  const node = index.nodes.get(nodeId);
  return node ? scoreTerm(index, node, term) : 0;
}

export interface NodeTextSearchRecord {
  record: TextSearchRecord;
  dependencies: {
    tagDefIds: string[];
    fieldDefIds: string[];
    referencedNodeIds: string[];
  };
}

export interface TextSearchRecordSnapshot {
  records: NodeTextSearchRecord[];
  nodes: Map<NodeId, SearchNode>;
  rootId: NodeId;
  libraryId: NodeId;
}

export function buildTextSearchIndex(document: SearchDocument): MutableTextSearchIndex {
  return createTextSearchIndex(buildTextSearchRecordSnapshot(document).records.map((entry) => entry.record));
}

export function buildTextSearchRecordSnapshot(document: SearchDocument): TextSearchRecordSnapshot {
  const index = indexSearchDocument(document);
  const records = index.allNodes
    .map((node) => textSearchRecordForNode(index, node.id))
    .filter((entry): entry is NodeTextSearchRecord => Boolean(entry));
  return {
    records,
    nodes: new Map(index.nodes),
    rootId: index.rootId,
    libraryId: index.libraryId,
  };
}

export function textSearchRecordForNodeMap(
  nodes: ReadonlyMap<NodeId, SearchNode>,
  rootId: NodeId,
  libraryId: NodeId,
  nodeId: NodeId,
): NodeTextSearchRecord | null {
  return textSearchRecordForNode({
    rootId,
    libraryId,
    nodes: nodes as Map<NodeId, SearchNode>,
    allNodes: [],
  }, nodeId);
}

function referenceSummaryForSearchIndex(index: SearchIndex): ReferenceSummary {
  return buildReferenceSummary(index.nodes, {
    isDeleted: (nodeId) => isInTrash(index, nodeId),
  });
}

function indexSearchDocument(document: SearchDocument): SearchIndex {
  const allNodes = Array.isArray(document.nodes)
    ? document.nodes
    : Object.values(document.nodes);
  return {
    rootId: document.rootId,
    libraryId: 'libraryId' in document ? document.libraryId : LIBRARY_ID,
    allNodes,
    nodes: new Map(allNodes.map((node) => [node.id, node])),
  };
}

function queryExprFromConditionNode(index: SearchIndex, conditionNode: QueryBearingNode): SearchQueryResolution {
  if (conditionNode.queryOp) {
    const text = QUERY_TEXT_CONTENT_OPS.has(conditionNode.queryOp)
      ? conditionNode.content.text.trim()
      : '';
    return {
      ok: true,
      query: {
        kind: 'rule',
        op: conditionNode.queryOp,
        ...(text ? { text } : {}),
        ...(conditionNode.queryFieldDefId ? { fieldDefId: conditionNode.queryFieldDefId } : {}),
        ...(conditionNode.queryTagDefId ? { tagDefId: conditionNode.queryTagDefId } : {}),
        ...(conditionNode.queryTargetId ? { targetId: conditionNode.queryTargetId } : {}),
        ...queryOperandsFromConditionNode(index, conditionNode),
      },
    };
  }

  if (!conditionNode.queryLogic) {
    return {
      ok: false,
      issue: {
        code: 'invalid_search_condition',
        message: `Search condition has no query operator: ${conditionNode.id}`,
        nodeId: conditionNode.id,
      },
    };
  }

  const childConditions = conditionNode.children
    .map((childId) => index.nodes.get(childId))
    .filter((child): child is QueryBearingNode => child?.type === 'queryCondition' && !isInTrash(index, child.id));
  const children: SearchQueryExpr[] = [];
  for (const childCondition of childConditions) {
    const resolved = queryExprFromConditionNode(index, childCondition);
    if (!resolved.ok) return resolved;
    if (resolved.query) children.push(resolved.query);
  }

  return { ok: true, query: { kind: 'group', logic: conditionNode.queryLogic, children } };
}

function queryOperandsFromConditionNode(index: SearchIndex, conditionNode: QueryBearingNode): { operands?: SearchQueryOperand[] } {
  const operands = conditionNode.children.flatMap((childId): SearchQueryOperand[] => {
    const child = index.nodes.get(childId);
    if (!child || child.type === 'queryCondition' || isInTrash(index, child.id)) return [];
    if (child.type === 'reference' && child.targetId) {
      const target = index.nodes.get(child.targetId);
      return [{ targetId: child.targetId, text: target?.content.text.trim() || child.content.text.trim() || undefined }];
    }
    const inlineRef = child.content.inlineRefs[0];
    const inlineNodeId = inlineRef ? inlineRefNodeId(inlineRef) : null;
    if (inlineNodeId) {
      return [{ targetId: inlineNodeId, text: inlineRef?.displayName || child.content.text.trim() || undefined }];
    }
    const text = child.content.text.trim();
    return text ? [{ text }] : [];
  });
  return operands.length > 0 ? { operands: uniqueQueryOperands(operands) } : {};
}

type SearchEvaluation =
  | { ok: true; match: boolean; score: number }
  | { ok: false; issue: SearchConditionIssue };

function evaluateSearchNode(index: SearchIndex, candidate: SearchNode, searchNode: SearchNode): SearchEvaluation {
  const context: SearchContext = { searchNode, references: referenceSummaryForSearchIndex(index) };
  const conditionNodes = searchNode.children
    .map((childId) => index.nodes.get(childId))
    .filter((child): child is QueryBearingNode => child?.type === 'queryCondition' && !isInTrash(index, child.id));

  if (conditionNodes.length > 0) return evaluateAnd(index, candidate, conditionNodes, context);
  const inlineRule = asQueryBearing(searchNode);
  if (inlineRule?.queryOp) return evaluateLeafNode(index, candidate, inlineRule, context);
  return { ok: true, match: false, score: 0 };
}

function evaluateCondition(index: SearchIndex, candidate: SearchNode, conditionNode: QueryBearingNode, context: SearchContext): SearchEvaluation {
  if (conditionNode.queryOp) return evaluateLeafNode(index, candidate, conditionNode, context);
  if (!conditionNode.queryLogic) {
    return {
      ok: false,
      issue: {
        code: 'invalid_search_condition',
        message: `Search condition has no query operator: ${conditionNode.id}`,
        nodeId: conditionNode.id,
      },
    };
  }

  const childConditions = conditionNode.children
    .map((childId) => index.nodes.get(childId))
    .filter((child): child is QueryBearingNode => child?.type === 'queryCondition' && !isInTrash(index, child.id));
  if (childConditions.length === 0) {
    return {
      ok: false,
      issue: {
        code: 'invalid_search_condition',
        message: `Search condition group has no child conditions: ${conditionNode.id}`,
        nodeId: conditionNode.id,
        queryLogic: conditionNode.queryLogic,
      },
    };
  }

  if (conditionNode.queryLogic === 'AND') return evaluateAnd(index, candidate, childConditions, context);
  if (conditionNode.queryLogic === 'OR') return evaluateOr(index, candidate, childConditions, context);
  if (conditionNode.queryLogic === 'NOT') return evaluateNot(index, candidate, childConditions, context);

  return {
    ok: false,
    issue: {
      code: 'unsupported_search_logic',
      message: `Search logic "${conditionNode.queryLogic}" is not supported yet.`,
      nodeId: conditionNode.id,
      queryLogic: conditionNode.queryLogic,
    },
  };
}

function evaluateAnd(index: SearchIndex, candidate: SearchNode, conditions: QueryBearingNode[], context: SearchContext): SearchEvaluation {
  let score = 0;
  for (const condition of conditions) {
    const evaluation = evaluateCondition(index, candidate, condition, context);
    if (!evaluation.ok) return evaluation;
    if (!evaluation.match) return { ok: true, match: false, score: 0 };
    score += evaluation.score;
  }
  return { ok: true, match: true, score: Math.max(score, 1) };
}

function evaluateOr(index: SearchIndex, candidate: SearchNode, conditions: QueryBearingNode[], context: SearchContext): SearchEvaluation {
  let score = 0;
  let matched = false;
  for (const condition of conditions) {
    const evaluation = evaluateCondition(index, candidate, condition, context);
    if (!evaluation.ok) return evaluation;
    if (!evaluation.match) continue;
    matched = true;
    score += evaluation.score;
  }
  return { ok: true, match: matched, score: matched ? Math.max(score, 1) : 0 };
}

function evaluateNot(index: SearchIndex, candidate: SearchNode, conditions: QueryBearingNode[], context: SearchContext): SearchEvaluation {
  for (const condition of conditions) {
    const evaluation = evaluateCondition(index, candidate, condition, context);
    if (!evaluation.ok) return evaluation;
    if (evaluation.match) return { ok: true, match: false, score: 0 };
  }
  return { ok: true, match: true, score: 5 };
}

function evaluateLeafNode(index: SearchIndex, candidate: SearchNode, conditionNode: QueryBearingNode, context: SearchContext): SearchEvaluation {
  if (conditionNode.queryLogic && conditionNode.queryLogic !== 'AND') {
    return {
      ok: false,
      issue: {
        code: 'unsupported_search_logic',
        message: `Search logic "${conditionNode.queryLogic}" is not supported on leaf rules.`,
        nodeId: conditionNode.id,
        queryLogic: conditionNode.queryLogic,
      },
    };
  }
  return evaluateLeaf(index, candidate, conditionNode, context);
}

function evaluateLeaf(index: SearchIndex, candidate: SearchNode, conditionNode: QueryBearingNode, context: SearchContext): SearchEvaluation {
  const op = conditionNode.queryOp;
  if (!op) {
    return {
      ok: false,
      issue: {
        code: 'invalid_search_condition',
        message: `Search condition has no query operator: ${conditionNode.id}`,
        nodeId: conditionNode.id,
      },
    };
  }

  if (op === 'HAS_TAG') {
    if (!conditionNode.queryTagDefId) return { ok: true, match: candidate.tags.length > 0, score: 12 };
    return { ok: true, match: candidate.tags.includes(conditionNode.queryTagDefId), score: 25 };
  }
  if (op === 'TODO') return { ok: true, match: nodeShowsCheckbox(index.nodes, candidate), score: 10 };
  if (op === 'DONE') return { ok: true, match: nodeIsDone(candidate), score: 10 };
  if (op === 'NOT_DONE') return { ok: true, match: nodeShowsCheckbox(index.nodes, candidate) && !nodeIsDone(candidate), score: 10 };

  if (op === 'FIELD_IS' || op === 'FIELD_IS_NOT') {
    if (!conditionNode.queryFieldDefId) return missingEvaluationOperand(conditionNode, op, 'field id');
    const ruleOperands = conditionOperands(index, conditionNode, context);
    if (ruleOperands.length === 0) return missingEvaluationOperand(conditionNode, op, 'comparison value');
    const fieldType = fieldTypeOf(index, conditionNode.queryFieldDefId);
    const candidateField = comparableFieldState(index, candidate, conditionNode.queryFieldDefId);
    const hasMatch = candidateField.values.some((value) =>
      ruleOperands.some((operand) => valueMatchesOperand(value, operand, fieldType)));
    return { ok: true, match: op === 'FIELD_IS' ? hasMatch : candidateField.hasField && !hasMatch, score: 18 };
  }

  if (op === 'IS_EMPTY' || op === 'IS_NOT_EMPTY') {
    if (!conditionNode.queryFieldDefId) return missingEvaluationOperand(conditionNode, op, 'field id');
    const candidateField = comparableFieldState(index, candidate, conditionNode.queryFieldDefId);
    const hasValue = candidateField.values.length > 0;
    return { ok: true, match: op === 'IS_EMPTY' ? candidateField.hasField && !hasValue : hasValue, score: 12 };
  }

  if (op === 'FIELD_IS_SET' || op === 'FIELD_IS_NOT_SET' || op === 'FIELD_IS_DEFINED' || op === 'FIELD_IS_NOT_DEFINED') {
    if (!conditionNode.queryFieldDefId) return missingEvaluationOperand(conditionNode, op, 'field id');
    const candidateField = comparableFieldState(index, candidate, conditionNode.queryFieldDefId);
    const isDefined = candidateField.hasField;
    const isSet = candidateField.values.length > 0;
    const match = op === 'FIELD_IS_SET'
      ? isSet
      : op === 'FIELD_IS_NOT_SET'
        ? !isSet
        : op === 'FIELD_IS_DEFINED'
          ? isDefined
          : !isDefined;
    return { ok: true, match, score: 12 };
  }

  if (op === 'HAS_FIELD') {
    const fields = fieldReads(index, candidate);
    const match = conditionNode.queryFieldDefId
      ? fields.some((field) => field.fieldDefId === conditionNode.queryFieldDefId)
      : fields.length > 0;
    return { ok: true, match, score: 12 };
  }

  if (op === 'GT' || op === 'LT') {
    if (!conditionNode.queryFieldDefId) return missingEvaluationOperand(conditionNode, op, 'field id');
    const ruleScalar = conditionComparableScalar(index, conditionNode, context);
    if (ruleScalar === null) return missingEvaluationOperand(conditionNode, op, 'comparison value');
    const candidateScalars = comparableFieldScalars(index, candidate, conditionNode.queryFieldDefId, fieldTypeOf(index, conditionNode.queryFieldDefId));
    const match = candidateScalars.some((value) => op === 'GT' ? value > ruleScalar : value < ruleScalar);
    return { ok: true, match, score: 18 };
  }

  if (op === 'FIELD_CONTAINS') {
    if (!conditionNode.queryFieldDefId) return missingEvaluationOperand(conditionNode, op, 'field id');
    const ruleOperands = conditionOperands(index, conditionNode, context);
    const text = ruleOperands.length > 0
      ? ruleOperands.map((operand) => operand.text).join(' ')
      : conditionNode.content.text;
    return {
      ok: true,
      match: nodeMatchesFieldCondition(index, candidate, conditionNode.queryFieldDefId, text),
      score: 18,
    };
  }

  if (op === 'LINKS_TO') {
    const targetId = conditionTargetId(index, conditionNode, context);
    if (!targetId) return missingEvaluationOperand(conditionNode, op, 'target id');
    return { ok: true, match: nodeLinksTo(candidate, targetId, context), score: 20 };
  }

  if (op === 'STRING_MATCH') {
    const score = context.textIndex
      ? scoreTextSearchRecord(context, candidate.id, conditionNode.content.text)
      : scoreTerm(index, candidate, conditionNode.content.text);
    return { ok: true, match: score > 0, score };
  }

  if (op === 'REGEXP_MATCH') {
    const regexp = regexpFromCondition(conditionNode);
    if (!regexp) return missingEvaluationOperand(conditionNode, op, 'valid regular expression');
    const haystack = `${candidate.content.text}\n${candidate.description ?? ''}`;
    return { ok: true, match: regexp.test(haystack), score: 30 };
  }

  if (op === 'CHILD_OF' || op === 'OWNED_BY' || op === 'DESCENDANT_OF' || op === 'DESCENDANT_OF_WITH_REFS') {
    const targetId = conditionTargetId(index, conditionNode, context);
    if (!targetId) return missingEvaluationOperand(conditionNode, op, 'target id');
    const match = op === 'CHILD_OF'
      ? nodeIsChildOf(index, candidate, targetId)
      : op === 'OWNED_BY'
        ? candidate.parentId === targetId
        : op === 'DESCENDANT_OF_WITH_REFS'
          ? nodeIsInTreeUnderWithRefs(index, candidate, targetId, context)
          : isDescendantOf(index, candidate.id, targetId);
    return { ok: true, match, score: 16 };
  }

  if (
    op === 'PARENTS_DESCENDANTS'
    || op === 'GRANDPARENTS_DESCENDANTS'
    || op === 'PARENTS_DESCENDANTS_WITH_REFS'
    || op === 'GRANDPARENTS_DESCENDANTS_WITH_REFS'
  ) {
    const targetId = scopedAncestorId(index, context.searchNode, op.startsWith('GRANDPARENTS') ? 'grandparent' : 'parent');
    if (!targetId) return missingEvaluationOperand(conditionNode, op, 'search node parent');
    const match = op.endsWith('WITH_REFS')
      ? nodeIsInTreeUnderWithRefs(index, candidate, targetId, context)
      : isDescendantOf(index, candidate.id, targetId);
    return { ok: true, match, score: 16 };
  }

  if (op === 'SIBLING_NAMED') {
    const siblingName = conditionNode.content.text.trim();
    if (!siblingName) return missingEvaluationOperand(conditionNode, op, 'sibling name');
    const sibling = findSiblingNamed(index, context.searchNode, siblingName);
    return { ok: true, match: Boolean(sibling && isDescendantOf(index, candidate.id, sibling.id)), score: 16 };
  }

  if (op === 'IN_LIBRARY') return { ok: true, match: candidate.parentId === index.libraryId, score: 12 };

  if (op === 'ON_DAY_NODE') return { ok: true, match: Boolean(candidate.parentId && isDayNode(index, candidate.parentId)), score: 12 };

  if (op === 'IS_TYPE') {
    const expectedTypes = conditionComparableValues(index, conditionNode, context);
    if (expectedTypes.length === 0) return missingEvaluationOperand(conditionNode, op, 'node type');
    return { ok: true, match: expectedTypes.some((expectedType) => nodeMatchesType(index, candidate, expectedType)), score: 12 };
  }

  if (op === 'FOR_DATE' || op === 'FOR_RELATIVE_DATE') {
    const dateOperands = conditionOperands(index, conditionNode, context)
      .filter((operand) => operand.dateRange);
    if (dateOperands.length === 0) return missingEvaluationOperand(conditionNode, op, 'date value');
    return { ok: true, match: nodeMatchesDateOperands(index, candidate, dateOperands), score: 18 };
  }

  if (op === 'DATE_OVERLAPS') {
    if (!conditionNode.queryFieldDefId) return missingEvaluationOperand(conditionNode, op, 'field id');
    const ranges = conditionOperands(index, conditionNode, context)
      .map((operand) => operand.dateRange)
      .filter((range): range is DateRange => Boolean(range));
    if (ranges.length === 0) return missingEvaluationOperand(conditionNode, op, 'date value');
    const candidateRanges = fieldDateRanges(index, candidate, conditionNode.queryFieldDefId);
    return { ok: true, match: candidateRanges.some((candidateRange) => ranges.some((range) => rangesOverlap(candidateRange, range))), score: 18 };
  }

  if (op === 'CREATED_LAST_DAYS' || op === 'EDITED_LAST_DAYS' || op === 'DONE_LAST_DAYS') {
    const days = conditionDays(conditionNode);
    if (days === null) return missingEvaluationOperand(conditionNode, op, 'day count');
    const timestamp = op === 'CREATED_LAST_DAYS'
      ? candidate.createdAt
      : op === 'EDITED_LAST_DAYS'
        ? candidate.updatedAt
        : candidate.completedAt;
    if (!timestamp) return { ok: true, match: false, score: 0 };
    return { ok: true, match: timestamp >= Date.now() - days * 24 * 60 * 60 * 1000, score: 12 };
  }

  if (op === 'OVERDUE') return { ok: true, match: nodeIsOverdue(index, candidate, conditionNode), score: 18 };

  if (op === 'HAS_MEDIA' || op === 'HAS_AUDIO' || op === 'HAS_VIDEO' || op === 'HAS_IMAGE') {
    return { ok: true, match: nodeHasMediaKind(candidate, op), score: 14 };
  }

  return {
    ok: false,
    issue: {
      code: 'unsupported_search_rule',
      message: `Search rule "${op}" is not supported yet.`,
      nodeId: conditionNode.id,
      queryOp: op,
    },
  };
}

function missingEvaluationOperand(conditionNode: QueryBearingNode, op: QueryOp, operand: string): SearchEvaluation {
  return {
    ok: false,
    issue: {
      code: 'invalid_search_condition',
      message: `Search rule "${op}" is missing ${operand}.`,
      nodeId: conditionNode.id,
      queryOp: op,
    },
  };
}

function virtualConditionTreeFromQueryExpr(
  query: SearchQueryExpr,
  parentId: NodeId | undefined,
  nextId: () => NodeId,
): { root: QueryBearingNode; nodes: SearchNode[] } {
  const node = virtualNode(nextId(), parentId, 'queryCondition', query.kind === 'rule' ? query.text ?? '' : '') as QueryBearingNode;
  const nodes: SearchNode[] = [node];

  if (query.kind === 'group') {
    node.queryLogic = query.logic;
    for (const child of query.children) {
      const childTree = virtualConditionTreeFromQueryExpr(child, node.id, nextId);
      node.children.push(childTree.root.id);
      nodes.push(...childTree.nodes);
    }
    return { root: node, nodes };
  }

  node.queryOp = query.op;
  if (query.fieldDefId) node.queryFieldDefId = query.fieldDefId;
  if (query.tagDefId) node.queryTagDefId = query.tagDefId;
  if (query.targetId) node.queryTargetId = query.targetId;
  for (const operand of query.operands ?? []) {
    const operandNode = virtualNode(nextId(), node.id, operand.targetId ? 'reference' : undefined, operand.text ?? '');
    if (operand.targetId) (operandNode as Extract<SearchNode, { type: 'reference' }>).targetId = operand.targetId;
    node.children.push(operandNode.id);
    nodes.push(operandNode);
  }
  return { root: node, nodes };
}

function virtualSearchNode(): SearchNode {
  return virtualNode('virtual:search', undefined, 'search', 'Search');
}

function virtualNode(
  id: NodeId,
  parentId: NodeId | undefined,
  type: SearchNode['type'],
  text: string,
): SearchNode {
  return {
    id,
    type,
    parentId,
    children: [],
    content: plainText(text),
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    locked: false,
    autoCollected: false,
  };
}

function invalidSearchNode(searchNodeId: NodeId): SearchConditionIssue {
  return {
    code: 'invalid_search_condition',
    message: `Search node not found: ${searchNodeId}`,
    nodeId: searchNodeId,
  };
}

function scoreTextSearchRecord(context: SearchContext, nodeId: NodeId, query: string): number {
  const textIndex = context.textIndex;
  if (!textIndex) return 0;
  let analysis = context.textAnalysisByQuery?.get(query);
  if (!analysis) {
    analysis = analyzeTextSearchQuery(query);
    context.textAnalysisByQuery?.set(query, analysis);
  }
  return textIndex.scoreAnalyzedRecord(nodeId, analysis, { includeSnippet: false })?.score ?? 0;
}

function scoreTerm(index: SearchIndex, node: SearchNode, term: string): number {
  // Compatibility scorer for direct core calls that do not provide a
  // TextSearchIndex. DocumentService, launcher search, and agent node_search pass
  // the live index, so this is not a competing main/agent ranker.
  const q = term.trim().toLowerCase();
  if (!q) return 0;
  let score = 0;
  const text = node.content.text.toLowerCase();
  if (text === q) score += 100;
  else if (text.startsWith(q)) score += 60;
  else if (text.includes(q)) score += 30;
  if (node.description?.toLowerCase().includes(q)) score += 15;
  for (const tagName of tagNames(index, node)) {
    if (tagName.toLowerCase().includes(q)) score += 15;
  }
  for (const field of fieldReads(index, node)) {
    if (field.name.toLowerCase().includes(q)) score += 8;
    for (const value of field.values) {
      if (value.toLowerCase().includes(q)) score += 10;
    }
  }
  return score;
}

function candidateIdsForQuery(query: SearchQueryExpr, textIndex: TextSearchIndex | undefined): Set<NodeId> | null {
  if (!textIndex) return null;
  if (query.kind === 'rule') {
    if (query.op !== 'STRING_MATCH' || !query.text?.trim()) return null;
    const candidates = textIndex.candidateIds(query.text);
    return candidates.size > 0 ? candidates : null;
  }

  const childSets = query.children.map((child) => candidateIdsForQuery(child, textIndex));
  if (query.logic === 'NOT') return null;
  if (query.logic === 'AND') {
    const positiveSets = childSets.filter((set): set is Set<NodeId> => Boolean(set));
    if (positiveSets.length === 0) return null;
    return intersectSetList(positiveSets);
  }
  if (query.logic === 'OR') {
    if (childSets.length === 0 || childSets.some((set) => !set)) return null;
    return unionSets(childSets as Set<NodeId>[]);
  }
  return null;
}

function textSearchRecordForNode(index: SearchIndex, nodeId: NodeId): NodeTextSearchRecord | null {
  const node = index.nodes.get(nodeId);
  if (!node || !isSearchCandidate(index, nodeId)) return null;

  const fields: TextSearchField[] = [];
  const title = node.content.text.trim();
  if (title) fields.push({ key: 'title', text: title });
  if (node.description?.trim()) fields.push({ key: 'description', text: node.description });
  if (node.type === 'codeBlock' && title) fields.push({ key: 'body', text: title });

  const tagDefIds = uniqueStrings(node.tags);
  for (const tagName of tagNames(index, node)) {
    fields.push({ key: 'tag', text: tagName });
    fields.push({ key: 'tag', text: `#${tagName}` });
  }

  const fieldDefIds: string[] = [];
  const referencedNodeIds: string[] = [];
  for (const field of fieldReads(index, node)) {
    if (field.name.trim()) fields.push({ key: 'fieldName', text: field.name });
    if (field.fieldDefId) fieldDefIds.push(field.fieldDefId);
    for (const value of field.values) {
      if (value.trim()) fields.push({ key: 'fieldValue', text: value });
    }
  }
  for (const valueNode of fieldValueNodes(index, node)) {
    if (valueNode.type === 'reference' && valueNode.targetId) referencedNodeIds.push(valueNode.targetId);
  }

  if (fields.length === 0) return null;
  return {
    record: {
      id: node.id,
      kind: node.type ?? 'node',
      fields,
      updatedAt: node.updatedAt,
    },
    dependencies: {
      tagDefIds,
      fieldDefIds: uniqueStrings(fieldDefIds),
      referencedNodeIds: uniqueStrings(referencedNodeIds),
    },
  };
}

function nodeLinksTo(node: SearchNode, targetId: NodeId, context: SearchContext): boolean {
  const sources = context.references.byTarget.get(targetId) ?? [];
  return sources.some((source) => source.kind !== 'unlinked' && source.sourceNodeId === node.id);
}

function nodeIsChildOf(index: SearchIndex, node: SearchNode, targetId: NodeId): boolean {
  if (node.parentId === targetId) return true;
  const target = index.nodes.get(targetId);
  return Boolean(target?.children.some((childId) => {
    const child = index.nodes.get(childId);
    return child?.type === 'reference' && child.targetId === node.id && !isInTrash(index, child.id);
  }));
}

function nodeIsInTreeUnderWithRefs(index: SearchIndex, node: SearchNode, targetId: NodeId, context: SearchContext): boolean {
  if (isDescendantOf(index, node.id, targetId)) return true;
  const sources = context.references.byTarget.get(node.id) ?? [];
  return sources.some((source) =>
    source.kind !== 'unlinked'
    && (source.sourceNodeId === targetId || isDescendantOf(index, source.sourceNodeId, targetId)));
}

function nodeMatchesFieldCondition(index: SearchIndex, node: SearchNode, fieldDefId: NodeId, text?: string): boolean {
  const fields = fieldReads(index, node).filter((field) => field.fieldDefId === fieldDefId);
  if (fields.length === 0) return false;
  const needle = text?.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => field.values.some((value) => value.toLowerCase().includes(needle)));
}

function comparableFieldState(index: SearchIndex, node: SearchNode, fieldDefId: NodeId): { hasField: boolean; values: string[] } {
  const fields = fieldReads(index, node).filter((field) => field.fieldDefId === fieldDefId);
  return {
    hasField: fields.length > 0,
    values: fields.flatMap((field) => field.values).map((value) => value.trim()).filter(Boolean),
  };
}

function comparableFieldScalars(index: SearchIndex, node: SearchNode, fieldDefId: NodeId, fieldType?: string): number[] {
  return comparableFieldState(index, node, fieldDefId).values
    .map((value) => comparableScalar(value, fieldType))
    .filter((value): value is number => value !== null);
}

function fieldDateRanges(index: SearchIndex, node: SearchNode, fieldDefId: NodeId): DateRange[] {
  const entries = fieldEntryNodes(index, node).filter((fieldEntry) => fieldEntry.fieldDefId === fieldDefId);
  return uniqueDateRanges(entries.flatMap((fieldEntry) =>
    fieldEntry.children.flatMap((valueId) => {
      const value = index.nodes.get(valueId);
      return value && !isInTrash(index, value.id) ? dateRangesFromValueNode(index, value) : [];
    })));
}

function nodeMatchesDateOperands(index: SearchIndex, node: SearchNode, dateOperands: SearchOperand[]): boolean {
  const ranges = dateOperands
    .map((operand) => operand.dateRange)
    .filter((range): range is DateRange => Boolean(range));
  return ranges.some((range) => nodeMatchesDateRange(index, node, range));
}

function nodeIsOverdue(index: SearchIndex, node: SearchNode, conditionNode: QueryBearingNode): boolean {
  if (node.completedAt) return false;
  const todayStart = startOfLocalDay(new Date()).getTime();
  return overdueDateRanges(index, node, conditionNode.queryFieldDefId)
    .some((range) => range.end <= todayStart);
}

function overdueDateRanges(index: SearchIndex, node: SearchNode, fieldDefId?: NodeId): DateRange[] {
  const entries = fieldEntryNodes(index, node).filter((fieldEntry) => {
    if (fieldDefId) return fieldEntry.fieldDefId === fieldDefId;
    return fieldTypeOf(index, fieldEntry.fieldDefId) === 'date';
  });
  return uniqueDateRanges(entries.flatMap((fieldEntry) =>
    fieldEntry.children.flatMap((valueId) => {
      const value = index.nodes.get(valueId);
      return value && !isInTrash(index, value.id) ? dateRangesFromValueNode(index, value) : [];
    })));
}

function conditionComparableValues(index: SearchIndex, conditionNode: QueryBearingNode, context: SearchContext): string[] {
  return uniqueStrings(conditionOperands(index, conditionNode, context).map((operand) => operand.normalizedText));
}

function conditionComparableScalar(index: SearchIndex, conditionNode: QueryBearingNode, context: SearchContext): number | null {
  const operand = conditionOperands(index, conditionNode, context)[0];
  if (!operand) return null;
  if (operand.scalar !== undefined) return operand.scalar;
  if (operand.dateRange) return operand.dateRange.start;
  return comparableScalar(operand.text, fieldTypeOf(index, conditionNode.queryFieldDefId));
}

function conditionTargetId(index: SearchIndex, conditionNode: QueryBearingNode, context: SearchContext): NodeId | undefined {
  for (const operand of conditionOperands(index, conditionNode, context)) {
    if (operand.nodeId) return operand.nodeId;
    if (index.nodes.has(operand.text)) return operand.text;
  }
  return undefined;
}

function conditionOperands(index: SearchIndex, conditionNode: QueryBearingNode, context: SearchContext): SearchOperand[] {
  const options: OperandResolutionOptions = {
    resolveRelativeDates: shouldResolveRelativeDates(index, conditionNode),
  };
  const childOperands = conditionNode.children.flatMap((childId) => {
    const child = index.nodes.get(childId);
    if (!child || child.type === 'queryCondition' || isInTrash(index, child.id)) return [];
    return operandsFromNode(index, child, context, options);
  });
  if (childOperands.length > 0) return uniqueOperands(childOperands);
  return uniqueOperands(operandsFromNode(index, conditionNode, context, options));
}

function shouldResolveRelativeDates(index: SearchIndex, conditionNode: QueryBearingNode): boolean {
  if (conditionNode.queryOp === 'FOR_RELATIVE_DATE') return true;
  if (!conditionNode.queryFieldDefId) return false;
  return fieldTypeOf(index, conditionNode.queryFieldDefId) === 'date';
}

function operandsFromNode(
  index: SearchIndex,
  node: SearchNode,
  context: SearchContext,
  options: OperandResolutionOptions,
): SearchOperand[] {
  const operands: SearchOperand[] = [];
  if (node.type === 'reference' && node.targetId) operands.push(...nodeOperand(index, node.targetId));
  if ((node.type === 'search' || node.type === 'queryCondition') && node.queryTargetId) {
    operands.push(...nodeOperand(index, node.queryTargetId));
  }
  for (const inlineRef of node.content.inlineRefs) {
    const nodeId = inlineRefNodeId(inlineRef);
    if (nodeId) operands.push(...nodeOperand(index, nodeId));
  }

  const text = node.content.text.trim();
  if (text) operands.push(...resolveOperandText(index, text, context, options));
  return operands;
}

function resolveOperandText(
  index: SearchIndex,
  text: string,
  context: SearchContext,
  options: OperandResolutionOptions,
): SearchOperand[] {
  const dynamicOperands = resolveAncestorOperand(index, text, context);
  if (dynamicOperands.length > 0) return dynamicOperands;

  if (options.resolveRelativeDates) {
    const relativeRange = relativeDateRange(text);
    if (relativeRange) return [operandFromDateRange(relativeRange)];
  }

  const operand = textOperand(text);
  return operand ? [operand] : [];
}

function resolveAncestorOperand(index: SearchIndex, text: string, context: SearchContext): SearchOperand[] {
  const parsed = parseAncestorOperand(text);
  if (!parsed) return [];
  const baseId = parsed.kind === 'PARENT'
    ? context.searchNode.parentId
    : context.searchNode.parentId ? index.nodes.get(context.searchNode.parentId)?.parentId : undefined;
  if (!baseId) return [];
  const base = index.nodes.get(baseId);
  if (!base) return [];

  if (!parsed.fieldName) return nodeOperand(index, base.id, parsed.offsetDays);

  const fieldName = parsed.fieldName;
  const fields = fieldReads(index, base)
    .filter((field) => normalizeComparableValue(field.name) === normalizeComparableValue(fieldName));
  return fields.flatMap((field) =>
    field.values.flatMap((value) => {
      const operand = textOperand(value, parsed.offsetDays);
      return operand ? [operand] : [];
    }));
}

function parseAncestorOperand(text: string): { kind: 'PARENT' | 'GRANDPARENT'; fieldName?: string; offsetDays: number } | null {
  const trimmed = text.trim();
  const offsetMatch = trimmed.match(/\s*([+-])\s*(\d+)\s*$/);
  const offsetDays = offsetMatch
    ? Number(offsetMatch[2]) * (offsetMatch[1] === '-' ? -1 : 1)
    : 0;
  const head = offsetMatch ? trimmed.slice(0, offsetMatch.index).trim() : trimmed;
  const match = head.match(/^(PARENT|GRANDPARENT)(?:\.(.+))?$/i);
  if (!match) return null;
  const fieldName = match[2]?.trim();
  return {
    kind: match[1]!.toUpperCase() as 'PARENT' | 'GRANDPARENT',
    fieldName: fieldName || undefined,
    offsetDays,
  };
}

function nodeOperand(index: SearchIndex, nodeId: NodeId, offsetDays = 0): SearchOperand[] {
  const node = index.nodes.get(nodeId);
  if (!node) return [];
  const calendarRange = calendarNodeRange(index, node);
  if (calendarRange) {
    const range = offsetDays === 0
      ? calendarRange.range
      : shiftDateRangeByUnit(calendarRange.range, offsetDays, calendarRange.unit);
    return [operandFromDateRange(range, offsetDays === 0 ? nodeId : undefined)];
  }
  const range = strictDateRange(node.content.text);
  if (range) {
    const shifted = offsetDays === 0 ? range : shiftDateRange(range, offsetDays);
    return [operandFromDateRange(shifted, offsetDays === 0 ? nodeId : undefined)];
  }
  const operand = textOperand(node.content.text || nodeId, offsetDays, offsetDays === 0 ? nodeId : undefined);
  return operand ? [operand] : [];
}

function textOperand(text: string, offsetDays = 0, nodeId?: NodeId): SearchOperand | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const range = strictDateRange(trimmed);
  if (offsetDays !== 0) {
    if (!range) return null;
    return operandFromDateRange(shiftDateRange(range, offsetDays), nodeId);
  }

  if (range) return operandFromDateRange(range, nodeId);

  const scalar = comparableScalar(trimmed);
  return {
    text: trimmed,
    normalizedText: normalizeComparableValue(trimmed),
    nodeId,
    scalar: scalar ?? undefined,
  };
}

function operandFromDateRange(range: DateRange, nodeId?: NodeId): SearchOperand {
  return {
    text: range.isoStart,
    normalizedText: range.isoStart,
    nodeId,
    scalar: range.start,
    dateRange: range,
  };
}

function valueMatchesOperand(value: string, operand: SearchOperand, fieldType?: string): boolean {
  if (fieldType === 'date') {
    return Boolean(operand.dateRange && textMatchesDateRange(value, operand.dateRange));
  }
  if (normalizeComparableValue(value) === operand.normalizedText) return true;
  if (operand.dateRange && textMatchesDateRange(value, operand.dateRange)) return true;
  if (operand.scalar !== undefined) {
    const scalar = comparableScalar(value, fieldType);
    return scalar !== null && scalar === operand.scalar;
  }
  return false;
}

function comparableScalar(value: string, fieldType?: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (fieldType === 'number') {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (fieldType === 'date') {
    const range = strictDateRange(trimmed);
    return range ? range.start : null;
  }
  const number = Number(trimmed);
  if (Number.isFinite(number)) return number;
  const range = strictDateRange(trimmed);
  if (range) return range.start;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? date : null;
}

function nodeMatchesDateRange(index: SearchIndex, node: SearchNode, range: DateRange): boolean {
  if (textMatchesDateRange(node.content.text, range)) return true;
  if (node.description && textMatchesDateRange(node.description, range)) return true;
  if (node.type === 'reference' && node.targetId && nodeIdMatchesDateRange(index, node.targetId, range)) return true;
  if (node.content.inlineRefs.some((ref) => {
    const nodeId = inlineRefNodeId(ref);
    return Boolean(nodeId && nodeIdMatchesDateRange(index, nodeId, range));
  })) return true;

  for (const fieldValue of fieldValueNodes(index, node)) {
    if (textMatchesDateRange(fieldValue.content.text, range)) return true;
    if (fieldValue.type === 'reference' && fieldValue.targetId && nodeIdMatchesDateRange(index, fieldValue.targetId, range)) return true;
    if (fieldValue.content.inlineRefs.some((ref) => {
      const nodeId = inlineRefNodeId(ref);
      return Boolean(nodeId && nodeIdMatchesDateRange(index, nodeId, range));
    })) return true;
  }

  return node.children.some((childId) => {
    const child = index.nodes.get(childId);
    return child?.type === 'reference'
      && Boolean(child.targetId)
      && !isInTrash(index, child.id)
      && nodeIdMatchesDateRange(index, child.targetId!, range);
  });
}

function nodeIdMatchesDateRange(index: SearchIndex, nodeId: NodeId, range: DateRange): boolean {
  const node = index.nodes.get(nodeId);
  return Boolean(node && textMatchesDateRange(node.content.text, range));
}

function dateRangesFromValueNode(index: SearchIndex, value: SearchNode): DateRange[] {
  const exactRange = strictDateRange(value.content.text);
  const ranges = exactRange ? [exactRange] : [...dateRangesInText(value.content.text)];
  if (value.type === 'reference' && value.targetId) {
    const range = nodeDateRange(index, value.targetId);
    if (range) ranges.push(range);
  }
  for (const inlineRef of value.content.inlineRefs) {
    const nodeId = inlineRefNodeId(inlineRef);
    const range = nodeId ? nodeDateRange(index, nodeId) : null;
    if (range) ranges.push(range);
  }
  return uniqueDateRanges(ranges);
}

function nodeDateRange(index: SearchIndex, nodeId: NodeId): DateRange | null {
  const node = index.nodes.get(nodeId);
  if (!node) return null;
  return calendarNodeRange(index, node)?.range ?? strictDateRange(node.content.text);
}

function textMatchesDateRange(text: string, range: DateRange): boolean {
  return dateRangesInText(text).some((candidateRange) => rangesOverlap(candidateRange, range));
}

function dateRangesInText(text: string): DateRange[] {
  return dateFieldValueRangesInText(text).map(dateRangeFromDateFieldValueRange);
}

function strictDateRange(text: string): DateRange | null {
  const range = parseDateFieldValueRange(text);
  return range ? dateRangeFromDateFieldValueRange(range) : null;
}

function dateRangeFromDateFieldValueRange(range: DateFieldValueRange): DateRange {
  return {
    start: range.startMs,
    end: range.endExclusiveMs,
    isoStart: range.start,
  };
}

function dateRangeFromParts(year: number, month: number, day: number): DateRange | null {
  const startDate = new Date(year, month - 1, day);
  if (
    startDate.getFullYear() !== year
    || startDate.getMonth() !== month - 1
    || startDate.getDate() !== day
  ) {
    return null;
  }
  const endDate = new Date(year, month - 1, day + 1);
  return {
    start: startDate.getTime(),
    end: endDate.getTime(),
    isoStart: isoLocalDate(startDate),
  };
}

function relativeDateRange(text: string): DateRange | null {
  const term = text
    .trim()
    .replace(/^(?:for[_\s-]*relative[_\s-]*date|relative[_\s-]*date)\s*:?\s*/i, '')
    .toLowerCase();
  const today = startOfLocalDay(new Date());

  if (term === 'today') return dateRangeFromDate(today, 1);
  if (term === 'yesterday') return dateRangeFromDate(addDays(today, -1), 1);
  if (term === 'tomorrow') return dateRangeFromDate(addDays(today, 1), 1);

  if (term === 'this week') return dateRangeFromDate(startOfLocalWeek(today), 7);
  if (term === 'last week') return dateRangeFromDate(addDays(startOfLocalWeek(today), -7), 7);
  if (term === 'next week') return dateRangeFromDate(addDays(startOfLocalWeek(today), 7), 7);

  if (term === 'this month') return monthRange(today.getFullYear(), today.getMonth());
  if (term === 'last month') return monthRange(today.getFullYear(), today.getMonth() - 1);
  if (term === 'next month') return monthRange(today.getFullYear(), today.getMonth() + 1);

  if (term === 'this year') return yearRange(today.getFullYear());
  if (term === 'last year') return yearRange(today.getFullYear() - 1);
  if (term === 'next year') return yearRange(today.getFullYear() + 1);

  return null;
}

function shiftDateRange(range: DateRange, days: number): DateRange {
  return dateRangeFromDate(addDays(new Date(range.start), days), Math.round((range.end - range.start) / 86_400_000));
}

function shiftDateRangeByUnit(range: DateRange, amount: number, unit: CalendarRangeUnit): DateRange {
  const start = new Date(range.start);
  if (unit === 'week') return dateRangeFromDate(addDays(start, amount * 7), 7);
  if (unit === 'year') return yearRange(start.getFullYear() + amount);
  return dateRangeFromDate(addDays(start, amount), 1);
}

function dateRangeFromDate(start: Date, days: number): DateRange {
  const normalizedStart = startOfLocalDay(start);
  const end = addDays(normalizedStart, Math.max(days, 1));
  return {
    start: normalizedStart.getTime(),
    end: end.getTime(),
    isoStart: isoLocalDate(normalizedStart),
  };
}

function monthRange(year: number, monthIndex: number): DateRange {
  const start = new Date(year, monthIndex, 1);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  return {
    start: start.getTime(),
    end: end.getTime(),
    isoStart: isoLocalDate(start),
  };
}

function yearRange(year: number): DateRange {
  const start = new Date(year, 0, 1);
  const end = new Date(year + 1, 0, 1);
  return {
    start: start.getTime(),
    end: end.getTime(),
    isoStart: isoLocalDate(start),
  };
}

function calendarNodeRange(index: SearchIndex, node: SearchNode): CalendarNodeRange | null {
  if (isDayNode(index, node.id)) {
    const range = strictDateRange(node.content.text);
    return range ? { range, unit: 'day' } : null;
  }

  if (isWeekNode(index, node.id)) {
    const week = Number(node.content.text.trim().replace(/^W/i, ''));
    const year = calendarNodeYear(index, node);
    if (!Number.isInteger(week) || week < 1 || week > 53 || year === null) return null;
    return { range: isoWeekRange(year, week), unit: 'week' };
  }

  if (isYearNode(index, node.id)) {
    const year = Number(node.content.text.trim());
    return Number.isInteger(year) && year >= 1 ? { range: yearRange(year), unit: 'year' } : null;
  }

  return null;
}

function calendarNodeYear(index: SearchIndex, node: SearchNode): number | null {
  const ownYear = Number(node.content.text.trim());
  if (isYearNode(index, node.id) && Number.isInteger(ownYear)) return ownYear;
  const parent = node.parentId ? index.nodes.get(node.parentId) : undefined;
  if (!parent) return null;
  const parentYear = Number(parent.content.text.trim());
  return isYearNode(index, parent.id) && Number.isInteger(parentYear) ? parentYear : null;
}

function isoWeekRange(year: number, week: number): DateRange {
  const weekOneStart = startOfLocalWeek(new Date(year, 0, 4));
  return dateRangeFromDate(addDays(weekOneStart, (week - 1) * 7), 7);
}

function rangesOverlap(left: DateRange, right: DateRange): boolean {
  return left.start < right.end && right.start < left.end;
}

function regexpFromCondition(conditionNode: QueryBearingNode): RegExp | null {
  const raw = conditionNode.content.text.trim();
  if (!raw) return null;
  try {
    const slashMatch = raw.match(/^\/(.+)\/([a-z]*)$/i);
    if (slashMatch) return new RegExp(slashMatch[1]!, slashMatch[2]);
    return new RegExp(raw, 'i');
  } catch {
    return null;
  }
}

function conditionDays(conditionNode: QueryBearingNode): number | null {
  const match = conditionNode.content.text.match(/\d+/);
  if (!match) return null;
  const days = Number(match[0]);
  return Number.isFinite(days) && days >= 0 ? days : null;
}

function isDescendantOf(index: SearchIndex, nodeId: NodeId, ancestorId: NodeId): boolean {
  let current = index.nodes.get(nodeId)?.parentId;
  const visited = new Set<NodeId>();
  while (current && !visited.has(current)) {
    if (current === ancestorId) return true;
    visited.add(current);
    current = index.nodes.get(current)?.parentId;
  }
  return false;
}

function scopedAncestorId(index: SearchIndex, searchNode: SearchNode, level: 'parent' | 'grandparent'): NodeId | undefined {
  const parentId = searchNode.parentId;
  if (level === 'parent') return parentId;
  return parentId ? index.nodes.get(parentId)?.parentId : undefined;
}

function findSiblingNamed(index: SearchIndex, searchNode: SearchNode, name: string): SearchNode | null {
  if (!searchNode.parentId) return null;
  const parent = index.nodes.get(searchNode.parentId);
  if (!parent) return null;
  const normalized = normalizeComparableValue(name);
  for (const childId of parent.children) {
    if (childId === searchNode.id) continue;
    const child = index.nodes.get(childId);
    if (!child || isInTrash(index, child.id)) continue;
    if (normalizeComparableValue(child.content.text) === normalized) return child;
  }
  return null;
}

function isDayNode(index: SearchIndex, nodeId: NodeId): boolean {
  const node = index.nodes.get(nodeId);
  if (!node) return false;
  return node.tags.some((tagId) =>
    tagId === TAG_DAY_ID || index.nodes.get(tagId)?.content.text.trim().toLowerCase() === 'day');
}

function isWeekNode(index: SearchIndex, nodeId: NodeId): boolean {
  const node = index.nodes.get(nodeId);
  if (!node) return false;
  return node.tags.some((tagId) =>
    tagId === TAG_WEEK_ID || index.nodes.get(tagId)?.content.text.trim().toLowerCase() === 'week');
}

function isYearNode(index: SearchIndex, nodeId: NodeId): boolean {
  const node = index.nodes.get(nodeId);
  if (!node) return false;
  return node.tags.some((tagId) =>
    tagId === TAG_YEAR_ID || index.nodes.get(tagId)?.content.text.trim().toLowerCase() === 'year');
}

function isCalendarNode(index: SearchIndex, nodeId: NodeId): boolean {
  return isDayNode(index, nodeId) || isWeekNode(index, nodeId) || isYearNode(index, nodeId);
}

function nodeMatchesType(index: SearchIndex, node: SearchNode, expectedType: string): boolean {
  const expected = normalizeComparableValue(expectedType).replace(/[\s_-]+/g, '');
  const actual = normalizeComparableValue(node.type ?? 'node').replace(/[\s_-]+/g, '');
  if (expected === actual) return true;
  if (['node', 'plain', 'textnode'].includes(expected)) return node.type === undefined;
  if (['tag', 'tagdef', 'supertag'].includes(expected)) return node.type === 'tagDef';
  if (['field', 'fielddef'].includes(expected)) return node.type === 'fieldDef';
  if (['search', 'searchnode', 'livesearch'].includes(expected)) return node.type === 'search';
  if (['calendar', 'calendarnode'].includes(expected)) return isCalendarNode(index, node.id);
  if (expected === 'day') return isDayNode(index, node.id);
  if (expected === 'week') return isWeekNode(index, node.id);
  if (expected === 'year') return isYearNode(index, node.id);
  if (expected === 'image') return node.type === 'image';
  if (expected === 'embed') return node.type === 'embed';
  if (['code', 'codeblock'].includes(expected)) return node.type === 'codeBlock';
  return false;
}

function normalizeComparableValue(value: string): string {
  return value.trim().toLowerCase();
}

function fieldReads(index: SearchIndex, node: SearchNode): Array<{ name: string; fieldDefId?: NodeId; values: string[] }> {
  return fieldEntryNodes(index, node)
    .map((fieldEntry) => {
      const fieldDef = fieldEntry.fieldDefId ? index.nodes.get(fieldEntry.fieldDefId) : undefined;
      return {
        name: fieldDef?.content.text || fieldEntry.content.text || 'Field',
        fieldDefId: fieldEntry.fieldDefId,
        values: fieldEntry.children
          .map((valueId) => index.nodes.get(valueId))
          .filter((value): value is SearchNode => value !== undefined && !isInTrash(index, value.id))
          .map((value) => fieldValueText(index, value)),
      };
    });
}

function fieldValueNodes(index: SearchIndex, node: SearchNode): SearchNode[] {
  return fieldEntryNodes(index, node)
    .flatMap((fieldEntry) =>
      fieldEntry.children
        .map((valueId) => index.nodes.get(valueId))
        .filter((value): value is SearchNode => value !== undefined && !isInTrash(index, value.id)));
}

function fieldEntryNodes(index: SearchIndex, node: SearchNode): Extract<SearchNode, { type: 'fieldEntry' }>[] {
  if (node.type === 'tagDef' || node.type === 'fieldDef' || node.type === 'search') return [];
  return node.children
    .map((childId) => index.nodes.get(childId))
    .filter((child): child is Extract<SearchNode, { type: 'fieldEntry' }> => child?.type === 'fieldEntry' && !isInTrash(index, child.id));
}

function fieldValueText(index: SearchIndex, value: SearchNode): string {
  if (value.type === 'reference' && value.targetId) {
    return index.nodes.get(value.targetId)?.content.text ?? value.targetId;
  }
  return value.content.text;
}

function tagNames(index: SearchIndex, node: SearchNode): string[] {
  return node.tags
    .map((tagId) => index.nodes.get(tagId)?.content.text.trim())
    .filter((name): name is string => Boolean(name));
}

function collectQueryExprTerms(query: SearchQueryExpr | null | undefined, terms: string[]) {
  if (!query) return;
  if (query.kind === 'group') {
    for (const child of query.children) collectQueryExprTerms(child, terms);
    return;
  }
  if (query.op === 'STRING_MATCH') {
    if (query.text?.trim()) terms.push(query.text.trim());
    for (const operand of query.operands ?? []) {
      if (operand.text?.trim()) terms.push(operand.text.trim());
    }
  }
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

function uniqueOperands(operands: SearchOperand[]): SearchOperand[] {
  const result: SearchOperand[] = [];
  const seen = new Set<string>();
  for (const operand of operands) {
    const key = [
      operand.nodeId ?? '',
      operand.normalizedText,
      operand.scalar ?? '',
      operand.dateRange?.start ?? '',
      operand.dateRange?.end ?? '',
    ].join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(operand);
  }
  return result;
}

function uniqueQueryOperands(operands: SearchQueryOperand[]): SearchQueryOperand[] {
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

function uniqueDateRanges(ranges: DateRange[]): DateRange[] {
  const result: DateRange[] = [];
  const seen = new Set<string>();
  for (const range of ranges) {
    const key = `${range.start}:${range.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(range);
  }
  return result;
}

function isSearchCandidate(index: SearchIndex, nodeId: NodeId): boolean {
  const node = index.nodes.get(nodeId);
  if (!node) return false;
  return !isInTrash(index, nodeId)
    && !hasAncestorOfType(index, nodeId, 'queryCondition')
    && !SYSTEM_IDS.has(nodeId)
    && (node.type === undefined || ['tagDef', 'fieldDef', 'search', 'codeBlock', 'image', 'embed'].includes(node.type));
}

/** The image node's url, narrowed — only image nodes carry one. */
function nodeMediaUrl(node: SearchNode): string | undefined {
  return node.type === 'image' ? node.mediaUrl : undefined;
}

/** The embed node's fields, narrowed — only embed nodes carry them. */
function nodeEmbedFields(node: SearchNode): { embedType?: string; embedId?: string; sourceUrl?: string } {
  return node.type === 'embed' ? node : {};
}

function nodeHasMediaKind(node: SearchNode, op: Extract<QueryOp, 'HAS_MEDIA' | 'HAS_AUDIO' | 'HAS_VIDEO' | 'HAS_IMAGE'>): boolean {
  if (op === 'HAS_MEDIA') {
    const embed = nodeEmbedFields(node);
    return node.type === 'image'
      || node.type === 'embed'
      || Boolean(nodeMediaUrl(node) || embed.embedType || embed.embedId || embed.sourceUrl);
  }
  if (op === 'HAS_IMAGE') {
    return node.type === 'image'
      || mediaKindFromNode(node) === 'image';
  }
  if (op === 'HAS_AUDIO') return mediaKindFromNode(node) === 'audio';
  return mediaKindFromNode(node) === 'video';
}

function mediaKindFromNode(node: SearchNode): 'image' | 'audio' | 'video' | 'embed' | null {
  const embed = nodeEmbedFields(node);
  const embedType = embed.embedType?.trim().toLowerCase();
  if (embedType === 'image' || embedType === 'audio' || embedType === 'video') return embedType;
  const url = nodeMediaUrl(node) || embed.sourceUrl || '';
  const ext = url.split(/[?#]/)[0]?.split('.').pop()?.toLowerCase();
  if (!ext) return node.type === 'embed' ? 'embed' : null;
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga'].includes(ext)) return 'audio';
  if (['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv'].includes(ext)) return 'video';
  return node.type === 'embed' ? 'embed' : null;
}

function hasAncestorOfType(index: SearchIndex, nodeId: NodeId, type: SearchNode['type']): boolean {
  let current = index.nodes.get(nodeId)?.parentId;
  const visited = new Set<NodeId>();
  while (current && !visited.has(current)) {
    const node = index.nodes.get(current);
    if (node?.type === type) return true;
    visited.add(current);
    current = node?.parentId;
  }
  return false;
}

function isInTrash(index: SearchIndex, nodeId: NodeId): boolean {
  return nodeIsInSubtree(index.nodes, nodeId, TRASH_ID);
}
