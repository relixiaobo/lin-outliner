import { describe, expect, test } from 'bun:test';
import type {
  SubAgentActivityThreadItem,
  SubagentExecutionState,
  Thread,
  ThreadItem,
  Turn,
} from '../../src/core/agent/protocol';
import { projectSubagentsForTurn } from '../../src/renderer/agent/subagentPresentation';

const PARENT_ID = 'thread-parent';
const CHILD_ID = 'thread-child';
const SKILL_CHILD_ID = 'thread-skill-child';

describe('Subagent parent-Turn presentation projection', () => {
  test('keeps the first canonical slot while the latest terminal Item owns status and error', () => {
    const started = activity('activity-started', 'started', null);
    const terminalError = {
      message: 'Token budget exhausted (120 of 100)',
      code: 'subagent_budget_exhausted' as const,
    };
    const errored = activity('activity-errored', 'errored', terminalError);
    const turn = parentTurn([
      reasoning('reasoning-before'),
      started,
      reasoning('reasoning-middle'),
      errored,
    ]);
    const projection = projectSubagentsForTurn(
      turn,
      new Map([[CHILD_ID, childThread({ type: 'active', activeFlags: [] })]]),
      new Map([[CHILD_ID, childTurn('child-followup', 'inProgress', 250, 'later-parent-item')]]),
    );

    expect(projection.items.map((item) => item.id)).toEqual([
      'reasoning-before',
      'activity-started',
      'reasoning-middle',
    ]);
    expect(projection.byThreadId.get(CHILD_ID)).toMatchObject({
      displayName: 'research',
      status: 'errored',
      error: terminalError,
    });
  });

  test('uses a current child completion immediately, but renders an older completed child as idle', () => {
    const turn = parentTurn([collaborationItem('list', 'list_agents', 'completed', CHILD_ID)], 100);
    const idleChild = childThread({ type: 'idle' });
    const completedNow = childTurn('child-current', 'completed', 120, 'older-parent-item', 180);
    const completedBefore = childTurn('child-old', 'completed', 20, 'older-parent-item', 80);

    expect(projectSubagentsForTurn(
      turn,
      new Map([[CHILD_ID, idleChild]]),
      new Map([[CHILD_ID, completedNow]]),
    ).byThreadId.get(CHILD_ID)?.status).toBe('completed');
    expect(projectSubagentsForTurn(
      turn,
      new Map([[CHILD_ID, idleChild]]),
      new Map([[CHILD_ID, completedBefore]]),
    ).byThreadId.get(CHILD_ID)?.status).toBe('idle');
  });

  test('does not let a later follow-up Turn rewrite a settled parent Turn', () => {
    const spawn = collaborationItem('spawn-item', 'spawn_agent', 'completed', CHILD_ID);
    const settledParent = parentTurn([activity('activity-started', 'started', null), spawn], 100, 'completed');
    const laterFollowup = childTurn('child-followup', 'inProgress', 300, 'followup-item');
    const projection = projectSubagentsForTurn(
      settledParent,
      new Map([[CHILD_ID, childThread({ type: 'active', activeFlags: [] })]]),
      new Map([[CHILD_ID, laterFollowup]]),
    );

    expect(projection.byThreadId.get(CHILD_ID)?.startedAt).toBeNull();
    expect(projection.byThreadId.get(CHILD_ID)?.status).toBe('running');
  });

  test('derives a wait-only bottleneck from direct child catalog state', () => {
    const wait = collaborationItem('wait-item', 'wait_agent', 'inProgress');
    const projection = projectSubagentsForTurn(
      parentTurn([wait]),
      new Map([[CHILD_ID, childThread({ type: 'active', activeFlags: [] })]]),
      new Map([[CHILD_ID, childTurn('child-active', 'inProgress', 150, 'spawn-from-prior-turn')]]),
    );

    expect(projection.activeThreadIds).toEqual([CHILD_ID]);
    expect(projection.byThreadId.get(CHILD_ID)).toMatchObject({
      displayName: 'Researcher',
      status: 'running',
      startedAt: 150,
    });
  });

  test('projects an isolated Skill child as delegated work a wait is not waiting for', () => {
    const skillStarted: SubAgentActivityThreadItem = {
      ...activity('activity-skill-started', 'started', null),
      agentThreadId: SKILL_CHILD_ID,
      agentPath: '/root/skill_research_ab12cd34ef56',
    };
    const wait = collaborationItem('wait-item', 'wait_agent', 'inProgress');
    const projection = projectSubagentsForTurn(
      parentTurn([wait, skillStarted]),
      new Map([
        [CHILD_ID, childThread({ type: 'active', activeFlags: [] })],
        [SKILL_CHILD_ID, skillChildThread()],
      ]),
      new Map([
        [CHILD_ID, childTurn('child-active', 'inProgress', 150, 'spawn-from-prior-turn')],
      ]),
    );

    // Both are live delegated children and both get a row...
    expect(projection.activeThreadIds).toEqual(expect.arrayContaining([CHILD_ID, SKILL_CHILD_ID]));
    expect(projection.byThreadId.get(SKILL_CHILD_ID)).toMatchObject({
      displayName: 'research',
      form: 'isolatedSkill',
      status: 'running',
    });
    // ...but only the collaboration child is what the wait is blocked on.
    expect(projection.byThreadId.get(CHILD_ID)?.form).toBe('collaboration');
  });

  test('names an isolated Skill child by its recorded Skill name, not its address', () => {
    const skillStarted: SubAgentActivityThreadItem = {
      ...activity('activity-skill-started', 'started', null),
      agentThreadId: SKILL_CHILD_ID,
      agentPath: '/root/skill_data_viz_ab12cd34ef56',
    };
    const projection = projectSubagentsForTurn(
      parentTurn([skillStarted]),
      new Map([[SKILL_CHILD_ID, { ...skillChildThread(), agentNickname: 'Data Viz' }]]),
      new Map(),
    );

    // The slug folded case and spaces away; the Thread record did not.
    expect(projection.byThreadId.get(SKILL_CHILD_ID)?.displayName).toBe('Data Viz');
  });

  test('strips the address suffix when the Skill child is gone and only its path survives', () => {
    const skillStarted: SubAgentActivityThreadItem = {
      ...activity('activity-skill-started', 'started', null),
      agentThreadId: SKILL_CHILD_ID,
      agentPath: '/root/skill_research_ab12cd34ef56',
    };
    const projection = projectSubagentsForTurn(parentTurn([skillStarted]), new Map(), new Map());

    // No Thread record left to carry the name, and no form to consult either —
    // the shape of the address is the only thing to go on.
    expect(projection.byThreadId.get(SKILL_CHILD_ID)).toMatchObject({
      displayName: 'research',
      status: 'notFound',
    });
  });

  test('leaves a collaboration task name that merely looks addressed alone', () => {
    const item = collaborationItem('spawn-item', 'spawn_agent', 'completed', CHILD_ID, {
      status: 'completed',
      taskPath: '/root/skill_research_notactually',
      nickname: null,
      role: 'worker',
    });
    const projection = projectSubagentsForTurn(parentTurn([item]), new Map(), new Map());

    expect(projection.byThreadId.get(CHILD_ID)?.displayName).toBe('skill_research_notactually');
  });

  test('leaves a Skill child out of the wait-time direct-child expansion', () => {
    const wait = collaborationItem('wait-item', 'wait_agent', 'inProgress');
    const projection = projectSubagentsForTurn(
      parentTurn([wait]),
      new Map([[SKILL_CHILD_ID, skillChildThread()]]),
      new Map(),
    );

    expect(projection.byThreadId.size).toBe(0);
    expect(projection.activeThreadIds).toEqual([]);
  });

  test('keeps persisted identity after deletion without treating the snapshot as live truth', () => {
    const item = collaborationItem('spawn-item', 'spawn_agent', 'completed', CHILD_ID);
    const projection = projectSubagentsForTurn(parentTurn([item]), new Map(), new Map());

    expect(projection.byThreadId.get(CHILD_ID)).toMatchObject({
      displayName: 'research',
      taskPath: '/root/research',
      nickname: 'Researcher',
      role: 'worker',
      status: 'notFound',
    });
  });
});

