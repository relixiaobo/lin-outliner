import {
  buildTextSearchIndex,
  runSearchNode,
  runTransientSearchExpr,
  type SearchAssetMetadata,
} from '../../core/searchEngine';
import type { TextSearchIndex } from '../../core/textSearchIndex';
import {
  DAILY_NOTES_ID,
  LIBRARY_ID,
  SCHEMA_ID,
  TAG_DAY_ID,
  TRASH_ID,
  isContentBearingNode,
  type DocumentProjection,
  type NodeProjection,
  type SearchQueryExpr,
} from '../../core/types';
import { OutlineContractError, outlineError } from '../contract/errors';
import type { QueryExpression, Selector, TargetSpec } from '../contract/schemas';

export interface OutlineSelectionIndex {
  readonly projection: DocumentProjection;
  readonly byId: ReadonlyMap<string, NodeProjection>;
  readonly documentOrder: readonly string[];
  readonly documentPosition: ReadonlyMap<string, number>;
  readonly textIndex: () => TextSearchIndex;
  readonly assetMetadataById?: ReadonlyMap<string, SearchAssetMetadata>;
}

export interface OutlineSelectionIndexOptions {
  readonly nodesById?: ReadonlyMap<string, NodeProjection>;
  readonly textIndex?: TextSearchIndex;
  readonly assetMetadataById?: ReadonlyMap<string, SearchAssetMetadata>;
}

export function createSelectionIndex(
  projection: DocumentProjection,
  options: OutlineSelectionIndexOptions = {},
): OutlineSelectionIndex {
  const byId = options.nodesById ?? new Map(projection.nodes.map((node) => [node.id, node]));
  let documentOrder: readonly string[] | undefined;
  let documentPosition: ReadonlyMap<string, number> | undefined;
  const ensureDocumentOrder = () => {
    if (documentOrder && documentPosition) return;
    const ordered: string[] = [];
    const visited = new Set<string>();
    const stack = [projection.rootId];
    while (stack.length > 0) {
      const nodeId = stack.pop()!;
      if (visited.has(nodeId) || !byId.has(nodeId)) continue;
      visited.add(nodeId);
      ordered.push(nodeId);
      const children = byId.get(nodeId)?.children ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
    }
    for (const nodeId of [...byId.keys()].sort(compareText)) {
      if (!visited.has(nodeId)) ordered.push(nodeId);
    }
    documentOrder = ordered;
    documentPosition = new Map(ordered.map((nodeId, index) => [nodeId, index]));
  };
  let textIndex: TextSearchIndex | undefined;
  return {
    projection,
    byId,
    get documentOrder() {
      ensureDocumentOrder();
      return documentOrder!;
    },
    get documentPosition() {
      ensureDocumentOrder();
      return documentPosition!;
    },
    textIndex: () => {
      textIndex ??= options.textIndex ?? buildTextSearchIndex(projection);
      return textIndex;
    },
    assetMetadataById: options.assetMetadataById,
  };
}

export function resolveSelector(index: OutlineSelectionIndex, selector: Selector): readonly string[] {
  if (selector.by === 'id') {
    const node = index.byId.get(selector.id);
    return node ? [node.id] : [];
  }
  if (selector.by === 'ids') {
    const missingIds = selector.ids.filter((nodeId) => !index.byId.has(nodeId));
    if (missingIds.length > 0) {
      throw new OutlineContractError(outlineError(
        'not_found',
        'selection',
        'One or more exact Node IDs do not exist.',
        { details: { missingIds: missingIds.slice(0, 100), missingCount: missingIds.length } },
      ));
    }
    return selector.ids;
  }
  if (selector.by === 'alias') {
    const nodeId = aliasNodeId(index.projection, selector.alias);
    return index.byId.has(nodeId) ? [nodeId] : [];
  }
  if (selector.by === 'date') {
    const node = index.projection.nodes.find((candidate) => (
      isContentBearingNode(candidate)
      && candidate.content.text === selector.date
      && candidate.tags.includes(TAG_DAY_ID)
      && isDescendantOf(index, candidate.id, DAILY_NOTES_ID)
    ));
    return node ? [node.id] : [];
  }
  if (selector.by === 'search') {
    return savedSearchMatches(index, selector.id, selector.limit);
  }

  return queryMatches(index, selector.query, {
    ...(selector.within ? { within: selector.within } : {}),
    includeTrash: selector.includeTrash === true,
    order: selector.order ?? 'document',
    limit: selector.limit,
  });
}

export function countQueryMatches(
  index: OutlineSelectionIndex,
  query: QueryExpression,
  options: { readonly within?: Selector; readonly includeTrash?: boolean } = {},
): number {
  return queryMatches(index, query, options).length;
}

export function countSavedSearchMatches(index: OutlineSelectionIndex, searchNodeId: string): number {
  return savedSearchMatches(index, searchNodeId).length;
}

