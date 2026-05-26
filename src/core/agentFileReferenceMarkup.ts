export interface FileReferenceSegment {
  type: 'file';
  raw: string;
  ref: string;
}

export type FileReferenceTextSegment =
  | { type: 'text'; text: string }
  | FileReferenceSegment;

const FILE_REFERENCE_PATTERN = /\[\[file:([^\]\n]+)\]\]/gu;

export function formatFileReferenceMarker(ref: string): string {
  return `[[file:${sanitizeFileReferenceRef(ref)}]]`;
}

export function sanitizeFileReferenceRef(ref: string): string {
  return ref
    .replace(/[\r\n[\]]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim() || 'attachment';
}

export function splitFileReferenceMarkers(text: string): FileReferenceTextSegment[] {
  const segments: FileReferenceTextSegment[] = [];
  let cursor = 0;
  FILE_REFERENCE_PATTERN.lastIndex = 0;

  for (const match of text.matchAll(FILE_REFERENCE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ type: 'text', text: text.slice(cursor, index) });
    const raw = match[0] ?? '';
    segments.push({
      type: 'file',
      raw,
      ref: sanitizeFileReferenceRef(match[1] ?? ''),
    });
    cursor = index + raw.length;
  }

  if (cursor < text.length) segments.push({ type: 'text', text: text.slice(cursor) });
  return segments.length > 0 ? segments : [{ type: 'text', text }];
}
