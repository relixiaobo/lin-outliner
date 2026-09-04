import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { ThreadId, TurnId } from '../../src/core/agent/protocol';
import type {
  DelegateExecutionResult,
  DelegateStateCommand,
} from '../../src/delegate/contract';
import { parseDelegateCommand } from '../../src/delegate/contract';
import {
  DelegationCoordinator,
  DelegationSessionStore,
  delegationTaskReconciliation,
  type DelegateCapabilityExecution,
  type DelegationPreparedResultStore,
  type DelegationRootMessage,
  type DelegationSessionBinding,
  type DelegationSessionCommitInput,
  type DelegationSessionRunInput,
  type DelegationSessionRuntime,
} from '../../src/main/agent/delegation';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';

const OWNER_ID = '00000000-0000-7000-8000-000000000001' as ThreadId;
const SESSION_ID = '00000000-0000-7000-8000-000000000010' as ThreadId;
const ROOT_TURN_ID = '00000000-0000-7000-8000-000000000020' as TurnId;

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close(false);
});

describe('DelegationCoordinator', () => {
  test('keeps the Session occupied until matching prepared and final evidence commits', async () => {
    const fixture = coordinatorFixture();
    fixture.runtime.immediate = true;

    const result = await fixture.coordinator.execute(runExecution('capability-run', 'task-run'));
    expect(result).toMatchObject({
      kind: 'delegate.execution-result',
      sessionId: SESSION_ID,
      outcome: 'succeeded',
    });
    const settlement = fixture.store.settlementForTask('task-run');
    expect(settlement).toMatchObject({ state: 'context_committed' });
    expect(fixture.store.readSession(SESSION_ID)).toMatchObject({ currentTaskId: 'task-run' });
    expect(fixture.prepared.values.get('task-run')).toBeDefined();

    await expect(fixture.coordinator.settleFinalReceipt({
      taskId: 'task-run',
      preparedResultDigest: settlement!.preparedResultDigest,
      receiptDigest: digest('final-receipt'),
    })).resolves.toMatchObject({
      outcome: 'committed',
      result: { outcome: 'succeeded' },
    });

    expect(fixture.store.settlementForTask('task-run')).toMatchObject({ state: 'committed' });
    expect(fixture.store.readSession(SESSION_ID)).toMatchObject({
      currentTaskId: null,
      previousTaskId: 'task-run',
    });
  });

  test('accepts context while a run is active and commits its exact message prefix', async () => {
    const fixture = coordinatorFixture();
    const running = fixture.coordinator.execute(runExecution('capability-run', 'task-run'));
    await waitUntil(() => fixture.runtime.active !== null);
    const activeSession = fixture.store.readSession(SESSION_ID)!;

    const receipt = await fixture.coordinator.execute(sendExecution({
      capabilityId: 'capability-send',
      taskId: 'task-send',
      sessionRevision: activeSession.revision,
      message: 'Also inspect the restart boundary.',
    }));
    expect(receipt).toMatchObject({
      kind: 'delegate.message-receipt',
      sessionId: SESSION_ID,
      sequence: 1,
      state: 'committed',
      taskId: 'task-run',
    });
    await waitUntil(() => fixture.store.readMessage('capability-send')?.state === 'committed');
    expect(fixture.store.settlementForTask('task-run')).toMatchObject({ messageSequence: 1 });

    fixture.runtime.finish();
    await expect(running).resolves.toMatchObject({ committedMessageSequence: 1 });
    expect(fixture.store.settlementForTask('task-run')).toMatchObject({
      state: 'context_committed',
      messageSequence: 1,
    });
  });

  test('continues every queued message when the active Turn closes before consuming them', async () => {
    const fixture = coordinatorFixture();
    fixture.runtime.deliverSteering = false;
    const running = fixture.coordinator.execute(runExecution('capability-run', 'task-run'));
    await waitUntil(() => fixture.runtime.active !== null);

    const first = fixture.coordinator.execute(sendExecution({
      capabilityId: 'capability-send-one',
      taskId: 'task-send-one',
      sessionRevision: fixture.store.readSession(SESSION_ID)!.revision,
      message: 'Inspect the shutdown boundary.',
    }));
    await waitUntil(() => fixture.store.readMessage('capability-send-one')?.state === 'queued');
    const second = fixture.coordinator.execute(sendExecution({
      capabilityId: 'capability-send-two',
      taskId: 'task-send-two',
      sessionRevision: fixture.store.readSession(SESSION_ID)!.revision,
      message: 'Also verify the restart boundary.',
    }));
    await waitUntil(() => fixture.store.readMessage('capability-send-two')?.state === 'queued');

    fixture.runtime.finish();
    await running;
    const initial = fixture.store.settlementForTask('task-run')!;
    await fixture.coordinator.settleFinalReceipt({
      taskId: 'task-run',
      preparedResultDigest: initial.preparedResultDigest,
      receiptDigest: digest('initial-final-receipt'),
    });
    await waitUntil(() => fixture.runtime.active?.session.currentTaskId === 'task-send-one'
      || fixture.runtime.active?.session.currentTaskId === 'task-send-two');
    expect(fixture.runtime.active?.messages.map((message) => ({
      sequence: message.sequence,
      text: message.text,
    }))).toEqual([
      { sequence: 1, text: 'Inspect the shutdown boundary.' },
      { sequence: 2, text: 'Also verify the restart boundary.' },
    ]);

    fixture.runtime.finish();
    const outcomes = await Promise.all([first, second]);
    expect(outcomes.filter((outcome) => (
      (outcome as DelegateExecutionResult).kind === 'delegate.execution-result'
    ))).toHaveLength(1);
    expect(outcomes.filter((outcome) => (
      (outcome as { kind: string }).kind === 'delegate.message-receipt'
    ))).toHaveLength(1);
    expect(fixture.store.messagesForSession(SESSION_ID).map((message) => message.state))
      .toEqual(['committed', 'committed']);
  });

  test('does not redeliver accepted steering while unrelated Session changes wake the sender', async () => {
    const fixture = coordinatorFixture();
    fixture.runtime.deliverSteering = false;
    const running = fixture.coordinator.execute(runExecution('capability-run', 'task-run'));
    await waitUntil(() => fixture.runtime.active !== null);
    const sending = fixture.coordinator.execute(sendExecution({
      capabilityId: 'capability-send',
      taskId: 'task-send',
      sessionRevision: fixture.store.readSession(SESSION_ID)!.revision,
      message: 'Hold this message at the next safe boundary.',
    }));
    await waitUntil(() => fixture.runtime.steeringAttempts === 1);

    await fixture.coordinator.fenceUserStop({
      taskId: 'task-run',
      ownerThreadId: OWNER_ID,
      stoppedByRootTurnId: ROOT_TURN_ID,
      currentRootIntentRevision: 1,
    });
    expect(fixture.runtime.steeringAttempts).toBe(1);

    fixture.runtime.finish();
    await running;
    const initial = fixture.store.settlementForTask('task-run')!;
    await fixture.coordinator.settleFinalReceipt({
      taskId: 'task-run',
      preparedResultDigest: initial.preparedResultDigest,
      receiptDigest: digest('initial-final-receipt'),
    });
    await expect(sending).resolves.toMatchObject({
      kind: 'delegate.message-receipt',
      state: 'blocked',
      taskId: null,
    });
    expect(fixture.runtime.steeringAttempts).toBe(1);
  });

  test('persists the Session user-stop fence before process settlement can continue', async () => {
    const fixture = coordinatorFixture();
    const running = fixture.coordinator.execute(runExecution('capability-run', 'task-run'));
    await waitUntil(() => fixture.runtime.active !== null);

    await expect(fixture.coordinator.fenceUserStop({
      taskId: 'task-run',
      ownerThreadId: OWNER_ID,
      stoppedByRootTurnId: ROOT_TURN_ID,
      currentRootIntentRevision: 1,
    })).resolves.toEqual({
      outcome: 'fenced',
      sessionId: SESSION_ID,
      minimumResumeRevision: 2,
    });
    expect(fixture.store.readSession(SESSION_ID)?.stopFence).toMatchObject({
      cancelledTaskId: 'task-run',
      stoppedByRootTurnId: ROOT_TURN_ID,
      stoppedAtRootIntentRevision: 1,
      minimumResumeRevision: 2,
    });
    expect(fixture.runtime.active).not.toBeNull();

    fixture.runtime.finish();
    await running;
    const settlement = fixture.store.settlementForTask('task-run')!;
    await fixture.coordinator.settleFinalReceipt({
      taskId: 'task-run',
      preparedResultDigest: settlement.preparedResultDigest,
      receiptDigest: digest('final-receipt'),
    });
    expect(fixture.store.readSession(SESSION_ID)).toMatchObject({
      currentTaskId: null,
      stopFence: { minimumResumeRevision: 2 },
    });
  });

  test('does not claim unrelated or foreign Tool Tasks as delegated user stops', async () => {
    const fixture = coordinatorFixture();
    await expect(fixture.coordinator.fenceUserStop({
      taskId: 'task-ordinary-bash',
      ownerThreadId: OWNER_ID,
      stoppedByRootTurnId: ROOT_TURN_ID,
      currentRootIntentRevision: 1,
    })).resolves.toEqual({ outcome: 'unrelated' });

    const running = fixture.coordinator.execute(runExecution('capability-run', 'task-run'));
    await waitUntil(() => fixture.runtime.active !== null);
    await expect(fixture.coordinator.fenceUserStop({
      taskId: 'task-run',
      ownerThreadId: '00000000-0000-7000-8000-000000000099' as ThreadId,
      stoppedByRootTurnId: ROOT_TURN_ID,
      currentRootIntentRevision: 1,
    })).rejects.toThrow('not owned');
    fixture.runtime.finish();
    await running;
  });

  test('blocks only the affected execution when prepared result evidence mismatches', async () => {
    const fixture = coordinatorFixture();
    fixture.runtime.immediate = true;
    fixture.prepared.returnWrongDigest = true;

    await expect(fixture.coordinator.execute(runExecution('capability-run', 'task-run')))
      .rejects.toThrow('could not be committed safely');
    expect(fixture.store.settlementForTask('task-run')).toMatchObject({
      state: 'blocked',
      blockedReason: expect.stringContaining('digest'),
    });
  });

  test('reconciles a prepared result without running the delegated Turn again', async () => {
    const fixture = coordinatorFixture();
    fixture.runtime.immediate = true;
    fixture.runtime.failCommit = true;

    await expect(fixture.coordinator.execute(runExecution('capability-run', 'task-run')))
      .rejects.toThrow('simulated canonical commit interruption');
    const prepared = fixture.store.settlementForTask('task-run')!;
    expect(prepared.state).toBe('prepared');
    expect(fixture.runtime.commits).toHaveLength(0);

    fixture.runtime.failCommit = false;
    await fixture.coordinator.settleFinalReceipt({
      taskId: 'task-run',
      preparedResultDigest: prepared.preparedResultDigest,
      receiptDigest: digest('final-receipt'),
    });

    expect(fixture.store.settlementForTask('task-run')).toMatchObject({ state: 'committed' });
    expect(fixture.runtime.commits).toHaveLength(1);
    expect(fixture.runtime.commits[0]).toMatchObject({
      settlementId: 'capability-run',
      turnId: prepared.turnId,
    });
  });

  test('reports a blocked settlement when final evidence omits the prepared result', async () => {
    const fixture = coordinatorFixture();
    fixture.runtime.immediate = true;
    await fixture.coordinator.execute(runExecution('capability-run', 'task-run'));

    await expect(fixture.coordinator.settleFinalReceipt({
      taskId: 'task-run',
      preparedResultDigest: null,
      receiptDigest: digest('final-receipt'),
    })).resolves.toMatchObject({
      outcome: 'blocked',
      reason: expect.stringContaining('missing prepared result'),
    });
    expect(fixture.store.settlementForTask('task-run')?.state).toBe('blocked');
    expect(fixture.store.readSession(SESSION_ID)?.currentTaskId).toBeNull();
  });

  test('maps normalized delegated outcomes without overriding factual process failures', async () => {
    const fixture = coordinatorFixture();
    fixture.runtime.immediate = true;
    fixture.runtime.outcome = 'timed_out';
    const execution = await fixture.coordinator.execute(runExecution('capability-run', 'task-run'));
    expect(execution).toMatchObject({ outcome: 'timed_out' });
    const settlement = fixture.store.settlementForTask('task-run')!;
    const committed = await fixture.coordinator.settleFinalReceipt({
      taskId: 'task-run',
      preparedResultDigest: settlement.preparedResultDigest,
      receiptDigest: digest('final-receipt'),
    });

    expect(delegationTaskReconciliation(committed)).toEqual({
      outcome: 'replace',
      state: 'timed_out',
      reason: 'delegated_execution_timed_out',
      error: 'Delegated execution timed_out.',
    });
    expect(delegationTaskReconciliation({
      outcome: 'blocked',
      reason: 'Canonical context mismatch.',
    })).toEqual({
      outcome: 'replace',
      state: 'failed',
      reason: 'delegation_coordination_failed',
      error: 'Canonical context mismatch.',
    });
    expect(delegationTaskReconciliation({ outcome: 'unrelated' }))
      .toEqual({ outcome: 'preserve' });
  });

  test('closes an idle owned Session and refuses a stale Session revision', async () => {
    const fixture = coordinatorFixture();
    fixture.runtime.immediate = true;
    await fixture.coordinator.execute(runExecution('capability-run', 'task-run'));
    const settlement = fixture.store.settlementForTask('task-run')!;
    await fixture.coordinator.settleFinalReceipt({
      taskId: 'task-run',
      preparedResultDigest: settlement.preparedResultDigest,
      receiptDigest: digest('final-receipt'),
    });
    const session = fixture.store.readSession(SESSION_ID)!;

    await expect(fixture.coordinator.execute(closeExecution('capability-stale', session.revision - 1)))
      .rejects.toThrow('changed before closure');
    await expect(fixture.coordinator.execute(closeExecution('capability-close', session.revision)))
      .resolves.toMatchObject({ kind: 'delegate.close-receipt', closed: true });
    expect(fixture.store.readSession(SESSION_ID)?.state).toBe('closed');
    expect(fixture.runtime.closed).toEqual([SESSION_ID]);
  });
});

