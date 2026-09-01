import { parseFileReferenceUri } from '../../../core/referenceMarkup';
import type { AgentFinalCitationStatus, ThreadResourceReference } from '../../../core/agent/protocol';

export interface InlineFilePreviewDescriptor {
  attachmentId?: string;
  entryKind?: 'file' | 'directory';
  iconDataUrl?: string;
  lastModified?: number;
  mimeType?: string;
  name?: string;
  path?: string;
  ref?: string;
  resourceRef?: ThreadResourceReference;
  resourceIntent?: 'delivered' | 'source';
  citationStatus?: AgentFinalCitationStatus;
  sourceAvailable?: boolean;
  sizeBytes?: number;
  thumbnailDataUrl?: string;
  threadId?: string;
}

export function inlineFilePreviewAttrs(file: InlineFilePreviewDescriptor): Record<string, string> {
  const attrs: Record<string, string> = {
    'data-inline-ref-kind': 'local-file',
  };
  setAttr(attrs, 'data-inline-ref-path', file.path);
  setAttr(attrs, 'data-inline-ref-entry-kind', file.entryKind);
  setAttr(attrs, 'data-inline-ref-name', file.name);
  setAttr(attrs, 'data-inline-ref-ref', file.ref);
  setAttr(attrs, 'data-inline-ref-mime-type', file.mimeType);
  setFiniteNumberAttr(attrs, 'data-inline-ref-size-bytes', file.sizeBytes);
  setFiniteNumberAttr(attrs, 'data-inline-ref-last-modified', file.lastModified);
  setAttr(attrs, 'data-inline-ref-icon-data-url', file.iconDataUrl);
  setAttr(attrs, 'data-inline-ref-thumbnail-data-url', file.thumbnailDataUrl);
  setAttr(attrs, 'data-inline-ref-thread-id', file.threadId);
  setAttr(attrs, 'data-inline-ref-attachment-id', file.attachmentId);
  setAttr(attrs, 'data-inline-ref-resource-id', file.resourceRef?.id);
  setAttr(attrs, 'data-inline-ref-resource-mime-type', file.resourceRef?.mimeType);
  setFiniteNumberAttr(attrs, 'data-inline-ref-resource-byte-length', file.resourceRef?.byteLength);
  setAttr(attrs, 'data-inline-ref-resource-file-name', file.resourceRef?.fileName);
  setAttr(attrs, 'data-inline-ref-resource-intent', file.resourceIntent);
  setAttr(attrs, 'data-inline-ref-citation-status', file.citationStatus);
  if (file.sourceAvailable !== undefined) {
    attrs['data-inline-ref-source-available'] = String(file.sourceAvailable);
  }
  return attrs;
}

export const LOCAL_FILE_REFERENCE_LINK_PREFIX = 'lin-file:';

export function localFileReferenceHref(
  path: string,
  entryKind: 'file' | 'directory' = 'file',
  markerOrdinal?: number,
): string {
  const suffix = markerOrdinal === undefined ? '' : `:${markerOrdinal}`;
  return `#${LOCAL_FILE_REFERENCE_LINK_PREFIX}${encodeURIComponent(entryKind)}:${encodeURIComponent(path)}${suffix}`;
}

export function localFileReferenceFromHref(
  href: string | undefined,
): { entryKind: 'file' | 'directory'; path: string; markerOrdinal?: number } | null {
  const normalizedHref = href?.startsWith('#') ? href.slice(1) : href;
  const fileReferenceUrl = parseFileReferenceUri(normalizedHref);
  if (fileReferenceUrl) {
    return { entryKind: fileReferenceUrl.entryKind, path: fileReferenceUrl.path };
  }
  if (!normalizedHref?.startsWith(LOCAL_FILE_REFERENCE_LINK_PREFIX)) return null;
  const body = normalizedHref.slice(LOCAL_FILE_REFERENCE_LINK_PREFIX.length);
  const separator = body.indexOf(':');
  if (separator < 0) return null;
  const rawEntryKind = body.slice(0, separator);
  const rawBody = body.slice(separator + 1);
  const ordinalSeparator = rawBody.lastIndexOf(':');
  const rawOrdinal = ordinalSeparator >= 0 ? rawBody.slice(ordinalSeparator + 1) : '';
  const hasOrdinal = /^\d+$/u.test(rawOrdinal);
  const rawPath = hasOrdinal ? rawBody.slice(0, ordinalSeparator) : rawBody;
  try {
    const entryKind = decodeURIComponent(rawEntryKind) === 'directory' ? 'directory' : 'file';
    const path = decodeURIComponent(rawPath);
    return path ? {
      entryKind,
      path,
      ...(hasOrdinal ? { markerOrdinal: Number(rawOrdinal) } : {}),
    } : null;
  } catch {
    return null;
  }
}

function setAttr(attrs: Record<string, string>, name: string, value: string | undefined): void {
  if (typeof value === 'string' && value.length > 0) attrs[name] = value;
}

function setFiniteNumberAttr(attrs: Record<string, string>, name: string, value: number | undefined): void {
  if (typeof value === 'number' && Number.isFinite(value)) attrs[name] = String(value);
}
