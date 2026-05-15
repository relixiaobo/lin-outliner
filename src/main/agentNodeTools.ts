import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { DocumentCommand } from '../core/commands';
import {
  DAILY_NOTES_ID,
  SCHEMA_ID,
  SEARCHES_ID,
  SETTINGS_ID,
  TAG_DAY_ID,
  TAG_WEEK_ID,
  TAG_YEAR_ID,
  TRASH_ID,
  WORKSPACE_ID,
  plainText,
  replaceAllRichTextPatch,
  type DocumentProjection,
  type NodeProjection,
  type SearchNodeCondition,
  type SearchNodeConfig,
} from '../core/types';
import { agentToolResult, errorEnvelope, successEnvelope, type ToolEnvelope } from './agentToolEnvelope';
import {
  parseLinOutline,
  type OutlineDocument,
  type OutlineField,
  type OutlineNode,
  type OutlineValue,
} from './agentOutlineParser';

export interface OutlinerToolHost {
  getProjection(): DocumentProjection;
  handle(
    command: DocumentCommand,
    args?: Record<string, unknown>,
    meta?: { origin?: 'user' | 'agent' | 'system'; command?: string; tool?: string; summary?: string },
  ): Promise<unknown>;
  transaction?<T>(
    meta: { origin?: 'user' | 'agent' | 'system'; command?: string; tool?: string; summary?: string },
    fn: () => Promise<T>,
  ): Promise<T>;
  operationHistory?(query: OperationHistoryParams): Promise<OperationHistoryData> | OperationHistoryData;
}

interface NodeReadParams {
  nodeId?: string;
  nodeIds?: string[];
  depth?: number;
  childOffset?: number;
  childLimit?: number;
  format?: 'structured' | 'outline' | 'both';
  includeDeleted?: boolean;
  includeBacklinks?: boolean;
}

interface NodeReadData {
  items: NodeReadItem[];
}

interface NodeReadItem {
  nodeId: string;
  type: string;
  title: string;
  description?: string | null;
  tags: string[];
  fields: NodeFieldRead[];
  checked?: boolean | null;
  parent?: NodeRef | null;
  breadcrumb: NodeRef[];
  children: ChildrenPage;
  backlinks?: NodeBacklink[];
  revision: string;
  outline?: string;
}

interface NodeFieldRead {
  name: string;
  type: string;
  values: Array<{
    text: string;
    valueNodeId?: string;
    targetId?: string;
  }>;
  fieldEntryId: string;
  options?: string[];
}

interface ChildrenPage {
  total: number;
  offset: number;
  limit: number;
  items: NodeChildSummary[];
}

interface NodeChildSummary {
  nodeId: string;
  title: string;
  type: string;
  tags: string[];
  checked?: boolean | null;
  hasChildren: boolean;
  childCount: number;
  isReference?: boolean;
  targetId?: string;
  children?: ChildrenPage;
}

interface NodeBacklink {
  sourceNodeId: string;
  sourceTitle: string;
  kind: 'tree' | 'inline' | 'field';
  snippet?: string;
}

interface NodeRef {
  nodeId: string;
  title: string;
}

interface NodeSearchParams {
  outline?: string;
  searchNodeId?: string;
  query?: string;
  limit?: number;
  offset?: number;
  count?: boolean;
}

interface NodeSearchData {
  source: 'temporary' | 'saved';
  title?: string;
  view?: string;
  searchNodeId?: string;
  outline?: string;
  total: number;
  offset: number;
  limit: number;
  items?: NodeSearchItem[];
  unresolvedTags?: string[];
  unresolvedFields?: string[];
}

interface NodeSearchItem {
  nodeId: string;
  title: string;
  description?: string | null;
  type: string;
  tags: string[];
  snippet: string;
  parent?: NodeRef | null;
  fields: Record<string, string | string[]>;
  checked?: boolean | null;
  hasChildren: boolean;
  childCount: number;
  updatedAt: string;
}

interface NodeCreateParams {
  parentId?: string;
  afterId?: string | null;
  outline?: string;
  targetId?: string;
  duplicateId?: string;
  previewOnly?: boolean;
}

interface NodeDeleteParams {
  nodeId?: string;
  nodeIds?: string[];
  restore?: boolean;
  previewOnly?: boolean;
}

interface NodeEditParams {
  nodeId?: string;
  nodeIds?: string[];
  oldString?: string;
  newString?: string;
  expectedRevision?: string;
  move?: NodeEditMoveParams;
  mergeFromNodeIds?: string[];
  replaceWithReferenceTo?: string;
  previewOnly?: boolean;
}

interface NodeEditMoveParams {
  parentId?: string;
  afterId?: string | null;
  structuralAction?: 'indent' | 'outdent' | 'move_up' | 'move_down';
}

interface OperationHistoryParams {
  action?: 'list' | 'undo' | 'redo';
  steps?: number;
  operationId?: string;
  origin?: 'all' | 'agent' | 'user';
  limit?: number;
  offset?: number;
}

interface NodeCreateData {
  parentId: string;
  afterId?: string | null;
  createdRootIds: string[];
  createdNodeIds: string[];
  createdFieldEntryIds?: string[];
  createdTagIds?: string[];
  createdFieldDefIds?: string[];
  duplicatedFrom?: string;
  targetId?: string;
  outline?: string;
}

interface NodeDeleteData {
  action: 'trashed' | 'restored';
  trashId: string;
  requestedNodeIds: string[];
  deletedNodeIds: string[];
  restoredNodeIds?: string[];
  deletedCount: number;
  restoredCount?: number;
  affectedNodeCount: number;
  preview: NodeDeletePreview[];
  skippedNodeIds?: NodeDeleteSkip[];
}

interface NodeEditData {
  action: 'outline_edit' | 'move' | 'merge' | 'replace_with_reference';
  status: 'updated' | 'unchanged';
  affectedNodeIds: string[];
  createdNodeIds?: string[];
  trashedNodeIds?: string[];
  matchedNodeIds?: string[];
  movedNodeIds?: string[];
  updatedFields?: string[];
  updatedTags?: string[];
  beforeOutline?: string;
  afterOutline?: string;
  revisions?: Record<string, string>;
  merge?: {
    targetNodeId: string;
    sourceNodeIds: string[];
    movedChildren: number;
    mergedFields: NodeMergeFieldPreview[];
    appliedTags: number;
    redirectedReferences: number;
  };
}

interface NodeMergeFieldPreview {
  fieldName: string;
  sourceFieldEntryId: string;
  targetFieldEntryId: string;
  movedValueIds: string[];
  mode: 'merged_values' | 'moved_entry';
}

interface OperationHistoryData {
  action: 'list' | 'undo' | 'redo';
  historyMode?: 'journal' | 'undo_stack';
  count: number;
  total?: number;
  hasMore?: boolean;
  items?: OperationHistoryItem[];
  undone?: OperationHistoryItem[];
  redone?: OperationHistoryItem[];
  canUndo: boolean;
  canRedo: boolean;
  cursor?: {
    topUndoOperationId?: string;
    topRedoOperationId?: string;
  };
}

interface OperationHistoryItem {
  operationId: string;
  origin: 'agent' | 'user' | 'system';
  command?: string;
  tool?: string;
  action: string;
  summary: string;
  affectedNodeIds: string[];
  createdAt: string;
  canUndo: boolean;
  canRedo: boolean;
}

interface NodeDeletePreview {
  nodeId: string;
  title: string;
  type: string;
  parent?: NodeRef | null;
  childCount: number;
  subtreeNodeCount: number;
}

interface NodeDeleteSkip {
  nodeId: string;
  reason: string;
  coveredBy?: string;
}

interface ProjectionIndex {
  projection: DocumentProjection;
  nodes: Map<string, NodeProjection>;
}

interface ParsedSearch {
  title?: string;
  view?: string;
  queryTerms: string[];
  tagNames: string[];
  linkTargetIds: string[];
  fieldConditions: ParsedFieldSearchCondition[];
}

interface ResolvedSearchSpec {
  title: string;
  view?: string;
  queryTerms: string[];
  tagIds: string[];
  linkTargetIds: string[];
  fieldConditions: ResolvedFieldSearchCondition[];
  unresolvedTagNames: string[];
  unresolvedFields: string[];
  warnings: string[];
}

interface ParsedFieldSearchCondition {
  fieldName: string;
  text?: string;
}

interface ResolvedFieldSearchCondition {
  fieldName: string;
  fieldDefId: string;
  text?: string;
}

type NormalizedEditParams =
  | (NodeEditParams & { action: 'outline_edit'; nodeId: string; oldString: string; newString: string })
  | (NodeEditParams & { action: 'move'; move: NodeEditMoveParams; nodeIds: string[] })
  | (NodeEditParams & { action: 'merge'; nodeId: string; mergeFromNodeIds: string[] })
  | (NodeEditParams & { action: 'replace_with_reference'; nodeId: string; replaceWithReferenceTo: string })
  | { error: string };

const NODE_READ_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    nodeId: {
      type: 'string',
      minLength: 1,
      description: "Node id to read. Defaults to today's journal node when nodeIds is omitted.",
    },
    nodeIds: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: { type: 'string', minLength: 1 },
      description: 'Read multiple independent nodes. Do not combine with nodeId.',
    },
    depth: {
      type: 'integer',
      minimum: 0,
      maximum: 3,
      description: 'Descendant depth to include. 0 reads only the node. Default 1, max 3.',
    },
    childOffset: {
      type: 'integer',
      minimum: 0,
      description: 'Child offset for the root children page. Default 0.',
    },
    childLimit: {
      type: 'integer',
      minimum: 0,
      maximum: 50,
      description: 'Maximum children returned per page. Default 20, max 50.',
    },
    format: {
      type: 'string',
      enum: ['structured', 'outline', 'both'],
      description: 'Return structured data, canonical outline text, or both. Default both.',
    },
    includeDeleted: {
      type: 'boolean',
      description: 'Allow reading nodes in Trash. Default false.',
    },
    includeBacklinks: {
      type: 'boolean',
      description: 'Include tree and inline backlinks to the requested nodes. Default false.',
    },
  },
};

