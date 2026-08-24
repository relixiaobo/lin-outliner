import { runTransientSearchExpr } from '../../core/searchEngine';
import {
  DAILY_NOTES_ID,
  LIBRARY_ID,
  SCHEMA_ID,
  TAG_DAY_ID,
  TRASH_ID,
  type DocumentProjection,
  type NodeProjection,
  type SearchQueryExpr,
} from '../../core/types';
import { OutlineContractError, outlineError } from '../contract/errors';
import type { Selector, TargetSpec } from '../contract/schemas';

export interface OutlineSelectionIndex {
  readonly projection: DocumentProjection;
  readonly byId: ReadonlyMap<string, NodeProjection>;
  readonly documentOrder: readonly string[];
  readonly documentPosition: ReadonlyMap<string, number>;
}

export function createSelectionIndex(projection: DocumentProjection): OutlineSelectionIndex {
  const byId = new Map(projection.nodes.map((node) => [node.id, node]));
  const documentOrder: string[] = [];
  const visited = new Set<string>();
  const stack = [projection.rootId];
  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    if (visited.has(nodeId) || !byId.has(nodeId)) continue;
    visited.add(nodeId);
    documentOrder.push(nodeId);
    const children = byId.get(nodeId)?.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
  }
  for (const nodeId of [...byId.keys()].sort(compareText)) {
    if (!visited.has(nodeId)) documentOrder.push(nodeId);
  }
  return {
    projection,
    byId,
    documentOrder,
    documentPosition: new Map(documentOrder.map((nodeId, index) => [nodeId, index])),
  };
}

export function resolveSelector(index: OutlineSelectionIndex, selector: Selector): readonly string[] {
  if (selector.by === 'id') {
    const node = index.byId.get(selector.id);
    return node ? [node.id] : [];
  }
  if (selector.by === 'alias') {
    const nodeId = aliasNodeId(index.projection, selector.alias);
    return index.byId.has(nodeId) ? [nodeId] : [];
  }
  if (selector.by === 'date') {
    const node = index.projection.nodes.find((candidate) => (
      candidate.content.text === selector.date
      && candidate.tags.includes(TAG_DAY_ID)
      && isDescendantOf(index, candidate.id, DAILY_NOTES_ID)
    ));
    return node ? [node.id] : [];
  }

  const result = runTransientSearchExpr(
    index.projection,
    selector.query as SearchQueryExpr,
    { limit: selector.limit },
  );
  if (!result.ok) {
    throw new OutlineContractError(outlineError(
      'invalid_input',
      'selection',
      result.issue.message,
      { details: result.issue },
    ));
  }
  const withinIds = selector.within
    ? new Set(resolveSelector(index, selector.within))
    : undefined;
  const candidates = result.hits
    .map((hit) => index.byId.get(hit.nodeId))
    .filter((node): node is NodeProjection => Boolean(node))
    .filter((node) => selector.includeTrash === true || !isInTrash(index, node.id))
    .filter((node) => !withinIds || [...withinIds].some((rootId) => (
      node.id === rootId || isDescendantOf(index, node.id, rootId)
    )));
  candidates.sort((left, right) => compareSelectedNodes(index, left, right, selector.order ?? 'document'));
  return candidates.slice(0, selector.limit).map((node) => node.id);
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
    const difference = compareText(left.content.text, right.content.text);
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
