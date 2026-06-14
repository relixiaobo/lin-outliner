import {
  getAgentEventActivePath,
  getAgentEventMessageBranches,
  getAgentEventVisibleTranscript,
  type AgentActor,
  type AgentCompactionRecord,
  type AgentCompactionTrigger,
  type AgentDreamRecord,
  type AgentEventMessageRecord,
  type AgentEventReplayState,
  type AgentPersistedContent,
  type AgentPrincipal,
  type AgentDreamCompletedChanges,
  type AgentChildRunRecord,
  type AgentRunStatus,
} from './agentEventLog';
import {
  agentMentionToken,
  channelAgentMembers,
  deriveAgentPovProjection,
  isMultiAgentConversation,
  type PovFlattenStep,
} from './agentChannel';

export type AgentRenderRowKind = 'message' | 'tool_result' | 'compaction' | 'dream' | 'child-run';

export type AgentRenderRow =
  | {
      id: string;
      kind: 'message' | 'tool_result';
      messageId: string;
      archived?: boolean;
    }
  | {
      id: string;
      kind: 'compaction';
      messageId: string;
      compactionId: string;
      archived?: boolean;
    }
  | {
      id: string;
      kind: 'dream';
      messageId: string;
      dreamId: string;
      archived?: boolean;
    }
  | {
      // A child run surfaced inline in the transcript as a boundary (its final
      // result IS the conversation's record of the run). A main-agent-spawned run
      // sits right after the assistant turn that launched it; a parentless run (a
      // scheduled/Run-now command fire) is placed by start time.
      id: string;
      kind: 'child-run';
      childRunId: string;
      messageId?: string;
      archived?: boolean;
    };

export interface AgentRenderBranchState {
  ids: string[];
  currentIndex: number;
}

export interface AgentRenderMessageEntity {
  id: string;
  role: AgentEventMessageRecord['role'];
  status: AgentEventMessageRecord['status'];
  parentMessageId: string | null;
  content: AgentPersistedContent[];
  createdAt: number;
  updatedAt: number;
  branches: AgentRenderBranchState | null;
  actor: AgentActor;
  addressedTo?: AgentPrincipal[];
  addressedByMessageId?: string | null;
  apiId?: string;
  providerId?: string;
  modelId?: string;
  runId?: string;
  stopReason?: string;
  usage?: AgentEventMessageRecord['usage'];
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** Wall-clock the producing run took (run `updatedAt − startedAt`), for the "Worked for …" process header. */
  runDurationMs?: number;
}

/** A conversation member as the renderer needs it: principal + mention + label. */
export interface AgentRenderMemberView {
  principal: AgentPrincipal;
  /** `@` token for agent members (composer typeahead + badge); empty for the user. */
  mention: string;
  displayName: string;
  /** True for the Channel coordinator (default `addressedTo` when no one is `@`-ed). */
  coordinator?: boolean;
}

export interface AgentStreamingRenderState {
  messageId: string;
  rowId: string;
  text: string;
  updatedAt: number;
}

export interface AgentRenderActiveRun {
  runId: string;
  agentId: string;
  addressedByMessageId: string | null;
  startedAt: number;
}

export interface AgentRenderChildRunEntity {
  id: string;
  name?: string;
  description: string;
  prompt: string;
  agentType: string;
  contextMode: AgentChildRunRecord['contextMode'];
  parentRunId?: string;
  executingAgentId: string;
  parentAgentId: string;
  memoryOwnerAgentId: string;
  status: AgentRenderTaskStatus;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  parentToolCallId?: string;
}

export type AgentRenderActivityState = 'received' | 'thinking' | 'using_tools';

export interface AgentRenderActivityEntry {
  id: string;
  agentId: string;
  runId: string | null;
  messageId: string | null;
  addressedByMessageId: string;
  state: AgentRenderActivityState;
  updatedAt: number;
  /**
   * The running agent's live composing text for this run — retained for the
   * per-run detail view (the "watch a Channel agent compose" live stream,
   * PM-ratified 2026-06-13). It is filtered from the message stream: the
   * transcript shows only the final utterance on completion. Undefined for
   * pending turns and while a run is between tool segments.
   */
  streamingText?: string;
}

