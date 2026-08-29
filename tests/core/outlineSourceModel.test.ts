import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';
import { formatAssetSourceUri } from '../../src/core/source';
import {
  SOURCE_FIELD_ID,
  sourceEntryNodeId,
  type DocumentState,
  type NodeId,
} from '../../src/core/types';

function focusedNodeId(outcome: ReturnType<Core['createNode']>): string {
  expect(outcome.focus).toBeDefined();
  return outcome.focus!.nodeId;
}

function sourceValueIds(state: DocumentState, ownerId: NodeId): NodeId[] {
  return state.nodes[sourceEntryNodeId(ownerId)]!.children;
}

function sourceTexts(state: DocumentState, ownerId: NodeId): string[] {
  return sourceValueIds(state, ownerId).map((valueId) => {
    const value = state.nodes[valueId];
    expect(value?.type).toBe('sourceValue');
    return value.type === 'sourceValue' ? value.sourceText : '';
  });
}

function replicas(seed: Core): { left: Core; right: Core; leftBase: Uint8Array; rightBase: Uint8Array } {
  const shared = seed.exportSharedState();
  const left = Core.fromSharedState(shared, { installationId: crypto.randomUUID() });
  const right = Core.fromSharedState(shared, { installationId: crypto.randomUUID() });
  return {
    left,
    right,
    leftBase: left.replicationVersionVector(),
    rightBase: right.replicationVersionVector(),
  };
}

function converge(
  pair: ReturnType<typeof replicas>,
  mutateLeft: (core: Core) => void,
  mutateRight: (core: Core) => void,
): DocumentState {
  mutateLeft(pair.left);
  mutateRight(pair.right);
  const leftUpdate = pair.left.exportReplicationUpdate(pair.leftBase);
  const rightUpdate = pair.right.exportReplicationUpdate(pair.rightBase);
  pair.left.applyReplicationUpdates([rightUpdate]);
  pair.right.applyReplicationUpdates([leftUpdate]);
  expect(pair.left.state()).toEqual(pair.right.state());
  return pair.left.state();
}

