import { api } from '../../api/client';
import type { NodeProjection } from '../../api/types';
import { assetUrl } from '../../../core/assets';
import { CopyIcon, FolderIcon, ICON_SIZE, OpenIcon } from '../icons';
import {
  INLINE_FILE_ICON_CLASS,
  inlineFileIconKind,
} from '../editor/inlineFileIcon';
import { ButtonControl } from '../primitives/ButtonControl';
import { useT } from '../../i18n/I18nProvider';
import { wantsNewPaneFromClick } from '../shared';
import { dispatchPreviewTargetOpen } from '../preview/previewEvents';

interface AttachmentRowProps {
  node: Extract<NodeProjection, { type: 'attachment' }>;
}

export function AttachmentRow({ node }: AttachmentRowProps) {
  const ta = useT().outliner.field.attachment;
  if (!node.assetId || !node.mimeType || !node.originalFilename || node.fileSize === undefined) {
    return (
      <div className="outliner-attachment outliner-attachment--missing" contentEditable={false}>
        {ta.unavailable}
      </div>
    );
  }

  const assetId = node.assetId;
  const kind = attachmentKind(node.mimeType);
  const typeLabel = attachmentTypeLabel(kind, node.mimeType, ta);
  const metaParts = [
    typeLabel,
    formatBytes(node.fileSize),
    node.pdfPageCount ? ta.pages({ count: node.pdfPageCount }) : null,
    node.audioDurationMs ? ta.duration({ duration: formatDuration(node.audioDurationMs) }) : null,
    node.videoDurationMs ? ta.duration({ duration: formatDuration(node.videoDurationMs) }) : null,
  ].filter((part): part is string => Boolean(part));

  return (
    <div
      className={`outliner-attachment outliner-attachment--${kind}`}
      contentEditable={false}
      onClick={(event) => {
        dispatchPreviewTargetOpen({
          newPane: wantsNewPaneFromClick(event),
          target: {
            kind: 'asset',
            assetId,
            label: node.originalFilename,
          },
        });
      }}
    >
      {node.thumbnailAssetId ? (
        <img
          alt=""
          className="outliner-attachment-thumb"
          draggable={false}
          src={assetUrl(node.thumbnailAssetId)}
        />
      ) : (
        <span
          aria-hidden="true"
          className={`outliner-attachment-icon ${INLINE_FILE_ICON_CLASS}`}
          data-file-icon-kind={inlineFileIconKind({ mimeType: node.mimeType, name: node.originalFilename })}
        />
      )}
      <div className="outliner-attachment-main">
        <div className="outliner-attachment-title" title={node.originalFilename}>
          {node.originalFilename}
        </div>
        <div className="outliner-attachment-meta">
          {metaParts.join(' · ')}
        </div>
        {kind === 'audio' && (
          <audio
            className="outliner-attachment-media"
            controls
            onClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            preload="metadata"
            src={assetUrl(assetId)}
          />
        )}
        {kind === 'video' && (
          <video
            className="outliner-attachment-media"
            controls
            onClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            preload="metadata"
            src={assetUrl(assetId)}
          />
        )}
      </div>
      <div
        className="outliner-attachment-actions"
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <ButtonControl
          aria-label={ta.open}
          className="outliner-attachment-action"
          onClick={() => void api.openAsset(node.assetId!)}
        >
          <OpenIcon size={ICON_SIZE.toolbar} />
        </ButtonControl>
        <ButtonControl
          aria-label={ta.reveal}
          className="outliner-attachment-action"
          onClick={() => void api.revealAsset(node.assetId!)}
        >
          <FolderIcon size={ICON_SIZE.toolbar} />
        </ButtonControl>
        <ButtonControl
          aria-label={ta.copy}
          className="outliner-attachment-action"
          onClick={() => void api.copyAssetFile(node.assetId!)}
        >
          <CopyIcon size={ICON_SIZE.toolbar} />
        </ButtonControl>
      </div>
    </div>
  );
}

type AttachmentKind = 'pdf' | 'audio' | 'video' | 'file';

function attachmentKind(mimeType: string): AttachmentKind {
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

function attachmentTypeLabel(
  kind: AttachmentKind,
  mimeType: string,
  labels: ReturnType<typeof useT>['outliner']['field']['attachment'],
): string {
  if (kind === 'pdf') return labels.pdf;
  if (kind === 'audio') return labels.audio;
  if (kind === 'video') return labels.video;
  return mimeType === 'application/octet-stream' ? labels.file : mimeType;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
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
