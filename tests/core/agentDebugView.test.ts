import { describe, expect, test } from 'bun:test';
import type { AgentActor, AgentEvent } from '../../src/core/agentEventLog';
import {
  deriveDebugRounds,
  deriveDebugRun,
  extractRunSnapshotFromPayload,
  snapshotFromRunEvents,
  summarizeDebugRun,
  summarizeRunStream,
} from '../../src/main/agentDebugView';
import type { AgentRunMetaProjection } from '../../src/main/agentEventStore';

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

  test('fork-prefix messages before run.started are context, not rounds', () => {
    seqCounter = 0;
    const runId = 'run-child';
    // A child run's ledger opens with the inherited transcript (a user + an
    // assistant turn) BEFORE its own run.started, then the directive, then the
    // run's real assistant turn. Only the post-run.started turn is a round.
    const events: AgentEvent[] = [
      ev('user_message.created', { runId, messageId: 'ctx-u', parentMessageId: null, content: [{ type: 'text', text: 'inherited question' }] }, userActor),
      ev('assistant_message.started', { runId, messageId: 'ctx-a', parentMessageId: 'ctx-u', providerId: 'anthropic', modelId: 'claude', apiId: 'messages' }),
      ev('assistant_message.completed', { runId, messageId: 'ctx-a', parentMessageId: 'ctx-u', stopReason: 'stop', content: [{ type: 'text', text: 'inherited answer' }] }),
      ev('run.started', { runId, agentId: 'built-in:tenon:assistant', kind: 'delegation', trigger: { type: 'parent-run', parentRunId: 'run-parent' } }),
      ev('user_message.created', { runId, messageId: 'dir', parentMessageId: 'ctx-a', content: [{ type: 'text', text: 'do the subtask' }] }, userActor),
      ev('assistant_message.started', { runId, messageId: 'a1', parentMessageId: 'dir', providerId: 'anthropic', modelId: 'claude', apiId: 'messages' }),
      ev('assistant_message.completed', { runId, messageId: 'a1', parentMessageId: 'dir', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] }),
      ev('run.completed', { runId }),
    ];

    const rounds = deriveDebugRounds(events);
    // The fork-prefix assistant (ctx-a) is NOT a round.
    expect(rounds.map((round) => round.messageId)).toEqual(['a1']);
    // It folds into the first round's request window, in order, with the directive.
    expect(rounds[0]!.requestWindow.map((row) => row.role)).toEqual(['user', 'assistant', 'user']);
  });

  test('tool_result.replaced patches the exchange across rounds, keeping isError', () => {
    seqCounter = 0;
    const runId = 'run-slim';
    const events: AgentEvent[] = [
      ev('run.started', { runId, agentId: 'built-in:tenon:assistant', kind: 'turn', trigger: { type: 'message', messageId: 'u1' } }),
      ev('user_message.created', { runId, messageId: 'u1', parentMessageId: null, content: [{ type: 'text', text: 'read it' }] }, userActor),
      ev('assistant_message.started', { runId, messageId: 'a1', parentMessageId: 'u1', providerId: 'anthropic', modelId: 'claude', apiId: 'messages' }),
      ev('assistant_message.completed', {
        runId, messageId: 'a1', parentMessageId: 'u1', stopReason: 'tool_use',
        content: [{ type: 'toolCall', id: 'call-1', name: 'read_file', arguments: {} }],
      }),
      ev('tool_result.created', { runId, messageId: 'tr1', parentMessageId: 'a1', toolCallId: 'call-1', toolName: 'read_file', isError: true, content: [{ type: 'text', text: 'HUGE original output' }], outputSummary: '' }),
      // Next round opens BEFORE the replacement arrives — so `current` is a2.
      ev('assistant_message.started', { runId, messageId: 'a2', parentMessageId: 'tr1', providerId: 'anthropic', modelId: 'claude', apiId: 'messages' }),
      ev('tool_result.replaced', { runId, messageId: 'tr1', toolCallId: 'call-1', content: [{ type: 'text', text: 'slim output' }], outputSummary: '' }),
      ev('assistant_message.completed', { runId, messageId: 'a2', parentMessageId: 'tr1', stopReason: 'stop', content: [{ type: 'text', text: 'ok' }] }),
      ev('run.completed', { runId }),
    ];

    const rounds = deriveDebugRounds(events);
    expect(rounds.map((round) => round.messageId)).toEqual(['a1', 'a2']);
    // The replacement patched the call's exchange in the EARLIER round (a1)...
    expect(rounds[0]!.toolExchanges[0]).toMatchObject({ toolCallId: 'call-1', result: 'slim output', isError: true });
  });

  test('a tool_result.replaced with no matching call is dropped, not made into a phantom exchange', () => {
    seqCounter = 0;
    const runId = 'run-orphan-replace';
    // Slimming of a tool result produced in a DIFFERENT run lands in this run's
    // stream (stamped with the active run) but matches no call here — it must be
    // ignored, never fabricate an empty-named exchange on the in-flight round.
    const events: AgentEvent[] = [
      ev('run.started', { runId, agentId: 'built-in:tenon:assistant', kind: 'turn', trigger: { type: 'message', messageId: 'u1' } }),
      ev('user_message.created', { runId, messageId: 'u1', parentMessageId: null, content: [{ type: 'text', text: 'hi' }] }, userActor),
      ev('assistant_message.started', { runId, messageId: 'a1', parentMessageId: 'u1', providerId: 'anthropic', modelId: 'claude', apiId: 'messages' }),
      ev('tool_result.replaced', { runId, messageId: 'tr-foreign', toolCallId: 'call-from-another-run', content: [{ type: 'text', text: 'slim' }], outputSummary: '' }),
      ev('assistant_message.completed', { runId, messageId: 'a1', parentMessageId: 'u1', stopReason: 'stop', content: [{ type: 'text', text: 'ok' }] }),
      ev('run.completed', { runId }),
    ];
    const rounds = deriveDebugRounds(events);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.toolExchanges).toHaveLength(0);
  });

  test('redacts secrets in tool-call arguments by key name AND inline value pattern', () => {
    seqCounter = 0;
    const runId = 'run-secret';
    const events: AgentEvent[] = [
      ev('run.started', { runId, agentId: 'built-in:tenon:assistant', kind: 'turn', trigger: { type: 'message', messageId: 'u1' } }),
      ev('user_message.created', { runId, messageId: 'u1', parentMessageId: null, content: [{ type: 'text', text: 'go' }] }, userActor),
      ev('assistant_message.started', { runId, messageId: 'a1', parentMessageId: 'u1', providerId: 'anthropic', modelId: 'claude', apiId: 'messages' }),
      ev('assistant_message.completed', {
        runId, messageId: 'a1', parentMessageId: 'u1', stopReason: 'tool_use',
        content: [{
          type: 'toolCall', id: 'call-1', name: 'run_command',
          // `api_key` is caught by key name; the inline bearer token is caught by
          // the value-pattern pass even though `command` is not a secret key.
          arguments: { api_key: 'super-secret', command: "curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123'" },
        }],
      }),
      ev('run.completed', { runId }),
    ];
    const rounds = deriveDebugRounds(events);
    const toolCall = rounds[0]!.responseParts.find((part) => part.kind === 'toolCall');
    expect(toolCall?.body).toContain('[redacted]');
    expect(toolCall?.body).toContain('[redacted secret-like content]');
    expect(toolCall?.body).not.toContain('super-secret');
    expect(toolCall?.body).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
  });

});

