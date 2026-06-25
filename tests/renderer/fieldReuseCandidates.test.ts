import { describe, expect, test } from 'bun:test';
import type { NodeId, NodeProjection } from '../../src/renderer/api/types';
import {
  buildSystemFieldReuseCandidates,
  buildUserFieldReuseCandidates,
  filterFieldReuseCandidates,
  sortFieldReuseCandidatesByLabel,
} from '../../src/renderer/ui/interactions/fieldReuseCandidates';

function node(
  id: string,
  type: string,
  text: string,
  overrides: Partial<NodeProjection> = {},
): NodeProjection {
  return { id, type, content: { text, inlineRefs: [] }, children: [], ...overrides } as unknown as NodeProjection;
}

function byId(...nodes: NodeProjection[]): Map<NodeId, NodeProjection> {
  return new Map(nodes.map((n) => [n.id, n]));
}

describe('buildUserFieldReuseCandidates', () => {
  test('collects named field definitions, skipping empties, non-defs, and the excluded def', () => {
    const map = byId(
      node('a', 'fieldDef', 'Status'),
      node('b', 'fieldDef', 'Owner'),
      node('draft', 'fieldDef', ''),
      node('self', 'fieldDef', 'Priority'),
      node('plain', 'node', 'Status'),
    );
    const result = buildUserFieldReuseCandidates(map, { excludeDefId: 'self' });
    expect(result.map((c) => c.id).sort()).toEqual(['a', 'b']);
    expect(result.every((c) => c.kind === 'user' && c.section === 'Fields')).toBe(true);
  });

  test('skips field definitions in Trash when a trash root is provided', () => {
    const map = byId(
      node('trash', 'node', 'Trash'),
      node('a', 'fieldDef', 'Status'),
      node('deleted', 'fieldDef', 'Archived', { parentId: 'trash' }),
    );
    const result = buildUserFieldReuseCandidates(map, { trashId: 'trash' });
    expect(result.map((c) => c.id)).toEqual(['a']);
  });
});

describe('filterFieldReuseCandidates', () => {
  const candidates = buildUserFieldReuseCandidates(
    byId(node('a', 'fieldDef', 'Status'), node('b', 'fieldDef', 'Start date'), node('c', 'fieldDef', 'Assignee')),
  );

  test('an empty query offers nothing', () => {
    expect(filterFieldReuseCandidates(candidates, '   ')).toEqual([]);
  });

  test('matches case-insensitively and orders prefix matches first', () => {
    const result = filterFieldReuseCandidates(candidates, 'sta');
    expect(result.map((c) => c.label)).toEqual(['Start date', 'Status']);
  });

  test('keeps an exact-name match so the existing field can be reused', () => {
    expect(filterFieldReuseCandidates(candidates, 'Status').map((c) => c.label)).toEqual(['Status']);
  });
});

describe('buildSystemFieldReuseCandidates', () => {
  test('offers the built-in read-only fields under the System fields section', () => {
    const system = buildSystemFieldReuseCandidates();
    expect(system.map((c) => c.label)).toContain('Created');
    expect(system.map((c) => c.label)).toContain('Done time');
    expect(system.every((c) => c.kind === 'system' && c.section === 'System fields')).toBe(true);
    expect(system.every((c) => c.id === c.systemKind && c.id.startsWith('sys:'))).toBe(true);
    // Excludes Name — a node's name is its title, not a field.
    expect(system.map((c) => c.label)).not.toContain('Name');
  });

  test('filters system candidates by query like any other', () => {
    const matches = filterFieldReuseCandidates(buildSystemFieldReuseCandidates(), 'don');
    expect(matches.map((c) => c.label)).toEqual(['Done', 'Done time']);
  });
});

describe('sortFieldReuseCandidatesByLabel', () => {
  test('orders candidates alphabetically for the empty-query (Space-summoned) picker', () => {
    const candidates = buildUserFieldReuseCandidates(
      byId(node('a', 'fieldDef', 'Owner'), node('b', 'fieldDef', 'Assignee'), node('c', 'fieldDef', 'status')),
    );
    expect(sortFieldReuseCandidatesByLabel(candidates).map((c) => c.label)).toEqual([
      'Assignee',
      'Owner',
      'status',
    ]);
  });
});
