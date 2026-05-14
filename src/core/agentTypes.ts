export const LIN_AGENT_EVENT_CHANNEL = 'lin-agent-event';

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

export interface AgentAttachmentInputBase {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface AgentImageAttachmentInput extends AgentAttachmentInputBase {
  kind: 'image';
  dataBase64: string;
}

export interface AgentTextAttachmentInput extends AgentAttachmentInputBase {
  kind: 'text';
  text: string;
  truncated?: boolean;
}

export type AgentMessageAttachmentInput = AgentImageAttachmentInput | AgentTextAttachmentInput;

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

export type AgentDebugSnapshotSource = 'provider_payload' | 'runtime_state';
export type AgentDebugTurnStatus = 'running' | 'completed' | 'error' | 'aborted' | 'interrupted';

export interface AgentDebugWirePayload {
  json: string;
  bytes: number;
  hash: string;
}

export type AgentDebugMessagePart =
  | { kind: 'text'; body: string; isReminder?: boolean }
  | { kind: 'thinking'; body: string }
  | { kind: 'toolCall'; name: string; toolUseId: string; body: string }
  | { kind: 'toolResult'; toolUseId: string; body: string; isError: boolean }
  | { kind: 'image'; body: string }
  | { kind: 'json'; body: string };

export interface AgentDebugMessageRow {
  id: string;
  role: string;
  summary: string;
  json: string;
  bytes: number;
  parts: AgentDebugMessagePart[];
}

export interface AgentDebugToolEntry {
  name: string;
  description: string;
  schema: string;
  bytes: number;
}

export interface AgentDebugReminderSection {
  body: string;
  bytes: number;
}

export interface AgentDebugUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
  costInputUsd: number;
  costOutputUsd: number;
  costCacheReadUsd: number;
  costCacheWriteUsd: number;
}

export interface AgentDebugTotals extends AgentDebugUsage {
  queries: number;
  rounds: number;
}

export interface AgentDebugTokenEstimate {
  systemPrompt: number;
  tools: number;
  messages: number;
  total: number;
  contextWindow: number | null;
  usagePercent: number | null;
}

export interface AgentDebugSnapshot {
  id: string;
  source: AgentDebugSnapshotSource;
  sessionId: string;
  sessionTitle: string | null;
  turnIndex: number;
  queryIndex: number;
  capturedAt: number;
  modelId: string;
  provider: string;
  status: AgentDebugTurnStatus;
  wire: AgentDebugWirePayload;
  systemPrompt: string;
  systemPromptBytes: number;
  systemPromptHash: string;
  reminders: AgentDebugReminderSection[];
  remindersBytes: number;
  remindersHash: string;
  tools: AgentDebugToolEntry[];
  toolsBytes: number;
  toolsHash: string;
  messages: AgentDebugMessageRow[];
  messageCount: number;
  messagesBytes: number;
  tokenEstimate: AgentDebugTokenEstimate;
  usage: AgentDebugUsage | null;
  responseParts: AgentDebugMessagePart[];
  errorMessage: string | null;
}

export interface AgentMessageBranchState {
  ids: string[];
  currentIndex: number;
}

export interface AgentConversationSnapshotEntry {
  nodeId: string;
  message: AgentConversationMessage;
  branches: AgentMessageBranchState | null;
}

export interface AgentSnapshotState {
  sessionTitle: string | null;
  systemPrompt: string;
  model: Record<string, unknown>;
  thinkingLevel: string;
  messages: AgentMessage[];
  conversation: AgentConversationSnapshotEntry[];
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

export type AgentRuntimeEvent =
  | AgentSnapshotEvent
  | AgentReadyEvent
  | AgentErrorEvent
  | AgentClosedEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentApprovalRequestEvent;
