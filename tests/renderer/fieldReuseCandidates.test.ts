import { describe, expect, test } from 'bun:test';
import type { NodeId, NodeProjection } from '../../src/renderer/api/types';
import {
  buildSystemFieldReuseCandidates,
  buildUserFieldReuseCandidates,
  filterFieldReuseCandidates,
  queryUserFieldReuseCandidates,
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

class CountingMap<K, V> extends Map<K, V> {
  valuesCalls = 0;

  override values(): MapIterator<V> {
    this.valuesCalls += 1;
    return super.values();
  }
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

describe('queryUserFieldReuseCandidates', () => {
  test('reuses the active field index for multiple queries on the same byId snapshot', () => {
    const map = new CountingMap<NodeId, NodeProjection>([
      ['trash', node('trash', 'node', 'Trash')],
      ['a', node('a', 'fieldDef', 'Status')],
      ['b', node('b', 'fieldDef', 'Start date')],
      ['c', node('c', 'fieldDef', 'Assignee')],
    ]);

    expect(queryUserFieldReuseCandidates(map, 'sta', { trashId: 'trash' }).map((c) => c.label)).toEqual([
      'Start date',
      'Status',
    ]);
    expect(map.valuesCalls).toBe(1);

    expect(queryUserFieldReuseCandidates(map, 'ass', { trashId: 'trash' }).map((c) => c.label)).toEqual([
      'Assignee',
    ]);
    expect(map.valuesCalls).toBe(1);
  });

  test('returns every broad prefix match from the cached sorted index', () => {
    const entries: Array<[NodeId, NodeProjection]> = [['trash', node('trash', 'node', 'Trash')]];
    for (let index = 0; index < 40; index += 1) {
      const id = `field-${String(index).padStart(2, '0')}`;
      entries.push([id, node(id, 'fieldDef', `Field ${String(index).padStart(2, '0')}`)]);
    }
    const map = new CountingMap<NodeId, NodeProjection>(entries);

    const result = queryUserFieldReuseCandidates(map, 'field', { trashId: 'trash' });

    expect(result).toHaveLength(40);
    expect(result[0]?.label).toBe('Field 00');
    expect(result.at(-1)?.label).toBe('Field 39');
    expect(map.valuesCalls).toBe(1);
  });

  test('does not let localized index ordering hide a real ASCII prefix candidate', () => {
    const map = byId(
      node('accented', 'fieldDef', 'Äther'),
      node('ascii', 'fieldDef', 'Azure'),
    );

    expect(queryUserFieldReuseCandidates(map, 'a').map((c) => c.label)).toEqual([
      'Azure',
    ]);
  });

  test('falls back to substring matches when there are not enough prefix matches', () => {
    const map = byId(
      node('a', 'fieldDef', 'Status'),
      node('b', 'fieldDef', 'Start date'),
      node('c', 'fieldDef', 'Assignee'),
    );

    expect(queryUserFieldReuseCandidates(map, 'tus').map((c) => c.label)).toEqual([
      'Status',
    ]);
  });

  test('keeps the empty forced picker complete and alphabetical', () => {
    const map = byId(
      node('a', 'fieldDef', 'Owner'),
      node('b', 'fieldDef', 'Assignee'),
      node('c', 'fieldDef', 'status'),
    );

    expect(queryUserFieldReuseCandidates(map, '', { forceOpen: true }).map((c) => c.label)).toEqual([
      'Assignee',
      'Owner',
      'status',
    ]);
  });

  test('excludes the draft def and fields already present on the owner', () => {
    const map = byId(
      node('a', 'fieldDef', 'Status'),
      node('b', 'fieldDef', 'Start date'),
      node('draft', 'fieldDef', 'Draft'),
    );

    expect(queryUserFieldReuseCandidates(map, 'sta', {
      excludeDefId: 'draft',
      excludeDefIds: new Set(['a']),
    }).map((c) => c.label)).toEqual([
      'Start date',
    ]);
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
