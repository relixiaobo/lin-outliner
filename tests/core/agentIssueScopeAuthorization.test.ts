import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';
import type { AgentIssue, AgentSession } from '../../src/core/agentIssue';
import { validateChildIssueNodeScope } from '../../src/main/agentIssueScopeAuthorization';

describe('child Issue scope authorization', () => {
  test('allows descendants but rejects nodes outside the parent Session ceiling', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const allowedRoot = mustFocus(core.createNode(today, null, 'Allowed root'));
    const allowedChild = mustFocus(core.createNode(allowedRoot, null, 'Allowed child'));
    const outside = mustFocus(core.createNode(today, null, 'Outside root'));
    const parentSession = sessionWithNodeRoots([allowedRoot], allowedRoot);

    expect(validateChildIssueNodeScope(parentSession, {
      input: { type: 'selected-nodes', nodeIds: [allowedChild] },
      resolvedInput: {
        scope: { type: 'selected-nodes', nodeIds: [allowedChild] },
        resolvedAt: 1,
        nodeIds: [allowedChild],
      },
      output: { type: 'append-to-node', nodeId: allowedChild },
    }, core.projection())).toEqual([]);

    expect(validateChildIssueNodeScope(parentSession, {
      input: { type: 'tag-query', tag: 'dynamic' },
      resolvedInput: {
        scope: { type: 'tag-query', tag: 'dynamic' },
        resolvedAt: 2,
        nodeIds: [outside],
      },
    }, core.projection())).toContainEqual(expect.objectContaining({
      code: 'child_scope_broadened',
    }));
  });

  test('treats an empty parent Session node scope as an absolute deny-all ceiling', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const outside = mustFocus(core.createNode(today, null, 'Denied node'));
    expect(validateChildIssueNodeScope(sessionWithNodeRoots([]), {
      output: { type: 'create-child-under-node', nodeId: outside },
    }, core.projection())).toContainEqual(expect.objectContaining({
      code: 'child_scope_broadened',
    }));
  });

  test('does not promote a parent read-only input into a child writable output', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const inputNode = mustFocus(core.createNode(today, null, 'Read-only parent input'));
    expect(validateChildIssueNodeScope(sessionWithNodeRoots([inputNode]), {
      output: { type: 'append-to-node', nodeId: inputNode },
    }, core.projection())).toContainEqual(expect.objectContaining({
      code: 'child_scope_broadened',
      path: 'output',
    }));
  });
});

function sessionWithNodeRoots(nodeIds: string[], writableNodeId?: string): AgentSession {
  const issue: AgentIssue = {
    id: 'issue:parent',
    title: 'Parent',
    status: { name: 'Started', category: 'started' },
    relations: [],
    trigger: { type: 'when-ready' },
    permissionMode: 'unattended',
    confirmation: { confirmedBy: { type: 'system' }, confirmedAt: 1 },
    revision: 'rev:issue',
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    id: 'agent-session:parent',
    issueId: issue.id,
    delegate: { type: 'default-agent' },
    state: 'active',
    source: { type: 'runtime-action', actor: { type: 'system' } },
    issueSnapshot: issue,
    inputSnapshot: {
      scope: { type: 'selected-nodes', nodeIds },
      resolvedAt: 1,
      nodeIds,
    },
    ...(writableNodeId ? { outputSnapshot: { type: 'append-to-node' as const, nodeId: writableNodeId } } : {}),
    revision: 'rev:session',
    createdAt: 1,
    updatedAt: 1,
  };
}

function mustFocus<T extends { focus?: { nodeId: string } }>(outcome: T): string {
  if (!outcome.focus) throw new Error('Expected focused node id.');
  return outcome.focus.nodeId;
}
