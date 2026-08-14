import { describe, expect, test } from 'bun:test';
import type { AgentTaskToolName, ThreadItem, Turn } from '../../src/core/agent/protocol';
import { en } from '../../src/core/i18n';
import {
  createTurnContentGrouper,
  groupTurnContent,
  threadProcessSummary,
  turnMotionOwner,
} from '../../src/renderer/agent/components/ThreadView';
import {
  collaborationThreadIds,
  type SubagentPresentation,
  type SubagentTurnProjection,
} from '../../src/renderer/agent/subagentPresentation';
import type { DocumentIndex } from '../../src/renderer/state/document';

describe('active Turn process summary', () => {
  test('does not infer waiting from live Agent projections', () => {
    const launch = collaboration('launch', 'agent');
    const projection = subagents(['child-a', 'child-b']);

    expect(threadProcessSummary(turn([launch]), [launch], false, 5_000, en, emptyIndex(), projection))
      .toBe('Working for 5s');
  });

  test('keeps the generic summary while Agent messaging is in progress', () => {
    const launch = collaboration('launch', 'agent');
    const message = collaboration('message', 'agent_message');
    const items = [launch, message];

    expect(threadProcessSummary(turn(items), items, false, 5_000, en, emptyIndex(), subagents(['child-a'])))
      .toBe('Working for 5s');
  });

  test('only an explicit user-input block replaces the active work summary', () => {
    const message = collaboration('message', 'agent_message');

    expect(threadProcessSummary(
      turn([message]),
      [message],
      false,
      5_000,
      en,
      emptyIndex(),
      subagents(['child-a'], ['skill-child']),
      true,
    )).toBe('Waiting for input');
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

  test('keeps an interrupted segment before process state and the final response', () => {
    const interrupted = interruptedResponse('interrupted');
    const response = agentResponse('response');
    const completed: Turn = {
      ...turn([interrupted, response]),
      status: 'completed',
      completedAt: 3,
      durationMs: 2,
    };

    expect(groupTurnContent(completed).map((block) => (
      block.kind === 'process'
        ? { kind: block.kind, itemIds: block.items.map((item) => item.id) }
        : { kind: block.kind, itemId: block.item.id }
    ))).toEqual([
      { kind: 'item', itemId: 'interrupted' },
      { kind: 'process', itemIds: [] },
      { kind: 'item', itemId: 'response' },
    ]);
  });

  test('rebuilds only the content block that contains an identity-changed Item', () => {
    const grouper = createTurnContentGrouper();
    const user = userMessage('user');
    const process = reasoning('reasoning', ['Inspecting.']);
    const response = agentResponse('response');
    const first = grouper.group(turn([user, process, response]));
    const changedResponse = { ...response, text: 'Streaming more text.' };
    const second = grouper.group(turn([user, process, changedResponse]));

    expect(second).not.toBe(first);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).not.toBe(first[2]);
    expect(second[2]).toEqual({ kind: 'item', item: changedResponse });

    const changedProcess = { ...process, summary: ['Inspecting more.'] };
    const third = grouper.group(turn([user, changedProcess, changedResponse]));
    expect(third[0]).toBe(second[0]);
    expect(third[1]).not.toBe(second[1]);
    expect(third[2]).toBe(second[2]);
    expect(third[1]).toEqual({ kind: 'process', items: [changedProcess] });
  });

  test('rebuilds structure while reusing identity-stable blocks', () => {
    const grouper = createTurnContentGrouper();
    const user = userMessage('user');
    const empty = commentary('commentary', '');
    const response = agentResponse('response');
    const first = grouper.group(turn([user, empty, response]));
    const visible = { ...empty, text: 'Checking.' };
    const second = grouper.group(turn([user, visible, response]));

    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]).toEqual({ kind: 'process', items: [visible] });
    expect(second[2]).toBe(first[2]);

    const reordered = grouper.group(turn([response, visible, user]));
    expect(reordered.map((block) => block.kind === 'process' ? 'process' : block.item.id))
      .toEqual(['process', 'response', 'user']);
    expect(reordered[1]).toBe(second[2]);
    expect(reordered[2]).toBe(second[0]);

    const settled = grouper.group({
      ...turn([response, empty, user]),
      status: 'completed',
      completedAt: 3,
      durationMs: null,
    });
    expect(settled.map((block) => block.kind === 'process' ? 'process' : block.item.id))
      .toEqual(['response', 'user']);
    expect(settled[0]).toBe(reordered[1]);
    expect(settled[1]).toBe(reordered[2]);
  });
});

describe('Turn motion ownership', () => {
  test('assigns the generic live summary when no specific leaf is active', () => {
    expect(turnMotionOwner(turn([]), [], subagents([]))).toBe('summary');
  });

  test('assigns a live tool or Subagent to the leaf', () => {
    const tool = collaboration('tool', 'list_agents');
    const activity = subagentActivity('activity', 'child-a');
    expect(turnMotionOwner(turn([tool]), [tool], subagents([]))).toBe('leaf');
    expect(turnMotionOwner(turn([activity]), [activity], subagents(['child-a']))).toBe('leaf');
  });

  test('assigns empty Thinking to the leaf and populated streaming content to none', () => {
    const empty = reasoning('empty', ['', '   ']);
    const populated = reasoning('populated', ['Planning the next step.']);
    expect(turnMotionOwner(turn([empty]), [empty], subagents([]))).toBe('leaf');
    expect(turnMotionOwner(turn([populated]), [populated], subagents([]))).toBe('none');
  });

  test('does not assign motion to settled Turns or readable commentary', () => {
    const commentaryItem = commentary('commentary', 'Checking the workspace.');
    const settled = {
      ...turn([]),
      status: 'completed' as const,
      completedAt: 2,
      durationMs: 1,
    };
    expect(turnMotionOwner(turn([commentaryItem]), [commentaryItem], subagents([]))).toBe('none');
    expect(turnMotionOwner(settled, [], subagents([]))).toBe('none');
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
  tool: AgentTaskToolName,
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
    summary: null,
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

function reasoning(id: string, parts: readonly string[]): Extract<ThreadItem, { type: 'reasoning' }> {
  return {
    id,
    provenance: { originThreadId: 'thread-parent', originTurnId: 'turn-parent', originItemId: id },
    type: 'reasoning',
    summary: parts,
    content: [],
  };
}

function subagentActivity(
  id: string,
  agentThreadId: string,
): Extract<ThreadItem, { type: 'subAgentActivity' }> {
  return {
    id,
    provenance: { originThreadId: 'thread-parent', originTurnId: 'turn-parent', originItemId: id },
    type: 'subAgentActivity',
    kind: 'started',
    agentThreadId,
    agentPath: `/root/${agentThreadId}`,
    error: null,
    spawnItemId: null,
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

function interruptedResponse(id: string): Extract<ThreadItem, { type: 'agentMessage' }> {
  return {
    ...agentResponse(id),
    text: 'Partial response.',
    phase: 'interrupted',
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
      durationMs: null,
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
