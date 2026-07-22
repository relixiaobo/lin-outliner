import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  dateFieldEndpointDate,
  dateFieldEndpointHasTime,
  dateFieldEndpointTime,
  formatDateFieldEndpoint,
  formatDateFieldInput,
  isoLocalDate,
  orderDateFieldEndpoints,
  parseDateFieldValue,
  parseIsoLocalDate,
} from '../../api/types';
import {
  buildScheduleString,
  presetFromRecurrence,
  SELECTABLE_PRESETS,
  type RecurrencePreset,
} from './dateRecurrence';
import type { DateRecurrenceRule } from '../../../core/dateFieldValue';
import { ButtonControl } from '../primitives/ButtonControl';
import { CalendarMonthGrid, shiftedCalendarMonth, type CalendarMonthDay } from '../primitives/CalendarMonthGrid';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';
import { useAnchoredOverlay, type OverlayPlacement } from '../primitives/useAnchoredOverlay';
import { useMenuKeyboard } from '../primitives/useMenuKeyboard';
import { useT } from '../../i18n/I18nProvider';

interface DateValuePickerProps {
  // The row content line the popover anchors to (so the calendar opens under the
  // value, not under a dedicated whole-field control).
  anchorRef: RefObject<HTMLElement | null>;
  // The current normalized date value ('' for an empty / draft value).
  value: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Commit a normalized date value ('' clears it). The caller routes this to the
  // node command set (materialize a draft, or replace a committed value's text).
  onCommit: (nextValue: string) => void;
  // Whether the end-date (range) toggle is offered. Off for single-date callers
  // where a range has no meaning.
  allowRange?: boolean;
  // Whether the time toggle is offered. Date-only callers persist strict
  // YYYY-MM-DD values.
  allowTime?: boolean;
  // Whether the recurrence selector is offered for single dates. Recurring
  // workflows need it; plain date pickers do not.
  allowRecurrence?: boolean;
  // Optional upper bound for selectable dates, encoded as YYYY-MM-DD.
  maxDate?: string;
  // Composer-like callers near the viewport bottom can force the calendar above
  // the anchor; ordinary field values keep the default bottom-start behavior.
  popoverPlacement?: OverlayPlacement;
  popoverGap?: number;
  popoverMaxHeight?: number;
}

type DateFieldEdge = 'start' | 'end' | 'until';

const DEFAULT_TIME = '09:00';

