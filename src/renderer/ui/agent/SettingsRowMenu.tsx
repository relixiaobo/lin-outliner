import { useEffect, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ICON_SIZE, MoreIcon } from '../icons';
import { MenuItem } from '../primitives/MenuItem';
import { MenuSurface } from '../primitives/MenuSurface';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';

export interface RowMenuAction {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

// A trailing `⋯` actions menu for an inset-list row. The trigger is an icon-only
// chrome control (B6: colour-only hover, no box) and the floating menu reuses the
// shared popover glass (D2: --material-popover + --material-backdrop carry the
// reduced-transparency opaque fallback for free). The open row is owned by the
// parent so only one menu is open at a time.
export function SettingsRowMenu({
  ariaLabel,
  actions,
  open,
  onOpenChange,
}: {
  ariaLabel: string;
  actions: RowMenuAction[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={ariaLabel}
        className="settings-row-menu-trigger"
        onClick={(event) => {
          // The trigger is a sibling of the row's selectable area, but stop the
          // click anyway so opening the menu never doubles as a row selection.
          event.stopPropagation();
          onOpenChange(!open);
        }}
        ref={anchorRef}
        type="button"
      >
        <MoreIcon size={ICON_SIZE.menu} />
      </button>
      {open ? (
        <FloatingRowMenu
          actions={actions}
          anchorRef={anchorRef}
          onClose={() => onOpenChange(false)}
        />
      ) : null}
    </>
  );
}

function FloatingRowMenu({
  actions,
  anchorRef,
  onClose,
}: {
  actions: RowMenuAction[];
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const style = useAnchoredOverlay(menuRef, {
    anchorRef,
    layoutKey: String(actions.length),
    maxHeight: 320,
    placement: 'bottom-end',
    width: 208,
  });

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [anchorRef, onClose]);

  return createPortal(
    <MenuSurface
      aria-label="Provider actions"
      className="settings-row-menu"
      ref={menuRef}
      role="menu"
      style={style}
    >
      {actions.map((action) => (
        <MenuItem
          className={['settings-row-menu-item', action.danger ? 'is-danger' : ''].filter(Boolean).join(' ')}
          disabled={action.disabled}
          key={action.label}
          label={action.label}
          labelClassName="settings-row-menu-item-label"
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
