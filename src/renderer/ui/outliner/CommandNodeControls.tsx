import { useMemo, useState } from 'react';
import {
  describeDateSchedule,
  formatDateSchedule,
  parseDateSchedule,
  type DateRecurrenceRule,
  type DateSchedule,
} from '../../../core/dateSchedule';
import {
  dateFieldEndpointDate,
  dateFieldEndpointTime,
  formatDateFieldEndpoint,
} from '../../../core/dateFieldValue';

// Recurrence presets exposed in the editor (a Todoist-style "Repeat" set). The
// custom `INTERVAL` / multi-day `BYDAY` rules the schedule string can express are
// reachable by editing the agent-proposed value; the preset list keeps manual
// authoring simple.
export type CommandRecurrencePreset = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly';

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
  manualOnly: string;
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

const PRESETS: readonly CommandRecurrencePreset[] = ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly'];

export function CommandNodeControls(props: CommandNodeControlsProps) {
  const { schedule, labels, onSetSchedule, onRunNow, readOnly, busy } = props;
  const [editing, setEditing] = useState(false);

  const summary = useMemo(() => (schedule ? describeDateSchedule(schedule) : ''), [schedule]);

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

  const next = date ? buildScheduleString({ date, time, preset, until }) : null;

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
          {PRESETS.map((option) => (
            <option key={option} value={option}>{labels.recurrence[option]}</option>
          ))}
        </select>
      </label>
      {preset !== 'none' && (
        <label className="command-schedule-field">
          <span>{labels.ends}</span>
          <input type="date" value={until} onChange={(event) => setUntil(event.target.value)} />
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
}

function formStateFromSchedule(schedule: string | null): FormState {
  const parsed = schedule ? parseDateSchedule(schedule) : null;
  if (!parsed) return { date: '', time: '', preset: 'none', until: '' };
  return {
    date: dateFieldEndpointDate(parsed.anchor),
    time: dateFieldEndpointTime(parsed.anchor),
    preset: presetFromRule(parsed.recurrence),
    until: parsed.recurrence?.until ? dateFieldEndpointDate(parsed.recurrence.until) : '',
  };
}

function presetFromRule(rule: DateSchedule['recurrence']): CommandRecurrencePreset {
  if (!rule) return 'none';
  if (rule.frequency === 'weekly') {
    const isWeekdays = rule.byDay?.length === 5
      && ['MO', 'TU', 'WE', 'TH', 'FR'].every((day) => rule.byDay?.includes(day as never));
    return isWeekdays ? 'weekdays' : 'weekly';
  }
  return rule.frequency;
}

// Build the canonical `<endpoint> RRULE:...` string from the editor form, reusing
// the core codec so the stored value is always normalized.
export function buildScheduleString(form: FormState): string | null {
  if (!form.date) return null;
  const anchor = formatDateFieldEndpoint(form.date, form.time);
  let recurrence: DateRecurrenceRule | undefined;
  switch (form.preset) {
    case 'daily':
      recurrence = { frequency: 'daily', interval: 1 };
      break;
    case 'weekdays':
      recurrence = { frequency: 'weekly', interval: 1, byDay: ['MO', 'TU', 'WE', 'TH', 'FR'] };
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
    default:
      recurrence = undefined;
  }
  if (recurrence && form.until) recurrence.until = form.until;
  return formatDateSchedule({ anchor, recurrence });
}