class FakeRuntime implements DelegationSessionRuntime {
  readonly ensured: ThreadId[] = [];
  readonly closed: ThreadId[] = [];
  active: DelegationSessionRunInput | null = null;
  immediate = false;
  failCommit = false;
  deliverSteering = true;
  steeringAttempts = 0;
  outcome: DelegateExecutionResult['outcome'] = 'succeeded';
  readonly commits: DelegationSessionCommitInput[] = [];
  private resolveRun: ((result: DelegateExecutionResult) => void) | null = null;
  private committedMessageSequence = 0;

  async ensureSession(session: DelegationSessionBinding): Promise<void> {
    this.ensured.push(session.sessionId);
  }

  async run(input: DelegationSessionRunInput): Promise<DelegateExecutionResult> {
    this.active = input;
    this.committedMessageSequence = input.messages.at(-1)?.sequence ?? 0;
    if (this.immediate) {
      const result = executionResult(input, this.committedMessageSequence, this.outcome);
      this.active = null;
      return result;
    }
    return new Promise((resolve) => { this.resolveRun = resolve; });
  }

  async commitResult(input: DelegationSessionCommitInput): Promise<void> {
    if (this.failCommit) throw new Error('simulated canonical commit interruption');
    this.commits.push(input);
  }

  send(sessionId: ThreadId, message: DelegationRootMessage, onDelivered: () => void): boolean {
    if (this.active?.session.sessionId !== sessionId) return false;
    this.steeringAttempts += 1;
    if (this.deliverSteering) {
      this.committedMessageSequence = message.sequence;
      onDelivered();
    }
    return true;
  }

