import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import path from 'node:path';
import type { AgentRunScope } from '../core/agentEventLog';
import { normalizeDateFieldValue } from '../core/dateFieldValue';
import { projectFieldConfig, projectTagConfig, nodeIsDone, nodeShowsCheckbox } from '../core/configProjection';
import { validateSearchQueries } from '../core/searchEngine';
import {
  SCHEMA_ID,
  plainText,
  referenceTargetSortKey,
  replaceAllRichTextPatch,
  type FieldConfigPatch,
  type FieldType,
  type HideFieldMode,
  type NodeId,
  type NodeProjection,
  type ReferenceTarget,
  type RichText,
  type SearchQueryExpr,
  type TagConfigPatch,
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
  OUTLINE_UNDO_STACK_PARAMETERS,
} from './agentNodeToolSchemas';
import {
  NODE_CREATE_DESCRIPTION,
  NODE_DELETE_DESCRIPTION,
  NODE_EDIT_DESCRIPTION,
  NODE_READ_DESCRIPTION,
  NODE_SEARCH_DESCRIPTION,
  OUTLINE_UNDO_STACK_DESCRIPTION,
} from './agentNodeToolGuidance';
import {
  buildReadItem,
  editableOutlineRevision,
  normalizeReadParams,
  pageHasMore,
  serializeAnnotatedOutline,
  serializeEditableNodeOutline,
  serializeOutline,
} from './agentNodeToolRead';
import {
  buildSearchItem,
  combineSearchQueryFragments,
  normalizeSearchParams,
  resolveSearch,
  resolveSearchQueryFragment,
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
  visibleSearchBatchCountResult,
  visibleSearchResult,
} from './agentNodeToolVisibility';
import type {
  NodeCreateData,
  NodeDefinitionCreateParams,
  NodeDefinitionMerge,
  NodeDefinitionMutation,
  NodeCreateParams,
  NodeDeleteData,
  NodeDeleteParams,
  NodeDeletePreview,
  NodeDeleteSkip,
  DefinitionIncompatibleValue,
  DefinitionValueValidationReport,
  NodeEditData,
  NodeEditMoveParams,
  NodeEditParams,
  NodeMergeFieldPreview,
  ProjectedDefinitionConfig,
  NodeReadData,
  NodeSearchBatchCountData,
  NodeSearchData,
  NodeSearchResultData,
  NormalizedBatchCountSearchParams,
  NormalizedEditParams,
  NormalizedReadParams,
  OperationHistoryData,
  OperationHistoryItem,
  OperationHistoryParams,
  OutlinerToolHost,
  ProjectionIndex,
} from './agentNodeToolTypes';
import { markdownReferenceMarkupToRichText, richTextToMarkdownReferenceMarkup } from '../core/markdownRichText';
import { isPathInside } from './agentAttachmentMaterialization';
import {
  inferFieldTypeFromValues,
  normalizeFieldNameKey,
  resolveFieldWriteTarget,
  validateFieldValuesForType,
  type FieldResolutionNode,
  type FieldResolutionValue,
  type FieldWriteTarget,
} from '../core/fieldResolution';
import { DONE_FIELD, isSystemFieldId } from '../core/systemFields';

export type { OutlinerToolHost } from './agentNodeToolTypes';

export interface NodeToolsOptions {
  chatSourceValidator?: ChatSourceValidator;
  localFileRoot?: string;
  runScope?: AgentRunScope;
}

export type ChatSourceValidator = (
  target: Extract<ReferenceTarget, { kind: 'chat-source' }>,
) => Promise<ChatSourceValidationResult> | ChatSourceValidationResult;

export type ChatSourceValidationResult =
  | { ok: true }
  | { ok: false; code?: string; error?: string; instructions?: string };

export function createNodeTools(host: OutlinerToolHost, options: NodeToolsOptions = {}): AgentTool<any>[] {
  const agentHost = asAgentToolHost(host);
  const tools = [
    createNodeSearchTool(agentHost, options),
    createNodeReadTool(agentHost, options),
    createNodeCreateTool(agentHost, options),
    createNodeEditTool(agentHost, options),
    createNodeDeleteTool(agentHost, options),
    ...(options.runScope ? [] : [createOutlineUndoStackTool(agentHost)]),
  ];
  return tools.map((tool) => tool.name === 'outline_undo_stack' ? tool : withAgentToolTransaction(tool, agentHost));
}

