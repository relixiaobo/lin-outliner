import type { CreateCaptureInput } from '../core/launcher/sources';
import { isActionCommand, type CommandName } from '../core/actions/bindings';
import {
  isContentBearingNode,
  type CreateNodeTree,
  DocumentProjection,
  FocusHint,
  NodeProjection,
  RichText,
  ViewMode,
} from '../core/types';
import type {
  Change,
  NodeDraft,
  TargetRef,
  UpdateInstruction,
} from '../outline/contract/schemas';
import type { OutlineMutationOptions } from './outlineDocumentService';

export interface OutlineActionDocumentCapability {
  getProjection(): DocumentProjection;
  runChanges(
    changes: readonly Change[],
    options?: OutlineMutationOptions,
  ): Promise<unknown>;
}

interface ProjectionView {
  readonly projection: DocumentProjection;
  readonly byId: ReadonlyMap<string, NodeProjection>;
}

export function runOutlineActionCommand(
  document: OutlineActionDocumentCapability,
  command: string,
  args: Record<string, unknown>,
) {
  if (!isActionCommand(command)) throw new Error(`Unsupported Outline action command: ${command}`);
  const view = projectionView(document.getProjection());
  const plan = actionChanges(command, args, view);
  return document.runChanges(plan.changes, plan.options);
}

function actionChanges(
  command: CommandName,
  args: Record<string, unknown>,
  view: ProjectionView,
): { readonly changes: readonly Change[]; readonly options?: OutlineMutationOptions } {
  switch (command) {
    case 'set_view_mode': {
      const nodeId = stringArg(args, 'nodeId');
      const mode = args.mode;
      if (mode !== 'list' && mode !== 'table' && mode !== 'cards' && mode !== 'calendar') {
        throw new Error('Action view mode is invalid.');
      }
      return update(nodeId, [{ kind: 'view', property: 'mode', action: 'set', mode }]);
    }
    case 'set_view_toolbar_visible': {
      const nodeId = stringArg(args, 'nodeId');
      return update(nodeId, [{
        kind: 'view', property: 'toolbar', action: 'set', visible: booleanArg(args, 'visible'),
      }]);
    }
    case 'move_node': {
      const nodeId = stringArg(args, 'nodeId');
      return {
        changes: [{
          op: 'move',
          targets: oneId(nodeId),
          placement: placement(oneId(stringArg(args, 'parentId')), nullableIndexArg(args, 'index')),
        }],
        options: { focus: focus(nodeId) },
      };
    }
    case 'batch_trash_nodes':
      return lifecycle('trash', stringArrayArg(args, 'nodeIds').reverse());
    case 'batch_indent_nodes':
      return { changes: batchIndentChanges(view, stringArrayArg(args, 'nodeIds')) };
    case 'batch_outdent_nodes':
      return {
        changes: stringArrayArg(args, 'nodeIds').reverse().map((nodeId) => outdentChange(view, nodeId)),
      };
    case 'batch_toggle_done':
      return {
        changes: stringArrayArg(args, 'nodeIds').map((nodeId) => updateChange(nodeId, [{
          kind: 'done', value: !nodeDone(requiredNode(view, nodeId)),
        }])),
      };
    case 'batch_duplicate_nodes':
      return duplicateChanges(view, stringArrayArg(args, 'nodeIds'));
    case 'batch_move_nodes_up':
      return { changes: moveSelectedSiblingChanges(view, stringArrayArg(args, 'nodeIds'), 'up') };
    case 'batch_move_nodes_down':
      return { changes: moveSelectedSiblingChanges(view, stringArrayArg(args, 'nodeIds'), 'down') };
    case 'batch_apply_tag': {
      const tagId = stringArg(args, 'tagId');
      return {
        changes: stringArrayArg(args, 'nodeIds').map((nodeId) => updateChange(nodeId, [{
          kind: 'tag', action: 'add', tag: oneId(tagId),
        }])),
      };
    }
    case 'restore_node': {
      const nodeId = stringArg(args, 'nodeId');
      return lifecycle('restore', [nodeId], { focus: focus(nodeId) });
    }
    case 'delete_node':
      return lifecycle('purge', [stringArg(args, 'nodeId')], { acknowledgeDestructive: true });
    case 'toggle_done': {
      const nodeId = stringArg(args, 'nodeId');
      return {
        ...update(nodeId, [{ kind: 'done', value: !nodeDone(requiredNode(view, nodeId)) }]),
        options: { focus: focus(nodeId) },
      };
    }
    case 'create_tag':
      return {
        changes: [{
          op: 'ensure', resource: 'definition', definitionType: 'tag', name: stringArg(args, 'name'), bind: 'tag',
        }],
        options: { focus: bindingFocus('tag') },
      };
    case 'apply_tag': {
      const nodeId = stringArg(args, 'nodeId');
      return {
        ...update(nodeId, [{ kind: 'tag', action: 'add', tag: oneId(stringArg(args, 'tagId')) }]),
        options: { focus: focus(nodeId) },
      };
    }
    case 'remove_field_value':
      return removeFieldValueChanges(view, stringArg(args, 'valueId'));
    case 'ensure_date_node': {
      const date = `${padDatePart(integerArg(args, 'year'), 4)}-${padDatePart(integerArg(args, 'month'), 2)}-${padDatePart(integerArg(args, 'day'), 2)}`;
      return {
        changes: [{ op: 'ensure', resource: 'date', date, bind: 'date' }],
        options: { focus: bindingFocus('date') },
      };
    }
    case 'create_capture':
      return captureChanges(recordArg(args, 'input') as unknown as CreateCaptureInput, view);
  }
  const unsupported: never = command;
  throw new Error(`Unsupported Outline action command: ${unsupported}`);
}

