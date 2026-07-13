import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, UserMessage, Usage } from '../../src/core/agentTypes';
import type { AgentConversationEntry, AgentMessageEntry } from '../../src/renderer/agent/runtime';
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
  sourceSeq?: number;
  sourceSeqs?: number[];
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
    sourceSeq: opts.sourceSeq,
    sourceSeqs: opts.sourceSeqs,
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

function hiddenTurnBoundaryEntry(id: string, timestamp = 2, sourceSeq?: number): AgentConversationEntry {
  return {
    id,
    kind: 'hidden-turn-boundary',
    timestamp,
    sourceSeq,
  };
}

function issueNotificationEntry(id: string, timestamp = 2): AgentConversationEntry {
  return {
    id,
    kind: 'issue-notification',
    notificationId: id,
    issueId: 'issue-1',
    state: 'complete',
    title: 'Compile the report',
    timestamp,
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

  test('hidden system reminders split same-agent assistant turns with an empty rhythm boundary', () => {
    const rows = buildConversationRenderRows(
      [
        userEntry('user-1', 0),
        assistantEntry({ id: 'a1', agentId: 'alpha', runId: 'run-1', text: 'first response' }),
        hiddenTurnBoundaryEntry('hidden-notification', 2),
        assistantEntry({ id: 'a2', agentId: 'alpha', runId: 'run-2', text: 'background response' }),
      ],
      'idle',
    );

    const assistantRows = rows.filter((row) => row.entry.kind === 'message'
      && (row.entry as AgentMessageEntry).message.role === 'assistant');
    expect(rows.map((row) => row.entry.kind)).toEqual([
      'message',
      'message',
      'hidden-turn-boundary',
      'message',
    ]);
    expect(assistantRows).toHaveLength(2);
    expect(assistantRows.map((row) => row.key)).toEqual([
      'assistant-turn-run:run-1',
      'assistant-turn-run:run-2',
    ]);
    expect(assistantRows.every((row) => row.isLastInTurn)).toBe(true);
  });

  test('Issue notifications visibly split independent same-agent turns', () => {
    const rows = buildConversationRenderRows(
      [
        userEntry('user-1', 0),
        assistantEntry({ id: 'a1', agentId: 'alpha', runId: 'run-1', text: 'first response' }),
        issueNotificationEntry('notification-1'),
        assistantEntry({ id: 'a2', agentId: 'alpha', runId: 'run-2', text: 'Issue result' }),
      ],
      'idle',
    );

    expect(rows.map((row) => row.entry.kind)).toEqual([
      'message',
      'message',
      'issue-notification',
      'message',
    ]);
    expect(rows.filter((row) => row.entry.kind === 'message'
      && (row.entry as AgentMessageEntry).message.role === 'assistant')).toHaveLength(2);
  });

  test('run-scoped hidden steering keeps assistant continuations in one turn', () => {
    const rows = buildConversationRenderRows(
      [
        userEntry('user-1', 0),
        assistantEntry({ id: 'a-skill', agentId: 'alpha', runId: 'run-1', sourceSeq: 10, text: 'loaded skill' }),
        hiddenTurnBoundaryEntry('hidden-skill-steering', 2, 11),
        assistantEntry({ id: 'a-answer', agentId: 'alpha', runId: 'run-1', sourceSeq: 12, text: 'final response' }),
      ],
      'idle',
    );

    const assistantRows = rows.filter((row) => row.entry.kind === 'message'
      && (row.entry as AgentMessageEntry).message.role === 'assistant');
    expect(rows.map((row) => row.entry.kind)).toEqual(['message', 'message']);
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]!.key).toBe('assistant-turn-run:run-1');
    expect(assistantRows[0]!.sourceSeqs).toEqual([10, 11, 12]);
    expect((assistantRows[0]!.entry as AgentMessageEntry).message.content).toEqual([
      { type: 'text', text: 'loaded skill' },
      { type: 'text', text: 'final response' },
    ]);
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

describe('buildConversationRenderRows — source evidence', () => {
  test('merged assistant rows keep source seqs from every merged entry', () => {
    const rows = buildConversationRenderRows(
      [
        assistantEntry({ id: 'a1', agentId: 'alpha', sourceSeqs: [5, 7] }),
        assistantEntry({ id: 'a2', agentId: 'alpha', sourceSeq: 9 }),
      ],
      'idle',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceSeqs).toEqual([5, 7, 9]);
  });
});

describe('buildConversationRenderRows — stable assistant turn key', () => {
  test('prefers runId over transient active entry id churn', () => {
    const rows = buildConversationRenderRows(
      [
        userEntry('user-1', 0),
        assistantEntry({ id: 'active-assistant-0', agentId: 'alpha', runId: 'run-stable', timestamp: 10 }),
      ],
      'streaming_text',
    );

    expect(rows[1]!.key).toBe('assistant-turn-run:run-stable');
    expect(rows[1]!.contentKey).toBe('assistant-turn-run:run-stable');
  });

  test('falls back to timestamp plus assistant actor when no runId is available', () => {
    const rows = buildConversationRenderRows(
      [
        userEntry('user-1', 0),
        assistantEntry({ id: 'active-assistant-0', agentId: 'alpha', runId: null, timestamp: 10 }),
      ],
      'streaming_text',
    );

    expect(rows[1]!.key).toBe('assistant-turn-10:agent:alpha');
    expect(rows[1]!.contentKey).toBe('assistant-turn-10:agent:alpha');
  });

  test('falls back to the assistant message timestamp before an actor is known', () => {
    const rows = buildConversationRenderRows(
      [
        userEntry('user-1', 0),
        assistantEntry({ id: 'active-assistant-0', agentId: null, runId: null, timestamp: 10 }),
      ],
      'streaming_text',
    );

    expect(rows[1]!.key).toBe('assistant-turn-10:actor:none');
    expect(rows[1]!.contentKey).toBe('assistant-turn-10:actor:none');
  });

  test('deduplicates repeated fallback keys without making the first turn unstable', () => {
    const rows = buildConversationRenderRows(
      [
        userEntry('user-1', 0),
        assistantEntry({ id: 'a1', agentId: 'alpha', runId: null, timestamp: 10 }),
        userEntry('user-2', 11),
        assistantEntry({ id: 'a2', agentId: 'alpha', runId: null, timestamp: 10 }),
      ],
      'idle',
    );

    expect(rows[1]!.key).toBe('assistant-turn-10:agent:alpha');
    expect(rows[3]!.key).toBe('assistant-turn-10:agent:alpha:a2');
  });
});