export type AgentPovInspectorMessageRole = 'user' | 'assistant' | 'toolResult';

export interface AgentPovInspectorMessagePart {
  preamble?: string;
  text: string;
  sourceMessageId: string;
  sourceRole: AgentEventMessageRecord['role'];
  sourceActor: AgentActor;
}

export interface AgentPovInspectorMessage {
  id: string;
  role: AgentPovInspectorMessageRole;
  sourceMessageIds: string[];
  createdAt: number;
  parts: AgentPovInspectorMessagePart[];
}

export interface AgentPovInspectorView {
  agentId: string;
  addressedByMessageId: string | null;
  messages: AgentPovInspectorMessage[];
  memoryBriefing: string | null;
}

export interface AgentRenderCompactionEntity {
  id: string;
  messageId: string;
  summary: string;
  source: AgentCompactionRecord['source'];
  trigger: AgentCompactionTrigger;
  createdAt: number;
}

export interface AgentRenderActiveCompaction {
  id: string;
  trigger: AgentCompactionTrigger;
  startedAt: number;
}

export interface AgentRenderDreamEntity {
  id: string;
  messageId: string;
  agentId: string;
  runId?: string;
  trigger: AgentDreamRecord['trigger'];
  status: AgentDreamRecord['status'];
  startedAt: number;
  completedAt: number;
  processed?: AgentDreamRecord['processed'];
  changes?: AgentDreamCompletedChanges;
  errorMessage?: string;
  createdAt: number;
}

export interface AgentRenderActiveDream {
  id: string;
  trigger: 'manual';
  startedAt: number;
}

export type AgentRenderTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

/**
 * Project the canonical run-status vocabulary onto the renderer's presentation
 * term: a user-cancelled run reads as `stopped` in the UI (the user pressed
 * stop). The single translation seam between the data vocabulary (`cancelled`)
 * and the renderer (`stopped`) — shared by every task/child-run render entity so
 * components never see `cancelled`.
 */
export function renderTaskStatusFromRunStatus(status: AgentRunStatus): AgentRenderTaskStatus {
  return status === 'cancelled' ? 'stopped' : status;
}

export interface AgentRenderChildRunTaskEntity {
  id: string;
  kind: 'child-run';
  status: AgentRenderTaskStatus;
  title: string;
  subtitle: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  childRunId: string;
}

export interface AgentRenderDreamTaskEntity {
  id: string;
  kind: 'dream';
  status: AgentRenderTaskStatus;
  trigger: 'manual' | 'schedule';
  /** The pool this Dream maintains (run anchor subject), so the panel can label whose Dream. */
  principal: AgentPrincipal;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  runId: string;
  processed?: {
    totalMessageCount: number;
    totalCharCount: number;
    consolidateOnly: boolean;
  };
  changes?: AgentDreamCompletedChanges;
}

export type AgentRenderTaskEntity = AgentRenderChildRunTaskEntity | AgentRenderDreamTaskEntity;

export interface AgentRenderEntities {
  messages: Record<string, AgentRenderMessageEntity>;
  childRuns: Record<string, AgentRenderChildRunEntity>;
  compactions: Record<string, AgentRenderCompactionEntity>;
  dreams: Record<string, AgentRenderDreamEntity>;
  tasks: Record<string, AgentRenderTaskEntity>;
}

