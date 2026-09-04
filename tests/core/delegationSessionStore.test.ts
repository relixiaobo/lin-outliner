import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ThreadId, TurnId } from '../../src/core/agent/protocol';
import {
  DelegationSessionStore,
  EMPTY_DELEGATION_MESSAGE_SEQUENCE_DIGEST,
  type DelegationPolicySnapshot,
} from '../../src/main/agent/delegation';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';

const OWNER_ID = '00000000-0000-7000-8000-000000000001' as ThreadId;
const OTHER_OWNER_ID = '00000000-0000-7000-8000-000000000002' as ThreadId;
const SESSION_ID = '00000000-0000-7000-8000-000000000010' as ThreadId;
const SESSION_TWO_ID = '00000000-0000-7000-8000-000000000020' as ThreadId;
const ROOT_TURN_ID = '00000000-0000-7000-8000-000000000030' as TurnId;
const ROOT_TURN_TWO_ID = '00000000-0000-7000-8000-000000000031' as TurnId;
const DELEGATED_TURN_ID = '00000000-0000-7000-8000-000000000040' as TurnId;
const DELEGATED_TURN_TWO_ID = '00000000-0000-7000-8000-000000000041' as TurnId;
const REQUEST_DIGEST = digest('request');
const PREPARED_DIGEST = digest('prepared');
const RECEIPT_DIGEST = digest('receipt');

