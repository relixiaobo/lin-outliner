import { CoreError } from './errors';
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
  createNodeRecord,
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
  type NodeProjection,
  type NodeType,
  type QueryLogic,
  type QueryOp,
  type RichText,
  type SearchHit,
  type SortDirection,
  type TagConfigPatch,
  type TextMark,
} from './types';

type Mutator = (state: DocumentState) => FocusHint | undefined;
type MoveDirection = 'up' | 'down';

interface TemplateFieldRef {
  fieldDefId: NodeId;
  templateOriginId: NodeId;
}

export class Core {
  private stateValue: DocumentState;
  private undoStack: DocumentState[] = [];
  private redoStack: DocumentState[] = [];

  constructor(state?: DocumentState) {
    this.stateValue = state ? cloneState(state) : {
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      rootId: WORKSPACE_ID,
      nodes: {},
    };
    ensureSystemNodes(this.stateValue);
  }

  static new() {
    return new Core();
  }

  static fromState(state: DocumentState) {
    return new Core(state);
  }

  static deserializeState(raw: string): DocumentState {
    return normalizeState(JSON.parse(raw) as DocumentState);
  }

  state() {
    return this.stateValue;
  }

  intoState() {
    return cloneState(this.stateValue);
  }

  serializeState() {
    return JSON.stringify(this.stateValue, null, 2);
  }

  projection(): DocumentProjection {
    const todayId = this.ensureTodayNodeNoHistory();
    return this.buildProjection(todayId);
  }

  createNode(parentId: string, index: number | null | undefined, text: string): CommandOutcome {
    return this.mutate((state) => {
      ensureParentMutable(state, parentId);
      const id = freshId('node');
      insertNode(state, id, parentId, index, undefined, (node) => {
        node.content = plainText(text);
      });
      applyChildTags(state, parentId, id);
      return focus(id);
    });
  }

