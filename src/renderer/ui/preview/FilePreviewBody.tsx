import { useMemo } from 'react';
import type { PreviewTarget } from '../../../core/preview';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { CopyIcon, FolderIcon, ICON_SIZE, OpenIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { fileNodeTarget, type FileNode } from './fileNode';
import {
  formatBytes,
  PreviewMessage,
  PreviewRenderer,
  sourceMeta,
  usePreviewSource,
} from './previewRenderers';

type AttachmentLabels = ReturnType<typeof useT>['outliner']['field']['attachment'];

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
  // Attachment nodes carry richer metadata than the resolved source (type label,
  // page count, media duration), so build their meta from the node; images / URLs
  // fall back to the resolved-source meta.
  const meta = node.type === 'attachment'
    ? attachmentNodeMeta(node, ta)
    : state.status === 'ready' ? sourceMeta(state.source, labels) : null;
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

type AttachmentKind = 'pdf' | 'audio' | 'video' | 'file';

function attachmentNodeMeta(
  node: Extract<FileNode, { type: 'attachment' }>,
  labels: AttachmentLabels,
): string {
  const mimeType = node.mimeType ?? 'application/octet-stream';
  const kind = attachmentKind(mimeType);
  return [
    attachmentTypeLabel(kind, mimeType, labels),
    node.fileSize !== undefined ? formatBytes(node.fileSize) : null,
    node.pdfPageCount ? labels.pages({ count: node.pdfPageCount }) : null,
    node.audioDurationMs ? labels.duration({ duration: formatDuration(node.audioDurationMs) }) : null,
    node.videoDurationMs ? labels.duration({ duration: formatDuration(node.videoDurationMs) }) : null,
  ].filter((part): part is string => Boolean(part)).join(' · ');
}

function attachmentKind(mimeType: string): AttachmentKind {
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

function attachmentTypeLabel(kind: AttachmentKind, mimeType: string, labels: AttachmentLabels): string {
  if (kind === 'pdf') return labels.pdf;
  if (kind === 'audio') return labels.audio;
  if (kind === 'video') return labels.video;
  return mimeType === 'application/octet-stream' ? labels.file : mimeType;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}
