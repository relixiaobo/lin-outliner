import { expect, type Page } from '@playwright/test';

export const ids = {
  workspace: 'workspace',
  root: 'root',
  daily: 'daily',
  schema: 'schema',
  searches: 'searches',
  trash: 'trash',
  settings: 'settings',
  today: 'today',
  dayTag: 'tag-day',
  projectTag: 'tag-project',
  statusField: 'field-status',
  alpha: 'node-alpha',
  beta: 'node-beta',
  gamma: 'node-gamma',
} as const;

type E2EWindow = Window & {
  __LIN_E2E__?: {
    calls: Array<{ cmd: string; args: Record<string, unknown> }>;
    projection: () => unknown;
    clipboardText: () => string;
  };
  lin?: {
    invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    onAgentEvent: (listener: (event: unknown) => void) => () => void;
  };
};

export async function installElectronMock(page: Page) {
  await page.addInitScript(({ ids }) => {
    type RichText = { text: string; marks: unknown[]; inlineRefs: Array<{ offset: number; targetNodeId: string; displayName?: string }> };
    type RichTextPatch = {
      ops: Array<
        | { type: 'replace_all'; content: RichText }
        | { type: 'replace'; from: number; to: number; content: RichText }
        | { type: 'add_mark'; from: number; to: number; markType: string; attrs?: Record<string, string> }
        | { type: 'remove_mark'; from: number; to: number; markType: string }
      >;
    };
    type MockNode = {
      id: string;
      type?: string;
      parentId?: string;
      children: string[];
      content: RichText;
      description?: string;
      tags: string[];
      createdAt: number;
      updatedAt: number;
      completedAt?: number;
      locked: boolean;
      color?: string;
      showCheckbox: boolean;
      childSupertag?: string;
      extends?: string;
      doneStateEnabled: boolean;
      fieldDefId?: string;
      fieldType?: string;
      nullable?: boolean;
      hideField?: string;
      autoInitialize?: string;
      autocollectOptions: boolean;
      autoCollected: boolean;
      minValue?: number;
      maxValue?: number;
      sourceSupertag?: string;
      toolbarVisible: boolean;
      filterValues: string[];
      targetId?: string;
    };
    type CreateNodeTree = {
      content: RichText;
      children: CreateNodeTree[];
    };

    const win = window as E2EWindow;
    const rich = (text: string): RichText => ({ text, marks: [], inlineRefs: [] });
    const nodes = new Map<string, MockNode>();
    let now = 1_800_000_000_000;
    let sequence = 0;
    let clipboardText = '';
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];

    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    const applyRichTextPatch = (content: RichText, patch: RichTextPatch): RichText => {
      let next = clone(content);
      for (const op of patch.ops) {
        if (op.type === 'replace_all') {
          next = clone(op.content);
          continue;
        }
        if (op.type === 'replace') {
          const from = Math.max(0, Math.min(next.text.length, op.from));
          const to = Math.max(from, Math.min(next.text.length, op.to));
          next = {
            text: `${next.text.slice(0, from)}${op.content.text}${next.text.slice(to)}`,
            marks: clone(op.content.marks),
            inlineRefs: [
              ...next.inlineRefs.filter((ref) => ref.offset < from || ref.offset > to),
              ...op.content.inlineRefs.map((ref) => ({ ...ref, offset: from + ref.offset })),
            ],
          };
          continue;
        }
        if (op.type === 'add_mark') {
          next.marks.push({ start: op.from, end: op.to, type: op.markType, attrs: op.attrs });
          continue;
        }
        next.marks = next.marks.filter((mark) => {
          const typed = mark as { type?: string; start?: number; end?: number };
          return typed.type !== op.markType || typed.end! <= op.from || typed.start! >= op.to;
        });
      }
      return next;
    };
    const makeNode = (id: string, text: string, overrides: Partial<MockNode> = {}) => {
      nodes.set(id, {
        id,
        children: [],
        content: rich(text),
        tags: [],
        createdAt: ++now,
        updatedAt: now,
        locked: false,
        showCheckbox: false,
        doneStateEnabled: false,
        autocollectOptions: false,
        autoCollected: false,
        toolbarVisible: false,
        filterValues: [],
        ...overrides,
      });
      return nodes.get(id)!;
    };
    const appendChild = (parentId: string, childId: string, index: number | null = null) => {
      const parent = nodes.get(parentId);
      const child = nodes.get(childId);
      if (!parent || !child) return;
      parent.children = parent.children.filter((id) => id !== childId);
      const insertAt = index == null ? parent.children.length : Math.max(0, Math.min(index, parent.children.length));
      parent.children.splice(insertAt, 0, childId);
      child.parentId = parentId;
      parent.updatedAt = ++now;
      child.updatedAt = now;
    };
    const removeFromParent = (nodeId: string) => {
      const node = nodes.get(nodeId);
      if (!node?.parentId) return;
      const parent = nodes.get(node.parentId);
      if (parent) parent.children = parent.children.filter((id) => id !== nodeId);
    };
    const moveNode = (nodeId: string, parentId: string, index: number | null = null) => {
      const node = nodes.get(nodeId);
      if (!node || !nodes.has(parentId)) return;
      removeFromParent(nodeId);
      appendChild(parentId, nodeId, index);
      node.updatedAt = ++now;
    };
    const projection = () => ({
      workspaceId: ids.workspace,
      rootId: ids.root,
      dailyNotesId: ids.daily,
      schemaId: ids.schema,
      searchesId: ids.searches,
      trashId: ids.trash,
      settingsId: ids.settings,
      todayId: ids.today,
      nodes: [...nodes.values()],
    });
    const outcome = (focus?: { nodeId: string; selectAll: boolean }) => ({
      projection: projection(),
      ...(focus ? { focus } : {}),
    });
    const createNode = (parentId: string, index: number | null, text: string, overrides: Partial<MockNode> = {}) => {
      const nodeId = `node-${++sequence}`;
      makeNode(nodeId, text, { parentId, showCheckbox: true, ...overrides });
      appendChild(parentId, nodeId, index);
      return nodeId;
    };
    const createTag = (name: string) => {
      const normalized = name.trim();
      const existing = [...nodes.values()].find((node) => node.type === 'tagDef' && node.content.text === normalized);
      if (existing) return outcome({ nodeId: existing.id, selectAll: false });
      const tagId = `tag-${normalized}-${++sequence}`;
      makeNode(tagId, normalized, { type: 'tagDef', parentId: ids.schema, color: '#6a8f6b' });
      appendChild(ids.schema, tagId);
      return outcome({ nodeId: tagId, selectAll: false });
    };
    const createTree = (parentId: string, tree: CreateNodeTree[], index: number | null = null) => {
      let lastId: string | null = null;
      tree.forEach((item, offset) => {
        const nodeId = createNode(parentId, index === null ? null : index + offset, item.content.text);
        const node = nodes.get(nodeId);
        if (node) node.content = clone(item.content);
        if (item.children.length > 0) createTree(nodeId, item.children);
        lastId = nodeId;
      });
      return lastId;
    };
    const duplicateNode = (nodeId: string) => {
      const node = nodes.get(nodeId);
      if (!node?.parentId) return null;
      const cloneId = `${nodeId}-copy-${++sequence}`;
      makeNode(cloneId, node.content.text, {
        type: node.type,
        parentId: node.parentId,
        tags: [...node.tags],
        showCheckbox: node.showCheckbox,
        doneStateEnabled: node.doneStateEnabled,
        completedAt: node.completedAt,
        targetId: node.targetId,
        fieldDefId: node.fieldDefId,
        fieldType: node.fieldType,
        color: node.color,
        childSupertag: node.childSupertag,
        extends: node.extends,
        nullable: node.nullable,
        hideField: node.hideField,
        autoInitialize: node.autoInitialize,
        autocollectOptions: node.autocollectOptions,
        minValue: node.minValue,
        maxValue: node.maxValue,
        sourceSupertag: node.sourceSupertag,
      });
      const cloneNode = nodes.get(cloneId)!;
      cloneNode.content = clone(node.content);
      const parent = nodes.get(node.parentId);
      const index = parent ? parent.children.indexOf(nodeId) + 1 : null;
      appendChild(node.parentId, cloneId, index);
      return cloneId;
    };
    const siblingMove = (nodeIds: string[], direction: 'up' | 'down') => {
      const idsToMove = direction === 'up' ? nodeIds : [...nodeIds].reverse();
      for (const nodeId of idsToMove) {
        const node = nodes.get(nodeId);
        const parent = node?.parentId ? nodes.get(node.parentId) : null;
        if (!node || !parent) continue;
        const index = parent.children.indexOf(nodeId);
        const swapIndex = direction === 'up' ? index - 1 : index + 1;
        if (index < 0 || swapIndex < 0 || swapIndex >= parent.children.length) continue;
        if (nodeIds.includes(parent.children[swapIndex])) continue;
        [parent.children[index], parent.children[swapIndex]] = [parent.children[swapIndex], parent.children[index]];
      }
    };
    const inlineField = (parentId: string, index: number | null, name: string, fieldType: string) => {
      const fieldDefId = `field-def-${++sequence}`;
      makeNode(fieldDefId, name, { type: 'fieldDef', fieldType, parentId: ids.schema, nullable: true });
      appendChild(ids.schema, fieldDefId);
      const fieldEntryId = `field-entry-${++sequence}`;
      makeNode(fieldEntryId, name, { type: 'fieldEntry', parentId, fieldDefId, fieldType });
      appendChild(parentId, fieldEntryId, index);
      return fieldEntryId;
    };
    const setOptionalText = (node: MockNode, key: keyof MockNode, value: unknown) => {
      const normalized = typeof value === 'string' ? value.trim() : value == null ? '' : String(value);
      if (!normalized) {
        delete (node as Record<string, unknown>)[key];
        return;
      }
      (node as Record<string, unknown>)[key] = normalized;
    };
    const setOptionalNumber = (node: MockNode, key: keyof MockNode, value: unknown) => {
      if (value == null || value === '') {
        delete (node as Record<string, unknown>)[key];
        return;
      }
      const parsed = Number(value);
      if (Number.isFinite(parsed)) (node as Record<string, unknown>)[key] = parsed;
    };

    makeNode(ids.workspace, 'Workspace');
    makeNode(ids.root, 'Root', { parentId: ids.workspace });
    makeNode(ids.daily, 'Daily Notes', { parentId: ids.root });
    makeNode(ids.schema, 'Schema', { parentId: ids.root });
    makeNode(ids.searches, 'Searches', { parentId: ids.root });
    makeNode(ids.trash, 'Trash', { parentId: ids.root });
    makeNode(ids.settings, 'Settings', { parentId: ids.root });
    makeNode(ids.dayTag, 'day', { type: 'tagDef', parentId: ids.schema, color: 'gray' });
    makeNode(ids.projectTag, 'project', { type: 'tagDef', parentId: ids.schema, color: '#5e8e65' });
    makeNode(ids.statusField, 'Status', {
      type: 'fieldDef',
      parentId: ids.schema,
      fieldType: 'plain',
      nullable: true,
    });
    makeNode(ids.today, '2026-05-13', { parentId: ids.daily, tags: [ids.dayTag] });
    makeNode(ids.alpha, 'Alpha', { parentId: ids.today, showCheckbox: true });
    makeNode(ids.beta, 'Beta', { parentId: ids.today, showCheckbox: true });
    makeNode(ids.gamma, 'Gamma', { parentId: ids.today, showCheckbox: true });
    appendChild(ids.workspace, ids.root);
    for (const childId of [ids.daily, ids.schema, ids.searches, ids.trash, ids.settings]) appendChild(ids.root, childId);
    appendChild(ids.schema, ids.dayTag);
    appendChild(ids.schema, ids.projectTag);
    appendChild(ids.schema, ids.statusField);
    appendChild(ids.daily, ids.today);
    for (const childId of [ids.alpha, ids.beta, ids.gamma]) appendChild(ids.today, childId);

    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          clipboardText = text;
        },
      },
      configurable: true,
    });

    win.__LIN_E2E__ = { calls, projection, clipboardText: () => clipboardText };
    win.lin = {
      invoke: async <T,>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => {
        calls.push({ cmd, args: clone(args) });
        if (cmd === 'agent_create_session') return clone({ sessionId: 'mock-agent-session' }) as T;
        if (cmd.startsWith('agent_')) return clone(undefined) as T;
        if (cmd === 'init_workspace' || cmd === 'get_projection') return clone(projection());
        if (cmd === 'create_node') {
          const nodeId = createNode(String(args.parentId), args.index as number | null, String(args.text ?? ''));
          return clone(outcome({ nodeId, selectAll: false }));
        }
        if (cmd === 'create_nodes_from_tree') {
          const lastId = createTree(String(args.parentId), args.nodes as CreateNodeTree[]);
          return clone(outcome(lastId ? { nodeId: lastId, selectAll: false } : undefined));
        }
        if (cmd === 'paste_nodes_into_node') {
          const nodeId = String(args.nodeId);
          const node = nodes.get(nodeId);
          if (!node?.parentId) return clone(outcome());
          node.content = clone(args.content as RichText);
          node.updatedAt = ++now;
          createTree(nodeId, args.children as CreateNodeTree[]);
          const parent = nodes.get(node.parentId);
          const index = parent ? parent.children.indexOf(nodeId) + 1 : null;
          const lastSiblingId = createTree(node.parentId, args.siblingsAfter as CreateNodeTree[], index);
          return clone(outcome({ nodeId: lastSiblingId ?? nodeId, selectAll: false }));
        }
        if (cmd === 'apply_node_text_patch') {
          const node = nodes.get(String(args.nodeId));
          if (node) {
            node.content = applyRichTextPatch(node.content, args.patch as RichTextPatch);
            node.updatedAt = ++now;
          }
          return clone(outcome({ nodeId: String(args.nodeId), selectAll: false }));
        }
        if (cmd === 'split_node') {
          const nodeId = String(args.nodeId);
          const node = nodes.get(nodeId);
          if (!node?.parentId) return clone(outcome());
          node.content = clone(args.before as RichText);
          const parent = nodes.get(node.parentId);
          const insertAt = parent ? parent.children.indexOf(nodeId) + 1 : null;
          const nextId = createNode(node.parentId, insertAt, (args.after as RichText).text);
          const next = nodes.get(nextId);
          if (next) next.content = clone(args.after as RichText);
          return clone(outcome({ nodeId: nextId, selectAll: false }));
        }
        if (cmd === 'merge_node_into') {
          const node = nodes.get(String(args.nodeId));
          const target = nodes.get(String(args.targetId));
          if (node && target) {
            target.content = rich(`${target.content.text}${node.content.text}`);
            removeFromParent(node.id);
            nodes.delete(node.id);
          }
          return clone(outcome({ nodeId: String(args.targetId), selectAll: false }));
        }
        if (cmd === 'trash_node') {
          if (nodes.has(String(args.nodeId))) moveNode(String(args.nodeId), ids.trash);
          return clone(outcome());
        }
        if (cmd === 'batch_trash_nodes') {
          for (const nodeId of args.nodeIds as string[]) {
            if (nodes.has(nodeId)) moveNode(nodeId, ids.trash);
          }
          return clone(outcome());
        }
        if (cmd === 'indent_node' || cmd === 'batch_indent_nodes') {
          for (const nodeId of (cmd === 'indent_node' ? [String(args.nodeId)] : args.nodeIds as string[])) {
            const node = nodes.get(nodeId);
            const parent = node?.parentId ? nodes.get(node.parentId) : null;
            if (!node || !parent) continue;
            const index = parent.children.indexOf(nodeId);
            if (index <= 0) continue;
            moveNode(nodeId, parent.children[index - 1]);
          }
          return clone(outcome());
        }
        if (cmd === 'outdent_node' || cmd === 'batch_outdent_nodes') {
          const idsToOutdent = cmd === 'outdent_node' ? [String(args.nodeId)] : [...(args.nodeIds as string[])].reverse();
          for (const nodeId of idsToOutdent) {
            const node = nodes.get(nodeId);
            const parent = node?.parentId ? nodes.get(node.parentId) : null;
            const grandParent = parent?.parentId ? nodes.get(parent.parentId) : null;
            if (!node || !parent || !grandParent) continue;
            const parentIndex = grandParent.children.indexOf(parent.id);
            moveNode(nodeId, grandParent.id, parentIndex + 1);
          }
          return clone(outcome());
        }
        if (cmd === 'batch_move_nodes_up' || cmd === 'batch_move_nodes_down') {
          siblingMove(args.nodeIds as string[], cmd === 'batch_move_nodes_up' ? 'up' : 'down');
          return clone(outcome());
        }
        if (cmd === 'batch_duplicate_nodes') {
          const firstClone = (args.nodeIds as string[]).map(duplicateNode).find(Boolean);
          return clone(outcome(firstClone ? { nodeId: firstClone, selectAll: false } : undefined));
        }
        if (cmd === 'toggle_done' || cmd === 'batch_toggle_done') {
          const targetIds = cmd === 'toggle_done' ? [String(args.nodeId)] : args.nodeIds as string[];
          for (const nodeId of targetIds) {
            const node = nodes.get(nodeId);
            if (!node) continue;
            node.completedAt = node.completedAt ? undefined : ++now;
            node.showCheckbox = true;
          }
          return clone(outcome());
        }
        if (cmd === 'create_tag') return clone(createTag(String(args.name)));
        if (cmd === 'apply_tag' || cmd === 'batch_apply_tag') {
          const tagId = String(args.tagId);
          const targetIds = cmd === 'apply_tag' ? [String(args.nodeId)] : args.nodeIds as string[];
          for (const nodeId of targetIds) {
            const node = nodes.get(nodeId);
            if (node && !node.tags.includes(tagId)) node.tags.push(tagId);
          }
          return clone(outcome());
        }
        if (cmd === 'remove_tag') {
          const node = nodes.get(String(args.nodeId));
          if (node) node.tags = node.tags.filter((id) => id !== String(args.tagId));
          return clone(outcome());
        }
        if (cmd === 'set_tag_config') {
          const node = nodes.get(String(args.tagId));
          const patch = args.patch as Record<string, unknown>;
          if (node) {
            if ('color' in patch) setOptionalText(node, 'color', patch.color);
            if ('extends' in patch) setOptionalText(node, 'extends', patch.extends);
            if ('childSupertag' in patch) setOptionalText(node, 'childSupertag', patch.childSupertag);
            if ('showCheckbox' in patch) node.showCheckbox = Boolean(patch.showCheckbox);
            if ('doneStateEnabled' in patch) node.doneStateEnabled = Boolean(patch.doneStateEnabled);
            node.updatedAt = ++now;
          }
          return clone(outcome({ nodeId: String(args.tagId), selectAll: false }));
        }
        if (cmd === 'set_field_config') {
          const node = nodes.get(String(args.fieldId));
          const patch = args.patch as Record<string, unknown>;
          if (node) {
            if ('fieldType' in patch) {
              node.fieldType = String(patch.fieldType);
              if (node.fieldType !== 'options_from_supertag') delete node.sourceSupertag;
              if (node.fieldType !== 'options') node.autocollectOptions = false;
              if (node.fieldType !== 'number') {
                delete node.minValue;
                delete node.maxValue;
              }
            }
            if ('sourceSupertag' in patch) setOptionalText(node, 'sourceSupertag', patch.sourceSupertag);
            if ('nullable' in patch) {
              if (patch.nullable == null) delete node.nullable;
              else node.nullable = Boolean(patch.nullable);
            }
            if ('hideField' in patch) setOptionalText(node, 'hideField', patch.hideField);
            if ('autoInitialize' in patch) setOptionalText(node, 'autoInitialize', patch.autoInitialize);
            if ('autocollectOptions' in patch) node.autocollectOptions = Boolean(patch.autocollectOptions);
            if ('minValue' in patch) setOptionalNumber(node, 'minValue', patch.minValue);
            if ('maxValue' in patch) setOptionalNumber(node, 'maxValue', patch.maxValue);
            node.updatedAt = ++now;
          }
          return clone(outcome({ nodeId: String(args.fieldId), selectAll: false }));
        }
        if (cmd === 'create_inline_field') {
          const fieldEntryId = inlineField(String(args.parentId), args.index as number | null, String(args.name), String(args.fieldType));
          return clone(outcome({ nodeId: fieldEntryId, selectAll: false }));
        }
        if (cmd === 'create_inline_field_after_node') {
          const after = nodes.get(String(args.afterNodeId));
          const parent = after?.parentId ? nodes.get(after.parentId) : null;
          const index = parent && after ? parent.children.indexOf(after.id) + 1 : null;
          const fieldEntryId = inlineField(after?.parentId ?? ids.today, index, String(args.name), String(args.fieldType));
          return clone(outcome({ nodeId: fieldEntryId, selectAll: false }));
        }
        if (cmd === 'add_reference') {
          const target = nodes.get(String(args.targetId));
          const refId = createNode(String(args.parentId), args.index as number | null, target?.content.text ?? '', {
            type: 'reference',
            targetId: String(args.targetId),
          });
          return clone(outcome({ nodeId: refId, selectAll: false }));
        }
        if (cmd === 'set_reference_target') {
          const node = nodes.get(String(args.referenceId));
          const target = nodes.get(String(args.targetId));
          if (node && target) {
            node.type = 'reference';
            node.targetId = target.id;
            node.content = clone(target.content);
          }
          return clone(outcome({ nodeId: String(args.referenceId), selectAll: false }));
        }
        if (cmd === 'replace_node_with_reference') {
          const node = nodes.get(String(args.nodeId));
          const target = nodes.get(String(args.targetId));
          if (node && target) {
            node.type = 'reference';
            node.targetId = target.id;
            node.content = clone(target.content);
          }
          return clone(outcome({ nodeId: String(args.nodeId), selectAll: false }));
        }
        if (cmd === 'ensure_date_node') {
          const label = `${String(args.year).padStart(4, '0')}-${String(args.month).padStart(2, '0')}-${String(args.day).padStart(2, '0')}`;
          const existing = [...nodes.values()].find((node) => node.parentId === ids.daily && node.content.text === label);
          const nodeId = existing?.id ?? createNode(ids.daily, null, label);
          return clone(outcome({ nodeId, selectAll: false }));
        }
        if (cmd === 'set_node_toolbar_visible') {
          const node = nodes.get(String(args.nodeId));
          if (node) node.toolbarVisible = Boolean(args.visible);
          return clone(outcome());
        }
        if (cmd === 'search_nodes') {
          const query = String(args.query ?? '').toLowerCase();
          return clone([...nodes.values()]
            .filter((node) => node.content.text.toLowerCase().includes(query))
            .map((node) => ({ nodeId: node.id, score: 1 })));
        }
        if (cmd === 'ensure_tag_search' || cmd === 'restore_node' || cmd === 'delete_node' || cmd === 'undo' || cmd === 'redo') {
          return clone(outcome());
        }
        throw new Error(`Unhandled mock invoke: ${cmd}`);
      },
      onAgentEvent: () => () => undefined,
    };
  }, { ids });
}

