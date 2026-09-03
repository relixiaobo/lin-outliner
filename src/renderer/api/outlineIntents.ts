import type {
  AssetLease,
  Change,
  Diff,
  NodeDraft,
  OneTargetRef,
  OperationUndoGroup,
  ProjectionResult,
  TargetRef,
  UpdateInstruction,
} from '../../outline/contract';
import { freshNodeId } from '../../core/nodeId';
import { isContentBearingNode } from './types';
import type {
  ContentBearingNodeProjection,
  NodeProjection,
  RichText,
  Backlink,
  AssetMetadata,
  BatchMoveNodeInput,
  CommandResult,
  CreateNodeTree,
  DocumentProjection,
  FieldConfigPatch,
  FieldSlotMutation,
  FieldType,
  FilterOperator,
  FilterValueLogic,
  FocusHint,
  IconKind,
  PasteRowMeta,
  ProjectionSnapshot,
  RichTextPatch,
  SearchHit,
  SortDirection,
  SplitNodeOptions,
  TagConfigPatch,
  TagTemplateBackfillPreview,
  ViewMode,
} from './types';
import { parseSearchQueryOutline } from '../../core/searchQueryOutline';
import { nextCompletedAt } from '../../core/doneState';
import { formatAssetSourceUri } from '../../core/source';
import { tagDrivenShowCheckbox } from '../../core/configProjection';
import {
  previewDesktopMutation,
  readDesktopProjection,
  requestOutline,
  runDesktopHistory,
  runDesktopMutation,
  type DesktopFocusHint,
} from './outline';

interface DesktopProjectionView {
  readonly projection: DocumentProjection;
  readonly byId: ReadonlyMap<string, NodeProjection>;
}

type DesktopProjectionReader = () => DesktopProjectionView | null;
type PublicViewField = Extract<
  UpdateInstruction,
  { kind: 'view'; property: 'sort'; action: 'add' }
>['field'];

let projectionReader: DesktopProjectionReader | null = null;

export function installDesktopProjectionReader(reader: DesktopProjectionReader): () => void {
  projectionReader = reader;
  return () => {
    if (projectionReader === reader) projectionReader = null;
  };
}

export const outlineDocumentApi = {
  initWorkspace: readDesktopProjection,
  getProjection: readDesktopProjection,
  createNode,
  createNodeRelativeTo,
  materializeDraftNode,
  createRichTextNode,
  createTaggedNode,
  createTagAndTaggedNode,
  createNodesFromTree,
  pasteNodesIntoNode,
  splitNode,
  applyNodeTextPatch,
  replaceNodeText,
  updateNodeDescription,
  setNodeCheckboxVisible,
  convertNodeToCheckbox,
  createCheckboxNode,
  setCodeBlock,
  convertNodeToCodeBlock,
  createCodeBlock,
  setCodeLanguage,
  createSourceNode,
  setNodeContentAndAddSource,
  addSource,
  replaceSource,
  reorderSource,
  removeSource,
  clearSources,
  ingestAssetFromData,
  setViewToolbarVisible,
  setViewMode,
  addSortRule,
  updateSortRule,
  removeSortRule,
  clearSortRules,
  addFilterRule,
  updateFilterRule,
  removeFilterRule,
  clearFilterRules,
  setGroupField,
  addDisplayField,
  createDisplayField,
  updateDisplayField,
  removeDisplayField,
  setNodeIcon,
  setNodeBanner,
  mergeNodeInto,
  moveNode,
  batchMoveNodes,
  indentNode,
  outdentNode,
  trashNode,
  batchTrashNodes,
  batchDeleteRows,
  batchIndentNodes,
  batchOutdentNodes,
  batchToggleDone,
  batchCycleDoneState,
  batchDuplicateNodes,
  batchMoveNodesUp,
  batchMoveNodesDown,
  batchApplyTag,
  createTagAndBatchApply,
  restoreNode,
  deleteNode,
  toggleDone,
  cycleDoneState,
  createTag,
  applyTagWithContent,
  createTagAndApplyWithContent,
  previewTagTemplateBackfill,
  applyTemplateToTaggedNodes,
  applyTag,
  removeTag,
  setTagConfig,
  setFieldConfig,
  createFieldDef,
  createInlineFieldAfterNode,
  createInlineField,
  updateFieldSlot,
  appendFieldSource,
  reuseFieldDefinition,
  registerCollectedOption,
  createCollectedFieldOption,
  selectFieldOption,
  setFieldFreeTextValue,
  clearFieldValue,
  removeFieldValue,
  addReference,
  addReferenceConversion,
  setReferenceTarget,
  replaceNodeWithReference,
  replaceNodeWithReferenceConversion,
  replaceNodeWithInlineReference,
  convertReferenceToInlineNode,
  restoreInlineReferenceNodeToReference,
  ensureDateNode,
  searchNodes,
  ensureTagSearch,
  setSearchQueryOutline,
  refreshSearchNodeResults,
  backlinks,
  undo: () => runDesktopHistory('undo'),
  redo: () => runDesktopHistory('redo'),
};

type MutationOptions = {
  readonly acknowledgeDestructive?: boolean;
  readonly requiresDiff?: boolean;
  readonly undoGroup?: OperationUndoGroup;
};

function createNode(
  parentId: string,
  index: number | null,
  text: string,
  id = freshId('node'),
  options?: MutationOptions,
): Promise<CommandResult> {
  return mutate(() => [{
    op: 'create',
    placement: structuralPlacement(oneId(parentId), index),
    nodes: [draft({ text, marks: [], inlineRefs: [] }, id)],
  }], focus(id, parentId, { kind: 'end' }), options);
}

function createNodeRelativeTo(
  siblingId: string,
  parentId: string,
  side: 'before' | 'after',
  content: RichText,
  id = freshId('node'),
  options?: MutationOptions,
): Promise<CommandResult> {
  return mutate(() => [{
    op: 'create',
    placement: { kind: side, sibling: oneId(siblingId) },
    nodes: [draft(content, id)],
  }], focus(id, parentId, { kind: 'end' }), options);
}

function materializeDraftNode(
  parentId: string,
  index: number | null,
  text: string,
  id = freshId('node'),
  undoGroup?: OperationUndoGroup,
): Promise<CommandResult> {
  return createNode(parentId, index, text, id, undoGroup ? { undoGroup } : undefined);
}

function createRichTextNode(
  parentId: string,
  index: number | null,
  content: RichText,
  id = freshId('node'),
): Promise<CommandResult> {
  return mutate(() => [{
    op: 'create',
    placement: structuralPlacement(oneId(parentId), index),
    nodes: [draft(content, id)],
  }], focus(id, parentId, { kind: 'end' }));
}

function createTaggedNode(
  parentId: string,
  content: RichText,
  tagId: string,
  index: number | null = null,
  id = freshId('node'),
): Promise<CommandResult> {
  return mutate(() => [{
    op: 'create',
    placement: structuralPlacement(oneId(parentId), index),
    nodes: [draft(content, id, { tags: [tagId] })],
  }], focus(id, parentId, { kind: 'end' }));
}

function createTagAndTaggedNode(
  parentId: string,
  content: RichText,
  name: string,
  index: number | null = null,
  id = freshId('node'),
): Promise<CommandResult> {
  return mutate(() => [
    { op: 'ensure', resource: 'definition', definitionType: 'tag', name, bind: 'tag' },
    { op: 'create', placement: structuralPlacement(oneId(parentId), index), nodes: [draft(content, id)], bind: 'created' },
    {
      op: 'update',
      targets: binding('created'),
      changes: [{ kind: 'tag', action: 'add', tag: binding('tag') }],
    },
  ], focus(id, parentId, { kind: 'end' }));
}

