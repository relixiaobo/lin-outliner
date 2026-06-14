import { useMemo } from 'react';
import type { NodeProjection } from '../../api/types';
import type { PreviewTarget } from '../../../core/preview';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { CopyIcon, FolderIcon, ICON_SIZE, OpenIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import {
  PreviewMessage,
  PreviewRenderer,
  sourceMeta,
  usePreviewSource,
} from './previewRenderers';

export type FileNode =
  | Extract<NodeProjection, { type: 'attachment' }>
  | Extract<NodeProjection, { type: 'image' }>;

/** True when this node is a file (attachment or image) with a usable source. */
export function isFileNode(node: NodeProjection | undefined): node is FileNode {
  if (!node) return false;
  if (node.type === 'attachment') return Boolean(node.assetId);
  if (node.type === 'image') return Boolean(node.assetId || node.mediaUrl);
  return false;
}

/** The preview target a file node resolves to (local asset, or a remote image URL). */
export function fileNodeTarget(node: FileNode): PreviewTarget | null {
  if (node.assetId) {
    return {
      kind: 'asset',
      assetId: node.assetId,
      ...(node.content.text ? { label: node.content.text } : {}),
    };
  }
  if (node.type === 'image' && node.mediaUrl) {
    return { kind: 'url', url: node.mediaUrl };
  }
  return null;
}

interface FilePreviewBodyProps {
  node: FileNode;
  onOpenTarget: (target: PreviewTarget, options?: { newPane?: boolean }) => void;
  /** `full` = node page body; `inline` = bounded preview block under an expanded row. */
  variant?: 'full' | 'inline';
}

/**
 * The body of a file node: a meta + actions strip over the rendered preview. The
 * file's name lives in the owning surface's title (node page) or row text (inline
 * block), so this body never repeats it. Shared by the node page and the inline
 * preview block via `variant`.
 */
export function FilePreviewBody({ node, onOpenTarget, variant = 'full' }: FilePreviewBodyProps) {
  const labels = useT().shell.filePreview;
  const target = useMemo(
    () => fileNodeTarget(node),
    [node.assetId, node.type, node.type === 'image' ? node.mediaUrl : undefined, node.content.text],
  );
  if (!target) {
    return (
      <div className={`file-node-body file-node-body--${variant}`}>
        <PreviewMessage>{labels.unavailable}</PreviewMessage>
      </div>
    );
  }
  return <FilePreviewBodyResolved node={node} target={target} onOpenTarget={onOpenTarget} variant={variant} />;
}

function FilePreviewBodyResolved({
  node,
  target,
  onOpenTarget,
  variant,
}: {
  node: FileNode;
  target: PreviewTarget;
  onOpenTarget: (target: PreviewTarget, options?: { newPane?: boolean }) => void;
  variant: 'full' | 'inline';
}) {
  const ta = useT().outliner.field.attachment;
  const labels = useT().shell.filePreview;
  const state = usePreviewSource(target);
  const meta = state.status === 'ready' ? sourceMeta(state.source, labels) : null;
  const assetId = node.assetId;

  return (
    <div className={`file-node-body file-node-body--${variant}`}>
      <div className="file-node-toolbar">
        <span className="file-node-meta">{meta ?? ' '}</span>
        {assetId ? (
          <div className="file-node-actions">
            <ButtonControl
              aria-label={ta.open}
              className="file-node-action"
              onClick={() => void api.openAsset(assetId)}
            >
              <OpenIcon size={ICON_SIZE.toolbar} />
            </ButtonControl>
            <ButtonControl
              aria-label={ta.reveal}
              className="file-node-action"
              onClick={() => void api.revealAsset(assetId)}
            >
              <FolderIcon size={ICON_SIZE.toolbar} />
            </ButtonControl>
            <ButtonControl
              aria-label={ta.copy}
              className="file-node-action"
              onClick={() => void api.copyAssetFile(assetId)}
            >
              <CopyIcon size={ICON_SIZE.toolbar} />
            </ButtonControl>
          </div>
        ) : null}
      </div>
      <div className="file-node-preview">
        {state.status === 'loading' ? (
          <PreviewMessage>{labels.loading}</PreviewMessage>
        ) : state.status === 'missing' ? (
          <PreviewMessage>{state.error === 'too-large' ? labels.tooLarge : labels.unavailable}</PreviewMessage>
        ) : (
          <PreviewRenderer source={state.source} onOpenTarget={onOpenTarget} />
        )}
      </div>
    </div>
  );
}
