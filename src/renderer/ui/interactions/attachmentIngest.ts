import { api } from '../../api/client';
import type { AssetMetadata } from '../../api/types';
import { mediaKindForMimeType } from '../../../core/mediaKind';
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
    if (mediaKindForMimeType(asset.mimeType) === 'image') images.push(asset);
    else attachments.push(asset);
  }
  return { assets, images, attachments };
}

// The single AssetMetadata -> ordinary Source-backed Node mapping.
export function createAssetNode(
  run: CommandRunner,
  parentId: string,
  index: number | null,
  asset: AssetMetadata,
  options?: CommandRunnerOptions,
): ReturnType<CommandRunner> {
  return run(() => api.createSourceNode(parentId, index, {
    assetId: asset.id,
    name: asset.originalFilename ?? 'attachment',
  }), options);
}
