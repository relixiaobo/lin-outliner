import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/I18nProvider';
import { ClockIcon, ICON_SIZE } from '../icons';
import { ButtonControl } from './ButtonControl';
import { cx } from './cx';
import { DIALOG_NESTED_OVERLAY_ATTRIBUTE } from './dialogNestedOverlay';
import { MenuSurface } from './MenuSurface';
import { useAnchoredOverlay } from './useAnchoredOverlay';
import { useMenuKeyboard } from './useMenuKeyboard';

interface TimePickerControlProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'aria-label' | 'onChange' | 'onInput' | 'step' | 'type' | 'value'
> {
  label: string;
  onValueChange: (value: string) => void;
  value: string;
}

const HOURS = numericOptions(24);
const MINUTES = numericOptions(60);

export const TimePickerControl = forwardRef<HTMLInputElement, TimePickerControlProps>(function TimePickerControl({
  className,
  disabled,
  label,
  onBlur,
  onKeyDown,
  onValueChange,
  value,
  ...inputProps
}, forwardedRef) {
  const t = useT().timePicker;
  const inputRef = useRef<HTMLInputElement>(null);
  const shellRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const hourListRef = useRef<HTMLDivElement>(null);
  const minuteListRef = useRef<HTMLDivElement>(null);
  const restoreTargetRef = useRef<HTMLElement | null>(null);
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);

  useImperativeHandle(forwardedRef, () => inputRef.current as HTMLInputElement);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const close = useCallback(() => setOpen(false), []);
  const style = useAnchoredOverlay(popoverRef, {
    anchorRef: shellRef,
    disabled: !open,
    layoutKey: value,
    maxHeight: 280,
    placement: 'bottom-end',
    width: 184,
  });
  const { onKeyDown: onPopoverKeyDown } = useMenuKeyboard({
    active: open,
    surfaceRef: popoverRef,
    onClose: close,
    kind: 'dialog',
    getRestoreTarget: () => restoreTargetRef.current,
  });

  useEffect(() => {
    if (!open) return undefined;
    const frame = requestFrame(() => {
      hourListRef.current?.focus({ preventScroll: true });
      popoverRef.current?.querySelectorAll<HTMLElement>('[aria-selected="true"]')
        .forEach((option) => option.scrollIntoView?.({ block: 'center' }));
    });
    return () => cancelFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target) || shellRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [close, open]);

  const selected = parseTimeValue(value) ?? { hour: 0, minute: 0 };

  function openPicker(restoreTarget: HTMLElement | null): void {
    if (disabled) return;
    restoreTargetRef.current = restoreTarget;
    setOpen(true);
  }

  function updateDraft(nextDraft: string): void {
    setDraft(nextDraft);
    const parsed = parseTimeValue(nextDraft);
    if (parsed) onValueChange(formatTime(parsed.hour, parsed.minute));
  }

  function commitDraft(): void {
    const parsed = parseTimeValue(draft);
    if (parsed) {
      const normalized = formatTime(parsed.hour, parsed.minute);
      setDraft(normalized);
      if (normalized !== value) onValueChange(normalized);
      return;
    }
    setDraft(value);
  }

  function updateTime(part: 'hour' | 'minute', nextValue: number): void {
    const next = {
      hour: part === 'hour' ? nextValue : selected.hour,
      minute: part === 'minute' ? nextValue : selected.minute,
    };
    const normalized = formatTime(next.hour, next.minute);
    setDraft(normalized);
    onValueChange(normalized);
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === 'ArrowDown' && (event.metaKey || event.altKey)) {
      event.preventDefault();
      openPicker(event.currentTarget);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      commitDraft();
      event.currentTarget.blur();
      return;
    }
    if (event.key === 'Escape') {
      setDraft(value);
      close();
      event.currentTarget.blur();
    }
  }

  return (
    <>
      <span className={cx('time-picker-control', open && 'is-open', className)} ref={shellRef}>
        <input
          ref={inputRef}
          {...inputProps}
          aria-label={label}
          className="time-picker-input"
          disabled={disabled}
          inputMode="numeric"
          maxLength={5}
          onBlur={(event) => {
            commitDraft();
            onBlur?.(event);
          }}
          onInput={(event) => updateDraft(event.currentTarget.value)}
          onKeyDown={handleInputKeyDown}
          placeholder="00:00"
          spellCheck={false}
          type="text"
          value={draft}
        />
        <ButtonControl
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={t.open}
          className="time-picker-trigger"
          disabled={disabled}
          onClick={(event) => openPicker(event.currentTarget)}
        >
          <ClockIcon aria-hidden size={ICON_SIZE.menu} />
        </ButtonControl>
      </span>
      {open ? createPortal(
        <MenuSurface
          aria-label={t.title}
          className="time-picker-popover"
          {...{ [DIALOG_NESTED_OVERLAY_ATTRIBUTE]: 'true' }}
          onKeyDown={onPopoverKeyDown}
          ref={popoverRef}
          role="dialog"
          style={style}
        >
          <TimePickerColumn
            label={t.hour}
            listRef={hourListRef}
            onSelect={(nextHour) => updateTime('hour', nextHour)}
            selected={selected.hour}
            values={HOURS}
          />
          <TimePickerColumn
            closeOnPointerSelect
            label={t.minute}
            listRef={minuteListRef}
            onSelect={(nextMinute) => updateTime('minute', nextMinute)}
            onSelectionComplete={close}
            selected={selected.minute}
            values={MINUTES}
          />
        </MenuSurface>,
        document.body,
      ) : null}
    </>
  );
});

