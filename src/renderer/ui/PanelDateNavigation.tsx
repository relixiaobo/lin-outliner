import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { offsetIsoLocalDate, parseIsoLocalDate, todayIsoLocalDate, type NodeId } from '../api/types';
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from './icons';
import { ButtonControl } from './primitives/ButtonControl';
import { buildCalendarMonthDays, CalendarMonthGrid, shiftedCalendarMonth, type CalendarMonthDay } from './primitives/CalendarMonthGrid';
import type { CommandRunner } from './shared';
import { useT } from '../i18n/I18nProvider';
import { readDateNoteCountWindow, type DayNoteCountIndex } from '../state/dayNoteCounts';

interface PanelDateNavigationProps {
  dayNoteCounts: DayNoteCountIndex;
  isoDate: string;
  onRoot: (nodeId: NodeId) => void;
  run: CommandRunner;
}

const PANEL_DATE_ICON_SIZE = 13;
const PANEL_DATE_ICON_STROKE_WIDTH = 1.8;

function noteDensityClass(count: number) {
  if (count >= 10) return 'has-note-count note-density-4';
  if (count >= 6) return 'has-note-count note-density-3';
  if (count >= 3) return 'has-note-count note-density-2';
  if (count >= 1) return 'has-note-count note-density-1';
  return '';
}

// Localized label builders the calendar-day aria-label needs. This helper runs
// outside React, so the component passes these in from `t.dateNavigation`.
interface DateButtonLabels {
  goToDate: (parts: { isoDate: string }) => string;
  goToDateWithCount: (parts: { isoDate: string; count: number }) => string;
}

function dateButtonLabel(isoDate: string, count: number, labels: DateButtonLabels) {
  if (count <= 0) return labels.goToDate({ isoDate });
  return labels.goToDateWithCount({ isoDate, count });
}

export function PanelDateNavigation({
  dayNoteCounts,
  isoDate,
  onRoot,
  run,
}: PanelDateNavigationProps) {
  const t = useT();
  const selected = parseIsoLocalDate(isoDate);
  const selectedYear = selected?.getFullYear();
  const selectedMonth = selected?.getMonth();
  const today = todayIsoLocalDate();
  const popoverRef = useRef<HTMLDivElement>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [viewYear, setViewYear] = useState(() => selectedYear ?? new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => selectedMonth ?? new Date().getMonth());
  const calendarDays = useMemo(() => buildCalendarMonthDays(viewYear, viewMonth), [viewMonth, viewYear]);
  const visibleIsoDates = useMemo(() => calendarDays.map((day) => day.isoDate), [calendarDays]);
  const dateCountWindow = useMemo(
    () => readDateNoteCountWindow(dayNoteCounts, visibleIsoDates),
    [dayNoteCounts, visibleIsoDates],
  );

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
    const count = dateCountWindow.counts.get(day.isoDate) ?? 0;
    return ['panel-date-calendar-day', noteDensityClass(count)].filter(Boolean).join(' ');
  };

  const calendarDayLabel = (day: CalendarMonthDay) => {
    const count = dateCountWindow.counts.get(day.isoDate) ?? 0;
    return dateButtonLabel(day.isoDate, count, {
      goToDate: t.dateNavigation.goToDate,
      goToDateWithCount: t.dateNavigation.goToDateWithCount,
    });
  };

  return (
    <div className="panel-date-nav-wrap" ref={popoverRef}>
      <nav className="panel-date-nav" aria-label={t.dateNavigation.ariaLabel}>
        <ButtonControl
          aria-label={t.dateNavigation.previousDay}
          className="panel-date-nav-button"
          onClick={() => void navigateToDate(offsetIsoLocalDate(isoDate, -1))}
        >
          <ChevronLeftIcon size={PANEL_DATE_ICON_SIZE} strokeWidth={PANEL_DATE_ICON_STROKE_WIDTH} />
        </ButtonControl>
        <ButtonControl
          className="panel-date-nav-today"
          onClick={() => void navigateToDate(today)}
        >
          {t.dateNavigation.today}
        </ButtonControl>
        <ButtonControl
          aria-label={t.dateNavigation.nextDay}
          className="panel-date-nav-button"
          onClick={() => void navigateToDate(offsetIsoLocalDate(isoDate, 1))}
        >
          <ChevronRightIcon size={PANEL_DATE_ICON_SIZE} strokeWidth={PANEL_DATE_ICON_STROKE_WIDTH} />
        </ButtonControl>
        <span className="panel-date-nav-divider" aria-hidden="true" />
        <ButtonControl
          aria-expanded={calendarOpen}
          aria-label={t.dateNavigation.openCalendar}
          className="panel-date-picker-button"
          onClick={() => setCalendarOpen((open) => !open)}
        >
          <CalendarIcon size={PANEL_DATE_ICON_SIZE} strokeWidth={PANEL_DATE_ICON_STROKE_WIDTH} />
        </ButtonControl>
      </nav>
      {calendarOpen && (
        <div className="panel-date-popover" role="dialog" aria-label={t.dateNavigation.calendarDialogAriaLabel}>
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