  finish(): void {
    if (!this.active || !this.resolveRun) throw new Error('Fake delegated run is not active');
    const input = this.active;
    const resolve = this.resolveRun;
    this.active = null;
    this.resolveRun = null;
    resolve(executionResult(input, this.committedMessageSequence, this.outcome));
  }

  async close(session: DelegationSessionBinding): Promise<void> {
    this.closed.push(session.sessionId);
  }
}

class PreparedResults implements DelegationPreparedResultStore {
  readonly values = new Map<string, Buffer>();
  returnWrongDigest = false;

  async prepare(
    taskId: string,
    ownerThreadId: ThreadId,
    bytes: Uint8Array,
  ): Promise<{ readonly sha256: string }> {
    if (ownerThreadId !== OWNER_ID) throw new Error('Unexpected prepared-result owner');
    const value = Buffer.from(bytes);
    this.values.set(taskId, value);
    return { sha256: this.returnWrongDigest ? digest('wrong') : digest(value) };
  }

  async read(taskId: string, ownerThreadId: ThreadId): Promise<Uint8Array | null> {
    if (ownerThreadId !== OWNER_ID) throw new Error('Unexpected prepared-result owner');
    return this.values.get(taskId) ?? null;
  }
}

function coordinatorFixture() {
  const database = new Database(':memory:');
  databases.push(database);
  const store = new DelegationSessionStore(database as unknown as SqliteDatabase);
  const runtime = new FakeRuntime();
  const prepared = new PreparedResults();
  let now = 1_900_000_000_000;
  return {
    store,
    runtime,
    prepared,
    coordinator: new DelegationCoordinator({
      store,
      runtime,
      preparedResults: prepared,
      now: () => now++,
    }),
  };
}

