import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AGENT_ISSUE_STORE_FILE, AgentIssueStore } from '../../src/main/agentIssueStore';
import type { ActorRef, AgentSessionSource, IssueDraftFields } from '../../src/core/agentIssue';

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
  test('treats older Issue store generations as a clean empty state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-agent-issue-store-legacy-'));
    try {
      await writeFile(path.join(root, AGENT_ISSUE_STORE_FILE), JSON.stringify({
        v: 1,
        issues: {
          'issue:legacy': {
            id: 'issue:legacy',
            title: 'Old Issue',
            status: { name: 'Triage', category: 'triage' },
            trigger: { type: 'when-ready' },
            permissionMode: 'unattended',
            confirmation: { confirmedBy: actor, confirmedAt: 1 },
            revision: 'rev:1',
            createdAt: 1,
            updatedAt: 1,
          },
        },
      }), 'utf8');

      const store = AgentIssueStore.forAgentDataRoot(root);
      expect((await store.search({ targets: ['issue'] })).rows).toEqual([]);

      await store.create({
        issueType: 'issue',
        fields: { title: 'Current Issue' },
        request: { mode: 'request' },
        reason: 'Create current work.',
      }, actor, 10);

      const persisted = JSON.parse(await readFile(path.join(root, AGENT_ISSUE_STORE_FILE), 'utf8'));
      expect(persisted.v).toBe(5);
      expect(Object.keys(persisted.issues)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('blocks malformed create payloads instead of throwing or persisting partial objects', async () => {
    await withStore(async (store) => {
      const missingIssueTitle = await store.create({
        issueType: 'issue',
        fields: {},
        request: { mode: 'request' },
        reason: 'Reject missing title.',
      } as never, actor, 10);
      expect(missingIssueTitle.status).toBe('blocked');
      expect(missingIssueTitle.validation?.map((entry) => entry.path)).toContain('fields.title');

      const missingRecurringContract = await store.create({
        issueType: 'recurring-issue',
        fields: {
          cadence: { type: 'daily', time: '09:00' },
          timeZone: 'UTC',
        },
        request: { mode: 'request' },
        reason: 'Reject missing recurring contract.',
      } as never, actor, 20);
      expect(missingRecurringContract.status).toBe('blocked');
      expect(missingRecurringContract.validation?.map((entry) => entry.path)).toEqual(expect.arrayContaining([
        'fields.titleTemplate',
        'fields.issueTemplate',
      ]));
      const malformedScheduled = await store.create({
        issueType: 'issue',
        fields: { title: 'Malformed schedule', trigger: { type: 'scheduled' } },
        request: { mode: 'request' },
        reason: 'Reject an incomplete scheduled trigger.',
      } as never, actor, 30);
      expect(malformedScheduled.status).toBe('blocked');
      expect(malformedScheduled.validation?.map((entry) => entry.code)).toEqual(expect.arrayContaining([
        'invalid_trigger_start',
        'invalid_trigger_time_zone',
      ]));

      const malformedRecurringTrigger = await store.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Malformed recurring template',
          cadence: { type: 'daily', time: '09:00' },
          timeZone: 'UTC',
          issueTemplate: { permissionMode: 'unattended', trigger: { type: 'scheduled' } },
        },
        request: { mode: 'request' },
        reason: 'Reject an incomplete recurring template trigger.',
      } as never, actor, 40);
      expect(malformedRecurringTrigger.status).toBe('blocked');
      expect(malformedRecurringTrigger.validation?.map((entry) => entry.code)).toContain('invalid_trigger_start');
      expect((await store.search({})).rows).toEqual([]);
    });
  });

  test('validates every discriminated input and output policy on create and patch', async () => {
    await withStore(async (store) => {
      const invalidPolicies: Array<{ field: 'input' | 'output'; value: unknown; code: string }> = [
        { field: 'input', value: { type: 'selected-nodes', nodeIds: [] }, code: 'invalid_input_scope' },
        { field: 'input', value: { type: 'node-children' }, code: 'invalid_input_scope' },
        { field: 'input', value: { type: 'tag-query', tag: '' }, code: 'invalid_input_scope' },
        { field: 'input', value: { type: 'saved-query' }, code: 'invalid_input_scope' },
        { field: 'output', value: { type: 'daily-note' }, code: 'invalid_output_policy' },
        { field: 'output', value: { type: 'append-to-node' }, code: 'invalid_output_policy' },
        { field: 'output', value: { type: 'create-child-under-node' }, code: 'invalid_output_policy' },
        { field: 'output', value: { type: 'per-input-child' }, code: 'invalid_output_policy' },
        { field: 'output', value: { type: 'replace-input', requiresConfirmation: false }, code: 'invalid_output_policy' },
      ];

      for (const [index, candidate] of invalidPolicies.entries()) {
        const created = await store.create({
          issueType: 'issue',
          fields: { title: `Invalid policy ${index}`, [candidate.field]: candidate.value },
          request: { mode: 'request' },
          reason: 'Reject an incomplete policy variant.',
        } as never, actor, 10 + index);
        expect(created.status).toBe('blocked');
        expect(created.validation?.map((entry) => entry.code)).toContain(candidate.code);
      }

      await store.create({
        issueType: 'issue',
        fields: { title: 'Patch policy target' },
        request: { mode: 'request' },
        reason: 'Create a patch target.',
      }, actor, 100);
      const issue = (await store.search({ text: 'Patch policy target' })).rows[0];
      for (const candidate of invalidPolicies) {
        const patched = await store.update({
          target: { type: 'issue', id: issue.target.id, expectedRevision: issue.revision },
          change: { type: 'patch', patch: { [candidate.field]: candidate.value } },
          request: { mode: 'request' },
          reason: 'Reject an incomplete policy patch.',
        } as never, actor, 200);
        expect(patched.status).toBe('blocked');
        expect(patched.validation?.map((entry) => entry.code)).toContain(candidate.code);
      }

      const invalidRecurringCreate = await store.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Invalid recurring policy',
          cadence: { type: 'daily', time: '09:00' },
          timeZone: 'UTC',
          issueTemplate: {
            permissionMode: 'unattended',
            output: { type: 'append-to-node' },
          },
        },
        request: { mode: 'request' },
        reason: 'Reject an invalid recurring template.',
      } as never, actor, 300);
      expect(invalidRecurringCreate.status).toBe('blocked');
      expect(invalidRecurringCreate.validation?.map((entry) => entry.code)).toContain('invalid_output_policy');

      await store.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Recurring patch target',
          cadence: { type: 'daily', time: '09:00' },
          timeZone: 'UTC',
          issueTemplate: { permissionMode: 'unattended' },
        },
        request: { mode: 'request' },
        reason: 'Create a recurring patch target.',
      }, actor, 310);
      const recurring = (await store.search({ text: 'Recurring patch target' })).rows[0];
      const invalidRecurringPatch = await store.update({
        target: { type: 'recurring-issue', id: recurring.target.id, expectedRevision: recurring.revision },
        change: {
          type: 'patch',
          patch: {
            issueTemplate: {
              permissionMode: 'unattended',
              input: { type: 'selected-nodes', nodeIds: [] },
            },
          },
        },
        request: { mode: 'request' },
        reason: 'Reject an invalid recurring template patch.',
      } as never, actor, 320);
      expect(invalidRecurringPatch.status).toBe('blocked');
      expect(invalidRecurringPatch.validation?.map((entry) => entry.code)).toContain('invalid_input_scope');
    });
  });

  test('blocks Session start for unresolved saved-query inputs', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: {
          title: 'Saved query execution',
          input: { type: 'saved-query', queryId: 'query:unimplemented' },
        },
        request: { mode: 'request' },
        reason: 'Create saved-query work.',
      }, actor, 100);
      const issue = (await store.search({ text: 'Saved query execution' })).rows[0];
      const started = await store.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Reject unresolved saved-query execution.',
      }, { type: 'runtime-action', actor }, actor, 110);
      expect(started.status).toBe('blocked');
      expect(started.validation).toContainEqual(expect.objectContaining({
        code: 'saved_query_not_supported',
        path: 'input',
      }));
      const preview = await store.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'preview' },
        reason: 'Preview unresolved saved-query execution.',
      }, { type: 'runtime-action', actor }, actor, 110);
      expect(preview.status).toBe('blocked');
      expect(preview.validation?.map((entry) => entry.code)).toContain('saved_query_not_supported');
      expect((await store.listReadyIssuesForExecution(110)).map((candidate) => candidate.id))
        .toContain(issue.target.id);
    });
  });

  test('binds prepared execution to the Issue revision and request mode', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: {
          title: 'Prepared Daily Note',
          output: { type: 'daily-note', datePolicy: 'session-date' },
        },
        request: { mode: 'request' },
        reason: 'Create prepared work.',
      }, actor, 100);
      const row = (await store.search({ text: 'Prepared Daily Note' })).rows[0]!;
      const source: AgentSessionSource = { type: 'runtime-action', actor };

      const preview = await store.startSession({
        issueId: row.target.id,
        expectedIssueRevision: row.revision,
        request: { mode: 'preview' },
        reason: 'Preview without creating the date node.',
      }, source, actor, 110, {
        preparedExecution: {
          issueRevision: row.revision,
          mode: 'preview',
          outputSnapshot: { type: 'daily-note', datePolicy: 'session-date' },
          warnings: [],
        },
      });
      expect(preview.status).toBe('preview');

      const wrongMode = await store.startSession({
        issueId: row.target.id,
        expectedIssueRevision: row.revision,
        request: { mode: 'request' },
        reason: 'Reject a preview plan at the execution boundary.',
      }, source, actor, 111, {
        preparedExecution: {
          issueRevision: row.revision,
          mode: 'preview',
          outputSnapshot: { type: 'daily-note', datePolicy: 'session-date' },
          warnings: [],
        },
      });
      expect(wrongMode.validation?.map((entry) => entry.code)).toEqual(expect.arrayContaining([
        'prepared_execution_mode_mismatch',
        'daily_note_output_not_supported',
      ]));

      const started = await store.startSession({
        issueId: row.target.id,
        expectedIssueRevision: row.revision,
        request: { mode: 'request' },
        reason: 'Start from a concrete prepared destination.',
      }, source, actor, 112, {
        preparedExecution: {
          issueRevision: row.revision,
          mode: 'request',
          outputSnapshot: { type: 'create-child-under-node', nodeId: 'node:day' },
          warnings: [],
        },
      });
      expect(started.status).toBe('applied');
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
      expect((await store.readSession({ agentSessionId: sessionId }))?.agentSession.outputSnapshot).toEqual({
        type: 'create-child-under-node',
        nodeId: 'node:day',
      });
    });
  });

  test('records preparation failures as one visible terminal Session', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: {
          title: 'Broken prepared work',
          input: { type: 'saved-query', queryId: 'query:missing' },
        },
        request: { mode: 'request' },
        reason: 'Create a legacy unsupported definition.',
      }, actor, 100, {
        origin: { type: 'conversation', conversationId: 'conversation:preparation-failure' },
      });
      const row = (await store.search({ text: 'Broken prepared work' })).rows[0]!;
      const failed = await store.recordSessionPreparationFailure({
        issueId: row.target.id,
        expectedIssueRevision: row.revision,
        request: { mode: 'request' },
        reason: 'Record the failed execution boundary.',
      }, { type: 'runtime-action', actor }, [{
        path: 'input',
        code: 'saved_query_not_supported',
        message: 'Saved query resolution is unavailable.',
      }], actor, 110);

      expect(failed.status).toBe('blocked');
      const sessionId = failed.targets.find((target) => target.type === 'agent-session')!.id;
      const session = (await store.readSession({
        agentSessionId: sessionId,
        include: ['activity-summary'],
      }))!;
      expect(session.agentSession).toMatchObject({
        state: 'error',
        errorMessage: 'Saved query resolution is unavailable.',
        completedAt: 110,
      });
      expect(session.activity).toContainEqual(expect.objectContaining({
        content: expect.objectContaining({ type: 'agent-error' }),
      }));
      expect(await store.listReadyIssuesForExecution(111)).toEqual([]);
      expect(Object.values((await store.state()).terminalDeliveries)).toHaveLength(1);
    });
  });

  test('allows Session deadline overrides to narrow but never broaden or revive the Issue policy', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: {
          title: 'Deadline execution policy',
          executionPolicy: { deadlineAt: 10_000 },
        },
        request: { mode: 'request' },
        reason: 'Create deadline-bound work.',
      }, actor, 100);
      const issue = (await store.search({ text: 'Deadline execution policy' })).rows[0];

      const widerDeadline = await store.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        executionPolicyOverride: { deadlineAt: 10_001 },
        request: { mode: 'request' },
        reason: 'Reject a wider deadline.',
      }, { type: 'runtime-action', actor }, actor, 200);
      expect(widerDeadline.status).toBe('blocked');
      expect(widerDeadline.validation).toContainEqual(expect.objectContaining({
        code: 'execution_policy_broadened',
        path: 'executionPolicyOverride.deadlineAt',
      }));

      const narrowed = await store.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        executionPolicyOverride: { deadlineAt: 9_000 },
        request: { mode: 'request' },
        reason: 'Narrow the execution budget.',
      }, { type: 'runtime-action', actor }, actor, 200);
      expect(narrowed.status).toBe('applied');
      const sessionId = narrowed.targets.find((target) => target.type === 'agent-session')!.id;
      expect((await store.readSession({ agentSessionId: sessionId }))?.agentSession.executionPolicy).toEqual({
        deadlineAt: 9_000,
      });

      await store.markInterruptedSessionsStale(actor, 10_000);
      const expired = await store.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Reject execution after its deadline.',
      }, { type: 'runtime-action', actor }, actor, 10_001);
      expect(expired.status).toBe('blocked');
      expect(expired.validation).toContainEqual(expect.objectContaining({
        code: 'execution_deadline_elapsed',
        path: 'executionPolicy.deadlineAt',
      }));
    });
  });

  test('uses the default one-hour deadline as the ceiling for Session overrides', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: { title: 'Default execution policy ceiling' },
        request: { mode: 'request' },
        reason: 'Create default policy work.',
      }, actor, 100);
      const issue = (await store.search({ text: 'Default execution policy ceiling' })).rows[0];
      const broadened = await store.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        executionPolicyOverride: { deadlineAt: 3_600_101 },
        request: { mode: 'request' },
        reason: 'Reject broader defaults.',
      }, { type: 'runtime-action', actor }, actor, 100);
      expect(broadened.status).toBe('blocked');
      expect(broadened.validation?.map((entry) => entry.path)).toContain('executionPolicyOverride.deadlineAt');
    });
  });

  test('surfaces expired when-ready and scheduled Issues as attention instead of silently dropping them', async () => {
    await withStore(async (store) => {
      for (const [title, trigger] of [
        ['Expired when-ready work', { type: 'when-ready' as const }],
        ['Expired scheduled work', { type: 'scheduled' as const, startAt: 150, timeZone: 'UTC' }],
      ] as const) {
        await store.create({
          issueType: 'issue',
          fields: {
            title,
            trigger,
            executionPolicy: { deadlineAt: 200 },
          },
          request: { mode: 'request' },
          reason: 'Create work whose execution window will expire.',
        }, actor, 100);
      }

      expect(await store.listReadyIssuesForExecution(201)).toEqual([]);
      const attentionRows = await store.search({
        targets: ['issue'],
        filter: { needsAttention: true },
      });
      expect(attentionRows.rows.map((row) => row.title).sort()).toEqual([
        'Expired scheduled work',
        'Expired when-ready work',
      ]);
      const scheduled = await store.search({
        targets: ['issue'],
        filter: { statusCategories: ['scheduled'] },
      });
      expect(scheduled.rows.map((row) => row.title)).toEqual(['Expired scheduled work']);
    });
  });

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
      expect(read.activity?.map((entry) => entry.content.type)).toContain('created');
    });
  });

  for (const [label, cadence, timeZone, expectedCode] of [
    ['time', { type: 'daily', time: '9:00' }, 'UTC', 'invalid_cadence_time'],
    ['time zone', { type: 'daily', time: '09:00' }, 'Not/A_Time_Zone', 'invalid_time_zone'],
    ['weekdays', { type: 'weekly', weekdays: [], time: '09:00' }, 'UTC', 'invalid_weekdays'],
    ['day of month', { type: 'monthly', dayOfMonth: 0, time: '09:00' }, 'UTC', 'invalid_day_of_month'],
  ] as const) {
    test(`rejects an invalid Recurring Issue ${label}`, async () => {
      await withStore(async (store) => {
        const result = await store.create({
          issueType: 'recurring-issue',
          fields: {
            titleTemplate: 'Invalid routine',
            cadence: cadence as never,
            timeZone,
            issueTemplate: { permissionMode: 'unattended' },
          },
          request: { mode: 'request' },
          reason: 'Reject an invalid schedule.',
        }, actor, 100);

        expect(result.status).toBe('blocked');
        expect(result.validation?.map((entry) => entry.code)).toContain(expectedCode);
        expect((await store.search({ targets: ['recurring-issue'] })).rows).toEqual([]);
      });
    });
  }

  test('validates the merged Recurring Issue schedule before applying a patch', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Valid routine',
          cadence: { type: 'daily', time: '09:00' },
          timeZone: 'UTC',
          issueTemplate: { permissionMode: 'unattended' },
        },
        request: { mode: 'request' },
        reason: 'Create a valid schedule.',
      }, actor, 100);
      const original = (await store.search({ targets: ['recurring-issue'] })).rows[0];

      const invalidCadence = await store.update({
        target: { type: 'recurring-issue', id: original.target.id, expectedRevision: original.revision },
        change: { type: 'patch', patch: { cadence: { type: 'weekly', weekdays: [], time: '09:00' } } },
        request: { mode: 'request' },
        reason: 'Reject an empty weekly cadence.',
      }, actor, 110);
      expect(invalidCadence.status).toBe('blocked');
      expect(invalidCadence.validation?.map((entry) => entry.code)).toContain('invalid_weekdays');

      const invalidTimeZone = await store.update({
        target: { type: 'recurring-issue', id: original.target.id, expectedRevision: original.revision },
        change: { type: 'patch', patch: { timeZone: 'Not/A_Time_Zone' } },
        request: { mode: 'request' },
        reason: 'Reject an invalid time zone.',
      }, actor, 120);
      expect(invalidTimeZone.status).toBe('blocked');
      expect(invalidTimeZone.validation?.map((entry) => entry.code)).toContain('invalid_time_zone');

      const current = await store.read({ target: original.target });
      expect(current.recurringIssue).toMatchObject({
        cadence: { type: 'daily', time: '09:00' },
        timeZone: 'UTC',
        revision: original.revision,
      });
    });
  });

  test('rejects cross-family operations, fields, and incomplete patch payloads', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Family-safe routine',
          cadence: { type: 'daily', time: '09:00' },
          timeZone: 'UTC',
          issueTemplate: { permissionMode: 'unattended' },
        },
        request: { mode: 'request' },
        reason: 'Create recurring work.',
      }, actor, 100);
      const recurring = (await store.search({ targets: ['recurring-issue'] })).rows[0];

      for (const change of [
        { type: 'transition', status: { name: 'Completed', category: 'completed' } },
        { type: 'patch', patch: { title: 'Wrong family field' } },
        { type: 'patch' },
        { type: 'patch', patch: {} },
        { type: 'pause', patch: { cadence: { type: 'daily', time: '10:00' } } },
      ]) {
        const result = await store.update({
          target: { type: 'recurring-issue', id: recurring.target.id, expectedRevision: recurring.revision },
          change,
          request: { mode: 'request' },
          reason: 'Reject a malformed recurring update.',
        } as never, actor, 110);
        expect(result.status).toBe('blocked');
      }

      const current = await store.read({ target: recurring.target });
      expect(current.recurringIssue).toMatchObject({
        titleTemplate: 'Family-safe routine',
        revision: recurring.revision,
      });
      expect(current.recurringIssue).not.toHaveProperty('title');
    });
  });

  test('canonicalizes the Local time-zone alias before persistence', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Local routine',
          cadence: { type: 'daily', time: '09:00' },
          timeZone: 'Local',
          issueTemplate: { permissionMode: 'unattended' },
        },
        request: { mode: 'request' },
        reason: 'Resolve the compatibility alias once.',
      }, actor, 100);

      const recurring = (await store.search({ targets: ['recurring-issue'] })).rows[0];
      const read = await store.read({ target: recurring.target });
      expect(read.recurringIssue?.timeZone).toBe(
        Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      );
      expect(read.recurringIssue?.timeZone).not.toBe('Local');
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

      const updated = await store.search({
        targets: ['issue'],
        text: 'invoices',
      });
      await store.update({
        target: { type: 'issue', id: updated.rows[0].target.id, expectedRevision: updated.rows[0].revision },
        change: { type: 'patch', patch: { description: 'Updated guidance.' } },
        request: { mode: 'request' },
        reason: 'Edit the Issue definition.',
      }, actor, 50);
      const updatedRow = (await store.search({
        targets: ['issue'],
        include: ['activity-summary'],
        text: 'invoices',
      })).rows[0];
      expect(updatedRow.latestActivity).toMatchObject({
        content: { type: 'updated', fields: ['description'] },
        createdAt: 50,
      });
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
      const createdAt = Date.parse('2026-07-07T09:00:00Z');
      const dueAt = Date.parse('2026-07-07T10:05:00Z');
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

      expect(await store.materializeDueRecurringIssues(Date.parse('2026-07-07T09:59:00Z'), actor)).toEqual([]);

      const materialized = await store.materializeDueRecurringIssues(dueAt, actor);
      expect(materialized).toHaveLength(1);
      expect(materialized[0].title).toBe('Write daily report - 2026-07-07');
      expect(materialized[0].description).toBe('Summarize the work for 2026-07-07.');
      expect(materialized[0].trigger.type).toBe('when-ready');
      expect(materialized[0].confirmation.confirmedBy).toEqual(actor);
      expect(materialized[0].recurrence?.recurringIssueId).toBe(recurring.target.id);
      expect(materialized[0].recurrence?.timeZone).toBe('Asia/Shanghai');
      expect(materialized[0].dueDate).toEqual({
        targetAt: Date.parse('2026-07-07T10:00:00Z'),
        timeZone: 'Asia/Shanghai',
      });
      expect(await store.materializeDueRecurringIssues(dueAt, actor)).toEqual([]);

      const currentRecurring = (await store.search({ targets: ['recurring-issue'] })).rows[0];
      await store.update({
        target: { type: 'recurring-issue', id: recurring.target.id, expectedRevision: currentRecurring.revision },
        change: { type: 'pause' },
        request: { mode: 'request' },
        reason: 'Pause the daily report routine.',
      }, actor, dueAt + 1);
      const nextDayDue = Date.parse('2026-07-08T10:05:00Z');
      expect(await store.materializeDueRecurringIssues(nextDayDue, actor)).toEqual([]);
    });
  });

  test('does not backfill an earlier window after a cadence patch', async () => {
    await withStore(async (store) => {
      const createdAt = Date.parse('2026-07-07T07:00:00Z');
      const patchedAt = Date.parse('2026-07-07T10:00:00Z');
      await store.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Patched routine',
          cadence: { type: 'daily', time: '12:00' },
          timeZone: 'UTC',
          issueTemplate: { permissionMode: 'unattended' },
        },
        request: { mode: 'request' },
        reason: 'Create a cadence that will be changed.',
      }, actor, createdAt);
      const recurring = (await store.search({ targets: ['recurring-issue'] })).rows[0];

      const patched = await store.update({
        target: { type: 'recurring-issue', id: recurring.target.id, expectedRevision: recurring.revision },
        change: { type: 'patch', patch: { cadence: { type: 'daily', time: '08:00' } } },
        request: { mode: 'request' },
        reason: 'Move the cadence earlier without backfilling today.',
      }, actor, patchedAt);
      expect(patched.status).toBe('applied');

      expect(await store.materializeDueRecurringIssues(Date.parse('2026-07-07T10:05:00Z'), actor)).toEqual([]);
      const nextWindow = await store.materializeDueRecurringIssues(Date.parse('2026-07-08T08:05:00Z'), actor);
      expect(nextWindow).toHaveLength(1);
      expect(nextWindow[0].recurrence?.windowStartAt).toBe(Date.parse('2026-07-08T08:00:00Z'));
      expect(nextWindow[0].recurrence?.skippedWindowCount).toBeUndefined();
    });
  });

  test('resume starts after the paused interval instead of backfilling it', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Pause-safe routine',
          cadence: { type: 'daily', time: '09:00' },
          timeZone: 'UTC',
          issueTemplate: { permissionMode: 'unattended' },
        },
        request: { mode: 'request' },
        reason: 'Create a routine that will be paused.',
      }, actor, Date.parse('2026-07-07T08:00:00Z'));
      let recurring = (await store.search({ targets: ['recurring-issue'] })).rows[0];
      await store.update({
        target: { type: 'recurring-issue', id: recurring.target.id, expectedRevision: recurring.revision },
        change: { type: 'pause' },
        request: { mode: 'request' },
        reason: 'Pause before the first window.',
      }, actor, Date.parse('2026-07-07T08:30:00Z'));
      recurring = (await store.search({ targets: ['recurring-issue'] })).rows[0];
      await store.update({
        target: { type: 'recurring-issue', id: recurring.target.id, expectedRevision: recurring.revision },
        change: { type: 'resume' },
        request: { mode: 'request' },
        reason: 'Resume after several paused windows.',
      }, actor, Date.parse('2026-07-10T10:00:00Z'));

      expect(await store.materializeDueRecurringIssues(Date.parse('2026-07-10T10:01:00Z'), actor)).toEqual([]);
      const nextWindow = await store.materializeDueRecurringIssues(Date.parse('2026-07-11T09:05:00Z'), actor);
      expect(nextWindow).toHaveLength(1);
      expect(nextWindow[0].recurrence).toMatchObject({
        windowStartAt: Date.parse('2026-07-11T09:00:00Z'),
      });
      expect(nextWindow[0].recurrence?.skippedWindowCount).toBeUndefined();
    });
  });

  test('an archived Recurring Issue cannot be resumed or materialized', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Archived routine',
          cadence: { type: 'daily', time: '09:00' },
          timeZone: 'UTC',
          issueTemplate: { permissionMode: 'unattended' },
        },
        request: { mode: 'request' },
        reason: 'Create a routine to archive.',
      }, actor, Date.parse('2026-07-07T08:00:00Z'));
      let recurring = (await store.search({ targets: ['recurring-issue'] })).rows[0];
      await store.update({
        target: { type: 'recurring-issue', id: recurring.target.id, expectedRevision: recurring.revision },
        change: { type: 'archive' },
        request: { mode: 'request' },
        reason: 'Archive the routine.',
      }, actor, Date.parse('2026-07-07T08:30:00Z'));
      recurring = (await store.search({ targets: ['recurring-issue'] })).rows[0];

      const resumed = await store.update({
        target: { type: 'recurring-issue', id: recurring.target.id, expectedRevision: recurring.revision },
        change: { type: 'resume' },
        request: { mode: 'request' },
        reason: 'Do not revive archived work.',
      }, actor, Date.parse('2026-07-08T08:00:00Z'));
      expect(resumed.status).toBe('blocked');
      expect(resumed.validation?.map((entry) => entry.code)).toContain('invalid_state');
      expect(await store.materializeDueRecurringIssues(Date.parse('2026-07-10T10:00:00Z'), actor)).toEqual([]);

      const read = await store.read({ target: recurring.target });
      expect(read.recurringIssue).toMatchObject({ status: 'archived' });
      expect(read.recurringIssue?.nextMaterializationAt).toBeUndefined();
    });
  });

  test('skip-next advances a Recurring Issue without materializing or coalescing the skipped window', async () => {
    await withStore(async (store) => {
      const createdAt = Date.parse('2026-07-07T09:00:00Z');
      const firstWindow = Date.parse('2026-07-07T10:00:00Z');
      const firstDue = Date.parse('2026-07-07T10:05:00Z');
      const secondDue = Date.parse('2026-07-08T10:05:00Z');
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
      const createdAt = Date.parse('2026-07-07T09:00:00Z');
      const laterDue = Date.parse('2026-07-10T10:05:00Z');
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

  test('uses the declared time zone and omits coalesced metadata for skip-missed', async () => {
    await withStore(async (store) => {
      const createdAt = Date.parse('2026-07-07T08:30:00Z');
      await store.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'UTC checkpoint',
          cadence: { type: 'daily', time: '09:00' },
          timeZone: 'UTC',
          missedPolicy: { type: 'skip-missed' },
          issueTemplate: { permissionMode: 'unattended' },
        },
        request: { mode: 'request' },
        reason: 'Create a UTC recurring checkpoint.',
      }, actor, createdAt);

      const first = await store.materializeDueRecurringIssues(Date.parse('2026-07-07T09:05:00Z'), actor);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        title: 'UTC checkpoint - 2026-07-07',
        recurrence: {
          windowStartAt: Date.parse('2026-07-07T09:00:00Z'),
        },
      });

      const latest = await store.materializeDueRecurringIssues(Date.parse('2026-07-10T09:05:00Z'), actor);
      expect(latest).toHaveLength(1);
      expect(latest[0].title).toBe('UTC checkpoint - 2026-07-10');
      expect(latest[0].recurrence?.skippedWindowCount).toBeUndefined();
      const recurring = (await store.search({ targets: ['recurring-issue'] })).rows[0];
      const read = await store.read({ target: recurring.target, include: ['activity'] });
      const latestMaterialization = read.activity
        ?.filter((entry) => entry.content.type === 'agent-action' && entry.content.action === 'materialize')
        .at(-1);
      expect(latestMaterialization?.content).toMatchObject({ type: 'agent-action', action: 'materialize' });
      expect(latestMaterialization?.content).not.toHaveProperty('parameter');
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

  test('previews run the same stateful validation as requests without mutating', async () => {
    await withStore(async (store) => {
      const created = await store.create({
        issueType: 'issue',
        fields: { title: 'Preview validation target' },
        request: { mode: 'request' },
        reason: 'Create a concrete validation target.',
      }, actor, 10);
      const issueTarget = created.targets.find((target) => target.type === 'issue')!;
      const issue = (await store.read({ target: issueTarget })).issue!;

      const invalidCreateRelation = await store.create({
        issueType: 'issue',
        fields: {
          title: 'Invalid related preview',
          relations: [{ type: 'related', issueId: 'issue:missing' }],
        },
        request: { mode: 'preview' },
        reason: 'Validate a relation before creation.',
      }, actor, 20);
      expect(invalidCreateRelation.status).toBe('blocked');
      expect(invalidCreateRelation.validation?.map((entry) => entry.code)).toContain('relation_target_not_found');

      const missingUpdate = await store.update({
        target: { type: 'issue', id: 'issue:missing' },
        change: { type: 'patch', patch: { title: 'Still missing' } },
        request: { mode: 'preview' },
        reason: 'Validate a missing target.',
      }, actor, 30);
      expect(missingUpdate.status).toBe('blocked');
      expect(missingUpdate.validation?.map((entry) => entry.code)).toContain('not_found');

      const staleUpdate = await store.update({
        target: { type: 'issue', id: issue.id, expectedRevision: 'rev:stale' },
        change: { type: 'patch', patch: { title: 'Stale preview' } },
        request: { mode: 'preview' },
        reason: 'Validate optimistic concurrency.',
      }, actor, 40);
      expect(staleUpdate.status).toBe('conflict');
      expect(staleUpdate.validation?.map((entry) => entry.code)).toContain('revision_mismatch');

      const invalidUpdateRelation = await store.update({
        target: { type: 'issue', id: issue.id, expectedRevision: issue.revision },
        change: { type: 'patch', patch: { relations: [{ type: 'blocks', issueId: 'issue:missing' }] } },
        request: { mode: 'preview' },
        reason: 'Validate a relation update.',
      }, actor, 50);
      expect(invalidUpdateRelation.status).toBe('blocked');
      expect(invalidUpdateRelation.validation?.map((entry) => entry.code)).toContain('relation_target_not_found');

      const source: AgentSessionSource = { type: 'runtime-action', actor };
      const started = await store.startSession({
        issueId: issue.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start a Session for lifecycle preview validation.',
      }, source, actor, 60);
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;

      const invalidCompletion = await store.update({
        target: { type: 'issue', id: issue.id },
        change: { type: 'transition', status: { name: 'Completed', category: 'completed' } },
        request: { mode: 'preview' },
        reason: 'Validate completion while work remains active.',
      }, actor, 70);
      expect(invalidCompletion.status).toBe('blocked');
      expect(invalidCompletion.validation?.map((entry) => entry.code)).toContain('active_session_exists');

      const missingMessage = await store.sendSessionMessage({
        agentSessionId: 'agent-session:missing',
        message: 'No recipient.',
        request: { mode: 'preview' },
        reason: 'Validate a missing Session.',
      }, actor, 80);
      expect(missingMessage.status).toBe('blocked');
      expect(missingMessage.validation?.map((entry) => entry.code)).toContain('not_found');

      await store.stopSession({
        agentSessionId: sessionId,
        request: { mode: 'request' },
        reason: 'Cancel the Session.',
      }, actor, 90);
      const terminalMessage = await store.sendSessionMessage({
        agentSessionId: sessionId,
        message: 'Too late.',
        request: { mode: 'preview' },
        reason: 'Validate terminal Session messaging.',
      }, actor, 100);
      expect(terminalMessage.status).toBe('blocked');
      expect(terminalMessage.validation?.map((entry) => entry.code)).toContain('invalid_state');
      expect((await store.read({ target: issueTarget })).issue?.title).toBe('Preview validation target');
      expect((await store.search({ targets: ['issue'] })).rows).toHaveLength(1);
    });
  });

  test('defaults new Issues to when-ready unattended execution', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: { title: 'Default executable work' },
        request: { mode: 'request' },
        reason: 'Create normal work.',
      }, actor, 10);

      const row = (await store.search({ text: 'Default executable work' })).rows[0];
      const read = await store.read({ target: { type: 'issue', id: row.target.id } });
      expect(read.issue?.trigger).toEqual({ type: 'when-ready' });
      expect(read.issue?.permissionMode).toBe('unattended');
      expect((await store.listReadyIssuesForExecution(20)).map((issue) => issue.title)).toEqual(['Default executable work']);
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
          content: { type: 'deleted' },
        }),
        expect.objectContaining({
          target: { type: 'recurring-issue', recurringIssueId: recurringIssue.target.id },
          content: { type: 'deleted' },
        }),
      ]));
    });
  });

  test('keeps unrelated Issues separate when no Agent Session origin exists', async () => {
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
      const release = (await store.search({ targets: ['issue'], text: 'July release' })).rows[0]!;

      await store.create({
        issueType: 'issue',
        fields: {
          title: 'Write release notes',
          relations: [{ type: 'related', issueId: release.target.id }],
        },
        request: { mode: 'request' },
        reason: 'Track related release work as a separate root Issue.',
      }, actor, 20);

      const rows = await store.search({ targets: ['issue'] });
      expect(rows.rows.map((row) => row.title).sort()).toEqual(['Prepare July release', 'Write release notes']);
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
      expect(unblocked.viewBuckets).not.toContain('blocked');
      const blockedRows = await store.search({ filter: { statusCategories: ['blocked'] } });
      expect(blockedRows.rows.map((row) => row.target.id)).not.toContain(unblocked.target.id);
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

  test('returns the Agent Session created by the current start mutation', async () => {
    await withStore(async (store) => {
      const source: AgentSessionSource = { type: 'runtime-action', actor };
      for (const title of ['Existing active issue', 'New issue']) {
        await store.create({
          issueType: 'issue',
          fields: { title },
          request: { mode: 'request' },
          reason: 'Create issue.',
        }, actor, 10);
      }
      const existing = (await store.search({ text: 'Existing active issue' })).rows[0];
      const newIssue = (await store.search({ text: 'New issue' })).rows[0];
      const existingStart = await store.startSession({
        issueId: existing.target.id,
        expectedIssueRevision: existing.revision,
        request: { mode: 'request' },
        reason: 'Start existing issue.',
      }, source, actor, 1_000);
      expect(existingStart.status).toBe('applied');
      const existingSessionId = existingStart.targets.find((target) => target.type === 'agent-session')?.id;

      const newStart = await store.startSession({
        issueId: newIssue.target.id,
        expectedIssueRevision: newIssue.revision,
        request: { mode: 'request' },
        reason: 'Start new issue with an earlier timestamp.',
      }, source, actor, 50);
      expect(newStart.status).toBe('applied');
      const newSessionId = newStart.targets.find((target) => target.type === 'agent-session')?.id;
      expect(newSessionId).toBeDefined();
      expect(newSessionId).not.toBe(existingSessionId);
      expect((await store.readSession({ agentSessionId: newSessionId! }))?.agentSession.issueId).toBe(newIssue.target.id);
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

      const missingIntent = await store.startSession({
        issueId: target.target.id,
        expectedIssueRevision: target.revision,
        continuation: { previousAgentSessionId: previousSessionId },
        request: { mode: 'preview' },
        reason: 'Reject an incomplete continuation.',
      } as never, source, actor, 65);
      expect(missingIntent.status).toBe('blocked');
      expect(missingIntent.validation).toContainEqual(expect.objectContaining({
        path: 'continuation.intent',
        code: 'required_field',
      }));

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
          completionCriteria: [{ id: 'risks', text: 'Launch risks are summarized.', state: 'open' }],
          verificationPolicy: { mode: 'criteria-and-evidence' },
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
      expect(synced?.becameTerminal).toBe(true);
      expect(synced?.session.state).toBe('complete');
      expect(synced?.session.latestOutput).toBe('<analysis>internal chain of thought</analysis>\nLaunch risks summarized.');
      const read = await store.readSession({ agentSessionId: sessionId, include: ['activity-summary'] });
      expect(read?.activity?.map((entry) => entry.content.type)).toContain('agent-response');
      expect(read?.activity?.find((entry) => entry.content.type === 'agent-response')?.content).toEqual({
        type: 'agent-response',
        body: 'Launch risks summarized.',
      });
      const issueRead = await store.read({ target: issue.target, include: ['activity'] });
      expect(issueRead.issue?.status).toEqual({ name: 'Completed', category: 'completed' });
      expect(issueRead.issue?.terminalAt).toBe(200);
      expect(issueRead.issue?.completionCriteria?.[0]).toMatchObject({
        id: 'risks',
        state: 'met',
        evidence: [{ type: 'agent-session', agentSessionId: sessionId }],
      });
      expect(issueRead.issue?.evidence).toContainEqual({ type: 'agent-session', agentSessionId: sessionId });
      expect(issueRead.activity).toEqual(expect.arrayContaining([
        expect.objectContaining({
          content: { type: 'status-change', from: 'Started', to: 'Completed' },
        }),
      ]));
    });
  });

  test('keeps Agent Session terminal time stable across repeated execution syncs', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: {
          title: 'Stable completion',
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

      await store.bindSessionExecution(sessionId, {
        engine: 'delegation',
        conversationId: 'conversation:issue',
        executionId: 'execution:stable',
        startedAt: 130,
      }, actor, 130);
      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:stable',
        state: 'completed',
        latestOutput: 'First result.',
        completedAt: 200,
      }, actor, 200);
      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:stable',
        state: 'completed',
        latestOutput: 'Second read result.',
        completedAt: 250,
      }, actor, 250);

      const read = await store.readSession({ agentSessionId: sessionId });
      expect(read?.agentSession).toMatchObject({
        state: 'complete',
        completedAt: 200,
        latestOutput: 'Second read result.',
      });
      expect((await store.read({ target: issue.target })).issue?.terminalAt).toBe(200);
    });
  });

  test('requires a new Session when completion criteria change after the evidence snapshot', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: {
          title: 'Snapshot-bound criteria',
          completionCriteria: [{ id: 'original', text: 'Original criterion.', state: 'open' }],
        },
        request: { mode: 'request' },
        reason: 'Create snapshot-bound work.',
      }, actor, 100);
      const issue = (await store.search({ text: 'Snapshot-bound criteria' })).rows[0];
      const firstStart = await store.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start against the original criteria.',
      }, { type: 'runtime-action', actor }, actor, 110);
      const firstSessionId = firstStart.targets.find((target) => target.type === 'agent-session')!.id;
      await store.bindSessionExecution(firstSessionId, {
        engine: 'delegation',
        conversationId: 'conversation:snapshot-criteria',
        executionId: 'execution:snapshot-criteria:first',
        startedAt: 120,
      }, actor, 120);

      const current = (await store.read({ target: issue.target })).issue!;
      await store.update({
        target: { type: 'issue', id: current.id, expectedRevision: current.revision },
        change: {
          type: 'patch',
          patch: {
            completionCriteria: [
              { id: 'original', text: 'Rewritten criterion.', state: 'open' },
              { id: 'added', text: 'Added criterion.', state: 'open' },
            ],
          },
        },
        request: { mode: 'request' },
        reason: 'Change the contract while the Session is active.',
      }, actor, 130);

      const firstSync = await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:snapshot-criteria:first',
        state: 'completed',
        latestOutput: 'Result for the original contract.',
        completedAt: 140,
      }, actor, 140);
      expect(firstSync?.issueBecameCompleted).toBe(false);
      expect(firstSync?.session.state).toBe('complete');
      expect(firstSync?.session.errorMessage).toContain('Issue completion blocked');
      const stillOpen = (await store.read({ target: issue.target })).issue!;
      expect(stillOpen.status.category).toBe('started');
      expect(stillOpen.completionCriteria?.map((criterion) => criterion.state)).toEqual(['open', 'open']);
      expect(stillOpen.evidence).toBeUndefined();
      expect((await store.search({
        targets: ['issue'],
        filter: { needsAttention: true },
      })).rows.map((row) => row.target.id)).toContain(issue.target.id);

      const secondStart = await store.startSession({
        issueId: stillOpen.id,
        expectedIssueRevision: stillOpen.revision,
        continuation: {
          previousAgentSessionId: firstSessionId,
          intent: 'revise',
          context: 'summary',
        },
        request: { mode: 'request' },
        reason: 'Run against the current criteria.',
      }, { type: 'runtime-action', actor }, actor, 150);
      const secondSessionId = secondStart.targets.find((target) => target.type === 'agent-session')!.id;
      await store.bindSessionExecution(secondSessionId, {
        engine: 'delegation',
        conversationId: 'conversation:snapshot-criteria',
        executionId: 'execution:snapshot-criteria:second',
        startedAt: 160,
      }, actor, 160);
      const secondSync = await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:snapshot-criteria:second',
        state: 'completed',
        latestOutput: 'Result for the revised contract.',
        completedAt: 170,
      }, actor, 170);
      expect(secondSync?.issueBecameCompleted).toBe(true);
      expect((await store.read({ target: issue.target })).issue?.completionCriteria?.map((criterion) => criterion.state))
        .toEqual(['met', 'met']);
    });
  });

  test('requires a new Session when execution-relevant Issue fields change after start', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: {
          title: 'Snapshot-bound definition',
          description: 'Use the original instructions.',
          input: { type: 'selected-nodes', nodeIds: ['node:original'] },
          output: { type: 'append-to-node', nodeId: 'node:output-original' },
          verificationPolicy: { mode: 'none' },
        },
        request: { mode: 'request' },
        reason: 'Create definition-fenced work.',
      }, actor, 100);
      const issue = (await store.search({ text: 'Snapshot-bound definition' })).rows[0]!;
      const started = await store.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start against the original definition.',
      }, { type: 'runtime-action', actor }, actor, 110);
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
      await store.bindSessionExecution(sessionId, {
        engine: 'delegation',
        conversationId: 'conversation:snapshot-definition',
        executionId: 'execution:snapshot-definition',
        startedAt: 120,
      }, actor, 120);

      const current = (await store.read({ target: issue.target })).issue!;
      const patched = await store.update({
        target: { type: 'issue', id: current.id, expectedRevision: current.revision },
        change: {
          type: 'patch',
          patch: {
            description: 'Use the revised instructions.',
            input: { type: 'selected-nodes', nodeIds: ['node:revised'] },
            output: { type: 'append-to-node', nodeId: 'node:output-revised' },
            verificationPolicy: { mode: 'human-review' },
          },
        },
        request: { mode: 'request' },
        reason: 'Tighten and revise the execution contract.',
      }, actor, 130);
      expect(patched.status).toBe('applied');

      const synced = await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:snapshot-definition',
        state: 'completed',
        latestOutput: 'Result for the original definition.',
        completedAt: 140,
      }, actor, 140);
      expect(synced?.issueBecameCompleted).toBe(false);
      expect(synced?.session).toMatchObject({ state: 'complete' });
      expect(synced?.session.errorMessage).toContain('Issue completion blocked');
      const open = (await store.read({ target: issue.target })).issue!;
      expect(open.status.category).toBe('started');
      expect((await store.search({ targets: ['issue'], filter: { needsAttention: true } })).rows)
        .toContainEqual(expect.objectContaining({ target: issue.target }));
    });
  });

  test('allows only trusted users to weaken review policy requirements', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: {
          title: 'Protected review policy',
          verificationPolicy: {
            mode: 'agent-review',
            requiredVerdict: 'pass',
            requiredEvidence: ['source URL', 'checksum'],
          },
        },
        request: { mode: 'request' },
        reason: 'Create review-protected work.',
      }, actor, 100);
      const issue = (await store.search({ text: 'Protected review policy' })).rows[0]!;

      const agentDowngrade = await store.update({
        target: { type: 'issue', id: issue.target.id, expectedRevision: issue.revision },
        change: { type: 'patch', patch: { verificationPolicy: { mode: 'none' } } },
        request: { mode: 'request' },
        reason: 'Attempt to remove review.',
      }, actor, 110);
      expect(agentDowngrade).toMatchObject({
        status: 'blocked',
        validation: [expect.objectContaining({ code: 'review_policy_downgrade_requires_user' })],
      });

      const agentEvidenceDowngrade = await store.update({
        target: { type: 'issue', id: issue.target.id, expectedRevision: issue.revision },
        change: {
          type: 'patch',
          patch: {
            verificationPolicy: {
              mode: 'agent-review',
              requiredVerdict: 'pass-or-partial',
              requiredEvidence: ['source URL'],
            },
          },
        },
        request: { mode: 'request' },
        reason: 'Attempt to relax verifier acceptance.',
      }, actor, 120);
      expect(agentEvidenceDowngrade.status).toBe('blocked');

      const defaultVerdictCreated = await store.create({
        issueType: 'issue',
        fields: {
          title: 'Default pass review policy',
          verificationPolicy: { mode: 'agent-review' },
        },
        request: { mode: 'request' },
        reason: 'Create a policy that uses the default pass verdict.',
      }, actor, 125);
      const defaultVerdictIssue = (await store.read({
        target: defaultVerdictCreated.targets.find((target) => target.type === 'issue')!,
      })).issue!;
      const defaultVerdictDowngrade = await store.update({
        target: {
          type: 'issue',
          id: defaultVerdictIssue.id,
          expectedRevision: defaultVerdictIssue.revision,
        },
        change: {
          type: 'patch',
          patch: {
            verificationPolicy: {
              mode: 'agent-review',
              requiredVerdict: 'pass-or-partial',
            },
          },
        },
        request: { mode: 'request' },
        reason: 'Attempt to relax the implicit pass verdict.',
      }, actor, 126);
      expect(defaultVerdictDowngrade).toMatchObject({
        status: 'blocked',
        validation: [expect.objectContaining({ code: 'review_policy_downgrade_requires_user' })],
      });

      const recurringCreated = await store.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Protected recurring review',
          cadence: { type: 'daily', time: '09:00' },
          timeZone: 'UTC',
          issueTemplate: {
            permissionMode: 'unattended',
            verificationPolicy: { mode: 'human-review' },
          },
        },
        request: { mode: 'request' },
        reason: 'Create recurring review-protected work.',
      }, actor, 127);
      const recurring = (await store.read({
        target: recurringCreated.targets.find((target) => target.type === 'recurring-issue')!,
      })).recurringIssue!;
      const recurringDowngrade = await store.update({
        target: {
          type: 'recurring-issue',
          id: recurring.id,
          expectedRevision: recurring.revision,
        },
        change: {
          type: 'patch',
          patch: { issueTemplate: { permissionMode: 'unattended' } },
        },
        request: { mode: 'request' },
        reason: 'Attempt to remove review from future generated Issues.',
      }, actor, 128);
      expect(recurringDowngrade).toMatchObject({
        status: 'blocked',
        validation: [expect.objectContaining({ code: 'review_policy_downgrade_requires_user' })],
      });

      const user: ActorRef = { type: 'user', userId: 'user:owner' };
      const userDowngrade = await store.update({
        target: { type: 'issue', id: issue.target.id, expectedRevision: issue.revision },
        change: { type: 'patch', patch: { verificationPolicy: { mode: 'none' } } },
        request: { mode: 'request' },
        reason: 'The user explicitly removes review.',
      }, user, 130);
      expect(userDowngrade.status).toBe('applied');
    });
  });

  test('prevents agents from removing or waiving existing completion criteria', async () => {
    await withStore(async (store) => {
      const created = await store.create({
        issueType: 'issue',
        fields: {
          title: 'Protected completion contract',
          completionCriteria: [{ id: 'proof', text: 'Provide proof.', state: 'open' }],
        },
        request: { mode: 'request' },
        reason: 'Create completion-protected work.',
      }, actor, 100);
      const issue = (await store.read({
        target: created.targets.find((target) => target.type === 'issue')!,
      })).issue!;

      const removed = await store.update({
        target: { type: 'issue', id: issue.id, expectedRevision: issue.revision },
        change: { type: 'patch', patch: { completionCriteria: [] } },
        request: { mode: 'request' },
        reason: 'Attempt to remove the completion contract.',
      }, actor, 110);
      expect(removed).toMatchObject({
        status: 'blocked',
        validation: [expect.objectContaining({ code: 'completion_criteria_downgrade_requires_user' })],
      });

      const waived = await store.update({
        target: { type: 'issue', id: issue.id, expectedRevision: issue.revision },
        change: {
          type: 'patch',
          patch: { completionCriteria: [{ id: 'proof', text: 'Provide proof.', state: 'waived' }] },
        },
        request: { mode: 'request' },
        reason: 'Attempt to waive the completion contract.',
      }, actor, 120);
      expect(waived).toMatchObject({
        status: 'blocked',
        validation: [expect.objectContaining({ code: 'completion_criteria_downgrade_requires_user' })],
      });

      const recurringCreated = await store.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Protected recurring completion contract',
          cadence: { type: 'daily', time: '09:00' },
          timeZone: 'UTC',
          issueTemplate: {
            permissionMode: 'unattended',
            completionCriteria: [{ id: 'daily-proof', text: 'Provide daily proof.', state: 'open' }],
          },
        },
        request: { mode: 'request' },
        reason: 'Create recurring completion-protected work.',
      }, actor, 130);
      const recurring = (await store.read({
        target: recurringCreated.targets.find((target) => target.type === 'recurring-issue')!,
      })).recurringIssue!;
      const recurringRemoved = await store.update({
        target: {
          type: 'recurring-issue',
          id: recurring.id,
          expectedRevision: recurring.revision,
        },
        change: { type: 'patch', patch: { issueTemplate: { permissionMode: 'unattended' } } },
        request: { mode: 'request' },
        reason: 'Attempt to remove future completion criteria.',
      }, actor, 140);
      expect(recurringRemoved).toMatchObject({
        status: 'blocked',
        validation: [expect.objectContaining({ code: 'completion_criteria_downgrade_requires_user' })],
      });

      const user: ActorRef = { type: 'user', userId: 'user:owner' };
      const userWaiver = await store.update({
        target: { type: 'issue', id: issue.id, expectedRevision: issue.revision },
        change: {
          type: 'patch',
          patch: { completionCriteria: [{ id: 'proof', text: 'Provide proof.', state: 'waived' }] },
        },
        request: { mode: 'request' },
        reason: 'The user explicitly waives the completion criterion.',
      }, user, 150);
      expect(userWaiver.status).toBe('applied');
    });
  });

  test('does not complete against criteria removed after the evidence Session started', async () => {
    await withStore(async (store) => {
      const user: ActorRef = { type: 'user', userId: 'user:owner' };
      const created = await store.create({
        issueType: 'issue',
        fields: {
          title: 'Snapshot completion contract',
          completionCriteria: [{ id: 'original-proof', text: 'Provide original proof.', state: 'open' }],
        },
        request: { mode: 'request' },
        reason: 'Create snapshot-bound completion work.',
      }, user, 100);
      const issue = (await store.read({
        target: created.targets.find((target) => target.type === 'issue')!,
      })).issue!;
      const started = await store.startSession({
        issueId: issue.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start against the original completion contract.',
      }, { type: 'runtime-action', actor }, actor, 110);
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
      await store.bindSessionExecution(sessionId, {
        engine: 'delegation',
        conversationId: 'conversation:criteria-snapshot',
        executionId: 'execution:criteria-snapshot',
        startedAt: 120,
      }, actor, 120);
      const current = (await store.read({ target: { type: 'issue', id: issue.id } })).issue!;
      expect((await store.update({
        target: { type: 'issue', id: issue.id, expectedRevision: current.revision },
        change: { type: 'patch', patch: { completionCriteria: [] } },
        request: { mode: 'request' },
        reason: 'The user changes the completion contract after execution starts.',
      }, user, 130)).status).toBe('applied');

      const synced = await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:criteria-snapshot',
        state: 'completed',
        latestOutput: 'Result without the original proof.',
        completedAt: 140,
      }, actor, 140);
      expect(synced?.issueBecameCompleted).toBe(false);
      expect(synced?.session.errorMessage).toContain('original-proof');
      expect((await store.read({ target: { type: 'issue', id: issue.id } })).issue?.status.category)
        .toBe('started');
    });
  });

  test('keeps human-review Issues open after execution completes', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: {
          title: 'Draft legal summary',
          verificationPolicy: { mode: 'human-review' },
          completionCriteria: [{ id: 'draft', text: 'Draft is ready for human review.', state: 'open' }],
        },
        request: { mode: 'request' },
        reason: 'Create review-gated work.',
      }, actor, 100);
      const issue = (await store.search({ text: 'Draft legal summary' })).rows[0];
      const user: ActorRef = { type: 'user', userId: 'user:reviewer' };
      const prematureReview = await store.update({
        target: { type: 'issue', id: issue.target.id, expectedRevision: issue.revision },
        change: { type: 'transition', status: { name: 'Completed', category: 'completed' } },
        request: { mode: 'request' },
        reason: 'Attempt review before any execution result exists.',
      }, user, 110, { allowHumanReviewTransition: true });
      expect(prematureReview).toMatchObject({
        status: 'blocked',
        validation: [expect.objectContaining({ code: 'human_review_execution_required' })],
      });
      const started = await store.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start work.',
      }, { type: 'runtime-action', actor }, actor, 120);
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
      await store.bindSessionExecution(sessionId, {
        engine: 'delegation',
        conversationId: 'conversation:issue',
        executionId: 'execution:human-review',
        startedAt: 130,
      }, actor, 130);
      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:human-review',
        state: 'completed',
        latestOutput: 'Draft ready for review.',
        completedAt: 200,
      }, actor, 200);

      const read = await store.read({ target: issue.target });
      expect(read.issue?.status).toEqual({ name: 'Started', category: 'started' });
      expect(read.issue?.completionCriteria?.[0]?.state).toBe('open');
    });
  });

  test('completes agent-review Issues only after verified execution', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: {
          title: 'Verified weather summary',
          verificationPolicy: { mode: 'agent-review', requiredVerdict: 'pass' },
          completionCriteria: [{ id: 'summary', text: 'Weather summary is verified.', state: 'open' }],
        },
        request: { mode: 'request' },
        reason: 'Create agent-reviewed work.',
      }, actor, 100);
      const issue = (await store.search({ text: 'Verified weather summary' })).rows[0];
      const started = await store.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start work.',
      }, { type: 'runtime-action', actor }, actor, 120);
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
      await store.bindSessionExecution(sessionId, {
        engine: 'delegation',
        conversationId: 'conversation:issue',
        executionId: 'execution:agent-review',
        startedAt: 130,
      }, actor, 130);
      const unverified = await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:agent-review',
        state: 'completed',
        latestOutput: 'Weather summary verified.',
        completedAt: 200,
      }, actor, 200);
      expect(unverified?.becameTerminal).toBe(true);
      expect(unverified?.issueBecameCompleted).toBe(false);
      expect((await store.read({ target: issue.target })).issue?.status.category).toBe('started');

      const verified = await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:agent-review',
        state: 'completed',
        objectiveStatus: 'verified',
        latestOutput: 'Weather summary verified.',
        completedAt: 220,
      }, actor, 220);
      expect(verified?.becameTerminal).toBe(false);
      expect(verified?.issueBecameCompleted).toBe(true);
      const read = await store.read({ target: issue.target });
      expect(read.issue?.status).toEqual({ name: 'Completed', category: 'completed' });
      expect(read.issue?.completionCriteria?.[0]?.state).toBe('met');
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

  test('surfaces a rejected verifier result as Issue attention', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: {
          title: 'Rejected verification fixture',
          verificationPolicy: {
            mode: 'agent-review',
            requiredVerdict: 'pass',
            requiredEvidence: ['signed report'],
          },
        },
        request: { mode: 'request' },
        reason: 'Create rejected verification work.',
      }, actor, 100);
      const issue = (await store.search({ text: 'Rejected verification fixture' })).rows[0];
      const started = await store.startSession({
        issueId: issue.target.id,
        purpose: 'verify',
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Run a rejecting verifier.',
      }, { type: 'runtime-action', actor }, actor, 110);
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
      await store.bindSessionExecution(sessionId, {
        engine: 'delegation',
        conversationId: 'conversation:rejected-verification',
        executionId: 'execution:rejected-verification',
        startedAt: 120,
      }, actor, 120);
      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:rejected-verification',
        state: 'completed',
        latestOutput: 'Verdict: pass-or-partial\nThe signed report is missing.',
        completedAt: 130,
      }, actor, 130);

      const attention = await store.search({
        targets: ['issue'],
        filter: { needsAttention: true },
        include: ['session-summary'],
      });
      expect(attention.rows).toEqual([
        expect.objectContaining({
          target: issue.target,
          needsAttention: true,
          hasActiveSession: false,
          latestSessionState: 'complete',
          viewBuckets: expect.arrayContaining(['attention-needed']),
        }),
      ]);
      const detail = await store.read({ target: issue.target, include: ['activity'] });
      expect(detail.activity).toContainEqual(expect.objectContaining({
        content: expect.objectContaining({ type: 'verification-result', verdict: 'partial' }),
      }));
    });
  });

  test('treats a missing verifier verdict as fail under pass-or-partial policy', async () => {
    await withStore(async (store) => {
      const created = await store.create({
        issueType: 'issue',
        fields: {
          title: 'Malformed verifier verdict fixture',
          verificationPolicy: {
            mode: 'agent-review',
            requiredVerdict: 'pass-or-partial',
          },
        },
        request: { mode: 'request' },
        reason: 'Create work that permits an explicit partial verdict.',
      }, actor, 100);
      const issueId = created.targets.find((target) => target.type === 'issue')!.id;
      const issue = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
      const execution = await store.startSession({
        issueId,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Produce the result before verification.',
      }, { type: 'runtime-action', actor }, actor, 110);
      const executionSessionId = execution.targets.find((target) => target.type === 'agent-session')!.id;
      await store.bindSessionExecution(executionSessionId, {
        engine: 'delegation',
        conversationId: 'conversation:malformed-verdict-execution',
        executionId: 'execution:malformed-verdict-execution',
        startedAt: 120,
      }, actor, 120);
      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:malformed-verdict-execution',
        state: 'completed',
        latestOutput: 'Candidate result awaiting review.',
        completedAt: 130,
      }, actor, 130);

      const current = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
      const verification = await store.startSession({
        issueId,
        purpose: 'verify',
        expectedIssueRevision: current.revision,
        request: { mode: 'request' },
        reason: 'Verify the candidate result.',
      }, { type: 'runtime-action', actor }, actor, 140);
      const verificationSessionId = verification.targets.find((target) => target.type === 'agent-session')!.id;
      await store.bindSessionExecution(verificationSessionId, {
        engine: 'delegation',
        conversationId: 'conversation:malformed-verdict-review',
        executionId: 'execution:malformed-verdict-review',
        startedAt: 150,
      }, actor, 150);
      const synced = await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:malformed-verdict-review',
        state: 'completed',
        latestOutput: 'The evidence was reviewed, but this response omitted the required verdict line.',
        completedAt: 160,
      }, actor, 160);

      expect(synced?.issueBecameCompleted).toBe(false);
      const detail = await store.read({ target: { type: 'issue', id: issueId }, include: ['activity'] });
      expect(detail.issue?.status.category).toBe('started');
      expect(detail.activity).toContainEqual(expect.objectContaining({
        content: expect.objectContaining({ type: 'verification-result', verdict: 'fail' }),
      }));
      expect((await store.search({ filter: { needsAttention: true } })).rows)
        .toContainEqual(expect.objectContaining({ target: { type: 'issue', id: issueId } }));
    });
  });

  test('reuses the full verifier output when later completing an accepted review', async () => {
    await withStore(async (store) => {
      const requiredEvidence = 'proof-at-the-end';
      const created = await store.create({
        issueType: 'issue',
        fields: {
          title: 'Long verifier evidence fixture',
          description: 'Original instructions.',
          verificationPolicy: {
            mode: 'agent-review',
            requiredVerdict: 'pass',
            requiredEvidence: [requiredEvidence],
          },
        },
        request: { mode: 'request' },
        reason: 'Create work with long verifier evidence.',
      }, actor, 100);
      const issueId = created.targets.find((target) => target.type === 'issue')!.id;
      const issue = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
      const verification = await store.startSession({
        issueId,
        purpose: 'verify',
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start the verifier before a temporary definition edit.',
      }, { type: 'runtime-action', actor }, actor, 110);
      const verificationSessionId = verification.targets.find((target) => target.type === 'agent-session')!.id;
      await store.bindSessionExecution(verificationSessionId, {
        engine: 'delegation',
        conversationId: 'conversation:long-verifier-evidence',
        executionId: 'execution:long-verifier-evidence',
        startedAt: 120,
      }, actor, 120);
      const beforeEdit = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
      await store.update({
        target: { type: 'issue', id: issueId, expectedRevision: beforeEdit.revision },
        change: { type: 'patch', patch: { description: 'Temporary revised instructions.' } },
        request: { mode: 'request' },
        reason: 'Temporarily change the execution contract.',
      }, actor, 130);
      const fullVerifierOutput = `Verdict: pass\n${'evidence '.repeat(600)}${requiredEvidence}`;
      const synced = await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:long-verifier-evidence',
        state: 'completed',
        latestOutput: fullVerifierOutput,
        completedAt: 140,
      }, actor, 140);
      expect(synced?.issueBecameCompleted).toBe(false);

      const afterVerification = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
      await store.update({
        target: { type: 'issue', id: issueId, expectedRevision: afterVerification.revision },
        change: { type: 'patch', patch: { description: 'Original instructions.' } },
        request: { mode: 'request' },
        reason: 'Restore the verified contract.',
      }, actor, 150);
      const restored = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
      const completed = await store.update({
        target: { type: 'issue', id: issueId, expectedRevision: restored.revision },
        change: { type: 'transition', status: { name: 'Completed', category: 'completed' } },
        request: { mode: 'request' },
        reason: 'Complete from the accepted full verifier result.',
      }, actor, 160);

      expect(completed.status).toBe('applied');
      expect((await store.read({ target: { type: 'issue', id: issueId } })).issue?.status.category)
        .toBe('completed');
    });
  });

  test('uses Activity append order for verifier results with the same timestamp', async () => {
    await withStore(async (store) => {
      const created = await store.create({
        issueType: 'issue',
        fields: {
          title: 'Same-time verifier ordering fixture',
          description: 'Original instructions.',
          verificationPolicy: { mode: 'agent-review', requiredVerdict: 'pass' },
        },
        request: { mode: 'request' },
        reason: 'Create work for deterministic verifier ordering.',
      }, actor, 100);
      const issueId = created.targets.find((target) => target.type === 'issue')!.id;
      const issue = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
      const verification = await store.startSession({
        issueId,
        purpose: 'verify',
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start verifier ordering work.',
      }, { type: 'runtime-action', actor }, actor, 110);
      const verificationSessionId = verification.targets.find((target) => target.type === 'agent-session')!.id;
      await store.bindSessionExecution(verificationSessionId, {
        engine: 'delegation',
        conversationId: 'conversation:same-time-verifier-order',
        executionId: 'execution:same-time-verifier-order',
        startedAt: 120,
      }, actor, 120);
      const beforeEdit = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
      await store.update({
        target: { type: 'issue', id: issueId, expectedRevision: beforeEdit.revision },
        change: { type: 'patch', patch: { description: 'Temporary revised instructions.' } },
        request: { mode: 'request' },
        reason: 'Temporarily block verifier finalization.',
      }, actor, 130);
      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:same-time-verifier-order',
        state: 'completed',
        latestOutput: 'Verdict: pass\nInitial evaluation passed.',
        completedAt: 140,
      }, actor, 140);
      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:same-time-verifier-order',
        state: 'completed',
        latestOutput: 'Verdict: fail\nLater evaluation found a blocker.',
        completedAt: 140,
      }, actor, 140);

      const afterVerification = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
      await store.update({
        target: { type: 'issue', id: issueId, expectedRevision: afterVerification.revision },
        change: { type: 'patch', patch: { description: 'Original instructions.' } },
        request: { mode: 'request' },
        reason: 'Restore the original contract.',
      }, actor, 150);
      const restored = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
      const completed = await store.update({
        target: { type: 'issue', id: issueId, expectedRevision: restored.revision },
        change: { type: 'transition', status: { name: 'Completed', category: 'completed' } },
        request: { mode: 'request' },
        reason: 'Attempt completion from the latest verifier result.',
      }, actor, 160);

      expect(completed).toMatchObject({
        status: 'blocked',
        validation: [expect.objectContaining({ code: 'verification_required' })],
      });
      expect((await store.search({ filter: { needsAttention: true } })).rows)
        .toContainEqual(expect.objectContaining({ target: { type: 'issue', id: issueId } }));
    });
  });

  test('clears historical Session failure attention after a successful retry completes the Issue', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: { title: 'Retry clears historical attention' },
        request: { mode: 'request' },
        reason: 'Create retry attention work.',
      }, actor, 100);
      const issue = (await store.search({ text: 'Retry clears historical attention' })).rows[0];
      const firstStart = await store.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start the failing attempt.',
      }, { type: 'runtime-action', actor }, actor, 110);
      const firstSessionId = firstStart.targets.find((target) => target.type === 'agent-session')!.id;
      await store.bindSessionExecution(firstSessionId, {
        engine: 'delegation',
        conversationId: 'conversation:retry-attention',
        executionId: 'execution:retry-attention:first',
        startedAt: 120,
      }, actor, 120);
      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:retry-attention:first',
        state: 'failed',
        errorMessage: 'First attempt failed.',
        completedAt: 130,
      }, actor, 130);
      expect((await store.search({ filter: { needsAttention: true } })).rows.map((row) => row.target.id))
        .toContain(issue.target.id);

      const currentIssue = (await store.search({ text: 'Retry clears historical attention' })).rows[0];
      const retryStart = await store.startSession({
        issueId: currentIssue.target.id,
        expectedIssueRevision: currentIssue.revision,
        continuation: {
          previousAgentSessionId: firstSessionId,
          intent: 'retry',
          context: 'summary',
        },
        request: { mode: 'request' },
        reason: 'Retry after the first failure.',
      }, { type: 'runtime-action', actor }, actor, 140);
      const retrySessionId = retryStart.targets.find((target) => target.type === 'agent-session')!.id;
      await store.bindSessionExecution(retrySessionId, {
        engine: 'delegation',
        conversationId: 'conversation:retry-attention',
        executionId: 'execution:retry-attention:retry',
        startedAt: 150,
      }, actor, 150);
      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:retry-attention:retry',
        state: 'completed',
        latestOutput: 'Retry completed successfully.',
        completedAt: 160,
      }, actor, 160);

      const completed = (await store.search({
        text: 'Retry clears historical attention',
        include: ['session-summary'],
      })).rows[0];
      expect(completed).toMatchObject({
        statusCategory: 'completed',
        latestSessionState: 'complete',
        needsAttention: false,
      });
      expect(completed.viewBuckets).not.toContain('attention-needed');
      expect((await store.search({ filter: { needsAttention: true } })).rows.map((row) => row.target.id))
        .not.toContain(issue.target.id);
    });
  });

  test('validates relation targets, self links, duplicates, delete references, and blocks semantics', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: { title: 'Blocked target' },
        request: { mode: 'request' },
        reason: 'Create relation target.',
      }, actor, 10);
      const target = (await store.search({ text: 'Blocked target', targets: ['issue'] })).rows[0];
      await store.create({
        issueType: 'issue',
        fields: {
          title: 'Blocking source',
          relations: [{ type: 'blocks', issueId: target.target.id }],
        },
        request: { mode: 'request' },
        reason: 'Create blocker.',
      }, actor, 20);
      const blocker = (await store.search({ text: 'Blocking source', targets: ['issue'] })).rows[0];

      expect((await store.listReadyIssuesForExecution(30)).map((issue) => issue.id)).not.toContain(target.target.id);
      expect((await store.search({
        filter: { relation: { type: 'blocks', issueId: target.target.id } },
        targets: ['issue'],
      })).rows.map((row) => row.target.id)).toEqual([blocker.target.id]);

      const missingRelation = await store.create({
        issueType: 'issue',
        fields: { title: 'Dangling relation', relations: [{ type: 'related', issueId: 'issue:missing' }] },
        request: { mode: 'request' },
        reason: 'Reject dangling relation.',
      }, actor, 30);
      expect(missingRelation.status).toBe('blocked');
      expect(missingRelation.validation?.map((entry) => entry.code)).toContain('relation_target_not_found');

      const duplicate = await store.update({
        target: { type: 'issue', id: blocker.target.id, expectedRevision: blocker.revision },
        change: {
          type: 'patch',
          patch: {
            relations: [
              { type: 'related', issueId: target.target.id },
              { type: 'related', issueId: target.target.id },
            ],
          },
        },
        request: { mode: 'request' },
        reason: 'Reject duplicate relation.',
      }, actor, 40);
      expect(duplicate.status).toBe('blocked');
      expect(duplicate.validation?.map((entry) => entry.code)).toContain('duplicate_relation');

      const self = await store.update({
        target: { type: 'issue', id: blocker.target.id, expectedRevision: blocker.revision },
        change: { type: 'patch', patch: { relations: [{ type: 'blocked-by', issueId: blocker.target.id }] } },
        request: { mode: 'request' },
        reason: 'Reject self relation.',
      }, actor, 41);
      expect(self.status).toBe('blocked');
      expect(self.validation?.map((entry) => entry.code)).toContain('self_relation');

      const referencedDelete = await store.update({
        target: { type: 'issue', id: target.target.id, expectedRevision: target.revision },
        change: { type: 'delete' },
        request: { mode: 'request' },
        reason: 'Reject deleting a referenced Issue.',
      }, actor, 50);
      expect(referencedDelete.status).toBe('blocked');
      expect(referencedDelete.validation?.map((entry) => entry.code)).toContain('issue_is_referenced');

      await store.update({
        target: { type: 'issue', id: blocker.target.id },
        change: { type: 'transition', status: { name: 'Canceled', category: 'canceled' } },
        request: { mode: 'request' },
        reason: 'Cancel blocker.',
      }, actor, 60);
      expect((await store.listReadyIssuesForExecution(70)).map((issue) => issue.id)).toContain(target.target.id);
    });
  });

  test('keeps search target families isolated and searches Session output plus Session Activity', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Unrelated routine',
          cadence: { type: 'daily', time: '09:00' },
          timeZone: 'UTC',
          issueTemplate: { permissionMode: 'unattended' },
        },
        request: { mode: 'request' },
        reason: 'Create unrelated recurring work.',
      }, actor, 10);
      await store.create({
        issueType: 'issue',
        fields: { title: 'Searchable execution' },
        request: { mode: 'request' },
        reason: 'Create searchable work.',
      }, actor, 20);
      const issue = (await store.search({ text: 'Searchable execution', targets: ['issue'] })).rows[0];
      const started = await store.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start searchable work.',
      }, { type: 'runtime-action', actor }, actor, 30);
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
      await store.bindSessionExecution(sessionId, {
        engine: 'delegation',
        conversationId: 'conversation:searchable',
        executionId: 'execution:searchable',
        startedAt: 40,
      }, actor, 40);
      await store.sendSessionMessage({
        agentSessionId: sessionId,
        message: 'Activity needle for search.',
        request: { mode: 'request' },
        reason: 'Record searchable Activity.',
      }, actor, 50);
      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:searchable',
        state: 'completed',
        latestOutput: 'Output needle for search.',
        completedAt: 60,
      }, actor, 60);

      expect((await store.search({ filter: { issueIds: [issue.target.id] } })).rows.map((row) => row.target))
        .toEqual([{ type: 'issue', id: issue.target.id }]);
      expect((await store.search({ text: 'Activity needle' })).rows.map((row) => row.target.id)).toContain(issue.target.id);
      expect((await store.search({ text: 'Output needle' })).rows.map((row) => row.target.id)).toContain(issue.target.id);
      const detail = await store.read({ target: issue.target, include: ['activity'] });
      expect(detail.activity?.some((entry) => (
        entry.target.type === 'agent-session'
        && entry.content.type === 'comment'
        && entry.content.body.includes('Activity needle')
      ))).toBe(true);
    });
  });

  test('clears dueDate with null and keeps terminal Issue states terminal', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: { title: 'Terminal patch', dueDate: { targetAt: 100 } },
        request: { mode: 'request' },
        reason: 'Create patchable work.',
      }, actor, 10);
      const issue = (await store.search({ targets: ['issue'] })).rows[0];
      const cleared = await store.update({
        target: { type: 'issue', id: issue.target.id, expectedRevision: issue.revision },
        change: { type: 'patch', patch: { dueDate: null } },
        request: { mode: 'request' },
        reason: 'Clear the due date.',
      }, actor, 20);
      expect(cleared.status).toBe('applied');
      const current = (await store.read({ target: issue.target })).issue!;
      expect(current.dueDate).toBeUndefined();
      await store.update({
        target: { type: 'issue', id: current.id, expectedRevision: current.revision },
        change: { type: 'transition', status: { name: 'Canceled', category: 'canceled' } },
        request: { mode: 'request' },
        reason: 'Cancel the Issue.',
      }, actor, 30);
      const canceled = (await store.read({ target: issue.target })).issue!;
      expect(canceled.terminalAt).toBe(30);
      await store.update({
        target: { type: 'issue', id: canceled.id, expectedRevision: canceled.revision },
        change: { type: 'patch', patch: { description: 'Edited after cancellation.' } },
        request: { mode: 'request' },
        reason: 'Edit terminal metadata without changing terminal time.',
      }, actor, 35);
      const edited = (await store.read({ target: issue.target })).issue!;
      expect(edited.updatedAt).toBe(35);
      expect(edited.terminalAt).toBe(30);
      expect((await store.search({
        targets: ['issue'],
        filter: { terminalAt: { from: 30, to: 30 } },
      })).rows.map((row) => row.target.id)).toContain(canceled.id);
      expect((await store.search({
        targets: ['issue'],
        filter: { terminalAt: { from: 31 } },
      })).rows.map((row) => row.target.id)).not.toContain(canceled.id);
      const reopened = await store.update({
        target: { type: 'issue', id: edited.id, expectedRevision: edited.revision },
        change: { type: 'transition', status: { name: 'Started', category: 'started' } },
        request: { mode: 'request' },
        reason: 'Attempt to reopen terminal work.',
      }, actor, 40);
      expect(reopened.status).toBe('blocked');
      expect(reopened.validation?.map((entry) => entry.code)).toContain('terminal_issue');
    });
  });

  test('accepts child origins only from active execution-bound parent Sessions', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: { title: 'Origin parent' },
        request: { mode: 'request' },
        reason: 'Create parent.',
      }, actor, 10);
      const parent = (await store.search({ targets: ['issue'] })).rows[0];
      const started = await store.startSession({
        issueId: parent.target.id,
        expectedIssueRevision: parent.revision,
        request: { mode: 'request' },
        reason: 'Start parent.',
      }, { type: 'runtime-action', actor }, actor, 20);
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
      const createChild = (title: string, now: number) => store.create({
        issueType: 'issue',
        fields: { title },
        request: { mode: 'request' },
        reason: 'Create child.',
      }, actor, now, { origin: { type: 'agent-session', agentSessionId: sessionId } });

      expect((await createChild('Pending parent child', 21)).status).toBe('blocked');
      await store.bindSessionExecution(sessionId, {
        engine: 'delegation',
        conversationId: 'conversation:origin-parent',
        executionId: 'execution:origin-parent',
        startedAt: 22,
      }, actor, 22);
      expect((await createChild('Active parent child', 23)).status).toBe('applied');
      const dangling = await store.create({
        issueType: 'issue',
        fields: { title: 'Dangling parent child' },
        request: { mode: 'request' },
        reason: 'Reject dangling origin.',
      }, actor, 24, { origin: { type: 'agent-session', agentSessionId: 'agent-session:missing' } });
      expect(dangling.status).toBe('blocked');
      expect(dangling.validation?.map((entry) => entry.code)).toContain('invalid_origin');
    });
  });

  test('keeps persisted child Issues startable after a non-canceled parent Session becomes terminal', async () => {
    for (const terminalState of ['complete', 'error', 'stale'] as const) {
      await withStore(async (store) => {
        await store.create({
          issueType: 'issue',
          fields: { title: `Parent ${terminalState}` },
          request: { mode: 'request' },
          reason: 'Create parent work.',
        }, actor, 10);
        const parent = (await store.search({ targets: ['issue'] })).rows[0]!;
        const parentStarted = await store.startSession({
          issueId: parent.target.id,
          expectedIssueRevision: parent.revision,
          request: { mode: 'request' },
          reason: 'Start parent work.',
        }, { type: 'runtime-action', actor }, actor, 20);
        const parentSessionId = parentStarted.targets.find((target) => target.type === 'agent-session')!.id;
        await store.bindSessionExecution(parentSessionId, {
          engine: 'delegation',
          conversationId: `conversation:parent-${terminalState}`,
          executionId: `execution:parent-${terminalState}`,
          startedAt: 30,
        }, actor, 30);
        const childCreated = await store.create({
          issueType: 'issue',
          fields: { title: `Child after ${terminalState}` },
          request: { mode: 'request' },
          reason: 'Persist child work before the parent becomes terminal.',
        }, actor, 40, { origin: { type: 'agent-session', agentSessionId: parentSessionId } });
        const childId = childCreated.targets.find((target) => target.type === 'issue')!.id;

        if (terminalState === 'complete') {
          await store.syncSessionExecution({
            engine: 'delegation',
            executionId: `execution:parent-${terminalState}`,
            state: 'completed',
            latestOutput: 'Parent is waiting for its persisted child.',
            completedAt: 50,
          }, actor, 50);
        } else if (terminalState === 'error') {
          await store.syncSessionExecution({
            engine: 'delegation',
            executionId: `execution:parent-${terminalState}`,
            state: 'failed',
            errorMessage: 'Parent execution failed after child creation.',
            completedAt: 50,
          }, actor, 50);
        } else {
          await store.markInterruptedSessionsStale(actor, 50);
        }
        expect((await store.readSession({ agentSessionId: parentSessionId }))?.agentSession.state).toBe(terminalState);
        const child = (await store.read({ target: { type: 'issue', id: childId } })).issue!;
        const childStarted = await store.startSession({
          issueId: childId,
          expectedIssueRevision: child.revision,
          request: { mode: 'request' },
          reason: 'Start the persisted child through its original parent route.',
        }, { type: 'orchestration', coordinatorAgentSessionId: parentSessionId }, actor, 60);
        expect(childStarted.status).toBe('applied');
      });
    }
  });

  test('enforces parent read/write node ceilings across child create, patch, and start', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: {
          title: 'Scoped parent',
          noteNodeIds: ['node:allowed-note'],
          input: { type: 'selected-nodes', nodeIds: ['node:read-only-input'] },
          output: { type: 'append-to-node', nodeId: 'node:writable-output' },
        },
        request: { mode: 'request' },
        reason: 'Create scoped parent work.',
      }, actor, 10);
      const parent = (await store.search({ targets: ['issue'] })).rows[0]!;
      const parentStarted = await store.startSession({
        issueId: parent.target.id,
        expectedIssueRevision: parent.revision,
        request: { mode: 'request' },
        reason: 'Start scoped parent work.',
      }, { type: 'runtime-action', actor }, actor, 20, {
        resolveInput: async (input, _issue, now) => ({ scope: input, resolvedAt: now, nodeIds: ['node:read-only-input'] }),
      });
      const parentSessionId = parentStarted.targets.find((target) => target.type === 'agent-session')!.id;
      await store.bindSessionExecution(parentSessionId, {
        engine: 'delegation',
        conversationId: 'conversation:scoped-parent',
        executionId: 'execution:scoped-parent',
        startedAt: 30,
      }, actor, 30);
      const createChild = (title: string, fields: Omit<IssueDraftFields, 'title'>, now: number) => store.create({
        issueType: 'issue',
        fields: { title, ...fields },
        request: { mode: 'request' },
        reason: 'Create scoped child work.',
      }, actor, now, { origin: { type: 'agent-session', agentSessionId: parentSessionId } });

      const outsidePreview = await store.create({
        issueType: 'issue',
        fields: { title: 'Outside preview child', noteNodeIds: ['node:outside'] },
        request: { mode: 'preview' },
        reason: 'Preview scoped child work.',
      }, actor, 39, { origin: { type: 'agent-session', agentSessionId: parentSessionId } });
      expect(outsidePreview.validation).toContainEqual(expect.objectContaining({ code: 'child_scope_broadened' }));

      expect((await createChild('Outside note child', { noteNodeIds: ['node:outside'] }, 40)).validation)
        .toContainEqual(expect.objectContaining({ code: 'child_scope_broadened' }));
      expect((await createChild('Read escalation child', {
        output: { type: 'append-to-node', nodeId: 'node:read-only-input' },
      }, 41)).validation).toContainEqual(expect.objectContaining({ code: 'child_scope_broadened' }));
      const allowed = await createChild('Allowed scoped child', {
        noteNodeIds: ['node:allowed-note'],
        output: { type: 'append-to-node', nodeId: 'node:writable-output' },
      }, 42);
      expect(allowed.status).toBe('applied');
      const childId = allowed.targets.find((target) => target.type === 'issue')!.id;
      const child = (await store.read({ target: { type: 'issue', id: childId } })).issue!;
      const widenedPreview = await store.update({
        target: { type: 'issue', id: childId, expectedRevision: child.revision },
        change: { type: 'patch', patch: { noteNodeIds: ['node:outside'] } },
        request: { mode: 'preview' },
        reason: 'Preview widening the persisted child.',
      }, actor, 49);
      expect(widenedPreview.validation).toContainEqual(expect.objectContaining({ code: 'child_scope_broadened' }));
      const widenedPatch = await store.update({
        target: { type: 'issue', id: childId, expectedRevision: child.revision },
        change: { type: 'patch', patch: { noteNodeIds: ['node:outside'] } },
        request: { mode: 'request' },
        reason: 'Attempt to widen the persisted child.',
      }, actor, 50);
      expect(widenedPatch.validation).toContainEqual(expect.objectContaining({ code: 'child_scope_broadened' }));
      const childStart = await store.startSession({
        issueId: childId,
        expectedIssueRevision: child.revision,
        request: { mode: 'request' },
        reason: 'Start within the inherited ceiling.',
      }, { type: 'orchestration', coordinatorAgentSessionId: parentSessionId }, actor, 60);
      expect(childStart.status).toBe('applied');
    });
  });

  test('lists ready Issues once and excludes Issues that already have a Session', async () => {
    await withStore(async (store) => {
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
      }, actor, 10, {
        origin: { type: 'conversation', conversationId: 'conversation:issue' },
      });
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
      expect(Object.values((await store.state()).terminalDeliveries)).toEqual([
        expect.objectContaining({
          agentSessionId: sessionId,
          origin: { type: 'conversation', conversationId: 'conversation:issue' },
          state: 'error',
          status: 'pending',
        }),
      ]);

      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:interrupted',
        state: 'failed',
        errorMessage: 'The delegated run was interrupted before conversation restore.',
        completedAt: 35,
      }, { type: 'system' }, 50);
      expect(Object.values((await store.state()).terminalDeliveries)).toHaveLength(1);

      expect(await store.markInterruptedSessionsStale({ type: 'system' }, 60)).toEqual([]);
    });
  });
});
