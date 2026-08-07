import type {
  CollabAgentToolCallThreadItem,
  SubAgentActivityThreadItem,
  SubagentExecutionState,
  SubagentExecutionStatus,
  Thread,
  ThreadId,
  ThreadItem,
  Turn,
  TurnError,
} from '../../core/agent/protocol';
import { isolatedSkillNameFromTaskName } from '../../core/agent/subagentTaskPath';
import { userFacingAgentErrorRecord } from './threadErrorMessage';

export type SubagentPresentationStatus = SubagentExecutionStatus | 'idle';

/**
 * Which delegated form a row describes. Every form is shown as process, but only
 * collaboration children are what `wait_agent` waits on and what a collaboration
 * tool row is accountable for — counting an isolated Skill child there would
 * describe work the parent is not actually waiting on.
 */
export type SubagentDelegationForm = 'collaboration' | 'isolatedSkill';

export interface SubagentPresentation {
  readonly agentThreadId: ThreadId;
  readonly displayName: string;
  readonly error: TurnError | null;
  readonly form: SubagentDelegationForm;
  readonly nickname: string | null;
  readonly role: string | null;
  readonly startedAt: number | null;
  readonly status: SubagentPresentationStatus;
  readonly taskPath: string | null;
}

export interface SubagentTurnProjection {
  readonly activeThreadIds: readonly ThreadId[];
  readonly byThreadId: ReadonlyMap<ThreadId, SubagentPresentation>;
  /**
   * The children a wait blocks on and a collaboration tool row is accountable
   * for. Derived once here: every consumer that re-derived it would have to be
   * found again when a third delegation form appears.
   */
  readonly collaborationThreadIds: readonly ThreadId[];
  readonly items: readonly ThreadItem[];
}

export interface CollaborationResultSnapshot {
  readonly receiverThreadIds: readonly ThreadId[];
  readonly agentsStates: CollabAgentToolCallThreadItem['agentsStates'];
}

interface ActivityEvidence {
  readonly first: SubAgentActivityThreadItem;
  terminal: SubAgentActivityThreadItem | null;
}

export function projectSubagentsForTurn(
  turn: Turn,
  threadsById: ReadonlyMap<ThreadId, Thread>,
  latestTurnByThread: ReadonlyMap<ThreadId, Turn>,
): SubagentTurnProjection {
  const activities = new Map<ThreadId, ActivityEvidence>();
  const snapshots = new Map<ThreadId, SubagentExecutionState>();
  const relatedThreadIds = new Set<ThreadId>();

  for (const item of turn.items) {
    if (item.type === 'subAgentActivity') {
      relatedThreadIds.add(item.agentThreadId);
      const evidence = activities.get(item.agentThreadId);
      if (!evidence) {
        activities.set(item.agentThreadId, {
          first: item,
          terminal: item.kind === 'started' ? null : item,
        });
      } else if (item.kind !== 'started') {
        evidence.terminal = item;
      }
      continue;
    }
    if (item.type !== 'collabAgentToolCall') continue;
    for (const threadId of item.receiverThreadIds) relatedThreadIds.add(threadId);
    for (const [threadId, state] of Object.entries(item.agentsStates)) {
      relatedThreadIds.add(threadId);
      snapshots.set(threadId, mergeSnapshot(snapshots.get(threadId), state));
    }
  }

  const waitingForSubagents = turn.items.some((item) => (
    item.type === 'collabAgentToolCall'
    && item.tool === 'wait_agent'
    && item.status === 'inProgress'
  ));
  if (waitingForSubagents) {
    for (const thread of threadsById.values()) {
      // Only collaboration children: a wait is never blocked on an isolated
      // Skill child, so pulling one in here would inflate what the parent
      // claims to be waiting for.
      if (thread.parentThreadId === turn.provenance.originThreadId && thread.source === 'collaboration') {
        relatedThreadIds.add(thread.id);
      }
    }
  }

  const byThreadId = new Map<ThreadId, SubagentPresentation>();
  for (const threadId of relatedThreadIds) {
    const activity = activities.get(threadId);
    const snapshot = snapshots.get(threadId);
    const thread = threadsById.get(threadId);
    const latestTurn = latestTurnByThread.get(threadId);
    const taskPath = activity?.first.agentPath ?? snapshot?.taskPath ?? null;
    const nickname = snapshot?.nickname ?? thread?.agentNickname ?? null;
    const role = snapshot?.role ?? thread?.agentRole ?? null;
    const live = livePresentationState(turn, activity ?? null, thread ?? null, latestTurn ?? null);
    const form = delegationForm(thread ?? null, taskPath);
    byThreadId.set(threadId, {
      agentThreadId: threadId,
      displayName: subagentDisplayName(taskPath, nickname, role, threadId, form),
      error: live.error,
      form,
      nickname,
      role,
      startedAt: live.startedAt,
      status: live.status,
      taskPath,
    });
  }
  disambiguateDisplayNames(byThreadId);

  const seenActivities = new Set<ThreadId>();
  const items = turn.items.filter((item) => {
    if (item.type !== 'subAgentActivity') return true;
    if (seenActivities.has(item.agentThreadId)) return false;
    seenActivities.add(item.agentThreadId);
    return true;
  });
  return {
    activeThreadIds: [...byThreadId.values()]
      .filter((entry) => entry.status === 'pendingInit' || entry.status === 'running')
      .map((entry) => entry.agentThreadId),
    byThreadId,
    collaborationThreadIds: collaborationThreadIds(byThreadId),
    items,
  };
}

