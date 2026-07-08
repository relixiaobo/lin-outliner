import { describe, expect, test } from 'bun:test';
import type { AgentIssue, AgentSession } from '../../src/core/agentIssue';
import { agentSessionRunScope } from '../../src/main/agentIssueSessionScope';

describe('agent issue session scope', () => {
  test('maps Issue input and output node boundaries into run resources', () => {
    const session = sessionWith({
      inputSnapshot: {
        scope: { type: 'selected-nodes', nodeIds: ['node:input-a', 'node:input-b'] },
        resolvedAt: 1,
        nodeIds: ['node:input-a', 'node:input-b'],
      },
      outputSnapshot: { type: 'per-input-child', parentNodeId: 'node:output-parent' },
    });

    expect(agentSessionRunScope(session)).toEqual({
      resources: { nodes: ['node:input-a', 'node:input-b', 'node:output-parent'] },
    });
  });

  test('does not create a node resource scope for activity-only Issues without input nodes', () => {
    expect(agentSessionRunScope(sessionWith())).toBeUndefined();
  });
});

function sessionWith(overrides: Partial<AgentSession> = {}): AgentSession {
  const now = 1_000;
  const issue: AgentIssue = {
    id: 'issue-1',
    title: 'Scoped work',
    status: { name: 'Ready', category: 'unstarted' },
    relations: [],
    trigger: { type: 'when-ready' },
    permissionMode: 'unattended',
    confirmation: { confirmedBy: { type: 'user', userId: 'user-1' }, confirmedAt: now },
    revision: 'rev-1',
    createdAt: now,
    updatedAt: now,
  };
  return {
    id: 'session-1',
    issueId: issue.id,
    delegate: { type: 'default-agent' },
    state: 'pending',
    source: { type: 'manual', actor: { type: 'user', userId: 'user-1' } },
    issueSnapshot: issue,
    plan: [],
    revision: 'session-rev-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
