import type { AgentRenderProjection } from './agentRenderProjection';

export type NodeId = string;

export const WORKSPACE_ID = 'workspace';
export const LIBRARY_ID = 'library';
export const DAILY_NOTES_ID = 'daily-notes';
export const PROJECTS_ID = 'projects';
export const AREAS_ID = 'areas';
export const RESOURCES_ID = 'resources';
export const SCHEMA_ID = 'schema';
export const SEARCHES_ID = 'searches';
export const RECENTS_ID = 'recents';
export const TRASH_ID = 'trash';
export const SETTINGS_ID = 'settings';
export const TAG_DAY_ID = 'tag:day';
export const TAG_WEEK_ID = 'tag:week';
export const TAG_YEAR_ID = 'tag:year';

// System option subtrees under SCHEMA_ID. Each holds the enum domain for a
// config knob; selecting an enum value = referencing one of these nodes, so
// an invalid enum value is unrepresentable. See docs/plans/config-as-nodes.md.
export const SCHEMA_FIELD_TYPES_ID = 'schema:field-types';
export const SCHEMA_HIDE_MODES_ID = 'schema:hide-modes';
export const SCHEMA_CARDINALITIES_ID = 'schema:cardinalities';
export const SCHEMA_AUTO_INIT_ID = 'schema:auto-init';

/** Deterministic id for a system option node, e.g. `schema:field-types/number`. */
export function systemOptionNodeId(subtreeId: string, value: string): NodeId {
  return `${subtreeId}/${value}`;
}

/**
 * Deterministic id for a definition's `defConfig` row, e.g. `tag123::cfg:color`.
 * Stable so reconcile is idempotent and `setConfigValue` can address the row
 * without scanning children.
 */
export function defConfigNodeId(defId: NodeId, configKey: string): NodeId {
  return `${defId}::cfg:${configKey}`;
}

export type NodeType =
  | 'fieldEntry'
  | 'reference'
  | 'codeBlock'
  | 'image'
  | 'embed'
  | 'tagDef'
  | 'fieldDef'
  | 'defConfig'
  | 'systemOption'
  | 'viewDef'
  | 'sortRule'
  | 'filterRule'
  | 'displayField'
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

export type FieldCardinality = 'single' | 'list';

export type AutoInitStrategy =
  | 'current_date'
  | 'ancestor_day_node'
  | 'ancestor_field_value'
  | 'ancestor_supertag_ref';

export type HideFieldMode =
  | 'never'
  | 'empty'
  | 'not_empty'
  | 'value_is_default'
  | 'always';

// ─── Config-as-nodes (see docs/plans/config-as-nodes.md) ───
// A definition's configuration is stored as `defConfig` child nodes whose
// `configKey` identifies the knob; the value is held as the defConfig node's
// own child node(s) — the same mechanism field values use (U1). Reads go
// through typed accessors over a config index, never the flat fields below;
// those flat config fields are removed once every reader is cut over
// (compiler-driven, no derive-back bridge — pre-launch, no data to preserve).
export type TagConfigKey =
  | 'color'
  | 'extends'
  | 'childSupertag'
  | 'showCheckbox'
  | 'doneStateEnabled'
  // Done-state mapping: option nodes whose selection mirrors the checked /
  // unchecked state. Field grouping is derived from each option's owning field.
  | 'doneMapChecked'
  | 'doneMapUnchecked';

export type FieldConfigKey =
  | 'fieldType'
  | 'cardinality'
  | 'sourceSupertag'
  | 'nullable'
  | 'hideField'
  | 'autoInitialize'
  | 'autocollectOptions'
  | 'minValue'
  | 'maxValue';

export type DefConfigKey = TagConfigKey | FieldConfigKey;

