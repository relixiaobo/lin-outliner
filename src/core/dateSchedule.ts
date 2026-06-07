import {
  addLocalDays,
  dateFromIsoLocalDate,
  dateFromIsoLocalDateTime,
} from './localDate';
import {
  dateFieldEndpointHasTime,
  normalizedDateFieldEndpoint,
} from './dateFieldValue';

export type DateScheduleFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type DateScheduleWeekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export interface DateRecurrenceRule {
  frequency: DateScheduleFrequency;
  interval: number;
  byDay?: DateScheduleWeekday[];
  until?: string;
}

export interface DateSchedule {
  anchor: string;
  recurrence?: DateRecurrenceRule;
}

export interface DateScheduleFireDecision {
  shouldFire: boolean;
  dueAt: Date | null;
  reason: 'not_due' | 'already_fired' | 'due';
}

const RRULE_SEPARATOR_PATTERN = /\s+RRULE:/i;
const WEEKDAYS: readonly DateScheduleWeekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const WEEKDAY_SET = new Set<DateScheduleWeekday>(WEEKDAYS);
const JS_DAY_TO_WEEKDAY: readonly DateScheduleWeekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const WEEKDAY_TO_WEEK_OFFSET: Record<DateScheduleWeekday, number> = {
  MO: 0,
  TU: 1,
  WE: 2,
  TH: 3,
  FR: 4,
  SA: 5,
  SU: 6,
};

export function parseDateSchedule(raw: string): DateSchedule | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(RRULE_SEPARATOR_PATTERN);
  if (parts.length > 2) return null;

  const anchor = normalizedDateFieldEndpoint(parts[0] ?? '');
  if (!anchor) return null;
  if (parts.length === 1) return { anchor };

  const recurrence = parseDateRecurrenceRule(parts[1] ?? '');
  return recurrence ? { anchor, recurrence } : null;
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

  const interval = values.has('INTERVAL') ? Number(values.get('INTERVAL')) : 1;
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

export function formatDateSchedule(schedule: DateSchedule): string {
  return schedule.recurrence
    ? `${schedule.anchor} RRULE:${formatDateRecurrenceRule(schedule.recurrence)}`
    : schedule.anchor;
}

