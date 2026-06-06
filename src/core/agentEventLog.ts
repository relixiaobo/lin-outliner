import type {
  AgentMessage,
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from './agentTypes';

export const AGENT_EVENT_VERSION = 1;

export type AgentActor =
  | { type: 'user'; userId: string }
  | { type: 'agent'; agentId: string }
  | { type: 'tool'; toolName: string; toolCallId: string }
  | { type: 'system' };

export type AgentPayloadRole =
  | 'source'
  | 'thumbnail'
  | 'preview'
  | 'text_extract'
  | 'tool_output'
  | 'subagent_transcript'
  | 'approval'
  | 'debug';

export interface AgentPayloadDisplayMetadata {
  width?: number;
  height?: number;
  durationMs?: number;
  pageCount?: number;
}

export type AgentPayloadScope =
  | { type: 'conversation'; conversationId: string }
  | { type: 'run'; conversationId: string; runId: string };

export interface AgentPayloadRef {
  kind: 'payload_ref';
  id: string;
  storage: 'file';
  mimeType: string;
  byteLength: number;
  sha256: string;
  scope?: AgentPayloadScope;
  role?: AgentPayloadRole;
  summary?: string;
  truncated?: boolean;
  display?: AgentPayloadDisplayMetadata;
}

export type AgentPersistedContent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; redacted?: boolean }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'image'; imageRef: AgentPayloadRef; alt?: string }
  | { type: 'payload_ref'; payload: AgentPayloadRef; label?: string };

// M0 target data-model contracts. These describe the planned conversation/run/memory
// logs while the current flat session event log remains the runtime format below.
export type AgentSourceKind = 'built-in' | 'user' | 'project';
export type AgentId = `${AgentSourceKind}:${string}:${string}`;

export type AgentPrincipal =
  | { type: 'user'; userId: string }
  | { type: 'agent'; agentId: string };

export type AgentConversationActor = AgentPrincipal | { type: 'system' };

export interface AgentConversationMeta {
  id: string;
  members: AgentPrincipal[];
  goal?: string;
  name?: string;
  createdAt: number;
}

export interface AgentReadCursors {
  conversationId: string;
  byPrincipal: Record<string, number>;
}

export type AgentConversationEventType =
  | 'message.created'
  | 'message.edited'
  | 'member.added'
  | 'member.removed'
  | 'branch.selected'
  | 'compaction.completed';

export interface AgentConversationEventBase {
  v: typeof AGENT_EVENT_VERSION;
  eventId: string;
  seq: number;
  conversationId: string;
  type: AgentConversationEventType;
  createdAt: number;
  actor: AgentConversationActor;
}

export type AgentConversationEvent =
  | (AgentConversationEventBase & {
      type: 'message.created';
      messageId: string;
      parentMessageId?: string;
      role: 'user' | 'assistant';
      addressedTo?: AgentPrincipal[];
      runId?: string;
      content: AgentPersistedContent[];
      forwarded?: {
        fromConversationId: string;
        sourceMessageIds: string[];
        bundleId: string;
      };
    })
  | (AgentConversationEventBase & {
      type: 'message.edited';
      messageId: string;
      content: AgentPersistedContent[];
    })
  | (AgentConversationEventBase & {
      type: 'member.added' | 'member.removed';
      member: AgentPrincipal;
    })
  | (AgentConversationEventBase & {
      type: 'branch.selected';
      selectedLeafMessageId: string;
    })
  | (AgentConversationEventBase & {
      type: 'compaction.completed';
      summaryId: string;
      source: { fromMessageId: string; throughMessageId: string };
    });

export type AgentRunKind = 'turn' | 'background' | 'subagent' | 'scheduled';
export type AgentRunRetention = 'hot' | 'cold-archived' | 'summarized-only' | 'deleted';

export type AgentRunTrigger =
  | { type: 'message'; messageId: string }
  | { type: 'node'; nodeId: string }
  | { type: 'parent-run'; parentRunId: string }
  | { type: 'manual' | 'system' };

export interface AgentRunFingerprint {
  appVersion: string;
  promptHash: string;
  toolSchemaHash: string;
  skillBindings: string[];
  modelConfig: string;
}

export interface AgentRunMeta {
  id: string;
  agentId: string;
  conversationId: string;
  parentRunId?: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  trigger: AgentRunTrigger;
  usage?: Usage;
  fingerprint: AgentRunFingerprint;
  retention: AgentRunRetention;
  createdAt: number;
}

export type AgentRunLogEventType =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'assistant_message.started'
  | 'assistant_message.delta'
  | 'assistant_message.completed'
  | 'thinking.delta'
  | 'tool_call.started'
  | 'tool_call.completed'
  | 'tool_call.failed'
  | 'tool_result.created'
  | 'tool.permission.checked'
  | 'tool.permission.resolved'
  | 'user_question.requested'
  | 'user_question.answered'
  | 'user_question.cancelled'
  | 'widget_state.updated';

export interface AgentRunEventBase {
  v: typeof AGENT_EVENT_VERSION;
  eventId: string;
  seq: number;
  runId: string;
  type: AgentRunLogEventType;
  createdAt: number;
}

export type AgentUserQuestionKind = 'single_choice' | 'multi_choice' | 'free_text';

