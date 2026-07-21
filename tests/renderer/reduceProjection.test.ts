import { describe, expect, test } from 'bun:test';
import type { DocumentProjection, NodeId, NodeProjection, ProjectionUpdate } from '../../src/core/types';
import { reduceProjection } from '../../src/renderer/state/document';

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

// Minimal envelope; only `nodes` and `todayId` move under the projection store.
function envelope(nodes: NodeProjection[], todayId: NodeId = 'root'): DocumentProjection {
  return {
    workspaceId: 'ws',
    rootId: 'root',
    libraryId: 'lib',
    dailyNotesId: 'daily',
    schemaId: 'schema',
    searchesId: 'searches',
    recentsId: 'recents',
    trashId: 'trash',
    todayId,
    nodes,
  };
}

// root > a > b > c, plus sibling a2 under root.
function tree(): NodeProjection[] {
  return [
    node('root', { children: ['a', 'a2'] }),
    node('a', { parentId: 'root', children: ['b'] }),
    node('a2', { parentId: 'root' }),
    node('b', { parentId: 'a', children: ['c'] }),
    node('c', { parentId: 'b' }),
  ];
}

function full(revision: number, nodes: NodeProjection[]): ProjectionUpdate {
  return { kind: 'full', revision, projection: envelope(nodes) };
}

function seed(revision = 1) {
  const state = reduceProjection(null, full(revision, tree()));
  if (!state) throw new Error('seed full update must produce a state');
  return state;
}

describe('reduceProjection — full update', () => {
  test('seeds byId, revision, and a revision counter per node', () => {
    const state = seed(7);
    expect(state.revision).toBe(7);
    expect([...state.index.byId.keys()].sort()).toEqual(['a', 'a2', 'b', 'c', 'root']);
    expect(state.index.renderRev.get('c')).toBe(1);
    expect(state.index.renderRev.get('root')).toBe(1);
  });

  test('a later full update rebuilds from scratch and bumps every counter', () => {
    const first = seed(1);
    const second = reduceProjection(first, full(2, tree()))!;
    expect(second.revision).toBe(2);
    // Every node is "affected" on a full rebuild, so each counter advances.
    expect(second.index.renderRev.get('c')).toBe(2);
    expect(second.index.renderRev.get('a2')).toBe(2);
  });
});

describe('reduceProjection — delta content edit', () => {
  test('replaces only the changed node object and keeps others by reference', () => {
    const prev = seed(1);
    const previousC = prev.index.byId.get('c');
    const editedC = node('c', { parentId: 'b', content: { text: 'edited', marks: [], inlineRefs: [] } });
    const next = reduceProjection(prev, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [editedC],
      removedIds: [],
    })!;

    expect(next.revision).toBe(2);
    expect(next.index.byId).not.toBe(prev.index.byId);
    expect(next.index.projection.nodes).not.toBe(prev.index.projection.nodes);
    expect(next.index.byId.get('c')!.content.text).toBe('edited');
    expect(prev.index.byId.get('c')).toBe(previousC);
    expect(prev.index.projection.nodes.find((candidate) => candidate.id === 'c')).toBe(previousC);
    expect(next.index.projection.nodes.find((candidate) => candidate.id === 'c')).toBe(editedC);
    // Unchanged nodes keep object identity — the stable-reference foundation memo relies on.
    expect(next.index.byId.get('a2')).toBe(prev.index.byId.get('a2'));
    expect(next.index.byId.get('root')).toBe(prev.index.byId.get('root'));
  });

  test('does not iterate the previous byId snapshot while folding a content delta', () => {
    const prev = seed(1);
    const fail = () => {
      throw new Error('previous byId must not be fully iterated');
    };
    Object.defineProperties(prev.index.byId, {
      [Symbol.iterator]: { value: fail },
      entries: { value: fail },
      keys: { value: fail },
      values: { value: fail },
      forEach: { value: fail },
    });

    const next = reduceProjection(prev, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [node('c', { parentId: 'b', content: { text: 'edited', marks: [], inlineRefs: [] } })],
      removedIds: [],
    })!;

    expect(next.index.byId.get('c')!.content.text).toBe('edited');
    expect(next.index.renderRev.get('root')).toBe(2);
  });

  test('bumps the changed node and its structural ancestors only', () => {
    const prev = seed(1);
    const editedC = node('c', { parentId: 'b', content: { text: 'edited', marks: [], inlineRefs: [] } });
    const next = reduceProjection(prev, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [editedC],
      removedIds: [],
    })!;

    expect(next.index.renderRev.get('c')).toBe(2);
    expect(next.index.renderRev.get('b')).toBe(2);
    expect(next.index.renderRev.get('a')).toBe(2);
    expect(next.index.renderRev.get('root')).toBe(2);
    expect(next.index.renderRev.get('a2')).toBe(1); // untouched sibling stays put
  });
});

