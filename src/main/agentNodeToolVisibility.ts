import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { projectFieldConfig, projectTagConfig } from '../core/configProjection';
import { agentToolResult, dropUndefinedFields, modelVisibleEnvelope, type ToolEnvelope } from './agentToolEnvelope';
import { normalChildIds } from './agentNodeToolProjection';
import { serializeAnnotatedOutlines } from './agentNodeToolRead';
import type {
  ChildrenPage,
  NodeCreateData,
  NodeDefinitionRead,
  NodeDeleteData,
  NodeEditData,
  NodeSearchBatchCountData,
  NodeSearchData,
  NodeVisibleBatchCountResult,
  NodeVisibleChanges,
  NodeVisibleCountResult,
  NodeVisibleMutationResult,
  NodeVisiblePage,
  NodeVisibleReadResult,
  NodeVisibleResult,
  NodeVisibleSearchResult,
  NormalizedReadParams,
  ProjectionIndex,
} from './agentNodeToolTypes';

/** A model-visible node result kept separate from the full runtime details. */
export interface NodeVisiblePayload {
  visible: NodeVisibleResult;
}

export function nodeToolResult<TData>(
  envelope: ToolEnvelope<TData>,
  payload: NodeVisiblePayload,
): AgentToolResult<ToolEnvelope<TData>> {
  const visibleEnvelope = modelVisibleEnvelope(envelope, payload.visible);
  return {
    content: [{ type: 'text', text: JSON.stringify(visibleEnvelope, null, 2) }],
    details: envelope,
  };
}

export function nodeErrorResult<TData>(
  envelope: ToolEnvelope<TData>,
  payload?: NodeVisiblePayload,
): AgentToolResult<ToolEnvelope<TData>> {
  if (payload) return agentToolResult(envelope, payload.visible);
  // Errors use the standard projection by default: no data block, just `error` +
  // actionable `instructions` (the error object already carries code + message).
  return agentToolResult(envelope);
}

export function visibleReadResult(
  index: ProjectionIndex,
  nodeIds: string[],
  params: NormalizedReadParams,
): NodeVisiblePayload {
  const outline = serializeAnnotatedOutlines(index, nodeIds, params.depth, params.childOffset, params.childLimit, params.includeDeleted);
  const rootPages = nodeIds
    .map((nodeId) => visibleReadPage(index, nodeId, params))
    .filter((page) => page.total > page.limit || page.offset > 0);
  const page = rootPages.length === 1 ? rootPages[0] : undefined;
  const visible: NodeVisibleReadResult = compactVisibleResult({
    outline,
    definitions: visibleDefinitionReads(index, nodeIds),
    page,
  });
  return { visible };
}

function visibleDefinitionReads(index: ProjectionIndex, nodeIds: string[]): NodeDefinitionRead[] | undefined {
  const definitions: NodeDefinitionRead[] = [];
  for (const nodeId of nodeIds) {
    const node = index.nodes.get(nodeId);
    if (node?.type === 'fieldDef') {
      definitions.push({
        kind: 'field' as const,
        config: projectFieldConfig(index.nodes, node),
        editableWith: 'node_edit operation "configure_definition" with node_id and definition_patch.',
      });
    }
    if (node?.type === 'tagDef') {
      definitions.push({
        kind: 'tag' as const,
        config: projectTagConfig(index.nodes, node),
        editableWith: 'node_edit operation "configure_definition" with node_id and definition_patch.',
      });
    }
  }
  return definitions.length ? definitions : undefined;
}

function visibleReadPage(
  index: ProjectionIndex,
  nodeId: string,
  params: NormalizedReadParams,
): NodeVisiblePage {
  return visiblePage({
    total: normalChildIds(index, nodeId, params.includeDeleted).length,
    offset: params.childOffset,
    limit: params.childLimit,
    items: [],
  });
}

export function visibleSearchResult(index: ProjectionIndex, data: NodeSearchData, count?: boolean): NodeVisiblePayload {
  const items = data.items ?? [];
  const nextOffset = data.offset + data.limit < data.total ? data.offset + data.limit : undefined;
  const visible = compactVisibleResult({
    ...(count ? { total: data.total } : {
      outline: serializeAnnotatedOutlines(index, items.map((item) => item.nodeId), 0, 0, 0, false),
      total: data.total,
      next_offset: nextOffset,
    }),
  } as NodeVisibleSearchResult | NodeVisibleCountResult);
  return { visible };
}

