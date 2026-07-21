import { beforeEach, describe, expect, test } from 'bun:test';
import {
  clearFormatterCachesForTests,
  dateTimeFormatter,
  formatDateTime,
  formatLocaleDateTime,
  formatNumber,
  formatterCacheStatsForTests,
  numberFormatter,
} from '../../src/renderer/ui/formatting';

describe('renderer formatter cache', () => {
  beforeEach(() => {
    clearFormatterCachesForTests();
  });

  test('formats dates with the same output as direct Intl formatters', () => {
    const timestamp = Date.UTC(2026, 6, 21, 12, 34, 56);
    const cases: Array<[string, Intl.DateTimeFormatOptions]> = [
      ['en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }],
      ['zh-CN', { hour: 'numeric', minute: '2-digit' }],
      ['ja-JP', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }],
      ['de-DE', { dateStyle: 'medium', timeStyle: 'short' }],
      ['en-GB', { month: 'long', year: 'numeric' }],
    ];

    for (const [locale, options] of cases) {
      expect(formatDateTime(timestamp, locale, options)).toBe(
        new Intl.DateTimeFormat(locale, options).format(new Date(timestamp)),
      );
    }
  });

  test('preserves Date#toLocaleString(locale) date-time output', () => {
    const timestamp = Date.UTC(2026, 6, 21, 12, 34, 56);

    for (const locale of ['en-US', 'zh-CN', 'ja-JP', 'de-DE']) {
      expect(formatLocaleDateTime(timestamp, locale)).toBe(new Date(timestamp).toLocaleString(locale));
    }

    const invalid = new Date(Number.NaN);
    expect(formatLocaleDateTime(invalid, 'en-US')).toBe(invalid.toLocaleString('en-US'));
  });

  test('formats numbers with the same output as direct Intl formatters', () => {
    expect(formatNumber(1_234_567)).toBe(new Intl.NumberFormat().format(1_234_567));
    expect(formatNumber(1_234_567.89, 'de-DE', { maximumFractionDigits: 1 })).toBe(
      new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(1_234_567.89),
    );
  });

  test('distinguishes locale and option keys while canonicalizing option order', () => {
    const ordered = { month: 'short', day: 'numeric', hour: '2-digit' } satisfies Intl.DateTimeFormatOptions;
    const reordered = { hour: '2-digit', day: 'numeric', month: 'short' } satisfies Intl.DateTimeFormatOptions;

    expect(dateTimeFormatter('en-US', ordered)).toBe(dateTimeFormatter('en-US', reordered));
    expect(dateTimeFormatter(undefined, ordered)).not.toBe(dateTimeFormatter('en-US', ordered));
    expect(dateTimeFormatter('en-US', ordered)).not.toBe(dateTimeFormatter('zh-CN', ordered));
    expect(dateTimeFormatter('en-US', ordered)).not.toBe(dateTimeFormatter('en-US', { ...ordered, second: '2-digit' }));

    expect(numberFormatter('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 })).toBe(
      numberFormatter('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    );
    expect(numberFormatter(undefined)).not.toBe(numberFormatter('en-US'));
  });

  test('keeps formatter caches bounded', () => {
    for (let index = 0; index < 40; index += 1) {
      dateTimeFormatter(`en-US-x-cache${index}`, { year: 'numeric', month: 'short', day: 'numeric' });
      numberFormatter('en-US', { minimumIntegerDigits: (index % 21) + 1, minimumFractionDigits: Math.floor(index / 21) });
    }

    expect(formatterCacheStatsForTests()).toEqual({ dateTime: 32, number: 32 });
  });
});
