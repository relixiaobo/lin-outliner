import { LoroDoc, LoroList, LoroText, UndoManager, type LoroMap, type LoroTree, type LoroTreeNode, type TreeID, type Value } from 'loro-crdt';
import { CoreError } from './errors';
import {
  WORKSPACE_ID,
  createNodeRecord,
  referenceTargetSortKey,
  referenceTargetsEqual,
  type DocumentState,
  type Node,
  type NodeFieldKey,
  type NodeType,
  type RichText,
  type RichTextPatch,
  type RichTextPatchOp,
  type TextMark,
} from './types';

export type LoroUndoScope = 'all' | 'agent' | 'user';

export interface SerializedLoroDocumentState {
  kind: 'loro-document';
  schemaVersion: 2;
  snapshot: string;
  peerId?: string;
}

const LORO_TREE_NAME = 'nodes';
const INLINE_REF_MARK = 'inlineRef';
const INLINE_REF_PLACEHOLDER = '\uFFFC';
const TEXT_MARK_KEYS = ['bold', 'italic', 'strike', 'code', 'highlight', 'headingMark', 'link'] as const;
const UNDO_EXCLUDED_ORIGIN_PREFIXES = ['__seed__', 'system:'];
const AGENT_UNDO_EXCLUDED_ORIGIN_PREFIXES = ['__seed__', 'system:', 'user:'];
const USER_UNDO_EXCLUDED_ORIGIN_PREFIXES = ['__seed__', 'system:', 'agent:'];
const LORO_DELETED_ROOT_ID = '2147483647@18446744073709551615' as TreeID;
const NODE_SCALAR_KEYS: NodeFieldKey[] = [
  'type',
  'description',
  'createdAt',
  'updatedAt',
  'completedAt',
  'locked',
  'icon',
  'iconKind',
  'bannerAssetId',
  'bannerPositionX',
  'bannerPositionY',
  'bannerAlt',
  'templateId',
  'fieldDefId',
  'configKey',
  'refRole',
  'autoCollected',
  'targetId',
  'viewMode',
  'toolbarVisible',
  'sortField',
  'sortDirection',
  'groupField',
  'filterField',
  'filterOperator',
  'filterValueLogic',
  'filterValues',
  'displayField',
  'displayVisible',
  'displayWidth',
  'displayOrder',
  'displayLabel',
  'displayPlacement',
  'queryLogic',
  'queryOp',
  'queryTagDefId',
  'queryFieldDefId',
  'queryTargetId',
  'codeLanguage',
  'assetId',
  'mediaUrl',
  'mediaAlt',
  'imageWidth',
  'imageHeight',
  'mimeType',
  'originalFilename',
  'fileSize',
  'thumbnailAssetId',
  'pdfPageCount',
  'audioDurationMs',
  'videoDurationMs',
  'embedType',
  'embedId',
  'sourceUrl',
  'aiSummary',
  // user-only-writable field keys (e.g. a command node's schedule); a string[]
  // that round-trips through the generic clone path (same as `capture`).
  'protectedFields',
  // Typed launcher-capture sidecar. A JSON-compatible object persists as a node
  // scalar via the generic writeNodeData/clone path (same as filterValues), and
  // round-trips through the JSON clone on read.
  'capture',
  'trashedFromParentId',
  'trashedFromIndex',
];

export class LoroOutlinerDocument {
  private doc: LoroDoc;
  private tree: LoroTree;
  private undoManager: UndoManager;
  private aiUndoManager: UndoManager;
  private userUndoManager: UndoManager;
  private nodeIdToTreeId = new Map<string, TreeID>();
  private touchedNodeIds = new Set<string>();
  private pendingUndoValue: Value | undefined;
  private undoGroupActive = false;
  // The id→TreeID map is maintained incrementally (create sets, delete removes,
  // move is a no-op since TreeIDs are stable). Only operations that rewrite the
  // tree wholesale — import, revertTo, loro undo/redo — invalidate it; they set
  // this flag so the next lookup rebuilds once instead of every lookup paying O(N).
  private mappingsDirty = false;
  // Live materialized-state cache. `materializeState()` is on every read/mutation
  // path, so it must not walk the whole tree each time. The cache is patched
  // write-through: `touchNode` records the dirty ids in `statePatch`, and a read
  // re-materializes only those. Whole-tree rewrites (import/undo/redo/revert) set
  // `stateDirtyFull` to force one full rebuild. `null` means "never built yet".
  private stateCacheNodes: Record<string, Node> | null = null;
  private statePatch = new Set<string>();
  private stateDirtyFull = false;

