import { autoInitStrategiesForFieldType } from './autoInit';
import { CoreError } from './errors';
import { LoroOutlinerDocument, type SerializedLoroDocumentState } from './loroDocument';
import { freshNodeId, isClientNodeId } from './nodeId';
import {
  OperationJournal,
  decorateHistoryItem,
  operationHistoryEntryFromValue,
  stackStateResult,
  synthesizeHistoryEntry,
  type OperationHistoryEntry,
  type OperationHistoryItem,
  type OperationHistoryMetadata,
  type OperationHistoryQuery,
  type OperationHistoryResult,
  type OperationHistoryScope,
  type OperationStackState,
} from './operationJournal';
import { assembleProjection, buildDocumentProjection, projectNode } from './projection';
import { runSearchExpr, runSearchNode, searchNodeHasRules } from './searchEngine';
import { formatDateSchedule, parseDateSchedule } from './dateSchedule';
import { COMMAND_AGENT_FIELD_ID, COMMAND_SCHEDULE_FIELD_ID } from './systemFields';
import type { TextSearchIndex } from './textSearchIndex';
import {
  CONFIG_SCHEMA,
  ENUM_DOMAINS,
  boolCodec,
  canonicalizeScalar,
  configKeysForDefType,
  configValueKind,
  isInternalConfigNode,
  refRoleCountsAsBacklink,
  type SetConfigValueInput,
} from './configSchema';
import {
  AREAS_ID,
  DAILY_NOTES_ID,
  LIBRARY_ID,
  PROJECTS_ID,
  RECENTS_ID,
  RESOURCES_ID,
  SCHEMA_ID,
  SEARCHES_ID,
  SETTINGS_ID,
  TAG_DAY_ID,
  TAG_WEEK_ID,
  TAG_YEAR_ID,
  TRASH_ID,
  WORKSPACE_ID,
  defConfigNodeId,
  inlineRefNodeId,
  nodeReferenceTarget,
  plainText,
  systemOptionNodeId,
  type Backlink,
  type BatchMoveNodeInput,
  type DefConfigKey,
  type RefRole,
  type CommandOutcome,
  type CreateNodeTree,
  type ParsedPasteField,
  type PasteRowMeta,
  type DocumentProjection,
  type DocumentState,
  type NodeProjection,
  type AutoInitStrategy,
  type FieldConfigPatch,
  type FieldType,
  type DisplayPlacement,
  type FilterOperator,
  type FilterValueLogic,
  type FocusHint,
  type IconKind,
  type Node,
  type CodeBlockNode,
  type CommandNode,
  COMMAND_SCHEDULE_FIELD,
  type DefConfigNode,
  type DisplayFieldNode,
  type EmbedNode,
  type FieldEntryNode,
  type FilterRuleNode,
  type ImageNode,
  type QueryConditionNode,
  type ReferenceNode,
  type SearchNode,
  type SortRuleNode,
  type ViewDefNode,
  type NodeId,
  type NodeType,
  type QueryLogic,
  type QueryOp,
  type RichText,
  type RichTextPatch,
  type SearchNodeConfig,
  type SearchQueryExpr,
  type SearchQueryOperand,
  type SearchQueryRule,
  type SearchHit,
  type SplitNodeOptions,
  type SortDirection,
  type TagConfigPatch,
  type TextMark,
  type ViewFieldRef,
  type ViewMode,
} from './types';
import type { CaptureFieldDef, CreateCaptureInput } from './launcher/sources';

type Mutator = () => FocusHint | undefined;
type FocusOptions = Omit<FocusHint, 'nodeId' | 'selectAll'> & { selectAll?: boolean };
type MoveDirection = 'up' | 'down';
type CommitOrigin = 'user' | 'agent' | 'system' | '__seed__';
export type CoreTransactionMetadata = OperationHistoryMetadata;
export type {
  OperationHistoryEntry,
  OperationHistoryItem,
  OperationHistoryQuery,
  OperationHistoryResult,
  OperationHistoryScope,
};

export interface CoreRevisionDelta {
  revision: number;
  changedNodeIds: string[];
  requiresFullSearchRebuild: boolean;
}

interface TemplateFieldRef {
  fieldDefId: NodeId;
  templateOriginId: NodeId;
}

interface CoreTransaction {
  origin: string;
  before: DocumentState;
  metadata: CoreTransactionMetadata;
}

interface SerializedLoroState extends SerializedLoroDocumentState {
  operationHistory?: OperationHistoryEntry[];
}

type CoreSerializedState = SerializedLoroState;

const DEFAULT_COMMIT_ORIGIN = 'user:implicit';
const SYSTEM_COMMIT_ORIGIN = 'system:core';
const AGENT_COMMIT_ORIGIN = 'agent:tool';
const AUTO_INIT_STRATEGIES: AutoInitStrategy[] = [
  'current_date',
  'ancestor_day_node',
  'ancestor_field_value',
  'ancestor_supertag_ref',
];
const AUTO_INIT_PRIORITY: AutoInitStrategy[] = [
  'ancestor_supertag_ref',
  'current_date',
  'ancestor_day_node',
  'ancestor_field_value',
];

export class Core {
  private loro: LoroOutlinerDocument;
  private commitOriginStack: string[] = [];
  private commitMetadataStack: CoreTransactionMetadata[] = [];
  private activeTransaction?: CoreTransaction;
  private stateValue: DocumentState;
  private history: OperationJournal;
  // Projection cache: the per-node projections plus their sorted id order.
  // Patched incrementally for the touched nodes after each mutation, so the
  // hot path no longer deep-clones every node on every command. `projectionReady`
  // is false until first built or after a whole-tree rewrite (undo/redo/load).
  private projectionNodes = new Map<string, NodeProjection>();
  private projectionOrder: string[] = [];
  private projectionReady = false;
  // Monotonic counter bumped only when a mutation actually changes state. The
  // service layer compares it before/after a command for O(1) change detection
  // instead of stringifying the whole document.
  private revisionValue = 0;
  private lastRevisionDelta: CoreRevisionDelta = {
    revision: 0,
    changedNodeIds: [],
    requiresFullSearchRebuild: true,
  };
  // True when construction seeded the system nodes or minted today's date node
  // (i.e. the in-memory document now differs from what was loaded). The service
  // layer persists once after load so these ids are durable — otherwise the
  // lazily-created today node gets a fresh id on every launch and any renderer
  // state holding the old id (panel root, persisted layout) dangles → a
  // `parent not found` when the user adds the first row to today's note.
  private initialPersistRequired = false;

  constructor(state?: CoreSerializedState) {
    this.loro = new LoroOutlinerDocument(state);
    this.history = new OperationJournal(state?.operationHistory);

    if (this.loro.isEmpty()) {
      this.ensureSystemNodesDirect();
      this.ensureCurrentTodayNodeDirect();
      this.loro.commit('__seed__');
      this.initialPersistRequired = true;
    } else {
      const existing = this.loro.materializeState();
      this.ensureSystemNodesDirect();
      this.ensureCurrentTodayNodeDirect();
      const normalized = this.loro.materializeState();
      if (!sameJson(existing, normalized)) {
        this.loro.commit(SYSTEM_COMMIT_ORIGIN);
        this.initialPersistRequired = true;
      }
    }

    this.stateValue = this.loro.materializeState();
    this.loro.clearTouchedNodeIds();
  }

  /** Whether construction created/changed nodes that are not yet on disk (system
   *  seeding or today's date node). The service persists once after load when set,
   *  so the today node id stays stable across launches. */
  requiresInitialPersist(): boolean {
    return this.initialPersistRequired;
  }

  static new() {
    return new Core();
  }

  static fromState(state: CoreSerializedState) {
    return new Core(state);
  }

  static deserializeState(raw: string): CoreSerializedState {
    const parsed = JSON.parse(raw) as CoreSerializedState;
    if (parsed.kind !== 'loro-document' || parsed.schemaVersion !== 2 || typeof parsed.snapshot !== 'string') {
      throw CoreError.invalidOperation('invalid Loro workspace state');
    }
    return parsed;
  }

  state() {
    this.refreshStateFromLoro();
    return cloneState(this.stateValue);
  }

  intoState() {
    this.refreshStateFromLoro();
    return cloneState(this.stateValue);
  }

  serializeState() {
    const serialized: SerializedLoroState = {
      ...this.loro.serialize(SYSTEM_COMMIT_ORIGIN),
      operationHistory: this.history.entriesForSerialization(500),
    };
    return JSON.stringify(serialized);
  }

  projection(): DocumentProjection {
    // Inside a transaction the cache is not folded until commit, so build fresh
    // to reflect in-flight mutations. Outside one, serve the incremental cache.
    if (this.activeTransaction) return this.freshProjection();
    this.ensureProjectionCache();
    const state = this.loro.materializeState();
    const todayId = this.currentTodayNodeId();
    return assembleProjection(state.workspaceId, state.rootId, todayId, this.projectionOrder, this.projectionNodes);
  }

  /**
   * Project specific nodes by id from the incremental cache — O(ids), skipping the
   * whole-document `materializeState` + `assembleProjection` that `projection()`
   * runs. For the launcher's per-keystroke inline search, which only needs the few
   * hit nodes (+ a parent lookup) and would otherwise rebuild + map the full doc on
   * every keystroke. Missing ids are skipped; order follows the input. (The cache
   * reflects committed state; not for use mid-transaction.)
   */
  projectionNodesByIds(ids: Iterable<string>): NodeProjection[] {
    this.ensureProjectionCache();
    const out: NodeProjection[] = [];
    for (const id of ids) {
      const node = this.projectionNodes.get(id);
      if (node) out.push(node);
    }
    return out;
  }

  // The revision changes only when a mutation actually alters the document, so
  // the caller can detect "did anything change" without comparing snapshots.
  revision(): number {
    return this.revisionValue;
  }

  revisionDelta(): CoreRevisionDelta {
    return {
      revision: this.lastRevisionDelta.revision,
      changedNodeIds: [...this.lastRevisionDelta.changedNodeIds],
      requiresFullSearchRebuild: this.lastRevisionDelta.requiresFullSearchRebuild,
    };
  }

  // The current daily-note ("today") node id — the one projection envelope pointer
  // that can move post-init. Cheap accessor so a projection delta can carry it
  // without assembling the whole projection.
  todayId(): string {
    return this.currentTodayNodeId();
  }

  projectionNodesFor(nodeIds: readonly NodeId[]): Map<NodeId, NodeProjection> {
    if (this.activeTransaction) {
      const state = this.loro.materializeState();
      return new Map(nodeIds.flatMap((nodeId): Array<[NodeId, NodeProjection]> => {
        const node = state.nodes[nodeId];
        return node ? [[nodeId, projectNode(node)]] : [];
      }));
    }
    this.ensureProjectionCache();
    return new Map(nodeIds.flatMap((nodeId): Array<[NodeId, NodeProjection]> => {
      const node = this.projectionNodes.get(nodeId);
      return node ? [[nodeId, node]] : [];
    }));
  }

  private ensureProjectionCache() {
    if (this.projectionReady) return;
    const state = this.loro.materializeState();
    this.projectionNodes.clear();
    for (const id of Object.keys(state.nodes)) this.projectionNodes.set(id, projectNode(state.nodes[id]));
    this.projectionOrder = [...this.projectionNodes.keys()].sort();
    this.projectionReady = true;
  }

  // Fold the touched nodes into the projection cache. Re-sort the id order only
  // when membership changed (create/delete), not on plain content edits.
  private patchProjectionCache(affectedNodeIds: readonly string[], state: DocumentState) {
    this.ensureProjectionCache();
    let membershipChanged = false;
    for (const id of affectedNodeIds) {
      const node = state.nodes[id];
      if (node) {
        if (!this.projectionNodes.has(id)) membershipChanged = true;
        this.projectionNodes.set(id, projectNode(node));
      } else if (this.projectionNodes.delete(id)) {
        membershipChanged = true;
      }
    }
    if (membershipChanged) this.projectionOrder = [...this.projectionNodes.keys()].sort();
  }

  // Discard the projection cache after a whole-tree rewrite (undo/redo) where the
  // set of changed nodes is not tracked; the next read rebuilds it from scratch.
  private invalidateProjectionCache() {
    this.projectionReady = false;
    this.projectionNodes.clear();
    this.projectionOrder = [];
  }

  // Build a projection straight from current Loro state, bypassing the cache.
  // Used for intermediate outcomes inside a transaction, where the cache is not
  // folded until commit. Transactions are batch operations, not the per-keystroke
  // hot path, so an O(N) build here is acceptable.
  private freshProjection(): DocumentProjection {
    const state = this.loro.materializeState();
    return buildDocumentProjection(state, this.currentTodayNodeId());
  }

  // Opt-in invariant check (LIN_VERIFY_CACHE=1): the incrementally-patched
  // projection cache must match a full rebuild. A mismatch means a mutation
  // changed a node without touching it. Off (and free) in production; on in the
  // test suite so any missing `touchNode` surfaces immediately.
  private verifyCaches() {
    if (process.env.LIN_VERIFY_CACHE !== '1') return;
    const cached = JSON.stringify(this.projection());
    const fresh = JSON.stringify(this.freshProjection());
    if (cached !== fresh) {
      throw new Error('[core] projection cache diverged from a full rebuild — a mutation changed a node without touching it');
    }
  }

  beginUndoGroup() {
    this.loro.beginUndoGroup();
  }

  endUndoGroup() {
    this.loro.endUndoGroup();
  }

  async transaction<T>(origin: CommitOrigin, fn: () => T | Promise<T>, metadata: CoreTransactionMetadata = {}): Promise<T> {
    if (this.activeTransaction) return fn();
    const before = this.loro.materializeState();
    const rollbackFrontiers = this.loro.frontiers();
    this.loro.clearTouchedNodeIds();
    this.activeTransaction = {
      origin: commitOriginFor(origin),
      before,
      metadata,
    };
    try {
      const result = await fn();
      const transaction = this.activeTransaction;
      const after = this.loro.materializeState();
      const affectedNodeIds = this.loro.drainTouchedNodeIds();
      if (transaction && changedTouchedNodes(affectedNodeIds, transaction.before, after)) {
        this.commitCurrentTransaction(transaction.origin, transaction.before, after, transaction.metadata, affectedNodeIds);
        this.patchProjectionCache(affectedNodeIds, after);
        this.bumpRevision(affectedNodeIds, false);
      }
      this.activeTransaction = undefined;
      this.refreshStateFromLoro();
      this.verifyCaches();
      return result;
    } catch (error) {
      this.loro.revertTo(rollbackFrontiers, SYSTEM_COMMIT_ORIGIN);
      this.loro.clearTouchedNodeIds();
      this.activeTransaction = undefined;
      // The revert rewrites the tree wholesale; drop the projection cache so the
      // next read rebuilds it from the rolled-back state.
      this.invalidateProjectionCache();
      this.refreshStateFromLoro();
      throw error;
    }
  }

