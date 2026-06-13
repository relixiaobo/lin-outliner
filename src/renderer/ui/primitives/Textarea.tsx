import { forwardRef, type TextareaHTMLAttributes } from 'react';
import type { InputSize, InputVariant } from './Input';
import { cx } from './cx';

interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'aria-label'> {
  label: string;
  size?: InputSize;
  variant?: InputVariant;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({
  className,
  label,
  size = 'md',
  variant = 'boxed',
  ...textareaProps
}, ref) {
  const classes = cx(
    'input-control',
    'textarea-control',
    `input-${variant}`,
    `input-${size}`,
    className,
  );

  return (
    <textarea
      ref={ref}
      {...textareaProps}
      aria-label={label}
      className={classes}
    />
  );
});