describe('extractRunSnapshotFromPayload', () => {
  test('reads an Anthropic-shaped payload (system array + input_schema tools)', () => {
    const snapshot = extractRunSnapshotFromPayload({
      system: [{ type: 'text', text: 'You are Tenon.' }, { type: 'text', text: 'Be concise.' }],
      tools: [{ name: 'list_files', description: 'List files', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(snapshot.systemPrompt).toBe('You are Tenon.\n\nBe concise.');
    expect(snapshot.tools).toEqual([{ name: 'list_files', description: 'List files', schema: '{\n  "type": "object"\n}' }]);
    expect(snapshot.messages.map((message) => message.role)).toEqual(['user']);
  });

  test('reads an OpenAI-shaped payload (instructions + tools.function)', () => {
    const snapshot = extractRunSnapshotFromPayload({
      instructions: 'You are Tenon.',
      tools: [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } } }],
    });
    expect(snapshot.systemPrompt).toBe('You are Tenon.');
    expect(snapshot.tools[0]).toMatchObject({ name: 'read_file', description: 'Read' });
  });

  test('reads an OpenAI message-folded system prompt (developer/system role in input)', () => {
    // The OpenAI responses/completions providers fold the system prompt into the
    // message array as a `developer` / `system` role entry — no top-level key.
    const fromInput = extractRunSnapshotFromPayload({
      input: [{ role: 'developer', content: 'You are Tenon.' }, { role: 'user', content: 'hi' }],
    });
    expect(fromInput.systemPrompt).toBe('You are Tenon.');
    expect(fromInput.messages.map((message) => message.role)).toEqual(['user']);
    const fromMessages = extractRunSnapshotFromPayload({
      messages: [{ role: 'system', content: 'Be concise.' }, { role: 'user', content: 'hi' }],
    });
    expect(fromMessages.systemPrompt).toBe('Be concise.');
    expect(fromMessages.messages.map((message) => message.role)).toEqual(['user']);
  });

  test('captures the full model input message window from provider payloads', () => {
    const snapshot = extractRunSnapshotFromPayload({
      input: [
        { role: 'developer', content: 'You are Tenon.' },
        { role: 'user', content: 'Generate a PPT.' },
        { role: 'assistant', content: [{ type: 'output_text', text: 'PPT generated.' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'Today weather?' }] },
      ],
    });

    expect(snapshot.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(snapshot.messages.map((message) => message.content[0])).toEqual([
      { type: 'text', text: 'Generate a PPT.' },
      { type: 'text', text: 'PPT generated.' },
      { type: 'text', text: 'Today weather?' },
    ]);
  });

  test('summarizes final provider file parts without exposing inline file data', () => {
    const snapshot = extractRunSnapshotFromPayload({
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'Read this PDF.' },
          { type: 'input_file', filename: 'sample.pdf', file_data: 'data:application/pdf;base64,secret-bytes' },
        ],
      }],
    });

    expect(snapshot.messages[0]?.content).toEqual([
      { type: 'text', text: 'Read this PDF.' },
      { type: 'text', text: '[file sample.pdf]' },
    ]);
    expect(JSON.stringify(snapshot.messages)).not.toContain('secret-bytes');
  });

  test('degrades to empty on a non-record payload', () => {
    expect(extractRunSnapshotFromPayload('nope')).toEqual({ systemPrompt: '', tools: [], messages: [] });
  });
});

