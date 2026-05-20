import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { offsetIsoLocalDate, parseIsoLocalDate, todayIsoLocalDate, type NodeId } from '../api/types';
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from './icons';
import { ButtonControl } from './primitives/ButtonControl';
import { CalendarMonthGrid, shiftedCalendarMonth, type CalendarMonthDay } from './primitives/CalendarMonthGrid';
import type { CommandRunner } from './shared';

interface PanelDateNavigationProps {
  dateNoteCounts?: Readonly<Record<string, number>>;
  isoDate: string;
  onRoot: (nodeId: NodeId) => void;
  run: CommandRunner;
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
  const selected = parseIsoLocalDate(isoDate);
  const selectedYear = selected?.getFullYear();
  const selectedMonth = selected?.getMonth();
  const today = todayIsoLocalDate();
  const popoverRef = useRef<HTMLDivElement>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [viewYear, setViewYear] = useState(() => selectedYear ?? new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => selectedMonth ?? new Date().getMonth());

  useEffect(() => {
    if (selectedYear === undefined || selectedMonth === undefined) return;
    setViewYear(selectedYear);
    setViewMonth(selectedMonth);
  }, [selectedMonth, selectedYear]);

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
    const next = shiftedCalendarMonth(viewYear, viewMonth, delta);
    setViewYear(next.year);
    setViewMonth(next.month);
  };

  const navigateToDate = async (nextIsoDate: string) => {
    const parsed = parseIsoLocalDate(nextIsoDate);
    if (!parsed) return;
    const result = await run(() => api.ensureDateNode(
      parsed.getFullYear(),
      parsed.getMonth() + 1,
      parsed.getDate(),
    ));
    if (result && 'focus' in result && result.focus?.nodeId) onRoot(result.focus.nodeId);
    setCalendarOpen(false);
  };

  const calendarDayClassName = (day: CalendarMonthDay) => {
    const count = dateNoteCounts[day.isoDate] ?? 0;
    return ['panel-date-calendar-day', noteDensityClass(count)].filter(Boolean).join(' ');
  };

  const calendarDayLabel = (day: CalendarMonthDay) => {
    const count = dateNoteCounts[day.isoDate] ?? 0;
    return dateButtonLabel(day.isoDate, count);
  };

  return (
    <div className="panel-date-nav-wrap" ref={popoverRef}>
      <nav className="panel-date-nav" aria-label="Date navigation">
        <ButtonControl
          aria-label="Previous day"
          className="panel-date-nav-button"
          onClick={() => void navigateToDate(offsetIsoLocalDate(isoDate, -1))}
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
          onClick={() => void navigateToDate(offsetIsoLocalDate(isoDate, 1))}
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
          <CalendarMonthGrid
            getDayAriaLabel={calendarDayLabel}
            getDayClassName={calendarDayClassName}
            month={viewMonth}
            onMoveMonth={moveMonth}
            onSelectDate={(nextIsoDate) => void navigateToDate(nextIsoDate)}
            selectedIsoDates={[isoDate]}
            todayIsoDate={today}
            year={viewYear}
          />
        </div>
      )}
    </div>
  );
}
