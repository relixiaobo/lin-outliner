import { describe, expect, test } from 'bun:test';
import {
  createHostRootTurnAdmissionBarrierSnapshot,
  createThreadHistoryRollbackContext,
  createThreadAdmissionBarrierSnapshot,
} from '../../src/core/agent/extensions';
import type { ThreadId, TurnId } from '../../src/core/agent/protocol';

const THREAD_ID = '018f0f24-7b2e-7a3f-8a4b-123456789abc' as ThreadId;
const TURN_ID = '018f0f24-7b2e-7a3f-8a4b-123456789abd' as TurnId;
const SECOND_TURN_ID = '018f0f24-7b2e-7a3f-8a4b-123456789abe' as TurnId;

describe('Codex Agent Core extension contract', () => {
  test('creates immutable per-Thread admission barrier snapshots', () => {
    const snapshot = createThreadAdmissionBarrierSnapshot(THREAD_ID, 3);
    expect(snapshot).toEqual({ kind: 'thread', threadId: THREAD_ID, generation: 3 });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => createThreadAdmissionBarrierSnapshot('' as ThreadId, 0)).toThrow('threadId must be non-empty');
    expect(() => createThreadAdmissionBarrierSnapshot(THREAD_ID, -1)).toThrow('non-negative safe integer');
  });

  test('creates immutable host-wide root-Turn admission barrier snapshots', () => {
    const snapshot = createHostRootTurnAdmissionBarrierSnapshot(7);
    expect(snapshot).toEqual({ kind: 'hostRootTurns', generation: 7 });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => createHostRootTurnAdmissionBarrierSnapshot(1.5)).toThrow('non-negative safe integer');
    expect(() => createHostRootTurnAdmissionBarrierSnapshot(Number.MAX_SAFE_INTEGER + 1))
      .toThrow('non-negative safe integer');
  });

  test('creates immutable Thread-history rollback contexts', () => {
    const omittedTurnIds = [TURN_ID, SECOND_TURN_ID];
    const context = createThreadHistoryRollbackContext(
      '018f0f24-7b2e-7a3f-8a4b-123456789abf',
      THREAD_ID,
      omittedTurnIds,
      8,
      9,
    );

    omittedTurnIds.pop();
    expect(context).toEqual({
      rollbackId: '018f0f24-7b2e-7a3f-8a4b-123456789abf',
      threadId: THREAD_ID,
      omittedTurnIds: [TURN_ID, SECOND_TURN_ID],
      beforeProjectionVersion: 8,
      afterProjectionVersion: 9,
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.omittedTurnIds)).toBe(true);
  });

  test('rejects ambiguous Thread-history rollback contexts', () => {
    expect(() => createThreadHistoryRollbackContext('', THREAD_ID, [TURN_ID], 8, 9))
      .toThrow('rollbackId must be non-empty');
    expect(() => createThreadHistoryRollbackContext('rollback', THREAD_ID, [], 8, 9))
      .toThrow('omittedTurnIds must not be empty');
    expect(() => createThreadHistoryRollbackContext('rollback', THREAD_ID, [TURN_ID, TURN_ID], 8, 9))
      .toThrow('omittedTurnIds must not contain duplicates');
    expect(() => createThreadHistoryRollbackContext('rollback', THREAD_ID, [TURN_ID], -1, 9))
      .toThrow('beforeProjectionVersion must be a non-negative safe integer');
    expect(() => createThreadHistoryRollbackContext('rollback', THREAD_ID, [TURN_ID], 9, 9))
      .toThrow('afterProjectionVersion must be greater than beforeProjectionVersion');
  });
});
