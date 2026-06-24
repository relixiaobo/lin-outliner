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
type DateScheduleSearchDirection = 'past' | 'future';

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
  return dateScheduleDue(input, now, 'past');
}

export function nextDateScheduleDue(input: DateSchedule | string, now = new Date()): Date | null {
  return dateScheduleDue(input, now, 'future');
}

function dateScheduleDue(input: DateSchedule | string, now: Date, direction: DateScheduleSearchDirection): Date | null {
  const schedule = typeof input === 'string' ? parseDateSchedule(input) : input;
  if (!schedule) return null;

  const anchor = dateFromScheduleEndpoint(schedule.anchor);
  const nowMs = now.getTime();
  if (!schedule.recurrence) {
    return direction === 'past'
      ? (anchor.getTime() <= nowMs ? anchor : null)
      : (anchor.getTime() >= nowMs ? anchor : null);
  }

  const untilEnd = schedule.recurrence.until ? dateEndpointInclusiveEnd(schedule.recurrence.until) : null;
  if (untilEnd && anchor.getTime() > untilEnd.getTime()) return null;

  if (direction === 'past') {
    const limit = untilEnd && untilEnd.getTime() < nowMs ? untilEnd : now;
    if (limit.getTime() < anchor.getTime()) return null;
    return recurrenceDueInDirection(anchor, schedule.recurrence, limit, direction, untilEnd);
  }

  if (anchor.getTime() >= nowMs) return withinUntil(anchor, untilEnd) ? anchor : null;
  return recurrenceDueInDirection(anchor, schedule.recurrence, now, direction, untilEnd);
}

function recurrenceDueInDirection(
  anchor: Date,
  rule: DateRecurrenceRule,
  boundary: Date,
  direction: DateScheduleSearchDirection,
  untilEnd: Date | null,
): Date | null {
  let due: Date | null = null;
  switch (rule.frequency) {
    case 'daily':
      due = dailyDue(anchor, rule.interval, boundary, direction);
      break;
    case 'weekly':
      due = weeklyDue(anchor, rule, boundary, direction);
      break;
    case 'monthly':
      due = monthlyDue(anchor, rule.interval, boundary, direction, untilEnd);
      break;
    case 'yearly':
      due = yearlyDue(anchor, rule.interval, boundary, direction, untilEnd);
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

function dailyDue(anchor: Date, interval: number, boundary: Date, direction: DateScheduleSearchDirection): Date | null {
  const elapsedDays = calendarDayIndex(boundary) - calendarDayIndex(anchor);
  const offset = Math.floor(elapsedDays / interval) * interval;
  const candidate = addDaysWithAnchorTime(anchor, offset);
  if (direction === 'past') {
    if (candidate.getTime() <= boundary.getTime()) return candidate;
    const previous = addDaysWithAnchorTime(anchor, offset - interval);
    return previous.getTime() >= anchor.getTime() ? previous : null;
  }
  return candidate.getTime() >= boundary.getTime()
    ? candidate
    : addDaysWithAnchorTime(anchor, offset + interval);
}

function weeklyDue(anchor: Date, rule: DateRecurrenceRule, boundary: Date, direction: DateScheduleSearchDirection): Date | null {
  const anchorWeekStart = startOfMondayWeek(anchor);
  const boundaryWeekStart = startOfMondayWeek(boundary);
  const elapsedWeeks = Math.max(0, Math.floor((calendarDayIndex(boundaryWeekStart) - calendarDayIndex(anchorWeekStart)) / 7));
  const firstWeekOffset = Math.floor(elapsedWeeks / rule.interval) * rule.interval;
  const byDay = rule.byDay?.length ? rule.byDay : [JS_DAY_TO_WEEKDAY[anchor.getDay()]!];
  const weekdays = [...byDay].sort((left, right) => (
    direction === 'past'
      ? WEEKDAY_TO_WEEK_OFFSET[right] - WEEKDAY_TO_WEEK_OFFSET[left]
      : WEEKDAY_TO_WEEK_OFFSET[left] - WEEKDAY_TO_WEEK_OFFSET[right]
  ));
  const weekEnd = direction === 'past' ? -rule.interval : firstWeekOffset + rule.interval * 2;
  const weekStep = direction === 'past' ? -rule.interval : rule.interval;

  for (
    let weekOffset = firstWeekOffset;
    direction === 'past' ? weekOffset > weekEnd : weekOffset <= weekEnd;
    weekOffset += weekStep
  ) {
    for (const weekday of weekdays) {
      const day = addDaysWithAnchorTime(anchorWeekStart, weekOffset * 7 + WEEKDAY_TO_WEEK_OFFSET[weekday]);
      const occurrence = withAnchorTime(day, anchor);
      if (
        (direction === 'past' ? occurrence.getTime() <= boundary.getTime() : occurrence.getTime() >= boundary.getTime())
        && occurrence.getTime() >= anchor.getTime()
      ) return occurrence;
    }
  }
  return null;
}

function monthlyDue(
  anchor: Date,
  interval: number,
  boundary: Date,
  direction: DateScheduleSearchDirection,
  untilEnd: Date | null,
): Date | null {
  const elapsedMonths = (boundary.getFullYear() - anchor.getFullYear()) * 12 + (boundary.getMonth() - anchor.getMonth());
  const firstOffset = Math.floor(Math.max(0, elapsedMonths) / interval) * interval;
  const endOffset = direction === 'past' ? -interval : firstOffset + interval * 120;
  const step = direction === 'past' ? -interval : interval;
  for (
    let offset = firstOffset;
    direction === 'past' ? offset > endOffset : offset <= endOffset;
    offset += step
  ) {
    const candidate = localDateOrNull(anchor.getFullYear(), anchor.getMonth() + offset, anchor.getDate(), anchor.getHours(), anchor.getMinutes());
    if (!candidate) continue;
    if (!withinUntil(candidate, untilEnd)) return null;
    if (
      (direction === 'past' ? candidate.getTime() <= boundary.getTime() : candidate.getTime() >= boundary.getTime())
      && candidate.getTime() >= anchor.getTime()
    ) return candidate;
  }
  return null;
}

function yearlyDue(
  anchor: Date,
  interval: number,
  boundary: Date,
  direction: DateScheduleSearchDirection,
  untilEnd: Date | null,
): Date | null {
  const elapsedYears = boundary.getFullYear() - anchor.getFullYear();
  const firstOffset = Math.floor(Math.max(0, elapsedYears) / interval) * interval;
  const endOffset = direction === 'past' ? -interval : firstOffset + interval * 200;
  const step = direction === 'past' ? -interval : interval;
  for (
    let offset = firstOffset;
    direction === 'past' ? offset > endOffset : offset <= endOffset;
    offset += step
  ) {
    const candidate = localDateOrNull(anchor.getFullYear() + offset, anchor.getMonth(), anchor.getDate(), anchor.getHours(), anchor.getMinutes());
    if (!candidate) continue;
    if (!withinUntil(candidate, untilEnd)) return null;
    if (
      (direction === 'past' ? candidate.getTime() <= boundary.getTime() : candidate.getTime() >= boundary.getTime())
      && candidate.getTime() >= anchor.getTime()
    ) return candidate;
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
