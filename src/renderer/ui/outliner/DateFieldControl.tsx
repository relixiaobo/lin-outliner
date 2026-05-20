import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { CalendarIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { CalendarMonthGrid, shiftedCalendarMonth, type CalendarMonthDay } from '../primitives/CalendarMonthGrid';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';

interface DateFieldControlProps {
  value: string;
  placeholder: string;
  commit: (nextValue: string) => void;
}

type DateFieldEdge = 'start' | 'end';

const DEFAULT_TIME = '09:00';

export function DateFieldControl({ value, placeholder, commit }: DateFieldControlProps) {
  const initial = dateDraftFromValue(value);
  const today = useMemo(() => isoLocalDate(new Date()), []);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [includeEnd, setIncludeEnd] = useState(initial.includeEnd);
  const [startDraft, setStartDraft] = useState(initial.start);
  const [endDraft, setEndDraft] = useState(initial.end);
  const [includeTime, setIncludeTime] = useState(initial.includeTime);
  const [startTimeDraft, setStartTimeDraft] = useState(initial.startTime || DEFAULT_TIME);
  const [endTimeDraft, setEndTimeDraft] = useState(initial.endTime || DEFAULT_TIME);
  const [open, setOpen] = useState(false);
  const [editingEdge, setEditingEdge] = useState<DateFieldEdge>('start');
  const [hoveredDate, setHoveredDate] = useState('');
  const initialViewDate = parseIsoLocalDate(dateFieldEndpointDate(initial.start || today)) ?? new Date();
  const [viewYear, setViewYear] = useState(initialViewDate.getFullYear());
  const [viewMonth, setViewMonth] = useState(initialViewDate.getMonth());
  const popoverStyle = useAnchoredOverlay(popoverRef, {
    anchorRef: triggerRef,
    disabled: !open,
    maxHeight: 520,
    placement: 'bottom-start',
    width: 256,
  });

  useEffect(() => {
    const next = dateDraftFromValue(value);
    setIncludeEnd(next.includeEnd);
    setStartDraft(next.start);
    setEndDraft(next.end);
    setIncludeTime(next.includeTime);
    setStartTimeDraft(next.startTime || DEFAULT_TIME);
    setEndTimeDraft(next.endTime || DEFAULT_TIME);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && triggerRef.current?.contains(target)) return;
      if (target instanceof Node && popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open]);

  const commitDate = (nextIncludeEnd = includeEnd, nextStart = startDraft, nextEnd = endDraft) => {
    if (!nextStart && (!nextIncludeEnd || !nextEnd)) {
      commit('');
      return;
    }
    if (nextIncludeEnd && (!nextStart || !nextEnd)) return;
    const nextValue = nextIncludeEnd
      ? formatDateFieldInput(nextStart, nextEnd)
      : formatDateFieldInput(nextStart, '');
    if (!nextValue) return;
    commit(nextValue);
  };

  const setViewToDate = (isoDate: string) => {
    const date = parseIsoLocalDate(dateFieldEndpointDate(isoDate));
    if (!date) return;
    setViewYear(date.getFullYear());
    setViewMonth(date.getMonth());
  };

  const endpointForDate = (isoDate: string, edge: DateFieldEdge) => (
    includeTime ? formatDateFieldEndpoint(isoDate, edge === 'start' ? startTimeDraft : endTimeDraft) : isoDate
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
    applySelectedDate(editingEdge, isoDate);
  };

  const updateDate = (edge: DateFieldEdge, isoDate: string) => {
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
    commit('');
    setOpen(false);
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

  const displayedValue = dateDisplayValue(startDraft, includeEnd ? endDraft : '', includeEnd);
  const rangePreviewEnd = includeEnd && editingEdge === 'end' && hoveredDate
    ? hoveredDate
    : dateFieldEndpointDate(endDraft);
  const selectedDates = includeEnd
    ? [dateFieldEndpointDate(startDraft), dateFieldEndpointDate(endDraft)].filter(Boolean)
    : [dateFieldEndpointDate(startDraft)].filter(Boolean);
  const calendarDayClassName = (day: CalendarMonthDay) => (
    includeEnd && isIsoDateBetween(day.isoDate, dateFieldEndpointDate(startDraft), rangePreviewEnd) ? 'is-in-range' : ''
  );

  return (
    <span className="typed-field-control typed-field-control-date">
      <ButtonControl
        ref={triggerRef}
        className={`typed-field-date-trigger ${displayedValue ? '' : 'empty'}`}
        aria-expanded={open}
        aria-label={placeholder}
        onClick={() => {
          setOpen((nextOpen) => {
            if (!nextOpen) setViewToDate(startDraft || today);
            return !nextOpen;
          });
        }}
      >
        <CalendarIcon size={13} strokeWidth={1.8} />
        <span>{displayedValue || placeholder}</span>
      </ButtonControl>
      {open ? createPortal(
        <div
          ref={popoverRef}
          className="typed-field-date-popover"
          role="dialog"
          aria-label={`${placeholder} calendar`}
          style={popoverStyle}
        >
          <div className="typed-field-date-summary">
            <DateSummaryRow
              active={editingEdge === 'start'}
              includeTime={includeTime}
              label="Start"
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
                label="End"
                time={endTimeDraft}
                value={endDraft}
                onSelect={() => setEditingEdge('end')}
                onDateChange={(isoDate) => updateDate('end', isoDate)}
                onTimeChange={(nextTime) => updateTime('end', nextTime)}
              />
            )}
          </div>
          <CalendarMonthGrid
            getDayClassName={calendarDayClassName}
            month={viewMonth}
            onDayMouseEnter={(day) => setHoveredDate(day.isoDate)}
            onDayMouseLeave={() => setHoveredDate('')}
            onMoveMonth={moveMonth}
            onSelectDate={selectDate}
            selectedIsoDates={selectedDates}
            todayIsoDate={today}
            year={viewYear}
          />
          <div className="typed-field-date-settings">
            <DateSettingRow label="End date" checked={includeEnd} onToggle={toggleIncludeEnd} />
            <DateSettingRow label="Include time" checked={includeTime} onToggle={toggleIncludeTime} />
          </div>
          <div className="typed-field-date-actions">
            <ButtonControl onClick={pickToday}>Today</ButtonControl>
            <ButtonControl onClick={clearDate}>Clear</ButtonControl>
          </div>
        </div>,
        document.body,
      ) : null}
    </span>
  );
}