export interface AgentRenderProjection {
  conversationId: string;
  revision: number;
  conversationTitle: string | null;
  members: AgentRenderMemberView[];
  activeRuns: AgentRenderActiveRun[];
  activeRunId: string | null;
  /**
   * Per-run Channel activity: one entry per active or pending addressed run.
   * This is the async Channel work surface (the floating overlay + per-run
   * detail view) — never the DM composer's run state.
   */
  channelActivityEntries: AgentRenderActivityEntry[];
  povInspectors: Record<string, AgentPovInspectorView>;
  activeCompaction: AgentRenderActiveCompaction | null;
  activeDream: AgentRenderActiveDream | null;
  /**
   * DM (or single-agent) composer run state: a serial run is in flight, so the
   * composer may show stop/steer. Always false for a multi-agent Channel — its
   * work lives in {@link channelActivityEntries}, not the composer. Replaces the
   * old overloaded `isStreaming` so DM composer state is never derived from
   * Channel runs.
   */
  dmRunActive: boolean;
  /** True while any addressed Channel run is active or pending (Slack-like async work). */
  channelRunsActive: boolean;
  model: Record<string, unknown>;
  thinkingLevel: string;
  pendingToolCallIds: string[];
  errorMessage: string | null;
  rows: AgentRenderRow[];
  transcriptRows: AgentRenderRow[];
  taskIds: string[];
  childRunIds: string[];
  entities: AgentRenderEntities;
  /** The DM streaming tail (the token stream rendered in the transcript). Null for multi-agent Channels. */
  dmStreaming: AgentStreamingRenderState | null;
}

export interface BuildAgentRenderProjectionOptions {
  revision: number;
  activeRuns?: AgentRenderActiveRun[];
  activeRunId?: string | null;
  activeRunAddressedByMessageId?: string | null;
  channelActivityEntries?: readonly AgentRenderActivityEntry[];
  povInspectorMemoryByAgentId?: Record<string, string | null>;
  messageAddressedByMessageIds?: Record<string, string | null | undefined>;
  activeCompaction?: AgentRenderActiveCompaction | null;
  activeDream?: AgentRenderActiveDream | null;
  dmRunActive?: boolean;
  channelRunsActive?: boolean;
  model?: Record<string, unknown>;
  thinkingLevel?: string;
  pendingToolCallIds?: string[];
  errorMessage?: string | null;
  agentTasks?: readonly AgentRenderTaskEntity[];
  /** Display names for agent members (agentId → name); mention token is the fallback. */
  memberDisplayNames?: Record<string, string>;
  /** The Channel coordinator (default = the main agent); flags its member view. */
  coordinatorAgentId?: string;
}

export function buildAgentRenderProjection(
  state: AgentEventReplayState,
  options: BuildAgentRenderProjectionOptions,
): AgentRenderProjection {
  if (!state.conversation) {
    throw new Error('Cannot build agent render projection before conversation.created');
  }

  const activePath = getAgentEventActivePath(state);
  const entities: AgentRenderEntities = { messages: {}, childRuns: {}, compactions: {}, dreams: {}, tasks: {} };
  const multiAgent = isMultiAgentConversation(state.conversation.members);
  // The runs that are LIVE right now (in-memory active runs the runtime passes in),
  // NOT every run whose persisted status is `running`. A run left `running` by a
  // crash/quit is absent here, so its interrupted turn is never mistaken for an
  // in-flight one — see the Channel suppression in buildTranscriptRows.
  const activeRunIds = new Set((options.activeRuns ?? []).map((run) => run.runId));
  const rows = buildActiveRows(state, activePath, entities);
  const transcriptRows = buildTranscriptRows(state, entities, multiAgent, activeRunIds);

  // The streaming tail drives only the DM composer/transcript; a multi-agent
  // Channel nulls dmStreaming, so skip the active-path scan there entirely.
  let streaming: AgentStreamingRenderState | null = null;
  if (!multiAgent) {
    for (const message of activePath) {
      const rowId = `${message.role}:${message.id}`;
      if (message.role === 'assistant' && message.status === 'streaming') {
        streaming = {
          messageId: message.id,
          rowId,
          text: textFromContent(message.content),
          updatedAt: message.updatedAt,
        };
      }
    }
  }

  const taskIds: string[] = [];
  const childRunIds = Object.values(state.childRuns ?? {})
    .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))
    .map((run) => {
      entities.childRuns[run.id] = toRenderChildRunEntity(run);
      const task = toRenderChildRunTaskEntity(run);
      entities.tasks[task.id] = task;
      taskIds.push(task.id);
      return run.id;
    });
  for (const task of options.agentTasks ?? []) {
    entities.tasks[task.id] = task;
    if (!taskIds.includes(task.id)) taskIds.push(task.id);
  }
  applyMessageAddressing(entities, options);
  const pendingToolCallIds = options.pendingToolCallIds ?? [];
  const activeRunId = options.activeRunId ?? options.activeRuns?.[0]?.runId ?? null;

  return {
    conversationId: state.conversation.id,
    revision: options.revision,
    conversationTitle: state.conversation.title,
    members: state.conversation.members.map((principal) => toRenderMemberView(principal, options)),
    activeRuns: options.activeRuns ?? [],
    activeRunId,
    channelActivityEntries: options.channelActivityEntries
      ? options.channelActivityEntries.map((entry) => ({ ...entry }))
      : buildDerivedActivityEntries(state, options, pendingToolCallIds),
    povInspectors: buildPovInspectors(state, options),
    activeCompaction: options.activeCompaction ?? null,
    activeDream: options.activeDream ?? null,
    // DM composer state never derives from Channel runs: a multi-agent Channel's
    // work is surfaced through channelActivityEntries, so dmRunActive stays false
    // there and the streaming tail is suppressed in the transcript.
    dmRunActive: options.dmRunActive ?? (!multiAgent && !!streaming),
    channelRunsActive: options.channelRunsActive ?? false,
    model: options.model ?? {},
    thinkingLevel: options.thinkingLevel ?? 'off',
    pendingToolCallIds,
    errorMessage: options.errorMessage ?? null,
    rows,
    transcriptRows,
    taskIds,
    childRunIds,
    entities,
    // Already null for multi-agent Channels (the scan above is skipped there).
    dmStreaming: streaming,
  };
}

