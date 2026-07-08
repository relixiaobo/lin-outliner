import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ActorRef } from '../../src/core/agentIssue';
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

describe('agent issue tool runtime execution', () => {
  test('creates scheduled recurring work with runtime provenance by default', async () => {
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
        reason: 'Create a daily summary routine.',
      });

      expect(result.status).toBe('applied');
      const row = (await runtime.search({ targets: ['recurring-issue'] })).rows[0];
      const read = await runtime.read({ target: row.target });
      expect(read.recurringIssue?.confirmation.confirmedBy).toEqual(actor);
      expect(read.recurringIssue?.confirmation.confirmedAt).toBe(1_800_000_000_000);
      expect(read.recurringIssue?.status).toBe('active');
    });
  });

  test('starts Issue work without a separate approval handoff', async () => {
    await withStore(async (store) => {
      const runtime = createAgentIssueToolRuntime({ store, actor, now: () => 100 });
      await runtime.create({
        issueType: 'issue',
        fields: { title: 'Write release report', trigger: { type: 'when-ready' } },
        request: { mode: 'request' },
        reason: 'Create executable work.',
      });
      const issue = (await runtime.search({ targets: ['issue'] })).rows[0];
      const readIssue = await runtime.read({ target: issue.target });
      expect(readIssue.issue?.confirmation.confirmedBy).toEqual(actor);

      const started = await runtime.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start work.',
      });
      expect(started.status).toBe('applied');
      expect(started.targets.some((target) => target.type === 'agent-session')).toBe(true);
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
      const read = await runtime.readSession({ agentSessionId: sessionId });
      expect(read?.agentSession.state).toBe('error');
      expect(read?.agentSession.errorMessage).toBe('No Agent Session executor is configured.');
    });
  });

  test('updates lifecycle and starts through an executor without approval handoff', async () => {
    await withStore(async (store) => {
      const executorStarts: string[] = [];
      const executor: AgentSessionExecutor = {
        start: ({ session }) => {
          executorStarts.push(session.id);
          return {
            engine: 'delegation',
            conversationId: 'conversation:silent-start',
            executionId: 'execution:silent-start',
            startedAt: 500,
          };
        },
      };
      await store.create({
        issueType: 'issue',
        fields: {
          title: 'Silent issue start',
          trigger: { type: 'when-ready' },
          permissionMode: 'unattended',
        },
        request: { mode: 'request' },
        reason: 'Create executable issue.',
      }, actor, 100);
      const issue = (await store.search({ targets: ['issue'] })).rows[0];
      const runtime = createAgentIssueToolRuntime({
        store,
        actor,
        executor,
        now: () => 500,
      });

      const transitioned = await runtime.update({
        target: { type: 'issue', id: issue.target.id, expectedRevision: issue.revision },
        change: { type: 'transition', status: { name: 'Started', category: 'started' } },
        request: { mode: 'request' },
        reason: 'Mark as started before execution.',
      });
      expect(transitioned.status).toBe('applied');
      const updatedIssue = (await store.search({ targets: ['issue'] })).rows[0];

      const started = await runtime.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: updatedIssue.revision,
        request: { mode: 'request' },
        reason: 'Start without a separate approval handoff.',
      });
      expect(started.status).toBe('applied');
      expect(executorStarts).toHaveLength(1);
    });
  });

  test('starts Agent Sessions through the configured runtime executor', async () => {
    await withStore(async (store) => {
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
      const runtime = createAgentIssueToolRuntime({ store, actor, executor, now: () => 300 });
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

      const started = await runtime.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
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
