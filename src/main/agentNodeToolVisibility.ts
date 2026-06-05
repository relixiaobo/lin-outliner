import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { formatNodeReferenceMarker } from '../core/referenceMarkup';
import { agentToolResult, dropUndefinedFields, modelVisibleEnvelope, type ToolEnvelope } from './agentToolEnvelope';
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
  NodeVisibleMutationResult,
  NodeVisiblePage,
  NodeVisibleReadResult,
  NodeVisibleReference,
  NodeVisibleResult,
  NodeVisibleSearchResult,
  NormalizedReadParams,
  ProjectionIndex,
} from './agentNodeToolTypes';

// Keep this union in lockstep with the node tool `name` fields. `nodeInstructions`
// switches on it exhaustively, so adding a tool forces a guidance branch.
type NodeToolName = 'node_read' | 'node_search' | 'node_create' | 'node_edit' | 'node_delete';

/**
 * Facts the caller holds that drive guidance but never appear in the payload.
 * `count` is node_search's count-only mode; `outcome` is the mutation result
 * (a preview, a real apply, or a no-op). Carried next to the visible result so
 * each fact lives in exactly ONE place — the builder that already knows it —
 * never re-derived from the payload shape nor duplicated at the call site.
 */
interface NodeInstructionContext {
  count?: boolean;
  outcome?: 'preview' | 'applied' | 'unchanged';
}

/** A model-visible node result plus the guidance context the builder computed. */
export interface NodeVisiblePayload {
  visible: NodeVisibleResult;
  ctx: NodeInstructionContext;
}

export function nodeToolResult<TData>(
  envelope: ToolEnvelope<TData>,
  payload: NodeVisiblePayload,
): AgentToolResult<ToolEnvelope<TData>> {
  // Node tools compute their own guidance, then hand off to the shared
  // `modelVisibleEnvelope` projector. The spread envelope is a throwaway used
  // only for projection — `details` keeps the original envelope, unchanged.
  const instructions = nodeInstructions(envelope, payload.visible, payload.ctx);
  const visibleEnvelope = modelVisibleEnvelope({ ...envelope, instructions }, payload.visible);
  return {
    content: [{ type: 'text', text: JSON.stringify(visibleEnvelope, null, 2) }],
    details: envelope,
  };
}

export function nodeErrorResult<TData>(
  envelope: ToolEnvelope<TData>,
): AgentToolResult<ToolEnvelope<TData>> {
  // Errors use the standard projection: no data block, just `error` +
  // `instructions` (the error object already carries code + message).
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
    references: visibleReferences(index, visibleReadReferenceIds(index, nodeIds, params)),
    page,
  });
  return { visible, ctx: {} };
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
  const page = visiblePage({ total: data.total, offset: data.offset, limit: data.limit, items });
  const visible = compactVisibleResult({
    ...(count ? { total: data.total } : {
      outline: serializeAnnotatedOutlines(index, items.map((item) => item.nodeId), 0, 0, 0, false),
      references: visibleReferences(index, items.map((item) => item.nodeId)),
    }),
    page,
  } as NodeVisibleSearchResult | NodeVisibleCountResult);
  return { visible, ctx: { count } };
}

export function visibleCreateResult(data: NodeCreateData, previewOnly: boolean, index?: ProjectionIndex): NodeVisiblePayload {
  const visible: NodeVisibleMutationResult = compactVisibleResult({
    outline: previewOnly
      ? data.outline
      : index ? serializeAnnotatedOutlines(index, data.createdRootIds, 12, 0, 500, false) : undefined,
    changes: previewOnly ? {} : compactChanges({ created: data.createdNodeIds }) ?? {},
  });
  return { visible, ctx: { outcome: previewOnly ? 'preview' : 'applied' } };
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
  return { visible, ctx: { outcome: previewOnly ? 'preview' : 'applied' } };
}

