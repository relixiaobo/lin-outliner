import { describe, expect, test } from 'bun:test';
import { replayAgentEvents, type AgentActor, type AgentEvent } from '../../src/core/agentEventLog';
import { buildAgentRenderProjection } from '../../src/core/agentRenderProjection';
import { systemReminder } from '../../src/core/agentAttachments';

const sessionId = 'session-render';
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

describe('agent render projection', () => {
  test('builds compact rows and streaming state from the active path', () => {
    const state = replayAgentEvents([
      { ...base(1, 'session.created'), title: 'Render test' },
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
      },
      {
        ...base(4, 'assistant_message.delta', agentActor),
        messageId: 'assistant-1',
        delta: { type: 'text_delta', text: 'Partial answer' },
        providerChunkCount: 1,
        startedAt: 10,
        endedAt: 11,
      },
    ]);

    const projection = buildAgentRenderProjection(state, {
      revision: 7,
      activeRunId: 'run-1',
      isStreaming: true,
    });

    expect(projection.rows).toEqual([
      { id: 'user:user-1', kind: 'message', messageId: 'user-1' },
      { id: 'assistant:assistant-1', kind: 'message', messageId: 'assistant-1' },
    ]);
    expect(projection.transcriptRows).toEqual(projection.rows);
    expect(projection.entities.messages['assistant-1']?.status).toBe('streaming');
    expect(projection.streaming).toMatchObject({
      messageId: 'assistant-1',
      rowId: 'assistant:assistant-1',
      text: 'Partial answer',
    });
  });

  test('keeps branch state on message entities without persisting a tree', () => {
    const state = replayAgentEvents([
      { ...base(1, 'session.created'), title: 'Branches' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-original',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Original' }],
      },
      {
        ...base(3, 'user_message.created', userActor),
        messageId: 'user-edited',
        parentMessageId: null,
        replacesMessageId: 'user-original',
        content: [{ type: 'text', text: 'Edited' }],
      },
    ]);

    const projection = buildAgentRenderProjection(state, { revision: 1 });

    expect(projection.rows.map((row) => row.messageId)).toEqual(['user-edited']);
    expect(projection.entities.messages['user-edited']?.branches).toEqual({
      ids: ['user-original', 'user-edited'],
      currentIndex: 1,
    });
  });

  test('projects compaction as a boundary row instead of a user bubble', () => {
    const state = replayAgentEvents([
      { ...base(1, 'session.created'), title: 'Compaction' },
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
        providerId: 'test-provider',
        modelId: 'test-model',
      },
      {
        ...base(4, 'assistant_message.completed', agentActor),
        messageId: 'assistant-before-compact',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Old answer' }],
      },
      {
        ...base(5, 'compaction.completed'),
        messageId: 'compact-root',
        summary: 'Kept the important implementation details.',
        compactedThroughMessageId: 'assistant-before-compact',
        trigger: 'manual',
      },
      {
        ...base(6, 'user_message.created', systemActor),
        messageId: 'compact-root',
        parentMessageId: null,
        content: [
          { type: 'text', text: 'Conversation compacted.' },
          { type: 'text', text: systemReminder('Kept the important implementation details.') },
        ],
      },
    ]);

    const projection = buildAgentRenderProjection(state, { revision: 1 });

    expect(projection.rows).toEqual([{
      id: 'compaction:compact-root',
      kind: 'compaction',
      messageId: 'compact-root',
      compactionId: 'event-5',
    }]);
    expect(projection.transcriptRows).toEqual([
      { id: 'archived:user:user-before-compact', kind: 'message', messageId: 'user-before-compact', archived: true },
      { id: 'archived:assistant:assistant-before-compact', kind: 'message', messageId: 'assistant-before-compact', archived: true },
      { id: 'compaction:compact-root', kind: 'compaction', messageId: 'compact-root', compactionId: 'event-5' },
    ]);
    expect(projection.entities.compactions['event-5']).toMatchObject({
      messageId: 'compact-root',
      summary: 'Kept the important implementation details.',
      trigger: 'manual',
    });
  });

  test('reconstructs consecutive compact boundaries as one transcript timeline', () => {
    const state = replayAgentEvents([
      { ...base(1, 'session.created'), title: 'Nested compaction' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'u1',
        parentMessageId: null,
        content: [{ type: 'text', text: 'First question' }],
      },
      {
        ...base(3, 'assistant_message.started', agentActor),
        runId: 'run-1',
        messageId: 'a1',
        parentMessageId: 'u1',
        providerId: 'test-provider',
        modelId: 'test-model',
      },
      {
        ...base(4, 'assistant_message.completed', agentActor),
        messageId: 'a1',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'First answer' }],
      },
      {
        ...base(5, 'compaction.completed'),
        messageId: 'compact-1',
        summary: 'First compact summary.',
        compactedThroughMessageId: 'a1',
        trigger: 'manual',
      },
      {
        ...base(6, 'user_message.created', systemActor),
        messageId: 'compact-1',
        parentMessageId: null,
        content: [
          { type: 'text', text: 'Conversation compacted.' },
          { type: 'text', text: systemReminder('First compact summary.') },
        ],
      },
      {
        ...base(7, 'user_message.created', userActor),
        messageId: 'u2',
        parentMessageId: 'compact-1',
        content: [{ type: 'text', text: 'Second question' }],
      },
      {
        ...base(8, 'assistant_message.started', agentActor),
        runId: 'run-2',
        messageId: 'a2',
        parentMessageId: 'u2',
        providerId: 'test-provider',
        modelId: 'test-model',
      },
      {
        ...base(9, 'assistant_message.completed', agentActor),
        messageId: 'a2',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Second answer' }],
      },
      {
        ...base(10, 'compaction.completed'),
        messageId: 'compact-2',
        summary: 'Second compact summary.',
        compactedThroughMessageId: 'a2',
        trigger: 'manual',
      },
      {
        ...base(11, 'user_message.created', systemActor),
        messageId: 'compact-2',
        parentMessageId: null,
        content: [
          { type: 'text', text: 'Conversation compacted.' },
          { type: 'text', text: systemReminder('Second compact summary.') },
        ],
      },
      {
        ...base(12, 'user_message.created', userActor),
        messageId: 'u3',
        parentMessageId: 'compact-2',
        content: [{ type: 'text', text: 'Current question' }],
      },
    ]);

    const projection = buildAgentRenderProjection(state, { revision: 1 });

    expect(projection.rows.map((row) => row.id)).toEqual([
      'compaction:compact-2',
      'user:u3',
    ]);
    expect(projection.transcriptRows.map((row) => row.id)).toEqual([
      'archived:user:u1',
      'archived:assistant:a1',
      'archived:compaction:compact-1',
      'archived:user:u2',
      'archived:assistant:a2',
      'compaction:compact-2',
      'user:u3',
    ]);
  });

  test('keeps large media details as payload refs in message entities', () => {
    const payload: AgentPayloadRef = {
      kind: 'payload_ref',
      id: 'image-source',
      storage: 'file',
      mimeType: 'image/png',
      byteLength: 10_000,
      sha256: 'sha',
      role: 'source',
      summary: 'Screenshot',
      display: { width: 800, height: 600 },
    };
    const state = replayAgentEvents([
      { ...base(1, 'session.created'), title: 'Media' },
      { ...base(2, 'payload.created'), payload },
      {
        ...base(3, 'user_message.created', userActor),
        messageId: 'user-media',
        parentMessageId: null,
        content: [{ type: 'image', imageRef: payload, alt: 'Screenshot attachment' }],
        attachments: [payload],
      },
    ]);

    const projection = buildAgentRenderProjection(state, { revision: 1 });

    expect(projection.entities.messages['user-media']?.content).toEqual([{
      type: 'image',
      imageRef: payload,
      alt: 'Screenshot attachment',
    }]);
  });

  test('keeps large tool output as a payload ref in message entities', () => {
    const payload: AgentPayloadRef = {
      kind: 'payload_ref',
      id: 'tool-output-1',
      storage: 'file',
      mimeType: 'text/plain',
      byteLength: 50_000,
      sha256: 'tool-output-sha',
      role: 'tool_output',
      summary: 'file_read output: long result...',
      truncated: true,
    };
    const replacement = '<persisted-output>\nPreview\n</persisted-output>';
    const state = replayAgentEvents([
      { ...base(1, 'session.created'), title: 'Tools' },
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
    ]);

    const projection = buildAgentRenderProjection(state, { revision: 1 });

    expect(projection.entities.messages['tool-result-1']?.content).toEqual([{
      type: 'payload_ref',
      payload,
      label: replacement,
    }]);
  });
});
