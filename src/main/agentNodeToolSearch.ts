import type { NodeProjection, SearchNodeCondition, SearchNodeConfig } from '../core/types';
import { parseLinOutline, type OutlineDocument, type OutlineField, type OutlineNode } from './agentOutlineParser';
import {
  checkedState,
  fieldDefinitionName,
  fieldReads,
  isInTrash,
  isSearchCandidate,
  nodeKind,
  nodeTitle,
  normalChildIds,
  parentRef,
  resolveFieldSearchConditions,
  resolveTagNames,
  scoreTerm,
  snippetFor,
  tagLabel,
  tagLabels,
} from './agentNodeToolProjection';
import type {
  NodeSearchItem,
  NodeToolIssue,
  NormalizedSearchParams,
  ParsedFieldSearchCondition,
  ParsedSearch,
  ProjectionIndex,
  ResolvedFieldSearchCondition,
  ResolvedSearchSpec,
} from './agentNodeToolTypes';
import { asRecord, clampInteger, unique } from './agentNodeToolUtils';

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

export function resolveSearchSpecFromOutlineNode(index: ProjectionIndex, node: OutlineNode): ResolvedSearchSpec {
  const parsed = parsedSearchFromOutlineNode(node);
  const resolvedTags = resolveTagNames(index, parsed.tagNames);
  const resolvedFields = resolveFieldSearchConditions(index, parsed.fieldConditions);
  return {
    title: parsed.title ?? 'Search',
    view: parsed.view,
    queryTerms: parsed.queryTerms,
    tagIds: resolvedTags.tagIds,
    linkTargetIds: parsed.linkTargetIds,
    fieldConditions: resolvedFields.fieldConditions,
    unresolvedTagNames: resolvedTags.unresolvedTagNames,
    unresolvedFields: resolvedFields.unresolvedFields,
    warnings: [],
  };
}

export function parsedSearchFromOutlineNode(node: OutlineNode): ParsedSearch {
  const queryTerms: string[] = [];
  const tagNames: string[] = [];
  const linkTargetIds: string[] = [];
  const fieldConditions: ParsedFieldSearchCondition[] = [];

  for (const field of node.fields) {
    fieldConditions.push(...fieldSearchConditionsFromOutlineField(field));
  }

  for (const child of node.children) {
    tagNames.push(...child.tags);
    if (child.referenceTargetId) {
      linkTargetIds.push(child.referenceTargetId);
    } else if (child.title.trim() && child.title !== '(untitled)') {
      queryTerms.push(child.title.trim());
    }
    for (const field of child.fields) {
      fieldConditions.push(...fieldSearchConditionsFromOutlineField(field));
    }
  }

  if (queryTerms.length === 0 && tagNames.length === 0 && linkTargetIds.length === 0 && fieldConditions.length === 0 && node.title.trim()) {
    queryTerms.push(node.title.trim());
  }

  return {
    title: node.title.trim() || undefined,
    view: node.view,
    queryTerms: unique(queryTerms.filter(Boolean)),
    tagNames: unique(tagNames),
    linkTargetIds: unique(linkTargetIds),
    fieldConditions: uniqueParsedFieldConditions(fieldConditions),
  };
}

export function searchNodeConfigFromSpec(spec: ResolvedSearchSpec): SearchNodeConfig {
  return {
    title: spec.title,
    viewMode: spec.view,
    conditions: [
      ...spec.queryTerms.map((text): SearchNodeCondition => ({ op: 'STRING_MATCH', text })),
      ...spec.tagIds.map((tagId): SearchNodeCondition => ({ op: 'HAS_TAG', tagId })),
      ...spec.linkTargetIds.map((targetId): SearchNodeCondition => ({ op: 'LINKS_TO', targetId })),
      ...spec.fieldConditions.map((field): SearchNodeCondition => ({
        op: 'FIELD_CONTAINS',
        fieldDefId: field.fieldDefId,
        text: field.text,
      })),
    ],
  };
}

