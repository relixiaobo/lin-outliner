import type { ButtonHTMLAttributes } from 'react';

interface ResizeHandleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  label: string;
}

export function ResizeHandle({
  className,
  label,
  title,
  type = 'button',
  ...buttonProps
}: ResizeHandleProps) {
  return (
    <button
      {...buttonProps}
      aria-label={label}
      className={className}
      title={title ?? label}
      type={type}
    />
  );
}
