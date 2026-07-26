import type { ThreadUserContent, Turn } from '../../core/agent/protocol';

export function turnUserContent(turn: Turn): ThreadUserContent[] {
  return turn.items
    .filter((item) => item.type === 'userMessage')
    .flatMap((item) => item.content);
}

export function canEditUserContentText(content: readonly ThreadUserContent[]): boolean {
  let textParts = 0;
  for (const part of content) {
    if (part.type === 'text') textParts += 1;
    if (textParts > 1) return false;
  }
  return true;
}

export function replaceUserContentText(
  content: readonly ThreadUserContent[],
  textInput: string,
): ThreadUserContent[] {
  if (!canEditUserContentText(content)) {
    throw new Error('Cannot replace text in user content with multiple text parts.');
  }
  const text = textInput.trim();
  const firstTextIndex = content.findIndex((part) => part.type === 'text');
  if (!text) return content.filter((part) => part.type !== 'text');
  if (firstTextIndex < 0) return [{ type: 'text', text }, ...content];
  return content.map((part) => part.type === 'text' ? { type: 'text', text } : part);
}
