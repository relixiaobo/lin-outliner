import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';
import { inlineRefNodeId } from '../../src/core/types';

function mustFocus<T extends { focus?: { nodeId: string } }>(outcome: T) {
  if (!outcome.focus) throw new Error('expected focus');
  return outcome.focus.nodeId;
}

describe('merging a row into a reference node', () => {
  test('converts the reference into a leading inline reference on a plain node', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const alpha = mustFocus(core.createNode(today, null, 'Alpha'));
    // The reference lives under a different parent (a parent can't hold both a
    // node and a reference to it), with the text row as its sibling.
    const parent = mustFocus(core.createNode(today, null, 'Parent'));
    const refId = mustFocus(core.addReference(parent, alpha, null));
    const textId = mustFocus(core.createNode(parent, null, 'tail'));

    core.mergeNodeInto(textId, refId);

    const merged = core.projection().nodes.find((node) => node.id === refId);
    expect(merged).toBeDefined();
    // No longer a reference node — it became a plain node...
    expect(merged?.type).not.toBe('reference');
    // ...whose content is the original reference (now inline) followed by the
    // merged text.
    expect(merged?.content.text).toBe('tail');
    expect(merged?.content.inlineRefs.map((ref) => inlineRefNodeId(ref))).toEqual([alpha]);
    expect(merged?.content.inlineRefs[0]?.offset).toBe(0);
    // The merged source row is gone.
    expect(core.projection().nodes.find((node) => node.id === textId)).toBeUndefined();
  });

  test('merging into a plain node still just appends text (unchanged)', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const first = mustFocus(core.createNode(today, null, 'foo'));
    const second = mustFocus(core.createNode(today, null, 'bar'));

    core.mergeNodeInto(second, first);

    const merged = core.projection().nodes.find((node) => node.id === first);
    expect(merged?.content.text).toBe('foobar');
    expect(merged?.content.inlineRefs).toEqual([]);
  });
});
