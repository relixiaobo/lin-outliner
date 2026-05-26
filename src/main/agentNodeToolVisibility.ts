import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { formatNodeReferenceMarker } from '../core/nodeReferenceMarkup';
import type { ToolEnvelope } from './agentToolEnvelope';
import { FINAL_ANSWER_NODE_REFERENCE_GUIDANCE } from './agentNodeToolGuidance';
import { nodeKind, nodeTitle, normalChildIds, requiredNode } from './agentNodeToolProjection';
import { serializeAnnotatedOutlines } from './agentNodeToolRead';
import type {
  ChildrenPage,
  NodeCreateData,
  NodeDeleteData,
  NodeEditData,
  NodeSearchData,
  NodeVisibleChanges,
  NodeVisibleCountResult,
  NodeVisibleEnvelope,
  NodeVisibleMutationResult,
  NodeVisiblePage,
  NodeVisibleReadResult,
  NodeVisibleReference,
  NodeVisibleResult,
  NodeVisibleSearchResult,
  NormalizedReadParams,
  ProjectionIndex,
} from './agentNodeToolTypes';

export function nodeToolResult<TData>(
  envelope: ToolEnvelope<TData>,
  visibleData: NodeVisibleResult,
): AgentToolResult<ToolEnvelope<TData>> {
  const visibleEnvelope = nodeVisibleEnvelope(envelope, visibleData);
  return {
    content: [{ type: 'text', text: JSON.stringify(visibleEnvelope, null, 2) }],
    details: envelope,
  };
}

export function nodeErrorResult<TData>(
  envelope: ToolEnvelope<TData>,
): AgentToolResult<ToolEnvelope<TData>> {
  return {
    content: [{ type: 'text', text: JSON.stringify(nodeVisibleErrorEnvelope(envelope), null, 2) }],
    details: envelope,
  };
}

function nodeVisibleEnvelope<TData>(
  envelope: ToolEnvelope<TData>,
  data: NodeVisibleResult,
): NodeVisibleEnvelope {
  return compactVisibleEnvelope({
    ok: envelope.ok,
    tool: envelope.tool,
    status: envelope.status,
    instructions: nodeInstructions(envelope, data),
    data,
    warnings: envelope.warnings,
  });
}

function nodeVisibleErrorEnvelope<TData>(envelope: ToolEnvelope<TData>): NodeVisibleEnvelope {
  const error = envelope.error ?? {
    code: 'unknown_error',
    message: 'Tool failed without an error payload.',
    recoverable: true,
  };
  return compactVisibleEnvelope({
    ok: false,
    tool: envelope.tool,
    status: 'error',
    instructions: errorInstructions(envelope),
    error,
    warnings: envelope.warnings,
  });
}

