import type { BrowserWindow } from 'electron';
import { Agent, type StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, getModels, streamSimple } from '@earendil-works/pi-ai';
import type { Api, AssistantMessage, KnownProvider, Model } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import {
  LIN_AGENT_EVENT_CHANNEL,
  type AgentImageAttachmentInput,
  type AgentMessageAttachmentInput,
  type AgentConversationMessage,
  type AgentConversationSnapshotEntry,
  type AgentDebugSnapshot,
  type AgentDebugTotals,
  type AgentMessage,
  type AgentRuntimeEvent,
  type AgentSnapshotState,
  type ImageContent,
  type TextContent,
  type UserMessage,
} from '../core/agentTypes';
import { serializeAgentTextAttachment } from '../core/agentAttachments';
import {
  createAgentChatSession,
  deriveAgentChatTitle,
  editAgentChatUserMessage,
  getAgentChatBranches,
  getAgentChatLinearPath,
  getAgentChatMessages,
  getAgentChatNode,
  regenerateAgentChatMessage,
  switchAgentChatBranch,
  syncAgentMessagesToChatTree,
  type AgentChatSession,
} from '../core/agentChatTree';
import { createAgentTools, toolEnvelopeAfterToolCall } from './agentTools';
import {
  addUsageToDebugTotals,
  cloneDebug,
  createAgentDebugSnapshot,
  createEmptyDebugTotals,
  createRuntimeStateDebugSnapshot,
  patchDebugSnapshotWithAssistant,
  sweepRunningDebugSnapshots,
} from './agentDebug';
import {
  deleteChatSession,
  getChatSession,
  getLatestChatSession,
  listChatSessions,
  renameChatSession,
  saveChatSession,
} from './agentChatStore';
import { getActiveProviderRuntimeConfig, getProviderApiKey, type AgentProviderRuntimeConfig } from './agentSettings';
import type { OutlinerToolHost } from './agentNodeTools';

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
const MAX_IMAGE_ATTACHMENT_BASE64_CHARS = 18 * 1024 * 1024;

interface AgentSessionState {
  agent: Agent;
  chatSession: AgentChatSession;
  currentDebugQueryIndex: number;
  debugHistory: AgentDebugSnapshot[];
  debugTotals: AgentDebugTotals;
  nextDebugQueryIndex: number;
  nextDebugTurnIndex: number;
  revision: number;
  unsubscribe: (() => void) | null;
}