function runExecution(capabilityId: string, taskId: string): DelegateCapabilityExecution {
  return execution({
    capabilityId,
    taskId,
    command: parseDelegateCommand(['run', '--input', '-', '--output', 'json']) as DelegateStateCommand,
    input: {
      version: 1,
      prompt: 'Inspect the settlement path.',
      profile: 'explore',
      access: 'read-only',
    },
    session: { kind: 'run', preallocatedSessionId: SESSION_ID },
  });
}

function sendExecution(input: {
  capabilityId: string;
  taskId: string;
  sessionRevision: number;
  message: string;
}): DelegateCapabilityExecution {
  return execution({
    capabilityId: input.capabilityId,
    taskId: input.taskId,
    command: parseDelegateCommand([
      'send', '--session', SESSION_ID, '--input', '-', '--output', 'json',
    ]) as DelegateStateCommand,
    input: { version: 1, message: input.message },
    session: {
      kind: 'send',
      sessionId: SESSION_ID,
      sessionRevision: input.sessionRevision,
      minimumResumeRevision: null,
    },
  });
}

function closeExecution(capabilityId: string, sessionRevision: number): DelegateCapabilityExecution {
  return execution({
    capabilityId,
    taskId: `task-${capabilityId}`,
    command: parseDelegateCommand([
      'close', '--session', SESSION_ID, '--output', 'json',
    ]) as DelegateStateCommand,
    input: null,
    session: { kind: 'close', sessionId: SESSION_ID, sessionRevision },
  });
}

