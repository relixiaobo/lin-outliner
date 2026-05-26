import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';
import { freshNodeId, isClientNodeId } from '../../src/core/core';
import { replaceAllRichTextPatch } from '../../src/core/types';

function mustFocus<T extends { focus?: { nodeId: string } }>(outcome: T) {
  if (!outcome.focus) throw new Error('expected focus');
  return outcome.focus.nodeId;
}

const uuid = () => `node:${crypto.randomUUID()}`;

describe('createNode with a client-proposed id (eager materialization support)', () => {
  test('uses the proposed node:<uuid> id verbatim', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const id = uuid();
    const created = mustFocus(core.createNode(today, null, '你好', id));
    expect(created).toBe(id);
    const node = core.projection().nodes.find((candidate) => candidate.id === id);
    expect(node?.content.text).toBe('你好');
    expect(core.projection().nodes.find((n) => n.id === today)?.children).toContain(id);
  });

  test('re-materializing the same id under the same parent is idempotent (no duplicate)', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const id = uuid();
    mustFocus(core.createNode(today, null, '你', id));
    const again = mustFocus(core.createNode(today, null, 'ignored', id));
    expect(again).toBe(id);
    expect(core.projection().nodes.filter((n) => n.id === id).length).toBe(1);
    // The idempotent call does not overwrite the original content.
    expect(core.projection().nodes.find((n) => n.id === id)?.content.text).toBe('你');
    expect(core.projection().nodes.find((n) => n.id === today)?.children.filter((c) => c === id).length).toBe(1);
  });

  test('reusing an existing id under a DIFFERENT parent is rejected (no hijack backdoor)', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const id = uuid();
    const parentA = mustFocus(core.createNode(today, null, 'A'));
    mustFocus(core.createNode(parentA, null, 'child', id));
    expect(() => core.createNode(today, null, 'elsewhere', id)).toThrow();
  });

  test('rejects ids that are not node:<uuid> (reserved / forged)', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    expect(() => core.createNode(today, null, 'x', 'node:not-a-uuid')).toThrow();
    expect(() => core.createNode(today, null, 'x', 'trash')).toThrow();
    expect(() => core.createNode(today, null, 'x', 'ref:00000000-0000-0000-0000-000000000000')).toThrow();
  });

  test('omitting the id still generates a fresh node:<uuid> (behaviour preserved)', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const created = mustFocus(core.createNode(today, null, 'plain'));
    expect(created).toMatch(/^node:/);
    expect(isClientNodeId(created)).toBe(true);
    expect(core.projection().nodes.find((n) => n.id === created)?.content.text).toBe('plain');
  });

  test('isClientNodeId accepts freshId-shaped node ids and rejects others', () => {
    expect(isClientNodeId(`node:${crypto.randomUUID()}`)).toBe(true);
    expect(isClientNodeId('node:abc')).toBe(false);
    expect(isClientNodeId('ref:' + crypto.randomUUID())).toBe(false);
    expect(isClientNodeId('trash')).toBe(false);
  });

  test('freshNodeId produces a client-shaped id', () => {
    const id = freshNodeId();
    expect(isClientNodeId(id)).toBe(true);
  });

  // The DocumentService materialize path wraps the create + the text patches
  // that immediately follow in one undo group (beginUndoGroup/endUndoGroup).
  // This exercises the core mechanism that orchestration relies on.
  test('materialize undo group: create + following patches undo as a single step', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const id = freshNodeId();
    core.beginUndoGroup();
    core.createNode(today, null, '你', id);
    core.applyNodeTextPatch(id, replaceAllRichTextPatch({ text: '你好', marks: [], inlineRefs: [] }));
    core.endUndoGroup();
    expect(core.projection().nodes.find((n) => n.id === id)?.content.text).toBe('你好');

    core.undo();
    // Undo removes the whole node, never leaving a one-character orphan.
    expect(core.projection().nodes.find((n) => n.id === id)).toBeUndefined();
    expect(core.projection().nodes.find((n) => n.id === today)?.children).not.toContain(id);
  });
});
