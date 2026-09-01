import { describe, expect, test } from 'bun:test';
import type {
  AgentTaskToolName,
  SubAgentActivityThreadItem,
  SubagentExecutionProjection,
  SubagentGenerationReceipt,
  Thread,
  ThreadItem,
  Turn,
} from '../../src/core/agent/protocol';
import {
  projectSubagentConversation,
  type SubagentProjectionInput,
} from '../../src/renderer/agent/subagentPresentation';
import { stripRows, SUBAGENT_STRIP_LINGER_MS } from '../../src/renderer/agent/components/SubagentWorkStrip';

const PARENT_ID = 'thread-parent';
const CHILD_ID = 'thread-child';
const SECOND_CHILD_ID = 'thread-child-2';
const GRANDCHILD_ID = 'thread-grandchild';
const SKILL_CHILD_ID = 'thread-skill-child';

describe('Agent registry projection', () => {
  test('describes one Agent across generations, not one row per Turn that touched it', () => {
    const spawn = activity('spawn', 'started', null, 'agent-call');
    const spawnTurn = parentTurn('turn-1', [collaborationItem('agent-call', 'agent', 'completed', CHILD_ID), spawn]);
    const resumeTurn = parentTurn('turn-2', [collaborationItem('resume-call', 'agent_message', 'completed', CHILD_ID)]);

    const projection = projectSubagentConversation(input({
      turnsByThread: new Map([[PARENT_ID, [spawnTurn, resumeTurn]]]),
      executions: executionMap([execution({ generation: 2 })]),
    }));

    expect([...projection.byAgentId.keys()]).toEqual([CHILD_ID]);
    expect(projection.byAgentId.get(CHILD_ID)).toMatchObject({
      displayName: 'survey the runtime',
      agentType: 'general-purpose',
      form: 'agent',
      generation: 2,
    });
    // Both Turns anchor the SAME Agent: the spawn where it was delegated, the
    // resume where it was steered again.
    expect(anchorList(projection, 'turn-1')).toEqual([{
      kind: 'spawn', agentId: CHILD_ID, itemId: 'spawn', generation: 2,
    }]);
    expect(anchorList(projection, 'turn-2')).toEqual([{
      kind: 'resume', agentId: CHILD_ID, itemId: 'resume-call', generation: null,
    }]);
  });

  test('collapses the delegating call into its chip and drops terminal activity entirely', () => {
    const call = collaborationItem('agent-call', 'agent', 'completed', CHILD_ID);
    const spawn = activity('spawn', 'started', null, 'agent-call');
    const settled = activity('settled', 'completed', null, null);
    const turn = parentTurn('turn-1', [reasoning('before'), call, spawn, reasoning('after'), settled]);

    const projection = projectSubagentConversation(input({
      turnsByThread: new Map([[PARENT_ID, [turn]]]),
    }));

    // The chip takes the CALL's slot, so a delegation can never precede the
    // reasoning that produced it; the terminal Item renders nothing at all.
    expect(projection.anchorsByTurnId.get('turn-1')?.items.map((item) => item.id))
      .toEqual(['before', 'spawn', 'after']);
  });

  test('anchors a spawn whose delegating call is not in the Turn', () => {
    const spawn = activity('spawn', 'started', null, 'call-from-another-turn');
    const turn = parentTurn('turn-1', [spawn]);

    const projection = projectSubagentConversation(input({ turnsByThread: new Map([[PARENT_ID, [turn]]]) }));

    expect(projection.anchorsByTurnId.get('turn-1')?.items.map((item) => item.id)).toEqual(['spawn']);
    expect(anchorList(projection, 'turn-1')).toEqual([{
      kind: 'spawn', agentId: CHILD_ID, itemId: 'spawn', generation: 1,
    }]);
  });

  test('leaves a message to the conversation itself unanchored', () => {
    // `main` addresses the conversation, not an Agent, so there is no recipient
    // Thread for a chip to open.
    const toMain = collaborationItem('main-message', 'agent_message', 'completed');
    const turn = parentTurn('turn-1', [toMain]);

    const projection = projectSubagentConversation(input({ turnsByThread: new Map([[PARENT_ID, [turn]]]) }));

    expect(anchorList(projection, 'turn-1')).toEqual([]);
    expect(projection.anchorsByTurnId.get('turn-1')?.items.map((item) => item.id)).toEqual(['main-message']);
  });

  test('names whose result a durable delivery Turn carries', () => {
    const spawn = activity('spawn', 'started', null, 'agent-call');
    const spawnTurn = parentTurn('turn-1', [collaborationItem('agent-call', 'agent', 'completed', CHILD_ID), spawn]);
    const continuation: Turn = {
      ...parentTurn('turn-2', []),
      provenance: {
        originThreadId: PARENT_ID,
        originTurnId: 'turn-2',
        // The notification answers the call that spawned this generation.
        trigger: { kind: 'subagent', parentThreadId: PARENT_ID, parentItemId: 'agent-call' },
      },
    };

    const projection = projectSubagentConversation(input({
      turnsByThread: new Map([[PARENT_ID, [spawnTurn, continuation]]]),
      executions: executionMap([
        execution({
          terminalStatus: 'finished',
          notificationState: 'delivered',
          deliveryTurnId: 'turn-2',
          generationReceipts: [receipt({ deliveryTurnId: 'turn-2' })],
        }),
      ]),
    }));

    expect(projection.deliveryByTurnId.get('turn-2'))
      .toEqual({ agentId: CHILD_ID, generation: 1 });
    expect(projection.deliveryByTurnId.get('turn-1')).toBeUndefined();
  });

  test('keeps delivered generations anchored after the Agent resumes', () => {
    const spawn = activity('spawn', 'started', null, 'agent-call');
    const spawnTurn = parentTurn('turn-1', [collaborationItem('agent-call', 'agent', 'completed', CHILD_ID), spawn]);
    const firstDelivery = continuationTurn('turn-2', 'agent-call');
    const resumeTurn = parentTurn('turn-3', [collaborationItem('resume-call', 'agent_message', 'completed', CHILD_ID)]);
    const secondDelivery = continuationTurn('turn-4', 'resume-call');

    const projection = projectSubagentConversation(input({
      turnsByThread: new Map([[PARENT_ID, [spawnTurn, firstDelivery, resumeTurn, secondDelivery]]]),
      executions: executionMap([
        execution({
          generation: 2,
          currentTurnId: 'child-turn-2',
          terminalStatus: 'finished',
          notificationState: 'delivered',
          deliveryTurnId: 'turn-4',
          generationReceipts: [
            receipt({ generation: 1, turnId: 'child-turn-1', deliveryTurnId: 'turn-2' }),
            receipt({ generation: 2, turnId: 'child-turn-2', deliveryTurnId: 'turn-4' }),
          ],
        }),
      ]),
    }));

    // The ledger owns delivery identity for every delivered generation, not
    // only for the stable Agent record's current generation.
    expect(projection.deliveryByTurnId.get('turn-2'))
      .toEqual({ agentId: CHILD_ID, generation: 1 });
    expect(projection.deliveryByTurnId.get('turn-4'))
      .toEqual({ agentId: CHILD_ID, generation: 2 });
  });

  test('anchors each historical event to its immutable generation receipt after resume', () => {
    const spawn = activity('spawn', 'started', null, 'agent-call', 'child-turn-1');
    const spawnTurn = parentTurn('turn-1', [collaborationItem('agent-call', 'agent', 'completed', CHILD_ID), spawn]);
    const resumeTurn = parentTurn('turn-3', [collaborationItem('resume-call', 'agent_message', 'completed', CHILD_ID)]);
    const firstChildTurn = childTurn('child-turn-1', 'failed', 100);
    const secondChildTurn: Turn = {
      ...childTurn('child-turn-2', 'inProgress', 200),
      provenance: {
        originThreadId: CHILD_ID,
        originTurnId: 'child-turn-2',
        trigger: { kind: 'subagent', parentThreadId: PARENT_ID, parentItemId: 'resume-call' },
      },
    };
    const projection = projectSubagentConversation(input({
      turnsByThread: new Map([
        [PARENT_ID, [spawnTurn, resumeTurn]],
        [CHILD_ID, [firstChildTurn, secondChildTurn]],
      ]),
      latestTurnByThread: new Map([[CHILD_ID, secondChildTurn]]),
      executions: executionMap([execution({
        generation: 2,
        currentTurnId: secondChildTurn.id,
        generationReceipts: [receipt({
          generation: 1,
          turnId: firstChildTurn.id,
          terminalStatus: 'failed',
        })],
      })]),
    }));

    expect(anchorList(projection, spawnTurn.id)[0]).toMatchObject({ generation: 1 });
    expect(anchorList(projection, resumeTurn.id)[0]).toMatchObject({ generation: 2 });
    expect(projection.byAgentId.get(CHILD_ID)).toMatchObject({ generation: 2, status: 'running' });
    expect(projection.byAgentId.get(CHILD_ID)?.generationReceipts.get(1))
      .toMatchObject({ terminalStatus: 'failed', turnId: firstChildTurn.id });
  });

  test('never reads an Agent\'s own delegated Turn as its own result arriving', () => {
    const spawn = activity('spawn', 'started', null, 'agent-call');
    const spawnTurn = parentTurn('turn-1', [collaborationItem('agent-call', 'agent', 'completed', CHILD_ID), spawn]);
    // The Agent's own first Turn: same `subagent` trigger, same call id — and
    // the delegating Thread named as its parent, which is what tells it apart
    // from the delegator's continuation.
    const delegatedTurn: Turn = {
      ...childTurn('child-turn', 'inProgress', 500),
      provenance: {
        originThreadId: CHILD_ID,
        originTurnId: 'child-turn',
        trigger: { kind: 'subagent', parentThreadId: PARENT_ID, parentItemId: 'agent-call' },
      },
    };

    const projection = projectSubagentConversation(input({
      turnsByThread: new Map([[PARENT_ID, [spawnTurn]], [CHILD_ID, [delegatedTurn]]]),
    }));

    expect(projection.deliveryByTurnId.get('child-turn')).toBeUndefined();
    expect([...projection.deliveryByTurnId.keys()]).toEqual([]);
  });

  test('reads live status from the current generation Turn and settled status from the record', () => {
    const running = projectSubagentConversation(input({
      latestTurnByThread: new Map([[CHILD_ID, childTurn('child-turn', 'inProgress', 500)]]),
    })).byAgentId.get(CHILD_ID);
    expect(running).toMatchObject({ status: 'running', startedAt: 500, durationMs: null });

    const settledTurn = projectSubagentConversation(input({
      latestTurnByThread: new Map([[CHILD_ID, childTurn('child-turn', 'completed', 500, 800)]]),
    })).byAgentId.get(CHILD_ID);
    expect(settledTurn).toMatchObject({ status: 'finished', durationMs: 10, settledAt: 800 });

    // No Turn in hand — a conversation reopened days later — still states the
    // outcome, because the terminal status is durable.
    const fromRecord = projectSubagentConversation(input({
      executions: executionMap([execution({ terminalStatus: 'failed', notificationState: 'delivered' })]),
    })).byAgentId.get(CHILD_ID);
    expect(fromRecord).toMatchObject({ status: 'errored', durationMs: null });
  });

  test('marks a user stop as the user\'s, so the model may not resume it', () => {
    const entry = projectSubagentConversation(input({
      executions: executionMap([execution({ stopProvenance: 'user', terminalStatus: 'interrupted' })]),
    })).byAgentId.get(CHILD_ID);

    expect(entry).toMatchObject({ status: 'interrupted', stoppedByUser: true });
  });

  test('counts live descendants without flattening the tree', () => {
    const projection = projectSubagentConversation(input({
      executions: executionMap([
        execution(),
        execution({ agentId: GRANDCHILD_ID, parentThreadId: CHILD_ID, description: 'read the docs' }),
      ]),
      threadsById: new Map([
        [CHILD_ID, childThread({ type: 'active', activeFlags: [] })],
        [GRANDCHILD_ID, { ...childThread({ type: 'active', activeFlags: [] }), id: GRANDCHILD_ID, parentThreadId: CHILD_ID }],
      ]),
    }));

    expect(projection.byAgentId.get(CHILD_ID)?.liveDescendantCount).toBe(1);
    expect(projection.byAgentId.get(GRANDCHILD_ID)?.liveDescendantCount).toBe(0);
  });

  test('scopes membership to this conversation, walking the delegation edges', () => {
    const projection = projectSubagentConversation(input({
      executions: executionMap([
        execution(),
        execution({ agentId: GRANDCHILD_ID, parentThreadId: CHILD_ID }),
        // Another conversation's Agent: same store, different root.
        execution({ agentId: 'thread-elsewhere', parentThreadId: 'thread-other-root' }),
      ]),
    }));

    expect([...projection.byAgentId.keys()]).toEqual([CHILD_ID, GRANDCHILD_ID]);
  });

  test('never adopts another conversation\'s record-less child', () => {
    // The store keeps every conversation the reader visited, and `threadsById`
    // holds their descendants. A record-less child is synthesized as BACKGROUND
    // work, so adopting one from elsewhere put another conversation's Agent in
    // this one's work strip.
    const projection = projectSubagentConversation(input({
      executions: executionMap([
        execution(),
        execution({ agentId: 'thread-elsewhere', parentThreadId: 'thread-other-root' }),
      ]),
      threadsById: new Map([
        [CHILD_ID, childThread({ type: 'active', activeFlags: [] })],
        ['thread-ours', {
          ...childThread({ type: 'active', activeFlags: [] }),
          id: 'thread-ours',
          parentThreadId: CHILD_ID,
        }],
        ['thread-theirs', {
          ...childThread({ type: 'active', activeFlags: [] }),
          id: 'thread-theirs',
          parentThreadId: 'thread-elsewhere',
        }],
      ]),
    }));

    expect([...projection.byAgentId.keys()]).toEqual([CHILD_ID, 'thread-ours']);
  });

  test('numbers same-named siblings so two delegations of one task can be told apart', () => {
    const projection = projectSubagentConversation(input({
      executions: executionMap([
        execution(),
        execution({ agentId: SECOND_CHILD_ID, createdAt: 20 }),
      ]),
    }));

    expect([...projection.byAgentId.values()].map((entry) => entry.displayName))
      .toEqual(['survey the runtime (1)', 'survey the runtime (2)']);
  });

  test('reads an isolated Skill as a Skill, and gives it no Agent type to advertise', () => {
    const projection = projectSubagentConversation(input({
      executions: executionMap([execution({
        agentId: SKILL_CHILD_ID,
        agentType: 'isolated-skill',
        description: 'Data Viz',
        runMode: 'foreground',
      })]),
      threadsById: new Map([[SKILL_CHILD_ID, skillChildThread()]]),
    }));

    expect(projection.byAgentId.get(SKILL_CHILD_ID)).toMatchObject({
      displayName: 'Data Viz',
      form: 'isolatedSkill',
      agentType: null,
    });
  });
});