function asAgentToolHost(host: OutlinerToolHost): OutlinerToolHost {
  return {
    getProjection: () => host.getProjection(),
    getTextSearchIndex: host.getTextSearchIndex ? () => host.getTextSearchIndex!() : undefined,
    getTransientSearchOptions: host.getTransientSearchOptions ? () => host.getTransientSearchOptions!() : undefined,
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

function createOutlineUndoStackTool(host: OutlinerToolHost): AgentTool<any, ToolEnvelope<OperationHistoryData>> {
  return {
    name: 'outline_undo_stack',
    label: 'Outline Undo Stack',
    description: OUTLINE_UNDO_STACK_DESCRIPTION,
    parameters: OUTLINE_UNDO_STACK_PARAMETERS,
    executionMode: 'sequential',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      const params = normalizeOutlineUndoStackParams(rawParams);
      if (params.error) {
        return agentToolResult(errorEnvelope<OperationHistoryData>('outline_undo_stack', 'invalid_args', params.error, {
          instructions: 'Call outline_undo_stack with action "list", "undo", or "redo".',
          metrics: { durationMs: elapsed(started) },
        }));
      }
      if (!host.operationHistory) {
        return agentToolResult(errorEnvelope<OperationHistoryData>('outline_undo_stack', 'outline_undo_stack_unavailable', 'The host does not expose Loro outline undo stack support.', {
          instructions: 'Retry after the document service has initialized outline undo stack support.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      const data = await host.operationHistory(params);
      return agentToolResult(successEnvelope('outline_undo_stack', data, {
        status: params.action === 'list' || data.count > 0 ? 'success' : 'unchanged',
        metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
      }), visibleOutlineUndoStack(data));
    },
  };
}

// Model-visible projection: the full OperationHistoryData stays on the envelope
// (details). The model needs the entries plus undo/redo affordances, not the
// derivable count, the internal historyMode, the Loro cursor, or each item's
// raw command name (tool/action/summary already describe the operation).
export function visibleOutlineUndoStack(data: OperationHistoryData): unknown {
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

interface NodeScopeIssue {
  nodeId: string;
  error?: string;
}

type NodeScopeAccess = 'read' | 'write';

function scopedNodeRoots(options: NodeToolsOptions, access: NodeScopeAccess = 'read'): string[] | null {
  const resources = options.runScope?.resources;
  const nodeIds = access === 'write'
    ? resources?.writableNodes ?? resources?.nodes
    : resources?.nodes;
  if (nodeIds === undefined) return null;
  return unique(nodeIds.map((nodeId) => nodeId.trim()).filter(Boolean));
}

function hasNodeResourceScope(options: NodeToolsOptions, access: NodeScopeAccess = 'read'): boolean {
  return scopedNodeRoots(options, access) !== null;
}

function filterNodeResourceScope(options: NodeToolsOptions, index: ProjectionIndex, nodeIds: readonly string[]): string[] {
  const roots = scopedNodeRoots(options);
  return roots ? nodeIds.filter((nodeId) => nodeIsInsideResourceScope(index, nodeId, roots)) : [...nodeIds];
}

function validateNodeResourceScope(
  options: NodeToolsOptions,
  index: ProjectionIndex,
  nodeIds: readonly string[],
  access: NodeScopeAccess = 'read',
): NodeScopeIssue | null {
  const roots = scopedNodeRoots(options, access);
  if (!roots) return null;
  const outside = nodeIds.find((nodeId) => !nodeIsInsideResourceScope(index, nodeId, roots));
  return outside ? { nodeId: outside } : null;
}

function nodeIsInsideResourceScope(index: ProjectionIndex, nodeId: string, roots: readonly string[]): boolean {
  return roots.some((rootId) => nodeId === rootId || isDescendantOf(index, nodeId, rootId));
}

function nodeScopeIssueDetails(issue: NodeScopeIssue): { code: string; error: string; instructions: string } {
  return {
    code: 'outside_scope',
    error: issue.error ?? `Node is outside this run's confirmed resource scope: ${issue.nodeId}`,
    instructions: 'Stop and ask for an Issue scope change or a new authorized Agent Session instead of broadening the work silently.',
  };
}

function nodeScopeError<TData>(toolName: string, issue: NodeScopeIssue, started: number) {
  const details = nodeScopeIssueDetails(issue);
  return nodeErrorResult(errorEnvelope<TData>(toolName, details.code, details.error, {
    instructions: details.instructions,
    metrics: { durationMs: elapsed(started) },
  }));
}

function readVisibleNodeIds(index: ProjectionIndex, nodeId: string, params: NormalizedReadParams): string[] {
  const out: string[] = [];
  const visit = (currentId: string, remainingDepth: number, offset: number, limit: number) => {
    out.push(currentId);
    if (remainingDepth <= 0) return;
    const childIds = normalChildIds(index, currentId, params.includeDeleted)
      .slice(offset, offset + limit);
    for (const childId of childIds) visit(childId, remainingDepth - 1, 0, limit);
  };
  visit(nodeId, params.depth, params.childOffset, params.childLimit);
  return unique(out);
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
          instructions: 'Set operation to one of replace_outline, move, merge, or replace_with_reference and provide only the fields for that operation.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      switch (params.action) {
        case 'replace_outline':
          return executeOutlineEdit(host, params, started, options);
        case 'move':
          return executeMoveEdit(host, params, started, options);
        case 'merge':
          return executeMergeEdit(host, params, started, options);
        case 'replace_with_reference':
          return executeReferenceReplaceEdit(host, params, started, options);
        case 'configure_definition':
          return executeDefinitionConfigEdit(host, params, started, options);
        case 'reuse_field_definition':
          return executeReuseFieldDefinitionEdit(host, params, started, options);
        case 'merge_definition':
          return executeDefinitionMergeEdit(host, params, started, options);
      }
    },
  };
}

function createNodeDeleteTool(host: OutlinerToolHost, options: NodeToolsOptions): AgentTool<any, ToolEnvelope<NodeDeleteData>> {
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
      const scopedNodeIds = requestedNodeIds.flatMap((nodeId) => [...descendantNodeIdSet(index, nodeId, true)]);
      const scopeIssue = validateNodeResourceScope(options, index, scopedNodeIds, 'write');
      if (scopeIssue) {
        return nodeScopeError<NodeDeleteData>('node_delete', scopeIssue, started);
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
  params: Extract<NormalizedEditParams, { action: 'replace_outline' }>,
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
  const scopeIssue = validateNodeResourceScope(options, index, [params.nodeId], 'write');
  if (scopeIssue) {
    return nodeScopeError<NodeEditData>('node_edit', scopeIssue, started);
  }
  requiredNode(index, params.nodeId);
  const currentRevision = editableOutlineRevision(index, params.nodeId);
  if (params.expectedRevision && params.expectedRevision !== currentRevision) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'revision_mismatch', `Node changed since it was read: ${params.nodeId}`, {
      instructions: 'Call node_read again and retry with the latest outline and revision.',
      metrics: { durationMs: elapsed(started) },
    }));
  }
  if (params.oldString === '*' && !params.previewOnly && !params.expectedRevision) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'expected_revision_required', 'old_string "*" replaces the whole editable outline and requires expected_revision from node_read.', {
      instructions: 'Call node_read for the target node, then retry with expected_revision. Use exact old_string fragments for partial replacements.',
      metrics: { durationMs: elapsed(started) },
    }));
  }

  const currentOutline = serializeEditableNodeOutline(index, params.nodeId);
  const replacement = replaceOutline(currentOutline, params.oldString, params.newString, params.nodeId);
  if (!replacement.ok) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', replacement.code, replacement.error, {
      instructions: replacement.instructions,
      metrics: { durationMs: elapsed(started) },
    }));
  }

  const dataBase = {
    action: 'replace_outline' as const,
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
      instructions: `Fix new_string so the one-node outline remains valid outline format. Line ${parsed.error.line}, column ${parsed.error.column}.`,
      metrics: { durationMs: elapsed(started) },
    }));
  }
  if (parsed.document.fields.length > 0) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'invalid_outline_root', 'node_edit cannot place field lines outside the target root node.', {
      instructions: 'Indent field lines under the target root line, or use node_create to add fields to an existing parent node.',
      metrics: { durationMs: elapsed(started) },
    }));
  }
  if (parsed.document.roots.length !== 1) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'ambiguous_root', 'node_edit must produce exactly one root node for the target node_id.', {
      instructions: 'Call node_create for new sibling roots, node_edit move for moves, or edit the intended child node directly by id.',
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
  const annotationScopeIssue = validateNodeResourceScope(options, index, collectOutlineAnnotationIds(parsed.document));
  if (annotationScopeIssue) {
    return nodeScopeError<NodeEditData>('node_edit', annotationScopeIssue, started);
  }
  const referenceValidation = await validateOutlineReferenceTargets(options, index, parsed.document);
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
  const shapeValidation = validateSingleNodeEditShape(parsed.document);
  if (shapeValidation) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', shapeValidation.code, shapeValidation.error, {
      instructions: shapeValidation.instructions,
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
  let updatedTags: string[] = [];
  try {
    const valueKindValidation = validateFieldValueKindUpdates(index, params.nodeId, parsed.document.roots[0]!);
    if (valueKindValidation) {
      return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', valueKindValidation.code, valueKindValidation.error, {
        instructions: valueKindValidation.instructions,
        metrics: { durationMs: elapsed(started) },
      }));
    }
  } catch (error) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'mutation_failed', errorMessage(error), {
      instructions: 'Use node_read to refresh the target node, then retry a smaller single-node edit if needed.',
      metrics: { durationMs: elapsed(started) },
    }));
  }
  try {
    const applied = await applySingleNodeEdit(host, params.nodeId, parsed.document.roots[0]!, tracker, warnings);
    updatedTags = applied.updatedTagIds;
  } catch (error) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'mutation_failed', errorMessage(error), {
      instructions: 'Use node_read to refresh the target node, then retry a smaller single-node edit if needed.',
      metrics: { durationMs: elapsed(started) },
    }));
  }

  const updatedIndex = indexProjection(host.getProjection());
  const updatedNode = updatedIndex.nodes.get(params.nodeId);
  const changedIds = changedNodeIds(beforeProjection, updatedIndex.projection)
    .filter((nodeId) => updatedIndex.nodes.has(nodeId));
  const afterOutline = updatedNode ? serializeEditableNodeOutline(updatedIndex, params.nodeId) : replacement.afterOutline;
  const data: NodeEditData = {
    ...dataBase,
    afterOutline,
    status: 'updated',
    affectedNodeIds: unique([params.nodeId, ...changedIds, ...tracker.createdNodeIds]),
    createdNodeIds: tracker.createdNodeIds.length ? tracker.createdNodeIds : undefined,
    matchedNodeIds: tracker.matchedNodeIds.length ? tracker.matchedNodeIds : undefined,
    updatedFields: tracker.createdFieldEntryIds.length ? tracker.createdFieldEntryIds : undefined,
    updatedTags: updatedTags.length ? updatedTags : undefined,
    revisions: updatedNode ? { [params.nodeId]: editableOutlineRevision(updatedIndex, params.nodeId) } : undefined,
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
  options: NodeToolsOptions,
) {
  const index = indexProjection(host.getProjection());
  const validation = validateMutableNodeIds(index, params.nodeIds);
  if (validation) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', validation.code, validation.error, {
      instructions: validation.instructions,
      metrics: { durationMs: elapsed(started) },
    }));
  }
  if (hasNodeResourceScope(options, 'write') && params.move.structuralAction) {
    return nodeScopeError<NodeEditData>('node_edit', {
      nodeId: params.move.structuralAction,
      error: 'Structural moves infer a destination outside the explicit request and are not available in a node-scoped run.',
    }, started);
  }

  const requestedScopeNodeIds = unique([
    ...params.nodeIds,
    ...(params.move.parentId ? [params.move.parentId] : []),
    ...(typeof params.move.afterId === 'string' ? [params.move.afterId] : []),
  ]);
  const scopeIssue = validateNodeResourceScope(options, index, requestedScopeNodeIds, 'write');
  if (scopeIssue) {
    return nodeScopeError<NodeEditData>('node_edit', scopeIssue, started);
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
  options: NodeToolsOptions,
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
  const initialScopeIssue = validateNodeResourceScope(options, index, nodeIds, 'write');
  if (initialScopeIssue) {
    return nodeScopeError<NodeEditData>('node_edit', initialScopeIssue, started);
  }
  if (params.mergeFromNodeIds.includes(params.nodeId)) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'invalid_merge', 'merge_from_node_ids cannot include the target node_id.', {
      instructions: 'Pass only duplicate/source nodes in merge_from_node_ids.',
      metrics: { durationMs: elapsed(started) },
    }));
  }
  const typeValidation = validateOrdinaryMergeNodeTypes(index, params.nodeId, params.mergeFromNodeIds);
  if (typeValidation) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', typeValidation.code, typeValidation.error, {
      instructions: typeValidation.instructions,
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
  const affectedScopeIssue = validateNodeResourceScope(options, index, data.affectedNodeIds, 'write');
  if (affectedScopeIssue) {
    return nodeScopeError<NodeEditData>('node_edit', affectedScopeIssue, started);
  }

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
  const targetValidation = validateReferenceTargetIds(index, [params.replaceWithReferenceTo]);
  if (targetValidation) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', targetValidation.code, targetValidation.error, {
      instructions: targetValidation.instructions,
      metrics: { durationMs: elapsed(started) },
    }));
  }
  const writeScopeIssue = validateNodeResourceScope(options, index, [params.nodeId], 'write');
  if (writeScopeIssue) {
    return nodeScopeError<NodeEditData>('node_edit', writeScopeIssue, started);
  }
  const referenceScopeIssue = validateNodeResourceScope(options, index, [params.replaceWithReferenceTo]);
  if (referenceScopeIssue) {
    return nodeScopeError<NodeEditData>('node_edit', referenceScopeIssue, started);
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

async function executeDefinitionConfigEdit(
  host: OutlinerToolHost,
  params: Extract<NormalizedEditParams, { action: 'configure_definition' }>,
  started: number,
  options: NodeToolsOptions,
) {
  const index = indexProjection(host.getProjection());
  const targetScopeIssue = validateNodeResourceScope(options, index, [params.nodeId], 'write');
  if (targetScopeIssue) {
    return nodeScopeError<NodeEditData>('node_edit', targetScopeIssue, started);
  }
  const referenceScopeIssue = validateNodeResourceScope(options, index, definitionPatchNodeIds(params.definitionPatch));
  if (referenceScopeIssue) {
    return nodeScopeError<NodeEditData>('node_edit', referenceScopeIssue, started);
  }
  const validation = validateMutableNodeIds(index, [params.nodeId]);
  if (validation) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', validation.code, validation.error, {
      instructions: validation.instructions,
      metrics: { durationMs: elapsed(started) },
    }));
  }
  const node = requiredNode(index, params.nodeId);
  const kind = definitionKind(node);
  if (!kind) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'invalid_definition_target', `Node is not a tag or field definition: ${params.nodeId}`, {
      instructions: 'Use node_read/node_search to locate a tagDef or fieldDef node, then retry configure_definition.',
      metrics: { durationMs: elapsed(started) },
    }));
  }
  const affectedScopeIssue = validateNodeResourceScope(
    options,
    index,
    definitionConfigAffectedNodeIds(index, node),
    'write',
  );
  if (affectedScopeIssue) {
    return nodeScopeError<NodeEditData>('node_edit', affectedScopeIssue, started);
  }
  const foreignKeys = kind === 'field' ? presentPatchKeys(params.definitionPatch, TAG_PATCH_KEYS) : presentPatchKeys(params.definitionPatch, FIELD_PATCH_KEYS);
  if (foreignKeys.length > 0) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'invalid_definition_patch', `${kind} definitions cannot use these config keys: ${foreignKeys.join(', ')}.`, {
      instructions: kind === 'field'
        ? 'Use field config keys such as field_type, source_supertag, nullable, hide_field, auto_initialize, autocollect_options, min_value, or max_value.'
        : 'Use tag config keys such as color, extends, child_supertag, show_checkbox, done_state_enabled, done_map_checked, or done_map_unchecked.',
      metrics: { durationMs: elapsed(started) },
    }));
  }

  const beforeConfig = projectDefinitionConfig(index, node);
  const validationReport = kind === 'field'
    ? validateFieldDefinitionPatchAgainstExistingValues(index, node, params.definitionPatch as FieldConfigPatch, params.existingValues)
    : { strategy: params.existingValues } satisfies DefinitionValueValidationReport;
  const incompatibleValues = validationReport.incompatibleValues ?? [];
  if (incompatibleValues.length > 0) {
    const data: NodeEditData = {
      action: 'configure_definition',
      status: 'unchanged',
      affectedNodeIds: [params.nodeId],
      definition: {
        kind,
        nodeId: params.nodeId,
        beforeConfig,
        afterConfig: beforeConfig,
        patch: params.definitionPatch,
        validation: validationReport,
      },
      revisions: { [params.nodeId]: revisionOf(node) },
    };
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'incompatible_existing_values', 'Field type change is incompatible with existing field values.', {
      instructions: 'Fix or clear the listed field values first, or choose a field type compatible with all existing values.',
      data,
      metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
    }), visibleEditResult(data, false, index));
  }

  if (params.previewOnly) {
    const afterConfig = applyProjectedDefinitionPatch(kind, beforeConfig, params.definitionPatch);
    const data: NodeEditData = {
      action: 'configure_definition',
      status: sameJsonValue(beforeConfig, afterConfig) ? 'unchanged' : 'updated',
      affectedNodeIds: [params.nodeId],
      definition: {
        kind,
        nodeId: params.nodeId,
        beforeConfig,
        afterConfig,
        patch: params.definitionPatch,
        validation: validationReport,
      },
      revisions: { [params.nodeId]: revisionOf(node) },
    };
    return nodeToolResult(successEnvelope('node_edit', data, {
      status: 'unchanged',
      metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
    }), visibleEditResult(data, true, index));
  }

  try {
    if (kind === 'field') {
      await host.handle('set_field_config', { fieldId: params.nodeId, patch: params.definitionPatch });
    } else {
      await host.handle('set_tag_config', { tagId: params.nodeId, patch: params.definitionPatch });
    }
  } catch (error) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'mutation_failed', errorMessage(error), {
      instructions: 'Use node_read to refresh the definition, verify referenced tag/option ids, and retry with a smaller config patch.',
      metrics: { durationMs: elapsed(started) },
    }));
  }

  const updatedIndex = indexProjection(host.getProjection());
  const updatedNode = requiredNode(updatedIndex, params.nodeId);
  const afterConfig = projectDefinitionConfig(updatedIndex, updatedNode);
  const status = sameJsonValue(beforeConfig, afterConfig) ? 'unchanged' : 'updated';
  const data: NodeEditData = {
    action: 'configure_definition',
    status,
    affectedNodeIds: [params.nodeId],
    definition: {
      kind,
      nodeId: params.nodeId,
      beforeConfig,
      afterConfig,
      patch: params.definitionPatch,
      validation: validationReport,
    },
    revisions: { [params.nodeId]: revisionOf(updatedNode) },
  };
  return nodeToolResult(successEnvelope('node_edit', data, {
    status: status === 'unchanged' ? 'unchanged' : undefined,
    metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
  }), visibleEditResult(data, false, updatedIndex));
}

async function executeReuseFieldDefinitionEdit(
  host: OutlinerToolHost,
  params: Extract<NormalizedEditParams, { action: 'reuse_field_definition' }>,
  started: number,
  options: NodeToolsOptions,
) {
  const index = indexProjection(host.getProjection());
  const entryScopeIssue = validateNodeResourceScope(options, index, [params.nodeId], 'write');
  if (entryScopeIssue) {
    return nodeScopeError<NodeEditData>('node_edit', entryScopeIssue, started);
  }
  const targetScopeIssue = validateNodeResourceScope(options, index, [
    ...(!isSystemFieldId(params.targetDefinitionId) ? [params.targetDefinitionId] : []),
  ]);
  if (targetScopeIssue) {
    return nodeScopeError<NodeEditData>('node_edit', targetScopeIssue, started);
  }
  const validation = validateMutableNodeIds(index, [params.nodeId]);
  if (validation) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', validation.code, validation.error, {
      instructions: validation.instructions,
      metrics: { durationMs: elapsed(started) },
    }));
  }
  const entry = requiredNode(index, params.nodeId);
  if (entry.type !== 'fieldEntry') {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'invalid_field_entry', `Node is not a field entry: ${params.nodeId}`, {
      instructions: 'Use node_read on the owner node and pass the fieldEntryId from the field you want to relink.',
      metrics: { durationMs: elapsed(started) },
    }));
  }
  const targetIsSystemField = isSystemFieldId(params.targetDefinitionId);
  const target = targetIsSystemField ? undefined : index.nodes.get(params.targetDefinitionId);
  if (!targetIsSystemField && target?.type !== 'fieldDef') {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'invalid_field_definition', `Target is not an active field definition: ${params.targetDefinitionId}`, {
      instructions: 'Use node_read/node_search to locate a fieldDef node, or pass a supported sys:* field id.',
      metrics: { durationMs: elapsed(started) },
    }));
  }
  if (!targetIsSystemField && isInTrash(index, params.targetDefinitionId)) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'node_in_trash', `Target field definition is in Trash: ${params.targetDefinitionId}`, {
      instructions: 'Restore the field definition or choose an active field definition.',
      metrics: { durationMs: elapsed(started) },
    }));
  }

  const previousDefinitionId = entry.fieldDefId;
  const previousScopeIssue = validateNodeResourceScope(options, index, [
    ...(previousDefinitionId && !isSystemFieldId(previousDefinitionId) ? [previousDefinitionId] : []),
  ], 'write');
  if (previousScopeIssue) {
    return nodeScopeError<NodeEditData>('node_edit', previousScopeIssue, started);
  }
  const targetFieldDef = target?.type === 'fieldDef' ? target : undefined;
  const targetType = targetFieldDef ? projectFieldConfig(index.nodes, targetFieldDef).fieldType : undefined;
  if (targetType) {
    const valueValidation = validateFieldValuesForType(
      fieldName(index, targetFieldDef!),
      targetType,
      fieldResolutionValuesFromEntry(index, entry),
    );
    if (!valueValidation.ok) {
      return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'incompatible_existing_values', valueValidation.error, {
        instructions: valueValidation.instructions,
        metrics: { durationMs: elapsed(started) },
      }));
    }
  }

  const affectedNodeIds = unique([
    params.nodeId,
    params.targetDefinitionId,
    ...(previousDefinitionId ? [previousDefinitionId] : []),
  ]);
  const data: NodeEditData = {
    action: 'reuse_field_definition',
    status: previousDefinitionId === params.targetDefinitionId ? 'unchanged' : 'updated',
    affectedNodeIds,
    reusedFieldDefinition: {
      fieldEntryId: params.nodeId,
      targetDefinitionId: params.targetDefinitionId,
    },
    revisions: { [params.nodeId]: revisionOf(entry) },
  };
  if (params.previewOnly || data.status === 'unchanged') {
    return nodeToolResult(successEnvelope('node_edit', data, {
      status: params.previewOnly || data.status === 'unchanged' ? 'unchanged' : undefined,
      metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
    }), visibleEditResult(data, params.previewOnly === true, index));
  }

  try {
    await host.handle('reuse_field_definition', { entryId: params.nodeId, targetDefId: params.targetDefinitionId });
  } catch (error) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'mutation_failed', errorMessage(error), {
      instructions: 'Use node_read to refresh the field entry and target definition ids before retrying.',
      metrics: { durationMs: elapsed(started) },
    }));
  }
  const updatedIndex = indexProjection(host.getProjection());
  const updatedEntry = updatedIndex.nodes.get(params.nodeId);
  data.affectedNodeIds = data.affectedNodeIds.filter((nodeId) => updatedIndex.nodes.has(nodeId));
  if (updatedEntry) data.revisions = { [params.nodeId]: revisionOf(updatedEntry) };
  return nodeToolResult(successEnvelope('node_edit', data, {
    metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
  }), visibleEditResult(data, false, updatedIndex));
}