function createNodesFromTree(parentId: string, trees: CreateNodeTree[]): Promise<CommandResult> {
  const plan = buildTreePlan(oneId(parentId), trees);
  return mutate(() => plan.operations, plan.lastRootId
    ? focus(plan.lastRootId, parentId, { kind: 'end' })
    : undefined);
}

function pasteNodesIntoNode(
  nodeId: string,
  content: RichText,
  children: CreateNodeTree[],
  siblingsAfter: CreateNodeTree[],
  firstMeta: PasteRowMeta = {},
): Promise<CommandResult> {
  return mutate(() => {
    const view = requireProjection();
    const node = requiredContentBearingNode(view, nodeId);
    if (!node.parentId) throw new Error('Cannot paste siblings beside a root Node.');
    const siblingIndex = requiredNode(view, node.parentId).children.indexOf(nodeId) + 1;
    const definitions = collectTreeDefinitions([...children, ...siblingsAfter], firstMeta);
    const operations: Change[] = definitionEnsureOperations(definitions);
    const firstChanges: UpdateInstruction[] = [{ kind: 'content', value: content }];
    if (firstMeta.checkbox === true) firstChanges.push({ kind: 'checkbox', visible: true });
    if (firstMeta.done !== undefined) firstChanges.push({ kind: 'done', value: firstMeta.done });
    firstChanges.push(...metadataInstructions(firstMeta, definitions));
    operations.push({ op: 'update', targets: oneId(nodeId), changes: firstChanges });
    const context = createTreePlanContext();
    const childPlan = buildTreePlan(oneId(nodeId), children, null, definitions, context);
    const siblingPlan = buildTreePlan(oneId(node.parentId), siblingsAfter, siblingIndex, definitions, context);
    operations.push(...childPlan.operations, ...siblingPlan.operations);
    return operations;
  }, (_operation, diff) => {
    const created = createdOrdinaryNodeIds(diff).at(-1);
    return created ? focus(created) : focus(nodeId);
  }, { requiresDiff: true });
}

function splitNode(
  nodeId: string,
  before: RichText,
  after: RichText,
  options: SplitNodeOptions = {},
  createdId = freshId('node'),
): Promise<CommandResult> {
  let targetParentId: string | null = null;
  return mutate(() => {
    const view = requireProjection();
    const node = requiredContentBearingNode(view, nodeId);
    if (!node.parentId) throw new Error('Cannot split a root Node.');
    targetParentId = options.targetParentId ?? node.parentId;
    const targetIndex = options.targetIndex ?? (
      targetParentId === node.parentId
        ? requiredNode(view, node.parentId).children.indexOf(nodeId) + 1
        : null
    );
    return [
      { op: 'update', targets: oneId(nodeId), changes: [{ kind: 'content', value: before }] },
      {
        op: 'create',
        placement: structuralPlacement(oneId(targetParentId), targetIndex),
        nodes: [draft(after, createdId, {
          ...(targetParentId === node.parentId ? { tags: [...node.tags] } : {}),
        })],
      },
    ];
  }, () => focus(createdId, targetParentId, options.focusPlacement ?? { kind: 'start' }), { requiresDiff: false });
}

function applyNodeTextPatch(
  nodeId: string,
  patch: RichTextPatch,
  options?: Pick<MutationOptions, 'undoGroup'>,
): Promise<CommandResult> {
  return update(nodeId, [{ kind: 'text-patch', field: 'content', patch }], focus(nodeId), options);
}

function replaceNodeText(nodeId: string, content: RichText): Promise<CommandResult> {
  return update(nodeId, [{ kind: 'content', value: content }], focus(nodeId));
}

function updateNodeDescription(nodeId: string, description: string | null): Promise<CommandResult> {
  return update(nodeId, [{ kind: 'description', value: description }], focus(nodeId, undefined, undefined, 'description'));
}

function setNodeCheckboxVisible(nodeId: string, visible: boolean): Promise<CommandResult> {
  return update(nodeId, [{ kind: 'checkbox', visible }], focus(nodeId));
}

function convertNodeToCheckbox(nodeId: string, content: RichText): Promise<CommandResult> {
  return update(nodeId, [
    { kind: 'content', value: content },
    { kind: 'checkbox', visible: true },
  ], focus(nodeId));
}

function createCheckboxNode(
  parentId: string,
  index: number | null,
  content: RichText,
  id = freshId('node'),
): Promise<CommandResult> {
  return mutate(() => [{
    op: 'create',
    placement: structuralPlacement(oneId(parentId), index),
    nodes: [draft(content, id, { checkbox: true, done: false })],
  }], focus(id, parentId, { kind: 'end' }));
}

function setCodeBlock(nodeId: string, codeLanguage = ''): Promise<CommandResult> {
  return update(nodeId, [{ kind: 'code', language: codeLanguage }], focus(nodeId));
}

function convertNodeToCodeBlock(nodeId: string, content: RichText, codeLanguage = ''): Promise<CommandResult> {
  return update(nodeId, [
    { kind: 'content', value: content },
    { kind: 'code', language: codeLanguage },
  ], focus(nodeId));
}

function createCodeBlock(
  parentId: string,
  index: number | null,
  content: RichText,
  id = freshId('node'),
  codeLanguage = '',
): Promise<CommandResult> {
  return mutate(() => [{
    op: 'create',
    placement: structuralPlacement(oneId(parentId), index),
    nodes: [draft(content, id, { type: 'codeBlock', codeLanguage })],
  }], focus(id, parentId, { kind: 'end' }));
}

function setCodeLanguage(nodeId: string, codeLanguage: string): Promise<CommandResult> {
  return update(nodeId, [{ kind: 'code', language: codeLanguage }], focus(nodeId));
}

function createSourceNode(
  parentId: string,
  index: number | null,
  options: {
    assetId?: string;
    sourceText?: string;
    name?: string | null;
    content?: RichText;
    id?: string;
  },
): Promise<CommandResult> {
  const id = options.id ?? freshId('node');
  const valueId = freshId('node');
  const sourceText = options.assetId ? formatAssetSourceUri(options.assetId) : options.sourceText;
  if (!sourceText) return Promise.reject(new Error('Source text is required.'));
  return mutate(() => [{
    op: 'create',
    placement: structuralPlacement(oneId(parentId), index),
    nodes: [draft(options.content ?? { text: options.name ?? '', marks: [], inlineRefs: [] }, id)],
    bind: 'sourceOwner',
  }, {
    op: 'update',
    targets: { binding: 'sourceOwner' },
    changes: [{ kind: 'source', action: 'add', sourceText, valueId }],
  }], focus(id, parentId));
}

function setNodeContentAndAddSource(
  ownerId: string,
  content: RichText,
  sourceText: string,
): Promise<CommandResult> {
  return update(ownerId, [
    { kind: 'content', value: content },
    {
      kind: 'source',
      action: 'add',
      sourceText,
      valueId: freshId('node'),
    },
  ], focus(ownerId));
}

function addSource(ownerId: string, sourceText: string, afterValueId?: string | null): Promise<CommandResult> {
  return update(ownerId, [{
    kind: 'source',
    action: 'add',
    sourceText,
    valueId: freshId('node'),
    ...(afterValueId === undefined ? {} : { after: afterValueId === null ? null : oneSourceId(afterValueId) }),
  }], focus(ownerId));
}

function replaceSource(ownerId: string, valueId: string, sourceText: string): Promise<CommandResult> {
  return update(ownerId, [{ kind: 'source', action: 'replace', value: oneSourceId(valueId), sourceText }], focus(ownerId));
}

function reorderSource(ownerId: string, valueId: string, afterValueId: string | null): Promise<CommandResult> {
  return update(ownerId, [{
    kind: 'source', action: 'reorder', value: oneSourceId(valueId), after: afterValueId === null ? null : oneSourceId(afterValueId),
  }], focus(ownerId));
}

function removeSource(ownerId: string, valueId: string): Promise<CommandResult> {
  return update(ownerId, [{ kind: 'source', action: 'remove', value: oneSourceId(valueId) }], focus(ownerId));
}