function applyMessageAddressing(
  entities: AgentRenderEntities,
  options: BuildAgentRenderProjectionOptions,
) {
  for (const [messageId, addressedByMessageId] of Object.entries(options.messageAddressedByMessageIds ?? {})) {
    const message = entities.messages[messageId];
    if (message && addressedByMessageId) message.addressedByMessageId = addressedByMessageId;
  }
  if (!options.activeRunId || !options.activeRunAddressedByMessageId) return;
  for (const message of Object.values(entities.messages)) {
    if (message.role === 'assistant' && message.runId === options.activeRunId) {
      message.addressedByMessageId = options.activeRunAddressedByMessageId;
    }
  }
}

// One predicate for "this run has not reached a terminal event", mirrored by the
// sealed-duration gate (`!isRunRunning`). Centralized so the run-lifecycle meaning
// changes in one place.
function isRunRunning(run: { status: AgentRunStatus } | undefined): boolean {
  return run?.status === 'running';
}

function buildDerivedActivityEntries(
  state: AgentEventReplayState,
  options: BuildAgentRenderProjectionOptions,
  pendingToolCallIds: readonly string[],
): AgentRenderActivityEntry[] {
  const activeRunId = options.activeRunId ?? null;
  if (!activeRunId || !options.activeRunAddressedByMessageId) return [];
  const activeRun = state.runs[activeRunId];
  const activeAgentId = activeRun?.agentId;
  if (!activeAgentId || !isRunRunning(activeRun)) return [];

  const addressedByMessageId = options.activeRunAddressedByMessageId;
  const addressingMessage = state.messages[addressedByMessageId];
  const addressedAgents = channelAgentMembers(addressingMessage?.addressedTo ?? []);
  const agentIds = addressedAgents.length > 0
    ? addressedAgents.map((principal) => principal.agentId)
    : [activeAgentId];
  const pendingAgentIds = new Set(agentIds);
  const activeRunMessageId = latestAssistantMessageIdForRun(state, activeRunId);

  if (addressingMessage) {
    for (const message of Object.values(state.messages)) {
      if (message.role !== 'assistant' || !message.runId) continue;
      const run = state.runs[message.runId];
      if (!run?.agentId || !pendingAgentIds.has(run.agentId)) continue;
      if (isRunRunning(run)) continue;
      if (message.createdAt < addressingMessage.createdAt) continue;
      pendingAgentIds.delete(run.agentId);
    }
    for (const run of Object.values(state.runs)) {
      if (!run.agentId || !pendingAgentIds.has(run.agentId)) continue;
      if (run.addressedByMessageId !== addressedByMessageId) continue;
      if (isRunRunning(run)) continue;
      pendingAgentIds.delete(run.agentId);
    }
  }

  if (!pendingAgentIds.has(activeAgentId)) pendingAgentIds.add(activeAgentId);

  return agentIds
    .filter((agentId) => pendingAgentIds.has(agentId))
    .map((agentId) => ({
      id: `${addressedByMessageId}:${agentId}`,
      agentId,
      runId: agentId === activeAgentId ? activeRunId : null,
      messageId: agentId === activeAgentId ? activeRunMessageId : null,
      addressedByMessageId,
      state: agentId === activeAgentId
        ? (pendingToolCallIds.length > 0 ? 'using_tools' : 'thinking')
        : 'received',
      updatedAt: agentId === activeAgentId ? activeRun.updatedAt : addressingMessage?.updatedAt ?? activeRun.startedAt,
    }));
}

