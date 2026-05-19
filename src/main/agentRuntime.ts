import { app, type BrowserWindow } from 'electron';
import { Agent, type AgentEvent as PiAgentEvent, type StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, getModels, streamSimple } from '@earendil-works/pi-ai';
import type { Api, AssistantMessage, ImageContent as PiImageContent, KnownProvider, Message, Model, TextContent as PiTextContent, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  type AgentFileAttachmentInput,
  LIN_AGENT_EVENT_CHANNEL,
  type AgentImageAttachmentInput,
  type AgentMessageAttachmentInput,
  type AgentDebugSnapshot,
  type AgentDebugTotals,
  type AgentMessage,
  type AgentRuntimeEvent,
  type ImageContent,
  type TextContent,
  type UserMessage,
} from '../core/agentTypes';
import {
  AGENT_EVENT_VERSION,
  appendAgentEventToReplayState,
  createEmptyAgentEventReplayState,
  getAgentEventActivePath,
  type AgentActor,
  type AgentEvent,
  type AgentEventMessageRecord,
  type AgentEventReplayState,
  type AgentEventType,
  type AgentPayloadRef,
  type AgentPersistedContent,
} from '../core/agentEventLog';
import { serializeAgentAttachmentMarker, serializeAgentTextAttachment, systemReminder } from '../core/agentAttachments';
import { toolEnvelopeAfterToolCall } from './agentToolEnvelope';
import { createAgentTools } from './agentTools';
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
} from './agentEventStore';
import { getActiveProviderRuntimeConfig, getProviderApiKey, type AgentProviderRuntimeConfig } from './agentSettings';
import type { OutlinerToolHost } from './agentNodeTools';
import type { AgentSessionMeta } from '../core/types';
import { buildAgentRenderProjection } from '../core/agentRenderProjection';

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
  name: 'Lin Provider Not Configured',
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
const MAX_IMAGE_ATTACHMENT_BASE64_CHARS = Math.floor(4.5 * 1024 * 1024);
const MAX_INLINE_TOOL_OUTPUT_CHARS = 8_000;
const TOOL_OUTPUT_PREVIEW_CHARS = 2_000;
const AGENT_ATTACHMENT_DIR = 'agent-attachments';
const SUPPORTED_INLINE_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

interface AgentSessionState {
  agent: Agent;
  eventState: AgentEventReplayState;
  activeRunId: string | null;
  activeAssistantMessageId: string | null;
  activeAssistantText: string;
  currentDebugQueryIndex: number;
  nextDebugQueryIndex: number;
  nextDebugTurnIndex: number;
  pendingEventAppend: Promise<void>;
  pendingProjectionLastEventType: string | null;
  pendingProjectionTimer: ReturnType<typeof setTimeout> | null;
  revision: number;
  toolCallMessageIds: Map<string, string>;
  unsubscribe: (() => void) | null;
}

type AgentEventInput = {
  type: AgentEventType;
  actor: AgentActor;
  createdAt?: number;
  [key: string]: unknown;
};

