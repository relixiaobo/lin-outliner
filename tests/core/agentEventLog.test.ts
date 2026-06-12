import { describe, expect, test } from 'bun:test';
import {
  deriveAgentPiMessages,
  getAgentEventActivePath,
  getAgentEventConversation,
  getAgentEventConversationPath,
  getAgentEventMessageBranches,
  getAgentEventRuntimeTranscriptPath,
  getAgentEventVisibleTranscript,
  conversationIdOfRun,
  replayAgentEvents,
  type AgentActor,
  type AgentEvent,
  type AgentRunMeta,
  type AgentPayloadRef,
} from '../../src/core/agentEventLog';

const conversationId = 'conversation-1';
const systemActor: AgentActor = { type: 'system' };
const userActor: AgentActor = { type: 'user', userId: 'user-1' };
const agentActor: AgentActor = { type: 'agent', agentId: 'agent-1' };

function base(seq: number, type: AgentEvent['type'], actor: AgentActor = systemActor) {
  return {
    v: 1 as const,
    eventId: `event-${seq}`,
    seq,
    conversationId,
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
  test('represents agent-anchored run meta without a conversation target', () => {
    const meta = {
      id: 'run-dream',
      agentId: 'built-in:tenon:assistant',
      anchor: { type: 'principal', principal: { type: 'agent', agentId: 'built-in:tenon:assistant' } },
      kind: 'scheduled',
      status: 'running',
      trigger: { type: 'system' },
      fingerprint: {
        appVersion: 'test',
        promptHash: 'prompt',
        toolSchemaHash: 'tools',
        skillBindings: [],
        modelConfig: 'model',
      },
      retention: 'hot',
      createdAt: 1,
    } satisfies AgentRunMeta;

    expect(conversationIdOfRun(meta)).toBeNull();
  });

  test('replays a linear conversation and derives pi messages from deltas', () => {
    const events: AgentEvent[] = [
      { ...base(1, 'conversation.created'), title: 'Untitled' },
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
    const activePath = getAgentEventActivePath(state);

    expect(activePath.map((message) => message.id)).toEqual(['user-1', 'assistant-1']);
    expect(activePath.map((message) => message.actor)).toEqual([userActor, agentActor]);
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
      { ...base(1, 'conversation.created'), title: 'Untitled' },
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

  test('keeps run-scoped interaction and widget events replay-neutral for the flat conversation projection', () => {
    const events: AgentEvent[] = [
      { ...base(1, 'conversation.created'), title: 'Untitled' },
      { ...base(2, 'run.started'), runId: 'run-1' },
      {
        ...base(3, 'user_question.requested', agentActor),
        runId: 'run-1',
        requestId: 'question-1',
        toolCallId: 'tool-1',
        request: {
          questions: [{
            id: 'choice',
            type: 'single_choice',
            question: 'Pick one',
            options: [
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B' },
            ],
          }],
        },
      },
      {
        ...base(4, 'user_question.answered', userActor),
        runId: 'run-1',
        requestId: 'question-1',
        result: {
          requestId: 'question-1',
          answers: [{ questionId: 'choice', selectedOptionIds: ['a'] }],
        },
      },
      {
        ...base(5, 'widget_state.updated', agentActor),
        runId: 'run-1',
        toolCallId: 'tool-2',
        messageId: 'assistant-1',
        currentState: { slider: 4 },
      },
    ];

    const state = replayAgentEvents(events);

    expect(state.latestSeq).toBe(5);
    expect(state.runs['run-1']?.status).toBe('running');
    expect(state.userQuestions['question-1']).toMatchObject({
      requestId: 'question-1',
      status: 'answered',
      result: {
        requestId: 'question-1',
        answers: [{ questionId: 'choice', selectedOptionIds: ['a'] }],
      },
    });
    expect(getAgentEventActivePath(state)).toEqual([]);
    expect(getAgentEventConversation(state)).toEqual([]);
  });

  test('represents edits as sibling branches selected by events', () => {
    const events: AgentEvent[] = [
      { ...base(1, 'conversation.created'), title: 'Untitled' },
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

  test('visible transcript keeps Channel peer reply slots but collapses regenerated slot versions', () => {
    const reviewerActor: AgentActor = { type: 'agent', agentId: 'agent-2' };
    const events: AgentEvent[] = [
      { ...base(1, 'conversation.created'), title: 'Channel' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-channel',
        parentMessageId: null,
        content: [{ type: 'text', text: '@one @two compare' }],
      },
      { ...base(3, 'run.started'), runId: 'run-one', agentId: 'agent-1', addressedByMessageId: 'user-channel' },
      {
        ...base(4, 'assistant_message.started', agentActor),
        runId: 'run-one',
        messageId: 'assistant-one',
        parentMessageId: 'user-channel',
        addressedByMessageId: 'user-channel',
        providerId: 'test',
        modelId: 'test',
      },
      {
        ...base(5, 'assistant_message.completed', agentActor),
        messageId: 'assistant-one',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'One original' }],
      },
      { ...base(6, 'run.completed'), runId: 'run-one' },
      { ...base(7, 'run.started'), runId: 'run-two', agentId: 'agent-2', addressedByMessageId: 'user-channel' },
      {
        ...base(8, 'assistant_message.started', reviewerActor),
        runId: 'run-two',
        messageId: 'assistant-two',
        parentMessageId: 'user-channel',
        addressedByMessageId: 'user-channel',
        providerId: 'test',
        modelId: 'test',
      },
      {
        ...base(9, 'assistant_message.completed', reviewerActor),
        messageId: 'assistant-two',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Two original' }],
      },
      { ...base(10, 'run.completed'), runId: 'run-two' },
    ];

    const peerState = replayAgentEvents(events);
    expect(getAgentEventActivePath(peerState).map((message) => message.id)).toEqual(['user-channel', 'assistant-two']);
    expect(getAgentEventVisibleTranscript(peerState).map((entry) => entry.message.id)).toEqual([
      'user-channel',
      'assistant-one',
      'assistant-two',
    ]);

    const regeneratedState = replayAgentEvents([
      ...events,
      { ...base(11, 'branch.selected'), leafMessageId: 'user-channel' },
      { ...base(12, 'run.started'), runId: 'run-one-b', agentId: 'agent-1', addressedByMessageId: 'user-channel' },
      {
        ...base(13, 'assistant_message.started', agentActor),
        runId: 'run-one-b',
        messageId: 'assistant-one-b',
        parentMessageId: 'user-channel',
        addressedByMessageId: 'user-channel',
        providerId: 'test',
        modelId: 'test',
      },
      {
        ...base(14, 'assistant_message.completed', agentActor),
        messageId: 'assistant-one-b',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'One regenerated' }],
      },
      { ...base(15, 'run.completed'), runId: 'run-one-b' },
    ]);

    expect(getAgentEventVisibleTranscript(regeneratedState).map((entry) => entry.message.id)).toEqual([
      'user-channel',
      'assistant-two',
      'assistant-one-b',
    ]);
  });

  test("visible transcript surfaces a non-active Channel peer's full tool spine, not just its first segment", () => {
    const peerActor: AgentActor = { type: 'agent', agentId: 'agent-1' };
    const activeActor: AgentActor = { type: 'agent', agentId: 'agent-2' };
    // Peer agent-1 runs a tool turn (3 segments: toolCall -> result -> reply);
    // agent-2 answers with a single segment and settles last (the active leaf).
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Channel' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-channel',
        parentMessageId: null,
        content: [{ type: 'text', text: '@one @two compare' }],
      },
      { ...base(3, 'run.started'), runId: 'run-peer', agentId: 'agent-1', addressedByMessageId: 'user-channel' },
      {
        ...base(4, 'assistant_message.started', peerActor),
        runId: 'run-peer',
        messageId: 'peer-seg-1',
        parentMessageId: 'user-channel',
        addressedByMessageId: 'user-channel',
        providerId: 'test',
        modelId: 'test',
      },
      {
        ...base(5, 'assistant_message.completed', peerActor),
        runId: 'run-peer',
        messageId: 'peer-seg-1',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 'tool-peer', name: 'file_read', arguments: { file_path: 'x.txt' } }],
      },
      {
        ...base(6, 'tool_result.created', { type: 'tool', toolName: 'file_read', toolCallId: 'tool-peer' }),
        runId: 'run-peer',
        messageId: 'peer-tool-result',
        parentMessageId: 'peer-seg-1',
        toolCallId: 'tool-peer',
        toolName: 'file_read',
        content: [{ type: 'text', text: 'peer tool output' }],
      },
      {
        ...base(7, 'assistant_message.started', peerActor),
        runId: 'run-peer',
        messageId: 'peer-seg-2',
        // The continuation parents to the run's OWN tail (the tool result),
        // keeping run-peer a linear spine off user-channel.
        parentMessageId: 'peer-tool-result',
        addressedByMessageId: 'user-channel',
        providerId: 'test',
        modelId: 'test',
      },
      {
        ...base(8, 'assistant_message.completed', peerActor),
        runId: 'run-peer',
        messageId: 'peer-seg-2',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Peer done' }],
      },
      { ...base(9, 'run.completed'), runId: 'run-peer' },
      { ...base(10, 'run.started'), runId: 'run-active', agentId: 'agent-2', addressedByMessageId: 'user-channel' },
      {
        ...base(11, 'assistant_message.started', activeActor),
        runId: 'run-active',
        messageId: 'active-reply',
        parentMessageId: 'user-channel',
        addressedByMessageId: 'user-channel',
        providerId: 'test',
        modelId: 'test',
      },
      {
        ...base(12, 'assistant_message.completed', activeActor),
        runId: 'run-active',
        messageId: 'active-reply',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Active done' }],
      },
      { ...base(13, 'run.completed'), runId: 'run-active' },
    ]);

    // The active path is just the active peer's single segment...
    expect(getAgentEventActivePath(state).map((message) => message.id)).toEqual(['user-channel', 'active-reply']);
    // ...but the transcript still shows the non-active peer's WHOLE spine —
    // its tool call segment, the tool result, and the continuation — in order.
    expect(getAgentEventVisibleTranscript(state).map((entry) => entry.message.id)).toEqual([
      'user-channel',
      'peer-seg-1',
      'peer-tool-result',
      'peer-seg-2',
      'active-reply',
    ]);
  });

  test('expands compacted active-path history for visible transcript reads', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Compaction' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-before-compact',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Old question' }],
      },
      {
        ...base(3, 'assistant_message.started', agentActor),
        runId: 'run-before-compact',
        messageId: 'assistant-before-compact',
        parentMessageId: 'user-before-compact',
        providerId: 'test',
        modelId: 'test',
      },
      {
        ...base(4, 'assistant_message.completed', agentActor),
        messageId: 'assistant-before-compact',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Old answer' }],
      },
      {
        ...base(5, 'user_message.created', userActor),
        messageId: 'user-edited-away',
        parentMessageId: null,
        replacesMessageId: 'user-before-compact',
        content: [{ type: 'text', text: 'Sibling branch' }],
      },
      {
        ...base(6, 'branch.selected'),
        leafMessageId: 'assistant-before-compact',
      },
      {
        ...base(7, 'compaction.completed'),
        messageId: 'compact-root',
        summary: 'Summary',
        source: { fromMessageId: 'user-before-compact', throughMessageId: 'assistant-before-compact' },
        trigger: 'manual',
      },
      {
        ...base(8, 'user_message.created', systemActor),
        messageId: 'compact-root',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Conversation compacted.' }],
      },
      {
        ...base(9, 'user_message.created', userActor),
        messageId: 'user-after-compact',
        parentMessageId: 'compact-root',
        content: [{ type: 'text', text: 'New question' }],
      },
    ]);

    expect(getAgentEventActivePath(state).map((message) => message.id)).toEqual([
      'compact-root',
      'user-after-compact',
    ]);
    expect(state.compactionsByMessageId['compact-root']?.source).toEqual({
      fromMessageId: 'user-before-compact',
      throughMessageId: 'assistant-before-compact',
    });
    expect(getAgentEventRuntimeTranscriptPath(state).map((message) => message.id)).toEqual([
      'compact-root',
      'user-after-compact',
    ]);
    expect(getAgentEventVisibleTranscript(state).map((entry) => ({
      id: entry.message.id,
      archived: entry.archived,
    }))).toEqual([
      { id: 'user-before-compact', archived: true },
      { id: 'assistant-before-compact', archived: true },
      { id: 'compact-root', archived: false },
      { id: 'user-after-compact', archived: false },
    ]);
  });

  test('uses mixed-resolution runtime history after compaction', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Compaction with tools' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'u1',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Read the file' }],
      },
      {
        ...base(3, 'assistant_message.started', agentActor),
        runId: 'run-1',
        messageId: 'a1',
        parentMessageId: 'u1',
        providerId: 'test',
        modelId: 'test',
      },
      {
        ...base(4, 'assistant_message.completed', agentActor),
        runId: 'run-1',
        messageId: 'a1',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 'tool-1', name: 'file_read', arguments: { file_path: 'secret.txt' } }],
      },
      {
        ...base(5, 'tool_result.created', { type: 'tool', toolName: 'file_read', toolCallId: 'tool-1' }),
        runId: 'run-1',
        messageId: 'tool-result-1',
        parentMessageId: 'a1',
        toolCallId: 'tool-1',
        toolName: 'file_read',
        content: [{ type: 'text', text: 'verbatim old tool output' }],
      },
      {
        ...base(6, 'assistant_message.started', agentActor),
        runId: 'run-1',
        messageId: 'a2',
        parentMessageId: 'tool-result-1',
        providerId: 'test',
        modelId: 'test',
      },
      {
        ...base(7, 'assistant_message.completed', agentActor),
        runId: 'run-1',
        messageId: 'a2',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'I read the file.' }],
      },
      {
        ...base(8, 'compaction.completed'),
        messageId: 'compact-root',
        summary: 'The file was read and its exact output is summarized.',
        source: { fromMessageId: 'u1', throughMessageId: 'a2' },
        trigger: 'manual',
      },
      {
        ...base(9, 'user_message.created', systemActor),
        messageId: 'compact-root',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Conversation compacted. Summary: The file was read.' }],
      },
      {
        ...base(10, 'user_message.created', userActor),
        messageId: 'u2',
        parentMessageId: 'compact-root',
        content: [{ type: 'text', text: 'Continue from there' }],
      },
    ]);

    expect(getAgentEventVisibleTranscript(state).map((entry) => ({
      id: entry.message.id,
      archived: entry.archived,
    }))).toEqual([
      { id: 'u1', archived: true },
      { id: 'a1', archived: true },
      { id: 'tool-result-1', archived: true },
      { id: 'a2', archived: true },
      { id: 'compact-root', archived: false },
      { id: 'u2', archived: false },
    ]);
    expect(getAgentEventRuntimeTranscriptPath(state).map((message) => message.id)).toEqual(['compact-root', 'u2']);
    expect(JSON.stringify(deriveAgentPiMessages(state))).not.toContain('verbatim old tool output');
    expect(JSON.stringify(deriveAgentPiMessages(state))).toContain('Conversation compacted');
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
      { ...base(1, 'conversation.created'), title: 'Untitled' },
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
      { ...base(1, 'conversation.created'), title: 'Untitled' },
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
        runId: 'run-1',
        messageId: 'tool-result-1',
        parentMessageId: 'assistant-1',
        toolCallId: 'tool-1',
        toolName: 'file_read',
        isError: false,
        content: [{ type: 'text', text: 'notes content' }],
        outputSummary: 'notes content',
      },
      {
        ...base(7, 'assistant_message.started', agentActor),
        runId: 'run-1',
        messageId: 'assistant-2',
        parentMessageId: 'tool-result-1',
        providerId: 'test',
        modelId: 'test',
      },
      {
        ...base(8, 'assistant_message.completed', agentActor),
        runId: 'run-1',
        messageId: 'assistant-2',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Done.' }],
      },
    ];

    const state = replayAgentEvents(events);
    expect(getAgentEventActivePath(state).map((message) => message.id)).toEqual([
      'user-1',
      'assistant-1',
      'tool-result-1',
      'assistant-2',
    ]);
    expect(getAgentEventRuntimeTranscriptPath(state).map((message) => message.id)).toEqual([
      'user-1',
      'assistant-1',
      'tool-result-1',
      'assistant-2',
    ]);
    expect(getAgentEventConversationPath(state).map((message) => message.id)).toEqual(['user-1', 'assistant-2']);
    expect(getAgentEventConversation(state).map((entry) => entry.messageId)).toEqual(['user-1', 'assistant-2']);
    expect(getAgentEventActivePath(state).map((message) => message.actor)).toEqual([
      userActor,
      agentActor,
      { type: 'tool', toolName: 'file_read', toolCallId: 'tool-1' },
      agentActor,
    ]);
    expect(state.messages['tool-result-1']?.runId).toBe('run-1');

    const messages = deriveAgentPiMessages(state);
    const assistant = messages[1];
    const toolResult = messages[2];
    const finalAssistant = messages[3];

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
    expect(finalAssistant?.role).toBe('assistant');
    if (finalAssistant?.role !== 'assistant') throw new Error('Expected final assistant');
    expect(finalAssistant.content).toEqual([{ type: 'text', text: 'Done.' }]);
  });

  test('infers run ownership for legacy flat tool results from the parent assistant', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Untitled' },
      {
        ...base(2, 'assistant_message.started', agentActor),
        runId: 'run-legacy',
        messageId: 'assistant-1',
        parentMessageId: null,
        providerId: 'test',
        modelId: 'test',
      },
      {
        ...base(3, 'assistant_message.completed', agentActor),
        runId: 'run-legacy',
        messageId: 'assistant-1',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 'tool-1', name: 'file_read', arguments: {} }],
      },
      {
        ...base(4, 'tool_result.created', { type: 'tool', toolName: 'file_read', toolCallId: 'tool-1' }),
        messageId: 'tool-result-1',
        parentMessageId: 'assistant-1',
        toolCallId: 'tool-1',
        toolName: 'file_read',
        isError: false,
        content: [{ type: 'text', text: 'legacy result' }],
        outputSummary: 'legacy result',
      },
    ]);

    expect(state.messages['tool-result-1']?.runId).toBe('run-legacy');
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
      { ...base(1, 'conversation.created'), title: 'Untitled' },
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

    const state = replayAgentEvents(events);
    expect(state.messages['tool-result-1']?.outputSummary).toBe(payload.summary);
    const toolResult = deriveAgentPiMessages(state)[1];
    expect(toolResult?.role).toBe('toolResult');
    if (toolResult?.role !== 'toolResult') throw new Error('Expected tool result');
    expect(toolResult.content).toEqual([{ type: 'text', text: replacement }]);
  });

  test('tracks child-run lifecycle markers without adding them to the active conversation', () => {
    const events: AgentEvent[] = [
      { ...base(1, 'conversation.created'), title: 'Untitled' },
      {
        ...base(2, 'child_run.started', { type: 'tool', toolName: 'Agent', toolCallId: 'tool-agent-1' }),
        childRunId: 'child-1',
        parentRunId: 'run-parent',
        parentToolCallId: 'tool-agent-1',
        name: 'research',
        description: 'research docs',
        prompt: 'Research this.',
        agentType: 'general',
        contextMode: 'fresh',
      },
      {
        ...base(3, 'child_run.updated', { type: 'tool', toolName: 'Agent', toolCallId: 'tool-agent-1' }),
        childRunId: 'child-1',
        status: 'completed',
        completedAt: 1_700_000_000_100,
        result: 'Done.',
      },
    ];

    const state = replayAgentEvents(events);

    expect(getAgentEventActivePath(state)).toEqual([]);
    expect(deriveAgentPiMessages(state)).toEqual([]);
    expect(state.childRuns['child-1']).toMatchObject({
      id: 'child-1',
      name: 'research',
      agentType: 'general',
      parentRunId: 'run-parent',
      status: 'completed',
      result: 'Done.',
      parentToolCallId: 'tool-agent-1',
    });

    // Markers apply in seq order: a LATER 'running' update is the resume of a
    // detached run, so it re-opens the terminal record (clearing the stale
    // result/completedAt) and a second completion lands on top.
    const resumed = replayAgentEvents([
      ...events,
      {
        ...base(4, 'child_run.updated', { type: 'tool', toolName: 'Agent', toolCallId: 'tool-agent-1' }),
        childRunId: 'child-1',
        status: 'running',
      },
    ]);
    expect(resumed.childRuns['child-1']).toMatchObject({ status: 'running' });
    expect(resumed.childRuns['child-1']?.result).toBeUndefined();
    expect(resumed.childRuns['child-1']?.completedAt).toBeUndefined();
  });

  test('applies tool result replacement events to replayed pi messages', () => {
    const payload: AgentPayloadRef = {
      kind: 'payload_ref',
      id: 'tool-output-tool-1',
      storage: 'file',
      mimeType: 'text/plain',
      byteLength: 80_000,
      sha256: 'tool-sha',
      role: 'tool_output',
      summary: 'bash output',
      truncated: true,
    };
    const replacement = '<persisted-output>\nPreview\n</persisted-output>';
    const events: AgentEvent[] = [
      { ...base(1, 'conversation.created'), title: 'Untitled' },
      {
        ...base(2, 'assistant_message.started', agentActor),
        runId: 'run-1',
        messageId: 'assistant-1',
        parentMessageId: null,
        providerId: 'test',
        modelId: 'test',
      },
      {
        ...base(3, 'assistant_message.completed', agentActor),
        messageId: 'assistant-1',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 'tool-1', name: 'bash', arguments: {} }],
      },
      {
        ...base(4, 'tool_result.created', { type: 'tool', toolName: 'bash', toolCallId: 'tool-1' }),
        messageId: 'tool-result-1',
        parentMessageId: 'assistant-1',
        toolCallId: 'tool-1',
        toolName: 'bash',
        isError: false,
        content: [{ type: 'text', text: 'large original output' }],
        outputSummary: 'large original output',
      },
      { ...base(5, 'payload.created'), payload },
      {
        ...base(6, 'tool_result.replaced'),
        runId: 'run-1',
        messageId: 'tool-result-1',
        toolCallId: 'tool-1',
        content: [{ type: 'payload_ref', payload, label: replacement }],
        outputSummary: 'bash output',
        outputRef: payload,
      },
    ];

    const state = replayAgentEvents(events);
    expect(state.messages['tool-result-1']?.outputSummary).toBe('bash output');
    expect(state.messages['tool-result-1']?.runId).toBe('run-1');
    const toolResult = deriveAgentPiMessages(state)[1];
    expect(toolResult?.role).toBe('toolResult');
    if (toolResult?.role !== 'toolResult') throw new Error('Expected tool result');
    expect(toolResult.content).toEqual([{ type: 'text', text: replacement }]);
  });

  test('rejects non-monotonic event sequences', () => {
    expect(() => replayAgentEvents([
      { ...base(2, 'conversation.created'), title: 'Untitled' },
      { ...base(2, 'conversation.renamed'), eventId: 'event-3', title: 'Still duplicate seq' },
    ])).toThrow(/increasing seq order/);
  });
});

