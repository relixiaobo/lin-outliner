import { describe, expect, test } from 'bun:test';
import type { ToolCall } from '../../src/core/agentTypes';
import { getToolIcon, summarizeToolCall } from '../../src/renderer/ui/agent/AgentToolCallBlock';
import { BrainIcon, FileTextIcon, RecentsIcon, SearchIcon } from '../../src/renderer/ui/icons';
import { getMessages } from '../../src/core/i18n';

const labels = getMessages('en').agent.toolCall;

function pastChatsToolCall(args: Record<string, unknown>): ToolCall {
  return {
    type: 'toolCall',
    id: 'tool-past-chats',
    name: 'past_chats',
    arguments: args,
  };
}

function memoryToolCall(args: Record<string, unknown>): ToolCall {
  return {
    type: 'toolCall',
    id: 'tool-memory',
    name: 'memory',
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
    expect(summarizeToolCall(pastChatsToolCall({ recent: true }), 'done', labels)).toBe('Listed recent past chat messages');
    expect(summarizeToolCall(pastChatsToolCall({ query: 'basketball' }), 'pending', labels)).toBe('Searching past chats "basketball"');
    expect(summarizeToolCall(pastChatsToolCall({ message_id: 'user-1' }), 'done', labels)).toBe('Read past chat "user-1"');
    expect(summarizeToolCall(pastChatsToolCall({ query: 'basketball' }), 'error', labels)).toBe('Failed to search past chats "basketball"');
  });

  test('uses memory icon and summarizes memory actions', () => {
    expect(getToolIcon(memoryToolCall({ action: 'remember', fact: 'Use direct answers' }))).toBe(BrainIcon);
    expect(summarizeToolCall(memoryToolCall({ action: 'list', query: 'preferences' }), 'pending', labels)).toBe('Listing memory "preferences"');
    expect(summarizeToolCall(memoryToolCall({ action: 'remember', fact: 'Use direct answers' }), 'done', labels)).toBe('Remembered fact "Use direct answers"');
    expect(summarizeToolCall(memoryToolCall({ action: 'forget', memory_id: 'memory-1' }), 'error', labels)).toBe('Failed to forget memory "memory-1"');
  });
});
