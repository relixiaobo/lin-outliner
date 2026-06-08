import {
  addLocalDays,
  addLocalMinutes,
  dateFromIsoLocalDate,
  dateFromIsoLocalDateTime,
  normalizedIsoLocalDateTime,
  normalizedIsoLocalDate,
} from './localDate';

export type DateFieldValue =
  // A single date may carry a recurrence rule (a repeating date); a range never
  // does. The canonical text form mirrors a schedule string: `<date> RRULE:...`.
  | { kind: 'single'; date: string; recurrence?: DateRecurrenceRule }
  | { kind: 'range'; start: string; end: string };

export type DateScheduleFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type DateScheduleWeekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export interface DateRecurrenceRule {
  frequency: DateScheduleFrequency;
  interval: number;
  byDay?: DateScheduleWeekday[];
  until?: string;
}

export interface DateFieldValueRange {
  start: string;
  end: string;
  startMs: number;
  endExclusiveMs: number;
}

export const RRULE_SEPARATOR_PATTERN = /\s+RRULE:/i;
const DECIMAL_INTEGER_PATTERN = /^[0-9]+$/;
const WEEKDAYS: readonly DateScheduleWeekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const WEEKDAY_SET = new Set<DateScheduleWeekday>(WEEKDAYS);
export const WEEKDAY_TO_WEEK_OFFSET: Record<DateScheduleWeekday, number> = {
  MO: 0,
  TU: 1,
  WE: 2,
  TH: 3,
  FR: 4,
  SA: 5,
  SU: 6,
};

const DATE_FIELD_ENDPOINT_SOURCE = String.raw`\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?`;
const DATE_FIELD_ENDPOINT_PATTERN = new RegExp(`^${DATE_FIELD_ENDPOINT_SOURCE}$`);
const DATE_FIELD_ENDPOINT_IN_TEXT_PATTERN = new RegExp(`\\b(${DATE_FIELD_ENDPOINT_SOURCE})\\b`, 'g');
const DATE_FIELD_RANGE_PATTERN = new RegExp(`^(${DATE_FIELD_ENDPOINT_SOURCE})\\s*/\\s*(${DATE_FIELD_ENDPOINT_SOURCE})$`);
const DATE_FIELD_RANGE_IN_TEXT_PATTERN = new RegExp(`\\b(${DATE_FIELD_ENDPOINT_SOURCE})\\s*/\\s*(${DATE_FIELD_ENDPOINT_SOURCE})\\b`, 'g');

export function parseDateFieldValue(raw: string): DateFieldValue | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // `<anchor> RRULE:...` — a recurring single date. Ranges never recur, so the
  // anchor part must be a bare endpoint (a `start/end` here fails and rejects).
  const parts = trimmed.split(RRULE_SEPARATOR_PATTERN);
  if (parts.length > 2) return null;
  if (parts.length === 2) {
    const date = normalizedDateFieldEndpoint(parts[0] ?? '');
    const recurrence = parseDateRecurrenceRule(parts[1] ?? '');
    if (!date || !recurrence) return null;
    return { kind: 'single', date, recurrence };
  }

  const rangeMatch = trimmed.match(DATE_FIELD_RANGE_PATTERN);
  if (rangeMatch) {
    const start = normalizedDateFieldEndpoint(rangeMatch[1]!);
    const end = normalizedDateFieldEndpoint(rangeMatch[2]!);
    if (!start || !end || !dateFieldRangeIsValid(start, end)) return null;
    return { kind: 'range', start, end };
  }

  const date = normalizedDateFieldEndpoint(trimmed);
  return date ? { kind: 'single', date } : null;
}

export function formatDateFieldValue(value: DateFieldValue): string {
  if (value.kind === 'single') {
    return value.recurrence
      ? `${value.date} RRULE:${formatDateRecurrenceRule(value.recurrence)}`
      : value.date;
  }
  return `${value.start}/${value.end}`;
}

