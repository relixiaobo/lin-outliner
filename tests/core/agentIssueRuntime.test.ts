import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ActorRef, RuntimeAuthorizationCapability } from '../../src/core/agentIssue';
import { createAgentIssueToolRuntime, type AgentSessionExecutor } from '../../src/main/agentIssueRuntime';
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
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
      const read = await authorized.readSession({ agentSessionId: sessionId });
      expect(read?.agentSession.state).toBe('error');
      expect(read?.agentSession.errorMessage).toBe('No Agent Session executor is configured.');
    });
  });

  test('starts Agent Sessions through the configured runtime executor', async () => {
    await withStore(async (store) => {
      const authorization: RuntimeAuthorizationCapability = {
        id: 'auth:executor',
        actor,
        allowedOperations: [
          { type: 'issue-update' },
          { type: 'agent-session-start' },
        ],
        expiresAt: 1_000,
        auditReason: 'User confirmed this execution.',
      };
      const startedSessions: string[] = [];
      const executor: AgentSessionExecutor = {
        start: ({ session }) => {
          startedSessions.push(session.id);
          return {
            engine: 'delegation',
            conversationId: 'conversation:issue',
            executionId: 'execution:issue',
            startedAt: 300,
          };
        },
        read: async () => undefined,
      };
      const runtime = createAgentIssueToolRuntime({ store, actor, authorization, executor, now: () => 300 });
      await runtime.create({
        issueType: 'issue',
        fields: {
          title: 'Run through executor',
          trigger: { type: 'when-ready' },
          permissionMode: 'unattended',
        },
        request: { mode: 'request' },
        reason: 'Create executable issue.',
      });
      const issue = (await runtime.search({ targets: ['issue'] })).rows[0];
      await runtime.update({
        target: { type: 'issue', id: issue.target.id, expectedRevision: issue.revision },
        change: { type: 'confirm' },
        request: { mode: 'request' },
        reason: 'Confirm execution.',
      });
      const confirmed = (await runtime.search({ targets: ['issue'] })).rows[0];

      const started = await runtime.startSession({
        issueId: confirmed.target.id,
        expectedIssueRevision: confirmed.revision,
        request: { mode: 'request' },
        reason: 'Start execution.',
      });
      expect(started.status).toBe('applied');
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
      expect(startedSessions).toEqual([sessionId]);
      expect((await runtime.readSession({ agentSessionId: sessionId }))?.agentSession.state).toBe('active');

      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:issue',
        state: 'completed',
        latestOutput: 'Executor completed.',
        completedAt: 400,
      }, actor, 400);
      expect((await runtime.readSession({ agentSessionId: sessionId }))?.agentSession).toMatchObject({
        state: 'complete',
        latestOutput: 'Executor completed.',
      });
    });
  });
});
