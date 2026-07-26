import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n, useT } from '../../i18n/I18nProvider';
import { CalendarIcon, ChevronDownIcon, ICON_SIZE } from '../../ui/icons';
import { formatDateTime } from '../../ui/formatting';
import { DateValuePicker } from '../../ui/outliner/DateValuePicker';
import { CheckboxMark } from '../../ui/primitives/CheckboxMark';
import { Field } from '../../ui/primitives/Field';
import { MenuItem } from '../../ui/primitives/MenuItem';
import { MenuSurface } from '../../ui/primitives/MenuSurface';
import { NumberInputControl } from '../../ui/primitives/NumberInputControl';
import { SelectControl } from '../../ui/primitives/SelectControl';
import { TimePickerControl } from '../../ui/primitives/TimePickerControl';
import { useAnchoredOverlay } from '../../ui/primitives/useAnchoredOverlay';
import { useMenuKeyboard } from '../../ui/primitives/useMenuKeyboard';
import {
  AUTOMATION_CUSTOM_FREQUENCIES,
  AUTOMATION_SCHEDULE_MODES,
  AUTOMATION_WEEKDAYS,
  type AutomationCustomFrequency,
  type AutomationScheduleDraft,
  type AutomationScheduleMode,
  type AutomationWeekday,
  startAtDate,
  startAtTime,
  updateAutomationScheduleDate,
  updateAutomationScheduleMode,
  updateAutomationScheduleTime,
} from './AutomationScheduleDraft';

const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);
interface AutomationScheduleEditorProps {
  readonly disabled: boolean;
  readonly schedule: AutomationScheduleDraft;
  readonly timezone: string;
  readonly timezones: readonly string[];
  readonly onChange: (schedule: AutomationScheduleDraft) => void;
  readonly onTimezoneChange: (timezone: string) => void;
}

