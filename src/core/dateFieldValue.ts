import {
  addLocalDays,
  addLocalMinutes,
  dateFromIsoLocalDate,
  dateFromIsoLocalDateTime,
  normalizedIsoLocalDateTime,
  normalizedIsoLocalDate,
} from './localDate';

export type DateFieldValue =
  | { kind: 'single'; date: string }
  | { kind: 'range'; start: string; end: string };

export interface DateFieldValueRange {
  start: string;
  end: string;
  startMs: number;
  endExclusiveMs: number;
}

const DATE_FIELD_ENDPOINT_SOURCE = String.raw`\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?`;
const DATE_FIELD_ENDPOINT_PATTERN = new RegExp(`^${DATE_FIELD_ENDPOINT_SOURCE}$`);
const DATE_FIELD_ENDPOINT_IN_TEXT_PATTERN = new RegExp(`\\b(${DATE_FIELD_ENDPOINT_SOURCE})\\b`, 'g');
const DATE_FIELD_RANGE_PATTERN = new RegExp(`^(${DATE_FIELD_ENDPOINT_SOURCE})\\s*/\\s*(${DATE_FIELD_ENDPOINT_SOURCE})$`);
const DATE_FIELD_RANGE_IN_TEXT_PATTERN = new RegExp(`\\b(${DATE_FIELD_ENDPOINT_SOURCE})\\s*/\\s*(${DATE_FIELD_ENDPOINT_SOURCE})\\b`, 'g');

export function parseDateFieldValue(raw: string): DateFieldValue | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

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
  if (value.kind === 'single') return value.date;
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
