import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEventHandler } from 'react';
import { addLocalDays, isoLocalDate, parseIsoLocalDate } from '../../api/types';
import { useI18n, useT } from '../../i18n/I18nProvider';
import { ChevronLeftIcon, ChevronRightIcon } from '../icons';
import { formatDateTime } from '../formatting';
import { ButtonControl } from './ButtonControl';
import { cx } from './cx';

export interface CalendarMonthDay {
  date: Date;
  inMonth: boolean;
  isoDate: string;
}

interface CalendarMonthGridProps {
  className?: string;
  getDayAriaLabel?: (day: CalendarMonthDay) => string;
  getDayClassName?: (day: CalendarMonthDay) => string;
  isDateDisabled?: (isoDate: string) => boolean;
  month: number;
  // True when the grid can hold more than one selected cell at a time (e.g. a
  // date range's two endpoints), so it advertises `aria-multiselectable`.
  multiselectable?: boolean;
  onDayMouseEnter?: (day: CalendarMonthDay) => void;
  onDayMouseLeave?: (day: CalendarMonthDay) => void;
  onMoveMonth: (delta: number) => void;
  onSelectDate: (isoDate: string) => void;
  selectedIsoDates?: readonly string[];
  todayIsoDate: string;
  year: number;
}

const DAYS_PER_WEEK = 7;
const CALENDAR_MONTH_OPTIONS: Intl.DateTimeFormatOptions = { month: 'long', year: 'numeric' };

