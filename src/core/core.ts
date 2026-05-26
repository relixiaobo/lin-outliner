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
import { buildDocumentProjection } from './projection';
import { runSearchExpr, runSearchNode, searchNodeHasRules } from './searchEngine';
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
  plainText,
  type Backlink,
  type CommandOutcome,
  type CreateNodeTree,
  type DocumentProjection,
  type DocumentState,
  type AutoInitStrategy,
  type FieldCardinality,
  type FieldConfigPatch,
  type FieldType,
  type DisplayPlacement,
  type FilterOperator,
  type FilterValueLogic,
  type FocusHint,
  type IconKind,
  type Node,
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

  constructor(state?: CoreSerializedState) {
    this.loro = new LoroOutlinerDocument(state);
    this.history = new OperationJournal(state?.operationHistory);

    if (this.loro.isEmpty()) {
      this.ensureSystemNodesDirect();
      this.ensureCurrentTodayNodeDirect();
      this.loro.commit('__seed__');
    } else {
      const existing = this.loro.materializeState();
      this.ensureSystemNodesDirect();
      this.ensureCurrentTodayNodeDirect();
      const normalized = this.loro.materializeState();
      if (!sameJson(existing, normalized)) {
        this.loro.commit(SYSTEM_COMMIT_ORIGIN);
      }
    }

    this.stateValue = this.loro.materializeState();
    this.loro.clearTouchedNodeIds();
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
    return JSON.stringify(serialized, null, 2);
  }

  projection(): DocumentProjection {
    this.refreshStateFromLoro();
    const todayId = this.currentTodayNodeId();
    return buildDocumentProjection(this.stateValue, todayId);
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
      if (transaction && !sameJson(after, transaction.before)) {
        this.commitCurrentTransaction(transaction.origin, transaction.before, after, transaction.metadata, affectedNodeIds);
      }
      this.activeTransaction = undefined;
      this.refreshStateFromLoro();
      return result;
    } catch (error) {
      this.loro.revertTo(rollbackFrontiers, SYSTEM_COMMIT_ORIGIN);
      this.loro.clearTouchedNodeIds();
      this.activeTransaction = undefined;
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
      this.loro.createNodeWithId(id, parentId, index, 'image', (node) => {
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
      node.type = 'image';
      if (source.assetId) {
        node.assetId = source.assetId;
        delete node.mediaUrl;
      } else {
        node.mediaUrl = source.mediaUrl;
        delete node.assetId;
      }
      if (options.width != null) node.imageWidth = options.width;
      else delete node.imageWidth;
      if (options.height != null) node.imageHeight = options.height;
      else delete node.imageHeight;
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

  pasteNodesIntoNode(
    nodeId: string,
    content: RichText,
    children: CreateNodeTree[],
    siblingsAfter: CreateNodeTree[],
  ): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeEditable(state, nodeId);
      const parentId = state.nodes[nodeId]?.parentId;
      if (!parentId) throw CoreError.noParent();
      const siblingIndex = (childIndex(state, parentId, nodeId) ?? 0) + 1;
      const node = clone(requiredNode(state, nodeId));
      node.content = clone(content);
      node.updatedAt = nowMs();
      this.loro.writeNode(node);

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
      node.showCheckbox = visible;
    });
  }

  setCodeBlock(nodeId: string, codeLanguage?: string): CommandOutcome {
    return this.patchNode(nodeId, (node) => {
      if (node.type !== undefined && node.type !== 'codeBlock') {
        throw CoreError.invalidOperation('only plain content nodes can become code blocks');
      }
      node.type = 'codeBlock';
      setOptional(node, 'codeLanguage', normalizeCodeLanguage(codeLanguage));
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
      this.loro.createNodeWithId(freshId('sort'), viewDefId, undefined, 'sortRule', (node) => {
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
      this.loro.createNodeWithId(freshId('filter'), viewDefId, undefined, 'filterRule', (node) => {
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
      this.loro.createNodeWithId(freshId('display'), viewDefId, undefined, 'displayField', (node) => {
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
      const node = clone(requiredNode(state, nodeId));
      node.showCheckbox = true;
      if (node.completedAt) delete node.completedAt;
      else node.completedAt = nowMs();
      node.updatedAt = nowMs();
      this.loro.writeNode(node);
      return focus(nodeId);
    });
  }

  cycleDoneState(nodeId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeEditable(state, nodeId);
      const node = clone(requiredNode(state, nodeId));
      cycleNodeDoneState(node);
      node.updatedAt = nowMs();
      this.loro.writeNode(node);
      return focus(nodeId);
    });
  }

  batchIndentNodes(nodeIds: string[]): CommandOutcome {
    return this.mutate(() => {
      for (const nodeId of nodeIds) {
        const state = this.snapshot();
        if (!state.nodes[nodeId]) continue;
        try {
          ensureNodeMovable(state, nodeId);
          const parentId = state.nodes[nodeId].parentId;
          if (!parentId) continue;
          const index = childIndex(state, parentId, nodeId);
          if (!index) continue;
          const newParentId = requiredNode(state, parentId).children[index - 1];
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
        const node = clone(requiredNode(state, nodeId));
        node.showCheckbox = true;
        if (node.completedAt) delete node.completedAt;
        else node.completedAt = nowMs();
        node.updatedAt = nowMs();
        this.loro.writeNode(node);
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
        const node = clone(requiredNode(state, nodeId));
        cycleNodeDoneState(node);
        node.updatedAt = nowMs();
        this.loro.writeNode(node);
      }
      return undefined;
    });
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
      if ('color' in patch) setOptional(node, 'color', normalizeOptionalText(patch.color));
      if ('extends' in patch) setOptional(node, 'extends', normalizeOptionalText(patch.extends));
      if ('childSupertag' in patch) setOptional(node, 'childSupertag', normalizeOptionalText(patch.childSupertag));
      if (patch.showCheckbox !== undefined) node.showCheckbox = patch.showCheckbox;
      if (patch.doneStateEnabled !== undefined) node.doneStateEnabled = patch.doneStateEnabled;
      node.updatedAt = nowMs();
      this.loro.writeNode(node);
      return focus(tagId);
    });
  }

  setFieldConfig(fieldId: string, patch: FieldConfigPatch): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeEditable(state, fieldId);
      ensureFieldDefinition(state, fieldId);
      const current = clone(requiredNode(state, fieldId));
      const nextFieldType = patch.fieldType ?? current.fieldType ?? 'plain';
      const nextMin = 'minValue' in patch ? patch.minValue ?? undefined : current.minValue;
      const nextMax = 'maxValue' in patch ? patch.maxValue ?? undefined : current.maxValue;
      if (patch.sourceSupertag) {
        ensureTagDefinition(state, patch.sourceSupertag);
        if (nextFieldType !== 'options_from_supertag') {
          throw CoreError.invalidOperation('source supertag is only valid for options-from-supertag fields');
        }
      }
      if (patch.autocollectOptions === true && nextFieldType !== 'options') {
        throw CoreError.invalidOperation('auto-collect options is only valid for options fields');
      }
      if (patch.cardinality && !isFieldCardinality(patch.cardinality)) {
        throw CoreError.invalidOperation('invalid field cardinality');
      }
      if (patch.hideField) ensureValidHideFieldMode(patch.hideField.trim());
      if (patch.autoInitialize) ensureValidAutoInitialize(patch.autoInitialize);
      if (nextMin !== undefined && nextMax !== undefined && nextMin > nextMax) {
        throw CoreError.invalidOperation('minimum value cannot be greater than maximum value');
      }
      if (patch.fieldType !== undefined) {
        current.fieldType = patch.fieldType;
        if (patch.fieldType !== 'options_from_supertag') delete current.sourceSupertag;
        if (patch.fieldType !== 'options') current.autocollectOptions = false;
        if (patch.fieldType !== 'number') {
          delete current.minValue;
          delete current.maxValue;
        }
      }
      if ('cardinality' in patch) setOptional(current, 'cardinality', patch.cardinality ?? undefined);
      if ('sourceSupertag' in patch) setOptional(current, 'sourceSupertag', normalizeOptionalText(patch.sourceSupertag));
      if ('nullable' in patch) setOptional(current, 'nullable', patch.nullable ?? undefined);
      if ('hideField' in patch) setOptional(current, 'hideField', normalizeOptionalText(patch.hideField));
      if ('autoInitialize' in patch) setOptional(current, 'autoInitialize', normalizeOptionalText(patch.autoInitialize));
      if (patch.autocollectOptions !== undefined) current.autocollectOptions = patch.autocollectOptions;
      if ('minValue' in patch) setOptional(current, 'minValue', patch.minValue ?? undefined);
      if ('maxValue' in patch) setOptional(current, 'maxValue', patch.maxValue ?? undefined);
      current.updatedAt = nowMs();
      this.loro.writeNode(current);
      return focus(fieldId);
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
      const node = clone(requiredNode(state, afterNodeId));
      node.type = 'fieldEntry';
      node.fieldDefId = fieldDefId;
      node.content = plainText('');
      node.tags = [];
      node.showCheckbox = false;
      node.doneStateEnabled = false;
      delete node.completedAt;
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

  registerCollectedOption(fieldDefId: string, name: string): CommandOutcome {
    const normalized = name.trim();
    if (!normalized) throw CoreError.invalidOperation('option name cannot be empty');
    return this.mutate(() => {
      const state = this.snapshot();
      ensureCollectableOptionsFieldDef(state, fieldDefId);
      return focus(this.ensureOptionNodeDirect(fieldDefId, normalized));
    });
  }

  createCollectedFieldOption(fieldEntryId: string, name: string): CommandOutcome {
    const normalized = name.trim();
    if (!normalized) throw CoreError.invalidOperation('option name cannot be empty');
    return this.mutate(() => {
      const state = this.snapshot();
      const fieldEntry = requiredNode(state, fieldEntryId);
      if (fieldEntry.type !== 'fieldEntry') throw CoreError.invalidOperation('options can only be created on field entries');
      const fieldDefId = fieldEntry.fieldDefId;
      if (!fieldDefId) throw CoreError.invalidOperation('field entry has no field definition');
      const fieldDef = ensureCollectableOptionsFieldDef(state, fieldDefId);
      const existingOptionId = findOptionByName(state, fieldDefId, normalized);
      if (existingOptionId) {
        this.selectFieldOptionDirect(fieldEntryId, fieldDefId, existingOptionId);
        return focus(fieldEntryId);
      }

      if (fieldDef.cardinality !== 'list') {
        this.clearFieldEntryValuesDirect(fieldEntryId, fieldDefId);
      }

      const valueId = freshId('option_value');
      this.loro.createNodeWithId(valueId, fieldEntryId, undefined, undefined, (node) => {
        node.content = plainText(normalized);
      });
      this.loro.createNodeWithId(freshId('option_ref'), fieldDefId, undefined, 'reference', (node) => {
        node.targetId = valueId;
        node.autoCollected = true;
      });
      return focus(fieldEntryId);
    });
  }

  selectFieldOption(fieldEntryId: string, optionNodeId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      const fieldEntry = requiredNode(state, fieldEntryId);
      if (fieldEntry.type !== 'fieldEntry') throw CoreError.invalidOperation('options can only be selected on field entries');
      const fieldDefId = fieldEntry.fieldDefId;
      if (!fieldDefId) throw CoreError.invalidOperation('field entry has no field definition');
      ensureOptionsFieldDef(state, fieldDefId);
      ensureOptionBelongsToField(state, fieldDefId, optionNodeId);
      this.selectFieldOptionDirect(fieldEntryId, fieldDefId, optionNodeId);
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

  addReference(parentId: string, targetId: string, index?: number | null): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureParentMutable(state, parentId);
      const resolvedTargetId = resolveReferenceTargetId(state, targetId);
      if (wouldCreateReferenceCycle(state, parentId, resolvedTargetId)) throw CoreError.referenceCycle();
      ensureParentCanContainChildInstance(state, parentId, resolvedTargetId);
      const id = freshId('ref');
      this.loro.createNodeWithId(id, parentId, index, 'reference', (node) => {
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
      this.loro.createNodeWithId(referenceId, parentId, index, 'reference', (node) => {
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
      this.loro.createNodeWithId(referenceId, parentId, index, 'reference', (reference) => {
        reference.targetId = resolvedTargetId;
      });
      this.removeSubtreeDirect(nodeId);
      return focus(referenceId, { parentId });
    });
  }

  ensureDateNode(year: number, month: number, day: number): CommandOutcome {
    return this.mutate(() => focus(this.ensureDateNodeDirect(year, month, day)));
  }

  createSearchNode(parentId: string, index: number | null | undefined, config: SearchNodeConfig): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureParentMutable(state, parentId);
      const searchId = freshId('search');
      this.loro.createNodeWithId(searchId, parentId, index, 'search', (node) => {
        node.content = plainText(normalizeSearchTitle(config.title));
      });
      this.writeSearchNodeConfigDirect(searchId, config);
      return focus(searchId);
    });
  }

  setSearchNode(nodeId: string, config: SearchNodeConfig): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeEditable(state, nodeId);
      this.writeSearchNodeConfigDirect(nodeId, config);
      return focus(nodeId);
    });
  }

  refreshSearchNodeResults(nodeId: string): CommandOutcome {
    return this.mutate(() => {
      this.materializeSearchNodeResultsDirect(nodeId);
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
      if (node.type === 'reference' && node.targetId === targetId && node.parentId) {
        result.push({ sourceId: node.parentId, referenceId: node.id, kind: 'tree' });
      }
      for (const inlineRef of node.content.inlineRefs) {
        if (inlineRef.targetNodeId === targetId) {
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

  private patchNode(nodeId: string, patch: (node: Node) => void): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeEditable(state, nodeId);
      const node = clone(requiredNode(state, nodeId));
      patch(node);
      node.updatedAt = nowMs();
      this.loro.writeNode(node);
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
    this.loro.createNodeWithId(viewDefId, nodeId, 0, 'viewDef', (node) => {
      node.viewMode = 'list';
      node.toolbarVisible = false;
    });
    return viewDefId;
  }

  private patchViewDefDirect(nodeId: string, patch: (viewDef: Node) => void) {
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
      this.refreshStateFromLoro();
      return { projection: this.projection(), ...(focusHint ? { focus: focusHint } : {}) };
    }

    const before = this.loro.materializeState();
    this.loro.clearTouchedNodeIds();
    const focusHint = mutator();
    const after = this.loro.materializeState();
    const affectedNodeIds = this.loro.drainTouchedNodeIds();
    if (!sameJson(after, before)) {
      this.commitCurrentTransaction(this.currentCommitOrigin(), before, after, this.currentCommitMetadata(), affectedNodeIds);
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
    this.loro.rebuildMappings();
    this.stateValue = this.loro.materializeState();
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

  private writeSearchNodeConfigDirect(nodeId: string, config: SearchNodeConfig) {
    const state = this.snapshot();
    const node = clone(requiredNode(state, nodeId));
    node.type = 'search';
    node.content = plainText(normalizeSearchTitle(config.title));
    delete node.queryOp;
    delete node.queryLogic;
    delete node.queryTagDefId;
    delete node.queryFieldDefId;
    delete node.targetId;
    node.updatedAt = nowMs();
    this.loro.writeNode(node);

    const latest = this.snapshot();
    for (const childId of [...latest.nodes[nodeId]?.children ?? []]) {
      if (latest.nodes[childId]?.type === 'queryCondition') this.removeSubtreeDirect(childId);
    }
    this.createSearchQueryConditionDirect(nodeId, config.query, 0);
    this.materializeSearchNodeResultsDirect(nodeId);
  }

  private materializeSearchNodeResultsDirect(nodeId: string) {
    const state = this.snapshot();
    const searchNode = requiredNode(state, nodeId);
    if (searchNode.type !== 'search') throw CoreError.invalidOperation('expected a search node');

    const result = searchNodeHasRules(state, nodeId)
      ? runSearchNode(state, nodeId)
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
      this.loro.createNodeWithId(freshId('ref'), nodeId, undefined, 'reference', (node) => {
        node.targetId = targetId;
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
    this.loro.createNodeWithId(conditionId, parentId, index, 'queryCondition', (node) => {
      if (query.kind === 'group') {
        node.queryLogic = query.logic;
        node.content = plainText(query.logic);
      } else {
        node.queryOp = query.op;
        node.content = plainText(query.text ?? searchRuleTitle(state, query));
        if (query.fieldDefId) node.queryFieldDefId = query.fieldDefId;
        if (query.tagDefId) node.queryTagDefId = query.tagDefId;
        if (query.targetId) node.targetId = query.targetId;
      }
    });
    if (query.kind === 'group') {
      for (const child of query.children) this.createSearchQueryConditionDirect(conditionId, child);
    } else {
      for (const operand of query.operands ?? []) this.createSearchQueryOperandDirect(conditionId, operand);
    }
  }

  private createSearchQueryOperandDirect(parentId: string, operand: SearchQueryOperand) {
    this.loro.createNodeWithId(freshId(operand.targetId ? 'ref' : 'operand'), parentId, undefined, operand.targetId ? 'reference' : undefined, (node) => {
      node.content = plainText(operand.text ?? '');
      if (operand.targetId) node.targetId = operand.targetId;
    });
  }

  private ensureSystemNodesDirect() {
    const now = nowMs();
    this.ensureSystemNodeDirect(WORKSPACE_ID, undefined, undefined, 'Lin Outliner', true, now);
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
    [DAILY_NOTES_ID, LIBRARY_ID, SEARCHES_ID, TRASH_ID].forEach((id, index) => {
      this.loro.moveNode(id, WORKSPACE_ID, index);
    });
    this.loro.moveNode(RECENTS_ID, SEARCHES_ID, 0);
    [TAG_DAY_ID, TAG_WEEK_ID, TAG_YEAR_ID].forEach((id, index) => {
      this.loro.moveNode(id, SCHEMA_ID, index);
    });
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
      .find((node) => node?.type === 'queryCondition');
    const viewDef = recents.children
      .map((childId) => state.nodes[childId])
      .find((node) => node?.type === 'viewDef');
    const sortRule = viewDef?.children
      .map((childId) => state.nodes[childId])
      .find((node) => node?.type === 'sortRule');
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
    this.loro.createNodeWithId(freshId('sort'), viewDefId, undefined, 'sortRule', (node) => {
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
    if (!node.content.text) node.content = plainText(name);
    node.locked = locked;
    node.updatedAt = node.updatedAt || now;
    this.loro.writeNode(node);
    if (parentId && node.parentId !== parentId) this.loro.moveNode(id, parentId, undefined);
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
        targetNodeId: targetId,
        displayName: target.content.text || undefined,
      }],
    });
  }

  private createTagDefDirect(name: string) {
    const id = freshId('tag');
    const color = nextTagColor(this.snapshot());
    this.loro.createNodeWithId(id, SCHEMA_ID, undefined, 'tagDef', (node) => {
      node.content = plainText(name);
      node.color = color;
    });
    return id;
  }

  private insertNodeTreeDirect(parentId: string, tree: CreateNodeTree, index?: number | null): string {
    const id = freshId('node');
    // Paste trees may carry a node type; only `codeBlock` is honored so the
    // materialization surface stays narrow and predictable.
    const type = tree.type === 'codeBlock' ? 'codeBlock' : undefined;
    this.loro.createNodeWithId(id, parentId, index, type, (node) => {
      node.content = clone(tree.content);
      if (type === 'codeBlock') {
        setOptional(node, 'codeLanguage', normalizeCodeLanguage(tree.codeLanguage));
      }
    });
    this.applyChildTagsDirect(parentId, id);
    for (const child of tree.children) this.insertNodeTreeDirect(id, child);
    return id;
  }

  private insertFieldDefNodeDirect(parentId: string, name: string, fieldType: FieldType) {
    const id = freshId('field');
    this.loro.createNodeWithId(id, parentId, undefined, 'fieldDef', (node) => {
      node.content = plainText(name);
      node.fieldType = fieldType;
      node.cardinality = 'single';
      node.nullable = true;
    });
    return id;
  }

  private insertFieldEntryNodeDirect(parentId: string, index: number | null | undefined, fieldDefId: string) {
    const id = freshId('field_entry');
    this.loro.createNodeWithId(id, parentId, index, 'fieldEntry', (node) => {
      node.fieldDefId = fieldDefId;
      node.content = plainText('');
    });
    return id;
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
      if (next.targetId && removedIds.has(next.targetId)) delete next.targetId;
      next.content.inlineRefs = next.content.inlineRefs.filter((ref) => !removedIds.has(ref.targetNodeId));
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
    const clonedId = freshId('copy');
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
      const childSupertag = state.nodes[tagId]?.childSupertag;
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
    for (const templateNodeId of getTemplateContentNodes(state, tagId)) {
      this.cloneTemplateContentNodeShallowDirect(nodeId, templateNodeId);
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
    if (!fieldDef?.autoInitialize) return;
    const result = resolveAutoInit(state, nodeId, fieldDef);
    if (!result) return;
    if (result.kind === 'reference') {
      this.loro.createNodeWithId(freshId('auto_value'), fieldEntryId, undefined, 'reference', (node) => {
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
      this.loro.createNodeWithId(freshId('value'), fieldEntryId, undefined, value.type, (node) => {
        node.content = clone(value.content);
        node.description = value.description;
        node.fieldDefId = value.fieldDefId;
        node.targetId = value.targetId;
        node.codeLanguage = value.codeLanguage;
      });
    }
  }

  private cloneTemplateContentNodeShallowDirect(parentId: string, templateNodeId: string) {
    const state = this.snapshot();
    const parent = requiredNode(state, parentId);
    if (parent.children.some((childId) => state.nodes[childId]?.templateId === templateNodeId)) return;
    const template = requiredNode(state, templateNodeId);
    this.loro.createNodeWithId(freshId('template'), parentId, undefined, template.type, (node) => {
      node.templateId = templateNodeId;
      node.content = clone(template.content);
      node.description = template.description;
      node.codeLanguage = template.codeLanguage;
      node.mediaUrl = template.mediaUrl;
      node.mediaAlt = template.mediaAlt;
      node.imageWidth = template.imageWidth;
      node.imageHeight = template.imageHeight;
      node.embedType = template.embedType;
      node.embedId = template.embedId;
      node.sourceUrl = template.sourceUrl;
      node.aiSummary = template.aiSummary;
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

  private selectFieldOptionDirect(fieldEntryId: string, fieldDefId: string, optionNodeId: string) {
    const state = this.snapshot();
    const fieldEntry = requiredNode(state, fieldEntryId);
    const fieldDef = requiredNode(state, fieldDefId);
    const optionTargetId = optionValueTargetId(state, optionNodeId);
    const isList = fieldDef.cardinality === 'list';
    const alreadySelected = fieldEntry.children.some((childId) => (
      childId === optionTargetId || state.nodes[childId]?.targetId === optionTargetId
    ));
    if (alreadySelected) {
      return;
    }
    if (!isList) {
      this.clearFieldEntryValuesDirect(fieldEntryId, fieldDefId);
    }
    this.loro.createNodeWithId(freshId('option_value'), fieldEntryId, undefined, 'reference', (node) => {
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
    const target = clone(requiredNode(state, targetId));
    target.content = appendRichText(target.content, current.content);
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
    if (node.content.inlineRefs.some((ref) => ref.targetNodeId === targetId)) return true;
  }
  return false;
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
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

function cycleNodeDoneState(node: Node) {
  const hasCheckboxAffordance = node.showCheckbox || node.doneStateEnabled || Boolean(node.completedAt);
  if (!hasCheckboxAffordance) {
    node.showCheckbox = true;
    delete node.completedAt;
    return;
  }
  if (!node.completedAt) {
    node.showCheckbox = true;
    node.completedAt = nowMs();
    return;
  }
  delete node.completedAt;
  node.showCheckbox = Boolean(node.doneStateEnabled);
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

function ensureParentMutable(state: DocumentState, parentId: string) {
  if (!state.nodes[parentId]) throw CoreError.parentNotFound(parentId);
}

function ensureNodeEditable(state: DocumentState, nodeId: string) {
  const node = requiredNode(state, nodeId);
  if (node.locked) throw CoreError.lockedNode(nodeId);
}

function ensureNodeMovable(state: DocumentState, nodeId: string) {
  const node = requiredNode(state, nodeId);
  if (node.locked || isSystemId(nodeId)) throw CoreError.lockedNode(nodeId);
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
  return condition?.queryOp === 'HAS_TAG' && condition.queryTagDefId === tagId;
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
    && (node.filterValues?.length ?? 0) === 0
    && !node.description;
}

function isSystemId(nodeId: string) {
  return [
    WORKSPACE_ID,
    DAILY_NOTES_ID,
    SCHEMA_ID,
    SEARCHES_ID,
    TRASH_ID,
    SETTINGS_ID,
    TAG_DAY_ID,
    TAG_WEEK_ID,
    TAG_YEAR_ID,
  ].includes(nodeId);
}

function touchNode(state: DocumentState, nodeId: string) {
  if (state.nodes[nodeId]) state.nodes[nodeId].updatedAt = nowMs();
}

function getExtendsChain(state: DocumentState, tagId: string): string[] {
  const chain: string[] = [];
  const visited = new Set<string>();
  let current: string | undefined = tagId;
  while (current && !visited.has(current)) {
    visited.add(current);
    chain.push(current);
    current = state.nodes[current]?.extends;
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
    current = state.nodes[current]?.extends;
  }
  return false;
}

function ensureOptionsFieldDef(state: DocumentState, fieldDefId: string) {
  const fieldDef = requiredNode(state, fieldDefId);
  if (fieldDef.type !== 'fieldDef') throw CoreError.invalidOperation('options belong to field definitions');
  if (fieldDef.fieldType !== 'options' && fieldDef.fieldType !== 'options_from_supertag') {
    throw CoreError.invalidOperation('field definition is not an options field');
  }
  return fieldDef;
}

function ensureCollectableOptionsFieldDef(state: DocumentState, fieldDefId: string) {
  const fieldDef = ensureOptionsFieldDef(state, fieldDefId);
  if (fieldDef.fieldType !== 'options') {
    throw CoreError.invalidOperation('only direct options fields can collect new options');
  }
  return fieldDef;
}

function findOptionByName(state: DocumentState, fieldDefId: string, name: string) {
  const needle = name.trim().toLowerCase();
  return state.nodes[fieldDefId]?.children.find((childId) =>
    optionLabel(state, childId).trim().toLowerCase() === needle);
}

function ensureOptionBelongsToField(state: DocumentState, fieldDefId: string, optionNodeId: string) {
  const fieldDef = requiredNode(state, fieldDefId);
  const optionNode = requiredNode(state, optionNodeId);
  if (fieldDef.fieldType === 'options_from_supertag') {
    const sourceSupertag = fieldDef.sourceSupertag;
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

function isFieldCardinality(value: string): value is FieldCardinality {
  return value === 'single' || value === 'list';
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
  const strategies = parseAutoInitStrategies(fieldDef.autoInitialize) as AutoInitStrategy[];
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
  if (strategy === 'ancestor_supertag_ref' && fieldDef.sourceSupertag) {
    const target = ancestorsOf(state, nodeId).find((ancestor) =>
      ancestor.tags.includes(fieldDef.sourceSupertag!));
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
    && content.inlineRefs[0].targetNodeId === targetId;
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
