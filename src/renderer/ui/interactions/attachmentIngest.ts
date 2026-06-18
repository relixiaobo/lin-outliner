import { api } from '../../api/client';
import type { AssetMetadata } from '../../api/types';
import type { CommandRunner, CommandRunnerOptions } from '../shared';

export interface IngestedFiles {
  assets: AssetMetadata[];
  images: AssetMetadata[];
  attachments: AssetMetadata[];
}

export function dataTransferFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files.length > 0 ? files : Array.from(data.files ?? []);
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

// The single "AssetMetadata -> outliner node" mapping: an image node for image/*
// (carrying its pixel dims), else an attachment node (full metadata). Shared by the
// user paste/drop flow and the agent ingest bridge so an agent-inserted file and a
// user-dropped one produce identical nodes. Returns the runner's result (null when
// the command failed) so callers can confirm a real insert; `options` forwards focus
// behavior (the bridge suppresses focus to keep it in the agent panel).
export function createAssetNode(
  run: CommandRunner,
  parentId: string,
  index: number | null,
  asset: AssetMetadata,
  options?: CommandRunnerOptions,
): ReturnType<CommandRunner> {
  return asset.mimeType.startsWith('image/')
    ? run(() => api.createImageNode(parentId, index, {
        assetId: asset.id,
        width: asset.imageWidth,
        height: asset.imageHeight,
        name: asset.originalFilename,
      }), options)
    : run(() => api.createAttachmentNode(parentId, index, attachmentNodeInput(asset)), options);
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
