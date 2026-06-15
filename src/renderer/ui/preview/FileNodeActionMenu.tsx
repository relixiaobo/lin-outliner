import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { FolderIcon, ICON_SIZE, MoreIcon, ShowIcon } from '../icons';
import { MenuItem } from '../primitives/MenuItem';
import { MenuSurface } from '../primitives/MenuSurface';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import type { FileNode } from './fileNode';

interface FileNodeActionMenuProps {
  node: FileNode;
  /** The primary "open" action — "Maximize" for an image, "Open in split" otherwise. */
  primaryLabel: string;
  onPrimary: () => void;
}

/**
 * The `⋯` action menu shared by both file-node row presentations (the icon card and
 * the inline image): a primary open action (Maximize for an image, Open in split for
 * other files) and Reveal in Finder. The trigger is an icon-only chrome control;
 * its `aria-expanded` lets the owning row keep the menu visible while open (CSS
 * `:has`).
 */
export function FileNodeActionMenu({ node, primaryLabel, onPrimary }: FileNodeActionMenuProps) {
  const ta = useT().outliner.field.attachment;
  const assetId = node.assetId;
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={ta.menuLabel}
        className="file-node-card-menu-trigger"
        // Don't let the trigger steal focus or select / open the row.
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        ref={anchorRef}
        type="button"
      >
        <MoreIcon size={ICON_SIZE.menu} />
      </button>
      {open ? (
        <FloatingActionMenu
          anchorRef={anchorRef}
          ariaLabel={ta.menuLabel}
          onClose={() => setOpen(false)}
          onPrimary={onPrimary}
          onReveal={assetId ? () => void api.revealAsset(assetId) : undefined}
          primaryLabel={primaryLabel}
          revealLabel={ta.reveal}
        />
      ) : null}
    </>
  );
}

function FloatingActionMenu({
  anchorRef,
  ariaLabel,
  onClose,
  onPrimary,
  onReveal,
  primaryLabel,
  revealLabel,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  ariaLabel: string;
  onClose: () => void;
  onPrimary: () => void;
  onReveal?: () => void;
  primaryLabel: string;
  revealLabel: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const style = useAnchoredOverlay(menuRef, {
    anchorRef,
    maxHeight: 240,
    placement: 'bottom-end',
    width: 200,
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
    <MenuSurface aria-label={ariaLabel} className="node-context-menu" ref={menuRef} role="menu" style={style}>
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
      {onReveal ? (
        <MenuItem
          className="node-context-item"
          icon={<FolderIcon size={ICON_SIZE.menu} />}
          label={revealLabel}
          onClick={() => {
            onClose();
            onReveal();
          }}
          role="menuitem"
        />
      ) : null}
    </MenuSurface>,
    document.body,
  );
}
