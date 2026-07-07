import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core } from '../../src/core/core';
import { projectFieldConfig } from '../../src/core/configProjection';
import { LoroOutlinerDocument } from '../../src/core/loroDocument';
import { buildTextSearchIndex } from '../../src/core/searchEngine';
import { LIBRARY_ID, plainText, replaceAllRichTextPatch, SCHEMA_ID, TRASH_ID, WORKSPACE_ID } from '../../src/core/types';
import { createNodeTools, visibleOperationHistory, type OutlinerToolHost } from '../../src/main/agentNodeTools';
import type { OperationHistoryData } from '../../src/main/agentNodeToolTypes';
import type { ToolEnvelope } from '../../src/main/agentToolEnvelope';
import { formatChatSourceReferenceMarker, formatFileReferenceMarker, formatNodeReferenceMarker, splitChatSourceReferenceMarkers, splitFileReferenceMarkers } from '../../src/core/referenceMarkup';

function mustFocus<T extends { focus?: { nodeId: string } }>(outcome: T) {
  expect(outcome.focus).toBeDefined();
  return outcome.focus!.nodeId;
}

function hostFor(core: Core, overrides: Partial<OutlinerToolHost> = {}): OutlinerToolHost {
  const host: OutlinerToolHost = {
    getProjection: () => core.projection(),
    getTextSearchIndex: () => buildTextSearchIndex(core.projection()),
    transaction: async (meta, fn) => core.transaction(meta.origin ?? 'agent', fn, meta),
    operationHistory: (query) => core.operationHistory(query),
    handle: async (command, args = {}, meta = {}) => {
      const run = () => {
      if (command === 'search_nodes') return core.searchNodes(String(args.query ?? ''));
      if (command === 'backlinks') return core.backlinks(String(args.targetId ?? ''));
      if (command === 'create_node') return core.createNode(String(args.parentId), nullableNumber(args.index), String(args.text ?? ''));
      if (command === 'create_rich_text_node') return core.createRichTextContentNode(String(args.parentId), nullableNumber(args.index), args.content as any);
      if (command === 'apply_node_text_patch') return core.applyNodeTextPatch(String(args.nodeId), args.patch as any);
      if (command === 'update_node_description') return core.updateNodeDescription(String(args.nodeId), nullableString(args.description));
      if (command === 'set_code_block') return core.setCodeBlock(String(args.nodeId), nullableString(args.codeLanguage) ?? undefined);
      if (command === 'set_code_language') return core.setCodeLanguage(String(args.nodeId), String(args.codeLanguage ?? ''));
      if (command === 'set_node_checkbox_visible') return core.setNodeCheckboxVisible(String(args.nodeId), Boolean(args.visible));
      if (command === 'toggle_done') return core.toggleDone(String(args.nodeId));
      if (command === 'create_tag') return core.createTag(String(args.name ?? ''));
      if (command === 'apply_tag') return core.applyTag(String(args.nodeId), String(args.tagId));
      if (command === 'remove_tag') return core.removeTag(String(args.nodeId), String(args.tagId));
      if (command === 'create_inline_field') return core.createInlineField(String(args.parentId), nullableNumber(args.index), String(args.name), fieldTypeArg(args.fieldType));
      if (command === 'reuse_field_definition') return core.reuseFieldDefinition(String(args.entryId), String(args.targetDefId));
      if (command === 'create_collected_field_option') return core.createCollectedFieldOption(String(args.fieldEntryId), String(args.name));
      if (command === 'select_field_option') return core.selectFieldOption(String(args.fieldEntryId), String(args.optionNodeId));
      if (command === 'add_field_reference') return core.addFieldReference(String(args.fieldEntryId), String(args.targetNodeId));
      if (command === 'add_reference') return core.addReference(String(args.parentId), String(args.targetId), nullableNumber(args.index));
      if (command === 'set_reference_target') return core.setReferenceTarget(String(args.referenceId), String(args.targetId));
      if (command === 'trash_node') return core.trashNode(String(args.nodeId));
      if (command === 'batch_trash_nodes') return core.batchTrashNodes(arrayArg(args.nodeIds));
      if (command === 'restore_node') return core.restoreNode(String(args.nodeId));
      if (command === 'move_node') return core.moveNode(String(args.nodeId), String(args.parentId), nullableNumber(args.index));
      if (command === 'batch_indent_nodes') return core.batchIndentNodes(arrayArg(args.nodeIds));
      if (command === 'batch_outdent_nodes') return core.batchOutdentNodes(arrayArg(args.nodeIds));
      if (command === 'batch_move_nodes_up') return core.batchMoveNodesUp(arrayArg(args.nodeIds));
      if (command === 'batch_move_nodes_down') return core.batchMoveNodesDown(arrayArg(args.nodeIds));
      if (command === 'replace_node_with_reference') return core.replaceNodeWithReference(String(args.nodeId), String(args.targetId));
      if (command === 'create_search_node') return core.createSearchNode(String(args.parentId), nullableNumber(args.index), args.config as any);
      if (command === 'set_search_node') return core.setSearchNode(String(args.nodeId), args.config as any);
      if (command === 'set_view_mode') return core.setViewMode(String(args.nodeId), String(args.mode) as any);
      if (command === 'undo') return core.operationHistory({ action: 'undo', origin: meta.origin === 'agent' ? 'agent' : 'all' });
      if (command === 'redo') return core.operationHistory({ action: 'redo', origin: meta.origin === 'agent' ? 'agent' : 'all' });
      throw new Error(`unsupported test command: ${command}`);
      };
      return meta.origin ? core.withOrigin(meta.origin, run) : run();
    },
  };
  return { ...host, ...overrides };
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

function arrayArg(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function fieldTypeArg(value: unknown) {
  if (['plain', 'options', 'options_from_supertag', 'date', 'number', 'url', 'email', 'checkbox', 'reference'].includes(String(value))) {
    return String(value) as any;
  }
  return 'plain';
}

function nodeRef(core: Core, nodeId: string, label?: string): string {
  return formatNodeReferenceMarker(label ?? core.state().nodes[nodeId]?.content.text ?? nodeId, nodeId);
}

function fieldEntryByName(core: Core, ownerId: string, name: string): string {
  const state = core.state();
  const entryId = state.nodes[ownerId]!.children.find((childId) => {
    const child = state.nodes[childId];
    if (child?.type !== 'fieldEntry') return false;
    const label = child.fieldDefId?.startsWith('sys:')
      ? child.fieldDefId
      : state.nodes[child.fieldDefId ?? '']?.content.text;
    return label === name;
  });
  expect(entryId).toBeDefined();
  return entryId!;
}

function fieldTypeOf(core: Core, fieldEntryId: string) {
  const state = core.state();
  const entry = state.nodes[fieldEntryId]!;
  expect(entry.type).toBe('fieldEntry');
  const fieldDef = state.nodes[entry.fieldDefId!]!;
  const byId = new Map(Object.values(state.nodes).map((node) => [node.id, node]));
  return projectFieldConfig(byId, fieldDef).fieldType;
}

function coreWithDirtyDuplicateOwnerFields(): Core {
  const legacy = new LoroOutlinerDocument();
  legacy.createNodeWithId(WORKSPACE_ID, undefined, undefined, undefined, (node) => {
    node.content = plainText('Tenon');
  });
  legacy.createNodeWithId(LIBRARY_ID, WORKSPACE_ID, undefined, undefined, (node) => {
    node.content = plainText('Library');
  });
  legacy.createNodeWithId(SCHEMA_ID, WORKSPACE_ID, undefined, undefined, (node) => {
    node.content = plainText('Schema');
  });
  legacy.createNodeWithId(TRASH_ID, WORKSPACE_ID, undefined, undefined, (node) => {
    node.content = plainText('Trash');
  });
  legacy.createNodeWithId('feed-node', LIBRARY_ID, undefined, undefined, (node) => {
    node.content = plainText('Feed');
  });
  legacy.createNodeWithId('xml-def-a', SCHEMA_ID, undefined, 'fieldDef', (node) => {
    node.content = plainText('xmlUrl');
  });
  legacy.createNodeWithId('xml-def-b', SCHEMA_ID, undefined, 'fieldDef', (node) => {
    node.content = plainText(' XMLURL ');
  });
  legacy.createNodeWithId('xml-entry-a', 'feed-node', undefined, 'fieldEntry', (node) => {
    node.fieldDefId = 'xml-def-a';
  });
  legacy.createNodeWithId('xml-entry-b', 'feed-node', undefined, 'fieldEntry', (node) => {
    node.fieldDefId = 'xml-def-b';
  });
  return Core.fromState(legacy.serialize('__legacy__'));
}

function coreWithDirtyDuplicateFieldDefs(): Core {
  const legacy = new LoroOutlinerDocument();
  legacy.createNodeWithId(WORKSPACE_ID, undefined, undefined, undefined, (node) => {
    node.content = plainText('Tenon');
  });
  legacy.createNodeWithId(LIBRARY_ID, WORKSPACE_ID, undefined, undefined, (node) => {
    node.content = plainText('Library');
  });
  legacy.createNodeWithId(SCHEMA_ID, WORKSPACE_ID, undefined, undefined, (node) => {
    node.content = plainText('Schema');
  });
  legacy.createNodeWithId(TRASH_ID, WORKSPACE_ID, undefined, undefined, (node) => {
    node.content = plainText('Trash');
  });
  legacy.createNodeWithId('article-parent', LIBRARY_ID, undefined, undefined, (node) => {
    node.content = plainText('Articles');
  });
  legacy.createNodeWithId('source-def-a', SCHEMA_ID, undefined, 'fieldDef', (node) => {
    node.content = plainText('Source');
  });
  legacy.createNodeWithId('source-def-b', SCHEMA_ID, undefined, 'fieldDef', (node) => {
    node.content = plainText(' source ');
  });
  return Core.fromState(legacy.serialize('__legacy__'));
}

async function executeTool<TData>(core: Core, name: string, params: unknown): Promise<ToolEnvelope<TData>> {
  const result = await executeRawTool<TData>(core, name, params);
  return result.details;
}

async function executeRawTool<TData>(
  core: Core,
  name: string,
  params: unknown,
  options?: Parameters<typeof createNodeTools>[1],
  hostOverrides: Partial<OutlinerToolHost> = {},
): Promise<{
  contentText: string;
  details: ToolEnvelope<TData>;
}> {
  const tool = createNodeTools(hostFor(core, hostOverrides), options).find((candidate) => candidate.name === name);
  expect(tool).toBeDefined();
  const result = await (tool!.execute as any)('test-call', params);
  const contentText = result.content
    .filter((block: { type: string }) => block.type === 'text')
    .map((block: { text: string }) => block.text)
    .join('\n');
  return {
    contentText,
    details: result.details as ToolEnvelope<TData>,
  };
}

function parseVisibleToolResult<TData>(contentText: string): TData {
  return JSON.parse(contentText) as TData;
}

describe('agent node tools', () => {
  test('node tool schemas use operational descriptions for agent guidance', () => {
    const tools = createNodeTools(hostFor(Core.new()));
    const nodeRead = tools.find((tool) => tool.name === 'node_read')!;
    const nodeCreate = tools.find((tool) => tool.name === 'node_create')!;
    const nodeEdit = tools.find((tool) => tool.name === 'node_edit')!;
    const nodeSearch = tools.find((tool) => tool.name === 'node_search')!;
    const history = tools.find((tool) => tool.name === 'operation_history')!;
    const nodeCreateOutlineDescription = (nodeCreate.parameters as any).properties.outline.description as string;

    expect(nodeRead.description).toContain('Use node_read before node_edit');
    expect(nodeCreate.description).toContain('Usage:');
    expect(nodeCreate.description).toContain('YYYY-MM-DDTHH:mm');
    expect(nodeCreate.description).toContain('Use child nodes for ordinary notes');
    expect(nodeCreate.description).toContain('Prefer nested child lines over node descriptions');
    expect(nodeCreate.description).toContain('Prefer ordinary child nodes over Field:: lines');
    expect(nodeCreate.description).toContain('Use [ ]/[x] only for real tasks');
    expect(nodeCreate.description).toContain('Use %%search%% only when creating a saved search/view');
    expect(nodeCreateOutlineDescription).toContain('Use "Title - description" only when the user explicitly asks');
    expect(nodeCreateOutlineDescription).toContain('Markdown inline syntax creates rich-text marks');
    expect(nodeCreateOutlineDescription).toContain('Field:: writes resolve existing owner fields');
    expect(JSON.stringify(nodeCreate.parameters)).toContain("today's journal node, not the current UI selection");
    expect(nodeSearch.description).toContain('DONE_LAST_DAYS value:: 7');
    expect(nodeSearch.description).toContain('Use node_search for temporary lookup');
    expect(nodeSearch.description).toContain('Do not express done state as FIELD_IS');
    expect(nodeSearch.description).toContain('Use DATE_OVERLAPS only for values stored in a date field');
    expect(JSON.stringify(nodeSearch.parameters)).toContain('Plain field names');
    expect(JSON.stringify(nodeSearch.parameters)).toContain('Date field values use YYYY-MM-DD');
    expect(nodeEdit.description).toContain('Set operation explicitly');
    expect(JSON.stringify(nodeEdit.parameters)).toContain('replace_outline');
    expect(nodeEdit.description).toContain('old_string "*" only to replace');
    expect(nodeEdit.description).toContain('target root line only');
    expect(JSON.stringify(nodeEdit.parameters)).toContain('Date field values use YYYY-MM-DD');
    expect(JSON.stringify(nodeEdit.parameters)).toContain('edits require expected_revision');
    expect(JSON.stringify(nodeEdit.parameters)).toContain('leading %%node:id%% marker may be omitted');
    expect(JSON.stringify(nodeEdit.parameters)).toContain('Include enough surrounding lines');
    expect(history.description).toContain('Use action "list" first');
  });

  test('node_create creates outline trees with tags fields descriptions and completion', async () => {
    const core = Core.new();
    const today = core.projection().todayId;

    const envelope = await executeTool<{
      parentId: string;
      createdRootIds: string[];
      createdNodeIds: string[];
      createdFieldEntryIds?: string[];
      createdTagIds?: string[];
    }>(core, 'node_create', {
      parent_id: today,
      outline: '- [x] Launch - Q2 rollout #project\n  - Status:: Active\n  - Draft plan',
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.parentId).toBe(today);
    expect(envelope.data!.createdRootIds).toHaveLength(1);
    expect(envelope.data!.createdFieldEntryIds).toHaveLength(1);
    expect(envelope.data!.createdTagIds).toHaveLength(1);

    const nodeId = envelope.data!.createdRootIds[0]!;
    const node = core.state().nodes[nodeId]!;
    expect(node.content.text).toBe('Launch');
    expect(node.description).toBe('Q2 rollout');
    expect(node.completedAt).toBeGreaterThan(0);
    expect(node.tags).toHaveLength(1);
    expect(core.state().nodes[node.tags[0]!]!.content.text).toBe('project');
    expect(node.children.map((childId) => core.state().nodes[childId]!.content.text)).toEqual(['', 'Draft plan']);

    const fieldEntryId = node.children[0]!;
    const fieldEntry = core.state().nodes[fieldEntryId]!;
    expect(fieldEntry.type).toBe('fieldEntry');
    expect(fieldEntry.children.map((childId) => core.state().nodes[childId]!.content.text)).toEqual(['Active']);
  });

  test('node_create top-level field lines write structured fields onto the parent', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const feed = mustFocus(core.createNode(today, null, 'Feed'));

    const envelope = await executeTool<{
      createdRootIds: string[];
      createdFieldEntryIds?: string[];
      createdFieldDefIds?: string[];
    }>(core, 'node_create', {
      parent_id: feed,
      outline: '- xmlUrl:: https://example.com/feed.xml',
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.createdRootIds).toEqual([]);
    expect(envelope.data!.createdFieldEntryIds).toHaveLength(1);
    const entryId = fieldEntryByName(core, feed, 'xmlUrl');
    expect(fieldTypeOf(core, entryId)).toBe('url');
    expect(core.state().nodes[entryId]!.children.map((childId) => core.state().nodes[childId]!.content.text)).toEqual([
      'https://example.com/feed.xml',
    ]);
  });

  test('node_create infers conservative field types for new field definitions', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const target = mustFocus(core.createNode(today, null, 'Target'));

    const envelope = await executeTool<{ createdRootIds: string[] }>(core, 'node_create', {
      parent_id: today,
      outline: [
        '- Typed',
        '  - xmlUrl:: https://example.com/feed.xml',
        '  - Contact:: person@example.com',
        '  - Published:: 2026-07-07',
        '  - Score:: 42',
        `  - Related:: ${nodeRef(core, target)}`,
        '  - Flag:: true',
        '  - Notes:: hello',
      ].join('\n'),
    });

    expect(envelope.ok).toBe(true);
    const root = envelope.data!.createdRootIds[0]!;
    expect(fieldTypeOf(core, fieldEntryByName(core, root, 'xmlUrl'))).toBe('url');
    expect(fieldTypeOf(core, fieldEntryByName(core, root, 'Contact'))).toBe('email');
    expect(fieldTypeOf(core, fieldEntryByName(core, root, 'Published'))).toBe('date');
    expect(fieldTypeOf(core, fieldEntryByName(core, root, 'Score'))).toBe('number');
    expect(fieldTypeOf(core, fieldEntryByName(core, root, 'Related'))).toBe('reference');
    expect(fieldTypeOf(core, fieldEntryByName(core, root, 'Flag'))).toBe('checkbox');
    expect(fieldTypeOf(core, fieldEntryByName(core, root, 'Notes'))).toBe('plain');
  });

  test('node_create reuses existing typed field definitions by name', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const seed = mustFocus(core.createNode(today, null, 'Seed'));
    const seedEntry = mustFocus(core.createInlineField(seed, null, 'xmlUrl', 'url'));
    const fieldDefId = core.state().nodes[seedEntry]!.fieldDefId!;

    const envelope = await executeTool<{ createdRootIds: string[]; createdFieldDefIds?: string[]; matchedNodeIds?: string[] }>(core, 'node_create', {
      parent_id: today,
      outline: '- Feed\n  - xmlUrl:: https://example.com/feed.xml',
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.createdFieldDefIds).toBeUndefined();
    expect(envelope.data!.matchedNodeIds).toContain(fieldDefId);
    const root = envelope.data!.createdRootIds[0]!;
    const entryId = fieldEntryByName(core, root, 'xmlUrl');
    expect(core.state().nodes[entryId]!.fieldDefId).toBe(fieldDefId);
    expect(fieldTypeOf(core, entryId)).toBe('url');
  });

  test('node_create selects existing options when reusing an options field definition', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const seed = mustFocus(core.createNode(today, null, 'Seed'));
    const seedEntry = mustFocus(core.createInlineField(seed, null, 'Status', 'options'));
    const fieldDefId = core.state().nodes[seedEntry]!.fieldDefId!;
    const activeOption = mustFocus(core.registerCollectedOption(fieldDefId, 'Active'));

    const envelope = await executeTool<{ createdRootIds: string[] }>(core, 'node_create', {
      parent_id: today,
      outline: '- Feed\n  - Status:: Active',
    });

    expect(envelope.ok).toBe(true);
    const root = envelope.data!.createdRootIds[0]!;
    const entryId = fieldEntryByName(core, root, 'Status');
    const valueId = core.state().nodes[entryId]!.children[0]!;
    expect(core.state().nodes[valueId]).toMatchObject({
      type: 'reference',
      targetId: activeOption,
    });
  });

  test('node_create validates options-from-supertag values through option selection', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const sourceTagId = mustFocus(core.createTag('City'));
    const seed = mustFocus(core.createNode(today, null, 'Seed'));
    const seedEntry = mustFocus(core.createInlineField(seed, null, 'Destination', 'options_from_supertag'));
    const fieldDefId = core.state().nodes[seedEntry]!.fieldDefId!;
    core.setFieldConfig(fieldDefId, {
      fieldType: 'options_from_supertag',
      sourceSupertag: sourceTagId,
    });
    const chengduId = mustFocus(core.createNode(today, null, 'Chengdu'));
    core.applyTag(chengduId, sourceTagId);

    const valid = await executeTool<{ createdRootIds: string[] }>(core, 'node_create', {
      parent_id: today,
      outline: `- Trip\n  - Destination:: ${nodeRef(core, chengduId, 'Chengdu')}`,
    });

    expect(valid.ok).toBe(true);
    const root = valid.data!.createdRootIds[0]!;
    const entryId = fieldEntryByName(core, root, 'Destination');
    const valueId = core.state().nodes[entryId]!.children[0]!;
    expect(core.state().nodes[valueId]).toMatchObject({
      type: 'reference',
      targetId: chengduId,
    });

    const invalid = await executeTool(core, 'node_create', {
      parent_id: today,
      outline: '- Bad trip\n  - Destination:: Chengdu',
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.error?.message).toContain('options-from-supertag');
  });

  test('node_create reuses an existing same-owner field entry instead of duplicating it', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const feed = mustFocus(core.createNode(today, null, 'Feed'));
    const entry = mustFocus(core.createInlineField(feed, null, 'xmlUrl', 'url'));
    core.setFieldFreeTextValue(entry, 'https://old.example/feed.xml');

    const envelope = await executeTool<{ createdFieldEntryIds?: string[] }>(core, 'node_create', {
      parent_id: feed,
      outline: '- xmlUrl:: https://new.example/feed.xml',
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.createdFieldEntryIds).toBeUndefined();
    const fieldEntries = core.state().nodes[feed]!.children.filter((childId) => core.state().nodes[childId]?.type === 'fieldEntry');
    expect(fieldEntries).toEqual([entry]);
    expect(core.state().nodes[entry]!.children.map((childId) => core.state().nodes[childId]!.content.text)).toEqual([
      'https://old.example/feed.xml',
      'https://new.example/feed.xml',
    ]);
  });

  test('node_create rejects ambiguous duplicate owner fields and duplicate definitions', async () => {
    const duplicateOwnerCore = coreWithDirtyDuplicateOwnerFields();
    const duplicateOwner = await executeTool(duplicateOwnerCore, 'node_create', {
      parent_id: 'feed-node',
      outline: '- xmlUrl:: https://example.com/feed.xml',
    });
    expect(duplicateOwner.ok).toBe(false);
    expect(duplicateOwner.error?.message).toContain('Multiple field entries');

    const duplicateDefsCore = coreWithDirtyDuplicateFieldDefs();
    const duplicateDefs = await executeTool(duplicateDefsCore, 'node_create', {
      parent_id: 'article-parent',
      outline: '- Article\n  - Source:: RSS',
    });
    expect(duplicateDefs.ok).toBe(false);
    expect(duplicateDefs.error?.message).toContain('Multiple field definitions');
  });

  test('node_create writes Done through the system field and rejects read-only system fields', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const task = mustFocus(core.createNode(today, null, 'Task'));

    const done = await executeTool(core, 'node_create', {
      parent_id: task,
      outline: '- Done:: true',
    });
    expect(done.ok).toBe(true);
    expect(core.state().nodes[task]!.completedAt).toBeGreaterThan(0);
    const doneEntry = core.state().nodes[task]!.children.find((childId) => core.state().nodes[childId]?.fieldDefId === 'sys:done');
    expect(doneEntry).toBeDefined();
    expect(core.state().nodes[doneEntry!]!.children).toEqual([]);

    const created = await executeTool(core, 'node_create', {
      parent_id: task,
      outline: '- Created:: 2026-07-07',
    });
    expect(created.ok).toBe(false);
    expect(created.error?.message).toContain('read-only');
  });

  test('node_create materializes markdown inline marks and links as rich text', async () => {
    const core = Core.new();
    const today = core.projection().todayId;

    const result = await executeRawTool<{ createdRootIds: string[] }>(core, 'node_create', {
      parent_id: today,
      outline: '- Ship **bold** *italic* ~~old~~ ==hot== `code` [site](https://example.com)',
    });

    expect(result.details.ok).toBe(true);
    const nodeId = result.details.data!.createdRootIds[0]!;
    expect(core.state().nodes[nodeId]!.content).toEqual({
      text: 'Ship bold italic old hot code site',
      marks: [
        { start: 5, end: 9, type: 'bold' },
        { start: 10, end: 16, type: 'italic' },
        { start: 17, end: 20, type: 'strike' },
        { start: 21, end: 24, type: 'highlight' },
        { start: 25, end: 29, type: 'code' },
        { start: 30, end: 34, type: 'link', attrs: { href: 'https://example.com' } },
      ],
      inlineRefs: [],
    });
    expect(result.contentText).toContain('Ship **bold** *italic* ~~old~~ ==hot== `code` [site](https://example.com)');
  });

  test('node_create materializes fenced outline entries as code block rows', async () => {
    const core = Core.new();
    const today = core.projection().todayId;

    const result = await executeRawTool<{ createdRootIds: string[]; createdNodeIds: string[] }>(core, 'node_create', {
      parent_id: today,
      outline: '- Snippet\n  - ```ts\n  const x = 1\n  const y = 2\n  ```',
    });

    expect(result.details.ok).toBe(true);
    const rootId = result.details.data!.createdRootIds[0]!;
    const codeId = core.state().nodes[rootId]!.children[0]!;
    expect(core.state().nodes[codeId]).toMatchObject({
      type: 'codeBlock',
      codeLanguage: 'typescript',
      content: { text: 'const x = 1\nconst y = 2' },
    });
    const visible = parseVisibleToolResult<{ data?: { outline?: string } }>(result.contentText);
    expect(visible.data!.outline).toContain(`  - %%node:${codeId}%% \`\`\`typescript\n  const x = 1\n  const y = 2\n  \`\`\``);
  });

  test('node_read serializes code block fences that do not collide with body fence runs', async () => {
    const core = Core.new();
    const today = core.projection().todayId;

    const result = await executeRawTool<{ createdRootIds: string[] }>(core, 'node_create', {
      parent_id: today,
      outline: '- ````ts\n```literal\n````',
    });

    expect(result.details.ok).toBe(true);
    const codeId = result.details.data!.createdRootIds[0]!;
    expect(core.state().nodes[codeId]).toMatchObject({
      type: 'codeBlock',
      content: { text: '```literal' },
    });
    const read = await executeTool<{ items: Array<{ outline?: string }> }>(core, 'node_read', { node_id: codeId, depth: 0 });
    expect(read.data!.items[0]!.outline).toBe('- ~~~typescript\n```literal\n~~~');
  });

  test('node_create fills existing tag-template date fields with canonical values', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const tagId = mustFocus(core.createTag('event'));
    const templateEntryId = mustFocus(core.createFieldDef(tagId, 'Date', 'date'));
    const dateFieldDefId = core.state().nodes[templateEntryId]!.fieldDefId!;

    const envelope = await executeTool<{ createdRootIds: string[] }>(core, 'node_create', {
      parent_id: today,
      outline: '- Launch #event\n  - Date:: 2026-05-20 / 2026-05-24',
    });

    expect(envelope.ok).toBe(true);
    const nodeId = envelope.data!.createdRootIds[0]!;
    const dateFieldIds = core.state().nodes[nodeId]!.children.filter((childId) =>
      core.state().nodes[childId]!.type === 'fieldEntry'
      && core.state().nodes[childId]!.fieldDefId === dateFieldDefId);
    expect(dateFieldIds).toHaveLength(1);
    expect(core.state().nodes[dateFieldIds[0]!]!.children.map((childId) => core.state().nodes[childId]!.content.text)).toEqual([
      '2026-05-20/2026-05-24',
    ]);
  });

  test('node_create preserves reusable template field values while adding new values', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const tagId = mustFocus(core.createTag('project'));
    const templateEntryId = mustFocus(core.createFieldDef(tagId, 'Status', 'plain'));
    const fieldDefId = core.state().nodes[templateEntryId]!.fieldDefId!;
    core.createNode(templateEntryId, null, 'Template default');

    const envelope = await executeTool<{ createdRootIds: string[] }>(core, 'node_create', {
      parent_id: today,
      outline: '- Launch #project\n  - Status:: Active',
    });

    expect(envelope.ok).toBe(true);
    const nodeId = envelope.data!.createdRootIds[0]!;
    const fieldEntryId = core.state().nodes[nodeId]!.children.find((childId) =>
      core.state().nodes[childId]!.type === 'fieldEntry'
      && core.state().nodes[childId]!.fieldDefId === fieldDefId)!;
    expect(core.state().nodes[fieldEntryId]!.children.map((childId) => core.state().nodes[childId]!.content.text)).toEqual([
      'Template default',
      'Active',
    ]);
  });

  test('node_create returns model-visible annotated outline while details stay complete', async () => {
    const core = Core.new();
    const today = core.projection().todayId;

    const result = await executeRawTool<{
      createdRootIds: string[];
      createdNodeIds: string[];
      createdFieldEntryIds?: string[];
      outline?: string;
    }>(core, 'node_create', {
      parent_id: today,
      outline: '- Launch #project\n  - Status:: Active\n  - Draft plan',
    });

    const visible = parseVisibleToolResult<{
      ok: boolean;
      instructions?: string;
      data?: {
        outline?: string;
        changes?: { created?: string[] };
      };
    }>(result.contentText);

    expect(visible.ok).toBe(true);
    // The echoed `tool`, the redundant envelope `status: 'success'`, and the
    // derivable `kind`/`action`/`status` discriminants are no longer model-visible.
    expect(visible).not.toHaveProperty('tool');
    expect(visible).not.toHaveProperty('status');
    expect(visible.data).not.toHaveProperty('kind');
    expect(visible.data).not.toHaveProperty('action');
    expect(visible.data).not.toHaveProperty('status');
    expect((visible as any).metrics).toBeUndefined();
    expect(visible.data!.outline).toContain(`%%node:${result.details.data!.createdRootIds[0]}%% Launch`);
    expect(visible.data!.outline).toContain('Status::');
    expect(visible.data!.changes!.created).toEqual([
      ...result.details.data!.createdNodeIds,
      ...(result.details.data!.createdFieldEntryIds ?? []),
    ]);
    expect((visible.data! as any).refs).toBeUndefined();
    // create now carries the final-answer citation guidance.
    expect(visible.instructions).toContain('[[node:');
    expect(result.details.data!.outline).toContain('Status:: Active');
  });

  test('node_create keeps CSS hex colors as text instead of bare tags', async () => {
    const core = Core.new();
    const today = core.projection().todayId;

    const envelope = await executeTool<{ createdRootIds: string[] }>(core, 'node_create', {
      parent_id: today,
      outline: '- Palette - brand #112233 #urgent\n  - Swatch #fff\n  - Explicit tag #[[abc]]',
    });

    expect(envelope.ok).toBe(true);
    const state = core.state();
    const root = state.nodes[envelope.data!.createdRootIds[0]!]!;
    const swatch = state.nodes[root.children[0]!]!;
    const explicit = state.nodes[root.children[1]!]!;
    const tagNames = (tagIds: string[]) => tagIds.map((tagId) => state.nodes[tagId]!.content.text);

    expect(root.content.text).toBe('Palette');
    expect(root.description).toBe('brand #112233');
    expect(tagNames(root.tags)).toEqual(['urgent']);
    expect(swatch.content.text).toBe('Swatch #fff');
    expect(swatch.tags).toEqual([]);
    expect(explicit.content.text).toBe('Explicit tag');
    expect(tagNames(explicit.tags)).toEqual(['abc']);
  });

  test('node_create rejects annotated node ids from read/edit protocol', async () => {
    const core = Core.new();
    const today = core.projection().todayId;

    const envelope = await executeTool(core, 'node_create', {
      parent_id: today,
      outline: '- %%node:node_existing%% Copied node',
    });

    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('invalid_annotation');
  });

  test('node_create rejects out-of-root local-file markers from agent outlines', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-node-root-'));
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-node-source-'));
    try {
      const core = Core.new();
      const today = core.projection().todayId;
      const outsidePath = path.join(sourceRoot, 'id_rsa');
      const marker = formatFileReferenceMarker('id_rsa', outsidePath);

      const result = await executeRawTool(core, 'node_create', {
        parent_id: today,
        outline: `- Read ${marker}`,
      }, { localFileRoot: localRoot });

      expect(result.details.ok).toBe(false);
      expect(result.details.error?.code).toBe('invalid_file_reference');
      expect(core.state().nodes[today]!.children).toHaveLength(0);
    } finally {
      await Promise.all([
        rm(localRoot, { recursive: true, force: true }),
        rm(sourceRoot, { recursive: true, force: true }),
      ]);
    }
  });

  test('node_create persists validated chat-source inline refs', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const target = {
      kind: 'chat-source',
      stream: 'conversation',
      streamId: 'lin-agent-1',
      range: { fromSeqExclusive: 4, throughSeq: 8, throughEventId: 'event-8' },
    } as const;
    const marker = formatChatSourceReferenceMarker('source chat', target);

    const result = await executeRawTool<{ createdRootIds: string[] }>(core, 'node_create', {
      parent_id: today,
      outline: `- Memory episode ${marker}`,
    }, {
      chatSourceValidator: (source) => source.streamId === target.streamId ? { ok: true } : { ok: false },
    });

    expect(result.details.ok).toBe(true);
    const nodeId = result.details.data!.createdRootIds[0]!;
    const node = core.state().nodes[nodeId]!;
    expect(node.content.text).toBe('Memory episode ');
    expect(node.content.inlineRefs).toEqual([{
      offset: 'Memory episode '.length,
      target,
      displayName: 'source chat',
    }]);

    const read = await executeRawTool<{ items: Array<{ outline?: string; title: string }> }>(core, 'node_read', {
      node_id: nodeId,
      depth: 0,
    });
    expect(read.details.data!.items[0]!.title).toBe(`Memory episode ${marker}`);
    expect(read.details.data!.items[0]!.outline).toBe(`- Memory episode ${marker}`);
    expect(splitChatSourceReferenceMarkers(read.details.data!.items[0]!.title)[1]).toMatchObject({
      type: 'chat',
      target,
    });
  });

  test('node_create rejects fabricated chat-source inline refs before mutation', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const marker = formatChatSourceReferenceMarker('bad source', {
      kind: 'chat-source',
      stream: 'conversation',
      streamId: 'missing-conversation',
      range: { fromSeqExclusive: 1, throughSeq: 2, throughEventId: 'event-2' },
    });

    const result = await executeRawTool(core, 'node_create', {
      parent_id: today,
      outline: `- Memory episode ${marker}`,
    }, {
      chatSourceValidator: () => ({
        ok: false,
        code: 'invalid_chat_source',
        error: 'No source stream was found.',
      }),
    });

    expect(result.details.ok).toBe(false);
    expect(result.details.error?.code).toBe('invalid_chat_source');
    expect(core.state().nodes[today]!.children).toHaveLength(0);
  });

  test('node_create preserves unchecked checkbox markers', async () => {
    const core = Core.new();
    const today = core.projection().todayId;

    const envelope = await executeTool<{ createdRootIds: string[] }>(core, 'node_create', {
      parent_id: today,
      outline: '- [ ] Draft task',
    });

    expect(envelope.ok).toBe(true);
    const node = core.state().nodes[envelope.data!.createdRootIds[0]!]!;
    // Unchecked marker → manual checkbox present but undone (sentinel completedAt = 0).
    expect(node.completedAt).toBe(0);
  });

  test('node_create creates reference nodes with insertion points', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const targetParentId = mustFocus(core.createNode(today, null, 'Canonical source'));
    const targetId = mustFocus(core.createNode(targetParentId, null, 'Canonical'));
    const afterId = mustFocus(core.createNode(today, null, 'Before ref'));

    const envelope = await executeTool<{
      createdRootIds: string[];
      targetId?: string;
    }>(core, 'node_create', { after_id: afterId, target_id: targetId });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.targetId).toBe(targetId);
    const refId = envelope.data!.createdRootIds[0]!;
    expect(core.state().nodes[refId]!.type).toBe('reference');
    expect(core.state().nodes[refId]!.targetId).toBe(targetId);
    expect(core.state().nodes[today]!.children).toEqual([targetParentId, afterId, refId]);
  });

  test('node_create rejects references to trashed targets before mutation', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const targetId = mustFocus(core.createNode(today, null, 'Archived target'));
    core.trashNode(targetId);

    const shortcut = await executeTool(core, 'node_create', { parent_id: today, target_id: targetId });
    expect(shortcut.ok).toBe(false);
    expect(shortcut.error?.code).toBe('node_in_trash');

    const outline = await executeTool(core, 'node_create', {
      parent_id: today,
      outline: `- ${formatNodeReferenceMarker('Archived target', targetId)}`,
    });
    expect(outline.ok).toBe(false);
    expect(outline.error?.code).toBe('node_in_trash');
  });

  test('node_create duplicates a subtree from plain outline', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const sourceId = mustFocus(core.createNode(today, null, 'Source'));
    core.updateNodeDescription(sourceId, 'Original');
    core.createNode(sourceId, null, 'Child');

    const envelope = await executeTool<{
      createdRootIds: string[];
      duplicatedFrom?: string;
      outline?: string;
    }>(core, 'node_create', { parent_id: today, duplicate_id: sourceId });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.duplicatedFrom).toBe(sourceId);
    expect(envelope.data!.outline).toContain('- Source - Original');
    const cloneId = envelope.data!.createdRootIds[0]!;
    expect(cloneId).not.toBe(sourceId);
    expect(core.state().nodes[cloneId]!.content.text).toBe('Source');
    expect(core.state().nodes[cloneId]!.description).toBe('Original');
    const clonedChildId = core.state().nodes[cloneId]!.children[0]!;
    expect(core.state().nodes[clonedChildId]!.content.text).toBe('Child');
  });

  test('node_create persists saved search nodes with executable conditions', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const tagId = mustFocus(core.createTag('weather'));
    const tagged = mustFocus(core.createNode(today, null, 'Chengdu forecast'));
    const untagged = mustFocus(core.createNode(today, null, 'Shanghai forecast'));
    core.applyTag(tagged, tagId);

    const created = await executeTool<{ createdRootIds: string[] }>(core, 'node_create', {
      parent_id: core.projection().searchesId,
      outline: [
        '- %%search%% Weather forecast %%view:list%%',
        '  - AND',
        '    - STRING_MATCH',
        '      - value:: forecast',
        `    - HAS_TAG`,
        `      - tag:: ${nodeRef(core, tagId, '#weather')}`,
      ].join('\n'),
    });

    expect(created.ok).toBe(true);
    const searchId = created.data!.createdRootIds[0]!;
    const search = core.state().nodes[searchId]!;
    expect(search.type).toBe('search');
    const viewDef = search.children
      .map((childId) => core.state().nodes[childId]!)
      .find((child) => child.type === 'viewDef');
    expect(viewDef?.viewMode).toBe('list');
    const searchChildTypes = search.children.map((childId) => core.state().nodes[childId]!.type);
    expect(searchChildTypes).toContain('queryCondition');
    const resultRefs = search.children
      .map((childId) => core.state().nodes[childId]!)
      .filter((child) => child.type === 'reference');
    expect(resultRefs.map((ref) => ref.targetId)).toEqual([tagged]);

    const results = await executeTool<{
      total: number;
      items?: Array<{ nodeId: string; title: string }>;
    }>(core, 'node_search', { search_node_id: searchId, limit: 10 });

    expect(results.ok).toBe(true);
    expect(results.data!.items?.map((item) => item.nodeId)).toEqual([tagged]);
    expect(results.data!.items?.map((item) => item.nodeId)).not.toContain(untagged);

    const read = await executeTool<{ items: Array<{ outline?: string }> }>(core, 'node_read', {
      node_id: searchId,
    });
    expect(read.data!.items[0]!.outline).toBe([
      '- %%search%% %%view:list%% Weather forecast',
      '  - AND',
      '    - STRING_MATCH',
      '      - value:: forecast',
      `    - HAS_TAG`,
      `      - tag:: ${nodeRef(core, tagId, '#weather')}`,
    ].join('\n'));
  });

  test('node_create preview validates canonical saved search rules', async () => {
    const core = Core.new();

    const envelope = await executeTool(core, 'node_create', {
      parent_id: core.projection().searchesId,
      outline: '- %%search%% Invalid saved search\n  - FIELD_IS\n    - field:: Missing\n    - value:: Value',
      preview_only: true,
    });

    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('invalid_search_condition');
  });

  test('node_search does not treat a saved search title as an implicit condition', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    core.createNode(today, null, 'Chengdu weather');
    const searchId = mustFocus(core.createSearchNode(core.projection().searchesId, null, {
      title: 'Chengdu',
      query: { kind: 'group', logic: 'AND', children: [] },
    }));

    const envelope = await executeTool(core, 'node_search', {
      search_node_id: searchId,
      limit: 10,
    });

    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('empty_search');
  });

  test('node_delete moves selected nodes to trash and skips covered descendants', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const parent = mustFocus(core.createNode(today, null, 'Parent'));
    const child = mustFocus(core.createNode(parent, null, 'Child'));
    const sibling = mustFocus(core.createNode(today, null, 'Sibling'));

    const envelope = await executeTool<{
      deletedNodeIds: string[];
      deletedCount: number;
      affectedNodeCount: number;
      skippedNodeIds?: Array<{ nodeId: string; reason: string; coveredBy?: string }>;
      preview: Array<{ nodeId: string; subtreeNodeCount: number }>;
    }>(core, 'node_delete', { node_ids: [parent, child, sibling] });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.deletedNodeIds).toEqual([parent, sibling]);
    expect(envelope.data!.deletedCount).toBe(2);
    expect(envelope.data!.affectedNodeCount).toBe(3);
    expect(envelope.data!.skippedNodeIds).toEqual([{ nodeId: child, reason: 'covered_by_ancestor', coveredBy: parent }]);
    expect(envelope.data!.preview).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: parent, subtreeNodeCount: 2 }),
      expect.objectContaining({ nodeId: sibling, subtreeNodeCount: 1 }),
    ]));
    expect(core.state().nodes[parent]!.parentId).toBe(TRASH_ID);
    expect(core.state().nodes[sibling]!.parentId).toBe(TRASH_ID);
    expect(core.state().nodes[child]!.parentId).toBe(parent);
  });

  test('node_delete preview does not mutate', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const nodeId = mustFocus(core.createNode(today, null, 'Preview me'));

    const envelope = await executeTool<{
      deletedNodeIds: string[];
      deletedCount: number;
      preview: Array<{ nodeId: string; title: string }>;
    }>(core, 'node_delete', { node_id: nodeId, preview_only: true });

    expect(envelope.ok).toBe(true);
    expect(envelope.status).toBe('unchanged');
    expect(envelope.data!.deletedNodeIds).toEqual([]);
    expect(envelope.data!.deletedCount).toBe(0);
    expect(envelope.data!.preview).toEqual([expect.objectContaining({ nodeId, title: 'Preview me' })]);
    expect(core.state().nodes[nodeId]!.parentId).toBe(today);
  });

  test('node_delete restores nodes from trash', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const nodeId = mustFocus(core.createNode(today, null, 'Restore me'));
    core.trashNode(nodeId);
    expect(core.state().nodes[nodeId]!.parentId).toBe(TRASH_ID);

    const envelope = await executeTool<{
      action: 'trashed' | 'restored';
      restoredNodeIds?: string[];
      restoredCount?: number;
    }>(core, 'node_delete', { node_id: nodeId, restore: true });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.action).toBe('restored');
    expect(envelope.data!.restoredNodeIds).toEqual([nodeId]);
    expect(envelope.data!.restoredCount).toBe(1);
    expect(core.state().nodes[nodeId]!.parentId).toBe(today);
  });

  test('node_delete can trash one field entry without touching sibling fields', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const root = mustFocus(core.createNode(today, null, 'Task'));
    const statusField = mustFocus(core.createInlineField(root, null, 'Status', 'plain'));
    const ownerField = mustFocus(core.createInlineField(root, null, 'Owner', 'plain'));
    const ownerValue = mustFocus(core.createNode(ownerField, null, 'Ada'));

    const envelope = await executeTool<{ deletedNodeIds: string[] }>(core, 'node_delete', { node_id: statusField });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.deletedNodeIds).toEqual([statusField]);
    expect(core.state().nodes[statusField]!.parentId).toBe(TRASH_ID);
    expect(core.state().nodes[ownerField]!.parentId).toBe(root);
    expect(core.state().nodes[ownerValue]!.parentId).toBe(ownerField);
  });

  test('node_delete can trash one field value without touching sibling values', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const root = mustFocus(core.createNode(today, null, 'Task'));
    const statusField = mustFocus(core.createInlineField(root, null, 'Status', 'plain'));
    const openValue = mustFocus(core.createNode(statusField, null, 'Open'));
    const blockedValue = mustFocus(core.createNode(statusField, null, 'Blocked'));

    const envelope = await executeTool<{ deletedNodeIds: string[] }>(core, 'node_delete', { node_id: openValue });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.deletedNodeIds).toEqual([openValue]);
    expect(core.state().nodes[openValue]!.parentId).toBe(TRASH_ID);
    expect(core.state().nodes[blockedValue]!.parentId).toBe(statusField);
    expect(core.state().nodes[statusField]!.children).toContain(blockedValue);
  });

  test('node_edit requires expected_revision for non-preview whole editable outline replacement', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const root = mustFocus(core.createNode(today, null, 'Task'));

    const envelope = await executeTool(core, 'node_edit', {
      node_id: root,
      old_string: '*',
      new_string: '- [x] Renamed #edited',
    });

    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('expected_revision_required');
    expect(core.state().nodes[root]!.content.text).toBe('Task');
  });

  test('node_edit replaces the whole editable outline with revision guard', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const root = mustFocus(core.createNode(today, null, 'Task'));
    const statusField = mustFocus(core.createInlineField(root, null, 'Status', 'plain'));
    const statusValue = mustFocus(core.createNode(statusField, null, 'Open'));
    const read = await executeTool<{ items: Array<{ revision: string }> }>(core, 'node_read', { node_id: root, depth: 0 });

    const envelope = await executeTool<{ afterOutline?: string; matchedNodeIds?: string[] }>(core, 'node_edit', {
      node_id: root,
      old_string: '*',
      new_string: `- [x] Renamed #edited\n  - %%node:${statusField}%% Status::\n    - %%node:${statusValue}%% Closed`,
      expected_revision: read.data!.items[0]!.revision,
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.afterOutline).toContain(`- %%node:${root}%% [x] Renamed #edited`);
    expect(envelope.data!.matchedNodeIds).toEqual(expect.arrayContaining([root, statusField, statusValue]));
    expect(core.state().nodes[root]!.content.text).toBe('Renamed');
    expect(core.state().nodes[statusValue]!.content.text).toBe('Closed');
    expect(core.state().nodes[root]!.completedAt).toBeGreaterThan(0);
  });

  test('node_edit whole editable outline revision covers field value changes', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const root = mustFocus(core.createNode(today, null, 'Task'));
    const statusField = mustFocus(core.createInlineField(root, null, 'Status', 'plain'));
    const statusValue = mustFocus(core.createNode(statusField, null, 'Open'));
    const read = await executeTool<{ items: Array<{ revision: string }> }>(core, 'node_read', { node_id: root, depth: 0 });

    core.applyNodeTextPatch(statusValue, replaceAllRichTextPatch(plainText('User changed')));

    const envelope = await executeTool(core, 'node_edit', {
      node_id: root,
      old_string: '*',
      new_string: `- Task\n  - %%node:${statusField}%% Status::\n    - %%node:${statusValue}%% Closed`,
      expected_revision: read.data!.items[0]!.revision,
    });

    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('revision_mismatch');
    expect(core.state().nodes[statusValue]!.content.text).toBe('User changed');
  });

  test('node_edit rejects whole editable outline replacement with child structure and preserves children', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const root = mustFocus(core.createNode(today, null, 'Task'));
    const oldChild = mustFocus(core.createNode(root, null, 'Old child'));
    const read = await executeTool<{ items: Array<{ revision: string }> }>(core, 'node_read', { node_id: root, depth: 0 });

    const envelope = await executeTool(core, 'node_edit', {
      node_id: root,
      old_string: '*',
      new_string: '- [x] Renamed - Done #edited\n  - Status:: Complete\n  - New child',
      expected_revision: read.data!.items[0]!.revision,
    });

    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('subtree_edit_removed');
    expect(core.state().nodes[root]!.content.text).toBe('Task');
    expect(core.state().nodes[root]!.children).toEqual([oldChild]);
    expect(core.state().nodes[oldChild]!.content.text).toBe('Old child');
    expect(core.state().nodes[oldChild]!.parentId).toBe(root);
  });

  test('node_edit guidance reports a real no-op instead of claiming the edit applied', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const root = mustFocus(core.createNode(today, null, 'Task'));

    // old_string === new_string leaves the outline byte-identical → unchanged.
    const result = await executeRawTool<{ status: 'updated' | 'unchanged' }>(core, 'node_edit', {
      node_id: root,
      old_string: '- Task',
      new_string: '- Task',
    });
    const visible = parseVisibleToolResult<{ instructions?: string }>(result.contentText);

    expect(result.details.status).toBe('unchanged');
    expect(visible.instructions).toContain('No change was needed');
    expect(visible.instructions).not.toContain('Edit applied');
  });

  test('node_edit accepts explicit replace_outline operation and returns the next revision visibly', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const root = mustFocus(core.createNode(today, null, 'Task'));

    const result = await executeRawTool<{ status: 'updated' | 'unchanged'; revisions?: Record<string, string> }>(core, 'node_edit', {
      operation: 'replace_outline',
      node_id: root,
      old_string: '- Task',
      new_string: '- Renamed',
    });
    const visible = parseVisibleToolResult<{ data?: { outline?: string; revisions?: Record<string, string> } }>(result.contentText);

    expect(result.details.ok).toBe(true);
    expect(result.details.data!.action).toBe('replace_outline');
    expect(result.details.data!.revisions?.[root]).toBeTruthy();
    expect(visible.data!.outline).toContain(`- %%node:${root}%% Renamed`);
    expect(visible.data!.revisions?.[root]).toBe(result.details.data!.revisions?.[root]);
  });

  test('node_edit operation rejects fields from a different operation', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const root = mustFocus(core.createNode(today, null, 'Task'));

    const envelope = await executeTool(core, 'node_edit', {
      operation: 'move',
      node_id: root,
      old_string: '- Task',
      new_string: '- Renamed',
      move: { after_id: null },
    });

    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('invalid_args');
    expect(envelope.error?.message).toContain('operation "move" cannot be combined with');
    expect(core.state().nodes[root]!.content.text).toBe('Task');
  });

  test('node_edit preserves rich text metadata on unchanged titles and field values', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const rootFile = { kind: 'local-file', path: '/tmp/brief.pdf', entryKind: 'file' } as const;
    const valueFile = { kind: 'local-file', path: '/tmp/source.txt', entryKind: 'file' } as const;
    const rootMarker = formatFileReferenceMarker('brief.pdf', rootFile.path);
    const valueMarker = formatFileReferenceMarker('source.txt', valueFile.path);
    const root = mustFocus(core.createRichTextContentNode(today, null, {
      text: 'Task ',
      marks: [{ start: 0, end: 4, type: 'bold' }],
      inlineRefs: [{
        offset: 5,
        target: rootFile,
        displayName: 'brief.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 321,
      }],
    }));
    const fieldEntryId = mustFocus(core.createInlineField(root, null, 'Status', 'plain'));
    const valueId = mustFocus(core.createRichTextContentNode(fieldEntryId, null, {
      text: 'Open ',
      marks: [{ start: 0, end: 4, type: 'italic' }],
      inlineRefs: [{
        offset: 5,
        target: valueFile,
        displayName: 'source.txt',
        mimeType: 'text/plain',
        sizeBytes: 12,
      }],
    }));

    const envelope = await executeTool<{ status: 'updated' | 'unchanged' }>(core, 'node_edit', {
      node_id: root,
      old_string: `  - %%node:${fieldEntryId}%% Status::\n    - %%node:${valueId}%% *Open* ${valueMarker}`,
      new_string: `  - %%node:${fieldEntryId}%% Status::\n    - %%node:${valueId}%% *Open* ${valueMarker}\n    - Waiting`,
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.status).toBe('updated');
    expect(core.state().nodes[root]!.content).toEqual({
      text: 'Task ',
      marks: [{ start: 0, end: 4, type: 'bold' }],
      inlineRefs: [{
        offset: 5,
        target: rootFile,
        displayName: 'brief.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 321,
      }],
    });
    expect(core.state().nodes[valueId]!.content).toEqual({
      text: 'Open ',
      marks: [{ start: 0, end: 4, type: 'italic' }],
      inlineRefs: [{
        offset: 5,
        target: valueFile,
        displayName: 'source.txt',
        mimeType: 'text/plain',
        sizeBytes: 12,
      }],
    });
    expect(core.state().nodes[fieldEntryId]!.children.map((childId) => core.state().nodes[childId]!.content.text)).toEqual([
      'Open ',
      'Waiting',
    ]);
  });

  test('node_edit treats reference-like markers in descriptions and field names as plain text', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const root = mustFocus(core.createNode(today, null, 'Task'));
    const staleMarker = formatChatSourceReferenceMarker('stale', {
      kind: 'chat-source',
      stream: 'conversation',
      streamId: 'deleted-conversation',
      range: { fromSeqExclusive: 1, throughSeq: 2, throughEventId: 'event-2' },
    });

    const envelope = await executeTool<{ status: 'updated' | 'unchanged' }>(core, 'node_edit', {
      node_id: root,
      old_string: `- %%node:${root}%% Task`,
      new_string: `- %%node:${root}%% Task - See ${staleMarker}\n  - Review ${staleMarker}:: Plain`,
    });

    expect(envelope.ok).toBe(true);
    expect(core.state().nodes[root]!.description).toBe(`See ${staleMarker}`);
    const fieldEntryId = core.state().nodes[root]!.children[0]!;
    const fieldDefId = core.state().nodes[fieldEntryId]!.fieldDefId!;
    expect(core.state().nodes[fieldDefId]!.content.text).toBe(`Review ${staleMarker}`);
  });

  test('node_edit updates code block fenced text as plain code', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const created = await executeTool<{ createdRootIds: string[] }>(core, 'node_create', {
      parent_id: today,
      outline: '- ```ts\nconst x = 1\n```',
    });
    const nodeId = created.data!.createdRootIds[0]!;

    const envelope = await executeTool<{ status: 'updated' | 'unchanged'; afterOutline?: string }>(core, 'node_edit', {
      node_id: nodeId,
      old_string: `- %%node:${nodeId}%% \`\`\`typescript\nconst x = 1\n\`\`\``,
      new_string: `- %%node:${nodeId}%% \`\`\`typescript\nconst x = **1**\n\`\`\``,
    });

    expect(envelope.ok).toBe(true);
    expect(core.state().nodes[nodeId]!.content).toEqual({
      text: 'const x = **1**',
      marks: [],
      inlineRefs: [],
    });
    expect(envelope.data!.afterOutline).toContain('const x = **1**');
  });

  test('node_edit rejects out-of-root local-file markers from agent outlines', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-node-root-'));
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-node-source-'));
    try {
      const core = Core.new();
      const today = core.projection().todayId;
      const root = mustFocus(core.createNode(today, null, 'Task'));
      const outsidePath = path.join(sourceRoot, 'id_rsa');
      const marker = formatFileReferenceMarker('id_rsa', outsidePath);

      const result = await executeRawTool(core, 'node_edit', {
        node_id: root,
        old_string: `- %%node:${root}%% Task`,
        new_string: `- %%node:${root}%% Task ${marker}`,
      }, { localFileRoot: localRoot });

      expect(result.details.ok).toBe(false);
      expect(result.details.error?.code).toBe('invalid_file_reference');
      expect(core.state().nodes[root]!.content.text).toBe('Task');
    } finally {
      await Promise.all([
        rm(localRoot, { recursive: true, force: true }),
        rm(sourceRoot, { recursive: true, force: true }),
      ]);
    }
  });

  test('node_edit validates existing date field values against the canonical format', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const tagId = mustFocus(core.createTag('event'));
    const templateEntryId = mustFocus(core.createFieldDef(tagId, 'Date', 'date'));
    const dateFieldDefId = core.state().nodes[templateEntryId]!.fieldDefId!;
    const root = mustFocus(core.createNode(today, null, 'Launch'));
    core.applyTag(root, tagId);
    const fieldEntryId = core.state().nodes[root]!.children.find((childId) =>
      core.state().nodes[childId]!.fieldDefId === dateFieldDefId)!;

    const valid = await executeTool(core, 'node_edit', {
      node_id: root,
      old_string: `  - %%node:${fieldEntryId}%% Date::`,
      new_string: `  - %%node:${fieldEntryId}%% Date::\n    - 2026-05-20 / 2026-05-24`,
    });
    expect(valid.ok).toBe(true);
    expect(core.state().nodes[fieldEntryId]!.children.map((childId) => core.state().nodes[childId]!.content.text)).toEqual([
      '2026-05-20/2026-05-24',
    ]);

    const invalid = await executeTool(core, 'node_edit', {
      node_id: root,
      old_string: `  - %%node:${fieldEntryId}%% Date::\n    - %%node:${core.state().nodes[fieldEntryId]!.children[0]}%% 2026-05-20/2026-05-24`,
      new_string: `  - %%node:${fieldEntryId}%% Date::\n    - 2026-05-20..2026-05-24`,
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.error?.message).toContain('date field and received a non-date value');
    expect(core.state().nodes[fieldEntryId]!.children.map((childId) => core.state().nodes[childId]!.content.text)).toEqual([
      '2026-05-20/2026-05-24',
    ]);
  });

  test('node_edit rejects child-structure outline edits', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const root = mustFocus(core.createNode(today, null, 'Root'));
    const taskA = mustFocus(core.createNode(root, null, 'Task A'));
    const taskB = mustFocus(core.createNode(root, null, 'Task B'));

    const envelope = await executeTool(core, 'node_edit', {
      node_id: root,
      old_string: `- %%node:${root}%% Root`,
      new_string: `- %%node:${root}%% Root\n  - %%node:${taskB}%% Task C`,
    });

    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('subtree_edit_removed');
    expect(core.state().nodes[root]!.children).toEqual([taskA, taskB]);
    expect(core.state().nodes[taskB]!.content.text).toBe('Task B');
  });

  test('node_edit edits a child directly by id', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const root = mustFocus(core.createNode(today, null, 'Root'));
    const taskB = mustFocus(core.createNode(root, null, 'Task B'));

    const envelope = await executeTool<{
      afterOutline?: string;
      matchedNodeIds?: string[];
    }>(core, 'node_edit', {
      node_id: taskB,
      old_string: `- %%node:${taskB}%% Task B`,
      new_string: `- %%node:${taskB}%% Task C`,
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.afterOutline).toContain(`- %%node:${taskB}%% Task C`);
    expect(envelope.data!.matchedNodeIds).toContain(taskB);
    expect(core.state().nodes[root]!.children.map((childId) => core.state().nodes[childId]!.content.text)).toEqual(['Task C']);
  });

  test('node_edit accepts target root line fragments without repeating the node marker', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const root = mustFocus(core.createNode(today, null, 'Task'));

    const envelope = await executeTool<{
      afterOutline?: string;
      matchedNodeIds?: string[];
    }>(core, 'node_edit', {
      node_id: root,
      old_string: '- Task',
      new_string: '- [x] Task #done',
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.afterOutline).toContain(`- %%node:${root}%% [x] Task #done`);
    expect(envelope.data!.matchedNodeIds).toContain(root);
    expect(core.state().nodes[root]!.content.text).toBe('Task');
    expect(core.state().nodes[root]!.completedAt).toBeGreaterThan(0);
  });

  test('node_edit does not rewrite a mismatched root marker from old_string', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const root = mustFocus(core.createNode(today, null, 'Task'));

    const envelope = await executeTool(core, 'node_edit', {
      node_id: root,
      old_string: '- %%node:other%% Task',
      new_string: '- Task updated',
    });

    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('old_string_not_found');
    expect(core.state().nodes[root]!.content.text).toBe('Task');
  });

  test('node_edit root shorthand does not fall back to matching field values', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const root = mustFocus(core.createNode(today, null, 'Project'));
    const statusField = mustFocus(core.createInlineField(root, null, 'Status', 'plain'));
    const statusValue = mustFocus(core.createNode(statusField, null, 'Task'));

    const envelope = await executeTool(core, 'node_edit', {
      node_id: root,
      old_string: '- Task',
      new_string: '- Task renamed',
    });

    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('old_string_not_found');
    expect(core.state().nodes[root]!.content.text).toBe('Project');
    expect(core.state().nodes[statusValue]!.content.text).toBe('Task');
  });

  test('node_edit model-visible result returns current annotated outline after apply', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const root = mustFocus(core.createNode(today, null, 'Root'));
    core.createNode(root, null, 'Task A');

    const result = await executeRawTool<{
      beforeOutline?: string;
      afterOutline?: string;
      affectedNodeIds: string[];
    }>(core, 'node_edit', {
      node_id: root,
      old_string: `- %%node:${root}%% Root`,
      new_string: `- %%node:${root}%% Root updated`,
    });

    const visible = parseVisibleToolResult<{
      ok: boolean;
      instructions?: string;
      data?: {
        outline?: string;
        changes?: { updated?: string[] };
      };
    }>(result.contentText);

    expect(result.details.data!.beforeOutline).toContain('Root');
    expect(result.details.data!.afterOutline).toContain('Root updated');
    expect(visible).toMatchObject({ ok: true });
    expect(visible.instructions).toContain('Use node_delete for removals');
    expect(visible.instructions).not.toContain('removed marked lines were moved to Trash');
    expect(visible).not.toHaveProperty('tool');
    expect(visible).not.toHaveProperty('status');
    expect(visible.data).not.toHaveProperty('kind');
    expect(visible.data).not.toHaveProperty('action');
    expect(visible.data).not.toHaveProperty('status');
    expect(visible.data!.outline).toContain(`%%node:${root}%% Root updated`);
    expect(visible.data!.outline).toContain('Task A');
    expect(visible.data).not.toHaveProperty('changes');
    expect(JSON.stringify(visible)).not.toContain('beforeOutline');
    expect(JSON.stringify(visible)).not.toContain('"updated"');
  });

  test('node_edit preserves omitted fields and field values', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const root = mustFocus(core.createNode(today, null, 'Root'));
    const statusField = mustFocus(core.createInlineField(root, null, 'Status', 'plain'));
    const statusOpen = mustFocus(core.createNode(statusField, null, 'Open'));
    const statusBlocked = mustFocus(core.createNode(statusField, null, 'Blocked'));
    const ownerField = mustFocus(core.createInlineField(root, null, 'Owner', 'plain'));
    const ownerValue = mustFocus(core.createNode(ownerField, null, 'Ada'));

    const envelope = await executeTool<{
      matchedNodeIds?: string[];
      createdNodeIds?: string[];
    }>(core, 'node_edit', {
      node_id: root,
      old_string: `  - %%node:${statusField}%% Status::\n    - %%node:${statusOpen}%% Open\n    - %%node:${statusBlocked}%% Blocked`,
      new_string: `  - %%node:${statusField}%% Status::\n    - %%node:${statusOpen}%% In progress\n    - Waiting`,
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.matchedNodeIds).toEqual(expect.arrayContaining([statusField, statusOpen]));
    expect(core.state().nodes[statusField]!.children.map((childId) => core.state().nodes[childId]!.content.text)).toEqual([
      'In progress',
      'Blocked',
      'Waiting',
    ]);
    expect(core.state().nodes[ownerField]!.parentId).toBe(root);
    expect(core.state().nodes[ownerValue]!.parentId).toBe(ownerField);
  });

  test('node_edit reports ignored field clears with the current applied outline', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const root = mustFocus(core.createNode(today, null, 'Task'));
    const statusField = mustFocus(core.createInlineField(root, null, 'Status', 'plain'));
    const statusValue = mustFocus(core.createNode(statusField, null, 'Done'));

    const result = await executeRawTool<{
      status: 'updated' | 'unchanged';
      afterOutline?: string;
    }>(core, 'node_edit', {
      node_id: root,
      old_string: `  - %%node:${statusField}%% Status::\n    - %%node:${statusValue}%% Done`,
      new_string: `  - %%node:${statusField}%% Status::`,
    });

    expect(result.details.ok).toBe(true);
    expect(result.details.data!.afterOutline).toContain(`- %%node:${statusValue}%% Done`);
    expect(result.details.warnings?.some((warning) =>
      warning.includes('Status') && warning.includes('node_delete'))).toBe(true);
    expect(core.state().nodes[statusField]!.children).toEqual([statusValue]);
  });

  test('node_edit inserts new fields before existing ordinary children', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const root = mustFocus(core.createNode(today, null, 'Project'));
    const task = mustFocus(core.createNode(root, null, 'Task'));

    const envelope = await executeTool<{
      createdNodeIds?: string[];
      updatedFields?: string[];
    }>(core, 'node_edit', {
      node_id: root,
      old_string: `- %%node:${root}%% Project`,
      new_string: `- %%node:${root}%% Project\n  - Status:: Active`,
    });

    expect(envelope.ok).toBe(true);
    const statusField = envelope.data!.updatedFields![0]!;
    expect(core.state().nodes[statusField]!.type).toBe('fieldEntry');
    expect(core.state().nodes[root]!.children).toEqual([statusField, task]);
  });

  test('node_edit rejects field value kind changes before mutating the root', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const root = mustFocus(core.createNode(today, null, 'Task'));
    const target = mustFocus(core.createNode(today, null, 'Target'));
    const statusField = mustFocus(core.createInlineField(root, null, 'Status', 'plain'));
    const statusValue = mustFocus(core.createNode(statusField, null, 'Open'));
    const targetRef = nodeRef(core, target, 'Target');

    const envelope = await executeTool(core, 'node_edit', {
      node_id: root,
      old_string: `- %%node:${root}%% Task\n  - %%node:${statusField}%% Status::\n    - %%node:${statusValue}%% Open`,
      new_string: `- %%node:${root}%% Renamed\n  - %%node:${statusField}%% Status::\n    - %%node:${statusValue}%% ${targetRef}`,
    });

    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('invalid_field_value_kind');
    expect(envelope.instructions).toContain('node_delete');
    expect(core.state().nodes[root]!.content.text).toBe('Task');
    expect(core.state().nodes[statusValue]!.content.text).toBe('Open');
    expect(core.state().nodes[statusValue]!.type).toBeUndefined();
  });

  test('node_edit updates saved search config without pruning ordinary children', async () => {
    const core = Core.new();
    const searchId = mustFocus(core.createSearchNode(core.projection().searchesId, null, {
      title: 'Weather',
      query: { kind: 'rule', op: 'STRING_MATCH', text: 'weather' },
    }));
    const noteChild = mustFocus(core.createNode(searchId, null, 'Pinned note'));

    const envelope = await executeTool<{ status: 'updated' | 'unchanged'; afterOutline?: string }>(core, 'node_edit', {
      node_id: searchId,
      old_string: '    - value:: weather',
      new_string: '    - value:: forecast',
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.status).toBe('updated');
    expect(envelope.data!.afterOutline).toContain('value:: forecast');
    expect(core.state().nodes[searchId]!.content.text).toBe('Weather');
    expect(core.state().nodes[noteChild]!.parentId).toBe(searchId);
    expect(core.state().nodes[noteChild]!.content.text).toBe('Pinned note');
  });

  test('node_edit moves nodes with an absolute destination', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const source = mustFocus(core.createNode(today, null, 'Source'));
    const child = mustFocus(core.createNode(source, null, 'Child'));
    const destination = mustFocus(core.createNode(today, null, 'Destination'));

    const envelope = await executeTool<{
      movedNodeIds?: string[];
    }>(core, 'node_edit', {
      node_id: child,
      move: { parent_id: destination },
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.movedNodeIds).toEqual([child]);
    expect(core.state().nodes[child]!.parentId).toBe(destination);
    expect(core.state().nodes[source]!.children).toEqual([]);
    expect(core.state().nodes[destination]!.children).toEqual([child]);
  });

  test('node_edit replaces a node with a reference', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const targetParent = mustFocus(core.createNode(today, null, 'Canonical source'));
    const target = mustFocus(core.createNode(targetParent, null, 'Canonical'));
    const duplicate = mustFocus(core.createNode(today, null, 'Duplicate'));

    const envelope = await executeTool<{
      createdNodeIds?: string[];
      trashedNodeIds?: string[];
    }>(core, 'node_edit', {
      node_id: duplicate,
      replace_with_reference_to: target,
    });

    expect(envelope.ok).toBe(true);
    const referenceId = envelope.data!.createdNodeIds![0]!;
    expect(core.state().nodes[referenceId]!.type).toBe('reference');
    expect(core.state().nodes[referenceId]!.targetId).toBe(target);
    expect(core.state().nodes[duplicate]!.parentId).toBe(TRASH_ID);
    expect(envelope.data!.trashedNodeIds).toEqual([duplicate]);
  });

  test('node_edit retargets an existing reference without replacing its node id', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const targetParent = mustFocus(core.createNode(today, null, 'Canonical source'));
    const firstTarget = mustFocus(core.createNode(targetParent, null, 'First canonical'));
    const secondTarget = mustFocus(core.createNode(targetParent, null, 'Second canonical'));
    const referenceId = mustFocus(core.addReference(today, firstTarget, null));

    const envelope = await executeTool<{
      createdNodeIds?: string[];
      trashedNodeIds?: string[];
    }>(core, 'node_edit', {
      node_id: referenceId,
      replace_with_reference_to: secondTarget,
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.createdNodeIds).toBeUndefined();
    expect(envelope.data!.trashedNodeIds).toBeUndefined();
    expect(core.state().nodes[referenceId]!.parentId).toBe(today);
    expect(core.state().nodes[referenceId]!.type).toBe('reference');
    expect(core.state().nodes[referenceId]!.targetId).toBe(secondTarget);
  });

  test('node_edit merges source children and tags into target then trashes source', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const tagId = mustFocus(core.createTag('topic'));
    const target = mustFocus(core.createNode(today, null, 'Target'));
    const source = mustFocus(core.createNode(today, null, 'Source'));
    const sourceChild = mustFocus(core.createNode(source, null, 'Source child'));
    core.applyTag(source, tagId);

    const envelope = await executeTool<{
      merge?: { movedChildren: number; appliedTags: number };
      trashedNodeIds?: string[];
    }>(core, 'node_edit', {
      node_id: target,
      merge_from_node_ids: [source],
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.merge).toMatchObject({ movedChildren: 1, appliedTags: 1 });
    expect(envelope.data!.trashedNodeIds).toEqual([source]);
    expect(core.state().nodes[source]!.parentId).toBe(TRASH_ID);
    expect(core.state().nodes[sourceChild]!.parentId).toBe(target);
    expect(core.state().nodes[target]!.tags).toContain(tagId);
  });

  test('node_edit merges matching fields by moving source values into the target field', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const target = mustFocus(core.createNode(today, null, 'Target'));
    const source = mustFocus(core.createNode(today, null, 'Source'));
    const targetField = mustFocus(core.createInlineField(target, null, 'Status', 'plain'));
    const sourceField = mustFocus(core.createInlineField(source, null, 'Status', 'plain'));
    const targetValue = mustFocus(core.createNode(targetField, null, 'Todo'));
    const sourceValue = mustFocus(core.createNode(sourceField, null, 'Done'));

    const envelope = await executeTool<{
      merge?: { mergedFields: Array<{ mode: string; movedValueIds: string[] }> };
      movedNodeIds?: string[];
      trashedNodeIds?: string[];
    }>(core, 'node_edit', {
      node_id: target,
      merge_from_node_ids: [source],
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.merge!.mergedFields).toMatchObject([
      { mode: 'merged_values', movedValueIds: [sourceValue] },
    ]);
    expect(envelope.data!.movedNodeIds).toContain(sourceValue);
    expect(envelope.data!.trashedNodeIds).toContain(sourceField);
    expect(core.state().nodes[targetField]!.children).toEqual([targetValue, sourceValue]);
    expect(core.state().nodes[sourceValue]!.parentId).toBe(targetField);
    expect(core.state().nodes[sourceField]!.parentId).toBe(TRASH_ID);
  });

  test('node_edit merge redirects external references from source to target', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const target = mustFocus(core.createNode(today, null, 'Target'));
    const source = mustFocus(core.createNode(today, null, 'Source'));
    const referenceParent = mustFocus(core.createNode(today, null, 'External references'));
    const referenceId = mustFocus(core.addReference(referenceParent, source, null));

    const envelope = await executeTool<{
      merge?: { redirectedReferences: number };
    }>(core, 'node_edit', {
      node_id: target,
      merge_from_node_ids: [source],
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.merge!.redirectedReferences).toBe(1);
    expect(core.state().nodes[referenceId]!.targetId).toBe(target);
  });

  test('operation_history undo and redo use the agent Loro stack', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const nodeId = mustFocus(core.createNode(today, null, 'Undo me'));
    const deleted = await executeTool<{ deletedNodeIds: string[] }>(core, 'node_delete', { node_ids: [nodeId] });
    expect(deleted.ok).toBe(true);
    expect(core.state().nodes[nodeId]!.parentId).toBe(TRASH_ID);

    const undo = await executeTool<{
      action: 'undo' | 'redo' | 'list';
      count: number;
      undone?: Array<{ affectedNodeIds: string[] }>;
    }>(core, 'operation_history', { action: 'undo' });

    expect(undo.ok).toBe(true);
    expect(undo.data!.count).toBe(1);
    expect(undo.data!.undone![0]!.affectedNodeIds).toContain(nodeId);
    expect(core.state().nodes[nodeId]!.parentId).toBe(today);

    const redo = await executeTool<{
      action: 'undo' | 'redo' | 'list';
      count: number;
      redone?: Array<{ affectedNodeIds: string[] }>;
    }>(core, 'operation_history', { action: 'redo' });

    expect(redo.ok).toBe(true);
    expect(redo.data!.count).toBe(1);
    expect(redo.data!.redone![0]!.affectedNodeIds).toContain(nodeId);
    expect(core.state().nodes[nodeId]!.parentId).toBe(TRASH_ID);
  });

  test('operation_history list returns stored tool metadata', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const created = await executeTool<{ createdRootIds: string[] }>(core, 'node_create', {
      parent_id: today,
      outline: '- Journal item',
    });
    expect(created.ok).toBe(true);

    const history = await executeTool<{
      count: number;
      items?: Array<{ origin: string; tool?: string; action: string; affectedNodeIds: string[]; canUndo: boolean }>;
      canUndo: boolean;
    }>(core, 'operation_history', { action: 'list', origin: 'agent' });

    expect(history.ok).toBe(true);
    expect(history.data!.count).toBeGreaterThanOrEqual(1);
    expect(history.data!.canUndo).toBe(true);
    expect(history.data!.items![0]).toMatchObject({
      origin: 'agent',
      tool: 'node_create',
      action: 'node_create',
      canUndo: true,
    });
    expect(history.data!.items![0]!.affectedNodeIds).toContain(created.data!.createdRootIds[0]!);
  });

  test('operation_history model view drops derivable count, historyMode, cursor, and item command', () => {
    const data: OperationHistoryData = {
      action: 'list',
      historyMode: 'journal',
      count: 1,
      total: 5,
      hasMore: true,
      canUndo: true,
      canRedo: false,
      cursor: { topUndoOperationId: 'op_1' },
      items: [
        {
          operationId: 'op_1',
          origin: 'agent',
          command: 'create_node',
          tool: 'node_create',
          action: 'node_create',
          summary: 'Created a node.',
          affectedNodeIds: ['node_1'],
          createdAt: '2026-05-26T00:00:00.000Z',
          canUndo: true,
          canRedo: false,
        },
      ],
    };

    expect(visibleOperationHistory(data)).toEqual({
      action: 'list',
      total: 5,
      hasMore: true,
      items: [
        {
          operationId: 'op_1',
          origin: 'agent',
          tool: 'node_create',
          action: 'node_create',
          summary: 'Created a node.',
          affectedNodeIds: ['node_1'],
          createdAt: '2026-05-26T00:00:00.000Z',
          canUndo: true,
          canRedo: false,
        },
      ],
      canUndo: true,
      canRedo: false,
    });
  });

  test('operation_history defaults to listing all origins', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    core.withOrigin('user', () => core.createNode(today, null, 'User note'), {
      command: 'create_node',
      summary: 'User created a note.',
    });
    await executeTool(core, 'node_create', {
      parent_id: today,
      outline: '- Agent note',
    });

    const history = await executeTool<{
      items?: Array<{ origin: string }>;
    }>(core, 'operation_history', {});

    expect(history.ok).toBe(true);
    expect(history.data!.items?.map((item) => item.origin)).toContain('user');
    expect(history.data!.items?.map((item) => item.origin)).toContain('agent');
  });

  test('agent tool calls commit as one Loro undo step', async () => {
    const core = Core.new();
    const today = core.projection().todayId;

    const created = await executeTool<{
      createdRootIds: string[];
      createdNodeIds: string[];
    }>(core, 'node_create', {
      parent_id: today,
      outline: '- Launch #project\n  - Status:: Active\n  - Draft plan',
    });
    expect(created.ok).toBe(true);
    const rootId = created.data!.createdRootIds[0]!;
    expect(core.state().nodes[rootId]).toBeDefined();

    const undo = await executeTool<{ count: number }>(core, 'operation_history', { action: 'undo' });

    expect(undo.ok).toBe(true);
    expect(undo.data!.count).toBe(1);
    for (const nodeId of created.data!.createdNodeIds) {
      expect(core.state().nodes[nodeId]).toBeUndefined();
    }
  });

  test('node_read returns structured details and plain detail outline for a subtree', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const tagId = mustFocus(core.createTag('project'));
    const templateEntryId = mustFocus(core.createFieldDef(tagId, 'Status', 'plain'));
    const fieldDefId = core.state().nodes[templateEntryId].fieldDefId!;
    const nodeId = mustFocus(core.createNode(today, null, 'Launch'));
    core.updateNodeDescription(nodeId, 'Q2 rollout');
    core.applyTag(nodeId, tagId);
    const fieldEntryId = core.state().nodes[nodeId].children.find((childId) => core.state().nodes[childId].fieldDefId === fieldDefId)!;
    core.createNode(fieldEntryId, null, 'Active');
    const childId = mustFocus(core.createNode(nodeId, null, 'Draft plan'));

    const envelope = await executeTool<{
      items: Array<{
        nodeId: string;
        title: string;
        description: string | null;
        tags: string[];
        fields: Array<{ name: string; values: Array<{ text: string }> }>;
        children: { items: Array<{ nodeId: string; title: string }> };
        outline?: string;
      }>;
    }>(core, 'node_read', { node_id: nodeId, depth: 1 });

    expect(envelope.ok).toBe(true);
    const item = envelope.data!.items[0]!;
    expect(item.nodeId).toBe(nodeId);
    expect(item.title).toBe('Launch');
    expect(item.description).toBe('Q2 rollout');
    expect(item.tags).toContain('#project');
    expect(item.fields[0]).toMatchObject({ name: 'Status', values: [{ text: 'Active' }] });
    expect(item.children.items).toEqual([expect.objectContaining({ nodeId: childId, title: 'Draft plan' })]);
    expect(item.outline).toContain('- Launch - Q2 rollout #project');
    expect(item.outline).toContain('  - Status:: Active');
    expect(item.outline).toContain('  - Draft plan');
  });

  test('node_read serializes local-file inline refs as file markers', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const nodeId = mustFocus(core.createNode(today, null, 'Placeholder'));
    const filePath = '/Users/me/report.pdf';
    core.applyNodeTextPatch(nodeId, {
      ops: [{
        type: 'replace_all',
        content: {
          text: 'Review  soon',
          marks: [],
          inlineRefs: [{
            offset: 7,
            target: { kind: 'local-file', path: filePath, entryKind: 'file' },
            displayName: 'report.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 2048,
          }],
        },
      }],
    });

    const result = await executeRawTool<{
      items: Array<{ outline?: string; title: string }>;
    }>(core, 'node_read', { node_id: nodeId, depth: 0 });
    const visible = parseVisibleToolResult<{
      ok: boolean;
      data?: { outline?: string };
    }>(result.contentText);

    const marker = formatFileReferenceMarker('report.pdf', filePath);
    expect(result.details.data!.items[0]!.title).toBe(`Review ${marker} soon`);
    expect(visible.data!.outline).toBe(`- %%node:${nodeId}%% Review ${marker} soon`);
  });

  test('node_read preserves out-of-root local-file inline refs without materializing them', async () => {
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-node-root-'));
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-node-source-'));
    try {
      const core = Core.new();
      const today = core.projection().todayId;
      const nodeId = mustFocus(core.createNode(today, null, 'Placeholder'));
      const filePath = path.join(sourceRoot, 'report.pdf');
      core.applyNodeTextPatch(nodeId, {
        ops: [{
          type: 'replace_all',
          content: {
            text: 'Review  soon',
            marks: [],
            inlineRefs: [{
              offset: 7,
              target: { kind: 'local-file', path: filePath, entryKind: 'file' },
              displayName: 'report.pdf',
              mimeType: 'application/pdf',
              sizeBytes: 2048,
            }],
          },
        }],
      });

      const result = await executeRawTool<{
        items: Array<{ outline?: string; title: string }>;
      }>(core, 'node_read', { node_id: nodeId, depth: 0 }, { localFileRoot: localRoot });
      const visible = parseVisibleToolResult<{
        ok: boolean;
        data?: { outline?: string };
      }>(result.contentText);
      const marker = splitFileReferenceMarkers(result.details.data!.items[0]!.title)
        .find((segment) => segment.type === 'file');

      expect(marker?.path).toBe(filePath);
      expect(result.details.data!.items[0]!.title).toBe(`Review ${formatFileReferenceMarker('report.pdf', filePath)} soon`);
      expect(visible.data!.outline).toBe(`- %%node:${nodeId}%% Review ${formatFileReferenceMarker('report.pdf', filePath)} soon`);
    } finally {
      await Promise.all([
        rm(localRoot, { recursive: true, force: true }),
        rm(sourceRoot, { recursive: true, force: true }),
      ]);
    }
  });

  test('node_read default returns one annotated outline without duplicate refs', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const root = mustFocus(core.createNode(today, null, 'Root'));
    const child = mustFocus(core.createNode(root, null, 'Child'));

    const result = await executeRawTool<{
      items: Array<{ nodeId: string; children: { items: Array<{ nodeId: string }> }; outline?: string }>;
    }>(core, 'node_read', { node_id: root, depth: 1 });
    const visible = parseVisibleToolResult<{
      ok: boolean;
      data?: {
        outline?: string;
        references?: Array<{ node_id: string; title: string; display_ref: string; edit_handle: string; type: string }>;
      };
    }>(result.contentText);

    expect(visible.ok).toBe(true);
    expect(visible).not.toHaveProperty('tool');
    expect(visible.data).not.toHaveProperty('kind');
    expect((visible as any).metrics).toBeUndefined();
    expect(visible.data!.outline).toBe(`- %%node:${root}%% Root\n  - %%node:${child}%% Child`);
    expect((visible.data! as any).refs).toBeUndefined();
    expect(visible.data!.references).toEqual([
      {
        display_ref: nodeRef(core, root, 'Root'),
        edit_handle: `%%node:${root}%%`,
        node_id: root,
        title: 'Root',
        type: 'node',
      },
      {
        display_ref: nodeRef(core, child, 'Child'),
        edit_handle: `%%node:${child}%%`,
        node_id: child,
        title: 'Child',
        type: 'node',
      },
    ]);
    expect(result.details.data!.items[0]!.children.items).toEqual([expect.objectContaining({ nodeId: child })]);
  });

  test('node_read model-visible pagination uses snake_case fields', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const root = mustFocus(core.createNode(today, null, 'Root'));
    core.createNode(root, null, 'First');
    core.createNode(root, null, 'Second');

    const result = await executeRawTool(core, 'node_read', {
      node_id: root,
      depth: 1,
      child_limit: 1,
    });
    const visible = parseVisibleToolResult<{
      instructions?: string;
      data?: { page?: { total: number; offset: number; limit: number; next_offset?: number } };
    }>(result.contentText);

    expect(visible.data!.page).toMatchObject({ total: 2, offset: 0, limit: 1, next_offset: 1 });
    expect((visible.data!.page as any).nextOffset).toBeUndefined();
    expect(visible.instructions).toContain('child_offset 1');
  });

  test('node_read annotated outline includes field entry and field value ids', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const tagId = mustFocus(core.createTag('task'));
    const templateEntryId = mustFocus(core.createFieldDef(tagId, 'Status', 'plain'));
    const fieldDefId = core.state().nodes[templateEntryId]!.fieldDefId!;
    const root = mustFocus(core.createNode(today, null, 'Task'));
    core.applyTag(root, tagId);
    const fieldEntryId = core.state().nodes[root]!.children.find((childId) => core.state().nodes[childId]!.fieldDefId === fieldDefId)!;
    const valueId = mustFocus(core.createNode(fieldEntryId, null, 'Open'));

    const result = await executeRawTool(core, 'node_read', { node_id: root, depth: 1 });
    const visible = parseVisibleToolResult<{
      data?: { outline?: string };
    }>(result.contentText);

    expect(visible.data!.outline).toContain(`- %%node:${fieldEntryId}%% Status::`);
    expect(visible.data!.outline).toContain(`  - %%node:${valueId}%% Open`);
  });

  test('node_read model-visible errors use the node protocol', async () => {
    const core = Core.new();

    const result = await executeRawTool(core, 'node_read', { node_id: 'missing-node' });
    const visible = parseVisibleToolResult<{
      ok: boolean;
      instructions?: string;
      error?: {
        code: string;
        message: string;
      };
    }>(result.contentText);

    expect(result.details.ok).toBe(false);
    // The visible error drops the echoed `tool`, the redundant `status: 'error'`
    // (implied by `ok: false`), and the constant `recoverable`.
    expect(visible).toMatchObject({
      ok: false,
      error: { code: 'node_not_found' },
    });
    expect(visible).not.toHaveProperty('tool');
    expect(visible).not.toHaveProperty('status');
    expect(visible.error).not.toHaveProperty('recoverable');
    expect(visible.instructions).toContain('node_search');
    expect((visible as any).details).toBeUndefined();
    expect((visible as any).metrics).toBeUndefined();
  });

  test('node_search supports keyword search through temporary search outline', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const chengdu = mustFocus(core.createNode(today, null, 'Chengdu weather'));
    core.createNode(today, null, 'Beijing itinerary');

    const envelope = await executeTool<{
      total: number;
      items?: Array<{ nodeId: string; title: string; snippet: string }>;
    }>(core, 'node_search', {
      outline: '- %%search%% Chengdu\n  - STRING_MATCH\n    - value:: Chengdu',
      limit: 10,
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.total).toBe(1);
    expect(envelope.data!.items).toEqual([
      expect.objectContaining({ nodeId: chengdu, title: 'Chengdu weather' }),
    ]);
  });

  test('node_search uses indexed relevance for loose multi-term keyword search', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const exact = mustFocus(core.createNode(today, null, 'Launch design'));
    const loose = mustFocus(core.createNode(today, null, 'Design review'));
    core.updateNodeDescription(loose, 'Launch notes');

    const envelope = await executeTool<{
      total: number;
      items?: Array<{ nodeId: string; title: string }>;
    }>(core, 'node_search', {
      outline: '- %%search%% Launch design\n  - STRING_MATCH\n    - value:: launch design',
      limit: 10,
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.items?.map((item) => item.nodeId)).toEqual([exact, loose]);
  });

  test('node_search applies personal access ranking and records only the returned page', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const baselineFirst = mustFocus(core.createNode(
      today,
      null,
      'agent access ranking needle',
      'node:00000000-0000-4000-8000-000000000021',
    ));
    const favored = mustFocus(core.createNode(
      today,
      null,
      'agent access ranking needle',
      'node:00000000-0000-4000-8000-000000000022',
    ));
    const now = 4_000;
    const recorded: Array<{ nodeIds: string[]; source: string }> = [];

    const result = await executeRawTool<{
      total: number;
      items?: Array<{ nodeId: string; title: string }>;
    }>(core, 'node_search', {
      outline: '- %%search%% Agent ranking\n  - STRING_MATCH\n    - value:: agent access ranking needle',
      limit: 1,
    }, undefined, {
      getTransientSearchOptions: () => ({
        personalAccessRanking: {
          getNodeAccessStats: (nodeId) => nodeId === favored ? { s: 8, tUpdate: now } : undefined,
          now,
        },
      }),
      recordNodeAccess: (nodeIds, source) => {
        recorded.push({ nodeIds: [...nodeIds], source });
      },
    });

    expect(result.details.ok).toBe(true);
    expect(result.details.data!.items?.map((item) => item.nodeId)).toEqual([favored]);
    expect(result.details.data!.items?.map((item) => item.nodeId)).not.toContain(baselineFirst);
    expect(recorded).toEqual([{ nodeIds: [favored], source: 'agentRecall' }]);
  });

  test('node_search does not await asynchronous agent recall recording', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const chengdu = mustFocus(core.createNode(today, null, 'Async recall needle'));
    let resolved = false;
    let resolveRecord: (() => void) | null = null;

    const result = await executeRawTool<{
      total: number;
      items?: Array<{ nodeId: string; title: string }>;
    }>(core, 'node_search', {
      outline: '- %%search%% Async recall\n  - STRING_MATCH\n    - value:: Async recall needle',
      limit: 1,
    }, undefined, {
      recordNodeAccess: () => new Promise<void>((resolve) => {
        resolveRecord = () => {
          resolved = true;
          resolve();
        };
      }),
    });

    expect(result.details.ok).toBe(true);
    expect(result.details.data!.items?.map((item) => item.nodeId)).toEqual([chengdu]);
    expect(resolved).toBe(false);
    resolveRecord?.();
  });

  test('node_search model-visible result returns one annotated outline', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const chengdu = mustFocus(core.createNode(today, null, 'Chengdu weather'));
    core.createNode(today, null, 'Beijing itinerary');

    const result = await executeRawTool<{
      total: number;
      items?: Array<{ nodeId: string; title: string }>;
    }>(core, 'node_search', {
      outline: '- %%search%% Chengdu\n  - STRING_MATCH\n    - value:: Chengdu',
      limit: 10,
    });
    const visible = parseVisibleToolResult<{
      ok: boolean;
      instructions?: string;
      data?: {
        outline?: string;
        references?: Array<{ node_id: string; title: string; display_ref: string; edit_handle: string; type: string }>;
        page?: { total: number; offset: number; limit: number; next_offset?: number };
      };
    }>(result.contentText);

    expect(visible).toMatchObject({ ok: true });
    expect(visible).not.toHaveProperty('tool');
    expect(visible.data).not.toHaveProperty('kind');
    expect(visible.instructions).toContain('[[node:Display^...]]');
    expect(visible.instructions).toContain('[[node:^...]]');
    expect(visible.instructions).toContain('never show %%node:id%%');
    expect(visible.instructions).toContain('data.references[].display_ref');
    expect(visible.data!.outline).toBe(`- %%node:${chengdu}%% Chengdu weather`);
    expect((visible.data! as any).matches).toBeUndefined();
    expect((visible.data! as any).refs).toBeUndefined();
    expect(visible.data!.references).toEqual([{
      display_ref: nodeRef(core, chengdu, 'Chengdu weather'),
      edit_handle: `%%node:${chengdu}%%`,
      node_id: chengdu,
      title: 'Chengdu weather',
      type: 'node',
    }]);
    expect(visible.data!.page).toMatchObject({ total: 1, offset: 0, limit: 10 });
    expect(result.details.data!.items![0]!.nodeId).toBe(chengdu);
  });

  test('node_search count mode guides toward an id-returning call instead of an outline', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    mustFocus(core.createNode(today, null, 'Chengdu weather'));
    core.createNode(today, null, 'Beijing itinerary');

    const result = await executeRawTool(core, 'node_search', {
      outline: '- %%search%% Chengdu\n  - STRING_MATCH\n    - value:: Chengdu',
      count: true,
      limit: 10,
    });
    const visible = parseVisibleToolResult<{
      ok: boolean;
      instructions?: string;
      data?: { total?: number; outline?: string; references?: unknown };
    }>(result.contentText);

    // Count-only mode is signalled by the caller-supplied ctx, not by sniffing
    // the payload shape — guidance must point back to an id-returning call.
    expect(visible.instructions).toContain('Only the result count was requested');
    expect(visible.instructions).toContain('without count');
    // Editing guidance is suppressed: no outline markers, no reference hints.
    expect(visible.instructions).not.toContain('%%node:id%%');
    expect(visible.instructions).not.toContain('display_ref');
    expect(visible.data!.total).toBe(1);
    expect(visible.data).not.toHaveProperty('outline');
    expect(visible.data).not.toHaveProperty('references');
  });

  test('node_search count mode does not record agent recall', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    mustFocus(core.createNode(today, null, 'Count-only access needle'));
    const recorded: Array<{ nodeIds: string[]; source: string }> = [];

    const result = await executeRawTool(core, 'node_search', {
      outline: '- %%search%% Count only\n  - STRING_MATCH\n    - value:: Count-only access needle',
      count: true,
      limit: 10,
    }, undefined, {
      recordNodeAccess: (nodeIds, source) => {
        recorded.push({ nodeIds: [...nodeIds], source });
      },
    });

    expect(result.details.ok).toBe(true);
    expect(recorded).toEqual([]);
  });

  test('node_search resolves tag conditions from temporary search outlines', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const tagId = mustFocus(core.createTag('weather'));
    const tagged = mustFocus(core.createNode(today, null, 'Chengdu'));
    const untagged = mustFocus(core.createNode(today, null, 'Shanghai'));
    core.applyTag(tagged, tagId);

    const envelope = await executeTool<{
      total: number;
      items?: Array<{ nodeId: string; title: string }>;
    }>(core, 'node_search', {
      outline: `- %%search%% Weather notes %%view:list%%\n  - HAS_TAG\n    - tag:: ${nodeRef(core, tagId, '#weather')}`,
      limit: 10,
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.total).toBe(1);
    expect(envelope.data!.items?.map((item) => item.nodeId)).toEqual([tagged]);
    expect(envelope.data!.items?.map((item) => item.nodeId)).not.toContain(untagged);
  });

  test('node_search executes nested canonical query groups', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const alpha = mustFocus(core.createNode(today, null, 'Alpha note'));
    const beta = mustFocus(core.createNode(today, null, 'Beta note'));
    const gamma = mustFocus(core.createNode(today, null, 'Gamma note'));

    const envelope = await executeTool<{
      total: number;
      items?: Array<{ nodeId: string; title: string }>;
    }>(core, 'node_search', {
      outline: [
        '- %%search%% Alpha or beta',
        '  - AND',
        '    - OR',
        '      - STRING_MATCH',
        '        - value:: Alpha',
        '      - STRING_MATCH',
        '        - value:: Beta',
        '    - NOT',
        '      - STRING_MATCH',
        '        - value:: Gamma',
      ].join('\n'),
      limit: 10,
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.items?.map((item) => item.nodeId)).toEqual(expect.arrayContaining([alpha, beta]));
    expect(envelope.data!.items?.map((item) => item.nodeId)).not.toContain(gamma);
  });

  test('node_search rejects unresolved structured conditions instead of ignoring them', async () => {
    const core = Core.new();

    const missingTag = await executeTool(core, 'node_search', {
      outline: '- %%search%% Missing tag\n  - HAS_TAG\n    - tag:: missing',
    });
    expect(missingTag.ok).toBe(false);
    expect(missingTag.error?.code).toBe('invalid_search_condition');

    const missingField = await executeTool(core, 'node_search', {
      outline: '- %%search%% Missing field\n  - FIELD_IS\n    - field:: Status\n    - value:: Active',
    });
    expect(missingField.ok).toBe(false);
    expect(missingField.error?.code).toBe('invalid_search_condition');
    expect(missingField.instructions).toContain('Plain field names');
    expect(missingField.instructions).toContain('DONE_LAST_DAYS');
  });

  test('node_search guides common completion and date query mistakes toward executable operators', async () => {
    const core = Core.new();

    const isDone = await executeTool(core, 'node_search', {
      outline: '- %%search%% Done nodes\n  - IS_DONE',
    });
    expect(isDone.ok).toBe(false);
    expect(isDone.error?.code).toBe('unsupported_search_rule');
    expect(isDone.instructions).toContain('Use DONE');
    expect(isDone.instructions).toContain('DONE_LAST_DAYS');
    expect(isDone.instructions).toContain('Do not use FIELD_IS for done state');

    const isChecked = await executeTool(core, 'node_search', {
      outline: '- %%search%% Checked nodes\n  - IS_CHECKED',
    });
    expect(isChecked.ok).toBe(false);
    expect(isChecked.error?.code).toBe('unsupported_search_rule');
    expect(isChecked.instructions).toContain('Use DONE');
    expect(isChecked.instructions).toContain('DONE_LAST_DAYS');
    expect(isChecked.instructions).toContain('instead of AND + DATE_OVERLAPS');

    const dateTextField = await executeTool(core, 'node_search', {
      outline: '- %%search%% Date range\n  - DATE_OVERLAPS\n    - field:: date\n    - value:: 2026-05-14/2026-05-20',
    });
    expect(dateTextField.ok).toBe(false);
    expect(dateTextField.error?.code).toBe('invalid_search_condition');
    expect(dateTextField.instructions).toContain('DATE_OVERLAPS searches date field values');
    expect(dateTextField.instructions).toContain('field definition node id');
    expect(dateTextField.instructions).toContain('DONE_LAST_DAYS');
  });

  test('node_search executes outline reference conditions as links-to filters', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const target = mustFocus(core.createNode(today, null, 'Target'));
    const linked = mustFocus(core.createNode(today, null, 'Linked note'));
    const unlinked = mustFocus(core.createNode(today, null, 'Unlinked note'));
    core.addReference(linked, target, null);

    const envelope = await executeTool<{
      total: number;
      items?: Array<{ nodeId: string; title: string }>;
    }>(core, 'node_search', {
      outline: `- %%search%% Links to Target\n  - LINKS_TO\n    - target:: ${nodeRef(core, target)}`,
      limit: 10,
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.items?.map((item) => item.nodeId)).toEqual([linked]);
    expect(envelope.data!.items?.map((item) => item.nodeId)).not.toContain(unlinked);
  });

  test('node_search executes field conditions from temporary and saved search outlines', async () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const taskTagId = mustFocus(core.createTag('task'));
    const templateEntryId = mustFocus(core.createFieldDef(taskTagId, 'Status', 'plain'));
    const statusFieldDefId = core.state().nodes[templateEntryId]!.fieldDefId!;

    const active = mustFocus(core.createNode(today, null, 'Launch plan'));
    const waiting = mustFocus(core.createNode(today, null, 'Partner followup'));
    core.applyTag(active, taskTagId);
    core.applyTag(waiting, taskTagId);
    const activeStatus = core.state().nodes[active]!.children.find((childId) => core.state().nodes[childId]!.fieldDefId === statusFieldDefId)!;
    const waitingStatus = core.state().nodes[waiting]!.children.find((childId) => core.state().nodes[childId]!.fieldDefId === statusFieldDefId)!;
    core.createNode(activeStatus, null, 'Active');
    core.createNode(waitingStatus, null, 'Waiting');

    const temporary = await executeTool<{
      total: number;
      items?: Array<{ nodeId: string; title: string }>;
    }>(core, 'node_search', {
      outline: `- %%search%% Active tasks\n  - FIELD_IS\n    - field:: ${nodeRef(core, statusFieldDefId)}\n    - value:: Active`,
      limit: 10,
    });

    expect(temporary.ok).toBe(true);
    expect(temporary.data!.items?.map((item) => item.nodeId)).toEqual([active]);

    const saved = await executeTool<{ createdRootIds: string[] }>(core, 'node_create', {
      parent_id: core.projection().searchesId,
      outline: `- %%search%% Active tasks\n  - FIELD_IS\n    - field:: ${nodeRef(core, statusFieldDefId)}\n    - value:: Active`,
    });
    expect(saved.ok).toBe(true);

    const savedSearch = await executeTool<{
      total: number;
      items?: Array<{ nodeId: string; title: string }>;
    }>(core, 'node_search', {
      search_node_id: saved.data!.createdRootIds[0]!,
      limit: 10,
    });

    expect(savedSearch.ok).toBe(true);
    expect(savedSearch.data!.items?.map((item) => item.nodeId)).toEqual([active]);
  });
});
