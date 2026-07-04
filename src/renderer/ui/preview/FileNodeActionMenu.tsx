import { useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/I18nProvider';
import { CopyIcon, FolderIcon, ICON_SIZE, MoreIcon, OpenIcon, ShowIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { MenuItem } from '../primitives/MenuItem';
import { MenuSurface } from '../primitives/MenuSurface';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { useDismissibleOverlay } from '../primitives/useDismissibleOverlay';
import type { FileNode } from './fileNode';
import {
  fileNodeAssetActions,
  type FileNodeAssetAction,
  type FileNodeAssetActionKey,
} from './fileNodeActions';

const ASSET_ACTION_ICON: Record<FileNodeAssetActionKey, typeof OpenIcon> = {
  open: OpenIcon,
  reveal: FolderIcon,
  copy: CopyIcon,
};

interface FileNodeActionMenuProps {
  node: FileNode;
  /** The primary "open" action — "Maximize" for an image, "Open in split" otherwise. */
  primaryLabel: string;
  onPrimary: () => void;
}

/**
 * The `⋯` action menu shared by both file-node row presentations (the icon card and
 * the inline image): a type-specific primary action (Maximize for an image, Open in
 * split for other files), then the stored asset's Open / Reveal in Finder / Copy file
 * actions (the shared `fileNodeAssetActions` descriptor, also used by the preview
 * hero). The trigger is an icon-only chrome control; its `aria-expanded` lets the
 * owning row keep the menu visible while open (CSS `:has`).
 */
export function FileNodeActionMenu({ node, primaryLabel, onPrimary }: FileNodeActionMenuProps) {
  const ta = useT().outliner.field.attachment;
  const assetId = node.assetId;
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const dismissIgnoreRefs = useMemo(() => [anchorRef], []);

  return (
    <>
      <ButtonControl
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={ta.menuLabel}
        className="file-node-card-menu-trigger"
        // Don't let the trigger steal focus or select / open the row, and keep the
        // mousedown off the document so the dismiss listener doesn't fire on the same
        // click that toggles the menu.
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        ref={anchorRef}
      >
        <MoreIcon size={ICON_SIZE.menu} />
      </ButtonControl>
      {open ? (
        <FloatingActionMenu
          anchorRef={anchorRef}
          ariaLabel={ta.menuLabel}
          assetActions={assetId ? fileNodeAssetActions(assetId, ta) : []}
          dismissIgnoreRefs={dismissIgnoreRefs}
          onClose={() => setOpen(false)}
          onPrimary={onPrimary}
          primaryLabel={primaryLabel}
        />
      ) : null}
    </>
  );
}

function FloatingActionMenu({
  anchorRef,
  ariaLabel,
  assetActions,
  dismissIgnoreRefs,
  onClose,
  onPrimary,
  primaryLabel,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  ariaLabel: string;
  assetActions: FileNodeAssetAction[];
  dismissIgnoreRefs: Array<RefObject<HTMLElement | null>>;
  onClose: () => void;
  onPrimary: () => void;
  primaryLabel: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const style = useAnchoredOverlay(menuRef, {
    anchorRef,
    maxHeight: 240,
    placement: 'bottom-end',
    width: 200,
  });
  // Capture-phase outside-pointer + Escape dismissal. The trigger is ignored so a
  // repeat click toggles this menu instead of closing and immediately reopening it.
  useDismissibleOverlay(menuRef, onClose, { ignoreRefs: dismissIgnoreRefs });

  return createPortal(
    <MenuSurface
      aria-label={ariaLabel}
      className="node-context-menu"
      // The menu is portaled to <body>; without this the document pointerdown handler
      // would clear the active row selection when the menu (or an item) is clicked.
      preserveSelection
      onMouseDown={(event) => event.stopPropagation()}
      ref={menuRef}
      role="menu"
      style={style}
    >
      <MenuItem
        className="node-context-item"
        icon={<ShowIcon size={ICON_SIZE.menu} />}
        label={primaryLabel}
        onClick={() => {
          onClose();
          onPrimary();
        }}
        role="menuitem"
      />
      {assetActions.map((action) => {
        const Icon = ASSET_ACTION_ICON[action.key];
        return (
          <MenuItem
            key={action.key}
            className="node-context-item"
            icon={<Icon size={ICON_SIZE.menu} />}
            label={action.label}
            onClick={() => {
              onClose();
              action.run();
            }}
            role="menuitem"
          />
        );
      })}
    </MenuSurface>,
    document.body,
  );
}
