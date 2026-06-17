import { nodeReferenceMarkersToText } from './referenceMarkup';

export function sanitizeConversationTitle(title: string | null | undefined): string | null {
  const normalized = nodeReferenceMarkersToText(title ?? '').replace(/\s+/g, ' ').trim();
  return normalized || null;
}

export function normalizeConversationTitle(title: string): string {
  return sanitizeConversationTitle(title) ?? 'Untitled';
}