export function searchSpecFromSavedSearch(index: ProjectionIndex, node: NodeProjection): ResolvedSearchSpec {
  const queryTerms: string[] = [];
  const tagIds: string[] = [];
  const linkTargetIds: string[] = [];
  const fieldConditions: ResolvedFieldSearchCondition[] = [];
  const conditionNodes = node.children
    .map((childId) => index.nodes.get(childId))
    .filter((child): child is NodeProjection => child?.type === 'queryCondition' && !isInTrash(index, child.id));

  for (const condition of conditionNodes) {
    if (condition.queryOp === 'HAS_TAG' && condition.queryTagDefId) tagIds.push(condition.queryTagDefId);
    else if (condition.queryOp === 'LINKS_TO' && condition.targetId) linkTargetIds.push(condition.targetId);
    else if (condition.queryOp === 'FIELD_CONTAINS' && condition.queryFieldDefId) {
      fieldConditions.push({
        fieldDefId: condition.queryFieldDefId,
        fieldName: fieldDefinitionName(index, condition.queryFieldDefId),
        text: condition.content.text.trim() || undefined,
      });
    }
    else if (condition.queryOp === 'STRING_MATCH' && condition.content.text.trim()) queryTerms.push(condition.content.text.trim());
  }

  if (conditionNodes.length === 0) {
    if (node.queryOp === 'HAS_TAG' && node.queryTagDefId) tagIds.push(node.queryTagDefId);
    else if (node.queryOp === 'LINKS_TO' && node.targetId) linkTargetIds.push(node.targetId);
    else if (node.queryOp === 'FIELD_CONTAINS' && node.queryFieldDefId) {
      fieldConditions.push({
        fieldDefId: node.queryFieldDefId,
        fieldName: fieldDefinitionName(index, node.queryFieldDefId),
      });
    }
    else if (node.queryOp === 'STRING_MATCH' && node.content.text.trim()) queryTerms.push(node.content.text.trim());
    else if (node.content.text.trim()) queryTerms.push(node.content.text.trim());
  }

  return {
    title: node.content.text.trim() || 'Search',
    view: node.viewMode,
    queryTerms: unique(queryTerms),
    tagIds: unique(tagIds),
    linkTargetIds: unique(linkTargetIds),
    fieldConditions: uniqueFieldConditions(fieldConditions),
    unresolvedTagNames: [],
    unresolvedFields: [],
    warnings: [],
  };
}

export function resolveSearch(index: ProjectionIndex, params: NormalizedSearchParams): {
  source: 'temporary' | 'saved';
  title?: string;
  view?: string;
  searchNodeId?: string;
  outline?: string;
  queryTerms: string[];
  tagIds: string[];
  linkTargetIds: string[];
  fieldConditions: ResolvedFieldSearchCondition[];
  unresolvedTagNames: string[];
  unresolvedFields: string[];
  warnings: string[];
} | NodeToolIssue {
  if (params.outline) {
    const parsed = parseSearchOutline(params.outline);
    if ('error' in parsed) return parsed;
    const referenceValidation = validateReferenceTargetIds(index, parsed.linkTargetIds);
    if (referenceValidation) return referenceValidation;
    const resolvedTags = resolveTagNames(index, parsed.tagNames);
    const resolvedFields = resolveFieldSearchConditions(index, parsed.fieldConditions);
    if (resolvedTags.unresolvedTagNames.length) {
      return {
        code: 'unresolved_tag',
        error: `Search references unknown tags: ${resolvedTags.unresolvedTagNames.join(', ')}`,
        instructions: 'Use a plain text search outline first, or create/apply the tag before filtering by it.',
      };
    }
    if (resolvedFields.unresolvedFields.length) {
      return {
        code: 'unresolved_field',
        error: `Search references unknown fields: ${resolvedFields.unresolvedFields.join(', ')}`,
        instructions: 'Use node_read on a tagged node to inspect available field names before filtering by field.',
      };
    }
    return {
      source: 'temporary',
      title: parsed.title,
      view: parsed.view,
      outline: params.outline,
      queryTerms: parsed.queryTerms,
      tagIds: resolvedTags.tagIds,
      linkTargetIds: parsed.linkTargetIds,
      fieldConditions: resolvedFields.fieldConditions,
      unresolvedTagNames: [],
      unresolvedFields: [],
      warnings: [],
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
  const referenceValidation = validateReferenceTargetIds(index, spec.linkTargetIds);
  if (referenceValidation) return referenceValidation;
  return {
    source: 'saved',
    title: spec.title,
    view: spec.view,
    searchNodeId,
    queryTerms: spec.queryTerms,
    tagIds: spec.tagIds,
    linkTargetIds: spec.linkTargetIds,
    fieldConditions: spec.fieldConditions,
    unresolvedTagNames: spec.unresolvedTagNames,
    unresolvedFields: spec.unresolvedFields,
    warnings: spec.warnings,
  };
}

export function runSearch(index: ProjectionIndex, search: {
  queryTerms: string[];
  tagIds: string[];
  linkTargetIds: string[];
  fieldConditions: ResolvedFieldSearchCondition[];
}): string[] {
  const scored: Array<{ nodeId: string; score: number }> = [];
  for (const node of index.projection.nodes) {
    if (!isSearchCandidate(index, node.id)) continue;
    if (!search.tagIds.every((tagId) => node.tags.includes(tagId))) continue;
    if (!search.linkTargetIds.every((targetId) => nodeLinksTo(index, node, targetId))) continue;
    if (!search.fieldConditions.every((condition) => nodeMatchesFieldCondition(index, node, condition))) continue;
    let score = search.tagIds.length * 25 + search.linkTargetIds.length * 20 + search.fieldConditions.length * 18;
    let matched = true;
    for (const term of search.queryTerms) {
      const termScore = scoreTerm(index, node, term);
      if (termScore <= 0) {
        matched = false;
        break;
      }
      score += termScore;
    }
    if (matched) scored.push({ nodeId: node.id, score });
  }
  return scored.sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId)).map((hit) => hit.nodeId);
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

function validateSearchNode(index: ProjectionIndex, node: OutlineNode): NodeToolIssue | null {
  if (node.search) {
    const spec = resolveSearchSpecFromOutlineNode(index, node);
    if (spec.unresolvedTagNames.length) {
      return {
        code: 'unresolved_tag',
        error: `Search references unknown tags: ${spec.unresolvedTagNames.join(', ')}`,
        instructions: 'Create/apply the tag first, or remove the tag condition from the search node outline.',
      };
    }
    if (spec.unresolvedFields.length) {
      return {
        code: 'unresolved_field',
        error: `Search references unknown fields: ${spec.unresolvedFields.join(', ')}`,
        instructions: 'Create the field definition first, or remove the field condition from the search node outline.',
      };
    }
  }
  for (const child of node.children) {
    const validation = validateSearchNode(index, child);
    if (validation) return validation;
  }
  return null;
}

function nodeLinksTo(index: ProjectionIndex, node: NodeProjection, targetId: string): boolean {
  if (node.type === 'reference' && node.targetId === targetId) return true;
  if (node.content.inlineRefs.some((ref) => ref.targetNodeId === targetId)) return true;
  return node.children.some((childId) => {
    const child = index.nodes.get(childId);
    return child?.type === 'reference' && child.targetId === targetId;
  });
}

function nodeMatchesFieldCondition(index: ProjectionIndex, node: NodeProjection, condition: ResolvedFieldSearchCondition): boolean {
  const fields = fieldReads(index, node, false).filter((field) => {
    const fieldEntry = index.nodes.get(field.fieldEntryId);
    return fieldEntry?.fieldDefId === condition.fieldDefId;
  });
  if (fields.length === 0) return false;
  const text = condition.text?.trim().toLowerCase();
  if (!text) return true;
  return fields.some((field) => field.values.some((value) => value.text.toLowerCase().includes(text)));
}

function parseSearchOutline(outline: string): ParsedSearch | NodeToolIssue {
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
      instructions: 'Wrap all search conditions under one "- %%search%% Title" root.',
    };
  }
  return parsedSearchFromOutlineNode(parsed.document.roots[0]!);
}

