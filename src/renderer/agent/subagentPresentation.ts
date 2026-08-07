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
    byThreadId.set(threadId, {
      agentThreadId: threadId,
      displayName: subagentDisplayName(taskPath, nickname, role, threadId),
      error: live.error,
      form: delegationForm(thread ?? null),
      nickname,
      role,
      startedAt: live.startedAt,
      status: live.status,
      taskPath,
    });
  }

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
  return {
    agentThreadId: item.agentThreadId,
    displayName: subagentDisplayName(item.agentPath, null, null, item.agentThreadId),
    error: item.error,
    form: 'collaboration',
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
    displayName: subagentDisplayName(taskPath, nickname, role, threadId),
    error: null,
    // A persisted collaboration snapshot only ever records collaboration children.
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
 * An unknown Thread reads as collaboration: that is the pre-existing meaning of
 * a row whose child is no longer in the catalog, and the form only ever narrows
 * counts, never widens them.
 */
function delegationForm(thread: Thread | null): SubagentDelegationForm {
  return thread?.source === 'agent.skill' ? 'isolatedSkill' : 'collaboration';
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
 * An isolated Skill's task-path segment is `skill_<slug>_<12 hex>`: the suffix
 * exists so two runs of one Skill get distinct session addresses, and the slug
 * has already folded case and spaces away. Neither is a name, so a row that
 * renders the segment renders twelve characters no reader can use.
 *
 * Matched by shape rather than by the delegation form, because the case that
 * needs it most has no form left to consult: once the child Thread is deleted,
 * its activity Item's `agentPath` is the only surviving identity.
 */
const ISOLATED_SKILL_TASK_NAME = /^skill_(.+)_[0-9a-f]{12}$/;

function subagentDisplayName(
  taskPath: string | null,
  nickname: string | null,
  role: string | null,
  threadId: ThreadId,
): string {
  const taskName = taskPath?.split('/').filter(Boolean).at(-1)?.trim();
  const skillSlug = taskName?.match(ISOLATED_SKILL_TASK_NAME)?.[1];
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
