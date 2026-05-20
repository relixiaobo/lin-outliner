import type { DocumentCommand } from '../core/commands';
import type { DocumentProjection, NodeProjection, SearchQueryExpr } from '../core/types';
import type { ToolEnvelope } from './agentToolEnvelope';

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

export interface NodeReadParams {
  nodeId?: string;
  nodeIds?: string[];
  depth?: number;
  childOffset?: number;
  childLimit?: number;
  includeDeleted?: boolean;
  includeBacklinks?: boolean;
}

export type NormalizedReadParams = Required<Pick<NodeReadParams, 'depth' | 'childOffset' | 'childLimit' | 'includeDeleted' | 'includeBacklinks'>>
  & Pick<NodeReadParams, 'nodeId' | 'nodeIds'>
  & { error?: string };

export interface NodeReadData {
  items: NodeReadItem[];
}

export interface NodeReadItem {
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

export interface NodeFieldRead {
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

export interface ChildrenPage {
  total: number;
  offset: number;
  limit: number;
  items: NodeChildSummary[];
}

export interface NodeChildSummary {
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

export interface NodeBacklink {
  sourceNodeId: string;
  sourceTitle: string;
  kind: 'tree' | 'inline' | 'field';
  snippet?: string;
}

export interface NodeRef {
  nodeId: string;
  title: string;
}

export interface NodeSearchParams {
  outline?: string;
  searchNodeId?: string;
  limit?: number;
  offset?: number;
  count?: boolean;
}

export type NormalizedSearchParams = Required<Pick<NodeSearchParams, 'limit' | 'offset' | 'count'>>
  & Pick<NodeSearchParams, 'outline' | 'searchNodeId'>
  & { error?: string };

export interface NodeSearchData {
  source: 'temporary' | 'saved';
  title?: string;
  view?: string;
  searchNodeId?: string;
  outline?: string;
  total: number;
  offset: number;
  limit: number;
  items?: NodeSearchItem[];
}

export interface NodeSearchItem {
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

export interface NodeCreateParams {
  parentId?: string;
  afterId?: string | null;
  outline?: string;
  targetId?: string;
  duplicateId?: string;
  previewOnly?: boolean;
}

export interface NodeDeleteParams {
  nodeId?: string;
  nodeIds?: string[];
  restore?: boolean;
  previewOnly?: boolean;
}

export interface NodeEditParams {
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

export interface NodeEditMoveParams {
  parentId?: string;
  afterId?: string | null;
  structuralAction?: 'indent' | 'outdent' | 'move_up' | 'move_down';
}

export interface OperationHistoryParams {
  action?: 'list' | 'undo' | 'redo';
  steps?: number;
  operationId?: string;
  origin?: 'all' | 'agent' | 'user';
  limit?: number;
  offset?: number;
}

export interface NodeCreateData {
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

export interface NodeDeleteData {
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

export interface NodeEditData {
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

export interface NodeMergeFieldPreview {
  fieldName: string;
  sourceFieldEntryId: string;
  targetFieldEntryId: string;
  movedValueIds: string[];
  mode: 'merged_values' | 'moved_entry';
}

export interface OperationHistoryData {
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

export interface OperationHistoryItem {
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

export interface NodeDeletePreview {
  nodeId: string;
  title: string;
  type: string;
  parent?: NodeRef | null;
  childCount: number;
  subtreeNodeCount: number;
}

export interface NodeDeleteSkip {
  nodeId: string;
  reason: string;
  coveredBy?: string;
}

export type NodeVisibleResult =
  | NodeVisibleReadResult
  | NodeVisibleSearchResult
  | NodeVisibleMutationResult
  | NodeVisibleCountResult;

export interface NodeVisibleEnvelope {
  ok: boolean;
  tool: string;
  status: ToolEnvelope['status'];
  instructions?: string;
  data?: NodeVisibleResult;
  error?: ToolEnvelope['error'];
  warnings?: string[];
}

export interface NodeVisibleReadResult {
  kind: 'read';
  outline?: string;
  page?: NodeVisiblePage;
}

export interface NodeVisibleSearchResult {
  kind: 'search';
  outline?: string;
  page: NodeVisiblePage;
}

export interface NodeVisibleMutationResult {
  kind: 'mutation';
  action: 'create' | 'edit' | 'delete';
  status: 'applied' | 'preview' | 'unchanged';
  changes: NodeVisibleChanges;
  outline?: string;
}

export interface NodeVisibleCountResult {
  kind: 'count';
  total: number;
  page: NodeVisiblePage;
}

export interface NodeVisibleChanges {
  created?: string[];
  updated?: string[];
  moved?: string[];
  trashed?: string[];
  restored?: string[];
}

export interface NodeVisiblePage {
  total: number;
  offset: number;
  limit: number;
  next_offset?: number;
}

export interface ProjectionIndex {
  projection: DocumentProjection;
  nodes: Map<string, NodeProjection>;
}

export interface ParsedSearch {
  title?: string;
  view?: string;
  query: SearchQueryExpr;
}

export interface ResolvedSearchSpec {
  title: string;
  view?: string;
  query: SearchQueryExpr;
  warnings: string[];
}

export type NormalizedEditParams =
  | (NodeEditParams & { action: 'outline_edit'; nodeId: string; oldString: string; newString: string })
  | (NodeEditParams & { action: 'move'; move: NodeEditMoveParams; nodeIds: string[] })
  | (NodeEditParams & { action: 'merge'; nodeId: string; mergeFromNodeIds: string[] })
  | (NodeEditParams & { action: 'replace_with_reference'; nodeId: string; replaceWithReferenceTo: string })
  | { error: string };

export interface NodeToolIssue {
  code: string;
  error: string;
  instructions: string;
}
