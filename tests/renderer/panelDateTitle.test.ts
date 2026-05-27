import { describe, expect, test } from 'bun:test';
import { formatDayNodeTitle } from '../../src/renderer/ui/NodePanel';

describe('formatDayNodeTitle', () => {
  const now = new Date(2025, 4, 27); // Tue, May 27 2025 (local)

  test('prefixes the day name with a relative name for the adjacent days', () => {
    expect(formatDayNodeTitle('2025-05-27', now)).toBe('Today, Tue, May 27');
    expect(formatDayNodeTitle('2025-05-28', now)).toBe('Tomorrow, Wed, May 28');
    expect(formatDayNodeTitle('2025-05-26', now)).toBe('Yesterday, Mon, May 26');
  });

  test('formats other dates as "Ddd, Mmm D" with no prefix', () => {
    expect(formatDayNodeTitle('2025-05-30', now)).toBe('Fri, May 30');
    expect(formatDayNodeTitle('2025-06-01', now)).toBe('Sun, Jun 1');
    expect(formatDayNodeTitle('2024-12-25', now)).toBe('Wed, Dec 25');
  });

  test('crosses month and year boundaries relative to now', () => {
    // Day before "now" that is also the previous month.
    expect(formatDayNodeTitle('2025-04-30', new Date(2025, 4, 1))).toBe('Yesterday, Wed, Apr 30');
    // Day after a year-end "now".
    expect(formatDayNodeTitle('2026-01-01', new Date(2025, 11, 31))).toBe('Tomorrow, Thu, Jan 1');
  });
});