describe('Agent registry identity stability', () => {
  test('re-projects nothing when a delta touches neither the Agent nor its Turn', () => {
    const spawn = activity('spawn', 'started', null, 'agent-call');
    const first = parentTurn('turn-1', [collaborationItem('agent-call', 'agent', 'completed', CHILD_ID), spawn]);
    const streaming = parentTurn('turn-2', [reasoning('thinking')]);
    const before = projectSubagentConversation(input({
      turnsByThread: new Map([[PARENT_ID, [first, streaming]]]),
    }));

    // Exactly what a streaming delta does: one Turn object replaced, every
    // other input identical.
    const after = projectSubagentConversation(input({
      turnsByThread: new Map([[PARENT_ID, [first, parentTurn('turn-2', [reasoning('thinking'), reasoning('more')])]]]),
    }), before);

    expect(after.byAgentId).toBe(before.byAgentId);
    expect(after.byAgentId.get(CHILD_ID)).toBe(before.byAgentId.get(CHILD_ID));
    expect(after.anchorsByTurnId.get('turn-1')).toBe(before.anchorsByTurnId.get('turn-1'));
    expect(after.deliveryByTurnId).toBe(before.deliveryByTurnId);
  });

  test('re-derives no registry when only a Turn streamed', () => {
    // A streaming frame replaces `turnsByThread` and touches none of the three
    // collections the registry reads. Re-deriving it per delta walked the whole
    // subtree, every thread in the store, and an O(n²) descendant count to
    // arrive at what it already had.
    const shared = {
      executions: executionMap([execution()]),
      threadsById: new Map([[CHILD_ID, childThread({ type: 'active', activeFlags: [] })]]),
      latestTurnByThread: new Map(),
    };
    const before = projectSubagentConversation(input({
      ...shared,
      turnsByThread: new Map([[PARENT_ID, [parentTurn('turn-1', [])]]]),
    }));
    const after = projectSubagentConversation(input({
      ...shared,
      turnsByThread: new Map([[PARENT_ID, [parentTurn('turn-1', [reasoning('item-1')])]]]),
    }), before);

    expect(after.byAgentId).toBe(before.byAgentId);
    expect(after.byAgentId.get(CHILD_ID)).toBe(before.byAgentId.get(CHILD_ID));
  });

  test('returns the same projection object when nothing changed at all', () => {
    const turn = parentTurn('turn-1', [activity('spawn', 'started', null, null)]);
    const before = projectSubagentConversation(input({ turnsByThread: new Map([[PARENT_ID, [turn]]]) }));
    const after = projectSubagentConversation(input({ turnsByThread: new Map([[PARENT_ID, [turn]]]) }), before);

    expect(after).toBe(before);
  });

  test('replaces only the Agent that moved, leaving its siblings by reference', () => {
    const before = projectSubagentConversation(input({
      executions: executionMap([execution(), execution({ agentId: SECOND_CHILD_ID, description: 'draft the note' })]),
    }));
    const after = projectSubagentConversation(input({
      executions: executionMap([
        execution({ terminalStatus: 'finished', notificationState: 'pending' }),
        execution({ agentId: SECOND_CHILD_ID, description: 'draft the note' }),
      ]),
    }), before);

    expect(after.byAgentId.get(SECOND_CHILD_ID)).toBe(before.byAgentId.get(SECOND_CHILD_ID));
    expect(after.byAgentId.get(CHILD_ID)).not.toBe(before.byAgentId.get(CHILD_ID));
  });
});

