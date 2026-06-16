import { useEffect, useRef, type HTMLAttributes, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './cx';
import { MenuItem } from './MenuItem';
import { MenuSurface } from './MenuSurface';
import { useAnchoredOverlay } from './useAnchoredOverlay';
import { useMenuKeyboard } from './useMenuKeyboard';

export interface AnchoredMenuAction {
  id?: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

interface AnchoredActionMenuProps {
  actions: AnchoredMenuAction[];
  // The trigger the menu anchors to and restores focus to on close.
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  ariaLabel: string;
  className: string;
  itemClassName?: string;
  itemLabelClassName?: string;
  width?: number;
  // Extra attributes for the surface (e.g. a `data-` hook a parent's
  // outside-pointer handler tests against). Explicit props below always win.
  surfaceProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string>;
}

// A trailing `⋯`-style anchored actions menu. Owns the shared overlay behavior so
// call sites are a one-liner: anchored positioning + `useMenuKeyboard` (focus-in,
// roving Arrow/Home/End, Escape, focus-restore to the trigger) + outside-pointer
// dismissal that ignores the trigger (so clicking it toggles rather than
// close-then-reopens). The trigger button itself lives at the call site.
export function AnchoredActionMenu({
  actions,
  anchorRef,
  onClose,
  ariaLabel,
  className,
  itemClassName,
  itemLabelClassName,
  width = 208,
  surfaceProps,
}: AnchoredActionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const style = useAnchoredOverlay(menuRef, {
    anchorRef,
    layoutKey: actions.map((action) => action.label).join('|'),
    maxHeight: 320,
    placement: 'bottom-end',
    width,
  });
  const { onKeyDown } = useMenuKeyboard({
    surfaceRef: menuRef,
    onClose,
    kind: 'menu',
    getRestoreTarget: () => (anchorRef.current instanceof HTMLElement ? anchorRef.current : null),
  });

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    }
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [anchorRef, onClose]);

  return createPortal(
    <MenuSurface
      {...surfaceProps}
      aria-label={ariaLabel}
      className={className}
      onKeyDown={onKeyDown}
      ref={menuRef}
      role="menu"
      style={style}
    >
      {actions.map((action) => (
        <MenuItem
          className={cx(itemClassName, action.danger && 'is-danger')}
          disabled={action.disabled}
          key={action.id ?? action.label}
          label={action.label}
          labelClassName={itemLabelClassName}
          onClick={() => {
            onClose();
            action.onSelect();
          }}
          role="menuitem"
        />
      ))}
    </MenuSurface>,
    document.body,
  );
}
