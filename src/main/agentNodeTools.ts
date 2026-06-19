import type { AgentTool } from '@earendil-works/pi-agent-core';
import path from 'node:path';
import { normalizeDateFieldValue } from '../core/dateFieldValue';
import { projectFieldConfig, nodeIsDone, nodeShowsCheckbox } from '../core/configProjection';
import {
  plainText,
  replaceAllRichTextPatch,
  type NodeProjection,
} from '../core/types';
import { agentToolResult, errorEnvelope, successEnvelope, type ToolEnvelope } from './agentToolEnvelope';
import {
  parseLinOutline,
  type OutlineDocument,
  type OutlineField,
  type OutlineNode,
  type OutlineValue,
} from './agentOutlineParser';
import {
  NODE_CREATE_PARAMETERS,
  NODE_DELETE_PARAMETERS,
  NODE_EDIT_PARAMETERS,
  NODE_READ_PARAMETERS,
  NODE_SEARCH_PARAMETERS,
  OPERATION_HISTORY_PARAMETERS,
} from './agentNodeToolSchemas';
import {
  NODE_CREATE_DESCRIPTION,
  NODE_DELETE_DESCRIPTION,
  NODE_EDIT_DESCRIPTION,
  NODE_READ_DESCRIPTION,
  NODE_SEARCH_DESCRIPTION,
  OPERATION_HISTORY_DESCRIPTION,
} from './agentNodeToolGuidance';
import {
  buildReadItem,
  normalizeReadParams,
  pageHasMore,
  serializeAnnotatedOutline,
  serializeOutline,
} from './agentNodeToolRead';
import {
  buildSearchItem,
  normalizeSearchParams,
  resolveSearch,
  resolveSearchSpecFromOutlineNode,
  runSearch,
  searchNodeConfigFromSpec,
  validateReferenceTargetIds,
  validateSearchNodes,
} from './agentNodeToolSearch';
import {
  changedNodeIds,
  fieldName,
  findTagByName,
  indexProjection,
  isInTrash,
  isSystemNodeId,
  nodeKind,
  nodeTitle,
  normalChildIds,
  parentRef,
  projectionFingerprint,
  requiredNode,
  revisionOf,
} from './agentNodeToolProjection';
import {
  asRecord,
  clampInteger,
  elapsed,
  errorMessage,
  firstDuplicate,
  jsonByteLength,
  normalizeLineEndings,
  unique,
} from './agentNodeToolUtils';
import {
  nodeErrorResult,
  nodeToolResult,
  visibleCreateResult,
  visibleDeleteResult,
  visibleEditResult,
  visibleReadResult,
  visibleSearchResult,
} from './agentNodeToolVisibility';
import type {
  NodeCreateData,
  NodeCreateParams,
  NodeDeleteData,
  NodeDeleteParams,
  NodeDeletePreview,
  NodeDeleteSkip,
  NodeEditData,
  NodeEditMoveParams,
  NodeMergeFieldPreview,
  NodeReadData,
  NodeSearchData,
  NormalizedEditParams,
  OperationHistoryData,
  OperationHistoryItem,
  OperationHistoryParams,
  OutlinerToolHost,
  ProjectionIndex,
} from './agentNodeToolTypes';
import { splitFileReferenceMarkers } from '../core/referenceMarkup';
import { isPathInside } from './agentAttachmentMaterialization';

export type { OutlinerToolHost } from './agentNodeToolTypes';

export interface NodeToolsOptions {
  localFileRoot?: string;
}

export function createNodeTools(host: OutlinerToolHost, options: NodeToolsOptions = {}): AgentTool<any>[] {
  const agentHost = asAgentToolHost(host);
  return [
    createNodeSearchTool(agentHost),
    createNodeReadTool(agentHost),
    createNodeCreateTool(agentHost, options),
    createNodeEditTool(agentHost, options),
    createNodeDeleteTool(agentHost),
    createOperationHistoryTool(agentHost),
  ].map((tool) => tool.name === 'operation_history' ? tool : withAgentToolTransaction(tool, agentHost));
}

function asAgentToolHost(host: OutlinerToolHost): OutlinerToolHost {
  return {
    getProjection: () => host.getProjection(),
    getTextSearchIndex: host.getTextSearchIndex ? () => host.getTextSearchIndex!() : undefined,
    getSearchRankingOptions: host.getSearchRankingOptions ? () => host.getSearchRankingOptions!() : undefined,
    recordNodeAccess: host.recordNodeAccess
      ? (nodeIds, source) => host.recordNodeAccess!(nodeIds, source)
      : undefined,
    // On the MUTATION paths, `origin: 'agent'` MUST come last so a caller-supplied
    // `meta` can never override the forced agent origin (the bright line trusts
    // `origin === 'user'`; a spread that let meta win would be a fail-open).
    handle: (command, args = {}, meta = {}) => host.handle(command, args, { ...meta, origin: 'agent' }),
    transaction: host.transaction
      ? (meta, fn) => host.transaction!({ ...meta, origin: 'agent' }, fn)
      : undefined,
    // operationHistory's `origin` is a READ FILTER, not a commit gate: the query's
    // value (often undefined = list all origins) must win, so it spreads LAST.
    operationHistory: host.operationHistory
      ? (query) => host.operationHistory!({ origin: 'agent', ...query })
      : undefined,
  };
}

function withAgentToolTransaction(tool: AgentTool<any>, host: OutlinerToolHost): AgentTool<any> {
  if (!host.transaction) return tool;
  return {
    ...tool,
    execute: (toolCallId: string, params: unknown) =>
      host.transaction!({ origin: 'agent', tool: tool.name }, () => tool.execute(toolCallId, params)),
  };
}

