// Shared XML escaping for the hidden reminder/briefing blocks the runtime injects. These
// blocks are pseudo-XML the model reads (not a strict parser target), so we escape the
// structural characters that could break a tag boundary while leaving prose readable.
// Apostrophes are intentionally left untouched — they are common in prose and need no
// escaping inside double-quoted attributes or element text.
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Serialize a leading `<tag<attrs> ...` attribute string for the reminder blocks.
// Null / undefined / empty values are dropped; the rest are escaped. Newlines are
// collapsed so a stray line break in a value can never break the single-line tag.
export function xmlAttrs(attrs: Record<string, string | null | undefined>): string {
  const serialized = Object.entries(attrs)
    .filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== undefined && entry[1] !== '')
    .map(([key, value]) => `${key}="${escapeXml(value.replace(/\s+/g, ' '))}"`);
  return serialized.length ? ` ${serialized.join(' ')}` : '';
}
