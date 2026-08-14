import type {
  CollabAgentToolCallThreadItem,
  SubAgentActivityThreadItem,
  SubagentExecutionProjection,
  SubagentRunMode,
  SubagentWorktreeSummary,
  Thread,
  ThreadId,
  ThreadItem,
  ThreadItemId,
  Turn,
  TurnError,
  TurnId,
} from '../../core/agent/protocol';
import { isolatedSkillNameFromTaskName } from '../../core/agent/subagentTaskPath';
import { userFacingAgentErrorRecord } from './threadErrorMessage';

/**
 * Which delegated form an entry describes. Both render as process, but only an
 * Agent is addressable and resumable; an isolated Skill remains read-only and
 * its result stays owned by the `skill` call that invoked it.
 */
export type SubagentDelegationForm = 'agent' | 'isolatedSkill';

export type SubagentRegistryStatus =
  | 'pendingInit'
  | 'running'
  | 'idle'
  | 'interrupted'
  | 'completed'
  | 'errored'
  | 'notFound';

/**
 * One Agent, for its whole life.
 *
 * Keyed by the stable Agent ID rather than by the Turn that spawned it: a
 * resume appends a generation to the same Agent, so a Turn-anchored entry would
 * either duplicate that Agent under every Turn that touched it or orphan the
 * generations that no Turn owns.
 */
export interface SubagentRegistryEntry {
  readonly agentId: ThreadId;
  readonly parentThreadId: ThreadId;
  readonly displayName: string;
  /** The selected Agent type, shown muted beside the name. */
  readonly agentType: string | null;
  readonly form: SubagentDelegationForm;
  readonly runMode: SubagentRunMode;
  readonly generation: number;
  readonly status: SubagentRegistryStatus;
  /** User authority: the model may not resume this Agent until the user does. */
  readonly stoppedByUser: boolean;
  readonly startedAt: number | null;
  readonly durationMs: number | null;
  /** When the current generation settled, where the renderer can know it. */
  readonly settledAt: number | null;
  readonly error: TurnError | null;
  readonly worktree: SubagentWorktreeSummary | null;
  /** Live Agents below this one, at any depth. */
  readonly liveDescendantCount: number;
}

export type SubagentAnchorKind = 'spawn' | 'resume' | 'foreground';

/** One lifecycle event, at the canonical Item position where it happened. */
export interface SubagentAnchor {
  readonly kind: SubagentAnchorKind;
  readonly agentId: ThreadId;
  readonly itemId: ThreadItemId;
}

export interface SubagentTurnAnchors {
  /** The Turn's Items with each delegating call collapsed into its anchor. */
  readonly items: readonly ThreadItem[];
  readonly anchorByItemId: ReadonlyMap<ThreadItemId, SubagentAnchor>;
  /**
   * The Agent each delegating TOOL CALL in this Turn addressed, by the call's
   * own Item id. A completion notification names that call, not the chip that
   * replaced it, so this is what resolves a continuation back to its Agent.
   */
  readonly agentByCallItemId: ReadonlyMap<ThreadItemId, ThreadId>;
  /** Every Agent this Turn's Items reference, spawned or steered. */
  readonly agentIds: readonly ThreadId[];
}

export interface SubagentConversationProjection {
  readonly byAgentId: ReadonlyMap<ThreadId, SubagentRegistryEntry>;
  readonly anchorsByTurnId: ReadonlyMap<TurnId, SubagentTurnAnchors>;
  /**
   * For a Turn the host started to deliver a child's result, the Agent that
   * result came from. This is what the completion divider names, and it is
   * resolved across Turns: the call that spawned or resumed the Agent is
   * usually in a much earlier Turn than the one its result continues.
   */
  readonly continuationAgentByTurnId: ReadonlyMap<TurnId, ThreadId>;
}

export interface SubagentProjectionInput {
  readonly rootThreadId: ThreadId;
  /**
   * Loaded history for the conversation and every Agent under it. A nested
   * Agent's transcript carries anchors of its own, so the projection covers
   * the whole subtree rather than only the conversation's own Turns.
   */
  readonly turnsByThread: ReadonlyMap<ThreadId, readonly Turn[]>;
  readonly executions: ReadonlyMap<ThreadId, SubagentExecutionProjection>;
  readonly threadsById: ReadonlyMap<ThreadId, Thread>;
  readonly latestTurnByThread: ReadonlyMap<ThreadId, Turn>;
}

