import type { AgentRenderProjection } from './agentRenderProjection';
import type { AgentUserQuestionPendingView } from './agentTypes';
import type { AgentPrincipal } from './agentEventLog';
import type { CaptureNodeMetadata } from './launcher/sources';

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
export const TAG_DAY_ID = 'tag:day';
export const TAG_WEEK_ID = 'tag:week';
export const TAG_YEAR_ID = 'tag:year';

// System option subtrees under SCHEMA_ID. Each holds the enum domain for a
// config knob; selecting an enum value = referencing one of these nodes, so
// an invalid enum value is unrepresentable. See docs/plans/archive/config-as-nodes.md.
export const SCHEMA_FIELD_TYPES_ID = 'schema:field-types';
export const SCHEMA_HIDE_MODES_ID = 'schema:hide-modes';
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
  | 'attachment'
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
  | 'url'
  | 'email'
  | 'checkbox';

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

// ─── Config-as-nodes (see docs/plans/archive/config-as-nodes.md) ───
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
//   color    → one child value node; content text = codec-encoded palette token
// Registry-level domain of a config knob. Drives which control renders and how
// the value is stored as a child node: ref/enum → a child reference (with a
// config refRole so it stays out of the backlink graph); number/color/bool →
// a child value node (same mechanism field values already use). See
// docs/plans/archive/config-as-nodes.md.
export type ConfigValueDomain = 'ref' | 'refList' | 'enum' | 'enumList' | 'number' | 'bool' | 'color';

// The role a `reference` node plays. Reads/backlinks/search use this to decide
// whether a reference is a real edge (link/fieldValue) or an internal pointer
// (config/enum/system/searchResult) that must stay out of the backlink graph.
// See docs/plans/archive/config-as-nodes.md (transitional rule 4) — explicit role, not
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
  doneMapChecked?: NodeId[];
  doneMapUnchecked?: NodeId[];
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

export type ReferenceTarget =
  | { kind: 'node'; nodeId: NodeId }
  | { kind: 'local-file'; path: string; entryKind: 'file' | 'directory' }
  | {
      kind: 'chat-source';
      stream: 'conversation' | 'run';
      streamId: string;
      range: {
        fromSeqExclusive: number;
        throughSeq: number;
        throughEventId?: string | null;
        fromCreatedAtInclusive?: number;
        throughCreatedAtExclusive?: number;
      };
    };

