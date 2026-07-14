import { describe, expect, test } from 'bun:test';
import type { NodeId, NodeProjection } from '../../src/core/types';
import { OWNER_FIELD } from '../../src/core/systemFields';
import { flattenVisibleRows } from '../../src/renderer/state/document';
import {
  buildSelectableRows,
  resolveSelectableReferenceTargetId,
  selectableChildParentId,
} from '../../src/renderer/state/selectableRows';

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

function rowIds(rows: ReturnType<typeof buildSelectableRows>): NodeId[] {
  return rows.map((row) => row.id);
}

describe('buildSelectableRows', () => {
  test('adds field values to panel selection order without changing visible flattening', () => {
    const byId = byIdOf([
      node('root', { children: ['before', 'entry', 'after'] }),
      node('before', { parentId: 'root' }),
      node('entry', { parentId: 'root', type: 'fieldEntry', children: ['value-a', 'value-b'] }),
      node('value-a', { parentId: 'entry' }),
      node('value-b', { parentId: 'entry' }),
      node('after', { parentId: 'root' }),
    ]);
    const expanded = new Set<NodeId>();

    expect(rowIds(buildSelectableRows('root', byId, { expanded }))).toEqual([
      'before',
      'entry',
      'value-a',
      'value-b',
      'after',
    ]);
    expect(flattenVisibleRows('root', byId, expanded)).toEqual([
      'before',
      'entry',
      'after',
    ]);
    expect(rowIds(buildSelectableRows('entry', byId, { expanded }))).toEqual(['value-a', 'value-b']);
  });

  test('classifies field rows and stored value rows with explicit policies', () => {
    const byId = byIdOf([
      node('root', { children: ['entry'] }),
      node('entry', { parentId: 'root', type: 'fieldEntry', children: ['value'] }),
      node('value', { parentId: 'entry' }),
    ]);

    const rootRows = buildSelectableRows('root', byId, { expanded: new Set() });
    expect(rootRows[0]).toMatchObject({
      id: 'entry',
      kind: 'fieldEntry',
      stored: true,
      mutable: true,
      actionPolicy: {
        delete: 'node-trash',
        move: 'node-reorder',
        duplicate: 'node-clone',
      },
    });

    expect(rootRows[1]).toMatchObject({
      id: 'value',
      parentId: 'entry',
      panelRootId: 'root',
      kind: 'fieldValue',
      stored: true,
      mutable: true,
      actionPolicy: {
        delete: 'field-value-remove',
        move: 'node-reorder',
        duplicate: 'node-clone',
      },
    });

    const valueRows = buildSelectableRows('entry', byId, { expanded: new Set() });
    expect(valueRows[0]).toMatchObject({
      id: 'value',
      parentId: 'entry',
      panelRootId: 'entry',
      kind: 'fieldValue',
    });
  });

  test('classifies a direct nested field entry by its owning field-value boundary', () => {
    const byId = byIdOf([
      node('root', { children: ['entry'] }),
      node('entry', { parentId: 'root', type: 'fieldEntry', children: ['nested-entry'] }),
      node('nested-entry', {
        parentId: 'entry',
        type: 'fieldEntry',
        children: ['nested-value'],
      }),
      node('nested-value', { parentId: 'nested-entry' }),
    ]);

    const rows = buildSelectableRows('root', byId, { expanded: new Set() });

    expect(rowIds(rows)).toEqual(['entry', 'nested-entry', 'nested-value']);
    expect(rows[1]).toMatchObject({
      id: 'nested-entry',
      parentId: 'entry',
      kind: 'fieldValue',
      actionPolicy: { delete: 'field-value-remove' },
    });
    expect(rows[2]).toMatchObject({
      id: 'nested-value',
      parentId: 'nested-entry',
      kind: 'fieldValue',
    });
  });

  test('treats expanded field value descendants as ordinary content rows', () => {
    const byId = byIdOf([
      node('root', { children: ['entry'] }),
      node('entry', { parentId: 'root', type: 'fieldEntry', children: ['value'] }),
      node('value', { parentId: 'entry', children: ['child'] }),
      node('child', { parentId: 'value', children: ['grandchild'] }),
      node('grandchild', { parentId: 'child' }),
    ]);

    const rows = buildSelectableRows('root', byId, {
      expanded: new Set(['value', 'child']),
    });

    expect(rowIds(rows)).toEqual(['entry', 'value', 'child', 'grandchild']);
    expect(rows[1]).toMatchObject({
      id: 'value',
      kind: 'fieldValue',
      parentId: 'entry',
      actionPolicy: { delete: 'field-value-remove' },
    });
    expect(rows[2]).toMatchObject({
      id: 'child',
      kind: 'content',
      parentId: 'value',
      actionPolicy: { delete: 'node-trash' },
    });
    expect(rows[3]).toMatchObject({
      id: 'grandchild',
      kind: 'content',
      parentId: 'child',
    });
  });

  test('marks synthetic system reference values as read-only presentation rows', () => {
    const sysrefId = 'sysref:entry:target';
    const byId = byIdOf([
      node('entry', { type: 'fieldEntry', children: [sysrefId] }),
      node('target'),
      node(sysrefId, {
        parentId: 'entry',
        type: 'reference',
        targetId: 'target',
        locked: true,
      }),
    ]);

    expect(buildSelectableRows('entry', byId, { expanded: new Set() })).toEqual([{
      id: sysrefId,
      parentId: 'entry',
      panelRootId: 'entry',
      kind: 'syntheticSystemValue',
      stored: false,
      mutable: false,
      actionPolicy: {
        delete: 'disabled',
        move: 'disabled',
        duplicate: 'disabled',
        tag: 'disabled',
        checkbox: 'disabled',
      },
    }]);
  });

  test('synthesizes system reference rows for the global selectable order', () => {
    const sysrefId = 'sysref:entry:parent';
    const byId = byIdOf([
      node('parent', { children: ['root'] }),
      node('root', { parentId: 'parent', children: ['entry', 'after'] }),
      node('entry', { parentId: 'root', type: 'fieldEntry', fieldDefId: OWNER_FIELD }),
      node('after', { parentId: 'root' }),
    ]);

    const rows = buildSelectableRows('root', byId, { expanded: new Set() });

    expect(rowIds(rows)).toEqual(['entry', sysrefId, 'after']);
    expect(rows[1]).toMatchObject({
      id: sysrefId,
      parentId: 'entry',
      panelRootId: 'root',
      kind: 'syntheticSystemValue',
      stored: false,
      mutable: false,
      actionPolicy: {
        delete: 'disabled',
        move: 'disabled',
        duplicate: 'disabled',
        tag: 'disabled',
        checkbox: 'disabled',
      },
    });
  });

  test('uses the existing reference target resolution and cycle guard behavior', () => {
    const byId = byIdOf([
      node('root', { children: ['ancestor'] }),
      node('ancestor', { parentId: 'root', children: ['child'] }),
      node('child', { parentId: 'ancestor', children: ['ref'] }),
      node('ref', { parentId: 'child', type: 'reference', targetId: 'ancestor' }),
    ]);

    expect(selectableChildParentId('ref', byId)).toBe('ancestor');
    expect(resolveSelectableReferenceTargetId('ref', byId)).toBe('ancestor');
    expect(rowIds(buildSelectableRows('root', byId, {
      expanded: new Set(['ancestor', 'child', 'ref']),
    }))).toEqual(['ancestor', 'child', 'ref']);
  });
});
