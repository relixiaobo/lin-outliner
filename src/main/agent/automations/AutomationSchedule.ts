import { RRule, rrulestr } from 'rrule';
import type { AutomationSchedule } from '../../../core/agent/automation';

const MAX_OCCURRENCES_PER_EVALUATION = 1_000;
const SUPPORTED_FREQUENCIES = new Set([RRule.HOURLY, RRule.DAILY, RRule.WEEKLY, RRule.MONTHLY, RRule.YEARLY]);

export interface AutomationOccurrenceBatch {
  readonly occurrences: readonly number[];
  readonly truncated: boolean;
  readonly evaluatedThrough: number;
}

export function normalizeAutomationSchedule(schedule: AutomationSchedule): AutomationSchedule {
  assertTimeZone(schedule.timezone);
  const source = normalizeRruleSource(schedule.rrule, schedule.timezone);
  const prepared = prepareRruleSource(source, schedule.timezone);
  const parsed = parseRule(prepared.source);
  if (!SUPPORTED_FREQUENCIES.has(parsed.options.freq)) {
    throw new Error('Automation RRULE frequency must be HOURLY, DAILY, WEEKLY, MONTHLY, or YEARLY');
  }
  const dtstart = parsed.options.dtstart;
  if (!dtstart) throw new Error('Automation RRULE requires DTSTART');
  let normalizedRule = parsed.toString()
      .replace(/DTSTART;TZID=[^:]+:/, 'DTSTART:')
      .replace(/^(DTSTART:\d{8}T\d{6})Z$/m, '$1');
  if (prepared.utcUntilStamp) {
    normalizedRule = normalizedRule.replace(
      /\bUNTIL=\d{8}T\d{6}Z\b/,
      `UNTIL=${prepared.utcUntilStamp}Z`,
    );
  } else if (prepared.localUntilStamp) {
    normalizedRule = normalizedRule.replace(
      /\bUNTIL=\d{8}T\d{6}Z\b/,
      `UNTIL=${prepared.localUntilStamp}`,
    );
  }
  return Object.freeze({
    rrule: normalizedRule,
    timezone: schedule.timezone,
  });
}

export function nextAutomationOccurrence(
  schedule: AutomationSchedule,
  afterExclusive: number,
): number | null {
  const normalized = normalizeAutomationSchedule(schedule);
  const prepared = prepareRruleSource(normalized.rrule, normalized.timezone);
  const rule = parseRule(prepared.source);
  let wall = rule.after(instantToWallDate(afterExclusive, normalized.timezone), false);
  for (let attempts = 0; wall && attempts < 8; attempts += 1) {
    const instant = wallDateToInstant(wall, normalized.timezone);
    if (instant !== null && prepared.utcUntil !== null && instant > prepared.utcUntil) return null;
    if (instant !== null && instant > afterExclusive) return instant;
    wall = rule.after(wall, false);
  }
  return null;
}

export function automationOccurrencesBetween(
  schedule: AutomationSchedule,
  afterExclusive: number,
  throughInclusive: number,
  limit = MAX_OCCURRENCES_PER_EVALUATION,
): AutomationOccurrenceBatch {
  if (!Number.isSafeInteger(afterExclusive) || !Number.isSafeInteger(throughInclusive)) {
    throw new Error('Automation occurrence bounds must be integer timestamps');
  }
  if (throughInclusive <= afterExclusive) {
    return { occurrences: Object.freeze([]), truncated: false, evaluatedThrough: throughInclusive };
  }
  const normalized = normalizeAutomationSchedule(schedule);
  const prepared = prepareRruleSource(normalized.rrule, normalized.timezone);
  const rule = parseRule(prepared.source);
  const wallStart = instantToWallDate(afterExclusive - 36 * 60 * 60 * 1_000, normalized.timezone);
  const wallEnd = instantToWallDate(throughInclusive + 36 * 60 * 60 * 1_000, normalized.timezone);
  const occurrences: number[] = [];
  let truncated = false;
  let evaluatedThrough = throughInclusive;
  rule.between(wallStart, wallEnd, true, (wall, index) => {
    const instant = wallDateToInstant(wall, normalized.timezone);
    if (
      instant === null
      || instant <= afterExclusive
      || instant > throughInclusive
      || (prepared.utcUntil !== null && instant > prepared.utcUntil)
    ) return true;
    if (occurrences.length >= limit) {
      truncated = true;
      evaluatedThrough = occurrences.at(-1)!;
      return false;
    }
    occurrences.push(instant);
    return index < Number.MAX_SAFE_INTEGER;
  });
  return {
    occurrences: Object.freeze(occurrences),
    truncated,
    evaluatedThrough,
  };
}

export function defaultAutomationSchedule(
  startAt: number,
  timezone: string,
  frequency: 'once' | 'hourly' | 'daily' | 'weekly',
): AutomationSchedule {
  assertTimeZone(timezone);
  const wall = instantToWallDate(startAt, timezone);
  const stamp = wallStamp(wall);
  const recurrence = frequency === 'once'
    ? 'FREQ=DAILY;COUNT=1'
    : frequency === 'hourly'
      ? 'FREQ=HOURLY'
      : frequency === 'daily'
        ? 'FREQ=DAILY'
        : `FREQ=WEEKLY;BYDAY=${weekdayToken(wall.getUTCDay())}`;
  return normalizeAutomationSchedule({
    rrule: `DTSTART:${stamp}\nRRULE:${recurrence}`,
    timezone,
  });
}

