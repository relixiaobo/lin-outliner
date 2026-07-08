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
  test('creates Recurring Issue automation as active work with provenance by default', async () => {
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
      const search = await store.search({ targets: ['recurring-issue'] });
      expect(search.rows).toHaveLength(1);
      const read = await store.read({ target: search.rows[0].target, include: ['activity'] });
      expect(read.recurringIssue?.confirmation.confirmedBy).toEqual(actor);
      expect(read.recurringIssue?.confirmation.confirmedAt).toBe(1_800_000_000_000);
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
            input: { type: 'tag-query', tag: 'news' },
          },
        },
        request: { mode: 'request' },
        reason: 'Create recurring work.',
      }, actor, 1_800_000_000_000);

      expect((await store.search({
        targets: ['recurring-issue'],
        filter: { statusCategories: ['triage'] },
      })).rows).toHaveLength(0);
      expect((await store.search({
        targets: ['recurring-issue'],
        filter: { statusCategories: ['scheduled'] },
      })).rows).toHaveLength(1);
      expect((await store.search({
        targets: ['recurring-issue'],
        filter: { delegateIds: ['background'], inputTags: ['#news'], triggerTypes: ['when-ready'] },
      })).rows).toHaveLength(1);

      await store.create({
        issueType: 'issue',
        fields: { title: 'Summarize tagged invoices', trigger: { type: 'when-ready' } },
        request: { mode: 'request' },
        reason: 'Create one-off work.',
      }, actor, 10);
      const issue = (await store.search({ targets: ['issue'], text: 'invoices' })).rows[0];
      const started = await store.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start one-off work.',
      }, { type: 'runtime-action', actor }, actor, 30);
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
      await store.sendSessionMessage({
        agentSessionId: sessionId,
        message: 'Inspect totals first.',
        kind: 'guidance',
        request: { mode: 'request' },
        reason: 'Add execution guidance.',
      }, actor, 40);

      expect((await store.search({
        targets: ['issue'],
        filter: { hasActiveSession: true },
      })).rows.map((row) => row.target.id)).toContain(issue.target.id);
      expect((await store.search({
        targets: ['issue'],
        filter: { activityTypes: ['agent-progress'] },
      })).rows.map((row) => row.target.id)).toContain(issue.target.id);
      const activityRows = await store.search({
        targets: ['issue'],
        include: ['activity-summary'],
      });
      const activityRow = activityRows.rows.find((row) => row.target.id === issue.target.id);
      expect(activityRow?.latestActivity).toMatchObject({
        content: { type: 'comment', body: 'Inspect totals first.' },
        createdAt: 40,
      });
      expect(activityRow?.activityCount).toBeGreaterThan(0);
    });
  });

  test('honors explicit Issue search ordering with missing values last', async () => {
    await withStore(async (store) => {
      for (const [title, targetAt] of [
        ['No due date', undefined],
        ['Due later', 300],
        ['Due earlier', 200],
      ] as const) {
        await store.create({
          issueType: 'issue',
          fields: {
            title,
            ...(targetAt !== undefined ? { dueDate: { targetAt, timeZone: 'UTC' } } : {}),
          },
          request: { mode: 'request' },
          reason: 'Create ordered work.',
        }, actor, targetAt ?? 100);
      }

      const ascending = await store.search({
        targets: ['issue'],
        orderBy: [{ field: 'dueDate', direction: 'asc' }],
      });
      expect(ascending.rows.map((row) => row.title)).toEqual(['Due earlier', 'Due later', 'No due date']);

      const descending = await store.search({
        targets: ['issue'],
        orderBy: [{ field: 'dueDate', direction: 'desc' }],
      });
      expect(descending.rows.map((row) => row.title)).toEqual(['Due later', 'Due earlier', 'No due date']);
    });
  });

  test('materializes active Recurring Issues only when due', async () => {
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

      expect(await store.materializeDueRecurringIssues(new Date(2026, 6, 7, 17, 59).getTime(), actor)).toEqual([]);

      const materialized = await store.materializeDueRecurringIssues(dueAt, actor);
      expect(materialized).toHaveLength(1);
      expect(materialized[0].title).toBe('Write daily report - 2026-07-07');
      expect(materialized[0].description).toBe('Summarize the work for 2026-07-07.');
      expect(materialized[0].trigger.type).toBe('when-ready');
      expect(materialized[0].confirmation.confirmedBy).toEqual(actor);
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

  test('skip-next advances a Recurring Issue without materializing or coalescing the skipped window', async () => {
    await withStore(async (store) => {
      const createdAt = new Date(2026, 6, 7, 17, 0).getTime();
      const firstWindow = new Date(2026, 6, 7, 18, 0).getTime();
      const firstDue = new Date(2026, 6, 7, 18, 5).getTime();
      const secondDue = new Date(2026, 6, 8, 18, 5).getTime();
      await store.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Daily review',
          cadence: { type: 'daily', time: '18:00' },
          timeZone: 'Asia/Shanghai',
          missedPolicy: { type: 'coalesce-latest' },
          issueTemplate: {
            delegate: { type: 'default-agent', runProfile: 'background' },
            trigger: { type: 'when-ready' },
            permissionMode: 'unattended',
          },
        },
        request: { mode: 'request' },
        reason: 'Create review routine.',
      }, actor, createdAt);
      const recurring = (await store.search({ targets: ['recurring-issue'] })).rows[0];
      await store.update({
        target: { type: 'recurring-issue', id: recurring.target.id, expectedRevision: recurring.revision },
        change: { type: 'skip-next' },
        request: { mode: 'request' },
        reason: 'Skip today.',
      }, actor, createdAt + 2);

      expect(await store.materializeDueRecurringIssues(firstDue, actor)).toEqual([]);
      const materialized = await store.materializeDueRecurringIssues(secondDue, actor);
      expect(materialized).toHaveLength(1);
      expect(materialized[0].title).toBe('Daily review - 2026-07-08');
      expect(materialized[0].recurrence?.skippedWindowCount).toBeUndefined();

      const read = await store.read({ target: recurring.target, include: ['activity', 'generated-issues'] });
      expect(read.recurringIssue?.skippedMaterializationAts).toEqual([firstWindow]);
      expect(read.activity).toEqual(expect.arrayContaining([
        expect.objectContaining({
          content: {
            type: 'agent-action',
            action: 'skip-next',
            parameter: String(firstWindow),
            result: 'recorded',
          },
        }),
      ]));
      expect(read.generatedIssues?.map((issue) => issue.title)).toEqual(['Daily review - 2026-07-08']);
    });
  });

  test('coalesces missed Recurring Issue windows into the latest concrete Issue', async () => {
    await withStore(async (store) => {
      const createdAt = new Date(2026, 6, 7, 17, 0).getTime();
      const laterDue = new Date(2026, 6, 10, 18, 5).getTime();
      await store.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Daily digest',
          cadence: { type: 'daily', time: '18:00' },
          timeZone: 'Asia/Shanghai',
          missedPolicy: { type: 'coalesce-latest' },
          issueTemplate: {
            delegate: { type: 'default-agent', runProfile: 'background' },
            trigger: { type: 'when-ready' },
            permissionMode: 'unattended',
          },
        },
        request: { mode: 'request' },
        reason: 'Create digest routine.',
      }, actor, createdAt);
      const recurring = (await store.search({ targets: ['recurring-issue'] })).rows[0];

      const materialized = await store.materializeDueRecurringIssues(laterDue, actor);
      expect(materialized).toHaveLength(1);
      expect(materialized[0].title).toBe('Daily digest - 2026-07-10');
      expect(materialized[0].recurrence).toMatchObject({
        recurringIssueId: recurring.target.id,
        skippedWindowCount: 3,
      });
      const read = await store.read({ target: recurring.target, include: ['activity', 'generated-issues'] });
      expect(read.generatedIssues?.map((issue) => issue.title)).toEqual(['Daily digest - 2026-07-10']);
      expect(read.activity).toEqual(expect.arrayContaining([
        expect.objectContaining({
          content: {
            type: 'agent-action',
            action: 'materialize',
            parameter: 'coalesced:3',
            result: materialized[0].id,
          },
        }),
      ]));
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

  test('delete lifecycle operations apply and keep Activity audit records', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: { title: 'Delete concrete work' },
        request: { mode: 'request' },
        reason: 'Create concrete work.',
      }, actor, 10);
      await store.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Delete routine',
          cadence: { type: 'daily', time: '09:00' },
          timeZone: 'UTC',
          issueTemplate: { permissionMode: 'unattended' },
        },
        request: { mode: 'request' },
        reason: 'Create recurring work.',
      }, actor, 20);
      const issue = (await store.search({ targets: ['issue'] })).rows[0];
      const recurringIssue = (await store.search({ targets: ['recurring-issue'] })).rows[0];

      const issueDelete = await store.update({
        target: { type: 'issue', id: issue.target.id, expectedRevision: issue.revision },
        change: { type: 'delete' },
        request: { mode: 'request' },
        reason: 'Delete concrete work.',
      }, actor, 30);
      const recurringDelete = await store.update({
        target: { type: 'recurring-issue', id: recurringIssue.target.id, expectedRevision: recurringIssue.revision },
        change: { type: 'delete' },
        request: { mode: 'request' },
        reason: 'Delete recurring work.',
      }, actor, 40);

      expect(issueDelete.status).toBe('applied');
      expect(recurringDelete.status).toBe('applied');
      expect((await store.search({ targets: ['issue'] })).rows).toEqual([]);
      expect((await store.search({ targets: ['recurring-issue'] })).rows).toEqual([]);
      const state = await store.state();
      expect(Object.values(state.activity)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          target: { type: 'issue', issueId: issue.target.id },
          content: { type: 'field-change', field: 'definition', to: 'deleted' },
        }),
        expect.objectContaining({
          target: { type: 'recurring-issue', recurringIssueId: recurringIssue.target.id },
          content: { type: 'field-change', field: 'definition', to: 'deleted' },
        }),
      ]));
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

      const read = await store.read({ target: parent.target, include: ['sub-issues', 'activity'] });
      expect(read.issue?.subIssueIds).toHaveLength(1);
      expect(read.subIssues?.[0]?.title).toBe('Write release notes');
      expect(read.activity).toEqual(expect.arrayContaining([
        expect.objectContaining({
          content: { type: 'agent-action', action: 'sub_issue_create', result: read.subIssues![0]!.id },
        }),
      ]));
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
      const source: AgentSessionSource = { type: 'runtime-action', actor };

      const sessionResult = await store.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
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

  test('blocks Agent Session starts that violate blocker or active-session rules', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: { title: 'Blocked starter', trigger: { type: 'when-ready' } },
        request: { mode: 'request' },
        reason: 'Create work.',
      }, actor, 10);
      const starter = (await store.search({ text: 'Blocked starter' })).rows[0];
      const source: AgentSessionSource = { type: 'runtime-action', actor };

      await store.create({
        issueType: 'issue',
        fields: { title: 'Blocking prerequisite' },
        request: { mode: 'request' },
        reason: 'Create blocker.',
      }, actor, 30);
      const blocker = (await store.search({ text: 'Blocking prerequisite' })).rows[0];
      await store.update({
        target: { type: 'issue', id: starter.target.id, expectedRevision: starter.revision },
        change: { type: 'patch', patch: { relations: [{ type: 'blocked-by', issueId: blocker.target.id }] } },
        request: { mode: 'request' },
        reason: 'Add dependency.',
      }, actor, 40);
      const patched = (await store.search({ text: 'Blocked starter' })).rows[0];
      const blockedStart = await store.startSession({
        issueId: patched.target.id,
        expectedIssueRevision: patched.revision,
        request: { mode: 'request' },
        reason: 'Start while blocked.',
      }, source, actor, 60);
      expect(blockedStart.status).toBe('blocked');
      expect(blockedStart.validation?.map((entry) => entry.code)).toContain('blocked_by_issue');

      await store.update({
        target: { type: 'issue', id: blocker.target.id, expectedRevision: blocker.revision },
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
      }
      const source: AgentSessionSource = { type: 'runtime-action', actor };
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
      const started = await store.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start work.',
      }, { type: 'runtime-action', actor }, actor, 120);
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
        latestOutput: '<analysis>internal chain of thought</analysis>\nLaunch risks summarized.',
        completedAt: 200,
      }, actor, 200);
      expect(synced?.state).toBe('complete');
      expect(synced?.latestOutput).toBe('<analysis>internal chain of thought</analysis>\nLaunch risks summarized.');
      const read = await store.readSession({ agentSessionId: sessionId, include: ['activity-summary'] });
      expect(read?.activity?.map((entry) => entry.content.type)).toContain('agent-response');
      expect(read?.activity?.find((entry) => entry.content.type === 'agent-response')?.content).toEqual({
        type: 'agent-response',
        body: 'Launch risks summarized.',
      });
    });
  });

  test('represents agent verification as a normal Agent Session with verdict Activity', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: { title: 'No verification policy' },
        request: { mode: 'request' },
        reason: 'Create unverified work.',
      }, actor, 90);
      const noPolicy = (await store.search({ text: 'No verification policy' })).rows[0];
      const blocked = await store.startSession({
        issueId: noPolicy.target.id,
        purpose: 'verify',
        expectedIssueRevision: noPolicy.revision,
        request: { mode: 'request' },
        reason: 'Try to verify without policy.',
      }, { type: 'runtime-action', actor }, actor, 96);
      expect(blocked.status).toBe('blocked');
      expect(blocked.validation?.map((entry) => entry.code)).toContain('missing_agent_review_policy');

      await store.create({
        issueType: 'issue',
        fields: {
          title: 'Verify launch checklist',
          verificationPolicy: {
            mode: 'agent-review',
            verifier: { type: 'default-agent', runProfile: 'verifier' },
            requiredVerdict: 'pass',
          },
        },
        request: { mode: 'request' },
        reason: 'Create verifiable work.',
      }, actor, 100);
      const issue = (await store.search({ text: 'Verify launch checklist' })).rows[0];
      const started = await store.startSession({
        issueId: issue.target.id,
        purpose: 'verify',
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start verifier.',
      }, { type: 'runtime-action', actor }, actor, 120);
      expect(started.status).toBe('applied');
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
      const session = await store.readSession({ agentSessionId: sessionId });
      expect(session?.agentSession).toMatchObject({
        purpose: 'verify',
        delegate: { type: 'default-agent', runProfile: 'verifier' },
      });

      await store.bindSessionExecution(sessionId, {
        engine: 'delegation',
        conversationId: 'conversation:verify',
        executionId: 'execution:verify',
        startedAt: 130,
      }, actor, 130);
      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:verify',
        state: 'completed',
        latestOutput: 'Verdict: pass\nAll checklist evidence is present.',
        completedAt: 140,
      }, actor, 140);

      const read = await store.read({ target: issue.target, include: ['activity'] });
      expect(read.issue?.evidence).toContainEqual({ type: 'agent-session', agentSessionId: sessionId });
      expect(read.activity).toEqual(expect.arrayContaining([
        expect.objectContaining({
          content: {
            type: 'verification-result',
            verdict: 'pass',
            body: 'Verdict: pass\nAll checklist evidence is present.',
            agentSessionId: sessionId,
          },
        }),
      ]));
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
      }, { type: 'runtime-action', actor }, actor, 120);

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
      const started = await store.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start work.',
      }, { type: 'runtime-action', actor }, actor, 20);
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
