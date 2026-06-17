import { describe, expect, test } from 'bun:test';
import { replayAgentEvents, type AgentActor, type AgentEvent } from '../../src/core/agentEventLog';
import { buildAgentRenderProjection, type AgentRenderActivityEntry } from '../../src/core/agentRenderProjection';
import { systemReminder } from '../../src/core/agentAttachments';

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
      dmRunActive: true,
    });

    expect(projection.rows).toEqual([
      { id: 'user:user-1', kind: 'message', messageId: 'user-1' },
      { id: 'assistant:assistant-1', kind: 'message', messageId: 'assistant-1' },
    ]);
    expect(projection.transcriptRows).toEqual(projection.rows);
    expect(projection.entities.messages['assistant-1']?.status).toBe('streaming');
    expect(projection.dmStreaming).toMatchObject({
      messageId: 'assistant-1',
      rowId: 'assistant:assistant-1',
      text: 'Partial answer',
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
    expect(projection.entities.messages['assistant-1']?.runDurationMs).toBe(run!.updatedAt - run!.startedAt);
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

  test('surfaces a parentless child run (a command fire) as a transcript boundary row', () => {
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

    // The run is placed by start time after the user message and carries its result.
    expect(projection.transcriptRows.map((row) => row.id)).toEqual(['user:user-1', 'child-run:sub-1']);
    const childRunRow = projection.transcriptRows.find((row) => row.kind === 'child-run');
    expect(childRunRow).toMatchObject({ kind: 'child-run', childRunId: 'sub-1' });
    expect(projection.entities.childRuns['sub-1']?.result).toBe('Partly cloudy, 22–29°C.');
  });

  test('projects a cancelled child run as the presentation status `stopped`', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Command delivery' },
      {
        ...base(2, 'child_run.started', agentActor),
        childRunId: 'sub-1',
        executingAgentId: 'built-in:tenon:researcher',
        parentAgentId: 'built-in:tenon:assistant',
        memoryOwnerAgentId: 'built-in:tenon:researcher',
        description: 'check Chengdu weather',
        prompt: 'Check the weather in Chengdu today.',
        agentType: 'researcher',
        contextMode: 'fork',
      },
      {
        ...base(3, 'child_run.updated', agentActor),
        childRunId: 'sub-1',
        status: 'cancelled',
        completedAt: 1_700_000_000_900,
      },
    ]);

    const projection = buildAgentRenderProjection(state, { revision: 1 });

    // The data vocabulary is `cancelled`; the render projection is the one seam
    // that maps it to the user-facing word `stopped`, on BOTH the entity and the
    // task — so renderer components never see `cancelled`.
    expect(projection.entities.childRuns['sub-1']?.status).toBe('stopped');
    expect(projection.entities.tasks['child-run:sub-1']?.status).toBe('stopped');
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

    const projection = buildAgentRenderProjection(state, { revision: 1 });

    // A DM child run spawned by a tool call folds into its spawning turn's process
    // (the tool-call row renders the child-run summary + result inline), so it gets
    // NO conversation-level boundary row — that would orphan to the transcript end
    // on an edit. The child-run entity stays available (keyed by its parent tool
    // call) for the renderer to fold into the process.
    expect(projection.transcriptRows.map((row) => row.id))
      .toEqual(['user:user-1', 'assistant:assistant-1']);
    expect(projection.transcriptRows.some((row) => row.kind === 'child-run')).toBe(false);
    expect(projection.entities.childRuns['sub-1']).toMatchObject({
      id: 'sub-1',
      parentToolCallId: 'tc-1',
      result: 'done',
    });
  });

  test('keeps a multi-agent Channel child run as a boundary row (a visible participant turn)', () => {
    const state = replayAgentEvents([
      {
        ...base(1, 'conversation.created'),
        title: 'Channel',
        members: [
          { type: 'user', userId: 'user-1' },
          { type: 'agent', agentId: 'agent-1' },
          { type: 'agent', agentId: 'agent-2' },
        ],
      },
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
      // Seal the parent run so the Channel live-suppression rule does not hold the
      // boundary back — we are asserting the resting (sealed) Channel placement.
      { ...base(5, 'run.completed'), runId: 'run-1' },
      {
        ...base(6, 'child_run.started', agentActor),
        childRunId: 'sub-1',
        parentRunId: 'run-1',
        parentToolCallId: 'tc-1',
        description: 'do the subtask',
        prompt: 'Do the subtask.',
        agentType: 'researcher',
        contextMode: 'fork',
      },
      {
        ...base(7, 'child_run.updated', agentActor),
        childRunId: 'sub-1',
        status: 'completed',
        completedAt: 1_700_000_000_900,
        result: 'done',
      },
    ]);

    const projection = buildAgentRenderProjection(state, { revision: 1 });

    // In a multi-agent Channel a delegated child run is a visible participant turn,
    // so it keeps its conversation-level boundary row (unchanged behavior).
    expect(projection.transcriptRows.some((row) => row.kind === 'child-run' && row.id === 'child-run:sub-1')).toBe(true);
  });

  test('derives Channel activity entries from an active addressed run', () => {
    const state = replayAgentEvents([
      {
        ...base(1, 'conversation.created'),
        title: 'Channel',
        members: [
          { type: 'user', userId: 'user-1' },
          { type: 'agent', agentId: 'agent-1' },
          { type: 'agent', agentId: 'agent-2' },
          { type: 'agent', agentId: 'agent-3' },
        ],
      },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-channel',
        parentMessageId: null,
        content: [{ type: 'text', text: '@one @two @three compare this.' }],
        addressedTo: [
          { type: 'agent', agentId: 'agent-1' },
          { type: 'agent', agentId: 'agent-2' },
          { type: 'agent', agentId: 'agent-3' },
        ],
      },
      { ...base(3, 'run.started'), runId: 'run-agent-1', agentId: 'agent-1' },
      {
        ...base(4, 'assistant_message.started', agentActor),
        runId: 'run-agent-1',
        messageId: 'assistant-agent-1',
        parentMessageId: 'user-channel',
        providerId: 'test-provider',
        modelId: 'test-model',
      },
      {
        ...base(5, 'assistant_message.completed', agentActor),
        messageId: 'assistant-agent-1',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Agent one done.' }],
      },
      { ...base(6, 'run.completed'), runId: 'run-agent-1' },
      { ...base(7, 'run.started'), runId: 'run-agent-2', agentId: 'agent-2' },
    ]);

    const projection = buildAgentRenderProjection(state, {
      revision: 1,
      activeRunId: 'run-agent-2',
      activeRunAddressedByMessageId: 'user-channel',
      pendingToolCallIds: ['tool-call-2'],
    });

    expect(projection.channelActivityEntries).toEqual([
      {
        id: 'user-channel:agent-2',
        agentId: 'agent-2',
        runId: 'run-agent-2',
        messageId: null,
        addressedByMessageId: 'user-channel',
        state: 'using_tools',
        pendingToolCallIds: ['tool-call-2'],
        updatedAt: 1_700_000_000_007,
      },
      {
        id: 'user-channel:agent-3',
        agentId: 'agent-3',
        runId: null,
        messageId: null,
        addressedByMessageId: 'user-channel',
        state: 'received',
        updatedAt: 1_700_000_000_002,
      },
    ]);
  });

  test('carries live Channel activity content for the per-run detail view', () => {
    const state = replayAgentEvents([
      {
        ...base(1, 'conversation.created'),
        title: 'Channel',
        members: [
          { type: 'user', userId: 'user-1' },
          { type: 'agent', agentId: 'agent-1' },
          { type: 'agent', agentId: 'agent-2' },
        ],
      },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-channel',
        parentMessageId: null,
        content: [{ type: 'text', text: '@one @two compare this.' }],
        addressedTo: [
          { type: 'agent', agentId: 'agent-1' },
          { type: 'agent', agentId: 'agent-2' },
        ],
      },
      { ...base(3, 'run.started'), runId: 'run-agent-1', agentId: 'agent-1' },
      {
        ...base(4, 'assistant_message.started', agentActor),
        runId: 'run-agent-1',
        messageId: 'assistant-agent-1',
        parentMessageId: 'user-channel',
        providerId: 'test-provider',
        modelId: 'test-model',
      },
      {
        ...base(5, 'assistant_message.completed', agentActor),
        messageId: 'assistant-agent-1',
        stopReason: 'toolUse',
        content: [
          { type: 'thinking', thinking: 'Checking the source.' },
          { type: 'toolCall', id: 'tool-agent-1', name: 'web_fetch', arguments: { url: 'https://example.test' } },
          { type: 'text', text: 'Drafting answer.' },
        ],
      },
    ]);

    const projection = buildAgentRenderProjection(state, {
      revision: 1,
      activeRunId: 'run-agent-1',
      activeRunAddressedByMessageId: 'user-channel',
      pendingToolCallIds: ['tool-agent-1'],
    });

    expect(projection.channelActivityEntries[0]).toMatchObject({
      id: 'user-channel:agent-1',
      agentId: 'agent-1',
      runId: 'run-agent-1',
      messageId: 'assistant-agent-1',
      state: 'using_tools',
      streamingText: 'Drafting answer.',
      streamingContent: [
        { type: 'thinking', thinking: 'Checking the source.' },
        { type: 'toolCall', id: 'tool-agent-1', name: 'web_fetch', arguments: { url: 'https://example.test' } },
        { type: 'text', text: 'Drafting answer.' },
      ],
    });
  });

  test('uses the Channel activity surface for a one-agent Channel', () => {
    const channelConversationId = 'lin-agent-channel-solo';
    const channelBase = (seq: number, type: AgentEvent['type'], actor: AgentActor = systemActor) => ({
      ...base(seq, type, actor),
      conversationId: channelConversationId,
    });
    const state = replayAgentEvents([
      {
        ...channelBase(1, 'conversation.created'),
        title: 'Solo Channel',
        members: [
          { type: 'user', userId: 'user-1' },
          { type: 'agent', agentId: 'agent-1' },
        ],
      },
      {
        ...channelBase(2, 'user_message.created', userActor),
        messageId: 'user-solo',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Handle this in the Channel.' }],
        addressedTo: [{ type: 'agent', agentId: 'agent-1' }],
      },
      {
        ...channelBase(3, 'run.started'),
        runId: 'run-solo',
        agentId: 'agent-1',
        addressedByMessageId: 'user-solo',
      },
      {
        ...channelBase(4, 'assistant_message.started', agentActor),
        runId: 'run-solo',
        messageId: 'assistant-solo',
        parentMessageId: 'user-solo',
        addressedByMessageId: 'user-solo',
        providerId: 'test-provider',
        modelId: 'test-model',
      },
      {
        ...channelBase(5, 'assistant_message.delta', agentActor),
        messageId: 'assistant-solo',
        delta: { type: 'text_delta', text: 'Working through the Channel detail.' },
        providerChunkCount: 1,
        startedAt: 10,
        endedAt: 11,
      },
    ]);

    const projection = buildAgentRenderProjection(state, {
      revision: 1,
      activeRunId: 'run-solo',
      activeRunAddressedByMessageId: 'user-solo',
      activeRuns: [{
        runId: 'run-solo',
        agentId: 'agent-1',
        addressedByMessageId: 'user-solo',
        startedAt: 1_700_000_000_003,
      }],
    });

    expect(projection.dmRunActive).toBe(false);
    expect(projection.dmStreaming).toBeNull();
    expect(projection.transcriptRows).toEqual([
      { id: 'user:user-solo', kind: 'message', messageId: 'user-solo' },
    ]);
    expect(projection.channelActivityEntries[0]).toMatchObject({
      id: 'user-solo:agent-1',
      agentId: 'agent-1',
      runId: 'run-solo',
      messageId: 'assistant-solo',
      state: 'thinking',
      streamingText: 'Working through the Channel detail.',
      streamingContent: [{ type: 'text', text: 'Working through the Channel detail.' }],
    });
  });

  test('drops failed Channel addressees from derived activity even if no assistant message landed', () => {
    const state = replayAgentEvents([
      {
        ...base(1, 'conversation.created'),
        title: 'Channel',
        members: [
          { type: 'user', userId: 'user-1' },
          { type: 'agent', agentId: 'agent-1' },
          { type: 'agent', agentId: 'agent-2' },
          { type: 'agent', agentId: 'agent-3' },
        ],
      },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-channel',
        parentMessageId: null,
        content: [{ type: 'text', text: '@one @two @three compare this.' }],
        addressedTo: [
          { type: 'agent', agentId: 'agent-1' },
          { type: 'agent', agentId: 'agent-2' },
          { type: 'agent', agentId: 'agent-3' },
        ],
      },
      {
        ...base(3, 'run.started'),
        runId: 'run-agent-1',
        agentId: 'agent-1',
        addressedByMessageId: 'user-channel',
      },
      { ...base(4, 'run.failed'), runId: 'run-agent-1', errorMessage: 'boom' },
      {
        ...base(5, 'run.started'),
        runId: 'run-agent-2',
        agentId: 'agent-2',
        addressedByMessageId: 'user-channel',
      },
    ]);

    const projection = buildAgentRenderProjection(state, {
      revision: 1,
      activeRunId: 'run-agent-2',
      activeRunAddressedByMessageId: 'user-channel',
    });

    expect(projection.channelActivityEntries.map((entry) => entry.agentId)).toEqual(['agent-2', 'agent-3']);
  });

  test('accepts explicit message addressing for reply-anchor rendering', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Anchors' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-1',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Original question' }],
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
        ...base(4, 'assistant_message.completed', agentActor),
        messageId: 'assistant-1',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Later answer' }],
      },
    ]);

    const projection = buildAgentRenderProjection(state, {
      revision: 1,
      messageAddressedByMessageIds: { 'assistant-1': 'user-1' },
    });

    expect(projection.entities.messages['assistant-1']?.addressedByMessageId).toBe('user-1');
  });

  test('projects persisted reply-anchor addressing on completed assistant messages', () => {
    const state = replayAgentEvents([
      { ...base(1, 'conversation.created'), title: 'Historical anchors' },
      {
        ...base(2, 'user_message.created', userActor),
        messageId: 'user-original',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Original question' }],
      },
      {
        ...base(3, 'user_message.created', userActor),
        messageId: 'user-newer',
        parentMessageId: 'user-original',
        content: [{ type: 'text', text: 'Newer question' }],
      },
      { ...base(4, 'run.started'), runId: 'run-late', agentId: 'agent-1' },
      {
        ...base(5, 'assistant_message.started', agentActor),
        runId: 'run-late',
        messageId: 'assistant-late',
        parentMessageId: 'user-newer',
        addressedByMessageId: 'user-original',
        providerId: 'test-provider',
        modelId: 'test-model',
      },
      {
        ...base(6, 'assistant_message.completed', agentActor),
        messageId: 'assistant-late',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Late answer' }],
      },
      { ...base(7, 'run.completed'), runId: 'run-late' },
    ]);

    const projection = buildAgentRenderProjection(state, { revision: 1 });

    expect(projection.entities.messages['assistant-late']?.status).toBe('completed');
    expect(projection.entities.messages['assistant-late']?.addressedByMessageId).toBe('user-original');
  });

  test('keeps explicit Channel activity entries from multiple addressing messages', () => {
    const state = replayAgentEvents([
      {
        ...base(1, 'conversation.created'),
        title: 'Parallel activity',
        members: [
          { type: 'user', userId: 'user-1' },
          { type: 'agent', agentId: 'agent-1' },
          { type: 'agent', agentId: 'agent-2' },
        ],
      },
    ]);
    const toolArguments = { url: 'https://example.test/live' };
    const activityEntries: AgentRenderActivityEntry[] = [
      {
        id: 'user-1:agent-1',
        agentId: 'agent-1',
        runId: 'run-1',
        messageId: 'assistant-1',
        addressedByMessageId: 'user-1',
        state: 'thinking' as const,
        updatedAt: 1_700_000_000_010,
        pendingToolCallIds: ['tool-1'],
        streamingContent: [
          { type: 'toolCall', id: 'tool-1', name: 'web_fetch', arguments: toolArguments },
        ],
      },
      {
        id: 'user-2:agent-2',
        agentId: 'agent-2',
        runId: 'run-2',
        messageId: 'assistant-2',
        addressedByMessageId: 'user-2',
        state: 'using_tools' as const,
        updatedAt: 1_700_000_000_020,
      },
    ];

    const projection = buildAgentRenderProjection(state, {
      revision: 1,
      channelActivityEntries: activityEntries,
    });

    expect(projection.channelActivityEntries).toEqual(activityEntries);
    expect(projection.channelActivityEntries).not.toBe(activityEntries);
    expect(projection.channelActivityEntries[0]?.pendingToolCallIds).toEqual(['tool-1']);
    expect(projection.channelActivityEntries[0]?.pendingToolCallIds).not.toBe(activityEntries[0]?.pendingToolCallIds);
    const projectedTool = projection.channelActivityEntries[0]?.streamingContent?.[0];
    expect(projectedTool).toMatchObject({ type: 'toolCall', arguments: toolArguments });
    expect(projectedTool?.type === 'toolCall' ? projectedTool.arguments : null).not.toBe(toolArguments);
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
        activeRuns: [{ runId: 'run-1', agentId: 'agent-1', addressedByMessageId: 'user-1', startedAt: 1 }],
      });
      expect(live.entities.messages['assistant-1']?.turnInterrupted).toBeFalsy();

      // Crash-orphaned: persisted `running` but absent from the live set → interrupted.
      const orphaned = buildAgentRenderProjection(state, { revision: 1 });
      expect(orphaned.entities.messages['assistant-1']?.turnInterrupted).toBe(true);
    });
  });
});
