import { useRef, type KeyboardEvent } from 'react';
import { cx } from './cx';

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentedControlOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the whole group (e.g. "Theme"). */
  label: string;
  className?: string;
  /** Read-only display: segments render disabled and selection is a no-op. */
  disabled?: boolean;
}

// A macOS-style segmented control: a horizontal row of mutually-exclusive
// segments where the selected one carries a neutral fill (design-system B3 —
// functional state is neutral, never a brand accent). Modeled as an ARIA
// radiogroup with roving tabindex: only the selected segment is tab-stoppable,
// and Arrow keys move + select within the group (B8 — keyboard parity).
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
  disabled = false,
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  // Only notify on an actual change — re-selecting the active segment is a no-op,
  // matching the native radio convention (and avoiding a redundant persist).
  function select(next: T) {
    if (disabled) return;
    if (next !== value) onChange(next);
  }

  function focusAndSelect(index: number) {
    const next = options[index];
    if (!next) return;
    select(next.value);
    refs.current[index]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      focusAndSelect((index + 1) % options.length);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusAndSelect((index - 1 + options.length) % options.length);
    }
  }

  return (
    <div
      aria-label={label}
      className={cx('segmented-control', className)}
      role="radiogroup"
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            aria-checked={selected}
            className={cx('segmented-control-option', selected && 'is-selected')}
            disabled={disabled}
            key={option.value}
            onClick={() => select(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            ref={(el) => { refs.current[index] = el; }}
            role="radio"
            tabIndex={selected ? 0 : -1}
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
