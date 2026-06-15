import { app, type BrowserWindow } from 'electron';
import {
  Agent,
  type AfterToolCallResult,
  type AgentEvent as PiAgentEvent,
  type AgentLoopTurnUpdate,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  // pi-ai's own vocabulary: per-"session" provider resources, keyed by our conversation id.
  cleanupSessionResources as cleanupPiConversationResources,
  completeSimple,
  createAssistantMessageEventStream,
  getModels,
  getProviders,
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
  SimpleStreamOptions,
  TextContent as PiTextContent,
  ToolCall,
  ToolResultMessage,
} from '@earendil-works/pi-ai';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type AgentFileAttachmentInput,
  type AgentUserQuestionPendingView,
  LIN_AGENT_EVENT_CHANNEL,
  type AgentImageAttachmentInput,
  type AgentMessageAttachmentInput,
  type AgentDebugConversation,
  type AgentDebugConversationShape,
  type AgentDebugRun,
  type AgentDebugRunSummary,
  type AgentMessage,
  type AgentRuntimeEvent,
  type AgentApprovalRequestDetail,
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
  conversationIdOfRun,
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
  type AgentMemorySource,
  type AgentNotificationKind,
  type AgentTaskSource,
  type AgentPayloadRef,
  type AgentPersistedContent,
  type AgentPrincipal,
  type AgentRunFingerprint,
  type AgentRunTrigger,
  type AgentRunMeta,
  type AgentChildRunRecord,
  type AgentUserQuestionAnswer,
  type AgentUserQuestionAttachment,
  type AgentUserQuestionFileReference,
  type AgentUserQuestionRequestView,
} from '../core/agentEventLog';
import {
  agentMentionToken,
  channelAgentMembers,
  channelMessageOwner,
  deriveAgentPovProjection,
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
import { materializeAgentLocalPath, materializePathBackedAttachment } from './agentAttachmentMaterialization';
import { sniffMimeType } from './assetService';
import {
  buildReferencedFilesReminder,
  selectReferencedAssetNodes,
  type MaterializedReferencedFile,
} from './agentReferencedAssets';
import { isToolEnvelope, toolEnvelopeAfterToolCall } from './agentToolEnvelope';
import { createAgentTools, type AgentToolsOptions } from './agentTools';
import { agentDefinitionDisplayName } from './agentDefinitionDisplay';
import { DEFAULT_AGENT_SYSTEM_PROMPT, composeAgentPrompt } from './agentSystemPrompt';
import { applyAgentPromptCacheBreakpoints } from './agentProviderCacheBreakpoints';
import {
  deriveDebugConversation,
  deriveDebugRun,
  extractRunSnapshotFromPayload,
  snapshotFromRunEvents,
  summarizeDebugRun,
} from './agentDebugView';
import {
  AgentEventStore,
  MAX_AGENT_MEMORY_FACT_CHARS,
  type AgentConversationIndexEntry,
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
  parseDreamMemoryExtractionResponse,
  type DreamMemoryAction,
  type DreamMemoryExtractionRunInput,
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
  getBuiltInAgentProfile,
  setBuiltInAgentProfile,
  providerStreamOptionsFromRuntimeSettings,
  rankedModels,
  type AgentProviderRuntimeConfig,
} from './agentSettings';
import { parseProviderQualifiedModel } from '../core/agentModelId';
import { appendAgentToolPermissionGrant, readAgentToolPermissionConfig } from './agentToolPermissionStore';
import type { OutlinerToolHost } from './agentNodeTools';
import { AgentUserViewContextReminderTracker, buildUserViewContextReminder } from './agentUserViewContextReminder';
import { buildConversationEnvironmentReminder } from './agentConversationEnvironmentReminder';
import {
  AgentSkillRuntime,
  createSlashSkillPrompt,
  type SkillListingReservation,
  type SkillTurnEffect,
} from './agentSkills';
import { createAgentSkillProvenanceStore } from './agentSkillProvenanceStore';
import {
  AGENT_DELEGATE_TOOL_NAME,
  AgentDelegationRuntime,
  createTenonAssistantAgentDefinition,
  type AgentChildAgentCreateInput,
  type AgentChildRunSnapshot,
} from './agentDelegation';
import { mergeMemoryOverviews, orderMemoryEntriesForBriefing } from '../core/agentMemoryActivation';
import {
  agentDefinitionAgentId,
  memoryWorkspaceIdForRoot,
  resolveChildRunMemoryOwner,
} from './agentDelegationIdentity';
import {
  createAgentDefinitionFile,
  deleteAgentDefinitionFile,
  duplicateAgentDefinitionFile,
  isAgentDefinitionWritable,
  updateAgentDefinitionFile,
} from './agentAuthoring';
import { AgentRunLedgerWriter, fromPiAssistantContent } from './agentRunLedger';
import type { AgentSkillWriteAudit } from './agentSkillAuthoring';
import { executeAgentSkillShellCommand } from './agentSkillShell';
import type { AgentRecallEvidence, AgentRecallRuntimeEntry, AgentRecallToolRuntime } from './agentRecallTool';
import { renderAgentMemoryBriefing, MEMORY_BRIEFING_MAX_ENTRIES } from './agentMemoryBriefing';
import { redactSecretLikeContent } from './agentSecretRedaction';
import {
  approvalNoticeForDeniedDecision,
  evaluateAgentToolPermission,
  type AgentPermissionAskDecision,
  type AgentPermissionDenyDecision,
} from './agentPermissions';
import {
  resolveAgentPermissionAsk,
  type PermissionDeniedReason,
} from './agentPermissionAskResolver';
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
  scratchRootForWorkdir,
  setAgentLocalPermissionRoots,
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
import type { ErrorReport, ErrorReportContext } from '../core/errorObservability';
import { AGENT_REASONING_LADDER } from '../core/types';
import type {
  AgentDefinition,
  AgentPermissionMode,
  AgentReasoningLevel,
  AgentRuntimeSettings,
  SkillDefinition,
  AgentConversationListMeta,
  AgentMemoryEntryView,
  AgentSlashCommandView,
  AssetMetadata,
  DocumentProjection,
} from '../core/types';
import {
  ASK_USER_QUESTION_TOOL_NAME,
  askUserQuestionToolResult,
  type AgentAskUserQuestionRuntime,
} from './agentAskUserQuestionTool';
import {
  normalizeRuntimeSettingPatch,
  readRuntimeSetting,
  type AgentSelfMaintenanceRuntime,
  type DreamToolData,
  type DoctorDiagnostic,
} from './agentSelfMaintenanceTools';
import {
  buildAgentRenderProjection,
  renderTaskStatusFromRunStatus,
  type AgentRenderActivityEntry,
  type AgentRenderActiveCompaction,
  type AgentRenderActiveDream,
  type AgentRenderDreamTaskEntity,
  type AgentRenderTaskEntity,
  type AgentRenderTaskStatus,
} from '../core/agentRenderProjection';
import { createAbortSettledStreamFn } from './agentStreamAbort';
import { awaitWithAbort, throwIfAborted } from './agentAwaitWithAbort';
import { shouldFireDateSchedule } from '../core/dateSchedule';
import type { AgentPermissionGrant } from '../core/agentPermissionModel';

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
// Upper bound on referenced outliner images inlined for vision in one turn; the rest
// are still surfaced as readable paths. Mirrors the composer's MAX_ATTACHMENTS spirit.
const MAX_REFERENCED_INLINE_IMAGES = MAX_ATTACHMENTS;
const MAX_INLINE_TOOL_OUTPUT_CHARS = DEFAULT_MAX_TOOL_RESULT_CHARS;
const LOCAL_FILE_TOOL_NAMES = new Set([
  'file_read',
  'file_glob',
  'file_grep',
  'file_edit',
  'file_write',
  'file_convert',
  'file_delete',
]);
const LOCAL_USER_ID = 'local-user';
const COMPACT_SUMMARY_MAX_OUTPUT_TOKENS = 20_000;
const DEFAULT_DREAM_SCHEDULE = '2026-01-01T03:00 RRULE:FREQ=DAILY';
const DREAM_MIN_VOLUME_CHARS = 1_000;
const CHILD_RUN_TRANSCRIPT_CACHE_LIMIT = 16;
const DEBUG_RUN_CACHE_LIMIT = 64;
const DREAM_SCHEDULER_INTERVAL_MS = 60_000;
const COMMAND_SCHEDULER_INTERVAL_MS = 60_000;
// In-memory per-command failure backoff (openclaw-style); process-level, never
// persisted. A failed fire does not advance the watermark, so it stays due.
const COMMAND_FAILURE_BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000] as const;
// How long each `status({wait})` poll blocks while waiting for a background-flagged
// command child run to finish (it re-polls if the run is still going).
const COMMAND_CHILD_RUN_WAIT_MS = 600_000;
const CHANNEL_MAX_CONCURRENT_RUNS = 4;
const SUPPORTED_INLINE_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

type CompleteSimpleFn = typeof completeSimple;
type ErrorReporter = (report: ErrorReport) => void | Promise<void>;

/**
 * Narrow view of the asset store the runtime needs to materialize a referenced
 * outliner file (handle → path) for the agent. `AssetService` satisfies it.
 */
export interface AgentAssetResolver {
  pathFor(id: string): Promise<string | null>;
  lookup(id: string): Promise<AssetMetadata | null>;
}

interface AgentRuntimeOptions {
  agentDataRoot?: string;
  agentIdentity?: AgentIdentityRecord;
  domainEvents?: AgentDomainEventBus;
  completeSimpleFn?: CompleteSimpleFn;
  localFileRoot?: string;
  scratchRoot?: string;
  assetResolver?: AgentAssetResolver;
  permissionMode?: AgentPermissionMode;
  runtimeSettingsLoader?: () => Promise<AgentRuntimeSettings>;
  providerApiKeyLoader?: (providerId: string) => Promise<string | undefined> | string | undefined;
  providerConfigLoader?: () => Promise<AgentProviderRuntimeConfig | null>;
  providerModelResolver?: (providerConfig: AgentProviderRuntimeConfig) => Model<Api>;
  streamFn?: StreamFn;
  dreamMemoryExtractionEnabled?: boolean;
  errorReporter?: ErrorReporter;
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
  startedAt: number;
  agent: Agent;
  channelTurn: boolean;
  unsubscribe?: () => void;
  channelDefinition?: AgentDefinition;
  settled: Promise<void>;
  resolveSettled: () => void;
  assistantMessageId: string | null;
  assistantText: string;
  /**
   * This run's own tail: the id of the last message it appended (an assistant
   * segment or a tool result). A run's continuation segments parent to their
   * OWN tail, so each run is a linear spine off its addressing message — never
   * a fan-out of sibling segments (which would collapse to one in the transcript)
   * and never chained onto the shared, concurrently-moving `selectedLeafMessageId`
   * (which would interleave parallel runs). Null until the run appends.
   */
  lastMessageId: string | null;
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

/** One scheduled Channel turn: the agent to run and the message that addressed it. */
interface ChannelTurnRequest {
  agentId: string;
  addressedByMessageId: string;
}

interface AgentRosterEntry {
  agentId: string;
  displayName: string;
  model?: string;
}

type RendererProjectionDomainEvent = Extract<AgentDomainEvent, { lane: 'renderer-projection' }>;

/** One Dream pass's single sweep over every conversation's childRuns records. */
type DreamChildRunHarvest = { conversationId: string; runs: AgentChildRunRecord[] }[];
type PublicConversationRuntimeEventInput =
  | Omit<Extract<AgentRuntimeEvent, { type: 'approval_request' }>, 'conversationId' | 'timestamp'>
  | Omit<Extract<AgentRuntimeEvent, { type: 'approval_resolved' }>, 'conversationId' | 'timestamp'>
  | Omit<Extract<AgentRuntimeEvent, { type: 'user_question_request' }>, 'conversationId' | 'timestamp'>
  | Omit<Extract<AgentRuntimeEvent, { type: 'user_question_resolved' }>, 'conversationId' | 'timestamp'>
  | Omit<Extract<AgentRuntimeEvent, { type: 'closed' }>, 'conversationId' | 'timestamp'>
  | Omit<Extract<AgentRuntimeEvent, { type: 'error' }>, 'conversationId' | 'timestamp'>;

interface AgentConversationState {
  agent: Agent;
  defaultAgentId: string;
  activeRuns: Map<string, AgentActiveRunState>;
  activeRun: AgentActiveRunState | null;
  lastRun: AgentActiveRunState | null;
  autoCompactConsecutiveFailures: number;
  autoCompactInProgress: boolean;
  eventState: AgentEventReplayState;
  activeCompaction: AgentRenderActiveCompaction | null;
  activeDream: AgentRenderActiveDream | null;
  pendingDreamFinishedMarkers: AgentDreamRunResult[];
  pendingChildRunNotifications: string[];
  pendingEventAppend: Promise<void>;
  pendingProjectionLastEventType: string | null;
  pendingProjectionTimer: ReturnType<typeof setTimeout> | null;
  queuedFollowUpSkillListingReservation: SkillListingReservation | null;
  reactiveCompactRequested: boolean;
  revision: number;
  childRunNotificationFlushInProgress: boolean;
  runtimeSettings: AgentRuntimeSettings;
  skillRuntime: AgentSkillRuntime;
  delegationRuntime: AgentDelegationRuntime;
  localWorkspace: AgentLocalWorkspaceContext;
  toolResultBudgetState: ToolResultBudgetState;
  /** Display names for member agents (agentId → name), for projections + preambles. */
  memberDisplayNames: Record<string, string>;
  /** Read-only briefing text for Channel POV inspectors (agentId → rendered zones). */
  povInspectorMemoryByAgentId: Record<string, string | null>;
  povInspectorMemoryRefreshInProgress: boolean;
  povInspectorMemoryRefreshQueued: boolean;
  pendingChannelTurns: ChannelTurnRequest[];
  channelTurnStartsInProgress: number;
  channelStopRequested: boolean;
  channelDrainWaiters: Set<() => void>;
  /**
   * Guards a single background watcher that emits the final idle projection once
   * the Channel drains. A Channel send returns on acceptance (it does not await
   * the addressed runs), so the idle emit is detached from the send call — but at
   * most one watcher runs per conversation so the drain emits exactly once.
   */
  channelIdleEmitInFlight: boolean;
  /**
   * Ownership token for the detached idle watcher. `teardownChannelDraining`
   * bumps it (reset/close/delete) so an orphaned watcher bows out instead of
   * emitting on a dead conversation or leaving `channelIdleEmitInFlight` stuck.
   */
  channelIdleEmitToken: number;
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

interface AgentRuntimeRunScope {
  conversation: AgentConversationState;
  agent: Agent;
}

export class AgentRuntime {
  private conversations = new Map<string, AgentConversationState>();
  private readonly runScope = new AsyncLocalStorage<AgentRuntimeRunScope>();
  private osNotifier?: OsNotifier;
  // The conversation the user is actually VIEWING, reported by the renderer:
  // the displayed conversation when the agent dock is open, else null (the dock
  // collapses CSS-only while keeping the conversation loaded, so the runtime cannot
  // infer this from restore alone). Used to suppress an OS banner for a task whose
  // conversation the user is already looking at — see main.ts's notifier.
  private viewedConversationId: string | null = null;
  // Last emitted system/tools hash per run, so the once-per-run debug snapshot
  // ([[agent-debug-run-grounded]]) re-emits only on a real change. Keyed by runId,
  // bounded LRU (a re-emit after eviction is just a harmless duplicate snapshot).
  private debugRunSnapshotHashByRun = new Map<string, string>();
  // Derived debug rounds per run, invalidated by the run's latestSeq (the
  // childRunTranscript cache-by-latestSeq pattern) so the view IPC and the
  // per-run IPC share one derivation. Bounded LRU (run ids are globally unique,
  // so an evicted entry is just re-derived; it never grows across a session).
  private debugRunCache = new Map<string, { latestSeq: number; parentToolCallId: string | null; run: AgentDebugRun }>();
  private eventStore: AgentEventStore | null = null;
  private pastChatsService: AgentPastChatsService | null = null;
  private pendingApprovals = new Map<string, {
    conversationId: string;
    runId?: string;
    request: AgentApprovalRequestView;
    alwaysAllowRule?: string;
    onApproved?: () => Promise<void>;
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
  /** The write seam for delegated runs' own ledgers ([[agent-run-unification]]). */
  /** Drill-in transcripts keyed on the run ledger's tail seq (see childRunTranscript). */
  private readonly childRunTranscriptCache = new Map<string, { latestSeq: number; messages: AgentMessage[] }>();

  private readonly runLedger = new AgentRunLedgerWriter({
    store: () => this.getEventStore(),
    persister: {
      persistUserContent: async (conversationId, runId, content) => (
        await this.persistPiUserContent(conversationId, content, { imageSummary: 'Attached image', runId })
      ).content,
      persistToolResultContent: async (conversationId, runId, toolCallId, toolName, content) => (
        await this.persistPiUserContent(conversationId, content, {
          imageSummary: `${toolName} image output`,
          textPayloadRole: 'tool_output',
          textSummary: toolName,
          textPayloadIdPrefix: `tool-output-${runId}-${toolCallId}`,
          runId,
        })
      ).content,
    },
  });

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
      deriveRuntimePiMessages: (conversationId, eventState, conversation) => this.deriveRuntimePiMessages(conversationId, eventState, conversation),
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
      persistToolOutputPayload: (conversationId, toolCallId, toolName, text, runId) => (
        this.persistToolOutputPayload(conversationId, toolCallId, toolName, text, runId)
      ),
      emitError: (conversationId, message) => this.emitError(conversationId, message),
      getActiveProviderConfig: () => this.getActiveProviderConfig(),
      getProviderApiKey: (providerId) => this.getProviderApiKey(providerId),
      resolveProviderModel: (providerConfig) => this.resolveProviderModel(providerConfig),
      beginCompaction: (conversationId, conversation, trigger) => this.beginCompaction(conversationId, conversation, trigger),
      finishCompaction: (conversationId, conversation, compactionId, lastEventType) => {
        this.finishCompaction(conversationId, conversation, compactionId, lastEventType);
      },
      startReactiveRetryRun: async (conversationId, conversation) => {
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
    return this.restoreOrCreateAgentDm(this.agentIdentity.agentId);
  }

  async restoreConversation(conversationId: string) {
    const eventState = await this.loadEventState(conversationId);
    if (!eventState.conversation) {
      const dmAgentId = await this.agentIdForCanonicalDmConversationId(conversationId);
      if (dmAgentId) return this.restoreOrCreateAgentDm(dmAgentId);
      throw new Error(`Agent conversation not found: ${conversationId}`);
    }
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

  private async restoreOrCreateAgentDm(agentId: string) {
    const principal = await this.requireAgentMemberPrincipal(agentId);
    const conversationId = this.canonicalDmConversationId(agentId);
    let eventState = await this.loadEventState(conversationId);
    if (!eventState.conversation) {
      const title = await this.displayNameForAgentId(agentId);
      eventState = createEmptyAgentEventReplayState();
      const events = this.buildEvents(eventState, conversationId, [{
        type: 'conversation.created',
        actor: systemActor(),
        title,
        members: [this.userPrincipal(), principal],
      }]);
      await this.getEventStore().appendEvents(conversationId, events);
      for (const event of events) appendAgentEventToReplayState(eventState, event);
      this.publishPersistedEvents(conversationId, events);
    }
    const conversation = await this.createConversationWithEventState(eventState);
    await this.refreshAgentTaskCache();
    return this.conversationResponse(conversationId, conversation);
  }

  async createConversation(options: {
    agentIds?: string[];
    title?: string;
    goal?: string;
    seedText?: string;
  } = {}) {
    const conversationId = this.createChannelId();
    const eventState = createEmptyAgentEventReplayState();
    const normalizedTitle = sanitizeConversationTitle(options.title ?? options.goal);
    if (!normalizedTitle) {
      throw new Error('A Channel requires a name.');
    }
    const title = normalizedTitle;
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
        actor: userActor(),
        messageId: this.createMessageId('user'),
        parentMessageId: null,
        content: textPersistedContent(seedText),
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
   * Add an agent member. On a Channel this is a real `member.added` event.
   * Canonical DMs are immutable; only named Channels support membership edits.
   */
  async addConversationMember(conversationId: string, agentId: string) {
    const principal = await this.requireAgentMemberPrincipal(agentId);
    const conversation = await this.ensureConversationWithId(conversationId);
    if (this.isCanonicalDmConversationId(conversationId)) {
      throw new Error('Create a Channel from a DM first.');
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
      this.queuePovInspectorMemoryRefresh(conversationId, conversation);
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
    if (this.isCanonicalDmConversationId(conversationId)) throw new Error('The canonical DM membership cannot change.');
    if (agentId === this.coordinatorAgentId()) throw new Error('The Channel coordinator cannot be removed.');
    const conversation = await this.ensureConversationWithId(conversationId);
    const principal: AgentPrincipal = { type: 'agent', agentId };
    const members = conversation.eventState.conversation?.members ?? [];
    const memberExists = members.some((member) => samePrincipal(member, principal));
    // Mid-run removal would yank a member whose run is live (or queued) and
    // can flip the conversation's POV selection under it — membership changes
    // wait for the Channel to settle.
    if (this.hasActiveRuns(conversation) || conversation.pendingChannelTurns.length > 0) {
      throw new Error('Cannot remove a member while a Channel run is active.');
    }
    if (memberExists) {
      await this.appendConversationEvents(conversationId, conversation, [{
        type: 'member.removed',
        actor: userActor(),
        member: principal,
      }]);
      this.queuePovInspectorMemoryRefresh(conversationId, conversation);
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

  private async displayNameForAgentId(agentId: string): Promise<string> {
    if (agentId === this.agentIdentity.agentId) return this.agentIdentity.displayName;
    const definitions = await this.listRawAgentDefinitions('agent-display-name');
    const match = definitions.find((definition) => agentDefinitionAgentId(definition) === agentId);
    return match ? agentDefinitionDisplayName(match) : `@${agentMentionToken(agentId)}`;
  }

  private async agentIdForCanonicalDmConversationId(conversationId: string): Promise<string | null> {
    if (!this.isCanonicalDmConversationId(conversationId)) return null;
    const roster = await this.listConversationRosterAgents();
    return roster.find((agent) => this.canonicalDmConversationId(agent.agentId) === conversationId)?.agentId ?? null;
  }

  private async listConversationRosterAgents(): Promise<AgentRosterEntry[]> {
    const providerConfig = await this.getActiveProviderConfig();
    const builtInModel = providerConfig
      ? await this.resolveBuiltInAssistantModelEffort(providerConfig)
          .then((resolved) => resolved.model.id)
          // Display-only: a connection with no resolvable model (custom, no profile
          // model yet) falls back to the identity's last-known model id.
          .catch(() => this.agentIdentity.model)
      : this.agentIdentity.model;
    const definitions = await this.listRawAgentDefinitions('conversation-roster');
    const entries: AgentRosterEntry[] = [{
      agentId: this.agentIdentity.agentId,
      displayName: this.agentIdentity.displayName,
      model: builtInModel,
    }];
    const seen = new Set(entries.map((entry) => entry.agentId));
    for (const definition of definitions) {
      const agentId = agentDefinitionAgentId(definition);
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      entries.push({
        agentId,
        displayName: agentDefinitionDisplayName(definition),
        model: definition.model,
      });
    }
    return entries;
  }

  private conversationListMetaFromIndexEntry(
    entry: AgentConversationIndexEntry | null,
    fallback?: {
      id: string;
      title: string | null;
      members: AgentPrincipal[];
      canonicalDmAgentId?: string;
    },
  ): AgentConversationListMeta {
    const id = entry?.id ?? fallback!.id;
    return {
      id,
      title: sanitizeConversationTitle(entry?.title ?? fallback?.title),
      members: (entry?.members ?? fallback?.members ?? []).slice(),
      goal: entry?.goal,
      canonicalDmAgentId: fallback?.canonicalDmAgentId,
      createdAt: entry?.createdAt ?? 0,
      updatedAt: entry?.updatedAt ?? 0,
      messageCount: entry?.messageCount ?? 0,
      lastMessageSnippet: entry?.lastMessageSnippet ?? null,
      lastMessageAt: entry?.lastMessageAt ?? null,
      unreadCount: entry?.unreadCount ?? 0,
    };
  }

  async listConversations() {
    const entries = await this.getEventStore().listConversationIndexEntries();
    const entryById = new Map(entries.map((entry) => [entry.id, entry]));
    const roster = await this.listConversationRosterAgents();
    const dmRows = roster.map((agent) => (
      this.conversationListMetaFromIndexEntry(
        entryById.get(this.canonicalDmConversationId(agent.agentId)) ?? null,
        {
          id: this.canonicalDmConversationId(agent.agentId),
          title: agent.displayName,
          members: [this.userPrincipal(), { type: 'agent', agentId: agent.agentId as AgentId }],
          canonicalDmAgentId: agent.agentId,
        },
      )
    ));
    const channelRows = entries
      .filter((entry) => !!entry.goal)
      .map((entry) => this.conversationListMetaFromIndexEntry(entry));
    const listed = [...dmRows, ...channelRows];
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
          unreadCount: entry.unreadCount ?? 0,
          timestamp: Date.now(),
        });
      }
    }
    return listed;
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
    this.queuePovInspectorMemoryRefreshForPrincipal(principal);
    return entry ? agentMemoryEntryToView(entry) : null;
  }

  async forgetMemory(memoryId: string): Promise<AgentMemoryEntryView | null> {
    const principal = await this.resolveMemoryPrincipal(memoryId);
    if (!principal) return null;
    const entry = await this.getEventStore().removeMemoryEntry(principal, memoryId, 'user');
    this.queuePovInspectorMemoryRefreshForPrincipal(principal);
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

    let resolvedApproved = approved;
    let deniedReason: PermissionDeniedReason | undefined = approved ? undefined : 'user_denied';
    let resolvedScope = scope;
    let alwaysAllowRule = approved && scope === 'always' ? pending.alwaysAllowRule : undefined;
    if (approved && scope === 'always' && !alwaysAllowRule) {
      resolvedScope = 'once';
    }
    if (alwaysAllowRule) {
      try {
        await appendAgentToolPermissionGrant(alwaysAllowRule);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.emitError(conversationId, `Failed to persist permission grant; approved once instead. ${message}`);
        resolvedScope = 'once';
        alwaysAllowRule = undefined;
      }
    }
    if (resolvedApproved && pending.onApproved) {
      try {
        await pending.onApproved();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.emitError(conversationId, message);
        resolvedApproved = false;
        deniedReason = 'runtime';
        resolvedScope = 'once';
        alwaysAllowRule = undefined;
      }
    }

    this.pendingApprovals.delete(requestId);
    try {
      await this.appendConversationEvents(conversationId, conversation, [{
        type: 'approval.resolved',
        actor: userActor(),
        runId: pending.runId,
        requestId,
        approved: resolvedApproved,
      }]);
      this.emitConversationRuntimeEvent(conversationId, {
        type: 'approval_resolved',
        requestId,
        approved: resolvedApproved,
        scope: resolvedScope,
      });
      this.emitProjection(conversationId, 'approval.resolved');
    } finally {
      pending.resolve({
        approved: resolvedApproved,
        deniedReason,
        scope: resolvedScope,
        alwaysAllowRule,
      });
    }
    return { resolved: true };
  }

  /**
   * Run-grounded debug ([[agent-debug-run-grounded]]): the conversation's
   * execution tree as per-run summary nodes (agent / kind / status / model /
   * real usage / round count), plus the conversation shape (DM = one member,
   * Channel = many) and rolled-up totals. Reads the store directly, so it works
   * on any stored conversation without loading it into memory.
   */
  async agentDebugView(conversationId: string): Promise<AgentDebugConversation> {
    const store = this.getEventStore();
    const [metas, conversationMeta] = await Promise.all([
      store.listConversationRunMetaProjections(conversationId),
      store.readConversationMetaProjection(conversationId),
    ]);
    const parentToolCallByChild = await this.debugParentToolCallMap(conversationId);
    const summaries: AgentDebugRunSummary[] = [];
    for (const meta of metas) {
      // Reflective / principal-anchored runs span conversations — not this view.
      if (meta.kind === 'reflective' || meta.anchor.type !== 'conversation') continue;
      const run = await this.deriveDebugRunFromStore(meta, parentToolCallByChild.get(meta.id) ?? null);
      summaries.push(summarizeDebugRun(run));
    }
    // Shape + member roster come from the conversation's authoritative members
    // (NOT distinct run executors — a DM that delegates would otherwise look like
    // a Channel, with the transient sub-agent shown as a member). The agents that
    // actually executed runs are filterable in the renderer, derived from the runs.
    const roster = conversationMeta?.members ?? [];
    const memberIds = roster.length > 0
      ? channelAgentMembers(roster).map((member) => member.agentId)
      : [...new Set(summaries.map((summary) => summary.agentId))];
    const shape: AgentDebugConversationShape = isMultiAgentConversation(roster) ? 'channel' : 'dm';
    return deriveDebugConversation(conversationId, shape, memberIds, summaries);
  }

  /** Run-grounded debug: one run's full execution detail (rounds + per-run snapshot). */
  async agentDebugRun(conversationId: string, runId: string): Promise<AgentDebugRun | null> {
    const meta = await this.getEventStore().readRunMetaProjection(runId);
    if (!meta) return null;
    if (meta.anchor.type !== 'conversation' || meta.anchor.conversationId !== conversationId) return null;
    const parentToolCallByChild = await this.debugParentToolCallMap(conversationId);
    return this.deriveDebugRunFromStore(meta, parentToolCallByChild.get(runId) ?? null);
  }

  /** childRunId → parentToolCallId, read from the parent conversation's `child_run.started`. */
  private async debugParentToolCallMap(conversationId: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const event of await this.getEventStore().readEvents(conversationId)) {
      if (event.type === 'child_run.started' && typeof event.parentToolCallId === 'string') {
        map.set(event.childRunId, event.parentToolCallId);
      }
    }
    return map;
  }

  private async deriveDebugRunFromStore(meta: AgentRunMetaProjection, parentToolCallId: string | null): Promise<AgentDebugRun> {
    const cached = this.debugRunCache.get(meta.id);
    if (cached && cached.latestSeq === meta.latestSeq && cached.parentToolCallId === parentToolCallId) return cached.run;
    const events = await this.getEventStore().readRunStreamEvents(meta.id);
    const run = deriveDebugRun(events, { meta, snapshot: snapshotFromRunEvents(events), parentToolCallId });
    if (this.debugRunCache.size >= DEBUG_RUN_CACHE_LIMIT) {
      const oldest = this.debugRunCache.keys().next().value;
      if (oldest !== undefined) this.debugRunCache.delete(oldest);
    }
    this.debugRunCache.set(meta.id, { latestSeq: meta.latestSeq, parentToolCallId, run });
    return run;
  }

  /** Bounded-LRU record of the last-emitted debug-snapshot hash (see capture). */
  private rememberDebugRunSnapshotHash(runId: string, combined: string) {
    if (this.debugRunSnapshotHashByRun.size >= DEBUG_RUN_CACHE_LIMIT && !this.debugRunSnapshotHashByRun.has(runId)) {
      const oldest = this.debugRunSnapshotHashByRun.keys().next().value;
      if (oldest !== undefined) this.debugRunSnapshotHashByRun.delete(oldest);
    }
    this.debugRunSnapshotHashByRun.set(runId, combined);
  }

  async payloadText(conversationId: string, payloadId: string) {
    const conversation = this.conversations.get(conversationId);
    const eventState = conversation?.eventState ?? await this.loadEventState(conversationId);
    const payload = eventState.payloads[payloadId];
    if (!payload || !isTextPayloadRole(payload.role) || !isTextPayloadMimeType(payload.mimeType)) return null;
    const bytes = await this.getEventStore().readPayload(conversationId, payload);
    return bytes.toString('utf8');
  }

  async previewPayload(conversationId: string, payloadId: string, runId?: string): Promise<AgentPayloadRef | null> {
    const conversation = this.conversations.get(conversationId);
    const eventState = conversation?.eventState ?? await this.loadEventState(conversationId);
    const payload = eventState.payloads[payloadId];
    if (!payload || !isPreviewPayloadRole(payload.role)) return null;
    if (!payloadScopeMatchesPreviewTarget(payload, conversationId, runId)) return null;
    return payload;
  }

  async previewPayloadBytes(conversationId: string, payloadId: string, runId?: string): Promise<Buffer | null> {
    const payload = await this.previewPayload(conversationId, payloadId, runId);
    if (!payload) return null;
    return this.getEventStore().readPayload(conversationId, payload);
  }

  /**
   * The drill-in transcript for a delegated run: its OWN ledger replayed alone
   * and derived to pi messages ([[agent-run-unification]] — replaces the
   * transcript-snapshot payload read). Cached on the ledger tail seq (one tiny
   * run-meta read decides freshness), so the panel's live poll re-replays only
   * when the ledger actually grew.
   */
  async childRunTranscript(conversationId: string, runId: string): Promise<{ messages: AgentMessage[] } | null> {
    const meta = await this.getEventStore().readRunMetaProjection(runId);
    // Ownership gate: run ids are global, so without this any renderer call
    // could read another conversation's run ledger. Fail closed when the meta
    // is missing (no meta ⇒ no seeded ledger to serve anyway).
    if (!meta || conversationIdOfRun(meta) !== conversationId) return null;
    const cached = this.childRunTranscriptCache.get(runId);
    if (meta && cached && cached.latestSeq === meta.latestSeq) return { messages: cached.messages };
    const state = await this.getEventStore().replayRunStream(runId);
    if (state.latestSeq === 0) return null;
    const messages = await this.deriveRuntimePiMessages(conversationId, state);
    if (this.childRunTranscriptCache.size >= CHILD_RUN_TRANSCRIPT_CACHE_LIMIT) {
      const oldest = this.childRunTranscriptCache.keys().next().value;
      if (oldest !== undefined) this.childRunTranscriptCache.delete(oldest);
    }
    this.childRunTranscriptCache.set(runId, { latestSeq: state.latestSeq, messages });
    return { messages };
  }

  async childRunStatus(
    conversationId: string,
    agentId: string,
    options: { wait?: boolean; timeoutMs?: number } = {},
  ) {
    const conversation = await this.ensureConversationWithId(conversationId);
    return conversation.delegationRuntime.status({
      agent_id: agentId,
      wait: options.wait === true,
      timeout_ms: options.timeoutMs,
    });
  }

  async childRunSend(conversationId: string, agentId: string, message: string) {
    const conversation = await this.ensureConversationWithId(conversationId);
    return conversation.delegationRuntime.send({
      agent_id: agentId,
      message,
    });
  }

  async childRunStop(conversationId: string, agentId: string) {
    const conversation = await this.ensureConversationWithId(conversationId);
    return conversation.delegationRuntime.stop({
      agent_id: agentId,
    });
  }

  async listAllAgentDefinitions(conversationId: string): Promise<AgentDefinitionView[]> {
    const definitions = await this.listRawAgentDefinitions(conversationId);
    const localRoot = this.authoringLocalRoot();
    return Promise.all(this.withBuiltInAgentDefinitions(definitions).map(async (definition) => {
      const agentId = agentDefinitionAgentId(definition);
      // Surface the built-in's editable model/effort overlay on its view so the
      // editor renders the user's saved selection (not the inert `inherit` default).
      const overlaid = definition.source === 'built-in'
        ? { ...definition, ...(await this.resolveDefinitionModelEffort(agentId, definition)) }
        : definition;
      return {
        ...overlaid,
        agentId,
        writable: isAgentDefinitionWritable(definition, localRoot),
      };
    }));
  }

  // The raw (agentId-less) scan, shared by the settings list and the
  // authoring resolve-by-id path. Reuses a live conversation's registry when one
  // exists (so its cache invalidation is observed), else a throwaway runtime.
  private async listRawAgentDefinitions(conversationId: string): Promise<AgentDefinition[]> {
    const conversation = this.conversations.get(conversationId);
    if (conversation) {
      return conversation.delegationRuntime.listAllAgentDefinitions();
    }
    const tempRuntime = new AgentDelegationRuntime({
      conversationId: 'temp-settings-list',
      executingAgentId: this.agentIdentity.agentId,
      memoryOwnerAgentId: this.agentIdentity.agentId,
      localRoot: this.options.localFileRoot,
      scratchRoot: this.scratchRoot(),
      host: {} as any,
    });
    return tempRuntime.listAllAgentDefinitions();
  }

  private withBuiltInAgentDefinitions(definitions: readonly AgentDefinition[]): AgentDefinition[] {
    const builtIn = createTenonAssistantAgentDefinition();
    const builtInId = agentDefinitionAgentId(builtIn);
    return [
      builtIn,
      ...definitions.filter((definition) => agentDefinitionAgentId(definition) !== builtInId),
    ];
  }

  // Authoring (user-driven only — see [[agent-authoring]]). Each write goes
  // through main's containment-checked file surface, then every live conversation's
  // registry cache is invalidated so the change is visible (child run picker +
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
    // A built-in definition is read-only code: only its model/effort are editable,
    // and they persist to the settings overlay rather than a (non-existent) file.
    if (existing.source === 'built-in') {
      await setBuiltInAgentProfile(agentId, {
        model: input.model ?? null,
        effort: typeof input.effort === 'string' ? input.effort : null,
      });
    } else {
      await updateAgentDefinitionFile({ existing, input, localRoot: this.authoringLocalRoot() });
    }
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
      conversation.delegationRuntime.reloadAgentDefinitions();
    }
    return this.listAllAgentDefinitions(conversationId);
  }