function queryMatches(
  index: OutlineSelectionIndex,
  query: QueryExpression,
  options: {
    readonly within?: Selector;
    readonly includeTrash?: boolean;
    readonly order?: 'document' | 'created' | 'updated' | 'text';
    readonly limit?: number;
  },
): readonly string[] {
  const result = runTransientSearchExpr(index.projection, query as SearchQueryExpr, {
    ...(options.includeTrash ? { includeTrash: true } : { textIndex: index.textIndex() }),
    assetMetadataById: index.assetMetadataById,
  });
  if (!result.ok) throw searchSelectionError(result.issue);
  const withinIds = options.within
    ? new Set(resolveSelector(index, options.within))
    : undefined;
  const candidates = result.hits
    .map((hit) => index.byId.get(hit.nodeId))
    .filter((node): node is NodeProjection => Boolean(node))
    .filter((node) => options.includeTrash === true || !isInTrash(index, node.id))
    .filter((node) => !withinIds || [...withinIds].some((rootId) => (
      node.id === rootId || isDescendantOf(index, node.id, rootId)
    )));
  candidates.sort((left, right) => compareSelectedNodes(index, left, right, options.order ?? 'document'));
  const bounded = options.limit === undefined ? candidates : candidates.slice(0, options.limit);
  return bounded.map((node) => node.id);
}

function savedSearchMatches(
  index: OutlineSelectionIndex,
  searchNodeId: string,
  limit?: number,
): readonly string[] {
  if (index.byId.get(searchNodeId)?.type !== 'search') {
    throw new OutlineContractError(outlineError(
      'invalid_input',
      'selection',
      `Saved Search selector requires a Search Node: ${searchNodeId}`,
    ));
  }
  const result = runSearchNode(index.projection, searchNodeId, {
    textIndex: index.textIndex(),
    assetMetadataById: index.assetMetadataById,
    ...(limit !== undefined ? { limit } : {}),
  });
  if (!result.ok) throw searchSelectionError(result.issue);
  return result.hits.map((hit) => hit.nodeId).filter((nodeId) => index.byId.has(nodeId));
}

function searchSelectionError(issue: { readonly message: string }): OutlineContractError {
  return new OutlineContractError(outlineError(
    'invalid_input',
    'selection',
    issue.message,
    { details: issue },
  ));
}

export function resolveTargetSpec(index: OutlineSelectionIndex, target: TargetSpec): readonly string[] {
  const ids = resolveSelector(index, target.selector);
  if (target.cardinality === 'one') {
    if (ids.length === 0) throw selectionError('not_found', 'Selector did not resolve to a Node.', target);
    if (ids.length !== 1) throw selectionError('ambiguous_selector', 'Selector resolved to more than one Node.', target, ids);
  }
  if (target.cardinality === 'zero-or-one' && ids.length > 1) {
    throw selectionError('ambiguous_selector', 'Selector resolved to more than one Node.', target, ids);
  }
  if (target.cardinality === 'many') {
    if (target.max === undefined) {
      throw selectionError('cardinality_mismatch', 'A many target requires an explicit maximum.', target);
    }
    if (ids.length > target.max) {
      throw selectionError('cardinality_mismatch', 'Selector resolved beyond its declared maximum.', target, ids);
    }
  }
  return ids;
}

export function isInTrash(index: OutlineSelectionIndex, nodeId: string): boolean {
  return nodeId === TRASH_ID || isDescendantOf(index, nodeId, TRASH_ID);
}

export function isDescendantOf(index: OutlineSelectionIndex, nodeId: string, rootId: string): boolean {
  let current = index.byId.get(nodeId);
  const visited = new Set<string>();
  while (current?.parentId && !visited.has(current.id)) {
    if (current.parentId === rootId) return true;
    visited.add(current.id);
    current = index.byId.get(current.parentId);
  }
  return false;
}

function aliasNodeId(projection: DocumentProjection, alias: Extract<Selector, { by: 'alias' }>['alias']): string {
  switch (alias) {
    case 'home': return projection.rootId;
    case 'inbox': return LIBRARY_ID;
    case 'library': return LIBRARY_ID;
    case 'schema': return SCHEMA_ID;
    case 'trash': return TRASH_ID;
    case 'daily-notes': return DAILY_NOTES_ID;
    case 'saved-searches': return projection.searchesId;
    case 'today': return projection.todayId;
  }
}

function compareSelectedNodes(
  index: OutlineSelectionIndex,
  left: NodeProjection,
  right: NodeProjection,
  order: 'document' | 'created' | 'updated' | 'text',
): number {
  if (order === 'document') {
    const difference = (index.documentPosition.get(left.id) ?? Number.MAX_SAFE_INTEGER)
      - (index.documentPosition.get(right.id) ?? Number.MAX_SAFE_INTEGER);
    if (difference !== 0) return difference;
  } else if (order === 'created') {
    const difference = left.createdAt - right.createdAt;
    if (difference !== 0) return difference;
  } else if (order === 'updated') {
    const difference = left.updatedAt - right.updatedAt;
    if (difference !== 0) return difference;
  } else {
    const leftText = isContentBearingNode(left) ? left.content.text : left.sourceText;
    const rightText = isContentBearingNode(right) ? right.content.text : right.sourceText;
    const difference = compareText(leftText, rightText);
    if (difference !== 0) return difference;
  }
  return compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function selectionError(
  code: 'not_found' | 'ambiguous_selector' | 'cardinality_mismatch',
  message: string,
  target: TargetSpec,
  ids: readonly string[] = [],
): OutlineContractError {
  return new OutlineContractError(outlineError(code, 'selection', message, {
    details: { target, candidateIds: [...ids].slice(0, 100), candidateCount: ids.length },
  }));
}
