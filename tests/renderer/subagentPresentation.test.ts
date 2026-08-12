import { describe, expect, test } from 'bun:test';
import type {
  AgentTaskToolName,
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
    const turn = parentTurn([collaborationItem('message', 'agent_message', 'completed', CHILD_ID)], 100);
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
    const spawn = collaborationItem('spawn-item', 'agent', 'completed', CHILD_ID);
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

  test('does not infer an Agent row from unrelated direct-child catalog state', () => {
    const projection = projectSubagentsForTurn(
      parentTurn([]),
      new Map([[CHILD_ID, childThread({ type: 'active', activeFlags: [] })]]),
      new Map([[CHILD_ID, childTurn('child-active', 'inProgress', 150, 'spawn-from-prior-turn')]]),
    );

    expect(projection.activeThreadIds).toEqual([]);
    expect(projection.byThreadId.size).toBe(0);
  });

  test('projects only an explicitly recorded isolated Skill without scanning sibling Agents', () => {
    const skillStarted: SubAgentActivityThreadItem = {
      ...activity('activity-skill-started', 'started', null),
      agentThreadId: SKILL_CHILD_ID,
      agentPath: '/root/skill_research_ab12cd34ef56',
    };
    const projection = projectSubagentsForTurn(
      parentTurn([skillStarted]),
      new Map([
        [CHILD_ID, childThread({ type: 'active', activeFlags: [] })],
        [SKILL_CHILD_ID, skillChildThread()],
      ]),
      new Map([
        [CHILD_ID, childTurn('child-active', 'inProgress', 150, 'spawn-from-prior-turn')],
      ]),
    );

    expect(projection.activeThreadIds).toEqual([SKILL_CHILD_ID]);
    expect(projection.byThreadId.get(SKILL_CHILD_ID)).toMatchObject({
      displayName: 'research',
      form: 'isolatedSkill',
      status: 'running',
    });
    expect(projection.byThreadId.has(CHILD_ID)).toBe(false);
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
    // A model-chosen task_name may legitimately carry this exact shape, hex tail
    // and all. The child Thread's own source is what decides, so the row keeps
    // the persisted Agent identity recorded for it.
    const skillShaped = '/root/skill_audit_0123456789ab';
    const item = collaborationItem('spawn-item', 'agent', 'completed', CHILD_ID, {
      status: 'completed',
      taskPath: skillShaped,
      nickname: 'Researcher',
      role: 'worker',
    });
    const projection = projectSubagentsForTurn(
      parentTurn([item]),
      new Map([[CHILD_ID, childThread({ type: 'idle' })]]),
      new Map(),
    );

    expect(projection.byThreadId.get(CHILD_ID)).toMatchObject({
      displayName: 'skill_audit_0123456789ab',
      form: 'collaboration',
    });
  });

  test('reads the form from the address when the child record is gone', () => {
    const skillStarted: SubAgentActivityThreadItem = {
      ...activity('activity-skill-started', 'started', null),
      agentThreadId: SKILL_CHILD_ID,
      agentPath: '/root/skill_research_ab12cd34ef56',
    };
    const projection = projectSubagentsForTurn(parentTurn([skillStarted]), new Map(), new Map());

    // Defaulting a dead Skill child to collaboration would incorrectly expose
    // Agent resume semantics for an isolated Skill.
    expect(projection.byThreadId.get(SKILL_CHILD_ID)?.form).toBe('isolatedSkill');
    expect(projection.collaborationThreadIds).toEqual([]);
  });

  test('numbers repeated names so two runs of one Skill are tellable apart', () => {
    const first: SubAgentActivityThreadItem = {
      ...activity('activity-first', 'started', null),
      agentThreadId: SKILL_CHILD_ID,
      agentPath: '/root/skill_research_ab12cd34ef56',
    };
    const second: SubAgentActivityThreadItem = {
      ...activity('activity-second', 'started', null),
      agentThreadId: 'thread-skill-child-2',
      agentPath: '/root/skill_research_ff99aa11bb22',
    };
    const projection = projectSubagentsForTurn(parentTurn([first, second]), new Map(), new Map());

    expect([...projection.byThreadId.values()].map((entry) => entry.displayName))
      .toEqual(['research (1)', 'research (2)']);
  });

  test('renders one delegation at the slot of the call that delegated it', () => {
    const skillCall = skillToolCall('skill-call');
    const started = activity('activity-started', 'started', null, 'skill-call');
    const turn = parentTurn([reasoning('reasoning-before'), skillCall, started]);
    const projection = projectSubagentsForTurn(
      turn,
      new Map([[CHILD_ID, childThread({ type: 'active', activeFlags: [] })]]),
      new Map(),
    );

    // The tool call is gone and the row took its place: one delegation, named
    // once, at the position where the model decided on it.
    expect(projection.items.map((item) => item.id)).toEqual([
      'reasoning-before',
      'activity-started',
    ]);
  });

  test('keeps the delegation row where the delegating call is not in this Turn', () => {
    // A fire-and-forget child settling into a later parent Turn: its terminal
    // activity names no call here, so it must not claim an unrelated Item.
    const skillCall = skillToolCall('unrelated-call');
    const settled = activity('activity-completed', 'completed', null);
    const projection = projectSubagentsForTurn(
      parentTurn([skillCall, settled]),
      new Map(),
      new Map(),
    );

    expect(projection.items.map((item) => item.id)).toEqual([
      'unrelated-call',
      'activity-completed',
    ]);
  });

  test('collapses a started/terminal pair onto the delegating call exactly once', () => {
    const skillCall = skillToolCall('skill-call');
    const started = activity('activity-started', 'started', null, 'skill-call');
    const done = activity('activity-completed', 'completed', null, null);
    const projection = projectSubagentsForTurn(
      parentTurn([skillCall, started, done]),
      new Map(),
      new Map(),
    );

    expect(projection.items.map((item) => item.id)).toEqual(['activity-started']);
    expect(projection.byThreadId.get(CHILD_ID)?.status).toBe('completed');
  });

  test('carries the settled child Turn duration, since a finished row has no clock', () => {
    const started = activity('activity-started', 'started', null);
    const done = childTurn('child-done', 'completed', 100, 'spawn-item', 192_100);
    const projection = projectSubagentsForTurn(
      parentTurn([started]),
      new Map([[CHILD_ID, childThread({ type: 'idle' })]]),
      new Map([[CHILD_ID, done]]),
    );

    expect(projection.byThreadId.get(CHILD_ID)).toMatchObject({
      status: 'completed',
      durationMs: done.durationMs,
    });
  });

  test('reports no duration where only the terminal Item survived the reload', () => {
    const projection = projectSubagentsForTurn(
      parentTurn([activity('activity-done', 'completed', null)]),
      new Map(),
      new Map(),
    );

    // Better a row that says `Completed` than one inventing a span it never saw.
    expect(projection.byThreadId.get(CHILD_ID)).toMatchObject({
      status: 'completed',
      durationMs: null,
    });
  });

  test('does not project an unrelated Skill child from the catalog alone', () => {
    const projection = projectSubagentsForTurn(
      parentTurn([]),
      new Map([[SKILL_CHILD_ID, skillChildThread()]]),
      new Map(),
    );

    expect(projection.byThreadId.size).toBe(0);
    expect(projection.activeThreadIds).toEqual([]);
  });

  test('keeps persisted identity after deletion without treating the snapshot as live truth', () => {
    const item = collaborationItem('spawn-item', 'agent', 'completed', CHILD_ID);
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
  spawnItemId: string | null = null,
): SubAgentActivityThreadItem {
  return {
    id,
    provenance: { originThreadId: PARENT_ID, originTurnId: 'turn-parent', originItemId: id },
    type: 'subAgentActivity',
    kind,
    agentThreadId: CHILD_ID,
    agentPath: '/root/research',
    error,
    spawnItemId,
  };
}

function skillToolCall(id: string): ThreadItem {
  return {
    id,
    provenance: { originThreadId: PARENT_ID, originTurnId: 'turn-parent', originItemId: id },
    type: 'dynamicToolCall',
    namespace: null,
    tool: 'skill',
    arguments: { name: 'research' },
    modelCall: null,
    contentItems: null,
    status: 'inProgress',
    success: null,
    durationMs: null,
    outputRef: null,
  };
}

function collaborationItem(
  id: string,
  tool: AgentTaskToolName,
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
