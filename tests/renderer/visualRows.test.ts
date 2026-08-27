import { describe, expect, test } from 'bun:test';
import type { DocumentProjection, NodeId, NodeProjection, ProjectionUpdate } from '../../src/core/types';
import { flattenVisibleRows, reduceProjection } from '../../src/renderer/state/document';
import { buildSelectableRows } from '../../src/renderer/state/selectableRows';
import {
  buildVisualRows,
  buildVisualRowsIncrementally,
  visualRowNodeIds,
  type VisualRowsSnapshot,
} from '../../src/renderer/state/visualRows';

function node(id: string, patch: Partial<NodeProjection> = {}): NodeProjection {
  return {
    id,
    children: [],
    content: { text: id, marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    locked: false,
    autoCollected: false,
    toolbarVisible: false,
    filterValues: [],
    ...patch,
  } as NodeProjection;
}

function byIdOf(nodes: NodeProjection[]): Map<NodeId, NodeProjection> {
  return new Map(nodes.map((n) => [n.id, n]));
}

function projection(nodes: NodeProjection[], rootId = 'lib'): DocumentProjection {
  return {
    workspaceId: 'ws',
    rootId,
    libraryId: rootId,
    dailyNotesId: 'daily',
    schemaId: 'schema',
    searchesId: 'searches',
    recentsId: 'recents',
    trashId: 'trash',
    todayId: rootId,
    nodes,
  };
}

function delta(revision: number, changedNodes: NodeProjection[]): ProjectionUpdate {
  return { kind: 'delta', revision, todayId: 'lib', changedNodes, removedIds: [] };
}

// lib > a (>a1,a2), b (> refA -> a). With a, b, refA expanded the reference
// transcludes a's children a second time.
function fixture(): Map<NodeId, NodeProjection> {
  return byIdOf([
    node('lib', { children: ['a', 'b'] }),
    node('a', { parentId: 'lib', children: ['a1', 'a2'] }),
    node('a1', { parentId: 'a' }),
    node('a2', { parentId: 'a' }),
    node('b', { parentId: 'lib', children: ['refA'] }),
    node('refA', { parentId: 'b', type: 'reference', targetId: 'a' }),
  ]);
}

describe('buildVisualRows body/reference parity with flattenVisibleRows', () => {
  test('content/field ordering matches across nesting and reference transclusion', () => {
    const byId = fixture();
    const expanded = new Set<NodeId>(['a', 'b', 'refA']);
    const flat = flattenVisibleRows('lib', byId, expanded, new Set());
    const visual = visualRowNodeIds(buildVisualRows('lib', byId, { expanded }));
    expect(visual).toEqual(flat);
    // Sanity: the reference re-emits a's children.
    expect(flat).toEqual(['a', 'a1', 'a2', 'b', 'refA', 'a1', 'a2']);
  });

  test('matches when collapsed (no descent)', () => {
    const byId = fixture();
    const expanded = new Set<NodeId>();
    const flat = flattenVisibleRows('lib', byId, expanded, new Set());
    const visual = visualRowNodeIds(buildVisualRows('lib', byId, { expanded }));
    expect(visual).toEqual(flat);
    expect(flat).toEqual(['a', 'b']);
  });

  test('omits pending removals and their visible descendants without changing the projection', () => {
    const byId = fixture();
    const rows = buildVisualRows('lib', byId, {
      expanded: new Set(['a']),
      pendingRemovalIds: new Set(['a']),
    });

    expect(visualRowNodeIds(rows)).toEqual(['b']);
    expect(byId.get('lib')?.children).toEqual(['a', 'b']);
    expect(byId.has('a')).toBe(true);
  });

  test('field values stay in selectable order but render inside their field row', () => {
    const byId = byIdOf([
      node('root', { children: ['before', 'entry', 'after'] }),
      node('before', { parentId: 'root' }),
      node('field-def', { type: 'fieldDef' }),
      node('entry', {
        parentId: 'root',
        type: 'fieldEntry',
        fieldDefId: 'field-def',
        children: ['value-a', 'value-b'],
      }),
      node('value-a', { parentId: 'entry' }),
      node('value-b', { parentId: 'entry' }),
      node('after', { parentId: 'root' }),
    ]);
    const flat = flattenVisibleRows('root', byId, new Set(), new Set());
    const visual = visualRowNodeIds(buildVisualRows('root', byId, { expanded: new Set() }));
    const selectable = buildSelectableRows('root', byId, { expanded: new Set() }).map((row) => row.id);

    expect(selectable).toEqual(['before', 'entry', 'value-a', 'value-b', 'after']);
    expect(flat).toEqual(['before', 'entry', 'after']);
    expect(visual).toEqual(['before', 'entry', 'after']);
  });
});

describe('buildVisualRows depth and extras', () => {
  test('assigns cumulative depth down the tree and through references', () => {
    const byId = fixture();
    const rows = buildVisualRows('lib', byId, { expanded: new Set(['a', 'b', 'refA']) });
    const depthOf = (key: string) => rows.find((r) => r.key === key)?.depth;
    expect(depthOf('a')).toBe(0);
    expect(depthOf('a1')).toBe(1);
    expect(depthOf('b')).toBe(0);
    expect(depthOf('refA')).toBe(1);
    // Transcluded children sit one level below the reference row; the key is the
    // chain of rendered row ids (the reference row), not the resolved target.
    expect(depthOf('lib>b>refA>a1')).toBe(2);
  });

  test('emits a trailing draft row at the root when requested', () => {
    const byId = fixture();
    const rows = buildVisualRows('lib', byId, {
      expanded: new Set(),
      rootTrailingDraft: 'always',
      draftIdFor: (parentId) => (parentId === 'lib' ? 'draft-lib' : null),
    });
    const last = rows[rows.length - 1];
    expect(last.kind).toBe('content');
    expect(last).toMatchObject({ nodeId: 'draft-lib', draft: true, depth: 0 });
    // The draft is not part of the canonical node ordering.
    expect(visualRowNodeIds(rows)).toEqual(['a', 'b']);
  });

  test('expanded attachment rows emit their first-child trailing draft', () => {
    const byId = byIdOf([
      node('lib', { children: ['file'] }),
      node('file', { parentId: 'lib', type: 'attachment' } as Partial<NodeProjection>),
    ]);
    const rows = buildVisualRows('lib', byId, {
      expanded: new Set(['file']),
      draftIdFor: (parentId) => (parentId === 'file' ? 'draft-file' : null),
    });

    expect(rows.map((row) => (row.kind === 'content' ? row.nodeId : row.kind))).toEqual(['file', 'draft-file']);
    expect(rows.find((row) => row.kind === 'content' && row.draft)).toMatchObject({
      nodeId: 'draft-file',
      parentId: 'file',
      depth: 1,
    });
    expect(visualRowNodeIds(rows)).toEqual(['file']);
  });

  test('trailing draft is keyed by its id so it survives materialization', () => {
    const draftId = 'node:draft1';
    const before = buildVisualRows('lib', fixture(), {
      expanded: new Set(),
      rootTrailingDraft: 'always',
      draftIdFor: () => draftId,
    });
    const draftRow = before[before.length - 1];
    expect(draftRow).toMatchObject({ kind: 'content', nodeId: draftId, draft: true });

    // Once the draft materializes it is a real last child under the same id; its
    // content row must carry the identical key so React keeps the same component
    // (and its editor) mounted across materialization.
    const materialized = byIdOf([
      node('lib', { children: ['a', 'b', draftId] }),
      node('a', { parentId: 'lib', children: ['a1', 'a2'] }),
      node('a1', { parentId: 'a' }),
      node('a2', { parentId: 'a' }),
      node('b', { parentId: 'lib', children: ['refA'] }),
      node('refA', { parentId: 'b', type: 'reference', targetId: 'a' }),
      node(draftId, { parentId: 'lib' }),
    ]);
    const after = buildVisualRows('lib', materialized, {
      expanded: new Set(),
      rootTrailingDraft: 'none',
      draftIdFor: () => null,
    });
    const realRow = after.find((r) => (r.kind === 'content') && r.nodeId === draftId);
    expect(realRow?.key).toBe(draftRow.key);
  });

  test('owned row keys stay stable across reparenting', () => {
    const beforeById = byIdOf([
      node('lib', { children: ['a', 'b'] }),
      node('a', { parentId: 'lib' }),
      node('b', { parentId: 'lib' }),
    ]);
    const before = buildVisualRows('lib', beforeById, { expanded: new Set() });
    const afterById = byIdOf([
      node('lib', { children: ['b'] }),
      node('a', { parentId: 'b' }),
      node('b', { parentId: 'lib', children: ['a'] }),
    ]);
    const after = buildVisualRows('lib', afterById, { expanded: new Set(['b']) });

    expect(before.find((row) => row.kind === 'content' && row.nodeId === 'a')?.key).toBe('a');
    expect(after.find((row) => row.kind === 'content' && row.nodeId === 'a')?.key).toBe('a');
  });

  test('transcluded row keys remain path-qualified and unique', () => {
    const rows = buildVisualRows('lib', fixture(), {
      expanded: new Set(['a', 'b', 'refA']),
    });
    const a1Keys = rows
      .filter((row) => row.kind === 'content' && row.nodeId === 'a1')
      .map((row) => row.key);

    expect(a1Keys).toEqual(['a1', 'lib>b>refA>a1']);
    expect(new Set(a1Keys).size).toBe(2);
  });

  test('places a relocated trailing draft after the anchored child subtree', () => {
    const rows = buildVisualRows('lib', fixture(), {
      expanded: new Set(['a']),
      rootTrailingDraft: 'always',
      draftIdFor: (parentId) => (parentId === 'lib' ? 'draft-after-a' : null),
      trailingDraftPlacement: { parentId: 'lib', afterId: 'a', panelId: 'panel' },
    });

    expect(rows.map((row) => (row.kind === 'content' ? row.nodeId : row.kind))).toEqual([
      'a',
      'a1',
      'a2',
      'draft-after-a',
      'b',
    ]);
    expect(rows.find((row) => row.kind === 'content' && row.draft)).toMatchObject({
      nodeId: 'draft-after-a',
      depth: 0,
      afterId: 'a',
    });
    expect(visualRowNodeIds(rows)).toEqual(['a', 'a1', 'a2', 'b']);
  });

  test('emits a toolbar row (owned by the parent) when a nested view has its toolbar visible', () => {
    // toolbarVisible is read from a viewDef child node, not the node itself.
    const byId = byIdOf([
      node('lib', { children: ['view'] }),
      node('view', { parentId: 'lib', children: ['vd', 'c1'] }),
      node('vd', { parentId: 'view', type: 'viewDef', toolbarVisible: true } as Partial<NodeProjection>),
      node('c1', { parentId: 'view' }),
    ]);
    const rows = buildVisualRows('lib', byId, { expanded: new Set(['view']) });
    const toolbar = rows.find((r) => r.kind === 'toolbar' && r.nodeId === 'view');
    expect(toolbar).toMatchObject({ depth: 1, indentDepth: 0 });
  });

  test('keeps filtered-out rows collapsed until their disclosure is expanded', () => {
    const byId = byIdOf([
      node('lib', { children: ['view', 'done', 'todo'] }),
      node('view', {
        parentId: 'lib',
        type: 'viewDef',
        children: ['filter'],
      } as Partial<NodeProjection>),
      node('filter', {
        parentId: 'view',
        type: 'filterRule',
        filterField: 'sys:done',
        filterOperator: 'is',
        filterValues: ['true'],
      } as Partial<NodeProjection>),
      node('done', { parentId: 'lib', completedAt: 1000 }),
      node('todo', { parentId: 'lib', completedAt: 0 }),
    ]);

    const collapsed = buildVisualRows('lib', byId, { expanded: new Set() });
    expect(collapsed.map((row) => row.kind)).toEqual(['content', 'filteredOut']);
    expect(collapsed.find((row) => row.kind === 'filteredOut')).toMatchObject({
      id: 'filtered:lib:filter',
      count: 1,
      expanded: false,
    });
    expect(visualRowNodeIds(collapsed)).toEqual(['done']);

    const expanded = buildVisualRows('lib', byId, { expanded: new Set(['filtered:lib:filter']) });
    expect(expanded.map((row) => row.kind)).toEqual(['content', 'filteredOut', 'content']);
    expect(visualRowNodeIds(expanded)).toEqual(['done', 'todo']);
    expect(flattenVisibleRows('lib', byId, new Set(), new Set())).toEqual(['done']);
    expect(flattenVisibleRows('lib', byId, new Set(['filtered:lib:filter']), new Set())).toEqual(['done', 'todo']);
    expect(buildSelectableRows('lib', byId, { expanded: new Set(['filtered:lib:filter']) }).map((row) => row.id))
      .toEqual(['done', 'todo']);
  });

  test('root toolbar can be suppressed with showRootToolbar=false', () => {
    const byId = byIdOf([
      node('lib', { children: ['vd'] }),
      node('vd', { parentId: 'lib', type: 'viewDef', toolbarVisible: true } as Partial<NodeProjection>),
    ]);
    const withToolbar = buildVisualRows('lib', byId, { expanded: new Set() });
    const without = buildVisualRows('lib', byId, { expanded: new Set(), showRootToolbar: false });
    expect(withToolbar.some((r) => r.kind === 'toolbar')).toBe(true);
    expect(withToolbar.find((r) => r.kind === 'toolbar')).toMatchObject({ depth: 0, indentDepth: 0 });
    expect(without.some((r) => r.kind === 'toolbar')).toBe(false);
  });

  test('emits one compact-control host for a search even before toolbarVisible is persisted', () => {
    const byId = byIdOf([
      node('search', { type: 'search', children: ['result'] } as Partial<NodeProjection>),
      node('result', { parentId: 'search', type: 'reference', targetId: 'target' }),
      node('target'),
    ]);

    const rows = buildVisualRows('search', byId, { expanded: new Set() });
    expect(rows.filter((row) => row.kind === 'toolbar')).toHaveLength(1);
    expect(rows.find((row) => row.kind === 'toolbar')).toMatchObject({ nodeId: 'search', depth: 0 });
  });

  test('emits compact controls for an expanded empty nested search', () => {
    const byId = byIdOf([
      node('lib', { children: ['search'] }),
      node('search', { parentId: 'lib', type: 'search' } as Partial<NodeProjection>),
    ]);

    const rows = buildVisualRows('lib', byId, { expanded: new Set(['search']) });

    expect(rows.map((row) => row.kind)).toEqual(['content', 'toolbar']);
    expect(rows[1]).toMatchObject({ nodeId: 'search', depth: 1 });
  });

  test('emits one independently rendered table scope instead of flattening its descendants', () => {
    const byId = byIdOf([
      node('lib', { children: ['project'] }),
      node('project', { parentId: 'lib', children: ['project-view', 'task-a', 'task-b'] }),
      node('project-view', {
        parentId: 'project',
        type: 'viewDef',
        viewMode: 'table',
      } as Partial<NodeProjection>),
      node('task-a', { parentId: 'project' }),
      node('task-b', { parentId: 'project' }),
    ]);

    const rows = buildVisualRows('lib', byId, { expanded: new Set(['project']) });

    expect(rows.map((row) => row.kind)).toEqual(['content', 'table']);
    expect(rows[1]).toMatchObject({
      kind: 'table',
      nodeId: 'project',
      parentId: 'project',
      depth: 1,
      referencePath: ['lib', 'project'],
    });
    expect(visualRowNodeIds(rows)).toEqual(['project']);
  });
});

describe('buildVisualRowsIncrementally', () => {
  const expanded = new Set<NodeId>();
  const options = { expanded };

  function seed(nodes: NodeProjection[]) {
    return reduceProjection(null, {
      kind: 'full',
      revision: 1,
      projection: projection(nodes),
    })!;
  }

  function rebuild(
    previous: VisualRowsSnapshot | null,
    state: NonNullable<ReturnType<typeof reduceProjection>>,
  ) {
    return buildVisualRowsIncrementally(previous, 'lib', state.index, {
      ...options,
      systemFieldContext: { referenceSummary: state.index.referenceSummary },
    });
  }

  test('reuses the row model for a text edit in a plain list', () => {
    const lib = node('lib', { children: ['a', 'b'] });
    const a = node('a', { parentId: 'lib', content: { text: 'A', marks: [], inlineRefs: [] } });
    const b = node('b', { parentId: 'lib', content: { text: 'B', marks: [], inlineRefs: [] } });
    const trash = node('trash');
    const firstState = seed([lib, a, b, trash]);
    const first = rebuild(null, firstState);
    const editedA = {
      ...a,
      updatedAt: 2,
      content: { ...a.content, text: 'A edited' },
    };
    const secondState = reduceProjection(firstState, delta(2, [editedA]))!;
    const second = rebuild(first, secondState);

    expect(second.rows).toBe(first.rows);
    expect(second.rows).toEqual(buildVisualRows('lib', secondState.index.byId, options));
  });

  test('reuses the row model when a plain-list field value changes', () => {
    const lib = node('lib', { children: ['entry'] });
    const entry = node('entry', {
      parentId: 'lib',
      type: 'fieldEntry',
      fieldDefId: 'field',
      children: ['value'],
      content: { text: '', marks: [], inlineRefs: [] },
    });
    const value = node('value', {
      parentId: 'entry',
      content: { text: 'Before', marks: [], inlineRefs: [] },
    });
    const field = node('field', { type: 'fieldDef' });
    const trash = node('trash');
    const firstState = seed([lib, entry, value, field, trash]);
    const first = rebuild(null, firstState);
    const changedValue = {
      ...value,
      content: { ...value.content, text: 'After' },
      updatedAt: 2,
    };
    const secondState = reduceProjection(firstState, delta(2, [changedValue]))!;
    const second = rebuild(first, secondState);

    expect(second.rows).toBe(first.rows);
    expect(second.rows).toEqual(buildVisualRows('lib', secondState.index.byId, options));
  });

  test('rebuilds when an owner gains a projected tag without changing children', () => {
    const lib = node('lib', { children: ['body'] });
    const body = node('body', { parentId: 'lib' });
    const schema = node('schema', { children: ['tag', 'field-def'] });
    const tag = node('tag', {
      parentId: 'schema',
      type: 'tagDef',
      children: ['template-entry'],
    });
    const templateEntry = node('template-entry', {
      parentId: 'tag',
      type: 'fieldEntry',
      fieldDefId: 'field-def',
    });
    const fieldDef = node('field-def', { parentId: 'schema', type: 'fieldDef' });
    const trash = node('trash');
    const firstState = seed([lib, body, schema, tag, templateEntry, fieldDef, trash]);
    const first = rebuild(null, firstState);
    const taggedLib = { ...lib, tags: ['tag'], updatedAt: 2 };
    const secondState = reduceProjection(firstState, delta(2, [taggedLib]))!;
    const second = rebuild(first, secondState);

    expect(second.rows).not.toBe(first.rows);
    expect(second.rows.map((row) => row.kind)).toEqual(['field', 'content']);
    expect(second.rows).toEqual(buildVisualRows('lib', secondState.index.byId, options));
  });

  test('rebuilds when a stored field entry is relinked without changing structure', () => {
    const lib = node('lib', { children: ['entry'] });
    const entry = node('entry', {
      parentId: 'lib',
      type: 'fieldEntry',
      fieldDefId: 'field-a',
    });
    const fieldA = node('field-a', { type: 'fieldDef' });
    const fieldB = node('field-b', { type: 'fieldDef' });
    const trash = node('trash');
    const firstState = seed([lib, entry, fieldA, fieldB, trash]);
    const first = rebuild(null, firstState);
    const relinkedEntry = { ...entry, fieldDefId: 'field-b', updatedAt: 2 };
    const secondState = reduceProjection(firstState, delta(2, [relinkedEntry]))!;
    const second = rebuild(first, secondState);

    expect(second.rows).not.toBe(first.rows);
    expect(second.rows[0]).toMatchObject({
      kind: 'field',
      slot: { fieldDefId: 'field-b' },
    });
    expect(second.rows).toEqual(buildVisualRows('lib', secondState.index.byId, options));
  });

  test('rebuilds a modeled projected field row when its stored value changes', () => {
    const lib = node('lib', {
      children: ['view', 'entry'],
      tags: ['tag'],
    });
    const view = node('view', {
      parentId: 'lib',
      type: 'viewDef',
      children: ['filter'],
    });
    const filter = node('filter', {
      parentId: 'view',
      type: 'filterRule',
      filterField: 'sys:name',
      filterOperator: 'contains',
      filterValueLogic: 'any',
      filterValues: ['Keep'],
    });
    const tag = node('tag', {
      type: 'tagDef',
      children: ['template'],
    });
    const template = node('template', {
      parentId: 'tag',
      type: 'fieldEntry',
      fieldDefId: 'field',
    });
    const field = node('field', { type: 'fieldDef' });
    const entry = node('entry', {
      parentId: 'lib',
      type: 'fieldEntry',
      fieldDefId: 'field',
      children: ['value'],
      content: { text: '', marks: [], inlineRefs: [] },
    });
    const value = node('value', {
      parentId: 'entry',
      content: { text: 'Keep', marks: [], inlineRefs: [] },
    });
    const trash = node('trash');
    const firstState = seed([lib, view, filter, tag, template, field, entry, value, trash]);
    const first = rebuild(null, firstState);
    expect(first.rows.map((row) => row.kind)).toEqual(['field']);

    const changedValue = {
      ...value,
      content: { ...value.content, text: 'Drop' },
      updatedAt: 2,
    };
    const secondState = reduceProjection(firstState, delta(2, [changedValue]))!;
    const second = rebuild(first, secondState);

    expect(second.rows).not.toBe(first.rows);
    expect(second.rows.map((row) => row.kind)).toEqual(['filteredOut']);
    expect(second.rows).toEqual(buildVisualRows('lib', secondState.index.byId, options));
  });

  test('rebuilds with full parity when Name or Updated changes ordering', () => {
    const lib = node('lib', { children: ['view', 'a', 'b'] });
    const view = node('view', {
      parentId: 'lib',
      type: 'viewDef',
      children: ['sort-name', 'sort-updated'],
    });
    const sortName = node('sort-name', {
      parentId: 'view',
      type: 'sortRule',
      sortField: 'sys:name',
      sortDirection: 'asc',
    });
    const sortUpdated = node('sort-updated', {
      parentId: 'view',
      type: 'sortRule',
      sortField: 'sys:updatedAt',
      sortDirection: 'desc',
    });
    const a = node('a', {
      parentId: 'lib',
      content: { text: 'Zulu', marks: [], inlineRefs: [] },
      updatedAt: 1,
    });
    const b = node('b', {
      parentId: 'lib',
      content: { text: 'Alpha', marks: [], inlineRefs: [] },
      updatedAt: 2,
    });
    const trash = node('trash');
    const firstState = seed([lib, view, sortName, sortUpdated, a, b, trash]);
    const first = rebuild(null, firstState);
    const editedA = {
      ...a,
      updatedAt: 3,
      content: { ...a.content, text: 'Aardvark' },
    };
    const secondState = reduceProjection(firstState, delta(2, [editedA]))!;
    const second = rebuild(first, secondState);

    expect(second.rows).not.toBe(first.rows);
    expect(visualRowNodeIds(second.rows)).toEqual(['a', 'b']);
    expect(second.rows).toEqual(buildVisualRows('lib', secondState.index.byId, options));
  });

  test('keeps a custom-field view stable for unrelated text and rebuilds for a value edit', () => {
    const lib = node('lib', { children: ['view', 'a', 'b'] });
    const view = node('view', { parentId: 'lib', type: 'viewDef', children: ['sort'] });
    const sort = node('sort', {
      parentId: 'view',
      type: 'sortRule',
      sortField: 'priority',
      sortDirection: 'asc',
    });
    const fieldDef = node('priority', { type: 'fieldDef' });
    const a = node('a', {
      parentId: 'lib',
      children: ['a-entry'],
      content: { text: 'A', marks: [], inlineRefs: [] },
    });
    const aEntry = node('a-entry', {
      parentId: 'a',
      type: 'fieldEntry',
      fieldDefId: 'priority',
      children: ['a-value'],
    });
    const aValue = node('a-value', {
      parentId: 'a-entry',
      content: { text: '2', marks: [], inlineRefs: [] },
    });
    const b = node('b', { parentId: 'lib', children: ['b-entry'] });
    const bEntry = node('b-entry', {
      parentId: 'b',
      type: 'fieldEntry',
      fieldDefId: 'priority',
      children: ['b-value'],
    });
    const bValue = node('b-value', {
      parentId: 'b-entry',
      content: { text: '1', marks: [], inlineRefs: [] },
    });
    const trash = node('trash');
    const firstState = seed([
      lib, view, sort, fieldDef, a, aEntry, aValue, b, bEntry, bValue, trash,
    ]);
    const first = rebuild(null, firstState);
    expect(visualRowNodeIds(first.rows)).toEqual(['b', 'a']);

    const renamedA = {
      ...a,
      updatedAt: 2,
      content: { ...a.content, text: 'A renamed' },
    };
    const renamedState = reduceProjection(firstState, delta(2, [renamedA]))!;
    const renamed = rebuild(first, renamedState);
    expect(renamed.rows).toBe(first.rows);

    const changedValue = {
      ...aValue,
      updatedAt: 3,
      content: { ...aValue.content, text: '0' },
    };
    const valueState = reduceProjection(renamedState, delta(3, [changedValue]))!;
    const valueSnapshot = rebuild(renamed, valueState);
    expect(valueSnapshot.rows).not.toBe(renamed.rows);
    expect(visualRowNodeIds(valueSnapshot.rows)).toEqual(['a', 'b']);
    expect(valueSnapshot.rows).toEqual(buildVisualRows('lib', valueState.index.byId, options));
  });

  test('matches a full rebuild when typing changes custom-field sort, filter, and group results', () => {
    const lib = node('lib', { children: ['view', 'a', 'b'] });
    const view = node('view', {
      parentId: 'lib',
      type: 'viewDef',
      children: ['sort', 'filter'],
      groupField: 'status',
    });
    const sort = node('sort', {
      parentId: 'view',
      type: 'sortRule',
      sortField: 'status',
      sortDirection: 'asc',
    });
    const filter = node('filter', {
      parentId: 'view',
      type: 'filterRule',
      filterField: 'status',
      filterOperator: 'contains',
      filterValueLogic: 'any',
      filterValues: ['keep'],
    });
    const fieldDef = node('status', { type: 'fieldDef' });
    const a = node('a', { parentId: 'lib', children: ['a-entry'] });
    const aEntry = node('a-entry', {
      parentId: 'a',
      type: 'fieldEntry',
      fieldDefId: 'status',
      children: ['a-value'],
    });
    const aValue = node('a-value', {
      parentId: 'a-entry',
      content: { text: 'keep-b', marks: [], inlineRefs: [] },
    });
    const b = node('b', { parentId: 'lib', children: ['b-entry'] });
    const bEntry = node('b-entry', {
      parentId: 'b',
      type: 'fieldEntry',
      fieldDefId: 'status',
      children: ['b-value'],
    });
    const bValue = node('b-value', {
      parentId: 'b-entry',
      content: { text: 'drop', marks: [], inlineRefs: [] },
    });
    const trash = node('trash');
    const firstState = seed([
      lib, view, sort, filter, fieldDef, a, aEntry, aValue, b, bEntry, bValue, trash,
    ]);
    const first = rebuild(null, firstState);
    expect(visualRowNodeIds(first.rows)).toEqual(['a']);
    expect(first.rows.filter((row) => row.kind === 'group').map((row) => row.label))
      .toEqual(['keep-b']);

    const changedValue = {
      ...bValue,
      updatedAt: 2,
      content: { ...bValue.content, text: 'keep-a' },
    };
    const secondState = reduceProjection(firstState, delta(2, [changedValue]))!;
    const second = rebuild(first, secondState);

    expect(second.rows).not.toBe(first.rows);
    expect(visualRowNodeIds(second.rows)).toEqual(['b', 'a']);
    expect(second.rows.filter((row) => row.kind === 'group').map((row) => row.label))
      .toEqual(['keep-a', 'keep-b']);
    expect(second.rows).toEqual(buildVisualRows('lib', secondState.index.byId, options));
  });

  test('reorders a Name view when a reference target is renamed', () => {
    const lib = node('lib', { children: ['view', 'ref-a', 'ref-b'] });
    const view = node('view', { parentId: 'lib', type: 'viewDef', children: ['sort'] });
    const sort = node('sort', {
      parentId: 'view',
      type: 'sortRule',
      sortField: 'sys:name',
      sortDirection: 'asc',
    });
    const refA = node('ref-a', { parentId: 'lib', type: 'reference', targetId: 'target-a' });
    const refB = node('ref-b', { parentId: 'lib', type: 'reference', targetId: 'target-b' });
    const targetA = node('target-a', { content: { text: 'Zulu', marks: [], inlineRefs: [] } });
    const targetB = node('target-b', { content: { text: 'Beta', marks: [], inlineRefs: [] } });
    const trash = node('trash');
    const firstState = seed([lib, view, sort, refA, refB, targetA, targetB, trash]);
    const first = rebuild(null, firstState);
    expect(visualRowNodeIds(first.rows)).toEqual(['ref-b', 'ref-a']);

    const renamedTarget = {
      ...targetA,
      updatedAt: 2,
      content: { ...targetA.content, text: 'Alpha' },
    };
    const secondState = reduceProjection(firstState, delta(2, [renamedTarget]))!;
    const second = rebuild(first, secondState);
    expect(visualRowNodeIds(second.rows)).toEqual(['ref-a', 'ref-b']);
    expect(second.rows).toEqual(buildVisualRows('lib', secondState.index.byId, options));
  });
});
