export interface TextContent {
  type: 'text';
  text: string;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  redacted?: boolean;
}

export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface ToolCall {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface UserMessage {
  role: 'user';
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: 'assistant';
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;
export type AgentConversationMessage = UserMessage | AssistantMessage;

export interface AgentSnapshotState {
  systemPrompt: string;
  model: Record<string, unknown>;
  thinkingLevel: string;
  messages: AgentMessage[];
  streamingMessage: AgentMessage | null;
  isStreaming: boolean;
  pendingToolCallIds: string[];
  errorMessage: string | null;
}

export interface AgentSnapshotEvent {
  type: 'snapshot';
  sessionId: string;
  lastEventType: string | null;
  revision: number;
  state: AgentSnapshotState;
  timestamp: number;
}

export interface AgentReadyEvent {
  type: 'ready';
  sessionId: null;
  timestamp: number;
}

export interface AgentErrorEvent {
  type: 'error';
  sessionId: string;
  error: string;
  timestamp: number;
}

export interface AgentClosedEvent {
  type: 'closed';
  sessionId: string;
  timestamp: number;
}

export interface AgentToolCallEvent {
  type: 'tool_call';
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args?: unknown;
  timestamp: number;
}

export interface AgentToolResultEvent {
  type: 'tool_result';
  sessionId: string;
  toolCallId: string;
  result?: unknown;
  timestamp: number;
}

export interface AgentApprovalRequestEvent {
  type: 'approval_request';
  sessionId: string;
  requestId: string;
  payload?: unknown;
  timestamp: number;
}

export type AgentWorkerEvent =
  | AgentSnapshotEvent
  | AgentReadyEvent
  | AgentErrorEvent
  | AgentClosedEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentApprovalRequestEvent;
