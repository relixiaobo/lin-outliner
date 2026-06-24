import {
  dateFieldEndpointDate,
  dateFieldEndpointTime,
  formatDateFieldEndpoint,
  isWeekdayPreset,
  WEEKDAY_PRESET,
  type DateRecurrenceRule,
} from '../../../core/dateFieldValue';
import { formatDateSchedule, parseDateSchedule } from '../../../core/dateSchedule';

// The recurrence presets exposed in the date editor's "Repeat" control (a
// Todoist-style set), shared by the generic date field and the command-schedule
// field. The canonical value string can express richer rules (custom `INTERVAL`,
// a multi-day `BYDAY`) — typically proposed by the agent as text — which map to
// no plain preset; those are preserved verbatim under `custom` so opening the
// editor to tweak the time never silently downgrades the rule.
export type RecurrencePreset =
  | 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly' | 'custom';

// The presets a user can pick from the dropdown. `custom` is never freely
// selectable — it only appears (pre-selected) when the armed value already
// carries a rule no preset represents, so the user can keep it as-is.
export const SELECTABLE_PRESETS: readonly RecurrencePreset[] = [
  'none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly',
];

// The minimal label shape the chip summary needs — a `CommandFieldLabels` (and
// the date-picker labels) is structurally assignable.
export interface RecurrenceLabels {
  recurrence: Record<RecurrencePreset, string>;
  ends: string;
}

export interface ScheduleForm {
  date: string;
  time: string;
  preset: RecurrencePreset;
  until: string;
  /** The originally-parsed recurrence, preserved for the `custom` preset. */
  rule?: DateRecurrenceRule | null;
}

export function presetFromRecurrence(rule: DateRecurrenceRule | undefined): RecurrencePreset {
  if (!rule) return 'none';
  if (rule.interval > 1) return 'custom'; // every-N-units has no plain preset
  switch (rule.frequency) {
    case 'daily':
      return 'daily';
    case 'weekly':
      if (!rule.byDay || rule.byDay.length === 0) return 'weekly';
      return isWeekdayPreset(rule.byDay) ? 'weekdays' : 'custom';
    case 'monthly':
      return 'monthly';
    case 'yearly':
      return 'yearly';
  }
}

// Build the canonical `<endpoint> RRULE:...` string from the editor form, reusing
// the core codec so the stored value is always normalized. `custom` re-emits the
// preserved rule (interval/byDay intact) with only the anchor/until refreshed
// from the form.
export function buildScheduleString(form: ScheduleForm): string | null {
  if (!form.date) return null;
  const anchor = formatDateFieldEndpoint(form.date, form.time);
  let recurrence: DateRecurrenceRule | undefined;
  switch (form.preset) {
    case 'daily':
      recurrence = { frequency: 'daily', interval: 1 };
      break;
    case 'weekdays':
      recurrence = { frequency: 'weekly', interval: 1, byDay: [...WEEKDAY_PRESET] };
      break;
    case 'weekly':
      recurrence = { frequency: 'weekly', interval: 1 };
      break;
    case 'monthly':
      recurrence = { frequency: 'monthly', interval: 1 };
      break;
    case 'yearly':
      recurrence = { frequency: 'yearly', interval: 1 };
      break;
    case 'custom':
      recurrence = form.rule
        ? { ...form.rule, byDay: form.rule.byDay ? [...form.rule.byDay] : undefined }
        : undefined;
      break;
    default:
      recurrence = undefined;
  }
  if (recurrence) {
    if (form.until && form.until >= dateFieldEndpointDate(form.date)) recurrence.until = form.until;
    else delete recurrence.until;
  }
  return formatDateSchedule({ anchor, recurrence });
}

// A short, localized label for a recurring value, built from the editor's own
// recurrence labels so it never disagrees with the dropdown (and is never
// hardcoded English). A custom interval reads as "×N"; a non-weekday BYDAY set
// is summarized as its base frequency (the editor holds the full detail).
export function scheduleChipSummary(schedule: string, labels: RecurrenceLabels): string {
  const parsed = parseDateSchedule(schedule);
  if (!parsed) return '';
  const time = dateFieldEndpointTime(parsed.anchor);
  const date = dateFieldEndpointDate(parsed.anchor);
  const rule = parsed.recurrence;
  if (!rule) return time ? `${date} ${time}` : date;
  let base = labels.recurrence[recurrenceSummaryKey(rule)];
  if (rule.interval > 1) base += ` ×${rule.interval}`;
  const parts = [base];
  if (time) parts.push(time);
  if (rule.until) parts.push(`${labels.ends} ${dateFieldEndpointDate(rule.until)}`);
  return parts.join(' · ');
}

function recurrenceSummaryKey(rule: DateRecurrenceRule): RecurrencePreset {
  switch (rule.frequency) {
    case 'daily':
      return 'daily';
    case 'weekly':
      return rule.byDay && isWeekdayPreset(rule.byDay) ? 'weekdays' : 'weekly';
    case 'monthly':
      return 'monthly';
    case 'yearly':
      return 'yearly';
  }
}
