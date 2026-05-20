import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from '@earendil-works/pi-ai';
import type { AgentRenderProjection } from './agentRenderProjection';
import type { AgentPayloadRef } from './agentEventLog';
import type { NodeId, NodeType } from './types';

export const LIN_AGENT_EVENT_CHANNEL = 'lin-agent-event';

export type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from '@earendil-works/pi-ai';

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

export interface AgentFileAttachmentInput extends AgentAttachmentInputBase {
  kind: 'file';
  path: string;
}

export type AgentMessageAttachmentInput = AgentImageAttachmentInput | AgentTextAttachmentInput | AgentFileAttachmentInput;

export type AgentMessage = Message;
export type AgentConversationMessage = UserMessage | AssistantMessage;

export interface AgentUserViewNodeContext {
  nodeId: NodeId;
  title: string;
  panelId?: string | null;
  surface?: string | null;
}

export interface AgentUserViewOutlineNodeContext {
  nodeId: NodeId;
  title: string;
  depth: number;
  focused?: boolean;
  collapsed?: boolean;
  childCount?: number;
  partial?: {
    included: number;
    total: number;
  };
}

export interface AgentUserViewPanelContext {
  panelId: string;
  rootNodeId: NodeId;
  rootTitle: string;
  rootType?: NodeType | 'outline';
  active: boolean;
  focused: boolean;
  order: number;
  childCount: number;
  breadcrumb: AgentUserViewNodeContext[];
  visibleOutline: AgentUserViewOutlineNodeContext[];
  visibleOutlineTruncated: boolean;
}

export interface AgentUserViewContext {
  activePanelId: string | null;
  focusedPanelId: string | null;
  focusSurface: string | null;
  focusedNode: AgentUserViewNodeContext | null;
  nodePanels: AgentUserViewPanelContext[];
}

export interface AgentToolResultPayloadPart {
  contentIndex: number;
  payload: AgentPayloadRef;
  label?: string;
}

export type AgentToolResultWithPayloads = ToolResultMessage & {
  payloadRefs?: AgentToolResultPayloadPart[];
};

export type AgentDebugSnapshotSource = 'provider_payload' | 'runtime_state';
export type AgentDebugTurnStatus = 'running' | 'completed' | 'error' | 'aborted' | 'interrupted';

export interface AgentDebugWirePayload {
  bytes: number;
  hash: string;
  json?: string;
  payloadRef?: AgentPayloadRef;
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

export interface AgentProjectionEvent {
  type: 'projection';
  sessionId: string;
  lastEventType: string | null;
  revision: number;
  renderProjection: AgentRenderProjection;
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
  | AgentProjectionEvent
  | AgentReadyEvent
  | AgentErrorEvent
  | AgentClosedEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentApprovalRequestEvent;
