import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ActorRef, RuntimeAuthorizationCapability } from '../../src/core/agentIssue';
import { createAgentIssueToolRuntime } from '../../src/main/agentIssueRuntime';
import { AgentIssueStore } from '../../src/main/agentIssueStore';

const actor: ActorRef = { type: 'agent', agentId: 'built-in:tenon:assistant' };

async function withStore<T>(fn: (store: AgentIssueStore) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'lin-agent-issue-runtime-'));
  try {
    return await fn(AgentIssueStore.forAgentDataRoot(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('agent issue tool runtime authorization', () => {
  test('allows safe draft creation without a runtime authorization capability', async () => {
    await withStore(async (store) => {
      const runtime = createAgentIssueToolRuntime({ store, actor, now: () => 1_800_000_000_000 });
      const result = await runtime.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Daily news summary',
          cadence: { type: 'daily', time: '08:00' },
          timeZone: 'Asia/Shanghai',
          issueTemplate: {
            permissionMode: 'unattended',
            trigger: { type: 'when-ready' },
          },
        },
        request: { mode: 'request' },
        reason: 'Draft a daily summary routine.',
      });

      expect(result.status).toBe('applied');
      const row = (await runtime.search({ targets: ['recurring-issue'] })).rows[0];
      const read = await runtime.read({ target: row.target });
      expect(read.recurringIssue?.confirmation.state).toBe('draft');
    });
  });

  test('requires runtime-owned authorization for confirm and start', async () => {
    await withStore(async (store) => {
      const unauthorized = createAgentIssueToolRuntime({ store, actor, now: () => 100 });
      await unauthorized.create({
        issueType: 'issue',
        fields: { title: 'Write release report', trigger: { type: 'when-ready' } },
        request: { mode: 'request' },
        reason: 'Create executable work.',
      });
      const issue = (await unauthorized.search({ targets: ['issue'] })).rows[0];

      const confirmBlocked = await unauthorized.update({
        target: { type: 'issue', id: issue.target.id, expectedRevision: issue.revision },
        change: { type: 'confirm' },
        request: { mode: 'request' },
        reason: 'Confirm executable work.',
      });
      expect(confirmBlocked.status).toBe('needs-confirmation');

      const startBlocked = await unauthorized.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start work.',
      });
      expect(startBlocked.status).toBe('needs-confirmation');

      const authorization: RuntimeAuthorizationCapability = {
        id: 'auth:1',
        actor,
        allowedOperations: [
          { type: 'issue-update', issueId: issue.target.id },
          { type: 'agent-session-start', issueId: issue.target.id },
        ],
        expiresAt: 1_000,
        auditReason: 'User confirmed this Issue in the current runtime action.',
      };
      const authorized = createAgentIssueToolRuntime({ store, actor, authorization, now: () => 200 });
      const confirmed = await authorized.update({
        target: { type: 'issue', id: issue.target.id, expectedRevision: issue.revision },
        change: { type: 'confirm' },
        request: { mode: 'request' },
        reason: 'Confirm executable work.',
      });
      expect(confirmed.status).toBe('applied');
      const confirmedIssue = (await authorized.search({ targets: ['issue'] })).rows[0];

      const started = await authorized.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: confirmedIssue.revision,
        request: { mode: 'request' },
        reason: 'Start work.',
      });
      expect(started.status).toBe('applied');
      expect(started.targets.some((target) => target.type === 'agent-session')).toBe(true);
    });
  });
});
