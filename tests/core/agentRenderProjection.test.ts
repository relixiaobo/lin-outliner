import { describe, expect, test } from 'bun:test';
import { replayAgentEvents, type AgentActor, type AgentEvent, type AgentRunMeta } from '../../src/core/agentEventLog';
import { buildAgentRenderProjection } from '../../src/core/agentRenderProjection';
import { systemReminder } from '../../src/core/agentAttachments';
import { DEFAULT_DREAM_CHANNEL_ID } from '../../src/core/agentChannel';

const conversationId = 'conversation-render';
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

describe('agent render projection', () => {
  test('builds compact rows and streaming state from the active path', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Render test' },
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
      runActive: true,
    });

    expect(projection.rows).toEqual([
      { id: 'user:user-1', kind: 'message', messageId: 'user-1' },
      { id: 'assistant:assistant-1', kind: 'message', messageId: 'assistant-1' },
    ]);
    expect(projection.transcriptRows).toEqual(projection.rows);
    expect(projection.entities.messages['user-1']?.sourceSeq).toBe(2);
    expect(projection.entities.messages['user-1']?.sourceSeqs).toEqual([2]);
    expect(projection.entities.messages['assistant-1']?.sourceSeq).toBeUndefined();
    expect(projection.entities.messages['assistant-1']?.sourceSeqs).toBeUndefined();
    expect(projection.entities.messages['assistant-1']?.status).toBe('streaming');
    expect(projection.streaming).toMatchObject({
      messageId: 'assistant-1',
      rowId: 'assistant:assistant-1',
      text: 'Partial answer',
    });
  });

  test('projects render runs from Run metadata input', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Run metadata projection' },
    ]);
    const run: AgentRunMeta = {
      id: 'run-sub-1',
      agentId: 'built-in:tenon:assistant',
      anchor: { type: 'conversation', agentId: 'built-in:tenon:assistant', conversationId },
      parentRunId: 'run-parent-1',
      parentToolCallId: 'tool-agent-1',
      disposition: 'detached',
      context: 'brief',
      runProfile: 'research',
      trigger: { type: 'parent-run', parentRunId: 'run-parent-1' },
      fingerprint: {
        appVersion: 'test',
        promptHash: 'prompt',
        toolSchemaHash: 'tools',
        skillBindings: [],
        modelConfig: 'model',
      },
      retention: 'hot',
      createdAt: 100,
      updatedAt: 250,
      latestSeq: 7,
      execution: {
        status: 'completed',
        completedAt: 250,
      },
      objective: {
        text: 'Inspect the projection seam.',
        criteria: [],
        role: 'worker',
        status: 'verified',
      },
    };

    const projection = buildAgentRenderProjection(state, {
      revision: 1,
      runs: [run],
      runProfileLabels: { research: 'Research' },
      runTitles: { 'run-sub-1': 'Inspect projection' },
    });

    expect(projection.runIds).toEqual(['run-sub-1']);
    expect(projection.entities.runs['run-sub-1']).toMatchObject({
      id: 'run-sub-1',
      conversationId,
      title: 'Inspect projection',
      parentRunId: 'run-parent-1',
      parentToolCallId: 'tool-agent-1',
      runProfile: 'research',
      runProfileLabel: 'Research',
      status: 'completed',
      objectiveStatus: 'verified',
      objectiveRole: 'worker',
      context: 'brief',
      startedAt: 100,
      updatedAt: 250,
      completedAt: 250,
    });
  });

  test('threads the producing run wall-clock onto the message entity as runDurationMs', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Worked for' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-1',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Question' }],
      },
      { ...base(3, 'run.started'), runId: 'run-1', agentId: 'agent-1' },
      {
        ...base(4, 'assistant_message.started', agentActor),
        runId: 'run-1',
        messageId: 'assistant-1',
        parentMessageId: 'user-1',
        providerId: 'test-provider',
        modelId: 'test-model',
      },
      {
        ...base(5, 'assistant_message.completed', agentActor),
        messageId: 'assistant-1',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Answer.' }],
      },
      { ...base(9, 'run.completed'), runId: 'run-1' },
    ]);

    const projection = buildAgentRenderProjection(state, { revision: 1 });

    const run = state.runs['run-1'];
    expect(run).toBeDefined();
    expect(run!.updatedAt - run!.startedAt).toBeGreaterThan(0);
    expect(projection.entities.messages['assistant-1']?.sourceSeq).toBe(5);
    expect(projection.entities.messages['assistant-1']?.sourceSeqs).toEqual([5]);
    expect(projection.entities.messages['assistant-1']?.runDurationMs).toBe(run!.updatedAt - run!.startedAt);
  });

  test('keeps every user message evidence seq so old chat-source refs survive edits', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Edited source' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-1',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Original question' }],
      },
      {
        ...base(3, 'user_message.edited', userActor),
        messageId: 'user-1',
        content: [{ type: 'text', text: 'Edited question' }],
      },
    ]);

    const projection = buildAgentRenderProjection(state, { revision: 1 });

    expect(projection.entities.messages['user-1']?.sourceSeq).toBe(2);
    expect(projection.entities.messages['user-1']?.sourceSeqs).toEqual([2, 3]);
  });

  test('leaves runDurationMs undefined while the producing run is still running', () => {
    // `run.updatedAt` only moves at start and at the terminal event, so a run left
    // `running` (a crash/quit before run.completed, or simply mid-flight) has
    // updatedAt === startedAt. That is unknown timing, NOT a 0ms "<1s" turn, so the
    // entity must omit the duration and let the header fall back to its summary.
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Worked for' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-1',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Question' }],
      },
      { ...base(3, 'run.started'), runId: 'run-1', agentId: 'agent-1' },
      {
        ...base(4, 'assistant_message.started', agentActor),
        runId: 'run-1',
        messageId: 'assistant-1',
        parentMessageId: 'user-1',
        providerId: 'test-provider',
        modelId: 'test-model',
      },
      {
        ...base(5, 'assistant_message.completed', agentActor),
        messageId: 'assistant-1',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Partial answer.' }],
      },
      // No run.completed/failed/cancelled — the run stays 'running'.
    ]);

    const projection = buildAgentRenderProjection(state, { revision: 1 });

    expect(state.runs['run-1']?.status).toBe('running');
    expect(projection.entities.messages['assistant-1']?.runDurationMs).toBeUndefined();
  });

  test('a DM streams its active turn into the transcript (no Channel suppression)', () => {
    // Single-agent DM: even with the run still running, the active turn stays a
    // transcript row — DM turns stream live; suppression is Channel-only.
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'DM' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-1',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Question' }],
      },
      { ...base(3, 'run.started'), runId: 'run-1', agentId: 'agent-1' },
      {
        ...base(4, 'assistant_message.started', agentActor),
        runId: 'run-1',
        messageId: 'assistant-1',
        parentMessageId: 'user-1',
        providerId: 'p',
        modelId: 'm',
      },
      {
        ...base(5, 'assistant_message.delta', agentActor),
        messageId: 'assistant-1',
        delta: { type: 'text_delta', text: 'Streaming…' },
        providerChunkCount: 1,
        startedAt: 10,
        endedAt: 11,
      },
    ]);

    const projection = buildAgentRenderProjection(state, { revision: 1 });
    expect(state.runs['run-1']?.status).toBe('running');
    expect(projection.transcriptRows.filter((row) => row.kind === 'message').map((row) => row.messageId))
      .toContain('assistant-1');
  });

  test('keeps branch state on message entities without persisting a tree', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Branches' },
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
        source: { fromMessageId: 'user-before-compact', throughMessageId: 'assistant-before-compact' },
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

  test('projects context clears as boundary rows instead of user bubbles', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Clear' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-before-clear',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Old question' }],
      },
      {
        ...base(3, 'assistant_message.started', agentActor),
        runId: 'run-before-clear',
        messageId: 'assistant-before-clear',
        parentMessageId: 'user-before-clear',
        providerId: 'test-provider',
        modelId: 'test-model',
      },
      {
        ...base(4, 'assistant_message.completed', agentActor),
        messageId: 'assistant-before-clear',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Old answer' }],
      },
      {
        ...base(5, 'context.cleared'),
        messageId: 'clear-root',
        source: { fromMessageId: 'user-before-clear', throughMessageId: 'assistant-before-clear' },
      },
      {
        ...base(6, 'user_message.created', systemActor),
        messageId: 'clear-root',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Context cleared.' }],
      },
    ]);

    const projection = buildAgentRenderProjection(state, { revision: 1 });

    expect(projection.rows).toEqual([{
      id: 'context-clear:clear-root',
      kind: 'context-clear',
      messageId: 'clear-root',
      contextClearId: 'event-5',
    }]);
    expect(projection.transcriptRows).toEqual([
      { id: 'archived:user:user-before-clear', kind: 'message', messageId: 'user-before-clear', archived: true },
      { id: 'archived:assistant:assistant-before-clear', kind: 'message', messageId: 'assistant-before-clear', archived: true },
      { id: 'context-clear:clear-root', kind: 'context-clear', messageId: 'clear-root', contextClearId: 'event-5' },
    ]);
    expect(projection.entities.contextClears['event-5']).toMatchObject({
      messageId: 'clear-root',
      source: { fromMessageId: 'user-before-clear', throughMessageId: 'assistant-before-clear' },
    });
  });

  test('projects Dream markers as boundary rows instead of user bubbles', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Dream' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-before-dream',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Remember concise answers.' }],
      },
      {
        ...base(3, 'dream.finished'),
        messageId: 'dream-anchor',
        agentId: 'built-in:tenon:assistant',
        runId: 'dream-run-1',
        trigger: 'manual',
        status: 'completed',
        startedAt: 1_700_000_000_010,
        completedAt: 1_700_000_000_020,
        processed: {
          conversations: {},
          totalMessageCount: 1,
          totalCharCount: 120,
          consolidateOnly: false,
        },
        changes: { added: 1, updated: 0, forgotten: 0, skipped: 0 },
      },
      {
        ...base(4, 'user_message.created', systemActor),
        messageId: 'dream-anchor',
        parentMessageId: 'user-before-dream',
        content: [{ type: 'text', text: systemReminder('Memory Dream completed.') }],
      },
      {
        ...base(5, 'branch.selected'),
        leafMessageId: 'dream-anchor',
      },
    ]);

    const projection = buildAgentRenderProjection(state, { revision: 1 });

    expect(projection.rows).toEqual([
      { id: 'user:user-before-dream', kind: 'message', messageId: 'user-before-dream' },
      { id: 'dream:dream-anchor', kind: 'dream', messageId: 'dream-anchor', dreamId: 'event-3' },
    ]);
    expect(projection.transcriptRows).toEqual(projection.rows);
    expect(projection.entities.dreams['event-3']).toMatchObject({
      messageId: 'dream-anchor',
      runId: 'dream-run-1',
      status: 'completed',
      changes: { added: 1, updated: 0, forgotten: 0, skipped: 0 },
    });
  });

  test('keeps Dream channel markers attached to their anchor messages', () => {
    const dreamBase = (seq: number, type: AgentEvent['type'], actor: AgentActor = systemActor) => ({
      ...base(seq, type, actor),
      conversationId: DEFAULT_DREAM_CHANNEL_ID,
    });
    const state = replayAgentEvents([
      { ...dreamBase(1, 'conversation.created'), title: 'Dream' },
      {
        ...dreamBase(2, 'user_message.created', userActor),
        messageId: 'user-before-dream',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Remember concise answers.' }],
      },
      {
        ...dreamBase(3, 'dream.finished'),
        messageId: 'dream-anchor',
        agentId: 'built-in:tenon:assistant',
        runId: 'dream-run-1',
        trigger: 'manual',
        status: 'completed',
        startedAt: 1_700_000_000_010,
        completedAt: 1_700_000_000_020,
        processed: {
          conversations: {},
          totalMessageCount: 1,
          totalCharCount: 120,
          consolidateOnly: false,
        },
        changes: { added: 1, updated: 0, forgotten: 0, skipped: 0 },
      },
      {
        ...dreamBase(4, 'user_message.created', systemActor),
        messageId: 'dream-anchor',
        parentMessageId: 'user-before-dream',
        content: [
          { type: 'text', text: systemReminder('Memory Dream completed.') },
          { type: 'text', text: 'Manual Dream · 1 messages · 120 chars' },
        ],
      },
      {
        ...dreamBase(5, 'branch.selected'),
        leafMessageId: 'dream-anchor',
      },
    ]);

    const projection = buildAgentRenderProjection(state, { revision: 1 });

    expect(projection.rows).toEqual([
      { id: 'user:user-before-dream', kind: 'message', messageId: 'user-before-dream' },
      { id: 'user:dream-anchor', kind: 'message', messageId: 'dream-anchor' },
    ]);
    expect(projection.transcriptRows).toEqual(projection.rows);
    expect(projection.entities.messages['dream-anchor']).toMatchObject({
      id: 'dream-anchor',
      role: 'user',
    });
    expect(projection.entities.dreams).toEqual({});
  });

  test('reconstructs consecutive compact boundaries as one transcript timeline', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Nested compaction' },
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
        source: { fromMessageId: 'u1', throughMessageId: 'a1' },
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
        source: { fromMessageId: 'compact-1', throughMessageId: 'a2' },
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
      { ...base(1, 'conversation.created'), title: 'Media' },
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
      { ...base(1, 'conversation.created'), title: 'Tools' },
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

  test('ignores parentless child-run markers in the render projection', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Command delivery' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-1',
        parentMessageId: null,
        content: [{ type: 'text', text: 'go' }],
      },
      {
        ...base(3, 'child_run.started', agentActor),
        childRunId: 'sub-1',
        description: 'check Chengdu weather',
        prompt: 'Check the weather in Chengdu today.',
        agentType: 'researcher',
        contextMode: 'fork',
      },
      {
        ...base(4, 'child_run.updated', agentActor),
        childRunId: 'sub-1',
        status: 'completed',
        completedAt: 1_700_000_000_900,
        result: 'Partly cloudy, 22–29°C.',
      },
    ]);

    const projection = buildAgentRenderProjection(state, { revision: 1 });

    expect(projection.transcriptRows.map((row) => row.id)).toEqual(['user:user-1']);
    expect(projection.runIds).toEqual([]);
  });

  test('projects a cancelled run as the presentation status `stopped`', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Command delivery' },
    ]);
    const run: AgentRunMeta = {
      id: 'sub-1',
      agentId: 'built-in:tenon:researcher',
      anchor: { type: 'conversation', agentId: 'built-in:tenon:assistant', conversationId },
      disposition: 'detached',
      context: 'brief',
      runProfile: 'default',
      trigger: { type: 'manual' },
      fingerprint: {
        appVersion: 'test',
        promptHash: 'prompt',
        toolSchemaHash: 'tools',
        skillBindings: [],
        modelConfig: 'model',
      },
      retention: 'hot',
      createdAt: 100,
      updatedAt: 900,
      latestSeq: 3,
      execution: {
        status: 'cancelled',
        completedAt: 900,
      },
      objective: {
        text: 'Check the weather in Chengdu today.',
        criteria: [],
        role: 'worker',
        status: 'cancelled',
      },
    };

    const projection = buildAgentRenderProjection(state, { revision: 1, runs: [run] });

    // The data vocabulary is `cancelled`; the render projection is the one seam
    // that maps it to the user-facing word `stopped`, so renderer components
    // never see `cancelled`.
    expect(projection.entities.runs['sub-1']?.status).toBe('stopped');
  });

  test('folds a DM main-agent child run into its spawning turn — no boundary row', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Spawning turn' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-1',
        parentMessageId: null,
        content: [{ type: 'text', text: 'do it' }],
      },
      {
        ...base(3, 'assistant_message.started', agentActor),
        runId: 'run-1',
        messageId: 'assistant-1',
        parentMessageId: 'user-1',
      },
      {
        ...base(4, 'assistant_message.completed', agentActor),
        messageId: 'assistant-1',
        stopReason: 'tool_use',
        content: [{ type: 'toolCall', id: 'tc-1', name: 'Task', arguments: {} }],
      },
      {
        ...base(5, 'child_run.started', agentActor),
        childRunId: 'sub-1',
        parentToolCallId: 'tc-1',
        description: 'do the subtask',
        prompt: 'Do the subtask.',
        agentType: 'researcher',
        contextMode: 'fork',
      },
      {
        ...base(6, 'child_run.updated', agentActor),
        childRunId: 'sub-1',
        status: 'completed',
        completedAt: 1_700_000_000_900,
        result: 'done',
      },
    ]);

    const run: AgentRunMeta = {
      id: 'sub-1',
      agentId: 'built-in:tenon:researcher',
      anchor: { type: 'conversation', agentId: 'built-in:tenon:assistant', conversationId },
      parentRunId: 'run-1',
      parentToolCallId: 'tc-1',
      disposition: 'detached',
      context: 'brief',
      runProfile: 'default',
      trigger: { type: 'parent-run', parentRunId: 'run-1' },
      fingerprint: {
        appVersion: 'test',
        promptHash: 'prompt',
        toolSchemaHash: 'tools',
        skillBindings: [],
        modelConfig: 'model',
      },
      retention: 'hot',
      createdAt: 100,
      updatedAt: 900,
      latestSeq: 6,
      execution: {
        status: 'completed',
        completedAt: 900,
      },
      objective: {
        text: 'Do the subtask.',
        criteria: [],
        role: 'worker',
        status: 'verified',
      },
    };

    const projection = buildAgentRenderProjection(state, { revision: 1, runs: [run] });

    // A DM child run spawned by a tool call folds into its spawning turn's process
    // (the tool-call row renders the sub-run summary inline from Run metadata), so
    // it gets NO conversation-level boundary row that could orphan to the
    // transcript end on an edit.
    expect(projection.transcriptRows.map((row) => row.id))
      .toEqual(['user:user-1', 'assistant:assistant-1']);
    expect(projection.runIds).toEqual(['sub-1']);
    expect(projection.entities.runs['sub-1']).toMatchObject({
      id: 'sub-1',
      parentToolCallId: 'tc-1',
      title: 'Do the subtask.',
    });
  });

  // The authoritative interrupted verdict — derived from the producing run's REAL
  // status, never from whether the visible blocks end on answer prose. This is the
  // single source of truth that stops the recurring Channel mislabel where a
  // cleanly-completed turn that ended on a tool was painted red "Interrupted".
  describe('turnInterrupted', () => {
    // A turn that ended on a tool call with NO trailing answer prose — the exact
    // shape the old `turnEnded && !finalIsProse` heuristic mislabeled. With a
    // `completed` run it must NOT be interrupted.
    function resultlessTurn(runTerminal: 'completed' | 'failed' | 'cancelled' | null) {
      const events: AgentEvent[] = [
        { ...base(1, 'conversation.created'), title: 'Interrupted verdict' } as AgentEvent,
        {
          ...base(2, 'user_message.created', userActor),
          messageId: 'user-1',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Shanghai weather?' }],
        } as AgentEvent,
        { ...base(3, 'run.started'), runId: 'run-1', agentId: 'agent-1' } as AgentEvent,
        {
          ...base(4, 'assistant_message.started', agentActor),
          runId: 'run-1',
          messageId: 'assistant-1',
          parentMessageId: 'user-1',
          providerId: 'p',
          modelId: 'm',
        } as AgentEvent,
        {
          ...base(5, 'assistant_message.completed', agentActor),
          messageId: 'assistant-1',
          stopReason: 'stop',
          // Ends on a tool call — no trailing answer prose.
          content: [
            { type: 'thinking', thinking: 'Fetching Shanghai weather' },
            { type: 'toolCall', id: 'call-1', name: 'web_fetch', input: { url: 'https://weather' } },
          ],
        } as AgentEvent,
      ];
      if (runTerminal === 'completed') events.push({ ...base(6, 'run.completed'), runId: 'run-1' } as AgentEvent);
      if (runTerminal === 'failed') events.push({ ...base(6, 'run.failed'), runId: 'run-1', errorMessage: 'boom' } as AgentEvent);
      if (runTerminal === 'cancelled') events.push({ ...base(6, 'run.cancelled'), runId: 'run-1' } as AgentEvent);
      return replayAgentEvents(events);
    }

    test('a completed turn that ended on a tool is NOT interrupted (the core fix)', () => {
      const state = resultlessTurn('completed');
      const projection = buildAgentRenderProjection(state, { revision: 1 });
      expect(state.runs['run-1']?.status).toBe('completed');
      expect(projection.entities.messages['assistant-1']?.turnInterrupted).toBeFalsy();
    });

    test('a failed turn is interrupted', () => {
      const state = resultlessTurn('failed');
      const projection = buildAgentRenderProjection(state, { revision: 1 });
      expect(projection.entities.messages['assistant-1']?.turnInterrupted).toBe(true);
    });

    test('a cancelled turn is interrupted', () => {
      const state = resultlessTurn('cancelled');
      const projection = buildAgentRenderProjection(state, { revision: 1 });
      expect(projection.entities.messages['assistant-1']?.turnInterrupted).toBe(true);
    });

    test('a live in-flight run is NOT interrupted; the same run orphaned (not live) is', () => {
      const state = resultlessTurn(null);
      expect(state.runs['run-1']?.status).toBe('running');

      // Live: the run is in the active set → still working, not interrupted.
      const live = buildAgentRenderProjection(state, {
        revision: 1,
        activeRuns: [{ runId: 'run-1', agentId: 'agent-1', startedAt: 1 }],
      });
      expect(live.entities.messages['assistant-1']?.turnInterrupted).toBeFalsy();

      // Crash-orphaned: persisted `running` but absent from the live set → interrupted.
      const orphaned = buildAgentRenderProjection(state, { revision: 1 });
      expect(orphaned.entities.messages['assistant-1']?.turnInterrupted).toBe(true);
    });
  });
});
