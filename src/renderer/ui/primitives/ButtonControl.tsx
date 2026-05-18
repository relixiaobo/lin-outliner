import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface ButtonControlProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode;
}

export function ButtonControl({
  children,
  type = 'button',
  ...buttonProps
}: ButtonControlProps) {
  return (
    <button
      {...buttonProps}
      type={type}
    >
      {children}
    </button>
  );
}