// The date picker overlay for a date field value. It is a controlled,
// anchor-positioned popover with no trigger of its own — the value row summons
// it (Space / a calendar affordance) and owns where the picked value lands. The
// calendar logic mirrors the reference date interaction: optional end date for a
// range, optional time, today / clear.
export function DateValuePicker({
  anchorRef,
  value,
  open,
  onOpenChange,
  onCommit,
  allowRange = true,
  allowTime = true,
  allowRecurrence = true,
  maxDate,
  popoverPlacement = 'bottom-start',
  popoverGap,
  popoverMaxHeight = 520,
}: DateValuePickerProps) {
  const td = useT().outliner.field.datePicker;
  const initial = dateDraftFromValue(value);
  const initialStart = allowTime ? initial.start : dateFieldEndpointDate(initial.start);
  const initialEnd = allowTime ? initial.end : dateFieldEndpointDate(initial.end);
  const today = useMemo(() => isoLocalDate(new Date()), []);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [includeEnd, setIncludeEnd] = useState(initial.includeEnd);
  const [startDraft, setStartDraft] = useState(initialStart);
  const [endDraft, setEndDraft] = useState(initialEnd);
  const [includeTime, setIncludeTime] = useState(allowTime && initial.includeTime);
  const [startTimeDraft, setStartTimeDraft] = useState(initial.startTime || DEFAULT_TIME);
  const [endTimeDraft, setEndTimeDraft] = useState(initial.endTime || DEFAULT_TIME);
  // Recurrence (single dates only — a range never repeats). `customRule` preserves
  // an agent-authored rule no preset represents so editing the date keeps it intact.
  const [preset, setPreset] = useState<RecurrencePreset>(initial.preset);
  const [until, setUntil] = useState(initial.until);
  const [includeUntil, setIncludeUntil] = useState(allowRecurrence && Boolean(initial.until));
  const [customRule, setCustomRule] = useState<DateRecurrenceRule | null>(initial.rule);
  const [editingEdge, setEditingEdge] = useState<DateFieldEdge>('start');
  const [hoveredDate, setHoveredDate] = useState('');
  const initialViewDate = parseIsoLocalDate(dateFieldEndpointDate(initial.start || today)) ?? new Date();
  const [viewYear, setViewYear] = useState(initialViewDate.getFullYear());
  const [viewMonth, setViewMonth] = useState(initialViewDate.getMonth());
  const popoverLayoutKey = [
    includeEnd ? 'range' : 'single',
    includeTime ? 'time' : 'date',
    allowRecurrence ? 'recurrence' : 'plain',
    preset === 'none' ? 'no-repeat' : 'repeat',
    includeUntil ? 'until' : 'no-until',
  ].join(':');
  const popoverStyle = useAnchoredOverlay(popoverRef, {
    anchorRef,
    disabled: !open,
    gap: popoverGap,
    layoutKey: popoverLayoutKey,
    maxHeight: popoverMaxHeight,
    placement: popoverPlacement,
    width: 256,
  });

  useEffect(() => {
    const next = dateDraftFromValue(value);
    setIncludeEnd(next.includeEnd);
    setStartDraft(allowTime ? next.start : dateFieldEndpointDate(next.start));
    setEndDraft(allowTime ? next.end : dateFieldEndpointDate(next.end));
    setIncludeTime(allowTime && next.includeTime);
    setStartTimeDraft(next.startTime || DEFAULT_TIME);
    setEndTimeDraft(next.endTime || DEFAULT_TIME);
    setPreset(allowRecurrence ? next.preset : 'none');
    setUntil(allowRecurrence ? next.until : '');
    setIncludeUntil(allowRecurrence && Boolean(next.until));
    setCustomRule(allowRecurrence ? next.rule : null);
  }, [allowRecurrence, allowTime, value]);

  // Re-centre the calendar on the value's month each time the popover opens.
  useEffect(() => {
    if (!open) return;
    const date = parseIsoLocalDate(dateFieldEndpointDate(startDraft || today));
    if (!date) return;
    setViewYear(date.getFullYear());
    setViewMonth(date.getMonth());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && anchorRef.current?.contains(target)) return;
      if (target instanceof Node && popoverRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [open, anchorRef, onOpenChange]);

  // Focus-in / trap / Escape-to-close / focus-restore to the value row. Arrow keys
  // pass through to the calendar grid's own roving navigation (dialog kind only
  // traps Tab + handles Escape).
  const { onKeyDown: onPopoverKeyDown } = useMenuKeyboard({
    surfaceRef: popoverRef,
    onClose: () => onOpenChange(false),
    kind: 'dialog',
    active: open,
    getRestoreTarget: () => (anchorRef.current instanceof HTMLElement ? anchorRef.current : null),
  });

  const commitDate = (
    nextIncludeEnd = includeEnd,
    nextStart = startDraft,
    nextEnd = endDraft,
    nextPreset: RecurrencePreset = preset,
    nextUntil = until,
  ) => {
    const normalizedStart = allowTime ? nextStart : dateFieldEndpointDate(nextStart);
    const normalizedEnd = allowTime ? nextEnd : dateFieldEndpointDate(nextEnd);
    if (!nextStart && (!nextIncludeEnd || !nextEnd)) {
      onCommit('');
      return;
    }
    if (nextIncludeEnd && (!normalizedStart || !normalizedEnd)) return;
    // A recurring single date encodes its rule into the value (`<date> RRULE:...`);
    // a range never recurs, so its branch ignores the preset.
    if (allowRecurrence && !nextIncludeEnd && nextPreset !== 'none') {
      const recurring = buildScheduleString({
        date: dateFieldEndpointDate(normalizedStart),
        time: dateFieldEndpointTime(normalizedStart),
        preset: nextPreset,
        until: validRecurrenceUntil(normalizedStart, nextUntil),
        rule: customRule,
      });
      if (recurring) onCommit(recurring);
      return;
    }
    const nextValue = nextIncludeEnd
      ? formatDateFieldInput(normalizedStart, normalizedEnd)
      : formatDateFieldInput(normalizedStart, '');
    if (!nextValue) return;
    onCommit(nextValue);
  };

  const setViewToDate = (isoDate: string) => {
    const date = parseIsoLocalDate(dateFieldEndpointDate(isoDate));
    if (!date) return;
    setViewYear(date.getFullYear());
    setViewMonth(date.getMonth());
  };

  const endpointForDate = (isoDate: string, edge: DateFieldEdge) => (
    allowTime && includeTime ? formatDateFieldEndpoint(isoDate, edge === 'start' ? startTimeDraft : endTimeDraft) : isoDate
  );

  const toggleIncludeEnd = () => {
    const nextIncludeEnd = !includeEnd;
    setIncludeEnd(nextIncludeEnd);
    setHoveredDate('');
    if (!nextIncludeEnd) {
      setEditingEdge('start');
      setEndDraft('');
      setEndTimeDraft(DEFAULT_TIME);
      commitDate(false, startDraft, '');
      return;
    }

    const fallbackStart = startDraft || today;
    const nextStart = includeTime ? applyTimeMode(fallbackStart, true, startTimeDraft) : dateFieldEndpointDate(fallbackStart);
    const nextEndTime = endDraft ? endTimeDraft : dateFieldEndpointTime(nextStart) || startTimeDraft || DEFAULT_TIME;
    const nextEnd = includeTime
      ? applyTimeMode(endDraft || fallbackStart, true, nextEndTime)
      : dateFieldEndpointDate(endDraft || fallbackStart);
    const ordered = orderDateFieldEndpoints(nextStart, nextEnd) ?? [nextStart, nextEnd];
    setStartDraft(ordered[0]);
    setEndDraft(ordered[1]);
    setEndTimeDraft(nextEndTime);
    setEditingEdge('end');
    setViewToDate(ordered[1]);
    commitDate(true, ordered[0], ordered[1]);
  };

  const applySelectedDate = (edge: DateFieldEdge, isoDate: string) => {
    if (edge === 'until') {
      const nextUntil = dateFieldEndpointDate(isoDate);
      if (nextUntil < dateFieldEndpointDate(startDraft)) return;
      setViewToDate(nextUntil);
      updateUntil(nextUntil);
      return;
    }

    const selectedEndpoint = endpointForDate(isoDate, edge);
    if (!includeEnd) {
      setStartDraft(selectedEndpoint);
      setEndDraft('');
      setViewToDate(isoDate);
      commitDate(false, selectedEndpoint, '');
      return;
    }

    if (edge === 'start') {
      let nextStart = selectedEndpoint;
      let nextEnd = endDraft;
      if (nextEnd) [nextStart, nextEnd] = orderDateFieldEndpoints(nextStart, nextEnd) ?? [nextStart, nextEnd];
      setStartDraft(nextStart);
      setEndDraft(nextEnd);
      setEditingEdge('end');
      setHoveredDate('');
      setViewToDate(isoDate);
      if (nextEnd) commitDate(true, nextStart, nextEnd);
      return;
    }

    let nextStart = startDraft || selectedEndpoint;
    let nextEnd = selectedEndpoint;
    [nextStart, nextEnd] = orderDateFieldEndpoints(nextStart, nextEnd) ?? [nextStart, nextEnd];
    setStartDraft(nextStart);
    setEndDraft(nextEnd);
    setHoveredDate('');
    setViewToDate(isoDate);
    commitDate(true, nextStart, nextEnd);
  };

  const selectDate = (isoDate: string) => {
    if (maxDate && isoDate > maxDate) return;
    applySelectedDate(editingEdge, isoDate);
  };

  const updateDate = (edge: DateFieldEdge, isoDate: string) => {
    if (maxDate && isoDate > maxDate) return;
    applySelectedDate(edge, isoDate);
  };

  const moveMonth = (delta: number) => {
    const next = shiftedCalendarMonth(viewYear, viewMonth, delta);
    setViewYear(next.year);
    setViewMonth(next.month);
  };

  const clearDate = () => {
    setStartDraft('');
    setEndDraft('');
    setHoveredDate('');
    setEditingEdge('start');
    setPreset('none');
    setUntil('');
    setIncludeUntil(false);
    setCustomRule(null);
    onCommit('');
    onOpenChange(false);
  };

  const updatePreset = (nextPreset: RecurrencePreset) => {
    setPreset(nextPreset);
    const nextUntil = nextPreset === 'none' ? '' : until;
    if (nextPreset === 'none') {
      setUntil('');
      setIncludeUntil(false);
      if (editingEdge === 'until') setEditingEdge('start');
    }
    commitDate(includeEnd, startDraft, endDraft, nextPreset, nextUntil);
  };

  const updateUntil = (nextUntil: string) => {
    const nextValidUntil = validRecurrenceUntil(startDraft, nextUntil);
    if (!nextValidUntil && nextUntil) return;
    setUntil(nextValidUntil);
    commitDate(includeEnd, startDraft, endDraft, preset, nextValidUntil);
  };

  const toggleIncludeUntil = () => {
    const nextIncludeUntil = !includeUntil;
    setIncludeUntil(nextIncludeUntil);
    if (!nextIncludeUntil) {
      setUntil('');
      if (editingEdge === 'until') setEditingEdge('start');
      commitDate(includeEnd, startDraft, endDraft, preset, '');
      return;
    }
    const nextUntil = until || dateFieldEndpointDate(startDraft) || today;
    setUntil(nextUntil);
    setEditingEdge('until');
    setViewToDate(nextUntil);
    commitDate(includeEnd, startDraft, endDraft, preset, nextUntil);
  };

  const pickToday = () => {
    setViewToDate(today);
    selectDate(today);
  };

  const toggleIncludeTime = () => {
    const nextIncludeTime = !includeTime;
    setIncludeTime(nextIncludeTime);
    const nextStart = applyTimeMode(startDraft, nextIncludeTime, startTimeDraft);
    const nextEnd = applyTimeMode(endDraft, nextIncludeTime, endTimeDraft);
    setStartDraft(nextStart);
    setEndDraft(nextEnd);
    commitDate(includeEnd, nextStart, nextEnd);
  };

  const updateTime = (edge: DateFieldEdge, nextTime: string) => {
    if (edge === 'start') {
      setStartTimeDraft(nextTime);
      const nextStart = applyTimeMode(startDraft, true, nextTime);
      setStartDraft(nextStart);
      commitDate(includeEnd, nextStart, endDraft);
      return;
    }
    setEndTimeDraft(nextTime);
    const nextEnd = applyTimeMode(endDraft, true, nextTime);
    setEndDraft(nextEnd);
    commitDate(includeEnd, startDraft, nextEnd);
  };

  const rangePreviewEnd = includeEnd && editingEdge === 'end' && hoveredDate
    ? hoveredDate
    : dateFieldEndpointDate(endDraft);
  const recurrenceUntilDate = allowRecurrence && !includeEnd && preset !== 'none' && includeUntil
    ? dateFieldEndpointDate(until)
    : '';
  const recurrenceStartDate = dateFieldEndpointDate(startDraft);
  const selectedDates = includeEnd
    ? [dateFieldEndpointDate(startDraft), dateFieldEndpointDate(endDraft)].filter(Boolean)
    : [dateFieldEndpointDate(startDraft), recurrenceUntilDate].filter(Boolean);
  // `custom` is never freely selectable — it only appears (pre-selected) when the
  // stored rule maps to no plain preset, so the user can keep it as-is.
  const presetOptions = preset === 'custom' ? (['custom', ...SELECTABLE_PRESETS] as const) : SELECTABLE_PRESETS;
  const calendarDayClassName = (day: CalendarMonthDay) => (
    includeEnd && isIsoDateBetween(day.isoDate, dateFieldEndpointDate(startDraft), rangePreviewEnd) ? 'is-in-range' : ''
  );

  if (!open) return null;

  return createPortal(
    <div
      ref={popoverRef}
      className="typed-field-date-popover"
      role="dialog"
      aria-label={td.title}
      onKeyDown={onPopoverKeyDown}
      style={popoverStyle}
    >
      <div className="typed-field-date-summary">
        <DateSummaryRow
          active={editingEdge === 'start'}
          includeTime={includeTime}
          label={td.start}
          dateAriaLabel={td.startDate}
          timeAriaLabel={td.startTime}
          time={startTimeDraft}
          value={startDraft}
          onSelect={() => setEditingEdge('start')}
          onDateChange={(isoDate) => updateDate('start', isoDate)}
          onTimeChange={(nextTime) => updateTime('start', nextTime)}
        />
        {includeEnd && (
          <DateSummaryRow
            active={editingEdge === 'end'}
            includeTime={includeTime}
            label={td.end}
            dateAriaLabel={td.endDate}
            timeAriaLabel={td.endTime}
            time={endTimeDraft}
            value={endDraft}
            onSelect={() => setEditingEdge('end')}
            onDateChange={(isoDate) => updateDate('end', isoDate)}
            onTimeChange={(nextTime) => updateTime('end', nextTime)}
          />
        )}
        {allowRecurrence && !includeEnd && preset !== 'none' && includeUntil && (
          <DateSummaryRow
            active={editingEdge === 'until'}
            includeTime={false}
            label={td.ends}
            dateAriaLabel={td.ends}
            timeAriaLabel={td.endTime}
            time=""
            value={until}
            onSelect={() => {
              setEditingEdge('until');
              setViewToDate(until || dateFieldEndpointDate(startDraft) || today);
            }}
            onDateChange={updateUntil}
            onTimeChange={() => {}}
          />
        )}
      </div>
      <CalendarMonthGrid
        getDayClassName={calendarDayClassName}
        isDateDisabled={(isoDate) => Boolean(
          (maxDate && isoDate > maxDate)
          || (editingEdge === 'until' && recurrenceStartDate && isoDate < recurrenceStartDate),
        )}
        month={viewMonth}
        multiselectable={includeEnd || Boolean(recurrenceUntilDate)}
        onDayMouseEnter={(day) => setHoveredDate(day.isoDate)}
        onDayMouseLeave={() => setHoveredDate('')}
        onMoveMonth={moveMonth}
        onSelectDate={selectDate}
        selectedIsoDates={selectedDates}
        todayIsoDate={today}
        year={viewYear}
      />
      <div className="typed-field-date-settings">
        {allowRange && (
          <DateSettingRow label={td.endDateToggle} checked={includeEnd} onToggle={toggleIncludeEnd} />
        )}
        {allowTime && (
          <DateSettingRow label={td.includeTimeToggle} checked={includeTime} onToggle={toggleIncludeTime} />
        )}
        {allowRecurrence && !includeEnd && preset !== 'none' && (
          <DateSettingRow label={td.ends} checked={includeUntil} onToggle={toggleIncludeUntil} />
        )}
      </div>
      {allowRecurrence && !includeEnd && (
        // Recurrence is a single-date concept; a range never repeats.
        <div className="typed-field-date-recurrence">
          <label className="typed-field-date-recurrence-row">
            <span>{td.repeat}</span>
            <select
              className="typed-field-date-recurrence-select"
              value={preset}
              onChange={(event) => updatePreset(event.target.value as RecurrencePreset)}
            >
              {presetOptions.map((option) => (
                <option key={option} value={option}>{td.recurrence[option]}</option>
              ))}
            </select>
          </label>
        </div>
      )}
      <div className="typed-field-date-actions">
        <ButtonControl onClick={pickToday}>{td.today}</ButtonControl>
        <ButtonControl onClick={clearDate}>{td.clear}</ButtonControl>
      </div>
    </div>,
    document.body,
  );
}

interface DateSummaryRowProps {
  active: boolean;
  includeTime: boolean;
  label: string;
  // Pre-built accessible names for the date / time inputs (the parent owns the
  // localization so the "Start date" / "End time" wording stays whole, not
  // concatenated). See DateValuePicker.
  dateAriaLabel: string;
  timeAriaLabel: string;
  onDateChange: (isoDate: string) => void;
  onSelect: () => void;
  onTimeChange: (time: string) => void;
  time: string;
  value: string;
}

function DateSummaryRow({
  active,
  includeTime,
  label,
  dateAriaLabel,
  timeAriaLabel,
  onDateChange,
  onSelect,
  onTimeChange,
  time,
  value,
}: DateSummaryRowProps) {
  const [editingDate, setEditingDate] = useState(false);
  const [dateDraft, setDateDraft] = useState(() => editableDateDisplay(value));

  useEffect(() => {
    if (!editingDate) setDateDraft(editableDateDisplay(value));
  }, [editingDate, value]);

  const commitDateDraft = (rawDateDraft = dateDraft) => {
    setEditingDate(false);
    const parsed = parseEditableDateInput(rawDateDraft);
    if (parsed && parsed !== dateFieldEndpointDate(value)) onDateChange(parsed);
    else setDateDraft(editableDateDisplay(value));
  };

  return (
    <div className={`typed-field-date-summary-row ${active ? 'active' : ''}`}>
      <label className="typed-field-date-summary-main">
        <span>{label}</span>
        <input
          aria-label={dateAriaLabel}
          className="typed-field-date-date-input"
          onBlur={(event) => commitDateDraft(event.currentTarget.value)}
          onChange={(event) => setDateDraft(event.currentTarget.value)}
          onInput={(event) => setDateDraft(event.currentTarget.value)}
          onClick={onSelect}
          onFocus={() => {
            onSelect();
            setEditingDate(true);
            setDateDraft(editableDateDisplay(value));
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            } else if (event.key === 'Escape') {
              setEditingDate(false);
              setDateDraft(editableDateDisplay(value));
              event.currentTarget.blur();
            }
          }}
          placeholder="YYYY/MM/DD"
          value={editingDate ? dateDraft : editableDateDisplay(value)}
        />
      </label>
      {includeTime && (
        <input
          aria-label={timeAriaLabel}
          className="typed-field-date-time-input"
          type="time"
          value={dateFieldEndpointTime(value) || time}
          onInput={(event) => onTimeChange(event.currentTarget.value)}
        />
      )}
    </div>
  );
}