  constructor(state?: SerializedLoroDocumentState) {
    this.doc = new LoroDoc();
    this.doc.setChangeMergeInterval(0);
    this.doc.configTextStyle({
      bold: { expand: 'after' },
      italic: { expand: 'after' },
      strike: { expand: 'after' },
      code: { expand: 'after' },
      highlight: { expand: 'after' },
      headingMark: { expand: 'after' },
      link: { expand: 'none' },
      [INLINE_REF_MARK]: { expand: 'none' },
    });
    this.tree = this.doc.getTree(LORO_TREE_NAME);
    if (state?.peerId) {
      try {
        this.doc.setPeerId(state.peerId as `${number}`);
      } catch {
        // Keep Loro's generated peer id if the stored value is not accepted.
      }
    }
    if (state?.snapshot) this.doc.import(decodeBase64(state.snapshot));
    this.rebuildMappings();
    this.undoManager = this.createUndoManager(UNDO_EXCLUDED_ORIGIN_PREFIXES);
    this.aiUndoManager = this.createUndoManager(AGENT_UNDO_EXCLUDED_ORIGIN_PREFIXES);
    this.userUndoManager = this.createUndoManager(USER_UNDO_EXCLUDED_ORIGIN_PREFIXES);
  }

  isEmpty() {
    return this.nodeIdToTreeId.size === 0;
  }

  serialize(commitOrigin: string): SerializedLoroDocumentState {
    this.commit(commitOrigin);
    return {
      kind: 'loro-document',
      schemaVersion: 2,
      snapshot: encodeBase64(this.doc.export({ mode: 'snapshot' })),
      peerId: this.doc.peerIdStr,
    };
  }

  commit(origin: string, undoValue?: unknown) {
    this.pendingUndoValue = undoValue as Value | undefined;
    try {
      // Committing finalizes pending ops; it never reassigns TreeIDs, so the
      // incrementally-maintained map stays valid and needs no rebuild here.
      this.doc.commit({ origin });
    } finally {
      this.pendingUndoValue = undefined;
    }
  }

  rebuildMappings() {
    this.nodeIdToTreeId.clear();
    for (const treeNode of this.tree.nodes()) {
      if (isDeletedTreeNode(treeNode)) continue;
      const id = readString(treeNode.data.get('id'));
      if (!id) continue;
      this.nodeIdToTreeId.set(id, treeNode.id);
    }
    this.mappingsDirty = false;
  }

  private ensureMappings() {
    if (this.mappingsDirty) this.rebuildMappings();
  }

  clearRedo() {
    this.undoManager.clearRedo();
    this.aiUndoManager.clearRedo();
    this.userUndoManager.clearRedo();
  }

  undo(scope: LoroUndoScope) {
    const result = this.undoManagerFor(scope).undo();
    // Undo replays ops directly on the doc without our touchNode hooks, so it
    // can recreate/remove arbitrary nodes — the map and the state cache must be
    // rebuilt from scratch before the next lookup.
    this.invalidateWholeTree();
    return result;
  }

  redo(scope: LoroUndoScope) {
    const result = this.undoManagerFor(scope).redo();
    this.invalidateWholeTree();
    return result;
  }

  canUndo(scope: LoroUndoScope) {
    return this.undoManagerFor(scope).canUndo();
  }

  canRedo(scope: LoroUndoScope) {
    return this.undoManagerFor(scope).canRedo();
  }

  topUndoValue(scope: LoroUndoScope) {
    return this.undoManagerFor(scope).topUndoValue();
  }

  topRedoValue(scope: LoroUndoScope) {
    return this.undoManagerFor(scope).topRedoValue();
  }

  beginUndoGroup(): boolean {
    if (this.undoGroupActive) return false;
    this.undoManager.groupStart();
    this.aiUndoManager.groupStart();
    this.userUndoManager.groupStart();
    this.undoGroupActive = true;
    return true;
  }

  endUndoGroup(): boolean {
    if (!this.undoGroupActive) return false;
    this.undoManager.groupEnd();
    this.aiUndoManager.groupEnd();
    this.userUndoManager.groupEnd();
    this.undoGroupActive = false;
    return true;
  }

  frontiers() {
    return this.doc.frontiers();
  }