export function AutomationScheduleEditor({
  disabled,
  schedule,
  timezone,
  timezones,
  onChange,
  onTimezoneChange,
}: AutomationScheduleEditorProps) {
  const t = useT().agent.automations;
  const custom = schedule.mode === 'custom';
  const usesTime = schedule.mode === 'once'
    || schedule.mode === 'daily'
    || schedule.mode === 'weekdays'
    || schedule.mode === 'weekly'
    || (custom && schedule.customFrequency !== 'hourly');
  const usesWeekdays = schedule.mode === 'weekly'
    || (custom && schedule.customFrequency === 'weekly');

  function update(patch: Partial<AutomationScheduleDraft>): void {
    onChange({ ...schedule, ...patch, sourceRrule: null });
  }

  return (
    <div className="automation-settings-group">
      <Field className="automation-setting-row" label={t.repeat} labelClassName="automation-setting-label">
        <SelectControl
          className="automation-setting-value"
          disabled={disabled}
          label={t.repeat}
          onChange={(event) => onChange(updateAutomationScheduleMode(
            schedule,
            event.target.value as AutomationScheduleMode,
          ))}
          value={schedule.mode}
          variant="popup"
        >
          {AUTOMATION_SCHEDULE_MODES.map((mode) => (
            <option key={mode} value={mode}>{t.frequencies[mode]}</option>
          ))}
        </SelectControl>
      </Field>

      {schedule.mode === 'once' ? (
        <Field className="automation-setting-row" label={t.date} labelClassName="automation-setting-label">
          <AutomationDatePicker
            disabled={disabled}
            label={t.date}
            onChange={(date) => onChange(updateAutomationScheduleDate(schedule, date))}
            value={startAtDate(schedule.startAt)}
          />
        </Field>
      ) : null}

      {usesWeekdays && !custom ? (
        <Field className="automation-setting-row" label={t.weekday} labelClassName="automation-setting-label">
          <AutomationMultiSelect
            disabled={disabled}
            label={t.weekday}
            onChange={(weekdays) => update({ weekdays })}
            options={AUTOMATION_WEEKDAYS.map((weekday) => ({
              id: weekday,
              label: t.weekdays[weekday],
              summary: t.weekdayShort[weekday],
            }))}
            values={schedule.weekdays}
          />
        </Field>
      ) : null}

      {usesTime && !custom ? (
        <Field className="automation-setting-row" label={t.startAt} labelClassName="automation-setting-label">
          <TimePickerControl
            className="automation-time-input"
            disabled={disabled}
            label={t.startAt}
            onValueChange={(time) => onChange(updateAutomationScheduleTime(schedule, time))}
            value={startAtTime(schedule.startAt)}
          />
        </Field>
      ) : null}

      {custom ? (
        <>
          <Field className="automation-setting-row" label={t.repeats} labelClassName="automation-setting-label">
            <SelectControl
              className="automation-setting-value"
              disabled={disabled}
              label={t.repeats}
              onChange={(event) => update({ customFrequency: event.target.value as AutomationCustomFrequency })}
              value={schedule.customFrequency}
              variant="popup"
            >
              {AUTOMATION_CUSTOM_FREQUENCIES.map((frequency) => (
                <option key={frequency} value={frequency}>{t.customFrequencies[frequency]}</option>
              ))}
            </SelectControl>
          </Field>

          <Field className="automation-setting-row" label={t.every} labelClassName="automation-setting-label">
            <label className="automation-number-setting">
              <NumberInputControl
                disabled={disabled}
                label={t.every}
                max={999}
                min={1}
                onChange={(event) => update({ interval: boundedNumber(event.target.value, 1, 999, schedule.interval) })}
                value={schedule.interval}
              />
              <span>{t.intervalUnit({ frequency: schedule.customFrequency, count: schedule.interval })}</span>
            </label>
          </Field>

          {schedule.customFrequency === 'weekly' ? (
            <Field className="automation-setting-row" label={t.weekday} labelClassName="automation-setting-label">
              <AutomationMultiSelect
                disabled={disabled}
                label={t.weekday}
                onChange={(weekdays) => update({ weekdays })}
                options={AUTOMATION_WEEKDAYS.map((weekday) => ({
                  id: weekday,
                  label: t.weekdays[weekday],
                  summary: t.weekdayShort[weekday],
                }))}
                values={schedule.weekdays}
              />
            </Field>
          ) : null}

          {schedule.customFrequency === 'yearly' ? (
            <Field className="automation-setting-row" label={t.inMonth} labelClassName="automation-setting-label">
              <SelectControl
                className="automation-setting-value"
                disabled={disabled}
                label={t.inMonth}
                onChange={(event) => update({ month: Number(event.target.value) })}
                value={schedule.month}
                variant="popup"
              >
                {t.months.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}
              </SelectControl>
            </Field>
          ) : null}

          {schedule.customFrequency === 'monthly' || schedule.customFrequency === 'yearly' ? (
            <Field className="automation-setting-row" label={t.onDays} labelClassName="automation-setting-label">
              <AutomationMultiSelect
                disabled={disabled}
                label={t.onDays}
                onChange={(monthDays) => update({ monthDays })}
                options={MONTH_DAYS.map((day) => ({ id: day, label: String(day), summary: String(day) }))}
                summary={schedule.monthDays.length <= 3
                  ? schedule.monthDays.join(', ')
                  : t.daysSelected({ count: schedule.monthDays.length })}
                values={schedule.monthDays}
              />
            </Field>
          ) : null}

          {schedule.customFrequency === 'hourly' ? (
            <Field className="automation-setting-row" label={t.atMinute} labelClassName="automation-setting-label">
              <NumberInputControl
                className="automation-number-input"
                disabled={disabled}
                label={t.atMinute}
                max={59}
                min={0}
                onChange={(event) => update({ minute: boundedNumber(event.target.value, 0, 59, schedule.minute) })}
                value={schedule.minute}
              />
            </Field>
          ) : (
            <Field className="automation-setting-row" label={t.startAt} labelClassName="automation-setting-label">
              <TimePickerControl
                className="automation-time-input"
                disabled={disabled}
                label={t.startAt}
                onValueChange={(time) => onChange(updateAutomationScheduleTime(schedule, time))}
                value={startAtTime(schedule.startAt)}
              />
            </Field>
          )}
        </>
      ) : null}

      <Field className="automation-setting-row" label={t.timezone} labelClassName="automation-setting-label">
        <SelectControl
          className="automation-setting-value"
          disabled={disabled}
          label={t.timezone}
          onChange={(event) => onTimezoneChange(event.target.value)}
          value={timezone}
          variant="popup"
        >
          {timezones.map((option) => <option key={option} value={option}>{option}</option>)}
        </SelectControl>
      </Field>
    </div>
  );
}

