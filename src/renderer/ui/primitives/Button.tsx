import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';
export type ButtonTone = 'subtle' | 'solid';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode;
  size?: ButtonSize;
  tone?: ButtonTone;
  variant?: ButtonVariant;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  children,
  className,
  size = 'md',
  tone = 'subtle',
  type = 'button',
  variant = 'secondary',
  ...buttonProps
}, ref) {
  const classes = cx(
    'button',
    `button-${variant}`,
    `button-${size}`,
    tone === 'solid' && 'button-solid',
    className,
  );

  return (
    <button
      ref={ref}
      {...buttonProps}
      className={classes}
      type={type}
    >
      {children}
    </button>
  );
});
