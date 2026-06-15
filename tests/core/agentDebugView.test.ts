import { describe, expect, test } from 'bun:test';
import type { AgentActor, AgentEvent } from '../../src/core/agentEventLog';
import { deriveDebugRounds } from '../../src/main/agentDebugView';

// Round derivation ([[agent-debug-run-grounded]]): a run's own event stream ->
// the rounds the debug surface renders. Boundaries come from
// assistant_message.started; tool exchanges pair calls with results; the request
// window is the new context entering each round.

const conversationId = 'lin-agent-debug-view';
const agentActor: AgentActor = { type: 'agent', agentId: 'built-in:tenon:assistant' };
const userActor: AgentActor = { type: 'user', userId: 'user-1' };

let seqCounter = 0;
function ev(type: AgentEvent['type'], fields: Record<string, unknown>, actor: AgentActor = agentActor): AgentEvent {
  seqCounter += 1;
  return {
    v: 1,
    eventId: `event-${seqCounter}`,
    seq: seqCounter,
    conversationId,
    createdAt: 1_700_000_000_000 + seqCounter,
    type,
    actor,
    ...fields,
  } as AgentEvent;
}

describe('deriveDebugRounds', () => {
  test('splits a multi-round run with a tool exchange into rounds', () => {
    seqCounter = 0;
    const runId = 'run-x';
    const events: AgentEvent[] = [
      ev('run.started', { runId, agentId: 'built-in:tenon:assistant', kind: 'turn', trigger: { type: 'message', messageId: 'u1' } }),
      ev('user_message.created', { runId, messageId: 'u1', parentMessageId: null, content: [{ type: 'text', text: 'List my files' }] }, userActor),
      ev('assistant_message.started', { runId, messageId: 'a1', parentMessageId: 'u1', providerId: 'anthropic', modelId: 'claude', apiId: 'messages' }),
      ev('assistant_message.completed', {
        runId,
        messageId: 'a1',
        parentMessageId: 'u1',
        stopReason: 'tool_use',
        content: [
          { type: 'text', text: 'Let me look.' },
          { type: 'toolCall', id: 'call-1', name: 'list_files', arguments: { path: '/' } },
        ],
        usage: { input: 100, output: 20, totalTokens: 120, cost: { total: 0.01 } },
      }),
      ev('tool_result.created', { runId, messageId: 'tr1', parentMessageId: 'a1', toolCallId: 'call-1', toolName: 'list_files', isError: false, content: [{ type: 'text', text: 'a.md\nb.md' }] }),
      ev('assistant_message.started', { runId, messageId: 'a2', parentMessageId: 'tr1', providerId: 'anthropic', modelId: 'claude', apiId: 'messages' }),
      ev('assistant_message.completed', {
        runId,
        messageId: 'a2',
        parentMessageId: 'tr1',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'You have a.md and b.md.' }],
        usage: { input: 140, output: 12, totalTokens: 152, cost: { total: 0.012 } },
      }),
      ev('run.completed', { runId }),
    ];

    const rounds = deriveDebugRounds(events);
    expect(rounds.map((round) => round.messageId)).toEqual(['a1', 'a2']);

    const [first, second] = rounds;
    // Round 0: triggered by the user message, called one tool, got its result.
    expect(first!.requestWindow.map((row) => row.role)).toEqual(['user']);
    expect(first!.status).toBe('completed');
    expect(first!.stopReason).toBe('tool_use');
    expect(first!.usage?.input).toBe(100);
    expect(first!.toolExchanges).toHaveLength(1);
    expect(first!.toolExchanges[0]).toMatchObject({ toolCallId: 'call-1', toolName: 'list_files', result: 'a.md\nb.md', isError: false });
    expect(first!.responseParts.some((part) => part.kind === 'toolCall')).toBe(true);

    // Round 1: the tool result is the new context; final text answer, no tools.
    expect(second!.requestWindow.map((row) => row.role)).toEqual(['tool']);
    expect(second!.toolExchanges).toHaveLength(0);
    expect(second!.status).toBe('completed');
    expect(second!.responseParts).toEqual([{ kind: 'text', body: 'You have a.md and b.md.', isReminder: false }]);
    expect(second!.usage?.totalTokens).toBe(152);
  });

  test('an in-flight round (started, no completed) is reported running', () => {
    seqCounter = 0;
    const runId = 'run-live';
    const events: AgentEvent[] = [
      ev('run.started', { runId, agentId: 'built-in:tenon:assistant', kind: 'turn', trigger: { type: 'message', messageId: 'u1' } }),
      ev('user_message.created', { runId, messageId: 'u1', parentMessageId: null, content: [{ type: 'text', text: 'Hi' }] }, userActor),
      ev('assistant_message.started', { runId, messageId: 'a1', parentMessageId: 'u1', providerId: 'anthropic', modelId: 'claude', apiId: 'messages' }),
    ];
    const rounds = deriveDebugRounds(events);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.status).toBe('running');
    expect(rounds[0]!.completedAt).toBeNull();
    expect(rounds[0]!.usage).toBeNull();
  });
});
