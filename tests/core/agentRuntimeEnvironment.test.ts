import { describe, expect, test } from 'bun:test';
import {
  resolvedIanaTimezone,
  runtimeEnvironmentContext,
} from '../../src/main/agent/runtime/runtimeEnvironmentContext';

describe('Agent runtime environment context', () => {
  test('renders the local date, exact UTC instant, and IANA timezone', () => {
    expect(runtimeEnvironmentContext(Date.parse('2026-07-26T03:12:27Z'), 'Asia/Shanghai')).toBe([
      '<environment_context>',
      '  <current_date>2026-07-26</current_date>',
      '  <current_time_utc>2026-07-26T03:12:27.000Z</current_time_utc>',
      '  <timezone>Asia/Shanghai</timezone>',
      '</environment_context>',
    ].join('\n'));
  });

  test('derives the calendar date in the supplied timezone', () => {
    expect(runtimeEnvironmentContext(Date.parse('2026-07-26T00:30:00Z'), 'America/Los_Angeles'))
      .toContain('<current_date>2026-07-25</current_date>');
  });

  test('always resolves a non-empty runtime timezone', () => {
    expect(resolvedIanaTimezone()).not.toBe('');
  });
});
