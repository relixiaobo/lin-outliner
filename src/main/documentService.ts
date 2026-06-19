import { app } from 'electron';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DocumentCommand } from '../core/commands';
import { Core, type CoreTransactionMetadata, type OperationHistoryQuery } from '../core/core';
import { CoreError } from '../core/errors';
import {
  buildTextSearchIndex,
  buildTextSearchRecordSnapshot,
  textSearchRecordForNodeMap,
  type SearchRankingOptions,
} from '../core/searchEngine';
import { addToSetMap, removeFromSetMap } from '../core/setUtils';
import { createTextSearchIndex, type MutableTextSearchIndex, type TextSearchIndex } from '../core/textSearchIndex';
import { collectDescendantIds, nodeIsInSubtree } from '../core/treeUtils';
import type { NodeAccessSource } from '../core/nodeAccessRanking';
import { TRASH_ID } from '../core/types';
import type {
  CommandResult,
  BatchMoveNodeInput,
  DocumentProjectionChangedEvent,
  ProjectionSnapshot,
  ProjectionUpdate,
  DisplayPlacement,
  FieldConfigPatch,
  FieldType,
  FilterOperator,
  FilterValueLogic,
  FocusPlacement,
  IconKind,
  NodeProjection,
  PasteRowMeta,
  RichText,
  RichTextPatch,
  SearchNodeConfig,
  SortDirection,
  TagConfigPatch,
  ViewMode,
} from '../core/types';
import type { CreateCaptureInput } from '../core/launcher/sources';
import { parseLinOutline } from './agentOutlineParser';
import { indexProjection } from './agentNodeToolProjection';
import { resolveSearchSpecFromOutlineNode } from './agentNodeToolSearch';
import { atomicWriteFile } from './jsonFileStore';
import { NodeRetrievalService } from './nodeRetrievalService';

const WORKSPACE_FILE = 'workspace.loro.json';

export interface DocumentMutationMeta {
  origin?: 'user' | 'agent' | 'system';
  operationId?: string;
  command?: string;
  tool?: string;
  summary?: string;
}

interface TextEditGroup {
  nodeId: string;
  origin: NonNullable<DocumentMutationMeta['origin']>;
  operationId: string;
  timer?: ReturnType<typeof setTimeout>;
}

type ProjectionChangedListener = (event: DocumentProjectionChangedEvent) => void;

export class DocumentService {
  private core = Core.new();
  private mutationQueue = Promise.resolve();
  private projectionChangedListeners = new Set<ProjectionChangedListener>();
  // The last projection revision delivered to the renderer (via a command reply
  // or an event), so projection deltas form a contiguous `+1` chain. A discontinuity
  // forces a `full` reseed. Cached per-revision so the command reply and the
  // (often suppressed) event for the same mutation deliver the identical update.
  private lastEmittedProjectionRevision = -1;
  private builtProjectionUpdate: { revision: number; update: ProjectionUpdate } | null = null;
  private transactionContext = new AsyncLocalStorage<boolean>();
  private textEditGroup?: TextEditGroup;
  private readonly textEditFlushDelayMs = 700;
  private coreSavePending = false;
  private coreSaveTimer?: ReturnType<typeof setTimeout>;
  private textSearchIndex?: MutableTextSearchIndex;
  private textSearchRevision = -1;
  private textSearchNodes = new Map<string, NodeProjection>();
  private textSearchRootId = '';
  private textSearchLibraryId = '';
  private textSearchTagDependents = new Map<string, Set<string>>();
  private textSearchFieldDependents = new Map<string, Set<string>>();
  private textSearchReferenceDependents = new Map<string, Set<string>>();
  private textSearchNodeDependencies = new Map<string, {
    tagDefIds: string[];
    fieldDefIds: string[];
    referencedNodeIds: string[];
  }>();
  private searchRankingOptionsProvider?: () => SearchRankingOptions;
  private nodeAccessRecorder?: (nodeIds: readonly string[], source: NodeAccessSource) => void | Promise<void>;
  private readonly nodeRetrieval = new NodeRetrievalService({
    getProjection: () => this.core.projection(),
    getTextSearchIndex: () => this.getTextSearchIndex(),
  });

  async initWorkspace(): Promise<ProjectionSnapshot> {
    this.core = await this.loadCore();
    // The constructor lazily mints today's date node (and seeds system nodes) in
    // memory; persist immediately so its id is durable across launches. Without
    // this, a re-init mints a fresh today id while the renderer still holds the
    // old one, producing `parent not found: date:…` on the first row of today.
    if (this.core.requiresInitialPersist()) await this.saveCore();
    const projection = this.core.projection();
    this.rebuildTextSearchIndex(projection);
    return this.projectionSnapshot();
  }

  // A full projection plus its revision, used to seed the renderer (init) and to
  // resync after a delta gap. Establishes the emit-chain baseline so the next
  // mutation's delta applies cleanly.
  projectionSnapshot(): ProjectionSnapshot {
    const revision = this.core.revision();
    this.lastEmittedProjectionRevision = revision;
    this.builtProjectionUpdate = null;
    return { revision, projection: this.core.projection() };
  }