/**
 * The children a wait blocks on and a collaboration tool row is accountable
 * for. One definition, because a consumer that re-derives it is a consumer that
 * has to be found again when a third delegation form appears.
 */
export function collaborationThreadIds(
  byThreadId: ReadonlyMap<ThreadId, SubagentPresentation>,
): readonly ThreadId[] {
  return [...byThreadId.values()]
    .filter((entry) => entry.form === 'collaboration')
    .map((entry) => entry.agentThreadId);
}

export function presentationFromActivity(item: SubAgentActivityThreadItem): SubagentPresentation {
  const status = item.kind === 'started' ? 'running' : item.kind;
  // No catalog to consult from a lone Item, so the address is the evidence —
  // the same rule the projection falls back to for a child with no record.
  const form = delegationForm(null, item.agentPath);
  return {
    agentThreadId: item.agentThreadId,
    displayName: subagentDisplayName(item.agentPath, null, null, item.agentThreadId, form),
    error: item.error,
    form,
    nickname: null,
    role: null,
    startedAt: null,
    status,
    taskPath: item.agentPath,
  };
}

export function presentationFromSnapshot(
  threadId: ThreadId,
  state: SubagentExecutionState | undefined,
): SubagentPresentation {
  const taskPath = state?.taskPath ?? null;
  const nickname = state?.nickname ?? null;
  const role = state?.role ?? null;
  return {
    agentThreadId: threadId,
    // A persisted collaboration snapshot only ever records collaboration children.
    displayName: subagentDisplayName(taskPath, nickname, role, threadId, 'collaboration'),
    error: null,
    form: 'collaboration',
    nickname,
    role,
    startedAt: null,
    status: state?.status ?? 'notFound',
    taskPath,
  };
}

export function collaborationResultSnapshot(
  item: CollabAgentToolCallThreadItem,
): CollaborationResultSnapshot {
  return {
    receiverThreadIds: item.receiverThreadIds,
    agentsStates: item.agentsStates,
  };
}

export function threadItemForUserSurface(
  item: ThreadItem,
  resourceLimitMessage: string,
): ThreadItem {
  if (item.type === 'collabAgentToolCall') {
    return { ...item, outputRef: null };
  }
  if (item.type === 'subAgentActivity' && item.error) {
    return {
      ...item,
      error: userFacingAgentErrorRecord(item.error, resourceLimitMessage),
    };
  }
  return item;
}

function livePresentationState(
  parentTurn: Turn,
  activity: ActivityEvidence | null,
  thread: Thread | null,
  latestTurn: Turn | null,
): Pick<SubagentPresentation, 'error' | 'startedAt' | 'status'> {
  if (activity?.terminal) {
    return {
      error: activity.terminal.error,
      startedAt: null,
      status: activity.terminal.kind === 'started' ? 'running' : activity.terminal.kind,
    };
  }

  const latestBelongsToParent = latestTurn?.provenance.trigger.kind === 'subagent'
    && turnOwnsItem(parentTurn, latestTurn.provenance.trigger.parentItemId);
  const latestCanDriveLiveState = parentTurn.status === 'inProgress' || latestBelongsToParent;
  if (latestCanDriveLiveState && latestTurn?.status === 'inProgress') {
    return { error: null, startedAt: latestTurn.startedAt, status: 'running' };
  }

  const terminalIsCurrent = latestCanDriveLiveState
    && latestTurn !== null
    && (latestBelongsToParent || (latestTurn.completedAt ?? latestTurn.startedAt) >= parentTurn.startedAt);
  if (terminalIsCurrent && latestTurn) return terminalTurnPresentation(latestTurn);

  if (!thread) {
    return { error: null, startedAt: null, status: 'notFound' };
  }
  switch (thread.status.type) {
    case 'active':
      return { error: null, startedAt: null, status: 'running' };
    case 'idle':
      return { error: null, startedAt: null, status: 'idle' };
    case 'notLoaded':
      return { error: null, startedAt: null, status: 'pendingInit' };
    case 'systemError':
      return {
        error: thread.status.message
          ? { message: thread.status.message, code: 'runtime_failure' }
          : null,
        startedAt: null,
        status: 'errored',
      };
  }
}

