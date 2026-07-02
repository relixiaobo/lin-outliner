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
import type { AgentRenderProjection, AgentRenderProjectionPatch, AgentRenderRunStatus } from './agentRenderProjection';
import type {
  AgentId,
  AgentPayloadRef,
  AgentRunContextMode,
  AgentRunContextPolicy,
  AgentRunDisposition,
  AgentRunKind,
  AgentRunObjectiveRole,
  AgentRunProfileId,
  AgentRunSubmissionProjection,
  AgentUserQuestionRequestView,
  AskUserQuestionResult,
} from './agentEventLog';
import type { AgentDefinition, AgentDelegationPermissionMode, NodeId, NodeType } from './types';
import type { AgentObjectiveStatus, AgentRunBudget, AgentRunPurpose, AgentRunScope } from './agentEventLog';

export const LIN_AGENT_EVENT_CHANNEL = 'lin-agent-event';

/**
 * Main → renderer one-shot: route the active agent panel to a conversation.
 * Fired when the user clicks an OS notification banner for an off-floor task so
 * the click lands on the originating conversation, not whatever was last active.
 */
export const LIN_AGENT_NAVIGATE_CONVERSATION_CHANNEL = 'lin:agent-navigate-conversation';
export const LIN_AGENT_MESSAGE_CONTEXT_MENU_CHANNEL = 'lin:agent-message-context-menu';

export type AgentMessageContextMenuAction = 'copy' | 'retry' | 'regenerate' | 'details';

export interface AgentMessageContextMenuRequest {
  canCopy: boolean;
  canRetry: boolean;
  canRegenerate: boolean;
  canShowDetails: boolean;
}

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
  /** Whether settings can update/delete this exact definition in place. */
  writable: boolean;
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

export interface AgentRunTranscriptPayload {
  messages: AgentMessage[];
  latestSubmission?: AgentRunSubmissionProjection;
}

export interface AgentRunDetailChild {
  runId: string;
  title: string;
  status: AgentRenderRunStatus;
  objectiveStatus?: AgentObjectiveStatus;
  objectiveRole?: AgentRunObjectiveRole;
  runProfile: AgentRunProfileId;
  runProfileLabel: string;
  parentRunId?: string;
  parentToolCallId?: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface AgentRunDetailPayload {
  runId: string;
  conversationId: string | null;
  agentId: AgentId;
  kind: AgentRunKind;
  title: string;
  status: AgentRenderRunStatus;
  objectiveStatus?: AgentObjectiveStatus;
  objectiveRole?: AgentRunObjectiveRole;
  runProfile: AgentRunProfileId;
  runProfileLabel: string;
  context: AgentRunContextPolicy;
  disposition: AgentRunDisposition;
  parentRunId?: string;
  parentToolCallId?: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  objective?: {
    text: string;
    criteria: string[];
    scope?: AgentRunScope;
    budget?: AgentRunBudget;
    blockedReason?: string;
    latestVerifierGap?: string;
  };
  result?: AgentRunSubmissionProjection;
  error?: string;
  subRuns: AgentRunDetailChild[];
  verificationRuns: AgentRunDetailChild[];
  transcriptMessageCount: number;
}

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
  selectedNodes?: AgentUserViewNodeContext[];
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

export interface AgentRunNodeChanges {
  createdNodeIds?: string[];
  updatedNodeIds?: string[];
  trashedNodeIds?: string[];
}

export interface AgentRunFilePatch {
  filePath: string;
  operation: 'create' | 'update' | 'delete';
  structuredPatch?: unknown;
  trashPath?: string;
  kind?: string;
}

export interface AgentRunFileChanges {
  createdPaths?: string[];
  updatedPaths?: string[];
  deletedPaths?: string[];
  patches?: AgentRunFilePatch[];
}

export interface AgentSubRunStatus {
  runId: string;
  role: 'controller' | 'worker' | 'verifier';
  objectiveStatus?: AgentObjectiveStatus;
  executionStatus: AgentRunActionResult['status'];
  name?: string;
  description?: string;
  objective?: string;
}

export interface AgentRunActionResult {
  status: 'completed' | 'async_launched' | 'queued' | 'running' | 'failed' | 'cancelled';
  runId: string;
  name?: string;
  description: string;
  objective?: string;
  criteria?: string[];
  objective_status?: AgentObjectiveStatus;
  purpose?: AgentRunPurpose;
  scope?: AgentRunScope;
  budget?: AgentRunBudget;
  blocked_reason?: string;
  runProfile: AgentRunProfileId;
  context_mode: AgentRunContextMode;
  result?: string;
  error?: string;
  started_at: number;
  updated_at: number;
  completed_at?: number;
  transcript_message_count: number;
  children?: AgentSubRunStatus[];
  latest_verifier_gap?: string;
  node_changes?: AgentRunNodeChanges;
  file_changes?: AgentRunFileChanges;
  /**
   * The run reached a terminal `completed` status WITHOUT the model deciding it
   * was done: a maxTurns abort or an unresolved context overflow cut it off mid
   * work. Lets callers that treat "completed + empty" as a deliberate outcome
   * (Dream's no-op) tell truncation apart from a genuine finish.
   */
  incomplete?: boolean;
  instructions?: string;
}

export interface AgentRunListEntry {
  runId: string;
  conversationId: string;
  conversationTitle: string | null;
  agentId: AgentId;
  kind: AgentRunKind;
  runProfile: AgentRunProfileId;
  runProfileLabel: string;
  status: AgentRenderRunStatus;
  objectiveStatus?: AgentObjectiveStatus;
  purpose?: AgentRunPurpose;
  parentRunId: string | null;
  title: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}

export type AgentDebugTurnStatus = 'running' | 'completed' | 'error' | 'aborted';

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
  bytes: number;
  parts: AgentDebugMessagePart[];
}

