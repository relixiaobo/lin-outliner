import type { InputHTMLAttributes } from 'react';

interface TextInputControlProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'aria-label' | 'type'> {
  label: string;
}

export function TextInputControl({
  label,
  ...inputProps
}: TextInputControlProps) {
  return (
    <input
      {...inputProps}
      aria-label={label}
      type="text"
    />
  );
}