function captureChanges(input: CreateCaptureInput, view: ProjectionView): {
  readonly changes: readonly Change[];
  readonly options: OutlineMutationOptions;
} {
  const operations: Change[] = [];
  if (input.tag && input.tagExtends && input.tag !== input.tagExtends) {
    operations.push({
      op: 'ensure',
      resource: 'definition',
      definitionType: 'tag',
      name: input.tagExtends,
      bind: 'captureTagExtends',
    });
  }
  if (input.tag) {
    operations.push({
      op: 'ensure',
      resource: 'definition',
      definitionType: 'tag',
      name: input.tag,
      ...(input.tagExtends && input.tag !== input.tagExtends
        ? { extends: binding('captureTagExtends') }
        : {}),
      bind: 'captureTag',
    });
  }
  for (const [index, field] of (input.fields ?? []).entries()) {
    operations.push({
      op: 'ensure',
      resource: 'definition',
      definitionType: 'field',
      id: field.field.id,
      name: field.field.name,
      config: { fieldType: field.field.type },
      bind: `captureField${index + 1}`,
    } as Change);
  }
  const definitionIds = new Map<string, string>();
  const children = (input.children ?? []).map((tree) => captureTreeDraft(
    tree,
    view,
    operations,
    definitionIds,
  ));
  operations.push({
    op: 'create',
    placement: placement(oneId(input.destinationParentId), input.index ?? null),
    nodes: [{
      content: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.metadata ? { metadata: { capture: input.metadata } } : {}),
      ...(input.fields?.length ? {
        fields: input.fields.map((field) => ({
          fieldDefId: field.field.id,
          values: [{ content: plainText(field.value), children: [] }],
        })),
      } : {}),
      children,
    }],
    bind: 'capture',
  });
  if (input.sourceText !== undefined) {
    operations.push({
      op: 'update',
      targets: binding('capture'),
      changes: [{
        kind: 'source',
        action: 'add',
        sourceText: input.sourceText,
        valueId: `node:${crypto.randomUUID()}`,
      }],
    });
  }
  if (input.tag) {
    operations.push({
      op: 'update',
      targets: binding('capture'),
      changes: [{ kind: 'tag', action: 'add', tag: binding('captureTag') }],
    });
  }
  return {
    changes: operations,
    options: { focus: bindingFocus('capture') },
  };
}

