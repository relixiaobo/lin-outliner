import { describe, expect, test } from 'bun:test';
import type { AgentActor, AgentEvent } from '../../src/core/agentEventLog';
import {
  buildDreamMemoryExtractionSpanFromEvidence,
} from '../../src/main/agentDreamExtraction';

const systemActor: AgentActor = { type: 'system' };
const userActor: AgentActor = { type: 'user', userId: 'user-1' };
const agentActor: AgentActor = { type: 'agent', agentId: 'agent-1' };
const toolActor: AgentActor = { type: 'tool', toolName: 'node_read', toolCallId: 'tool-prev' };

function base(seq: number, type: AgentEvent['type'], actor: AgentActor = systemActor) {
  return {
    v: 1 as const,
    eventId: `conversation-1-event-${seq}`,
    seq,
    conversationId: 'conversation-1',
    type,
    createdAt: 1_800_000_000_000 + seq,
    actor,
  };
}

function conversationCreated(): AgentEvent {
  return { ...base(1, 'conversation.created'), title: 'Dream evidence' };
}

function runStarted(seq: number, runId: string): AgentEvent {
  return {
    ...base(seq, 'run.started', agentActor),
    runId,
    agentId: 'agent-1',
  };
}

function runCompleted(seq: number, runId: string): AgentEvent {
  return {
    ...base(seq, 'run.completed', agentActor),
    runId,
  };
}

function userMessage(seq: number, messageId: string, text: string, parentMessageId: string | null, runId?: string): AgentEvent {
  return {
    ...base(seq, 'user_message.created', userActor),
    runId,
    messageId,
    parentMessageId,
    content: [{ type: 'text', text }],
  };
}

function assistantStarted(seq: number, messageId: string, parentMessageId: string | null, runId: string): AgentEvent {
  return {
    ...base(seq, 'assistant_message.started', agentActor),
    runId,
    messageId,
    parentMessageId,
    providerId: 'test',
    modelId: 'test',
  };
}

function assistantCompleted(seq: number, messageId: string, text: string, runId: string): AgentEvent {
  return {
    ...base(seq, 'assistant_message.completed', agentActor),
    runId,
    messageId,
    stopReason: 'stop',
    content: [{ type: 'text', text }],
  };
}

function toolResult(seq: number, messageId: string, parentMessageId: string, text: string, runId: string): AgentEvent {
  return {
    ...base(seq, 'tool_result.created', toolActor),
    runId,
    toolCallId: 'tool-prev',
    messageId,
    parentMessageId,
    toolName: 'node_read',
    content: [{ type: 'text', text }],
  };
}

function conversationSpan(events: readonly AgentEvent[], fromSeqExclusive: number) {
  return buildDreamMemoryExtractionSpanFromEvidence('run-new', {
    conversations: [{
      conversationId: 'conversation-1',
      events: [conversationCreated(), ...events],
      fromSeqExclusive,
    }],
    runs: [],
  });
}

function conversationSpanWithCreatedAtRange(
  events: readonly AgentEvent[],
  fromSeqExclusive: number,
  createdAtRange: { fromInclusive: number; throughExclusive: number },
) {
  return buildDreamMemoryExtractionSpanFromEvidence('run-new', {
    conversations: [{
      conversationId: 'conversation-1',
      events: [conversationCreated(), ...events],
      fromSeqExclusive,
      createdAtRange,
    }],
    runs: [],
  });
}

describe('agent dream extraction', () => {
  test('does not cross a previous run boundary to find user provenance', () => {
    const events = [
      runStarted(2, 'run-prev'),
      userMessage(3, 'user-prev', 'Previous turn instruction that must not become new-run evidence.', null, 'run-prev'),
      assistantStarted(4, 'assistant-prev', 'user-prev', 'run-prev'),
      assistantCompleted(5, 'assistant-prev', 'Previous run response.', 'run-prev'),
      toolResult(6, 'tool-prev-result', 'assistant-prev', 'Previous run tool result.', 'run-prev'),
      runCompleted(7, 'run-prev'),
      runStarted(8, 'run-new'),
      assistantStarted(9, 'assistant-new', 'tool-prev-result', 'run-new'),
      assistantCompleted(10, 'assistant-new', 'New run response without a fresh user prompt.', 'run-new'),
      runCompleted(11, 'run-new'),
    ];

    const span = conversationSpan(events, 8);

    expect(span?.sources[0]).toMatchObject({
      stream: 'conversation',
      streamId: 'conversation-1',
      range: { fromSeqExclusive: 8, throughSeq: 11 },
    });
    expect(span?.transcript).toContain('New run response without a fresh user prompt.');
    expect(span?.transcript).not.toContain('Previous turn instruction');
    expect(span?.transcript).not.toContain('Previous run tool result.');
  });

  test('includes the directly adjacent user prompt for a normal completed turn', () => {
    const events = [
      runStarted(2, 'run-new'),
      userMessage(3, 'user-new', 'Remember that concise answers are preferred.', null, 'run-new'),
      assistantStarted(4, 'assistant-new', 'user-new', 'run-new'),
      assistantCompleted(5, 'assistant-new', 'I will answer concisely.', 'run-new'),
      runCompleted(6, 'run-new'),
    ];

    const span = conversationSpan(events, 2);

    expect(span?.sources[0]).toMatchObject({
      stream: 'conversation',
      streamId: 'conversation-1',
      range: { fromSeqExclusive: 2, throughSeq: 6 },
    });
    expect(span?.transcript).toContain('Remember that concise answers are preferred.');
    expect(span?.transcript).toContain('I will answer concisely.');
  });

  test('filters Dream evidence by created-at range while preserving the scanned source tail', () => {
    const windowStart = 1_800_010_000_000;
    const windowEnd = windowStart + 10_000;
    const events = [
      { ...userMessage(2, 'user-before-window', 'Ignore this stale preference.', null), createdAt: windowStart - 1 },
      { ...userMessage(3, 'user-in-window', 'Remember source-date Dream windows.', 'user-before-window', 'run-new'), createdAt: windowStart },
      { ...assistantStarted(4, 'assistant-in-window', 'user-in-window', 'run-new'), createdAt: windowStart + 1 },
      { ...assistantCompleted(5, 'assistant-in-window', 'Dream should write to the source date.', 'run-new'), createdAt: windowStart + 2 },
      { ...runCompleted(6, 'run-new'), createdAt: windowEnd - 1 },
      { ...userMessage(7, 'user-after-window', 'Ignore this later preference.', 'assistant-in-window'), createdAt: windowEnd },
    ];

    const span = conversationSpanWithCreatedAtRange(events, 1, {
      fromInclusive: windowStart,
      throughExclusive: windowEnd,
    });

    expect(span?.sources[0]).toEqual({
      stream: 'conversation',
      streamId: 'conversation-1',
      range: {
        fromSeqExclusive: 1,
        throughSeq: 6,
        throughEventId: 'conversation-1-event-6',
        fromCreatedAtInclusive: windowStart,
        throughCreatedAtExclusive: windowEnd,
      },
    });
    expect(span?.transcript).toContain('Remember source-date Dream windows.');
    expect(span?.transcript).toContain('Dream should write to the source date.');
    expect(span?.transcript).not.toContain('stale preference');
    expect(span?.transcript).not.toContain('later preference');
  });

});
