import { useMemo, useState } from 'react';
import {
  formatDateSchedule,
  isWeekdayPreset,
  parseDateSchedule,
  WEEKDAY_PRESET,
  type DateRecurrenceRule,
  type DateSchedule,
} from '../../../core/dateSchedule';
import {
  dateFieldEndpointDate,
  dateFieldEndpointTime,
  formatDateFieldEndpoint,
} from '../../../core/dateFieldValue';

// Recurrence presets exposed in the editor (a Todoist-style "Repeat" set). The
// canonical schedule string can express richer rules (custom `INTERVAL`, a
// multi-day `BYDAY`) — typically proposed by the agent as text — which don't map
// to a simple preset. Those are preserved verbatim under the `custom` option so
// opening the editor to tweak the time never silently downgrades the rule.
export type CommandRecurrencePreset =
  | 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly' | 'custom';

export interface CommandNodeControlsLabels {
  enableSchedule: string;
  runNow: string;
  save: string;
  cancel: string;
  clear: string;
  date: string;
  time: string;
  repeat: string;
  ends: string;
  recurrence: Record<CommandRecurrencePreset, string>;
}

export interface CommandNodeControlsProps {
  /** The command node's canonical schedule string, or null when manual-only. */
  schedule: string | null;
  labels: CommandNodeControlsLabels;
  /** Write the user-armed schedule (null clears it). Wired to set_command_schedule. */
  onSetSchedule: (schedule: string | null) => void;
  /** Run the command attended, right now (never disturbs the schedule). */
  onRunNow: () => void;
  readOnly?: boolean;
  busy?: boolean;
}

// The presets a user can pick from the dropdown. `custom` is never freely
// selectable — it only appears (pre-selected) when the armed schedule already
// carries a rule no preset represents, so the user can keep it as-is.
const SELECTABLE_PRESETS: readonly CommandRecurrencePreset[] = [
  'none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly',
];

export function CommandNodeControls(props: CommandNodeControlsProps) {
  const { schedule, labels, onSetSchedule, onRunNow, readOnly, busy } = props;
  const [editing, setEditing] = useState(false);

  const summary = useMemo(() => (schedule ? scheduleChipSummary(schedule, labels) : ''), [schedule, labels]);

  return (
    <div className="command-node-controls" data-testid="command-node-controls">
      <div className="command-node-controls__bar">
        {!editing && (
          <button
            type="button"
            className="command-schedule-chip"
            data-armed={schedule ? 'true' : 'false'}
            disabled={readOnly}
            onClick={() => setEditing(true)}
          >
            {schedule ? summary : labels.enableSchedule}
          </button>
        )}
        <button
          type="button"
          className="command-run-now"
          disabled={readOnly || busy}
          onClick={onRunNow}
        >
          {labels.runNow}
        </button>
      </div>
      {editing && (
        <CommandScheduleEditor
          schedule={schedule}
          labels={labels}
          onCancel={() => setEditing(false)}
          onClear={() => {
            onSetSchedule(null);
            setEditing(false);
          }}
          onSave={(next) => {
            onSetSchedule(next);
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}

interface EditorProps {
  schedule: string | null;
  labels: CommandNodeControlsLabels;
  onCancel: () => void;
  onClear: () => void;
  onSave: (schedule: string) => void;
}

function CommandScheduleEditor({ schedule, labels, onCancel, onClear, onSave }: EditorProps) {
  const initial = useMemo(() => formStateFromSchedule(schedule), [schedule]);
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [preset, setPreset] = useState<CommandRecurrencePreset>(initial.preset);
  const [until, setUntil] = useState(initial.until);

  // An "Ends" date before the start would arm a schedule that can never fire;
  // block Save (and constrain the picker) rather than store a silently-dead rule.
  const untilBeforeStart = until !== '' && date !== '' && until < date;
  const next = !date || untilBeforeStart
    ? null
    : buildScheduleString({ date, time, preset, until, rule: initial.rule });

  const presetOptions = preset === 'custom' ? (['custom', ...SELECTABLE_PRESETS] as const) : SELECTABLE_PRESETS;

  return (
    <div className="command-schedule-editor">
      <label className="command-schedule-field">
        <span>{labels.date}</span>
        <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
      </label>
      <label className="command-schedule-field">
        <span>{labels.time}</span>
        <input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
      </label>
      <label className="command-schedule-field">
        <span>{labels.repeat}</span>
        <select value={preset} onChange={(event) => setPreset(event.target.value as CommandRecurrencePreset)}>
          {presetOptions.map((option) => (
            <option key={option} value={option}>{labels.recurrence[option]}</option>
          ))}
        </select>
      </label>
      {preset !== 'none' && (
        <label className="command-schedule-field">
          <span>{labels.ends}</span>
          <input
            type="date"
            value={until}
            min={date || undefined}
            onChange={(event) => setUntil(event.target.value)}
          />
        </label>
      )}
      <div className="command-schedule-editor__actions">
        <button type="button" className="command-schedule-save" disabled={!next} onClick={() => next && onSave(next)}>
          {labels.save}
        </button>
        {schedule && (
          <button type="button" className="command-schedule-clear" onClick={onClear}>
            {labels.clear}
          </button>
        )}
        <button type="button" className="command-schedule-cancel" onClick={onCancel}>
          {labels.cancel}
        </button>
      </div>
    </div>
  );
}

interface FormState {
  date: string;
  time: string;
  preset: CommandRecurrencePreset;
  until: string;
  /** The originally-parsed recurrence, preserved for the `custom` preset. */
  rule: DateRecurrenceRule | null;
}

function formStateFromSchedule(schedule: string | null): FormState {
  const parsed = schedule ? parseDateSchedule(schedule) : null;
  if (!parsed) return { date: '', time: '', preset: 'none', until: '', rule: null };
  return {
    date: dateFieldEndpointDate(parsed.anchor),
    time: dateFieldEndpointTime(parsed.anchor),
    preset: presetFromRule(parsed.recurrence),
    until: parsed.recurrence?.until ? dateFieldEndpointDate(parsed.recurrence.until) : '',
    rule: parsed.recurrence ?? null,
  };
}

function presetFromRule(rule: DateSchedule['recurrence']): CommandRecurrencePreset {
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

interface ScheduleForm {
  date: string;
  time: string;
  preset: CommandRecurrencePreset;
  until: string;
  rule?: DateRecurrenceRule | null;
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
    if (form.until) recurrence.until = form.until;
    else delete recurrence.until;
  }
  return formatDateSchedule({ anchor, recurrence });
}

// A short, localized label for the schedule chip, built from the editor's own
// recurrence labels so it never disagrees with the dropdown (and is never
// hardcoded English). A custom interval reads as "×N"; a non-weekday BYDAY set
// is summarized as its base frequency (the editor holds the full detail).
export function scheduleChipSummary(schedule: string, labels: CommandNodeControlsLabels): string {
  const parsed = parseDateSchedule(schedule);
  if (!parsed) return '';
  const time = dateFieldEndpointTime(parsed.anchor);
  const date = dateFieldEndpointDate(parsed.anchor);
  const rule = parsed.recurrence;
  if (!rule) return time ? `${date} ${time}` : date;
  let base = labels.recurrence[summaryPresetKey(rule)];
  if (rule.interval > 1) base += ` ×${rule.interval}`;
  const parts = [base];
  if (time) parts.push(time);
  if (rule.until) parts.push(`${labels.ends} ${dateFieldEndpointDate(rule.until)}`);
  return parts.join(' · ');
}

function summaryPresetKey(rule: DateRecurrenceRule): CommandRecurrencePreset {
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
