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
  type AgentChildRunNodeChanges,
  type AgentRuntimeEvent,
  type AgentApprovalRequestView,
  type AgentApprovalResolutionScope,
  type AgentAuthoringInput,
  type AgentDefinitionView,
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
  type AgentDreamWindow,
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
  type AgentRunKind,
  type AgentRunTrigger,
  type AgentRunMeta,
  type AgentUserQuestionAnswer,
  type AgentUserQuestionAttachment,
  type AgentUserQuestionFileReference,
  type AgentUserQuestionRequestView,
} from '../core/agentEventLog';
import {
  CHANNEL_INCLUDE_IN_DREAM_DATA_SETTING,
  DEFAULT_DREAM_CHANNEL_ID,
  DEFAULT_DREAM_CHANNEL_TITLE,
  DEFAULT_GENERAL_CHANNEL_ID,
  DEFAULT_GENERAL_CHANNEL_TITLE,
  agentMentionToken,
  channelIncludesInDreamData,
  channelAgentMembers,
} from '../core/agentChannel';
import {
  formatChatSourceReferenceMarker,
  rewriteFileReferenceMarkerPaths,
  richTextToReferenceMarkup,
  sanitizeFileReferenceRef,
} from '../core/referenceMarkup';
import { normalizeConversationTitle, sanitizeConversationTitle } from '../core/agentConversationTitle';
import { TOOL_CATALOG } from '../core/agentToolCatalog';
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
  summarizeRunStream,
} from './agentDebugView';
import {
  AgentEventStore,
  MAX_AGENT_MEMORY_FACT_CHARS,
  type AgentConversationIndexEntry,
  type AgentRunMetaProjection,
} from './agentEventStore';
import {
  buildConsolidateOnlyDreamMemoryExtractionSpan,
  dreamWindowSummary,
  buildDreamMemoryExtractionSpanFromEvents,
  type DreamMemoryExtractionSpan,
  type DreamMemoryExtractionSourceRange,
  type DreamMemoryExtractionCreatedAtRange,
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
  DEFAULT_DREAM_SCHEDULE,
  type AgentProviderRuntimeConfig,
  type StoredBuiltInAgentProfile,
} from './agentSettings';
import { parseProviderQualifiedModel } from '../core/agentModelId';
import {
  appendAgentToolPermissionGrant,
  appendAgentToolPermissionSoftBlockAllow,
  readAgentToolPermissionConfig,
  removeAgentToolPermissionBlock,
} from './agentToolPermissionStore';
import type { OutlinerToolHost } from './agentNodeTools';
import { AgentUserViewContextReminderTracker, buildUserViewContextReminder } from './agentUserViewContextReminder';
import { buildConversationEnvironmentReminder } from './agentConversationEnvironmentReminder';
import {
  AgentSkillRuntime,
  createUserSkillPrompt,
  type SkillListingReservation,
  type SkillTurnEffect,
} from './agentSkills';
import { createAgentSkillProvenanceStore } from './agentSkillProvenanceStore';
import {
  AGENT_DELEGATE_TOOL_NAME,
  AgentDelegationRuntime,
  createTenonAssistantAgentDefinition,
  recordNodeToolChanges,
  type AgentChildAgentCreateInput,
  type AgentChildRunSnapshot,
} from './agentDelegation';
import {
  agentDefinitionAgentId,
} from './agentDelegationIdentity';
import { AgentRunLedgerWriter, fromPiAssistantContent } from './agentRunLedger';
import type { AgentSkillWriteAudit } from './agentSkillAuthoring';
import { executeAgentSkillShellCommand } from './agentSkillShell';
import {
  evaluateAgentToolPermission,
  type AgentPermissionAskDecision,
  type AgentPermissionSoftBlockDecision,
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
import { defaultThinkingLevelFor } from '../core/agentReasoning';
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
  type DoctorDiagnostic,
} from './agentSelfMaintenanceTools';
import {
  applyAgentRenderProjectionPatch,
  buildAgentRenderProjection,
  renderTaskStatusFromRunStatus,
  type AgentRenderMessageEntity,
  type AgentDreamReadiness,
  type AgentRenderActiveCompaction,
  type AgentRenderActiveDream,
  type AgentRenderLiveContent,
  type AgentRenderProjection,
  type AgentRenderProjectionPatch,
  type AgentRenderDreamTaskEntity,
  type AgentRenderTaskEntity,
  type AgentRenderTaskStatus,
} from '../core/agentRenderProjection';
import { createAbortSettledStreamFn } from './agentStreamAbort';
import { awaitWithAbort, throwIfAborted } from './agentAwaitWithAbort';
import { shouldFireDateSchedule } from '../core/dateSchedule';
import {
  addLocalDays,
  compareIsoLocalDates,
  dateFromIsoLocalDate,
  isoLocalDate,
  normalizedIsoLocalDate,
  offsetIsoLocalDate,
  startOfLocalDay,
} from '../core/localDate';
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
const SCHEDULED_DREAM_MAX_ATTEMPTS_PER_DUE = 3;
const DREAM_MIN_VOLUME_CHARS = 1_000;
const DREAM_CHANNEL_RETAINED_RUNS = 512;
const MEMORY_DREAM_SKILL_NAME = 'memory-dream';
const LEGACY_MEMORY_DREAM_CONVERSATION_ID = 'lin-agent-memory-dream';
const MEMORY_DREAM_ALLOWED_TOOLS = [
  'past_chats',
  'node_search',
  'node_read',
  'node_create',
  'node_edit',
  'node_delete',
] as const;
const CHILD_RUN_TRANSCRIPT_CACHE_LIMIT = 16;
const DEBUG_RUN_CACHE_LIMIT = 64;

/**
 * Conversation-stream events the run-grounded debug view ([[agent-debug-run-grounded]])
 * needs but a run's own ledger lacks — read once per conversation, cached by its
 * latestSeq, shared across every run in the view.
 */
interface DebugConversationContext {
  latestSeq: number;
  /** childRunId → parentToolCallId (from `child_run.started`). */
  parentToolCallByChild: Map<string, string>;
  /** messageId → the triggering `user_message.created` (appended with no runId). */
  triggerMessages: Map<string, Extract<AgentEvent, { type: 'user_message.created' }>>;
  /** toolCallId → conversation-budget `tool_result.replaced` slimming for that call. */
  replacedByToolCall: Map<string, Extract<AgentEvent, { type: 'tool_result.replaced' }>[]>;
}
const DREAM_SCHEDULER_INTERVAL_MS = 60_000;
const COMMAND_SCHEDULER_INTERVAL_MS = 60_000;
// In-memory per-command failure backoff (openclaw-style); process-level, never
// persisted. A failed fire does not advance the watermark, so it stays due.
const COMMAND_FAILURE_BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000] as const;
// How long each `status({wait})` poll blocks while waiting for a background-flagged
// command child run to finish (it re-polls if the run is still going).
const COMMAND_CHILD_RUN_WAIT_MS = 600_000;
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
  decision: AgentPermissionAskDecision | AgentPermissionSoftBlockDecision;
}

interface AgentToolApprovalResolution {
  approved: boolean;
  deniedReason?: PermissionDeniedReason;
  scope?: AgentApprovalResolutionScope;
  alwaysAllowRule?: string;
}

interface AgentPendingApproval {
  conversationId: string;
  runId?: string;
  request: AgentApprovalRequestView;
  alwaysAllowRule?: string;
  alwaysAllowAction?: 'grant' | 'soft_allow' | 'remove_block';
  autoBlockTimer?: ReturnType<typeof setTimeout>;
  onApproved?: () => Promise<void>;
  resolve: (resolution: AgentToolApprovalResolution) => void;
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
  unsubscribe?: () => void;
  settled: Promise<void>;
  resolveSettled: () => void;
  assistantMessageId: string | null;
  assistantText: string;
  assistantContent: AgentRenderLiveContent[];
  assistantLiveSegmentStart: number;
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
}

interface AgentRosterEntry {
  agentId: string;
  displayName: string;
  model?: string;
}

type RendererProjectionDomainEvent = Extract<AgentDomainEvent, { lane: 'renderer-projection' }>;

type PublicConversationRuntimeEventInput =
  | Omit<Extract<AgentRuntimeEvent, { type: 'approval_request' }>, 'conversationId' | 'timestamp'>
  | Omit<Extract<AgentRuntimeEvent, { type: 'approval_resolved' }>, 'conversationId' | 'timestamp'>
  | Omit<Extract<AgentRuntimeEvent, { type: 'user_question_request' }>, 'conversationId' | 'timestamp'>
  | Omit<Extract<AgentRuntimeEvent, { type: 'user_question_resolved' }>, 'conversationId' | 'timestamp'>
  | Omit<Extract<AgentRuntimeEvent, { type: 'closed' }>, 'conversationId' | 'timestamp'>
  | Omit<Extract<AgentRuntimeEvent, { type: 'error' }>, 'conversationId' | 'timestamp'>;

/** Allow/deny filter passed to {@link createAgentTools} for a conversation's default agent. */
interface AgentToolFilter {
  allowedTools: readonly string[] | undefined;
  disallowedTools: readonly string[] | undefined;
}

/**
 * Resolve the tool allow/deny filter for a conversation's default agent.
 *
 * External file agents keep a strict allow-list: their `tools` field is the
 * complete capability set and is applied verbatim by `filterAgentTools`.
 *
 * The built-in assistant (Neva) is different: its core tools — `past_chats`,
 * `node_*`, `skill`, and self-maintenance — are never part of the
 * editable catalog (`TOOL_CATALOG`), so a strict allow-list would silently
 * strip them. A catalog restriction is therefore expressed as a *disallow-list
 * over the unchecked catalog tools*, never as an allow-list; the core tools
 * (and any user-typed extra tools) stay enabled.
 */
export function resolveAgentToolFilter(input: {
  isBuiltIn: boolean;
  tools: readonly string[] | undefined;
  disallowedTools: readonly string[] | undefined;
}): AgentToolFilter {
  const { isBuiltIn, tools, disallowedTools } = input;
  if (!isBuiltIn) return { allowedTools: tools, disallowedTools };
  if (!tools || tools.includes('*')) return { allowedTools: undefined, disallowedTools };
  const merged = [...(disallowedTools ?? [])];
  for (const name of TOOL_CATALOG) {
    if (!tools.includes(name) && !merged.includes(name)) merged.push(name);
  }
  return { allowedTools: undefined, disallowedTools: merged };
}

/**
 * Did a built-in agent edit actually change the model or effort?
 *
 * The composer chip and the editor both round-trip the *full* definition, so a
 * persona/display-name/tools edit re-sends the existing `model`/`effort`
 * unchanged. We only re-resolve and live-swap the conversation's model when one
 * of these two fields really moved — otherwise editing Neva's persona while a
 * different provider happens to be active would silently switch the running
 * conversation's model (model is `inherit` → it resolves to the *current*
 * provider, not the one the conversation started under).
 *
 * `inherit`/blank model and blank effort are the "unset" sentinels, so they
 * normalize together: `undefined`, `''`, `'  '`, and `'inherit'` are all "no
 * model override" and compare equal.
 */
export function builtInModelEffortChanged(
  prev: { model?: string | null; effort?: string | null },
  next: { model?: string | null; effort?: string | null },
): boolean {
  const normModel = (value?: string | null) =>
    value && value.trim() && value.trim() !== 'inherit' ? value.trim() : 'inherit';
  const normEffort = (value?: string | null) => (value && value.trim() ? value.trim() : '');
  return normModel(prev.model) !== normModel(next.model) || normEffort(prev.effort) !== normEffort(next.effort);
}

interface AgentConversationState {
  agent: Agent;
  defaultAgentId: string;
  /** Tool allow/deny filter for the default agent, reapplied on runtime-settings changes. */
  agentToolFilter: AgentToolFilter;
  activeRuns: Map<string, AgentActiveRunState>;
  activeRun: AgentActiveRunState | null;
  lastRun: AgentActiveRunState | null;
  autoCompactConsecutiveFailures: number;
  autoCompactInProgress: boolean;
  eventState: AgentEventReplayState;
  activeCompaction: AgentRenderActiveCompaction | null;
  activeDream: AgentRenderActiveDream | null;
  pendingChildRunNotifications: string[];
  pendingEventAppend: Promise<void>;
  pendingProjectionLastEventType: string | null;
  pendingProjectionTimer: ReturnType<typeof setTimeout> | null;
  lastRenderProjection: AgentRenderProjection | null;
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
  unsubscribe: (() => void) | null;
}

interface AgentDreamMemoryExtractionTask {
  runId: string;
  /** The memory pool this Dream consolidates (the subject it models, and the run anchor). */
  principal: AgentPrincipal;
  trigger: AgentDreamTrigger;
  startedAt: number;
  dueAt?: number;
  schedule: string;
  window: AgentDreamWindow;
  guidance?: string;
  span: DreamMemoryExtractionSpan;
  watermark: AgentDreamWatermark;
}

interface AgentDreamRunResult {
  agentId: string;
  runId?: string;
  trigger: AgentDreamTrigger;
  window?: AgentDreamWindow;
  status: AgentDreamMarkerStatus;
  startedAt: number;
  completedAt: number;
  processed?: Extract<AgentMemoryEvent, { type: 'dream.completed' }>['processed'];
  changes?: AgentDreamCompletedChanges;
  errorMessage?: string;
}

interface AgentDreamRunOptions {
  startDate?: string;
  endDate?: string;
  guidance?: string;
}

interface DerivedDreamChannelState {
  finishedByRunId: Map<string, Extract<AgentEvent, { type: 'dream.finished' }>>;
  lastDreamedThrough: string | null;
}