export interface AgentUserQuestionOptionView {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface AgentUserQuestionItemView {
  id: string;
  type: AgentUserQuestionKind;
  header?: string;
  question: string;
  required?: boolean;
  allowOther?: boolean;
  allowReferences?: boolean;
  allowAttachments?: boolean;
  options?: AgentUserQuestionOptionView[];
}

export interface AgentUserQuestionRequestView {
  questions: AgentUserQuestionItemView[];
  submitLabel?: string;
}

export interface AgentUserQuestionNodeReference {
  nodeId: string;
  label?: string;
}

export interface AgentUserQuestionFileReference {
  path: string;
  label?: string;
  payload?: AgentPayloadRef;
}

export interface AgentUserQuestionAttachment {
  payload: AgentPayloadRef;
  label?: string;
}

export interface AgentUserQuestionAnswer {
  questionId: string;
  selectedOptionIds?: string[];
  text?: string;
  notes?: string;
  nodeRefs?: AgentUserQuestionNodeReference[];
  fileRefs?: AgentUserQuestionFileReference[];
  attachments?: AgentUserQuestionAttachment[];
}

export interface AskUserQuestionResult {
  requestId: string;
  answers: AgentUserQuestionAnswer[];
}

export type AgentRunLogEvent =
  | (AgentRunEventBase & { type: 'run.started' })
  | (AgentRunEventBase & { type: 'run.completed'; usage?: Usage })
  | (AgentRunEventBase & { type: 'run.failed'; error: { code: string; message: string }; usage?: Usage })
  | (AgentRunEventBase & { type: 'run.cancelled'; reason?: string; usage?: Usage })
  | (AgentRunEventBase & { type: 'assistant_message.started'; messageId: string })
  | (AgentRunEventBase & { type: 'assistant_message.delta'; messageId: string; delta: AgentPersistedContent })
  | (AgentRunEventBase & { type: 'assistant_message.completed'; messageId: string; content: AgentPersistedContent[]; usage: Usage })
  | (AgentRunEventBase & { type: 'thinking.delta'; messageId: string; delta: string })
  | (AgentRunEventBase & { type: 'tool_call.started'; toolCallId: string; messageId: string; name: string; input: unknown })
  | (AgentRunEventBase & { type: 'tool_call.completed'; toolCallId: string })
  | (AgentRunEventBase & { type: 'tool_call.failed'; toolCallId: string; error: { code: string; message: string } })
  | (AgentRunEventBase & { type: 'tool_result.created'; toolCallId: string; content: AgentPersistedContent[]; isError?: boolean })
  | (AgentRunEventBase & {
      type: 'tool.permission.checked';
      requestId: string;
      toolCallId: string;
      toolName: string;
      primaryActionKind?: string;
      actionKinds: string[];
      outcome: 'allow' | 'ask' | 'blocked';
      source:
        | 'global_rule'
        | 'action_default'
        | 'configured_deny'
        | 'classifier'
        | 'classifier_unavailable'
        | 'safe_allowlist'
        | 'user'
        | 'platform_hard_block'
        | 'runtime';
      classifierResult?: {
        outcome: 'allow' | 'block';
        reason: string;
        model?: string;
        unavailable?: boolean;
      };
      descriptorRef?: AgentPayloadRef;
    })
  | (AgentRunEventBase & {
      type: 'tool.permission.resolved';
      requestId: string;
      toolCallId: string;
      toolName: string;
      status: 'approved' | 'denied' | 'aborted';
      resolvedBy:
        | 'classifier'
        | 'safe_allowlist'
        | 'user_once'
        | 'allow_rule_update'
        | 'global_rule'
        | 'configured_deny'
        | 'classifier_unavailable'
        | 'platform_hard_block'
        | 'runtime'
        | 'system_abort';
      updatedRule?: string;
      deniedReason?: string;
    })
  | (AgentRunEventBase & {
      type: 'user_question.requested';
      requestId: string;
      toolCallId: string;
      request: AgentUserQuestionRequestView;
    })
  | (AgentRunEventBase & {
      type: 'user_question.answered';
      requestId: string;
      result: AskUserQuestionResult;
    })
  | (AgentRunEventBase & {
      type: 'user_question.cancelled';
      requestId: string;
      reason?: string;
    })
  | (AgentRunEventBase & {
      type: 'widget_state.updated';
      toolCallId: string;
      messageId: string;
      currentState: unknown;
    });

export interface AgentIdentityRecord {
  agentId: AgentId;
  displayName: string;
  model: string;
  effort?: string;
  systemPrompt: string;
  skills: string[];
}

export interface AgentMemorySource {
  conversationId: string;
  summaryId?: string;
  messageRange?: [string, string];
  runId?: string;
  eventId?: string;
}

export interface AgentMemoryEntry {
  id: string;
  agentId: string;
  fact: string;
  originWorkspace?: string;
  sources: AgentMemorySource[];
  status: 'active' | 'invalidated';
  createdAt: number;
}

export interface AgentMemoryEventBase {
  v: typeof AGENT_EVENT_VERSION;
  eventId: string;
  seq: number;
  agentId: string;
  type: AgentMemoryEventType;
  createdAt: number;
}

export type AgentMemoryEventType = 'memory.entry_added' | 'memory.entry_updated' | 'memory.entry_removed';

export type AgentMemoryEvent =
  | (AgentMemoryEventBase & { type: 'memory.entry_added'; entry: AgentMemoryEntry })
  | (AgentMemoryEventBase & {
      type: 'memory.entry_updated';
      entryId: string;
      patch: Partial<Pick<AgentMemoryEntry, 'fact' | 'sources' | 'status' | 'originWorkspace'>>;
    })
  | (AgentMemoryEventBase & { type: 'memory.entry_removed'; entryId: string; reason?: string });

export interface AgentTextDelta {
  type: 'text_delta';
  text: string;
}

export type AgentContentDelta = AgentTextDelta;

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type AgentMessageStatus = 'completed' | 'streaming' | 'failed';
export type AgentSubagentRunStatus = 'running' | 'completed' | 'failed' | 'stopped';
export type AgentCompactionTrigger = 'manual' | 'auto' | 'reactive';

export type AgentEventType =
  | 'session.created'
  | 'session.renamed'
  | 'session.settings_changed'
  | 'debug.snapshot.created'
  | 'branch.selected'
  | 'user_message.created'
  | 'user_message.edited'
  | 'assistant_message.started'
  | 'assistant_message.delta'
  | 'assistant_message.completed'
  | 'assistant_message.failed'
  | 'thinking.delta'
  | 'tool_call.started'
  | 'tool_call.delta'
  | 'tool_call.completed'
  | 'tool_call.failed'
  | 'tool_result.created'
  | 'tool_result.replaced'
  | 'tool.permission.checked'
  | 'tool.permission.resolved'
  | 'user_question.requested'
  | 'user_question.answered'
  | 'user_question.cancelled'
  | 'widget_state.updated'
  | 'approval.requested'
  | 'approval.resolved'
  | 'follow_up.queued'
  | 'follow_up.applied'
  | 'task.created'
  | 'task.completed'
  | 'notification.created'
  | 'config.change'
  | 'review_card.created'
  | 'skill.created'
  | 'skill.patched'
  | 'skill.replaced'
  | 'skill.enabled'
  | 'skill.disabled'
  | 'skill.rolled_back'
  | 'skill.curation.updated'
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'subagent_run.started'
  | 'subagent_run.updated'
  | 'compaction.completed'
  | 'payload.created'
  | 'payload.derived'
  | 'checkpoint.created'
  | 'metric.recorded';

export interface AgentEventBase {
  v: typeof AGENT_EVENT_VERSION;
  eventId: string;
  seq: number;
  sessionId: string;
  type: AgentEventType;
  createdAt: number;
  actor: AgentActor;
  runId?: string;
  turnId?: string;
  messageId?: string;
  parentMessageId?: string | null;
  causedByEventId?: string;
}

export interface SessionCreatedEvent extends AgentEventBase {
  type: 'session.created';
  title: string | null;
}

export interface SessionRenamedEvent extends AgentEventBase {
  type: 'session.renamed';
  title: string | null;
}

export interface SessionSettingsChangedEvent extends AgentEventBase {
  type: 'session.settings_changed';
  settings: Record<string, unknown>;
}

export interface DebugSnapshotCreatedEvent extends AgentEventBase {
  type: 'debug.snapshot.created';
  debugId: string;
  source: 'provider_payload' | 'provider_response' | 'runtime_state';
  queryIndex: number;
  turnIndex: number;
  payloadRef: AgentPayloadRef;
  wire: {
    bytes: number;
    hash: string;
  };
  model: {
    id: string;
    provider: string;
    api?: string;
    contextWindow?: number | null;
  };
}

export interface BranchSelectedEvent extends AgentEventBase {
  type: 'branch.selected';
  leafMessageId: string;
}

export interface UserMessageCreatedEvent extends AgentEventBase {
  type: 'user_message.created';
  messageId: string;
  parentMessageId: string | null;
  content: AgentPersistedContent[];
  attachments?: AgentPayloadRef[];
  replacesMessageId?: string;
}

export interface UserMessageEditedEvent extends AgentEventBase {
  type: 'user_message.edited';
  messageId: string;
  content: AgentPersistedContent[];
}

export interface AssistantMessageStartedEvent extends AgentEventBase {
  type: 'assistant_message.started';
  messageId: string;
  parentMessageId: string | null;
  runId: string;
  providerId: string;
  modelId: string;
  apiId?: string;
}

export interface AssistantMessageDeltaEvent extends AgentEventBase {
  type: 'assistant_message.delta';
  messageId: string;
  delta: AgentContentDelta;
  providerChunkCount: number;
  startedAt: number;
  endedAt: number;
}

export interface AssistantMessageCompletedEvent extends AgentEventBase {
  type: 'assistant_message.completed';
  messageId: string;
  stopReason: AssistantMessage['stopReason'];
  content: AgentPersistedContent[];
  usage?: Usage;
}

export interface AssistantMessageFailedEvent extends AgentEventBase {
  type: 'assistant_message.failed';
  messageId: string;
  errorMessage: string;
}

export interface ThinkingDeltaEvent extends AgentEventBase {
  type: 'thinking.delta';
  messageId: string;
  delta: AgentTextDelta;
}

export interface ToolCallStartedEvent extends AgentEventBase {
  type: 'tool_call.started';
  toolCallId: string;
  messageId: string;
  name: string;
  inputSummary: string;
  args?: Record<string, unknown>;
  inputRef?: AgentPayloadRef;
}

export interface ToolCallDeltaEvent extends AgentEventBase {
  type: 'tool_call.delta';
  toolCallId: string;
  messageId: string;
  delta: AgentTextDelta;
}

export interface ToolCallCompletedEvent extends AgentEventBase {
  type: 'tool_call.completed';
  toolCallId: string;
  messageId: string;
}

export interface ToolCallFailedEvent extends AgentEventBase {
  type: 'tool_call.failed';
  toolCallId: string;
  messageId: string;
  errorMessage: string;
}

export interface ToolResultCreatedEvent extends AgentEventBase {
  type: 'tool_result.created';
  runId?: string;
  toolCallId: string;
  toolName: string;
  messageId: string;
  parentMessageId: string | null;
  isError: boolean;
  content: AgentPersistedContent[];
  outputSummary: string;
  outputRef?: AgentPayloadRef;
}

export interface ToolResultReplacedEvent extends AgentEventBase {
  type: 'tool_result.replaced';
  runId?: string;
  toolCallId: string;
  messageId: string;
  content: AgentPersistedContent[];
  outputSummary: string;
  outputRef?: AgentPayloadRef;
}

export interface ToolPermissionCheckedEvent extends AgentEventBase {
  type: 'tool.permission.checked';
  requestId: string;
  toolCallId: string;
  toolName: string;
  primaryActionKind?: string;
  actionKinds: string[];
  outcome: 'allow' | 'ask' | 'blocked';
  source:
    | 'global_rule'
    | 'action_default'
    | 'configured_deny'
    | 'classifier'
    | 'classifier_unavailable'
    | 'safe_allowlist'
    | 'user'
    | 'platform_hard_block'
    | 'runtime';
  classifierResult?: {
    outcome: 'allow' | 'block';
    reason: string;
    model?: string;
    unavailable?: boolean;
  };
  descriptorRef?: AgentPayloadRef;
}

export interface ToolPermissionResolvedEvent extends AgentEventBase {
  type: 'tool.permission.resolved';
  requestId: string;
  toolCallId: string;
  toolName: string;
  status: 'approved' | 'denied' | 'aborted';
  resolvedBy:
    | 'classifier'
    | 'safe_allowlist'
    | 'user_once'
    | 'allow_rule_update'
    | 'global_rule'
    | 'configured_deny'
    | 'classifier_unavailable'
    | 'platform_hard_block'
    | 'runtime'
    | 'system_abort';
  updatedRule?: string;
  deniedReason?: string;
}

export interface UserQuestionRequestedEvent extends AgentEventBase {
  type: 'user_question.requested';
  runId: string;
  requestId: string;
  toolCallId: string;
  request: AgentUserQuestionRequestView;
}

export interface UserQuestionAnsweredEvent extends AgentEventBase {
  type: 'user_question.answered';
  runId: string;
  requestId: string;
  result: AskUserQuestionResult;
}

export interface UserQuestionCancelledEvent extends AgentEventBase {
  type: 'user_question.cancelled';
  runId: string;
  requestId: string;
  reason?: string;
}

export interface WidgetStateUpdatedEvent extends AgentEventBase {
  type: 'widget_state.updated';
  runId: string;
  toolCallId: string;
  messageId: string;
  currentState: unknown;
}

export interface ApprovalRequestedEvent extends AgentEventBase {
  type: 'approval.requested';
  requestId: string;
  summary: string;
  payloadRef?: AgentPayloadRef;
}

export interface ApprovalResolvedEvent extends AgentEventBase {
  type: 'approval.resolved';
  requestId: string;
  approved: boolean;
}

export interface FollowUpQueuedEvent extends AgentEventBase {
  type: 'follow_up.queued';
  content: AgentPersistedContent[];
}

export interface FollowUpAppliedEvent extends AgentEventBase {
  type: 'follow_up.applied';
  messageId: string;
}

export interface TaskCreatedEvent extends AgentEventBase {
  type: 'task.created';
  taskId: string;
  title: string;
  assignedTo?: AgentPrincipal;
  sourceRunId?: string;
}

export interface TaskCompletedEvent extends AgentEventBase {
  type: 'task.completed';
  taskId: string;
  result?: string;
}

export interface NotificationCreatedEvent extends AgentEventBase {
  type: 'notification.created';
  notificationId: string;
  title: string;
  body?: string;
  target: AgentPrincipal;
}

export interface AgentConfigChange {
  target: 'runtime' | 'agent' | 'skill' | 'hook';
  key: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

export interface ConfigChangeEvent extends AgentEventBase {
  type: 'config.change';
  changeId: string;
  status: 'proposed' | 'applied' | 'reverted' | 'failed';
  change: AgentConfigChange;
}

export interface AgentReviewCard {
  id: string;
  title: string;
  body: string;
  status: 'pending' | 'approved' | 'rejected' | 'applied';
  payloadRef?: AgentPayloadRef;
}

export interface ReviewCardCreatedEvent extends AgentEventBase {
  type: 'review_card.created';
  card: AgentReviewCard;
}

export interface SkillAuditEvent extends AgentEventBase {
  type:
    | 'skill.created'
    | 'skill.patched'
    | 'skill.replaced'
    | 'skill.enabled'
    | 'skill.disabled'
    | 'skill.rolled_back'
    | 'skill.curation.updated';
  skillId: string;
  source: AgentSourceKind | 'dynamic';
  summary?: string;
  payloadRef?: AgentPayloadRef;
}

export interface RunStartedEvent extends AgentEventBase {
  type: 'run.started';
  runId: string;
  agentId?: string;
  kind?: AgentRunKind;
  trigger?: AgentRunTrigger;
  fingerprint?: AgentRunFingerprint;
  retention?: AgentRunRetention;
}

export interface RunTerminalEvent extends AgentEventBase {
  type: 'run.completed' | 'run.failed' | 'run.cancelled';
  runId: string;
  errorMessage?: string;
  usage?: Usage;
}

export interface SubagentRunStartedEvent extends AgentEventBase {
  type: 'subagent_run.started';
  subagentRunId: string;
  parentToolCallId?: string;
  name?: string;
  description: string;
  prompt: string;
  subagentType: string;
  contextMode: 'fresh' | 'fork';
  transcriptPayload?: AgentPayloadRef;
  transcriptMessageCount: number;
}

export interface SubagentRunUpdatedEvent extends AgentEventBase {
  type: 'subagent_run.updated';
  subagentRunId: string;
  status: AgentSubagentRunStatus;
  completedAt?: number;
  result?: string;
  error?: string;
  transcriptPayload?: AgentPayloadRef;
  transcriptMessageCount: number;
}

export interface CompactionCompletedEvent extends AgentEventBase {
  type: 'compaction.completed';
  messageId: string;
  summary: string;
  compactedThroughMessageId: string;
  trigger: AgentCompactionTrigger;
}

export interface PayloadCreatedEvent extends AgentEventBase {
  type: 'payload.created';
  payload: AgentPayloadRef;
}

export interface PayloadDerivedEvent extends AgentEventBase {
  type: 'payload.derived';
  sourcePayloadId: string;
  payload: AgentPayloadRef;
  derivation: 'thumbnail' | 'preview' | 'text_extract' | 'page_render';
}

export interface CheckpointCreatedEvent extends AgentEventBase {
  type: 'checkpoint.created';
  checkpointSeq: number;
  eventByteOffset: number;
}

export interface MetricRecordedEvent extends AgentEventBase {
  type: 'metric.recorded';
  name: string;
  value: number;
  unit?: string;
  tags?: Record<string, string>;
}

export type AgentEvent =
  | SessionCreatedEvent
  | SessionRenamedEvent
  | SessionSettingsChangedEvent
  | DebugSnapshotCreatedEvent
  | BranchSelectedEvent
  | UserMessageCreatedEvent
  | UserMessageEditedEvent
  | AssistantMessageStartedEvent
  | AssistantMessageDeltaEvent
  | AssistantMessageCompletedEvent
  | AssistantMessageFailedEvent
  | ThinkingDeltaEvent
  | ToolCallStartedEvent
  | ToolCallDeltaEvent
  | ToolCallCompletedEvent
  | ToolCallFailedEvent
  | ToolResultCreatedEvent
  | ToolResultReplacedEvent
  | ToolPermissionCheckedEvent
  | ToolPermissionResolvedEvent
  | UserQuestionRequestedEvent
  | UserQuestionAnsweredEvent
  | UserQuestionCancelledEvent
  | WidgetStateUpdatedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | FollowUpQueuedEvent
  | FollowUpAppliedEvent
  | TaskCreatedEvent
  | TaskCompletedEvent
  | NotificationCreatedEvent
  | ConfigChangeEvent
  | ReviewCardCreatedEvent
  | SkillAuditEvent
  | RunStartedEvent
  | RunTerminalEvent
  | SubagentRunStartedEvent
  | SubagentRunUpdatedEvent
  | CompactionCompletedEvent
  | PayloadCreatedEvent
  | PayloadDerivedEvent
  | CheckpointCreatedEvent
  | MetricRecordedEvent;

export interface AgentSessionRecord {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  settings: Record<string, unknown>;
}

export type AgentEventMessageRole = 'user' | 'assistant' | 'toolResult';

export interface AgentEventMessageRecord {
  id: string;
  role: AgentEventMessageRole;
  actor: AgentActor;
  parentMessageId: string | null;
  replacesMessageId?: string;
  content: AgentPersistedContent[];
  createdAt: number;
  updatedAt: number;
  status: AgentMessageStatus;
  runId?: string;
  providerId?: string;
  modelId?: string;
  apiId?: string;
  stopReason?: AssistantMessage['stopReason'];
  usage?: Usage;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  outputSummary?: string;
  attachments?: AgentPayloadRef[];
}

export interface AgentRunRecord {
  id: string;
  agentId?: string;
  status: AgentRunStatus;
  startedAt: number;
  updatedAt: number;
  errorMessage?: string;
  usage?: Usage;
}

export interface AgentSubagentRunRecord {
  id: string;
  name?: string;
  description: string;
  prompt: string;
  subagentType: string;
  contextMode: 'fresh' | 'fork';
  status: AgentSubagentRunStatus;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  transcriptPayloadId?: string;
  transcriptMessageCount: number;
  parentToolCallId?: string;
}

export interface AgentCompactionRecord {
  id: string;
  messageId: string;
  summary: string;
  compactedThroughMessageId: string;
  trigger: AgentCompactionTrigger;
  createdAt: number;
}

export interface AgentEventReplayState {
  session: AgentSessionRecord | null;
  latestSeq: number;
  latestEventId: string | null;
  messages: Record<string, AgentEventMessageRecord>;
  rootMessageIds: string[];
  childrenByParentId: Record<string, string[]>;
  selectedLeafMessageId: string | null;
  latestMessageId: string | null;
  payloads: Record<string, AgentPayloadRef>;
  derivedPayloadsBySourceId: Record<string, AgentPayloadRef[]>;
  runs: Record<string, AgentRunRecord>;
  subagents: Record<string, AgentSubagentRunRecord>;
  compactionsByMessageId: Record<string, AgentCompactionRecord>;
}

export interface AgentMessageBranchState {
  ids: string[];
  currentIndex: number;
}

export interface AgentEventConversationEntry {
  messageId: string;
  message: AgentEventMessageRecord;
  branches: AgentMessageBranchState | null;
}

export interface AgentEventVisibleTranscriptEntry {
  message: AgentEventMessageRecord;
  archived: boolean;
}

export function createEmptyAgentEventReplayState(): AgentEventReplayState {
  return {
    session: null,
    latestSeq: 0,
    latestEventId: null,
    messages: {},
    rootMessageIds: [],
    childrenByParentId: {},
    selectedLeafMessageId: null,
    latestMessageId: null,
    payloads: {},
    derivedPayloadsBySourceId: {},
    runs: {},
    subagents: {},
    compactionsByMessageId: {},
  };
}

export function replayAgentEvents(events: readonly AgentEvent[]): AgentEventReplayState {
  const state = createEmptyAgentEventReplayState();
  const seenEventIds = new Set<string>();
  for (const event of events) {
    assertValidNextEvent(state, seenEventIds, event);
    applyAgentEvent(state, event);
    touchSessionUpdatedAt(state, event);
    seenEventIds.add(event.eventId);
    state.latestSeq = event.seq;
    state.latestEventId = event.eventId;
  }
  return state;
}

export function appendAgentEventToReplayState(state: AgentEventReplayState, event: AgentEvent): AgentEventReplayState {
  assertValidNextEvent(state, new Set(), event);
  applyAgentEvent(state, event);
  touchSessionUpdatedAt(state, event);
  state.latestSeq = event.seq;
  state.latestEventId = event.eventId;
  return state;
}

export function getAgentEventActivePath(state: AgentEventReplayState): AgentEventMessageRecord[] {
  const leafMessageId = state.selectedLeafMessageId ?? state.latestMessageId;
  if (!leafMessageId) return [];

  const path: AgentEventMessageRecord[] = [];
  const visited = new Set<string>();
  let cursorId: string | null = leafMessageId;
  while (cursorId) {
    if (visited.has(cursorId)) {
      throw new Error(`Cycle in agent message chain at ${cursorId}`);
    }
    visited.add(cursorId);
    const message: AgentEventMessageRecord | undefined = state.messages[cursorId];
    if (!message) {
      throw new Error(`Selected agent branch references missing message: ${cursorId}`);
    }
    path.push(message);
    cursorId = message.parentMessageId;
  }
  return path.reverse();
}

export function getAgentEventVisibleTranscript(
  state: AgentEventReplayState,
): AgentEventVisibleTranscriptEntry[] {
  const entries: AgentEventVisibleTranscriptEntry[] = [];
  const expandingCompactions = new Set<string>();
  for (const message of getAgentEventActivePath(state)) {
    appendVisibleTranscriptEntry(state, entries, expandingCompactions, message, false);
  }
  return entries;
}

export function getAgentEventConversationPath(state: AgentEventReplayState): AgentEventMessageRecord[] {
  return getAgentEventActivePath(state).filter(isAgentConversationMessage);
}

export function getAgentEventRuntimeTranscriptPath(state: AgentEventReplayState): AgentEventMessageRecord[] {
  // F2a read seam: this is the joined pi-agent-core transcript. While storage is
  // still flat, the active path already interleaves communication messages with
  // run-scoped execution messages; the physical run-log split can later replace
  // this implementation without changing runtime consumers.
  return getAgentEventActivePath(state);
}

export function getAgentEventMessageBranches(
  state: AgentEventReplayState,
  messageId: string,
): AgentMessageBranchState | null {
  const message = state.messages[messageId];
  if (!message) return null;
  const siblings = message.parentMessageId
    ? state.childrenByParentId[message.parentMessageId] ?? []
    : state.rootMessageIds;
  if (siblings.length <= 1) return null;

  const activePathIds = new Set(getAgentEventActivePath(state).map((item) => item.id));
  const activeSiblingId = siblings.find((id) => activePathIds.has(id)) ?? messageId;
  const currentIndex = siblings.indexOf(activeSiblingId);
  return currentIndex >= 0 ? { ids: siblings.slice(), currentIndex } : null;
}

export function getAgentEventConversation(state: AgentEventReplayState): AgentEventConversationEntry[] {
  return getAgentEventConversationPath(state)
    .map((message) => ({
      messageId: message.id,
      message,
      branches: getAgentEventMessageBranches(state, message.id),
    }));
}

export function deriveAgentPiMessages(state: AgentEventReplayState): AgentMessage[] {
  return getAgentEventRuntimeTranscriptPath(state)
    .map(agentEventMessageToPiMessage)
    .filter((message): message is AgentMessage => Boolean(message));
}

export function isAgentConversationMessage(message: AgentEventMessageRecord): boolean {
  if (message.role === 'user') return true;
  if (message.role !== 'assistant') return false;
  return !isAgentRunExecutionMessage(message);
}

export function isAgentRunExecutionMessage(message: AgentEventMessageRecord): boolean {
  if (message.role === 'toolResult') return true;
  return message.role === 'assistant'
    && (message.stopReason === 'toolUse' || message.content.some((part) => part.type === 'toolCall'));
}

export function agentEventMessageToPiMessage(message: AgentEventMessageRecord): AgentMessage | null {
  if (message.role === 'user') {
    return {
      role: 'user',
      content: toPiUserContent(message.content),
      timestamp: message.createdAt,
    } satisfies UserMessage;
  }
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: toPiAssistantContent(message.content),
      api: message.apiId ?? 'unknown',
      provider: message.providerId ?? 'unknown',
      model: message.modelId ?? 'unknown',
      usage: message.usage ?? EMPTY_USAGE,
      stopReason: message.stopReason ?? (message.status === 'failed' ? 'error' : 'stop'),
      errorMessage: message.errorMessage,
      timestamp: message.createdAt,
    } satisfies AssistantMessage;
  }
  return {
    role: 'toolResult',
    toolCallId: message.toolCallId ?? message.id,
    toolName: message.toolName ?? 'unknown',
    content: toPiContentParts(message.content),
    isError: !!message.isError,
    timestamp: message.createdAt,
  } satisfies ToolResultMessage;
}

