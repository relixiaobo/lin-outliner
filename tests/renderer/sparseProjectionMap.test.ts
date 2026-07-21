import { describe, expect, test } from 'bun:test';
import type { NodeProjection } from '../../src/core/types';
import { projectionNodesView, SparseProjectionMap } from '../../src/renderer/state/sparseProjectionMap';

function node(id: string): NodeProjection {
  return {
    id,
    children: [],
    content: { text: id, marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    locked: false,
    autoCollected: false,
  } as NodeProjection;
}

describe('SparseProjectionMap', () => {
  test('exposes normal read-only Map iteration APIs', () => {
    const a = node('a');
    const b = node('b');
    const map = SparseProjectionMap.fromEntries([
      ['a', a],
      ['b', b],
    ] as const);

    expect(map instanceof Map).toBe(true);
    expect(map.size).toBe(2);
    expect(map.get('a')).toBe(a);
    expect(map.has('b')).toBe(true);
    expect([...map.keys()]).toEqual(['a', 'b']);
    expect([...map.values()]).toEqual([a, b]);
    expect([...map.entries()]).toEqual([['a', a], ['b', b]]);
    expect(new Map(map)).toEqual(new Map([['a', a], ['b', b]]));

    const visited: string[] = [];
    map.forEach((value, key, owner) => {
      expect(owner).toBe(map);
      visited.push(`${key}:${value.id}`);
    });
    expect(visited).toEqual(['a:a', 'b:b']);
  });

  test('patches a new snapshot without mutating the previous one', () => {
    const a = node('a');
    const b = node('b');
    const editedB = { ...b, content: { text: 'edited', marks: [], inlineRefs: [] } };
    const c = node('c');
    const previous = SparseProjectionMap.fromEntries([
      ['a', a],
      ['b', b],
    ] as const);

    const next = previous.patch([
      ['b', editedB],
      ['c', c],
    ] as const, ['a']);

    expect([...previous.keys()]).toEqual(['a', 'b']);
    expect(previous.get('a')).toBe(a);
    expect(previous.get('b')).toBe(b);
    expect([...next.keys()]).toEqual(['b', 'c']);
    expect(next.get('b')).toBe(editedB);
    expect(next.get('c')).toBe(c);
  });

  test('does not duplicate order when a malformed delta repeats an added id', () => {
    const previous = SparseProjectionMap.fromEntries([['a', node('a')]] as const);
    const firstB = node('b');
    const secondB = { ...firstB, content: { text: 'second', marks: [], inlineRefs: [] } };

    const next = previous.patch([
      ['b', firstB],
      ['b', secondB],
    ] as const, []);

    expect(next.size).toBe(2);
    expect([...next.keys()]).toEqual(['a', 'b']);
    expect([...next.values()]).toEqual([previous.get('a'), secondB]);
  });
});

describe('projectionNodesView', () => {
  test('supports existing array-shaped projection node reads', () => {
    const a = node('a');
    const b = node('b');
    const byId = SparseProjectionMap.fromEntries([
      ['a', a],
      ['b', b],
    ] as const);
    const nodes = projectionNodesView(byId, byId.orderedIds);

    expect(Array.isArray(nodes)).toBe(true);
    expect(nodes.length).toBe(2);
    expect(nodes[0]).toBe(a);
    expect([...nodes]).toEqual([a, b]);
    expect(nodes.map((candidate) => candidate.id)).toEqual(['a', 'b']);
    expect(nodes.filter((candidate) => candidate.id !== 'a')).toEqual([b]);
    expect(nodes.find((candidate) => candidate.id === 'b')).toBe(b);
    expect(nodes.some((candidate) => candidate.id === 'a')).toBe(true);
  });
});
