import {
  addLocalDays,
  dateFromIsoLocalDate,
  dateFromIsoLocalDateTime,
} from './localDate';
import {
  dateFieldEndpointHasTime,
  formatDateRecurrenceRule,
  normalizedDateFieldEndpoint,
  parseDateRecurrenceRule,
  RRULE_SEPARATOR_PATTERN,
  WEEKDAY_TO_WEEK_OFFSET,
  type DateRecurrenceRule,
  type DateScheduleWeekday,
} from './dateFieldValue';

// The recurrence-rule primitives now live in the value-model layer
// (`dateFieldValue.ts`); re-export them so existing importers can keep pulling
// the rule surface from here alongside the fire-evaluation helpers.
export {
  formatDateRecurrenceRule,
  isWeekdayPreset,
  parseDateRecurrenceRule,
  WEEKDAY_PRESET,
} from './dateFieldValue';
export type {
  DateRecurrenceRule,
  DateScheduleFrequency,
  DateScheduleWeekday,
} from './dateFieldValue';

export interface DateSchedule {
  anchor: string;
  recurrence?: DateRecurrenceRule;
}

export interface DateScheduleFireDecision {
  shouldFire: boolean;
  dueAt: Date | null;
  reason: 'not_due' | 'already_fired' | 'due';
}

const JS_DAY_TO_WEEKDAY: readonly DateScheduleWeekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

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

export function formatDateSchedule(schedule: DateSchedule): string {
  return schedule.recurrence
    ? `${schedule.anchor} RRULE:${formatDateRecurrenceRule(schedule.recurrence)}`
    : schedule.anchor;
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

export function nextDateScheduleDue(input: DateSchedule | string, now = new Date()): Date | null {
  const schedule = typeof input === 'string' ? parseDateSchedule(input) : input;
  if (!schedule) return null;

  const anchor = dateFromScheduleEndpoint(schedule.anchor);
  const nowMs = now.getTime();
  if (!schedule.recurrence) return anchor.getTime() >= nowMs ? anchor : null;

  const untilEnd = schedule.recurrence.until ? dateEndpointInclusiveEnd(schedule.recurrence.until) : null;
  if (untilEnd && anchor.getTime() > untilEnd.getTime()) return null;
  if (anchor.getTime() >= nowMs) return withinUntil(anchor, untilEnd) ? anchor : null;

  let due: Date | null = null;
  switch (schedule.recurrence.frequency) {
    case 'daily':
      due = nextDailyDue(anchor, schedule.recurrence.interval, now);
      break;
    case 'weekly':
      due = nextWeeklyDue(anchor, schedule.recurrence, now);
      break;
    case 'monthly':
      due = nextMonthlyDue(anchor, schedule.recurrence.interval, now, untilEnd);
      break;
    case 'yearly':
      due = nextYearlyDue(anchor, schedule.recurrence.interval, now, untilEnd);
      break;
  }
  return due && withinUntil(due, untilEnd) ? due : null;
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

function nextDailyDue(anchor: Date, interval: number, now: Date): Date {
  const elapsedDays = calendarDayIndex(now) - calendarDayIndex(anchor);
  const baseOffset = Math.max(0, Math.floor(elapsedDays / interval) * interval);
  const candidate = addDaysWithAnchorTime(anchor, baseOffset);
  return candidate.getTime() >= now.getTime()
    ? candidate
    : addDaysWithAnchorTime(anchor, baseOffset + interval);
}

function nextWeeklyDue(anchor: Date, rule: DateRecurrenceRule, now: Date): Date | null {
  const anchorWeekStart = startOfMondayWeek(anchor);
  const nowWeekStart = startOfMondayWeek(now);
  const elapsedWeeks = Math.max(0, Math.floor((calendarDayIndex(nowWeekStart) - calendarDayIndex(anchorWeekStart)) / 7));
  const firstWeekOffset = Math.floor(elapsedWeeks / rule.interval) * rule.interval;
  const byDay = rule.byDay?.length ? rule.byDay : [JS_DAY_TO_WEEKDAY[anchor.getDay()]!];

  for (let weekOffset = firstWeekOffset; weekOffset <= firstWeekOffset + rule.interval * 2; weekOffset += rule.interval) {
    for (const weekday of [...byDay].sort((left, right) => WEEKDAY_TO_WEEK_OFFSET[left] - WEEKDAY_TO_WEEK_OFFSET[right])) {
      const day = addDaysWithAnchorTime(anchorWeekStart, weekOffset * 7 + WEEKDAY_TO_WEEK_OFFSET[weekday]);
      const occurrence = withAnchorTime(day, anchor);
      if (occurrence.getTime() >= now.getTime() && occurrence.getTime() >= anchor.getTime()) return occurrence;
    }
  }
  return null;
}

function nextMonthlyDue(anchor: Date, interval: number, now: Date, untilEnd: Date | null): Date | null {
  const elapsedMonths = (now.getFullYear() - anchor.getFullYear()) * 12 + (now.getMonth() - anchor.getMonth());
  const firstOffset = Math.max(0, Math.floor(elapsedMonths / interval) * interval);
  for (let offset = firstOffset; offset <= firstOffset + interval * 120; offset += interval) {
    const candidate = localDateOrNull(anchor.getFullYear(), anchor.getMonth() + offset, anchor.getDate(), anchor.getHours(), anchor.getMinutes());
    if (!candidate) continue;
    if (!withinUntil(candidate, untilEnd)) return null;
    if (candidate.getTime() >= now.getTime() && candidate.getTime() >= anchor.getTime()) return candidate;
  }
  return null;
}

function nextYearlyDue(anchor: Date, interval: number, now: Date, untilEnd: Date | null): Date | null {
  const elapsedYears = now.getFullYear() - anchor.getFullYear();
  const firstOffset = Math.max(0, Math.floor(elapsedYears / interval) * interval);
  for (let offset = firstOffset; offset <= firstOffset + interval * 200; offset += interval) {
    const candidate = localDateOrNull(anchor.getFullYear() + offset, anchor.getMonth(), anchor.getDate(), anchor.getHours(), anchor.getMinutes());
    if (!candidate) continue;
    if (!withinUntil(candidate, untilEnd)) return null;
    if (candidate.getTime() >= now.getTime() && candidate.getTime() >= anchor.getTime()) return candidate;
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

function withinUntil(date: Date, untilEnd: Date | null): boolean {
  return !untilEnd || date.getTime() <= untilEnd.getTime();
}

function localDateOrNull(year: number, monthIndex: number, day: number, hour: number, minute: number): Date | null {
  const monthStart = new Date(year, monthIndex, 1);
  const expectedYear = monthStart.getFullYear();
  const expectedMonth = monthStart.getMonth();
  const date = new Date(year, monthIndex, day, hour, minute);
  return date.getFullYear() === expectedYear
    && date.getMonth() === expectedMonth
    && date.getDate() === day
    ? date
    : null;
}
