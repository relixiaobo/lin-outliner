import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, UserMessage, Usage } from '../../src/core/agentTypes';
import type { AgentMessageEntry } from '../../src/renderer/agent/runtime';
import { buildConversationRenderRows } from '../../src/renderer/ui/agent/agentConversationRows';

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(text: string, timestamp: number): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp,
  };
}

function userMessage(text: string, timestamp: number): UserMessage {
  return { role: 'user', content: text, timestamp };
}

function assistantEntry(opts: {
  id: string;
  agentId: string | null;
  addressedByMessageId?: string | null;
  text?: string;
  timestamp?: number;
}): AgentMessageEntry {
  return {
    id: opts.id,
    kind: 'message',
    nodeId: opts.id,
    message: assistantMessage(opts.text ?? `reply ${opts.id}`, opts.timestamp ?? 1),
    branches: null,
    streaming: false,
    actor: opts.agentId ? { type: 'agent', agentId: opts.agentId } : null,
    runId: opts.agentId ? `run-${opts.agentId}` : null,
    runDurationMs: null,
    addressedByMessageId: opts.addressedByMessageId ?? null,
  };
}

function userEntry(id: string, timestamp: number): AgentMessageEntry {
  return {
    id,
    kind: 'message',
    nodeId: id,
    message: userMessage(`ask ${id}`, timestamp),
    branches: null,
    streaming: false,
    actor: { type: 'user', userId: 'user-1' },
    runId: null,
    runDurationMs: null,
    addressedByMessageId: null,
  };
}

describe('buildConversationRenderRows — isLastInTurn', () => {
  test('back-to-back Channel turns from different agents each end their own turn', () => {
    const rows = buildConversationRenderRows(
      [
        userEntry('user-1', 0),
        assistantEntry({ id: 'a-alpha', agentId: 'alpha', addressedByMessageId: 'user-1' }),
        assistantEntry({ id: 'a-beta', agentId: 'beta', addressedByMessageId: 'user-1' }),
      ],
      'idle',
    );

    // One row per agent (the same-actor merge does not cross the agent seam) and
    // each is the last in its own turn, so each gets its own action bar.
    const assistantRows = rows.filter((row) => row.entry.kind === 'message'
      && (row.entry as AgentMessageEntry).message.role === 'assistant');
    expect(assistantRows).toHaveLength(2);
    expect(assistantRows.every((row) => row.isLastInTurn)).toBe(true);
  });

  test('same-agent consecutive turns merge into one last-in-turn row', () => {
    const rows = buildConversationRenderRows(
      [
        userEntry('user-1', 0),
        assistantEntry({ id: 'a1', agentId: 'alpha', addressedByMessageId: 'user-1' }),
        assistantEntry({ id: 'a2', agentId: 'alpha', addressedByMessageId: 'user-1' }),
      ],
      'idle',
    );

    const assistantRows = rows.filter((row) => row.entry.kind === 'message'
      && (row.entry as AgentMessageEntry).message.role === 'assistant');
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]!.isLastInTurn).toBe(true);
  });

  test('an assistant turn followed by a different agent is still last-in-turn', () => {
    // Regression: previously the first agent's turn was denied its action bar
    // because the next entry was also `assistant` (a different agent's reply).
    const rows = buildConversationRenderRows(
      [
        assistantEntry({ id: 'a-alpha', agentId: 'alpha', addressedByMessageId: 'user-1' }),
        assistantEntry({ id: 'a-beta', agentId: 'beta', addressedByMessageId: 'user-1' }),
      ],
      'idle',
    );
    expect(rows[0]!.isLastInTurn).toBe(true);
    expect(rows[1]!.isLastInTurn).toBe(true);
  });

  test('an assistant turn before a user message ends its turn', () => {
    const rows = buildConversationRenderRows(
      [
        assistantEntry({ id: 'a1', agentId: 'alpha', addressedByMessageId: 'user-1' }),
        userEntry('user-2', 5),
      ],
      'idle',
    );
    expect(rows[0]!.isLastInTurn).toBe(true);
  });
});
