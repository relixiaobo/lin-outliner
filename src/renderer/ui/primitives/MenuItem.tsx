import type { ButtonHTMLAttributes, ReactNode } from 'react';

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

export function MenuItem({
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
}: MenuItemProps) {
  const classes = [
    className,
    active ? activeClassName : '',
  ].filter(Boolean).join(' ');

  return (
    <button {...buttonProps} className={classes} type={type}>
      {iconClassName ? <span className={iconClassName}>{icon}</span> : icon}
      {labelClassName ? <span className={labelClassName}>{label}</span> : label}
      {meta ? (metaClassName ? <span className={metaClassName}>{meta}</span> : meta) : null}
    </button>
  );
}