describe('work strip membership', () => {
  const now = 10_000;
  const entryOf = (overrides: Partial<SubagentExecutionProjection>, threads?: SubagentProjectionInput['threadsById']) => (
    projectSubagentConversation(input({
      executions: executionMap([execution(overrides)]),
      ...(threads ? { threadsById: threads } : {}),
    })).byAgentId
  );

  test('leaves foreground work out: it belongs to the Turn it blocks', () => {
    const foreground = entryOf({ runMode: 'foreground' });
    expect(stripRows(foreground, now)).toEqual([]);
  });

  test('keeps a just-finished row briefly, then lets it leave', () => {
    const settled = entryOf({ terminalStatus: 'finished', notificationState: 'pending', updatedAt: now - 1_000 });
    expect(stripRows(settled, now)).toHaveLength(1);
    expect(stripRows(settled, now + SUBAGENT_STRIP_LINGER_MS)).toEqual([]);
  });

  test('sorts running before stopped before just-finished', () => {
    const byAgentId = projectSubagentConversation(input({
      executions: executionMap([
        execution({ agentId: 'agent-finished', terminalStatus: 'finished', updatedAt: now - 500 }),
        execution({ agentId: 'agent-stopped', stopProvenance: 'user', terminalStatus: 'interrupted', updatedAt: now - 500 }),
        execution({ agentId: 'agent-running' }),
      ]),
      threadsById: new Map([['agent-running', { ...childThread({ type: 'active', activeFlags: [] }), id: 'agent-running' }]]),
    })).byAgentId;

    expect(stripRows(byAgentId, now).map((entry) => entry.agentId))
      .toEqual(['agent-running', 'agent-stopped', 'agent-finished']);
  });

  test('shows nothing for a conversation whose Agents finished before it was opened', () => {
    // No settlement time the renderer can trust means the work is history, and
    // the idle deck and the everything-finished deck must look identical.
    const old = entryOf({ terminalStatus: 'finished', updatedAt: 0 });
    expect(stripRows(old, now)).toEqual([]);
  });
});