export function formatDateFieldInput(start: string, end: string): string {
  const normalizedStart = normalizedDateFieldEndpoint(start);
  const normalizedEnd = normalizedDateFieldEndpoint(end);
  if (!normalizedStart && !normalizedEnd) return '';
  if (normalizedStart && !normalizedEnd) return normalizedStart;
  if (!normalizedStart && normalizedEnd) return normalizedEnd;
  if (!normalizedStart || !normalizedEnd) return '';

  const ordered = orderDateFieldEndpoints(normalizedStart, normalizedEnd);
  if (!ordered) return '';
  const [rangeStart, rangeEnd] = ordered;
  return formatDateFieldValue({ kind: 'range', start: rangeStart, end: rangeEnd });
}

export function normalizeDateFieldValue(raw: string): string {
  const parsed = parseDateFieldValue(raw);
  return parsed ? formatDateFieldValue(parsed) : '';
}

export function parseDateFieldValueRange(raw: string): DateFieldValueRange | null {
  const parsed = parseDateFieldValue(raw);
  return parsed ? dateFieldValueRange(parsed) : null;
}

export function dateFieldValueRangesInText(text: string): DateFieldValueRange[] {
  const ranges: DateFieldValueRange[] = [];
  for (const match of text.matchAll(DATE_FIELD_RANGE_IN_TEXT_PATTERN)) {
    const range = parseDateFieldValueRange(`${match[1]}/${match[2]}`);
    if (range) ranges.push(range);
  }
  for (const match of text.matchAll(DATE_FIELD_ENDPOINT_IN_TEXT_PATTERN)) {
    const range = parseDateFieldValueRange(match[1]!);
    if (range) ranges.push(range);
  }
  return uniqueDateFieldValueRanges(ranges);
}

export function dateFieldValueRange(value: DateFieldValue): DateFieldValueRange {
  const start = value.kind === 'single' ? value.date : value.start;
  const end = value.kind === 'single' ? value.date : value.end;
  const startRange = dateFieldEndpointRange(start);
  const endRange = dateFieldEndpointRange(end);
  return {
    start,
    end,
    startMs: startRange.startMs,
    endExclusiveMs: endRange.endExclusiveMs,
  };
}

export function normalizedDateFieldEndpoint(raw: string): string | null {
  const trimmed = raw.trim();
  if (!DATE_FIELD_ENDPOINT_PATTERN.test(trimmed)) return null;
  return normalizedIsoLocalDateTime(trimmed) ?? normalizedIsoLocalDate(trimmed);
}

export function dateFieldEndpointHasTime(value: string): boolean {
  return Boolean(normalizedIsoLocalDateTime(value));
}

export function dateFieldEndpointDate(value: string): string {
  return value.split('T')[0] ?? value;
}

export function dateFieldEndpointTime(value: string): string {
  return value.includes('T') ? value.split('T')[1] ?? '' : '';
}

export function formatDateFieldEndpoint(date: string, time = ''): string {
  const normalizedDate = normalizedIsoLocalDate(date);
  if (!normalizedDate) return '';
  if (!time) return normalizedDate;
  return normalizedDateFieldEndpoint(`${normalizedDate}T${time}`) ?? '';
}

export function orderDateFieldEndpoints(start: string, end: string): [string, string] | null {
  if (dateFieldRangeIsValid(start, end)) return [start, end];
  if (dateFieldRangeIsValid(end, start)) return [end, start];
  return null;
}

export function compareDateFieldEndpoints(left: string, right: string): number {
  return dateFieldEndpointRange(left).startMs - dateFieldEndpointRange(right).startMs;
}

export { normalizedIsoLocalDate } from './localDate';

function dateFieldRangeIsValid(start: string, end: string): boolean {
  return dateFieldEndpointRange(start).startMs < dateFieldEndpointRange(end).endExclusiveMs;
}

function dateFieldEndpointRange(value: string): { startMs: number; endExclusiveMs: number } {
  if (dateFieldEndpointHasTime(value)) {
    const date = dateFromIsoLocalDateTime(value);
    return {
      startMs: date.getTime(),
      endExclusiveMs: addLocalMinutes(date, 1).getTime(),
    };
  }
  const date = dateFromIsoLocalDate(value);
  return {
    startMs: date.getTime(),
    endExclusiveMs: addLocalDays(date, 1).getTime(),
  };
}

