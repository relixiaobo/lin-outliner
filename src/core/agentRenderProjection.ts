import {
  getAgentEventActivePath,
  getAgentEventMessageBranches,
  type AgentEventMessageRecord,
  type AgentEventReplayState,
  type AgentPersistedContent,
  type AgentSubagentRunRecord,
} from './agentEventLog';

export type AgentRenderRowKind = 'message' | 'tool_result';

export interface AgentRenderRow {
  id: string;
  kind: AgentRenderRowKind;
  messageId: string;
}

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

export interface AgentRenderEntities {
  messages: Record<string, AgentRenderMessageEntity>;
  subagents: Record<string, AgentRenderSubagentEntity>;
}

export interface AgentRenderProjection {
  sessionId: string;
  revision: number;
  sessionTitle: string | null;
  activeRunId: string | null;
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
  const entities: AgentRenderEntities = { messages: {}, subagents: {} };
  const rows: AgentRenderRow[] = [];
  let streaming: AgentStreamingRenderState | null = null;

  for (const message of activePath) {
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
