import { describe, expect, test } from 'bun:test';
import type { ThreadItem, Turn } from '../../src/core/agent/protocol';
import { en } from '../../src/core/i18n';
import { threadProcessSummary } from '../../src/renderer/agent/components/ThreadView';
import type { SubagentTurnProjection } from '../../src/renderer/agent/subagentPresentation';
import type { DocumentIndex } from '../../src/renderer/state/document';

describe('active Turn process summary', () => {
  test('names wait_agent as the only live bottleneck with a distinct child count', () => {
    const wait = collaboration('wait', 'wait_agent');
    const projection = subagents(['child-a', 'child-b']);

    expect(threadProcessSummary(turn([wait]), [wait], false, 5_000, en, emptyIndex(), projection))
      .toBe('Waiting on 2 subagents · 5s');
  });

  test('keeps the generic summary when another tool is still in progress', () => {
    const wait = collaboration('wait', 'wait_agent');
    const list = collaboration('list', 'list_agents');
    const items = [wait, list];

    expect(threadProcessSummary(turn(items), items, false, 5_000, en, emptyIndex(), subagents(['child-a'])))
      .toBe('Working for 5s');
  });

  test('does not claim to wait on a child after every projected child becomes terminal', () => {
    const wait = collaboration('wait', 'wait_agent');

    expect(threadProcessSummary(turn([wait]), [wait], false, 5_000, en, emptyIndex(), subagents([])))
      .toBe('Working for 5s');
  });
});

function turn(items: readonly ThreadItem[]): Turn {
  return {
    id: 'turn-parent',
    items,
    itemsView: 'full',
    provenance: { originThreadId: 'thread-parent', originTurnId: 'turn-parent', trigger: { kind: 'user' } },
    status: 'inProgress',
    error: null,
    startedAt: 1,
    completedAt: null,
    durationMs: null,
  };
}

function collaboration(
  id: string,
  tool: 'wait_agent' | 'list_agents',
): Extract<ThreadItem, { type: 'collabAgentToolCall' }> {
  return {
    id,
    provenance: { originThreadId: 'thread-parent', originTurnId: 'turn-parent', originItemId: id },
    type: 'collabAgentToolCall',
    tool,
    status: 'inProgress',
    outputRef: null,
    senderThreadId: 'thread-parent',
    receiverThreadIds: [],
    prompt: null,
    model: null,
    reasoningEffort: null,
    agentsStates: {},
  };
}

function subagents(activeThreadIds: readonly string[]): SubagentTurnProjection {
  return { activeThreadIds, byThreadId: new Map(), items: [] };
}

function emptyIndex(): DocumentIndex {
  return { byId: new Map(), projection: { nodes: [] } } as unknown as DocumentIndex;
}
