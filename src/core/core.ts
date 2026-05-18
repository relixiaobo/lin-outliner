import { CoreError } from './errors';
import { LoroOutlinerDocument, type SerializedLoroDocumentState } from './loroDocument';
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
  type Backlink,
  type CommandOutcome,
  type CreateNodeTree,
  type DocumentProjection,
  type DocumentState,
  type FieldConfigPatch,
  type FieldType,
  type FilterOp,
  type FocusHint,
  type Node,
  type NodeId,
  type NodeType,
  type QueryLogic,
  type QueryOp,
  type RichText,
  type RichTextPatch,
  type SearchNodeConfig,
  type SearchNodeCondition,
  type SearchHit,
  type SplitNodeOptions,
  type SortDirection,
  type TagConfigPatch,
  type TextMark,
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

  createNode(parentId: string, index: number | null | undefined, text: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureParentMutable(state, parentId);
      const id = this.createPlainNode(parentId, index, text);
      this.applyChildTagsDirect(parentId, id);
      return focus(id, { parentId, placement: { kind: 'end' } });
    });
  }

  createNodesFromTree(parentId: string, nodes: CreateNodeTree[]): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureParentMutable(state, parentId);
      let firstCreatedId: string | undefined;
      for (const node of nodes) {
        const createdId = this.insertNodeTreeDirect(parentId, node);
        firstCreatedId ??= createdId;
      }
      return firstCreatedId ? focus(firstCreatedId) : undefined;
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
      return focus(nodeId);
    });
  }

  setNodeCheckboxVisible(nodeId: string, visible: boolean): CommandOutcome {
    return this.patchNode(nodeId, (node) => {
      node.showCheckbox = visible;
    });
  }

  setNodeToolbarVisible(nodeId: string, visible: boolean): CommandOutcome {
    return this.patchNode(nodeId, (node) => {
      node.toolbarVisible = visible;
    });
  }

  setNodeSort(nodeId: string, field: string | null | undefined, direction?: SortDirection | null): CommandOutcome {
    return this.patchNode(nodeId, (node) => {
      setOptional(node, 'sortField', normalizeOptionalText(field));
      if (node.sortField) node.sortDirection = direction ?? 'asc';
      else delete node.sortDirection;
    });
  }

  setNodeFilter(
    nodeId: string,
    field: string | null | undefined,
    op?: FilterOp | null,
    values: string[] = [],
  ): CommandOutcome {
    return this.patchNode(nodeId, (node) => {
      setOptional(node, 'filterField', normalizeOptionalText(field));
      if (node.filterField) {
        node.filterOp = op ?? 'all';
        node.filterValues = normalizeTextList(values);
      } else {
        delete node.filterOp;
        node.filterValues = [];
      }
    });
  }

  setNodeGroup(nodeId: string, field: string | null | undefined): CommandOutcome {
    return this.patchNode(nodeId, (node) => {
      setOptional(node, 'groupField', normalizeOptionalText(field));
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
      const id = freshId('tag');
      const color = nextTagColor(state);
      this.loro.createNodeWithId(id, SCHEMA_ID, undefined, 'tagDef', (node) => {
        node.content = plainText(normalized);
        node.color = color;
      });
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
      if (patch.hideField) ensureValidHideFieldMode(patch.hideField.trim());
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
    if (!normalized) throw CoreError.invalidOperation('field name cannot be empty');
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
    if (!normalized) throw CoreError.invalidOperation('field name cannot be empty');
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
      ensureOptionsFieldDef(state, fieldDefId);
      return focus(this.ensureOptionNodeDirect(fieldDefId, normalized));
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
      for (const childId of [...fieldEntry.children]) this.removeSubtreeDirect(childId);
      this.loro.createNodeWithId(freshId('option_value'), fieldEntryId, undefined, 'reference', (node) => {
        node.targetId = optionNodeId;
      });
      return focus(fieldEntryId);
    });
  }

  addReference(parentId: string, targetId: string, index?: number | null): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureParentMutable(state, parentId);
      if (!state.nodes[targetId]) throw CoreError.nodeNotFound(targetId);
      if (wouldCreateReferenceCycle(state, parentId, targetId)) throw CoreError.referenceCycle();
      const id = freshId('ref');
      this.loro.createNodeWithId(id, parentId, index, 'reference', (node) => {
        node.targetId = targetId;
      });
      return focus(id);
    });
  }

  setReferenceTarget(referenceId: string, targetId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeMovable(state, referenceId);
      const current = clone(requiredNode(state, referenceId));
      if (current.type !== 'reference') throw CoreError.invalidOperation('expected a reference node');
      if (!state.nodes[targetId]) throw CoreError.nodeNotFound(targetId);
      const parentId = current.parentId;
      if (!parentId) throw CoreError.noParent();
      ensureParentMutable(state, parentId);
      if (wouldCreateReferenceCycle(state, parentId, targetId)) throw CoreError.referenceCycle();
      current.targetId = targetId;
      current.updatedAt = nowMs();
      this.loro.writeNode(current);
      return focus(referenceId);
    });
  }

  replaceNodeWithReference(nodeId: string, targetId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      ensureNodeMovable(state, nodeId);
      if (!state.nodes[targetId]) throw CoreError.nodeNotFound(targetId);
      const current = clone(requiredNode(state, nodeId));
      const parentId = current.parentId;
      if (!parentId) throw CoreError.noParent();
      ensureParentMutable(state, parentId);
      if (wouldCreateReferenceCycle(state, parentId, targetId)) throw CoreError.referenceCycle();
      if (current.type === 'reference') {
        current.targetId = targetId;
        current.updatedAt = nowMs();
        this.loro.writeNode(current);
        return focus(nodeId);
      }
      const index = childIndex(state, parentId, nodeId) ?? 0;
      const referenceId = freshId('ref');
      this.loro.createNodeWithId(referenceId, parentId, index, 'reference', (node) => {
        node.targetId = targetId;
      });
      current.trashedFromParentId = parentId;
      current.trashedFromIndex = index;
      this.loro.writeNode(current);
      this.loro.moveNode(nodeId, TRASH_ID, undefined);
      return focus(referenceId);
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

  searchNodes(query: string): SearchHit[] {
    this.refreshStateFromLoro();
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits: SearchHit[] = [];
    for (const node of Object.values(this.stateValue.nodes)) {
      if (!isSearchCandidate(this.stateValue, node.id)) continue;
      let score = 0;
      const text = node.content.text.toLowerCase();
      if (text === q) score += 100;
      else if (text.startsWith(q)) score += 60;
      else if (text.includes(q)) score += 30;
      for (const tagId of node.tags) {
        if (this.stateValue.nodes[tagId]?.content.text.toLowerCase().includes(q)) score += 15;
      }
      if (score > 0) hits.push({ nodeId: node.id, score });
    }
    return hits.sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId)).slice(0, 50);
  }

  ensureTagSearch(tagId: string): CommandOutcome {
    return this.mutate(() => {
      const state = this.snapshot();
      const tag = requiredNode(state, tagId);
      if (tag.type !== 'tagDef') throw CoreError.invalidOperation('tag search target must be a tag');
      const existing = Object.values(state.nodes).find((node) =>
        !isInTrash(state, node.id)
        && node.type === 'search'
        && node.queryOp === 'HAS_TAG'
        && node.queryTagDefId === tagId);
      const searchId = existing?.id ?? (() => {
        const id = freshId('search');
        this.loro.createNodeWithId(id, SEARCHES_ID, undefined, 'search', (node) => {
          node.content = plainText(`Everything tagged #${tag.content.text}`);
          node.queryLogic = 'AND';
          node.queryOp = 'HAS_TAG';
          node.queryTagDefId = tagId;
        });
        return id;
      })();
      this.refreshTagSearchChildrenDirect(searchId, tagId);
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
    const conditions = normalizeSearchConditions(config.conditions);
    node.type = 'search';
    node.content = plainText(normalizeSearchTitle(config.title));
    setOptional(node, 'viewMode', normalizeOptionalText(config.viewMode ?? null));
    node.queryLogic = 'AND';
    delete node.queryOp;
    delete node.queryTagDefId;
    delete node.queryFieldDefId;
    delete node.targetId;
    node.lastRefreshedAt = nowMs();
    const primary = conditions[0];
    if (conditions.length === 1 && primary?.op === 'HAS_TAG' && primary.tagId) {
      node.queryOp = 'HAS_TAG';
      node.queryTagDefId = primary.tagId;
    } else if (conditions.length === 1 && primary?.op === 'STRING_MATCH' && primary.text) {
      node.queryOp = 'STRING_MATCH';
    } else if (conditions.length === 1 && primary?.op === 'LINKS_TO' && primary.targetId) {
      node.queryOp = 'LINKS_TO';
      node.targetId = primary.targetId;
    } else if (conditions.length === 1 && primary?.op === 'FIELD_CONTAINS' && primary.fieldDefId) {
      node.queryOp = 'FIELD_CONTAINS';
      node.queryFieldDefId = primary.fieldDefId;
    }
    node.updatedAt = nowMs();
    this.loro.writeNode(node);

    const latest = this.snapshot();
    for (const childId of [...latest.nodes[nodeId]?.children ?? []]) {
      this.removeSubtreeDirect(childId);
    }
    for (const condition of conditions) {
      this.createSearchConditionDirect(nodeId, condition);
    }
  }

  private createSearchConditionDirect(parentId: string, condition: SearchNodeCondition) {
    this.loro.createNodeWithId(freshId('condition'), parentId, undefined, 'queryCondition', (node) => {
      node.queryLogic = 'AND';
      node.queryOp = condition.op;
      if (condition.op === 'HAS_TAG') {
        node.queryTagDefId = condition.tagId;
        const tag = condition.tagId ? this.snapshot().nodes[condition.tagId] : undefined;
        node.content = plainText(tag?.content.text ?? condition.tagId ?? '');
      } else if (condition.op === 'LINKS_TO') {
        node.targetId = condition.targetId;
        const target = condition.targetId ? this.snapshot().nodes[condition.targetId] : undefined;
        node.content = plainText(target?.content.text ?? condition.targetId ?? '');
      } else if (condition.op === 'FIELD_CONTAINS') {
        node.queryFieldDefId = condition.fieldDefId;
        node.content = plainText(condition.text ?? '');
      } else {
        node.content = plainText(condition.text ?? '');
      }
    });
  }

  private ensureSystemNodesDirect() {
    const now = nowMs();
    this.ensureSystemNodeDirect(WORKSPACE_ID, undefined, undefined, 'Lin Outliner', true, now);
    this.ensureSystemNodeDirect(DAILY_NOTES_ID, undefined, WORKSPACE_ID, 'Daily notes', true, now);
    this.ensureSystemNodeDirect(SCHEMA_ID, undefined, WORKSPACE_ID, 'Schema', true, now);
    this.ensureSystemNodeDirect(SEARCHES_ID, undefined, WORKSPACE_ID, 'Searches', true, now);
    this.ensureSystemNodeDirect(TRASH_ID, undefined, WORKSPACE_ID, 'Trash', true, now);
    this.ensureSystemNodeDirect(SETTINGS_ID, undefined, WORKSPACE_ID, 'Settings', true, now);
    this.ensureSystemNodeDirect(TAG_DAY_ID, 'tagDef', SCHEMA_ID, 'day', true, now);
    this.ensureSystemNodeDirect(TAG_WEEK_ID, 'tagDef', SCHEMA_ID, 'week', true, now);
    this.ensureSystemNodeDirect(TAG_YEAR_ID, 'tagDef', SCHEMA_ID, 'year', true, now);
    [DAILY_NOTES_ID, SCHEMA_ID, SEARCHES_ID, TRASH_ID, SETTINGS_ID].forEach((id, index) => {
      this.loro.moveNode(id, WORKSPACE_ID, index);
    });
    [TAG_DAY_ID, TAG_WEEK_ID, TAG_YEAR_ID].forEach((id, index) => {
      this.loro.moveNode(id, SCHEMA_ID, index);
    });
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

  private createPlainNode(parentId: string, index: number | null | undefined, text: string, type?: NodeType) {
    const id = freshId(type === 'reference' ? 'ref' : type === 'fieldEntry' ? 'field_entry' : 'node');
    this.loro.createNodeWithId(id, parentId, index, type, (node) => {
      node.content = plainText(text);
    });
    return id;
  }

  private insertNodeTreeDirect(parentId: string, tree: CreateNodeTree, index?: number | null): string {
    const id = freshId('node');
    this.loro.createNodeWithId(id, parentId, index, undefined, (node) => {
      node.content = clone(tree.content);
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
    const removedIds = new Set([nodeId, ...collectDescendantsFromState(state, nodeId)]);
    this.loro.deleteNode(nodeId);
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
    if (!node.tags.includes(tagId)) node.tags.push(tagId);
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
    return id;
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

  private refreshTagSearchChildrenDirect(searchId: string, tagId: string) {
    const state = this.snapshot();
    for (const childId of [...state.nodes[searchId]?.children ?? []]) this.removeSubtreeDirect(childId);
    const refreshed = this.snapshot();
    const targetIds = Object.values(refreshed.nodes)
      .filter((node) =>
        node.id !== searchId
        && node.id !== tagId
        && !isSystemId(node.id)
        && !isInTrash(refreshed, node.id)
        && node.type !== 'search'
        && node.tags.includes(tagId))
      .sort((left, right) => left.content.text.localeCompare(right.content.text) || left.id.localeCompare(right.id))
      .map((node) => node.id);
    for (const targetId of targetIds) {
      this.loro.createNodeWithId(freshId('ref'), searchId, undefined, 'reference', (node) => {
        node.targetId = targetId;
      });
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

function normalizeSearchTitle(value: string) {
  return value.trim() || 'Search';
}

function normalizeSearchConditions(conditions: SearchNodeCondition[]): SearchNodeCondition[] {
  const result: SearchNodeCondition[] = [];
  const seen = new Set<string>();
  for (const condition of conditions) {
    const normalized = condition.op === 'HAS_TAG'
      ? condition.tagId
        ? { op: 'HAS_TAG' as const, tagId: condition.tagId }
        : null
      : condition.op === 'LINKS_TO'
        ? condition.targetId
          ? { op: 'LINKS_TO' as const, targetId: condition.targetId }
          : null
      : condition.op === 'FIELD_CONTAINS'
        ? condition.fieldDefId
          ? { op: 'FIELD_CONTAINS' as const, fieldDefId: condition.fieldDefId, text: condition.text?.trim() ?? '' }
          : null
        : condition.text?.trim()
          ? { op: 'STRING_MATCH' as const, text: condition.text.trim() }
          : null;
    if (!normalized) continue;
    const key = normalized.op === 'HAS_TAG'
      ? `tag:${normalized.tagId}`
      : normalized.op === 'LINKS_TO'
        ? `link:${normalized.targetId}`
        : normalized.op === 'FIELD_CONTAINS'
          ? `field:${normalized.fieldDefId}:${normalized.text.toLowerCase()}`
          : `text:${normalized.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
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
}

function findOptionByName(state: DocumentState, fieldDefId: string, name: string) {
  const needle = name.trim().toLowerCase();
  return state.nodes[fieldDefId]?.children.find((childId) =>
    state.nodes[childId]?.content.text.trim().toLowerCase() === needle);
}

function ensureOptionBelongsToField(state: DocumentState, fieldDefId: string, optionNodeId: string) {
  if (requiredNode(state, optionNodeId).parentId !== fieldDefId) {
    throw CoreError.invalidOperation('option does not belong to this field definition');
  }
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