  private async resolveAgentDefinitionById(conversationId: string, agentId: string): Promise<AgentDefinition> {
    const definitions = await this.listRawAgentDefinitions(conversationId);
    const match = this.withBuiltInAgentDefinitions(definitions)
      .find((definition) => agentDefinitionAgentId(definition) === agentId);
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
    if (this.isCanonicalDmConversationId(conversationId)) {
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
    if (this.isCanonicalDmConversationId(conversationId)) {
      throw new Error('The canonical agent DM cannot be deleted.');
    }
    const conversation = this.conversations.get(conversationId);
    if (conversation) {
      await this.clearPendingUserQuestionsForConversation(conversationId, 'conversation_deleted');
      for (const run of this.activeRunList(conversation)) run.agent.abort();
      conversation.agent.abort();
      // Settle the detached idle watcher before dropping the conversation: an
      // unresolved parked watcher would pin it and could emit on a deleted one.
      this.teardownChannelDraining(conversation);
      conversation.unsubscribe?.();
      clearPendingProjection(conversation);
      this.conversations.delete(conversationId);
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
      if (this.hasActiveRuns(conversation) && !multiAgent) {
        if (attachments.length > 0) {
          throw new Error('Attachments cannot be queued while the agent is running.');
        }
        await this.steerConversation(conversationId, messageText);
        return;
      }
      const channelActive = multiAgent && this.hasActiveRuns(conversation);
      const runtimeSettings = await this.refreshRuntimeSettings(conversation);
      const compactCommand = attachments.length === 0 && runtimeSettings.compactEnabled
        ? parseCompactSlashCommand(messageText)
        : null;
      if (compactCommand) {
        if (channelActive) throw new Error('Cannot compact while a Channel run is active.');
        await this.compactConversation(conversationId, conversation, compactCommand.instructions);
        return;
      }
      if (attachments.length === 0 && parseDreamSlashCommand(messageText) && this.dreamMemoryExtractionEnabled()) {
        if (channelActive) throw new Error('Cannot run /dream while a Channel run is active.');
        await this.runManualDreamFromConversation(conversationId);
        return;
      }
      if (!channelActive) {
        conversation.skillRuntime.resetRunPermissionRules();
      }
      const normalizedUserViewContext = normalizeAgentUserViewContext(userViewContextInput);
      const userViewContextReminder = this.userViewContextReminderTracker.prepare(
        conversationId,
        normalizedUserViewContext,
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
        : await this.buildMemoryReminder(conversation.defaultAgentId, conversation);
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
      let prompt: UserMessage;
      if (slashSkillPrompt) {
        // A slash-skill turn replaces the user prompt wholesale, so referenced
        // assets are not materialized for it (nothing would surface them).
        prompt = slashSkillPrompt;
      } else {
        // Materialize bridge: hand the agent the bytes of any outliner image /
        // attachment node the user explicitly referenced (images also inline for
        // vision). The composer images already in this turn count against the inline cap.
        const composerInlineImages = attachments.reduce((count, a) => count + (a.kind === 'image' ? 1 : 0), 0);
        const referencedAssets = await this.materializeReferencedAssetNodes(
          normalizedUserViewContext?.referencedNodes,
          composerInlineImages,
        );
        prompt = buildUserPromptMessage(messageText, [...attachments, ...referencedAssets.imageAttachments], {
          memoryReminder,
          outlinerContext,
          userViewContextReminder: userViewReminderText,
          referencedFilesReminder: buildReferencedFilesReminder(referencedAssets.files),
          skillListingReminder,
          agentListingReminder,
        }, now);
      }
      if (multiAgent) {
        const addressedTo = this.resolveAddressedMembers(messageText, channelMembers);
        const messageId = await this.appendUserPromptEvent(conversationId, conversation, prompt, { addressedTo });
        userViewContextReminder.commit();
        this.enqueueChannelTurns(
          conversationId,
          conversation,
          addressedTo
            .filter((target): target is Extract<AgentPrincipal, { type: 'agent' }> => target.type === 'agent')
            .map((target) => ({ agentId: target.agentId, addressedByMessageId: messageId })),
        );
        // Channel send returns on acceptance: the user message is persisted and
        // the addressed turns are enqueued and projected (above). The runs drain
        // asynchronously; scheduleChannelIdleEmit emits the final idle state. A
        // settled Channel for tests uses drainChannelTurnsForTest.
        //
        // DISPATCH CONTRACT (keep in sync): this accept-and-return shape is
        // mirrored in editMessage and rerunSettledTurn (the latter enqueues a
        // single owner turn, with a different guard). A change to the contract — a
        // new ChannelTurnRequest field, an extra accept-time step — must land in
        // ALL THREE or one entry point silently diverges (an edit/retry-only bug).
        // Deliberately NOT unified into one dispatchTurn: the three differ enough
        // (addressing source, continue verb, guard) that a careless merge would
        // itself reintroduce that entry-point-specific divergence.
        return;
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

  /** Edit/regenerate/retry/switch act on a settled transcript — any in-flight run means it is not settled. */
  private assertNoActiveChannelRound(conversation: AgentConversationState) {
    if (this.hasActiveRuns(conversation)) throw new Error('Cannot modify the transcript while a Channel run is active.');
  }

  async editMessage(conversationId: string, nodeId: string, message: string) {
    const trimmed = message.trim();
    if (!trimmed) return;
    let startedRunId: string | null = null;
    try {
      const conversation = await this.ensureConversationWithId(conversationId);
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
      if (multiAgent && addressedTo) {
        this.enqueueChannelTurns(
          conversationId,
          conversation,
          addressedTo
            .filter((target): target is Extract<AgentPrincipal, { type: 'agent' }> => target.type === 'agent')
            .map((target) => ({ agentId: target.agentId, addressedByMessageId: messageId })),
        );
        // Returns on acceptance like a Channel send: the edited addressing message
        // is persisted and re-dispatched; the runs drain asynchronously.
        // (Channel-dispatch sibling of sendMessage / rerunSettledTurn — keep the
        // dispatch contract synced; see the DISPATCH CONTRACT note in sendMessage.)
        return;
      }
      startedRunId = await this.startRun(conversationId, conversation);
      await conversation.agent.continue();
      await this.contextManager.runReactiveCompactRetryIfNeeded(conversationId, conversation);
      await this.persistAndEmitIdle(conversationId, conversation);
    } catch (error) {
      await this.recoverFromRunError(conversationId, startedRunId);
      this.emitError(conversationId, error instanceof Error ? error.message : String(error));
    }
  }

  async regenerateMessage(conversationId: string, nodeId: string) {
    try {
      const conversation = await this.ensureConversationWithId(conversationId);
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
      // rerunSettledTurn emits idle for the synchronous DM path; the Channel path
      // returns on acceptance and drains asynchronously.
      await this.rerunSettledTurn(conversationId, conversation, target, parentId);
    } catch (error) {
      // Run recovery happens inside rerunSettledTurn (it knows the run it
      // started); this catch only surfaces the error.
      this.emitError(conversationId, error instanceof Error ? error.message : String(error));
    }
  }

  async retryMessage(conversationId: string, nodeId: string) {
    try {
      const conversation = await this.ensureConversationWithId(conversationId);
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
      // rerunSettledTurn emits idle for the synchronous DM path; the Channel path
      // returns on acceptance and drains asynchronously.
      await this.rerunSettledTurn(conversationId, conversation, target, parentId);
    } catch (error) {
      // Run recovery happens inside rerunSettledTurn (it knows the run it
      // started); this catch only surfaces the error.
      this.emitError(conversationId, error instanceof Error ? error.message : String(error));
    }
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
      this.enqueueChannelTurns(conversationId, conversation, [{
        agentId: ownerAgentId,
        addressedByMessageId: parentId,
      }]);
      // Returns on acceptance: the re-run turn is enqueued and projected; it
      // drains asynchronously via scheduleChannelIdleEmit.
      // (Channel-dispatch sibling of sendMessage / editMessage, but a SINGLE owner
      // turn and a wider guard — keep the dispatch contract synced; see the
      // DISPATCH CONTRACT note in sendMessage.)
      return;
    }
    let startedRunId: string | null = null;
    try {
      startedRunId = await this.startRun(conversationId, conversation);
      await continueFromActivePath(conversation.agent);
      await this.contextManager.runReactiveCompactRetryIfNeeded(conversationId, conversation);
      // DM rerun is synchronous: emit idle here once the run settles. The Channel
      // branch returned early and drains via scheduleChannelIdleEmit instead.
      await this.persistAndEmitIdle(conversationId, conversation);
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
      memoryReminder: await this.buildMemoryReminder(conversation.defaultAgentId, conversation),
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
    conversation.channelStopRequested = this.activeOrStartingChannelRunCount(conversation) > 0 || conversation.pendingChannelTurns.length > 0;
    void this.discardPendingChannelTurns(conversationId, conversation, '')
      .catch((error) => this.emitError(conversationId, error instanceof Error ? error.message : String(error)));
    for (const run of this.activeRunList(conversation)) run.agent.abort();
    conversation.agent.abort();
    conversation.skillRuntime.resetRunPermissionRules();
    this.emitProjection(conversationId, 'stop_requested');
  }

  stopRun(conversationId: string, runId: string) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return { stopped: false };
    const run = conversation.activeRuns.get(runId);
    if (!run) return { stopped: false };
    void this.clearPendingUserQuestionsForRun(conversationId, runId, 'run_stopped')
      .catch((error) => this.emitError(conversationId, error instanceof Error ? error.message : String(error)));
    run.agent.abort();
    this.emitProjection(conversationId, 'run_stop_requested');
    return { stopped: true };
  }

  resetConversation(conversationId: string) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    for (const run of this.activeRunList(conversation)) run.agent.abort();
    conversation.agent.reset();
    this.cleanupProviderConversationResources(conversationId);
    this.userViewContextReminderTracker.reset(conversationId);
    void (async () => {
      await this.clearPendingApprovalsForConversation(conversationId, conversation);
      await this.clearPendingUserQuestionsForConversation(conversationId, 'conversation_reset');
      const previousConversation = conversation.eventState.conversation;
      await this.getEventStore().deleteConversation(conversationId);
      const eventState = createEmptyAgentEventReplayState();
      const fallbackDmAgentId = this.directMessageAgentId(conversation.eventState) ?? this.agentIdentity.agentId;
      const events = this.buildEvents(eventState, conversationId, [{
        type: 'conversation.created',
        actor: systemActor(),
        title: previousConversation?.title
          ?? (this.isCanonicalDmConversationId(conversationId) ? await this.displayNameForAgentId(fallbackDmAgentId) : 'Untitled'),
        members: previousConversation?.members.slice() ?? this.defaultConversationMembers(),
        goal: previousConversation?.goal,
      }]);
      await this.getEventStore().appendEvents(conversationId, events);
      for (const event of events) appendAgentEventToReplayState(eventState, event);
      this.publishPersistedEvents(conversationId, events);
      conversation.eventState = eventState;
      conversation.agent.state.messages = [];
      conversation.autoCompactConsecutiveFailures = 0;
      conversation.activeRuns.clear();
      conversation.activeRun = null;
      conversation.lastRun = null;
      conversation.pendingChannelTurns = [];
      conversation.channelTurnStartsInProgress = 0;
      // Tears down the detached idle watcher too: clearing channelDrainWaiters
      // without resolving them would orphan a parked watcher and leave
      // channelIdleEmitInFlight stuck true, blocking every later idle emit.
      this.teardownChannelDraining(conversation);
      conversation.pendingChildRunNotifications.length = 0;
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
    for (const run of this.activeRunList(conversation)) run.agent.abort();
    conversation.agent.abort();
    // Settle the detached idle watcher before dropping the conversation: an
    // unresolved parked watcher would pin it and could emit on a deleted one.
    this.teardownChannelDraining(conversation);
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
        runId: pending.runId,
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

  private async denyPendingApprovalForRuntime(
    conversationId: string,
    conversation: AgentConversationState,
    requestId: string,
    deniedReason: PermissionDeniedReason,
  ): Promise<boolean> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending || pending.conversationId !== conversationId) return false;

    this.pendingApprovals.delete(requestId);
    try {
      await this.appendConversationEvents(conversationId, conversation, [{
        type: 'approval.resolved',
        actor: systemActor(),
        runId: pending.runId,
        requestId,
        approved: false,
      }]);
    } catch (error) {
      this.emitError(conversationId, error instanceof Error ? error.message : String(error));
    } finally {
      this.emitConversationRuntimeEvent(conversationId, {
        type: 'approval_resolved',
        requestId,
        approved: false,
      });
      this.emitProjection(conversationId, 'approval.resolved');
      pending.resolve({ approved: false, deniedReason });
    }
    return true;
  }

  private async clearPendingPermissionNotices(conversationId: string, conversation: AgentConversationState): Promise<void> {
    const notices = [...this.pendingApprovals.entries()].filter(([, pending]) => (
      pending.conversationId === conversationId
      && pending.request.kind === 'permission_notice'
    ));
    for (const [requestId] of notices) {
      await this.denyPendingApprovalForRuntime(conversationId, conversation, requestId, 'runtime');
    }
  }

  private async clearPendingUserQuestionsForConversation(conversationId: string, reason: string) {
    for (const pending of [...this.pendingUserQuestions.values()]) {
      if (pending.conversationId === conversationId) await this.cancelUserQuestion(pending.requestId, reason);
    }
  }

  private async clearPendingUserQuestionsForRun(conversationId: string, runId: string, reason: string) {
    for (const pending of [...this.pendingUserQuestions.values()]) {
      if (pending.conversationId === conversationId && pending.runId === runId) {
        await this.cancelUserQuestion(pending.requestId, reason);
      }
    }
  }

  private async createConversationWithEventState(eventState: AgentEventReplayState) {
    if (!eventState.conversation) throw new Error('Cannot create agent runtime without conversation.created');
    const conversationId = eventState.conversation.id;
    this.reserveConversationId(conversationId);
    const existing = this.conversations.get(conversationId);
    if (existing) {
      for (const run of this.activeRunList(existing)) run.agent.abort();
    }
    existing?.unsubscribe?.();
    existing?.agent.abort();
    if (existing) clearPendingProjection(existing);
    if (existing) this.cleanupProviderConversationResources(conversationId);
    this.userViewContextReminderTracker.reset(conversationId);

    const providerConfig = await this.getActiveProviderConfig();
    const runtimeSettings = await this.getRuntimeSettings();
    const activePath = await this.deriveRuntimePiMessages(conversationId, eventState);
    const providerModel = providerConfig ? this.tryResolveProviderModel(providerConfig) : null;
    const defaultAgentId = this.defaultAgentIdForConversation(eventState);
    const conversationRef: { current: AgentConversationState | null } = { current: null };
    const agentRef: { current: Agent | null } = { current: null };
    const skillRuntime = new AgentSkillRuntime({
      localRoot: this.options.localFileRoot,
      additionalSkillDirectories: runtimeSettings.additionalSkillDirectories,
      provenanceStore: createAgentSkillProvenanceStore(),
      conversationId,
      permissionScopeProvider: () => (
        this.currentRuntimeConversation(conversationRef.current)?.activeRun?.id ?? null
      ),
      skillTrustApprovalHandler: async ({ skill, parentToolCallId, signal }) => {
        const current = this.currentRuntimeConversation(conversationRef.current);
        if (!current) return false;
        return this.requestSkillTrustApproval(conversationId, current, skill, parentToolCallId, signal);
      },
      executeSkillShell: async ({ command, skill, signal }) => {
        const activeSettings = await this.getRuntimeSettings();
        const globalPermissions = await readAgentToolPermissionConfig();
        const current = this.currentRuntimeConversation(conversationRef.current);
        return executeAgentSkillShellCommand({
          approvalHandler: current
            ? (input, signal) => this.requestToolApproval(conversationId, current, input, signal)
            : undefined,
          command,
          localRoot: this.options.localFileRoot,
          scratchRoot: this.scratchRoot(),
          permissionMode: this.options.permissionMode,
          allowedTools: skill.allowedTools,
          globalPermissions,
          permissionEventHandler: (input) => {
            const currentConversation = this.currentRuntimeConversation(conversationRef.current);
            return currentConversation ? this.appendToolPermissionEvent(conversationId, currentConversation, input) : Promise.resolve();
          },
          permissionNoticeHandler: (input, noticeSignal) => {
            const currentConversation = this.currentRuntimeConversation(conversationRef.current);
            return currentConversation ? this.showPermissionNotice(conversationId, currentConversation, input, noticeSignal) : Promise.resolve();
          },
          signal,
          toolCallId: `skill-shell-${randomUUID()}`,
        });
      },
      executeIsolatedSkill: async ({ skill, renderedContent, parentToolCallId, readOnlyIsolated }) => {
        const current = this.currentRuntimeConversation(conversationRef.current);
        if (!current) throw new Error('Cannot run isolated skill before the agent conversation is ready.');
        const data = await current.delegationRuntime.invokeSkillChildAgent({
          skillName: skill.name,
          description: skill.description,
          renderedContent,
          agent: skill.agent,
          model: skill.model,
          effort: skill.effort,
          allowedTools: skill.allowedTools,
          readOnlyIsolated,
        }, undefined, parentToolCallId);
        return {
          agentId: data.agent_id,
          agentType: data.agent_type,
          status: data.status,
          result: data.result,
          error: data.error,
        };
      },
    });
    skillRuntime.updateDisabledSkills(runtimeSettings.disabledSkills ?? []);
    skillRuntime.restoreInvokedSkillsFromMessages(activePath);
    const localWorkspace = createAgentLocalWorkspaceContext(this.options.localFileRoot, this.scratchRoot(), skillRuntime);
    const delegationRuntime = new AgentDelegationRuntime({
      conversationId,
      executingAgentId: defaultAgentId,
      memoryOwnerAgentId: defaultAgentId,
      localRoot: this.options.localFileRoot,
      scratchRoot: this.scratchRoot(),
      additionalAgentDirectories: runtimeSettings.additionalAgentDirectories,
      host: {
        createChildAgent: (input) => {
          if (!providerConfig) throw new Error('No enabled agent provider is configured.');
          return this.createChildPiAgent(conversationId, conversationRef, providerConfig, input);
        },
        getParentMessages: () => this.currentRuntimeAgent(agentRef.current)?.state.messages as AgentMessage[] ?? activePath,
        getParentSystemPrompt: () => this.currentRuntimeAgent(agentRef.current)?.state.systemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT,
        getParentAgentId: () => this.currentRuntimeConversation(conversationRef.current)?.activeRun?.executingAgentId ?? defaultAgentId,
        getParentMemoryOwnerAgentId: () => this.currentRuntimeConversation(conversationRef.current)?.activeRun?.executingAgentId ?? defaultAgentId,
        getActiveRunId: () => this.currentRuntimeConversation(conversationRef.current)?.activeRun?.id ?? null,
        getRuntimeSettings: () => this.getRuntimeSettings(),
        buildMemoryReminder: (agentId) => (
          this.buildMemoryReminder(agentId, conversationRef.current)
        ),
        childRunStarted: (snapshot, seed) => {
          const current = this.currentRuntimeConversation(conversationRef.current);
          if (!current) return Promise.resolve();
          return this.childRunStarted(conversationId, current, snapshot, seed);
        },
        childRunMessage: (snapshot, message) => (
          // No projection ping here: the conversation projection carries no
          // per-message child data, and an open drill-in panel polls the run
          // ledger while the run is live (the poll is meta-keyed, near-free).
          this.runLedger.appendMessage(snapshot.id, message, this.childRunActor(snapshot))
        ),
        childRunToolResultReplaced: (snapshot, toolCallId, text) => (
          this.runLedger.replaceToolResult(snapshot.id, toolCallId, text, this.childRunActor(snapshot))
        ),
        childRunCompacted: (snapshot, input) => (
          this.runLedger.compacted(snapshot.id, { ...input, actor: this.childRunActor(snapshot) })
        ),
        childRunStatusChanged: (snapshot) => {
          const current = this.currentRuntimeConversation(conversationRef.current);
          if (!current) return Promise.resolve();
          return this.childRunStatusChanged(conversationId, current, snapshot);
        },
        notifyChildRun: (snapshot) => {
          const current = this.currentRuntimeConversation(conversationRef.current);
          if (!current) return Promise.resolve();
          return this.notifyChildRun(conversationId, current, snapshot);
        },
        reportError: (report) => this.reportError(report),
        restoreChildRunLedger: (runId) => this.restoreChildRunLedger(conversationId, runId),
        persistToolOutputPayload: (toolCallId, toolName, text) => (
          this.persistToolOutputPayload(
            conversationId,
            toolCallId,
            toolName,
            text,
            this.currentRuntimeConversation(conversationRef.current)?.activeRun?.id ?? undefined,
          )
        ),
        completeCompactSummary: (compactConversationId, messages, model, customInstructions, signal) => (
          this.completeCompactSummary(compactConversationId, messages, model, customInstructions, signal)
        ),
      },
    });
    delegationRuntime.updateDisabledAgents(runtimeSettings.disabledAgents ?? []);
    delegationRuntime.restoreListedAgentsFromMessages(activePath);
    // null when the agent's model can't resolve yet (e.g. a custom endpoint with no
    // catalog and the profile still on 'inherit') — surfaced below as the same
    // configuration-error agent the built-in path produces, not a thrown open.
    const defaultAgentProfile = providerConfig && defaultAgentId !== this.agentIdentity.agentId
      ? await this.resolveAgentProfile(defaultAgentId, delegationRuntime, skillRuntime, { providerConfig }).catch(() => null)
      : null;
    // The built-in assistant owns its model/effort through a settings overlay, not
    // the provider connection — resolve it the same way a profile agent resolves
    // its own, while keeping the built-in's base system prompt unchanged.
    const builtInModelEffort = providerConfig && defaultAgentId === this.agentIdentity.agentId
      // null when the connection has no resolvable model yet (a fresh custom endpoint
      // with no assistant default chosen) — surfaced below as a configuration error.
      ? await this.resolveBuiltInAssistantModelEffort(providerConfig).catch(() => null)
      : null;
    if (defaultAgentProfile) {
      await this.getEventStore().writeAgentIdentity(defaultAgentProfile.identity);
    } else {
      await this.getEventStore().writeAgentIdentity(
        this.currentAgentIdentity(builtInModelEffort?.model ?? providerModel, builtInModelEffort?.thinkingLevel),
      );
    }
    const agentModel = defaultAgentProfile?.model ?? builtInModelEffort?.model ?? providerModel;
    const agentThinkingLevel = defaultAgentProfile?.thinkingLevel ?? builtInModelEffort?.thinkingLevel;
    const agentSystemPrompt = defaultAgentProfile?.systemPrompt ?? this.agentIdentity.systemPrompt;
    const defaultAgentDisplayName = defaultAgentProfile?.identity.displayName ?? this.agentIdentity.displayName;
    const agent = providerConfig && agentModel
      ? createConfiguredAgent(conversationId, providerConfig, activePath, this.outlinerToolHost, {
          localFileRoot: this.options.localFileRoot,
          localWorkspace,
          model: agentModel!,
          thinkingLevel: agentThinkingLevel,
          systemPrompt: agentSystemPrompt,
          permissionMode: this.options.permissionMode,
          runtimeSettingsLoader: () => this.getRuntimeSettings(),
          skillToolEnabled: runtimeSettings.automaticSkillsEnabled,
          skillRuntime,
          delegationRuntime,
          recall: this.createRecallToolRuntime(defaultAgentId, () => conversationId, () => conversationRef.current),
          askUserQuestion: this.createAskUserQuestionRuntime(() => conversationId, () => conversationRef.current),
          selfMaintenance: defaultAgentId === this.agentIdentity.agentId
            ? this.createSelfMaintenanceRuntime(() => conversationId, () => conversationRef.current)
            : undefined,
          allowedTools: defaultAgentProfile?.definition.tools,
          disallowedTools: defaultAgentProfile?.definition.disallowedTools,
          streamFn: this.options.streamFn,
          completeSimpleFn: this.options.completeSimpleFn,
          providerApiKeyLoader: this.options.providerApiKeyLoader,
          permissionEventHandler: (input) => {
            const current = conversationRef.current;
            return current ? this.appendToolPermissionEvent(conversationId, current, input) : Promise.resolve();
          },
          permissionNoticeHandler: (input, signal) => {
            const current = conversationRef.current;
            return current ? this.showPermissionNotice(conversationId, current, input, signal) : Promise.resolve();
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
        }, async (payload) => {
          try {
            await this.captureDebugRunSnapshot(conversationId, payload);
          } catch (error) {
            this.emitError(conversationId, error instanceof Error ? error.message : String(error));
          }
          return undefined;
        })
      : createConfigurationErrorAgent(
          conversationId,
          providerConfig
            ? 'No model is configured. Choose a default model for the assistant in Settings → Agents.'
            : 'No enabled agent provider is configured.',
          activePath,
        );
    agentRef.current = agent;

    const conversation: AgentConversationState = {
      agent,
      defaultAgentId,
      activeRuns: new Map(),
      activeRun: null,
      lastRun: null,
      autoCompactConsecutiveFailures: 0,
      autoCompactInProgress: false,
      eventState,
      activeCompaction: null,
      activeDream: null,
      pendingDreamFinishedMarkers: [],
      pendingChildRunNotifications: [],
      pendingEventAppend: Promise.resolve(),
      pendingProjectionLastEventType: null,
      pendingProjectionTimer: null,
      queuedFollowUpSkillListingReservation: null,
      reactiveCompactRequested: false,
      revision: 0,
      childRunNotificationFlushInProgress: false,
      runtimeSettings,
      skillRuntime,
      delegationRuntime,
      localWorkspace,
      toolResultBudgetState: restoreToolResultBudgetStateFromMessages(getAgentEventActivePath(eventState)),
      memberDisplayNames: {
        [this.agentIdentity.agentId]: this.agentIdentity.displayName,
        [defaultAgentId]: defaultAgentDisplayName,
      },
      povInspectorMemoryByAgentId: {},
      povInspectorMemoryRefreshInProgress: false,
      povInspectorMemoryRefreshQueued: false,
      pendingChannelTurns: [],
      channelTurnStartsInProgress: 0,
      channelStopRequested: false,
      channelDrainWaiters: new Set(),
      channelIdleEmitInFlight: false,
      channelIdleEmitToken: 0,
      unsubscribe: null,
    };
    conversationRef.current = conversation;
    await this.refreshMemberDisplayNames(conversation);
    await this.markInterruptedChildRunsOnRestore(conversationId, conversation);
    // Restore is records-only — no ledger IO on the conversation-open path. A
    // run's transcript is replayed from its own ledger lazily, on first resume
    // (restoreChildRunLedger) or drill-in (childRunTranscript).
    conversation.delegationRuntime.restorePersistedRuns(Object.values(conversation.eventState.childRuns ?? {}));
    agent.transformContext = async (_messages, signal) => this.contextManager.prepareModelContext(conversationId, conversation, signal);

    conversation.unsubscribe = agent.subscribe(async (event) => {
      await this.handlePiAgentEvent(conversationId, conversation, event);
      this.emitProjection(conversationId, event.type, event.type === 'message_update' ? 'coalesce' : 'immediate');
    });
    this.conversations.set(conversationId, conversation);
    this.queuePovInspectorMemoryRefresh(conversationId, conversation);
    this.emitProjection(conversationId, 'conversation_created');
    return conversation;
  }

  private async ensureConversationWithId(conversationId: string, titleOverride?: string) {
    const existing = this.conversations.get(conversationId);
    if (existing) return existing;
    let eventState = await this.loadEventState(conversationId);
    if (!eventState.conversation) {
      const dmAgentId = await this.agentIdForCanonicalDmConversationId(conversationId);
      if (dmAgentId) {
        await this.restoreOrCreateAgentDm(dmAgentId);
        return this.conversations.get(conversationId)!;
      }
      if (!titleOverride) throw new Error(`Agent conversation not found: ${conversationId}`);
      eventState = createEmptyAgentEventReplayState();
      const title = titleOverride?.trim() || 'Untitled';
      const events = this.buildEvents(eventState, conversationId, [{
        type: 'conversation.created',
        actor: systemActor(),
        title,
        members: this.defaultConversationMembers(),
        goal: title,
      }]);
      await this.getEventStore().appendEvents(conversationId, events);
      for (const event of events) appendAgentEventToReplayState(eventState, event);
      this.publishPersistedEvents(conversationId, events);
    }
    await this.createConversationWithEventState(eventState);
    return this.conversations.get(conversationId)!;
  }

  private async buildSkillListingReminder(conversation: AgentConversationState): Promise<string | null> {
    return (await this.reserveSkillListingReminder(conversation))?.text ?? null;
  }

  private async buildAgentListingReminder(conversation: AgentConversationState): Promise<string | null> {
    return conversation.delegationRuntime.reserveAgentListingReminderText(
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
        const definitions = await conversation.delegationRuntime.listAllAgentDefinitions();
        for (const definition of definitions) {
          names[agentDefinitionAgentId(definition)] = agentDefinitionDisplayName(definition);
        }
      } catch {
        // Registry unavailable: projections fall back to mention tokens.
      }
    }
    conversation.memberDisplayNames = names;
  }

  private queuePovInspectorMemoryRefresh(conversationId: string, conversation: AgentConversationState): void {
    if (conversation.povInspectorMemoryRefreshInProgress) {
      conversation.povInspectorMemoryRefreshQueued = true;
      return;
    }
    const members = conversation.eventState.conversation?.members ?? [];
    if (!isMultiAgentConversation(members)) {
      conversation.povInspectorMemoryByAgentId = {};
      return;
    }
    conversation.povInspectorMemoryRefreshQueued = false;
    conversation.povInspectorMemoryRefreshInProgress = true;
    void this.refreshPovInspectorMemory(conversation)
      .then((next) => {
        conversation.povInspectorMemoryByAgentId = next;
        if (this.conversations.get(conversationId) === conversation) {
          this.emitProjection(conversationId, 'pov_inspector_memory_refreshed', 'coalesce');
        }
      })
      .catch((error) => {
        this.reportWarn(
          'persistence',
          `Failed to refresh agent POV inspector memory: ${error instanceof Error ? error.message : String(error)}`,
          error,
          { operation: 'refreshPovInspectorMemory' },
          'agent-pov-inspector-memory-failed',
        );
      })
      .finally(() => {
        conversation.povInspectorMemoryRefreshInProgress = false;
        if (conversation.povInspectorMemoryRefreshQueued && this.conversations.get(conversationId) === conversation) {
          this.queuePovInspectorMemoryRefresh(conversationId, conversation);
        }
      });
  }

  private async refreshPovInspectorMemory(
    conversation: AgentConversationState,
  ): Promise<Record<string, string | null>> {
    const next: Record<string, string | null> = {};
    const agentMembers = channelAgentMembers(conversation.eventState.conversation?.members ?? []);
    await Promise.all(agentMembers.map(async (member) => {
      next[member.agentId] = await this.buildPovInspectorMemoryBriefing(member.agentId, conversation);
    }));
    return next;
  }

  private queuePovInspectorMemoryRefreshForPrincipal(principal: AgentPrincipal): void {
    for (const [conversationId, conversation] of this.conversations) {
      const members = conversation.eventState.conversation?.members ?? [];
      if (members.some((member) => samePrincipal(member, principal))) {
        this.queuePovInspectorMemoryRefresh(conversationId, conversation);
      }
    }
  }

  private async refreshRuntimeSettings(conversation: AgentConversationState): Promise<AgentRuntimeSettings> {
    const runtimeSettings = await this.getRuntimeSettings();
    conversation.runtimeSettings = runtimeSettings;
    conversation.skillRuntime.updateAdditionalSkillDirectories(runtimeSettings.additionalSkillDirectories);
    conversation.skillRuntime.updateDisabledSkills(runtimeSettings.disabledSkills ?? []);
    conversation.delegationRuntime.updateDisabledAgents(runtimeSettings.disabledAgents ?? []);
    this.applyRuntimeToolSettings(conversation);
    return runtimeSettings;
  }

  private applyRuntimeToolSettings(conversation: AgentConversationState): void {
    conversation.delegationRuntime.updateAdditionalAgentDirectories(conversation.runtimeSettings.additionalAgentDirectories);
    const activeRun = conversation.activeRun;
    if (
      activeRun
      && activeRun.executingAgentId !== this.agentIdentity.agentId
      && activeRun.channelDefinition
    ) {
      this.applyChannelTurnToolSettings(conversation, activeRun.executingAgentId, activeRun.channelDefinition);
      return;
    }
    conversation.agent.state.tools = createAgentTools(this.outlinerToolHost, {
      localFileRoot: this.options.localFileRoot,
      localWorkspace: conversation.localWorkspace,
      skillRuntime: conversation.skillRuntime,
      skillToolEnabled: conversation.runtimeSettings.automaticSkillsEnabled,
      delegationRuntime: conversation.delegationRuntime,
      recall: this.createRecallToolRuntime(this.agentIdentity.agentId, () => conversation.eventState.conversation?.id ?? 'unknown', () => conversation),
      askUserQuestion: this.createAskUserQuestionRuntime(() => conversation.eventState.conversation?.id ?? 'unknown', () => conversation),
      selfMaintenance: this.createSelfMaintenanceRuntime(() => conversation.eventState.conversation?.id ?? 'unknown', () => conversation),
    });
  }

  private createChildPiAgent(
    parentConversationId: string,
    parentConversationRef: { current: AgentConversationState | null },
    providerConfig: AgentProviderRuntimeConfig,
    input: AgentChildAgentCreateInput,
  ): Agent {
    const { model, thinkingLevel } = resolveAgentModelEffort(
      input.model,
      input.effort,
      providerConfig,
      () => this.tryResolveProviderModel(providerConfig),
    );
    // Attribution for this run's gated/denied approvals, resolved at the delegation
    // layer from the authoritative context mode (fresh consult → the consultee;
    // fork → inherited; the user's own agent → undefined). The card resolves the id
    // to its canonical mention; undefined leaves it unattributed.
    const requestedByAgentId = input.requestedByAgentId;
    return createConfiguredAgent(input.conversationId, providerConfig, input.messages, this.outlinerToolHost, {
      localFileRoot: this.options.localFileRoot,
      localWorkspace: input.localWorkspace,
      model,
      thinkingLevel,
      permissionMode: input.permissionMode ?? this.options.permissionMode,
      runtimeSettingsLoader: () => this.getRuntimeSettings(),
      skillToolEnabled: true,
      skillRuntime: input.skillRuntime,
      delegationRuntime: input.delegationRuntime,
      recall: this.createRecallToolRuntime(
        input.memoryOwnerAgentId,
        () => input.conversationId,
        () => parentConversationRef.current,
      ),
      streamFn: this.options.streamFn,
      completeSimpleFn: this.options.completeSimpleFn,
      providerApiKeyLoader: this.options.providerApiKeyLoader,
      permissionEventHandler: (eventInput) => {
        const parentConversation = this.currentRuntimeConversation(parentConversationRef.current);
        return parentConversation ? this.appendToolPermissionEvent(parentConversationId, parentConversation, eventInput) : Promise.resolve();
      },
      permissionNoticeHandler: (noticeInput, signal) => {
        const parentConversation = this.currentRuntimeConversation(parentConversationRef.current);
        return parentConversation ? this.showPermissionNotice(parentConversationId, parentConversation, noticeInput, signal, requestedByAgentId) : Promise.resolve();
      },
      systemPrompt: input.systemPrompt,
      l0CacheBreakpointEnabled: input.l0CacheBreakpointEnabled,
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
          const parentConversation = this.currentRuntimeConversation(parentConversationRef.current);
          if (!parentConversation) return Promise.resolve({ approved: false, deniedReason: 'runtime' });
          // Attribute a consultee's gated capability to it (undefined for forks /
          // the parent's own agent — those stay unattributed).
          return this.requestToolApproval(parentConversationId, parentConversation, approvalInput, signal, requestedByAgentId);
        },
      afterToolResult: input.afterToolResult,
    });
  }

  /**
   * Re-register the run's ledger writer (and re-derive its transcript) from the
   * run's OWN ledger — the resume path's restore. Returns null when no ledger
   * exists; the writer is then registered empty, so the resume's `run.started`
   * becomes the ledger's first event (a conversation record whose seed never
   * landed stays resumable instead of wedging on "Unknown child-run ledger").
   */
  private async restoreChildRunLedger(conversationId: string, runId: string): Promise<AgentMessage[] | null> {
    const state = await this.runLedger.restore(conversationId, runId);
    if (!state) {
      this.runLedger.register(conversationId, runId);
      return null;
    }
    return this.deriveRuntimePiMessages(conversationId, state);
  }

  private async markInterruptedChildRunsOnRestore(
    conversationId: string,
    conversation: AgentConversationState,
  ): Promise<void> {
    const runningRuns = Object.values(conversation.eventState.childRuns ?? {})
      .filter((run) => run.status === 'running');
    if (runningRuns.length === 0) return;

    const interruptedError = 'The delegated child run was interrupted before conversation restore.';
    const completedAt = Date.now();
    // Mirror the terminal into each run's OWN ledger first — without it the run
    // stream would self-describe as `running` forever, contradicting the
    // conversation record. Contained per run: a corrupt child ledger must
    // degrade to a warning, never block opening the parent conversation.
    for (const run of runningRuns) {
      try {
        await this.runLedger.markInterrupted(conversationId, run.id, {
          actor: systemActor(),
          errorMessage: interruptedError,
        });
      } catch (error) {
        this.reportWarn(
          'persistence',
          `Could not mirror the interruption into run ledger ${run.id}: ${error instanceof Error ? error.message : String(error)}`,
          error,
          { conversationId, runId: run.id, operation: 'markInterrupted' },
          'child-run-interruption-ledger-failed',
        );
      }
    }
    await this.appendConversationEvents(conversationId, conversation, runningRuns.map((run): AgentEventInput => ({
      type: 'child_run.updated',
      actor: systemActor(),
      childRunId: run.id,
      status: 'failed',
      completedAt,
      error: interruptedError,
    })));

    // "Don't go silent": a background child run that died while the app was closed
    // must still raise a durable badge (and OS banner) on restore — not vanish.
    // Durable delivery only here (no live model-injection): the conversation is being
    // restored, not running a turn, and recovery is re-spawn, not resume.
    for (const run of runningRuns) {
      await this.emitTaskNotification(conversationId, conversation, {
        notificationId: `notification-${run.id}-${completedAt}`,
        kind: 'task_failed',
        title: `Agent task "${run.description}" was interrupted.`,
        body: interruptedError,
        source: { type: 'run', runId: run.id },
        actor: run.parentToolCallId
          ? toolActor(AGENT_DELEGATE_TOOL_NAME, run.parentToolCallId)
          : systemActor(),
      });
    }
  }

  private childRunActor(snapshot: AgentChildRunSnapshot): AgentActor {
    return snapshot.parentToolCallId
      ? toolActor(AGENT_DELEGATE_TOOL_NAME, snapshot.parentToolCallId)
      : systemActor();
  }

  /**
   * A child run started ([[agent-run-unification]] Design 1): append the slim
   * `child_run.started` conversation marker (the boundary-row/task-panel feed)
   * and seed the child's OWN run ledger — context before `run.started`, the
   * directive after it.
   */
  private async childRunStarted(
    conversationId: string,
    conversation: AgentConversationState,
    snapshot: AgentChildRunSnapshot,
    seed: { contextMessages: readonly AgentMessage[]; evidenceMessages: readonly AgentMessage[] },
  ): Promise<void> {
    const actor = this.childRunActor(snapshot);
    // Ledger seed BEFORE the conversation marker: if the seed fails (crash,
    // disk error) the spawn aborts with no conversation record — an orphan
    // ledger directory is invisible and harmless, while the reverse order
    // would leave a permanently un-resumable phantom run in the conversation.
    await this.runLedger.runStarted({
      conversationId,
      runId: snapshot.id,
      agentId: snapshot.executingAgentId as AgentId,
      parentRunId: snapshot.parentRunId,
      actor,
      contextMessages: seed.contextMessages,
      evidenceMessages: seed.evidenceMessages,
    });
    await this.appendConversationEvents(conversationId, conversation, [{
      type: 'child_run.started',
      actor,
      childRunId: snapshot.id,
      parentRunId: snapshot.parentRunId,
      parentToolCallId: snapshot.parentToolCallId,
      executingAgentId: snapshot.executingAgentId,
      parentAgentId: snapshot.parentAgentId,
      memoryOwnerAgentId: snapshot.memoryOwnerAgentId,
      memoryOriginWorkspace: snapshot.memoryOriginWorkspace,
      name: snapshot.name,
      description: snapshot.description,
      prompt: snapshot.prompt,
      agentType: snapshot.agentType,
      contextMode: snapshot.contextMode,
      unattended: snapshot.unattended,
    }]);
    this.emitProjection(conversationId, 'child_run.started', 'coalesce');
  }

  private async childRunStatusChanged(
    conversationId: string,
    conversation: AgentConversationState,
    snapshot: AgentChildRunSnapshot,
  ): Promise<void> {
    await this.appendConversationEvents(conversationId, conversation, [{
      type: 'child_run.updated',
      actor: this.childRunActor(snapshot),
      childRunId: snapshot.id,
      status: snapshot.status,
      completedAt: snapshot.completedAt,
      result: snapshot.result,
      error: snapshot.error,
    }]);
    await this.runLedger.statusChanged(snapshot.id, snapshot.status, {
      actor: this.childRunActor(snapshot),
      errorMessage: snapshot.error,
      agentId: snapshot.executingAgentId as AgentId,
      parentRunId: snapshot.parentRunId,
    });
    this.emitProjection(conversationId, 'child_run.updated', 'coalesce');
  }

  private async notifyChildRun(
    conversationId: string,
    conversation: AgentConversationState,
    snapshot: AgentChildRunSnapshot,
  ): Promise<void> {
    if (snapshot.status === 'running') return;
    // A user-initiated stop (cancelled) is the user's own action — it raises no
    // badge/OS banner (the durable notification below is for completion/failure
    // only). The live model-injection still fires so a foreground agent learns
    // its child stopped.
    if (snapshot.status !== 'cancelled') {
      // Durable per-conversation delivery: emit the attention/OS signal as a
      // notification.created event anchored to the origin conversation. This is the
      // restart-safe record (the in-memory model-injection below is the live-conversation
      // composed-turn layer; it is best-effort and not the durability guarantee).
      // The id keys on the completion instant so a *resumed* detached run that
      // finishes again gets a fresh notification (idempotent across replay, distinct
      // across re-completions — see agentDelegation `send`).
      await this.emitTaskNotification(conversationId, conversation, {
        notificationId: `notification-${snapshot.id}-${snapshot.completedAt ?? 0}`,
        kind: childRunNotificationKind(snapshot.status),
        title: childRunNotificationTitle(snapshot),
        body: snapshot.status === 'failed' ? snapshot.error : snapshot.result,
        source: { type: 'run', runId: snapshot.id },
        actor: this.childRunActor(snapshot),
      });
    }
    conversation.pendingChildRunNotifications.push(formatChildRunNotification(snapshot));
    void this.flushChildRunNotifications(conversationId, conversation).catch((error) => {
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
      /** Badge-only when false: fold unread but skip the OS notification (default true). */
      deliverOs?: boolean;
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
    if (input.deliverOs !== false) this.deliverOsNotification({ title: input.title, body, conversationId });
  }

  private async flushChildRunNotifications(conversationId: string, conversation: AgentConversationState): Promise<void> {
    if (conversation.childRunNotificationFlushInProgress) return;
    if (conversation.pendingChildRunNotifications.length === 0) return;
    // A notification-delivery run is the COORDINATOR's turn (its child runs);
    // never interleave it into active Channel member turns.
    if (this.hasActiveRuns(conversation) || conversation.pendingChannelTurns.length > 0) return;

    conversation.childRunNotificationFlushInProgress = true;
    let startedRunId: string | null = null;
    try {
      while (conversation.pendingChildRunNotifications.length > 0) {
        if (this.hasActiveRuns(conversation) || conversation.pendingChannelTurns.length > 0) break;
        const notifications = conversation.pendingChildRunNotifications.splice(0);
        const prompt: UserMessage = {
          role: 'user',
          timestamp: Date.now(),
          content: [{ type: 'text', text: systemReminder(notifications.join('\n\n')) }],
        };
        conversation.skillRuntime.resetRunPermissionRules();
        await this.appendSystemPromptEvent(conversationId, conversation, prompt);
        startedRunId = await this.startRun(conversationId, conversation, prompt);
        await conversation.agent.prompt(prompt);
        await this.contextManager.runReactiveCompactRetryIfNeeded(conversationId, conversation);
        await this.persistAndEmitIdle(conversationId, conversation, { flushChildRunNotifications: false });
      }
    } catch (error) {
      await this.recoverFromRunError(conversationId, startedRunId);
      this.emitError(conversationId, error instanceof Error ? error.message : String(error));
    } finally {
      conversation.childRunNotificationFlushInProgress = false;
    }
  }

  private async persistToolOutputPayload(
    conversationId: string,
    toolCallId: string,
    toolName: string,
    text: string,
    runIdOverride?: string,
  ): Promise<{ payload: AgentPayloadRef; label: string }> {
    const conversation = this.conversations.get(conversationId);
    const runId = runIdOverride ?? (conversation ? this.activeRunId(conversation) ?? undefined : undefined);
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
    // Summaries run on the assistant's resolved model (handles custom endpoints,
    // where the provider connection has no catalog default).
    const model = modelOverride ?? (await this.resolveBuiltInAssistantModelEffort(providerConfig)).model;
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

  /**
   * Run-grounded debug capture ([[agent-debug-run-grounded]]): persist the active
   * run's outbound system prompt + tool schemas once, re-emitting only when they
   * change (hash-deduped). The message window is already event-sourced; this fills
   * the request context the ledger lacks. The event carries the run id, so the
   * conversation append path splits it into the run's own stream. Additive and
   * best-effort — a capture failure never perturbs the run.
   */
  private async captureDebugRunSnapshot(conversationId: string, payload: unknown, runIdOverride?: string) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    const runId = runIdOverride ?? this.activeRunId(conversation);
    if (!runId) return;
    const { systemPrompt, tools } = extractRunSnapshotFromPayload(payload);
    const systemHash = createHash('sha256').update(systemPrompt).digest('hex');
    const toolsHash = createHash('sha256').update(JSON.stringify(tools)).digest('hex');
    const combined = `${systemHash}:${toolsHash}`;
    if (this.debugRunSnapshotHashByRun.get(runId) === combined) return;
    await this.appendConversationEvents(conversationId, conversation, [{
      type: 'debug.run_snapshot.created',
      actor: systemActor(),
      runId,
      systemPrompt,
      systemHash,
      tools,
      toolsHash,
    }]);
    // Record the hash only AFTER the append succeeds — a swallowed append failure
    // must not poison the dedupe and silently drop this run's snapshot forever.
    this.rememberDebugRunSnapshotHash(runId, combined);
  }

  private async persistAndEmitIdle(
    conversationId: string,
    conversation: AgentConversationState,
    options: { flushChildRunNotifications?: boolean; emitGuard?: () => boolean } = {},
  ) {
    await this.flushPendingDreamFinishedEvents(conversationId, conversation);
    conversation.agent.state.messages = await this.deriveRuntimePiMessages(conversationId, conversation.eventState) as never;
    // The detached idle watcher passes a guard: a teardown (reset/close/delete)
    // landing during the awaits above must abort the emit, or an `agent_idle`
    // projection races/duplicates the `conversation_reset` emit (or fires on a
    // closed conversation).
    if (options.emitGuard && !options.emitGuard()) return;
    this.emitProjection(conversationId, 'agent_idle');
    if (options.flushChildRunNotifications !== false) {
      await this.flushChildRunNotifications(conversationId, conversation);
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
    const pending: Promise<unknown>[] = [this.dreamMemoryExtractionTail, this.commandSweepTail];
    for (const conversation of this.conversations.values()) pending.push(conversation.pendingEventAppend);
    // Delegated-run ledgers append on their own per-run queues — settle them
    // too, or a quit can keep the conversation's terminal marker while losing
    // the ledger's own run.completed (the run stream then self-reports running).
    pending.push(...this.runLedger.pendingWrites());
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
      const message = error instanceof Error ? error.message : String(error);
      this.emitError(
        this.commandConversationId(command.nodeId),
        message,
        {
          domain: 'command',
          code: 'scheduled-command-failed',
          context: {
            commandNodeId: command.nodeId,
            attempt: attempt + 1,
            delayMs: delay,
            dueAt: command.dueAt,
          },
          error,
        },
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

  // A scheduled fire: no human turn, runs as a child run on the delivery conversation.
  private async startTriggeredRun(command: DueCommand): Promise<void> {
    const brief = command.brief.trim();
    // Defensive: `selectDueCommands` already drops empty-brief commands, so this
    // throw is unreachable in normal operation — but it guarantees an empty
    // command can never reach the watermark advance in `fireCommand`.
    if (!brief) throw new Error('This command has no brief to run.');
    await this.runCommandChildAgent(
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
      await this.runCommandChildAgent(conversationId, brief, node.commandAgent, node.sysLastRunAt ?? null);
      return { conversationId: conversationId };
    } finally {
      this.firingCommandNodeIds.delete(nodeId);
    }
  }

  // Shared no-human-turn execution for command runs (scheduled + Run-now). The
  // brief — the command title plus its non-field child outline (see
  // `commandBriefText`) — is run as a DELEGATED child run anchored to the command's own
  // delivery conversation, so every fire shows up as a task in that conversation's
  // task panel. `agent` picks the executing agent definition (an
  // `AgentDefinition.name`); empty forks the otherwise-empty delivery conversation
  // so the run executes under the main agent's identity and capabilities. Resolves
  // only when the child run reaches a terminal state; throws on failure/stop so the
  // caller leaves the watermark unadvanced and arms the failure backoff.
  private async runCommandChildAgent(
    conversationId: string,
    brief: string,
    agent: string | undefined,
    lastSuccessAt: number | null,
  ): Promise<void> {
    const conversation = await this.ensureConversationWithId(conversationId, commandConversationTitle(brief));
    await this.refreshRuntimeSettings(conversation);
    const agentType = agent?.trim() ? agent.trim() : undefined;
    let data = await conversation.delegationRuntime.invokeAgent({
      agent_type: agentType,
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
      data = await conversation.delegationRuntime.status({
        agent_id: data.agent_id,
        wait: true,
        timeout_ms: COMMAND_CHILD_RUN_WAIT_MS,
      });
    }
    if (data.status === 'failed' || data.error) throw new Error(data.error || 'The command run failed.');
    if (data.status === 'cancelled') throw new Error('The command run was stopped before completing.');
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
    // Gates before any scanning: a disabled/read-only/provider-less pass must
    // not pay the all-conversations replay sweep just to bail per pool.
    if (!await this.dreamPassGatesOpen()) return;
    // ONE replay sweep per pass: every pool reads this harvest instead of
    // re-replaying every conversation per principal.
    const childRunHarvest = await this.harvestChildRunRecords();
    const principals = await this.listDreamPrincipals(childRunHarvest);
    // Drop failure-backoff entries for pools that are no longer dream principals (e.g. a deleted
    // agent), so the in-memory map stays bounded to live pools. A live pool with an armed window
    // is always in this set (it ran a Dream to arm it), so its backoff is never pruned here.
    const liveKeys = new Set(principals.map(principalKey));
    for (const key of this.dreamFailureBackoff.keys()) {
      if (!liveKeys.has(key)) this.dreamFailureBackoff.delete(key);
    }
    for (const principal of principals) {
      try {
        await this.fireDreamForPool(principal, trigger, now, childRunHarvest);
      } catch (error) {
        this.reportWarn(
          'dream',
          `Dream pass failed for ${principalKey(principal)}: ${error instanceof Error ? error.message : String(error)}`,
          error,
          { principalKey: principalKey(principal), operation: 'fireDreamForPool' },
          'dream-pass-failed',
        );
      }
    }
  }

  /** The pass-level Dream gates (also re-checked per task for the manual path). */
  private async dreamPassGatesOpen(): Promise<boolean> {
    if (!this.dreamMemoryExtractionEnabled()) return false;
    if ((await this.dreamMemoryScope()).readOnly) return false;
    return Boolean(await this.getActiveProviderConfig());
  }

  /** Every pool with a Dream: the user pool plus each known agent's pool. */
  private async listDreamPrincipals(harvest?: DreamChildRunHarvest): Promise<AgentPrincipal[]> {
    const agentIds = new Set<string>([this.agentIdentity.agentId]);
    for (const { runs } of harvest ?? await this.harvestChildRunRecords()) {
      for (const run of runs) agentIds.add(this.memoryOwnerAgentIdForChildRun(run));
    }
    return [this.userPrincipal(), ...[...agentIds].sort().map((agentId): AgentPrincipal => ({ type: 'agent', agentId }))];
  }

  /** Run one pool's Dream, serialized per pool by `principalKey`. */
  private async fireDreamForPool(
    principal: AgentPrincipal,
    trigger: AgentDreamTrigger,
    now: Date,
    childRunHarvest?: DreamChildRunHarvest,
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
      const task = await this.createDreamMemoryExtractionTask(principal, trigger, now, childRunHarvest);
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
    childRunHarvest?: DreamChildRunHarvest,
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
          runs: await this.collectDreamRunInputs(
            principal.agentId,
            dreamState.watermark,
            childRunHarvest ?? await this.harvestChildRunRecords(),
          ),
        }
      : {
          conversations: await this.collectDreamConversationInputs(dreamState),
          runs: [],
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

  private buildDreamMemoryExtractionBatches(
    runId: string,
    memoryScope: AgentDreamMemoryScope,
    inputs: {
      conversations: readonly {
        conversationId: string;
        events: readonly AgentEvent[];
        fromSeqExclusive: number;
      }[];
      runs: readonly DreamMemoryExtractionRunInput[];
    },
  ): AgentDreamMemoryExtractionBatch[] {
    const batches: AgentDreamMemoryExtractionBatch[] = [];
    const conversationSpan = buildDreamMemoryExtractionSpanFromEvidence(runId, {
      conversations: inputs.conversations,
      runs: [],
    });
    if (conversationSpan) {
      batches.push({
        span: conversationSpan,
        originWorkspace: memoryScope.originWorkspace,
      });
    }

    // Run evidence still groups by the workspace each run happened in, so a new fact's
    // provenance tag names where it was learned — grouping is for tagging, not partitioning.
    for (const group of groupDreamRunInputsByOriginWorkspace(inputs.runs)) {
      const span = buildDreamMemoryExtractionSpanFromEvidence(runId, {
        conversations: [],
        runs: group.inputs,
      });
      if (!span) continue;
      batches.push({
        span,
        originWorkspace: group.originWorkspace ?? memoryScope.originWorkspace,
      });
    }
    return batches;
  }

  /** One sweep over every conversation's childRuns records (the per-pass harvest). */
  private async harvestChildRunRecords(): Promise<DreamChildRunHarvest> {
    const harvest: DreamChildRunHarvest = [];
    for (const conversationId of await this.getEventStore().listConversationIds()) {
      const state = await this.getEventStore().replay(conversationId);
      const runs = Object.values(state.childRuns ?? {});
      if (runs.length > 0) harvest.push({ conversationId, runs });
    }
    return harvest;
  }

  private async collectDreamRunInputs(
    agentId: string,
    watermark: AgentDreamWatermark,
    harvest: DreamChildRunHarvest,
  ): Promise<DreamMemoryExtractionRunInput[]> {
    const inputs: DreamMemoryExtractionRunInput[] = [];
    for (const { conversationId, runs } of harvest) {
      for (const run of runs) {
        if (run.status === 'running') continue;
        const owner = this.memoryOwnerAgentIdForChildRun(run);
        if (owner !== agentId) continue;

        // Already-consolidated skip BEFORE the ledger file read: the watermark
        // records the scanned tail seq, so one tiny run-meta read settles a
        // terminal run that was already digested.
        const cursorSeq = watermark.runs?.[run.id]?.seq ?? 0;
        if (cursorSeq > 0) {
          const meta = await this.getEventStore().readRunMetaProjection(run.id);
          if (meta && meta.latestSeq <= cursorSeq) continue;
        }

        // The run's own ledger digests like any stream ([[agent-run-unification]]
        // Design 3): one `{seq, eventId}` cursor, no payload pinning, no positional
        // coordinates. The fork boundary is structural — the ledger's first
        // `run.started` seq — so a compaction can never stale it.
        const events = await this.getEventStore().readRunStreamEvents(run.id);
        if (events.length === 0) continue;
        // No `run.started` means the ledger has no evidence boundary (a partial
        // seed/crash artifact). A 0 fallback would leak the inherited fork
        // prefix into this run's evidence — skip rather than over-collect.
        const boundarySeq = events.find((event) => event.type === 'run.started')?.seq;
        if (boundarySeq === undefined) continue;
        const fromSeqExclusive = Math.max(cursorSeq, boundarySeq);
        const latestSeq = events.at(-1)?.seq ?? 0;
        if (latestSeq <= fromSeqExclusive) continue;
        inputs.push({
          conversationId,
          agentId,
          runId: run.id,
          originWorkspace: run.memoryOriginWorkspace,
          events,
          fromSeqExclusive,
        });
      }
    }
    return inputs;
  }

  private memoryOwnerAgentIdForChildRun(run: AgentChildRunRecord): string {
    return resolveChildRunMemoryOwner(run, this.agentIdentity.agentId);
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
      // Dream runs on the assistant's resolved model (handles custom endpoints).
      const model = (await this.resolveBuiltInAssistantModelEffort(providerConfig)).model;
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
        const parsed = parseDreamMemoryExtractionResponse(assistantMessageText(response));
        let episodeSources: AgentMemorySource[] | null = null;
        const sourcesForCommittedChange = async (): Promise<AgentMemorySource[]> => {
          if (episodeSources) return episodeSources;
          if (batch.span.sources.length === 0) {
            episodeSources = [];
            return episodeSources;
          }
          const episode = await this.getEventStore().recordMemoryEpisode(task.principal, {
            gist: parsed.episodeGist ?? fallbackEpisodeGist(batch.span),
            originWorkspace: batch.originWorkspace,
            sources: batch.span.sources,
          });
          episodeSources = [{ episodeId: episode.id }];
          return episodeSources;
        };
        // Crash-retry dedup window: applyDreamMemoryActions matches new facts against this
        // list by fact key, so it must see as much of the pool as the store allows (200 =
        // query clamp max) or a re-run after a crash re-saves entries past the window.
        const currentMemories = await this.getEventStore().listMemoryEntries(task.principal, { limit: 200 });
        addDreamChanges(changes, parsed.actions.length > 0
          ? await this.applyDreamMemoryActions(task, batch, parsed.actions, currentMemories, sourcesForCommittedChange)
          : emptyDreamChanges());
      }
      const completed = await this.getEventStore().appendDreamCompleted(task.principal, {
        runId: task.runId,
        trigger: task.trigger,
        startedAt: task.startedAt,
        watermark: task.watermark,
        processed: {
          conversations: dreamProcessedConversations(task.span.sourceRanges),
          runs: dreamProcessedRuns(task.span.sourceRanges),
          totalMessageCount: task.span.totalMessageCount,
          totalCharCount: task.span.totalCharCount,
          consolidateOnly: task.span.consolidateOnly,
        },
        changes,
      });
      await this.writeDreamRunMeta(task, 'completed', model);
      this.clearChildRunMemoryReminderCaches();
      if (changes.added > 0 || changes.updated > 0 || changes.forgotten > 0) {
        this.queuePovInspectorMemoryRefreshForPrincipal(task.principal);
      }
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
      this.reportWarn(
        'dream',
        `Dream memory extraction skipped: ${message}`,
        error,
        {
          agentId: this.agentIdentity.agentId,
          runId: task.runId,
          principalKey: principalKey(task.principal),
          operation: 'extractDreamMemory',
        },
        'dream-memory-extraction-failed',
      );
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
    sourcesForCommittedChange: () => Promise<readonly AgentMemorySource[]>,
  ): Promise<AgentDreamCompletedChanges> {
    const changes = emptyDreamChanges();
    const entriesById = new Map(initialEntries.map((entry) => [entry.id, entry]));
    const activeFactKeys = new Set(initialEntries.map((entry) => memoryFactKey(entry.fact)));
    for (const action of actions) {
      if (action.type === 'add') {
        const key = memoryFactKey(action.fact);
        if (activeFactKeys.has(key)) {
          changes.skipped += 1;
          continue;
        }
        const sources = await sourcesForCommittedChange();
        if (sources.length === 0) {
          changes.skipped += 1;
          continue;
        }
        const entry = await this.getEventStore().addMemoryEntry(task.principal, {
          fact: action.fact,
          originWorkspace: batch.originWorkspace,
          sources: [...sources],
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
      const sources = batch.span.consolidateOnly ? [] : await sourcesForCommittedChange();
      if (!batch.span.consolidateOnly && sources.length === 0) {
        changes.skipped += 1;
        continue;
      }
      const updated = await this.getEventStore().updateMemoryEntry(task.principal, current.id, {
        fact: action.fact,
        originWorkspace: current.originWorkspace ?? batch.originWorkspace,
        sources: mergeMemorySources(current.sources, sources),
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

  private canonicalDmConversationId(agentId: string) {
    return `lin-agent-dm-${hashJson({
      userId: LOCAL_USER_ID,
      agentId,
    }).slice(0, 16)}`;
  }

  private createChannelId() {
    return `lin-agent-channel-${randomUUID()}`;
  }

  private isCanonicalDmConversationId(conversationId: string) {
    return conversationId.startsWith('lin-agent-dm-');
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

  private directMessageAgentId(eventState: AgentEventReplayState): string | null {
    if (eventState.conversation?.goal) return null;
    const agentMembers = channelAgentMembers(eventState.conversation?.members ?? []);
    return agentMembers.length === 1 ? agentMembers[0]!.agentId : null;
  }

  private defaultAgentIdForConversation(eventState: AgentEventReplayState): string {
    return this.directMessageAgentId(eventState) ?? this.agentIdentity.agentId;
  }

  private createMessageId(prefix: string) {
    return `${prefix}-${randomUUID()}`;
  }

  private agentActor(): AgentActor {
    return { type: 'agent', agentId: this.agentIdentity.agentId };
  }

  /** Actor for the in-flight run's emissions: the executing member, not always the main agent. */
  private runActor(conversation: AgentConversationState): AgentActor {
    return { type: 'agent', agentId: conversation.activeRun?.executingAgentId ?? conversation.defaultAgentId };
  }

  private activeRunId(conversation: AgentConversationState): string | null {
    return conversation.activeRun?.id ?? conversation.activeRuns.keys().next().value ?? null;
  }

  private requireActiveRun(conversation: AgentConversationState): AgentActiveRunState {
    const activeRun = conversation.activeRun ?? conversation.activeRuns.values().next().value;
    if (!activeRun) throw new Error('Agent run state is not active.');
    return activeRun;
  }

  private activeRunList(conversation: AgentConversationState): AgentActiveRunState[] {
    return [...conversation.activeRuns.values()].sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
  }

  private hasActiveRuns(conversation: AgentConversationState): boolean {
    return conversation.activeRuns.size > 0 || conversation.agent.state.isStreaming;
  }

  private activeChannelRuns(conversation: AgentConversationState): AgentActiveRunState[] {
    return this.activeRunList(conversation).filter((run) => run.channelTurn);
  }

  private activeOrStartingChannelRunCount(conversation: AgentConversationState): number {
    return this.activeChannelRuns(conversation).length + conversation.channelTurnStartsInProgress;
  }

  private maybeClearChannelStopRequested(conversation: AgentConversationState): void {
    // Clear once the stopped round's runs have drained — deliberately NOT gated on
    // pendingChannelTurns being empty. `stopConversation` synchronously discards the
    // pending-at-stop-time turns (discardPendingChannelTurns), and hand-offs are
    // suppressed while the flag is set, so any pending that appears afterward is a
    // NEW user send. It must resume the Channel; gating on pending-emptiness would
    // pin the flag true forever (the late send pumps nothing), deadlocking the
    // Channel — see the async-accept regression this guards against.
    if (
      conversation.channelStopRequested
      && this.activeOrStartingChannelRunCount(conversation) === 0
    ) {
      conversation.channelStopRequested = false;
    }
  }

  private notifyChannelDrainWaiters(conversation: AgentConversationState): void {
    if (!this.channelFullyIdle(conversation)) return;
    const waiters = [...conversation.channelDrainWaiters];
    conversation.channelDrainWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private scopedConversation(
    conversation: AgentConversationState,
    activeRun: AgentActiveRunState,
    agent: Agent = activeRun.agent,
  ): AgentConversationState {
    return new Proxy(conversation, {
      get(target, property, receiver) {
        if (property === 'activeRun') return activeRun;
        if (property === 'agent') return agent;
        return Reflect.get(target, property, receiver);
      },
      set(target, property, value, receiver) {
        if (property === 'activeRun') {
          if (value === null) {
            target.activeRuns.delete(activeRun.id);
            activeRun.unsubscribe?.();
            activeRun.unsubscribe = undefined;
            if (target.activeRun?.id === activeRun.id) target.activeRun = null;
          } else {
            target.activeRuns.set(activeRun.id, activeRun);
            if (target.activeRun?.id === activeRun.id) target.activeRun = activeRun;
          }
          return true;
        }
        return Reflect.set(target, property, value, receiver);
      },
    });
  }

  private currentRuntimeConversation(fallback: AgentConversationState | null): AgentConversationState | null {
    return this.runScope.getStore()?.conversation ?? fallback;
  }

  private currentRuntimeAgent(fallback: Agent | null): Agent | null {
    return this.runScope.getStore()?.agent ?? fallback;
  }

  private runWithScope<T>(
    conversation: AgentConversationState,
    runState: AgentActiveRunState,
    callback: () => T,
  ): T {
    return this.runScope.run({
      conversation: this.scopedConversation(conversation, runState, runState.agent),
      agent: runState.agent,
    }, callback);
  }

  private currentAgentIdentity(model: Model<Api> | null, effort?: AgentReasoningLevel): AgentIdentityRecord {
    return {
      ...this.agentIdentity,
      model: model?.id ?? this.agentIdentity.model,
      effort: effort ? String(effort) : this.agentIdentity.effort,
    };
  }

  private runTrigger(conversation: AgentConversationState): AgentRunTrigger {
    const messageId = conversation.eventState.selectedLeafMessageId ?? conversation.eventState.latestMessageId;
    return messageId ? { type: 'message', messageId } : { type: 'manual' };
  }

  private runFingerprint(conversation: AgentConversationState, executingAgentId?: string, agent: Agent = conversation.agent): AgentRunFingerprint {
    const agentId = executingAgentId ?? conversation.defaultAgentId;
    return {
      appVersion: electronAppVersion(),
      promptHash: hashJson({
        agentId,
        // The conversation agent is already configured for the executing member
        // when the run starts, so its live system prompt is the turn's real prompt.
        systemPrompt: agentId === this.agentIdentity.agentId
          ? this.agentIdentity.systemPrompt
          : agent.state.systemPrompt,
      }),
      toolSchemaHash: 'runtime-tools',
      skillBindings: [],
      modelConfig: hashJson({
        model: agent.state.model.id,
        provider: agent.state.model.provider,
        thinkingLevel: agent.state.thinkingLevel,
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
    const members = conversation.eventState.conversation?.members ?? [];
    const multiAgent = isMultiAgentConversation(members);
    const hasActiveRuns = this.hasActiveRuns(conversation);
    // Sort the active-run list once: renderProjection reads it three times below.
    const runList = this.activeRunList(conversation);
    const projection = buildAgentRenderProjection(conversation.eventState, {
      revision: conversation.revision,
      activeRunId: this.activeRunId(conversation),
      activeRuns: runList.map((run) => ({
        runId: run.id,
        agentId: run.executingAgentId,
        addressedByMessageId: run.addressedByMessageId,
        startedAt: run.startedAt,
      })),
      activeRunAddressedByMessageId: conversation.activeRun?.addressedByMessageId ?? null,
      channelActivityEntries: this.channelActivityEntries(conversation, runList),
      activeCompaction: conversation.activeCompaction,
      activeDream: conversation.activeDream,
      // Mode-specific run state: a multi-agent Channel never drives the DM
      // composer (its async work shows in channelActivityEntries), and pending
      // (not-yet-launched) addressed turns count as Channel work in flight.
      dmRunActive: !multiAgent && hasActiveRuns,
      channelRunsActive: multiAgent && (hasActiveRuns || conversation.pendingChannelTurns.length > 0),
      model: clone(conversation.agent.state.model) as unknown as Record<string, unknown>,
      thinkingLevel: conversation.agent.state.thinkingLevel,
      pendingToolCallIds: uniqueStrings([
        ...Array.from(conversation.agent.state.pendingToolCalls),
        ...runList.flatMap((run) => Array.from(run.agent.state.pendingToolCalls)),
      ]),
      // Run/provider failures render inline as a failed assistant message (see
      // appendAssistantCompleted). The top-level banner is reserved for transient
      // operational errors delivered via the `error` event.
      errorMessage: null,
      agentTasks: this.agentTaskCache,
      memberDisplayNames: conversation.memberDisplayNames,
      povInspectorMemoryByAgentId: conversation.povInspectorMemoryByAgentId,
      coordinatorAgentId: this.agentIdentity.agentId,
    });
    return {
      ...projection,
      conversationTitle: sanitizeConversationTitle(projection.conversationTitle),
    };
  }

  private channelActivityEntries(
    conversation: AgentConversationState,
    runList: AgentActiveRunState[] = this.activeRunList(conversation),
  ): AgentRenderActivityEntry[] {
    const entries = new Map<string, AgentRenderActivityEntry>();
    for (const run of runList) {
      if (!run.addressedByMessageId) continue;
      const pendingToolCalls = run.agent.state.pendingToolCalls;
      const persistedRun = conversation.eventState.runs[run.id];
      const entry: AgentRenderActivityEntry = {
        id: `${run.addressedByMessageId}:${run.executingAgentId}`,
        agentId: run.executingAgentId,
        runId: run.id,
        messageId: latestAssistantMessageIdForRun(conversation.eventState, run.id),
        addressedByMessageId: run.addressedByMessageId,
        state: pendingToolCalls.size > 0 ? 'using_tools' : 'thinking',
        updatedAt: persistedRun?.updatedAt ?? run.startedAt,
        // The live composing text for the per-run detail view; retained on the
        // run (not the shared log) so concurrent runs never collide and the
        // transcript stays whole-utterance.
        streamingText: run.assistantText || undefined,
      };
      entries.set(entry.id, entry);
    }

    for (const turn of conversation.pendingChannelTurns) {
      const id = `${turn.addressedByMessageId}:${turn.agentId}`;
      if (entries.has(id)) continue;
      const addressingMessage = conversation.eventState.messages[turn.addressedByMessageId];
      entries.set(id, {
        id,
        agentId: turn.agentId,
        runId: null,
        messageId: null,
        addressedByMessageId: turn.addressedByMessageId,
        state: 'received',
        updatedAt: addressingMessage?.updatedAt ?? 0,
      });
    }

    return [...entries.values()]
      .sort((left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id));
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

  private emitError(conversationId: string, message: string, report?: Partial<ErrorReport>) {
    this.reportError({
      domain: report?.domain ?? 'runtime',
      severity: report?.severity ?? 'error',
      ...(report?.code ? { code: report.code } : {}),
      message,
      context: {
        conversationId,
        ...(report?.context ?? {}),
      },
      ...(report?.error !== undefined ? { error: report.error } : {}),
    });
    this.emitConversationRuntimeEvent(conversationId, {
      type: 'error',
      error: message,
    });
  }

  private reportError(report: ErrorReport): void {
    try {
      this.options.errorReporter?.(report);
    } catch (error) {
      console.error('[diagnostics] runtime error reporter failed', error);
    }
  }

  private reportWarn(domain: string, message: string, error?: unknown, context?: ErrorReportContext, code?: string): void {
    this.reportError({
      domain,
      severity: 'warn',
      ...(code ? { code } : {}),
      message,
      ...(context ? { context } : {}),
      ...(error !== undefined ? { error } : {}),
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
    this.eventStore ??= new AgentEventStore(this.options.agentDataRoot ?? path.join(app.getPath('userData'), 'agent'), {
      errorReporter: this.options.errorReporter,
    });
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
      principalNameFor: (principal) => this.memoryPrincipalName(principal, getConversation()),
      recall: async (options) => {
        const conversation = getConversation();
        const limit = clampRecallLimit(options.limit);
        const query = options.query?.trim();
        const readPrincipals = this.memoryReadPrincipals(reader, conversation);
        if (!query) {
          const now = Date.now();
          const activations = await Promise.all(readPrincipals.map((principal) => (
            this.getEventStore().activateMemoryEntries(principal, { limit: 200, now })
          )));
          const totalEntries = activations.reduce((sum, activation) => sum + activation.totalEntries, 0);
          return {
            entries: [],
            totalEntries,
            overview: mergeMemoryOverviews(
              activations.map((activation) => activation.overview),
              {
                generatedAt: now,
                totalEntries,
              },
            ),
          };
        }
        // Cross-principal read by membership ([[agent-data-model]] §4): the reader searches its
        // own pool plus every co-member principal's pool. Each pool is one undivided self-model;
        // `originWorkspace` is provenance on entries, never a retrieval fence.
        const queryResults = await Promise.all(readPrincipals.map((principal) => (
          this.getEventStore().queryMemoryEntries(principal, { query, limit })
        )));
        // Fair interleave so a large own pool never fully starves co-member pool hits.
        const mergedEntries = interleaveMemoryEntryGroups(queryResults.map((result) => result.entries), limit);
        const visibleEntries = mergedEntries.map((entry) => this.memoryEntryVisibleToReader(entry, reader));
        // Total durable matches across all readable pools — reachable by raising `limit` (which
        // lifts each pool's per-query cap and the interleave cap together), so it is an honest
        // paging signal rather than an over-report of this single capped page.
        const totalEntries = queryResults.reduce((sum, result) => sum + result.totalEntries, 0);

        if (!options.includeEvidence) {
          await this.recordMemoryAccessForEntries(mergedEntries, 'recall');
          return {
            entries: visibleEntries.map((entry) => ({ entry })),
            totalEntries,
          };
        }

        let remainingChars = Math.max(0, options.maxChars ?? 0);
        const entries: AgentRecallRuntimeEntry[] = [];
        for (const [index, entry] of mergedEntries.entries()) {
          const visibleEntry = visibleEntries[index] ?? this.memoryEntryVisibleToReader(entry, reader);
          if (!samePrincipal(entry.principal, reader)) {
            const refusal = await this.crossPrincipalEvidenceRefusal(entry, reader);
            entries.push({
              entry: visibleEntry,
              evidence: refusal ? [refusal] : undefined,
            });
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
              principal: entry.principal,
              reader,
              source,
              maxChars: remainingChars,
            });
            if (sourceEvidence.mode !== 'evidence') continue;
            evidenceTruncated ||= sourceEvidence.outputTruncated;
            if (sourceEvidence.episode) {
              const gist = clampEvidenceText(sourceEvidence.episode.gist, remainingChars);
              evidence.push({
                kind: 'episode_gist',
                source,
                episodeId: sourceEvidence.episode.id,
                gist: gist.text,
                createdAt: sourceEvidence.episode.createdAt,
                rawSources: sourceEvidence.episode.sources,
              });
              evidenceTruncated ||= gist.truncated;
              remainingChars = Math.max(0, remainingChars - gist.text.length);
              if (remainingChars <= 0 || gist.truncated) {
                evidenceTruncated = true;
                break;
              }
            }
            for (const message of sourceEvidence.messages) {
              evidence.push({
                kind: 'raw_span',
                source,
                rawSource: message.rawSource,
                conversationId: message.conversationId,
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
            entry: visibleEntry,
            evidence: evidence.length > 0 ? evidence : undefined,
            evidenceTruncated,
          });
        }

        await this.recordMemoryAccessForEntries(mergedEntries, 'recall');
        return {
          entries,
          totalEntries,
        };
      },
    };
  }

  private memoryReadPrincipals(
    reader: AgentPrincipal,
    conversation: AgentConversationState | null,
  ): AgentPrincipal[] {
    const principals: AgentPrincipal[] = [];
    const push = (principal: AgentPrincipal): void => {
      if (principals.some((current) => samePrincipal(current, principal))) return;
      principals.push(principal);
    };
    push(reader);
    const members = conversation?.eventState.conversation?.members;
    if (!members) {
      push(this.userPrincipal());
      return principals;
    }
    const readerIsMember = members.some((member) => samePrincipal(member, reader));
    if (!readerIsMember) {
      // Fresh child sidechains borrow the parent conversation for user context but are not
      // co-members of that conversation, so they do not inherit the parent agent's pool.
      const user = this.userPrincipal();
      if (members.some((member) => samePrincipal(member, user))) push(user);
      return principals;
    }
    for (const member of members) push(member);
    return principals;
  }

  private memoryEntryVisibleToReader(entry: AgentMemoryEntry, reader: AgentPrincipal): AgentMemoryEntry {
    if (samePrincipal(entry.principal, reader)) return entry;
    return {
      ...entry,
      fact: redactSecretLikeContent(entry.fact),
      sources: [],
    };
  }

  private async crossPrincipalEvidenceRefusal(
    entry: AgentMemoryEntry,
    reader: AgentPrincipal,
  ): Promise<AgentRecallEvidence | null> {
    const source = entry.sources[0];
    if (!source) return null;
    const sourceEvidence = await this.getPastChatsService().readMemorySourceEvidence({
      principal: entry.principal,
      reader,
      source,
      maxChars: 1,
    });
    if (sourceEvidence.mode === 'error' && sourceEvidence.code === 'CROSS_PRINCIPAL_EVIDENCE') {
      return {
        kind: 'evidence_refusal',
        code: sourceEvidence.code,
        message: sourceEvidence.message,
      };
    }
    return null;
  }

  private memoryPrincipalName(
    principal: AgentPrincipal,
    conversation: AgentConversationState | null,
  ): string {
    if (principal.type === 'user') return 'The user';
    return conversation?.memberDisplayNames[principal.agentId] ?? agentMentionToken(principal.agentId);
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
        // The provider connection owns no model; report the built-in assistant's
        // resolved model/effort (its agent-owned default over this connection).
        const provider = providerConfig
          ? await this.resolveBuiltInAssistantModelEffort(providerConfig)
              .then((resolved) => ({
                configured: true,
                providerId: providerConfig.providerId,
                modelId: resolved.model.id,
                reasoningLevel: String(resolved.thinkingLevel),
              }))
              .catch(() => ({ configured: true, providerId: providerConfig.providerId }))
          : { configured: false };
        return {
          agentId: this.agentIdentity.agentId,
          conversationId: getConversationId(),
          provider,
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
        const patch = normalizeRuntimeSettingPatch(setting, value);
        await updateAgentRuntimeSettings(patch);
        const runtimeSettings = await this.refreshRuntimeSettings(conversation);
        const after = readRuntimeSetting(runtimeSettings, setting);
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
            message: `${runtimeSettings.disabledAgents.length} agents are disabled.`,
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
    const { result, payloadEvents } = await this.normalizeAskUserQuestionResult(
      conversationId,
      pending,
      resultInput,
    );
    const validationError = this.validateUserQuestionResult(pending.request, result);
    if (validationError) throw new Error(validationError);
    const events: AgentEventInput[] = [...payloadEvents, {
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
    if (result.outcome === 'discussed') {
      return result.discuss?.message?.trim() ? null : 'A discuss result requires a message.';
    }
    const answers = new Map(result.answers.map((answer) => [answer.questionId, answer]));
    for (const question of request.questions) {
      if (question.required === false) continue;
      const answer = answers.get(question.id);
      if (!answer) return `Question ${question.id} is required.`;
      if (!hasUserQuestionAnswerContent(answer)) return `Question ${question.id} is required.`;
    }
    return null;
  }

  private async normalizeAskUserQuestionResult(
    conversationId: string,
    pending: AgentPendingUserQuestion,
    input: unknown,
  ): Promise<{ result: AskUserQuestionResult; payloadEvents: AgentEventInput[] }> {
    const inputRecord = isRecord(input) ? input : {};
    const outcome = inputRecord.outcome === 'discussed' || inputRecord.outcome === 'discuss'
      ? 'discussed'
      : 'answered';
    if (outcome === 'discussed') {
      const rawDiscuss = isRecord(inputRecord.discuss) ? inputRecord.discuss.message : inputRecord.message;
      const message = typeof rawDiscuss === 'string' && rawDiscuss.trim()
        ? rawDiscuss.trim().slice(0, 1000)
        : 'I want to discuss this before answering.';
      return {
        result: {
          requestId: pending.requestId,
          outcome,
          answers: [],
          discuss: { message },
        },
        payloadEvents: [],
      };
    }

    const inputAnswers = Array.isArray(inputRecord.answers) ? inputRecord.answers : [];
    const answersByQuestionId = new Map<string, unknown>();
    for (const answer of inputAnswers) {
      if (!isRecord(answer) || typeof answer.questionId !== 'string') continue;
      answersByQuestionId.set(answer.questionId, answer);
    }

    const answers: AgentUserQuestionAnswer[] = [];
    const payloadEvents: AgentEventInput[] = [];
    for (const question of pending.request.questions) {
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

      const allowReferences = question.allowReferences ?? question.type === 'free_text';
      const allowAttachments = (question.allowAttachments ?? question.type === 'free_text') || allowReferences;
      const normalizedAttachments = allowAttachments
        ? await this.normalizeUserQuestionAnswerAttachments(conversationId, pending, raw.attachments)
        : { attachments: [], payloadEvents: [], pathMap: new Map<string, string>() };
      payloadEvents.push(...normalizedAttachments.payloadEvents);

      const rawText = typeof raw.text === 'string' ? raw.text.trim().slice(0, 4000) : '';
      const text = rewriteFileReferenceMarkerPaths(rawText, normalizedAttachments.pathMap);
      const notes = typeof raw.notes === 'string' ? raw.notes.trim().slice(0, 4000) : '';
      if (text) answer.text = text;
      if (notes) answer.notes = notes;
      if (allowReferences) {
        const nodeRefs = normalizeUserQuestionNodeRefs(raw.nodeRefs);
        const fileRefs = normalizeUserQuestionFileRefs(raw.fileRefs, normalizedAttachments.pathMap);
        if (nodeRefs.length > 0) answer.nodeRefs = nodeRefs;
        if (fileRefs.length > 0) answer.fileRefs = fileRefs;
      }
      if (normalizedAttachments.attachments.length > 0) answer.attachments = normalizedAttachments.attachments;
      answers.push(answer);
    }

    return {
      result: {
        requestId: pending.requestId,
        outcome,
        answers,
      },
      payloadEvents,
    };
  }

  private async normalizeUserQuestionAnswerAttachments(
    conversationId: string,
    pending: AgentPendingUserQuestion,
    rawAttachments: unknown,
  ): Promise<{
    attachments: AgentUserQuestionAttachment[];
    payloadEvents: AgentEventInput[];
    pathMap: Map<string, string>;
  }> {
    const materialized = await this.materializeFileAttachments(normalizeAttachmentInputs(rawAttachments));
    const attachments: AgentUserQuestionAttachment[] = [];
    const payloadEvents: AgentEventInput[] = [];
    for (const attachment of materialized.attachments) {
      const base = {
        id: attachment.id,
        kind: attachment.kind,
        ref: attachment.ref,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      };
      if (attachment.kind === 'file') {
        attachments.push({ ...base, kind: 'file', path: attachment.path });
        continue;
      }

      const payload = await this.getEventStore().writePayload(conversationId, {
        data: attachment.kind === 'image'
          ? Buffer.from(stripDataUrlPrefix(attachment.dataBase64), 'base64')
          : attachment.text,
        mimeType: attachment.mimeType,
        runId: pending.runId,
        role: 'source',
        summary: attachment.name,
        truncated: attachment.kind === 'text' ? attachment.truncated : undefined,
      });
      payloadEvents.push({
        type: 'payload.created',
        actor: systemActor(),
        runId: pending.runId,
        payload,
      });
      if (attachment.kind === 'image') {
        attachments.push({ ...base, kind: 'image', path: attachment.path, payload });
      } else {
        attachments.push({ ...base, kind: 'text', truncated: attachment.truncated, payload });
      }
    }
    return {
      attachments,
      payloadEvents,
      pathMap: materialized.pathMap,
    };
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
    const toolResult = askUserQuestionToolResult(result);
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
    return this.deriveMemoryBriefing(agentId, conversation, {
      recordAccess: true,
      operation: 'buildMemoryReminder',
      warningCode: 'agent-memory-reminder-failed',
    });
  }

  private async buildPovInspectorMemoryBriefing(
    agentId: string,
    conversation: AgentConversationState | null,
  ): Promise<string | null> {
    return this.deriveMemoryBriefing(agentId, conversation, {
      recordAccess: false,
      operation: 'buildPovInspectorMemoryBriefing',
      warningCode: 'agent-pov-inspector-memory-failed',
    });
  }

  private async deriveMemoryBriefing(
    agentId: string,
    conversation: AgentConversationState | null,
    options: { recordAccess: boolean; operation: string; warningCode: string },
  ): Promise<string | null> {
    try {
      const reader: AgentPrincipal = { type: 'agent', agentId };
      // Chronic activation: the briefing is the distilled-memory prefix, so it lists
      // strength-selected active entries plus a schema overview rather than query-specific hits.
      // Query-specific retrieval remains the `recall` tool's job ([5] tail).
      //
      // Membership read ([[agent-data-model]] §4): the reader sees its own pool (`<self>`) plus
      // every co-member principal's pool (`<principal>`). Each pool is one undivided self-model
      // — like a person, a principal never partitions its own memory by where it works.
      const now = Date.now();
      const activations = await Promise.all(this.memoryReadPrincipals(reader, conversation).map((principal) => (
        this.getEventStore().activateMemoryEntries(principal, { limit: 200, now })
      )));
      // Interleave so co-member pools get a fair share of the resident budget — a self-first
      // concatenation would let an agent with a full self-model starve foreign zones entirely.
      const selected = interleaveMemoryEntryGroups(
        activations.map((activation) => (
          orderMemoryEntriesForBriefing(activation.entries, { now }).map((item) => item.entry)
        )),
        MEMORY_BRIEFING_MAX_ENTRIES,
      );
      if (options.recordAccess) await this.recordMemoryAccessForEntries(selected, 'briefing', now);
      const totalEntries = activations.reduce((sum, activation) => sum + activation.totalEntries, 0);
      const overview = mergeMemoryOverviews(
        activations.map((activation) => activation.overview),
        {
          generatedAt: now,
          totalEntries,
        },
      );
      return renderAgentMemoryBriefing(selected, {
        reader,
        overview,
        principalNameFor: (principal) => this.memoryPrincipalName(principal, conversation),
      });
    } catch (error) {
      this.reportWarn(
        'persistence',
        `Failed to build agent memory reminder: ${error instanceof Error ? error.message : String(error)}`,
        error,
        { operation: options.operation },
        options.warningCode,
      );
      return null;
    }
  }

  private clearChildRunMemoryReminderCaches(): void {
    for (const conversation of this.conversations.values()) {
      conversation.delegationRuntime.clearMemoryReminderCache();
    }
  }

  private async recordMemoryAccessForEntries(
    entries: readonly AgentMemoryEntry[],
    via: 'briefing' | 'recall',
    createdAt?: number,
  ): Promise<void> {
    if (entries.length === 0) return;
    const groups = new Map<string, { principal: AgentPrincipal; entryIds: string[] }>();
    for (const entry of entries) {
      const key = principalKey(entry.principal);
      const group = groups.get(key) ?? { principal: entry.principal, entryIds: [] };
      group.entryIds.push(entry.id);
      groups.set(key, group);
    }
    await Promise.all([...groups.values()].map((group) => (
      this.getEventStore().recordMemoryAccess(group.principal, {
        via,
        entryIds: group.entryIds,
        ...(createdAt === undefined ? {} : { createdAt }),
      })
    )));
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

  /**
   * The provider connection's default catalog model, or null when none exists (a
   * custom endpoint with no catalog). Display/fallback paths use this so an
   * unconfigured custom provider never throws during conversation setup.
   */
  private tryResolveProviderModel(providerConfig: AgentProviderRuntimeConfig): Model<Api> | null {
    try {
      return this.resolveProviderModel(providerConfig);
    } catch {
      return null;
    }
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
    requestedByAgentId?: string,
  ): Promise<AgentToolApprovalResolution> {
    if (signal?.aborted) return { approved: false, deniedReason: 'run_aborted' };

    const requestId = input.requestId;
    const request: AgentApprovalRequestView = {
      requestId,
      conversationId: conversationId,
      kind: 'tool_permission',
      toolCallId: input.toolCall.id,
      toolName: input.toolCall.name,
      title: input.decision.request.title,
      target: input.decision.request.target,
      reason: input.decision.reason,
      details: input.decision.request.details,
      alwaysAllowRule: input.decision.request.alwaysAllowRule,
      requestedByAgentId,
    };
    await this.emitApprovalCard(conversationId, conversation, request, {
      request,
      decision: {
        behavior: input.decision.behavior,
        code: input.decision.code,
        reason: input.decision.reason,
        access: input.decision.access,
      },
      args: input.args,
    });

    return new Promise<AgentToolApprovalResolution>((resolve) => {
      const onAbort = () => {
        void this.denyPendingApprovalForRuntime(conversationId, conversation, requestId, 'run_aborted');
      };

      this.pendingApprovals.set(requestId, {
        conversationId,
        runId: this.activeRunId(conversation) ?? undefined,
        request,
        alwaysAllowRule: request.alwaysAllowRule,
        resolve: (resolution) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(resolution);
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  private async requestSkillTrustApproval(
    conversationId: string,
    conversation: AgentConversationState,
    skill: SkillDefinition,
    parentToolCallId?: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    if (skill.source !== 'user' && skill.source !== 'project') return false;
    const contentHash = skill.contentHash;
    if (!contentHash) return false;
    const requestId = `skill-trust-${randomUUID()}`;
    const displayName = skill.displayName || skill.name;
    const details: AgentApprovalRequestDetail[] = [
      { label: 'Skill', value: `/${skill.name}` },
      { label: 'Source', value: skill.source },
      { label: 'Path', value: skill.skillFile },
      { label: 'Content hash', value: contentHash },
    ];
    if (skill.description.trim()) {
      details.push({ label: 'Description', value: skill.description.trim() });
    }
    const request: AgentApprovalRequestView = {
      requestId,
      conversationId,
      kind: 'skill_trust',
      toolCallId: parentToolCallId ?? requestId,
      toolName: 'skill',
      title: `Skill ${displayName} requests automatic use.`,
      target: `/${skill.name}`,
      reason: 'Accept the current skill content hash before Lin can invoke it automatically.',
      details,
      skillTrust: {
        name: skill.name,
        displayName: skill.displayName,
        source: skill.source,
        contentHash,
      },
    };
    await this.emitApprovalCard(conversationId, conversation, request, {
      request,
      skill: {
        name: skill.name,
        displayName: skill.displayName,
        source: skill.source,
        skillFile: skill.skillFile,
        contentHash,
      },
    });

    return new Promise<boolean>((resolve) => {
      const onAbort = () => {
        void this.denyPendingApprovalForRuntime(conversationId, conversation, requestId, 'run_aborted');
      };

      this.pendingApprovals.set(requestId, {
        conversationId,
        runId: this.activeRunId(conversation) ?? undefined,
        request,
        onApproved: async () => {
          await this.applySkillTrustAction(conversationId, (skillRuntime) => skillRuntime.acceptSkill(skill.name, contentHash));
        },
        resolve: (resolution) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(resolution.approved);
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  private async showPermissionNotice(
    conversationId: string,
    conversation: AgentConversationState,
    input: {
      requestId: string;
      toolCall: ToolCall;
      args: unknown;
      decision: AgentPermissionDenyDecision;
    },
    signal?: AbortSignal,
    requestedByAgentId?: string,
  ): Promise<void> {
    if (signal?.aborted) return;
    await this.clearPendingPermissionNotices(conversationId, conversation);

    const notice = approvalNoticeForDeniedDecision(input.toolCall.name, input.decision);
    const request: AgentApprovalRequestView = {
      requestId: input.requestId,
      conversationId,
      kind: 'permission_notice',
      toolCallId: input.toolCall.id,
      toolName: input.toolCall.name,
      title: notice.title,
      target: notice.target,
      reason: input.decision.reason,
      details: notice.details,
      requestedByAgentId,
    };
    await this.emitApprovalCard(conversationId, conversation, request, {
      request,
      decision: {
        behavior: input.decision.behavior,
        code: input.decision.code,
        reason: input.decision.reason,
        access: input.decision.access,
      },
      args: input.args,
    });

    const onAbort = () => {
      void this.denyPendingApprovalForRuntime(conversationId, conversation, input.requestId, 'run_aborted');
    };
    this.pendingApprovals.set(input.requestId, {
      conversationId,
      runId: this.activeRunId(conversation) ?? undefined,
      request,
      resolve: () => {
        signal?.removeEventListener('abort', onAbort);
      },
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  }

  private async emitApprovalCard(
    conversationId: string,
    conversation: AgentConversationState,
    request: AgentApprovalRequestView,
    payloadData: unknown,
  ): Promise<void> {
    const payload = await this.getEventStore().writePayload(conversationId, {
      id: `approval-${request.requestId}`,
      data: JSON.stringify(payloadData, null, 2),
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
      requestId: request.requestId,
      summary: `${request.title} ${request.target}`.trim(),
      payloadRef: payload,
    }]);

    this.emitConversationRuntimeEvent(conversationId, {
      type: 'approval_request',
      requestId: request.requestId,
      request,
    });
    this.emitProjection(conversationId, 'approval.requested');
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
    const activeRun = conversation.activeRuns.get(runId);
    if (!activeRun || activeRun.agent.state.isStreaming) return;
    const scoped = this.scopedConversation(conversation, activeRun);
    try {
      await this.appendConversationEvents(conversationId, scoped, [{
        type: 'run.failed',
        actor: systemActor(),
        runId: activeRun.id,
        errorMessage: activeRun.agent.state.errorMessage ?? 'The run ended without a terminal agent event.',
        usage: sumRunUsage(scoped.eventState, activeRun.id),
      }]);
    } catch {
      // Recording the failure is best-effort; freeing the slot is the
      // critical part — a wedged activeRun blocks the conversation forever.
    }
    scoped.lastRun = activeRun;
    scoped.activeRun = null;
    activeRun.resolveSettled();
    this.notifyChannelDrainWaiters(conversation);
  }

  private async startRun(
    conversationId: string,
    conversation: AgentConversationState,
    prompt: UserMessage | null = null,
    triggerOverride: AgentRunTrigger | null = null,
    identity: {
      executingAgentId?: string;
      addressedByMessageId?: string | null;
      agent?: Agent;
      channelTurn?: boolean;
      allowConcurrent?: boolean;
      channelDefinition?: AgentDefinition;
    } = {},
  ): Promise<string> {
    if (!identity.allowConcurrent && this.hasActiveRuns(conversation)) {
      throw new Error('A run is already active in this conversation.');
    }
    const runId = randomUUID();
    const agentId = (identity.executingAgentId ?? conversation.defaultAgentId) as AgentId;
    const agent = identity.agent ?? conversation.agent;
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const runState: AgentActiveRunState = {
      id: runId,
      startedAt: Date.now(),
      agent,
      channelTurn: identity.channelTurn === true,
      channelDefinition: identity.channelDefinition,
      settled,
      resolveSettled,
      assistantMessageId: null,
      assistantText: '',
      lastMessageId: null,
      lastSubmittedUserPrompt: prompt,
      toolOutputPayloads: new Map(),
      toolCallMessageIds: new Map(),
      executingAgentId: agentId,
      addressedByMessageId: identity.addressedByMessageId ?? null,
    };
    conversation.activeRuns.set(runId, runState);
    if (!identity.allowConcurrent) conversation.activeRun = runState;
    conversation.lastRun = null;
    const scoped = identity.allowConcurrent ? this.scopedConversation(conversation, runState, agent) : conversation;
    try {
      await this.appendConversationEvents(conversationId, scoped, [{
        type: 'run.started',
        actor: systemActor(),
        runId,
        agentId,
        addressedByMessageId: runState.addressedByMessageId,
        anchor: { type: 'conversation', agentId, conversationId },
        kind: 'turn',
        trigger: triggerOverride ?? this.runTrigger(scoped),
        fingerprint: this.runFingerprint(scoped, agentId, agent),
        retention: 'hot',
      }]);
    } catch (error) {
      // The run never made it into the ledger — release the slot, or every
      // later run in this conversation hits the guard above until restart.
      conversation.activeRuns.delete(runId);
      if (conversation.activeRun?.id === runId) conversation.activeRun = null;
      runState.resolveSettled();
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

  private enqueueChannelTurns(
    conversationId: string,
    conversation: AgentConversationState,
    turns: readonly ChannelTurnRequest[],
  ): void {
    if (turns.length === 0) {
      this.notifyChannelDrainWaiters(conversation);
      return;
    }
    conversation.pendingChannelTurns.push(...turns);
    this.emitProjection(conversationId, 'channel_turns_enqueued');
    // Detach the final idle emit from the (now non-blocking) send: the work is
    // accepted and projected above; this watcher emits idle once it all drains.
    this.scheduleChannelIdleEmit(conversationId, conversation);
    void this.pumpChannelTurns(conversationId, conversation)
      .catch((error) => this.emitError(conversationId, error instanceof Error ? error.message : String(error)));
  }

  private async pumpChannelTurns(conversationId: string, conversation: AgentConversationState): Promise<void> {
    while (
      !conversation.channelStopRequested
      && conversation.pendingChannelTurns.length > 0
      && this.activeOrStartingChannelRunCount(conversation) < CHANNEL_MAX_CONCURRENT_RUNS
    ) {
      const request = conversation.pendingChannelTurns.shift()!;
      const members = conversation.eventState.conversation?.members ?? [];
      if (!members.some((member) => member.type === 'agent' && member.agentId === request.agentId)) continue;
      conversation.channelTurnStartsInProgress += 1;
      try {
        await this.launchChannelTurn(conversationId, conversation, request);
      } finally {
        conversation.channelTurnStartsInProgress = Math.max(0, conversation.channelTurnStartsInProgress - 1);
        this.maybeClearChannelStopRequested(conversation);
        this.notifyChannelDrainWaiters(conversation);
      }
    }
    this.notifyChannelDrainWaiters(conversation);
  }

  private channelFullyIdle(conversation: AgentConversationState): boolean {
    return conversation.pendingChannelTurns.length === 0
      && conversation.channelTurnStartsInProgress === 0
      && this.activeChannelRuns(conversation).length === 0;
  }

  /** Resolve once the Channel has no pending, starting, or active addressed runs. */
  private async awaitChannelIdle(conversation: AgentConversationState): Promise<void> {
    while (!this.channelFullyIdle(conversation)) {
      await new Promise<void>((resolve) => {
        conversation.channelDrainWaiters.add(resolve);
      });
    }
  }

  private async waitForChannelIdle(conversationId: string, conversation: AgentConversationState): Promise<void> {
    await this.awaitChannelIdle(conversation);
    await this.persistAndEmitIdle(conversationId, conversation);
  }

  /**
   * Emit the final idle projection once the Channel drains, WITHOUT blocking the
   * caller. A Channel send/edit/retry returns on acceptance — the addressed runs
   * drain asynchronously — so the idle finalization is detached here. At most one
   * watcher runs per conversation; it re-arms if fresh work (a follow-up send or a
   * hand-off turn) arrives during the emit, so the drain always emits exactly once.
   *
   * Ownership is tracked by `channelIdleEmitToken`: a teardown (reset/close/delete,
   * via {@link teardownChannelDraining}) bumps the token and resolves the parked
   * waiter, so the orphaned watcher neither emits on a dead conversation nor leaves
   * `channelIdleEmitInFlight` stuck true (which would block every later idle emit).
   */
  private scheduleChannelIdleEmit(conversationId: string, conversation: AgentConversationState): void {
    if (conversation.channelIdleEmitInFlight || this.channelFullyIdle(conversation)) return;
    conversation.channelIdleEmitInFlight = true;
    const token = conversation.channelIdleEmitToken;
    const stillOwned = () => conversation.channelIdleEmitToken === token
      && this.conversations.get(conversationId) === conversation;
    void (async () => {
      try {
        await this.awaitChannelIdle(conversation);
        // A teardown (reset/close/delete) supersedes this watcher; skip the emit so
        // we never persist/emit on a conversation that is gone or restarted. The
        // emitGuard re-checks ownership AFTER persistAndEmitIdle's internal awaits,
        // closing the window where a teardown lands mid-emit.
        if (stillOwned()) await this.persistAndEmitIdle(conversationId, conversation, { emitGuard: stillOwned });
      } catch (error) {
        this.emitError(conversationId, error instanceof Error ? error.message : String(error));
      } finally {
        // Only the owning watcher clears the flag and re-arms; a superseded one bows out.
        if (conversation.channelIdleEmitToken === token) {
          conversation.channelIdleEmitInFlight = false;
          if (stillOwned() && !this.channelFullyIdle(conversation)) {
            this.scheduleChannelIdleEmit(conversationId, conversation);
          }
        }
      }
    })();
  }

  /**
   * Tear down the detached idle-drain machinery for a conversation being reset,
   * closed, or deleted: supersede any in-flight watcher (bump the token) and
   * resolve its parked waiter so the watcher's Promise settles and is collected
   * instead of pinning the conversation, then clear the stop flag. Idempotent.
   */
  private teardownChannelDraining(conversation: AgentConversationState): void {
    conversation.channelStopRequested = false;
    conversation.channelIdleEmitInFlight = false;
    conversation.channelIdleEmitToken += 1;
    const waiters = [...conversation.channelDrainWaiters];
    conversation.channelDrainWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  async drainChannelTurnsForTest(conversationId: string): Promise<void> {
    const conversation = await this.ensureConversationWithId(conversationId);
    await this.waitForChannelIdle(conversationId, conversation);
  }

  private async discardPendingChannelTurns(
    conversationId: string,
    conversation: AgentConversationState,
    reason: string,
  ): Promise<void> {
    const discardedTurns = conversation.pendingChannelTurns.length;
    conversation.pendingChannelTurns = [];
    try {
      if (discardedTurns > 0) {
        await this.appendSystemPromptEvent(conversationId, conversation, {
          role: 'user',
          content: [{
            type: 'text',
            text: systemReminder(`The user stopped this round. ${discardedTurns} unstarted turn(s) were discarded. ${reason}`.trim()),
          }],
          timestamp: Date.now(),
        });
      }
    } finally {
      this.maybeClearChannelStopRequested(conversation);
      // Re-pump after clearing the stop flag, like finishChannelTurn does: a send
      // that enqueued a turn during the await above had its pump bailed while the
      // flag was still set, and nothing else would re-pump it (no active run to
      // finish) — it would stick in pendingChannelTurns forever.
      void this.pumpChannelTurns(conversationId, conversation)
        .catch((error) => this.emitError(conversationId, error instanceof Error ? error.message : String(error)));
      this.notifyChannelDrainWaiters(conversation);
    }
  }

  private async launchChannelTurn(
    conversationId: string,
    conversation: AgentConversationState,
    request: ChannelTurnRequest,
  ): Promise<void> {
    let runState: AgentActiveRunState | null = null;
    try {
      const { agent, definition } = await this.createChannelTurnAgent(conversationId, conversation, request.agentId, () => {
        if (!runState) return conversation;
        return this.scopedConversation(conversation, runState, agent);
      });
      if (conversation.channelStopRequested) return;
      const runId = await this.startRun(conversationId, conversation, null, { type: 'message', messageId: request.addressedByMessageId }, {
        executingAgentId: request.agentId,
        addressedByMessageId: request.addressedByMessageId,
        agent,
        channelTurn: true,
        allowConcurrent: true,
        channelDefinition: definition,
      });
      runState = conversation.activeRuns.get(runId) ?? null;
      if (!runState) throw new Error(`Channel run failed to register: ${runId}`);
      const scoped = this.scopedConversation(conversation, runState, agent);
      agent.transformContext = async (_messages, signal) => this.contextManager.prepareModelContext(conversationId, scoped, signal);
      runState.unsubscribe = agent.subscribe(async (event) => {
        await this.handlePiAgentEvent(conversationId, scoped, event);
        this.emitProjection(conversationId, event.type, event.type === 'message_update' ? 'coalesce' : 'immediate');
      });
      agent.state.messages = await this.deriveRuntimePiMessages(conversationId, scoped.eventState, scoped) as never;
      this.emitProjection(conversationId, 'channel_turn_started');
      void this.finishChannelTurn(conversationId, conversation, runState, request)
        .catch((error) => this.emitError(conversationId, error instanceof Error ? error.message : String(error)));
    } catch (error) {
      await this.recoverFromRunError(conversationId, runState?.id ?? null);
      this.emitError(conversationId, error instanceof Error ? error.message : String(error));
      void this.pumpChannelTurns(conversationId, conversation)
        .catch((pumpError) => this.emitError(conversationId, pumpError instanceof Error ? pumpError.message : String(pumpError)));
    }
  }

  private async finishChannelTurn(
    conversationId: string,
    conversation: AgentConversationState,
    runState: AgentActiveRunState,
    request: ChannelTurnRequest,
  ): Promise<void> {
    try {
      await this.runWithScope(conversation, runState, () => runState.agent.continue());
    } catch (error) {
      await this.recoverFromRunError(conversationId, runState.id);
      this.emitError(conversationId, error instanceof Error ? error.message : String(error));
    } finally {
      await runState.settled;
      try {
        const run = conversation.eventState.runs[runState.id];
        const assistantMessageId = latestAssistantMessageIdForRun(conversation.eventState, runState.id);
        if (run?.status === 'completed' && assistantMessageId) {
          // Enqueue hand-off turns FIRST (synchronous) so channelRunsActive does not
          // dip false between this run's agent_end projection and the next turn —
          // before the awaited, backgrounded-only unread raise would widen that gap.
          if (!conversation.channelStopRequested) {
            const reply = conversation.eventState.messages[assistantMessageId];
            const handoffTurns = channelAgentMembers(reply?.addressedTo ?? [])
              .filter((target) => target.agentId !== request.agentId)
              .map((target): ChannelTurnRequest => ({
                agentId: target.agentId,
                addressedByMessageId: assistantMessageId,
              }));
            this.enqueueChannelTurns(conversationId, conversation, handoffTurns);
          }
          // A delivered reply bumps unread for a backgrounded Channel (badge-only).
          await this.raiseChannelReplyUnread(conversationId, conversation, runState, assistantMessageId);
        }
        await this.flushPendingDreamFinishedEvents(conversationId, conversation);
      } catch (error) {
        // Best-effort: a notification / dream-flush write failure must NOT abort the
        // drain release below, or the detached watcher and any drainChannelTurnsForTest
        // park forever and the Channel wedges (channelRunsActive stuck) with no recovery.
        this.emitError(conversationId, error instanceof Error ? error.message : String(error));
      }
      // Drain release — MUST run even if the bookkeeping above threw.
      this.maybeClearChannelStopRequested(conversation);
      void this.pumpChannelTurns(conversationId, conversation)
        .catch((error) => this.emitError(conversationId, error instanceof Error ? error.message : String(error)));
      this.notifyChannelDrainWaiters(conversation);
      this.emitProjection(conversationId, 'channel_turn_finished');
    }
  }

  /**
   * A delivered in-Channel peer reply bumps the conversation's unread badge when
   * the user is not viewing it — reusing the existing `notification.created` /
   * `conversation_attention` fold (the only unread mechanism; see the reducer).
   * Badge-only by design: no OS notification is delivered for in-Channel chatter
   * (a count, not a ding). Skipped for the viewed conversation (nothing unread to
   * raise) and idempotent on the reply's message id.
   */
  private async raiseChannelReplyUnread(
    conversationId: string,
    conversation: AgentConversationState,
    runState: AgentActiveRunState,
    assistantMessageId: string,
  ): Promise<void> {
    if (this.viewedConversationId === conversationId) return;
    // Reuse the shared notification path (idempotency + notification.created +
    // conversation_attention fold); badge-only — no OS ding for in-Channel chatter.
    await this.emitTaskNotification(conversationId, conversation, {
      notificationId: `channel-reply:${assistantMessageId}`,
      kind: 'channel_reply',
      title: `@${agentMentionToken(runState.executingAgentId)}`,
      source: { type: 'run', runId: runState.id },
      deliverOs: false,
    });
  }

  private async createChannelTurnAgent(
    conversationId: string,
    conversation: AgentConversationState,
    targetAgentId: string,
    getScopedConversation: () => AgentConversationState,
  ): Promise<{ agent: Agent; definition?: AgentDefinition }> {
    const providerConfig = await this.getActiveProviderConfig();
    if (!providerConfig) throw new Error('No enabled agent provider is configured.');
    const runtimeSettings = await this.refreshRuntimeSettings(conversation);
    const isMainAgent = targetAgentId === this.coordinatorAgentId();
    // null when a peer's model can't resolve (custom endpoint, profile on 'inherit')
    // — degrades to the configuration-error agent below, not a thrown channel turn.
    const profile = isMainAgent ? null : await this.resolveChannelPeerProfile(conversation, targetAgentId).catch(() => null);
    if (profile) await this.getEventStore().writeAgentIdentity(profile.identity);
    // The built-in coordinator owns its model/effort through the settings overlay,
    // resolved the same way as a peer profile; its base system prompt is unchanged.
    // null when the coordinator's connection has no resolvable model yet (a fresh
    // custom endpoint, no assistant default chosen) — degrade like the direct
    // conversation path rather than throwing the whole channel turn.
    const builtIn = isMainAgent
      ? await this.resolveBuiltInAssistantModelEffort(providerConfig).catch(() => null)
      : null;
    const model = profile?.model ?? builtIn?.model;
    const thinkingLevel = profile?.thinkingLevel ?? builtIn?.thinkingLevel;
    const systemPrompt = profile?.systemPrompt ?? this.agentIdentity.systemPrompt;
    const definition = profile?.definition;
    if (!model) {
      return {
        agent: createConfigurationErrorAgent(
          conversationId,
          'No model is configured. Choose a default model for the assistant in Settings → Agents.',
        ),
        definition,
      };
    }
    const agent = createConfiguredAgent(conversationId, providerConfig, [], this.outlinerToolHost, {
      localFileRoot: this.options.localFileRoot,
      localWorkspace: conversation.localWorkspace,
      model,
      thinkingLevel,
      systemPrompt,
      permissionMode: this.options.permissionMode,
      runtimeSettingsLoader: () => this.getRuntimeSettings(),
      skillToolEnabled: runtimeSettings.automaticSkillsEnabled,
      skillRuntime: conversation.skillRuntime,
      delegationRuntime: conversation.delegationRuntime,
      recall: this.createRecallToolRuntime(targetAgentId, () => conversationId, () => getScopedConversation()),
      askUserQuestion: this.createAskUserQuestionRuntime(() => conversationId, () => getScopedConversation()),
      selfMaintenance: isMainAgent ? this.createSelfMaintenanceRuntime(() => conversationId, () => getScopedConversation()) : undefined,
      streamFn: this.options.streamFn,
      completeSimpleFn: this.options.completeSimpleFn,
      providerApiKeyLoader: this.options.providerApiKeyLoader,
      permissionEventHandler: (input) => this.appendToolPermissionEvent(conversationId, getScopedConversation(), input),
      permissionNoticeHandler: (input, signal) => this.showPermissionNotice(conversationId, getScopedConversation(), input, signal),
      approvalHandler: (input, signal) => this.requestToolApproval(conversationId, getScopedConversation(), input, signal),
      afterToolResult: (toolCallId, toolName, result, isError) => (
        this.contextManager.afterToolResultForModelContext(conversationId, getScopedConversation(), toolCallId, toolName, result, isError)
      ),
      allowedTools: definition?.tools,
      disallowedTools: definition?.disallowedTools,
      l0CacheBreakpointEnabled: isMultiAgentConversation(conversation.eventState.conversation?.members ?? []),
    }, async (payload) => {
      try {
        await this.captureDebugRunSnapshot(conversationId, payload, getScopedConversation().activeRun?.id);
      } catch (error) {
        this.emitError(conversationId, error instanceof Error ? error.message : String(error));
      }
      return undefined;
    });
    return { agent, definition };
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
    return this.resolveAgentProfile(agentId, conversation.delegationRuntime, conversation.skillRuntime);
  }

  /**
   * The model/effort an agent profile selects. For a writable agent this is its own
   * `model`/`effort` frontmatter; for a read-only built-in it is the settings-owned
   * overlay (keyed by agentId), since built-in definitions are code, not files.
   */
  private async resolveDefinitionModelEffort(
    agentId: string,
    definition: AgentDefinition,
  ): Promise<{ model?: string; effort?: string }> {
    if (definition.source !== 'built-in') {
      return {
        model: definition.model,
        effort: typeof definition.effort === 'string' ? definition.effort : undefined,
      };
    }
    const overlay = await getBuiltInAgentProfile(agentId);
    return {
      model: overlay.model ?? definition.model,
      effort: overlay.effort ?? (typeof definition.effort === 'string' ? definition.effort : undefined),
    };
  }

  /** The built-in assistant's effective model + thinking level over a connection. */
  private async resolveBuiltInAssistantModelEffort(
    providerConfig: AgentProviderRuntimeConfig,
  ): Promise<{ model: Model<Api>; thinkingLevel: AgentReasoningLevel }> {
    const definition = createTenonAssistantAgentDefinition();
    const selection = await this.resolveDefinitionModelEffort(this.agentIdentity.agentId, definition);
    return resolveAgentModelEffort(
      selection.model,
      selection.effort,
      providerConfig,
      () => this.tryResolveProviderModel(providerConfig),
    );
  }

  private async resolveAgentProfile(
    agentId: string,
    delegationRuntime: AgentDelegationRuntime,
    skillRuntime: AgentSkillRuntime,
    options: {
      providerConfig?: AgentProviderRuntimeConfig;
    } = {},
  ): Promise<{
    identity: AgentIdentityRecord;
    model: Model<Api>;
    thinkingLevel: AgentReasoningLevel;
    systemPrompt: string;
    definition: AgentDefinition;
  }> {
    const definitions = this.withBuiltInAgentDefinitions(await delegationRuntime.listAllAgentDefinitions());
    const definition = definitions.find((candidate) => agentDefinitionAgentId(candidate) === agentId);
    if (!definition) throw new Error(`Agent definition not found: ${agentId}`);
    const providerConfig = options.providerConfig ?? await this.getActiveProviderConfig();
    if (!providerConfig) throw new Error('No enabled agent provider is configured.');
    const profileSelection = await this.resolveDefinitionModelEffort(agentId, definition);
    const { model, thinkingLevel } = resolveAgentModelEffort(
      profileSelection.model,
      profileSelection.effort,
      providerConfig,
      () => this.tryResolveProviderModel(providerConfig),
    );
    const skillSections = await this.memberSkillSections(skillRuntime, definition);
    const systemPrompt = composeAgentPrompt(definition, {
      mode: 'member',
      mention: agentMentionToken(agentId),
      profileSkillSections: skillSections,
    });
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
  private async memberSkillSections(
    skillRuntime: AgentSkillRuntime,
    definition: AgentDefinition,
  ): Promise<string[]> {
    const names = definition.skills ?? [];
    if (names.length === 0) return [];
    try {
      const skills = await skillRuntime.listAllSkills();
      const sections: string[] = [];
      let budget = MEMBER_SKILL_PROMPT_BUDGET;
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
      delegationRuntime: conversation.delegationRuntime,
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
    const projection = deriveAgentPovProjection(conversation.eventState, povAgentId, {
      addressedByMessageId,
      mainAgentId: this.coordinatorAgentId(),
      displayNameByAgentId: conversation.memberDisplayNames,
    });
    const messages: AgentMessage[] = [];
    for (const step of projection.steps) {
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
    if (memoryReminder) this.appendTrailingSystemReminder(messages, memoryReminder);
    return messages;
  }

  private async compactConversation(conversationId: string, conversation: AgentConversationState, customInstructions?: string) {
    await this.contextManager.compactConversation(conversationId, conversation, {
      trigger: 'manual',
      customInstructions,
      updateAgentState: true,
    });
    conversation.skillRuntime.resetRunPermissionRules();
  }

  private async handlePiAgentEvent(conversationId: string, conversation: AgentConversationState, event: PiAgentEvent) {
    if (event.type === 'message_start' || event.type === 'message_update') {
      if (isAssistantMessage(event.message)) {
        if (conversation.activeRun?.channelTurn) {
          // Channel turns are not token-streamed into the transcript (the message
          // stream is whole-utterance only). Retain the live composing text on the
          // run so the per-run detail view can surface it, without writing
          // streaming deltas to the shared log (concurrent runs would interleave,
          // and off-active-path siblings never reach the transcript anyway). The
          // final utterance is appended whole on message_end. Only update on
          // NON-EMPTY text: each continuation segment opens with an empty
          // message_start, which would otherwise blank the detail view mid-turn
          // (and stay blank through a tool-only segment), defeating the
          // cross-segment retention.
          const visible = assistantVisibleText(event.message);
          if (visible) conversation.activeRun.assistantText = visible;
          return;
        }
        await this.ensureAssistantStarted(conversationId, conversation, event.message);
        await this.appendAssistantDelta(conversationId, conversation, event.message);
      }
      return;
    }

    if (event.type === 'message_end') {
      if (isUserMessage(event.message)) {
        if (!isDuplicateTailUserMessage(conversation.eventState, event.message)) {
          const messageId = await this.appendUserPromptEvent(conversationId, conversation, event.message);
          // A mid-run user message (e.g. a skill's steering injection) joins this
          // run's spine as its new tail, so the next continuation segment chains
          // after it rather than skipping it (see `lastMessageId`).
          if (conversation.activeRun) conversation.activeRun.lastMessageId = messageId;
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
      conversation.activeRuns.delete(activeRun.id);
      activeRun.unsubscribe?.();
      activeRun.unsubscribe = undefined;
      conversation.activeRun = null;
      activeRun.resolveSettled();
      conversation.skillRuntime.resetRunPermissionRules(activeRun.id);
      await this.getEventStore().maybeWriteCheckpoint(conversationId, conversation.eventState, { force: true });
      if (!activeRun.channelTurn) this.notifyChannelDrainWaiters(conversation);
    }
  }

  private async ensureAssistantStarted(conversationId: string, conversation: AgentConversationState, message: AssistantMessage) {
    const activeRun = conversation.activeRun;
    if (!activeRun || activeRun.assistantMessageId) return;
    const messageId = this.createMessageId('assistant');
    activeRun.assistantMessageId = messageId;
    // DM accumulates streamed deltas from an empty base. A Channel turn's
    // assistantText is only the per-run live-detail buffer (set whole on each
    // message_update), so keep the prior segment's text visible during a tool
    // segment instead of blanking the detail view between segments.
    if (!activeRun.channelTurn) activeRun.assistantText = '';
    await this.appendConversationEvents(conversationId, conversation, [{
      type: 'assistant_message.started',
      actor: this.runActor(conversation),
      runId: this.activeRunId(conversation) ?? randomUUID(),
      messageId,
      addressedByMessageId: activeRun.addressedByMessageId,
      // A run's first segment parents to its addressing message (so concurrent
      // peers fan out as siblings under it); every later segment parents to the
      // run's own tail (`lastMessageId`) so the run stays a linear spine. Falling
      // back to the shared `selectedLeafMessageId` would interleave parallel runs.
      parentMessageId: activeRun.lastMessageId ?? activeRun.addressedByMessageId ?? conversation.eventState.selectedLeafMessageId,
      providerId: message.provider,
      modelId: message.model,
      apiId: message.api,
    }]);
    activeRun.lastMessageId = messageId;
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
    // Keep a Channel turn's last live-detail text across segments (see ensureAssistantStarted).
    if (!activeRun.channelTurn) activeRun.assistantText = '';
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
    const toolResultMessageId = this.createMessageId('tool-result');
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
        messageId: toolResultMessageId,
        parentMessageId: activeRun.toolCallMessageIds.get(message.toolCallId)
          ?? latestAssistantMessageIdForRun(conversation.eventState, activeRun.id),
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        isError: message.isError,
        content: persisted.content,
        outputSummary: summarizeToolResult(message),
        outputRef,
      },
    ]);
    // The tool result is now the run's tail: the next continuation segment
    // chains onto it, keeping this run's spine linear (see `lastMessageId`).
    activeRun.lastMessageId = toolResultMessageId;
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
    const messageId = latestAssistantMessageIdForRun(conversation.eventState, activeRun.id);
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
    const messageId = activeRun
      ? activeRun.toolCallMessageIds.get(toolCallId) ?? latestAssistantMessageIdForRun(conversation.eventState, activeRun.id)
      : findLatestAssistantMessageId(conversation.eventState);
    if (!messageId) return;
    const activeRunId = this.activeRunId(conversation) ?? undefined;
    const events: AgentEventInput[] = [{
      type: isError ? 'tool_call.failed' : 'tool_call.completed',
      actor: toolActor(toolName, toolCallId),
      runId: activeRunId,
      messageId,
      toolCallId,
      errorMessage: isError ? summarizeJson(result) : undefined,
    }];
    const skillAuditEvent = !isError && activeRunId
      ? skillAuditEventFromToolResult(toolName, toolCallId, result, activeRunId)
      : null;
    if (skillAuditEvent) events.push(skillAuditEvent);
    await this.appendConversationEvents(conversationId, conversation, events);
  }

  private async deriveRuntimePiMessages(
    conversationId: string,
    eventState: AgentEventReplayState,
    scopedConversation?: AgentConversationState,
  ): Promise<AgentMessage[]> {
    // Every model call re-derives its context through here (the agent's
    // transformContext → prepareModelContext), so this is THE seam where a
    // multi-agent Channel turn gets its §8 POV assembly: the in-flight run's
    // executing member is the POV. Outside a run (restore, Dream, DMs) the
    // linear derivation stands.
    const conversation = scopedConversation ?? this.conversations.get(conversationId);
    const activeRun = conversation?.activeRun;
    const liveConversation = conversation && conversation.eventState === eventState ? conversation : null;
    let messages: AgentMessage[];
    if (liveConversation && activeRun && this.requiresChannelPov(eventState, activeRun.executingAgentId)) {
      const memoryReminder = await this.buildMemoryReminder(activeRun.executingAgentId, liveConversation);
      messages = await this.deriveChannelPiMessages(
        conversationId,
        liveConversation,
        activeRun.executingAgentId,
        memoryReminder,
        activeRun.addressedByMessageId,
      );
    } else {
      messages = [];
      for (const message of getAgentEventRuntimeTranscriptPath(eventState)) {
        messages.push(await this.runtimePiMessageFromRecord(conversationId, message));
      }
    }
    // Channel/DM environment reminder (the reminder-stack `environment` slot):
    // the member system prompt is identity-only, so DM-vs-Channel framing + the
    // member roster + Channel communication norms ride here instead. POV-correct
    // (written for the executing member) and uniform across the main agent
    // (whose prompt is built separately) and peers. Keyed off conversation
    // identity (DM id prefix), not the live headcount or the POV branch above —
    // a coordinator-only Channel is still a Channel. Only on a real reply run;
    // restore/Dream/compaction have no activeRun.
    if (liveConversation && activeRun) {
      // liveConversation.eventState === eventState by construction, so read the
      // already-in-scope eventState.conversation (matches the POV branch above).
      const environment = buildConversationEnvironmentReminder({
        // DM-vs-Channel is conversation identity, not headcount: a coordinator-only
        // Channel (no extra agents, or shrunk) is still a Channel.
        isChannel: !this.isCanonicalDmConversationId(conversationId),
        members: eventState.conversation?.members ?? [],
        povAgentId: activeRun.executingAgentId,
        channelName: eventState.conversation?.goal ?? null,
        displayNames: liveConversation.memberDisplayNames,
      });
      if (environment) this.appendTrailingSystemReminder(messages, environment);
    }
    return messages;
  }

  /**
   * Append a `<system-reminder>` to the tail of the assembled context, coalescing
   * onto the trailing user block when there is one (else a fresh user block) —
   * the same placement the memory reminder uses, keeping reminders near the
   * current turn and off the cacheable prefix.
   */
  private appendTrailingSystemReminder(messages: AgentMessage[], reminder: string): void {
    const reminderText = systemReminder(reminder);
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

  // App-owned scratch sibling of the workdir. Defaults to `<workdir>/tmp` so a runtime built
  // with only a `localFileRoot` (e.g. in tests) keeps the legacy in-workdir scratch layout.
  private scratchRoot() {
    return scratchRootForWorkdir(this.localFileRoot(), this.options.scratchRoot);
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
      const materialized = await materializePathBackedAttachment(root, this.scratchRoot(), attachment);
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

  // Materialize bridge (handle → path): when the user references outliner image /
  // attachment nodes into a message, copy their asset-store bytes into the agent
  // scratch root and hand them over the same way a composer attachment arrives —
  // a readable path, plus a base64 image block for vision. The renderer keeps the
  // `asset://` handle for its own display; only the agent-facing side gains a path.
  private async materializeReferencedAssetNodes(
    referencedNodes: ReadonlyArray<{ nodeId: string; title?: string }> | undefined,
    alreadyInlinedImages = 0,
  ): Promise<{ imageAttachments: AgentImageAttachmentInput[]; files: MaterializedReferencedFile[] }> {
    const resolver = this.options.assetResolver;
    if (!resolver || !referencedNodes || referencedNodes.length === 0) {
      return { imageAttachments: [], files: [] };
    }
    let projection: DocumentProjection;
    try {
      projection = this.outlinerToolHost.getProjection();
    } catch {
      return { imageAttachments: [], files: [] };
    }
    const selected = selectReferencedAssetNodes(projection, referencedNodes);
    if (selected.length === 0) return { imageAttachments: [], files: [] };

    const root = this.localFileRoot();
    const scratch = this.scratchRoot();
    const imageAttachments: AgentImageAttachmentInput[] = [];
    const files: MaterializedReferencedFile[] = [];
    for (const ref of selected) {
      try {
        const assetPath = await resolver.pathFor(ref.assetId);
        if (!assetPath) continue;
        const meta = await resolver.lookup(ref.assetId);
        let mimeType = meta?.mimeType || ref.nodeMimeType || '';
        const name = meta?.originalFilename || ref.nodeFileName || ref.title || 'attachment';
        const sizeBytes = meta?.byteSize ?? ref.nodeFileSize ?? 0;
        // Copies into scratch; throws (and we skip) when the asset is larger than
        // MAX_MATERIALIZED_ATTACHMENT_BYTES, matching composer-attachment behavior.
        const scratchPath = await materializeAgentLocalPath(root, scratch, assetPath, name);

        // Inline images for vision — best-effort and bounded. The count cap (which
        // includes composer images already in this turn) plus the per-image base64
        // budget keep one turn from ballooning; the size pre-check avoids reading a
        // large file we already know cannot fit. The path entry below is emitted
        // regardless, so a skipped/failed inline still leaves the file readable.
        let inlineImage = false;
        let inlineMime = normalizeInlineImageMimeType(mimeType);
        const underCountCap = (alreadyInlinedImages + imageAttachments.length) < MAX_REFERENCED_INLINE_IMAGES;
        if ((inlineMime || ref.isImageNode) && underCountCap && withinInlineByteBudget(sizeBytes)) {
          try {
            const bytes = await readFile(scratchPath);
            // An image node whose metadata gave no canonical image mime: sniff the
            // bytes — the node type already proves the asset is an image.
            if (!inlineMime && ref.isImageNode) {
              const sniffed = sniffMimeType(bytes, name);
              if (sniffed) {
                if (!mimeType) mimeType = sniffed;
                inlineMime = normalizeInlineImageMimeType(sniffed);
              }
            }
            const dataBase64 = bytes.toString('base64');
            if (inlineMime && dataBase64.length <= MAX_IMAGE_ATTACHMENT_BASE64_CHARS) {
              imageAttachments.push({
                id: randomUUID(),
                ref: name,
                kind: 'image',
                name,
                mimeType: inlineMime,
                sizeBytes,
                dataBase64,
                path: scratchPath,
              });
              inlineImage = true;
            }
          } catch {
            // Inlining is best-effort; fall through and still surface the path.
          }
        }
        if (!mimeType) mimeType = 'application/octet-stream';
        files.push({ nodeId: ref.nodeId, title: ref.title, mimeType, sizeBytes, path: scratchPath, inlineImage });
      } catch {
        // A referenced asset that is missing, oversized, or unreadable is skipped
        // rather than failing the whole send.
      }
    }
    return { imageAttachments, files };
  }
}

function isDirectoryAttachment(attachment: AgentPathBackedAttachment): boolean {
  return attachment.kind === 'file' && attachment.mimeType === 'inode/directory';
}

// Whether a known byte size could possibly fit the inline base64 budget (base64
// length ≈ ceil(bytes / 3) * 4). A size of 0 means "unknown" — let the caller read
// and check the real encoded length.
function withinInlineByteBudget(sizeBytes: number): boolean {
  return sizeBytes <= 0 || Math.ceil(sizeBytes / 3) * 4 <= MAX_IMAGE_ATTACHMENT_BASE64_CHARS;
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
    referencedFilesReminder?: string | null;
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
    referencedFilesReminder?: string | null;
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
    context.referencedFilesReminder,
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

function groupDreamRunInputsByOriginWorkspace(
  inputs: readonly DreamMemoryExtractionRunInput[],
): Array<{ originWorkspace?: string; inputs: DreamMemoryExtractionRunInput[] }> {
  const groups = new Map<string, { originWorkspace?: string; inputs: DreamMemoryExtractionRunInput[] }>();
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

function stringParam(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
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
    sources: entry.sources.map((source) => (
      'episodeId' in source
        ? { episodeId: source.episodeId }
        : { stream: source.stream, streamId: source.streamId, range: { ...source.range } }
    )),
    status: entry.status,
    createdAt: entry.createdAt,
  };
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
    || role === 'preview';
}

function isPreviewPayloadRole(role: AgentPayloadRef['role']): boolean {
  return role === undefined
    || role === 'source'
    || role === 'thumbnail'
    || role === 'preview'
    || role === 'text_extract'
    || role === 'tool_output';
}

function payloadScopeMatchesPreviewTarget(
  payload: AgentPayloadRef,
  conversationId: string,
  runId: string | undefined,
): boolean {
  if (!payload.scope) return true;
  if (payload.scope.conversationId !== conversationId) return false;
  if (payload.scope.type === 'run') return payload.scope.runId === runId;
  return true;
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
  runId: string,
): AgentEventInput | null {
  if (toolName !== 'file_write' && toolName !== 'file_edit') return null;
  const details = isRecord(result) && Object.hasOwn(result, 'details') ? result.details : result;
  if (!isToolEnvelope(details) || !details.ok || details.tool !== toolName || !isRecord(details.data)) return null;
  const skillWrite = parseAgentSkillWriteAudit(details.data.skillWrite);
  if (!skillWrite) return null;
  return {
    type: skillAuditEventType(skillWrite.changeType),
    actor: toolActor(toolName, toolCallId),
    runId,
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

function normalizeUserQuestionNodeRefs(input: unknown): NonNullable<AgentUserQuestionAnswer['nodeRefs']> {
  if (!Array.isArray(input)) return [];
  const out: NonNullable<AgentUserQuestionAnswer['nodeRefs']> = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!isRecord(raw) || typeof raw.nodeId !== 'string') continue;
    const nodeId = raw.nodeId.trim();
    if (!nodeId || seen.has(nodeId)) continue;
    seen.add(nodeId);
    const label = typeof raw.title === 'string' && raw.title.trim()
      ? raw.title.trim().slice(0, 200)
      : typeof raw.label === 'string' && raw.label.trim()
        ? raw.label.trim().slice(0, 200)
        : undefined;
    out.push({ nodeId, ...(label ? { label } : {}) });
  }
  return out;
}

function normalizeUserQuestionFileRefs(
  input: unknown,
  pathMap: Map<string, string>,
): AgentUserQuestionFileReference[] {
  if (!Array.isArray(input)) return [];
  const out: AgentUserQuestionFileReference[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!isRecord(raw)) continue;
    const attachmentId = stringParam(raw.attachmentId, 120);
    const rawPath = stringParam(raw.path, 2000);
    // File refs are user-supplied metadata. Only attachment-backed paths are
    // rewritten through the materialization map; unresolved paths stay as labels.
    const pathValue = rawPath ? pathMap.get(rawPath) ?? rawPath : undefined;
    const ref = sanitizeFileReferenceRef(stringParam(raw.ref, 120) ?? stringParam(raw.name, 120) ?? '');
    const key = attachmentId ?? pathValue ?? ref;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const mimeType = stringParam(raw.mimeType, 200);
    const sizeBytes = typeof raw.sizeBytes === 'number' && Number.isFinite(raw.sizeBytes)
      ? Math.max(0, raw.sizeBytes)
      : undefined;
    const entryKind = raw.entryKind === 'directory' || mimeType === 'inode/directory' ? 'directory' : 'file';
    out.push({
      ...(attachmentId ? { attachmentId } : {}),
      entryKind,
      ...(stringParam(raw.name, 200) ? { name: stringParam(raw.name, 200) } : {}),
      ...(pathValue ? { path: pathValue } : {}),
      ...(ref ? { ref } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    });
  }
  return out;
}

function hasUserQuestionAnswerContent(answer: AgentUserQuestionAnswer): boolean {
  return (typeof answer.text === 'string' && answer.text.trim().length > 0)
    || (typeof answer.notes === 'string' && answer.notes.trim().length > 0)
    || (Array.isArray(answer.selectedOptionIds) && answer.selectedOptionIds.length > 0)
    || (Array.isArray(answer.nodeRefs) && answer.nodeRefs.length > 0)
    || (Array.isArray(answer.fileRefs) && answer.fileRefs.length > 0)
    || (Array.isArray(answer.attachments) && answer.attachments.length > 0);
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
    displayName: 'Neva',
    model: 'unknown',
    systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
    skills: [],
  };
}

function electronAppVersion(): string {
  return typeof app.getVersion === 'function' ? app.getVersion() : 'dev';
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Cap on inlined profile-skill bodies in a DM/Channel member's system prompt. */
const MEMBER_SKILL_PROMPT_BUDGET = 24_000;

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
  return Object.values(eventState.messages)
    .filter((record): record is AgentEventMessageRecord & { role: 'assistant' } => (
      record.role === 'assistant' && record.runId === runId
    ))
    .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0] ?? null;
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
    delegationRuntime?: AgentDelegationRuntime;
    recall?: AgentToolsOptions['recall'];
    askUserQuestion?: AgentToolsOptions['askUserQuestion'];
    selfMaintenance?: AgentToolsOptions['selfMaintenance'];
    localWorkspace?: AgentLocalWorkspaceContext;
    allowedTools?: string[];
    disallowedTools?: string[];
    preapprovedToolRules?: string[];
    l0CacheBreakpointEnabled?: boolean;
    approvalHandler?: (input: AgentToolApprovalInput, signal?: AbortSignal) => Promise<AgentToolApprovalResolution>;
    permissionNoticeHandler?: (input: {
      requestId: string;
      toolCall: ToolCall;
      args: unknown;
      decision: AgentPermissionDenyDecision;
    }, signal?: AbortSignal) => Promise<void>;
    streamFn?: StreamFn;
    completeSimpleFn?: CompleteSimpleFn;
    permissionEventHandler?: (input: AgentToolPermissionLogInput) => Promise<void> | void;
    afterToolResult?: (
      toolCallId: string,
      toolName: string,
      result: unknown,
      isError: boolean,
    ) => Promise<AfterToolCallResult | undefined> | AfterToolCallResult | undefined;
  } = {},
  onPayload?: (payload: unknown, model: Model<any>) => unknown | undefined | Promise<unknown | undefined>,
) {
  const model = options.model ?? resolveModel(providerConfig);
  const localFileRoot = options.localFileRoot;
  const skillRuntime = options.skillRuntime;
  let syncedLocalPermissionRootSignature = '';
  const systemPrompt = options.systemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT;
  let activeLoopModel = model;
  let activeThinkingLevel = options.thinkingLevel ?? defaultThinkingLevel(model);
  let agent: Agent;
  agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: activeThinkingLevel,
      tools: createAgentTools(outlinerToolHost, {
        localFileRoot,
        localWorkspace: options.localWorkspace,
        skillRuntime,
        skillToolEnabled: options.skillToolEnabled,
        delegationRuntime: options.delegationRuntime,
        recall: options.recall,
        askUserQuestion: options.askUserQuestion,
        selfMaintenance: options.selfMaintenance,
        allowedTools: options.allowedTools,
        disallowedTools: options.disallowedTools,
      }),
      messages,
    },
    streamFn: createProviderConfiguredStreamFn(options.streamFn ?? streamSimple as StreamFn, options.runtimeSettingsLoader),
    onPayload: async (payload, payloadModel) => {
      const payloadWithBreakpoints = applyAgentPromptCacheBreakpoints(payload, payloadModel, {
        enabled: options.l0CacheBreakpointEnabled ?? false,
        systemPrompt,
      });
      const payloadForCallback = payloadWithBreakpoints ?? payload;
      const callbackPayload = await onPayload?.(payloadForCallback, payloadModel);
      return callbackPayload ?? payloadWithBreakpoints;
    },
    getApiKey: async (provider) => {
      if (provider === providerConfig.providerId) {
        return providerConfig.apiKey ?? options.providerApiKeyLoader?.(provider) ?? getProviderApiKey(provider);
      }
      return options.providerApiKeyLoader?.(provider) ?? getProviderApiKey(provider);
    },
    beforeToolCall: async ({ toolCall, args }, signal) => {
      const globalPermissions = await readAgentToolPermissionConfig();
      const shouldSyncLocalPermissionRoots = Boolean(
        options.localWorkspace
        && LOCAL_FILE_TOOL_NAMES.has(toolCall.name.trim().replace(/-/g, '_').toLowerCase()),
      );
      const syncLocalPermissionRoots = (extraGrants: readonly AgentPermissionGrant[] = []) => {
        if (!options.localWorkspace || !shouldSyncLocalPermissionRoots) return;
        const roots = [
          ...globalPermissions.grants.flatMap((rule) => (
            rule.grant.kind === 'scope'
              ? [{ access: rule.grant.access, root: rule.grant.root }]
              : []
          )),
          ...extraGrants.flatMap((grant) => (
            grant.kind === 'scope'
              ? [{ access: grant.access, root: grant.root }]
              : []
          )),
        ];
        const signature = roots.map((root) => `${root.access}:${root.root}`).join('\0');
        if (signature === syncedLocalPermissionRootSignature) return;
        setAgentLocalPermissionRoots(options.localWorkspace, roots);
        syncedLocalPermissionRootSignature = signature;
      };
      if (shouldSyncLocalPermissionRoots) syncLocalPermissionRoots();
      const decision = evaluateAgentToolPermission({
        toolName: toolCall.name,
        args,
        policy: {
          mode: options.permissionMode,
          workspaceRoot: localFileRoot,
          scratchRoot: options.localWorkspace?.scratchRoot,
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
        const askResolution = await resolveAgentPermissionAsk({
          decision,
          interactionAvailable: Boolean(options.approvalHandler),
          signal,
        });
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
          if (approval.approved) {
            if (shouldSyncLocalPermissionRoots) {
              syncLocalPermissionRoots((decision.descriptors ?? [])
                .map((descriptor) => descriptor.effect.grant)
                .filter((grant): grant is AgentPermissionGrant => grant !== undefined));
            }
            return undefined;
          }
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
      await options.permissionNoticeHandler?.({
        requestId: permissionRequestId,
        toolCall,
        args,
        decision,
      }, signal);
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

// `AGENT_REASONING_LEVELS` membership and `nearestSupportedLevel` distance both
// derive from the single shared ordered ladder in core (`AGENT_REASONING_LADDER`).
const AGENT_REASONING_LEVELS = new Set<AgentReasoningLevel>(AGENT_REASONING_LADDER);
// The default effort an agent runs at when it has not chosen one. `medium` keeps a
// reasoning-capable model actually reasoning by default (a provider connection no
// longer carries a global reasoning level), coerced to the model's nearest level.
const DEFAULT_AGENT_THINKING_LEVEL: AgentReasoningLevel = 'medium';

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
  return resolveModelOverride(requested, providerConfig) ?? currentModel;
}

/**
 * Resolve a model-selection string against a provider CONNECTION. Accepts a bare
 * model id or a `providerId/modelId` (or `providerId:modelId`) qualifier. Returns a
 * catalog model when the id is known, an OpenAI-compatible model for the
 * connection's custom endpoint, or null when nothing matches (the caller decides
 * the fallback). The provider connection no longer carries a model, so this is the
 * single place a model string becomes a `Model`.
 */
function resolveModelOverride(
  requested: string,
  providerConfig: AgentProviderRuntimeConfig,
): Model<Api> | null {
  const parsed = parseProviderQualifiedModel(requested, isKnownProviderId);
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
  return null;
}

/**
 * The default catalog model for a provider connection — the first after the shared
 * ranking sort (`rankedModels`), with the connection's base URL applied. Null for a
 * custom endpoint with no catalog (where the agent profile must name the model).
 */
function resolveProviderCatalogModel(config: AgentProviderRuntimeConfig): Model<Api> | null {
  const first = rankedModels(config.providerId)[0];
  if (!first) return null;
  return config.baseUrl ? { ...first, baseUrl: config.baseUrl } : first;
}

/**
 * The model a provider connection runs by default when no agent profile names one.
 * Throws (rather than returns null) for the utility callers — compaction, dream,
 * roster display — that always need a concrete model.
 */
function resolveModel(config: AgentProviderRuntimeConfig): Model<Api> {
  const model = resolveProviderCatalogModel(config);
  if (model) return model;
  if (config.baseUrl) {
    throw new Error(`No catalog model for custom provider ${config.providerId}; set a model on the agent profile.`);
  }
  throw new Error(`model not found for provider ${config.providerId}`);
}

/**
 * The model a model-selection string resolves to. `fallback` is a THUNK for the
 * provider connection's default model (resolved by the caller through the injectable
 * `resolveProviderModel` seam, so tests and custom resolvers are honored); it is
 * invoked lazily — only an empty/`inherit` selection (or an unresolvable explicit
 * one) needs it, so an explicit, resolvable model never triggers the catalog sort.
 */
function resolveAgentModel(
  modelInput: string | undefined,
  config: AgentProviderRuntimeConfig,
  fallback: () => Model<Api> | null,
): Model<Api> {
  const requested = modelInput?.trim();
  if (!requested || requested === 'inherit') {
    const resolved = fallback();
    if (resolved) return resolved;
    throw new Error('No model is configured for this agent. Set a default model in the agent profile.');
  }
  const resolved = resolveModelOverride(requested, config);
  if (resolved) return resolved;
  const fell = fallback();
  if (fell) return fell;
  throw new Error(`Model not found for provider ${config.providerId}: ${requested}`);
}

/** The supported reasoning level nearest `target` on the ladder (ties favour lower). */
function nearestSupportedLevel(
  target: AgentReasoningLevel,
  supported: readonly AgentReasoningLevel[],
): AgentReasoningLevel {
  if (supported.includes(target)) return target;
  const targetIndex = AGENT_REASONING_LADDER.indexOf(target);
  let best = supported[0];
  let bestDistance = Infinity;
  for (const level of supported) {
    const distance = Math.abs(AGENT_REASONING_LADDER.indexOf(level) - targetIndex);
    if (distance < bestDistance
      || (distance === bestDistance && AGENT_REASONING_LADDER.indexOf(level) < AGENT_REASONING_LADDER.indexOf(best))) {
      best = level;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The default thinking level an agent runs at when its profile sets no effort:
 * `medium` coerced to the model's nearest supported level (a non-reasoning model
 * supporting only `off` stays `off`).
 */
function defaultThinkingLevel(model: Model<Api>): AgentReasoningLevel {
  const supported = getSupportedThinkingLevels(model).filter((item): item is AgentReasoningLevel => (
    AGENT_REASONING_LEVELS.has(item as AgentReasoningLevel)
  ));
  if (!supported.length) return 'off';
  return nearestSupportedLevel(DEFAULT_AGENT_THINKING_LEVEL, supported);
}

/**
 * Resolve the effective model + thinking level an agent runs with, from its
 * profile's model/effort selection over a provider connection. The single seam the
 * runtime uses now that the provider connection owns neither. `fallback` is a thunk
 * for the connection's default model (see `resolveAgentModel`).
 */
function resolveAgentModelEffort(
  modelInput: string | undefined,
  effortInput: string | undefined,
  config: AgentProviderRuntimeConfig,
  fallback: () => Model<Api> | null,
): { model: Model<Api>; thinkingLevel: AgentReasoningLevel } {
  const model = resolveAgentModel(modelInput, config, fallback);
  const thinkingLevel = effortInput
    ? resolveSkillEffortOverride(effortInput, model, defaultThinkingLevel(model))
    : defaultThinkingLevel(model);
  return { model, thinkingLevel };
}

let knownProviderIdsCache: Set<string> | null = null;
function isKnownProviderId(providerId: string): boolean {
  if (!knownProviderIdsCache) knownProviderIdsCache = new Set(getProviders());
  return knownProviderIdsCache.has(providerId);
}

function clampEvidenceText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  if (maxChars <= 0) return { text: '', truncated: true };
  return { text: text.slice(0, maxChars), truncated: true };
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

function childRunNotificationKind(
  // 'cancelled' is gated out before this (a user-initiated stop raises no
  // notification — see notifyChildRun), so only failed/completed reach here.
  status: 'failed' | 'completed',
): AgentNotificationKind {
  return status === 'failed' ? 'task_failed' : 'task_completed';
}

function childRunNotificationTitle(snapshot: AgentChildRunSnapshot): string {
  if (snapshot.status === 'failed') return `Agent task "${snapshot.description}" failed.`;
  if (snapshot.status === 'cancelled') return `Agent task "${snapshot.description}" was stopped.`;
  return `Agent task "${snapshot.description}" completed.`;
}

function formatChildRunNotification(snapshot: AgentChildRunSnapshot): string {
  const summary = childRunNotificationTitle(snapshot);
  return [
    '<agent-task-notification>',
    `<agent_id>${escapeXml(snapshot.id)}</agent_id>`,
    snapshot.name ? `<name>${escapeXml(snapshot.name)}</name>` : null,
    `<description>${escapeXml(snapshot.description)}</description>`,
    `<agent_type>${escapeXml(snapshot.agentType)}</agent_type>`,
    `<context_mode>${escapeXml(snapshot.contextMode)}</context_mode>`,
    `<status>${escapeXml(snapshot.status)}</status>`,
    `<summary>${escapeXml(summary)}</summary>`,
    snapshot.result ? `<result>${escapeXml(snapshot.result)}</result>` : null,
    snapshot.error ? `<error>${escapeXml(snapshot.error)}</error>` : null,
    '</agent-task-notification>',
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
      systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
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

function findKnownModel(providerId: string, modelId: string): Model<Api> | null {
  try {
    return getModels(providerId as KnownProvider).find((model) => model.id === modelId) as Model<Api> | undefined ?? null;
  } catch {
    return null;
  }
}

function createOpenAICompatibleModel(
  config: { providerId: string; modelId: string; baseUrl?: string },
): Model<'openai-completions'> {
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

function fallbackEpisodeGist(span: DreamMemoryExtractionSpan): string {
  const normalized = span.transcript.trim().replace(/\s+/g, ' ');
  if (!normalized) return 'Episode gist unavailable; see raw evidence pointers.';
  const maxChars = 1_200;
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
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

// ONE cursor shape for every stream ([[agent-run-unification]] Design 3): a
// conversation and a delegated run's ledger advance the same `{seq, eventId}`
// frontier — the positional `{messageCount, payloadId}` cursor died with the
// transcript-snapshot representation.
function dreamWatermarkFromSpan(
  previous: AgentDreamWatermark,
  ranges: readonly DreamMemoryExtractionSourceRange[],
): AgentDreamWatermark {
  const conversations = { ...previous.conversations };
  const runs = { ...(previous.runs ?? {}) };
  for (const range of ranges) {
    if (range.source.stream === 'run') {
      const current = runs[range.source.streamId];
      if (current && current.seq > range.throughSeq) continue;
      runs[range.source.streamId] = {
        seq: range.throughSeq,
        eventId: range.throughEventId,
      };
      continue;
    }
    const current = conversations[range.source.streamId];
    if (current && current.seq > range.throughSeq) continue;
    conversations[range.source.streamId] = {
      seq: range.throughSeq,
      eventId: range.throughEventId,
    };
  }
  return { conversations, runs };
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
  return Object.fromEntries(ranges.filter((range) => range.source.stream === 'conversation').map((range) => [range.source.streamId, {
    fromSeqExclusive: range.fromSeqExclusive,
    throughSeq: range.throughSeq,
    throughEventId: range.throughEventId,
    messageCount: range.messageCount,
    charCount: range.charCount,
  }]));
}

function dreamProcessedRuns(
  ranges: readonly DreamMemoryExtractionSourceRange[],
): Record<string, {
  conversationId: string;
  fromSeqExclusive: number;
  throughSeq: number;
  throughEventId: string | null;
  messageCount: number;
  charCount: number;
}> {
  return Object.fromEntries(ranges.flatMap((range) => {
    if (range.source.stream !== 'run') return [];
    return [[range.source.streamId, {
      conversationId: range.conversationId ?? '',
      fromSeqExclusive: range.fromSeqExclusive,
      throughSeq: range.throughSeq,
      throughEventId: range.throughEventId,
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
 * Round-robin merge of readable memory pools into one budget, reader-own pool first within each
 * round. A plain concatenation would let a full self-model starve co-member zones to nothing;
 * interleaving guarantees every readable pool a fair share of whatever budget remains. Each input
 * is already ordered for its surface (query-ranked for recall, resident activation + exploration
 * for briefing), and the merge preserves that order within each pool.
 */
function interleaveMemoryEntryGroups(
  groups: readonly (readonly AgentMemoryEntry[])[],
  limit: number,
): AgentMemoryEntry[] {
  const merged: AgentMemoryEntry[] = [];
  const seen = new Set<string>();
  const push = (entry: AgentMemoryEntry | undefined): void => {
    if (!entry || merged.length >= limit) return;
    const key = `${principalKey(entry.principal)}\0${entry.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(entry);
  };
  const rounds = Math.max(0, ...groups.map((group) => group.length));
  for (let i = 0; i < rounds && merged.length < limit; i += 1) {
    for (const group of groups) {
      push(group[i]);
      if (merged.length >= limit) break;
    }
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

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
