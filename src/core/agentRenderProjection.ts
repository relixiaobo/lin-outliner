import {
  getAgentEventActivePath,
  getAgentEventMessageBranches,
  type AgentCompactionRecord,
  type AgentCompactionTrigger,
  type AgentEventMessageRecord,
  type AgentEventReplayState,
  type AgentPersistedContent,
  type AgentSubagentRunRecord,
} from './agentEventLog';

export type AgentRenderRowKind = 'message' | 'tool_result' | 'compaction';

export type AgentRenderRow =
  | {
      id: string;
      kind: 'message' | 'tool_result';
      messageId: string;
    }
  | {
      id: string;
      kind: 'compaction';
      messageId: string;
      compactionId: string;
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
  compactedThroughMessageId: string;
  trigger: AgentCompactionTrigger;
  createdAt: number;
}

export interface AgentRenderActiveCompaction {
  id: string;
  trigger: AgentCompactionTrigger;
  startedAt: number;
}

export interface AgentRenderEntities {
  messages: Record<string, AgentRenderMessageEntity>;
  subagents: Record<string, AgentRenderSubagentEntity>;
  compactions: Record<string, AgentRenderCompactionEntity>;
}

export interface AgentRenderProjection {
  sessionId: string;
  revision: number;
  sessionTitle: string | null;
  activeRunId: string | null;
  activeCompaction: AgentRenderActiveCompaction | null;
  isStreaming: boolean;
  model: Record<string, unknown>;
  thinkingLevel: string;
  pendingToolCallIds: string[];
  errorMessage: string | null;
  rows: AgentRenderRow[];
  subagentRunIds: string[];
  entities: AgentRenderEntities;
  streaming: AgentStreamingRenderState | null;
}

export interface BuildAgentRenderProjectionOptions {
  revision: number;
  activeRunId?: string | null;
  activeCompaction?: AgentRenderActiveCompaction | null;
  isStreaming?: boolean;
  model?: Record<string, unknown>;
  thinkingLevel?: string;
  pendingToolCallIds?: string[];
  errorMessage?: string | null;
}

export function buildAgentRenderProjection(
  state: AgentEventReplayState,
  options: BuildAgentRenderProjectionOptions,
): AgentRenderProjection {
  if (!state.session) {
    throw new Error('Cannot build agent render projection before session.created');
  }

  const activePath = getAgentEventActivePath(state);
  const entities: AgentRenderEntities = { messages: {}, subagents: {}, compactions: {} };
  const rows: AgentRenderRow[] = [];
  let streaming: AgentStreamingRenderState | null = null;

  for (const message of activePath) {
    const compaction = compactionForMessage(state, message);
    if (compaction) {
      entities.messages[message.id] = toRenderMessageEntity(state, message);
      entities.compactions[compaction.id] = toRenderCompactionEntity(compaction);
      rows.push({
        id: `compaction:${message.id}`,
        kind: 'compaction',
        messageId: message.id,
        compactionId: compaction.id,
      });
      continue;
    }

    const rowId = `${message.role}:${message.id}`;
    rows.push({
      id: rowId,
      kind: message.role === 'toolResult' ? 'tool_result' : 'message',
      messageId: message.id,
    });
    entities.messages[message.id] = toRenderMessageEntity(state, message);

    if (message.role === 'assistant' && message.status === 'streaming') {
      streaming = {
        messageId: message.id,
        rowId,
        text: textFromContent(message.content),
        updatedAt: message.updatedAt,
      };
    }
  }

  const subagentRunIds = Object.values(state.subagents ?? {})
    .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))
    .map((run) => {
      entities.subagents[run.id] = toRenderSubagentEntity(run);
      return run.id;
    });

  return {
    sessionId: state.session.id,
    revision: options.revision,
    sessionTitle: state.session.title,
    activeRunId: options.activeRunId ?? null,
    activeCompaction: options.activeCompaction ?? null,
    isStreaming: options.isStreaming ?? !!streaming,
    model: options.model ?? {},
    thinkingLevel: options.thinkingLevel ?? 'off',
    pendingToolCallIds: options.pendingToolCallIds ?? [],
    errorMessage: options.errorMessage ?? null,
    rows,
    subagentRunIds,
    entities,
    streaming,
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

function toRenderCompactionEntity(record: AgentCompactionRecord): AgentRenderCompactionEntity {
  return {
    id: record.id,
    messageId: record.messageId,
    summary: record.summary,
    compactedThroughMessageId: record.compactedThroughMessageId,
    trigger: record.trigger,
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