export function CalendarMonthGrid({
  className,
  getDayAriaLabel,
  getDayClassName,
  isDateDisabled,
  month,
  multiselectable = false,
  onDayMouseEnter,
  onDayMouseLeave,
  onMoveMonth,
  onSelectDate,
  selectedIsoDates = [],
  todayIsoDate,
  year,
}: CalendarMonthGridProps) {
  const t = useT();
  const { locale } = useI18n();
  const calendarDays = useMemo(() => buildCalendarMonthDays(year, month), [month, year]);
  const selectedDates = useMemo(() => new Set(selectedIsoDates.filter(Boolean)), [selectedIsoDates]);
  const weeks = useMemo(() => {
    const rows: CalendarMonthDay[][] = [];
    for (let i = 0; i < calendarDays.length; i += DAYS_PER_WEEK) {
      rows.push(calendarDays.slice(i, i + DAYS_PER_WEEK));
    }
    return rows;
  }, [calendarDays]);

  const gridRef = useRef<HTMLDivElement>(null);
  // The roving day: which cell is the single tab stop (tabIndex 0). `null` until
  // the user moves with the keyboard, so the default tab stop is the selected day,
  // else today, else the first in-month day.
  const [focusIso, setFocusIso] = useState<string | null>(null);
  // When true, focus the roving cell after the next render (a keyboard move, which
  // may have crossed a month boundary, so the cell only exists post-render).
  const pendingFocus = useRef(false);

  const defaultRovingIso = useMemo(() => {
    const firstSelected = calendarDays.find((day) => selectedDates.has(day.isoDate) && !isDateDisabled?.(day.isoDate));
    if (firstSelected) return firstSelected.isoDate;
    const today = calendarDays.find((day) => day.isoDate === todayIsoDate && day.inMonth && !isDateDisabled?.(day.isoDate));
    if (today) return today.isoDate;
    return calendarDays.find((day) => day.inMonth && !isDateDisabled?.(day.isoDate))?.isoDate ?? calendarDays[0]?.isoDate ?? null;
  }, [calendarDays, isDateDisabled, selectedDates, todayIsoDate]);

  // A keyboard target that fell outside the current month window resolves to the
  // default once the new month renders (graceful fallback if the overlap missed).
  const rovingIso = focusIso && calendarDays.some((day) => day.isoDate === focusIso)
    ? focusIso
    : defaultRovingIso;

  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    const grid = gridRef.current;
    if (!grid || !rovingIso) return;
    grid.querySelector<HTMLElement>(`[data-iso="${rovingIso}"]`)?.focus();
  }, [rovingIso]);

  function moveRovingTo(targetIso: string, disabledFallbackStep: -1 | 0 | 1 = 0) {
    const resolvedIso = enabledIsoOrFallback(targetIso, disabledFallbackStep);
    if (!resolvedIso) return;
    targetIso = resolvedIso;
    setFocusIso(targetIso);
    pendingFocus.current = true;
    if (!calendarDays.some((day) => day.isoDate === targetIso)) {
      // Move the view by exactly enough months to land the target in its own
      // month window. A single arrow step is ±1 month, but Page from an overflow
      // cell (an adjacent month already shown in this window) can be ±2 — so shift
      // by the real month difference, never a fixed ±1.
      const target = parseIsoLocalDate(targetIso);
      if (target) {
        const monthDelta = (target.getFullYear() * 12 + target.getMonth()) - (year * 12 + month);
        if (monthDelta !== 0) onMoveMonth(monthDelta);
      }
    }
  }

  function enabledIsoOrFallback(targetIso: string, fallbackStep: -1 | 0 | 1): string | null {
    if (!isDateDisabled?.(targetIso)) return targetIso;
    if (fallbackStep === 0) return null;
    const target = parseIsoLocalDate(targetIso);
    if (!target) return null;
    for (let offset = fallbackStep; Math.abs(offset) <= calendarDays.length; offset += fallbackStep) {
      const candidate = isoLocalDate(addLocalDays(target, offset));
      if (!isDateDisabled?.(candidate)) return candidate;
    }
    return null;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const focusedIso = (event.target as HTMLElement | null)?.closest('[data-iso]')?.getAttribute('data-iso')
      ?? rovingIso;
    const current = focusedIso ? parseIsoLocalDate(focusedIso) : null;
    if (!current) return;

    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        moveRovingTo(isoLocalDate(addLocalDays(current, 1)), -1);
        return;
      case 'ArrowLeft':
        event.preventDefault();
        moveRovingTo(isoLocalDate(addLocalDays(current, -1)), 1);
        return;
      case 'ArrowDown':
        event.preventDefault();
        moveRovingTo(isoLocalDate(addLocalDays(current, DAYS_PER_WEEK)), -1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveRovingTo(isoLocalDate(addLocalDays(current, -DAYS_PER_WEEK)), 1);
        return;
      case 'Home': {
        // Start of the week (Monday-based, matching the grid layout).
        event.preventDefault();
        const weekday = (current.getDay() + 6) % 7;
        moveRovingTo(isoLocalDate(addLocalDays(current, -weekday)), 1);
        return;
      }
      case 'End': {
        event.preventDefault();
        const weekday = (current.getDay() + 6) % 7;
        moveRovingTo(isoLocalDate(addLocalDays(current, DAYS_PER_WEEK - 1 - weekday)), -1);
        return;
      }
      case 'PageUp':
        event.preventDefault();
        moveRovingTo(shiftIsoByMonths(current, -1), 1);
        return;
      case 'PageDown':
        event.preventDefault();
        moveRovingTo(shiftIsoByMonths(current, 1), -1);
        return;
      default:
        return;
    }
  }

  return (
    <div className={cx('calendar-month', className)}>
      <div className="calendar-month-header">
        <ButtonControl
          aria-label={t.calendar.previousMonth}
          className="calendar-month-nav"
          onClick={() => onMoveMonth(-1)}
        >
          <ChevronLeftIcon size={13} strokeWidth={1.8} />
        </ButtonControl>
        <span>{calendarMonthLabel(year, month, locale)}</span>
        <ButtonControl
          aria-label={t.calendar.nextMonth}
          className="calendar-month-nav"
          onClick={() => onMoveMonth(1)}
        >
          <ChevronRightIcon size={13} strokeWidth={1.8} />
        </ButtonControl>
      </div>
      <div className="calendar-month-weekdays" aria-hidden="true">
        {t.calendar.weekdayInitials.map((day, index) => (
          <span key={`${day}-${index}`}>{day}</span>
        ))}
      </div>
      <div
        className="calendar-month-grid"
        ref={gridRef}
        role="grid"
        aria-label={calendarMonthLabel(year, month, locale)}
        aria-multiselectable={multiselectable ? true : undefined}
        onKeyDown={handleKeyDown}
      >
        {weeks.map((week, weekIndex) => (
          <div className="calendar-month-week" role="row" key={week[0]?.isoDate ?? weekIndex}>
            {week.map((day) => {
              const handleMouseEnter: MouseEventHandler<HTMLButtonElement> | undefined = onDayMouseEnter
                ? () => onDayMouseEnter(day)
                : undefined;
              const handleMouseLeave: MouseEventHandler<HTMLButtonElement> | undefined = onDayMouseLeave
                ? () => onDayMouseLeave(day)
                : undefined;
              const isSelected = selectedDates.has(day.isoDate);
              const isDisabled = Boolean(isDateDisabled?.(day.isoDate));
              return (
                <ButtonControl
                  aria-current={day.isoDate === todayIsoDate ? 'date' : undefined}
                  aria-label={getDayAriaLabel?.(day) ?? t.calendar.selectDate({ isoDate: day.isoDate })}
                  aria-disabled={isDisabled || undefined}
                  aria-selected={isSelected}
                  className={cx(
                    'calendar-month-day',
                    !day.inMonth && 'is-outside-month',
                    day.isoDate === todayIsoDate && 'is-today',
                    isSelected && 'is-selected',
                    isDisabled && 'is-disabled',
                    getDayClassName?.(day),
                  )}
                  data-iso={day.isoDate}
                  disabled={isDisabled}
                  key={day.isoDate}
                  onClick={() => {
                    if (isDisabled) return;
                    setFocusIso(day.isoDate);
                    onSelectDate(day.isoDate);
                  }}
                  onMouseEnter={handleMouseEnter}
                  onMouseLeave={handleMouseLeave}
                  role="gridcell"
                  tabIndex={!isDisabled && day.isoDate === rovingIso ? 0 : -1}
                >
                  <span>{day.date.getDate()}</span>
                </ButtonControl>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function calendarMonthLabel(year: number, monthIndex: number, locale: string): string {
  return formatDateTime(new Date(year, monthIndex, 1), locale, CALENDAR_MONTH_OPTIONS);
}

export function shiftedCalendarMonth(year: number, monthIndex: number, delta: number): { year: number; month: number } {
  const next = new Date(year, monthIndex + delta, 1);
  return { year: next.getFullYear(), month: next.getMonth() };
}

export function buildCalendarMonthDays(year: number, monthIndex: number): CalendarMonthDay[] {
  const firstDay = new Date(year, monthIndex, 1);
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  const start = addLocalDays(firstDay, -mondayOffset);

  return Array.from({ length: 42 }, (_, index) => {
    const date = addLocalDays(start, index);
    return {
      date,
      inMonth: date.getMonth() === monthIndex,
      isoDate: isoLocalDate(date),
    };
  });
}

// Same day-of-month in another month, clamped to that month's last day (so
// PageUp/PageDown from the 31st lands on the 28th/30th rather than rolling over).
function shiftIsoByMonths(date: Date, deltaMonths: number): string {
  const year = date.getFullYear();
  const month = date.getMonth() + deltaMonths;
  const lastDay = new Date(year, month + 1, 0).getDate();
  return isoLocalDate(new Date(year, month, Math.min(date.getDate(), lastDay)));
}