describe('deriveDebugRun + snapshot + summary assembly', () => {
  test('keeps the first captured model input messages when later provider calls update the snapshot', () => {
    seqCounter = 0;
    const runId = 'run-snapshot-window';
    const snapshot = snapshotFromRunEvents([
      ev('debug.run_snapshot.created', {
        runId,
        systemPrompt: 'Initial prompt.',
        tools: [{ name: 'web_search', description: 'Search', schema: '{}' }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Generate a PPT.' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'PPT generated.' }] },
          { role: 'user', content: [{ type: 'text', text: 'Today weather?' }] },
        ],
      }),
      ev('debug.run_snapshot.created', {
        runId,
        systemPrompt: 'Updated prompt.',
        tools: [{ name: 'web_search', description: 'Search the web', schema: '{}' }],
        messages: [
          { role: 'tool', content: [{ type: 'text', text: 'weather result' }] },
        ],
      }),
    ]);

    expect(snapshot?.systemPrompt).toBe('Updated prompt.');
    expect(snapshot?.tools[0]?.description).toBe('Search the web');
    expect(snapshot?.messages.map((message) => message.summary)).toEqual([
      'user: Generate a PPT.',
      'assistant: PPT generated.',
      'user: Today weather?',
    ]);
  });

  test('assembles a run from its stream + per-run snapshot, and projects to a summary', () => {
    seqCounter = 0;
    const runId = 'run-assembled';
    const events: AgentEvent[] = [
      ev('run.started', { runId, agentId: 'built-in:tenon:assistant', kind: 'turn', trigger: { type: 'message', messageId: 'u1' } }),
      ev('debug.run_snapshot.created', {
        runId,
        systemPrompt: 'You are Tenon.',
        tools: [{ name: 'list_files', description: 'List', schema: '{}' }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
      ev('user_message.created', { runId, messageId: 'u1', parentMessageId: null, content: [{ type: 'text', text: 'hi' }] }, userActor),
      ev('assistant_message.started', { runId, messageId: 'a1', parentMessageId: 'u1', providerId: 'anthropic', modelId: 'claude', apiId: 'messages' }),
      ev('assistant_message.completed', { runId, messageId: 'a1', parentMessageId: 'u1', stopReason: 'stop', content: [{ type: 'text', text: 'hello' }], usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.001 } } }),
      ev('run.completed', { runId }),
    ];

    const meta = {
      v: 1, id: runId, agentId: 'built-in:tenon:assistant', kind: 'turn', status: 'completed',
      anchor: { type: 'conversation', agentId: 'built-in:tenon:assistant', conversationId },
      trigger: { type: 'message', messageId: 'u1' },
      usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.001 } },
      fingerprint: {}, retention: 'hot', createdAt: 1700, updatedAt: 1800, latestSeq: 6,
    } as unknown as AgentRunMetaProjection;

    const run = deriveDebugRun(events, { meta, snapshot: snapshotFromRunEvents(events), parentToolCallId: null });
    expect(run.systemPrompt).toBe('You are Tenon.');
    expect(run.tools).toEqual([{ name: 'list_files', description: 'List', schema: '{}', bytes: 16 }]);
    expect(run.modelInputMessages.map((message) => message.summary)).toEqual(['user: hi']);
    expect(run.modelInputMessagesSource).toBe('captured');
    expect(run.rounds.map((round) => round.messageId)).toEqual(['a1']);
    expect(run.kind).toBe('turn');
    expect(run.createdAt).toBe(1700);

    const summary = summarizeDebugRun(run);
    expect(summary).toMatchObject({ runId, agentId: 'built-in:tenon:assistant', kind: 'turn', roundCount: 1, createdAt: 1700 });
    expect(summary.provider).toBe('anthropic');

    // The light tree path must agree with the full-derivation oracle field-for-field
    // — otherwise a collapsed node could disagree with the run it expands into.
    expect(summarizeRunStream(events, meta, null)).toEqual(summary);
  });

  test('rolls up round usage when meta.usage is absent (in-flight run)', () => {
    seqCounter = 0;
    const runId = 'run-live-usage';
    const events: AgentEvent[] = [
      ev('run.started', { runId, agentId: 'built-in:tenon:assistant', kind: 'turn', trigger: { type: 'message', messageId: 'u1' } }),
      ev('user_message.created', { runId, messageId: 'u1', parentMessageId: null, content: [{ type: 'text', text: 'hi' }] }, userActor),
      ev('assistant_message.started', { runId, messageId: 'a1', parentMessageId: 'u1', providerId: 'anthropic', modelId: 'claude', apiId: 'messages' }),
      ev('assistant_message.completed', { runId, messageId: 'a1', parentMessageId: 'u1', stopReason: 'tool_use', content: [{ type: 'text', text: 'one' }], usage: { input: 100, output: 10, totalTokens: 110, cost: { total: 0.01 } } }),
      ev('assistant_message.started', { runId, messageId: 'a2', parentMessageId: 'a1', providerId: 'anthropic', modelId: 'claude', apiId: 'messages' }),
      ev('assistant_message.completed', { runId, messageId: 'a2', parentMessageId: 'a1', stopReason: 'stop', content: [{ type: 'text', text: 'two' }], usage: { input: 50, output: 5, totalTokens: 55, cost: { total: 0.005 } } }),
    ];
    // meta has NO usage (run not terminated) — the run total must still reflect
    // the rounds the user can already see, not read zero.
    const meta = {
      v: 1, id: runId, agentId: 'built-in:tenon:assistant', kind: 'turn', status: 'running',
      anchor: { type: 'conversation', agentId: 'built-in:tenon:assistant', conversationId },
      trigger: { type: 'message', messageId: 'u1' },
      fingerprint: {}, retention: 'hot', createdAt: 1700, updatedAt: 1800, latestSeq: 6,
    } as unknown as AgentRunMetaProjection;

    const run = deriveDebugRun(events, { meta, snapshot: null, parentToolCallId: null });
    expect(run.usage?.totalTokens).toBe(165);
    expect(run.usage?.costUsd).toBeCloseTo(0.015, 5);
    expect(run.modelInputMessagesSource).toBe('legacyRequestWindow');

    // Two rounds + in-flight usage rollup — the case most apt to drift: the light
    // path must still match the oracle's summary exactly.
    expect(summarizeRunStream(events, meta, null)).toEqual(summarizeDebugRun(run));
  });

  test('snapshotFromRunEvents returns null when no snapshot was captured', () => {
    expect(snapshotFromRunEvents([])).toBeNull();
  });
});

describe('deriveDebugRounds running-state', () => {
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
