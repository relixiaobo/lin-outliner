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

/** Which delegated form a row describes. Both render as process, but only an
 * Agent is addressable and resumable; an isolated Skill remains read-only. */
export type SubagentDelegationForm = 'collaboration' | 'isolatedSkill';

export interface SubagentPresentation {
  readonly agentThreadId: ThreadId;
  readonly displayName: string;
  /**
   * How long the child's own Turn took, once it has one and the renderer knows
   * it. A running child measures from `startedAt` instead; a settled one has no
   * clock left to read, so without this a finished row could only ever say
   * `Completed` and never `Completed · 3m 12s`.
   */
  readonly durationMs: number | null;
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
  /** The Agent children that model-visible Agent task calls are accountable for. */
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
      durationMs: live.durationMs,
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

  return {
    activeThreadIds: [...byThreadId.values()]
      .filter((entry) => entry.status === 'pendingInit' || entry.status === 'running')
      .map((entry) => entry.agentThreadId),
    byThreadId,
    collaborationThreadIds: collaborationThreadIds(byThreadId),
    items: delegationCollapsedItems(turn, activities),
  };
}

/**
 * One delegation, one row, at the position where it was decided.
 *
 * A delegated child otherwise reaches the reader twice in two vocabularies: the
 * tool call that delegated (`Used the research skill`) and the child's own
 * activity row, which is the same event named differently. The activity row is
 * the one that can carry live status, elapsed time, a Stop, and a way into the
 * child, so it stands in for the call and takes its canonical slot — the slot
 * being the delegating call's, so the row can never precede the reasoning that
 * produced it.
 *
 * Collapsing here rather than in the leaf renderer is deliberate: everything
 * upstream reasons over this list, so a row hidden at the paint step would still
 * be counted, grouped, and adjacency-checked as present.
 */
function delegationCollapsedItems(
  turn: Turn,
  activities: ReadonlyMap<ThreadId, ActivityEvidence>,
): readonly ThreadItem[] {
  const itemIds = new Set(turn.items.map((item) => item.id));
  const standsInFor = new Map<string, ThreadId>();
  for (const [threadId, evidence] of activities) {
    // Only the spawn-time activity claims a call, and only within the Turn that
    // holds it: a terminal activity flushed into a later Turn names nothing here.
    const claim = evidence.first.spawnItemId;
    if (claim !== null && itemIds.has(claim)) standsInFor.set(claim, threadId);
  }
  const relocated = new Set(standsInFor.values());

  const seenActivities = new Set<ThreadId>();
  const items: ThreadItem[] = [];
  for (const item of turn.items) {
    if (item.type === 'subAgentActivity') {
      if (seenActivities.has(item.agentThreadId)) continue;
      seenActivities.add(item.agentThreadId);
      if (relocated.has(item.agentThreadId)) continue;
      items.push(item);
      continue;
    }
    const standIn = standsInFor.get(item.id);
    if (standIn !== undefined) {
      items.push(activities.get(standIn)!.first);
      seenActivities.add(standIn);
      continue;
    }
    items.push(item);
  }
  return items;
}

/** Agent children a model-visible Agent task call is accountable for. */
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
    durationMs: null,
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
    durationMs: null,
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
): Pick<SubagentPresentation, 'durationMs' | 'error' | 'startedAt' | 'status'> {
  if (activity?.terminal) {
    // A terminal Item records the outcome, not the clock. Where the child's own
    // Turn DTO is still around it supplies the duration below; after a reload
    // that leaves only this Item, the row honestly says the status alone.
    return {
      durationMs: durationFromTurn(latestTurn, activity.terminal.agentThreadId),
      error: activity.terminal.error,
      startedAt: null,
      status: activity.terminal.kind === 'started' ? 'running' : activity.terminal.kind,
    };
  }

  const latestBelongsToParent = latestTurn?.provenance.trigger.kind === 'subagent'
    && turnOwnsItem(parentTurn, latestTurn.provenance.trigger.parentItemId);
  const latestCanDriveLiveState = parentTurn.status === 'inProgress' || latestBelongsToParent;
  if (latestCanDriveLiveState && latestTurn?.status === 'inProgress') {
    return { durationMs: null, error: null, startedAt: latestTurn.startedAt, status: 'running' };
  }

  const terminalIsCurrent = latestCanDriveLiveState
    && latestTurn !== null
    && (latestBelongsToParent || (latestTurn.completedAt ?? latestTurn.startedAt) >= parentTurn.startedAt);
  if (terminalIsCurrent && latestTurn) return terminalTurnPresentation(latestTurn);

  if (!thread) {
    return { durationMs: null, error: null, startedAt: null, status: 'notFound' };
  }
  switch (thread.status.type) {
    case 'active':
      return { durationMs: null, error: null, startedAt: null, status: 'running' };
    case 'idle':
      return { durationMs: null, error: null, startedAt: null, status: 'idle' };
    case 'notLoaded':
      return { durationMs: null, error: null, startedAt: null, status: 'pendingInit' };
    case 'systemError':
      return {
        durationMs: null,
        error: thread.status.message
          ? { message: thread.status.message, code: 'runtime_failure' }
          : null,
        startedAt: null,
        status: 'errored',
      };
  }
}

/** The child Turn's own recorded span, when the DTO in hand is that child's. */
function durationFromTurn(turn: Turn | null, agentThreadId: ThreadId): number | null {
  if (!turn || turn.provenance.originThreadId !== agentThreadId) return null;
  return turn.durationMs;
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
 * unconditional `collaboration`: that made a deleted Skill child count as an
 * addressable Agent even though it has no Agent resume semantics.
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
): Pick<SubagentPresentation, 'durationMs' | 'error' | 'startedAt' | 'status'> {
  const settled = { durationMs: turn.durationMs, startedAt: null };
  if (turn.status === 'failed') return { ...settled, error: turn.error, status: 'errored' };
  if (turn.status === 'interrupted') return { ...settled, error: turn.error, status: 'interrupted' };
  return { ...settled, error: null, status: 'completed' };
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
 * its task name, which remains the only identity a reader can correlate with
 * the recorded delegation.
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
