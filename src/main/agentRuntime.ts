import { app, type BrowserWindow } from 'electron';
import {
  Agent,
  type AfterToolCallResult,
  type AgentEvent as PiAgentEvent,
  type AgentLoopTurnUpdate,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import {
  cleanupSessionResources as cleanupPiSessionResources,
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
  principalKey,
  samePrincipal,
  type AgentActor,
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
  memoryFactKey,
  mergeMemorySources,
  parseDreamMemoryActions,
  type DreamMemoryAction,
  type DreamMemoryExtractionAgentRunInput,
  type DreamMemoryExtractionSpan,
  type DreamMemoryExtractionSourceRange,
} from './agentDreamExtraction';
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
  sessionId: string;
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
}

type RendererProjectionDomainEvent = Extract<AgentDomainEvent, { lane: 'renderer-projection' }>;
type PublicConversationRuntimeEventInput =
  | Omit<Extract<AgentRuntimeEvent, { type: 'approval_request' }>, 'conversationId' | 'timestamp'>
  | Omit<Extract<AgentRuntimeEvent, { type: 'approval_resolved' }>, 'conversationId' | 'timestamp'>
  | Omit<Extract<AgentRuntimeEvent, { type: 'user_question_request' }>, 'conversationId' | 'timestamp'>
  | Omit<Extract<AgentRuntimeEvent, { type: 'user_question_resolved' }>, 'conversationId' | 'timestamp'>
  | Omit<Extract<AgentRuntimeEvent, { type: 'closed' }>, 'conversationId' | 'timestamp'>
  | Omit<Extract<AgentRuntimeEvent, { type: 'error' }>, 'conversationId' | 'timestamp'>;

interface AgentSessionState {
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
  unsubscribe: (() => void) | null;
}

interface AgentDreamMemoryExtractionTask {
  runId: string;
  agentId: string;
  /** The memory pool this Dream consolidates (the subject it models). */
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
  originWorkspace?: string;
  originWorkspaceFilter?: string;
}

