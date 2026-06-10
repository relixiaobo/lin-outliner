import { describe, expect, test } from 'bun:test';
import {
  createEmptyAgentEventReplayState,
  type AgentActor,
  type AgentEventMessageRecord,
} from '../../src/core/agentEventLog';
import {
  buildConsolidateOnlyDreamMemoryExtractionSpan,
  buildDreamMemoryExtractionRequest,
  buildDreamMemoryExtractionSpan,
} from '../../src/main/agentDreamExtraction';

const systemActor: AgentActor = { type: 'system' };
const userActor: AgentActor = { type: 'user', userId: 'user-1' };
const agentActor: AgentActor = { type: 'agent', agentId: 'agent-1' };
const toolActor: AgentActor = { type: 'tool', toolName: 'node_read', toolCallId: 'tool-prev' };

function message(input: {
  id: string;
  role: AgentEventMessageRecord['role'];
  actor: AgentActor;
  parentMessageId: string | null;
  text: string;
  runId?: string;
  toolName?: string;
}): AgentEventMessageRecord {
  return {
    id: input.id,
    role: input.role,
    actor: input.actor,
    parentMessageId: input.parentMessageId,
    content: [{ type: 'text', text: input.text }],
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
    status: 'completed',
    runId: input.runId,
    toolName: input.toolName,
  };
}

// Build a replay state from completed runs plus a parent-linked message list;
// rootMessageIds and childrenByParentId are derived from each message's parentMessageId.
function replayStateWith(runIds: readonly string[], messages: readonly AgentEventMessageRecord[]) {
  const state = createEmptyAgentEventReplayState();
  state.latestEventId = 'event-terminal-new';
  runIds.forEach((id, index) => {
    state.runs[id] = { id, status: 'completed', startedAt: 10 + index * 20, updatedAt: 20 + index * 20 };
  });
  for (const item of messages) {
    state.messages[item.id] = item;
    if (item.parentMessageId === null) state.rootMessageIds.push(item.id);
    else (state.childrenByParentId[item.parentMessageId] ??= []).push(item.id);
  }
  state.latestMessageId = messages.at(-1)?.id ?? null;
  return state;
}

const promptText = (request: ReturnType<typeof buildDreamMemoryExtractionRequest>): string =>
  request.content[0]?.type === 'text' ? request.content[0].text : '';

const fenceOf = (text: string) => /<(evidence-[0-9a-f-]+)>/.exec(text)?.[1];

describe('agent dream extraction', () => {
  test('does not cross a previous run boundary to find user provenance', () => {
    const state = replayStateWith(['run-prev', 'run-new'], [
      message({
        id: 'user-prev',
        role: 'user',
        actor: userActor,
        parentMessageId: null,
        text: 'Previous turn instruction that must not become new-run evidence.',
      }),
      message({
        id: 'assistant-prev',
        role: 'assistant',
        actor: agentActor,
        parentMessageId: 'user-prev',
        text: 'Previous run response.',
        runId: 'run-prev',
      }),
      message({
        id: 'tool-prev-result',
        role: 'toolResult',
        actor: toolActor,
        parentMessageId: 'assistant-prev',
        text: 'Previous run tool result.',
        runId: 'run-prev',
        toolName: 'node_read',
      }),
      message({
        id: 'assistant-new',
        role: 'assistant',
        actor: agentActor,
        parentMessageId: 'tool-prev-result',
        text: 'New run response without a fresh user prompt.',
        runId: 'run-new',
      }),
    ]);

    const span = buildDreamMemoryExtractionSpan('conversation-1', state, 'run-new');

    expect(span?.sources[0]?.messageRange).toEqual(['assistant-new', 'assistant-new']);
    expect(span?.transcript).toContain('New run response without a fresh user prompt.');
    expect(span?.transcript).not.toContain('Previous turn instruction');
    expect(span?.transcript).not.toContain('Previous run tool result.');
  });

  test('includes the directly adjacent user prompt for a normal completed turn', () => {
    const state = replayStateWith(['run-new'], [
      message({
        id: 'user-new',
        role: 'user',
        actor: userActor,
        parentMessageId: null,
        text: 'Remember that concise answers are preferred.',
      }),
      message({
        id: 'assistant-new',
        role: 'assistant',
        actor: agentActor,
        parentMessageId: 'user-new',
        text: 'I will answer concisely.',
        runId: 'run-new',
      }),
    ]);

    const span = buildDreamMemoryExtractionSpan('conversation-1', state, 'run-new');

    expect(span?.sources[0]?.messageRange).toEqual(['user-new', 'assistant-new']);
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
    // D-9: cross-pool duplication is prompt guidance — user preferences stay out of this pool.
    expect(text).toContain('do\n  not duplicate them here');
    expect(text).toContain('user pool, not this one');
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
    expect(text).toContain("zone tagged with the\n  user's name");
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
    const state = replayStateWith(['run-new'], [
      message({
        id: 'user-new',
        role: 'user',
        actor: userActor,
        parentMessageId: null,
        text: 'No — that assumption was wrong: this repo builds with bun, never npm.',
      }),
      message({
        id: 'assistant-1',
        role: 'assistant',
        actor: agentActor,
        parentMessageId: 'user-new',
        text: 'Checking the lockfile.',
        runId: 'run-new',
      }),
      message({
        id: 'tool-result-1',
        role: 'toolResult',
        actor: toolActor,
        parentMessageId: 'assistant-1',
        text: 'ENOENT: package-lock.json does not exist; found bun.lock instead.',
        runId: 'run-new',
        toolName: 'node_read',
      }),
      message({
        id: 'assistant-2',
        role: 'assistant',
        actor: agentActor,
        parentMessageId: 'tool-result-1',
        text: 'Confirmed: bun is the package manager here.',
        runId: 'run-new',
      }),
    ]);

    const span = buildDreamMemoryExtractionSpan('conversation-1', state, 'run-new');
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
