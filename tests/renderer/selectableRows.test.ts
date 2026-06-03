import { describe, expect, test } from 'bun:test';
import type { NodeId, NodeProjection } from '../../src/core/types';
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
  test('is the panel-level projection behind flattenVisibleRows', () => {
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
      'value-a',
      'value-b',
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