interface AgentDreamMemoryScope {
  readOnly: boolean;
  originWorkspace?: string;
  originWorkspaceFilter?: string;
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
  private sessions = new Map<string, AgentSessionState>();
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
    sessionId: string;
    request: AgentApprovalRequestView;
    alwaysAllowRule?: string;
    resolve: (resolution: AgentToolApprovalResolution) => void;
  }>();
  private pendingUserQuestions = new Map<string, AgentPendingUserQuestion>();
  private nextSessionId = 1;
  private dreamMemoryExtractionTail: Promise<void> = Promise.resolve();
  private readonly dreamingAgentIds = new Set<string>();
  private dreamSchedulerTimer: ReturnType<typeof setInterval> | null = null;
  private commandSchedulerTimer: ReturnType<typeof setInterval> | null = null;
  private commandSweepTail: Promise<void> = Promise.resolve();
  private readonly firingCommandNodeIds = new Set<string>();
  private readonly commandFailureCounts = new Map<string, number>();
  private readonly commandBackoffUntil = new Map<string, number>();
  // Command nodes that have a delivery conversation this session, so the sweep
  // can delete the conversation when the node is permanently removed.
  private readonly knownCommandConversationNodeIds = new Set<string>();
  private agentTaskCache: AgentRenderTaskEntity[] = [];
  private readonly userViewContextReminderTracker = new AgentUserViewContextReminderTracker();
  private readonly contextManager: AgentRuntimeContextManager<AgentSessionState>;
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
    this.contextManager = new AgentRuntimeContextManager<AgentSessionState>({
      refreshRuntimeSettings: (session) => this.refreshRuntimeSettings(session),
      deriveRuntimePiMessages: (sessionId, eventState) => this.deriveRuntimePiMessages(sessionId, eventState),
      appendSessionEvents: async (sessionId, session, inputs) => {
        await this.appendSessionEvents(sessionId, session, inputs);
      },
      appendCompactionRootEvent: (
        sessionId,
        session,
        prompt,
        summary,
        source,
        trigger,
        preservedMessages,
      ) => (
        this.appendCompactionRootEvent(
          sessionId,
          session,
          prompt,
          summary,
          source,
          trigger,
          preservedMessages,
        )
      ),
      persistToolOutputPayload: (sessionId, toolCallId, toolName, text) => (
        this.persistToolOutputPayload(sessionId, toolCallId, toolName, text)
      ),
      captureDebugPayload: (sessionId, payload, model) => this.captureDebugPayload(sessionId, payload, model),
      captureDebugResponse: (sessionId, response, model) => this.captureDebugResponse(sessionId, response, model),
      emitError: (sessionId, message) => this.emitError(sessionId, message),
      getActiveProviderConfig: () => this.getActiveProviderConfig(),
      getProviderApiKey: (providerId) => this.getProviderApiKey(providerId),
      resolveProviderModel: (providerConfig) => this.resolveProviderModel(providerConfig),
      beginCompaction: (sessionId, session, trigger) => this.beginCompaction(sessionId, session, trigger),
      finishCompaction: (sessionId, session, compactionId, lastEventType) => {
        this.finishCompaction(sessionId, session, compactionId, lastEventType);
      },
      startReactiveRetryRun: async (sessionId, session) => {
        this.beginDebugQuery(session);
        await this.startRun(sessionId, session, session.lastRun?.lastSubmittedUserPrompt ?? null);
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
    const sessionId = sessionIdFromConversationId(conversationId);
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Agent conversation not live: ${conversationId}`);
    return this.emitTaskNotification(sessionId, session, {
      notificationId,
      kind: 'task_completed',
      title: 'Test notification',
    });
  }

  async restoreLatestConversation() {
    return this.restoreOrCreateDefaultDm();
  }

  async restoreConversation(conversationId: string) {
    const sessionId = sessionIdFromConversationId(conversationId);
    const eventState = await this.loadEventState(sessionId);
    if (!eventState.session) throw new Error(`Agent conversation not found: ${sessionId}`);
    const session = await this.createSessionWithEventState(eventState);
    await this.refreshAgentTaskCache();
    // Restoring loads a conversation's state; it does NOT mark it read, and it does
    // NOT imply the user is viewing it (the dock may be collapsed). Marking read and
    // the viewed-conversation signal are both driven explicitly by the renderer.
    return this.conversationResponse(sessionId, session);
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
    const sessionId = sessionIdFromConversationId(conversationId);
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // Cheap pre-check to avoid scheduling an append when clearly nothing is unread;
    // the authoritative decision is re-taken inside the serial block below.
    const pending = session.eventState.attentionByConversationId[conversationId];
    if (!pending || pending.unreadCount === 0) return;
    await this.appendSessionEvents(sessionId, session, (state) => {
      const attention = state.attentionByConversationId[conversationId];
      if (!attention || attention.unreadCount === 0) return [];
      const throughSeq = state.latestSeq;
      if (throughSeq <= attention.lastReadThroughSeq) return [];
      return [{ type: 'notification.read', actor: userActor(), conversationId, throughSeq }];
    });
    this.emitConversationAttention(sessionId, session);
  }

  private async restoreOrCreateDefaultDm() {
    const sessionId = this.defaultDmConversationId();
    let eventState = await this.loadEventState(sessionId);
    if (!eventState.session) {
      eventState = createEmptyAgentEventReplayState();
      const events = this.buildEvents(eventState, sessionId, [{
        type: 'session.created',
        actor: systemActor(),
        title: this.agentIdentity.displayName,
        members: this.defaultConversationMembers(),
      }]);
      await this.getEventStore().appendEvents(sessionId, events);
      for (const event of events) appendAgentEventToReplayState(eventState, event);
      this.publishPersistedEvents(sessionId, events);
    }
    const session = await this.createSessionWithEventState(eventState);
    await this.refreshAgentTaskCache();
    return this.conversationResponse(sessionId, session);
  }

  async createConversation() {
    const sessionId = this.createChannelId();
    const eventState = createEmptyAgentEventReplayState();
    const title = normalizeSessionTitle('');
    const created = this.buildEvents(eventState, sessionId, [{
      type: 'session.created',
      actor: systemActor(),
      title,
      members: this.defaultConversationMembers(),
      goal: title,
    }]);
    await this.getEventStore().appendEvents(sessionId, created);
    for (const event of created) appendAgentEventToReplayState(eventState, event);
    this.publishPersistedEvents(sessionId, created);
    const session = await this.createSessionWithEventState(eventState);
    await this.refreshAgentTaskCache();
    return this.conversationResponse(sessionId, session);
  }

  async listConversations() {
    const entries = await this.getEventStore().listConversationIndexEntries();
    const listed = entries.filter((entry) => !!entry.goal);
    // Seed cross-conversation unread badges on launch: the live conversation_attention
    // event only fires for sessions touched this run, so a conversation that went
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
        title: sanitizeSessionTitle(entry.title),
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
    const sessionId = sessionIdFromConversationId(conversationId);
    const session = await this.ensureSessionWithId(sessionId);
    const runtimeSettings = await this.refreshRuntimeSettings(session);
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
      const skills = await session.skillRuntime.listUserInvocableSkills();
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
    const sessionId = sessionIdFromConversationId(conversationId);
    const pending = this.pendingApprovals.get(requestId);
    if (!pending || pending.sessionId !== sessionId) return { resolved: false };
    const session = this.sessions.get(sessionId);
    if (!session) return { resolved: false };

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
        this.emitError(sessionId, `Failed to persist always-allow rule; approved once instead. ${message}`);
        resolvedScope = 'once';
        alwaysAllowRule = undefined;
      }
    }

    this.pendingApprovals.delete(requestId);
    try {
      await this.appendSessionEvents(sessionId, session, [{
        type: 'approval.resolved',
        actor: userActor(),
        runId: this.activeRunId(session) ?? undefined,
        requestId,
        approved,
      }]);
      this.emitConversationRuntimeEvent(sessionId, {
        type: 'approval_resolved',
        requestId,
        approved,
        scope: resolvedScope,
      });
      this.emitProjection(sessionId, 'approval.resolved');
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
    const sessionId = sessionIdFromConversationId(conversationId);
    const session = await this.ensureSessionWithId(sessionId);
    const projection = await this.deriveDebugProjection(sessionId);
    const snapshot = projection.history.at(-1) ?? this.getRuntimeDebugSnapshot(sessionId, session);
    return snapshot ? cloneDebug(snapshot) : null;
  }

  async debugHistory(conversationId: string) {
    const sessionId = sessionIdFromConversationId(conversationId);
    await this.ensureSessionWithId(sessionId);
    return cloneDebug((await this.deriveDebugProjection(sessionId)).history);
  }

  async debugTotals(conversationId: string) {
    const sessionId = sessionIdFromConversationId(conversationId);
    await this.ensureSessionWithId(sessionId);
    return cloneDebug((await this.deriveDebugProjection(sessionId)).totals);
  }

  async debugPayload(conversationId: string, payloadId: string) {
    const sessionId = sessionIdFromConversationId(conversationId);
    const session = this.sessions.get(sessionId);
    const eventState = session?.eventState ?? await this.loadEventState(sessionId);
    const payload = eventState.payloads[payloadId];
    if (!payload || payload.role !== 'debug') return null;
    const bytes = await this.getEventStore().readPayload(sessionId, payload);
    return bytes.toString('utf8');
  }

  async payloadText(conversationId: string, payloadId: string) {
    const sessionId = sessionIdFromConversationId(conversationId);
    const session = this.sessions.get(sessionId);
    const eventState = session?.eventState ?? await this.loadEventState(sessionId);
    const payload = eventState.payloads[payloadId];
    if (!payload || !isTextPayloadRole(payload.role) || !isTextPayloadMimeType(payload.mimeType)) return null;
    const bytes = await this.getEventStore().readPayload(sessionId, payload);
    return bytes.toString('utf8');
  }

  async subagentStatus(
    conversationId: string,
    agentId: string,
    options: { wait?: boolean; timeoutMs?: number } = {},
  ) {
    const sessionId = sessionIdFromConversationId(conversationId);
    const session = await this.ensureSessionWithId(sessionId);
    return session.subagentRuntime.status({
      agent_id: agentId,
      wait: options.wait === true,
      timeout_ms: options.timeoutMs,
    });
  }

  async subagentSend(conversationId: string, agentId: string, message: string) {
    const sessionId = sessionIdFromConversationId(conversationId);
    const session = await this.ensureSessionWithId(sessionId);
    return session.subagentRuntime.send({
      agent_id: agentId,
      message,
    });
  }

  async subagentStop(conversationId: string, agentId: string) {
    const sessionId = sessionIdFromConversationId(conversationId);
    const session = await this.ensureSessionWithId(sessionId);
    return session.subagentRuntime.stop({
      agent_id: agentId,
    });
  }

  async listAllAgentDefinitions(conversationId: string): Promise<AgentDefinitionView[]> {
    const definitions = await this.listRawAgentDefinitions(conversationId);
    return definitions.map((definition) => ({ ...definition, agentId: agentDefinitionAgentId(definition) }));
  }

  // The raw (agentId-less) scan, shared by the settings list and the
  // authoring resolve-by-id path. Reuses a live session's registry when one
  // exists (so its cache invalidation is observed), else a throwaway runtime.
  private async listRawAgentDefinitions(conversationId: string): Promise<AgentDefinition[]> {
    const sessionId = sessionIdFromConversationId(conversationId);
    const session = this.sessions.get(sessionId);
    if (session) {
      return session.subagentRuntime.listAllAgentDefinitions();
    }
    const tempRuntime = new AgentSubagentRuntime({
      sessionId: 'temp-settings-list',
      executingAgentId: this.agentIdentity.agentId,
      memoryOwnerAgentId: this.agentIdentity.agentId,
      localRoot: this.options.localFileRoot,
      host: {} as any,
    });
    return tempRuntime.listAllAgentDefinitions();
  }

  // Authoring (user-driven only — see [[agent-authoring]]). Each write goes
  // through main's containment-checked file surface, then every live session's
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

  // Invalidate every live session's registry cache, then return the fresh list.
  // Also exposed as an explicit "reload agents" action.
  async reloadAgentDefinitions(conversationId: string): Promise<AgentDefinitionView[]> {
    for (const session of this.sessions.values()) {
      session.subagentRuntime.reloadAgentDefinitions();
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
    const sessionId = sessionIdFromConversationId(conversationId);
    const session = this.sessions.get(sessionId);
    if (session) {
      return session.skillRuntime.listAllSkills();
    }
    const runtimeSettings = await this.getRuntimeSettings();
    const tempRuntime = new AgentSkillRuntime({
      localRoot: this.options.localFileRoot,
      additionalSkillDirectories: runtimeSettings.additionalSkillDirectories,
    });
    return tempRuntime.listAllSkills();
  }

  async renameConversation(conversationId: string, title: string) {
    const sessionId = sessionIdFromConversationId(conversationId);
    if (this.isDefaultDmSessionId(sessionId)) {
      throw new Error('The canonical agent DM cannot be renamed.');
    }
    const normalized = normalizeSessionTitle(title);
    const session = this.sessions.get(sessionId);
    if (session) {
      await this.appendSessionEvents(sessionId, session, [{
        type: 'session.renamed',
        actor: systemActor(),
        title: normalized,
        goal: normalized,
      }]);
      this.emitProjection(sessionId, 'session_renamed');
      return eventStateToMeta(session.eventState);
    }
    const eventState = await this.loadEventState(sessionId);
    if (!eventState.session) return null;
    const events = this.buildEvents(eventState, sessionId, [{
      type: 'session.renamed',
      actor: systemActor(),
      title: normalized,
      goal: normalized,
    }]);
    await this.getEventStore().appendEvents(sessionId, events);
    for (const event of events) appendAgentEventToReplayState(eventState, event);
    this.publishPersistedEvents(sessionId, events);
    return eventStateToMeta(eventState);
  }

  async deleteConversation(conversationId: string) {
    const sessionId = sessionIdFromConversationId(conversationId);
    if (this.isDefaultDmSessionId(sessionId)) {
      throw new Error('The canonical agent DM cannot be deleted.');
    }
    const session = this.sessions.get(sessionId);
    if (session) {
      await this.clearPendingUserQuestionsForSession(sessionId, 'conversation_deleted');
      session.agent.abort();
      session.unsubscribe?.();
      clearPendingProjection(session);
      this.sessions.delete(sessionId);
      this.debugProjectionCache.delete(sessionId);
      this.userViewContextReminderTracker.reset(sessionId);
      this.emitConversationRuntimeEvent(sessionId, { type: 'closed' });
    }
    this.cleanupProviderSessionResources(sessionId);
    await this.getEventStore().deleteConversation(sessionId);
    this.userViewContextReminderTracker.reset(sessionId);
  }

  async sendMessage(
    conversationId: string,
    message: string,
    attachmentInput: unknown = [],
    userViewContextInput: unknown = null,
  ) {
    const sessionId = sessionIdFromConversationId(conversationId);
    try {
      const session = await this.ensureSessionWithId(sessionId);
      const materialized = await this.materializeFileAttachments(normalizeAttachmentInputs(attachmentInput));
      const attachments = materialized.attachments;
      const messageText = rewriteFileReferenceMarkerPaths(message, materialized.pathMap);
      if (!messageText.trim() && attachments.length === 0) return;
      if (session.agent.state.isStreaming) {
        if (attachments.length > 0) {
          throw new Error('Attachments cannot be queued while the agent is running.');
        }
        await this.steerConversation(conversationId, messageText);
        return;
      }
      const runtimeSettings = await this.refreshRuntimeSettings(session);
      const compactCommand = attachments.length === 0 && runtimeSettings.compactEnabled
        ? parseCompactSlashCommand(messageText)
        : null;
      if (compactCommand) {
        await this.compactSession(sessionId, session, compactCommand.instructions);
        return;
      }
      if (attachments.length === 0 && parseDreamSlashCommand(messageText) && this.dreamMemoryExtractionEnabled()) {
        await this.runManualDreamFromConversation(sessionId);
        return;
      }
      session.skillRuntime.resetRunPermissionRules();
      this.beginDebugQuery(session);
      const userViewContextReminder = this.userViewContextReminderTracker.prepare(
        sessionId,
        normalizeAgentUserViewContext(userViewContextInput),
      );
      const userViewReminderText = userViewContextReminder.reminder;
      const now = new Date();
      const outlinerContext = buildOutlinerContextReminder(this.outlinerToolHost);
      const memoryReminder = await this.buildMemoryReminder(this.agentIdentity.agentId, session);
      const turnContextReminder = joinReminderParts([
        buildEnvironmentContextReminder(now),
        memoryReminder,
        outlinerContext,
        userViewReminderText,
      ]);
      const slashSkillPrompt = attachments.length === 0 && runtimeSettings.slashSkillsEnabled
        ? await createSlashSkillPrompt(session.skillRuntime, messageText, turnContextReminder)
        : null;
      const skillListingReminder = slashSkillPrompt
        ? null
        : await this.buildSkillListingReminder(session);
      const agentListingReminder = slashSkillPrompt
        ? null
        : await this.buildAgentListingReminder(session);
      const prompt = slashSkillPrompt ?? buildUserPromptMessage(messageText, attachments, {
        memoryReminder,
        outlinerContext,
        userViewContextReminder: userViewReminderText,
        skillListingReminder,
        agentListingReminder,
      }, now);
      await this.appendUserPromptEvent(sessionId, session, prompt);
      userViewContextReminder.commit();
      await this.startRun(sessionId, session, prompt);
      await session.agent.prompt(prompt);
      await this.contextManager.runReactiveCompactRetryIfNeeded(sessionId, session);
      await this.persistAndEmitIdle(sessionId, session);
    } catch (error) {
      this.emitError(sessionId, error instanceof Error ? error.message : String(error));
    }
  }

  async editMessage(conversationId: string, nodeId: string, message: string) {
    const sessionId = sessionIdFromConversationId(conversationId);
    const trimmed = message.trim();
    if (!trimmed) return;
    try {
      const session = await this.ensureSessionWithId(sessionId);
      if (session.agent.state.isStreaming) throw new Error('Cannot edit while the agent is running.');
      const target = requireEventMessage(session.eventState, nodeId);
      if (target.role !== 'user') throw new Error('Only user messages can be edited');
      this.userViewContextReminderTracker.reset(sessionId);
      await this.appendSessionEvents(sessionId, session, [{
        type: 'user_message.created',
        actor: userActor(),
        messageId: this.createMessageId('user'),
        parentMessageId: target.parentMessageId,
        replacesMessageId: target.id,
        content: textPersistedContent(trimmed),
      }]);
      session.agent.state.messages = await this.deriveRuntimePiMessages(sessionId, session.eventState) as never;
      this.emitProjection(sessionId, 'message_edited');
      session.skillRuntime.resetRunPermissionRules();
      this.beginDebugQuery(session);
      await this.startRun(sessionId, session);
      await session.agent.continue();
      await this.contextManager.runReactiveCompactRetryIfNeeded(sessionId, session);
      await this.persistAndEmitIdle(sessionId, session);
    } catch (error) {
      this.emitError(sessionId, error instanceof Error ? error.message : String(error));
    }
  }

  async regenerateMessage(conversationId: string, nodeId: string) {
    const sessionId = sessionIdFromConversationId(conversationId);
    try {
      const session = await this.ensureSessionWithId(sessionId);
      if (session.agent.state.isStreaming) throw new Error('Cannot regenerate while the agent is running.');
      const targetId = findRegenerateTarget(session.eventState, nodeId);
      const parentId = requireEventMessage(session.eventState, targetId).parentMessageId;
      if (!parentId) throw new Error('Cannot regenerate without a parent message.');
      this.userViewContextReminderTracker.reset(sessionId);
      await this.appendSessionEvents(sessionId, session, [{
        type: 'branch.selected',
        actor: systemActor(),
        leafMessageId: parentId,
      }]);
      session.agent.state.messages = await this.deriveRuntimePiMessages(sessionId, session.eventState) as never;
      this.emitProjection(sessionId, 'message_regenerate_started');
      session.skillRuntime.resetRunPermissionRules();
      this.beginDebugQuery(session);
      await this.startRun(sessionId, session);
      await continueFromActivePath(session.agent);
      await this.contextManager.runReactiveCompactRetryIfNeeded(sessionId, session);
      await this.persistAndEmitIdle(sessionId, session);
    } catch (error) {
      this.emitError(sessionId, error instanceof Error ? error.message : String(error));
    }
  }

  async retryMessage(conversationId: string, nodeId: string) {
    const sessionId = sessionIdFromConversationId(conversationId);
    try {
      const session = await this.ensureSessionWithId(sessionId);
      if (session.agent.state.isStreaming) throw new Error('Cannot retry while the agent is running.');
      const parentId = requireEventMessage(session.eventState, nodeId).parentMessageId;
      if (!parentId) throw new Error('Cannot retry without a parent message.');
      this.userViewContextReminderTracker.reset(sessionId);
      await this.appendSessionEvents(sessionId, session, [{
        type: 'branch.selected',
        actor: systemActor(),
        leafMessageId: parentId,
      }]);
      session.agent.state.messages = await this.deriveRuntimePiMessages(sessionId, session.eventState) as never;
      this.emitProjection(sessionId, 'message_retry_started');
      session.skillRuntime.resetRunPermissionRules();
      this.beginDebugQuery(session);
      await this.startRun(sessionId, session);
      await continueFromActivePath(session.agent);
      await this.contextManager.runReactiveCompactRetryIfNeeded(sessionId, session);
      await this.persistAndEmitIdle(sessionId, session);
    } catch (error) {
      this.emitError(sessionId, error instanceof Error ? error.message : String(error));
    }
  }

  async switchBranch(conversationId: string, nodeId: string) {
    const sessionId = sessionIdFromConversationId(conversationId);
    try {
      const session = await this.ensureSessionWithId(sessionId);
      if (session.agent.state.isStreaming) throw new Error('Cannot switch branches while the agent is running.');
      const leafMessageId = findLatestEventLeaf(session.eventState, nodeId).id;
      this.userViewContextReminderTracker.reset(sessionId);
      await this.appendSessionEvents(sessionId, session, [{
        type: 'branch.selected',
        actor: systemActor(),
        leafMessageId,
      }]);
      session.agent.state.messages = await this.deriveRuntimePiMessages(sessionId, session.eventState) as never;
      this.emitProjection(sessionId, 'branch_switched');
    } catch (error) {
      this.emitError(sessionId, error instanceof Error ? error.message : String(error));
    }
  }

  async queueFollowUp(conversationId: string, message: string, userViewContextInput: unknown = null) {
    const sessionId = sessionIdFromConversationId(conversationId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.emitError(sessionId, `Unknown agent conversation: ${sessionId}`);
      return { queued: false };
    }
    const text = message.trim();
    if (!text) return { queued: false };
    this.releaseQueuedFollowUpSkillListing(session);
    session.agent.clearFollowUpQueue();
    this.userViewContextReminderTracker.reset(sessionId);
    await this.refreshRuntimeSettings(session);
    const skillListingReservation = await this.reserveSkillListingReminder(session);
    session.queuedFollowUpSkillListingReservation = skillListingReservation;
    const userViewContextReminder = buildUserViewContextReminder(normalizeAgentUserViewContext(userViewContextInput));
    session.agent.followUp(buildUserPromptMessage(text, [], {
      memoryReminder: await this.buildMemoryReminder(this.agentIdentity.agentId, session),
      outlinerContext: buildOutlinerContextReminder(this.outlinerToolHost),
      userViewContextReminder,
      skillListingReminder: skillListingReservation?.text ?? null,
      agentListingReminder: await this.buildAgentListingReminder(session),
    }));
    this.emitProjection(sessionId, 'follow_up_queued');
    return { queued: true };
  }

  steerConversation(conversationId: string, message: string) {
    const sessionId = sessionIdFromConversationId(conversationId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.emitError(sessionId, `Unknown agent conversation: ${sessionId}`);
      return { queued: false };
    }
    const text = message.trim();
    if (!text) return { queued: false };
    if (!session.agent.state.isStreaming) return { queued: false };
    session.agent.clearSteeringQueue();
    session.agent.steer({
      role: 'user',
      timestamp: Date.now(),
      content: [{ type: 'text', text }],
    });
    this.emitProjection(sessionId, 'steer_queued');
    return { queued: true };
  }

  clearSteer(conversationId: string) {
    const sessionId = sessionIdFromConversationId(conversationId);
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.agent.clearSteeringQueue();
    this.emitProjection(sessionId, 'steer_cleared');
  }

  clearFollowUp(conversationId: string) {
    const sessionId = sessionIdFromConversationId(conversationId);
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.agent.clearFollowUpQueue();
    this.releaseQueuedFollowUpSkillListing(session);
    this.emitProjection(sessionId, 'follow_up_cleared');
  }

  stopConversation(conversationId: string) {
    const sessionId = sessionIdFromConversationId(conversationId);
    const session = this.sessions.get(sessionId);
    if (!session) return;
    void this.clearPendingUserQuestionsForSession(sessionId, 'conversation_stopped')
      .catch((error) => this.emitError(sessionId, error instanceof Error ? error.message : String(error)));
    session.agent.abort();
    session.skillRuntime.resetRunPermissionRules();
    this.emitProjection(sessionId, 'stop_requested');
  }

  resetConversation(conversationId: string) {
    const sessionId = sessionIdFromConversationId(conversationId);
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.agent.reset();
    this.cleanupProviderSessionResources(sessionId);
    this.userViewContextReminderTracker.reset(sessionId);
    void (async () => {
      await this.clearPendingApprovalsForSession(sessionId, session);
      await this.clearPendingUserQuestionsForSession(sessionId, 'conversation_reset');
      const previousSession = session.eventState.session;
      await this.getEventStore().deleteConversation(sessionId);
      this.debugProjectionCache.delete(sessionId);
      const eventState = createEmptyAgentEventReplayState();
      const events = this.buildEvents(eventState, sessionId, [{
        type: 'session.created',
        actor: systemActor(),
        title: previousSession?.title ?? (this.isDefaultDmSessionId(sessionId) ? this.agentIdentity.displayName : 'Untitled'),
        members: previousSession?.members.slice() ?? this.defaultConversationMembers(),
        goal: previousSession?.goal,
      }]);
      await this.getEventStore().appendEvents(sessionId, events);
      for (const event of events) appendAgentEventToReplayState(eventState, event);
      this.publishPersistedEvents(sessionId, events);
      session.eventState = eventState;
      session.agent.state.messages = [];
      session.autoCompactConsecutiveFailures = 0;
      session.activeRun = null;
      session.lastRun = null;
      session.pendingSubagentNotifications.length = 0;
      session.queuedFollowUpSkillListingReservation = null;
      session.reactiveCompactRequested = false;
      session.localWorkspace.readFileState.clear();
      session.toolResultBudgetState = createToolResultBudgetState();
      await this.refreshRuntimeSettings(session);
      session.skillRuntime.resetSessionState();
      this.emitProjection(sessionId, 'session_reset');
    })().catch((error) => this.emitError(sessionId, error instanceof Error ? error.message : String(error)));
  }

  closeConversation(conversationId: string) {
    const sessionId = sessionIdFromConversationId(conversationId);
    const session = this.sessions.get(sessionId);
    if (!session) return;
    void this.clearPendingApprovalsForSession(sessionId, session)
      .catch((error) => this.emitError(sessionId, error instanceof Error ? error.message : String(error)));
    void this.clearPendingUserQuestionsForSession(sessionId, 'conversation_closed')
      .catch((error) => this.emitError(sessionId, error instanceof Error ? error.message : String(error)));
    session.agent.abort();
    session.unsubscribe?.();
    clearPendingProjection(session);
    this.sessions.delete(sessionId);
    this.userViewContextReminderTracker.reset(sessionId);
    this.cleanupProviderSessionResources(sessionId);
    this.emitConversationRuntimeEvent(sessionId, { type: 'closed' });
  }

  private async clearPendingApprovalsForSession(sessionId: string, session: AgentSessionState) {
    const resolvedEvents: AgentEventInput[] = [];
    for (const [requestId, pending] of [...this.pendingApprovals]) {
      if (pending.sessionId !== sessionId) continue;
      this.pendingApprovals.delete(requestId);
      resolvedEvents.push({
        type: 'approval.resolved',
        actor: systemActor(),
        runId: this.activeRunId(session) ?? undefined,
        requestId,
        approved: false,
      });
      this.emitConversationRuntimeEvent(sessionId, {
        type: 'approval_resolved',
        requestId,
        approved: false,
      });
      pending.resolve({ approved: false, deniedReason: 'runtime' });
    }
    if (resolvedEvents.length > 0) {
      await this.appendSessionEvents(sessionId, session, resolvedEvents);
      this.emitProjection(sessionId, 'approval.resolved');
    }
  }

  private async clearPendingUserQuestionsForSession(sessionId: string, reason: string) {
    for (const pending of [...this.pendingUserQuestions.values()]) {
      if (pending.sessionId === sessionId) await this.cancelUserQuestion(pending.requestId, reason);
    }
  }

  private async createSessionWithEventState(eventState: AgentEventReplayState) {
    if (!eventState.session) throw new Error('Cannot create agent runtime without session.created');
    const sessionId = eventState.session.id;
    this.reserveSessionId(sessionId);
    const existing = this.sessions.get(sessionId);
    existing?.unsubscribe?.();
    existing?.agent.abort();
    if (existing) clearPendingProjection(existing);
    if (existing) this.cleanupProviderSessionResources(sessionId);
    this.userViewContextReminderTracker.reset(sessionId);

    const providerConfig = await this.getActiveProviderConfig();
    const runtimeSettings = await this.getRuntimeSettings();
    const activePath = await this.deriveRuntimePiMessages(sessionId, eventState);
    const providerModel = providerConfig ? this.resolveProviderModel(providerConfig) : null;
    await this.getEventStore().writeAgentIdentity(this.currentAgentIdentity(providerModel));
    const sessionRef: { current: AgentSessionState | null } = { current: null };
    const agentRef: { current: Agent | null } = { current: null };
    const skillRuntime = new AgentSkillRuntime({
      localRoot: this.options.localFileRoot,
      additionalSkillDirectories: runtimeSettings.additionalSkillDirectories,
      sessionId,
      executeSkillShell: async ({ command, skill }) => {
        const activeSettings = await this.getRuntimeSettings();
        const globalPermissions = await readAgentToolPermissionConfig();
        const current = sessionRef.current;
        return executeAgentSkillShellCommand({
          approvalHandler: current
            ? (input, signal) => this.requestToolApproval(sessionId, current, input, signal)
            : undefined,
          command,
          localRoot: this.options.localFileRoot,
          permissionMode: this.options.permissionMode ?? activeSettings.permissionMode,
          allowedTools: skill.allowedTools,
          globalPermissions,
          permissionEventHandler: (input) => {
            const currentSession = sessionRef.current;
            return currentSession ? this.appendToolPermissionEvent(sessionId, currentSession, input) : Promise.resolve();
          },
          toolCallId: `skill-shell-${randomUUID()}`,
        });
      },
      executeForkedSkill: async ({ skill, renderedContent, parentToolCallId }) => {
        const current = sessionRef.current;
        if (!current) throw new Error('Cannot run forked skill before the agent session is ready.');
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
      sessionId,
      executingAgentId: this.agentIdentity.agentId,
      memoryOwnerAgentId: this.agentIdentity.agentId,
      localRoot: this.options.localFileRoot,
      additionalAgentDirectories: runtimeSettings.additionalAgentDirectories,
      host: {
        createChildAgent: (input) => {
          if (!providerConfig) throw new Error('No enabled agent provider is configured.');
          return this.createSubagentAgent(sessionId, sessionRef, providerConfig, input);
        },
        getParentMessages: () => agentRef.current?.state.messages as AgentMessage[] ?? activePath,
        getParentSystemPrompt: () => agentRef.current?.state.systemPrompt ?? LIN_AGENT_SYSTEM_PROMPT,
        getRuntimeSettings: () => this.getRuntimeSettings(),
        buildMemoryReminder: (agentId, originWorkspace) => (
          this.buildMemoryReminder(agentId, sessionRef.current, originWorkspace)
        ),
        persistSubagentRun: (snapshot) => {
          const current = sessionRef.current;
          if (!current) return Promise.resolve();
          return this.persistSubagentRun(sessionId, current, snapshot);
        },
        notifySubagentRun: (snapshot) => {
          const current = sessionRef.current;
          if (!current) return Promise.resolve();
          return this.notifySubagentRun(sessionId, current, snapshot);
        },
        persistToolOutputPayload: (toolCallId, toolName, text) => (
          this.persistToolOutputPayload(sessionId, toolCallId, toolName, text)
        ),
        completeCompactSummary: (compactSessionId, messages, model, customInstructions, signal) => (
          this.completeCompactSummary(compactSessionId, messages, model, customInstructions, signal)
        ),
      },
    });
    subagentRuntime.updateDisabledAgents(runtimeSettings.disabledAgents ?? []);
    subagentRuntime.restoreListedAgentsFromMessages(activePath);
    const agent = providerConfig
      ? createConfiguredAgent(sessionId, providerConfig, activePath, this.outlinerToolHost, {
          localFileRoot: this.options.localFileRoot,
          localWorkspace,
          model: providerModel!,
          permissionMode: this.options.permissionMode,
          runtimeSettingsLoader: () => this.getRuntimeSettings(),
          skillToolEnabled: runtimeSettings.automaticSkillsEnabled,
          skillRuntime,
          subagentRuntime,
          recall: this.createRecallToolRuntime(this.agentIdentity.agentId, () => sessionId, () => sessionRef.current),
          askUserQuestion: this.createAskUserQuestionRuntime(() => sessionId, () => sessionRef.current),
          selfMaintenance: this.createSelfMaintenanceRuntime(() => sessionId, () => sessionRef.current),
          streamFn: this.options.streamFn,
          completeSimpleFn: this.options.completeSimpleFn,
          providerApiKeyLoader: this.options.providerApiKeyLoader,
          permissionClassifier: this.options.permissionClassifier,
          permissionEventHandler: (input) => {
            const current = sessionRef.current;
            return current ? this.appendToolPermissionEvent(sessionId, current, input) : Promise.resolve();
          },
          approvalHandler: (input, signal) => {
            const current = sessionRef.current;
            if (!current) return Promise.resolve({ approved: false, deniedReason: 'runtime' });
            return this.requestToolApproval(sessionId, current, input, signal);
          },
          afterToolResult: (toolCallId, toolName, result, isError) => {
            const current = sessionRef.current;
            if (!current) return undefined;
            return this.contextManager.afterToolResultForModelContext(sessionId, current, toolCallId, toolName, result, isError);
          },
        }, async (payload, model) => {
          try {
            await this.captureDebugPayload(sessionId, payload, model);
          } catch (error) {
            this.emitError(sessionId, error instanceof Error ? error.message : String(error));
          }
          return undefined;
        }, async (response, model) => {
          try {
            await this.captureDebugResponse(sessionId, response, model);
          } catch (error) {
            this.emitError(sessionId, error instanceof Error ? error.message : String(error));
          }
        })
      : createConfigurationErrorAgent(sessionId, 'No enabled agent provider is configured.', activePath);
    agentRef.current = agent;

    const debugCounters = await this.loadDebugCounters(sessionId);
    const session: AgentSessionState = {
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
      unsubscribe: null,
    };
    sessionRef.current = session;
    await this.markInterruptedSubagentsOnRestore(sessionId, session);
    session.subagentRuntime.restorePersistedRuns(await this.loadPersistedSubagentRuns(sessionId, session.eventState));
    agent.transformContext = async (_messages, signal) => this.contextManager.prepareModelContext(sessionId, session, signal);

    session.unsubscribe = agent.subscribe(async (event) => {
      await this.handlePiAgentEvent(sessionId, session, event);
      if (event.type === 'agent_end') {
        session.currentDebugQueryIndex = 0;
      }
      this.emitProjection(sessionId, event.type, event.type === 'message_update' ? 'coalesce' : 'immediate');
    });
    this.sessions.set(sessionId, session);
    this.emitProjection(sessionId, 'session_created');
    return session;
  }

  private async ensureSessionWithId(sessionId: string, titleOverride?: string) {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    let eventState = await this.loadEventState(sessionId);
    if (!eventState.session) {
      eventState = createEmptyAgentEventReplayState();
      const isDefaultDm = this.isDefaultDmSessionId(sessionId);
      const title = isDefaultDm ? this.agentIdentity.displayName : (titleOverride?.trim() || 'Untitled');
      const events = this.buildEvents(eventState, sessionId, [{
        type: 'session.created',
        actor: systemActor(),
        title,
        members: this.defaultConversationMembers(),
        goal: isDefaultDm ? undefined : title,
      }]);
      await this.getEventStore().appendEvents(sessionId, events);
      for (const event of events) appendAgentEventToReplayState(eventState, event);
      this.publishPersistedEvents(sessionId, events);
    }
    await this.createSessionWithEventState(eventState);
    return this.sessions.get(sessionId)!;
  }

  private beginDebugQuery(session: AgentSessionState) {
    if (session.currentDebugQueryIndex > 0) return;
    session.currentDebugQueryIndex = session.nextDebugQueryIndex;
    session.nextDebugQueryIndex += 1;
  }

  private async buildSkillListingReminder(session: AgentSessionState): Promise<string | null> {
    return (await this.reserveSkillListingReminder(session))?.text ?? null;
  }

  private async buildAgentListingReminder(session: AgentSessionState): Promise<string | null> {
    return session.subagentRuntime.reserveAgentListingReminderText(
      session.agent.state.model.contextWindow,
    );
  }

  private async reserveSkillListingReminder(session: AgentSessionState) {
    if (!session.runtimeSettings.automaticSkillsEnabled) return null;
    return session.skillRuntime.reserveSkillListingReminderText(
      session.agent.state.model.contextWindow,
    );
  }

  private releaseQueuedFollowUpSkillListing(session: AgentSessionState): void {
    if (!session.queuedFollowUpSkillListingReservation) return;
    session.skillRuntime.releaseSkillListingReservation(session.queuedFollowUpSkillListingReservation);
    session.queuedFollowUpSkillListingReservation = null;
  }

  private async refreshRuntimeSettings(session: AgentSessionState): Promise<AgentRuntimeSettings> {
    const runtimeSettings = await this.getRuntimeSettings();
    session.runtimeSettings = runtimeSettings;
    session.skillRuntime.updateAdditionalSkillDirectories(runtimeSettings.additionalSkillDirectories);
    session.skillRuntime.updateDisabledSkills(runtimeSettings.disabledSkills ?? []);
    session.subagentRuntime.updateDisabledAgents(runtimeSettings.disabledAgents ?? []);
    this.applyRuntimeToolSettings(session);
    return runtimeSettings;
  }

  private applyRuntimeToolSettings(session: AgentSessionState): void {
    session.subagentRuntime.updateAdditionalAgentDirectories(session.runtimeSettings.additionalAgentDirectories);
    session.agent.state.tools = createAgentTools(this.outlinerToolHost, {
      localFileRoot: this.options.localFileRoot,
      localWorkspace: session.localWorkspace,
      skillRuntime: session.skillRuntime,
      skillToolEnabled: session.runtimeSettings.automaticSkillsEnabled,
      subagentRuntime: session.subagentRuntime,
      recall: this.createRecallToolRuntime(this.agentIdentity.agentId, () => session.eventState.session?.id ?? 'unknown', () => session),
      askUserQuestion: this.createAskUserQuestionRuntime(() => session.eventState.session?.id ?? 'unknown', () => session),
      selfMaintenance: this.createSelfMaintenanceRuntime(() => session.eventState.session?.id ?? 'unknown', () => session),
    });
  }

  private createSubagentAgent(
    parentSessionId: string,
    parentSessionRef: { current: AgentSessionState | null },
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
    return createConfiguredAgent(input.sessionId, providerConfig, input.messages, this.outlinerToolHost, {
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
        () => input.sessionId,
        () => parentSessionRef.current,
        input.memoryOriginWorkspace,
      ),
      streamFn: this.options.streamFn,
      completeSimpleFn: this.options.completeSimpleFn,
      providerApiKeyLoader: this.options.providerApiKeyLoader,
      permissionClassifier: this.options.permissionClassifier,
      permissionEventHandler: (eventInput) => {
        const parentSession = parentSessionRef.current;
        return parentSession ? this.appendToolPermissionEvent(parentSessionId, parentSession, eventInput) : Promise.resolve();
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
          const parentSession = parentSessionRef.current;
          if (!parentSession) return Promise.resolve({ approved: false, deniedReason: 'runtime' });
          return this.requestToolApproval(parentSessionId, parentSession, approvalInput, signal);
        },
      afterToolResult: input.afterToolResult,
    }, async (payload, modelForPayload) => {
      try {
        await this.captureDebugPayload(input.sessionId, payload, modelForPayload);
      } catch {
        // Subagent sidechain persistence is intentionally isolated from parent UI errors.
      }
      return undefined;
    }, async (response, modelForResponse) => {
      try {
        await this.captureDebugResponse(input.sessionId, response, modelForResponse);
      } catch {
        // Subagent sidechain persistence is intentionally isolated from parent UI errors.
      }
    });
  }

  private async loadPersistedSubagentRuns(
    sessionId: string,
    eventState: AgentEventReplayState,
  ): Promise<AgentSubagentRestoredRun[]> {
    const runs: AgentSubagentRestoredRun[] = [];
    for (const record of Object.values(eventState.subagents ?? {})) {
      const payloadId = record.transcriptPayloadId;
      const payload = payloadId ? eventState.payloads[payloadId] : undefined;
      const transcriptMessages = payload
        ? await this.readSubagentTranscriptPayload(sessionId, payload)
        : [];
      runs.push({ record, transcriptMessages });
    }
    return runs;
  }

  private async markInterruptedSubagentsOnRestore(
    sessionId: string,
    session: AgentSessionState,
  ): Promise<void> {
    const runningRuns = Object.values(session.eventState.subagents ?? {})
      .filter((run) => run.status === 'running');
    if (runningRuns.length === 0) return;

    const interruptedError = 'Subagent was interrupted before session restore.';
    const completedAt = Date.now();
    await this.appendSessionEvents(sessionId, session, runningRuns.map((run): AgentEventInput => ({
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
    // Durable delivery only here (no live model-injection): the session is being
    // restored, not running a turn, and recovery is re-spawn, not resume.
    for (const run of runningRuns) {
      await this.emitTaskNotification(sessionId, session, {
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
    sessionId: string,
    payload: AgentPayloadRef,
  ): Promise<AgentMessage[]> {
    return (await this.readSubagentTranscriptEnvelope(sessionId, payload))?.messages ?? [];
  }

  private async readSubagentTranscriptEnvelope(
    sessionId: string,
    payload: AgentPayloadRef,
  ): Promise<SubagentTranscriptEnvelope | null> {
    try {
      const raw = await this.getEventStore().readPayload(sessionId, payload);
      return parseSubagentTranscriptEnvelope(raw);
    } catch {
      return null;
    }
  }

  private async persistSubagentRun(
    sessionId: string,
    session: AgentSessionState,
    snapshot: AgentSubagentRunSnapshot,
  ): Promise<void> {
    const actor = snapshot.parentToolCallId
      ? toolActor(AGENT_SUBAGENT_TOOL_NAME, snapshot.parentToolCallId)
      : systemActor();
    const exists = Boolean(session.eventState.subagents[snapshot.id]);
    const existingRun = session.eventState.subagents[snapshot.id];
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
      ? session.eventState.payloads[existingRun.transcriptPayloadId]
      : undefined;
    const payload = existingPayload?.sha256 === transcriptSha
      ? undefined
      : await this.getEventStore().writePayload(sessionId, {
          id: `subagent-transcript-${snapshot.id}-${snapshot.transcriptMessages.length}-${transcriptSha.slice(0, 12)}`,
          data: transcriptData,
          mimeType: 'application/json',
          role: 'subagent_transcript',
          summary: `Subagent ${snapshot.subagentType} transcript (${snapshot.transcriptMessages.length} messages)`,
        });
    await this.appendSessionEvents(sessionId, session, [
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
    this.emitProjection(sessionId, exists ? 'subagent_run.updated' : 'subagent_run.started', 'coalesce');
  }

  private async notifySubagentRun(
    sessionId: string,
    session: AgentSessionState,
    snapshot: AgentSubagentRunSnapshot,
  ): Promise<void> {
    if (snapshot.status === 'running') return;
    // A user-initiated stop is the user's own action — it raises no badge/OS
    // banner (the durable notification below is for completion/failure only). The
    // live model-injection still fires so a foreground agent learns its child stopped.
    if (snapshot.status !== 'stopped') {
      // Durable per-conversation delivery: emit the attention/OS signal as a
      // notification.created event anchored to the origin conversation. This is the
      // restart-safe record (the in-memory model-injection below is the live-session
      // composed-turn layer; it is best-effort and not the durability guarantee).
      // The id keys on the completion instant so a *resumed* detached run that
      // finishes again gets a fresh notification (idempotent across replay, distinct
      // across re-completions — see agentSubagents `send`).
      await this.emitTaskNotification(sessionId, session, {
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
    session.pendingSubagentNotifications.push(formatSubagentNotification(snapshot));
    void this.flushSubagentNotifications(sessionId, session).catch((error) => {
      this.emitError(sessionId, error instanceof Error ? error.message : String(error));
    });
  }

  /**
   * Append a durable notification.created event anchored to the session's origin
   * conversation, then surface it (projection + opt-in OS notification). Idempotent
   * on notificationId so a re-emitted terminal snapshot does not double-count.
   */
  private async emitTaskNotification(
    sessionId: string,
    session: AgentSessionState,
    input: {
      notificationId: string;
      kind: AgentNotificationKind;
      title: string;
      body?: string;
      source?: AgentTaskSource;
      actor?: AgentActor;
    },
  ): Promise<void> {
    if (session.eventState.notifications[input.notificationId]) return;
    const conversationId = conversationIdFromSessionId(sessionId);
    const body = input.body ? truncateNotificationBody(input.body) : undefined;
    await this.appendSessionEvents(sessionId, session, [{
      type: 'notification.created',
      actor: input.actor ?? systemActor(),
      notificationId: input.notificationId,
      conversationId,
      kind: input.kind,
      title: input.title,
      body,
      source: input.source,
    }]);
    // No emitProjection here: the render projection never reads notifications or
    // attention (the badge rides the dedicated conversation_attention event), so a
    // rebuild would produce byte-identical content. Attention is the only signal.
    this.emitConversationAttention(sessionId, session);
    this.deliverOsNotification({ title: input.title, body, conversationId });
  }

  private async flushSubagentNotifications(sessionId: string, session: AgentSessionState): Promise<void> {
    if (session.subagentNotificationFlushInProgress) return;
    if (session.pendingSubagentNotifications.length === 0) return;
    if (this.activeRunId(session) || session.agent.state.isStreaming) return;

    session.subagentNotificationFlushInProgress = true;
    try {
      while (session.pendingSubagentNotifications.length > 0) {
        if (this.activeRunId(session) || session.agent.state.isStreaming) break;
        const notifications = session.pendingSubagentNotifications.splice(0);
        const prompt: UserMessage = {
          role: 'user',
          timestamp: Date.now(),
          content: [{ type: 'text', text: systemReminder(notifications.join('\n\n')) }],
        };
        session.skillRuntime.resetRunPermissionRules();
        this.beginDebugQuery(session);
        await this.appendSystemPromptEvent(sessionId, session, prompt);
        await this.startRun(sessionId, session, prompt);
        await session.agent.prompt(prompt);
        await this.contextManager.runReactiveCompactRetryIfNeeded(sessionId, session);
        await this.persistAndEmitIdle(sessionId, session, { flushSubagentNotifications: false });
      }
    } catch (error) {
      this.emitError(sessionId, error instanceof Error ? error.message : String(error));
    } finally {
      session.subagentNotificationFlushInProgress = false;
    }
  }

  private async persistToolOutputPayload(
    sessionId: string,
    toolCallId: string,
    toolName: string,
    text: string,
  ): Promise<{ payload: AgentPayloadRef; label: string }> {
    const session = this.sessions.get(sessionId);
    const runId = session ? this.activeRunId(session) ?? undefined : undefined;
    const payload = await this.getEventStore().writePayload(sessionId, {
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
    sessionId: string,
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
        sessionId,
        signal,
        onPayload: async (payload, payloadModel) => {
          try {
            await this.captureDebugPayload(sessionId, payload, payloadModel);
          } catch {
            // Subagent compact debug capture must not break the child run.
          }
          return undefined;
        },
        onResponse: async (responsePayload, responseModel) => {
          try {
            await this.captureDebugResponse(sessionId, responsePayload, responseModel);
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
    sessionId: string,
    payload: unknown,
    model: Model<any>,
    source: AgentDebugSnapshot['source'] = 'provider_payload',
  ) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.beginDebugQuery(session);
    const turnIndex = session.nextDebugTurnIndex;
    const debugId = `debug-${randomUUID()}`;
    const envelope = createAgentDebugPayloadEnvelope(payload);
    const sourceLabel = source === 'provider_response' ? 'Provider response' : 'Provider payload';
    const payloadRef = await this.getEventStore().writePayload(sessionId, {
      id: `${debugId}-payload`,
      data: envelope.json,
      mimeType: 'application/json',
      runId: this.activeRunId(session) ?? undefined,
      role: 'debug',
      summary: `${sourceLabel} round ${turnIndex}`,
    });
    await this.appendSessionEvents(sessionId, session, [{
      type: 'payload.created',
      actor: systemActor(),
      runId: this.activeRunId(session) ?? undefined,
      payload: payloadRef,
    }, {
      type: 'debug.snapshot.created',
      actor: systemActor(),
      runId: this.activeRunId(session) ?? undefined,
      debugId,
      source,
      queryIndex: session.currentDebugQueryIndex,
      turnIndex,
      payloadRef,
      wire: {
        bytes: envelope.bytes,
        hash: envelope.hash,
      },
      model: debugModelMetadata(model),
    }]);
    session.nextDebugTurnIndex += 1;
    this.debugProjectionCache.delete(sessionId);
  }

  private async captureDebugResponse(sessionId: string, response: ProviderResponse, model: Model<any>) {
    await this.captureDebugPayload(sessionId, {
      status: response.status,
      headers: response.headers,
    }, model, 'provider_response');
  }

  private getRuntimeDebugSnapshot(sessionId: string, session: AgentSessionState) {
    const state = session.agent.state;
    return createRuntimeStateDebugSnapshot({
      messages: state.messages as AgentMessage[],
      model: state.model as Model<any>,
      queryIndex: 0,
      conversationId: conversationIdFromSessionId(sessionId),
      conversationTitle: sanitizeSessionTitle(session.eventState.session?.title),
      systemPrompt: state.systemPrompt,
      thinkingLevel: state.thinkingLevel,
      tools: state.tools,
    });
  }

  private async deriveDebugProjection(sessionId: string): Promise<{
    history: AgentDebugSnapshot[];
    latestSeq: number;
    totals: AgentDebugTotals;
  }> {
    const events = await this.getEventStore().readEvents(sessionId);
    const latestSeq = events.at(-1)?.seq ?? 0;
    const cached = this.debugProjectionCache.get(sessionId);
    if (cached?.latestSeq === latestSeq) return cached;

    const projection = await deriveAgentDebugProjectionFromEvents({
      events,
      readPayload: (payload) => this.getEventStore().readPayload(sessionId, payload),
      conversationId: conversationIdFromSessionId(sessionId),
      conversationTitle: sanitizeSessionTitle(this.sessions.get(sessionId)?.eventState.session?.title),
    });
    this.debugProjectionCache.set(sessionId, projection);
    return projection;
  }

  private async loadDebugCounters(sessionId: string): Promise<{ nextQueryIndex: number; nextTurnIndex: number }> {
    const events = await this.getEventStore().readEvents(sessionId);
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
    sessionId: string,
    session: AgentSessionState,
    options: { flushSubagentNotifications?: boolean } = {},
  ) {
    await this.flushPendingDreamFinishedEvents(sessionId, session);
    session.agent.state.messages = await this.deriveRuntimePiMessages(sessionId, session.eventState) as never;
    this.emitProjection(sessionId, 'agent_idle');
    if (options.flushSubagentNotifications !== false) {
      await this.flushSubagentNotifications(sessionId, session);
    }
  }

  private async flushPendingDreamFinishedEvents(sessionId: string, session: AgentSessionState): Promise<void> {
    while (session.pendingDreamFinishedMarkers.length > 0) {
      const result = session.pendingDreamFinishedMarkers.shift();
      if (!result) continue;
      await this.appendDreamFinishedEvent(sessionId, session, result);
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
        conversationIdFromSessionId(this.commandConversationSessionId(nodeId)),
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
        this.commandConversationSessionId(command.nodeId),
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.firingCommandNodeIds.delete(command.nodeId);
    }
  }

  // One delivery conversation per command node — a stable id derived from the
  // node id so every fire posts into a single thread (find-or-created on each
  // fire; tolerant of the conversation being deleted).
  private commandConversationSessionId(nodeId: string): string {
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
      this.commandConversationSessionId(command.nodeId),
      brief,
      command.commandAgent,
      command.lastSuccessAt,
    );
  }

  // Ensure a command node's delivery conversation EXISTS ON DISK (a `session.created`
  // titled from the brief) and return its id — without materializing an in-memory
  // session. The renderer awaits this, then selects the conversation (which loads
  // the single in-memory session via `restoreConversation`), then runs it. Doing
  // the persist here instead of `ensureSessionWithId` is deliberate: creating an
  // in-memory session here AND again on restore would `abort()` + recreate the
  // session mid-flight, diverging the event seq ("seq N is not after existing M").
  async ensureCommandConversation(nodeId: string): Promise<{ conversationId: string }> {
    const node = this.outlinerToolHost.getProjection().nodes.find((entry) => entry.id === nodeId);
    if (!node || node.type !== 'command') throw new Error('Not a command node.');
    const sessionId = this.commandConversationSessionId(nodeId);
    this.knownCommandConversationNodeIds.add(nodeId);
    // Already live (a prior run/restore) — nothing to persist; restore will reuse it.
    if (!this.sessions.has(sessionId)) {
      const loaded = await this.loadEventState(sessionId);
      if (!loaded.session) {
        const title = commandConversationTitle(node.content.text);
        const eventState = createEmptyAgentEventReplayState();
        const events = this.buildEvents(eventState, sessionId, [{
          type: 'session.created',
          actor: systemActor(),
          title,
          members: this.defaultConversationMembers(),
          goal: title,
        }]);
        await this.getEventStore().appendEvents(sessionId, events);
        this.publishPersistedEvents(sessionId, events);
      }
    }
    return { conversationId: conversationIdFromSessionId(sessionId) };
  }

  // Run now (attended): the same execution path with a `node` trigger and NO
  // watermark advance, so testing a command never disturbs its schedule.
  // Returns the delivery conversation so the caller can surface it.
  async runCommandNow(nodeId: string): Promise<{ conversationId: string }> {
    const projection = this.outlinerToolHost.getProjection();
    const node = projection.nodes.find((entry) => entry.id === nodeId);
    if (!node || node.type !== 'command') throw new Error('Not a command node.');
    const sessionId = this.commandConversationSessionId(nodeId);
    // Coordinate with the scheduled sweep via the same guard set. If a fire (or
    // another Run-now) for this node is already in flight, surface the existing
    // delivery conversation instead of starting a colliding second run — and the
    // sweep, which skips nodes in this set, won't treat the attended run as a
    // schedule failure.
    if (this.firingCommandNodeIds.has(nodeId)) {
      return { conversationId: conversationIdFromSessionId(sessionId) };
    }
    // Build the same brief a scheduled fire does: title + non-field child outline,
    // with inline references reconstructed (see `commandBriefText`).
    const byId = new Map(projection.nodes.map((entry) => [entry.id, entry]));
    const brief = commandBriefText(node, byId).trim();
    if (!brief) throw new Error('This command has no brief to run.');
    this.firingCommandNodeIds.add(nodeId);
    this.knownCommandConversationNodeIds.add(nodeId);
    try {
      await this.runCommandSubagent(sessionId, brief, node.commandAgent, node.sysLastRunAt ?? null);
      return { conversationId: conversationIdFromSessionId(sessionId) };
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
    sessionId: string,
    brief: string,
    agent: string | undefined,
    lastSuccessAt: number | null,
  ): Promise<void> {
    const session = await this.ensureSessionWithId(sessionId, commandConversationTitle(brief));
    await this.refreshRuntimeSettings(session);
    const subagentType = agent?.trim() ? agent.trim() : undefined;
    let data = await session.subagentRuntime.invokeAgent({
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
      data = await session.subagentRuntime.status({
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

  private async runManualDreamFromConversation(sessionId: string) {
    if (!this.dreamMemoryExtractionEnabled()) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const activeDreamId = this.beginDream(sessionId, session);
    const result = await this.fireManualDream(new Date());
    try {
      await this.appendDreamFinishedEvent(sessionId, session, result);
    } finally {
      this.finishDream(sessionId, session, activeDreamId, 'dream.finished');
    }
  }

  private async fireDream(trigger: AgentDreamTrigger, now: Date): Promise<void> {
    // The user-Dream (conversations → user pool) runs once per pass; the agent-Dream
    // (runs → agent pool) runs per agent ([[agent-data-model]] §4). Each pool's Dream is
    // isolated: one pool throwing (e.g. a provider error consolidating the user pool) must not
    // abort the rest of the pass, or a single bad pool would silently starve every other pool's
    // consolidation (review #4). `runDreamMemoryExtractionTask` already records `dream.completed`
    // with a failed status on its own errors; this guard only covers task-creation throws.
    await this.fireDreamPoolSafely(() => this.fireUserDream(trigger, now), 'user');
    const agentIds = trigger === 'schedule'
      ? await this.listDreamAgentIds()
      : [this.agentIdentity.agentId];
    for (const agentId of agentIds) {
      await this.fireDreamPoolSafely(() => this.fireDreamForAgent(agentId, trigger, now), `agent ${agentId}`);
    }
  }

  /** Run one pool's Dream, swallowing+logging a throw so it cannot abort the rest of the pass. */
  private async fireDreamPoolSafely(
    run: () => Promise<AgentDreamRunResult | null>,
    label: string,
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      console.warn(`Dream pass failed for ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async fireDreamForAgent(agentId: string, trigger: AgentDreamTrigger, now: Date): Promise<AgentDreamRunResult | null> {
    if (this.dreamingAgentIds.has(agentId)) {
      return trigger === 'manual'
        ? skippedDreamRunResult(agentId, trigger, now, 'Dream is already running for this agent.')
        : null;
    }
    this.dreamingAgentIds.add(agentId);
    try {
      const task = await this.createDreamMemoryExtractionTask(agentId, trigger, now);
      if (!task) return null;
      return await this.runDreamMemoryExtractionTask(task);
    } finally {
      this.dreamingAgentIds.delete(agentId);
    }
  }

  private async fireUserDream(trigger: AgentDreamTrigger, now: Date): Promise<AgentDreamRunResult | null> {
    const guardKey = principalKey(this.userPrincipal());
    if (this.dreamingAgentIds.has(guardKey)) {
      return trigger === 'manual'
        ? skippedDreamRunResult(this.agentIdentity.agentId, trigger, now, 'The user Dream is already running.')
        : null;
    }
    this.dreamingAgentIds.add(guardKey);
    try {
      const task = await this.createUserDreamMemoryExtractionTask(trigger, now);
      if (!task) return null;
      return await this.runDreamMemoryExtractionTask(task);
    } finally {
      this.dreamingAgentIds.delete(guardKey);
    }
  }

  /**
   * A manual /dream consolidates the current conversation into durable memory. Conversation
   * evidence models the user ([[agent-data-model]] §4), so /dream writes the user pool — the
   * complete conversation-consolidation. Agent self-models (run logs) consolidate on schedule,
   * not on demand. Concurrency is handled by fireUserDream's own per-pool guard.
   */
  private async fireManualDream(now: Date): Promise<AgentDreamRunResult> {
    try {
      return await this.fireUserDream('manual', now)
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

  private async createDreamMemoryExtractionTask(
    agentId: string,
    trigger: AgentDreamTrigger,
    now: Date,
  ): Promise<AgentDreamMemoryExtractionTask | null> {
    if (!this.dreamMemoryExtractionEnabled()) return null;
    const memoryScope = await this.dreamMemoryScope();
    if (memoryScope.readOnly) return null;
    if (!await this.getActiveProviderConfig()) return null;

    const principal: AgentPrincipal = { type: 'agent', agentId };
    const dreamState = await this.getEventStore().readDreamState(principal);
    const scheduleDecision = shouldFireDateSchedule(DEFAULT_DREAM_SCHEDULE, now, dreamState.lastSuccessAt);
    if (trigger === 'schedule' && !scheduleDecision.shouldFire) return null;

    const runId = `dream-run-${randomUUID()}`;
    // The agent-Dream models the agent's working self from its run log (execution).
    // Conversation evidence (communication) is the user-Dream's input, not the agent's
    // ([[agent-data-model]] §4: one writer, one subject, one activity layer each).
    const conversationIds = await this.getEventStore().listConversationIds();
    const agentRunInputs = await this.collectDreamAgentRunInputs(agentId, dreamState.watermark, conversationIds);
    const evidenceSpan = buildDreamMemoryExtractionSpanFromEvidence(runId, {
      conversations: [],
      agentRuns: agentRunInputs,
    });
    const newVolume = evidenceSpan?.totalCharCount ?? 0;
    if (trigger === 'schedule' && newVolume < DREAM_MIN_VOLUME_CHARS) return null;

    const span = evidenceSpan ?? (trigger === 'manual'
      ? buildConsolidateOnlyDreamMemoryExtractionSpan(runId)
      : null);
    if (!span) return null;
    const batches = evidenceSpan
      ? this.buildDreamMemoryExtractionBatches(runId, memoryScope, {
          conversations: [],
          agentRuns: agentRunInputs,
        })
      : [{
          span,
          originWorkspace: memoryScope.originWorkspace,
          originWorkspaceFilter: memoryScope.originWorkspaceFilter,
        }];
    if (batches.length === 0) return null;

    return {
      runId,
      agentId,
      principal,
      trigger,
      startedAt: Date.now(),
      dueAt: scheduleDecision.dueAt?.getTime(),
      span,
      batches,
      watermark: dreamWatermarkFromSpan(dreamState.watermark, span.sourceRanges),
    };
  }

  /**
   * The user-Dream models the person from the conversations they are a member of
   * (communication, both sides) and writes only the user pool ([[agent-data-model]] §4).
   * It is the single writer of the user pool; the main agent is its executor, so the
   * task's `agentId` (run-meta anchor) is the main agent while `principal` is the user.
   * Concurrent passes are safe: the store serializes by principalKey and the watermark
   * skips already-consolidated evidence.
   */
  private async createUserDreamMemoryExtractionTask(
    trigger: AgentDreamTrigger,
    now: Date,
  ): Promise<AgentDreamMemoryExtractionTask | null> {
    if (!this.dreamMemoryExtractionEnabled()) return null;
    const memoryScope = await this.dreamMemoryScope();
    if (memoryScope.readOnly) return null;
    if (!await this.getActiveProviderConfig()) return null;

    const principal = this.userPrincipal();
    const dreamState = await this.getEventStore().readDreamState(principal);
    const scheduleDecision = shouldFireDateSchedule(DEFAULT_DREAM_SCHEDULE, now, dreamState.lastSuccessAt);
    if (trigger === 'schedule' && !scheduleDecision.shouldFire) return null;

    const runId = `dream-run-${randomUUID()}`;
    const conversationIds = await this.userMemberConversationIds();
    const conversationInputs = await Promise.all(conversationIds.map(async (conversationId) => ({
      conversationId,
      events: await this.getEventStore().readEvents(conversationId),
      fromSeqExclusive: dreamState.watermark.conversations[conversationId]?.seq ?? 0,
    })));
    const evidenceSpan = buildDreamMemoryExtractionSpanFromEvidence(runId, {
      conversations: conversationInputs,
      agentRuns: [],
    });
    const newVolume = evidenceSpan?.totalCharCount ?? 0;
    if (trigger === 'schedule' && newVolume < DREAM_MIN_VOLUME_CHARS) return null;

    const span = evidenceSpan ?? (trigger === 'manual'
      ? buildConsolidateOnlyDreamMemoryExtractionSpan(runId)
      : null);
    if (!span) return null;
    const batches = evidenceSpan
      ? this.buildDreamMemoryExtractionBatches(runId, memoryScope, {
          conversations: conversationInputs,
          agentRuns: [],
        })
      : [{
          span,
          originWorkspace: memoryScope.originWorkspace,
          originWorkspaceFilter: memoryScope.originWorkspaceFilter,
        }];
    if (batches.length === 0) return null;

    return {
      runId,
      agentId: this.agentIdentity.agentId,
      principal,
      trigger,
      startedAt: Date.now(),
      dueAt: scheduleDecision.dueAt?.getTime(),
      span,
      batches,
      watermark: dreamWatermarkFromSpan(dreamState.watermark, span.sourceRanges),
    };
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
   * pool ([[agent-data-model]] §4 visibility = membership). A null session or one with no
   * membership info defaults to true (the single-user main-agent case); a sidechain whose members
   * exclude the user (e.g. an agent-only subagent context) does not receive the user pool.
   */
  private conversationIncludesUser(session: AgentSessionState | null): boolean {
    const members = session?.eventState.session?.members;
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
        originWorkspaceFilter: memoryScope.originWorkspaceFilter,
      });
    }

    for (const group of groupDreamAgentRunInputsByOriginWorkspace(inputs.agentRuns)) {
      const span = buildDreamMemoryExtractionSpanFromEvidence(runId, {
        conversations: [],
        agentRuns: group.inputs,
      });
      if (!span) continue;
      batches.push({
        span,
        originWorkspace: group.originWorkspace ?? memoryScope.originWorkspace,
        originWorkspaceFilter: group.originWorkspace ?? memoryScope.originWorkspaceFilter,
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
        const evidenceStart = subagentDreamEvidenceStartMessageIndex({
          contextMode: run.contextMode,
          dreamEvidenceStartMessageIndex: run.dreamEvidenceStartMessageIndex ?? envelope.dreamEvidenceStartMessageIndex,
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
          agentId: task.agentId,
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
        const existingMemories = await this.getEventStore().listMemoryEntries(task.principal, {
          limit: 50,
          originWorkspace: batch.originWorkspaceFilter,
        });
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
          sessionId: `${task.agentId}:dream:${task.runId}:${index + 1}`,
        });
        if (response.stopReason === 'error' || response.stopReason === 'aborted') {
          throw new Error(response.errorMessage || 'Dream memory extraction failed.');
        }
        const actions = parseDreamMemoryActions(assistantMessageText(response));
        const currentMemories = await this.getEventStore().listMemoryEntries(task.principal, {
          limit: 50,
          originWorkspace: batch.originWorkspaceFilter,
        });
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
        agentId: task.agentId,
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
        agentId: task.agentId,
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
    const agentId = task.agentId as AgentRunMetaProjection['agentId'];
    await this.getEventStore().writeRunMeta({
      v: 1,
      id: task.runId,
      agentId,
      anchor: { type: 'agent', agentId },
      kind: 'reflective',
      status,
      trigger: task.trigger === 'schedule'
        ? { type: 'schedule', schedule: DEFAULT_DREAM_SCHEDULE, dueAt: task.dueAt }
        : { type: 'manual' },
      fingerprint: {
        appVersion: electronAppVersion(),
        promptHash: hashJson({
          agentId: task.agentId,
          dream: 'memory',
          systemPrompt: this.agentIdentity.systemPrompt,
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
    const agentIds = await this.listDreamAgentIds();
    // A Dream's completion record lives in the pool it wrote (agent pools and the user pool),
    // but its run-meta is anchored to the executing agent. Index completions by runId across all
    // pools so a user-Dream run (anchored to the main agent) is enriched from the user pool.
    const dreamStates = await Promise.all([
      ...agentIds.map((agentId) => store.readDreamState({ type: 'agent', agentId })),
      store.readDreamState(this.userPrincipal()),
    ]);
    const lastCompletedByRunId = new Map<string, NonNullable<AgentDreamState['lastCompleted']>>();
    for (const state of dreamStates) {
      if (state.lastCompleted) lastCompletedByRunId.set(state.lastCompleted.runId, state.lastCompleted);
    }
    const runGroups = await Promise.all(agentIds.map((agentId) => (
      store.listAgentRunMetaProjections(agentId as AgentRunMetaProjection['agentId'], { limit: 50 })
    )));
    this.agentTaskCache = runGroups
      .flatMap((runs): AgentRenderTaskEntity[] => (
        runs.flatMap((run): AgentRenderTaskEntity[] => {
          const task = dreamTaskFromRunMeta(run, lastCompletedByRunId.get(run.id) ?? null);
          return task ? [task] : [];
        })
      ))
      .sort(compareRenderTasks);
  }

  private emitAgentTaskProjection(lastEventType: string) {
    for (const sessionId of this.sessions.keys()) {
      this.emitProjection(sessionId, lastEventType, 'coalesce');
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

  private reserveSessionId(sessionId: string) {
    const match = /^lin-agent-(\d+)$/.exec(sessionId);
    if (!match) return;
    const numericId = Number(match[1]);
    if (Number.isInteger(numericId) && numericId >= this.nextSessionId) {
      this.nextSessionId = numericId + 1;
    }
  }

  private createSessionId() {
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

  private isDefaultDmSessionId(sessionId: string) {
    return sessionId === this.defaultDmConversationId();
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

  private activeRunId(session: AgentSessionState): string | null {
    return session.activeRun?.id ?? null;
  }

  private requireActiveRun(session: AgentSessionState): AgentActiveRunState {
    if (!session.activeRun) throw new Error('Agent run state is not active.');
    return session.activeRun;
  }

  private currentAgentIdentity(model: Model<Api> | null): AgentIdentityRecord {
    return {
      ...this.agentIdentity,
      model: model?.id ?? this.agentIdentity.model,
    };
  }

  private runTrigger(session: AgentSessionState): AgentRunTrigger {
    const messageId = session.eventState.selectedLeafMessageId ?? session.eventState.latestMessageId;
    return messageId ? { type: 'message', messageId } : { type: 'manual' };
  }

  private runFingerprint(session: AgentSessionState): AgentRunFingerprint {
    return {
      appVersion: electronAppVersion(),
      promptHash: hashJson({
        agentId: this.agentIdentity.agentId,
        systemPrompt: this.agentIdentity.systemPrompt,
      }),
      toolSchemaHash: 'runtime-tools',
      skillBindings: [],
      modelConfig: hashJson({
        model: session.agent.state.model.id,
        provider: session.agent.state.model.provider,
        thinkingLevel: session.agent.state.thinkingLevel,
      }),
    };
  }

  private conversationResponse(sessionId: string, session: AgentSessionState) {
    return {
      conversationId: conversationIdFromSessionId(sessionId),
      renderProjection: this.renderProjection(session),
      pendingUserQuestion: this.pendingUserQuestionView(sessionId, session),
    };
  }

  private renderProjection(session: AgentSessionState) {
    const projection = buildAgentRenderProjection(session.eventState, {
      revision: session.revision,
      activeRunId: this.activeRunId(session),
      activeCompaction: session.activeCompaction,
      activeDream: session.activeDream,
      isStreaming: session.agent.state.isStreaming,
      model: clone(session.agent.state.model) as unknown as Record<string, unknown>,
      thinkingLevel: session.agent.state.thinkingLevel,
      pendingToolCallIds: Array.from(session.agent.state.pendingToolCalls),
      // Run/provider failures render inline as a failed assistant message (see
      // appendAssistantCompleted). The top-level banner is reserved for transient
      // operational errors delivered via the `error` event.
      errorMessage: null,
      agentTasks: this.agentTaskCache,
    });
    return {
      ...projection,
      conversationTitle: sanitizeSessionTitle(projection.conversationTitle),
    };
  }

  private beginCompaction(
    sessionId: string,
    session: AgentSessionState,
    trigger: AgentCompactionTrigger,
  ): string {
    const activeCompaction = {
      id: randomUUID(),
      trigger,
      startedAt: Date.now(),
    };
    session.activeCompaction = activeCompaction;
    this.emitProjection(sessionId, 'compaction.started');
    return activeCompaction.id;
  }

  private finishCompaction(
    sessionId: string,
    session: AgentSessionState,
    compactionId: string,
    lastEventType: string,
  ) {
    if (session.activeCompaction?.id === compactionId) {
      session.activeCompaction = null;
    }
    this.emitProjection(sessionId, lastEventType);
  }

  private beginDream(sessionId: string, session: AgentSessionState): string {
    const activeDream = {
      id: randomUUID(),
      trigger: 'manual' as const,
      startedAt: Date.now(),
    };
    session.activeDream = activeDream;
    this.emitProjection(sessionId, 'dream.started');
    return activeDream.id;
  }

  private finishDream(
    sessionId: string,
    session: AgentSessionState,
    dreamId: string,
    lastEventType: string,
  ) {
    if (session.activeDream?.id === dreamId) {
      session.activeDream = null;
    }
    this.emitProjection(sessionId, lastEventType);
  }

  private emitProjection(
    sessionId: string,
    lastEventType: string | null = null,
    mode: 'immediate' | 'coalesce' = 'immediate',
  ) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (mode === 'coalesce') {
      session.pendingProjectionLastEventType = lastEventType;
      if (session.pendingProjectionTimer) return;
      session.pendingProjectionTimer = setTimeout(() => {
        session.pendingProjectionTimer = null;
        const pendingEventType = session.pendingProjectionLastEventType;
        session.pendingProjectionLastEventType = null;
        this.emitProjectionNow(sessionId, pendingEventType);
      }, 16);
      return;
    }
    clearPendingProjection(session);
    this.emitProjectionNow(sessionId, lastEventType);
  }

  private emitProjectionNow(sessionId: string, lastEventType: string | null = null) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.revision += 1;
    const renderProjection = this.renderProjection(session);
    const timestamp = Date.now();
    this.domainEvents.publish({
      lane: 'renderer-projection',
      name: 'RendererProjectionUpdated',
      sessionId,
      lastEventType,
      revision: session.revision,
      projection: renderProjection,
      createdAt: timestamp,
    });
  }

  private publishPersistedEvents(sessionId: string, events: readonly AgentEvent[]) {
    for (const event of events) {
      this.domainEvents.publish({
        lane: 'persisted-log',
        name: 'PersistedLogEvent',
        sessionId,
        runId: event.runId,
        event,
        createdAt: event.createdAt,
      });
    }
  }

  private emitError(sessionId: string, message: string) {
    this.emitConversationRuntimeEvent(sessionId, {
      type: 'error',
      error: message,
    });
  }

  /**
   * Push the conversation's folded unread count to the renderer's conversation
   * list. Threaded independently of the active-conversation projection so badges
   * on other conversations update too.
   */
  private emitConversationAttention(sessionId: string, session: AgentSessionState) {
    const conversationId = conversationIdFromSessionId(sessionId);
    const attention = session.eventState.attentionByConversationId[conversationId];
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

  private emitConversationRuntimeEvent(sessionId: string, input: PublicConversationRuntimeEventInput) {
    const conversationId = conversationIdFromSessionId(sessionId);
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
    _getSessionId: () => string,
    getSession: () => AgentSessionState | null,
    originWorkspace?: string,
  ): AgentRecallToolRuntime {
    const reader: AgentPrincipal = { type: 'agent', agentId };
    return {
      recall: async (options) => {
        const session = getSession();
        const filter = this.memoryOriginWorkspaceFilter(session, originWorkspace);
        const limit = clampRecallLimit(options.limit);
        // Cross-principal read by membership ([[agent-data-model]] §4): the reader searches its
        // own pool and — only when the user is a member of its conversation — the shared user
        // pool. The user pool is workspace-independent (it is the user's model, not a per-workspace
        // fact), so it is exempt from the reader's `isolated`-mode workspace filter.
        const ownResult = await this.getEventStore().queryMemoryEntries(reader, {
          query: options.query, limit, originWorkspace: filter,
        });
        const userResult = this.conversationIncludesUser(session)
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
    getSessionId: () => string,
    getSession: () => AgentSessionState | null,
  ): AgentAskUserQuestionRuntime {
    return {
      ask: (toolCallId, request, signal) => {
        const session = getSession();
        if (!session) throw new Error('Agent session is not ready.');
        return this.askUserQuestion(getSessionId(), session, toolCallId, request, signal);
      },
    };
  }

  private createSelfMaintenanceRuntime(
    getSessionId: () => string,
    getSession: () => AgentSessionState | null,
  ): AgentSelfMaintenanceRuntime {
    return {
      runtimeStatus: async () => {
        const providerConfig = await this.getActiveProviderConfig();
        return {
          agentId: this.agentIdentity.agentId,
          conversationId: conversationIdFromSessionId(getSessionId()),
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
        const session = getSession();
        if (!session) throw new Error('Agent session is not ready.');
        const before = readRuntimeSetting(await this.getRuntimeSettings(), setting);
        const patch = normalizeRuntimeSettingPatch(setting, value);
        await updateAgentRuntimeSettings(patch);
        const runtimeSettings = await this.refreshRuntimeSettings(session);
        const after = readRuntimeSetting(runtimeSettings, setting);
        await this.appendSessionEvents(getSessionId(), session, [{
          type: 'config.change',
          actor: this.agentActor(),
          runId: this.activeRunId(session) ?? undefined,
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
        getSession()?.pendingDreamFinishedMarkers.push(result);
        return dreamToolDataFromRunResult(result);
      },
    };
  }

  private async askUserQuestion(
    sessionId: string,
    session: AgentSessionState,
    toolCallId: string,
    request: AgentUserQuestionRequestView,
    signal?: AbortSignal,
  ): Promise<AskUserQuestionResult> {
    const runId = this.activeRunId(session);
    if (!runId) throw new Error('Cannot ask the user a question outside an active run.');
    if ([...this.pendingUserQuestions.values()].some((pending) => pending.sessionId === sessionId && pending.runId === runId)) {
      throw new Error('A user question is already pending for this run.');
    }

    const requestId = `question-${randomUUID()}`;
    await this.appendSessionEvents(sessionId, session, [{
      type: 'user_question.requested',
      actor: this.agentActor(),
      runId,
      requestId,
      toolCallId,
      request,
    }]);

    return new Promise<AskUserQuestionResult>((resolve, reject) => {
      const pending: AgentPendingUserQuestion = {
        sessionId,
        runId,
        toolCallId,
        requestId,
        request,
        resolve,
        reject,
      };
      this.pendingUserQuestions.set(requestId, pending);
      this.emitConversationRuntimeEvent(sessionId, {
        type: 'user_question_request',
        requestId,
        question: this.userQuestionView(sessionId, pending),
      });
      this.emitProjection(sessionId, 'user_question.requested');
      const abort = () => {
        void this.cancelUserQuestion(requestId, 'aborted')
          .catch((error) => this.emitError(sessionId, error instanceof Error ? error.message : String(error)));
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
    const sessionId = sessionIdFromConversationId(conversationId);
    const session = await this.ensureSessionWithId(sessionId);
    const pending = this.pendingUserQuestions.get(requestId) ?? this.pendingUserQuestionFromReplay(sessionId, session, requestId);
    if (!pending || pending.sessionId !== sessionId) return { resolved: false };
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
    if (!pending.resolve) events.push(this.replayedUserQuestionToolResultInput(session, pending, result));
    await this.appendSessionEvents(sessionId, session, events);
    this.pendingUserQuestions.delete(requestId);
    this.emitConversationRuntimeEvent(sessionId, {
      type: 'user_question_resolved',
      requestId,
      result,
    });
    this.emitProjection(sessionId, 'user_question.answered');
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
    session: AgentSessionState,
    pending: AgentPendingUserQuestion,
    result: AskUserQuestionResult,
  ): AgentEventInput {
    const parentMessage = getAgentEventActivePath(session.eventState)
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
    const session = this.sessions.get(pending.sessionId);
    if (session) {
      await this.appendSessionEvents(pending.sessionId, session, [{
        type: 'user_question.cancelled',
        actor: systemActor(),
        runId: pending.runId,
        requestId,
        reason,
      }]);
      this.emitProjection(pending.sessionId, 'user_question.cancelled');
    }
    this.emitConversationRuntimeEvent(pending.sessionId, {
      type: 'user_question_resolved',
      requestId,
    });
    pending.reject?.(new Error(`User question cancelled: ${reason}`));
  }

  private pendingUserQuestionView(
    sessionId: string,
    session: AgentSessionState,
  ): AgentUserQuestionPendingView | null {
    const live = [...this.pendingUserQuestions.values()].find((pending) => pending.sessionId === sessionId);
    if (live) return this.userQuestionView(sessionId, live);
    const replayed = Object.values(session.eventState.userQuestions)
      .filter((question) => question.status === 'pending')
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    return replayed ? this.userQuestionView(sessionId, {
      sessionId,
      runId: replayed.runId,
      toolCallId: replayed.toolCallId,
      requestId: replayed.requestId,
      request: replayed.request,
    }) : null;
  }

  private pendingUserQuestionFromReplay(
    sessionId: string,
    session: AgentSessionState,
    requestId: string,
  ): AgentPendingUserQuestion | null {
    const record = session.eventState.userQuestions[requestId];
    if (!record || record.status !== 'pending') return null;
    return {
      sessionId,
      runId: record.runId,
      toolCallId: record.toolCallId,
      requestId,
      request: record.request,
    };
  }

  private userQuestionView(
    sessionId: string,
    pending: AgentPendingUserQuestion,
  ): AgentUserQuestionPendingView {
    return {
      requestId: pending.requestId,
      conversationId: conversationIdFromSessionId(sessionId),
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
    const isolation = runtimeSettings.memoryIsolation ?? 'global';
    if (isolation === 'read-only-global') return { readOnly: true };
    if (isolation === 'isolated') {
      const originWorkspace = this.memoryOriginWorkspace() ?? '__no_workspace__';
      return { readOnly: false, originWorkspace, originWorkspaceFilter: originWorkspace };
    }
    return {
      readOnly: false,
      originWorkspace: this.memoryOriginWorkspace() ?? undefined,
    };
  }

  private async buildMemoryReminder(
    agentId: string,
    session: AgentSessionState | null,
    originWorkspace?: string,
  ): Promise<string | null> {
    try {
      const reader: AgentPrincipal = { type: 'agent', agentId };
      const originWorkspaceFilter = this.memoryOriginWorkspaceFilter(session, originWorkspace);
      // Resident selection: the briefing is the distilled-memory prefix ([[agent-memory-model]]
      // §2), so it lists recent active entries rather than query-specific hits — those arrive
      // on demand through the `recall` tool ([5] tail). Keeping selection query-independent
      // keeps the briefing stable turn-over-turn (cache-friendly); a mid-session Dream write
      // surfaces through recall until the next turn folds it into the briefing.
      //
      // Membership read ([[agent-data-model]] §4): the reader sees its own pool (`<self>`) plus
      // the co-member user pool (`<principal>`) when the user is a member of its conversation.
      // The user pool is workspace-independent (the user's model, not per-workspace facts), so it
      // is exempt from the reader's `isolated`-mode workspace filter. Agent↔agent co-member pools
      // are deferred (fork 1).
      const [selfEntries, userEntries] = await Promise.all([
        this.getEventStore().listMemoryEntries(reader, {
          limit: MEMORY_BRIEFING_MAX_ENTRIES,
          originWorkspace: originWorkspaceFilter,
        }),
        this.conversationIncludesUser(session)
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
    for (const session of this.sessions.values()) {
      session.subagentRuntime.clearMemoryReminderCache();
    }
  }

  private memoryIsolation(session: AgentSessionState): AgentRuntimeSettings['memoryIsolation'] {
    return session.runtimeSettings.memoryIsolation ?? 'global';
  }

  private memoryOriginWorkspaceFilter(session: AgentSessionState | null, originWorkspace?: string): string | undefined {
    if (!session || this.memoryIsolation(session) !== 'isolated') return undefined;
    return originWorkspace ?? this.memoryOriginWorkspaceForSession(session);
  }

  private memoryOriginWorkspaceForSession(session: AgentSessionState): string | undefined {
    if (this.memoryIsolation(session) === 'global') return this.memoryOriginWorkspace() ?? undefined;
    return this.memoryOriginWorkspace() ?? '__no_workspace__';
  }

  private memoryOriginWorkspace(): string | undefined {
    return memoryWorkspaceIdForRoot(this.options.localFileRoot);
  }

  private getActiveProviderConfig() {
    return this.options.providerConfigLoader?.() ?? getActiveProviderRuntimeConfig();
  }

  private getRuntimeSettings() {
    return this.options.runtimeSettingsLoader?.() ?? getAgentRuntimeSettings();
  }

  private cleanupProviderSessionResources(sessionId: string) {
    try {
      cleanupPiSessionResources(sessionId);
    } catch (error) {
      this.emitError(sessionId, error instanceof Error ? error.message : String(error));
    }
  }

  private getProviderApiKey(providerId: string) {
    return this.options.providerApiKeyLoader?.(providerId) ?? getProviderApiKey(providerId);
  }

  private resolveProviderModel(providerConfig: AgentProviderRuntimeConfig) {
    return this.options.providerModelResolver?.(providerConfig) ?? resolveModel(providerConfig);
  }

  private async loadEventState(sessionId: string): Promise<AgentEventReplayState> {
    return this.getEventStore().replay(sessionId);
  }

  private buildEvents(
    eventState: AgentEventReplayState,
    sessionId: string,
    inputs: readonly AgentEventInput[],
  ): AgentEvent[] {
    let seq = eventState.latestSeq;
    return inputs.map((input) => {
      const { createdAt, ...rest } = input;
      return {
        v: AGENT_EVENT_VERSION,
        eventId: randomUUID(),
        seq: ++seq,
        sessionId,
        createdAt: createdAt ?? Date.now(),
        ...rest,
      } as AgentEvent;
    });
  }

  private async appendSessionEvents(
    sessionId: string,
    session: AgentSessionState,
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
      const resolved = typeof inputs === 'function' ? inputs(session.eventState) : inputs;
      if (resolved.length === 0) {
        events = [];
        return;
      }
      events = this.buildEvents(session.eventState, sessionId, resolved);
      await this.getEventStore().appendEvents(sessionId, events);
      for (const event of events) appendAgentEventToReplayState(session.eventState, event);
      this.publishPersistedEvents(sessionId, events);
    };
    const operation = session.pendingEventAppend.then(writeEvents, writeEvents);
    session.pendingEventAppend = operation.then(() => undefined, () => undefined);
    await operation;
    return events;
  }

  private async requestToolApproval(
    sessionId: string,
    session: AgentSessionState,
    input: AgentToolApprovalInput,
    signal?: AbortSignal,
  ): Promise<AgentToolApprovalResolution> {
    if (signal?.aborted) return { approved: false, deniedReason: 'run_aborted' };

    const requestId = input.requestId;
    const request: AgentApprovalRequestView = {
      requestId,
      conversationId: conversationIdFromSessionId(sessionId),
      toolCallId: input.toolCall.id,
      toolName: input.toolCall.name,
      title: input.decision.request.title,
      target: input.decision.request.target,
      reason: input.decision.reason,
      details: input.decision.request.details,
      alwaysAllowRule: input.decision.request.alwaysAllowRule,
    };
    const payload = await this.getEventStore().writePayload(sessionId, {
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
      runId: this.activeRunId(session) ?? undefined,
      role: 'approval',
      summary: request.title,
    });

    await this.appendSessionEvents(sessionId, session, [{
      type: 'payload.created',
      actor: systemActor(),
      runId: this.activeRunId(session) ?? undefined,
      payload,
    }, {
      type: 'approval.requested',
      actor: systemActor(),
      runId: this.activeRunId(session) ?? undefined,
      requestId,
      summary: `${request.title} ${request.target}`.trim(),
      payloadRef: payload,
    }]);

    this.emitConversationRuntimeEvent(sessionId, {
      type: 'approval_request',
      requestId,
      request,
    });
    this.emitProjection(sessionId, 'approval.requested');

    return new Promise<AgentToolApprovalResolution>((resolve) => {
      const onAbort = () => {
        const pending = this.pendingApprovals.get(requestId);
        if (!pending) return;
        this.pendingApprovals.delete(requestId);
        signal?.removeEventListener('abort', onAbort);
        void this.appendSessionEvents(sessionId, session, [{
          type: 'approval.resolved',
          actor: systemActor(),
          runId: this.activeRunId(session) ?? undefined,
          requestId,
          approved: false,
        }]).catch((error) => this.emitError(sessionId, error instanceof Error ? error.message : String(error)));
        this.emitConversationRuntimeEvent(sessionId, {
          type: 'approval_resolved',
          requestId,
          approved: false,
        });
        resolve({ approved: false, deniedReason: 'run_aborted' });
      };

      this.pendingApprovals.set(requestId, {
        sessionId,
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
    sessionId: string,
    session: AgentSessionState,
    input: AgentToolPermissionLogInput,
  ) {
    const source = input.source ?? permissionEventSourceForDecision(input.decision);
    const actionKinds = permissionActionKinds(input.decision);
    const events: AgentEventInput[] = input.includeChecked === false ? [] : [{
      type: 'tool.permission.checked',
      actor: systemActor(),
      runId: this.activeRunId(session) ?? undefined,
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
        runId: this.activeRunId(session) ?? undefined,
        requestId: input.requestId,
        toolCallId: input.toolCall.id,
        toolName: input.toolCall.name,
        status: input.resolved.status,
        resolvedBy: input.resolved.resolvedBy,
        updatedRule: input.resolved.updatedRule,
        deniedReason: input.resolved.deniedReason,
      });
    }
    await this.appendSessionEvents(sessionId, session, events);
  }

  private async appendUserPromptEvent(sessionId: string, session: AgentSessionState, prompt: UserMessage) {
    const messageId = this.createMessageId('user');
    const persisted = await this.persistPiUserContent(sessionId, prompt.content, {
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
        parentMessageId: session.eventState.selectedLeafMessageId,
        content: persisted.content,
        attachments: persisted.payloads.length > 0 ? persisted.payloads : undefined,
      },
      {
        type: 'branch.selected',
        actor: systemActor(),
        leafMessageId: messageId,
      },
    ];

    const title = deriveTitleFromPersistedContent(persisted.content);
    if (title && (!session.eventState.session?.title || session.eventState.session.title === 'Untitled')) {
      inputs.push({
        type: 'session.renamed',
        actor: systemActor(),
        title,
      });
    }

    await this.appendSessionEvents(sessionId, session, inputs);
  }

  private async appendSystemPromptEvent(sessionId: string, session: AgentSessionState, prompt: UserMessage) {
    const messageId = this.createMessageId('user');
    const persisted = await this.persistPiUserContent(sessionId, prompt.content, {
      imageSummary: 'System notification attachment',
    });
    const actor = systemActor();
    await this.appendSessionEvents(sessionId, session, [
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
        parentMessageId: session.eventState.selectedLeafMessageId,
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
    sessionId: string,
    session: AgentSessionState,
    prompt: UserMessage,
    summary: string,
    source: AgentCompactionSourceRange,
    trigger: 'manual' | 'auto' | 'reactive',
    preservedMessages: readonly AgentMessage[] = [],
  ) {
    const messageId = this.createMessageId('user');
    const persisted = await this.persistPiUserContent(sessionId, prompt.content, {
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
      const clone = await this.buildPreservedMessageEvents(sessionId, message, leafMessageId);
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

    await this.appendSessionEvents(sessionId, session, inputs);
  }

  private async appendDreamFinishedEvent(
    sessionId: string,
    session: AgentSessionState,
    result: AgentDreamRunResult,
  ) {
    const messageId = this.createMessageId('user');
    const timestamp = result.completedAt;
    const reminder = systemReminder([
      `Memory Dream ${result.status}.`,
      result.runId ? `Run id: ${result.runId}.` : null,
      result.errorMessage ? `Error: ${result.errorMessage}` : null,
    ].filter(Boolean).join('\n'));
    await this.appendSessionEvents(sessionId, session, [
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
        parentMessageId: session.eventState.selectedLeafMessageId,
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
    sessionId: string,
    message: AgentMessage,
    parentMessageId: string,
  ): Promise<{ messageId: string; inputs: AgentEventInput[] }> {
    if (message.role === 'assistant') {
      const messageId = this.createMessageId('assistant');
      const runId = randomUUID();
      return {
        messageId,
        inputs: [
          {
            type: 'assistant_message.started',
            actor: this.agentActor(),
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
            actor: this.agentActor(),
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
      const persisted = await this.persistPiUserContent(sessionId, message.content, {
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
    const persisted = await this.persistPiUserContent(sessionId, message.content, {
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

  private async startRun(
    sessionId: string,
    session: AgentSessionState,
    prompt: UserMessage | null = null,
    triggerOverride: AgentRunTrigger | null = null,
  ) {
    const runId = randomUUID();
    const runState: AgentActiveRunState = {
      id: runId,
      assistantMessageId: null,
      assistantText: '',
      lastSubmittedUserPrompt: prompt,
      toolOutputPayloads: new Map(),
      toolCallMessageIds: new Map(),
    };
    session.activeRun = runState;
    session.lastRun = null;
    await this.appendSessionEvents(sessionId, session, [{
      type: 'run.started',
      actor: systemActor(),
      runId,
      agentId: this.agentIdentity.agentId,
      anchor: { type: 'conversation', agentId: this.agentIdentity.agentId, conversationId: sessionId },
      kind: 'turn',
      trigger: triggerOverride ?? this.runTrigger(session),
      fingerprint: this.runFingerprint(session),
      retention: 'hot',
    }]);
  }

  private async compactSession(sessionId: string, session: AgentSessionState, customInstructions?: string) {
    try {
      await this.contextManager.compactSession(sessionId, session, {
        trigger: 'manual',
        customInstructions,
        updateAgentState: true,
      });
      session.skillRuntime.resetRunPermissionRules();
    } finally {
      session.currentDebugQueryIndex = 0;
    }
  }

  private async handlePiAgentEvent(sessionId: string, session: AgentSessionState, event: PiAgentEvent) {
    if (event.type === 'message_start' || event.type === 'message_update') {
      if (isAssistantMessage(event.message)) {
        await this.ensureAssistantStarted(sessionId, session, event.message);
        await this.appendAssistantDelta(sessionId, session, event.message);
      }
      return;
    }

    if (event.type === 'message_end') {
      if (isUserMessage(event.message)) {
        if (!isDuplicateTailUserMessage(session.eventState, event.message)) {
          await this.appendUserPromptEvent(sessionId, session, event.message);
        }
        session.queuedFollowUpSkillListingReservation = null;
        return;
      }
      if (isAssistantMessage(event.message)) {
        await this.ensureAssistantStarted(sessionId, session, event.message);
        await this.appendToolCallEventsFromAssistant(sessionId, session, event.message);
        await this.appendAssistantCompleted(sessionId, session, event.message);
        return;
      }
      if (isToolResultMessage(event.message)) {
        await this.appendToolResultMessage(sessionId, session, event.message);
      }
      return;
    }

    if (event.type === 'tool_execution_start') {
      await this.appendToolExecutionStart(sessionId, session, event.toolCallId, event.toolName, event.args);
      return;
    }

    if (event.type === 'tool_execution_end') {
      await this.appendToolExecutionEnd(sessionId, session, event.toolCallId, event.toolName, event.result, event.isError);
      return;
    }

    if (event.type === 'agent_end' && session.activeRun) {
      const activeRun = session.activeRun;
      const errorMessage = session.agent.state.errorMessage ?? null;
      const terminalAssistant = [...event.messages].reverse().find(isAssistantMessage);
      const cancelled = terminalAssistant?.stopReason === 'aborted';
      const contextOverflow = terminalAssistant
        ? isContextOverflow(terminalAssistant, session.agent.state.model.contextWindow)
        : false;
      await this.appendSessionEvents(sessionId, session, [{
        type: cancelled ? 'run.cancelled' : errorMessage ? 'run.failed' : 'run.completed',
        actor: systemActor(),
        runId: activeRun.id,
        errorMessage: cancelled ? undefined : errorMessage ?? undefined,
        usage: sumRunUsage(session.eventState, activeRun.id),
      }]);
      session.reactiveCompactRequested = Boolean(!cancelled && contextOverflow);
      if (!session.reactiveCompactRequested) activeRun.lastSubmittedUserPrompt = null;
      session.lastRun = activeRun;
      session.activeRun = null;
      session.skillRuntime.resetRunPermissionRules();
      await this.getEventStore().maybeWriteCheckpoint(sessionId, session.eventState, { force: true });
    }
  }

  private async ensureAssistantStarted(sessionId: string, session: AgentSessionState, message: AssistantMessage) {
    const activeRun = session.activeRun;
    if (!activeRun || activeRun.assistantMessageId) return;
    const messageId = this.createMessageId('assistant');
    activeRun.assistantMessageId = messageId;
    activeRun.assistantText = '';
    await this.appendSessionEvents(sessionId, session, [{
      type: 'assistant_message.started',
      actor: this.agentActor(),
      runId: this.activeRunId(session) ?? randomUUID(),
      messageId,
      parentMessageId: session.eventState.selectedLeafMessageId,
      providerId: message.provider,
      modelId: message.model,
      apiId: message.api,
    }]);
  }

  private async appendAssistantDelta(sessionId: string, session: AgentSessionState, message: AssistantMessage) {
    const activeRun = session.activeRun;
    const messageId = activeRun?.assistantMessageId;
    if (!messageId) return;
    const nextText = assistantText(message);
    if (!nextText.startsWith(activeRun.assistantText) || nextText.length <= activeRun.assistantText.length) return;
    const delta = nextText.slice(activeRun.assistantText.length);
    activeRun.assistantText = nextText;
    await this.appendSessionEvents(sessionId, session, [{
      type: 'assistant_message.delta',
      actor: this.agentActor(),
      runId: this.activeRunId(session) ?? undefined,
      messageId,
      delta: { type: 'text_delta', text: delta },
      providerChunkCount: 1,
      startedAt: Date.now(),
      endedAt: Date.now(),
    }]);
  }

  private async appendAssistantCompleted(sessionId: string, session: AgentSessionState, message: AssistantMessage) {
    const activeRun = session.activeRun;
    const messageId = activeRun?.assistantMessageId;
    if (!messageId) return;
    // A provider/run failure surfaces as a terminal assistant message with an
    // error stop reason (pi-agent-core synthesizes it). Carry that error onto the
    // message record so the turn renders inline as a failed message (with retry),
    // rather than a separate top banner. Context-overflow failures are recovered
    // automatically by reactive compaction, so they are left unmarked.
    const inlineFailure = message.stopReason !== 'aborted'
      && message.errorMessage
      && !isContextOverflow(message, session.agent.state.model.contextWindow)
      ? message.errorMessage
      : null;
    await this.appendSessionEvents(sessionId, session, [
      {
        type: 'assistant_message.completed',
        actor: this.agentActor(),
        runId: this.activeRunId(session) ?? undefined,
        messageId,
        stopReason: message.stopReason,
        content: fromPiAssistantContent(message.content),
        usage: message.usage,
      },
      ...(inlineFailure ? [{
        type: 'assistant_message.failed' as const,
        actor: this.agentActor(),
        runId: this.activeRunId(session) ?? undefined,
        messageId,
        errorMessage: inlineFailure,
      }] : []),
    ]);
    activeRun.assistantMessageId = null;
    activeRun.assistantText = '';
  }

  private async appendToolResultMessage(sessionId: string, session: AgentSessionState, message: ToolResultMessage) {
    const activeRun = session.activeRun;
    if (!activeRun) return;
    const actor = toolActor(message.toolName, message.toolCallId);
    const prePersisted = activeRun.toolOutputPayloads.get(message.toolCallId);
    activeRun.toolOutputPayloads.delete(message.toolCallId);
    const persisted = prePersisted
      ? {
          content: [{ type: 'payload_ref', payload: prePersisted.payload, label: prePersisted.label }] satisfies AgentPersistedContent[],
          payloads: [prePersisted.payload],
        }
      : await this.persistPiUserContent(sessionId, message.content, {
          imageSummary: `${message.toolName} image output`,
          runId: this.activeRunId(session) ?? undefined,
          textPayloadRole: 'tool_output',
          textSummary: `${message.toolName} output`,
          textPayloadIdPrefix: `tool-output-${message.toolCallId}`,
        });
    const outputRef = prePersisted?.payload
      ?? persisted.payloads.find((payload) => payload.role === 'tool_output')
      ?? persisted.payloads[0];
    await this.appendSessionEvents(sessionId, session, [
      ...persisted.payloads.map((payload): AgentEventInput => ({
        type: 'payload.created',
        actor,
        payload,
      })),
      {
        type: 'tool_result.created',
        actor,
        runId: this.activeRunId(session) ?? undefined,
        messageId: this.createMessageId('tool-result'),
        parentMessageId: session.eventState.selectedLeafMessageId,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        isError: message.isError,
        content: persisted.content,
        outputSummary: summarizeToolResult(message),
        outputRef,
      },
    ]);
  }

  private async appendToolCallEventsFromAssistant(sessionId: string, session: AgentSessionState, message: AssistantMessage) {
    const activeRun = session.activeRun;
    const assistantMessageId = activeRun?.assistantMessageId;
    if (!assistantMessageId) return;
    const toolCalls = message.content.filter((part): part is ToolCall => part.type === 'toolCall');
    const inputs: AgentEventInput[] = [];
    for (const toolCall of toolCalls) {
      activeRun.toolCallMessageIds.set(toolCall.id, assistantMessageId);
      inputs.push({
        type: 'tool_call.started',
        actor: this.agentActor(),
        runId: this.activeRunId(session) ?? undefined,
        messageId: assistantMessageId,
        toolCallId: toolCall.id,
        name: toolCall.name,
        inputSummary: summarizeJson(toolCall.arguments),
        args: toolCall.arguments,
      });
    }
    if (inputs.length > 0) await this.appendSessionEvents(sessionId, session, inputs);
  }

  private async appendToolExecutionStart(
    sessionId: string,
    session: AgentSessionState,
    toolCallId: string,
    toolName: string,
    args: unknown,
  ) {
    const activeRun = session.activeRun;
    if (!activeRun || activeRun.toolCallMessageIds.has(toolCallId)) return;
    const messageId = findLatestAssistantMessageId(session.eventState);
    if (!messageId) return;
    activeRun.toolCallMessageIds.set(toolCallId, messageId);
    await this.appendSessionEvents(sessionId, session, [{
      type: 'tool_call.started',
      actor: toolActor(toolName, toolCallId),
      runId: this.activeRunId(session) ?? undefined,
      messageId,
      toolCallId,
      name: toolName,
      inputSummary: summarizeJson(args),
      args: isRecord(args) ? args : undefined,
    }]);
  }

  private async appendToolExecutionEnd(
    sessionId: string,
    session: AgentSessionState,
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean,
  ) {
    const activeRun = session.activeRun;
    const messageId = activeRun?.toolCallMessageIds.get(toolCallId) ?? findLatestAssistantMessageId(session.eventState);
    if (!messageId) return;
    const events: AgentEventInput[] = [{
      type: isError ? 'tool_call.failed' : 'tool_call.completed',
      actor: toolActor(toolName, toolCallId),
      runId: this.activeRunId(session) ?? undefined,
      messageId,
      toolCallId,
      errorMessage: isError ? summarizeJson(result) : undefined,
    }];
    const skillAuditEvent = isError ? null : skillAuditEventFromToolResult(toolName, toolCallId, result);
    if (skillAuditEvent) events.push(skillAuditEvent);
    await this.appendSessionEvents(sessionId, session, events);
  }

  private async deriveRuntimePiMessages(
    sessionId: string,
    eventState: AgentEventReplayState,
  ): Promise<AgentMessage[]> {
    const messages: AgentMessage[] = [];
    for (const message of getAgentEventRuntimeTranscriptPath(eventState)) {
      if (message.role === 'user') {
        messages.push({
          role: 'user',
          content: await this.runtimeUserContent(sessionId, message.content),
          timestamp: message.createdAt,
        } satisfies UserMessage);
        continue;
      }
      if (message.role === 'assistant') {
        messages.push({
          role: 'assistant',
          content: this.runtimeAssistantContent(message.content),
          api: message.apiId ?? 'unknown',
          provider: message.providerId ?? 'unknown',
          model: message.modelId ?? 'unknown',
          usage: message.usage ?? EMPTY_USAGE,
          stopReason: message.stopReason ?? (message.status === 'failed' ? 'error' : 'stop'),
          errorMessage: message.errorMessage,
          timestamp: message.createdAt,
        } satisfies AssistantMessage);
        continue;
      }
      messages.push({
        role: 'toolResult',
        toolCallId: message.toolCallId ?? message.id,
        toolName: message.toolName ?? 'unknown',
        content: await this.runtimeUserContent(sessionId, message.content),
        isError: !!message.isError,
        timestamp: message.createdAt,
      } satisfies ToolResultMessage);
    }
    return messages;
  }

  private async persistPiUserContent(
    sessionId: string,
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
      const persisted = await this.persistTextContent(sessionId, content, {
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
        const saved = await this.persistTextContent(sessionId, part.text, {
          ...options,
          textPayloadId,
        });
        persisted.push(saved.content);
        if (saved.payload) payloads.push(saved.payload);
        continue;
      }
      const payload = await this.getEventStore().writePayload(sessionId, {
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
    sessionId: string,
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
    const payload = await this.getEventStore().writePayload(sessionId, {
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
    sessionId: string,
    content: AgentPersistedContent[],
  ): Promise<Array<PiTextContent | PiImageContent>> {
    const parts: Array<PiTextContent | PiImageContent> = [];
    for (const part of content) {
      if (part.type === 'text') {
        parts.push({ type: 'text', text: part.text });
        continue;
      }
      if (part.type === 'image') {
        parts.push(await this.runtimeImageContent(sessionId, part.imageRef, part.alt));
        continue;
      }
      if (part.type === 'payload_ref' && part.payload.mimeType.startsWith('image/')) {
        parts.push(await this.runtimeImageContent(sessionId, part.payload, part.label));
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
        parts.push(await this.runtimeTextPayloadContent(sessionId, part.payload, part.label));
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
    sessionId: string,
    payload: AgentPayloadRef,
    label?: string,
  ): Promise<PiImageContent | PiTextContent> {
    try {
      const data = await this.getEventStore().readPayload(sessionId, payload);
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
    sessionId: string,
    payload: AgentPayloadRef,
    label?: string,
  ): Promise<PiTextContent> {
    try {
      const data = await this.getEventStore().readPayload(sessionId, payload);
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
  if (!eventState.session) return null;
  return {
    id: eventState.session.id,
    title: sanitizeSessionTitle(eventState.session.title),
    members: eventState.session.members.slice(),
    goal: eventState.session.goal,
    createdAt: eventState.session.createdAt,
    updatedAt: eventState.session.updatedAt,
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
  const normalized = sanitizeSessionTitle(text);
  return normalized ? normalized.slice(0, 30) : null;
}

function sanitizeSessionTitle(title: string | null | undefined): string | null {
  const normalized = nodeReferenceMarkersToText(title ?? '').replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function normalizeSessionTitle(title: string): string {
  return sanitizeSessionTitle(title) ?? 'Untitled';
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
  if (value.source !== 'user' && value.source !== 'project' && value.source !== 'built-in' && value.source !== 'dynamic') return null;
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

function clearPendingProjection(session: AgentSessionState) {
  if (!session.pendingProjectionTimer) return;
  clearTimeout(session.pendingProjectionTimer);
  session.pendingProjectionTimer = null;
  session.pendingProjectionLastEventType = null;
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
  sessionId: string,
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
    sessionId,
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
    sessionId,
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

function createConfigurationErrorAgent(sessionId: string, message: string, messages: AgentMessage[] = []) {
  return new Agent({
    initialState: {
      systemPrompt: LIN_AGENT_SYSTEM_PROMPT,
      model: CONFIGURATION_ERROR_MODEL,
      thinkingLevel: 'off',
      tools: [],
      messages,
    },
    streamFn: createConfigurationErrorStreamFn(message),
    sessionId,
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
  if (run.anchor.type !== 'agent' || run.kind !== 'reflective') return null;
  const trigger = dreamTaskTrigger(run);
  if (!trigger) return null;
  const status = renderTaskStatusFromRunStatus(run.status);
  return {
    id: `dream:${run.id}`,
    kind: 'dream',
    status,
    trigger,
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
    conversationId: conversationIdFromSessionId(event.sessionId),
    lastEventType: event.lastEventType,
    revision: event.revision,
    renderProjection: event.projection,
    timestamp: event.createdAt,
  };
}

function conversationIdFromSessionId(sessionId: string): string {
  return sessionId;
}

function sessionIdFromConversationId(conversationId: string): string {
  return conversationId;
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
