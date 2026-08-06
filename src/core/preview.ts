import { decodeThreadImageArtifactReference } from './agent/codec';
import type { ThreadImageArtifactReference, ThreadResourceReference } from './agent/protocol';
import { MAX_MANAGED_ATTACHMENT_BYTES } from './agentAttachmentLimits';
import { safeAttachmentFileName } from './agentAttachmentPaths';

export type PreviewEntryKind = 'file' | 'directory';
export type PreviewSourceKind = 'local-file' | 'asset';

export type PreviewTarget =
  | {
      kind: 'local-file';
      path: string;
      entryKind: PreviewEntryKind;
      label?: string;
      threadId?: string;
      attachmentId?: string;
      resourceRef?: ThreadResourceReference;
      imageArtifactRef?: ThreadImageArtifactReference;
    }
  | {
      kind: 'asset';
      assetId: string;
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
      if (target.threadId && target.attachmentId) {
        return `local-file:thread-attachment:${target.threadId}:${target.attachmentId}:${target.entryKind}:${target.path}`;
      }
      if (target.threadId && target.resourceRef) {
        const ref = target.resourceRef;
        return `local-file:thread-resource:${target.threadId}:${ref.id}:${ref.mimeType}:${ref.byteLength}:${ref.fileName}`;
      }
      if (target.threadId && target.imageArtifactRef) {
        return `local-file:thread-image-artifact:${target.threadId}:${target.imageArtifactRef.id}`;
      }
      return `local-file:${target.entryKind}:${target.path}`;
    case 'asset':
      return `asset:${target.assetId}`;
    case 'url':
      return `url:${target.url}`;
  }
}

export function previewTargetFromUnknown(value: unknown): PreviewTarget | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  const label = typeof value.label === 'string' && value.label.trim() ? value.label : undefined;
  if (value.kind === 'local-file') {
    if (typeof value.path !== 'string' || !value.path) return null;
    const threadId = typeof value.threadId === 'string' && value.threadId.trim() ? value.threadId : undefined;
    const attachmentId = typeof value.attachmentId === 'string' && value.attachmentId.trim()
      ? value.attachmentId
      : undefined;
    let resourceRef: ThreadResourceReference | undefined;
    if (value.resourceRef !== undefined) {
      resourceRef = threadResourceReferenceFromUnknown(value.resourceRef) ?? undefined;
      if (!resourceRef) return null;
    }
    let imageArtifactRef: ThreadImageArtifactReference | undefined;
    if (value.imageArtifactRef !== undefined) {
      try {
        imageArtifactRef = decodeThreadImageArtifactReference(value.imageArtifactRef, 'previewTarget.imageArtifactRef');
      } catch {
        return null;
      }
    }
    const scopedIdentityCount = Number(Boolean(attachmentId))
      + Number(Boolean(resourceRef))
      + Number(Boolean(imageArtifactRef));
    if (threadId ? scopedIdentityCount !== 1 : scopedIdentityCount !== 0) return null;
    return {
      kind: 'local-file',
      path: value.path,
      entryKind: value.entryKind === 'directory' ? 'directory' : 'file',
      ...(label ? { label } : {}),
      ...(threadId && attachmentId ? { threadId, attachmentId } : {}),
      ...(threadId && resourceRef ? { threadId, resourceRef } : {}),
      ...(threadId && imageArtifactRef ? { threadId, imageArtifactRef } : {}),
    };
  }
  if (value.kind === 'asset') {
    if (typeof value.assetId !== 'string' || !value.assetId) return null;
    return { kind: 'asset', assetId: value.assetId, ...(label ? { label } : {}) };
  }
  if (value.kind === 'url') {
    if (typeof value.url !== 'string' || !value.url) return null;
    return { kind: 'url', url: value.url, ...(label ? { label } : {}) };
  }
  return null;
}

function threadResourceReferenceFromUnknown(value: unknown): ThreadResourceReference | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 4 || keys.some((key) => !['id', 'mimeType', 'byteLength', 'fileName'].includes(key))) {
    return null;
  }
  if (typeof value.id !== 'string' || !/^[a-f0-9]{64}$/u.test(value.id)) return null;
  if (typeof value.mimeType !== 'string' || !value.mimeType.trim()) return null;
  if (!Number.isSafeInteger(value.byteLength)
    || (value.byteLength as number) < 0
    || (value.byteLength as number) > MAX_MANAGED_ATTACHMENT_BYTES) return null;
  if (typeof value.fileName !== 'string' || safeAttachmentFileName(value.fileName) !== value.fileName) return null;
  return {
    id: value.id,
    mimeType: value.mimeType,
    byteLength: value.byteLength as number,
    fileName: value.fileName,
  };
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
