import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';

function mustFocus<T extends { focus?: { nodeId: string } }>(outcome: T) {
  if (!outcome.focus) throw new Error('expected focus');
  return outcome.focus.nodeId;
}

describe('createNode with a client-supplied id (eager materialization support)', () => {
  test('uses the supplied id verbatim', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const id = 'node:client-supplied-1';
    const created = mustFocus(core.createNode(today, null, '你好', id));
    expect(created).toBe(id);
    const node = core.projection().nodes.find((candidate) => candidate.id === id);
    expect(node?.content.text).toBe('你好');
    expect(core.projection().nodes.find((n) => n.id === today)?.children).toContain(id);
  });

  test('re-materializing an existing id is idempotent (no duplicate node)', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const id = 'node:client-supplied-2';
    mustFocus(core.createNode(today, null, '你', id));
    const before = core.projection().nodes.filter((n) => n.id === id).length;
    const again = mustFocus(core.createNode(today, null, 'ignored', id));
    expect(again).toBe(id);
    const after = core.projection().nodes.filter((n) => n.id === id).length;
    expect(before).toBe(1);
    expect(after).toBe(1);
    // The original content is preserved; the idempotent call does not overwrite.
    expect(core.projection().nodes.find((n) => n.id === id)?.content.text).toBe('你');
    // The parent gained exactly one child for this id.
    const childCount = core.projection().nodes.find((n) => n.id === today)?.children.filter((c) => c === id).length;
    expect(childCount).toBe(1);
  });

  test('omitting the id still generates a fresh node:<uuid> (behaviour preserved)', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const created = mustFocus(core.createNode(today, null, 'plain'));
    expect(created).toMatch(/^node:/);
    expect(core.projection().nodes.find((n) => n.id === created)?.content.text).toBe('plain');
  });
});