async function executeDefinitionMergeEdit(
  host: OutlinerToolHost,
  params: Extract<NormalizedEditParams, { action: 'merge_definition' }>,
  started: number,
  options: NodeToolsOptions,
) {
  const index = indexProjection(host.getProjection());
  const requestedScopeIssue = validateNodeResourceScope(options, index, [params.nodeId, ...params.mergeFromNodeIds], 'write');
  if (requestedScopeIssue) {
    return nodeScopeError<NodeEditData>('node_edit', requestedScopeIssue, started);
  }
  const validation = validateMutableNodeIds(index, [params.nodeId, ...params.mergeFromNodeIds]);
  if (validation) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', validation.code, validation.error, {
      instructions: validation.instructions,
      metrics: { durationMs: elapsed(started) },
    }));
  }
  const preview = definitionMergePreview(index, params.nodeId, params.mergeFromNodeIds, params.existingValues);
  if ('error' in preview) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', preview.code, preview.error, {
      instructions: preview.instructions,
      metrics: { durationMs: elapsed(started) },
    }));
  }
  const affectedScopeIssue = validateNodeResourceScope(options, index, preview.affectedNodeIds, 'write');
  if (affectedScopeIssue) {
    return nodeScopeError<NodeEditData>('node_edit', affectedScopeIssue, started);
  }
  const target = requiredNode(index, params.nodeId);
  const data: NodeEditData = {
    action: 'merge_definition',
    status: 'updated',
    affectedNodeIds: preview.affectedNodeIds,
    definitionMerge: preview.merge,
    revisions: { [params.nodeId]: revisionOf(target) },
  };
  if (params.previewOnly) {
    return nodeToolResult(successEnvelope('node_edit', data, {
      status: 'unchanged',
      metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
    }), visibleEditResult(data, true, index));
  }

  try {
    await host.handle('merge_definitions', { targetId: params.nodeId, sourceIds: params.mergeFromNodeIds });
  } catch (error) {
    return nodeErrorResult(errorEnvelope<NodeEditData>('node_edit', 'mutation_failed', errorMessage(error), {
      instructions: 'Use node_read to refresh the target/source definition ids, verify they are the same definition kind and field type, then retry.',
      metrics: { durationMs: elapsed(started) },
    }));
  }

  const updatedIndex = indexProjection(host.getProjection());
  const updatedTarget = updatedIndex.nodes.get(params.nodeId);
  data.affectedNodeIds = data.affectedNodeIds.filter((nodeId) => updatedIndex.nodes.has(nodeId));
  data.revisions = updatedTarget ? { [params.nodeId]: revisionOf(updatedTarget) } : undefined;
  return nodeToolResult(successEnvelope('node_edit', data, {
    metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
  }), visibleEditResult(data, false, updatedIndex));
}

async function executeDefinitionCreate(
  host: OutlinerToolHost,
  definition: NodeDefinitionCreateParams,
  previewOnly: boolean,
  started: number,
  options: NodeToolsOptions,
): Promise<AgentToolResult<ToolEnvelope<NodeCreateData>>> {
  const initialIndex = indexProjection(host.getProjection());
  const schemaScopeIssue = validateNodeResourceScope(options, initialIndex, [SCHEMA_ID], 'write');
  if (schemaScopeIssue) return nodeScopeError<NodeCreateData>('node_create', schemaScopeIssue, started);
  const referenceScopeIssue = validateNodeResourceScope(options, initialIndex, definitionPatchNodeIds(definition.config ?? {}));
  if (referenceScopeIssue) return nodeScopeError<NodeCreateData>('node_create', referenceScopeIssue, started);
  const existing = findDefinitionByName(initialIndex, definition.kind, definition.name);
  const beforeConfig = existing ? projectDefinitionConfig(initialIndex, existing) : undefined;
  const projectedDefault = beforeConfig ?? defaultDefinitionConfig(definition.kind, definition.config);
  const projectedAfter = existing
    ? beforeConfig
    : applyProjectedDefinitionPatch(definition.kind, projectedDefault, definition.config ?? {});
  const dataBase: NodeCreateData = {
    parentId: SCHEMA_ID,
    createdRootIds: [],
    createdNodeIds: [],
    matchedNodeIds: existing ? [existing.id] : undefined,
    definition: {
      kind: definition.kind,
      nodeId: existing?.id ?? 'preview:new-definition',
      beforeConfig,
      afterConfig: projectedAfter,
      patch: definition.config,
    },
  };

  if (previewOnly) {
    const data: NodeCreateData = {
      ...dataBase,
      createdRootIds: [],
      createdNodeIds: [],
    };
    return nodeToolResult(successEnvelope('node_create', data, {
      status: 'unchanged',
      warnings: existing && definition.config ? ['Definition already exists; node_create preview will not change its config. Use node_edit configure_definition to update it.'] : undefined,
      metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
    }), visibleCreateResult(data, true, initialIndex));
  }

  if (existing) {
    const data: NodeCreateData = {
      ...dataBase,
      definition: {
        ...dataBase.definition!,
        nodeId: existing.id,
      },
    };
    return nodeToolResult(successEnvelope('node_create', data, {
      status: 'unchanged',
      warnings: definition.config ? ['Definition already existed; config was not changed. Use node_edit configure_definition to update it.'] : undefined,
      metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
    }), visibleCreateResult(data, false, initialIndex));
  }

  try {
    const createdId = definition.kind === 'field'
      ? focusFromOutcome(await host.handle('create_field_definition', {
        name: definition.name,
        fieldType: (definition.config as FieldConfigPatch | undefined)?.fieldType ?? 'plain',
      }))
      : focusFromOutcome(await host.handle('create_tag', { name: definition.name }));
    if (definition.config && Object.keys(definition.config).length > 0) {
      if (definition.kind === 'field') {
        await host.handle('set_field_config', { fieldId: createdId, patch: definition.config });
      } else {
        await host.handle('set_tag_config', { tagId: createdId, patch: definition.config });
      }
    }
    const updatedIndex = indexProjection(host.getProjection());
    const created = requiredNode(updatedIndex, createdId);
    const afterConfig = projectDefinitionConfig(updatedIndex, created);
    const data: NodeCreateData = {
      parentId: SCHEMA_ID,
      createdRootIds: [createdId],
      createdNodeIds: [createdId],
      createdFieldDefIds: definition.kind === 'field' ? [createdId] : undefined,
      createdTagIds: definition.kind === 'tag' ? [createdId] : undefined,
      definition: {
        kind: definition.kind,
        nodeId: createdId,
        afterConfig,
        patch: definition.config,
      },
    };
    return nodeToolResult(successEnvelope('node_create', data, {
      metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
    }), visibleCreateResult(data, false, updatedIndex));
  } catch (error) {
    return nodeErrorResult(errorEnvelope('node_create', 'mutation_failed', errorMessage(error), {
      instructions: 'Verify referenced tag/option ids in definition.config and retry with a smaller config patch.',
      metrics: { durationMs: elapsed(started) },
    }));
  }
}

function definitionKind(node: NodeProjection): 'field' | 'tag' | null {
  if (node.type === 'fieldDef') return 'field';
  if (node.type === 'tagDef') return 'tag';
  return null;
}

function findDefinitionByName(index: ProjectionIndex, kind: 'field' | 'tag', name: string): NodeProjection | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  return index.projection.nodes.find((node) =>
    node.type === (kind === 'field' ? 'fieldDef' : 'tagDef')
    && node.parentId === SCHEMA_ID
    && node.content.text.trim().toLowerCase() === key
    && !isInTrash(index, node.id));
}

function projectDefinitionConfig(index: ProjectionIndex, node: NodeProjection): ProjectedDefinitionConfig {
  if (node.type === 'fieldDef') return projectFieldConfig(index.nodes, node);
  if (node.type === 'tagDef') return projectTagConfig(index.nodes, node);
  throw new Error(`Node is not a definition: ${node.id}`);
}

function defaultDefinitionConfig(kind: 'field' | 'tag', patch: FieldConfigPatch | TagConfigPatch | undefined): ProjectedDefinitionConfig {
  if (kind === 'field') {
    return {
      fieldType: (patch as FieldConfigPatch | undefined)?.fieldType ?? 'plain',
      sourceSupertag: undefined,
      nullable: true,
      hideField: 'never',
      autoInitialize: [],
      autocollectOptions: false,
      minValue: undefined,
      maxValue: undefined,
    };
  }
  return {
    color: undefined,
    extends: undefined,
    childSupertag: undefined,
    showCheckbox: false,
    doneStateEnabled: false,
    doneMapChecked: [],
    doneMapUnchecked: [],
  };
}

function applyProjectedDefinitionPatch(
  kind: 'field' | 'tag',
  config: ProjectedDefinitionConfig,
  patch: FieldConfigPatch | TagConfigPatch,
): ProjectedDefinitionConfig {
  if (kind === 'field') {
    const current = config as Extract<ProjectedDefinitionConfig, { fieldType: string }>;
    const fieldPatch = patch as FieldConfigPatch;
    const nextFieldType = fieldPatch.fieldType ?? current.fieldType;
    return {
      ...current,
      fieldType: nextFieldType,
      sourceSupertag: 'sourceSupertag' in fieldPatch
        ? fieldPatch.sourceSupertag ?? undefined
        : nextFieldType === 'options_from_supertag' ? current.sourceSupertag : undefined,
      nullable: 'nullable' in fieldPatch ? fieldPatch.nullable ?? true : current.nullable,
      hideField: 'hideField' in fieldPatch ? fieldPatch.hideField ?? 'never' : current.hideField,
      autoInitialize: 'autoInitialize' in fieldPatch
        ? splitAutoInitialize(fieldPatch.autoInitialize)
        : current.autoInitialize,
      autocollectOptions: fieldPatch.autocollectOptions ?? (nextFieldType === 'options' ? current.autocollectOptions : false),
      minValue: 'minValue' in fieldPatch ? fieldPatch.minValue ?? undefined : nextFieldType === 'number' ? current.minValue : undefined,
      maxValue: 'maxValue' in fieldPatch ? fieldPatch.maxValue ?? undefined : nextFieldType === 'number' ? current.maxValue : undefined,
    };
  }
  const current = config as Extract<ProjectedDefinitionConfig, { showCheckbox: boolean }>;
  const tagPatch = patch as TagConfigPatch;
  return {
    ...current,
    color: 'color' in tagPatch ? tagPatch.color ?? undefined : current.color,
    extends: 'extends' in tagPatch ? tagPatch.extends ?? undefined : current.extends,
    childSupertag: 'childSupertag' in tagPatch ? tagPatch.childSupertag ?? undefined : current.childSupertag,
    showCheckbox: tagPatch.showCheckbox ?? current.showCheckbox,
    doneStateEnabled: tagPatch.doneStateEnabled ?? current.doneStateEnabled,
    doneMapChecked: tagPatch.doneMapChecked ?? current.doneMapChecked,
    doneMapUnchecked: tagPatch.doneMapUnchecked ?? current.doneMapUnchecked,
  };
}

function splitAutoInitialize(value: string | null | undefined): string[] {
  return value?.split(',').map((strategy) => strategy.trim()).filter(Boolean) ?? [];
}

function presentPatchKeys<K extends readonly string[]>(
  patch: FieldConfigPatch | TagConfigPatch,
  keys: K,
): string[] {
  const input = patch as Record<string, unknown>;
  return keys.filter((key) => hasOwn(input, key));
}

function validateFieldDefinitionPatchAgainstExistingValues(
  index: ProjectionIndex,
  fieldDef: NodeProjection,
  patch: FieldConfigPatch,
  strategy: 'validate',
): DefinitionValueValidationReport {
  const fieldType = patch.fieldType;
  const fieldEntries = activeFieldEntriesForDefinition(index, fieldDef.id);
  const checkedFieldEntryIds = fieldEntries.map((entry) => entry.id);
  if (!fieldType) return { strategy, checkedFieldEntryIds };
  const incompatibleValues: DefinitionIncompatibleValue[] = [];
  for (const entry of fieldEntries) {
    for (const value of fieldResolutionValuesFromEntry(index, entry)) {
      const validation = validateFieldValuesForType(fieldName(index, entry), fieldType, [value]);
      if (!validation.ok) {
        incompatibleValues.push({
          fieldEntryId: entry.id,
          valueNodeId: value.valueNodeId,
          value: value.text,
          reason: validation.error,
        });
      }
    }
  }
  return { strategy, checkedFieldEntryIds, incompatibleValues: incompatibleValues.length ? incompatibleValues : undefined };
}

function activeFieldEntriesForDefinition(index: ProjectionIndex, fieldDefId: NodeId): Extract<NodeProjection, { type: 'fieldEntry' }>[] {
  return index.projection.nodes.filter((node): node is Extract<NodeProjection, { type: 'fieldEntry' }> =>
    node.type === 'fieldEntry'
    && node.fieldDefId === fieldDefId
    && !isInTrash(index, node.id));
}

function fieldResolutionValuesFromEntry(
  index: ProjectionIndex,
  entry: Extract<NodeProjection, { type: 'fieldEntry' }>,
): Array<FieldResolutionValue & { valueNodeId?: string }> {
  return entry.children
    .map((childId) => index.nodes.get(childId))
    .filter((value): value is NodeProjection => Boolean(value) && !isInTrash(index, value!.id))
    .map((value) => ({
      valueNodeId: value.id,
      text: value.content.text,
      targetId: value.type === 'reference' ? value.targetId : undefined,
      hasInlineRefs: value.content.inlineRefs.length > 0,
    }));
}