export interface InlineRef {
  offset: number;
  target: ReferenceTarget;
  displayName?: string;
  mimeType?: string;
  sizeBytes?: number;
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

// ─── Node: discriminated union over `type` (A-full, see config-as-nodes.md) ───
//
// Stage 8 (additive, structural no-op): every node type gets a variant that
// extends `NodeBase` and is distinguished by its `type` discriminant. The
// field set is still shared on `NodeBase` for now, so existing field access
// and construction keep compiling unchanged — the only new thing is that
// `node.type` narrows to a variant. Stage 9 narrows access sites by
// `node.type`; Stage 10 moves each field onto the variant that owns it and the
// god-record is gone. Until then the variants are intentionally identical
// apart from their discriminant.
export interface NodeBase {
  id: NodeId;
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
  autoCollected: boolean;
  aiSummary?: string;
  /**
   * Descriptive metadata only: field keys on this node that are intended to be
   * user-only-writable. Enforcement must live at the owning command or gateway,
   * not in this mutable array.
   */
  protectedFields?: string[];
  /**
   * Typed launcher-capture sidecar: provenance metadata only (what the node is
   * and where it came from — provider, source, app, capture origin). System-owned
   * JSON; persisted as a node scalar, hidden from normal outline rendering and
   * default full-text search. Rich captured content / deferred enrichment is NOT
   * stored here (basic-info-only capture; rich extraction returns via the browser
   * extension path). See `src/core/launcher/sources.ts` and
   * docs/plans/lazy-like-global-launcher.md.
   */
  capture?: CaptureNodeMetadata;
  trashedFromParentId?: NodeId;
  trashedFromIndex?: number;
}

/** A plain content node — the only variant whose `type` is absent. */
export interface ContentNode extends NodeBase { type?: undefined; }
export interface FieldEntryNode extends NodeBase {
  type: 'fieldEntry';
  /** The fieldDef this entry holds a value for. */
  fieldDefId?: NodeId;
}
export interface ReferenceNode extends NodeBase {
  type: 'reference';
  /** The node this reference points to. */
  targetId?: NodeId;
  /** The role this reference plays (backlink allowlist). */
  refRole?: RefRole;
}
export interface CodeBlockNode extends NodeBase {
  type: 'codeBlock';
  /** CodeMirror language bundle id; '' means plain text. */
  codeLanguage?: string;
}
export interface ImageNode extends NodeBase {
  type: 'image';
  assetId?: string;
  mediaUrl?: string;
  mediaAlt?: string;
  imageWidth?: number;
  imageHeight?: number;
}
export interface AttachmentNode extends NodeBase {
  type: 'attachment';
  assetId?: string;
  mimeType?: string;
  originalFilename?: string;
  fileSize?: number;
  thumbnailAssetId?: string;
  pdfPageCount?: number;
  audioDurationMs?: number;
  videoDurationMs?: number;
}
export interface EmbedNode extends NodeBase {
  type: 'embed';
  embedType?: string;
  embedId?: string;
  sourceUrl?: string;
}
export interface TagDefNode extends NodeBase { type: 'tagDef'; }
export interface FieldDefNode extends NodeBase { type: 'fieldDef'; }
export interface DefConfigNode extends NodeBase {
  type: 'defConfig';
  /** Which config knob this row represents. */
  configKey?: DefConfigKey;
}
export interface SystemOptionNode extends NodeBase { type: 'systemOption'; }
export interface ViewDefNode extends NodeBase {
  type: 'viewDef';
  viewMode?: ViewMode;
  toolbarVisible?: boolean;
  groupField?: ViewFieldRef;
}
export interface SortRuleNode extends NodeBase {
  type: 'sortRule';
  sortField?: ViewFieldRef;
  sortDirection?: SortDirection;
}
export interface FilterRuleNode extends NodeBase {
  type: 'filterRule';
  filterField?: ViewFieldRef;
  filterOperator?: FilterOperator;
  filterValueLogic?: FilterValueLogic;
  filterValues?: string[];
}
export interface DisplayFieldNode extends NodeBase {
  type: 'displayField';
  displayField?: ViewFieldRef;
  displayVisible?: boolean;
  displayWidth?: number;
  displayOrder?: number;
  displayLabel?: string;
  displayPlacement?: DisplayPlacement;
}
/**
 * Query parameters carried by both a `search` node (its inline top-level rule)
 * and each `queryCondition` node (a rule/group in the search's condition tree).
 */
export interface QueryParams {
  queryLogic?: QueryLogic;
  queryOp?: QueryOp;
  queryTagDefId?: NodeId;
  queryFieldDefId?: NodeId;
  /** A rule's single-node target (e.g. "field is [node]"); mirrors SearchQueryRule.targetId. */
  queryTargetId?: NodeId;
}
export interface SearchNode extends NodeBase, QueryParams { type: 'search'; }
export interface QueryConditionNode extends NodeBase, QueryParams { type: 'queryCondition'; }

export type Node =
  | ContentNode
  | FieldEntryNode
  | ReferenceNode
  | CodeBlockNode
  | ImageNode
  | AttachmentNode
  | EmbedNode
  | TagDefNode
  | FieldDefNode
  | DefConfigNode
  | SystemOptionNode
  | ViewDefNode
  | SortRuleNode
  | FilterRuleNode
  | DisplayFieldNode
  | SearchNode
  | QueryConditionNode;

export interface DocumentState {
  schemaVersion: number;
  workspaceId: NodeId;
  rootId: NodeId;
  nodes: Record<NodeId, Node>;
}

/** Omit that distributes over a union, preserving each member as its own type. */
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

/** The union of keys across every union member (not the common-key intersection `keyof` gives). */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/**
 * Every field key any node variant can carry. Persistence enumerates this to
 * read/write the flat scalar map generically, independent of a node's variant.
 */
export type NodeFieldKey = KeysOfUnion<Node>;

// The projection mirrors the `Node` union variant-by-variant (minus the trash
// bookkeeping fields), so consumers narrow a projected node by `type` exactly
// as they would a `Node`. While the variants still share their field set this
// is structurally the old broad projection.
export type NodeProjection = DistributiveOmit<Node, 'trashedFromParentId' | 'trashedFromIndex'>;

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
  todayId: NodeId;
  nodes: NodeProjection[];
}