// How a config value is stored as child node(s) of its `defConfig` node:
//   ref      → one child `reference` (refRole 'config') targeting a tagDef
//   refList  → zero or more child `reference`s (refRole 'config') to nodes
//   enum     → one child `reference` (refRole 'enum') targeting a system option
//   enumList → zero or more child `reference`s (refRole 'enum') to options
//   number   → one child value node; content text = codec-encoded number
//   bool     → one child value node; content text = codec-encoded boolean
//   color    → one child value node; content text = codec-encoded #RRGGBB
// Registry-level domain of a config knob. Drives which control renders and how
// the value is stored as a child node: ref/enum → a child reference (with a
// config refRole so it stays out of the backlink graph); number/color/bool →
// a child value node (same mechanism field values already use). See
// docs/plans/config-as-nodes.md.
export type ConfigValueDomain = 'ref' | 'refList' | 'enum' | 'enumList' | 'number' | 'bool' | 'color';

// The role a `reference` node plays. Reads/backlinks/search use this to decide
// whether a reference is a real edge (link/fieldValue) or an internal pointer
// (config/enum/system/searchResult) that must stay out of the backlink graph.
// See docs/plans/config-as-nodes.md (transitional rule 4) — explicit role, not
// parent inference. Absent role is treated as 'link' (legacy user reference).
export type RefRole =
  | 'link'
  | 'fieldValue'
  | 'config'
  | 'enum'
  | 'searchResult'
  | 'autoInit';

export interface TagConfigPatch {
  color?: string | null;
  extends?: NodeId | null;
  childSupertag?: NodeId | null;
  showCheckbox?: boolean;
  doneStateEnabled?: boolean;
}

export interface FieldConfigPatch {
  fieldType?: FieldType;
  cardinality?: FieldCardinality | null;
  sourceSupertag?: NodeId | null;
  nullable?: boolean | null;
  hideField?: HideFieldMode | null;
  autoInitialize?: string | null;
  autocollectOptions?: boolean;
  minValue?: number | null;
  maxValue?: number | null;
}

export type SortDirection = 'asc' | 'desc';
export type ViewMode = 'list' | 'table' | 'cards' | 'calendar';
export type ViewSystemField =
  | 'sys:name'
  | 'sys:createdAt'
  | 'sys:updatedAt'
  | 'sys:done'
  | 'sys:doneAt'
  | 'sys:tags'
  | 'sys:refCount';
export type ViewFieldRef = ViewSystemField | NodeId;
export type FilterOperator =
  | 'is'
  | 'is_not'
  | 'contains'
  | 'not_contains'
  | 'is_empty'
  | 'is_not_empty'
  | 'gt'
  | 'lt'
  | 'before'
  | 'after';
export type FilterValueLogic = 'all' | 'any';
export type DisplayPlacement = 'title' | 'body' | 'footer' | 'hidden';
export type IconKind = 'emoji' | 'image' | 'generated';
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

export type InlineRefCursorBias = 'before' | 'after';

export type FocusSurface =
  | 'row'
  | 'panel-title'
  | 'description'
  | 'field-name'
  | 'field-value'
  | 'trailing';

export type FocusPlacement =
  | { kind: 'start' }
  | { kind: 'end' }
  | { kind: 'all' }
  | { kind: 'preserve' }
  | { kind: 'text-offset'; offset: number; inlineRefBias?: InlineRefCursorBias };

export interface RichText {
  text: string;
  marks: TextMark[];
  inlineRefs: InlineRef[];
}

export type RichTextPatchOp =
  | {
    type: 'replace';
    from: number;
    to: number;
    content: RichText;
    deletedInlineRefs?: InlineRef[];
  }
  | {
    type: 'replace_all';
    content: RichText;
  }
  | {
    type: 'add_mark';
    from: number;
    to: number;
    markType: TextMarkKind;
    attrs?: Record<string, string>;
  }
  | {
    type: 'remove_mark';
    from: number;
    to: number;
    markType: TextMarkKind;
  };

export interface RichTextPatch {
  ops: RichTextPatchOp[];
}

export interface SearchQueryOperand {
  text?: string;
  targetId?: NodeId;
}

export interface SearchQueryRule {
  kind: 'rule';
  op: QueryOp;
  text?: string;
  fieldDefId?: NodeId;
  tagDefId?: NodeId;
  targetId?: NodeId;
  operands?: SearchQueryOperand[];
}

