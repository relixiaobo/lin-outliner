export type NodeId = string;

export const WORKSPACE_ID = 'workspace';
export const DAILY_NOTES_ID = 'daily-notes';
export const SCHEMA_ID = 'schema';
export const SEARCHES_ID = 'searches';
export const TRASH_ID = 'trash';
export const SETTINGS_ID = 'settings';
export const TAG_DAY_ID = 'tag:day';
export const TAG_WEEK_ID = 'tag:week';
export const TAG_YEAR_ID = 'tag:year';

export type NodeType =
  | 'fieldEntry'
  | 'reference'
  | 'codeBlock'
  | 'image'
  | 'embed'
  | 'tagDef'
  | 'fieldDef'
  | 'viewDef'
  | 'sortRule'
  | 'search'
  | 'queryCondition';

export type FieldType =
  | 'plain'
  | 'options'
  | 'options_from_supertag'
  | 'date'
  | 'number'
  | 'password'
  | 'formula'
  | 'user'
  | 'url'
  | 'email'
  | 'checkbox'
  | 'boolean'
  | 'color';

export type HideFieldMode =
  | 'never'
  | 'empty'
  | 'not_empty'
  | 'value_is_default'
  | 'always';

export interface TagConfigPatch {
  color?: string | null;
  extends?: NodeId | null;
  childSupertag?: NodeId | null;
  showCheckbox?: boolean;
  doneStateEnabled?: boolean;
}

export interface FieldConfigPatch {
  fieldType?: FieldType;
  sourceSupertag?: NodeId | null;
  nullable?: boolean | null;
  hideField?: HideFieldMode | null;
  autoInitialize?: string | null;
  autocollectOptions?: boolean;
  minValue?: number | null;
  maxValue?: number | null;
}

export type SortDirection = 'asc' | 'desc';
export type FilterOp = 'all' | 'any';
export type TextMarkKind = 'bold' | 'italic' | 'strike' | 'code' | 'highlight' | 'headingMark' | 'link';

export interface TextMark {
  start: number;
  end: number;
  type: TextMarkKind;
  attrs?: Record<string, string>;
}

export interface InlineRef {
  offset: number;
  targetNodeId: NodeId;
  displayName?: string;
}

export interface RichText {
  text: string;
  marks: TextMark[];
  inlineRefs: InlineRef[];
}

export type QueryLogic = 'AND' | 'OR' | 'NOT';

export type QueryOp =
  | 'HAS_TAG'
  | 'TODO'
  | 'DONE'
  | 'NOT_DONE'
  | 'FIELD_IS'
  | 'FIELD_IS_NOT'
  | 'IS_EMPTY'
  | 'IS_NOT_EMPTY'
  | 'FIELD_CONTAINS'
  | 'LT'
  | 'GT'
  | 'CREATED_LAST_DAYS'
  | 'EDITED_LAST_DAYS'
  | 'DONE_LAST_DAYS'
  | 'HAS_FIELD'
  | 'LINKS_TO'
  | 'STRING_MATCH'
  | 'REGEXP_MATCH'
  | 'CHILD_OF'
  | 'IS_TYPE'
  | 'FOR_DATE'
  | 'FOR_RELATIVE_DATE'
  | 'PARENTS_DESCENDANTS'
  | 'IN_LIBRARY'
  | 'ON_DAY_NODE'
  | 'EDITED_BY'
  | 'OWNED_BY'
  | 'OVERDUE'
  | 'HAS_MEDIA';

export interface Node {
  id: NodeId;
  type?: NodeType;
  parentId?: NodeId;
  children: NodeId[];
  content: RichText;
  description?: string;
  tags: NodeId[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  locked: boolean;
  color?: string;
  showCheckbox: boolean;
  templateId?: NodeId;
  childSupertag?: NodeId;
  extends?: NodeId;
  doneStateEnabled: boolean;
  fieldDefId?: NodeId;
  fieldType?: FieldType;
  cardinality?: string;
  nullable?: boolean;
  hideField?: string;
  autoInitialize?: string;
  autocollectOptions: boolean;
  autoCollected: boolean;
  minValue?: number;
  maxValue?: number;
  sourceSupertag?: NodeId;
  targetId?: NodeId;
  viewMode?: string;
  toolbarVisible: boolean;
  sortField?: string;
  sortDirection?: SortDirection;
  groupField?: string;
  filterField?: string;
  filterOp?: FilterOp;
  filterValues: string[];
  queryLogic?: QueryLogic;
  queryOp?: QueryOp;
  queryTagDefId?: NodeId;
  queryFieldDefId?: NodeId;
  lastRefreshedAt?: number;
  codeLanguage?: string;
  mediaUrl?: string;
  mediaAlt?: string;
  imageWidth?: number;
  imageHeight?: number;
  embedType?: string;
  embedId?: string;
  sourceUrl?: string;
  aiSummary?: string;
  trashedFromParentId?: NodeId;
  trashedFromIndex?: number;
}

export interface DocumentState {
  schemaVersion: number;
  workspaceId: NodeId;
  rootId: NodeId;
  nodes: Record<NodeId, Node>;
}

export type NodeProjection = Omit<Node, 'trashedFromParentId' | 'trashedFromIndex'>;

export interface DocumentProjection {
  workspaceId: NodeId;
  rootId: NodeId;
  dailyNotesId: NodeId;
  schemaId: NodeId;
  searchesId: NodeId;
  trashId: NodeId;
  settingsId: NodeId;
  todayId: NodeId;
  nodes: NodeProjection[];
}

export interface FocusHint {
  nodeId: NodeId;
  selectAll: boolean;
}

export interface CommandOutcome {
  projection: DocumentProjection;
  focus?: FocusHint;
}

export interface CreateNodeTree {
  content: RichText;
  children: CreateNodeTree[];
}

export interface Backlink {
  sourceId: NodeId;
  referenceId: NodeId;
  kind: string;
}

export interface SearchHit {
  nodeId: NodeId;
  score: number;
}

export interface AgentSession {
  sessionId: string;
}

export interface AgentProviderConfigInput {
  providerId: string;
  modelId: string;
  baseUrl?: string | null;
  enabled?: boolean;
}

export interface AgentProviderConfigView {
  providerId: string;
  modelId: string;
  baseUrl?: string;
  enabled: boolean;
  hasApiKey: boolean;
}

export interface AgentProviderSettingsView {
  activeProviderId?: string;
  providers: AgentProviderConfigView[];
}

export interface AgentProviderSecretStatus {
  providerId: string;
  hasApiKey: boolean;
}

export const EMPTY_RICH_TEXT: RichText = {
  text: '',
  marks: [],
  inlineRefs: [],
};

export function plainText(text: string): RichText {
  return { text, marks: [], inlineRefs: [] };
}

export function createNodeRecord(
  id: NodeId,
  type: NodeType | undefined,
  parentId: NodeId | undefined,
  now: number,
): Node {
  return {
    id,
    type,
    parentId,
    children: [],
    content: plainText(''),
    tags: [],
    createdAt: now,
    updatedAt: now,
    locked: false,
    showCheckbox: false,
    doneStateEnabled: false,
    autocollectOptions: false,
    autoCollected: false,
    toolbarVisible: false,
    filterValues: [],
  };
}

