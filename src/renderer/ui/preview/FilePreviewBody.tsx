import { useMemo, type ComponentType } from 'react';
import type { PreviewTarget } from '../../../core/preview';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { CopyIcon, FolderIcon, OpenIcon } from '../icons';
import type { FilePreviewNavigationOptions } from '../workspaceLayoutTypes';
import { fileNodeMeta, fileNodeTarget, type FileNode } from './fileNode';
import { fileNodeAssetActions, type FileNodeAssetActionKey } from './fileNodeActions';
import type { FilePreviewMenuAction } from './FilePreviewPill';
import {
  FilePreviewShell,
  type PreviewSourceState,
  sourceMeta,
  usePreviewSource,
} from './previewRenderers';

const ASSET_MENU_ICON: Record<Exclude<FileNodeAssetActionKey, 'open'>, ComponentType<{ size?: number }>> = {
  reveal: FolderIcon,
  copy: CopyIcon,
};

interface FilePreviewBodyProps {
  node: FileNode;
  onOpenTarget: (target: PreviewTarget, options?: FilePreviewNavigationOptions) => void;
  // Previewable sources start in summary mode (a bounded thumbnail strip for PDFs)
  // and Expand switches into the full scrollable renderer.
  initialExpanded?: boolean;
}

/**
 * The body of an ingested file preview: the rendered preview with its bottom-center
 * floating pill, shown on the node page above the node's children outline and inline
 * under an expanded file row. The file's name lives in the surface title / row, so
 * this body never repeats it. Shares its layout (FilePreviewShell) with loose
 * previews, so the two read identically.
 */
export function FilePreviewBody({ node, onOpenTarget, initialExpanded = false }: FilePreviewBodyProps) {
  const target = useMemo(
    () => fileNodeTarget(node),
    // Intentionally excludes node.content.text: the filename feeds only the target's
    // cosmetic `label`; the file surface renders its title separately. Keying on it
    // would rebuild the target and re-resolve usePreviewSource, reloading the
    // PDF/image/media renderer from scratch on display-name-only updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [node.assetId, node.type, node.type === 'image' ? node.mediaUrl : undefined],
  );
  if (!target) {
    return (
      <FilePreviewShell
        state={{ status: 'missing' }}
        onOpenTarget={onOpenTarget}
        initialExpanded={initialExpanded}
      />
    );
  }
  return (
    <FilePreviewBodyResolved
      node={node}
      target={target}
      onOpenTarget={onOpenTarget}
      initialExpanded={initialExpanded}
    />
  );
}

function FilePreviewBodyResolved({
  node,
  target,
  onOpenTarget,
  initialExpanded,
}: {
  node: FileNode;
  target: PreviewTarget;
  onOpenTarget: (target: PreviewTarget, options?: FilePreviewNavigationOptions) => void;
  initialExpanded: boolean;
}) {
  const state = usePreviewSource(target);
  const attachmentLabels = useT().outliner.field.attachment;
  const previewLabels = useT().shell.filePreview;
  const meta = fileNodePreviewMeta(node, state, attachmentLabels, previewLabels);
  const { primaryOpen, menuActions } = fileNodePreviewControls(node, target, attachmentLabels, previewLabels, {
    openInSplit: () => onOpenTarget(target, { newPane: true, nodeId: node.id, presentation: 'reader' }),
  });

  return (
    <FilePreviewShell
      state={state}
      onOpenTarget={onOpenTarget}
      primaryOpen={primaryOpen}
      menuActions={menuActions}
      meta={meta}
      initialExpanded={initialExpanded}
    />
  );
}

export function fileNodePreviewMeta(
  node: FileNode,
  state: PreviewSourceState,
  attachmentLabels: Parameters<typeof fileNodeMeta>[1],
  previewLabels: Parameters<typeof sourceMeta>[1],
): string | null {
  // Attachment nodes carry richer metadata than the resolved source (type label,
  // page count, media duration), so build their meta from the node; images / URLs
  // fall back to the resolved-source meta.
  return node.type === 'attachment'
    ? fileNodeMeta(node, attachmentLabels)
    : state.status === 'ready' ? sourceMeta(state.source, previewLabels) : null;
}

/**
 * The pill controls for an ingested file node: Open-with-default-app as the primary,
 * Reveal-in-Finder / Copy in the `⋯` menu (the shared `fileNodeAssetActions` descriptor,
 * also used by the row menu, so they stay in sync). A remote (mediaUrl-only) image has
 * no stored asset, so it offers only Open-in-browser.
 */
export function fileNodePreviewControls(
  node: FileNode,
  target: PreviewTarget,
  attachmentLabels: Parameters<typeof fileNodeAssetActions>[1],
  previewLabels: ReturnType<typeof useT>['shell']['filePreview'],
  options: { openInSplit?: () => void } = {},
): { primaryOpen: { label: string; run: () => void } | null; menuActions: FilePreviewMenuAction[] } {
  const openInSplitAction: FilePreviewMenuAction[] = options.openInSplit
    ? [{
        key: 'open-in-split',
        label: previewLabels.openInSplitPane,
        icon: OpenIcon,
        run: options.openInSplit,
      }]
    : [];
  const assetId = node.assetId;
  if (assetId) {
    const actions = fileNodeAssetActions(assetId, attachmentLabels);
    const open = actions.find((action) => action.key === 'open') ?? null;
    const menuActions: FilePreviewMenuAction[] = actions
      .filter((action) => action.key !== 'open')
      .map((action) => ({
        key: action.key,
        label: action.label,
        icon: ASSET_MENU_ICON[action.key as Exclude<FileNodeAssetActionKey, 'open'>],
        run: action.run,
      }));
    return {
      primaryOpen: open ? { label: previewLabels.openWithDefault, run: open.run } : null,
      menuActions: [...openInSplitAction, ...menuActions],
    };
  }
  if (target.kind === 'url') {
    return {
      primaryOpen: { label: previewLabels.openInBrowser, run: () => void api.openExternalUrl(target.url) },
      menuActions: openInSplitAction,
    };
  }
  return { primaryOpen: null, menuActions: openInSplitAction };
}
