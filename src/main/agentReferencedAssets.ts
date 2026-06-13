import type { DocumentProjection } from '../core/types';
import { xmlAttrs } from './agentReminderXml';

export interface ReferencedAssetNode {
  nodeId: string;
  title: string;
  assetId: string;
  /** True for image nodes — their bytes are an image even when asset metadata is absent. */
  isImageNode: boolean;
  /** Attachment-node fallbacks used when the asset metadata sidecar is missing. */
  nodeMimeType?: string;
  nodeFileName?: string;
  nodeFileSize?: number;
}

export interface MaterializedReferencedFile {
  nodeId: string;
  title: string;
  mimeType: string;
  sizeBytes: number;
  /** Absolute path of the copy inside the agent scratch root. */
  path: string;
  /** True when the same bytes are also inlined as an image block for vision. */
  inlineImage: boolean;
}

// Collapse whitespace so a stray newline/tab in a free-text title can never break the
// single-line `<file ... />` tag the reminder emits.
function compactTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Pick the user-referenced nodes whose bytes the agent can be given: image /
 * attachment nodes carrying an `assetId`. Only nodes the user explicitly
 * referenced are eligible — the explicit reference is the authorization, so an
 * asset that merely sits in the document (and was never referenced) is never
 * copied. De-duped by `assetId` (so two nodes pointing at the same bytes, or one
 * node referenced twice, are materialized once); non-asset references are dropped.
 */
export function selectReferencedAssetNodes(
  projection: DocumentProjection,
  referencedNodes: ReadonlyArray<{ nodeId: string; title?: string }> | undefined,
): ReferencedAssetNode[] {
  if (!referencedNodes || referencedNodes.length === 0) return [];
  const byId = new Map(projection.nodes.map((node) => [node.id, node]));
  const seenAssets = new Set<string>();
  const out: ReferencedAssetNode[] = [];
  for (const ref of referencedNodes) {
    const node = byId.get(ref.nodeId);
    if (!node) continue;
    if (node.type === 'image') {
      if (!node.assetId || seenAssets.has(node.assetId)) continue;
      seenAssets.add(node.assetId);
      out.push({
        nodeId: ref.nodeId,
        assetId: node.assetId,
        isImageNode: true,
        title: compactTitle(ref.title || node.mediaAlt || node.content.text || ''),
      });
    } else if (node.type === 'attachment') {
      if (!node.assetId || seenAssets.has(node.assetId)) continue;
      seenAssets.add(node.assetId);
      out.push({
        nodeId: ref.nodeId,
        assetId: node.assetId,
        isImageNode: false,
        title: compactTitle(ref.title || node.originalFilename || node.content.text || ''),
        nodeMimeType: node.mimeType,
        nodeFileName: node.originalFilename,
        nodeFileSize: node.fileSize,
      });
    }
  }
  return out;
}

/**
 * A hidden, model-only reminder that tells the agent where the referenced files
 * landed so it can `file_read` them. Images are additionally inlined as image
 * blocks; this block records their path too so the agent can re-read or process
 * the raw bytes. Returns null when there is nothing to surface.
 */
export function buildReferencedFilesReminder(files: ReadonlyArray<MaterializedReferencedFile>): string | null {
  if (files.length === 0) return null;
  const lines = [
    '<referenced-files>',
    'The user referenced these outliner files. Their bytes are available at the local paths below — use file_read to read a file (image files are also shown inline as image blocks in this message).',
  ];
  for (const file of files) {
    lines.push(`  <file${xmlAttrs({
      node_id: file.nodeId,
      title: file.title,
      mime: file.mimeType,
      size_bytes: file.sizeBytes > 0 ? String(file.sizeBytes) : null,
      path: file.path,
      inline_image: file.inlineImage ? 'true' : null,
    })} />`);
  }
  lines.push('</referenced-files>');
  return lines.join('\n');
}