function fieldSearchConditionsFromOutlineField(field: OutlineField): ParsedFieldSearchCondition[] {
  const fieldName = field.name.trim();
  if (!fieldName) return [];
  if (field.values.length === 0) return [{ fieldName }];
  return field.values.map((value) => ({
    fieldName,
    text: value.text.trim() || undefined,
  }));
}

function uniqueParsedFieldConditions(conditions: ParsedFieldSearchCondition[]): ParsedFieldSearchCondition[] {
  const result: ParsedFieldSearchCondition[] = [];
  const seen = new Set<string>();
  for (const condition of conditions) {
    const fieldName = condition.fieldName.trim();
    if (!fieldName) continue;
    const text = condition.text?.trim() || undefined;
    const key = `${fieldName.toLowerCase()}:${(text ?? '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ fieldName, text });
  }
  return result;
}

function uniqueFieldConditions(conditions: ResolvedFieldSearchCondition[]): ResolvedFieldSearchCondition[] {
  const result: ResolvedFieldSearchCondition[] = [];
  const seen = new Set<string>();
  for (const condition of conditions) {
    const text = condition.text?.trim() || undefined;
    const key = `${condition.fieldDefId}:${(text ?? '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...condition, text });
  }
  return result;
}

function requiredSearchNode(index: ProjectionIndex, nodeId: string): NodeProjection {
  const node = index.nodes.get(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  return node;
}

export function searchConditionOutlineLines(index: ProjectionIndex, node: NodeProjection, level: number): string[] {
  const indent = '  '.repeat(level);
  const spec = searchSpecFromSavedSearch(index, node);
  return [
    ...spec.queryTerms.map((term) => `${indent}- ${term}`),
    ...spec.tagIds.map((tagId) => {
      const tag = tagLabel(index.nodes.get(tagId)) ?? `#${tagId}`;
      return `${indent}- ${tag}`;
    }),
    ...spec.linkTargetIds.map((targetId) => {
      const target = index.nodes.get(targetId);
      return `${indent}- [[${target ? nodeTitle(index, target) : targetId}^${targetId}]]`;
    }),
    ...spec.fieldConditions.map((field) => `${indent}- ${field.fieldName}:: ${field.text ?? ''}`.trimEnd()),
  ];
}
