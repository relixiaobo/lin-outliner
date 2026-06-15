import { api } from '../../api/client';

export type FileNodeAssetActionKey = 'open' | 'reveal' | 'copy';

export interface FileNodeAssetActionLabels {
  open: string;
  reveal: string;
  copy: string;
}

export interface FileNodeAssetAction {
  key: FileNodeAssetActionKey;
  label: string;
  run: () => void;
}

/**
 * The system actions for a file node's stored asset — open (default app), reveal in
 * Finder, copy the file — as one descriptor list, so the preview action strip and
 * the row ⋯ menu stay in sync (one place to add or change an asset action). The descriptor
 * carries the api call; each consumer only chooses the presentation (button vs menu
 * item) and the icon size.
 */
export function fileNodeAssetActions(
  assetId: string,
  labels: FileNodeAssetActionLabels,
): FileNodeAssetAction[] {
  return [
    { key: 'open', label: labels.open, run: () => void api.openAsset(assetId) },
    { key: 'reveal', label: labels.reveal, run: () => void api.revealAsset(assetId) },
    { key: 'copy', label: labels.copy, run: () => void api.copyAssetFile(assetId) },
  ];
}
