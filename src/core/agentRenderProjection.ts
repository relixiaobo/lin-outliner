import {
  getAgentEventActivePath,
  getAgentEventMessageBranches,
  getAgentEventVisibleTranscript,
  type AgentActor,
  type AgentCompactionRecord,
  type AgentCompactionTrigger,
  type AgentContextClearRecord,
  type AgentDreamRecord,
  type AgentEventMessageRecord,
  type AgentEventReplayState,
  type AgentPersistedContent,
  type AgentPrincipal,
  type AgentDreamCompletedChanges,
  type AgentObjectiveStatus,
  type AgentRunAnchor,
  type AgentRunContextPolicy,
  type AgentRunMeta,
  type AgentRunObjectiveRole,
  type AgentRunProfileId,
  type AgentRunStatus,
} from './agentEventLog';
import {
  DEFAULT_DREAM_CHANNEL_ID,
  agentMentionToken,
} from './agentChannel';

export type AgentRenderRowKind = 'message' | 'tool_result' | 'compaction' | 'context-clear' | 'dream';

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
      kind: 'context-clear';
      messageId: string;
      contextClearId: string;
      archived?: boolean;
    }
  | {
      id: string;
      kind: 'dream';
      messageId: string;
      dreamId: string;
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
  sourceSeq?: number;
  sourceSeqs?: number[];
  branches: AgentRenderBranchState | null;
  actor: AgentActor;
  apiId?: string;
  providerId?: string;
  modelId?: string;
  runId?: string;
  stopReason?: string;
  usage?: AgentEventMessageRecord['usage'];
  /** Aggregated usage for the producing run, if the run has settled. */
  runUsage?: AgentEventMessageRecord['usage'];
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** Wall-clock the producing run took (run `updatedAt − startedAt`), for the "Worked for …" process header. */
  runDurationMs?: number;
  /**
   * Producing run's `startedAt`, exposed while the run still has `running` status
   * so the live header can tick a "Working for {t}" elapsed clock. Mutually
   * exclusive with `runDurationMs` (a sealed run has the duration; a running run
   * has the start). The projection can't tell a genuinely-live run from one left
   * `running` after a crash, so the renderer gates the ticker on `turnActive` —
   * a crashed run is never `turnActive`, so its stale start never renders.
   */
  runStartedAtMs?: number;
  /**
   * Authoritative "this turn was interrupted" verdict, derived from the
   * producing run's REAL terminal status — never from whether the visible
   * blocks end on answer prose. A cleanly `completed` run is never interrupted
   * even when it produced no trailing text (it folds to "Worked for …"); only a
   * `failed` / `cancelled` run, or a run left `running` by a crash (orphaned —
   * absent from the live active set), is. The renderer must consume this rather
   * than re-deriving interruption from block structure.
   */
  turnInterrupted?: boolean;
}

/** A conversation member as the renderer needs it: principal + mention + label. */
export interface AgentRenderMemberView {
  principal: AgentPrincipal;
  /** `@` token for agent members (composer typeahead + badge); empty for the user. */
  mention: string;
  displayName: string;
  /** True for the Channel coordinator (default when no one is `@`-ed). */
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
  startedAt: number;
}

export interface AgentRenderRunEntity {
  id: string;
  agentId: AgentRunMeta['agentId'];
  anchor: AgentRunAnchor;
  conversationId?: string;
  title: string;
  parentRunId?: string;
  parentToolCallId?: string;
  runProfile: AgentRunProfileId;
  runProfileLabel: string;
  status: AgentRenderRunStatus;
  objectiveStatus?: AgentObjectiveStatus;
  objectiveRole?: AgentRunObjectiveRole;
  context: AgentRunContextPolicy;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}

export type AgentRenderActivityState = 'received' | 'thinking' | 'using_tools';
export type AgentRenderLiveContent = Extract<AgentPersistedContent, { type: 'text' | 'thinking' | 'toolCall' }>;

export interface AgentRenderCompactionEntity {
  id: string;
  messageId: string;
  summary: string;
  source: AgentCompactionRecord['source'];
  trigger: AgentCompactionTrigger;
  createdAt: number;
}