function createOperationHistoryTool(host: OutlinerToolHost): AgentTool<any, ToolEnvelope<OperationHistoryData>> {
  return {
    name: 'operation_history',
    label: 'Operation History',
    description: OPERATION_HISTORY_DESCRIPTION,
    parameters: OPERATION_HISTORY_PARAMETERS,
    executionMode: 'sequential',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      const params = normalizeOperationHistoryParams(rawParams);
      if (params.error) {
        return agentToolResult(errorEnvelope<OperationHistoryData>('operation_history', 'invalid_args', params.error, {
          instructions: 'Call operation_history with action "list", "undo", or "redo".',
          metrics: { durationMs: elapsed(started) },
        }));
      }
      if (!host.operationHistory) {
        return agentToolResult(errorEnvelope<OperationHistoryData>('operation_history', 'history_unavailable', 'The host does not expose Loro operation history.', {
          instructions: 'Retry after the document service has initialized operation history support.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      const data = await host.operationHistory(params);
      return agentToolResult(successEnvelope('operation_history', data, {
        status: params.action === 'list' || data.count > 0 ? 'success' : 'unchanged',
        metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
      }), visibleOperationHistory(data));
    },
  };
}

// Model-visible projection: the full OperationHistoryData stays on the envelope
// (details). The model needs the entries plus undo/redo affordances, not the
// derivable count, the internal historyMode, the Loro cursor, or each item's
// raw command name (tool/action/summary already describe the operation).
export function visibleOperationHistory(data: OperationHistoryData): unknown {
  const visible: Record<string, unknown> = { action: data.action };
  if (data.total !== undefined) visible.total = data.total;
  if (data.hasMore) visible.hasMore = true;
  if (data.items) visible.items = data.items.map(visibleHistoryItem);
  if (data.undone) visible.undone = data.undone.map(visibleHistoryItem);
  if (data.redone) visible.redone = data.redone.map(visibleHistoryItem);
  visible.canUndo = data.canUndo;
  visible.canRedo = data.canRedo;
  return visible;
}

function visibleHistoryItem(item: OperationHistoryItem) {
  return {
    operationId: item.operationId,
    origin: item.origin,
    ...(item.tool ? { tool: item.tool } : {}),
    action: item.action,
    summary: item.summary,
    affectedNodeIds: item.affectedNodeIds,
    createdAt: item.createdAt,
    canUndo: item.canUndo,
    canRedo: item.canRedo,
  };
}

function createNodeEditTool(host: OutlinerToolHost, options: NodeToolsOptions): AgentTool<any, ToolEnvelope<NodeEditData>> {
  return {
    name: 'node_edit',
    label: 'Node Edit',
    description: NODE_EDIT_DESCRIPTION,
    parameters: NODE_EDIT_PARAMETERS,
    executionMode: 'sequential',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      const params = normalizeEditParams(rawParams);
      if ('error' in params) {
        return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'invalid_args', params.error, {
          instructions: 'Use exactly one action: outline edit, move, merge_from_node_ids, or replace_with_reference_to.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      switch (params.action) {
        case 'outline_edit':
          return executeOutlineEdit(host, params, started, options);
        case 'move':
          return executeMoveEdit(host, params, started);
        case 'merge':
          return executeMergeEdit(host, params, started);
        case 'replace_with_reference':
          return executeReferenceReplaceEdit(host, params, started);
      }
    },
  };
}

function createNodeDeleteTool(host: OutlinerToolHost): AgentTool<any, ToolEnvelope<NodeDeleteData>> {
  return {
    name: 'node_delete',
    label: 'Node Delete',
    description: NODE_DELETE_DESCRIPTION,
    parameters: NODE_DELETE_PARAMETERS,
    executionMode: 'sequential',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      const params = normalizeDeleteParams(rawParams);
      if (params.error) {
        return nodeErrorResult(errorEnvelope('node_delete', 'invalid_args', params.error, {
          instructions: 'Call node_delete with either node_id or node_ids, not both.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      const index = indexProjection(host.getProjection());
      const requestedNodeIds = params.nodeIds ?? [params.nodeId!];
      const missing = requestedNodeIds.find((nodeId) => !index.nodes.has(nodeId));
      if (missing) {
        return nodeErrorResult(errorEnvelope('node_delete', 'node_not_found', `Node not found: ${missing}`, {
          instructions: 'Use node_search or node_read to locate the current node id.',
          metrics: { durationMs: elapsed(started) },
        }));
      }
      const locked = requestedNodeIds.find((nodeId) => isSystemNodeId(nodeId));
      if (locked) {
        return nodeErrorResult(errorEnvelope('node_delete', 'locked_node', `System node cannot be deleted: ${locked}`, {
          instructions: 'Choose a user-created node instead of a protected system node.',
          metrics: { durationMs: elapsed(started) },
        }));
      }
      if (params.restore) {
        const notTrashed = requestedNodeIds.find((nodeId) => !isInTrash(index, nodeId));
        if (notTrashed) {
          return nodeErrorResult(errorEnvelope('node_delete', 'node_not_in_trash', `Node is not in Trash: ${notTrashed}`, {
            instructions: 'Use restore true only for nodes currently in Trash.',
            metrics: { durationMs: elapsed(started) },
          }));
        }
        const preview = requestedNodeIds.map((nodeId) => deletePreview(index, nodeId));
        const affectedNodeCount = preview.reduce((sum, item) => sum + item.subtreeNodeCount, 0);
        const data: NodeDeleteData = {
          action: 'restored',
          trashId: index.projection.trashId,
          requestedNodeIds,
          deletedNodeIds: [],
          restoredNodeIds: params.previewOnly ? [] : requestedNodeIds,
          deletedCount: 0,
          restoredCount: params.previewOnly ? 0 : requestedNodeIds.length,
          affectedNodeCount,
          preview,
        };
        if (params.previewOnly) {
          return nodeToolResult(successEnvelope('node_delete', data, {
            status: 'unchanged',
            metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
          }), visibleDeleteResult(data, true));
        }
        try {
          for (const nodeId of requestedNodeIds) await host.handle('restore_node', { nodeId });
        } catch (error) {
          return nodeErrorResult(errorEnvelope('node_delete', 'mutation_failed', errorMessage(error), {
            instructions: 'Use node_read with include_deleted true to verify the nodes are restorable.',
            metrics: { durationMs: elapsed(started) },
          }));
        }
        return nodeToolResult(successEnvelope('node_delete', data, {
          metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
        }), visibleDeleteResult(data, false));
      }
      const trashed = requestedNodeIds.find((nodeId) => isInTrash(index, nodeId));
      if (trashed) {
        return nodeErrorResult(errorEnvelope('node_delete', 'node_in_trash', `Node is already in Trash: ${trashed}`, {
          instructions: 'Use node_read with include_deleted true to inspect Trash content.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      const selection = topLevelSelection(index, requestedNodeIds);
      const preview = selection.nodeIds.map((nodeId) => deletePreview(index, nodeId));
      const affectedNodeCount = preview.reduce((sum, item) => sum + item.subtreeNodeCount, 0);
      const data: NodeDeleteData = {
        action: 'trashed',
        trashId: index.projection.trashId,
        requestedNodeIds,
        deletedNodeIds: params.previewOnly ? [] : selection.nodeIds,
        deletedCount: params.previewOnly ? 0 : selection.nodeIds.length,
        affectedNodeCount,
        preview,
        skippedNodeIds: selection.skipped.length ? selection.skipped : undefined,
      };

      if (params.previewOnly) {
        return nodeToolResult(successEnvelope('node_delete', data, {
          status: 'unchanged',
          metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
        }), visibleDeleteResult(data, true));
      }

      try {
        if (selection.nodeIds.length === 1) {
          await host.handle('trash_node', { nodeId: selection.nodeIds[0] });
        } else {
          await host.handle('batch_trash_nodes', { nodeIds: selection.nodeIds });
        }
      } catch (error) {
        return nodeErrorResult(errorEnvelope('node_delete', 'mutation_failed', errorMessage(error), {
          instructions: 'Use node_read to verify the selected nodes still exist and are movable.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      return nodeToolResult(successEnvelope('node_delete', data, {
        warnings: selection.skipped.length ? ['Some requested descendant nodes were covered by a selected ancestor and skipped.'] : undefined,
        metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
      }), visibleDeleteResult(data, false));
    },
  };
}

async function executeOutlineEdit(
  host: OutlinerToolHost,
  params: Extract<NormalizedEditParams, { action: 'outline_edit' }>,
  started: number,
  options: NodeToolsOptions,
) {
  const index = indexProjection(host.getProjection());
  const validation = validateMutableNodeIds(index, [params.nodeId]);
  if (validation) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', validation.code, validation.error, {
      instructions: validation.instructions,
      metrics: { durationMs: elapsed(started) },
    }));
  }
  const currentNode = requiredNode(index, params.nodeId);
  const currentRevision = revisionOf(currentNode);
  if (params.expectedRevision && params.expectedRevision !== currentRevision) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'revision_mismatch', `Node changed since it was read: ${params.nodeId}`, {
      instructions: 'Call node_read again and retry with the latest outline and revision.',
      metrics: { durationMs: elapsed(started) },
    }));
  }

  const currentOutline = serializeAnnotatedOutline(index, params.nodeId, 12, 0, 500, false);
  const replacement = replaceOutline(currentOutline, params.oldString, params.newString);
  if (!replacement.ok) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', replacement.code, replacement.error, {
      instructions: replacement.instructions,
      metrics: { durationMs: elapsed(started) },
    }));
  }

  const dataBase = {
    action: 'outline_edit' as const,
    affectedNodeIds: [params.nodeId],
    beforeOutline: currentOutline,
    afterOutline: replacement.afterOutline,
    revisions: { [params.nodeId]: currentRevision },
  };

  if (replacement.afterOutline === currentOutline) {
    const data: NodeEditData = { ...dataBase, status: 'unchanged' };
    return nodeToolResult(successEnvelope('node_edit', data, {
      status: 'unchanged',
      metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
    }), visibleEditResult(data, false, index));
  }

  const parsed = parseLinOutline(replacement.afterOutline, { annotations: 'allow' });
  if (!parsed.ok) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'parse_error', parsed.error.message, {
      instructions: `Fix new_string so the complete outline remains valid outline format. Line ${parsed.error.line}, column ${parsed.error.column}.`,
      metrics: { durationMs: elapsed(started) },
    }));
  }
  if (parsed.document.roots.length !== 1) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'ambiguous_root', 'node_edit must produce exactly one root node for the target node_id.', {
      instructions: 'Call node_create for new sibling roots, or edit a child node directly.',
      metrics: { durationMs: elapsed(started) },
    }));
  }
  const annotationValidation = validateEditAnnotations(index, params.nodeId, parsed.document);
  if (annotationValidation) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', annotationValidation.code, annotationValidation.error, {
      instructions: annotationValidation.instructions,
      metrics: { durationMs: elapsed(started) },
    }));
  }
  const referenceValidation = validateReferenceTargetIds(index, collectReferenceTargetIds(parsed.document));
  if (referenceValidation) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', referenceValidation.code, referenceValidation.error, {
      instructions: referenceValidation.instructions,
      metrics: { durationMs: elapsed(started) },
    }));
  }
  const fileReferenceValidation = validateLocalFileReferenceMarkers(options, parsed.document);
  if (fileReferenceValidation) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', fileReferenceValidation.code, fileReferenceValidation.error, {
      instructions: fileReferenceValidation.instructions,
      metrics: { durationMs: elapsed(started) },
    }));
  }
  const searchValidation = validateSearchNodes(index, parsed.document);
  if (searchValidation) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', searchValidation.code, searchValidation.error, {
      instructions: searchValidation.instructions,
      metrics: { durationMs: elapsed(started) },
    }));
  }
  if (parsed.document.roots[0]!.referenceTargetId) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'invalid_outline_root', 'Outline edits cannot turn the target root into a reference.', {
      instructions: 'Use node_edit with replace_with_reference_to for root reference replacement.',
      metrics: { durationMs: elapsed(started) },
    }));
  }

  if (params.previewOnly) {
    const data: NodeEditData = { ...dataBase, status: 'updated' };
    return nodeToolResult(successEnvelope('node_edit', data, {
      status: 'unchanged',
      warnings: parsed.warnings.length ? parsed.warnings : undefined,
      metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
    }), visibleEditResult(data, true, index));
  }

  const tracker = createMutationTracker();
  const warnings = [...parsed.warnings];
  const beforeProjection = index.projection;
  let trashedNodeIds: string[] = [];
  let updatedTags: string[] = [];
  try {
    const applied = await applyOutlineRootToExistingNode(host, params.nodeId, parsed.document.roots[0]!, tracker, warnings);
    trashedNodeIds = applied.trashedNodeIds;
    updatedTags = applied.updatedTagIds;
  } catch (error) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'mutation_failed', errorMessage(error), {
      instructions: 'Use node_read to refresh the target node, then retry a smaller exact replacement if needed.',
      metrics: { durationMs: elapsed(started) },
    }));
  }

  const updatedIndex = indexProjection(host.getProjection());
  const updatedNode = updatedIndex.nodes.get(params.nodeId);
  const changedIds = changedNodeIds(beforeProjection, updatedIndex.projection);
  const data: NodeEditData = {
    ...dataBase,
    status: 'updated',
    affectedNodeIds: unique([params.nodeId, ...changedIds, ...tracker.createdNodeIds, ...trashedNodeIds]),
    createdNodeIds: tracker.createdNodeIds.length ? tracker.createdNodeIds : undefined,
    trashedNodeIds: trashedNodeIds.length ? trashedNodeIds : undefined,
    matchedNodeIds: tracker.matchedNodeIds.length ? tracker.matchedNodeIds : undefined,
    updatedFields: tracker.createdFieldEntryIds.length ? tracker.createdFieldEntryIds : undefined,
    updatedTags: updatedTags.length ? updatedTags : undefined,
    revisions: updatedNode ? { [params.nodeId]: revisionOf(updatedNode) } : undefined,
  };
  return nodeToolResult(successEnvelope('node_edit', data, {
    warnings: warnings.length ? unique(warnings) : undefined,
    metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
  }), visibleEditResult(data, false, updatedIndex));
}

async function executeMoveEdit(
  host: OutlinerToolHost,
  params: Extract<NormalizedEditParams, { action: 'move' }>,
  started: number,
) {
  const index = indexProjection(host.getProjection());
  const validation = validateMutableNodeIds(index, params.nodeIds);
  if (validation) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', validation.code, validation.error, {
      instructions: validation.instructions,
      metrics: { durationMs: elapsed(started) },
    }));
  }

  const moveValidation = validateMoveRequest(index, params.nodeIds, params.move);
  if (moveValidation) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', moveValidation.code, moveValidation.error, {
      instructions: moveValidation.instructions,
      metrics: { durationMs: elapsed(started) },
    }));
  }

  const data: NodeEditData = {
    action: 'move',
    status: 'updated',
    affectedNodeIds: params.nodeIds,
    movedNodeIds: params.nodeIds,
    revisions: Object.fromEntries(params.nodeIds.map((nodeId) => [nodeId, revisionOf(requiredNode(index, nodeId))])),
  };

  if (params.previewOnly) {
    return nodeToolResult(successEnvelope('node_edit', data, {
      status: 'unchanged',
      metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
    }), visibleEditResult(data, true, index));
  }

  try {
    if (params.move.structuralAction) {
      await runStructuralMove(host, params.nodeIds, params.move.structuralAction);
    } else {
      await runAbsoluteMove(host, params.nodeIds, params.move);
    }
  } catch (error) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'mutation_failed', errorMessage(error), {
      instructions: 'Use node_read to refresh the source and destination ids before retrying.',
      metrics: { durationMs: elapsed(started) },
    }));
  }

  const updatedIndex = indexProjection(host.getProjection());
  data.revisions = Object.fromEntries(params.nodeIds
    .map((nodeId) => updatedIndex.nodes.get(nodeId))
    .filter((node): node is NodeProjection => Boolean(node))
    .map((node) => [node.id, revisionOf(node)]));
  return nodeToolResult(successEnvelope('node_edit', data, {
    metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
  }), visibleEditResult(data, false, updatedIndex));
}