  createNode(
    parentId: string,
    index: number | null | undefined,
    text: string,
    id?: string,
  ): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureParentMutable(state, parentId);
      // A caller-supplied id lets the renderer materialize a draft row under an
      // id it already chose, so the row's React identity survives the
      // draft->real transition (see node-line-editor-step2-eager-materialization).
      // The renderer only *proposes* the id; core validates and owns it.
      if (id !== undefined) {
        if (!isClientNodeId(id)) {
          throw new Error(`createNode: invalid client-supplied id "${id}" (expected node:<uuid>)`);
        }
        const existing = state.nodes[id];
        if (existing) {
          // Idempotent only for a retry of the *same* materialization (same
          // parent). Otherwise a stale/forged id must not hijack another node.
          if (existing.parentId !== parentId) {
            throw new Error(`createNode: id "${id}" already exists under a different parent`);
          }
          return focus(id, { parentId, placement: { kind: 'end' } });
        }
      }
      const newId = this.createPlainNode(parentId, index, text, undefined, id);
      this.applyChildTagsDirect(parentId, newId);
      return focus(newId, { parentId, placement: { kind: 'end' } });
    });
  }

  createRichTextContentNode(parentId: string, index: number | null | undefined, content: RichText): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureParentMutable(state, parentId);
      const id = this.createRichTextNodeDirect(parentId, index, content);
      this.applyChildTagsDirect(parentId, id);
      return focus(id, { parentId, placement: { kind: 'end' } });
    });
  }

  createImageNode(
    parentId: string,
    index: number | null | undefined,
    options: { assetId?: string; mediaUrl?: string; width?: number | null; height?: number | null; alt?: string | null },
  ): CommandOutcome {
    const source = resolveImageSource(options);
    return this.mutate(() => {
      const state = this.snapshot();
      ensureParentMutable(state, parentId);
      const id = freshId('image');
      this.loro.createNodeWithId<ImageNode>(id, parentId, index, 'image', (node) => {
        node.content = plainText('');
        if (source.assetId) node.assetId = source.assetId;
        else node.mediaUrl = source.mediaUrl;
        if (options.width != null) node.imageWidth = options.width;
        if (options.height != null) node.imageHeight = options.height;
        const alt = options.alt?.trim();
        if (alt) node.mediaAlt = alt;
      });
      this.applyChildTagsDirect(parentId, id);
      return focus(id, { parentId, placement: { kind: 'end' } });
    });
  }

  /**
   * Convert a plain content node into an image node in place. Used when
   * pasting/dropping an image (or a remote image URL) onto an existing row so
   * the image lands on that row rather than spawning a sibling. The source is
   * exactly one of `assetId` (local) or `mediaUrl` (remote); the other is
   * cleared. Any existing row text is preserved in `content` (it is not shown
   * for image nodes — the caption is `description`).
   */
  setNodeImage(
    nodeId: string,
    options: { assetId?: string; mediaUrl?: string; width?: number | null; height?: number | null },
  ): CommandOutcome {
    const source = resolveImageSource(options);
    return this.patchNode(nodeId, (node) => {
      if (node.type !== undefined && node.type !== 'image') {
        throw CoreError.invalidOperation('only plain content nodes can become images');
      }
      // Rebuild as an image node so the variant fields type-check; the source is
      // exactly one of assetId/mediaUrl (the other stays cleared).
      const image: ImageNode = {
        ...node,
        type: 'image',
        assetId: source.assetId ? source.assetId : undefined,
        mediaUrl: source.assetId ? undefined : source.mediaUrl,
        imageWidth: options.width != null ? options.width : undefined,
        imageHeight: options.height != null ? options.height : undefined,
      };
      return image;
    });
  }

  createTaggedNode(parentId: string, content: RichText, tagId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureParentMutable(state, parentId);
      if (state.nodes[tagId]?.type !== 'tagDef') throw CoreError.nodeNotFound(tagId);
      const id = this.createRichTextNodeDirect(parentId, null, content);
      this.applyChildTagsDirect(parentId, id);
      this.applyTagDirect(id, tagId);
      return focus(id, { parentId, placement: { kind: 'end' } });
    });
  }

  createTagAndTaggedNode(parentId: string, content: RichText, name: string): CommandOutcome {
    const normalized = name.trim();
    if (!normalized) throw CoreError.invalidOperation('tag name cannot be empty');
    return this.mutate(() => {
      const state = this.snapshot();
      ensureParentMutable(state, parentId);
      const tagId = findTagByName(state, normalized) ?? this.createTagDefDirect(normalized);
      const id = this.createRichTextNodeDirect(parentId, null, content);
      this.applyChildTagsDirect(parentId, id);
      this.applyTagDirect(id, tagId);
      return focus(id, { parentId, placement: { kind: 'end' } });
    });
  }

  createNodesFromTree(parentId: string, nodes: CreateNodeTree[]): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureParentMutable(state, parentId);
      let lastCreatedId: string | undefined;
      for (const node of nodes) {
        const createdId = this.insertNodeTreeDirect(parentId, node);
        lastCreatedId = createdId;
      }
      return lastCreatedId ? focus(lastCreatedId, { parentId, placement: { kind: 'end' } }) : undefined;
    });
  }

  /**
   * Create one capture: a root content node carrying the typed `capture`
   * sidecar plus its bounded visible children, in a single transaction so undo
   * removes the whole capture atomically. The launcher builds metadata in the
   * main process; this method only persists it. The sidecar is provenance-only
   * (source identity, origin, status, warnings) — capture stores no page body.
   */
  createCapture(input: CreateCaptureInput): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureParentMutable(state, input.destinationParentId);
      const id = freshId('node');
      this.loro.createNodeWithId(id, input.destinationParentId, input.index ?? null, undefined, (node) => {
        node.content = clone(input.title);
        if (input.description !== undefined) node.description = input.description;
        // A plain manual note supplies no metadata → no capture sidecar.
        if (input.metadata) node.capture = clone(input.metadata);
      });
      this.applyChildTagsDirect(input.destinationParentId, id);
      // Project the capture into native outline shape: a tag (most specific kind,
      // rolling up to #capture) + fields (Source::, Author::, …). This is what
      // makes a capture an ordinary, filterable/searchable outline node rather
      // than bespoke-rendered data (see docs/plans/lazy-like-global-launcher.md).
      if (input.tag) {
        const tagId = this.ensureCaptureTagDirect(input.tag, input.tagExtends);
        this.applyTagNoHistoryDirect(id, tagId);
      }
      for (const field of input.fields ?? []) {
        this.createCaptureFieldDirect(id, field.field, field.value);
      }
      for (const child of input.children ?? []) this.insertNodeTreeDirect(id, child);
      return focus(id, { parentId: input.destinationParentId, placement: { kind: 'end' } });
    });
  }

  // Reuse a tag definition by name (creating it under the schema if absent), and
  // wire `extends` to the given supertag (e.g. #article extends #capture) so
  // capture-type tags roll up to a single #capture collection. Idempotent: repeated
  // captures never duplicate defs.
  //
  // CRITICAL — only set `extends` on a tag WE just created. A user may already own a
  // same-named personal tag (e.g. their own #video); silently re-parenting it under
  // #capture would pull every node tagged with it into the capture rollup, and undo
  // wouldn't restore the hierarchy. Reusing an existing tag's name is reversible
  // (undo the capture removes the tag application); corrupting its hierarchy is not.
  // So a pre-existing tag is reused as-is and its config is left untouched.
  private ensureCaptureTagDirect(name: string, extendsName?: string): string {
    const existing = findTagByName(this.snapshot(), name);
    const tagId = existing ?? this.createTagDefDirect(name);
    if (!existing && extendsName) {
      const superId = findTagByName(this.snapshot(), extendsName) ?? this.createTagDefDirect(extendsName);
      if (superId !== tagId) {
        this.setConfigValueDirect(tagId, { kind: 'ref', configKey: 'extends', targetId: superId });
      }
    }
    return tagId;
  }

  // Attach a capture field: ensure its (stable-id) definition exists, then add one
  // field entry holding the value as an ordinary content child.
  private createCaptureFieldDirect(ownerId: string, field: CaptureFieldDef, value: string): void {
    this.ensureSeededFieldDefDirect(field);
    const entryId = this.insertFieldEntryNodeDirect(ownerId, null, field.id);
    this.insertNodeTreeDirect(entryId, { content: plainText(value), children: [] });
  }

  // Seed a capture field def at its stable id with the registry name + type, but
  // only if absent — an existing def (seeded earlier, or since renamed/retyped by
  // the user) is left untouched. Identity is the id, never the name, so this is
  // stable across renames and never duplicates a def.
  private ensureSeededFieldDefDirect(field: CaptureFieldDef): void {
    if (this.loro.hasNode(field.id)) return;
    this.loro.createNodeWithId(field.id, SCHEMA_ID, undefined, 'fieldDef', (node) => {
      node.content = plainText(field.name);
    });
    this.setConfigValueDirect(field.id, { kind: 'enum', configKey: 'fieldType', value: field.type });
  }

  pasteNodesIntoNode(
    nodeId: string,
    content: RichText,
    children: CreateNodeTree[],
    siblingsAfter: CreateNodeTree[],
    firstMeta: PasteRowMeta = {},
  ): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeEditable(state, nodeId);
      const parentId = state.nodes[nodeId]?.parentId;
      if (!parentId) throw CoreError.noParent();
      const siblingIndex = (childIndex(state, parentId, nodeId) ?? 0) + 1;
      const node = clone(requiredNode(state, nodeId));
      node.content = clone(content);
      const completedAt = pasteCompletedAt(firstMeta);
      if (completedAt !== undefined) node.completedAt = completedAt;
      node.updatedAt = nowMs();
      this.loro.writeNode(node);
      // The first pasted block merges into this row; apply its harvested tags
      // and fields here since it is not materialized via insertNodeTreeDirect.
      this.applyPasteMetadataDirect(nodeId, firstMeta.tags, firstMeta.fields);

      for (const child of children) this.insertNodeTreeDirect(nodeId, child);

      let focusId = nodeId;
      siblingsAfter.forEach((sibling, offset) => {
        focusId = this.insertNodeTreeDirect(parentId, sibling, siblingIndex + offset);
      });
      return focus(focusId);
    });
  }

  splitNode(nodeId: string, before: RichText, after: RichText, options: SplitNodeOptions = {}): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeEditable(state, nodeId);
      const parentId = state.nodes[nodeId]?.parentId;
      if (!parentId) throw CoreError.noParent();
      const targetParentId = options.targetParentId ?? parentId;
      ensureParentMutable(state, targetParentId);
      const index = options.targetIndex ?? (
        targetParentId === parentId
          ? (childIndex(state, parentId, nodeId) ?? 0) + 1
          : null
      );
      const node = clone(requiredNode(state, nodeId));
      node.content = clone(before);
      node.updatedAt = nowMs();
      this.loro.writeNode(node);

      const newId = freshId('node');
      const copiedTags = targetParentId === parentId ? [...node.tags] : [];
      this.loro.createNodeWithId(newId, targetParentId, index, undefined, (created) => {
        created.content = clone(after);
        created.tags = copiedTags;
      });
      if (targetParentId === parentId) {
        for (const tagId of copiedTags) this.instantiateTagTemplateDirect(newId, tagId);
      } else {
        this.applyChildTagsDirect(targetParentId, newId);
      }
      return focus(newId, {
        parentId: targetParentId,
        placement: options.focusPlacement ?? { kind: 'start' },
      });
    });
  }

  applyNodeTextPatch(nodeId: string, patch: RichTextPatch): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeEditable(state, nodeId);
      this.loro.applyNodeTextPatch(nodeId, patch);
      this.loro.setNodeUpdatedAt(nodeId, nowMs());
      return focus(nodeId, { placement: { kind: 'preserve' } });
    });
  }

  updateNodeDescription(nodeId: string, description: string | null | undefined): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeEditable(state, nodeId);
      const node = clone(requiredNode(state, nodeId));
      setOptional(node, 'description', normalizeOptionalText(description));
      node.updatedAt = nowMs();
      this.loro.writeNode(node);
      return undefined;
    });
  }

  setNodeCheckboxVisible(nodeId: string, visible: boolean): CommandOutcome {
    return this.patchNode(nodeId, (node) => {
      // Manual checkbox: the `completedAt` sentinel carries presence. Adding a
      // checkbox sets the undone sentinel (0); removing it clears the timestamp.
      if (visible) {
        if (node.completedAt === undefined) node.completedAt = 0;
      } else {
        delete node.completedAt;
      }
    });
  }

  setCodeBlock(nodeId: string, codeLanguage?: string): CommandOutcome {
    return this.patchNode(nodeId, (node) => {
      if (node.type !== undefined && node.type !== 'codeBlock') {
        throw CoreError.invalidOperation('only plain content nodes can become code blocks');
      }
      const block: CodeBlockNode = {
        ...node,
        type: 'codeBlock',
        codeLanguage: normalizeCodeLanguage(codeLanguage) || undefined,
      };
      return block;
    });
  }

  setCodeLanguage(nodeId: string, codeLanguage: string): CommandOutcome {
    return this.patchNode(nodeId, (node) => {
      if (node.type !== 'codeBlock') {
        throw CoreError.invalidOperation('node is not a code block');
      }
      setOptional(node, 'codeLanguage', normalizeCodeLanguage(codeLanguage));
    });
  }

  // Convert a plain content row into a command node (its text content stays the
  // brief). Idempotent; seeds the user-only `commandSchedule` protected field so
  // the bright line holds the moment the node becomes a command, and seeds the two
  // config field rows (Schedule / Agent) so the command is fully node-native — the
  // editors hang off real `fieldEntry` children, and the prompt is the remaining
  // (non-field) child outline. Drafting a command (including this conversion) is
  // allowed from any origin — only *arming* the schedule is user-only (see
  // `setCommandSchedule`).
  setCommandNode(nodeId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeEditable(state, nodeId);
      const node = clone(requiredNode(state, nodeId));
      if (node.type !== undefined && node.type !== 'command') {
        throw CoreError.invalidOperation('only plain content nodes can become command nodes');
      }
      const protectedFields = node.protectedFields?.includes(COMMAND_SCHEDULE_FIELD)
        ? node.protectedFields
        : [...(node.protectedFields ?? []), COMMAND_SCHEDULE_FIELD];
      const command: CommandNode = { ...node, type: 'command', protectedFields } as CommandNode;
      command.updatedAt = nowMs();
      this.loro.writeNode(command);
      this.ensureCommandFieldEntriesDirect(nodeId);
      return focus(nodeId);
    });
  }

  // Seed the Schedule + Agent config rows for a command node as real `fieldEntry`
  // children pointing at the built-in system fields (`sys:commandSchedule` /
  // `sys:commandAgent`), whose value editors write the gated scalars. Find-or-create
  // so a re-conversion never duplicates a row; the rows sit ahead of the prompt
  // (the remaining non-field children), in Schedule-then-Agent order.
  private ensureCommandFieldEntriesDirect(nodeId: string): void {
    const hasEntry = (defId: string): boolean =>
      (this.snapshot().nodes[nodeId]?.children ?? []).some((childId) => {
        const child = this.snapshot().nodes[childId];
        return child?.type === 'fieldEntry' && child.fieldDefId === defId;
      });
    if (!hasEntry(COMMAND_SCHEDULE_FIELD_ID)) {
      this.insertFieldEntryNodeDirect(nodeId, 0, COMMAND_SCHEDULE_FIELD_ID);
    }
    if (!hasEntry(COMMAND_AGENT_FIELD_ID)) {
      const children = this.snapshot().nodes[nodeId]?.children ?? [];
      const scheduleIndex = children.findIndex((childId) => {
        const child = this.snapshot().nodes[childId];
        return child?.type === 'fieldEntry' && child.fieldDefId === COMMAND_SCHEDULE_FIELD_ID;
      });
      this.insertFieldEntryNodeDirect(nodeId, scheduleIndex >= 0 ? scheduleIndex + 1 : 0, COMMAND_AGENT_FIELD_ID);
    }
  }

  // Arm / change / clear a command node's schedule. The bright line: a write to
  // the protected `commandSchedule` field is rejected unless it originates from
  // the user. A non-empty value re-arms (`sysLastRunAt = now`) so an occurrence
  // that already passed today does not retroactively fire; clearing it leaves
  // the watermark untouched (the node simply becomes manual-only).
  setCommandSchedule(nodeId: string, schedule: string | undefined, origin: CommitOrigin): CommandOutcome {
    return this.patchNode(nodeId, (node) => {
      if (node.type !== 'command') throw CoreError.invalidOperation('node is not a command node');
      // The bright line, keyed to the node-type invariant (not the mutable
      // `protectedFields` array, which could drift and fail open): arming /
      // changing / clearing a command node's schedule is user-only. The agent
      // can draft the brief and propose a schedule as text, but only the user
      // can arm an unattended run.
      if (origin !== 'user') {
        throw CoreError.invalidOperation('only the user can arm a command node schedule');
      }
      const normalized = normalizeCommandSchedule(schedule);
      const command = node as CommandNode;
      setOptional(command, 'commandSchedule', normalized);
      if (normalized) command.sysLastRunAt = nowMs();
    });
  }

  // Advance a command node's system fire watermark after a successful run. Not
  // user-facing and not protected (system-managed, never agent-written): the
  // anacron scheduler calls this via a `system`-origin command. The agent is
  // barred — otherwise a future agent→document-command path could push the
  // watermark to the far future and permanently suppress the user's schedule
  // (the symmetric counterpart to the user-only `setCommandSchedule` gate).
  // Forward-only — a fire whose captured timestamp is older than the current
  // watermark (a long run that straddled a user re-arm) must never move it
  // backward and re-expose a covered occurrence.
  markCommandFired(nodeId: string, firedAt: number, origin: CommitOrigin): CommandOutcome {
    return this.patchNode(nodeId, (node) => {
      if (node.type !== 'command') throw CoreError.invalidOperation('node is not a command node');
      if (origin === 'agent') throw CoreError.invalidOperation('the agent cannot advance a command fire watermark');
      const command = node as CommandNode;
      command.sysLastRunAt = Math.max(command.sysLastRunAt ?? 0, firedAt);
    });
  }

  // Record that a command occurrence is being ATTEMPTED, before its run starts.
  // System-managed (same agent bar as `markCommandFired`); forward-only. Used
  // only by the startup reconciliation: if a crash/quit/sleep left
  // `sysLastAttemptAt > sysLastRunAt`, that occurrence is treated as consumed and
  // not re-fired (at-most-once). The due check never reads this field, so an
  // in-process run failure still retries (watermark un-advanced + backoff).
  markCommandAttempted(nodeId: string, attemptedAt: number, origin: CommitOrigin): CommandOutcome {
    return this.patchNode(nodeId, (node) => {
      if (node.type !== 'command') throw CoreError.invalidOperation('node is not a command node');
      if (origin === 'agent') throw CoreError.invalidOperation('the agent cannot advance a command attempt marker');
      const command = node as CommandNode;
      command.sysLastAttemptAt = Math.max(command.sysLastAttemptAt ?? 0, attemptedAt);
    });
  }

  // Choose which agent definition runs this command (matches an
  // `AgentDefinition.name`; empty clears back to the main agent). Agent-editable
  // — picking the executor is not part of the user-only bright line (only arming
  // the *schedule* is user-gated, see `setCommandSchedule`).
  setCommandAgent(nodeId: string, agent: string | undefined): CommandOutcome {
    return this.patchNode(nodeId, (node) => {
      if (node.type !== 'command') throw CoreError.invalidOperation('node is not a command node');
      const command = node as CommandNode;
      const normalized = agent?.trim() ? agent.trim() : undefined;
      setOptional(command, 'commandAgent', normalized);
    });
  }

  setViewToolbarVisible(nodeId: string, visible: boolean): CommandOutcome {
    return this.mutate(() => {
      this.patchViewDefDirect(nodeId, (viewDef) => {
        viewDef.toolbarVisible = visible;
      });
      return focus(nodeId);
    });
  }

  setViewMode(nodeId: string, mode: ViewMode): CommandOutcome {
    return this.mutate(() => {
      this.patchViewDefDirect(nodeId, (viewDef) => {
        viewDef.viewMode = mode;
      });
      return focus(nodeId);
    });
  }

  addSortRule(nodeId: string, field: ViewFieldRef, direction: SortDirection = 'asc'): CommandOutcome {
    return this.mutate(() => {
      const viewDefId = this.ensureViewDefDirect(nodeId);
      this.loro.createNodeWithId<SortRuleNode>(freshId('sort'), viewDefId, undefined, 'sortRule', (node) => {
        node.sortField = normalizeRequiredText(field, 'sort field');
        node.sortDirection = direction === 'desc' ? 'desc' : 'asc';
      });
      return focus(nodeId);
    });
  }

  updateSortRule(ruleId: string, field: ViewFieldRef, direction: SortDirection = 'asc'): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      const node = clone(requiredNode(state, ruleId));
      if (node.type !== 'sortRule') throw CoreError.invalidOperation('expected a sort rule');
      node.sortField = normalizeRequiredText(field, 'sort field');
      node.sortDirection = direction === 'desc' ? 'desc' : 'asc';
      node.updatedAt = nowMs();
      this.loro.writeNode(node);
      return focus(ruleId);
    });
  }

  removeSortRule(ruleId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      const node = requiredNode(state, ruleId);
      if (node.type !== 'sortRule') throw CoreError.invalidOperation('expected a sort rule');
      const parentId = node.parentId;
      this.removeSubtreeDirect(ruleId);
      return parentId ? focus(parentId) : undefined;
    });
  }

  clearSortRules(nodeId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      for (const rule of this.viewDefChildren(state, nodeId, 'sortRule')) this.removeSubtreeDirect(rule.id);
      return focus(nodeId);
    });
  }

  addFilterRule(
    nodeId: string,
    field: ViewFieldRef,
    operator: FilterOperator = 'contains',
    values: string[] = [],
    valueLogic: FilterValueLogic = 'any',
  ): CommandOutcome {
    return this.mutate(() => {
      const viewDefId = this.ensureViewDefDirect(nodeId);
      this.loro.createNodeWithId<FilterRuleNode>(freshId('filter'), viewDefId, undefined, 'filterRule', (node) => {
        node.filterField = normalizeRequiredText(field, 'filter field');
        node.filterOperator = normalizeFilterOperator(operator);
        node.filterValueLogic = valueLogic === 'all' ? 'all' : 'any';
        node.filterValues = normalizeTextList(values);
      });
      return focus(nodeId);
    });
  }

  updateFilterRule(
    ruleId: string,
    patch: {
      field?: ViewFieldRef | null;
      operator?: FilterOperator | null;
      values?: string[] | null;
      valueLogic?: FilterValueLogic | null;
    },
  ): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      const node = clone(requiredNode(state, ruleId));
      if (node.type !== 'filterRule') throw CoreError.invalidOperation('expected a filter rule');
      if (patch.field !== undefined && patch.field !== null) node.filterField = normalizeRequiredText(patch.field, 'filter field');
      if (patch.operator !== undefined && patch.operator !== null) node.filterOperator = normalizeFilterOperator(patch.operator);
      if (patch.valueLogic !== undefined && patch.valueLogic !== null) node.filterValueLogic = patch.valueLogic === 'all' ? 'all' : 'any';
      if (patch.values !== undefined && patch.values !== null) node.filterValues = normalizeTextList(patch.values);
      node.updatedAt = nowMs();
      this.loro.writeNode(node);
      return focus(ruleId);
    });
  }

  removeFilterRule(ruleId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      const node = requiredNode(state, ruleId);
      if (node.type !== 'filterRule') throw CoreError.invalidOperation('expected a filter rule');
      const parentId = node.parentId;
      this.removeSubtreeDirect(ruleId);
      return parentId ? focus(parentId) : undefined;
    });
  }

  clearFilterRules(nodeId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      for (const rule of this.viewDefChildren(state, nodeId, 'filterRule')) this.removeSubtreeDirect(rule.id);
      return focus(nodeId);
    });
  }

  setGroupField(nodeId: string, field: ViewFieldRef | null | undefined): CommandOutcome {
    return this.mutate(() => {
      this.patchViewDefDirect(nodeId, (viewDef) => {
        setOptional(viewDef, 'groupField', normalizeOptionalText(field));
      });
      return focus(nodeId);
    });
  }

  addDisplayField(nodeId: string, field: ViewFieldRef): CommandOutcome {
    return this.mutate(() => {
      const viewDefId = this.ensureViewDefDirect(nodeId);
      this.loro.createNodeWithId<DisplayFieldNode>(freshId('display'), viewDefId, undefined, 'displayField', (node) => {
        node.displayField = normalizeRequiredText(field, 'display field');
        node.displayVisible = true;
      });
      return focus(nodeId);
    });
  }

  updateDisplayField(
    displayFieldId: string,
    patch: {
      field?: ViewFieldRef | null;
      visible?: boolean | null;
      width?: number | null;
      order?: number | null;
      label?: string | null;
      placement?: DisplayPlacement | null;
    },
  ): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      const node = clone(requiredNode(state, displayFieldId));
      if (node.type !== 'displayField') throw CoreError.invalidOperation('expected a display field');
      if (patch.field !== undefined && patch.field !== null) node.displayField = normalizeRequiredText(patch.field, 'display field');
      if (patch.visible !== undefined && patch.visible !== null) node.displayVisible = patch.visible;
      if (patch.width !== undefined) setOptional(node, 'displayWidth', patch.width ?? undefined);
      if (patch.order !== undefined) setOptional(node, 'displayOrder', patch.order ?? undefined);
      if (patch.label !== undefined) setOptional(node, 'displayLabel', normalizeOptionalText(patch.label));
      if (patch.placement !== undefined) setOptional(node, 'displayPlacement', normalizeOptionalText(patch.placement) as DisplayPlacement | undefined);
      node.updatedAt = nowMs();
      this.loro.writeNode(node);
      return focus(displayFieldId);
    });
  }

  removeDisplayField(displayFieldId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      const node = requiredNode(state, displayFieldId);
      if (node.type !== 'displayField') throw CoreError.invalidOperation('expected a display field');
      const parentId = node.parentId;
      this.removeSubtreeDirect(displayFieldId);
      return parentId ? focus(parentId) : undefined;
    });
  }

  setNodeIcon(nodeId: string, icon: string | null | undefined, iconKind?: IconKind | null): CommandOutcome {
    return this.patchNodeAppearance(nodeId, (node) => {
      setOptional(node, 'icon', normalizeOptionalText(icon));
      if (node.icon) node.iconKind = iconKind ?? 'emoji';
      else delete node.iconKind;
    });
  }

  setNodeBanner(nodeId: string, assetId: string | null | undefined, position?: { x?: number | null; y?: number | null } | null): CommandOutcome {
    return this.patchNodeAppearance(nodeId, (node) => {
      setOptional(node, 'bannerAssetId', normalizeOptionalText(assetId));
      if (node.bannerAssetId) {
        if (position?.x !== undefined) setOptional(node, 'bannerPositionX', position.x ?? undefined);
        if (position?.y !== undefined) setOptional(node, 'bannerPositionY', position.y ?? undefined);
      } else {
        delete node.bannerPositionX;
        delete node.bannerPositionY;
        delete node.bannerAlt;
      }
    });
  }

  mergeNodeInto(nodeId: string, targetId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeEditable(state, nodeId);
      ensureNodeEditable(state, targetId);
      this.mergeNodeIntoTargetDirect(nodeId, targetId);
      return focus(targetId);
    });
  }

  moveNode(nodeId: string, parentId: string, index?: number | null): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeMovable(state, nodeId);
      ensureParentMutable(state, parentId);
      ensureParentCanContainChildInstance(state, parentId, childInstanceTargetId(state, nodeId), nodeId);
      this.loro.moveNode(nodeId, parentId, index);
      this.touchNodeDirect(nodeId);
      return focus(nodeId);
    });
  }

  batchMoveNodes(moves: readonly BatchMoveNodeInput[]): CommandOutcome {
    return this.mutate(() => {
      const planned = cloneState(this.snapshot());
      for (const move of moves) applyPlannedNodeMove(planned, move);
      for (const move of moves) {
        this.loro.moveNode(move.nodeId, move.parentId, move.index);
        this.touchNodeDirect(move.nodeId);
      }
      return undefined;
    });
  }

  indentNode(nodeId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeMovable(state, nodeId);
      const parentId = requiredNode(state, nodeId).parentId;
      if (!parentId) throw CoreError.noParent();
      const index = childIndex(state, parentId, nodeId);
      if (!index) throw CoreError.noPreviousSibling();
      const newParentId = requiredNode(state, parentId).children[index - 1];
      ensureParentMutable(state, newParentId);
      ensureParentCanContainChildInstance(state, newParentId, childInstanceTargetId(state, nodeId), nodeId);
      this.loro.moveNode(nodeId, newParentId, undefined);
      return focus(nodeId);
    });
  }

  outdentNode(nodeId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeMovable(state, nodeId);
      const parentId = requiredNode(state, nodeId).parentId;
      if (!parentId) throw CoreError.noParent();
      const grandParentId = requiredNode(state, parentId).parentId;
      if (!grandParentId) throw CoreError.noParent();
      ensureParentMutable(state, grandParentId);
      const parentIndex = childIndex(state, grandParentId, parentId) ?? 0;
      ensureParentCanContainChildInstance(state, grandParentId, childInstanceTargetId(state, nodeId), nodeId);
      this.loro.moveNode(nodeId, grandParentId, parentIndex + 1);
      return focus(nodeId);
    });
  }

  trashNode(nodeId: string): CommandOutcome {
    return this.mutate(() => {
      this.trashNodeDirect(nodeId);
      return undefined;
    });
  }

  batchTrashNodes(nodeIds: string[]): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      for (const nodeId of [...nodeIds].reverse()) {
        if (state.nodes[nodeId]) this.trashNodeDirect(nodeId);
      }
      return undefined;
    });
  }

  restoreNode(nodeId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeMovable(state, nodeId);
      const node = clone(requiredNode(state, nodeId));
      const parentId = node.trashedFromParentId && state.nodes[node.trashedFromParentId]
        ? node.trashedFromParentId
        : WORKSPACE_ID;
      const index = node.trashedFromIndex;
      ensureParentCanContainChildInstance(state, parentId, childInstanceTargetId(state, nodeId), nodeId);
      delete node.trashedFromParentId;
      delete node.trashedFromIndex;
      this.loro.writeNode(node);
      this.loro.moveNode(nodeId, parentId, index);
      return focus(nodeId);
    });
  }

  deleteNode(nodeId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeMovable(state, nodeId);
      this.removeSubtreeDirect(nodeId);
      return undefined;
    });
  }

  toggleDone(nodeId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeEditable(state, nodeId);
      this.writeDoneStateDirect(state, nodeId, toggleNodeDone);
      return focus(nodeId);
    });
  }

  cycleDoneState(nodeId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeEditable(state, nodeId);
      this.writeDoneStateDirect(state, nodeId, cycleNodeDoneState);
      return focus(nodeId);
    });
  }

  batchIndentNodes(nodeIds: string[]): CommandOutcome {
    return this.mutate(() => {
      const initial = this.snapshot();
      const batch = new Set(nodeIds);
      const targetParentIds = new Map<string, string>();
      const operationIds = orderNodeIdsByDocumentPosition(initial, nodeIds);
      for (const nodeId of operationIds) {
        const targetParentId = batchIndentTargetParentId(initial, nodeId, batch);
        if (targetParentId) targetParentIds.set(nodeId, targetParentId);
      }
      for (const nodeId of operationIds) {
        const newParentId = targetParentIds.get(nodeId);
        if (!newParentId) continue;
        const state = this.snapshot();
        if (!state.nodes[nodeId]) continue;
        if (!state.nodes[newParentId]) continue;
        try {
          ensureNodeMovable(state, nodeId);
          ensureParentMutable(state, newParentId);
          ensureParentCanContainChildInstance(state, newParentId, childInstanceTargetId(state, nodeId), nodeId);
          this.loro.moveNode(nodeId, newParentId, undefined);
        } catch (error) {
          if (error instanceof CoreError) throw error;
          throw error;
        }
      }
      return undefined;
    });
  }

  batchOutdentNodes(nodeIds: string[]): CommandOutcome {
    return this.mutate(() => {
      for (const nodeId of [...nodeIds].reverse()) {
        const state = this.snapshot();
        if (!state.nodes[nodeId]) continue;
        ensureNodeMovable(state, nodeId);
        const parentId = state.nodes[nodeId].parentId;
        if (!parentId) continue;
        const grandParentId = state.nodes[parentId]?.parentId;
        if (!grandParentId) continue;
        ensureParentMutable(state, grandParentId);
        const parentIndex = childIndex(state, grandParentId, parentId) ?? 0;
        ensureParentCanContainChildInstance(state, grandParentId, childInstanceTargetId(state, nodeId), nodeId);
        this.loro.moveNode(nodeId, grandParentId, parentIndex + 1);
      }
      return undefined;
    });
  }

  batchToggleDone(nodeIds: string[]): CommandOutcome {
    return this.mutate(() => {
      for (const nodeId of nodeIds) {
        const state = this.snapshot();
        if (!state.nodes[nodeId]) continue;
        ensureNodeEditable(state, nodeId);
        this.writeDoneStateDirect(state, nodeId, toggleNodeDone);
      }
      return undefined;
    });
  }

  batchCycleDoneState(nodeIds: string[]): CommandOutcome {
    return this.mutate(() => {
      for (const nodeId of nodeIds) {
        const state = this.snapshot();
        if (!state.nodes[nodeId]) continue;
        ensureNodeEditable(state, nodeId);
        this.writeDoneStateDirect(state, nodeId, cycleNodeDoneState);
      }
      return undefined;
    });
  }

  /**
   * Mutate a node's done state and, when the done/undone state actually flips,
   * push the change into mapped option fields (forward done-state mapping).
   */
  private writeDoneStateDirect(state: DocumentState, nodeId: string, mutate: (node: Node, tagDriven: boolean) => void) {
    const node = clone(requiredNode(state, nodeId));
    const wasDone = nodeIsDone(node);
    mutate(node, nodeTagDrivenCheckbox(state, node));
    node.updatedAt = nowMs();
    this.loro.writeNode(node);
    const nowDone = nodeIsDone(node);
    if (nowDone !== wasDone) this.applyForwardDoneMappingDirect(nodeId, nowDone);
  }

  /** Forward mapping: set each mapped field to its first checked/unchecked option. */
  private applyForwardDoneMappingDirect(nodeId: string, isDone: boolean) {
    for (const mapping of getDoneStateMappings(this.snapshot(), requiredNode(this.snapshot(), nodeId))) {
      const optionId = isDone ? mapping.checkedOptionIds[0] : mapping.uncheckedOptionIds[0];
      if (!optionId) continue;
      const entryId = this.ensureFieldEntryWithTemplateDirect(nodeId, mapping.fieldDefId, undefined, false);
      // Done-state mapping is a controlled binary state-sync (part of the checkbox
      // mechanism): replace the prior state option rather than appending. Free
      // field-value editing always appends — this is the checkbox exception.
      this.clearFieldEntryValuesDirect(entryId, mapping.fieldDefId);
      this.selectFieldOptionDirect(entryId, mapping.fieldDefId, optionId);
    }
  }

  /** Reverse mapping: selecting a mapped option flips the owner node's done state. */
  private applyReverseDoneMappingDirect(ownerId: string | undefined, fieldDefId: string, optionNodeId: string) {
    if (!ownerId) return;
    const state = this.snapshot();
    const owner = state.nodes[ownerId];
    if (!owner) return;
    const newDone = resolveReverseDoneMapping(state, owner, fieldDefId, optionNodeId);
    if (newDone === null) return;
    // Done-state mapping is a binary state-sync: a mapped field must not hold both a
    // checked-mapped and an unchecked-mapped option at once. Selecting one drops the
    // previously-selected opposite-mapped option(s) — mirroring the forward path's
    // clear-then-select — while any non-mapped values stay (the append model).
    this.removeOppositeDoneMappedOptionsDirect(owner, fieldDefId, optionNodeId, newDone);
    const refreshed = this.snapshot().nodes[ownerId];
    if (!refreshed || nodeIsDone(refreshed) === newDone) return;
    const node = clone(refreshed);
    applyNodeDoneState(node, newDone, nodeTagDrivenCheckbox(this.snapshot(), node));
    node.updatedAt = nowMs();
    this.loro.writeNode(node);
  }

  /**
   * Drop a done-mapped field's previously-selected options that map to the OPPOSITE
   * done state from the one just selected, so the field never holds contradictory
   * checked/unchecked options. Non-mapped values are left untouched (append model).
   */
  private removeOppositeDoneMappedOptionsDirect(owner: Node, fieldDefId: string, selectedOptionId: string, newDone: boolean) {
    const state = this.snapshot();
    const oppositeTargets = new Set<string>();
    for (const mapping of getDoneStateMappings(state, owner)) {
      if (mapping.fieldDefId !== fieldDefId) continue;
      const oppositeOptionIds = newDone ? mapping.uncheckedOptionIds : mapping.checkedOptionIds;
      for (const optionId of oppositeOptionIds) {
        if (optionId === selectedOptionId) continue;
        oppositeTargets.add(optionValueTargetId(state, optionId));
      }
    }
    if (oppositeTargets.size === 0) return;
    const fieldEntryId = owner.children.find((childId) => {
      const child = state.nodes[childId];
      return child?.type === 'fieldEntry' && child.fieldDefId === fieldDefId;
    });
    if (!fieldEntryId) return;
    for (const childId of [...state.nodes[fieldEntryId]?.children ?? []]) {
      const child = state.nodes[childId];
      if (child?.type === 'reference' && child.targetId && oppositeTargets.has(child.targetId)) {
        this.removeSubtreeDirect(childId);
      }
    }
  }

  batchDuplicateNodes(nodeIds: string[]): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      let firstCloneId: string | undefined;
      for (const nodeId of topLevelNodeIds(state, nodeIds)) {
        if (!state.nodes[nodeId]) continue;
        ensureNodeMovable(state, nodeId);
        const parentId = requiredNode(state, nodeId).parentId;
        if (!parentId) throw CoreError.noParent();
        ensureParentMutable(state, parentId);
        const index = childIndex(state, parentId, nodeId) ?? 0;
        const cloneId = this.cloneSubtreeDirect(nodeId, parentId, index + 1);
        firstCloneId ??= cloneId;
      }
      return firstCloneId ? focus(firstCloneId) : undefined;
    });
  }

  batchMoveNodesUp(nodeIds: string[]): CommandOutcome {
    return this.mutate(() => {
      const state = cloneState(this.snapshot());
      moveSelectedSiblings(state, nodeIds, 'up');
      this.applyPlannedParentOrders(state);
      return undefined;
    });
  }

  batchMoveNodesDown(nodeIds: string[]): CommandOutcome {
    return this.mutate(() => {
      const state = cloneState(this.snapshot());
      moveSelectedSiblings(state, nodeIds, 'down');
      this.applyPlannedParentOrders(state);
      return undefined;
    });
  }

  batchApplyTag(nodeIds: string[], tagId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      if (state.nodes[tagId]?.type !== 'tagDef') throw CoreError.nodeNotFound(tagId);
      for (const nodeId of nodeIds) {
        if (!this.snapshot().nodes[nodeId]) continue;
        this.applyTagDirect(nodeId, tagId);
      }
      return undefined;
    });
  }

  createTag(name: string): CommandOutcome {
    const normalized = name.trim();
    if (!normalized) throw CoreError.invalidOperation('tag name cannot be empty');
    return this.mutate(() => {
      const state = this.snapshot();
      const existing = findTagByName(state, normalized);
      if (existing) return focus(existing);
      const id = this.createTagDefDirect(normalized);
      return focus(id);
    });
  }

  applyTag(nodeId: string, tagId: string): CommandOutcome {
    return this.mutate(() => {
      this.applyTagDirect(nodeId, tagId);
      return focus(nodeId);
    });
  }

  removeTag(nodeId: string, tagId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeEditable(state, nodeId);
      const node = clone(requiredNode(state, nodeId));
      const hadTag = node.tags.includes(tagId);
      node.tags = node.tags.filter((id) => id !== tagId);
      node.updatedAt = nowMs();
      this.loro.writeNode(node);
      if (hadTag) this.cleanupFieldsFromRemovedTagDirect(nodeId, tagId);
      return focus(nodeId);
    });
  }

  setTagConfig(tagId: string, patch: TagConfigPatch): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeEditable(state, tagId);
      ensureTagDefinition(state, tagId);
      if (patch.extends) {
        ensureTagDefinition(state, patch.extends);
        if (patch.extends === tagId || tagExtendsWouldCycle(state, tagId, patch.extends)) {
          throw CoreError.invalidOperation('tag inheritance cannot create a cycle');
        }
      }
      if (patch.childSupertag) ensureTagDefinition(state, patch.childSupertag);
      const node = clone(requiredNode(state, tagId));
      node.updatedAt = nowMs();
      this.loro.writeNode(node);
      // config-as-nodes: every tag knob is stored in the defConfig subtree.
      if (patch.showCheckbox !== undefined) {
        this.setConfigValueDirect(tagId, { kind: 'scalar', configKey: 'showCheckbox', text: patch.showCheckbox ? 'true' : 'false' });
      }
      if (patch.doneStateEnabled !== undefined) {
        this.setConfigValueDirect(tagId, { kind: 'scalar', configKey: 'doneStateEnabled', text: patch.doneStateEnabled ? 'true' : 'false' });
      }
      if ('color' in patch) {
        this.setConfigValueDirect(tagId, { kind: 'scalar', configKey: 'color', text: normalizeOptionalText(patch.color) ?? null });
      }
      if ('extends' in patch) {
        this.setConfigValueDirect(tagId, { kind: 'ref', configKey: 'extends', targetId: normalizeOptionalText(patch.extends) ?? null });
      }
      if ('childSupertag' in patch) {
        this.setConfigValueDirect(tagId, { kind: 'ref', configKey: 'childSupertag', targetId: normalizeOptionalText(patch.childSupertag) ?? null });
      }
      if (patch.doneMapChecked !== undefined) {
        this.setConfigValueDirect(tagId, { kind: 'refList', configKey: 'doneMapChecked', targetIds: patch.doneMapChecked });
      }
      if (patch.doneMapUnchecked !== undefined) {
        this.setConfigValueDirect(tagId, { kind: 'refList', configKey: 'doneMapUnchecked', targetIds: patch.doneMapUnchecked });
      }
      return focus(tagId);
    });
  }

  setFieldConfig(fieldId: string, patch: FieldConfigPatch): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeEditable(state, fieldId);
      ensureFieldDefinition(state, fieldId);
      const current = clone(requiredNode(state, fieldId));
      const nextFieldType = patch.fieldType ?? fieldTypeOf(state, fieldId);
      const nextMin = 'minValue' in patch ? patch.minValue ?? undefined : fieldNumberConfigOf(state, fieldId, 'minValue');
      const nextMax = 'maxValue' in patch ? patch.maxValue ?? undefined : fieldNumberConfigOf(state, fieldId, 'maxValue');
      if (patch.sourceSupertag) {
        ensureTagDefinition(state, patch.sourceSupertag);
        if (nextFieldType !== 'options_from_supertag') {
          throw CoreError.invalidOperation('source supertag is only valid for options-from-supertag fields');
        }
      }
      if (patch.autocollectOptions === true && nextFieldType !== 'options') {
        throw CoreError.invalidOperation('auto-collect options is only valid for options fields');
      }
      if (patch.hideField) ensureValidHideFieldMode(patch.hideField.trim());
      if (patch.autoInitialize) ensureValidAutoInitialize(patch.autoInitialize);
      if (nextMin !== undefined && nextMax !== undefined && nextMin > nextMax) {
        throw CoreError.invalidOperation('minimum value cannot be greater than maximum value');
      }
      current.updatedAt = nowMs();
      this.loro.writeNode(current);
      // config-as-nodes: fieldType lives in the defConfig subtree.
      if (patch.fieldType !== undefined) {
        this.setConfigValueDirect(fieldId, { kind: 'enum', configKey: 'fieldType', value: patch.fieldType });
      }
      if ('nullable' in patch) {
        this.setConfigValueDirect(fieldId, { kind: 'scalar', configKey: 'nullable', text: patch.nullable == null ? null : (patch.nullable ? 'true' : 'false') });
      }
      if ('hideField' in patch) {
        this.setConfigValueDirect(fieldId, { kind: 'enum', configKey: 'hideField', value: normalizeOptionalText(patch.hideField) ?? null });
      }
      // autoInitialize: explicit set, or pruned to the new type's valid strategies
      // when the field type changes. Each strategy is type-specific, so a stored
      // strategy that the new type does not offer would otherwise linger
      // invisibly and be silently dropped on the next unrelated edit (the picker
      // only ever serializes the offered set).
      if ('autoInitialize' in patch) {
        this.setConfigValueDirect(fieldId, { kind: 'enumList', configKey: 'autoInitialize', values: parseAutoInitStrategies(normalizeOptionalText(patch.autoInitialize)) });
      } else if (patch.fieldType !== undefined) {
        const currentAutoInit = fieldAutoInitOf(state, fieldId);
        const valid = new Set(autoInitStrategiesForFieldType(patch.fieldType));
        const pruned = currentAutoInit.filter((strategy) => valid.has(strategy));
        if (pruned.length !== currentAutoInit.length) {
          this.setConfigValueDirect(fieldId, { kind: 'enumList', configKey: 'autoInitialize', values: pruned });
        }
      }
      // minValue/maxValue: explicit set, or cleared when the type is no longer numeric.
      const clearRange = patch.fieldType !== undefined && patch.fieldType !== 'number';
      if ('minValue' in patch || clearRange) {
        const min = clearRange && !('minValue' in patch) ? null : patch.minValue;
        this.setConfigValueDirect(fieldId, { kind: 'scalar', configKey: 'minValue', text: min == null ? null : String(min) });
      }
      if ('maxValue' in patch || clearRange) {
        const max = clearRange && !('maxValue' in patch) ? null : patch.maxValue;
        this.setConfigValueDirect(fieldId, { kind: 'scalar', configKey: 'maxValue', text: max == null ? null : String(max) });
      }
      // autocollectOptions: explicit set, or cleared when the type no longer supports it.
      if (patch.autocollectOptions !== undefined) {
        this.setConfigValueDirect(fieldId, { kind: 'scalar', configKey: 'autocollectOptions', text: patch.autocollectOptions ? 'true' : 'false' });
      } else if (patch.fieldType !== undefined && patch.fieldType !== 'options') {
        this.setConfigValueDirect(fieldId, { kind: 'scalar', configKey: 'autocollectOptions', text: null });
      }
      // config-as-nodes: sourceSupertag lives in the defConfig subtree. Set it,
      // or clear it when the field type no longer supports it.
      if ('sourceSupertag' in patch) {
        this.setConfigValueDirect(fieldId, { kind: 'ref', configKey: 'sourceSupertag', targetId: normalizeOptionalText(patch.sourceSupertag) ?? null });
      } else if (patch.fieldType !== undefined && patch.fieldType !== 'options_from_supertag') {
        this.setConfigValueDirect(fieldId, { kind: 'ref', configKey: 'sourceSupertag', targetId: null });
      }
      return focus(fieldId);
    });
  }

  // config-as-nodes Stage 4: ensure a definition carries the full set of
  // `defConfig` rows for its kind (tag/field), pinned as a leading internal
  // segment. Idempotent; values are untouched. Set values via setConfigValue.
  reconcileConfigSubtree(defId: string): CommandOutcome {
    return this.mutate(() => {
      this.reconcileConfigSubtreeDirect(defId);
      return focus(defId);
    });
  }

  // config-as-nodes Stage 4: the registry-governed value-write chokepoint. The
  // defConfig row's structure is locked; only its value child(ren) change here.
  setConfigValue(defId: string, input: SetConfigValueInput): CommandOutcome {
    return this.mutate(() => {
      this.setConfigValueDirect(defId, input);
      return focus(defId);
    });
  }

  createFieldDef(tagId: string, name: string, fieldType: FieldType): CommandOutcome {
    const normalized = name.trim();
    if (!normalized) throw CoreError.invalidOperation('field name cannot be empty');
    return this.mutate(() => {
      const state = this.snapshot();
      ensureParentMutable(state, tagId);
      if (state.nodes[tagId]?.type !== 'tagDef') throw CoreError.invalidOperation('field templates belong under tags');
      const fieldDefId = this.insertFieldDefNodeDirect(SCHEMA_ID, normalized, fieldType);
      const templateEntryId = this.insertFieldEntryNodeDirect(tagId, undefined, fieldDefId);
      for (const taggedNodeId of findNodesWithTag(state, tagId)) {
        this.ensureFieldEntryWithTemplateDirect(taggedNodeId, fieldDefId, templateEntryId, false);
      }
      return focus(templateEntryId);
    });
  }

  createInlineFieldAfterNode(afterNodeId: string, name: string, fieldType: FieldType): CommandOutcome {
    const normalized = name.trim();
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeMovable(state, afterNodeId);
      const parentId = state.nodes[afterNodeId]?.parentId;
      if (!parentId) throw CoreError.noParent();
      ensureParentMutable(state, parentId);
      const fieldDefId = this.insertFieldDefNodeDirect(SCHEMA_ID, normalized, fieldType);
      const existing = clone(requiredNode(state, afterNodeId));
      // Convert the row into a field entry: rebuild as the variant rather than
      // mutating the discriminant in place.
      const node: FieldEntryNode = {
        ...existing,
        type: 'fieldEntry',
        fieldDefId,
        content: plainText(''),
        tags: [],
        completedAt: undefined,
      };
      this.loro.writeNode(node);
      return focus(afterNodeId, { parentId, surface: 'field-name', placement: { kind: 'all' } });
    });
  }

  createInlineField(parentId: string, index: number | null | undefined, name: string, fieldType: FieldType): CommandOutcome {
    const normalized = name.trim();
    return this.mutate(() => {
      const state = this.snapshot();
      ensureParentMutable(state, parentId);
      const fieldDefId = this.insertFieldDefNodeDirect(SCHEMA_ID, normalized, fieldType);
      const fieldEntryId = this.insertFieldEntryNodeDirect(parentId, index, fieldDefId);
      return focus(fieldEntryId, { parentId, surface: 'field-name', placement: { kind: 'all' } });
    });
  }

  // Reuse an existing field definition for a field entry instead of keeping the
  // throwaway draft def that `>` minted. The renderer calls this when the user
  // picks a previously-created field (or a system field) from the name popover:
  // the entry is repointed at `targetDefId`, and the orphaned draft def — a plain
  // user fieldDef under SCHEMA_ID that nothing else references anymore — is
  // removed so reuse never leaves a dangling empty definition behind.
  reuseFieldDefinition(entryId: string, targetDefId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      const entry = clone(requiredNode(state, entryId));
      if (entry.type !== 'fieldEntry') {
        throw CoreError.invalidOperation('only field entries can be relinked to a field definition');
      }
      // A built-in system field (`sys:*`) has no backing def node — its value is
      // computed read-only from the owner. Any other target must resolve to a real
      // field definition.
      const isSystemField = isSystemFieldDefId(targetDefId);
      if (!isSystemField) {
        const targetDef = requiredNode(state, targetDefId);
        if (targetDef.type !== 'fieldDef') {
          throw CoreError.invalidOperation('relink target must be a field definition');
        }
      }
      const previousDefId = entry.fieldDefId;
      const focusOutcome = focus(entryId, { parentId: entry.parentId, surface: 'field-name', placement: { kind: 'all' } });
      if (previousDefId === targetDefId) return focusOutcome;
      entry.fieldDefId = targetDefId;
      this.loro.writeNode(entry);
      // A read-only system field's value is computed from the owner, never stored,
      // so any value children the draft entry carried become dead nodes after the
      // relink — drop them (mirrors clearFieldValue) so reuse leaves the entry
      // value-clean and never resurrects a stale value as a hidden child.
      if (isSystemField) {
        for (const childId of [...entry.children]) this.removeSubtreeDirect(childId);
      }
      if (previousDefId) this.removeOrphanedFieldDefDirect(previousDefId, state, entryId);
      return focusOutcome;
    });
  }

  // Drop a field definition left dangling by a relink. Guards: only a plain user
  // fieldDef directly under SCHEMA_ID (never a system node or a nested def), and
  // only when no other field entry still references it. `stateBeforeRelink` is the
  // pre-mutation snapshot, so the just-relinked entry is excluded by id.
  private removeOrphanedFieldDefDirect(defId: string, stateBeforeRelink: DocumentState, relinkedEntryId: string) {
    const def = stateBeforeRelink.nodes[defId];
    if (!def || def.type !== 'fieldDef' || def.parentId !== SCHEMA_ID || isSystemId(defId)) return;
    const stillReferenced = Object.values(stateBeforeRelink.nodes).some(
      (node) => node.type === 'fieldEntry' && node.id !== relinkedEntryId && node.fieldDefId === defId,
    );
    if (stillReferenced) return;
    this.removeSubtreeDirect(defId);
  }

  registerCollectedOption(fieldDefId: string, name: string): CommandOutcome {
    const normalized = name.trim();
    if (!normalized) throw CoreError.invalidOperation('option name cannot be empty');
    return this.mutate(() => {
      const state = this.snapshot();
      ensureCollectableOptionsFieldDef(state, fieldDefId);
      return focus(this.ensureOptionNodeDirect(fieldDefId, normalized));
    });
  }

  // Validate a renderer-proposed client id for a field value node, mirroring the
  // createNode contract: the renderer may propose the trailing draft row's stable
  // id so the row's React identity (and any in-flight IME composition) survives
  // materialization. Core validates the shape and rejects collisions; an absent
  // id falls back to a freshly minted one.
  private resolveFieldValueId(state: DocumentState, id: string | undefined, prefix: string): string {
    if (id === undefined) return freshId(prefix);
    if (!isClientNodeId(id)) {
      throw CoreError.invalidOperation(`invalid client-supplied id "${id}" (expected node:<uuid>)`);
    }
    if (state.nodes[id]) throw CoreError.invalidOperation(`id "${id}" already exists`);
    return id;
  }

  createCollectedFieldOption(fieldEntryId: string, name: string, id?: string): CommandOutcome {
    const normalized = name.trim();
    if (!normalized) throw CoreError.invalidOperation('option name cannot be empty');
    return this.mutate(() => {
      const state = this.snapshot();
      const fieldEntry = requiredNode(state, fieldEntryId);
      if (fieldEntry.type !== 'fieldEntry') throw CoreError.invalidOperation('options can only be created on field entries');
      const fieldDefId = fieldEntry.fieldDefId;
      if (!fieldDefId) throw CoreError.invalidOperation('field entry has no field definition');
      ensureCollectableOptionsFieldDef(state, fieldDefId);
      const existingOptionId = findOptionByName(state, fieldDefId, normalized);
      if (existingOptionId) {
        // Typed text matches an existing pool option: reference it (deduped)
        // rather than minting a duplicate. The reference carries the renderer id
        // so the draft row stays the same React node through materialization.
        this.selectFieldOptionDirect(fieldEntryId, fieldDefId, existingOptionId, id);
        return focus(fieldEntryId);
      }

      // Everything is a node: each created value appends. Core no longer
      // special-cases cardinality (the single-vs-list distinction was removed).
      const valueId = this.resolveFieldValueId(state, id, 'option_value');
      this.loro.createNodeWithId(valueId, fieldEntryId, undefined, undefined, (node) => {
        node.content = plainText(normalized);
      });
      this.loro.createNodeWithId<ReferenceNode>(freshId('option_ref'), fieldDefId, undefined, 'reference', (node) => {
        node.targetId = valueId;
        node.autoCollected = true;
      });
      return focus(fieldEntryId);
    });
  }

  selectFieldOption(fieldEntryId: string, optionNodeId: string, id?: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      const fieldEntry = requiredNode(state, fieldEntryId);
      if (fieldEntry.type !== 'fieldEntry') throw CoreError.invalidOperation('options can only be selected on field entries');
      const fieldDefId = fieldEntry.fieldDefId;
      if (!fieldDefId) throw CoreError.invalidOperation('field entry has no field definition');
      ensureOptionsFieldDef(state, fieldDefId);
      ensureOptionBelongsToField(state, fieldDefId, optionNodeId);
      this.selectFieldOptionDirect(fieldEntryId, fieldDefId, optionNodeId, id);
      this.applyReverseDoneMappingDirect(fieldEntry.parentId, fieldDefId, optionNodeId);
      return focus(fieldEntryId);
    });
  }

  /**
   * Append a reference value on a `reference` field. Everything is a node: the
   * value is a `reference` child of the entry pointing at any existing node
   * (deduped against an already-present reference), reusing the same append path
   * as option selection — only the target is unconstrained (any node, not a pool
   * option). Picking a node twice is a no-op.
   */
  addFieldReference(fieldEntryId: string, targetNodeId: string, id?: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      const fieldEntry = requiredNode(state, fieldEntryId);
      if (fieldEntry.type !== 'fieldEntry') throw CoreError.invalidOperation('references can only be set on field entries');
      const fieldDefId = fieldEntry.fieldDefId;
      if (!fieldDefId) throw CoreError.invalidOperation('field entry has no field definition');
      ensureReferenceFieldDef(state, fieldDefId);
      requiredNode(state, targetNodeId);
      this.selectFieldOptionDirect(fieldEntryId, fieldDefId, targetNodeId, id);
      return focus(fieldEntryId);
    });
  }

  /**
   * Set a free-text value on an options field without collecting it as a
   * reusable option (decoupled from autocollect). Everything is a node: the
   * value appends as a plain content child (never a reference into the option
   * pool); whitespace-only text is a no-op. Clearing goes through clearFieldValue.
   */
  setFieldFreeTextValue(fieldEntryId: string, text: string, id?: string): CommandOutcome {
    const normalized = text.trim();
    return this.mutate(() => {
      const state = this.snapshot();
      const fieldEntry = requiredNode(state, fieldEntryId);
      if (fieldEntry.type !== 'fieldEntry') throw CoreError.invalidOperation('field values can only be set on field entries');
      if (!normalized) return focus(fieldEntryId);
      const valueId = this.resolveFieldValueId(state, id, 'value');
      this.loro.createNodeWithId(valueId, fieldEntryId, undefined, undefined, (node) => {
        node.content = plainText(normalized);
      });
      return focus(fieldEntryId);
    });
  }

  clearFieldValue(fieldEntryId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      const fieldEntry = requiredNode(state, fieldEntryId);
      if (fieldEntry.type !== 'fieldEntry') throw CoreError.invalidOperation('field values can only be cleared on field entries');
      if (fieldEntry.fieldDefId) {
        this.clearFieldEntryValuesDirect(fieldEntryId, fieldEntry.fieldDefId);
      } else {
        for (const childId of [...fieldEntry.children]) this.removeSubtreeDirect(childId);
      }
      return focus(fieldEntryId);
    });
  }

  /**
   * Remove a single field value (the gesture behind backspacing an empty value
   * row). Mirrors clearFieldValue's per-value cleanup so an auto-collected value
   * never leaves an orphan reference behind in the option pool: a value still
   * referenced elsewhere is promoted into the pool, otherwise its auto-collected
   * pool references are removed alongside it. A plain value (free text, or a
   * selected-option reference) is simply removed.
   */
  removeFieldValue(valueId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      const value = requiredNode(state, valueId);
      const fieldEntryId = value.parentId;
      if (!fieldEntryId) throw CoreError.noParent();
      const fieldEntry = state.nodes[fieldEntryId];
      const fieldDefId = fieldEntry?.type === 'fieldEntry' ? fieldEntry.fieldDefId : undefined;
      if (fieldDefId) {
        if (!this.promoteCollectedValueIfReferencedDirect(fieldEntryId, fieldDefId, valueId)) {
          this.removeCollectedReferencesForFieldValuesDirect(fieldDefId, [valueId]);
          this.removeSubtreeDirect(valueId);
        }
      } else {
        this.removeSubtreeDirect(valueId);
      }
      return focus(fieldEntryId);
    });
  }

  addReference(parentId: string, targetId: string, index?: number | null): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureParentMutable(state, parentId);
      const resolvedTargetId = resolveReferenceTargetId(state, targetId);
      if (wouldCreateReferenceCycle(state, parentId, resolvedTargetId)) throw CoreError.referenceCycle();
      ensureParentCanContainChildInstance(state, parentId, resolvedTargetId);
      const id = freshId('ref');
      this.loro.createNodeWithId<ReferenceNode>(id, parentId, index, 'reference', (node) => {
        node.targetId = resolvedTargetId;
      });
      return focus(id);
    });
  }

  addReferenceConversion(parentId: string, targetId: string, index?: number | null): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureParentMutable(state, parentId);
      const resolvedTargetId = resolveReferenceTargetId(state, targetId);
      if (wouldCreateReferenceCycle(state, parentId, resolvedTargetId)) throw CoreError.referenceCycle();
      ensureParentCanContainChildInstance(state, parentId, resolvedTargetId);
      const inlineNodeId = this.createInlineReferenceNodeDirect(state, parentId, index, resolvedTargetId);
      return focus(inlineNodeId, {
        parentId,
        placement: { kind: 'text-offset', offset: 0, inlineRefBias: 'after' },
      });
    });
  }

  setReferenceTarget(referenceId: string, targetId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeMovable(state, referenceId);
      const current = clone(requiredNode(state, referenceId));
      if (current.type !== 'reference') throw CoreError.invalidOperation('expected a reference node');
      const resolvedTargetId = resolveReferenceTargetId(state, targetId);
      const parentId = current.parentId;
      if (!parentId) throw CoreError.noParent();
      ensureParentMutable(state, parentId);
      if (wouldCreateReferenceCycle(state, parentId, resolvedTargetId)) throw CoreError.referenceCycle();
      ensureParentCanContainChildInstance(state, parentId, resolvedTargetId, referenceId);
      current.targetId = resolvedTargetId;
      current.updatedAt = nowMs();
      this.loro.writeNode(current);
      return focus(referenceId);
    });
  }

  replaceNodeWithReference(nodeId: string, targetId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeMovable(state, nodeId);
      const resolvedTargetId = resolveReferenceTargetId(state, targetId);
      const current = clone(requiredNode(state, nodeId));
      const parentId = current.parentId;
      if (!parentId) throw CoreError.noParent();
      ensureParentMutable(state, parentId);
      if (wouldCreateReferenceCycle(state, parentId, resolvedTargetId)) throw CoreError.referenceCycle();
      if (current.id === resolvedTargetId) {
        throw CoreError.invalidOperation('cannot replace a node with a reference to itself');
      }
      ensureParentCanContainChildInstance(state, parentId, resolvedTargetId, nodeId);
      if (current.type === 'reference') {
        current.targetId = resolvedTargetId;
        current.updatedAt = nowMs();
        this.loro.writeNode(current);
        return focus(nodeId);
      }
      const index = childIndex(state, parentId, nodeId) ?? 0;
      const referenceId = freshId('ref');
      this.loro.createNodeWithId<ReferenceNode>(referenceId, parentId, index, 'reference', (node) => {
        node.targetId = resolvedTargetId;
      });
      current.trashedFromParentId = parentId;
      current.trashedFromIndex = index;
      this.loro.writeNode(current);
      this.loro.moveNode(nodeId, TRASH_ID, undefined);
      return focus(referenceId);
    });
  }

  replaceNodeWithReferenceConversion(nodeId: string, targetId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeMovable(state, nodeId);
      const resolvedTargetId = resolveReferenceTargetId(state, targetId);
      const current = clone(requiredNode(state, nodeId));
      if (current.type === 'reference') throw CoreError.invalidOperation('expected a content node');
      const parentId = current.parentId;
      if (!parentId) throw CoreError.noParent();
      ensureParentMutable(state, parentId);
      if (wouldCreateReferenceCycle(state, parentId, resolvedTargetId)) throw CoreError.referenceCycle();
      if (current.id === resolvedTargetId) {
        throw CoreError.invalidOperation('cannot replace a node with a reference to itself');
      }
      ensureParentCanContainChildInstance(state, parentId, resolvedTargetId, nodeId);
      const index = childIndex(state, parentId, nodeId) ?? 0;
      const inlineNodeId = this.createInlineReferenceNodeDirect(state, parentId, index, resolvedTargetId);
      current.trashedFromParentId = parentId;
      current.trashedFromIndex = index;
      this.loro.writeNode(current);
      this.loro.moveNode(nodeId, TRASH_ID, undefined);
      return focus(inlineNodeId, {
        parentId,
        placement: { kind: 'text-offset', offset: 0, inlineRefBias: 'after' },
      });
    });
  }

  replaceNodeWithInlineReference(nodeId: string, targetId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeMovable(state, nodeId);
      const resolvedTargetId = resolveReferenceTargetId(state, targetId);
      const current = clone(requiredNode(state, nodeId));
      if (current.type === 'reference') throw CoreError.invalidOperation('expected a content node');
      const parentId = current.parentId;
      if (!parentId) throw CoreError.noParent();
      ensureParentMutable(state, parentId);
      if (wouldCreateReferenceCycle(state, parentId, resolvedTargetId)) throw CoreError.referenceCycle();
      const index = childIndex(state, parentId, nodeId) ?? 0;
      const inlineNodeId = this.createInlineReferenceNodeDirect(state, parentId, index, resolvedTargetId);
      current.trashedFromParentId = parentId;
      current.trashedFromIndex = index;
      this.loro.writeNode(current);
      this.loro.moveNode(nodeId, TRASH_ID, undefined);
      return focus(inlineNodeId, {
        parentId,
        placement: { kind: 'text-offset', offset: 0, inlineRefBias: 'after' },
      });
    });
  }

  convertReferenceToInlineNode(referenceId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeMovable(state, referenceId);
      const reference = requiredNode(state, referenceId);
      if (reference.type !== 'reference' || !reference.targetId) {
        throw CoreError.invalidOperation('expected a reference node');
      }
      const targetId = resolveReferenceTargetId(state, reference.targetId);
      const parentId = reference.parentId;
      if (!parentId) throw CoreError.noParent();
      ensureParentMutable(state, parentId);
      const index = childIndex(state, parentId, referenceId) ?? 0;
      const inlineNodeId = this.createInlineReferenceNodeDirect(state, parentId, index, targetId);
      this.removeSubtreeDirect(referenceId);
      return focus(inlineNodeId, {
        parentId,
        placement: { kind: 'text-offset', offset: 0, inlineRefBias: 'after' },
      });
    });
  }

  restoreInlineReferenceNodeToReference(nodeId: string, targetId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeMovable(state, nodeId);
      const node = requiredNode(state, nodeId);
      const parentId = node.parentId;
      if (!parentId) throw CoreError.noParent();
      ensureParentMutable(state, parentId);
      const resolvedTargetId = resolveReferenceTargetId(state, targetId);
      if (!isOnlyInlineReference(node.content, resolvedTargetId)) {
        throw CoreError.invalidOperation('node is not an unchanged inline reference');
      }
      if (wouldCreateReferenceCycle(state, parentId, resolvedTargetId)) throw CoreError.referenceCycle();
      ensureParentCanContainChildInstance(state, parentId, resolvedTargetId, nodeId);
      const index = childIndex(state, parentId, nodeId) ?? 0;
      const referenceId = freshId('ref');
      this.loro.createNodeWithId<ReferenceNode>(referenceId, parentId, index, 'reference', (reference) => {
        reference.targetId = resolvedTargetId;
      });
      this.removeSubtreeDirect(nodeId);
      return focus(referenceId, { parentId });
    });
  }

  ensureDateNode(year: number, month: number, day: number): CommandOutcome {
    return this.mutate(() => focus(this.ensureDateNodeDirect(year, month, day)));
  }

  createSearchNode(parentId: string, index: number | null | undefined, config: SearchNodeConfig, textIndex?: TextSearchIndex): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureParentMutable(state, parentId);
      const searchId = freshId('search');
      this.loro.createNodeWithId(searchId, parentId, index, 'search', (node) => {
        node.content = plainText(normalizeSearchTitle(config.title));
      });
      this.writeSearchNodeConfigDirect(searchId, config, textIndex);
      return focus(searchId);
    });
  }

  setSearchNode(nodeId: string, config: SearchNodeConfig, textIndex?: TextSearchIndex): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeEditable(state, nodeId);
      this.writeSearchNodeConfigDirect(nodeId, config, textIndex);
      return focus(nodeId);
    });
  }

  refreshSearchNodeResults(nodeId: string, textIndex?: TextSearchIndex): CommandOutcome {
    return this.mutate(() => {
      this.materializeSearchNodeResultsDirect(nodeId, textIndex);
      return undefined;
    });
  }

  searchNodes(query: string): SearchHit[] {
    this.refreshStateFromLoro();
    const q = query.trim();
    if (!q) return [];
    const result = runSearchExpr(this.stateValue, { kind: 'rule', op: 'STRING_MATCH', text: q }, { limit: 50 });
    return result.ok ? result.hits : [];
  }

  ensureTagSearch(tagId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      const tag = requiredNode(state, tagId);
      if (tag.type !== 'tagDef') throw CoreError.invalidOperation('tag search target must be a tag');
      const existing = Object.values(state.nodes).find((node) =>
        !isInTrash(state, node.id)
        && node.type === 'search'
        && searchNodeHasSingleTagQuery(state, node.id, tagId));
      const searchId = existing?.id ?? (() => {
        const id = freshId('search');
        this.loro.createNodeWithId(id, SEARCHES_ID, undefined, 'search', (node) => {
          node.content = plainText(`Everything tagged #${tag.content.text}`);
        });
        this.writeSearchNodeConfigDirect(id, {
          title: `Everything tagged #${tag.content.text}`,
          query: { kind: 'rule', op: 'HAS_TAG', tagDefId: tagId },
        });
        return id;
      })();
      if (existing) this.materializeSearchNodeResultsDirect(searchId);
      return focus(searchId);
    });
  }

  backlinks(targetId: string): Backlink[] {
    this.refreshStateFromLoro();
    const result: Backlink[] = [];
    for (const node of Object.values(this.stateValue.nodes)) {
      if (isInTrash(this.stateValue, node.id)) continue;
      if (node.type === 'reference' && refRoleCountsAsBacklink(node) && node.targetId === targetId && node.parentId) {
        result.push({ sourceId: node.parentId, referenceId: node.id, kind: 'tree' });
      }
      for (const inlineRef of node.content.inlineRefs) {
        if (inlineRefNodeId(inlineRef) === targetId) {
          result.push({ sourceId: node.id, referenceId: node.id, kind: 'inline' });
        }
      }
    }
    return result;
  }

  undo(): CommandOutcome {
    return { projection: this.applyOperationHistory('undo', 'all', 1).projection! };
  }

  redo(): CommandOutcome {
    return { projection: this.applyOperationHistory('redo', 'all', 1).projection! };
  }

  undoAgent(): CommandOutcome {
    return { projection: this.applyOperationHistory('undo', 'agent', 1).projection! };
  }

  redoAgent(): CommandOutcome {
    return { projection: this.applyOperationHistory('redo', 'agent', 1).projection! };
  }

  undoUser(): CommandOutcome {
    return { projection: this.applyOperationHistory('undo', 'user', 1).projection! };
  }

  redoUser(): CommandOutcome {
    return { projection: this.applyOperationHistory('redo', 'user', 1).projection! };
  }

  operationHistory(query: OperationHistoryQuery = {}): OperationHistoryResult {
    if (query.action === 'undo' || query.action === 'redo') {
      return this.applyOperationHistory(query.action, query.origin ?? 'agent', query.steps ?? 1, query.operationId);
    }

    const origin = query.origin ?? 'all';
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.max(1, Math.min(query.limit ?? 20, 100));
    return this.history.list({
      origin,
      offset,
      limit,
    }, this.operationStackState(origin));
  }

  withOrigin<T>(origin: CommitOrigin, fn: () => T, metadata: CoreTransactionMetadata = {}): T {
    this.commitOriginStack.push(commitOriginFor(origin));
    this.commitMetadataStack.push(metadata);
    try {
      return fn();
    } finally {
      this.commitMetadataStack.pop();
      this.commitOriginStack.pop();
    }
  }

  // A patch may mutate the node in place (return void) or return a replacement
  // node — the latter is how a type-changing patch rebuilds a different variant
  // instead of mutating the discriminant in place.
  private patchNode(nodeId: string, patch: (node: Node) => Node | void): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeEditable(state, nodeId);
      const node = clone(requiredNode(state, nodeId));
      const patched = patch(node) ?? node;
      patched.updatedAt = nowMs();
      this.loro.writeNode(patched);
      return focus(nodeId);
    });
  }

  private patchNodeAppearance(nodeId: string, patch: (node: Node) => void): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      const node = clone(requiredNode(state, nodeId));
      patch(node);
      node.updatedAt = nowMs();
      this.loro.writeNode(node);
      return focus(nodeId);
    });
  }

  private ensureViewDefDirect(nodeId: string): NodeId {
    const state = this.snapshot();
    requiredNode(state, nodeId);
    const existing = state.nodes[nodeId]?.children
      .map((childId) => state.nodes[childId])
      .find((child): child is Node => child?.type === 'viewDef');
    if (existing) return existing.id;
    const viewDefId = freshId('view');
    this.loro.createNodeWithId<ViewDefNode>(viewDefId, nodeId, 0, 'viewDef', (node) => {
      node.viewMode = 'list';
      node.toolbarVisible = false;
    });
    return viewDefId;
  }

  private patchViewDefDirect(nodeId: string, patch: (viewDef: ViewDefNode) => void) {
    const viewDefId = this.ensureViewDefDirect(nodeId);
    const state = this.snapshot();
    const viewDef = clone(requiredNode(state, viewDefId));
    if (viewDef.type !== 'viewDef') throw CoreError.invalidOperation('expected a view definition');
    patch(viewDef);
    viewDef.updatedAt = nowMs();
    this.loro.writeNode(viewDef);
  }

  private viewDefChildren(state: DocumentState, nodeId: string, type: NodeType): Node[] {
    const viewDef = state.nodes[nodeId]?.children
      .map((childId) => state.nodes[childId])
      .find((child): child is Node => child?.type === 'viewDef');
    if (!viewDef) return [];
    return viewDef.children
      .map((childId) => state.nodes[childId])
      .filter((child): child is Node => child?.type === type);
  }

  private mutate(mutator: Mutator): CommandOutcome {
    if (this.activeTransaction) {
      const focusHint = mutator();
      return { projection: this.freshProjection(), ...(focusHint ? { focus: focusHint } : {}) };
    }

    const before = this.loro.materializeState();
    this.loro.clearTouchedNodeIds();
    const focusHint = mutator();
    const after = this.loro.materializeState();
    const affectedNodeIds = this.loro.drainTouchedNodeIds();
    // Exact change detection at O(touched): a node is changed iff its pre/post
    // materialization differs. This preserves the prior whole-state `sameJson`
    // semantics (idempotent writes that touch but don't change are not commits)
    // without stringifying the entire document.
    if (changedTouchedNodes(affectedNodeIds, before, after)) {
      this.commitCurrentTransaction(this.currentCommitOrigin(), before, after, this.currentCommitMetadata(), affectedNodeIds);
      this.patchProjectionCache(affectedNodeIds, after);
      this.bumpRevision(affectedNodeIds, false);
      this.verifyCaches();
    }
    this.stateValue = after;
    return { projection: this.projection(), ...(focusHint ? { focus: focusHint } : {}) };
  }

  private currentTodayNodeId(): string {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth() + 1;
    const day = today.getDate();
    return this.findDateNodeId(year, month, day) ?? DAILY_NOTES_ID;
  }

  private ensureCurrentTodayNodeDirect(): string {
    const today = new Date();
    return this.ensureDateNodeDirect(today.getFullYear(), today.getMonth() + 1, today.getDate());
  }

  private refreshStateFromLoro() {
    // The id→TreeID map is now maintained incrementally and rebuilt lazily on
    // demand, so no explicit rebuild is needed here. materializeState is a cheap
    // cache read.
    this.stateValue = this.loro.materializeState();
  }

  private bumpRevision(changedNodeIds: readonly string[], requiresFullSearchRebuild: boolean) {
    this.revisionValue += 1;
    this.lastRevisionDelta = {
      revision: this.revisionValue,
      changedNodeIds: uniqueNodeIds([...changedNodeIds]),
      requiresFullSearchRebuild,
    };
  }

  private commitCurrentTransaction(
    origin: string,
    before: DocumentState,
    after: DocumentState,
    metadata: CoreTransactionMetadata = {},
    affectedNodeIds?: string[],
  ) {
    const entry = this.history.createEntry(origin, metadata, before, after, affectedNodeIds);
    this.loro.commit(origin, entry);
    if (entry) {
      this.history.record(entry);
      this.loro.clearRedo();
    }
  }

  private currentCommitOrigin() {
    return this.commitOriginStack[this.commitOriginStack.length - 1] ?? DEFAULT_COMMIT_ORIGIN;
  }

  private currentCommitMetadata() {
    return this.commitMetadataStack[this.commitMetadataStack.length - 1] ?? {};
  }

  private applyOperationHistory(
    action: 'undo' | 'redo',
    origin: OperationHistoryScope,
    steps: number,
    operationId?: string,
  ): OperationHistoryResult {
    const undoing = action === 'undo';
    const changed: OperationHistoryItem[] = [];
    const requestedSteps = Math.max(1, Math.min(steps, 10));

    for (let index = 0; index < requestedSteps; index += 1) {
      const stackBefore = this.operationStackState(origin);
      const entry = undoing ? stackBefore.topUndo : stackBefore.topRedo;
      if (index === 0 && operationId && entry?.operationId !== operationId) break;
      const before = this.loro.materializeState();
      this.loro.commit(`system:flush-before-${origin}-${action}`);
      const ok = undoing ? this.loro.undo(origin) : this.loro.redo(origin);
      if (!ok) break;
      const after = this.loro.materializeState();
      if (sameJson(before, after)) break;
      const stackAfter = this.operationStackState(origin);
      changed.push(decorateHistoryItem(entry ?? synthesizeHistoryEntry(action, origin, before, after), stackAfter));
    }

    if (changed.length > 0) this.bumpRevision([], true);
    // Undo/redo rewrites the tree without per-node touch tracking, so the
    // incremental caches cannot be patched — rebuild them from scratch.
    this.invalidateProjectionCache();
    this.refreshStateFromLoro();
    const stackState = stackStateResult(this.operationStackState(origin));
    return {
      action,
      historyMode: 'undo_stack',
      count: changed.length,
      undone: undoing ? changed : undefined,
      redone: undoing ? undefined : changed,
      canUndo: stackState.canUndo,
      canRedo: stackState.canRedo,
      cursor: stackState.cursor,
      projection: this.projection(),
    };
  }

  private operationStackState(origin: OperationHistoryScope): OperationStackState {
    return {
      canUndo: this.loro.canUndo(origin),
      canRedo: this.loro.canRedo(origin),
      topUndo: operationHistoryEntryFromValue(this.loro.topUndoValue(origin)),
      topRedo: operationHistoryEntryFromValue(this.loro.topRedoValue(origin)),
    };
  }

  private snapshot() {
    return this.loro.materializeState();
  }

  private nodeSnapshot(nodeId: string) {
    return requiredNode(this.snapshot(), nodeId);
  }

  private patchNodeData(nodeId: string, patch: (node: Node, state: DocumentState) => void) {
    const state = this.snapshot();
    const node = clone(requiredNode(state, nodeId));
    patch(node, state);
    node.updatedAt = nowMs();
    this.loro.writeNode(node);
  }

  private writeSearchNodeConfigDirect(nodeId: string, config: SearchNodeConfig, textIndex?: TextSearchIndex) {
    const state = this.snapshot();
    const existing = clone(requiredNode(state, nodeId));
    // Rebuild as a search node with its inline query cleared (the query lives in
    // child queryCondition nodes); reconstructing avoids mutating the discriminant.
    const node: SearchNode = {
      ...existing,
      type: 'search',
      content: plainText(normalizeSearchTitle(config.title)),
      queryOp: undefined,
      queryLogic: undefined,
      queryTagDefId: undefined,
      queryFieldDefId: undefined,
      updatedAt: nowMs(),
    };
    this.loro.writeNode(node);

    const latest = this.snapshot();
    for (const childId of [...latest.nodes[nodeId]?.children ?? []]) {
      if (latest.nodes[childId]?.type === 'queryCondition') this.removeSubtreeDirect(childId);
    }
    this.createSearchQueryConditionDirect(nodeId, config.query, 0);
    this.materializeSearchNodeResultsDirect(nodeId, textIndex);
  }

  private materializeSearchNodeResultsDirect(nodeId: string, textIndex?: TextSearchIndex) {
    const state = this.snapshot();
    const searchNode = requiredNode(state, nodeId);
    if (searchNode.type !== 'search') throw CoreError.invalidOperation('expected a search node');

    const result = searchNodeHasRules(state, nodeId)
      ? runSearchNode(state, nodeId, { textIndex })
      : { ok: true, hits: [] } as const;
    if (!result.ok) throw CoreError.invalidOperation(result.issue.message);

    const hits = uniqueNodeIds(result.hits.map((hit) => hit.nodeId))
      .filter((targetId) =>
        state.nodes[targetId]
        && !isInTrash(state, targetId)
        && !wouldCreateReferenceCycle(state, nodeId, targetId));
    const matchedIds = new Set(hits);
    const existingRefs = new Map<NodeId, NodeId>();
    for (const childId of [...searchNode.children]) {
      const child = state.nodes[childId];
      if (child?.type !== 'reference' || !child.targetId) continue;
      if (existingRefs.has(child.targetId)) {
        this.removeSubtreeDirect(childId);
      } else {
        existingRefs.set(child.targetId, childId);
      }
    }

    for (const [targetId, refId] of existingRefs) {
      if (!matchedIds.has(targetId)) this.removeSubtreeDirect(refId);
    }

    const refreshedState = this.snapshot();
    for (const targetId of hits) {
      if (existingRefs.has(targetId)) continue;
      if (!refreshedState.nodes[targetId]) continue;
      this.loro.createNodeWithId<ReferenceNode>(freshId('ref'), nodeId, undefined, 'reference', (node) => {
        node.targetId = targetId;
        // Result refs are internal pointers, not user-authored links — keep them
        // out of the backlink graph (refRoleOf treats an absent role as 'link').
        node.refRole = 'searchResult';
      });
    }

    const latest = this.snapshot();
    const latestSearchNode = requiredNode(latest, nodeId);
    const resultRefIds = hits.flatMap((targetId): NodeId[] => {
      const refId = latestSearchNode.children.find((childId) => latest.nodes[childId]?.type === 'reference'
        && latest.nodes[childId]?.targetId === targetId);
      return refId ? [refId] : [];
    });
    const queryConditionIds = latestSearchNode.children.filter((childId) => latest.nodes[childId]?.type === 'queryCondition');
    const generatedIds = new Set([...queryConditionIds, ...resultRefIds]);
    const otherChildIds = latestSearchNode.children.filter((childId) => !generatedIds.has(childId));
    reorderDirectChildren(this.loro, latestSearchNode, [...queryConditionIds, ...resultRefIds, ...otherChildIds]);
  }

  private createSearchQueryConditionDirect(parentId: string, query: SearchQueryExpr, index?: number | null) {
    const state = this.snapshot();
    const conditionId = freshId('condition');
    this.loro.createNodeWithId<QueryConditionNode>(conditionId, parentId, index, 'queryCondition', (node) => {
      if (query.kind === 'group') {
        node.queryLogic = query.logic;
        node.content = plainText(query.logic);
      } else {
        node.queryOp = query.op;
        node.content = plainText(query.text ?? searchRuleTitle(state, query));
        if (query.fieldDefId) node.queryFieldDefId = query.fieldDefId;
        if (query.tagDefId) node.queryTagDefId = query.tagDefId;
        if (query.targetId) node.queryTargetId = query.targetId;
      }
    });
    if (query.kind === 'group') {
      for (const child of query.children) this.createSearchQueryConditionDirect(conditionId, child);
    } else {
      for (const operand of query.operands ?? []) this.createSearchQueryOperandDirect(conditionId, operand);
    }
  }

  private createSearchQueryOperandDirect(parentId: string, operand: SearchQueryOperand) {
    const targetId = operand.targetId;
    if (targetId) {
      this.loro.createNodeWithId<ReferenceNode>(freshId('ref'), parentId, undefined, 'reference', (node) => {
        node.content = plainText(operand.text ?? '');
        node.targetId = targetId;
      });
    } else {
      this.loro.createNodeWithId(freshId('operand'), parentId, undefined, undefined, (node) => {
        node.content = plainText(operand.text ?? '');
      });
    }
  }

  private ensureSystemNodesDirect() {
    const now = nowMs();
    // The workspace root title is user-editable (so people can name their own
    // workspace); it stays structurally fixed via isSystemId in ensureNodeMovable,
    // so move/delete/reparent remain blocked even though locked is false. The
    // functional sections below stay locked (read-only titles).
    this.ensureSystemNodeDirect(WORKSPACE_ID, undefined, undefined, 'Tenon', false, now, ['Lin Outliner']);
    this.ensureSystemNodeDirect(DAILY_NOTES_ID, undefined, WORKSPACE_ID, 'Daily notes', true, now);
    this.ensureSystemNodeDirect(LIBRARY_ID, undefined, WORKSPACE_ID, 'Library', true, now);
    this.ensureSystemNodeDirect(SCHEMA_ID, undefined, WORKSPACE_ID, 'Schema', true, now);
    this.ensureSystemNodeDirect(SEARCHES_ID, undefined, WORKSPACE_ID, 'Saved searches', true, now);
    this.ensureSystemNodeDirect(RECENTS_ID, 'search', SEARCHES_ID, 'Recents', true, now);
    this.ensureSystemNodeDirect(TRASH_ID, undefined, WORKSPACE_ID, 'Trash', true, now);
    this.ensureSystemNodeDirect(SETTINGS_ID, undefined, WORKSPACE_ID, 'Settings', true, now);
    this.ensureSystemNodeDirect(TAG_DAY_ID, 'tagDef', SCHEMA_ID, 'day', true, now);
    this.ensureSystemNodeDirect(TAG_WEEK_ID, 'tagDef', SCHEMA_ID, 'week', true, now);
    this.ensureSystemNodeDirect(TAG_YEAR_ID, 'tagDef', SCHEMA_ID, 'year', true, now);
    // Persist the canonical root child order into the tree. Materialization now
    // reflects the tree verbatim (no read-time re-ordering), so every system node
    // must be placed here, matching the historical projection order.
    [DAILY_NOTES_ID, LIBRARY_ID, SCHEMA_ID, SEARCHES_ID, TRASH_ID, SETTINGS_ID].forEach((id, index) => {
      this.loro.moveNode(id, WORKSPACE_ID, index);
    });
    this.loro.moveNode(RECENTS_ID, SEARCHES_ID, 0);
    [TAG_DAY_ID, TAG_WEEK_ID, TAG_YEAR_ID].forEach((id, index) => {
      this.loro.moveNode(id, SCHEMA_ID, index);
    });
    this.ensureSystemOptionNodesDirect();
    this.migrateLegacyParaRootNodesDirect();
    this.ensureRecentsSearchDirect();
    this.moveLegacyWorkspaceNodesToLibraryDirect();
  }

  private ensureRecentsSearchDirect() {
    const state = this.snapshot();
    const recents = state.nodes[RECENTS_ID];
    if (!recents) return;
    const queryCondition = recents.children
      .map((childId) => state.nodes[childId])
      .find((node): node is QueryConditionNode => node?.type === 'queryCondition');
    const viewDef = recents.children
      .map((childId) => state.nodes[childId])
      .find((node): node is ViewDefNode => node?.type === 'viewDef');
    const sortRule = viewDef?.children
      .map((childId) => state.nodes[childId])
      .find((node): node is SortRuleNode => node?.type === 'sortRule');
    const alreadyConfigured = recents.type === 'search'
      && recents.content.text === 'Recents'
      && viewDef?.viewMode === 'list'
      && sortRule?.sortField === 'sys:updatedAt'
      && sortRule.sortDirection === 'desc'
      && queryCondition?.queryOp === 'EDITED_LAST_DAYS'
      && queryCondition.content.text === '30';
    if (alreadyConfigured) return;
    this.writeSearchNodeConfigDirect(RECENTS_ID, {
      title: 'Recents',
      query: { kind: 'rule', op: 'EDITED_LAST_DAYS', text: '30' },
    });
    this.patchViewDefDirect(RECENTS_ID, (node) => {
      node.viewMode = 'list';
    });
    const latest = this.snapshot();
    for (const rule of this.viewDefChildren(latest, RECENTS_ID, 'sortRule')) this.removeSubtreeDirect(rule.id);
    const viewDefId = this.ensureViewDefDirect(RECENTS_ID);
    this.loro.createNodeWithId<SortRuleNode>(freshId('sort'), viewDefId, undefined, 'sortRule', (node) => {
      node.sortField = 'sys:updatedAt';
      node.sortDirection = 'desc';
    });
  }

  private moveLegacyWorkspaceNodesToLibraryDirect() {
    const state = this.snapshot();
    const root = state.nodes[WORKSPACE_ID];
    if (!root || !state.nodes[LIBRARY_ID]) return;
    const systemRootIds = new Set([
      LIBRARY_ID,
      DAILY_NOTES_ID,
      SCHEMA_ID,
      SEARCHES_ID,
      RECENTS_ID,
      TRASH_ID,
      SETTINGS_ID,
    ]);
    for (const childId of [...root.children]) {
      if (systemRootIds.has(childId)) continue;
      if (state.nodes[childId]) this.loro.moveNode(childId, LIBRARY_ID, undefined);
    }
  }

  private migrateLegacyParaRootNodesDirect() {
    for (const [id, title] of LEGACY_PARA_NODE_NAMES) {
      if (!this.loro.hasNode(id)) continue;
      const state = this.snapshot();
      const node = state.nodes[id];
      if (!node) continue;
      if (isDisposableLegacyParaNode(node, title)) {
        this.loro.deleteNode(id);
        continue;
      }
      const migrated = clone(node);
      migrated.locked = false;
      this.loro.writeNode(migrated);
      this.loro.moveNode(id, LIBRARY_ID, undefined);
    }
  }

  private ensureSystemNodeDirect(
    id: string,
    type: NodeType | undefined,
    parentId: string | undefined,
    name: string,
    locked: boolean,
    now: number,
    legacyNames: readonly string[] = [],
  ) {
    const existingTreeNode = this.loro.hasNode(id);
    if (!existingTreeNode) {
      this.loro.createNodeWithId(id, parentId, undefined, type, (node) => {
        node.content = plainText(name);
        node.locked = locked;
        node.createdAt = now;
        node.updatedAt = now;
      });
      return;
    }
    const state = this.snapshot();
    const node = clone(requiredNode(state, id));
    node.type = type;
    if (!node.content.text || legacyNames.includes(node.content.text)) node.content = plainText(name);
    node.locked = locked;
    node.updatedAt = node.updatedAt || now;
    this.loro.writeNode(node);
    if (parentId && node.parentId !== parentId) this.loro.moveNode(id, parentId, undefined);
  }

  // config-as-nodes Stage 4: idempotently seed the system enum option subtrees
  // under SCHEMA_ID. Enum config values are references to these `systemOption`
  // nodes (stable derived ids), so an invalid enum value is unrepresentable.
  // They are `systemOption`-typed, hence excluded from outliner/search/agent/
  // sidebar by isInternalConfigNode, but remain in the projection so config
  // rows can resolve the selected value's label.
  private ensureSystemOptionNodesDirect() {
    const now = nowMs();
    for (const [key, domain] of Object.entries(ENUM_DOMAINS)) {
      this.ensureSystemNodeDirect(domain.subtreeId, 'systemOption', SCHEMA_ID, key, true, now);
      domain.values.forEach((value, index) => {
        const optionId = systemOptionNodeId(domain.subtreeId, value);
        this.ensureSystemNodeDirect(optionId, 'systemOption', domain.subtreeId, value, true, now);
        this.loro.moveNode(optionId, domain.subtreeId, index);
      });
    }
  }

  // config-as-nodes Stage 4: materialize the fixed `defConfig` row set for a
  // definition (tag or field) as a leading internal segment, in registry order.
  // Stable ids (defConfigNodeId) make this idempotent and let setConfigValue
  // address a row without scanning. Rows are locked; values live as children.
  private reconcileConfigSubtreeDirect(defId: string) {
    const state = this.snapshot();
    const def = requiredNode(state, defId);
    const keys = configKeysForDefType(def.type);
    if (!keys) return;
    const now = nowMs();
    keys.forEach((key, index) => {
      const rowId = defConfigNodeId(defId, key);
      if (this.loro.hasNode(rowId)) {
        this.loro.moveNode(rowId, defId, index);
        return;
      }
      this.loro.createNodeWithId<DefConfigNode>(rowId, defId, index, 'defConfig', (node) => {
        node.configKey = key;
        node.content = plainText(CONFIG_SCHEMA[key].label);
        node.locked = true;
        node.createdAt = now;
        node.updatedAt = now;
      });
    });
  }

  private setConfigValueDirect(defId: string, input: SetConfigValueInput) {
    const def = requiredNode(this.snapshot(), defId);
    const schema = CONFIG_SCHEMA[input.configKey];
    if (!schema) throw CoreError.invalidOperation(`unknown config key: ${input.configKey}`);
    const expectedKind = configValueKind(input.configKey);
    if (expectedKind !== input.kind) {
      throw CoreError.invalidOperation(`config key ${input.configKey} expects a ${expectedKind} value`);
    }
    const allowedKeys = configKeysForDefType(def.type);
    if (!allowedKeys || !allowedKeys.includes(input.configKey)) {
      throw CoreError.invalidOperation(`config key ${input.configKey} does not apply to this definition`);
    }
    const rowId = this.ensureConfigRowDirect(defId, input.configKey);
    this.clearConfigValueChildrenDirect(rowId);

    switch (input.kind) {
      case 'scalar': {
        if (input.text == null || input.text.trim() === '') break;
        const result = canonicalizeScalar(schema.domain, input.text);
        if ('error' in result) throw CoreError.invalidOperation(result.error);
        this.createConfigValueNodeDirect(rowId, result.text, undefined, undefined);
        break;
      }
      case 'ref': {
        if (input.targetId == null) break;
        requiredNode(this.snapshot(), input.targetId);
        this.createConfigValueNodeDirect(rowId, '', 'config', input.targetId);
        break;
      }
      case 'refList': {
        for (const targetId of input.targetIds) {
          requiredNode(this.snapshot(), targetId);
          this.createConfigValueNodeDirect(rowId, '', 'config', targetId);
        }
        break;
      }
      case 'enum': {
        if (input.value == null) break;
        const optionId = this.resolveEnumOption(input.configKey, input.value);
        this.createConfigValueNodeDirect(rowId, '', 'enum', optionId);
        break;
      }
      case 'enumList': {
        for (const value of input.values) {
          const optionId = this.resolveEnumOption(input.configKey, value);
          this.createConfigValueNodeDirect(rowId, '', 'enum', optionId);
        }
        break;
      }
    }
  }

  private ensureConfigRowDirect(defId: string, configKey: DefConfigKey): string {
    const rowId = defConfigNodeId(defId, configKey);
    if (!this.loro.hasNode(rowId)) {
      const now = nowMs();
      this.loro.createNodeWithId<DefConfigNode>(rowId, defId, 0, 'defConfig', (node) => {
        node.configKey = configKey;
        node.content = plainText(CONFIG_SCHEMA[configKey].label);
        node.locked = true;
        node.createdAt = now;
        node.updatedAt = now;
      });
    }
    return rowId;
  }

  private clearConfigValueChildrenDirect(rowId: string) {
    const row = requiredNode(this.snapshot(), rowId);
    for (const childId of [...row.children]) this.loro.deleteNode(childId);
  }

  private createConfigValueNodeDirect(rowId: string, text: string, refRole: RefRole | undefined, targetId: string | undefined) {
    const now = nowMs();
    if (targetId) {
      const id = freshId('ref');
      this.loro.createNodeWithId<ReferenceNode>(id, rowId, undefined, 'reference', (node) => {
        node.content = plainText(text);
        if (refRole) node.refRole = refRole;
        node.targetId = targetId;
        node.createdAt = now;
        node.updatedAt = now;
      });
      return id;
    }
    const id = freshId('node');
    this.loro.createNodeWithId(id, rowId, undefined, undefined, (node) => {
      node.content = plainText(text);
      node.createdAt = now;
      node.updatedAt = now;
    });
    return id;
  }

  private resolveEnumOption(configKey: DefConfigKey, value: string): string {
    const domainKey = CONFIG_SCHEMA[configKey].enumDomain;
    if (!domainKey) throw CoreError.invalidOperation(`config key ${configKey} has no enum domain`);
    const domain = ENUM_DOMAINS[domainKey];
    if (!(domain.values as readonly string[]).includes(value)) {
      throw CoreError.invalidOperation(`invalid ${configKey} value: ${value}`);
    }
    return systemOptionNodeId(domain.subtreeId, value);
  }

  private createPlainNode(
    parentId: string,
    index: number | null | undefined,
    text: string,
    type?: NodeType,
    id?: string,
  ) {
    const nodeId = id ?? freshId(type === 'reference' ? 'ref' : type === 'fieldEntry' ? 'field_entry' : 'node');
    this.loro.createNodeWithId(nodeId, parentId, index, type, (node) => {
      node.content = plainText(text);
    });
    return nodeId;
  }

  private createRichTextNodeDirect(parentId: string, index: number | null | undefined, content: RichText, type?: NodeType) {
    const id = freshId(type === 'reference' ? 'ref' : type === 'fieldEntry' ? 'field_entry' : 'node');
    this.loro.createNodeWithId(id, parentId, index, type, (node) => {
      node.content = clone(content);
    });
    return id;
  }

  private createInlineReferenceNodeDirect(
    state: DocumentState,
    parentId: string,
    index: number | null | undefined,
    targetId: string,
  ) {
    const target = requiredNode(state, targetId);
    return this.createRichTextNodeDirect(parentId, index, {
      text: '',
      marks: [],
      inlineRefs: [{
        offset: 0,
        target: nodeReferenceTarget(targetId),
        displayName: target.content.text || undefined,
      }],
    });
  }

  private createTagDefDirect(name: string) {
    const id = freshId('tag');
    const color = nextTagColor(this.snapshot());
    this.loro.createNodeWithId(id, SCHEMA_ID, undefined, 'tagDef', (node) => {
      node.content = plainText(name);
    });
    // config-as-nodes: the round-robin auto color lives in the defConfig subtree.
    this.setConfigValueDirect(id, { kind: 'scalar', configKey: 'color', text: color });
    return id;
  }

  private insertNodeTreeDirect(parentId: string, tree: CreateNodeTree, index?: number | null): string {
    const id = freshId('node');
    // Paste trees may carry a node type; only `codeBlock` is honored so the
    // materialization surface stays narrow and predictable.
    const type = tree.type === 'codeBlock' ? 'codeBlock' : undefined;
    const completedAt = pasteCompletedAt(tree);
    this.loro.createNodeWithId(id, parentId, index, type, (node) => {
      node.content = clone(tree.content);
      if (type === 'codeBlock') {
        (node as CodeBlockNode).codeLanguage = normalizeCodeLanguage(tree.codeLanguage) || undefined;
      }
      if (completedAt !== undefined) node.completedAt = completedAt;
    });
    this.applyChildTagsDirect(parentId, id);
    this.applyPasteMetadataDirect(id, tree.tags, tree.fields);
    for (const child of tree.children) this.insertNodeTreeDirect(id, child);
    return id;
  }

  private insertFieldDefNodeDirect(parentId: string, name: string, fieldType: FieldType) {
    const id = freshId('field');
    this.loro.createNodeWithId(id, parentId, undefined, 'fieldDef', (node) => {
      node.content = plainText(name);
    });
    // config-as-nodes: fieldType lives in the defConfig subtree, not a flat field.
    this.setConfigValueDirect(id, { kind: 'enum', configKey: 'fieldType', value: fieldType });
    return id;
  }

  private insertFieldEntryNodeDirect(parentId: string, index: number | null | undefined, fieldDefId: string) {
    const id = freshId('field_entry');
    this.loro.createNodeWithId<FieldEntryNode>(id, parentId, index, 'fieldEntry', (node) => {
      node.fieldDefId = fieldDefId;
      node.content = plainText('');
    });
    return id;
  }

  // Apply `#tag` / `name:: value` metadata harvested from a paste onto a node.
  // The parser runs in the renderer without state, so it emits names; here we
  // own the state and do find-or-create (PM decision 2026-06-04: auto-create to
  // match nodex). Tag/field syntax itself is recognized renderer-side and today
  // diverges from `agentOutlineParser` (ASCII vs Unicode `#tag`); unifying the
  // two on one canonical grammar is docs/plans/outline-syntax-unification.md.
  private applyPasteMetadataDirect(
    nodeId: string,
    tags: string[] | undefined,
    fields: ParsedPasteField[] | undefined,
  ): void {
    for (const rawName of tags ?? []) {
      const name = rawName.trim();
      if (!name) continue;
      const tagId = findTagByName(this.snapshot(), name) ?? this.createTagDefDirect(name);
      this.applyTagNoHistoryDirect(nodeId, tagId);
    }
    for (const field of fields ?? []) {
      const name = field.name.trim();
      const value = field.value.trim();
      if (!name || !value) continue;
      const fieldDefId = findFieldDefByName(this.snapshot(), name)
        ?? this.insertFieldDefNodeDirect(SCHEMA_ID, name, 'plain');
      const entryId = this.reuseOrCreateFieldEntryDirect(nodeId, fieldDefId);
      // An existing `options` field find-or-creates+selects the option (smart
      // select); every other type (incl. a freshly created `plain` field) stores
      // the value as a plain content child, the same shape free-text values use.
      if (fieldTypeOf(this.snapshot(), fieldDefId) === 'options') {
        const optionId = this.ensureOptionNodeDirect(fieldDefId, value);
        this.selectFieldOptionDirect(entryId, fieldDefId, optionId);
      } else {
        // Fill an empty value child a reused entry (e.g. a tag template's) already
        // owns, instead of stacking a second value beside it; create one only when
        // there is no empty slot to reuse.
        const emptySlot = this.snapshot().nodes[entryId]?.children.find((childId) => {
          const child = this.snapshot().nodes[childId];
          return child?.type === undefined && child.content.text.trim().length === 0;
        });
        if (emptySlot) {
          this.patchNodeData(emptySlot, (node) => { node.content = plainText(value); });
        } else {
          this.loro.createNodeWithId(freshId('value'), entryId, undefined, undefined, (node) => {
            node.content = plainText(value);
          });
        }
      }
    }
  }

  // Reuse a field entry the node already owns for this def (e.g. one a tag
  // template just instantiated) so a pasted `field::` fills it instead of
  // stacking a second empty entry; otherwise create one.
  private reuseOrCreateFieldEntryDirect(nodeId: string, fieldDefId: string): string {
    const state = this.snapshot();
    const existing = state.nodes[nodeId]?.children.find((childId) => {
      const child = state.nodes[childId];
      return child?.type === 'fieldEntry' && child.fieldDefId === fieldDefId;
    });
    return existing ?? this.insertFieldEntryNodeDirect(nodeId, undefined, fieldDefId);
  }

  private touchNodeDirect(nodeId: string) {
    if (!this.loro.hasNode(nodeId)) return;
    this.patchNodeData(nodeId, (node) => {
      node.updatedAt = nowMs();
    });
  }

  private removeSubtreeDirect(nodeId: string) {
    const state = this.snapshot();
    if (isSystemId(nodeId)) throw CoreError.lockedNode(nodeId);
    requiredNode(state, nodeId);
    const removedIds = collectSubtreeAndDependentReferences(state, nodeId);
    for (const rootId of removalRootIds(state, removedIds)) {
      this.loro.deleteNode(rootId);
    }
    for (const other of Object.values(state.nodes)) {
      if (removedIds.has(other.id)) continue;
      const next = clone(other);
      const before = JSON.stringify(next);
      next.tags = next.tags.filter((id) => !removedIds.has(id));
      if (next.type === 'reference' && next.targetId && removedIds.has(next.targetId)) delete next.targetId;
      if ((next.type === 'search' || next.type === 'queryCondition') && next.queryTargetId && removedIds.has(next.queryTargetId)) {
        delete next.queryTargetId;
      }
      next.content.inlineRefs = next.content.inlineRefs.filter((ref) => {
        const nodeId = inlineRefNodeId(ref);
        return !nodeId || !removedIds.has(nodeId);
      });
      if (JSON.stringify(next) !== before && this.loro.hasNode(next.id)) this.loro.writeNode(next);
    }
    this.loro.rebuildMappings();
  }

  private trashNodeDirect(nodeId: string) {
    const state = this.snapshot();
    ensureNodeMovable(state, nodeId);
    if (nodeId === TRASH_ID) throw CoreError.invalidOperation('cannot trash Trash');
    const node = clone(requiredNode(state, nodeId));
    if (!node.parentId) throw CoreError.noParent();
    node.trashedFromParentId = node.parentId;
    node.trashedFromIndex = childIndex(state, node.parentId, nodeId) ?? 0;
    this.loro.writeNode(node);
    this.loro.moveNode(nodeId, TRASH_ID, undefined);
  }

  private cloneSubtreeDirect(sourceId: string, parentId: string, index: number | undefined): string {
    const state = this.snapshot();
    const source = clone(requiredNode(state, sourceId));
    const sourceChildren = [...source.children];
    // A defConfig row is addressed by the stable id defConfigNodeId(parent, key);
    // cloning it under a fresh id would orphan it from ensureConfigRowDirect, so a
    // later edit on the copy creates a *second* row that configRowsByKey shadows.
    const clonedId = source.type === 'defConfig' && source.configKey
      ? defConfigNodeId(parentId, source.configKey)
      : freshId('copy');
    this.loro.createNodeWithId(clonedId, parentId, index, source.type, (node) => {
      const createdAt = node.createdAt;
      Object.assign(node, source);
      node.id = clonedId;
      node.parentId = parentId;
      node.children = [];
      node.createdAt = createdAt;
      node.updatedAt = createdAt;
      delete node.trashedFromParentId;
      delete node.trashedFromIndex;
    });
    for (const childId of sourceChildren) this.cloneSubtreeDirect(childId, clonedId, undefined);
    return clonedId;
  }

  private applyChildTagsDirect(parentId: string, childId: string) {
    const state = this.snapshot();
    const tagIds = state.nodes[parentId]?.tags ?? [];
    for (const tagId of tagIds) {
      const childSupertag = configRefTarget(state, tagId, 'childSupertag');
      if (childSupertag) this.applyTagDirect(childId, childSupertag);
    }
  }

  private applyTagDirect(nodeId: string, tagId: string) {
    const state = this.snapshot();
    ensureNodeEditable(state, nodeId);
    this.applyTagNoHistoryDirect(nodeId, tagId);
  }

  private applyTagNoHistoryDirect(nodeId: string, tagId: string) {
    const state = this.snapshot();
    if (state.nodes[tagId]?.type !== 'tagDef') throw CoreError.nodeNotFound(tagId);
    const node = clone(requiredNode(state, nodeId));
    if (node.tags.includes(tagId)) return;
    node.tags.push(tagId);
    node.updatedAt = nowMs();
    this.loro.writeNode(node);
    this.instantiateTagTemplateDirect(nodeId, tagId);
  }

  private instantiateTagTemplateDirect(nodeId: string, tagId: string) {
    const state = this.snapshot();
    for (const chainTagId of getExtendsChain(state, tagId)) {
      for (const fieldRef of getTemplateFieldDefs(state, chainTagId)) {
        this.ensureFieldEntryWithTemplateDirect(nodeId, fieldRef.fieldDefId, fieldRef.templateOriginId, true);
      }
    }
    // Default content is inherited along the extends chain too (Tana parity:
    // template objects are inherited wholesale, not just fields). Ancestor-first
    // so a base tag's content precedes the more specific tag's; dedup by
    // templateId keeps re-application idempotent.
    for (const chainTagId of [...getExtendsChain(state, tagId)].reverse()) {
      for (const templateNodeId of getTemplateContentNodes(state, chainTagId)) {
        this.cloneTemplateContentNodeShallowDirect(nodeId, templateNodeId);
      }
    }
  }

  private ensureFieldEntryWithTemplateDirect(
    nodeId: string,
    fieldDefId: string,
    templateOriginId: string | undefined,
    cloneDefaults: boolean,
  ) {
    const state = this.snapshot();
    const existing = requiredNode(state, nodeId).children.find((childId) => {
      const child = state.nodes[childId];
      return child?.type === 'fieldEntry' && child.fieldDefId === fieldDefId;
    });
    if (existing) return existing;
    const id = this.insertFieldEntryNodeDirect(nodeId, 0, fieldDefId);
    if (templateOriginId) {
      this.patchNodeData(id, (node) => {
        node.templateId = templateOriginId;
      });
    }
    if (cloneDefaults && templateOriginId) this.cloneTemplateFieldValuesDirect(id, templateOriginId);
    if (requiredNode(this.snapshot(), id).children.length === 0) {
      this.applyAutoInitializeDirect(nodeId, id, fieldDefId);
    }
    return id;
  }

  private applyAutoInitializeDirect(nodeId: string, fieldEntryId: string, fieldDefId: string) {
    const state = this.snapshot();
    const fieldDef = state.nodes[fieldDefId];
    if (!fieldDef || fieldAutoInitOf(state, fieldDefId).length === 0) return;
    const result = resolveAutoInit(state, nodeId, fieldDef);
    if (!result) return;
    if (result.kind === 'reference') {
      this.loro.createNodeWithId<ReferenceNode>(freshId('auto_value'), fieldEntryId, undefined, 'reference', (node) => {
        node.targetId = result.targetId;
      });
      return;
    }
    this.loro.createNodeWithId(freshId('auto_value'), fieldEntryId, undefined, undefined, (node) => {
      node.content = plainText(result.value);
    });
  }

  private cloneTemplateFieldValuesDirect(fieldEntryId: string, templateOriginId: string) {
    const state = this.snapshot();
    if (state.nodes[templateOriginId]?.type !== 'fieldEntry') return;
    for (const valueId of state.nodes[templateOriginId]?.children ?? []) {
      const value = state.nodes[valueId];
      if (!value) continue;
      const sourceTargetId = value.type === 'reference' ? value.targetId : undefined;
      const sourceCodeLanguage = value.type === 'codeBlock' ? value.codeLanguage : undefined;
      this.loro.createNodeWithId(freshId('value'), fieldEntryId, undefined, value.type, (node) => {
        node.content = clone(value.content);
        node.description = value.description;
        if (sourceTargetId) (node as ReferenceNode).targetId = sourceTargetId;
        if (sourceCodeLanguage) (node as CodeBlockNode).codeLanguage = sourceCodeLanguage;
      });
    }
  }

  private cloneTemplateContentNodeShallowDirect(parentId: string, templateNodeId: string) {
    const state = this.snapshot();
    const parent = requiredNode(state, parentId);
    if (parent.children.some((childId) => state.nodes[childId]?.templateId === templateNodeId)) return;
    const template = requiredNode(state, templateNodeId);
    const code = template as Partial<CodeBlockNode>;
    const image = template as Partial<ImageNode>;
    const embed = template as Partial<EmbedNode>;
    this.loro.createNodeWithId(freshId('template'), parentId, undefined, template.type, (node) => {
      node.templateId = templateNodeId;
      node.content = clone(template.content);
      node.description = template.description;
      node.aiSummary = template.aiSummary;
      (node as CodeBlockNode).codeLanguage = code.codeLanguage;
      const target = node as ImageNode;
      target.mediaUrl = image.mediaUrl;
      target.mediaAlt = image.mediaAlt;
      target.imageWidth = image.imageWidth;
      target.imageHeight = image.imageHeight;
      const targetEmbed = node as EmbedNode;
      targetEmbed.embedType = embed.embedType;
      targetEmbed.embedId = embed.embedId;
      targetEmbed.sourceUrl = embed.sourceUrl;
    });
  }

  private cleanupFieldsFromRemovedTagDirect(nodeId: string, removedTagId: string) {
    const state = this.snapshot();
    const remainingTags = state.nodes[nodeId]?.tags ?? [];
    const requiredByRemaining = new Set<string>();
    for (const tagId of remainingTags) {
      for (const chainTagId of getExtendsChain(state, tagId)) {
        for (const fieldRef of getTemplateFieldDefs(state, chainTagId)) requiredByRemaining.add(fieldRef.fieldDefId);
      }
    }
    const removedFields = new Set<string>();
    for (const chainTagId of getExtendsChain(state, removedTagId)) {
      for (const fieldRef of getTemplateFieldDefs(state, chainTagId)) removedFields.add(fieldRef.fieldDefId);
    }
    const toRemove = (state.nodes[nodeId]?.children ?? []).filter((childId) => {
      const child = state.nodes[childId];
      return child?.type === 'fieldEntry'
        && !!child.fieldDefId
        && removedFields.has(child.fieldDefId)
        && !requiredByRemaining.has(child.fieldDefId);
    });
    for (const fieldEntryId of toRemove) this.removeSubtreeDirect(fieldEntryId);
  }

  private ensureOptionNodeDirect(fieldDefId: string, name: string) {
    const state = this.snapshot();
    const existing = findOptionByName(state, fieldDefId, name);
    if (existing) return existing;
    const optionId = freshId('option');
    this.loro.createNodeWithId(optionId, fieldDefId, undefined, undefined, (node) => {
      node.content = plainText(name);
      node.autoCollected = true;
    });
    return optionId;
  }

  private selectFieldOptionDirect(fieldEntryId: string, fieldDefId: string, optionNodeId: string, id?: string) {
    const state = this.snapshot();
    const fieldEntry = requiredNode(state, fieldEntryId);
    requiredNode(state, fieldDefId);
    const optionTargetId = optionValueTargetId(state, optionNodeId);
    // Everything is a node: selecting an option appends a reference value (deduped
    // against an already-present selection). Core no longer replaces on cardinality.
    const alreadySelected = fieldEntry.children.some((childId) => {
      const child = state.nodes[childId];
      return childId === optionTargetId || (child?.type === 'reference' && child.targetId === optionTargetId);
    });
    if (alreadySelected) {
      return;
    }
    // An optional renderer-proposed id keeps the trailing draft row's React
    // identity through the draft->reference transition (see resolveFieldValueId).
    const referenceId = this.resolveFieldValueId(state, id, 'option_value');
    this.loro.createNodeWithId<ReferenceNode>(referenceId, fieldEntryId, undefined, 'reference', (node) => {
      node.targetId = optionTargetId;
    });
  }

  private clearFieldEntryValuesDirect(fieldEntryId: string, fieldDefId: string) {
    const state = this.snapshot();
    for (const valueId of [...state.nodes[fieldEntryId]?.children ?? []]) {
      if (this.promoteCollectedValueIfReferencedDirect(fieldEntryId, fieldDefId, valueId)) continue;
      this.removeCollectedReferencesForFieldValuesDirect(fieldDefId, [valueId]);
      this.removeSubtreeDirect(valueId);
    }
  }

  private promoteCollectedValueIfReferencedDirect(fieldEntryId: string, fieldDefId: string, valueId: string) {
    const state = this.snapshot();
    const value = state.nodes[valueId];
    if (!value || value.type === 'reference') return false;
    const collectedRefIds = collectedReferenceIdsForValue(state, fieldDefId, valueId);
    if (collectedRefIds.length === 0) return false;

    const ignoredIds = new Set([
      fieldEntryId,
      ...collectDescendantsFromState(state, fieldEntryId),
      ...collectedRefIds,
    ]);
    if (!hasExternalReferencesToTarget(state, valueId, ignoredIds)) return false;

    const fieldChildren = state.nodes[fieldDefId]?.children ?? [];
    const insertIndex = fieldChildren.findIndex((childId) => collectedRefIds.includes(childId));
    for (const refId of collectedRefIds) this.removeSubtreeDirect(refId);

    const promoted = clone(requiredNode(this.snapshot(), valueId));
    promoted.autoCollected = true;
    this.loro.writeNode(promoted);
    this.loro.moveNode(valueId, fieldDefId, insertIndex >= 0 ? insertIndex : undefined);
    return true;
  }

  private removeCollectedReferencesForFieldValuesDirect(fieldDefId: string, valueIds: readonly string[]) {
    const state = this.snapshot();
    const removedValueIds = new Set(valueIds);
    for (const childId of [...state.nodes[fieldDefId]?.children ?? []]) {
      const child = state.nodes[childId];
      if (child?.type === 'reference' && child.autoCollected && child.targetId && removedValueIds.has(child.targetId)) {
        this.removeSubtreeDirect(childId);
      }
    }
  }

  private ensureDateNodeDirect(year: number, month: number, day: number) {
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      throw CoreError.invalidOperation('invalid date');
    }
    const yearName = String(year);
    const weekName = `W${String(isoWeek(date)).padStart(2, '0')}`;
    const dayName = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const yearId = this.findOrCreateNamedChildDirect(DAILY_NOTES_ID, yearName, TAG_YEAR_ID);
    const weekId = this.findOrCreateNamedChildDirect(yearId, weekName, TAG_WEEK_ID);
    return this.findOrCreateNamedChildDirect(weekId, dayName, TAG_DAY_ID);
  }

  private findDateNodeId(year: number, month: number, day: number) {
    const state = this.snapshot();
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
    const yearName = String(year);
    const weekName = `W${String(isoWeek(date)).padStart(2, '0')}`;
    const dayName = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const yearId = findNamedChild(state, DAILY_NOTES_ID, yearName);
    const weekId = yearId ? findNamedChild(state, yearId, weekName) : undefined;
    return weekId ? findNamedChild(state, weekId, dayName) : undefined;
  }

  private findOrCreateNamedChildDirect(parentId: string, name: string, tagId?: string) {
    const state = this.snapshot();
    for (const childId of state.nodes[parentId]?.children ?? []) {
      if (state.nodes[childId]?.content.text === name) return childId;
    }
    const id = freshId('date');
    this.loro.createNodeWithId(id, parentId, 0, undefined, (node) => {
      node.content = plainText(name);
      node.locked = true;
    });
    if (tagId) this.applyTagNoHistoryDirect(id, tagId);
    return id;
  }

  private mergeNodeIntoTargetDirect(nodeId: string, targetId: string) {
    const state = this.snapshot();
    if (nodeId === targetId || isDescendant(state, targetId, nodeId)) throw CoreError.invalidMove();
    const current = clone(requiredNode(state, nodeId));
    const sourceParentId = current.parentId;
    const sourceIndex = sourceParentId ? childIndex(state, sourceParentId, nodeId) : undefined;
    let target = clone(requiredNode(state, targetId));
    if (target.type === 'reference' && target.targetId) {
      // A reference node renders its target, not its own content, so merging text
      // into it converts the reference into a *leading inline reference* on a
      // now-plain node — the merged text then has somewhere to live. Rebuild it
      // as a content node rather than mutating the discriminant in place.
      const resolvedTargetId = resolveReferenceTargetId(state, target.targetId);
      const inlineRefContent: RichText = {
        text: '',
        marks: [],
        inlineRefs: [{
          offset: 0,
          target: nodeReferenceTarget(resolvedTargetId),
          displayName: state.nodes[resolvedTargetId]?.content.text || undefined,
        }],
      };
      const { targetId: _droppedTargetId, refRole: _droppedRefRole, ...rest } = target;
      target = {
        ...rest,
        type: undefined,
        content: appendRichText(inlineRefContent, current.content),
      };
    } else {
      target.content = appendRichText(target.content, current.content);
    }
    target.updatedAt = nowMs();
    this.loro.writeNode(target);
    current.children.forEach((childId, offset) => {
      const insertIndex = sourceParentId === targetId && sourceIndex !== undefined ? sourceIndex + 1 + offset : undefined;
      this.loro.moveNode(childId, targetId, insertIndex);
    });
    this.removeSubtreeDirect(nodeId);
  }

  private applyPlannedParentOrders(planned: DocumentState) {
    const current = this.snapshot();
    for (const parent of Object.values(planned.nodes)) {
      const existing = current.nodes[parent.id];
      if (!existing) continue;
      parent.children.forEach((childId, index) => {
        if (current.nodes[childId]?.parentId === parent.id && existing.children[index] !== childId) {
          this.loro.moveNode(childId, parent.id, index);
        }
      });
    }
  }

}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneState(state: DocumentState): DocumentState {
  return clone(state);
}