/**
 * A Turn nobody projected: its own Items, no anchors. Reached when a transcript
 * renders before its conversation's projection has caught up with it, which is
 * a frame, not a state — the Items are still exactly right.
 */
export function emptyTurnAnchors(turn: Turn): SubagentTurnAnchors {
  return { items: turn.items, anchorByItemId: new Map(), agentByCallItemId: new Map(), agentIds: [] };
}

export const EMPTY_SUBAGENT_PROJECTION: SubagentConversationProjection = {
  byAgentId: new Map(),
  anchorsByTurnId: new Map(),
  continuationAgentByTurnId: new Map(),
};

interface ProjectionMemo {
  readonly projection: SubagentConversationProjection;
  readonly anchorsByTurn: ReadonlyMap<Turn, SubagentTurnAnchors>;
}

const memos = new WeakMap<SubagentConversationProjection, ProjectionMemo>();

/**
 * The conversation's Agents, and where each one is anchored in its narrative.
 *
 * Recomputation is identity-preserving by contract. A streaming delta rewrites
 * exactly one Turn object and touches no execution record, so every anchor set
 * and every registry entry is returned by reference and the memoized rows
 * projected from them never re-render. The inputs that legitimately invalidate
 * beyond one Agent are collection-scoped and modelled as such: membership
 * changes, and the display-name collision set, which renumbers same-named
 * siblings when one joins or leaves.
 */
export function projectSubagentConversation(
  input: SubagentProjectionInput,
  previous: SubagentConversationProjection | null = null,
): SubagentConversationProjection {
  const previousMemo = previous ? memos.get(previous) ?? null : null;
  const entries = projectRegistryEntries(input);
  const anchorsByTurn = new Map<Turn, SubagentTurnAnchors>();
  const anchorsByTurnId = new Map<TurnId, SubagentTurnAnchors>();
  const agentByCallItemId = new Map<ThreadItemId, ThreadId>();
  const owners = [input.rootThreadId, ...entries.keys()];
  for (const ownerThreadId of owners) {
    for (const turn of input.turnsByThread.get(ownerThreadId) ?? []) {
      // Turn objects are replaced only when their own content changes, so
      // identity is the exact invalidation signal: an unchanged Turn keeps the
      // anchor set it already had, whatever else moved in the conversation.
      const anchors = previousMemo?.anchorsByTurn.get(turn) ?? projectTurnAnchors(turn);
      anchorsByTurn.set(turn, anchors);
      anchorsByTurnId.set(turn.id, anchors);
      for (const [itemId, agentId] of anchors.agentByCallItemId) {
        agentByCallItemId.set(itemId, agentId);
      }
    }
  }

  const byAgentId = reuseEntryMap(previous?.byAgentId ?? null, entries);
  const continuationAgentByTurnId = reuseIdMap(
    previous?.continuationAgentByTurnId ?? null,
    continuationAgents(owners, input.turnsByThread, agentByCallItemId),
  );
  const anchors = reuseAnchorMap(previous?.anchorsByTurnId ?? null, anchorsByTurnId);
  const projection = previous
    && anchors === previous.anchorsByTurnId
    && byAgentId === previous.byAgentId
    && continuationAgentByTurnId === previous.continuationAgentByTurnId
    ? previous
    : { anchorsByTurnId: anchors, byAgentId, continuationAgentByTurnId };
  memos.set(projection, { projection, anchorsByTurn });
  return projection;
}

/**
 * One delegation, one anchor, at the position where it was decided.
 *
 * A delegated child otherwise reaches the reader twice in two vocabularies:
 * the tool call that delegated it, and the child's own activity row saying the
 * same thing differently. The anchor is what can carry live status, a Stop, and
 * a way in, so it takes the delegating call's canonical slot — the call's slot,
 * so the chip can never precede the reasoning that produced it.
 *
 * Terminal activity Items render nothing at all. The chip re-reads its Agent
 * from the registry for that Agent's whole life, so a settled row is the live
 * row; a second Item announcing the same settlement in a later Turn would be a
 * duplicate of state the chip already shows, in a place the reader never asked
 * about.
 */
