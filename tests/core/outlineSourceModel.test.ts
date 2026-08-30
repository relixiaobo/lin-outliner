import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';
import { buildConfigIndex } from '../../src/core/configProjection';
import { classifyNodeSource, formatAssetSourceUri } from '../../src/core/source';
import { sourceFieldEntries, sourceFieldValues } from '../../src/core/sourceField';
import {
  SOURCE_FIELD_ID,
  plainText,
  replaceAllRichTextPatch,
  type DocumentState,
  type NodeId,
} from '../../src/core/types';

function focusedNodeId(outcome: ReturnType<Core['createNode']>): string {
  expect(outcome.focus).toBeDefined();
  return outcome.focus!.nodeId;
}

function uriValueIds(state: DocumentState, ownerId: NodeId): NodeId[] {
  return sourceFieldValues(state, ownerId).map((value) => value.node.id);
}

function uriTexts(state: DocumentState, ownerId: NodeId): string[] {
  return sourceFieldValues(state, ownerId).map((value) => value.sourceText);
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

describe('Outline URI field model', () => {
  test('bootstraps one URI definition without adding a field entry to every Node', () => {
    const core = Core.new();
    const ownerId = focusedNodeId(core.createNode(core.projection().libraryId, null, 'Resource'));
    const definition = core.state().nodes[SOURCE_FIELD_ID];

    expect(definition).toMatchObject({
      id: SOURCE_FIELD_ID,
      type: 'fieldDef',
      locked: true,
      content: { text: 'URI' },
    });
    expect(buildConfigIndex(core.state()).field(SOURCE_FIELD_ID)?.fieldType).toBe('uri');
    expect(sourceFieldEntries(core.state(), ownerId)).toEqual([]);
  });

  test('stores URI values as ordinary editable field value Nodes', () => {
    const core = Core.new();
    const ownerId = focusedNodeId(core.createNode(core.projection().libraryId, null, 'Resource'));

    core.addSource(ownerId, 'source:a', 'https://example.com/a.png');
    core.addSource(ownerId, 'source:b', formatAssetSourceUri('asset:report'), null);
    const entry = sourceFieldEntries(core.state(), ownerId)[0]!;

    expect(entry).toMatchObject({
      type: 'fieldEntry',
      parentId: ownerId,
      fieldDefId: SOURCE_FIELD_ID,
      locked: false,
    });
    expect(entry.id).not.toContain(`${ownerId}::source`);
    expect(uriValueIds(core.state(), ownerId)).toEqual(['source:b', 'source:a']);
    expect(core.state().nodes['source:a']).toEqual(expect.objectContaining({
      parentId: entry.id,
      content: plainText('https://example.com/a.png'),
      locked: false,
    }));

    core.applyNodeTextPatch(
      'source:a',
      replaceAllRichTextPatch(plainText('https://example.com/wrong-but-accessible')),
    );
    core.updateNodeDescription('source:a', 'Ordinary field value');
    expect(uriTexts(core.state(), ownerId)[1]).toBe('https://example.com/wrong-but-accessible');
    expect(core.state().nodes['source:a']?.description).toBe('Ordinary field value');
  });

  test('allows generic field mutation and deletion of the complete URI entry', () => {
    const core = Core.new();
    const ownerId = focusedNodeId(core.createNode(core.projection().libraryId, null, 'Editable'));

    core.updateFieldSlot(ownerId, SOURCE_FIELD_ID, {
      kind: 'appendText',
      text: 'not a valid URI',
      id: 'node:00000000-0000-4000-8000-000000000001',
    });
    const entry = sourceFieldEntries(core.state(), ownerId)[0]!;
    expect(uriTexts(core.state(), ownerId)).toEqual(['not a valid URI']);

    core.deleteNode(entry.id);
    expect(sourceFieldEntries(core.state(), ownerId)).toEqual([]);
    expect(core.state().nodes[ownerId]?.content.text).toBe('Editable');
  });

  test('keeps same-name user fields ordinary and binds source semantics only by definition id', () => {
    const core = Core.new();
    const tagId = focusedNodeId(core.createTag('resource'));
    const sourceEntryId = focusedNodeId(core.createFieldDef(tagId, 'Source', 'uri'));
    const uriEntryId = focusedNodeId(core.createFieldDef(tagId, 'URI', 'uri'));
    const sourceDefId = core.state().nodes[sourceEntryId]!.fieldDefId!;
    const uriDefId = core.state().nodes[uriEntryId]!.fieldDefId!;
    const ownerId = focusedNodeId(core.createNode(core.projection().libraryId, null, 'Resource'));
    core.applyTag(ownerId, tagId);

    core.updateFieldSlot(ownerId, sourceDefId, {
      kind: 'appendText',
      text: 'https://example.com/user-source',
    });
    core.updateFieldSlot(ownerId, uriDefId, {
      kind: 'appendText',
      text: 'https://example.com/user-uri',
    });
    expect(sourceFieldValues(core.state(), ownerId)).toEqual([]);

    core.updateFieldSlot(ownerId, SOURCE_FIELD_ID, {
      kind: 'appendText',
      text: 'https://example.com/built-in-uri',
    });
    expect(uriTexts(core.state(), ownerId)).toEqual(['https://example.com/built-in-uri']);
  });

  test('keeps the built-in definition identity locked without locking its entries', () => {
    const core = Core.new();
    const tagId = focusedNodeId(core.createTag('resource'));
    const templateEntryId = focusedNodeId(core.createFieldDef(tagId, 'Locator', 'uri'));
    const userDefId = core.state().nodes[templateEntryId]!.fieldDefId!;
    const ownerId = focusedNodeId(core.createNode(core.projection().libraryId, null, 'Resource'));
    core.updateFieldSlot(ownerId, userDefId, {
      kind: 'appendText',
      text: 'https://example.com/relinked',
    });
    const entryId = core.state().nodes[ownerId]!.children.find((childId) => (
      core.state().nodes[childId]?.type === 'fieldEntry'
    ))!;

    expect(() => core.mergeDefinitions(userDefId, [SOURCE_FIELD_ID])).toThrow('locked');
    expect(() => core.mergeDefinitions(SOURCE_FIELD_ID, [userDefId])).toThrow('locked');
    expect(() => core.reuseFieldDefinition(entryId, SOURCE_FIELD_ID)).not.toThrow();
    expect(sourceFieldEntries(core.state(), ownerId)[0]?.id).toBe(entryId);
    expect(core.state().nodes[entryId]?.locked).toBe(false);
  });

  test('keeps an edited web URI exact and derives preview state from the new text', () => {
    const core = Core.new();
    const ownerId = focusedNodeId(core.createNode(core.projection().libraryId, null, 'Video'));
    core.addSource(ownerId, 'source:video', 'https://www.youtube.com/watch?v=abc123');

    core.applyNodeTextPatch(
      'source:video',
      replaceAllRichTextPatch(plainText('https://www.youtub.com/watch?v=abc123')),
    );
    const editedText = uriTexts(core.state(), ownerId)[0]!;
    expect(editedText).toBe('https://www.youtub.com/watch?v=abc123');
    expect(classifyNodeSource(editedText)).toMatchObject({
      availability: 'ready',
      normalizedUri: 'https://www.youtub.com/watch?v=abc123',
    });

    core.applyNodeTextPatch(
      'source:video',
      replaceAllRichTextPatch(plainText('not a valid URI')),
    );
    const invalidText = uriTexts(core.state(), ownerId)[0]!;
    expect(invalidText).toBe('not a valid URI');
    expect(classifyNodeSource(invalidText)).toMatchObject({
      availability: 'invalid',
      reason: 'malformed-uri',
    });
  });

  test('keeps Source convenience commands as adapters over the ordinary field structure', () => {
    const core = Core.new();
    const ownerId = focusedNodeId(core.createNode(core.projection().libraryId, null, 'Resource'));
    core.addSource(ownerId, 'source:a', 'https://example.com/a');
    core.addSource(ownerId, 'source:b', 'https://example.com/b');

    core.replaceSource(ownerId, 'source:a', 'https://example.com/replaced');
    core.reorderSource(ownerId, 'source:a', null);
    expect(uriTexts(core.state(), ownerId)).toEqual([
      'https://example.com/replaced',
      'https://example.com/b',
    ]);

    core.removeSource(ownerId, 'source:a');
    expect(uriValueIds(core.state(), ownerId)).toEqual(['source:b']);
    core.clearSources(ownerId, ['source:b']);
    expect(sourceFieldEntries(core.state(), ownerId)).toEqual([]);
  });

  test('duplicates the URI entry and values through ordinary subtree cloning', () => {
    const core = Core.new();
    const ownerId = focusedNodeId(core.createNode(core.projection().libraryId, null, 'Original'));
    core.addSource(ownerId, 'source:first', 'https://example.com/first');
    core.addSource(ownerId, 'source:second', 'https://example.com/second');

    const cloneId = core.batchDuplicateNodes([ownerId]).focus!.nodeId;
    expect(cloneId).not.toBe(ownerId);
    expect(uriTexts(core.state(), cloneId)).toEqual(uriTexts(core.state(), ownerId));
    expect(sourceFieldEntries(core.state(), cloneId)[0]?.id)
      .not.toBe(sourceFieldEntries(core.state(), ownerId)[0]?.id);
    expect(uriValueIds(core.state(), cloneId)).not.toEqual(uriValueIds(core.state(), ownerId));
  });

  test('keeps concurrent first adds even when ordinary field convergence creates duplicate entries', () => {
    const seed = Core.new();
    const ownerId = focusedNodeId(seed.createNode(seed.projection().libraryId, null, 'Shared'));
    const state = converge(
      replicas(seed),
      (left) => left.addSource(ownerId, 'source:left', 'https://example.com/left'),
      (right) => right.addSource(ownerId, 'source:right', 'https://example.com/right'),
    );
    expect(new Set(uriTexts(state, ownerId))).toEqual(new Set([
      'https://example.com/left',
      'https://example.com/right',
    ]));
    expect(sourceFieldEntries(state, ownerId)).toHaveLength(2);
  });

  test('clearing the final value uses ordinary parent-deletion convergence', () => {
    const seed = Core.new();
    const ownerId = focusedNodeId(seed.createNode(seed.projection().libraryId, null, 'Shared'));
    seed.addSource(ownerId, 'source:observed', 'https://example.com/observed');
    const state = converge(
      replicas(seed),
      (left) => left.clearSources(ownerId, ['source:observed']),
      (right) => right.addSource(ownerId, 'source:unseen', 'https://example.com/unseen'),
    );
    expect(uriTexts(state, ownerId)).toEqual([]);
    expect(sourceFieldEntries(state, ownerId)).toEqual([]);
  });

  test('inherits ordinary tree convergence for concurrent add, reorder, and remove', () => {
    const seed = Core.new();
    const ownerId = focusedNodeId(seed.createNode(seed.projection().libraryId, null, 'Shared'));
    seed.addSource(ownerId, 'source:first', 'https://example.com/first');
    seed.addSource(ownerId, 'source:second', 'https://example.com/second');
    const addAndReorder = converge(
      replicas(seed),
      (left) => left.addSource(ownerId, 'source:third', 'https://example.com/third'),
      (right) => right.reorderSource(ownerId, 'source:second', null),
    );
    expect(new Set(uriValueIds(addAndReorder, ownerId))).toEqual(new Set([
      'source:first', 'source:second', 'source:third',
    ]));

    const removeAndReorder = converge(
      replicas(seed),
      (left) => left.removeSource(ownerId, 'source:second'),
      (right) => right.reorderSource(ownerId, 'source:second', null),
    );
    const convergedIds = uriValueIds(removeAndReorder, ownerId);
    expect(convergedIds).toContain('source:first');
    expect(new Set(convergedIds).size).toBe(convergedIds.length);
    expect(convergedIds.every((id) => id === 'source:first' || id === 'source:second')).toBe(true);
  });
});
