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
  type AgentActor,
  type AgentCompactionSourceRange,
  type AgentCompactionTrigger,
  type AgentEvent,
  type AgentEventMessageRecord,
  type AgentEventReplayState,
  type AgentIdentityRecord,
  type AgentMemoryEntry,
  type AgentMemorySource,
  type AgentPayloadRef,
  type AgentPersistedContent,
  type AgentPrincipal,
  type AgentRunFingerprint,
  type AgentRunTrigger,
  type AgentUserQuestionAnswer,
  type AgentUserQuestionRequestView,
} from '../core/agentEventLog';
import {
  nodeReferenceMarkersToText,
  rewriteFileReferenceMarkerPaths,
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
} from './agentEventStore';
import { AgentDomainEventBus, type AgentDomainEvent } from './agentDomainEvents';
import { AgentPastChatsService } from './agentPastChats';
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
import type { AgentSkillWriteAudit } from './agentSkillAuthoring';
import { executeAgentSkillShellCommand } from './agentSkillShell';
import {
  evaluateAgentToolPermission,
  toPermissionClassifierInput,
  type AgentPermissionAskDecision,
} from './agentPermissions';
import {
  resolveAgentPermissionAsk,
  type AgentPermissionClassifier,
} from './agentPermissionAskResolver';
import {
  buildPermissionClassifierContextRecords,
  createDefaultPermissionClassifier,
} from './agentPermissionClassifier';
import {
  permissionActionKinds,
  permissionDeniedReasonForDecision,
  permissionDeniedToolResultMessage,
  permissionEventSourceForDecision,
  permissionPrimaryActionKind,
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
  AgentPermissionMode,
  AgentReasoningLevel,
  AgentRuntimeSettings,
  AgentConversationListMeta,
  AgentMemoryEntryView,
  AgentSlashCommandView,
} from '../core/types';
import type { AgentMemoryToolRuntime } from './agentMemoryTool';
import { ASK_USER_QUESTION_TOOL_NAME, type AgentAskUserQuestionRuntime } from './agentAskUserQuestionTool';
import {
  normalizeRuntimeSettingPatch,
  readRuntimeSetting,
  type AgentSelfMaintenanceRuntime,
  type DoctorDiagnostic,
} from './agentSelfMaintenanceTools';
import { buildAgentRenderProjection, type AgentRenderActiveCompaction } from '../core/agentRenderProjection';
import { createAbortSettledStreamFn } from './agentStreamAbort';
import { awaitWithAbort, throwIfAborted } from './agentAwaitWithAbort';

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
}

interface AgentToolApprovalInput {
  toolCall: ToolCall;
  args: unknown;
  decision: AgentPermissionAskDecision;
}

interface AgentToolApprovalResolution {
  approved: boolean;
  deniedBy?: 'abort' | 'runtime' | 'user';
  scope?: AgentApprovalResolutionScope;
  conversationRule?: string;
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
  currentDebugQueryIndex: number;
  nextDebugQueryIndex: number;
  nextDebugTurnIndex: number;
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
  permissionConversationAllowRules: string[];
  unsubscribe: (() => void) | null;
}

type AgentEventInput = AgentRuntimeContextEventInput;
type AgentUserViewPanel = AgentUserViewContext['nodePanels'][number];
type AgentUserViewNode = NonNullable<AgentUserViewContext['focusedNode']>;
type AgentUserViewOutlineNode = AgentUserViewPanel['visibleOutline'][number];

