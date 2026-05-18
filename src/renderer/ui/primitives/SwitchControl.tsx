import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

interface SwitchControlProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-checked' | 'aria-label' | 'children' | 'onChange' | 'role'> {
  checked: boolean;
  children: ReactNode;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}

export const SwitchControl = forwardRef<HTMLButtonElement, SwitchControlProps>(function SwitchControl({
  checked,
  children,
  label,
  onCheckedChange,
  onClick,
  type = 'button',
  ...buttonProps
}, ref) {
  return (
    <button
      ref={ref}
      {...buttonProps}
      aria-checked={checked}
      aria-label={label}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onCheckedChange(!checked);
      }}
      role="switch"
      type={type}
    >
      {children}
    </button>
  );
});