function clearSources(ownerId: string): Promise<CommandResult> {
  return update(ownerId, [{ kind: 'source', action: 'clear' }], focus(ownerId));
}

async function ingestAssetFromData(
  data: Uint8Array,
  mimeType?: string,
  originalFilename?: string,
): Promise<AssetMetadata> {
  const lease = await requestOutline<AssetLease>('asset ingest', {
    source: 'bytes',
    data: bytesToBase64(data),
    ...(mimeType ? { mimeType } : {}),
    ...(originalFilename ? { originalFilename } : {}),
  });
  return legacyAssetMetadata(lease);
}

function setViewToolbarVisible(nodeId: string, visible: boolean): Promise<CommandResult> {
  return update(nodeId, [{ kind: 'view', property: 'toolbar', action: 'set', visible }]);
}

function setViewMode(nodeId: string, mode: ViewMode): Promise<CommandResult> {
  return update(nodeId, [{ kind: 'view', property: 'mode', action: 'set', mode }]);
}

function addSortRule(nodeId: string, field: string, direction: SortDirection = 'asc'): Promise<CommandResult> {
  return update(nodeId, [{ kind: 'view', property: 'sort', action: 'add', field: viewField(field), direction }]);
}

function updateSortRule(ruleId: string, field: string, direction: SortDirection = 'asc'): Promise<CommandResult> {
  return update(ruleId, [{ kind: 'view', property: 'sort', action: 'set', ruleId, field: viewField(field), direction }]);
}

function removeSortRule(ruleId: string): Promise<CommandResult> {
  return update(ruleId, [{ kind: 'view', property: 'sort', action: 'remove', ruleId }]);
}

function clearSortRules(nodeId: string): Promise<CommandResult> {
  return update(nodeId, [{ kind: 'view', property: 'sort', action: 'clear' }]);
}

function addFilterRule(
  nodeId: string,
  field: string,
  operator: FilterOperator = 'contains',
  values: string[] = [],
  valueLogic: FilterValueLogic = 'any',
): Promise<CommandResult> {
  return update(nodeId, [{
    kind: 'view', property: 'filter', action: 'add', field: viewField(field), operator, values, valueLogic,
  }]);
}

function updateFilterRule(
  ruleId: string,
  patch: {
    field?: string | null;
    operator?: FilterOperator | null;
    values?: string[] | null;
    valueLogic?: FilterValueLogic | null;
  },
): Promise<CommandResult> {
  const { field, ...rest } = patch;
  return update(ruleId, [{
    kind: 'view',
    property: 'filter',
    action: 'set',
    ruleId,
    ...rest,
    ...(field !== undefined ? { field: field === null ? null : viewField(field) } : {}),
  }]);
}

function removeFilterRule(ruleId: string): Promise<CommandResult> {
  return update(ruleId, [{ kind: 'view', property: 'filter', action: 'remove', ruleId }]);
}

function clearFilterRules(nodeId: string): Promise<CommandResult> {
  return update(nodeId, [{ kind: 'view', property: 'filter', action: 'clear' }]);
}

function setGroupField(nodeId: string, field: string | null): Promise<CommandResult> {
  return update(nodeId, [{
    kind: 'view', property: 'group', action: 'set', field: field === null ? null : viewField(field),
  }]);
}

function addDisplayField(nodeId: string, field: string): Promise<CommandResult> {
  return update(nodeId, [{ kind: 'view', property: 'display-field', action: 'add', field: viewField(field) }]);
}

function createDisplayField(nodeId: string, name: string, fieldType: FieldType): Promise<CommandResult> {
  return mutate(() => [
    {
      op: 'ensure', resource: 'definition', definitionType: 'field', name,
      config: { fieldType }, bind: 'field',
    },
    {
      op: 'update',
      targets: oneId(nodeId),
      changes: [{ kind: 'view', property: 'display-field', action: 'add', field: binding('field') }],
    },
  ]);
}

function updateDisplayField(
  displayFieldId: string,
  patch: {
    field?: string | null;
    visible?: boolean | null;
    width?: number | null;
    order?: number | null;
    label?: string | null;
    placement?: string | null;
    move?: 'left' | 'right';
  },
): Promise<CommandResult> {
  const placement = patch.placement;
  if (placement !== undefined && placement !== null
    && placement !== 'title' && placement !== 'body' && placement !== 'footer' && placement !== 'hidden') {
    return Promise.reject(new Error(`Invalid display field placement: ${placement}`));
  }
  return update(displayFieldId, [{
    kind: 'view',
    property: 'display-field',
    action: 'set',
    displayFieldId,
    ...patch,
    ...(patch.field !== undefined ? { field: patch.field === null ? null : viewField(patch.field) } : {}),
    ...(placement !== undefined ? { placement } : {}),
  } as Extract<UpdateInstruction, { kind: 'view'; property: 'display-field'; action: 'set' }>]);
}

function removeDisplayField(displayFieldId: string): Promise<CommandResult> {
  return update(displayFieldId, [{
    kind: 'view', property: 'display-field', action: 'remove', displayFieldId,
  }]);
}

function setNodeIcon(nodeId: string, icon: string | null, iconKind: IconKind | null = null): Promise<CommandResult> {
  return update(nodeId, [{ kind: 'icon', value: icon, ...(iconKind ? { iconKind } : {}) }]);
}

function setNodeBanner(
  nodeId: string,
  assetId: string | null,
  position?: { x?: number | null; y?: number | null },
): Promise<CommandResult> {
  return update(nodeId, [{
    kind: 'banner',
    assetLeaseId: assetId,
    ...(position ? { position: {
      ...(typeof position.x === 'number' ? { x: position.x } : {}),
      ...(typeof position.y === 'number' ? { y: position.y } : {}),
    } } : {}),
  }]);
}

function mergeNodeInto(nodeId: string, targetId: string): Promise<CommandResult> {
  return mutate(
    () => [{ op: 'merge', sources: oneId(nodeId), target: oneId(targetId) }],
    focus(targetId),
    { acknowledgeDestructive: true },
  );
}

function moveNode(nodeId: string, parentId: string, index: number | null = null): Promise<CommandResult> {
  return mutate(() => [{
    op: 'move', targets: oneId(nodeId), placement: structuralPlacement(oneId(parentId), index),
  }], focus(nodeId));
}

function batchMoveNodes(moves: readonly BatchMoveNodeInput[]): Promise<CommandResult> {
  return mutate(() => {
    if (moves.length === 0) return [];
    const parentId = moves[0]!.parentId;
    if (moves.some((move) => move.parentId !== parentId)) {
      throw new Error('A batch move must have one destination parent.');
    }

    const parent = requiredNode(requireProjection(), parentId);
    const finalChildren = [...parent.children];
    for (const move of moves) {
      const currentIndex = finalChildren.indexOf(move.nodeId);
      if (currentIndex >= 0) finalChildren.splice(currentIndex, 1);
      const index = move.index == null
        ? finalChildren.length
        : Math.max(0, Math.min(move.index, finalChildren.length));
      finalChildren.splice(index, 0, move.nodeId);
    }

    const moved = new Set(moves.map((move) => move.nodeId));
    const orderedIds = finalChildren.filter((nodeId) => moved.has(nodeId));
    const start = finalChildren.indexOf(orderedIds[0]!);
    if (orderedIds.length !== moved.size || finalChildren.slice(start, start + orderedIds.length).some((nodeId) => !moved.has(nodeId))) {
      throw new Error('A batch move must produce one contiguous destination block.');
    }
    const anchorId = finalChildren[start + orderedIds.length];
    return [{
      op: 'move',
      targets: manyIds(orderedIds),
      placement: anchorId
        ? { kind: 'before', sibling: oneId(anchorId) }
        : { kind: 'last', parent: oneId(parentId) },
    }];
  });
}