  revertTo(frontiers: ReturnType<LoroDoc['frontiers']>, origin: string) {
    this.doc.revertTo(frontiers);
    this.commit(origin);
    // Reverting rewrites the tree to an earlier state; map and cache are stale.
    this.invalidateWholeTree();
  }

  private invalidateWholeTree() {
    this.mappingsDirty = true;
    this.stateDirtyFull = true;
  }

  clearTouchedNodeIds() {
    this.touchedNodeIds.clear();
  }

  drainTouchedNodeIds() {
    const ids = [...this.touchedNodeIds].sort();
    this.clearTouchedNodeIds();
    return ids;
  }

  hasNode(nodeId: string) {
    return this.treeNodeOrUndefined(nodeId) !== undefined;
  }

  writeNode(node: Node) {
    const treeNode = this.requiredTreeNode(node.id);
    writeNodeData(treeNode.data, normalizeNode(node));
    this.touchNode(node.id);
  }

  applyNodeTextPatch(nodeId: string, patch: RichTextPatch) {
    const treeNode = this.requiredTreeNode(nodeId);
    const text = ensureLoroText(treeNode.data, 'content');
    for (const op of patch.ops) applyRichTextPatchOp(text, op);
    treeNode.data.delete('contentMarks');
    treeNode.data.delete('contentInlineRefs');
    this.touchNode(nodeId);
  }

  setNodeUpdatedAt(nodeId: string, updatedAt: number) {
    const treeNode = this.requiredTreeNode(nodeId);
    treeNode.data.set('updatedAt', updatedAt);
    this.touchNode(nodeId);
  }

  createNodeWithId<T extends Node = Node>(
    id: string,
    parentId: string | undefined,
    index: number | null | undefined,
    type: NodeType | undefined,
    configure: (node: T) => void,
  ) {
    const parentTreeNode = parentId ? this.treeNodeOrUndefined(parentId) : undefined;
    if (parentId && !parentTreeNode) throw CoreError.parentNotFound(parentId);
    const parentTreeId = parentTreeNode?.id;
    const targetIndex = parentTreeNode
      ? clampInsertIndex(index, parentTreeNode.children()?.length ?? 0)
      : clampInsertIndex(index, this.tree.roots().length);
    const treeNode = this.tree.createNode(parentTreeId, targetIndex);
    // The caller's `type` argument fixes the variant; `T` lets it set
    // variant-specific fields on the configured node without a local cast.
    const node = createNodeRecord(id, type, parentId, nowMs()) as T;
    configure(node);
    writeNodeData(treeNode.data, normalizeNode(node));
    this.nodeIdToTreeId.set(id, treeNode.id);
    this.touchNode(id);
    if (parentId) this.touchNode(parentId);
    return id;
  }

  moveNode(nodeId: string, parentId: string, index: number | null | undefined) {
    const state = this.materializeState();
    if (nodeId === parentId || isDescendant(state, parentId, nodeId)) throw CoreError.invalidMove();
    if (!state.nodes[nodeId]) throw CoreError.nodeNotFound(nodeId);
    if (!state.nodes[parentId]) throw CoreError.parentNotFound(parentId);
    const treeNode = this.requiredTreeNode(nodeId);
    const parentTreeNode = this.requiredTreeNode(parentId);
    const targetIndex = clampInsertIndex(index, parentTreeNode.children()?.length ?? 0);
    this.tree.move(treeNode.id, parentTreeNode.id, targetIndex);
    this.touchNode(nodeId);
    if (state.nodes[nodeId]?.parentId) this.touchNode(state.nodes[nodeId]!.parentId!);
    this.touchNode(parentId);
  }

  deleteNode(nodeId: string) {
    const state = this.materializeState();
    const removed = subtreeIds(state, nodeId);
    for (const id of removed) this.touchNode(id);
    const parentId = state.nodes[nodeId]?.parentId;
    if (parentId) this.touchNode(parentId);
    this.tree.delete(this.requiredTreeNode(nodeId).id);
    // Drop the deleted subtree from the map incrementally — TreeIDs of the
    // surviving nodes are unchanged, so a full rebuild is unnecessary.
    for (const id of removed) this.nodeIdToTreeId.delete(id);
  }

  materializeState(): DocumentState {
    this.reconcileStateCache();
    // Return a fresh container over the cached node objects: callers may add or
    // remove `nodes` entries without corrupting the cache. The node objects are
    // shared (read-only by contract — mutators clone before writing), so this is
    // an O(N) reference copy rather than a full re-materialize.
    return {
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      rootId: WORKSPACE_ID,
      nodes: { ...this.stateCacheNodes },
    };
  }

