import { describe, expect, test } from 'bun:test';
import { THREAD_GOAL_STATUSES, type ThreadGoal } from '../../src/core/agent/goal';

describe('Codex Agent Core Goal contracts', () => {
  test('defines one Goal per Thread with the exact Codex lifecycle statuses', () => {
    expect(THREAD_GOAL_STATUSES).toEqual([
      'active',
      'paused',
      'blocked',
      'usageLimited',
      'budgetLimited',
      'complete',
    ]);
    const goal: ThreadGoal = {
      threadId: '018f0f24-7b2e-7a3f-8a4b-123456789abc',
      objective: 'Replace Agent Core',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 100,
      timeUsedSeconds: 20,
      createdAt: 1,
      updatedAt: 2,
    };
    expect(goal.threadId).toBeTruthy();
    expect(goal.status).toBe('active');
  });
});