function definitionMergePreview(
  index: ProjectionIndex,
  targetNodeId: string,
  sourceNodeIds: string[],
  existingValues: 'validate',
): { merge: NodeDefinitionMerge; affectedNodeIds: string[] } | { code: string; error: string; instructions: string } {
  const target = requiredNode(index, targetNodeId);
  const kind = definitionKind(target);
  if (!kind) {
    return {
      code: 'invalid_definition_target',
      error: `Node is not a tag or field definition: ${targetNodeId}`,
      instructions: 'Use merge_definition only with a fieldDef or tagDef target node.',
    };
  }
  if (sourceNodeIds.includes(targetNodeId)) {
    return {
      code: 'invalid_definition_merge',
      error: 'merge_from_node_ids cannot include the target definition.',
      instructions: 'Pass only duplicate source definitions in merge_from_node_ids.',
    };
  }
  const sourceNodes = sourceNodeIds.map((sourceId) => requiredNode(index, sourceId));
  const wrongKind = sourceNodes.find((node) => definitionKind(node) !== kind);
  if (wrongKind) {
    return {
      code: 'invalid_definition_merge',
      error: `Definition merge requires all sources to be ${kind} definitions: ${wrongKind.id}`,
      instructions: 'Split field and tag merges into separate node_edit merge_definition calls.',
    };
  }

  if (kind === 'field') {
    const targetConfig = projectFieldConfig(index.nodes, target);
    for (const source of sourceNodes) {
      const sourceConfig = projectFieldConfig(index.nodes, source);
      if (sourceConfig.fieldType !== targetConfig.fieldType) {
        return {
          code: 'incompatible_definition_merge',
          error: `Field definition merge currently requires matching field types: ${source.id} is ${sourceConfig.fieldType}, target is ${targetConfig.fieldType}.`,
          instructions: 'Change the source or target field type first, or migrate values explicitly before merging definitions.',
        };
      }
      if (sourceConfig.fieldType === 'options_from_supertag' && sourceConfig.sourceSupertag !== targetConfig.sourceSupertag) {
        return {
          code: 'incompatible_definition_merge',
          error: `options_from_supertag field definitions require the same source supertag before merge: ${source.id}.`,
          instructions: 'Set the same source_supertag on the definitions before merging.',
        };
      }
      const validation = validateFieldDefinitionPatchAgainstExistingValues(index, source, { fieldType: targetConfig.fieldType as FieldType }, existingValues);
      if (validation.incompatibleValues?.length) {
        return {
          code: 'incompatible_existing_values',
          error: `Source field values are incompatible with target field type: ${source.id}`,
          instructions: 'Fix or clear incompatible source field values before merging definitions.',
        };
      }
    }
    const relinkedFieldEntryIds: string[] = [];
    const mergedFieldEntryIds: string[] = [];
    const targetReferenceIds = targetReferenceNodeIds(index, sourceNodeIds);
    const inlineReferenceNodeIds = inlineReferenceHostNodeIds(index, sourceNodeIds);
    for (const source of sourceNodes) {
      for (const entry of activeFieldEntriesForDefinition(index, source.id)) {
        const ownerId = entry.parentId;
        const targetEntry = ownerId
          ? requiredNode(index, ownerId).children
            .map((childId) => index.nodes.get(childId))
            .find((child) => child?.type === 'fieldEntry' && child.fieldDefId === targetNodeId && !isInTrash(index, child.id))
          : undefined;
        if (targetEntry) mergedFieldEntryIds.push(entry.id);
        else relinkedFieldEntryIds.push(entry.id);
      }
    }
    const merge: NodeDefinitionMerge = {
      kind,
      targetNodeId,
      sourceNodeIds,
      relinkedFieldEntryIds: relinkedFieldEntryIds.length ? unique(relinkedFieldEntryIds) : undefined,
      mergedFieldEntryIds: mergedFieldEntryIds.length ? unique(mergedFieldEntryIds) : undefined,
      rewrittenReferenceIds: targetReferenceIds.length ? targetReferenceIds : undefined,
      rewrittenInlineReferenceNodeIds: inlineReferenceNodeIds.length ? inlineReferenceNodeIds : undefined,
    };
    return {
      merge,
      affectedNodeIds: unique([
        targetNodeId,
        ...sourceNodeIds,
        ...relinkedFieldEntryIds,
        ...mergedFieldEntryIds,
        ...targetReferenceIds,
        ...inlineReferenceNodeIds,
      ]),
    };
  }

  const retaggedNodeIds = index.projection.nodes
    .filter((node) => sourceNodeIds.some((sourceId) => node.tags.includes(sourceId)) && !isInTrash(index, node.id))
    .map((node) => node.id);
  const rewrittenReferenceIds = targetReferenceNodeIds(index, sourceNodeIds);
  const rewrittenInlineReferenceNodeIds = inlineReferenceHostNodeIds(index, sourceNodeIds);
  const merge: NodeDefinitionMerge = {
    kind,
    targetNodeId,
    sourceNodeIds,
    retaggedNodeIds: retaggedNodeIds.length ? unique(retaggedNodeIds) : undefined,
    rewrittenReferenceIds: rewrittenReferenceIds.length ? rewrittenReferenceIds : undefined,
    rewrittenInlineReferenceNodeIds: rewrittenInlineReferenceNodeIds.length ? rewrittenInlineReferenceNodeIds : undefined,
  };
  return {
    merge,
    affectedNodeIds: unique([
      targetNodeId,
      ...sourceNodeIds,
      ...retaggedNodeIds,
      ...rewrittenReferenceIds,
      ...rewrittenInlineReferenceNodeIds,
    ]),
  };
}

function targetReferenceNodeIds(index: ProjectionIndex, targetIds: string[]): string[] {
  const targets = new Set(targetIds);
  return index.projection.nodes
    .filter((node) =>
      !isInTrash(index, node.id)
      && (
        (node.type === 'reference' && node.targetId && targets.has(node.targetId))
        || ((node.type === 'search' || node.type === 'queryCondition') && (
          (node.queryFieldDefId && targets.has(node.queryFieldDefId))
          || (node.queryTagDefId && targets.has(node.queryTagDefId))
          || (node.queryTargetId && targets.has(node.queryTargetId))
        ))
        || (node.type === 'viewDef' && node.groupField && targets.has(node.groupField))
        || (node.type === 'sortRule' && node.sortField && targets.has(node.sortField))
        || (node.type === 'filterRule' && node.filterField && targets.has(node.filterField))
        || (node.type === 'displayField' && node.displayField && targets.has(node.displayField))
      ))
    .map((node) => node.id);
}

function inlineReferenceHostNodeIds(index: ProjectionIndex, targetIds: string[]): string[] {
  const targets = new Set(targetIds);
  return index.projection.nodes
    .filter((node) =>
      !isInTrash(index, node.id)
      && node.content.inlineRefs.some((ref) => ref.target.kind === 'node' && targets.has(ref.target.nodeId)))
    .map((node) => node.id);
}

function definitionPatchNodeIds(patch: FieldConfigPatch | TagConfigPatch): string[] {
  const fieldPatch = patch as FieldConfigPatch;
  const tagPatch = patch as TagConfigPatch;
  return unique([
    fieldPatch.sourceSupertag,
    tagPatch.extends,
    tagPatch.childSupertag,
    ...(tagPatch.doneMapChecked ?? []),
    ...(tagPatch.doneMapUnchecked ?? []),
  ].filter((nodeId): nodeId is string => typeof nodeId === 'string' && nodeId.length > 0));
}