/** A Turn the host started in the delegating conversation to deliver a result. */
function continuationTurn(id: string, callItemId: string): Turn {
  return {
    ...parentTurn(id, []),
    provenance: {
      originThreadId: PARENT_ID,
      originTurnId: id,
      trigger: { kind: 'subagent', parentThreadId: PARENT_ID, parentItemId: callItemId },
    },
  };
}

function anchorList(
  projection: ReturnType<typeof projectSubagentConversation>,
  turnId: string,
): readonly unknown[] {
  return [...projection.anchorsByTurnId.get(turnId)?.anchorByItemId.values() ?? []];
}

function input(overrides: Partial<SubagentProjectionInput> = {}): SubagentProjectionInput {
  return {
    rootThreadId: PARENT_ID,
    turnsByThread: new Map(),
    executions: executionMap([execution()]),
    threadsById: new Map(),
    latestTurnByThread: new Map(),
    ...overrides,
  };
}

function executionMap(
  executions: readonly SubagentExecutionProjection[],
): ReadonlyMap<string, SubagentExecutionProjection> {
  return new Map(executions.map((execution) => [execution.agentId, execution]));
}

function receipt(overrides: Partial<SubagentGenerationReceipt> = {}): SubagentGenerationReceipt {
  return {
    generation: 1,
    turnId: 'child-turn',
    terminalStatus: 'finished',
    durationMs: 10,
    error: null,
    partialOutputAvailable: true,
    parentThreadId: PARENT_ID,
    notificationState: 'delivered',
    deliveryTurnId: 'turn-2',
    ...overrides,
  };
}

