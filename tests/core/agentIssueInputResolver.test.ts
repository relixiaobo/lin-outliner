import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';
import type { AgentIssue } from '../../src/core/agentIssue';
import { resolveIssueInputScopeFromProjection } from '../../src/main/agentIssueInputResolver';

function mustFocus<T extends { focus?: { nodeId: string } }>(outcome: T) {
  expect(outcome.focus).toBeDefined();
  return outcome.focus!.nodeId;
}

describe('agent issue input resolver', () => {
  test('resolves tag-query scopes to concrete node snapshots', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const invoiceTag = mustFocus(core.createTag('invoice'));
    const invoiceA = mustFocus(core.createNode(today, null, 'Invoice A'));
    const invoiceB = mustFocus(core.createNode(today, null, 'Invoice B'));
    const note = mustFocus(core.createNode(today, null, 'Plain note'));
    core.applyTag(invoiceA, invoiceTag);
    core.applyTag(invoiceB, invoiceTag);
    core.trashNode(invoiceB);

    const issue = { id: 'issue:1', title: 'Process invoices' } as AgentIssue;
    const resolved = resolveIssueInputScopeFromProjection(
      { type: 'tag-query', tag: '#invoice' },
      issue,
      core.projection(),
      1_800_000_000_000,
    );

    expect(resolved.scope).toEqual({ type: 'tag-query', tag: '#invoice' });
    expect(resolved.resolvedAt).toBe(1_800_000_000_000);
    expect(resolved.nodeIds).toEqual([invoiceA]);
    expect(resolved.nodeIds).not.toContain(invoiceB);
    expect(resolved.nodeIds).not.toContain(note);
    expect(resolved.preview).toContain('Process invoices');
    expect(resolved.preview).toContain('Invoice A #invoice');
  });

  test('resolves bounded child scopes without storing work state in nodes', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const parent = mustFocus(core.createNode(today, null, 'Parent'));
    const child = mustFocus(core.createNode(parent, null, 'Child'));
    const grandchild = mustFocus(core.createNode(child, null, 'Grandchild'));

    const issue = { id: 'issue:2', title: 'Process children' } as AgentIssue;
    const resolved = resolveIssueInputScopeFromProjection(
      { type: 'node-children', nodeId: parent, depth: 1 },
      issue,
      core.projection(),
      1_800_000_000_001,
    );

    expect(resolved.nodeIds).toEqual([child]);
    expect(resolved.nodeIds).not.toContain(parent);
    expect(resolved.nodeIds).not.toContain(grandchild);
  });
});