export function formatDateRecurrenceRule(rule: DateRecurrenceRule): string {
  const parts = [`FREQ=${rule.frequency.toUpperCase()}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay?.length) parts.push(`BYDAY=${sortWeekdays(rule.byDay).join(',')}`);
  if (rule.until) parts.push(`UNTIL=${rule.until}`);
  return parts.join(';');
}

export function mostRecentDateScheduleDue(input: DateSchedule | string, now = new Date()): Date | null {
  const schedule = typeof input === 'string' ? parseDateSchedule(input) : input;
  if (!schedule) return null;

  const anchor = dateFromScheduleEndpoint(schedule.anchor);
  if (!schedule.recurrence) return anchor.getTime() <= now.getTime() ? anchor : null;

  const untilEnd = schedule.recurrence.until ? dateEndpointInclusiveEnd(schedule.recurrence.until) : null;
  if (untilEnd && anchor.getTime() > untilEnd.getTime()) return null;

  const limit = untilEnd && untilEnd.getTime() < now.getTime() ? untilEnd : now;
  if (limit.getTime() < anchor.getTime()) return null;

  switch (schedule.recurrence.frequency) {
    case 'daily':
      return mostRecentDailyDue(anchor, schedule.recurrence.interval, limit);
    case 'weekly':
      return mostRecentWeeklyDue(anchor, schedule.recurrence, limit);
    case 'monthly':
      return mostRecentMonthlyDue(anchor, schedule.recurrence.interval, limit);
    case 'yearly':
      return mostRecentYearlyDue(anchor, schedule.recurrence.interval, limit);
  }
}

export function shouldFireDateSchedule(
  input: DateSchedule | string,
  now = new Date(),
  lastSuccessAt: Date | number | null = null,
): DateScheduleFireDecision {
  const dueAt = mostRecentDateScheduleDue(input, now);
  if (!dueAt) return { shouldFire: false, dueAt: null, reason: 'not_due' };

  const lastSuccessMs = lastSuccessAt instanceof Date ? lastSuccessAt.getTime() : lastSuccessAt;
  if (lastSuccessMs !== null && lastSuccessMs >= dueAt.getTime()) {
    return { shouldFire: false, dueAt, reason: 'already_fired' };
  }
  return { shouldFire: true, dueAt, reason: 'due' };
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

function sortWeekdays(days: readonly DateScheduleWeekday[]): DateScheduleWeekday[] {
  return [...days].sort((left, right) => WEEKDAY_TO_WEEK_OFFSET[left] - WEEKDAY_TO_WEEK_OFFSET[right]);
}

function dateFromScheduleEndpoint(endpoint: string): Date {
  return dateFieldEndpointHasTime(endpoint)
    ? dateFromIsoLocalDateTime(endpoint)
    : dateFromIsoLocalDate(endpoint);
}

function dateEndpointInclusiveEnd(endpoint: string): Date {
  if (dateFieldEndpointHasTime(endpoint)) return dateFromIsoLocalDateTime(endpoint);
  const date = dateFromIsoLocalDate(endpoint);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function mostRecentDailyDue(anchor: Date, interval: number, limit: Date): Date | null {
  const elapsedDays = calendarDayIndex(limit) - calendarDayIndex(anchor);
  const offset = Math.floor(elapsedDays / interval) * interval;
  const candidate = addDaysWithAnchorTime(anchor, offset);
  if (candidate.getTime() <= limit.getTime()) return candidate;
  const previous = addDaysWithAnchorTime(anchor, offset - interval);
  return previous.getTime() >= anchor.getTime() ? previous : null;
}

function mostRecentWeeklyDue(anchor: Date, rule: DateRecurrenceRule, limit: Date): Date | null {
  const anchorWeekStart = startOfMondayWeek(anchor);
  const limitWeekStart = startOfMondayWeek(limit);
  const elapsedWeeks = Math.floor((calendarDayIndex(limitWeekStart) - calendarDayIndex(anchorWeekStart)) / 7);
  const firstWeekOffset = Math.floor(elapsedWeeks / rule.interval) * rule.interval;
  const byDay = rule.byDay?.length ? rule.byDay : [JS_DAY_TO_WEEKDAY[anchor.getDay()]!];

  for (let weekOffset = firstWeekOffset; weekOffset >= 0; weekOffset -= rule.interval) {
    for (const weekday of [...byDay].sort((left, right) => WEEKDAY_TO_WEEK_OFFSET[right] - WEEKDAY_TO_WEEK_OFFSET[left])) {
      const day = addDaysWithAnchorTime(anchorWeekStart, weekOffset * 7 + WEEKDAY_TO_WEEK_OFFSET[weekday]);
      const occurrence = withAnchorTime(day, anchor);
      if (occurrence.getTime() <= limit.getTime() && occurrence.getTime() >= anchor.getTime()) return occurrence;
    }
  }
  return null;
}

function mostRecentMonthlyDue(anchor: Date, interval: number, limit: Date): Date | null {
  const elapsedMonths = (limit.getFullYear() - anchor.getFullYear()) * 12 + (limit.getMonth() - anchor.getMonth());
  for (let offset = Math.floor(elapsedMonths / interval) * interval; offset >= 0; offset -= interval) {
    const candidate = localDateOrNull(anchor.getFullYear(), anchor.getMonth() + offset, anchor.getDate(), anchor.getHours(), anchor.getMinutes());
    if (candidate && candidate.getTime() <= limit.getTime() && candidate.getTime() >= anchor.getTime()) return candidate;
  }
  return null;
}

function mostRecentYearlyDue(anchor: Date, interval: number, limit: Date): Date | null {
  const elapsedYears = limit.getFullYear() - anchor.getFullYear();
  for (let offset = Math.floor(elapsedYears / interval) * interval; offset >= 0; offset -= interval) {
    const candidate = localDateOrNull(anchor.getFullYear() + offset, anchor.getMonth(), anchor.getDate(), anchor.getHours(), anchor.getMinutes());
    if (candidate && candidate.getTime() <= limit.getTime() && candidate.getTime() >= anchor.getTime()) return candidate;
  }
  return null;
}

function addDaysWithAnchorTime(anchor: Date, days: number): Date {
  const date = addLocalDays(anchor, days);
  return withAnchorTime(date, anchor);
}

function withAnchorTime(date: Date, anchor: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), anchor.getHours(), anchor.getMinutes());
}

function startOfMondayWeek(date: Date): Date {
  const day = date.getDay() || 7;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1 - day);
}

function calendarDayIndex(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

function localDateOrNull(year: number, monthIndex: number, day: number, hour: number, minute: number): Date | null {
  const monthStart = new Date(year, monthIndex, 1);
  const expectedYear = monthStart.getFullYear();
  const expectedMonth = monthStart.getMonth();
  const date = new Date(year, monthIndex, day, hour, minute);
  return date.getFullYear() === expectedYear
    && date.getMonth() === expectedMonth
    && date.getDate() === day
    && date.getHours() === hour
    && date.getMinutes() === minute
    ? date
    : null;
}