async function executeMergeEdit(
  host: OutlinerToolHost,
  params: Extract<NormalizedEditParams, { action: 'merge' }>,
  started: number,
) {
  const index = indexProjection(host.getProjection());
  const nodeIds = [params.nodeId, ...params.mergeFromNodeIds];
  const validation = validateMutableNodeIds(index, nodeIds);
  if (validation) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', validation.code, validation.error, {
      instructions: validation.instructions,
      metrics: { durationMs: elapsed(started) },
    }));
  }
  if (params.mergeFromNodeIds.includes(params.nodeId)) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'invalid_merge', 'merge_from_node_ids cannot include the target node_id.', {
      instructions: 'Pass only duplicate/source nodes in merge_from_node_ids.',
      metrics: { durationMs: elapsed(started) },
    }));
  }
  const ancestorSource = params.mergeFromNodeIds.find((sourceId) => isDescendantOf(index, params.nodeId, sourceId));
  if (ancestorSource) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'invalid_merge', `Cannot merge ancestor ${ancestorSource} into descendant ${params.nodeId}.`, {
      instructions: 'Choose an ancestor as the merge target, or move content manually.',
      metrics: { durationMs: elapsed(started) },
    }));
  }

  const preview = mergePreview(index, params.nodeId, params.mergeFromNodeIds);
  const trashedFieldEntryIds = preview.mergedFields
    .filter((field) => field.mode === 'merged_values')
    .map((field) => field.sourceFieldEntryId);
  const data: NodeEditData = {
    action: 'merge',
    status: 'updated',
    affectedNodeIds: unique([
      ...nodeIds,
      ...preview.movedNodeIds,
      ...trashedFieldEntryIds,
      ...preview.redirectedReferenceIds,
    ]),
    trashedNodeIds: unique([...params.mergeFromNodeIds, ...trashedFieldEntryIds]),
    movedNodeIds: preview.movedNodeIds,
    merge: {
      targetNodeId: params.nodeId,
      sourceNodeIds: params.mergeFromNodeIds,
      movedChildren: preview.normalChildIds.length,
      mergedFields: preview.mergedFields,
      appliedTags: preview.tagIds.length,
      redirectedReferences: preview.redirectedReferenceIds.length,
    },
    revisions: { [params.nodeId]: revisionOf(requiredNode(index, params.nodeId)) },
  };

  if (params.previewOnly) {
    return nodeToolResult(successEnvelope('node_edit', data, {
      status: 'unchanged',
      warnings: ['Merge preview does not mutate. Source titles and descriptions are not appended to the target.'],
      metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
    }), visibleEditResult(data, true, index));
  }

  try {
    await runMerge(host, params.nodeId, params.mergeFromNodeIds);
  } catch (error) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'mutation_failed', errorMessage(error), {
      instructions: 'Use node_read to refresh the target and source ids, then retry.',
      metrics: { durationMs: elapsed(started) },
    }));
  }

  const updatedIndex = indexProjection(host.getProjection());
  const updatedNode = updatedIndex.nodes.get(params.nodeId);
  if (updatedNode) data.revisions = { [params.nodeId]: revisionOf(updatedNode) };
  return nodeToolResult(successEnvelope('node_edit', data, {
    warnings: ['Source titles and descriptions are not appended to the target; source nodes are preserved in Trash for undo/restore.'],
    metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
  }), visibleEditResult(data, false, updatedIndex));
}

async function executeReferenceReplaceEdit(
  host: OutlinerToolHost,
  params: Extract<NormalizedEditParams, { action: 'replace_with_reference' }>,
  started: number,
) {
  const index = indexProjection(host.getProjection());
  const validation = validateMutableNodeIds(index, [params.nodeId]);
  if (validation) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', validation.code, validation.error, {
      instructions: validation.instructions,
      metrics: { durationMs: elapsed(started) },
    }));
  }
  const targetValidation = validateReferenceTargetIds(index, [params.replaceWithReferenceTo]);
  if (targetValidation) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', targetValidation.code, targetValidation.error, {
      instructions: targetValidation.instructions,
      metrics: { durationMs: elapsed(started) },
    }));
  }
  if (params.nodeId === params.replaceWithReferenceTo) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'invalid_reference', 'A node cannot be replaced with a reference to itself.', {
      instructions: 'Choose a different target node id.',
      metrics: { durationMs: elapsed(started) },
    }));
  }
  const current = requiredNode(index, params.nodeId);
  const target = requiredNode(index, params.replaceWithReferenceTo);
  if (current.type === 'reference' && current.targetId === params.replaceWithReferenceTo) {
    const data: NodeEditData = {
      action: 'replace_with_reference',
      status: 'unchanged',
      affectedNodeIds: [params.nodeId],
      revisions: { [params.nodeId]: revisionOf(current) },
    };
    return nodeToolResult(successEnvelope('node_edit', data, {
      status: 'unchanged',
      metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
    }), visibleEditResult(data, false, index));
  }
  const retargetingReference = current.type === 'reference';

  const data: NodeEditData = {
    action: 'replace_with_reference',
    status: 'updated',
    affectedNodeIds: [params.nodeId, params.replaceWithReferenceTo],
    revisions: { [params.nodeId]: revisionOf(current), [params.replaceWithReferenceTo]: revisionOf(target) },
  };
  if (!retargetingReference) data.trashedNodeIds = [params.nodeId];

  if (params.previewOnly) {
    return nodeToolResult(successEnvelope('node_edit', data, {
      status: 'unchanged',
      metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
    }), visibleEditResult(data, true, index));
  }

  try {
    const createdReferenceId = focusFromOutcome(await host.handle('replace_node_with_reference', {
      nodeId: params.nodeId,
      targetId: params.replaceWithReferenceTo,
    }));
    if (!retargetingReference) data.createdNodeIds = [createdReferenceId];
    data.affectedNodeIds = unique([...data.affectedNodeIds, createdReferenceId]);
  } catch (error) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'mutation_failed', errorMessage(error), {
      instructions: 'Use node_read to refresh the node and target ids before retrying.',
      metrics: { durationMs: elapsed(started) },
    }));
  }

  return nodeToolResult(successEnvelope('node_edit', data, {
    metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
  }), visibleEditResult(data, false, indexProjection(host.getProjection())));
}