function captureTreeDraft(
  tree: CreateNodeTree,
  view: ProjectionView,
  definitions: Change[],
  definitionIds: Map<string, string>,
): NodeDraft {
  const id = `node:${crypto.randomUUID()}`;
  const ensureDefinition = (type: 'tag' | 'field', name: string) => {
    const key = `${type}:${name.trim().toLocaleLowerCase()}`;
    const cached = definitionIds.get(key);
    if (cached) return cached;
    const existing = view.projection.nodes.find((node) => (
      node.type === (type === 'tag' ? 'tagDef' : 'fieldDef')
      && node.content.text.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase()
    ));
    if (existing) {
      definitionIds.set(key, existing.id);
      return existing.id;
    }
    const definitionId = `node:${crypto.randomUUID()}`;
    const bind = `captureTreeDefinition${definitionIds.size + 1}`;
    definitionIds.set(key, definitionId);
    definitions.push({
      op: 'ensure',
      resource: 'definition',
      definitionType: type,
      id: definitionId,
      name,
      ...(type === 'field' ? { config: { fieldType: 'plain' } } : {}),
      bind,
    } as Change);
    return definitionId;
  };
  const tags = (tree.tags ?? [])
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((name) => ensureDefinition('tag', name));
  const fields = (tree.fields ?? []).flatMap((field) => {
    const name = field.name.trim();
    const value = field.value.trim();
    if (!name || !value) return [];
    return [{
      fieldDefId: ensureDefinition('field', name),
      values: [{ content: plainText(value), children: [] }],
    }];
  });
  return {
    id,
    content: tree.content,
    ...(tree.description !== undefined ? { description: tree.description } : {}),
    ...(tree.type === 'codeBlock' ? { type: 'codeBlock', codeLanguage: tree.codeLanguage } : {}),
    ...(tree.checkbox !== undefined ? { checkbox: tree.checkbox } : {}),
    ...(tree.done !== undefined ? { done: tree.done } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(fields.length > 0 ? { fields } : {}),
    children: tree.children.map((child) => captureTreeDraft(
      child,
      view,
      definitions,
      definitionIds,
    )),
  };
}

function batchIndentChanges(view: ProjectionView, nodeIds: string[]): Change[] {
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
}

function duplicateChanges(
  view: ProjectionView,
  nodeIds: string[],
): { readonly changes: readonly Change[]; readonly options: OutlineMutationOptions } {
  return {
    changes: topLevelIds(view, nodeIds).map((nodeId) => {
      const node = requiredNode(view, nodeId);
      if (!node.parentId) throw new Error('Cannot duplicate a root Node.');
      return { op: 'duplicate', targets: oneId(nodeId), placement: { kind: 'next' } };
    }),
    options: {
      focus: (_operation, diff) => {
        const created = diff.affected.find((entry) => entry.effect === 'create')?.id;
        return created ? focus(created) : undefined;
      },
    },
  };
}

function moveSelectedSiblingChanges(
  view: ProjectionView,
  nodeIds: string[],
  direction: 'up' | 'down',
): Change[] {
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
}

function removeFieldValueChanges(
  view: ProjectionView,
  valueId: string,
): { readonly changes: readonly Change[]; readonly options: OutlineMutationOptions } {
  const value = requiredNode(view, valueId);
  if (!value.parentId) throw new Error('Field value is unavailable.');
  const entry = requiredNode(view, value.parentId);
  if (entry.type !== 'fieldEntry' || !entry.parentId || !entry.fieldDefId) {
    throw new Error('Field entry is unavailable.');
  }
  return {
    ...update(entry.parentId, [{
      kind: 'field-slot',
      field: oneId(entry.fieldDefId),
      mutation: { action: 'remove-value', value: oneId(valueId), entryId: entry.id },
    }]),
    options: { focus: focus(entry.id) },
  };
}

function lifecycle(
  action: 'trash' | 'restore' | 'purge',
  nodeIds: string[],
  options: OutlineMutationOptions = {},
) {
  return {
    changes: nodeIds.map((nodeId): Change => ({ op: 'lifecycle', action, targets: oneId(nodeId) })),
    options,
  };
}

function update(nodeId: string, changes: UpdateInstruction[]) {
  return { changes: [updateChange(nodeId, changes)] };
}

function updateChange(nodeId: string, changes: UpdateInstruction[]): Change {
  return { op: 'update', targets: oneId(nodeId), changes };
}

function outdentChange(view: ProjectionView, nodeId: string): Change {
  const node = requiredNode(view, nodeId);
  if (!node.parentId) throw new Error('Cannot outdent a root Node.');
  const parent = requiredNode(view, node.parentId);
  if (!parent.parentId) throw new Error('Cannot outdent beyond the document root.');
  const index = requiredNode(view, parent.parentId).children.indexOf(parent.id) + 1;
  return { op: 'move', targets: oneId(nodeId), placement: { kind: 'index', parent: oneId(parent.parentId), index } };
}

function placement(parent: TargetRef, index: number | null) {
  return index === null
    ? { kind: 'last' as const, parent }
    : { kind: 'index' as const, parent, index };
}

function documentOrder(view: ProjectionView, nodeIds: readonly string[]): string[] {
  const requested = new Set(nodeIds);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (nodeId: string) => {
    if (seen.has(nodeId)) return;
    seen.add(nodeId);
    if (requested.has(nodeId)) ordered.push(nodeId);
    for (const childId of view.byId.get(nodeId)?.children ?? []) visit(childId);
  };
  const roots = [...view.byId.values()]
    .filter((node) => !node.parentId)
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const root of roots) visit(root.id);
  return [...ordered, ...nodeIds.filter((nodeId) => !seen.has(nodeId))];
}

