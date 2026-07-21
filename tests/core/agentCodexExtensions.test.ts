import { describe, expect, test } from 'bun:test';
import {
  createHostRootTurnAdmissionBarrierSnapshot,
  createThreadAdmissionBarrierSnapshot,
} from '../../src/core/agent/extensions';
import type { ThreadId } from '../../src/core/agent/protocol';

const THREAD_ID = '018f0f24-7b2e-7a3f-8a4b-123456789abc' as ThreadId;

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
});