  createNodesFromTree(parentId: string, nodes: CreateNodeTree[]): CommandOutcome {
    return this.mutate((state) => {
      ensureParentMutable(state, parentId);
      let firstCreatedId: string | undefined;
      for (const node of nodes) {
        const createdId = insertNodeTree(state, parentId, node);
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
    return this.mutate((state) => {
      ensureNodeEditable(state, nodeId);
      const parentId = state.nodes[nodeId]?.parentId;
      if (!parentId) throw CoreError.noParent();
      const siblingIndex = (childIndex(state, parentId, nodeId) ?? 0) + 1;
      const node = requiredNode(state, nodeId);
      node.content = clone(content);
      node.updatedAt = nowMs();

      for (const child of children) insertNodeTree(state, nodeId, child);

      let focusId = nodeId;
      siblingsAfter.forEach((sibling, offset) => {
        focusId = insertNodeTreeAt(state, parentId, siblingIndex + offset, sibling);
      });
      return focus(focusId);
    });
  }

  splitNode(nodeId: string, before: RichText, after: RichText): CommandOutcome {
    return this.mutate((state) => {
      ensureNodeEditable(state, nodeId);
      const parentId = state.nodes[nodeId]?.parentId;
      if (!parentId) throw CoreError.noParent();
      const index = (childIndex(state, parentId, nodeId) ?? 0) + 1;
      const node = requiredNode(state, nodeId);
      node.content = clone(before);
      node.updatedAt = nowMs();

      const newId = freshId('node');
      const tags = [...node.tags];
      insertNode(state, newId, parentId, index, undefined, (created) => {
        created.content = clone(after);
        created.tags = tags;
      });
      for (const tagId of tags) instantiateTagTemplate(state, newId, tagId);
      return focus(newId);
    });
  }

  updateNodeText(nodeId: string, content: RichText): CommandOutcome {
    return this.mutate((state) => {
      ensureNodeEditable(state, nodeId);
      const node = requiredNode(state, nodeId);
      node.content = clone(content);
      node.updatedAt = nowMs();
      return focus(nodeId);
    });
  }

  updateNodeDescription(nodeId: string, description: string | null | undefined): CommandOutcome {
    return this.mutate((state) => {
      ensureNodeEditable(state, nodeId);
      const node = requiredNode(state, nodeId);
      setOptional(node, 'description', normalizeOptionalText(description));
      node.updatedAt = nowMs();
      return focus(nodeId);
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
    return this.mutate((state) => {
      ensureNodeEditable(state, nodeId);
      ensureNodeEditable(state, targetId);
      mergeNodeIntoTarget(state, nodeId, targetId);
      return focus(targetId);
    });
  }

  moveNode(nodeId: string, parentId: string, index?: number | null): CommandOutcome {
    return this.mutate((state) => {
      ensureNodeMovable(state, nodeId);
      ensureParentMutable(state, parentId);
      moveNodeNoTouch(state, nodeId, parentId, index);
      touchNode(state, nodeId);
      return focus(nodeId);
    });
  }

  indentNode(nodeId: string): CommandOutcome {
    return this.mutate((state) => {
      ensureNodeMovable(state, nodeId);
      const parentId = requiredNode(state, nodeId).parentId;
      if (!parentId) throw CoreError.noParent();
      const index = childIndex(state, parentId, nodeId);
      if (!index) throw CoreError.noPreviousSibling();
      const newParentId = requiredNode(state, parentId).children[index - 1];
      ensureParentMutable(state, newParentId);
      moveNodeNoTouch(state, nodeId, newParentId, undefined);
      return focus(nodeId);
    });
  }

  outdentNode(nodeId: string): CommandOutcome {
    return this.mutate((state) => {
      ensureNodeMovable(state, nodeId);
      const parentId = requiredNode(state, nodeId).parentId;
      if (!parentId) throw CoreError.noParent();
      const grandParentId = requiredNode(state, parentId).parentId;
      if (!grandParentId) throw CoreError.noParent();
      ensureParentMutable(state, grandParentId);
      const parentIndex = childIndex(state, grandParentId, parentId) ?? 0;
      moveNodeNoTouch(state, nodeId, grandParentId, parentIndex + 1);
      return focus(nodeId);
    });
  }

  trashNode(nodeId: string): CommandOutcome {
    return this.mutate((state) => {
      trashNodeInState(state, nodeId);
      return undefined;
    });
  }

  batchTrashNodes(nodeIds: string[]): CommandOutcome {
    return this.mutate((state) => {
      for (const nodeId of [...nodeIds].reverse()) {
        if (state.nodes[nodeId]) trashNodeInState(state, nodeId);
      }
      return undefined;
    });
  }

  restoreNode(nodeId: string): CommandOutcome {
    return this.mutate((state) => {
      ensureNodeMovable(state, nodeId);
      const node = requiredNode(state, nodeId);
      const parentId = node.trashedFromParentId && state.nodes[node.trashedFromParentId]
        ? node.trashedFromParentId
        : WORKSPACE_ID;
      const index = node.trashedFromIndex;
      delete node.trashedFromParentId;
      delete node.trashedFromIndex;
      moveNodeNoTouch(state, nodeId, parentId, index);
      return focus(nodeId);
    });
  }

  deleteNode(nodeId: string): CommandOutcome {
    return this.mutate((state) => {
      ensureNodeMovable(state, nodeId);
      removeSubtree(state, nodeId);
      return undefined;
    });
  }

  toggleDone(nodeId: string): CommandOutcome {
    return this.mutate((state) => {
      ensureNodeEditable(state, nodeId);
      const node = requiredNode(state, nodeId);
      if (node.completedAt) delete node.completedAt;
      else node.completedAt = nowMs();
      node.updatedAt = nowMs();
      return focus(nodeId);
    });
  }

  batchIndentNodes(nodeIds: string[]): CommandOutcome {
    return this.mutate((state) => {
      for (const nodeId of nodeIds) {
        if (!state.nodes[nodeId]) continue;
        try {
          ensureNodeMovable(state, nodeId);
          const parentId = state.nodes[nodeId].parentId;
          if (!parentId) continue;
          const index = childIndex(state, parentId, nodeId);
          if (!index) continue;
          const newParentId = requiredNode(state, parentId).children[index - 1];
          ensureParentMutable(state, newParentId);
          moveNodeNoTouch(state, nodeId, newParentId, undefined);
        } catch (error) {
          if (error instanceof CoreError) throw error;
          throw error;
        }
      }
      return undefined;
    });
  }

  batchOutdentNodes(nodeIds: string[]): CommandOutcome {
    return this.mutate((state) => {
      for (const nodeId of [...nodeIds].reverse()) {
        if (!state.nodes[nodeId]) continue;
        ensureNodeMovable(state, nodeId);
        const parentId = state.nodes[nodeId].parentId;
        if (!parentId) continue;
        const grandParentId = state.nodes[parentId]?.parentId;
        if (!grandParentId) continue;
        ensureParentMutable(state, grandParentId);
        const parentIndex = childIndex(state, grandParentId, parentId) ?? 0;
        moveNodeNoTouch(state, nodeId, grandParentId, parentIndex + 1);
      }
      return undefined;
    });
  }

  batchToggleDone(nodeIds: string[]): CommandOutcome {
    return this.mutate((state) => {
      for (const nodeId of nodeIds) {
        if (!state.nodes[nodeId]) continue;
        ensureNodeEditable(state, nodeId);
        const node = requiredNode(state, nodeId);
        if (node.completedAt) delete node.completedAt;
        else node.completedAt = nowMs();
        node.updatedAt = nowMs();
      }
      return undefined;
    });
  }

  batchDuplicateNodes(nodeIds: string[]): CommandOutcome {
    return this.mutate((state) => {
      let firstCloneId: string | undefined;
      for (const nodeId of topLevelNodeIds(state, nodeIds)) {
        if (!state.nodes[nodeId]) continue;
        ensureNodeMovable(state, nodeId);
        const parentId = requiredNode(state, nodeId).parentId;
        if (!parentId) throw CoreError.noParent();
        ensureParentMutable(state, parentId);
        const index = childIndex(state, parentId, nodeId) ?? 0;
        const cloneId = cloneSubtree(state, nodeId, parentId, index + 1);
        firstCloneId ??= cloneId;
      }
      return firstCloneId ? focus(firstCloneId) : undefined;
    });
  }

  batchMoveNodesUp(nodeIds: string[]): CommandOutcome {
    return this.mutate((state) => {
      moveSelectedSiblings(state, nodeIds, 'up');
      return undefined;
    });
  }

  batchMoveNodesDown(nodeIds: string[]): CommandOutcome {
    return this.mutate((state) => {
      moveSelectedSiblings(state, nodeIds, 'down');
      return undefined;
    });
  }

  batchApplyTag(nodeIds: string[], tagId: string): CommandOutcome {
    return this.mutate((state) => {
      if (state.nodes[tagId]?.type !== 'tagDef') throw CoreError.nodeNotFound(tagId);
      for (const nodeId of nodeIds) {
        if (!state.nodes[nodeId]) continue;
        ensureNodeEditable(state, nodeId);
        applyTagNoHistory(state, nodeId, tagId);
      }
      return undefined;
    });
  }

  createTag(name: string): CommandOutcome {
    const normalized = name.trim();
    if (!normalized) throw CoreError.invalidOperation('tag name cannot be empty');
    return this.mutate((state) => {
      const existing = findTagByName(state, normalized);
      if (existing) return focus(existing);
      const id = freshId('tag');
      const color = nextTagColor(state);
      insertNode(state, id, SCHEMA_ID, undefined, 'tagDef', (node) => {
        node.content = plainText(normalized);
        node.color = color;
      });
      return focus(id);
    });
  }

  applyTag(nodeId: string, tagId: string): CommandOutcome {
    return this.mutate((state) => {
      ensureNodeEditable(state, nodeId);
      if (state.nodes[tagId]?.type !== 'tagDef') throw CoreError.nodeNotFound(tagId);
      applyTagNoHistory(state, nodeId, tagId);
      return focus(nodeId);
    });
  }

  removeTag(nodeId: string, tagId: string): CommandOutcome {
    return this.mutate((state) => {
      ensureNodeEditable(state, nodeId);
      const node = requiredNode(state, nodeId);
      const hadTag = node.tags.includes(tagId);
      node.tags = node.tags.filter((id) => id !== tagId);
      node.updatedAt = nowMs();
      if (hadTag) cleanupFieldsFromRemovedTag(state, nodeId, tagId);
      return focus(nodeId);
    });
  }

  setTagConfig(tagId: string, patch: TagConfigPatch): CommandOutcome {
    return this.mutate((state) => {
      ensureNodeEditable(state, tagId);
      ensureTagDefinition(state, tagId);
      if (patch.extends) {
        ensureTagDefinition(state, patch.extends);
        if (patch.extends === tagId || tagExtendsWouldCycle(state, tagId, patch.extends)) {
          throw CoreError.invalidOperation('tag inheritance cannot create a cycle');
        }
      }
      if (patch.childSupertag) ensureTagDefinition(state, patch.childSupertag);
      const node = requiredNode(state, tagId);
      if ('color' in patch) setOptional(node, 'color', normalizeOptionalText(patch.color));
      if ('extends' in patch) setOptional(node, 'extends', normalizeOptionalText(patch.extends));
      if ('childSupertag' in patch) setOptional(node, 'childSupertag', normalizeOptionalText(patch.childSupertag));
      if (patch.showCheckbox !== undefined) node.showCheckbox = patch.showCheckbox;
      if (patch.doneStateEnabled !== undefined) node.doneStateEnabled = patch.doneStateEnabled;
      node.updatedAt = nowMs();
      return focus(tagId);
    });
  }

  setFieldConfig(fieldId: string, patch: FieldConfigPatch): CommandOutcome {
    return this.mutate((state) => {
      ensureNodeEditable(state, fieldId);
      ensureFieldDefinition(state, fieldId);
      const current = requiredNode(state, fieldId);
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
      return focus(fieldId);
    });
  }

  createFieldDef(tagId: string, name: string, fieldType: FieldType): CommandOutcome {
    const normalized = name.trim();
    if (!normalized) throw CoreError.invalidOperation('field name cannot be empty');
    return this.mutate((state) => {
      ensureParentMutable(state, tagId);
      if (state.nodes[tagId]?.type !== 'tagDef') throw CoreError.invalidOperation('field templates belong under tags');
      const fieldDefId = insertFieldDefNode(state, SCHEMA_ID, normalized, fieldType);
      const templateEntryId = insertFieldEntryNode(state, tagId, undefined, fieldDefId);
      for (const taggedNodeId of findNodesWithTag(state, tagId)) {
        ensureFieldEntryFromTemplate(state, taggedNodeId, fieldDefId, templateEntryId, false);
      }
      return focus(templateEntryId);
    });
  }

  createInlineFieldAfterNode(afterNodeId: string, name: string, fieldType: FieldType): CommandOutcome {
    const normalized = name.trim();
    if (!normalized) throw CoreError.invalidOperation('field name cannot be empty');
    return this.mutate((state) => {
      ensureNodeMovable(state, afterNodeId);
      const parentId = state.nodes[afterNodeId]?.parentId;
      if (!parentId) throw CoreError.noParent();
      ensureParentMutable(state, parentId);
      const afterIndex = childIndex(state, parentId, afterNodeId) ?? 0;
      const fieldDefId = insertFieldDefNode(state, SCHEMA_ID, normalized, fieldType);
      const fieldEntryId = insertFieldEntryNode(state, parentId, afterIndex + 1, fieldDefId);
      const node = requiredNode(state, afterNodeId);
      node.trashedFromParentId = parentId;
      node.trashedFromIndex = afterIndex;
      moveNodeNoTouch(state, afterNodeId, TRASH_ID, undefined);
      return focus(fieldEntryId);
    });
  }

  createInlineField(parentId: string, index: number | null | undefined, name: string, fieldType: FieldType): CommandOutcome {
    const normalized = name.trim();
    if (!normalized) throw CoreError.invalidOperation('field name cannot be empty');
    return this.mutate((state) => {
      ensureParentMutable(state, parentId);
      const fieldDefId = insertFieldDefNode(state, SCHEMA_ID, normalized, fieldType);
      const fieldEntryId = insertFieldEntryNode(state, parentId, index, fieldDefId);
      return focus(fieldEntryId);
    });
  }

  registerCollectedOption(fieldDefId: string, name: string): CommandOutcome {
    const normalized = name.trim();
    if (!normalized) throw CoreError.invalidOperation('option name cannot be empty');
    return this.mutate((state) => {
      ensureOptionsFieldDef(state, fieldDefId);
      return focus(ensureOptionNode(state, fieldDefId, normalized));
    });
  }

  selectFieldOption(fieldEntryId: string, optionNodeId: string): CommandOutcome {
    return this.mutate((state) => {
      const fieldEntry = requiredNode(state, fieldEntryId);
      if (fieldEntry.type !== 'fieldEntry') throw CoreError.invalidOperation('options can only be selected on field entries');
      const fieldDefId = fieldEntry.fieldDefId;
      if (!fieldDefId) throw CoreError.invalidOperation('field entry has no field definition');
      ensureOptionsFieldDef(state, fieldDefId);
      ensureOptionBelongsToField(state, fieldDefId, optionNodeId);
      for (const childId of [...fieldEntry.children]) removeSubtree(state, childId);
      insertNode(state, freshId('option_value'), fieldEntryId, undefined, 'reference', (node) => {
        node.targetId = optionNodeId;
      });
      return focus(fieldEntryId);
    });
  }

  addReference(parentId: string, targetId: string, index?: number | null): CommandOutcome {
    return this.mutate((state) => {
      ensureParentMutable(state, parentId);
      if (!state.nodes[targetId]) throw CoreError.nodeNotFound(targetId);
      if (wouldCreateReferenceCycle(state, parentId, targetId)) throw CoreError.referenceCycle();
      const id = freshId('ref');
      insertNode(state, id, parentId, index, 'reference', (node) => {
        node.targetId = targetId;
      });
      return focus(id);
    });
  }

  replaceNodeWithReference(nodeId: string, targetId: string): CommandOutcome {
    return this.mutate((state) => {
      ensureNodeMovable(state, nodeId);
      if (!state.nodes[targetId]) throw CoreError.nodeNotFound(targetId);
      const parentId = requiredNode(state, nodeId).parentId;
      if (!parentId) throw CoreError.noParent();
      ensureParentMutable(state, parentId);
      if (wouldCreateReferenceCycle(state, parentId, targetId)) throw CoreError.referenceCycle();
      const index = childIndex(state, parentId, nodeId) ?? 0;
      const referenceId = freshId('ref');
      insertNode(state, referenceId, parentId, index, 'reference', (node) => {
        node.targetId = targetId;
      });
      const node = requiredNode(state, nodeId);
      node.trashedFromParentId = parentId;
      node.trashedFromIndex = index;
      moveNodeNoTouch(state, nodeId, TRASH_ID, undefined);
      return focus(referenceId);
    });
  }

  ensureDateNode(year: number, month: number, day: number): CommandOutcome {
    return this.mutate((state) => focus(ensureDateNodeInState(state, year, month, day)));
  }

  searchNodes(query: string): SearchHit[] {
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
    return this.mutate((state) => {
      const tag = requiredNode(state, tagId);
      if (tag.type !== 'tagDef') throw CoreError.invalidOperation('tag search target must be a tag');
      const existing = Object.values(state.nodes).find((node) =>
        !isInTrash(state, node.id)
        && node.type === 'search'
        && node.queryOp === 'HAS_TAG'
        && node.queryTagDefId === tagId);
      const searchId = existing?.id ?? (() => {
        const id = freshId('search');
        insertNode(state, id, SEARCHES_ID, undefined, 'search', (node) => {
          node.content = plainText(`Everything tagged #${tag.content.text}`);
          node.queryLogic = 'AND';
          node.queryOp = 'HAS_TAG';
          node.queryTagDefId = tagId;
        });
        return id;
      })();
      refreshTagSearchChildren(state, searchId, tagId);
      return focus(searchId);
    });
  }

  backlinks(targetId: string): Backlink[] {
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
    const previous = this.undoStack.pop();
    if (previous) {
      this.redoStack.push(cloneState(this.stateValue));
      this.stateValue = previous;
    }
    return { projection: this.projection() };
  }

  redo(): CommandOutcome {
    const next = this.redoStack.pop();
    if (next) {
      this.undoStack.push(cloneState(this.stateValue));
      this.stateValue = next;
    }
    return { projection: this.projection() };
  }

  private patchNode(nodeId: string, patch: (node: Node) => void): CommandOutcome {
    return this.mutate((state) => {
      ensureNodeEditable(state, nodeId);
      const node = requiredNode(state, nodeId);
      patch(node);
      node.updatedAt = nowMs();
      return focus(nodeId);
    });
  }

  private mutate(mutator: Mutator): CommandOutcome {
    const before = cloneState(this.stateValue);
    const focusHint = mutator(this.stateValue);
    if (JSON.stringify(this.stateValue) !== JSON.stringify(before)) {
      this.undoStack.push(before);
      this.redoStack = [];
    }
    return { projection: this.projection(), ...(focusHint ? { focus: focusHint } : {}) };
  }

  private ensureTodayNodeNoHistory(): string {
    const today = new Date();
    try {
      return ensureDateNodeInState(this.stateValue, today.getFullYear(), today.getMonth() + 1, today.getDate());
    } catch {
      return DAILY_NOTES_ID;
    }
  }

  private buildProjection(todayId: string): DocumentProjection {
    return {
      workspaceId: this.stateValue.workspaceId,
      rootId: this.stateValue.rootId,
      dailyNotesId: DAILY_NOTES_ID,
      schemaId: SCHEMA_ID,
      searchesId: SEARCHES_ID,
      trashId: TRASH_ID,
      settingsId: SETTINGS_ID,
      todayId,
      nodes: Object.keys(this.stateValue.nodes).sort().map((id) => projectNode(requiredNode(this.stateValue, id))),
    };
  }
}

function normalizeState(state: DocumentState): DocumentState {
  return {
    schemaVersion: state.schemaVersion ?? 1,
    workspaceId: state.workspaceId ?? WORKSPACE_ID,
    rootId: state.rootId ?? WORKSPACE_ID,
    nodes: Object.fromEntries(Object.entries(state.nodes ?? {}).map(([id, node]) => [id, normalizeNode(node)])),
  };
}

function normalizeNode(node: Node): Node {
  return {
    ...createNodeRecord(node.id, node.type, node.parentId, node.createdAt ?? nowMs()),
    ...node,
    children: node.children ?? [],
    content: {
      text: node.content?.text ?? '',
      marks: node.content?.marks ?? [],
      inlineRefs: node.content?.inlineRefs ?? [],
    },
    tags: node.tags ?? [],
    filterValues: node.filterValues ?? [],
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneState(state: DocumentState): DocumentState {
  return clone(state);
}

function focus(nodeId: string): FocusHint {
  return { nodeId, selectAll: false };
}

function nowMs() {
  return Date.now();
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

function projectNode(node: Node): NodeProjection {
  const { trashedFromParentId: _trashedFromParentId, trashedFromIndex: _trashedFromIndex, ...projection } = node;
  return clone(projection);
}

function ensureSystemNodes(state: DocumentState) {
  const now = nowMs();
  state.workspaceId = WORKSPACE_ID;
  state.rootId = WORKSPACE_ID;
  ensureNode(state, WORKSPACE_ID, undefined, undefined, 'Lin Outliner', true, now);
  ensureNode(state, DAILY_NOTES_ID, undefined, WORKSPACE_ID, 'Daily notes', true, now);
  ensureNode(state, SCHEMA_ID, undefined, WORKSPACE_ID, 'Schema', true, now);
  ensureNode(state, SEARCHES_ID, undefined, WORKSPACE_ID, 'Searches', true, now);
  ensureNode(state, TRASH_ID, undefined, WORKSPACE_ID, 'Trash', true, now);
  ensureNode(state, SETTINGS_ID, undefined, WORKSPACE_ID, 'Settings', true, now);
  ensureNode(state, TAG_DAY_ID, 'tagDef', SCHEMA_ID, 'day', true, now);
  ensureNode(state, TAG_WEEK_ID, 'tagDef', SCHEMA_ID, 'week', true, now);
  ensureNode(state, TAG_YEAR_ID, 'tagDef', SCHEMA_ID, 'year', true, now);
  for (const id of [DAILY_NOTES_ID, SCHEMA_ID, SEARCHES_ID, TRASH_ID, SETTINGS_ID]) {
    attachChildOnce(state, WORKSPACE_ID, id, undefined);
  }
  for (const id of [TAG_DAY_ID, TAG_WEEK_ID, TAG_YEAR_ID]) {
    attachChildOnce(state, SCHEMA_ID, id, undefined);
  }
}

function ensureNode(
  state: DocumentState,
  id: string,
  type: NodeType | undefined,
  parentId: string | undefined,
  name: string,
  locked: boolean,
  now: number,
) {
  const node = state.nodes[id] ?? createNodeRecord(id, type, parentId, now);
  node.type = type;
  node.parentId = parentId;
  if (!node.content.text) node.content = plainText(name);
  node.locked = locked;
  state.nodes[id] = normalizeNode(node);
}

function attachChildOnce(state: DocumentState, parentId: string, childId: string, index: number | null | undefined) {
  const parent = state.nodes[parentId];
  if (parent) {
    parent.children = parent.children.filter((id) => id !== childId);
    const pos = Math.max(0, Math.min(index ?? parent.children.length, parent.children.length));
    parent.children.splice(pos, 0, childId);
  }
  const child = state.nodes[childId];
  if (child) child.parentId = parentId;
}

function insertNode(
  state: DocumentState,
  id: string,
  parentId: string,
  index: number | null | undefined,
  type: NodeType | undefined,
  configure: (node: Node) => void,
) {
  if (!state.nodes[parentId]) throw CoreError.parentNotFound(parentId);
  const node = createNodeRecord(id, type, parentId, nowMs());
  configure(node);
  state.nodes[id] = node;
  attachChildOnce(state, parentId, id, index);
}

function insertNodeTree(state: DocumentState, parentId: string, tree: CreateNodeTree): string {
  return insertNodeTreeAt(state, parentId, undefined, tree);
}

function insertNodeTreeAt(state: DocumentState, parentId: string, index: number | undefined, tree: CreateNodeTree): string {
  const id = freshId('node');
  insertNode(state, id, parentId, index, undefined, (node) => {
    node.content = clone(tree.content);
  });
  applyChildTags(state, parentId, id);
  for (const child of tree.children) insertNodeTree(state, id, child);
  return id;
}

function insertFieldDefNode(state: DocumentState, parentId: string, name: string, fieldType: FieldType): string {
  const id = freshId('field');
  insertNode(state, id, parentId, undefined, 'fieldDef', (node) => {
    node.content = plainText(name);
    node.fieldType = fieldType;
    node.cardinality = 'single';
    node.nullable = true;
  });
  return id;
}

function insertFieldEntryNode(
  state: DocumentState,
  parentId: string,
  index: number | null | undefined,
  fieldDefId: string,
): string {
  const id = freshId('field_entry');
  insertNode(state, id, parentId, index, 'fieldEntry', (node) => {
    node.fieldDefId = fieldDefId;
    node.content = plainText('');
  });
  return id;
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

function moveNodeNoTouch(
  state: DocumentState,
  nodeId: string,
  parentId: string,
  index: number | null | undefined,
) {
  if (nodeId === parentId || isDescendant(state, parentId, nodeId)) throw CoreError.invalidMove();
  if (!state.nodes[nodeId]) throw CoreError.nodeNotFound(nodeId);
  if (!state.nodes[parentId]) throw CoreError.parentNotFound(parentId);
  const oldParentId = state.nodes[nodeId].parentId;
  if (oldParentId && state.nodes[oldParentId]) {
    state.nodes[oldParentId].children = state.nodes[oldParentId].children.filter((id) => id !== nodeId);
  }
  attachChildOnce(state, parentId, nodeId, index);
}

function removeSubtree(state: DocumentState, nodeId: string) {
  if (isSystemId(nodeId)) throw CoreError.lockedNode(nodeId);
  const node = clone(requiredNode(state, nodeId));
  if (node.parentId && state.nodes[node.parentId]) {
    state.nodes[node.parentId].children = state.nodes[node.parentId].children.filter((id) => id !== nodeId);
  }
  for (const childId of node.children) removeSubtree(state, childId);
  delete state.nodes[nodeId];
  for (const other of Object.values(state.nodes)) {
    other.tags = other.tags.filter((id) => id !== nodeId);
    if (other.targetId === nodeId) delete other.targetId;
    other.content.inlineRefs = other.content.inlineRefs.filter((ref) => ref.targetNodeId !== nodeId);
  }
}

function cloneSubtree(state: DocumentState, sourceId: string, parentId: string, index: number | undefined): string {
  const source = clone(requiredNode(state, sourceId));
  const sourceChildren = source.children;
  const clonedId = freshId('copy');
  insertNode(state, clonedId, parentId, index, source.type, (node) => {
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
  for (const childId of sourceChildren) cloneSubtree(state, childId, clonedId, undefined);
  return clonedId;
}

function trashNodeInState(state: DocumentState, nodeId: string) {
  ensureNodeMovable(state, nodeId);
  if (nodeId === TRASH_ID) throw CoreError.invalidOperation('cannot trash Trash');
  const node = requiredNode(state, nodeId);
  if (!node.parentId) throw CoreError.noParent();
  node.trashedFromParentId = node.parentId;
  node.trashedFromIndex = childIndex(state, node.parentId, nodeId) ?? 0;
  moveNodeNoTouch(state, nodeId, TRASH_ID, undefined);
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

function applyChildTags(state: DocumentState, parentId: string, childId: string) {
  const tagIds = state.nodes[parentId]?.tags ?? [];
  for (const tagId of tagIds) {
    const childSupertag = state.nodes[tagId]?.childSupertag;
    if (childSupertag) applyTagNoHistory(state, childId, childSupertag);
  }
}

function applyTagNoHistory(state: DocumentState, nodeId: string, tagId: string) {
  const node = requiredNode(state, nodeId);
  if (!node.tags.includes(tagId)) node.tags.push(tagId);
  node.updatedAt = nowMs();
  instantiateTagTemplate(state, nodeId, tagId);
}

function instantiateTagTemplate(state: DocumentState, nodeId: string, tagId: string) {
  for (const chainTagId of getExtendsChain(state, tagId)) {
    for (const fieldRef of getTemplateFieldDefs(state, chainTagId)) {
      ensureFieldEntryFromTemplate(state, nodeId, fieldRef.fieldDefId, fieldRef.templateOriginId, true);
    }
  }
  for (const templateNodeId of getTemplateContentNodes(state, tagId)) {
    cloneTemplateContentNodeShallow(state, nodeId, templateNodeId);
  }
}

function ensureFieldEntryFromTemplate(
  state: DocumentState,
  nodeId: string,
  fieldDefId: string,
  templateOriginId: string,
  cloneDefaults: boolean,
) {
  return ensureFieldEntryWithTemplate(state, nodeId, fieldDefId, templateOriginId, cloneDefaults);
}

function ensureFieldEntryWithTemplate(
  state: DocumentState,
  nodeId: string,
  fieldDefId: string,
  templateOriginId: string | undefined,
  cloneDefaults: boolean,
) {
  const existing = requiredNode(state, nodeId).children.find((childId) => {
    const child = state.nodes[childId];
    return child?.type === 'fieldEntry' && child.fieldDefId === fieldDefId;
  });
  if (existing) return existing;
  const id = freshId('field_entry');
  insertNode(state, id, nodeId, 0, 'fieldEntry', (node) => {
    node.fieldDefId = fieldDefId;
    node.templateId = templateOriginId;
    node.content = plainText('');
  });
  if (cloneDefaults && templateOriginId) cloneTemplateFieldValues(state, id, templateOriginId);
  return id;
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

function cloneTemplateFieldValues(state: DocumentState, fieldEntryId: string, templateOriginId: string) {
  if (state.nodes[templateOriginId]?.type !== 'fieldEntry') return;
  for (const valueId of state.nodes[templateOriginId]?.children ?? []) {
    const value = state.nodes[valueId];
    if (!value) continue;
    insertNode(state, freshId('value'), fieldEntryId, undefined, value.type, (node) => {
      node.content = clone(value.content);
      node.description = value.description;
      node.fieldDefId = value.fieldDefId;
      node.targetId = value.targetId;
      node.codeLanguage = value.codeLanguage;
    });
  }
}

function cloneTemplateContentNodeShallow(state: DocumentState, parentId: string, templateNodeId: string) {
  const parent = requiredNode(state, parentId);
  if (parent.children.some((childId) => state.nodes[childId]?.templateId === templateNodeId)) return;
  const template = requiredNode(state, templateNodeId);
  insertNode(state, freshId('template'), parentId, undefined, template.type, (node) => {
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

function findNodesWithTag(state: DocumentState, tagId: string) {
  return Object.values(state.nodes).filter((node) => node.tags.includes(tagId)).map((node) => node.id);
}

function cleanupFieldsFromRemovedTag(state: DocumentState, nodeId: string, removedTagId: string) {
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
  for (const fieldEntryId of toRemove) removeSubtree(state, fieldEntryId);
}

function findTagByName(state: DocumentState, name: string) {
  const needle = name.trim().toLowerCase();
  return Object.values(state.nodes).find((node) =>
    node.type === 'tagDef' && node.content.text.trim().toLowerCase() === needle)?.id;
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

function ensureOptionNode(state: DocumentState, fieldDefId: string, name: string) {
  const existing = findOptionByName(state, fieldDefId, name);
  if (existing) return existing;
  const optionId = freshId('option');
  insertNode(state, optionId, fieldDefId, undefined, undefined, (node) => {
    node.content = plainText(name);
    node.autoCollected = true;
  });
  return optionId;
}

function ensureOptionBelongsToField(state: DocumentState, fieldDefId: string, optionNodeId: string) {
  if (requiredNode(state, optionNodeId).parentId !== fieldDefId) {
    throw CoreError.invalidOperation('option does not belong to this field definition');
  }
}

function refreshTagSearchChildren(state: DocumentState, searchId: string, tagId: string) {
  for (const childId of [...state.nodes[searchId]?.children ?? []]) removeSubtree(state, childId);
  const targetIds = Object.values(state.nodes)
    .filter((node) =>
      node.id !== searchId
      && node.id !== tagId
      && !isSystemId(node.id)
      && !isInTrash(state, node.id)
      && node.type !== 'search'
      && node.tags.includes(tagId))
    .sort((left, right) => left.content.text.localeCompare(right.content.text) || left.id.localeCompare(right.id))
    .map((node) => node.id);
  for (const targetId of targetIds) {
    insertNode(state, freshId('ref'), searchId, undefined, 'reference', (node) => {
      node.targetId = targetId;
    });
  }
}

function ensureDateNodeInState(state: DocumentState, year: number, month: number, day: number) {
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw CoreError.invalidOperation('invalid date');
  }
  const yearName = String(year);
  const weekName = `W${String(isoWeek(date)).padStart(2, '0')}`;
  const dayName = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const yearId = findOrCreateNamedChild(state, DAILY_NOTES_ID, yearName, TAG_YEAR_ID);
  const weekId = findOrCreateNamedChild(state, yearId, weekName, TAG_WEEK_ID);
  return findOrCreateNamedChild(state, weekId, dayName, TAG_DAY_ID);
}

function findOrCreateNamedChild(state: DocumentState, parentId: string, name: string, tagId?: string) {
  for (const childId of state.nodes[parentId]?.children ?? []) {
    if (state.nodes[childId]?.content.text === name) return childId;
  }
  const id = freshId('date');
  insertNode(state, id, parentId, 0, undefined, (node) => {
    node.content = plainText(name);
    node.locked = true;
  });
  if (tagId) applyTagNoHistory(state, id, tagId);
  return id;
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

function mergeNodeIntoTarget(state: DocumentState, nodeId: string, targetId: string) {
  if (nodeId === targetId || isDescendant(state, targetId, nodeId)) throw CoreError.invalidMove();
  const current = clone(requiredNode(state, nodeId));
  const sourceParentId = current.parentId;
  const sourceIndex = sourceParentId ? childIndex(state, sourceParentId, nodeId) : undefined;
  const target = requiredNode(state, targetId);
  target.content = appendRichText(target.content, current.content);
  target.updatedAt = nowMs();
  current.children.forEach((childId, offset) => {
    const insertIndex = sourceParentId === targetId && sourceIndex !== undefined ? sourceIndex + 1 + offset : undefined;
    moveNodeNoTouch(state, childId, targetId, insertIndex);
  });
  removeSubtree(state, nodeId);
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

