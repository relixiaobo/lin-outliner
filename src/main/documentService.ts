import { app } from 'electron';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DocumentCommand } from '../core/commands';
import { Core, type CoreTransactionMetadata, type OperationHistoryQuery } from '../core/core';
import type {
  DocumentProjectionChangedEvent,
  FieldConfigPatch,
  FieldType,
  FilterOp,
  FocusPlacement,
  RichText,
  RichTextPatch,
  SearchNodeConfig,
  SortDirection,
  TagConfigPatch,
} from '../core/types';

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
  private transactionContext = new AsyncLocalStorage<boolean>();
  private textEditGroup?: TextEditGroup;
  private readonly textEditFlushDelayMs = 700;

  async initWorkspace() {
    this.core = await this.loadCore();
    return this.core.projection();
  }

  getProjection() {
    return this.core.projection();
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
        await this.saveCore();
        this.emitProjectionChanged(historyChangeOrigin(query.origin));
      }
      return result;
    });
    this.mutationQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  async flushPendingChanges() {
    const task = this.mutationQueue.then(() => this.flushTextEditGroupNow());
    this.mutationQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  async transaction<T>(meta: DocumentMutationMeta, fn: () => Promise<T>) {
    const task = this.mutationQueue.then(async () => {
      await this.flushTextEditGroupNow();
      const before = this.core.intoState();
      const result = await this.core.transaction(meta.origin ?? 'user', async () =>
        this.transactionContext.run(true, fn), transactionMetadata(meta));
      if (!sameJson(before, this.core.intoState())) {
        await this.saveCore();
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
        return this.getProjection();
      case 'search_nodes':
        return this.core.searchNodes(String(args.query ?? ''));
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
    const task = this.mutationQueue.then(async () => {
      if (command !== 'apply_node_text_patch') {
        await this.flushTextEditGroupNow();
      }
      const before = this.core.intoState();
      const textEditMeta = command === 'apply_node_text_patch'
        ? await this.textEditMetadata(String(args.nodeId), mutationMeta)
        : mutationMeta;
      const outcome = this.core.withOrigin(
        textEditMeta.origin ?? 'user',
        () => this.runMutation(command, args, textEditMeta),
        transactionMetadata({ ...textEditMeta, command }),
      );
      const changed = !sameJson(before, this.core.intoState());
      if (command === 'apply_node_text_patch') {
        if (changed) this.scheduleTextEditFlush();
      } else if (changed) {
        await this.saveCore();
      }
      if (changed) this.emitProjectionChanged(textEditMeta.origin ?? 'user');
      return outcome;
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

  private runMutation(command: DocumentCommand, args: Record<string, unknown>, meta: DocumentMutationMeta) {
    switch (command) {
      case 'create_node':
        return this.core.createNode(String(args.parentId), nullableNumber(args.index), String(args.text ?? ''));
      case 'create_rich_text_node':
        return this.core.createRichTextContentNode(String(args.parentId), nullableNumber(args.index), args.content as RichText);
      case 'create_tagged_node':
        return this.core.createTaggedNode(String(args.parentId), args.content as RichText, String(args.tagId));
      case 'create_tag_and_tagged_node':
        return this.core.createTagAndTaggedNode(String(args.parentId), args.content as RichText, String(args.name ?? ''));
      case 'create_nodes_from_tree':
        return this.core.createNodesFromTree(String(args.parentId), arrayArg(args.nodes));
      case 'paste_nodes_into_node':
        return this.core.pasteNodesIntoNode(
          String(args.nodeId),
          args.content as RichText,
          arrayArg(args.children),
          arrayArg(args.siblingsAfter),
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
      case 'set_node_toolbar_visible':
        return this.core.setNodeToolbarVisible(String(args.nodeId), Boolean(args.visible));
      case 'set_node_sort':
        return this.core.setNodeSort(String(args.nodeId), nullableString(args.field), sortDirection(args.direction));
      case 'set_node_filter':
        return this.core.setNodeFilter(
          String(args.nodeId),
          nullableString(args.field),
          filterOp(args.op),
          arrayArg(args.values),
        );
      case 'set_node_group':
        return this.core.setNodeGroup(String(args.nodeId), nullableString(args.field));
      case 'merge_node_into':
        return this.core.mergeNodeInto(String(args.nodeId), String(args.targetId));
      case 'move_node':
        return this.core.moveNode(String(args.nodeId), String(args.parentId), nullableNumber(args.index));
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
      case 'register_collected_option':
        return this.core.registerCollectedOption(String(args.fieldDefId), String(args.name));
      case 'create_collected_field_option':
        return this.core.createCollectedFieldOption(String(args.fieldEntryId), String(args.name));
      case 'select_field_option':
        return this.core.selectFieldOption(String(args.fieldEntryId), String(args.optionNodeId));
      case 'clear_field_value':
        return this.core.clearFieldValue(String(args.fieldEntryId));
      case 'add_reference':
        return this.core.addReference(String(args.parentId), String(args.targetId), nullableNumber(args.index));
      case 'set_reference_target':
        return this.core.setReferenceTarget(String(args.referenceId), String(args.targetId));
      case 'replace_node_with_reference':
        return this.core.replaceNodeWithReference(String(args.nodeId), String(args.targetId));
      case 'convert_reference_to_inline_node':
        return this.core.convertReferenceToInlineNode(String(args.referenceId));
      case 'restore_inline_reference_node_to_reference':
        return this.core.restoreInlineReferenceNodeToReference(String(args.nodeId), String(args.targetId));
      case 'ensure_date_node':
        return this.core.ensureDateNode(Number(args.year), Number(args.month), Number(args.day));
      case 'ensure_tag_search':
        return this.core.ensureTagSearch(String(args.tagId));
      case 'create_search_node':
        return this.core.createSearchNode(String(args.parentId), nullableNumber(args.index), args.config as SearchNodeConfig);
      case 'set_search_node':
        return this.core.setSearchNode(String(args.nodeId), args.config as SearchNodeConfig);
      case 'refresh_search_node_results':
        return this.core.refreshSearchNodeResults(String(args.nodeId));
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

  private async loadCore() {
    try {
      const raw = await readFile(workspacePath(), 'utf8');
      return Core.fromState(Core.deserializeState(raw));
    } catch (error) {
      if (isNotFound(error)) return Core.new();
      throw error;
    }
  }

  private async saveCore() {
    const path = workspacePath();
    await mkdir(dirname(path), { recursive: true });
    await atomicWrite(path, this.core.serializeState());
  }

  private emitProjectionChanged(origin: DocumentProjectionChangedEvent['origin']) {
    if (this.projectionChangedListeners.size === 0) return;
    const event: DocumentProjectionChangedEvent = {
      type: 'projection_changed',
      origin,
      projection: this.core.projection(),
      timestamp: Date.now(),
    };
    for (const listener of this.projectionChangedListeners) listener(event);
  }
}

function workspacePath() {
  return join(app.getPath('userData'), WORKSPACE_FILE);
}

async function atomicWrite(path: string, data: string) {
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
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

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sortDirection(value: unknown): SortDirection | null {
  if (value === null || value === undefined) return null;
  if (value === 'asc' || value === 'desc') return value;
  throw new Error(`invalid sort direction: ${String(value)}`);
}

function filterOp(value: unknown): FilterOp | null {
  if (value === null || value === undefined) return null;
  if (value === 'all' || value === 'any') return value;
  throw new Error(`invalid filter operator: ${String(value)}`);
}

function fieldType(value: unknown): FieldType {
  if (
    value === 'plain'
    || value === 'options'
    || value === 'options_from_supertag'
    || value === 'date'
    || value === 'number'
    || value === 'password'
    || value === 'formula'
    || value === 'user'
    || value === 'url'
    || value === 'email'
    || value === 'checkbox'
    || value === 'boolean'
    || value === 'color'
  ) {
    return value;
  }
  throw new Error(`invalid field type: ${String(value)}`);
}
