import { forwardRef, type InputHTMLAttributes } from 'react';
import { cx } from './cx';

interface TimeInputControlProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'aria-label' | 'onInput' | 'step' | 'type' | 'value'
> {
  label: string;
  onValueChange: (value: string) => void;
  value: string;
}

export const TimeInputControl = forwardRef<HTMLInputElement, TimeInputControlProps>(function TimeInputControl({
  className,
  label,
  onValueChange,
  value,
  ...inputProps
}, ref) {
  return (
    <input
      ref={ref}
      {...inputProps}
      aria-label={label}
      className={cx('time-input-control', className)}
      onInput={(event) => onValueChange(event.currentTarget.value)}
      step={60}
      type="time"
      value={value}
    />
  );
});