function indentNode(nodeId: string): Promise<CommandResult> {
  return mutate(() => {
    const view = requireProjection();
    const node = requiredNode(view, nodeId);
    if (!node.parentId) throw new Error('Cannot indent a root Node.');
    const siblings = requiredNode(view, node.parentId).children;
    const index = siblings.indexOf(nodeId);
    if (index <= 0) throw new Error('Cannot indent without a previous sibling.');
    return [{ op: 'move', targets: oneId(nodeId), placement: { kind: 'last', parent: oneId(siblings[index - 1]!) } }];
  }, focus(nodeId));
}

function outdentNode(nodeId: string): Promise<CommandResult> {
  return mutate(() => [outdentChange(requireProjection(), nodeId)], focus(nodeId));
}

function trashNode(nodeId: string): Promise<CommandResult> {
  return lifecycle('trash', [nodeId]);
}

function batchTrashNodes(nodeIds: string[]): Promise<CommandResult> {
  return lifecycle('trash', [...nodeIds].reverse());
}

function batchIndentNodes(nodeIds: string[]): Promise<CommandResult> {
  return mutate(() => {
    const view = requireProjection();
    const selected = new Set(nodeIds);
    return documentOrder(view, nodeIds).flatMap((nodeId): Change[] => {
      let currentId: string | undefined = nodeId;
      while (currentId) {
        const current = view.byId.get(currentId);
        const parent = current?.parentId ? view.byId.get(current.parentId) : undefined;
        const index: number = parent?.children.indexOf(currentId) ?? -1;
        if (!parent || index <= 0) return [];
        const previousId: string = parent.children[index - 1]!;
        if (!selected.has(previousId)) {
          return [{ op: 'move', targets: oneId(nodeId), placement: { kind: 'last', parent: oneId(previousId) } }];
        }
        currentId = previousId;
      }
      return [];
    });
  });
}

function batchOutdentNodes(nodeIds: string[]): Promise<CommandResult> {
  return mutate(() => [...nodeIds].reverse().map((nodeId) => outdentChange(requireProjection(), nodeId)));
}

function batchToggleDone(nodeIds: string[]): Promise<CommandResult> {
  return mutate(() => {
    const view = requireProjection();
    return nodeIds.map((nodeId) => updateChange(
      nodeId,
      doneTransitionInstructions(view, requiredContentBearingNode(view, nodeId), 'toggle'),
    ));
  });
}

function batchCycleDoneState(nodeIds: string[]): Promise<CommandResult> {
  return mutate(() => {
    const view = requireProjection();
    return nodeIds.map((nodeId) => updateChange(
      nodeId,
      doneTransitionInstructions(view, requiredContentBearingNode(view, nodeId), 'cycle'),
    ));
  });
}

function batchDuplicateNodes(nodeIds: string[]): Promise<CommandResult> {
  return mutate(() => {
    const view = requireProjection();
    return topLevelIds(view, nodeIds).map((nodeId) => {
      const node = requiredNode(view, nodeId);
      if (!node.parentId) throw new Error('Cannot duplicate a root Node.');
      return { op: 'duplicate' as const, targets: oneId(nodeId), placement: { kind: 'next' as const } };
    });
  }, (_operation, diff) => {
    const created = diff.affected.find((entry) => entry.effect === 'create')?.id;
    return created ? focus(created) : undefined;
  }, { requiresDiff: true });
}

function batchMoveNodesUp(nodeIds: string[]): Promise<CommandResult> {
  return moveSelectedSiblings(nodeIds, 'up');
}

function batchMoveNodesDown(nodeIds: string[]): Promise<CommandResult> {
  return moveSelectedSiblings(nodeIds, 'down');
}

function batchApplyTag(nodeIds: string[], tagId: string): Promise<CommandResult> {
  return mutate(() => nodeIds.map((nodeId) => updateChange(nodeId, [{
    kind: 'tag', action: 'add', tag: oneId(tagId),
  }])));
}

function createTagAndBatchApply(
  nodeIds: string[],
  name: string,
  tagId = freshId('node'),
): Promise<CommandResult> {
  return mutate(() => [
    {
      op: 'ensure',
      resource: 'definition',
      definitionType: 'tag',
      id: tagId,
      name,
      bind: 'tag',
    },
    ...nodeIds.map((nodeId) => updateChange(nodeId, [{
      kind: 'tag', action: 'add', tag: binding('tag'),
    }])),
  ]);
}

function restoreNode(nodeId: string): Promise<CommandResult> {
  return lifecycle('restore', [nodeId], focus(nodeId));
}

function deleteNode(nodeId: string): Promise<CommandResult> {
  return lifecycle('purge', [nodeId], undefined, { acknowledgeDestructive: true });
}

function toggleDone(nodeId: string): Promise<CommandResult> {
  return mutate(() => {
    const view = requireProjection();
    return [updateChange(
      nodeId,
      doneTransitionInstructions(view, requiredContentBearingNode(view, nodeId), 'toggle'),
    )];
  }, focus(nodeId));
}

function cycleDoneState(nodeId: string): Promise<CommandResult> {
  return mutate(() => {
    const view = requireProjection();
    return [updateChange(
      nodeId,
      doneTransitionInstructions(view, requiredContentBearingNode(view, nodeId), 'cycle'),
    )];
  }, focus(nodeId));
}

function createTag(name: string): Promise<CommandResult> {
  return mutate(() => [{
    op: 'ensure', resource: 'definition', definitionType: 'tag', name, bind: 'tag',
  }], bindingFocus('tag'), { requiresDiff: true });
}

async function previewTagTemplateBackfill(tagId: string): Promise<TagTemplateBackfillPreview> {
  const diff = await preview(() => [{ op: 'template', action: 'apply', tag: oneId(tagId) }]);
  return templatePreviewFromDiff(diff);
}

function applyTemplateToTaggedNodes(tagId: string): Promise<CommandResult> {
  return mutate(() => [{ op: 'template', action: 'apply', tag: oneId(tagId) }]);
}

function applyTag(nodeId: string, tagId: string): Promise<CommandResult> {
  return update(nodeId, [{ kind: 'tag', action: 'add', tag: oneId(tagId) }], focus(nodeId));
}

function applyTagWithContent(
  nodeId: string,
  tagId: string,
  content: RichText,
): Promise<CommandResult> {
  return update(nodeId, [
    { kind: 'content', value: content },
    { kind: 'tag', action: 'add', tag: oneId(tagId) },
  ], focus(nodeId));
}

function createTagAndApplyWithContent(
  nodeId: string,
  name: string,
  content: RichText,
  tagId = freshId('node'),
): Promise<CommandResult> {
  return mutate(() => [
    {
      op: 'ensure',
      resource: 'definition',
      definitionType: 'tag',
      id: tagId,
      name,
      bind: 'tag',
    },
    {
      op: 'update',
      targets: oneId(nodeId),
      changes: [
        { kind: 'content', value: content },
        { kind: 'tag', action: 'add', tag: binding('tag') },
      ],
    },
  ], focus(nodeId));
}

function removeTag(nodeId: string, tagId: string): Promise<CommandResult> {
  return update(nodeId, [{ kind: 'tag', action: 'remove', tag: oneId(tagId) }], focus(nodeId));
}

function setTagConfig(tagId: string, patch: TagConfigPatch): Promise<CommandResult> {
  return update(tagId, [{ kind: 'definition', definitionType: 'tag', patch }]);
}

function setFieldConfig(fieldId: string, patch: FieldConfigPatch): Promise<CommandResult> {
  return update(fieldId, [{ kind: 'definition', definitionType: 'field', patch }]);
}

function createFieldDef(tagId: string, name: string, fieldType: FieldType): Promise<CommandResult> {
  return update(tagId, [{ kind: 'field', action: 'define', name, fieldType }],
    createdFocus(undefined, { kind: 'all' }, 'field-name'), { requiresDiff: true });
}

