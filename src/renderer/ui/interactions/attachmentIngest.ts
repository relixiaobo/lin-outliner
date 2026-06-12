import { api } from '../../api/client';
import type { AssetMetadata } from '../../api/types';

export interface IngestedFiles {
  assets: AssetMetadata[];
  images: AssetMetadata[];
  attachments: AssetMetadata[];
}

export function dataTransferFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  return Array.from(data.files);
}

export function hasFileTransfer(data: DataTransfer | null | undefined): boolean {
  return dataTransferFiles(data).length > 0
    || Array.from(data?.items ?? []).some((item) => item.kind === 'file');
}

export async function ingestFiles(files: readonly File[]): Promise<IngestedFiles> {
  const assets: AssetMetadata[] = [];
  const images: AssetMetadata[] = [];
  const attachments: AssetMetadata[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const asset = await api.ingestAssetFromData(bytes, file.type || undefined, file.name || undefined);
    assets.push(asset);
    if (asset.mimeType.startsWith('image/')) images.push(asset);
    else attachments.push(asset);
  }
  return { assets, images, attachments };
}

export function attachmentNodeInput(asset: AssetMetadata) {
  return {
    assetId: asset.id,
    mimeType: asset.mimeType,
    originalFilename: asset.originalFilename ?? 'attachment',
    fileSize: asset.byteSize,
    ...(asset.thumbnailAssetId ? { thumbnailAssetId: asset.thumbnailAssetId } : {}),
    ...(asset.pdfPageCount !== undefined ? { pdfPageCount: asset.pdfPageCount } : {}),
    ...(asset.audioDurationMs !== undefined ? { audioDurationMs: asset.audioDurationMs } : {}),
    ...(asset.videoDurationMs !== undefined ? { videoDurationMs: asset.videoDurationMs } : {}),
  };
}