function projectTurnAnchors(turn: Turn): SubagentTurnAnchors {
  const itemIds = new Set(turn.items.map((item) => item.id));
  const spawnByClaimedItemId = new Map<ThreadItemId, SubAgentActivityThreadItem>();
  for (const item of turn.items) {
    if (item.type !== 'subAgentActivity' || item.kind !== 'started') continue;
    // Only a spawn-time activity claims a call, and only inside the Turn that
    // holds it: a terminal activity flushed into a later Turn names nothing.
    if (item.spawnItemId !== null && itemIds.has(item.spawnItemId)) {
      spawnByClaimedItemId.set(item.spawnItemId, item);
    }
  }
  const claimed = new Set(spawnByClaimedItemId.values());

  const items: ThreadItem[] = [];
  const anchorByItemId = new Map<ThreadItemId, SubagentAnchor>();
  const agentByCallItemId = new Map<ThreadItemId, ThreadId>();
  const agentIds: ThreadId[] = [];
  const addAnchor = (anchor: SubagentAnchor): void => {
    anchorByItemId.set(anchor.itemId, anchor);
    if (!agentIds.includes(anchor.agentId)) agentIds.push(anchor.agentId);
  };
  const seenSpawns = new Set<ThreadId>();
  for (const item of turn.items) {
    if (item.type === 'subAgentActivity') {
      if (item.kind !== 'started' || claimed.has(item) || seenSpawns.has(item.agentThreadId)) continue;
      // A spawn whose delegating call is not in this Turn still anchors here;
      // the activity Item is the only evidence the delegation happened.
      seenSpawns.add(item.agentThreadId);
      items.push(item);
      addAnchor(spawnAnchor(item));
      continue;
    }
    const spawn = spawnByClaimedItemId.get(item.id);
    if (spawn) {
      seenSpawns.add(spawn.agentThreadId);
      items.push(spawn);
      addAnchor(spawnAnchor(spawn));
      agentByCallItemId.set(item.id, spawn.agentThreadId);
      continue;
    }
    if (item.type === 'collabAgentToolCall' && item.tool === 'agent_message') {
      const agentId = item.receiverThreadIds[0];
      // `main` messages address the conversation, not an Agent, and have no
      // recipient Thread to open.
      if (agentId !== undefined) {
        items.push(item);
        addAnchor({ kind: 'resume', agentId, itemId: item.id });
        agentByCallItemId.set(item.id, agentId);
        continue;
      }
    }
    items.push(item);
  }
  return { items, anchorByItemId, agentByCallItemId, agentIds };
}

function spawnAnchor(item: SubAgentActivityThreadItem): SubagentAnchor {
  return { kind: 'spawn', agentId: item.agentThreadId, itemId: item.id };
}

/**
 * Which Agent's result each host-authored continuation Turn carries.
 *
 * The Turn's trigger names the tool call the notification answers — the spawn
 * for a first generation, the `agent_message` that resumed a later one — so
 * the whole conversation's anchors are the index that resolves it.
 */
function continuationAgents(
  owners: readonly ThreadId[],
  turnsByThread: ReadonlyMap<ThreadId, readonly Turn[]>,
  agentByCallItemId: ReadonlyMap<ThreadItemId, ThreadId>,
): Map<TurnId, ThreadId> {
  const resolved = new Map<TurnId, ThreadId>();
  for (const ownerThreadId of owners) {
    for (const turn of turnsByThread.get(ownerThreadId) ?? []) {
      const trigger = turn.provenance.trigger;
      if (trigger.kind !== 'subagent' || turn.provenance.originThreadId !== ownerThreadId) continue;
      const agentId = agentByCallItemId.get(trigger.parentItemId);
      if (agentId !== undefined) resolved.set(turn.id, agentId);
    }
  }
  return resolved;
}

