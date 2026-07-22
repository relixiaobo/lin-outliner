import type { ThreadUserContent, Turn } from '../../core/agent/protocol';

export function turnUserContent(turn: Turn): ThreadUserContent[] {
  return turn.items
    .filter((item) => item.type === 'userMessage')
    .flatMap((item) => item.content);
}

export function replaceUserContentText(
  content: readonly ThreadUserContent[],
  textInput: string,
): ThreadUserContent[] {
  const text = textInput.trim();
  const firstTextIndex = content.findIndex((part) => part.type === 'text');
  const preserved = content.filter((part, index) => part.type !== 'text' || index === firstTextIndex);
  if (!text) return preserved.filter((part) => part.type !== 'text');
  if (firstTextIndex < 0) return [{ type: 'text', text }, ...preserved];
  return preserved.map((part) => part.type === 'text' ? { type: 'text', text } : part);
}