function buildPovInspectors(
  state: AgentEventReplayState,
  options: BuildAgentRenderProjectionOptions,
): Record<string, AgentPovInspectorView> {
  const result: Record<string, AgentPovInspectorView> = {};
  const coordinatorAgentId = options.coordinatorAgentId;
  if (!coordinatorAgentId) return result;
  const members = state.conversation?.members ?? [];
  if (!isMultiAgentConversation(members)) return result;
  for (const member of channelAgentMembers(members)) {
    const projection = deriveAgentPovProjection(state, member.agentId, {
      mainAgentId: coordinatorAgentId,
      displayNameByAgentId: options.memberDisplayNames,
    });
    result[member.agentId] = {
      agentId: member.agentId,
      addressedByMessageId: projection.addressedByMessageId,
      messages: inspectorMessagesFromPovSteps(projection.steps),
      memoryBriefing: options.povInspectorMemoryByAgentId?.[member.agentId] ?? null,
    };
  }
  return result;
}

function inspectorMessagesFromPovSteps(steps: readonly PovFlattenStep[]): AgentPovInspectorMessage[] {
  return steps.map((step, index): AgentPovInspectorMessage => {
    if (step.kind === 'verbatim') {
      const text = inspectorTextFromContent(step.record.content);
      return {
        id: `verbatim:${step.record.id}`,
        role: step.record.role,
        sourceMessageIds: [step.record.id],
        createdAt: step.record.createdAt,
        parts: [{
          text,
          sourceMessageId: step.record.id,
          sourceRole: step.record.role,
          sourceActor: step.record.actor,
        }],
      };
    }
    const parts = step.parts.map((part): AgentPovInspectorMessagePart => ({
      preamble: part.preamble ?? undefined,
      text: inspectorTextFromContent(part.record.content),
      sourceMessageId: part.record.id,
      sourceRole: part.record.role,
      sourceActor: part.record.actor,
    }));
    return {
      id: `flattened:${index}:${step.parts.map((part) => part.record.id).join(':')}`,
      role: 'user',
      sourceMessageIds: step.parts.map((part) => part.record.id),
      createdAt: step.parts.at(-1)?.record.createdAt ?? 0,
      parts,
    };
  });
}

function latestAssistantMessageIdForRun(state: AgentEventReplayState, runId: string): string | null {
  let latest: AgentEventMessageRecord | null = null;
  for (const message of Object.values(state.messages)) {
    if (message.role !== 'assistant' || message.runId !== runId) continue;
    if (!latest || message.createdAt > latest.createdAt) latest = message;
  }
  return latest?.id ?? null;
}

function buildActiveRows(
  state: AgentEventReplayState,
  activePath: readonly AgentEventMessageRecord[],
  entities: AgentRenderEntities,
): AgentRenderRow[] {
  const rows: AgentRenderRow[] = [];
  for (const message of activePath) {
    appendActiveRow(state, rows, entities, message);
  }
  return rows;
}

