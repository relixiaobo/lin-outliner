import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from './cx';

interface MenuItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  active?: boolean;
  activeClassName?: string;
  icon?: ReactNode;
  iconClassName?: string;
  label: ReactNode;
  labelClassName?: string;
  meta?: ReactNode;
  metaClassName?: string;
}

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem({
  active = false,
  activeClassName = 'active',
  className,
  icon,
  iconClassName,
  label,
  labelClassName,
  meta,
  metaClassName,
  type = 'button',
  ...buttonProps
}, ref) {
  const classes = cx(
    className,
    active && activeClassName,
  );

  return (
    <button {...buttonProps} className={classes} ref={ref} type={type}>
      {iconClassName ? <span className={iconClassName}>{icon}</span> : icon}
      {labelClassName ? <span className={labelClassName}>{label}</span> : label}
      {meta ? (metaClassName ? <span className={metaClassName}>{meta}</span> : meta) : null}
    </button>
  );
});
