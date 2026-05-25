import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';

function mustFocus<T extends { focus?: { nodeId: string } }>(outcome: T) {
  expect(outcome.focus).toBeDefined();
  return outcome.focus!.nodeId;
}

describe('Core.createImageNode', () => {
  test('creates an image node carrying the asset id and intrinsic size', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createImageNode(libraryId, null, {
      assetId: 'asset-abc',
      width: 120,
      height: 80,
      alt: 'A photo',
    }));

    const node = core.projection().nodes.find((entry) => entry.id === id);
    expect(node).toMatchObject({
      type: 'image',
      parentId: libraryId,
      assetId: 'asset-abc',
      imageWidth: 120,
      imageHeight: 80,
      mediaAlt: 'A photo',
    });
  });

  test('preserves the asset id across trash and restore', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createImageNode(libraryId, null, { assetId: 'asset-keep' }));

    core.trashNode(id);
    core.restoreNode(id);

    const node = core.projection().nodes.find((entry) => entry.id === id);
    expect(node?.assetId).toBe('asset-keep');
  });

  test('rejects an empty asset id', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    expect(() => core.createImageNode(libraryId, null, { assetId: '   ' })).toThrow();
  });
});
