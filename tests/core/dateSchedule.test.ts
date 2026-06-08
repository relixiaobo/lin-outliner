import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  describeDateSchedule,
  formatDateRecurrenceRule,
  formatDateSchedule,
  mostRecentDateScheduleDue,
  parseDateRecurrenceRule,
  parseDateSchedule,
  shouldFireDateSchedule,
} from '../../src/core/dateSchedule';
import { isoLocalDateTime } from '../../src/core/localDate';

describe('date schedules', () => {
  test('parses and formats one-off and recurring schedules', () => {
    expect(parseDateSchedule('2026-05-20T09:30')).toEqual({ anchor: '2026-05-20T09:30' });
    expect(parseDateSchedule(' 2026-05-20T09:30 rrule:freq=weekly;byday=we,mo;interval=2;until=2026-12-31 ')).toEqual({
      anchor: '2026-05-20T09:30',
      recurrence: {
        frequency: 'weekly',
        interval: 2,
        byDay: ['MO', 'WE'],
        until: '2026-12-31',
      },
    });
    expect(formatDateSchedule({
      anchor: '2026-05-20T09:30',
      recurrence: { frequency: 'weekly', interval: 2, byDay: ['MO', 'WE'], until: '2026-12-31' },
    })).toBe('2026-05-20T09:30 RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=2026-12-31');
    expect(formatDateRecurrenceRule({ frequency: 'daily', interval: 1 })).toBe('FREQ=DAILY');
  });

  test('rejects unsupported or ambiguous schedule grammar', () => {
    expect(parseDateSchedule('2026-05-20/2026-05-21 RRULE:FREQ=DAILY')).toBeNull();
    expect(parseDateSchedule('2026-05-20 RRULE:FREQ=HOURLY')).toBeNull();
    expect(parseDateSchedule('2026-05-20 RRULE:FREQ=DAILY;BYDAY=MO')).toBeNull();
    expect(parseDateSchedule('2026-05-20 RRULE:FREQ=WEEKLY;BYDAY=MO,MO')).toBeNull();
    expect(parseDateSchedule('2026-05-20 RRULE:FREQ=WEEKLY;COUNT=3')).toBeNull();
    expect(parseDateRecurrenceRule('FREQ=DAILY;INTERVAL=0')).toBeNull();
    expect(parseDateRecurrenceRule('FREQ=DAILY;INTERVAL=1E1')).toBeNull();
    expect(parseDateRecurrenceRule('FREQ=DAILY;INTERVAL=0X2')).toBeNull();
    expect(parseDateRecurrenceRule('FREQ=DAILY;INTERVAL=+2')).toBeNull();
  });

  test('fires a one-off schedule once after its anchor', () => {
    const schedule = '2026-05-20T09:30';
    expect(mostRecentDateScheduleDue(schedule, localDate(2026, 5, 20, 9, 29))).toBeNull();
    expect(formatDue(schedule, localDate(2026, 5, 20, 9, 30))).toBe('2026-05-20T09:30');
    expect(shouldFireDateSchedule(schedule, localDate(2026, 5, 20, 10), null)).toMatchObject({
      shouldFire: true,
      reason: 'due',
    });
    expect(shouldFireDateSchedule(schedule, localDate(2026, 5, 20, 10), localDate(2026, 5, 20, 9, 30))).toMatchObject({
      shouldFire: false,
      reason: 'already_fired',
    });
  });

  test('coalesces daily catch-up to the most recent due occurrence', () => {
    const schedule = '2026-05-20T09:00 RRULE:FREQ=DAILY';
    expect(formatDue(schedule, localDate(2026, 5, 23, 12))).toBe('2026-05-23T09:00');
    expect(shouldFireDateSchedule(schedule, localDate(2026, 5, 23, 12), localDate(2026, 5, 22, 9))).toMatchObject({
      shouldFire: true,
      reason: 'due',
    });
    expect(shouldFireDateSchedule(schedule, localDate(2026, 5, 23, 12), localDate(2026, 5, 23, 9))).toMatchObject({
      shouldFire: false,
      reason: 'already_fired',
    });
  });

  test('computes weekly recurrence by eligible week and day set', () => {
    const schedule = '2026-05-20T09:00 RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR';
    expect(formatDue(schedule, localDate(2026, 5, 22, 12))).toBe('2026-05-22T09:00');
    expect(formatDue(schedule, localDate(2026, 5, 27, 12))).toBe('2026-05-22T09:00');
    expect(formatDue(schedule, localDate(2026, 6, 1, 12))).toBe('2026-06-01T09:00');
  });

  test('uses the anchor weekday when weekly BYDAY is omitted', () => {
    const schedule = '2026-05-20T09:00 RRULE:FREQ=WEEKLY';
    expect(formatDue(schedule, localDate(2026, 5, 27, 8))).toBe('2026-05-20T09:00');
    expect(formatDue(schedule, localDate(2026, 5, 27, 10))).toBe('2026-05-27T09:00');
  });

  test('skips invalid monthly and yearly calendar dates', () => {
    expect(formatDue('2026-01-31T09:00 RRULE:FREQ=MONTHLY', localDate(2026, 3, 1, 12))).toBe('2026-01-31T09:00');
    expect(formatDue('2026-01-31T09:00 RRULE:FREQ=MONTHLY', localDate(2026, 3, 31, 12))).toBe('2026-03-31T09:00');
    expect(formatDue('2024-02-29T09:00 RRULE:FREQ=YEARLY', localDate(2027, 3, 1, 12))).toBe('2024-02-29T09:00');
    expect(formatDue('2024-02-29T09:00 RRULE:FREQ=YEARLY', localDate(2028, 3, 1, 12))).toBe('2028-02-29T09:00');
  });

  test('keeps monthly occurrences that roll through a daylight-saving spring-forward gap', () => {
    const result = spawnSync(process.execPath, ['--eval', `
      import { mostRecentDateScheduleDue } from './src/core/dateSchedule.ts';
      import { isoLocalDateTime } from './src/core/localDate.ts';
      const due = mostRecentDateScheduleDue('2026-02-08T02:30 RRULE:FREQ=MONTHLY', new Date(2026, 2, 20, 12));
      process.stdout.write(due ? isoLocalDateTime(due) : 'null');
    `], {
      cwd: path.resolve(import.meta.dir, '../..'),
      encoding: 'utf8',
      env: { ...process.env, TZ: 'America/New_York' },
    });
    if (result.status !== 0) throw new Error(result.stderr || `DST regression subprocess exited with ${result.status}`);
    expect(result.stdout).toBe('2026-03-08T03:30');
  });

  test('honors inclusive UNTIL endpoints', () => {
    const schedule = '2026-05-20T09:00 RRULE:FREQ=DAILY;UNTIL=2026-05-22';
    expect(formatDue(schedule, localDate(2026, 5, 23, 12))).toBe('2026-05-22T09:00');
    expect(shouldFireDateSchedule(schedule, localDate(2026, 5, 23, 12), localDate(2026, 5, 22, 9))).toMatchObject({
      shouldFire: false,
      reason: 'already_fired',
    });
  });
});

