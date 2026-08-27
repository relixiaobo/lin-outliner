import { describe, expect, test } from 'bun:test';
import {
  applyPendingRowPlacement,
  pendingStructuralProjectionSuppressions,
  resolvePendingRowPlacement,
} from '../../src/renderer/state/trailingDraftPlacement';

interface Row {
  id: string;
  parentId: string;
}

const rows: readonly Row[] = [
  { id: 'a', parentId: 'root' },
  { id: 'b', parentId: 'root' },
  { id: 'c', parentId: 'root' },
];

function placement(change: { id: string; beforeId?: string | null; afterId?: string | null }) {
  return resolvePendingRowPlacement({
    rows,
    change: {
      id: change.id,
      parentId: 'root',
      beforeId: change.beforeId ?? null,
      afterId: change.afterId ?? null,
    },
    matches: (row, id, parentId) => row.id === id && row.parentId === parentId,
    fallbackIndex: (currentRows) => currentRows.length,
  });
}

describe('pending row placement', () => {
  test('replaces a projected row with the optimistic row carrying the same id', () => {
    const resolved = placement({ id: 'b' });
    expect(resolved).toEqual({ kind: 'replace', index: 1, referenceIndex: 1 });
    expect(applyPendingRowPlacement(rows, { id: 'b', parentId: 'optimistic' }, resolved!)).toEqual([
      rows[0],
      { id: 'b', parentId: 'optimistic' },
      rows[2],
    ]);
  });

  test('inserts before and after exact anchors', () => {
    expect(placement({ id: 'pending-before', beforeId: 'b' })).toEqual({
      kind: 'insert',
      index: 1,
      referenceIndex: 1,
    });
    expect(placement({ id: 'pending-after', afterId: 'b' })).toEqual({
      kind: 'insert',
      index: 2,
      referenceIndex: 1,
    });
  });

  test('uses the caller fallback when no exact anchor exists', () => {
    expect(placement({ id: 'pending', afterId: 'missing' })).toEqual({
      kind: 'insert',
      index: 3,
      referenceIndex: null,
    });
  });

  test('suppresses relocation sources for both cross-parent and same-parent moves', () => {
    const suppressions = pendingStructuralProjectionSuppressions([
      { id: 'cross-parent', sourceParentId: 'root', parentId: 'other' },
      { id: 'same-parent', sourceParentId: 'root', parentId: 'root' },
      { id: 'different-source', sourceParentId: 'other', parentId: 'root' },
    ], 'root', new Set(['removed']));

    expect([...suppressions]).toEqual(['removed', 'cross-parent', 'same-parent']);
  });
});