function assertValidNextEvent(
  state: AgentEventReplayState,
  seenEventIds: Set<string>,
  event: AgentEvent,
) {
  if (event.v !== AGENT_EVENT_VERSION) {
    throw new Error(`Unsupported agent event version: ${event.v}`);
  }
  if (seenEventIds.has(event.eventId)) {
    throw new Error(`Duplicate agent event id: ${event.eventId}`);
  }
  if (event.seq <= state.latestSeq) {
    throw new Error(`Agent events must be appended in increasing seq order: ${event.seq}`);
  }
  if (state.session && event.sessionId !== state.session.id) {
    throw new Error(`Agent event session mismatch: ${event.sessionId}`);
  }
}

function applyAgentEvent(state: AgentEventReplayState, event: AgentEvent) {
  switch (event.type) {
    case 'session.created':
      state.session = {
        id: event.sessionId,
        title: event.title,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        settings: {},
      };
      return;
    case 'session.renamed':
      requireSession(state, event);
      state.session!.title = event.title;
      state.session!.updatedAt = event.createdAt;
      return;
    case 'session.settings_changed':
      requireSession(state, event);
      state.session!.settings = { ...state.session!.settings, ...event.settings };
      state.session!.updatedAt = event.createdAt;
      return;
    case 'debug.snapshot.created':
      return;
    case 'user_message.created':
      addMessage(state, {
        id: event.messageId,
        role: 'user',
        actor: event.actor,
        parentMessageId: event.parentMessageId,
        replacesMessageId: event.replacesMessageId,
        content: cloneContent(event.content),
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        status: 'completed',
        attachments: event.attachments?.slice(),
      });
      state.selectedLeafMessageId = event.messageId;
      return;
    case 'user_message.edited': {
      const message = requireMessage(state, event.messageId);
      if (message.role !== 'user') throw new Error(`Cannot edit non-user agent message: ${event.messageId}`);
      message.content = cloneContent(event.content);
      message.updatedAt = event.createdAt;
      return;
    }
    case 'assistant_message.started':
      addMessage(state, {
        id: event.messageId,
        role: 'assistant',
        actor: event.actor,
        parentMessageId: event.parentMessageId,
        content: [],
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        status: 'streaming',
        runId: event.runId,
        providerId: event.providerId,
        modelId: event.modelId,
        apiId: event.apiId,
      });
      state.selectedLeafMessageId = event.messageId;
      return;
    case 'assistant_message.delta': {
      const message = requireMessage(state, event.messageId);
      if (message.role !== 'assistant') throw new Error(`Cannot append assistant delta to ${message.role} message`);
      applyContentDelta(message, event.delta);
      message.updatedAt = event.endedAt;
      return;
    }
    case 'assistant_message.completed': {
      const message = requireMessage(state, event.messageId);
      if (message.role !== 'assistant') throw new Error(`Cannot complete ${message.role} message as assistant`);
      message.content = cloneContent(event.content);
      message.status = 'completed';
      message.stopReason = event.stopReason;
      message.usage = event.usage;
      message.updatedAt = event.createdAt;
      return;
    }
    case 'assistant_message.failed': {
      const message = requireMessage(state, event.messageId);
      if (message.role !== 'assistant') throw new Error(`Cannot fail ${message.role} message as assistant`);
      message.status = 'failed';
      message.errorMessage = event.errorMessage;
      message.updatedAt = event.createdAt;
      return;
    }
    case 'tool_result.created':
      addMessage(state, {
        id: event.messageId,
        role: 'toolResult',
        actor: event.actor,
        parentMessageId: event.parentMessageId,
        content: cloneContent(event.content),
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        status: 'completed',
        runId: event.runId ?? parentRunId(state, event.parentMessageId),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        outputSummary: event.outputSummary,
      });
      state.selectedLeafMessageId = event.messageId;
      return;
    case 'tool_result.replaced': {
      const message = requireMessage(state, event.messageId);
      if (message.role !== 'toolResult') throw new Error(`Cannot replace ${message.role} message as tool result`);
      if (message.toolCallId !== event.toolCallId) {
        throw new Error(`Tool result replacement id mismatch: ${event.toolCallId}`);
      }
      message.content = cloneContent(event.content);
      message.updatedAt = event.createdAt;
      message.outputSummary = event.outputSummary;
      message.runId = event.runId ?? message.runId;
      return;
    }
    case 'branch.selected':
      requireMessage(state, event.leafMessageId);
      state.selectedLeafMessageId = event.leafMessageId;
      return;
    case 'run.started':
      state.runs[event.runId] = {
        id: event.runId,
        agentId: event.agentId,
        status: 'running',
        startedAt: event.createdAt,
        updatedAt: event.createdAt,
      };
      return;
    case 'run.completed':
    case 'run.failed':
    case 'run.cancelled': {
      const run = state.runs[event.runId] ?? {
        id: event.runId,
        status: 'running' as const,
        startedAt: event.createdAt,
        updatedAt: event.createdAt,
      };
      run.status = event.type === 'run.completed'
        ? 'completed'
        : event.type === 'run.failed'
          ? 'failed'
          : 'cancelled';
      run.updatedAt = event.createdAt;
      run.errorMessage = event.errorMessage;
      run.usage = event.usage ?? run.usage;
      state.runs[event.runId] = run;
      return;
    }
    case 'subagent_run.started':
      state.subagents ??= {};
      state.subagents[event.subagentRunId] = {
        id: event.subagentRunId,
        name: event.name,
        description: event.description,
        prompt: event.prompt,
        subagentType: event.subagentType,
        contextMode: event.contextMode,
        status: 'running',
        startedAt: event.createdAt,
        updatedAt: event.createdAt,
        transcriptPayloadId: event.transcriptPayload?.id,
        transcriptMessageCount: event.transcriptMessageCount,
        parentToolCallId: event.parentToolCallId,
      };
      if (event.transcriptPayload) state.payloads[event.transcriptPayload.id] = event.transcriptPayload;
      return;
    case 'subagent_run.updated': {
      state.subagents ??= {};
      const run = state.subagents[event.subagentRunId];
      if (!run) return;
      const currentIsTerminal = run.status !== 'running';
      const incomingIsRunning = event.status === 'running';
      if (!currentIsTerminal || !incomingIsRunning) {
        run.status = event.status;
        run.completedAt = event.completedAt;
        run.result = event.result;
        run.error = event.error;
      }
      run.updatedAt = event.createdAt;
      run.transcriptPayloadId = event.transcriptPayload?.id ?? run.transcriptPayloadId;
      run.transcriptMessageCount = event.transcriptMessageCount;
      if (event.transcriptPayload) state.payloads[event.transcriptPayload.id] = event.transcriptPayload;
      return;
    }
    case 'payload.created':
      state.payloads[event.payload.id] = event.payload;
      return;
    case 'payload.derived': {
      state.payloads[event.payload.id] = event.payload;
      const derived = state.derivedPayloadsBySourceId[event.sourcePayloadId] ?? [];
      state.derivedPayloadsBySourceId[event.sourcePayloadId] = [...derived, event.payload];
      return;
    }
    case 'tool_call.started':
      applyToolCallStarted(state, event);
      return;
    case 'compaction.completed':
      state.compactionsByMessageId[event.messageId] = {
        id: event.eventId,
        messageId: event.messageId,
        summary: event.summary,
        compactedThroughMessageId: event.compactedThroughMessageId,
        trigger: event.trigger,
        createdAt: event.createdAt,
      };
      return;
    case 'thinking.delta':
    case 'tool_call.delta':
    case 'tool_call.completed':
    case 'tool_call.failed':
    case 'tool.permission.checked':
    case 'tool.permission.resolved':
    case 'user_question.requested':
    case 'user_question.answered':
    case 'user_question.cancelled':
    case 'widget_state.updated':
    case 'approval.requested':
    case 'approval.resolved':
    case 'follow_up.queued':
    case 'follow_up.applied':
    case 'task.created':
    case 'task.completed':
    case 'notification.created':
    case 'config.change':
    case 'review_card.created':
    case 'skill.created':
    case 'skill.patched':
    case 'skill.replaced':
    case 'skill.enabled':
    case 'skill.disabled':
    case 'skill.rolled_back':
    case 'skill.curation.updated':
    case 'checkpoint.created':
    case 'metric.recorded':
      return;
  }
}

