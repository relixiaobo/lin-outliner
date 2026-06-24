import { useEffect, useMemo, useRef, useState } from 'react';
import { nextDateScheduleDue } from '../../../core/dateSchedule';
import { api } from '../../api/client';
import { dateFieldEndpointDate, formatDateFieldInput, parseDateFieldValue } from '../../api/types';
import { useI18n } from '../../i18n/I18nProvider';
import { CalendarIcon, LoaderIcon } from '../icons';
import { DateValuePicker } from '../outliner/DateValuePicker';
import { scheduleChipSummary } from '../outliner/dateRecurrence';
import { Button } from '../primitives/Button';

interface DreamLauncherProps {
  dreamSchedule?: string;
  isStreaming: boolean;
  onSettingsChanged?: () => void;
}

interface DreamReadinessWindow {
  start: string;
  end: string;
}

export function DreamLauncher({ dreamSchedule, isStreaming, onSettingsChanged }: DreamLauncherProps) {
  const { locale, t } = useI18n();
  const [scheduleDraft, setScheduleDraft] = useState(dreamSchedule ?? '');
  const [manualStartDate, setManualStartDate] = useState(() => todayInputValue());
  const [manualEndDate, setManualEndDate] = useState(() => todayInputValue());
  const [manualGuidance, setManualGuidance] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [runningManual, setRunningManual] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const today = todayInputValue();
  const savedSchedule = dreamSchedule ?? '';
  const scheduleSummary = useMemo(() => scheduleDraft ? scheduleChipSummary(scheduleDraft, t.outliner.field.datePicker) : '', [
    scheduleDraft,
    t.outliner.field.datePicker,
  ]);
  const nextRunLabel = useMemo(() => {
    if (!scheduleDraft) return '';
    const next = nextDateScheduleDue(scheduleDraft, now);
    return next ? t.agent.chat.dreamNextRun({ time: formatDreamNextRun(next, locale) }) : '';
  }, [locale, now, scheduleDraft, t]);

  useEffect(() => {
    setScheduleDraft(dreamSchedule ?? '');
  }, [dreamSchedule]);

  useEffect(() => {
    let cancelled = false;
    api.agentDreamReadiness()
      .then((readiness) => {
        if (cancelled || !readiness.window) return;
        setManualWindow(readiness.window, setManualStartDate, setManualEndDate);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  async function saveSchedule() {
    if (!scheduleDraft || savingSchedule) return;
    setSavingSchedule(true);
    setError(null);
    try {
      await api.agentUpdateRuntimeSettings({ dreamSchedule: scheduleDraft });
      onSettingsChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSavingSchedule(false);
    }
  }

  async function runManualDream() {
    if (runningManual || isStreaming || !manualStartDate || !manualEndDate) return;
    if (manualStartDate > manualEndDate || manualStartDate > today || manualEndDate > today) return;
    setRunningManual(true);
    setError(null);
    try {
      await api.agentRunDreamNow({
        startDate: manualStartDate,
        endDate: manualEndDate,
        guidance: manualGuidance,
        limit: 50,
      });
      setManualGuidance('');
      setManualOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunningManual(false);
    }
  }

  const scheduleChanged = scheduleDraft !== savedSchedule;
  const scheduleSaveDisabled = savingSchedule || !scheduleDraft || !scheduleChanged;
  const manualRunDisabled = runningManual
    || isStreaming
    || !manualStartDate
    || !manualEndDate
    || manualStartDate > manualEndDate
    || manualStartDate > today
    || manualEndDate > today;

  return (
    <section className="dream-launcher" aria-label={t.agent.chat.dreamLauncherAriaLabel}>
      <div className="agent-composer-surface dream-launcher-surface">
        <div className="dream-schedule-head">
          <div className="dream-schedule-copy">
            <span className="dream-schedule-title">{t.agent.chat.dreamScheduleTitle}</span>
            {nextRunLabel ? <span className="dream-schedule-next">{nextRunLabel}</span> : null}
          </div>
          <Button
            className="dream-manual-open"
            disabled={isStreaming}
            onClick={() => setManualOpen(true)}
            size="sm"
            variant="ghost"
          >
            {t.agent.chat.dreamManualRunButton}
          </Button>
        </div>
        <div className="dream-schedule-row">
          <DreamScheduleField
            schedule={scheduleDraft}
            summary={scheduleSummary}
            onChange={setScheduleDraft}
          />
          <Button
            className="dream-schedule-save"
            disabled={scheduleSaveDisabled}
            onClick={() => {
              void saveSchedule();
            }}
            size="sm"
            variant="primary"
          >
            {savingSchedule ? t.agent.chat.dreamScheduleSaving : t.agent.chat.dreamScheduleSave}
          </Button>
        </div>
        {error ? <div className="agent-composer-error dream-launcher-error" role="status">{error}</div> : null}
        {manualOpen ? (
          <ManualRunPopover
            endDate={manualEndDate}
            guidance={manualGuidance}
            maxDate={today}
            running={runningManual}
            runDisabled={manualRunDisabled}
            startDate={manualStartDate}
            onCancel={() => setManualOpen(false)}
            onDateChange={(start, end) => {
              setManualStartDate(start);
              setManualEndDate(end);
            }}
            onGuidanceChange={setManualGuidance}
            onRun={() => {
              void runManualDream();
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

interface DreamScheduleFieldProps {
  onChange: (schedule: string) => void;
  schedule: string;
  summary: string;
}

function DreamScheduleField({ onChange, schedule, summary }: DreamScheduleFieldProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="dream-schedule-field">
      <button
        ref={anchorRef}
        type="button"
        className={`dream-schedule-trigger ${open ? 'is-open' : ''} ${summary ? '' : 'is-empty'}`.trim()}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="dream-schedule-value">
          {summary || t.agent.chat.dreamSchedulePlaceholder}
        </span>
        <CalendarIcon size={13} strokeWidth={1.8} />
      </button>
      <DateValuePicker
        anchorRef={anchorRef}
        value={schedule}
        open={open}
        onOpenChange={setOpen}
        onCommit={(nextValue) => onChange(nextValue)}
        allowRange={false}
        popoverGap={10}
        popoverPlacement="top-start"
      />
    </div>
  );
}

interface ManualRunPopoverProps {
  endDate: string;
  guidance: string;
  maxDate: string;
  onCancel: () => void;
  onDateChange: (startDate: string, endDate: string) => void;
  onGuidanceChange: (guidance: string) => void;
  onRun: () => void;
  runDisabled: boolean;
  running: boolean;
  startDate: string;
}

function ManualRunPopover({
  endDate,
  guidance,
  maxDate,
  onCancel,
  onDateChange,
  onGuidanceChange,
  onRun,
  runDisabled,
  running,
  startDate,
}: ManualRunPopoverProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('.typed-field-date-popover')) return;
      onCancel();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [onCancel]);

  useEffect(() => {
    textareaRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      ref={panelRef}
      className="dream-manual-popover"
      role="dialog"
      aria-label={t.agent.chat.dreamManualDialogTitle}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="dream-manual-head">
        <span className="dream-manual-title">{t.agent.chat.dreamManualDialogTitle}</span>
      </div>
      <label className="dream-manual-field">
        <span className="dream-manual-label">{t.agent.chat.dreamManualDateLabel}</span>
        <DreamManualDateField
          endDate={endDate}
          maxDate={maxDate}
          startDate={startDate}
          onChange={onDateChange}
        />
      </label>
      <label className="dream-manual-field">
        <span className="dream-manual-label">{t.agent.chat.dreamManualFocusLabel}</span>
        <textarea
          ref={textareaRef}
          className="dream-manual-guidance"
          value={guidance}
          onChange={(event) => onGuidanceChange(event.currentTarget.value)}
          placeholder={t.agent.chat.dreamManualFocusPlaceholder}
          rows={3}
        />
      </label>
      <div className="dream-manual-actions">
        <Button onClick={onCancel} size="sm" variant="ghost">
          {t.dialog.cancel}
        </Button>
        <Button disabled={runDisabled} onClick={onRun} size="sm" variant="primary">
          {running ? t.agent.chat.dreamLauncherBusy : t.agent.chat.dreamManualRunConfirm}
        </Button>
      </div>
    </div>
  );
}

interface DreamManualDateFieldProps {
  endDate: string;
  maxDate: string;
  onChange: (startDate: string, endDate: string) => void;
  startDate: string;
}

function DreamManualDateField({ endDate, maxDate, onChange, startDate }: DreamManualDateFieldProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const value = formatDreamDatePickerValue(startDate, endDate);
  const label = formatDreamDateValue(startDate, endDate);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`dream-manual-date-trigger ${open ? 'is-open' : ''}`.trim()}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        <span className={`dream-manual-date-value ${label ? '' : 'is-empty'}`.trim()}>
          {label || 'YYYY-MM-DD'}
        </span>
        <CalendarIcon size={13} strokeWidth={1.8} />
      </button>
      <DateValuePicker
        anchorRef={anchorRef}
        value={value}
        open={open}
        onOpenChange={setOpen}
        onCommit={(nextValue) => {
          if (!nextValue) {
            onChange('', '');
            return;
          }
          const parsed = parseDateFieldValue(nextValue);
          if (parsed?.kind === 'range') {
            onChange(dateFieldEndpointDate(parsed.start), dateFieldEndpointDate(parsed.end));
            return;
          }
          if (parsed?.kind === 'single') {
            const selectedDate = dateFieldEndpointDate(parsed.date);
            onChange(selectedDate, selectedDate);
          }
        }}
        allowRange
        allowTime={false}
        allowRecurrence={false}
        maxDate={maxDate}
        popoverMaxHeight={380}
      />
    </>
  );
}

function setManualWindow(
  window: DreamReadinessWindow,
  setStartDate: (date: string) => void,
  setEndDate: (date: string) => void,
): void {
  setStartDate(window.start);
  setEndDate(window.end);
}

function formatDreamNextRun(value: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

function formatDreamDatePickerValue(startDate: string, endDate: string): string {
  if (startDate && endDate && startDate === endDate) return formatDateFieldInput(startDate, '');
  return formatDateFieldInput(startDate, endDate);
}

function formatDreamDateValue(startDate: string, endDate: string): string {
  if (!startDate && !endDate) return '';
  if (!startDate || !endDate || startDate === endDate) return startDate || endDate;
  return `${startDate}/${endDate}`;
}

function todayInputValue(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