interface TimePickerColumnProps {
  closeOnPointerSelect?: boolean;
  label: string;
  listRef: RefObject<HTMLDivElement | null>;
  onSelect: (value: number) => void;
  onSelectionComplete?: () => void;
  selected: number;
  values: readonly number[];
}

function TimePickerColumn({
  closeOnPointerSelect = false,
  label,
  listRef,
  onSelect,
  onSelectionComplete,
  selected,
  values,
}: TimePickerColumnProps) {
  const reactId = useId().replace(/:/g, '');
  const listId = `time-picker-${reactId}`;

  function select(nextValue: number): void {
    onSelect(nextValue);
    requestFrame(() => {
      listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
        ?.scrollIntoView?.({ block: 'nearest' });
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    let next = selected;
    if (event.key === 'ArrowDown') next = (selected + 1) % values.length;
    else if (event.key === 'ArrowUp') next = (selected - 1 + values.length) % values.length;
    else if (event.key === 'PageDown') next = Math.min(values.length - 1, selected + 5);
    else if (event.key === 'PageUp') next = Math.max(0, selected - 5);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = values.length - 1;
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelectionComplete?.();
      return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
    select(next);
  }

  return (
    <div className="time-picker-column">
      <span className="time-picker-column-label" id={`${listId}-label`}>{label}</span>
      <div
        aria-activedescendant={`${listId}-${formatTwoDigits(selected)}`}
        aria-labelledby={`${listId}-label`}
        className="time-picker-list"
        onKeyDown={handleKeyDown}
        ref={listRef}
        role="listbox"
        tabIndex={0}
      >
        {values.map((option) => {
          const optionLabel = formatTwoDigits(option);
          const isSelected = option === selected;
          return (
            <div
              aria-selected={isSelected}
              className={cx('time-picker-option', isSelected && 'is-selected')}
              id={`${listId}-${optionLabel}`}
              key={option}
              onClick={() => {
                select(option);
                if (closeOnPointerSelect) onSelectionComplete?.();
              }}
              role="option"
            >
              {optionLabel}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function numericOptions(count: number): readonly number[] {
  return Array.from({ length: count }, (_, value) => value);
}

function parseTimeValue(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function formatTime(hour: number, minute: number): string {
  return `${formatTwoDigits(hour)}:${formatTwoDigits(minute)}`;
}

function requestFrame(callback: FrameRequestCallback): number {
  return window.requestAnimationFrame?.(callback)
    ?? window.setTimeout(() => callback(Date.now()), 0);
}

function cancelFrame(handle: number): void {
  if (window.cancelAnimationFrame) window.cancelAnimationFrame(handle);
  else window.clearTimeout(handle);
}

function formatTwoDigits(value: number): string {
  return String(value).padStart(2, '0');
}
