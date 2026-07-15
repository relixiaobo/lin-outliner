import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core } from '../../src/core/core';
import type { ActorRef } from '../../src/core/agentIssue';
import { createAgentIssueToolRuntime, type AgentSessionExecutor } from '../../src/main/agentIssueRuntime';
import { validateIssueNodeDefinition } from '../../src/main/agentIssueExecutionPreparation';
import { AgentIssueStore } from '../../src/main/agentIssueStore';

const actor: ActorRef = { type: 'agent', agentId: 'built-in:tenon:assistant' };
const rootOrigin = { type: 'conversation' as const, conversationId: 'conversation:runtime-test-origin' };

async function withStore<T>(fn: (store: AgentIssueStore) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'lin-agent-issue-runtime-'));
  try {
    return await fn(AgentIssueStore.forAgentDataRoot(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('agent issue tool runtime execution', () => {
  test('blocks creation previews and requests when runtime cannot resolve a routing origin', async () => {
    await withStore(async (store) => {
      const runtime = createAgentIssueToolRuntime({ store, actor, now: () => 100 });
      for (const mode of ['preview', 'request'] as const) {
        const result = await runtime.create({
          issueType: 'issue',
          fields: { title: 'Originless runtime Issue' },
          request: { mode },
          reason: 'Reject originless work.',
        });
        expect(result.status).toBe('blocked');
        expect(result.validation?.map((entry) => entry.code)).toContain('invalid_origin');
      }
      expect((await store.search({})).rows).toEqual([]);
    });
  });

  test('creates scheduled recurring work with runtime provenance by default', async () => {
    await withStore(async (store) => {
      const origin = { type: 'conversation' as const, conversationId: 'conversation:recurring-origin' };
      const runtime = createAgentIssueToolRuntime({
        store,
        actor,
        origin: () => origin,
        now: () => 1_800_000_000_000,
      });
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
      expect(read.recurringIssue?.origin).toEqual(origin);

      const materialized = await store.materializeDueRecurringIssues(
        read.recurringIssue!.nextMaterializationAt!,
        actor,
      );
      expect(materialized).toHaveLength(1);
      expect(materialized[0]).toMatchObject({ origin });
      expect(materialized[0].parentIssueId).toBeUndefined();
    });
  });

  test('starts Issue work without a separate approval handoff', async () => {
    await withStore(async (store) => {
      const runtime = createAgentIssueToolRuntime({ store, actor, origin: () => rootOrigin, now: () => 100 });
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

  test('turns request preparation failures into terminal Sessions while previews stay non-persistent', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: { title: 'Unresolvable runtime work' },
        request: { mode: 'request' },
        reason: 'Create work for preparation failure.',
      }, actor, 100, { origin: rootOrigin });
      const row = (await store.search({ text: 'Unresolvable runtime work' })).rows[0]!;
      let deliveryNotifications = 0;
      const runtime = createAgentIssueToolRuntime({
        store,
        actor,
        origin: () => rootOrigin,
        prepareExecution: async () => ({
          ok: false,
          validation: [{
            path: 'output',
            code: 'daily_note_resolution_failed',
            message: 'The Daily Note destination could not be resolved.',
          }],
        }),
        onIssueDeliveryQueued: () => {
          deliveryNotifications += 1;
        },
        now: () => 110,
      });

      const preview = await runtime.startSession({
        issueId: row.target.id,
        expectedIssueRevision: row.revision,
        request: { mode: 'preview' },
        reason: 'Preview the failure.',
      });
      expect(preview.status).toBe('blocked');
      expect(Object.values((await store.state()).sessions)).toHaveLength(0);

      const request = await runtime.startSession({
        issueId: row.target.id,
        expectedIssueRevision: row.revision,
        request: { mode: 'request' },
        reason: 'Record the execution failure.',
      });
      expect(request.status).toBe('blocked');
      const sessions = Object.values((await store.state()).sessions);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        state: 'error',
        errorMessage: 'The Daily Note destination could not be resolved.',
      });
      expect(deliveryNotifications).toBe(1);
    });
  });

  test('runs request preparation only after the non-mutating Store gate passes', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: { title: 'Two-stage preparation' },
        request: { mode: 'request' },
        reason: 'Create gated work.',
      }, actor, 100, { origin: rootOrigin });
      const row = (await store.search({ text: 'Two-stage preparation' })).rows[0]!;
      const modes: Array<'preview' | 'request'> = [];
      const runtime = createAgentIssueToolRuntime({
        store,
        actor,
        origin: () => rootOrigin,
        prepareExecution: async (issue, _now, mode) => {
          modes.push(mode);
          return {
            ok: true,
            prepared: {
              issueRevision: issue.revision,
              mode,
              warnings: [],
            },
          };
        },
        now: () => 110,
      });

      const conflict = await runtime.startSession({
        issueId: row.target.id,
        expectedIssueRevision: 'revision:stale',
        request: { mode: 'request' },
        reason: 'Reject before request preparation can mutate.',
      });
      expect(conflict.status).toBe('conflict');
      expect(modes).toEqual(['preview']);

      const started = await runtime.startSession({
        issueId: row.target.id,
        expectedIssueRevision: row.revision,
        request: { mode: 'request' },
        reason: 'Run both preparation phases.',
      });
      expect(started.status).toBe('applied');
      expect(modes).toEqual(['preview', 'preview', 'request']);
    });
  });

  test('preflights executable definitions before creating or resuming active work', async () => {
    await withStore(async (store) => {
      const core = Core.new();
      const runtime = createAgentIssueToolRuntime({
        store,
        actor,
        origin: () => rootOrigin,
        validateDefinition: (definition, validationOptions) => validateIssueNodeDefinition(
          definition,
          core.projection(),
          validationOptions,
        ),
        now: () => 100,
      });

      const savedQuery = await runtime.create({
        issueType: 'issue',
        fields: {
          title: 'Unsupported saved query',
          input: { type: 'saved-query', queryId: 'query:missing' },
        },
        request: { mode: 'request' },
        reason: 'Reject unsupported active work.',
      });
      expect(savedQuery.validation?.map((entry) => entry.code)).toContain('saved_query_not_supported');

      const missingDueDate = await runtime.create({
        issueType: 'issue',
        fields: {
          title: 'Missing Daily Note due date',
          output: { type: 'daily-note', datePolicy: 'due-date' },
        },
        request: { mode: 'request' },
        reason: 'Reject a due-date output without a due date.',
      });
      expect(missingDueDate.validation?.map((entry) => entry.code)).toContain('daily_note_due_date_missing');

      const recurring = await runtime.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Daily Note routine',
          cadence: { type: 'daily', time: '10:00' },
          timeZone: 'Asia/Shanghai',
          issueTemplate: {
            permissionMode: 'unattended',
            output: { type: 'daily-note', datePolicy: 'due-date' },
          },
        },
        request: { mode: 'request' },
        reason: 'Recurring windows supply the concrete due date.',
      });
      expect(recurring.status).toBe('applied');
      await store.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Legacy paused saved query',
          cadence: { type: 'daily', time: '11:00' },
          timeZone: 'UTC',
          issueTemplate: {
            permissionMode: 'unattended',
            input: { type: 'saved-query', queryId: 'query:legacy' },
          },
        },
        request: { mode: 'request' },
        reason: 'Seed a pre-preflight definition.',
      }, actor, 101, { origin: rootOrigin });
      let legacy = (await store.search({ text: 'Legacy paused saved query' })).rows[0]!;
      await store.update({
        target: { type: 'recurring-issue', id: legacy.target.id, expectedRevision: legacy.revision },
        change: { type: 'pause' },
        request: { mode: 'request' },
        reason: 'Pause the legacy definition.',
      }, actor, 102);
      legacy = (await store.search({ text: 'Legacy paused saved query' })).rows[0]!;
      const resumed = await runtime.update({
        target: { type: 'recurring-issue', id: legacy.target.id, expectedRevision: legacy.revision },
        change: { type: 'resume' },
        request: { mode: 'request' },
        reason: 'Do not reactivate an unsupported definition.',
      });
      expect(resumed.validation?.map((entry) => entry.code)).toContain('saved_query_not_supported');
      expect((await store.read({ target: legacy.target })).recurringIssue?.status).toBe('paused');
    });
  });

  test('records the owning Agent Session as the origin of child Issues', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: { title: 'Parent issue' },
        request: { mode: 'request' },
        reason: 'Create parent work.',
      }, actor, 100);
      const parentIssue = (await store.search({ targets: ['issue'] })).rows[0];
      const started = await store.startSession({
        issueId: parentIssue.target.id,
        expectedIssueRevision: parentIssue.revision,
        request: { mode: 'request' },
        reason: 'Start parent work.',
      }, { type: 'runtime-action', actor }, actor, 110);
      const parentAgentSessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
      await store.bindSessionExecution(parentAgentSessionId, {
        engine: 'delegation',
        conversationId: 'conversation:parent-issue',
        executionId: 'execution:parent-issue',
        startedAt: 120,
      }, actor, 120);

      const runtime = createAgentIssueToolRuntime({
        store,
        actor,
        origin: () => ({ type: 'agent-session', agentSessionId: parentAgentSessionId }),
        now: () => 130,
      });
      const created = await runtime.create({
        issueType: 'issue',
        fields: { title: 'Child issue' },
        request: { mode: 'request' },
        reason: 'Create child work.',
      });

      expect(created.status).toBe('applied');
      const childIssue = await store.read({
        target: created.targets.find((target) => target.type === 'issue')!,
      });
      expect(childIssue.issue).toMatchObject({
        parentIssueId: parentIssue.target.id,
        origin: { type: 'agent-session', agentSessionId: parentAgentSessionId },
      });
    });
  });

  test('confines an Agent Session caller to its owning Issue and direct child branch', async () => {
    await withStore(async (store) => {
      await store.create({
        issueType: 'issue',
        fields: { title: 'Caller-owned parent' },
        request: { mode: 'request' },
        reason: 'Create the caller parent.',
      }, actor, 100);
      await store.create({
        issueType: 'issue',
        fields: { title: 'Unrelated root' },
        request: { mode: 'request' },
        reason: 'Create unrelated work.',
      }, actor, 101);
      const rows = await store.search({ targets: ['issue'] });
      const parent = rows.rows.find((row) => row.title === 'Caller-owned parent')!;
      const unrelated = rows.rows.find((row) => row.title === 'Unrelated root')!;
      const parentStarted = await store.startSession({
        issueId: parent.target.id,
        expectedIssueRevision: parent.revision,
        request: { mode: 'request' },
        reason: 'Start caller parent work.',
      }, { type: 'runtime-action', actor }, actor, 110);
      const parentSessionId = parentStarted.targets.find((target) => target.type === 'agent-session')!.id;
      await store.bindSessionExecution(parentSessionId, {
        engine: 'delegation',
        conversationId: 'conversation:caller-parent',
        executionId: 'execution:caller-parent',
        startedAt: 120,
      }, actor, 120);
      const unrelatedStarted = await store.startSession({
        issueId: unrelated.target.id,
        expectedIssueRevision: unrelated.revision,
        request: { mode: 'request' },
        reason: 'Start unrelated work.',
      }, { type: 'runtime-action', actor }, actor, 121);
      const unrelatedSessionId = unrelatedStarted.targets.find((target) => target.type === 'agent-session')!.id;
      await store.bindSessionExecution(unrelatedSessionId, {
        engine: 'delegation',
        conversationId: 'conversation:unrelated',
        executionId: 'execution:unrelated',
        startedAt: 122,
      }, actor, 122);
      const parentAfterBinding = (await store.read({ target: parent.target })).issue!;
      const trustedRelationUpdate = await store.update({
        target: {
          type: 'issue',
          id: parent.target.id,
          expectedRevision: parentAfterBinding.revision,
        },
        change: {
          type: 'patch',
          patch: { relations: [{ type: 'related', issueId: unrelated.target.id }] },
        },
        request: { mode: 'request' },
        reason: 'Attach a trusted external relation before the Session acts.',
      }, actor, 123);
      expect(trustedRelationUpdate.status).toBe('applied');
      const parentWithExternalRelation = (await store.read({ target: parent.target })).issue!;

      const runtime = createAgentIssueToolRuntime({
        store,
        actor,
        origin: () => ({ type: 'agent-session', agentSessionId: parentSessionId }),
        executor: {
          start: async ({ session, now, bindExecution }) => {
            const binding = {
              engine: 'delegation' as const,
              conversationId: 'conversation:direct-child',
              executionId: `execution:${session.id}`,
              startedAt: now,
            };
            await bindExecution(binding);
            return binding;
          },
        },
        now: () => 130,
      });
      const childCreated = await runtime.create({
        issueType: 'issue',
        fields: { title: 'Direct child' },
        request: { mode: 'request' },
        reason: 'Create direct child work.',
      });
      const childId = childCreated.targets.find((target) => target.type === 'issue')!.id;
      const scopedRelationCreate = await runtime.create({
        issueType: 'issue',
        fields: {
          title: 'Unauthorized related child',
          relations: [{ type: 'blocks', issueId: unrelated.target.id }],
        },
        request: { mode: 'request' },
        reason: 'Attempt to affect an unrelated branch through a child relation.',
      });
      expect(scopedRelationCreate.validation?.[0]?.code).toBe('caller_scope_denied');
      const scopedRelationUpdate = await runtime.update({
        target: {
          type: 'issue',
          id: parent.target.id,
          expectedRevision: parentWithExternalRelation.revision,
        },
        change: {
          type: 'patch',
          patch: { relations: [{ type: 'blocks', issueId: unrelated.target.id }] },
        },
        request: { mode: 'request' },
        reason: 'Attempt to affect an unrelated branch through a parent relation.',
      });
      expect(scopedRelationUpdate.validation?.[0]?.code).toBe('caller_scope_denied');
      const scopedRelationRemoval = await runtime.update({
        target: {
          type: 'issue',
          id: parent.target.id,
          expectedRevision: parentWithExternalRelation.revision,
        },
        change: { type: 'patch', patch: { relations: [] } },
        request: { mode: 'request' },
        reason: 'Attempt to remove a trusted relation outside the Session branch.',
      });
      expect(scopedRelationRemoval.validation?.[0]?.code).toBe('caller_scope_denied');
      await store.create({
        issueType: 'issue',
        fields: { title: 'Newest unrelated root' },
        request: { mode: 'request' },
        reason: 'Create a newer unrelated row that must not consume scoped pagination.',
      }, actor, 132);
      const firstScopedPage = await runtime.search({ targets: ['issue'], limit: 1 });
      expect(firstScopedPage.rows).toHaveLength(1);
      expect(firstScopedPage.rows[0]?.title).not.toBe('Newest unrelated root');
      expect(firstScopedPage.nextCursor).toBe('1');
      const secondScopedPage = await runtime.search({
        targets: ['issue'],
        limit: 1,
        cursor: firstScopedPage.nextCursor,
      });
      expect(secondScopedPage.rows).toHaveLength(1);
      expect(secondScopedPage.nextCursor).toBeUndefined();
      const visible = await runtime.search({ targets: ['issue'] });
      expect(visible.rows.map((row) => row.target.id).sort()).toEqual([childId, parent.target.id].sort());
      expect((await runtime.read({ target: unrelated.target })).issue).toBeUndefined();
      expect((await store.read({ target: unrelated.target })).issue?.relations).toEqual([]);
      expect((await store.read({ target: parent.target })).issue?.relations).toEqual([
        { type: 'related', issueId: unrelated.target.id },
      ]);

      const unrelatedUpdate = await runtime.update({
        target: { type: 'issue', id: unrelated.target.id, expectedRevision: unrelated.revision },
        change: { type: 'patch', patch: { description: 'Unauthorized edit.' } },
        request: { mode: 'request' },
        reason: 'Attempt unrelated edit.',
      });
      expect(unrelatedUpdate.validation?.[0]?.code).toBe('caller_scope_denied');
      const directCompletion = await runtime.update({
        target: { type: 'issue', id: childId },
        change: { type: 'transition', status: { name: 'Completed', category: 'completed' } },
        request: { mode: 'request' },
        reason: 'Attempt to bypass child execution.',
      });
      expect(directCompletion.validation?.[0]?.code).toBe('caller_scope_denied');
      const child = (await store.read({ target: { type: 'issue', id: childId } })).issue!;
      const childStart = await runtime.startSession({
        issueId: childId,
        expectedIssueRevision: child.revision,
        request: { mode: 'request' },
        reason: 'Explicitly start the direct child through the parent Session.',
      });
      expect(childStart.status).toBe('applied');
      const childSessionId = childStart.targets.find((target) => target.type === 'agent-session')!.id;
      const childRuntime = createAgentIssueToolRuntime({
        store,
        actor,
        origin: () => ({ type: 'agent-session', agentSessionId: childSessionId }),
        now: () => 131,
      });
      const grandchildCreated = await childRuntime.create({
        issueType: 'issue',
        fields: { title: 'Grandchild outside caller scope' },
        request: { mode: 'request' },
        reason: 'Create nested child work.',
      });
      expect(grandchildCreated.status).toBe('applied');
      const childBranch = await runtime.read({
        target: { type: 'issue', id: childId },
        include: ['child-issues'],
      });
      expect(childBranch.childIssues).toEqual([]);
      const owningBranch = await runtime.read({
        target: parent.target,
        include: ['child-issues'],
      });
      expect(owningBranch.childIssues?.map((issue) => issue.id)).toEqual([childId]);
      const unrelatedStart = await runtime.startSession({
        issueId: unrelated.target.id,
        expectedIssueRevision: unrelated.revision,
        request: { mode: 'request' },
        reason: 'Attempt unrelated execution.',
      });
      expect(unrelatedStart.validation?.[0]?.code).toBe('caller_scope_denied');
      expect(await runtime.readSession({ agentSessionId: unrelatedSessionId })).toBeNull();
      expect((await runtime.sendSessionMessage({
        agentSessionId: unrelatedSessionId,
        message: 'Unauthorized guidance.',
        request: { mode: 'request' },
        reason: 'Attempt unrelated control.',
      })).validation?.[0]?.code).toBe('caller_scope_denied');
      expect((await runtime.stopSession({
        agentSessionId: unrelatedSessionId,
        request: { mode: 'request' },
        reason: 'Attempt unrelated stop.',
      })).validation?.[0]?.code).toBe('caller_scope_denied');
      const recurring = await runtime.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Unauthorized recurring work',
          cadence: { type: 'daily', time: '09:00' },
          timeZone: 'UTC',
          issueTemplate: { permissionMode: 'unattended' },
        },
        request: { mode: 'request' },
        reason: 'Attempt recurring creation from a Session.',
      });
      expect(recurring.status).toBe('blocked');
      expect(recurring.validation?.[0]?.code).toBe('invalid_origin');
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
        origin: () => rootOrigin,
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

  for (const detach of [true, false] as const) {
    test(`binds ${detach ? 'detached' : 'attended'} execution before the executor returns`, async () => {
      await withStore(async (store) => {
        const firstBinding = {
          engine: 'delegation' as const,
          conversationId: `conversation:${detach ? 'detached' : 'attended'}`,
          executionId: `execution:${detach ? 'detached' : 'attended'}`,
          startedAt: 250,
        };
        const executor: AgentSessionExecutor = {
          start: async ({ session, startInput, bindExecution }) => {
            expect(startInput.detach).toBe(detach);
            await bindExecution(firstBinding);
            expect(await store.executionForSession(session.id)).toMatchObject(firstBinding);

            await bindExecution({
              ...firstBinding,
              executionId: `${firstBinding.executionId}:nested`,
            });
            expect(await store.executionForSession(session.id)).toMatchObject(firstBinding);
            return firstBinding;
          },
        };
        const runtime = createAgentIssueToolRuntime({ store, actor, executor, origin: () => rootOrigin, now: () => 250 });
        await runtime.create({
          issueType: 'issue',
          fields: {
            title: `Pre-bind ${detach ? 'detached' : 'attended'} execution`,
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
          detach,
          request: { mode: 'request' },
          reason: 'Start execution.',
        });

        expect(started.status).toBe('applied');
        const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
        expect(await store.executionForSession(sessionId)).toMatchObject(firstBinding);
      });
    });
  }

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
        read: async () => 'unavailable',
      };
      const runtime = createAgentIssueToolRuntime({ store, actor, executor, origin: () => rootOrigin, now: () => 300 });
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
      expect(await store.executionForSession(sessionId)).toMatchObject({
        engine: 'delegation',
        conversationId: 'conversation:issue',
        executionId: 'execution:issue',
      });
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

  test('keeps a bound Session active when the initial executor refresh fails', async () => {
    await withStore(async (store) => {
      const executor: AgentSessionExecutor = {
        start: () => ({
          engine: 'delegation',
          conversationId: 'conversation:refresh-failure',
          executionId: 'execution:refresh-failure',
          startedAt: 300,
        }),
        read: () => {
          throw new Error('Transient status refresh failure.');
        },
      };
      const runtime = createAgentIssueToolRuntime({ store, actor, executor, origin: () => rootOrigin, now: () => 300 });
      await runtime.create({
        issueType: 'issue',
        fields: { title: 'Refresh failure fixture' },
        request: { mode: 'request' },
        reason: 'Create executable work.',
      });
      const issue = (await runtime.search({ targets: ['issue'] })).rows[0];

      const started = await runtime.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start execution.',
      });

      expect(started.status).toBe('applied');
      expect(started.warnings).toContainEqual({
        code: 'executor_sync_failed',
        message: 'Transient status refresh failure.',
      });
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
      expect((await store.readSession({ agentSessionId: sessionId }))?.agentSession.state).toBe('active');
      expect(Object.values((await store.state()).terminalDeliveries)).toHaveLength(0);
    });
  });

  test('refreshes active Agent Sessions through the executor on read', async () => {
    await withStore(async (store) => {
      let readSequence = 0;
      const executor: AgentSessionExecutor = {
        start: () => ({
          engine: 'delegation',
          conversationId: 'conversation:issue',
          executionId: 'execution:issue',
          startedAt: 300,
        }),
        read: async (binding) => {
          readSequence += 1;
          await store.syncSessionExecution({
            engine: binding.engine,
            executionId: binding.executionId,
            state: 'running',
            latestOutput: `Partial output ${readSequence}.`,
          }, actor, 300 + readSequence);
          return 'synced';
        },
      };
      const runtime = createAgentIssueToolRuntime({ store, actor, executor, origin: () => rootOrigin, now: () => 300 });
      await runtime.create({
        issueType: 'issue',
        fields: {
          title: 'Stream issue progress',
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
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
      const readCountAfterStart = readSequence;

      const read = await runtime.readSession({ agentSessionId: sessionId, include: ['latest-output'] });

      expect(readSequence).toBe(readCountAfterStart + 1);
      expect(read?.agentSession).toMatchObject({
        state: 'active',
        latestOutput: `Partial output ${readSequence}.`,
      });
      const readCountAfterSessionRead = readSequence;

      const issueDetail = await runtime.read({ target: issue.target, include: ['sessions'] });

      expect(readSequence).toBe(readCountAfterSessionRead + 1);
      expect(issueDetail.sessions?.[0]).toMatchObject({
        state: 'active',
        latestOutput: `Partial output ${readSequence}.`,
      });
    });
  });

  test('does not persist Session guidance or cancellation when executor delivery fails', async () => {
    await withStore(async (store) => {
      let stopAttempted = false;
      const executor: AgentSessionExecutor = {
        start: () => ({
          engine: 'delegation',
          conversationId: 'conversation:control-failure',
          executionId: 'execution:control-failure',
          startedAt: 200,
        }),
        sendMessage: () => {
          throw new Error('Guidance delivery failed.');
        },
        stop: () => {
          stopAttempted = true;
          throw new Error('Stop delivery failed.');
        },
        read: async (binding) => {
          if (!stopAttempted) return 'unavailable';
          await store.syncSessionExecution({
            engine: binding.engine,
            executionId: binding.executionId,
            state: 'running',
          }, actor, 210);
          return 'synced';
        },
      };
      const runtime = createAgentIssueToolRuntime({
        store,
        actor,
        executor,
        origin: () => rootOrigin,
        now: () => 200,
      });
      await runtime.create({
        issueType: 'issue',
        fields: { title: 'Control failure fixture' },
        request: { mode: 'request' },
        reason: 'Create control failure work.',
      });
      const issue = (await runtime.search({ targets: ['issue'] })).rows[0];
      const started = await runtime.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start control failure work.',
      });
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;

      expect((await runtime.sendSessionMessage({
        agentSessionId: sessionId,
        message: 'Preview guidance only.',
        request: { mode: 'preview' },
        reason: 'Preview guidance without delivery.',
      })).status).toBe('preview');
      expect((await runtime.stopSession({
        agentSessionId: sessionId,
        request: { mode: 'preview' },
        reason: 'Preview stopping without executor mutation.',
      })).status).toBe('preview');
      expect(stopAttempted).toBe(false);

      const sent = await runtime.sendSessionMessage({
        agentSessionId: sessionId,
        message: 'Must not be audited as delivered.',
        request: { mode: 'request' },
        reason: 'Exercise send failure.',
      });
      expect(sent.status).toBe('blocked');
      expect(sent.validation?.map((entry) => entry.code)).toContain('executor_delivery_failed');
      expect((await store.readSession({ agentSessionId: sessionId, include: ['activity-summary'] }))?.activity
        ?.some((entry) => entry.content.type === 'comment')).toBe(false);

      const stopped = await runtime.stopSession({
        agentSessionId: sessionId,
        request: { mode: 'request' },
        reason: 'Exercise stop failure.',
      });
      expect(stopped.status).toBe('blocked');
      expect(stopped.validation?.map((entry) => entry.code)).toContain('executor_stop_failed');
      expect((await store.readSession({ agentSessionId: sessionId }))?.agentSession.state).toBe('active');
      expect((await store.state()).sessionStopIntents[sessionId]).toBeUndefined();
    });
  });

  test('serializes Session guidance and stop across the external executor boundary', async () => {
    await withStore(async (store) => {
      let releaseSend!: () => void;
      let markSendStarted!: () => void;
      const sendStarted = new Promise<void>((resolve) => {
        markSendStarted = resolve;
      });
      const sendGate = new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
      let stopCalls = 0;
      const executor: AgentSessionExecutor = {
        start: () => ({
          engine: 'delegation',
          conversationId: 'conversation:serialized-control',
          executionId: 'execution:serialized-control',
          startedAt: 200,
        }),
        sendMessage: async () => {
          markSendStarted();
          await sendGate;
        },
        stop: () => {
          stopCalls += 1;
          return 'canceled';
        },
      };
      const sendRuntime = createAgentIssueToolRuntime({
        store,
        actor,
        executor,
        origin: () => rootOrigin,
        now: () => 200,
      });
      const stopRuntime = createAgentIssueToolRuntime({
        store: new AgentIssueStore(store.coordinationKey()),
        actor,
        executor,
        origin: () => rootOrigin,
        now: () => 200,
      });
      await sendRuntime.create({
        issueType: 'issue',
        fields: { title: 'Serialized control fixture' },
        request: { mode: 'request' },
        reason: 'Create serialized control work.',
      });
      const issue = (await sendRuntime.search({ targets: ['issue'] })).rows[0];
      const started = await sendRuntime.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start serialized control work.',
      });
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;

      const send = sendRuntime.sendSessionMessage({
        agentSessionId: sessionId,
        message: 'Persist this guidance before stopping.',
        request: { mode: 'request' },
        reason: 'Exercise serialized guidance.',
      });
      await sendStarted;
      const stop = stopRuntime.stopSession({
        agentSessionId: sessionId,
        request: { mode: 'request' },
        reason: 'Stop after guidance is committed.',
      });
      await Promise.resolve();

      expect(stopCalls).toBe(0);
      expect((await store.state()).sessionStopIntents[sessionId]).toBeUndefined();

      releaseSend();
      expect((await send).status).toBe('applied');
      expect((await stop).status).toBe('applied');
      expect(stopCalls).toBe(1);
      const read = await store.readSession({ agentSessionId: sessionId, include: ['activity-summary'] });
      expect(read?.activity?.some((entry) => (
        entry.content.type === 'comment'
        && entry.content.body === 'Persist this guidance before stopping.'
      ))).toBe(true);
      expect(read?.agentSession.state).toBe('canceled');
    });
  });

  test('lets a pending stop reservation beat a concurrent first binding failure', async () => {
    await withStore(async (store) => {
      let releaseBinding!: () => void;
      let markStartEntered!: () => void;
      let markFailureHandled!: () => void;
      const bindingGate = new Promise<void>((resolve) => {
        releaseBinding = resolve;
      });
      const startEntered = new Promise<void>((resolve) => {
        markStartEntered = resolve;
      });
      const failureHandled = new Promise<void>((resolve) => {
        markFailureHandled = resolve;
      });
      const executor: AgentSessionExecutor = {
        start: async ({ bindExecution }) => {
          markStartEntered();
          await bindingGate;
          const binding = {
            engine: 'delegation' as const,
            conversationId: 'conversation:pending-stop-race',
            executionId: 'execution:pending-stop-race',
            startedAt: 200,
          };
          const bound = await bindExecution(binding);
          if (bound.status !== 'applied') {
            throw new Error(bound.validation?.[0]?.message ?? 'Binding failed.');
          }
          return binding;
        },
      };
      const runtime = createAgentIssueToolRuntime({
        store,
        actor,
        executor,
        origin: () => rootOrigin,
        now: () => 200,
      });
      await runtime.create({
        issueType: 'issue',
        fields: { title: 'Pending stop binding race' },
        request: { mode: 'request' },
        reason: 'Create pending stop race work.',
      });
      const issue = (await runtime.search({ targets: ['issue'] })).rows[0];

      const originalFailSessionStart = store.failSessionStart.bind(store);
      store.failSessionStart = async (...args) => {
        const result = await originalFailSessionStart(...args);
        markFailureHandled();
        return result;
      };
      const originalReserveSessionStop = store.reserveSessionStop.bind(store);
      store.reserveSessionStop = async (...args) => {
        const reservation = await originalReserveSessionStop(...args);
        releaseBinding();
        await failureHandled;
        return reservation;
      };

      const start = runtime.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start while a stop races the first binding.',
      });
      await startEntered;
      const sessionId = Object.keys((await store.state()).sessions)[0]!;
      const stop = runtime.stopSession({
        agentSessionId: sessionId,
        request: { mode: 'request' },
        reason: 'Cancel before the first execution binding commits.',
      });

      expect((await start).status).toBe('applied');
      expect((await stop).status).toBe('applied');
      const read = await store.readSession({ agentSessionId: sessionId });
      expect(read?.agentSession.state).toBe('canceled');
      expect(read?.agentSession.errorMessage).toBeUndefined();
      const state = await store.state();
      expect(state.sessionStopIntents[sessionId]).toBeUndefined();
      expect(Object.values(state.terminalDeliveries).some((delivery) => delivery.state === 'error')).toBe(false);
    });
  });

  test('keeps a stop reservation when executor state reconciliation is unavailable', async () => {
    await withStore(async (store) => {
      const executor: AgentSessionExecutor = {
        start: () => ({
          engine: 'delegation',
          conversationId: 'conversation:unknown-stop',
          executionId: 'execution:unknown-stop',
          startedAt: 200,
        }),
        stop: () => {
          throw new Error('Executor stop outcome is unknown.');
        },
        read: () => 'unavailable',
      };
      const runtime = createAgentIssueToolRuntime({
        store,
        actor,
        executor,
        origin: () => rootOrigin,
        now: () => 200,
      });
      await runtime.create({
        issueType: 'issue',
        fields: { title: 'Unknown stop fixture' },
        request: { mode: 'request' },
        reason: 'Create unknown stop work.',
      });
      const issue = (await runtime.search({ targets: ['issue'] })).rows[0];
      const started = await runtime.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start unknown stop work.',
      });
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;

      const stopped = await runtime.stopSession({
        agentSessionId: sessionId,
        request: { mode: 'request' },
        reason: 'Preserve an unknown stop outcome.',
      });

      expect(stopped.status).toBe('blocked');
      expect((await store.state()).sessionStopIntents[sessionId]).toBeDefined();
      expect((await runtime.sendSessionMessage({
        agentSessionId: sessionId,
        message: 'Do not race an unresolved stop.',
        request: { mode: 'request' },
        reason: 'Verify the stop guard.',
      })).validation?.map((entry) => entry.code)).toContain('stop_in_progress');

      await store.markInterruptedSessionsStale({ type: 'system' }, 300);
      expect((await store.readSession({ agentSessionId: sessionId }))?.agentSession.state).toBe('stale');
      expect((await store.state()).sessionStopIntents[sessionId]).toBeUndefined();
    });
  });

  test.each([
    ['completed', 'complete'],
    ['failed', 'error'],
    ['cancelled', 'canceled'],
  ] satisfies Array<[
    'completed' | 'failed' | 'cancelled',
    'complete' | 'error' | 'canceled',
  ]>)('releases a stop reservation after late %s reconciliation', async (executionState, sessionState) => {
    await withStore(async (store) => {
      const conversationId = `conversation:late-${executionState}-stop-race`;
      const executionId = `execution:late-${executionState}-stop-race`;
      const executor: AgentSessionExecutor = {
        start: () => ({
          engine: 'delegation',
          conversationId,
          executionId,
          startedAt: 200,
        }),
        stop: () => {
          throw new Error('Executor stop outcome is unknown.');
        },
        read: () => 'unavailable',
      };
      const runtime = createAgentIssueToolRuntime({
        store,
        actor,
        executor,
        origin: () => rootOrigin,
        now: () => 200,
      });
      await runtime.create({
        issueType: 'issue',
        fields: { title: `Late ${executionState} stop race fixture` },
        request: { mode: 'request' },
        reason: 'Create terminal stop race work.',
      });
      const issue = (await runtime.search({ targets: ['issue'] })).rows[0];
      const started = await runtime.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start terminal stop race work.',
      });
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;

      const stopped = await runtime.stopSession({
        agentSessionId: sessionId,
        request: { mode: 'request' },
        reason: 'Preserve the unresolved stop until authoritative reconciliation.',
      });

      expect(stopped.status).toBe('blocked');
      expect((await store.state()).sessionStopIntents[sessionId]).toBeDefined();
      expect((await store.conversationRoutingReferences(conversationId)).agentSessionIds).toContain(sessionId);

      await store.syncSessionExecution({
        engine: 'delegation',
        executionId,
        state: executionState,
        completedAt: 250,
        ...(executionState === 'completed' ? { latestOutput: 'Execution already completed.' } : {}),
        ...(executionState === 'failed' ? { errorMessage: 'Execution already failed.' } : {}),
      }, actor, 250);

      expect((await store.readSession({ agentSessionId: sessionId }))?.agentSession.state).toBe(sessionState);
      expect((await store.state()).sessionStopIntents[sessionId]).toBeUndefined();
      expect((await store.conversationRoutingReferences(conversationId)).agentSessionIds).not.toContain(sessionId);
    });
  });

  test('does not cancel a Session when a successful stop call observes natural completion', async () => {
    await withStore(async (store) => {
      const executor: AgentSessionExecutor = {
        start: () => ({
          engine: 'delegation',
          conversationId: 'conversation:completed-stop-race',
          executionId: 'execution:completed-stop-race',
          startedAt: 200,
        }),
        stop: async (binding) => {
          await store.syncSessionExecution({
            engine: binding.engine,
            executionId: binding.executionId,
            state: 'completed',
            latestOutput: 'Completed before cancellation.',
            completedAt: 210,
          }, actor, 210);
          return 'not-canceled';
        },
      };
      const runtime = createAgentIssueToolRuntime({
        store,
        actor,
        executor,
        origin: () => rootOrigin,
        now: () => 200,
      });
      await runtime.create({
        issueType: 'issue',
        fields: { title: 'Completed stop race fixture' },
        request: { mode: 'request' },
        reason: 'Create completed stop race work.',
      });
      const issue = (await runtime.search({ targets: ['issue'] })).rows[0];
      const started = await runtime.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start completed stop race work.',
      });
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;

      const stopped = await runtime.stopSession({
        agentSessionId: sessionId,
        request: { mode: 'request' },
        reason: 'Race natural completion.',
      });

      expect(stopped.status).toBe('blocked');
      expect(stopped.validation?.map((entry) => entry.code)).toContain('executor_stop_not_canceled');
      expect((await store.readSession({ agentSessionId: sessionId }))?.agentSession.state).toBe('complete');
      expect((await store.state()).sessionStopIntents[sessionId]).toBeUndefined();
    });
  });

  test('holds a durable stop reservation while the executor is stopping', async () => {
    await withStore(async (store) => {
      let sessionId = '';
      let racyChildStatus: string | undefined;
      const executor: AgentSessionExecutor = {
        start: ({ session }) => {
          sessionId = session.id;
          return {
            engine: 'delegation',
            conversationId: 'conversation:stop-reservation',
            executionId: 'execution:stop-reservation',
            startedAt: 200,
          };
        },
        stop: async () => {
          const child = await store.create({
            issueType: 'issue',
            fields: { title: 'Racy child during stop' },
            request: { mode: 'request' },
            reason: 'Attempt child creation during stop.',
          }, actor, 205, { origin: { type: 'agent-session', agentSessionId: sessionId } });
          racyChildStatus = child.status;
          return 'canceled';
        },
      };
      const runtime = createAgentIssueToolRuntime({
        store,
        actor,
        executor,
        origin: () => rootOrigin,
        now: () => 200,
      });
      await runtime.create({
        issueType: 'issue',
        fields: { title: 'Stop reservation fixture' },
        request: { mode: 'request' },
        reason: 'Create stoppable work.',
      });
      const issue = (await runtime.search({ targets: ['issue'] })).rows[0];
      await runtime.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start stoppable work.',
      });

      const stopped = await runtime.stopSession({
        agentSessionId: sessionId,
        request: { mode: 'request' },
        reason: 'Stop safely.',
      });

      expect(racyChildStatus).toBe('blocked');
      expect(stopped.status).toBe('applied');
      expect((await store.readSession({ agentSessionId: sessionId }))?.agentSession.state).toBe('canceled');
      expect((await store.state()).sessionStopIntents[sessionId]).toBeUndefined();
    });
  });

  test('commits a stop when executor cancellation succeeded before the executor surfaced an error', async () => {
    await withStore(async (store) => {
      const executor: AgentSessionExecutor = {
        start: () => ({
          engine: 'delegation',
          conversationId: 'conversation:late-stop-error',
          executionId: 'execution:late-stop-error',
          startedAt: 200,
        }),
        stop: async (binding) => {
          await store.syncSessionExecution({
            engine: binding.engine,
            executionId: binding.executionId,
            state: 'cancelled',
            completedAt: 205,
          }, actor, 205);
          throw new Error('Persistence callback failed after the execution stopped.');
        },
      };
      const runtime = createAgentIssueToolRuntime({
        store,
        actor,
        executor,
        origin: () => rootOrigin,
        now: () => 200,
      });
      await runtime.create({
        issueType: 'issue',
        fields: { title: 'Late stop error fixture' },
        request: { mode: 'request' },
        reason: 'Create stoppable work.',
      });
      const issue = (await runtime.search({ targets: ['issue'] })).rows[0];
      const started = await runtime.startSession({
        issueId: issue.target.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: 'Start stoppable work.',
      });
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;

      const stopped = await runtime.stopSession({
        agentSessionId: sessionId,
        request: { mode: 'request' },
        reason: 'Stop despite late callback error.',
      });

      expect(stopped.status).toBe('applied');
      expect((await store.readSession({ agentSessionId: sessionId }))?.agentSession.state).toBe('canceled');
      expect((await store.state()).sessionStopIntents[sessionId]).toBeUndefined();
    });
  });

  test('does not stop the executor for previews or blocked parent Sessions', async () => {
    await withStore(async (store) => {
      let stopCalls = 0;
      const executor: AgentSessionExecutor = {
        start: () => ({
          engine: 'delegation',
          conversationId: 'conversation:stop-guard',
          executionId: 'execution:stop-guard',
          startedAt: 200,
        }),
        stop: () => {
          stopCalls += 1;
          return 'canceled';
        },
      };
      const runtime = createAgentIssueToolRuntime({ store, actor, executor, origin: () => rootOrigin, now: () => 200 });
      await runtime.create({
        issueType: 'issue',
        fields: { title: 'Parent stop guard' },
        request: { mode: 'request' },
        reason: 'Create parent work.',
      });
      const parent = (await runtime.search({ targets: ['issue'] })).rows[0];
      const started = await runtime.startSession({
        issueId: parent.target.id,
        expectedIssueRevision: parent.revision,
        request: { mode: 'request' },
        reason: 'Start parent execution.',
      });
      const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
      await store.create({
        issueType: 'issue',
        fields: { title: 'Unresolved child' },
        request: { mode: 'request' },
        reason: 'Create child work.',
      }, actor, 210, {
        origin: { type: 'agent-session', agentSessionId: sessionId },
      });

      const preview = await runtime.stopSession({
        agentSessionId: sessionId,
        request: { mode: 'preview' },
        reason: 'Preview a stop.',
      });
      expect(preview.status).toBe('blocked');
      expect(preview.validation?.map((entry) => entry.code)).toContain('incomplete_child_issues');
      expect(stopCalls).toBe(0);

      const blocked = await runtime.stopSession({
        agentSessionId: sessionId,
        request: { mode: 'request' },
        reason: 'Do not orphan child work.',
      });
      expect(blocked.status).toBe('blocked');
      expect(blocked.validation?.map((entry) => entry.code)).toContain('incomplete_child_issues');
      expect(stopCalls).toBe(0);
      expect((await store.readSession({ agentSessionId: sessionId }))?.agentSession.state).toBe('active');
    });
  });
});