function createInlineFieldAfterNode(afterNodeId: string, name: string, fieldType: FieldType): Promise<CommandResult> {
  return update(afterNodeId, [{ kind: 'field', action: 'convert', name, fieldType }],
    focus(afterNodeId, undefined, { kind: 'all' }, 'field-name'));
}

function createInlineField(
  parentId: string,
  index: number | null,
  name: string,
  fieldType: FieldType,
  targetDefId?: string,
  id?: string,
): Promise<CommandResult> {
  if (id && !targetDefId) {
    return mutate(() => [
      {
        op: 'create',
        placement: structuralPlacement(oneId(parentId), index),
        nodes: [draft({ text: '', marks: [], inlineRefs: [] }, id)],
        bind: 'field-entry',
      },
      {
        op: 'update',
        targets: binding('field-entry'),
        changes: [{ kind: 'field', action: 'convert', name, fieldType }],
      },
    ], focus(id, parentId, { kind: 'all' }, 'field-name'), { requiresDiff: true });
  }
  const instruction: Extract<UpdateInstruction, { kind: 'field' }> = targetDefId
    ? { kind: 'field', action: 'attach', field: oneId(targetDefId), index }
    : { kind: 'field', action: 'define', name, fieldType, index };
  return update(parentId, [instruction], targetDefId
    ? createdFocus(parentId, undefined, 'trailing')
    : createdFocus(undefined, { kind: 'all' }, 'field-name'), { requiresDiff: true });
}

function updateFieldSlot(
  ownerId: string,
  fieldDefId: string,
  mutation: FieldSlotMutation,
): Promise<CommandResult> {
  const lowered = lowerFieldSlotMutation(mutation);
  const focusHint = mutation.kind === 'appendField'
    ? ('id' in mutation && mutation.id
        ? focus(mutation.id, undefined, { kind: 'all' }, 'field-name')
        : createdFocus(ownerId, { kind: 'all' }, 'field-name'))
    : fieldEntryFocus(ownerId, fieldDefId);
  return update(ownerId, [{ kind: 'field-slot', field: oneId(fieldDefId), mutation: lowered }], focusHint, {
    requiresDiff: mutation.kind === 'appendField' && !('id' in mutation && mutation.id),
  });
}

function appendFieldSource(
  ownerId: string,
  fieldDefId: string,
  valueId: string,
  sourceText: string,
  name = '',
  entryId?: string,
): Promise<CommandResult> {
  return mutate(() => [{
    op: 'update',
    targets: oneId(ownerId),
    changes: [{
      kind: 'field-slot',
      field: oneId(fieldDefId),
      mutation: {
        action: 'append-nodes',
        nodes: [draft({ text: name, marks: [], inlineRefs: [] }, valueId)],
        ...(entryId ? { entryId } : {}),
      },
    }],
  }, {
    op: 'update',
    targets: oneId(valueId),
    changes: [{ kind: 'source', action: 'add', sourceText, valueId: freshId('node') }],
  }], focus(valueId));
}

function reuseFieldDefinition(entryId: string, targetDefId: string): Promise<CommandResult> {
  return mutate(() => {
    const entry = requiredNode(requireProjection(), entryId);
    if (!entry.parentId || entry.type !== 'fieldEntry' || !entry.fieldDefId) {
      throw new Error('Field entry is unavailable.');
    }
    return [updateChange(entry.parentId, [{
      kind: 'field',
      action: 'reuse',
      field: oneId(targetDefId),
      sourceField: oneId(entry.fieldDefId),
    }])];
  }, focus(entryId));
}

function registerCollectedOption(fieldDefId: string, name: string): Promise<CommandResult> {
  return update(fieldDefId, [{ kind: 'field', action: 'register-option', name }], focus(fieldDefId));
}

function createCollectedFieldOption(fieldEntryId: string, name: string, id?: string): Promise<CommandResult> {
  const { ownerId, fieldDefId } = fieldEntryContext(fieldEntryId);
  return updateFieldSlot(ownerId, fieldDefId, {
    kind: 'appendText',
    text: name,
    collect: true,
    entryId: fieldEntryId,
    ...(id ? { id } : {}),
  });
}

function selectFieldOption(fieldEntryId: string, optionNodeId: string, id?: string): Promise<CommandResult> {
  const { ownerId, fieldDefId } = fieldEntryContext(fieldEntryId);
  return updateFieldSlot(ownerId, fieldDefId, {
    kind: 'selectOption',
    optionNodeId,
    entryId: fieldEntryId,
    ...(id ? { id } : {}),
  });
}

function setFieldFreeTextValue(fieldEntryId: string, text: string, id?: string): Promise<CommandResult> {
  const { ownerId, fieldDefId } = fieldEntryContext(fieldEntryId);
  return updateFieldSlot(ownerId, fieldDefId, {
    kind: 'appendText',
    text,
    entryId: fieldEntryId,
    ...(id ? { id } : {}),
  });
}

function clearFieldValue(fieldEntryId: string): Promise<CommandResult> {
  const { ownerId, fieldDefId } = fieldEntryContext(fieldEntryId);
  return update(ownerId, [{ kind: 'field', action: 'clear', field: oneId(fieldDefId) }], focus(ownerId));
}

function removeFieldValue(valueId: string): Promise<CommandResult> {
  const view = requireProjection();
  const value = requiredNode(view, valueId);
  if (!value.parentId) throw new Error('Field value is unavailable.');
  const { ownerId, fieldDefId } = fieldEntryContext(value.parentId);
  return update(ownerId, [{
    kind: 'field-slot',
    field: oneId(fieldDefId),
    mutation: { action: 'remove-value', value: oneId(valueId), entryId: value.parentId },
  }], focus(value.parentId));
}

function batchDeleteRows(trashIds: string[], fieldValueIds: string[]): Promise<CommandResult> {
  return mutate(() => {
    const view = requireProjection();
    const fieldChangesByOwner = new Map<string, UpdateInstruction[]>();
    for (const valueId of fieldValueIds) {
      const value = requiredNode(view, valueId);
      if (!value.parentId) throw new Error('Field value is unavailable.');
      const entryId = value.parentId;
      const { ownerId, fieldDefId } = fieldEntryContext(entryId);
      const changes = fieldChangesByOwner.get(ownerId) ?? [];
      changes.push({
        kind: 'field-slot',
        field: oneId(fieldDefId),
        mutation: { action: 'remove-value', value: oneId(valueId), entryId },
      });
      fieldChangesByOwner.set(ownerId, changes);
    }
    return [
      ...[...fieldChangesByOwner].map(([ownerId, changes]) => updateChange(ownerId, changes)),
      ...trashIds.map((nodeId): Change => ({ op: 'lifecycle', action: 'trash', targets: oneId(nodeId) })),
    ];
  });
}

function addReference(parentId: string, targetId: string, index: number | null = null): Promise<CommandResult> {
  const id = freshId('ref');
  return mutate(() => [{
    op: 'create',
    placement: structuralPlacement(oneId(parentId), index),
    nodes: [draft({ text: '', marks: [], inlineRefs: [] }, id, {
      type: 'reference', referenceTargetId: targetId,
    })],
  }], focus(id, parentId));
}

function addReferenceConversion(
  parentId: string,
  targetId: string,
  index: number | null = null,
  displayName?: string,
  id = freshId('node'),
): Promise<CommandResult> {
  return mutate(() => [{
    op: 'create',
    placement: structuralPlacement(oneId(parentId), index),
    nodes: [draft(inlineReferenceContent(targetId, displayName), id)],
  }], focus(id, parentId, { kind: 'text-offset', offset: 0, inlineRefBias: 'after' }));
}

function setReferenceTarget(referenceId: string, targetId: string): Promise<CommandResult> {
  return update(referenceId, [{ kind: 'reference', action: 'retarget', target: oneId(targetId) }], focus(referenceId));
}