  // Build the projection update for the just-committed mutation: a `delta`
  // carrying only the changed/removed nodes when the revision advanced by exactly
  // one from the last emit, else a `full` reseed (whole-tree rewrite / discontinuity).
  // Cached per-revision so a command reply and its (usually suppressed) event
  // deliver the identical update and advance the chain once. Mirrors
  // refreshTextSearchIndexFromCoreDelta.
  private buildProjectionUpdate(): ProjectionUpdate {
    const revision = this.core.revision();
    if (this.builtProjectionUpdate && this.builtProjectionUpdate.revision === revision) {
      return this.builtProjectionUpdate.update;
    }
    if (revision === this.lastEmittedProjectionRevision) {
      // An idempotent / no-op command that did not advance the revision. Deliver an
      // empty delta at the current revision; the renderer ignores already-applied ones.
      return { kind: 'delta', revision, todayId: this.core.todayId(), changedNodes: [], removedIds: [] };
    }
    const delta = this.core.revisionDelta();
    let update: ProjectionUpdate;
    if (
      delta.requiresFullSearchRebuild
      || delta.revision !== revision
      || revision !== this.lastEmittedProjectionRevision + 1
    ) {
      update = { kind: 'full', revision, projection: this.core.projection() };
    } else {
      const present = this.core.projectionNodesFor(delta.changedNodeIds);
      update = {
        kind: 'delta',
        revision,
        todayId: this.core.todayId(),
        changedNodes: [...present.values()],
        removedIds: delta.changedNodeIds.filter((id) => !present.has(id)),
      };
    }
    this.lastEmittedProjectionRevision = revision;
    this.builtProjectionUpdate = { revision, update };
    return update;
  }

  // Full projection for the agent tool host (OutlinerToolHost). The renderer's
  // resync path uses the `get_projection` command, which returns a ProjectionSnapshot.
  getProjection() {
    return this.core.projection();
  }

  getTextSearchIndex(): TextSearchIndex {
    this.ensureTextSearchIndex();
    return this.textSearchIndex!;
  }

  getSearchRankingOptions(): SearchRankingOptions {
    return this.searchRankingOptionsProvider?.() ?? {};
  }

  setSearchRankingOptionsProvider(provider: () => SearchRankingOptions): void {
    this.searchRankingOptionsProvider = provider;
  }

  setNodeAccessRecorder(recorder: (nodeIds: readonly string[], source: NodeAccessSource) => void | Promise<void>): void {
    this.nodeAccessRecorder = recorder;
  }

  recordNodeAccess(nodeIds: readonly string[], source: NodeAccessSource): void | Promise<void> {
    return this.nodeAccessRecorder?.(nodeIds, source);
  }

  /** Project specific nodes by id without rebuilding the whole-document projection
   *  (the launcher inline-search hot path). See Core.projectionNodesByIds. */
  projectionNodesByIds(ids: Iterable<string>) {
    return this.core.projectionNodesByIds(ids);
  }

  /** The current daily-note ("today") node id. Cheap accessor — used by launcher
   *  capture after `ensure_date_node`, which no longer returns a full projection. */
  todayId() {
    return this.core.todayId();
  }

  onProjectionChanged(listener: ProjectionChangedListener) {
    this.projectionChangedListeners.add(listener);
    return () => {
      this.projectionChangedListeners.delete(listener);
    };
  }

