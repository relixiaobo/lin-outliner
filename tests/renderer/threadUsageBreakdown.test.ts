import { describe, expect, test } from 'bun:test';
import { formatCachedShare } from '../../src/renderer/agent/components/ThreadUsageBreakdown';

describe('Thread usage cached share', () => {
  test('shows zero percent when input has no cache hit', () => {
    expect(formatCachedShare(10_845, 0, 0)).toBe('0%');
  });

  test('uses the complete input context as the denominator', () => {
    expect(formatCachedShare(120, 32, 0)).toBe('21%');
    expect(formatCachedShare(0, 100, 0)).toBe('100%');
  });

  test('shows an unavailable marker when there is no input context', () => {
    expect(formatCachedShare(0, 0, 0)).toBe('-');
  });
});
