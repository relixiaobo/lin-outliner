import { app, type BrowserWindow } from 'electron';
import {
  Agent,
  type AfterToolCallResult,
  type AgentEvent as PiAgentEvent,
  type AgentLoopTurnUpdate,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import {
  // pi-ai's own vocabulary: per-"session" provider resources, keyed by our conversation id.
  cleanupSessionResources as cleanupPiConversationResources,
  completeSimple,
  createAssistantMessageEventStream,
  getModels,
  getSupportedThinkingLevels,
  isContextOverflow,
  streamSimple,
} from '@earendil-works/pi-ai';
import type {
  Api,
  AssistantMessage,
  ImageContent as PiImageContent,
  KnownProvider,
  Message,
  Model,
  ProviderResponse,
  SimpleStreamOptions,
  TextContent as PiTextContent,
  ToolCall,
  ToolResultMessage,
} from '@earendil-works/pi-ai';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  type AgentFileAttachmentInput,
  type AgentUserQuestionPendingView,
  LIN_AGENT_EVENT_CHANNEL,
  type AgentImageAttachmentInput,
  type AgentMessageAttachmentInput,
  type AgentDebugSnapshot,
  type AgentDebugTotals,
  type AgentMessage,
  type AgentRuntimeEvent,
  type AgentApprovalRequestView,
  type AgentApprovalResolutionScope,
  type AgentAuthoringInput,
  type AgentDefinitionView,
  type AgentStorageLocation,
  type AgentUserViewContext,
  type AskUserQuestionResult,
  type ImageContent,
  type TextContent,
  type Usage,
  type UserMessage,
} from '../core/agentTypes';
import {
  AGENT_EVENT_VERSION,
  appendAgentEventToReplayState,
  createEmptyAgentEventReplayState,
  getAgentEventActivePath,
  getAgentEventRuntimeTranscriptPath,
  mergeUniquePrincipals,
  principalKey,
  samePrincipal,
  type AgentActor,
  type AgentId,
  type AgentCompactionSourceRange,
  type AgentCompactionTrigger,
  type AgentDreamCompletedChanges,
  type AgentDreamMarkerStatus,
  type AgentDreamTrigger,
  type AgentDreamWatermark,
  type AgentEvent,
  type AgentEventMessageRecord,
  type AgentEventReplayState,
  type AgentIdentityRecord,
  type AgentMemoryEntry,
  type AgentMemoryEvent,
  type AgentNotificationKind,
  type AgentTaskSource,
  type AgentPayloadRef,
  type AgentPersistedContent,
  type AgentPrincipal,
  type AgentRunFingerprint,
  type AgentRunTrigger,
  type AgentRunMeta,
  type AgentSubagentRunRecord,
  type AgentUserQuestionAnswer,
  type AgentUserQuestionRequestView,
} from '../core/agentEventLog';
import {
  agentMentionToken,
  channelAgentMembers,
  channelMessageOwner,
  cutChannelPathForRun,
  flattenAgentPathForPov,
  handOffTargets,
  isMultiAgentConversation,
  parseAgentMentionTargets,
} from '../core/agentChannel';
import {
  nodeReferenceMarkersToText,
  rewriteFileReferenceMarkerPaths,
  richTextToReferenceMarkup,
  sanitizeFileReferenceRef,
} from '../core/referenceMarkup';
import { serializeAgentTextAttachment, systemReminder } from '../core/agentAttachments';
import { MAX_INLINE_IMAGE_BASE64_CHARS } from '../core/agentAttachmentLimits';
import { materializePathBackedAttachment } from './agentAttachmentMaterialization';
import { agentToolResult, isToolEnvelope, successEnvelope, toolEnvelopeAfterToolCall } from './agentToolEnvelope';
import { createAgentTools, type AgentToolsOptions } from './agentTools';
import { LIN_AGENT_SYSTEM_PROMPT } from './agentSystemPrompt';
import {
  cloneDebug,
  createAgentDebugPayloadEnvelope,
  createRuntimeStateDebugSnapshot,
} from './agentDebug';
import {
  debugModelMetadata,
  deriveAgentDebugProjectionFromEvents,
  isDebugSnapshotCreatedEvent,
} from './agentDebugProjection';
import {
  AgentEventStore,
  MAX_AGENT_MEMORY_FACT_CHARS,
  type AgentDreamState,
  type AgentRunMetaProjection,
} from './agentEventStore';
import {
  buildConsolidateOnlyDreamMemoryExtractionSpan,
  buildDreamMemoryExtractionRequest,
  buildDreamMemoryExtractionSpanFromEvidence,
  buildDreamSessionId,
  memoryFactKey,
  mergeMemorySources,
  parseDreamMemoryActions,
  type DreamMemoryAction,
  type DreamMemoryExtractionAgentRunInput,
  type DreamMemoryExtractionSpan,
  type DreamMemoryExtractionSourceRange,
} from './agentDreamExtraction';
import { dreamFailureBackoffMs } from './dreamBackoff';
import { AgentDomainEventBus, type AgentDomainEvent } from './agentDomainEvents';
import { AgentPastChatsService } from './agentPastChats';
import { commandBriefText, liveCommandNodeIds, selectDueCommands, type DueCommand } from './commandScheduler';
import {
  getActiveProviderRuntimeConfig,
  getAgentRuntimeSettings,
  updateAgentRuntimeSettings,
  getProviderApiKey,
  providerStreamOptionsFromRuntimeSettings,
  type AgentProviderRuntimeConfig,
} from './agentSettings';
import { appendAgentToolPermissionAllowRule, readAgentToolPermissionConfig } from './agentToolPermissionStore';
import type { OutlinerToolHost } from './agentNodeTools';
import { AgentUserViewContextReminderTracker, buildUserViewContextReminder } from './agentUserViewContextReminder';
import {
  AgentSkillRuntime,
  createSlashSkillPrompt,
  type SkillListingReservation,
  type SkillTurnEffect,
} from './agentSkills';
import { createAgentSkillProvenanceStore } from './agentSkillProvenanceStore';
import {
  AGENT_SUBAGENT_TOOL_NAME,
  AgentSubagentRuntime,
  type AgentSubagentCreateInput,
  type AgentSubagentRestoredRun,
  type AgentSubagentRunSnapshot,
} from './agentSubagents';
import {
  agentDefinitionAgentId,
  memoryWorkspaceIdForRoot,
  resolveSubagentMemoryOwner,
} from './agentSubagentIdentity';
import {
  createAgentDefinitionFile,
  deleteAgentDefinitionFile,
  duplicateAgentDefinitionFile,
  updateAgentDefinitionFile,
} from './agentAuthoring';
import {
  createSubagentTranscriptEnvelope,
  parseSubagentTranscriptEnvelope,
  subagentDreamEvidenceStartMessageIndex,
  type SubagentTranscriptEnvelope,
} from './agentSubagentTranscript';
import type { AgentSkillWriteAudit } from './agentSkillAuthoring';
import { executeAgentSkillShellCommand } from './agentSkillShell';
import type { AgentRecallEvidence, AgentRecallRuntimeEntry, AgentRecallToolRuntime } from './agentRecallTool';
import { renderAgentMemoryBriefing, MEMORY_BRIEFING_MAX_ENTRIES } from './agentMemoryBriefing';
import {
  evaluateAgentToolPermission,
  toPermissionClassifierInput,
  type AgentPermissionAskDecision,
} from './agentPermissions';
import {
  resolveAgentPermissionAsk,
  type AgentPermissionClassifier,
  type PermissionDeniedReason,
} from './agentPermissionAskResolver';
import {
  buildPermissionClassifierContextRecords,
  createDefaultPermissionClassifier,
} from './agentPermissionClassifier';
import {
  permissionActionKinds,
  permissionDeniedReasonForDecision,
  permissionDeniedToolResultMessage,
  permissionEventSourceForDeniedReason,
  permissionEventSourceForDecision,
  permissionPrimaryActionKind,
  permissionResolutionStatusForDeniedReason,
  permissionResolvedByForAllowDecision,
  permissionResolvedByForDeniedReason,
  type AgentToolPermissionLogInput,
} from './agentPermissionEvents';
import {
  createAgentLocalWorkspaceContext,
  type AgentLocalWorkspaceContext,
} from './agentLocalTools';
import {
  assistantMessageText,
  buildCompactSummaryRequest,
  formatCompactSummary,
  parseCompactSlashCommand,
  truncateCompactMessagesForPromptTooLongRetry,
} from './agentCompaction';
import {
  createToolResultBudgetState,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  buildPersistedToolOutputMessage,
  restoreToolResultBudgetStateFromMessages,
  summarizeTextPayload,
  type ToolResultBudgetState,
} from './agentToolOutputSlimming';
import {
  AgentRuntimeContextManager,
  type AgentRuntimeActiveRunState,
  type AgentRuntimeContextEventInput,
} from './agentRuntimeContext';
import type {
  AgentDefinition,
  AgentPermissionMode,
  AgentReasoningLevel,
  AgentRuntimeSettings,
  AgentConversationListMeta,
  AgentMemoryEntryView,
  AgentSlashCommandView,
  DocumentProjection,
} from '../core/types';
import { ASK_USER_QUESTION_TOOL_NAME, type AgentAskUserQuestionRuntime } from './agentAskUserQuestionTool';
import {
  normalizeRuntimeSettingPatch,
  readRuntimeSetting,
  type AgentSelfMaintenanceRuntime,
  type DreamToolData,
  type DoctorDiagnostic,
} from './agentSelfMaintenanceTools';
import {
  buildAgentRenderProjection,
  type AgentRenderActiveCompaction,
  type AgentRenderActiveDream,
  type AgentRenderDreamTaskEntity,
  type AgentRenderTaskEntity,
  type AgentRenderTaskStatus,
} from '../core/agentRenderProjection';
import { createAbortSettledStreamFn } from './agentStreamAbort';
import { awaitWithAbort, throwIfAborted } from './agentAwaitWithAbort';
import { shouldFireDateSchedule } from '../core/dateSchedule';

const EMPTY_USAGE = {
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

const CONFIGURATION_ERROR_MODEL = {
  id: 'lin-provider-not-configured',
  name: 'Tenon Provider Not Configured',
  api: 'openai-completions',
  provider: 'lin',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 128000,
  maxTokens: 8192,
} satisfies Model<'openai-completions'>;

const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_NAME_LENGTH = 180;
const MAX_TEXT_ATTACHMENT_CHARS = 120_000;
const MAX_IMAGE_ATTACHMENT_BASE64_CHARS = MAX_INLINE_IMAGE_BASE64_CHARS;
const MAX_INLINE_TOOL_OUTPUT_CHARS = DEFAULT_MAX_TOOL_RESULT_CHARS;
const LOCAL_USER_ID = 'local-user';
const COMPACT_SUMMARY_MAX_OUTPUT_TOKENS = 20_000;
const DEFAULT_DREAM_SCHEDULE = '2026-01-01T03:00 RRULE:FREQ=DAILY';
const DREAM_MIN_VOLUME_CHARS = 1_000;
const DREAM_SCHEDULER_INTERVAL_MS = 60_000;
const COMMAND_SCHEDULER_INTERVAL_MS = 60_000;
// In-memory per-command failure backoff (openclaw-style); process-level, never
// persisted. A failed fire does not advance the watermark, so it stays due.
const COMMAND_FAILURE_BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000] as const;
// How long each `status({wait})` poll blocks while waiting for a background-flagged
// command subagent to finish (it re-polls if the run is still going).
const COMMAND_SUBAGENT_WAIT_MS = 600_000;
const SUPPORTED_INLINE_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

type CompleteSimpleFn = typeof completeSimple;

interface AgentRuntimeOptions {
  agentDataRoot?: string;
  agentIdentity?: AgentIdentityRecord;
  domainEvents?: AgentDomainEventBus;
  completeSimpleFn?: CompleteSimpleFn;
  localFileRoot?: string;
  permissionMode?: AgentPermissionMode;
  runtimeSettingsLoader?: () => Promise<AgentRuntimeSettings>;
  providerApiKeyLoader?: (providerId: string) => Promise<string | undefined> | string | undefined;
  providerConfigLoader?: () => Promise<AgentProviderRuntimeConfig | null>;
  providerModelResolver?: (providerConfig: AgentProviderRuntimeConfig) => Model<Api>;
  streamFn?: StreamFn;
  permissionClassifier?: AgentPermissionClassifier;
  dreamMemoryExtractionEnabled?: boolean;
}

interface AgentToolApprovalInput {
  requestId: string;
  toolCall: ToolCall;
  args: unknown;
  decision: AgentPermissionAskDecision;
}

interface AgentToolApprovalResolution {
  approved: boolean;
  deniedReason?: PermissionDeniedReason;
  scope?: AgentApprovalResolutionScope;
  alwaysAllowRule?: string;
}

interface AgentPendingUserQuestion {
  conversationId: string;
  runId: string;
  toolCallId: string;
  requestId: string;
  request: AgentUserQuestionRequestView;
  resolve?: (result: AskUserQuestionResult) => void;
  reject?: (error: unknown) => void;
}

interface AgentActiveRunState extends AgentRuntimeActiveRunState {
  assistantMessageId: string | null;
  assistantText: string;
  toolCallMessageIds: Map<string, string>;
  /** The agent this run executes as (a Channel peer or the main agent). */
  executingAgentId: string;
  /**
   * The message that addressed this run (independence cut boundary,
   * PM-ratified 2026-06-10). Null outside Channel routing (DMs, retries
   * without a recorded addressing message) — the cut fails open.
   */
  addressedByMessageId: string | null;
}

/**
 * A Channel user message awaiting routing (the round queue, in-memory). A
 * message sent while a round is active is NOT persisted at send time: the event
 * tree is linear along the active path, and appending mid-run would re-point the
 * leaf and orphan the in-flight reply. The round loop persists each entry when
 * it routes it (mirroring the DM follow-up model); until then the renderer shows
 * it from the projection's queue. Edit/regenerate paths enqueue an
 * already-persisted message (they assert no round is active first).
 */
type PendingChannelMessage =
  | { kind: 'prompt'; prompt: UserMessage; messageText: string }
  | { kind: 'persisted'; messageId: string; addressedTo: AgentPrincipal[] };

/** One scheduled Channel turn: the agent to run and the message that addressed it. */
interface ChannelTurnRequest {
  agentId: string;
  addressedByMessageId: string;
}

type RendererProjectionDomainEvent = Extract<AgentDomainEvent, { lane: 'renderer-projection' }>;
type PublicConversationRuntimeEventInput =
  | Omit<Extract<AgentRuntimeEvent, { type: 'approval_request' }>, 'conversationId' | 'timestamp'>
  | Omit<Extract<AgentRuntimeEvent, { type: 'approval_resolved' }>, 'conversationId' | 'timestamp'>
  | Omit<Extract<AgentRuntimeEvent, { type: 'user_question_request' }>, 'conversationId' | 'timestamp'>
  | Omit<Extract<AgentRuntimeEvent, { type: 'user_question_resolved' }>, 'conversationId' | 'timestamp'>
  | Omit<Extract<AgentRuntimeEvent, { type: 'closed' }>, 'conversationId' | 'timestamp'>
  | Omit<Extract<AgentRuntimeEvent, { type: 'error' }>, 'conversationId' | 'timestamp'>;

interface AgentConversationState {
  agent: Agent;
  activeRun: AgentActiveRunState | null;
  lastRun: AgentActiveRunState | null;
  autoCompactConsecutiveFailures: number;
  autoCompactInProgress: boolean;
  eventState: AgentEventReplayState;
  activeCompaction: AgentRenderActiveCompaction | null;
  activeDream: AgentRenderActiveDream | null;
  currentDebugQueryIndex: number;
  nextDebugQueryIndex: number;
  nextDebugTurnIndex: number;
  pendingDreamFinishedMarkers: AgentDreamRunResult[];
  pendingSubagentNotifications: string[];
  pendingEventAppend: Promise<void>;
  pendingProjectionLastEventType: string | null;
  pendingProjectionTimer: ReturnType<typeof setTimeout> | null;
  queuedFollowUpSkillListingReservation: SkillListingReservation | null;
  reactiveCompactRequested: boolean;
  revision: number;
  subagentNotificationFlushInProgress: boolean;
  runtimeSettings: AgentRuntimeSettings;
  skillRuntime: AgentSkillRuntime;
  subagentRuntime: AgentSubagentRuntime;
  localWorkspace: AgentLocalWorkspaceContext;
  toolResultBudgetState: ToolResultBudgetState;
  /** Display names for member agents (agentId → name), for projections + preambles. */
  memberDisplayNames: Record<string, string>;
  /**
   * Channel round state: non-null while a round is draining (turns may be
   * between runs, so `activeRun` alone cannot gate). Queue-all (no steer in
   * Channels): user messages arriving mid-round persist immediately and join
   * `pendingMessages`; `stopRequested` ends the round and discards unstarted
   * routing.
   */
  channelRound: { stopRequested: boolean } | null;
  pendingChannelMessages: PendingChannelMessage[];
  unsubscribe: (() => void) | null;
}

interface AgentDreamMemoryExtractionTask {
  runId: string;
  /** The memory pool this Dream consolidates (the subject it models, and the run anchor). */
  principal: AgentPrincipal;
  trigger: AgentDreamTrigger;
  startedAt: number;
  dueAt?: number;
  span: DreamMemoryExtractionSpan;
  batches: AgentDreamMemoryExtractionBatch[];
  watermark: AgentDreamWatermark;
}

interface AgentDreamMemoryExtractionBatch {
  span: DreamMemoryExtractionSpan;
  /** Provenance only — the workspace the evidence came from; never a retrieval fence. */
  originWorkspace?: string;
}

interface AgentDreamMemoryScope {
  readOnly: boolean;
  /** Provenance tag for new entries — where this runtime works; never a retrieval fence. */
  originWorkspace?: string;
}

interface AgentDreamRunResult {
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

type AgentEventInput = AgentRuntimeContextEventInput;
/** Opt-in OS-notification sink, wired by main.ts (owns the native Electron Notification). */
export type OsNotifier = (input: { title: string; body?: string; conversationId: string }) => void;
type AgentUserViewPanel = AgentUserViewContext['nodePanels'][number];
type AgentUserViewNode = NonNullable<AgentUserViewContext['focusedNode']>;
type AgentUserViewOutlineNode = AgentUserViewPanel['visibleOutline'][number];

export class AgentRuntime {
  private conversations = new Map<string, AgentConversationState>();
  private osNotifier?: OsNotifier;
  // The conversation the user is actually VIEWING, reported by the renderer:
  // the displayed conversation when the agent dock is open, else null (the dock
  // collapses CSS-only while keeping the conversation loaded, so the runtime cannot
  // infer this from restore alone). Used to suppress an OS banner for a task whose
  // conversation the user is already looking at — see main.ts's notifier.
  private viewedConversationId: string | null = null;
  private debugProjectionCache = new Map<string, {
    history: AgentDebugSnapshot[];
    latestSeq: number;
    totals: AgentDebugTotals;
  }>();
  private eventStore: AgentEventStore | null = null;
  private pastChatsService: AgentPastChatsService | null = null;
  private pendingApprovals = new Map<string, {
    conversationId: string;
    request: AgentApprovalRequestView;
    alwaysAllowRule?: string;
    resolve: (resolution: AgentToolApprovalResolution) => void;
  }>();
  private pendingUserQuestions = new Map<string, AgentPendingUserQuestion>();
  private nextConversationId = 1;
  private dreamMemoryExtractionTail: Promise<void> = Promise.resolve();
  /** Pools with a Dream in flight, keyed by `principalKey` — one Dream per pool at a time. */
  private readonly dreamingPools = new Set<string>();
  /**
   * Per-pool scheduled-Dream failure backoff, keyed by `principalKey` (sibling to
   * `dreamingPools`). A scheduled Dream that keeps failing must not re-fire on every 60s tick
   * and flood the run list with `failed` records; the window grows with consecutive failures and
   * clears on the first success. See `dreamBackoff` for why this is in-memory.
   */
  private readonly dreamFailureBackoff = new Map<string, { consecutiveFailures: number; nextAttemptAt: number }>();
  private dreamSchedulerTimer: ReturnType<typeof setInterval> | null = null;
  private commandSchedulerTimer: ReturnType<typeof setInterval> | null = null;
  private commandSweepTail: Promise<void> = Promise.resolve();
  private readonly firingCommandNodeIds = new Set<string>();
  private readonly commandFailureCounts = new Map<string, number>();
  private readonly commandBackoffUntil = new Map<string, number>();
  // Command nodes that have a delivery conversation this app run, so the sweep
  // can delete the conversation when the node is permanently removed.
  private readonly knownCommandConversationNodeIds = new Set<string>();
  private agentTaskCache: AgentRenderTaskEntity[] = [];
  private readonly userViewContextReminderTracker = new AgentUserViewContextReminderTracker();
  private readonly contextManager: AgentRuntimeContextManager<AgentConversationState>;
  private readonly agentIdentity: AgentIdentityRecord;
  private readonly domainEvents: AgentDomainEventBus;

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly outlinerToolHost: OutlinerToolHost,
    private readonly options: AgentRuntimeOptions = {},
  ) {
    this.agentIdentity = options.agentIdentity ?? createDefaultAgentIdentity();
    this.domainEvents = options.domainEvents ?? new AgentDomainEventBus();
    this.domainEvents.subscribeLane('renderer-projection', (event) => {
      this.emit(rendererProjectionEventFromDomain(event));
    });
    this.contextManager = new AgentRuntimeContextManager<AgentConversationState>({
      refreshRuntimeSettings: (conversation) => this.refreshRuntimeSettings(conversation),
      deriveRuntimePiMessages: (conversationId, eventState) => this.deriveRuntimePiMessages(conversationId, eventState),
      appendConversationEvents: async (conversationId, conversation, inputs) => {
        await this.appendConversationEvents(conversationId, conversation, inputs);
      },
      appendCompactionRootEvent: (
        conversationId,
        conversation,
        prompt,
        summary,
        source,
        trigger,
        preservedMessages,
      ) => (
        this.appendCompactionRootEvent(
          conversationId,
          conversation,
          prompt,
          summary,
          source,
          trigger,
          preservedMessages,
        )
      ),
      persistToolOutputPayload: (conversationId, toolCallId, toolName, text) => (
        this.persistToolOutputPayload(conversationId, toolCallId, toolName, text)
      ),
      captureDebugPayload: (conversationId, payload, model) => this.captureDebugPayload(conversationId, payload, model),
      captureDebugResponse: (conversationId, response, model) => this.captureDebugResponse(conversationId, response, model),
      emitError: (conversationId, message) => this.emitError(conversationId, message),
      getActiveProviderConfig: () => this.getActiveProviderConfig(),
      getProviderApiKey: (providerId) => this.getProviderApiKey(providerId),
      resolveProviderModel: (providerConfig) => this.resolveProviderModel(providerConfig),
      beginCompaction: (conversationId, conversation, trigger) => this.beginCompaction(conversationId, conversation, trigger),
      finishCompaction: (conversationId, conversation, compactionId, lastEventType) => {
        this.finishCompaction(conversationId, conversation, compactionId, lastEventType);
      },
      startReactiveRetryRun: async (conversationId, conversation) => {
        this.beginDebugQuery(conversation);
        // The retry continues the SAME turn: same executing member, same
        // addressing boundary — never the coordinator's identity by default.
        await this.startRun(conversationId, conversation, conversation.lastRun?.lastSubmittedUserPrompt ?? null, null, {
          executingAgentId: conversation.lastRun?.executingAgentId,
          addressedByMessageId: conversation.lastRun?.addressedByMessageId ?? null,
        });
      },
      completeSimpleFn: this.options.completeSimpleFn,
    });
    this.startDreamScheduler();
    this.startCommandScheduler();
  }

  ready() {
    this.emit({ type: 'ready', conversationId: null, timestamp: Date.now() });
    this.queueScheduledDream(new Date());
    // Crash recovery FIRST: reconcile any occurrence that was attempted but never
    // recorded success (the app crashed/quit/slept mid-run) — at-most-once, so it
    // is skipped, not re-fired. Chained on the same sweep tail, so the catch-up
    // sweep below sees the reconciled watermark.
    this.queueCommandReconcile();
    // Anacron catch-up on launch: fire any command whose occurrence elapsed
    // while the app was closed (coalesced to one fire per command).
    this.queueCommandSweep(new Date());
  }

  async drainDreamMemoryExtractionForTest(): Promise<void> {
    await this.dreamMemoryExtractionTail;
  }

  async runScheduledDreamsForTest(now = new Date()): Promise<void> {
    this.queueScheduledDream(now);
    await this.dreamMemoryExtractionTail;
  }