function parentTurn(
  items: readonly ThreadItem[],
  startedAt = 100,
  status: Turn['status'] = 'inProgress',
): Turn {
  return {
    id: 'turn-parent',
    items,
    itemsView: 'full',
    provenance: { originThreadId: PARENT_ID, originTurnId: 'turn-parent', trigger: { kind: 'user' } },
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
  parentItemId: string,
  completedAt: number | null = null,
): Turn {
  return {
    id,
    items: [],
    itemsView: 'full',
    provenance: {
      originThreadId: CHILD_ID,
      originTurnId: id,
      trigger: { kind: 'subagent', parentThreadId: PARENT_ID, parentItemId },
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
): SubAgentActivityThreadItem {
  return {
    id,
    provenance: { originThreadId: PARENT_ID, originTurnId: 'turn-parent', originItemId: id },
    type: 'subAgentActivity',
    kind,
    agentThreadId: CHILD_ID,
    agentPath: '/root/research',
    error,
  };
}

function collaborationItem(
  id: string,
  tool: 'spawn_agent' | 'list_agents' | 'wait_agent',
  status: 'inProgress' | 'completed',
  receiverThreadId?: string,
  state?: SubagentExecutionState,
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
    model: null,
    reasoningEffort: null,
    agentsStates: receiverThreadId ? {
      [receiverThreadId]: state ?? {
        status: 'completed',
        taskPath: '/root/research',
        nickname: 'Researcher',
        role: 'worker',
      },
    } : {},
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
