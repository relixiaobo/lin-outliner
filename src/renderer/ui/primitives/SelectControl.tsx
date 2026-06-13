import { forwardRef, type ReactNode, type SelectHTMLAttributes } from 'react';
import { ChevronDownIcon, ICON_SIZE } from '../icons';
import type { InputSize } from './Input';
import { cx } from './cx';

interface SelectControlProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'aria-label' | 'children' | 'size'> {
  children: ReactNode;
  label: string;
  size?: InputSize;
  /**
   * 'popup' renders a design-system pop-up button — the native chrome is stripped
   * (appearance: none) and replaced with compact text chrome + overlaid chevron
   * for settings inset rows. Its neutral fill appears only on interaction. 'plain'
   * (default) is a bare <select> for callers that style it in their own context
   * (e.g. the view toolbar). 'boxed'/'bare' use the shared input primitive skin.
   * The native option list still opens on click (B10).
   */
  variant?: 'plain' | 'popup' | 'boxed' | 'bare';
}

export const SelectControl = forwardRef<HTMLSelectElement, SelectControlProps>(function SelectControl({
  children,
  label,
  size = 'md',
  variant = 'plain',
  className,
  ...selectProps
}, ref) {
  if (variant === 'plain') {
    return (
      <select ref={ref} {...selectProps} aria-label={label} className={className}>
        {children}
      </select>
    );
  }
  if (variant === 'boxed' || variant === 'bare') {
    const shellClasses = cx(
      'input-select-shell',
      `input-select-shell-${variant}`,
      className,
    );
    const classes = cx(
      'input-control',
      'input-select',
      `input-${variant}`,
      `input-${size}`,
    );
    return (
      <span className={shellClasses}>
        <select ref={ref} {...selectProps} aria-label={label} className={classes}>
          {children}
        </select>
        <ChevronDownIcon className="input-select-chevron" size={ICON_SIZE.rowGlyph} aria-hidden />
      </span>
    );
  }
  return (
    <span className={cx('select-popup', className)}>
      <select ref={ref} {...selectProps} aria-label={label} className="select-popup-input">
        {children}
      </select>
      <ChevronDownIcon className="select-popup-chevron" size={ICON_SIZE.rowGlyph} aria-hidden />
    </span>
  );
});
