import type { CaptureNodeMetadata } from './launcher/sources';
import type { AgentIdentityEntry } from './agent/protocol';

export type {
  AdditionalContext,
  AdditionalContextEntry,
  AgentCoreNotification,
  AgentIdentityEntry,
  AgentMutationCausation,
  ItemProvenance,
  MemoryCitation,
  MemoryCitationEntry,
  Thread,
  ThreadId,
  ThreadItem,
  ThreadItemId,
  ThreadSource,
  Turn,
  TurnId,
  TurnProvenance,
} from './agent/protocol';
export type { ThreadGoal, ThreadGoalStatus } from './agent/goal';

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
export const SOURCE_FIELD_ID = 'field:source';

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
  | 'uri'
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
  | { kind: 'local-file'; path: string; entryKind: 'file' | 'directory' };

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

export type ContentBearingNode =
  | ContentNode
  | FieldEntryNode
  | ReferenceNode
  | CodeBlockNode
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

export type Node = ContentBearingNode;

/** True when a node owns rich content and the ordinary content metadata surface. */
export function isContentBearingNode<T extends { type?: NodeType }>(
  node: T,
): node is T {
  return Boolean(node);
}

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
export type NodeFieldKey = Extract<KeysOfUnion<Node>, string>;

// The projection mirrors the `Node` union variant-by-variant. Trash origin
// metadata stays visible so read projections can associate deleted direct
// children with their live owner; the restore index remains core-internal.
export type ContentBearingNodeProjection = DistributiveOmit<ContentBearingNode, 'trashedFromIndex'>;
export type NodeProjection = ContentBearingNodeProjection;

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

/**
 * Public metadata for an Outline asset. Physical integrity coordinates remain
 * private to Runtime and ContentStore; renderer clients reference only `id`.
 */
