import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import type { AgentActor, AgentEvent } from '../../src/core/agentEventLog';
import {
  buildConsolidateOnlyDreamMemoryExtractionSpan,
  buildDreamMemoryExtractionRequest,
  buildDreamMemoryExtractionSpanFromEvidence,
  buildDreamSessionId,
  DREAM_SESSION_ID_MAX_CHARS,
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

const promptText = (request: ReturnType<typeof buildDreamMemoryExtractionRequest>): string =>
  request.content[0]?.type === 'text' ? request.content[0].text : '';

const fenceOf = (text: string) => /<(evidence-[0-9a-f-]+)>/.exec(text)?.[1];

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

  test('the agent-subject prompt writes the self-model under the ONE phrasing rule', () => {
    const request = buildDreamMemoryExtractionRequest({
      span: buildConsolidateOnlyDreamMemoryExtractionSpan('run-1'),
      existingMemories: [],
      subject: 'agent',
    });
    const text = promptText(request);
    expect(text).toContain("the agent's durable self-model");
    // ONE phrasing rule for all pools ([[agent-memory-realignment]] D-2): third-person
    // singular, subject-elided; render is a bullet list under the zone tag, so the prompt
    // must not promise a prepended subject.
    expect(text).toContain('THIRD-PERSON SINGULAR');
    expect(text).toContain('bullets under a <self> zone');
    expect(text).not.toContain('BASE form');
    expect(text).not.toContain('renders as "You <fact>"');
    expect(text).toContain('an inference reads "has noticed that…"');
    expect(text).not.toContain('have noticed that…');
    // D-9: cross-pool duplication is prompt guidance — user preferences stay out of this pool,
    // EXCEPT when the evidence is visible only to this writer (run-log-only), which would
    // otherwise be dropped by both Dreams (gate round, #183 finding 3).
    expect(text).toContain('do\n  not duplicate them here unless the evidence exists only in this run log');
    expect(text).toContain('user pool, not this one');
    // Authority examples are agent-workflow-shaped and carry no hardcoded person name; a
    // stated-authority example must not model re-importing user directives (#183 finding 2).
    expect(text).toContain('a stated preference reads\n  "follows an explicit project rule to…"');
    expect(text).not.toContain('lixiaobo');
  });

  test('the user-subject prompt writes the user pool under the same phrasing rule', () => {
    const request = buildDreamMemoryExtractionRequest({
      span: buildConsolidateOnlyDreamMemoryExtractionSpan('run-1'),
      existingMemories: [],
      subject: 'user',
    });
    const text = promptText(request);
    expect(text).toContain('the person it works with (the user)');
    expect(text).toContain('THIRD-PERSON SINGULAR');
    // The prompt promises only what the runtime performs: the live call site passes no
    // name resolver, so the zone identifies the user generically (gate round, #183 finding 2).
    expect(text).toContain('zone identifying the\n  user');
    expect(text).not.toContain('renders as "The user <fact>"');
    // The user profile must not absorb the agent's own working habits.
    expect(text).toContain("the agent's separate self-model");
    expect(text).toContain('an inference reads "has noticed that…"');
    expect(text).toContain('a stated preference reads\n  "has said they want…"');
    expect(text).not.toContain('have noticed that…');
  });

  test('defaults to the agent subject when none is given', () => {
    const request = buildDreamMemoryExtractionRequest({
      span: buildConsolidateOnlyDreamMemoryExtractionSpan('run-1'),
      existingMemories: [],
    });
    expect(promptText(request)).toContain("the agent's durable self-model");
  });

  // The former D2 encoding-signal acceptance ([[agent-memory-academic-alignment]]): the prompt
  // states the encoding policy with prediction-error weighting, and a span carrying a clear
  // user-correction plus a tool-surprise reaches the model inside the evidence fence. This is a
  // prompt snapshot (no model-in-loop harness); whether the model actually cites those spans is
  // verified manually.
  test('states the encoding policy and carries correction/surprise evidence inside the fence', () => {
    const events = [
      runStarted(2, 'run-new'),
      userMessage(3, 'user-new', 'No - that assumption was wrong: this repo builds with bun, never npm.', null, 'run-new'),
      assistantStarted(4, 'assistant-1', 'user-new', 'run-new'),
      assistantCompleted(5, 'assistant-1', 'Checking the lockfile.', 'run-new'),
      toolResult(6, 'tool-result-1', 'assistant-1', 'ENOENT: package-lock.json does not exist; found bun.lock instead.', 'run-new'),
      assistantStarted(7, 'assistant-2', 'tool-result-1', 'run-new'),
      assistantCompleted(8, 'assistant-2', 'Confirmed: bun is the package manager here.', 'run-new'),
      runCompleted(9, 'run-new'),
    ];

    const span = conversationSpan(events, 2);
    expect(span).not.toBeNull();
    const text = promptText(buildDreamMemoryExtractionRequest({ span: span!, existingMemories: [] }));

    // Consolidation framing + encoding policy with prediction-error weighting.
    expect(text).toContain('consolidation pass');
    expect(text).toContain('Encoding policy');
    expect(text).toContain('prediction error');
    expect(text).toContain('diverged from what was assumed');
    expect(text).toContain('reconsolidation');

    // The correction and the tool-surprise are evidence: they appear inside the fence, after the
    // prompt's instruction body. Anchor on the tags' own lines — a bare indexOf would match the
    // prose mention of the fence ("enclosed in the <fence> tags below") ahead of the real tag.
    const fence = fenceOf(text);
    expect(fence).toBeDefined();
    const fenceOpenAt = text.indexOf(`\n<${fence}>\n`);
    const fenceCloseAt = text.indexOf(`\n</${fence}>`);
    expect(fenceOpenAt).toBeGreaterThan(-1);
    expect(fenceCloseAt).toBeGreaterThan(fenceOpenAt);
    const correctionAt = text.indexOf('this repo builds with bun, never npm');
    const surpriseAt = text.indexOf('package-lock.json does not exist');
    expect(correctionAt).toBeGreaterThan(fenceOpenAt);
    expect(correctionAt).toBeLessThan(fenceCloseAt);
    expect(surpriseAt).toBeGreaterThan(fenceOpenAt);
    expect(surpriseAt).toBeLessThan(fenceCloseAt);
  });

  // The Dream batch sessionId becomes the provider prompt_cache_key (via pi-ai's session-id
  // header); Codex/OpenAI reject one longer than 64 chars (HTTP 400). The old form prefixed
  // the principalKey, overflowing to 79 chars and failing every Dream. Guard the cap and the
  // dropped prefix.
  test('builds a Dream batch sessionId within the provider prompt_cache_key cap', () => {
    // Runtime shape: runId is `dream-run-<uuid>` (see AgentRuntime.runDreamTask).
    const runId = `dream-run-${randomUUID()}`;

    expect(buildDreamSessionId(runId, 0)).toBe(`dream:${runId}:1`);
    // No principal prefix — runId is already globally unique; the prefix only blew the cap.
    expect(buildDreamSessionId(runId, 0).startsWith('dream:')).toBe(true);

    // Every plausible batch index stays under the 64-char limit.
    for (const batchIndex of [0, 1, 9, 99, 999]) {
      expect(buildDreamSessionId(runId, batchIndex).length).toBeLessThanOrEqual(DREAM_SESSION_ID_MAX_CHARS);
    }
  });

  test('wraps raw evidence in a randomized fence an adversarial transcript cannot close', () => {
    const first = promptText(buildDreamMemoryExtractionRequest({
      span: buildConsolidateOnlyDreamMemoryExtractionSpan('run-1'),
      existingMemories: [],
    }));
    const second = promptText(buildDreamMemoryExtractionRequest({
      span: buildConsolidateOnlyDreamMemoryExtractionSpan('run-1'),
      existingMemories: [],
    }));
    const firstFence = fenceOf(first);
    const secondFence = fenceOf(second);
    // The fence tag is per-request and unguessable, so evidence text cannot break out of it.
    expect(firstFence).toBeDefined();
    expect(first).toContain(`</${firstFence}>`);
    expect(firstFence).not.toBe(secondFence);
    // The model is told the fenced content is untrusted data, not instructions.
    expect(first).toContain('untrusted DATA');
    expect(first).not.toContain('<conversation_run>');
  });
});