function buildTranscriptRows(
  state: AgentEventReplayState,
  entities: AgentRenderEntities,
  multiAgent: boolean,
  activeRunIds: ReadonlySet<string>,
): AgentRenderRow[] {
  const rows: AgentRenderRow[] = [];
  for (const entry of getAgentEventVisibleTranscript(state)) {
    // Atomic Channel delivery (spec: a running Channel turn is "never a transcript
    // row"): in a multi-agent Channel, a turn whose producing run is LIVE right now
    // is suppressed from the transcript — its progress shows only in
    // channelActivityEntries. The whole turn appears once its run seals (leaves the
    // live set), rendered result-first. Keyed off the live active-run set, NOT
    // persisted `status === running`: a run orphaned `running` by a crash is not
    // live, so its interrupted turn still renders instead of vanishing. A DM streams
    // its active turn live, so this is gated on `multiAgent`.
    if (multiAgent && entry.message.runId && activeRunIds.has(entry.message.runId)) {
      continue;
    }
    const compaction = compactionForMessage(state, entry.message);
    if (compaction) {
      appendCompactionRow(rows, entities, state, entry.message, compaction, entry.archived);
      continue;
    }
    const dream = dreamForMessage(state, entry.message);
    if (dream) {
      appendDreamRow(rows, entities, state, entry.message, dream, entry.archived);
      continue;
    }
    appendMessageRow(rows, entities, state, entry.message, entry.archived);
  }
  return insertChildRunRows(rows, entities, state, multiAgent, activeRunIds);
}

function messageHasToolCall(entity: AgentRenderMessageEntity | undefined, toolCallId: string): boolean {
  return entity?.content.some((block) => block.type === 'toolCall' && block.id === toolCallId) ?? false;
}

// Where a child run boundary row belongs. A parented run anchors to the spawning
// turn: right after the tool_result row for its call (once it completed) or, if
// that hasn't arrived yet, right after the assistant message that issued the call.
// A parentless run (a command fire) is ordered by start time among the messages.
// `-1` means append at the end.
function childRunInsertIndex(
  rows: AgentRenderRow[],
  entities: AgentRenderEntities,
  run: AgentChildRunRecord,
): number {
  if (run.parentToolCallId) {
    const resultIndex = rows.findIndex(
      (row) => row.kind === 'tool_result'
        && entities.messages[row.messageId]?.toolCallId === run.parentToolCallId,
    );
    if (resultIndex >= 0) return resultIndex + 1;
    const callIndex = rows.findIndex(
      (row) => row.kind === 'message'
        && messageHasToolCall(entities.messages[row.messageId], run.parentToolCallId!),
    );
    return callIndex >= 0 ? callIndex + 1 : -1;
  }
  let index = -1;
  for (let position = 0; position < rows.length; position += 1) {
    const messageId = rows[position]!.messageId;
    const message = messageId ? entities.messages[messageId] : undefined;
    if (message && message.createdAt <= run.startedAt) index = position;
  }
  return index < 0 ? -1 : index + 1;
}

// Splice each child run into the transcript as a boundary row, earliest first
// (the index is recomputed against the growing list each iteration).
function insertChildRunRows(
  rows: AgentRenderRow[],
  entities: AgentRenderEntities,
  state: AgentEventReplayState,
  multiAgent: boolean,
  activeRunIds: ReadonlySet<string>,
): AgentRenderRow[] {
  const runs = Object.values(state.childRuns ?? {})
    .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
  if (runs.length === 0) return rows;
  const result = [...rows];
  for (const run of runs) {
    // Mirror the parent turn's suppression: a child run spawned by a Channel turn
    // whose run is still LIVE is held back too, so its boundary row never orphans
    // to the transcript end (its anchor message is suppressed) while the parent is
    // hidden. It reappears, anchored, once the parent turn lands.
    if (multiAgent && run.parentRunId && activeRunIds.has(run.parentRunId)) continue;
    const row: AgentRenderRow = { id: `child-run:${run.id}`, kind: 'child-run', childRunId: run.id };
    const insertAt = childRunInsertIndex(result, entities, run);
    if (insertAt < 0) result.push(row);
    else result.splice(insertAt, 0, row);
  }
  return result;
}