export function visibleEditResult(data: NodeEditData, previewOnly: boolean, index?: ProjectionIndex): NodeVisiblePayload {
  const readableIds = readableEditNodeIds(data);
  const visible: NodeVisibleMutationResult = compactVisibleResult({
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
  // A non-preview edit can still be a real no-op (afterOutline == current).
  const outcome = previewOnly ? 'preview' : data.status === 'updated' ? 'applied' : 'unchanged';
  return { visible, ctx: { outcome } };
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

// The visible result no longer carries a `kind`/`action` discriminant (both were
// derivable from the tool name), so guidance switches on `envelope.tool` and the
// caller-supplied `ctx` (count / mutation outcome) — never on the payload shape.
// The switch is exhaustive over NodeToolName: a new tool forces a branch here.
function nodeInstructions<TData>(envelope: ToolEnvelope<TData>, data: NodeVisibleResult, ctx: NodeInstructionContext): string {
  const parts: string[] = [];
  switch (envelope.tool as NodeToolName) {
    case 'node_read': {
      parts.push('Use data.outline as the single source of truth for follow-up edits. Preserve existing %%node:id%% markers for existing nodes; omit markers only for newly created lines.');
      if (resultReferences(data)?.length) parts.push('For final answers, prefer copying data.references[].display_ref for node mentions.');
      parts.push(FINAL_ANSWER_NODE_REFERENCE_GUIDANCE);
      const nextOffset = resultNextOffset(data);
      if (nextOffset !== undefined) {
        parts.push(`More root children are available. Call node_read again with child_offset ${nextOffset} and the same node_id/depth/child_limit.`);
      }
      break;
    }
    case 'node_search': {
      if (ctx.count) {
        parts.push('Only the result count was requested; call node_search without count when you need editable node ids.');
        break;
      }
      parts.push('Use the %%node:id%% markers in data.outline when reading or editing a search result.');
      if (resultReferences(data)?.length) parts.push('For final answers, prefer copying data.references[].display_ref for result mentions.');
      parts.push(FINAL_ANSWER_NODE_REFERENCE_GUIDANCE);
      const nextOffset = resultNextOffset(data);
      if (nextOffset !== undefined) {
        parts.push(`More search results are available. Call node_search again with offset ${nextOffset} and the same outline/search_node_id/limit.`);
      }
      break;
    }
    case 'node_create': {
      parts.push(ctx.outcome === 'preview'
        ? 'Preview only; no nodes were created.'
        : 'Created nodes are included in data.outline with fresh %%node:id%% markers for follow-up edits.');
      parts.push(FINAL_ANSWER_NODE_REFERENCE_GUIDANCE);
      break;
    }
    case 'node_edit': {
      parts.push(editOutcomeGuidance(ctx.outcome));
      parts.push(FINAL_ANSWER_NODE_REFERENCE_GUIDANCE);
      break;
    }
    case 'node_delete': {
      parts.push(ctx.outcome === 'preview'
        ? 'Preview only; no nodes were moved.'
        : 'Nodes were moved to Trash, not permanently deleted.');
      break;
    }
    default: {
      // Exhaustiveness guard: extending NodeToolName without a case fails here.
      const _exhaustive: never = envelope.tool as never;
      void _exhaustive;
    }
  }
  if (envelope.instructions) parts.push(envelope.instructions);
  return parts.join(' ');
}

// A non-preview node_edit can leave the document unchanged (the requested
// afterOutline already matched). Guidance must follow the actual outcome rather
// than always claiming the edit applied.
function editOutcomeGuidance(outcome: NodeInstructionContext['outcome']): string {
  if (outcome === 'preview') return 'Preview only; no edit was applied. Re-run without preview_only to apply it.';
  if (outcome === 'unchanged') return 'No change was needed; the targeted nodes already match the requested content.';
  return 'Edit applied. Marked existing nodes were updated in place; unmarked new lines were created; removed marked lines were moved to Trash.';
}

function resultReferences(data: NodeVisibleResult): NodeVisibleReference[] | undefined {
  return 'references' in data ? data.references : undefined;
}

function resultNextOffset(data: NodeVisibleResult): number | undefined {
  return 'page' in data ? data.page?.next_offset : undefined;
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
  return dropUndefinedFields(result as unknown as Record<string, unknown>) as unknown as T;
}