  async operationHistory(query: OperationHistoryQuery = {}) {
    const mutatesHistory = query.action === 'undo' || query.action === 'redo';
    if (!mutatesHistory && !this.textEditGroup) {
      return this.mutationQueue.then(() => this.core.operationHistory(query));
    }
    const task = this.mutationQueue.then(async () => {
      await this.flushTextEditGroupNow();
      const result = this.core.operationHistory(query);
      if (mutatesHistory && result.count > 0) {
        this.refreshTextSearchIndexFromCoreDelta();
        this.scheduleCoreSave();
        this.emitProjectionChanged(historyChangeOrigin(query.origin));
      }
      return result;
    });
    this.mutationQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  async flushPendingChanges() {
    const task = this.mutationQueue.then(async () => {
      await this.flushTextEditGroupNow();
      await this.flushCoreSaveNow();
    });
    this.mutationQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  async transaction<T>(meta: DocumentMutationMeta, fn: () => Promise<T>) {
    const task = this.mutationQueue.then(async () => {
      await this.flushTextEditGroupNow();
      const revisionBefore = this.core.revision();
      const result = await this.core.transaction(meta.origin ?? 'user', async () =>
        this.transactionContext.run(true, fn), transactionMetadata(meta));
      if (this.core.revision() !== revisionBefore) {
        this.refreshTextSearchIndexFromCoreDelta();
        this.scheduleCoreSave();
        this.emitProjectionChanged(meta.origin ?? 'user');
      }
      return result;
    });
    this.mutationQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  async handle(command: DocumentCommand, args: Record<string, unknown> = {}, meta: DocumentMutationMeta = {}) {
    switch (command) {
      case 'init_workspace':
        return this.initWorkspace();
      case 'get_projection':
        return this.mutationQueue.then(() => this.projectionSnapshot());
      case 'search_nodes':
        return this.searchNodes(String(args.query ?? ''));
      case 'backlinks':
        return this.core.backlinks(String(args.targetId));
      default:
        return this.mutate(command, args, meta);
    }
  }

  private async mutate(command: DocumentCommand, args: Record<string, unknown>, meta: DocumentMutationMeta) {
    if (this.transactionContext.getStore()) {
      return this.runMutation(command, args, meta);
    }
    const mutationMeta = command === 'refresh_search_node_results' && !meta.origin
      ? { ...meta, origin: 'system' as const, summary: meta.summary ?? 'Refreshed search node results.' }
      : meta;
    // An eager-materialize create (`create_node` with `materialize: true`) opens
    // a text-edit undo group keyed to the new node, so the create and the text
    // patches that immediately follow on that node collapse into a single undo
    // step — undoing a half-typed new row removes the whole node, never leaving
    // a one-character orphan.
    const isMaterialize = command === 'create_node'
      && args.materialize === true
      && typeof args.id === 'string';
    const task = this.mutationQueue.then(async () => {
      if (command !== 'apply_node_text_patch') await this.flushTextEditGroupNow();
      if (command === 'apply_node_text_patch' || isMaterialize) {
        await this.flushCoreSaveNow();
      }
      const revisionBefore = this.core.revision();
      const effectiveMeta = command === 'apply_node_text_patch'
        ? await this.textEditMetadata(String(args.nodeId), mutationMeta)
        : isMaterialize
          ? this.beginMaterializeGroup(String(args.id), mutationMeta)
          : mutationMeta;
      const outcome = this.core.withOrigin(
        effectiveMeta.origin ?? 'user',
        () => this.runMutation(command, args, effectiveMeta),
        transactionMetadata({ ...effectiveMeta, command }),
      );
      const changed = this.core.revision() !== revisionBefore;
      if (command === 'apply_node_text_patch') {
        if (changed) this.scheduleTextEditFlush();
      } else if (isMaterialize) {
        // Keep the group open for the following text patches when the node was
        // created; close it immediately if the create was an idempotent retry.
        if (changed) this.scheduleTextEditFlush();
        else await this.flushTextEditGroupNow();
      } else if (changed) {
        this.refreshTextSearchIndexFromCoreDelta();
        this.scheduleCoreSave();
      }
      if (changed && (command === 'apply_node_text_patch' || isMaterialize)) this.refreshTextSearchIndexFromCoreDelta();
      if (changed) this.emitProjectionChanged(effectiveMeta.origin ?? 'user');
      const focus = 'focus' in outcome ? outcome.focus : undefined;
      const result: CommandResult = { update: this.buildProjectionUpdate(), ...(focus ? { focus } : {}) };
      return result;
    });
    this.mutationQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async textEditMetadata(nodeId: string, meta: DocumentMutationMeta): Promise<DocumentMutationMeta> {
    const origin = meta.origin ?? 'user';
    if (this.textEditGroup && (this.textEditGroup.nodeId !== nodeId || this.textEditGroup.origin !== origin)) {
      await this.flushTextEditGroupNow();
    }
    if (!this.textEditGroup) {
      this.core.beginUndoGroup();
      this.textEditGroup = {
        nodeId,
        origin,
        operationId: `op:${randomUUID()}`,
      };
    }
    return {
      ...meta,
      origin,
      operationId: this.textEditGroup.operationId,
      summary: meta.summary ?? 'Edited node text.',
    };
  }

  private beginMaterializeGroup(nodeId: string, meta: DocumentMutationMeta): DocumentMutationMeta {
    const origin = meta.origin ?? 'user';
    // Any prior group was flushed before this runs, so a materialize always
    // starts a fresh group. Subsequent `apply_node_text_patch` calls on the
    // same node id reuse this group (see `textEditMetadata`).
    this.core.beginUndoGroup();
    this.textEditGroup = {
      nodeId,
      origin,
      operationId: `op:${randomUUID()}`,
    };
    return {
      ...meta,
      origin,
      operationId: this.textEditGroup.operationId,
      summary: meta.summary ?? 'Created node.',
    };
  }

  private scheduleTextEditFlush() {
    if (!this.textEditGroup) return;
    if (this.textEditGroup.timer) clearTimeout(this.textEditGroup.timer);
    this.textEditGroup.timer = setTimeout(() => {
      void this.flushTextEditGroup();
    }, this.textEditFlushDelayMs);
  }

  private async flushTextEditGroup() {
    const task = this.mutationQueue.then(() => this.flushTextEditGroupNow());
    this.mutationQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async flushTextEditGroupNow() {
    const group = this.textEditGroup;
    if (!group) return;
    if (group.timer) clearTimeout(group.timer);
    this.textEditGroup = undefined;
    this.core.endUndoGroup();
    await this.saveCore();
    this.emitProjectionChanged(group.origin);
  }

  private scheduleCoreSave() {
    this.coreSavePending = true;
    if (this.coreSaveTimer) clearTimeout(this.coreSaveTimer);
    this.coreSaveTimer = setTimeout(() => {
      void this.flushCoreSave();
    }, this.textEditFlushDelayMs);
  }

  private async flushCoreSave() {
    const task = this.mutationQueue.then(() => this.flushCoreSaveNow());
    this.mutationQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async flushCoreSaveNow() {
    const shouldSave = this.coreSavePending;
    if (this.coreSaveTimer) clearTimeout(this.coreSaveTimer);
    this.coreSaveTimer = undefined;
    if (!shouldSave) return;
    await this.saveCore();
  }

  private runMutation(command: DocumentCommand, args: Record<string, unknown>, meta: DocumentMutationMeta) {
    switch (command) {
      case 'create_node':
        return this.core.createNode(
          String(args.parentId),
          nullableNumber(args.index),
          String(args.text ?? ''),
          typeof args.id === 'string' ? args.id : undefined,
        );
      case 'create_rich_text_node':
        return this.core.createRichTextContentNode(String(args.parentId), nullableNumber(args.index), args.content as RichText);
      case 'create_tagged_node':
        return this.core.createTaggedNode(String(args.parentId), args.content as RichText, String(args.tagId));
      case 'create_tag_and_tagged_node':
        return this.core.createTagAndTaggedNode(String(args.parentId), args.content as RichText, String(args.name ?? ''));
      case 'create_nodes_from_tree':
        return this.core.createNodesFromTree(String(args.parentId), arrayArg(args.nodes));
      case 'create_capture':
        return this.core.createCapture(args.input as CreateCaptureInput);
      case 'paste_nodes_into_node':
        return this.core.pasteNodesIntoNode(
          String(args.nodeId),
          args.content as RichText,
          arrayArg(args.children),
          arrayArg(args.siblingsAfter),
          (args.firstMeta ?? {}) as PasteRowMeta,
        );
      case 'split_node':
        return this.core.splitNode(String(args.nodeId), args.before as RichText, args.after as RichText, {
          targetParentId: nullableString(args.targetParentId),
          targetIndex: nullableNumber(args.targetIndex),
          focusPlacement: args.focusPlacement as FocusPlacement | undefined,
        });
      case 'apply_node_text_patch':
        return this.core.applyNodeTextPatch(String(args.nodeId), args.patch as RichTextPatch);
      case 'update_node_description':
        return this.core.updateNodeDescription(String(args.nodeId), nullableString(args.description));
      case 'set_node_checkbox_visible':
        return this.core.setNodeCheckboxVisible(String(args.nodeId), Boolean(args.visible));
      case 'set_code_block':
        return this.core.setCodeBlock(String(args.nodeId), nullableString(args.codeLanguage) ?? undefined);
      case 'set_code_language':
        return this.core.setCodeLanguage(String(args.nodeId), String(args.codeLanguage ?? ''));
      case 'set_command_node':
        return this.core.setCommandNode(String(args.nodeId));
      case 'set_command_schedule':
        return this.core.setCommandSchedule(
          String(args.nodeId),
          nullableString(args.schedule) ?? undefined,
          meta.origin ?? 'user',
        );
      case 'mark_command_fired':
        return this.core.markCommandFired(
          String(args.nodeId),
          nullableNumber(args.firedAt) ?? Date.now(),
          meta.origin ?? 'system',
        );
      case 'mark_command_attempted':
        return this.core.markCommandAttempted(
          String(args.nodeId),
          nullableNumber(args.attemptedAt) ?? Date.now(),
          meta.origin ?? 'system',
        );
      case 'create_image_node':
        return this.core.createImageNode(String(args.parentId), nullableNumber(args.index), {
          assetId: nullableString(args.assetId) ?? undefined,
          mediaUrl: nullableString(args.mediaUrl) ?? undefined,
          width: nullableNumber(args.width),
          height: nullableNumber(args.height),
          alt: nullableString(args.alt),
          name: nullableString(args.name),
        });
      case 'create_attachment_node':
        return this.core.createAttachmentNode(String(args.parentId), nullableNumber(args.index), {
          assetId: nullableString(args.assetId),
          mimeType: nullableString(args.mimeType),
          originalFilename: nullableString(args.originalFilename),
          fileSize: nullableNumber(args.fileSize),
          thumbnailAssetId: nullableString(args.thumbnailAssetId),
          pdfPageCount: nullableNumber(args.pdfPageCount),
          audioDurationMs: nullableNumber(args.audioDurationMs),
          videoDurationMs: nullableNumber(args.videoDurationMs),
        });
      case 'set_node_image':
        return this.core.setNodeImage(String(args.nodeId), {
          assetId: nullableString(args.assetId) ?? undefined,
          mediaUrl: nullableString(args.mediaUrl) ?? undefined,
          width: nullableNumber(args.width),
          height: nullableNumber(args.height),
        });
      case 'set_view_toolbar_visible':
        return this.core.setViewToolbarVisible(String(args.nodeId), Boolean(args.visible));
      case 'set_view_mode':
        return this.core.setViewMode(String(args.nodeId), viewMode(args.mode));
      case 'add_sort_rule':
        return this.core.addSortRule(String(args.nodeId), String(args.field), sortDirection(args.direction) ?? 'asc');
      case 'update_sort_rule':
        return this.core.updateSortRule(String(args.ruleId), String(args.field), sortDirection(args.direction) ?? 'asc');
      case 'remove_sort_rule':
        return this.core.removeSortRule(String(args.ruleId));
      case 'clear_sort_rules':
        return this.core.clearSortRules(String(args.nodeId));
      case 'add_filter_rule':
        return this.core.addFilterRule(
          String(args.nodeId),
          String(args.field),
          filterOperator(args.operator),
          arrayArg(args.values),
          filterValueLogic(args.valueLogic),
        );
      case 'update_filter_rule':
        return this.core.updateFilterRule(String(args.ruleId), {
          field: nullableString(args.field),
          operator: args.operator === undefined ? undefined : filterOperator(args.operator),
          values: args.values === undefined ? undefined : arrayArg(args.values),
          valueLogic: args.valueLogic === undefined ? undefined : filterValueLogic(args.valueLogic),
        });
      case 'remove_filter_rule':
        return this.core.removeFilterRule(String(args.ruleId));
      case 'clear_filter_rules':
        return this.core.clearFilterRules(String(args.nodeId));
      case 'set_group_field':
        return this.core.setGroupField(String(args.nodeId), nullableString(args.field));
      case 'add_display_field':
        return this.core.addDisplayField(String(args.nodeId), String(args.field));
      case 'update_display_field':
        return this.core.updateDisplayField(String(args.displayFieldId), {
          field: nullableString(args.field),
          visible: args.visible === undefined ? undefined : Boolean(args.visible),
          width: nullableNumber(args.width),
          order: nullableNumber(args.order),
          label: nullableString(args.label),
          placement: displayPlacement(args.placement),
        });
      case 'remove_display_field':
        return this.core.removeDisplayField(String(args.displayFieldId));
      case 'set_node_icon':
        return this.core.setNodeIcon(String(args.nodeId), nullableString(args.icon), iconKind(args.iconKind));
      case 'set_node_banner':
        return this.core.setNodeBanner(String(args.nodeId), nullableString(args.assetId), {
          x: nullableNumber(args.positionX),
          y: nullableNumber(args.positionY),
        });
      case 'set_search_query_outline':
        return this.setSearchQueryOutline(String(args.nodeId), String(args.queryOutline ?? ''));
      case 'merge_node_into':
        return this.core.mergeNodeInto(String(args.nodeId), String(args.targetId));
      case 'move_node':
        return this.core.moveNode(String(args.nodeId), String(args.parentId), nullableNumber(args.index));
      case 'batch_move_nodes':
        return this.core.batchMoveNodes(batchMoveNodeArgs(args.moves));
      case 'indent_node':
        return this.core.indentNode(String(args.nodeId));
      case 'outdent_node':
        return this.core.outdentNode(String(args.nodeId));
      case 'trash_node':
        return this.core.trashNode(String(args.nodeId));
      case 'batch_trash_nodes':
        return this.core.batchTrashNodes(arrayArg(args.nodeIds));
      case 'batch_indent_nodes':
        return this.core.batchIndentNodes(arrayArg(args.nodeIds));
      case 'batch_outdent_nodes':
        return this.core.batchOutdentNodes(arrayArg(args.nodeIds));
      case 'batch_toggle_done':
        return this.core.batchToggleDone(arrayArg(args.nodeIds));
      case 'batch_cycle_done_state':
        return this.core.batchCycleDoneState(arrayArg(args.nodeIds));
      case 'batch_duplicate_nodes':
        return this.core.batchDuplicateNodes(arrayArg(args.nodeIds));
      case 'batch_move_nodes_up':
        return this.core.batchMoveNodesUp(arrayArg(args.nodeIds));
      case 'batch_move_nodes_down':
        return this.core.batchMoveNodesDown(arrayArg(args.nodeIds));
      case 'batch_apply_tag':
        return this.core.batchApplyTag(arrayArg(args.nodeIds), String(args.tagId));
      case 'restore_node':
        return this.core.restoreNode(String(args.nodeId));
      case 'delete_node':
        return this.core.deleteNode(String(args.nodeId));
      case 'toggle_done':
        return this.core.toggleDone(String(args.nodeId));
      case 'cycle_done_state':
        return this.core.cycleDoneState(String(args.nodeId));
      case 'create_tag':
        return this.core.createTag(String(args.name ?? ''));
      case 'apply_tag':
        return this.core.applyTag(String(args.nodeId), String(args.tagId));
      case 'remove_tag':
        return this.core.removeTag(String(args.nodeId), String(args.tagId));
      case 'set_tag_config':
        return this.core.setTagConfig(String(args.tagId), args.patch as TagConfigPatch);
      case 'set_field_config':
        return this.core.setFieldConfig(String(args.fieldId), args.patch as FieldConfigPatch);
      case 'create_field_def':
        return this.core.createFieldDef(String(args.tagId), String(args.name), fieldType(args.fieldType));
      case 'create_inline_field_after_node':
        return this.core.createInlineFieldAfterNode(String(args.afterNodeId), String(args.name), fieldType(args.fieldType));
      case 'create_inline_field':
        return this.core.createInlineField(String(args.parentId), nullableNumber(args.index), String(args.name), fieldType(args.fieldType));
      case 'reuse_field_definition':
        return this.core.reuseFieldDefinition(String(args.entryId), String(args.targetDefId));
      case 'register_collected_option':
        return this.core.registerCollectedOption(String(args.fieldDefId), String(args.name));
      case 'create_collected_field_option':
        return this.core.createCollectedFieldOption(
          String(args.fieldEntryId),
          String(args.name),
          typeof args.id === 'string' ? args.id : undefined,
        );
      case 'select_field_option':
        return this.core.selectFieldOption(
          String(args.fieldEntryId),
          String(args.optionNodeId),
          typeof args.id === 'string' ? args.id : undefined,
        );
      case 'add_field_reference':
        return this.core.addFieldReference(
          String(args.fieldEntryId),
          String(args.targetNodeId),
          typeof args.id === 'string' ? args.id : undefined,
        );
      case 'set_field_free_text_value':
        return this.core.setFieldFreeTextValue(
          String(args.fieldEntryId),
          String(args.text),
          typeof args.id === 'string' ? args.id : undefined,
        );
      case 'clear_field_value':
        return this.core.clearFieldValue(String(args.fieldEntryId));
      case 'remove_field_value':
        return this.core.removeFieldValue(String(args.valueId));
      case 'add_reference':
        return this.core.addReference(String(args.parentId), String(args.targetId), nullableNumber(args.index));
      case 'add_reference_conversion':
        return this.core.addReferenceConversion(String(args.parentId), String(args.targetId), nullableNumber(args.index));
      case 'set_reference_target':
        return this.core.setReferenceTarget(String(args.referenceId), String(args.targetId));
      case 'replace_node_with_reference':
        return this.core.replaceNodeWithReference(String(args.nodeId), String(args.targetId));
      case 'replace_node_with_reference_conversion':
        return this.core.replaceNodeWithReferenceConversion(String(args.nodeId), String(args.targetId));
      case 'replace_node_with_inline_reference':
        return this.core.replaceNodeWithInlineReference(String(args.nodeId), String(args.targetId));
      case 'convert_reference_to_inline_node':
        return this.core.convertReferenceToInlineNode(String(args.referenceId));
      case 'restore_inline_reference_node_to_reference':
        return this.core.restoreInlineReferenceNodeToReference(String(args.nodeId), String(args.targetId));
      case 'ensure_date_node':
        return this.core.ensureDateNode(Number(args.year), Number(args.month), Number(args.day));
      case 'ensure_tag_search':
        return this.core.ensureTagSearch(String(args.tagId));
      case 'create_search_node':
        return this.core.createSearchNode(
          String(args.parentId),
          nullableNumber(args.index),
          args.config as SearchNodeConfig,
          this.textSearchIndexForCoreMutation(),
        );
      case 'set_search_node':
        return this.core.setSearchNode(String(args.nodeId), args.config as SearchNodeConfig, this.textSearchIndexForCoreMutation());
      case 'refresh_search_node_results':
        return this.core.refreshSearchNodeResults(String(args.nodeId), this.textSearchIndexForCoreMutation());
      case 'undo':
        return this.core.operationHistory({
          action: 'undo',
          origin: historyOrigin(args.historyOrigin, meta.origin),
          steps: nullableNumber(args.steps) ?? 1,
          operationId: nullableString(args.operationId) ?? undefined,
        });
      case 'redo':
        return this.core.operationHistory({
          action: 'redo',
          origin: historyOrigin(args.historyOrigin, meta.origin),
          steps: nullableNumber(args.steps) ?? 1,
          operationId: nullableString(args.operationId) ?? undefined,
        });
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  private searchNodes(query: string) {
    return this.nodeRetrieval.searchText(query, {
      limit: 50,
      ...this.getSearchRankingOptions(),
    });
  }

  private textSearchIndexForCoreMutation(): TextSearchIndex | undefined {
    return this.transactionContext.getStore()
      ? buildTextSearchIndex(this.core.projection())
      : this.getTextSearchIndex();
  }

  private ensureTextSearchIndex() {
    if (!this.textSearchIndex) {
      this.rebuildTextSearchIndex(this.core.projection());
      return;
    }
    if (this.textSearchRevision !== this.core.revision()) {
      this.refreshTextSearchIndexFromCoreDelta();
    }
  }

  private rebuildTextSearchIndex(projection = this.core.projection()) {
    const snapshot = buildTextSearchRecordSnapshot(projection);
    this.textSearchIndex = createTextSearchIndex(snapshot.records.map((entry) => entry.record));
    this.textSearchRevision = this.core.revision();
    this.textSearchNodes = snapshot.nodes as Map<string, NodeProjection>;
    this.textSearchRootId = snapshot.rootId;
    this.textSearchLibraryId = snapshot.libraryId;
    this.textSearchTagDependents.clear();
    this.textSearchFieldDependents.clear();
    this.textSearchReferenceDependents.clear();
    this.textSearchNodeDependencies.clear();
    for (const entry of snapshot.records) this.trackTextSearchDependencies(entry.record.id, entry.dependencies);
  }

  private refreshTextSearchIndexFromCoreDelta() {
    if (!this.textSearchIndex) {
      this.rebuildTextSearchIndex(this.core.projection());
      return;
    }

    const delta = this.core.revisionDelta();
    if (delta.revision === this.textSearchRevision) return;
    if (
      delta.requiresFullSearchRebuild
      || delta.revision !== this.core.revision()
      || delta.revision !== this.textSearchRevision + 1
    ) {
      this.rebuildTextSearchIndex(this.core.projection());
      return;
    }

    const changedNodeIds = new Set(delta.changedNodeIds);
    if (changedNodeIds.size === 0) {
      this.rebuildTextSearchIndex(this.core.projection());
      return;
    }

    const previousNodes = this.textSearchNodes;
    const currentChangedNodes = this.core.projectionNodesFor([...changedNodeIds]);
    const nextNodes = new Map(previousNodes);
    for (const nodeId of changedNodeIds) {
      const current = currentChangedNodes.get(nodeId);
      if (current) nextNodes.set(nodeId, current);
      else nextNodes.delete(nodeId);
    }

    const refreshIds = new Set<string>(changedNodeIds);
    for (const nodeId of changedNodeIds) {
      const before = previousNodes.get(nodeId);
      const after = nextNodes.get(nodeId);
      this.addDependentRefreshIds(refreshIds, nodeId, before, after);

      if (before && !after) {
        for (const descendantId of collectDescendantIds(previousNodes, nodeId)) {
          refreshIds.add(descendantId);
          nextNodes.delete(descendantId);
        }
        continue;
      }

      if (before && after && isInProjectionTrash(previousNodes, nodeId) !== isInProjectionTrash(nextNodes, nodeId)) {
        for (const descendantId of collectDescendantIds(previousNodes, nodeId)) refreshIds.add(descendantId);
        for (const descendantId of collectDescendantIds(nextNodes, nodeId)) refreshIds.add(descendantId);
      }
    }

    this.textSearchNodes = nextNodes;
    for (const nodeId of refreshIds) this.refreshTextSearchRecord(nodeId);
    this.textSearchRevision = delta.revision;
  }

  private addDependentRefreshIds(
    refreshIds: Set<string>,
    nodeId: string,
    before: NodeProjection | undefined,
    after: NodeProjection | undefined,
  ) {
    if (before?.type === 'tagDef' || after?.type === 'tagDef') {
      for (const dependentId of this.textSearchTagDependents.get(nodeId) ?? []) refreshIds.add(dependentId);
    }
    if (before?.type === 'fieldDef' || after?.type === 'fieldDef') {
      for (const dependentId of this.textSearchFieldDependents.get(nodeId) ?? []) refreshIds.add(dependentId);
    }
    for (const dependentId of this.textSearchReferenceDependents.get(nodeId) ?? []) refreshIds.add(dependentId);
  }

  private refreshTextSearchRecord(nodeId: string) {
    this.clearTextSearchDependencies(nodeId);
    const entry = textSearchRecordForNodeMap(
      this.textSearchNodes,
      this.textSearchRootId,
      this.textSearchLibraryId,
      nodeId,
    );
    if (!entry) {
      this.textSearchIndex?.remove(nodeId);
      return;
    }
    this.textSearchIndex?.upsert(entry.record);
    this.trackTextSearchDependencies(nodeId, entry.dependencies);
  }

  private trackTextSearchDependencies(
    nodeId: string,
    dependencies: { tagDefIds: string[]; fieldDefIds: string[]; referencedNodeIds: string[] },
  ) {
    this.textSearchNodeDependencies.set(nodeId, dependencies);
    for (const tagDefId of dependencies.tagDefIds) addToSetMap(this.textSearchTagDependents, tagDefId, nodeId);
    for (const fieldDefId of dependencies.fieldDefIds) addToSetMap(this.textSearchFieldDependents, fieldDefId, nodeId);
    for (const referencedNodeId of dependencies.referencedNodeIds) {
      addToSetMap(this.textSearchReferenceDependents, referencedNodeId, nodeId);
    }
  }

  private clearTextSearchDependencies(nodeId: string) {
    const dependencies = this.textSearchNodeDependencies.get(nodeId);
    if (!dependencies) return;
    for (const tagDefId of dependencies.tagDefIds) removeFromSetMap(this.textSearchTagDependents, tagDefId, nodeId);
    for (const fieldDefId of dependencies.fieldDefIds) removeFromSetMap(this.textSearchFieldDependents, fieldDefId, nodeId);
    for (const referencedNodeId of dependencies.referencedNodeIds) {
      removeFromSetMap(this.textSearchReferenceDependents, referencedNodeId, nodeId);
    }
    this.textSearchNodeDependencies.delete(nodeId);
  }

  private async loadCore() {
    try {
      const raw = await readFile(workspacePath(), 'utf8');
      return Core.fromState(Core.deserializeState(raw));
    } catch (error) {
      if (isNotFound(error)) return Core.new();
      throw error;
    }
  }

  private setSearchQueryOutline(nodeId: string, queryOutline: string) {
    const projection = this.core.projection();
    const searchNode = projection.nodes.find((node) => node.id === nodeId);
    if (!searchNode) throw CoreError.nodeNotFound(nodeId);
    if (searchNode.type !== 'search') throw CoreError.invalidOperation('expected a search node');

    const trimmed = queryOutline.trim();
    if (!trimmed) throw CoreError.invalidOperation('search query cannot be empty');

    const outline = [
      '- %%search%% Query',
      ...trimmed.split('\n').map((line) => `  ${line}`),
    ].join('\n');
    const parsed = parseLinOutline(outline, { annotations: 'forbid' });
    if (!parsed.ok) {
      throw CoreError.invalidOperation(`${parsed.error.message} Line ${parsed.error.line}, column ${parsed.error.column}.`);
    }

    const root = parsed.document.roots[0];
    if (!root) throw CoreError.invalidOperation('search query cannot be empty');
    const spec = resolveSearchSpecFromOutlineNode(indexProjection(projection), root);
    if ('error' in spec) throw CoreError.invalidOperation(spec.error);

    return this.core.setSearchNode(nodeId, {
      title: searchNode.content.text.trim() || 'Search',
      query: spec.query,
    }, this.textSearchIndexForCoreMutation());
  }

  private async saveCore() {
    await atomicWriteFile(workspacePath(), this.core.serializeState());
    if (this.coreSaveTimer) clearTimeout(this.coreSaveTimer);
    this.coreSaveTimer = undefined;
    this.coreSavePending = false;
  }

  private emitProjectionChanged(origin: DocumentProjectionChangedEvent['origin']) {
    if (this.projectionChangedListeners.size === 0) return;
    const event: DocumentProjectionChangedEvent = {
      type: 'projection_changed',
      origin,
      update: this.buildProjectionUpdate(),
      timestamp: Date.now(),
    };
    for (const listener of this.projectionChangedListeners) listener(event);
  }
}

function isInProjectionTrash(nodes: ReadonlyMap<string, NodeProjection>, nodeId: string): boolean {
  return nodeIsInSubtree(nodes, nodeId, TRASH_ID);
}

function workspacePath() {
  return join(app.getPath('userData'), WORKSPACE_FILE);
}

function isNotFound(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function arrayArg<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function batchMoveNodeArgs(value: unknown): BatchMoveNodeInput[] {
  return arrayArg<unknown>(value)
    .map((item) => {
      const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      return {
        nodeId: String(record.nodeId ?? ''),
        parentId: String(record.parentId ?? ''),
        index: nullableNumber(record.index),
      };
    })
    .filter((move) => move.nodeId && move.parentId);
}

function transactionMetadata(meta: DocumentMutationMeta): CoreTransactionMetadata {
  return {
    operationId: meta.operationId,
    command: meta.command,
    tool: meta.tool,
    summary: meta.summary,
  };
}

function historyOrigin(value: unknown, fallback?: DocumentMutationMeta['origin']) {
  if (value === 'all' || value === 'agent' || value === 'user') return value;
  if (fallback === 'agent') return 'agent';
  if (fallback === 'user') return 'user';
  return 'all';
}

function historyChangeOrigin(value: unknown): DocumentProjectionChangedEvent['origin'] {
  if (value === 'agent' || value === 'user' || value === 'system') return value;
  return 'agent';
}

function sortDirection(value: unknown): SortDirection | null {
  if (value === null || value === undefined) return null;
  if (value === 'asc' || value === 'desc') return value;
  throw new Error(`invalid sort direction: ${String(value)}`);
}

function viewMode(value: unknown): ViewMode {
  if (value === 'table' || value === 'cards' || value === 'calendar') return value;
  return 'list';
}

function filterOperator(value: unknown): FilterOperator {
  if (
    value === 'is'
    || value === 'is_not'
    || value === 'contains'
    || value === 'not_contains'
    || value === 'is_empty'
    || value === 'is_not_empty'
    || value === 'gt'
    || value === 'lt'
    || value === 'before'
    || value === 'after'
  ) return value;
  return 'contains';
}

function filterValueLogic(value: unknown): FilterValueLogic {
  return value === 'all' ? 'all' : 'any';
}

function iconKind(value: unknown): IconKind | null {
  if (value === 'emoji' || value === 'image' || value === 'generated') return value;
  return null;
}

function displayPlacement(value: unknown): DisplayPlacement | null {
  if (value === 'title' || value === 'body' || value === 'footer' || value === 'hidden') return value;
  return null;
}

function fieldType(value: unknown): FieldType {
  if (
    value === 'plain'
    || value === 'options'
    || value === 'options_from_supertag'
    || value === 'date'
    || value === 'number'
    || value === 'url'
    || value === 'email'
    || value === 'checkbox'
  ) {
    return value;
  }
  throw new Error(`invalid field type: ${String(value)}`);
}