interface DateSummaryRowProps {
  active: boolean;
  includeTime: boolean;
  label: string;
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
          aria-label={`${label} date`}
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
          aria-label={`${label} time`}
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
} {
  const parsed = parseDateFieldValue(value);
  if (parsed?.kind === 'range') {
    return {
      includeEnd: true,
      start: parsed.start,
      end: parsed.end,
      includeTime: dateFieldEndpointHasTime(parsed.start) || dateFieldEndpointHasTime(parsed.end),
      startTime: dateFieldEndpointTime(parsed.start),
      endTime: dateFieldEndpointTime(parsed.end),
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
    };
  }
  return { includeEnd: false, start: '', end: '', includeTime: false, startTime: '', endTime: '' };
}

function dateDisplayValue(start: string, end: string, includeEnd: boolean): string {
  if (!start) return '';
  if (!includeEnd || !end) return compactDateDisplay(start);
  return `${compactDateDisplay(start)} to ${compactDateDisplay(end)}`;
}

function compactDateDisplay(isoDate: string): string {
  const date = parseIsoLocalDate(dateFieldEndpointDate(isoDate));
  if (!date) return isoDate;
  const currentYear = new Date().getFullYear();
  const options: Intl.DateTimeFormatOptions = date.getFullYear() === currentYear
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
  const dateLabel = new Intl.DateTimeFormat(undefined, options).format(date);
  const time = dateFieldEndpointTime(isoDate);
  return time ? `${dateLabel} ${time}` : dateLabel;
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