export interface SearchQueryGroup {
  kind: 'group';
  logic: QueryLogic;
  children: SearchQueryExpr[];
}

export type SearchQueryExpr = SearchQueryGroup | SearchQueryRule;

export interface SearchNodeConfig {
  title: string;
  query: SearchQueryExpr;
}

export type QueryLogic = 'AND' | 'OR' | 'NOT';

export const QUERY_OPS = [
  'HAS_TAG',
  'TODO',
  'DONE',
  'NOT_DONE',
  'FIELD_IS',
  'FIELD_IS_NOT',
  'IS_EMPTY',
  'IS_NOT_EMPTY',
  'FIELD_CONTAINS',
  'LT',
  'GT',
  'CREATED_LAST_DAYS',
  'EDITED_LAST_DAYS',
  'DONE_LAST_DAYS',
  'HAS_FIELD',
  'LINKS_TO',
  'STRING_MATCH',
  'REGEXP_MATCH',
  'CHILD_OF',
  'IS_TYPE',
  'FOR_DATE',
  'FOR_RELATIVE_DATE',
  'DATE_OVERLAPS',
  'DESCENDANT_OF',
  'DESCENDANT_OF_WITH_REFS',
  'PARENTS_DESCENDANTS',
  'GRANDPARENTS_DESCENDANTS',
  'PARENTS_DESCENDANTS_WITH_REFS',
  'GRANDPARENTS_DESCENDANTS_WITH_REFS',
  'SIBLING_NAMED',
  'IN_LIBRARY',
  'ON_DAY_NODE',
  'EDITED_BY',
  'OWNED_BY',
  'OVERDUE',
  'HAS_MEDIA',
  'HAS_AUDIO',
  'HAS_VIDEO',
  'HAS_IMAGE',
  'FIELD_IS_SET',
  'FIELD_IS_NOT_SET',
  'FIELD_IS_DEFINED',
  'FIELD_IS_NOT_DEFINED',
] as const;

export type QueryOp = typeof QUERY_OPS[number];

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
  icon?: string;
  iconKind?: IconKind;
  bannerAssetId?: string;
  bannerPositionX?: number;
  bannerPositionY?: number;
  bannerAlt?: string;
  templateId?: NodeId;
  fieldDefId?: NodeId;
  /** For `defConfig` nodes: which config knob this row represents. */
  configKey?: DefConfigKey;
  /** For `reference` nodes: the role this reference plays (backlink allowlist). */
  refRole?: RefRole;
  autoCollected: boolean;
  targetId?: NodeId;
  viewMode?: ViewMode;
  toolbarVisible?: boolean;
  groupField?: ViewFieldRef;
  sortField?: ViewFieldRef;
  sortDirection?: SortDirection;
  filterField?: ViewFieldRef;
  filterOperator?: FilterOperator;
  filterValueLogic?: FilterValueLogic;
  filterValues?: string[];
  displayField?: ViewFieldRef;
  displayVisible?: boolean;
  displayWidth?: number;
  displayOrder?: number;
  displayLabel?: string;
  displayPlacement?: DisplayPlacement;
  queryLogic?: QueryLogic;
  queryOp?: QueryOp;
  queryTagDefId?: NodeId;
  queryFieldDefId?: NodeId;
  codeLanguage?: string;
  assetId?: string;
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

export const LIN_DOCUMENT_EVENT_CHANNEL = 'lin-document-event';

export interface DocumentProjection {
  workspaceId: NodeId;
  rootId: NodeId;
  libraryId: NodeId;
  dailyNotesId: NodeId;
  schemaId: NodeId;
  searchesId: NodeId;
  recentsId: NodeId;
  trashId: NodeId;
  settingsId: NodeId;
  todayId: NodeId;
  nodes: NodeProjection[];
}

export interface DocumentProjectionChangedEvent {
  type: 'projection_changed';
  origin: 'agent' | 'user' | 'system';
  projection: DocumentProjection;
  timestamp: number;
}

/**
 * Metadata sidecar for a stored asset. The bytes live on disk under the user
 * data directory; the document only ever references the stable `id`.
 */
