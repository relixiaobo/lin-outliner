import type {
  RecurringIssueCadence,
  RecurringIssueMissedPolicy,
} from '../core/agentIssue';

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_WINDOW_SCAN = 100_000;
const OFFSET_PROBE_DELTAS = [
  -2 * DAY_MS,
  -DAY_MS,
  -12 * 60 * 60 * 1_000,
  0,
  12 * 60 * 60 * 1_000,
  DAY_MS,
  2 * DAY_MS,
] as const;

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

interface CalendarDateTime extends CalendarDate {
  hour: number;
  minute: number;
  second: number;
}

export interface RecurringIssueMissedWindowMetadataInput {
  cadence: RecurringIssueCadence;
  timeZone: string;
  missedPolicy: RecurringIssueMissedPolicy;
  createdAt: number;
  dueAt: number;
  firstEligibleWindowStart?: number;
  generatedWindowStarts: readonly number[];
  skippedWindowStarts?: readonly number[];
}

export interface RecurringIssueMissedWindowMetadata {
  skippedWindowCount?: number;
  activityParameter?: `coalesced:${number}`;
}

export interface RecurringIssueScheduleValidationMessage {
  path: 'cadence' | 'cadence.time' | 'cadence.weekdays' | 'cadence.dayOfMonth' | 'timeZone';
  code: string;
  message: string;
}

const resolvedTimeZones = new Map<string, string | null>();
const zonedPartFormatters = new Map<string, Intl.DateTimeFormat>();

export function validateRecurringIssueSchedule(
  cadence: RecurringIssueCadence,
  timeZone: string,
): RecurringIssueScheduleValidationMessage[] {
  const validation: RecurringIssueScheduleValidationMessage[] = [];
  if (!resolveTimeZone(typeof timeZone === 'string' ? timeZone : '')) {
    validation.push({ path: 'timeZone', code: 'invalid_time_zone', message: 'Recurring Issue timeZone must be a valid IANA time zone or Local.' });
  }
  if (!cadence || typeof cadence !== 'object') {
    validation.push({ path: 'cadence', code: 'invalid_cadence', message: 'Recurring Issue cadence is required.' });
    return validation;
  }
  if (!parseLocalTime(typeof cadence.time === 'string' ? cadence.time : '')) {
    validation.push({ path: 'cadence.time', code: 'invalid_cadence_time', message: 'Recurring Issue cadence time must use HH:mm.' });
  }
  switch (cadence.type) {
    case 'daily':
      break;
    case 'weekly':
      if (!Array.isArray(cadence.weekdays)
        || cadence.weekdays.length === 0
        || cadence.weekdays.some((weekday) => !Number.isInteger(weekday) || weekday < 0 || weekday > 6)
        || new Set(cadence.weekdays).size !== cadence.weekdays.length) {
        validation.push({ path: 'cadence.weekdays', code: 'invalid_weekdays', message: 'Weekly cadence requires unique weekdays from 0 through 6.' });
      }
      break;
    case 'monthly':
      if (!validDayOfMonth(cadence.dayOfMonth)) {
        validation.push({ path: 'cadence.dayOfMonth', code: 'invalid_day_of_month', message: 'Monthly cadence dayOfMonth must be an integer from 1 through 31.' });
      }
      break;
    default:
      validation.push({ path: 'cadence', code: 'invalid_cadence', message: 'Recurring Issue cadence type must be daily, weekly, or monthly.' });
  }
  return validation;
}

export function normalizeRecurringIssueTimeZone(timeZone: string): string | null {
  return resolveTimeZone(timeZone);
}

export function nextRecurringIssueDueAfter(
  cadence: RecurringIssueCadence,
  timeZone: string,
  after: number,
): number | null {
  const resolvedTimeZone = resolveTimeZone(timeZone);
  const localTime = parseLocalTime(cadence.time);
  if (!resolvedTimeZone || !localTime || !Number.isFinite(after)) return null;

  const afterDate = calendarDateAt(after, resolvedTimeZone);
  switch (cadence.type) {
    case 'daily': {
      const candidate = epochForCalendarDateTime(afterDate, localTime, resolvedTimeZone);
      if (candidate !== null && candidate > after) return candidate;
      return epochForCalendarDateTime(addCalendarDays(afterDate, 1), localTime, resolvedTimeZone);
    }
    case 'weekly': {
      const weekdays = validWeekdays(cadence.weekdays);
      if (weekdays.size === 0) return null;
      for (let offset = 0; offset <= 14; offset += 1) {
        const date = addCalendarDays(afterDate, offset);
        if (!weekdays.has(calendarWeekday(date))) continue;
        const candidate = epochForCalendarDateTime(date, localTime, resolvedTimeZone);
        if (candidate !== null && candidate > after) return candidate;
      }
      return null;
    }
    case 'monthly': {
      if (!validDayOfMonth(cadence.dayOfMonth)) return null;
      for (let offset = 0; offset <= 13; offset += 1) {
        const date = calendarDateInMonth(afterDate, offset, cadence.dayOfMonth);
        if (!date) continue;
        const candidate = epochForCalendarDateTime(date, localTime, resolvedTimeZone);
        if (candidate !== null && candidate > after) return candidate;
      }
      return null;
    }
  }
}

