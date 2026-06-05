import { forwardRef, type ReactNode, type SelectHTMLAttributes } from 'react';
import { ChevronDownIcon, ICON_SIZE } from '../icons';

interface SelectControlProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'aria-label' | 'children'> {
  children: ReactNode;
  label: string;
  /**
   * 'popup' renders a design-system pop-up button — the native chrome is stripped
   * (appearance: none) and replaced with compact text chrome + overlaid chevron
   * for settings inset rows. Its neutral fill appears only on interaction. 'plain'
   * (default) is a bare <select> for callers that style it in their own context
   * (e.g. the view toolbar). The native option list still opens on click (B10).
   */
  variant?: 'plain' | 'popup';
}

export const SelectControl = forwardRef<HTMLSelectElement, SelectControlProps>(function SelectControl({
  children,
  label,
  variant = 'plain',
  className,
  ...selectProps
}, ref) {
  if (variant !== 'popup') {
    return (
      <select ref={ref} {...selectProps} aria-label={label} className={className}>
        {children}
      </select>
    );
  }
  return (
    <span className={`select-popup${className ? ` ${className}` : ''}`}>
      <select ref={ref} {...selectProps} aria-label={label} className="select-popup-input">
        {children}
      </select>
      <ChevronDownIcon className="select-popup-chevron" size={ICON_SIZE.rowGlyph} aria-hidden />
    </span>
  );
});
