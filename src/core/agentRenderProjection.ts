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
  type AgentSubagentRunRecord,
} from './agentEventLog';
import { agentMentionToken } from './agentChannel';

export type AgentRenderRowKind = 'message' | 'tool_result' | 'compaction' | 'dream' | 'subagent';

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
      // A subagent run surfaced inline in the transcript as a boundary (its final
      // result IS the conversation's record of the run). A main-agent-spawned run
      // sits right after the assistant turn that launched it; a parentless run (a
      // scheduled/Run-now command fire) is placed by start time.
      id: string;
      kind: 'subagent';
      subagentId: string;
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
  apiId?: string;
  providerId?: string;
  modelId?: string;
  stopReason?: string;
  usage?: AgentEventMessageRecord['usage'];
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
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

export interface AgentRenderSubagentEntity {
  id: string;
  name?: string;
  description: string;
  prompt: string;
  subagentType: string;
  contextMode: AgentSubagentRunRecord['contextMode'];
  executingAgentId?: string;
  parentAgentId?: string;
  memoryOwnerAgentId?: string;
  status: AgentSubagentRunRecord['status'];
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  transcriptPayloadId?: string;
  transcriptMessageCount: number;
  parentToolCallId?: string;
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

export interface AgentRenderSubagentTaskEntity {
  id: string;
  kind: 'subagent';
  status: AgentRenderTaskStatus;
  title: string;
  subtitle: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  subagentId: string;
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

export type AgentRenderTaskEntity = AgentRenderSubagentTaskEntity | AgentRenderDreamTaskEntity;

export interface AgentRenderEntities {
  messages: Record<string, AgentRenderMessageEntity>;
  subagents: Record<string, AgentRenderSubagentEntity>;
  compactions: Record<string, AgentRenderCompactionEntity>;
  dreams: Record<string, AgentRenderDreamEntity>;
  tasks: Record<string, AgentRenderTaskEntity>;
}

export interface AgentRenderProjection {
  conversationId: string;
  revision: number;
  conversationTitle: string | null;
  members: AgentRenderMemberView[];
  activeRunId: string | null;
  activeCompaction: AgentRenderActiveCompaction | null;
  activeDream: AgentRenderActiveDream | null;
  isStreaming: boolean;
  model: Record<string, unknown>;
  thinkingLevel: string;
  pendingToolCallIds: string[];
  errorMessage: string | null;
  rows: AgentRenderRow[];
  transcriptRows: AgentRenderRow[];
  taskIds: string[];
  subagentRunIds: string[];
  entities: AgentRenderEntities;
  streaming: AgentStreamingRenderState | null;
}

export interface BuildAgentRenderProjectionOptions {
  revision: number;
  activeRunId?: string | null;
  activeCompaction?: AgentRenderActiveCompaction | null;
  activeDream?: AgentRenderActiveDream | null;
  isStreaming?: boolean;
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
  const entities: AgentRenderEntities = { messages: {}, subagents: {}, compactions: {}, dreams: {}, tasks: {} };
  const rows = buildActiveRows(state, activePath, entities);
  const transcriptRows = buildTranscriptRows(state, entities);
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

  const taskIds: string[] = [];
  const subagentRunIds = Object.values(state.subagents ?? {})
    .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))
    .map((run) => {
      entities.subagents[run.id] = toRenderSubagentEntity(run);
      const task = toRenderSubagentTaskEntity(run);
      entities.tasks[task.id] = task;
      taskIds.push(task.id);
      return run.id;
    });
  for (const task of options.agentTasks ?? []) {
    entities.tasks[task.id] = task;
    if (!taskIds.includes(task.id)) taskIds.push(task.id);
  }

  return {
    conversationId: state.conversation.id,
    revision: options.revision,
    conversationTitle: state.conversation.title,
    members: state.conversation.members.map((principal) => toRenderMemberView(principal, options)),
    activeRunId: options.activeRunId ?? null,
    activeCompaction: options.activeCompaction ?? null,
    activeDream: options.activeDream ?? null,
    isStreaming: options.isStreaming ?? !!streaming,
    model: options.model ?? {},
    thinkingLevel: options.thinkingLevel ?? 'off',
    pendingToolCallIds: options.pendingToolCallIds ?? [],
    errorMessage: options.errorMessage ?? null,
    rows,
    transcriptRows,
    taskIds,
    subagentRunIds,
    entities,
    streaming,
  };
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
    const dream = dreamForMessage(state, entry.message);
    if (dream) {
      appendDreamRow(rows, entities, state, entry.message, dream, entry.archived);
      continue;
    }
    appendMessageRow(rows, entities, state, entry.message, entry.archived);
  }
  return insertSubagentRows(rows, entities, state);
}

function messageHasToolCall(entity: AgentRenderMessageEntity | undefined, toolCallId: string): boolean {
  return entity?.content.some((block) => block.type === 'toolCall' && block.id === toolCallId) ?? false;
}

// Where a subagent boundary row belongs. A parented run anchors to the spawning
// turn: right after the tool_result row for its call (once it completed) or, if
// that hasn't arrived yet, right after the assistant message that issued the call.
// A parentless run (a command fire) is ordered by start time among the messages.
// `-1` means append at the end.
function subagentInsertIndex(
  rows: AgentRenderRow[],
  entities: AgentRenderEntities,
  run: AgentSubagentRunRecord,
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

// Splice each subagent run into the transcript as a boundary row, earliest first
// (the index is recomputed against the growing list each iteration).
function insertSubagentRows(
  rows: AgentRenderRow[],
  entities: AgentRenderEntities,
  state: AgentEventReplayState,
): AgentRenderRow[] {
  const runs = Object.values(state.subagents ?? {})
    .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
  if (runs.length === 0) return rows;
  const result = [...rows];
  for (const run of runs) {
    const row: AgentRenderRow = { id: `subagent:${run.id}`, kind: 'subagent', subagentId: run.id };
    const insertAt = subagentInsertIndex(result, entities, run);
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
    apiId: message.apiId,
    providerId: message.providerId,
    modelId: message.modelId,
    stopReason: message.stopReason,
    usage: message.usage,
    errorMessage: message.errorMessage,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    isError: message.isError,
  };
}

function toRenderSubagentEntity(run: AgentSubagentRunRecord): AgentRenderSubagentEntity {
  return { ...run };
}

function toRenderSubagentTaskEntity(run: AgentSubagentRunRecord): AgentRenderSubagentTaskEntity {
  return {
    id: `subagent:${run.id}`,
    kind: 'subagent',
    status: run.status,
    title: run.description.trim() || run.name?.trim() || run.id,
    subtitle: `${run.contextMode} · ${run.subagentType}`,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    subagentId: run.id,
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
