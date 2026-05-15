import { app } from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DocumentCommand } from '../core/commands';
import { Core } from '../core/core';
import type { FieldConfigPatch, FieldType, FilterOp, RichText, SortDirection, TagConfigPatch } from '../core/types';

const WORKSPACE_FILE = 'workspace.json';

export class DocumentService {
  private core = Core.new();
  private mutationQueue = Promise.resolve();

  async initWorkspace() {
    this.core = await this.loadCore();
    return this.core.projection();
  }

  getProjection() {
    return this.core.projection();
  }

  async handle(command: DocumentCommand, args: Record<string, unknown> = {}) {
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
        return this.mutate(command, args);
    }
  }

  private async mutate(command: DocumentCommand, args: Record<string, unknown>) {
    const task = this.mutationQueue.then(async () => {
      const outcome = this.runMutation(command, args);
      await this.saveCore();
      return outcome;
    });
    this.mutationQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private runMutation(command: DocumentCommand, args: Record<string, unknown>) {
    switch (command) {
      case 'create_node':
        return this.core.createNode(String(args.parentId), nullableNumber(args.index), String(args.text ?? ''));
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
        return this.core.splitNode(String(args.nodeId), args.before as RichText, args.after as RichText);
      case 'update_node_text':
        return this.core.updateNodeText(String(args.nodeId), args.content as RichText);
      case 'update_node_description':
        return this.core.updateNodeDescription(String(args.nodeId), nullableString(args.description));
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
      case 'select_field_option':
        return this.core.selectFieldOption(String(args.fieldEntryId), String(args.optionNodeId));
      case 'add_reference':
        return this.core.addReference(String(args.parentId), String(args.targetId), nullableNumber(args.index));
      case 'replace_node_with_reference':
        return this.core.replaceNodeWithReference(String(args.nodeId), String(args.targetId));
      case 'ensure_date_node':
        return this.core.ensureDateNode(Number(args.year), Number(args.month), Number(args.day));
      case 'ensure_tag_search':
        return this.core.ensureTagSearch(String(args.tagId));
      case 'undo':
        return this.core.undo();
      case 'redo':
        return this.core.redo();
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