function applyPlannedNodeMove(state: DocumentState, move: BatchMoveNodeInput) {
  const node = requiredNode(state, move.nodeId);
  if (move.nodeId === move.parentId || isDescendant(state, move.parentId, move.nodeId)) {
    throw CoreError.invalidMove();
  }
  ensureNodeMovable(state, move.nodeId);
  ensureParentMutable(state, move.parentId);
  ensureParentCanContainChildInstance(state, move.parentId, childInstanceTargetId(state, move.nodeId), move.nodeId);

  const targetParent = requiredNode(state, move.parentId);
  const targetIndex = plannedInsertIndex(move.index, targetParent.children.length);
  const previousParent = node.parentId ? requiredNode(state, node.parentId) : null;
  if (previousParent) previousParent.children = previousParent.children.filter((childId) => childId !== move.nodeId);
  const refreshedTargetParent = requiredNode(state, move.parentId);
  refreshedTargetParent.children.splice(Math.min(targetIndex, refreshedTargetParent.children.length), 0, move.nodeId);
  node.parentId = move.parentId;
}

function plannedInsertIndex(index: number | null | undefined, length: number): number {
  if (index === null || index === undefined) return length;
  return Math.max(0, Math.min(index, length));
}

function collectDescendantsFromState(state: DocumentState, nodeId: string): string[] {
  const result: string[] = [];
  for (const childId of state.nodes[nodeId]?.children ?? []) {
    result.push(childId, ...collectDescendantsFromState(state, childId));
  }
  return result;
}