function topLevelIds(view: ProjectionView, nodeIds: readonly string[]): string[] {
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

function projectionView(projection: DocumentProjection): ProjectionView {
  return { projection, byId: new Map(projection.nodes.map((node) => [node.id, node])) };
}

function requiredNode(view: ProjectionView, nodeId: string): NodeProjection {
  const node = view.byId.get(nodeId);
  if (!node) throw new Error(`Outline Node is unavailable: ${nodeId}`);
  return node;
}

function nodeDone(node: NodeProjection): boolean {
  return isContentBearingNode(node)
    && typeof node.completedAt === 'number'
    && node.completedAt > 0;
}

function oneId(id: string): TargetRef {
  return { target: { selector: { by: 'id', id }, cardinality: 'one' } };
}

function binding(name: string): TargetRef {
  return { binding: name };
}

function focus(nodeId: string): FocusHint {
  return { nodeId, selectAll: false };
}

function bindingFocus(name: string): NonNullable<OutlineMutationOptions['focus']> {
  return (_operation, diff) => {
    const nodeId = diff.bindings[name]?.[0];
    return nodeId ? focus(nodeId) : undefined;
  };
}

function plainText(text: string): RichText {
  return { text, marks: [], inlineRefs: [] };
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !value) throw new Error(`Action argument ${name} must be a non-empty string.`);
  return value;
}

function stringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
    throw new Error(`Action argument ${name} must be an array of Node IDs.`);
  }
  return [...new Set(value as string[])];
}

function booleanArg(args: Record<string, unknown>, name: string): boolean {
  const value = args[name];
  if (typeof value !== 'boolean') throw new Error(`Action argument ${name} must be boolean.`);
  return value;
}

function integerArg(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (!Number.isSafeInteger(value)) throw new Error(`Action argument ${name} must be an integer.`);
  return Number(value);
}

function nullableIndexArg(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Action argument ${name} must be a non-negative integer or null.`);
  }
  return Number(value);
}

function recordArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = args[name];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Action argument ${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function padDatePart(value: number, width: number): string {
  return String(value).padStart(width, '0');
}
