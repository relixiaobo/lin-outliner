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
    settingsId: 'settings',
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
    const editedC = node('c', { parentId: 'b', content: { text: 'edited', marks: [], inlineRefs: [] } });
    const next = reduceProjection(prev, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [editedC],
      removedIds: [],
    })!;

    expect(next.revision).toBe(2);
    expect(next.index.byId.get('c')!.content.text).toBe('edited');
    // Unchanged nodes keep object identity — the stable-reference foundation memo relies on.
    expect(next.index.byId.get('a2')).toBe(prev.index.byId.get('a2'));
    expect(next.index.byId.get('root')).toBe(prev.index.byId.get('root'));
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

  test('prunes a removed subtree (root and descendants) and carries todayId', () => {
    const prev = seed(1);
    const editedA = node('a', { parentId: 'root', children: [] }); // lost child b
    const next = reduceProjection(prev, {
      kind: 'delta',
      revision: 2,
      todayId: 'a2',
      changedNodes: [editedA],
      removedIds: ['b'], // core reports the subtree root; descendants derived here
    })!;

    expect(next.index.byId.has('b')).toBe(false);
    expect(next.index.byId.has('c')).toBe(false); // descendant pruned too
    expect(next.index.byId.has('a')).toBe(true);
    expect(next.index.projection.todayId).toBe('a2');
    expect(next.index.projection.nodes.some((n) => n.id === 'c')).toBe(false);
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
