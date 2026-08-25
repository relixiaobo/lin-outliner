import type { Core } from '../../core/core';
import type { NodeProjection } from '../../core/types';
import { canonicalSha256 } from '../contract/canonical';
import { OutlineContractError, outlineError } from '../contract/errors';
import type { Projection, ProjectionResult, TargetRef } from '../contract/schemas';
import { createSelectionIndex, resolveTargetSpec, type OutlineSelectionIndex } from './selector';

const DEFAULT_PAGE_LIMIT = 100;

export function projectOutline(
  core: Core,
  projection: Projection,
  bindings: Readonly<Record<string, readonly string[]>> = {},
): ProjectionResult {
  const document = core.projection();
  const index = createSelectionIndex(document);
  const targetIds = resolveTargetRef(index, projection.targets, bindings);
  const selectedIds = projection.kind === 'outline' || projection.kind === 'export'
    ? collectOutlineIds(index, targetIds, projection.depth ?? 3)
    : targetIds;
  const projectionHash = canonicalSha256(projectionCursorIdentity(projection));
  const offset = decodePageCursor(projection.page?.cursor, projectionHash, core.revision());
  const limit = projection.page?.limit ?? DEFAULT_PAGE_LIMIT;
  const pageIds = selectedIds.slice(offset, offset + limit);
  const includeBacklinks = projection.kind === 'backlinks' || projection.include?.includes('backlinks') === true;
  const nodes = projection.kind === 'backlinks'
    ? []
    : pageIds.map((nodeId) => projectNode(index.byId.get(nodeId)!, projection));
  const backlinks = includeBacklinks
    ? pageIds.flatMap((nodeId) => core.backlinks(nodeId).map((backlink) => ({ targetId: nodeId, ...backlink })))
    : undefined;
  const nextOffset = offset + pageIds.length;
  return {
    projection,
    revision: core.revision(),
    anchors: {
      workspaceId: document.workspaceId,
      rootId: document.rootId,
      libraryId: document.libraryId,
      dailyNotesId: document.dailyNotesId,
      schemaId: document.schemaId,
      searchesId: document.searchesId,
      recentsId: document.recentsId,
      trashId: document.trashId,
      todayId: document.todayId,
    },
    nodes,
    ...(backlinks ? { backlinks } : {}),
    ...(nextOffset < selectedIds.length ? {
      cursor: encodePageCursor({ projectionHash, revision: core.revision(), offset: nextOffset }),
      truncated: true,
    } : {}),
  };
}

export function resolveTargetRef(
  index: OutlineSelectionIndex,
  reference: TargetRef,
  bindings: Readonly<Record<string, readonly string[]>>,
): readonly string[] {
  if ('binding' in reference) {
    const ids = bindings[reference.binding];
    if (!ids) {
      throw new OutlineContractError(outlineError(
        'invalid_input',
        'selection',
        `Unknown ChangeSet binding: ${reference.binding}`,
      ));
    }
    return ids;
  }
  return resolveTargetSpec(index, reference.target);
}

function collectOutlineIds(index: OutlineSelectionIndex, roots: readonly string[], depth: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const rootId of roots) {
    const stack: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (seen.has(current.id)) continue;
      const node = index.byId.get(current.id);
      if (!node) continue;
      seen.add(current.id);
      result.push(current.id);
      if (current.depth >= depth) continue;
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        stack.push({ id: node.children[index]!, depth: current.depth + 1 });
      }
    }
  }
  return result;
}

function projectNode(node: NodeProjection, projection: Projection): Record<string, unknown> {
  if (projection.kind === 'summary') {
    return {
      id: node.id,
      type: node.type ?? 'plain',
      text: node.content.text,
      parentId: node.parentId ?? null,
      childCount: node.children.length,
      done: typeof node.completedAt === 'number' && node.completedAt > 0,
    };
  }
  const include = new Set(projection.include ?? []);
  const result = JSON.parse(JSON.stringify(node)) as Record<string, unknown>;
  if (!include.has('description')) delete result.description;
  if (!include.has('children') && projection.kind !== 'outline' && projection.kind !== 'export') delete result.children;
  if (!include.has('tags')) delete result.tags;
  if (!include.has('references')) {
    delete result.targetId;
    if (isRecord(result.content)) delete result.content.inlineRefs;
  }
  if (!include.has('media')) {
    for (const key of ['assetId', 'thumbnailAssetId', 'mediaUrl', 'bannerAssetId']) delete result[key];
  }
  if (!include.has('fields')) delete result.fieldDefId;
  if (!include.has('view')) {
    for (const key of [
      'viewMode',
      'toolbarVisible',
      'groupField',
      'sortField',
      'sortDirection',
      'filterField',
      'filterOperator',
      'filterValueLogic',
      'filterValues',
      'displayField',
      'displayVisible',
      'displayWidth',
      'displayOrder',
      'displayLabel',
      'displayPlacement',
      'queryLogic',
      'queryOp',
      'queryTagDefId',
      'queryFieldDefId',
      'queryTargetId',
    ]) delete result[key];
  }
  if (!include.has('trash')) delete result.trashedFromParentId;
  return result;
}

interface PageCursor {
  readonly projectionHash: string;
  readonly revision: number;
  readonly offset: number;
}

function projectionCursorIdentity(projection: Projection): Projection {
  if (!projection.page) return projection;
  const { cursor: _cursor, ...page } = projection.page;
  return { ...projection, page };
}

function encodePageCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodePageCursor(cursor: string | undefined, projectionHash: string, revision: number): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(value)
      || value.projectionHash !== projectionHash
      || value.revision !== revision
      || !Number.isSafeInteger(value.offset)
      || (value.offset as number) < 0) throw new Error('cursor mismatch');
    return value.offset as number;
  } catch {
    throw new OutlineContractError(outlineError(
      'stale_revision',
      'conflict',
      'Projection cursor does not match the requested Projection and revision.',
    ));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