type AgentEventInput = AgentRuntimeContextEventInput;
type AgentMemberPrincipal = Extract<AgentPrincipal, { type: 'agent' }>;
interface ProtectedDefaultChannelConfig {
  id: string;
  title: string;
  sortRank: number;
  projectionEvent: string;
  forcedSettings?: Record<string, unknown>;
}

const PROTECTED_DEFAULT_CHANNELS: readonly ProtectedDefaultChannelConfig[] = [
  {
    id: DEFAULT_GENERAL_CHANNEL_ID,
    title: DEFAULT_GENERAL_CHANNEL_TITLE,
    sortRank: 0,
    projectionEvent: 'general_channel_updated',
  },
  {
    id: DEFAULT_DREAM_CHANNEL_ID,
    title: DEFAULT_DREAM_CHANNEL_TITLE,
    sortRank: 1,
    projectionEvent: 'dream_channel_updated',
    forcedSettings: { [CHANNEL_INCLUDE_IN_DREAM_DATA_SETTING]: false },
  },
] as const;

interface AgentConversationChannelUpdateOptions {
  title?: string;
  addAgentIds?: readonly string[];
  removeAgentIds?: readonly string[];
}

interface AgentConversationChannelUpdateResult {
  conversation: AgentConversationListMeta;
  addedAgentIds: string[];
  removedAgentIds: string[];
  renamed: boolean;
}

/** Opt-in OS-notification sink, wired by main.ts (owns the native Electron Notification). */
export type OsNotifier = (input: { title: string; body?: string; conversationId: string }) => void;
type AgentUserViewPanel = AgentUserViewContext['nodePanels'][number];
type AgentUserViewNode = NonNullable<AgentUserViewContext['focusedNode']>;
type AgentUserViewOutlineNode = AgentUserViewPanel['visibleOutline'][number];

