import { describe, expect, test } from 'bun:test';
import {
  dateFieldValueRangesInText,
  formatDateFieldInput,
  normalizeDateFieldValue,
  parseDateFieldValue,
  parseDateFieldValueRange,
} from '../../src/core/dateFieldValue';

describe('date field values', () => {
  test('parses and normalizes single dates and date ranges', () => {
    expect(parseDateFieldValue('2026-05-20')).toEqual({ kind: 'single', date: '2026-05-20' });
    expect(parseDateFieldValue('2026-05-20T09:30')).toEqual({ kind: 'single', date: '2026-05-20T09:30' });
    expect(parseDateFieldValue('2026-05-20/2026-05-24')).toEqual({
      kind: 'range',
      start: '2026-05-20',
      end: '2026-05-24',
    });
    expect(parseDateFieldValue('2026-05-20T09:30/2026-05-24T17:00')).toEqual({
      kind: 'range',
      start: '2026-05-20T09:30',
      end: '2026-05-24T17:00',
    });
    expect(parseDateFieldValue('2026-05-20/2026-05-20')).toEqual({
      kind: 'range',
      start: '2026-05-20',
      end: '2026-05-20',
    });
    expect(normalizeDateFieldValue(' 2026-05-20 / 2026-05-24 ')).toBe('2026-05-20/2026-05-24');
    expect(normalizeDateFieldValue(' 2026-05-20T09:30 / 2026-05-24T17:00 ')).toBe('2026-05-20T09:30/2026-05-24T17:00');
    expect(normalizeDateFieldValue('2026-02-30')).toBe('');
    expect(normalizeDateFieldValue('2026-05-20T24:00')).toBe('');
    expect(normalizeDateFieldValue('2026-05-24/2026-05-20')).toBe('');
    expect(normalizeDateFieldValue('2026-05-20T10:00/2026-05-20T09:00')).toBe('');
    expect(normalizeDateFieldValue('2026-05-20..2026-05-24')).toBe('');
  });

  test('parses and formats recurring single dates; ranges never recur', () => {
    expect(parseDateFieldValue('2026-05-20T09:30 RRULE:FREQ=DAILY')).toEqual({
      kind: 'single',
      date: '2026-05-20T09:30',
      recurrence: { frequency: 'daily', interval: 1 },
    });
    expect(parseDateFieldValue(' 2026-05-20 rrule:freq=weekly;byday=we,mo;interval=2;until=2026-12-31 ')).toEqual({
      kind: 'single',
      date: '2026-05-20',
      recurrence: { frequency: 'weekly', interval: 2, byDay: ['MO', 'WE'], until: '2026-12-31' },
    });
    // A plain single carries no `recurrence` key.
    expect(parseDateFieldValue('2026-05-20')).not.toHaveProperty('recurrence');
    // Round-trips through the canonical text form.
    expect(normalizeDateFieldValue('2026-05-20 RRULE:FREQ=MONTHLY;INTERVAL=3')).toBe('2026-05-20 RRULE:FREQ=MONTHLY;INTERVAL=3');
    // A recurring range is rejected (anchor part is not a bare endpoint).
    expect(normalizeDateFieldValue('2026-05-20/2026-05-24 RRULE:FREQ=DAILY')).toBe('');
    // A malformed rule rejects the whole value.
    expect(normalizeDateFieldValue('2026-05-20 RRULE:FREQ=NOPE')).toBe('');
    expect(normalizeDateFieldValue('2026-05-20 RRULE:')).toBe('');
  });

  test('formats date input into canonical field values', () => {
    expect(formatDateFieldInput('', '')).toBe('');
    expect(formatDateFieldInput('2026-05-20', '')).toBe('2026-05-20');
    expect(formatDateFieldInput('', '2026-05-24')).toBe('2026-05-24');
    expect(formatDateFieldInput('2026-05-24', '2026-05-20')).toBe('2026-05-20/2026-05-24');
    expect(formatDateFieldInput('2026-05-20', '2026-05-20')).toBe('2026-05-20/2026-05-20');
    expect(formatDateFieldInput('2026-05-20T09:30', '')).toBe('2026-05-20T09:30');
    expect(formatDateFieldInput('2026-05-20T17:00', '2026-05-20T09:30')).toBe('2026-05-20T09:30/2026-05-20T17:00');
    expect(formatDateFieldInput('2026-05-20T12:00', '2026-05-20')).toBe('2026-05-20T12:00/2026-05-20');
  });

  test('builds local date ranges for search comparisons', () => {
    const single = parseDateFieldValueRange('2026-05-20')!;
    expect(single.start).toBe('2026-05-20');
    expect(single.end).toBe('2026-05-20');
    expect(single.endExclusiveMs).toBeGreaterThan(single.startMs);

    const range = parseDateFieldValueRange('2026-05-20/2026-05-24')!;
    expect(range.start).toBe('2026-05-20');
    expect(range.end).toBe('2026-05-24');
    expect(range.endExclusiveMs).toBeGreaterThan(single.endExclusiveMs);

    const minute = parseDateFieldValueRange('2026-05-20T09:30')!;
    expect(minute.start).toBe('2026-05-20T09:30');
    expect(minute.end).toBe('2026-05-20T09:30');
    expect(minute.endExclusiveMs - minute.startMs).toBe(60_000);
  });

  test('extracts canonical date ranges from text', () => {
    const ranges = dateFieldValueRangesInText('Plan 2026-05-20/2026-05-24, review 2026-05-30, ship 2026-05-31T09:30');
    expect(ranges.map((range) => [range.start, range.end])).toEqual([
      ['2026-05-20', '2026-05-24'],
      ['2026-05-20', '2026-05-20'],
      ['2026-05-24', '2026-05-24'],
      ['2026-05-30', '2026-05-30'],
      ['2026-05-31T09:30', '2026-05-31T09:30'],
    ]);
  });

  test('does not treat legacy double-dot text as a date field range', () => {
    const ranges = dateFieldValueRangesInText('Plan 2026-05-20..2026-05-24');
    expect(ranges.map((range) => [range.start, range.end])).toEqual([
      ['2026-05-20', '2026-05-20'],
      ['2026-05-24', '2026-05-24'],
    ]);
  });
});
