import { forwardRef, type InputHTMLAttributes } from 'react';
import { cx } from './cx';

export type InputVariant = 'boxed' | 'bare';
export type InputSize = 'md' | 'sm';

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'aria-label' | 'size'> {
  label: string;
  size?: InputSize;
  variant?: InputVariant;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({
  className,
  label,
  size = 'md',
  type = 'text',
  variant = 'boxed',
  ...inputProps
}, ref) {
  const classes = cx(
    'input-control',
    `input-${variant}`,
    `input-${size}`,
    className,
  );

  return (
    <input
      ref={ref}
      {...inputProps}
      aria-label={label}
      className={classes}
      type={type}
    />
  );
});
