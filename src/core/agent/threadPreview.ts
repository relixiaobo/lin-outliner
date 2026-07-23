import type { ThreadUserContent } from './protocol';

const MAX_THREAD_PREVIEW_LENGTH = 200;

export function threadPreviewFromContent(content: readonly ThreadUserContent[]): string {
  const text = content.find((part) => part.type === 'text' && part.text.trim());
  if (text?.type === 'text') return boundedPreview(text.text);
  const attachment = content.find((part) => part.type === 'attachment' && part.name.trim());
  if (attachment?.type === 'attachment') return boundedPreview(attachment.name);
  const reference = content.find((part) => part.type === 'nodeReference' && part.note?.trim());
  return reference?.type === 'nodeReference' ? boundedPreview(reference.note ?? '') : '';
}

function boundedPreview(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > MAX_THREAD_PREVIEW_LENGTH
    ? `${normalized.slice(0, MAX_THREAD_PREVIEW_LENGTH - 3).trimEnd()}...`
    : normalized;
}