function appendActiveRow(
  state: AgentEventReplayState,
  rows: AgentRenderRow[],
  entities: AgentRenderEntities,
  message: AgentEventMessageRecord,
) {
  const compaction = compactionForMessage(state, message);
  if (compaction) {
    appendCompactionRow(rows, entities, state, message, compaction, false);
    return;
  }
  const dream = dreamForMessage(state, message);
  if (dream) {
    appendDreamRow(rows, entities, state, message, dream, false);
    return;
  }
  appendMessageRow(rows, entities, state, message, false);
}

function appendMessageRow(
  rows: AgentRenderRow[],
  entities: AgentRenderEntities,
  state: AgentEventReplayState,
  message: AgentEventMessageRecord,
  archived: boolean,
) {
  const prefix = archived ? 'archived:' : '';
  rows.push({
    id: `${prefix}${message.role}:${message.id}`,
    kind: message.role === 'toolResult' ? 'tool_result' : 'message',
    messageId: message.id,
    archived: archived || undefined,
  });
  entities.messages[message.id] = toRenderMessageEntity(state, message);
}

function appendCompactionRow(
  rows: AgentRenderRow[],
  entities: AgentRenderEntities,
  state: AgentEventReplayState,
  message: AgentEventMessageRecord,
  compaction: AgentCompactionRecord,
  archived: boolean,
) {
  const prefix = archived ? 'archived:' : '';
  rows.push({
    id: `${prefix}compaction:${message.id}`,
    kind: 'compaction',
    messageId: message.id,
    compactionId: compaction.id,
    archived: archived || undefined,
  });
  entities.messages[message.id] = toRenderMessageEntity(state, message);
  entities.compactions[compaction.id] = toRenderCompactionEntity(compaction);
}

function appendDreamRow(
  rows: AgentRenderRow[],
  entities: AgentRenderEntities,
  state: AgentEventReplayState,
  message: AgentEventMessageRecord,
  dream: AgentDreamRecord,
  archived: boolean,
) {
  const prefix = archived ? 'archived:' : '';
  rows.push({
    id: `${prefix}dream:${message.id}`,
    kind: 'dream',
    messageId: message.id,
    dreamId: dream.id,
    archived: archived || undefined,
  });
  entities.messages[message.id] = toRenderMessageEntity(state, message);
  entities.dreams[dream.id] = toRenderDreamEntity(dream);
}

function toRenderMemberView(
  principal: AgentPrincipal,
  options: BuildAgentRenderProjectionOptions,
): AgentRenderMemberView {
  if (principal.type === 'user') {
    return { principal, mention: '', displayName: 'You' };
  }
  const mention = agentMentionToken(principal.agentId);
  return {
    principal,
    mention,
    displayName: options.memberDisplayNames?.[principal.agentId] ?? mention,
    coordinator: principal.agentId === options.coordinatorAgentId || undefined,
  };
}

function toRenderMessageEntity(
  state: AgentEventReplayState,
  message: AgentEventMessageRecord,
): AgentRenderMessageEntity {
  const run = message.runId ? state.runs[message.runId] : undefined;
  return {
    id: message.id,
    role: message.role,
    status: message.status,
    parentMessageId: message.parentMessageId,
    content: cloneContent(message.content),
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    branches: getAgentEventMessageBranches(state, message.id),
    actor: message.actor,
    addressedTo: message.addressedTo?.slice(),
    addressedByMessageId: message.addressedByMessageId ?? null,
    apiId: message.apiId,
    providerId: message.providerId,
    modelId: message.modelId,
    runId: message.runId,
    stopReason: message.stopReason,
    usage: message.usage,
    errorMessage: message.errorMessage,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    isError: message.isError,
    // Only a SEALED run has a meaningful wall-clock: `run.updatedAt` is bumped
    // at start and at the terminal event, never in between, so a still-`running`
    // run (live, or a top-level run left `running` after a crash/quit) has
    // `updatedAt === startedAt` → a misleading "<1s". Leave it undefined there so
    // the header falls back to its descriptive summary instead of faking 0ms.
    runDurationMs:
      run && !isRunRunning(run) ? Math.max(0, run.updatedAt - run.startedAt) : undefined,
  };
}

