import { forwardRef, type InputHTMLAttributes } from 'react';

interface TextInputControlProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'aria-label'> {
  label: string;
}

export const TextInputControl = forwardRef<HTMLInputElement, TextInputControlProps>(function TextInputControl({
  label,
  type = 'text',
  ...inputProps
}, ref) {
  return (
    <input
      ref={ref}
      {...inputProps}
      aria-label={label}
      type={type}
    />
  );
});
