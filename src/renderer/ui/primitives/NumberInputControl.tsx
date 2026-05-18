import { forwardRef, type InputHTMLAttributes } from 'react';

interface NumberInputControlProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'aria-label' | 'type'> {
  label: string;
}

export const NumberInputControl = forwardRef<HTMLInputElement, NumberInputControlProps>(function NumberInputControl({
  label,
  ...inputProps
}, ref) {
  return (
    <input
      ref={ref}
      {...inputProps}
      aria-label={label}
      type="number"
    />
  );
});