interface AutomationDatePickerProps {
  readonly disabled: boolean;
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly value: string;
}

function AutomationDatePicker({ disabled, label, onChange, value }: AutomationDatePickerProps) {
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        className="automation-date-trigger"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        type="button"
      >
        <span>{scheduleDateLabel(value, locale)}</span>
        <CalendarIcon aria-hidden size={ICON_SIZE.rowGlyph} />
      </button>
      <DateValuePicker
        allowClear={false}
        allowRange={false}
        allowRecurrence={false}
        allowTime={false}
        anchorRef={triggerRef}
        onCommit={(nextValue) => {
          if (nextValue) onChange(nextValue);
        }}
        onOpenChange={setOpen}
        open={open}
        popoverPlacement="bottom-end"
        value={value}
      />
    </>
  );
}

interface MultiSelectOption<Value extends string | number> {
  readonly id: Value;
  readonly label: string;
  readonly summary: string;
}

interface AutomationMultiSelectProps<Value extends string | number> {
  readonly disabled: boolean;
  readonly label: string;
  readonly onChange: (values: readonly Value[]) => void;
  readonly options: readonly MultiSelectOption<Value>[];
  readonly summary?: string;
  readonly values: readonly Value[];
}

function AutomationMultiSelect<Value extends string | number>(props: AutomationMultiSelectProps<Value>) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const style = useAnchoredOverlay(menuRef, {
    anchorRef: triggerRef,
    disabled: !open,
    layoutKey: String(props.options.length),
    maxHeight: 320,
    placement: 'bottom-end',
    width: 200,
  });
  const { onKeyDown } = useMenuKeyboard({
    active: open,
    surfaceRef: menuRef,
    onClose: close,
    kind: 'menu',
    getRestoreTarget: () => triggerRef.current,
  });

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      queueMicrotask(() => {
        close();
        triggerRef.current?.focus({ preventScroll: true });
      });
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [close, open]);

  const selected = new Set(props.values);
  const selectedOptions = props.options.filter((option) => selected.has(option.id));
  const summary = props.summary
    ?? (selectedOptions.length === 1
      ? selectedOptions[0]!.label
      : selectedOptions.map((option) => option.summary).join(', '));

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={props.label}
        className="automation-multi-select-trigger"
        disabled={props.disabled}
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        type="button"
      >
        <span>{summary}</span>
        <ChevronDownIcon aria-hidden size={ICON_SIZE.rowGlyph} />
      </button>
      {open ? createPortal(
        <MenuSurface
          aria-label={props.label}
          className="anchored-overlay-surface automation-multi-select-menu"
          data-dialog-nested-overlay="true"
          onKeyDown={onKeyDown}
          ref={menuRef}
          role="menu"
          style={style}
        >
          {props.options.map((option) => {
            const checked = selected.has(option.id);
            return (
              <MenuItem
                active={checked}
                aria-checked={checked}
                className="automation-multi-select-option"
                icon={<CheckboxMark checked={checked} />}
                key={option.id}
                label={option.label}
                onClick={() => {
                  const next = checked
                    ? props.values.filter((value) => value !== option.id)
                    : [...props.values, option.id];
                  if (next.length > 0) props.onChange(next);
                }}
                role="menuitemcheckbox"
              />
            );
          })}
        </MenuSurface>,
        document.body,
      ) : null}
    </>
  );
}

function scheduleDateLabel(value: string, locale: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return formatDateTime(date, locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

function boundedNumber(value: string, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
}
