import { describe, expect, test } from 'bun:test';
import {
  appendAgentChatMessage,
  createAgentChatSession,
  editAgentChatUserMessage,
  getAgentChatBranches,
  getAgentChatLinearPath,
  getAgentChatMessages,
  regenerateAgentChatMessage,
  switchAgentChatBranch,
  syncAgentMessagesToChatTree,
} from '../../src/core/agentChatTree';
import type { AgentMessage, AssistantMessage, UserMessage } from '../../src/core/agentTypes';

function user(text: string): UserMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  };
}

function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function textOf(message: AgentMessage) {
  if (message.role === 'toolResult') return '';
  const first = Array.isArray(message.content) ? message.content[0] : null;
  return first?.type === 'text' ? first.text : '';
}

describe('agent chat tree', () => {
  test('editing a user message creates a sibling branch without destroying the old path', () => {
    const session = createAgentChatSession('chat-test');
    const firstUser = appendAgentChatMessage(session, user('first'));
    appendAgentChatMessage(session, assistant('old answer'));

    const editedUser = editAgentChatUserMessage(session, firstUser.id, [{ type: 'text', text: 'edited' }]);
    syncAgentMessagesToChatTree(session, [
      ...getAgentChatMessages(session),
      assistant('new answer'),
    ]);

    expect(getAgentChatMessages(session).map(textOf)).toEqual(['edited', 'new answer']);
    expect(getAgentChatBranches(session, editedUser.id)).toEqual([firstUser.id, editedUser.id]);

    switchAgentChatBranch(session, firstUser.id);
    expect(getAgentChatMessages(session).map(textOf)).toEqual(['first', 'old answer']);
  });

  test('regenerating an assistant message leaves the active path ready to continue', () => {
    const session = createAgentChatSession('chat-test');
    appendAgentChatMessage(session, user('question'));
    const firstAnswer = appendAgentChatMessage(session, assistant('first answer'));

    const placeholder = regenerateAgentChatMessage(session, firstAnswer.id);
    expect(placeholder.message).toBeNull();
    expect(getAgentChatMessages(session).map(textOf)).toEqual(['question']);

    syncAgentMessagesToChatTree(session, [
      ...getAgentChatMessages(session),
      assistant('second answer'),
    ]);

    expect(getAgentChatMessages(session).map(textOf)).toEqual(['question', 'second answer']);
    const activePath = getAgentChatLinearPath(session);
    expect(activePath.at(-1)?.message && textOf(activePath.at(-1)!.message!)).toBe('second answer');
    expect(getAgentChatBranches(session, activePath.at(-1)!.id)).toEqual([firstAnswer.id, placeholder.id]);
  });
});
