import type { PreviewTarget } from './previewTarget';

const ASSET_SOURCE_PREFIX = 'asset://local/';

export type SourceKind = 'web' | 'image' | 'document' | 'audio' | 'video' | 'file';
export type SourceAvailability = 'ready' | 'invalid' | 'unavailable' | 'denied' | 'unsupported';
export type SourceResolutionReason =
  | 'malformed-uri'
  | 'unsupported-scheme'
  | 'asset-unavailable'
  | 'file-access-denied'
  | 'file-unavailable'
  | 'network-unavailable';
export type SourceAction =
  | 'copy-uri'
  | 'edit'
  | 'preview'
  | 'open'
  | 'reveal'
  | 'retry'
  | 'authorize'
  | 'replace'
  | 'remove';

export interface ResolvedNodeSource {
  sourceValueId: string;
  sourceText: string;
  normalizedUri?: string;
  kind?: SourceKind;
  label: string;
  previewTarget?: PreviewTarget;
  availability: SourceAvailability;
  reason?: SourceResolutionReason;
  actions: readonly SourceAction[];
}

export type ClassifiedNodeSource = Omit<ResolvedNodeSource, 'sourceValueId' | 'previewTarget'>;

const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
const DOCUMENT_EXTENSIONS = new Set([
  'csv', 'doc', 'docx', 'epub', 'html', 'htm', 'md', 'markdown', 'odp', 'ods', 'odt',
  'pdf', 'ppt', 'pptx', 'rtf', 'tsv', 'txt', 'xls', 'xlsx',
]);
const AUDIO_EXTENSIONS = new Set(['aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav']);
const VIDEO_EXTENSIONS = new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'ogv', 'webm']);

export function formatAssetSourceUri(assetId: string): string {
  if (!assetId) throw new Error('Asset Source URI requires a non-empty AssetRecord ID.');
  return `${ASSET_SOURCE_PREFIX}${encodeURIComponent(assetId)}`;
}

export function parseAssetSourceUri(sourceText: string): string | null {
  if (!sourceText.startsWith(ASSET_SOURCE_PREFIX)) return null;
  const encoded = sourceText.slice(ASSET_SOURCE_PREFIX.length);
  if (!encoded || encoded.includes('/')) return null;
  try {
    const assetId = decodeURIComponent(encoded);
    if (!assetId || formatAssetSourceUri(assetId) !== sourceText) return null;
    return assetId;
  } catch {
    return null;
  }
}

export function classifyNodeSource(sourceText: string): ClassifiedNodeSource {
  if (sourceText.startsWith('asset:')) {
    const assetId = parseAssetSourceUri(sourceText);
    if (!assetId) return invalidSource(sourceText, 'malformed-uri');
    return {
      sourceText,
      normalizedUri: formatAssetSourceUri(assetId),
      kind: 'file',
      label: assetId,
      availability: 'ready',
      actions: ['copy-uri', 'edit', 'preview', 'open', 'reveal', 'replace', 'remove'],
    };
  }

  let url: URL;
  try {
    url = new URL(sourceText);
  } catch {
    return invalidSource(sourceText, 'malformed-uri');
  }

  if (url.protocol === 'http:' || url.protocol === 'https:') {
    const normalizedUri = url.toString();
    return {
      sourceText,
      normalizedUri,
      kind: kindFromPath(url.pathname, 'web'),
      label: remoteLabel(url),
      availability: 'ready',
      actions: ['copy-uri', 'edit', 'preview', 'open', 'retry', 'replace', 'remove'],
    };
  }

  if (url.protocol === 'file:') {
    if (url.username || url.password || url.port || (url.hostname && url.hostname !== 'localhost')) {
      return invalidSource(sourceText, 'malformed-uri');
    }
    const label = decodedLastPathSegment(url.pathname) || url.pathname || sourceText;
    return {
      sourceText,
      normalizedUri: url.toString(),
      kind: kindFromPath(url.pathname, 'file'),
      label,
      availability: 'denied',
      reason: 'file-access-denied',
      actions: ['copy-uri', 'edit', 'authorize', 'replace', 'remove'],
    };
  }

  return {
    sourceText,
    normalizedUri: url.toString(),
    label: url.hostname || sourceText,
    availability: 'unsupported',
    reason: 'unsupported-scheme',
    actions: ['copy-uri', 'edit', 'open', 'replace', 'remove'],
  };
}

export function sourceKindFromMetadata(
  mimeType: string | null | undefined,
  filename?: string | null,
): SourceKind {
  const normalized = mimeType?.trim().toLowerCase() ?? '';
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('video/')) return 'video';
  if (normalized.startsWith('text/')
    || normalized === 'application/pdf'
    || normalized.includes('document')
    || normalized.includes('spreadsheet')
    || normalized.includes('presentation')
    || normalized === 'application/epub+zip') return 'document';
  return filename ? kindFromPath(filename, 'file') : 'file';
}

function invalidSource(sourceText: string, reason: SourceResolutionReason): ClassifiedNodeSource {
  return {
    sourceText,
    label: sourceText || 'Invalid Source',
    availability: 'invalid',
    reason,
    actions: ['copy-uri', 'edit', 'replace', 'remove'],
  };
}

function kindFromPath(pathname: string, fallback: SourceKind): SourceKind {
  const segment = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = segment.lastIndexOf('.');
  const extension = dot >= 0 ? segment.slice(dot + 1).toLowerCase() : '';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return fallback;
}

function remoteLabel(url: URL): string {
  return decodedLastPathSegment(url.pathname) || url.hostname || url.toString();
}

function decodedLastPathSegment(pathname: string): string {
  const value = pathname.split('/').filter(Boolean).at(-1) ?? '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
