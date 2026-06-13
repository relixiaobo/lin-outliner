import type { ButtonHTMLAttributes } from 'react';
import { ICON_SIZE, type AppIcon } from '../icons';
import { cx } from './cx';

type IconButtonVariant =
  | 'chrome'
  | 'panel'
  | 'toolbar'
  | 'message'
  | 'composerTool'
  | 'composerAction'
  | 'tabClose';

const DEFAULT_ICON_SIZE: Record<IconButtonVariant, number> = {
  chrome: ICON_SIZE.toolbar,
  panel: ICON_SIZE.menu,
  toolbar: ICON_SIZE.menu,
  message: ICON_SIZE.menu,
  composerTool: ICON_SIZE.toolbar,
  composerAction: ICON_SIZE.toolbar,
  tabClose: ICON_SIZE.tiny,
};

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  icon: AppIcon;
  iconSize?: number;
  label: string;
  strokeWidth?: number;
  variant?: IconButtonVariant;
}

export function IconButton({
  className,
  icon: Icon,
  iconSize,
  label,
  strokeWidth,
  title,
  type = 'button',
  variant = 'chrome',
  ...buttonProps
}: IconButtonProps) {
  const classes = cx('icon-button', `icon-button-${variant}`, className);

  return (
    <button
      {...buttonProps}
      aria-label={label}
      className={classes}
      title={title ?? label}
      type={type}
    >
      <Icon size={iconSize ?? DEFAULT_ICON_SIZE[variant]} strokeWidth={strokeWidth} />
    </button>
  );
}
