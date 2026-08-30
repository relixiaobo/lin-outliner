import type { Core } from '../../core/core';
import { buildReferenceSummary } from '../../core/references';
import {
  SOURCE_FIELD_ID,
  isContentBearingNode,
  sourceEntryNodeId,
  type NodeProjection,
} from '../../core/types';
import { canonicalSha256 } from '../contract/canonical';
import { OutlineContractError, outlineError } from '../contract/errors';
import type { Projection, ProjectionResult, TargetRef } from '../contract/schemas';
import { createSelectionIndex, isInTrash, resolveTargetSpec, type OutlineSelectionIndex } from './selector';

const DEFAULT_PAGE_LIMIT = 100;

export function projectOutline(
  core: Core,
  projection: Projection,
  bindings: Readonly<Record<string, readonly string[]>> = {},
): ProjectionResult {
  const document = core.projection();
  const index = createSelectionIndex(document);
  return projectOutlineFromSelectionIndex(core.revision(), index, projection, bindings);
}

export function projectOutlineFromSelectionIndex(
  revision: number,
  index: OutlineSelectionIndex,
  projection: Projection,
  bindings: Readonly<Record<string, readonly string[]>> = {},
): ProjectionResult {
  const document = index.projection;
  const targetIds = resolveTargetRef(index, projection.targets, bindings);
  const selectedIds = projection.kind === 'outline' || projection.kind === 'export'
    ? collectOutlineIds(
        index,
        targetIds,
        projection.depth ?? 3,
        projection.include?.includes('fields') === true,
      )
    : targetIds;
  const projectionHash = canonicalSha256(projectionCursorIdentity(projection));
  const offset = decodePageCursor(projection.page?.cursor, projectionHash, revision);
  const limit = projection.page?.limit ?? DEFAULT_PAGE_LIMIT;
  const pageIds = selectedIds.slice(offset, offset + limit);
  const includeBacklinks = projection.kind === 'backlinks' || projection.include?.includes('backlinks') === true;
  const referenceSummary = includeBacklinks
    ? buildReferenceSummary(index.byId, { isDeleted: (nodeId) => isInTrash(index, nodeId) })
    : undefined;
  const allBacklinks = includeBacklinks
    ? selectedIds.flatMap((nodeId) => (referenceSummary?.byTarget.get(nodeId) ?? [])
        .map((backlink) => ({
          targetId: nodeId,
          sourceId: backlink.sourceNodeId,
          referenceId: backlink.referenceNodeId,
          kind: backlink.kind,
        }))
        .sort(compareBacklinks))
    : undefined;
  const nodes = projection.kind === 'backlinks'
    ? []
    : pageIds.map((nodeId) => projectNode(index.byId.get(nodeId)!, index.byId, projection));
  const backlinks = allBacklinks?.slice(offset, offset + limit);
  const pageWidth = Math.max(pageIds.length, backlinks?.length ?? 0);
  const nextOffset = offset + pageWidth;
  const totalWidth = Math.max(projection.kind === 'backlinks' ? 0 : selectedIds.length, allBacklinks?.length ?? 0);
  return {
    projection,
    revision,
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
    ...(nextOffset < totalWidth ? {
      cursor: encodePageCursor({ projectionHash, revision, offset: nextOffset }),
      truncated: true,
    } : {}),
  };
}

function compareBacklinks(
  left: { readonly sourceId: string; readonly referenceId: string; readonly kind: string },
  right: { readonly sourceId: string; readonly referenceId: string; readonly kind: string },
): number {
  for (const key of ['sourceId', 'referenceId', 'kind'] as const) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return 0;
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

function collectOutlineIds(
  index: OutlineSelectionIndex,
  roots: readonly string[],
  depth: number,
  includeSourceStructure: boolean,
): string[] {
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
      const children = outlineProjectionChildIds(node, index.byId, includeSourceStructure);
      for (let childIndex = children.length - 1; childIndex >= 0; childIndex -= 1) {
        stack.push({ id: children[childIndex]!, depth: current.depth + 1 });
      }
    }
  }
  return result;
}

function outlineProjectionChildIds(
  node: NodeProjection,
  byId: ReadonlyMap<string, NodeProjection>,
  includeSourceStructure: boolean,
): readonly string[] {
  if (includeSourceStructure || node.type !== undefined) return node.children;
  const entryId = sourceEntryNodeId(node.id);
  const entry = byId.get(entryId);
  if (entry?.type !== 'fieldEntry' || entry.fieldDefId !== SOURCE_FIELD_ID) return node.children;
  return node.children.filter((childId) => childId !== entryId);
}

function projectNode(
  node: NodeProjection,
  byId: ReadonlyMap<string, NodeProjection>,
  projection: Projection,
): Record<string, unknown> {
  if (projection.kind === 'summary') {
    const content = isContentBearingNode(node) ? node : undefined;
    return {
      id: node.id,
      type: node.type ?? 'plain',
      text: content?.content.text ?? (node.type === 'sourceValue' ? node.sourceText : ''),
      parentId: node.parentId ?? null,
      childCount: outlineProjectionChildIds(node, byId, false).length,
      done: typeof content?.completedAt === 'number' && content.completedAt > 0,
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
