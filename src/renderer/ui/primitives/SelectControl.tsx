import type { ReactNode, SelectHTMLAttributes } from 'react';

interface SelectControlProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'aria-label' | 'children'> {
  children: ReactNode;
  label: string;
}

export function SelectControl({
  children,
  label,
  ...selectProps
}: SelectControlProps) {
  return (
    <select
      {...selectProps}
      aria-label={label}
    >
      {children}
    </select>
  );
}
