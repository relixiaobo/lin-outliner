import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { unstartedProcessIsolation } from '../../src/core/agent/processIsolation';
import type { ThreadId, TurnId } from '../../src/core/agent/protocol';
import type {
  DelegateExecutionResult,
  DelegateStateCommand,
} from '../../src/delegate/contract';
import { parseDelegateCommand } from '../../src/delegate/contract';
import {
  DelegationCoordinator,
  DELEGATION_SESSION_IDLE_TTL_MS,
  DelegationSessionStore,
  delegationTaskReconciliation,
  type DelegateCapabilityExecution,
  type DelegationPreparedResultStore,
  type DelegationRootMessage,
  type DelegationPolicySnapshot,
  type DelegationSessionBinding,
  type DelegationSessionCommitInput,
  type DelegationSessionRunInput,
  type DelegationSessionRuntime,
} from '../../src/main/agent/delegation';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';
import { pendingExecutionContext, resolveExecutionAddress } from '../../src/main/agent/tasks/ExecutionContext';
import { ToolTaskService } from '../../src/main/agent/tasks/ToolTaskService';
import { ToolTaskStore } from '../../src/main/agent/tasks/ToolTaskStore';
import type { ToolTaskDeliveryAdmission } from '../../src/main/agent/tasks/toolTaskTypes';

const OWNER_ID = '00000000-0000-7000-8000-000000000001' as ThreadId;
const SESSION_ID = '00000000-0000-7000-8000-000000000010' as ThreadId;
const ROOT_TURN_ID = '00000000-0000-7000-8000-000000000020' as TurnId;

const databases: Database[] = [];
const taskServices: ToolTaskService[] = [];