function collectSubtreeAndDependentReferences(state: DocumentState, nodeId: string): Set<string> {
  const removedIds = new Set<string>();
  const addSubtree = (id: string) => {
    if (removedIds.has(id) || !state.nodes[id]) return;
    removedIds.add(id);
    for (const childId of state.nodes[id].children) addSubtree(childId);
  };

  addSubtree(nodeId);

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of Object.values(state.nodes)) {
      if (removedIds.has(node.id)) continue;
      if (node.type === 'reference' && node.targetId && removedIds.has(node.targetId)) {
        addSubtree(node.id);
        changed = true;
      }
    }
  }

  return removedIds;
}

function removalRootIds(state: DocumentState, removedIds: ReadonlySet<string>): string[] {
  return [...removedIds].filter((id) => {
    const parentId = state.nodes[id]?.parentId;
    return !parentId || !removedIds.has(parentId);
  });
}

function collectedReferenceIdsForValue(state: DocumentState, fieldDefId: string, valueId: string): string[] {
  return (state.nodes[fieldDefId]?.children ?? []).filter((childId) => {
    const child = state.nodes[childId];
    return child?.type === 'reference'
      && child.autoCollected
      && child.targetId === valueId;
  });
}

function hasExternalReferencesToTarget(
  state: DocumentState,
  targetId: string,
  ignoredIds: ReadonlySet<string>,
): boolean {
  for (const node of Object.values(state.nodes)) {
    if (ignoredIds.has(node.id)) continue;
    if (node.type === 'reference' && node.targetId === targetId) return true;
    if (node.content.inlineRefs.some((ref) => inlineRefNodeId(ref) === targetId)) return true;
  }
  return false;
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// True iff any of the touched nodes actually differs between the pre- and
// post-mutation states (covers creates, deletes, and content edits). Compares
// only the touched nodes, so change detection is O(touched) rather than O(N).
function changedTouchedNodes(touched: readonly string[], before: DocumentState, after: DocumentState): boolean {
  return touched.some((id) => !sameJson(before.nodes[id], after.nodes[id]));
}

function commitOriginFor(origin: CommitOrigin) {
  if (origin === 'agent') return AGENT_COMMIT_ORIGIN;
  if (origin === 'system') return SYSTEM_COMMIT_ORIGIN;
  if (origin === '__seed__') return '__seed__';
  return DEFAULT_COMMIT_ORIGIN;
}

function focus(nodeId: string, options: FocusOptions = {}): FocusHint {
  return {
    nodeId,
    selectAll: options.selectAll ?? (options.placement?.kind === 'all'),
    ...(options.parentId !== undefined ? { parentId: options.parentId } : {}),
    ...(options.surface ? { surface: options.surface } : {}),
    ...(options.placement ? { placement: options.placement } : {}),
  };
}

function nowMs() {
  return Date.now();
}

// Checkbox click (nodex `resolveCheckboxClick`): toggle undone ↔ done, never
// removing the checkbox. Tag-driven nodes keep their checkbox via the tag, so
// undone clears the timestamp entirely; manual nodes fall back to the undone
// sentinel (0) to keep the box visible.
function toggleNodeDone(node: Node, tagDriven: boolean) {
  if (nodeIsDone(node)) {
    if (tagDriven) delete node.completedAt;
    else node.completedAt = 0;
  } else {
    node.completedAt = nowMs();
  }
}

// Cmd+Enter cycle (nodex `resolveCmdEnterCycle`): tag-driven nodes are a 2-state
// toggle (undone ↔ done); manual nodes cycle no-checkbox → undone → done → none.
function cycleNodeDoneState(node: Node, tagDriven: boolean) {
  if (tagDriven) {
    if (nodeIsDone(node)) delete node.completedAt;
    else node.completedAt = nowMs();
    return;
  }
  if (node.completedAt === undefined) node.completedAt = 0;
  else if (node.completedAt === 0) node.completedAt = nowMs();
  else delete node.completedAt;
}

function freshId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

// Re-exported so existing importers of `core` keep resolving these; the shape
// itself lives in `./nodeId` as the single source of truth for renderer + core.
export { freshNodeId, isClientNodeId };

/**
 * An image node's source is exactly one of a local `assetId` or a remote
 * `mediaUrl`. Normalize and validate the create/convert options into one.
 */
function resolveImageSource(
  options: { assetId?: string; mediaUrl?: string },
): { assetId: string; mediaUrl?: undefined } | { assetId?: undefined; mediaUrl: string } {
  const assetId = options.assetId?.trim();
  const mediaUrl = options.mediaUrl?.trim();
  if (assetId && mediaUrl) {
    throw CoreError.invalidOperation('image node takes either an assetId or a mediaUrl, not both');
  }
  if (assetId) return { assetId };
  if (mediaUrl) {
    // A remote source is always loaded into an <img>/opened externally, so it
    // must be http(s). Enforcing it here keeps the document invariant true for
    // every caller (paste, agent, import), not just the UI paste classifier.
    if (!/^https?:\/\//i.test(mediaUrl)) {
      throw CoreError.invalidOperation('image node mediaUrl must be an http(s) URL');
    }
    return { mediaUrl };
  }
  throw CoreError.invalidOperation('image node requires an assetId or a mediaUrl');
}

function requiredNode(state: DocumentState, nodeId: string): Node {
  const node = state.nodes[nodeId];
  if (!node) throw CoreError.nodeNotFound(nodeId);
  return node;
}

function setOptional<T extends object, K extends keyof T>(object: T, key: K, value: T[K] | undefined) {
  if (value === undefined || value === null || value === '') delete object[key];
  else object[key] = value;
}

// Validate and canonicalize a command schedule string. Empty → undefined
// (manual-only). A non-empty value must parse as a `<endpoint> RRULE:...`
// schedule (src/core/dateSchedule.ts); we store the canonical re-serialization
// so the offline scheduler always reads a normalized form.
function normalizeCommandSchedule(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = parseDateSchedule(trimmed);
  if (!parsed) throw CoreError.invalidOperation('invalid command schedule');
  return formatDateSchedule(parsed);
}

function ensureParentMutable(state: DocumentState, parentId: string) {
  if (!state.nodes[parentId]) throw CoreError.parentNotFound(parentId);
  // config-as-nodes: defConfig/systemOption subtrees are registry-governed;
  // user commands cannot insert children under them. Internal config machinery
  // uses *Direct loro APIs that bypass this guard.
  if (isInternalConfigNode(state.nodes[parentId])) {
    throw CoreError.invalidOperation('config nodes are structurally locked');
  }
}

function ensureNodeEditable(state: DocumentState, nodeId: string) {
  const node = requiredNode(state, nodeId);
  if (node.locked) throw CoreError.lockedNode(nodeId);
  // The defConfig/systemOption node itself cannot be renamed/edited via user
  // commands; its value is mutated only through the setConfigValue chokepoint.
  if (isInternalConfigNode(node)) throw CoreError.invalidOperation('config nodes are structurally locked');
}

function ensureNodeMovable(state: DocumentState, nodeId: string) {
  const node = requiredNode(state, nodeId);
  if (node.locked || isSystemId(nodeId) || isInternalConfigNode(node)) throw CoreError.lockedNode(nodeId);
}

function ensureTagDefinition(state: DocumentState, tagId: string) {
  if (requiredNode(state, tagId).type !== 'tagDef') throw CoreError.invalidOperation('expected a tag definition');
}

function ensureFieldDefinition(state: DocumentState, fieldId: string) {
  if (requiredNode(state, fieldId).type !== 'fieldDef') throw CoreError.invalidOperation('expected a field definition');
}

function ensureValidHideFieldMode(mode: string) {
  if (!['never', 'empty', 'not_empty', 'value_is_default', 'always', 'hidden'].includes(mode)) {
    throw CoreError.invalidOperation(`invalid hide field mode: ${mode}`);
  }
}

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeCodeLanguage(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function normalizeRequiredText(value: string, label: string): string {
  const normalized = normalizeOptionalText(value);
  if (!normalized) throw CoreError.invalidOperation(`${label} is required`);
  return normalized;
}

function normalizeFilterOperator(value: FilterOperator): FilterOperator {
  return [
    'is',
    'is_not',
    'contains',
    'not_contains',
    'is_empty',
    'is_not_empty',
    'gt',
    'lt',
    'before',
    'after',
  ].includes(value) ? value : 'contains';
}

function normalizeSearchTitle(value: string) {
  return value.trim() || 'Search';
}

function searchRuleTitle(state: DocumentState, rule: SearchQueryRule): string {
  if (rule.tagDefId) return state.nodes[rule.tagDefId]?.content.text ?? rule.tagDefId;
  if (rule.targetId) return state.nodes[rule.targetId]?.content.text ?? rule.targetId;
  if (rule.fieldDefId) return state.nodes[rule.fieldDefId]?.content.text ?? rule.fieldDefId;
  return rule.op;
}

function searchNodeHasSingleTagQuery(state: DocumentState, nodeId: string, tagId: string): boolean {
  const node = state.nodes[nodeId];
  const conditionIds = node?.children.filter((childId) => {
    const child = state.nodes[childId];
    return child?.type === 'queryCondition' && !isInTrash(state, childId);
  }) ?? [];
  if (conditionIds.length !== 1) return false;
  const condition = state.nodes[conditionIds[0]!];
  return condition?.type === 'queryCondition' && condition.queryOp === 'HAS_TAG' && condition.queryTagDefId === tagId;
}

function reorderDirectChildren(
  loro: { moveNode: (nodeId: string, parentId: string, index: number | null | undefined) => void },
  parent: Node,
  desiredChildren: NodeId[],
) {
  const currentChildren = [...parent.children];
  desiredChildren.forEach((childId, index) => {
    if (currentChildren[index] === childId) return;
    const currentIndex = currentChildren.indexOf(childId);
    if (currentIndex < 0) return;
    loro.moveNode(childId, parent.id, index);
    currentChildren.splice(currentIndex, 1);
    currentChildren.splice(index, 0, childId);
  });
}

function uniqueNodeIds(nodeIds: NodeId[]): NodeId[] {
  const seen = new Set<NodeId>();
  const result: NodeId[] = [];
  for (const nodeId of nodeIds) {
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    result.push(nodeId);
  }
  return result;
}

function normalizeTextList(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function childIndex(state: DocumentState, parentId: string, childId: string): number | undefined {
  const index = state.nodes[parentId]?.children.indexOf(childId) ?? -1;
  return index >= 0 ? index : undefined;
}

function batchIndentTargetParentId(
  state: DocumentState,
  nodeId: string,
  batch: ReadonlySet<string>,
): string | null {
  let currentId: string | undefined = nodeId;
  while (currentId) {
    const node: Node | undefined = state.nodes[currentId];
    const parentId: string | undefined = node?.parentId;
    const parent: Node | undefined = parentId ? state.nodes[parentId] : undefined;
    const index: number = parent?.children.indexOf(currentId) ?? -1;
    if (!parent || index <= 0) return null;

    const previousSiblingId: string | undefined = parent.children[index - 1];
    if (!previousSiblingId) return null;
    if (!batch.has(previousSiblingId)) return previousSiblingId;
    currentId = previousSiblingId;
  }
  return null;
}

function orderNodeIdsByDocumentPosition(state: DocumentState, nodeIds: readonly string[]): string[] {
  const ranks = new Map<string, number>();
  let nextRank = 0;
  const visit = (nodeId: string) => {
    if (ranks.has(nodeId)) return;
    const node = state.nodes[nodeId];
    if (!node) return;
    ranks.set(nodeId, nextRank);
    nextRank += 1;
    for (const childId of node.children) visit(childId);
  };
  Object.values(state.nodes)
    .filter((node) => !node.parentId)
    .sort((left, right) => left.id.localeCompare(right.id))
    .forEach((node) => visit(node.id));
  return [...nodeIds].sort((left, right) => (
    (ranks.get(left) ?? Number.MAX_SAFE_INTEGER)
    - (ranks.get(right) ?? Number.MAX_SAFE_INTEGER)
  ));
}

function topLevelNodeIds(state: DocumentState, nodeIds: string[]): string[] {
  const selected = new Set(nodeIds);
  const seen = new Set<string>();
  return nodeIds.filter((nodeId) => {
    if (seen.has(nodeId)) return false;
    seen.add(nodeId);
    return !hasSelectedAncestor(state, nodeId, selected);
  });
}

function hasSelectedAncestor(state: DocumentState, nodeId: string, selected: Set<string>) {
  let current = state.nodes[nodeId]?.parentId;
  while (current) {
    if (selected.has(current)) return true;
    current = state.nodes[current]?.parentId;
  }
  return false;
}

function moveSelectedSiblings(state: DocumentState, nodeIds: string[], direction: MoveDirection) {
  const topLevelIds = topLevelNodeIds(state, nodeIds);
  const selected = new Set(topLevelIds);
  const parentIds: string[] = [];
  for (const nodeId of topLevelIds) {
    if (!state.nodes[nodeId]) continue;
    ensureNodeMovable(state, nodeId);
    const parentId = state.nodes[nodeId].parentId;
    if (!parentId) throw CoreError.noParent();
    ensureParentMutable(state, parentId);
    if (!parentIds.includes(parentId)) parentIds.push(parentId);
  }
  for (const parentId of parentIds) {
    const parent = state.nodes[parentId];
    if (!parent) continue;
    if (direction === 'up') {
      for (let index = 1; index < parent.children.length; index += 1) {
        if (selected.has(parent.children[index]) && !selected.has(parent.children[index - 1])) {
          [parent.children[index - 1], parent.children[index]] = [parent.children[index], parent.children[index - 1]];
        }
      }
    } else {
      for (let index = parent.children.length - 2; index >= 0; index -= 1) {
        if (selected.has(parent.children[index]) && !selected.has(parent.children[index + 1])) {
          [parent.children[index], parent.children[index + 1]] = [parent.children[index + 1], parent.children[index]];
        }
      }
    }
  }
  for (const nodeId of selected) touchNode(state, nodeId);
}

function isDescendant(state: DocumentState, nodeId: string, ancestorId: string) {
  let current = state.nodes[nodeId]?.parentId;
  while (current) {
    if (current === ancestorId) return true;
    current = state.nodes[current]?.parentId;
  }
  return false;
}

function isInTrash(state: DocumentState, nodeId: string) {
  return nodeId === TRASH_ID || isDescendant(state, nodeId, TRASH_ID);
}

const LEGACY_PARA_NODE_NAMES = new Map([
  [PROJECTS_ID, 'Projects'],
  [AREAS_ID, 'Areas'],
  [RESOURCES_ID, 'Resources'],
]);

function isDisposableLegacyParaNode(node: Node, title: string) {
  return node.type === undefined
    && node.children.length === 0
    && node.content.text === title
    && node.content.marks.length === 0
    && node.content.inlineRefs.length === 0
    && node.tags.length === 0
    && !node.description;
}

// The authoritative set of seeded system nodes (workspace sections + built-in
// tags). Membership confers structural protection (no move/delete/reparent via
// `ensureNodeMovable` / `removeSubtreeDirect`) and excludes the node from search
// candidates. Keep this in sync with the seeded sections — LIBRARY_ID and
// RECENTS_ID belong here too (Library was previously protected only by its
// `locked` flag, leaving `removeSubtreeDirect` / `isSearchCandidate` to treat it
// as a normal node).
function isSystemId(nodeId: string) {
  return [
    WORKSPACE_ID,
    DAILY_NOTES_ID,
    LIBRARY_ID,
    SCHEMA_ID,
    SEARCHES_ID,
    RECENTS_ID,
    TRASH_ID,
    SETTINGS_ID,
    TAG_DAY_ID,
    TAG_WEEK_ID,
    TAG_YEAR_ID,
  ].includes(nodeId);
}

// Built-in system fields (Created / Done time / Tags / …) are addressed by a
// `sys:` id and have no backing def node — their value is computed read-only from
// the owner. `freshId` never mints this prefix, so it cannot collide with a real
// field definition id.
function isSystemFieldDefId(id: string): boolean {
  return id.startsWith('sys:');
}

function touchNode(state: DocumentState, nodeId: string) {
  if (state.nodes[nodeId]) state.nodes[nodeId].updatedAt = nowMs();
}

// config-as-nodes: read a single ref-domain config value (extends /
// childSupertag / sourceSupertag) from a definition's defConfig subtree.
function configRefTarget(state: DocumentState, defId: string, configKey: DefConfigKey): string | undefined {
  const def = state.nodes[defId];
  if (!def) return undefined;
  for (const rowId of def.children) {
    const row = state.nodes[rowId];
    if (row?.type === 'defConfig' && row.configKey === configKey) {
      for (const valueId of row.children) {
        const value = state.nodes[valueId];
        if (value?.type === 'reference' && value.targetId) return value.targetId;
      }
    }
  }
  return undefined;
}

/**
 * The field's type, read from its `defConfig(fieldType)` enum subtree (the value
 * reference targets a system option whose text is the canonical value). Mirrors
 * `projectFieldConfig`'s resolution; defaults to 'plain'. See configProjection.ts.
 */
function fieldTypeOf(state: DocumentState, fieldDefId: string): FieldType {
  const optionId = configRefTarget(state, fieldDefId, 'fieldType');
  const value = optionId ? state.nodes[optionId]?.content.text : undefined;
  return (value as FieldType | undefined) ?? 'plain';
}

/** A scalar (number/bool/color) config value's stored text, read from the def's subtree. */
function configScalarText(state: DocumentState, defId: string, configKey: DefConfigKey): string | undefined {
  const def = state.nodes[defId];
  if (!def) return undefined;
  for (const rowId of def.children) {
    const row = state.nodes[rowId];
    if (row?.type === 'defConfig' && row.configKey === configKey) {
      for (const valueId of row.children) {
        const value = state.nodes[valueId];
        if (value && value.type !== 'reference') return value.content.text;
      }
    }
  }
  return undefined;
}

/** A boolean config value read from the def's scalar subtree. */
function configScalarBool(state: DocumentState, defId: string, configKey: DefConfigKey): boolean {
  return boolCodec.decode(configScalarText(state, defId, configKey) ?? '') ?? false;
}

/** Whether a tag definition enables a checkbox, walking its `extends` chain. */
function tagShowsCheckboxOf(state: DocumentState, tagDefId: string): boolean {
  const visited = new Set<string>();
  let current: string | undefined = tagDefId;
  while (current && !visited.has(current)) {
    visited.add(current);
    if (configScalarBool(state, current, 'showCheckbox')) return true;
    current = configRefTarget(state, current, 'extends');
  }
  return false;
}

/** True when any of the node's applied tags drives a checkbox (tag-driven visibility). */
function nodeTagDrivenCheckbox(state: DocumentState, node: Node): boolean {
  return node.tags.some((tagId) => tagShowsCheckboxOf(state, tagId));
}

/** Done = a completion timestamp is set (sentinel 0 means "has checkbox, undone"). */
function nodeIsDone(node: Node): boolean {
  return node.completedAt !== undefined && node.completedAt > 0;
}

// ─── Done-state mapping (Tana parity): a tag's checked/unchecked done state
// mirrors option-field values both ways. See checkbox-utils in nodex. ───

/** A tag's `extends` chain including itself, ancestor-last, deduped. */
function tagExtendsChainSelf(state: DocumentState, tagDefId: string): string[] {
  const chain: string[] = [];
  const visited = new Set<string>();
  let current: string | undefined = tagDefId;
  while (current && !visited.has(current)) {
    visited.add(current);
    chain.push(current);
    current = configRefTarget(state, current, 'extends');
  }
  return chain;
}

/** Every target of a ref-list config value (`doneMapChecked`/`doneMapUnchecked`), in order. */
function configRefTargets(state: DocumentState, defId: string, configKey: DefConfigKey): string[] {
  const def = state.nodes[defId];
  if (!def) return [];
  for (const rowId of def.children) {
    const row = state.nodes[rowId];
    if (row?.type === 'defConfig' && row.configKey === configKey) {
      return row.children
        .map((id) => state.nodes[id])
        .filter((n): n is Extract<Node, { type: 'reference' }> => n?.type === 'reference' && Boolean(n.targetId))
        .map((n) => n.targetId as string);
    }
  }
  return [];
}

interface DoneStateFieldMapping {
  fieldDefId: string;
  checkedOptionIds: string[];
  uncheckedOptionIds: string[];
}

/**
 * The done-state mappings that apply to a node: for each of its tags (walking
 * extends chains) whose `doneStateEnabled` is on, the checked/unchecked option
 * lists grouped by the option's owning field definition.
 */
function getDoneStateMappings(state: DocumentState, node: Node): DoneStateFieldMapping[] {
  const byField = new Map<string, { checked: string[]; unchecked: string[] }>();
  const seenTags = new Set<string>();
  const addOptions = (optionIds: string[], key: 'checked' | 'unchecked') => {
    for (const optionId of optionIds) {
      const fieldDefId = state.nodes[optionId]?.parentId;
      if (!fieldDefId || state.nodes[fieldDefId]?.type !== 'fieldDef') continue;
      let entry = byField.get(fieldDefId);
      if (!entry) byField.set(fieldDefId, (entry = { checked: [], unchecked: [] }));
      if (!entry[key].includes(optionId)) entry[key].push(optionId);
    }
  };
  for (const tagId of node.tags) {
    for (const tdId of tagExtendsChainSelf(state, tagId)) {
      if (seenTags.has(tdId)) continue;
      seenTags.add(tdId);
      if (!configScalarBool(state, tdId, 'doneStateEnabled')) continue;
      addOptions(configRefTargets(state, tdId, 'doneMapChecked'), 'checked');
      addOptions(configRefTargets(state, tdId, 'doneMapUnchecked'), 'unchecked');
    }
  }
  return [...byField].map(([fieldDefId, { checked, unchecked }]) => ({
    fieldDefId,
    checkedOptionIds: checked,
    uncheckedOptionIds: unchecked,
  }));
}

/**
 * Reverse mapping: when an option is selected on a node's field, whether that
 * implies a new done state (true/false) or has no mapping (null).
 */
function resolveReverseDoneMapping(state: DocumentState, node: Node, fieldDefId: string, optionNodeId: string): boolean | null {
  for (const mapping of getDoneStateMappings(state, node)) {
    if (mapping.fieldDefId !== fieldDefId) continue;
    if (mapping.checkedOptionIds.includes(optionNodeId)) return true;
    if (mapping.uncheckedOptionIds.includes(optionNodeId)) return false;
  }
  return null;
}

/** Apply a resolved done state to a node in place (tag-driven keeps the box on undo). */
function applyNodeDoneState(node: Node, done: boolean, tagDriven: boolean) {
  if (done) node.completedAt = nowMs();
  else if (tagDriven) delete node.completedAt;
  else node.completedAt = 0;
}

/** A numeric config value (minValue/maxValue) read from the def's scalar subtree. */
function fieldNumberConfigOf(state: DocumentState, fieldDefId: string, configKey: DefConfigKey): number | undefined {
  const text = configScalarText(state, fieldDefId, configKey);
  if (text == null) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/** The field's auto-initialize strategies, read from its `defConfig(autoInitialize)` enumList subtree. */
function fieldAutoInitOf(state: DocumentState, fieldDefId: string): AutoInitStrategy[] {
  const def = state.nodes[fieldDefId];
  if (!def) return [];
  const row = def.children
    .map((id) => state.nodes[id])
    .find((n) => n?.type === 'defConfig' && n.configKey === 'autoInitialize');
  if (!row) return [];
  const strategies: AutoInitStrategy[] = [];
  for (const valueId of row.children) {
    const ref = state.nodes[valueId];
    const text = ref?.type === 'reference' && ref.targetId ? state.nodes[ref.targetId]?.content.text : undefined;
    if (text && AUTO_INIT_STRATEGIES.includes(text as AutoInitStrategy)) strategies.push(text as AutoInitStrategy);
  }
  return strategies;
}

function getExtendsChain(state: DocumentState, tagId: string): string[] {
  const chain: string[] = [];
  const visited = new Set<string>();
  let current: string | undefined = tagId;
  while (current && !visited.has(current)) {
    visited.add(current);
    chain.push(current);
    current = configRefTarget(state, current, 'extends');
  }
  return chain;
}

function getTemplateFieldDefs(state: DocumentState, tagId: string): TemplateFieldRef[] {
  const result: TemplateFieldRef[] = [];
  const seen = new Set<string>();
  for (const childId of state.nodes[tagId]?.children ?? []) {
    const child = state.nodes[childId];
    if (child?.type === 'fieldEntry' && child.fieldDefId && !seen.has(child.fieldDefId)) {
      seen.add(child.fieldDefId);
      result.push({ fieldDefId: child.fieldDefId, templateOriginId: childId });
    }
  }
  return result;
}

function getTemplateContentNodes(state: DocumentState, tagId: string) {
  return (state.nodes[tagId]?.children ?? []).filter((id) => {
    const type = state.nodes[id]?.type;
    return type === undefined || type === 'codeBlock';
  });
}

function findNodesWithTag(state: DocumentState, tagId: string) {
  return Object.values(state.nodes).filter((node) => node.tags.includes(tagId)).map((node) => node.id);
}

function findTagByName(state: DocumentState, name: string) {
  const needle = name.trim().toLowerCase();
  return Object.values(state.nodes).find((node) =>
    node.type === 'tagDef' && node.content.text.trim().toLowerCase() === needle)?.id;
}

function findFieldDefByName(state: DocumentState, name: string) {
  const needle = name.trim().toLowerCase();
  return Object.values(state.nodes).find((node) =>
    node.type === 'fieldDef'
    && node.parentId === SCHEMA_ID
    && node.content.text.trim().toLowerCase() === needle)?.id;
}

// A pasted task-list row's `completedAt` sentinel: undefined → no checkbox,
// 0 → an unchecked checkbox, a timestamp → checked/done (see setNodeCheckboxVisible).
function pasteCompletedAt(meta: PasteRowMeta): number | undefined {
  if (!meta.checkbox) return undefined;
  return meta.done ? nowMs() : 0;
}

function findNamedChild(state: DocumentState, parentId: string, name: string) {
  return state.nodes[parentId]?.children.find((childId) => state.nodes[childId]?.content.text === name);
}

function nextTagColor(state: DocumentState) {
  const colors = ['red', 'orange', 'amber', 'yellow', 'green', 'teal', 'blue', 'indigo', 'violet', 'brown'];
  const count = Object.values(state.nodes).filter((node) => node.type === 'tagDef').length;
  return colors[count % colors.length];
}

function tagExtendsWouldCycle(state: DocumentState, tagId: string, parentTagId: string) {
  const visited = new Set<string>();
  let current: string | undefined = parentTagId;
  while (current) {
    if (current === tagId || visited.has(current)) return true;
    visited.add(current);
    current = configRefTarget(state, current, 'extends');
  }
  return false;
}

function ensureOptionsFieldDef(state: DocumentState, fieldDefId: string) {
  const fieldDef = requiredNode(state, fieldDefId);
  if (fieldDef.type !== 'fieldDef') throw CoreError.invalidOperation('options belong to field definitions');
  const fieldType = fieldTypeOf(state, fieldDefId);
  if (fieldType !== 'options' && fieldType !== 'options_from_supertag') {
    throw CoreError.invalidOperation('field definition is not an options field');
  }
  return fieldDef;
}

function ensureReferenceFieldDef(state: DocumentState, fieldDefId: string) {
  const fieldDef = requiredNode(state, fieldDefId);
  if (fieldDef.type !== 'fieldDef') throw CoreError.invalidOperation('references belong to field definitions');
  if (fieldTypeOf(state, fieldDefId) !== 'reference') {
    throw CoreError.invalidOperation('field definition is not a reference field');
  }
  return fieldDef;
}

function ensureCollectableOptionsFieldDef(state: DocumentState, fieldDefId: string) {
  const fieldDef = ensureOptionsFieldDef(state, fieldDefId);
  if (fieldTypeOf(state, fieldDefId) !== 'options') {
    throw CoreError.invalidOperation('only direct options fields can collect new options');
  }
  return fieldDef;
}

function findOptionByName(state: DocumentState, fieldDefId: string, name: string) {
  const needle = name.trim().toLowerCase();
  return state.nodes[fieldDefId]?.children.find((childId) =>
    !isInternalConfigNode(state.nodes[childId])
    && optionLabel(state, childId).trim().toLowerCase() === needle);
}

function ensureOptionBelongsToField(state: DocumentState, fieldDefId: string, optionNodeId: string) {
  const fieldDef = requiredNode(state, fieldDefId);
  const optionNode = requiredNode(state, optionNodeId);
  if (fieldTypeOf(state, fieldDefId) === 'options_from_supertag') {
    const sourceSupertag = configRefTarget(state, fieldDef.id, 'sourceSupertag');
    if (
      sourceSupertag
      && (!optionNode.type || optionNode.type === 'codeBlock')
      && optionNode.tags.includes(sourceSupertag)
    ) {
      return;
    }
    throw CoreError.invalidOperation('option does not match this field source tag');
  }
  if (optionNode.parentId !== fieldDefId) {
    throw CoreError.invalidOperation('option does not belong to this field definition');
  }
}

function optionValueTargetId(state: DocumentState, optionNodeId: string) {
  const optionNode = requiredNode(state, optionNodeId);
  if (optionNode.type !== 'reference') return optionNodeId;
  if (!optionNode.targetId || !state.nodes[optionNode.targetId]) throw CoreError.nodeNotFound(optionNode.targetId ?? optionNodeId);
  return optionNode.targetId;
}

function optionLabel(state: DocumentState, optionNodeId: string) {
  const optionNode = state.nodes[optionNodeId];
  if (!optionNode) return '';
  if (optionNode.type === 'reference' && optionNode.targetId) {
    return state.nodes[optionNode.targetId]?.content.text ?? optionNode.content.text;
  }
  return optionNode.content.text;
}

function ensureValidAutoInitialize(value: string) {
  const invalid = parseAutoInitStrategies(value, { includeInvalid: true })
    .filter((strategy) => !AUTO_INIT_STRATEGIES.includes(strategy as AutoInitStrategy));
  if (invalid.length > 0) throw CoreError.invalidOperation('invalid auto-initialize strategy');
}

function parseAutoInitStrategies(
  value: string | undefined,
  options: { includeInvalid?: boolean } = {},
): string[] {
  if (!value) return [];
  const strategies = value.split(',').map((strategy) => strategy.trim()).filter(Boolean);
  return options.includeInvalid
    ? strategies
    : strategies.filter((strategy): strategy is AutoInitStrategy =>
      AUTO_INIT_STRATEGIES.includes(strategy as AutoInitStrategy));
}

type AutoInitResult =
  | { kind: 'text'; value: string }
  | { kind: 'reference'; targetId: string };

function resolveAutoInit(state: DocumentState, nodeId: string, fieldDef: Node): AutoInitResult | null {
  const strategies = fieldAutoInitOf(state, fieldDef.id);
  for (const strategy of AUTO_INIT_PRIORITY) {
    if (!strategies.includes(strategy)) continue;
    const result = resolveAutoInitStrategy(state, nodeId, fieldDef, strategy);
    if (result) return result;
  }
  return null;
}

function resolveAutoInitStrategy(
  state: DocumentState,
  nodeId: string,
  fieldDef: Node,
  strategy: AutoInitStrategy,
): AutoInitResult | null {
  if (strategy === 'current_date') return { kind: 'text', value: formatLocalDate(new Date()) };
  if (strategy === 'ancestor_day_node') {
    const dayNode = ancestorsOf(state, nodeId).find((ancestor) =>
      ancestor.tags.some((tagId) =>
        tagId === TAG_DAY_ID || state.nodes[tagId]?.content.text.trim().toLowerCase() === 'day'));
    const value = dayNode?.content.text.trim();
    return value ? { kind: 'text', value } : null;
  }
  if (strategy === 'ancestor_field_value') {
    for (const ancestor of ancestorsOf(state, nodeId)) {
      const fieldEntry = ancestor.children
        .map((childId) => state.nodes[childId])
        .find((child) => child?.type === 'fieldEntry' && child.fieldDefId === fieldDef.id);
      const firstValue = fieldEntry?.children.map((childId) => state.nodes[childId]).find(Boolean);
      if (!firstValue) continue;
      if (firstValue.type === 'reference' && firstValue.targetId) {
        return { kind: 'reference', targetId: firstValue.targetId };
      }
      const value = firstValue.content.text.trim();
      if (value) return { kind: 'text', value };
    }
  }
  if (strategy === 'ancestor_supertag_ref') {
    const sourceSupertag = configRefTarget(state, fieldDef.id, 'sourceSupertag');
    if (!sourceSupertag) return null;
    const target = ancestorsOf(state, nodeId).find((ancestor) =>
      ancestor.tags.includes(sourceSupertag));
    return target ? { kind: 'reference', targetId: target.id } : null;
  }
  return null;
}

function ancestorsOf(state: DocumentState, nodeId: string): Node[] {
  const result: Node[] = [];
  const visited = new Set<string>();
  let currentId = state.nodes[nodeId]?.parentId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const current = state.nodes[currentId];
    if (!current) break;
    result.push(current);
    currentId = current.parentId;
  }
  return result;
}

function formatLocalDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isoWeek(date: Date) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function wouldCreateReferenceCycle(state: DocumentState, parentId: string, targetId: string) {
  if (parentId === targetId) return true;
  const stack = [targetId];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    if (id === parentId) return true;
    for (const childId of state.nodes[id]?.children ?? []) {
      const child = state.nodes[childId];
      if (!child) continue;
      if (child.type === 'reference' && child.targetId) stack.push(child.targetId);
      else stack.push(childId);
    }
  }
  return false;
}

function childInstanceTargetId(state: DocumentState, nodeId: string) {
  const node = requiredNode(state, nodeId);
  return node.type === 'reference' && node.targetId
    ? resolveReferenceTargetId(state, node.targetId)
    : node.id;
}

function ensureParentCanContainChildInstance(
  state: DocumentState,
  parentId: string,
  targetId: string,
  excludeNodeId?: string,
) {
  const parent = requiredNode(state, parentId);
  for (const childId of parent.children) {
    if (childId === excludeNodeId) continue;
    const child = state.nodes[childId];
    if (!child || child.parentId === TRASH_ID) continue;
    const childTargetId = child.type === 'reference' && child.targetId
      ? resolveReferenceTargetId(state, child.targetId)
      : child.id;
    if (childTargetId === targetId) throw CoreError.duplicateChildReference();
  }
}

function resolveReferenceTargetId(state: DocumentState, targetId: string) {
  let currentId = targetId;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(currentId)) throw CoreError.referenceCycle();
    visited.add(currentId);
    const current = state.nodes[currentId];
    if (!current) throw CoreError.nodeNotFound(currentId);
    if (current.type !== 'reference') return currentId;
    if (!current.targetId) throw CoreError.invalidOperation('reference node has no target');
    currentId = current.targetId;
  }
}