function projectRegistryEntries(input: SubagentProjectionInput): Map<ThreadId, SubagentRegistryEntry> {
  const members = [
    ...conversationExecutions(input.rootThreadId, input.executions),
    ...recordlessChildren(input),
  ];
  const entries = new Map<ThreadId, SubagentRegistryEntry>();
  for (const execution of members) {
    const thread = input.threadsById.get(execution.agentId) ?? null;
    const latestTurn = input.latestTurnByThread.get(execution.agentId) ?? null;
    const live = liveState(execution, thread, latestTurn);
    const form: SubagentDelegationForm = execution.agentType === 'isolated-skill'
      || thread?.source === 'agent.skill'
      ? 'isolatedSkill'
      : 'agent';
    entries.set(execution.agentId, {
      agentId: execution.agentId,
      parentThreadId: execution.parentThreadId,
      displayName: displayName(execution, thread, form),
      agentType: form === 'isolatedSkill' ? null : execution.agentType || null,
      form,
      runMode: execution.runMode,
      generation: execution.generation,
      status: live.status,
      stoppedByUser: execution.stopProvenance === 'user',
      startedAt: live.startedAt,
      durationMs: live.durationMs,
      settledAt: live.settledAt,
      error: live.error,
      worktree: execution.worktree,
      liveDescendantCount: 0,
    });
  }
  applyLiveDescendantCounts(entries);
  applyDisplayNameOrdinals(entries);
  return entries;
}

/**
 * Delegated children this conversation holds that have no execution record.
 *
 * The record is the authority, and the host publishes it before it publishes a
 * child's start — but a child whose record was retired, or one recovered from
 * an older release, is still a Thread the reader can open. Synthesizing the
 * identity fields from the Thread keeps it readable instead of rendering an
 * anchor that says `Not found` about work the conversation plainly did.
 */
function recordlessChildren(input: SubagentProjectionInput): readonly SubagentExecutionProjection[] {
  const childrenByParent = new Map<ThreadId, Thread[]>();
  for (const thread of input.threadsById.values()) {
    if (thread.parentThreadId === null || input.executions.has(thread.id)) continue;
    const siblings = childrenByParent.get(thread.parentThreadId) ?? [];
    siblings.push(thread);
    childrenByParent.set(thread.parentThreadId, siblings);
  }
  if (childrenByParent.size === 0) return [];
  const known = new Set<ThreadId>([input.rootThreadId, ...input.executions.keys()]);
  const synthesized: SubagentExecutionProjection[] = [];
  const frontier = [...known];
  for (let index = 0; index < frontier.length; index += 1) {
    for (const thread of childrenByParent.get(frontier[index]!) ?? []) {
      if (known.has(thread.id)) continue;
      known.add(thread.id);
      frontier.push(thread.id);
      synthesized.push({
        agentId: thread.id,
        parentThreadId: thread.parentThreadId!,
        description: thread.agentNickname?.trim() || thread.name?.trim() || '',
        agentType: '',
        runMode: 'background',
        generation: 1,
        currentTurnId: input.latestTurnByThread.get(thread.id)?.id ?? thread.id,
        stopProvenance: 'none',
        terminalStatus: null,
        notificationState: 'none',
        worktree: null,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      });
    }
  }
  return synthesized;
}

/**
 * The Agents this conversation delegated, at any depth.
 *
 * Membership walks the delegation edges the records themselves carry rather
 * than the Thread catalog, so a conversation whose child Threads have not been
 * read yet still knows exactly which Agents belong to it.
 */
function conversationExecutions(
  rootThreadId: ThreadId,
  executions: ReadonlyMap<ThreadId, SubagentExecutionProjection>,
): readonly SubagentExecutionProjection[] {
  const byParent = new Map<ThreadId, SubagentExecutionProjection[]>();
  for (const execution of executions.values()) {
    const siblings = byParent.get(execution.parentThreadId) ?? [];
    siblings.push(execution);
    byParent.set(execution.parentThreadId, siblings);
  }
  const members: SubagentExecutionProjection[] = [];
  const frontier: ThreadId[] = [rootThreadId];
  const visited = new Set<ThreadId>(frontier);
  for (let index = 0; index < frontier.length; index += 1) {
    for (const execution of byParent.get(frontier[index]!) ?? []) {
      if (visited.has(execution.agentId)) continue;
      visited.add(execution.agentId);
      members.push(execution);
      frontier.push(execution.agentId);
    }
  }
  return members.sort((left, right) => (
    left.createdAt - right.createdAt || left.agentId.localeCompare(right.agentId)
  ));
}

/**
 * Live truth first, then the most specific settled evidence.
 *
 * The execution record's `currentTurnId` names the generation being described.
 * When the renderer holds that exact Turn it supplies the duration and the
 * typed error; otherwise the durable terminal status still states the outcome,
 * so a conversation reopened days later never has to call a finished Agent
 * `Idle` for want of a Turn it never loaded.
 */
