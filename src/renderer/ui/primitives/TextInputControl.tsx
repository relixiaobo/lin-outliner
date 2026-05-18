import type { InputHTMLAttributes } from 'react';

interface TextInputControlProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'aria-label'> {
  label: string;
}

export function TextInputControl({
  label,
  type = 'text',
  ...inputProps
}: TextInputControlProps) {
  return (
    <input
      {...inputProps}
      aria-label={label}
      type={type}
    />
  );
}
