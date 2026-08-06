import { describe, expect, test } from 'bun:test';
import type { ThreadItem, Turn } from '../../src/core/agent/protocol';
import { en } from '../../src/core/i18n';
import {
  groupTurnContent,
  threadProcessSummary,
} from '../../src/renderer/agent/components/ThreadView';
import {
  collaborationThreadIds,
  type SubagentPresentation,
  type SubagentTurnProjection,
} from '../../src/renderer/agent/subagentPresentation';
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

  test('does not count a live isolated Skill child as something the wait is waiting for', () => {
    const wait = collaboration('wait', 'wait_agent');
    const projection = subagents(['child-a'], ['skill-child']);

    expect(threadProcessSummary(turn([wait]), [wait], false, 5_000, en, emptyIndex(), projection))
      .toBe('Waiting on 1 subagent · 5s');
  });

  test('does not claim to wait on a child after every projected child becomes terminal', () => {
    const wait = collaboration('wait', 'wait_agent');

    expect(threadProcessSummary(turn([wait]), [wait], false, 5_000, en, emptyIndex(), subagents([])))
      .toBe('Working for 5s');
  });
});

describe('Turn process projection', () => {
  test('removes empty commentary before building process and item blocks', () => {
    const user = userMessage('user');
    const empty = commentary('empty', '   ');
    const response = agentResponse('response');
    const completed: Turn = {
      ...turn([user, empty, response]),
      status: 'completed',
      completedAt: 3,
      durationMs: 2,
    };

    expect(groupTurnContent(completed).map((block) => (
      block.kind === 'process'
        ? { kind: block.kind, itemIds: block.items.map((item) => item.id) }
        : { kind: block.kind, itemId: block.item.id }
    ))).toEqual([
      { kind: 'item', itemId: 'user' },
      { kind: 'process', itemIds: [] },
      { kind: 'item', itemId: 'response' },
    ]);
  });

  test('retains commentary that has visible text in the process block', () => {
    const visible = commentary('commentary', 'Checking the workspace.');
    const blocks = groupTurnContent(turn([visible]));

    expect(blocks).toEqual([{ kind: 'process', items: [visible] }]);
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

function userMessage(id: string): Extract<ThreadItem, { type: 'userMessage' }> {
  return {
    id,
    provenance: { originThreadId: 'thread-parent', originTurnId: 'turn-parent', originItemId: id },
    type: 'userMessage',
    clientId: null,
    content: [{ type: 'text', text: 'Inspect the workspace.' }],
    acceptedAt: 1,
  };
}

function commentary(id: string, text: string): Extract<ThreadItem, { type: 'agentMessage' }> {
  return {
    id,
    provenance: { originThreadId: 'thread-parent', originTurnId: 'turn-parent', originItemId: id },
    type: 'agentMessage',
    text,
    phase: 'commentary',
    memoryCitation: null,
  };
}

function agentResponse(id: string): Extract<ThreadItem, { type: 'agentMessage' }> {
  return {
    id,
    provenance: { originThreadId: 'thread-parent', originTurnId: 'turn-parent', originItemId: id },
    type: 'agentMessage',
    text: 'Finished.',
    phase: 'final_answer',
    memoryCitation: null,
  };
}

function subagents(
  activeThreadIds: readonly string[],
  skillThreadIds: readonly string[] = [],
): SubagentTurnProjection {
  const byThreadId = new Map<string, SubagentPresentation>();
  for (const threadId of [...activeThreadIds, ...skillThreadIds]) {
    byThreadId.set(threadId, {
      agentThreadId: threadId,
      displayName: threadId,
      error: null,
      form: skillThreadIds.includes(threadId) ? 'isolatedSkill' : 'collaboration',
      nickname: null,
      role: null,
      startedAt: null,
      status: 'running',
      taskPath: null,
    });
  }
  return {
    activeThreadIds: [...activeThreadIds, ...skillThreadIds],
    byThreadId,
    collaborationThreadIds: collaborationThreadIds(byThreadId),
    items: [],
  };
}

function emptyIndex(): DocumentIndex {
  return { byId: new Map(), projection: { nodes: [] } } as unknown as DocumentIndex;
}
