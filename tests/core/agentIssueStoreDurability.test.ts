import { describe, expect, test } from 'bun:test';
import { access, appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ActorRef,
  AgentIssue,
  AgentSessionSource,
  IssueUpdateChange,
  TenonAgentToolResult,
} from '../../src/core/agentIssue';
import { AGENT_ISSUE_OPERATION_LOG_FILE, AgentIssueStore } from '../../src/main/agentIssueStore';
import {
  parseAgentIssueOperationBatchesJsonl,
  replayAgentIssueOperationBatches,
} from '../../src/main/agentIssueOperationLog';

const actor: ActorRef = { type: 'agent', agentId: 'built-in:tenon:assistant' };
const source: AgentSessionSource = { type: 'runtime-action', actor };

async function withStore<T>(fn: (store: AgentIssueStore) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'lin-agent-issue-store-durability-'));
  try {
    return await fn(AgentIssueStore.forAgentDataRoot(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createIssue(store: AgentIssueStore, title: string, now = 10): Promise<AgentIssue> {
  const created = await store.create({
    issueType: 'issue',
    fields: { title },
    request: { mode: 'request' },
    reason: `Create ${title}.`,
  }, actor, now);
  const issueId = created.targets.find((target) => target.type === 'issue')?.id;
  if (!issueId) throw new Error(`Issue ${title} was not created.`);
  const issue = (await store.read({ target: { type: 'issue', id: issueId } })).issue;
  if (!issue) throw new Error(`Issue ${title} could not be read.`);
  return issue;
}

function sessionIdFrom(result: TenonAgentToolResult): string {
  const sessionId = result.targets.find((target) => target.type === 'agent-session')?.id;
  if (!sessionId) throw new Error('Agent Session was not created.');
  return sessionId;
}

async function startIssueSession(store: AgentIssueStore, issue: AgentIssue, now = 20): Promise<string> {
  const started = await store.startSession({
    issueId: issue.id,
    expectedIssueRevision: issue.revision,
    request: { mode: 'request' },
    reason: `Start ${issue.title}.`,
  }, source, actor, now);
  expect(started.status).toBe('applied');
  return sessionIdFrom(started);
}

async function readOperationBatches(root: string) {
  return parseAgentIssueOperationBatchesJsonl(
    await readFile(path.join(root, AGENT_ISSUE_OPERATION_LOG_FILE), 'utf8'),
    AGENT_ISSUE_OPERATION_LOG_FILE,
  );
}

async function createParentWithChild(
  store: AgentIssueStore,
  suffix: string,
  options: { settleParent?: boolean } = {},
): Promise<{
  child: AgentIssue;
  parent: AgentIssue;
  parentSessionId: string;
  parentExecutionId: string;
}> {
  const parent = await createIssue(store, `Parent ${suffix}`, 10);
  const parentSessionId = await startIssueSession(store, parent, 20);
  const parentExecutionId = `execution:parent-${suffix}`;
  await store.bindSessionExecution(parentSessionId, {
    engine: 'delegation',
    conversationId: `conversation:parent-${suffix}`,
    executionId: parentExecutionId,
    startedAt: 25,
  }, actor, 25);
  const createdChild = await store.create({
    issueType: 'issue',
    fields: { title: `Child ${suffix}` },
    request: { mode: 'request' },
    reason: 'Create delegated child work.',
  }, actor, 30, {
    origin: { type: 'agent-session', agentSessionId: parentSessionId },
  });
  const childId = createdChild.targets.find((target) => target.type === 'issue')?.id;
  if (!childId) throw new Error('Child Issue was not created.');
  const child = (await store.read({ target: { type: 'issue', id: childId } })).issue;
  if (!child) throw new Error('Child Issue could not be read.');
  expect(child.parentIssueId).toBe(parent.id);

  if (options.settleParent !== false) {
    await store.markInterruptedSessionsStale(actor, 40);
    expect((await store.readSession({ agentSessionId: parentSessionId }))?.agentSession.state).toBe('stale');
  }
  const currentParent = (await store.read({ target: { type: 'issue', id: parent.id } })).issue;
  if (!currentParent) throw new Error('Parent Issue could not be read.');
  return { child, parent: currentParent, parentSessionId, parentExecutionId };
}

describe('agent issue store durability guards', () => {
  test('rebuilds the complete projection from atomic workflow operation batches', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-agent-issue-operation-replay-'));
    try {
      const store = AgentIssueStore.forAgentDataRoot(root);
      const created = await store.create({
        issueType: 'issue',
        fields: { title: 'Replay workflow' },
        request: { mode: 'request' },
        reason: 'Create replay workflow.',
      }, actor, 10, { origin: { type: 'conversation', conversationId: 'conversation:origin' } });
      const issueId = created.targets.find((target) => target.type === 'issue')?.id;
      if (!issueId) throw new Error('Replay workflow Issue was not created.');
      const issue = (await store.read({ target: { type: 'issue', id: issueId } })).issue;
      if (!issue) throw new Error('Replay workflow Issue could not be read.');
      const sessionId = await startIssueSession(store, issue, 20);
      await store.bindSessionExecution(sessionId, {
        engine: 'delegation',
        conversationId: 'conversation:replay-workflow',
        executionId: 'execution:replay-workflow',
        startedAt: 30,
      }, actor, 30);
      await store.failSessionStart(sessionId, 'Provider unavailable.', actor, 40);

      const batches = await readOperationBatches(root);
      expect(batches.map((batch) => batch.seq)).toEqual([1, 2, 3, 4]);
      expect(batches[0]?.operations.map((operation) => operation.type)).toEqual([
        'issue.upserted',
        'activity.appended',
      ]);
      expect(batches[1]?.operations.map((operation) => operation.type)).toEqual([
        'agent-session.upserted',
        'activity.appended',
        'activity.appended',
      ]);
      expect(batches[2]?.operations.map((operation) => operation.type)).toEqual([
        'issue.upserted',
        'agent-session.upserted',
        'session-execution.upserted',
        'activity.appended',
        'activity.appended',
      ]);
      expect(batches[3]?.operations.map((operation) => operation.type)).toEqual([
        'agent-session.upserted',
        'terminal-delivery.upserted',
        'activity.appended',
      ]);

      const current = await store.state();
      expect(replayAgentIssueOperationBatches(batches).state).toEqual(current);
      expect(await new AgentIssueStore(store.coordinationKey()).state()).toEqual(current);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('records schedule materialization as one Issue, recurrence, and Activity batch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-agent-issue-schedule-log-'));
    try {
      const store = AgentIssueStore.forAgentDataRoot(root);
      const createdAt = Date.parse('2026-07-07T09:00:00Z');
      await store.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Logged schedule',
          cadence: { type: 'daily', time: '18:00' },
          timeZone: 'Asia/Shanghai',
          issueTemplate: { permissionMode: 'unattended' },
        },
        request: { mode: 'request' },
        reason: 'Create logged schedule.',
      }, actor, createdAt);

      const materialized = await store.materializeDueRecurringIssues(
        Date.parse('2026-07-07T10:05:00Z'),
        actor,
      );
      expect(materialized).toHaveLength(1);
      const batches = await readOperationBatches(root);
      expect(batches).toHaveLength(2);
      expect(batches[1]?.operations.map((operation) => operation.type)).toEqual([
        'issue.upserted',
        'recurring-issue.upserted',
        'activity.appended',
        'activity.appended',
      ]);
      expect(batches[1]?.operations).toContainEqual(expect.objectContaining({
        type: 'activity.appended',
        activity: expect.objectContaining({
          content: expect.objectContaining({ type: 'agent-action', action: 'materialize' }),
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('persists and clears Session stop intents through explicit operations', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-agent-issue-stop-intent-log-'));
    try {
      const store = AgentIssueStore.forAgentDataRoot(root);
      const issue = await createIssue(store, 'Stop intent replay', 10);
      const sessionId = await startIssueSession(store, issue, 20);
      const reservation = await store.reserveSessionStop({
        agentSessionId: sessionId,
        request: { mode: 'request' },
        reason: 'Reserve stop.',
      }, 30);
      expect(reservation.token).toBeDefined();
      expect((await readOperationBatches(root)).at(-1)?.operations).toEqual([
        expect.objectContaining({
          type: 'session-stop-intent.upserted',
          agentSessionId: sessionId,
          intent: { token: reservation.token, createdAt: 30 },
        }),
      ]);

      const restarted = new AgentIssueStore(store.coordinationKey());
      expect((await restarted.state()).sessionStopIntents[sessionId]?.token).toBe(reservation.token);
      await restarted.releaseSessionStop(sessionId, reservation.token!);
      expect((await readOperationBatches(root)).at(-1)?.operations).toEqual([
        { type: 'session-stop-intent.cleared', agentSessionId: sessionId },
      ]);
      expect((await new AgentIssueStore(store.coordinationKey()).state()).sessionStopIntents).toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps tombstoned entities deleted when stale and duplicate operations arrive later', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-agent-issue-tombstone-log-'));
    try {
      const store = AgentIssueStore.forAgentDataRoot(root);
      const issue = await createIssue(store, 'Delete permanently', 10);
      const deleted = await store.update({
        target: { type: 'issue', id: issue.id, expectedRevision: issue.revision },
        change: { type: 'delete' },
        request: { mode: 'request' },
        reason: 'Delete the Issue.',
      }, actor, 20);
      expect(deleted.status).toBe('applied');

      const initialBatches = await readOperationBatches(root);
      const creationBatch = initialBatches[0]!;
      const deletionBatch = initialBatches[1]!;
      expect(deletionBatch.operations).toContainEqual(expect.objectContaining({
        type: 'issue.deleted',
        tombstone: expect.objectContaining({
          entity: { type: 'issue', issueId: issue.id },
          actor,
          deletedAt: 20,
          lastKnownRevision: issue.revision,
        }),
      }));

      const staleBatch = {
        ...structuredClone(creationBatch),
        seq: deletionBatch.seq + 1,
        operationId: 'stale-replica-operation',
      };
      const duplicateBatch = {
        ...structuredClone(creationBatch),
        seq: deletionBatch.seq + 2,
      };
      const logPath = path.join(root, AGENT_ISSUE_OPERATION_LOG_FILE);
      await appendFile(logPath, `${JSON.stringify(staleBatch)}\n${JSON.stringify(duplicateBatch)}\n`, 'utf8');
      await writeFile(path.join(root, 'issue-manager.json'), JSON.stringify({
        v: 5,
        issues: { [issue.id]: issue },
      }), 'utf8');

      expect((await store.search({ targets: ['issue'] })).rows).toEqual([]);
      const restarted = new AgentIssueStore(store.coordinationKey());
      expect((await restarted.search({ targets: ['issue'] })).rows).toEqual([]);
      expect(replayAgentIssueOperationBatches(await readOperationBatches(root)).state.issues[issue.id]).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('gives Recurring Issue tombstones precedence over stale definition operations', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-agent-recurring-issue-tombstone-log-'));
    try {
      const store = AgentIssueStore.forAgentDataRoot(root);
      await store.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Delete recurring definition',
          cadence: { type: 'daily', time: '09:00' },
          timeZone: 'UTC',
          issueTemplate: { permissionMode: 'unattended' },
        },
        request: { mode: 'request' },
        reason: 'Create recurring definition.',
      }, actor, 10);
      const recurring = (await store.search({ targets: ['recurring-issue'] })).rows[0]!;
      await store.update({
        target: {
          type: 'recurring-issue',
          id: recurring.target.id,
          expectedRevision: recurring.revision,
        },
        change: { type: 'delete' },
        request: { mode: 'request' },
        reason: 'Delete recurring definition.',
      }, actor, 20);

      const batches = await readOperationBatches(root);
      expect(batches[1]?.operations).toContainEqual(expect.objectContaining({
        type: 'recurring-issue.deleted',
        tombstone: expect.objectContaining({
          entity: { type: 'recurring-issue', recurringIssueId: recurring.target.id },
          deletedAt: 20,
          lastKnownRevision: recurring.revision,
        }),
      }));
      const staleBatch = {
        ...structuredClone(batches[0]!),
        seq: 3,
        operationId: 'stale-recurring-issue-operation',
      };
      await appendFile(
        path.join(root, AGENT_ISSUE_OPERATION_LOG_FILE),
        `${JSON.stringify(staleBatch)}\n`,
        'utf8',
      );

      expect((await new AgentIssueStore(store.coordinationKey()).search({
        targets: ['recurring-issue'],
      })).rows).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects stale materialization derived from a tombstoned Recurring Issue', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-agent-recurring-materialization-primary-'));
    const staleRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-recurring-materialization-stale-'));
    try {
      const store = AgentIssueStore.forAgentDataRoot(root);
      const createdAt = Date.parse('2026-07-07T09:00:00Z');
      const materializedAt = Date.parse('2026-07-07T10:05:00Z');
      await store.create({
        issueType: 'recurring-issue',
        fields: {
          titleTemplate: 'Deleted offline schedule',
          cadence: { type: 'daily', time: '18:00' },
          timeZone: 'Asia/Shanghai',
          issueTemplate: { permissionMode: 'unattended' },
        },
        request: { mode: 'request' },
        reason: 'Create a schedule before the replica goes offline.',
      }, actor, createdAt);
      await writeFile(
        path.join(staleRoot, AGENT_ISSUE_OPERATION_LOG_FILE),
        await readFile(path.join(root, AGENT_ISSUE_OPERATION_LOG_FILE)),
      );

      const recurring = (await store.search({ targets: ['recurring-issue'] })).rows[0]!;
      await store.update({
        target: {
          type: 'recurring-issue',
          id: recurring.target.id,
          expectedRevision: recurring.revision,
        },
        change: { type: 'delete' },
        request: { mode: 'request' },
        reason: 'Delete the schedule while the other replica is offline.',
      }, actor, materializedAt - 1);

      const staleStore = AgentIssueStore.forAgentDataRoot(staleRoot);
      expect(await staleStore.materializeDueRecurringIssues(materializedAt, actor)).toHaveLength(1);
      const staleMaterialization = (await readOperationBatches(staleRoot))[1]!;
      const deletion = (await readOperationBatches(root))[1]!;
      await appendFile(
        path.join(root, AGENT_ISSUE_OPERATION_LOG_FILE),
        `${JSON.stringify({ ...staleMaterialization, seq: deletion.seq + 1 })}\n`,
        'utf8',
      );

      const restarted = AgentIssueStore.forAgentDataRoot(root);
      expect((await restarted.search({ targets: ['recurring-issue'] })).rows).toEqual([]);
      expect((await restarted.search({ targets: ['issue'] })).rows).toEqual([]);
      expect(await restarted.listReadyIssuesForExecution(materializedAt)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(staleRoot, { recursive: true, force: true });
    }
  });

  test('rejects stale child creation derived from a tombstoned parent Issue', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-primary-'));
    const staleRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-child-stale-'));
    try {
      const store = AgentIssueStore.forAgentDataRoot(root);
      const parent = await createIssue(store, 'Deleted parent', 10);
      const parentSessionId = await startIssueSession(store, parent, 20);
      await store.bindSessionExecution(parentSessionId, {
        engine: 'delegation',
        conversationId: 'conversation:deleted-parent',
        executionId: 'execution:deleted-parent',
        startedAt: 25,
      }, actor, 25);
      await writeFile(
        path.join(staleRoot, AGENT_ISSUE_OPERATION_LOG_FILE),
        await readFile(path.join(root, AGENT_ISSUE_OPERATION_LOG_FILE)),
      );

      await store.markInterruptedSessionsStale(actor, 30);
      const currentParent = (await store.read({ target: { type: 'issue', id: parent.id } })).issue!;
      expect((await store.update({
        target: { type: 'issue', id: parent.id, expectedRevision: currentParent.revision },
        change: { type: 'delete' },
        request: { mode: 'request' },
        reason: 'Delete the parent while the other replica is offline.',
      }, actor, 40)).status).toBe('applied');

      const staleStore = AgentIssueStore.forAgentDataRoot(staleRoot);
      const childCreation = await staleStore.create({
        issueType: 'issue',
        fields: { title: 'Late child' },
        request: { mode: 'request' },
        reason: 'Create a child from stale parent state.',
      }, actor, 35, {
        origin: { type: 'agent-session', agentSessionId: parentSessionId },
      });
      expect(childCreation.status).toBe('applied');
      const staleChildBatch = (await readOperationBatches(staleRoot)).at(-1)!;
      const primaryTail = (await readOperationBatches(root)).at(-1)!;
      await appendFile(
        path.join(root, AGENT_ISSUE_OPERATION_LOG_FILE),
        `${JSON.stringify({ ...staleChildBatch, seq: primaryTail.seq + 1 })}\n`,
        'utf8',
      );

      const restarted = AgentIssueStore.forAgentDataRoot(root);
      expect((await restarted.search({ targets: ['issue'] })).rows).toEqual([]);
      expect(await restarted.listReadyIssuesForExecution(50)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(staleRoot, { recursive: true, force: true });
    }
  });

  test('rejects conflicting operation identities and malformed middle records', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-agent-issue-corrupt-log-'));
    try {
      const store = AgentIssueStore.forAgentDataRoot(root);
      await createIssue(store, 'Corruption guard', 10);
      const first = (await readOperationBatches(root))[0]!;
      const conflicting = {
        ...structuredClone(first),
        seq: 2,
        committedAt: 11,
      };
      expect(() => replayAgentIssueOperationBatches([first, conflicting]))
        .toThrow('Conflicting Agent Issue operation id');

      const later = {
        ...structuredClone(first),
        seq: 3,
        operationId: 'later-operation',
      };
      expect(() => parseAgentIssueOperationBatchesJsonl(
        `${JSON.stringify(first)}\nnot-json\n${JSON.stringify(later)}\n`,
        'corrupt-middle.jsonl',
      )).toThrow('Invalid Agent Issue operation JSON at corrupt-middle.jsonl:2');

      expect(() => parseAgentIssueOperationBatchesJsonl(`${JSON.stringify({
        v: 1,
        seq: 1,
        operationId: 'malformed-entity',
        actor: { type: 'system' },
        committedAt: 1,
        operations: [{ type: 'issue.upserted', issue: { id: 'issue:malformed' } }],
      })}\n`, 'malformed-entity.jsonl'))
        .toThrow('Invalid Agent Issue operation at malformed-entity.jsonl:1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects a newline-terminated malformed tail before another mutation can append', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-agent-issue-complete-corrupt-tail-'));
    try {
      const store = AgentIssueStore.forAgentDataRoot(root);
      const issue = await createIssue(store, 'Before complete corrupt tail', 10);
      const logPath = path.join(root, AGENT_ISSUE_OPERATION_LOG_FILE);
      await appendFile(logPath, 'not-json\n', 'utf8');
      const corrupted = await readFile(logPath, 'utf8');

      await expect(store.state()).rejects.toThrow('Invalid Agent Issue operation JSON');
      await expect(store.update({
        target: { type: 'issue', id: issue.id, expectedRevision: issue.revision },
        change: { type: 'patch', patch: { title: 'Must not append' } },
        request: { mode: 'request' },
        reason: 'Do not write past a complete corrupt record.',
      }, actor, 20)).rejects.toThrow('Invalid Agent Issue operation JSON');
      expect(await readFile(logPath, 'utf8')).toBe(corrupted);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('drops and repairs a torn final operation before the next append', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-agent-issue-torn-log-'));
    try {
      const store = AgentIssueStore.forAgentDataRoot(root);
      const issue = await createIssue(store, 'Before torn append', 10);
      const logPath = path.join(root, AGENT_ISSUE_OPERATION_LOG_FILE);
      await appendFile(logPath, '{"v":1,"seq":2,"operationId":"torn', 'utf8');

      expect((await store.read({ target: { type: 'issue', id: issue.id } })).issue?.title).toBe('Before torn append');
      const updated = await store.update({
        target: { type: 'issue', id: issue.id, expectedRevision: issue.revision },
        change: { type: 'patch', patch: { title: 'After torn append' } },
        request: { mode: 'request' },
        reason: 'Repair and update.',
      }, actor, 20);
      expect(updated.status).toBe('applied');

      const raw = await readFile(logPath, 'utf8');
      expect(raw.endsWith('\n')).toBe(true);
      expect(raw).not.toContain('"operationId":"torn');
      expect((await new AgentIssueStore(store.coordinationKey()).read({
        target: { type: 'issue', id: issue.id },
      })).issue?.title).toBe('After torn append');
      expect((await readOperationBatches(root)).map((batch) => batch.seq)).toEqual([1, 2]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('checks expected revisions inside the serialized update transaction', async () => {
    await withStore(async (store) => {
      const issue = await createIssue(store, 'Concurrent update');
      const update = (title: string) => store.update({
        target: { type: 'issue', id: issue.id, expectedRevision: issue.revision },
        change: { type: 'patch', patch: { title } },
        request: { mode: 'request' },
        reason: `Rename to ${title}.`,
      }, actor, 20);

      const results = await Promise.all([update('First winner'), update('Second winner')]);

      expect(results.map((result) => result.status).sort()).toEqual(['applied', 'conflict']);
      expect(results.find((result) => result.status === 'conflict')?.validation?.map((entry) => entry.code))
        .toContain('revision_mismatch');
      expect(['First winner', 'Second winner']).toContain(
        (await store.read({ target: { type: 'issue', id: issue.id } })).issue?.title,
      );
    });
  });

  test('serializes concurrent Agent Session starts so only one request succeeds', async () => {
    await withStore(async (store) => {
      const issue = await createIssue(store, 'Concurrent start');
      const input = {
        issueId: issue.id,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' as const },
        reason: 'Start concurrently.',
      };

      const results = await Promise.all([
        store.startSession(input, source, actor, 20),
        store.startSession(input, source, actor, 20),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual(['applied', 'blocked']);
      expect(results.find((result) => result.status === 'blocked')?.validation?.map((entry) => entry.code))
        .toContain('active_session_exists');
      const detail = await store.read({ target: { type: 'issue', id: issue.id }, include: ['sessions'] });
      expect(detail.sessions).toHaveLength(1);
      expect(detail.sessions?.[0]?.state).toBe('pending');
    });
  });

  test('ignores stale execution snapshots after a Session becomes terminal', async () => {
    await withStore(async (store) => {
      const issue = await createIssue(store, 'Monotonic execution');
      const sessionId = await startIssueSession(store, issue, 20);
      await store.bindSessionExecution(sessionId, {
        engine: 'delegation',
        conversationId: 'conversation:monotonic',
        executionId: 'execution:monotonic',
        startedAt: 100,
      }, actor, 100);
      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:monotonic',
        state: 'completed',
        latestOutput: 'Final result.',
        completedAt: 200,
      }, actor, 200);

      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:monotonic',
        state: 'running',
        latestOutput: 'Stale running snapshot.',
      }, actor, 150);

      expect((await store.readSession({ agentSessionId: sessionId }))?.agentSession).toMatchObject({
        state: 'complete',
        completedAt: 200,
        latestOutput: 'Final result.',
        updatedAt: 200,
      });
      expect(await store.executionForSession(sessionId)).toMatchObject({ updatedAt: 200 });
      expect((await store.read({ target: { type: 'issue', id: issue.id } })).issue?.status.category).toBe('completed');
    });
  });

  test('does not let a conflicting same-timestamp snapshot revive a terminal Session', async () => {
    await withStore(async (store) => {
      const issue = await createIssue(store, 'Same timestamp terminal');
      const sessionId = await startIssueSession(store, issue, 20);
      await store.bindSessionExecution(sessionId, {
        engine: 'delegation',
        conversationId: 'conversation:same-timestamp',
        executionId: 'execution:same-timestamp',
        startedAt: 30,
      }, actor, 30);
      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:same-timestamp',
        state: 'completed',
        latestOutput: 'Final output.',
        completedAt: 100,
      }, actor, 100);

      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:same-timestamp',
        state: 'running',
        latestOutput: 'Conflicting running output.',
      }, actor, 100);

      expect((await store.readSession({ agentSessionId: sessionId }))?.agentSession).toMatchObject({
        state: 'complete',
        latestOutput: 'Final output.',
        completedAt: 100,
      });
    });
  });

  test('does not revive a canceled Session from a late executor completion', async () => {
    await withStore(async (store) => {
      const issue = await createIssue(store, 'Canceled execution');
      const sessionId = await startIssueSession(store, issue, 20);
      await store.bindSessionExecution(sessionId, {
        engine: 'delegation',
        conversationId: 'conversation:canceled',
        executionId: 'execution:canceled',
        startedAt: 30,
      }, actor, 30);
      await store.stopSession({
        agentSessionId: sessionId,
        request: { mode: 'request' },
        reason: 'Cancel execution.',
      }, actor, 100);

      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:canceled',
        state: 'completed',
        latestOutput: 'Late completion that must be ignored.',
        completedAt: 120,
      }, actor, 120);

      expect((await store.readSession({ agentSessionId: sessionId }))?.agentSession).toMatchObject({
        state: 'canceled',
        completedAt: 100,
      });
      expect((await store.read({ target: { type: 'issue', id: issue.id } })).issue?.status.category).toBe('started');
      expect(Object.values((await store.state()).terminalDeliveries)).toHaveLength(0);
    });
  });

  test('does not acknowledge child delivery from a stale parent execution snapshot', async () => {
    await withStore(async (store) => {
      const { child, parent, parentSessionId, parentExecutionId } = await createParentWithChild(
        store,
        'stale acknowledgment',
        { settleParent: false },
      );
      await store.update({
        target: { type: 'issue', id: child.id, expectedRevision: child.revision },
        change: { type: 'transition', status: { name: 'Completed', category: 'completed' } },
        request: { mode: 'request' },
        reason: 'Complete the child.',
      }, actor, 50);
      const delivery = Object.values((await store.state()).terminalDeliveries)[0]!;

      const stale = await store.syncSessionExecution({
        engine: 'delegation',
        executionId: parentExecutionId,
        state: 'completed',
        latestOutput: 'Stale parent result.',
        acknowledgedTerminalDeliveryIds: [delivery.id],
      }, actor, 24);

      expect(stale?.acknowledgedTerminalDeliveryIds).toEqual([]);
      const state = await store.state();
      expect(state.terminalDeliveries[delivery.id]?.status).toBe('pending');
      expect(state.sessions[parentSessionId]?.state).toBe('active');
      expect(state.issues[parent.id]?.status.category).toBe('started');
    });
  });

  test('acknowledges child delivery and completes the parent in one execution sync', async () => {
    await withStore(async (store) => {
      const { child, parent, parentSessionId, parentExecutionId } = await createParentWithChild(
        store,
        'atomic acknowledgment',
        { settleParent: false },
      );
      await store.update({
        target: { type: 'issue', id: child.id, expectedRevision: child.revision },
        change: { type: 'transition', status: { name: 'Completed', category: 'completed' } },
        request: { mode: 'request' },
        reason: 'Complete the child.',
      }, actor, 50);
      const delivery = Object.values((await store.state()).terminalDeliveries)[0]!;
      const [claimed] = await store.claimTerminalDeliveries('owner:atomic-ack', 10, 55);
      expect(claimed?.id).toBe(delivery.id);

      const synced = await store.syncSessionExecution({
        engine: 'delegation',
        executionId: parentExecutionId,
        state: 'completed',
        latestOutput: 'Integrated child result.',
        completedAt: 60,
        acknowledgedTerminalDeliveryIds: [delivery.id],
      }, actor, 60);

      expect(synced).toMatchObject({
        issueBecameCompleted: true,
        acknowledgedTerminalDeliveryIds: [delivery.id],
      });
      const state = await store.state();
      expect(state.terminalDeliveries[delivery.id]?.status).toBe('delivered');
      expect(state.sessions[parentSessionId]?.state).toBe('complete');
      expect(state.issues[parent.id]?.status.category).toBe('completed');
      expect(await store.completeTerminalDelivery(delivery.id, 'owner:atomic-ack', 70)).toBe(false);
    });
  });

  test('routes an execution-definition fence to the direct parent without completing the child Issue', async () => {
    await withStore(async (store) => {
      const parent = await createIssue(store, 'Definition-fence parent', 10);
      const parentSessionId = await startIssueSession(store, parent, 20);
      await store.bindSessionExecution(parentSessionId, {
        engine: 'delegation',
        conversationId: 'conversation:definition-fence-parent',
        executionId: 'execution:definition-fence-parent',
        startedAt: 30,
      }, actor, 30);
      const childCreated = await store.create({
        issueType: 'issue',
        fields: { title: 'Definition-fence child', description: 'Original definition.' },
        request: { mode: 'request' },
        reason: 'Create child work.',
      }, actor, 40, { origin: { type: 'agent-session', agentSessionId: parentSessionId } });
      const childId = childCreated.targets.find((target) => target.type === 'issue')!.id;
      const child = (await store.read({ target: { type: 'issue', id: childId } })).issue!;
      const childSessionId = await startIssueSession(store, child, 50);
      await store.bindSessionExecution(childSessionId, {
        engine: 'delegation',
        conversationId: 'conversation:definition-fence-child',
        executionId: 'execution:definition-fence-child',
        startedAt: 60,
      }, actor, 60);
      const currentChild = (await store.read({ target: { type: 'issue', id: childId } })).issue!;
      await store.update({
        target: { type: 'issue', id: childId, expectedRevision: currentChild.revision },
        change: { type: 'patch', patch: { description: 'Revised definition.' } },
        request: { mode: 'request' },
        reason: 'Revise the child while its Session is running.',
      }, actor, 70);

      const synced = await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:definition-fence-child',
        state: 'completed',
        latestOutput: 'Output for the old definition.',
        completedAt: 80,
      }, actor, 80);
      expect(synced?.issueBecameCompleted).toBe(false);
      const state = await store.state();
      expect(state.issues[childId]?.status.category).not.toBe('completed');
      expect(state.sessions[childSessionId]).toMatchObject({
        state: 'complete',
        errorMessage: expect.stringContaining('Issue completion blocked'),
      });
      expect(Object.values(state.terminalDeliveries)).toContainEqual(expect.objectContaining({
        issueId: childId,
        agentSessionId: childSessionId,
        origin: { type: 'agent-session', agentSessionId: parentSessionId },
        state: 'error',
        status: 'pending',
      }));
    });
  });

  test('carries the terminal child execution identity on a later child cancellation', async () => {
    await withStore(async (store) => {
      const parent = await createIssue(store, 'Cancellation identity parent', 10);
      const parentSessionId = await startIssueSession(store, parent, 20);
      await store.bindSessionExecution(parentSessionId, {
        engine: 'delegation',
        conversationId: 'conversation:cancellation-parent',
        executionId: 'execution:cancellation-parent',
        startedAt: 30,
      }, actor, 30);
      const childCreated = await store.create({
        issueType: 'issue',
        fields: {
          title: 'Cancellation identity child',
          verificationPolicy: { mode: 'human-review' },
        },
        request: { mode: 'request' },
        reason: 'Create review-gated child work.',
      }, actor, 40, { origin: { type: 'agent-session', agentSessionId: parentSessionId } });
      const childId = childCreated.targets.find((target) => target.type === 'issue')!.id;
      const child = (await store.read({ target: { type: 'issue', id: childId } })).issue!;
      const childSessionId = await startIssueSession(store, child, 50);
      await store.bindSessionExecution(childSessionId, {
        engine: 'delegation',
        conversationId: 'conversation:cancellation-child',
        executionId: 'execution:cancellation-child',
        startedAt: 60,
      }, actor, 60);
      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:cancellation-child',
        state: 'completed',
        latestOutput: 'Reviewable child result.',
        completedAt: 70,
      }, actor, 70);
      const currentChild = (await store.read({ target: { type: 'issue', id: childId } })).issue!;
      const canceled = await store.update({
        target: { type: 'issue', id: childId, expectedRevision: currentChild.revision },
        change: { type: 'transition', status: { name: 'Canceled', category: 'canceled' } },
        request: { mode: 'request' },
        reason: 'Cancel instead of accepting human review.',
      }, actor, 80);
      expect(canceled.status).toBe('applied');
      expect(Object.values((await store.state()).terminalDeliveries)).toContainEqual(expect.objectContaining({
        issueId: childId,
        agentSessionId: childSessionId,
        origin: { type: 'agent-session', agentSessionId: parentSessionId },
        state: 'canceled',
      }));
    });
  });

  test('does not start a replacement parent Session while child work is outstanding', async () => {
    await withStore(async (store) => {
      const { parent, parentExecutionId } = await createParentWithChild(
        store,
        'replacement guard',
        { settleParent: false },
      );
      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: parentExecutionId,
        state: 'completed',
        latestOutput: 'Parent stopped before resolving its child.',
        completedAt: 50,
      }, actor, 50);
      const currentParent = (await store.read({ target: { type: 'issue', id: parent.id } })).issue!;

      const replacement = await store.startSession({
        issueId: parent.id,
        expectedIssueRevision: currentParent.revision,
        request: { mode: 'request' },
        reason: 'Attempt replacement execution.',
      }, source, actor, 60);

      expect(replacement.status).toBe('blocked');
      expect(replacement.validation?.map((entry) => entry.code)).toContain('incomplete_child_issues');
    });
  });

  test('blocks parent cancellation while child work is outstanding', async () => {
    await withStore(async (store) => {
      const { parent } = await createParentWithChild(store, 'parent cancel guard');

      const canceled = await store.update({
        target: { type: 'issue', id: parent.id, expectedRevision: parent.revision },
        change: { type: 'transition', status: { name: 'Canceled', category: 'canceled' } },
        request: { mode: 'request' },
        reason: 'Attempt to cancel unresolved parent work.',
      }, actor, 50);

      expect(canceled.status).toBe('blocked');
      expect(canceled.validation?.map((entry) => entry.code)).toContain('incomplete_child_issues');
    });
  });

  test('stop reservation prevents a new child origin until stop commits or releases', async () => {
    await withStore(async (store) => {
      const parent = await createIssue(store, 'Stop reservation parent');
      const parentSessionId = await startIssueSession(store, parent, 20);
      await store.bindSessionExecution(parentSessionId, {
        engine: 'delegation',
        conversationId: 'conversation:stop-reservation',
        executionId: 'execution:stop-reservation',
        startedAt: 25,
      }, actor, 25);
      const input = {
        agentSessionId: parentSessionId,
        request: { mode: 'request' as const },
        reason: 'Reserve stop.',
      };
      const reservation = await store.reserveSessionStop(input, 30);
      expect(reservation.token).toBeTruthy();

      const child = await store.create({
        issueType: 'issue',
        fields: { title: 'Must not attach during stop' },
        request: { mode: 'request' },
        reason: 'Attempt racy child creation.',
      }, actor, 31, { origin: { type: 'agent-session', agentSessionId: parentSessionId } });
      expect(child.status).toBe('blocked');
      expect(child.validation?.map((entry) => entry.code)).toContain('invalid_origin');

      await store.releaseSessionStop(parentSessionId, reservation.token!);
      const retried = await store.create({
        issueType: 'issue',
        fields: { title: 'Allowed after stop release' },
        request: { mode: 'request' },
        reason: 'Create after release.',
      }, actor, 32, { origin: { type: 'agent-session', agentSessionId: parentSessionId } });
      expect(retried.status).toBe('applied');
    });
  });

  test('unexpected executor cancellation leaves a parent resumable while child work exists', async () => {
    await withStore(async (store) => {
      const { parentSessionId, parentExecutionId } = await createParentWithChild(
        store,
        'unexpected cancellation',
        { settleParent: false },
      );

      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: parentExecutionId,
        state: 'cancelled',
        completedAt: 50,
      }, actor, 50);

      expect((await store.readSession({ agentSessionId: parentSessionId }))?.agentSession.state).toBe('stale');
    });
  });

  test('blocks stopping a parent Session while child work or delivery is pending', async () => {
    await withStore(async (store) => {
      const { child, parentSessionId } = await createParentWithChild(store, 'stop guard', {
        settleParent: false,
      });

      const unresolved = await store.stopSession({
        agentSessionId: parentSessionId,
        request: { mode: 'request' },
        reason: 'Do not orphan unresolved child work.',
      }, actor, 40);
      expect(unresolved.status).toBe('blocked');
      expect(unresolved.validation?.map((entry) => entry.code)).toContain('incomplete_child_issues');

      await store.update({
        target: { type: 'issue', id: child.id, expectedRevision: child.revision },
        change: { type: 'transition', status: { name: 'Completed', category: 'completed' } },
        request: { mode: 'request' },
        reason: 'Complete the child and enqueue its result.',
      }, actor, 50);
      const pendingDelivery = await store.stopSession({
        agentSessionId: parentSessionId,
        request: { mode: 'request' },
        reason: 'Do not orphan an undelivered child result.',
      }, actor, 60);
      expect(pendingDelivery.status).toBe('blocked');
      expect(pendingDelivery.validation?.map((entry) => entry.code)).toContain('incomplete_child_issues');
      expect((await store.readSession({ agentSessionId: parentSessionId }))?.agentSession.state).toBe('active');
    });
  });

  for (const [label, change] of [
    ['transition', { type: 'transition', status: { name: 'Completed', category: 'completed' } }],
    ['status patch', { type: 'patch', patch: { status: { name: 'Completed', category: 'completed' } } }],
  ] as const satisfies ReadonlyArray<readonly [string, IssueUpdateChange]>) {
    test(`blocks manual completion by ${label} while a direct child is incomplete`, async () => {
      await withStore(async (store) => {
        const { child, parent } = await createParentWithChild(store, label);

        const completed = await store.update({
          target: { type: 'issue', id: parent.id, expectedRevision: parent.revision },
          change,
          request: { mode: 'request' },
          reason: 'Attempt to complete the parent early.',
        }, actor, 50);

        expect(completed.status).toBe('blocked');
        expect(completed.validation?.map((entry) => entry.code)).toContain(
          label === 'status patch' ? 'status_patch_not_allowed' : 'incomplete_child_issues',
        );
        expect((await store.read({ target: { type: 'issue', id: parent.id } })).issue?.status.category).not.toBe('completed');
        expect((await store.read({ target: { type: 'issue', id: child.id } })).issue?.status.category).toBe('triage');
      });
    });
  }

  for (const state of ['pending', 'active'] as const) {
    test(`blocks manual completion while an Agent Session is ${state}`, async () => {
      await withStore(async (store) => {
        const issue = await createIssue(store, `Manual completion ${state}`);
        const sessionId = await startIssueSession(store, issue, 20);
        if (state === 'active') {
          await store.bindSessionExecution(sessionId, {
            engine: 'delegation',
            conversationId: `conversation:${state}`,
            executionId: `execution:${state}`,
            startedAt: 30,
          }, actor, 30);
        }
        const current = (await store.read({ target: { type: 'issue', id: issue.id } })).issue!;

        const completed = await store.update({
          target: { type: 'issue', id: issue.id, expectedRevision: current.revision },
          change: { type: 'transition', status: { name: 'Completed', category: 'completed' } },
          request: { mode: 'request' },
          reason: 'Attempt to complete running work.',
        }, actor, 40);

        expect(completed.status).toBe('blocked');
        expect(completed.validation?.map((entry) => entry.code)).toContain('active_session_exists');
        expect((await store.read({ target: { type: 'issue', id: issue.id } })).issue?.status.category).not.toBe('completed');
        expect(Object.values((await store.state()).terminalDeliveries)).toHaveLength(0);
      });
    });
  }

  test('blocks canceling an Issue while its Agent Session is active', async () => {
    await withStore(async (store) => {
      const issue = await createIssue(store, 'Cancel active Issue');
      await startIssueSession(store, issue, 20);

      const canceled = await store.update({
        target: { type: 'issue', id: issue.id, expectedRevision: issue.revision },
        change: { type: 'transition', status: { name: 'Canceled', category: 'canceled' } },
        request: { mode: 'request' },
        reason: 'Attempt to cancel running work.',
      }, actor, 30);

      expect(canceled.status).toBe('blocked');
      expect(canceled.validation?.map((entry) => entry.code)).toContain('active_session_exists');
      expect((await store.read({ target: { type: 'issue', id: issue.id } })).issue?.status.category).not.toBe('canceled');
    });
  });

  test('keeps an archived but unfinished child in the parent completion gate', async () => {
    await withStore(async (store) => {
      const { child, parent } = await createParentWithChild(store, 'archived child');
      await store.update({
        target: { type: 'issue', id: child.id, expectedRevision: child.revision },
        change: { type: 'archive' },
        request: { mode: 'request' },
        reason: 'Archive unfinished child work.',
      }, actor, 50);

      const completed = await store.update({
        target: { type: 'issue', id: parent.id, expectedRevision: parent.revision },
        change: { type: 'transition', status: { name: 'Completed', category: 'completed' } },
        request: { mode: 'request' },
        reason: 'Attempt to complete the parent.',
      }, actor, 60);

      expect(completed.status).toBe('blocked');
      expect(completed.validation?.map((entry) => entry.code)).toContain('incomplete_child_issues');
      expect((await store.read({ target: { type: 'issue', id: parent.id } })).issue?.status.category).not.toBe('completed');
    });
  });

  test('blocks deleting a parent Issue while direct children still exist', async () => {
    await withStore(async (store) => {
      const { child, parent } = await createParentWithChild(store, 'delete children');

      const deleted = await store.update({
        target: { type: 'issue', id: parent.id, expectedRevision: parent.revision },
        change: { type: 'delete' },
        request: { mode: 'request' },
        reason: 'Attempt to delete a parent with child work.',
      }, actor, 50);

      expect(deleted.status).toBe('blocked');
      expect(deleted.validation?.map((entry) => entry.code)).toContain('child_issues_exist');
      expect((await store.read({ target: { type: 'issue', id: parent.id } })).issue).toBeDefined();
      expect((await store.read({ target: { type: 'issue', id: child.id } })).issue?.parentIssueId).toBe(parent.id);
    });
  });

  test('blocks deleting an Issue while it has an active Agent Session', async () => {
    await withStore(async (store) => {
      const issue = await createIssue(store, 'Delete active');
      const sessionId = await startIssueSession(store, issue, 20);

      const deleted = await store.update({
        target: { type: 'issue', id: issue.id, expectedRevision: issue.revision },
        change: { type: 'delete' },
        request: { mode: 'request' },
        reason: 'Attempt to delete active work.',
      }, actor, 30);

      expect(deleted.status).toBe('blocked');
      expect(deleted.validation?.map((entry) => entry.code)).toContain('active_session_exists');
      expect((await store.read({ target: { type: 'issue', id: issue.id } })).issue).toBeDefined();
      expect((await store.readSession({ agentSessionId: sessionId }))?.agentSession.state).toBe('pending');
    });
  });

  test('keeps failSessionStart idempotent after the first terminal transition', async () => {
    await withStore(async (store) => {
      const issue = await createIssue(store, 'Failed start');
      const sessionId = await startIssueSession(store, issue, 20);

      await store.failSessionStart(sessionId, 'Provider unavailable.', actor, 100);
      await store.failSessionStart(sessionId, 'Duplicate late failure.', actor, 200);

      const read = await store.readSession({ agentSessionId: sessionId, include: ['activity-summary'] });
      expect(read?.agentSession).toMatchObject({
        state: 'error',
        errorMessage: 'Provider unavailable.',
        completedAt: 100,
        updatedAt: 100,
      });
      expect(read?.activity?.filter((entry) => entry.content.type === 'agent-error')).toHaveLength(1);
    });
  });

  test('reports an execution error as a terminal edge exactly once', async () => {
    await withStore(async (store) => {
      const issue = await createIssue(store, 'Execution error');
      const sessionId = await startIssueSession(store, issue, 20);
      await store.bindSessionExecution(sessionId, {
        engine: 'delegation',
        conversationId: 'conversation:error',
        executionId: 'execution:error',
        startedAt: 30,
      }, actor, 30);

      const first = await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:error',
        state: 'failed',
        errorMessage: 'Execution failed.',
        completedAt: 100,
      }, actor, 100);
      const duplicate = await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:error',
        state: 'failed',
        errorMessage: 'Execution failed.',
        completedAt: 100,
      }, actor, 120);

      expect(first?.becameTerminal).toBe(true);
      expect(duplicate?.becameTerminal).toBe(false);
      expect((await store.readSession({ agentSessionId: sessionId }))?.agentSession).toMatchObject({
        state: 'error',
        completedAt: 100,
      });
    });
  });

  test('persists and retries failed-start terminal delivery claims', async () => {
    await withStore(async (store) => {
      const created = await store.create({
        issueType: 'issue',
        fields: { title: 'Durable failed start' },
        request: { mode: 'request' },
        reason: 'Create routed work.',
      }, actor, 10, { origin: { type: 'conversation', conversationId: 'conversation:origin' } });
      const issueId = created.targets.find((target) => target.type === 'issue')!.id;
      const issue = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
      const sessionId = await startIssueSession(store, issue, 20);

      await store.failSessionStart(sessionId, 'Provider unavailable.', actor, 100);

      const firstClaim = await store.claimTerminalDeliveries('owner:first', 10, 110);
      expect(firstClaim).toHaveLength(1);
      expect(firstClaim[0]).toMatchObject({
        issueId,
        agentSessionId: sessionId,
        state: 'error',
        status: 'dispatching',
        attemptCount: 1,
        body: 'Provider unavailable.',
      });
      await store.releaseTerminalDelivery(firstClaim[0]!.id, 'owner:first', 'Temporary route failure.', 120);

      const retryClaim = await store.claimTerminalDeliveries('owner:restart', 10, 130);
      expect(retryClaim).toHaveLength(1);
      expect(retryClaim[0]).toMatchObject({
        id: firstClaim[0]!.id,
        status: 'dispatching',
        attemptCount: 2,
      });
      expect(await store.completeTerminalDelivery(retryClaim[0]!.id, 'owner:restart', 140)).toBe(true);
      expect((await store.state()).terminalDeliveries[retryClaim[0]!.id]).toMatchObject({
        status: 'delivered',
        deliveredAt: 140,
      });
    });
  });

  test('does not create or rewrite the store when no terminal delivery is claimable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-agent-issue-empty-delivery-'));
    const storePath = path.join(root, AGENT_ISSUE_OPERATION_LOG_FILE);
    try {
      const store = AgentIssueStore.forAgentDataRoot(root);
      expect(await store.claimTerminalDeliveries('owner:idle', 10, 100)).toEqual([]);
      expect(await access(storePath).then(() => true, () => false)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('leases terminal delivery claims so concurrent drain owners cannot execute one delivery twice', async () => {
    await withStore(async (store) => {
      const created = await store.create({
        issueType: 'issue',
        fields: { title: 'Concurrent delivery claim' },
        request: { mode: 'request' },
        reason: 'Create routed work.',
      }, actor, 10, { origin: { type: 'conversation', conversationId: 'conversation:origin' } });
      const issueId = created.targets.find((target) => target.type === 'issue')!.id;
      const issue = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
      const sessionId = await startIssueSession(store, issue, 20);
      await store.failSessionStart(sessionId, 'Provider unavailable.', actor, 30);

      const [first, second] = await Promise.all([
        store.claimTerminalDeliveries('owner:first', 10, 40),
        store.claimTerminalDeliveries('owner:second', 10, 40),
      ]);
      expect([first.length, second.length].sort()).toEqual([0, 1]);
      const winner = first[0] ?? second[0]!;
      const loserOwner = first.length === 0 ? 'owner:first' : 'owner:second';
      expect(await store.claimTerminalDeliveries(loserOwner, 10, 40 + 29_999)).toEqual([]);

      const reclaimed = await store.claimTerminalDeliveries(loserOwner, 10, 40 + 30_001);
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]).toMatchObject({ id: winner.id, attemptCount: 2 });
      expect(await store.completeTerminalDelivery(winner.id, winner.dispatchOwnerId!, 40 + 30_002)).toBe(false);
      expect(await store.releaseTerminalDelivery(winner.id, winner.dispatchOwnerId!, undefined, 40 + 30_003)).toBe(false);
      expect(await store.completeTerminalDelivery(winner.id, loserOwner, 40 + 30_004)).toBe(true);
    });
  });

  test('manual human-review completion uses the execution result for delivery', async () => {
    await withStore(async (store) => {
      const created = await store.create({
        issueType: 'issue',
        fields: {
          title: 'Human-reviewed result',
          verificationPolicy: { mode: 'human-review' },
          completionCriteria: [{ id: 'review', text: 'A human accepts the result.', state: 'open' }],
        },
        request: { mode: 'request' },
        reason: 'Create human-reviewed work.',
      }, actor, 10, { origin: { type: 'conversation', conversationId: 'conversation:origin' } });
      const issueId = created.targets.find((target) => target.type === 'issue')!.id;
      const issue = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
      const sessionId = await startIssueSession(store, issue, 20);
      await store.bindSessionExecution(sessionId, {
        engine: 'delegation',
        conversationId: 'conversation:execution',
        executionId: 'execution:human-review',
        startedAt: 30,
      }, actor, 30);
      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:human-review',
        state: 'completed',
        latestOutput: 'Reviewed deliverable body.',
        completedAt: 100,
      }, actor, 100);
      const current = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;

      const agentCompletion = await store.update({
        target: { type: 'issue', id: issueId, expectedRevision: current.revision },
        change: { type: 'transition', status: { name: 'Completed', category: 'completed' } },
        request: { mode: 'request' },
        reason: 'An agent attempts to accept its own human-reviewed result.',
      }, actor, 110, { allowHumanReviewTransition: true });
      expect(agentCompletion).toMatchObject({
        status: 'blocked',
        validation: [expect.objectContaining({ code: 'human_review_confirmation_required' })],
      });

      const user: ActorRef = { type: 'user', userId: 'user:reviewer' };
      const completed = await store.update({
        target: { type: 'issue', id: issueId, expectedRevision: current.revision },
        change: { type: 'transition', status: { name: 'Completed', category: 'completed' } },
        request: { mode: 'request' },
        reason: 'Human review accepted the result.',
      }, user, 120, { allowHumanReviewTransition: true });

      expect(completed.status).toBe('applied');
      const state = await store.state();
      expect(state.issues[issueId]?.completionCriteria?.[0]).toMatchObject({ state: 'met' });
      expect(Object.values(state.terminalDeliveries)).toEqual([
        expect.objectContaining({
          issueId,
          agentSessionId: sessionId,
          state: 'complete',
          body: 'Reviewed deliverable body.',
          status: 'pending',
        }),
      ]);
    });
  });

  test('explicit verifier completion enforces evidence and delivers execute output', async () => {
    await withStore(async (store) => {
      const created = await store.create({
        issueType: 'issue',
        fields: {
          title: 'Verified routed result',
          verificationPolicy: {
            mode: 'agent-review',
            requiredVerdict: 'pass',
            requiredEvidence: ['source URL'],
          },
        },
        request: { mode: 'request' },
        reason: 'Create verified work.',
      }, actor, 10, { origin: { type: 'conversation', conversationId: 'conversation:origin' } });
      const issueId = created.targets.find((target) => target.type === 'issue')!.id;
      const issue = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
      const executeSessionId = await startIssueSession(store, issue, 20);
      await store.bindSessionExecution(executeSessionId, {
        engine: 'delegation',
        conversationId: 'conversation:execute',
        executionId: 'execution:execute',
        startedAt: 30,
      }, actor, 30);
      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:execute',
        state: 'completed',
        latestOutput: 'The original execution result.',
        completedAt: 100,
      }, actor, 100);
      const afterExecution = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
      const verifierStart = await store.startSession({
        issueId,
        purpose: 'verify',
        expectedIssueRevision: afterExecution.revision,
        request: { mode: 'request' },
        reason: 'Verify the result.',
      }, source, actor, 110);
      const verifierSessionId = sessionIdFrom(verifierStart);
      await store.bindSessionExecution(verifierSessionId, {
        engine: 'delegation',
        conversationId: 'conversation:verify',
        executionId: 'execution:verify',
        startedAt: 120,
      }, actor, 120);

      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:verify',
        state: 'completed',
        latestOutput: 'Verdict: pass\nThe evidence is sufficient.',
        completedAt: 130,
      }, actor, 130);
      expect((await store.read({ target: { type: 'issue', id: issueId } })).issue?.status.category).toBe('started');

      const accepted = await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:verify',
        state: 'completed',
        latestOutput: 'Verdict: pass\nThe source URL was checked and supports the result.',
        completedAt: 130,
      }, actor, 140);

      expect(accepted?.issueBecameCompleted).toBe(true);
      const state = await store.state();
      expect(state.issues[issueId]?.status.category).toBe('completed');
      expect(Object.values(state.terminalDeliveries)).toEqual([
        expect.objectContaining({
          issueId,
          agentSessionId: executeSessionId,
          state: 'complete',
          body: 'The original execution result.',
        }),
      ]);
    });
  });

  test('routes a newer verifier failure after an earlier completed snapshot', async () => {
    await withStore(async (store) => {
      const created = await store.create({
        issueType: 'issue',
        fields: {
          title: 'Verifier infrastructure failure',
          verificationPolicy: { mode: 'agent-review', requiredVerdict: 'pass' },
        },
        request: { mode: 'request' },
        reason: 'Create verified work.',
      }, actor, 10, { origin: { type: 'conversation', conversationId: 'conversation:origin' } });
      const issueId = created.targets.find((target) => target.type === 'issue')!.id;
      const issue = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
      const sessionId = await startIssueSession(store, issue, 20);
      await store.bindSessionExecution(sessionId, {
        engine: 'delegation',
        conversationId: 'conversation:execute',
        executionId: 'execution:verifier-failure',
        startedAt: 30,
      }, actor, 30);
      await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:verifier-failure',
        state: 'completed',
        objectiveStatus: 'verifying',
        latestOutput: 'Work result awaiting verification.',
        completedAt: 100,
      }, actor, 100);

      const failed = await store.syncSessionExecution({
        engine: 'delegation',
        executionId: 'execution:verifier-failure',
        state: 'failed',
        objectiveStatus: 'blocked',
        errorMessage: 'Verifier could not run.',
        completedAt: 140,
      }, actor, 140);

      expect(failed?.becameTerminal).toBe(true);
      expect(failed?.session).toMatchObject({ state: 'error', completedAt: 140 });
      expect(Object.values((await store.state()).terminalDeliveries)).toEqual([
        expect.objectContaining({
          issueId,
          agentSessionId: sessionId,
          state: 'error',
          body: 'Verifier could not run.',
        }),
      ]);
    });
  });
});