export function row(page: Page, id: string) {
  return page.locator(`[data-node-id="${id}"]`).first();
}

export function rowBody(page: Page, id: string) {
  return row(page, id).locator('> .row').first();
}

export function rowEditor(page: Page, id: string) {
  return row(page, id).locator('.ProseMirror').first();
}

export function trailingEditor(page: Page, parentId = ids.today) {
  return page.locator(`[data-trailing-parent-id="${parentId}"] .ProseMirror`).first();
}

export async function openMockedApp(page: Page) {
  await installElectronMock(page);
  await page.goto('/');
  await expect(row(page, ids.alpha)).toContainText('Alpha');
  await expect(row(page, ids.beta)).toContainText('Beta');
}

export async function multiSelect(page: Page, rowIds: string[]) {
  for (const rowId of rowIds) {
    await row(page, rowId).click({ modifiers: ['Meta'] });
  }
  for (const rowId of rowIds) {
    await expect(rowBody(page, rowId)).toHaveClass(/selected/);
  }
}

export async function e2eProjection(page: Page): Promise<{ nodes: Array<{
  id: string;
  parentId?: string;
  children: string[];
  content: { text: string };
  completedAt?: number;
  tags: string[];
  type?: string;
  targetId?: string;
  color?: string;
  childSupertag?: string;
  extends?: string;
  showCheckbox?: boolean;
  doneStateEnabled?: boolean;
  fieldType?: string;
  nullable?: boolean;
  hideField?: string;
  autocollectOptions?: boolean;
  minValue?: number;
  maxValue?: number;
  sourceSupertag?: string;
}> }> {
  return page.evaluate(() => {
    const win = window as E2EWindow;
    return win.__LIN_E2E__?.projection() as { nodes: Array<{
      id: string;
      parentId?: string;
      children: string[];
      content: { text: string };
      completedAt?: number;
      tags: string[];
      type?: string;
      targetId?: string;
      color?: string;
      childSupertag?: string;
      extends?: string;
      showCheckbox?: boolean;
      doneStateEnabled?: boolean;
      fieldType?: string;
      nullable?: boolean;
      hideField?: string;
      autocollectOptions?: boolean;
      minValue?: number;
      maxValue?: number;
      sourceSupertag?: string;
    }> };
  });
}

export async function nodeByText(page: Page, text: string) {
  const projection = await e2eProjection(page);
  return projection.nodes.find((node) => node.content.text === text);
}

export async function nodeById(page: Page, id: string) {
  const projection = await e2eProjection(page);
  return projection.nodes.find((node) => node.id === id);
}

export async function commandCalls(page: Page) {
  return page.evaluate(() => {
    const win = window as E2EWindow;
    return win.__LIN_E2E__?.calls ?? [];
  });
}

export async function clipboardText(page: Page) {
  return page.evaluate(() => {
    const win = window as E2EWindow;
    return win.__LIN_E2E__?.clipboardText() ?? '';
  });
}
