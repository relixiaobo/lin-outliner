import { describe, expect, test } from 'bun:test';
import { collapseWhitespace, resolveLauncherNodeMatches } from '../../src/core/launcher/nodeMatches';
import type { MatchableNode } from '../../src/core/launcher/nodeMatches';

const NODES: MatchableNode[] = [
  { id: 'n1', text: 'Caching   strategies\nfor scale', parentId: 'p1', icon: '📦', iconKind: 'emoji' },
  { id: 'p1', text: 'Engineering', parentId: null },
  { id: 'n2', text: 'Cache invalidation', parentId: 'p2', icon: 'img:1', iconKind: 'image' },
  { id: 'p2', text: '  Notes  ' },
  { id: 'n3', text: '   ', parentId: undefined },
];

describe('collapseWhitespace', () => {
  test('collapses runs of whitespace/newlines and trims', () => {
    expect(collapseWhitespace('a   b\n c\t')).toBe('a b c');
    expect(collapseWhitespace('   ')).toBe('');
  });
});

describe('resolveLauncherNodeMatches', () => {
  test('resolves hits into single-line title + parent subtitle + emoji icon', () => {
    const matches = resolveLauncherNodeMatches(['n1'], NODES, 8);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({
      nodeId: 'n1',
      title: 'Caching strategies for scale', // whitespace collapsed
      subtitle: 'Engineering',
      icon: '📦',
    });
  });

  test('only emoji icons travel — image/generated icons fall back (undefined → bullet)', () => {
    const [match] = resolveLauncherNodeMatches(['n2'], NODES, 8);
    expect(match.icon).toBeUndefined();
    expect(match.subtitle).toBe('Notes'); // parent text collapsed/trimmed
  });

  test('a node with no parent has no subtitle; blank text becomes "Untitled"', () => {
    const [match] = resolveLauncherNodeMatches(['n3'], NODES, 8);
    expect(match.title).toBe('Untitled');
    expect(match.subtitle).toBeUndefined();
  });

  test('skips hits whose node is missing, preserving hit order', () => {
    const matches = resolveLauncherNodeMatches(['missing', 'n2', 'n1'], NODES, 8);
    expect(matches.map((m) => m.nodeId)).toEqual(['n2', 'n1']);
  });

  test('bounds to the top `limit` hits (slice happens before skipping)', () => {
    // limit 2 considers ['missing','n1']; 'missing' is skipped → only n1 survives,
    // even though n2 (a valid hit) sits below the limit.
    const matches = resolveLauncherNodeMatches(['missing', 'n1', 'n2'], NODES, 2);
    expect(matches.map((m) => m.nodeId)).toEqual(['n1']);
  });

  test('respects the limit when all hits resolve', () => {
    const matches = resolveLauncherNodeMatches(['n1', 'n2', 'n3'], NODES, 2);
    expect(matches.map((m) => m.nodeId)).toEqual(['n1', 'n2']);
  });
});