const NODE_SEARCH_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  oneOf: [
    { required: ['query'] },
    { required: ['outline'] },
    { required: ['searchNodeId'] },
  ],
  properties: {
    outline: {
      type: 'string',
      minLength: 1,
      maxLength: 12000,
      description: 'Temporary search-node outline. Use "- %%search%% Title" plus child condition lines.',
    },
    searchNodeId: {
      type: 'string',
      minLength: 1,
      description: 'Existing saved search node id to execute.',
    },
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'Simple full-text shortcut. Prefer outline for structured searches.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'Maximum results to return. Default 20, max 50.',
    },
    offset: {
      type: 'integer',
      minimum: 0,
      description: 'Result offset. Default 0.',
    },
    count: {
      type: 'boolean',
      description: 'When true, return total without result items.',
    },
  },
};

const NODE_CREATE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  oneOf: [
    { required: ['outline'] },
    { required: ['targetId'] },
    { required: ['duplicateId'] },
  ],
  properties: {
    parentId: {
      type: 'string',
      minLength: 1,
      description: "Parent node id. Defaults to today's journal node.",
    },
    afterId: {
      anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
      description: 'Sibling insertion point. null means first child; omitted means append.',
    },
    outline: {
      type: 'string',
      minLength: 1,
      maxLength: 60000,
      description: 'Lin Outline Format to create. Supports nodes, descriptions, #tags, fields, references, and [x] completion.',
    },
    targetId: {
      type: 'string',
      minLength: 1,
      description: 'Create one reference node to this target.',
    },
    duplicateId: {
      type: 'string',
      minLength: 1,
      description: 'Duplicate an existing subtree by serializing and recreating its outline.',
    },
    previewOnly: {
      type: 'boolean',
      description: 'Parse and validate only; do not mutate the document.',
    },
  },
};

const NODE_DELETE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  oneOf: [
    { required: ['nodeId'] },
    { required: ['nodeIds'] },
  ],
  properties: {
    nodeId: {
      type: 'string',
      minLength: 1,
      description: 'Single node id to move to Trash.',
    },
    nodeIds: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: { type: 'string', minLength: 1 },
      description: 'Multiple node ids to move to Trash as one operation. Do not combine with nodeId.',
    },
    restore: {
      type: 'boolean',
      description: 'Restore nodes from Trash instead of moving them to Trash.',
    },
    previewOnly: {
      type: 'boolean',
      description: 'Validate and describe affected nodes only; do not mutate the document.',
    },
  },
};

const NODE_EDIT_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  oneOf: [
    { required: ['nodeId', 'oldString', 'newString'] },
    {
      required: ['move'],
      anyOf: [{ required: ['nodeId'] }, { required: ['nodeIds'] }],
    },
    { required: ['nodeId', 'mergeFromNodeIds'] },
    { required: ['nodeId', 'replaceWithReferenceTo'] },
  ],
  properties: {
    nodeId: {
      type: 'string',
      minLength: 1,
      description: 'Target node id. Required for outline edits, single-node moves, merge target, and reference replacement.',
    },
    nodeIds: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: { type: 'string', minLength: 1 },
      description: 'Target node ids for homogeneous move operations. Do not combine with nodeId except where explicitly allowed.',
    },
    oldString: {
      type: 'string',
      minLength: 1,
      description: 'Exact fragment from node_read.outline, or "*" to replace the whole canonical outline for nodeId.',
    },
    newString: {
      type: 'string',
      description: 'Replacement fragment. The full outline after replacement must parse as Lin Outline Format.',
    },
    expectedRevision: {
      type: 'string',
      minLength: 1,
      description: 'Optional revision from node_read; edit fails if the node changed.',
    },
    move: {
      type: 'object',
      additionalProperties: false,
      properties: {
        parentId: {
          type: 'string',
          minLength: 1,
          description: 'Destination parent for an absolute move.',
        },
        afterId: {
          anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
          description: 'Destination sibling. null means first child; omitted means append.',
        },
        structuralAction: {
          type: 'string',
          enum: ['indent', 'outdent', 'move_up', 'move_down'],
          description: 'User-like structural command for one or more nodes.',
        },
      },
    },
    mergeFromNodeIds: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: { type: 'string', minLength: 1 },
      description: 'Source node ids to merge into nodeId. Sources are moved to Trash after their children and tags are merged.',
    },
    replaceWithReferenceTo: {
      type: 'string',
      minLength: 1,
      description: 'Replace nodeId with a reference to this target node id at the same position.',
    },
    previewOnly: {
      type: 'boolean',
      description: 'Validate and render before/after data only; do not mutate the document.',
    },
  },
};

const OPERATION_HISTORY_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'undo', 'redo'],
      description: 'History action. Defaults to list. list is read-only; undo/redo operate on the selected Loro stack.',
    },
    steps: {
      type: 'integer',
      minimum: 1,
      maximum: 10,
      description: 'Number of stack steps for undo/redo. Default 1, max 10.',
    },
    operationId: {
      type: 'string',
      minLength: 1,
      description: 'Optional stack-top guard. The action is skipped unless the current Loro stack top has this operationId.',
    },
    origin: {
      type: 'string',
      enum: ['all', 'agent', 'user'],
      description: 'Filter/target origin. Defaults to all for list and agent for undo/redo.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'List page size. Default 20, max 100.',
    },
    offset: {
      type: 'integer',
      minimum: 0,
      description: 'List offset. Default 0.',
    },
  },
};

const SYSTEM_IDS = new Set([
  WORKSPACE_ID,
  DAILY_NOTES_ID,
  SCHEMA_ID,
  SEARCHES_ID,
  TRASH_ID,
  SETTINGS_ID,
  TAG_DAY_ID,
  TAG_WEEK_ID,
  TAG_YEAR_ID,
]);

export function createNodeTools(host: OutlinerToolHost): AgentTool<any>[] {
  const agentHost = asAgentToolHost(host);
  return [
    createNodeSearchTool(agentHost),
    createNodeReadTool(agentHost),
    createNodeCreateTool(agentHost),
    createNodeEditTool(agentHost),
    createNodeDeleteTool(agentHost),
    createOperationHistoryTool(agentHost),
  ].map((tool) => tool.name === 'operation_history' ? tool : withAgentToolTransaction(tool, agentHost));
}

