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

/** The preview target a file node resolves to (a local asset, or a remote image URL). */
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

/** The file-type glyph kind shown as the row bullet for a file node. */
export function fileNodeIconKind(node: FileNode): InlineFileIconKind {
  if (node.type === 'image') return 'image';
  return inlineFileIconKind({ mimeType: node.mimeType, name: node.originalFilename ?? node.content.text });
}