function createNodeCreateTool(host: OutlinerToolHost, options: NodeToolsOptions): AgentTool<any, ToolEnvelope<NodeCreateData>> {
  return {
    name: 'node_create',
    label: 'Node Create',
    description: NODE_CREATE_DESCRIPTION,
    parameters: NODE_CREATE_PARAMETERS,
    executionMode: 'sequential',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      const params = normalizeCreateParams(rawParams);
      if (params.error) {
        return nodeErrorResult(errorEnvelope('node_create', 'invalid_args', params.error, {
          instructions: 'Call node_create with exactly one of outline, target_id, or duplicate_id.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      const initialIndex = indexProjection(host.getProjection());
      const insertion = resolveInsertion(initialIndex, params);
      if ('error' in insertion) {
        return nodeErrorResult(errorEnvelope('node_create', insertion.code, insertion.error, {
          instructions: insertion.instructions,
          metrics: { durationMs: elapsed(started) },
        }));
      }

      if (params.targetId) {
        const targetValidation = validateReferenceTargetIds(initialIndex, [params.targetId]);
        if (targetValidation) {
          return nodeErrorResult(errorEnvelope('node_create', targetValidation.code, targetValidation.error, {
            instructions: targetValidation.instructions,
            metrics: { durationMs: elapsed(started) },
          }));
        }
        if (params.previewOnly) {
          const data: NodeCreateData = {
            parentId: insertion.parentId,
            afterId: insertion.afterId,
            createdRootIds: [],
            createdNodeIds: [],
            targetId: params.targetId,
          };
          return nodeToolResult(successEnvelope('node_create', data, {
            status: 'unchanged',
            metrics: { durationMs: elapsed(started) },
          }), visibleCreateResult(data, true, initialIndex));
        }
        try {
          const createdId = await addReference(host, insertion.parentId, params.targetId, insertion.index);
          const data: NodeCreateData = {
            parentId: insertion.parentId,
            afterId: insertion.afterId,
            createdRootIds: [createdId],
            createdNodeIds: [createdId],
            targetId: params.targetId,
          };
          return nodeToolResult(successEnvelope('node_create', data, {
            metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
          }), visibleCreateResult(data, false, indexProjection(host.getProjection())));
        } catch (error) {
          return nodeErrorResult(errorEnvelope('node_create', 'mutation_failed', errorMessage(error), {
            instructions: 'Check that the parent and reference target are valid and retry.',
            metrics: { durationMs: elapsed(started) },
          }));
        }
      }

      const outline = params.duplicateId
        ? duplicateOutline(initialIndex, params.duplicateId)
        : { ok: true as const, outline: params.outline! };
      if (!outline.ok) {
        return nodeErrorResult(errorEnvelope('node_create', outline.code, outline.error, {
          instructions: outline.instructions,
          metrics: { durationMs: elapsed(started) },
        }));
      }

      const parsed = parseLinOutline(outline.outline, { annotations: 'forbid' });
      if (!parsed.ok) {
        const instructions = parsed.error.code === 'invalid_annotation'
          ? `Remove all %%node:id%% markers before creating new nodes. Line ${parsed.error.line}, column ${parsed.error.column}.`
          : `Fix the outline so every non-empty line uses "- " and 2-space indentation. Line ${parsed.error.line}, column ${parsed.error.column}.`;
        return nodeErrorResult(errorEnvelope('node_create', parsed.error.code ?? 'parse_error', parsed.error.message, {
          instructions,
          metrics: { durationMs: elapsed(started) },
        }));
      }
      const referenceValidation = validateReferenceTargetIds(initialIndex, collectReferenceTargetIds(parsed.document));
      if (referenceValidation) {
        return nodeErrorResult(errorEnvelope('node_create', referenceValidation.code, referenceValidation.error, {
          instructions: referenceValidation.instructions,
          metrics: { durationMs: elapsed(started) },
        }));
      }
      const fileReferenceValidation = validateLocalFileReferenceMarkers(options, parsed.document);
      if (fileReferenceValidation) {
        return nodeErrorResult(errorEnvelope('node_create', fileReferenceValidation.code, fileReferenceValidation.error, {
          instructions: fileReferenceValidation.instructions,
          metrics: { durationMs: elapsed(started) },
        }));
      }
      const searchValidation = validateSearchNodes(initialIndex, parsed.document);
      if (searchValidation) {
        return nodeErrorResult(errorEnvelope('node_create', searchValidation.code, searchValidation.error, {
          instructions: searchValidation.instructions,
          metrics: { durationMs: elapsed(started) },
        }));
      }

      if (params.previewOnly) {
        const data: NodeCreateData = {
          parentId: insertion.parentId,
          afterId: insertion.afterId,
          createdRootIds: [],
          createdNodeIds: [],
          duplicatedFrom: params.duplicateId,
          outline: outline.outline,
        };
        return nodeToolResult(successEnvelope('node_create', data, {
          status: 'unchanged',
          warnings: parsed.warnings.length ? parsed.warnings : undefined,
          metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
        }), visibleCreateResult(data, true, initialIndex));
      }

      const tracker = createMutationTracker();
      const warnings = [...parsed.warnings];
      let insertIndex = insertion.index;
      try {
        for (const root of parsed.document.roots) {
          const createdId = await createOutlineNode(host, root, insertion.parentId, insertIndex, tracker, warnings);
          tracker.createdRootIds.push(createdId);
          if (insertIndex !== null) insertIndex += 1;
        }
      } catch (error) {
        return nodeErrorResult(errorEnvelope('node_create', 'mutation_failed', errorMessage(error), {
          instructions: 'Use node_read/node_search to verify node ids, references, and parent insertion point before retrying.',
          metrics: { durationMs: elapsed(started) },
        }));
      }
      const data: NodeCreateData = {
        parentId: insertion.parentId,
        afterId: insertion.afterId,
        createdRootIds: tracker.createdRootIds,
        createdNodeIds: tracker.createdNodeIds,
        createdFieldEntryIds: tracker.createdFieldEntryIds.length ? tracker.createdFieldEntryIds : undefined,
        createdTagIds: tracker.createdTagIds.length ? tracker.createdTagIds : undefined,
        createdFieldDefIds: tracker.createdFieldDefIds.length ? tracker.createdFieldDefIds : undefined,
        duplicatedFrom: params.duplicateId,
        outline: outline.outline,
      };
      return nodeToolResult(successEnvelope('node_create', data, {
        warnings: warnings.length ? unique(warnings) : undefined,
        metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
      }), visibleCreateResult(data, false, indexProjection(host.getProjection())));
    },
  };
}

function createNodeReadTool(host: OutlinerToolHost): AgentTool<any, ToolEnvelope<NodeReadData>> {
  return {
    name: 'node_read',
    label: 'Node Read',
    description: NODE_READ_DESCRIPTION,
    parameters: NODE_READ_PARAMETERS,
    executionMode: 'parallel',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      const params = normalizeReadParams(rawParams);
      if (params.error) {
        return nodeErrorResult(errorEnvelope('node_read', 'invalid_args', params.error, {
          instructions: 'Call node_read with either node_id or node_ids, not both.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      const index = indexProjection(host.getProjection());
      const nodeIds = params.nodeIds ?? [params.nodeId ?? index.projection.todayId];
      const missing = nodeIds.find((nodeId) => !index.nodes.has(nodeId));
      if (missing) {
        return nodeErrorResult(errorEnvelope('node_read', 'node_not_found', `Node not found: ${missing}`, {
          instructions: 'Use node_search to locate the current node id.',
          metrics: { durationMs: elapsed(started) },
        }));
      }
      const deleted = nodeIds.find((nodeId) => !params.includeDeleted && isInTrash(index, nodeId));
      if (deleted) {
        return nodeErrorResult(errorEnvelope('node_read', 'node_in_trash', `Node is in Trash: ${deleted}`, {
          instructions: 'Call node_read with include_deleted true if you intentionally need Trash content.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      const data: NodeReadData = { items: nodeIds.map((nodeId) => buildReadItem(index, nodeId, params)) };
      const visible = visibleReadResult(index, nodeIds, params);
      return nodeToolResult(successEnvelope('node_read', data, {
        metrics: {
          durationMs: elapsed(started),
          truncated: data.items.some((item) => pageHasMore(item.children)),
          outputBytes: jsonByteLength(data),
        },
      }), visible);
    },
  };
}

function createNodeSearchTool(host: OutlinerToolHost): AgentTool<any, ToolEnvelope<NodeSearchData>> {
  return {
    name: 'node_search',
    label: 'Node Search',
    description: NODE_SEARCH_DESCRIPTION,
    parameters: NODE_SEARCH_PARAMETERS,
    executionMode: 'parallel',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      const params = normalizeSearchParams(rawParams);
      if (params.error) {
        return nodeErrorResult(errorEnvelope('node_search', 'invalid_args', params.error, {
          instructions: 'Call node_search with exactly one of outline or search_node_id.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      const index = indexProjection(host.getProjection());
      const offset = clampInteger(params.offset, 0, Number.MAX_SAFE_INTEGER, 0);
      const limit = clampInteger(params.limit, 1, 50, 20);
      const search = resolveSearch(index, params);
      if ('error' in search) {
        return nodeErrorResult(errorEnvelope('node_search', search.code, search.error, {
          instructions: search.instructions,
          metrics: { durationMs: elapsed(started) },
        }));
      }

      if (
        !search.hasExecutableRules
      ) {
        return nodeErrorResult(errorEnvelope('node_search', 'empty_search', 'Search has no executable terms.', {
          instructions: 'Add at least one executable rule such as STRING_MATCH value:: text, HAS_TAG tag:: [[node:#tag^...]], DONE, or DONE_LAST_DAYS value:: 7.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      const resultIds = runSearch(index, search, {
        textIndex: host.getTextSearchIndex?.(),
        rankingOptions: host.getSearchRankingOptions?.(),
      });
      if ('error' in resultIds) {
        return nodeErrorResult(errorEnvelope('node_search', resultIds.code, resultIds.error, {
          instructions: resultIds.instructions,
          metrics: { durationMs: elapsed(started) },
        }));
      }
      const total = resultIds.length;
      const pageIds = resultIds.slice(offset, offset + limit);
      const items = params.count ? undefined : pageIds.map((nodeId) => buildSearchItem(index, nodeId, search.queryTerms));
      if (!params.count) await host.recordNodeAccess?.(pageIds, 'agentRecall');
      const data: NodeSearchData = {
        source: search.source,
        title: search.title,
        view: search.view,
        searchNodeId: search.searchNodeId,
        outline: search.outline,
        total,
        offset,
        limit,
        items,
      };
      const visible = visibleSearchResult(index, data, params.count);

      return nodeToolResult(successEnvelope('node_search', data, {
        instructions: offset + limit < total ? `Call node_search with offset ${offset + limit} to continue.` : undefined,
        warnings: search.warnings.length ? search.warnings : undefined,
        metrics: {
          durationMs: elapsed(started),
          truncated: offset + limit < total,
          outputBytes: jsonByteLength(data),
        },
      }), visible);
    },
  };
}

function normalizeCreateParams(rawParams: unknown): NodeCreateParams & { error?: string } {
  const input = asRecord(rawParams);
  const parentId = typeof input.parent_id === 'string' && input.parent_id.trim() ? input.parent_id.trim() : undefined;
  const afterId = input.after_id === null
    ? null
    : typeof input.after_id === 'string' && input.after_id.trim()
      ? input.after_id.trim()
      : undefined;
  const outline = typeof input.outline === 'string' && input.outline.trim() ? input.outline.trim() : undefined;
  const targetId = typeof input.target_id === 'string' && input.target_id.trim() ? input.target_id.trim() : undefined;
  const duplicateId = typeof input.duplicate_id === 'string' && input.duplicate_id.trim() ? input.duplicate_id.trim() : undefined;
  const provided = [outline, targetId, duplicateId].filter(Boolean).length;
  return {
    parentId,
    afterId,
    outline,
    targetId,
    duplicateId,
    previewOnly: input.preview_only === true,
    error: provided === 1 ? undefined : 'Exactly one of outline, target_id, or duplicate_id is required.',
  };
}

function normalizeDeleteParams(rawParams: unknown): NodeDeleteParams & { error?: string } {
  const input = asRecord(rawParams);
  const nodeId = typeof input.node_id === 'string' && input.node_id.trim() ? input.node_id.trim() : undefined;
  const nodeIds = Array.isArray(input.node_ids)
    ? unique(input.node_ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim()))
    : undefined;
  return {
    nodeId,
    nodeIds,
    restore: input.restore === true,
    previewOnly: input.preview_only === true,
    error: nodeId && nodeIds ? 'Use either node_id or node_ids, not both.' : !nodeId && !nodeIds ? 'node_id or node_ids is required.' : undefined,
  };
}

function normalizeEditParams(rawParams: unknown): NormalizedEditParams {
  const input = asRecord(rawParams);
  const nodeId = typeof input.node_id === 'string' && input.node_id.trim() ? input.node_id.trim() : undefined;
  const nodeIds = Array.isArray(input.node_ids)
    ? unique(input.node_ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim()))
    : undefined;
  const oldString = typeof input.old_string === 'string' ? normalizeLineEndings(input.old_string) : undefined;
  const newString = typeof input.new_string === 'string' ? normalizeLineEndings(input.new_string) : undefined;
  const expectedRevision = typeof input.expected_revision === 'string' && input.expected_revision.trim() ? input.expected_revision.trim() : undefined;
  const move = normalizeMoveParams(input.move);
  const mergeFromNodeIds = Array.isArray(input.merge_from_node_ids)
    ? unique(input.merge_from_node_ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim()))
    : undefined;
  const replaceWithReferenceTo = typeof input.replace_with_reference_to === 'string' && input.replace_with_reference_to.trim()
    ? input.replace_with_reference_to.trim()
    : undefined;
  const previewOnly = input.preview_only === true;

  const outlineAction = Boolean(nodeId && oldString !== undefined && newString !== undefined);
  const moveAction = Boolean(move !== undefined && (nodeId || nodeIds));
  const mergeAction = Boolean(nodeId && mergeFromNodeIds !== undefined);
  const referenceAction = Boolean(nodeId && replaceWithReferenceTo !== undefined);
  const provided = [outlineAction, moveAction, mergeAction, referenceAction].filter(Boolean).length;
  if (provided !== 1) return { error: 'Exactly one node_edit action is required.' };
  if (nodeId && nodeIds && !moveAction) return { error: 'node_ids is only valid for move actions.' };
  if (nodeId && nodeIds && moveAction) return { error: 'Use either node_id or node_ids for move actions, not both.' };

  if (outlineAction) {
    return { action: 'outline_edit', nodeId: nodeId!, oldString: oldString!, newString: newString!, expectedRevision, previewOnly };
  }
  if (moveAction) {
    return { action: 'move', nodeId, nodeIds: nodeIds ?? [nodeId!], move: move!, previewOnly };
  }
  if (mergeAction) {
    return { action: 'merge', nodeId: nodeId!, mergeFromNodeIds: mergeFromNodeIds!, previewOnly };
  }
  return { action: 'replace_with_reference', nodeId: nodeId!, replaceWithReferenceTo: replaceWithReferenceTo!, previewOnly };
}

function normalizeOperationHistoryParams(rawParams: unknown): Required<Pick<OperationHistoryParams, 'action' | 'steps' | 'origin' | 'limit' | 'offset'>>
  & Pick<OperationHistoryParams, 'operationId'>
  & { error?: string } {
  const input = asRecord(rawParams);
  const action = input.action === undefined
    ? 'list'
    : input.action === 'list' || input.action === 'undo' || input.action === 'redo'
      ? input.action
      : undefined;
  const defaultOrigin = action === 'list' ? 'all' : 'agent';
  const origin = input.origin === 'agent' || input.origin === 'user' || input.origin === 'all' ? input.origin : defaultOrigin;
  const operationId = typeof input.operation_id === 'string' && input.operation_id.trim() ? input.operation_id.trim() : undefined;
  return {
    action: action ?? 'list',
    steps: clampInteger(input.steps, 1, 10, 1),
    operationId,
    origin,
    limit: clampInteger(input.limit, 1, 100, 20),
    offset: clampInteger(input.offset, 0, Number.MAX_SAFE_INTEGER, 0),
    error: action ? undefined : 'action must be "list", "undo", or "redo".',
  };
}

function normalizeMoveParams(value: unknown): NodeEditMoveParams | undefined {
  const input = asRecord(value);
  if (Object.keys(input).length === 0) return undefined;
  const parentId = typeof input.parent_id === 'string' && input.parent_id.trim() ? input.parent_id.trim() : undefined;
  const afterId = input.after_id === null
    ? null
    : typeof input.after_id === 'string' && input.after_id.trim()
      ? input.after_id.trim()
      : undefined;
  const structuralAction = input.structural_action === 'indent'
    || input.structural_action === 'outdent'
    || input.structural_action === 'move_up'
    || input.structural_action === 'move_down'
    ? input.structural_action
    : undefined;
  return { parentId, afterId, structuralAction };
}

function resolveInsertion(index: ProjectionIndex, params: NodeCreateParams): {
  parentId: string;
  afterId?: string | null;
  index: number | null;
} | { code: string; error: string; instructions: string } {
  if (params.afterId === null) {
    const parentId = params.parentId ?? index.projection.todayId;
    if (!index.nodes.has(parentId)) return parentNotFound(parentId);
    return { parentId, afterId: null, index: 0 };
  }
  if (params.afterId) {
    const after = index.nodes.get(params.afterId);
    if (!after) return { code: 'node_not_found', error: `after_id not found: ${params.afterId}`, instructions: 'Use node_read on the parent to find a current sibling id.' };
    if (!after.parentId) return { code: 'invalid_insertion', error: `after_id has no parent: ${params.afterId}`, instructions: 'Pass an explicit parent_id and omit after_id.' };
    const parentId = params.parentId ?? after.parentId;
    if (parentId !== after.parentId) {
      return { code: 'invalid_insertion', error: `after_id ${params.afterId} is not a child of parent_id ${parentId}`, instructions: 'Use either after_id alone or pass the matching parent_id.' };
    }
    const parent = index.nodes.get(parentId);
    if (!parent) return parentNotFound(parentId);
    const childIndex = parent.children.indexOf(params.afterId);
    return { parentId, afterId: params.afterId, index: childIndex >= 0 ? childIndex + 1 : null };
  }
  const parentId = params.parentId ?? index.projection.todayId;
  if (!index.nodes.has(parentId)) return parentNotFound(parentId);
  return { parentId, index: null };
}

function validateMutableNodeIds(index: ProjectionIndex, nodeIds: string[]): { code: string; error: string; instructions: string } | null {
  const missing = nodeIds.find((nodeId) => !index.nodes.has(nodeId));
  if (missing) return { code: 'node_not_found', error: `Node not found: ${missing}`, instructions: 'Use node_search or node_read to locate the current node id.' };
  const system = nodeIds.find((nodeId) => isSystemNodeId(nodeId));
  if (system) return { code: 'locked_node', error: `System node cannot be edited: ${system}`, instructions: 'Choose a user-created node.' };
  const locked = nodeIds.find((nodeId) => index.nodes.get(nodeId)?.locked);
  if (locked) return { code: 'locked_node', error: `Locked node cannot be edited: ${locked}`, instructions: 'Choose an editable node.' };
  const trashed = nodeIds.find((nodeId) => isInTrash(index, nodeId));
  if (trashed) return { code: 'node_in_trash', error: `Node is in Trash: ${trashed}`, instructions: 'Restore the node before editing it.' };
  return null;
}

function replaceOutline(currentOutline: string, oldString: string, newString: string): {
  ok: true;
  afterOutline: string;
} | { ok: false; code: string; error: string; instructions: string } {
  const normalizedOld = normalizeLineEndings(oldString);
  const normalizedNew = normalizeLineEndings(newString);
  if (normalizedOld === '*') return { ok: true, afterOutline: normalizedNew.trim() };
  const matches = countOccurrences(currentOutline, normalizedOld);
  if (matches === 0) {
    return {
      ok: false,
      code: 'old_string_not_found',
      error: 'old_string did not match the current annotated outline.',
      instructions: 'Call node_read again and copy an exact fragment from data.outline.',
    };
  }
  if (matches > 1) {
    return {
      ok: false,
      code: 'old_string_not_unique',
      error: `old_string matched ${matches} times in the current annotated outline.`,
      instructions: 'Include more surrounding context or edit the intended child node directly by node_id.',
    };
  }
  return { ok: true, afterOutline: currentOutline.replace(normalizedOld, normalizedNew) };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

async function applyOutlineRootToExistingNode(
  host: OutlinerToolHost,
  nodeId: string,
  root: OutlineNode,
  tracker: MutationTracker,
  warnings: string[],
): Promise<{ trashedNodeIds: string[]; updatedTagIds: string[] }> {
  if (root.search) {
    const spec = resolveSearchSpecFromOutlineNode(indexProjection(host.getProjection()), root);
    if ('error' in spec) throw new Error(spec.error);
    warnings.push(...spec.warnings);
    await host.handle('set_search_node', {
      nodeId,
      config: searchNodeConfigFromSpec(spec),
    });
    await applySearchViewSpec(host, nodeId, spec.view);
    const current = indexProjection(host.getProjection()).nodes.get(nodeId);
    if ((current?.description ?? null) !== (root.description ?? null)) {
      await host.handle('update_node_description', { nodeId, description: root.description ?? null });
    }
    await setCheckboxState(host, nodeId, root.checked);
    const updatedTagIds = await syncTags(host, nodeId, root.tags, tracker);
    return { trashedNodeIds: [], updatedTagIds };
  }
  if (root.view) warnings.push('View directives are only persisted on search nodes today.');

  const updatedTagIds = await syncOutlineNodeInPlace(host, nodeId, root, tracker, warnings);
  const fieldSync = await syncFieldEntries(host, nodeId, root.fields, tracker, warnings);
  const childSync = await syncNormalChildren(host, nodeId, root.children, tracker, warnings);
  return { trashedNodeIds: unique([...fieldSync.trashedNodeIds, ...childSync.trashedNodeIds]), updatedTagIds };
}

async function syncOutlineNodeInPlace(
  host: OutlinerToolHost,
  nodeId: string,
  node: OutlineNode,
  tracker: MutationTracker,
  warnings: string[],
): Promise<string[]> {
  if (node.search) {
    const spec = resolveSearchSpecFromOutlineNode(indexProjection(host.getProjection()), node);
    if ('error' in spec) throw new Error(spec.error);
    warnings.push(...spec.warnings);
    await host.handle('set_search_node', {
      nodeId,
      config: searchNodeConfigFromSpec(spec),
    });
    await applySearchViewSpec(host, nodeId, spec.view);
    const latest = indexProjection(host.getProjection());
    const current = requiredNode(latest, nodeId);
    trackMatchedNode(tracker, nodeId);
    if ((current.description ?? null) !== (node.description ?? null)) {
      await host.handle('update_node_description', { nodeId, description: node.description ?? null });
    }
    await setCheckboxState(host, nodeId, node.checked);
    return syncTags(host, nodeId, node.tags, tracker);
  }
  if (node.view) warnings.push('View directives are only persisted on search nodes today.');

  const currentIndex = indexProjection(host.getProjection());
  const current = requiredNode(currentIndex, nodeId);
  if (current.type === 'reference') throw new Error('Outline edit cannot update a reference node root; use replace_with_reference_to.');
  trackMatchedNode(tracker, nodeId);
  if (current.content.text !== node.title) {
    await host.handle('apply_node_text_patch', { nodeId, patch: replaceAllRichTextPatch(plainText(node.title)) });
  }
  if ((current.description ?? null) !== (node.description ?? null)) {
    await host.handle('update_node_description', { nodeId, description: node.description ?? null });
  }
  await setCheckboxState(host, nodeId, node.checked);
  return syncTags(host, nodeId, node.tags, tracker);
}

async function syncFieldEntries(
  host: OutlinerToolHost,
  parentId: string,
  fields: OutlineField[],
  tracker: MutationTracker,
  warnings: string[],
): Promise<{ trashedNodeIds: string[] }> {
  const index = indexProjection(host.getProjection());
  const existingFieldIds = requiredNode(index, parentId).children.filter((childId) => {
    const child = index.nodes.get(childId);
    return child?.type === 'fieldEntry' && !isInTrash(index, childId);
  });
  const misplacedAnnotatedField = fields.find((field) => field.nodeId && !existingFieldIds.includes(field.nodeId));
  if (misplacedAnnotatedField?.nodeId) {
    throw new Error(`Annotated field id is not a field under ${parentId}: ${misplacedAnnotatedField.nodeId}`);
  }
  const plan = sequenceEditPlan(
    existingFieldIds,
    fields,
    (fieldEntryId, field) => field.nodeId === fieldEntryId,
  );
  pushDuplicateKeyWarning('field entries', existingFieldIds.map((fieldEntryId) => fieldName(index, requiredNode(index, fieldEntryId)).toLowerCase()), warnings);
  pushDuplicateKeyWarning('desired field names', fields.map((field) => field.name.trim().toLowerCase()), warnings);
  const trashedNodeIds: string[] = [];
  let desiredIndex = 0;
  for (const item of plan) {
    if (item.existing && item.desired) {
      const latest = indexProjection(host.getProjection());
      const currentName = fieldName(latest, requiredNode(latest, item.existing)).trim().toLowerCase();
      if (currentName === item.desired.name.trim().toLowerCase()) {
        trackMatchedNode(tracker, item.existing);
        await ensureAbsoluteChildIndex(host, item.existing, parentId, desiredIndex);
        await syncFieldValues(host, item.existing, item.desired, tracker, warnings);
      } else {
        await trashNodeIds(host, [item.existing]);
        trashedNodeIds.push(item.existing);
        const createdId = await createField(host, parentId, item.desired, tracker, desiredIndex);
        await ensureAbsoluteChildIndex(host, createdId, parentId, desiredIndex);
      }
      desiredIndex += 1;
      continue;
    }
    if (item.existing) {
      await trashNodeIds(host, [item.existing]);
      trashedNodeIds.push(item.existing);
      continue;
    }
    if (item.desired) {
      const createdId = await createField(host, parentId, item.desired, tracker, desiredIndex);
      await ensureAbsoluteChildIndex(host, createdId, parentId, desiredIndex);
      desiredIndex += 1;
    }
  }
  return { trashedNodeIds };
}

async function syncFieldValues(
  host: OutlinerToolHost,
  fieldEntryId: string,
  field: OutlineField,
  tracker: MutationTracker,
  warnings: string[],
) {
  const index = indexProjection(host.getProjection());
  const normalizedField = normalizeFieldValuesForEntry(index, fieldEntryId, field);
  const existingValueIds = [...requiredNode(index, fieldEntryId).children].filter((childId) => !isInTrash(index, childId));
  const desiredValues = normalizedField.clear ? [] : normalizedField.values;
  const misplacedAnnotatedValue = desiredValues.find((value) => value.nodeId && !existingValueIds.includes(value.nodeId));
  if (misplacedAnnotatedValue?.nodeId) {
    throw new Error(`Annotated field value id is not a value under ${fieldEntryId}: ${misplacedAnnotatedValue.nodeId}`);
  }
  const plan = sequenceEditPlan(
    existingValueIds,
    desiredValues,
    (valueId, value) => value.nodeId === valueId,
  );
  pushDuplicateKeyWarning('field values', existingValueIds.map((valueId) => outlineValueKeyFromProjection(index, requiredNode(index, valueId))), warnings);
  pushDuplicateKeyWarning('desired field values', desiredValues.map(outlineValueKey), warnings);
  let desiredIndex = 0;
  for (const item of plan) {
    if (item.existing && item.desired) {
      const latest = indexProjection(host.getProjection());
      const current = requiredNode(latest, item.existing);
      if (canUpdateValueInPlace(current, item.desired)) {
        trackMatchedNode(tracker, item.existing);
        await ensureAbsoluteChildIndex(host, item.existing, fieldEntryId, desiredIndex);
        if (current.content.text !== item.desired.text) {
          await host.handle('apply_node_text_patch', {
            nodeId: item.existing,
            patch: replaceAllRichTextPatch(plainText(item.desired.text)),
          });
        }
      } else {
        await trashNodeIds(host, [item.existing]);
        const createdId = await createFieldValue(host, fieldEntryId, item.desired, desiredIndex);
        tracker.createdNodeIds.push(createdId);
      }
      desiredIndex += 1;
      continue;
    }
    if (item.existing) {
      await trashNodeIds(host, [item.existing]);
      continue;
    }
    if (item.desired) {
      const createdId = await createFieldValue(host, fieldEntryId, item.desired, desiredIndex);
      tracker.createdNodeIds.push(createdId);
      desiredIndex += 1;
    }
  }
}

function normalizeFieldValuesForEntry(index: ProjectionIndex, fieldEntryId: string, field: OutlineField): OutlineField {
  if (field.clear) return field;
  if (fieldTypeForEntry(index, fieldEntryId) !== 'date') return field;

  return {
    ...field,
    values: field.values.map((value) => normalizeDateOutlineValue(field.name, value)),
  };
}

function normalizeDateOutlineValue(fieldName: string, value: OutlineValue): OutlineValue {
  if (value.targetId) {
    throw new Error(`Invalid date field value for "${fieldName}": date fields use text values, not node references. Use YYYY-MM-DD, YYYY-MM-DDTHH:mm, or start/end with "/" such as 2026-05-20/2026-05-24.`);
  }
  const normalized = normalizeDateFieldValue(value.text);
  if (!normalized) {
    throw new Error(`Invalid date field value for "${fieldName}": ${value.text}. Use YYYY-MM-DD, YYYY-MM-DDTHH:mm, or start/end with "/" such as 2026-05-20/2026-05-24.`);
  }
  return normalized === value.text ? value : { ...value, text: normalized };
}

function fieldTypeForEntry(index: ProjectionIndex, fieldEntryId: string): string {
  const fieldEntry = requiredNode(index, fieldEntryId);
  const fieldDefId = fieldEntry.type === 'fieldEntry' ? fieldEntry.fieldDefId : undefined;
  const fieldDef = fieldDefId ? index.nodes.get(fieldDefId) : undefined;
  return fieldDef?.type === 'fieldDef' ? projectFieldConfig(index.nodes, fieldDef).fieldType : 'plain';
}

async function syncNormalChildren(
  host: OutlinerToolHost,
  parentId: string,
  desiredChildren: OutlineNode[],
  tracker: MutationTracker,
  warnings: string[],
): Promise<{ trashedNodeIds: string[] }> {
  const index = indexProjection(host.getProjection());
  const existingChildIds = normalChildIds(index, parentId, false);
  const misplacedAnnotatedChild = desiredChildren.find((child) => child.nodeId && !existingChildIds.includes(child.nodeId));
  if (misplacedAnnotatedChild?.nodeId) {
    throw new Error(`Annotated child id is not a child under ${parentId}: ${misplacedAnnotatedChild.nodeId}`);
  }
  const plan = sequenceEditPlan(
    existingChildIds,
    desiredChildren,
    (childId, child) => child.nodeId === childId,
  );
  pushDuplicateKeyWarning('child nodes', existingChildIds.map((childId) => outlineNodeKeyFromProjection(index, requiredNode(index, childId))), warnings);
  pushDuplicateKeyWarning('desired child nodes', desiredChildren.map(outlineNodeKey), warnings);
  const trashedNodeIds: string[] = [];
  let desiredNormalIndex = 0;
  for (const item of plan) {
    if (item.existing && item.desired) {
      const latest = indexProjection(host.getProjection());
      const current = requiredNode(latest, item.existing);
      const targetIndex = absoluteIndexForNormalChild(latest, parentId, desiredNormalIndex);
      if (canUpdateOutlineNodeInPlace(current, item.desired)) {
        trackMatchedNode(tracker, item.existing);
        await ensureAbsoluteChildIndex(host, item.existing, parentId, targetIndex);
        await syncOutlineNodeInPlace(host, item.existing, item.desired, tracker, warnings);
        if (item.desired.search) {
          desiredNormalIndex += 1;
          continue;
        }
        const fieldSync = await syncFieldEntries(host, item.existing, item.desired.fields, tracker, warnings);
        const childSync = await syncNormalChildren(host, item.existing, item.desired.children, tracker, warnings);
        trashedNodeIds.push(...fieldSync.trashedNodeIds, ...childSync.trashedNodeIds);
      } else {
        await trashNodeIds(host, [item.existing]);
        trashedNodeIds.push(item.existing);
        await createOutlineNode(host, item.desired, parentId, targetIndex, tracker, warnings);
      }
      desiredNormalIndex += 1;
      continue;
    }
    if (item.existing) {
      await trashNodeIds(host, [item.existing]);
      trashedNodeIds.push(item.existing);
      continue;
    }
    if (item.desired) {
      const targetIndex = absoluteIndexForNormalChild(indexProjection(host.getProjection()), parentId, desiredNormalIndex);
      await createOutlineNode(host, item.desired, parentId, targetIndex, tracker, warnings);
      desiredNormalIndex += 1;
    }
  }
  return { trashedNodeIds };
}

interface SequenceEditItem<TExisting, TDesired> {
  existing?: TExisting;
  desired?: TDesired;
}

function sequenceEditPlan<TExisting, TDesired>(
  existing: TExisting[],
  desired: TDesired[],
  matches: (existing: TExisting, desired: TDesired) => boolean,
): Array<SequenceEditItem<TExisting, TDesired>> {
  const result: Array<SequenceEditItem<TExisting, TDesired>> = [];
  const usedExisting = new Set<number>();

  for (const desiredItem of desired) {
    let matchedIndex = -1;
    for (let index = 0; index < existing.length; index += 1) {
      if (usedExisting.has(index)) continue;
      if (!matches(existing[index]!, desiredItem)) continue;
      matchedIndex = index;
      break;
    }
    if (matchedIndex === -1) {
      result.push({ desired: desiredItem });
      continue;
    }
    usedExisting.add(matchedIndex);
    result.push({ existing: existing[matchedIndex], desired: desiredItem });
  }

  existing.forEach((existingItem, index) => {
    if (!usedExisting.has(index)) result.push({ existing: existingItem });
  });

  return result;
}

function outlineNodeKeyFromProjection(index: ProjectionIndex, node: NodeProjection): string {
  if (node.type === 'reference') return `reference:${node.targetId ?? ''}`;
  return `node:${node.content.text.trim().toLowerCase()}`;
}

function outlineNodeKey(node: OutlineNode): string {
  if (node.referenceTargetId) return `reference:${node.referenceTargetId}`;
  return `node:${node.title.trim().toLowerCase()}`;
}

function outlineValueKeyFromProjection(index: ProjectionIndex, node: NodeProjection): string {
  if (node.type === 'reference') return `reference:${node.targetId ?? ''}`;
  return `value:${nodeTitle(index, node).trim().toLowerCase()}`;
}

function outlineValueKey(value: OutlineValue): string {
  if (value.targetId) return `reference:${value.targetId}`;
  return `value:${value.text.trim().toLowerCase()}`;
}

function canUpdateOutlineNodeInPlace(current: NodeProjection, desired: OutlineNode): boolean {
  if (desired.referenceTargetId) {
    return current.type === 'reference' && current.targetId === desired.referenceTargetId;
  }
  return current.type !== 'reference' && current.type !== 'fieldEntry';
}

function canUpdateValueInPlace(current: NodeProjection, desired: OutlineValue): boolean {
  if (desired.targetId) return current.type === 'reference' && current.targetId === desired.targetId;
  return current.type !== 'reference';
}

function trackMatchedNode(tracker: MutationTracker, nodeId: string) {
  if (!tracker.matchedNodeIds.includes(nodeId)) tracker.matchedNodeIds.push(nodeId);
}

function pushDuplicateKeyWarning(label: string, keys: string[], warnings: string[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const key of keys) {
    if (!key) continue;
    if (seen.has(key)) duplicates.add(key);
    else seen.add(key);
  }
  if (duplicates.size > 0) {
    warnings.push(`Duplicate ${label} were matched by order: ${[...duplicates].join(', ')}.`);
  }
}

function absoluteIndexForNormalChild(index: ProjectionIndex, parentId: string, normalIndex: number): number {
  const parent = requiredNode(index, parentId);
  const fieldCount = parent.children.filter((childId) => index.nodes.get(childId)?.type === 'fieldEntry' && !isInTrash(index, childId)).length;
  return fieldCount + normalIndex;
}

async function ensureAbsoluteChildIndex(host: OutlinerToolHost, nodeId: string, parentId: string, index: number) {
  const latest = indexProjection(host.getProjection());
  const node = requiredNode(latest, nodeId);
  const parent = requiredNode(latest, parentId);
  if (node.parentId !== parentId || parent.children.indexOf(nodeId) !== index) {
    await host.handle('move_node', { nodeId, parentId, index });
  }
}

async function trashNodeIds(host: OutlinerToolHost, nodeIds: string[]) {
  const uniqueNodeIds = unique(nodeIds);
  if (uniqueNodeIds.length === 0) return;
  if (uniqueNodeIds.length === 1) await host.handle('trash_node', { nodeId: uniqueNodeIds[0] });
  else await host.handle('batch_trash_nodes', { nodeIds: uniqueNodeIds });
}

async function setCheckboxState(host: OutlinerToolHost, nodeId: string, checked: boolean | null | undefined) {
  const index = indexProjection(host.getProjection());
  const current = index.nodes.get(nodeId);
  if (!current) throw new Error(`Node not found: ${nodeId}`);
  const isCompleted = nodeIsDone(current);
  if (checked === true) {
    if (!nodeShowsCheckbox(index.nodes, current)) await host.handle('set_node_checkbox_visible', { nodeId, visible: true });
    if (!isCompleted) await host.handle('toggle_done', { nodeId });
    return;
  }
  if (checked === false) {
    if (isCompleted) await host.handle('toggle_done', { nodeId });
    const latestIndex = indexProjection(host.getProjection());
    const latest = latestIndex.nodes.get(nodeId);
    if (!latest || !nodeShowsCheckbox(latestIndex.nodes, latest)) await host.handle('set_node_checkbox_visible', { nodeId, visible: true });
    return;
  }
  if (isCompleted) await host.handle('toggle_done', { nodeId });
  const latestIndex = indexProjection(host.getProjection());
  const latest = latestIndex.nodes.get(nodeId);
  if (latest && nodeShowsCheckbox(latestIndex.nodes, latest)) await host.handle('set_node_checkbox_visible', { nodeId, visible: false });
}

async function syncTags(host: OutlinerToolHost, nodeId: string, tagNames: string[], tracker: MutationTracker): Promise<string[]> {
  const desiredTagIds: string[] = [];
  for (const tagName of tagNames) {
    const before = indexProjection(host.getProjection());
    const existing = findTagByName(before, tagName);
    const tagId = existing?.id ?? focusFromOutcome(await host.handle('create_tag', { name: tagName }));
    if (!existing) tracker.createdTagIds.push(tagId);
    desiredTagIds.push(tagId);
  }

  const latest = indexProjection(host.getProjection());
  const currentTagIds = latest.nodes.get(nodeId)?.tags ?? [];
  const desired = new Set(desiredTagIds);
  const updated: string[] = [];
  for (const tagId of currentTagIds) {
    if (!desired.has(tagId)) {
      await host.handle('remove_tag', { nodeId, tagId });
      updated.push(tagId);
    }
  }
  for (const tagId of desiredTagIds) {
    if (!currentTagIds.includes(tagId)) {
      await host.handle('apply_tag', { nodeId, tagId });
      updated.push(tagId);
    }
  }
  return unique(updated);
}

function validateMoveRequest(index: ProjectionIndex, nodeIds: string[], move: NodeEditMoveParams): { code: string; error: string; instructions: string } | null {
  if (move.structuralAction) {
    if (move.parentId || move.afterId !== undefined) {
      return { code: 'invalid_move', error: 'structural_action cannot be combined with parent_id or after_id.', instructions: 'Use either a structural action or an absolute destination.' };
    }
    return null;
  }
  if (!move.parentId && move.afterId === undefined) {
    return { code: 'invalid_move', error: 'Absolute moves require parent_id, after_id, or both.', instructions: 'Pass move.parent_id to append under a parent, or move.after_id to insert after a sibling.' };
  }
  if (move.afterId && nodeIds.includes(move.afterId)) {
    return { code: 'invalid_move', error: 'after_id cannot be one of the moved nodes.', instructions: 'Choose a stable sibling outside the moved selection.' };
  }
  const after = move.afterId ? index.nodes.get(move.afterId) : undefined;
  if (move.afterId && !after) {
    return { code: 'node_not_found', error: `after_id not found: ${move.afterId}`, instructions: 'Use node_read to refresh destination sibling ids.' };
  }
  const parentId = move.parentId ?? after?.parentId;
  if (!parentId) return { code: 'invalid_move', error: 'Destination parent could not be resolved.', instructions: 'Pass move.parent_id explicitly.' };
  const parent = index.nodes.get(parentId);
  if (!parent) return parentNotFound(parentId);
  if (isInTrash(index, parentId)) return { code: 'node_in_trash', error: `Destination parent is in Trash: ${parentId}`, instructions: 'Choose a non-deleted destination parent.' };
  if (move.afterId && !parent.children.includes(move.afterId)) {
    return { code: 'invalid_move', error: `after_id ${move.afterId} is not a child of destination parent ${parentId}.`, instructions: 'Pass the matching parent_id or omit parent_id.' };
  }
  const cycleNodeId = nodeIds.find((nodeId) => parentId === nodeId || isDescendantOf(index, parentId, nodeId));
  if (cycleNodeId) {
    return { code: 'invalid_move', error: `Cannot move ${cycleNodeId} under itself or one of its descendants.`, instructions: 'Choose a destination outside the moved subtree.' };
  }
  return null;
}

async function runStructuralMove(host: OutlinerToolHost, nodeIds: string[], action: NonNullable<NodeEditMoveParams['structuralAction']>) {
  if (action === 'indent') await host.handle('batch_indent_nodes', { nodeIds });
  else if (action === 'outdent') await host.handle('batch_outdent_nodes', { nodeIds });
  else if (action === 'move_up') await host.handle('batch_move_nodes_up', { nodeIds });
  else await host.handle('batch_move_nodes_down', { nodeIds });
}

async function runAbsoluteMove(host: OutlinerToolHost, nodeIds: string[], move: NodeEditMoveParams) {
  let afterId = typeof move.afterId === 'string' ? move.afterId : undefined;
  let firstInsertIndex = move.afterId === null ? 0 : null;
  for (const nodeId of nodeIds) {
    const currentIndex = indexProjection(host.getProjection());
    const after = afterId ? currentIndex.nodes.get(afterId) : undefined;
    const parentId = move.parentId ?? after?.parentId;
    if (!parentId) throw new Error('Destination parent could not be resolved.');
    const parent = requiredNode(currentIndex, parentId);
    const index = afterId
      ? parent.children.indexOf(afterId) + 1
      : firstInsertIndex;
    await host.handle('move_node', { nodeId, parentId, index });
    if (firstInsertIndex !== null) firstInsertIndex += 1;
    if (afterId) afterId = nodeId;
  }
}

interface NodeMergePreview {
  normalChildIds: string[];
  movedFieldEntryIds: string[];
  movedNodeIds: string[];
  tagIds: string[];
  mergedFields: NodeMergeFieldPreview[];
  redirectedReferenceIds: string[];
}

function mergePreview(index: ProjectionIndex, targetNodeId: string, sourceNodeIds: string[]): NodeMergePreview {
  const target = requiredNode(index, targetNodeId);
  const targetTags = new Set(target.tags);
  const targetFieldByKey = targetFieldEntryMap(index, targetNodeId);
  const normalChildIds: string[] = [];
  const movedFieldEntryIds: string[] = [];
  const movedFieldValueIds: string[] = [];
  const tagIds: string[] = [];
  const mergedFields: NodeMergeFieldPreview[] = [];
  const redirectedReferenceIds: string[] = [];
  for (const sourceId of sourceNodeIds) {
    const source = requiredNode(index, sourceId);
    redirectedReferenceIds.push(...externalTreeReferenceIds(index, sourceId));
    for (const childId of source.children) {
      const child = index.nodes.get(childId);
      if (!child || isInTrash(index, childId)) continue;
      if (child.type !== 'fieldEntry') {
        normalChildIds.push(childId);
        continue;
      }
      const key = fieldMergeKey(index, child);
      const valueIds = activeChildIds(index, childId);
      const existingFieldEntryId = targetFieldByKey.get(key);
      if (existingFieldEntryId && existingFieldEntryId !== childId) {
        movedFieldValueIds.push(...valueIds);
        mergedFields.push({
          fieldName: fieldName(index, child),
          sourceFieldEntryId: childId,
          targetFieldEntryId: existingFieldEntryId,
          movedValueIds: valueIds,
          mode: 'merged_values',
        });
      } else {
        movedFieldEntryIds.push(childId);
        targetFieldByKey.set(key, childId);
        mergedFields.push({
          fieldName: fieldName(index, child),
          sourceFieldEntryId: childId,
          targetFieldEntryId: childId,
          movedValueIds: valueIds,
          mode: 'moved_entry',
        });
      }
    }
    for (const tagId of source.tags) {
      if (!targetTags.has(tagId)) {
        targetTags.add(tagId);
        tagIds.push(tagId);
      }
    }
  }
  return {
    normalChildIds: unique(normalChildIds),
    movedFieldEntryIds: unique(movedFieldEntryIds),
    movedNodeIds: unique([...normalChildIds, ...movedFieldEntryIds, ...movedFieldValueIds]),
    tagIds: unique(tagIds),
    mergedFields,
    redirectedReferenceIds: unique(redirectedReferenceIds),
  };
}

async function runMerge(host: OutlinerToolHost, targetNodeId: string, sourceNodeIds: string[]) {
  for (const sourceId of sourceNodeIds) {
    const index = indexProjection(host.getProjection());
    const target = requiredNode(index, targetNodeId);
    const source = requiredNode(index, sourceId);
    for (const tagId of source.tags) {
      if (!target.tags.includes(tagId)) await host.handle('apply_tag', { nodeId: targetNodeId, tagId });
    }
    for (const referenceId of externalTreeReferenceIds(index, sourceId)) {
      await host.handle('set_reference_target', { referenceId, targetId: targetNodeId });
    }
    for (const childId of [...source.children]) {
      const latest = indexProjection(host.getProjection());
      const child = latest.nodes.get(childId);
      if (!child || isInTrash(latest, childId)) continue;
      if (child.type !== 'fieldEntry') {
        await host.handle('move_node', { nodeId: childId, parentId: targetNodeId, index: null });
        continue;
      }
      const targetFieldEntry = matchingTargetFieldEntry(latest, targetNodeId, child);
      if (!targetFieldEntry || targetFieldEntry.id === child.id) {
        await host.handle('move_node', { nodeId: child.id, parentId: targetNodeId, index: null });
        continue;
      }
      for (const valueId of [...child.children]) {
        const valueIndex = indexProjection(host.getProjection());
        if (valueIndex.nodes.has(valueId) && !isInTrash(valueIndex, valueId)) {
          await host.handle('move_node', { nodeId: valueId, parentId: targetFieldEntry.id, index: null });
        }
      }
      await host.handle('trash_node', { nodeId: child.id });
    }
    await host.handle('trash_node', { nodeId: sourceId });
  }
}

function targetFieldEntryMap(index: ProjectionIndex, targetNodeId: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const fieldEntryId of fieldEntryChildIds(index, targetNodeId)) {
    const fieldEntry = requiredNode(index, fieldEntryId);
    const key = fieldMergeKey(index, fieldEntry);
    if (!result.has(key)) result.set(key, fieldEntryId);
  }
  return result;
}

function matchingTargetFieldEntry(index: ProjectionIndex, targetNodeId: string, sourceFieldEntry: NodeProjection): NodeProjection | null {
  const key = fieldMergeKey(index, sourceFieldEntry);
  for (const fieldEntryId of fieldEntryChildIds(index, targetNodeId)) {
    const candidate = requiredNode(index, fieldEntryId);
    if (fieldMergeKey(index, candidate) === key) return candidate;
  }
  return null;
}

function fieldEntryChildIds(index: ProjectionIndex, nodeId: string): string[] {
  return requiredNode(index, nodeId).children.filter((childId) => {
    const child = index.nodes.get(childId);
    return child?.type === 'fieldEntry' && !isInTrash(index, childId);
  });
}

function activeChildIds(index: ProjectionIndex, nodeId: string): string[] {
  return requiredNode(index, nodeId).children.filter((childId) => index.nodes.has(childId) && !isInTrash(index, childId));
}

function fieldMergeKey(index: ProjectionIndex, fieldEntry: NodeProjection): string {
  return fieldName(index, fieldEntry).trim().toLowerCase();
}

function externalTreeReferenceIds(index: ProjectionIndex, targetId: string): string[] {
  const result: string[] = [];
  for (const node of index.projection.nodes) {
    if (node.type !== 'reference' || node.targetId !== targetId) continue;
    if (node.id === targetId || isInTrash(index, node.id) || isDescendantOf(index, node.id, targetId)) continue;
    result.push(node.id);
  }
  return result;
}

function isDescendantOf(index: ProjectionIndex, nodeId: string, ancestorId: string): boolean {
  let current = index.nodes.get(nodeId)?.parentId;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    if (current === ancestorId) return true;
    visited.add(current);
    current = index.nodes.get(current)?.parentId;
  }
  return false;
}

function topLevelSelection(index: ProjectionIndex, nodeIds: string[]): { nodeIds: string[]; skipped: NodeDeleteSkip[] } {
  const selected = new Set(nodeIds);
  const seen = new Set<string>();
  const topLevel: string[] = [];
  const skipped: NodeDeleteSkip[] = [];
  for (const nodeId of nodeIds) {
    if (seen.has(nodeId)) {
      skipped.push({ nodeId, reason: 'duplicate' });
      continue;
    }
    seen.add(nodeId);
    const coveredBy = selectedAncestor(index, nodeId, selected);
    if (coveredBy) {
      skipped.push({ nodeId, reason: 'covered_by_ancestor', coveredBy });
      continue;
    }
    topLevel.push(nodeId);
  }
  return { nodeIds: topLevel, skipped };
}

function selectedAncestor(index: ProjectionIndex, nodeId: string, selected: Set<string>): string | null {
  let current = index.nodes.get(nodeId)?.parentId;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    if (selected.has(current)) return current;
    visited.add(current);
    current = index.nodes.get(current)?.parentId;
  }
  return null;
}

function deletePreview(index: ProjectionIndex, nodeId: string): NodeDeletePreview {
  const node = requiredNode(index, nodeId);
  return {
    nodeId,
    title: nodeTitle(index, node),
    type: nodeKind(node),
    parent: parentRef(index, node),
    childCount: node.children.length,
    subtreeNodeCount: subtreeNodeCount(index, nodeId),
  };
}

function subtreeNodeCount(index: ProjectionIndex, nodeId: string, visited = new Set<string>()): number {
  if (visited.has(nodeId)) return 0;
  visited.add(nodeId);
  const node = index.nodes.get(nodeId);
  if (!node) return 0;
  return 1 + node.children.reduce((sum, childId) => sum + subtreeNodeCount(index, childId, visited), 0);
}

function parentNotFound(parentId: string) {
  return {
    code: 'parent_not_found',
    error: `Parent node not found: ${parentId}`,
    instructions: 'Use node_read or node_search to find the current parent node id.',
  };
}

interface MutationTracker {
  createdRootIds: string[];
  createdNodeIds: string[];
  createdFieldEntryIds: string[];
  createdFieldDefIds: string[];
  createdTagIds: string[];
  matchedNodeIds: string[];
}

function createMutationTracker(): MutationTracker {
  return {
    createdRootIds: [],
    createdNodeIds: [],
    createdFieldEntryIds: [],
    createdFieldDefIds: [],
    createdTagIds: [],
    matchedNodeIds: [],
  };
}

async function createOutlineNode(
  host: OutlinerToolHost,
  node: OutlineNode,
  parentId: string,
  index: number | null,
  tracker: MutationTracker,
  warnings: string[],
): Promise<string> {
  if (node.search) {
    const spec = resolveSearchSpecFromOutlineNode(indexProjection(host.getProjection()), node);
    if ('error' in spec) throw new Error(spec.error);
    warnings.push(...spec.warnings);
    const createdId = focusFromOutcome(await host.handle('create_search_node', {
      parentId,
      index,
      config: searchNodeConfigFromSpec(spec),
    }));
    await applySearchViewSpec(host, createdId, spec.view);
    tracker.createdNodeIds.push(createdId);
    const createdSearch = indexProjection(host.getProjection()).nodes.get(createdId);
    if (createdSearch) tracker.createdNodeIds.push(...createdSearch.children);
    if (node.description) {
      await host.handle('update_node_description', { nodeId: createdId, description: node.description });
    }
    await applyTags(host, createdId, node.tags, tracker);
    return createdId;
  }
  if (node.view) warnings.push('View directives are only persisted on search nodes today.');

  const createdId = node.referenceTargetId
    ? await addReference(host, parentId, node.referenceTargetId, index)
    : await createPlainNode(host, parentId, index, node.title);
  tracker.createdNodeIds.push(createdId);

  if (node.description && !node.referenceTargetId) {
    await host.handle('update_node_description', { nodeId: createdId, description: node.description });
  }
  await setCheckboxState(host, createdId, node.checked);

  await applyTags(host, createdId, node.tags, tracker);
  const reusableFieldEntries = reusableFieldEntriesForCreate(indexProjection(host.getProjection()), createdId);
  for (const field of node.fields) {
    const fieldKey = normalizedFieldNameKey(field.name);
    const existingFieldEntryId = reusableFieldEntries.get(fieldKey);
    if (existingFieldEntryId) {
      reusableFieldEntries.delete(fieldKey);
      trackMatchedNode(tracker, existingFieldEntryId);
      await syncFieldValues(host, existingFieldEntryId, field, tracker, warnings);
    } else {
      await createField(host, createdId, field, tracker);
    }
  }
  for (const child of node.children) {
    await createOutlineNode(host, child, createdId, null, tracker, warnings);
  }
  return createdId;
}

async function createPlainNode(host: OutlinerToolHost, parentId: string, index: number | null, text: string): Promise<string> {
  return focusFromOutcome(await host.handle('create_node', { parentId, index, text }));
}

async function addReference(host: OutlinerToolHost, parentId: string, targetId: string, index: number | null): Promise<string> {
  return focusFromOutcome(await host.handle('add_reference', { parentId, targetId, index }));
}

async function applySearchViewSpec(host: OutlinerToolHost, nodeId: string, view: string | undefined) {
  if (!view) return;
  await host.handle('set_view_mode', { nodeId, mode: view });
}

async function applyTags(host: OutlinerToolHost, nodeId: string, tags: string[], tracker: MutationTracker) {
  for (const tagName of tags) {
    const before = indexProjection(host.getProjection());
    const existing = findTagByName(before, tagName);
    const tagId = existing?.id ?? focusFromOutcome(await host.handle('create_tag', { name: tagName }));
    if (!existing) tracker.createdTagIds.push(tagId);
    await host.handle('apply_tag', { nodeId, tagId });
  }
}

function reusableFieldEntriesForCreate(index: ProjectionIndex, parentId: string): Map<string, string> {
  const byName = new Map<string, string[]>();
  for (const childId of requiredNode(index, parentId).children) {
    const child = index.nodes.get(childId);
    if (child?.type !== 'fieldEntry' || isInTrash(index, childId)) continue;
    const key = normalizedFieldNameKey(fieldName(index, child));
    byName.set(key, [...(byName.get(key) ?? []), childId]);
  }

  const reusable = new Map<string, string>();
  for (const [key, ids] of byName) {
    if (ids.length === 1) reusable.set(key, ids[0]!);
  }
  return reusable;
}

function normalizedFieldNameKey(name: string): string {
  return name.trim().toLowerCase();
}

async function createField(
  host: OutlinerToolHost,
  parentId: string,
  field: OutlineField,
  tracker: MutationTracker,
  index: number | null = null,
): Promise<string> {
  const fieldEntryId = focusFromOutcome(await host.handle('create_inline_field', {
    parentId,
    index,
    name: field.name,
    fieldType: 'plain',
  }));
  tracker.createdFieldEntryIds.push(fieldEntryId);
  const fieldEntry = indexProjection(host.getProjection()).nodes.get(fieldEntryId);
  if (fieldEntry?.type === 'fieldEntry' && fieldEntry.fieldDefId) tracker.createdFieldDefIds.push(fieldEntry.fieldDefId);
  for (const value of field.values) {
    const valueNodeId = await createFieldValue(host, fieldEntryId, value);
    tracker.createdNodeIds.push(valueNodeId);
  }
  return fieldEntryId;
}

async function createFieldValue(
  host: OutlinerToolHost,
  fieldEntryId: string,
  value: OutlineValue,
  index: number | null = null,
): Promise<string> {
  if (value.targetId) {
    return focusFromOutcome(await host.handle('add_reference', { parentId: fieldEntryId, targetId: value.targetId, index }));
  }
  return focusFromOutcome(await host.handle('create_node', { parentId: fieldEntryId, index, text: value.text }));
}

function duplicateOutline(index: ProjectionIndex, duplicateId: string): { ok: true; outline: string } | { ok: false; code: string; error: string; instructions: string } {
  if (!index.nodes.has(duplicateId)) {
    return { ok: false, code: 'node_not_found', error: `Duplicate source node not found: ${duplicateId}`, instructions: 'Use node_search to locate the source node id.' };
  }
  if (isInTrash(index, duplicateId)) {
    return { ok: false, code: 'node_in_trash', error: `Duplicate source is in Trash: ${duplicateId}`, instructions: 'Restore or choose a non-deleted source node.' };
  }
  return { ok: true, outline: serializeOutline(index, duplicateId, 12, 0, 500, false) };
}

function collectReferenceTargetIds(document: OutlineDocument): string[] {
  const ids: string[] = [];
  for (const root of document.roots) collectNodeReferenceTargetIds(root, ids);
  return unique(ids);
}

function validateLocalFileReferenceMarkers(
  options: NodeToolsOptions,
  document: OutlineDocument,
): { code: string; error: string; instructions: string } | null {
  if (!options.localFileRoot) return null;
  const root = path.resolve(options.localFileRoot);
  const outside = collectLocalFileReferencePaths(document)
    .find((filePath) => !localFileReferencePathIsInside(root, filePath));
  if (!outside) return null;
  return {
    code: 'invalid_file_reference',
    error: `Local file reference is outside the allowed file area: ${outside}`,
    instructions: 'Attach external files through the composer, or reference a file path under the allowed file area.',
  };
}

function localFileReferencePathIsInside(root: string, filePath: string): boolean {
  if (!filePath) return false;
  const resolved = path.resolve(path.isAbsolute(filePath) ? filePath : path.join(root, filePath));
  return isPathInside(root, resolved);
}

function collectLocalFileReferencePaths(document: OutlineDocument): string[] {
  const paths: string[] = [];
  for (const root of document.roots) collectNodeLocalFileReferencePaths(root, paths);
  return paths;
}

function collectNodeLocalFileReferencePaths(node: OutlineNode, paths: string[]) {
  collectTextLocalFileReferencePaths(node.title, paths);
  collectTextLocalFileReferencePaths(node.description ?? '', paths);
  for (const field of node.fields) {
    collectTextLocalFileReferencePaths(field.name, paths);
    for (const value of field.values) collectTextLocalFileReferencePaths(value.text, paths);
  }
  for (const child of node.children) collectNodeLocalFileReferencePaths(child, paths);
}

function collectTextLocalFileReferencePaths(text: string, paths: string[]) {
  if (!text.includes('[[file:')) return;
  for (const segment of splitFileReferenceMarkers(text)) {
    if (segment.type === 'file') paths.push(segment.path);
  }
}

function collectOutlineAnnotationIds(document: OutlineDocument): string[] {
  const ids: string[] = [];
  for (const root of document.roots) collectNodeAnnotationIds(root, ids);
  return unique(ids);
}

function collectNodeAnnotationIds(node: OutlineNode, ids: string[]) {
  if (node.nodeId) ids.push(node.nodeId);
  for (const field of node.fields) {
    if (field.nodeId) ids.push(field.nodeId);
    for (const value of field.values) {
      if (value.nodeId) ids.push(value.nodeId);
    }
  }
  for (const child of node.children) collectNodeAnnotationIds(child, ids);
}

function validateEditAnnotations(
  index: ProjectionIndex,
  rootNodeId: string,
  document: OutlineDocument,
): { code: string; error: string; instructions: string } | null {
  const root = document.roots[0];
  if (!root) return null;
  if (root.nodeId && root.nodeId !== rootNodeId) {
    return {
      code: 'invalid_annotation',
      error: `Root annotation ${root.nodeId} does not match target node_id ${rootNodeId}.`,
      instructions: 'Use the annotated outline returned by node_read for the same target node.',
    };
  }
  const ids = collectOutlineAnnotationIds(document);
  const duplicate = firstDuplicate(ids);
  if (duplicate) {
    return {
      code: 'duplicate_annotation',
      error: `Duplicate %%node:id%% marker in outline: ${duplicate}`,
      instructions: 'Each existing node id may appear at most once in a node_edit outline.',
    };
  }
  const missing = ids.find((nodeId) => !index.nodes.has(nodeId));
  if (missing) {
    return {
      code: 'node_not_found',
      error: `Annotated node id not found: ${missing}`,
      instructions: 'Call node_read again and retry with the latest annotated outline.',
    };
  }
  const scope = descendantNodeIdSet(index, rootNodeId, false);
  const outside = ids.find((nodeId) => !scope.has(nodeId));
  if (outside) {
    return {
      code: 'invalid_annotation_scope',
      error: `Annotated node id is outside the edited subtree: ${outside}`,
      instructions: 'Use node_edit move parameters for moving external nodes, or edit the correct subtree.',
    };
  }
  return null;
}

function descendantNodeIdSet(index: ProjectionIndex, rootNodeId: string, includeDeleted: boolean): Set<string> {
  const ids = new Set<string>();
  const visit = (nodeId: string) => {
    if (ids.has(nodeId)) return;
    const node = index.nodes.get(nodeId);
    if (!node || (!includeDeleted && isInTrash(index, nodeId))) return;
    ids.add(nodeId);
    for (const childId of node.children) visit(childId);
  };
  visit(rootNodeId);
  return ids;
}

function collectNodeReferenceTargetIds(node: OutlineNode, ids: string[]) {
  if (node.referenceTargetId) ids.push(node.referenceTargetId);
  for (const field of node.fields) {
    for (const value of field.values) {
      if (value.targetId) ids.push(value.targetId);
    }
  }
  for (const child of node.children) collectNodeReferenceTargetIds(child, ids);
}

function focusFromOutcome(outcome: unknown): string {
  const focusNodeId = outcome && typeof outcome === 'object'
    ? (outcome as { focus?: { nodeId?: unknown } }).focus?.nodeId
    : undefined;
  if (typeof focusNodeId !== 'string' || !focusNodeId) throw new Error('Mutation did not return a focus node id.');
  return focusNodeId;
}