function formatDue(schedule: string, now: Date): string | null {
  const due = mostRecentDateScheduleDue(schedule, now);
  return due ? isoLocalDateTime(due) : null;
}

function localDate(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute);
}

describe('describeDateSchedule', () => {
  test('one-off shows the date (and time when present)', () => {
    expect(describeDateSchedule('2026-06-09T09:00')).toBe('2026-06-09 09:00');
    expect(describeDateSchedule('2026-06-09')).toBe('2026-06-09');
  });

  test('recurrence presets read in human terms', () => {
    expect(describeDateSchedule('2026-06-09T09:00 RRULE:FREQ=DAILY')).toBe('Every day at 09:00');
    expect(describeDateSchedule('2026-06-09T09:00 RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'))
      .toBe('Every weekday at 09:00');
    expect(describeDateSchedule('2026-06-09T09:00 RRULE:FREQ=WEEKLY;BYDAY=MO,WE'))
      .toBe('Every week on Mon, Wed at 09:00');
    expect(describeDateSchedule('2026-06-09T09:00 RRULE:FREQ=WEEKLY;INTERVAL=2'))
      .toBe('Every 2 weeks at 09:00');
  });

  test('monthly with an end date', () => {
    expect(describeDateSchedule('2026-06-09T09:00 RRULE:FREQ=MONTHLY;UNTIL=2026-12-31'))
      .toBe('Every month at 09:00 · until 2026-12-31');
  });

  test('returns empty string for an unparseable schedule', () => {
    expect(describeDateSchedule('not-a-date')).toBe('');
  });
});