function liveState(
  execution: SubagentExecutionProjection,
  thread: Thread | null,
  latestTurn: Turn | null,
): Pick<SubagentRegistryEntry, 'durationMs' | 'error' | 'settledAt' | 'startedAt' | 'status'> {
  const currentTurn = latestTurn?.id === execution.currentTurnId ? latestTurn : null;
  if (currentTurn?.status === 'inProgress') {
    return {
      durationMs: null,
      error: null,
      settledAt: null,
      startedAt: currentTurn.startedAt,
      status: 'running',
    };
  }
  if (currentTurn) {
    return {
      durationMs: currentTurn.durationMs,
      error: currentTurn.error,
      settledAt: currentTurn.completedAt,
      startedAt: null,
      status: currentTurn.status === 'failed'
        ? 'errored'
        : currentTurn.status === 'interrupted'
          ? 'interrupted'
          : 'completed',
    };
  }
  if (execution.terminalStatus !== null) {
    return {
      durationMs: null,
      error: null,
      settledAt: execution.updatedAt,
      startedAt: null,
      status: execution.terminalStatus === 'completed'
        ? 'completed'
        : execution.terminalStatus === 'failed'
          ? 'errored'
          : 'interrupted',
    };
  }
  if (thread?.status.type === 'active') {
    return { durationMs: null, error: null, settledAt: null, startedAt: null, status: 'running' };
  }
  if (thread?.status.type === 'systemError') {
    return {
      durationMs: null,
      error: thread.status.message
        ? { message: thread.status.message, code: 'runtime_failure' }
        : null,
      settledAt: execution.updatedAt,
      startedAt: null,
      status: 'errored',
    };
  }
  if (execution.stopProvenance !== 'none') {
    return {
      durationMs: null,
      error: null,
      settledAt: execution.updatedAt,
      startedAt: null,
      status: 'interrupted',
    };
  }
  if (!thread) {
    return { durationMs: null, error: null, settledAt: null, startedAt: null, status: 'pendingInit' };
  }
  return {
    durationMs: null,
    error: null,
    settledAt: null,
    startedAt: null,
    status: thread.status.type === 'notLoaded' ? 'pendingInit' : 'idle',
  };
}

/**
 * A parent with live descendants is still working even after its own provider
 * Turn produced text: it must synthesize their results before its own
 * generation is terminal. The count says so without flattening the tree into
 * the strip, which is a list of delegations rather than a process browser.
 */
function applyLiveDescendantCounts(entries: Map<ThreadId, SubagentRegistryEntry>): void {
  const childrenByParent = new Map<ThreadId, ThreadId[]>();
  for (const entry of entries.values()) {
    const siblings = childrenByParent.get(entry.parentThreadId) ?? [];
    siblings.push(entry.agentId);
    childrenByParent.set(entry.parentThreadId, siblings);
  }
  for (const [agentId, entry] of entries) {
    let live = 0;
    const frontier = [...childrenByParent.get(agentId) ?? []];
    const visited = new Set(frontier);
    for (let index = 0; index < frontier.length; index += 1) {
      const descendantId = frontier[index]!;
      const descendant = entries.get(descendantId);
      if (!descendant) continue;
      if (descendant.status === 'running' || descendant.status === 'pendingInit') live += 1;
      for (const nested of childrenByParent.get(descendantId) ?? []) {
        if (visited.has(nested)) continue;
        visited.add(nested);
        frontier.push(nested);
      }
    }
    if (live !== 0) entries.set(agentId, { ...entry, liveDescendantCount: live });
  }
}

/**
 * Two Agents delegated with the same description are two rows reading the same
 * name — and the address that told them apart is exactly what a chip stops
 * rendering. Numbering the repeats in canonical order restores that for the
 * visible name, the title, and the accessible name at once. Unique names are
 * untouched, so the common chip keeps reading as the description alone.
 */
