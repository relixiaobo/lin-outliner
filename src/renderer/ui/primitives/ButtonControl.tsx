import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

interface ButtonControlProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode;
}

export const ButtonControl = forwardRef<HTMLButtonElement, ButtonControlProps>(function ButtonControl({
  children,
  type = 'button',
  ...buttonProps
}, ref) {
  return (
    <button
      ref={ref}
      {...buttonProps}
      type={type}
    >
      {children}
    </button>
  );
});