export function visibleReadResult(
  index: ProjectionIndex,
  nodeIds: string[],
  params: NormalizedReadParams,
): NodeVisibleReadResult {
  const outline = serializeAnnotatedOutlines(index, nodeIds, params.depth, params.childOffset, params.childLimit, params.includeDeleted);
  const rootPages = nodeIds
    .map((nodeId) => visibleReadPage(index, nodeId, params))
    .filter((page) => page.total > page.limit || page.offset > 0);
  const page = rootPages.length === 1 ? rootPages[0] : undefined;
  return compactVisibleResult({
    kind: 'read',
    outline,
    references: visibleReferences(index, visibleReadReferenceIds(index, nodeIds, params)),
    page,
  });
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

export function visibleSearchResult(index: ProjectionIndex, data: NodeSearchData): NodeVisibleSearchResult | NodeVisibleCountResult {
  const items = data.items ?? [];
  const page = visiblePage({ total: data.total, offset: data.offset, limit: data.limit, items });
  return compactVisibleResult({
    kind: data.items ? 'search' : 'count',
    ...(data.items ? {
      outline: serializeAnnotatedOutlines(index, items.map((item) => item.nodeId), 0, 0, 0, false),
      references: visibleReferences(index, items.map((item) => item.nodeId)),
    } : { total: data.total }),
    page,
  } as NodeVisibleSearchResult | NodeVisibleCountResult);
}

export function visibleCreateResult(data: NodeCreateData, previewOnly: boolean, index?: ProjectionIndex): NodeVisibleMutationResult {
  return compactVisibleResult({
    kind: 'mutation',
    action: 'create',
    status: previewOnly ? 'preview' : 'applied',
    outline: previewOnly
      ? data.outline
      : index ? serializeAnnotatedOutlines(index, data.createdRootIds, 12, 0, 500, false) : undefined,
    changes: previewOnly ? {} : compactChanges({ created: data.createdNodeIds }) ?? {},
  });
}

export function visibleDeleteResult(data: NodeDeleteData, previewOnly: boolean): NodeVisibleMutationResult {
  return compactVisibleResult({
    kind: 'mutation',
    action: 'delete',
    status: previewOnly ? 'preview' : 'applied',
    changes: previewOnly
      ? compactChanges({ trashed: data.preview.map((item) => item.nodeId) }) ?? {}
      : compactChanges({
        trashed: data.deletedNodeIds,
        restored: data.restoredNodeIds,
      }) ?? {},
  });
}

export function visibleEditResult(data: NodeEditData, previewOnly: boolean, index?: ProjectionIndex): NodeVisibleMutationResult {
  const changed = data.status === 'updated';
  const readableIds = readableEditNodeIds(data);
  return compactVisibleResult({
    kind: 'mutation',
    action: 'edit',
    status: previewOnly ? 'preview' : changed ? 'applied' : 'unchanged',
    outline: previewOnly
      ? data.afterOutline
      : index ? serializeAnnotatedOutlines(index, readableIds, 3, 0, 50, false) : undefined,
    changes: previewOnly
      ? {}
      : compactChanges({
        updated: data.status === 'updated' ? editUpdatedNodeIds(data) : undefined,
        created: data.createdNodeIds,
        moved: data.movedNodeIds,
        trashed: data.trashedNodeIds,
      }) ?? {},
  });
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

function readableEditNodeIds(data: NodeEditData): string[] {
  const trashedIds = new Set(data.trashedNodeIds ?? []);
  return data.affectedNodeIds.filter((nodeId) => !trashedIds.has(nodeId));
}

function nodeInstructions<TData>(envelope: ToolEnvelope<TData>, data: NodeVisibleResult): string {
  const parts: string[] = [];
  if (data.kind === 'read') {
    parts.push('Use data.outline as the single source of truth for follow-up edits. Preserve existing %%node:id%% markers for existing nodes; omit markers only for newly created lines.');
    if (data.references?.length) parts.push('For final answers, prefer copying data.references[].display_ref for node mentions.');
    parts.push(FINAL_ANSWER_NODE_REFERENCE_GUIDANCE);
    if (data.page?.next_offset !== undefined) {
      parts.push(`More root children are available. Call node_read again with child_offset ${data.page.next_offset} and the same node_id/depth/child_limit.`);
    }
  } else if (data.kind === 'search') {
    parts.push('Use the %%node:id%% markers in data.outline when reading or editing a search result.');
    if (data.references?.length) parts.push('For final answers, prefer copying data.references[].display_ref for result mentions.');
    parts.push(FINAL_ANSWER_NODE_REFERENCE_GUIDANCE);
    if (data.page.next_offset !== undefined) {
      parts.push(`More search results are available. Call node_search again with offset ${data.page.next_offset} and the same outline/search_node_id/limit.`);
    }
  } else if (data.kind === 'count') {
    parts.push('Only the result count was requested; call node_search without count when you need editable node ids.');
  } else if (data.kind === 'mutation') {
    if (data.action === 'create') {
      parts.push(data.status === 'preview'
        ? 'Preview only; no nodes were created.'
        : 'Created nodes are included in data.outline with fresh %%node:id%% markers for follow-up edits.');
    } else if (data.action === 'edit') {
      parts.push(data.status === 'preview'
        ? 'Preview only; no edit was applied.'
        : 'Edit applied. Marked existing nodes were updated in place; unmarked new lines were created; removed marked lines were moved to Trash.');
    } else if (data.action === 'delete') {
      parts.push(data.status === 'preview'
        ? 'Preview only; no nodes were moved.'
        : 'Nodes were moved to Trash, not permanently deleted.');
    }
  }
  if (envelope.instructions) parts.push(envelope.instructions);
  return parts.join(' ');
}

function errorInstructions<TData>(envelope: ToolEnvelope<TData>): string | undefined {
  return envelope.instructions;
}

function visibleReadReferenceIds(
  index: ProjectionIndex,
  nodeIds: string[],
  params: NormalizedReadParams,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (nodeId: string) => {
    if (seen.has(nodeId)) return;
    seen.add(nodeId);
    out.push(nodeId);
  };
  const visit = (nodeId: string, depth: number, childOffset: number) => {
    push(nodeId);
    if (depth <= 0) return;
    const childIds = normalChildIds(index, nodeId, params.includeDeleted)
      .slice(childOffset, childOffset + params.childLimit);
    for (const childId of childIds) visit(childId, depth - 1, 0);
  };
  for (const nodeId of nodeIds) visit(nodeId, params.depth, params.childOffset);
  return out;
}

function visibleReferences(index: ProjectionIndex, nodeIds: string[]): NodeVisibleReference[] | undefined {
  const seen = new Set<string>();
  const references: NodeVisibleReference[] = [];
  for (const nodeId of nodeIds) {
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    const node = requiredNode(index, nodeId);
    const title = nodeTitle(index, node);
    references.push({
      node_id: nodeId,
      title,
      display_ref: formatNodeReferenceMarker(title, nodeId),
      edit_handle: `%%node:${nodeId}%%`,
      type: nodeKind(node),
    });
  }
  return references.length > 0 ? references : undefined;
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
  return Object.fromEntries(
    Object.entries(result as unknown as Record<string, unknown>).filter(([, value]) => value !== undefined),
  ) as unknown as T;
}

function compactVisibleEnvelope(result: NodeVisibleEnvelope): NodeVisibleEnvelope {
  return Object.fromEntries(
    Object.entries(result as unknown as Record<string, unknown>).filter(([, value]) => {
      if (value === undefined) return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return true;
    }),
  ) as unknown as NodeVisibleEnvelope;
}