function applyDisplayNameOrdinals(entries: Map<ThreadId, SubagentRegistryEntry>): void {
  const counts = new Map<string, number>();
  for (const entry of entries.values()) {
    counts.set(entry.displayName, (counts.get(entry.displayName) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  for (const [agentId, entry] of entries) {
    if ((counts.get(entry.displayName) ?? 0) < 2) continue;
    const ordinal = (seen.get(entry.displayName) ?? 0) + 1;
    seen.set(entry.displayName, ordinal);
    entries.set(agentId, { ...entry, displayName: `${entry.displayName} (${ordinal})` });
  }
}

/**
 * The model's own description of the delegated task is the name a reader can
 * correlate with what the conversation said it was doing. The Thread's recorded
 * identity is the fallback, and the short address is the last resort — never
 * the first choice, because an opaque ID names nothing.
 */
function displayName(
  execution: SubagentExecutionProjection,
  thread: Thread | null,
  form: SubagentDelegationForm,
): string {
  const described = execution.description.trim();
  if (described) return described;
  const recorded = thread?.agentNickname?.trim() || thread?.name?.trim();
  if (recorded) return recorded;
  if (form === 'isolatedSkill' && thread) {
    const skill = isolatedSkillNameFromTaskName(thread.name?.trim() ?? '');
    if (skill) return skill;
  }
  const role = thread?.agentRole?.trim();
  if (role) return role;
  return shortAgentId(execution.agentId);
}

function shortAgentId(agentId: string): string {
  return agentId.length > 12 ? `${agentId.slice(0, 8)}...${agentId.slice(-4)}` : agentId;
}

export function collaborationResultSnapshot(item: CollabAgentToolCallThreadItem): {
  readonly receiverThreadIds: readonly ThreadId[];
  readonly agentsStates: CollabAgentToolCallThreadItem['agentsStates'];
} {
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

function reuseEntryMap(
  previous: ReadonlyMap<ThreadId, SubagentRegistryEntry> | null,
  next: ReadonlyMap<ThreadId, SubagentRegistryEntry>,
): ReadonlyMap<ThreadId, SubagentRegistryEntry> {
  if (!previous) return next;
  const previousKeys = [...previous.keys()];
  let unchanged = previousKeys.length === next.size;
  const reused = new Map<ThreadId, SubagentRegistryEntry>();
  let index = 0;
  for (const [agentId, entry] of next) {
    const previousEntry = previous.get(agentId);
    const stable = previousEntry && entryEqual(previousEntry, entry) ? previousEntry : entry;
    reused.set(agentId, stable);
    if (previousKeys[index] !== agentId || stable !== previousEntry) unchanged = false;
    index += 1;
  }
  return unchanged ? previous : reused;
}

function entryEqual(left: SubagentRegistryEntry, right: SubagentRegistryEntry): boolean {
  return left.agentId === right.agentId
    && left.parentThreadId === right.parentThreadId
    && left.displayName === right.displayName
    && left.agentType === right.agentType
    && left.form === right.form
    && left.runMode === right.runMode
    && left.generation === right.generation
    && left.status === right.status
    && left.stoppedByUser === right.stoppedByUser
    && left.startedAt === right.startedAt
    && left.durationMs === right.durationMs
    && left.settledAt === right.settledAt
    && left.liveDescendantCount === right.liveDescendantCount
    && left.worktree?.branch === right.worktree?.branch
    && left.worktree?.path === right.worktree?.path
    && turnErrorEqual(left.error, right.error);
}

function turnErrorEqual(left: TurnError | null, right: TurnError | null): boolean {
  return left === right || (
    left !== null
    && right !== null
    && left.message === right.message
    && left.code === right.code
    && left.detail === right.detail
  );
}

function reuseAnchorMap(
  previous: ReadonlyMap<TurnId, SubagentTurnAnchors> | null,
  next: ReadonlyMap<TurnId, SubagentTurnAnchors>,
): ReadonlyMap<TurnId, SubagentTurnAnchors> {
  if (!previous || previous.size !== next.size) return next;
  for (const [turnId, anchors] of next) {
    if (previous.get(turnId) !== anchors) return next;
  }
  return previous;
}

function reuseIdMap(
  previous: ReadonlyMap<TurnId, ThreadId> | null,
  next: ReadonlyMap<TurnId, ThreadId>,
): ReadonlyMap<TurnId, ThreadId> {
  if (!previous || previous.size !== next.size) return next;
  for (const [turnId, agentId] of next) {
    if (previous.get(turnId) !== agentId) return next;
  }
  return previous;
}
