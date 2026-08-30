import { useMemo, useRef, useState, type ComponentType, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/I18nProvider';
import { ICON_SIZE, MoreIcon, OpenIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
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
  /** Direct image and audio/video previews omit the document Expand primary. */
  primaryMode?: 'toggle' | 'open' | 'none';
  /** Open with the OS default app (asset / local file / url). Null when not openable. */
  primaryOpen?: { label: string; run: () => void } | null;
  /** Secondary actions for the `⋯` menu (reveal in Finder, copy, add to outline). */
  menuActions?: FilePreviewMenuAction[];
  /** A quiet caption (type · size · pages) shown as the `⋯` menu header. */
  meta?: string | null;
  /** Overlay documents by default; other placements select their owning surface. */
  placement?: 'overlay' | 'footer' | 'image' | 'media-control' | 'source-corner';
}

/** Shared preview action control, placed by the surface that owns the action. */
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
  const menuBoundaryRef = useRef<HTMLElement | null>(null);
  const menuFallbackBoundaryRef = useRef<HTMLElement | null>(null);
  const dismissIgnoreRefs = useMemo(() => [triggerRef], []);

  const allMenuActions: FilePreviewMenuAction[] = previewable && primaryOpen
    ? [{ key: 'open', label: primaryOpen.label, icon: OpenIcon, run: primaryOpen.run }, ...menuActions]
    : menuActions;

  const hasPrimary = primaryMode !== 'none' && (primaryMode === 'toggle' || Boolean(primaryOpen));
  if (!hasPrimary && allMenuActions.length === 0) return null;

  const primaryLabel = primaryMode === 'toggle' ? (expanded ? labels.collapse : labels.expand) : labels.open;
  const primaryTitle = primaryMode === 'toggle' ? primaryLabel : primaryOpen?.label ?? labels.open;
  const onPrimary = primaryMode === 'toggle' ? onToggleExpand : primaryOpen?.run ?? (() => undefined);
  const prepareMenuBoundary = () => {
    const trigger = triggerRef.current;
    menuBoundaryRef.current = placement === 'source-corner'
      ? trigger?.closest('.file-node-body')
        ?.querySelector<HTMLElement>(':scope > .file-node-preview') ?? null
      : null;
    menuFallbackBoundaryRef.current = placement === 'source-corner'
      ? trigger?.closest<HTMLElement>('.outline-panel-surface') ?? null
      : null;
  };

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
        placement === 'image' ? 'file-preview-pill--image' : '',
        placement === 'media-control' ? 'file-preview-pill--media-control' : '',
        placement === 'source-corner' ? 'file-preview-pill--source-corner' : '',
      ].filter(Boolean).join(' ')}
      data-preserve-selection
      onMouseDown={(event) => event.stopPropagation()}
    >
      {hasPrimary ? (
        <ButtonControl
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
        </ButtonControl>
      ) : null}
      {allMenuActions.length > 0 ? (
        <>
          <ButtonControl
            ref={triggerRef}
            className="file-preview-pill-more"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={labels.actions}
            onMouseDown={swallowPointer}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
              event.preventDefault();
              event.stopPropagation();
              prepareMenuBoundary();
              setMenuInitialFocus('auto');
              setOpen(true);
            }}
            onClick={(event) => {
              event.stopPropagation();
              const nextOpen = !open;
              if (nextOpen) {
                prepareMenuBoundary();
                setMenuInitialFocus(event.nativeEvent.detail === 0 ? 'auto' : 'surface');
              }
              setOpen(nextOpen);
            }}
          >
            <MoreIcon size={ICON_SIZE.menu} />
          </ButtonControl>
          {open ? (
            <PillMenu
              actions={allMenuActions}
              anchorRef={triggerRef}
              ariaLabel={labels.actions}
              boundaryRef={placement === 'source-corner' ? menuBoundaryRef : undefined}
              dismissIgnoreRefs={dismissIgnoreRefs}
              initialFocus={menuInitialFocus}
              fallbackBoundaryRef={placement === 'source-corner' ? menuFallbackBoundaryRef : undefined}
              meta={meta}
              onClose={() => setOpen(false)}
              placement={placement === 'source-corner' ? 'bottom-end' : 'top-end'}
              sourceContained={placement === 'source-corner'}
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
  boundaryRef,
  dismissIgnoreRefs,
  fallbackBoundaryRef,
  initialFocus,
  meta,
  onClose,
  placement,
  sourceContained,
}: {
  actions: FilePreviewMenuAction[];
  anchorRef: RefObject<HTMLElement | null>;
  ariaLabel: string;
  boundaryRef?: RefObject<HTMLElement | null>;
  dismissIgnoreRefs: Array<RefObject<HTMLElement | null>>;
  fallbackBoundaryRef?: RefObject<HTMLElement | null>;
  initialFocus: MenuInitialFocus;
  meta: string | null;
  onClose: () => void;
  placement: 'bottom-end' | 'top-end';
  sourceContained: boolean;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const style = useAnchoredOverlay(menuRef, {
    anchorRef,
    boundaryRef,
    fallbackBoundaryRef,
    maxHeight: 280,
    placement,
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
      className={`node-context-menu${sourceContained ? ' file-preview-menu--source-contained' : ''}`}
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
