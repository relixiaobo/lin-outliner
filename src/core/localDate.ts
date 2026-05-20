export interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

export interface LocalDateTimeParts extends LocalDateParts {
  hour: number;
  minute: number;
}

const ISO_LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_LOCAL_DATE_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;

export function parseIsoLocalDateParts(raw: string): LocalDateParts | null {
  const match = raw.trim().match(ISO_LOCAL_DATE_PATTERN);
  if (!match) return null;
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  const date = new Date(parts.year, parts.month - 1, parts.day);
  return date.getFullYear() === parts.year
    && date.getMonth() === parts.month - 1
    && date.getDate() === parts.day
    ? parts
    : null;
}

export function normalizedIsoLocalDate(raw: string): string | null {
  const parts = parseIsoLocalDateParts(raw);
  return parts ? formatIsoLocalDateParts(parts) : null;
}

export function parseIsoLocalDateTimeParts(raw: string): LocalDateTimeParts | null {
  const match = raw.trim().match(ISO_LOCAL_DATE_TIME_PATTERN);
  if (!match) return null;
  const dateParts = parseIsoLocalDateParts(match[1]!);
  if (!dateParts) return null;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { ...dateParts, hour, minute };
}

export function normalizedIsoLocalDateTime(raw: string): string | null {
  const parts = parseIsoLocalDateTimeParts(raw);
  return parts ? formatIsoLocalDateTimeParts(parts) : null;
}

export function formatIsoLocalDateParts(parts: LocalDateParts): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function formatIsoLocalDateTimeParts(parts: LocalDateTimeParts): string {
  return `${formatIsoLocalDateParts(parts)}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

export function isoLocalDate(date: Date): string {
  return formatIsoLocalDateParts({
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  });
}

export function isoLocalDateTime(date: Date): string {
  return formatIsoLocalDateTimeParts({
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
  });
}

export function parseIsoLocalDate(raw: string): Date | null {
  const parts = parseIsoLocalDateParts(raw);
  return parts ? new Date(parts.year, parts.month - 1, parts.day) : null;
}

export function parseIsoLocalDateTime(raw: string): Date | null {
  const parts = parseIsoLocalDateTimeParts(raw);
  return parts ? new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) : null;
}

export function dateFromIsoLocalDate(value: string): Date {
  const date = parseIsoLocalDate(value);
  if (!date) throw new Error(`Invalid ISO local date: ${value}`);
  return date;
}

export function dateFromIsoLocalDateTime(value: string): Date {
  const date = parseIsoLocalDateTime(value);
  if (!date) throw new Error(`Invalid ISO local date-time: ${value}`);
  return date;
}

export function compareIsoLocalDates(left: string, right: string): number {
  return dateFromIsoLocalDate(left).getTime() - dateFromIsoLocalDate(right).getTime();
}

export function todayIsoLocalDate(): string {
  return isoLocalDate(new Date());
}

export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function startOfLocalWeek(date: Date): Date {
  const day = date.getDay() || 7;
  return addLocalDays(startOfLocalDay(date), 1 - day);
}

export function addLocalDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function addLocalMinutes(date: Date, minutes: number): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes() + minutes,
  );
}

export function offsetIsoLocalDate(isoDate: string, deltaDays: number): string {
  const date = parseIsoLocalDate(isoDate);
  return date ? isoLocalDate(addLocalDays(date, deltaDays)) : isoDate;
}
