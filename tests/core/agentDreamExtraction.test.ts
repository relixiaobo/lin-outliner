import { describe, expect, test } from 'bun:test';
import {
  createEmptyAgentEventReplayState,
  type AgentActor,
  type AgentEventMessageRecord,
} from '../../src/core/agentEventLog';
import { buildDreamMemoryExtractionSpan } from '../../src/main/agentDreamExtraction';

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

describe('agent dream extraction', () => {
  test('does not cross a previous run boundary to find user provenance', () => {
    const state = createEmptyAgentEventReplayState();
    state.latestEventId = 'event-terminal-new';
    state.runs = {
      'run-prev': {
        id: 'run-prev',
        status: 'completed',
        startedAt: 10,
        updatedAt: 20,
      },
      'run-new': {
        id: 'run-new',
        status: 'completed',
        startedAt: 30,
        updatedAt: 40,
      },
    };
    const messages = [
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
    ];
    state.messages = Object.fromEntries(messages.map((item) => [item.id, item]));
    state.rootMessageIds = ['user-prev'];
    state.childrenByParentId = {
      'user-prev': ['assistant-prev'],
      'assistant-prev': ['tool-prev-result'],
      'tool-prev-result': ['assistant-new'],
    };
    state.latestMessageId = 'assistant-new';

    const span = buildDreamMemoryExtractionSpan('conversation-1', state, 'run-new');

    expect(span?.sources[0]?.messageRange).toEqual(['assistant-new', 'assistant-new']);
    expect(span?.transcript).toContain('New run response without a fresh user prompt.');
    expect(span?.transcript).not.toContain('Previous turn instruction');
    expect(span?.transcript).not.toContain('Previous run tool result.');
  });

  test('includes the directly adjacent user prompt for a normal completed turn', () => {
    const state = createEmptyAgentEventReplayState();
    state.latestEventId = 'event-terminal-new';
    state.runs = {
      'run-new': {
        id: 'run-new',
        status: 'completed',
        startedAt: 30,
        updatedAt: 40,
      },
    };
    const messages = [
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
    ];
    state.messages = Object.fromEntries(messages.map((item) => [item.id, item]));
    state.rootMessageIds = ['user-new'];
    state.childrenByParentId = { 'user-new': ['assistant-new'] };
    state.latestMessageId = 'assistant-new';

    const span = buildDreamMemoryExtractionSpan('conversation-1', state, 'run-new');

    expect(span?.sources[0]?.messageRange).toEqual(['user-new', 'assistant-new']);
    expect(span?.transcript).toContain('Remember that concise answers are preferred.');
    expect(span?.transcript).toContain('I will answer concisely.');
  });
});
