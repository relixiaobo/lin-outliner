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

export type AgentPermissionDeniedReason =
  | 'configured_deny'
  | 'policy_denied'
  | 'classifier_blocked'
  | 'classifier_unavailable'
  | 'platform_hard_block'
  | 'run_aborted'
  | 'runtime'
  | 'user_denied';

export type AgentToolPermissionEventSource =
  | 'global_rule'
  | 'action_default'
  | 'safety_mode_profile'
  | 'trust_ledger'
  | 'configured_deny'
  | 'policy_denied'
  | 'classifier'
  | 'classifier_unavailable'
  | 'safe_allowlist'
  | 'user'
  | 'platform_hard_block'
  | 'runtime';

export type AgentToolPermissionResolvedBy =
  | 'classifier'
  | 'safe_allowlist'
  | 'safety_mode_profile'
  | 'trust_ledger'
  | 'user_once'
  | 'allow_rule_update'
  | 'global_rule'
  | 'configured_deny'
  | 'policy_denied'
  | 'classifier_unavailable'
  | 'platform_hard_block'
  | 'runtime'
  | 'system_abort';

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
// logs while the current flat conversation event log remains the runtime format below.
export type AgentSourceKind = 'built-in' | 'user' | 'project';
export type AgentId = `${AgentSourceKind}:${string}:${string}`;

export type AgentPrincipal =
  | { type: 'user'; userId: string }
  | { type: 'agent'; agentId: string };

/**
 * Stable string key for a principal: `user:<userId>` / `agent:<agentId>`. Used
 * as a Map/Record key and stored in derived indexes; it is NOT an on-disk path
 * segment — every principal's pool directory lives under `principals/` with a
 * filesystem-encoded name (`agent-<agentId>` / `user-<userId>`), resolved by
 * the store's `memoryPaths`.
 */
export function principalKey(principal: AgentPrincipal): string {
  return principal.type === 'user' ? `user:${principal.userId}` : `agent:${principal.agentId}`;
}

export function samePrincipal(left: AgentPrincipal, right: AgentPrincipal): boolean {
  return principalKey(left) === principalKey(right);
}

/** Merge principal lists, deduplicated by key, preserving first-seen order. */
export function mergeUniquePrincipals(
  current: readonly AgentPrincipal[],
  next: readonly AgentPrincipal[],
): AgentPrincipal[] {
  const byKey = new Map<string, AgentPrincipal>();
  for (const principal of [...current, ...next]) byKey.set(principalKey(principal), principal);
  return [...byKey.values()];
}

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

export type AgentRunKind = 'turn' | 'background' | 'delegation' | 'scheduled' | 'reflective';
export type AgentRunRetention = 'hot' | 'cold-archived' | 'summarized-only' | 'deleted';

export type AgentRunTrigger =
  | { type: 'message'; messageId: string }
  | { type: 'node'; nodeId: string }
  | { type: 'parent-run'; parentRunId: string }
  | { type: 'schedule'; schedule: string; dueAt?: number }
  | { type: 'manual' | 'system' };

export interface AgentRunFingerprint {
  appVersion: string;
  promptHash: string;
  toolSchemaHash: string;
  skillBindings: string[];
  modelConfig: string;
}

/**
 * Where a run's record belongs. A conversation anchor places the run in a conversation's
 * timeline. A principal anchor marks a reflective run as maintaining that principal's pool
 * (its self-model) — the SUBJECT of the maintenance, not the executor. `AgentRunMeta.agentId`
 * stays the executor; the two are different questions and different fields ([[agent-data-model]]
 * §4: the user-Dream is executed by the main agent but maintains the user principal's pool).
 */
export type AgentRunAnchor =
  | { type: 'conversation'; agentId: AgentId; conversationId: string }
  | { type: 'principal'; principal: AgentPrincipal };

export interface AgentRunMeta {
  id: string;
  /** The executing agent (whose runtime/model ran this) — NOT the anchor subject. */
  agentId: AgentId;
  anchor: AgentRunAnchor;
  parentRunId?: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  trigger: AgentRunTrigger;
  usage?: Usage;
  fingerprint: AgentRunFingerprint;
  retention: AgentRunRetention;
  createdAt: number;
}