// Built explicitly (not `{ ...run }`) so the render entity exposes ONLY its
// declared fields: the durable record's `memoryOriginWorkspace`/`unattended` are
// runtime/persistence metadata the renderer never reads and must not leak across
// IPC. `status` is projected to the renderer's presentation vocabulary here.
function toRenderChildRunEntity(run: AgentChildRunRecord): AgentRenderChildRunEntity {
  return {
    id: run.id,
    name: run.name,
    description: run.description,
    prompt: run.prompt,
    agentType: run.agentType,
    contextMode: run.contextMode,
    parentRunId: run.parentRunId,
    executingAgentId: run.executingAgentId,
    parentAgentId: run.parentAgentId,
    memoryOwnerAgentId: run.memoryOwnerAgentId,
    status: renderTaskStatusFromRunStatus(run.status),
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    result: run.result,
    error: run.error,
    parentToolCallId: run.parentToolCallId,
  };
}

function toRenderChildRunTaskEntity(run: AgentChildRunRecord): AgentRenderChildRunTaskEntity {
  return {
    id: `child-run:${run.id}`,
    kind: 'child-run',
    status: renderTaskStatusFromRunStatus(run.status),
    title: run.description.trim() || run.name?.trim() || run.id,
    subtitle: `${run.contextMode} · ${run.agentType}`,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    childRunId: run.id,
  };
}

function toRenderCompactionEntity(record: AgentCompactionRecord): AgentRenderCompactionEntity {
  return {
    id: record.id,
    messageId: record.messageId,
    summary: record.summary,
    source: record.source,
    trigger: record.trigger,
    createdAt: record.createdAt,
  };
}

function toRenderDreamEntity(record: AgentDreamRecord): AgentRenderDreamEntity {
  return {
    id: record.id,
    messageId: record.messageId,
    agentId: record.agentId,
    runId: record.runId,
    trigger: record.trigger,
    status: record.status,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    processed: record.processed,
    changes: record.changes,
    errorMessage: record.errorMessage,
    createdAt: record.createdAt,
  };
}

function compactionForMessage(
  state: AgentEventReplayState,
  message: AgentEventMessageRecord,
): AgentCompactionRecord | null {
  if (message.role !== 'user') return null;
  return state.compactionsByMessageId[message.id] ?? null;
}

function dreamForMessage(
  state: AgentEventReplayState,
  message: AgentEventMessageRecord,
): AgentDreamRecord | null {
  if (message.role !== 'user') return null;
  return state.dreamsByMessageId[message.id] ?? null;
}

function textFromContent(content: AgentPersistedContent[]): string {
  return content
    .filter((part): part is Extract<AgentPersistedContent, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

/**
 * Inspector-only rendering of assembled content: unlike {@link textFromContent}
 * (which feeds the streaming text preview and stays text-only), the read-only POV
 * inspector surfaces every part so "what X sees" is faithful — thinking, tool
 * calls, images, and payloads become labeled placeholders.
 */
function inspectorTextFromContent(content: AgentPersistedContent[]): string {
  return content.map((part) => {
    if (part.type === 'text') return part.text;
    if (part.type === 'thinking') return part.redacted ? '[redacted thinking]' : `[thinking] ${part.thinking}`;
    if (part.type === 'toolCall') return `[tool call: ${part.name}]`;
    if (part.type === 'image') return part.alt || part.imageRef.summary || `[image: ${part.imageRef.id}]`;
    return part.label || part.payload.summary || `[payload: ${part.payload.id}]`;
  }).join('\n');
}

function cloneContent(content: AgentPersistedContent[]): AgentPersistedContent[] {
  return content.map((part) => {
    if (part.type === 'text') return { ...part };
    if (part.type === 'thinking') return { ...part };
    if (part.type === 'toolCall') return { ...part, arguments: { ...part.arguments } };
    if (part.type === 'image') {
      return {
        ...part,
        imageRef: {
          ...part.imageRef,
          display: part.imageRef.display ? { ...part.imageRef.display } : undefined,
        },
      };
    }
    return {
      ...part,
      payload: {
        ...part.payload,
        display: part.payload.display ? { ...part.payload.display } : undefined,
      },
    };
  });
}
