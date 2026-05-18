import { forwardRef, type ReactNode, type SelectHTMLAttributes } from 'react';

interface SelectControlProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'aria-label' | 'children'> {
  children: ReactNode;
  label: string;
}

export const SelectControl = forwardRef<HTMLSelectElement, SelectControlProps>(function SelectControl({
  children,
  label,
  ...selectProps
}, ref) {
  return (
    <select
      ref={ref}
      {...selectProps}
      aria-label={label}
    >
      {children}
    </select>
  );
});