function isOnlyInlineReference(content: RichText, targetId: string) {
  const textEmpty = content.text.replace(/\u200B/g, '').trim().length === 0;
  if (textEmpty && content.inlineRefs.length === 0) return true;
  if (!textEmpty) return false;
  if (content.marks.length > 0) return false;
  return content.inlineRefs.length === 1
    && content.inlineRefs[0].offset === 0
    && inlineRefNodeId(content.inlineRefs[0]) === targetId;
}

function isSearchCandidate(state: DocumentState, nodeId: string) {
  const type = state.nodes[nodeId]?.type;
  return !isInTrash(state, nodeId)
    && !isSystemId(nodeId)
    && (type === undefined || ['tagDef', 'fieldDef', 'search', 'codeBlock'].includes(type));
}

function appendRichText(left: RichText, right: RichText): RichText {
  const offset = left.text.length;
  return {
    text: `${left.text}${right.text}`,
    marks: [
      ...clone(left.marks),
      ...right.marks.map((mark): TextMark => ({
        ...clone(mark),
        start: mark.start + offset,
        end: mark.end + offset,
      })),
    ],
    inlineRefs: [
      ...clone(left.inlineRefs),
      ...right.inlineRefs.map((ref) => ({
        ...clone(ref),
        offset: ref.offset + offset,
      })),
    ],
  };
}