export interface AssetMetadata {
  id: string;
  mimeType: string;
  byteSize: number;
  originalFilename?: string;
  createdAt: number;
  imageWidth?: number;
  imageHeight?: number;
}

/**
 * Input to the asset ingest command. Either a path the main process reads
 * (drag-from-Finder, file picker) or raw bytes carried over IPC (clipboard
 * paste). All ingest paths converge here.
 */
export type AssetIngestInput =
  | { kind: 'path'; path: string }
  | { kind: 'buffer'; data: Uint8Array; mimeType?: string; originalFilename?: string };

export interface FocusHint {
  nodeId: NodeId;
  parentId?: NodeId | null;
  surface?: FocusSurface;
  placement?: FocusPlacement;
  selectAll: boolean;
}

export interface SplitNodeOptions {
  targetParentId?: NodeId | null;
  targetIndex?: number | null;
  focusPlacement?: FocusPlacement;
}

export interface CommandOutcome {
  projection: DocumentProjection;
  focus?: FocusHint;
}

export interface CreateNodeTree {
  content: RichText;
  children: CreateNodeTree[];
  /** Optional node type for the materialized node. Paste only emits `codeBlock`. */
  type?: NodeType;
  /** Language hint for `codeBlock` trees; ignored for other types. */
  codeLanguage?: string;
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
  renderProjection: AgentRenderProjection;
}

export interface AgentSessionMeta {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export type AgentReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type AgentPermissionMode = 'trusted' | 'restricted';
export type AgentCacheRetention = 'none' | 'short' | 'long';

export interface AgentRuntimeSettings {
  permissionMode: AgentPermissionMode;
  automaticSkillsEnabled: boolean;
  slashSkillsEnabled: boolean;
  compactEnabled: boolean;
  additionalSkillDirectories: string[];
  additionalAgentDirectories: string[];
  providerTimeoutMs: number | null;
  providerMaxRetries: number | null;
  providerMaxRetryDelayMs: number | null;
  providerCacheRetention: AgentCacheRetention;
}

export interface AgentRuntimeSettingsInput {
  permissionMode?: AgentPermissionMode;
  automaticSkillsEnabled?: boolean;
  slashSkillsEnabled?: boolean;
  compactEnabled?: boolean;
  additionalSkillDirectories?: string[];
  additionalAgentDirectories?: string[];
  providerTimeoutMs?: number | null;
  providerMaxRetries?: number | null;
  providerMaxRetryDelayMs?: number | null;
  providerCacheRetention?: AgentCacheRetention;
}

export type AgentSlashCommandKind = 'runtime' | 'skill';

export interface AgentSlashCommandView {
  id: string;
  kind: AgentSlashCommandKind;
  label: string;
  description?: string;
  insertText: string;
}

export interface AgentProviderConfigInput {
  providerId: string;
  modelId: string;
  reasoningLevel?: AgentReasoningLevel;
  baseUrl?: string | null;
  enabled?: boolean;
}

export interface AgentProviderConfigView {
  providerId: string;
  modelId: string;
  reasoningLevel: AgentReasoningLevel;
  baseUrl?: string;
  enabled: boolean;
  hasApiKey: boolean;
  hasEnvApiKey?: boolean;
}

export interface AgentModelOption {
  id: string;
  name: string;
  reasoning: boolean;
  supportedThinkingLevels: AgentReasoningLevel[];
  contextWindow: number;
  maxTokens: number;
}

export interface AgentProviderOption {
  providerId: string;
  hasEnvApiKey: boolean;
  envKeyNames: string[];
  defaultBaseUrl?: string;
  models: AgentModelOption[];
}

export interface AgentProviderSettingsView {
  activeProviderId?: string;
  providers: AgentProviderConfigView[];
  availableProviders: AgentProviderOption[];
  agent: AgentRuntimeSettings;
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

export function replaceAllRichTextPatch(content: RichText): RichTextPatch {
  return { ops: [{ type: 'replace_all', content }] };
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
    autoCollected: false,
  };
}
