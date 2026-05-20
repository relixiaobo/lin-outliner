import { describe, expect, test } from 'bun:test';
import {
  addLocalDays,
  dateFromIsoLocalDateTime,
  isoLocalDate,
  isoLocalDateTime,
  offsetIsoLocalDate,
  parseIsoLocalDate,
  parseIsoLocalDateTime,
} from '../../src/core/localDate';

describe('local date helpers', () => {
  test('parses and formats valid ISO local dates', () => {
    const date = parseIsoLocalDate('2026-05-20');
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(4);
    expect(date?.getDate()).toBe(20);
    expect(date ? isoLocalDate(date) : '').toBe('2026-05-20');
  });

  test('rejects impossible dates instead of rolling them forward', () => {
    expect(parseIsoLocalDate('2026-02-30')).toBeNull();
    expect(parseIsoLocalDate('2026-2-3')).toBeNull();
  });

  test('parses and formats ISO local date-times to minute precision', () => {
    const date = parseIsoLocalDateTime('2026-05-20T09:30');
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(4);
    expect(date?.getDate()).toBe(20);
    expect(date?.getHours()).toBe(9);
    expect(date?.getMinutes()).toBe(30);
    expect(date ? isoLocalDateTime(date) : '').toBe('2026-05-20T09:30');
    expect(dateFromIsoLocalDateTime('2026-05-20T23:59').getMinutes()).toBe(59);
  });

  test('rejects impossible local date-times', () => {
    expect(parseIsoLocalDateTime('2026-05-20T24:00')).toBeNull();
    expect(parseIsoLocalDateTime('2026-05-20T09:60')).toBeNull();
    expect(parseIsoLocalDateTime('2026-02-30T09:00')).toBeNull();
  });

  test('offsets ISO dates across month and year boundaries', () => {
    expect(offsetIsoLocalDate('2026-01-01', -1)).toBe('2025-12-31');
    expect(isoLocalDate(addLocalDays(new Date(2026, 1, 28), 1))).toBe('2026-03-01');
  });
});