export class AgentRuntime {
  private sessions = new Map<string, AgentSessionState>();
  private nextSessionId = 1;

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly outlinerToolHost: OutlinerToolHost,
  ) {}

  ready() {
    this.emit({ type: 'ready', sessionId: null, timestamp: Date.now() });
  }

  async restoreLatestSession() {
    const chatSession = await getLatestChatSession() ?? createAgentChatSession(this.createSessionId());
    const session = await this.createSessionWithChatSession(chatSession);
    return this.sessionResponse(chatSession.id, session);
  }

  async restoreSession(sessionId: string) {
    const chatSession = await getChatSession(sessionId);
    if (!chatSession) throw new Error(`Agent chat session not found: ${sessionId}`);
    const session = await this.createSessionWithChatSession(chatSession);
    return this.sessionResponse(sessionId, session);
  }

  async createSession() {
    const chatSession = createAgentChatSession(this.createSessionId());
    const session = await this.createSessionWithChatSession(chatSession);
    await saveChatSession(chatSession);
    return this.sessionResponse(chatSession.id, session);
  }

  listSessions() {
    return listChatSessions();
  }

  async debugSnapshot(sessionId: string) {
    const session = await this.ensureSessionWithId(sessionId);
    const snapshot = this.getLatestDebugSnapshot(sessionId, session);
    return snapshot ? cloneDebug(snapshot) : null;
  }

  async debugHistory(sessionId: string) {
    const session = await this.ensureSessionWithId(sessionId);
    return cloneDebug(session.debugHistory);
  }

  async debugTotals(sessionId: string) {
    const session = await this.ensureSessionWithId(sessionId);
    return cloneDebug(session.debugTotals);
  }

  async renameSession(sessionId: string, title: string) {
    const normalized = title.trim() || 'Untitled';
    const session = this.sessions.get(sessionId);
    if (session) {
      session.chatSession.title = normalized;
      await saveChatSession(session.chatSession);
      this.emitSnapshot(sessionId, 'session_renamed');
    }
    return renameChatSession(sessionId, normalized);
  }

  async deleteSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.agent.abort();
      session.unsubscribe?.();
      this.sessions.delete(sessionId);
      this.emit({ type: 'closed', sessionId, timestamp: Date.now() });
    }
    await deleteChatSession(sessionId);
  }

  async sendMessage(sessionId: string, message: string, attachmentInput: unknown = []) {
    try {
      const session = await this.ensureSessionWithId(sessionId);
      const attachments = normalizeAttachmentInputs(attachmentInput);
      if (!message.trim() && attachments.length === 0) return;
      if (session.agent.state.isStreaming) {
        if (attachments.length > 0) {
          throw new Error('Attachments cannot be queued while the agent is running.');
        }
        this.queueFollowUp(sessionId, message);
        return;
      }
      this.beginDebugQuery(session);
      await session.agent.prompt(buildUserPromptMessage(message, attachments));
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
      editAgentChatUserMessage(session.chatSession, nodeId, textContent(trimmed));
      session.agent.state.messages = getAgentChatMessages(session.chatSession) as never;
      await saveChatSession(session.chatSession);
      this.emitSnapshot(sessionId, 'message_edited');
      this.beginDebugQuery(session);
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
      const targetId = findRegenerateTarget(session.chatSession, nodeId);
      regenerateAgentChatMessage(session.chatSession, targetId);
      session.agent.state.messages = getAgentChatMessages(session.chatSession) as never;
      await saveChatSession(session.chatSession);
      this.emitSnapshot(sessionId, 'message_regenerate_started');
      this.beginDebugQuery(session);
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
      regenerateAgentChatMessage(session.chatSession, nodeId);
      session.agent.state.messages = getAgentChatMessages(session.chatSession) as never;
      await saveChatSession(session.chatSession);
      this.emitSnapshot(sessionId, 'message_retry_started');
      this.beginDebugQuery(session);
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
      switchAgentChatBranch(session.chatSession, nodeId);
      session.agent.state.messages = getAgentChatMessages(session.chatSession) as never;
      await saveChatSession(session.chatSession);
      this.emitSnapshot(sessionId, 'branch_switched');
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
    this.emitSnapshot(sessionId, 'follow_up_queued');
    return { queued: true };
  }

  clearFollowUp(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.agent.clearFollowUpQueue();
    this.emitSnapshot(sessionId, 'follow_up_cleared');
  }

  stopSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.agent.abort();
    this.emitSnapshot(sessionId, 'stop_requested');
  }

  resetSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.agent.reset();
    const nextChatSession = createAgentChatSession(sessionId);
    session.chatSession = nextChatSession;
    void saveChatSession(nextChatSession);
    this.emitSnapshot(sessionId, 'session_reset');
  }

  closeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.agent.abort();
    session.unsubscribe?.();
    this.sessions.delete(sessionId);
    this.emit({ type: 'closed', sessionId, timestamp: Date.now() });
  }

  private async createSessionWithChatSession(chatSession: AgentChatSession) {
    const sessionId = chatSession.id;
    this.reserveSessionId(sessionId);
    const existing = this.sessions.get(sessionId);
    existing?.unsubscribe?.();
    existing?.agent.abort();

    const providerConfig = await getActiveProviderRuntimeConfig();
    const activePath = getAgentChatMessages(chatSession);
    const agent = providerConfig
      ? createConfiguredAgent(sessionId, providerConfig, activePath, this.outlinerToolHost, (payload, model) => {
          this.captureDebugPayload(sessionId, payload, model);
        })
      : createConfigurationErrorAgent(sessionId, 'No enabled agent provider is configured.', activePath);

    const session: AgentSessionState = {
      agent,
      chatSession,
      currentDebugQueryIndex: 0,
      debugHistory: [],
      debugTotals: createEmptyDebugTotals(),
      nextDebugQueryIndex: 1,
      nextDebugTurnIndex: 1,
      revision: 0,
      unsubscribe: null,
    };

    session.unsubscribe = agent.subscribe((event) => {
      if (event.type === 'turn_end') {
        this.patchLatestDebugSnapshot(session, (event as { message?: unknown }).message);
      }
      if (event.type === 'message_end' || event.type === 'turn_end' || event.type === 'agent_end') {
        this.syncSessionFromAgent(session);
        void saveChatSession(session.chatSession);
      }
      if (event.type === 'agent_end') {
        sweepRunningDebugSnapshots(session.debugHistory);
        session.currentDebugQueryIndex = 0;
      }
      this.emitSnapshot(sessionId, event.type);
    });
    this.sessions.set(sessionId, session);
    this.emitSnapshot(sessionId, 'session_created');
    return session;
  }

  private async ensureSessionWithId(sessionId: string) {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const chatSession = await getLatestChatSessionByIdOrFresh(sessionId);
    await this.createSessionWithChatSession(chatSession);
    return this.sessions.get(sessionId)!;
  }

  private syncSessionFromAgent(session: AgentSessionState) {
    syncAgentMessagesToChatTree(session.chatSession, session.agent.state.messages as AgentMessage[]);
    if (session.chatSession.title === null || session.chatSession.title === 'Untitled') {
      session.chatSession.title = deriveAgentChatTitle(getAgentChatMessages(session.chatSession));
    }
  }

  private beginDebugQuery(session: AgentSessionState) {
    if (session.currentDebugQueryIndex > 0) return;
    session.currentDebugQueryIndex = session.nextDebugQueryIndex;
    session.nextDebugQueryIndex += 1;
    session.debugTotals.queries += 1;
  }

  private captureDebugPayload(sessionId: string, payload: unknown, model: Model<any>) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.beginDebugQuery(session);
    const snapshot = createAgentDebugSnapshot({
      payload,
      model,
      queryIndex: session.currentDebugQueryIndex,
      sessionId,
      sessionTitle: session.chatSession.title,
      source: 'provider_payload',
      turnIndex: session.nextDebugTurnIndex,
    });
    session.nextDebugTurnIndex += 1;
    session.debugTotals.rounds += 1;
    session.debugHistory.push(snapshot);
    if (session.debugHistory.length > 20) {
      session.debugHistory.splice(0, session.debugHistory.length - 20);
    }
  }

  private patchLatestDebugSnapshot(session: AgentSessionState, message: unknown) {
    const snapshot = session.debugHistory.at(-1);
    if (!snapshot || !isAssistantMessage(message)) return;
    const usage = patchDebugSnapshotWithAssistant(snapshot, message);
    if (usage) addUsageToDebugTotals(session.debugTotals, usage);
    for (let index = 0; index < session.debugHistory.length - 1; index += 1) {
      const item = session.debugHistory[index]!;
      if (item.status === 'running') item.status = 'completed';
    }
  }

  private getLatestDebugSnapshot(sessionId: string, session: AgentSessionState) {
    const captured = session.debugHistory.at(-1);
    if (captured) return captured;
    const state = session.agent.state;
    return createRuntimeStateDebugSnapshot({
      messages: state.messages as AgentMessage[],
      model: state.model as Model<any>,
      queryIndex: 0,
      sessionId,
      sessionTitle: session.chatSession.title,
      systemPrompt: state.systemPrompt,
      thinkingLevel: state.thinkingLevel,
      tools: state.tools,
    });
  }

  private async persistAndEmitIdle(sessionId: string, session: AgentSessionState) {
    this.syncSessionFromAgent(session);
    await saveChatSession(session.chatSession);
    this.emitSnapshot(sessionId, 'agent_idle');
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

  private sessionResponse(sessionId: string, session: AgentSessionState) {
    return {
      sessionId,
      state: this.snapshotState(session),
    };
  }

  private snapshotState(session: AgentSessionState): AgentSnapshotState {
    const state = session.agent.state;
    return {
      sessionTitle: session.chatSession.title,
      systemPrompt: state.systemPrompt,
      model: clone(state.model) as unknown as Record<string, unknown>,
      thinkingLevel: state.thinkingLevel,
      messages: state.messages.map(clone),
      conversation: buildConversationSnapshot(session.chatSession).map(clone),
      streamingMessage: state.streamingMessage ? clone(state.streamingMessage) : null,
      isStreaming: state.isStreaming,
      pendingToolCallIds: Array.from(state.pendingToolCalls),
      errorMessage: state.errorMessage ?? null,
    };
  }

  private emitSnapshot(sessionId: string, lastEventType: string | null = null) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.revision += 1;
    this.emit({
      type: 'snapshot',
      sessionId,
      lastEventType,
      revision: session.revision,
      state: this.snapshotState(session),
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
}

async function getLatestChatSessionByIdOrFresh(sessionId: string) {
  return await getChatSession(sessionId) ?? createAgentChatSession(sessionId);
}

function textContent(text: string): TextContent[] {
  return [{ type: 'text', text }];
}

function buildUserPromptMessage(message: string, attachments: AgentMessageAttachmentInput[]): UserMessage {
  const trimmed = message.trim();
  const baseText = trimmed || defaultAttachmentPrompt(attachments);
  const content: (TextContent | ImageContent)[] = [{ type: 'text', text: baseText }];

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
  if (hasText && hasImage) return 'Please review the attached files and images.';
  if (hasText) return 'Please review the attached files.';
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
    const dataBase64 = typeof record.dataBase64 === 'string'
      ? record.dataBase64.slice(0, MAX_IMAGE_ATTACHMENT_BASE64_CHARS)
      : '';
    if (!dataBase64) return null;
    return { id, kind: 'image', name, mimeType, sizeBytes, dataBase64 };
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

  return null;
}

function stringOrFallback(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function isConversationMessage(message: AgentMessage | null | undefined): message is AgentConversationMessage {
  return message?.role === 'user' || message?.role === 'assistant';
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return Boolean(message && typeof message === 'object' && (message as { role?: unknown }).role === 'assistant');
}

function buildConversationSnapshot(session: AgentChatSession): AgentConversationSnapshotEntry[] {
  return getAgentChatLinearPath(session)
    .filter((node) => isConversationMessage(node.message))
    .map((node) => {
      const branchIds = getAgentChatBranches(session, node.id);
      const currentIndex = branchIds.indexOf(node.id);
      return {
        nodeId: node.id,
        message: node.message as AgentConversationMessage,
        branches: branchIds.length > 1 && currentIndex >= 0
          ? { ids: branchIds, currentIndex }
          : null,
      };
    });
}

function findRegenerateTarget(session: AgentChatSession, nodeId: string) {
  let regenerateTarget = nodeId;
  let cursor: string | null = nodeId;
  while (cursor) {
    const parentId: string | null = getAgentChatNode(session, cursor)?.parentId ?? null;
    if (!parentId) break;
    const parent = getAgentChatNode(session, parentId);
    if (!parent?.message) break;
    if (parent.message.role === 'assistant') {
      regenerateTarget = parentId;
      cursor = parentId;
      continue;
    }
    if (parent.message.role === 'toolResult') {
      cursor = parentId;
      continue;
    }
    break;
  }
  return regenerateTarget;
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
  onPayload?: (payload: unknown, model: Model<any>) => void,
) {
  const model = resolveModel(providerConfig);
  return new Agent({
    initialState: {
      systemPrompt: [
        'You are Lin Outliner local agent.',
        'Use concise, concrete responses. When document tools become available, prefer structured edits over broad text rewrites.',
      ].join('\n'),
      model,
      thinkingLevel: providerConfig.reasoningLevel,
      tools: createAgentTools(outlinerToolHost),
      messages,
    },
    streamFn: streamSimple as StreamFn,
    onPayload: (payload, payloadModel) => {
      onPayload?.(payload, payloadModel);
      return undefined;
    },
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
      systemPrompt: 'You are Lin Outliner local agent.',
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