function replaceNodeWithReference(nodeId: string, targetId: string): Promise<CommandResult> {
  const referenceId = freshId('ref');
  return replaceNode(nodeId, referenceId, draft({ text: '', marks: [], inlineRefs: [] }, referenceId, {
    type: 'reference', referenceTargetId: targetId,
  }), { kind: 'start' });
}

function replaceNodeWithReferenceConversion(
  nodeId: string,
  targetId: string,
  displayName?: string,
  inlineId = freshId('node'),
): Promise<CommandResult> {
  return replaceNode(nodeId, inlineId, draft(inlineReferenceContent(targetId, displayName), inlineId), {
    kind: 'text-offset', offset: 0, inlineRefBias: 'after',
  });
}

function replaceNodeWithInlineReference(nodeId: string, targetId: string): Promise<CommandResult> {
  return replaceNodeWithReferenceConversion(nodeId, targetId);
}

function convertReferenceToInlineNode(
  referenceId: string,
  replacementId = freshNodeId(),
): Promise<CommandResult> {
  return update(referenceId, [{
    kind: 'reference', action: 'inline', target: oneId(requiredReferenceTarget(referenceId)),
    replacementId,
  }], createdFocus(replacementId, { kind: 'text-offset', offset: 0, inlineRefBias: 'after' }), { requiresDiff: true });
}

function restoreInlineReferenceNodeToReference(
  nodeId: string,
  targetId: string,
  replacementId = freshNodeId(),
): Promise<CommandResult> {
  return update(nodeId, [{
    kind: 'reference', action: 'restore', target: oneId(targetId),
    replacementId,
  }], createdFocus(replacementId), { requiresDiff: true });
}

function ensureDateNode(year: number, month: number, day: number): Promise<CommandResult> {
  const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return mutate(() => [{ op: 'ensure', resource: 'date', date, bind: 'date' }], bindingFocus('date'), { requiresDiff: true });
}

async function searchNodes(query: string): Promise<SearchHit[]> {
  const projection: ProjectionResult = await requestOutline('find', {
    target: {
      selector: {
        by: 'query',
        query: { kind: 'rule', op: 'STRING_MATCH', text: query },
        includeTrash: false,
        order: 'document',
        limit: 1_000,
      },
      cardinality: 'many',
      max: 1_000,
    },
  });
  return projection.nodes.map((node) => ({ nodeId: String((node as { id: string }).id), score: 1 }));
}

function ensureTagSearch(tagId: string): Promise<CommandResult> {
  return mutate(() => [{
    op: 'ensure', resource: 'tag-search', tag: oneId(tagId), bind: 'search',
  }], bindingFocus('search'), { requiresDiff: true });
}

function setSearchQueryOutline(nodeId: string, queryOutline: string): Promise<CommandResult> {
  const view = requireProjection();
  const node = requiredNode(view, nodeId);
  if (node.type !== 'search') return Promise.reject(new Error('Expected a search Node.'));
  const parsed = parseSearchQueryOutline(view.projection, queryOutline);
  if (!parsed.ok) return Promise.reject(new Error(parsed.message));
  return update(nodeId, [{
    kind: 'search',
    action: 'set',
    title: node.content.text.trim() || 'Search',
    query: parsed.query as Extract<UpdateInstruction, { kind: 'search'; action: 'set' }>['query'],
  }]);
}

function refreshSearchNodeResults(nodeId: string): Promise<CommandResult> {
  return update(nodeId, [{ kind: 'search', action: 'refresh' }]);
}

async function backlinks(targetId: string): Promise<Backlink[]> {
  const projection: ProjectionResult = await requestOutline('get', {
    selector: { by: 'id', id: targetId },
    projection: {
      kind: 'backlinks',
      targets: oneId(targetId),
      page: { limit: 10_000 },
    },
  });
  return (projection.backlinks ?? []).map((backlink) => {
    return { sourceId: backlink.sourceId, referenceId: backlink.referenceId, kind: backlink.kind };
  });
}

function mutate(
  build: () => readonly Change[],
  focusHint?: DesktopFocusHint,
  options?: MutationOptions,
): Promise<CommandResult> {
  return runDesktopMutation((revision) => ({
    protocolVersion: 1,
    kind: 'outline.changeset',
    base: { revision },
    operations: [...build()],
  }), focusHint, options);
}

function preview(build: () => readonly Change[]): Promise<Diff> {
  return previewDesktopMutation((revision) => ({
    protocolVersion: 1,
    kind: 'outline.changeset',
    base: { revision },
    operations: [...build()],
  }));
}

function update(
  nodeId: string,
  changes: UpdateInstruction[],
  focusHint?: DesktopFocusHint,
  options?: MutationOptions,
): Promise<CommandResult> {
  return mutate(() => [updateChange(nodeId, changes)], focusHint, options);
}

function updateChange(nodeId: string, changes: UpdateInstruction[]): Change {
  return { op: 'update', targets: oneId(nodeId), changes };
}

function lifecycle(
  action: 'trash' | 'restore' | 'purge',
  nodeIds: string[],
  focusHint?: DesktopFocusHint,
  options?: { readonly acknowledgeDestructive?: boolean },
): Promise<CommandResult> {
  return mutate(
    () => nodeIds.map((nodeId) => ({ op: 'lifecycle', action, targets: oneId(nodeId) })),
    focusHint,
    options,
  );
}

function replaceNode(
  nodeId: string,
  replacementId: string,
  replacement: NodeDraft,
  placement: FocusHint['placement'],
): Promise<CommandResult> {
  let parentId: string | null = null;
  return mutate(() => {
    const view = requireProjection();
    const node = requiredNode(view, nodeId);
    if (!node.parentId) throw new Error('Cannot replace a root Node.');
    parentId = node.parentId;
    const index = requiredNode(view, parentId).children.indexOf(nodeId);
    return [
      { op: 'create', placement: { kind: 'index', parent: oneId(parentId), index }, nodes: [replacement] },
      { op: 'lifecycle', action: 'trash', targets: oneId(nodeId) },
    ];
  }, () => focus(replacementId, parentId, placement), { requiresDiff: false });
}

function oneId(id: string): TargetRef {
  return { target: { selector: { by: 'id', id }, cardinality: 'one' } };
}

function oneSourceId(id: string): OneTargetRef {
  return { target: { selector: { by: 'id', id }, cardinality: 'one' } };
}

function manyIds(ids: readonly string[]): TargetRef {
  return { target: { selector: { by: 'ids', ids: [...ids] }, cardinality: 'many', max: ids.length } };
}

function structuralPlacement(parent: TargetRef, index: number | null) {
  return index === null
    ? { kind: 'last' as const, parent }
    : { kind: 'index' as const, parent, index };
}

function binding(name: string): TargetRef {
  return { binding: name };
}

function viewField(field: string): PublicViewField {
  return field.startsWith('sys:') ? field as PublicViewField : oneId(field);
}

function draft(content: RichText, id: string, patch: Partial<NodeDraft> = {}): NodeDraft {
  return { id, content, children: [], ...patch };
}

function freshId(prefix: 'node' | 'ref'): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function focus(
  nodeId: string,
  parentId?: string | null,
  placement?: FocusHint['placement'],
  surface?: FocusHint['surface'],
): FocusHint {
  return {
    nodeId,
    ...(parentId !== undefined ? { parentId } : {}),
    ...(placement ? { placement } : {}),
    ...(surface ? { surface } : {}),
    selectAll: placement?.kind === 'all',
  };
}

function bindingFocus(name: string): DesktopFocusHint {
  return (_operation, diff) => {
    const nodeId = diff.bindings[name]?.[0];
    return nodeId ? focus(nodeId) : undefined;
  };
}