  private reconcileStateCache() {
    if (this.stateCacheNodes === null || this.stateDirtyFull) {
      this.stateCacheNodes = this.buildAllNodes();
      if (cacheFreezeEnabled()) for (const id of Object.keys(this.stateCacheNodes)) deepFreeze(this.stateCacheNodes[id]);
      this.statePatch.clear();
      this.stateDirtyFull = false;
      return;
    }
    if (this.statePatch.size === 0) return;
    for (const id of this.statePatch) {
      const node = this.materializeNode(id);
      if (node) this.stateCacheNodes[id] = cacheFreezeEnabled() ? deepFreeze(node) : node;
      else delete this.stateCacheNodes[id];
    }
    this.statePatch.clear();
  }

  // Full walk of the tree into a normalized node map. The Loro tree is the single
  // source of truth: system-node seeding and legacy migration are persisted into
  // it once at construction (Core's `ensureSystemNodesDirect`), so reads no longer
  // re-apply them as a per-read view transform. That keeps materialization a pure,
  // cacheable projection of the tree and lets the incremental patch path stay
  // consistent with the full build.
  private buildAllNodes(): Record<string, Node> {
    const nodes: Record<string, Node> = {};
    const visit = (treeNode: LoroTreeNode) => {
      const node = this.readNodeFromTree(treeNode);
      if (node) nodes[node.id] = node;
      for (const child of treeNode.children() ?? []) visit(child);
    };

    for (const root of this.tree.roots()) visit(root);
    return normalizeState({
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      rootId: WORKSPACE_ID,
      nodes,
    }).nodes;
  }

  // Materialize a single node by id from the tree, mirroring exactly what
  // `materializeState` produces per node (minus the whole-state normalization
  // and system-node seeding, which are not per-node concerns). This is the
  // building block for the incremental cache: re-read only the touched nodes.
  materializeNode(id: string): Node | undefined {
    const treeNode = this.treeNodeOrUndefined(id);
    if (!treeNode) return undefined;
    return this.readNodeFromTree(treeNode);
  }

  private readNodeFromTree(treeNode: LoroTreeNode): Node | undefined {
    if (isDeletedTreeNode(treeNode)) return undefined;
    const data = treeNode.data;
    const id = readString(data.get('id'));
    if (!id) return undefined;
    const parentTreeNode = treeNode.parent();
    const parentId = parentTreeNode ? readString(parentTreeNode.data.get('id')) : undefined;
    const content = readRichText(data);
    const filterValues = data.get('filterValues');
    const node = normalizeNode({
      id,
      type: readString(data.get('type')) as NodeType | undefined,
      parentId,
      children: [],
      content,
      tags: readStringList(data.get('tags')),
      createdAt: readNumber(data.get('createdAt')) ?? nowMs(),
      updatedAt: readNumber(data.get('updatedAt')) ?? nowMs(),
      locked: readBoolean(data.get('locked')) ?? false,
      autoCollected: readBoolean(data.get('autoCollected')) ?? false,
    } as Node);
    // filterValues lives on the filterRule variant; persistence writes it
    // generically (only filterRule data carries it).
    if (filterValues !== undefined) (node as { filterValues?: string[] }).filterValues = readStringList(filterValues);

    for (const key of NODE_SCALAR_KEYS) {
      if ([
        'type',
        'createdAt',
        'updatedAt',
        'locked',
        'autoCollected',
        'filterValues',
      ].includes(key)) continue;
      const value = data.get(key);
      if (value !== undefined && value !== null) {
        (node as unknown as Record<string, unknown>)[key] = clone(value);
      }
    }

    const children = treeNode.children() ?? [];
    for (const child of children) {
      const childId = readString(child.data.get('id'));
      if (childId) node.children.push(childId);
    }
    return node;
  }

  private undoManagerFor(scope: LoroUndoScope) {
    if (scope === 'agent') return this.aiUndoManager;
    if (scope === 'user') return this.userUndoManager;
    return this.undoManager;
  }

