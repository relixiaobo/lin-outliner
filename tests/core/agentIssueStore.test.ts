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
      const source: AgentSessionSource = { type: 'runtime-authorized-action', actor };

      const sessionResult = await store.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        detach: true,
        request: { mode: 'request' },
        reason: 'Start invoice processing.',
      }, source, actor, 200);

      expect(sessionResult.status).toBe('applied');
      const sessionTarget = sessionResult.targets.find((target) => target.type === 'agent-session');
      expect(sessionTarget).toBeDefined();
      const session = await store.readSession({ agentSessionId: sessionTarget!.id, include: ['activity-summary'] });
      expect(session?.agentSession.state).toBe('pending');
      expect(session?.agentSession.issueSnapshot.title).toBe('Summarize tagged invoices');
      expect(session?.activity?.[0]?.content.type).toBe('agent-progress');

      const transitioned = await store.update({
        target: { type: 'issue', id: issue.target.id, expectedRevision: issue.revision },
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
});