function createdFocus(
  fallbackNodeId?: string,
  placement?: FocusHint['placement'],
  surface?: FocusHint['surface'],
): DesktopFocusHint {
  return (_operation, diff, update) => {
    const createdIds = new Set(diff.affected.filter((entry) => entry.effect === 'create').map((entry) => entry.id));
    const changedNodes = update.kind === 'full' ? update.projection.nodes : update.changedNodes;
    const candidates = changedNodes.filter((node) => (
      createdIds.has(node.id) && node.type !== 'fieldDef' && node.type !== 'tagDef'
    ));
    const byId = new Map(candidates.map((node) => [node.id, node]));
    const depth = (node: NodeProjection) => {
      let value = 0;
      let parentId = node.parentId;
      while (parentId && byId.has(parentId)) {
        value += 1;
        parentId = byId.get(parentId)?.parentId;
      }
      return value;
    };
    const nodeId = candidates
      .map((node, index) => ({ node, index, depth: depth(node) }))
      .sort((left, right) => left.depth - right.depth || left.index - right.index)
      .at(-1)?.node.id
      ?? fallbackNodeId;
    return nodeId ? focus(nodeId, undefined, placement, surface) : undefined;
  };
}

function fieldEntryFocus(ownerId: string, fieldDefId: string): DesktopFocusHint {
  const current = requireProjection();
  const existingEntryId = current.byId.get(ownerId)?.children
    .map((childId) => current.byId.get(childId))
    .find((node) => node?.type === 'fieldEntry' && node.fieldDefId === fieldDefId)?.id;
  return (_operation, _diff, update) => {
    const changedNodes = update.kind === 'full' ? update.projection.nodes : update.changedNodes;
    const entryId = changedNodes.find((node) => (
      node.type === 'fieldEntry'
      && node.parentId === ownerId
      && node.fieldDefId === fieldDefId
    ))?.id ?? existingEntryId;
    return entryId ? focus(entryId) : focus(ownerId);
  };
}

function requireProjection(): DesktopProjectionView {
  const view = projectionReader?.();
  if (!view) throw new Error('Tenon Outline projection is unavailable.');
  return view;
}

function requiredNode(view: DesktopProjectionView, nodeId: string): NodeProjection {
  const node = view.byId.get(nodeId);
  if (!node) throw new Error(`Outline Node is unavailable: ${nodeId}`);
  return node;
}

function requiredContentBearingNode(
  view: DesktopProjectionView,
  nodeId: string,
): ContentBearingNodeProjection {
  const node = requiredNode(view, nodeId);
  if (!isContentBearingNode(node)) throw new Error(`Outline Node is not content-bearing: ${nodeId}`);
  return node;
}

function fieldEntryContext(fieldEntryId: string): { ownerId: string; fieldDefId: string } {
  const entry = requiredNode(requireProjection(), fieldEntryId);
  if (entry.type !== 'fieldEntry' || !entry.parentId || !entry.fieldDefId) {
    throw new Error('Field entry is unavailable.');
  }
  return { ownerId: entry.parentId, fieldDefId: entry.fieldDefId };
}

interface DefinitionBindings {
  readonly tags: Map<string, string>;
  readonly fields: Map<string, string>;
}

interface TreePlan {
  readonly operations: Change[];
  readonly lastRootId?: string;
}

interface TreePlanContext {
  nextCreateBinding(): string;
}

function createTreePlanContext(): TreePlanContext {
  let sequence = 0;
  return {
    nextCreateBinding: () => `created${sequence += 1}`,
  };
}

function buildTreePlan(
  parent: TargetRef,
  trees: readonly CreateNodeTree[],
  index: number | null = null,
  existingDefinitions?: DefinitionBindings,
  context: TreePlanContext = createTreePlanContext(),
): TreePlan {
  const definitions = existingDefinitions ?? collectTreeDefinitions(trees);
  const operations = existingDefinitions ? [] : definitionEnsureOperations(definitions);
  let lastRootId: string | undefined;
  const addTree = (tree: CreateNodeTree, parentRef: TargetRef, treeIndex: number | null): string => {
    const id = freshId('node');
    const bind = context.nextCreateBinding();
    operations.push({
      op: 'create',
      placement: structuralPlacement(parentRef, treeIndex),
      nodes: [draft(tree.content, id, {
        ...(tree.description !== undefined ? { description: tree.description } : {}),
        ...(tree.type === 'codeBlock' ? { type: 'codeBlock', codeLanguage: tree.codeLanguage } : {}),
        ...(tree.checkbox !== undefined ? { checkbox: tree.checkbox } : {}),
        ...(tree.done !== undefined ? { done: tree.done } : {}),
      })],
      bind,
    });
    const changes = metadataInstructions(tree, definitions);
    if (changes.length > 0) operations.push({ op: 'update', targets: binding(bind), changes });
    for (const child of tree.children) addTree(child, binding(bind), null);
    return id;
  };
  for (const [rootIndex, tree] of trees.entries()) {
    lastRootId = addTree(tree, parent, index === null ? null : index + rootIndex);
  }
  return { operations, ...(lastRootId ? { lastRootId } : {}) };
}

function collectTreeDefinitions(
  trees: readonly CreateNodeTree[],
  firstMeta: PasteRowMeta = {},
): DefinitionBindings {
  const tags = new Map<string, string>();
  const fields = new Map<string, string>();
  let next = 0;
  const collect = (meta: PasteRowMeta) => {
    for (const name of meta.tags ?? []) {
      const key = name.trim().toLocaleLowerCase();
      if (key && !tags.has(key)) tags.set(key, `tag${next += 1}`);
    }
    for (const field of meta.fields ?? []) {
      const key = field.name.trim().toLocaleLowerCase();
      if (key && !fields.has(key)) fields.set(key, `field${next += 1}`);
    }
  };
  collect(firstMeta);
  const visit = (tree: CreateNodeTree) => {
    collect(tree);
    for (const child of tree.children) visit(child);
  };
  for (const tree of trees) visit(tree);
  return { tags, fields };
}

function definitionEnsureOperations(definitions: DefinitionBindings): Change[] {
  return [
    ...[...definitions.tags].map(([name, bind]): Change => ({
      op: 'ensure', resource: 'definition', definitionType: 'tag', name, bind,
    })),
    ...[...definitions.fields].map(([name, bind]): Change => ({
      op: 'ensure', resource: 'definition', definitionType: 'field', name, config: { fieldType: 'plain' }, bind,
    })),
  ];
}

function metadataInstructions(meta: PasteRowMeta, definitions: DefinitionBindings): UpdateInstruction[] {
  const changes: UpdateInstruction[] = [];
  for (const name of meta.tags ?? []) {
    const bind = definitions.tags.get(name.trim().toLocaleLowerCase());
    if (bind) changes.push({ kind: 'tag', action: 'add', tag: binding(bind) });
  }
  for (const field of meta.fields ?? []) {
    const bind = definitions.fields.get(field.name.trim().toLocaleLowerCase());
    if (bind) changes.push({ kind: 'field', action: 'set', field: binding(bind), value: field.value });
  }
  return changes;
}

function outdentChange(view: DesktopProjectionView, nodeId: string): Change {
  const node = requiredNode(view, nodeId);
  if (!node.parentId) throw new Error('Cannot outdent a root Node.');
  const parent = requiredNode(view, node.parentId);
  if (!parent.parentId) throw new Error('Cannot outdent beyond the document root.');
  const index = requiredNode(view, parent.parentId).children.indexOf(parent.id) + 1;
  return { op: 'move', targets: oneId(nodeId), placement: { kind: 'index', parent: oneId(parent.parentId), index } };
}

function documentOrder(view: DesktopProjectionView, nodeIds: readonly string[]): string[] {
  const requested = new Set(nodeIds);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (nodeId: string) => {
    if (seen.has(nodeId)) return;
    seen.add(nodeId);
    if (requested.has(nodeId)) ordered.push(nodeId);
    for (const childId of view.byId.get(nodeId)?.children ?? []) visit(childId);
  };
  const roots = [...view.byId.values()].filter((node) => !node.parentId).sort((left, right) => left.id.localeCompare(right.id));
  for (const root of roots) visit(root.id);
  return [...ordered, ...nodeIds.filter((nodeId) => !seen.has(nodeId))];
}

