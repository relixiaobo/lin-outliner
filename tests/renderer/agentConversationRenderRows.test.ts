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
  text?: string;
  timestamp?: number;
  runId?: string | null;
  runDurationMs?: number | null;
}): AgentMessageEntry {
  return {
    id: opts.id,
    kind: 'message',
    nodeId: opts.id,
    message: assistantMessage(opts.text ?? `reply ${opts.id}`, opts.timestamp ?? 1),
    branches: null,
    streaming: false,
    actor: opts.agentId ? { type: 'agent', agentId: opts.agentId } : null,
    runId: opts.runId !== undefined ? opts.runId : (opts.agentId ? `run-${opts.agentId}` : null),
    runDurationMs: opts.runDurationMs ?? null,
  };
}

function mergedAssistantRunDurationMs(rows: ReturnType<typeof buildConversationRenderRows>): number | null {
  const assistantRows = rows.filter((row) => row.entry.kind === 'message'
    && (row.entry as AgentMessageEntry).message.role === 'assistant');
  expect(assistantRows).toHaveLength(1);
  return (assistantRows[0]!.entry as AgentMessageEntry).runDurationMs;
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
  };
}

describe('buildConversationRenderRows — isLastInTurn', () => {
  test('back-to-back Channel turns from different agents each end their own turn', () => {
    const rows = buildConversationRenderRows(
      [
        userEntry('user-1', 0),
        assistantEntry({ id: 'a-alpha', agentId: 'alpha' }),
        assistantEntry({ id: 'a-beta', agentId: 'beta' }),
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
        assistantEntry({ id: 'a1', agentId: 'alpha' }),
        assistantEntry({ id: 'a2', agentId: 'alpha' }),
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
        assistantEntry({ id: 'a-alpha', agentId: 'alpha' }),
        assistantEntry({ id: 'a-beta', agentId: 'beta' }),
      ],
      'idle',
    );
    expect(rows[0]!.isLastInTurn).toBe(true);
    expect(rows[1]!.isLastInTurn).toBe(true);
  });

  test('an assistant turn before a user message ends its turn', () => {
    const rows = buildConversationRenderRows(
      [
        assistantEntry({ id: 'a1', agentId: 'alpha' }),
        userEntry('user-2', 5),
      ],
      'idle',
    );
    expect(rows[0]!.isLastInTurn).toBe(true);
  });
});

describe('buildConversationRenderRows — merged turn duration', () => {
  test('a multi-run turn sums each distinct run wall-clock for the merged "Worked for"', () => {
    // Reactive-compaction retry: run-1 overflows (partial), run-2 produces the
    // answer. Both merge into one row, so its runDurationMs must be run-1 + run-2
    // — spreading only the last entry would silently drop run-1's time.
    const rows = buildConversationRenderRows(
      [
        userEntry('user-1', 0),
        assistantEntry({ id: 'a1', agentId: 'alpha', runId: 'run-1', runDurationMs: 4000 }),
        assistantEntry({ id: 'a2', agentId: 'alpha', runId: 'run-2', runDurationMs: 8000 }),
      ],
      'idle',
    );
    expect(mergedAssistantRunDurationMs(rows)).toBe(12_000);
  });

  test('a single-run turn (two entries, one runId) counts that run once', () => {
    const rows = buildConversationRenderRows(
      [
        userEntry('user-1', 0),
        assistantEntry({ id: 'a1', agentId: 'alpha', runId: 'run-1', runDurationMs: 5000 }),
        assistantEntry({ id: 'a2', agentId: 'alpha', runId: 'run-1', runDurationMs: 5000 }),
      ],
      'idle',
    );
    expect(mergedAssistantRunDurationMs(rows)).toBe(5000);
  });

  test('a merged turn whose runs have no sealed duration yet stays null', () => {
    // Both runs still running (the projection leaves runDurationMs undefined →
    // null on the entry); the merged row reports null, not 0.
    const rows = buildConversationRenderRows(
      [
        userEntry('user-1', 0),
        assistantEntry({ id: 'a1', agentId: 'alpha', runId: 'run-1', runDurationMs: null }),
        assistantEntry({ id: 'a2', agentId: 'alpha', runId: 'run-2', runDurationMs: null }),
      ],
      'idle',
    );
    expect(mergedAssistantRunDurationMs(rows)).toBe(null);
  });
});
