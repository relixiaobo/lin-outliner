import { isHiddenAgentContextBlock } from '../../../core/agentAttachments';
import type { AgentMessageEntry } from '../../agent/runtime';

export function systemLineText(entry: AgentMessageEntry): string | null {
  if (entry.actor?.type !== 'system') return null;
  const text = textFromConversationEntry(entry).trim();
  return text || null;
}

function textFromConversationEntry(entry: AgentMessageEntry): string {
  const { content } = entry.message;
  if (typeof content === 'string') return isHiddenAgentContextBlock(content) ? '' : content;
  return content
    .flatMap((block) => {
      const part = block as {
        type: string;
        text?: string;
        thinking?: string;
        name?: string;
        alt?: string;
        label?: string;
        payload?: { summary?: string };
      };
      if (part.type === 'text') {
        const text = part.text ?? '';
        return isHiddenAgentContextBlock(text) ? [] : [text];
      }
      if (part.type === 'thinking') return [part.thinking ?? ''];
      if (part.type === 'toolCall') return [`[tool:${part.name ?? 'unknown'}]`];
      if (part.type === 'image') return [part.alt ?? ''];
      if (part.type === 'payload_ref') return [part.label || part.payload?.summary || ''];
      return [];
    })
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
