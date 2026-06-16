import { useRef, useState, type ComponentType, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/I18nProvider';
import { ICON_SIZE, MoreIcon, OpenIcon } from '../icons';
import { MenuItem } from '../primitives/MenuItem';
import { MenuSurface } from '../primitives/MenuSurface';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { useDismissibleOverlay } from '../primitives/useDismissibleOverlay';
import { useMenuKeyboard } from '../primitives/useMenuKeyboard';

export interface FilePreviewMenuAction {
  key: string;
  label: string;
  icon: ComponentType<{ size?: number }>;
  run: () => void;
}

interface FilePreviewPillProps {
  /** A real content renderer matched (not the metadata fallback). */
  previewable: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  /** Open with the OS default app (asset / local file / url). Null when not openable. */
  primaryOpen?: { label: string; run: () => void } | null;
  /** Secondary actions for the `⋯` menu (reveal in Finder, copy, add to outline). */
  menuActions?: FilePreviewMenuAction[];
  /** A quiet caption (type · size · pages) shown as the `⋯` menu header. */
  meta?: string | null;
}

/**
 * The single bottom-center floating control over a file preview: a primary button
 * plus a `⋯` menu, replacing the old top meta+actions toolbar. A previewable source's
 * primary toggles Expand/Collapse (the preview's peek vs full-scroll height) and
 * Open-with-default-app moves into the menu; a non-previewable source makes
 * Open-with-default-app the primary. Reuses the shared anchored-overlay menu stack.
 */
export function FilePreviewPill({
  previewable,
  expanded,
  onToggleExpand,
  primaryOpen = null,
  menuActions = [],
  meta = null,
}: FilePreviewPillProps) {
  const labels = useT().shell.filePreview;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const allMenuActions: FilePreviewMenuAction[] = previewable && primaryOpen
    ? [{ key: 'open', label: primaryOpen.label, icon: OpenIcon, run: primaryOpen.run }, ...menuActions]
    : menuActions;

  const hasPrimary = previewable || Boolean(primaryOpen);
  if (!hasPrimary && allMenuActions.length === 0) return null;

  const primaryLabel = previewable ? (expanded ? labels.collapse : labels.expand) : primaryOpen?.label ?? '';
  const onPrimary = previewable ? onToggleExpand : primaryOpen?.run ?? (() => undefined);

  // Float over content inside an outliner row, so swallow the pointer: it must not
  // steal edit focus or move the row selection, and the trigger keeps its own
  // mousedown off the document so the dismiss listener does not fire on the toggle.
  const swallowPointer = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="file-preview-pill" data-preserve-selection onMouseDown={(event) => event.stopPropagation()}>
      {hasPrimary ? (
        <button
          type="button"
          className="file-preview-pill-primary"
          onMouseDown={swallowPointer}
          onClick={(event) => {
            event.stopPropagation();
            onPrimary();
          }}
        >
          {primaryLabel}
        </button>
      ) : null}
      {allMenuActions.length > 0 ? (
        <>
          {hasPrimary ? <span className="file-preview-pill-divider" aria-hidden="true" /> : null}
          <button
            ref={triggerRef}
            type="button"
            className="file-preview-pill-more"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={labels.actions}
            onMouseDown={swallowPointer}
            onClick={(event) => {
              event.stopPropagation();
              setOpen((value) => !value);
            }}
          >
            <MoreIcon size={ICON_SIZE.menu} />
          </button>
          {open ? (
            <PillMenu
              actions={allMenuActions}
              anchorRef={triggerRef}
              ariaLabel={labels.actions}
              meta={meta}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function PillMenu({
  actions,
  anchorRef,
  ariaLabel,
  meta,
  onClose,
}: {
  actions: FilePreviewMenuAction[];
  anchorRef: RefObject<HTMLElement | null>;
  ariaLabel: string;
  meta: string | null;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const style = useAnchoredOverlay(menuRef, {
    anchorRef,
    maxHeight: 280,
    placement: 'top-end',
    width: 220,
  });
  // Outside-pointer dismissal; Escape + roving Arrow/Home/End + focus-in/restore come
  // from useMenuKeyboard (escape:false here so the two do not both handle Escape).
  useDismissibleOverlay(menuRef, onClose, { escape: false });
  const { onKeyDown } = useMenuKeyboard({
    surfaceRef: menuRef,
    onClose,
    kind: 'menu',
    getRestoreTarget: () => (anchorRef.current instanceof HTMLElement ? anchorRef.current : null),
  });

  return createPortal(
    <MenuSurface
      aria-label={ariaLabel}
      className="node-context-menu"
      preserveSelection
      onKeyDown={onKeyDown}
      onMouseDown={(event) => event.stopPropagation()}
      ref={menuRef}
      role="menu"
      style={style}
    >
      {meta ? <div className="file-preview-menu-meta" aria-hidden="true">{meta}</div> : null}
      {actions.map((action) => {
        const Icon = action.icon;
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
