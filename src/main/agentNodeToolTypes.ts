import type { DocumentCommand } from '../core/commands';
import type {
  CreateNodeTree,
  DocumentProjection,
  FieldConfigPatch,
  FocusHint,
  NodeProjection,
  SearchQueryExpr,
  TagConfigPatch,
} from '../core/types';
import type { TextSearchIndex } from '../core/textSearchIndex';
import type { NodeAccessSource } from '../core/nodeAccessRanking';
import type { TransientSearchOptions } from '../core/searchEngine';

export interface OutlinerToolHost {
  getProjection(): DocumentProjection;
  getTextSearchIndex?(): TextSearchIndex;
  getTransientSearchOptions?(): TransientSearchOptions;
  recordNodeAccess?(nodeIds: readonly string[], source: NodeAccessSource): void | Promise<void>;
  handle(
    command: DocumentCommand,
    args?: Record<string, unknown>,
    meta?: { origin?: 'user' | 'agent' | 'system'; command?: string; tool?: string; summary?: string },
  ): Promise<unknown>;
  transaction?<T>(
    meta: { origin?: 'user' | 'agent' | 'system'; command?: string; tool?: string; summary?: string },
    fn: () => Promise<T>,
  ): Promise<T>;
  createNodesFromTreeYielding?(
    parentId: string,
    nodes: CreateNodeTree[],
    meta: { origin?: 'user' | 'agent' | 'system'; command?: string; tool?: string; summary?: string },
    options?: { yieldEveryNodes?: number; commitEveryNodes?: number },
  ): Promise<{ focus?: FocusHint }>;
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
  definition?: NodeDefinitionRead;
  revision: string;
  outline?: string;
}

export interface NodeDefinitionRead {
  kind: 'field' | 'tag';
  config: ProjectedDefinitionConfig;
  editableWith: string;
}

export type ProjectedDefinitionConfig = ProjectedFieldDefinitionConfig | ProjectedTagDefinitionConfig;

export interface ProjectedFieldDefinitionConfig {
  fieldType: string;
  sourceSupertag?: string | null;
  nullable: boolean;
  hideField: string;
  autoInitialize: string[];
  autocollectOptions: boolean;
  minValue?: number | null;
  maxValue?: number | null;
}

export interface ProjectedTagDefinitionConfig {
  color?: string | null;
  extends?: string | null;
  childSupertag?: string | null;
  showCheckbox: boolean;
  doneStateEnabled: boolean;
  doneMapChecked: string[];
  doneMapUnchecked: string[];
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
  definition?: NodeDefinitionCreateParams;
  previewOnly?: boolean;
}

export interface NodeDefinitionCreateParams {
  kind: 'field' | 'tag';
  name: string;
  config?: FieldConfigPatch | TagConfigPatch;
}

export interface NodeDeleteParams {
  nodeId?: string;
  nodeIds?: string[];
  restore?: boolean;
  previewOnly?: boolean;
}

export interface NodeEditParams {
  operation?: NodeEditOperation;
  nodeId?: string;
  nodeIds?: string[];
  oldString?: string;
  newString?: string;
  expectedRevision?: string;
  move?: NodeEditMoveParams;
  mergeFromNodeIds?: string[];
  replaceWithReferenceTo?: string;
  definitionPatch?: FieldConfigPatch | TagConfigPatch;
  existingValues?: DefinitionExistingValuesStrategy;
  targetDefinitionId?: string;
  previewOnly?: boolean;
}

export type NodeEditOperation =
  | 'replace_outline'
  | 'move'
  | 'merge'
  | 'replace_with_reference'
  | 'configure_definition'
  | 'reuse_field_definition';

export type DefinitionExistingValuesStrategy = 'validate';

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
  matchedNodeIds?: string[];
  duplicatedFrom?: string;
  targetId?: string;
  definition?: NodeDefinitionMutation;
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
  action: NodeEditOperation;
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
  definition?: NodeDefinitionMutation;
  reusedFieldDefinition?: {
    fieldEntryId: string;
    targetDefinitionId: string;
  };
  merge?: {
    targetNodeId: string;
    sourceNodeIds: string[];
    movedChildren: number;
    mergedFields: NodeMergeFieldPreview[];
    appliedTags: number;
    redirectedReferences: number;
  };
}

export interface NodeDefinitionMutation {
  kind: 'field' | 'tag';
  nodeId: string;
  beforeConfig?: ProjectedDefinitionConfig;
  afterConfig?: ProjectedDefinitionConfig;
  patch?: FieldConfigPatch | TagConfigPatch;
  validation?: DefinitionValueValidationReport;
}

export interface DefinitionValueValidationReport {
  strategy: DefinitionExistingValuesStrategy;
  checkedFieldEntryIds?: string[];
  incompatibleValues?: DefinitionIncompatibleValue[];
}

export interface DefinitionIncompatibleValue {
  fieldEntryId: string;
  valueNodeId?: string;
  value: string;
  reason: string;
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

export interface NodeVisibleReadResult {
  outline?: string;
  definitions?: NodeDefinitionRead[];
  references?: NodeVisibleReference[];
  page?: NodeVisiblePage;
}

export interface NodeVisibleSearchResult {
  outline?: string;
  references?: NodeVisibleReference[];
  page: NodeVisiblePage;
}

export interface NodeVisibleMutationResult {
  changes?: NodeVisibleChanges;
  outline?: string;
  revisions?: Record<string, string>;
}

export interface NodeVisibleCountResult {
  total: number;
  page: NodeVisiblePage;
}

export interface NodeVisibleReference {
  node_id: string;
  title: string;
  display_ref: string;
  edit_handle: string;
  type: string;
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
  | (NodeEditParams & { action: 'replace_outline'; nodeId: string; oldString: string; newString: string })
  | (NodeEditParams & { action: 'move'; move: NodeEditMoveParams; nodeIds: string[] })
  | (NodeEditParams & { action: 'merge'; nodeId: string; mergeFromNodeIds: string[] })
  | (NodeEditParams & { action: 'replace_with_reference'; nodeId: string; replaceWithReferenceTo: string })
  | (NodeEditParams & { action: 'configure_definition'; nodeId: string; definitionPatch: FieldConfigPatch | TagConfigPatch; existingValues: DefinitionExistingValuesStrategy })
  | (NodeEditParams & { action: 'reuse_field_definition'; nodeId: string; targetDefinitionId: string })
  | { error: string };

export interface NodeToolIssue {
  code: string;
  error: string;
  instructions: string;
}
