import { describe, expect, test } from 'bun:test';
import type { ToolCall } from '../../src/core/agentTypes';
import { getToolIcon, summarizeToolCall } from '../../src/renderer/ui/agent/AgentToolCallBlock';
import { FileTextIcon, RecentsIcon, SearchIcon } from '../../src/renderer/ui/icons';

function pastChatsToolCall(args: Record<string, unknown>): ToolCall {
  return {
    type: 'toolCall',
    id: 'tool-past-chats',
    name: 'past_chats',
    arguments: args,
  };
}

describe('agent tool call block', () => {
  test('uses mode-specific icons for past_chats', () => {
    expect(getToolIcon(pastChatsToolCall({ recent: true }))).toBe(RecentsIcon);
    expect(getToolIcon(pastChatsToolCall({ query: 'basketball' }))).toBe(SearchIcon);
    expect(getToolIcon(pastChatsToolCall({ message_id: 'user-1' }))).toBe(FileTextIcon);
  });

  test('summarizes past_chats by mode', () => {
    expect(summarizeToolCall(pastChatsToolCall({ recent: true }), 'done')).toBe('Listed recent past chat messages');
    expect(summarizeToolCall(pastChatsToolCall({ query: 'basketball' }), 'pending')).toBe('Searching past chats "basketball"');
    expect(summarizeToolCall(pastChatsToolCall({ message_id: 'user-1' }), 'done')).toBe('Read past chat "user-1"');
    expect(summarizeToolCall(pastChatsToolCall({ query: 'basketball' }), 'error')).toBe('Failed to search past chats "basketball"');
  });
});
