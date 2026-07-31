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

export interface SubagentPresentation {
  readonly agentThreadId: ThreadId;
  readonly displayName: string;
  readonly error: TurnError | null;
  readonly nickname: string | null;
  readonly role: string | null;
  readonly startedAt: number | null;
  readonly status: SubagentPresentationStatus;
  readonly taskPath: string | null;
}

export interface SubagentTurnProjection {
  readonly activeThreadIds: readonly ThreadId[];
  readonly byThreadId: ReadonlyMap<ThreadId, SubagentPresentation>;
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
      if (thread.parentThreadId === turn.provenance.originThreadId) relatedThreadIds.add(thread.id);
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
    items,
  };
}

export function presentationFromActivity(item: SubAgentActivityThreadItem): SubagentPresentation {
  const status = item.kind === 'started' ? 'running' : item.kind;
  return {
    agentThreadId: item.agentThreadId,
    displayName: subagentDisplayName(item.agentPath, null, null, item.agentThreadId),
    error: item.error,
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

function subagentDisplayName(
  taskPath: string | null,
  nickname: string | null,
  role: string | null,
  threadId: ThreadId,
): string {
  const taskName = taskPath?.split('/').filter(Boolean).at(-1)?.trim();
  if (taskName) return taskName;
  if (nickname?.trim()) return nickname.trim();
  if (role?.trim()) return role.trim();
  return shortThreadId(threadId);
}

function shortThreadId(threadId: string): string {
  return threadId.length > 12 ? `${threadId.slice(0, 8)}...${threadId.slice(-4)}` : threadId;
}
