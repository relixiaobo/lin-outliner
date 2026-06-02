import { describe, expect, test } from 'bun:test';
import type { NodeId, NodeProjection } from '../../src/core/types';
import {
  collectChangedNodes,
  nextRevisions,
  nodeSignatures,
  propagateDirty,
} from '../../src/renderer/state/renderRev';

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
    ...patch,
  } as NodeProjection;
}

function byIdOf(nodes: NodeProjection[]): Map<NodeId, NodeProjection> {
  return new Map(nodes.map((n) => [n.id, n]));
}

// root > a > b > c, plus sibling a2 under root.
function tree(): Map<NodeId, NodeProjection> {
  return byIdOf([
    node('root', { children: ['a', 'a2'] }),
    node('a', { parentId: 'root', children: ['b'] }),
    node('a2', { parentId: 'root' }),
    node('b', { parentId: 'a', children: ['c'] }),
    node('c', { parentId: 'b' }),
  ]);
}

describe('collectChangedNodes', () => {
  test('reports every node on first build (no previous signatures)', () => {
    const sig = nodeSignatures(tree());
    expect(collectChangedNodes(null, sig)).toEqual(new Set(['root', 'a', 'a2', 'b', 'c']));
  });

  test('reports only the nodes whose serialized form differs', () => {
    const prev = nodeSignatures(tree());
    const mutated = tree();
    mutated.set('c', node('c', { parentId: 'b', content: { text: 'edited', marks: [], inlineRefs: [] } }));
    const next = nodeSignatures(mutated);
    expect(collectChangedNodes(prev, next)).toEqual(new Set(['c']));
  });

  test('reports a newly added node', () => {
    const prev = nodeSignatures(tree());
    const withNew = tree();
    withNew.set('d', node('d', { parentId: 'b' }));
    expect(collectChangedNodes(prev, nodeSignatures(withNew))).toEqual(new Set(['d']));
  });
});

describe('propagateDirty', () => {
  test('marks the changed node and its structural ancestors only', () => {
    const byId = tree();
    expect(propagateDirty(new Set(['c']), byId)).toEqual(new Set(['c', 'b', 'a', 'root']));
  });

  test('leaves unrelated branches untouched', () => {
    const byId = tree();
    const affected = propagateDirty(new Set(['c']), byId);
    expect(affected.has('a2')).toBe(false);
  });

  test('empty input yields an empty set without walking', () => {
    expect(propagateDirty(new Set(), tree()).size).toBe(0);
  });

  test('a changed reference target re-renders the reference row and its ancestors', () => {
    // root > host > ref(->target); target lives under root2 elsewhere.
    const byId = byIdOf([
      node('root', { children: ['host'] }),
      node('host', { parentId: 'root', children: ['ref'] }),
      node('ref', { parentId: 'host', type: 'reference', targetId: 'target' }),
      node('root2', { children: ['target'] }),
      node('target', { parentId: 'root2' }),
    ]);
    const affected = propagateDirty(new Set(['target']), byId);
    expect(affected.has('ref')).toBe(true);
    expect(affected.has('host')).toBe(true);
    expect(affected.has('root')).toBe(true);
  });

  test('a changed tag definition re-renders every node carrying that tag', () => {
    const byId = byIdOf([
      node('root', { children: ['x', 'schema'] }),
      node('x', { parentId: 'root', tags: ['tag1'] }),
      node('schema', { parentId: 'root', children: ['tag1'] }),
      node('tag1', { parentId: 'schema', type: 'tagDef' }),
    ]);
    const affected = propagateDirty(new Set(['tag1']), byId);
    expect(affected.has('x')).toBe(true);
    expect(affected.has('root')).toBe(true);
  });

  test('a changed inline-reference target re-renders the linking node', () => {
    const byId = byIdOf([
      node('root', { children: ['x', 'target'] }),
      node('x', {
        parentId: 'root',
        content: { text: 'see ', marks: [], inlineRefs: [{ offset: 4, target: { kind: 'node', nodeId: 'target' } }] },
      }),
      node('target', { parentId: 'root' }),
    ]);
    const affected = propagateDirty(new Set(['target']), byId);
    expect(affected.has('x')).toBe(true);
  });
});

describe('nextRevisions', () => {
  test('bumps affected nodes and carries the rest forward', () => {
    const ids = ['root', 'a', 'a2', 'b', 'c'];
    const first = nextRevisions(null, new Set(ids), ids);
    expect([...first.values()].every((v) => v === 1)).toBe(true);

    const affected = new Set(['c', 'b', 'a', 'root']);
    const second = nextRevisions(first, affected, ids);
    expect(second.get('c')).toBe(2);
    expect(second.get('b')).toBe(2);
    expect(second.get('a')).toBe(2);
    expect(second.get('root')).toBe(2);
    expect(second.get('a2')).toBe(1); // untouched sibling unchanged
  });
});