export class AgentRuntime {
  private sessions = new Map<string, AgentSessionState>();
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
    suggestedConversationRule?: string;
    alwaysAllowRule?: string;
    resolve: (resolution: AgentToolApprovalResolution) => void;
  }>();
  private pendingUserQuestions = new Map<string, AgentPendingUserQuestion>();
  private nextSessionId = 1;
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
  }

  ready() {
    this.emit({ type: 'ready', conversationId: null, timestamp: Date.now() });
  }

  async restoreLatestConversation() {
    return this.restoreOrCreateDefaultDm();
  }

  async restoreConversation(conversationId: string) {
    const sessionId = sessionIdFromConversationId(conversationId);
    const eventState = await this.loadEventState(sessionId);
    if (!eventState.session) throw new Error(`Agent conversation not found: ${sessionId}`);
    const session = await this.createSessionWithEventState(eventState);
    return this.conversationResponse(sessionId, session);
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
    return this.conversationResponse(sessionId, session);
  }

  listConversations() {
    return this.listEventConversations();
  }

  async listMemory(options: { includeInvalidated?: boolean; limit?: number } = {}): Promise<AgentMemoryEntryView[]> {
    const entries = await this.getEventStore().listMemoryEntries(this.agentIdentity.agentId, {
      includeInvalidated: options.includeInvalidated,
      limit: options.limit ?? 200,
    });
    return entries.map(agentMemoryEntryToView);
  }

  async updateMemory(memoryId: string, fact: string): Promise<AgentMemoryEntryView | null> {
    const normalizedFact = fact.trim();
    if (!normalizedFact) throw new Error('Memory fact cannot be empty.');
    if (normalizedFact.length > MAX_AGENT_MEMORY_FACT_CHARS) {
      throw new Error(`Memory fact must be ${MAX_AGENT_MEMORY_FACT_CHARS} characters or fewer.`);
    }
    const entry = await this.getEventStore().updateMemoryEntry(this.agentIdentity.agentId, memoryId, { fact: normalizedFact });
    return entry ? agentMemoryEntryToView(entry) : null;
  }

  async forgetMemory(memoryId: string): Promise<AgentMemoryEntryView | null> {
    const entry = await this.getEventStore().removeMemoryEntry(this.agentIdentity.agentId, memoryId, 'user');
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

    const conversationRule = approved && scope === 'conversation' ? pending.suggestedConversationRule : undefined;
    if (conversationRule && !session.permissionConversationAllowRules.includes(conversationRule)) {
      session.permissionConversationAllowRules.push(conversationRule);
    }
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
        deniedBy: approved ? undefined : 'user',
        scope: resolvedScope,
        conversationRule,
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

  async listAllAgentDefinitions(conversationId: string) {
    const sessionId = sessionIdFromConversationId(conversationId);
    const session = this.sessions.get(sessionId);
    if (session) {
      return session.subagentRuntime.listAllAgentDefinitions();
    }
    const tempRuntime = new AgentSubagentRuntime({
      sessionId: 'temp-settings-list',
      localRoot: this.options.localFileRoot,
      host: {} as any,
    });
    return tempRuntime.listAllAgentDefinitions();
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
      session.skillRuntime.resetRunPermissionRules();
      this.beginDebugQuery(session);
      const userViewContextReminder = this.userViewContextReminderTracker.prepare(
        sessionId,
        normalizeAgentUserViewContext(userViewContextInput),
      );
      const userViewReminderText = userViewContextReminder.reminder;
      const now = new Date();
      const outlinerContext = buildOutlinerContextReminder(this.outlinerToolHost);
      const memoryReminder = await this.buildMemoryReminder(messageText, session);
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
      memoryReminder: await this.buildMemoryReminder(text, session),
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
      pending.resolve({ approved: false, deniedBy: 'runtime' });
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
          conversationAllowRules: current?.permissionConversationAllowRules ?? [],
          globalPermissions,
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
          memory: this.createMemoryToolRuntime(() => sessionId, () => sessionRef.current),
          pastChats: {
            service: this.getPastChatsService(),
            currentConversationId: () => sessionId,
          },
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
          conversationAllowRules: () => sessionRef.current?.permissionConversationAllowRules ?? [],
          approvalHandler: (input, signal) => {
            const current = sessionRef.current;
            if (!current) return Promise.resolve({ approved: false, deniedBy: 'runtime' });
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
      currentDebugQueryIndex: 0,
      nextDebugQueryIndex: debugCounters.nextQueryIndex,
      nextDebugTurnIndex: debugCounters.nextTurnIndex,
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
      permissionConversationAllowRules: [],
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

  private async ensureSessionWithId(sessionId: string) {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    let eventState = await this.loadEventState(sessionId);
    if (!eventState.session) {
      eventState = createEmptyAgentEventReplayState();
      const isDefaultDm = this.isDefaultDmSessionId(sessionId);
      const title = isDefaultDm ? this.agentIdentity.displayName : 'Untitled';
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
      memory: this.createMemoryToolRuntime(() => session.eventState.session?.id ?? 'unknown', () => session),
      pastChats: {
        service: this.getPastChatsService(),
        currentConversationId: () => session.eventState.session?.id ?? null,
      },
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
      conversationAllowRules: () => parentSessionRef.current?.permissionConversationAllowRules ?? [],
      approvalHandler: (approvalInput, signal) => {
        const parentSession = parentSessionRef.current;
        if (!parentSession) return Promise.resolve({ approved: false, deniedBy: 'runtime' });
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

    await this.appendSessionEvents(sessionId, session, runningRuns.map((run): AgentEventInput => ({
      type: 'subagent_run.updated',
      actor: systemActor(),
      subagentRunId: run.id,
      status: 'failed',
      completedAt: Date.now(),
      error: 'Subagent was interrupted before session restore.',
      transcriptMessageCount: run.transcriptMessageCount,
    })));
  }

  private async readSubagentTranscriptPayload(
    sessionId: string,
    payload: AgentPayloadRef,
  ): Promise<AgentMessage[]> {
    try {
      const raw = await this.getEventStore().readPayload(sessionId, payload);
      const parsed = JSON.parse(raw.toString('utf8')) as unknown;
      if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.messages)) return [];
      return parsed.messages.filter(isRecordableRuntimeMessage).map((message) => JSON.parse(JSON.stringify(message)) as AgentMessage);
    } catch {
      return [];
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
    const transcriptEnvelope = {
      v: 1,
      runId: snapshot.id,
      messageCount: snapshot.transcriptMessages.length,
      messages: snapshot.transcriptMessages,
    };
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
            transcriptPayload: payload,
            transcriptMessageCount: snapshot.transcriptMessages.length,
          }
        : {
            type: 'subagent_run.started',
            actor,
            subagentRunId: snapshot.id,
            parentToolCallId: snapshot.parentToolCallId,
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
    session.pendingSubagentNotifications.push(formatSubagentNotification(snapshot));
    void this.flushSubagentNotifications(sessionId, session).catch((error) => {
      this.emitError(sessionId, error instanceof Error ? error.message : String(error));
    });
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
    session.agent.state.messages = await this.deriveRuntimePiMessages(sessionId, session.eventState) as never;
    this.emitProjection(sessionId, 'agent_idle');
    if (options.flushSubagentNotifications !== false) {
      await this.flushSubagentNotifications(sessionId, session);
    }
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
      isStreaming: session.agent.state.isStreaming,
      model: clone(session.agent.state.model) as unknown as Record<string, unknown>,
      thinkingLevel: session.agent.state.thinkingLevel,
      pendingToolCallIds: Array.from(session.agent.state.pendingToolCalls),
      // Run/provider failures render inline as a failed assistant message (see
      // appendAssistantCompleted). The top-level banner is reserved for transient
      // operational errors delivered via the `error` event.
      errorMessage: null,
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

  private createMemoryToolRuntime(
    getSessionId: () => string,
    getSession: () => AgentSessionState | null,
  ): AgentMemoryToolRuntime {
    return {
      list: async (options) => {
        const session = getSession();
        const result = await this.getEventStore().queryMemoryEntries(this.agentIdentity.agentId, {
          query: options.query,
          includeInvalidated: options.includeInvalidated,
          limit: options.limit,
          originWorkspace: this.memoryOriginWorkspaceFilter(session),
        });
        return {
          entries: result.entries,
          totalEntries: result.totalEntries,
        };
      },
      remember: (fact) => {
        const session = getSession();
        if (!session) throw new Error('Agent session is not ready.');
        if (this.memoryIsolation(session) === 'read-only-global') {
          throw new Error('Memory writes are disabled while agent.runtime.memoryIsolation is read-only-global.');
        }
        return this.getEventStore().addMemoryEntry(this.agentIdentity.agentId, {
          fact,
          originWorkspace: this.memoryOriginWorkspaceForSession(session),
          sources: this.memorySources(getSessionId(), session),
        });
      },
      update: async (memoryId, fact) => {
        const session = getSession();
        if (!session) throw new Error('Agent session is not ready.');
        await this.assertMemoryMutationAllowed(session, memoryId);
        return this.getEventStore().updateMemoryEntry(this.agentIdentity.agentId, memoryId, { fact });
      },
      forget: async (memoryId) => {
        const session = getSession();
        if (!session) throw new Error('Agent session is not ready.');
        await this.assertMemoryMutationAllowed(session, memoryId);
        return this.getEventStore().removeMemoryEntry(this.agentIdentity.agentId, memoryId, 'agent');
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

  private async buildMemoryReminder(query: string, session: AgentSessionState): Promise<string | null> {
    try {
      const relevant = await this.getEventStore().listMemoryEntries(this.agentIdentity.agentId, {
        query,
        limit: 8,
        originWorkspace: this.memoryOriginWorkspaceFilter(session),
      });
      const latest = await this.getEventStore().listMemoryEntries(this.agentIdentity.agentId, {
        limit: 8,
        originWorkspace: this.memoryOriginWorkspaceFilter(session),
      });
      const entries = uniqueMemoryEntries([...relevant, ...latest]).slice(0, 8);
      return formatMemoryReminder(entries);
    } catch (error) {
      console.warn(`Failed to build agent memory reminder: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private memoryIsolation(session: AgentSessionState): AgentRuntimeSettings['memoryIsolation'] {
    return session.runtimeSettings.memoryIsolation ?? 'global';
  }

  private memoryOriginWorkspaceFilter(session: AgentSessionState | null): string | undefined {
    if (!session || this.memoryIsolation(session) !== 'isolated') return undefined;
    return this.memoryOriginWorkspaceForSession(session);
  }

  private memorySources(sessionId: string, session: AgentSessionState): AgentMemorySource[] {
    const source: AgentMemorySource = { conversationId: conversationIdFromSessionId(sessionId) };
    const messageId = session.eventState.selectedLeafMessageId ?? session.eventState.latestMessageId;
    if (messageId) source.messageRange = [messageId, messageId];
    const runId = this.activeRunId(session);
    if (runId) source.runId = runId;
    if (session.eventState.latestEventId) source.eventId = session.eventState.latestEventId;
    return [source];
  }

  private memoryOriginWorkspaceForSession(session: AgentSessionState): string | undefined {
    if (this.memoryIsolation(session) === 'global') return this.memoryOriginWorkspace() ?? undefined;
    return this.memoryOriginWorkspace() ?? '__no_workspace__';
  }

  private async assertMemoryMutationAllowed(session: AgentSessionState, memoryId: string) {
    const isolation = this.memoryIsolation(session);
    if (isolation === 'read-only-global') {
      throw new Error('Memory writes are disabled while agent.runtime.memoryIsolation is read-only-global.');
    }
    if (isolation !== 'isolated') return;
    const entry = await this.getEventStore().getMemoryEntry(this.agentIdentity.agentId, memoryId);
    if (!entry) throw new Error(`Unknown memory entry: ${memoryId}`);
    const workspace = this.memoryOriginWorkspaceForSession(session);
    if (entry.originWorkspace !== workspace) {
      throw new Error('Cannot mutate memory outside the current isolated workspace.');
    }
  }

  private memoryOriginWorkspace(): string | undefined {
    const localRoot = this.options.localFileRoot?.trim();
    if (!localRoot) return undefined;
    return `workspace:${createHash('sha256').update(path.resolve(localRoot)).digest('hex').slice(0, 16)}`;
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

  private async listEventConversations(): Promise<AgentConversationListMeta[]> {
    return (await this.getEventStore().listConversationIndexEntries())
      .filter((entry) => !!entry.goal)
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
    inputs: readonly AgentEventInput[],
  ) {
    let events: AgentEvent[] = [];
    const writeEvents = async () => {
      events = this.buildEvents(session.eventState, sessionId, inputs);
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
    if (signal?.aborted) return { approved: false, deniedBy: 'abort' };

    const requestId = randomUUID();
    const request: AgentApprovalRequestView = {
      requestId,
      conversationId: conversationIdFromSessionId(sessionId),
      toolCallId: input.toolCall.id,
      toolName: input.toolCall.name,
      title: input.decision.request.title,
      target: input.decision.request.target,
      reason: input.decision.reason,
      details: input.decision.request.details,
      suggestedConversationRule: input.decision.request.suggestedConversationRule,
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
        resolve({ approved: false, deniedBy: 'abort' });
      };

      this.pendingApprovals.set(requestId, {
        sessionId,
        request,
        suggestedConversationRule: request.suggestedConversationRule,
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

  private async startRun(sessionId: string, session: AgentSessionState, prompt: UserMessage | null = null) {
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
      kind: 'turn',
      trigger: this.runTrigger(session),
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

function formatMemoryReminder(entries: readonly AgentMemoryEntry[]): string | null {
  const activeEntries = entries.filter((entry) => entry.status === 'active').slice(0, 8);
  if (activeEntries.length === 0) return null;
  return [
    '<agent-memory>',
    'Durable remembered facts for this agent. Use them as background context, and update or forget entries with the memory tool when the user corrects them.',
    ...activeEntries.map((entry) => (
      `- id=${escapeReminderText(entry.id)} fact="${escapeReminderText(entry.fact)}"`
    )),
    '</agent-memory>',
  ].join('\n');
}

function uniqueMemoryEntries(entries: readonly AgentMemoryEntry[]): AgentMemoryEntry[] {
  const seen = new Set<string>();
  const result: AgentMemoryEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(entry);
  }
  return result;
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
    agentId: entry.agentId,
    fact: entry.fact,
    originWorkspace: entry.originWorkspace,
    sources: entry.sources.map((source) => ({
      conversationId: source.conversationId,
      summaryId: source.summaryId,
      messageRange: source.messageRange,
      runId: source.runId,
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

function isRecordableRuntimeMessage(message: unknown): message is AgentMessage {
  return isUserMessage(message) || isAssistantMessage(message) || isToolResultMessage(message);
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
  switch (approval.deniedBy) {
    case 'user':
      return permissionDeniedToolResultMessage({
        toolName,
        reason: 'user',
        message: 'User denied permission. The requested tool call was not executed.',
      });
    case 'abort':
      return permissionDeniedToolResultMessage({
        toolName,
        reason: 'run_aborted',
        message: 'Permission request was cancelled before approval. The requested tool call was not executed.',
      });
    default:
      return permissionDeniedToolResultMessage({
        toolName,
        reason: 'runtime',
        message: 'Permission request was not approved. The requested tool call was not executed.',
      });
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
    memory?: AgentToolsOptions['memory'];
    pastChats?: AgentToolsOptions['pastChats'];
    askUserQuestion?: AgentToolsOptions['askUserQuestion'];
    selfMaintenance?: AgentToolsOptions['selfMaintenance'];
    localWorkspace?: AgentLocalWorkspaceContext;
    allowedTools?: string[];
    disallowedTools?: string[];
    preapprovedToolRules?: string[];
    conversationAllowRules?: () => readonly string[];
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
        memory: options.memory,
        pastChats: options.pastChats,
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
          conversationAllowRules: options.conversationAllowRules?.() ?? [],
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
            source: askResolution.reason === 'classifier_unavailable' ? 'classifier_unavailable' : 'classifier',
            resolved: {
              status: askResolution.reason === 'run_aborted' ? 'aborted' : 'denied',
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
          const approval = await options.approvalHandler({ toolCall, args, decision }, signal);
          await options.permissionEventHandler?.({
            requestId: permissionRequestId,
            toolCall,
            decision,
            outcome: approval.approved ? 'allow' : 'blocked',
            includeChecked: false,
            source: approval.approved ? 'user' : 'user',
            resolved: {
              status: approval.approved ? 'approved' : approval.deniedBy === 'abort' ? 'aborted' : 'denied',
              resolvedBy: approval.approved && approval.scope === 'always' ? 'allow_rule_update' : approval.deniedBy === 'abort' ? 'system_abort' : 'user_once',
              updatedRule: approval.alwaysAllowRule,
              deniedReason: approval.approved ? undefined : approval.deniedBy ?? 'user',
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

function formatSubagentNotification(snapshot: AgentSubagentRunSnapshot): string {
  const summary = snapshot.status === 'completed'
    ? `Subagent "${snapshot.description}" completed.`
    : snapshot.status === 'failed'
      ? `Subagent "${snapshot.description}" failed.`
      : `Subagent "${snapshot.description}" was stopped.`;
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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