function touchSessionUpdatedAt(state: AgentEventReplayState, event: AgentEvent) {
  if (!state.session) return;
  state.session.updatedAt = Math.max(state.session.updatedAt, event.createdAt);
}

function addMessage(state: AgentEventReplayState, message: AgentEventMessageRecord) {
  if (state.messages[message.id]) {
    throw new Error(`Duplicate agent message id: ${message.id}`);
  }
  if (message.parentMessageId && !state.messages[message.parentMessageId]) {
    throw new Error(`Missing parent agent message: ${message.parentMessageId}`);
  }
  state.messages[message.id] = message;
  if (message.parentMessageId) {
    const siblings = state.childrenByParentId[message.parentMessageId] ?? [];
    state.childrenByParentId[message.parentMessageId] = [...siblings, message.id];
  } else {
    state.rootMessageIds = [...state.rootMessageIds, message.id];
  }
  state.latestMessageId = message.id;
}

function appendVisibleTranscriptEntry(
  state: AgentEventReplayState,
  entries: AgentEventVisibleTranscriptEntry[],
  expandingCompactions: Set<string>,
  message: AgentEventMessageRecord,
  archived: boolean,
) {
  const compaction = message.role === 'user' ? state.compactionsByMessageId[message.id] ?? null : null;
  if (compaction && !expandingCompactions.has(compaction.messageId)) {
    expandingCompactions.add(compaction.messageId);
    for (const compactedMessage of pathToMessage(state, compaction.compactedThroughMessageId)) {
      if (compactedMessage.id === message.id) continue;
      appendVisibleTranscriptEntry(state, entries, expandingCompactions, compactedMessage, true);
    }
    expandingCompactions.delete(compaction.messageId);
  }

  entries.push({ message, archived });
}

