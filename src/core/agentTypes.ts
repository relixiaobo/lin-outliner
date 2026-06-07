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
import type {
  AgentPayloadRef,
  AgentUserQuestionRequestView,
  AskUserQuestionResult,
} from './agentEventLog';
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
  ref?: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface AgentImageAttachmentInput extends AgentAttachmentInputBase {
  kind: 'image';
  dataBase64: string;
  path?: string;
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
  referencedNodes?: AgentUserViewNodeContext[];
}

export interface AgentToolResultPayloadPart {
  contentIndex: number;
  payload: AgentPayloadRef;
  label?: string;
}

export type AgentToolResultWithPayloads = ToolResultMessage & {
  payloadRefs?: AgentToolResultPayloadPart[];
};

export interface AgentSubagentActionResult {
  status: 'completed' | 'async_launched' | 'queued' | 'running' | 'failed' | 'stopped';
  agent_id: string;
  name?: string;
  description: string;
  prompt: string;
  subagent_type: string;
  context_mode: 'fresh' | 'fork';
  executing_agent_id?: string;
  parent_agent_id?: string;
  memory_owner_agent_id?: string;
  result?: string;
  error?: string;
  started_at: number;
  updated_at: number;
  completed_at?: number;
  transcript_message_count: number;
  instructions?: string;
}

export type AgentDebugSnapshotSource = 'provider_payload' | 'provider_response' | 'runtime_state';
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
  conversationId: string;
  conversationTitle: string | null;
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
  conversationId: string;
  lastEventType: string | null;
  revision: number;
  renderProjection: AgentRenderProjection;
  timestamp: number;
}

export interface AgentReadyEvent {
  type: 'ready';
  conversationId: null;
  timestamp: number;
}

export interface AgentErrorEvent {
  type: 'error';
  conversationId: string;
  error: string;
  timestamp: number;
}

export interface AgentClosedEvent {
  type: 'closed';
  conversationId: string;
  timestamp: number;
}

export interface AgentToolCallEvent {
  type: 'tool_call';
  conversationId: string;
  toolCallId: string;
  toolName: string;
  args?: unknown;
  timestamp: number;
}

export interface AgentToolResultEvent {
  type: 'tool_result';
  conversationId: string;
  toolCallId: string;
  result?: unknown;
  timestamp: number;
}

export type AgentApprovalResolutionScope = 'once' | 'always';

export interface AgentApprovalRequestDetail {
  label: string;
  value: string;
}

export interface AgentApprovalRequestView {
  requestId: string;
  conversationId: string;
  toolCallId: string;
  toolName: string;
  title: string;
  target: string;
  reason: string;
  details: AgentApprovalRequestDetail[];
  alwaysAllowRule?: string;
}

export interface AgentApprovalResolvedEvent {
  type: 'approval_resolved';
  conversationId: string;
  requestId: string;
  approved: boolean;
  scope?: AgentApprovalResolutionScope;
  timestamp: number;
}

export interface AgentApprovalRequestEvent {
  type: 'approval_request';
  conversationId: string;
  requestId: string;
  request: AgentApprovalRequestView;
  timestamp: number;
}

export interface AgentUserQuestionPendingView {
  requestId: string;
  conversationId: string;
  runId: string;
  toolCallId: string;
  request: AgentUserQuestionRequestView;
}

export interface AgentUserQuestionRequestEvent {
  type: 'user_question_request';
  conversationId: string;
  requestId: string;
  question: AgentUserQuestionPendingView;
  timestamp: number;
}

export interface AgentUserQuestionResolvedEvent {
  type: 'user_question_resolved';
  conversationId: string;
  requestId: string;
  result?: AskUserQuestionResult;
  timestamp: number;
}

export type AgentRuntimeEvent =
  | AgentProjectionEvent
  | AgentReadyEvent
  | AgentErrorEvent
  | AgentClosedEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentApprovalRequestEvent
  | AgentApprovalResolvedEvent
  | AgentUserQuestionRequestEvent
  | AgentUserQuestionResolvedEvent;

export type { AskUserQuestionResult };
