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

  test('keeps unlinked mention ranges in original text offsets when case folding expands characters', () => {
    const byId = new Map([
      node({ id: 'target', content: plainText('İstanbul') }),
      node({ id: 'source', content: plainText('Visit İstanbul soon') }),
    ].map((entry) => [entry.id, entry]));

    const summary = buildReferenceSummary(byId, { includeUnlinked: true });
    const unlinked = (summary.byTarget.get('target') ?? []).filter((source) => source.kind === 'unlinked');

    expect(unlinked).toHaveLength(1);
    expect(unlinked[0]).toMatchObject({
      sourceNodeId: 'source',
      mention: { field: 'content', start: 6, end: 14, text: 'İstanbul' },
    });
  });

  test('keeps repeated unlinked mention occurrences linkable independently', () => {
    const byId = new Map([
      node({ id: 'target', content: plainText('Project Alpha') }),
      node({
        id: 'repeated-source',
        content: plainText('Project Alpha now, Project Alpha later'),
        description: 'Project Alpha in the description too',
      }),
      node({ id: 'second-source', content: plainText('Review Project Alpha') }),
    ].map((entry) => [entry.id, entry]));

    const summary = buildReferenceSummary(byId, { includeUnlinked: true });
    const unlinked = (summary.byTarget.get('target') ?? []).filter((source) => source.kind === 'unlinked');

    expect(summary.countsByTarget.get('target')).toEqual({ linked: 0, unlinked: 4, total: 4 });
    expect(unlinked.map((source) => source.sourceNodeId)).toEqual([
      'repeated-source',
      'repeated-source',
      'repeated-source',
      'second-source',
    ]);
    expect(unlinked[0]?.mention).toMatchObject({ field: 'content', start: 0, end: 13, text: 'Project Alpha' });
    expect(unlinked[1]?.mention).toMatchObject({ field: 'content', start: 19, end: 32, text: 'Project Alpha' });
    expect(unlinked[2]?.mention).toMatchObject({ field: 'description', start: 0, end: 13, text: 'Project Alpha' });
  });

  test('continues to show a plain mention from a node that already links to the target elsewhere', () => {
    const byId = new Map([
      node({ id: 'target', content: plainText('Project Alpha') }),
      node({
        id: 'source',
        content: { ...plainText('Already linked. Project Alpha later'), inlineRefs: [{ offset: 0, target: nodeReferenceTarget('target') }] },
      }),
    ].map((entry) => [entry.id, entry]));

    const summary = buildReferenceSummary(byId, { includeUnlinked: true });
    const unlinked = (summary.byTarget.get('target') ?? []).filter((source) => source.kind === 'unlinked');

    expect(summary.countsByTarget.get('target')).toEqual({ linked: 1, unlinked: 1, total: 2 });
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0]?.mention).toMatchObject({ field: 'content', start: 16, end: 29, text: 'Project Alpha' });
  });

  test('limits unlinked mention scanning to requested targets', () => {
    const byId = new Map([
      node({ id: 'target-a', content: plainText('Project Alpha') }),
      node({ id: 'target-b', content: plainText('Project Beta') }),
      node({ id: 'source', content: plainText('Project Alpha and Project Beta') }),
    ].map((entry) => [entry.id, entry]));

    const summary = buildReferenceSummary(byId, { includeUnlinked: true, mentionTargetIds: ['target-a'] });

    expect(summary.countsByTarget.get('target-a')).toEqual({ linked: 0, unlinked: 1, total: 1 });
    expect(summary.countsByTarget.get('target-b')).toBeUndefined();
  });

  test('does not create unlinked mentions from a node to itself', () => {
    const byId = new Map([
      node({ id: 'target', content: plainText('Project Alpha mentions Project Alpha') }),
    ].map((entry) => [entry.id, entry]));

    const summary = buildReferenceSummary(byId, { includeUnlinked: true });

    expect(summary.byTarget.get('target')).toBeUndefined();
    expect(summary.countsByTarget.get('target')).toBeUndefined();
  });

  test('does not match a CJK title inside a longer CJK word', () => {
    const byId = new Map([
      node({ id: 'target', content: plainText('项目集') }),
      node({ id: 'longer-word-source', content: plainText('项目集合') }),
      node({ id: 'separated-source', content: plainText('项目集。') }),
    ].map((entry) => [entry.id, entry]));

    const summary = buildReferenceSummary(byId, { includeUnlinked: true });
    const unlinked = (summary.byTarget.get('target') ?? []).filter((source) => source.kind === 'unlinked');

    expect(summary.countsByTarget.get('target')).toEqual({ linked: 0, unlinked: 1, total: 1 });
    expect(unlinked.map((source) => source.sourceNodeId)).toEqual(['separated-source']);
  });

  test('skips parentless reference nodes instead of attributing them to themselves', () => {
    const byId = new Map([
      node({ id: 'target', content: plainText('Target') }),
      node({ id: 'orphan-ref', type: 'reference', targetId: 'target' }),
    ].map((entry) => [entry.id, entry]));

    const summary = buildReferenceSummary(byId);

    expect(summary.byTarget.get('target')).toBeUndefined();
    expect(summary.countsByTarget.get('target')).toBeUndefined();
  });

  test('excludes saved-search internal references from backlinks without hiding manual children', () => {
    const byId = new Map([
      node({ id: 'target', content: plainText('Target') }),
      node({ id: 'source', children: ['source-ref'], content: plainText('Source') }),
      node({ id: 'source-ref', type: 'reference', parentId: 'source', targetId: 'target' }),
      node({
        id: 'search',
        type: 'search',
        children: ['legacy-result-ref', 'condition', 'manual-search-child'],
        content: { ...plainText('Search mentions Target'), inlineRefs: [{ offset: 0, target: nodeReferenceTarget('target') }] },
      }),
      node({ id: 'legacy-result-ref', type: 'reference', parentId: 'search', targetId: 'target' }),
      node({
        id: 'condition',
        type: 'queryCondition',
        parentId: 'search',
        children: ['operand-ref', 'operand-node'],
        content: { ...plainText('Condition mentions Target'), inlineRefs: [{ offset: 0, target: nodeReferenceTarget('target') }] },
      }),
      node({ id: 'operand-ref', type: 'reference', parentId: 'condition', targetId: 'target' }),
      node({
        id: 'operand-node',
        parentId: 'condition',
        content: { ...plainText('Operand mentions Target'), inlineRefs: [{ offset: 0, target: nodeReferenceTarget('target') }] },
      }),
      node({
        id: 'manual-search-child',
        parentId: 'search',
        children: ['manual-search-child-ref'],
        content: { ...plainText('Manual child mentions Target'), inlineRefs: [{ offset: 0, target: nodeReferenceTarget('target') }] },
      }),
      node({ id: 'manual-search-child-ref', type: 'reference', parentId: 'manual-search-child', targetId: 'target' }),
    ].map((entry) => [entry.id, entry]));

    const summary = buildReferenceSummary(byId, { includeUnlinked: true });
    const sources = summary.byTarget.get('target') ?? [];

    expect(summary.countsByTarget.get('target')).toEqual({ linked: 3, unlinked: 1, total: 4 });
    expect(sources.map((source) => [source.kind, source.sourceNodeId, source.referenceNodeId])).toEqual([
      ['tree', 'source', 'source-ref'],
      ['inline', 'manual-search-child', 'manual-search-child'],
      ['tree', 'manual-search-child', 'manual-search-child-ref'],
      ['unlinked', 'manual-search-child', 'manual-search-child'],
    ]);
  });
});
