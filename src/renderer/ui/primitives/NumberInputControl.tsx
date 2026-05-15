import type { InputHTMLAttributes } from 'react';

interface NumberInputControlProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'aria-label' | 'type'> {
  label: string;
}

export function NumberInputControl({
  label,
  ...inputProps
}: NumberInputControlProps) {
  return (
    <input
      {...inputProps}
      aria-label={label}
      type="number"
    />
  );
}