const databases: Database[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close(false);
  await Promise.allSettled(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DelegationSessionStore', () => {
  test('keeps Session identity idempotent and exposes only open or closed state', () => {
    const { store } = fixture();
    const created = createSession(store, SESSION_ID, 10);
    expect(created).toMatchObject({
      sessionId: SESSION_ID,
      ownerThreadId: OWNER_ID,
      state: 'open',
      revision: 1,
      currentTaskId: null,
      previousTaskId: null,
      messageSequence: 0,
    });
    expect(createSession(store, SESSION_ID, 20)).toEqual(created);
    expect(() => store.createSession({
      sessionId: SESSION_ID,
      ownerThreadId: OTHER_OWNER_ID,
      policy: policy(),
      now: 20,
    })).toThrow('identity conflict');

    const closed = store.closeSession(SESSION_ID, 1, 30);
    expect(closed).toMatchObject({ state: 'closed', revision: 2, closedAt: 30 });
    expect(store.closeSession(SESSION_ID, 1, 40)).toEqual(closed);
    expect(() => store.appendMessage(messageInput(SESSION_ID, 2, 'message-one', 'after close', 50)))
      .toThrow('is closed');
  });

  test('allows at most one active execution and keeps settlement progress separate from task release', () => {
    const { store } = fixture();
    createSession(store, SESSION_ID, 10);

    const first = reserve(store, {
      sessionId: SESSION_ID,
      expectedRevision: 1,
      settlementId: 'settlement-one',
      turnId: DELEGATED_TURN_ID,
      taskId: 'task-one',
      now: 20,
    });
    expect(first.state).toBe('awaiting_result');
    expect(store.readSession(SESSION_ID)).toMatchObject({ revision: 2, currentTaskId: 'task-one' });
    expect(reserve(store, {
      sessionId: SESSION_ID,
      expectedRevision: 1,
      settlementId: 'settlement-one',
      turnId: DELEGATED_TURN_ID,
      taskId: 'task-one',
      now: 21,
    })).toEqual(first);
    expect(() => reserve(store, {
      sessionId: SESSION_ID,
      expectedRevision: 2,
      settlementId: 'settlement-two',
      turnId: DELEGATED_TURN_TWO_ID,
      taskId: 'task-two',
      now: 22,
    })).toThrow('already has an active execution');

    expect(store.prepareSettlement({
      settlementId: 'settlement-one', requestDigest: REQUEST_DIGEST, preparedResultDigest: PREPARED_DIGEST, now: 30,
    }).state)
      .toBe('prepared');
    expect(store.commitSettlementContext({
      settlementId: 'settlement-one',
      turnId: DELEGATED_TURN_ID,
      requestDigest: REQUEST_DIGEST,
      messageSequenceDigest: EMPTY_DELEGATION_MESSAGE_SEQUENCE_DIGEST,
      preparedResultDigest: PREPARED_DIGEST,
      now: 40,
    }).state).toBe('context_committed');
    expect(() => store.releaseExecution(SESSION_ID, 'task-one', 41))
      .toThrow('before settlement reconciliation');
    expect(store.recordFinalReceipt({
      settlementId: 'settlement-one', taskId: 'task-one', preparedResultDigest: PREPARED_DIGEST,
      finalReceiptDigest: RECEIPT_DIGEST, now: 50,
    }))
      .toMatchObject({ state: 'context_committed', finalReceiptDigest: RECEIPT_DIGEST });
    expect(store.commitSettlement({
      settlementId: 'settlement-one', taskId: 'task-one', preparedResultDigest: PREPARED_DIGEST,
      finalReceiptDigest: RECEIPT_DIGEST, now: 60,
    }).state)
      .toBe('committed');
    expect(store.readSession(SESSION_ID)?.currentTaskId).toBe('task-one');

    const released = store.releaseExecution(SESSION_ID, 'task-one', 70);
    expect(released).toMatchObject({ currentTaskId: null, previousTaskId: 'task-one' });
    expect(store.releaseExecution(SESSION_ID, 'task-one', 80)).toEqual(released);
    expect(reserve(store, {
      sessionId: SESSION_ID,
      expectedRevision: released.revision,
      settlementId: 'settlement-two',
      turnId: DELEGATED_TURN_TWO_ID,
      taskId: 'task-two',
      now: 90,
    }).state).toBe('awaiting_result');
  });

  test('assigns monotonic message sequences and commits an immutable digest prefix once', () => {
    const { store } = fixture();
    createSession(store, SESSION_ID, 10);
    const firstInput = messageInput(SESSION_ID, 1, 'message-one', 'Inspect the first race.', 20);
    const first = store.appendMessage(firstInput);
    expect(first).toMatchObject({ sequence: 1, state: 'queued', text: 'Inspect the first race.' });
    expect(store.appendMessage(firstInput)).toEqual(first);
    expect(() => store.appendMessage({ ...firstInput, text: 'Changed replay.' }))
      .toThrow('identity conflict');

    const second = store.appendMessage(messageInput(SESSION_ID, 2, 'message-two', 'Then inspect recovery.', 30));
    expect(second.sequence).toBe(2);
    expect(second.prefixDigest).not.toBe(first.prefixDigest);
    expect(store.messageSequenceDigest(SESSION_ID, 0)).toBe(EMPTY_DELEGATION_MESSAGE_SEQUENCE_DIGEST);
    expect(store.messageSequenceDigest(SESSION_ID)).toBe(second.prefixDigest);

    const committed = store.commitMessagePrefix(SESSION_ID, 3, 2, DELEGATED_TURN_ID, 40);
    expect(committed).toHaveLength(2);
    expect(committed.every((message) => message.state === 'committed' && message.text === null)).toBe(true);
    expect(store.commitMessagePrefix(SESSION_ID, 3, 2, DELEGATED_TURN_ID, 50)).toEqual(committed);

    const third = store.appendMessage(messageInput(SESSION_ID, 4, 'message-three', 'Continue in another Turn.', 60));
    expect(store.commitMessagePrefix(SESSION_ID, 5, 3, DELEGATED_TURN_TWO_ID, 70))
      .toEqual([{
        ...third,
        text: null,
        state: 'committed',
        deliveryTurnId: DELEGATED_TURN_TWO_ID,
        updatedAt: 70,
      }]);
  });

  test('blocks only the settlement whose prepared, context, or receipt evidence mismatches', () => {
    const { store } = fixture();
    const cases = [
      { sessionId: SESSION_ID, suffix: 'prepared', turnId: DELEGATED_TURN_ID },
      { sessionId: SESSION_TWO_ID, suffix: 'context', turnId: DELEGATED_TURN_TWO_ID },
      {
        sessionId: '00000000-0000-7000-8000-000000000021' as ThreadId,
        suffix: 'receipt',
        turnId: '00000000-0000-7000-8000-000000000042' as TurnId,
      },
      {
        sessionId: '00000000-0000-7000-8000-000000000022' as ThreadId,
        suffix: 'healthy',
        turnId: '00000000-0000-7000-8000-000000000043' as TurnId,
      },
    ] as const;
    for (const entry of cases) {
      createSession(store, entry.sessionId, 10);
      reserve(store, {
        sessionId: entry.sessionId,
        expectedRevision: 1,
        settlementId: `settlement-${entry.suffix}`,
        turnId: entry.turnId,
        taskId: `task-${entry.suffix}`,
        now: 20,
      });
    }

    expect(store.prepareSettlement({
      settlementId: 'settlement-prepared', requestDigest: digest('wrong request'),
      preparedResultDigest: PREPARED_DIGEST, now: 30,
    }))
      .toMatchObject({ state: 'blocked', blockedReason: expect.stringContaining('request digest mismatch') });

    store.prepareSettlement({
      settlementId: 'settlement-context', requestDigest: REQUEST_DIGEST,
      preparedResultDigest: PREPARED_DIGEST, now: 30,
    });
    expect(store.commitSettlementContext({
      settlementId: 'settlement-context',
      turnId: DELEGATED_TURN_TWO_ID,
      requestDigest: REQUEST_DIGEST,
      messageSequenceDigest: EMPTY_DELEGATION_MESSAGE_SEQUENCE_DIGEST,
      preparedResultDigest: digest('wrong prepared'),
      now: 40,
    })).toMatchObject({ state: 'blocked', blockedReason: expect.stringContaining('prepared result digest mismatch') });

    store.prepareSettlement({
      settlementId: 'settlement-receipt', requestDigest: REQUEST_DIGEST,
      preparedResultDigest: PREPARED_DIGEST, now: 30,
    });
    expect(store.recordFinalReceipt({
      settlementId: 'settlement-receipt', taskId: 'task-receipt',
      preparedResultDigest: digest('wrong prepared'), finalReceiptDigest: RECEIPT_DIGEST, now: 40,
    }))
      .toMatchObject({ state: 'blocked', blockedReason: expect.stringContaining('prepared result digest mismatch') });

    store.prepareSettlement({
      settlementId: 'settlement-healthy', requestDigest: REQUEST_DIGEST,
      preparedResultDigest: PREPARED_DIGEST, now: 30,
    });
    expect(store.commitSettlementContext({
      settlementId: 'settlement-healthy',
      turnId: cases[3].turnId,
      requestDigest: REQUEST_DIGEST,
      messageSequenceDigest: EMPTY_DELEGATION_MESSAGE_SEQUENCE_DIGEST,
      preparedResultDigest: PREPARED_DIGEST,
      now: 40,
    }).state).toBe('context_committed');
    expect(store.recordFinalReceipt({
      settlementId: 'settlement-healthy', taskId: 'task-healthy', preparedResultDigest: PREPARED_DIGEST,
      finalReceiptDigest: RECEIPT_DIGEST, now: 50,
    }).state)
      .toBe('context_committed');
    expect(store.commitSettlement({
      settlementId: 'settlement-healthy', taskId: 'task-healthy', preparedResultDigest: PREPARED_DIGEST,
      finalReceiptDigest: RECEIPT_DIGEST, now: 60,
    }).state)
      .toBe('committed');
    expect(store.unsettledSettlements()).toHaveLength(0);
    expect(store.activeSettlements()).toHaveLength(4);

    const blockedSession = store.releaseExecution(SESSION_ID, 'task-prepared', 70);
    expect(() => reserve(store, {
      sessionId: SESSION_ID,
      expectedRevision: blockedSession.revision,
      settlementId: 'settlement-after-block',
      turnId: '00000000-0000-7000-8000-000000000044' as TurnId,
      taskId: 'task-after-block',
      now: 80,
    })).toThrow('has a blocked settlement');
  });

  test('blocks only the existing settlement when a Turn or Tool Task identity is rebound', () => {
    const { store } = fixture();
    createSession(store, SESSION_ID, 10);
    reserve(store, {
      sessionId: SESSION_ID,
      expectedRevision: 1,
      settlementId: 'settlement-one',
      turnId: DELEGATED_TURN_ID,
      taskId: 'task-one',
      now: 20,
    });

    expect(reserve(store, {
      sessionId: SESSION_ID,
      expectedRevision: 2,
      settlementId: 'settlement-two',
      turnId: DELEGATED_TURN_ID,
      taskId: 'task-one',
      now: 30,
    })).toMatchObject({
      settlementId: 'settlement-one',
      state: 'blocked',
      blockedReason: expect.stringContaining('identity'),
    });
    expect(store.readSettlement('settlement-two')).toBeNull();
  });

  test('persists a user-stop fence before release and clears it only with fresh root intent', () => {
    const { store } = fixture();
    createSession(store, SESSION_ID, 10);
    reserve(store, {
      sessionId: SESSION_ID,
      expectedRevision: 1,
      settlementId: 'settlement-one',
      turnId: DELEGATED_TURN_ID,
      taskId: 'task-one',
      now: 20,
    });
    const fenced = store.fenceUserStop({
      sessionId: SESSION_ID,
      expectedRevision: 2,
      cancelledTaskId: 'task-one',
      stoppedByRootTurnId: ROOT_TURN_ID,
      currentRootIntentRevision: 5,
      now: 30,
    });
    expect(fenced.stopFence).toMatchObject({ minimumResumeRevision: 6, cancelledTaskId: 'task-one' });

    store.prepareSettlement({
      settlementId: 'settlement-one', requestDigest: REQUEST_DIGEST,
      preparedResultDigest: PREPARED_DIGEST, now: 40,
    });
    store.commitSettlementContext({
      settlementId: 'settlement-one',
      turnId: DELEGATED_TURN_ID,
      requestDigest: REQUEST_DIGEST,
      messageSequenceDigest: EMPTY_DELEGATION_MESSAGE_SEQUENCE_DIGEST,
      preparedResultDigest: PREPARED_DIGEST,
      now: 50,
    });
    store.recordFinalReceipt({
      settlementId: 'settlement-one', taskId: 'task-one', preparedResultDigest: PREPARED_DIGEST,
      finalReceiptDigest: RECEIPT_DIGEST, now: 60,
    });
    store.commitSettlement({
      settlementId: 'settlement-one', taskId: 'task-one', preparedResultDigest: PREPARED_DIGEST,
      finalReceiptDigest: RECEIPT_DIGEST, now: 70,
    });
    const released = store.releaseExecution(SESSION_ID, 'task-one', 80);

    expect(() => store.clearUserStopFence({
      sessionId: SESSION_ID,
      expectedRevision: released.revision,
      rootTurnId: ROOT_TURN_TWO_ID,
      rootIntentRevision: null,
      now: 90,
    })).toThrow('fresh renderer-authored root request');
    expect(() => store.clearUserStopFence({
      sessionId: SESSION_ID,
      expectedRevision: released.revision,
      rootTurnId: ROOT_TURN_TWO_ID,
      rootIntentRevision: 5,
      now: 91,
    })).toThrow('fresh renderer-authored root request');

    const resumed = store.clearUserStopFence({
      sessionId: SESSION_ID,
      expectedRevision: released.revision,
      rootTurnId: ROOT_TURN_TWO_ID,
      rootIntentRevision: 6,
      now: 100,
    });
    expect(resumed).toMatchObject({
      stopFence: null,
      lastResume: { rootTurnId: ROOT_TURN_TWO_ID, rootIntentRevision: 6 },
    });
    expect(store.clearUserStopFence({
      sessionId: SESSION_ID,
      expectedRevision: released.revision,
      rootTurnId: ROOT_TURN_TWO_ID,
      rootIntentRevision: 6,
      now: 110,
    })).toEqual(resumed);
  });

  test('reopens without duplicating a Session, message, Turn, or Tool Task', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-delegation-store-'));
    roots.push(root);
    const databasePath = path.join(root, 'delegation.sqlite');
    const firstDatabase = new Database(databasePath, { create: true });
    const first = new DelegationSessionStore(firstDatabase as unknown as SqliteDatabase);
    createSession(first, SESSION_ID, 10);
    const message = first.appendMessage(messageInput(SESSION_ID, 1, 'message-one', 'Persist this exactly once.', 20));
    const settlement = reserve(first, {
      sessionId: SESSION_ID,
      expectedRevision: 2,
      settlementId: 'settlement-one',
      turnId: DELEGATED_TURN_ID,
      taskId: 'task-one',
      messageSequence: 1,
      messageSequenceDigest: message.prefixDigest,
      now: 30,
    });
    firstDatabase.close(false);

    const reopenedDatabase = new Database(databasePath);
    databases.push(reopenedDatabase);
    const reopened = new DelegationSessionStore(reopenedDatabase as unknown as SqliteDatabase);
    expect(createSession(reopened, SESSION_ID, 100).sessionId).toBe(SESSION_ID);
    expect(reopened.appendMessage(messageInput(SESSION_ID, 1, 'message-one', 'Persist this exactly once.', 100)))
      .toEqual(message);
    expect(reserve(reopened, {
      sessionId: SESSION_ID,
      expectedRevision: 2,
      settlementId: 'settlement-one',
      turnId: DELEGATED_TURN_ID,
      taskId: 'task-one',
      messageSequence: 1,
      messageSequenceDigest: message.prefixDigest,
      now: 100,
    })).toEqual(settlement);
    expect(reopened.sessionsForOwner(OWNER_ID)).toHaveLength(1);
    expect(reopened.messagesForSession(SESSION_ID)).toHaveLength(1);
    expect(reopened.settlementForTask('task-one')?.settlementId).toBe('settlement-one');
  });
});