function execution(overrides: Partial<SubagentExecutionProjection> = {}): SubagentExecutionProjection {
  return {
    agentId: CHILD_ID,
    parentThreadId: PARENT_ID,
    description: 'survey the runtime',
    agentType: 'general-purpose',
    runMode: 'background',
    generation: 1,
    currentTurnId: 'child-turn',
    stopProvenance: 'none',
    terminalStatus: null,
    notificationState: 'none',
    terminalError: null,
    deliveryTurnId: null,
    deliveryClass: null,
    eligibleAfterGeneration: null,
    coverageDisposition: null,
    omittedOutputBytes: 0,
    omittedOutputTokens: 0,
    generationReceipts: [],
    notificationCutoff: 'open',
    executionMode: 'ordinary',
    settlementCoverage: null,
    worktree: null,
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  };
}

function parentTurn(
  id: string,
  items: readonly ThreadItem[],
  startedAt = 100,
  status: Turn['status'] = 'inProgress',
): Turn {
  return {
    id,
    items,
    itemsView: 'full',
    provenance: { originThreadId: PARENT_ID, originTurnId: id, trigger: { kind: 'user' } },
    status,
    error: null,
    startedAt,
    completedAt: status === 'inProgress' ? null : startedAt + 10,
    durationMs: status === 'inProgress' ? null : 10,
  };
}