export function mostRecentRecurringIssueDueAtOrBefore(
  cadence: RecurringIssueCadence,
  timeZone: string,
  now: number,
  notBefore: number,
): number | null {
  const resolvedTimeZone = resolveTimeZone(timeZone);
  const localTime = parseLocalTime(cadence.time);
  if (
    !resolvedTimeZone
    || !localTime
    || !Number.isFinite(now)
    || !Number.isFinite(notBefore)
    || now < notBefore
  ) return null;

  const nowDate = calendarDateAt(now, resolvedTimeZone);
  switch (cadence.type) {
    case 'daily': {
      for (let offset = 0; offset >= -14; offset -= 1) {
        const candidate = epochForCalendarDateTime(
          addCalendarDays(nowDate, offset),
          localTime,
          resolvedTimeZone,
        );
        if (candidate !== null && candidate <= now) return candidate >= notBefore ? candidate : null;
      }
      return null;
    }
    case 'weekly': {
      const weekdays = validWeekdays(cadence.weekdays);
      if (weekdays.size === 0) return null;
      for (let offset = 0; offset >= -14; offset -= 1) {
        const date = addCalendarDays(nowDate, offset);
        if (!weekdays.has(calendarWeekday(date))) continue;
        const candidate = epochForCalendarDateTime(date, localTime, resolvedTimeZone);
        if (candidate !== null && candidate <= now) return candidate >= notBefore ? candidate : null;
      }
      return null;
    }
    case 'monthly': {
      if (!validDayOfMonth(cadence.dayOfMonth)) return null;
      for (let offset = 0; offset >= -13; offset -= 1) {
        const date = calendarDateInMonth(nowDate, offset, cadence.dayOfMonth);
        if (!date) continue;
        const candidate = epochForCalendarDateTime(date, localTime, resolvedTimeZone);
        if (candidate !== null && candidate <= now) return candidate >= notBefore ? candidate : null;
      }
      return null;
    }
  }
}

export function recurringIssueMissedWindowMetadata(
  input: RecurringIssueMissedWindowMetadataInput,
): RecurringIssueMissedWindowMetadata {
  if (input.missedPolicy.type === 'skip-missed') return {};

  const skippedWindowStarts = new Set(input.skippedWindowStarts ?? []);
  const generatedWindowStarts = new Set(input.generatedWindowStarts);
  let latestGeneratedWindow: number | undefined;
  for (const windowStart of generatedWindowStarts) {
    if (
      windowStart <= input.dueAt
      && (latestGeneratedWindow === undefined || windowStart > latestGeneratedWindow)
    ) {
      latestGeneratedWindow = windowStart;
    }
  }
  const boundary = latestGeneratedWindow ?? input.createdAt;
  let cursor = input.firstEligibleWindowStart
    ?? nextRecurringIssueDueAfter(input.cadence, input.timeZone, boundary);
  let skippedWindowCount = 0;
  let scannedWindowCount = 0;

  while (cursor !== null && cursor < input.dueAt && scannedWindowCount < MAX_WINDOW_SCAN) {
    if (!generatedWindowStarts.has(cursor) && !skippedWindowStarts.has(cursor)) {
      skippedWindowCount += 1;
    }
    const nextCursor = nextRecurringIssueDueAfter(input.cadence, input.timeZone, cursor);
    if (nextCursor === null || nextCursor <= cursor) break;
    cursor = nextCursor;
    scannedWindowCount += 1;
  }

  return skippedWindowCount > 0
    ? {
        skippedWindowCount,
        activityParameter: `coalesced:${skippedWindowCount}`,
      }
    : {};
}

export function formatRecurringIssueWindowDate(windowStartAt: number, timeZone: string): string {
  const resolvedTimeZone = resolveTimeZone(timeZone) ?? 'UTC';
  const date = calendarDateAt(windowStartAt, resolvedTimeZone);
  const year = String(date.year).padStart(4, '0');
  const month = String(date.month).padStart(2, '0');
  const day = String(date.day).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function resolveTimeZone(timeZone: string): string | null {
  const requested = timeZone.trim();
  if (!requested) return null;
  const isLocalAlias = requested.toLowerCase() === 'local';
  const cacheKey = requested;
  if (isLocalAlias) {
    const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: localTimeZone })
        .resolvedOptions()
        .timeZone;
    } catch {
      return null;
    }
  }
  if (resolvedTimeZones.has(cacheKey)) return resolvedTimeZones.get(cacheKey) ?? null;

  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: requested })
      .resolvedOptions()
      .timeZone;
    resolvedTimeZones.set(cacheKey, resolved);
    return resolved;
  } catch {
    resolvedTimeZones.set(cacheKey, null);
    return null;
  }
}

function zonedPartFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = zonedPartFormatters.get(timeZone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  zonedPartFormatters.set(timeZone, formatter);
  return formatter;
}

function calendarDateAt(epochMs: number, timeZone: string): CalendarDate {
  const { year, month, day } = calendarDateTimeAt(epochMs, timeZone);
  return { year, month, day };
}

function calendarDateTimeAt(epochMs: number, timeZone: string): CalendarDateTime {
  const parts = zonedPartFormatter(timeZone).formatToParts(new Date(epochMs));
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of parts) {
    if (part.type === 'literal') continue;
    values[part.type] = Number(part.value);
  }
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour === 24 ? 0 : values.hour!,
    minute: values.minute!,
    second: values.second!,
  };
}

function epochForCalendarDateTime(
  date: CalendarDate,
  time: readonly [hour: number, minute: number],
  timeZone: string,
): number | null {
  if (!validCalendarDate(date)) return null;
  const target: CalendarDateTime = {
    ...date,
    hour: time[0],
    minute: time[1],
    second: 0,
  };
  const targetIndex = calendarDateTimeIndex(target);
  const offsets = new Set<number>();
  for (const delta of OFFSET_PROBE_DELTAS) {
    offsets.add(offsetAt(targetIndex + delta, timeZone));
  }

  // Match Temporal's compatible disambiguation: earlier for overlaps, and the
  // same wall-clock offset shifted forward across a spring gap.
  const candidates = [...offsets]
    .map((offset) => targetIndex - offset)
    .map((epoch) => ({
      epoch,
      wallClockDelta: calendarDateTimeIndex(calendarDateTimeAt(epoch, timeZone)) - targetIndex,
    }));
  const exactCandidates = candidates
    .filter((candidate) => candidate.wallClockDelta === 0)
    .sort((left, right) => left.epoch - right.epoch);
  if (exactCandidates.length > 0) return exactCandidates[0]!.epoch;

  const compatibleGapCandidate = candidates
    .filter((candidate) => candidate.wallClockDelta > 0)
    .sort((left, right) => (
      left.wallClockDelta - right.wallClockDelta
      || left.epoch - right.epoch
    ))[0];
  if (compatibleGapCandidate) return compatibleGapCandidate.epoch;

  return candidates
    .sort((left, right) => (
      Math.abs(left.wallClockDelta) - Math.abs(right.wallClockDelta)
      || left.epoch - right.epoch
    ))[0]?.epoch ?? null;
}

function offsetAt(epochMs: number, timeZone: string): number {
  const wholeSecondEpoch = Math.floor(epochMs / 1_000) * 1_000;
  return calendarDateTimeIndex(calendarDateTimeAt(wholeSecondEpoch, timeZone)) - wholeSecondEpoch;
}

function calendarDateTimeIndex(dateTime: CalendarDateTime): number {
  const date = new Date(0);
  date.setUTCFullYear(dateTime.year, dateTime.month - 1, dateTime.day);
  date.setUTCHours(dateTime.hour, dateTime.minute, dateTime.second, 0);
  return date.getTime();
}

function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(0);
  shifted.setUTCFullYear(date.year, date.month - 1, date.day + days);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function calendarDateInMonth(base: CalendarDate, monthOffset: number, dayOfMonth: number): CalendarDate | null {
  const monthIndex = base.year * 12 + base.month - 1 + monthOffset;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12 + 1;
  const date = { year, month, day: dayOfMonth };
  return validCalendarDate(date) ? date : null;
}

function calendarWeekday(date: CalendarDate): number {
  const value = new Date(0);
  value.setUTCFullYear(date.year, date.month - 1, date.day);
  return value.getUTCDay();
}

function validCalendarDate(date: CalendarDate): boolean {
  if (!Number.isInteger(date.year) || !Number.isInteger(date.month) || !Number.isInteger(date.day)) return false;
  const value = new Date(0);
  value.setUTCFullYear(date.year, date.month - 1, date.day);
  return value.getUTCFullYear() === date.year
    && value.getUTCMonth() + 1 === date.month
    && value.getUTCDate() === date.day;
}

function validDayOfMonth(dayOfMonth: number): boolean {
  return Number.isInteger(dayOfMonth) && dayOfMonth >= 1 && dayOfMonth <= 31;
}

function validWeekdays(weekdays: readonly number[]): Set<number> {
  return new Set(weekdays.filter((weekday) => Number.isInteger(weekday) && weekday >= 0 && weekday <= 6));
}

function parseLocalTime(time: string): readonly [hour: number, minute: number] | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
    ? [hour, minute]
    : null;
}