function pathToMessage(
  state: AgentEventReplayState,
  leafMessageId: string,
): AgentEventMessageRecord[] {
  const path: AgentEventMessageRecord[] = [];
  const visited = new Set<string>();
  let cursorId: string | null = leafMessageId;
  while (cursorId) {
    if (visited.has(cursorId)) return path.reverse();
    visited.add(cursorId);
    const message: AgentEventMessageRecord | undefined = state.messages[cursorId];
    if (!message) return path.reverse();
    path.push(message);
    cursorId = message.parentMessageId;
  }
  return path.reverse();
}

function requireSession(state: AgentEventReplayState, event: AgentEvent) {
  if (!state.session) {
    throw new Error(`Agent event requires session.created first: ${event.type}`);
  }
}

function requireMessage(state: AgentEventReplayState, messageId: string): AgentEventMessageRecord {
  const message = state.messages[messageId];
  if (!message) throw new Error(`Missing agent message: ${messageId}`);
  return message;
}

function parentRunId(state: AgentEventReplayState, parentMessageId: string | null): string | undefined {
  return parentMessageId ? state.messages[parentMessageId]?.runId : undefined;
}

function applyContentDelta(message: AgentEventMessageRecord, delta: AgentContentDelta) {
  if (delta.type !== 'text_delta') return;
  const last = message.content.at(-1);
  if (last?.type === 'text') {
    message.content = [
      ...message.content.slice(0, -1),
      { type: 'text', text: `${last.text}${delta.text}` },
    ];
    return;
  }
  message.content = [...message.content, { type: 'text', text: delta.text }];
}