  /**
   * Test-only: append a notification.created on a loaded conversation, so a test can
   * deterministically interleave a delivery with markConversationRead and assert the
   * index fold never drifts from replay. Returns the queued promise; do NOT await it
   * before the racing call when reproducing the gap.
   */
  appendNotificationForTest(conversationId: string, notificationId: string): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error(`Agent conversation not live: ${conversationId}`);
    return this.emitTaskNotification(conversationId, conversation, {
      notificationId,
      kind: 'task_completed',
      title: 'Test notification',
    });
  }

  async restoreLatestConversation() {
    return this.restoreOrCreateDefaultDm();
  }

  async restoreConversation(conversationId: string) {
    const eventState = await this.loadEventState(conversationId);
    if (!eventState.conversation) throw new Error(`Agent conversation not found: ${conversationId}`);
    const conversation = await this.createConversationWithEventState(eventState);
    await this.refreshAgentTaskCache();
    // Restoring loads a conversation's state; it does NOT mark it read, and it does
    // NOT imply the user is viewing it (the dock may be collapsed). Marking read and
    // the viewed-conversation signal are both driven explicitly by the renderer.
    return this.conversationResponse(conversationId, conversation);
  }

  /**
   * Renderer-reported: the conversation the user can actually see (dock open), or
   * null (dock collapsed). Window focus is not a dimension here — main.ts layers
   * the focus check on top when deciding OS suppression.
   */
  setViewedConversation(conversationId: string | null): void {
    this.viewedConversationId = conversationId;
  }

  getViewedConversation(): string | null {
    return this.viewedConversationId;
  }

  /**
   * Durably clear a conversation's unread attention — the user opened/read it.
   * Driven explicitly by the renderer (genuine opens + the viewed conversation),
   * NEVER by a config reload. A no-op when nothing is unread (so the log does not
   * grow on every open) or the conversation is not live in this process (the
   * renderer always restores before marking read).
   *
   * The read cursor's throughSeq is taken INSIDE the serial append, not from a
   * pre-queue snapshot: seqs are assigned at write time, so a notification that
   * completes in the gap would otherwise get a higher seq than a stale cursor and be
   * dropped by replay while the index fold counted it read — a live-append/rebuild
   * drift. Reading through the tail-at-write-time keeps "a read clears the whole
   * conversation" true, which the O(1) index fold relies on.
   */
  async markConversationRead(conversationId: string): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    // Cheap pre-check to avoid scheduling an append when clearly nothing is unread;
    // the authoritative decision is re-taken inside the serial block below.
    const pending = conversation.eventState.attentionByConversationId[conversationId];
    if (!pending || pending.unreadCount === 0) return;
    await this.appendConversationEvents(conversationId, conversation, (state) => {
      const attention = state.attentionByConversationId[conversationId];
      if (!attention || attention.unreadCount === 0) return [];
      const throughSeq = state.latestSeq;
      if (throughSeq <= attention.lastReadThroughSeq) return [];
      // The base conversationId (stamped at append) is the delivery anchor.
      return [{ type: 'notification.read', actor: userActor(), throughSeq }];
    });
    this.emitConversationAttention(conversationId, conversation);
  }

  private async restoreOrCreateDefaultDm() {
    const conversationId = this.defaultDmConversationId();
    let eventState = await this.loadEventState(conversationId);
    if (!eventState.conversation) {
      eventState = createEmptyAgentEventReplayState();
      const events = this.buildEvents(eventState, conversationId, [{
        type: 'conversation.created',
        actor: systemActor(),
        title: this.agentIdentity.displayName,
        members: this.defaultConversationMembers(),
      }]);
      await this.getEventStore().appendEvents(conversationId, events);
      for (const event of events) appendAgentEventToReplayState(eventState, event);
      this.publishPersistedEvents(conversationId, events);
    }
    const conversation = await this.createConversationWithEventState(eventState);
    await this.refreshAgentTaskCache();
    return this.conversationResponse(conversationId, conversation);
  }

  async createConversation(options: { agentIds?: string[]; goal?: string; seedText?: string } = {}) {
    const conversationId = this.createChannelId();
    const eventState = createEmptyAgentEventReplayState();
    const title = normalizeConversationTitle(options.goal ?? '');
    const extraMembers = await this.resolveAgentMemberPrincipals(options.agentIds ?? []);
    const members = mergeUniquePrincipals(this.defaultConversationMembers(), extraMembers);
    for (const member of channelAgentMembers(members)) {
      this.assertNoMentionTokenCollision(members.filter((candidate) => candidate !== member), member.agentId);
    }
    const inputs: AgentEventInput[] = [{
      type: 'conversation.created',
      actor: systemActor(),
      title,
      members,
      goal: title,
    }];
    // New-member onboarding floor (ratified): shared substrates only. The optional
    // seed is the Channel's opening context for every member — never a DM transcript.
    const seedText = options.seedText?.trim();
    if (seedText) {
      inputs.push({
        type: 'user_message.created',
        actor: systemActor(),
        messageId: this.createMessageId('user'),
        parentMessageId: null,
        content: [{ type: 'text', text: systemReminder(seedText) }],
      });
    }
    const created = this.buildEvents(eventState, conversationId, inputs);
    await this.getEventStore().appendEvents(conversationId, created);
    for (const event of created) appendAgentEventToReplayState(eventState, event);
    this.publishPersistedEvents(conversationId, created);
    const conversation = await this.createConversationWithEventState(eventState);
    await this.refreshAgentTaskCache();
    return this.conversationResponse(conversationId, conversation);
  }

  /**
   * Add an agent member. On a Channel this is a real `member.added` event; on the
   * canonical DM it never converts in place (ratified) — it spawns a new seeded
   * Channel (goal + existing members + the new agent) and returns THAT conversation.
   */
  async addConversationMember(conversationId: string, agentId: string) {
    const principal = await this.requireAgentMemberPrincipal(agentId);
    const conversation = await this.ensureConversationWithId(conversationId);
    if (this.isDefaultDmConversationId(conversationId)) {
      const dmTitle = conversation.eventState.conversation?.title;
      const goal = dmTitle && dmTitle !== this.agentIdentity.displayName ? dmTitle : undefined;
      return this.createConversation({
        agentIds: [agentId],
        goal,
        seedText: `This Channel was spawned from the user's DM with @${agentMentionToken(this.agentIdentity.agentId)}. Members collaborate here; the DM transcript is private and is not shared.`,
      });
    }
    const members = conversation.eventState.conversation?.members ?? [];
    if (!members.some((member) => samePrincipal(member, principal))) {
      this.assertNoMentionTokenCollision(members, agentId);
      await this.appendConversationEvents(conversationId, conversation, [{
        type: 'member.added',
        actor: userActor(),
        member: principal,
      }]);
      await this.refreshMemberDisplayNames(conversation);
      this.emitProjection(conversationId, 'member.added');
    }
    return this.conversationResponse(conversationId, conversation);
  }

  /**
   * `@` tokens are the routing namespace: two members whose agentIds share a
   * trailing name segment would both match one mention (one `@` → two runs) and
   * be indistinguishable in the UI. Impossible by construction — reject the add.
   */
  private assertNoMentionTokenCollision(members: readonly AgentPrincipal[], agentId: string) {
    const token = agentMentionToken(agentId).toLowerCase();
    const collision = channelAgentMembers(members).find(
      (member) => member.agentId !== agentId && agentMentionToken(member.agentId).toLowerCase() === token,
    );
    if (collision) {
      throw new Error(`Cannot add member: "@${token}" already addresses ${collision.agentId}.`);
    }
  }

  async removeConversationMember(conversationId: string, agentId: string) {
    if (this.isDefaultDmConversationId(conversationId)) throw new Error('The canonical DM membership cannot change.');
    if (agentId === this.coordinatorAgentId()) throw new Error('The Channel coordinator cannot be removed.');
    const conversation = await this.ensureConversationWithId(conversationId);
    // Mid-round removal would yank a member whose run is live (or queued) and
    // can flip the conversation's POV selection under it — membership changes
    // wait for the round to settle.
    if (conversation.channelRound || conversation.agent.state.isStreaming) {
      throw new Error('Cannot remove a member while a Channel round is active.');
    }
    const principal: AgentPrincipal = { type: 'agent', agentId };
    const members = conversation.eventState.conversation?.members ?? [];
    if (members.some((member) => samePrincipal(member, principal))) {
      await this.appendConversationEvents(conversationId, conversation, [{
        type: 'member.removed',
        actor: userActor(),
        member: principal,
      }]);
      this.emitProjection(conversationId, 'member.removed');
    }
    return this.conversationResponse(conversationId, conversation);
  }

  /** Resolve agent ids to member principals, validating each against the registry. */
  private async resolveAgentMemberPrincipals(agentIds: readonly string[]): Promise<AgentPrincipal[]> {
    const principals: AgentPrincipal[] = [];
    for (const agentId of agentIds) {
      principals.push(await this.requireAgentMemberPrincipal(agentId));
    }
    return principals;
  }

  private async requireAgentMemberPrincipal(agentId: string): Promise<AgentPrincipal> {
    if (agentId === this.agentIdentity.agentId) {
      return { type: 'agent', agentId };
    }
    const definitions = await this.listRawAgentDefinitions('member-resolve');
    const match = definitions.find((definition) => agentDefinitionAgentId(definition) === agentId);
    if (!match) throw new Error(`Agent not found for Channel membership: ${agentId}`);
    return { type: 'agent', agentId };
  }

  async listConversations() {
    const entries = await this.getEventStore().listConversationIndexEntries();
    const listed = entries.filter((entry) => !!entry.goal);
    // Seed cross-conversation unread badges on launch: the live conversation_attention
    // event only fires for conversations touched this run, so a conversation that went
    // unread before the app closed would show no badge until it is reopened. Re-emit
    // the persisted unread — but only for conversations that have a list row to carry
    // the badge (goal-less conversations like the default DM are masked when active
    // and have nowhere to render an orphaned count).
    for (const entry of listed) {
      if ((entry.unreadCount ?? 0) > 0) {
        this.emit({
          type: 'conversation_attention',
          conversationId: entry.id,
          unreadCount: entry.unreadCount,
          timestamp: Date.now(),
        });
      }
    }
    return listed
      .map((entry) => ({
        id: entry.id,
        title: sanitizeConversationTitle(entry.title),
        members: entry.members.slice(),
        goal: entry.goal,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        messageCount: entry.messageCount,
      }));
  }

  /**
   * Pools the Settings Memory pane manages: this agent's own self-model and the user pool. The
   * user-Dream writes durable user facts, so they must be inspectable/editable here too (review
   * #6) — a single-pool surface would let user facts accumulate with no way to correct them. The
   * view carries `principal`, so the renderer can group/label the two pools.
   */
  private managedMemoryPrincipals(): AgentPrincipal[] {
    return [this.agentPrincipal(), this.userPrincipal()];
  }

  /** Locate which managed pool owns a memory id, so update/forget target the right pool. */
  private async resolveMemoryPrincipal(memoryId: string): Promise<AgentPrincipal | null> {
    for (const principal of this.managedMemoryPrincipals()) {
      const entry = await this.getEventStore().getMemoryEntry(principal, memoryId);
      if (entry) return principal;
    }
    return null;
  }

  async listMemory(options: { includeInvalidated?: boolean; limit?: number } = {}): Promise<AgentMemoryEntryView[]> {
    const limit = options.limit ?? 200;
    const pools = await Promise.all(this.managedMemoryPrincipals().map((principal) =>
      this.getEventStore().listMemoryEntries(principal, {
        includeInvalidated: options.includeInvalidated,
        limit,
      })));
    // Merge the managed pools newest-first into one bounded list; the view's `principal` lets the
    // renderer separate the agent self-model from the user pool.
    return pools
      .flat()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(agentMemoryEntryToView);
  }

  async updateMemory(memoryId: string, fact: string): Promise<AgentMemoryEntryView | null> {
    const normalizedFact = fact.trim();
    if (!normalizedFact) throw new Error('Memory fact cannot be empty.');
    if (normalizedFact.length > MAX_AGENT_MEMORY_FACT_CHARS) {
      throw new Error(`Memory fact must be ${MAX_AGENT_MEMORY_FACT_CHARS} characters or fewer.`);
    }
    const principal = await this.resolveMemoryPrincipal(memoryId);
    if (!principal) return null;
    const entry = await this.getEventStore().updateMemoryEntry(principal, memoryId, { fact: normalizedFact });
    return entry ? agentMemoryEntryToView(entry) : null;
  }

  async forgetMemory(memoryId: string): Promise<AgentMemoryEntryView | null> {
    const principal = await this.resolveMemoryPrincipal(memoryId);
    if (!principal) return null;
    const entry = await this.getEventStore().removeMemoryEntry(principal, memoryId, 'user');
    return entry ? agentMemoryEntryToView(entry) : null;
  }

  async listSlashCommands(conversationId: string): Promise<AgentSlashCommandView[]> {
    const conversation = await this.ensureConversationWithId(conversationId);
    const runtimeSettings = await this.refreshRuntimeSettings(conversation);
    const commands: AgentSlashCommandView[] = [];

    if (runtimeSettings.compactEnabled) {
      commands.push({
        id: 'compact',
        kind: 'runtime',
        label: '/compact',
        description: 'Compact the current conversation',
        insertText: '/compact ',
      });
    }

    if (this.dreamMemoryExtractionEnabled()) {
      commands.push({
        id: 'dream',
        kind: 'runtime',
        label: '/dream',
        description: 'Run Dream memory consolidation now',
        insertText: '/dream',
      });
    }

    if (runtimeSettings.slashSkillsEnabled) {
      const skills = await conversation.skillRuntime.listUserInvocableSkills();
      commands.push(...skills.map((skill): AgentSlashCommandView => ({
        id: `skill:${skill.name}`,
        kind: 'skill',
        label: `/${skill.name}`,
        description: slashCommandDescription(skill.displayName, skill.description),
        insertText: `/${skill.name} `,
      })));
    }

    return commands.sort((left, right) => (
      slashCommandKindRank(left.kind) - slashCommandKindRank(right.kind)
      || left.label.localeCompare(right.label)
    ));
  }

  async resolveApproval(
    conversationId: string,
    requestId: string,
    approved: boolean,
    scope: AgentApprovalResolutionScope = 'once',
  ) {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending || pending.conversationId !== conversationId) return { resolved: false };
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return { resolved: false };

    let resolvedScope = scope;
    let alwaysAllowRule = approved && scope === 'always' ? pending.alwaysAllowRule : undefined;
    if (approved && scope === 'always' && !alwaysAllowRule) {
      resolvedScope = 'once';
    }
    if (alwaysAllowRule) {
      try {
        await appendAgentToolPermissionAllowRule(alwaysAllowRule);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.emitError(conversationId, `Failed to persist always-allow rule; approved once instead. ${message}`);
        resolvedScope = 'once';
        alwaysAllowRule = undefined;
      }
    }

    this.pendingApprovals.delete(requestId);
    try {
      await this.appendConversationEvents(conversationId, conversation, [{
        type: 'approval.resolved',
        actor: userActor(),
        runId: this.activeRunId(conversation) ?? undefined,
        requestId,
        approved,
      }]);
      this.emitConversationRuntimeEvent(conversationId, {
        type: 'approval_resolved',
        requestId,
        approved,
        scope: resolvedScope,
      });
      this.emitProjection(conversationId, 'approval.resolved');
    } finally {
      pending.resolve({
        approved,
        deniedReason: approved ? undefined : 'user_denied',
        scope: resolvedScope,
        alwaysAllowRule,
      });
    }
    return { resolved: true };
  }

  async debugSnapshot(conversationId: string) {
    const conversation = await this.ensureConversationWithId(conversationId);
    const projection = await this.deriveDebugProjection(conversationId);
    const snapshot = projection.history.at(-1) ?? this.getRuntimeDebugSnapshot(conversationId, conversation);
    return snapshot ? cloneDebug(snapshot) : null;
  }

  async debugHistory(conversationId: string) {
    await this.ensureConversationWithId(conversationId);
    return cloneDebug((await this.deriveDebugProjection(conversationId)).history);
  }

  async debugTotals(conversationId: string) {
    await this.ensureConversationWithId(conversationId);
    return cloneDebug((await this.deriveDebugProjection(conversationId)).totals);
  }

  async debugPayload(conversationId: string, payloadId: string) {
    const conversation = this.conversations.get(conversationId);
    const eventState = conversation?.eventState ?? await this.loadEventState(conversationId);
    const payload = eventState.payloads[payloadId];
    if (!payload || payload.role !== 'debug') return null;
    const bytes = await this.getEventStore().readPayload(conversationId, payload);
    return bytes.toString('utf8');
  }

  async payloadText(conversationId: string, payloadId: string) {
    const conversation = this.conversations.get(conversationId);
    const eventState = conversation?.eventState ?? await this.loadEventState(conversationId);
    const payload = eventState.payloads[payloadId];
    if (!payload || !isTextPayloadRole(payload.role) || !isTextPayloadMimeType(payload.mimeType)) return null;
    const bytes = await this.getEventStore().readPayload(conversationId, payload);
    return bytes.toString('utf8');
  }

  async subagentStatus(
    conversationId: string,
    agentId: string,
    options: { wait?: boolean; timeoutMs?: number } = {},
  ) {
    const conversation = await this.ensureConversationWithId(conversationId);
    return conversation.subagentRuntime.status({
      agent_id: agentId,
      wait: options.wait === true,
      timeout_ms: options.timeoutMs,
    });
  }

  async subagentSend(conversationId: string, agentId: string, message: string) {
    const conversation = await this.ensureConversationWithId(conversationId);
    return conversation.subagentRuntime.send({
      agent_id: agentId,
      message,
    });
  }

  async subagentStop(conversationId: string, agentId: string) {
    const conversation = await this.ensureConversationWithId(conversationId);
    return conversation.subagentRuntime.stop({
      agent_id: agentId,
    });
  }

  async listAllAgentDefinitions(conversationId: string): Promise<AgentDefinitionView[]> {
    const definitions = await this.listRawAgentDefinitions(conversationId);
    return definitions.map((definition) => ({ ...definition, agentId: agentDefinitionAgentId(definition) }));
  }

  // The raw (agentId-less) scan, shared by the settings list and the
  // authoring resolve-by-id path. Reuses a live conversation's registry when one
  // exists (so its cache invalidation is observed), else a throwaway runtime.
  private async listRawAgentDefinitions(conversationId: string): Promise<AgentDefinition[]> {
    const conversation = this.conversations.get(conversationId);
    if (conversation) {
      return conversation.subagentRuntime.listAllAgentDefinitions();
    }
    const tempRuntime = new AgentSubagentRuntime({
      conversationId: 'temp-settings-list',
      executingAgentId: this.agentIdentity.agentId,
      memoryOwnerAgentId: this.agentIdentity.agentId,
      localRoot: this.options.localFileRoot,
      host: {} as any,
    });
    return tempRuntime.listAllAgentDefinitions();
  }

  // Authoring (user-driven only — see [[agent-authoring]]). Each write goes
  // through main's containment-checked file surface, then every live conversation's
  // registry cache is invalidated so the change is visible (subagent picker +
  // settings list) without an app restart. The fresh view list is returned so
  // the renderer can re-select by agentId.
  async createAgentDefinition(
    conversationId: string,
    input: AgentAuthoringInput,
    storage: AgentStorageLocation,
  ): Promise<AgentDefinitionView[]> {
    await createAgentDefinitionFile({ input, storage, localRoot: this.authoringLocalRoot() });
    return this.reloadAgentDefinitions(conversationId);
  }

  async updateAgentDefinition(
    conversationId: string,
    agentId: string,
    input: AgentAuthoringInput,
  ): Promise<AgentDefinitionView[]> {
    const existing = await this.resolveAgentDefinitionById(conversationId, agentId);
    await updateAgentDefinitionFile({ existing, input, localRoot: this.authoringLocalRoot() });
    return this.reloadAgentDefinitions(conversationId);
  }

  async deleteAgentDefinition(conversationId: string, agentId: string): Promise<AgentDefinitionView[]> {
    const existing = await this.resolveAgentDefinitionById(conversationId, agentId);
    await deleteAgentDefinitionFile({ existing, localRoot: this.authoringLocalRoot() });
    return this.reloadAgentDefinitions(conversationId);
  }

  async duplicateAgentDefinition(
    conversationId: string,
    agentId: string,
    newName: string,
    storage: AgentStorageLocation,
  ): Promise<AgentDefinitionView[]> {
    const source = await this.resolveAgentDefinitionById(conversationId, agentId);
    await duplicateAgentDefinitionFile({ source, newName, storage, localRoot: this.authoringLocalRoot() });
    return this.reloadAgentDefinitions(conversationId);
  }

  // Invalidate every live conversation's registry cache, then return the fresh list.
  // Also exposed as an explicit "reload agents" action.
  async reloadAgentDefinitions(conversationId: string): Promise<AgentDefinitionView[]> {
    for (const conversation of this.conversations.values()) {
      conversation.subagentRuntime.reloadAgentDefinitions();
    }
    return this.listAllAgentDefinitions(conversationId);
  }

  private async resolveAgentDefinitionById(conversationId: string, agentId: string): Promise<AgentDefinition> {
    const definitions = await this.listRawAgentDefinitions(conversationId);
    const match = definitions.find((definition) => agentDefinitionAgentId(definition) === agentId);
    if (!match) throw new Error('Agent definition not found.');
    return match;
  }

  private authoringLocalRoot(): string {
    return this.options.localFileRoot ?? process.cwd();
  }

  async listAllSkills(conversationId: string) {
    return (await this.skillRuntimeForConversation(conversationId)).listAllSkills();
  }

  async acceptSkill(conversationId: string, skillName: string, expectedHash: string) {
    return this.applySkillTrustAction(conversationId, (skillRuntime) => skillRuntime.acceptSkill(skillName, expectedHash));
  }

  async revokeSkillAcceptance(conversationId: string, skillName: string) {
    return this.applySkillTrustAction(conversationId, (skillRuntime) => skillRuntime.revokeSkillAcceptance(skillName));
  }

  async undoLastAgentSkillEdit(conversationId: string, skillName: string) {
    return this.applySkillTrustAction(conversationId, (skillRuntime) => skillRuntime.undoLastAgentSkillEdit(skillName));
  }

  /**
   * Run a trust action, then propagate it to every live conversation: the Settings panel
   * runs conversationless (its own registry over the persisted store), and each conversation
   * holds an independent in-memory trust map — without the refresh, an accepted
   * skill would join a running conversation's model listing only after restart.
   */
  private async applySkillTrustAction(
    conversationId: string,
    action: (skillRuntime: AgentSkillRuntime) => Promise<void>,
  ) {
    const skillRuntime = await this.skillRuntimeForConversation(conversationId);
    await action(skillRuntime);
    for (const conversation of this.conversations.values()) {
      if (conversation.skillRuntime !== skillRuntime) {
        await conversation.skillRuntime.refreshTrustRecords();
      }
    }
    return skillRuntime.listAllSkills();
  }

  /**
   * The live conversation skill runtime when the conversation has one, else a throwaway
   * runtime over the same skill dirs AND the same persisted trust store — without
   * the store a conversationless Skills panel would lose user-source agent-write
   * provenance and project-source acceptances.
   */
  private async skillRuntimeForConversation(conversationId: string): Promise<AgentSkillRuntime> {
    const conversation = this.conversations.get(conversationId);
    if (conversation) return conversation.skillRuntime;
    const runtimeSettings = await this.getRuntimeSettings();
    return new AgentSkillRuntime({
      localRoot: this.options.localFileRoot,
      additionalSkillDirectories: runtimeSettings.additionalSkillDirectories,
      provenanceStore: createAgentSkillProvenanceStore(),
    });
  }

  async renameConversation(conversationId: string, title: string) {
    if (this.isDefaultDmConversationId(conversationId)) {
      throw new Error('The canonical agent DM cannot be renamed.');
    }
    const normalized = normalizeConversationTitle(title);
    const conversation = this.conversations.get(conversationId);
    if (conversation) {
      await this.appendConversationEvents(conversationId, conversation, [{
        type: 'conversation.renamed',
        actor: systemActor(),
        title: normalized,
        goal: normalized,
      }]);
      this.emitProjection(conversationId, 'conversation_renamed');
      return eventStateToMeta(conversation.eventState);
    }
    const eventState = await this.loadEventState(conversationId);
    if (!eventState.conversation) return null;
    const events = this.buildEvents(eventState, conversationId, [{
      type: 'conversation.renamed',
      actor: systemActor(),
      title: normalized,
      goal: normalized,
    }]);
    await this.getEventStore().appendEvents(conversationId, events);
    for (const event of events) appendAgentEventToReplayState(eventState, event);
    this.publishPersistedEvents(conversationId, events);
    return eventStateToMeta(eventState);
  }

  async deleteConversation(conversationId: string) {
    if (this.isDefaultDmConversationId(conversationId)) {
      throw new Error('The canonical agent DM cannot be deleted.');
    }
    const conversation = this.conversations.get(conversationId);
    if (conversation) {
      await this.clearPendingUserQuestionsForConversation(conversationId, 'conversation_deleted');
      conversation.agent.abort();
      conversation.unsubscribe?.();
      clearPendingProjection(conversation);
      this.conversations.delete(conversationId);
      this.debugProjectionCache.delete(conversationId);
      this.userViewContextReminderTracker.reset(conversationId);
      this.emitConversationRuntimeEvent(conversationId, { type: 'closed' });
    }
    this.cleanupProviderConversationResources(conversationId);
    await this.getEventStore().deleteConversation(conversationId);
    this.userViewContextReminderTracker.reset(conversationId);
  }

  async sendMessage(
    conversationId: string,
    message: string,
    attachmentInput: unknown = [],
    userViewContextInput: unknown = null,
  ) {
    let startedRunId: string | null = null;
    try {
      const conversation = await this.ensureConversationWithId(conversationId);
      const materialized = await this.materializeFileAttachments(normalizeAttachmentInputs(attachmentInput));
      const attachments = materialized.attachments;
      const messageText = rewriteFileReferenceMarkerPaths(message, materialized.pathMap);
      if (!messageText.trim() && attachments.length === 0) return;
      const channelMembers = conversation.eventState.conversation?.members ?? [];
      const multiAgent = isMultiAgentConversation(channelMembers);
      if (conversation.agent.state.isStreaming && !multiAgent) {
        if (attachments.length > 0) {
          throw new Error('Attachments cannot be queued while the agent is running.');
        }
        await this.steerConversation(conversationId, messageText);
        return;
      }
      const roundActive = multiAgent && (conversation.channelRound !== null || conversation.agent.state.isStreaming);
      const runtimeSettings = await this.refreshRuntimeSettings(conversation);
      const compactCommand = attachments.length === 0 && runtimeSettings.compactEnabled
        ? parseCompactSlashCommand(messageText)
        : null;
      if (compactCommand) {
        if (roundActive) throw new Error('Cannot compact while a Channel round is active.');
        await this.compactConversation(conversationId, conversation, compactCommand.instructions);
        return;
      }
      if (attachments.length === 0 && parseDreamSlashCommand(messageText) && this.dreamMemoryExtractionEnabled()) {
        if (roundActive) throw new Error('Cannot run /dream while a Channel round is active.');
        await this.runManualDreamFromConversation(conversationId);
        return;
      }
      if (!roundActive) {
        conversation.skillRuntime.resetRunPermissionRules();
        this.beginDebugQuery(conversation);
      }
      const userViewContextReminder = this.userViewContextReminderTracker.prepare(
        conversationId,
        normalizeAgentUserViewContext(userViewContextInput),
      );
      const userViewReminderText = userViewContextReminder.reminder;
      const now = new Date();
      const outlinerContext = buildOutlinerContextReminder(this.outlinerToolHost);
      // In a Channel the persisted user message stays reader-neutral: a memory
      // briefing belongs to ONE reader, so it is injected transiently per run at
      // assembly time instead of being written into the shared log. Skill/agent
      // listings are likewise main-agent-POV and stay out of the shared message.
      const memoryReminder = multiAgent
        ? null
        : await this.buildMemoryReminder(this.agentIdentity.agentId, conversation);
      const turnContextReminder = joinReminderParts([
        buildEnvironmentContextReminder(now),
        memoryReminder,
        outlinerContext,
        userViewReminderText,
      ]);
      const slashSkillPrompt = attachments.length === 0 && runtimeSettings.slashSkillsEnabled
        ? await createSlashSkillPrompt(conversation.skillRuntime, messageText, turnContextReminder)
        : null;
      const skillListingReminder = slashSkillPrompt || multiAgent
        ? null
        : await this.buildSkillListingReminder(conversation);
      const agentListingReminder = slashSkillPrompt || multiAgent
        ? null
        : await this.buildAgentListingReminder(conversation);
      const prompt = slashSkillPrompt ?? buildUserPromptMessage(messageText, attachments, {
        memoryReminder,
        outlinerContext,
        userViewContextReminder: userViewReminderText,
        skillListingReminder,
        agentListingReminder,
      }, now);
      if (multiAgent) {
        // Queue-all (ratified, no steer in Channels): the message joins the
        // round queue and is shown immediately from the projection; the round
        // loop persists it when it routes it, keeping the event path linear
        // past the in-flight reply. The gate covers ANY active Channel run —
        // not just rounds: regenerate/retry and subagent-notification flushes
        // run turns with no channelRound, and starting a round under them
        // would re-point the leaf beneath the in-flight reply. Those paths
        // drain the queue when they settle.
        userViewContextReminder.commit();
        conversation.pendingChannelMessages.push({ kind: 'prompt', prompt, messageText });
        this.emitProjection(conversationId, 'channel_message_queued');
        if (conversation.channelRound || this.activeRunId(conversation) || conversation.agent.state.isStreaming) return;
        await this.runChannelRound(conversationId, conversation);
      } else {
        await this.appendUserPromptEvent(conversationId, conversation, prompt);
        userViewContextReminder.commit();
        startedRunId = await this.startRun(conversationId, conversation, prompt);
        await conversation.agent.prompt(prompt);
        await this.contextManager.runReactiveCompactRetryIfNeeded(conversationId, conversation);
      }
      await this.persistAndEmitIdle(conversationId, conversation);
    } catch (error) {
      // Scoped to the run THIS call started: the Channel path's turns recover
      // inside runChannelTurn, and a startRun rejected by the already-active
      // guard must never clear the healthy foreign run that owns the slot.
      await this.recoverFromRunError(conversationId, startedRunId);
      this.emitError(conversationId, error instanceof Error ? error.message : String(error));
    }
  }

  /** Edit/regenerate/retry/switch act on a settled transcript — a Channel round in flight means it is not settled. */
  private assertNoActiveChannelRound(conversation: AgentConversationState) {
    if (conversation.channelRound) throw new Error('Cannot modify the transcript while a Channel round is active.');
  }

  async editMessage(conversationId: string, nodeId: string, message: string) {
    const trimmed = message.trim();
    if (!trimmed) return;
    let startedRunId: string | null = null;
    try {
      const conversation = await this.ensureConversationWithId(conversationId);
      if (conversation.agent.state.isStreaming) throw new Error('Cannot edit while the agent is running.');
      this.assertNoActiveChannelRound(conversation);
      const target = requireEventMessage(conversation.eventState, nodeId);
      if (target.role !== 'user') throw new Error('Only user messages can be edited');
      this.userViewContextReminderTracker.reset(conversationId);
      const members = conversation.eventState.conversation?.members ?? [];
      const multiAgent = isMultiAgentConversation(members);
      // The edited text is a fresh addressing message: re-resolve `@` routing
      // (the original event's addressedTo must not silently carry over).
      const addressedTo = multiAgent ? this.resolveAddressedMembers(trimmed, members) : null;
      const messageId = this.createMessageId('user');
      await this.appendConversationEvents(conversationId, conversation, [{
        type: 'user_message.created',
        actor: userActor(),
        messageId,
        parentMessageId: target.parentMessageId,
        replacesMessageId: target.id,
        content: textPersistedContent(trimmed),
        addressedTo: addressedTo ?? undefined,
      }]);
      conversation.agent.state.messages = await this.deriveRuntimePiMessages(conversationId, conversation.eventState) as never;
      this.emitProjection(conversationId, 'message_edited');
      conversation.skillRuntime.resetRunPermissionRules();
      this.beginDebugQuery(conversation);
      if (multiAgent && addressedTo) {
        conversation.pendingChannelMessages.push({ kind: 'persisted', messageId, addressedTo });
        await this.runChannelRound(conversationId, conversation);
      } else {
        startedRunId = await this.startRun(conversationId, conversation);
        await conversation.agent.continue();
        await this.contextManager.runReactiveCompactRetryIfNeeded(conversationId, conversation);
      }
      await this.persistAndEmitIdle(conversationId, conversation);
    } catch (error) {
      await this.recoverFromRunError(conversationId, startedRunId);
      this.emitError(conversationId, error instanceof Error ? error.message : String(error));
    }
  }

  async regenerateMessage(conversationId: string, nodeId: string) {
    try {
      const conversation = await this.ensureConversationWithId(conversationId);
      if (conversation.agent.state.isStreaming) throw new Error('Cannot regenerate while the agent is running.');
      this.assertNoActiveChannelRound(conversation);
      const targetId = findRegenerateTarget(conversation.eventState, nodeId);
      const target = requireEventMessage(conversation.eventState, targetId);
      const parentId = target.parentMessageId;
      if (!parentId) throw new Error('Cannot regenerate without a parent message.');
      this.userViewContextReminderTracker.reset(conversationId);
      await this.appendConversationEvents(conversationId, conversation, [{
        type: 'branch.selected',
        actor: systemActor(),
        leafMessageId: parentId,
      }]);
      conversation.agent.state.messages = await this.deriveRuntimePiMessages(conversationId, conversation.eventState) as never;
      this.emitProjection(conversationId, 'message_regenerate_started');
      conversation.skillRuntime.resetRunPermissionRules();
      this.beginDebugQuery(conversation);
      await this.rerunSettledTurn(conversationId, conversation, target, parentId);
      await this.persistAndEmitIdle(conversationId, conversation);
    } catch (error) {
      // Run recovery happens inside rerunSettledTurn (it knows the run it
      // started); this catch only surfaces the error.
      this.emitError(conversationId, error instanceof Error ? error.message : String(error));
    }
    // After the catch (mirroring the notification flush): a pre-turn throw
    // must not strand messages queued behind this non-round turn.
    const settled = this.conversations.get(conversationId);
    if (settled) await this.drainChannelQueueIfIdle(conversationId, settled);
  }

  async retryMessage(conversationId: string, nodeId: string) {
    try {
      const conversation = await this.ensureConversationWithId(conversationId);
      if (conversation.agent.state.isStreaming) throw new Error('Cannot retry while the agent is running.');
      this.assertNoActiveChannelRound(conversation);
      const target = requireEventMessage(conversation.eventState, nodeId);
      const parentId = target.parentMessageId;
      if (!parentId) throw new Error('Cannot retry without a parent message.');
      this.userViewContextReminderTracker.reset(conversationId);
      await this.appendConversationEvents(conversationId, conversation, [{
        type: 'branch.selected',
        actor: systemActor(),
        leafMessageId: parentId,
      }]);
      conversation.agent.state.messages = await this.deriveRuntimePiMessages(conversationId, conversation.eventState) as never;
      this.emitProjection(conversationId, 'message_retry_started');
      conversation.skillRuntime.resetRunPermissionRules();
      this.beginDebugQuery(conversation);
      await this.rerunSettledTurn(conversationId, conversation, target, parentId);
      await this.persistAndEmitIdle(conversationId, conversation);
    } catch (error) {
      // Run recovery happens inside rerunSettledTurn (it knows the run it
      // started); this catch only surfaces the error.
      this.emitError(conversationId, error instanceof Error ? error.message : String(error));
    }
    // After the catch (mirroring the notification flush): a pre-turn throw
    // must not strand messages queued behind this non-round turn.
    const settled = this.conversations.get(conversationId);
    if (settled) await this.drainChannelQueueIfIdle(conversationId, settled);
  }

  /**
   * Re-run a settled assistant turn (regenerate/retry) AS its original speaker:
   * the regenerated record's run identity — not the coordinator — picks the
   * executing member, so a peer's alternate branch keeps the peer's persona,
   * tools, memory line, and POV. The branch was just reselected to `parentId`,
   * which is therefore the addressing boundary (the cut is a no-op on a path
   * that already ends there — recorded for the retry chain's benefit). A
   * regenerated reply does not re-trigger hand-off routing (noted in the PR;
   * the alternate branch is a re-statement, not a new round).
   */
  private async rerunSettledTurn(
    conversationId: string,
    conversation: AgentConversationState,
    originalRecord: AgentEventMessageRecord,
    parentId: string,
  ) {
    const owner = channelMessageOwner(originalRecord, conversation.eventState.runs, this.coordinatorAgentId());
    const ownerAgentId = owner.type === 'agent' ? owner.agentId : this.coordinatorAgentId();
    const members = conversation.eventState.conversation?.members ?? [];
    if (isMultiAgentConversation(members) || ownerAgentId !== this.coordinatorAgentId()) {
      await this.runChannelTurn(conversationId, conversation, {
        agentId: ownerAgentId,
        addressedByMessageId: parentId,
      });
      return;
    }
    let startedRunId: string | null = null;
    try {
      startedRunId = await this.startRun(conversationId, conversation);
      await continueFromActivePath(conversation.agent);
      await this.contextManager.runReactiveCompactRetryIfNeeded(conversationId, conversation);
    } catch (error) {
      // Free the slot of the run THIS rerun started, then let the caller's
      // catch surface the error.
      await this.recoverFromRunError(conversationId, startedRunId);
      throw error;
    }
  }

  async switchBranch(conversationId: string, nodeId: string) {
    try {
      const conversation = await this.ensureConversationWithId(conversationId);
      if (conversation.agent.state.isStreaming) throw new Error('Cannot switch branches while the agent is running.');
      this.assertNoActiveChannelRound(conversation);
      const leafMessageId = findLatestEventLeaf(conversation.eventState, nodeId).id;
      this.userViewContextReminderTracker.reset(conversationId);
      await this.appendConversationEvents(conversationId, conversation, [{
        type: 'branch.selected',
        actor: systemActor(),
        leafMessageId,
      }]);
      conversation.agent.state.messages = await this.deriveRuntimePiMessages(conversationId, conversation.eventState) as never;
      this.emitProjection(conversationId, 'branch_switched');
    } catch (error) {
      this.emitError(conversationId, error instanceof Error ? error.message : String(error));
    }
  }

  async queueFollowUp(conversationId: string, message: string, userViewContextInput: unknown = null) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      this.emitError(conversationId, `Unknown agent conversation: ${conversationId}`);
      return { queued: false };
    }
    const text = message.trim();
    if (!text) return { queued: false };
    // Channels use the round queue, not the pi follow-up queue: the DM follow-up
    // builds the MAIN agent's private memory briefing into the prompt, which
    // must never enter the reader-neutral shared log; routing also has to
    // re-resolve `@` addressing. sendMessage does both.
    if (isMultiAgentConversation(conversation.eventState.conversation?.members ?? [])) {
      void this.sendMessage(conversationId, text, [], userViewContextInput);
      return { queued: true };
    }
    this.releaseQueuedFollowUpSkillListing(conversation);
    conversation.agent.clearFollowUpQueue();
    this.userViewContextReminderTracker.reset(conversationId);
    await this.refreshRuntimeSettings(conversation);
    const skillListingReservation = await this.reserveSkillListingReminder(conversation);
    conversation.queuedFollowUpSkillListingReservation = skillListingReservation;
    const userViewContextReminder = buildUserViewContextReminder(normalizeAgentUserViewContext(userViewContextInput));
    conversation.agent.followUp(buildUserPromptMessage(text, [], {
      memoryReminder: await this.buildMemoryReminder(this.agentIdentity.agentId, conversation),
      outlinerContext: buildOutlinerContextReminder(this.outlinerToolHost),
      userViewContextReminder,
      skillListingReminder: skillListingReservation?.text ?? null,
      agentListingReminder: await this.buildAgentListingReminder(conversation),
    }));
    this.emitProjection(conversationId, 'follow_up_queued');
    return { queued: true };
  }

  steerConversation(conversationId: string, message: string) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      this.emitError(conversationId, `Unknown agent conversation: ${conversationId}`);
      return { queued: false };
    }
    const text = message.trim();
    if (!text) return { queued: false };
    // No steer in Channels (ratified): there is no streamed turn to steer, and
    // an explicit `@` must produce the addressed member's run, not an injection
    // into whichever member happens to be running. Route as a normal message.
    if (isMultiAgentConversation(conversation.eventState.conversation?.members ?? [])) {
      void this.sendMessage(conversationId, text);
      return { queued: true };
    }
    if (!conversation.agent.state.isStreaming) return { queued: false };
    conversation.agent.clearSteeringQueue();
    conversation.agent.steer({
      role: 'user',
      timestamp: Date.now(),
      content: [{ type: 'text', text }],
    });
    this.emitProjection(conversationId, 'steer_queued');
    return { queued: true };
  }

  clearSteer(conversationId: string) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    conversation.agent.clearSteeringQueue();
    this.emitProjection(conversationId, 'steer_cleared');
  }

  clearFollowUp(conversationId: string) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    conversation.agent.clearFollowUpQueue();
    this.releaseQueuedFollowUpSkillListing(conversation);
    this.emitProjection(conversationId, 'follow_up_cleared');
  }

  stopConversation(conversationId: string) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    void this.clearPendingUserQuestionsForConversation(conversationId, 'conversation_stopped')
      .catch((error) => this.emitError(conversationId, error instanceof Error ? error.message : String(error)));
    // stop ends the whole Channel round (ratified): the aborted run cancels,
    // and the round loop discards unstarted routing with a thread trace.
    if (conversation.channelRound) conversation.channelRound.stopRequested = true;
    conversation.agent.abort();
    conversation.skillRuntime.resetRunPermissionRules();
    this.emitProjection(conversationId, 'stop_requested');
  }

  resetConversation(conversationId: string) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    conversation.agent.reset();
    this.cleanupProviderConversationResources(conversationId);
    this.userViewContextReminderTracker.reset(conversationId);
    void (async () => {
      await this.clearPendingApprovalsForConversation(conversationId, conversation);
      await this.clearPendingUserQuestionsForConversation(conversationId, 'conversation_reset');
      const previousConversation = conversation.eventState.conversation;
      await this.getEventStore().deleteConversation(conversationId);
      this.debugProjectionCache.delete(conversationId);
      const eventState = createEmptyAgentEventReplayState();
      const events = this.buildEvents(eventState, conversationId, [{
        type: 'conversation.created',
        actor: systemActor(),
        title: previousConversation?.title ?? (this.isDefaultDmConversationId(conversationId) ? this.agentIdentity.displayName : 'Untitled'),
        members: previousConversation?.members.slice() ?? this.defaultConversationMembers(),
        goal: previousConversation?.goal,
      }]);
      await this.getEventStore().appendEvents(conversationId, events);
      for (const event of events) appendAgentEventToReplayState(eventState, event);
      this.publishPersistedEvents(conversationId, events);
      conversation.eventState = eventState;
      conversation.agent.state.messages = [];
      conversation.autoCompactConsecutiveFailures = 0;
      conversation.activeRun = null;
      conversation.lastRun = null;
      conversation.pendingSubagentNotifications.length = 0;
      conversation.queuedFollowUpSkillListingReservation = null;
      conversation.reactiveCompactRequested = false;
      conversation.localWorkspace.readFileState.clear();
      conversation.toolResultBudgetState = createToolResultBudgetState();
      await this.refreshRuntimeSettings(conversation);
      conversation.skillRuntime.resetConversationState();
      this.emitProjection(conversationId, 'conversation_reset');
    })().catch((error) => this.emitError(conversationId, error instanceof Error ? error.message : String(error)));
  }

  closeConversation(conversationId: string) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    void this.clearPendingApprovalsForConversation(conversationId, conversation)
      .catch((error) => this.emitError(conversationId, error instanceof Error ? error.message : String(error)));
    void this.clearPendingUserQuestionsForConversation(conversationId, 'conversation_closed')
      .catch((error) => this.emitError(conversationId, error instanceof Error ? error.message : String(error)));
    conversation.agent.abort();
    conversation.unsubscribe?.();
    clearPendingProjection(conversation);
    this.conversations.delete(conversationId);
    this.userViewContextReminderTracker.reset(conversationId);
    this.cleanupProviderConversationResources(conversationId);
    this.emitConversationRuntimeEvent(conversationId, { type: 'closed' });
  }

  private async clearPendingApprovalsForConversation(conversationId: string, conversation: AgentConversationState) {
    const resolvedEvents: AgentEventInput[] = [];
    for (const [requestId, pending] of [...this.pendingApprovals]) {
      if (pending.conversationId !== conversationId) continue;
      this.pendingApprovals.delete(requestId);
      resolvedEvents.push({
        type: 'approval.resolved',
        actor: systemActor(),
        runId: this.activeRunId(conversation) ?? undefined,
        requestId,
        approved: false,
      });
      this.emitConversationRuntimeEvent(conversationId, {
        type: 'approval_resolved',
        requestId,
        approved: false,
      });
      pending.resolve({ approved: false, deniedReason: 'runtime' });
    }
    if (resolvedEvents.length > 0) {
      await this.appendConversationEvents(conversationId, conversation, resolvedEvents);
      this.emitProjection(conversationId, 'approval.resolved');
    }
  }

  private async clearPendingUserQuestionsForConversation(conversationId: string, reason: string) {
    for (const pending of [...this.pendingUserQuestions.values()]) {
      if (pending.conversationId === conversationId) await this.cancelUserQuestion(pending.requestId, reason);
    }
  }

  private async createConversationWithEventState(eventState: AgentEventReplayState) {
    if (!eventState.conversation) throw new Error('Cannot create agent runtime without conversation.created');
    const conversationId = eventState.conversation.id;
    this.reserveConversationId(conversationId);
    const existing = this.conversations.get(conversationId);
    existing?.unsubscribe?.();
    existing?.agent.abort();
    if (existing) clearPendingProjection(existing);
    if (existing) this.cleanupProviderConversationResources(conversationId);
    this.userViewContextReminderTracker.reset(conversationId);

    const providerConfig = await this.getActiveProviderConfig();
    const runtimeSettings = await this.getRuntimeSettings();
    const activePath = await this.deriveRuntimePiMessages(conversationId, eventState);
    const providerModel = providerConfig ? this.resolveProviderModel(providerConfig) : null;
    await this.getEventStore().writeAgentIdentity(this.currentAgentIdentity(providerModel));
    const conversationRef: { current: AgentConversationState | null } = { current: null };
    const agentRef: { current: Agent | null } = { current: null };
    const skillRuntime = new AgentSkillRuntime({
      localRoot: this.options.localFileRoot,
      additionalSkillDirectories: runtimeSettings.additionalSkillDirectories,
      provenanceStore: createAgentSkillProvenanceStore(),
      conversationId,
      executeSkillShell: async ({ command, skill }) => {
        const activeSettings = await this.getRuntimeSettings();
        const globalPermissions = await readAgentToolPermissionConfig();
        const current = conversationRef.current;
        return executeAgentSkillShellCommand({
          approvalHandler: current
            ? (input, signal) => this.requestToolApproval(conversationId, current, input, signal)
            : undefined,
          command,
          localRoot: this.options.localFileRoot,
          permissionMode: this.options.permissionMode ?? activeSettings.permissionMode,
          allowedTools: skill.allowedTools,
          globalPermissions,
          permissionEventHandler: (input) => {
            const currentConversation = conversationRef.current;
            return currentConversation ? this.appendToolPermissionEvent(conversationId, currentConversation, input) : Promise.resolve();
          },
          toolCallId: `skill-shell-${randomUUID()}`,
        });
      },
      executeForkedSkill: async ({ skill, renderedContent, parentToolCallId }) => {
        const current = conversationRef.current;
        if (!current) throw new Error('Cannot run forked skill before the agent conversation is ready.');
        const data = await current.subagentRuntime.invokeSkillSubagent({
          skillName: skill.name,
          description: skill.description,
          renderedContent,
          agent: skill.agent,
          model: skill.model,
          effort: skill.effort,
          allowedTools: skill.allowedTools,
        }, undefined, parentToolCallId);
        return {
          agentId: data.agent_id,
          subagentType: data.subagent_type,
          status: data.status,
          result: data.result,
          error: data.error,
        };
      },
    });
    skillRuntime.updateDisabledSkills(runtimeSettings.disabledSkills ?? []);
    skillRuntime.restoreInvokedSkillsFromMessages(activePath);
    const localWorkspace = createAgentLocalWorkspaceContext(this.options.localFileRoot, skillRuntime);
    const subagentRuntime = new AgentSubagentRuntime({
      conversationId,
      executingAgentId: this.agentIdentity.agentId,
      memoryOwnerAgentId: this.agentIdentity.agentId,
      localRoot: this.options.localFileRoot,
      additionalAgentDirectories: runtimeSettings.additionalAgentDirectories,
      host: {
        createChildAgent: (input) => {
          if (!providerConfig) throw new Error('No enabled agent provider is configured.');
          return this.createSubagentAgent(conversationId, conversationRef, providerConfig, input);
        },
        getParentMessages: () => agentRef.current?.state.messages as AgentMessage[] ?? activePath,
        getParentSystemPrompt: () => agentRef.current?.state.systemPrompt ?? LIN_AGENT_SYSTEM_PROMPT,
        getRuntimeSettings: () => this.getRuntimeSettings(),
        buildMemoryReminder: (agentId) => (
          this.buildMemoryReminder(agentId, conversationRef.current)
        ),
        persistSubagentRun: (snapshot) => {
          const current = conversationRef.current;
          if (!current) return Promise.resolve();
          return this.persistSubagentRun(conversationId, current, snapshot);
        },
        notifySubagentRun: (snapshot) => {
          const current = conversationRef.current;
          if (!current) return Promise.resolve();
          return this.notifySubagentRun(conversationId, current, snapshot);
        },
        persistToolOutputPayload: (toolCallId, toolName, text) => (
          this.persistToolOutputPayload(conversationId, toolCallId, toolName, text)
        ),
        completeCompactSummary: (compactConversationId, messages, model, customInstructions, signal) => (
          this.completeCompactSummary(compactConversationId, messages, model, customInstructions, signal)
        ),
      },
    });
    subagentRuntime.updateDisabledAgents(runtimeSettings.disabledAgents ?? []);
    subagentRuntime.restoreListedAgentsFromMessages(activePath);
    const agent = providerConfig
      ? createConfiguredAgent(conversationId, providerConfig, activePath, this.outlinerToolHost, {
          localFileRoot: this.options.localFileRoot,
          localWorkspace,
          model: providerModel!,
          permissionMode: this.options.permissionMode,
          runtimeSettingsLoader: () => this.getRuntimeSettings(),
          skillToolEnabled: runtimeSettings.automaticSkillsEnabled,
          skillRuntime,
          subagentRuntime,
          recall: this.createRecallToolRuntime(this.agentIdentity.agentId, () => conversationId, () => conversationRef.current),
          askUserQuestion: this.createAskUserQuestionRuntime(() => conversationId, () => conversationRef.current),
          selfMaintenance: this.createSelfMaintenanceRuntime(() => conversationId, () => conversationRef.current),
          streamFn: this.options.streamFn,
          completeSimpleFn: this.options.completeSimpleFn,
          providerApiKeyLoader: this.options.providerApiKeyLoader,
          permissionClassifier: this.options.permissionClassifier,
          permissionEventHandler: (input) => {
            const current = conversationRef.current;
            return current ? this.appendToolPermissionEvent(conversationId, current, input) : Promise.resolve();
          },
          approvalHandler: (input, signal) => {
            const current = conversationRef.current;
            if (!current) return Promise.resolve({ approved: false, deniedReason: 'runtime' });
            return this.requestToolApproval(conversationId, current, input, signal);
          },
          afterToolResult: (toolCallId, toolName, result, isError) => {
            const current = conversationRef.current;
            if (!current) return undefined;
            return this.contextManager.afterToolResultForModelContext(conversationId, current, toolCallId, toolName, result, isError);
          },
        }, async (payload, model) => {
          try {
            await this.captureDebugPayload(conversationId, payload, model);
          } catch (error) {
            this.emitError(conversationId, error instanceof Error ? error.message : String(error));
          }
          return undefined;
        }, async (response, model) => {
          try {
            await this.captureDebugResponse(conversationId, response, model);
          } catch (error) {
            this.emitError(conversationId, error instanceof Error ? error.message : String(error));
          }
        })
      : createConfigurationErrorAgent(conversationId, 'No enabled agent provider is configured.', activePath);
    agentRef.current = agent;

    const debugCounters = await this.loadDebugCounters(conversationId);
    const conversation: AgentConversationState = {
      agent,
      activeRun: null,
      lastRun: null,
      autoCompactConsecutiveFailures: 0,
      autoCompactInProgress: false,
      eventState,
      activeCompaction: null,
      activeDream: null,
      currentDebugQueryIndex: 0,
      nextDebugQueryIndex: debugCounters.nextQueryIndex,
      nextDebugTurnIndex: debugCounters.nextTurnIndex,
      pendingDreamFinishedMarkers: [],
      pendingSubagentNotifications: [],
      pendingEventAppend: Promise.resolve(),
      pendingProjectionLastEventType: null,
      pendingProjectionTimer: null,
      queuedFollowUpSkillListingReservation: null,
      reactiveCompactRequested: false,
      revision: 0,
      subagentNotificationFlushInProgress: false,
      runtimeSettings,
      skillRuntime,
      subagentRuntime,
      localWorkspace,
      toolResultBudgetState: restoreToolResultBudgetStateFromMessages(getAgentEventActivePath(eventState)),
      memberDisplayNames: { [this.agentIdentity.agentId]: this.agentIdentity.displayName },
      channelRound: null,
      pendingChannelMessages: [],
      unsubscribe: null,
    };
    conversationRef.current = conversation;
    await this.refreshMemberDisplayNames(conversation);
    await this.markInterruptedSubagentsOnRestore(conversationId, conversation);
    conversation.subagentRuntime.restorePersistedRuns(await this.loadPersistedSubagentRuns(conversationId, conversation.eventState));
    agent.transformContext = async (_messages, signal) => this.contextManager.prepareModelContext(conversationId, conversation, signal);

    conversation.unsubscribe = agent.subscribe(async (event) => {
      await this.handlePiAgentEvent(conversationId, conversation, event);
      if (event.type === 'agent_end') {
        conversation.currentDebugQueryIndex = 0;
      }
      this.emitProjection(conversationId, event.type, event.type === 'message_update' ? 'coalesce' : 'immediate');
    });
    this.conversations.set(conversationId, conversation);
    this.emitProjection(conversationId, 'conversation_created');
    return conversation;
  }

  private async ensureConversationWithId(conversationId: string, titleOverride?: string) {
    const existing = this.conversations.get(conversationId);
    if (existing) return existing;
    let eventState = await this.loadEventState(conversationId);
    if (!eventState.conversation) {
      eventState = createEmptyAgentEventReplayState();
      const isDefaultDm = this.isDefaultDmConversationId(conversationId);
      const title = isDefaultDm ? this.agentIdentity.displayName : (titleOverride?.trim() || 'Untitled');
      const events = this.buildEvents(eventState, conversationId, [{
        type: 'conversation.created',
        actor: systemActor(),
        title,
        members: this.defaultConversationMembers(),
        goal: isDefaultDm ? undefined : title,
      }]);
      await this.getEventStore().appendEvents(conversationId, events);
      for (const event of events) appendAgentEventToReplayState(eventState, event);
      this.publishPersistedEvents(conversationId, events);
    }
    await this.createConversationWithEventState(eventState);
    return this.conversations.get(conversationId)!;
  }

  private beginDebugQuery(conversation: AgentConversationState) {
    if (conversation.currentDebugQueryIndex > 0) return;
    conversation.currentDebugQueryIndex = conversation.nextDebugQueryIndex;
    conversation.nextDebugQueryIndex += 1;
  }

  private async buildSkillListingReminder(conversation: AgentConversationState): Promise<string | null> {
    return (await this.reserveSkillListingReminder(conversation))?.text ?? null;
  }

  private async buildAgentListingReminder(conversation: AgentConversationState): Promise<string | null> {
    return conversation.subagentRuntime.reserveAgentListingReminderText(
      conversation.agent.state.model.contextWindow,
    );
  }

  private async reserveSkillListingReminder(conversation: AgentConversationState) {
    if (!conversation.runtimeSettings.automaticSkillsEnabled) return null;
    return conversation.skillRuntime.reserveSkillListingReminderText(
      conversation.agent.state.model.contextWindow,
    );
  }

  private releaseQueuedFollowUpSkillListing(conversation: AgentConversationState): void {
    if (!conversation.queuedFollowUpSkillListingReservation) return;
    conversation.skillRuntime.releaseSkillListingReservation(conversation.queuedFollowUpSkillListingReservation);
    conversation.queuedFollowUpSkillListingReservation = null;
  }

  /**
   * Refresh the agentId → display-name cache for the conversation's agent members.
   * Registry misses degrade to the mention token; never fail the caller.
   */
  private async refreshMemberDisplayNames(conversation: AgentConversationState): Promise<void> {
    const names: Record<string, string> = { [this.agentIdentity.agentId]: this.agentIdentity.displayName };
    const agentMembers = channelAgentMembers(conversation.eventState.conversation?.members ?? []);
    if (agentMembers.some((member) => member.agentId !== this.agentIdentity.agentId)) {
      try {
        const definitions = await conversation.subagentRuntime.listAllAgentDefinitions();
        for (const definition of definitions) {
          names[agentDefinitionAgentId(definition)] = agentDefinitionDisplayName(definition);
        }
      } catch {
        // Registry unavailable: projections fall back to mention tokens.
      }
    }
    conversation.memberDisplayNames = names;
  }

  private async refreshRuntimeSettings(conversation: AgentConversationState): Promise<AgentRuntimeSettings> {
    const runtimeSettings = await this.getRuntimeSettings();
    conversation.runtimeSettings = runtimeSettings;
    conversation.skillRuntime.updateAdditionalSkillDirectories(runtimeSettings.additionalSkillDirectories);
    conversation.skillRuntime.updateDisabledSkills(runtimeSettings.disabledSkills ?? []);
    conversation.subagentRuntime.updateDisabledAgents(runtimeSettings.disabledAgents ?? []);
    this.applyRuntimeToolSettings(conversation);
    return runtimeSettings;
  }

  private applyRuntimeToolSettings(conversation: AgentConversationState): void {
    conversation.subagentRuntime.updateAdditionalAgentDirectories(conversation.runtimeSettings.additionalAgentDirectories);
    conversation.agent.state.tools = createAgentTools(this.outlinerToolHost, {
      localFileRoot: this.options.localFileRoot,
      localWorkspace: conversation.localWorkspace,
      skillRuntime: conversation.skillRuntime,
      skillToolEnabled: conversation.runtimeSettings.automaticSkillsEnabled,
      subagentRuntime: conversation.subagentRuntime,
      recall: this.createRecallToolRuntime(this.agentIdentity.agentId, () => conversation.eventState.conversation?.id ?? 'unknown', () => conversation),
      askUserQuestion: this.createAskUserQuestionRuntime(() => conversation.eventState.conversation?.id ?? 'unknown', () => conversation),
      selfMaintenance: this.createSelfMaintenanceRuntime(() => conversation.eventState.conversation?.id ?? 'unknown', () => conversation),
    });
  }

  private createSubagentAgent(
    parentConversationId: string,
    parentConversationRef: { current: AgentConversationState | null },
    providerConfig: AgentProviderRuntimeConfig,
    input: AgentSubagentCreateInput,
  ): Agent {
    const inheritedModel = this.resolveProviderModel(providerConfig);
    const model = input.model
      ? resolveSkillModelOverride(input.model, providerConfig, inheritedModel)
      : inheritedModel;
    const thinkingLevel = input.effort
      ? resolveSkillEffortOverride(input.effort, model, providerConfig.reasoningLevel)
      : providerConfig.reasoningLevel;
    return createConfiguredAgent(input.conversationId, providerConfig, input.messages, this.outlinerToolHost, {
      localFileRoot: this.options.localFileRoot,
      localWorkspace: input.localWorkspace,
      model,
      thinkingLevel,
      permissionMode: input.permissionMode ?? this.options.permissionMode,
      runtimeSettingsLoader: () => this.getRuntimeSettings(),
      skillToolEnabled: true,
      skillRuntime: input.skillRuntime,
      subagentRuntime: input.subagentRuntime,
      recall: this.createRecallToolRuntime(
        input.memoryOwnerAgentId,
        () => input.conversationId,
        () => parentConversationRef.current,
      ),
      streamFn: this.options.streamFn,
      completeSimpleFn: this.options.completeSimpleFn,
      providerApiKeyLoader: this.options.providerApiKeyLoader,
      permissionClassifier: this.options.permissionClassifier,
      permissionEventHandler: (eventInput) => {
        const parentConversation = parentConversationRef.current;
        return parentConversation ? this.appendToolPermissionEvent(parentConversationId, parentConversation, eventInput) : Promise.resolve();
      },
      systemPrompt: input.systemPrompt,
      allowedTools: input.allowedTools,
      disallowedTools: input.disallowedTools,
      preapprovedToolRules: input.preapprovedToolRules,
      // Unattended (scheduled command) runs have NO interactive approval channel:
      // leaving it undefined makes an 'ask' decision resolve to a denial that is
      // surfaced in the conversation, rather than hanging on a human who will
      // never answer. Globally always-allowed tools still run (they resolve to
      // 'allow' before any approval is sought).
      approvalHandler: input.unattended
        ? undefined
        : (approvalInput, signal) => {
          const parentConversation = parentConversationRef.current;
          if (!parentConversation) return Promise.resolve({ approved: false, deniedReason: 'runtime' });
          return this.requestToolApproval(parentConversationId, parentConversation, approvalInput, signal);
        },
      afterToolResult: input.afterToolResult,
    }, async (payload, modelForPayload) => {
      try {
        await this.captureDebugPayload(input.conversationId, payload, modelForPayload);
      } catch {
        // Subagent sidechain persistence is intentionally isolated from parent UI errors.
      }
      return undefined;
    }, async (response, modelForResponse) => {
      try {
        await this.captureDebugResponse(input.conversationId, response, modelForResponse);
      } catch {
        // Subagent sidechain persistence is intentionally isolated from parent UI errors.
      }
    });
  }

  private async loadPersistedSubagentRuns(
    conversationId: string,
    eventState: AgentEventReplayState,
  ): Promise<AgentSubagentRestoredRun[]> {
    const runs: AgentSubagentRestoredRun[] = [];
    for (const record of Object.values(eventState.subagents ?? {})) {
      const payloadId = record.transcriptPayloadId;
      const payload = payloadId ? eventState.payloads[payloadId] : undefined;
      const transcriptMessages = payload
        ? await this.readSubagentTranscriptPayload(conversationId, payload)
        : [];
      runs.push({ record, transcriptMessages });
    }
    return runs;
  }

  private async markInterruptedSubagentsOnRestore(
    conversationId: string,
    conversation: AgentConversationState,
  ): Promise<void> {
    const runningRuns = Object.values(conversation.eventState.subagents ?? {})
      .filter((run) => run.status === 'running');
    if (runningRuns.length === 0) return;

    const interruptedError = 'Subagent was interrupted before conversation restore.';
    const completedAt = Date.now();
    await this.appendConversationEvents(conversationId, conversation, runningRuns.map((run): AgentEventInput => ({
      type: 'subagent_run.updated',
      actor: systemActor(),
      subagentRunId: run.id,
      status: 'failed',
      completedAt,
      error: interruptedError,
      transcriptMessageCount: run.transcriptMessageCount,
    })));

    // "Don't go silent": a background subagent that died while the app was closed
    // must still raise a durable badge (and OS banner) on restore — not vanish.
    // Durable delivery only here (no live model-injection): the conversation is being
    // restored, not running a turn, and recovery is re-spawn, not resume.
    for (const run of runningRuns) {
      await this.emitTaskNotification(conversationId, conversation, {
        notificationId: `notification-${run.id}-${completedAt}`,
        kind: 'task_failed',
        title: `Subagent "${run.description}" was interrupted.`,
        body: interruptedError,
        source: { type: 'subagent', subagentRunId: run.id },
        actor: run.parentToolCallId
          ? toolActor(AGENT_SUBAGENT_TOOL_NAME, run.parentToolCallId)
          : systemActor(),
      });
    }
  }

  private async readSubagentTranscriptPayload(
    conversationId: string,
    payload: AgentPayloadRef,
  ): Promise<AgentMessage[]> {
    return (await this.readSubagentTranscriptEnvelope(conversationId, payload))?.messages ?? [];
  }

  private async readSubagentTranscriptEnvelope(
    conversationId: string,
    payload: AgentPayloadRef,
  ): Promise<SubagentTranscriptEnvelope | null> {
    try {
      const raw = await this.getEventStore().readPayload(conversationId, payload);
      return parseSubagentTranscriptEnvelope(raw);
    } catch {
      return null;
    }
  }

  private async persistSubagentRun(
    conversationId: string,
    conversation: AgentConversationState,
    snapshot: AgentSubagentRunSnapshot,
  ): Promise<void> {
    const actor = snapshot.parentToolCallId
      ? toolActor(AGENT_SUBAGENT_TOOL_NAME, snapshot.parentToolCallId)
      : systemActor();
    const exists = Boolean(conversation.eventState.subagents[snapshot.id]);
    const existingRun = conversation.eventState.subagents[snapshot.id];
    const transcriptEnvelope = createSubagentTranscriptEnvelope({
      runId: snapshot.id,
      executingAgentId: snapshot.executingAgentId,
      parentAgentId: snapshot.parentAgentId,
      memoryOwnerAgentId: snapshot.memoryOwnerAgentId,
      dreamEvidenceStartMessageIndex: snapshot.dreamEvidenceStartMessageIndex,
      messages: snapshot.transcriptMessages,
    });
    const transcriptData = JSON.stringify(transcriptEnvelope);
    const transcriptSha = createHash('sha256').update(transcriptData).digest('hex');
    const existingPayload = existingRun?.transcriptPayloadId
      ? conversation.eventState.payloads[existingRun.transcriptPayloadId]
      : undefined;
    const payload = existingPayload?.sha256 === transcriptSha
      ? undefined
      : await this.getEventStore().writePayload(conversationId, {
          id: `subagent-transcript-${snapshot.id}-${snapshot.transcriptMessages.length}-${transcriptSha.slice(0, 12)}`,
          data: transcriptData,
          mimeType: 'application/json',
          role: 'subagent_transcript',
          summary: `Subagent ${snapshot.subagentType} transcript (${snapshot.transcriptMessages.length} messages)`,
        });
    await this.appendConversationEvents(conversationId, conversation, [
      ...(payload ? [{
        type: 'payload.created' as const,
        actor,
        payload,
      }] : []),
      exists
        ? {
            type: 'subagent_run.updated',
            actor,
            subagentRunId: snapshot.id,
            status: snapshot.status,
            completedAt: snapshot.completedAt,
            result: snapshot.result,
            error: snapshot.error,
            dreamEvidenceStartMessageIndex: snapshot.dreamEvidenceStartMessageIndex,
            transcriptPayload: payload,
            transcriptMessageCount: snapshot.transcriptMessages.length,
          }
        : {
            type: 'subagent_run.started',
            actor,
            subagentRunId: snapshot.id,
            parentToolCallId: snapshot.parentToolCallId,
            executingAgentId: snapshot.executingAgentId,
            parentAgentId: snapshot.parentAgentId,
            memoryOwnerAgentId: snapshot.memoryOwnerAgentId,
            memoryOriginWorkspace: snapshot.memoryOriginWorkspace,
            dreamEvidenceStartMessageIndex: snapshot.dreamEvidenceStartMessageIndex,
            name: snapshot.name,
            description: snapshot.description,
            prompt: snapshot.prompt,
            subagentType: snapshot.subagentType,
            contextMode: snapshot.contextMode,
            transcriptPayload: payload,
            transcriptMessageCount: snapshot.transcriptMessages.length,
          },
    ]);
    this.emitProjection(conversationId, exists ? 'subagent_run.updated' : 'subagent_run.started', 'coalesce');
  }

  private async notifySubagentRun(
    conversationId: string,
    conversation: AgentConversationState,
    snapshot: AgentSubagentRunSnapshot,
  ): Promise<void> {
    if (snapshot.status === 'running') return;
    // A user-initiated stop is the user's own action — it raises no badge/OS
    // banner (the durable notification below is for completion/failure only). The
    // live model-injection still fires so a foreground agent learns its child stopped.
    if (snapshot.status !== 'stopped') {
      // Durable per-conversation delivery: emit the attention/OS signal as a
      // notification.created event anchored to the origin conversation. This is the
      // restart-safe record (the in-memory model-injection below is the live-conversation
      // composed-turn layer; it is best-effort and not the durability guarantee).
      // The id keys on the completion instant so a *resumed* detached run that
      // finishes again gets a fresh notification (idempotent across replay, distinct
      // across re-completions — see agentSubagents `send`).
      await this.emitTaskNotification(conversationId, conversation, {
        notificationId: `notification-${snapshot.id}-${snapshot.completedAt ?? 0}`,
        kind: subagentNotificationKind(snapshot.status),
        title: subagentNotificationTitle(snapshot),
        body: snapshot.status === 'failed' ? snapshot.error : snapshot.result,
        source: { type: 'subagent', subagentRunId: snapshot.id },
        actor: snapshot.parentToolCallId
          ? toolActor(AGENT_SUBAGENT_TOOL_NAME, snapshot.parentToolCallId)
          : systemActor(),
      });
    }
    conversation.pendingSubagentNotifications.push(formatSubagentNotification(snapshot));
    void this.flushSubagentNotifications(conversationId, conversation).catch((error) => {
      this.emitError(conversationId, error instanceof Error ? error.message : String(error));
    });
  }

  /**
   * Append a durable notification.created event anchored to the origin
   * conversation, then surface it (projection + opt-in OS notification). Idempotent
   * on notificationId so a re-emitted terminal snapshot does not double-count.
   */
  private async emitTaskNotification(
    conversationId: string,
    conversation: AgentConversationState,
    input: {
      notificationId: string;
      kind: AgentNotificationKind;
      title: string;
      body?: string;
      source?: AgentTaskSource;
      actor?: AgentActor;
    },
  ): Promise<void> {
    if (conversation.eventState.notifications[input.notificationId]) return;
    const body = input.body ? truncateNotificationBody(input.body) : undefined;
    // The base conversationId (stamped at append) is the delivery anchor.
    await this.appendConversationEvents(conversationId, conversation, [{
      type: 'notification.created',
      actor: input.actor ?? systemActor(),
      notificationId: input.notificationId,
      kind: input.kind,
      title: input.title,
      body,
      source: input.source,
    }]);
    // No emitProjection here: the render projection never reads notifications or
    // attention (the badge rides the dedicated conversation_attention event), so a
    // rebuild would produce byte-identical content. Attention is the only signal.
    this.emitConversationAttention(conversationId, conversation);
    this.deliverOsNotification({ title: input.title, body, conversationId });
  }

  private async flushSubagentNotifications(conversationId: string, conversation: AgentConversationState): Promise<void> {
    if (conversation.subagentNotificationFlushInProgress) return;
    if (conversation.pendingSubagentNotifications.length === 0) return;
    // A notification-delivery run is the COORDINATOR's turn (its subagents);
    // never interleave it into an active Channel round between member turns.
    if (conversation.channelRound) return;
    if (this.activeRunId(conversation) || conversation.agent.state.isStreaming) return;

    conversation.subagentNotificationFlushInProgress = true;
    let startedRunId: string | null = null;
    try {
      while (conversation.pendingSubagentNotifications.length > 0) {
        if (conversation.channelRound) break;
        if (this.activeRunId(conversation) || conversation.agent.state.isStreaming) break;
        const notifications = conversation.pendingSubagentNotifications.splice(0);
        const prompt: UserMessage = {
          role: 'user',
          timestamp: Date.now(),
          content: [{ type: 'text', text: systemReminder(notifications.join('\n\n')) }],
        };
        conversation.skillRuntime.resetRunPermissionRules();
        this.beginDebugQuery(conversation);
        await this.appendSystemPromptEvent(conversationId, conversation, prompt);
        startedRunId = await this.startRun(conversationId, conversation, prompt);
        await conversation.agent.prompt(prompt);
        await this.contextManager.runReactiveCompactRetryIfNeeded(conversationId, conversation);
        await this.persistAndEmitIdle(conversationId, conversation, { flushSubagentNotifications: false });
      }
    } catch (error) {
      await this.recoverFromRunError(conversationId, startedRunId);
      this.emitError(conversationId, error instanceof Error ? error.message : String(error));
    } finally {
      conversation.subagentNotificationFlushInProgress = false;
    }
    // Messages queued while a notification-delivery run was live route now.
    await this.drainChannelQueueIfIdle(conversationId, conversation);
  }

  private async persistToolOutputPayload(
    conversationId: string,
    toolCallId: string,
    toolName: string,
    text: string,
  ): Promise<{ payload: AgentPayloadRef; label: string }> {
    const conversation = this.conversations.get(conversationId);
    const runId = conversation ? this.activeRunId(conversation) ?? undefined : undefined;
    const payload = await this.getEventStore().writePayload(conversationId, {
      id: `tool-output-${toolCallId}`,
      data: text,
      mimeType: 'text/plain',
      runId,
      role: 'tool_output',
      summary: summarizeTextPayload(text, `${toolName} output`),
      truncated: true,
    });
    return {
      payload,
      label: buildPersistedToolOutputMessage(payload, text),
    };
  }

  private async completeCompactSummary(
    conversationId: string,
    messages: readonly AgentMessage[],
    modelOverride?: Model<Api>,
    customInstructions?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);
    const providerConfig = await this.getActiveProviderConfig();
    throwIfAborted(signal);
    if (!providerConfig) throw new Error('No enabled agent provider is configured.');
    const model = modelOverride ?? this.resolveProviderModel(providerConfig);
    const apiKey = providerConfig.apiKey ?? await this.getProviderApiKey(providerConfig.providerId);
    const runtimeSettings = await this.getRuntimeSettings();
    let messagesToSummarize = [...messages];

    for (let attempt = 0; ; attempt += 1) {
      throwIfAborted(signal);
      const request = buildCompactSummaryRequest(messagesToSummarize, customInstructions);
      const response = await awaitWithAbort((this.options.completeSimpleFn ?? completeSimple)(model, {
        messages: [request],
        tools: [],
      }, {
        ...providerStreamOptionsFromRuntimeSettings(runtimeSettings),
        apiKey,
        maxTokens: Math.min(model.maxTokens ?? COMPACT_SUMMARY_MAX_OUTPUT_TOKENS, COMPACT_SUMMARY_MAX_OUTPUT_TOKENS),
        // pi-ai stream option (provider cache affinity) — the lib's own field name.
        sessionId: conversationId,
        signal,
        onPayload: async (payload, payloadModel) => {
          try {
            await this.captureDebugPayload(conversationId, payload, payloadModel);
          } catch {
            // Subagent compact debug capture must not break the child run.
          }
          return undefined;
        },
        onResponse: async (responsePayload, responseModel) => {
          try {
            await this.captureDebugResponse(conversationId, responsePayload, responseModel);
          } catch {
            // Subagent compact debug capture must not break the child run.
          }
        },
      }), { signal });

      const canRetry = (response.stopReason === 'error' || response.stopReason === 'aborted')
        && isContextOverflow(response, model.contextWindow)
        && attempt < 3;
      if (canRetry) {
        const errorText = response.errorMessage ?? assistantMessageText(response);
        const truncated = truncateCompactMessagesForPromptTooLongRetry(messagesToSummarize, errorText);
        if (truncated) {
          messagesToSummarize = truncated;
          continue;
        }
      }
      if (response.stopReason === 'error' || response.stopReason === 'aborted') {
        throw new Error(response.errorMessage || 'Compaction failed.');
      }
      const summary = formatCompactSummary(assistantMessageText(response));
      if (!summary) throw new Error('Compaction failed: no summary text returned.');
      return summary;
    }
  }

  private async captureDebugPayload(
    conversationId: string,
    payload: unknown,
    model: Model<any>,
    source: AgentDebugSnapshot['source'] = 'provider_payload',
  ) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    this.beginDebugQuery(conversation);
    const turnIndex = conversation.nextDebugTurnIndex;
    const debugId = `debug-${randomUUID()}`;
    const envelope = createAgentDebugPayloadEnvelope(payload);
    const sourceLabel = source === 'provider_response' ? 'Provider response' : 'Provider payload';
    const payloadRef = await this.getEventStore().writePayload(conversationId, {
      id: `${debugId}-payload`,
      data: envelope.json,
      mimeType: 'application/json',
      runId: this.activeRunId(conversation) ?? undefined,
      role: 'debug',
      summary: `${sourceLabel} round ${turnIndex}`,
    });
    await this.appendConversationEvents(conversationId, conversation, [{
      type: 'payload.created',
      actor: systemActor(),
      runId: this.activeRunId(conversation) ?? undefined,
      payload: payloadRef,
    }, {
      type: 'debug.snapshot.created',
      actor: systemActor(),
      runId: this.activeRunId(conversation) ?? undefined,
      debugId,
      source,
      queryIndex: conversation.currentDebugQueryIndex,
      turnIndex,
      payloadRef,
      wire: {
        bytes: envelope.bytes,
        hash: envelope.hash,
      },
      model: debugModelMetadata(model),
    }]);
    conversation.nextDebugTurnIndex += 1;
    this.debugProjectionCache.delete(conversationId);
  }

  private async captureDebugResponse(conversationId: string, response: ProviderResponse, model: Model<any>) {
    await this.captureDebugPayload(conversationId, {
      status: response.status,
      headers: response.headers,
    }, model, 'provider_response');
  }

  private getRuntimeDebugSnapshot(conversationId: string, conversation: AgentConversationState) {
    const state = conversation.agent.state;
    return createRuntimeStateDebugSnapshot({
      messages: state.messages as AgentMessage[],
      model: state.model as Model<any>,
      queryIndex: 0,
      conversationId: conversationId,
      conversationTitle: sanitizeConversationTitle(conversation.eventState.conversation?.title),
      systemPrompt: state.systemPrompt,
      thinkingLevel: state.thinkingLevel,
      tools: state.tools,
    });
  }

  private async deriveDebugProjection(conversationId: string): Promise<{
    history: AgentDebugSnapshot[];
    latestSeq: number;
    totals: AgentDebugTotals;
  }> {
    const events = await this.getEventStore().readEvents(conversationId);
    const latestSeq = events.at(-1)?.seq ?? 0;
    const cached = this.debugProjectionCache.get(conversationId);
    if (cached?.latestSeq === latestSeq) return cached;

    const projection = await deriveAgentDebugProjectionFromEvents({
      events,
      readPayload: (payload) => this.getEventStore().readPayload(conversationId, payload),
      conversationId: conversationId,
      conversationTitle: sanitizeConversationTitle(this.conversations.get(conversationId)?.eventState.conversation?.title),
    });
    this.debugProjectionCache.set(conversationId, projection);
    return projection;
  }

  private async loadDebugCounters(conversationId: string): Promise<{ nextQueryIndex: number; nextTurnIndex: number }> {
    const events = await this.getEventStore().readEvents(conversationId);
    let maxQueryIndex = 0;
    let maxTurnIndex = 0;
    for (const event of events) {
      if (!isDebugSnapshotCreatedEvent(event)) continue;
      maxQueryIndex = Math.max(maxQueryIndex, event.queryIndex);
      maxTurnIndex = Math.max(maxTurnIndex, event.turnIndex);
    }
    return {
      nextQueryIndex: maxQueryIndex + 1,
      nextTurnIndex: maxTurnIndex + 1,
    };
  }

  private async persistAndEmitIdle(
    conversationId: string,
    conversation: AgentConversationState,
    options: { flushSubagentNotifications?: boolean } = {},
  ) {
    await this.flushPendingDreamFinishedEvents(conversationId, conversation);
    conversation.agent.state.messages = await this.deriveRuntimePiMessages(conversationId, conversation.eventState) as never;
    this.emitProjection(conversationId, 'agent_idle');
    if (options.flushSubagentNotifications !== false) {
      await this.flushSubagentNotifications(conversationId, conversation);
    }
  }

  private async flushPendingDreamFinishedEvents(conversationId: string, conversation: AgentConversationState): Promise<void> {
    while (conversation.pendingDreamFinishedMarkers.length > 0) {
      const result = conversation.pendingDreamFinishedMarkers.shift();
      if (!result) continue;
      await this.appendDreamFinishedEvent(conversationId, conversation, result);
    }
  }

  private startDreamScheduler() {
    if (!this.dreamMemoryExtractionEnabled() || this.dreamSchedulerTimer) return;
    this.dreamSchedulerTimer = setInterval(() => {
      this.queueScheduledDream(new Date());
    }, DREAM_SCHEDULER_INTERVAL_MS);
    (this.dreamSchedulerTimer as { unref?: () => void }).unref?.();
  }

  private startCommandScheduler() {
    if (this.commandSchedulerTimer) return;
    this.commandSchedulerTimer = setInterval(() => {
      this.queueCommandSweep(new Date());
    }, COMMAND_SCHEDULER_INTERVAL_MS);
    (this.commandSchedulerTimer as { unref?: () => void }).unref?.();
  }

  // Teardown for the recurring scheduler timer (called on dispose / before-quit).
  // `.unref()` already keeps it from blocking exit; this stops it cleanly so a
  // disposed runtime (e.g. a test instance) leaves no live interval behind.
  stopCommandScheduler() {
    if (!this.commandSchedulerTimer) return;
    clearInterval(this.commandSchedulerTimer);
    this.commandSchedulerTimer = null;
  }

  /**
   * Settle in-flight best-effort writes so a force-exit on quit (see main.ts's
   * before-quit, which `app.exit`s after this) doesn't truncate them mid-write:
   * each conversation's event-log append (the integrity-critical fast local write),
   * plus the dream-extraction and command-sweep tails. The latter two are
   * crash-safe — their watermarks only advance on success, so a cut dream/sweep
   * simply re-fires next launch — so the CALLER SHOULD bound this with a timeout;
   * a slow in-flight dream (an LLM call) must not block ⌘Q.
   */
  async drainPendingWrites(): Promise<void> {
    // Queued Channel messages live only in main-process memory until a round
    // routes them — flush them into the log first (unrouted; they render in the
    // thread after restart) so nothing the user typed vanishes on quit.
    for (const [conversationId, conversation] of this.conversations.entries()) {
      const queued = conversation.pendingChannelMessages.splice(0);
      for (const entry of queued) {
        try {
          await this.persistPendingChannelMessage(conversationId, conversation, entry);
        } catch (error) {
          // Best-effort on the quit path; the event-append settle below still runs.
          console.warn(
            `Failed to flush a queued Channel message for ${conversationId} at quit: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    const pending: Promise<unknown>[] = [this.dreamMemoryExtractionTail, this.commandSweepTail];
    for (const conversation of this.conversations.values()) pending.push(conversation.pendingEventAppend);
    await Promise.allSettled(pending);
  }

  // Catch-up hook for app launch (see ready()) and `powerMonitor.resume` (wired
  // in main.ts). Idle-safe: queued behind any in-flight sweep.
  runCommandCatchUp() {
    this.queueCommandSweep(new Date());
  }

  private queueCommandSweep(now: Date) {
    this.commandSweepTail = this.commandSweepTail
      .catch(() => undefined)
      .then(() => this.sweepCommandSchedules(now));
  }

  private queueCommandReconcile() {
    this.commandSweepTail = this.commandSweepTail
      .catch(() => undefined)
      .then(() => this.reconcileCommandAttempts());
  }

  // One-time startup crash recovery for at-most-once scheduled runs. An occurrence
  // is attempted (`mark_command_attempted` → `sysLastAttemptAt = dueAt`) BEFORE it
  // runs; success advances `sysLastRunAt` past it. So at launch, any command with
  // `sysLastAttemptAt > sysLastRunAt` was interrupted mid-run (crash/quit/sleep):
  // advance the watermark past that occurrence rather than re-firing it — the
  // brief's non-idempotent side effects must not repeat. The due check never reads
  // the attempt marker, so an in-process run *failure* still retries (it is gated
  // by the in-memory backoff, not by this reconciliation).
  private async reconcileCommandAttempts() {
    let projection;
    try {
      projection = this.outlinerToolHost.getProjection();
    } catch {
      return;
    }
    for (const node of projection.nodes) {
      if (node.type !== 'command') continue;
      const attemptedAt = node.sysLastAttemptAt;
      if (attemptedAt === undefined || attemptedAt <= (node.sysLastRunAt ?? 0)) continue;
      await this.outlinerToolHost.handle(
        'mark_command_fired',
        { nodeId: node.id, firedAt: attemptedAt },
        { origin: 'system', summary: 'Reconciled an interrupted command run.' },
      ).catch(() => undefined);
    }
  }

  private async sweepCommandSchedules(now: Date) {
    let projection;
    try {
      projection = this.outlinerToolHost.getProjection();
    } catch {
      return;
    }
    this.pruneCommandRuntimeState(projection);
    const due = selectDueCommands(projection, now);
    for (const command of due) {
      if (this.firingCommandNodeIds.has(command.nodeId)) continue;
      const backoffUntil = this.commandBackoffUntil.get(command.nodeId);
      if (backoffUntil !== undefined && backoffUntil > now.getTime()) continue;
      // Fire concurrently — do NOT await here. `fireCommand` self-guards via
      // `firingCommandNodeIds` and never rejects, so one slow/hung command can't
      // block the others (or, via the sweep tail, every subsequent sweep).
      void this.fireCommand(command, now);
    }
  }

  // Reconcile in-memory command state against the live document: prune backoff
  // entries for nodes that no longer exist, and delete the delivery conversation
  // of a command node that was permanently removed (trashed nodes are still
  // present, so their conversation is preserved for restore).
  private pruneCommandRuntimeState(projection: DocumentProjection) {
    if (
      this.commandFailureCounts.size === 0
      && this.commandBackoffUntil.size === 0
      && this.knownCommandConversationNodeIds.size === 0
    ) return;
    const live = liveCommandNodeIds(projection);
    for (const nodeId of [...this.commandFailureCounts.keys()]) {
      if (!live.has(nodeId)) this.commandFailureCounts.delete(nodeId);
    }
    for (const nodeId of [...this.commandBackoffUntil.keys()]) {
      if (!live.has(nodeId)) this.commandBackoffUntil.delete(nodeId);
    }
    for (const nodeId of [...this.knownCommandConversationNodeIds]) {
      if (live.has(nodeId)) continue;
      this.knownCommandConversationNodeIds.delete(nodeId);
      void this.deleteConversation(
        this.commandConversationId(nodeId),
      ).catch(() => undefined);
    }
  }

  private async fireCommand(command: DueCommand, now: Date) {
    this.firingCommandNodeIds.add(command.nodeId);
    this.knownCommandConversationNodeIds.add(command.nodeId);
    try {
      // At-most-once: persist the attempted occurrence BEFORE running, so a
      // crash / quit / sleep mid-run is reconciled at startup (the occurrence is
      // skipped, not re-fired) instead of repeating the brief's non-idempotent
      // side effects. Done first inside the try: if even this write fails we back
      // off rather than run un-recorded. (An in-process run failure still retries
      // — the due check ignores this marker; only startup reconciliation reads it.)
      await this.outlinerToolHost.handle(
        'mark_command_attempted',
        { nodeId: command.nodeId, attemptedAt: command.dueAt },
        { origin: 'system', summary: 'Command occurrence attempted.' },
      );
      await this.startTriggeredRun(command);
      // Success: advance the watermark (system origin — never agent-written) so
      // the occurrence is not re-fired, and clear any failure backoff. Use the
      // COMPLETION time, not the sweep-start `now`: a run that straddled the next
      // occurrence boundary would otherwise leave a watermark before it and
      // double-fire. `markCommandFired` is forward-only, so this never regresses
      // a fresher user re-arm.
      await this.outlinerToolHost.handle(
        'mark_command_fired',
        { nodeId: command.nodeId, firedAt: Date.now() },
        { origin: 'system', summary: 'Command schedule fired.' },
      );
      this.commandFailureCounts.delete(command.nodeId);
      this.commandBackoffUntil.delete(command.nodeId);
    } catch (error) {
      // Failure does NOT advance the watermark — the occurrence stays due.
      // Apply an in-memory backoff so a persistently failing command (e.g. no
      // provider configured) does not tight-loop.
      const attempt = this.commandFailureCounts.get(command.nodeId) ?? 0;
      this.commandFailureCounts.set(command.nodeId, attempt + 1);
      const delay = COMMAND_FAILURE_BACKOFF_MS[Math.min(attempt, COMMAND_FAILURE_BACKOFF_MS.length - 1)];
      // Backoff from the FAILURE moment, not the sweep-start `now`: a slow run can
      // straddle the next sweep, and `now + delay` could already be in the past,
      // collapsing the 30s/1m/5m/15m/1h ladder into a 60s tight-retry loop.
      this.commandBackoffUntil.set(command.nodeId, Date.now() + delay);
      this.emitError(
        this.commandConversationId(command.nodeId),
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.firingCommandNodeIds.delete(command.nodeId);
    }
  }

  // One delivery conversation per command node — a stable id derived from the
  // node id so every fire posts into a single thread (find-or-created on each
  // fire; tolerant of the conversation being deleted).
  private commandConversationId(nodeId: string): string {
    return `lin-agent-command-${hashJson({ agentId: this.agentIdentity.agentId, nodeId }).slice(0, 16)}`;
  }

  // A scheduled fire: no human turn, runs as a subagent on the delivery conversation.
  private async startTriggeredRun(command: DueCommand): Promise<void> {
    const brief = command.brief.trim();
    // Defensive: `selectDueCommands` already drops empty-brief commands, so this
    // throw is unreachable in normal operation — but it guarantees an empty
    // command can never reach the watermark advance in `fireCommand`.
    if (!brief) throw new Error('This command has no brief to run.');
    await this.runCommandSubagent(
      this.commandConversationId(command.nodeId),
      brief,
      command.commandAgent,
      command.lastSuccessAt,
    );
  }

  // Ensure a command node's delivery conversation EXISTS ON DISK (a `conversation.created`
  // titled from the brief) and return its id — without materializing an in-memory
  // conversation. The renderer awaits this, then selects the conversation (which loads
  // the single in-memory conversation via `restoreConversation`), then runs it. Doing
  // the persist here instead of `ensureConversationWithId` is deliberate: creating an
  // in-memory conversation here AND again on restore would `abort()` + recreate the
  // conversation mid-flight, diverging the event seq ("seq N is not after existing M").
  async ensureCommandConversation(nodeId: string): Promise<{ conversationId: string }> {
    const node = this.outlinerToolHost.getProjection().nodes.find((entry) => entry.id === nodeId);
    if (!node || node.type !== 'command') throw new Error('Not a command node.');
    const conversationId = this.commandConversationId(nodeId);
    this.knownCommandConversationNodeIds.add(nodeId);
    // Already live (a prior run/restore) — nothing to persist; restore will reuse it.
    if (!this.conversations.has(conversationId)) {
      const loaded = await this.loadEventState(conversationId);
      if (!loaded.conversation) {
        const title = commandConversationTitle(node.content.text);
        const eventState = createEmptyAgentEventReplayState();
        const events = this.buildEvents(eventState, conversationId, [{
          type: 'conversation.created',
          actor: systemActor(),
          title,
          members: this.defaultConversationMembers(),
          goal: title,
        }]);
        await this.getEventStore().appendEvents(conversationId, events);
        this.publishPersistedEvents(conversationId, events);
      }
    }
    return { conversationId: conversationId };
  }

  // Run now (attended): the same execution path with a `node` trigger and NO
  // watermark advance, so testing a command never disturbs its schedule.
  // Returns the delivery conversation so the caller can surface it.
  async runCommandNow(nodeId: string): Promise<{ conversationId: string }> {
    const projection = this.outlinerToolHost.getProjection();
    const node = projection.nodes.find((entry) => entry.id === nodeId);
    if (!node || node.type !== 'command') throw new Error('Not a command node.');
    const conversationId = this.commandConversationId(nodeId);
    // Coordinate with the scheduled sweep via the same guard set. If a fire (or
    // another Run-now) for this node is already in flight, surface the existing
    // delivery conversation instead of starting a colliding second run — and the
    // sweep, which skips nodes in this set, won't treat the attended run as a
    // schedule failure.
    if (this.firingCommandNodeIds.has(nodeId)) {
      return { conversationId: conversationId };
    }
    // Build the same brief a scheduled fire does: title + non-field child outline,
    // with inline references reconstructed (see `commandBriefText`).
    const byId = new Map(projection.nodes.map((entry) => [entry.id, entry]));
    const brief = commandBriefText(node, byId).trim();
    if (!brief) throw new Error('This command has no brief to run.');
    this.firingCommandNodeIds.add(nodeId);
    this.knownCommandConversationNodeIds.add(nodeId);
    try {
      await this.runCommandSubagent(conversationId, brief, node.commandAgent, node.sysLastRunAt ?? null);
      return { conversationId: conversationId };
    } finally {
      this.firingCommandNodeIds.delete(nodeId);
    }
  }

  // Shared no-human-turn execution for command runs (scheduled + Run-now). The
  // brief — the command title plus its non-field child outline (see
  // `commandBriefText`) — is run as a SUBAGENT anchored to the command's own
  // delivery conversation, so every fire shows up as a task in that conversation's
  // task panel. `agent` picks the executing agent definition (an
  // `AgentDefinition.name`); empty forks the otherwise-empty delivery conversation
  // so the run executes under the main agent's identity and capabilities. Resolves
  // only when the subagent reaches a terminal state; throws on failure/stop so the
  // caller leaves the watermark unadvanced and arms the failure backoff.
  private async runCommandSubagent(
    conversationId: string,
    brief: string,
    agent: string | undefined,
    lastSuccessAt: number | null,
  ): Promise<void> {
    const conversation = await this.ensureConversationWithId(conversationId, commandConversationTitle(brief));
    await this.refreshRuntimeSettings(conversation);
    const subagentType = agent?.trim() ? agent.trim() : undefined;
    let data = await conversation.subagentRuntime.invokeAgent({
      subagent_type: subagentType,
      description: commandConversationTitle(brief),
      prompt: buildTriggeredCommandPrompt(brief, lastSuccessAt),
      run_in_background: false,
      // Unattended: a scheduled run has no human watching, so a tool needing
      // approval is denied + surfaced (never hangs the run); globally
      // always-allowed tools still run. Run-now keeps the interactive channel.
      unattended: true,
    });
    // `run_in_background: false` awaits completion, but an agent definition flagged
    // `background: true` launches detached regardless — poll to completion so the
    // watermark only ever advances on a finished run.
    while (data.status === 'async_launched' || data.status === 'queued' || data.status === 'running') {
      data = await conversation.subagentRuntime.status({
        agent_id: data.agent_id,
        wait: true,
        timeout_ms: COMMAND_SUBAGENT_WAIT_MS,
      });
    }
    if (data.status === 'failed' || data.error) throw new Error(data.error || 'The command run failed.');
    if (data.status === 'stopped') throw new Error('The command run was stopped before completing.');
  }

  private queueScheduledDream(now: Date) {
    if (!this.dreamMemoryExtractionEnabled()) return;
    this.dreamMemoryExtractionTail = this.dreamMemoryExtractionTail
      .catch(() => undefined)
      .then(() => this.fireDream('schedule', now));
  }

  private async runManualDreamFromConversation(conversationId: string) {
    if (!this.dreamMemoryExtractionEnabled()) return;
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    const activeDreamId = this.beginDream(conversationId, conversation);
    const result = await this.fireManualDream(new Date());
    try {
      await this.appendDreamFinishedEvent(conversationId, conversation, result);
    } finally {
      this.finishDream(conversationId, conversation, activeDreamId, 'dream.finished');
    }
  }

  /**
   * One scheduled pass = one Dream per pool ([[agent-data-model]] §4: one writer, one subject,
   * one activity layer each). Pools are independent: one pool throwing (e.g. a provider error)
   * must not abort the rest of the pass. `runDreamMemoryExtractionTask` already records its own
   * failures; the guard here only covers task-creation throws.
   */
  private async fireDream(trigger: AgentDreamTrigger, now: Date): Promise<void> {
    const principals = await this.listDreamPrincipals();
    // Drop failure-backoff entries for pools that are no longer dream principals (e.g. a deleted
    // agent), so the in-memory map stays bounded to live pools. A live pool with an armed window
    // is always in this set (it ran a Dream to arm it), so its backoff is never pruned here.
    const liveKeys = new Set(principals.map(principalKey));
    for (const key of this.dreamFailureBackoff.keys()) {
      if (!liveKeys.has(key)) this.dreamFailureBackoff.delete(key);
    }
    for (const principal of principals) {
      try {
        await this.fireDreamForPool(principal, trigger, now);
      } catch (error) {
        console.warn(`Dream pass failed for ${principalKey(principal)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Every pool with a Dream: the user pool plus each known agent's pool. */
  private async listDreamPrincipals(): Promise<AgentPrincipal[]> {
    const agentIds = await this.listDreamAgentIds();
    return [this.userPrincipal(), ...agentIds.map((agentId): AgentPrincipal => ({ type: 'agent', agentId }))];
  }

  /** Run one pool's Dream, serialized per pool by `principalKey`. */
  private async fireDreamForPool(
    principal: AgentPrincipal,
    trigger: AgentDreamTrigger,
    now: Date,
  ): Promise<AgentDreamRunResult | null> {
    const guardKey = principalKey(principal);
    if (this.dreamingPools.has(guardKey)) {
      return trigger === 'manual'
        ? skippedDreamRunResult(this.agentIdentity.agentId, trigger, now, 'Dream is already running for this pool.')
        : null;
    }
    // A scheduled Dream stuck failing backs off so it stops re-firing every tick (see
    // dreamFailureBackoff); a manual /dream ignores the window — the user asked for it now, and
    // its outcome still resets the backoff so a manual run can un-stick the schedule.
    if (trigger === 'schedule') {
      const backoff = this.dreamFailureBackoff.get(guardKey);
      if (backoff && now.getTime() < backoff.nextAttemptAt) return null;
    }
    this.dreamingPools.add(guardKey);
    try {
      const task = await this.createDreamMemoryExtractionTask(principal, trigger, now);
      if (!task) return null;
      const result = await this.runDreamMemoryExtractionTask(task);
      this.recordDreamFailureBackoff(guardKey, result, now);
      return result;
    } finally {
      this.dreamingPools.delete(guardKey);
    }
  }

  /**
   * Fold a Dream outcome into the pool's failure-backoff window: clear it on success, grow it
   * (exponential, capped) on failure. A `skipped` outcome means no attempt ran, so it leaves the
   * window untouched.
   */
  private recordDreamFailureBackoff(guardKey: string, result: AgentDreamRunResult, now: Date): void {
    if (result.status === 'completed') {
      this.dreamFailureBackoff.delete(guardKey);
    } else if (result.status === 'failed') {
      const consecutiveFailures = (this.dreamFailureBackoff.get(guardKey)?.consecutiveFailures ?? 0) + 1;
      this.dreamFailureBackoff.set(guardKey, {
        consecutiveFailures,
        nextAttemptAt: now.getTime() + dreamFailureBackoffMs(consecutiveFailures),
      });
    }
  }

  /**
   * A manual /dream fires the user pool's Dream: it consolidates the user's member
   * conversations since the Dream watermark — in practice the current conversation's new
   * turns — into durable user memory. Conversation evidence models the user
   * ([[agent-data-model]] §4); agent self-models (run logs) consolidate on schedule, not on
   * demand. The run is folded into the Dream tail so a quit-time drain awaits an in-flight
   * manual Dream instead of tearing the pool's trailing JSONL line — folded, not serialized
   * behind it: concurrent Dreams on the same pool are the `dreamingPools` guard's job (a
   * second /dream skips immediately rather than queueing).
   */
  private fireManualDream(now: Date): Promise<AgentDreamRunResult> {
    const work = this.runManualDream(now);
    this.dreamMemoryExtractionTail = Promise.all([
      this.dreamMemoryExtractionTail.catch(() => undefined),
      work.then(() => undefined, () => undefined),
    ]).then(() => undefined);
    return work;
  }

  private async runManualDream(now: Date): Promise<AgentDreamRunResult> {
    try {
      return await this.fireDreamForPool(this.userPrincipal(), 'manual', now)
        ?? skippedDreamRunResult(this.agentIdentity.agentId, 'manual', now, 'Dream is unavailable for the current memory/provider configuration.');
    } catch (error) {
      return {
        agentId: this.agentIdentity.agentId,
        trigger: 'manual',
        status: 'failed',
        startedAt: now.getTime(),
        completedAt: Date.now(),
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Build one pool's Dream task. A principal's Dream reads that principal's own activity layer
   * ([[agent-data-model]] §4: one writer, one subject, one activity layer each): an agent-Dream
   * models the agent's working self from its run log (execution); the user-Dream models the
   * person from the conversations they are a member of (communication, both sides). Everything
   * else — schedule gate, volume gate, batching, watermark — is the same machinery for every
   * pool. Concurrent passes are safe: the store serializes by principalKey and the watermark
   * skips already-consolidated evidence.
   */
  private async createDreamMemoryExtractionTask(
    principal: AgentPrincipal,
    trigger: AgentDreamTrigger,
    now: Date,
  ): Promise<AgentDreamMemoryExtractionTask | null> {
    if (!this.dreamMemoryExtractionEnabled()) return null;
    const memoryScope = await this.dreamMemoryScope();
    if (memoryScope.readOnly) return null;
    if (!await this.getActiveProviderConfig()) return null;

    const dreamState = await this.getEventStore().readDreamState(principal);
    const scheduleDecision = shouldFireDateSchedule(DEFAULT_DREAM_SCHEDULE, now, dreamState.lastSuccessAt);
    if (trigger === 'schedule' && !scheduleDecision.shouldFire) return null;

    const runId = `dream-run-${randomUUID()}`;
    const evidence = principal.type === 'agent'
      ? {
          conversations: [],
          agentRuns: await this.collectDreamAgentRunInputs(
            principal.agentId,
            dreamState.watermark,
            await this.getEventStore().listConversationIds(),
          ),
        }
      : {
          conversations: await this.collectDreamConversationInputs(dreamState),
          agentRuns: [],
        };
    const evidenceSpan = buildDreamMemoryExtractionSpanFromEvidence(runId, evidence);
    const newVolume = evidenceSpan?.totalCharCount ?? 0;
    if (trigger === 'schedule' && newVolume < DREAM_MIN_VOLUME_CHARS) return null;

    const span = evidenceSpan ?? (trigger === 'manual'
      ? buildConsolidateOnlyDreamMemoryExtractionSpan(runId)
      : null);
    if (!span) return null;
    const batches = evidenceSpan
      ? this.buildDreamMemoryExtractionBatches(runId, memoryScope, evidence)
      : [{ span, originWorkspace: memoryScope.originWorkspace }];
    if (batches.length === 0) return null;

    return {
      runId,
      principal,
      trigger,
      startedAt: Date.now(),
      dueAt: scheduleDecision.dueAt?.getTime(),
      span,
      batches,
      watermark: dreamWatermarkFromSpan(dreamState.watermark, span.sourceRanges),
    };
  }

  /** Conversation evidence for the user-Dream: new events in the user's member conversations. */
  private async collectDreamConversationInputs(dreamState: AgentDreamState) {
    const conversationIds = await this.userMemberConversationIds();
    return Promise.all(conversationIds.map(async (conversationId) => ({
      conversationId,
      events: await this.getEventStore().readEvents(conversationId),
      fromSeqExclusive: dreamState.watermark.conversations[conversationId]?.seq ?? 0,
    })));
  }

  /** Conversation ids the user principal is a member of (the user-Dream's evidence set). */
  private async userMemberConversationIds(): Promise<string[]> {
    const user = this.userPrincipal();
    const entries = await this.getEventStore().listConversationIndexEntries();
    return entries
      .filter((entry) => entry.members.some((member) => samePrincipal(member, user)))
      .map((entry) => entry.id);
  }

  /**
   * Whether the user is a member of this reader's conversation — the gate for sharing the user
   * pool ([[agent-data-model]] §4 visibility = membership).
   *
   * Reach, honestly stated: subagent recall/briefing are wired to the PARENT conversation, and every
   * user-created conversation has the user as a member, so today this returns true on all live
   * paths — subagents INHERIT user-pool visibility by design (they act inside the user's
   * conversation on the user's task; sidechains are not separate conversations with their own
   * member lists in M0). The membership check is the forward rule for when non-user-member
   * conversations exist (e.g. agent↔agent channels); missing membership info defaults open
   * because today a conversation without members cannot be anything but user-created.
   */
  private conversationIncludesUser(conversation: AgentConversationState | null): boolean {
    const members = conversation?.eventState.conversation?.members;
    if (!members) return true;
    const user = this.userPrincipal();
    return members.some((member) => samePrincipal(member, user));
  }

  private buildDreamMemoryExtractionBatches(
    runId: string,
    memoryScope: AgentDreamMemoryScope,
    inputs: {
      conversations: readonly {
        conversationId: string;
        events: readonly AgentEvent[];
        fromSeqExclusive: number;
      }[];
      agentRuns: readonly DreamMemoryExtractionAgentRunInput[];
    },
  ): AgentDreamMemoryExtractionBatch[] {
    const batches: AgentDreamMemoryExtractionBatch[] = [];
    const conversationSpan = buildDreamMemoryExtractionSpanFromEvidence(runId, {
      conversations: inputs.conversations,
      agentRuns: [],
    });
    if (conversationSpan) {
      batches.push({
        span: conversationSpan,
        originWorkspace: memoryScope.originWorkspace,
      });
    }

    // Agent-run evidence still groups by the workspace each run happened in, so a new fact's
    // provenance tag names where it was learned — grouping is for tagging, not partitioning.
    for (const group of groupDreamAgentRunInputsByOriginWorkspace(inputs.agentRuns)) {
      const span = buildDreamMemoryExtractionSpanFromEvidence(runId, {
        conversations: [],
        agentRuns: group.inputs,
      });
      if (!span) continue;
      batches.push({
        span,
        originWorkspace: group.originWorkspace ?? memoryScope.originWorkspace,
      });
    }
    return batches;
  }

  private async listDreamAgentIds(): Promise<string[]> {
    const ids = new Set<string>([this.agentIdentity.agentId]);
    for (const conversationId of await this.getEventStore().listConversationIds()) {
      const state = await this.getEventStore().replay(conversationId);
      for (const run of Object.values(state.subagents ?? {})) {
        ids.add(this.memoryOwnerAgentIdForSubagentRun(run));
      }
    }
    return [...ids].sort();
  }

  private async collectDreamAgentRunInputs(
    agentId: string,
    watermark: AgentDreamWatermark,
    conversationIds: readonly string[],
  ): Promise<DreamMemoryExtractionAgentRunInput[]> {
    const inputs: DreamMemoryExtractionAgentRunInput[] = [];
    for (const conversationId of conversationIds) {
      const state = await this.getEventStore().replay(conversationId);
      for (const run of Object.values(state.subagents ?? {})) {
        if (run.status === 'running') continue;
        const owner = this.memoryOwnerAgentIdForSubagentRun(run);
        if (owner !== agentId) continue;

        const payload = run.transcriptPayloadId ? state.payloads[run.transcriptPayloadId] : undefined;
        if (!payload) continue;
        const envelope = await this.readSubagentTranscriptEnvelope(conversationId, payload);
        if (!envelope) continue;
        const transcriptMessages = envelope.messages;
        // Prefer the envelope's own fork boundary: it is written atomically with the
        // messages it indexes, so it is always in the live payload's coordinates. The
        // replayed run-record boundary can be stale relative to a payload-superseding
        // compaction; using it could re-exclude a compacted summary as "fork prefix" and
        // permanently skip the run's only remaining evidence.
        const evidenceStart = subagentDreamEvidenceStartMessageIndex({
          contextMode: run.contextMode,
          dreamEvidenceStartMessageIndex: envelope.dreamEvidenceStartMessageIndex ?? run.dreamEvidenceStartMessageIndex,
        }, transcriptMessages.length);
        const cursor = watermark.agentRuns?.[run.id];
        const fromMessageCountExclusive = Math.min(
          cursor?.payloadId === payload.id
            ? Math.max(cursor.messageCount, evidenceStart)
            : evidenceStart,
          transcriptMessages.length,
        );
        if (transcriptMessages.length <= fromMessageCountExclusive) continue;
        inputs.push({
          conversationId,
          agentId,
          subagentRunId: run.id,
          parentToolCallId: run.parentToolCallId,
          transcriptPayloadId: payload.id,
          originWorkspace: run.memoryOriginWorkspace,
          transcriptMessages,
          fromMessageCountExclusive,
        });
      }
    }
    return inputs;
  }

  private memoryOwnerAgentIdForSubagentRun(run: AgentSubagentRunRecord): string {
    return resolveSubagentMemoryOwner(run, this.agentIdentity.agentId);
  }

  private async runDreamMemoryExtractionTask(task: AgentDreamMemoryExtractionTask): Promise<AgentDreamRunResult> {
    let modelForRunMeta: Model<Api> | null = null;
    try {
      const providerConfig = await this.getActiveProviderConfig();
      if (!providerConfig) {
        return {
          agentId: this.agentIdentity.agentId,
          runId: task.runId,
          trigger: task.trigger,
          status: 'skipped',
          startedAt: task.startedAt,
          completedAt: Date.now(),
          errorMessage: 'No enabled agent provider is configured.',
        };
      }
      const model = this.resolveProviderModel(providerConfig);
      modelForRunMeta = model;
      await this.writeDreamRunMeta(task, 'running', model);
      const apiKey = providerConfig.apiKey ?? await this.getProviderApiKey(providerConfig.providerId);
      const runtimeSettings = await this.getRuntimeSettings();
      const changes = emptyDreamChanges();
      for (const [index, batch] of task.batches.entries()) {
        // Consolidation/dedup reads the WHOLE pool — memory is one undivided self-model per
        // principal; `originWorkspace` is provenance on each entry, never a retrieval fence.
        // 200 is the store's query clamp max; the prompt's existing-memory list is bounded
        // separately (DREAM_EXISTING_MEMORY_LIMIT) inside buildDreamMemoryExtractionRequest.
        const existingMemories = await this.getEventStore().listMemoryEntries(task.principal, { limit: 200 });
        const request = buildDreamMemoryExtractionRequest({
          span: batch.span,
          existingMemories,
          originWorkspace: batch.originWorkspace,
          subject: task.principal.type === 'user' ? 'user' : 'agent',
        });
        const response = await (this.options.completeSimpleFn ?? completeSimple)(model, {
          messages: [request],
          tools: [],
        }, {
          ...providerStreamOptionsFromRuntimeSettings(runtimeSettings),
          apiKey,
          maxTokens: Math.min(model.maxTokens ?? 2_000, 2_000),
          // pi-ai stream option (provider cache affinity) — the lib's own field name. Kept
          // within the 64-char provider prompt_cache_key cap; see buildDreamSessionId.
          sessionId: buildDreamSessionId(task.runId, index),
        });
        if (response.stopReason === 'error' || response.stopReason === 'aborted') {
          throw new Error(response.errorMessage || 'Dream memory extraction failed.');
        }
        const actions = parseDreamMemoryActions(assistantMessageText(response));
        // Crash-retry dedup window: applyDreamMemoryActions matches new facts against this
        // list by fact key, so it must see as much of the pool as the store allows (200 =
        // query clamp max) or a re-run after a crash re-saves entries past the window.
        const currentMemories = await this.getEventStore().listMemoryEntries(task.principal, { limit: 200 });
        addDreamChanges(changes, actions.length > 0
          ? await this.applyDreamMemoryActions(task, batch, actions, currentMemories)
          : emptyDreamChanges());
      }
      const completed = await this.getEventStore().appendDreamCompleted(task.principal, {
        runId: task.runId,
        trigger: task.trigger,
        startedAt: task.startedAt,
        watermark: task.watermark,
        processed: {
          conversations: dreamProcessedConversations(task.span.sourceRanges),
          agentRuns: dreamProcessedAgentRuns(task.span.sourceRanges),
          totalMessageCount: task.span.totalMessageCount,
          totalCharCount: task.span.totalCharCount,
          consolidateOnly: task.span.consolidateOnly,
        },
        changes,
      });
      await this.writeDreamRunMeta(task, 'completed', model);
      this.clearSubagentMemoryReminderCaches();
      return {
        agentId: this.agentIdentity.agentId,
        runId: task.runId,
        trigger: task.trigger,
        status: 'completed',
        startedAt: task.startedAt,
        completedAt: completed.completedAt,
        processed: completed.processed,
        changes: completed.changes,
      };
    } catch (error) {
      if (modelForRunMeta) {
        await this.writeDreamRunMeta(task, 'failed', modelForRunMeta).catch(() => undefined);
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Dream memory extraction skipped: ${message}`);
      return {
        agentId: this.agentIdentity.agentId,
        runId: task.runId,
        trigger: task.trigger,
        status: 'failed',
        startedAt: task.startedAt,
        completedAt: Date.now(),
        errorMessage: message,
      };
    }
  }

  private async writeDreamRunMeta(
    task: AgentDreamMemoryExtractionTask,
    status: 'running' | 'completed' | 'failed',
    model: Model<Api>,
  ): Promise<void> {
    const timestamp = status === 'running' ? task.startedAt : Date.now();
    await this.getEventStore().writeRunMeta({
      v: 1,
      id: task.runId,
      // Executor vs subject: the runtime's main agent executes every Dream (`agentId`), but the
      // run is ANCHORED to the principal whose pool it maintains — run history lives beside that
      // principal's pool, keyed like its dream state ([[agent-data-model]] §4).
      agentId: this.agentIdentity.agentId as AgentRunMetaProjection['agentId'],
      anchor: { type: 'principal', principal: task.principal },
      kind: 'reflective',
      status,
      trigger: task.trigger === 'schedule'
        ? { type: 'schedule', schedule: DEFAULT_DREAM_SCHEDULE, dueAt: task.dueAt }
        : { type: 'manual' },
      fingerprint: {
        appVersion: electronAppVersion(),
        // The Dream's prompt is the subject-framed extraction request — not the executing
        // agent's system prompt, which never reaches a Dream completion call.
        promptHash: hashJson({
          dream: 'memory',
          principal: principalKey(task.principal),
          subject: task.principal.type,
        }),
        toolSchemaHash: 'no-tools',
        skillBindings: [],
        modelConfig: hashJson({
          model: model.id,
          provider: model.provider,
        }),
      },
      retention: 'hot',
      createdAt: task.startedAt,
      updatedAt: timestamp,
      latestSeq: 0,
    });
    await this.refreshAgentTaskCache();
    this.emitAgentTaskProjection(`dream.${status}`);
  }

  private async refreshAgentTaskCache(): Promise<void> {
    const store = this.getEventStore();
    // A pool's reflective-run history and its dream state are keyed by the same principal, so
    // each pool's tasks join locally — no cross-pool indexing.
    const principals = await this.listDreamPrincipals();
    const taskGroups = await Promise.all(principals.map(async (principal): Promise<AgentRenderTaskEntity[]> => {
      const [runs, dreamState] = await Promise.all([
        store.listPrincipalRunMetaProjections(principal, { limit: 50 }),
        store.readDreamState(principal),
      ]);
      return runs.flatMap((run): AgentRenderTaskEntity[] => {
        const completed = dreamState.lastCompleted?.runId === run.id ? dreamState.lastCompleted : null;
        const task = dreamTaskFromRunMeta(run, completed);
        return task ? [task] : [];
      });
    }));
    this.agentTaskCache = taskGroups.flat().sort(compareRenderTasks);
  }

  private emitAgentTaskProjection(lastEventType: string) {
    for (const conversationId of this.conversations.keys()) {
      this.emitProjection(conversationId, lastEventType, 'coalesce');
    }
  }

  private async applyDreamMemoryActions(
    task: AgentDreamMemoryExtractionTask,
    batch: AgentDreamMemoryExtractionBatch,
    actions: readonly DreamMemoryAction[],
    initialEntries: readonly AgentMemoryEntry[],
  ): Promise<AgentDreamCompletedChanges> {
    const changes = emptyDreamChanges();
    const entriesById = new Map(initialEntries.map((entry) => [entry.id, entry]));
    const activeFactKeys = new Set(initialEntries.map((entry) => memoryFactKey(entry.fact)));
    for (const action of actions) {
      if (action.type === 'add') {
        if (batch.span.sources.length === 0) {
          changes.skipped += 1;
          continue;
        }
        const key = memoryFactKey(action.fact);
        if (activeFactKeys.has(key)) {
          changes.skipped += 1;
          continue;
        }
        const entry = await this.getEventStore().addMemoryEntry(task.principal, {
          fact: action.fact,
          originWorkspace: batch.originWorkspace,
          sources: batch.span.sources,
        });
        entriesById.set(entry.id, entry);
        activeFactKeys.add(memoryFactKey(entry.fact));
        changes.added += 1;
        continue;
      }

      const current = entriesById.get(action.memoryId);
      if (!current) {
        changes.skipped += 1;
        continue;
      }
      if (action.type === 'forget') {
        await this.getEventStore().removeMemoryEntry(task.principal, current.id, action.reason ?? 'dream');
        entriesById.delete(current.id);
        activeFactKeys.delete(memoryFactKey(current.fact));
        changes.forgotten += 1;
        continue;
      }

      const currentFactKey = memoryFactKey(current.fact);
      const nextFactKey = memoryFactKey(action.fact);
      if (nextFactKey === currentFactKey) {
        changes.skipped += 1;
        continue;
      }
      if (activeFactKeys.has(nextFactKey)) {
        changes.skipped += 1;
        continue;
      }
      const updated = await this.getEventStore().updateMemoryEntry(task.principal, current.id, {
        fact: action.fact,
        originWorkspace: current.originWorkspace ?? batch.originWorkspace,
        sources: mergeMemorySources(current.sources, batch.span.sources),
      });
      if (!updated) {
        changes.skipped += 1;
        continue;
      }
      entriesById.set(updated.id, updated);
      activeFactKeys.delete(currentFactKey);
      activeFactKeys.add(memoryFactKey(updated.fact));
      changes.updated += 1;
    }
    return changes;
  }

  private reserveConversationId(conversationId: string) {
    const match = /^lin-agent-(\d+)$/.exec(conversationId);
    if (!match) return;
    const numericId = Number(match[1]);
    if (Number.isInteger(numericId) && numericId >= this.nextConversationId) {
      this.nextConversationId = numericId + 1;
    }
  }

  private createConversationId() {
    return `lin-agent-${randomUUID()}`;
  }

  private defaultDmConversationId() {
    return `lin-agent-dm-${hashJson({
      userId: LOCAL_USER_ID,
      agentId: this.agentIdentity.agentId,
    }).slice(0, 16)}`;
  }

  private createChannelId() {
    return `lin-agent-channel-${randomUUID()}`;
  }

  private isDefaultDmConversationId(conversationId: string) {
    return conversationId === this.defaultDmConversationId();
  }

  private userPrincipal(): AgentPrincipal {
    return { type: 'user', userId: LOCAL_USER_ID };
  }

  private agentPrincipal(): AgentPrincipal {
    return { type: 'agent', agentId: this.agentIdentity.agentId };
  }

  private defaultConversationMembers(): AgentPrincipal[] {
    return [this.userPrincipal(), this.agentPrincipal()];
  }

  private createMessageId(prefix: string) {
    return `${prefix}-${randomUUID()}`;
  }

  private agentActor(): AgentActor {
    return { type: 'agent', agentId: this.agentIdentity.agentId };
  }

  /** Actor for the in-flight run's emissions: the executing member, not always the main agent. */
  private runActor(conversation: AgentConversationState): AgentActor {
    return { type: 'agent', agentId: conversation.activeRun?.executingAgentId ?? this.agentIdentity.agentId };
  }

  private activeRunId(conversation: AgentConversationState): string | null {
    return conversation.activeRun?.id ?? null;
  }

  private requireActiveRun(conversation: AgentConversationState): AgentActiveRunState {
    if (!conversation.activeRun) throw new Error('Agent run state is not active.');
    return conversation.activeRun;
  }

  private currentAgentIdentity(model: Model<Api> | null): AgentIdentityRecord {
    return {
      ...this.agentIdentity,
      model: model?.id ?? this.agentIdentity.model,
    };
  }

  private runTrigger(conversation: AgentConversationState): AgentRunTrigger {
    const messageId = conversation.eventState.selectedLeafMessageId ?? conversation.eventState.latestMessageId;
    return messageId ? { type: 'message', messageId } : { type: 'manual' };
  }

  private runFingerprint(conversation: AgentConversationState, executingAgentId?: string): AgentRunFingerprint {
    const agentId = executingAgentId ?? this.agentIdentity.agentId;
    return {
      appVersion: electronAppVersion(),
      promptHash: hashJson({
        agentId,
        // The conversation agent is already configured for the executing member
        // when the run starts, so its live system prompt is the turn's real prompt.
        systemPrompt: agentId === this.agentIdentity.agentId
          ? this.agentIdentity.systemPrompt
          : conversation.agent.state.systemPrompt,
      }),
      toolSchemaHash: 'runtime-tools',
      skillBindings: [],
      modelConfig: hashJson({
        model: conversation.agent.state.model.id,
        provider: conversation.agent.state.model.provider,
        thinkingLevel: conversation.agent.state.thinkingLevel,
      }),
    };
  }

  private conversationResponse(conversationId: string, conversation: AgentConversationState) {
    return {
      conversationId: conversationId,
      renderProjection: this.renderProjection(conversation),
      pendingUserQuestion: this.pendingUserQuestionView(conversationId, conversation),
    };
  }

  private renderProjection(conversation: AgentConversationState) {
    const projection = buildAgentRenderProjection(conversation.eventState, {
      revision: conversation.revision,
      activeRunId: this.activeRunId(conversation),
      queuedMessages: conversation.pendingChannelMessages
        .filter((pending): pending is Extract<PendingChannelMessage, { kind: 'prompt' }> => pending.kind === 'prompt')
        .map((pending) => pending.messageText),
      activeCompaction: conversation.activeCompaction,
      activeDream: conversation.activeDream,
      isStreaming: conversation.agent.state.isStreaming,
      model: clone(conversation.agent.state.model) as unknown as Record<string, unknown>,
      thinkingLevel: conversation.agent.state.thinkingLevel,
      pendingToolCallIds: Array.from(conversation.agent.state.pendingToolCalls),
      // Run/provider failures render inline as a failed assistant message (see
      // appendAssistantCompleted). The top-level banner is reserved for transient
      // operational errors delivered via the `error` event.
      errorMessage: null,
      agentTasks: this.agentTaskCache,
      memberDisplayNames: conversation.memberDisplayNames,
      coordinatorAgentId: this.agentIdentity.agentId,
    });
    return {
      ...projection,
      conversationTitle: sanitizeConversationTitle(projection.conversationTitle),
    };
  }

  private beginCompaction(
    conversationId: string,
    conversation: AgentConversationState,
    trigger: AgentCompactionTrigger,
  ): string {
    const activeCompaction = {
      id: randomUUID(),
      trigger,
      startedAt: Date.now(),
    };
    conversation.activeCompaction = activeCompaction;
    this.emitProjection(conversationId, 'compaction.started');
    return activeCompaction.id;
  }

  private finishCompaction(
    conversationId: string,
    conversation: AgentConversationState,
    compactionId: string,
    lastEventType: string,
  ) {
    if (conversation.activeCompaction?.id === compactionId) {
      conversation.activeCompaction = null;
    }
    this.emitProjection(conversationId, lastEventType);
  }

  private beginDream(conversationId: string, conversation: AgentConversationState): string {
    const activeDream = {
      id: randomUUID(),
      trigger: 'manual' as const,
      startedAt: Date.now(),
    };
    conversation.activeDream = activeDream;
    this.emitProjection(conversationId, 'dream.started');
    return activeDream.id;
  }

  private finishDream(
    conversationId: string,
    conversation: AgentConversationState,
    dreamId: string,
    lastEventType: string,
  ) {
    if (conversation.activeDream?.id === dreamId) {
      conversation.activeDream = null;
    }
    this.emitProjection(conversationId, lastEventType);
  }

  private emitProjection(
    conversationId: string,
    lastEventType: string | null = null,
    mode: 'immediate' | 'coalesce' = 'immediate',
  ) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    if (mode === 'coalesce') {
      conversation.pendingProjectionLastEventType = lastEventType;
      if (conversation.pendingProjectionTimer) return;
      conversation.pendingProjectionTimer = setTimeout(() => {
        conversation.pendingProjectionTimer = null;
        const pendingEventType = conversation.pendingProjectionLastEventType;
        conversation.pendingProjectionLastEventType = null;
        this.emitProjectionNow(conversationId, pendingEventType);
      }, 16);
      return;
    }
    clearPendingProjection(conversation);
    this.emitProjectionNow(conversationId, lastEventType);
  }

  private emitProjectionNow(conversationId: string, lastEventType: string | null = null) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    conversation.revision += 1;
    const renderProjection = this.renderProjection(conversation);
    const timestamp = Date.now();
    this.domainEvents.publish({
      lane: 'renderer-projection',
      name: 'RendererProjectionUpdated',
      conversationId,
      lastEventType,
      revision: conversation.revision,
      projection: renderProjection,
      createdAt: timestamp,
    });
  }

  private publishPersistedEvents(conversationId: string, events: readonly AgentEvent[]) {
    for (const event of events) {
      this.domainEvents.publish({
        lane: 'persisted-log',
        name: 'PersistedLogEvent',
        conversationId,
        runId: event.runId,
        event,
        createdAt: event.createdAt,
      });
    }
  }

  private emitError(conversationId: string, message: string) {
    this.emitConversationRuntimeEvent(conversationId, {
      type: 'error',
      error: message,
    });
  }

  /**
   * Push the conversation's folded unread count to the renderer's conversation
   * list. Threaded independently of the active-conversation projection so badges
   * on other conversations update too.
   */
  private emitConversationAttention(conversationId: string, conversation: AgentConversationState) {
    const attention = conversation.eventState.attentionByConversationId[conversationId];
    this.emit({
      type: 'conversation_attention',
      conversationId,
      unreadCount: attention?.unreadCount ?? 0,
      timestamp: Date.now(),
    });
  }

  /**
   * Set the opt-in OS-notification sink. main.ts owns the native Electron
   * Notification (and window-focus suppression + the user opt-in gate); the
   * runtime only forwards the signal. Left unset means OS notifications are off
   * (the default) — the durable in-app delivery is unaffected.
   */
  setOsNotifier(notifier: OsNotifier | undefined): void {
    this.osNotifier = notifier;
  }

  private deliverOsNotification(input: { title: string; body?: string; conversationId: string }): void {
    try {
      this.osNotifier?.(input);
    } catch (error) {
      this.emitError(input.conversationId, error instanceof Error ? error.message : String(error));
    }
  }

  private emitConversationRuntimeEvent(conversationId: string, input: PublicConversationRuntimeEventInput) {
    const timestamp = Date.now();
    if (input.type === 'closed') {
      this.emit({ type: 'closed', conversationId, timestamp });
      return;
    }
    if (input.type === 'error') {
      this.emit({ type: 'error', conversationId, error: input.error, timestamp });
      return;
    }
    if (input.type === 'approval_request') {
      this.emit({
        type: 'approval_request',
        conversationId,
        requestId: input.requestId,
        request: input.request,
        timestamp,
      });
      return;
    }
    if (input.type === 'user_question_request') {
      this.emit({
        type: 'user_question_request',
        conversationId,
        requestId: input.requestId,
        question: input.question,
        timestamp,
      });
      return;
    }
    if (input.type === 'user_question_resolved') {
      this.emit({
        type: 'user_question_resolved',
        conversationId,
        requestId: input.requestId,
        result: input.result,
        timestamp,
      });
      return;
    }
    this.emit({
      type: 'approval_resolved',
      conversationId,
      requestId: input.requestId,
      approved: input.approved,
      scope: input.scope,
      timestamp,
    });
  }

  private emit(payload: AgentRuntimeEvent) {
    this.getWindow()?.webContents.send(LIN_AGENT_EVENT_CHANNEL, payload);
  }

  private getEventStore() {
    this.eventStore ??= new AgentEventStore(this.options.agentDataRoot ?? path.join(app.getPath('userData'), 'agent'));
    return this.eventStore;
  }

  private getPastChatsService() {
    this.pastChatsService ??= new AgentPastChatsService(this.getEventStore());
    return this.pastChatsService;
  }

  private createRecallToolRuntime(
    agentId: string,
    _getConversationId: () => string,
    getConversation: () => AgentConversationState | null,
  ): AgentRecallToolRuntime {
    const reader: AgentPrincipal = { type: 'agent', agentId };
    return {
      reader,
      recall: async (options) => {
        const conversation = getConversation();
        const limit = clampRecallLimit(options.limit);
        // Cross-principal read by membership ([[agent-data-model]] §4): the reader searches its
        // own pool and — only when the user is a member of its conversation — the shared user
        // pool. Each pool is one undivided self-model; `originWorkspace` is provenance on the
        // entries, never a retrieval fence.
        const ownResult = await this.getEventStore().queryMemoryEntries(reader, {
          query: options.query, limit,
        });
        const userResult = this.conversationIncludesUser(conversation)
          ? await this.getEventStore().queryMemoryEntries(this.userPrincipal(), { query: options.query, limit })
          : { entries: [], totalEntries: 0 };
        // Fair interleave so a large own pool never fully starves more-relevant user-pool hits.
        const mergedEntries = interleaveMemoryEntries(ownResult.entries, userResult.entries, limit);
        // Read-path security gate ([[agent-data-model]] §4): a cross-principal fact reaches the
        // reader DISTILLED — strip its source pointers (not just dereferenced evidence), so a
        // non-owning agent never receives pointers into another principal's private transcript.
        const gatedEntries = mergedEntries.map((entry) => (
          samePrincipal(entry.principal, reader) ? entry : { ...entry, sources: [] }
        ));
        // Total durable matches across both pools — reachable by raising `limit` (which lifts
        // each pool's per-query cap and the interleave cap together), so it is an honest paging
        // signal rather than an over-report of this single capped page.
        const totalEntries = ownResult.totalEntries + userResult.totalEntries;

        if (!options.includeEvidence) {
          return {
            entries: gatedEntries.map((entry) => ({ entry })),
            totalEntries,
          };
        }

        let remainingChars = Math.max(0, options.maxChars ?? 0);
        const entries: AgentRecallRuntimeEntry[] = [];
        for (const entry of gatedEntries) {
          // Evidence dereferences only for the reader's own pool; cross-principal entries already
          // had their sources stripped above, so the inner loop is a no-op for them.
          if (!samePrincipal(entry.principal, reader)) {
            entries.push({ entry });
            continue;
          }
          const evidence: AgentRecallEvidence[] = [];
          let evidenceTruncated = false;
          for (const source of entry.sources) {
            if (remainingChars <= 0) {
              evidenceTruncated = true;
              break;
            }
            const sourceEvidence = await this.getPastChatsService().readMemorySourceEvidence({
              source,
              maxChars: remainingChars,
            });
            if (sourceEvidence.mode !== 'evidence') continue;
            evidenceTruncated ||= sourceEvidence.outputTruncated;
            for (const message of sourceEvidence.messages) {
              evidence.push({
                source,
                conversationId: sourceEvidence.conversation.id,
                messageId: message.messageId,
                role: message.role,
                createdAt: message.createdAt,
                text: message.text,
                toolName: message.toolName,
                isError: message.isError,
                messageTruncated: message.messageTruncated,
              });
              remainingChars = Math.max(0, remainingChars - message.text.length);
              if (remainingChars <= 0) {
                evidenceTruncated = true;
                break;
              }
            }
          }
          entries.push({
            entry,
            evidence: evidence.length > 0 ? evidence : undefined,
            evidenceTruncated,
          });
        }

        return {
          entries,
          totalEntries,
        };
      },
    };
  }

  private createAskUserQuestionRuntime(
    getConversationId: () => string,
    getConversation: () => AgentConversationState | null,
  ): AgentAskUserQuestionRuntime {
    return {
      ask: (toolCallId, request, signal) => {
        const conversation = getConversation();
        if (!conversation) throw new Error('Agent conversation is not ready.');
        return this.askUserQuestion(getConversationId(), conversation, toolCallId, request, signal);
      },
    };
  }

  private createSelfMaintenanceRuntime(
    getConversationId: () => string,
    getConversation: () => AgentConversationState | null,
  ): AgentSelfMaintenanceRuntime {
    return {
      runtimeStatus: async () => {
        const providerConfig = await this.getActiveProviderConfig();
        return {
          agentId: this.agentIdentity.agentId,
          conversationId: getConversationId(),
          provider: providerConfig
            ? {
                configured: true,
                providerId: providerConfig.providerId,
                modelId: providerConfig.modelId,
                reasoningLevel: providerConfig.reasoningLevel,
              }
            : { configured: false },
          runtime: await this.getRuntimeSettings(),
        };
      },
      readConfig: async (setting) => ({
        operation: 'read',
        setting,
        value: readRuntimeSetting(await this.getRuntimeSettings(), setting),
      }),
      writeConfig: async (setting, value) => {
        const conversation = getConversation();
        if (!conversation) throw new Error('Agent conversation is not ready.');
        const before = readRuntimeSetting(await this.getRuntimeSettings(), setting);
        const patch = normalizeRuntimeSettingPatch(setting, value);
        await updateAgentRuntimeSettings(patch);
        const runtimeSettings = await this.refreshRuntimeSettings(conversation);
        const after = readRuntimeSetting(runtimeSettings, setting);
        await this.appendConversationEvents(getConversationId(), conversation, [{
          type: 'config.change',
          actor: this.agentActor(),
          runId: this.activeRunId(conversation) ?? undefined,
          changeId: `config-change-${randomUUID()}`,
          status: 'applied',
          change: {
            target: 'runtime',
            key: setting,
            before,
            after,
            reason: 'config tool',
          },
        }]);
        return { operation: 'write', setting, value: after };
      },
      doctor: async () => {
        const diagnostics: DoctorDiagnostic[] = [];
        const providerConfig = await this.getActiveProviderConfig();
        const runtimeSettings = await this.getRuntimeSettings();
        if (!providerConfig) {
          diagnostics.push({
            id: 'provider.not_configured',
            severity: 'error',
            message: 'No usable provider is configured.',
            recommendation: 'Configure a provider and credential in Settings before starting agent runs.',
          });
        }
        if (runtimeSettings.additionalSkillDirectories.length > 0) {
          diagnostics.push({
            id: 'skills.additional_directories',
            severity: 'info',
            message: `${runtimeSettings.additionalSkillDirectories.length} additional skill directories are configured.`,
          });
        }
        if (runtimeSettings.disabledSkills?.length) {
          diagnostics.push({
            id: 'skills.disabled',
            severity: 'warning',
            message: `${runtimeSettings.disabledSkills.length} skills are disabled.`,
            recommendation: 'Use config reads to inspect disabled skill names before relying on skills.',
          });
        }
        if (runtimeSettings.disabledAgents?.length) {
          diagnostics.push({
            id: 'agents.disabled',
            severity: 'warning',
            message: `${runtimeSettings.disabledAgents.length} subagents are disabled.`,
          });
        }
        return {
          ok: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
          diagnostics,
        };
      },
      dream: async () => {
        const result = await this.fireManualDream(new Date());
        getConversation()?.pendingDreamFinishedMarkers.push(result);
        return dreamToolDataFromRunResult(result);
      },
    };
  }

  private async askUserQuestion(
    conversationId: string,
    conversation: AgentConversationState,
    toolCallId: string,
    request: AgentUserQuestionRequestView,
    signal?: AbortSignal,
  ): Promise<AskUserQuestionResult> {
    const runId = this.activeRunId(conversation);
    if (!runId) throw new Error('Cannot ask the user a question outside an active run.');
    if ([...this.pendingUserQuestions.values()].some((pending) => pending.conversationId === conversationId && pending.runId === runId)) {
      throw new Error('A user question is already pending for this run.');
    }

    const requestId = `question-${randomUUID()}`;
    await this.appendConversationEvents(conversationId, conversation, [{
      type: 'user_question.requested',
      actor: this.agentActor(),
      runId,
      requestId,
      toolCallId,
      request,
    }]);

    return new Promise<AskUserQuestionResult>((resolve, reject) => {
      const pending: AgentPendingUserQuestion = {
        conversationId,
        runId,
        toolCallId,
        requestId,
        request,
        resolve,
        reject,
      };
      this.pendingUserQuestions.set(requestId, pending);
      this.emitConversationRuntimeEvent(conversationId, {
        type: 'user_question_request',
        requestId,
        question: this.userQuestionView(conversationId, pending),
      });
      this.emitProjection(conversationId, 'user_question.requested');
      const abort = () => {
        void this.cancelUserQuestion(requestId, 'aborted')
          .catch((error) => this.emitError(conversationId, error instanceof Error ? error.message : String(error)));
      };
      if (signal?.aborted) {
        abort();
      } else {
        signal?.addEventListener('abort', abort, { once: true });
      }
    });
  }

  async resolveUserQuestion(
    conversationId: string,
    requestId: string,
    resultInput: unknown,
  ) {
    const conversation = await this.ensureConversationWithId(conversationId);
    const pending = this.pendingUserQuestions.get(requestId) ?? this.pendingUserQuestionFromReplay(conversationId, conversation, requestId);
    if (!pending || pending.conversationId !== conversationId) return { resolved: false };
    const result = normalizeAskUserQuestionResult(requestId, pending.request, resultInput);
    const validationError = this.validateUserQuestionResult(pending.request, result);
    if (validationError) throw new Error(validationError);
    const events: AgentEventInput[] = [{
      type: 'user_question.answered',
      actor: userActor(),
      runId: pending.runId,
      requestId,
      result,
    }];
    if (!pending.resolve) events.push(this.replayedUserQuestionToolResultInput(conversation, pending, result));
    await this.appendConversationEvents(conversationId, conversation, events);
    this.pendingUserQuestions.delete(requestId);
    this.emitConversationRuntimeEvent(conversationId, {
      type: 'user_question_resolved',
      requestId,
      result,
    });
    this.emitProjection(conversationId, 'user_question.answered');
    if (pending.resolve) {
      pending.resolve(result);
    }
    return { resolved: true };
  }

  private validateUserQuestionResult(
    request: AgentUserQuestionRequestView,
    result: AskUserQuestionResult,
  ): string | null {
    const answers = new Map(result.answers.map((answer) => [answer.questionId, answer]));
    for (const question of request.questions) {
      if (question.required === false) continue;
      const answer = answers.get(question.id);
      if (!answer) return `Question ${question.id} is required.`;
      const hasText = typeof answer.text === 'string' && answer.text.trim().length > 0;
      const hasOptions = Array.isArray(answer.selectedOptionIds) && answer.selectedOptionIds.length > 0;
      if (!hasText && !hasOptions) return `Question ${question.id} is required.`;
    }
    return null;
  }

  private replayedUserQuestionToolResultInput(
    conversation: AgentConversationState,
    pending: AgentPendingUserQuestion,
    result: AskUserQuestionResult,
  ): AgentEventInput {
    const parentMessage = getAgentEventActivePath(conversation.eventState)
      .find((message) => message.role === 'assistant'
        && message.content.some((part) => part.type === 'toolCall' && part.id === pending.toolCallId));
    if (!parentMessage) {
      throw new Error(`Cannot resume replayed user question without parent tool call: ${pending.toolCallId}`);
    }
    const messageId = `tool-result-${pending.toolCallId}-${randomUUID()}`;
    // Reuse the shared envelope helper so a replayed answer renders identically to
    // the live ask_user_question tool result the model otherwise sees.
    const toolResult = agentToolResult(successEnvelope(ASK_USER_QUESTION_TOOL_NAME, result), result);
    return {
      type: 'tool_result.created',
      actor: toolActor(ASK_USER_QUESTION_TOOL_NAME, pending.toolCallId),
      runId: pending.runId,
      messageId,
      parentMessageId: parentMessage.id,
      toolCallId: pending.toolCallId,
      toolName: ASK_USER_QUESTION_TOOL_NAME,
      content: toolResult.content,
      isError: false,
      outputSummary: 'Answered user question.',
    };
  }

  private async cancelUserQuestion(requestId: string, reason: string) {
    const pending = this.pendingUserQuestions.get(requestId);
    if (!pending) return;
    this.pendingUserQuestions.delete(requestId);
    const conversation = this.conversations.get(pending.conversationId);
    if (conversation) {
      await this.appendConversationEvents(pending.conversationId, conversation, [{
        type: 'user_question.cancelled',
        actor: systemActor(),
        runId: pending.runId,
        requestId,
        reason,
      }]);
      this.emitProjection(pending.conversationId, 'user_question.cancelled');
    }
    this.emitConversationRuntimeEvent(pending.conversationId, {
      type: 'user_question_resolved',
      requestId,
    });
    pending.reject?.(new Error(`User question cancelled: ${reason}`));
  }

  private pendingUserQuestionView(
    conversationId: string,
    conversation: AgentConversationState,
  ): AgentUserQuestionPendingView | null {
    const live = [...this.pendingUserQuestions.values()].find((pending) => pending.conversationId === conversationId);
    if (live) return this.userQuestionView(conversationId, live);
    const replayed = Object.values(conversation.eventState.userQuestions)
      .filter((question) => question.status === 'pending')
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    return replayed ? this.userQuestionView(conversationId, {
      conversationId,
      runId: replayed.runId,
      toolCallId: replayed.toolCallId,
      requestId: replayed.requestId,
      request: replayed.request,
    }) : null;
  }

  private pendingUserQuestionFromReplay(
    conversationId: string,
    conversation: AgentConversationState,
    requestId: string,
  ): AgentPendingUserQuestion | null {
    const record = conversation.eventState.userQuestions[requestId];
    if (!record || record.status !== 'pending') return null;
    return {
      conversationId,
      runId: record.runId,
      toolCallId: record.toolCallId,
      requestId,
      request: record.request,
    };
  }

  private userQuestionView(
    conversationId: string,
    pending: AgentPendingUserQuestion,
  ): AgentUserQuestionPendingView {
    return {
      requestId: pending.requestId,
      conversationId: conversationId,
      runId: pending.runId,
      toolCallId: pending.toolCallId,
      request: pending.request,
    };
  }

  private dreamMemoryExtractionEnabled(): boolean {
    return this.options.dreamMemoryExtractionEnabled === true;
  }

  private async dreamMemoryScope(): Promise<AgentDreamMemoryScope> {
    const runtimeSettings = await this.getRuntimeSettings();
    // 'read-only-global' pauses Dream writes (stop learning); otherwise memory is one undivided
    // pool per principal — `originWorkspace` only tags new entries with provenance.
    if ((runtimeSettings.memoryIsolation ?? 'global') === 'read-only-global') return { readOnly: true };
    return {
      readOnly: false,
      originWorkspace: this.memoryOriginWorkspace() ?? undefined,
    };
  }

  private async buildMemoryReminder(
    agentId: string,
    conversation: AgentConversationState | null,
  ): Promise<string | null> {
    try {
      const reader: AgentPrincipal = { type: 'agent', agentId };
      // Resident selection: the briefing is the distilled-memory prefix ([[agent-memory-model]]
      // §2), so it lists recent active entries rather than query-specific hits — those arrive
      // on demand through the `recall` tool ([5] tail). Keeping selection query-independent
      // keeps the briefing stable turn-over-turn (cache-friendly); a mid-conversation Dream write
      // surfaces through recall until the next turn folds it into the briefing.
      //
      // Membership read ([[agent-data-model]] §4): the reader sees its own pool (`<self>`) plus
      // the co-member user pool (`<principal>`) when the user is a member of its conversation.
      // Each pool is one undivided self-model — like a person, a principal never partitions its
      // own memory by where it works. Agent↔agent co-member pools are deferred (fork 1).
      const [selfEntries, userEntries] = await Promise.all([
        this.getEventStore().listMemoryEntries(reader, { limit: MEMORY_BRIEFING_MAX_ENTRIES }),
        this.conversationIncludesUser(conversation)
          ? this.getEventStore().listMemoryEntries(this.userPrincipal(), { limit: MEMORY_BRIEFING_MAX_ENTRIES })
          : Promise.resolve([]),
      ]);
      // Interleave so the shared user pool gets a fair share of the resident budget — a self-first
      // concatenation would let an agent with a full self-model starve the user zone entirely.
      const selected = interleaveMemoryEntries(selfEntries, userEntries, MEMORY_BRIEFING_MAX_ENTRIES);
      return renderAgentMemoryBriefing(selected, { reader });
    } catch (error) {
      console.warn(`Failed to build agent memory reminder: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private clearSubagentMemoryReminderCaches(): void {
    for (const conversation of this.conversations.values()) {
      conversation.subagentRuntime.clearMemoryReminderCache();
    }
  }

  /** Provenance tag for new memory entries — where this runtime works; never a retrieval fence. */
  private memoryOriginWorkspace(): string | undefined {
    return memoryWorkspaceIdForRoot(this.options.localFileRoot);
  }

  private getActiveProviderConfig() {
    return this.options.providerConfigLoader?.() ?? getActiveProviderRuntimeConfig();
  }

  private getRuntimeSettings() {
    return this.options.runtimeSettingsLoader?.() ?? getAgentRuntimeSettings();
  }

  private cleanupProviderConversationResources(conversationId: string) {
    try {
      cleanupPiConversationResources(conversationId);
    } catch (error) {
      this.emitError(conversationId, error instanceof Error ? error.message : String(error));
    }
  }

  private getProviderApiKey(providerId: string) {
    return this.options.providerApiKeyLoader?.(providerId) ?? getProviderApiKey(providerId);
  }

  private resolveProviderModel(providerConfig: AgentProviderRuntimeConfig) {
    return this.options.providerModelResolver?.(providerConfig) ?? resolveModel(providerConfig);
  }

  private async loadEventState(conversationId: string): Promise<AgentEventReplayState> {
    return this.getEventStore().replay(conversationId);
  }

  private buildEvents(
    eventState: AgentEventReplayState,
    conversationId: string,
    inputs: readonly AgentEventInput[],
  ): AgentEvent[] {
    let seq = eventState.latestSeq;
    return inputs.map((input) => {
      const { createdAt, ...rest } = input;
      return {
        v: AGENT_EVENT_VERSION,
        eventId: randomUUID(),
        seq: ++seq,
        conversationId,
        createdAt: createdAt ?? Date.now(),
        ...rest,
      } as AgentEvent;
    });
  }

  private async appendConversationEvents(
    conversationId: string,
    conversation: AgentConversationState,
    // Either a fixed list, or a builder evaluated INSIDE the serial queue against the
    // up-to-date eventState — required when an event field is derived from the log
    // tail (e.g. a notification.read cursor), since seqs are assigned at write time
    // and a concurrent append can land between a pre-queue snapshot and the write.
    // Return [] to skip (the decision is then made authoritatively inside the queue).
    inputs:
      | readonly AgentEventInput[]
      | ((state: AgentEventReplayState) => readonly AgentEventInput[]),
  ) {
    let events: AgentEvent[] = [];
    const writeEvents = async () => {
      const resolved = typeof inputs === 'function' ? inputs(conversation.eventState) : inputs;
      if (resolved.length === 0) {
        events = [];
        return;
      }
      events = this.buildEvents(conversation.eventState, conversationId, resolved);
      await this.getEventStore().appendEvents(conversationId, events);
      for (const event of events) appendAgentEventToReplayState(conversation.eventState, event);
      this.publishPersistedEvents(conversationId, events);
    };
    const operation = conversation.pendingEventAppend.then(writeEvents, writeEvents);
    conversation.pendingEventAppend = operation.then(() => undefined, () => undefined);
    await operation;
    return events;
  }

  private async requestToolApproval(
    conversationId: string,
    conversation: AgentConversationState,
    input: AgentToolApprovalInput,
    signal?: AbortSignal,
  ): Promise<AgentToolApprovalResolution> {
    if (signal?.aborted) return { approved: false, deniedReason: 'run_aborted' };

    const requestId = input.requestId;
    const request: AgentApprovalRequestView = {
      requestId,
      conversationId: conversationId,
      toolCallId: input.toolCall.id,
      toolName: input.toolCall.name,
      title: input.decision.request.title,
      target: input.decision.request.target,
      reason: input.decision.reason,
      details: input.decision.request.details,
      alwaysAllowRule: input.decision.request.alwaysAllowRule,
    };
    const payload = await this.getEventStore().writePayload(conversationId, {
      id: `approval-${requestId}`,
      data: JSON.stringify({
        request,
        decision: {
          behavior: input.decision.behavior,
          code: input.decision.code,
          reason: input.decision.reason,
          access: input.decision.access,
        },
        args: input.args,
      }, null, 2),
      mimeType: 'application/json',
      runId: this.activeRunId(conversation) ?? undefined,
      role: 'approval',
      summary: request.title,
    });

    await this.appendConversationEvents(conversationId, conversation, [{
      type: 'payload.created',
      actor: systemActor(),
      runId: this.activeRunId(conversation) ?? undefined,
      payload,
    }, {
      type: 'approval.requested',
      actor: systemActor(),
      runId: this.activeRunId(conversation) ?? undefined,
      requestId,
      summary: `${request.title} ${request.target}`.trim(),
      payloadRef: payload,
    }]);

    this.emitConversationRuntimeEvent(conversationId, {
      type: 'approval_request',
      requestId,
      request,
    });
    this.emitProjection(conversationId, 'approval.requested');

    return new Promise<AgentToolApprovalResolution>((resolve) => {
      const onAbort = () => {
        const pending = this.pendingApprovals.get(requestId);
        if (!pending) return;
        this.pendingApprovals.delete(requestId);
        signal?.removeEventListener('abort', onAbort);
        void this.appendConversationEvents(conversationId, conversation, [{
          type: 'approval.resolved',
          actor: systemActor(),
          runId: this.activeRunId(conversation) ?? undefined,
          requestId,
          approved: false,
        }]).catch((error) => this.emitError(conversationId, error instanceof Error ? error.message : String(error)));
        this.emitConversationRuntimeEvent(conversationId, {
          type: 'approval_resolved',
          requestId,
          approved: false,
        });
        resolve({ approved: false, deniedReason: 'run_aborted' });
      };

      this.pendingApprovals.set(requestId, {
        conversationId,
        request,
        alwaysAllowRule: request.alwaysAllowRule,
        resolve: (resolution) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(resolution);
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async appendToolPermissionEvent(
    conversationId: string,
    conversation: AgentConversationState,
    input: AgentToolPermissionLogInput,
  ) {
    const source = input.source ?? permissionEventSourceForDecision(input.decision);
    const actionKinds = permissionActionKinds(input.decision);
    const events: AgentEventInput[] = input.includeChecked === false ? [] : [{
      type: 'tool.permission.checked',
      actor: systemActor(),
      runId: this.activeRunId(conversation) ?? undefined,
      requestId: input.requestId,
      toolCallId: input.toolCall.id,
      toolName: input.toolCall.name,
      primaryActionKind: permissionPrimaryActionKind(input.decision),
      actionKinds,
      outcome: input.outcome,
      source,
    }];
    if (input.resolved) {
      events.push({
        type: 'tool.permission.resolved',
        actor: systemActor(),
        runId: this.activeRunId(conversation) ?? undefined,
        requestId: input.requestId,
        toolCallId: input.toolCall.id,
        toolName: input.toolCall.name,
        status: input.resolved.status,
        resolvedBy: input.resolved.resolvedBy,
        updatedRule: input.resolved.updatedRule,
        deniedReason: input.resolved.deniedReason,
      });
    }
    await this.appendConversationEvents(conversationId, conversation, events);
  }

  private async appendUserPromptEvent(
    conversationId: string,
    conversation: AgentConversationState,
    prompt: UserMessage,
    options: { addressedTo?: AgentPrincipal[] } = {},
  ): Promise<string> {
    const messageId = this.createMessageId('user');
    const persisted = await this.persistPiUserContent(conversationId, prompt.content, {
      imageSummary: 'Image attachment',
    });
    const inputs: AgentEventInput[] = [
      ...persisted.payloads.map((payload): AgentEventInput => ({
        type: 'payload.created',
        actor: userActor(),
        payload,
      })),
      {
        type: 'user_message.created',
        actor: userActor(),
        createdAt: prompt.timestamp,
        messageId,
        parentMessageId: conversation.eventState.selectedLeafMessageId,
        content: persisted.content,
        attachments: persisted.payloads.length > 0 ? persisted.payloads : undefined,
        addressedTo: options.addressedTo,
      },
      {
        type: 'branch.selected',
        actor: systemActor(),
        leafMessageId: messageId,
      },
    ];

    const title = deriveTitleFromPersistedContent(persisted.content);
    if (title && (!conversation.eventState.conversation?.title || conversation.eventState.conversation.title === 'Untitled')) {
      inputs.push({
        type: 'conversation.renamed',
        actor: systemActor(),
        title,
      });
    }

    await this.appendConversationEvents(conversationId, conversation, inputs);
    return messageId;
  }

  private async appendSystemPromptEvent(conversationId: string, conversation: AgentConversationState, prompt: UserMessage) {
    const messageId = this.createMessageId('user');
    const persisted = await this.persistPiUserContent(conversationId, prompt.content, {
      imageSummary: 'System notification attachment',
    });
    const actor = systemActor();
    await this.appendConversationEvents(conversationId, conversation, [
      ...persisted.payloads.map((payload): AgentEventInput => ({
        type: 'payload.created',
        actor,
        payload,
      })),
      {
        type: 'user_message.created',
        actor,
        createdAt: prompt.timestamp,
        messageId,
        parentMessageId: conversation.eventState.selectedLeafMessageId,
        content: persisted.content,
        attachments: persisted.payloads.length > 0 ? persisted.payloads : undefined,
      },
      {
        type: 'branch.selected',
        actor,
        leafMessageId: messageId,
      },
    ]);
  }

  private async appendCompactionRootEvent(
    conversationId: string,
    conversation: AgentConversationState,
    prompt: UserMessage,
    summary: string,
    source: AgentCompactionSourceRange,
    trigger: 'manual' | 'auto' | 'reactive',
    preservedMessages: readonly AgentMessage[] = [],
  ) {
    const messageId = this.createMessageId('user');
    const persisted = await this.persistPiUserContent(conversationId, prompt.content, {
      imageSummary: 'Compaction attachment',
    });
    let leafMessageId = messageId;
    const inputs: AgentEventInput[] = [
      ...persisted.payloads.map((payload): AgentEventInput => ({
        type: 'payload.created',
        actor: systemActor(),
        payload,
      })),
      {
        type: 'compaction.completed',
        actor: systemActor(),
        messageId,
        summary,
        source,
        trigger,
      },
      {
        type: 'user_message.created',
        actor: systemActor(),
        createdAt: prompt.timestamp,
        messageId,
        parentMessageId: null,
        content: persisted.content,
        attachments: persisted.payloads.length > 0 ? persisted.payloads : undefined,
      },
    ];

    for (const message of preservedMessages) {
      const clone = await this.buildPreservedMessageEvents(conversationId, conversation, message, leafMessageId);
      inputs.push(...clone.inputs);
      leafMessageId = clone.messageId;
    }

    inputs.push(
      {
        type: 'branch.selected',
        actor: systemActor(),
        leafMessageId,
      },
    );

    await this.appendConversationEvents(conversationId, conversation, inputs);
  }

  private async appendDreamFinishedEvent(
    conversationId: string,
    conversation: AgentConversationState,
    result: AgentDreamRunResult,
  ) {
    const messageId = this.createMessageId('user');
    const timestamp = result.completedAt;
    const reminder = systemReminder([
      `Memory Dream ${result.status}.`,
      result.runId ? `Run id: ${result.runId}.` : null,
      result.errorMessage ? `Error: ${result.errorMessage}` : null,
    ].filter(Boolean).join('\n'));
    await this.appendConversationEvents(conversationId, conversation, [
      {
        type: 'dream.finished',
        actor: systemActor(),
        createdAt: timestamp,
        messageId,
        agentId: result.agentId,
        runId: result.runId,
        trigger: result.trigger,
        status: result.status,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        processed: result.processed,
        changes: result.changes,
        errorMessage: result.errorMessage,
      },
      {
        type: 'user_message.created',
        actor: systemActor(),
        createdAt: timestamp,
        messageId,
        parentMessageId: conversation.eventState.selectedLeafMessageId,
        content: [{ type: 'text', text: reminder }],
      },
      {
        type: 'branch.selected',
        actor: systemActor(),
        createdAt: timestamp,
        leafMessageId: messageId,
      },
    ]);
  }

  private async buildPreservedMessageEvents(
    conversationId: string,
    conversation: AgentConversationState,
    message: AgentMessage,
    parentMessageId: string,
  ): Promise<{ messageId: string; inputs: AgentEventInput[] }> {
    if (message.role === 'assistant') {
      const messageId = this.createMessageId('assistant');
      const runId = randomUUID();
      // The preserved tail belongs to the turn being compacted: stamp the
      // EXECUTING run's agent (a Channel peer keeps owning its own words), not
      // the runtime's main-agent actor. The synthetic runId is unregistered, so
      // ownership resolution falls through to this actor — it must be right.
      const executingAgentId = (conversation.activeRun ?? conversation.lastRun)?.executingAgentId
        ?? this.agentIdentity.agentId;
      const actor: AgentActor = { type: 'agent', agentId: executingAgentId as AgentId };
      return {
        messageId,
        inputs: [
          {
            type: 'assistant_message.started',
            actor,
            runId,
            messageId,
            parentMessageId,
            providerId: message.provider,
            modelId: message.model,
            apiId: message.api,
            createdAt: message.timestamp,
          },
          {
            type: 'assistant_message.completed',
            actor,
            runId,
            messageId,
            stopReason: message.stopReason,
            content: fromPiAssistantContent(message.content),
            usage: message.usage,
            createdAt: message.timestamp,
          },
        ],
      };
    }

    if (message.role === 'toolResult') {
      const messageId = this.createMessageId('tool-result');
      const persisted = await this.persistPiUserContent(conversationId, message.content, {
        imageSummary: `${message.toolName} image output`,
        textPayloadRole: 'tool_output',
        textSummary: `${message.toolName} output`,
        textPayloadIdPrefix: `tool-output-${message.toolCallId}-${messageId}`,
      });
      const outputRef = persisted.payloads.find((payload) => payload.role === 'tool_output') ?? persisted.payloads[0];
      const actor = toolActor(message.toolName, message.toolCallId);
      return {
        messageId,
        inputs: [
          ...persisted.payloads.map((payload): AgentEventInput => ({
            type: 'payload.created',
            actor,
            payload,
            createdAt: message.timestamp,
          })),
          {
            type: 'tool_result.created',
            actor,
            messageId,
            parentMessageId,
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            isError: message.isError,
            content: persisted.content,
            outputSummary: summarizeToolResult(message),
            outputRef,
            createdAt: message.timestamp,
          },
        ],
      };
    }

    const messageId = this.createMessageId('user');
    const persisted = await this.persistPiUserContent(conversationId, message.content, {
      imageSummary: 'Compaction preserved attachment',
    });
    return {
      messageId,
      inputs: [
        ...persisted.payloads.map((payload): AgentEventInput => ({
          type: 'payload.created',
          actor: userActor(),
          payload,
          createdAt: message.timestamp,
        })),
        {
          type: 'user_message.created',
          actor: userActor(),
          messageId,
          parentMessageId,
          content: persisted.content,
          attachments: persisted.payloads.length > 0 ? persisted.payloads : undefined,
          createdAt: message.timestamp,
        },
      ],
    };
  }

  /** The Channel coordinator (member role, ratified): the main agent by default. */
  private coordinatorAgentId(): string {
    return this.agentIdentity.agentId;
  }

  /**
   * Recovery for a run that died without pi emitting `agent_end` (a rejected
   * `prompt()`/`continue()`, a pre-stream failure): `agent_end` is the only
   * normal path that clears `activeRun`, so without this every later run —
   * DM or Channel — would hit the `startRun` guard until restart. Records the
   * failure on the run ledger (best-effort) and frees the slot.
   *
   * Scoped to the run the caller actually started (`runId`): a catch must
   * never "recover" a HEALTHY foreign run — e.g. a send whose `startRun` hit
   * the already-active guard while a notification flush sat between its
   * `run.started` append and `prompt()` (activeRun set, isStreaming still
   * false). `null` (the caller never got a run started) is a no-op, and the
   * id match also makes a double-entered recovery idempotent: the first
   * clears the slot, the second no-ops.
   */
  private async recoverFromRunError(conversationId: string, runId: string | null) {
    if (!runId) return;
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    const activeRun = conversation.activeRun;
    if (!activeRun || activeRun.id !== runId || conversation.agent.state.isStreaming) return;
    try {
      await this.appendConversationEvents(conversationId, conversation, [{
        type: 'run.failed',
        actor: systemActor(),
        runId: activeRun.id,
        errorMessage: conversation.agent.state.errorMessage ?? 'The run ended without a terminal agent event.',
        usage: sumRunUsage(conversation.eventState, activeRun.id),
      }]);
    } catch {
      // Recording the failure is best-effort; freeing the slot is the
      // critical part — a wedged activeRun blocks the conversation forever.
    }
    conversation.lastRun = activeRun;
    conversation.activeRun = null;
  }

  private async startRun(
    conversationId: string,
    conversation: AgentConversationState,
    prompt: UserMessage | null = null,
    triggerOverride: AgentRunTrigger | null = null,
    identity: { executingAgentId?: string; addressedByMessageId?: string | null } = {},
  ): Promise<string> {
    // The single activeRun slot is what stamps every durable event of the turn;
    // overwriting a live run would misattribute its remaining events. All
    // legitimate transitions clear activeRun (agent_end) before the next run.
    if (conversation.activeRun) {
      throw new Error('A run is already active in this conversation.');
    }
    const runId = randomUUID();
    const agentId = (identity.executingAgentId ?? this.agentIdentity.agentId) as AgentId;
    const runState: AgentActiveRunState = {
      id: runId,
      assistantMessageId: null,
      assistantText: '',
      lastSubmittedUserPrompt: prompt,
      toolOutputPayloads: new Map(),
      toolCallMessageIds: new Map(),
      executingAgentId: agentId,
      addressedByMessageId: identity.addressedByMessageId ?? null,
    };
    conversation.activeRun = runState;
    conversation.lastRun = null;
    try {
      await this.appendConversationEvents(conversationId, conversation, [{
        type: 'run.started',
        actor: systemActor(),
        runId,
        agentId,
        anchor: { type: 'conversation', agentId, conversationId },
        kind: 'turn',
        trigger: triggerOverride ?? this.runTrigger(conversation),
        fingerprint: this.runFingerprint(conversation, agentId),
        retention: 'hot',
      }]);
    } catch (error) {
      // The run never made it into the ledger — release the slot, or every
      // later run in this conversation hits the guard above until restart.
      conversation.activeRun = null;
      throw error;
    }
    return runId;
  }

  /**
   * Routing for a Channel user turn: explicit `@member` mentions (scoped to the
   * roster) bypass the coordinator entirely; no mention → the coordinator (the
   * main agent by default — PM gate Q1, ratified 2026-06-10).
   */
  private resolveAddressedMembers(messageText: string, members: readonly AgentPrincipal[]): AgentPrincipal[] {
    const mentioned = parseAgentMentionTargets(messageText, members);
    if (mentioned.length > 0) return mentioned;
    return [{ type: 'agent', agentId: this.coordinatorAgentId() as AgentId }];
  }

  /**
   * The Channel round loop (ratified 2026-06-10): drains the conversation's
   * pending-message queue, one message = one round. Each round runs every
   * addressed member sequentially — execution is serial, but SEMANTICS are
   * independent: every turn's context cuts at the message that addressed it,
   * so same-round co-addressees never see each other. A completed turn's reply
   * may `@` members (hand-off): those turns are addressed BY that reply and the
   * chain is unbounded — `stop` is the circuit breaker. One addressee's failure
   * leaves its failed-run trace and never skips siblings; only a user stop
   * (run.cancelled / stopRequested) ends the round, discarding unstarted
   * routing with a visible trace.
   */
  private async runChannelRound(
    conversationId: string,
    conversation: AgentConversationState,
  ): Promise<void> {
    if (conversation.channelRound) return;
    // A non-round Channel run (regenerate/retry, notification flush) is live:
    // starting a round under it would re-point the leaf beneath its in-flight
    // reply. That path drains the queue when it settles.
    if (this.activeRunId(conversation) || conversation.agent.state.isStreaming) return;
    const round = { stopRequested: false };
    conversation.channelRound = round;
    try {
      // Outer loop: after a stop is handled, messages that arrived during the
      // teardown route as a fresh logical round (a post-stop send is a new
      // request, not part of the stopped round) — nothing strands in the queue.
      while (conversation.pendingChannelMessages.length > 0) {
        let discardedTurns = 0;
        while (conversation.pendingChannelMessages.length > 0 && !round.stopRequested) {
          const pending = conversation.pendingChannelMessages.shift()!;
          let routed: { messageId: string; addressedTo: AgentPrincipal[] };
          try {
            routed = await this.persistPendingChannelMessage(conversationId, conversation, pending);
          } catch (error) {
            // One message's persist failure must not strand the rest of the queue.
            this.emitError(conversationId, error instanceof Error ? error.message : String(error));
            continue;
          }
          const turns: ChannelTurnRequest[] = routed.addressedTo
            .filter((target): target is Extract<AgentPrincipal, { type: 'agent' }> => target.type === 'agent')
            .map((target) => ({ agentId: target.agentId, addressedByMessageId: routed.messageId }));
          while (turns.length > 0) {
            if (round.stopRequested) break;
            const request = turns.shift()!;
            const members = conversation.eventState.conversation?.members ?? [];
            if (!members.some((member) => member.type === 'agent' && member.agentId === request.agentId)) continue;
            const turn = await this.runChannelTurn(conversationId, conversation, request);
            if (turn.cancelled) {
              round.stopRequested = true;
              break;
            }
            if (!turn.completed) continue; // failed run: its error trace is in the log; siblings still run
            if (!turn.assistantMessageId) continue;
            // The reply's hand-off addressing was persisted at completion
            // (assistant_message.completed.addressedTo) — route from the record,
            // not a re-parse, so the log and the routing can never disagree.
            const reply = conversation.eventState.messages[turn.assistantMessageId];
            for (const target of channelAgentMembers(reply?.addressedTo ?? [])) {
              if (target.agentId === request.agentId) continue;
              turns.push({ agentId: target.agentId, addressedByMessageId: turn.assistantMessageId });
            }
          }
          discardedTurns += turns.length;
        }
        if (!round.stopRequested) break; // queue drained normally
        // Stop: persist the stopped round's unrouted queued messages (the user
        // typed them; they must not vanish) — they just never produce runs.
        const unrouted = conversation.pendingChannelMessages;
        conversation.pendingChannelMessages = [];
        for (const pending of unrouted) {
          try {
            await this.persistPendingChannelMessage(conversationId, conversation, pending);
          } catch (error) {
            this.emitError(conversationId, error instanceof Error ? error.message : String(error));
          }
        }
        if (discardedTurns > 0 || unrouted.length > 0) {
          const parts = [
            discardedTurns > 0 ? `${discardedTurns} unstarted turn(s) were discarded` : null,
            unrouted.length > 0 ? `${unrouted.length} queued message(s) were not routed; they remain above and can be re-sent` : null,
          ].filter((part): part is string => part !== null);
          await this.appendSystemPromptEvent(conversationId, conversation, {
            role: 'user',
            content: [{
              type: 'text',
              text: systemReminder(`The user stopped this round. ${parts.join('; ')}.`),
            }],
            timestamp: Date.now(),
          });
        }
        round.stopRequested = false;
      }
    } finally {
      conversation.channelRound = null;
    }
    // A push that raced the teardown (channelRound was still set when its send
    // checked the gate) re-enters as a fresh round. Reached only on a normal
    // exit — a throw propagates to the caller and the next trigger (send,
    // settle-drain, quit-flush) picks the queue up instead, so a persistent
    // failure cannot loop.
    if (conversation.pendingChannelMessages.length > 0) {
      await this.runChannelRound(conversationId, conversation);
    }
  }

  /**
   * Drain trigger for non-round Channel runs (regenerate/retry, notification
   * flush): messages queued while such a run was live are routed when it
   * settles — sendMessage's gate returned without starting a round.
   */
  private async drainChannelQueueIfIdle(conversationId: string, conversation: AgentConversationState): Promise<void> {
    if (conversation.pendingChannelMessages.length === 0) return;
    await this.runChannelRound(conversationId, conversation);
  }

  /**
   * Persist one round-queue entry at routing time: a `prompt` entry is appended
   * to the (now settled) active leaf with its addressing resolved against the
   * current roster; a `persisted` entry (edit path) is already in the log.
   */
  private async persistPendingChannelMessage(
    conversationId: string,
    conversation: AgentConversationState,
    pending: PendingChannelMessage,
  ): Promise<{ messageId: string; addressedTo: AgentPrincipal[] }> {
    if (pending.kind === 'persisted') return { messageId: pending.messageId, addressedTo: pending.addressedTo };
    const members = conversation.eventState.conversation?.members ?? [];
    const addressedTo = this.resolveAddressedMembers(pending.messageText, members);
    const messageId = await this.appendUserPromptEvent(conversationId, conversation, pending.prompt, { addressedTo });
    return { messageId, addressedTo };
  }

  /**
   * One member's turn in a Channel, executed AS that member on the conversation's
   * agent loop: its system prompt, model/effort, tool surface, memory line, and
   * its §8 POV of the shared thread. The conversation agent is reconfigured for
   * the turn and always restored — the event pipeline (approvals, permissions,
   * steering, projections) is shared and untouched.
   */
  private async runChannelTurn(
    conversationId: string,
    conversation: AgentConversationState,
    request: ChannelTurnRequest,
  ): Promise<{ completed: boolean; cancelled: boolean; text: string; assistantMessageId: string | null }> {
    const agent = conversation.agent;
    const targetAgentId = request.agentId;
    const isMainAgent = targetAgentId === this.coordinatorAgentId();
    const snapshot = {
      systemPrompt: agent.state.systemPrompt,
      model: agent.state.model,
      thinkingLevel: agent.state.thinkingLevel,
    };
    let startedRunId: string | null = null;
    try {
      if (!isMainAgent) {
        const profile = await this.resolveChannelPeerProfile(conversation, targetAgentId);
        agent.state.systemPrompt = profile.systemPrompt;
        agent.state.model = profile.model as never;
        agent.state.thinkingLevel = profile.thinkingLevel as never;
        this.applyChannelTurnToolSettings(conversation, targetAgentId, profile.definition);
        await this.getEventStore().writeAgentIdentity(profile.identity);
      }
      const runId = await this.startRun(conversationId, conversation, null, null, {
        executingAgentId: targetAgentId,
        addressedByMessageId: request.addressedByMessageId,
      });
      startedRunId = runId;
      // With the run active, this resolves to the member's §8 POV assembly with
      // the independence cut — the same derivation every later model call re-runs.
      agent.state.messages = await this.deriveRuntimePiMessages(conversationId, conversation.eventState) as never;
      await agent.continue();
      // Context overflow retries while the member's profile is still applied —
      // the retry run must execute as the SAME member, never the coordinator.
      await this.contextManager.runReactiveCompactRetryIfNeeded(conversationId, conversation);
      // An overflow retry completes the turn under a NEW runId — evaluate the
      // run that actually settled the turn (lastRun, set at its agent_end),
      // falling back to the original when no run reached agent_end at all.
      const settledRunId = conversation.lastRun?.id ?? runId;
      const run = conversation.eventState.runs[settledRunId];
      return {
        completed: run?.status === 'completed',
        cancelled: run?.status === 'cancelled',
        text: latestAssistantTextForRun(conversation.eventState, settledRunId),
        assistantMessageId: latestAssistantMessageIdForRun(conversation.eventState, settledRunId),
      };
    } catch (error) {
      // A pre-run failure (profile resolution, provider config) must not kill
      // the round's sibling turns; surface it, free THIS turn's run slot if it
      // wedged, and let the loop continue.
      await this.recoverFromRunError(conversationId, startedRunId);
      this.emitError(conversationId, error instanceof Error ? error.message : String(error));
      return { completed: false, cancelled: false, text: '', assistantMessageId: null };
    } finally {
      agent.state.systemPrompt = snapshot.systemPrompt;
      agent.state.model = snapshot.model;
      agent.state.thinkingLevel = snapshot.thinkingLevel;
      if (!isMainAgent) this.applyRuntimeToolSettings(conversation);
      try {
        agent.state.messages = await this.deriveRuntimePiMessages(conversationId, conversation.eventState) as never;
      } catch {
        // Restore is best-effort; the next turn re-derives from the event log anyway.
      }
    }
  }

  /**
   * A Channel member's runtime profile, resolved from its agent definition
   * (capability binds to the agent, never the conversation): identity record,
   * model/effort overrides, and a member-voiced system prompt with its profile
   * skills inlined.
   */
  private async resolveChannelPeerProfile(
    conversation: AgentConversationState,
    agentId: string,
  ): Promise<{
    identity: AgentIdentityRecord;
    model: Model<Api>;
    thinkingLevel: AgentReasoningLevel;
    systemPrompt: string;
    definition: AgentDefinition;
  }> {
    const definitions = await conversation.subagentRuntime.listAllAgentDefinitions();
    const definition = definitions.find((candidate) => agentDefinitionAgentId(candidate) === agentId);
    if (!definition) throw new Error(`Channel member agent not found: ${agentId}`);
    const providerConfig = await this.getActiveProviderConfig();
    if (!providerConfig) throw new Error('No enabled agent provider is configured.');
    const inheritedModel = this.resolveProviderModel(providerConfig);
    const model = definition.model
      ? resolveSkillModelOverride(definition.model, providerConfig, inheritedModel)
      : inheritedModel;
    const thinkingLevel = definition.effort
      ? resolveSkillEffortOverride(definition.effort, model, providerConfig.reasoningLevel)
      : providerConfig.reasoningLevel;
    const skillSections = await this.channelPeerSkillSections(conversation, definition);
    const systemPrompt = buildChannelPeerSystemPrompt(definition, agentMentionToken(agentId), skillSections);
    const identity: AgentIdentityRecord = {
      agentId: agentId as AgentId,
      displayName: agentDefinitionDisplayName(definition),
      model: model.id,
      effort: String(thinkingLevel),
      systemPrompt,
      skills: definition.skills ?? [],
    };
    return { identity, model, thinkingLevel, systemPrompt, definition };
  }

  /**
   * Profile skills travel with the member ([[agent-conversation-model]]): inline
   * their bodies into the member's system prompt. Static read — no invocation
   * side effects on the shared conversation skill runtime.
   */
  private async channelPeerSkillSections(
    conversation: AgentConversationState,
    definition: AgentDefinition,
  ): Promise<string[]> {
    const names = definition.skills ?? [];
    if (names.length === 0) return [];
    try {
      const skills = await conversation.skillRuntime.listAllSkills();
      const sections: string[] = [];
      let budget = CHANNEL_PEER_SKILL_PROMPT_BUDGET;
      for (const name of names) {
        const skill = skills.find((candidate) => candidate.name === name);
        if (!skill || !skill.body.trim()) continue;
        const body = skill.body.trim().slice(0, Math.max(0, budget));
        if (!body) break;
        budget -= body.length;
        sections.push(`## Skill: ${skill.name}\n${body}`);
      }
      return sections;
    } catch {
      return [];
    }
  }

  /** Per-turn tool surface for a peer member: its tool allow/deny lists, its own recall pool. */
  private applyChannelTurnToolSettings(
    conversation: AgentConversationState,
    agentId: string,
    definition: AgentDefinition,
  ): void {
    conversation.agent.state.tools = createAgentTools(this.outlinerToolHost, {
      localFileRoot: this.options.localFileRoot,
      localWorkspace: conversation.localWorkspace,
      skillRuntime: conversation.skillRuntime,
      skillToolEnabled: conversation.runtimeSettings.automaticSkillsEnabled,
      subagentRuntime: conversation.subagentRuntime,
      recall: this.createRecallToolRuntime(agentId, () => conversation.eventState.conversation?.id ?? 'unknown', () => conversation),
      askUserQuestion: this.createAskUserQuestionRuntime(() => conversation.eventState.conversation?.id ?? 'unknown', () => conversation),
      // Self-maintenance configures THIS runtime — main-agent-first stays the
      // standing default (M3-A non-goal: no who-configures-whom), so peers don't get it.
      allowedTools: definition.tools,
      disallowedTools: definition.disallowedTools,
    });
  }

  /**
   * §8 POV assembly for a Channel member's run: the member's own turns verbatim
   * (toolCall/toolResult pairing intact); the user and other members coalesced
   * into user-role blocks with one identity preamble per source turn; the
   * member's memory briefing appended transiently (the persisted log stays
   * reader-neutral).
   */
  private async deriveChannelPiMessages(
    conversationId: string,
    conversation: AgentConversationState,
    povAgentId: string,
    memoryReminder: string | null,
    addressedByMessageId: string | null,
  ): Promise<AgentMessage[]> {
    const eventState = conversation.eventState;
    // Independence cut first (context ends at the addressing message, plus the
    // member's own in-flight records), then the §8 flatten over what remains.
    const path = cutChannelPathForRun(
      getAgentEventRuntimeTranscriptPath(eventState),
      eventState.runs,
      povAgentId,
      addressedByMessageId,
      this.coordinatorAgentId(),
    );
    const steps = flattenAgentPathForPov(
      path,
      eventState.runs,
      povAgentId,
      {
        mainAgentId: this.coordinatorAgentId(),
        displayNameByAgentId: conversation.memberDisplayNames,
      },
    );
    const messages: AgentMessage[] = [];
    for (const step of steps) {
      if (step.kind === 'verbatim') {
        messages.push(await this.runtimePiMessageFromRecord(conversationId, step.record));
        continue;
      }
      const content: (TextContent | ImageContent)[] = [];
      for (const part of step.parts) {
        if (part.preamble) content.push({ type: 'text', text: systemReminder(part.preamble) });
        if (part.record.role === 'user') {
          content.push(...await this.runtimeUserContent(conversationId, part.record.content));
        } else {
          const text = persistedTextContent(part.record.content);
          if (text) content.push({ type: 'text', text });
        }
      }
      messages.push({
        role: 'user',
        content: content.length > 0 ? content : [{ type: 'text', text: '' }],
        timestamp: step.parts.at(-1)!.record.createdAt,
      } satisfies UserMessage);
    }
    if (memoryReminder) {
      const reminderText = systemReminder(memoryReminder);
      const last = messages.at(-1);
      if (last?.role === 'user' && Array.isArray(last.content)) {
        last.content = [...last.content, { type: 'text', text: reminderText }];
      } else {
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: reminderText }],
          timestamp: Date.now(),
        } satisfies UserMessage);
      }
    }
    return messages;
  }

  private async compactConversation(conversationId: string, conversation: AgentConversationState, customInstructions?: string) {
    try {
      await this.contextManager.compactConversation(conversationId, conversation, {
        trigger: 'manual',
        customInstructions,
        updateAgentState: true,
      });
      conversation.skillRuntime.resetRunPermissionRules();
    } finally {
      conversation.currentDebugQueryIndex = 0;
    }
  }

  private async handlePiAgentEvent(conversationId: string, conversation: AgentConversationState, event: PiAgentEvent) {
    if (event.type === 'message_start' || event.type === 'message_update') {
      if (isAssistantMessage(event.message)) {
        await this.ensureAssistantStarted(conversationId, conversation, event.message);
        await this.appendAssistantDelta(conversationId, conversation, event.message);
      }
      return;
    }

    if (event.type === 'message_end') {
      if (isUserMessage(event.message)) {
        if (!isDuplicateTailUserMessage(conversation.eventState, event.message)) {
          await this.appendUserPromptEvent(conversationId, conversation, event.message);
        }
        conversation.queuedFollowUpSkillListingReservation = null;
        return;
      }
      if (isAssistantMessage(event.message)) {
        await this.ensureAssistantStarted(conversationId, conversation, event.message);
        await this.appendToolCallEventsFromAssistant(conversationId, conversation, event.message);
        await this.appendAssistantCompleted(conversationId, conversation, event.message);
        return;
      }
      if (isToolResultMessage(event.message)) {
        await this.appendToolResultMessage(conversationId, conversation, event.message);
      }
      return;
    }

    if (event.type === 'tool_execution_start') {
      await this.appendToolExecutionStart(conversationId, conversation, event.toolCallId, event.toolName, event.args);
      return;
    }

    if (event.type === 'tool_execution_end') {
      await this.appendToolExecutionEnd(conversationId, conversation, event.toolCallId, event.toolName, event.result, event.isError);
      return;
    }

    if (event.type === 'agent_end' && conversation.activeRun) {
      const activeRun = conversation.activeRun;
      const errorMessage = conversation.agent.state.errorMessage ?? null;
      const terminalAssistant = [...event.messages].reverse().find(isAssistantMessage);
      const cancelled = terminalAssistant?.stopReason === 'aborted';
      const contextOverflow = terminalAssistant
        ? isContextOverflow(terminalAssistant, conversation.agent.state.model.contextWindow)
        : false;
      await this.appendConversationEvents(conversationId, conversation, [{
        type: cancelled ? 'run.cancelled' : errorMessage ? 'run.failed' : 'run.completed',
        actor: systemActor(),
        runId: activeRun.id,
        errorMessage: cancelled ? undefined : errorMessage ?? undefined,
        usage: sumRunUsage(conversation.eventState, activeRun.id),
      }]);
      conversation.reactiveCompactRequested = Boolean(!cancelled && contextOverflow);
      if (!conversation.reactiveCompactRequested) activeRun.lastSubmittedUserPrompt = null;
      conversation.lastRun = activeRun;
      conversation.activeRun = null;
      conversation.skillRuntime.resetRunPermissionRules();
      await this.getEventStore().maybeWriteCheckpoint(conversationId, conversation.eventState, { force: true });
    }
  }

  private async ensureAssistantStarted(conversationId: string, conversation: AgentConversationState, message: AssistantMessage) {
    const activeRun = conversation.activeRun;
    if (!activeRun || activeRun.assistantMessageId) return;
    const messageId = this.createMessageId('assistant');
    activeRun.assistantMessageId = messageId;
    activeRun.assistantText = '';
    await this.appendConversationEvents(conversationId, conversation, [{
      type: 'assistant_message.started',
      actor: this.runActor(conversation),
      runId: this.activeRunId(conversation) ?? randomUUID(),
      messageId,
      parentMessageId: conversation.eventState.selectedLeafMessageId,
      providerId: message.provider,
      modelId: message.model,
      apiId: message.api,
    }]);
  }

  private async appendAssistantDelta(conversationId: string, conversation: AgentConversationState, message: AssistantMessage) {
    const activeRun = conversation.activeRun;
    const messageId = activeRun?.assistantMessageId;
    if (!messageId) return;
    const nextText = assistantText(message);
    if (!nextText.startsWith(activeRun.assistantText) || nextText.length <= activeRun.assistantText.length) return;
    const delta = nextText.slice(activeRun.assistantText.length);
    activeRun.assistantText = nextText;
    await this.appendConversationEvents(conversationId, conversation, [{
      type: 'assistant_message.delta',
      actor: this.runActor(conversation),
      runId: this.activeRunId(conversation) ?? undefined,
      messageId,
      delta: { type: 'text_delta', text: delta },
      providerChunkCount: 1,
      startedAt: Date.now(),
      endedAt: Date.now(),
    }]);
  }

  private async appendAssistantCompleted(conversationId: string, conversation: AgentConversationState, message: AssistantMessage) {
    const activeRun = conversation.activeRun;
    const messageId = activeRun?.assistantMessageId;
    if (!messageId) return;
    // A provider/run failure surfaces as a terminal assistant message with an
    // error stop reason (pi-agent-core synthesizes it). Carry that error onto the
    // message record so the turn renders inline as a failed message (with retry),
    // rather than a separate top banner. Context-overflow failures are recovered
    // automatically by reactive compaction, so they are left unmarked.
    const inlineFailure = message.stopReason !== 'aborted'
      && message.errorMessage
      && !isContextOverflow(message, conversation.agent.state.model.contextWindow)
      ? message.errorMessage
      : null;
    // Hand-off routing record: a Channel reply's `@member` mentions are its
    // addressedTo — persisted so the relay decision lives in the log. Stamped
    // ONLY on the run's final segment (a `toolUse` stop means the turn
    // continues), exactly the record the round loop routes from
    // (`latestAssistantMessageIdForRun`) — the log never claims addressing
    // that does not route.
    const members = conversation.eventState.conversation?.members ?? [];
    const handOffAddressedTo = isMultiAgentConversation(members) && message.stopReason !== 'toolUse'
      ? handOffTargets(assistantVisibleText(message), members, activeRun.executingAgentId)
      : [];
    await this.appendConversationEvents(conversationId, conversation, [
      {
        type: 'assistant_message.completed',
        actor: this.runActor(conversation),
        runId: this.activeRunId(conversation) ?? undefined,
        messageId,
        stopReason: message.stopReason,
        content: fromPiAssistantContent(message.content),
        usage: message.usage,
        addressedTo: handOffAddressedTo.length > 0 ? handOffAddressedTo : undefined,
      },
      ...(inlineFailure ? [{
        type: 'assistant_message.failed' as const,
        actor: this.runActor(conversation),
        runId: this.activeRunId(conversation) ?? undefined,
        messageId,
        errorMessage: inlineFailure,
      }] : []),
    ]);
    activeRun.assistantMessageId = null;
    activeRun.assistantText = '';
  }

  private async appendToolResultMessage(conversationId: string, conversation: AgentConversationState, message: ToolResultMessage) {
    const activeRun = conversation.activeRun;
    if (!activeRun) return;
    const actor = toolActor(message.toolName, message.toolCallId);
    const prePersisted = activeRun.toolOutputPayloads.get(message.toolCallId);
    activeRun.toolOutputPayloads.delete(message.toolCallId);
    const persisted = prePersisted
      ? {
          content: [{ type: 'payload_ref', payload: prePersisted.payload, label: prePersisted.label }] satisfies AgentPersistedContent[],
          payloads: [prePersisted.payload],
        }
      : await this.persistPiUserContent(conversationId, message.content, {
          imageSummary: `${message.toolName} image output`,
          runId: this.activeRunId(conversation) ?? undefined,
          textPayloadRole: 'tool_output',
          textSummary: `${message.toolName} output`,
          textPayloadIdPrefix: `tool-output-${message.toolCallId}`,
        });
    const outputRef = prePersisted?.payload
      ?? persisted.payloads.find((payload) => payload.role === 'tool_output')
      ?? persisted.payloads[0];
    await this.appendConversationEvents(conversationId, conversation, [
      ...persisted.payloads.map((payload): AgentEventInput => ({
        type: 'payload.created',
        actor,
        payload,
      })),
      {
        type: 'tool_result.created',
        actor,
        runId: this.activeRunId(conversation) ?? undefined,
        messageId: this.createMessageId('tool-result'),
        parentMessageId: conversation.eventState.selectedLeafMessageId,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        isError: message.isError,
        content: persisted.content,
        outputSummary: summarizeToolResult(message),
        outputRef,
      },
    ]);
  }

  private async appendToolCallEventsFromAssistant(conversationId: string, conversation: AgentConversationState, message: AssistantMessage) {
    const activeRun = conversation.activeRun;
    const assistantMessageId = activeRun?.assistantMessageId;
    if (!assistantMessageId) return;
    const toolCalls = message.content.filter((part): part is ToolCall => part.type === 'toolCall');
    const inputs: AgentEventInput[] = [];
    for (const toolCall of toolCalls) {
      activeRun.toolCallMessageIds.set(toolCall.id, assistantMessageId);
      inputs.push({
        type: 'tool_call.started',
        actor: this.runActor(conversation),
        runId: this.activeRunId(conversation) ?? undefined,
        messageId: assistantMessageId,
        toolCallId: toolCall.id,
        name: toolCall.name,
        inputSummary: summarizeJson(toolCall.arguments),
        args: toolCall.arguments,
      });
    }
    if (inputs.length > 0) await this.appendConversationEvents(conversationId, conversation, inputs);
  }

  private async appendToolExecutionStart(
    conversationId: string,
    conversation: AgentConversationState,
    toolCallId: string,
    toolName: string,
    args: unknown,
  ) {
    const activeRun = conversation.activeRun;
    if (!activeRun || activeRun.toolCallMessageIds.has(toolCallId)) return;
    const messageId = findLatestAssistantMessageId(conversation.eventState);
    if (!messageId) return;
    activeRun.toolCallMessageIds.set(toolCallId, messageId);
    await this.appendConversationEvents(conversationId, conversation, [{
      type: 'tool_call.started',
      actor: toolActor(toolName, toolCallId),
      runId: this.activeRunId(conversation) ?? undefined,
      messageId,
      toolCallId,
      name: toolName,
      inputSummary: summarizeJson(args),
      args: isRecord(args) ? args : undefined,
    }]);
  }

  private async appendToolExecutionEnd(
    conversationId: string,
    conversation: AgentConversationState,
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
  ) {
    const activeRun = conversation.activeRun;
    const messageId = activeRun?.toolCallMessageIds.get(toolCallId) ?? findLatestAssistantMessageId(conversation.eventState);
    if (!messageId) return;
    const events: AgentEventInput[] = [{
      type: isError ? 'tool_call.failed' : 'tool_call.completed',
      actor: toolActor(toolName, toolCallId),
      runId: this.activeRunId(conversation) ?? undefined,
      messageId,
      toolCallId,
      errorMessage: isError ? summarizeJson(result) : undefined,
    }];
    const skillAuditEvent = isError ? null : skillAuditEventFromToolResult(toolName, toolCallId, result);
    if (skillAuditEvent) events.push(skillAuditEvent);
    await this.appendConversationEvents(conversationId, conversation, events);
  }

  private async deriveRuntimePiMessages(
    conversationId: string,
    eventState: AgentEventReplayState,
  ): Promise<AgentMessage[]> {
    // Every model call re-derives its context through here (the agent's
    // transformContext → prepareModelContext), so this is THE seam where a
    // multi-agent Channel turn gets its §8 POV assembly: the in-flight run's
    // executing member is the POV. Outside a run (restore, Dream, DMs) the
    // linear derivation stands.
    const conversation = this.conversations.get(conversationId);
    const activeRun = conversation?.activeRun;
    if (
      conversation
      && conversation.eventState === eventState
      && activeRun
      && this.requiresChannelPov(eventState, activeRun.executingAgentId)
    ) {
      const memoryReminder = await this.buildMemoryReminder(activeRun.executingAgentId, conversation);
      return this.deriveChannelPiMessages(
        conversationId,
        conversation,
        activeRun.executingAgentId,
        memoryReminder,
        activeRun.addressedByMessageId,
      );
    }
    const messages: AgentMessage[] = [];
    for (const message of getAgentEventRuntimeTranscriptPath(eventState)) {
      messages.push(await this.runtimePiMessageFromRecord(conversationId, message));
    }
    return messages;
  }

  /**
   * The POV flatten applies whenever the transcript CONTAINS another agent's
   * records — not merely when the live roster has ≥2 agents. A Channel shrunk
   * to one member must never feed the remaining agent the raw transcript (other
   * agents' turns would read as its own); membership history, not the roster,
   * is the authority.
   */
  private requiresChannelPov(eventState: AgentEventReplayState, executingAgentId: string): boolean {
    if (isMultiAgentConversation(eventState.conversation?.members ?? [])) return true;
    const coordinatorId = this.coordinatorAgentId();
    return getAgentEventRuntimeTranscriptPath(eventState).some((record) => {
      if (record.role === 'user') return false;
      const owner = channelMessageOwner(record, eventState.runs, coordinatorId);
      return owner.type === 'agent' && owner.agentId !== executingAgentId;
    });
  }

  private async runtimePiMessageFromRecord(
    conversationId: string,
    message: AgentEventMessageRecord,
  ): Promise<AgentMessage> {
    if (message.role === 'user') {
      return {
        role: 'user',
        content: await this.runtimeUserContent(conversationId, message.content),
        timestamp: message.createdAt,
      } satisfies UserMessage;
    }
    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: this.runtimeAssistantContent(message.content),
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
      content: await this.runtimeUserContent(conversationId, message.content),
      isError: !!message.isError,
      timestamp: message.createdAt,
    } satisfies ToolResultMessage;
  }

  private async persistPiUserContent(
    conversationId: string,
    content: UserMessage['content'] | ToolResultMessage['content'],
    options: {
      imageSummary: string;
      textPayloadRole?: AgentPayloadRef['role'];
      textSummary?: string;
      textPayloadIdPrefix?: string;
      runId?: string;
    },
  ): Promise<{ content: AgentPersistedContent[]; payloads: AgentPayloadRef[] }> {
    if (typeof content === 'string') {
      const persisted = await this.persistTextContent(conversationId, content, {
        ...options,
        textPayloadId: options.textPayloadIdPrefix,
      });
      return { content: [persisted.content], payloads: persisted.payload ? [persisted.payload] : [] };
    }

    const persisted: AgentPersistedContent[] = [];
    const payloads: AgentPayloadRef[] = [];
    const textPartCount = content.filter((part) => part.type === 'text').length;
    let textPartIndex = 0;
    for (const part of content) {
      if (part.type === 'text') {
        let textPayloadId: string | undefined;
        if (options.textPayloadIdPrefix) {
          textPayloadId = textPartCount <= 1
            ? options.textPayloadIdPrefix
            : `${options.textPayloadIdPrefix}-${textPartIndex}`;
        }
        textPartIndex += 1;
        const saved = await this.persistTextContent(conversationId, part.text, {
          ...options,
          textPayloadId,
        });
        persisted.push(saved.content);
        if (saved.payload) payloads.push(saved.payload);
        continue;
      }
      const payload = await this.getEventStore().writePayload(conversationId, {
        data: Buffer.from(stripDataUrlPrefix(part.data), 'base64'),
        mimeType: part.mimeType,
        runId: options.runId,
        role: 'source',
        summary: options.imageSummary,
      });
      payloads.push(payload);
      persisted.push({ type: 'image', imageRef: payload, alt: options.imageSummary });
    }
    return { content: persisted.length > 0 ? persisted : textPersistedContent(''), payloads };
  }

  private async persistTextContent(
    conversationId: string,
    text: string,
    options: {
      textPayloadRole?: AgentPayloadRef['role'];
      textSummary?: string;
      textPayloadId?: string;
      runId?: string;
    },
  ): Promise<{ content: AgentPersistedContent; payload?: AgentPayloadRef }> {
    if (!options.textPayloadRole || text.length <= MAX_INLINE_TOOL_OUTPUT_CHARS) {
      return { content: { type: 'text', text } };
    }
    const payload = await this.getEventStore().writePayload(conversationId, {
      id: options.textPayloadId,
      data: text,
      mimeType: 'text/plain',
      runId: options.runId,
      role: options.textPayloadRole,
      summary: summarizeTextPayload(text, options.textSummary ?? 'Tool output'),
      truncated: true,
    });
    const label = options.textPayloadRole === 'tool_output'
      ? buildPersistedToolOutputMessage(payload, text)
      : payload.summary;
    return {
      content: {
        type: 'payload_ref',
        payload,
        label,
      },
      payload,
    };
  }

  private async runtimeUserContent(
    conversationId: string,
    content: AgentPersistedContent[],
  ): Promise<Array<PiTextContent | PiImageContent>> {
    const parts: Array<PiTextContent | PiImageContent> = [];
    for (const part of content) {
      if (part.type === 'text') {
        parts.push({ type: 'text', text: part.text });
        continue;
      }
      if (part.type === 'image') {
        parts.push(await this.runtimeImageContent(conversationId, part.imageRef, part.alt));
        continue;
      }
      if (part.type === 'payload_ref' && part.payload.mimeType.startsWith('image/')) {
        parts.push(await this.runtimeImageContent(conversationId, part.payload, part.label));
        continue;
      }
      if (part.type === 'payload_ref' && part.payload.role === 'tool_output') {
        parts.push({
          type: 'text',
          text: part.label || part.payload.summary || `[payload:${part.payload.id}]`,
        });
        continue;
      }
      if (part.type === 'payload_ref') {
        parts.push(await this.runtimeTextPayloadContent(conversationId, part.payload, part.label));
        continue;
      }
      parts.push({ type: 'text', text: persistedContentText(part) });
    }
    return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
  }

  private runtimeAssistantContent(content: AgentPersistedContent[]): AssistantMessage['content'] {
    return content.flatMap((part): AssistantMessage['content'] => {
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
      return [{ type: 'text', text: persistedContentText(part) }];
    });
  }

  private async runtimeImageContent(
    conversationId: string,
    payload: AgentPayloadRef,
    label?: string,
  ): Promise<PiImageContent | PiTextContent> {
    try {
      const data = await this.getEventStore().readPayload(conversationId, payload);
      return {
        type: 'image',
        data: data.toString('base64'),
        mimeType: payload.mimeType,
      };
    } catch {
      return {
        type: 'text',
        text: label || payload.summary || `[missing image:${payload.id}]`,
      };
    }
  }

  private async runtimeTextPayloadContent(
    conversationId: string,
    payload: AgentPayloadRef,
    label?: string,
  ): Promise<PiTextContent> {
    try {
      const data = await this.getEventStore().readPayload(conversationId, payload);
      return {
        type: 'text',
        text: data.toString('utf8'),
      };
    } catch {
      return {
        type: 'text',
        text: label || payload.summary || `[missing payload:${payload.id}]`,
      };
    }
  }

  private localFileRoot() {
    return path.resolve(this.options.localFileRoot ?? process.cwd());
  }

  private async materializeFileAttachments(attachments: AgentMessageAttachmentInput[]): Promise<{
    attachments: AgentMessageAttachmentInput[];
    pathMap: Map<string, string>;
  }> {
    const root = this.localFileRoot();
    const out: AgentMessageAttachmentInput[] = [];
    const pathMap = new Map<string, string>();
    for (const attachment of attachments) {
      if (!attachmentHasPath(attachment)) {
        out.push(attachment);
        continue;
      }
      if (isDirectoryAttachment(attachment)) {
        out.push(attachment);
        continue;
      }
      const originalPath = attachment.path;
      const materialized = await materializePathBackedAttachment(root, attachment);
      out.push(materialized);
      if (materialized.path !== originalPath) {
        pathMap.set(originalPath, materialized.path);
      }
      const resolvedOriginal = path.resolve(path.isAbsolute(originalPath) ? originalPath : path.join(root, originalPath));
      if (materialized.path !== resolvedOriginal) {
        pathMap.set(resolvedOriginal, materialized.path);
      }
    }
    return { attachments: out, pathMap };
  }
}

function isDirectoryAttachment(attachment: AgentPathBackedAttachment): boolean {
  return attachment.kind === 'file' && attachment.mimeType === 'inode/directory';
}

// The instruction text for a scheduled command fire: the brief, plus a bounded
// note of when it last ran so the agent covers only what is new (catch-up
// digests "the last few days" rather than replaying full history).
function buildTriggeredCommandPrompt(brief: string, lastSuccessAt: number | null): string {
  const since = lastSuccessAt
    ? `This is a scheduled run. The previous successful run was ${new Date(lastSuccessAt).toISOString()} — cover what is new since then.`
    : 'This is the first scheduled run of this command.';
  return `${brief}\n\n(${since})`;
}

function buildUserPromptMessage(
  message: string,
  attachments: AgentMessageAttachmentInput[],
  context: {
    memoryReminder?: string | null;
    outlinerContext?: string | null;
    userViewContextReminder?: string | null;
    skillListingReminder?: string | null;
    agentListingReminder?: string | null;
  } = {},
  now = new Date(),
): UserMessage {
  const timestamp = now.getTime();
  const trimmed = message.trim();
  const baseText = trimmed || defaultAttachmentPrompt(attachments);
  const content: (TextContent | ImageContent)[] = [];
  const reminders = buildTurnReminderBlocks(attachments, context, now);
  content.push(...reminders);
  content.push({ type: 'text', text: baseText });

  for (const attachment of attachments) {
    if (attachment.kind !== 'text') continue;
    const text = attachment.text.slice(0, MAX_TEXT_ATTACHMENT_CHARS);
    content.push({
      type: 'text',
      text: serializeAgentTextAttachment({
        ...attachment,
        text,
        truncated: !!attachment.truncated || attachment.text.length > text.length,
      }),
    });
  }

  for (const attachment of attachments) {
    if (attachment.kind !== 'image') continue;
    content.push(toImageContent(attachment));
  }

  return {
    role: 'user',
    content,
    timestamp,
  };
}

function defaultAttachmentPrompt(attachments: AgentMessageAttachmentInput[]): string {
  const hasText = attachments.some((attachment) => attachment.kind === 'text');
  const hasImage = attachments.some((attachment) => attachment.kind === 'image');
  const hasFile = attachments.some((attachment) => attachment.kind === 'file');
  if ((hasText || hasFile) && hasImage) return 'Please review the attached files and images.';
  if (hasText || hasFile) return 'Please review the attached files.';
  return 'Please review the attached images.';
}

function toImageContent(attachment: AgentImageAttachmentInput): ImageContent {
  return {
    type: 'image',
    data: attachment.dataBase64,
    mimeType: attachment.mimeType,
  };
}

function normalizeAttachmentInputs(input: unknown): AgentMessageAttachmentInput[] {
  if (!Array.isArray(input)) return [];
  const attachments: AgentMessageAttachmentInput[] = [];
  for (const item of input.slice(0, MAX_ATTACHMENTS)) {
    const attachment = normalizeAttachmentInput(item);
    if (attachment) attachments.push(attachment);
  }
  return attachments;
}

function normalizeAttachmentInput(input: unknown): AgentMessageAttachmentInput | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const kind = record.kind;
  const id = stringOrFallback(record.id, randomUUID());
  const name = stringOrFallback(record.name, 'attachment').slice(0, MAX_ATTACHMENT_NAME_LENGTH);
  const ref = sanitizeFileReferenceRef(stringOrFallback(record.ref, name)).slice(0, MAX_ATTACHMENT_NAME_LENGTH);
  const mimeType = stringOrFallback(record.mimeType, 'application/octet-stream');
  const sizeBytes = Number.isFinite(record.sizeBytes) ? Math.max(0, Number(record.sizeBytes)) : 0;

  if (kind === 'image') {
    const normalizedMimeType = normalizeInlineImageMimeType(mimeType);
    if (!normalizedMimeType) return null;
    const dataBase64 = typeof record.dataBase64 === 'string'
      ? stripDataUrlPrefix(record.dataBase64)
      : '';
    if (!dataBase64) return null;
    if (dataBase64.length > MAX_IMAGE_ATTACHMENT_BASE64_CHARS) return null;
    const filePath = stringOrFallback(record.path, '');
    return {
      id,
      ref,
      kind: 'image',
      name,
      mimeType: normalizedMimeType,
      sizeBytes,
      dataBase64,
      ...(filePath ? { path: filePath } : {}),
    };
  }

  if (kind === 'text') {
    const rawText = typeof record.text === 'string' ? record.text : '';
    const text = rawText.slice(0, MAX_TEXT_ATTACHMENT_CHARS);
    return {
      id,
      ref,
      kind: 'text',
      name,
      mimeType,
      sizeBytes,
      text,
      truncated: !!record.truncated || rawText.length > text.length,
    };
  }

  if (kind === 'file') {
    const filePath = stringOrFallback(record.path, '');
    if (!filePath) return null;
    return { id, ref, kind: 'file', name, mimeType, sizeBytes, path: filePath };
  }

  return null;
}

function normalizeInlineImageMimeType(mimeType: string): string | null {
  const normalized = mimeType.toLowerCase();
  if (normalized === 'image/jpg') return 'image/jpeg';
  if (SUPPORTED_INLINE_IMAGE_MIME_TYPES.has(normalized)) return normalized;
  return null;
}

function stripDataUrlPrefix(data: string): string {
  const marker = ';base64,';
  const markerIndex = data.indexOf(marker);
  if (!data.startsWith('data:') || markerIndex < 0) return data;
  return data.slice(markerIndex + marker.length);
}

function buildTurnReminderBlocks(
  attachments: AgentMessageAttachmentInput[],
  context: {
    memoryReminder?: string | null;
    outlinerContext?: string | null;
    userViewContextReminder?: string | null;
    skillListingReminder?: string | null;
    agentListingReminder?: string | null;
  },
  now: Date,
): TextContent[] {
  const blocks: TextContent[] = [];
  const reminder = joinReminderParts([
    buildEnvironmentContextReminder(now),
    context.memoryReminder,
    context.outlinerContext,
    context.userViewContextReminder,
    context.skillListingReminder,
    context.agentListingReminder,
  ]);
  if (reminder) {
    blocks.push({ type: 'text', text: systemReminder(reminder) });
  }

  return blocks;
}

function joinReminderParts(parts: Array<string | null | undefined>): string | null {
  const filtered = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return filtered.length > 0 ? filtered.join('\n\n') : null;
}

function buildEnvironmentContextReminder(now: Date): string {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  return [
    '<environment-context>',
    `Current local time: ${formatLocalDateTime(now)}`,
    `Current local date: ${formatLocalDate(now)}`,
    `IANA time zone: ${escapeReminderText(resolved.timeZone || 'unknown')}`,
    `UTC offset: ${formatUtcOffset(-now.getTimezoneOffset())}`,
    `UTC time: ${now.toISOString()}`,
    resolved.locale ? `Locale: ${escapeReminderText(resolved.locale)}` : '',
    '</environment-context>',
  ].filter(Boolean).join('\n');
}

function groupDreamAgentRunInputsByOriginWorkspace(
  inputs: readonly DreamMemoryExtractionAgentRunInput[],
): Array<{ originWorkspace?: string; inputs: DreamMemoryExtractionAgentRunInput[] }> {
  const groups = new Map<string, { originWorkspace?: string; inputs: DreamMemoryExtractionAgentRunInput[] }>();
  for (const input of inputs) {
    const key = input.originWorkspace ?? '';
    let group = groups.get(key);
    if (!group) {
      group = { originWorkspace: input.originWorkspace, inputs: [] };
      groups.set(key, group);
    }
    group.inputs.push(input);
  }
  return [...groups.values()];
}

function buildOutlinerContextReminder(host: OutlinerToolHost): string | null {
  try {
    const projection = host.getProjection();
    const today = projection.nodes.find((node) => node.id === projection.todayId);
    return [
      '<outliner-context>',
      `Today node: %%node:${annotationReminderValue(projection.todayId)}%% ${escapeReminderText(outlineReminderText(today?.content.text, 'Today'))}`,
      '</outliner-context>',
    ].join('\n');
  } catch {
    return null;
  }
}

function normalizeAgentUserViewContext(input: unknown): AgentUserViewContext | null {
  if (!isRecord(input)) return null;
  const nodePanels = Array.isArray(input.nodePanels)
    ? input.nodePanels.slice(0, 6).map(normalizeUserViewPanel).filter((panel): panel is AgentUserViewPanel => Boolean(panel))
    : [];
  const referencedNodes = Array.isArray(input.referencedNodes)
    ? input.referencedNodes.slice(0, 20).map(normalizeUserViewNode).filter((node): node is AgentUserViewNode => Boolean(node))
    : [];

  return {
    activePanelId: nullableCompactString(input.activePanelId, 160),
    focusedPanelId: nullableCompactString(input.focusedPanelId, 160),
    focusSurface: nullableCompactString(input.focusSurface, 80),
    focusedNode: normalizeUserViewNode(input.focusedNode),
    nodePanels,
    ...(referencedNodes.length > 0 ? { referencedNodes } : {}),
  };
}

function normalizeUserViewPanel(input: unknown): AgentUserViewPanel | null {
  if (!isRecord(input)) return null;
  const panelId = compactString(input.panelId, 160);
  const rootNodeId = compactString(input.rootNodeId, 160);
  if (!panelId || !rootNodeId) return null;
  const rootType = compactString(input.rootType, 80);
  const visibleOutline = Array.isArray(input.visibleOutline)
    ? input.visibleOutline.slice(0, 100).map(normalizeUserViewOutlineNode).filter((node): node is AgentUserViewOutlineNode => Boolean(node))
    : [];
  return {
    panelId,
    rootNodeId,
    rootTitle: compactString(input.rootTitle, 160) || 'Untitled',
    ...(rootType ? { rootType: rootType as AgentUserViewPanel['rootType'] } : {}),
    active: input.active === true,
    focused: input.focused === true,
    order: finiteInteger(input.order, 0, 0, 100),
    childCount: finiteInteger(input.childCount, 0, 0, 100_000),
    breadcrumb: Array.isArray(input.breadcrumb)
      ? input.breadcrumb.slice(0, 6).map(normalizeUserViewNode).filter((node): node is AgentUserViewNode => Boolean(node))
      : [],
    visibleOutline,
    visibleOutlineTruncated: input.visibleOutlineTruncated === true,
  };
}

function normalizeUserViewNode(input: unknown): AgentUserViewNode | null {
  if (!isRecord(input)) return null;
  const nodeId = compactString(input.nodeId, 160);
  if (!nodeId) return null;
  return {
    nodeId,
    title: compactString(input.title, 160) || 'Untitled',
    panelId: nullableCompactString(input.panelId, 160),
    surface: nullableCompactString(input.surface, 80),
  };
}

function normalizeUserViewOutlineNode(input: unknown): AgentUserViewOutlineNode | null {
  if (!isRecord(input)) return null;
  const nodeId = compactString(input.nodeId, 160);
  if (!nodeId) return null;
  const partial = isRecord(input.partial)
    ? {
        included: finiteInteger(input.partial.included, 0, 0, 10_000),
        total: finiteInteger(input.partial.total, 0, 0, 10_000),
      }
    : null;
  return {
    nodeId,
    title: compactString(input.title, 240) || 'Untitled',
    depth: finiteInteger(input.depth, 0, 0, 20),
    ...(input.focused === true ? { focused: true } : {}),
    ...(input.collapsed === true ? { collapsed: true } : {}),
    ...(input.childCount !== undefined ? { childCount: finiteInteger(input.childCount, 0, 0, 100_000) } : {}),
    ...(partial && partial.total > 0 ? { partial } : {}),
  };
}

function formatLocalDateTime(date: Date): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'longOffset',
    }).format(date);
  } catch {
    return date.toString();
  }
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatUtcOffset(minutesEastOfUtc: number): string {
  const sign = minutesEastOfUtc >= 0 ? '+' : '-';
  const absolute = Math.abs(minutesEastOfUtc);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${minutes}`;
}

type AgentPathBackedAttachment = AgentFileAttachmentInput | (AgentImageAttachmentInput & { path: string });

function attachmentHasPath(attachment: AgentMessageAttachmentInput): attachment is AgentPathBackedAttachment {
  return (attachment.kind === 'file' || attachment.kind === 'image')
    && typeof (attachment as { path?: unknown }).path === 'string'
    && Boolean((attachment as { path?: string }).path);
}

function stringOrFallback(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function nullableCompactString(value: unknown, maxLength: number): string | null {
  const text = compactString(value, maxLength);
  return text || null;
}

function compactString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength).trim()}...`;
}

function finiteInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, numeric));
}

function outlineReminderText(value: unknown, fallback = ''): string {
  return compactString(value, 240) || fallback;
}

function annotationReminderValue(value: string): string {
  return value.replace(/\s+/g, '_').replace(/%/g, '');
}

function escapeReminderText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isUserMessage(message: unknown): message is UserMessage {
  return Boolean(message && typeof message === 'object' && (message as { role?: unknown }).role === 'user');
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return Boolean(message && typeof message === 'object' && (message as { role?: unknown }).role === 'assistant');
}

function isToolResultMessage(message: unknown): message is ToolResultMessage {
  return Boolean(message && typeof message === 'object' && (message as { role?: unknown }).role === 'toolResult');
}

function findRegenerateTarget(eventState: AgentEventReplayState, nodeId: string) {
  let regenerateTarget = nodeId;
  let cursor: string | null = nodeId;
  while (cursor) {
    const parentId: string | null = eventState.messages[cursor]?.parentMessageId ?? null;
    if (!parentId) break;
    const parent = eventState.messages[parentId];
    if (!parent) break;
    if (parent.role === 'assistant') {
      regenerateTarget = parentId;
      cursor = parentId;
      continue;
    }
    if (parent.role === 'toolResult') {
      cursor = parentId;
      continue;
    }
    break;
  }
  return regenerateTarget;
}

function requireEventMessage(eventState: AgentEventReplayState, messageId: string): AgentEventMessageRecord {
  const message = eventState.messages[messageId];
  if (!message) throw new Error(`Agent message not found: ${messageId}`);
  return message;
}

function findLatestEventLeaf(eventState: AgentEventReplayState, messageId: string): AgentEventMessageRecord {
  let cursor = requireEventMessage(eventState, messageId);
  const visited = new Set<string>();
  while (!visited.has(cursor.id)) {
    visited.add(cursor.id);
    const nextId = eventState.childrenByParentId[cursor.id]?.at(-1);
    if (!nextId) break;
    cursor = requireEventMessage(eventState, nextId);
  }
  return cursor;
}

function findLatestAssistantMessageId(eventState: AgentEventReplayState): string | null {
  return [...getAgentEventActivePath(eventState)].reverse().find((message) => message.role === 'assistant')?.id ?? null;
}

function eventStateToMeta(eventState: AgentEventReplayState): AgentConversationListMeta | null {
  if (!eventState.conversation) return null;
  return {
    id: eventState.conversation.id,
    title: sanitizeConversationTitle(eventState.conversation.title),
    members: eventState.conversation.members.slice(),
    goal: eventState.conversation.goal,
    createdAt: eventState.conversation.createdAt,
    updatedAt: eventState.conversation.updatedAt,
    messageCount: Object.keys(eventState.messages).length,
  };
}

function agentMemoryEntryToView(entry: AgentMemoryEntry): AgentMemoryEntryView {
  return {
    id: entry.id,
    principal: entry.principal,
    fact: entry.fact,
    originWorkspace: entry.originWorkspace,
    sources: entry.sources.map((source) => ({
      conversationId: source.conversationId,
      kind: source.kind,
      summaryId: source.summaryId,
      messageRange: source.messageRange,
      runId: source.runId,
      subagentRunId: source.subagentRunId,
      agentId: source.agentId,
      parentToolCallId: source.parentToolCallId,
      eventId: source.eventId,
    })),
    status: entry.status,
    createdAt: entry.createdAt,
  };
}

function fromPiAssistantContent(content: AssistantMessage['content']): AgentPersistedContent[] {
  return content.map((part): AgentPersistedContent => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'thinking') return { type: 'thinking', thinking: part.thinking, redacted: part.redacted };
    return {
      type: 'toolCall',
      id: part.id,
      name: part.name,
      arguments: part.arguments,
    };
  });
}

function textPersistedContent(text: string): AgentPersistedContent[] {
  return [{ type: 'text', text }];
}

function isDuplicateTailUserMessage(eventState: AgentEventReplayState, message: UserMessage): boolean {
  const tail = getAgentEventActivePath(eventState).at(-1);
  return tail?.role === 'user'
    && tail.createdAt === message.timestamp
    && persistedText(tail.content) === piUserText(message.content);
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is PiTextContent => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function persistedText(content: AgentPersistedContent[]): string {
  return content
    .filter((part): part is Extract<AgentPersistedContent, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function piUserText(content: UserMessage['content'] | ToolResultMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is PiTextContent => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function persistedContentText(content: AgentPersistedContent): string {
  if (content.type === 'text') return content.text;
  if (content.type === 'thinking') return content.thinking;
  if (content.type === 'toolCall') return `[tool:${content.name}]`;
  if (content.type === 'image') return content.alt || content.imageRef.summary || `[image:${content.imageRef.id}]`;
  return content.label || content.payload.summary || `[payload:${content.payload.id}]`;
}

function deriveTitleFromPersistedContent(content: AgentPersistedContent[]): string | null {
  const text = [...content]
    .reverse()
    .find((part): part is Extract<AgentPersistedContent, { type: 'text' }> => part.type === 'text' && !part.text.includes('<system-reminder>'))
    ?.text ?? persistedText(content);
  const normalized = sanitizeConversationTitle(text);
  return normalized ? normalized.slice(0, 30) : null;
}

function sanitizeConversationTitle(title: string | null | undefined): string | null {
  const normalized = nodeReferenceMarkersToText(title ?? '').replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function normalizeConversationTitle(title: string): string {
  return sanitizeConversationTitle(title) ?? 'Untitled';
}

function summarizeToolResult(message: ToolResultMessage): string {
  const text = piUserText(message.content).replace(/\s+/g, ' ').trim();
  if (text) return text.length > 500 ? `${text.slice(0, 500).trim()}...` : text;
  return summarizeJson(message.content);
}

function isTextPayloadMimeType(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase();
  return normalized.startsWith('text/') || normalized === 'application/json';
}

function isTextPayloadRole(role: AgentPayloadRef['role']): boolean {
  return role === 'tool_output'
    || role === 'text_extract'
    || role === 'preview'
    || role === 'subagent_transcript';
}

function summarizeJson(value: unknown): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 500 ? `${text.slice(0, 500)}...` : text;
  } catch {
    return String(value);
  }
}

function skillAuditEventFromToolResult(
  toolName: string,
  toolCallId: string,
  result: unknown,
): AgentEventInput | null {
  if (toolName !== 'file_write' && toolName !== 'file_edit') return null;
  const details = isRecord(result) && Object.hasOwn(result, 'details') ? result.details : result;
  if (!isToolEnvelope(details) || !details.ok || details.tool !== toolName || !isRecord(details.data)) return null;
  const skillWrite = parseAgentSkillWriteAudit(details.data.skillWrite);
  if (!skillWrite) return null;
  return {
    type: skillAuditEventType(skillWrite.changeType),
    actor: toolActor(toolName, toolCallId),
    skillId: skillWrite.skillName,
    source: skillWrite.source,
    summary: `${skillWrite.changeType} ${skillWrite.relativePath} (${skillWrite.previousHash ?? 'new'} -> ${skillWrite.nextHash})`,
  };
}

function skillAuditEventType(
  changeType: AgentSkillWriteAudit['changeType'],
): 'skill.created' | 'skill.patched' | 'skill.replaced' {
  switch (changeType) {
    case 'create':
      return 'skill.created';
    case 'replace':
      return 'skill.replaced';
    case 'patch':
    case 'support-file-write':
      return 'skill.patched';
    default: {
      const _exhaustive: never = changeType;
      return _exhaustive;
    }
  }
}

function parseAgentSkillWriteAudit(value: unknown): AgentSkillWriteAudit | null {
  if (!isRecord(value)) return null;
  if (typeof value.skillName !== 'string') return null;
  if (value.source !== 'user' && value.source !== 'project' && value.source !== 'built-in') return null;
  if (typeof value.skillRoot !== 'string') return null;
  if (typeof value.relativePath !== 'string') return null;
  if (
    value.changeType !== 'create'
    && value.changeType !== 'patch'
    && value.changeType !== 'replace'
    && value.changeType !== 'support-file-write'
  ) {
    return null;
  }
  if (value.previousHash !== undefined && typeof value.previousHash !== 'string') return null;
  if (typeof value.nextHash !== 'string') return null;
  if (typeof value.previousBytes !== 'number' || typeof value.nextBytes !== 'number') return null;
  return {
    skillName: value.skillName,
    source: value.source,
    skillRoot: value.skillRoot,
    relativePath: value.relativePath,
    changeType: value.changeType,
    previousHash: value.previousHash,
    nextHash: value.nextHash,
    previousBytes: value.previousBytes,
    nextBytes: value.nextBytes,
    warnings: Array.isArray(value.warnings)
      ? value.warnings.filter((warning): warning is string => typeof warning === 'string')
      : [],
  };
}

function normalizeAskUserQuestionResult(
  requestId: string,
  request: AgentUserQuestionRequestView,
  input: unknown,
): AskUserQuestionResult {
  const inputAnswers = isRecord(input) && Array.isArray(input.answers) ? input.answers : [];
  const answersByQuestionId = new Map<string, unknown>();
  for (const answer of inputAnswers) {
    if (!isRecord(answer) || typeof answer.questionId !== 'string') continue;
    answersByQuestionId.set(answer.questionId, answer);
  }

  const answers: AgentUserQuestionAnswer[] = [];
  for (const question of request.questions) {
    const raw = answersByQuestionId.get(question.id);
    if (!isRecord(raw)) continue;
    const answer: AgentUserQuestionAnswer = { questionId: question.id };
    if (question.type === 'single_choice' || question.type === 'multi_choice') {
      const allowed = new Set((question.options ?? []).map((option) => option.id));
      const selected = Array.isArray(raw.selectedOptionIds)
        ? raw.selectedOptionIds.filter((id): id is string => typeof id === 'string' && allowed.has(id))
        : [];
      answer.selectedOptionIds = question.type === 'single_choice' ? selected.slice(0, 1) : selected;
    }
    const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, 4000) : '';
    const notes = typeof raw.notes === 'string' ? raw.notes.trim().slice(0, 4000) : '';
    if (text) answer.text = text;
    if (notes) answer.notes = notes;
    answers.push(answer);
  }

  return { requestId, answers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clearPendingProjection(conversation: AgentConversationState) {
  if (!conversation.pendingProjectionTimer) return;
  clearTimeout(conversation.pendingProjectionTimer);
  conversation.pendingProjectionTimer = null;
  conversation.pendingProjectionLastEventType = null;
}

function sumRunUsage(state: AgentEventReplayState, runId: string): Usage | undefined {
  const messages = Object.values(state.messages)
    .filter((message) => message.role === 'assistant' && message.runId === runId && message.usage);
  if (messages.length === 0) return undefined;
  return messages.reduce((total, message) => addUsage(total, message.usage ?? EMPTY_USAGE), EMPTY_USAGE);
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

function createDefaultAgentIdentity(): AgentIdentityRecord {
  return {
    agentId: 'built-in:tenon:assistant',
    displayName: 'Tenon Assistant',
    model: 'unknown',
    systemPrompt: LIN_AGENT_SYSTEM_PROMPT,
    skills: [],
  };
}

function electronAppVersion(): string {
  return typeof app.getVersion === 'function' ? app.getVersion() : 'dev';
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Cap on inlined profile-skill bodies in a Channel peer's system prompt. */
const CHANNEL_PEER_SKILL_PROMPT_BUDGET = 24_000;

/**
 * A Channel member speaks in the shared thread as itself — this is NOT the
 * subagent prompt (a peer is a conversation participant, not a headless worker
 * reporting to a parent).
 */
function agentDefinitionDisplayName(definition: AgentDefinition): string {
  return definition.displayName?.trim() || definition.name;
}

function buildChannelPeerSystemPrompt(
  definition: AgentDefinition,
  mention: string,
  skillSections: readonly string[],
): string {
  const displayName = agentDefinitionDisplayName(definition);
  return [
    [
      `You are "${displayName}" (@${mention}), an agent member of a shared multi-agent conversation (a Channel) with the user and other members.`,
      `Agent description: ${definition.description}`,
      '',
      '# Channel rules',
      '- Speak as yourself. Your reply is posted to the shared thread under your name.',
      '- Other members\' turns appear as quoted context with an identity preamble; never imitate another member or speak on their behalf.',
      '- To hand off to another agent member, mention them as @<name> in your reply — only when they are clearly better suited. Every mention routes a turn and there is no relay limit, so mention deliberately and do not create mention loops; the user can stop the round at any time.',
      '- Stay within your description and instructions; defer outside work to better-suited members.',
    ].join('\n'),
    definition.body.trim() ? `# Agent instructions\n${definition.body.trim()}` : null,
    skillSections.length > 0 ? `# Profile skills\n${skillSections.join('\n\n')}` : null,
  ].filter(Boolean).join('\n\n');
}

/** Final visible text of the run's last assistant message (hand-off mention source). */
function latestAssistantTextForRun(eventState: AgentEventReplayState, runId: string): string {
  const record = latestAssistantRecordForRun(eventState, runId);
  return record ? persistedTextContent(record.content) : '';
}

/** Id of the run's last assistant message — the addressing boundary for its hand-off targets. */
function latestAssistantMessageIdForRun(eventState: AgentEventReplayState, runId: string): string | null {
  return latestAssistantRecordForRun(eventState, runId)?.id ?? null;
}

function latestAssistantRecordForRun(eventState: AgentEventReplayState, runId: string): AgentEventMessageRecord | null {
  const path = getAgentEventActivePath(eventState);
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const record = path[index]!;
    if (record.role !== 'assistant' || record.runId !== runId) continue;
    return record;
  }
  return null;
}

/** Visible text of a live pi assistant message (the hand-off mention source at completion time). */
function assistantVisibleText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function persistedTextContent(content: readonly AgentPersistedContent[]): string {
  return content
    .filter((part): part is Extract<AgentPersistedContent, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function systemActor(): AgentActor {
  return { type: 'system' };
}

function userActor(): AgentActor {
  return { type: 'user', userId: LOCAL_USER_ID };
}

function toolActor(toolName: string, toolCallId: string): AgentActor {
  return { type: 'tool', toolName, toolCallId };
}

function canContinueFromMessage(message: AgentMessage | undefined): boolean {
  return message?.role === 'user' || message?.role === 'toolResult';
}

function createProviderConfiguredStreamFn(
  sourceFn: StreamFn,
  runtimeSettingsLoader?: () => Promise<AgentRuntimeSettings>,
): StreamFn {
  return createAbortSettledStreamFn(async (model, context, options = {}) => {
    const runtimeSettings = await loadRuntimeSettingsForStream(runtimeSettingsLoader);
    return sourceFn(model, context, {
      ...options,
      ...providerStreamOptionsFromRuntimeSettings(runtimeSettings),
    } satisfies SimpleStreamOptions);
  });
}

async function loadRuntimeSettingsForStream(
  runtimeSettingsLoader?: () => Promise<AgentRuntimeSettings>,
): Promise<AgentRuntimeSettings | undefined> {
  try {
    return await runtimeSettingsLoader?.();
  } catch {
    return undefined;
  }
}

async function continueFromActivePath(agent: Agent) {
  if (!canContinueFromMessage(agent.state.messages.at(-1) as AgentMessage | undefined)) {
    throw new Error('Cannot continue without a trailing user or tool result message.');
  }
  await agent.continue();
}

function approvalDeniedToolResultMessage(toolName: string, approval: AgentToolApprovalResolution): string {
  const reason = approval.deniedReason ?? 'runtime';
  return permissionDeniedToolResultMessage({
    toolName,
    reason,
    message: approvalDeniedMessage(reason),
  });
}

function approvalDeniedMessage(reason: PermissionDeniedReason): string {
  switch (reason) {
    case 'user_denied':
      return 'User denied permission. The requested tool call was not executed.';
    case 'run_aborted':
      return 'Permission request was cancelled before approval. The requested tool call was not executed.';
    case 'configured_deny':
    case 'policy_denied':
    case 'classifier_blocked':
    case 'classifier_unavailable':
    case 'platform_hard_block':
    case 'runtime':
      return 'Permission request was not approved. The requested tool call was not executed.';
  }
}

function createConfiguredAgent(
  conversationId: string,
  providerConfig: AgentProviderRuntimeConfig,
  messages: AgentMessage[] = [],
  outlinerToolHost: OutlinerToolHost,
  options: {
    localFileRoot?: string;
    model?: Model<Api>;
    thinkingLevel?: AgentReasoningLevel;
    systemPrompt?: string;
    permissionMode?: AgentPermissionMode;
    providerApiKeyLoader?: (providerId: string) => Promise<string | undefined> | string | undefined;
    runtimeSettingsLoader?: () => Promise<AgentRuntimeSettings>;
    skillToolEnabled?: boolean;
    skillRuntime?: AgentSkillRuntime;
    subagentRuntime?: AgentSubagentRuntime;
    recall?: AgentToolsOptions['recall'];
    askUserQuestion?: AgentToolsOptions['askUserQuestion'];
    selfMaintenance?: AgentToolsOptions['selfMaintenance'];
    localWorkspace?: AgentLocalWorkspaceContext;
    allowedTools?: string[];
    disallowedTools?: string[];
    preapprovedToolRules?: string[];
    approvalHandler?: (input: AgentToolApprovalInput, signal?: AbortSignal) => Promise<AgentToolApprovalResolution>;
    streamFn?: StreamFn;
    completeSimpleFn?: CompleteSimpleFn;
    permissionClassifier?: AgentPermissionClassifier;
    permissionEventHandler?: (input: AgentToolPermissionLogInput) => Promise<void> | void;
    afterToolResult?: (
      toolCallId: string,
      toolName: string,
      result: unknown,
      isError: boolean,
    ) => Promise<AfterToolCallResult | undefined> | AfterToolCallResult | undefined;
  } = {},
  onPayload?: (payload: unknown, model: Model<any>) => unknown | undefined | Promise<unknown | undefined>,
  onResponse?: (response: ProviderResponse, model: Model<any>) => void | Promise<void>,
) {
  const model = options.model ?? resolveModel(providerConfig);
  const localFileRoot = options.localFileRoot;
  const skillRuntime = options.skillRuntime;
  let activeLoopModel = model;
  let activeThinkingLevel = options.thinkingLevel ?? providerConfig.reasoningLevel;
  const permissionClassifier = options.permissionClassifier ?? createDefaultPermissionClassifier({
    conversationId,
    model: () => activeLoopModel,
    providerConfig,
    providerApiKeyLoader: options.providerApiKeyLoader,
    runtimeSettingsLoader: options.runtimeSettingsLoader,
    completeSimpleFn: options.completeSimpleFn,
  });
  let agent: Agent;
  agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt ?? LIN_AGENT_SYSTEM_PROMPT,
      model,
      thinkingLevel: activeThinkingLevel,
      tools: createAgentTools(outlinerToolHost, {
        localFileRoot,
        localWorkspace: options.localWorkspace,
        skillRuntime,
        skillToolEnabled: options.skillToolEnabled,
        subagentRuntime: options.subagentRuntime,
        recall: options.recall,
        askUserQuestion: options.askUserQuestion,
        selfMaintenance: options.selfMaintenance,
        allowedTools: options.allowedTools,
        disallowedTools: options.disallowedTools,
      }),
      messages,
    },
    streamFn: createProviderConfiguredStreamFn(options.streamFn ?? streamSimple as StreamFn, options.runtimeSettingsLoader),
    onPayload: async (payload, payloadModel) => onPayload?.(payload, payloadModel),
    onResponse: async (response, responseModel) => onResponse?.(response, responseModel),
    getApiKey: async (provider) => {
      if (provider === providerConfig.providerId) {
        return providerConfig.apiKey ?? options.providerApiKeyLoader?.(provider) ?? getProviderApiKey(provider);
      }
      return options.providerApiKeyLoader?.(provider) ?? getProviderApiKey(provider);
    },
    beforeToolCall: async ({ toolCall, args }, signal) => {
      const runtimeSettings = await options.runtimeSettingsLoader?.();
      const globalPermissions = await readAgentToolPermissionConfig();
      const decision = evaluateAgentToolPermission({
        toolName: toolCall.name,
        args,
        policy: {
          mode: options.permissionMode ?? runtimeSettings?.permissionMode,
          workspaceRoot: localFileRoot,
          globalPermissions,
          preapprovedToolRules: [
            ...(skillRuntime?.getActivePermissionRules() ?? []),
            ...(options.preapprovedToolRules ?? []),
          ],
          ...(skillRuntime?.getSkillDirConfig() ?? {}),
        },
      });
      const permissionRequestId = `permission-${randomUUID()}`;
      if (decision.behavior === 'allow') {
        await options.permissionEventHandler?.({
          requestId: permissionRequestId,
          toolCall,
          decision,
          outcome: 'allow',
          resolved: {
            status: 'approved',
            resolvedBy: permissionResolvedByForAllowDecision(decision),
          },
        });
        return undefined;
      }
      if (decision.behavior === 'ask') {
        await options.permissionEventHandler?.({
          requestId: permissionRequestId,
          toolCall,
          decision,
          outcome: 'ask',
        });
        const classifierProjection = toPermissionClassifierInput(toolCall.name, args);
        const askResolution = await resolveAgentPermissionAsk({
          decision,
          classifier: permissionClassifier,
          classifierProjection,
          classifierContextRecords: classifierProjection
            ? buildPermissionClassifierContextRecords(agent.state.messages as AgentMessage[], classifierProjection)
            : undefined,
          interactionAvailable: Boolean(options.approvalHandler),
          signal,
        });
        if (askResolution.outcome === 'allow') {
          await options.permissionEventHandler?.({
            requestId: permissionRequestId,
            toolCall,
            decision,
            outcome: 'allow',
            includeChecked: false,
            source: askResolution.source,
            resolved: {
              status: 'approved',
              resolvedBy: askResolution.source,
            },
          });
          return undefined;
        }
        if (askResolution.outcome === 'block') {
          await options.permissionEventHandler?.({
            requestId: permissionRequestId,
            toolCall,
            decision,
            outcome: 'blocked',
            includeChecked: false,
            source: permissionEventSourceForDeniedReason(askResolution.reason),
            resolved: {
              status: permissionResolutionStatusForDeniedReason(askResolution.reason),
              resolvedBy: permissionResolvedByForDeniedReason(askResolution.reason),
              deniedReason: askResolution.reason,
            },
          });
          return {
            block: true,
            reason: permissionDeniedToolResultMessage({
              toolName: toolCall.name,
              reason: askResolution.reason,
              message: askResolution.message,
            }),
          };
        }
        if (options.approvalHandler) {
          const approval = await options.approvalHandler({
            requestId: permissionRequestId,
            toolCall,
            args,
            decision,
          }, signal);
          const deniedReason = approval.deniedReason ?? 'runtime';
          await options.permissionEventHandler?.({
            requestId: permissionRequestId,
            toolCall,
            decision,
            outcome: approval.approved ? 'allow' : 'blocked',
            includeChecked: false,
            source: approval.approved ? 'user' : permissionEventSourceForDeniedReason(deniedReason),
            resolved: {
              status: approval.approved ? 'approved' : permissionResolutionStatusForDeniedReason(deniedReason),
              resolvedBy: approval.approved
                ? approval.scope === 'always' ? 'allow_rule_update' : 'user_once'
                : permissionResolvedByForDeniedReason(deniedReason),
              updatedRule: approval.alwaysAllowRule,
              deniedReason: approval.approved ? undefined : deniedReason,
            },
          });
          if (approval.approved) return undefined;
          return { block: true, reason: approvalDeniedToolResultMessage(toolCall.name, approval) };
        }
        await options.permissionEventHandler?.({
          requestId: permissionRequestId,
          toolCall,
          decision,
          outcome: 'blocked',
          includeChecked: false,
          source: 'runtime',
          resolved: {
            status: 'denied',
            resolvedBy: 'runtime',
            deniedReason: 'runtime',
          },
        });
        return {
          block: true,
          reason: permissionDeniedToolResultMessage({
            toolName: toolCall.name,
            reason: 'runtime',
            message: 'Permission requires user approval, but no approval channel is available.',
          }),
        };
      }
      await options.permissionEventHandler?.({
        requestId: permissionRequestId,
        toolCall,
        decision,
        outcome: 'blocked',
        source: permissionEventSourceForDecision(decision),
        resolved: {
          status: 'denied',
          resolvedBy: permissionResolvedByForDeniedReason(permissionDeniedReasonForDecision(decision)),
          deniedReason: permissionDeniedReasonForDecision(decision),
        },
      });
      return {
        block: true,
        reason: permissionDeniedToolResultMessage({
          toolName: toolCall.name,
          reason: permissionDeniedReasonForDecision(decision),
          message: decision.reason,
        }),
      };
    },
    afterToolCall: async ({ toolCall, result, isError }) => {
      if (skillRuntime) {
        for (const message of skillRuntime.drainSteeringMessages()) {
          agent.steer(message);
        }
      }
      const envelopeUpdate = toolEnvelopeAfterToolCall(result.details, isError);
      const slimmedUpdate = await options.afterToolResult?.(toolCall.id, toolCall.name, result, envelopeUpdate?.isError ?? isError);
      if (!envelopeUpdate) return slimmedUpdate;
      if (!slimmedUpdate) return envelopeUpdate;
      return {
        ...envelopeUpdate,
        ...slimmedUpdate,
        content: slimmedUpdate.content ?? envelopeUpdate.content,
        details: slimmedUpdate.details ?? envelopeUpdate.details,
        isError: slimmedUpdate.isError ?? envelopeUpdate.isError,
        terminate: slimmedUpdate.terminate ?? envelopeUpdate.terminate,
      };
    },
    steeringMode: 'all',
    prepareNextTurn: skillRuntime
      ? async () => {
          const update = resolveSkillTurnUpdate(
            skillRuntime.consumePendingTurnEffect(),
            providerConfig,
            activeLoopModel,
            activeThinkingLevel,
          );
          if (update?.model) activeLoopModel = update.model as Model<Api>;
          if (update?.thinkingLevel !== undefined) activeThinkingLevel = update.thinkingLevel as AgentReasoningLevel;
          return update;
        }
      : undefined,
    // pi-agent-core AgentOptions field (provider cache affinity) — the lib's own name.
    sessionId: conversationId,
  });
  agent.subscribe((event) => {
    if (event.type !== 'agent_start') return;
    activeLoopModel = agent.state.model as Model<Api>;
    activeThinkingLevel = agent.state.thinkingLevel as AgentReasoningLevel;
  });
  return agent;
}

const AGENT_REASONING_LEVELS = new Set<AgentReasoningLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

function resolveSkillTurnUpdate(
  effect: SkillTurnEffect | null,
  providerConfig: AgentProviderRuntimeConfig,
  currentModel: Model<Api>,
  currentThinkingLevel: AgentReasoningLevel,
): AgentLoopTurnUpdate | undefined {
  if (!effect) return undefined;

  const nextModel = effect.model
    ? resolveSkillModelOverride(effect.model, providerConfig, currentModel)
    : currentModel;
  const nextThinkingLevel = effect.effort
    ? resolveSkillEffortOverride(effect.effort, nextModel, currentThinkingLevel)
    : currentThinkingLevel;

  const update: AgentLoopTurnUpdate = {};
  if (nextModel !== currentModel) update.model = nextModel;
  if (nextThinkingLevel !== currentThinkingLevel) update.thinkingLevel = nextThinkingLevel;
  return update.model || update.thinkingLevel !== undefined ? update : undefined;
}

function resolveSkillModelOverride(
  modelInput: string,
  providerConfig: AgentProviderRuntimeConfig,
  currentModel: Model<Api>,
): Model<Api> {
  const requested = modelInput.trim();
  if (!requested || requested === 'inherit' || requested === currentModel.id) return currentModel;

  const parsed = parseProviderQualifiedModel(requested);
  const providerId = parsed?.providerId ?? providerConfig.providerId;
  const modelId = parsed?.modelId ?? requested;
  const knownModel = findKnownModel(providerId, modelId);
  if (knownModel) {
    return providerId === providerConfig.providerId && providerConfig.baseUrl
      ? { ...knownModel, baseUrl: providerConfig.baseUrl }
      : knownModel;
  }

  if (providerId === providerConfig.providerId && providerConfig.baseUrl) {
    return createOpenAICompatibleModel({ ...providerConfig, modelId });
  }

  return currentModel;
}

function parseProviderQualifiedModel(value: string): { providerId: string; modelId: string } | null {
  const separator = value.includes('/') ? '/' : value.includes(':') ? ':' : null;
  if (!separator) return null;
  const [providerId, ...rest] = value.split(separator);
  const modelId = rest.join(separator);
  if (!providerId?.trim() || !modelId.trim()) return null;
  return { providerId: providerId.trim(), modelId: modelId.trim() };
}

function resolveSkillEffortOverride(
  effortInput: string,
  model: Model<Api>,
  currentThinkingLevel: AgentReasoningLevel,
): AgentReasoningLevel {
  const requested = effortInput.trim().toLowerCase();
  if (!AGENT_REASONING_LEVELS.has(requested as AgentReasoningLevel)) return currentThinkingLevel;
  const level = requested as AgentReasoningLevel;
  const supported = getSupportedThinkingLevels(model).filter((item): item is AgentReasoningLevel => (
    AGENT_REASONING_LEVELS.has(item as AgentReasoningLevel)
  ));
  if (supported.includes(level)) return level;
  if (supported.includes('off')) return 'off';
  return supported[0] ?? currentThinkingLevel;
}

const NOTIFICATION_BODY_MAX_LENGTH = 280;

function truncateNotificationBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= NOTIFICATION_BODY_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, NOTIFICATION_BODY_MAX_LENGTH - 1).trimEnd()}…`;
}

function subagentNotificationKind(
  // 'stopped' is gated out before this (a user-initiated stop raises no
  // notification — see notifySubagentRun), so only failed/completed reach here.
  status: 'failed' | 'completed',
): AgentNotificationKind {
  return status === 'failed' ? 'task_failed' : 'task_completed';
}

function subagentNotificationTitle(snapshot: AgentSubagentRunSnapshot): string {
  if (snapshot.status === 'failed') return `Subagent "${snapshot.description}" failed.`;
  if (snapshot.status === 'stopped') return `Subagent "${snapshot.description}" was stopped.`;
  return `Subagent "${snapshot.description}" completed.`;
}

function formatSubagentNotification(snapshot: AgentSubagentRunSnapshot): string {
  const summary = subagentNotificationTitle(snapshot);
  return [
    '<subagent-notification>',
    `<agent_id>${escapeXml(snapshot.id)}</agent_id>`,
    snapshot.name ? `<name>${escapeXml(snapshot.name)}</name>` : null,
    `<description>${escapeXml(snapshot.description)}</description>`,
    `<subagent_type>${escapeXml(snapshot.subagentType)}</subagent_type>`,
    `<context_mode>${escapeXml(snapshot.contextMode)}</context_mode>`,
    `<status>${escapeXml(snapshot.status)}</status>`,
    `<summary>${escapeXml(summary)}</summary>`,
    `<transcript_message_count>${snapshot.transcriptMessages.length}</transcript_message_count>`,
    snapshot.result ? `<result>${escapeXml(snapshot.result)}</result>` : null,
    snapshot.error ? `<error>${escapeXml(snapshot.error)}</error>` : null,
    '</subagent-notification>',
  ].filter((line): line is string => line !== null).join('\n');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function createConfigurationErrorAgent(conversationId: string, message: string, messages: AgentMessage[] = []) {
  return new Agent({
    initialState: {
      systemPrompt: LIN_AGENT_SYSTEM_PROMPT,
      model: CONFIGURATION_ERROR_MODEL,
      thinkingLevel: 'off',
      tools: [],
      messages,
    },
    streamFn: createConfigurationErrorStreamFn(message),
    // pi-agent-core AgentOptions field — the lib's own name.
    sessionId: conversationId,
  });
}

function resolveModel(config: AgentProviderRuntimeConfig): Model<Api> {
  const knownModel = findKnownModel(config.providerId, config.modelId);
  if (knownModel) {
    return config.baseUrl ? { ...knownModel, baseUrl: config.baseUrl } : knownModel;
  }
  if (config.baseUrl) {
    return createOpenAICompatibleModel(config);
  }
  throw new Error(`model not found for provider ${config.providerId}: ${config.modelId}`);
}

function findKnownModel(providerId: string, modelId: string): Model<Api> | null {
  try {
    return getModels(providerId as KnownProvider).find((model) => model.id === modelId) as Model<Api> | undefined ?? null;
  } catch {
    return null;
  }
}

function createOpenAICompatibleModel(config: AgentProviderRuntimeConfig): Model<'openai-completions'> {
  return {
    id: config.modelId,
    name: config.modelId,
    api: 'openai-completions',
    provider: config.providerId,
    baseUrl: config.baseUrl ?? '',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

function createConfigurationErrorStreamFn(messageText: string): StreamFn {
  return (model) => {
    const stream = createAssistantMessageEventStream();

    void (async () => {
      const message = createAssistantBase(model as Model<Api>);
      stream.push({ type: 'start', partial: clone(message) });
      const failure: AssistantMessage = {
        ...message,
        stopReason: 'error',
        errorMessage: messageText,
      };
      stream.push({ type: 'error', reason: 'error', error: clone(failure) });
      stream.end(clone(failure));
    })();

    return stream;
  };
}

function parseDreamSlashCommand(message: string): boolean {
  return /^\/dream\s*$/i.test(message.trim());
}

function dreamTaskFromRunMeta(
  run: AgentRunMetaProjection,
  completed: Extract<AgentMemoryEvent, { type: 'dream.completed' }> | null,
): AgentRenderDreamTaskEntity | null {
  if (run.anchor.type !== 'principal' || run.kind !== 'reflective') return null;
  const trigger = dreamTaskTrigger(run);
  if (!trigger) return null;
  const status = renderTaskStatusFromRunStatus(run.status);
  return {
    id: `dream:${run.id}`,
    kind: 'dream',
    status,
    trigger,
    principal: run.anchor.principal,
    startedAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: status === 'running' ? undefined : run.updatedAt,
    runId: run.id,
    processed: completed?.processed,
    changes: completed?.changes,
  };
}

function dreamTaskTrigger(run: Pick<AgentRunMeta, 'trigger'>): AgentRenderDreamTaskEntity['trigger'] | null {
  if (run.trigger.type === 'schedule') return 'schedule';
  if (run.trigger.type === 'manual') return 'manual';
  return null;
}

function renderTaskStatusFromRunStatus(status: AgentRunMeta['status']): AgentRenderTaskStatus {
  return status === 'cancelled' ? 'stopped' : status;
}

function compareRenderTasks(left: AgentRenderTaskEntity, right: AgentRenderTaskEntity): number {
  return taskStatusRank(left.status) - taskStatusRank(right.status)
    || right.updatedAt - left.updatedAt
    || left.id.localeCompare(right.id);
}

function taskStatusRank(status: AgentRenderTaskStatus): number {
  if (status === 'running') return 0;
  if (status === 'failed') return 1;
  if (status === 'stopped') return 2;
  return 3;
}

function dreamWatermarkFromSpan(
  previous: AgentDreamWatermark,
  ranges: readonly DreamMemoryExtractionSourceRange[],
): AgentDreamWatermark {
  const conversations = { ...previous.conversations };
  const agentRuns = { ...(previous.agentRuns ?? {}) };
  for (const range of ranges) {
    if (range.source.kind === 'agent_run') {
      const runId = range.source.subagentRunId ?? range.source.runId;
      if (!runId) continue;
      const current = agentRuns[runId];
      if (current?.payloadId === range.throughEventId && current.messageCount > range.throughSeq) continue;
      agentRuns[runId] = {
        messageCount: range.throughSeq,
        payloadId: range.throughEventId,
      };
      continue;
    }
    const conversationId = range.source.conversationId;
    const current = conversations[conversationId];
    if (current && current.seq > range.throughSeq) continue;
    conversations[conversationId] = {
      seq: range.throughSeq,
      eventId: range.throughEventId,
    };
  }
  return { conversations, agentRuns };
}

function dreamProcessedConversations(
  ranges: readonly DreamMemoryExtractionSourceRange[],
): Record<string, {
  fromSeqExclusive: number;
  throughSeq: number;
  throughEventId: string | null;
  messageCount: number;
  charCount: number;
}> {
  return Object.fromEntries(ranges.filter((range) => range.source.kind !== 'agent_run').map((range) => [range.source.conversationId, {
    fromSeqExclusive: range.fromSeqExclusive,
    throughSeq: range.throughSeq,
    throughEventId: range.throughEventId,
    messageCount: range.messageCount,
    charCount: range.charCount,
  }]));
}

function dreamProcessedAgentRuns(
  ranges: readonly DreamMemoryExtractionSourceRange[],
): Record<string, {
  parentConversationId: string;
  parentToolCallId?: string;
  fromMessageCountExclusive: number;
  throughMessageCount: number;
  transcriptPayloadId: string | null;
  messageCount: number;
  charCount: number;
}> {
  return Object.fromEntries(ranges.flatMap((range) => {
    if (range.source.kind !== 'agent_run') return [];
    const runId = range.source.subagentRunId ?? range.source.runId;
    if (!runId) return [];
    return [[runId, {
      parentConversationId: range.source.conversationId,
      parentToolCallId: range.source.parentToolCallId,
      fromMessageCountExclusive: range.fromSeqExclusive,
      throughMessageCount: range.throughSeq,
      transcriptPayloadId: range.throughEventId,
      messageCount: range.messageCount,
      charCount: range.charCount,
    }]];
  }));
}

function clampRecallLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(200, Math.trunc(limit)));
}

/**
 * Round-robin merge of the reader's own pool and a shared (user) pool into a single budget,
 * own-first within each round. A plain `own.concat(shared).slice(limit)` would let a reader with
 * a full self-model starve the shared zone to nothing (review #2/#3); interleaving guarantees the
 * shared pool a fair share of whatever budget remains. Each input is already newest-active-first;
 * the merge preserves that within each source. De-duplicates by entry id (an entry can only belong
 * to one pool today, but the guard keeps the merge total honest if that ever changes).
 */
function interleaveMemoryEntries(
  own: readonly AgentMemoryEntry[],
  shared: readonly AgentMemoryEntry[],
  limit: number,
): AgentMemoryEntry[] {
  const merged: AgentMemoryEntry[] = [];
  const seen = new Set<string>();
  const push = (entry: AgentMemoryEntry | undefined): void => {
    if (!entry || seen.has(entry.id) || merged.length >= limit) return;
    seen.add(entry.id);
    merged.push(entry);
  };
  const rounds = Math.max(own.length, shared.length);
  for (let i = 0; i < rounds && merged.length < limit; i += 1) {
    push(own[i]);
    push(shared[i]);
  }
  return merged;
}

function emptyDreamChanges(): AgentDreamCompletedChanges {
  return { added: 0, updated: 0, forgotten: 0, skipped: 0 };
}

function addDreamChanges(target: AgentDreamCompletedChanges, next: AgentDreamCompletedChanges): AgentDreamCompletedChanges {
  target.added += next.added;
  target.updated += next.updated;
  target.forgotten += next.forgotten;
  target.skipped += next.skipped;
  return target;
}

function skippedDreamRunResult(
  agentId: string,
  trigger: AgentDreamTrigger,
  startedAt: Date,
  errorMessage: string,
): AgentDreamRunResult {
  return {
    agentId,
    trigger,
    status: 'skipped',
    startedAt: startedAt.getTime(),
    completedAt: Date.now(),
    errorMessage,
  };
}

function dreamToolDataFromRunResult(result: AgentDreamRunResult): DreamToolData {
  return {
    status: result.status,
    runId: result.runId,
    processed: result.processed
      ? {
          totalMessageCount: result.processed.totalMessageCount,
          totalCharCount: result.processed.totalCharCount,
          consolidateOnly: result.processed.consolidateOnly,
        }
      : undefined,
    changes: result.changes,
    errorMessage: result.errorMessage,
  };
}

function createAssistantBase(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function slashCommandKindRank(kind: AgentSlashCommandView['kind']): number {
  return kind === 'runtime' ? 0 : 1;
}

function slashCommandDescription(displayName: string | undefined, description: string): string {
  const detail = description.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  if (!displayName || displayName === detail) return detail;
  return detail ? `${displayName} - ${detail}` : displayName;
}

function rendererProjectionEventFromDomain(event: RendererProjectionDomainEvent): AgentRuntimeEvent {
  return {
    type: 'projection',
    conversationId: event.conversationId,
    lastEventType: event.lastEventType,
    revision: event.revision,
    renderProjection: event.projection,
    timestamp: event.createdAt,
  };
}

// A command's delivery conversation is titled from the first non-empty line of
// its brief (capped) so it reads sensibly in the conversation history instead of
// "Untitled". Falls back to a generic label for an empty brief.
function commandConversationTitle(brief: string): string {
  const firstLine = brief.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
  if (!firstLine) return 'Command';
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
