export const AUTOMATION_WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type AutomationWeekday = typeof AUTOMATION_WEEKDAYS[number];

export const AUTOMATION_SCHEDULE_MODES = [
  'once',
  'hourly',
  'daily',
  'weekdays',
  'weekly',
  'custom',
] as const;
export type AutomationScheduleMode = typeof AUTOMATION_SCHEDULE_MODES[number];

export const AUTOMATION_CUSTOM_FREQUENCIES = [
  'hourly',
  'daily',
  'weekly',
  'monthly',
  'yearly',
] as const;
export type AutomationCustomFrequency = typeof AUTOMATION_CUSTOM_FREQUENCIES[number];

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR'] as const;
const WEEKDAY_BY_DAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
const DEFAULT_START_DATE = new Date(Date.UTC(1970, 0, 5));

export interface AutomationScheduleDraft {
  readonly mode: AutomationScheduleMode;
  readonly startAt: string;
  readonly weekdays: readonly AutomationWeekday[];
  readonly customFrequency: AutomationCustomFrequency;
  readonly interval: number;
  readonly month: number;
  readonly monthDays: readonly number[];
  readonly minute: number;
  readonly sourceRrule: string | null;
}

interface ParsedSchedule {
  readonly startAt: string;
  readonly fields: ReadonlyMap<string, string>;
  readonly hasSubMinutePrecision: boolean;
}

export function createAutomationScheduleDraft(rrule?: string): AutomationScheduleDraft {
  const fallback = defaultAutomationScheduleDraft();
  if (!rrule) return fallback;
  const parsed = parseSchedule(rrule);
  if (!parsed) return fallback;
  const mode = scheduleMode(parsed.fields);
  const customFrequency = customFrequencyFromFields(parsed.fields) ?? 'daily';
  const weekdays = weekdaysFromFields(parsed.fields);
  const draft: AutomationScheduleDraft = {
    mode,
    startAt: parsed.startAt,
    weekdays: weekdays.length > 0 ? weekdays : [weekdayFromStartAt(parsed.startAt)],
    customFrequency,
    interval: boundedInteger(parsed.fields.get('INTERVAL'), 1, 999, 1),
    month: boundedInteger(parsed.fields.get('BYMONTH'), 1, 12, monthFromStartAt(parsed.startAt)),
    monthDays: monthDaysFromFields(parsed.fields, dayFromStartAt(parsed.startAt)),
    minute: boundedInteger(parsed.fields.get('BYMINUTE'), 0, 59, minuteFromStartAt(parsed.startAt)),
    sourceRrule: null,
  };
  const canonical = isAutomationScheduleDraftValid(draft) ? automationScheduleRrule(draft) : null;
  return {
    ...draft,
    sourceRrule: parsed.hasSubMinutePrecision
      || !isStructuredShape(parsed.fields)
      || canonical !== rrule
      ? rrule
      : null,
  };
}

export function defaultAutomationScheduleDraft(): AutomationScheduleDraft {
  const startAt = defaultStartAt();
  return {
    mode: 'daily',
    startAt,
    weekdays: [weekdayFromStartAt(startAt)],
    customFrequency: 'daily',
    interval: 1,
    month: monthFromStartAt(startAt),
    monthDays: [dayFromStartAt(startAt)],
    minute: minuteFromStartAt(startAt),
    sourceRrule: null,
  };
}

export function automationScheduleRrule(draft: AutomationScheduleDraft): string {
  if (draft.sourceRrule) return draft.sourceRrule;
  if (!isAutomationScheduleDraftValid(draft)) throw new Error('Invalid Automation schedule');
  const startAt = startAtForDraft(draft);
  const rule = ruleForDraft(draft);
  return `DTSTART:${startAt.replace(/[-:]/g, '')}00\nRRULE:${rule}`;
}