function applyToolCallStarted(state: AgentEventReplayState, event: ToolCallStartedEvent) {
  const message = requireMessage(state, event.messageId);
  if (message.role !== 'assistant') throw new Error(`Cannot attach tool call to ${message.role} message`);
  const alreadyExists = message.content.some((part) => part.type === 'toolCall' && part.id === event.toolCallId);
  if (alreadyExists) return;
  message.content = [
    ...message.content,
    {
      type: 'toolCall',
      id: event.toolCallId,
      name: event.name,
      arguments: event.args ?? {},
    },
  ];
  message.updatedAt = event.createdAt;
}

function toPiUserContent(content: AgentPersistedContent[]): UserMessage['content'] {
  const parts = toPiContentParts(content);
  return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
}

function toPiAssistantContent(content: AgentPersistedContent[]): AssistantMessage['content'] {
  return content
    .flatMap((part): Array<TextContent | ThinkingContent | ToolCall> => {
      if (part.type === 'text') return [{ type: 'text', text: part.text }];
      if (part.type === 'thinking') return [{ type: 'thinking', thinking: part.thinking, redacted: part.redacted }];
      if (part.type === 'toolCall') {
        return [{
          type: 'toolCall',
          id: part.id,
          name: part.name,
          arguments: part.arguments,
        }];
      }
      return [];
    });
}

