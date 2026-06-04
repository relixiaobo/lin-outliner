import { useMemo, type MouseEventHandler } from 'react';
import { addLocalDays, isoLocalDate } from '../../api/types';
import { useI18n, useT } from '../../i18n/I18nProvider';
import { ChevronLeftIcon, ChevronRightIcon } from '../icons';
import { ButtonControl } from './ButtonControl';

export interface CalendarMonthDay {
  date: Date;
  inMonth: boolean;
  isoDate: string;
}

interface CalendarMonthGridProps {
  className?: string;
  getDayAriaLabel?: (day: CalendarMonthDay) => string;
  getDayClassName?: (day: CalendarMonthDay) => string;
  month: number;
  onDayMouseEnter?: (day: CalendarMonthDay) => void;
  onDayMouseLeave?: (day: CalendarMonthDay) => void;
  onMoveMonth: (delta: number) => void;
  onSelectDate: (isoDate: string) => void;
  selectedIsoDates?: readonly string[];
  todayIsoDate: string;
  year: number;
}

export function CalendarMonthGrid({
  className,
  getDayAriaLabel,
  getDayClassName,
  month,
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

  return (
    <div className={['calendar-month', className].filter(Boolean).join(' ')}>
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
      <div className="calendar-month-grid">
        {calendarDays.map((day) => {
          const handleMouseEnter: MouseEventHandler<HTMLButtonElement> | undefined = onDayMouseEnter
            ? () => onDayMouseEnter(day)
            : undefined;
          const handleMouseLeave: MouseEventHandler<HTMLButtonElement> | undefined = onDayMouseLeave
            ? () => onDayMouseLeave(day)
            : undefined;
          return (
            <ButtonControl
              aria-label={getDayAriaLabel?.(day) ?? t.calendar.selectDate({ isoDate: day.isoDate })}
              className={[
                'calendar-month-day',
                day.inMonth ? '' : 'is-outside-month',
                day.isoDate === todayIsoDate ? 'is-today' : '',
                selectedDates.has(day.isoDate) ? 'is-selected' : '',
                getDayClassName?.(day) ?? '',
              ].filter(Boolean).join(' ')}
              key={day.isoDate}
              onClick={() => onSelectDate(day.isoDate)}
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
            >
              <span>{day.date.getDate()}</span>
            </ButtonControl>
          );
        })}
      </div>
    </div>
  );
}

export function calendarMonthLabel(year: number, monthIndex: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' })
    .format(new Date(year, monthIndex, 1));
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
