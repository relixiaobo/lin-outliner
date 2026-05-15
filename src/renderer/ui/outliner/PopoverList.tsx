import { forwardRef, type ButtonHTMLAttributes, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { MenuItem } from '../primitives/MenuItem';
import { MenuSurface } from '../primitives/MenuSurface';

interface PopoverListboxProps {
  children: ReactNode;
  className: string;
  label?: string;
  preventMouseDown?: boolean;
  role?: 'listbox' | 'menu';
  style?: CSSProperties;
  onMouseDown?: (event: MouseEvent<HTMLDivElement>) => void;
}

export const PopoverListbox = forwardRef<HTMLDivElement, PopoverListboxProps>(function PopoverListbox(
  {
    children,
    className,
    label,
    onMouseDown,
    preventMouseDown = true,
    role = 'listbox',
    style,
  },
  ref,
) {
  return (
    <MenuSurface
      ref={ref}
      aria-label={label}
      className={className}
      onMouseDown={(event) => {
        if (preventMouseDown) event.preventDefault();
        onMouseDown?.(event);
      }}
      role={role}
      style={style}
    >
      {children}
    </MenuSurface>
  );
});

interface PopoverListItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className' | 'disabled'> {
  active: boolean;
  className?: string;
  disabled?: boolean;
  icon: ReactNode;
  iconClassName?: string;
  label: ReactNode;
  labelClassName?: string;
}

export function PopoverListItem({
  active,
  className = 'popover-item',
  disabled = false,
  icon,
  iconClassName,
  label,
  labelClassName = 'popover-item-label',
  onMouseDown,
  role = 'option',
  ...buttonProps
}: PopoverListItemProps) {
  const classes = [
    className,
    disabled ? 'disabled' : '',
  ].filter(Boolean).join(' ');
  return (
    <MenuItem
      {...buttonProps}
      active={active}
      aria-disabled={buttonProps['aria-disabled'] ?? (disabled ? true : undefined)}
      aria-selected={role === 'option' ? buttonProps['aria-selected'] ?? active : buttonProps['aria-selected']}
      className={classes}
      data-selected={active ? 'true' : undefined}
      icon={icon}
      iconClassName={iconClassName}
      label={label}
      labelClassName={labelClassName}
      onMouseDown={(event) => {
        event.preventDefault();
        onMouseDown?.(event);
      }}
      role={role}
    />
  );
}

export function PopoverEmpty({ children }: { children: ReactNode }) {
  return <div className="popover-empty">{children}</div>;
}

export function PopoverBulletIcon() {
  return <span className="command-item-bullet" />;
}