describe('Outline Source model', () => {
  test('creates one exact permanent Source entry and executes all five Source commands', () => {
    const core = Core.new();
    const ownerId = focusedNodeId(core.createNode(core.projection().libraryId, null, 'Resource'));
    const entryId = sourceEntryNodeId(ownerId);
    const initial = core.state();

    expect(initial.nodes[ownerId]!.children).toContain(entryId);
    expect(initial.nodes[entryId]).toMatchObject({
      id: entryId,
      type: 'fieldEntry',
      parentId: ownerId,
      fieldDefId: SOURCE_FIELD_ID,
      locked: true,
      children: [],
    });

    core.addSource(ownerId, 'source:a', 'https://example.com/a.png');
    core.addSource(ownerId, 'source:b', formatAssetSourceUri('asset:report'), null);
    expect(sourceValueIds(core.state(), ownerId)).toEqual(['source:b', 'source:a']);
    expect(core.state().nodes['source:a']).toEqual(expect.objectContaining({
      type: 'sourceValue',
      parentId: entryId,
      sourceText: 'https://example.com/a.png',
      locked: true,
    }));
    expect(Object.keys(core.state().nodes['source:a']!).sort()).toEqual([
      'children', 'createdAt', 'id', 'locked', 'parentId', 'sourceText', 'type', 'updatedAt',
    ]);

    core.replaceSource(ownerId, 'source:a', 'https://example.com/replaced.png');
    core.reorderSource(ownerId, 'source:a', null);
    expect(sourceTexts(core.state(), ownerId)).toEqual([
      'https://example.com/replaced.png',
      formatAssetSourceUri('asset:report'),
    ]);

    core.removeSource(ownerId, 'source:a');
    expect(sourceValueIds(core.state(), ownerId)).toEqual(['source:b']);
    core.clearSources(ownerId, ['source:b']);
    expect(sourceValueIds(core.state(), ownerId)).toEqual([]);
    expect(core.state().nodes[entryId]).toBeDefined();
    expect(core.state().nodes[ownerId]?.content.text).toBe('Resource');
  });

  test('blocks generic edits, movement, deletion, cloning, and field-slot mutation of Source structure', () => {
    const core = Core.new();
    const ownerId = focusedNodeId(core.createNode(core.projection().libraryId, null, 'Protected'));
    const entryId = sourceEntryNodeId(ownerId);
    core.addSource(ownerId, 'source:protected', 'https://example.com/file.pdf');

    expect(() => core.updateNodeDescription(entryId, 'Bypass')).toThrow();
    expect(() => core.updateNodeDescription('source:protected', 'Bypass')).toThrow();
    expect(() => core.moveNode('source:protected', core.projection().libraryId, null)).toThrow();
    expect(() => core.deleteNode('source:protected')).toThrow();
    expect(() => core.batchDuplicateNodes(['source:protected'])).toThrow();
    expect(() => core.createNode(entryId, null, 'Bypass')).toThrow('structurally locked');
    expect(() => core.updateFieldSlot(ownerId, SOURCE_FIELD_ID, {
      kind: 'appendText',
      text: 'https://example.com/bypass',
    })).toThrow('dedicated Source commands');
  });

  test('duplicates a complete owner with a fresh permanent entry and copied ordered values', () => {
    const core = Core.new();
    const ownerId = focusedNodeId(core.createNode(core.projection().libraryId, null, 'Original'));
    core.addSource(ownerId, 'source:first', 'https://example.com/first');
    core.addSource(ownerId, 'source:second', 'https://example.com/second');

    const cloneId = core.batchDuplicateNodes([ownerId]).focus!.nodeId;
    expect(cloneId).not.toBe(ownerId);
    expect(sourceEntryNodeId(cloneId)).not.toBe(sourceEntryNodeId(ownerId));
    expect(sourceTexts(core.state(), cloneId)).toEqual(sourceTexts(core.state(), ownerId));
    expect(sourceValueIds(core.state(), cloneId)).not.toEqual(sourceValueIds(core.state(), ownerId));
  });

  test('observed clear preserves an unseen concurrent add', () => {
    const seed = Core.new();
    const ownerId = focusedNodeId(seed.createNode(seed.projection().libraryId, null, 'Shared'));
    seed.addSource(ownerId, 'source:observed', 'https://example.com/observed');
    const state = converge(
      replicas(seed),
      (left) => left.clearSources(ownerId, ['source:observed']),
      (right) => right.addSource(ownerId, 'source:unseen', 'https://example.com/unseen'),
    );
    expect(sourceTexts(state, ownerId)).toEqual(['https://example.com/unseen']);
  });

  test('converges concurrent add/add', () => {
    const seed = Core.new();
    const ownerId = focusedNodeId(seed.createNode(seed.projection().libraryId, null, 'Shared'));
    const state = converge(
      replicas(seed),
      (left) => left.addSource(ownerId, 'source:left', 'https://example.com/left'),
      (right) => right.addSource(ownerId, 'source:right', 'https://example.com/right'),
    );
    expect(new Set(sourceTexts(state, ownerId))).toEqual(new Set([
      'https://example.com/left',
      'https://example.com/right',
    ]));
  });

  test('converges concurrent add/reorder', () => {
    const seed = Core.new();
    const ownerId = focusedNodeId(seed.createNode(seed.projection().libraryId, null, 'Shared'));
    seed.addSource(ownerId, 'source:first', 'https://example.com/first');
    seed.addSource(ownerId, 'source:second', 'https://example.com/second');
    const state = converge(
      replicas(seed),
      (left) => left.addSource(ownerId, 'source:third', 'https://example.com/third'),
      (right) => right.reorderSource(ownerId, 'source:second', null),
    );
    expect(new Set(sourceValueIds(state, ownerId))).toEqual(new Set([
      'source:first', 'source:second', 'source:third',
    ]));
  });

  test('converges concurrent add/remove and remove wins over reorder', () => {
    const seed = Core.new();
    const ownerId = focusedNodeId(seed.createNode(seed.projection().libraryId, null, 'Shared'));
    seed.addSource(ownerId, 'source:first', 'https://example.com/first');
    seed.addSource(ownerId, 'source:second', 'https://example.com/second');
    const state = converge(
      replicas(seed),
      (left) => {
        left.addSource(ownerId, 'source:third', 'https://example.com/third');
        left.removeSource(ownerId, 'source:second');
      },
      (right) => right.reorderSource(ownerId, 'source:second', null),
    );
    expect(sourceValueIds(state, ownerId)).toContain('source:third');
    expect(sourceValueIds(state, ownerId)).not.toContain('source:second');
  });

  test('converges concurrent scalar replace/replace without splicing text', () => {
    const seed = Core.new();
    const ownerId = focusedNodeId(seed.createNode(seed.projection().libraryId, null, 'Shared'));
    seed.addSource(ownerId, 'source:value', 'https://example.com/original');
    const state = converge(
      replicas(seed),
      (left) => left.replaceSource(ownerId, 'source:value', 'https://left.example/value'),
      (right) => right.replaceSource(ownerId, 'source:value', 'https://right.example/value'),
    );
    expect([
      'https://left.example/value',
      'https://right.example/value',
    ]).toContain(sourceTexts(state, ownerId)[0]);
  });
});