afterEach(async () => {
  for (const service of taskServices.splice(0)) await service.close(0);
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
      state: 'succeeded',
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

  test.each(['idle', 'active successor', 'acknowledged', 'admitted'] as const)(
    'stops terminal delegated Task responsibilities after Session release: %s',
    async (scenario) => {
      const fixture = await terminalDelegationTaskFixture();
      expect(fixture.tasks.read(fixture.task.taskId)?.continuation.event?.disposition).toBe('pending');
      expect(fixture.store.readSession(SESSION_ID)?.currentTaskId).toBeNull();

      const successor = scenario === 'idle' ? null : fixture.coordinator.execute(sendExecution({
        capabilityId: 'capability-successor',
        taskId: 'task-successor',
        sessionRevision: fixture.store.readSession(SESSION_ID)!.revision,
        message: 'Inspect a separate follow-up question.',
      }));
      try {
        if (successor) await waitUntil(() => fixture.runtime.active !== null);
        const sessionBeforeStop = fixture.store.readSession(SESSION_ID);
        const caller = { turnId: ROOT_TURN_ID, itemId: 'acknowledge-item' };
        let handling: unknown = null;
        if (scenario === 'acknowledged') {
          handling = fixture.tasks.control({
            task_id: fixture.task.taskId,
            operation_id: 'acknowledge-result',
            action: 'acknowledge',
            event_id: fixture.task.terminalDigest!,
          }, caller, 30).event?.handling;
        } else if (scenario === 'admitted') {
          const batch = fixture.tasks.prepareDelivery({
            taskIds: [fixture.task.taskId],
            batchId: 'completion-batch',
            ownerThreadId: OWNER_ID,
            reservedTurnId: ROOT_TURN_ID,
            clientId: 'completion-client',
            envelopeDigest: digest('completion-envelope'),
            now: 30,
          });
          // Canonical admission has committed; the Task batch has not linked yet.
          fixture.admissions.set(ROOT_TURN_ID, {
            batchId: batch.batchId,
            envelopeDigest: batch.envelopeDigest,
          });
          handling = { kind: 'completion', turnId: ROOT_TURN_ID, batchId: batch.batchId };
        }

        const stopped = await fixture.taskService.stop(fixture.task.taskId, OWNER_ID, ROOT_TURN_ID);
        expect(stopped).toMatchObject({
          state: 'succeeded',
          exitCode: 0,
          terminalDigest: fixture.task.terminalDigest,
          continuation: { stop: { source: 'user', turnId: ROOT_TURN_ID } },
        });
        expect(stopped?.continuation.event).toMatchObject(scenario === 'acknowledged'
          ? { disposition: 'handled', handling }
          : scenario === 'admitted'
            ? { disposition: 'admitted', handling }
            : { disposition: 'silent', reason: 'stopped', handling: null });
        expect(stopped?.deliveryTurnId).toBe(scenario === 'admitted' ? ROOT_TURN_ID : null);
        expect(fixture.tasks.pendingDelivery(OWNER_ID, 8)).toEqual([]);
        expect(fixture.store.readSession(SESSION_ID)).toEqual(sessionBeforeStop);
        if (successor) {
          expect(fixture.runtime.active?.session.currentTaskId).toBe('task-successor');
          expect(fixture.runtime.active?.signal.aborted).toBe(false);
        }
        expect(fixture.completionCalls()).toBe(0);
      } finally {
        if (successor) {
          fixture.runtime.finish();
          await successor;
        }
      }
    },
  );

  test('does not fence an execution released while Stop waits for final receipt reconciliation', async () => {
    const fixture = coordinatorFixture();
    fixture.runtime.immediate = true;
    await fixture.coordinator.execute(runExecution('capability-run', 'task-run'));
    const settlement = fixture.store.settlementForTask('task-run')!;
    const settling = fixture.coordinator.settleFinalReceipt({
      taskId: 'task-run',
      state: 'succeeded',
      preparedResultDigest: settlement.preparedResultDigest,
      receiptDigest: digest('final-receipt'),
    });
    const stopping = fixture.coordinator.fenceUserStop({
      taskId: 'task-run',
      ownerThreadId: OWNER_ID,
      stoppedByRootTurnId: ROOT_TURN_ID,
      currentRootIntentRevision: 1,
    });
    await expect(settling).resolves.toMatchObject({ outcome: 'committed' });
    await expect(stopping).resolves.toEqual({ outcome: 'settled' });
    expect(fixture.store.readSession(SESSION_ID)).toMatchObject({
      currentTaskId: null,
      previousTaskId: 'task-run',
      stopFence: null,
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
      state: 'succeeded',
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

  test.each(['failed', 'timed_out', 'cancelled'] as const)(
    'blocks queued messages instead of continuing after a %s Turn',
    async (outcome) => {
      const fixture = coordinatorFixture();
      fixture.runtime.outcome = outcome;
      fixture.runtime.deliverSteering = false;
      const running = fixture.coordinator.execute(runExecution('capability-run', 'task-run'));
      await waitUntil(() => fixture.runtime.active !== null);
      const sending = fixture.coordinator.execute(sendExecution({
        capabilityId: 'capability-send',
        taskId: 'task-send',
        sessionRevision: fixture.store.readSession(SESSION_ID)!.revision,
        message: 'Continue only if the active Turn succeeds.',
      }));
      await waitUntil(() => fixture.store.readMessage('capability-send')?.state === 'queued');

      fixture.runtime.finish();
      await expect(running).resolves.toMatchObject({ outcome });
      const settlement = fixture.store.settlementForTask('task-run')!;
      await expect(fixture.coordinator.settleFinalReceipt({
        taskId: 'task-run',
        state: 'succeeded',
        preparedResultDigest: settlement.preparedResultDigest,
        receiptDigest: digest(`${outcome}-final-receipt`),
      })).resolves.toMatchObject({ outcome: 'committed', result: { outcome } });

      await expect(sending).resolves.toMatchObject({
        kind: 'delegate.message-receipt',
        state: 'blocked',
        taskId: null,
      });
      expect(fixture.store.readMessage('capability-send')).toMatchObject({
        state: 'blocked',
        text: null,
        blockedReason: expect.stringContaining(outcome),
      });
      expect(fixture.runtime.active).toBeNull();
    },
  );

  test('blocks queued input when the process receipt fails despite a successful prepared result', async () => {
    const fixture = coordinatorFixture();
    fixture.runtime.deliverSteering = false;
    const running = fixture.coordinator.execute(runExecution('capability-run', 'task-run'));
    await waitUntil(() => fixture.runtime.active !== null);
    const sending = fixture.coordinator.execute(sendExecution({
      capabilityId: 'capability-send',
      taskId: 'task-send',
      sessionRevision: fixture.store.readSession(SESSION_ID)!.revision,
      message: 'Do not run after a failed process receipt.',
    }));
    await waitUntil(() => fixture.store.readMessage('capability-send')?.state === 'queued');

    fixture.runtime.finish();
    await running;
    const settlement = fixture.store.settlementForTask('task-run')!;
    await expect(fixture.coordinator.settleFinalReceipt({
      taskId: 'task-run',
      state: 'timed_out',
      preparedResultDigest: settlement.preparedResultDigest,
      receiptDigest: digest('timed-out-final-receipt'),
    })).resolves.toMatchObject({ outcome: 'committed' });

    await expect(sending).resolves.toMatchObject({ state: 'blocked', taskId: null });
    expect(fixture.runtime.active).toBeNull();

    fixture.runtime.immediate = true;
    fixture.runtime.outcome = 'succeeded';
    const continuation = await fixture.coordinator.execute(sendExecution({
      capabilityId: 'capability-send-after-failure',
      taskId: 'task-send-after-failure',
      sessionRevision: fixture.store.readSession(SESSION_ID)!.revision,
      message: 'Continue only after an explicit fresh request.',
    }));
    expect(continuation).toMatchObject({
      kind: 'delegate.execution-result',
      outcome: 'succeeded',
    });
  });

  test('allows a fresh explicit send after a fenced non-success process receipt', async () => {
    const fixture = coordinatorFixture();
    const running = fixture.coordinator.execute(runExecution('capability-run', 'task-run'));
    await waitUntil(() => fixture.runtime.active !== null);
    const session = fixture.store.readSession(SESSION_ID)!;
    await fixture.coordinator.fenceUserStop({
      taskId: 'task-run',
      ownerThreadId: OWNER_ID,
      stoppedByRootTurnId: ROOT_TURN_ID,
      currentRootIntentRevision: 1,
    });

    fixture.runtime.outcome = 'cancelled';
    fixture.runtime.finish();
    await running;
    const settlement = fixture.store.settlementForTask('task-run')!;
    await expect(fixture.coordinator.settleFinalReceipt({
      taskId: 'task-run',
      state: 'cancelled',
      preparedResultDigest: settlement.preparedResultDigest,
      receiptDigest: digest('fenced-cancelled-final-receipt'),
    })).resolves.toMatchObject({ outcome: 'committed' });

    fixture.runtime.immediate = true;
    fixture.runtime.outcome = 'succeeded';
    const continuation = await fixture.coordinator.execute(sendExecution({
      capabilityId: 'capability-send-after-stop',
      taskId: 'task-send-after-stop',
      sessionRevision: fixture.store.readSession(SESSION_ID)!.revision,
      rootIntentRevision: 2,
      message: 'Continue after the user explicitly resumed the Session.',
    }));
    expect(continuation).toMatchObject({
      kind: 'delegate.execution-result',
      outcome: 'succeeded',
    });
    expect(fixture.store.readSession(SESSION_ID)?.stopFence).toBeNull();
    expect(fixture.store.readSession(SESSION_ID)?.revision).toBeGreaterThan(session.revision);
  });

  test('blocks a queued send message when its execution is cancelled', async () => {
    const fixture = coordinatorFixture();
    fixture.runtime.deliverSteering = false;
    const running = fixture.coordinator.execute(runExecution('capability-run', 'task-run'));
    await waitUntil(() => fixture.runtime.active !== null);
    const controller = new AbortController();
    const cancelled = fixture.coordinator.execute({
      ...sendExecution({
        capabilityId: 'capability-send-cancelled',
        taskId: 'task-send-cancelled',
        sessionRevision: fixture.store.readSession(SESSION_ID)!.revision,
        message: 'This cancelled message must never run.',
      }),
      signal: controller.signal,
    });
    await waitUntil(() => fixture.store.readMessage('capability-send-cancelled')?.state === 'queued');
    controller.abort();

    await expect(cancelled).rejects.toThrow('cancelled');
    expect(fixture.store.readMessage('capability-send-cancelled')).toMatchObject({ state: 'blocked' });
    fixture.runtime.finish();
    await running;
    const settlement = fixture.store.settlementForTask('task-run')!;
    await fixture.coordinator.settleFinalReceipt({
      taskId: 'task-run',
      state: 'succeeded',
      preparedResultDigest: settlement.preparedResultDigest,
      receiptDigest: digest('cancelled-send-final-receipt'),
    });
    expect(fixture.store.queuedMessages(SESSION_ID)).toEqual([]);
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
    fixture.runtime.deliverPendingSteering();
    await waitUntil(() => fixture.store.readMessage('capability-send')?.state === 'blocked');

    fixture.runtime.finish();
    await running;
    const initial = fixture.store.settlementForTask('task-run')!;
    await fixture.coordinator.settleFinalReceipt({
      taskId: 'task-run',
      state: 'succeeded',
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
      state: 'succeeded',
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
      state: 'succeeded',
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
      state: 'succeeded',
      preparedResultDigest: null,
      receiptDigest: digest('final-receipt'),
    })).resolves.toMatchObject({
      outcome: 'blocked',
      reason: expect.stringContaining('missing prepared result'),
    });
    expect(fixture.store.settlementForTask('task-run')?.state).toBe('blocked');
    expect(fixture.store.readSession(SESSION_ID)?.currentTaskId).toBeNull();
  });

  test('blocks queued messages when their active execution cannot settle', async () => {
    const fixture = coordinatorFixture();
    fixture.runtime.deliverSteering = false;
    void fixture.coordinator.execute(runExecution('capability-run', 'task-run'));
    await waitUntil(() => fixture.runtime.active !== null);
    const pendingMessage = fixture.coordinator.execute(sendExecution({
      capabilityId: 'capability-send',
      taskId: 'task-send',
      sessionRevision: fixture.store.readSession(SESSION_ID)!.revision,
      message: 'Inspect the evidence before continuing.',
    }));
    await waitUntil(() => fixture.store.readMessage('capability-send')?.state === 'queued');

    await fixture.coordinator.settleFinalReceipt({
      taskId: 'task-run',
      state: 'succeeded',
      preparedResultDigest: null,
      receiptDigest: digest('failed-final-receipt'),
    });

    await expect(pendingMessage).resolves.toMatchObject({
      kind: 'delegate.message-receipt',
      state: 'blocked',
      taskId: null,
    });
    expect(fixture.store.readMessage('capability-send')).toMatchObject({
      state: 'blocked',
      text: null,
      blockedReason: expect.stringContaining('execution settlement'),
    });
    const session = fixture.store.readSession(SESSION_ID)!;
    await expect(fixture.coordinator.execute(closeExecution('capability-close', session.revision)))
      .resolves.toMatchObject({ closed: true });
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
      state: 'succeeded',
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
      state: 'succeeded',
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

  test('refuses active or queued Session closure before runtime cleanup', async () => {
    const activeFixture = coordinatorFixture();
    const running = activeFixture.coordinator.execute(runExecution('capability-run', 'task-run'));
    await waitUntil(() => activeFixture.runtime.active !== null);
    const activeSession = activeFixture.store.readSession(SESSION_ID)!;

    await expect(activeFixture.coordinator.execute(
      closeExecution('capability-close-active', activeSession.revision),
    )).rejects.toThrow('must be idle');
    expect(activeFixture.runtime.closed).toEqual([]);
    activeFixture.runtime.finish();
    await running;

    const queuedFixture = coordinatorFixture();
    const initial = createStoredSession(queuedFixture.store, SESSION_ID, 1_900_000_000_000);
    queuedFixture.store.appendMessage({
      sessionId: SESSION_ID,
      expectedRevision: initial.revision,
      messageId: 'queued-message',
      text: 'Keep this pending.',
      sourceTaskId: 'task-send',
      sourceRootTurnId: ROOT_TURN_ID,
      sourceRootItemId: 'item-send',
      sourceRootIntentRevision: 1,
      now: 1_900_000_000_001,
    });
    const queuedSession = queuedFixture.store.readSession(SESSION_ID)!;

    await expect(queuedFixture.coordinator.execute(
      closeExecution('capability-close-queued', queuedSession.revision),
    )).rejects.toThrow('must be idle');
    expect(queuedFixture.runtime.closed).toEqual([]);
    expect(queuedFixture.store.readSession(SESSION_ID)).toMatchObject({ state: 'open' });
  });

  test('recovers open Sessions and closes only those beyond the idle TTL', async () => {
    const fixture = coordinatorFixture();
    const now = 1_900_000_000_000;
    const stale = createStoredSession(fixture.store, SESSION_ID, now - DELEGATION_SESSION_IDLE_TTL_MS - 1);
    const recentId = '00000000-0000-7000-8000-000000000011' as ThreadId;
    createStoredSession(fixture.store, recentId, now);

    await fixture.coordinator.initialize();

    expect(fixture.runtime.ensured).toEqual([stale.sessionId, recentId]);
    expect(fixture.runtime.closed).toEqual([stale.sessionId]);
    expect(fixture.store.readSession(stale.sessionId)?.state).toBe('closed');
    expect(fixture.store.readSession(recentId)?.state).toBe('open');
  });

  test('continues Session recovery when one Session cannot be restored', async () => {
    const fixture = coordinatorFixture();
    const failedId = '00000000-0000-7000-8000-000000000011' as ThreadId;
    const healthyId = '00000000-0000-7000-8000-000000000012' as ThreadId;
    createStoredSession(fixture.store, failedId, 1_900_000_000_000);
    createStoredSession(fixture.store, healthyId, 1_900_000_000_000);
    fixture.runtime.ensureFailures.add(failedId);

    await expect(fixture.coordinator.initialize()).resolves.toBeUndefined();

    expect(fixture.runtime.ensured).toEqual([failedId, healthyId]);
    expect(fixture.store.readSession(failedId)?.state).toBe('open');
    expect(fixture.store.readSession(healthyId)?.state).toBe('open');
  });

  test('closes owner Sessions, removes clean control state, and refuses retained workspace state', async () => {
    const fixture = coordinatorFixture();
    const clean = createStoredSession(fixture.store, SESSION_ID, 1_900_000_000_000);

    await fixture.coordinator.prepareOwnerDeletion(OWNER_ID);
    expect(fixture.store.readSession(clean.sessionId)?.state).toBe('closed');
    fixture.coordinator.deleteOwnerSessions(OWNER_ID);
    expect(fixture.store.sessionsForOwner(OWNER_ID)).toEqual([]);

    const retainedId = '00000000-0000-7000-8000-000000000013' as ThreadId;
    fixture.store.createSession({
      sessionId: retainedId,
      ownerThreadId: OWNER_ID,
      policy: storedPolicy(),
      worktree: {
        kind: 'ambiguous',
        intent: {
          sourceCwd: '/workspace',
          path: '/managed/session',
          branch: 'tenon-agent-session',
          baseCommit: 'base-revision',
          gitCommonDir: '/workspace/.git',
        },
        metadata: null,
      },
      now: 1_900_000_000_000,
    });
    await expect(fixture.coordinator.prepareOwnerDeletion(OWNER_ID))
      .rejects.toThrow('retains workspace changes');
    expect(fixture.store.readSession(retainedId)).not.toBeNull();
  });
});

class FakeRuntime implements DelegationSessionRuntime {
  readonly ensured: ThreadId[] = [];
  readonly closed: ThreadId[] = [];
  readonly ensureFailures = new Set<ThreadId>();
  active: DelegationSessionRunInput | null = null;
  immediate = false;
  failCommit = false;
  deliverSteering = true;
  steeringAttempts = 0;
  private readonly pendingSteering: Array<() => void> = [];
  outcome: DelegateExecutionResult['outcome'] = 'succeeded';
  readonly commits: DelegationSessionCommitInput[] = [];
  private resolveRun: ((result: DelegateExecutionResult) => void) | null = null;
  private committedMessageSequence = 0;

  async ensureSession(session: DelegationSessionBinding): Promise<void> {
    this.ensured.push(session.sessionId);
    if (this.ensureFailures.has(session.sessionId)) throw new Error('simulated recovery failure');
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
    } else {
      this.pendingSteering.push(onDelivered);
    }
    return true;
  }

  deliverPendingSteering(): void {
    for (const deliver of this.pendingSteering.splice(0)) deliver();
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

  async prepareOwnerDeletion(session: DelegationSessionBinding): Promise<void> {
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
    database,
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

async function terminalDelegationTaskFixture() {
  const fixture = coordinatorFixture();
  const tasks = new ToolTaskStore(fixture.database as unknown as SqliteDatabase);
  const executionContext = pendingExecutionContext(await resolveExecutionAddress({ defaultCwd: process.cwd() }), {
    capability: 'full-access', isolation: 'unsandboxed', writablePaths: [],
  });
  const runningTask = tasks.create({
    taskId: 'task-run',
    ownerThreadId: OWNER_ID,
    sourceTurnId: ROOT_TURN_ID,
    sourceItemId: 'source-run',
    producer: 'delegate',
    description: 'Inspect the settlement path.',
    commandDigest: digest('command'),
    cwd: executionContext.address.cwd,
    executionContext,
    operationKind: 'process',
    parentTaskId: null,
    nonce: 'nonce-task-run',
    detailPath: '/unused/terminal-delegation-task',
    backgroundEnabled: true,
    timeoutMs: null,
    startedAt: 10,
  });
  fixture.runtime.immediate = true;
  await fixture.coordinator.execute(runExecution('capability-run', runningTask.taskId));
  fixture.runtime.immediate = false;
  const settlement = fixture.store.settlementForTask(runningTask.taskId)!;
  const unsigned = {
    version: 3 as const,
    isolation: unstartedProcessIsolation(runningTask.isolation),
    taskId: runningTask.taskId,
    nonce: runningTask.nonce,
    state: 'succeeded' as const,
    exitCode: 0,
    signal: null,
    reason: 'exit_zero',
    error: null,
    supervisorPid: 2_000_000_001,
    childPid: 2_000_000_002,
    startedAt: runningTask.startedAt,
    quiescedAt: 20,
    stdoutBytes: 0,
    stderrBytes: 0,
    preparedResultDigest: settlement.preparedResultDigest,
    preparedResultBytes: fixture.prepared.values.get(runningTask.taskId)!.byteLength,
  };
  const receipt = { ...unsigned, receiptDigest: digest(JSON.stringify(unsigned)) };
  expect(await fixture.coordinator.settleFinalReceipt(receipt)).toMatchObject({ outcome: 'committed' });
  tasks.settleArtifacts(runningTask.taskId, { artifacts: [], warnings: [] }, 20);
  const task = tasks.commitTerminal(runningTask.taskId, receipt, 20);
  const admissions = new Map<TurnId, ToolTaskDeliveryAdmission>();
  let completionCalls = 0;
  const taskService = new ToolTaskService(tasks, '/unused', undefined, () => 40);
  taskServices.push(taskService);
  taskService.bindHost({
    ownerExists: (threadId) => threadId === OWNER_ID,
    readDeliveryAdmission: async (_threadId, turnId) => admissions.get(turnId) ?? null,
    startCompletionTurn: async () => { completionCalls += 1; return false; },
    taskChanged: () => {},
    beforeStop: async (stoppingTask, sourceTurnId) => {
      if (stoppingTask.producer !== 'delegate') return;
      if (!sourceTurnId) throw new Error('Delegated Stop requires its source Turn');
      await fixture.coordinator.fenceUserStop({
        taskId: stoppingTask.taskId,
        ownerThreadId: stoppingTask.ownerThreadId,
        stoppedByRootTurnId: sourceTurnId,
        currentRootIntentRevision: 1,
      });
    },
  });
  return { ...fixture, tasks, task, taskService, admissions, completionCalls: () => completionCalls };
}

function createStoredSession(
  store: DelegationSessionStore,
  sessionId: ThreadId,
  now: number,
): DelegationSessionBinding {
  return store.createSession({
    sessionId,
    ownerThreadId: OWNER_ID,
    policy: storedPolicy(),
    now,
  });
}

function storedPolicy(): DelegationPolicySnapshot {
  return {
    runnerId: 'internal',
    runnerVersion: '1',
    modelProvider: 'openai',
    modelId: 'gpt-test',
    effort: 'medium',
    profile: 'explore',
    access: 'read-only',
    capabilityCeilingDigest: digest('ceiling'),
    schedulingPolicyDigest: digest('scheduling'),
    configurationRevision: 'configuration-1',
    cwd: '/workspace',
    worktreePolicy: 'none',
  };
}

function runExecution(capabilityId: string, taskId: string): DelegateCapabilityExecution {
  return execution({
    capabilityId,
    taskId,
    command: parseDelegateCommand(['run', '--input', '-', '--output', 'json']) as DelegateStateCommand,
    payload: {
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
  rootIntentRevision?: number;
}): DelegateCapabilityExecution {
  return execution({
    capabilityId: input.capabilityId,
    taskId: input.taskId,
    command: parseDelegateCommand([
      'send', '--session', SESSION_ID, '--input', '-', '--output', 'json',
    ]) as DelegateStateCommand,
    payload: { version: 1, message: input.message },
    session: {
      kind: 'send',
      sessionId: SESSION_ID,
      sessionRevision: input.sessionRevision,
      minimumResumeRevision: null,
    },
    rootIntentRevision: input.rootIntentRevision,
  });
}

function closeExecution(capabilityId: string, sessionRevision: number): DelegateCapabilityExecution {
  return execution({
    capabilityId,
    taskId: `task-${capabilityId}`,
    command: parseDelegateCommand([
      'close', '--session', SESSION_ID, '--output', 'json',
    ]) as DelegateStateCommand,
    payload: null,
    session: { kind: 'close', sessionId: SESSION_ID, sessionRevision },
  });
}

function execution(input: {
  capabilityId: string;
  taskId: string;
  command: DelegateStateCommand;
  payload: unknown;
  session: DelegateCapabilityExecution['admission']['session'];
  signal?: AbortSignal;
  rootIntentRevision?: number;
}): DelegateCapabilityExecution {
  return {
    capabilityId: input.capabilityId,
    signal: input.signal ?? new AbortController().signal,
    admission: {
      toolTaskId: input.taskId,
      toolTaskNonce: `nonce-${input.taskId}`,
      command: input.command,
      stdin: input.command.name === 'close' ? '' : JSON.stringify(input.payload),
      cwd: '/workspace',
      processSha256: digest('process'),
      source: {
        rootThreadId: OWNER_ID,
        sourceTurnId: ROOT_TURN_ID,
        sourceItemId: `item-${input.capabilityId}`,
        rootUserIntentRevision: input.rootIntentRevision ?? 1,
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
