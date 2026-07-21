import { describe, expect, test } from 'bun:test';
import type { NodeId, NodeProjection } from '../../src/core/types';
import {
  buildReverseEdges,
  nextRevisions,
  patchRevisions,
  patchReverseEdges,
  propagateDirty as propagateDirtyRaw,
} from '../../src/renderer/state/renderRev';

// Tests exercise propagation given the reverse-edge index built from the same
// snapshot; the index is built incrementally in the store but a full build is the
// correct oracle for a one-shot assertion.
function propagateDirty(changed: ReadonlySet<NodeId>, byId: Map<NodeId, NodeProjection>) {
  return propagateDirtyRaw(changed, byId, buildReverseEdges(byId));
}

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

  test('a child text edit does not mark untouched siblings dirty', () => {
    const byId = tree();
    const affected = propagateDirty(new Set(['a']), byId);
    expect(affected.has('root')).toBe(true);
    expect(affected.has('a2')).toBe(false);
  });

  test('a view rule edit marks the owner rows that read view display settings', () => {
    const byId = byIdOf([
      node('root', { children: ['view', 'a', 'b'] }),
      node('view', { parentId: 'root', type: 'viewDef', children: ['display'] }),
      node('display', { parentId: 'view', type: 'displayField', displayField: 'sys:createdAt' } as Partial<NodeProjection>),
      node('a', { parentId: 'root' }),
      node('b', { parentId: 'root' }),
    ]);
    const affected = propagateDirty(new Set(['display']), byId);
    expect(affected.has('view')).toBe(true);
    expect(affected.has('root')).toBe(true);
    expect(affected.has('a')).toBe(true);
    expect(affected.has('b')).toBe(true);
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

describe('patchReverseEdges', () => {
  // x carries tag t and inline-refs target; ref(->target) points at target.
  function scene(): Map<NodeId, NodeProjection> {
    return byIdOf([
      node('x', { tags: ['t'], content: { text: 'see', marks: [], inlineRefs: [{ offset: 0, target: { kind: 'node', nodeId: 'target' } }] } }),
      node('ref', { type: 'reference', targetId: 'target' }),
      node('target'),
      node('t', { type: 'tagDef' }),
    ]);
  }

  test('matches a full rebuild after a tag is dropped from a node', () => {
    const before = scene();
    const prev = buildReverseEdges(before);
    const editedX = node('x', { tags: [], content: before.get('x')!.content }); // lost tag t
    const after = byIdOf([editedX, before.get('ref')!, before.get('target')!, before.get('t')!]);

    const next = patchReverseEdges(prev, before, [editedX], []);
    expect(next).toEqual(buildReverseEdges(after));
    expect(next.taggers.has('t')).toBe(false); // empty key pruned
  });

  test('matches a full rebuild after a node is removed', () => {
    const before = scene();
    const prev = buildReverseEdges(before);
    const after = byIdOf([before.get('x')!, before.get('target')!, before.get('t')!]); // ref gone

    const next = patchReverseEdges(prev, before, [], ['ref']);
    expect(next).toEqual(buildReverseEdges(after));
    expect(next.references.has('target')).toBe(false);
  });

  test('does not mutate the previous index (copy-on-write)', () => {
    const before = scene();
    const prev = buildReverseEdges(before);
    const taggersOfT = prev.taggers.get('t')!;
    expect(taggersOfT.has('x')).toBe(true);

    const editedX = node('x', { tags: [], content: before.get('x')!.content });
    patchReverseEdges(prev, before, [editedX], []);

    // prev's set is untouched — the new index owns a fresh copy.
    expect(prev.taggers.get('t')).toBe(taggersOfT);
    expect(taggersOfT.has('x')).toBe(true);
  });

  test('matches a full rebuild after a node gains an edge, copying the existing target set', () => {
    // `ref` already points at `target`; a second node `ref2` starts pointing at it
    // too, so the add path must copy `target`'s existing referrer set, not mutate it.
    const before = byIdOf([
      node('ref', { type: 'reference', targetId: 'target' }),
      node('ref2', { type: 'reference', targetId: undefined }),
      node('target'),
    ]);
    const prev = buildReverseEdges(before);
    const referrersOfTarget = prev.references.get('target')!; // {ref}
    expect([...referrersOfTarget]).toEqual(['ref']);

    const editedRef2 = node('ref2', { type: 'reference', targetId: 'target' }); // now points at target
    const after = byIdOf([before.get('ref')!, editedRef2, before.get('target')!]);
    const next = patchReverseEdges(prev, before, [editedRef2], []);

    expect(next).toEqual(buildReverseEdges(after));
    expect(next.references.get('target')).toEqual(new Set(['ref', 'ref2']));
    // prev's set was copied, not extended, on the add path.
    expect(prev.references.get('target')).toBe(referrersOfTarget);
    expect(referrersOfTarget.has('ref2')).toBe(false);
  });

  test('a text-only edit (same edge keys) leaves the edges equal', () => {
    const before = scene();
    const prev = buildReverseEdges(before);
    // Same tag + same inline-ref target, only the surrounding text changed.
    const editedX = node('x', { tags: ['t'], content: { text: 'see more', marks: [], inlineRefs: [{ offset: 0, target: { kind: 'node', nodeId: 'target' } }] } });
    const next = patchReverseEdges(prev, before, [editedX], []);
    // No edge moved, so the patch allocates nothing and hands back `prev` as-is.
    expect(next).toBe(prev);
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

  test('patchRevisions bumps only affected live ids without iterating the previous revision map', () => {
    const byId = tree();
    const previous = nextRevisions(null, new Set(byId.keys()), byId.keys());
    const fail = () => {
      throw new Error('previous renderRev must not be fully iterated');
    };
    Object.defineProperties(previous, {
      [Symbol.iterator]: { value: fail },
      entries: { value: fail },
      keys: { value: fail },
      values: { value: fail },
      forEach: { value: fail },
    });

    const next = patchRevisions(previous, new Set(['c', 'b', 'a', 'root']), byId, []);
    expect(next.get('c')).toBe(2);
    expect(next.get('b')).toBe(2);
    expect(next.get('a')).toBe(2);
    expect(next.get('root')).toBe(2);
    expect(next.get('a2')).toBe(1);
  });
});