function toPiContentPart(content: AgentPersistedContent): Array<TextContent | ImageContent> {
  if (content.type === 'text') return [{ type: 'text', text: content.text }];
  if (content.type === 'image') {
    return [{
      type: 'text',
      text: content.alt || content.imageRef.summary || `[image:${content.imageRef.id}]`,
    }];
  }
  if (content.type === 'thinking') return [{ type: 'text', text: content.thinking }];
  if (content.type === 'toolCall') return [{ type: 'text', text: `[tool:${content.name}]` }];
  return [{
    type: 'text',
    text: content.label || content.payload.summary || `[payload:${content.payload.id}]`,
  }];
}

function toPiContentParts(content: AgentPersistedContent[]): Array<TextContent | ImageContent> {
  const parts = content.flatMap(toPiContentPart);
  return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
}

function cloneContent(content: AgentPersistedContent[]): AgentPersistedContent[] {
  return content.map((part) => {
    if (part.type === 'text') return { ...part };
    if (part.type === 'thinking') return { ...part };
    if (part.type === 'toolCall') return { ...part, arguments: { ...part.arguments } };
    if (part.type === 'image') return { ...part, imageRef: { ...part.imageRef, display: part.imageRef.display ? { ...part.imageRef.display } : undefined } };
    return { ...part, payload: { ...part.payload, display: part.payload.display ? { ...part.payload.display } : undefined } };
  });
}

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};