export interface AgentDebugToolEntry {
  name: string;
  description: string;
  schema: string;
  bytes: number;
}

export interface AgentDebugUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface AgentDebugTotals extends AgentDebugUsage {
  queries: number;
  rounds: number;
}

// --- Run-grounded debug surface ([[agent-debug-run-grounded]]) -------------
// A read-only view over the execution tree: conversation -> runs -> rounds ->
// request / response / tool-exchange, derived from the run ledgers that are
// already the system's truth. (Replaced the seq-matched debug-snapshot model.)

export type AgentDebugConversationShape = 'dm' | 'channel';

/** One delegated tool exchange inside a round: the call and (if present) its result. */
export interface AgentDebugToolExchange {
  toolCallId: string;
  toolName: string;
  /** The model's call arguments, pretty-printed. */
  args: string;
  /** The tool result the model saw, or null if still pending / not yet recorded. */
  result: string | null;
  isError: boolean;
}

/** One provider call = one (request, response) pair. The atomic unit of the view. */
export interface AgentDebugRound {
  index: number;
  /** The assistant message id this round produced. */
  messageId: string;
  provider: string;
  modelId: string;
  status: AgentDebugTurnStatus;
  /** The NEW context the model saw entering this round (triggering / prior tool-result messages). */
  requestWindow: AgentDebugMessageRow[];
  /** The assistant's response content (text / thinking / tool calls). */
  responseParts: AgentDebugMessagePart[];
  stopReason: string | null;
  usage: AgentDebugUsage | null;
  toolExchanges: AgentDebugToolExchange[];
  startedAt: number;
  completedAt: number | null;
}

/** A run's full execution detail — meta + per-run system/tools snapshot + rounds. */
export interface AgentDebugRun {
  runId: string;
  agentId: string;
  kind: string;
  status: AgentDebugTurnStatus;
  parentRunId: string | null;
  parentToolCallId: string | null;
  provider: string | null;
  modelId: string | null;
  usage: AgentDebugUsage | null;
  createdAt: number;
  /** The agent's system prompt for this run (per-run snapshot), if captured. */
  systemPrompt: string | null;
  /** The agent's tool schemas for this run (per-run snapshot), if captured. */
  tools: AgentDebugToolEntry[];
  /** The actual model input messages captured from the provider request payload. */
  modelInputMessages: AgentDebugMessageRow[];
  /** Whether Model Input messages came from the provider payload or a legacy derived fallback. */
  modelInputMessagesSource: 'captured' | 'legacyRequestWindow';
  rounds: AgentDebugRound[];
}

/**
 * A per-run node in the conversation tree (no rounds — those load lazily per
 * run). A pure projection of {@link AgentDebugRun}: same fields by `Pick` so the
 * summary can never drift from the full run, plus a cheap `roundCount`.
 */
export interface AgentDebugRunSummary
  extends Pick<
    AgentDebugRun,
    | 'runId'
    | 'agentId'
    | 'kind'
    | 'status'
    | 'parentRunId'
    | 'parentToolCallId'
    | 'provider'
    | 'modelId'
    | 'usage'
    | 'createdAt'
  > {
  roundCount: number;
}

/** The conversation tree summary: shape, per-run nodes (ordered), and rolled-up totals. */
export interface AgentDebugConversation {
  conversationId: string;
  shape: AgentDebugConversationShape;
  members: string[];
  runs: AgentDebugRunSummary[];
  totals: AgentDebugTotals;
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

export interface AgentProjectionPatchEvent {
  type: 'projection_patch';
  conversationId: string;
  lastEventType: string | null;
  revision: number;
  patch: AgentRenderProjectionPatch;
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
  alwaysAllowAction?: 'grant' | 'soft_allow' | 'remove_block';
  autoBlockMs?: number;
  /**
   * Agent id, set only when an approval/notice is attributed to a separate
   * consulted agent. Same-agent Runs leave this unset; their risky actions still
   * gate through ordinary capability permissions.
   */
  requestedByAgentId?: string;
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
 * Per-conversation unread/attention signal for the conversation list. Emitted
 * whenever a conversation's folded unread count changes (new agent-visible
 * delivery while the user is elsewhere, or the user opened the conversation and
 * cleared it).
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
  | AgentProjectionPatchEvent
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