export function isAutomationScheduleDraftValid(draft: AutomationScheduleDraft): boolean {
  if (!validStartAt(draft.startAt)) return false;
  if (!Number.isInteger(draft.interval) || draft.interval < 1 || draft.interval > 999) return false;
  if (!Number.isInteger(draft.minute) || draft.minute < 0 || draft.minute > 59) return false;
  if (!Number.isInteger(draft.month) || draft.month < 1 || draft.month > 12) return false;
  if (draft.mode === 'weekly' || (draft.mode === 'custom' && draft.customFrequency === 'weekly')) {
    if (draft.weekdays.length === 0
      || new Set(draft.weekdays).size !== draft.weekdays.length
      || draft.weekdays.some((weekday) => !AUTOMATION_WEEKDAYS.includes(weekday))) return false;
  }
  if (draft.mode === 'custom' && (draft.customFrequency === 'monthly' || draft.customFrequency === 'yearly')) {
    if (draft.monthDays.length === 0) return false;
    if (new Set(draft.monthDays).size !== draft.monthDays.length
      || draft.monthDays.some((day) => !Number.isInteger(day) || day < 1 || day > 31)) return false;
  }
  return true;
}

export function updateAutomationScheduleMode(
  draft: AutomationScheduleDraft,
  mode: AutomationScheduleMode,
): AutomationScheduleDraft {
  if (mode === 'weekdays') return { ...draft, mode, weekdays: [...WEEKDAYS], sourceRrule: null };
  if (mode === 'hourly') {
    return {
      ...draft,
      mode,
      startAt: replaceStartAtPart(draft.startAt, 'time', `${startAtTime(draft.startAt).slice(0, 2)}:00`),
      sourceRrule: null,
    };
  }
  return { ...draft, mode, sourceRrule: null };
}

export function updateAutomationScheduleTime(draft: AutomationScheduleDraft, time: string): AutomationScheduleDraft {
  return { ...draft, startAt: replaceStartAtPart(draft.startAt, 'time', time), sourceRrule: null };
}

export function updateAutomationScheduleDate(draft: AutomationScheduleDraft, date: string): AutomationScheduleDraft {
  return { ...draft, startAt: replaceStartAtPart(draft.startAt, 'date', date), sourceRrule: null };
}

export function startAtDate(startAt: string): string {
  return startAt.slice(0, 10);
}

export function startAtTime(startAt: string): string {
  return startAt.slice(11, 16);
}

export function scheduleModeFromRrule(rrule: string): AutomationScheduleMode {
  return createAutomationScheduleDraft(rrule).mode;
}

function ruleForDraft(draft: AutomationScheduleDraft): string {
  switch (draft.mode) {
    case 'once':
      return 'FREQ=DAILY;COUNT=1';
    case 'hourly':
      return 'FREQ=HOURLY';
    case 'daily':
      return 'FREQ=DAILY';
    case 'weekdays':
      return `FREQ=WEEKLY;BYDAY=${WEEKDAYS.join(',')}`;
    case 'weekly':
      return `FREQ=WEEKLY;BYDAY=${orderedWeekdays(draft.weekdays).join(',')}`;
    case 'custom':
      return customRule(draft);
  }
}

function customRule(draft: AutomationScheduleDraft): string {
  const time = startAtTime(draft.startAt);
  const [hour, minute] = time.split(':').map(Number);
  const prefix = `FREQ=${draft.customFrequency.toUpperCase()};INTERVAL=${draft.interval}`;
  switch (draft.customFrequency) {
    case 'hourly':
      return `${prefix};BYMINUTE=${draft.minute}`;
    case 'daily':
      return `${prefix};BYHOUR=${hour};BYMINUTE=${minute}`;
    case 'weekly':
      return `${prefix};BYDAY=${orderedWeekdays(draft.weekdays).join(',')};BYHOUR=${hour};BYMINUTE=${minute}`;
    case 'monthly':
      return `${prefix};BYMONTHDAY=${orderedMonthDays(draft.monthDays).join(',')};BYHOUR=${hour};BYMINUTE=${minute}`;
    case 'yearly':
      return `${prefix};BYMONTH=${draft.month};BYMONTHDAY=${orderedMonthDays(draft.monthDays).join(',')};BYHOUR=${hour};BYMINUTE=${minute}`;
  }
}

