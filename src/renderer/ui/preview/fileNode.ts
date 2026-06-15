import type { NodeProjection } from '../../api/types';
import type { PreviewTarget } from '../../../core/preview';
import { inlineFileIconKind, type InlineFileIconKind } from '../editor/inlineFileIcon';

// Lightweight file-node helpers, kept free of the heavy preview-renderer module
// (react-markdown / shiki / pdfjs) so the outliner hot path can import them.

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

/** The read-only filename/title used by file rows and file preview surfaces. */
export function fileNodeTitle(node: FileNode): string {
  const displayName = node.content.text.trim();
  if (displayName) return displayName;
  if (node.type === 'attachment') return node.originalFilename?.trim() ?? '';
  if (node.mediaUrl) return node.mediaUrl.trim();
  if (node.mediaAlt) return node.mediaAlt.trim();
  return '';
}

/** The preview target a file node resolves to (a local asset, or a remote image URL). */
export function fileNodeTarget(node: FileNode): PreviewTarget | null {
  const label = fileNodeTitle(node);
  if (node.assetId) {
    return {
      kind: 'asset',
      assetId: node.assetId,
      ...(label ? { label } : {}),
    };
  }
  if (node.type === 'image' && node.mediaUrl) {
    return { kind: 'url', url: node.mediaUrl, ...(label ? { label } : {}) };
  }
  return null;
}

/** The file-type glyph kind shown for a file node (card icon / preview meta). */
export function fileNodeIconKind(node: FileNode): InlineFileIconKind {
  if (node.type === 'image') return 'image';
  return inlineFileIconKind({ mimeType: node.mimeType, name: node.originalFilename ?? node.content.text });
}

/**
 * The labels a file node's meta line needs — a structural subset of the
 * `outliner.field.attachment` i18n group, declared here so this hot-path module
 * stays decoupled from the i18n types (and the heavy preview-renderer module).
 */
export interface FileNodeMetaLabels {
  pdf: string;
  audio: string;
  video: string;
  file: string;
  pages: (params: { count: number }) => string;
  duration: (params: { duration: string }) => string;
}

/** Human-readable byte size, e.g. "5.7 KB". */
export function formatBytes(bytes: number): string {
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

type AttachmentKind = 'pdf' | 'audio' | 'video' | 'file';

function attachmentKind(mimeType: string): AttachmentKind {
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

function attachmentTypeLabel(kind: AttachmentKind, mimeType: string, labels: FileNodeMetaLabels): string {
  if (kind === 'pdf') return labels.pdf;
  if (kind === 'audio') return labels.audio;
  if (kind === 'video') return labels.video;
  return mimeType === 'application/octet-stream' ? labels.file : mimeType;
}

/**
 * The meta line for a file node — type, size, and any kind-specific extent (PDF page
 * count, media duration, image dimensions). Derived from the node's own fields, so
 * the outliner card shows it without loading the preview source. Returns null when
 * there is nothing meaningful to show.
 */
export function fileNodeMeta(node: FileNode, labels: FileNodeMetaLabels): string | null {
  if (node.type === 'attachment') {
    const mimeType = node.mimeType ?? 'application/octet-stream';
    const parts = [
      attachmentTypeLabel(attachmentKind(mimeType), mimeType, labels),
      node.fileSize !== undefined ? formatBytes(node.fileSize) : null,
      node.pdfPageCount ? labels.pages({ count: node.pdfPageCount }) : null,
      node.audioDurationMs ? labels.duration({ duration: formatDuration(node.audioDurationMs) }) : null,
      node.videoDurationMs ? labels.duration({ duration: formatDuration(node.videoDurationMs) }) : null,
    ].filter((part): part is string => Boolean(part));
    return parts.length ? parts.join(' · ') : null;
  }
  if (node.imageWidth && node.imageHeight) {
    return `${node.imageWidth} × ${node.imageHeight}`;
  }
  return null;
}
