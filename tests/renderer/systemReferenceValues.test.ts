import { describe, expect, test } from 'bun:test';
import { OWNER_FIELD } from '../../src/core/systemFields';
import type { NodeId, NodeProjection } from '../../src/renderer/api/types';
import { buildDayNoteCountIndex } from '../../src/renderer/state/dayNoteCounts';
import type { DocumentIndex } from '../../src/renderer/state/document';
import { syntheticSystemReferenceId } from '../../src/renderer/state/systemReferenceRows';
import { deriveSystemReferenceValueIndex } from '../../src/renderer/ui/outliner/SystemReferenceValues';

function node(partial: Partial<NodeProjection> & { id: NodeId }): NodeProjection {
  return {
    type: 'node',
    content: { text: '', marks: [], inlineRefs: [] },
    children: [],
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    locked: false,
    autoCollected: false,
    ...partial,
  } as NodeProjection;
}

function projection(nodes: NodeProjection[]): DocumentIndex['projection'] {
  return {
    workspaceId: 'workspace',
    rootId: 'workspace',
    libraryId: 'library',
    dailyNotesId: 'daily-notes',
    schemaId: 'schema',
    searchesId: 'searches',
    recentsId: 'recents',
    trashId: 'trash',
    todayId: 'today',
    nodes,
  };
}

function indexWith(byId: Map<NodeId, NodeProjection>, nodes: NodeProjection[]): DocumentIndex {
  return {
    projection: projection(nodes),
    byId,
    dayNoteCounts: buildDayNoteCountIndex(new Map(nodes.map((entry) => [entry.id, entry] as const))),
  };
}

class NonIterableMap<K, V> extends Map<K, V> {
  private readonly valuesByKey: Map<K, V>;

  constructor(entries: readonly (readonly [K, V])[]) {
    super();
    this.valuesByKey = new Map(entries);
  }

  override get size(): number {
    return this.valuesByKey.size;
  }

  override get(key: K): V | undefined {
    return this.valuesByKey.get(key);
  }

  override has(key: K): boolean {
    return this.valuesByKey.has(key);
  }

  override entries(): MapIterator<[K, V]> {
    throw new Error('base map must not be iterated');
  }

  override keys(): MapIterator<K> {
    throw new Error('base map must not be iterated');
  }

  override values(): MapIterator<V> {
    throw new Error('base map must not be iterated');
  }

  override forEach(): void {
    throw new Error('base map must not be iterated');
  }

  override [Symbol.iterator](): MapIterator<[K, V]> {
    throw new Error('base map must not be iterated');
  }
}

describe('deriveSystemReferenceValueIndex', () => {
  test('synthesizes system reference rows without copying the base byId map', () => {
    const parent = node({ id: 'parent', content: { text: 'Parent', marks: [], inlineRefs: [] } });
    const owner = node({ id: 'owner', parentId: 'parent' });
    const entry = node({
      id: 'entry',
      type: 'fieldEntry',
      parentId: 'owner',
      fieldDefId: OWNER_FIELD,
    } as Partial<NodeProjection> & { id: NodeId });
    const nodes = [parent, owner, entry];
    const baseById = new NonIterableMap<NodeId, NodeProjection>(nodes.map((entry) => [entry.id, entry] as const));

    const result = deriveSystemReferenceValueIndex(
      indexWith(baseById, nodes),
      owner.id,
      entry.id,
      OWNER_FIELD,
    );

    const syntheticRefId = syntheticSystemReferenceId(entry.id, parent.id);
    expect(result.isEmpty).toBe(false);
    expect(result.index.byId.get(owner.id)).toBe(owner);
    expect(result.index.byId.get(entry.id)?.children).toEqual([syntheticRefId]);
    expect(result.index.byId.get(syntheticRefId)).toMatchObject({
      id: syntheticRefId,
      type: 'reference',
      targetId: parent.id,
      parentId: entry.id,
      locked: true,
    });
  });

  test('preserves Map iteration semantics when callers need to enumerate the overlay', () => {
    const parent = node({ id: 'parent', content: { text: 'Parent', marks: [], inlineRefs: [] } });
    const owner = node({ id: 'owner', parentId: 'parent' });
    const entry = node({
      id: 'entry',
      type: 'fieldEntry',
      parentId: 'owner',
      fieldDefId: OWNER_FIELD,
    } as Partial<NodeProjection> & { id: NodeId });
    const nodes = [parent, owner, entry];

    const result = deriveSystemReferenceValueIndex(
      indexWith(new Map(nodes.map((entry) => [entry.id, entry] as const)), nodes),
      owner.id,
      entry.id,
      OWNER_FIELD,
    );

    const syntheticRefId = syntheticSystemReferenceId(entry.id, parent.id);
    expect(result.index.byId.size).toBe(4);
    expect(result.index.byId instanceof Map).toBe(true);
    expect([...result.index.byId.keys()]).toEqual(['parent', 'owner', 'entry', syntheticRefId]);
    expect([...result.index.byId.values()].map((entry) => entry.id)).toEqual(['parent', 'owner', 'entry', syntheticRefId]);
    expect([...result.index.byId.entries()].map(([id]) => id)).toEqual(['parent', 'owner', 'entry', syntheticRefId]);
    expect(() => result.index.byId.set('other', parent)).toThrow(/read-only/);
  });
});
