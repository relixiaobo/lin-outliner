import { describe, expect, test } from 'bun:test';
import {
  buildCalendarMonthDays,
  shiftedCalendarMonth,
} from '../../src/renderer/ui/primitives/CalendarMonthGrid';

describe('calendar month grid', () => {
  test('builds a six-week Monday-start month grid', () => {
    const days = buildCalendarMonthDays(2026, 4);

    expect(days).toHaveLength(42);
    expect(days[0]?.isoDate).toBe('2026-04-27');
    expect(days[4]?.isoDate).toBe('2026-05-01');
    expect(days[4]?.inMonth).toBe(true);
    expect(days[41]?.isoDate).toBe('2026-06-07');
    expect(days[41]?.inMonth).toBe(false);
  });

  test('shifts displayed months across year boundaries', () => {
    expect(shiftedCalendarMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
    expect(shiftedCalendarMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
  });
});