// A projection delivery to the renderer. `full` reseeds the whole document
// (init, resync, whole-tree rewrites like undo/redo/import); `delta` carries only
// the nodes a single mutation changed/removed so per-edit cost scales with the
// change, not the document. `revision` is Core's monotonic counter: a `delta`
// must apply onto `revision - 1`; any gap or a `full` reseeds. `todayId` is the
// one envelope pointer that can move post-init (daily-note rollover); the other
// system ids are immutable so a delta omits them. See docs/plans/incremental-projection.md.
export type ProjectionUpdate =
  | { kind: 'full'; revision: number; projection: DocumentProjection }
  | {
    kind: 'delta';
    revision: number;
    todayId: NodeId;
    changedNodes: NodeProjection[];
    removedIds: NodeId[];
  };

// A full projection plus its revision, for init and resync.
export interface ProjectionSnapshot {
  revision: number;
  projection: DocumentProjection;
}

export interface DocumentProjectionChangedEvent {
  type: 'projection_changed';
  origin: 'agent' | 'user' | 'system';
  update: ProjectionUpdate;
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
  thumbnailAssetId?: string;
  pdfPageCount?: number;
  audioDurationMs?: number;
  videoDurationMs?: number;
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

export interface BatchMoveNodeInput {
  nodeId: NodeId;
  parentId: NodeId;
  index: number | null;
}

// Core's internal command result: a command assembles the full projection
// in-process (cheap — cached refs, no clone). The main-process boundary converts
// this to a `CommandResult` before crossing IPC.
export interface CommandOutcome {
  projection: DocumentProjection;
  focus?: FocusHint;
}

// The renderer-facing command result. The full projection is replaced by a
// `ProjectionUpdate` (delta in the common case) so only changed nodes cross IPC.
export interface CommandResult {
  update: ProjectionUpdate;
  focus?: FocusHint;
}

/** A `name:: value` field harvested from pasted text (resolved to ids in core). */
export interface ParsedPasteField {
  name: string;
  value: string;
}

/**
 * Metadata harvested from a pasted Markdown line beyond its text/children, applied
 * by core (which owns the state) to the materialized — or, for the first/merged
 * block, the existing — row. Names are resolved find-or-create.
 */
export interface PasteRowMeta {
  /** Tag names (e.g. `urgent` from `#urgent`). */
  tags?: string[];
  /** Fields (e.g. `{name:'status', value:'done'}` from `status:: done`). */
  fields?: ParsedPasteField[];
  /** A GFM task-list checkbox (`[ ]` / `[x]`) — show a manual checkbox. */
  checkbox?: boolean;
  /** Whether that checkbox is checked (`[x]`). */
  done?: boolean;
}

export interface CreateNodeTree extends PasteRowMeta {
  content: RichText;
  /** Optional node description/caption to materialize with the row. */
  description?: string;
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

export interface AgentConversation {
  conversationId: string;
  renderProjection: AgentRenderProjection;
  pendingUserQuestion?: AgentUserQuestionPendingView | null;
}

export interface AgentCreateConversationOptions {
  title?: string;
}

export interface AgentConversationListMeta {
  id: string;
  title: string | null;
  members: AgentPrincipal[];
  goal?: string;
  settings?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  lastMessageSnippet?: string | null;
  lastMessageAt?: number | null;
  unreadCount?: number;
}

/**
 * The reasoning ladder, lowest → highest. The single ordered source for effort
 * option ordering (renderer) and nearest-supported-level coercion (runtime), so the
 * two sides never drift.
 */
export const AGENT_REASONING_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AgentReasoningLevel = (typeof AGENT_REASONING_LADDER)[number];
export type AgentReasoningLevelLabels = Partial<Record<AgentReasoningLevel, string>>;
export type AgentPermissionMode = 'trusted' | 'restricted';
export type AgentDelegationPermissionMode = 'restricted';
export type AgentCacheRetention = 'none' | 'short' | 'long';

export interface AgentRuntimeSettings {
  automaticSkillsEnabled: boolean;
  slashSkillsEnabled: boolean;
  compactEnabled: boolean;
  dreamSchedule?: string;
  additionalSkillDirectories: string[];
  providerTimeoutMs: number | null;
  providerMaxRetries: number | null;
  providerMaxRetryDelayMs: number | null;
  providerCacheRetention: AgentCacheRetention;
  disabledSkills?: string[];
  disabledAgents?: string[];
}

export interface AgentRuntimeSettingsInput {
  /** Legacy app-level setting, normalized at read/write time. */
  permissionMode?: AgentPermissionMode;
  automaticSkillsEnabled?: boolean;
  slashSkillsEnabled?: boolean;
  compactEnabled?: boolean;
  dreamSchedule?: string;
  additionalSkillDirectories?: string[];
  providerTimeoutMs?: number | null;
  providerMaxRetries?: number | null;
  providerMaxRetryDelayMs?: number | null;
  providerCacheRetention?: AgentCacheRetention;
  disabledSkills?: string[];
  disabledAgents?: string[];
}

export interface AgentImageGenerationSettings {
  /**
   * Provider-qualified default image model (`providerId/modelId`). Missing means
   * Auto: choose the best enabled image-capable provider/model at run time.
   */
  defaultModel?: string;
}

export interface AgentImageGenerationSettingsInput {
  /** Provider-qualified model id, or null/empty to use Auto. */
  defaultModel?: string | null;
}

export interface AgentDefinition {
  name: string;
  displayName?: string;
  source: 'built-in' | 'user' | 'project';
  rootDir: string;
  agentFile: string;
  description: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  effort?: AgentReasoningLevel | string;
  permissionMode?: AgentDelegationPermissionMode;
  maxTurns?: number;
  skills?: string[];
  background?: boolean;
  body: string;
}

export interface SkillDefinition {
  name: string;
  identity?: string;
  displayName?: string;
  source: 'built-in' | 'user' | 'project';
  rootDir: string;
  skillFile: string;
  description: string;
  hasUserSpecifiedDescription: boolean;
  whenToUse?: string;
  userInvocable: boolean;
  modelInvocable: boolean;
  /**
   * Trust state, derived (never stored). Project skills are false until the user
   * accepts the current content hash. User-source skills are false while the current
   * content hash matches the last agent-written hash AND the user has not accepted
   * those bytes. Unratified skills are excluded from the model skill listing and
   * refuse model-triggered invocation; slash invocation always works (the user's
   * command is per-run consent). Built-ins are always true.
   */
  ratified: boolean;
  /** True when the user explicitly accepted exactly these bytes for automatic model use. */
  accepted?: boolean;
  /** True when one previous version of the last agent edit is held for single-step undo. */
  canUndoLastAgentEdit?: boolean;
  /** sha256 of the raw SKILL.md content; absent for code-registered built-ins. */
  contentHash?: string;
  allowedTools: string[];
  argumentHint?: string;
  argumentNames: string[];
  version?: string;
  model?: string;
  effort?: string;
  shell?: string;
  execution: 'inline' | 'isolated';
  paths?: string[];
  contentLength: number;
  body: string;
}

export type AgentSlashCommandKind = 'runtime' | 'skill';

export interface AgentSlashCommandView {
  id: string;
  kind: AgentSlashCommandKind;
  label: string;
  description?: string;
  insertText: string;
}

/**
 * A provider is a CONNECTION, not a model choice. It proves credentials and an
 * endpoint are reachable; which model/effort actually runs is owned by the agent
 * profile that runs (see `AgentDefinition.model` / `effort` and the built-in
 * assistant's settings-owned default). Provider config therefore carries no
 * `modelId` / `reasoningLevel`.
 */
export interface AgentProviderConfigInput {
  providerId: string;
  baseUrl?: string | null;
  enabled?: boolean;
}

export type AgentProviderAuthKind = 'api-key' | 'oauth' | 'managed';

/**
 * The renderer-visible auth descriptor for a provider. Classification and all
 * credential reasoning live in main (sourced from pi-ai's `getOAuthProviders()`
 * plus a managed set); the renderer only renders this. Carries no secret —
 * never an API key, OAuth token, or AWS/ADC material.
 */
export interface ProviderAuthView {
  authKind: AgentProviderAuthKind;
  /** The single authoritative "can use models / show connected" signal. */
  credentialed: boolean;
  /** True when a user-pasted key is stored (clearable), vs an ambient env key. */
  hasStoredKey?: boolean;
  /** Present for oauth providers. `expiresAt` is read from stored creds — no refresh. */
  oauth?: { connected: boolean; expiresAt?: number };
}

export interface AgentProviderConfigView {
  providerId: string;
  baseUrl?: string;
  enabled: boolean;
  hasApiKey: boolean;
  hasEnvApiKey?: boolean;
  /**
   * Auth descriptor. Optional during the OAuth-providers rollout; once the main
   * builder populates it and the renderer reads it, `hasApiKey`/`hasEnvApiKey`
   * collapse into `auth.credentialed`/`auth.hasStoredKey`.
   */
  auth?: ProviderAuthView;
}

export interface OAuthLoginSelectOption {
  id: string;
  label: string;
}

/**
 * One interactive step of an OAuth sign-in, pushed main→renderer. Folds pi-ai's
 * login callbacks into a single union so loopback (Anthropic) and device-code
 * (Copilot/Codex) share one renderer state machine. `prompt` / `select` /
 * `manual-code` carry a `requestId` the renderer answers via `agent_oauth_respond`.
 */
export type OAuthLoginEvent =
  | { kind: 'auth'; url: string; instructions?: string }
  | { kind: 'device-code'; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { kind: 'progress'; message: string }
  | { kind: 'prompt'; requestId: string; message: string; placeholder?: string }
  | { kind: 'select'; requestId: string; message: string; options: OAuthLoginSelectOption[] }
  | { kind: 'manual-code'; requestId: string };

export interface OAuthLoginEventEnvelope {
  providerId: string;
  event: OAuthLoginEvent;
}

/** main→renderer push channel carrying OAuthLoginEventEnvelope during a sign-in. */
export const LIN_AGENT_OAUTH_EVENT_CHANNEL = 'lin-agent-oauth-event';

export interface AgentModelOption {
  id: string;
  name: string;
  reasoning: boolean;
  supportedThinkingLevels: AgentReasoningLevel[];
  /**
   * Optional model-specific display labels for canonical levels. Saved profile
   * values still use `supportedThinkingLevels`; these labels only reflect the
   * provider/model's own effort naming (for example `LOW`, `HIGH`, `xhigh`, or
   * `max`).
   */
  thinkingLevelLabels?: AgentReasoningLevelLabels;
  contextWindow: number;
  maxTokens: number;
}

export type AgentProviderCapabilityKind = 'language' | 'image_generation';
export type AgentProviderCapabilityIO = 'text' | 'image';

export interface AgentProviderCapabilityModelOption {
  id: string;
  name: string;
  providerId: string;
  input: AgentProviderCapabilityIO[];
  output: AgentProviderCapabilityIO[];
}

export interface AgentProviderCapabilitySummary {
  kind: AgentProviderCapabilityKind;
  models: AgentProviderCapabilityModelOption[];
  refreshable?: boolean;
  lastRefreshError?: string;
}

export interface AgentProviderOption {
  providerId: string;
  /** Auth class for an as-yet-unconfigured provider, so the config window can pick the right UI. */
  authKind: AgentProviderAuthKind;
  /** True for a detected external provider that is usable before a Tenon row exists. */
  credentialed?: boolean;
  /** True when the provider was found locally, either by endpoint probe or install/config presence. */
  detected?: boolean;
  /** External-provider connection state, used for CC Switch registry diagnostics. */
  connectionStatus?: 'ready' | 'proxy-required' | 'unsupported' | 'not-detected';
  /** Human-readable external-provider diagnostic. Must never contain secrets. */
  connectionStatusMessage?: string;
  hasEnvApiKey: boolean;
  envKeyNames: string[];
  defaultBaseUrl?: string;
  /**
   * Capability catalog grouped by runtime surface. `models` below remains the
   * legacy language-model list used by the composer/profile model picker.
   */
  capabilities?: AgentProviderCapabilitySummary[];
  models: AgentModelOption[];
}

export interface AgentProviderSettingsView {
  activeProviderId?: string;
  providers: AgentProviderConfigView[];
  availableProviders: AgentProviderOption[];
  agent: AgentRuntimeSettings;
  imageGeneration: AgentImageGenerationSettings;
}

export interface AgentProviderSecretStatus {
  providerId: string;
  hasApiKey: boolean;
}

/** Returned only by the provider config child window's sender-checked key IPC. */
export interface AgentProviderStoredApiKey {
  providerId: string;
  apiKey?: string;
}

export const EMPTY_RICH_TEXT: RichText = {
  text: '',
  marks: [],
  inlineRefs: [],
};

export function plainText(text: string): RichText {
  return { text, marks: [], inlineRefs: [] };
}

export function nodeReferenceTarget(nodeId: NodeId): ReferenceTarget {
  return { kind: 'node', nodeId };
}

export function inlineRefNodeId(ref: InlineRef): NodeId | null {
  return ref.target.kind === 'node' ? ref.target.nodeId : null;
}

export function referenceTargetsEqual(left: ReferenceTarget, right: ReferenceTarget): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'node') return left.nodeId === (right as Extract<ReferenceTarget, { kind: 'node' }>).nodeId;
  if (left.kind === 'chat-source') {
    const chatRight = right as Extract<ReferenceTarget, { kind: 'chat-source' }>;
    return left.stream === chatRight.stream
      && left.streamId === chatRight.streamId
      && left.range.fromSeqExclusive === chatRight.range.fromSeqExclusive
      && left.range.throughSeq === chatRight.range.throughSeq
      && (left.range.throughEventId ?? null) === (chatRight.range.throughEventId ?? null)
      && (left.range.fromCreatedAtInclusive ?? null) === (chatRight.range.fromCreatedAtInclusive ?? null)
      && (left.range.throughCreatedAtExclusive ?? null) === (chatRight.range.throughCreatedAtExclusive ?? null);
  }
  const localRight = right as Extract<ReferenceTarget, { kind: 'local-file' }>;
  return left.path === localRight.path && left.entryKind === localRight.entryKind;
}

export function referenceTargetSortKey(target: ReferenceTarget): string {
  if (target.kind === 'node') return `node:${target.nodeId}`;
  if (target.kind === 'chat-source') {
    return `chat:${target.stream}:${target.streamId}:${target.range.fromSeqExclusive}:${target.range.throughSeq}:${target.range.throughEventId ?? ''}:${target.range.fromCreatedAtInclusive ?? ''}:${target.range.throughCreatedAtExclusive ?? ''}`;
  }
  return `file:${target.entryKind}:${target.path}`;
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
  // `type` is the broad `NodeType | undefined` here; the variants are
  // structurally identical at Stage 8, so this widening to the union is sound.
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
  } as Node;
}
