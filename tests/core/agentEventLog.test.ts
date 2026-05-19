import { describe, expect, test } from 'bun:test';
import {
  deriveAgentPiMessages,
  getAgentEventActivePath,
  getAgentEventConversation,
  getAgentEventMessageBranches,
  replayAgentEvents,
  type AgentActor,
  type AgentEvent,
  type AgentPayloadRef,
} from '../../src/core/agentEventLog';

const sessionId = 'session-1';
const systemActor: AgentActor = { type: 'system' };
const userActor: AgentActor = { type: 'user', userId: 'user-1' };
const agentActor: AgentActor = { type: 'agent', agentId: 'agent-1' };

function base(seq: number, type: AgentEvent['type'], actor: AgentActor = systemActor) {
  return {
    v: 1 as const,
    eventId: `event-${seq}`,
    seq,
    sessionId,
    type,
    createdAt: 1_700_000_000_000 + seq,
    actor,
  };
}

function textOf(message: ReturnType<typeof deriveAgentPiMessages>[number]) {
  if (message.role === 'toolResult') return String(message.content);
  const first = Array.isArray(message.content) ? message.content[0] : null;
  return first?.type === 'text' ? first.text : '';
}

describe('agent event log', () => {
  test('replays a linear conversation and derives pi messages from deltas', () => {
    const events: AgentEvent[] = [
      { ...base(1, 'session.created'), title: 'Untitled' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-1',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Question' }],
      },
      {
        ...base(3, 'assistant_message.started', agentActor),
        runId: 'run-1',
        messageId: 'assistant-1',
        parentMessageId: 'user-1',
        providerId: 'test-provider',
        modelId: 'test-model',
        apiId: 'test-api',
      },
      {
        ...base(4, 'assistant_message.delta', agentActor),
        messageId: 'assistant-1',
        delta: { type: 'text_delta', text: 'Hel' },
        providerChunkCount: 2,
        startedAt: 10,
        endedAt: 11,
      },
      {
        ...base(5, 'assistant_message.delta', agentActor),
        messageId: 'assistant-1',
        delta: { type: 'text_delta', text: 'lo' },
        providerChunkCount: 1,
        startedAt: 12,
        endedAt: 13,
      },
      {
        ...base(6, 'assistant_message.completed', agentActor),
        messageId: 'assistant-1',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ];

    const state = replayAgentEvents(events);

    expect(getAgentEventActivePath(state).map((message) => message.id)).toEqual(['user-1', 'assistant-1']);
    expect(getAgentEventConversation(state).map((entry) => entry.messageId)).toEqual(['user-1', 'assistant-1']);
    expect(deriveAgentPiMessages(state).map(textOf)).toEqual(['Question', 'Hello']);
  });

  test('keeps debug snapshot events as replay-neutral diagnostics', () => {
    const debugPayload: AgentPayloadRef = {
      kind: 'payload_ref',
      id: 'debug-payload-1',
      storage: 'file',
      mimeType: 'application/json',
      byteLength: 42,
      sha256: 'debug-sha',
      role: 'debug',
      summary: 'Provider payload round 1',
    };
    const events: AgentEvent[] = [
      { ...base(1, 'session.created'), title: 'Untitled' },
      {
        ...base(2, 'payload.created'),
        payload: debugPayload,
      },
      {
        ...base(3, 'debug.snapshot.created'),
        debugId: 'debug-1',
        source: 'provider_payload',
        queryIndex: 1,
        turnIndex: 1,
        payloadRef: debugPayload,
        wire: { bytes: 42, hash: 'wire-hash' },
        model: { id: 'gpt-test', provider: 'openai', api: 'responses', contextWindow: 128_000 },
      },
    ];

    const state = replayAgentEvents(events);

    expect(state.latestSeq).toBe(3);
    expect(state.payloads['debug-payload-1']).toEqual(debugPayload);
    expect(getAgentEventActivePath(state)).toEqual([]);
  });

  test('represents edits as sibling branches selected by events', () => {
    const events: AgentEvent[] = [
      { ...base(1, 'session.created'), title: 'Untitled' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-original',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Original' }],
      },
      {
        ...base(3, 'assistant_message.started', agentActor),
        runId: 'run-1',
        messageId: 'assistant-original',
        parentMessageId: 'user-original',
        providerId: 'test',
        modelId: 'test',
      },
      {
        ...base(4, 'assistant_message.completed', agentActor),
        messageId: 'assistant-original',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Original answer' }],
      },
      {
        ...base(5, 'user_message.created', userActor),
        messageId: 'user-edited',
        parentMessageId: null,
        replacesMessageId: 'user-original',
        content: [{ type: 'text', text: 'Edited' }],
      },
      {
        ...base(6, 'assistant_message.started', agentActor),
        runId: 'run-2',
        messageId: 'assistant-edited',
        parentMessageId: 'user-edited',
        providerId: 'test',
        modelId: 'test',
      },
      {
        ...base(7, 'assistant_message.completed', agentActor),
        messageId: 'assistant-edited',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Edited answer' }],
      },
    ];

    const editedState = replayAgentEvents(events);

    expect(getAgentEventActivePath(editedState).map((message) => message.id)).toEqual([
      'user-edited',
      'assistant-edited',
    ]);
    expect(getAgentEventMessageBranches(editedState, 'user-edited')).toEqual({
      ids: ['user-original', 'user-edited'],
      currentIndex: 1,
    });

    const originalState = replayAgentEvents([
      ...events,
      { ...base(8, 'branch.selected'), leafMessageId: 'assistant-original' },
    ]);
    expect(getAgentEventActivePath(originalState).map((message) => message.id)).toEqual([
      'user-original',
      'assistant-original',
    ]);
    expect(getAgentEventMessageBranches(originalState, 'user-original')).toEqual({
      ids: ['user-original', 'user-edited'],
      currentIndex: 0,
    });
  });

  test('keeps multimedia as payload refs with derived previews', () => {
    const source: AgentPayloadRef = {
      kind: 'payload_ref',
      id: 'payload-source',
      storage: 'file',
      mimeType: 'image/png',
      byteLength: 1024,
      sha256: 'source-sha',
      role: 'source',
      summary: 'Screenshot',
      display: { width: 800, height: 600 },
    };
    const thumbnail: AgentPayloadRef = {
      kind: 'payload_ref',
      id: 'payload-thumb',
      storage: 'file',
      mimeType: 'image/webp',
      byteLength: 120,
      sha256: 'thumb-sha',
      role: 'thumbnail',
      display: { width: 160, height: 120 },
    };
    const events: AgentEvent[] = [
      { ...base(1, 'session.created'), title: 'Untitled' },
      { ...base(2, 'payload.created'), payload: source },
      { ...base(3, 'payload.derived'), sourcePayloadId: source.id, payload: thumbnail, derivation: 'thumbnail' },
      {
        ...base(4, 'user_message.created', userActor),
        messageId: 'user-with-image',
        parentMessageId: null,
        content: [{ type: 'image', imageRef: source, alt: 'Screenshot attachment' }],
        attachments: [source],
      },
    ];

    const state = replayAgentEvents(events);
    const [message] = getAgentEventActivePath(state);

    expect(state.payloads[source.id]).toEqual(source);
    expect(state.derivedPayloadsBySourceId[source.id]).toEqual([thumbnail]);
    expect(message?.content).toEqual([{ type: 'image', imageRef: source, alt: 'Screenshot attachment' }]);
    expect(deriveAgentPiMessages(state).map(textOf)).toEqual(['Screenshot attachment']);
  });

  test('reconstructs assistant tool calls and tool results for pi-mono', () => {
    const events: AgentEvent[] = [
      { ...base(1, 'session.created'), title: 'Untitled' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-1',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Read notes' }],
      },
      {
        ...base(3, 'assistant_message.started', agentActor),
        runId: 'run-1',
        messageId: 'assistant-1',
        parentMessageId: 'user-1',
        providerId: 'test',
        modelId: 'test',
      },
      {
        ...base(4, 'tool_call.started', agentActor),
        messageId: 'assistant-1',
        toolCallId: 'tool-1',
        name: 'file_read',
        inputSummary: '{"file_path":"notes.txt"}',
        args: { file_path: 'notes.txt' },
      },
      {
        ...base(5, 'assistant_message.completed', agentActor),
        messageId: 'assistant-1',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 'tool-1', name: 'file_read', arguments: { file_path: 'notes.txt' } }],
      },
      {
        ...base(6, 'tool_result.created', { type: 'tool', toolName: 'file_read', toolCallId: 'tool-1' }),
        messageId: 'tool-result-1',
        parentMessageId: 'assistant-1',
        toolCallId: 'tool-1',
        toolName: 'file_read',
        isError: false,
        content: [{ type: 'text', text: 'notes content' }],
        outputSummary: 'notes content',
      },
    ];

    const messages = deriveAgentPiMessages(replayAgentEvents(events));
    const assistant = messages[1];
    const toolResult = messages[2];

    expect(assistant?.role).toBe('assistant');
    if (assistant?.role !== 'assistant') throw new Error('Expected assistant');
    expect(assistant.content).toEqual([{
      type: 'toolCall',
      id: 'tool-1',
      name: 'file_read',
      arguments: { file_path: 'notes.txt' },
    }]);
    expect(toolResult).toMatchObject({
      role: 'toolResult',
      toolCallId: 'tool-1',
      toolName: 'file_read',
      isError: false,
    });
  });

  test('uses persisted output labels instead of expanding tool payload refs for pi-mono', () => {
    const payload: AgentPayloadRef = {
      kind: 'payload_ref',
      id: 'tool-output-tool-1',
      storage: 'file',
      mimeType: 'text/plain',
      byteLength: 50_000,
      sha256: 'tool-sha',
      role: 'tool_output',
      summary: 'file_read output: long result...',
      truncated: true,
    };
    const replacement = [
      '<persisted-output>',
      'Output too large (48.8 KB). Full output saved as payload: tool-output-tool-1',
      '',
      'Preview (first 2000 chars):',
      'preview text',
      '</persisted-output>',
    ].join('\n');
    const events: AgentEvent[] = [
      { ...base(1, 'session.created'), title: 'Untitled' },
      {
        ...base(2, 'assistant_message.started', agentActor),
        runId: 'run-1',
        messageId: 'assistant-1',
        parentMessageId: null,
        providerId: 'test',
        modelId: 'test',
      },
      { ...base(3, 'assistant_message.completed', agentActor), messageId: 'assistant-1', stopReason: 'toolUse', content: [] },
      { ...base(4, 'payload.created'), payload },
      {
        ...base(5, 'tool_result.created', { type: 'tool', toolName: 'file_read', toolCallId: 'tool-1' }),
        messageId: 'tool-result-1',
        parentMessageId: 'assistant-1',
        toolCallId: 'tool-1',
        toolName: 'file_read',
        isError: false,
        content: [{ type: 'payload_ref', payload, label: replacement }],
        outputSummary: payload.summary ?? '',
        outputRef: payload,
      },
    ];

    const toolResult = deriveAgentPiMessages(replayAgentEvents(events))[1];
    expect(toolResult?.role).toBe('toolResult');
    if (toolResult?.role !== 'toolResult') throw new Error('Expected tool result');
    expect(toolResult.content).toEqual([{ type: 'text', text: replacement }]);
  });

  test('rejects non-monotonic event sequences', () => {
    expect(() => replayAgentEvents([
      { ...base(2, 'session.created'), title: 'Untitled' },
      { ...base(2, 'session.renamed'), eventId: 'event-3', title: 'Still duplicate seq' },
    ])).toThrow(/increasing seq order/);
  });
});