function normalizeRruleSource(source: string, timezone: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.some((line) => /^(RDATE|EXDATE|EXRULE):/i.test(line))) {
    throw new Error('Automation schedules support one DTSTART and one RRULE only');
  }
  const dtstarts = lines.filter((line) => /^DTSTART(?:;[^:]*)?:/i.test(line));
  const rules = lines.filter((line) => /^RRULE:/i.test(line));
  if (dtstarts.length !== 1 || rules.length !== 1 || lines.length !== 2) {
    throw new Error('Automation schedule must contain exactly one DTSTART and one RRULE');
  }
  const dtstart = dtstarts[0]!;
  const match = /^DTSTART(?:;TZID=([^:]+))?:(\d{8}T\d{6})$/i.exec(dtstart);
  if (!match) throw new Error('Automation DTSTART must be a local YYYYMMDDTHHMMSS value');
  if (match[1] && match[1] !== timezone) {
    throw new Error('Automation DTSTART TZID must match schedule.timezone');
  }
  return `DTSTART:${match[2]}\n${rules[0]!.toUpperCase()}`;
}

function prepareRruleSource(
  source: string,
  timezone: string,
): {
  readonly source: string;
  readonly utcUntil: number | null;
  readonly utcUntilStamp: string | null;
  readonly localUntilStamp: string | null;
} {
  const match = /\bUNTIL=(\d{8}T\d{6})Z\b/.exec(source);
  if (!match) {
    return {
      source,
      utcUntil: null,
      utcUntilStamp: null,
      localUntilStamp: /\bUNTIL=(\d{8}T\d{6})(?!Z)\b/.exec(source)?.[1] ?? null,
    };
  }
  const stamp = match[1]!;
  const utcUntil = utcStampToInstant(stamp);
  const wallUntil = wallStamp(instantToWallDate(utcUntil, timezone));
  return {
    source: source.replace(`UNTIL=${stamp}Z`, `UNTIL=${wallUntil}`),
    utcUntil,
    utcUntilStamp: stamp,
    localUntilStamp: null,
  };
}

function utcStampToInstant(stamp: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (!match) throw new Error(`Invalid Automation UTC UNTIL: ${stamp}Z`);
  const instant = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  if (wallStamp(new Date(instant)) !== stamp) {
    throw new Error(`Invalid Automation UTC UNTIL: ${stamp}Z`);
  }
  return instant;
}

function parseRule(source: string): RRule {
  let parsed: ReturnType<typeof rrulestr>;
  try {
    parsed = rrulestr(source, { forceset: false, compatible: false });
  } catch (error) {
    throw new Error(`Invalid Automation RRULE: ${errorMessage(error)}`);
  }
  if (!(parsed instanceof RRule)) throw new Error('Automation schedule must contain exactly one RRULE');
  return parsed;
}

function assertTimeZone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
  } catch {
    throw new Error(`Unknown Automation timezone: ${timezone}`);
  }
}

function instantToWallDate(instant: number, timezone: string): Date {
  const parts = wallParts(new Date(instant), timezone);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
}

function wallDateToInstant(wall: Date, timezone: string): number | null {
  const target = {
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth() + 1,
    day: wall.getUTCDate(),
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
    second: wall.getUTCSeconds(),
  };
  const wallUtc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
  const offsets = new Set([
    zoneOffsetAt(wallUtc - 36 * 60 * 60 * 1_000, timezone),
    zoneOffsetAt(wallUtc, timezone),
    zoneOffsetAt(wallUtc + 36 * 60 * 60 * 1_000, timezone),
  ]);
  const candidates = [...offsets]
    .map((offset) => wallUtc - offset)
    .filter((candidate) => sameWallParts(wallParts(new Date(candidate), timezone), target))
    .sort((left, right) => left - right);
  return candidates[0] ?? null;
}

function zoneOffsetAt(instant: number, timezone: string): number {
  const parts = wallParts(new Date(instant), timezone);
  const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return represented - Math.floor(instant / 1_000) * 1_000;
}

function wallParts(date: Date, timezone: string): WallParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    calendar: 'iso8601',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type)?.value;
    if (!part) throw new Error(`Could not resolve ${type} for Automation timezone ${timezone}`);
    return Number(part);
  };
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

interface WallParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function sameWallParts(left: WallParts, right: WallParts): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute
    && left.second === right.second;
}

function wallStamp(date: Date): string {
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
    'T',
    String(date.getUTCHours()).padStart(2, '0'),
    String(date.getUTCMinutes()).padStart(2, '0'),
    String(date.getUTCSeconds()).padStart(2, '0'),
  ].join('');
}

function weekdayToken(day: number): string {
  return ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][day] ?? 'MO';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
