export type PreviewEntryKind = 'file' | 'directory';
export type PreviewSourceKind = 'local-file' | 'asset' | 'agent-payload';

export type PreviewTarget =
  | {
      kind: 'local-file';
      path: string;
      entryKind: PreviewEntryKind;
      label?: string;
    }
  | {
      kind: 'asset';
      assetId: string;
      label?: string;
    }
  | {
      kind: 'agent-payload';
      conversationId: string;
      runId?: string;
      payloadId: string;
      label?: string;
    }
  | {
      kind: 'url';
      url: string;
      label?: string;
    };

export interface PreviewFileSource {
  kind: 'file';
  sourceKind: PreviewSourceKind;
  id: string;
  target: PreviewTarget;
  name: string;
  ext: string;
  mimeType: string;
  entryKind: PreviewEntryKind;
  sizeBytes: number;
  lastModified?: number;
  displayPath?: string;
  streamUrl?: string;
  iconDataUrl?: string;
  thumbnailDataUrl?: string;
}

export interface PreviewUrlSource {
  kind: 'url';
  id: string;
  target: Extract<PreviewTarget, { kind: 'url' }>;
  url: string;
  title: string;
}

export type PreviewSourceDescriptor = PreviewFileSource | PreviewUrlSource;

export interface PreviewDirectoryEntry {
  entryKind: PreviewEntryKind;
  name: string;
  target: PreviewTarget;
  mimeType: string;
  sizeBytes: number;
  lastModified?: number;
}

export interface PreviewResolveSourceResult {
  source: PreviewSourceDescriptor | null;
  error?: string;
}

export interface PreviewReadTextResult {
  text: string | null;
  truncated?: boolean;
  error?: string;
}

export interface PreviewReadBytesResult {
  bytes: ArrayBuffer | null;
  mimeType?: string;
  error?: string;
}

export interface PreviewListDirectoryResult {
  entries: PreviewDirectoryEntry[] | null;
  truncated?: boolean;
  error?: string;
}

export function previewTargetKey(target: PreviewTarget): string {
  switch (target.kind) {
    case 'local-file':
      return `local-file:${target.entryKind}:${target.path}`;
    case 'asset':
      return `asset:${target.assetId}`;
    case 'agent-payload':
      return `agent-payload:${target.conversationId}:${target.runId ?? ''}:${target.payloadId}`;
    case 'url':
      return `url:${target.url}`;
  }
}

export function previewTargetFromUnknown(value: unknown): PreviewTarget | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  const label = typeof value.label === 'string' && value.label.trim() ? value.label : undefined;
  if (value.kind === 'local-file') {
    if (typeof value.path !== 'string' || !value.path) return null;
    return {
      kind: 'local-file',
      path: value.path,
      entryKind: value.entryKind === 'directory' ? 'directory' : 'file',
      ...(label ? { label } : {}),
    };
  }
  if (value.kind === 'asset') {
    if (typeof value.assetId !== 'string' || !value.assetId) return null;
    return { kind: 'asset', assetId: value.assetId, ...(label ? { label } : {}) };
  }
  if (value.kind === 'agent-payload') {
    if (typeof value.conversationId !== 'string' || !value.conversationId) return null;
    if (typeof value.payloadId !== 'string' || !value.payloadId) return null;
    return {
      kind: 'agent-payload',
      conversationId: value.conversationId,
      ...(typeof value.runId === 'string' && value.runId ? { runId: value.runId } : {}),
      payloadId: value.payloadId,
      ...(label ? { label } : {}),
    };
  }
  if (value.kind === 'url') {
    if (typeof value.url !== 'string' || !value.url) return null;
    return { kind: 'url', url: value.url, ...(label ? { label } : {}) };
  }
  return null;
}

export function normalizePreviewHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
