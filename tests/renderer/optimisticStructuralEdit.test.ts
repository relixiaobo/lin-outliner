import { describe, expect, test } from 'bun:test';
import {
  inlineRefNodeId,
  plainText,
  type NodeProjection,
} from '../../src/renderer/api/types';
import {
  createOptimisticStructuralSettlement,
  optimisticMergedNode,
} from '../../src/renderer/ui/outliner/optimisticStructuralEdit';

function node(id: string, patch: Partial<NodeProjection> = {}): NodeProjection {
  return {
    id,
    children: [],
    content: plainText(id),
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    locked: false,
    autoCollected: false,
    toolbarVisible: false,
    filterValues: [],
    ...patch,
  } as NodeProjection;
}

describe('optimistic structural settlement', () => {
  test('stays pending until its real command settlement is bound', async () => {
    const settlement = createOptimisticStructuralSettlement();
    let observed: boolean | undefined;
    void settlement.current.then((value) => {
      observed = value;
    });

    await Promise.resolve();
    expect(observed).toBeUndefined();

    settlement.bind(Promise.resolve(true));
    await expect(settlement.current).resolves.toBe(true);
    expect(() => settlement.bind(Promise.resolve(false))).toThrow(
      'Optimistic structural settlement is already bound.',
    );
  });
});

describe('optimistic Backspace merge projection', () => {
  test('appends sibling source content and children to the target', () => {
    const target = node('target', {
      parentId: 'root',
      children: ['existing-child'],
      content: plainText('before'),
    });
    const source = node('source', {
      parentId: 'root',
      children: ['source-child'],
      content: plainText('after'),
    });

    const merged = optimisticMergedNode({
      target,
      source,
      sourceContent: source.content,
    });

    expect(merged.content.text).toBe('beforeafter');
    expect(merged.children).toEqual(['existing-child', 'source-child']);
    expect(target.children).toEqual(['existing-child']);
  });

  test('replaces a source child with its children when merging into its parent', () => {
    const target = node('target', {
      parentId: 'root',
      children: ['before-child', 'source', 'after-child'],
      content: plainText('parent'),
    });
    const source = node('source', {
      parentId: 'target',
      children: ['source-child-a', 'source-child-b'],
      content: plainText('tail'),
    });

    const merged = optimisticMergedNode({
      target,
      source,
      sourceContent: source.content,
    });

    expect(merged.children).toEqual([
      'before-child',
      'source-child-a',
      'source-child-b',
      'after-child',
    ]);
  });

  test('converts a reference target into a plain row with a leading inline reference', () => {
    const target = node('reference', {
      parentId: 'root',
      type: 'reference',
      targetId: 'referenced-node',
      content: plainText('ignored-reference-content'),
    });
    const source = node('source', {
      parentId: 'root',
      content: plainText('tail'),
    });

    const merged = optimisticMergedNode({
      target,
      source,
      sourceContent: source.content,
      resolvedReferenceTargetId: 'referenced-node',
      referenceDisplayName: 'Referenced',
    });

    expect(merged.type).toBeUndefined();
    expect(merged.targetId).toBeUndefined();
    expect(merged.content.text).toBe('tail');
    expect(merged.content.inlineRefs).toHaveLength(1);
    expect(inlineRefNodeId(merged.content.inlineRefs[0]!)).toBe('referenced-node');
    expect(merged.content.inlineRefs[0]?.displayName).toBe('Referenced');
  });
});
