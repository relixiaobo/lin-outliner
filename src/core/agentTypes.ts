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
import type { AgentDefinition, AgentDelegationPermissionMode, NodeId, NodeType } from './types';

export const LIN_AGENT_EVENT_CHANNEL = 'lin-agent-event';

/**
 * Main → renderer one-shot: route the active agent panel to a conversation.
 * Fired when the user clicks an OS notification banner for an off-floor task so
 * the click lands on the originating conversation, not whatever was last active.
 */
export const LIN_AGENT_NAVIGATE_CONVERSATION_CHANNEL = 'lin:agent-navigate-conversation';

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

/**
 * Where a user-authored agent definition lives. `user` → the cross-workspace
 * `~/.agents/agents` dir; `project` → the git-trackable `<workspace>/.agents/agents`
 * dir. Built-in agents are never a write target. See [[agent-authoring]].
 */
export type AgentStorageLocation = 'user' | 'project';

/**
 * The editable subset of an {@link AgentDefinition} that the settings authoring
 * UI sends to main on create/update. Identity/location fields (`source`,
 * `rootDir`, `agentFile`) are NOT here — main derives them from the storage
 * location and name, so the renderer can never point a write outside the agents
 * dirs.
 */
export interface AgentAuthoringInput {
  name: string;
  description: string;
  body: string;
  model?: string;
  effort?: string;
  permissionMode?: AgentDelegationPermissionMode;
  maxTurns?: number;
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  background?: boolean;
}

/**
 * An {@link AgentDefinition} plus its stable `agentId` — the addressing key the
 * settings UI uses to update / delete / enable-disable a specific agent without
 * colliding two same-named agents from different sources. Computed in main from
 * `source`/`agentFile`/`name`; never persisted on disk.
 */
export interface AgentDefinitionView extends AgentDefinition {
  agentId: string;
}

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

export interface AgentChildRunActionResult {
  status: 'completed' | 'async_launched' | 'queued' | 'running' | 'failed' | 'stopped';
  agent_id: string;
  name?: string;
  description: string;
  prompt: string;
  agent_type: string;
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

export type AgentApprovalResolutionScope = 'once' | 'always' | 'full_access';
export type AgentApprovalRequestKind = 'tool_permission' | 'skill_trust' | 'permission_notice';

export interface AgentApprovalRequestDetail {
  label: string;
  value: string;
}

export interface AgentApprovalRequestView {
  requestId: string;
  conversationId: string;
  kind: AgentApprovalRequestKind;
  toolCallId: string;
  toolName: string;
  title: string;
  target: string;
  reason: string;
  details: AgentApprovalRequestDetail[];
  alwaysAllowRule?: string;
  skillTrust?: {
    name: string;
    displayName?: string;
    source: 'user' | 'project';
    contentHash: string;
  };
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

/**
 * Per-conversation unread/attention signal for the off-floor task plane. Emitted
 * whenever a conversation's folded unread count changes (a task delivered a
 * notification off-floor, or the user opened the conversation and cleared it).
 * Threaded to the renderer's conversation list independently of the active-
 * conversation projection, so badges update across all conversations.
 */
export interface AgentConversationAttentionEvent {
  type: 'conversation_attention';
  conversationId: string;
  unreadCount: number;
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
  | AgentUserQuestionResolvedEvent
  | AgentConversationAttentionEvent;

export type { AskUserQuestionResult };
