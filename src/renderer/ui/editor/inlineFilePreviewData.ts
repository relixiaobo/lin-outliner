import { parseLocalFileReferenceUrl } from '../../../core/referenceMarkup';

export interface InlineFilePreviewDescriptor {
  entryKind?: 'file' | 'directory';
  iconDataUrl?: string;
  lastModified?: number;
  mimeType?: string;
  name?: string;
  path?: string;
  ref?: string;
  sizeBytes?: number;
  thumbnailDataUrl?: string;
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
  return attrs;
}

export const LOCAL_FILE_REFERENCE_LINK_PREFIX = 'lin-file:';

export function localFileReferenceHref(path: string, entryKind: 'file' | 'directory' = 'file'): string {
  return `#${LOCAL_FILE_REFERENCE_LINK_PREFIX}${encodeURIComponent(entryKind)}:${encodeURIComponent(path)}`;
}

export function localFileReferenceFromHref(
  href: string | undefined,
): { entryKind: 'file' | 'directory'; path: string } | null {
  const normalizedHref = href?.startsWith('#') ? href.slice(1) : href;
  const fileReferenceUrl = parseLocalFileReferenceUrl(normalizedHref);
  if (fileReferenceUrl) return fileReferenceUrl;
  if (!normalizedHref?.startsWith(LOCAL_FILE_REFERENCE_LINK_PREFIX)) return null;
  const body = normalizedHref.slice(LOCAL_FILE_REFERENCE_LINK_PREFIX.length);
  const separator = body.indexOf(':');
  if (separator < 0) return null;
  const rawEntryKind = body.slice(0, separator);
  const rawPath = body.slice(separator + 1);
  try {
    const entryKind = decodeURIComponent(rawEntryKind) === 'directory' ? 'directory' : 'file';
    const path = decodeURIComponent(rawPath);
    return path ? { entryKind, path } : null;
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
