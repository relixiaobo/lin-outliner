import { useMemo } from 'react';
import type { PreviewTarget } from '../../../core/preview';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { CopyIcon, FolderIcon, ICON_SIZE, OpenIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { fileNodeMeta, fileNodeTarget, type FileNode } from './fileNode';
import { fileNodeAssetActions, type FileNodeAssetActionKey } from './fileNodeActions';
import {
  FilePreviewShell,
  sourceMeta,
  usePreviewSource,
} from './previewRenderers';

const ASSET_ACTION_ICON: Record<FileNodeAssetActionKey, typeof OpenIcon> = {
  open: OpenIcon,
  reveal: FolderIcon,
  copy: CopyIcon,
};

interface FilePreviewBodyProps {
  node: FileNode;
  onOpenTarget: (target: PreviewTarget, options?: { newPane?: boolean }) => void;
}

/**
 * The body of a file node's node page: a meta + actions strip over the rendered
 * preview, shown above the node's children outline. The file's name lives in the
 * page title, so this body never repeats it. Shares its layout (FilePreviewShell)
 * with the non-node pane preview, so the two read identically.
 */
export function FilePreviewBody({ node, onOpenTarget }: FilePreviewBodyProps) {
  const target = useMemo(
    () => fileNodeTarget(node),
    // Intentionally excludes node.content.text: the filename feeds only the target's
    // cosmetic `label`; the node page renders its title separately. Keying on it
    // would rebuild the target and re-resolve usePreviewSource, reloading the
    // PDF/image/media renderer from scratch on display-name-only updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [node.assetId, node.type, node.type === 'image' ? node.mediaUrl : undefined],
  );
  if (!target) {
    return <FilePreviewShell meta={null} state={{ status: 'missing' }} onOpenTarget={onOpenTarget} />;
  }
  return <FilePreviewBodyResolved node={node} target={target} onOpenTarget={onOpenTarget} />;
}

function FilePreviewBodyResolved({
  node,
  target,
  onOpenTarget,
}: {
  node: FileNode;
  target: PreviewTarget;
  onOpenTarget: (target: PreviewTarget, options?: { newPane?: boolean }) => void;
}) {
  const ta = useT().outliner.field.attachment;
  const labels = useT().shell.filePreview;
  const state = usePreviewSource(target);
  // Attachment nodes carry richer metadata than the resolved source (type label,
  // page count, media duration), so build their meta from the node; images / URLs
  // fall back to the resolved-source meta.
  const meta = node.type === 'attachment'
    ? fileNodeMeta(node, ta)
    : state.status === 'ready' ? sourceMeta(state.source, labels) : null;
  const assetId = node.assetId;
  // A file node already lives in the outline, so its actions are open / reveal /
  // copy on the stored asset (the non-node pane substitutes add-to-outline). The
  // descriptor is shared with the row ⋯ menu so the two stay in sync.
  const actions = assetId ? (
    <>
      {fileNodeAssetActions(assetId, ta).map((action) => {
        const Icon = ASSET_ACTION_ICON[action.key];
        return (
          <ButtonControl
            key={action.key}
            aria-label={action.label}
            className="file-node-action"
            onClick={action.run}
          >
            <Icon size={ICON_SIZE.toolbar} />
          </ButtonControl>
        );
      })}
    </>
  ) : target.kind === 'url' ? (
    // A remote (mediaUrl-only) image has no stored asset to open/reveal/copy, but it
    // can still be opened in the browser.
    <ButtonControl
      aria-label={labels.openInBrowser}
      className="file-node-action"
      onClick={() => void api.openExternalUrl(target.url)}
    >
      <OpenIcon size={ICON_SIZE.toolbar} />
    </ButtonControl>
  ) : null;

  return (
    <FilePreviewShell
      meta={meta}
      actions={actions}
      state={state}
      onOpenTarget={onOpenTarget}
    />
  );
}
