import { describe, expect, test } from 'bun:test';
import { buildReferenceSummary } from '../../src/core/references';
import { nodeReferenceTarget, plainText, type NodeProjection } from '../../src/core/types';

function node(partial: Partial<NodeProjection> & { id: string }): NodeProjection {
  return {
    content: plainText(''),
    children: [],
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    locked: false,
    autoCollected: false,
    ...partial,
  } as NodeProjection;
}

describe('buildReferenceSummary', () => {
  test('classifies tree, inline, and field references while excluding internal roles', () => {
    const byId = new Map([
      node({ id: 'target', content: plainText('Target') }),
      node({ id: 'source', children: ['tree-ref', 'config-ref'], content: plainText('Source') }),
      node({ id: 'tree-ref', type: 'reference', parentId: 'source', targetId: 'target' }),
      node({
        id: 'inline-source',
        content: { ...plainText('Inline'), inlineRefs: [{ offset: 0, target: nodeReferenceTarget('target'), displayName: 'Target' }] },
      }),
      node({ id: 'field-def', type: 'fieldDef', content: plainText('Related') }),
      node({ id: 'owner', children: ['field-entry'], content: plainText('Owner') }),
      node({ id: 'field-entry', type: 'fieldEntry', parentId: 'owner', fieldDefId: 'field-def', children: ['field-ref'] }),
      node({ id: 'field-ref', type: 'reference', parentId: 'field-entry', targetId: 'target', refRole: 'fieldValue' }),
      node({ id: 'config-ref', type: 'reference', parentId: 'source', targetId: 'target', refRole: 'config' }),
    ].map((entry) => [entry.id, entry]));

    const summary = buildReferenceSummary(byId);
    const sources = summary.byTarget.get('target') ?? [];

    expect(summary.countsByTarget.get('target')).toEqual({ linked: 3, unlinked: 0, total: 3 });
    expect(sources.map((source) => [source.kind, source.sourceNodeId, source.referenceNodeId, source.fieldEntryId])).toEqual([
      ['tree', 'source', 'tree-ref', undefined],
      ['inline', 'inline-source', 'inline-source', undefined],
      ['field', 'owner', 'field-ref', 'field-entry'],
    ]);
  });

  test('finds exact unlinked mentions and skips sources that already link to the target', () => {
    const byId = new Map([
      node({ id: 'target', content: plainText('Project Alpha') }),
      node({ id: 'text-source', content: plainText('Review Project Alpha next week') }),
      node({
        id: 'linked-source',
        content: { ...plainText('Project Alpha is already linked'), inlineRefs: [{ offset: 0, target: nodeReferenceTarget('target') }] },
      }),
      node({ id: 'partial-source', content: plainText('Project Alphabet is different') }),
    ].map((entry) => [entry.id, entry]));

    const summary = buildReferenceSummary(byId, { includeUnlinked: true });
    const unlinked = (summary.byTarget.get('target') ?? []).filter((source) => source.kind === 'unlinked');

    expect(summary.countsByTarget.get('target')).toEqual({ linked: 1, unlinked: 1, total: 2 });
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0]).toMatchObject({
      sourceNodeId: 'text-source',
      mention: { field: 'content', start: 7, end: 20, text: 'Project Alpha' },
    });
  });
});
