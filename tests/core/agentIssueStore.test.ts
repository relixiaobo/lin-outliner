import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentIssueStore } from '../../src/main/agentIssueStore';
import type { ActorRef, AgentSessionSource } from '../../src/core/agentIssue';

const actor: ActorRef = { type: 'agent', agentId: 'built-in:tenon:assistant' };

async function withStore<T>(fn: (store: AgentIssueStore) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'lin-agent-issue-store-'));
  try {
    return await fn(AgentIssueStore.forAgentDataRoot(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('agent issue store', () => {
  test('creates Recurring Issue drafts without confirming unattended execution', async () => {
    await withStore(async (store) => {
      const created = await store.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Write daily report - {{date}}',
          cadence: { type: 'daily', time: '18:00' },
          timeZone: 'Asia/Shanghai',
          issueTemplate: {
            delegate: { type: 'default-agent', runProfile: 'background' },
            trigger: { type: 'when-ready' },
            permissionMode: 'unattended',
            output: { type: 'activity-only' },
          },
        },
        request: { mode: 'request' },
        reason: 'Create the daily report routine.',
      }, actor, 1_800_000_000_000);

      expect(created.status).toBe('applied');
      const search = await store.search({ targets: ['recurring-issue'], filter: { confirmed: false } });
      expect(search.rows).toHaveLength(1);
      const read = await store.read({ target: search.rows[0].target, include: ['activity'] });
      expect(read.recurringIssue?.confirmation.state).toBe('draft');
      expect(read.recurringIssue?.status).toBe('active');
      expect(read.recurringIssue?.issueTemplate.permissionMode).toBe('unattended');
      expect(read.activity?.map((entry) => entry.content.type)).toContain('field-change');
    });
  });

  test('searches derived scheduled, active session, and Activity state', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Daily news - {{date}}',
          cadence: { type: 'daily', time: '08:00' },
          timeZone: 'Asia/Shanghai',
          issueTemplate: {
            delegate: { type: 'default-agent', runProfile: 'background' },
            trigger: { type: 'when-ready' },
            permissionMode: 'unattended',
          },
        },
        request: { mode: 'request' },
        reason: 'Create recurring work.',
      }, actor, 1_800_000_000_000);

      expect((await store.search({
        targets: ['recurring-issue'],
        filter: { statusCategories: ['triage'] },
      })).rows).toHaveLength(1);
      expect((await store.search({
        targets: ['recurring-issue'],
        filter: { statusCategories: ['scheduled'] },
      })).rows).toHaveLength(1);

      await store.create({
        issueType: 'issue',
        fields: { title: 'Summarize tagged invoices', trigger: { type: 'when-ready' } },
        request: { mode: 'request' },
        reason: 'Create one-off work.',
      }, actor, 10);
      const issue = (await store.search({ targets: ['issue'], text: 'invoices' })).rows[0];
      await store.update({
        target: { type: 'issue', id: issue.target.id, expectedRevision: issue.revision },
        change: { type: 'confirm' },
        request: { mode: 'request' },
        reason: 'Confirm one-off work.',
      }, actor, 20);
      const confirmed = (await store.search({ targets: ['issue'], text: 'invoices' })).rows[0];
      await store.startSession({
        issueId: confirmed.target.id,
        expectedIssueRevision: confirmed.revision,
        request: { mode: 'request' },
        reason: 'Start one-off work.',
      }, { type: 'runtime-authorized-action', actor }, actor, 30);

      expect((await store.search({
        targets: ['issue'],
        filter: { hasActiveSession: true },
      })).rows.map((row) => row.target.id)).toContain(confirmed.target.id);
      expect((await store.search({
        targets: ['issue'],
        filter: { activityTypes: ['agent-progress'] },
      })).rows.map((row) => row.target.id)).toContain(confirmed.target.id);
    });
  });

  test('materializes confirmed active Recurring Issues only when due', async () => {
    await withStore(async (store) => {
      const createdAt = new Date(2026, 6, 7, 17, 0).getTime();
      const dueAt = new Date(2026, 6, 7, 18, 5).getTime();
      await store.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Write daily report',
          descriptionTemplate: 'Summarize the work for {{date}}.',
          cadence: { type: 'daily', time: '18:00' },
          timeZone: 'Asia/Shanghai',
          issueTemplate: {
            delegate: { type: 'default-agent', runProfile: 'background' },
            trigger: { type: 'when-ready' },
            permissionMode: 'unattended',
            output: { type: 'activity-only' },
          },
        },
        request: { mode: 'request' },
        reason: 'Create a daily report routine.',
      }, actor, createdAt);
      const recurring = (await store.search({ targets: ['recurring-issue'] })).rows[0];

      expect(await store.materializeDueRecurringIssues(dueAt, actor)).toEqual([]);

      const confirmed = await store.update({
        target: { type: 'recurring-issue', id: recurring.target.id, expectedRevision: recurring.revision },
        change: { type: 'confirm' },
        request: { mode: 'request' },
        reason: 'Confirm the daily report routine.',
      }, actor, dueAt - 1);
      expect(confirmed.status).toBe('applied');

      const materialized = await store.materializeDueRecurringIssues(dueAt, actor);
      expect(materialized).toHaveLength(1);
      expect(materialized[0].title).toBe('Write daily report - 2026-07-07');
      expect(materialized[0].description).toBe('Summarize the work for 2026-07-07.');
      expect(materialized[0].trigger.type).toBe('when-ready');
      expect(materialized[0].confirmation.state).toBe('confirmed');
      expect(materialized[0].recurrence?.recurringIssueId).toBe(recurring.target.id);
      expect(await store.materializeDueRecurringIssues(dueAt, actor)).toEqual([]);

      const currentRecurring = (await store.search({ targets: ['recurring-issue'] })).rows[0];
      await store.update({
        target: { type: 'recurring-issue', id: recurring.target.id, expectedRevision: currentRecurring.revision },
        change: { type: 'pause' },
        request: { mode: 'request' },
        reason: 'Pause the daily report routine.',
      }, actor, dueAt + 1);
      const nextDayDue = new Date(2026, 6, 8, 18, 5).getTime();
      expect(await store.materializeDueRecurringIssues(nextDayDue, actor)).toEqual([]);
    });
  });

  test('previews do not persist Issues', async () => {
    await withStore(async (store) => {
      const preview = await store.create({
        issueType: 'issue',
        fields: { title: 'Preview only' },
        request: { mode: 'preview' },
        reason: 'Validate a possible issue.',
      }, actor);

      expect(preview.status).toBe('preview');
      expect((await store.search({ targets: ['issue'] })).rows).toHaveLength(0);
    });
  });

  test('links sub-issues through visible Issue hierarchy', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: {
          title: 'Prepare July release',
          completionCriteria: [{ id: 'criteria:1', text: 'Release checklist is complete.', state: 'open' }],
        },
        request: { mode: 'request' },
        reason: 'Track the July release outcome.',
      }, actor, 10);
      const parent = (await store.search({ text: 'July release' })).rows[0];

      await store.create({
        issueType: 'issue',
        fields: {
          title: 'Write release notes',
          parentIssueId: parent.target.id,
          trigger: { type: 'manual' },
        },
        request: { mode: 'request' },
        reason: 'Break release work into a visible sub-issue.',
      }, actor, 20);

      const read = await store.read({ target: parent.target, include: ['sub-issues'] });
      expect(read.issue?.subIssueIds).toHaveLength(1);
      expect(read.subIssues?.[0]?.title).toBe('Write release notes');
      const children = await store.search({ filter: { parentIssueIds: [parent.target.id] } });
      expect(children.rows.map((row) => row.title)).toEqual(['Write release notes']);
    });
  });

  test('creates pending Agent Sessions with Activity and rejects stale starts', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: {
          title: 'Summarize tagged invoices',
          delegate: { type: 'default-agent', runProfile: 'background' },
          input: { type: 'tag-query', tag: 'invoice' },
          output: { type: 'activity-only' },
        },
        request: { mode: 'request' },
        reason: 'Process invoice-tagged nodes.',
      }, actor, 100);
      const issue = (await store.search({ text: 'invoices' })).rows[0];
      expect((await store.search({
        targets: ['issue'],
        filter: { inputTags: ['invoice'] },
      })).rows.map((row) => row.target.id)).toContain(issue.target.id);
      const confirmed = await store.update({
        target: { type: 'issue', id: issue.target.id, expectedRevision: issue.revision },
        change: { type: 'confirm' },
        request: { mode: 'request' },
        reason: 'Confirm invoice processing.',
      }, actor, 150);
      expect(confirmed.status).toBe('applied');
      const confirmedIssue = (await store.search({ text: 'invoices' })).rows[0];
      const source: AgentSessionSource = { type: 'runtime-authorized-action', actor };

      const sessionResult = await store.startSession({
        issueId: confirmedIssue.target.id,
        expectedIssueRevision: confirmedIssue.revision,
        detach: true,
        request: { mode: 'request' },
        reason: 'Start invoice processing.',
      }, source, actor, 200, {
        resolveInput: (scope, _issue, now) => ({
          scope,
          resolvedAt: now,
          nodeIds: ['node:invoice-a', 'node:invoice-b'],
          preview: 'Resolved 2 invoice nodes.',
        }),
      });

      expect(sessionResult.status).toBe('applied');
      const sessionTarget = sessionResult.targets.find((target) => target.type === 'agent-session');
      expect(sessionTarget).toBeDefined();
      const session = await store.readSession({ agentSessionId: sessionTarget!.id, include: ['activity-summary'] });
      expect(session?.agentSession.state).toBe('pending');
      expect(session?.agentSession.issueSnapshot.title).toBe('Summarize tagged invoices');
      expect(session?.agentSession.inputSnapshot).toMatchObject({
        scope: { type: 'tag-query', tag: 'invoice' },
        resolvedAt: 200,
        nodeIds: ['node:invoice-a', 'node:invoice-b'],
        preview: 'Resolved 2 invoice nodes.',
      });
      expect(session?.activity?.[0]?.content.type).toBe('agent-progress');

      const transitioned = await store.update({
        target: { type: 'issue', id: confirmedIssue.target.id, expectedRevision: confirmedIssue.revision },
        change: { type: 'transition', status: { name: 'Started', category: 'started' } },
        request: { mode: 'request' },
        reason: 'Mark the Issue started.',
      }, actor, 300);
      expect(transitioned.status).toBe('applied');

      const stale = await store.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Retry from stale state.',
      }, source, actor, 400);
      expect(stale.status).toBe('conflict');

      const messageResult = await store.sendSessionMessage({
        agentSessionId: sessionTarget!.id,
        message: 'Narrow the summary to invoice totals only.',
        kind: 'guidance',
        request: { mode: 'request' },
        reason: 'Steer within the existing Issue scope.',
      }, actor, 500);
      expect(messageResult.status).toBe('applied');

      const stopResult = await store.stopSession({
        agentSessionId: sessionTarget!.id,
        request: { mode: 'request' },
        reason: 'Cancel this pending execution.',
      }, actor, 600);
      expect(stopResult.status).toBe('applied');
      const stopped = await store.readSession({ agentSessionId: sessionTarget!.id, include: ['activity-summary'] });
      expect(stopped?.agentSession.state).toBe('canceled');
      expect(stopped?.activity?.map((entry) => entry.content.type)).toEqual([
        'agent-progress',
        'comment',
        'agent-action',
      ]);
    });
  });

  test('blocks Agent Session starts that violate confirmation, blocker, or active-session rules', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: { title: 'Blocked starter', trigger: { type: 'when-ready' } },
        request: { mode: 'request' },
        reason: 'Create work.',
      }, actor, 10);
      const unconfirmed = (await store.search({ text: 'Blocked starter' })).rows[0];
      const source: AgentSessionSource = { type: 'runtime-authorized-action', actor };
      const unconfirmedStart = await store.startSession({
        issueId: unconfirmed.target.id,
        expectedIssueRevision: unconfirmed.revision,
        request: { mode: 'request' },
        reason: 'Start too early.',
      }, source, actor, 20);
      expect(unconfirmedStart.status).toBe('blocked');
      expect(unconfirmedStart.validation?.map((entry) => entry.code)).toContain('unconfirmed_issue');

      await store.create({
        issueType: 'issue',
        fields: { title: 'Blocking prerequisite' },
        request: { mode: 'request' },
        reason: 'Create blocker.',
      }, actor, 30);
      const blocker = (await store.search({ text: 'Blocking prerequisite' })).rows[0];
      await store.update({
        target: { type: 'issue', id: unconfirmed.target.id, expectedRevision: unconfirmed.revision },
        change: { type: 'patch', patch: { relations: [{ type: 'blocked-by', issueId: blocker.target.id }] } },
        request: { mode: 'request' },
        reason: 'Add dependency.',
      }, actor, 40);
      const patched = (await store.search({ text: 'Blocked starter' })).rows[0];
      await store.update({
        target: { type: 'issue', id: patched.target.id, expectedRevision: patched.revision },
        change: { type: 'confirm' },
        request: { mode: 'request' },
        reason: 'Confirm work.',
      }, actor, 50);
      const confirmed = (await store.search({ text: 'Blocked starter' })).rows[0];
      const blockedStart = await store.startSession({
        issueId: confirmed.target.id,
        expectedIssueRevision: confirmed.revision,
        request: { mode: 'request' },
        reason: 'Start while blocked.',
      }, source, actor, 60);
      expect(blockedStart.status).toBe('blocked');
      expect(blockedStart.validation?.map((entry) => entry.code)).toContain('blocked_by_issue');

      await store.update({
        target: { type: 'issue', id: blocker.target.id, expectedRevision: blocker.revision },
        change: { type: 'confirm' },
        request: { mode: 'request' },
        reason: 'Confirm blocker.',
      }, actor, 70);
      const confirmedBlocker = (await store.search({ text: 'Blocking prerequisite' })).rows[0];
      await store.update({
        target: { type: 'issue', id: blocker.target.id, expectedRevision: confirmedBlocker.revision },
        change: { type: 'transition', status: { name: 'Done', category: 'completed' } },
        request: { mode: 'request' },
        reason: 'Complete blocker.',
      }, actor, 80);
      const unblocked = (await store.search({ text: 'Blocked starter' })).rows[0];
      const firstStart = await store.startSession({
        issueId: unblocked.target.id,
        expectedIssueRevision: unblocked.revision,
        request: { mode: 'request' },
        reason: 'Start after blocker.',
      }, source, actor, 90);
      expect(firstStart.status).toBe('applied');

      const secondStart = await store.startSession({
        issueId: unblocked.target.id,
        expectedIssueRevision: unblocked.revision,
        request: { mode: 'request' },
        reason: 'Start duplicate session.',
      }, source, actor, 100);
      expect(secondStart.status).toBe('blocked');
      expect(secondStart.validation?.map((entry) => entry.code)).toContain('active_session_exists');
    });
  });

  test('validates Agent Session continuation identity and terminal state', async () => {
    await withStore(async (store) => {
      for (const title of ['Continuation target', 'Different issue']) {
        await store.create({
          issueType: 'issue',
          fields: { title },
          request: { mode: 'request' },
          reason: 'Create issue.',
        }, actor, 10);
        const row = (await store.search({ text: title })).rows[0];
        await store.update({
          target: { type: 'issue', id: row.target.id, expectedRevision: row.revision },
          change: { type: 'confirm' },
          request: { mode: 'request' },
          reason: 'Confirm issue.',
        }, actor, 20);
      }
      const source: AgentSessionSource = { type: 'runtime-authorized-action', actor };
      const target = (await store.search({ text: 'Continuation target' })).rows[0];
      const other = (await store.search({ text: 'Different issue' })).rows[0];
      const started = await store.startSession({
        issueId: target.target.id,
        expectedIssueRevision: target.revision,
        request: { mode: 'request' },
        reason: 'Initial start.',
      }, source, actor, 30);
      const previousSessionId = started.targets.find((entry) => entry.type === 'agent-session')!.id;
      await store.markInterruptedSessionsStale({ type: 'system' }, 40);

      const mismatch = await store.startSession({
        issueId: other.target.id,
        expectedIssueRevision: other.revision,
        continuation: { previousAgentSessionId: previousSessionId, intent: 'continue' },
        request: { mode: 'request' },
        reason: 'Continue from wrong issue.',
      }, source, actor, 50);
      expect(mismatch.status).toBe('blocked');
      expect(mismatch.validation?.map((entry) => entry.code)).toContain('previous_session_issue_mismatch');

      const continuation = await store.startSession({
        issueId: target.target.id,
        expectedIssueRevision: target.revision,
        continuation: { previousAgentSessionId: previousSessionId, intent: 'retry', guidance: 'Try again.' },
        request: { mode: 'request' },
        reason: 'Retry terminal session.',
      }, source, actor, 60);
      expect(continuation.status).toBe('applied');
      const nextSessionId = continuation.targets.find((entry) => entry.type === 'agent-session')!.id;
      const read = await store.readSession({ agentSessionId: nextSessionId });
      expect(read?.agentSession.continuationOfAgentSessionId).toBe(previousSessionId);

      const activeContinuation = await store.startSession({
        issueId: target.target.id,
        expectedIssueRevision: target.revision,
        continuation: { previousAgentSessionId: nextSessionId, intent: 'continue' },
        request: { mode: 'request' },
        reason: 'Continue active session.',
      }, source, actor, 70);
      expect(activeContinuation.status).toBe('blocked');
      expect(activeContinuation.validation?.map((entry) => entry.code)).toEqual(expect.arrayContaining([
        'active_session_exists',
        'previous_session_not_terminal',
      ]));
    });
  });

  test('binds Agent Sessions to runtime execution and syncs terminal state', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: {
          title: 'Research launch risks',
          trigger: { type: 'when-ready' },
          permissionMode: 'unattended',
        },
        request: { mode: 'request' },
        reason: 'Create executable work.',
      }, actor, 100);
      const issue = (await store.search({ targets: ['issue'] })).rows[0];
      await store.update({
        target: { type: 'issue', id: issue.target.id, expectedRevision: issue.revision },
        change: { type: 'confirm' },
        request: { mode: 'request' },
        reason: 'Confirm execution.',
      }, actor, 110);
      const confirmed = (await store.search({ targets: ['issue'] })).rows[0];
      const started = await store.startSession({
        issueId: confirmed.target.id,
        expectedIssueRevision: confirmed.revision,
        request: { mode: 'request' },
        reason: 'Start work.',
      }, { type: 'runtime-authorized-action', actor }, actor, 120);
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;

      const bound = await store.bindSessionExecution(sessionId, {
        engine: 'delegation',
        conversationId: 'conversation:issue',
        executionId: 'execution:1',
        startedAt: 130,
      }, actor, 130);
      expect(bound.status).toBe('applied');
      expect((await store.readSession({ agentSessionId: sessionId }))?.agentSession.state).toBe('active');

      const synced = await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:1',
        state: 'completed',
        latestOutput: 'Launch risks summarized.',
        completedAt: 200,
      }, actor, 200);
      expect(synced?.state).toBe('complete');
      expect(synced?.latestOutput).toBe('Launch risks summarized.');
      const read = await store.readSession({ agentSessionId: sessionId, include: ['activity-summary'] });
      expect(read?.activity?.map((entry) => entry.content.type)).toContain('agent-response');
    });
  });

  test('lists ready Issues once and excludes Issues that already have a Session', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: { title: 'Manual only', trigger: { type: 'manual' } },
        request: { mode: 'request' },
        reason: 'Create manual issue.',
      }, actor, 10);
      await store.create({
        issueType: 'issue',
        fields: { title: 'Ready now', trigger: { type: 'when-ready' } },
        request: { mode: 'request' },
        reason: 'Create ready issue.',
      }, actor, 20);
      await store.create({
        issueType: 'issue',
        fields: { title: 'Scheduled later', trigger: { type: 'scheduled', startAt: 500, timeZone: 'UTC' } },
        request: { mode: 'request' },
        reason: 'Create scheduled issue.',
      }, actor, 30);
      const rows = await store.search({ targets: ['issue'] });
      for (const row of rows.rows) {
        await store.update({
          target: { type: 'issue', id: row.target.id, expectedRevision: row.revision },
          change: { type: 'confirm' },
          request: { mode: 'request' },
          reason: 'Confirm issue.',
        }, actor, 40);
      }

      expect((await store.listReadyIssuesForExecution(100)).map((issue) => issue.title)).toEqual(['Ready now']);
      expect((await store.search({ filter: { hasActiveSession: false } })).rows.map((row) => row.title).sort()).toEqual([
        'Manual only',
        'Ready now',
        'Scheduled later',
      ]);

      const ready = (await store.search({ text: 'Ready now' })).rows[0];
      await store.startSession({
        issueId: ready.target.id,
        expectedIssueRevision: ready.revision,
        request: { mode: 'request' },
        reason: 'Auto start once.',
      }, { type: 'runtime-authorized-action', actor }, actor, 120);

      expect(await store.listReadyIssuesForExecution(600)).toEqual(expect.arrayContaining([
        expect.objectContaining({ title: 'Scheduled later' }),
      ]));
      expect((await store.listReadyIssuesForExecution(600)).map((issue) => issue.title)).not.toContain('Ready now');
    });
  });

  test('marks interrupted live Agent Sessions stale on recovery', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: { title: 'Recover interrupted session' },
        request: { mode: 'request' },
        reason: 'Create recoverable work.',
      }, actor, 10);
      const issue = (await store.search({ targets: ['issue'] })).rows[0];
      await store.update({
        target: { type: 'issue', id: issue.target.id, expectedRevision: issue.revision },
        change: { type: 'confirm' },
        request: { mode: 'request' },
        reason: 'Confirm recoverable work.',
      }, actor, 15);
      const confirmedIssue = (await store.search({ targets: ['issue'] })).rows[0];
      const started = await store.startSession({
        issueId: confirmedIssue.target.id,
        expectedIssueRevision: confirmedIssue.revision,
        request: { mode: 'request' },
        reason: 'Start work.',
      }, { type: 'runtime-authorized-action', actor }, actor, 20);
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
      await store.bindSessionExecution(sessionId, {
        engine: 'delegation',
        conversationId: 'conversation:issue',
        executionId: 'execution:interrupted',
        startedAt: 30,
      }, actor, 30);

      const stale = await store.markInterruptedSessionsStale({ type: 'system' }, 40);
      expect(stale.map((session) => session.id)).toEqual([sessionId]);
      const read = await store.readSession({ agentSessionId: sessionId, include: ['activity-summary'] });
      expect(read?.agentSession).toMatchObject({
        state: 'stale',
        errorMessage: 'Agent Session was interrupted before runtime restore.',
        completedAt: 40,
      });
      expect(read?.activity?.at(-1)?.content.type).toBe('agent-error');

      expect(await store.markInterruptedSessionsStale({ type: 'system' }, 50)).toEqual([]);
    });
  });
});