export class AgentRuntime {
  private conversations = new Map<string, AgentConversationState>();
  private generalChannelEnsureInFlight: Promise<AgentEventReplayState> | null = null;
  private dreamChannelEnsureInFlight: Promise<AgentEventReplayState> | null = null;
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
  // The debug view's caches, all bounded LRU (run ids are globally unique, so an
  // evicted entry is just re-derived; none grows across a session):
  // - conversation context (triggering messages / parent links / slimming), keyed
  //   by the conversation's latestSeq;
  // - light per-run SUMMARY nodes for the tree, keyed by the run's latestSeq;
  // - full per-run DETAIL, also keyed by the conversation context seq (it splices
  //   in conversation-stream slimming, so it must invalidate when that changes).
  private debugConversationContextCache = new Map<string, DebugConversationContext>();
  private debugRunSummaryCache = new Map<string, { latestSeq: number; parentToolCallId: string | null; summary: AgentDebugRunSummary }>();
  private debugRunCache = new Map<string, { latestSeq: number; contextSeq: number; parentToolCallId: string | null; run: AgentDebugRun }>();
  private eventStore: AgentEventStore | null = null;
  private pastChatsService: AgentPastChatsService | null = null;
  private pendingApprovals = new Map<string, AgentPendingApproval>();
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
  // Mutable: the primary agent (Neva) is user-customizable, so her display name and
  // composed system prompt are refreshed from the editable built-in overlay at
  // startup and after each edit ([[single-agent-collapse]]). `agentId` never changes
  // — it stays the stable memory anchor.
  private agentIdentity: AgentIdentityRecord;
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
        // The retry continues the SAME turn: same executing member — never the
        // coordinator's identity by default.
        await this.startRun(conversationId, conversation, conversation.lastRun?.lastSubmittedUserPrompt ?? null, null, {
          executingAgentId: conversation.lastRun?.executingAgentId,
        });
      },
      completeSimpleFn: this.options.completeSimpleFn,
    });
    this.startDreamScheduler();
    this.startCommandScheduler();
  }

  ready() {
    this.emit({ type: 'ready', conversationId: null, timestamp: Date.now() });
    // Load the user's editable assistant overlay into the primary identity (display
    // name + composed persona) before conversations are set up.
    void this.refreshPrimaryAgentIdentity()
      .catch((error) => this.reportWarn('agent-runtime', 'Failed to load assistant profile overlay.', error));
    void this.ensureDefaultChannelEventStates()
      .catch((error) => this.reportWarn('agent-runtime', 'Failed to ensure default channels.', error));
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
    // Single-agent collapse: the default landing is the General channel, not a
    // per-agent DM (the DM primitive is gone — every conversation is a channel).
    return this.restoreOrCreateGeneralChannel();
  }

  async restoreConversation(conversationId: string) {
    if (conversationId === DEFAULT_GENERAL_CHANNEL_ID) {
      return this.restoreOrCreateGeneralChannel();
    }
    if (conversationId === DEFAULT_DREAM_CHANNEL_ID) {
      return this.restoreOrCreateDreamChannel();
    }
    const eventState = await this.loadEventState(conversationId);
    if (!eventState.conversation) {
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

  private async restoreOrCreateGeneralChannel() {
    const eventState = await this.ensureGeneralChannelEventState();
    const conversation = await this.createConversationWithEventState(eventState);
    await this.refreshAgentTaskCache();
    return this.conversationResponse(DEFAULT_GENERAL_CHANNEL_ID, conversation);
  }

  private async restoreOrCreateDreamChannel() {
    const eventState = await this.ensureDreamChannelEventState();
    const conversation = await this.createConversationWithEventState(eventState);
    await this.refreshAgentTaskCache();
    return this.conversationResponse(DEFAULT_DREAM_CHANNEL_ID, conversation);
  }

  private async ensureDefaultChannelEventStates(): Promise<void> {
    await Promise.all([
      this.ensureGeneralChannelEventState(),
      this.ensureDreamChannelEventState(),
    ]);
  }

  private async ensureGeneralChannelEventState(): Promise<AgentEventReplayState> {
    if (this.generalChannelEnsureInFlight) return this.generalChannelEnsureInFlight;
    const operation = this.ensureGeneralChannelEventStateOnce()
      .finally(() => {
        if (this.generalChannelEnsureInFlight === operation) this.generalChannelEnsureInFlight = null;
      });
    this.generalChannelEnsureInFlight = operation;
    return operation;
  }

  private async ensureGeneralChannelEventStateOnce(): Promise<AgentEventReplayState> {
    return this.ensureProtectedDefaultChannelEventStateOnce(requiredProtectedDefaultChannelConfig(DEFAULT_GENERAL_CHANNEL_ID));
  }

  private async ensureDreamChannelEventState(): Promise<AgentEventReplayState> {
    if (this.dreamChannelEnsureInFlight) return this.dreamChannelEnsureInFlight;
    const operation = this.ensureDreamChannelEventStateOnce()
      .finally(() => {
        if (this.dreamChannelEnsureInFlight === operation) this.dreamChannelEnsureInFlight = null;
      });
    this.dreamChannelEnsureInFlight = operation;
    return operation;
  }

  private async ensureDreamChannelEventStateOnce(): Promise<AgentEventReplayState> {
    return this.ensureProtectedDefaultChannelEventStateOnce(requiredProtectedDefaultChannelConfig(DEFAULT_DREAM_CHANNEL_ID));
  }

  private defaultChannelMembers(): AgentPrincipal[] {
    // Single-agent collapse: every conversation — General included — has exactly
    // one agent member (Neva). Agent definitions are delegation child-agent types,
    // not conversation members, so the roster never joins a conversation.
    return this.defaultConversationMembers();
  }

  private async ensureProtectedDefaultChannelEventStateOnce(
    config: ProtectedDefaultChannelConfig,
  ): Promise<AgentEventReplayState> {
    const desiredMembers = this.defaultChannelMembers();
    const liveConversation = this.conversations.get(config.id);
    const eventState = liveConversation?.eventState ?? await this.loadEventState(config.id);
    const inputs = this.protectedDefaultChannelInvariantInputs(config, eventState, desiredMembers, {
      removeUnavailablePeers: !liveConversation || !this.hasActiveRuns(liveConversation),
    });
    if (inputs.length === 0) return eventState;

    if (liveConversation) {
      await this.appendConversationEvents(config.id, liveConversation, inputs);
      await this.refreshMemberDisplayNames(liveConversation);
      this.emitProjection(config.id, config.projectionEvent);
      return liveConversation.eventState;
    }

    const events = this.buildEvents(eventState, config.id, inputs);
    await this.getEventStore().appendEvents(config.id, events);
    for (const event of events) appendAgentEventToReplayState(eventState, event);
    this.publishPersistedEvents(config.id, events);
    return eventState;
  }

  private protectedDefaultChannelInvariantInputs(
    config: ProtectedDefaultChannelConfig,
    eventState: AgentEventReplayState,
    desiredMembers: readonly AgentPrincipal[],
    options: { removeUnavailablePeers: boolean },
  ): AgentEventInput[] {
    if (!eventState.conversation) {
      const inputs: AgentEventInput[] = [{
        type: 'conversation.created',
        actor: systemActor(),
        title: config.title,
        members: desiredMembers.slice(),
        goal: config.title,
      }];
      if (config.forcedSettings) {
        inputs.push({
          type: 'conversation.settings_changed',
          actor: systemActor(),
          settings: config.forcedSettings,
        });
      }
      return inputs;
    }

    const inputs: AgentEventInput[] = [];
    if (
      sanitizeConversationTitle(eventState.conversation.title) !== config.title
      || sanitizeConversationTitle(eventState.conversation.goal) !== config.title
    ) {
      inputs.push({
        type: 'conversation.renamed',
        actor: systemActor(),
        title: config.title,
        goal: config.title,
      });
    }

    if (config.forcedSettings) {
      const settings: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(config.forcedSettings)) {
        if (eventState.conversation.settings[key] !== value) settings[key] = value;
      }
      if (Object.keys(settings).length > 0) {
        inputs.push({
          type: 'conversation.settings_changed',
          actor: systemActor(),
          settings,
        });
      }
    }

    let workingMembers = eventState.conversation.members.slice();
    for (const member of desiredMembers) {
      if (workingMembers.some((candidate) => samePrincipal(candidate, member))) continue;
      inputs.push({
        type: 'member.added',
        actor: systemActor(),
        member,
      });
      workingMembers = [...workingMembers, member];
    }

    if (options.removeUnavailablePeers) {
      const desiredAgentIds = new Set(channelAgentMembers(desiredMembers).map((member) => member.agentId));
      for (const member of channelAgentMembers(workingMembers)) {
        if (member.agentId === this.coordinatorAgentId()) continue;
        if (desiredAgentIds.has(member.agentId)) continue;
        inputs.push({
          type: 'member.removed',
          actor: systemActor(),
          member,
        });
        workingMembers = workingMembers.filter((candidate) => !samePrincipal(candidate, member));
      }
    }

    return inputs;
  }

  async createConversation(options: {
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
    // Single-agent collapse: a conversation always has exactly {user, Neva}.
    const members = this.defaultConversationMembers();
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

  /** Resolve agent ids to member principals, validating each against the registry. */
  private async resolveAgentMemberPrincipals(agentIds: readonly string[]): Promise<AgentMemberPrincipal[]> {
    const lookupAgentIds = uniqueStrings(agentIds.filter((agentId) => agentId !== this.agentIdentity.agentId));
    const definitions = lookupAgentIds.length > 0 ? await this.listRawAgentDefinitions('member-resolve') : [];
    const availableAgentIds = new Set(definitions.map((definition) => agentDefinitionAgentId(definition)));
    return agentIds.map((agentId) => {
      if (agentId === this.agentIdentity.agentId || availableAgentIds.has(agentId)) {
        return { type: 'agent', agentId };
      }
      throw new Error(`Agent not found for Channel membership: ${agentId}`);
    });
  }

  private async requireAgentMemberPrincipal(agentId: string): Promise<AgentMemberPrincipal> {
    return (await this.resolveAgentMemberPrincipals([agentId]))[0]!;
  }

  private async displayNameForAgentId(agentId: string): Promise<string> {
    if (agentId === this.agentIdentity.agentId) return this.agentIdentity.displayName;
    const definitions = await this.listRawAgentDefinitions('agent-display-name');
    const match = definitions.find((definition) => agentDefinitionAgentId(definition) === agentId);
    return match ? agentDefinitionDisplayName(match) : `@${agentMentionToken(agentId)}`;
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
    entry: AgentConversationIndexEntry,
  ): AgentConversationListMeta {
    return {
      id: entry.id,
      title: sanitizeConversationTitle(entry.title),
      members: entry.members.slice(),
      goal: entry.goal,
      settings: { ...entry.settings },
      createdAt: entry.createdAt ?? 0,
      updatedAt: entry.updatedAt ?? 0,
      messageCount: entry.messageCount ?? 0,
      lastMessageSnippet: entry.lastMessageSnippet ?? null,
      lastMessageAt: entry.lastMessageAt ?? null,
      unreadCount: entry.unreadCount ?? 0,
    };
  }

  async listConversations() {
    await this.ensureDefaultChannelEventStates();
    const entries = await this.getEventStore().listConversationIndexEntries();
    // Single-agent collapse: channels are the only conversation primitive. Every
    // listed row is a goal-bearing channel (General sorts first); there are no
    // per-agent DM rows.
    const listed = entries
      .filter((entry) => !!entry.goal && !isInternalAgentConversationId(entry.id))
      .map((entry) => this.conversationListMetaFromIndexEntry(entry))
      .sort((left, right) => (
        defaultChannelSortRank(left.id) - defaultChannelSortRank(right.id)
        || (right.updatedAt - left.updatedAt)
        || left.id.localeCompare(right.id)
      ));
    // Seed cross-conversation unread badges on launch: the live conversation_attention
    // event only fires for conversations touched this run, so a conversation that went
    // unread before the app closed would show no badge until it is reopened. Re-emit
    // the persisted unread for every listed channel.
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
   * The single believer pool the Settings Memory pane manages: Neva's own knowledge. Memory
   * collapsed to one believer-keyed first-person pool — the view still carries `principal` (a
   * constant = the believer) but there are no longer separate pools to group or label.
   */
  private managedMemoryPrincipals(): AgentPrincipal[] {
    return [this.agentPrincipal()];
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
    // One believer pool, newest-first and bounded.
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
    this.clearPendingApprovalAutoBlock(pending);

    let resolvedApproved = approved;
    let deniedReason: PermissionDeniedReason | undefined = approved ? undefined : 'user_denied';
    let resolvedScope = scope;
    let alwaysAllowRule = approved && scope === 'always' ? pending.alwaysAllowRule : undefined;
    let alwaysAllowAction = approved && scope === 'always' ? pending.alwaysAllowAction ?? 'grant' : undefined;
    if (approved && scope === 'always' && !alwaysAllowRule) {
      resolvedScope = 'once';
      alwaysAllowAction = undefined;
    }
    if (alwaysAllowRule) {
      try {
        if (alwaysAllowAction === 'remove_block') {
          await removeAgentToolPermissionBlock(alwaysAllowRule);
        } else if (alwaysAllowAction === 'soft_allow') {
          await appendAgentToolPermissionSoftBlockAllow(alwaysAllowRule);
        } else {
          await appendAgentToolPermissionGrant(alwaysAllowRule);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.emitError(conversationId, `Failed to persist permission rule; approved once instead. ${message}`);
        resolvedScope = 'once';
        alwaysAllowRule = undefined;
        alwaysAllowAction = undefined;
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
        alwaysAllowAction = undefined;
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
   * real usage / round count), plus the conversation shape (DM or Channel) and
   * rolled-up totals. Reads the store directly, so it works
   * on any stored conversation without loading it into memory.
   */
  async agentDebugView(conversationId: string): Promise<AgentDebugConversation> {
    const store = this.getEventStore();
    const [metas, conversationMeta] = await Promise.all([
      store.listConversationRunMetaProjections(conversationId),
      store.readConversationMetaProjection(conversationId),
    ]);
    const context = await this.loadDebugConversationContext(conversationId, conversationMeta?.latestSeq ?? -1);
    const summaries: AgentDebugRunSummary[] = [];
    for (const meta of metas) {
      // Reflective / principal-anchored runs span conversations — not this view.
      if (meta.kind === 'reflective' || meta.anchor.type !== 'conversation') continue;
      summaries.push(await this.summarizeDebugRunFromStore(meta, context.parentToolCallByChild.get(meta.id) ?? null));
    }
    // Shape + member roster come from the conversation's authoritative members
    // (NOT distinct run executors — a DM that delegates would otherwise look like
    // a Channel, with the transient sub-agent shown as a member). The agents that
    // actually executed runs are filterable in the renderer, derived from the runs.
    const roster = conversationMeta?.members ?? [];
    const memberIds = roster.length > 0
      ? channelAgentMembers(roster).map((member) => member.agentId)
      : [...new Set(summaries.map((summary) => summary.agentId))];
    return deriveDebugConversation(conversationId, 'dm', memberIds, summaries);
  }

  /** Run-grounded debug: one run's full execution detail (rounds + per-run snapshot). */
  async agentDebugRun(conversationId: string, runId: string): Promise<AgentDebugRun | null> {
    const store = this.getEventStore();
    const meta = await store.readRunMetaProjection(runId);
    if (!meta) return null;
    if (meta.anchor.type !== 'conversation' || meta.anchor.conversationId !== conversationId) return null;
    const conversationMeta = await store.readConversationMetaProjection(conversationId);
    const context = await this.loadDebugConversationContext(conversationId, conversationMeta?.latestSeq ?? -1);
    return this.deriveDebugRunFromStore(meta, context);
  }

  /**
   * The conversation-stream events a run's OWN ledger lacks but its rounds need:
   * the triggering user message (appended with no runId before the run starts),
   * `child_run.started` parent links, and conversation-budget `tool_result.replaced`
   * slimming (also runId-less). Read once from the conversation segment and cached
   * by the conversation's latestSeq, so the whole tree shares one read instead of
   * the old per-run full `readEvents` ([[agent-debug-run-grounded]]).
   */
  private async loadDebugConversationContext(conversationId: string, latestSeq: number): Promise<DebugConversationContext> {
    const cached = this.debugConversationContextCache.get(conversationId);
    if (cached && cached.latestSeq === latestSeq) return cached;
    const parentToolCallByChild = new Map<string, string>();
    const triggerMessages = new Map<string, Extract<AgentEvent, { type: 'user_message.created' }>>();
    const replacedByToolCall = new Map<string, Extract<AgentEvent, { type: 'tool_result.replaced' }>[]>();
    for (const event of await this.getEventStore().readConversationStreamEvents(conversationId)) {
      if (event.type === 'child_run.started' && typeof event.parentToolCallId === 'string') {
        parentToolCallByChild.set(event.childRunId, event.parentToolCallId);
      } else if (event.type === 'user_message.created') {
        triggerMessages.set(event.messageId, event);
      } else if (event.type === 'tool_result.replaced') {
        const list = replacedByToolCall.get(event.toolCallId) ?? [];
        list.push(event);
        replacedByToolCall.set(event.toolCallId, list);
      }
    }
    const context: DebugConversationContext = { latestSeq, parentToolCallByChild, triggerMessages, replacedByToolCall };
    // Bounded like the run caches: each entry pins a conversation's full trigger /
    // slimming maps, so an unbounded map would retain every conversation ever
    // opened in the debug panel for the session. A re-read on eviction is cheap.
    this.evictForCapacity(this.debugConversationContextCache, conversationId);
    this.debugConversationContextCache.set(conversationId, context);
    return context;
  }

  /** Light summary node: a single pass over the run stream, no full detail built. */
  private async summarizeDebugRunFromStore(meta: AgentRunMetaProjection, parentToolCallId: string | null): Promise<AgentDebugRunSummary> {
    const cached = this.debugRunSummaryCache.get(meta.id);
    if (cached && cached.latestSeq === meta.latestSeq && cached.parentToolCallId === parentToolCallId) return cached.summary;
    const events = await this.getEventStore().readRunStreamEvents(meta.id);
    const summary = summarizeRunStream(events, meta, parentToolCallId);
    this.evictForCapacity(this.debugRunSummaryCache, meta.id);
    this.debugRunSummaryCache.set(meta.id, { latestSeq: meta.latestSeq, parentToolCallId, summary });
    return summary;
  }

  private async deriveDebugRunFromStore(meta: AgentRunMetaProjection, context: DebugConversationContext): Promise<AgentDebugRun> {
    const parentToolCallId = context.parentToolCallByChild.get(meta.id) ?? null;
    const cached = this.debugRunCache.get(meta.id);
    if (cached && cached.latestSeq === meta.latestSeq && cached.contextSeq === context.latestSeq && cached.parentToolCallId === parentToolCallId) {
      return cached.run;
    }
    const runEvents = await this.getEventStore().readRunStreamEvents(meta.id);
    // Splice in the conversation-stream events this run needs: its triggering user
    // message (folded into round 0's window) and any slimming of its tool results
    // (matched by toolCallId, regardless of which run did the slimming).
    const events = this.assembleDebugRunEvents(meta, runEvents, context);
    const run = deriveDebugRun(events, { meta, snapshot: snapshotFromRunEvents(runEvents), parentToolCallId });
    this.evictForCapacity(this.debugRunCache, meta.id);
    this.debugRunCache.set(meta.id, { latestSeq: meta.latestSeq, contextSeq: context.latestSeq, parentToolCallId, run });
    return run;
  }

  private assembleDebugRunEvents(
    meta: AgentRunMetaProjection,
    runEvents: readonly AgentEvent[],
    context: DebugConversationContext,
  ): AgentEvent[] {
    const prefix: AgentEvent[] = [];
    // The triggering user message lives in the conversation stream; prepend it
    // before run.started so it folds into the first round's request window. (Child
    // runs already carry their directive in the fork prefix, so skip if present.)
    const triggerMessageId = meta.trigger.type === 'message' ? meta.trigger.messageId : null;
    const hasTriggerInStream = triggerMessageId !== null
      && runEvents.some((event) => event.type === 'user_message.created' && event.messageId === triggerMessageId);
    if (triggerMessageId && !hasTriggerInStream) {
      const triggerEvent = context.triggerMessages.get(triggerMessageId);
      if (triggerEvent) prefix.push(triggerEvent);
    }
    // Append conversation-stream slimming for this run's tool calls. Matched by the
    // globally-unique toolCallId, so a replacement for another run's call is never
    // pulled in; recordToolResult drops any that still don't match.
    const ownToolCallIds = new Set<string>();
    for (const event of runEvents) {
      if (event.type === 'tool_result.created') ownToolCallIds.add(event.toolCallId);
    }
    const suffix: AgentEvent[] = [];
    for (const toolCallId of ownToolCallIds) {
      const replaced = context.replacedByToolCall.get(toolCallId);
      if (replaced) suffix.push(...replaced);
    }
    return prefix.length === 0 && suffix.length === 0 ? [...runEvents] : [...prefix, ...runEvents, ...suffix];
  }

  /** Bounded-LRU eviction shared by the debug caches (evict oldest when full). */
  private evictForCapacity<V>(cache: Map<string, V>, key: string) {
    if (cache.size >= DEBUG_RUN_CACHE_LIMIT && !cache.has(key)) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  /** Bounded-LRU record of the last-emitted debug-snapshot hash (see capture). */
  private rememberDebugRunSnapshotHash(runId: string, combined: string) {
    this.evictForCapacity(this.debugRunSnapshotHashByRun, runId);
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

  /** Resolve the conversation that owns a (global) run id, or null if unknown — one
   *  small run-meta read. The O(1) lookup behind chat-source `run` reveals, so the
   *  renderer never has to probe every conversation's ledger to find the owner. */
  async runConversationId(runId: string): Promise<string | null> {
    const meta = await this.getEventStore().readRunMetaProjection(runId);
    return meta ? conversationIdOfRun(meta) : null;
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
    // `withBuiltInAgentDefinitions` already layers the built-in's editable overlay
    // (display name, persona, model/effort, tools, …) onto the injected definition,
    // so the editor renders the user's saved values. The built-in Neva is the only
    // editable agent — her edits persist to the settings overlay, not a file — and
    // under the one-Neva invariant no other definition can exist, so `writable` is
    // exactly "is the built-in".
    return (await this.withBuiltInAgentDefinitions(definitions)).map((definition) => ({
      ...definition,
      agentId: agentDefinitionAgentId(definition),
      writable: definition.source === 'built-in',
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

  private async withBuiltInAgentDefinitions(definitions: readonly AgentDefinition[]): Promise<AgentDefinition[]> {
    const builtIn = await this.materializeBuiltInAgentDefinition();
    const builtInId = agentDefinitionAgentId(builtIn);
    return [
      builtIn,
      ...definitions.filter((definition) => agentDefinitionAgentId(definition) !== builtInId),
    ];
  }

  /**
   * The built-in assistant (Neva) definition with the user's editable overlay applied
   * — the single seam every list/execute path goes through, so an edit to the persona,
   * display name, tools, etc. takes effect everywhere. The stable `name` (memory
   * anchor) is never overlaid; only what the user can see and change.
   */
  private async materializeBuiltInAgentDefinition(): Promise<AgentDefinition> {
    const base = createTenonAssistantAgentDefinition();
    const overlay = await getBuiltInAgentProfile(agentDefinitionAgentId(base));
    return applyBuiltInAgentProfile(base, overlay);
  }

  /**
   * Rebuild the primary agent's identity (display name + composed system prompt +
   * skills) from the editable built-in overlay. Called at startup to pick up a
   * persisted overlay, and after each built-in edit. The system prompt is composed
   * in `main` mode — the same recipe as the code default — so customizing the persona
   * never silently drops the main-agent capabilities (timeline memory/past_chats).
   */
  private async refreshPrimaryAgentIdentity(): Promise<void> {
    const definition = await this.materializeBuiltInAgentDefinition();
    this.agentIdentity = {
      ...this.agentIdentity,
      displayName: agentDefinitionDisplayName(definition),
      systemPrompt: composeAgentPrompt(definition, { mode: 'main' }),
      skills: definition.skills ?? [],
    };
  }

  // Authoring (user-driven only — see [[agent-authoring]]). Each write goes
  // through main's containment-checked file surface, then every live conversation's
  // registry cache is invalidated so the change is visible (child run picker +
  // settings list) without an app restart. The fresh view list is returned so
  // the renderer can re-select by agentId.
  async updateAgentDefinition(
    conversationId: string,
    agentId: string,
    input: AgentAuthoringInput,
  ): Promise<AgentDefinitionView[]> {
    const existing = await this.resolveAgentDefinitionById(conversationId, agentId);
    // The built-in assistant (Neva) is directly editable, but it is code, not a
    // file — so its edits persist to the settings overlay. The editor's name field
    // edits the display name (the stable `name`/memory anchor never changes), then
    // we rebuild the primary identity + refresh live conversations so a rename shows
    // immediately, not only on the next conversation setup.
    if (existing.source === 'built-in') {
      // Persist ONLY the free-text fields the user actually changed from the code
      // defaults. The editor round-trips the current persona/description/display
      // name through the form, so storing them unconditionally would freeze them at
      // edit time — a later change to the code persona (NEVA_AGENT_PERSONA) would
      // then be ignored. Diffing against the code base leaves unchanged fields on
      // the code default (null → not stored). The remaining fields already
      // default-guard inside setBuiltInAgentProfile (model 'inherit', tools '*', …).
      const base = createTenonAssistantAgentDefinition();
      await setBuiltInAgentProfile(agentId, {
        displayName: input.name !== (base.displayName ?? base.name) ? input.name : null,
        description: input.description !== base.description ? input.description : null,
        body: input.body !== base.body ? input.body : null,
        model: input.model ?? null,
        effort: typeof input.effort === 'string' ? input.effort : null,
        permissionMode: input.permissionMode ?? null,
        maxTurns: input.maxTurns ?? null,
        tools: input.tools ?? null,
        disallowedTools: input.disallowedTools ?? null,
        skills: input.skills ?? null,
        background: input.background ?? null,
      });
      await this.refreshPrimaryAgentIdentity();
      const views = await this.reloadAgentDefinitions(conversationId);
      // Re-resolve the model/effort and hot-swap it into live conversations ONLY when
      // this edit actually changed model or effort — so a model/effort edit (Settings or
      // the composer chip) applies on the NEXT turn without reopening, while a
      // persona/display-name-only edit never re-resolves. The built-in defaults to
      // model:'inherit'; re-resolving unconditionally would silently switch a live
      // conversation's model if the active provider had changed since setup, a model
      // change the user never made. The agent loop re-reads state.model/thinkingLevel at
      // each agent_start. Best-effort: if no provider resolves, keep the live model.
      const modelEffortChanged = builtInModelEffortChanged(existing, input);
      const providerConfig = modelEffortChanged ? await this.getActiveProviderConfig().catch(() => null) : null;
      const resolvedModelEffort = providerConfig
        ? await this.resolveBuiltInAssistantModelEffort(providerConfig).catch(() => null)
        : null;
      // Re-resolve the built-in tool allow/deny filter from the freshly-saved overlay so a
      // tools edit takes effect on the NEXT turn, not only when the conversation reopens.
      // The live tool set is a setup-time snapshot (conversation.agentToolFilter); without
      // recomputing it here a just-removed tool stays callable for the rest of the session.
      const builtInToolOverlay = await this.materializeBuiltInAgentDefinition().catch(() => null);
      const builtInToolFilter = resolveAgentToolFilter({
        isBuiltIn: true,
        tools: builtInToolOverlay?.tools,
        disallowedTools: builtInToolOverlay?.disallowedTools,
      });
      for (const [id, conversation] of this.conversations) {
        await this.refreshMemberDisplayNames(conversation);
        // Reconfigure the live pi-agent so a persona / display-name / model / effort /
        // tools edit takes effect on the NEXT turn, not only when the conversation reopens.
        if (conversation.defaultAgentId === this.agentIdentity.agentId) {
          conversation.agent.state.systemPrompt = this.agentIdentity.systemPrompt;
          if (resolvedModelEffort) {
            conversation.agent.state.model = resolvedModelEffort.model;
            conversation.agent.state.thinkingLevel = resolvedModelEffort.thinkingLevel;
          }
          conversation.agentToolFilter = builtInToolFilter;
          this.applyRuntimeToolSettings(conversation);
        }
        this.emitProjection(id, 'agent_definitions_reloaded');
      }
      return views;
    }
    // Only the built-in assistant (Neva) is editable, and she is the only agent
    // definition that can exist (the one-Neva invariant — no create / load of a
    // second agent). A non-built-in source here is unreachable; treat it as a bug
    // rather than silently writing an agent file.
    throw new Error(`Agent "${agentId}" is not editable.`);
  }

  // Invalidate every live conversation's registry cache, then return the fresh list.
  // Also exposed as an explicit "reload agents" action.
  async reloadAgentDefinitions(conversationId: string): Promise<AgentDefinitionView[]> {
    for (const conversation of this.conversations.values()) {
      conversation.delegationRuntime.reloadAgentDefinitions();
    }
    await this.ensureDefaultChannelEventStates();
    return this.listAllAgentDefinitions(conversationId);
  }

  private async resolveAgentDefinitionById(conversationId: string, agentId: string): Promise<AgentDefinition> {
    const definitions = await this.listRawAgentDefinitions(conversationId);
    const match = (await this.withBuiltInAgentDefinitions(definitions))
      .find((definition) => agentDefinitionAgentId(definition) === agentId);
    if (!match) throw new Error('Agent definition not found.');
    return match;
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
    const protectedDefault = protectedDefaultChannelConfig(conversationId);
    if (protectedDefault) throw new Error(`#${protectedDefault.title} cannot be renamed.`);
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

  async setConversationIncludeInDreamData(conversationId: string, includeInDreamData: boolean) {
    if (conversationId === DEFAULT_DREAM_CHANNEL_ID && includeInDreamData) {
      throw new Error('#Dream cannot be included in Dream data.');
    }
    const conversation = await this.ensureConversationWithId(conversationId);
    const current = channelIncludesInDreamData(conversationId, conversation.eventState.conversation?.settings);
    if (current === includeInDreamData) return eventStateToMeta(conversation.eventState);
    await this.appendConversationEvents(conversationId, conversation, [{
      type: 'conversation.settings_changed',
      actor: userActor(),
      settings: { [CHANNEL_INCLUDE_IN_DREAM_DATA_SETTING]: includeInDreamData },
    }]);
    this.emitProjection(conversationId, 'conversation_settings_changed');
    return eventStateToMeta(conversation.eventState);
  }

  async deleteConversation(conversationId: string) {
    const protectedDefault = protectedDefaultChannelConfig(conversationId);
    if (protectedDefault) throw new Error(`#${protectedDefault.title} cannot be deleted.`);
    const conversation = this.conversations.get(conversationId);
    if (conversation) {
      await this.clearPendingUserQuestionsForConversation(conversationId, 'conversation_deleted');
      for (const run of this.activeRunList(conversation)) run.agent.abort();
      conversation.agent.abort();
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
      if (conversationId === DEFAULT_DREAM_CHANNEL_ID) {
        throw new Error('#Dream does not accept regular chat messages.');
      }
      const materialized = await this.materializeFileAttachments(normalizeAttachmentInputs(attachmentInput));
      const attachments = materialized.attachments;
      const messageText = rewriteFileReferenceMarkerPaths(message, materialized.pathMap);
      if (!messageText.trim() && attachments.length === 0) return;
      if (this.hasActiveRuns(conversation)) {
        if (attachments.length > 0) {
          throw new Error('Attachments cannot be queued while the agent is running.');
        }
        await this.steerConversation(conversationId, messageText);
        return;
      }
      const runtimeSettings = await this.refreshRuntimeSettings(conversation);
      const compactCommand = attachments.length === 0 && runtimeSettings.compactEnabled
        ? parseCompactSlashCommand(messageText)
        : null;
      if (compactCommand) {
        await this.compactConversation(conversationId, conversation, compactCommand.instructions);
        return;
      }
      conversation.skillRuntime.resetRunPermissionRules();
      const normalizedUserViewContext = normalizeAgentUserViewContext(userViewContextInput);
      const userViewContextReminder = this.userViewContextReminderTracker.prepare(
        conversationId,
        normalizedUserViewContext,
      );
      const userViewReminderText = userViewContextReminder.reminder;
      const now = new Date();
      const outlinerContext = buildOutlinerContextReminder(this.outlinerToolHost);
      const turnContextReminder = joinReminderParts([
        buildEnvironmentContextReminder(now),
        outlinerContext,
        userViewReminderText,
      ]);
      const userSkillPrompt = attachments.length === 0 && runtimeSettings.slashSkillsEnabled
        ? await createUserSkillPrompt(conversation.skillRuntime, messageText, turnContextReminder)
        : null;
      const skillListingReminder = userSkillPrompt
        ? null
        : await this.buildSkillListingReminder(conversation);
      const agentListingReminder = userSkillPrompt
        ? null
        : await this.buildAgentListingReminder(conversation);
      let prompt: UserMessage;
      if (userSkillPrompt) {
        // A directly invoked skill turn replaces the user prompt wholesale, so referenced
        // assets are not materialized for it (nothing would surface them).
        prompt = userSkillPrompt;
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
          outlinerContext,
          userViewContextReminder: userViewReminderText,
          referencedFilesReminder: buildReferencedFilesReminder(referencedAssets.files),
          skillListingReminder,
          agentListingReminder,
        }, now);
      }
      await this.appendUserPromptEvent(conversationId, conversation, prompt);
      userViewContextReminder.commit();
      startedRunId = await this.startRun(conversationId, conversation, prompt);
      await conversation.agent.prompt(prompt);
      await this.contextManager.runReactiveCompactRetryIfNeeded(conversationId, conversation);
      await this.persistAndEmitIdle(conversationId, conversation);
    } catch (error) {
      // Scoped to the run THIS call started: a startRun rejected by the
      // already-active guard must never clear the healthy run that owns the slot.
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
      const messageId = this.createMessageId('user');
      await this.appendConversationEvents(conversationId, conversation, [{
        type: 'user_message.created',
        actor: userActor(),
        messageId,
        parentMessageId: target.parentMessageId,
        replacesMessageId: target.id,
        content: textPersistedContent(trimmed),
      }]);
      conversation.agent.state.messages = await this.deriveRuntimePiMessages(conversationId, conversation.eventState) as never;
      this.emitProjection(conversationId, 'message_edited');
      conversation.skillRuntime.resetRunPermissionRules();
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
      await this.rerunSettledTurn(conversationId, conversation);
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
      await this.rerunSettledTurn(conversationId, conversation);
    } catch (error) {
      // Run recovery happens inside rerunSettledTurn (it knows the run it
      // started); this catch only surfaces the error.
      this.emitError(conversationId, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Re-run a settled assistant turn (regenerate/retry): the caller has already
   * reselected the branch to the parent, so the agent re-runs from there. Emits
   * idle once the run settles.
   */
  private async rerunSettledTurn(
    conversationId: string,
    conversation: AgentConversationState,
  ) {
    let startedRunId: string | null = null;
    try {
      startedRunId = await this.startRun(conversationId, conversation);
      await continueFromActivePath(conversation.agent);
      await this.contextManager.runReactiveCompactRetryIfNeeded(conversationId, conversation);
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
    this.releaseQueuedFollowUpSkillListing(conversation);
    conversation.agent.clearFollowUpQueue();
    this.userViewContextReminderTracker.reset(conversationId);
    await this.refreshRuntimeSettings(conversation);
    const skillListingReservation = await this.reserveSkillListingReminder(conversation);
    conversation.queuedFollowUpSkillListingReservation = skillListingReservation;
    const userViewContextReminder = buildUserViewContextReminder(normalizeAgentUserViewContext(userViewContextInput));
    conversation.agent.followUp(buildUserPromptMessage(text, [], {
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
      const events = this.buildEvents(eventState, conversationId, [{
        type: 'conversation.created',
        actor: systemActor(),
        title: previousConversation?.title ?? 'Untitled',
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
      this.clearPendingApprovalAutoBlock(pending);
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
    this.clearPendingApprovalAutoBlock(pending);
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

  private clearPendingApprovalAutoBlock(pending: AgentPendingApproval) {
    if (!pending.autoBlockTimer) return;
    clearTimeout(pending.autoBlockTimer);
    pending.autoBlockTimer = undefined;
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
    let delegationRuntime: AgentDelegationRuntime;
    const localWorkspace = createAgentLocalWorkspaceContext(this.options.localFileRoot, this.scratchRoot(), skillRuntime);
    delegationRuntime = new AgentDelegationRuntime({
      conversationId,
      executingAgentId: defaultAgentId,
      memoryOwnerAgentId: defaultAgentId,
      localRoot: this.options.localFileRoot,
      scratchRoot: this.scratchRoot(),
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
    // The built-in assistant (Neva) is user-customizable: its display name + persona
    // ride `this.agentIdentity` (refreshed from the editable overlay), its model/effort
    // resolve through the same overlay over the provider connection, and its tool
    // allow/deny list comes from the overlaid definition below.
    const builtInModelEffort = providerConfig && defaultAgentId === this.agentIdentity.agentId
      // null when the connection has no resolvable model yet (a fresh custom endpoint
      // with no assistant default chosen) — surfaced below as a configuration error.
      ? await this.resolveBuiltInAssistantModelEffort(providerConfig).catch(() => null)
      : null;
    const builtInToolOverlay = defaultAgentId === this.agentIdentity.agentId
      ? await this.materializeBuiltInAgentDefinition().catch(() => null)
      : null;
    const agentToolFilter = resolveAgentToolFilter({
      isBuiltIn: defaultAgentId === this.agentIdentity.agentId,
      tools: defaultAgentProfile?.definition.tools ?? builtInToolOverlay?.tools,
      disallowedTools: defaultAgentProfile?.definition.disallowedTools ?? builtInToolOverlay?.disallowedTools,
    });
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
          chatSourceValidator: this.createChatSourceValidator(),
          pastChats: this.createPastChatsToolRuntime(() => conversationId),
          askUserQuestion: this.createAskUserQuestionRuntime(() => conversationId, () => conversationRef.current),
          selfMaintenance: defaultAgentId === this.agentIdentity.agentId
            ? this.createSelfMaintenanceRuntime(() => conversationId, () => conversationRef.current)
            : undefined,
          allowedTools: agentToolFilter.allowedTools,
          disallowedTools: agentToolFilter.disallowedTools,
          streamFn: this.options.streamFn,
          completeSimpleFn: this.options.completeSimpleFn,
          providerApiKeyLoader: this.options.providerApiKeyLoader,
          permissionEventHandler: (input) => {
            const current = conversationRef.current;
            return current ? this.appendToolPermissionEvent(conversationId, current, input) : Promise.resolve();
          },
          approvalHandler: (input, signal) => {
            const current = conversationRef.current;
            if (!current) return Promise.resolve({ approved: false, deniedReason: 'runtime' });
            return this.requestToolApproval(conversationId, current, input, signal);
          },
          afterToolResult: async (toolCallId, toolName, result, isError) => {
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
      agentToolFilter,
      activeRuns: new Map(),
      activeRun: null,
      lastRun: null,
      autoCompactConsecutiveFailures: 0,
      autoCompactInProgress: false,
      eventState,
      activeCompaction: null,
      activeDream: null,
      pendingChildRunNotifications: [],
      pendingEventAppend: Promise.resolve(),
      pendingProjectionLastEventType: null,
      pendingProjectionTimer: null,
      lastRenderProjection: null,
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
    this.emitProjection(conversationId, 'conversation_created');
    return conversation;
  }

  private async ensureConversationWithId(conversationId: string, titleOverride?: string) {
    const existing = this.conversations.get(conversationId);
    if (existing) return existing;
    let eventState = await this.loadEventState(conversationId);
    if (!eventState.conversation) {
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
    conversation.agent.state.tools = createAgentTools(this.outlinerToolHost, {
      localFileRoot: this.options.localFileRoot,
      localWorkspace: conversation.localWorkspace,
      skillRuntime: conversation.skillRuntime,
      skillToolEnabled: conversation.runtimeSettings.automaticSkillsEnabled,
      delegationRuntime: conversation.delegationRuntime,
      chatSourceValidator: this.createChatSourceValidator(),
      pastChats: this.createPastChatsToolRuntime(() => conversation.eventState.conversation?.id ?? 'unknown'),
      askUserQuestion: this.createAskUserQuestionRuntime(() => conversation.eventState.conversation?.id ?? 'unknown', () => conversation),
      selfMaintenance: this.createSelfMaintenanceRuntime(() => conversation.eventState.conversation?.id ?? 'unknown', () => conversation),
      allowedTools: conversation.agentToolFilter.allowedTools,
      disallowedTools: conversation.agentToolFilter.disallowedTools,
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
      chatSourceValidator: this.createChatSourceValidator(),
      pastChats: this.createPastChatsToolRuntime(() => input.conversationId),
      streamFn: this.options.streamFn,
      completeSimpleFn: this.options.completeSimpleFn,
      providerApiKeyLoader: this.options.providerApiKeyLoader,
      permissionEventHandler: (eventInput) => {
        const parentConversation = this.currentRuntimeConversation(parentConversationRef.current);
        return parentConversation ? this.appendToolPermissionEvent(parentConversationId, parentConversation, eventInput) : Promise.resolve();
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
    // A notification-delivery run is the agent's own turn (its child runs);
    // never interleave it into an active run.
    if (this.hasActiveRuns(conversation)) return;

    conversation.childRunNotificationFlushInProgress = true;
    let startedRunId: string | null = null;
    try {
      while (conversation.pendingChildRunNotifications.length > 0) {
        if (this.hasActiveRuns(conversation)) break;
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
    // In-memory dedupe key (re-emit only on a real change) — derived from the
    // content itself; the hash is never persisted on the event (no reader needs it).
    const combined = createHash('sha256').update(systemPrompt).update('\0').update(JSON.stringify(tools)).digest('hex');
    if (this.debugRunSnapshotHashByRun.get(runId) === combined) return;
    await this.appendConversationEvents(conversationId, conversation, [{
      type: 'debug.run_snapshot.created',
      actor: systemActor(),
      runId,
      systemPrompt,
      tools,
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
      await this.runCommandChildAgent(conversationId, brief, node.sysLastRunAt ?? null);
      return { conversationId: conversationId };
    } finally {
      this.firingCommandNodeIds.delete(nodeId);
    }
  }

  // Shared no-human-turn execution for command runs (scheduled + Run-now). The
  // brief — the command title plus its non-field child outline (see
  // `commandBriefText`) — is run as a DELEGATED child run anchored to the command's own
  // delivery conversation, so every fire shows up as a task in that conversation's
  // task panel. Under the one-Neva invariant a fire always forks the otherwise-empty
  // delivery conversation, so the run executes under Neva's identity and capabilities.
  // Resolves only when the child run reaches a terminal state; throws on failure/stop
  // so the caller leaves the watermark unadvanced and arms the failure backoff.
  private async runCommandChildAgent(
    conversationId: string,
    brief: string,
    lastSuccessAt: number | null,
  ): Promise<void> {
    const conversation = await this.ensureConversationWithId(conversationId, commandConversationTitle(brief));
    await this.refreshRuntimeSettings(conversation);
    let data = await conversation.delegationRuntime.invokeAgent({
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

  /**
   * One scheduled pass = the believer pool's Dream over the user's member conversations. Memory
   * collapsed to one believer-keyed pool, so the pass runs a single Dream. The per-pool try/catch
   * + backoff bookkeeping stays (over the one principal): `runDreamMemoryExtractionTask` records
   * its own failures, and this guard covers task-creation throws.
   */
  private async fireDream(trigger: AgentDreamTrigger, now: Date): Promise<void> {
    // Gates before any scanning: a disabled/read-only/provider-less pass must not pay the
    // conversation replay sweep just to bail.
    if (!await this.dreamPassGatesOpen()) return;
    const principals = this.listDreamPrincipals();
    // Drop failure-backoff entries for pools that are no longer dream principals, so the in-memory
    // map stays bounded to live pools. A live pool with an armed window is always in this set (it
    // ran a Dream to arm it), so its backoff is never pruned here.
    const liveKeys = new Set(principals.map(principalKey));
    for (const key of this.dreamFailureBackoff.keys()) {
      if (!liveKeys.has(key)) this.dreamFailureBackoff.delete(key);
    }
    for (const principal of principals) {
      try {
        await this.fireDreamForPool(principal, trigger, now);
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
    return Boolean(await this.getActiveProviderConfig());
  }

  /** The single believer pool with a Dream. */
  private listDreamPrincipals(): AgentPrincipal[] {
    return [this.agentPrincipal()];
  }

  /** Run one pool's Dream, serialized per pool by `principalKey`. */
  private async fireDreamForPool(
    principal: AgentPrincipal,
    trigger: AgentDreamTrigger,
    now: Date,
    options: AgentDreamRunOptions = {},
  ): Promise<AgentDreamRunResult | null> {
    const guardKey = principalKey(principal);
    if (this.dreamingPools.has(guardKey)) {
      return trigger === 'manual'
        ? skippedDreamRunResult(this.agentIdentity.agentId, trigger, now, 'Dream is already running for this pool.')
        : null;
    }
    if (trigger === 'schedule') {
      const backoff = this.dreamFailureBackoff.get(guardKey);
      if (backoff && now.getTime() < backoff.nextAttemptAt) return null;
    }
    this.dreamingPools.add(guardKey);
    try {
      const task = await this.createDreamMemoryExtractionTask(principal, trigger, now, options);
      if (!task) return null;
      const result = await this.runDreamMemoryExtractionTask(task);
      if (trigger === 'schedule') this.recordDreamFailureBackoff(guardKey, result, now);
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
   * Build the believer pool's Dream task. Memory collapsed to one believer-keyed pool, and the
   * retained Dream reads CONVERSATION evidence (the user's member conversations) — communication,
   * both sides. The schedule gate picks fixed-time due occurrences, the Dream channel's clean
   * `dream.finished.window` markers derive the date cursor, and the evidence span is clamped to
   * that date window.
   */
  private async createDreamMemoryExtractionTask(
    principal: AgentPrincipal,
    trigger: AgentDreamTrigger,
    now: Date,
    options: AgentDreamRunOptions = {},
  ): Promise<AgentDreamMemoryExtractionTask | null> {
    if (!this.dreamMemoryExtractionEnabled()) return null;
    if (!await this.getActiveProviderConfig()) return null;

    const [runtimeSettings, derivedDream] = await Promise.all([
      this.getRuntimeSettings(),
      this.deriveDreamChannelState(),
    ]);
    const schedule = runtimeSettings.dreamSchedule || DEFAULT_DREAM_SCHEDULE;
    const scheduleDecision = shouldFireDateSchedule(schedule, now, null);
    if (trigger === 'schedule' && !scheduleDecision.shouldFire) return null;
    if (
      trigger === 'schedule'
      && scheduleDecision.dueAt
      && await this.scheduledDreamAttemptCountForDue(schedule, scheduleDecision.dueAt.getTime()) >= SCHEDULED_DREAM_MAX_ATTEMPTS_PER_DUE
    ) return null;

    const runId = `dream-run-${randomUUID()}`;
    const window = trigger === 'schedule'
      ? await this.scheduledDreamWindow(derivedDream, now)
      : await this.manualDreamWindow(options, derivedDream, now);
    if (!window) return null;
    const { span: evidenceSpan, newCharCount: newVolume } = await this.collectDreamEvidence(window, runId);
    if (trigger === 'schedule' && newVolume < DREAM_MIN_VOLUME_CHARS) return null;

    const span = evidenceSpan ?? (trigger === 'manual'
      ? buildConsolidateOnlyDreamMemoryExtractionSpan(runId)
      : null);
    if (!span) return null;

    return {
      runId,
      principal,
      trigger,
      startedAt: Date.now(),
      dueAt: scheduleDecision.dueAt?.getTime(),
      schedule,
      window,
      guidance: normalizeDreamGuidance(options.guidance),
      span,
      watermark: dreamWatermarkFromSpan({ conversations: {}, runs: {} }, span.sourceRanges),
    };
  }

  private async scheduledDreamAttemptCountForDue(schedule: string, dueAt: number): Promise<number> {
    const runs = await this.getEventStore().listConversationRunMetaProjections(DEFAULT_DREAM_CHANNEL_ID, { limit: 100 });
    return runs.filter((run) =>
      run.kind === 'reflective'
      && run.trigger.type === 'schedule'
      && run.trigger.schedule === schedule
      && run.trigger.dueAt === dueAt).length;
  }

  /** Conversation evidence for the Dream: new events in the user's member conversations. */
  private async collectDreamConversationInputs(window: AgentDreamWindow) {
    const conversationIds = await this.userMemberConversationIds();
    const createdAtRange = dreamCreatedAtRange(window);
    return Promise.all(conversationIds.map(async (conversationId) => {
      const events = await this.getEventStore().readEvents(conversationId);
      return {
        conversationId,
        events,
        fromSeqExclusive: 0,
        createdAtRange,
      };
    }));
  }

  /**
   * The single source of the Dream "new evidence volume" calc: read the member
   * conversations inside the date window once and build their evidence span + char/
   * message totals. Both the scheduled gate (createDreamMemoryExtractionTask) and
   * the manual pre-check (previewDreamReadiness) derive their numbers from here, so
   * the volume bar can never drift between the two paths and neither reads the
   * conversation events twice. The `runId` only stamps the span id; the volume
   * totals are runId-independent.
   */
  private async collectDreamEvidence(
    window: AgentDreamWindow,
    runId: string,
  ): Promise<{ span: DreamMemoryExtractionSpan | null; newCharCount: number; newMessageCount: number }> {
    const conversations = await this.collectDreamConversationInputs(window);
    const span = buildDreamMemoryExtractionSpanFromEvents(runId, conversations);
    return {
      span,
      newCharCount: span?.totalCharCount ?? 0,
      newMessageCount: span?.totalMessageCount ?? 0,
    };
  }

  private async deriveDreamChannelState(): Promise<DerivedDreamChannelState> {
    const events = await this.getEventStore().readEvents(DEFAULT_DREAM_CHANNEL_ID).catch(() => []);
    const finishedByRunId = new Map<string, Extract<AgentEvent, { type: 'dream.finished' }>>();
    let lastDreamedThrough: string | null = null;
    for (const event of events) {
      if (event.type !== 'dream.finished' || !event.runId) continue;
      const window = normalizeDreamWindow(event.window);
      const normalized: Extract<AgentEvent, { type: 'dream.finished' }> = window ? { ...event, window } : event;
      finishedByRunId.set(event.runId, normalized);
      if (event.status !== 'completed' || !window) continue;
      if (lastDreamedThrough === null || compareIsoLocalDates(window.end, lastDreamedThrough) > 0) {
        lastDreamedThrough = window.end;
      }
    }
    return { finishedByRunId, lastDreamedThrough };
  }

  private async scheduledDreamWindow(derived: DerivedDreamChannelState, now: Date): Promise<AgentDreamWindow | null> {
    const end = offsetIsoLocalDate(isoLocalDate(now), -1);
    const start = derived.lastDreamedThrough
      ? offsetIsoLocalDate(derived.lastDreamedThrough, 1)
      : await this.firstDreamEvidenceDate();
    if (!start || compareIsoLocalDates(start, end) > 0) return null;
    return { start, end };
  }

  private async manualDreamWindow(
    options: AgentDreamRunOptions,
    derived: DerivedDreamChannelState,
    now: Date,
  ): Promise<AgentDreamWindow> {
    const explicitStart = normalizedIsoLocalDate(options.startDate ?? '');
    const explicitEnd = normalizedIsoLocalDate(options.endDate ?? '');
    if ((options.startDate && !explicitStart) || (options.endDate && !explicitEnd)) {
      throw new Error('Dream date range must use YYYY-MM-DD dates.');
    }
    const today = isoLocalDate(now);
    const end = explicitEnd && compareIsoLocalDates(explicitEnd, today) < 0 ? explicitEnd : today;
    const defaultStart = (derived.lastDreamedThrough ? offsetIsoLocalDate(derived.lastDreamedThrough, 1) : await this.firstDreamEvidenceDate())
      ?? end;
    const start = explicitStart ?? (compareIsoLocalDates(defaultStart, end) > 0 ? end : defaultStart);
    if (compareIsoLocalDates(start, end) > 0) {
      throw new Error('Dream start date must be on or before the end date.');
    }
    return { start, end };
  }

  private async firstDreamEvidenceDate(): Promise<string | null> {
    const conversationIds = await this.userMemberConversationIds();
    let first: string | null = null;
    for (const conversationId of conversationIds) {
      const events = await this.getEventStore().readEvents(conversationId);
      for (const event of events) {
        if (!isDreamEvidenceRuntimeEvent(event)) continue;
        const date = isoLocalDate(new Date(event.createdAt));
        if (first === null || compareIsoLocalDates(date, first) < 0) first = date;
      }
    }
    return first;
  }

  /** Conversation ids the user principal is a member of (the Dream's evidence set). */
  private async userMemberConversationIds(): Promise<string[]> {
    const user = this.userPrincipal();
    const entries = await this.getEventStore().listConversationIndexEntries();
    return entries
      .filter((entry) => (
        !isInternalAgentConversationId(entry.id)
        && channelIncludesInDreamData(entry.id, entry.settings)
        && entry.members.some((member) => samePrincipal(member, user))
      ))
      .map((entry) => entry.id);
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
      const model = (await this.resolveBuiltInAssistantModelEffort(providerConfig)).model;
      modelForRunMeta = model;
      await this.writeDreamRunMeta(task, 'running', model);
      const skill = await this.renderMemoryDreamSkill(task.runId);
      const prompt = buildMemoryDreamPrompt(task, skill.renderedContent);
      // A successful child that DELIBERATELY writes nothing is a legitimate no-op,
      // not a failure: remembering nothing is a valid Dream outcome (a real
      // run failure/cancel already threw in runMemoryDreamChannelRun). It records
      // `dream.completed` and a clean windowed `dream.finished` marker with zero
      // change counts, so the considered-but-empty date window is not re-read.
      //
      // But "completed" is not the same as "finished": an unresolved context
      // overflow can end the run `completed` mid-work. Such a truncated run that
      // wrote nothing did NOT decide there was nothing worth remembering —
      // recording a clean completed window would silently drop that span's evidence
      // forever. Treat it as a failure so it is retried, NOT a no-op.
      const runResult = await this.runMemoryDreamChannelRun(task, prompt, skill.allowedTools, model, providerConfig);
      const changes = dreamChangesFromChildNodeChanges(runResult.nodeChanges);
      if (runResult.incomplete && !dreamChangesHaveCommittedWork(changes)) {
        throw new DreamChannelRunError('Memory Dream run was truncated by context overflow before writing any memory; not recording a completed window so the span is retried.', runResult.anchorMessageId);
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
      await this.writeDreamRunMeta(task, 'completed', model).catch((error) => {
        this.reportWarn(
          'dream',
          `Dream completed but its run metadata could not be refreshed: ${error instanceof Error ? error.message : String(error)}`,
          error,
          {
            agentId: this.agentIdentity.agentId,
            runId: task.runId,
            principalKey: principalKey(task.principal),
            operation: 'writeDreamRunMeta',
          },
          'dream-run-meta-write-failed',
        );
      });
      const result: AgentDreamRunResult = {
        agentId: this.agentIdentity.agentId,
        runId: task.runId,
        trigger: task.trigger,
        window: task.window,
        status: 'completed',
        startedAt: task.startedAt,
        completedAt: completed.completedAt,
        processed: completed.processed,
        changes: completed.changes,
      };
      await this.appendDreamFinishedEvent(runResult.anchorMessageId, result).catch((error) => {
        this.reportWarn(
          'dream',
          `Dream finished but its terminal channel marker could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
          error,
          {
            agentId: this.agentIdentity.agentId,
            runId: task.runId,
            principalKey: principalKey(task.principal),
            operation: 'appendDreamFinishedEvent',
          },
          'dream-finished-marker-write-failed',
        );
      });
      await this.pruneDreamChannelHistory().catch((error) => {
        this.reportWarn(
          'dream',
          `Dream completed but old channel transcript cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          error,
          {
            agentId: this.agentIdentity.agentId,
            runId: task.runId,
            principalKey: principalKey(task.principal),
            operation: 'pruneDreamChannelHistory',
          },
          'dream-channel-history-prune-failed',
        );
      });
      return result;
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
      const result: AgentDreamRunResult = {
        agentId: this.agentIdentity.agentId,
        runId: task.runId,
        trigger: task.trigger,
        window: task.window,
        status: 'failed',
        startedAt: task.startedAt,
        completedAt: Date.now(),
        errorMessage: message,
      };
      const anchorMessageId = error instanceof DreamChannelRunError ? error.anchorMessageId : null;
      if (anchorMessageId) {
        await this.appendDreamFinishedEvent(anchorMessageId, result).catch(() => undefined);
        await this.pruneDreamChannelHistory().catch(() => undefined);
      }
      return result;
    }
  }

  private async renderMemoryDreamSkill(runId: string): Promise<{
    renderedContent: string;
    allowedTools: string[];
  }> {
    const runtime = new AgentSkillRuntime({
      localRoot: this.options.localFileRoot,
      includeUserSkills: false,
      conversationId: `memory-dream:${runId}`,
    });
    const invocation = await runtime.invokeSkill({
      skill: MEMORY_DREAM_SKILL_NAME,
      trigger: 'runtime',
    });
    if (!invocation.ok) throw new Error(invocation.message);
    return {
      renderedContent: invocation.renderedContent,
      allowedTools: invocation.skill.allowedTools.length > 0
        ? invocation.skill.allowedTools
        : [...MEMORY_DREAM_ALLOWED_TOOLS],
    };
  }

  private async runMemoryDreamChannelRun(
    task: AgentDreamMemoryExtractionTask,
    prompt: string,
    allowedTools: readonly string[],
    model: Model<Api>,
    providerConfig: AgentProviderRuntimeConfig,
  ): Promise<{ nodeChanges: AgentChildRunNodeChanges; incomplete: boolean; anchorMessageId: string }> {
    let anchorMessageId: string | null = null;
    let startedRunId: string | null = null;
    try {
      const nodeChanges: AgentChildRunNodeChanges = {};
      await this.ensureDreamChannelEventState();
      const conversation = await this.ensureConversationWithId(DEFAULT_DREAM_CHANNEL_ID);
      await this.refreshRuntimeSettings(conversation);
      const activePath: AgentMessage[] = [];
      const skillRuntime = new AgentSkillRuntime({
        localRoot: this.options.localFileRoot,
        includeUserSkills: false,
        conversationId: `memory-dream:${task.runId}`,
      });
      const localWorkspace = createAgentLocalWorkspaceContext(this.options.localFileRoot, this.scratchRoot(), skillRuntime);
      const dreamAgent = createConfiguredAgent(DEFAULT_DREAM_CHANNEL_ID, providerConfig, activePath, this.outlinerToolHost, {
        localFileRoot: this.options.localFileRoot,
        localWorkspace,
        model,
        permissionMode: this.options.permissionMode,
        runtimeSettingsLoader: () => this.getRuntimeSettings(),
        skillToolEnabled: false,
        skillRuntime,
        chatSourceValidator: this.createChatSourceValidator(),
        pastChats: this.createPastChatsToolRuntime(() => DEFAULT_DREAM_CHANNEL_ID),
        allowedTools: [...allowedTools],
        preapprovedToolRules: [...allowedTools],
        streamFn: this.options.streamFn,
        completeSimpleFn: this.options.completeSimpleFn,
        providerApiKeyLoader: this.options.providerApiKeyLoader,
        permissionEventHandler: (input) => {
          const current = this.conversations.get(DEFAULT_DREAM_CHANNEL_ID);
          return current ? this.appendToolPermissionEvent(DEFAULT_DREAM_CHANNEL_ID, current, input) : Promise.resolve();
        },
        afterToolResult: (_toolCallId, toolName, result, isError) => {
          recordNodeToolChanges(nodeChanges, toolName, result, isError);
          return undefined;
        },
      }, async (payload) => {
        try {
          await this.captureDebugRunSnapshot(DEFAULT_DREAM_CHANNEL_ID, payload, task.runId);
        } catch (error) {
          this.emitError(DEFAULT_DREAM_CHANNEL_ID, error instanceof Error ? error.message : String(error));
        }
        return undefined;
      });
      const anchor = buildMemoryDreamAnchorPrompt(task, prompt);
      anchorMessageId = await this.appendUserPromptEvent(
        DEFAULT_DREAM_CHANNEL_ID,
        conversation,
        anchor,
        task.trigger === 'schedule' ? systemActor() : userActor(),
      );
      startedRunId = await this.startRun(
        DEFAULT_DREAM_CHANNEL_ID,
        conversation,
        anchor,
        { type: 'message', messageId: anchorMessageId },
        {
          runId: task.runId,
          executingAgentId: this.agentIdentity.agentId,
          agent: dreamAgent,
          kind: 'reflective',
          fingerprint: memoryDreamRunFingerprint(task, model),
        },
      );
      const activeRun = conversation.activeRuns.get(startedRunId);
      if (!activeRun) throw new Error('Memory Dream run did not start.');
      const scoped = this.scopedConversation(conversation, activeRun, dreamAgent);
      activeRun.unsubscribe = dreamAgent.subscribe(async (event) => {
        await this.handlePiAgentEvent(DEFAULT_DREAM_CHANNEL_ID, scoped, event);
        this.emitProjection(DEFAULT_DREAM_CHANNEL_ID, event.type, event.type === 'message_update' ? 'coalesce' : 'immediate');
      });
      await dreamAgent.prompt(anchor);
      await activeRun.settled;
      await this.persistAndEmitIdle(DEFAULT_DREAM_CHANNEL_ID, conversation);
      const finalAssistant = lastAssistantMessage(dreamAgent.state.messages as AgentMessage[]);
      return {
        nodeChanges,
        incomplete: finalAssistant ? isContextOverflow(finalAssistant, dreamAgent.state.model.contextWindow) : false,
        anchorMessageId,
      };
    } catch (error) {
      await this.recoverFromRunError(DEFAULT_DREAM_CHANNEL_ID, startedRunId);
      throw new DreamChannelRunError(error instanceof Error ? error.message : String(error), anchorMessageId);
    }
  }

  private async appendDreamFinishedEvent(
    anchorMessageId: string,
    result: AgentDreamRunResult,
  ): Promise<void> {
    const conversation = this.conversations.get(DEFAULT_DREAM_CHANNEL_ID)
      ?? await this.ensureConversationWithId(DEFAULT_DREAM_CHANNEL_ID);
    await this.appendConversationEvents(DEFAULT_DREAM_CHANNEL_ID, conversation, [{
      type: 'dream.finished',
      actor: systemActor(),
      messageId: anchorMessageId,
      agentId: result.agentId,
      runId: result.runId,
      trigger: result.trigger,
      window: result.window,
      status: result.status,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      processed: result.processed,
      changes: result.changes,
      errorMessage: result.errorMessage,
    }]);
  }

  private async pruneDreamChannelHistory(): Promise<void> {
    const result = await this.getEventStore().retainRecentConversationRuns(
      DEFAULT_DREAM_CHANNEL_ID,
      DREAM_CHANNEL_RETAINED_RUNS,
    );
    if (result.prunedRunIds.length === 0) return;
    await this.refreshAgentTaskCache();
    this.emitProjection(DEFAULT_DREAM_CHANNEL_ID, 'dream_channel_history_pruned');
  }

  private async writeDreamRunMeta(
    task: AgentDreamMemoryExtractionTask,
    status: 'running' | 'completed' | 'failed',
    model: Model<Api>,
  ): Promise<void> {
    const timestamp = status === 'running' ? task.startedAt : Date.now();
    const existing = await this.getEventStore().readRunMetaProjection(task.runId);
    await this.getEventStore().writeRunMeta({
      v: 1,
      id: task.runId,
      // Dream now runs as a top-level turn inside the protected Dream channel. The
      // semantic pool still belongs to `task.principal`; the run transcript and
      // durable run ledger are anchored to the channel so replay can join them.
      agentId: this.agentIdentity.agentId as AgentRunMetaProjection['agentId'],
      anchor: {
        type: 'conversation',
        agentId: this.agentIdentity.agentId as AgentRunMetaProjection['agentId'],
        conversationId: DEFAULT_DREAM_CHANNEL_ID,
      },
      kind: 'reflective',
      status,
      trigger: task.trigger === 'schedule'
        ? { type: 'schedule', schedule: task.schedule, dueAt: task.dueAt }
        : { type: 'manual' },
      fingerprint: memoryDreamRunFingerprint(task, model),
      retention: 'hot',
      createdAt: task.startedAt,
      updatedAt: timestamp,
      usage: existing?.usage,
      latestSeq: existing?.latestSeq ?? 0,
    });
    await this.refreshAgentTaskCache();
    this.emitAgentTaskProjection(`dream.${status}`);
  }

  private async refreshAgentTaskCache(): Promise<void> {
    this.agentTaskCache = await this.collectDreamTasks();
  }

  private async collectDreamTasks(limit = 50): Promise<AgentRenderDreamTaskEntity[]> {
    const store = this.getEventStore();
    const principal = this.agentPrincipal();
    const [runs, derivedDream] = await Promise.all([
      store.listConversationRunMetaProjections(DEFAULT_DREAM_CHANNEL_ID, { limit }),
      this.deriveDreamChannelState(),
    ]);
    return runs
      .flatMap((run): AgentRenderDreamTaskEntity[] => {
        const completed = derivedDream.finishedByRunId.get(run.id) ?? null;
        const task = dreamTaskFromRunMeta(run, completed, principal);
        return task ? [task] : [];
      })
      .sort(compareRenderTasks);
  }

  async listDreamHistory(options: { limit?: number } = {}): Promise<AgentRenderDreamTaskEntity[]> {
    return this.collectDreamTasks(options.limit ?? 50);
  }

  async runDreamNow(options: AgentDreamRunOptions = {}): Promise<AgentDreamRunResult | null> {
    if (!this.dreamMemoryExtractionEnabled()) throw new Error('Memory Dream is disabled.');
    if (!await this.getActiveProviderConfig()) throw new Error('No enabled agent provider is configured.');
    return this.fireDreamForPool(this.agentPrincipal(), 'manual', new Date(), options);
  }

  /**
   * Cheap, read-only pre-check for the manual "Dream now" control: count the new
   * evidence in the default manual date window and compare it to the same volume bar the
   * scheduled path uses, WITHOUT running the model. Lets the UI advise that a
   * manual run is likely a no-op (and offer to run anyway). Shares the exact
   * volume calc with the scheduled gate through collectDreamEvidence, so the two
   * can never drift.
   */
  async previewDreamReadiness(): Promise<AgentDreamReadiness> {
    const derived = await this.deriveDreamChannelState();
    const window = await this.manualDreamWindow({}, derived, new Date());
    const { newCharCount, newMessageCount } = await this.collectDreamEvidence(window, 'dream-readiness');
    return {
      window,
      lastDreamedThrough: derived.lastDreamedThrough,
      newMessageCount,
      newCharCount,
      thresholdChars: DREAM_MIN_VOLUME_CHARS,
      belowThreshold: newCharCount < DREAM_MIN_VOLUME_CHARS,
    };
  }

  private emitAgentTaskProjection(lastEventType: string) {
    for (const conversationId of this.conversations.keys()) {
      this.emitProjection(conversationId, lastEventType, 'coalesce');
    }
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

  private createChannelId() {
    return `lin-agent-channel-${randomUUID()}`;
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

  private defaultAgentIdForConversation(_eventState: AgentEventReplayState): string {
    // Single-agent collapse: every conversation's agent is Neva.
    return this.agentIdentity.agentId;
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
    return fallback;
  }

  private currentRuntimeAgent(fallback: Agent | null): Agent | null {
    return fallback;
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
        // The executing agent may be a run-profile agent (Dream) rather than the
        // conversation default, so hash the actual live prompt used for this run.
        systemPrompt: agent.state.systemPrompt,
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
    const renderProjection = this.renderProjection(conversation);
    conversation.lastRenderProjection = renderProjection;
    return {
      conversationId: conversationId,
      renderProjection,
      pendingUserQuestion: this.pendingUserQuestionView(conversationId, conversation),
    };
  }

  private renderProjection(conversation: AgentConversationState) {
    const hasActiveRuns = this.hasActiveRuns(conversation);
    // Sort the active-run list once: renderProjection reads it three times below.
    const runList = this.activeRunList(conversation);
    const projection = buildAgentRenderProjection(conversation.eventState, {
      revision: conversation.revision,
      activeRunId: this.activeRunId(conversation),
      activeRuns: runList.map((run) => ({
        runId: run.id,
        agentId: run.executingAgentId,
        startedAt: run.startedAt,
      })),
      activeCompaction: conversation.activeCompaction,
      activeDream: conversation.activeDream,
      runActive: hasActiveRuns,
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
      coordinatorAgentId: this.agentIdentity.agentId,
    });
    return {
      ...projection,
      conversationTitle: sanitizeConversationTitle(projection.conversationTitle),
    };
  }

  private streamingProjectionPatch(
    conversation: AgentConversationState,
    revision: number,
  ): AgentRenderProjectionPatch | null {
    const previous = conversation.lastRenderProjection;
    if (!previous || previous.revision !== revision - 1) return null;
    const activeRun = conversation.activeRun;
    const messageId = activeRun?.assistantMessageId;
    if (!activeRun || !messageId) return null;
    const previousMessage = previous.entities.messages[messageId];
    const eventMessage = conversation.eventState.messages[messageId];
    if (!previousMessage || previousMessage.role !== 'assistant') return null;
    if (!eventMessage || eventMessage.role !== 'assistant' || eventMessage.status !== 'streaming') return null;
    if (!previous.transcriptRows.some((row) => row.kind === 'message' && row.messageId === messageId)) return null;
    if (!isSingleTextPersistedContent(eventMessage.content, activeRun.assistantText)) return null;
    const runList = this.activeRunList(conversation);
    const pendingToolCallIds = uniqueStrings([
      ...Array.from(conversation.agent.state.pendingToolCalls),
      ...runList.flatMap((run) => Array.from(run.agent.state.pendingToolCalls)),
    ]);
    const message: AgentRenderMessageEntity = {
      ...previousMessage,
      status: eventMessage.status,
      content: textPersistedContent(activeRun.assistantText),
      updatedAt: eventMessage.updatedAt,
    };
    return {
      baseRevision: previous.revision,
      revision,
      activeRunId: this.activeRunId(conversation),
      activeRuns: runList.map((run) => ({
        runId: run.id,
        agentId: run.executingAgentId,
        startedAt: run.startedAt,
      })),
      runActive: true,
      pendingToolCallIds,
      entities: { messages: { [messageId]: message } },
      streaming: {
        messageId,
        rowId: previous.streaming?.rowId ?? `assistant:${messageId}`,
        text: activeRun.assistantText,
        updatedAt: eventMessage.updatedAt,
      },
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
    const revision = conversation.revision + 1;
    const projectionPatch = lastEventType === 'message_update'
      ? this.streamingProjectionPatch(conversation, revision)
      : null;
    conversation.revision = revision;
    const timestamp = Date.now();
    if (projectionPatch) {
      const nextProjection = conversation.lastRenderProjection
        ? applyAgentRenderProjectionPatch(conversation.lastRenderProjection, projectionPatch)
        : null;
      if (nextProjection) {
        conversation.lastRenderProjection = nextProjection;
        this.domainEvents.publish({
          lane: 'renderer-projection',
          name: 'RendererProjectionUpdated',
          conversationId,
          lastEventType,
          revision: conversation.revision,
          projectionPatch,
          createdAt: timestamp,
        });
        return;
      }
    }
    const renderProjection = this.renderProjection(conversation);
    conversation.lastRenderProjection = renderProjection;
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

  private createPastChatsToolRuntime(getConversationId: () => string): AgentToolsOptions['pastChats'] {
    return {
      service: this.getPastChatsService(),
      currentConversationId: getConversationId,
    };
  }

  private createChatSourceValidator(): AgentToolsOptions['chatSourceValidator'] {
    return async (target) => {
      const result = await this.getPastChatsService().readSource({
        source: {
          stream: target.stream,
          streamId: target.streamId,
          range: {
            fromSeqExclusive: target.range.fromSeqExclusive,
            throughSeq: target.range.throughSeq,
            throughEventId: target.range.throughEventId ?? null,
            ...(target.range.fromCreatedAtInclusive !== undefined ? { fromCreatedAtInclusive: target.range.fromCreatedAtInclusive } : {}),
            ...(target.range.throughCreatedAtExclusive !== undefined ? { throughCreatedAtExclusive: target.range.throughCreatedAtExclusive } : {}),
          },
        },
        maxChars: 1,
      });
      if (result.mode === 'source') return { ok: true };
      return {
        ok: false,
        code: 'invalid_chat_source',
        error: result.mode === 'error' ? result.message : 'Chat source could not be read by exact source coordinates.',
        instructions: 'Use past_chats search/recent/read to get a current source object, then retry with that exact chat reference marker.',
      };
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
      alwaysAllowAction: input.decision.request.alwaysAllowAction,
      autoBlockMs: input.decision.request.autoBlockMs,
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

      const pendingApproval: AgentPendingApproval = {
        conversationId,
        runId: this.activeRunId(conversation) ?? undefined,
        request,
        alwaysAllowRule: request.alwaysAllowRule,
        alwaysAllowAction: request.alwaysAllowAction,
        resolve: (resolution) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(resolution);
        },
      };
      if (request.autoBlockMs && request.autoBlockMs > 0) {
        pendingApproval.autoBlockTimer = setTimeout(() => {
          void this.denyPendingApprovalForRuntime(conversationId, conversation, requestId, 'user_denied');
        }, request.autoBlockMs);
        pendingApproval.autoBlockTimer.unref?.();
      }
      this.pendingApprovals.set(requestId, pendingApproval);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
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
    actor: AgentActor = userActor(),
  ): Promise<string> {
    const messageId = this.createMessageId('user');
    const persisted = await this.persistPiUserContent(conversationId, prompt.content, {
      imageSummary: 'Image attachment',
    });
    const inputs: AgentEventInput[] = [
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
  }

  private async startRun(
    conversationId: string,
    conversation: AgentConversationState,
    prompt: UserMessage | null = null,
    triggerOverride: AgentRunTrigger | null = null,
    identity: {
      runId?: string;
      executingAgentId?: string;
      agent?: Agent;
      allowConcurrent?: boolean;
      kind?: AgentRunKind;
      fingerprint?: AgentRunFingerprint;
    } = {},
  ): Promise<string> {
    if (!identity.allowConcurrent && this.hasActiveRuns(conversation)) {
      throw new Error('A run is already active in this conversation.');
    }
    const runId = identity.runId ?? randomUUID();
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
      settled,
      resolveSettled,
      assistantMessageId: null,
      assistantText: '',
      assistantContent: [],
      assistantLiveSegmentStart: 0,
      lastMessageId: null,
      lastSubmittedUserPrompt: prompt,
      toolOutputPayloads: new Map(),
      toolCallMessageIds: new Map(),
      executingAgentId: agentId,
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
        anchor: { type: 'conversation', agentId, conversationId },
        kind: identity.kind ?? 'turn',
        trigger: triggerOverride ?? this.runTrigger(scoped),
        fingerprint: identity.fingerprint ?? this.runFingerprint(scoped, agentId, agent),
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
    const definitions = await this.withBuiltInAgentDefinitions(await delegationRuntime.listAllAgentDefinitions());
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
      // A run's first segment parents to the conversation's selected leaf; every
      // later segment parents to the run's own tail (`lastMessageId`) so the run
      // stays a linear spine.
      parentMessageId: activeRun.lastMessageId ?? conversation.eventState.selectedLeafMessageId,
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
    await this.appendConversationEvents(conversationId, conversation, [
      {
        type: 'assistant_message.completed',
        actor: this.runActor(conversation),
        runId: this.activeRunId(conversation) ?? undefined,
        messageId,
        stopReason: message.stopReason,
        content: fromPiAssistantContent(message.content),
        usage: message.usage,
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
        // Chain onto the run's tail, not the assistant: when one assistant emits
        // parallel tool calls, parenting every result to the assistant makes them
        // siblings, and the single-leaf active path keeps only one — the rest fall
        // off-path and render as resultless "Failed" rows. Threading through
        // `lastMessageId` (assistant → result₁ → result₂ → …) keeps the run a
        // linear spine so every result stays on the active path.
        parentMessageId: activeRun.lastMessageId
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
    // transformContext → prepareModelContext). The single agent always reads
    // its own linear transcript; the environment reminder below rides the tail
    // on a real reply run.
    const conversation = scopedConversation ?? this.conversations.get(conversationId);
    const activeRun = conversation?.activeRun;
    const liveConversation = conversation && conversation.eventState === eventState ? conversation : null;
    const messages: AgentMessage[] = [];
    for (const message of getAgentEventRuntimeTranscriptPath(eventState)) {
      messages.push(await this.runtimePiMessageFromRecord(conversationId, message));
    }
    // Conversation environment reminder (the reminder-stack `environment` slot):
    // the system prompt is identity-only, so the 1:1 framing rides here instead.
    // Only on a real reply run; restore/Dream/compaction have no activeRun.
    if (liveConversation && activeRun) {
      this.appendTrailingSystemReminder(messages, buildConversationEnvironmentReminder());
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
      // The model sees the slimmed copy when one exists; the canonical full
      // `content` is reserved for the UI/search (see `modelSlimmedContent`).
      content: await this.runtimeUserContent(conversationId, message.modelSlimmedContent ?? message.content),
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
      if (part.type === 'payload_ref' && part.payload.mimeType === 'application/pdf') {
        parts.push({
          type: 'text',
          text: nativePdfPayloadFallbackText(part),
        });
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
    settings: { ...eventState.conversation.settings },
    createdAt: eventState.conversation.createdAt,
    updatedAt: eventState.conversation.updatedAt,
    messageCount: Object.keys(eventState.messages).length,
  };
}

function protectedDefaultChannelConfig(conversationId: string): ProtectedDefaultChannelConfig | null {
  return PROTECTED_DEFAULT_CHANNELS.find((config) => config.id === conversationId) ?? null;
}

function requiredProtectedDefaultChannelConfig(conversationId: string): ProtectedDefaultChannelConfig {
  const config = protectedDefaultChannelConfig(conversationId);
  if (!config) throw new Error(`Protected default channel is not configured: ${conversationId}`);
  return config;
}

function defaultChannelSortRank(conversationId: string): number {
  return protectedDefaultChannelConfig(conversationId)?.sortRank ?? PROTECTED_DEFAULT_CHANNELS.length;
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

function isSingleTextPersistedContent(content: AgentPersistedContent[], text: string): boolean {
  return content.length === 1 && content[0]?.type === 'text' && content[0].text === text;
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

function nativePdfPayloadFallbackText(part: Extract<AgentPersistedContent, { type: 'payload_ref' }>): string {
  const label = part.label || part.payload.summary || 'PDF document';
  return [
    `PDF document attached: ${label}`,
    'Use the referenced local file path with file_read to extract text. Add pages only when page images or visual layout inspection are needed.',
  ].join('\n');
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

/**
 * Layer the user's editable overlay onto the code-default built-in assistant. Only
 * the fields the user can change are overlaid; `name`/`source`/`rootDir`/`agentFile`
 * stay from the base so the agentId — the stable memory anchor — never moves, no
 * matter how Neva is renamed ([[single-agent-collapse]]).
 */
function applyBuiltInAgentProfile(base: AgentDefinition, overlay: StoredBuiltInAgentProfile): AgentDefinition {
  const next: AgentDefinition = { ...base };
  if (overlay.displayName !== undefined) next.displayName = overlay.displayName;
  if (overlay.description !== undefined) next.description = overlay.description;
  if (overlay.body !== undefined) next.body = overlay.body;
  if (overlay.model !== undefined) next.model = overlay.model;
  if (overlay.effort !== undefined) next.effort = overlay.effort;
  if (overlay.permissionMode !== undefined) next.permissionMode = overlay.permissionMode;
  if (overlay.maxTurns !== undefined) next.maxTurns = overlay.maxTurns;
  if (overlay.tools !== undefined) next.tools = overlay.tools;
  if (overlay.disallowedTools !== undefined) next.disallowedTools = overlay.disallowedTools;
  if (overlay.skills !== undefined) next.skills = overlay.skills;
  if (overlay.background !== undefined) next.background = overlay.background;
  return next;
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
    chatSourceValidator?: AgentToolsOptions['chatSourceValidator'];
    pastChats?: AgentToolsOptions['pastChats'];
    askUserQuestion?: AgentToolsOptions['askUserQuestion'];
    selfMaintenance?: AgentToolsOptions['selfMaintenance'];
    localWorkspace?: AgentLocalWorkspaceContext;
    allowedTools?: readonly string[];
    disallowedTools?: readonly string[];
    preapprovedToolRules?: string[];
    l0CacheBreakpointEnabled?: boolean;
    approvalHandler?: (input: AgentToolApprovalInput, signal?: AbortSignal) => Promise<AgentToolApprovalResolution>;
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
  const buildTools = () => createAgentTools(outlinerToolHost, {
    localFileRoot,
    localWorkspace: options.localWorkspace,
    skillRuntime,
    skillToolEnabled: options.skillToolEnabled,
    delegationRuntime: options.delegationRuntime,
    chatSourceValidator: options.chatSourceValidator,
    pastChats: options.pastChats,
    askUserQuestion: options.askUserQuestion,
    selfMaintenance: options.selfMaintenance,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
  });
  let agent: Agent;
  agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: activeThinkingLevel,
      tools: buildTools(),
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
      const activeSkillReadRoots = skillRuntime ? await skillRuntime.getActiveSkillReadRoots() : [];
      const shouldSyncLocalPermissionRoots = Boolean(
        options.localWorkspace
        && LOCAL_FILE_TOOL_NAMES.has(toolCall.name.trim().replace(/-/g, '_').toLowerCase()),
      );
      const syncLocalPermissionRoots = (extraGrants: readonly AgentPermissionGrant[] = []) => {
        if (!options.localWorkspace || !shouldSyncLocalPermissionRoots) return;
        const roots = [
          ...activeSkillReadRoots.map((root) => ({ access: 'read' as const, root })),
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
          trustedReadRoots: activeSkillReadRoots,
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
      if (decision.behavior === 'ask' || decision.behavior === 'soft_blocked') {
        await options.permissionEventHandler?.({
          requestId: permissionRequestId,
          toolCall,
          decision,
          outcome: decision.behavior === 'soft_blocked' ? 'soft_blocked' : 'ask',
        });
        if (decision.behavior === 'ask') {
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
            message: decision.behavior === 'soft_blocked'
              ? 'Action was blocked by default and no exception channel is available.'
              : 'Permission requires user approval, but no approval channel is available.',
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
          if (update?.model) {
            activeLoopModel = update.model as Model<Api>;
            agent.state.tools = buildTools();
          }
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

// `AGENT_REASONING_LEVELS` membership derives from the single shared ordered ladder
// in core (`AGENT_REASONING_LADDER`); the default level + nearest-level coercion are
// shared with the renderer via `core/agentReasoning`.
const AGENT_REASONING_LEVELS = new Set<AgentReasoningLevel>(AGENT_REASONING_LADDER);

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

/**
 * The default thinking level an agent runs at when its profile sets no effort:
 * `medium` coerced to the model's nearest supported level (shared with the renderer
 * via `core/agentReasoning`; a non-reasoning model supporting only `off` stays `off`).
 */
function defaultThinkingLevel(model: Model<Api>): AgentReasoningLevel {
  const supported = getSupportedThinkingLevels(model).filter((item): item is AgentReasoningLevel => (
    AGENT_REASONING_LEVELS.has(item as AgentReasoningLevel)
  ));
  return defaultThinkingLevelFor(supported);
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

function buildMemoryDreamPrompt(task: AgentDreamMemoryExtractionTask, skillContent: string): string {
  const sources = task.span.sources.map((source, index) => {
    const sourceId = `source-${index + 1}`;
    return {
      id: sourceId,
      past_chats: {
        source: {
          stream: source.stream,
          stream_id: source.streamId,
          from_seq_exclusive: source.range.fromSeqExclusive,
          through_seq: source.range.throughSeq,
          through_event_id: source.range.throughEventId ?? null,
          from_created_at_inclusive: source.range.fromCreatedAtInclusive ?? null,
          through_created_at_exclusive: source.range.throughCreatedAtExclusive ?? null,
        },
        max_chars: 8000,
      },
      chat_marker_template: formatChatSourceReferenceMarker('natural source phrase', {
        kind: 'chat-source',
        stream: source.stream,
        streamId: source.streamId,
        range: {
          fromSeqExclusive: source.range.fromSeqExclusive,
          throughSeq: source.range.throughSeq,
          throughEventId: source.range.throughEventId ?? null,
          ...(source.range.fromCreatedAtInclusive !== undefined ? { fromCreatedAtInclusive: source.range.fromCreatedAtInclusive } : {}),
          ...(source.range.throughCreatedAtExclusive !== undefined ? { throughCreatedAtExclusive: source.range.throughCreatedAtExclusive } : {}),
        },
      }),
    };
  });
  return [
    skillContent.trim(),
    '',
    '<memory-dream-run>',
    `run_id: ${task.runId}`,
    `trigger: ${task.trigger}`,
    `date_window: ${dreamWindowSummary(task.window)}`,
    `started_at: ${new Date(task.startedAt).toISOString()}`,
    ...(task.guidance ? [`guidance: ${task.guidance}`] : []),
    '',
    'Before writing, read the journal node for each source date in this run. When the window spans multiple days, write durable findings under the daily memory node for the source date, not merely the run date.',
    'Remembering nothing is a valid and common outcome. If this run yields no durable, future-useful memory, write nothing at all: create no #d-memory container and no memory nodes, then end. That is success, not failure. Never create an empty #d-memory container, and never write an episode that only narrates that Neva answered, looked something up, replied in a language, or cited a source (for example "Neva answered a Chengdu weather follow-up in Chinese using China Weather as the source") — an episode must capture a durable fact about the user or the work, not a log of assistant actions.',
    'When you do write memory, maintain exactly one direct child #d-memory container per source-date journal node across scheduled and manual Dream runs. The #d-memory title must be a concise generated daily memory headline, not the fixed word "Memory"; update the existing container title in place when that source date already has one.',
    'Apply the human-dream cycle from the skill instructions: replay salient fragments, associate them with outline context, reconcile prior memory, abstract stable patterns, expose unresolved tensions as #d-question only when needed, and write future handling notes as #d-guidance only when useful. When processed.consolidate_only is true and sources is empty, replay and consolidate outline context plus prior Dream memory instead of raw chat.',
    'Apply the Valuable Memory Filter from the skill instructions before writing. Prefer skipping thin or transient evidence over creating low-value memory; when nothing survives the filter, write nothing rather than a low-value placeholder. Durable #d-belief nodes should be reserved for future-relevant preferences, decisions, project facts, corrections, or recurring patterns.',
    'Use node_search and node_read to gather relevant outline context before writing: prior #d-memory/#d-episode/#d-belief/#d-question/#d-guidance nodes for these topics and user-authored outline nodes that clarify projects, tasks, decisions, tools, or workflow. Treat prior Dream results as current beliefs, tensions, and guidance to reconcile, not as primary evidence. Matching memory nodes and related outline nodes may be edited, moved, merged, or deleted when consolidation warrants it.',
    'When sources are present, read and consolidate only these chat sources. When processed.consolidate_only is true and sources is empty, do not call past_chats; consolidate using node_read/node_search over outline context and prior Dream memory. When a visible citation is useful, copy that source\'s chat_marker_template and replace only "natural source phrase" with a concise label that reads as part of the sentence you write. Do not cite every line mechanically; one episode-level citation can cover child nodes that use the same evidence.',
    'Do not use bookkeeping labels such as source-1, source-2, source, citation, evidence, or link as the visible marker label.',
    'Good labels are short natural fragments like "in the Chengdu weather chat" or "when the user asked in Chinese"; write the surrounding sentence so the marker label is grammatically connected to it.',
    '',
    JSON.stringify({
      sources,
      window: task.window,
      guidance: task.guidance ?? null,
      processed: {
        total_message_count: task.span.totalMessageCount,
        total_char_count: task.span.totalCharCount,
        consolidate_only: task.span.consolidateOnly,
      },
    }, null, 2),
    '</memory-dream-run>',
  ].join('\n');
}

function buildMemoryDreamAnchorPrompt(task: AgentDreamMemoryExtractionTask, hiddenPrompt: string): UserMessage {
  const label = task.trigger === 'schedule' ? 'Scheduled Dream' : 'Manual Dream';
  const guidance = task.guidance ? ` · ${task.guidance}` : '';
  return {
    role: 'user',
    timestamp: task.startedAt,
    content: [
      { type: 'text', text: systemReminder(hiddenPrompt) },
      { type: 'text', text: `${label} · ${dreamWindowSummary(task.window)} · ${dreamSpanSummary(task.span)}${guidance}` },
    ],
  };
}

function dreamSpanSummary(span: DreamMemoryExtractionSpan): string {
  if (span.consolidateOnly) return 'consolidate existing memory';
  return `${span.totalMessageCount} messages · ${span.totalCharCount} chars`;
}

function normalizeDreamGuidance(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 2_000) : undefined;
}

function normalizeDreamWindow(value: unknown): AgentDreamWindow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const start = typeof record.start === 'string' ? normalizedIsoLocalDate(record.start) : null;
  const end = typeof record.end === 'string' ? normalizedIsoLocalDate(record.end) : null;
  if (!start || !end || compareIsoLocalDates(start, end) > 0) return null;
  return { start, end };
}

function dreamCreatedAtRange(window: AgentDreamWindow): DreamMemoryExtractionCreatedAtRange {
  const start = startOfLocalDay(dateFromIsoLocalDate(window.start));
  const through = addLocalDays(startOfLocalDay(dateFromIsoLocalDate(window.end)), 1);
  return {
    fromInclusive: start.getTime(),
    throughExclusive: through.getTime(),
  };
}

function isDreamEvidenceRuntimeEvent(event: AgentEvent): boolean {
  return event.type === 'user_message.created'
    || event.type === 'user_message.edited'
    || event.type === 'assistant_message.completed'
    || event.type === 'assistant_message.failed'
    || event.type === 'tool_result.created'
    || event.type === 'tool_result.replaced';
}

function memoryDreamRunFingerprint(
  task: AgentDreamMemoryExtractionTask,
  model: Model<Api>,
): AgentRunFingerprint {
  return {
    appVersion: electronAppVersion(),
    // The Dream prompt is the believer-pool extraction request, not the protected
    // channel's normal chat prompt.
    promptHash: hashJson({
      dream: MEMORY_DREAM_SKILL_NAME,
      principal: principalKey(task.principal),
    }),
    toolSchemaHash: hashJson({ tools: MEMORY_DREAM_ALLOWED_TOOLS }),
    skillBindings: [MEMORY_DREAM_SKILL_NAME],
    modelConfig: hashJson({
      model: model.id,
      provider: model.provider,
    }),
  };
}

function dreamTaskFromRunMeta(
  run: AgentRunMetaProjection,
  completed: Extract<AgentEvent, { type: 'dream.finished' }> | null,
  principal: AgentPrincipal,
): AgentRenderDreamTaskEntity | null {
  if (run.kind !== 'reflective') return null;
  const trigger = dreamTaskTrigger(run);
  if (!trigger) return null;
  const status = renderTaskStatusFromRunStatus(run.status);
  return {
    id: `dream:${run.id}`,
    kind: 'dream',
    status,
    trigger,
    window: completed?.window,
    principal,
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

function emptyDreamChanges(): AgentDreamCompletedChanges {
  return { added: 0, updated: 0, forgotten: 0, skipped: 0 };
}

function dreamChangesFromChildNodeChanges(nodeChanges: AgentChildRunNodeChanges): AgentDreamCompletedChanges {
  return {
    added: uniqueStrings(nodeChanges.createdNodeIds).length,
    updated: uniqueStrings(nodeChanges.updatedNodeIds).length,
    forgotten: uniqueStrings(nodeChanges.trashedNodeIds).length,
    skipped: 0,
  };
}

function lastAssistantMessage(messages: readonly AgentMessage[]): AssistantMessage | null {
  for (const message of [...messages].reverse()) {
    if (isAssistantMessage(message)) return message;
  }
  return null;
}

function dreamChangesHaveCommittedWork(changes: AgentDreamCompletedChanges): boolean {
  return changes.added + changes.updated + changes.forgotten > 0;
}

class DreamChannelRunError extends Error {
  constructor(message: string, readonly anchorMessageId: string | null) {
    super(message);
  }
}

function isInternalAgentConversationId(conversationId: string): boolean {
  return conversationId === LEGACY_MEMORY_DREAM_CONVERSATION_ID;
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
  if (event.projectionPatch) {
    return {
      type: 'projection_patch',
      conversationId: event.conversationId,
      lastEventType: event.lastEventType,
      revision: event.revision,
      patch: event.projectionPatch,
      timestamp: event.createdAt,
    };
  }
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

function uniqueStrings(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((value) => typeof value === 'string' && value.length > 0))];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