  private createUndoManager(excludeOriginPrefixes: string[]) {
    let poppedValue: Value | undefined;
    return new UndoManager(this.doc, {
      mergeInterval: 0,
      excludeOriginPrefixes,
      onPush: () => {
        const value = this.pendingUndoValue ?? poppedValue ?? null;
        poppedValue = undefined;
        return { value, cursors: [] };
      },
      onPop: (_isUndo, value) => {
        poppedValue = value.value;
      },
    });
  }

  private requiredTreeNode(nodeId: string) {
    this.ensureMappings();
    const treeId = this.nodeIdToTreeId.get(nodeId);
    const treeNode = treeId ? this.tree.getNodeByID(treeId) : undefined;
    if (!treeNode || isDeletedTreeNode(treeNode)) throw CoreError.nodeNotFound(nodeId);
    return treeNode;
  }

  private treeNodeOrUndefined(nodeId: string) {
    this.ensureMappings();
    const treeId = this.nodeIdToTreeId.get(nodeId);
    const treeNode = treeId ? this.tree.getNodeByID(treeId) : undefined;
    return treeNode && !isDeletedTreeNode(treeNode) ? treeNode : undefined;
  }

  private touchNode(nodeId: string) {
    this.touchedNodeIds.add(nodeId);
    this.statePatch.add(nodeId);
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
  };
}

