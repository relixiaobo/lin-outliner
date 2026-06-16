import { useRef } from 'react';
import { ICON_SIZE, MoreIcon } from '../icons';
import { useT } from '../../i18n/I18nProvider';
import { AnchoredActionMenu, type AnchoredMenuAction } from '../primitives/AnchoredActionMenu';

export type RowMenuAction = AnchoredMenuAction;

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
  const t = useT();
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
        <AnchoredActionMenu
          actions={actions}
          anchorRef={anchorRef}
          ariaLabel={t.settings.providers.rowMenuAriaLabel}
          className="settings-row-menu"
          itemClassName="settings-row-menu-item"
          itemLabelClassName="settings-row-menu-item-label"
          onClose={() => onOpenChange(false)}
          width={208}
        />
      ) : null}
    </>
  );
}
