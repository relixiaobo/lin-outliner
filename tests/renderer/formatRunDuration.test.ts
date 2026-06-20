import { describe, expect, test } from 'bun:test';
import { formatRunDuration } from '../../src/renderer/ui/agent/agentProcessTypes';

describe('formatRunDuration', () => {
  test('sub-second is "<1s" (the live divider shows bare "Working" before this)', () => {
    expect(formatRunDuration(0)).toBe('<1s');
    expect(formatRunDuration(999)).toBe('<1s');
  });

  test('seconds below a minute', () => {
    expect(formatRunDuration(1_000)).toBe('1s');
    expect(formatRunDuration(9_000)).toBe('9s');
    expect(formatRunDuration(59_000)).toBe('59s');
  });

  test('minute boundary trims a zero seconds unit', () => {
    expect(formatRunDuration(60_000)).toBe('1m');
    expect(formatRunDuration(63_000)).toBe('1m 3s');
    expect(formatRunDuration(90_000)).toBe('1m 30s');
  });

  test('hour boundary keeps every non-zero unit and trims zeros', () => {
    expect(formatRunDuration(3_600_000)).toBe('1h');
    expect(formatRunDuration(3_661_000)).toBe('1h 1m 1s');
    expect(formatRunDuration(3_903_000)).toBe('1h 5m 3s');
  });

  test('rolls up through days', () => {
    expect(formatRunDuration(86_400_000)).toBe('1d');
    // 2d 3h exactly — interior zero units (m, s) are trimmed.
    expect(formatRunDuration((2 * 86_400 + 3 * 3_600) * 1_000)).toBe('2d 3h');
  });

  test('clamps non-finite / negative input', () => {
    expect(formatRunDuration(Number.NaN)).toBe('<1s');
    expect(formatRunDuration(-5_000)).toBe('<1s');
  });
});