function execution(input: {
  capabilityId: string;
  taskId: string;
  command: DelegateStateCommand;
  input: unknown;
  session: DelegateCapabilityExecution['admission']['session'];
}): DelegateCapabilityExecution {
  return {
    capabilityId: input.capabilityId,
    input: input.input,
    signal: new AbortController().signal,
    admission: {
      toolTaskId: input.taskId,
      toolTaskNonce: `nonce-${input.taskId}`,
      command: input.command,
      stdin: input.command.name === 'close' ? '' : JSON.stringify(input.input),
      cwd: '/workspace',
      processSha256: digest('process'),
      source: {
        rootThreadId: OWNER_ID,
        sourceTurnId: ROOT_TURN_ID,
        sourceItemId: `item-${input.capabilityId}`,
        rootUserIntentRevision: 1,
      },
      policy: {
        configurationRevision: 'configuration-1',
        capabilityCeilingDigest: digest('ceiling'),
        runnerId: 'internal',
        runnerVersion: '1',
        modelProvider: 'openai',
        modelId: 'gpt-test',
        effort: 'medium',
        profile: 'explore',
        access: 'read-only',
        timeoutMs: 60_000,
        schedulingPolicyDigest: digest('scheduling'),
      },
      session: input.session,
    },
  };
}

function executionResult(
  input: DelegationSessionRunInput,
  committedMessageSequence: number,
  outcome: DelegateExecutionResult['outcome'] = 'succeeded',
): DelegateExecutionResult {
  return {
    version: 1,
    kind: 'delegate.execution-result',
    sessionId: input.session.sessionId,
    turnId: input.turnId,
    outcome,
    runner: { id: 'internal', version: '1' },
    model: 'openai/gpt-test',
    durationMs: 10,
    text: 'Done.',
    error: outcome === 'succeeded' ? null : `Delegated execution ${outcome}.`,
    partialEvidence: outcome !== 'succeeded',
    committedMessageSequence,
    continuation: 'available',
    usage: { state: 'unknown' },
    artifacts: [],
    worktree: { disposition: 'none' },
  };
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for coordinator state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