export interface AssetMetadata {
  schemaVersion: 1;
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

// Core's internal command result: commands return only local interaction hints.
// Projection materialization is explicit (`projection()` / `revisionDelta()` +
// `projectionNodesFor(...)`) so ordinary mutations do not assemble a full document
// projection before the main-process boundary builds the renderer-facing update.
export interface CommandOutcome {
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

export type FieldSlotMutation =
  | { kind: 'acceptDefault'; entryId?: undefined }
  | { kind: 'appendText'; text: string; id?: NodeId; collect?: boolean; entryId?: NodeId }
  | { kind: 'appendReference'; targetId: NodeId; id?: NodeId; entryId?: NodeId }
  | { kind: 'selectOption'; optionNodeId: NodeId; id?: NodeId; entryId?: NodeId }
  | {
      kind: 'appendNodes';
      nodes: CreateNodeTree[];
      firstTagIds?: NodeId[];
      id?: NodeId;
      entryId?: NodeId;
    }
  | {
      kind: 'appendField';
      name: string;
      fieldType: FieldType;
      id?: NodeId;
      entryId?: NodeId;
    }
  | { kind: 'commit'; entryId?: NodeId };

export interface TagTemplateBackfillPreview {
  readonly nodeCount: number;
  readonly additionCount: number;
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

/**
 * The reasoning ladder, lowest → highest. The single ordered source for effort
 * option ordering (renderer) and nearest-supported-level coercion (runtime), so the
 * two sides never drift.
 */
export const AGENT_REASONING_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AgentReasoningLevel = (typeof AGENT_REASONING_LADDER)[number];
export type AgentReasoningLevelLabels = Partial<Record<AgentReasoningLevel, string>>;
export type AgentCacheRetention = 'none' | 'short' | 'long';

export type AgentDelegationAccess = 'read-only' | 'workspace-write';

export interface AgentDelegationRunnerSettings {
  enabled: boolean;
  /** Provider-qualified model id. Null inherits the invoking root model. */
  model: string | null;
  /** Null inherits the invoking root reasoning effort. */
  effort: AgentReasoningLevel | null;
  maximumAccess: AgentDelegationAccess;
  timeoutMs: number;
  maxConcurrent: number;
  pool: string;
  maxConcurrentPool: number;
}

export interface AgentDelegationSettings {
  enabled: boolean;
  defaultRunnerId: string;
  maxConcurrentGlobal: number;
  maxConcurrentThread: number;
  maxQueuedGlobal: number;
  maxQueuedThread: number;
  runners: Record<string, AgentDelegationRunnerSettings>;
}

export type AgentDelegationRunnerSettingsInput = Partial<AgentDelegationRunnerSettings>;

export interface AgentDelegationSettingsInput extends Partial<Omit<AgentDelegationSettings, 'runners'>> {
  runners?: Record<string, AgentDelegationRunnerSettingsInput>;
}

export interface AgentRuntimeSettings {
  additionalSkillDirectories: string[];
  subagentTokenBudget: number | null;
  subagentMaxDepth: number;
  subagentMaxConcurrent: number;
  providerTimeoutMs: number | null;
  providerMaxRetries: number | null;
  providerMaxRetryDelayMs: number | null;
  providerCacheRetention: AgentCacheRetention;
  delegation: AgentDelegationSettings;
  disabledSkills?: string[];
}

export interface AgentRuntimeSettingsInput {
  additionalSkillDirectories?: string[];
  subagentTokenBudget?: number | null;
  subagentMaxDepth?: number;
  subagentMaxConcurrent?: number;
  providerTimeoutMs?: number | null;
  providerMaxRetries?: number | null;
  providerMaxRetryDelayMs?: number | null;
  providerCacheRetention?: AgentCacheRetention;
  delegation?: AgentDelegationSettingsInput;
  disabledSkills?: string[];
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

export type SkillSourceKind = 'built-in' | 'managed' | 'user' | 'project';

export interface SkillDefinition {
  name: string;
  identity?: string;
  displayName?: string;
  source: SkillSourceKind;
  rootDir: string;
  skillFile: string;
  description: string;
  hasUserSpecifiedDescription: boolean;
  whenToUse?: string;
  userInvocable: boolean;
  modelInvocable: boolean;
  /** True when one previous version of the last agent edit is held for single-step undo. */
  canUndoLastAgentEdit?: boolean;
  /** sha256 of the raw SKILL.md content; absent for code-registered built-ins. */
  contentHash?: string;
  /** Whole-subtree hash for a pinned Tenon-managed skill version. */
  managedContentHash?: string;
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

export type ManagedSkillCompatibilityStatus = 'compatible' | 'unknown' | 'incompatible';

export const MANAGED_SKILL_ERROR_CODES = [
  'invalid_github_url',
  'unsupported_github_url',
  'github_not_found',
  'github_rate_limited',
  'github_unavailable',
  'github_response_too_large',
  'github_invalid_response',
  'github_redirect_rejected',
  'github_timeout',
  'github_tree_truncated',
  'too_many_tree_entries',
  'too_many_skill_candidates',
  'too_many_matching_refs',
  'duplicate_skill_name',
  'invalid_path',
  'hidden_file',
  'nested_git_data',
  'symlink',
  'submodule',
  'executable_file',
  'unsupported_entry',
  'file_count_exceeded',
  'file_size_exceeded',
  'total_size_exceeded',
  'missing_skill_file',
  'duplicate_skill_file',
  'invalid_frontmatter',
  'invalid_skill_name',
  'invalid_description',
  'embedded_shell',
  'invalid_text',
  'unsupported_binary',
  'secret_content',
  'invalid_compatibility',
  'incompatible_tenon',
  'missing_source',
  'catalog_entry_mismatch',
  'stale_discovery',
  'candidate_not_found',
  'candidate_changed',
  'skill_disabled',
  'stale_skill_version',
  'skill_modified',
  'no_update',
  'skill_moved',
  'skill_renamed',
  'stale_update_preview',
  'previous_version_missing',
  'previous_version_modified',
  'catalog_unavailable',
  'catalog_entry_not_found',
  'discovery_expired',
  'update_preview_expired',
  'managed_skill_not_found',
  'invalid_catalog',
  'invalid_catalog_cache',
  'invalid_request',
  'update_failed',
  'rolled_back',
  'unexpected_error',
] as const;

export type ManagedSkillErrorCode = typeof MANAGED_SKILL_ERROR_CODES[number];

export interface ManagedSkillErrorView {
  code: ManagedSkillErrorCode;
  detail?: string;
}

export type ManagedSkillCommandResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ManagedSkillErrorView };

export interface ManagedSkillCompatibilityView {
  status: ManagedSkillCompatibilityStatus;
  appVersion: string;
  declaredRange?: string;
  declaredRanges?: string[];
}

export interface ManagedSkillCatalogEntryView {
  id: string;
  name: string;
  description: string;
  repository: string;
  subdirectory: string;
  trackingRef: string;
  compatibilityRange?: string;
  installedSkillId?: string;
}

export interface ManagedSkillCatalogView {
  status: 'fresh' | 'cached' | 'unavailable';
  entries: ManagedSkillCatalogEntryView[];
  refreshedAt?: number;
  error?: ManagedSkillErrorView;
}

export interface ManagedSkillDiscoveryCandidateView {
  id: string;
  name: string;
  description: string;
  subdirectory: string;
  version?: string;
  compatibility: ManagedSkillCompatibilityView;
  scripts: string[];
  /**
   * The SKILL.md text, so the install review can show what the Skill will tell
   * the model to do. Installing now enables, which puts this text into the
   * agent's context — the inertness boundary covers execution, not instruction,
   * so consent has to be given to the words themselves. Bounded like a diff.
   */
  skillBody?: string;
  /** Set when `skillBody` was cut short, because a capped payload presented as
   *  complete is the same defect as an unmarked truncated diff. */
  skillBodyTruncated?: boolean;
}

export interface ManagedSkillDiscoveryView {
  id: string;
  repository: string;
  trackingRef: string;
  resolvedCommit: string;
  recommended: boolean;
  selectionRequired: boolean;
  candidates: ManagedSkillDiscoveryCandidateView[];
}

export interface ManagedSkillVersionView {
  commit: string;
  contentHash: string;
  installedAt: number;
  fileCount: number;
  totalBytes: number;
  version?: string;
  compatibility?: ManagedSkillCompatibilityView;
  scripts?: string[];
}

export type ManagedSkillStatus =
  | 'installed-disabled'
  | 'enabled'
  | 'update-available'
  | 'modified'
  | 'failed';

export interface ManagedSkillView {
  id: string;
  name: string;
  description: string;
  /** Whether the active version may appear as a slash command. */
  userInvocable: boolean;
  repository: string;
  subdirectory: string;
  trackingRef: string;
  recommended: boolean;
  enabled: boolean;
  status: ManagedSkillStatus;
  compatibility: ManagedSkillCompatibilityView;
  active: ManagedSkillVersionView;
  previous?: ManagedSkillVersionView;
  updateCommit?: string;
  scripts: string[];
  diagnostic?: ManagedSkillErrorView;
}

export interface ManagedSkillUpdatePreviewView {
  id: string;
  skillId: string;
  repository: string;
  subdirectory: string;
  recommended: boolean;
  current: ManagedSkillVersionView;
  candidate: ManagedSkillVersionView;
  compatibility: ManagedSkillCompatibilityView;
  scripts: string[];
  changedPaths: string[];
  skillDiff: string;
  diffTruncated: boolean;
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
 * endpoint are reachable; which model/effort actually runs is owned by the
 * selected Thread Configuration Profile and its persisted effective snapshot.
 * Provider config therefore carries no
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
 * credential reasoning live in main (sourced from each pi-ai provider's auth
 * capabilities plus a managed set); the renderer only renders this. Carries no secret —
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
  /**
   * The last connection probe's verdict, if one has ever run. Absent means
   * unverified — which is honest, and is also the state a credential write
   * restores, so a rotated key never inherits the old key's verdict.
   *
   * It exists because "has a credential" and "works" are different facts and the
   * settings list could only ever report the first. `outcome` is deliberately
   * three-valued: a probe that failed for a reason unrelated to the credential
   * (offline, timeout, 429, 5xx) must not be recorded as a rejection. Tenon
   * probes only on an explicit user write or an explicit Test — never on open,
   * on a schedule, or in the background — because the probe bills a 1-token
   * completion against the provider.
   */
  connectionCheck?: ProviderConnectionCheckView;
}

export interface ProviderConnectionCheckView {
  outcome: 'ok' | 'rejected' | 'unreachable';
  /** Epoch ms, so the surface can say when rather than implying "now". */
  at: number;
  /**
   * Inferred, not read: main derives it by matching the redacted error text, so
   * only a confident 401/403 may produce `rejected`. Anything else — including
   * an unclassified failure — is `unreachable`.
   */
  statusCode?: number;
  /** Already passed through `redactProviderErrorMessage` before it is stored. */
  message?: string;
}

export interface OAuthLoginSelectOption {
  id: string;
  label: string;
}

/**
 * One interactive step of an OAuth sign-in, pushed main→renderer. Folds pi-ai's
 * provider-neutral AuthInteraction into one union so browser, device-code, and
 * manual-code providers share one renderer state machine. `prompt` / `select` /
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
  /** Provider supports an explicit network refresh even when its current catalog is empty. */
  modelsRefreshable?: boolean;
  /**
   * Capability catalog grouped by runtime surface. `models` below remains the
   * legacy language-model list used by the composer/profile model picker.
   */
  capabilities?: AgentProviderCapabilitySummary[];
  models: AgentModelOption[];
}

/** One user- or project-defined Role, as the Agents editor edits it. */
export interface AgentEditableRole {
  readonly name: string;
  readonly layer: 'user' | 'project';
  readonly description: string;
  readonly developerInstructions: string;
  readonly persona: string | null;
  readonly color: string | null;
  /**
   * Null means "inherit", not "none". A capability list only ever NARROWS what
   * the parent has, so an absent list is the full inherited set and an empty one
   * would be a deliberate ban.
   */
  readonly tools: readonly string[] | null;
  readonly skills: readonly string[] | null;
}

/** What the editor writes: everything optional except the identity itself. */
export interface AgentRoleDraft {
  readonly name: string;
  readonly description: string;
  readonly developerInstructions: string;
  readonly persona?: string;
  readonly color?: string;
  /**
   * A capability narrowing has THREE states and the protocol carries all three:
   * `undefined` leaves whatever is on disk (the draft did not mention it),
   * `null` removes the narrowing so everything is inherited, and an array —
   * INCLUDING an empty one — is the exact set allowed. `[]` is a ban, not a
   * shorthand for "inherit": `constrainChildCapabilities` honours it.
   */
  readonly tools?: readonly string[] | null;
  readonly skills?: readonly string[] | null;
}

/** One execution preference exactly as stored in a user or project layer. */
export interface AgentExecutionSelectionRow {
  readonly agentType: string;
  readonly layer: 'user' | 'project';
  readonly modelProvider: string | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
}

/** Sibling payload written atomically with an Agent definition or presentation. */
export interface AgentExecutionSelectionDraft {
  readonly modelProvider?: string | null;
  readonly model?: string | null;
  readonly reasoningEffort?: string | null;
}

/**
 * The conversation agent's own configuration — its standing instructions and the
 * capability ceiling every Subagent is narrowed from. Written as a Configuration
 * Profile; the editor never says the word, because from the reader's side this
 * is simply "the agent I talk to".
 */
export interface AgentProfileDraft {
  /** Omitted leaves what is on disk; empty removes it so the default returns. */
  readonly developerInstructions?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  /** Three states, as on `AgentRoleDraft`. */
  readonly tools?: readonly string[] | null;
  readonly skills?: readonly string[] | null;
}

/** The Profile in force, as WRITTEN — null fields inherit the built-in default. */
export interface AgentProfileView {
  readonly name: string;
  /** Null when nothing is written down and the built-in default is in force. */
  readonly layer: 'user' | 'project' | null;
  readonly developerInstructions: string | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly tools: readonly string[] | null;
  readonly skills: readonly string[] | null;
}

/**
 * A built-in Agent type's frozen definition, carried so the editor can seed a
 * duplicate from it. Read-only everywhere else: this is code, not configuration.
 */
export interface AgentBuiltInDefinition {
  readonly agentType: string;
  readonly description: string;
  readonly developerInstructions: string;
}

/**
 * What a capability list may contain, resolved in main.
 *
 * The catalogue travels with the view rather than being imported by the
 * renderer: a settings pane naming tools it read out of the runtime's own
 * module would drift the moment the runtime gained one.
 */
export interface AgentCapabilityCatalog {
  readonly tools: readonly { readonly key: string; readonly description: string }[];
  readonly skills: readonly string[];
}

/**
 * One presentation re-skin exactly as it is written down, before layering
 * resolves it. The editor seeds its fields from this rather than from the
 * resolved catalog, so opening an identity and saving cannot turn today's
 * built-in default into a permanent override.
 */
export interface AgentPresentationOverrideRow {
  readonly agentType: string;
  readonly layer: 'user' | 'project';
  readonly persona: string | null;
  readonly color: string | null;
}

/**
 * The Agents editor's whole view in one answer: what the transcript can draw
 * (`entries`, the same catalog the renderer resolves identities from) beside
 * what the user may change (`roles`). Built-in types appear only in `entries`
 * — their definitions are frozen, and the editor re-skins them instead.
 */
export interface AgentEditorView {
  readonly entries: readonly AgentIdentityEntry[];
  readonly roles: readonly AgentEditableRole[];
  readonly presentationOverrides: readonly AgentPresentationOverrideRow[];
  readonly executionSelections: readonly AgentExecutionSelectionRow[];
  readonly profile: AgentProfileView;
  readonly builtInDefinitions: readonly AgentBuiltInDefinition[];
  readonly capabilities: AgentCapabilityCatalog;
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
  const localRight = right as Extract<ReferenceTarget, { kind: 'local-file' }>;
  return left.path === localRight.path && left.entryKind === localRight.entryKind;
}

export function referenceTargetSortKey(target: ReferenceTarget): string {
  if (target.kind === 'node') return `node:${target.nodeId}`;
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
