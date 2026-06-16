import { useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { PreviewTarget } from '../../../core/preview';
import { useT } from '../../i18n/I18nProvider';
import { AddChildIcon, FolderIcon, ICON_SIZE, OpenIcon } from '../icons';
import { MenuItem } from '../primitives/MenuItem';
import { MenuSurface } from '../primitives/MenuSurface';
import { overlayAnchorFromPoint, useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { useDismissibleOverlay } from '../primitives/useDismissibleOverlay';
import { useMenuKeyboard } from '../primitives/useMenuKeyboard';
import { requestAddPreviewTargetToOutline } from '../preview/previewIngest';

export interface AgentTranscriptFile {
  path: string;
  name: string;
  entryKind: 'file' | 'directory';
}

interface AgentTranscriptFileMenuProps {
  file: AgentTranscriptFile;
  x: number;
  y: number;
  onClose: () => void;
}

function previewTargetFor(file: AgentTranscriptFile): PreviewTarget {
  return {
    kind: 'local-file',
    path: file.path,
    entryKind: file.entryKind,
    label: file.name,
  };
}

/**
 * The right-click menu for a file chip rendered inside the agent transcript. Unlike
 * an outliner file reference (which opens the in-app preview pane), a transcript chip
 * is a pointer to a working file on disk: it opens with the OS default app, can be
 * revealed in Finder, and can be promoted into today's daily note as a first-class
 * file node ("Add to Today"). Built on the shared anchored-overlay menu stack (same as
 * NodeContextMenu / FileNodeActionMenu) so it inherits roving keys, Escape, and
 * dismissal.
 */
export function AgentTranscriptFileMenu({ file, x, y, onClose }: AgentTranscriptFileMenuProps) {
  const labels = useT().agent.filePreview;
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Memoize the point-anchor: a fresh object each render would re-fire the overlay's
  // layout effect every time it sets its style, looping (see NodeContextMenu).
  const menuAnchor = useMemo(() => overlayAnchorFromPoint(x, y), [x, y]);
  const menuStyle = useAnchoredOverlay(menuRef, {
    anchorRect: menuAnchor,
    maxHeight: 240,
    placement: 'bottom-start',
    width: 220,
  });
  // Outside-pointer dismissal only — Escape is owned by `useMenuKeyboard` (it scopes
  // ESC to the focused surface and restores focus to the trigger).
  useDismissibleOverlay(menuRef, onClose, { escape: false });
  const { onKeyDown } = useMenuKeyboard({ surfaceRef: menuRef, onClose, kind: 'menu' });

  const addToToday = () => {
    // App owns the destination: it ensures today's daily note exists (through the
    // command runner, so the new node is in the index) and creates the file node
    // under it, surfacing a failure toast on its own. Fire-and-forget here.
    void requestAddPreviewTargetToOutline({ target: previewTargetFor(file) });
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