export interface AgentRenderContextClearEntity {
  id: string;
  messageId: string;
  source: AgentContextClearRecord['source'];
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
  window?: AgentDreamRecord['window'];
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

export type AgentRenderRunStatus = 'running' | 'completed' | 'failed' | 'stopped';

/**
 * Project the canonical run-status vocabulary onto the renderer's presentation
 * term: a user-cancelled run reads as `stopped` in the UI (the user pressed
 * stop). The single translation seam between the data vocabulary (`cancelled`)
 * and the renderer (`stopped`) — shared by every run render entity so
 * components never see `cancelled`.
 */
export function renderRunStatusFromRunStatus(status: AgentRunStatus): AgentRenderRunStatus {
  return status === 'cancelled' ? 'stopped' : status;
}

export interface AgentRenderDreamRunEntity {
  id: string;
  kind: 'dream';
  status: AgentRenderRunStatus;
  trigger: 'manual' | 'schedule';
  window?: AgentDreamRecord['window'];
  /** The principal model this Dream maintains (run anchor subject), so the panel can label whose Dream. */
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

/**
 * A cheap, read-only pre-check for the manual "Dream now" control: how much new
 * evidence exists in the default manual Dream window, and whether it clears the
 * same volume bar the scheduled path uses. Computed without running the model, so
 * the UI can advise "probably nothing new to consolidate" and offer a forced run.
 */
export interface AgentDreamReadiness {
  /** The default manual Dream window the launcher should prefill. */
  window?: AgentDreamRecord['window'];
  /** Latest clean completed Dream window end, derived from the Dream channel. */
  lastDreamedThrough?: string | null;
  /** New evidence messages in the default Dream window, across member conversations. */
  newMessageCount: number;
  /** New evidence characters in the default Dream window. */
  newCharCount: number;
  /** The volume bar the scheduled Dream uses to decide a run is worthwhile. */
  thresholdChars: number;
  /** `newCharCount < thresholdChars` — a manual run is likely a no-op. */
  belowThreshold: boolean;
}

export interface AgentRenderEntities {
  messages: Record<string, AgentRenderMessageEntity>;
  runs: Record<string, AgentRenderRunEntity>;
  compactions: Record<string, AgentRenderCompactionEntity>;
  contextClears: Record<string, AgentRenderContextClearEntity>;
  dreams: Record<string, AgentRenderDreamEntity>;
}

export interface AgentRenderProjection {
  conversationId: string;
  revision: number;
  conversationTitle: string | null;
  members: AgentRenderMemberView[];
  activeRuns: AgentRenderActiveRun[];
  activeRunId: string | null;
  activeCompaction: AgentRenderActiveCompaction | null;
  activeDream: AgentRenderActiveDream | null;
  /**
   * Composer run state: a serial run is in flight, so the composer may show
   * stop/steer. Drives the composer's stop/steer affordance and the streaming
   * turn placeholder.
   */
  runActive: boolean;
  model: Record<string, unknown>;
  thinkingLevel: string;
  pendingToolCallIds: string[];
  errorMessage: string | null;
  rows: AgentRenderRow[];
  transcriptRows: AgentRenderRow[];
  runIds: string[];
  entities: AgentRenderEntities;
  /** The streaming tail (the token stream rendered in the transcript). */
  streaming: AgentStreamingRenderState | null;
}

export interface AgentRenderProjectionPatch {
  baseRevision: number;
  revision: number;
  activeRuns?: AgentRenderActiveRun[];
  activeRunId?: string | null;
  runActive?: boolean;
  pendingToolCallIds?: string[];
  entities?: Partial<{
    messages: Record<string, AgentRenderMessageEntity>;
    runs: Record<string, AgentRenderRunEntity>;
    compactions: Record<string, AgentRenderCompactionEntity>;
    contextClears: Record<string, AgentRenderContextClearEntity>;
    dreams: Record<string, AgentRenderDreamEntity>;
  }>;
  streaming?: AgentStreamingRenderState | null;
}

export function applyAgentRenderProjectionPatch(
  projection: AgentRenderProjection,
  patch: AgentRenderProjectionPatch,
): AgentRenderProjection | null {
  if (projection.revision !== patch.baseRevision) return null;
  if (!patchOnlyReplacesExistingEntities(projection, patch)) return null;
  const entities = patch.entities
    ? {
        messages: patch.entities.messages
          ? { ...projection.entities.messages, ...patch.entities.messages }
          : projection.entities.messages,
        runs: patch.entities.runs
          ? { ...projection.entities.runs, ...patch.entities.runs }
          : projection.entities.runs,
        compactions: patch.entities.compactions
          ? { ...projection.entities.compactions, ...patch.entities.compactions }
          : projection.entities.compactions,
        contextClears: patch.entities.contextClears
          ? { ...projection.entities.contextClears, ...patch.entities.contextClears }
          : projection.entities.contextClears,
        dreams: patch.entities.dreams
          ? { ...projection.entities.dreams, ...patch.entities.dreams }
          : projection.entities.dreams,
      }
    : projection.entities;
  return {
    ...projection,
    revision: patch.revision,
    ...(patch.activeRuns !== undefined ? { activeRuns: patch.activeRuns } : {}),
    ...(patch.activeRunId !== undefined ? { activeRunId: patch.activeRunId } : {}),
    ...(patch.runActive !== undefined ? { runActive: patch.runActive } : {}),
    ...(patch.pendingToolCallIds !== undefined ? { pendingToolCallIds: patch.pendingToolCallIds } : {}),
    ...(patch.streaming !== undefined ? { streaming: patch.streaming } : {}),
    entities,
  };
}

function patchOnlyReplacesExistingEntities(
  projection: AgentRenderProjection,
  patch: AgentRenderProjectionPatch,
): boolean {
  return Object.keys(patch.entities?.messages ?? {}).every((id) => projection.entities.messages[id])
    && Object.keys(patch.entities?.runs ?? {}).every((id) => projection.entities.runs[id])
    && Object.keys(patch.entities?.compactions ?? {}).every((id) => projection.entities.compactions[id])
    && Object.keys(patch.entities?.contextClears ?? {}).every((id) => projection.entities.contextClears[id])
    && Object.keys(patch.entities?.dreams ?? {}).every((id) => projection.entities.dreams[id]);
}

export interface BuildAgentRenderProjectionOptions {
  revision: number;
  activeRuns?: AgentRenderActiveRun[];
  activeRunId?: string | null;
  activeCompaction?: AgentRenderActiveCompaction | null;
  activeDream?: AgentRenderActiveDream | null;
  runActive?: boolean;
  model?: Record<string, unknown>;
  thinkingLevel?: string;
  pendingToolCallIds?: string[];
  errorMessage?: string | null;
  /** Display names for agent members (agentId → name); mention token is the fallback. */
  memberDisplayNames?: Record<string, string>;
  /** The Channel coordinator (default = the main agent); flags its member view. */
  coordinatorAgentId?: string;
  /** Conversation-anchored Run metadata used by the renderer's Run/sub-run UI projection. */
  runs?: readonly AgentRunMeta[];
  /** Pre-resolved profile labels (kept out of core so the registry stays in main). */
  runProfileLabels?: Partial<Record<AgentRunProfileId, string>>;
  /** Optional compact titles keyed by run id. */
  runTitles?: Record<string, string>;
}

export function buildAgentRenderProjection(
  state: AgentEventReplayState,
  options: BuildAgentRenderProjectionOptions,
): AgentRenderProjection {
  if (!state.conversation) {
    throw new Error('Cannot build agent render projection before conversation.created');
  }

  const activePath = getAgentEventActivePath(state);
  const entities: AgentRenderEntities = { messages: {}, runs: {}, compactions: {}, contextClears: {}, dreams: {} };
  // The runs that are LIVE right now (in-memory active runs the runtime passes in),
  // NOT every run whose persisted status is `running`. A run left `running` by a
  // crash/quit is absent here, so its interrupted turn is never mistaken for an
  // in-flight one.
  const activeRunIds = new Set((options.activeRuns ?? []).map((run) => run.runId));
  const rows = buildActiveRows(state, activePath, entities);
  const transcriptRows = buildTranscriptRows(state, entities);

  // Stamp the authoritative interrupted verdict on every assistant message from
  // the producing run's real status. This is the single fix for the recurring
  // Channel mislabel: the renderer used to infer "interrupted" from "the turn
  // ended without trailing prose", which — because a Channel turn is always
  // `turnPhase: idle` (so the row's `turnEnded` is always true) — fired on EVERY
  // result-less turn regardless of whether it actually failed. A `completed`
  // run that simply ended on a tool/thought is NOT interrupted; only a `failed`
  // / `cancelled` run, or a crash-orphaned `running` run (not in the live set),
  // is. A live in-flight run is still working, never interrupted.
  for (const message of Object.values(entities.messages)) {
    if (message.role !== 'assistant' || !message.runId) continue;
    const run = state.runs[message.runId];
    const interrupted = run
      ? run.status === 'failed'
        || run.status === 'cancelled'
        || (run.status === 'running' && !activeRunIds.has(message.runId))
      : message.status === 'failed';
    if (interrupted) message.turnInterrupted = true;
  }

  // The streaming tail drives the composer/transcript: the in-flight assistant
  // turn streams its token text live in the transcript.
  let streaming: AgentStreamingRenderState | null = null;
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

  const runIds = [...options.runs ?? []]
    .filter((run) => run.anchor.type === 'conversation' && run.anchor.conversationId === state.conversation!.id)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map((run) => {
      entities.runs[run.id] = toRenderRunEntity(run, options);
      return run.id;
    });
  const pendingToolCallIds = options.pendingToolCallIds ?? [];
  const activeRunId = options.activeRunId ?? options.activeRuns?.[0]?.runId ?? null;

  return {
    conversationId: state.conversation.id,
    revision: options.revision,
    conversationTitle: state.conversation.title,
    members: state.conversation.members.map((principal) => toRenderMemberView(principal, options)),
    activeRuns: options.activeRuns ?? [],
    activeRunId,
    activeCompaction: options.activeCompaction ?? null,
    activeDream: options.activeDream ?? null,
    runActive: options.runActive ?? !!streaming,
    model: options.model ?? {},
    thinkingLevel: options.thinkingLevel ?? 'off',
    pendingToolCallIds,
    errorMessage: options.errorMessage ?? null,
    rows,
    transcriptRows,
    runIds,
    entities,
    streaming,
  };
}

// One predicate for "this run has not reached a terminal event", mirrored by the
// sealed-duration gate (`!isRunRunning`). Centralized so the run-lifecycle meaning
// changes in one place.
function isRunRunning(run: { status: AgentRunStatus } | undefined): boolean {
  return run?.status === 'running';
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
): AgentRenderRow[] {
  const rows: AgentRenderRow[] = [];
  for (const entry of getAgentEventVisibleTranscript(state)) {
    const compaction = compactionForMessage(state, entry.message);
    if (compaction) {
      appendCompactionRow(rows, entities, state, entry.message, compaction, entry.archived);
      continue;
    }
    const contextClear = contextClearForMessage(state, entry.message);
    if (contextClear) {
      appendContextClearRow(rows, entities, state, entry.message, contextClear, entry.archived);
      continue;
    }
    const dream = dreamForMessage(state, entry.message);
    if (dream && state.conversation?.id !== DEFAULT_DREAM_CHANNEL_ID) {
      appendDreamRow(rows, entities, state, entry.message, dream, entry.archived);
      continue;
    }
    appendMessageRow(rows, entities, state, entry.message, entry.archived);
  }
  return rows;
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
  const contextClear = contextClearForMessage(state, message);
  if (contextClear) {
    appendContextClearRow(rows, entities, state, message, contextClear, false);
    return;
  }
  const dream = dreamForMessage(state, message);
  if (dream && state.conversation?.id !== DEFAULT_DREAM_CHANNEL_ID) {
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

function appendContextClearRow(
  rows: AgentRenderRow[],
  entities: AgentRenderEntities,
  state: AgentEventReplayState,
  message: AgentEventMessageRecord,
  contextClear: AgentContextClearRecord,
  archived: boolean,
) {
  const prefix = archived ? 'archived:' : '';
  rows.push({
    id: `${prefix}context-clear:${message.id}`,
    kind: 'context-clear',
    messageId: message.id,
    contextClearId: contextClear.id,
    archived: archived || undefined,
  });
  entities.messages[message.id] = toRenderMessageEntity(state, message);
  entities.contextClears[contextClear.id] = toRenderContextClearEntity(contextClear);
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
    sourceSeq: message.sourceSeq,
    sourceSeqs: message.sourceSeqs?.slice(),
    branches: getAgentEventMessageBranches(state, message.id),
    actor: message.actor,
    apiId: message.apiId,
    providerId: message.providerId,
    modelId: message.modelId,
    runId: message.runId,
    stopReason: message.stopReason,
    usage: message.usage,
    runUsage: run?.usage,
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
    runStartedAtMs: run && isRunRunning(run) ? run.startedAt : undefined,
  };
}

function fallbackRunTitle(run: AgentRunMeta): string {
  const objective = run.objective?.text.trim();
  return objective || run.id;
}

function fallbackRunProfileLabel(profile: AgentRunProfileId): string {
  return profile
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ') || profile;
}

function toRenderRunEntity(run: AgentRunMeta, options: BuildAgentRenderProjectionOptions): AgentRenderRunEntity {
  return {
    id: run.id,
    agentId: run.agentId,
    anchor: run.anchor,
    conversationId: run.anchor.type === 'conversation' ? run.anchor.conversationId : undefined,
    title: options.runTitles?.[run.id] ?? fallbackRunTitle(run),
    parentRunId: run.parentRunId,
    parentToolCallId: run.parentToolCallId,
    runProfile: run.runProfile,
    runProfileLabel: options.runProfileLabels?.[run.runProfile] ?? fallbackRunProfileLabel(run.runProfile),
    status: renderRunStatusFromRunStatus(run.execution.status),
    objectiveStatus: run.objective?.status,
    objectiveRole: run.objective?.role,
    context: run.context,
    startedAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.execution.completedAt,
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

function toRenderContextClearEntity(record: AgentContextClearRecord): AgentRenderContextClearEntity {
  return {
    id: record.id,
    messageId: record.messageId,
    source: record.source,
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
    window: record.window,
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

function contextClearForMessage(
  state: AgentEventReplayState,
  message: AgentEventMessageRecord,
): AgentContextClearRecord | null {
  if (message.role !== 'user') return null;
  return state.contextClearsByMessageId[message.id] ?? null;
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