// Read-only contract enforcement (dev/test only). The state cache hands out
// shared node objects; callers must clone before mutating. With LIN_VERIFY_CACHE
// set, cached nodes are frozen so any in-place mutation throws immediately rather
// than silently corrupting the cache. Off (and free) in production.
function cacheFreezeEnabled() {
  return process.env.LIN_VERIFY_CACHE === '1';
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function isDeletedTreeNode(treeNode: LoroTreeNode) {
  return treeNode.isDeleted() || treeNode.parent()?.id === LORO_DELETED_ROOT_ID;
}

function isDescendant(state: DocumentState, nodeId: string, ancestorId: string): boolean {
  let parentId = state.nodes[nodeId]?.parentId;
  while (parentId) {
    if (parentId === ancestorId) return true;
    parentId = state.nodes[parentId]?.parentId;
  }
  return false;
}

function subtreeIds(state: DocumentState, nodeId: string): string[] {
  const node = state.nodes[nodeId];
  if (!node) return [];
  return [nodeId, ...node.children.flatMap((childId) => subtreeIds(state, childId))];
}

function clampInsertIndex(index: number | null | undefined, length: number): number | undefined {
  if (index === null || index === undefined) return undefined;
  return Math.max(0, Math.min(index, length));
}

function nowMs() {
  return Date.now();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function encodeBase64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('base64');
}

function decodeBase64(value: string) {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readStringList(value: unknown): string[] {
  if (value instanceof LoroList) return value.toJSON().filter((item: unknown): item is string => typeof item === 'string');
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

function readRichText(data: LoroMap): RichText {
  const content = data.get('content');
  const fallbackMarks = data.get('contentMarks');
  const fallbackInlineRefs = data.get('contentInlineRefs');
  if (content instanceof LoroText) {
    const richText = richTextFromDelta(content.toDelta());
    return {
      text: richText.text,
      marks: richText.marks.length > 0
        ? richText.marks
        : Array.isArray(fallbackMarks) ? clone(fallbackMarks) as TextMark[] : [],
      inlineRefs: richText.inlineRefs.length > 0
        ? richText.inlineRefs
        : Array.isArray(fallbackInlineRefs) ? clone(fallbackInlineRefs) as RichText['inlineRefs'] : [],
    };
  }
  return {
    text: typeof content === 'string' ? content : '',
    marks: Array.isArray(fallbackMarks) ? clone(fallbackMarks) as TextMark[] : [],
    inlineRefs: Array.isArray(fallbackInlineRefs) ? clone(fallbackInlineRefs) as RichText['inlineRefs'] : [],
  };
}

function writeNodeData(data: LoroMap, node: Node) {
  data.set('id', node.id);
  for (const key of NODE_SCALAR_KEYS) {
    const value = (node as unknown as Record<string, unknown>)[key];
    if (value === undefined || value === null) data.delete(key);
    else data.set(key, clone(value) as Value);
  }
  writeRichText(data, 'content', node.content);
  data.delete('contentMarks');
  data.delete('contentInlineRefs');
  writeStringList(data, 'tags', node.tags);
}

function writeJsonValue(data: LoroMap, key: string, value: unknown) {
  if (value === undefined || value === null) data.delete(key);
  else data.set(key, clone(value) as Value);
}

function writeRichText(data: LoroMap, key: string, value: RichText) {
  const loroText = ensureLoroText(data, key);
  const current = loroText.toString();
  const encoded = encodeRichText(value);
  clearRichTextMarks(loroText, current.length);
  if (current !== encoded.text) loroText.splice(0, current.length, encoded.text);
  clearRichTextMarks(loroText, encoded.text.length);
  for (const mark of value.marks) {
    const start = clampTextOffset(mark.start, value.text.length);
    const end = clampTextOffset(mark.end, value.text.length);
    if (end <= start) continue;
    loroText.mark({
      start: toInternalTextOffset(start, value.inlineRefs, true),
      end: toInternalTextOffset(end, value.inlineRefs, false),
    }, mark.type, mark.attrs && Object.keys(mark.attrs).length > 0 ? clone(mark.attrs) : true);
  }
  for (const inlineRef of encoded.inlineRefs) {
    loroText.mark({
      start: inlineRef.internalOffset,
      end: inlineRef.internalOffset + INLINE_REF_PLACEHOLDER.length,
    }, INLINE_REF_MARK, {
      target: clone(inlineRef.target) as Value,
      ...(inlineRef.displayName ? { displayName: inlineRef.displayName } : {}),
      ...(inlineRef.mimeType ? { mimeType: inlineRef.mimeType } : {}),
      ...(typeof inlineRef.sizeBytes === 'number' ? { sizeBytes: inlineRef.sizeBytes } : {}),
    });
  }
}

function ensureLoroText(data: LoroMap, key: string) {
  let text = data.get(key);
  if (!(text instanceof LoroText)) {
    data.delete(key);
    text = data.setContainer(key, new LoroText());
  }
  return text as LoroText;
}

function applyRichTextPatchOp(text: LoroText, op: RichTextPatchOp) {
  if (op.type === 'replace_all') {
    replaceAllRichText(text, op.content);
    return;
  }
  if (op.type === 'replace') {
    replaceRichTextRange(text, op);
    return;
  }

  const current = richTextFromDelta(text.toDelta());
  const start = toInternalTextOffset(clampTextOffset(op.from, current.text.length), current.inlineRefs, false);
  const end = toInternalTextOffset(clampTextOffset(op.to, current.text.length), current.inlineRefs, false);
  if (end <= start) return;
  if (op.type === 'add_mark') {
    text.mark({ start, end }, op.markType, op.attrs && Object.keys(op.attrs).length > 0 ? clone(op.attrs) : true);
  } else {
    text.unmark({ start, end }, op.markType);
  }
}

function replaceAllRichText(text: LoroText, content: RichText) {
  const current = text.toString();
  const encoded = encodeRichText(content);
  clearRichTextMarks(text, current.length);
  if (current !== encoded.text) text.splice(0, current.length, encoded.text);
  clearRichTextMarks(text, encoded.text.length);
  markInsertedRichText(text, 0, content, encoded.inlineRefs);
}

function replaceRichTextRange(text: LoroText, op: Extract<RichTextPatchOp, { type: 'replace' }>) {
  deleteInlineRefs(text, op.deletedInlineRefs ?? []);

  const current = richTextFromDelta(text.toDelta());
  const from = clampTextOffset(op.from, current.text.length);
  const to = Math.max(from, clampTextOffset(op.to, current.text.length));
  const start = toInternalTextOffset(from, current.inlineRefs, true);
  const end = toInternalTextOffset(to, current.inlineRefs, false);
  const encoded = encodeRichText(op.content);
  text.splice(start, Math.max(0, end - start), encoded.text);
  markInsertedRichText(text, start, op.content, encoded.inlineRefs);
}

function deleteInlineRefs(text: LoroText, refs: readonly RichText['inlineRefs'][number][]) {
  if (refs.length === 0) return;
  const encoded = encodeRichText(richTextFromDelta(text.toDelta()));
  const usedInternalOffsets = new Set<number>();
  const internalOffsets: number[] = [];
  for (const ref of refs) {
    const match = encoded.inlineRefs.find((candidate) =>
      !usedInternalOffsets.has(candidate.internalOffset)
      && candidate.offset === ref.offset
      && referenceTargetsEqual(candidate.target, ref.target)
      && (ref.displayName === undefined || candidate.displayName === ref.displayName));
    if (!match) continue;
    usedInternalOffsets.add(match.internalOffset);
    internalOffsets.push(match.internalOffset);
  }
  for (const internalOffset of internalOffsets.sort((left, right) => right - left)) {
    text.splice(internalOffset, INLINE_REF_PLACEHOLDER.length, '');
  }
}

function markInsertedRichText(
  text: LoroText,
  baseOffset: number,
  content: RichText,
  inlineRefs: Array<RichText['inlineRefs'][number] & { internalOffset: number }>,
) {
  for (const mark of content.marks) {
    const start = clampTextOffset(mark.start, content.text.length);
    const end = clampTextOffset(mark.end, content.text.length);
    if (end <= start) continue;
    text.mark({
      start: baseOffset + toInternalTextOffset(start, content.inlineRefs, false),
      end: baseOffset + toInternalTextOffset(end, content.inlineRefs, false),
    }, mark.type, mark.attrs && Object.keys(mark.attrs).length > 0 ? clone(mark.attrs) : true);
  }
  for (const inlineRef of inlineRefs) {
    text.mark({
      start: baseOffset + inlineRef.internalOffset,
      end: baseOffset + inlineRef.internalOffset + INLINE_REF_PLACEHOLDER.length,
    }, INLINE_REF_MARK, {
      target: clone(inlineRef.target) as Value,
      ...(inlineRef.displayName ? { displayName: inlineRef.displayName } : {}),
      ...(inlineRef.mimeType ? { mimeType: inlineRef.mimeType } : {}),
      ...(typeof inlineRef.sizeBytes === 'number' ? { sizeBytes: inlineRef.sizeBytes } : {}),
    });
  }
}

function richTextFromDelta(delta: unknown[]): RichText {
  let text = '';
  const marks: TextMark[] = [];
  const inlineRefs: RichText['inlineRefs'] = [];

  for (const item of delta) {
    if (!item || typeof item !== 'object') continue;
    const insert = (item as { insert?: unknown }).insert;
    if (typeof insert !== 'string') continue;
    const attributes = normalizeAttributes((item as { attributes?: unknown }).attributes);
    for (let index = 0; index < insert.length; index += 1) {
      const char = insert[index] ?? '';
      const inlineRef = normalizeInlineRef(attributes[INLINE_REF_MARK]);
      if (char === INLINE_REF_PLACEHOLDER && inlineRef) {
        inlineRefs.push({ offset: text.length, ...inlineRef });
        continue;
      }
      const start = text.length;
      text += char;
      const end = text.length;
      for (const key of TEXT_MARK_KEYS) {
        const value = attributes[key];
        if (value === undefined || value === null || value === false) continue;
        marks.push({
          start,
          end,
          type: key,
          ...(typeof value === 'object' && !Array.isArray(value) ? { attrs: stringifyRecord(value) } : {}),
        });
      }
    }
  }

  return {
    text,
    marks: mergeAdjacentTextMarks(marks),
    inlineRefs,
  };
}

function encodeRichText(content: RichText) {
  const inlineRefs = [...content.inlineRefs]
    .map((ref) => ({ ...ref, offset: clampTextOffset(ref.offset, content.text.length) }))
    .sort((left, right) => left.offset - right.offset || referenceTargetSortKey(left.target).localeCompare(referenceTargetSortKey(right.target)));
  let text = '';
  let cursor = 0;
  const encodedRefs: Array<RichText['inlineRefs'][number] & { internalOffset: number }> = [];
  for (const ref of inlineRefs) {
    text += content.text.slice(cursor, ref.offset);
    cursor = ref.offset;
    const internalOffset = text.length;
    text += INLINE_REF_PLACEHOLDER;
    encodedRefs.push({ ...ref, internalOffset });
  }
  text += content.text.slice(cursor);
  return { text, inlineRefs: encodedRefs };
}

function clearRichTextMarks(text: LoroText, length: number) {
  if (length <= 0) return;
  for (const key of [...TEXT_MARK_KEYS, INLINE_REF_MARK]) text.unmark({ start: 0, end: length }, key);
}

function toInternalTextOffset(offset: number, inlineRefs: RichText['inlineRefs'], includeRefsAtOffset: boolean) {
  const refCount = inlineRefs.filter((ref) =>
    includeRefsAtOffset ? ref.offset <= offset : ref.offset < offset).length;
  return offset + refCount;
}

function clampTextOffset(offset: number, length: number) {
  return Math.max(0, Math.min(Number.isFinite(offset) ? offset : 0, length));
}

function normalizeAttributes(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeInlineRef(value: unknown): Omit<RichText['inlineRefs'][number], 'offset'> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const target = normalizeReferenceTarget(record.target);
  if (!target) return undefined;
  return {
    target,
    ...(typeof record.displayName === 'string' && record.displayName ? { displayName: record.displayName } : {}),
    ...(typeof record.mimeType === 'string' && record.mimeType ? { mimeType: record.mimeType } : {}),
    ...(typeof record.sizeBytes === 'number' && Number.isFinite(record.sizeBytes) ? { sizeBytes: record.sizeBytes } : {}),
  };
}

function normalizeReferenceTarget(value: unknown): RichText['inlineRefs'][number]['target'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === 'node' && typeof record.nodeId === 'string' && record.nodeId) {
    return { kind: 'node', nodeId: record.nodeId };
  }
  if (
    record.kind === 'local-file'
    && typeof record.path === 'string'
    && record.path
    && (record.entryKind === 'file' || record.entryKind === 'directory')
  ) {
    return { kind: 'local-file', path: record.path, entryKind: record.entryKind };
  }
  if (
    record.kind === 'chat-source'
    && (record.stream === 'conversation' || record.stream === 'run')
    && typeof record.streamId === 'string'
    && record.streamId
    && record.range
    && typeof record.range === 'object'
    && !Array.isArray(record.range)
  ) {
    const range = record.range as Record<string, unknown>;
    const fromSeqExclusive = numberInteger(range.fromSeqExclusive);
    const throughSeq = numberInteger(range.throughSeq);
    const throughEventId = typeof range.throughEventId === 'string'
      ? range.throughEventId
      : range.throughEventId === null ? null : undefined;
    const fromCreatedAtInclusive = numberInteger(range.fromCreatedAtInclusive);
    const throughCreatedAtExclusive = numberInteger(range.throughCreatedAtExclusive);
    const createdAtClamp = normalizeCreatedAtClamp(fromCreatedAtInclusive, throughCreatedAtExclusive);
    if (
      fromSeqExclusive !== null
      && fromSeqExclusive >= 0
      && throughSeq !== null
      && throughSeq > fromSeqExclusive
      && ((fromCreatedAtInclusive === null && throughCreatedAtExclusive === null) || createdAtClamp)
    ) {
      return {
        kind: 'chat-source',
        stream: record.stream,
        streamId: record.streamId,
        range: {
          fromSeqExclusive,
          throughSeq,
          ...(throughEventId !== undefined ? { throughEventId } : {}),
          ...(createdAtClamp ?? {}),
        },
      };
    }
  }
  return undefined;
}

function numberInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function normalizeCreatedAtClamp(
  fromCreatedAtInclusive: number | null,
  throughCreatedAtExclusive: number | null,
): { fromCreatedAtInclusive: number; throughCreatedAtExclusive: number } | null {
  if (fromCreatedAtInclusive === null && throughCreatedAtExclusive === null) return null;
  if (
    fromCreatedAtInclusive !== null
    && fromCreatedAtInclusive >= 0
    && throughCreatedAtExclusive !== null
    && throughCreatedAtExclusive > fromCreatedAtInclusive
  ) {
    return { fromCreatedAtInclusive, throughCreatedAtExclusive };
  }
  return null;
}

function stringifyRecord(value: object): Record<string, string> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

function mergeAdjacentTextMarks(marks: TextMark[]) {
  const result: TextMark[] = [];
  for (const mark of marks.sort((left, right) =>
    left.start - right.start
    || left.end - right.end
    || left.type.localeCompare(right.type)
    || JSON.stringify(left.attrs ?? {}).localeCompare(JSON.stringify(right.attrs ?? {})))) {
    const last = result[result.length - 1];
    if (
      last
      && last.type === mark.type
      && last.end === mark.start
      && JSON.stringify(last.attrs ?? {}) === JSON.stringify(mark.attrs ?? {})
    ) {
      last.end = mark.end;
    } else {
      result.push(clone(mark));
    }
  }
  return result;
}

function writeStringList(data: LoroMap, key: string, values: string[]) {
  let list = data.get(key);
  if (!(list instanceof LoroList)) {
    data.delete(key);
    list = data.setContainer(key, new LoroList());
  }
  const loroList = list as LoroList;
  if (loroList.length > 0) loroList.delete(0, loroList.length);
  values.forEach((value, index) => loroList.insert(index, value));
}