export function visibleSearchBatchCountResult(data: NodeSearchBatchCountData): NodeVisiblePayload {
  const visible: NodeVisibleBatchCountResult = {
    counts: Object.fromEntries(data.results.map((result) => [result.name, result.total])),
  };
  return { visible };
}

export function visibleCreateResult(data: NodeCreateData, previewOnly: boolean, index?: ProjectionIndex): NodeVisiblePayload {
  const createdIds = [...data.createdNodeIds, ...(data.createdFieldEntryIds ?? [])];
  const visible: NodeVisibleMutationResult = compactVisibleResult({
    outline: previewOnly
      ? data.outline
      : index ? serializeAnnotatedOutlines(index, data.createdRootIds, 12, 0, 500, false) : undefined,
    changes: previewOnly ? {} : compactChanges({ created: createdIds }) ?? {},
  });
  return { visible };
}

export function visibleDeleteResult(data: NodeDeleteData, previewOnly: boolean): NodeVisiblePayload {
  const visible: NodeVisibleMutationResult = compactVisibleResult({
    changes: previewOnly
      ? compactChanges({ trashed: data.preview.map((item) => item.nodeId) }) ?? {}
      : compactChanges({
        trashed: data.deletedNodeIds,
        restored: data.restoredNodeIds,
      }) ?? {},
  });
  return { visible };
}

export function visibleEditResult(data: NodeEditData, previewOnly: boolean, index?: ProjectionIndex): NodeVisiblePayload {
  const readableIds = readableEditNodeIds(data);
  const outline = previewOnly
    ? data.afterOutline
    : index ? serializeAnnotatedOutlines(index, readableIds, 3, 0, 50, false) : undefined;
  const changes = visibleEditChanges(data, previewOnly, Boolean(outline));
  const visible: NodeVisibleMutationResult = compactVisibleResult({
    outline,
    revisions: data.revisions,
    changes,
    definition: data.definition,
  });
  return { visible };
}

function visiblePage(page: ChildrenPage | { total: number; offset: number; limit: number; items: unknown[] }): NodeVisiblePage {
  const nextOffset = page.offset + page.limit < page.total ? page.offset + page.limit : undefined;
  return {
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    ...(nextOffset !== undefined ? { next_offset: nextOffset } : {}),
  };
}

function editUpdatedNodeIds(data: NodeEditData): string[] {
  const nonUpdatedIds = new Set([
    ...(data.createdNodeIds ?? []),
    ...(data.movedNodeIds ?? []),
    ...(data.trashedNodeIds ?? []),
  ]);
  return data.affectedNodeIds.filter((nodeId) => !nonUpdatedIds.has(nodeId));
}

function visibleEditChanges(data: NodeEditData, previewOnly: boolean, hasOutline: boolean): NodeVisibleChanges | undefined {
  if (previewOnly || hasOutline) return undefined;
  return compactChanges({
    updated: data.status === 'updated' ? editUpdatedNodeIds(data) : undefined,
    created: data.createdNodeIds,
    moved: data.movedNodeIds,
    trashed: data.trashedNodeIds,
  }) ?? {};
}

function readableEditNodeIds(data: NodeEditData): string[] {
  const trashedIds = new Set(data.trashedNodeIds ?? []);
  return data.affectedNodeIds.filter((nodeId) => !trashedIds.has(nodeId));
}

function compactChanges(changes: NodeVisibleChanges): NodeVisibleChanges | undefined {
  const result: NodeVisibleChanges = {};
  if (changes.created?.length) result.created = changes.created;
  if (changes.updated?.length) result.updated = changes.updated;
  if (changes.moved?.length) result.moved = changes.moved;
  if (changes.trashed?.length) result.trashed = changes.trashed;
  if (changes.restored?.length) result.restored = changes.restored;
  return Object.keys(result).length ? result : undefined;
}

function compactVisibleResult<T extends NodeVisibleResult>(result: T): T {
  return dropUndefinedFields(result as unknown as Record<string, unknown>) as unknown as T;
}