interface DateSettingRowProps {
  checked: boolean;
  label: string;
  onToggle: () => void;
}

function DateSettingRow({ checked, label, onToggle }: DateSettingRowProps) {
  return (
    <div className="typed-field-date-setting-row">
      <span>{label}</span>
      <SwitchControl
        checked={checked}
        className="typed-field-date-toggle"
        label={label}
        onCheckedChange={onToggle}
      >
        <SwitchMark checked={checked} />
      </SwitchControl>
    </div>
  );
}

function dateDraftFromValue(value: string): {
  includeEnd: boolean;
  start: string;
  end: string;
  includeTime: boolean;
  startTime: string;
  endTime: string;
  preset: RecurrencePreset;
  until: string;
  rule: DateRecurrenceRule | null;
} {
  const empty = { preset: 'none' as RecurrencePreset, until: '', rule: null };
  const parsed = parseDateFieldValue(value);
  if (parsed?.kind === 'range') {
    return {
      includeEnd: true,
      start: parsed.start,
      end: parsed.end,
      includeTime: dateFieldEndpointHasTime(parsed.start) || dateFieldEndpointHasTime(parsed.end),
      startTime: dateFieldEndpointTime(parsed.start),
      endTime: dateFieldEndpointTime(parsed.end),
      ...empty,
    };
  }
  if (parsed?.kind === 'single') {
    return {
      includeEnd: false,
      start: parsed.date,
      end: '',
      includeTime: dateFieldEndpointHasTime(parsed.date),
      startTime: dateFieldEndpointTime(parsed.date),
      endTime: '',
      preset: presetFromRecurrence(parsed.recurrence),
      until: parsed.recurrence?.until ? dateFieldEndpointDate(parsed.recurrence.until) : '',
      rule: parsed.recurrence ?? null,
    };
  }
  return { includeEnd: false, start: '', end: '', includeTime: false, startTime: '', endTime: '', ...empty };
}

function isIsoDateBetween(date: string, start: string, end: string): boolean {
  if (!start || !end || start === end) return false;
  const lower = start < end ? start : end;
  const upper = start < end ? end : start;
  return date > lower && date < upper;
}

function applyTimeMode(endpoint: string, includeTime: boolean, time: string): string {
  const date = dateFieldEndpointDate(endpoint);
  if (!date) return '';
  return includeTime ? formatDateFieldEndpoint(date, time || DEFAULT_TIME) : date;
}

function validRecurrenceUntil(start: string, until: string): string {
  if (!until) return '';
  const startDate = dateFieldEndpointDate(start);
  if (startDate && until < startDate) return '';
  return until;
}

function editableDateDisplay(endpoint: string): string {
  const date = dateFieldEndpointDate(endpoint);
  return date ? date.replace(/-/g, '/') : '';
}

function parseEditableDateInput(input: string): string | null {
  const match = input.trim().replace(/-/g, '/').match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!match) return null;
  const isoDate = `${match[1]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}`;
  return parseIsoLocalDate(isoDate) ? isoDate : null;
}