function uniqueDateFieldValueRanges(ranges: DateFieldValueRange[]): DateFieldValueRange[] {
  const result: DateFieldValueRange[] = [];
  const seen = new Set<string>();
  for (const range of ranges) {
    const key = `${range.start}:${range.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(range);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Recurrence rules — the RRULE primitives shared by the generic date field and
// the command-schedule string. Kept here (the value-model layer) so the
// fire-evaluation layer (`dateSchedule.ts`) can build on them without a cycle.
// ---------------------------------------------------------------------------

// Mon–Fri, the canonical "weekday" recurrence set. The single source of truth
// so the editor (detect + emit) and the chip summary all agree — no
// hand-duplicated day arrays that can drift.
export const WEEKDAY_PRESET: readonly DateScheduleWeekday[] = ['MO', 'TU', 'WE', 'TH', 'FR'];

// Whether a BYDAY set is exactly Mon–Fri (order-independent).
export function isWeekdayPreset(byDay: readonly DateScheduleWeekday[] | undefined): boolean {
  if (!byDay || byDay.length !== WEEKDAY_PRESET.length) return false;
  const set = new Set(byDay);
  return WEEKDAY_PRESET.every((day) => set.has(day));
}

export function parseDateRecurrenceRule(raw: string): DateRecurrenceRule | null {
  const segments = raw.trim().split(';').filter(Boolean);
  if (segments.length === 0) return null;

  const values = new Map<string, string>();
  for (const segment of segments) {
    const [rawKey, ...rawValueParts] = segment.split('=');
    const key = rawKey?.trim().toUpperCase();
    const value = rawValueParts.join('=').trim().toUpperCase();
    if (!key || !value || values.has(key)) return null;
    values.set(key, value);
  }

  const frequency = parseFrequency(values.get('FREQ'));
  if (!frequency) return null;

  const intervalValue = values.get('INTERVAL');
  if (intervalValue !== undefined && !DECIMAL_INTEGER_PATTERN.test(intervalValue)) return null;
  const interval = intervalValue !== undefined ? Number(intervalValue) : 1;
  if (!Number.isSafeInteger(interval) || interval < 1) return null;

  const byDay = values.has('BYDAY') ? parseByDay(values.get('BYDAY') ?? '') : undefined;
  if (values.has('BYDAY') && (!byDay || frequency !== 'weekly')) return null;

  const until = values.has('UNTIL') ? normalizedDateFieldEndpoint(values.get('UNTIL') ?? '') : undefined;
  if (values.has('UNTIL') && !until) return null;

  for (const key of values.keys()) {
    if (key !== 'FREQ' && key !== 'INTERVAL' && key !== 'BYDAY' && key !== 'UNTIL') return null;
  }

  return {
    frequency,
    interval,
    ...(byDay ? { byDay } : {}),
    ...(until ? { until } : {}),
  };
}

export function formatDateRecurrenceRule(rule: DateRecurrenceRule): string {
  const parts = [`FREQ=${rule.frequency.toUpperCase()}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay?.length) parts.push(`BYDAY=${sortWeekdays(rule.byDay).join(',')}`);
  if (rule.until) parts.push(`UNTIL=${rule.until}`);
  return parts.join(';');
}

export function sortWeekdays(days: readonly DateScheduleWeekday[]): DateScheduleWeekday[] {
  return [...days].sort((left, right) => WEEKDAY_TO_WEEK_OFFSET[left] - WEEKDAY_TO_WEEK_OFFSET[right]);
}

function parseFrequency(value: string | undefined): DateScheduleFrequency | null {
  switch (value) {
    case 'DAILY':
      return 'daily';
    case 'WEEKLY':
      return 'weekly';
    case 'MONTHLY':
      return 'monthly';
    case 'YEARLY':
      return 'yearly';
    default:
      return null;
  }
}

function parseByDay(value: string): DateScheduleWeekday[] | null {
  const days = value.split(',').map((day) => day.trim().toUpperCase()).filter(Boolean);
  if (days.length === 0) return null;
  const result: DateScheduleWeekday[] = [];
  const seen = new Set<DateScheduleWeekday>();
  for (const day of days) {
    if (!WEEKDAY_SET.has(day as DateScheduleWeekday)) return null;
    const weekday = day as DateScheduleWeekday;
    if (seen.has(weekday)) return null;
    seen.add(weekday);
    result.push(weekday);
  }
  return sortWeekdays(result);
}