function startAtForDraft(draft: AutomationScheduleDraft): string {
  if (draft.mode === 'weekly' || (draft.mode === 'custom' && draft.customFrequency === 'weekly')) {
    return alignStartAtToWeekdays(draft.startAt, draft.weekdays);
  }
  if (draft.mode === 'weekdays') return alignStartAtToWeekdays(draft.startAt, WEEKDAYS);
  if (draft.mode === 'custom' && draft.customFrequency === 'hourly') {
    return replaceStartAtPart(draft.startAt, 'time', `${startAtTime(draft.startAt).slice(0, 2)}:${String(draft.minute).padStart(2, '0')}`);
  }
  return draft.startAt;
}

function scheduleMode(fields: ReadonlyMap<string, string>): AutomationScheduleMode {
  const frequency = fields.get('FREQ');
  if (hasOnlyFields(fields, ['FREQ', 'COUNT']) && frequency === 'DAILY' && fields.get('COUNT') === '1') return 'once';
  if (hasOnlyFields(fields, ['FREQ']) && frequency === 'HOURLY') return 'hourly';
  if (hasOnlyFields(fields, ['FREQ']) && frequency === 'DAILY') return 'daily';
  if (hasOnlyFields(fields, ['FREQ', 'BYDAY']) && frequency === 'WEEKLY') {
    const weekdays = weekdaysFromFields(fields);
    if (sameValues(weekdays, WEEKDAYS)) return 'weekdays';
    if (weekdays.length > 0) return 'weekly';
  }
  return 'custom';
}

function customFrequencyFromFields(fields: ReadonlyMap<string, string>): AutomationCustomFrequency | null {
  const frequency = fields.get('FREQ')?.toLowerCase();
  return AUTOMATION_CUSTOM_FREQUENCIES.find((candidate) => candidate === frequency) ?? null;
}

function parseSchedule(source: string): ParsedSchedule | null {
  const start = /^DTSTART:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/m.exec(source);
  const rule = /^RRULE:(.+)$/m.exec(source)?.[1]?.trim().toUpperCase();
  if (!start || !rule) return null;
  const fields = new Map<string, string>();
  for (const part of rule.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) return null;
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (!value || fields.has(key)) return null;
    fields.set(key, value);
  }
  if (!fields.has('FREQ')) return null;
  return {
    startAt: `${start[1]}-${start[2]}-${start[3]}T${start[4]}:${start[5]}`,
    fields,
    hasSubMinutePrecision: start[6] !== '00',
  };
}

function isStructuredShape(fields: ReadonlyMap<string, string>): boolean {
  const mode = scheduleMode(fields);
  if (mode === 'once' || mode === 'hourly' || mode === 'daily') return true;
  if (mode === 'weekdays' || mode === 'weekly') return isWeekdayList(fields.get('BYDAY'));
  if (!isIntegerField(fields.get('INTERVAL'), 1, 999)) return false;
  switch (fields.get('FREQ')) {
    case 'HOURLY':
      return hasOnlyFields(fields, ['FREQ', 'INTERVAL', 'BYMINUTE'])
        && isIntegerField(fields.get('BYMINUTE'), 0, 59);
    case 'DAILY':
      return hasOnlyFields(fields, ['FREQ', 'INTERVAL', 'BYHOUR', 'BYMINUTE'])
        && isIntegerField(fields.get('BYHOUR'), 0, 23)
        && isIntegerField(fields.get('BYMINUTE'), 0, 59);
    case 'WEEKLY':
      return hasOnlyFields(fields, ['FREQ', 'INTERVAL', 'BYDAY', 'BYHOUR', 'BYMINUTE'])
        && isWeekdayList(fields.get('BYDAY'))
        && isIntegerField(fields.get('BYHOUR'), 0, 23)
        && isIntegerField(fields.get('BYMINUTE'), 0, 59);
    case 'MONTHLY':
      return hasOnlyFields(fields, ['FREQ', 'INTERVAL', 'BYMONTHDAY', 'BYHOUR', 'BYMINUTE'])
        && isIntegerList(fields.get('BYMONTHDAY'), 1, 31)
        && isIntegerField(fields.get('BYHOUR'), 0, 23)
        && isIntegerField(fields.get('BYMINUTE'), 0, 59);
    case 'YEARLY':
      return hasOnlyFields(fields, ['FREQ', 'INTERVAL', 'BYMONTH', 'BYMONTHDAY', 'BYHOUR', 'BYMINUTE'])
        && isIntegerField(fields.get('BYMONTH'), 1, 12)
        && isIntegerList(fields.get('BYMONTHDAY'), 1, 31)
        && isIntegerField(fields.get('BYHOUR'), 0, 23)
        && isIntegerField(fields.get('BYMINUTE'), 0, 59);
    default:
      return false;
  }
}

