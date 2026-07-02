import { describe, expect, test } from 'bun:test';
import {
  assertValidRunExecutionStatusTransition,
  assertValidRunObjectiveStatusTransition,
  isValidRunExecutionStatusTransition,
  isValidRunObjectiveStatusTransition,
} from '../../src/core/agentRunStateMachine';

describe('agent run state machine', () => {
  test('allows execution to resume from terminal through running only', () => {
    expect(isValidRunExecutionStatusTransition(undefined, 'running')).toBe(true);
    expect(isValidRunExecutionStatusTransition('running', 'completed')).toBe(true);
    expect(isValidRunExecutionStatusTransition('completed', 'running')).toBe(true);
    expect(isValidRunExecutionStatusTransition('running', 'failed')).toBe(true);

    expect(isValidRunExecutionStatusTransition('completed', 'failed')).toBe(false);
    expect(isValidRunExecutionStatusTransition('failed', 'cancelled')).toBe(false);
    expect(() => assertValidRunExecutionStatusTransition('completed', 'failed', 'run-1')).toThrow(
      'Invalid run execution status transition for run-1: completed -> failed',
    );
  });

  test('allows objective reopening but rejects direct verified-to-blocked regression', () => {
    expect(isValidRunObjectiveStatusTransition(undefined, 'active')).toBe(true);
    expect(isValidRunObjectiveStatusTransition('active', 'verifying')).toBe(true);
    expect(isValidRunObjectiveStatusTransition('verifying', 'verified')).toBe(true);
    expect(isValidRunObjectiveStatusTransition('verified', 'active')).toBe(true);
    expect(isValidRunObjectiveStatusTransition('blocked', 'active')).toBe(true);
    expect(isValidRunObjectiveStatusTransition('stopped', 'active')).toBe(true);

    expect(isValidRunObjectiveStatusTransition('verified', 'blocked')).toBe(false);
    expect(() => assertValidRunObjectiveStatusTransition('verified', 'blocked', 'run-2')).toThrow(
      'Invalid run objective status transition for run-2: verified -> blocked',
    );
  });
});