function definitionConfigAffectedNodeIds(index: ProjectionIndex, node: NodeProjection): string[] {
  if (node.type === 'fieldDef') {
    return unique([
      node.id,
      ...activeFieldEntriesForDefinition(index, node.id)
        .flatMap((entry) => [...descendantNodeIdSet(index, entry.id, true)]),
    ]);
  }
  if (node.type === 'tagDef') {
    return unique([
      node.id,
      ...index.projection.nodes
        .filter((candidate) => !isInTrash(index, candidate.id) && candidate.tags.includes(node.id))
        .map((candidate) => candidate.id),
    ]);
  }
  return [node.id];
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
        return nodeErrorResult(errorEnvelope<NodeCreateData>('node_create', 'invalid_args', params.error, {
          instructions: 'Call node_create with exactly one of outline, target_id, duplicate_id, or definition.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      if (params.definition) {
        return executeDefinitionCreate(host, params.definition, params.previewOnly === true, started, options);
      }

      const initialIndex = indexProjection(host.getProjection());
      const insertion = resolveInsertion(initialIndex, params);
      if ('error' in insertion) {
        return nodeErrorResult(errorEnvelope('node_create', insertion.code, insertion.error, {
          instructions: insertion.instructions,
          metrics: { durationMs: elapsed(started) },
        }));
      }
      const insertionScopeIssue = validateNodeResourceScope(options, initialIndex, [
        insertion.parentId,
        ...(typeof insertion.afterId === 'string' ? [insertion.afterId] : []),
      ], 'write');
      if (insertionScopeIssue) {
        return nodeScopeError<NodeCreateData>('node_create', insertionScopeIssue, started);
      }
      const sourceScopeIssue = validateNodeResourceScope(options, initialIndex, [
        ...(params.targetId ? [params.targetId] : []),
        ...(params.duplicateId ? [...descendantNodeIdSet(initialIndex, params.duplicateId, false)] : []),
      ]);
      if (sourceScopeIssue) {
        return nodeScopeError<NodeCreateData>('node_create', sourceScopeIssue, started);
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
      const referenceValidation = await validateOutlineReferenceTargets(options, initialIndex, parsed.document);
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
        const usedFieldIds = new Set<string>();
        for (const field of parsed.document.fields) {
          const latest = indexProjection(host.getProjection());
          const resolution = resolveFieldWriteTarget(
            fieldResolutionMap(latest),
            insertion.parentId,
            field.name,
            fieldResolutionValues(field),
            { isDeleted: (nodeId) => isInTrash(latest, nodeId) },
          );
          if (!resolution.ok) throw new Error(`${resolution.error} ${resolution.instructions}`);
          await applyResolvedField(host, insertion.parentId, field, resolution.target, tracker, warnings, {
            index: fieldSectionInsertIndex(latest, insertion.parentId),
            usedFieldIds,
          });
        }
        if (parsed.document.fields.length > 0) {
          insertIndex = currentRootInsertionIndex(indexProjection(host.getProjection()), insertion);
        }
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
        matchedNodeIds: tracker.matchedNodeIds.length ? tracker.matchedNodeIds : undefined,
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

function createNodeReadTool(host: OutlinerToolHost, options: NodeToolsOptions): AgentTool<any, ToolEnvelope<NodeReadData>> {
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
      if (params.includeBacklinks && hasNodeResourceScope(options)) {
        return nodeScopeError<NodeReadData>('node_read', {
          nodeId: 'backlinks',
          error: 'Backlinks can expose nodes outside this run scope.',
        }, started);
      }
      const scopeIssue = validateNodeResourceScope(
        options,
        index,
        nodeIds.flatMap((nodeId) => readVisibleNodeIds(index, nodeId, params)),
      );
      if (scopeIssue) {
        return nodeScopeError<NodeReadData>('node_read', scopeIssue, started);
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

function createNodeSearchTool(host: OutlinerToolHost, options: NodeToolsOptions): AgentTool<any, ToolEnvelope<NodeSearchResultData>> {
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
        return nodeErrorResult(errorEnvelope<NodeSearchResultData>('node_search', 'invalid_args', params.error, {
          instructions: 'Use exactly one single search source (outline or search_node_id), or use count true with queries for a batch count.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      const index = indexProjection(host.getProjection());
      if (params.mode === 'batch_count') {
        return executeNodeSearchBatchCount(host, index, params, started, options);
      }
      const offset = clampInteger(params.offset, 0, Number.MAX_SAFE_INTEGER, 0);
      const limit = clampInteger(params.limit, 1, 50, 20);
      if (params.searchNodeId) {
        const scopeIssue = validateNodeResourceScope(options, index, [params.searchNodeId]);
        if (scopeIssue) {
          return nodeScopeError<NodeSearchData>('node_search', scopeIssue, started);
        }
      }
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
        transientSearchOptions: host.getTransientSearchOptions?.(),
      });
      if ('error' in resultIds) {
        return nodeErrorResult(errorEnvelope('node_search', resultIds.code, resultIds.error, {
          instructions: resultIds.instructions,
          metrics: { durationMs: elapsed(started) },
        }));
      }
      const scopedResultIds = filterNodeResourceScope(options, index, resultIds);
      const total = scopedResultIds.length;
      const pageIds = scopedResultIds.slice(offset, offset + limit);
      const items = params.count ? undefined : pageIds.map((nodeId) => buildSearchItem(index, nodeId, search.queryTerms));
      if (!params.count) {
        try {
          void Promise.resolve(host.recordNodeAccess?.(pageIds, 'agentRecall')).catch(() => undefined);
        } catch {
          // Access ranking is best-effort and must not affect tool results.
        }
      }
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
      }), visible, { omitInstructions: true });
    },
  };
}

function executeNodeSearchBatchCount(
  host: OutlinerToolHost,
  index: ProjectionIndex,
  params: NormalizedBatchCountSearchParams,
  started: number,
  options: NodeToolsOptions,
): AgentToolResult<ToolEnvelope<NodeSearchResultData>> {
  let commonQuery: SearchQueryExpr | undefined;
  if (params.commonQuery) {
    const resolved = resolveSearchQueryFragment(index, params.commonQuery);
    if ('error' in resolved) {
      return nodeErrorResult(errorEnvelope<NodeSearchResultData>('node_search', resolved.code, `common_query: ${resolved.error}`, {
        instructions: resolved.instructions,
        metrics: { durationMs: elapsed(started) },
      }));
    }
    commonQuery = resolved;
  }

  const queries: Array<{ name: string; query: SearchQueryExpr }> = [];
  for (const item of params.queries) {
    const resolved = resolveSearchQueryFragment(index, item.query);
    if ('error' in resolved) {
      return nodeErrorResult(errorEnvelope<NodeSearchResultData>('node_search', resolved.code, `Query "${item.name}": ${resolved.error}`, {
        instructions: resolved.instructions,
        metrics: { durationMs: elapsed(started) },
      }));
    }
    queries.push({
      name: item.name,
      query: combineSearchQueryFragments(commonQuery, resolved),
    });
  }

  const validationTargets: Array<{ name?: string; query: SearchQueryExpr }> = [
    ...(commonQuery ? [{ query: commonQuery }] : []),
    ...queries,
  ];
  const validation = validateSearchQueries(index.projection, validationTargets.map((item) => item.query));
  if (!validation.ok) {
    const item = validationTargets[validation.queryIndex];
    const label = item?.name ? `Query "${item.name}"` : 'common_query';
    return nodeErrorResult(errorEnvelope<NodeSearchResultData>('node_search', validation.issue.code, `${label}: ${validation.issue.message}`, {
      instructions: 'Fix the canonical search query tree and retry.',
      metrics: { durationMs: elapsed(started) },
    }));
  }

  const results: NodeSearchBatchCountData['results'] = [];
  const searchOptions = {
    textIndex: host.getTextSearchIndex?.(),
    transientSearchOptions: host.getTransientSearchOptions?.(),
  };
  for (const item of queries) {
    const queryStarted = Date.now();
    const resultIds = runSearch(index, { query: item.query }, searchOptions);
    if ('error' in resultIds) {
      return nodeErrorResult(errorEnvelope<NodeSearchResultData>('node_search', resultIds.code, `Query "${item.name}": ${resultIds.error}`, {
        instructions: resultIds.instructions,
        metrics: { durationMs: elapsed(started) },
      }));
    }
    results.push({
      name: item.name,
      query: item.query,
      total: filterNodeResourceScope(options, index, resultIds).length,
      durationMs: elapsed(queryStarted),
    });
  }

  const data: NodeSearchBatchCountData = {
    commonQuery,
    results,
  };
  return nodeToolResult(successEnvelope<NodeSearchResultData>('node_search', data, {
    metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
  }), visibleSearchBatchCountResult(data));
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
  const definitionResult = normalizeDefinitionCreateParams(input.definition);
  if (definitionResult.error) {
    return { previewOnly: input.preview_only === true, error: definitionResult.error };
  }
  if (definitionResult.definition && (parentId !== undefined || afterId !== undefined)) {
    return { previewOnly: input.preview_only === true, error: 'definition creates under Schema; omit parent_id and after_id.' };
  }
  const provided = [outline, targetId, duplicateId, definitionResult.definition].filter(Boolean).length;
  return {
    parentId,
    afterId,
    outline,
    targetId,
    duplicateId,
    definition: definitionResult.definition,
    previewOnly: input.preview_only === true,
    error: provided === 1 ? undefined : 'Exactly one of outline, target_id, duplicate_id, or definition is required.',
  };
}

type DefinitionPatchNormalizeResult = {
  provided: boolean;
  patch: FieldConfigPatch | TagConfigPatch;
  fieldKeys: string[];
  tagKeys: string[];
  error?: string;
};

const FIELD_TYPES: readonly FieldType[] = [
  'plain',
  'options',
  'options_from_supertag',
  'date',
  'number',
  'url',
  'email',
  'checkbox',
];

const HIDE_FIELD_MODES: readonly HideFieldMode[] = ['never', 'empty', 'not_empty', 'value_is_default', 'always'];

const FIELD_PATCH_KEYS = [
  'fieldType',
  'sourceSupertag',
  'nullable',
  'hideField',
  'autoInitialize',
  'autocollectOptions',
  'minValue',
  'maxValue',
] as const;

const TAG_PATCH_KEYS = [
  'color',
  'extends',
  'childSupertag',
  'showCheckbox',
  'doneStateEnabled',
  'doneMapChecked',
  'doneMapUnchecked',
] as const;

function normalizeDefinitionCreateParams(value: unknown): { definition?: NodeDefinitionCreateParams; error?: string } {
  if (value === undefined) return {};
  const input = asRecord(value);
  if (Object.keys(input).length === 0) return { error: 'definition must be an object with kind and name.' };
  const kind = input.kind === 'field' || input.kind === 'tag' ? input.kind : undefined;
  if (!kind) return { error: 'definition.kind must be "field" or "tag".' };
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : undefined;
  if (!name) return { error: 'definition.name is required.' };
  const patchResult = normalizeDefinitionPatchParams(input.config);
  if (patchResult.error) return { error: patchResult.error.replace('definition_patch', 'definition.config') };
  if (kind === 'field' && patchResult.tagKeys.length > 0) {
    return { error: `field definitions cannot use tag config keys: ${patchResult.tagKeys.join(', ')}.` };
  }
  if (kind === 'tag' && patchResult.fieldKeys.length > 0) {
    return { error: `tag definitions cannot use field config keys: ${patchResult.fieldKeys.join(', ')}.` };
  }
  return {
    definition: {
      kind,
      name,
      config: patchResult.provided && Object.keys(patchResult.patch).length > 0 ? patchResult.patch : undefined,
    },
  };
}

function normalizeDefinitionPatchParams(value: unknown): DefinitionPatchNormalizeResult {
  if (value === undefined) return { provided: false, patch: {}, fieldKeys: [], tagKeys: [] };
  const input = asRecord(value);
  if (Object.keys(input).length === 0 && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    return { provided: true, patch: {}, fieldKeys: [], tagKeys: [], error: 'definition_patch must be an object.' };
  }
  const patch: FieldConfigPatch & TagConfigPatch = {};
  const fieldKeys: string[] = [];
  const tagKeys: string[] = [];

  const fieldType = readAliasedValue(input, 'field_type', 'fieldType');
  if (fieldType.error) return failedDefinitionPatch(fieldType.error);
  if (fieldType.provided) {
    if (!isFieldType(fieldType.value)) return failedDefinitionPatch('definition_patch.field_type must be a supported field type.');
    patch.fieldType = fieldType.value;
    fieldKeys.push('field_type');
  }

  const sourceSupertag = readAliasedValue(input, 'source_supertag', 'sourceSupertag');
  if (sourceSupertag.error) return failedDefinitionPatch(sourceSupertag.error);
  if (sourceSupertag.provided) {
    const parsed = stringOrNull(sourceSupertag.value, 'definition_patch.source_supertag');
    if ('error' in parsed) return failedDefinitionPatch(parsed.error);
    patch.sourceSupertag = parsed.value;
    fieldKeys.push('source_supertag');
  }

  const autocollectOptions = readAliasedValue(input, 'autocollect_options', 'autocollectOptions');
  if (autocollectOptions.error) return failedDefinitionPatch(autocollectOptions.error);
  if (autocollectOptions.provided) {
    if (typeof autocollectOptions.value !== 'boolean') return failedDefinitionPatch('definition_patch.autocollect_options must be boolean.');
    patch.autocollectOptions = autocollectOptions.value;
    fieldKeys.push('autocollect_options');
  }

  const autoInitialize = readAliasedValue(input, 'auto_initialize', 'autoInitialize');
  if (autoInitialize.error) return failedDefinitionPatch(autoInitialize.error);
  if (autoInitialize.provided) {
    const parsed = stringOrNull(autoInitialize.value, 'definition_patch.auto_initialize', { allowEmptyString: true });
    if ('error' in parsed) return failedDefinitionPatch(parsed.error);
    patch.autoInitialize = parsed.value;
    fieldKeys.push('auto_initialize');
  }

  const nullable = readAliasedValue(input, 'nullable');
  if (nullable.error) return failedDefinitionPatch(nullable.error);
  const required = readAliasedValue(input, 'required');
  if (required.error) return failedDefinitionPatch(required.error);
  if (nullable.provided) {
    if (nullable.value !== null && typeof nullable.value !== 'boolean') return failedDefinitionPatch('definition_patch.nullable must be boolean or null.');
    patch.nullable = nullable.value;
    fieldKeys.push('nullable');
  }
  if (required.provided) {
    if (typeof required.value !== 'boolean') return failedDefinitionPatch('definition_patch.required must be boolean.');
    const requiredNullable = !required.value;
    if (nullable.provided && nullable.value !== null && nullable.value !== requiredNullable) {
      return failedDefinitionPatch('definition_patch cannot provide conflicting nullable and required values.');
    }
    if (!nullable.provided) {
      patch.nullable = requiredNullable;
      fieldKeys.push('required');
    }
  }

  const hideField = readAliasedValue(input, 'hide_field', 'hideField');
  if (hideField.error) return failedDefinitionPatch(hideField.error);
  if (hideField.provided) {
    if (hideField.value !== null && !isHideFieldMode(hideField.value)) {
      return failedDefinitionPatch('definition_patch.hide_field must be a supported hide mode or null.');
    }
    patch.hideField = hideField.value;
    fieldKeys.push('hide_field');
  }

  const minValue = readAliasedValue(input, 'min_value', 'minValue');
  if (minValue.error) return failedDefinitionPatch(minValue.error);
  if (minValue.provided) {
    const parsed = numberOrNull(minValue.value, 'definition_patch.min_value');
    if ('error' in parsed) return failedDefinitionPatch(parsed.error);
    patch.minValue = parsed.value;
    fieldKeys.push('min_value');
  }

  const maxValue = readAliasedValue(input, 'max_value', 'maxValue');
  if (maxValue.error) return failedDefinitionPatch(maxValue.error);
  if (maxValue.provided) {
    const parsed = numberOrNull(maxValue.value, 'definition_patch.max_value');
    if ('error' in parsed) return failedDefinitionPatch(parsed.error);
    patch.maxValue = parsed.value;
    fieldKeys.push('max_value');
  }

  const color = readAliasedValue(input, 'color');
  if (color.error) return failedDefinitionPatch(color.error);
  if (color.provided) {
    const parsed = stringOrNull(color.value, 'definition_patch.color');
    if ('error' in parsed) return failedDefinitionPatch(parsed.error);
    patch.color = parsed.value;
    tagKeys.push('color');
  }

  const extendsTag = readAliasedValue(input, 'extends');
  if (extendsTag.error) return failedDefinitionPatch(extendsTag.error);
  if (extendsTag.provided) {
    const parsed = stringOrNull(extendsTag.value, 'definition_patch.extends');
    if ('error' in parsed) return failedDefinitionPatch(parsed.error);
    patch.extends = parsed.value;
    tagKeys.push('extends');
  }

  const childSupertag = readAliasedValue(input, 'child_supertag', 'childSupertag');
  if (childSupertag.error) return failedDefinitionPatch(childSupertag.error);
  if (childSupertag.provided) {
    const parsed = stringOrNull(childSupertag.value, 'definition_patch.child_supertag');
    if ('error' in parsed) return failedDefinitionPatch(parsed.error);
    patch.childSupertag = parsed.value;
    tagKeys.push('child_supertag');
  }

  const showCheckbox = readAliasedValue(input, 'show_checkbox', 'showCheckbox');
  if (showCheckbox.error) return failedDefinitionPatch(showCheckbox.error);
  if (showCheckbox.provided) {
    if (typeof showCheckbox.value !== 'boolean') return failedDefinitionPatch('definition_patch.show_checkbox must be boolean.');
    patch.showCheckbox = showCheckbox.value;
    tagKeys.push('show_checkbox');
  }

  const doneStateEnabled = readAliasedValue(input, 'done_state_enabled', 'doneStateEnabled');
  if (doneStateEnabled.error) return failedDefinitionPatch(doneStateEnabled.error);
  if (doneStateEnabled.provided) {
    if (typeof doneStateEnabled.value !== 'boolean') return failedDefinitionPatch('definition_patch.done_state_enabled must be boolean.');
    patch.doneStateEnabled = doneStateEnabled.value;
    tagKeys.push('done_state_enabled');
  }

  const doneMapChecked = readAliasedValue(input, 'done_map_checked', 'doneMapChecked');
  if (doneMapChecked.error) return failedDefinitionPatch(doneMapChecked.error);
  if (doneMapChecked.provided) {
    const parsed = stringArray(doneMapChecked.value, 'definition_patch.done_map_checked');
    if ('error' in parsed) return failedDefinitionPatch(parsed.error);
    patch.doneMapChecked = parsed.value;
    tagKeys.push('done_map_checked');
  }

  const doneMapUnchecked = readAliasedValue(input, 'done_map_unchecked', 'doneMapUnchecked');
  if (doneMapUnchecked.error) return failedDefinitionPatch(doneMapUnchecked.error);
  if (doneMapUnchecked.provided) {
    const parsed = stringArray(doneMapUnchecked.value, 'definition_patch.done_map_unchecked');
    if ('error' in parsed) return failedDefinitionPatch(parsed.error);
    patch.doneMapUnchecked = parsed.value;
    tagKeys.push('done_map_unchecked');
  }

  return { provided: true, patch, fieldKeys, tagKeys };
}

function failedDefinitionPatch(error: string): DefinitionPatchNormalizeResult {
  return { provided: true, patch: {}, fieldKeys: [], tagKeys: [], error };
}

function readAliasedValue(input: Record<string, unknown>, key: string, alias?: string): { provided: boolean; value?: unknown; error?: string } {
  const hasKey = hasOwn(input, key);
  const hasAlias = alias ? hasOwn(input, alias) : false;
  if (!hasKey && !hasAlias) return { provided: false };
  if (hasKey && hasAlias && !sameJsonValue(input[key], input[alias!])) {
    return { provided: true, error: `definition_patch.${key} and ${alias} disagree.` };
  }
  return { provided: true, value: hasKey ? input[key] : input[alias!] };
}

function hasOwn(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stringOrNull(value: unknown, label: string, options: { allowEmptyString?: boolean } = {}): { value: string | null } | { error: string } {
  if (value === null) return { value: null };
  if (typeof value !== 'string') return { error: `${label} must be a string or null.` };
  const normalized = options.allowEmptyString ? value.trim() : value.trim();
  if (!normalized && !options.allowEmptyString) return { error: `${label} must be a non-empty string or null.` };
  return { value: normalized };
}

function numberOrNull(value: unknown, label: string): { value: number | null } | { error: string } {
  if (value === null) return { value: null };
  if (typeof value !== 'number' || !Number.isFinite(value)) return { error: `${label} must be a finite number or null.` };
  return { value };
}

function stringArray(value: unknown, label: string): { value: string[] } | { error: string } {
  if (!Array.isArray(value)) return { error: `${label} must be an array of node ids.` };
  const strings = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
  if (strings.length !== value.length) return { error: `${label} must contain only non-empty strings.` };
  return { value: strings };
}

function isFieldType(value: unknown): value is FieldType {
  return FIELD_TYPES.includes(value as FieldType);
}

function isHideFieldMode(value: unknown): value is HideFieldMode {
  return HIDE_FIELD_MODES.includes(value as HideFieldMode);
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
  const operation = normalizeEditOperation(input.operation);
  if (operation === null) return { error: 'operation must be one of replace_outline, move, merge, replace_with_reference, configure_definition, reuse_field_definition, or merge_definition.' };
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
  const definitionPatchResult = normalizeDefinitionPatchParams(input.definition_patch);
  if (definitionPatchResult.error) return { error: definitionPatchResult.error };
  const definitionPatch = definitionPatchResult.provided ? definitionPatchResult.patch : undefined;
  const existingValues = input.existing_values === undefined
    ? 'validate'
    : input.existing_values === 'validate'
      ? 'validate'
      : undefined;
  if (input.existing_values !== undefined && existingValues === undefined) {
    return { error: 'existing_values must be "validate".' };
  }
  const targetDefinitionId = typeof input.target_definition_id === 'string' && input.target_definition_id.trim()
    ? input.target_definition_id.trim()
    : undefined;
  const previewOnly = input.preview_only === true;

  const outlineAction = Boolean(nodeId && oldString !== undefined && newString !== undefined);
  const moveAction = Boolean(move !== undefined && (nodeId || nodeIds));
  const mergeAction = Boolean(nodeId && mergeFromNodeIds !== undefined);
  const referenceAction = Boolean(nodeId && replaceWithReferenceTo !== undefined);
  const configureDefinitionAction = Boolean(nodeId && definitionPatch !== undefined);
  const reuseFieldDefinitionAction = Boolean(nodeId && targetDefinitionId !== undefined);
  const inferredOperation = inferEditOperation({
    outlineAction,
    moveAction,
    mergeAction,
    referenceAction,
    configureDefinitionAction,
    reuseFieldDefinitionAction,
  });
  if (!operation && !inferredOperation) return { error: 'Exactly one node_edit operation is required. Prefer setting operation explicitly.' };
  const selectedOperation = operation ?? inferredOperation!;

  const extraFields = invalidEditOperationFields(selectedOperation, {
    nodeIds,
    oldString,
    newString,
    expectedRevision,
    move,
    mergeFromNodeIds,
    replaceWithReferenceTo,
    definitionPatch,
    existingValues: input.existing_values === undefined ? undefined : existingValues,
    targetDefinitionId,
  });
  if (extraFields.length > 0) {
    return { error: `operation "${selectedOperation}" cannot be combined with: ${extraFields.join(', ')}.` };
  }

  if (selectedOperation === 'replace_outline') {
    if (!nodeId) return { error: 'operation "replace_outline" requires node_id.' };
    if (oldString === undefined) return { error: 'operation "replace_outline" requires old_string.' };
    if (newString === undefined) return { error: 'operation "replace_outline" requires new_string.' };
    return { action: 'replace_outline', operation: selectedOperation, nodeId, oldString, newString, expectedRevision, previewOnly };
  }

  if (selectedOperation === 'move') {
    if (!move) return { error: 'operation "move" requires move.' };
    if (!nodeId && !nodeIds) return { error: 'operation "move" requires node_id or node_ids.' };
    if (nodeId && nodeIds) return { error: 'operation "move" accepts either node_id or node_ids, not both.' };
    return { action: 'move', operation: selectedOperation, nodeId, nodeIds: nodeIds ?? [nodeId!], move, previewOnly };
  }

  if (selectedOperation === 'merge') {
    if (!nodeId) return { error: 'operation "merge" requires node_id.' };
    if (mergeFromNodeIds === undefined) return { error: 'operation "merge" requires merge_from_node_ids.' };
    return { action: 'merge', operation: selectedOperation, nodeId, mergeFromNodeIds, previewOnly };
  }

  if (selectedOperation === 'merge_definition') {
    if (!nodeId) return { error: 'operation "merge_definition" requires node_id.' };
    if (mergeFromNodeIds === undefined) return { error: 'operation "merge_definition" requires merge_from_node_ids.' };
    return {
      action: 'merge_definition',
      operation: selectedOperation,
      nodeId,
      mergeFromNodeIds,
      existingValues: existingValues ?? 'validate',
      previewOnly,
    };
  }

  if (selectedOperation === 'replace_with_reference') {
    if (!nodeId) return { error: 'operation "replace_with_reference" requires node_id.' };
    if (!replaceWithReferenceTo) return { error: 'operation "replace_with_reference" requires replace_with_reference_to.' };
    return { action: 'replace_with_reference', operation: selectedOperation, nodeId, replaceWithReferenceTo, previewOnly };
  }

  if (selectedOperation === 'configure_definition') {
    if (!nodeId) return { error: 'operation "configure_definition" requires node_id.' };
    if (definitionPatch === undefined) return { error: 'operation "configure_definition" requires definition_patch.' };
    if (Object.keys(definitionPatch).length === 0) return { error: 'definition_patch must include at least one config key.' };
    return {
      action: 'configure_definition',
      operation: selectedOperation,
      nodeId,
      definitionPatch,
      existingValues: existingValues ?? 'validate',
      previewOnly,
    };
  }

  if (!nodeId) return { error: 'operation "reuse_field_definition" requires node_id.' };
  if (!targetDefinitionId) return { error: 'operation "reuse_field_definition" requires target_definition_id.' };
  return { action: 'reuse_field_definition', operation: selectedOperation, nodeId, targetDefinitionId, previewOnly };
}

function normalizeEditOperation(value: unknown): NodeEditParams['operation'] | undefined | null {
  if (value === undefined) return undefined;
  return value === 'replace_outline'
    || value === 'move'
    || value === 'merge'
    || value === 'replace_with_reference'
    || value === 'configure_definition'
    || value === 'reuse_field_definition'
    || value === 'merge_definition'
    ? value
    : null;
}

type ConcreteNodeEditOperation = NonNullable<NodeEditParams['operation']>;

function inferEditOperation(actions: {
  outlineAction: boolean;
  moveAction: boolean;
  mergeAction: boolean;
  referenceAction: boolean;
  configureDefinitionAction: boolean;
  reuseFieldDefinitionAction: boolean;
}): ConcreteNodeEditOperation | null {
  const provided = [
    actions.outlineAction ? 'replace_outline' : null,
    actions.moveAction ? 'move' : null,
    actions.mergeAction ? 'merge' : null,
    actions.referenceAction ? 'replace_with_reference' : null,
    actions.configureDefinitionAction ? 'configure_definition' : null,
    actions.reuseFieldDefinitionAction ? 'reuse_field_definition' : null,
  ].filter((value): value is ConcreteNodeEditOperation => value !== null);
  return provided.length === 1 ? provided[0]! : null;
}

function invalidEditOperationFields(operation: ConcreteNodeEditOperation, fields: {
  nodeIds?: string[];
  oldString?: string;
  newString?: string;
  expectedRevision?: string;
  move?: NodeEditMoveParams;
  mergeFromNodeIds?: string[];
  replaceWithReferenceTo?: string;
  definitionPatch?: FieldConfigPatch | TagConfigPatch;
  existingValues?: string;
  targetDefinitionId?: string;
}): string[] {
  const extras: string[] = [];
  if (operation !== 'replace_outline') {
    if (fields.oldString !== undefined) extras.push('old_string');
    if (fields.newString !== undefined) extras.push('new_string');
    if (fields.expectedRevision !== undefined) extras.push('expected_revision');
  }
  if (operation !== 'move') {
    if (fields.nodeIds !== undefined) extras.push('node_ids');
    if (fields.move !== undefined) extras.push('move');
  }
  if (operation !== 'merge' && operation !== 'merge_definition' && fields.mergeFromNodeIds !== undefined) extras.push('merge_from_node_ids');
  if (operation !== 'replace_with_reference' && fields.replaceWithReferenceTo !== undefined) extras.push('replace_with_reference_to');
  if (operation !== 'configure_definition') {
    if (fields.definitionPatch !== undefined) extras.push('definition_patch');
  }
  if (operation !== 'configure_definition' && operation !== 'merge_definition') {
    if (fields.existingValues !== undefined) extras.push('existing_values');
  }
  if (operation !== 'reuse_field_definition' && fields.targetDefinitionId !== undefined) extras.push('target_definition_id');
  return extras;
}

function normalizeOutlineUndoStackParams(rawParams: unknown): Required<Pick<OperationHistoryParams, 'action' | 'steps' | 'origin' | 'limit' | 'offset'>>
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

function currentRootInsertionIndex(
  index: ProjectionIndex,
  insertion: { parentId: string; afterId?: string | null; index: number | null },
): number | null {
  if (insertion.afterId === undefined) return null;
  if (insertion.afterId === null) return fieldSectionInsertIndex(index, insertion.parentId);
  const parent = requiredNode(index, insertion.parentId);
  const childIndex = parent.children.indexOf(insertion.afterId);
  if (childIndex < 0) throw new Error(`after_id is no longer a child of parent_id ${insertion.parentId}: ${insertion.afterId}`);
  return childIndex + 1;
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

function validateOrdinaryMergeNodeTypes(index: ProjectionIndex, targetNodeId: string, sourceNodeIds: string[]): { code: string; error: string; instructions: string } | null {
  const target = requiredNode(index, targetNodeId);
  if (!isContentNode(target)) {
    return {
      code: 'invalid_merge_node_type',
      error: `Ordinary merge requires a content-node target; ${targetNodeId} is ${displayNodeType(target)}.`,
      instructions: ordinaryMergeNodeTypeInstructions(target),
    };
  }
  for (const sourceNodeId of sourceNodeIds) {
    const source = requiredNode(index, sourceNodeId);
    if (!isContentNode(source)) {
      return {
        code: 'invalid_merge_node_type',
        error: `Ordinary merge requires content-node sources; ${sourceNodeId} is ${displayNodeType(source)}.`,
        instructions: ordinaryMergeNodeTypeInstructions(source),
      };
    }
  }
  return null;
}

function isContentNode(node: NodeProjection): boolean {
  return node.type === undefined;
}

function displayNodeType(node: NodeProjection): string {
  return node.type ?? 'content';
}

function ordinaryMergeNodeTypeInstructions(node: NodeProjection): string {
  if (node.type === 'fieldDef' || node.type === 'tagDef') {
    return 'Use node_edit operation "merge_definition" for field/tag definitions.';
  }
  return 'Use ordinary merge only for duplicate content nodes. Use dedicated field, reference, search, view, or delete operations for structural nodes.';
}

function replaceOutline(currentOutline: string, oldString: string, newString: string, rootNodeId: string): {
  ok: true;
  afterOutline: string;
} | { ok: false; code: string; error: string; instructions: string } {
  const normalizedOld = normalizeLineEndings(oldString);
  const normalizedNew = normalizeLineEndings(newString);
  if (normalizedOld === '*') {
    return { ok: true, afterOutline: addTargetRootMarker(normalizedNew, rootNodeId) ?? normalizedNew };
  }
  const markerlessRootOld = addTargetRootMarker(normalizedOld, rootNodeId);
  if (markerlessRootOld && markerlessRootOld !== normalizedOld) {
    const markerlessRootNew = addTargetRootMarker(normalizedNew, rootNodeId) ?? normalizedNew;
    const markerlessRootMatches = countOccurrences(currentOutline, markerlessRootOld);
    if (markerlessRootMatches === 1) {
      return { ok: true, afterOutline: currentOutline.replace(markerlessRootOld, markerlessRootNew) };
    }
    if (markerlessRootMatches > 1) {
      return {
        ok: false,
        code: 'old_string_not_unique',
        error: `old_string matched ${markerlessRootMatches} times in the current annotated outline after restoring the target root marker.`,
        instructions: 'Include more surrounding context or edit the intended child node directly by node_id.',
      };
    }
    return {
      ok: false,
      code: 'old_string_not_found',
      error: 'old_string did not match the current target root line.',
      instructions: 'Call node_read again and copy the current target root line. You may omit the leading %%node:node_id%% marker only for that target root line.',
    };
  }

  const exactMatches = countOccurrences(currentOutline, normalizedOld);
  if (exactMatches === 1) {
    const effectiveNew = startsWithTargetRootMarker(normalizedOld, rootNodeId)
      ? addTargetRootMarker(normalizedNew, rootNodeId) ?? normalizedNew
      : normalizedNew;
    return { ok: true, afterOutline: currentOutline.replace(normalizedOld, effectiveNew) };
  }
  if (exactMatches > 1) {
    return {
      ok: false,
      code: 'old_string_not_unique',
      error: `old_string matched ${exactMatches} times in the current annotated outline.`,
      instructions: 'Include more surrounding context or edit the intended child node directly by node_id.',
    };
  }

  return {
    ok: false,
    code: 'old_string_not_found',
    error: 'old_string did not match the current annotated outline.',
    instructions: 'Call node_read again and copy an exact fragment from data.outline. For the target root line only, you may omit the leading %%node:node_id%% marker; keep field/value markers when editing existing field/value lines.',
  };
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

function addTargetRootMarker(fragment: string, rootNodeId: string): string | null {
  const lines = fragment.split('\n');
  const firstLine = lines[0];
  if (firstLine === undefined) return null;
  if (startsWithTargetRootMarker(fragment, rootNodeId)) return fragment;
  if (startsWithAnyRootMarker(fragment)) return null;
  const match = /^(-\s+)(.*)$/.exec(firstLine);
  if (!match) return null;
  lines[0] = `${match[1]}%%node:${rootNodeId}%% ${match[2]}`;
  return lines.join('\n');
}

function startsWithTargetRootMarker(fragment: string, rootNodeId: string): boolean {
  const firstLine = fragment.split('\n')[0] ?? '';
  return rootMarkerPattern(rootNodeId).test(firstLine);
}

function startsWithAnyRootMarker(fragment: string): boolean {
  const firstLine = fragment.split('\n')[0] ?? '';
  return /^-\s+%%node:[^\s%]+(?:\s+[^%]*)?%%(?:\s|$)/.test(firstLine);
}

function rootMarkerPattern(rootNodeId: string): RegExp {
  return new RegExp(`^-\\s+%%node:${escapeRegExp(rootNodeId)}(?:\\s+[^%]*)?%%(?:\\s|$)`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validateSingleNodeEditShape(document: OutlineDocument): { code: string; error: string; instructions: string } | null {
  const root = document.roots[0];
  if (!root) return null;
  if (!root.search && root.children.length > 0) {
    return {
      code: 'subtree_edit_removed',
      error: 'node_edit no longer edits child structure from an outline fragment.',
      instructions: 'Use node_create for new children, node_edit move for reordering or reparenting, node_delete for removals, or call node_edit directly on a child id.',
    };
  }
  if (root.search) {
    const queryChildCount = root.children.length;
    if (queryChildCount !== 1) {
      return {
        code: 'invalid_search_condition',
        error: 'Saved-search edits must include exactly one query root child.',
        instructions: 'Edit the saved search config as one search outline; do not use omitted child lines to remove document children.',
      };
    }
  }
  return null;
}

async function applySingleNodeEdit(
  host: OutlinerToolHost,
  nodeId: string,
  root: OutlineNode,
  tracker: MutationTracker,
  warnings: string[],
): Promise<{ updatedTagIds: string[] }> {
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
    return { updatedTagIds };
  }
  if (root.view) warnings.push('View directives are only persisted on search nodes today.');

  const updatedTagIds = await syncOutlineNodeInPlace(host, nodeId, root, tracker, warnings);
  await upsertFields(host, nodeId, root.fields, tracker, warnings);
  return { updatedTagIds };
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
  if (current.type === 'codeBlock' || node.codeBlock) {
    if (current.type !== 'codeBlock' || !node.codeBlock) {
      throw new Error('Outline edit cannot change a node to or from a code block; edit code blocks with the fenced outline returned by node_read.');
    }
    trackMatchedNode(tracker, nodeId);
    if (current.content.text !== node.title) {
      await host.handle('apply_node_text_patch', { nodeId, patch: replaceAllRichTextPatch(plainText(node.title)) });
    }
    if ((current.codeLanguage ?? '') !== (node.codeLanguage ?? '')) {
      await host.handle('set_code_language', { nodeId, codeLanguage: node.codeLanguage ?? '' });
    }
    return [];
  }
  trackMatchedNode(tracker, nodeId);
  const titleSuffix = node.description ? ' - ' : node.tags.length > 0 ? ' ' : '';
  if (richTextOutlineText(current.content, { suffix: titleSuffix }) !== node.title) {
    await host.handle('apply_node_text_patch', { nodeId, patch: replaceAllRichTextPatch(richTextFromOutlineText(node.title)) });
  }
  if ((current.description ?? null) !== (node.description ?? null)) {
    await host.handle('update_node_description', { nodeId, description: node.description ?? null });
  }
  await setCheckboxState(host, nodeId, node.checked);
  return syncTags(host, nodeId, node.tags, tracker);
}

async function upsertFields(
  host: OutlinerToolHost,
  parentId: string,
  fields: OutlineField[],
  tracker: MutationTracker,
  warnings: string[],
): Promise<void> {
  const index = indexProjection(host.getProjection());
  const existingFieldIds = requiredNode(index, parentId).children.filter((childId) => {
    const child = index.nodes.get(childId);
    return child?.type === 'fieldEntry' && !isInTrash(index, childId);
  });
  const misplacedAnnotatedField = fields.find((field) => field.nodeId && !existingFieldIds.includes(field.nodeId));
  if (misplacedAnnotatedField?.nodeId) {
    throw new Error(`Annotated field id is not a field under ${parentId}: ${misplacedAnnotatedField.nodeId}`);
  }
  pushDuplicateKeyWarning('field entries', existingFieldIds.map((fieldEntryId) => fieldName(index, requiredNode(index, fieldEntryId)).toLowerCase()), warnings);
  pushDuplicateKeyWarning('desired field names', fields.map((field) => field.name.trim().toLowerCase()), warnings);

  const usedFieldIds = new Set<string>();
  for (const field of fields) {
    const latest = indexProjection(host.getProjection());
    const latestExistingFieldIds = requiredNode(latest, parentId).children.filter((childId) => {
      const child = latest.nodes.get(childId);
      return child?.type === 'fieldEntry' && !isInTrash(latest, childId);
    });
    let fieldEntryId = field.nodeId;
    if (fieldEntryId) {
      usedFieldIds.add(fieldEntryId);
      trackMatchedNode(tracker, fieldEntryId);
      const existing = latest.nodes.get(fieldEntryId);
      if (existing?.type === 'fieldEntry' && existing.fieldDefId === DONE_FIELD) {
        await setDoneFieldValue(host, parentId, field, warnings);
        continue;
      }
      if (existing?.type === 'fieldEntry' && isSystemFieldId(existing.fieldDefId)) {
        throw new Error(`System field "${field.name}" is read-only. Use normal node syntax for tags, references, and dates; only Done can be written through field syntax.`);
      }
      await upsertFieldValues(host, fieldEntryId, field, tracker, warnings);
      continue;
    }
    const resolution = resolveFieldWriteTarget(
      fieldResolutionMap(latest),
      parentId,
      field.name,
      fieldResolutionValues(field),
      { isDeleted: (nodeId) => isInTrash(latest, nodeId) },
    );
    if (!resolution.ok) throw new Error(`${resolution.error} ${resolution.instructions}`);
    const appliedId = await applyResolvedField(host, parentId, field, resolution.target, tracker, warnings, {
      index: fieldSectionInsertIndex(latest, parentId),
      usedFieldIds,
    });
    usedFieldIds.add(appliedId);
  }
}

async function upsertFieldValues(
  host: OutlinerToolHost,
  fieldEntryId: string,
  field: OutlineField,
  tracker: MutationTracker,
  warnings: string[],
) {
  const index = indexProjection(host.getProjection());
  const normalizedField = normalizeFieldValuesForEntry(index, fieldEntryId, field);
  const fieldType = fieldTypeForEntry(index, fieldEntryId);
  const existingValueIds = [...requiredNode(index, fieldEntryId).children].filter((childId) => !isInTrash(index, childId));
  const desiredValues = normalizedField.clear ? [] : normalizedField.values;
  const misplacedAnnotatedValue = desiredValues.find((value) => value.nodeId && !existingValueIds.includes(value.nodeId));
  if (misplacedAnnotatedValue?.nodeId) {
    throw new Error(`Annotated field value id is not a value under ${fieldEntryId}: ${misplacedAnnotatedValue.nodeId}`);
  }
  pushDuplicateKeyWarning('field values', existingValueIds.map((valueId) => outlineValueKeyFromProjection(requiredNode(index, valueId))), warnings);
  pushDuplicateKeyWarning('desired field values', desiredValues.map(outlineValueKey), warnings);
  if (normalizedField.clear && existingValueIds.length > 0) {
    warnings.push(`Field "${field.name}" was left unchanged because node_edit no longer clears values by omission; use node_delete on value ids.`);
  }

  const usedExisting = new Set<string>();
  for (const desired of desiredValues) {
    let targetValueId = desired.nodeId;
    if (!targetValueId) {
      const key = outlineValueKey(desired);
      const candidates = existingValueIds.filter((valueId) =>
        !usedExisting.has(valueId) && outlineValueKeyFromProjection(requiredNode(index, valueId)) === key);
      targetValueId = candidates.length === 1 ? candidates[0] : undefined;
    }
    if (targetValueId) {
      usedExisting.add(targetValueId);
      const latest = indexProjection(host.getProjection());
      const current = requiredNode(latest, targetValueId);
      if (!canUpdateValueInPlace(current, desired)) {
        throw new Error(`Annotated field value id cannot be changed to a different value kind: ${targetValueId}`);
      }
      trackMatchedNode(tracker, targetValueId);
      const desiredSource = outlineValueSource(desired);
      if (!desired.targetId && richTextOutlineText(current.content) !== desiredSource) {
        await host.handle('apply_node_text_patch', {
          nodeId: targetValueId,
          patch: replaceAllRichTextPatch(richTextFromOutlineText(desiredSource)),
        });
      }
      continue;
    }
    tracker.createdNodeIds.push(...await appendFieldValue(host, fieldEntryId, desired, fieldType));
  }
}

function validateFieldValueKindUpdates(
  index: ProjectionIndex,
  parentId: string,
  root: OutlineNode,
): { code: string; error: string; instructions: string } | null {
  if (root.search) return null;
  const parent = requiredNode(index, parentId);
  const existingFieldIds = activeFieldEntryIds(index, parent.id);
  const usedFieldIds = new Set<string>();
  for (const field of root.fields) {
    let fieldEntryId = field.nodeId;
    if (!fieldEntryId) {
      const key = normalizeFieldNameKey(field.name);
      const candidates = existingFieldIds.filter((candidateId) =>
        !usedFieldIds.has(candidateId) && normalizeFieldNameKey(fieldName(index, requiredNode(index, candidateId))) === key);
      fieldEntryId = candidates.length === 1 ? candidates[0] : undefined;
    }
    if (!fieldEntryId) continue;
    usedFieldIds.add(fieldEntryId);
    if (field.clear) continue;
    const existingValueIds = activeChildIds(index, fieldEntryId);
    const usedValueIds = new Set<string>();
    for (const desired of field.values) {
      let targetValueId = desired.nodeId;
      if (!targetValueId) {
        const key = outlineValueKey(desired);
        const candidates = existingValueIds.filter((valueId) =>
          !usedValueIds.has(valueId) && outlineValueKeyFromProjection(requiredNode(index, valueId)) === key);
        targetValueId = candidates.length === 1 ? candidates[0] : undefined;
      }
      if (!targetValueId) continue;
      usedValueIds.add(targetValueId);
      const current = requiredNode(index, targetValueId);
      if (canUpdateValueInPlace(current, desired)) continue;
      return {
        code: 'invalid_field_value_kind',
        error: `Annotated field value id cannot be changed to a different value kind or reference target: ${targetValueId}`,
        instructions: 'Use node_delete on that field value id, then use node_edit or node_create to add the replacement value.',
      };
    }
  }
  return null;
}

function normalizeFieldValuesForEntry(index: ProjectionIndex, fieldEntryId: string, field: OutlineField): OutlineField {
  const fieldType = fieldTypeForEntry(index, fieldEntryId);
  return normalizeFieldValuesForType(field, fieldType);
}

function normalizeFieldValuesForType(field: OutlineField, fieldType: FieldType): OutlineField {
  const validation = validateFieldValuesForType(field.name, fieldType, fieldResolutionValues(field));
  if (!validation.ok) throw new Error(validation.error);
  if (field.clear) return field;
  if (fieldType !== 'date') return field;

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
  return normalized === value.text
    ? value
    : { ...(value.nodeId ? { nodeId: value.nodeId } : {}), text: normalized };
}

function fieldTypeForEntry(index: ProjectionIndex, fieldEntryId: string): FieldType {
  const fieldEntry = requiredNode(index, fieldEntryId);
  const fieldDefId = fieldEntry.type === 'fieldEntry' ? fieldEntry.fieldDefId : undefined;
  if (fieldDefId === DONE_FIELD) return 'checkbox';
  const fieldDef = fieldDefId ? index.nodes.get(fieldDefId) : undefined;
  return fieldDef?.type === 'fieldDef' ? projectFieldConfig(index.nodes, fieldDef).fieldType : 'plain';
}

function outlineValueKeyFromProjection(node: NodeProjection): string {
  if (node.type === 'reference') return `reference:${node.targetId ?? ''}`;
  return richTextValueKey(node.content);
}

function outlineValueKey(value: OutlineValue): string {
  if (value.targetId) return `reference:${value.targetId}`;
  return richTextValueKey(richTextFromOutlineText(outlineValueSource(value)));
}

function richTextValueKey(content: RichText): string {
  const text = content.text.trim().toLowerCase();
  if (content.inlineRefs.length === 0) return `value:${text}`;
  const references = [...content.inlineRefs]
    .sort((left, right) => (
      left.offset - right.offset
      || referenceTargetSortKey(left.target).localeCompare(referenceTargetSortKey(right.target))
    ))
    .map((ref) => `${ref.offset}:${referenceTargetSortKey(ref.target)}`)
    .join('|');
  return `inline-value:${text}:${references}`;
}

function outlineValueSource(value: OutlineValue): string {
  return value.outlineSource ?? value.text;
}

function canUpdateValueInPlace(current: NodeProjection, desired: OutlineValue): boolean {
  if (desired.targetId) return current.type === 'reference' && current.targetId === desired.targetId;
  return current.type !== 'reference';
}

function activeFieldEntryIds(index: ProjectionIndex, parentId: string): string[] {
  return requiredNode(index, parentId).children.filter((childId) => {
    const child = index.nodes.get(childId);
    return child?.type === 'fieldEntry' && !isInTrash(index, childId);
  });
}

function fieldSectionInsertIndex(index: ProjectionIndex, parentId: string): number {
  const parent = requiredNode(index, parentId);
  const firstNormalChildIndex = parent.children.findIndex((childId) => {
    const child = index.nodes.get(childId);
    return child !== undefined && child.type !== 'fieldEntry' && !isInTrash(index, childId);
  });
  return firstNormalChildIndex === -1 ? parent.children.length : firstNormalChildIndex;
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
    : node.codeBlock
      ? await createCodeBlockNode(host, parentId, index, node.title, node.codeLanguage)
      : await createPlainNode(host, parentId, index, node.title);
  tracker.createdNodeIds.push(createdId);

  if (node.description && !node.referenceTargetId) {
    await host.handle('update_node_description', { nodeId: createdId, description: node.description });
  }
  await setCheckboxState(host, createdId, node.checked);

  await applyTags(host, createdId, node.tags, tracker);
  for (const field of node.fields) {
    const latest = indexProjection(host.getProjection());
    const resolution = resolveFieldWriteTarget(
      fieldResolutionMap(latest),
      createdId,
      field.name,
      fieldResolutionValues(field),
      { isDeleted: (nodeId) => isInTrash(latest, nodeId) },
    );
    if (!resolution.ok) throw new Error(`${resolution.error} ${resolution.instructions}`);
    await applyResolvedField(host, createdId, field, resolution.target, tracker, warnings);
  }
  for (const child of node.children) {
    await createOutlineNode(host, child, createdId, null, tracker, warnings);
  }
  return createdId;
}

async function createPlainNode(host: OutlinerToolHost, parentId: string, index: number | null, text: string): Promise<string> {
  const content = richTextFromOutlineText(text);
  if (content.inlineRefs.length === 0 && content.marks.length === 0) {
    return focusFromOutcome(await host.handle('create_node', { parentId, index, text: content.text }));
  }
  return focusFromOutcome(await host.handle('create_rich_text_node', { parentId, index, content }));
}

async function createCodeBlockNode(
  host: OutlinerToolHost,
  parentId: string,
  index: number | null,
  text: string,
  codeLanguage?: string,
): Promise<string> {
  const createdId = focusFromOutcome(await host.handle('create_node', { parentId, index, text }));
  await host.handle('set_code_block', { nodeId: createdId, codeLanguage: codeLanguage ?? null });
  return createdId;
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

async function applyResolvedField(
  host: OutlinerToolHost,
  parentId: string,
  field: OutlineField,
  target: FieldWriteTarget,
  tracker: MutationTracker,
  warnings: string[],
  options: { index?: number | null; usedFieldIds?: Set<string> } = {},
): Promise<string> {
  if (target.kind === 'existingEntry') {
    if (options.usedFieldIds?.has(target.fieldEntryId)) {
      throw new Error(`Duplicate desired field "${field.name}" targets the same field entry: ${target.fieldEntryId}`);
    }
    trackMatchedNode(tracker, target.fieldEntryId);
    await upsertFieldValues(host, target.fieldEntryId, field, tracker, warnings);
    return target.fieldEntryId;
  }
  if (target.kind === 'existingFieldDef') {
    const fieldEntryId = await createFieldEntryForDefinition(host, parentId, target.fieldDefId, tracker, options.index ?? null);
    await upsertFieldValues(host, fieldEntryId, field, tracker, warnings);
    return fieldEntryId;
  }
  if (target.kind === 'systemDone') {
    const fieldEntryId = await ensureSystemFieldEntry(host, parentId, target.fieldDefId, tracker, options.index ?? null);
    await setDoneFieldValue(host, parentId, field, warnings);
    return fieldEntryId;
  }
  return createField(host, parentId, field, tracker, options.index ?? null, target.fieldType);
}

async function createFieldEntryForDefinition(
  host: OutlinerToolHost,
  parentId: string,
  targetDefId: string,
  tracker: MutationTracker,
  index: number | null,
): Promise<string> {
  const fieldEntryId = focusFromOutcome(await host.handle('create_inline_field', {
    parentId,
    index,
    name: '',
    fieldType: 'plain',
  }));
  tracker.createdFieldEntryIds.push(fieldEntryId);
  await host.handle('reuse_field_definition', { entryId: fieldEntryId, targetDefId });
  trackMatchedNode(tracker, targetDefId);
  return fieldEntryId;
}

async function ensureSystemFieldEntry(
  host: OutlinerToolHost,
  parentId: string,
  targetDefId: string,
  tracker: MutationTracker,
  index: number | null,
): Promise<string> {
  const latest = indexProjection(host.getProjection());
  const existing = requiredNode(latest, parentId).children.find((childId) => {
    const child = latest.nodes.get(childId);
    return child?.type === 'fieldEntry' && child.fieldDefId === targetDefId && !isInTrash(latest, childId);
  });
  if (existing) {
    trackMatchedNode(tracker, existing);
    return existing;
  }
  return createFieldEntryForDefinition(host, parentId, targetDefId, tracker, index);
}

async function setDoneFieldValue(
  host: OutlinerToolHost,
  parentId: string,
  field: OutlineField,
  warnings: string[],
): Promise<void> {
  const validation = validateFieldValuesForType(field.name, 'checkbox', fieldResolutionValues(field));
  if (!validation.ok) throw new Error(validation.error);
  const desired = field.values.at(-1)?.text.trim().toLowerCase();
  if (!desired) {
    warnings.push(`Field "${field.name}" was left unchanged because Done requires true or false.`);
    return;
  }
  await setCheckboxState(host, parentId, desired === 'true');
}

function fieldResolutionMap(index: ProjectionIndex): ReadonlyMap<string, FieldResolutionNode> {
  return index.nodes as ReadonlyMap<string, FieldResolutionNode>;
}

function fieldResolutionValues(field: OutlineField): FieldResolutionValue[] {
  if (field.clear) return [];
  return field.values.map((value) => {
    const content = value.targetId ? null : richTextFromOutlineText(outlineValueSource(value));
    return {
      text: value.text,
      ...(value.targetId ? { targetId: value.targetId } : {}),
      ...(content?.inlineRefs.length ? { hasInlineRefs: true } : {}),
    };
  });
}

async function createField(
  host: OutlinerToolHost,
  parentId: string,
  field: OutlineField,
  tracker: MutationTracker,
  index: number | null = null,
  fieldType: FieldType = inferFieldTypeFromValues(fieldResolutionValues(field)),
): Promise<string> {
  const fieldEntryId = focusFromOutcome(await host.handle('create_inline_field', {
    parentId,
    index,
    name: field.name,
    fieldType,
  }));
  tracker.createdFieldEntryIds.push(fieldEntryId);
  const fieldEntry = indexProjection(host.getProjection()).nodes.get(fieldEntryId);
  if (fieldEntry?.type === 'fieldEntry' && fieldEntry.fieldDefId) tracker.createdFieldDefIds.push(fieldEntry.fieldDefId);
  const normalizedField = normalizeFieldValuesForType(field, fieldType);
  for (const value of normalizedField.values) {
    tracker.createdNodeIds.push(...await appendFieldValue(host, fieldEntryId, value, fieldType));
  }
  return fieldEntryId;
}

async function appendFieldValue(
  host: OutlinerToolHost,
  fieldEntryId: string,
  value: OutlineValue,
  fieldType: FieldType,
): Promise<string[]> {
  const before = new Set(activeChildIds(indexProjection(host.getProjection()), fieldEntryId));
  if (fieldType === 'options') {
    if (value.targetId) {
      await host.handle('select_field_option', { fieldEntryId, optionNodeId: value.targetId });
    } else {
      await host.handle('create_collected_field_option', { fieldEntryId, name: value.text });
    }
    return appendedChildIds(host, fieldEntryId, before);
  }
  if (fieldType === 'options_from_supertag') {
    if (!value.targetId) throw new Error('Options-from-supertag field values must use [[node:Display^id]].');
    await host.handle('select_field_option', { fieldEntryId, optionNodeId: value.targetId });
    return appendedChildIds(host, fieldEntryId, before);
  }
  if (value.targetId) {
    if (fieldType !== 'plain') throw new Error(`${fieldType} field values cannot store node references.`);
    return [await addReference(host, fieldEntryId, value.targetId, null)];
  }
  return [await createPlainNode(host, fieldEntryId, null, outlineValueSource(value))];
}

function appendedChildIds(host: OutlinerToolHost, fieldEntryId: string, before: ReadonlySet<string>): string[] {
  const after = activeChildIds(indexProjection(host.getProjection()), fieldEntryId);
  return after.filter((childId) => !before.has(childId));
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

async function validateOutlineReferenceTargets(
  options: NodeToolsOptions,
  index: ProjectionIndex,
  document: OutlineDocument,
): Promise<{ code: string; error: string; instructions: string } | null> {
  const targets = collectReferenceTargets(document);
  const nodeTargetIds = targets
    .filter((target): target is Extract<ReferenceTarget, { kind: 'node' }> => target.kind === 'node')
    .map((target) => target.nodeId);
  const nodeValidation = validateReferenceTargetIds(index, nodeTargetIds);
  if (nodeValidation) return nodeValidation;
  const scopeIssue = validateNodeResourceScope(options, index, nodeTargetIds);
  if (scopeIssue) return nodeScopeIssueDetails(scopeIssue);

  const chatSources = targets
    .filter((target): target is Extract<ReferenceTarget, { kind: 'chat-source' }> => target.kind === 'chat-source');
  if (chatSources.length === 0) return null;
  if (!options.chatSourceValidator) {
    return {
      code: 'invalid_chat_source',
      error: 'Chat source references cannot be validated in this runtime.',
      instructions: 'Retry later after the agent conversation history service is available.',
    };
  }
  for (const source of chatSources) {
    const validation = await options.chatSourceValidator(source);
    if (!validation.ok) {
      return {
        code: validation.code ?? 'invalid_chat_source',
        error: validation.error ?? `Chat source reference not found: ${source.stream}:${source.streamId}`,
        instructions: validation.instructions ?? 'Use past_chats search/recent/read to get a current source object, then retry with that exact chat reference marker.',
      };
    }
  }
  return null;
}

function collectReferenceTargets(document: OutlineDocument): ReferenceTarget[] {
  const targets: ReferenceTarget[] = [];
  for (const field of document.fields) collectFieldReferenceTargets(field, targets);
  for (const root of document.roots) collectNodeReferenceTargets(root, targets);
  return dedupeReferenceTargets(targets);
}

function dedupeReferenceTargets(targets: readonly ReferenceTarget[]): ReferenceTarget[] {
  const seen = new Set<string>();
  const out: ReferenceTarget[] = [];
  for (const target of targets) {
    const key = referenceTargetSortKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
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
  for (const field of document.fields) collectFieldLocalFileReferencePaths(field, paths);
  for (const root of document.roots) collectNodeLocalFileReferencePaths(root, paths);
  return paths;
}

function collectFieldLocalFileReferencePaths(field: OutlineField, paths: string[]) {
  collectTextLocalFileReferencePaths(field.name, paths);
  for (const value of field.values) collectTextLocalFileReferencePaths(outlineValueSource(value), paths);
}

function collectNodeLocalFileReferencePaths(node: OutlineNode, paths: string[]) {
  collectTextLocalFileReferencePaths(node.title, paths);
  collectTextLocalFileReferencePaths(node.description ?? '', paths);
  for (const field of node.fields) {
    collectTextLocalFileReferencePaths(field.name, paths);
    for (const value of field.values) collectTextLocalFileReferencePaths(outlineValueSource(value), paths);
  }
  for (const child of node.children) collectNodeLocalFileReferencePaths(child, paths);
}

function collectTextLocalFileReferencePaths(text: string, paths: string[]) {
  if (!text.includes('[[file:')) return;
  for (const ref of markdownReferenceMarkupToRichText(text).inlineRefs) {
    if (ref.target.kind === 'local-file') paths.push(ref.target.path);
  }
}

function collectOutlineAnnotationIds(document: OutlineDocument): string[] {
  const ids: string[] = [];
  for (const field of document.fields) collectFieldAnnotationIds(field, ids);
  for (const root of document.roots) collectNodeAnnotationIds(root, ids);
  return unique(ids);
}

function collectFieldAnnotationIds(field: OutlineField, ids: string[]) {
  if (field.nodeId) ids.push(field.nodeId);
  for (const value of field.values) {
    if (value.nodeId) ids.push(value.nodeId);
  }
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

function collectNodeReferenceTargets(node: OutlineNode, targets: ReferenceTarget[]) {
  if (node.referenceTargetId) targets.push({ kind: 'node', nodeId: node.referenceTargetId });
  collectTextReferenceTargets(node.title, targets);
  for (const field of node.fields) {
    collectFieldReferenceTargets(field, targets);
  }
  for (const child of node.children) collectNodeReferenceTargets(child, targets);
}

function collectFieldReferenceTargets(field: OutlineField, targets: ReferenceTarget[]) {
  for (const value of field.values) {
    if (value.targetId) targets.push({ kind: 'node', nodeId: value.targetId });
    collectTextReferenceTargets(outlineValueSource(value), targets);
  }
}

function collectTextReferenceTargets(text: string, targets: ReferenceTarget[]) {
  if (!text.includes('[[')) return;
  for (const ref of markdownReferenceMarkupToRichText(text).inlineRefs) targets.push(ref.target);
}

function focusFromOutcome(outcome: unknown): string {
  const focusNodeId = outcome && typeof outcome === 'object'
    ? (outcome as { focus?: { nodeId?: unknown } }).focus?.nodeId
    : undefined;
  if (typeof focusNodeId !== 'string' || !focusNodeId) throw new Error('Mutation did not return a focus node id.');
  return focusNodeId;
}

function richTextFromOutlineText(text: string): RichText {
  return markdownReferenceMarkupToRichText(text);
}

function richTextOutlineText(content: RichText, context: { suffix?: string } = {}): string {
  return richTextToMarkdownReferenceMarkup(content, context);
}
