import { useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { PreviewTarget } from '../../../core/preview';
import type { FilePreviewNavigationOptions } from '../workspaceLayoutTypes';
import { useT } from '../../i18n/I18nProvider';
import {
  AddChildIcon,
  FolderIcon,
  ICON_SIZE,
  OpenIcon,
  ShowIcon,
} from '../icons';
import { MenuItem } from '../primitives/MenuItem';
import { MenuSurface } from '../primitives/MenuSurface';
import { overlayAnchorFromPoint, useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { useDismissibleOverlay } from '../primitives/useDismissibleOverlay';
import { useMenuKeyboard } from '../primitives/useMenuKeyboard';
import { dispatchPreviewTargetOpen } from '../preview/previewEvents';
import { requestAddPreviewTargetToOutline } from '../preview/previewIngest';

export interface InlineFileMenuFile {
  path: string;
  name: string;
  entryKind: 'file' | 'directory';
}

interface InlineFileContextMenuProps {
  file: InlineFileMenuFile;
  presentation?: FilePreviewNavigationOptions['presentation'];
  x: number;
  y: number;
  onClose: () => void;
}

export function previewTargetForInlineFile(file: InlineFileMenuFile): PreviewTarget {
  return {
    kind: 'local-file',
    path: file.path,
    entryKind: file.entryKind,
    label: file.name,
  };
}

export function InlineFileContextMenu({
  file,
  presentation,
  x,
  y,
  onClose,
}: InlineFileContextMenuProps) {
  const labels = useT().agent.filePreview;
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Memoize the point-anchor: a fresh object each render would re-fire the overlay's
  // layout effect every time it sets its style, looping (see NodeContextMenu).
  const menuAnchor = useMemo(() => overlayAnchorFromPoint(x, y), [x, y]);
  const menuStyle = useAnchoredOverlay(menuRef, {
    anchorRect: menuAnchor,
    maxHeight: 280,
    placement: 'bottom-start',
    width: 220,
  });
  // Outside-pointer dismissal only; Escape is owned by `useMenuKeyboard`.
  useDismissibleOverlay(menuRef, onClose, { escape: false });
  const { onKeyDown } = useMenuKeyboard({ surfaceRef: menuRef, onClose, kind: 'menu' });

  const target = previewTargetForInlineFile(file);

  const previewInTenon = () => {
    dispatchPreviewTargetOpen({
      ...(presentation ? { presentation } : {}),
      target,
    });
  };

  const addToToday = () => {
    // App owns the destination: it ensures today's daily note exists (through the
    // command runner, so the new node is in the index) and creates the file node
    // under it, surfacing a failure toast on its own. Fire-and-forget here.
    void requestAddPreviewTargetToOutline({ target });
  };

  const openExternally = () => {
    void window.lin?.openLocalFile?.({ path: file.path });
  };

  const revealInFinder = () => {
    void window.lin?.revealLocalFile?.({ path: file.path });
  };

  const run = (action: () => void) => () => {
    onClose();
    action();
  };

  return createPortal(
    <MenuSurface
      ref={menuRef}
      aria-label={labels.menuLabel}
      className="node-context-menu"
      // Portaled to <body>; preserve the selection so the document pointerdown handler
      // doesn't clear the active row when the menu (or an item) is clicked.
      preserveSelection
      role="menu"
      style={menuStyle}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <MenuItem
        className="node-context-item"
        icon={<ShowIcon size={ICON_SIZE.menu} />}
        label={labels.previewInTenon}
        onClick={run(previewInTenon)}
        role="menuitem"
      />
      {file.entryKind !== 'directory' ? (
        // A directory can't be ingested into the asset store as a file node, so
        // "Add to Today" applies to files only; a directory still opens / reveals.
        <MenuItem
          className="node-context-item"
          icon={<AddChildIcon size={ICON_SIZE.menu} />}
          label={labels.addToToday}
          onClick={run(addToToday)}
          role="menuitem"
        />
      ) : null}
      <MenuItem
        className="node-context-item"
        icon={<OpenIcon size={ICON_SIZE.menu} />}
        label={labels.openWithDefaultApp}
        onClick={run(openExternally)}
        role="menuitem"
      />
      <MenuItem
        className="node-context-item"
        icon={<FolderIcon size={ICON_SIZE.menu} />}
        label={labels.showInFinder}
        onClick={run(revealInFinder)}
        role="menuitem"
      />
    </MenuSurface>,
    document.body,
  );
}