export class AgentRuntime {
  private sessions = new Map<string, AgentSessionState>();
  private debugProjectionCache = new Map<string, {
    history: AgentDebugSnapshot[];
    latestSeq: number;
    totals: AgentDebugTotals;
  }>();
  private eventStore: AgentEventStore | null = null;
  private nextSessionId = 1;

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly outlinerToolHost: OutlinerToolHost,
    private readonly options: { localFileRoot?: string; agentDataRoot?: string } = {},
  ) {}

  ready() {
    this.emit({ type: 'ready', sessionId: null, timestamp: Date.now() });
  }

  async restoreLatestSession() {
    const latest = (await this.listSessions())[0] ?? null;
    if (!latest) return this.createSession();
    return this.restoreSession(latest.id);
  }

  async restoreSession(sessionId: string) {
    const eventState = await this.loadEventState(sessionId);
    if (!eventState.session) throw new Error(`Agent session not found: ${sessionId}`);
    const session = await this.createSessionWithEventState(eventState);
    return this.sessionResponse(sessionId, session);
  }

  async createSession() {
    const sessionId = this.createSessionId();
    const eventState = createEmptyAgentEventReplayState();
    const created = this.buildEvents(eventState, sessionId, [{
      type: 'session.created',
      actor: systemActor(),
      title: 'Untitled',
    }]);
    await this.getEventStore().appendEvents(sessionId, created);
    for (const event of created) appendAgentEventToReplayState(eventState, event);
    const session = await this.createSessionWithEventState(eventState);
    return this.sessionResponse(sessionId, session);
  }

  listSessions() {
    return this.listEventSessions();
  }

  async debugSnapshot(sessionId: string) {
    const session = await this.ensureSessionWithId(sessionId);
    const projection = await this.deriveDebugProjection(sessionId);
    const snapshot = projection.history.at(-1) ?? this.getRuntimeDebugSnapshot(sessionId, session);
    return snapshot ? cloneDebug(snapshot) : null;
  }

  async debugHistory(sessionId: string) {
    await this.ensureSessionWithId(sessionId);
    return cloneDebug((await this.deriveDebugProjection(sessionId)).history);
  }

  async debugTotals(sessionId: string) {
    await this.ensureSessionWithId(sessionId);
    return cloneDebug((await this.deriveDebugProjection(sessionId)).totals);
  }

  async debugPayload(sessionId: string, payloadId: string) {
    const session = this.sessions.get(sessionId);
    const eventState = session?.eventState ?? await this.loadEventState(sessionId);
    const payload = eventState.payloads[payloadId];
    if (!payload || payload.role !== 'debug') return null;
    const bytes = await this.getEventStore().readPayload(sessionId, payload);
    return bytes.toString('utf8');
  }

  async payloadText(sessionId: string, payloadId: string) {
    const session = this.sessions.get(sessionId);
    const eventState = session?.eventState ?? await this.loadEventState(sessionId);
    const payload = eventState.payloads[payloadId];
    if (!payload || !isTextPayloadRole(payload.role) || !isTextPayloadMimeType(payload.mimeType)) return null;
    const bytes = await this.getEventStore().readPayload(sessionId, payload);
    return bytes.toString('utf8');
  }

  async renameSession(sessionId: string, title: string) {
    const normalized = title.trim() || 'Untitled';
    const session = this.sessions.get(sessionId);
    if (session) {
      await this.appendSessionEvents(sessionId, session, [{
        type: 'session.renamed',
        actor: systemActor(),
        title: normalized,
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
    }]);
    await this.getEventStore().appendEvents(sessionId, events);
    for (const event of events) appendAgentEventToReplayState(eventState, event);
    return eventStateToMeta(eventState);
  }

  async deleteSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.agent.abort();
      session.unsubscribe?.();
      clearPendingProjection(session);
      this.sessions.delete(sessionId);
      this.debugProjectionCache.delete(sessionId);
      this.emit({ type: 'closed', sessionId, timestamp: Date.now() });
    }
    await this.getEventStore().deleteSession(sessionId);
  }

  async sendMessage(sessionId: string, message: string, attachmentInput: unknown = []) {
    try {
      const session = await this.ensureSessionWithId(sessionId);
      const attachments = await this.materializeFileAttachments(normalizeAttachmentInputs(attachmentInput));
      if (!message.trim() && attachments.length === 0) return;
      if (session.agent.state.isStreaming) {
        if (attachments.length > 0) {
          throw new Error('Attachments cannot be queued while the agent is running.');
        }
        this.queueFollowUp(sessionId, message);
        return;
      }
      this.beginDebugQuery(session);
      const prompt = buildUserPromptMessage(message, attachments, {
        outlinerContext: buildOutlinerContextReminder(this.outlinerToolHost),
      });
      await this.appendUserPromptEvent(sessionId, session, prompt);
      await this.startRun(sessionId, session);
      await session.agent.prompt(prompt);
      await this.persistAndEmitIdle(sessionId, session);
    } catch (error) {
      this.emitError(sessionId, error instanceof Error ? error.message : String(error));
    }
  }

  async editMessage(sessionId: string, nodeId: string, message: string) {
    const trimmed = message.trim();
    if (!trimmed) return;
    try {
      const session = await this.ensureSessionWithId(sessionId);
      if (session.agent.state.isStreaming) throw new Error('Cannot edit while the agent is running.');
      const target = requireEventMessage(session.eventState, nodeId);
      if (target.role !== 'user') throw new Error('Only user messages can be edited');
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
      this.beginDebugQuery(session);
      await this.startRun(sessionId, session);
      await session.agent.continue();
      await this.persistAndEmitIdle(sessionId, session);
    } catch (error) {
      this.emitError(sessionId, error instanceof Error ? error.message : String(error));
    }
  }

  async regenerateMessage(sessionId: string, nodeId: string) {
    try {
      const session = await this.ensureSessionWithId(sessionId);
      if (session.agent.state.isStreaming) throw new Error('Cannot regenerate while the agent is running.');
      const targetId = findRegenerateTarget(session.eventState, nodeId);
      const parentId = requireEventMessage(session.eventState, targetId).parentMessageId;
      if (!parentId) throw new Error('Cannot regenerate without a parent message.');
      await this.appendSessionEvents(sessionId, session, [{
        type: 'branch.selected',
        actor: systemActor(),
        leafMessageId: parentId,
      }]);
      session.agent.state.messages = await this.deriveRuntimePiMessages(sessionId, session.eventState) as never;
      this.emitProjection(sessionId, 'message_regenerate_started');
      this.beginDebugQuery(session);
      await this.startRun(sessionId, session);
      await continueFromActivePath(session.agent);
      await this.persistAndEmitIdle(sessionId, session);
    } catch (error) {
      this.emitError(sessionId, error instanceof Error ? error.message : String(error));
    }
  }

  async retryMessage(sessionId: string, nodeId: string) {
    try {
      const session = await this.ensureSessionWithId(sessionId);
      if (session.agent.state.isStreaming) throw new Error('Cannot retry while the agent is running.');
      const parentId = requireEventMessage(session.eventState, nodeId).parentMessageId;
      if (!parentId) throw new Error('Cannot retry without a parent message.');
      await this.appendSessionEvents(sessionId, session, [{
        type: 'branch.selected',
        actor: systemActor(),
        leafMessageId: parentId,
      }]);
      session.agent.state.messages = await this.deriveRuntimePiMessages(sessionId, session.eventState) as never;
      this.emitProjection(sessionId, 'message_retry_started');
      this.beginDebugQuery(session);
      await this.startRun(sessionId, session);
      await continueFromActivePath(session.agent);
      await this.persistAndEmitIdle(sessionId, session);
    } catch (error) {
      this.emitError(sessionId, error instanceof Error ? error.message : String(error));
    }
  }

  async switchBranch(sessionId: string, nodeId: string) {
    try {
      const session = await this.ensureSessionWithId(sessionId);
      if (session.agent.state.isStreaming) throw new Error('Cannot switch branches while the agent is running.');
      const leafMessageId = findLatestEventLeaf(session.eventState, nodeId).id;
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

  queueFollowUp(sessionId: string, message: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.emitError(sessionId, `Unknown agent session: ${sessionId}`);
      return { queued: false };
    }
    const text = message.trim();
    if (!text) return { queued: false };
    session.agent.clearFollowUpQueue();
    session.agent.followUp({
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: Date.now(),
    });
    this.emitProjection(sessionId, 'follow_up_queued');
    return { queued: true };
  }

  clearFollowUp(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.agent.clearFollowUpQueue();
    this.emitProjection(sessionId, 'follow_up_cleared');
  }

  stopSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.agent.abort();
    this.emitProjection(sessionId, 'stop_requested');
  }

  resetSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.agent.reset();
    void (async () => {
      await this.getEventStore().deleteSession(sessionId);
      this.debugProjectionCache.delete(sessionId);
      const eventState = createEmptyAgentEventReplayState();
      const events = this.buildEvents(eventState, sessionId, [{
        type: 'session.created',
        actor: systemActor(),
        title: 'Untitled',
      }]);
      await this.getEventStore().appendEvents(sessionId, events);
      for (const event of events) appendAgentEventToReplayState(eventState, event);
      session.eventState = eventState;
      session.agent.state.messages = [];
      this.emitProjection(sessionId, 'session_reset');
    })().catch((error) => this.emitError(sessionId, error instanceof Error ? error.message : String(error)));
  }

  closeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.agent.abort();
    session.unsubscribe?.();
    clearPendingProjection(session);
    this.sessions.delete(sessionId);
    this.emit({ type: 'closed', sessionId, timestamp: Date.now() });
  }

  private async createSessionWithEventState(eventState: AgentEventReplayState) {
    if (!eventState.session) throw new Error('Cannot create agent runtime without session.created');
    const sessionId = eventState.session.id;
    this.reserveSessionId(sessionId);
    const existing = this.sessions.get(sessionId);
    existing?.unsubscribe?.();
    existing?.agent.abort();
    if (existing) clearPendingProjection(existing);

    const providerConfig = await getActiveProviderRuntimeConfig();
    const activePath = await this.deriveRuntimePiMessages(sessionId, eventState);
    const agent = providerConfig
      ? createConfiguredAgent(sessionId, providerConfig, activePath, this.outlinerToolHost, this.options.localFileRoot, async (payload, model) => {
          try {
            await this.captureDebugPayload(sessionId, payload, model);
          } catch (error) {
            this.emitError(sessionId, error instanceof Error ? error.message : String(error));
          }
          return undefined;
        })
      : createConfigurationErrorAgent(sessionId, 'No enabled agent provider is configured.', activePath);

    const debugCounters = await this.loadDebugCounters(sessionId);
    const session: AgentSessionState = {
      agent,
      eventState,
      activeRunId: null,
      activeAssistantMessageId: null,
      activeAssistantText: '',
      currentDebugQueryIndex: 0,
      nextDebugQueryIndex: debugCounters.nextQueryIndex,
      nextDebugTurnIndex: debugCounters.nextTurnIndex,
      pendingEventAppend: Promise.resolve(),
      pendingProjectionLastEventType: null,
      pendingProjectionTimer: null,
      revision: 0,
      toolCallMessageIds: new Map(),
      unsubscribe: null,
    };

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
      const events = this.buildEvents(eventState, sessionId, [{
        type: 'session.created',
        actor: systemActor(),
        title: 'Untitled',
      }]);
      await this.getEventStore().appendEvents(sessionId, events);
      for (const event of events) appendAgentEventToReplayState(eventState, event);
    }
    await this.createSessionWithEventState(eventState);
    return this.sessions.get(sessionId)!;
  }

  private beginDebugQuery(session: AgentSessionState) {
    if (session.currentDebugQueryIndex > 0) return;
    session.currentDebugQueryIndex = session.nextDebugQueryIndex;
    session.nextDebugQueryIndex += 1;
  }

  private async captureDebugPayload(sessionId: string, payload: unknown, model: Model<any>) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.beginDebugQuery(session);
    const turnIndex = session.nextDebugTurnIndex;
    const debugId = `debug-${randomUUID()}`;
    const envelope = createAgentDebugPayloadEnvelope(payload);
    const payloadRef = await this.getEventStore().writePayload(sessionId, {
      id: `${debugId}-payload`,
      data: envelope.json,
      mimeType: 'application/json',
      role: 'debug',
      summary: `Provider payload round ${turnIndex}`,
    });
    await this.appendSessionEvents(sessionId, session, [{
      type: 'payload.created',
      actor: systemActor(),
      runId: session.activeRunId ?? undefined,
      payload: payloadRef,
    }, {
      type: 'debug.snapshot.created',
      actor: systemActor(),
      runId: session.activeRunId ?? undefined,
      debugId,
      source: 'provider_payload',
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

  private getRuntimeDebugSnapshot(sessionId: string, session: AgentSessionState) {
    const state = session.agent.state;
    return createRuntimeStateDebugSnapshot({
      messages: state.messages as AgentMessage[],
      model: state.model as Model<any>,
      queryIndex: 0,
      sessionId,
      sessionTitle: session.eventState.session?.title ?? null,
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
      sessionId,
      sessionTitle: this.sessions.get(sessionId)?.eventState.session?.title,
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

  private async persistAndEmitIdle(sessionId: string, session: AgentSessionState) {
    session.agent.state.messages = await this.deriveRuntimePiMessages(sessionId, session.eventState) as never;
    this.emitProjection(sessionId, 'agent_idle');
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

  private createMessageId(prefix: string) {
    return `${prefix}-${randomUUID()}`;
  }

  private sessionResponse(sessionId: string, session: AgentSessionState) {
    return {
      sessionId,
      renderProjection: this.renderProjection(session),
    };
  }

  private renderProjection(session: AgentSessionState) {
    return buildAgentRenderProjection(session.eventState, {
      revision: session.revision,
      activeRunId: session.activeRunId,
      isStreaming: session.agent.state.isStreaming,
      model: clone(session.agent.state.model) as unknown as Record<string, unknown>,
      thinkingLevel: session.agent.state.thinkingLevel,
      pendingToolCallIds: Array.from(session.agent.state.pendingToolCalls),
      errorMessage: session.agent.state.errorMessage ?? null,
    });
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
    this.emit({
      type: 'projection',
      sessionId,
      lastEventType,
      revision: session.revision,
      renderProjection,
      timestamp: Date.now(),
    });
  }

  private emitError(sessionId: string, message: string) {
    this.emit({
      type: 'error',
      sessionId,
      error: message,
      timestamp: Date.now(),
    });
  }

  private emit(payload: AgentRuntimeEvent) {
    this.getWindow()?.webContents.send(LIN_AGENT_EVENT_CHANNEL, payload);
  }

  private getEventStore() {
    this.eventStore ??= new AgentEventStore(this.options.agentDataRoot ?? path.join(app.getPath('userData'), 'agent'));
    return this.eventStore;
  }

  private async listEventSessions(): Promise<AgentSessionMeta[]> {
    return (await this.getEventStore().listSessionIndexEntries()).map((entry) => ({
      id: entry.id,
      title: entry.title,
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
    };
    const operation = session.pendingEventAppend.then(writeEvents, writeEvents);
    session.pendingEventAppend = operation.then(() => undefined, () => undefined);
    await operation;
    return events;
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

  private async startRun(sessionId: string, session: AgentSessionState) {
    const runId = randomUUID();
    session.activeRunId = runId;
    session.activeAssistantMessageId = null;
    session.activeAssistantText = '';
    session.toolCallMessageIds.clear();
    await this.appendSessionEvents(sessionId, session, [{
      type: 'run.started',
      actor: systemActor(),
      runId,
    }]);
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

    if (event.type === 'agent_end' && session.activeRunId) {
      const errorMessage = session.agent.state.errorMessage ?? null;
      await this.appendSessionEvents(sessionId, session, [{
        type: errorMessage ? 'run.failed' : 'run.completed',
        actor: systemActor(),
        runId: session.activeRunId,
        errorMessage: errorMessage ?? undefined,
      }]);
      session.activeRunId = null;
      session.activeAssistantMessageId = null;
      session.activeAssistantText = '';
      await this.getEventStore().maybeWriteCheckpoint(sessionId, session.eventState, { force: true });
    }
  }

  private async ensureAssistantStarted(sessionId: string, session: AgentSessionState, message: AssistantMessage) {
    if (session.activeAssistantMessageId) return;
    const messageId = this.createMessageId('assistant');
    session.activeAssistantMessageId = messageId;
    session.activeAssistantText = '';
    await this.appendSessionEvents(sessionId, session, [{
      type: 'assistant_message.started',
      actor: agentActor(),
      runId: session.activeRunId ?? randomUUID(),
      messageId,
      parentMessageId: session.eventState.selectedLeafMessageId,
      providerId: message.provider,
      modelId: message.model,
      apiId: message.api,
    }]);
  }

  private async appendAssistantDelta(sessionId: string, session: AgentSessionState, message: AssistantMessage) {
    const messageId = session.activeAssistantMessageId;
    if (!messageId) return;
    const nextText = assistantText(message);
    if (!nextText.startsWith(session.activeAssistantText) || nextText.length <= session.activeAssistantText.length) return;
    const delta = nextText.slice(session.activeAssistantText.length);
    session.activeAssistantText = nextText;
    await this.appendSessionEvents(sessionId, session, [{
      type: 'assistant_message.delta',
      actor: agentActor(),
      runId: session.activeRunId ?? undefined,
      messageId,
      delta: { type: 'text_delta', text: delta },
      providerChunkCount: 1,
      startedAt: Date.now(),
      endedAt: Date.now(),
    }]);
  }

  private async appendAssistantCompleted(sessionId: string, session: AgentSessionState, message: AssistantMessage) {
    const messageId = session.activeAssistantMessageId;
    if (!messageId) return;
    await this.appendSessionEvents(sessionId, session, [{
      type: 'assistant_message.completed',
      actor: agentActor(),
      runId: session.activeRunId ?? undefined,
      messageId,
      stopReason: message.stopReason,
      content: fromPiAssistantContent(message.content),
      usage: message.usage,
    }]);
    session.activeAssistantMessageId = null;
    session.activeAssistantText = '';
  }

  private async appendToolResultMessage(sessionId: string, session: AgentSessionState, message: ToolResultMessage) {
    const actor = toolActor(message.toolName, message.toolCallId);
    const persisted = await this.persistPiUserContent(sessionId, message.content, {
      imageSummary: `${message.toolName} image output`,
      textPayloadRole: 'tool_output',
      textSummary: `${message.toolName} output`,
      textPayloadIdPrefix: `tool-output-${message.toolCallId}`,
    });
    const outputRef = persisted.payloads.find((payload) => payload.role === 'tool_output') ?? persisted.payloads[0];
    await this.appendSessionEvents(sessionId, session, [
      ...persisted.payloads.map((payload): AgentEventInput => ({
        type: 'payload.created',
        actor,
        payload,
      })),
      {
        type: 'tool_result.created',
        actor,
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
    const assistantMessageId = session.activeAssistantMessageId;
    if (!assistantMessageId) return;
    const toolCalls = message.content.filter((part): part is ToolCall => part.type === 'toolCall');
    const inputs: AgentEventInput[] = [];
    for (const toolCall of toolCalls) {
      session.toolCallMessageIds.set(toolCall.id, assistantMessageId);
      inputs.push({
        type: 'tool_call.started',
        actor: agentActor(),
        runId: session.activeRunId ?? undefined,
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
    if (session.toolCallMessageIds.has(toolCallId)) return;
    const messageId = findLatestAssistantMessageId(session.eventState);
    if (!messageId) return;
    session.toolCallMessageIds.set(toolCallId, messageId);
    await this.appendSessionEvents(sessionId, session, [{
      type: 'tool_call.started',
      actor: toolActor(toolName, toolCallId),
      runId: session.activeRunId ?? undefined,
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
    const messageId = session.toolCallMessageIds.get(toolCallId) ?? findLatestAssistantMessageId(session.eventState);
    if (!messageId) return;
    await this.appendSessionEvents(sessionId, session, [{
      type: isError ? 'tool_call.failed' : 'tool_call.completed',
      actor: toolActor(toolName, toolCallId),
      runId: session.activeRunId ?? undefined,
      messageId,
      toolCallId,
      errorMessage: isError ? summarizeJson(result) : undefined,
    }]);
  }

  private async deriveRuntimePiMessages(
    sessionId: string,
    eventState: AgentEventReplayState,
  ): Promise<AgentMessage[]> {
    const messages: AgentMessage[] = [];
    for (const message of getAgentEventActivePath(eventState)) {
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
    },
  ): Promise<{ content: AgentPersistedContent; payload?: AgentPayloadRef }> {
    if (!options.textPayloadRole || text.length <= MAX_INLINE_TOOL_OUTPUT_CHARS) {
      return { content: { type: 'text', text } };
    }
    const payload = await this.getEventStore().writePayload(sessionId, {
      id: options.textPayloadId,
      data: text,
      mimeType: 'text/plain',
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

  private async materializeFileAttachments(attachments: AgentMessageAttachmentInput[]) {
    const root = this.localFileRoot();
    const out: AgentMessageAttachmentInput[] = [];
    for (const attachment of attachments) {
      if (attachment.kind !== 'file') {
        out.push(attachment);
        continue;
      }
      out.push(await materializeFileAttachment(root, attachment));
    }
    return out;
  }
}

function buildUserPromptMessage(
  message: string,
  attachments: AgentMessageAttachmentInput[],
  context: { outlinerContext?: string | null } = {},
): UserMessage {
  const trimmed = message.trim();
  const baseText = trimmed || defaultAttachmentPrompt(attachments);
  const content: (TextContent | ImageContent)[] = [];
  const reminders = buildTurnReminderBlocks(attachments, context);
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
    timestamp: Date.now(),
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
    return { id, kind: 'image', name, mimeType: normalizedMimeType, sizeBytes, dataBase64 };
  }

  if (kind === 'text') {
    const rawText = typeof record.text === 'string' ? record.text : '';
    const text = rawText.slice(0, MAX_TEXT_ATTACHMENT_CHARS);
    return {
      id,
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
    return { id, kind: 'file', name, mimeType, sizeBytes, path: filePath };
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
  context: { outlinerContext?: string | null },
): TextContent[] {
  const blocks: TextContent[] = [];
  const parts: string[] = [];
  if (context.outlinerContext) {
    parts.push(context.outlinerContext);
  }
  if (parts.length > 0) {
    blocks.push({ type: 'text', text: systemReminder(parts.join('\n\n')) });
  }

  const marker = serializeAgentAttachmentMarker(attachments);
  if (marker) {
    blocks.push({ type: 'text', text: systemReminder(marker) });
  }
  return blocks;
}

function buildOutlinerContextReminder(host: OutlinerToolHost): string | null {
  try {
    const projection = host.getProjection();
    const today = projection.nodes.find((node) => node.id === projection.todayId);
    return [
      'Current Lin outliner context:',
      `- Today node id: ${projection.todayId}${today ? ` (${today.content.text})` : ''}`,
      '- node_create without parent_id creates under today.',
      '- Use node_read/node_search when you need exact node ids or current content.',
    ].join('\n');
  } catch {
    return null;
  }
}

async function materializeFileAttachment(localRoot: string, attachment: AgentFileAttachmentInput): Promise<AgentFileAttachmentInput> {
  const sourcePath = path.resolve(attachment.path);
  if (isPathInside(localRoot, sourcePath)) return { ...attachment, path: sourcePath };

  await stat(sourcePath);
  const attachmentDir = path.join(localRoot, 'tmp', AGENT_ATTACHMENT_DIR);
  await mkdir(attachmentDir, { recursive: true });
  const targetPath = path.join(attachmentDir, `${randomUUID()}-${safeAttachmentFileName(attachment.name)}`);
  await copyFile(sourcePath, targetPath);
  return { ...attachment, path: targetPath };
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeAttachmentFileName(name: string): string {
  const base = path.basename(name).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
  return base || 'attachment';
}

function stringOrFallback(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
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

function eventStateToMeta(eventState: AgentEventReplayState): AgentSessionMeta | null {
  if (!eventState.session) return null;
  return {
    id: eventState.session.id,
    title: eventState.session.title,
    createdAt: eventState.session.createdAt,
    updatedAt: eventState.session.updatedAt,
    messageCount: Object.keys(eventState.messages).length,
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
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 30) : null;
}

function summarizeToolResult(message: ToolResultMessage): string {
  const text = piUserText(message.content).replace(/\s+/g, ' ').trim();
  if (text) return text.length > 500 ? `${text.slice(0, 500).trim()}...` : text;
  return summarizeJson(message.content);
}

function summarizeTextPayload(text: string, prefix: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const preview = normalized.length > 240 ? `${normalized.slice(0, 240).trim()}...` : normalized;
  return preview ? `${prefix}: ${preview}` : prefix;
}

function buildPersistedToolOutputMessage(payload: AgentPayloadRef, text: string): string {
  const preview = text.slice(0, TOOL_OUTPUT_PREVIEW_CHARS);
  const clipped = text.length > preview.length;
  return [
    '<persisted-output>',
    `Output too large (${formatByteSize(payload.byteLength)}). Full output saved as payload: ${payload.id}`,
    '',
    `Preview (first ${TOOL_OUTPUT_PREVIEW_CHARS} chars):`,
    clipped ? `${preview}\n...` : preview,
    '</persisted-output>',
  ].join('\n');
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isTextPayloadMimeType(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase();
  return normalized.startsWith('text/') || normalized === 'application/json';
}

function isTextPayloadRole(role: AgentPayloadRef['role']): boolean {
  return role === 'tool_output' || role === 'text_extract' || role === 'preview';
}

function summarizeJson(value: unknown): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 500 ? `${text.slice(0, 500)}...` : text;
  } catch {
    return String(value);
  }
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

function systemActor(): AgentActor {
  return { type: 'system' };
}

function userActor(): AgentActor {
  return { type: 'user', userId: 'local-user' };
}

function agentActor(): AgentActor {
  return { type: 'agent', agentId: 'pi-mono' };
}

function toolActor(toolName: string, toolCallId: string): AgentActor {
  return { type: 'tool', toolName, toolCallId };
}

function canContinueFromMessage(message: AgentMessage | undefined): boolean {
  return message?.role === 'user' || message?.role === 'toolResult';
}

async function continueFromActivePath(agent: Agent) {
  if (!canContinueFromMessage(agent.state.messages.at(-1) as AgentMessage | undefined)) {
    throw new Error('Cannot continue without a trailing user or tool result message.');
  }
  await agent.continue();
}

function createConfiguredAgent(
  sessionId: string,
  providerConfig: AgentProviderRuntimeConfig,
  messages: AgentMessage[] = [],
  outlinerToolHost: OutlinerToolHost,
  localFileRoot?: string,
  onPayload?: (payload: unknown, model: Model<any>) => unknown | undefined | Promise<unknown | undefined>,
) {
  const model = resolveModel(providerConfig);
  return new Agent({
    initialState: {
      systemPrompt: LIN_AGENT_SYSTEM_PROMPT,
      model,
      thinkingLevel: providerConfig.reasoningLevel,
      tools: createAgentTools(outlinerToolHost, { localFileRoot }),
      messages,
    },
    streamFn: streamSimple as StreamFn,
    onPayload: async (payload, payloadModel) => onPayload?.(payload, payloadModel),
    getApiKey: async (provider) => {
      if (provider === providerConfig.providerId) {
        return providerConfig.apiKey ?? getProviderApiKey(provider);
      }
      return getProviderApiKey(provider);
    },
    afterToolCall: async ({ result, isError }) => toolEnvelopeAfterToolCall(result.details, isError),
    sessionId,
  });
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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
