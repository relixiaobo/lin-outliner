export type MediaKind = 'image' | 'audio' | 'video';

/** Classify only an explicit MIME family; callers decide whether other evidence is admissible. */
export function mediaKindForMimeType(value: string | null | undefined): MediaKind | null {
  const mimeType = value?.trim().toLowerCase();
  if (!mimeType) return null;
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return null;
}