function fixture(): { readonly database: Database; readonly store: DelegationSessionStore } {
  const database = new Database(':memory:');
  databases.push(database);
  return {
    database,
    store: new DelegationSessionStore(database as unknown as SqliteDatabase),
  };
}

function createSession(store: DelegationSessionStore, sessionId: ThreadId, now: number) {
  return store.createSession({ sessionId, ownerThreadId: OWNER_ID, policy: policy(), now });
}

function policy(): DelegationPolicySnapshot {
  return {
    runnerId: 'internal',
    runnerVersion: '1',
    modelProvider: 'openai',
    modelId: 'gpt-test',
    effort: 'medium',
    profile: 'general',
    access: 'read-only',
    capabilityCeilingDigest: digest('ceiling'),
    schedulingPolicyDigest: digest('scheduling'),
    configurationRevision: 'configuration-one',
    cwd: '/workspace',
    worktreePolicy: 'none',
  };
}

function messageInput(
  sessionId: ThreadId,
  expectedRevision: number,
  messageId: string,
  text: string,
  now: number,
) {
  return {
    sessionId,
    expectedRevision,
    messageId,
    text,
    sourceTaskId: `task-${messageId}`,
    sourceRootTurnId: ROOT_TURN_ID,
    sourceRootItemId: `item-${messageId}`,
    sourceRootIntentRevision: 1,
    now,
  } as const;
}

function reserve(store: DelegationSessionStore, input: {
  readonly sessionId: ThreadId;
  readonly expectedRevision: number;
  readonly settlementId: string;
  readonly turnId: TurnId;
  readonly taskId: string;
  readonly messageSequence?: number;
  readonly messageSequenceDigest?: string;
  readonly now: number;
}) {
  return store.reserveExecution({
    ...input,
    requestDigest: REQUEST_DIGEST,
    messageSequence: input.messageSequence ?? 0,
    messageSequenceDigest: input.messageSequenceDigest ?? EMPTY_DELEGATION_MESSAGE_SEQUENCE_DIGEST,
  });
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
