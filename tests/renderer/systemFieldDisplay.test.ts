import { describe, expect, test } from 'bun:test';
import type { NodeId, NodeProjection } from '../../src/renderer/api/types';
import { nodeReferenceTarget } from '../../src/renderer/api/types';
import {
  CREATED_FIELD,
  DAY_FIELD,
  DONE_FIELD,
  OWNER_FIELD,
  REF_COUNT_FIELD,
  TAGS_FIELD,
  systemFieldDisplay,
  systemFieldValues,
} from '../../src/core/systemFields';
import { TRASH_ID } from '../../src/core/types';

function node(partial: Partial<NodeProjection> & { id: string }): NodeProjection {
  return {
    type: 'node',
    content: { text: '', inlineRefs: [] },
    children: [],
    tags: [],
    ...partial,
  } as unknown as NodeProjection;
}

function byId(...nodes: NodeProjection[]): Map<NodeId, NodeProjection> {
  return new Map(nodes.map((n) => [n.id, n]));
}

describe('systemFieldDisplay', () => {
  test('Done is a boolean checkbox derived from completedAt', () => {
    const map = byId(node({ id: 'task', completedAt: 1_800_000_000_000 }));
    expect(systemFieldDisplay(map.get('task')!, DONE_FIELD, map)).toEqual({ kind: 'done', checked: true });

    const undone = byId(node({ id: 'task', completedAt: 0 }));
    expect(systemFieldDisplay(undone.get('task')!, DONE_FIELD, undone)).toEqual({ kind: 'done', checked: false });
  });

  test('Created renders as a formatted date', () => {
    const map = byId(node({ id: 'n', createdAt: Date.UTC(2026, 5, 1) } as Partial<NodeProjection> & { id: string }));
    const display = systemFieldDisplay(map.get('n')!, CREATED_FIELD, map);
    expect(display.kind).toBe('date');
    expect(display.kind === 'date' && display.text).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('Tags returns the owner applied tag ids', () => {
    const map = byId(node({ id: 'n', tags: ['tag-a', 'tag-b'] }), node({ id: 'tag-a' }), node({ id: 'tag-b' }));
    expect(systemFieldDisplay(map.get('n')!, TAGS_FIELD, map)).toEqual({ kind: 'tags', tagIds: ['tag-a', 'tag-b'] });
  });

  test('Owner resolves to the parent node as a navigable ref', () => {
    const map = byId(
      node({ id: 'parent', content: { text: 'Project X', inlineRefs: [] } as NodeProjection['content'] }),
      node({ id: 'child', parentId: 'parent' } as Partial<NodeProjection> & { id: string }),
    );
    expect(systemFieldDisplay(map.get('child')!, OWNER_FIELD, map)).toEqual({
      kind: 'nodeRefs',
      refs: [{ id: 'parent', label: 'Project X' }],
    });
  });

  test('Day resolves to the nearest "day"-tagged ancestor', () => {
    const map = byId(
      node({ id: 'day-tag', content: { text: 'day', inlineRefs: [] } as NodeProjection['content'] }),
      node({
        id: 'day',
        content: { text: '2026-06-01', inlineRefs: [] } as NodeProjection['content'],
        tags: ['day-tag'],
      }),
      node({ id: 'task', parentId: 'day' } as Partial<NodeProjection> & { id: string }),
      node({ id: 'sub', parentId: 'task' } as Partial<NodeProjection> & { id: string }),
    );
    // Walks up through `task` to the day node.
    expect(systemFieldDisplay(map.get('sub')!, DAY_FIELD, map)).toEqual({
      kind: 'dayRef',
      nodeId: 'day',
      text: '2026-06-01',
    });
  });

  test('References surfaces the deduped backlink source nodes', () => {
    const map = byId(
      node({ id: 'target', content: { text: 'Target', inlineRefs: [] } as NodeProjection['content'] }),
      node({ id: 'source', content: { text: 'Mentions it', inlineRefs: [] } as NodeProjection['content'] }),
      node({ id: 'ref', type: 'reference', parentId: 'source', targetId: 'target' } as Partial<NodeProjection> & { id: string }),
    );
    expect(systemFieldDisplay(map.get('target')!, REF_COUNT_FIELD, map)).toEqual({
      kind: 'nodeRefs',
      refs: [{ id: 'source', label: 'Mentions it' }],
    });
  });

  test('a node with no backlinks yields an empty References ref list', () => {
    const map = byId(node({ id: 'lonely' }));
    expect(systemFieldDisplay(map.get('lonely')!, REF_COUNT_FIELD, map)).toEqual({ kind: 'nodeRefs', refs: [] });
  });
});

describe('systemFieldValues (sort/group/filter adapter)', () => {
  test('dates stay raw epoch-ms strings; Done is a boolean string', () => {
    const map = byId(node({ id: 'n', createdAt: 123, completedAt: 5 } as Partial<NodeProjection> & { id: string }));
    expect(systemFieldValues(map.get('n')!, CREATED_FIELD, map)).toEqual(['123']);
    expect(systemFieldValues(map.get('n')!, DONE_FIELD, map)).toEqual(['true']);
  });

  test('References reports its raw reference count, while the display dedupes sources', () => {
    // One source node references the target twice: count is 2, deduped sources is 1.
    const map = byId(
      node({ id: 'target' }),
      node({ id: 'source', content: { text: 'Src', inlineRefs: [] } as NodeProjection['content'] }),
      node({ id: 'r1', type: 'reference', parentId: 'source', targetId: 'target' } as Partial<NodeProjection> & { id: string }),
      node({ id: 'r2', type: 'reference', parentId: 'source', targetId: 'target' } as Partial<NodeProjection> & { id: string }),
    );
    expect(systemFieldValues(map.get('target')!, REF_COUNT_FIELD, map)).toEqual(['2']);
    const display = systemFieldDisplay(map.get('target')!, REF_COUNT_FIELD, map);
    expect(display.kind === 'nodeRefs' && display.refs).toEqual([{ id: 'source', label: 'Src' }]);
  });

  test('References counts inline and field-value references', () => {
    const map = byId(
      node({ id: 'target' }),
      node({
        id: 'inline-source',
        content: {
          text: 'Inline source',
          marks: [],
          inlineRefs: [{ offset: 0, target: nodeReferenceTarget('target') }],
        },
      }),
      node({ id: 'field-def', type: 'fieldDef', content: { text: 'Related', marks: [], inlineRefs: [] } } as Partial<NodeProjection> & { id: string }),
      node({ id: 'owner', children: ['field-entry'], content: { text: 'Owner', marks: [], inlineRefs: [] } }),
      node({ id: 'field-entry', type: 'fieldEntry', parentId: 'owner', fieldDefId: 'field-def', children: ['field-ref'] } as Partial<NodeProjection> & { id: string }),
      node({ id: 'field-ref', type: 'reference', parentId: 'field-entry', targetId: 'target', refRole: 'fieldValue' } as Partial<NodeProjection> & { id: string }),
    );

    expect(systemFieldValues(map.get('target')!, REF_COUNT_FIELD, map)).toEqual(['2']);
    const display = systemFieldDisplay(map.get('target')!, REF_COUNT_FIELD, map);
    expect(display.kind === 'nodeRefs' && display.refs).toEqual([
      { id: 'inline-source', label: 'Inline source' },
      { id: 'owner', label: 'Owner' },
    ]);
  });

  test('References ignores linked references from Trash', () => {
    const map = byId(
      node({ id: TRASH_ID, children: ['trashed-source'] }),
      node({ id: 'target', content: { text: 'Target', inlineRefs: [] } as NodeProjection['content'] }),
      node({
        id: 'active-source',
        children: ['active-ref'],
        content: { text: 'Active', inlineRefs: [] } as NodeProjection['content'],
      }),
      node({ id: 'active-ref', type: 'reference', parentId: 'active-source', targetId: 'target' } as Partial<NodeProjection> & { id: string }),
      node({
        id: 'trashed-source',
        parentId: TRASH_ID,
        children: ['trashed-ref'],
        content: { text: 'Trashed', inlineRefs: [] } as NodeProjection['content'],
      }),
      node({ id: 'trashed-ref', type: 'reference', parentId: 'trashed-source', targetId: 'target' } as Partial<NodeProjection> & { id: string }),
    );

    expect(systemFieldValues(map.get('target')!, REF_COUNT_FIELD, map)).toEqual(['1']);
    const display = systemFieldDisplay(map.get('target')!, REF_COUNT_FIELD, map);
    expect(display.kind === 'nodeRefs' && display.refs).toEqual([{ id: 'active-source', label: 'Active' }]);
  });
});
