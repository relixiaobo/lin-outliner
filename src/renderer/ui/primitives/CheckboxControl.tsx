import type { InputHTMLAttributes, ReactNode } from 'react';
import { CheckboxMark } from './CheckboxMark';

interface CheckboxControlProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'checked' | 'children' | 'onChange' | 'type'> {
  checked: boolean;
  children: ReactNode;
  onCheckedChange: (checked: boolean) => void;
}

export function CheckboxControl({
  checked,
  children,
  className,
  onCheckedChange,
  ...inputProps
}: CheckboxControlProps) {
  return (
    <label className={className}>
      <input
        {...inputProps}
        checked={checked}
        onChange={(event) => onCheckedChange(event.target.checked)}
        type="checkbox"
      />
      <CheckboxMark checked={checked} />
      {children}
    </label>
  );
}