export function conversationIdOfRun(run: Pick<AgentRunMeta, 'anchor'>): string | null {
  return run.anchor.type === 'conversation' ? run.anchor.conversationId : null;
}

/**
 * The agent named by an anchor, when it names one. `AgentPrincipal.agentId` is a
 * plain string by design (principals outlive any one id scheme), so the cast back
 * to `AgentId` mirrors the store's `asAgentId` — neither validates the template
 * format; ids are trusted at the write site.
 */
export function agentIdOfRunAnchor(anchor: AgentRunAnchor): AgentId | undefined {
  if (anchor.type === 'conversation') return anchor.agentId;
  return anchor.principal.type === 'agent' ? anchor.principal.agentId as AgentId : undefined;
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
  attachmentId?: string;
  entryKind?: 'file' | 'directory';
  mimeType?: string;
  name?: string;
  path?: string;
  ref?: string;
  sizeBytes?: number;
  label?: string;
  payload?: AgentPayloadRef;
}

export interface AgentUserQuestionAttachment {
  id?: string;
  kind: 'image' | 'text' | 'file';
  ref?: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  path?: string;
  dataBase64?: string;
  text?: string;
  truncated?: boolean;
  payload?: AgentPayloadRef;
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
  outcome?: 'answered' | 'discussed';
  answers: AgentUserQuestionAnswer[];
  discuss?: {
    message: string;
  };
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
      source: AgentToolPermissionEventSource;
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
      resolvedBy: AgentToolPermissionResolvedBy;
      updatedRule?: string;
      deniedReason?: AgentPermissionDeniedReason;
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

export interface AgentMemorySourceRange {
  fromSeqExclusive: number;
  throughSeq: number;
  throughEventId: string | null;
}

/**
 * Provenance down-pointer from the episodic layer into the raw record. A stream
 * source names one conversation or run ledger plus a stable seq/event range in
 * that stream's own coordinate space ([[agent-memory-realignment]] D-5).
 */
export interface AgentMemoryStreamSource {
  stream: 'conversation' | 'run';
  streamId: string;
  range: AgentMemorySourceRange;
}

export interface AgentMemoryEpisodeSource {
  episodeId: string;
}

export type AgentMemorySource = AgentMemoryStreamSource | AgentMemoryEpisodeSource;

export interface AgentMemoryEpisode {
  id: string;
  principal: AgentPrincipal;
  gist: string;
  originWorkspace?: string;
  sources: AgentMemoryStreamSource[];
  createdAt: number;
}

export interface AgentMemoryEntry {
  id: string;
  /**
   * The pool this fact lives in — its owner/believer (whose self-model), and therefore the
   * fact's elided subject ([[agent-memory-realignment]] D-1). NOT "any subject the fact is
   * about": a believer's knowledge of others lives in the believer's own pool as relational
   * facts; the write paths have always been believer-keyed.
   */
  principal: AgentPrincipal;
  fact: string;
  originWorkspace?: string;
  sources: AgentMemorySource[];
  status: 'active' | 'invalidated';
  createdAt: number;
}

export type AgentMemoryAccessVia = 'briefing' | 'recall';

export interface AgentMemoryAccessedEntry {
  entryId: string;
  /**
   * Live access events use count=1; compaction can fold older access events into
   * the same shape without inventing stored strength fields on MemoryEntry.
   */
  count: number;
  /** Defaults to the event createdAt; compaction sets the per-entry last access time. */
  accessedAt?: number;
}

export type AgentDreamTrigger = 'schedule' | 'manual';

/**
 * ONE consolidation-frontier cursor shape for every stream (a conversation log
 * or a delegated run's ledger): the last digested `{seq, eventId}` in that
 * stream's own seq space. The positional `{messageCount, payloadId}` agent-run
 * variant died with the transcript-snapshot representation (run unification).
 */
export interface AgentDreamWatermarkCursor {
  seq: number;
  eventId: string | null;
}

export interface AgentDreamWatermark {
  conversations: Record<string, AgentDreamWatermarkCursor>;
  /** Delegated-run ledgers, keyed by runId. */
  runs?: Record<string, AgentDreamWatermarkCursor>;
}

export interface AgentDreamProcessedConversation {
  fromSeqExclusive: number;
  throughSeq: number;
  throughEventId: string | null;
  messageCount: number;
  charCount: number;
}

export interface AgentDreamProcessedRun {
  conversationId: string;
  fromSeqExclusive: number;
  throughSeq: number;
  throughEventId: string | null;
  messageCount: number;
  charCount: number;
}

export interface AgentDreamCompletedChanges {
  added: number;
  updated: number;
  forgotten: number;
  skipped: number;
}

export interface AgentMemoryEventBase {
  v: typeof AGENT_EVENT_VERSION;
  eventId: string;
  seq: number;
  /** Identifies the pool this event belongs to (the subject's self-model). */
  principal: AgentPrincipal;
  type: AgentMemoryEventType;
  createdAt: number;
}

export type AgentMemoryEventType =
  | 'memory.episode_recorded'
  | 'memory.entry_added'
  | 'memory.entry_updated'
  | 'memory.entry_removed'
  | 'memory.accessed'
  | 'dream.completed';

export type AgentMemoryEvent =
  | (AgentMemoryEventBase & { type: 'memory.episode_recorded'; episode: AgentMemoryEpisode })
  | (AgentMemoryEventBase & { type: 'memory.entry_added'; entry: AgentMemoryEntry })
  | (AgentMemoryEventBase & {
      type: 'memory.entry_updated';
      entryId: string;
      patch: Partial<Pick<AgentMemoryEntry, 'fact' | 'sources' | 'status' | 'originWorkspace'>>;
    })
  | (AgentMemoryEventBase & { type: 'memory.entry_removed'; entryId: string; reason?: string })
  | (AgentMemoryEventBase & {
      type: 'memory.accessed';
      via: AgentMemoryAccessVia;
      accesses: AgentMemoryAccessedEntry[];
    })
  | (AgentMemoryEventBase & {
      type: 'dream.completed';
      dreamId: string;
      runId: string;
      trigger: AgentDreamTrigger;
      startedAt: number;
      completedAt: number;
      watermark: AgentDreamWatermark;
      processed: {
        conversations: Record<string, AgentDreamProcessedConversation>;
        runs?: Record<string, AgentDreamProcessedRun>;
        totalMessageCount: number;
        totalCharCount: number;
        consolidateOnly: boolean;
      };
      changes: AgentDreamCompletedChanges;
    });

export interface AgentTextDelta {
  type: 'text_delta';
  text: string;
}

export type AgentContentDelta = AgentTextDelta;

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type AgentMessageStatus = 'completed' | 'streaming' | 'failed';
export type AgentChildRunStatus = 'running' | 'completed' | 'failed' | 'stopped';
export type AgentCompactionTrigger = 'manual' | 'auto' | 'reactive';

export type AgentEventType =
  | 'conversation.created'
  | 'conversation.renamed'
  | 'conversation.settings_changed'
  | 'debug.snapshot.created'
  | 'branch.selected'
  | 'member.added'
  | 'member.removed'
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
  | 'notification.read'
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
  | 'child_run.started'
  | 'child_run.updated'
  | 'compaction.completed'
  | 'dream.finished'
  | 'payload.created'
  | 'payload.derived'
  | 'checkpoint.created'
  | 'metric.recorded';

export interface AgentEventBase {
  v: typeof AGENT_EVENT_VERSION;
  eventId: string;
  seq: number;
  conversationId: string;
  type: AgentEventType;
  createdAt: number;
  actor: AgentActor;
  runId?: string;
  turnId?: string;
  messageId?: string;
  parentMessageId?: string | null;
  causedByEventId?: string;
}

export interface ConversationCreatedEvent extends AgentEventBase {
  type: 'conversation.created';
  title: string | null;
  members?: AgentPrincipal[];
  goal?: string;
}

export interface ConversationRenamedEvent extends AgentEventBase {
  type: 'conversation.renamed';
  title: string | null;
  goal?: string;
}

export interface ConversationSettingsChangedEvent extends AgentEventBase {
  type: 'conversation.settings_changed';
  settings: Record<string, unknown>;
}

/**
 * Conversation membership change. Replays into `conversation.members`; idempotent by
 * `principalKey` (adding an existing member or removing an absent one is a no-op,
 * so a crash-retried append cannot corrupt the roster).
 */
export interface MemberChangedEvent extends AgentEventBase {
  type: 'member.added' | 'member.removed';
  member: AgentPrincipal;
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
  /**
   * The principals this turn addresses ([[agent-conversation-model]] routing rule:
   * a run is produced iff a principal is in `addressedTo`). Written by the runtime
   * router in multi-agent Channels; absent in DMs (single implicit addressee).
   */
  addressedTo?: AgentPrincipal[];
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
  /**
   * Hand-off routing record: the members this reply `@`-addressed (Channel
   * relay). Written at completion so the routing decision is in the durable
   * log, not only re-derivable from text.
   */
  addressedTo?: AgentPrincipal[];
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
  source: AgentToolPermissionEventSource;
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
  resolvedBy: AgentToolPermissionResolvedBy;
  updatedRule?: string;
  deniedReason?: AgentPermissionDeniedReason;
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

export type AgentNotificationKind =
  // Off-floor task terminal states — the only kinds with an emitter today.
  | 'task_completed'
  | 'task_failed'
  // Reserved (no emitter yet): a conversation's own *foreground* agent awaiting a
  // user decision while the user is elsewhere. Delegated child runs never ask the
  // user mid-execution, so there is deliberately no child-run→user needs_input trigger.
  | 'needs_input'
  // Reserved (no emitter yet): a cheap no-LLM progress post for a long task.
  | 'status';

/**
 * Provenance for a notification: the off-floor run whose terminal state (or
 * needs-input pause) produced it. Orthogonal to the delivery anchor
 * (`conversationId`) — a run anchored to conversation X still reports there.
 * One variant only: a delegated child run IS a run (run unification).
 */
export type AgentTaskSource = { type: 'run'; runId: string };

/**
 * Delivered to its origin conversation: the base `conversationId` IS the
 * delivery anchor (a background run always anchors to a delivery conversation —
 * there are no conversation-less notifications).
 */
export interface NotificationCreatedEvent extends AgentEventBase {
  type: 'notification.created';
  notificationId: string;
  kind: AgentNotificationKind;
  title: string;
  body?: string;
  /** The off-floor run that produced this notification, when any. */
  source?: AgentTaskSource;
}

/**
 * Durable attention-clear. Marks every `notification.created` in the base
 * `conversationId` with `seq <= throughSeq` as read. A conversation's unread
 * count is the number of its notifications with `seq > lastReadThroughSeq` —
 * folded per conversation, restart-safe, cleared when the user opens the
 * conversation.
 */
export interface NotificationReadEvent extends AgentEventBase {
  type: 'notification.read';
  throughSeq: number;
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
  source: AgentSourceKind;
  summary?: string;
  payloadRef?: AgentPayloadRef;
}

export interface RunStartedEvent extends AgentEventBase {
  type: 'run.started';
  runId: string;
  agentId?: AgentId;
  anchor?: AgentRunAnchor;
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

/**
 * Conversation-log lifecycle marker for a delegated (child) run — the slim
 * projection feed for the boundary row + task panel. The child's transcript
 * lives in its OWN run ledger (`runs/<childRunId>/events.jsonl`, replayed
 * alone); there is no transcript snapshot, message count, or evidence
 * boundary here (run unification — the boundary is `run.started`'s seq in
 * the child ledger).
 */
export interface ChildRunStartedEvent extends AgentEventBase {
  type: 'child_run.started';
  childRunId: string;
  /** The run that delegated this one — the parent side of the run tree. */
  parentRunId?: string;
  parentToolCallId?: string;
  executingAgentId?: AgentId | string;
  parentAgentId?: AgentId | string;
  memoryOwnerAgentId?: AgentId | string;
  memoryOriginWorkspace?: string;
  name?: string;
  description: string;
  prompt: string;
  agentType: string;
  contextMode: 'fresh' | 'fork';
}

export interface ChildRunUpdatedEvent extends AgentEventBase {
  type: 'child_run.updated';
  childRunId: string;
  status: AgentChildRunStatus;
  completedAt?: number;
  result?: string;
  error?: string;
}

export interface CompactionCompletedEvent extends AgentEventBase {
  type: 'compaction.completed';
  messageId: string;
  summary: string;
  source: AgentCompactionSourceRange;
  trigger: AgentCompactionTrigger;
}

export type AgentDreamMarkerStatus = 'completed' | 'failed' | 'skipped';

export interface DreamFinishedEvent extends AgentEventBase {
  type: 'dream.finished';
  messageId: string;
  agentId: string;
  runId?: string;
  trigger: AgentDreamTrigger;
  status: AgentDreamMarkerStatus;
  startedAt: number;
  completedAt: number;
  processed?: Extract<AgentMemoryEvent, { type: 'dream.completed' }>['processed'];
  changes?: AgentDreamCompletedChanges;
  errorMessage?: string;
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
  | ConversationCreatedEvent
  | ConversationRenamedEvent
  | ConversationSettingsChangedEvent
  | MemberChangedEvent
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
  | NotificationReadEvent
  | ConfigChangeEvent
  | ReviewCardCreatedEvent
  | SkillAuditEvent
  | RunStartedEvent
  | RunTerminalEvent
  | ChildRunStartedEvent
  | ChildRunUpdatedEvent
  | CompactionCompletedEvent
  | DreamFinishedEvent
  | PayloadCreatedEvent
  | PayloadDerivedEvent
  | CheckpointCreatedEvent
  | MetricRecordedEvent;

export interface AgentConversationRecord {
  id: string;
  title: string | null;
  members: AgentPrincipal[];
  goal?: string;
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
  addressedTo?: AgentPrincipal[];
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

/**
 * Conversation-level record of a delegated (child) run — the projection the
 * boundary row + task panel read. The transcript is NOT here: it lives in the
 * child's own run ledger, replayed independently (run unification).
 */
export interface AgentChildRunRecord {
  id: string;
  name?: string;
  description: string;
  prompt: string;
  agentType: string;
  contextMode: 'fresh' | 'fork';
  parentRunId?: string;
  executingAgentId?: string;
  parentAgentId?: string;
  memoryOwnerAgentId?: string;
  memoryOriginWorkspace?: string;
  status: AgentChildRunStatus;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  parentToolCallId?: string;
}

export interface AgentCompactionRecord {
  id: string;
  messageId: string;
  summary: string;
  source: AgentCompactionSourceRange;
  trigger: AgentCompactionTrigger;
  createdAt: number;
}

export interface AgentDreamRecord {
  id: string;
  messageId: string;
  agentId: string;
  runId?: string;
  trigger: AgentDreamTrigger;
  status: AgentDreamMarkerStatus;
  startedAt: number;
  completedAt: number;
  processed?: Extract<AgentMemoryEvent, { type: 'dream.completed' }>['processed'];
  changes?: AgentDreamCompletedChanges;
  errorMessage?: string;
  createdAt: number;
}

export interface AgentCompactionSourceRange {
  fromMessageId: string;
  throughMessageId: string;
}

export interface AgentUserQuestionRecord {
  requestId: string;
  runId: string;
  toolCallId: string;
  request: AgentUserQuestionRequestView;
  status: 'pending' | 'answered' | 'cancelled';
  result?: AskUserQuestionResult;
  reason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentNotificationRecord {
  notificationId: string;
  conversationId: string;
  kind: AgentNotificationKind;
  title: string;
  body?: string;
  source?: AgentTaskSource;
  seq: number;
  createdAt: number;
  read: boolean;
}

export interface AgentConversationAttention {
  conversationId: string;
  unreadCount: number;
  lastReadThroughSeq: number;
}

export interface AgentEventReplayState {
  conversation: AgentConversationRecord | null;
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
  childRuns: Record<string, AgentChildRunRecord>;
  compactionsByMessageId: Record<string, AgentCompactionRecord>;
  dreamsByMessageId: Record<string, AgentDreamRecord>;
  userQuestions: Record<string, AgentUserQuestionRecord>;
  notifications: Record<string, AgentNotificationRecord>;
  attentionByConversationId: Record<string, AgentConversationAttention>;
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
    conversation: null,
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
    childRuns: {},
    compactionsByMessageId: {},
    dreamsByMessageId: {},
    userQuestions: {},
    notifications: {},
    attentionByConversationId: {},
  };
}

export function replayAgentEvents(events: readonly AgentEvent[]): AgentEventReplayState {
  const state = createEmptyAgentEventReplayState();
  const seenEventIds = new Set<string>();
  for (const event of events) {
    assertValidNextEvent(state, seenEventIds, event);
    applyAgentEvent(state, event);
    touchConversationUpdatedAt(state, event);
    seenEventIds.add(event.eventId);
    state.latestSeq = event.seq;
    state.latestEventId = event.eventId;
  }
  return state;
}

export function appendAgentEventToReplayState(state: AgentEventReplayState, event: AgentEvent): AgentEventReplayState {
  assertValidNextEvent(state, new Set(), event);
  applyAgentEvent(state, event);
  touchConversationUpdatedAt(state, event);
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
  if (state.conversation && event.conversationId !== state.conversation.id) {
    throw new Error(`Agent event conversation mismatch: ${event.conversationId}`);
  }
}

function applyAgentEvent(state: AgentEventReplayState, event: AgentEvent) {
  switch (event.type) {
    case 'conversation.created':
      state.conversation = {
        id: event.conversationId,
        title: event.title,
        members: event.members?.slice() ?? [],
        goal: event.goal,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        settings: {},
      };
      return;
    case 'conversation.renamed':
      requireConversation(state, event);
      state.conversation!.title = event.title;
      state.conversation!.goal = event.goal ?? state.conversation!.goal;
      state.conversation!.updatedAt = event.createdAt;
      return;
    case 'conversation.settings_changed':
      requireConversation(state, event);
      state.conversation!.settings = { ...state.conversation!.settings, ...event.settings };
      state.conversation!.updatedAt = event.createdAt;
      return;
    case 'member.added': {
      requireConversation(state, event);
      const conversation = state.conversation!;
      const key = principalKey(event.member);
      if (!conversation.members.some((member) => principalKey(member) === key)) {
        conversation.members = [...conversation.members, event.member];
      }
      conversation.updatedAt = event.createdAt;
      return;
    }
    case 'member.removed': {
      requireConversation(state, event);
      const conversation = state.conversation!;
      const key = principalKey(event.member);
      conversation.members = conversation.members.filter((member) => principalKey(member) !== key);
      conversation.updatedAt = event.createdAt;
      return;
    }
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
        addressedTo: event.addressedTo?.slice(),
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
      if (event.addressedTo) message.addressedTo = event.addressedTo.slice();
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
        agentId: event.agentId ?? (event.anchor ? agentIdOfRunAnchor(event.anchor) : undefined),
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
    case 'child_run.started':
      state.childRuns ??= {};
      state.childRuns[event.childRunId] = {
        id: event.childRunId,
        name: event.name,
        description: event.description,
        prompt: event.prompt,
        agentType: event.agentType,
        contextMode: event.contextMode,
        parentRunId: event.parentRunId,
        executingAgentId: event.executingAgentId,
        parentAgentId: event.parentAgentId,
        memoryOwnerAgentId: event.memoryOwnerAgentId,
        memoryOriginWorkspace: event.memoryOriginWorkspace,
        status: 'running',
        startedAt: event.createdAt,
        updatedAt: event.createdAt,
        parentToolCallId: event.parentToolCallId,
      };
      return;
    case 'child_run.updated': {
      state.childRuns ??= {};
      const run = state.childRuns[event.childRunId];
      if (!run) return;
      // Markers are applied in seq order, so a terminal→running transition at a
      // later seq IS the resume of a detached run (agentDelegation `send`) —
      // dropping it would hide the resumed run from Dream's running-skip,
      // crash-recovery's interrupted scan, and the projection.
      run.status = event.status;
      run.completedAt = event.completedAt;
      run.result = event.result;
      run.error = event.error;
      run.updatedAt = event.createdAt;
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
        source: event.source,
        trigger: event.trigger,
        createdAt: event.createdAt,
      };
      return;
    case 'dream.finished':
      state.dreamsByMessageId[event.messageId] = {
        id: event.eventId,
        messageId: event.messageId,
        agentId: event.agentId,
        runId: event.runId,
        trigger: event.trigger,
        status: event.status,
        startedAt: event.startedAt,
        completedAt: event.completedAt,
        processed: event.processed,
        changes: event.changes,
        errorMessage: event.errorMessage,
        createdAt: event.createdAt,
      };
      return;
    case 'thinking.delta':
    case 'tool_call.delta':
    case 'tool_call.completed':
    case 'tool_call.failed':
    case 'tool.permission.checked':
    case 'tool.permission.resolved':
    case 'widget_state.updated':
    case 'approval.requested':
    case 'approval.resolved':
    case 'follow_up.queued':
    case 'follow_up.applied':
    case 'task.created':
    case 'task.completed':
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
    case 'user_question.requested':
      state.userQuestions[event.requestId] = {
        requestId: event.requestId,
        runId: event.runId,
        toolCallId: event.toolCallId,
        request: event.request,
        status: 'pending',
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      };
      return;
    case 'user_question.answered': {
      const question = state.userQuestions[event.requestId];
      if (!question) return;
      question.status = 'answered';
      question.result = event.result;
      question.updatedAt = event.createdAt;
      return;
    }
    case 'user_question.cancelled': {
      const question = state.userQuestions[event.requestId];
      if (!question) return;
      question.status = 'cancelled';
      question.reason = event.reason;
      question.updatedAt = event.createdAt;
      return;
    }
    case 'notification.created': {
      if (state.notifications[event.notificationId]) return;
      const attention = ensureConversationAttention(state, event.conversationId);
      const read = event.seq <= attention.lastReadThroughSeq;
      state.notifications[event.notificationId] = {
        notificationId: event.notificationId,
        conversationId: event.conversationId,
        kind: event.kind,
        title: event.title,
        body: event.body,
        source: event.source,
        seq: event.seq,
        createdAt: event.createdAt,
        read,
      };
      if (!read) attention.unreadCount += 1;
      return;
    }
    case 'notification.read': {
      const attention = ensureConversationAttention(state, event.conversationId);
      attention.lastReadThroughSeq = Math.max(attention.lastReadThroughSeq, event.throughSeq);
      let unread = 0;
      for (const record of Object.values(state.notifications)) {
        if (record.conversationId !== event.conversationId) continue;
        if (record.seq <= attention.lastReadThroughSeq) record.read = true;
        else unread += 1;
      }
      attention.unreadCount = unread;
      return;
    }
  }
}

function ensureConversationAttention(
  state: AgentEventReplayState,
  conversationId: string,
): AgentConversationAttention {
  let attention = state.attentionByConversationId[conversationId];
  if (!attention) {
    attention = { conversationId, unreadCount: 0, lastReadThroughSeq: 0 };
    state.attentionByConversationId[conversationId] = attention;
  }
  return attention;
}

function touchConversationUpdatedAt(state: AgentEventReplayState, event: AgentEvent) {
  if (!state.conversation) return;
  // Off-floor attention bookkeeping is not conversation activity: a background
  // notification arriving (or being read) must not reorder the conversation list
  // or change its displayed timestamp. Only genuine content/state events touch it.
  if (event.type === 'notification.created' || event.type === 'notification.read') return;
  state.conversation.updatedAt = Math.max(state.conversation.updatedAt, event.createdAt);
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
    for (const compactedMessage of pathRangeToMessage(state, compaction.source)) {
      if (compactedMessage.id === message.id) continue;
      appendVisibleTranscriptEntry(state, entries, expandingCompactions, compactedMessage, true);
    }
    expandingCompactions.delete(compaction.messageId);
  }

  entries.push({ message, archived });
}

function pathRangeToMessage(
  state: AgentEventReplayState,
  source: AgentCompactionSourceRange,
): AgentEventMessageRecord[] {
  const path = pathToMessage(state, source.throughMessageId);
  const startIndex = path.findIndex((message) => message.id === source.fromMessageId);
  return startIndex >= 0 ? path.slice(startIndex) : path;
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

function requireConversation(state: AgentEventReplayState, event: AgentEvent) {
  if (!state.conversation) {
    throw new Error(`Agent event requires conversation.created first: ${event.type}`);
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