function isWeekdayList(value: string | undefined): boolean {
  if (!value) return false;
  const values = value.split(',');
  return values.length > 0
    && new Set(values).size === values.length
    && values.every((weekday) => AUTOMATION_WEEKDAYS.includes(weekday as AutomationWeekday));
}

function isIntegerList(value: string | undefined, min: number, max: number): boolean {
  if (!value) return false;
  const values = value.split(',');
  return values.length > 0
    && new Set(values).size === values.length
    && values.every((item) => isIntegerField(item, min, max));
}

function isIntegerField(value: string | undefined, min: number, max: number): boolean {
  if (!value || !/^\d+$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max;
}

function weekdaysFromFields(fields: ReadonlyMap<string, string>): AutomationWeekday[] {
  const values = fields.get('BYDAY')?.split(',') ?? [];
  if (values.some((value) => !AUTOMATION_WEEKDAYS.includes(value as AutomationWeekday))) return [];
  return orderedWeekdays(values as AutomationWeekday[]);
}

function monthDaysFromFields(fields: ReadonlyMap<string, string>, fallback: number): number[] {
  const values = fields.get('BYMONTHDAY')?.split(',').map(Number) ?? [fallback];
  if (values.some((value) => !Number.isInteger(value) || value < 1 || value > 31)) return [fallback];
  return orderedMonthDays(values);
}

function orderedWeekdays(values: readonly AutomationWeekday[]): AutomationWeekday[] {
  const selected = new Set(values);
  return AUTOMATION_WEEKDAYS.filter((weekday) => selected.has(weekday));
}

function orderedMonthDays(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function hasOnlyFields(fields: ReadonlyMap<string, string>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return fields.size === allowedSet.size && [...fields.keys()].every((key) => allowedSet.has(key));
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function boundedInteger(value: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function replaceStartAtPart(startAt: string, part: 'date' | 'time', value: string): string {
  return part === 'date' ? `${value}T${startAtTime(startAt)}` : `${startAtDate(startAt)}T${value}`;
}

function validStartAt(startAt: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(startAt);
  if (!match) return false;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  if (hour > 23 || minute > 59) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function weekdayFromStartAt(startAt: string): AutomationWeekday {
  return WEEKDAY_BY_DAY[parseStartAtDate(startAt).getUTCDay()] ?? 'MO';
}

function dayFromStartAt(startAt: string): number {
  return parseStartAtDate(startAt).getUTCDate();
}

function monthFromStartAt(startAt: string): number {
  return parseStartAtDate(startAt).getUTCMonth() + 1;
}

function minuteFromStartAt(startAt: string): number {
  const minute = Number(startAtTime(startAt).slice(3, 5));
  return Number.isInteger(minute) ? minute : 0;
}

function alignStartAtToWeekdays(startAt: string, weekdays: readonly AutomationWeekday[]): string {
  const date = parseStartAtDate(startAt);
  const selectedDays = weekdays.map((weekday) => WEEKDAY_BY_DAY.indexOf(weekday));
  const offsets = selectedDays.map((day) => (day - date.getUTCDay() + 7) % 7);
  date.setUTCDate(date.getUTCDate() + Math.min(...offsets));
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}T${startAtTime(startAt)}`;
}

function parseStartAtDate(startAt: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}$/.exec(startAt);
  if (!match) return new Date(DEFAULT_START_DATE);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function defaultStartAt(): string {
  const date = new Date(Date.now() + 60 * 60 * 1_000);
  date.setMinutes(0, 0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
