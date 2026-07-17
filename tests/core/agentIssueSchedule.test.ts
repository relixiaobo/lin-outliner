import { describe, expect, test } from 'bun:test';
import {
  formatRecurringIssueWindowDate,
  mostRecentRecurringIssueDueAtOrBefore,
  nextRecurringIssueDueAfter,
  recurringIssueMissedWindowMetadata,
  validateRecurringIssueSchedule,
} from '../../src/main/agentIssueSchedule';

describe('Agent Issue recurring schedules', () => {
  test('interprets daily cadence in its IANA time zone', () => {
    const cadence = { type: 'daily', time: '09:00' } as const;
    expect(nextRecurringIssueDueAfter(
      cadence,
      'Asia/Shanghai',
      Date.UTC(2026, 6, 7, 0, 30),
    )).toBe(Date.UTC(2026, 6, 7, 1));
    expect(mostRecentRecurringIssueDueAtOrBefore(
      cadence,
      'Asia/Shanghai',
      Date.UTC(2026, 6, 7, 1, 5),
      Date.UTC(2026, 6, 1),
    )).toBe(Date.UTC(2026, 6, 7, 1));
  });

  test('supports the Local compatibility alias and non-hour IANA offsets', () => {
    const cadence = { type: 'daily', time: '09:00' } as const;
    const after = Date.UTC(2026, 6, 7);
    const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    expect(nextRecurringIssueDueAfter(cadence, 'Local', after))
      .toBe(nextRecurringIssueDueAfter(cadence, localTimeZone, after));
    expect(nextRecurringIssueDueAfter(cadence, 'Asia/Kathmandu', after))
      .toBe(Date.UTC(2026, 6, 7, 3, 15));
  });

  test('keeps daily wall-clock time across a spring-forward transition', () => {
    const cadence = { type: 'daily', time: '09:00' } as const;
    const beforeTransition = Date.UTC(2026, 2, 7, 14);
    expect(nextRecurringIssueDueAfter(cadence, 'America/New_York', beforeTransition))
      .toBe(Date.UTC(2026, 2, 8, 13));
    expect(mostRecentRecurringIssueDueAtOrBefore(
      cadence,
      'America/New_York',
      Date.UTC(2026, 2, 9, 15),
      Date.UTC(2026, 2, 1),
    )).toBe(Date.UTC(2026, 2, 9, 13));
  });

  test('uses compatible DST disambiguation for missing and repeated times', () => {
    const gapCadence = { type: 'daily', time: '02:30' } as const;
    expect(nextRecurringIssueDueAfter(
      gapCadence,
      'America/New_York',
      Date.UTC(2026, 2, 8, 6),
    )).toBe(Date.UTC(2026, 2, 8, 7, 30));

    const overlapCadence = { type: 'daily', time: '01:30' } as const;
    const firstOccurrence = Date.UTC(2026, 10, 1, 5, 30);
    expect(nextRecurringIssueDueAfter(
      overlapCadence,
      'America/New_York',
      Date.UTC(2026, 10, 1, 4),
    )).toBe(firstOccurrence);
    expect(nextRecurringIssueDueAfter(overlapCadence, 'America/New_York', firstOccurrence))
      .toBe(Date.UTC(2026, 10, 2, 6, 30));
  });

  test('does not return a future daily due across a skipped calendar date', () => {
    const cadence = { type: 'daily', time: '09:00' } as const;
    const now = Date.UTC(2011, 11, 30, 18);
    const due = mostRecentRecurringIssueDueAtOrBefore(
      cadence,
      'Pacific/Apia',
      now,
      Date.UTC(2011, 11, 28),
    );

    expect(due).not.toBeNull();
    expect(due!).toBeLessThanOrEqual(now);
    expect(formatRecurringIssueWindowDate(due!, 'Pacific/Apia')).toBe('2011-12-29');
  });

  test('finds weekly occurrences by the target-zone weekday across DST', () => {
    const cadence = { type: 'weekly', weekdays: [1, 3], time: '09:00' } as const;
    expect(nextRecurringIssueDueAfter(
      cadence,
      'America/New_York',
      Date.UTC(2026, 2, 8, 16),
    )).toBe(Date.UTC(2026, 2, 9, 13));
    expect(mostRecentRecurringIssueDueAtOrBefore(
      cadence,
      'America/New_York',
      Date.UTC(2026, 2, 11, 14),
      Date.UTC(2026, 2, 1),
    )).toBe(Date.UTC(2026, 2, 11, 13));
  });

  test('skips invalid monthly dates and handles a monthly DST gap', () => {
    const monthEndCadence = { type: 'monthly', dayOfMonth: 31, time: '09:00' } as const;
    expect(nextRecurringIssueDueAfter(
      monthEndCadence,
      'Asia/Shanghai',
      Date.UTC(2026, 0, 31, 1),
    )).toBe(Date.UTC(2026, 2, 31, 1));

    const gapCadence = { type: 'monthly', dayOfMonth: 8, time: '02:30' } as const;
    expect(nextRecurringIssueDueAfter(
      gapCadence,
      'America/New_York',
      Date.UTC(2026, 1, 8, 8),
    )).toBe(Date.UTC(2026, 2, 8, 7, 30));
  });

  test('formats generated Issue dates in the recurring time zone', () => {
    const instant = Date.UTC(2026, 6, 7, 23);
    expect(formatRecurringIssueWindowDate(instant, 'Asia/Shanghai')).toBe('2026-07-08');
    expect(formatRecurringIssueWindowDate(instant, 'America/Los_Angeles')).toBe('2026-07-07');
  });

  test('produces coalesced metadata only for coalesce-latest', () => {
    const cadence = { type: 'daily', time: '18:00' } as const;
    const input = {
      cadence,
      timeZone: 'UTC',
      createdAt: Date.UTC(2026, 6, 7, 17),
      dueAt: Date.UTC(2026, 6, 10, 18),
      generatedWindowStarts: [] as number[],
      skippedWindowStarts: [] as number[],
    };
    expect(recurringIssueMissedWindowMetadata({
      ...input,
      missedPolicy: { type: 'coalesce-latest' },
    })).toEqual({
      skippedWindowCount: 3,
      activityParameter: 'coalesced:3',
    });
    expect(recurringIssueMissedWindowMetadata({
      ...input,
      missedPolicy: { type: 'skip-missed' },
    })).toEqual({});
  });

  test('does not coalesce generated or explicitly skipped windows', () => {
    const cadence = { type: 'daily', time: '18:00' } as const;
    const july7 = Date.UTC(2026, 6, 7, 18);
    const july8 = Date.UTC(2026, 6, 8, 18);
    expect(recurringIssueMissedWindowMetadata({
      cadence,
      timeZone: 'UTC',
      missedPolicy: { type: 'coalesce-latest' },
      createdAt: Date.UTC(2026, 6, 7, 17),
      dueAt: Date.UTC(2026, 6, 10, 18),
      generatedWindowStarts: [july7],
      skippedWindowStarts: [july8],
    })).toEqual({
      skippedWindowCount: 1,
      activityParameter: 'coalesced:1',
    });
  });

  test('rejects invalid cadence shapes, times, and IANA zones', () => {
    expect(validateRecurringIssueSchedule(
      { type: 'daily', time: '9:00' },
      'Not/A_Time_Zone',
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid_cadence_time', path: 'cadence.time' }),
      expect.objectContaining({ code: 'invalid_time_zone', path: 'timeZone' }),
    ]));
    expect(validateRecurringIssueSchedule(
      { type: 'weekly', weekdays: [], time: '09:00' },
      'UTC',
    )).toEqual([
      expect.objectContaining({ code: 'invalid_weekdays', path: 'cadence.weekdays' }),
    ]);
    expect(validateRecurringIssueSchedule(
      { type: 'daily', time: '09:00', weekdays: [1] } as never,
      'UTC',
    )).toEqual([
      expect.objectContaining({ code: 'invalid_cadence', path: 'cadence' }),
    ]);
    expect(validateRecurringIssueSchedule(
      { type: 'monthly', dayOfMonth: 32, time: '09:00' },
      'UTC',
    )).toEqual([
      expect.objectContaining({ code: 'invalid_day_of_month', path: 'cadence.dayOfMonth' }),
    ]);
    expect(nextRecurringIssueDueAfter(
      { type: 'daily', time: '25:00' },
      'UTC',
      Date.UTC(2026, 0, 1),
    )).toBeNull();
    expect(nextRecurringIssueDueAfter(
      { type: 'daily', time: '09:00' },
      'Not/A_Time_Zone',
      Date.UTC(2026, 0, 1),
    )).toBeNull();
  });
});