/**
 * Two runs of one Skill inside a Turn produce two rows with the same name — the
 * address suffix that told them apart is exactly what the row stops rendering.
 * Numbering the repeats in canonical order restores that for every consumer at
 * once: the visible row, its title, and the accessible name a screen-reader
 * user picks a button from. Unique names are untouched, so the common row keeps
 * reading as the bare Skill name.
 */
function disambiguateDisplayNames(byThreadId: Map<ThreadId, SubagentPresentation>): void {
  const counts = new Map<string, number>();
  for (const entry of byThreadId.values()) {
    counts.set(entry.displayName, (counts.get(entry.displayName) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  for (const [threadId, entry] of byThreadId) {
    if ((counts.get(entry.displayName) ?? 0) < 2) continue;
    const ordinal = (seen.get(entry.displayName) ?? 0) + 1;
    seen.set(entry.displayName, ordinal);
    byThreadId.set(threadId, { ...entry, displayName: `${entry.displayName} (${ordinal})` });
  }
}

/**
 * The child Thread's own `source` decides the form. When the record is gone the
 * address is the only surviving evidence, and reading it beats the previous
 * unconditional `collaboration`: that made a deleted Skill child count into
 * `collaborationThreadIds`, inflating `Waiting on N subagents` with work no
 * wait was ever blocked on.
 *
 * Shape is evidence, not proof — a model-chosen collaboration `task_name` could
 * coincide with it — which is exactly why a live record always wins.
 */
function delegationForm(thread: Thread | null, taskPath: string | null): SubagentDelegationForm {
  if (thread) return thread.source === 'agent.skill' ? 'isolatedSkill' : 'collaboration';
  return taskPath !== null && isolatedSkillSlug(taskPath) !== null ? 'isolatedSkill' : 'collaboration';
}

function isolatedSkillSlug(taskPath: string): string | null {
  const taskName = taskPath.split('/').filter(Boolean).at(-1)?.trim();
  return taskName ? isolatedSkillNameFromTaskName(taskName) : null;
}

function turnOwnsItem(turn: Turn, itemId: string): boolean {
  return turn.items.some((item) => item.id === itemId);
}

function terminalTurnPresentation(
  turn: Turn,
): Pick<SubagentPresentation, 'error' | 'startedAt' | 'status'> {
  if (turn.status === 'failed') return { error: turn.error, startedAt: null, status: 'errored' };
  if (turn.status === 'interrupted') return { error: turn.error, startedAt: null, status: 'interrupted' };
  return { error: null, startedAt: null, status: 'completed' };
}

function mergeSnapshot(
  current: SubagentExecutionState | undefined,
  next: SubagentExecutionState,
): SubagentExecutionState {
  return {
    status: next.status,
    taskPath: next.taskPath ?? current?.taskPath ?? null,
    nickname: next.nickname ?? current?.nickname ?? null,
    role: next.role ?? current?.role ?? null,
  };
}

/**
 * An isolated Skill's task-path segment is an address, not a name, so it yields
 * to the recorded Skill name (or, with no record left, to the slug alone).
 * Gated on the resolved FORM rather than on the address shape: a collaboration
 * child whose model-chosen `task_name` happens to look like the address keeps
 * its task name, which is the identity `list_agents` and `send_message` use and
 * therefore the only one a reader can correlate a row with.
 */
function subagentDisplayName(
  taskPath: string | null,
  nickname: string | null,
  role: string | null,
  threadId: ThreadId,
  form: SubagentDelegationForm,
): string {
  const taskName = taskPath?.split('/').filter(Boolean).at(-1)?.trim();
  const skillSlug = form === 'isolatedSkill' && taskName
    ? isolatedSkillNameFromTaskName(taskName)
    : null;
  // The recorded Skill name outranks the slug: spawn stores it verbatim, so
  // `Data Viz` survives there while the address only kept `data_viz`.
  if (skillSlug) return nickname?.trim() || skillSlug;
  if (taskName) return taskName;
  if (nickname?.trim()) return nickname.trim();
  if (role?.trim()) return role.trim();
  return shortThreadId(threadId);
}

function shortThreadId(threadId: string): string {
  return threadId.length > 12 ? `${threadId.slice(0, 8)}...${threadId.slice(-4)}` : threadId;
}
