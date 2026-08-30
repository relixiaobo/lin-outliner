import { api } from '../../api/client';
import type { AssetMetadata, NodeId } from '../../api/types';
import type { CommandRunner } from '../shared';

export interface PastedImage {
  data: Uint8Array;
  mimeType?: string;
  name?: string;
}

/**
 * Collect image files from a paste/drop `DataTransfer`. Must run synchronously
 * inside the event: `getAsFile()` is only valid during dispatch. Falls back to
 * `.files` for sources that populate it but not `.items`.
 */
export function clipboardImageFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length === 0) {
    for (const file of Array.from(data.files ?? [])) {
      if (file.type.startsWith('image/')) files.push(file);
    }
  }
  return files;
}

export async function readPastedImages(files: File[]): Promise<PastedImage[]> {
  return Promise.all(files.map(async (file) => ({
    data: new Uint8Array(await file.arrayBuffer()),
    mimeType: file.type || undefined,
    name: file.name || undefined,
  })));
}

export async function ingestPastedImages(images: PastedImage[]): Promise<AssetMetadata[]> {
  const assets: AssetMetadata[] = [];
  for (const image of images) {
    assets.push(await api.ingestAssetFromData(image.data, image.mimeType, image.name));
  }
  return assets;
}

// A lone http(s) URL ending in a known image extension (optional query). Used
// to turn a pasted image link into a remote Source-backed Node rather than plain text.
const IMAGE_URL_RE = /^https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg|avif|bmp|heic)(?:\?\S*)?$/i;

/** If `text` is exactly a remote image URL, return it (trimmed); else null. */
export function imageUrlFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  return IMAGE_URL_RE.test(trimmed) ? trimmed : null;
}

/**
 * Decide whether a dropped/pasted Source should attach to the current row in
 * place. Only an empty, childless ordinary row is reused.
 */
export function shouldConvertRowToImage(row: {
  referenceLikeRow: boolean;
  nodeType: string | undefined;
  hasChildren: boolean;
  rowTextEmpty: boolean;
}): boolean {
  if (row.referenceLikeRow || row.hasChildren) return false;
  return !row.nodeType && row.rowTextEmpty;
}

/**
 * Ingest images and create ordinary Source-backed Nodes under `parentId`.
 */
export async function appendImageNodes(parentId: NodeId, images: PastedImage[], run: CommandRunner): Promise<void> {
  const assets = await ingestPastedImages(images);
  for (const asset of assets) {
    await run(() => api.createSourceNode(parentId, null, {
      assetId: asset.id,
      name: asset.originalFilename,
    }));
  }
}

/** Create a remote Source-backed Node appended under `parentId`. */
export async function appendRemoteImageNode(parentId: NodeId, url: string, run: CommandRunner): Promise<void> {
  await run(() => api.createSourceNode(parentId, null, { sourceText: url }));
}