function childTurn(
  id: string,
  status: Turn['status'],
  startedAt: number,
  completedAt: number | null = null,
): Turn {
  return {
    id,
    items: [],
    itemsView: 'full',
    provenance: {
      originThreadId: CHILD_ID,
      originTurnId: id,
      trigger: { kind: 'subagent', parentThreadId: PARENT_ID, parentItemId: 'agent-call' },
    },
    status,
    error: status === 'failed' ? { message: 'Child failed', code: 'runtime_failure' } : null,
    startedAt,
    completedAt: status === 'inProgress' ? null : completedAt ?? startedAt + 10,
    durationMs: status === 'inProgress' ? null : 10,
  };
}

function childThread(status: Thread['status']): Thread {
  return {
    id: CHILD_ID,
    sessionId: 'session',
    parentThreadId: PARENT_ID,
    forkedFromId: null,
    agentNickname: 'Researcher',
    agentRole: 'worker',
    name: null,
    preview: '',
    ephemeral: false,
    source: 'collaboration',
    threadSource: 'subagent',
    modelProvider: 'openai',
    cwd: '/workspace',
    createdAt: 1,
    updatedAt: 1,
    status,
    historyMode: 'paginated',
  };
}

function skillChildThread(): Thread {
  return {
    ...childThread({ type: 'active', activeFlags: [] }),
    id: SKILL_CHILD_ID,
    agentNickname: null,
    agentRole: 'explorer',
    source: 'agent.skill',
  };
}

function activity(
  id: string,
  kind: SubAgentActivityThreadItem['kind'],
  error: SubAgentActivityThreadItem['error'],
  spawnItemId: string | null = null,
  agentTurnId: string | null = 'child-turn',
): SubAgentActivityThreadItem {
  return {
    id,
    provenance: { originThreadId: PARENT_ID, originTurnId: 'turn-parent', originItemId: id },
    type: 'subAgentActivity',
    kind,
    agentThreadId: CHILD_ID,
    agentTurnId,
    agentPath: '/root/research',
    error,
    spawnItemId,
  };
}

function collaborationItem(
  id: string,
  tool: AgentTaskToolName,
  status: 'inProgress' | 'completed',
  receiverThreadId?: string,
): Extract<ThreadItem, { type: 'collabAgentToolCall' }> {
  return {
    id,
    provenance: { originThreadId: PARENT_ID, originTurnId: 'turn-parent', originItemId: id },
    type: 'collabAgentToolCall',
    tool,
    status,
    outputRef: null,
    senderThreadId: PARENT_ID,
    receiverThreadIds: receiverThreadId ? [receiverThreadId] : [],
    prompt: null,
    summary: null,
    model: null,
    reasoningEffort: null,
    agentsStates: {},
  };
}

function reasoning(id: string): Extract<ThreadItem, { type: 'reasoning' }> {
  return {
    id,
    provenance: { originThreadId: PARENT_ID, originTurnId: 'turn-parent', originItemId: id },
    type: 'reasoning',
    summary: [],
    content: [],
  };
}