function asAgentToolHost(host: OutlinerToolHost): OutlinerToolHost {
  return {
    getProjection: () => host.getProjection(),
    handle: (command, args = {}, meta = {}) => host.handle(command, args, { origin: 'agent', ...meta }),
    transaction: host.transaction
      ? (meta, fn) => host.transaction!({ origin: 'agent', ...meta }, fn)
      : undefined,
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
    description: [
      'Inspect, undo, or redo document operations.',
      'Undo/redo uses the Loro-backed operation stack. Agent calls default to the agent-origin stack; list returns stored commit metadata.',
    ].join('\n'),
    parameters: OPERATION_HISTORY_PARAMETERS,
    executionMode: 'sequential',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      const params = normalizeOperationHistoryParams(rawParams);
      if (params.error) {
        return agentToolResult(errorEnvelope<OperationHistoryData>('operation_history', 'invalid_args', params.error, {
          nextStep: 'Call operation_history with action "list", "undo", or "redo".',
          metrics: { durationMs: elapsed(started) },
        }));
      }
      if (!host.operationHistory) {
        return agentToolResult(errorEnvelope<OperationHistoryData>('operation_history', 'history_unavailable', 'The host does not expose Loro operation history.', {
          nextStep: 'Retry after the document service has initialized operation history support.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      const data = await host.operationHistory(params);
      return agentToolResult(successEnvelope('operation_history', data, {
        status: params.action === 'list' || data.count > 0 ? 'success' : 'unchanged',
        metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
      }));
    },
  };
}

function createNodeEditTool(host: OutlinerToolHost): AgentTool<any, ToolEnvelope<NodeEditData>> {
  return {
    name: 'node_edit',
    label: 'Node Edit',
    description: [
      'Edit existing Lin outliner content.',
      'For content edits, use node_read first, then pass exact oldString/newString against the canonical outline; oldString "*" replaces the whole outline for nodeId.',
      'Also supports user-like move operations, merge into a surviving target, and replacing a node with a reference.',
    ].join('\n'),
    parameters: NODE_EDIT_PARAMETERS,
    executionMode: 'sequential',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      const params = normalizeEditParams(rawParams);
      if ('error' in params) {
        return agentToolResult(errorEnvelope<NodeEditData>('node_edit', 'invalid_args', params.error, {
          nextStep: 'Use exactly one action: outline edit, move, mergeFromNodeIds, or replaceWithReferenceTo.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      switch (params.action) {
        case 'outline_edit':
          return executeOutlineEdit(host, params, started);
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
    description: [
      'Move one or more Lin outliner nodes to Trash, or restore nodes from Trash with restore true. This is not a permanent delete.',
      'Use nodeId for one node, or nodeIds for a batch. Children and fields move with their parent.',
      'If both a parent and its descendant are provided, the descendant is skipped because the parent covers it.',
    ].join('\n'),
    parameters: NODE_DELETE_PARAMETERS,
    executionMode: 'sequential',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      const params = normalizeDeleteParams(rawParams);
      if (params.error) {
        return agentToolResult(errorEnvelope('node_delete', 'invalid_args', params.error, {
          nextStep: 'Call node_delete with either nodeId or nodeIds, not both.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      const index = indexProjection(host.getProjection());
      const requestedNodeIds = params.nodeIds ?? [params.nodeId!];
      const missing = requestedNodeIds.find((nodeId) => !index.nodes.has(nodeId));
      if (missing) {
        return agentToolResult(errorEnvelope('node_delete', 'node_not_found', `Node not found: ${missing}`, {
          nextStep: 'Use node_search or node_read to locate the current node id.',
          metrics: { durationMs: elapsed(started) },
        }));
      }
      const locked = requestedNodeIds.find((nodeId) => SYSTEM_IDS.has(nodeId));
      if (locked) {
        return agentToolResult(errorEnvelope('node_delete', 'locked_node', `System node cannot be deleted: ${locked}`, {
          nextStep: 'Choose a user-created node instead of a workspace/system node.',
          metrics: { durationMs: elapsed(started) },
        }));
      }
      if (params.restore) {
        const notTrashed = requestedNodeIds.find((nodeId) => !isInTrash(index, nodeId));
        if (notTrashed) {
          return agentToolResult(errorEnvelope('node_delete', 'node_not_in_trash', `Node is not in Trash: ${notTrashed}`, {
            nextStep: 'Use restore true only for nodes currently in Trash.',
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
          return agentToolResult(successEnvelope('node_delete', data, {
            status: 'unchanged',
            metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
          }));
        }
        try {
          for (const nodeId of requestedNodeIds) await host.handle('restore_node', { nodeId });
        } catch (error) {
          return agentToolResult(errorEnvelope('node_delete', 'mutation_failed', errorMessage(error), {
            nextStep: 'Use node_read with includeDeleted true to verify the nodes are restorable.',
            metrics: { durationMs: elapsed(started) },
          }));
        }
        return agentToolResult(successEnvelope('node_delete', data, {
          metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
        }));
      }
      const trashed = requestedNodeIds.find((nodeId) => isInTrash(index, nodeId));
      if (trashed) {
        return agentToolResult(errorEnvelope('node_delete', 'node_in_trash', `Node is already in Trash: ${trashed}`, {
          nextStep: 'Use node_read with includeDeleted true to inspect Trash content.',
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
        return agentToolResult(successEnvelope('node_delete', data, {
          status: 'unchanged',
          metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
        }));
      }

      try {
        if (selection.nodeIds.length === 1) {
          await host.handle('trash_node', { nodeId: selection.nodeIds[0] });
        } else {
          await host.handle('batch_trash_nodes', { nodeIds: selection.nodeIds });
        }
      } catch (error) {
        return agentToolResult(errorEnvelope('node_delete', 'mutation_failed', errorMessage(error), {
          nextStep: 'Use node_read to verify the selected nodes still exist and are movable.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      return agentToolResult(successEnvelope('node_delete', data, {
        warnings: selection.skipped.length ? ['Some requested descendant nodes were covered by a selected ancestor and skipped.'] : undefined,
        metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
      }));
    },
  };
}

async function executeOutlineEdit(
  host: OutlinerToolHost,
  params: Extract<NormalizedEditParams, { action: 'outline_edit' }>,
  started: number,
) {
  const index = indexProjection(host.getProjection());
  const validation = validateMutableNodeIds(index, [params.nodeId]);
  if (validation) {
    return agentToolResult(errorEnvelope<NodeEditData>('node_edit', validation.code, validation.error, {
      nextStep: validation.nextStep,
      metrics: { durationMs: elapsed(started) },
    }));
  }
  const currentNode = requiredNode(index, params.nodeId);
  const currentRevision = revisionOf(currentNode);
  if (params.expectedRevision && params.expectedRevision !== currentRevision) {
    return agentToolResult(errorEnvelope<NodeEditData>('node_edit', 'revision_mismatch', `Node changed since it was read: ${params.nodeId}`, {
      nextStep: 'Call node_read again and retry with the latest outline and revision.',
      metrics: { durationMs: elapsed(started) },
    }));
  }

  const currentOutline = serializeOutline(index, params.nodeId, 12, 0, 500, false);
  const replacement = replaceOutline(currentOutline, params.oldString, params.newString);
  if (!replacement.ok) {
    return agentToolResult(errorEnvelope<NodeEditData>('node_edit', replacement.code, replacement.error, {
      nextStep: replacement.nextStep,
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
    return agentToolResult(successEnvelope('node_edit', data, {
      status: 'unchanged',
      metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
    }));
  }

  const parsed = parseLinOutline(replacement.afterOutline);
  if (!parsed.ok) {
    return agentToolResult(errorEnvelope<NodeEditData>('node_edit', 'parse_error', parsed.error.message, {
      hint: `Line ${parsed.error.line}, column ${parsed.error.column}`,
      nextStep: 'Fix newString so the complete outline remains valid Lin Outline Format.',
      metrics: { durationMs: elapsed(started) },
    }));
  }
  if (parsed.document.roots.length !== 1) {
    return agentToolResult(errorEnvelope<NodeEditData>('node_edit', 'ambiguous_root', 'node_edit must produce exactly one root node for the target nodeId.', {
      nextStep: 'Call node_create for new sibling roots, or edit a child node directly.',
      metrics: { durationMs: elapsed(started) },
    }));
  }
  const referenceValidation = validateReferenceTargetIds(index, collectReferenceTargetIds(parsed.document));
  if (referenceValidation) {
    return agentToolResult(errorEnvelope<NodeEditData>('node_edit', referenceValidation.code, referenceValidation.error, {
      nextStep: referenceValidation.nextStep,
      metrics: { durationMs: elapsed(started) },
    }));
  }
  const searchValidation = validateSearchNodes(index, parsed.document);
  if (searchValidation) {
    return agentToolResult(errorEnvelope<NodeEditData>('node_edit', searchValidation.code, searchValidation.error, {
      nextStep: searchValidation.nextStep,
      metrics: { durationMs: elapsed(started) },
    }));
  }
  if (parsed.document.roots[0]!.referenceTargetId) {
    return agentToolResult(errorEnvelope<NodeEditData>('node_edit', 'invalid_outline_root', 'Outline edits cannot turn the target root into a reference.', {
      nextStep: 'Use node_edit with replaceWithReferenceTo for root reference replacement.',
      metrics: { durationMs: elapsed(started) },
    }));
  }

  if (params.previewOnly) {
    const data: NodeEditData = { ...dataBase, status: 'updated' };
    return agentToolResult(successEnvelope('node_edit', data, {
      status: 'unchanged',
      warnings: parsed.warnings.length ? parsed.warnings : undefined,
      metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
    }));
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
    return agentToolResult(errorEnvelope<NodeEditData>('node_edit', 'mutation_failed', errorMessage(error), {
      nextStep: 'Use node_read to refresh the target node, then retry a smaller exact replacement if needed.',
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
  return agentToolResult(successEnvelope('node_edit', data, {
    warnings: warnings.length ? unique(warnings) : undefined,
    metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
  }));
}

async function executeMoveEdit(
  host: OutlinerToolHost,
  params: Extract<NormalizedEditParams, { action: 'move' }>,
  started: number,
) {
  const index = indexProjection(host.getProjection());
  const validation = validateMutableNodeIds(index, params.nodeIds);
  if (validation) {
    return agentToolResult(errorEnvelope<NodeEditData>('node_edit', validation.code, validation.error, {
      nextStep: validation.nextStep,
      metrics: { durationMs: elapsed(started) },
    }));
  }

  const moveValidation = validateMoveRequest(index, params.nodeIds, params.move);
  if (moveValidation) {
    return agentToolResult(errorEnvelope<NodeEditData>('node_edit', moveValidation.code, moveValidation.error, {
      nextStep: moveValidation.nextStep,
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
    return agentToolResult(successEnvelope('node_edit', data, {
      status: 'unchanged',
      metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
    }));
  }

  try {
    if (params.move.structuralAction) {
      await runStructuralMove(host, params.nodeIds, params.move.structuralAction);
    } else {
      await runAbsoluteMove(host, params.nodeIds, params.move);
    }
  } catch (error) {
    return agentToolResult(errorEnvelope<NodeEditData>('node_edit', 'mutation_failed', errorMessage(error), {
      nextStep: 'Use node_read to refresh the source and destination ids before retrying.',
      metrics: { durationMs: elapsed(started) },
    }));
  }

  const updatedIndex = indexProjection(host.getProjection());
  data.revisions = Object.fromEntries(params.nodeIds
    .map((nodeId) => updatedIndex.nodes.get(nodeId))
    .filter((node): node is NodeProjection => Boolean(node))
    .map((node) => [node.id, revisionOf(node)]));
  return agentToolResult(successEnvelope('node_edit', data, {
    metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
  }));
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
    return agentToolResult(errorEnvelope<NodeEditData>('node_edit', validation.code, validation.error, {
      nextStep: validation.nextStep,
      metrics: { durationMs: elapsed(started) },
    }));
  }
  if (params.mergeFromNodeIds.includes(params.nodeId)) {
    return agentToolResult(errorEnvelope<NodeEditData>('node_edit', 'invalid_merge', 'mergeFromNodeIds cannot include the target nodeId.', {
      nextStep: 'Pass only duplicate/source nodes in mergeFromNodeIds.',
      metrics: { durationMs: elapsed(started) },
    }));
  }
  const ancestorSource = params.mergeFromNodeIds.find((sourceId) => isDescendantOf(index, params.nodeId, sourceId));
  if (ancestorSource) {
    return agentToolResult(errorEnvelope<NodeEditData>('node_edit', 'invalid_merge', `Cannot merge ancestor ${ancestorSource} into descendant ${params.nodeId}.`, {
      nextStep: 'Choose an ancestor as the merge target, or move content manually.',
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
    return agentToolResult(successEnvelope('node_edit', data, {
      status: 'unchanged',
      warnings: ['Merge preview does not mutate. Source titles and descriptions are not appended to the target.'],
      metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
    }));
  }

  try {
    await runMerge(host, params.nodeId, params.mergeFromNodeIds);
  } catch (error) {
    return agentToolResult(errorEnvelope<NodeEditData>('node_edit', 'mutation_failed', errorMessage(error), {
      nextStep: 'Use node_read to refresh the target and source ids, then retry.',
      metrics: { durationMs: elapsed(started) },
    }));
  }

  const updatedNode = indexProjection(host.getProjection()).nodes.get(params.nodeId);
  if (updatedNode) data.revisions = { [params.nodeId]: revisionOf(updatedNode) };
  return agentToolResult(successEnvelope('node_edit', data, {
    warnings: ['Source titles and descriptions are not appended to the target; source nodes are preserved in Trash for undo/restore.'],
    metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
  }));
}

async function executeReferenceReplaceEdit(
  host: OutlinerToolHost,
  params: Extract<NormalizedEditParams, { action: 'replace_with_reference' }>,
  started: number,
) {
  const index = indexProjection(host.getProjection());
  const validation = validateMutableNodeIds(index, [params.nodeId]);
  if (validation) {
    return agentToolResult(errorEnvelope<NodeEditData>('node_edit', validation.code, validation.error, {
      nextStep: validation.nextStep,
      metrics: { durationMs: elapsed(started) },
    }));
  }
  const targetValidation = validateReferenceTargetIds(index, [params.replaceWithReferenceTo]);
  if (targetValidation) {
    return agentToolResult(errorEnvelope<NodeEditData>('node_edit', targetValidation.code, targetValidation.error, {
      nextStep: targetValidation.nextStep,
      metrics: { durationMs: elapsed(started) },
    }));
  }
  if (params.nodeId === params.replaceWithReferenceTo) {
    return agentToolResult(errorEnvelope<NodeEditData>('node_edit', 'invalid_reference', 'A node cannot be replaced with a reference to itself.', {
      nextStep: 'Choose a different target node id.',
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
    return agentToolResult(successEnvelope('node_edit', data, {
      status: 'unchanged',
      metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
    }));
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
    return agentToolResult(successEnvelope('node_edit', data, {
      status: 'unchanged',
      metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
    }));
  }

  try {
    const createdReferenceId = focusFromOutcome(await host.handle('replace_node_with_reference', {
      nodeId: params.nodeId,
      targetId: params.replaceWithReferenceTo,
    }));
    if (!retargetingReference) data.createdNodeIds = [createdReferenceId];
    data.affectedNodeIds = unique([...data.affectedNodeIds, createdReferenceId]);
  } catch (error) {
    return agentToolResult(errorEnvelope<NodeEditData>('node_edit', 'mutation_failed', errorMessage(error), {
      nextStep: 'Use node_read to refresh the node and target ids before retrying.',
      metrics: { durationMs: elapsed(started) },
    }));
  }

  return agentToolResult(successEnvelope('node_edit', data, {
    metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
  }));
}

function createNodeCreateTool(host: OutlinerToolHost): AgentTool<any, ToolEnvelope<NodeCreateData>> {
  return {
    name: 'node_create',
    label: 'Node Create',
    description: [
      'Create Lin outliner content under a parent. Omit parentId to create under today.',
      'Use outline for Lin Outline Format. Use targetId for one reference node. Use duplicateId to recreate a subtree.',
      'Insertion: afterId omitted appends; afterId null inserts first; afterId string inserts after that sibling.',
    ].join('\n'),
    parameters: NODE_CREATE_PARAMETERS,
    executionMode: 'sequential',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      const params = normalizeCreateParams(rawParams);
      if (params.error) {
        return agentToolResult(errorEnvelope('node_create', 'invalid_args', params.error, {
          nextStep: 'Call node_create with exactly one of outline, targetId, or duplicateId.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      const initialIndex = indexProjection(host.getProjection());
      const insertion = resolveInsertion(initialIndex, params);
      if ('error' in insertion) {
        return agentToolResult(errorEnvelope('node_create', insertion.code, insertion.error, {
          nextStep: insertion.nextStep,
          metrics: { durationMs: elapsed(started) },
        }));
      }

      if (params.targetId) {
        const targetValidation = validateReferenceTargetIds(initialIndex, [params.targetId]);
        if (targetValidation) {
          return agentToolResult(errorEnvelope('node_create', targetValidation.code, targetValidation.error, {
            nextStep: targetValidation.nextStep,
            metrics: { durationMs: elapsed(started) },
          }));
        }
        if (params.previewOnly) {
          return agentToolResult(successEnvelope('node_create', {
            parentId: insertion.parentId,
            afterId: insertion.afterId,
            createdRootIds: [],
            createdNodeIds: [],
            targetId: params.targetId,
          }, {
            status: 'unchanged',
            metrics: { durationMs: elapsed(started) },
          }));
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
          return agentToolResult(successEnvelope('node_create', data, {
            metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
          }));
        } catch (error) {
          return agentToolResult(errorEnvelope('node_create', 'mutation_failed', errorMessage(error), {
            nextStep: 'Check that the parent and reference target are valid and retry.',
            metrics: { durationMs: elapsed(started) },
          }));
        }
      }

      const outline = params.duplicateId
        ? duplicateOutline(initialIndex, params.duplicateId)
        : { ok: true as const, outline: params.outline! };
      if (!outline.ok) {
        return agentToolResult(errorEnvelope('node_create', outline.code, outline.error, {
          nextStep: outline.nextStep,
          metrics: { durationMs: elapsed(started) },
        }));
      }

      const parsed = parseLinOutline(outline.outline);
      if (!parsed.ok) {
        return agentToolResult(errorEnvelope('node_create', 'parse_error', parsed.error.message, {
          hint: `Line ${parsed.error.line}, column ${parsed.error.column}`,
          nextStep: 'Fix the outline so every non-empty line uses "- " and 2-space indentation.',
          metrics: { durationMs: elapsed(started) },
        }));
      }
      const referenceValidation = validateReferenceTargetIds(initialIndex, collectReferenceTargetIds(parsed.document));
      if (referenceValidation) {
        return agentToolResult(errorEnvelope('node_create', referenceValidation.code, referenceValidation.error, {
          nextStep: referenceValidation.nextStep,
          metrics: { durationMs: elapsed(started) },
        }));
      }
      const searchValidation = validateSearchNodes(initialIndex, parsed.document);
      if (searchValidation) {
        return agentToolResult(errorEnvelope('node_create', searchValidation.code, searchValidation.error, {
          nextStep: searchValidation.nextStep,
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
        return agentToolResult(successEnvelope('node_create', data, {
          status: 'unchanged',
          warnings: parsed.warnings.length ? parsed.warnings : undefined,
          metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
        }));
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
        return agentToolResult(errorEnvelope('node_create', 'mutation_failed', errorMessage(error), {
          nextStep: 'Use node_read/node_search to verify node ids, references, and parent insertion point before retrying.',
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
      return agentToolResult(successEnvelope('node_create', data, {
        warnings: warnings.length ? unique(warnings) : undefined,
        metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
      }));
    },
  };
}

function createNodeReadTool(host: OutlinerToolHost): AgentTool<any, ToolEnvelope<NodeReadData>> {
  return {
    name: 'node_read',
    label: 'Node Read',
    description: [
      'Read Lin outliner nodes as structured data and optional canonical outline text.',
      'Omit nodeId to read today. Use depth/childOffset/childLimit to bound children.',
      'Use node_read before node_edit when you need exact node ids or canonical outline fragments.',
    ].join('\n'),
    parameters: NODE_READ_PARAMETERS,
    executionMode: 'parallel',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      const params = normalizeReadParams(rawParams);
      if (params.error) {
        return agentToolResult(errorEnvelope('node_read', 'invalid_args', params.error, {
          nextStep: 'Call node_read with either nodeId or nodeIds, not both.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      const index = indexProjection(host.getProjection());
      const nodeIds = params.nodeIds ?? [params.nodeId ?? index.projection.todayId];
      const missing = nodeIds.find((nodeId) => !index.nodes.has(nodeId));
      if (missing) {
        return agentToolResult(errorEnvelope('node_read', 'node_not_found', `Node not found: ${missing}`, {
          nextStep: 'Use node_search to locate the current node id.',
          metrics: { durationMs: elapsed(started) },
        }));
      }
      const deleted = nodeIds.find((nodeId) => !params.includeDeleted && isInTrash(index, nodeId));
      if (deleted) {
        return agentToolResult(errorEnvelope('node_read', 'node_in_trash', `Node is in Trash: ${deleted}`, {
          nextStep: 'Call node_read with includeDeleted true if you intentionally need Trash content.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      const items = nodeIds.map((nodeId) => buildReadItem(index, nodeId, params));
      return agentToolResult(successEnvelope('node_read', { items }, {
        metrics: {
          durationMs: elapsed(started),
          truncated: items.some((item) => pageHasMore(item.children)),
          outputBytes: jsonByteLength({ items }),
        },
      }));
    },
  };
}

function createNodeSearchTool(host: OutlinerToolHost): AgentTool<any, ToolEnvelope<NodeSearchData>> {
  return {
    name: 'node_search',
    label: 'Node Search',
    description: [
      'Search Lin outliner nodes. Use query for simple full-text search.',
      'Use outline for temporary search-node syntax: "- %%search%% Title" plus child condition lines.',
      'Use searchNodeId to execute a saved search node.',
    ].join('\n'),
    parameters: NODE_SEARCH_PARAMETERS,
    executionMode: 'parallel',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      const params = normalizeSearchParams(rawParams);
      if (params.error) {
        return agentToolResult(errorEnvelope('node_search', 'invalid_args', params.error, {
          nextStep: 'Call node_search with exactly one of query, outline, or searchNodeId.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      const index = indexProjection(host.getProjection());
      const offset = clampInteger(params.offset, 0, Number.MAX_SAFE_INTEGER, 0);
      const limit = clampInteger(params.limit, 1, 50, 20);
      const search = resolveSearch(index, params);
      if ('error' in search) {
        return agentToolResult(errorEnvelope('node_search', search.code, search.error, {
          nextStep: search.nextStep,
          metrics: { durationMs: elapsed(started) },
        }));
      }

      if (
        search.queryTerms.length === 0
        && search.tagIds.length === 0
        && search.linkTargetIds.length === 0
        && search.fieldConditions.length === 0
      ) {
        return agentToolResult(errorEnvelope('node_search', 'empty_search', 'Search has no executable terms.', {
          nextStep: 'Provide a non-empty query or add condition lines to the search outline.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      const resultIds = runSearch(index, search);
      const total = resultIds.length;
      const pageIds = resultIds.slice(offset, offset + limit);
      const items = params.count ? undefined : pageIds.map((nodeId) => buildSearchItem(index, nodeId, search.queryTerms));
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
        unresolvedTags: search.unresolvedTagNames.length ? search.unresolvedTagNames : undefined,
        unresolvedFields: search.unresolvedFields.length ? search.unresolvedFields : undefined,
      };

      return agentToolResult(successEnvelope('node_search', data, {
        nextStep: offset + limit < total ? `Call node_search with offset ${offset + limit} to continue.` : undefined,
        warnings: search.warnings.length ? search.warnings : undefined,
        metrics: {
          durationMs: elapsed(started),
          truncated: offset + limit < total,
          outputBytes: jsonByteLength(data),
        },
      }));
    },
  };
}

function normalizeReadParams(rawParams: unknown): Required<Pick<NodeReadParams, 'depth' | 'childOffset' | 'childLimit' | 'format' | 'includeDeleted' | 'includeBacklinks'>>
  & Pick<NodeReadParams, 'nodeId' | 'nodeIds'>
  & { error?: string } {
  const input = asRecord(rawParams);
  const nodeId = typeof input.nodeId === 'string' && input.nodeId.trim() ? input.nodeId.trim() : undefined;
  const nodeIds = Array.isArray(input.nodeIds)
    ? input.nodeIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim())
    : undefined;
  const format = input.format === 'structured' || input.format === 'outline' || input.format === 'both'
    ? input.format
    : 'both';
  return {
    nodeId,
    nodeIds,
    depth: clampInteger(input.depth, 0, 3, 1),
    childOffset: clampInteger(input.childOffset, 0, Number.MAX_SAFE_INTEGER, 0),
    childLimit: clampInteger(input.childLimit, 0, 50, 20),
    format,
    includeDeleted: input.includeDeleted === true,
    includeBacklinks: input.includeBacklinks === true,
    error: nodeId && nodeIds ? 'Use either nodeId or nodeIds, not both.' : undefined,
  };
}

function normalizeSearchParams(rawParams: unknown): Required<Pick<NodeSearchParams, 'limit' | 'offset' | 'count'>>
  & Pick<NodeSearchParams, 'outline' | 'searchNodeId' | 'query'>
  & { error?: string } {
  const input = asRecord(rawParams);
  const outline = typeof input.outline === 'string' && input.outline.trim() ? input.outline.trim() : undefined;
  const searchNodeId = typeof input.searchNodeId === 'string' && input.searchNodeId.trim() ? input.searchNodeId.trim() : undefined;
  const query = typeof input.query === 'string' && input.query.trim() ? input.query.trim() : undefined;
  const provided = [outline, searchNodeId, query].filter(Boolean).length;
  return {
    outline,
    searchNodeId,
    query,
    limit: clampInteger(input.limit, 1, 50, 20),
    offset: clampInteger(input.offset, 0, Number.MAX_SAFE_INTEGER, 0),
    count: input.count === true,
    error: provided === 1 ? undefined : 'Exactly one of query, outline, or searchNodeId is required.',
  };
}

function normalizeCreateParams(rawParams: unknown): NodeCreateParams & { error?: string } {
  const input = asRecord(rawParams);
  const parentId = typeof input.parentId === 'string' && input.parentId.trim() ? input.parentId.trim() : undefined;
  const afterId = input.afterId === null
    ? null
    : typeof input.afterId === 'string' && input.afterId.trim()
      ? input.afterId.trim()
      : undefined;
  const outline = typeof input.outline === 'string' && input.outline.trim() ? input.outline.trim() : undefined;
  const targetId = typeof input.targetId === 'string' && input.targetId.trim() ? input.targetId.trim() : undefined;
  const duplicateId = typeof input.duplicateId === 'string' && input.duplicateId.trim() ? input.duplicateId.trim() : undefined;
  const provided = [outline, targetId, duplicateId].filter(Boolean).length;
  return {
    parentId,
    afterId,
    outline,
    targetId,
    duplicateId,
    previewOnly: input.previewOnly === true,
    error: provided === 1 ? undefined : 'Exactly one of outline, targetId, or duplicateId is required.',
  };
}

function normalizeDeleteParams(rawParams: unknown): NodeDeleteParams & { error?: string } {
  const input = asRecord(rawParams);
  const nodeId = typeof input.nodeId === 'string' && input.nodeId.trim() ? input.nodeId.trim() : undefined;
  const nodeIds = Array.isArray(input.nodeIds)
    ? unique(input.nodeIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim()))
    : undefined;
  return {
    nodeId,
    nodeIds,
    restore: input.restore === true,
    previewOnly: input.previewOnly === true,
    error: nodeId && nodeIds ? 'Use either nodeId or nodeIds, not both.' : !nodeId && !nodeIds ? 'nodeId or nodeIds is required.' : undefined,
  };
}

function normalizeEditParams(rawParams: unknown): NormalizedEditParams {
  const input = asRecord(rawParams);
  const nodeId = typeof input.nodeId === 'string' && input.nodeId.trim() ? input.nodeId.trim() : undefined;
  const nodeIds = Array.isArray(input.nodeIds)
    ? unique(input.nodeIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim()))
    : undefined;
  const oldString = typeof input.oldString === 'string' ? normalizeLineEndings(input.oldString) : undefined;
  const newString = typeof input.newString === 'string' ? normalizeLineEndings(input.newString) : undefined;
  const expectedRevision = typeof input.expectedRevision === 'string' && input.expectedRevision.trim() ? input.expectedRevision.trim() : undefined;
  const move = normalizeMoveParams(input.move);
  const mergeFromNodeIds = Array.isArray(input.mergeFromNodeIds)
    ? unique(input.mergeFromNodeIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim()))
    : undefined;
  const replaceWithReferenceTo = typeof input.replaceWithReferenceTo === 'string' && input.replaceWithReferenceTo.trim()
    ? input.replaceWithReferenceTo.trim()
    : undefined;
  const previewOnly = input.previewOnly === true;

  const outlineAction = Boolean(nodeId && oldString !== undefined && newString !== undefined);
  const moveAction = Boolean(move !== undefined && (nodeId || nodeIds));
  const mergeAction = Boolean(nodeId && mergeFromNodeIds !== undefined);
  const referenceAction = Boolean(nodeId && replaceWithReferenceTo !== undefined);
  const provided = [outlineAction, moveAction, mergeAction, referenceAction].filter(Boolean).length;
  if (provided !== 1) return { error: 'Exactly one node_edit action is required.' };
  if (nodeId && nodeIds && !moveAction) return { error: 'nodeIds is only valid for move actions.' };
  if (nodeId && nodeIds && moveAction) return { error: 'Use either nodeId or nodeIds for move actions, not both.' };

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
  const operationId = typeof input.operationId === 'string' && input.operationId.trim() ? input.operationId.trim() : undefined;
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
  const parentId = typeof input.parentId === 'string' && input.parentId.trim() ? input.parentId.trim() : undefined;
  const afterId = input.afterId === null
    ? null
    : typeof input.afterId === 'string' && input.afterId.trim()
      ? input.afterId.trim()
      : undefined;
  const structuralAction = input.structuralAction === 'indent'
    || input.structuralAction === 'outdent'
    || input.structuralAction === 'move_up'
    || input.structuralAction === 'move_down'
    ? input.structuralAction
    : undefined;
  return { parentId, afterId, structuralAction };
}

function resolveInsertion(index: ProjectionIndex, params: NodeCreateParams): {
  parentId: string;
  afterId?: string | null;
  index: number | null;
} | { code: string; error: string; nextStep: string } {
  if (params.afterId === null) {
    const parentId = params.parentId ?? index.projection.todayId;
    if (!index.nodes.has(parentId)) return parentNotFound(parentId);
    return { parentId, afterId: null, index: 0 };
  }
  if (params.afterId) {
    const after = index.nodes.get(params.afterId);
    if (!after) return { code: 'node_not_found', error: `afterId not found: ${params.afterId}`, nextStep: 'Use node_read on the parent to find a current sibling id.' };
    if (!after.parentId) return { code: 'invalid_insertion', error: `afterId has no parent: ${params.afterId}`, nextStep: 'Pass an explicit parentId and omit afterId.' };
    const parentId = params.parentId ?? after.parentId;
    if (parentId !== after.parentId) {
      return { code: 'invalid_insertion', error: `afterId ${params.afterId} is not a child of parentId ${parentId}`, nextStep: 'Use either afterId alone or pass the matching parentId.' };
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

function validateMutableNodeIds(index: ProjectionIndex, nodeIds: string[]): { code: string; error: string; nextStep: string } | null {
  const missing = nodeIds.find((nodeId) => !index.nodes.has(nodeId));
  if (missing) return { code: 'node_not_found', error: `Node not found: ${missing}`, nextStep: 'Use node_search or node_read to locate the current node id.' };
  const system = nodeIds.find((nodeId) => SYSTEM_IDS.has(nodeId));
  if (system) return { code: 'locked_node', error: `System node cannot be edited: ${system}`, nextStep: 'Choose a user-created node.' };
  const locked = nodeIds.find((nodeId) => index.nodes.get(nodeId)?.locked);
  if (locked) return { code: 'locked_node', error: `Locked node cannot be edited: ${locked}`, nextStep: 'Choose an editable node.' };
  const trashed = nodeIds.find((nodeId) => isInTrash(index, nodeId));
  if (trashed) return { code: 'node_in_trash', error: `Node is in Trash: ${trashed}`, nextStep: 'Restore the node before editing it.' };
  return null;
}

function replaceOutline(currentOutline: string, oldString: string, newString: string): {
  ok: true;
  afterOutline: string;
} | { ok: false; code: string; error: string; nextStep: string } {
  const normalizedOld = normalizeLineEndings(oldString);
  const normalizedNew = normalizeLineEndings(newString);
  if (normalizedOld === '*') return { ok: true, afterOutline: normalizedNew.trim() };
  const matches = countOccurrences(currentOutline, normalizedOld);
  if (matches === 0) {
    return {
      ok: false,
      code: 'old_string_not_found',
      error: 'oldString did not match the current canonical outline.',
      nextStep: 'Call node_read again and copy an exact fragment from outline.',
    };
  }
  if (matches > 1) {
    return {
      ok: false,
      code: 'old_string_not_unique',
      error: `oldString matched ${matches} times in the current canonical outline.`,
      nextStep: 'Include more surrounding context or edit the intended child node directly by nodeId.',
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
    warnings.push(...spec.warnings);
    if (spec.unresolvedTagNames.length) {
      throw new Error(`Search references unknown tags: ${spec.unresolvedTagNames.join(', ')}`);
    }
    if (spec.unresolvedFields.length) {
      throw new Error(`Search references unknown fields: ${spec.unresolvedFields.join(', ')}`);
    }
    await host.handle('set_search_node', {
      nodeId,
      config: searchNodeConfigFromSpec(spec),
    });
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
    warnings.push(...spec.warnings);
    if (spec.unresolvedTagNames.length) {
      throw new Error(`Search references unknown tags: ${spec.unresolvedTagNames.join(', ')}`);
    }
    if (spec.unresolvedFields.length) {
      throw new Error(`Search references unknown fields: ${spec.unresolvedFields.join(', ')}`);
    }
    await host.handle('set_search_node', {
      nodeId,
      config: searchNodeConfigFromSpec(spec),
    });
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
  if (current.type === 'reference') throw new Error('Outline edit cannot update a reference node root; use replaceWithReferenceTo.');
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
  const plan = sequenceEditPlan(
    existingFieldIds,
    fields,
    (fieldEntryId) => fieldName(index, requiredNode(index, fieldEntryId)).toLowerCase(),
    (field) => field.name.trim().toLowerCase(),
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
  const existingValueIds = [...requiredNode(index, fieldEntryId).children].filter((childId) => !isInTrash(index, childId));
  const desiredValues = field.clear ? [] : field.values;
  const plan = sequenceEditPlan(
    existingValueIds,
    desiredValues,
    (valueId) => outlineValueKeyFromProjection(index, requiredNode(index, valueId)),
    outlineValueKey,
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

async function syncNormalChildren(
  host: OutlinerToolHost,
  parentId: string,
  desiredChildren: OutlineNode[],
  tracker: MutationTracker,
  warnings: string[],
): Promise<{ trashedNodeIds: string[] }> {
  const index = indexProjection(host.getProjection());
  const existingChildIds = normalChildIds(index, parentId, false);
  const plan = sequenceEditPlan(
    existingChildIds,
    desiredChildren,
    (childId) => outlineNodeKeyFromProjection(index, requiredNode(index, childId)),
    outlineNodeKey,
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
  existingKey: (item: TExisting) => string,
  desiredKey: (item: TDesired) => string,
): Array<SequenceEditItem<TExisting, TDesired>> {
  const existingKeys = existing.map(existingKey);
  const desiredKeys = desired.map(desiredKey);
  const dp = Array.from({ length: existing.length + 1 }, () => Array(desired.length + 1).fill(0) as number[]);
  for (let left = existing.length - 1; left >= 0; left -= 1) {
    for (let right = desired.length - 1; right >= 0; right -= 1) {
      dp[left]![right] = existingKeys[left] === desiredKeys[right]
        ? dp[left + 1]![right + 1]! + 1
        : Math.max(dp[left + 1]![right]!, dp[left]![right + 1]!);
    }
  }

  const anchors: Array<{ existingIndex: number; desiredIndex: number }> = [];
  let left = 0;
  let right = 0;
  while (left < existing.length && right < desired.length) {
    if (existingKeys[left] === desiredKeys[right]) {
      anchors.push({ existingIndex: left, desiredIndex: right });
      left += 1;
      right += 1;
    } else if (dp[left + 1]![right]! >= dp[left]![right + 1]!) {
      left += 1;
    } else {
      right += 1;
    }
  }

  const result: Array<SequenceEditItem<TExisting, TDesired>> = [];
  const appendGap = (existingStart: number, existingEnd: number, desiredStart: number, desiredEnd: number) => {
    const oldGap = existing.slice(existingStart, existingEnd);
    const newGap = desired.slice(desiredStart, desiredEnd);
    const paired = Math.min(oldGap.length, newGap.length);
    for (let index = 0; index < paired; index += 1) {
      result.push({ existing: oldGap[index], desired: newGap[index] });
    }
    for (const item of oldGap.slice(paired)) result.push({ existing: item });
    for (const item of newGap.slice(paired)) result.push({ desired: item });
  };

  let existingCursor = 0;
  let desiredCursor = 0;
  for (const anchor of anchors) {
    appendGap(existingCursor, anchor.existingIndex, desiredCursor, anchor.desiredIndex);
    result.push({ existing: existing[anchor.existingIndex], desired: desired[anchor.desiredIndex] });
    existingCursor = anchor.existingIndex + 1;
    desiredCursor = anchor.desiredIndex + 1;
  }
  appendGap(existingCursor, existing.length, desiredCursor, desired.length);
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
  const current = indexProjection(host.getProjection()).nodes.get(nodeId);
  if (!current) throw new Error(`Node not found: ${nodeId}`);
  const isCompleted = Boolean(current.completedAt);
  if (checked === true) {
    if (!current.showCheckbox) await host.handle('set_node_checkbox_visible', { nodeId, visible: true });
    if (!isCompleted) await host.handle('toggle_done', { nodeId });
    return;
  }
  if (checked === false) {
    if (isCompleted) await host.handle('toggle_done', { nodeId });
    const latest = indexProjection(host.getProjection()).nodes.get(nodeId);
    if (!latest?.showCheckbox) await host.handle('set_node_checkbox_visible', { nodeId, visible: true });
    return;
  }
  if (isCompleted) await host.handle('toggle_done', { nodeId });
  const latest = indexProjection(host.getProjection()).nodes.get(nodeId);
  if (latest?.showCheckbox) await host.handle('set_node_checkbox_visible', { nodeId, visible: false });
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

function validateMoveRequest(index: ProjectionIndex, nodeIds: string[], move: NodeEditMoveParams): { code: string; error: string; nextStep: string } | null {
  if (move.structuralAction) {
    if (move.parentId || move.afterId !== undefined) {
      return { code: 'invalid_move', error: 'structuralAction cannot be combined with parentId or afterId.', nextStep: 'Use either a structural action or an absolute destination.' };
    }
    return null;
  }
  if (!move.parentId && move.afterId === undefined) {
    return { code: 'invalid_move', error: 'Absolute moves require parentId, afterId, or both.', nextStep: 'Pass move.parentId to append under a parent, or move.afterId to insert after a sibling.' };
  }
  if (move.afterId && nodeIds.includes(move.afterId)) {
    return { code: 'invalid_move', error: 'afterId cannot be one of the moved nodes.', nextStep: 'Choose a stable sibling outside the moved selection.' };
  }
  const after = move.afterId ? index.nodes.get(move.afterId) : undefined;
  if (move.afterId && !after) {
    return { code: 'node_not_found', error: `afterId not found: ${move.afterId}`, nextStep: 'Use node_read to refresh destination sibling ids.' };
  }
  const parentId = move.parentId ?? after?.parentId;
  if (!parentId) return { code: 'invalid_move', error: 'Destination parent could not be resolved.', nextStep: 'Pass move.parentId explicitly.' };
  const parent = index.nodes.get(parentId);
  if (!parent) return parentNotFound(parentId);
  if (isInTrash(index, parentId)) return { code: 'node_in_trash', error: `Destination parent is in Trash: ${parentId}`, nextStep: 'Choose a non-deleted destination parent.' };
  if (move.afterId && !parent.children.includes(move.afterId)) {
    return { code: 'invalid_move', error: `afterId ${move.afterId} is not a child of destination parent ${parentId}.`, nextStep: 'Pass the matching parentId or omit parentId.' };
  }
  const cycleNodeId = nodeIds.find((nodeId) => parentId === nodeId || isDescendantOf(index, parentId, nodeId));
  if (cycleNodeId) {
    return { code: 'invalid_move', error: `Cannot move ${cycleNodeId} under itself or one of its descendants.`, nextStep: 'Choose a destination outside the moved subtree.' };
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
    nextStep: 'Use node_read or node_search to find the current parent node id.',
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
    warnings.push(...spec.warnings);
    if (spec.unresolvedTagNames.length) {
      throw new Error(`Search references unknown tags: ${spec.unresolvedTagNames.join(', ')}`);
    }
    if (spec.unresolvedFields.length) {
      throw new Error(`Search references unknown fields: ${spec.unresolvedFields.join(', ')}`);
    }
    const createdId = focusFromOutcome(await host.handle('create_search_node', {
      parentId,
      index,
      config: searchNodeConfigFromSpec(spec),
    }));
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
  for (const field of node.fields) {
    await createField(host, createdId, field, tracker);
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

async function applyTags(host: OutlinerToolHost, nodeId: string, tags: string[], tracker: MutationTracker) {
  for (const tagName of tags) {
    const before = indexProjection(host.getProjection());
    const existing = findTagByName(before, tagName);
    const tagId = existing?.id ?? focusFromOutcome(await host.handle('create_tag', { name: tagName }));
    if (!existing) tracker.createdTagIds.push(tagId);
    await host.handle('apply_tag', { nodeId, tagId });
  }
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
  if (fieldEntry?.fieldDefId) tracker.createdFieldDefIds.push(fieldEntry.fieldDefId);
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

function duplicateOutline(index: ProjectionIndex, duplicateId: string): { ok: true; outline: string } | { ok: false; code: string; error: string; nextStep: string } {
  if (!index.nodes.has(duplicateId)) {
    return { ok: false, code: 'node_not_found', error: `Duplicate source node not found: ${duplicateId}`, nextStep: 'Use node_search to locate the source node id.' };
  }
  if (isInTrash(index, duplicateId)) {
    return { ok: false, code: 'node_in_trash', error: `Duplicate source is in Trash: ${duplicateId}`, nextStep: 'Restore or choose a non-deleted source node.' };
  }
  return { ok: true, outline: serializeOutline(index, duplicateId, 12, 0, 500, false) };
}

function collectReferenceTargetIds(document: OutlineDocument): string[] {
  const ids: string[] = [];
  for (const root of document.roots) collectNodeReferenceTargetIds(root, ids);
  return unique(ids);
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

function validateReferenceTargetIds(index: ProjectionIndex, targetIds: string[]): { code: string; error: string; nextStep: string } | null {
  const missing = targetIds.find((targetId) => !index.nodes.has(targetId));
  if (missing) {
    return {
      code: 'node_not_found',
      error: `Reference target not found: ${missing}`,
      nextStep: 'Use node_search to locate the target id, then retry with [[Display^nodeId]].',
    };
  }
  const trashed = targetIds.find((targetId) => isInTrash(index, targetId));
  if (trashed) {
    return {
      code: 'node_in_trash',
      error: `Reference target is in Trash: ${trashed}`,
      nextStep: 'Choose a non-deleted target node or restore the target first.',
    };
  }
  return null;
}

function validateSearchNodes(index: ProjectionIndex, document: OutlineDocument): { code: string; error: string; nextStep: string } | null {
  for (const root of document.roots) {
    const validation = validateSearchNode(index, root);
    if (validation) return validation;
  }
  return null;
}

function validateSearchNode(index: ProjectionIndex, node: OutlineNode): { code: string; error: string; nextStep: string } | null {
  if (node.search) {
    const spec = resolveSearchSpecFromOutlineNode(index, node);
    if (spec.unresolvedTagNames.length) {
      return {
        code: 'unresolved_tag',
        error: `Search references unknown tags: ${spec.unresolvedTagNames.join(', ')}`,
        nextStep: 'Create/apply the tag first, or remove the tag condition from the search node outline.',
      };
    }
    if (spec.unresolvedFields.length) {
      return {
        code: 'unresolved_field',
        error: `Search references unknown fields: ${spec.unresolvedFields.join(', ')}`,
        nextStep: 'Create the field definition first, or remove the field condition from the search node outline.',
      };
    }
  }
  for (const child of node.children) {
    const validation = validateSearchNode(index, child);
    if (validation) return validation;
  }
  return null;
}

function focusFromOutcome(outcome: unknown): string {
  const focusNodeId = outcome && typeof outcome === 'object'
    ? (outcome as { focus?: { nodeId?: unknown } }).focus?.nodeId
    : undefined;
  if (typeof focusNodeId !== 'string' || !focusNodeId) throw new Error('Mutation did not return a focus node id.');
  return focusNodeId;
}

function buildReadItem(index: ProjectionIndex, nodeId: string, params: ReturnType<typeof normalizeReadParams>): NodeReadItem {
  const node = requiredNode(index, nodeId);
  const includeOutline = params.format === 'outline' || params.format === 'both';
  const item: NodeReadItem = {
    nodeId,
    type: nodeKind(node),
    title: nodeTitle(index, node),
    description: node.description ?? null,
    tags: tagLabels(index, node),
    fields: fieldReads(index, node, params.includeDeleted),
    checked: checkedState(node),
    parent: parentRef(index, node),
    breadcrumb: breadcrumb(index, nodeId),
    children: buildChildrenPage(index, nodeId, params.depth, params.childOffset, params.childLimit, params.includeDeleted),
    backlinks: params.includeBacklinks ? backlinks(index, nodeId, params.includeDeleted) : undefined,
    revision: revisionOf(node),
    outline: includeOutline
      ? serializeOutline(index, nodeId, params.depth, params.childOffset, params.childLimit, params.includeDeleted)
      : undefined,
  };
  return params.format === 'outline' ? { ...item, fields: [], children: emptyChildrenPage(params.childOffset, params.childLimit) } : item;
}

function buildChildrenPage(
  index: ProjectionIndex,
  nodeId: string,
  depth: number,
  offset: number,
  limit: number,
  includeDeleted: boolean,
): ChildrenPage {
  const childIds = normalChildIds(index, nodeId, includeDeleted);
  const pageIds = depth > 0 ? childIds.slice(offset, offset + limit) : [];
  return {
    total: childIds.length,
    offset,
    limit,
    items: pageIds.map((childId) => childSummary(index, childId, depth - 1, limit, includeDeleted)),
  };
}

function childSummary(
  index: ProjectionIndex,
  nodeId: string,
  remainingDepth: number,
  childLimit: number,
  includeDeleted: boolean,
): NodeChildSummary {
  const node = requiredNode(index, nodeId);
  const children = normalChildIds(index, nodeId, includeDeleted);
  return {
    nodeId,
    title: nodeTitle(index, node),
    type: nodeKind(node),
    tags: tagLabels(index, node),
    checked: checkedState(node),
    hasChildren: children.length > 0,
    childCount: children.length,
    isReference: node.type === 'reference' || undefined,
    targetId: node.targetId,
    children: remainingDepth > 0 ? buildChildrenPage(index, nodeId, remainingDepth, 0, childLimit, includeDeleted) : undefined,
  };
}

function buildSearchItem(index: ProjectionIndex, nodeId: string, queryTerms: string[]): NodeSearchItem {
  const node = requiredNode(index, nodeId);
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

function resolveSearchSpecFromOutlineNode(index: ProjectionIndex, node: OutlineNode): ResolvedSearchSpec {
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

function parsedSearchFromOutlineNode(node: OutlineNode): ParsedSearch {
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

function searchNodeConfigFromSpec(spec: ResolvedSearchSpec): SearchNodeConfig {
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

function searchSpecFromSavedSearch(index: ProjectionIndex, node: NodeProjection): ResolvedSearchSpec {
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

function resolveSearch(index: ProjectionIndex, params: ReturnType<typeof normalizeSearchParams>): {
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
} | { error: string; code: string; nextStep: string } {
  if (params.query) {
    return {
      source: 'temporary',
      title: params.query,
      queryTerms: [params.query],
      tagIds: [],
      linkTargetIds: [],
      fieldConditions: [],
      unresolvedTagNames: [],
      unresolvedFields: [],
      warnings: [],
    };
  }

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
        nextStep: 'Use node_search with query first, or create/apply the tag before filtering by it.',
      };
    }
    if (resolvedFields.unresolvedFields.length) {
      return {
        code: 'unresolved_field',
        error: `Search references unknown fields: ${resolvedFields.unresolvedFields.join(', ')}`,
        nextStep: 'Use node_read on a tagged node to inspect available field names before filtering by field.',
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
  if (!node) return { code: 'node_not_found', error: `Search node not found: ${searchNodeId}`, nextStep: 'Use node_search with query or locate the saved search id first.' };
  if (isInTrash(index, searchNodeId)) return { code: 'node_in_trash', error: `Search node is in Trash: ${searchNodeId}`, nextStep: 'Use a non-deleted saved search node.' };
  if (node.type !== 'search') {
    return { code: 'invalid_search_node', error: `Node is not a search node: ${searchNodeId}`, nextStep: 'Use node_search with query for simple content search.' };
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

function runSearch(index: ProjectionIndex, search: {
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

function parseSearchOutline(outline: string): ParsedSearch | { code: string; error: string; nextStep: string } {
  const parsed = parseLinOutline(outline);
  if (!parsed.ok) {
    return {
      code: 'parse_error',
      error: `${parsed.error.message} Line ${parsed.error.line}, column ${parsed.error.column}.`,
      nextStep: 'Fix the search outline so every non-empty line uses "- " and 2-space indentation.',
    };
  }
  if (parsed.document.roots.length !== 1) {
    return {
      code: 'ambiguous_search',
      error: 'Search outline must contain exactly one root search node.',
      nextStep: 'Wrap all search conditions under one "- %%search%% Title" root.',
    };
  }
  return parsedSearchFromOutlineNode(parsed.document.roots[0]!);
}

function serializeOutline(
  index: ProjectionIndex,
  nodeId: string,
  depth: number,
  childOffset: number,
  childLimit: number,
  includeDeleted: boolean,
): string {
  return serializeOutlineNode(index, nodeId, depth, 0, childOffset, childLimit, includeDeleted).join('\n');
}

function serializeOutlineNode(
  index: ProjectionIndex,
  nodeId: string,
  depth: number,
  level: number,
  childOffset: number,
  childLimit: number,
  includeDeleted: boolean,
): string[] {
  const node = requiredNode(index, nodeId);
  const indent = '  '.repeat(level);
  const lines = [`${indent}- ${outlineNodeText(index, node)}`];
  for (const field of fieldReads(index, node, includeDeleted)) {
    const fieldIndent = '  '.repeat(level + 1);
    if (field.values.length === 0) {
      lines.push(`${fieldIndent}- ${field.name}::`);
    } else if (field.values.length === 1) {
      lines.push(`${fieldIndent}- ${field.name}:: ${field.values[0]!.text}`);
    } else {
      lines.push(`${fieldIndent}- ${field.name}::`);
      for (const value of field.values) lines.push(`${fieldIndent}  - ${value.text}`);
    }
  }
  if (node.type === 'search') {
    lines.push(...searchConditionOutlineLines(index, node, level + 1));
    return lines;
  }
  if (depth <= 0) return lines;
  const childIds = normalChildIds(index, nodeId, includeDeleted).slice(childOffset, childOffset + childLimit);
  for (const childId of childIds) {
    lines.push(...serializeOutlineNode(index, childId, depth - 1, level + 1, 0, childLimit, includeDeleted));
  }
  return lines;
}

function searchConditionOutlineLines(index: ProjectionIndex, node: NodeProjection, level: number): string[] {
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

function outlineNodeText(index: ProjectionIndex, node: NodeProjection): string {
  const parts: string[] = [];
  if (node.type === 'search') parts.push('%%search%%');
  if (node.viewMode) parts.push(`%%view:${node.viewMode}%%`);
  if (node.completedAt) parts.push('[x]');
  else if (node.showCheckbox) parts.push('[ ]');
  parts.push((referenceText(index, node) ?? node.content.text) || '(untitled)');
  if (node.description) parts.push(`- ${node.description}`);
  parts.push(...tagLabels(index, node));
  return parts.join(' ').trim();
}

function fieldReads(index: ProjectionIndex, node: NodeProjection, includeDeleted: boolean): NodeFieldRead[] {
  return node.children
    .map((childId) => index.nodes.get(childId))
    .filter((child): child is NodeProjection => child !== undefined && child.type === 'fieldEntry' && (includeDeleted || !isInTrash(index, child.id)))
    .map((fieldEntry) => {
      const fieldDef = fieldEntry.fieldDefId ? index.nodes.get(fieldEntry.fieldDefId) : undefined;
      const values = fieldEntry.children
        .map((valueId) => index.nodes.get(valueId))
        .filter((value): value is NodeProjection => value !== undefined && (includeDeleted || !isInTrash(index, value.id)))
        .map((value) => ({
          text: referenceText(index, value) ?? value.content.text,
          valueNodeId: value.id,
          targetId: value.targetId,
        }));
      const options = fieldDef?.children
        .map((optionId) => index.nodes.get(optionId)?.content.text.trim())
        .filter((value): value is string => Boolean(value));
      return {
        name: fieldDef?.content.text || fieldEntry.content.text || 'Field',
        type: fieldDef?.fieldType ?? fieldEntry.fieldType ?? 'plain',
        values,
        fieldEntryId: fieldEntry.id,
        options: options && options.length ? options : undefined,
      };
    });
}

function backlinks(index: ProjectionIndex, targetId: string, includeDeleted: boolean): NodeBacklink[] {
  const result: NodeBacklink[] = [];
  for (const node of index.projection.nodes) {
    if (!includeDeleted && isInTrash(index, node.id)) continue;
    if (node.type === 'reference' && node.targetId === targetId) {
      const parent = node.parentId ? index.nodes.get(node.parentId) : undefined;
      const source = parent && parent.type === 'fieldEntry' && parent.parentId ? index.nodes.get(parent.parentId) : parent;
      result.push({
        sourceNodeId: source?.id ?? node.id,
        sourceTitle: source ? nodeTitle(index, source) : nodeTitle(index, node),
        kind: parent?.type === 'fieldEntry' ? 'field' : 'tree',
        snippet: parent?.type === 'fieldEntry' ? fieldName(index, parent) : undefined,
      });
    }
    for (const inlineRef of node.content.inlineRefs) {
      if (inlineRef.targetNodeId === targetId) {
        result.push({
          sourceNodeId: node.id,
          sourceTitle: nodeTitle(index, node),
          kind: 'inline',
          snippet: snippetFor(node, [inlineRef.displayName ?? '']),
        });
      }
    }
  }
  return result;
}

function normalChildIds(index: ProjectionIndex, nodeId: string, includeDeleted: boolean): string[] {
  const node = requiredNode(index, nodeId);
  return node.children.filter((childId) => {
    const child = index.nodes.get(childId);
    return Boolean(child)
      && child!.type !== 'fieldEntry'
      && child!.type !== 'queryCondition'
      && (includeDeleted || !isInTrash(index, childId));
  });
}

function tagLabels(index: ProjectionIndex, node: NodeProjection): string[] {
  return node.tags.map((tagId) => tagLabel(index.nodes.get(tagId))).filter((tag): tag is string => Boolean(tag));
}

function tagLabel(node: NodeProjection | undefined): string | null {
  if (!node) return null;
  const name = node.content.text.trim();
  if (!name) return null;
  return /^[\w-]+$/.test(name) ? `#${name}` : `#[[${name}]]`;
}

function nodeTitle(index: ProjectionIndex, node: NodeProjection): string {
  if (node.type === 'reference' && node.targetId) {
    const target = index.nodes.get(node.targetId);
    if (target) return nodeTitle(index, target);
  }
  return node.content.text || '(untitled)';
}

function nodeKind(node: NodeProjection): string {
  return node.type ?? 'node';
}

function checkedState(node: NodeProjection): boolean | null | undefined {
  if (node.completedAt) return true;
  if (node.showCheckbox) return false;
  return undefined;
}

function parentRef(index: ProjectionIndex, node: NodeProjection): NodeRef | null {
  if (!node.parentId) return null;
  const parent = index.nodes.get(node.parentId);
  return parent ? { nodeId: parent.id, title: nodeTitle(index, parent) } : null;
}

function breadcrumb(index: ProjectionIndex, nodeId: string): NodeRef[] {
  const items: NodeRef[] = [];
  let current = index.nodes.get(nodeId);
  const visited = new Set<string>();
  while (current?.parentId && !visited.has(current.parentId)) {
    visited.add(current.parentId);
    const parent = index.nodes.get(current.parentId);
    if (!parent) break;
    items.push({ nodeId: parent.id, title: nodeTitle(index, parent) });
    current = parent;
  }
  return items.reverse();
}

function referenceText(index: ProjectionIndex, node: NodeProjection): string | null {
  if (node.type !== 'reference' || !node.targetId) return null;
  const target = index.nodes.get(node.targetId);
  const display = target ? nodeTitle(index, target) : node.targetId;
  return `[[${display}^${node.targetId}]]`;
}

function fieldName(index: ProjectionIndex, fieldEntry: NodeProjection): string {
  const fieldDef = fieldEntry.fieldDefId ? index.nodes.get(fieldEntry.fieldDefId) : undefined;
  return fieldDef?.content.text || fieldEntry.content.text || 'Field';
}

function snippetFor(node: NodeProjection, queryTerms: string[]): string {
  const haystack = [node.content.text, node.description ?? ''].join(' ').trim();
  if (!haystack) return '';
  const lower = haystack.toLowerCase();
  const term = queryTerms.map((value) => value.toLowerCase()).find((value) => value && lower.includes(value));
  if (!term) return haystack.slice(0, 160);
  const index = lower.indexOf(term);
  const start = Math.max(0, index - 60);
  const end = Math.min(haystack.length, index + term.length + 80);
  return `${start > 0 ? '...' : ''}${haystack.slice(start, end)}${end < haystack.length ? '...' : ''}`;
}

function scoreTerm(index: ProjectionIndex, node: NodeProjection, term: string): number {
  const q = term.trim().toLowerCase();
  if (!q) return 0;
  let score = 0;
  const text = node.content.text.toLowerCase();
  if (text === q) score += 100;
  else if (text.startsWith(q)) score += 60;
  else if (text.includes(q)) score += 30;
  if (node.description?.toLowerCase().includes(q)) score += 15;
  for (const tag of tagLabels(index, node)) {
    if (tag.toLowerCase().includes(q)) score += 15;
  }
  for (const field of fieldReads(index, node, false)) {
    if (field.name.toLowerCase().includes(q)) score += 8;
    for (const value of field.values) {
      if (value.text.toLowerCase().includes(q)) score += 10;
    }
  }
  return score;
}

function isSearchCandidate(index: ProjectionIndex, nodeId: string): boolean {
  const node = index.nodes.get(nodeId);
  if (!node) return false;
  return !isInTrash(index, nodeId)
    && !SYSTEM_IDS.has(nodeId)
    && (node.type === undefined || ['tagDef', 'fieldDef', 'search', 'codeBlock'].includes(node.type));
}

function isInTrash(index: ProjectionIndex, nodeId: string): boolean {
  if (nodeId === TRASH_ID) return true;
  let current = index.nodes.get(nodeId)?.parentId;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    if (current === TRASH_ID) return true;
    visited.add(current);
    current = index.nodes.get(current)?.parentId;
  }
  return false;
}

function resolveTagNames(index: ProjectionIndex, tagNames: string[]): { tagIds: string[]; unresolvedTagNames: string[] } {
  const tagIds: string[] = [];
  const unresolvedTagNames: string[] = [];
  for (const tagName of tagNames) {
    const normalized = tagName.toLowerCase();
    const tag = index.projection.nodes.find((node) => node.type === 'tagDef' && node.content.text.toLowerCase() === normalized);
    if (tag) tagIds.push(tag.id);
    else unresolvedTagNames.push(tagName);
  }
  return { tagIds: unique(tagIds), unresolvedTagNames: unique(unresolvedTagNames) };
}

function resolveFieldSearchConditions(
  index: ProjectionIndex,
  conditions: ParsedFieldSearchCondition[],
): { fieldConditions: ResolvedFieldSearchCondition[]; unresolvedFields: string[] } {
  const fieldConditions: ResolvedFieldSearchCondition[] = [];
  const unresolvedFields: string[] = [];
  for (const condition of conditions) {
    const field = findFieldDefByName(index, condition.fieldName);
    if (!field) {
      unresolvedFields.push(condition.fieldName);
      continue;
    }
    fieldConditions.push({
      fieldName: field.content.text.trim() || condition.fieldName,
      fieldDefId: field.id,
      text: condition.text?.trim() || undefined,
    });
  }
  return {
    fieldConditions: uniqueFieldConditions(fieldConditions),
    unresolvedFields: unique(unresolvedFields),
  };
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

function fieldDefinitionName(index: ProjectionIndex, fieldDefId: string): string {
  return index.nodes.get(fieldDefId)?.content.text.trim() || fieldDefId;
}

function findTagByName(index: ProjectionIndex, tagName: string): NodeProjection | undefined {
  const normalized = tagName.trim().toLowerCase();
  return index.projection.nodes.find((node) => node.type === 'tagDef' && node.content.text.trim().toLowerCase() === normalized);
}

function findFieldDefByName(index: ProjectionIndex, fieldName: string): NodeProjection | undefined {
  const normalized = fieldName.trim().toLowerCase();
  return index.projection.nodes.find((node) => node.type === 'fieldDef' && node.content.text.trim().toLowerCase() === normalized);
}

function pageHasMore(page: ChildrenPage): boolean {
  return page.offset + page.items.length < page.total;
}

function emptyChildrenPage(offset: number, limit: number): ChildrenPage {
  return { total: 0, offset, limit, items: [] };
}

function indexProjection(projection: DocumentProjection): ProjectionIndex {
  return {
    projection,
    nodes: new Map(projection.nodes.map((node) => [node.id, node])),
  };
}

function projectionFingerprint(projection: DocumentProjection): string {
  return JSON.stringify(projection.nodes.map((node) => ({
    id: node.id,
    parentId: node.parentId,
    children: node.children,
    text: node.content.text,
    tags: node.tags,
    type: node.type,
    targetId: node.targetId,
    updatedAt: node.updatedAt,
  })));
}

function changedNodeIds(before: DocumentProjection, after: DocumentProjection): string[] {
  const beforeById = new Map(before.nodes.map((node) => [node.id, node]));
  const afterById = new Map(after.nodes.map((node) => [node.id, node]));
  const ids = unique([...beforeById.keys(), ...afterById.keys()]);
  return ids.filter((id) => JSON.stringify(beforeById.get(id)) !== JSON.stringify(afterById.get(id)));
}

function requiredNode(index: ProjectionIndex, nodeId: string): NodeProjection {
  const node = index.nodes.get(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  return node;
}

function revisionOf(node: NodeProjection): string {
  return `${node.id}:${node.updatedAt}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function elapsed(started: number): number {
  return Date.now() - started;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
