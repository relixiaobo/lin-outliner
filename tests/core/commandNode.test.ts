import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';

function mustFocus<T extends { focus?: { nodeId: string } }>(outcome: T) {
  expect(outcome.focus).toBeDefined();
  return outcome.focus!.nodeId;
}

function commandNode(core: Core, id: string) {
  const node = core.projection().nodes.find((entry) => entry.id === id);
  if (!node || node.type !== 'command') throw new Error(`not a command node: ${id}`);
  return node;
}

describe('Core.setCommandNode', () => {
  test('converts a plain row into a manual command node', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createNode(libraryId, null, 'Summarize my feeds'));

    core.setCommandNode(id);

    const node = commandNode(core, id);
    expect(node.type).toBe('command');
    expect(node.content.text).toBe('Summarize my feeds');
    expect(node.protectedFields ?? []).toEqual([]);
  });

  test('is idempotent and does not create config field rows', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createNode(libraryId, null, 'cmd'));

    core.setCommandNode(id);
    core.setCommandNode(id);

    const node = commandNode(core, id);
    const byId = new Map(core.projection().nodes.map((entry) => [entry.id, entry]));
    const fieldChildren = node.children
      .map((childId) => byId.get(childId))
      .filter((child) => child?.type === 'fieldEntry');
    expect(fieldChildren).toEqual([]);
  });

  test('refuses to convert a non-plain node', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createNode(libraryId, null, 'code'));
    core.setCodeBlock(id);

    expect(() => core.setCommandNode(id)).toThrow();
  });
});
