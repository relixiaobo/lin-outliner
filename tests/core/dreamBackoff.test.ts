import { describe, expect, test } from 'bun:test';
import {
  DREAM_FAILURE_BACKOFF_BASE_MS,
  DREAM_FAILURE_BACKOFF_CAP_MS,
  dreamFailureBackoffMs,
} from '../../src/main/dreamBackoff';

describe('dream failure backoff', () => {
  test('waits the base delay after the first failure', () => {
    expect(dreamFailureBackoffMs(1)).toBe(DREAM_FAILURE_BACKOFF_BASE_MS);
  });

  test('grows exponentially with consecutive failures', () => {
    expect(dreamFailureBackoffMs(2)).toBe(DREAM_FAILURE_BACKOFF_BASE_MS * 2);
    expect(dreamFailureBackoffMs(3)).toBe(DREAM_FAILURE_BACKOFF_BASE_MS * 4);
    // Strictly increasing up to (but not into) the cap, so a longer streak never retries sooner.
    for (let n = 2; n <= 7; n += 1) {
      expect(dreamFailureBackoffMs(n)).toBeGreaterThan(dreamFailureBackoffMs(n - 1));
    }
  });

  test('never exceeds the cap, even for a long failure streak', () => {
    expect(dreamFailureBackoffMs(100)).toBe(DREAM_FAILURE_BACKOFF_CAP_MS);
    expect(dreamFailureBackoffMs(1_000_000)).toBe(DREAM_FAILURE_BACKOFF_CAP_MS);
  });

  test('treats a non-positive count as the base delay (defensive)', () => {
    expect(dreamFailureBackoffMs(0)).toBe(DREAM_FAILURE_BACKOFF_BASE_MS);
    expect(dreamFailureBackoffMs(-5)).toBe(DREAM_FAILURE_BACKOFF_BASE_MS);
  });
});