describe('reduceProjection — delta structural change', () => {
  test('adds a new node carried in the change set', () => {
    const prev = seed(1);
    const newD = node('d', { parentId: 'b' });
    const editedB = node('b', { parentId: 'a', children: ['c', 'd'] });
    const next = reduceProjection(prev, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [editedB, newD],
      removedIds: [],
    })!;

    expect(next.index.byId.get('d')).toBeDefined();
    expect(next.index.byId.get('b')!.children).toEqual(['c', 'd']);
    expect(next.index.projection.nodes.some((n) => n.id === 'd')).toBe(true);
  });

  test('exposes delta projection nodes through normal array reads without materializing the store', () => {
    const prev = seed(1);
    const editedC = node('c', { parentId: 'b', content: { text: 'edited', marks: [], inlineRefs: [] } });
    const next = reduceProjection(prev, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [editedC],
      removedIds: [],
    })!;

    expect(Array.isArray(next.index.projection.nodes)).toBe(true);
    expect(next.index.projection.nodes.length).toBe(prev.index.projection.nodes.length);
    expect(next.index.projection.nodes[4]).toBe(editedC);
    expect([...next.index.projection.nodes].map((candidate) => candidate.id)).toEqual(['root', 'a', 'a2', 'b', 'c']);
    expect(next.index.projection.nodes.filter((candidate) => candidate.id.startsWith('a')).map((candidate) => candidate.id)).toEqual(['a', 'a2']);
    expect(next.index.projection.nodes.find((candidate) => candidate.id === 'c')).toBe(editedC);
  });

  test('deletes exactly the removed ids and carries todayId', () => {
    const prev = seed(1);
    const editedA = node('a', { parentId: 'root', children: [] }); // lost child b
    // Core enumerates the WHOLE removed subtree (`loro.deleteNode` touches every
    // descendant), so `removedIds` lists both b and c — the reducer deletes exactly
    // that set rather than walking the stale tree (which would wrongly drop a child
    // that the same revision moved out of b; see projectionDeltaIntegration merge).
    const next = reduceProjection(prev, {
      kind: 'delta',
      revision: 2,
      todayId: 'a2',
      changedNodes: [editedA],
      removedIds: ['b', 'c'],
    })!;

    expect(next.index.byId.has('b')).toBe(false);
    expect(next.index.byId.has('c')).toBe(false);
    expect(next.index.byId.has('a')).toBe(true);
    expect(next.index.projection.todayId).toBe('a2');
    expect(next.index.projection.nodes.some((n) => n.id === 'c')).toBe(false);
  });

  test('a survivor moved out of a removed node is kept (removedIds-only delete)', () => {
    const prev = seed(1);
    // b is removed, but its child c was re-parented under a2 in the same revision —
    // so c arrives in changedNodes, not removedIds. Deleting only removedIds keeps c.
    const editedA = node('a', { parentId: 'root', children: [] });
    const movedC = node('c', { parentId: 'a2' });
    const editedA2 = node('a2', { parentId: 'root', children: ['c'] });
    const next = reduceProjection(prev, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [editedA, movedC, editedA2],
      removedIds: ['b'],
    })!;

    expect(next.index.byId.has('b')).toBe(false);
    expect(next.index.byId.has('c')).toBe(true);
    expect(next.index.byId.get('c')!.parentId).toBe('a2');
  });

  test('a same-revision full reseed is a no-op', () => {
    const prev = seed(5);
    // Folding a refresh snapshot at the held revision must not churn renderRev
    // (it would invalidate every memo).
    const same = reduceProjection(prev, { kind: 'full', revision: 5, projection: prev.index.projection });
    expect(same).toBe(prev);
  });
});

describe('reduceProjection — revision discipline', () => {
  test('an already-applied revision returns the previous state unchanged', () => {
    const prev = seed(5);
    const dup = reduceProjection(prev, {
      kind: 'delta',
      revision: 5, // dual-channel duplicate (command reply + event)
      todayId: 'root',
      changedNodes: [node('c', { parentId: 'b', content: { text: 'x', marks: [], inlineRefs: [] } })],
      removedIds: [],
    });
    expect(dup).toBe(prev); // same object — no rebuild, no counter churn
  });

  test('a revision gap returns null to signal the caller must resync', () => {
    const prev = seed(1);
    const gapped = reduceProjection(prev, {
      kind: 'delta',
      revision: 3, // skipped revision 2
      todayId: 'root',
      changedNodes: [],
      removedIds: [],
    });
    expect(gapped).toBeNull();
  });

  test('a delta with no base state returns null (must resync)', () => {
    const orphan = reduceProjection(null, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [],
      removedIds: [],
    });
    expect(orphan).toBeNull();
  });
});