describe('notification + attention projection', () => {
  // The base conversationId IS the delivery anchor: a log only ever carries its
  // own conversation's notifications (cross-conversation isolation is structural,
  // enforced by the replay conversation-mismatch guard).
  function notificationCreated(seq: number, overrides: Partial<Record<string, unknown>> = {}) {
    return {
      ...base(seq, 'notification.created'),
      notificationId: `notif-${seq}`,
      kind: 'task_completed' as const,
      title: `Task ${seq} done`,
      ...overrides,
    } as AgentEvent;
  }

  test('folds unread for the origin conversation', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Untitled' },
      notificationCreated(2, { source: { type: 'run', runId: 'run-x' } }),
      notificationCreated(3),
      notificationCreated(4, { kind: 'needs_input', source: { type: 'run', runId: 'run-y' } }),
    ]);

    expect(state.attentionByConversationId[conversationId]?.unreadCount).toBe(3);
    expect(state.notifications['notif-2']?.source).toEqual({ type: 'run', runId: 'run-x' });
    expect(state.notifications['notif-4']?.kind).toBe('needs_input');
    expect(Object.values(state.notifications).every((record) => record.read === false)).toBe(true);
  });

  test('rejects a notification claiming another conversation (delivery anchor = log identity)', () => {
    expect(() => replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Untitled' },
      { ...notificationCreated(2), conversationId: 'conv-other' } as AgentEvent,
    ])).toThrow(/conversation mismatch/);
  });

  test('notification.read clears the conversation through the given seq', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Untitled' },
      notificationCreated(2),
      notificationCreated(3),
      { ...base(4, 'notification.read'), throughSeq: 3 },
    ]);

    expect(state.attentionByConversationId[conversationId]?.unreadCount).toBe(0);
    expect(state.attentionByConversationId[conversationId]?.lastReadThroughSeq).toBe(3);
    expect(state.notifications['notif-2']?.read).toBe(true);
    expect(state.notifications['notif-3']?.read).toBe(true);
  });

  test('a notification arriving after a read cursor counts as unread again (restart-safe replay)', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Untitled' },
      notificationCreated(2),
      { ...base(3, 'notification.read'), throughSeq: 2 },
      notificationCreated(4),
    ]);

    expect(state.attentionByConversationId[conversationId]?.unreadCount).toBe(1);
    expect(state.notifications['notif-2']?.read).toBe(true);
    expect(state.notifications['notif-4']?.read).toBe(false);
  });

  test('duplicate notification.created is idempotent', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Untitled' },
      notificationCreated(2),
      { ...notificationCreated(3), notificationId: 'notif-2' },
    ]);

    expect(state.attentionByConversationId[conversationId]?.unreadCount).toBe(1);
    expect(Object.keys(state.notifications)).toEqual(['notif-2']);
  });

  test('notification.created/read do not bump the conversation updatedAt (no list reorder)', () => {
    // A background delivery and a read must not look like conversation activity:
    // updatedAt stays pinned to the last real content event (the user message).
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Untitled' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-1',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Question' }],
      } as AgentEvent,
      notificationCreated(5),
      { ...base(6, 'notification.read'), throughSeq: 5 },
    ]);

    expect(state.conversation?.updatedAt).toBe(1_700_000_000_000 + 2);
  });
});