function topLevelIds(view: DesktopProjectionView, nodeIds: readonly string[]): string[] {
  const selected = new Set(nodeIds);
  const seen = new Set<string>();
  return nodeIds.filter((nodeId) => {
    if (seen.has(nodeId)) return false;
    seen.add(nodeId);
    let parentId = view.byId.get(nodeId)?.parentId;
    while (parentId) {
      if (selected.has(parentId)) return false;
      parentId = view.byId.get(parentId)?.parentId;
    }
    return true;
  });
}

function moveSelectedSiblings(nodeIds: string[], direction: 'up' | 'down'): Promise<CommandResult> {
  return mutate(() => {
    const view = requireProjection();
    const topLevel = topLevelIds(view, nodeIds);
    const selected = new Set(topLevel);
    const parentIds = [...new Set(topLevel.map((nodeId) => requiredNode(view, nodeId).parentId))]
      .filter((parentId): parentId is string => Boolean(parentId));
    const operations: Change[] = [];
    for (const parentId of parentIds) {
      const final = [...requiredNode(view, parentId).children];
      if (direction === 'up') {
        for (let index = 1; index < final.length; index += 1) {
          if (selected.has(final[index]!) && !selected.has(final[index - 1]!)) {
            [final[index - 1], final[index]] = [final[index]!, final[index - 1]!];
          }
        }
      } else {
        for (let index = final.length - 2; index >= 0; index -= 1) {
          if (selected.has(final[index]!) && !selected.has(final[index + 1]!)) {
            [final[index], final[index + 1]] = [final[index + 1]!, final[index]!];
          }
        }
      }
      const moved = final
        .map((nodeId, index) => ({ nodeId, index }))
        .filter(({ nodeId }) => selected.has(nodeId));
      if (direction === 'down') moved.reverse();
      operations.push(...moved.map(({ nodeId, index }) => ({
        op: 'move' as const,
        targets: oneId(nodeId),
        placement: { kind: 'index' as const, parent: oneId(parentId), index },
      })));
    }
    return operations;
  });
}

function doneTransitionInstructions(
  view: DesktopProjectionView,
  node: ContentBearingNodeProjection,
  transition: 'toggle' | 'cycle',
): UpdateInstruction[] {
  const tagDriven = tagDrivenShowCheckbox(view.byId, node);
  const completedAt = nextCompletedAt({
    completedAt: node.completedAt,
    tagDriven,
    transition,
  });
  if (transition === 'toggle') {
    return [{ kind: 'done', value: typeof completedAt === 'number' && completedAt > 0 }];
  }
  if (tagDriven) return [{ kind: 'done', value: typeof completedAt === 'number' && completedAt > 0 }];
  if (completedAt === undefined) return [{ kind: 'checkbox', visible: false }];
  if (node.completedAt === undefined && completedAt === 0) {
    return [{ kind: 'checkbox', visible: true }];
  }
  return [{ kind: 'done', value: completedAt > 0 }];
}

function lowerFieldSlotMutation(
  mutation: FieldSlotMutation,
): Extract<UpdateInstruction, { kind: 'field-slot' }>['mutation'] {
  const common = mutation.entryId ? { entryId: mutation.entryId } : {};
  if (mutation.kind === 'acceptDefault') return { action: 'accept-default' };
  if (mutation.kind === 'appendText') return {
    action: 'append-text', text: mutation.text, ...common,
    ...(mutation.id ? { id: mutation.id } : {}),
    ...(mutation.collect ? { collect: true } : {}),
  };
  if (mutation.kind === 'appendReference') return {
    action: 'append-reference', target: oneId(mutation.targetId), ...common,
    ...(mutation.id ? { id: mutation.id } : {}),
  };
  if (mutation.kind === 'selectOption') return {
    action: 'select-option', option: oneId(mutation.optionNodeId), ...common,
    ...(mutation.id ? { id: mutation.id } : {}),
  };
  if (mutation.kind === 'appendNodes') return {
    action: 'append-nodes',
    nodes: mutation.nodes.map(treeDraft),
    ...(mutation.firstTagIds ? { firstTags: mutation.firstTagIds.map(oneId) } : {}),
    ...common,
    ...(mutation.id ? { id: mutation.id } : {}),
  };
  if (mutation.kind === 'appendField') return {
    action: 'append-field', name: mutation.name, fieldType: mutation.fieldType, ...common,
    ...(mutation.id ? { id: mutation.id } : {}),
  };
  return { action: 'commit', ...common };
}

function treeDraft(tree: CreateNodeTree): NodeDraft {
  const pasteMetadata = treeDraftPasteMetadata(tree);
  return {
    content: tree.content,
    children: tree.children.map(treeDraft),
    ...(tree.description !== undefined ? { description: tree.description } : {}),
    ...(tree.type === 'codeBlock' ? { type: 'codeBlock', codeLanguage: tree.codeLanguage } : {}),
    ...(tree.checkbox !== undefined ? { checkbox: tree.checkbox } : {}),
    ...(tree.done !== undefined ? { done: tree.done } : {}),
    ...(pasteMetadata ? { metadata: pasteMetadata } : {}),
  };
}

function treeDraftPasteMetadata(tree: CreateNodeTree): NodeDraft['metadata'] | undefined {
  const metadata: NonNullable<NodeDraft['metadata']> = {};
  if (tree.tags && tree.tags.length > 0) metadata.pasteTags = [...tree.tags];
  if (tree.fields && tree.fields.length > 0) {
    metadata.pasteFields = tree.fields.map((field) => ({ name: field.name, value: field.value }));
  }
  return metadata.pasteTags || metadata.pasteFields ? metadata : undefined;
}

function inlineReferenceContent(targetId: string, suppliedDisplayName?: string): RichText {
  const target = projectionReader?.()?.byId.get(targetId);
  const displayName = suppliedDisplayName
    || (target && isContentBearingNode(target) ? target.content.text : '')
    || undefined;
  return {
    text: '',
    marks: [],
    inlineRefs: [{
      offset: 0,
      target: { kind: 'node', nodeId: targetId },
      ...(displayName ? { displayName } : {}),
    }],
  };
}

function requiredReferenceTarget(referenceId: string): string {
  const reference = requiredNode(requireProjection(), referenceId);
  if (reference.type !== 'reference' || !reference.targetId) throw new Error('Reference target is unavailable.');
  return reference.targetId;
}

function templatePreviewFromDiff(diff: Diff): TagTemplateBackfillPreview {
  const additionCount = createdOrdinaryNodeIds(diff).length;
  const nodeCount = diff.affected.filter((entry) => entry.effect === 'update').length;
  return { nodeCount, additionCount };
}

function createdOrdinaryNodeIds(diff: Diff): string[] {
  return diff.affected
    .filter((entry) => entry.effect === 'create')
    .map((entry) => entry.id);
}

function bytesToBase64(data: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < data.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...data.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(''));
}

function legacyAssetMetadata(lease: AssetLease): AssetMetadata {
  return {
    schemaVersion: 1,
    id: lease.assetId,
    mimeType: lease.metadata.mimeType,
    byteSize: lease.metadata.byteSize,
    originalFilename: lease.metadata.originalFilename,
    createdAt: Date.now(),
    imageWidth: lease.metadata.imageWidth,
    imageHeight: lease.metadata.imageHeight,
    thumbnailAssetId: lease.metadata.thumbnailAssetId,
    pdfPageCount: lease.metadata.pdfPageCount,
    audioDurationMs: lease.metadata.audioDurationMs,
    videoDurationMs: lease.metadata.videoDurationMs,
  };
}
