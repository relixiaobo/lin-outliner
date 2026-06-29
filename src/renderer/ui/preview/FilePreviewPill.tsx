import { useMemo, useRef, useState, type ComponentType, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/I18nProvider';
import { ICON_SIZE, MoreIcon, OpenIcon } from '../icons';
import { MenuItem } from '../primitives/MenuItem';
import { MenuSurface } from '../primitives/MenuSurface';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { useDismissibleOverlay } from '../primitives/useDismissibleOverlay';
import { useMenuKeyboard, type MenuInitialFocus } from '../primitives/useMenuKeyboard';

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
  /** Audio/video previews are already final controls, so they omit the Expand primary. */
  primaryMode?: 'toggle' | 'open' | 'none';
  /** Open with the OS default app (asset / local file / url). Null when not openable. */
  primaryOpen?: { label: string; run: () => void } | null;
  /** Secondary actions for the `⋯` menu (reveal in Finder, copy, add to outline). */
  menuActions?: FilePreviewMenuAction[];
  /** A quiet caption (type · size · pages) shown as the `⋯` menu header. */
  meta?: string | null;
  /** Overlay preview content by default; footer keeps metadata cards in normal flow. */
  placement?: 'overlay' | 'footer' | 'media' | 'media-control';
}

/**
 * The single bottom-center floating control over a file preview: a primary button
 * plus a separate `⋯` menu button, replacing the old top meta+actions toolbar. A previewable source's
 * primary toggles Expand/Collapse (the preview's peek vs full-scroll height) and
 * Open-with-default-app moves into the menu. A non-previewable metadata card uses
 * the same position and menu stack; only its primary action changes to Open with
 * default app, so every non-image file keeps one learned action location.
 */
export function FilePreviewPill({
  previewable,
  expanded,
  onToggleExpand,
  primaryMode = previewable ? 'toggle' : 'open',
  primaryOpen = null,
  menuActions = [],
  meta = null,
  placement = 'overlay',
}: FilePreviewPillProps) {
  const labels = useT().shell.filePreview;
  const [open, setOpen] = useState(false);
  const [menuInitialFocus, setMenuInitialFocus] = useState<MenuInitialFocus>('surface');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dismissIgnoreRefs = useMemo(() => [triggerRef], []);

  const allMenuActions: FilePreviewMenuAction[] = previewable && primaryOpen
    ? [{ key: 'open', label: primaryOpen.label, icon: OpenIcon, run: primaryOpen.run }, ...menuActions]
    : menuActions;

  const hasPrimary = primaryMode !== 'none' && (primaryMode === 'toggle' || Boolean(primaryOpen));
  if (!hasPrimary && allMenuActions.length === 0) return null;

  const primaryLabel = primaryMode === 'toggle' ? (expanded ? labels.collapse : labels.expand) : labels.open;
  const primaryTitle = primaryMode === 'toggle' ? primaryLabel : primaryOpen?.label ?? labels.open;
  const onPrimary = primaryMode === 'toggle' ? onToggleExpand : primaryOpen?.run ?? (() => undefined);

  // Float over content inside an outliner row, so swallow the pointer: it must not
  // steal edit focus or move the row selection, and the trigger keeps its own
  // mousedown off the document so the dismiss listener does not fire on the toggle.
  const swallowPointer = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      className={[
        'file-preview-pill',
        placement === 'footer' ? 'file-preview-pill--footer' : '',
        placement === 'media' ? 'file-preview-pill--media' : '',
        placement === 'media-control' ? 'file-preview-pill--media-control' : '',
      ].filter(Boolean).join(' ')}
      data-preserve-selection
      onMouseDown={(event) => event.stopPropagation()}
    >
      {hasPrimary ? (
        <button
          type="button"
          className="file-preview-pill-primary"
          title={primaryTitle}
          aria-label={primaryTitle}
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
          <button
            ref={triggerRef}
            type="button"
            className="file-preview-pill-more"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={labels.actions}
            onMouseDown={swallowPointer}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
              event.preventDefault();
              event.stopPropagation();
              setMenuInitialFocus('auto');
              setOpen(true);
            }}
            onClick={(event) => {
              event.stopPropagation();
              const nextOpen = !open;
              if (nextOpen) {
                setMenuInitialFocus(event.nativeEvent.detail === 0 ? 'auto' : 'surface');
              }
              setOpen(nextOpen);
            }}
          >
            <MoreIcon size={ICON_SIZE.menu} />
          </button>
          {open ? (
            <PillMenu
              actions={allMenuActions}
              anchorRef={triggerRef}
              ariaLabel={labels.actions}
              dismissIgnoreRefs={dismissIgnoreRefs}
              initialFocus={menuInitialFocus}
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
  dismissIgnoreRefs,
  initialFocus,
  meta,
  onClose,
}: {
  actions: FilePreviewMenuAction[];
  anchorRef: RefObject<HTMLElement | null>;
  ariaLabel: string;
  dismissIgnoreRefs: Array<RefObject<HTMLElement | null>>;
  initialFocus: MenuInitialFocus;
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
  useDismissibleOverlay(menuRef, onClose, { escape: false, ignoreRefs: dismissIgnoreRefs });
  const { onKeyDown } = useMenuKeyboard({
    surfaceRef: menuRef,
    onClose,
    kind: 'menu',
    getRestoreTarget: () => (anchorRef.current instanceof HTMLElement ? anchorRef.current : null),
    initialFocus,
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
