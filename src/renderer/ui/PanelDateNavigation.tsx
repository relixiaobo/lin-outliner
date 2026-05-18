import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type { NodeId } from '../api/types';
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from './icons';
import { ButtonControl } from './primitives/ButtonControl';
import type { CommandRunner } from './shared';

interface PanelDateNavigationProps {
  dateNoteCounts?: Readonly<Record<string, number>>;
  isoDate: string;
  onRoot: (nodeId: NodeId) => void;
  run: CommandRunner;
}

function parseIsoDate(isoDate: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return { date, year, month, day };
}

function formatDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function offsetIsoDate(isoDate: string, deltaDays: number) {
  const parsed = parseIsoDate(isoDate);
  if (!parsed) return isoDate;
  const next = new Date(parsed.date);
  next.setDate(next.getDate() + deltaDays);
  return formatDate(next);
}

function todayIsoDate() {
  return formatDate(new Date());
}

function monthLabel(year: number, monthIndex: number) {
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
    .format(new Date(year, monthIndex, 1));
}

function buildCalendarDays(year: number, monthIndex: number) {
  const firstDay = new Date(year, monthIndex, 1);
  const start = new Date(firstDay);
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  start.setDate(firstDay.getDate() - mondayOffset);

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return {
      date,
      inMonth: date.getMonth() === monthIndex,
      isoDate: formatDate(date),
    };
  });
}

function noteDensityClass(count: number) {
  if (count >= 10) return 'has-note-count note-density-4';
  if (count >= 6) return 'has-note-count note-density-3';
  if (count >= 3) return 'has-note-count note-density-2';
  if (count >= 1) return 'has-note-count note-density-1';
  return '';
}

function dateButtonLabel(isoDate: string, count: number) {
  if (count <= 0) return `Go to ${isoDate}`;
  return `Go to ${isoDate} · ${count} ${count === 1 ? 'node' : 'nodes'}`;
}

export function PanelDateNavigation({
  dateNoteCounts = {},
  isoDate,
  onRoot,
  run,
}: PanelDateNavigationProps) {
  const selected = parseIsoDate(isoDate);
  const today = todayIsoDate();
  const popoverRef = useRef<HTMLDivElement>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [viewYear, setViewYear] = useState(() => selected?.year ?? new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => (selected ? selected.month - 1 : new Date().getMonth()));
  const calendarDays = useMemo(() => buildCalendarDays(viewYear, viewMonth), [viewMonth, viewYear]);

  useEffect(() => {
    if (!selected) return;
    setViewYear(selected.year);
    setViewMonth(selected.month - 1);
  }, [selected?.year, selected?.month]);

  useEffect(() => {
    if (!calendarOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (popoverRef.current?.contains(event.target as Node)) return;
      setCalendarOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCalendarOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [calendarOpen]);

  const moveMonth = (delta: number) => {
    const next = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth());
  };

  const navigateToDate = async (nextIsoDate: string) => {
    const parsed = parseIsoDate(nextIsoDate);
    if (!parsed) return;
    const result = await run(() => api.ensureDateNode(parsed.year, parsed.month, parsed.day));
    if (result && 'focus' in result && result.focus?.nodeId) onRoot(result.focus.nodeId);
    setCalendarOpen(false);
  };

  return (
    <div className="panel-date-nav-wrap" ref={popoverRef}>
      <nav className="panel-date-nav" aria-label="Date navigation">
        <ButtonControl
          aria-label="Previous day"
          className="panel-date-nav-button"
          onClick={() => void navigateToDate(offsetIsoDate(isoDate, -1))}
        >
          <ChevronLeftIcon size={13} strokeWidth={1.8} />
        </ButtonControl>
        <ButtonControl
          className="panel-date-nav-today"
          onClick={() => void navigateToDate(today)}
        >
          Today
        </ButtonControl>
        <ButtonControl
          aria-label="Next day"
          className="panel-date-nav-button"
          onClick={() => void navigateToDate(offsetIsoDate(isoDate, 1))}
        >
          <ChevronRightIcon size={13} strokeWidth={1.8} />
        </ButtonControl>
        <span className="panel-date-nav-divider" aria-hidden="true" />
        <ButtonControl
          aria-expanded={calendarOpen}
          aria-label="Open calendar"
          className="panel-date-picker-button"
          onClick={() => setCalendarOpen((open) => !open)}
        >
          <CalendarIcon size={13} strokeWidth={1.8} />
        </ButtonControl>
      </nav>
      {calendarOpen && (
        <div className="panel-date-popover" role="dialog" aria-label="Calendar">
          <div className="panel-date-calendar-header">
            <ButtonControl
              aria-label="Previous month"
              className="panel-date-calendar-nav"
              onClick={() => moveMonth(-1)}
            >
              <ChevronLeftIcon size={13} strokeWidth={1.8} />
            </ButtonControl>
            <span>{monthLabel(viewYear, viewMonth)}</span>
            <ButtonControl
              aria-label="Next month"
              className="panel-date-calendar-nav"
              onClick={() => moveMonth(1)}
            >
              <ChevronRightIcon size={13} strokeWidth={1.8} />
            </ButtonControl>
          </div>
          <div className="panel-date-calendar-weekdays" aria-hidden="true">
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => (
              <span key={`${day}-${index}`}>{day}</span>
            ))}
          </div>
          <div className="panel-date-calendar-grid">
            {calendarDays.map((day) => {
              const count = dateNoteCounts[day.isoDate] ?? 0;
              const dayNumber = day.date.getDate();
              return (
                <ButtonControl
                  aria-label={dateButtonLabel(day.isoDate, count)}
                  className={[
                    'panel-date-calendar-day',
                    day.inMonth ? '' : 'is-outside-month',
                    day.isoDate === isoDate ? 'is-selected' : '',
                    day.isoDate === today ? 'is-today' : '',
                    noteDensityClass(count),
                  ].filter(Boolean).join(' ')}
                  data-note-count={count > 0 ? count : undefined}
                  key={day.isoDate}
                  onClick={() => void navigateToDate(day.isoDate)}
                >
                  <span>{dayNumber}</span>
                </ButtonControl>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
