import { describe, expect, test } from 'bun:test';
import type { NodeId, NodeProjection } from '../../src/core/types';
import { flattenVisibleRows } from '../../src/renderer/state/document';
import { buildSelectableRows } from '../../src/renderer/state/selectableRows';
import { buildVisualRows, visualRowNodeIds } from '../../src/renderer/state/visualRows';

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

  test('field values stay in selectable order but render inside their field row', () => {
    const byId = byIdOf([
      node('root', { children: ['before', 'entry', 'after'] }),
      node('before', { parentId: 'root' }),
      node('entry', { parentId: 'root', type: 'fieldEntry', children: ['value-a', 'value-b'] }),
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
    expect(depthOf('lib>a')).toBe(0);
    expect(depthOf('lib>a>a1')).toBe(1);
    expect(depthOf('lib>b')).toBe(0);
    expect(depthOf('lib>b>refA')).toBe(1);
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
    expect(rows.some((r) => r.kind === 'toolbar' && r.nodeId === 'view')).toBe(true);
  });

  test('root toolbar can be suppressed with showRootToolbar=false', () => {
    const byId = byIdOf([
      node('lib', { children: ['vd'] }),
      node('vd', { parentId: 'lib', type: 'viewDef', toolbarVisible: true } as Partial<NodeProjection>),
    ]);
    const withToolbar = buildVisualRows('lib', byId, { expanded: new Set() });
    const without = buildVisualRows('lib', byId, { expanded: new Set(), showRootToolbar: false });
    expect(withToolbar.some((r) => r.kind === 'toolbar')).toBe(true);
    expect(without.some((r) => r.kind === 'toolbar')).toBe(false);
  });
});
