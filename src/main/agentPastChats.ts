import {
  getAgentEventVisibleTranscript,
  type AgentEventMessageRecord,
  type AgentMemorySource,
  type AgentPersistedContent,
  type AgentPayloadRef,
} from '../core/agentEventLog';
import type { AgentMessage } from '../core/agentTypes';
import {
  analyzeTextSearchQuery,
  normalizeSearchText,
  textSearchTextMatchesQuery,
  type TextSearchQueryAnalysis,
} from '../core/textSearchAnalyzer';
import type {
  AgentEventSearchIndexEntry,
  AgentConversationIndexEntry,
  AgentEventStore,
} from './agentEventStore';

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 20;
const SEARCH_SNIPPET_CHARS = 200;
const DEFAULT_RECENT_LIMIT = 20;
const MAX_RECENT_LIMIT = 50;
const DEFAULT_RECENT_MESSAGE_CHARS = 360;
const MAX_RECENT_MESSAGE_CHARS = 1_200;
const DEFAULT_BEFORE_CONTEXT = 1;
const MAX_BEFORE_CONTEXT = 5;
const DEFAULT_AFTER_CONTEXT = 4;
const MAX_AFTER_CONTEXT = 20;
const DEFAULT_READ_CHARS = 2_000;
const MAX_READ_CHARS = 8_000;
const DEFAULT_EVIDENCE_CHARS = 1_600;
const MAX_QUERY_TERMS = 12;

export type PastChatsRole = 'user' | 'assistant' | 'toolResult';

export interface PastChatsSearchParams {
  query: string;
  after?: string;
  before?: string;
  conversationIds?: string[];
  limit?: number;
  includeCurrentConversation?: boolean;
}

export interface PastChatsReadParams {
  messageId: string;
  beforeContext?: number;
  afterContext?: number;
  maxChars?: number;
  includeCurrentConversation?: boolean;
}

export interface PastChatsEvidenceParams {
  source: AgentMemorySource;
  maxChars?: number;
}

export interface PastChatsRecentParams {
  after?: string;
  before?: string;
  conversationIds?: string[];
  limit?: number;
  maxMessageChars?: number;
  includeCurrentConversation?: boolean;
}

export interface PastChatsRequestContext {
  currentConversationId?: string | null;
}

export type PastChatsResult =
  | PastChatsRecentResult
  | PastChatsSearchResult
  | PastChatsReadResult
  | PastChatsErrorResult;

export type PastChatsEvidenceResult =
  | PastChatsEvidenceReadResult
  | PastChatsErrorResult;

export interface PastChatsRecentResult {
  mode: 'recent';
  items: PastChatsRecentItem[];
  totalItems: number;
  truncated: boolean;
}

export interface PastChatsRecentItem {
  messageId: string;
  conversationId: string;
  conversationTitle: string | null;
  createdAt: string;
  text: string;
  totalChars: number;
  textTruncated: boolean;
  hasAttachments: boolean;
}

export interface PastChatsSearchResult {
  mode: 'search';
  hits: PastChatsSearchHit[];
  totalHits: number;
  truncated: boolean;
}

export interface PastChatsSearchHit {
  messageId: string;
  conversationId: string;
  conversationTitle: string | null;
  role: PastChatsRole;
  createdAt: string;
  snippet: string;
}

export interface PastChatsReadResult {
  mode: 'read';
  conversation: { id: string; title: string | null; createdAt: string; updatedAt: string };
  anchorMessageId: string;
  messages: PastChatsReadMessage[];
  totalChars: number;
  outputTruncated: boolean;
}

export interface PastChatsEvidenceReadResult {
  mode: 'evidence';
  source: AgentMemorySource;
  conversation: { id: string; title: string | null; createdAt: string; updatedAt: string };
  messages: PastChatsReadMessage[];
  totalChars: number;
  outputTruncated: boolean;
}

export interface PastChatsReadMessage {
  messageId: string;
  role: PastChatsRole;
  createdAt: string;
  text: string;
  toolName?: string;
  isError?: boolean;
  messageTruncated?: boolean;
}

export type PastChatsErrorCode =
  | 'AMBIGUOUS_MODE'
  | 'MISSING_QUERY_OR_MESSAGE_ID'
  | 'CONVERSATION_NOT_FOUND'
  | 'NOT_ON_ACTIVE_BRANCH'
  | 'CONVERSATION_IS_CURRENT'
  | 'SOURCE_NOT_FOUND';

export interface PastChatsErrorResult {
  mode: 'error';
  code: PastChatsErrorCode;
  message: string;
  nearbyMessageIds?: string[];
}

interface VisibleSessionCacheEntry {
  latestEventId: string | null;
  messageIds: Set<string>;
  messageById: Map<string, AgentEventMessageRecord>;
  messages: AgentEventMessageRecord[];
  compactionMessageIds: Set<string>;
}

interface ConversationIndexedEntry {
  sessionId: string;
}

export class AgentPastChatsService {
  private readonly visibleSessionCache = new Map<string, VisibleSessionCacheEntry>();

  constructor(private readonly eventStore: AgentEventStore) {}

  async search(
    params: PastChatsSearchParams,
    context: PastChatsRequestContext = {},
  ): Promise<PastChatsResult> {
    const analysis = limitedQueryAnalysis(analyzeTextSearchQuery(params.query));
    if (analysis.terms.length === 0) {
      return pastChatsError('MISSING_QUERY_OR_MESSAGE_ID', 'Pass a non-empty query or message_id.');
    }

    const limit = clampInteger(params.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
    const conversationIds = stringSet(params.conversationIds);
    const after = parseDateFilter(params.after);
    const before = parseDateFilter(params.before);
    const conversations = await this.conversationMetaById();
    const currentConversationId = context.currentConversationId ?? null;
    const candidates = (await this.eventStore.listMessageIndexEntries())
      .filter((entry) => conversations.has(entryConversationId(entry)))
      .filter((entry) => !conversationIds || conversationIds.has(entryConversationId(entry)))
      .filter((entry) => params.includeCurrentConversation || entryConversationId(entry) !== currentConversationId)
      .filter((entry) => after === null || entry.createdAt >= after)
      .filter((entry) => before === null || entry.createdAt <= before)
      .filter((entry) => textSearchTextMatchesQuery(entry.normalizedText, analysis));

    const visibleHits: Array<{ entry: AgentEventSearchIndexEntry; match: PastChatTextMatch }> = [];
    for (const entry of candidates) {
      const visible = await this.visibleSessionMessages(entryConversationId(entry));
      if (!visible.messageIds.has(entry.messageId)) continue;
      const text = searchResultText(entry, visible.messageById.get(entry.messageId));
      const match = scorePastChatText(text, analysis);
      if (!match) continue;
      visibleHits.push({ entry, match });
    }

    visibleHits.sort((left, right) => {
      const leftConversation = conversations.get(entryConversationId(left.entry))?.updatedAt ?? left.entry.updatedAt;
      const rightConversation = conversations.get(entryConversationId(right.entry))?.updatedAt ?? right.entry.updatedAt;
      return right.match.score - left.match.score
        || rightConversation - leftConversation
        || right.entry.updatedAt - left.entry.updatedAt;
    });

    const selected = visibleHits.slice(0, limit);
    return {
      mode: 'search',
      hits: selected.map(({ entry, match }) => ({
        messageId: entry.messageId,
        ...conversationFieldsForEntry(entry, conversations),
        role: entry.role,
        createdAt: isoTime(entry.createdAt),
        snippet: match.snippet,
      })),
      totalHits: visibleHits.length,
      truncated: visibleHits.length > selected.length,
    };
  }

  async recent(
    params: PastChatsRecentParams = {},
    context: PastChatsRequestContext = {},
  ): Promise<PastChatsResult> {
    const limit = clampInteger(params.limit, DEFAULT_RECENT_LIMIT, 1, MAX_RECENT_LIMIT);
    const maxMessageChars = clampInteger(
      params.maxMessageChars,
      DEFAULT_RECENT_MESSAGE_CHARS,
      1,
      MAX_RECENT_MESSAGE_CHARS,
    );
    const conversationIds = stringSet(params.conversationIds);
    const after = parseDateFilter(params.after);
    const before = parseDateFilter(params.before);
    const conversations = await this.conversationMetaById();
    const currentConversationId = context.currentConversationId ?? null;
    const candidates = (await this.eventStore.listUserMessageIndexEntries())
      .filter((entry) => conversations.has(entryConversationId(entry)))
      .filter((entry) => !conversationIds || conversationIds.has(entryConversationId(entry)))
      .filter((entry) => params.includeCurrentConversation || entryConversationId(entry) !== currentConversationId)
      .filter((entry) => after === null || entry.createdAt >= after)
      .filter((entry) => before === null || entry.createdAt <= before);

    const items: Array<PastChatsRecentItem & { sortAt: number }> = [];
    for (const entry of candidates) {
      const visible = await this.visibleSessionMessages(entryConversationId(entry));
      if (!visible.messageIds.has(entry.messageId)) continue;
      if (visible.compactionMessageIds.has(entry.messageId)) continue;
      const message = visible.messageById.get(entry.messageId);
      if (!message || message.role !== 'user') continue;
      const text = cleanUserMessageText(contentText(message.content));
      if (!text) continue;
      items.push({
        messageId: entry.messageId,
        ...conversationFieldsForEntry(entry, conversations),
        createdAt: isoTime(entry.createdAt),
        text: truncateForDisplay(text, maxMessageChars),
        totalChars: text.length,
        textTruncated: text.length > maxMessageChars,
        hasAttachments: entry.hasAttachments,
        sortAt: entry.createdAt,
      });
    }

    items.sort((left, right) => right.sortAt - left.sortAt);
    const selected = items.slice(0, limit);
    return {
      mode: 'recent',
      items: selected.map(({ sortAt: _sortAt, ...item }) => item),
      totalItems: items.length,
      truncated: items.length > selected.length,
    };
  }

  async read(
    params: PastChatsReadParams,
    context: PastChatsRequestContext = {},
  ): Promise<PastChatsResult> {
    const messageId = params.messageId.trim();
    if (!messageId) {
      return pastChatsError('MISSING_QUERY_OR_MESSAGE_ID', 'Pass a non-empty query or message_id.');
    }

    const indexEntry = await this.eventStore.findMessageIndexEntry(messageId);
    if (!indexEntry) {
      return pastChatsError('CONVERSATION_NOT_FOUND', `No visible conversation was found for message ${messageId}.`);
    }

    const currentConversationId = context.currentConversationId ?? null;
    if (!params.includeCurrentConversation && entryConversationId(indexEntry) === currentConversationId) {
      return pastChatsError('CONVERSATION_IS_CURRENT', 'That message is in the current conversation. Use current context unless the conversation was compacted.');
    }

    const conversations = await this.conversationMetaById();
    const conversation = conversations.get(entryConversationId(indexEntry));
    if (!conversation) {
      return pastChatsError('CONVERSATION_NOT_FOUND', `No visible conversation was found for message ${messageId}.`);
    }

    const visible = await this.visibleSessionMessages(entryConversationId(indexEntry));
    const anchorIndex = visible.messages.findIndex((message) => message.id === messageId);
    if (anchorIndex < 0) {
      return pastChatsError(
        'NOT_ON_ACTIVE_BRANCH',
        `The message ${messageId} was edited away or is on a non-active branch.`,
        { nearbyMessageIds: nearbyMessageIds(visible.messages, indexEntry) },
      );
    }

    const beforeContext = clampInteger(params.beforeContext, DEFAULT_BEFORE_CONTEXT, 0, MAX_BEFORE_CONTEXT);
    const afterContext = clampInteger(params.afterContext, DEFAULT_AFTER_CONTEXT, 0, MAX_AFTER_CONTEXT);
    const maxChars = clampInteger(params.maxChars, DEFAULT_READ_CHARS, 1, MAX_READ_CHARS);
    const windowMessages = readWindow(visible.messages, anchorIndex, beforeContext, afterContext);
    const assembled = clampReadMessages(windowMessages, maxChars);

    return {
      mode: 'read',
      conversation: {
        id: conversation.id,
        title: conversation.title,
        createdAt: isoTime(conversation.createdAt),
        updatedAt: isoTime(conversation.updatedAt),
      },
      anchorMessageId: messageId,
      messages: assembled.messages,
      totalChars: assembled.totalChars,
      outputTruncated: assembled.outputTruncated,
    };
  }

  async readMemorySourceEvidence(params: PastChatsEvidenceParams): Promise<PastChatsEvidenceResult> {
    const source = params.source;
    if (source.kind === 'agent_run') {
      return this.readAgentRunMemorySourceEvidence(params);
    }
    if (!source.messageRange) {
      return pastChatsError('SOURCE_NOT_FOUND', 'Memory source does not include an addressable message range.');
    }

    const conversations = await this.conversationMetaById();
    const conversation = conversations.get(source.conversationId);
    if (!conversation) {
      return pastChatsError('CONVERSATION_NOT_FOUND', `No visible conversation was found for source ${source.conversationId}.`);
    }

    const visible = await this.visibleSessionMessages(source.conversationId);
    const [fromMessageId, throughMessageId] = source.messageRange;
    const startIndex = visible.messages.findIndex((message) => message.id === fromMessageId);
    if (startIndex < 0) {
      return pastChatsError(
        'NOT_ON_ACTIVE_BRANCH',
        `The source message ${fromMessageId} was edited away or is on a non-active branch.`,
        { nearbyMessageIds: nearbyMessageIds(visible.messages, { messageId: fromMessageId }) },
      );
    }

    const throughIndex = visible.messages.findIndex((message) => message.id === throughMessageId);
    const endIndex = throughIndex >= startIndex ? throughIndex : startIndex;
    const maxChars = clampInteger(params.maxChars, DEFAULT_EVIDENCE_CHARS, 1, MAX_READ_CHARS);
    const assembled = clampReadMessages(visible.messages.slice(startIndex, endIndex + 1), maxChars);

    return {
      mode: 'evidence',
      source: { ...source },
      conversation: {
        id: conversation.id,
        title: conversation.title,
        createdAt: isoTime(conversation.createdAt),
        updatedAt: isoTime(conversation.updatedAt),
      },
      messages: assembled.messages,
      totalChars: assembled.totalChars,
      outputTruncated: assembled.outputTruncated,
    };
  }

  private async readAgentRunMemorySourceEvidence(params: PastChatsEvidenceParams): Promise<PastChatsEvidenceResult> {
    const source = params.source;
    const runId = source.subagentRunId ?? source.runId;
    if (!runId || !source.messageRange) {
      return pastChatsError('SOURCE_NOT_FOUND', 'Agent-run memory source does not include an addressable run message range.');
    }

    const conversations = await this.conversationMetaById();
    const conversation = conversations.get(source.conversationId);
    if (!conversation) {
      return pastChatsError('CONVERSATION_NOT_FOUND', `No visible conversation was found for source ${source.conversationId}.`);
    }

    const state = await this.eventStore.replay(source.conversationId);
    const run = state.subagents[runId];
    if (!run?.transcriptPayloadId) {
      return pastChatsError('SOURCE_NOT_FOUND', `No transcript payload was found for agent run ${runId}.`);
    }
    const payload = state.payloads[run.transcriptPayloadId];
    if (!payload) {
      return pastChatsError('SOURCE_NOT_FOUND', `No transcript payload was found for agent run ${runId}.`);
    }

    const messages = await this.readSubagentTranscriptPayload(source.conversationId, payload);
    const [fromMessageId, throughMessageId] = source.messageRange;
    const startIndex = agentRunMessageIndex(runId, fromMessageId);
    if (startIndex < 0 || startIndex >= messages.length) {
      return pastChatsError('SOURCE_NOT_FOUND', `The source message ${fromMessageId} was not found in agent run ${runId}.`);
    }
    const throughIndex = agentRunMessageIndex(runId, throughMessageId);
    const endIndex = throughIndex >= startIndex ? throughIndex : startIndex;
    const maxChars = clampInteger(params.maxChars, DEFAULT_EVIDENCE_CHARS, 1, MAX_READ_CHARS);
    const assembled = clampRuntimeReadMessages(runId, messages.slice(startIndex, endIndex + 1), maxChars, startIndex);

    return {
      mode: 'evidence',
      source: { ...source },
      conversation: {
        id: conversation.id,
        title: conversation.title,
        createdAt: isoTime(conversation.createdAt),
        updatedAt: isoTime(conversation.updatedAt),
      },
      messages: assembled.messages,
      totalChars: assembled.totalChars,
      outputTruncated: assembled.outputTruncated,
    };
  }

  private async readSubagentTranscriptPayload(
    sessionId: string,
    payload: AgentPayloadRef,
  ): Promise<AgentMessage[]> {
    try {
      const raw = await this.eventStore.readPayload(sessionId, payload);
      const parsed = JSON.parse(raw.toString('utf8')) as unknown;
      if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.messages)) return [];
      return parsed.messages.filter(isRecordableRuntimeMessage).map((message) => JSON.parse(JSON.stringify(message)) as AgentMessage);
    } catch {
      return [];
    }
  }

  private async conversationMetaById(): Promise<Map<string, AgentConversationIndexEntry>> {
    return new Map((await this.eventStore.listConversationIndexEntries()).map((entry) => [entry.id, entry]));
  }

  private async visibleSessionMessages(sessionId: string): Promise<VisibleSessionCacheEntry> {
    const state = await this.eventStore.replay(sessionId);
    const cached = this.visibleSessionCache.get(sessionId);
    if (cached && cached.latestEventId === state.latestEventId) return cached;
    const messages = getAgentEventVisibleTranscript(state).map((entry) => entry.message);
    const next = {
      latestEventId: state.latestEventId,
      messageIds: new Set(messages.map((message) => message.id)),
      messageById: new Map(messages.map((message) => [message.id, message])),
      messages,
      compactionMessageIds: new Set(Object.keys(state.compactionsByMessageId)),
    };
    this.visibleSessionCache.set(sessionId, next);
    return next;
  }
}

export function pastChatsError(
  code: PastChatsErrorCode,
  message: string,
  options: { nearbyMessageIds?: string[] } = {},
): PastChatsErrorResult {
  return {
    mode: 'error',
    code,
    message,
    nearbyMessageIds: options.nearbyMessageIds,
  };
}

function readWindow(
  messages: readonly AgentEventMessageRecord[],
  anchorIndex: number,
  beforeContext: number,
  afterContext: number,
): AgentEventMessageRecord[] {
  let start = anchorIndex;
  if (beforeContext > 0) {
    let seenUsers = 0;
    for (let index = anchorIndex - 1; index >= 0; index -= 1) {
      if (messages[index]?.role !== 'user') continue;
      seenUsers += 1;
      start = index;
      if (seenUsers >= beforeContext) break;
    }
  }
  const end = Math.min(messages.length, anchorIndex + 1 + afterContext);
  return messages.slice(start, end);
}

function clampReadMessages(messages: readonly AgentEventMessageRecord[], maxChars: number): {
  messages: PastChatsReadMessage[];
  totalChars: number;
  outputTruncated: boolean;
} {
  const full = messages.map((message) => ({
    message,
    text: messageText(message),
  }));
  const totalChars = full.reduce((sum, item) => sum + item.text.length, 0);
  let remaining = maxChars;
  let outputTruncated = totalChars > maxChars;
  const out: PastChatsReadMessage[] = [];

  for (const item of full) {
    if (remaining <= 0) {
      outputTruncated = true;
      break;
    }
    const truncated = item.text.length > remaining;
    const text = truncated ? item.text.slice(0, remaining).trimEnd() : item.text;
    remaining -= text.length;
    out.push({
      messageId: item.message.id,
      role: item.message.role,
      createdAt: isoTime(item.message.createdAt),
      text,
      toolName: item.message.toolName,
      isError: item.message.isError,
      messageTruncated: truncated || undefined,
    });
    if (truncated) break;
  }

  return { messages: out, totalChars, outputTruncated };
}

function clampRuntimeReadMessages(
  runId: string,
  messages: readonly AgentMessage[],
  maxChars: number,
  startIndex = 0,
): {
  messages: PastChatsReadMessage[];
  totalChars: number;
  outputTruncated: boolean;
} {
  const full = messages.map((message, index) => ({
    message,
    messageId: agentRunMessageId(runId, startIndex + index),
    text: runtimeMessageText(message),
  }));
  const totalChars = full.reduce((sum, item) => sum + item.text.length, 0);
  let remaining = maxChars;
  let outputTruncated = totalChars > maxChars;
  const out: PastChatsReadMessage[] = [];

  for (const item of full) {
    if (remaining <= 0) {
      outputTruncated = true;
      break;
    }
    const truncated = item.text.length > remaining;
    const text = truncated ? item.text.slice(0, remaining).trimEnd() : item.text;
    remaining -= text.length;
    out.push({
      messageId: item.messageId,
      role: runtimeMessageRole(item.message),
      createdAt: isoTime(runtimeMessageTimestamp(item.message)),
      text,
      toolName: item.message.role === 'toolResult' ? item.message.toolName : undefined,
      isError: item.message.role === 'toolResult' ? item.message.isError : undefined,
      messageTruncated: truncated || undefined,
    });
    if (truncated) break;
  }

  return { messages: out, totalChars, outputTruncated };
}

function messageText(message: AgentEventMessageRecord): string {
  if (message.role === 'toolResult' && message.outputSummary?.trim()) {
    return message.outputSummary.trim();
  }
  if (message.role === 'user') {
    return cleanUserMessageText(contentText(message.content));
  }
  return contentText(message.content);
}

function searchResultText(entry: AgentEventSearchIndexEntry, message: AgentEventMessageRecord | undefined): string {
  if (entry.role === 'user' && message) {
    return cleanUserMessageText(contentText(message.content));
  }
  return entry.text || entry.preview;
}

function contentText(content: readonly AgentPersistedContent[]): string {
  return content
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'thinking') return part.redacted ? '[thinking]' : '[thinking]';
      if (part.type === 'toolCall') return `[tool:${part.name} ${summarizeJson(part.arguments)}]`;
      if (part.type === 'image') return part.alt ?? part.imageRef.summary ?? `[image:${part.imageRef.id}]`;
      return part.label ?? part.payload.summary ?? `[payload:${part.payload.id}]`;
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function runtimeMessageText(message: AgentMessage): string {
  if (message.role === 'toolResult') return runtimeContentText(message.content);
  return runtimeContentText(message.content);
}

function runtimeContentText(content: AgentMessage['content']): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!isRecord(part)) return '';
      if (part.type === 'text' && typeof part.text === 'string') return part.text;
      if (part.type === 'thinking') return '[thinking]';
      if (part.type === 'toolCall') return `[tool:${String(part.name ?? 'unknown')} ${summarizeJson(part.arguments)}]`;
      if (part.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function runtimeMessageRole(message: AgentMessage): PastChatsRole {
  return message.role === 'assistant' || message.role === 'toolResult' ? message.role : 'user';
}

function runtimeMessageTimestamp(message: AgentMessage): number {
  return typeof message.timestamp === 'number' ? message.timestamp : Date.now();
}

function agentRunMessageId(runId: string, index: number): string {
  return `${runId}:message:${index + 1}`;
}

function agentRunMessageIndex(runId: string, messageId: string): number {
  const prefix = `${runId}:message:`;
  if (!messageId.startsWith(prefix)) return -1;
  const numeric = Number(messageId.slice(prefix.length));
  if (!Number.isInteger(numeric) || numeric <= 0) return -1;
  return numeric - 1;
}

function isRecordableRuntimeMessage(message: unknown): message is AgentMessage {
  return isRecord(message)
    && (message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult');
}

function cleanUserMessageText(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncateForDisplay(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return '.'.repeat(maxChars);
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function nearbyMessageIds(
  visibleMessages: readonly AgentEventMessageRecord[],
  indexEntry: Pick<AgentEventSearchIndexEntry, 'messageId'> & Partial<Pick<AgentEventSearchIndexEntry, 'createdAt'>>,
): string[] {
  const createdAt = indexEntry.createdAt;
  const byTime = typeof createdAt === 'number'
    ? visibleMessages.findIndex((message) => message.createdAt >= createdAt)
    : -1;
  const byId = visibleMessages.findIndex((message) => message.id === indexEntry.messageId);
  const center = byTime >= 0 ? byTime : byId >= 0 ? byId : visibleMessages.length;
  return visibleMessages
    .slice(Math.max(0, center - 5), Math.min(visibleMessages.length, center + 5))
    .map((message) => message.id);
}

interface PastChatTextMatch {
  score: number;
  snippet: string;
}

function limitedQueryAnalysis(analysis: TextSearchQueryAnalysis): TextSearchQueryAnalysis {
  return analysis.terms.length <= MAX_QUERY_TERMS
    ? analysis
    : { ...analysis, terms: analysis.terms.slice(0, MAX_QUERY_TERMS) };
}

function scorePastChatText(text: string, analysis: TextSearchQueryAnalysis): PastChatTextMatch | null {
  const normalized = normalizeSearchText(text);
  if (!textSearchTextMatchesQuery(normalized, analysis)) return null;
  const phraseIndex = normalized.indexOf(analysis.normalized);
  const phraseMatched = phraseIndex >= 0;
  const matchedTerms = analysis.terms.filter((term) => normalized.includes(term));
  const firstMatchIndex = firstTextSearchMatchIndex(normalized, analysis, phraseIndex);
  let score = 0;
  if (normalized === analysis.normalized) score += 120;
  else if (normalized.startsWith(analysis.normalized)) score += 70;
  if (phraseMatched) score += 42;
  if (matchedTerms.length === analysis.terms.length) score += 26;
  score += Math.min(matchedTerms.length, 4) * 4;
  if (firstMatchIndex >= 0) score += Math.max(0, 8 - firstMatchIndex / 40);
  return {
    score,
    snippet: buildPastChatSnippet(text, analysis),
  };
}

function buildPastChatSnippet(text: string, analysis: TextSearchQueryAnalysis): string {
  const normalized = normalizeSearchText(text);
  let matchIndex = normalized.indexOf(analysis.normalized);
  let matchTerm = matchIndex >= 0 ? analysis.normalized : '';
  for (const term of analysis.terms) {
    const index = normalized.indexOf(term);
    if (index >= 0 && (matchIndex < 0 || index < matchIndex)) {
      matchIndex = index;
      matchTerm = term;
    }
  }

  const source = text.replace(/\s+/g, ' ').trim();
  if (matchIndex < 0) return source.slice(0, SEARCH_SNIPPET_CHARS);
  const half = Math.floor((SEARCH_SNIPPET_CHARS - matchTerm.length) / 2);
  const start = Math.max(0, matchIndex - half);
  const end = Math.min(source.length, start + SEARCH_SNIPPET_CHARS);
  return `${start > 0 ? '...' : ''}${highlightPastChatSnippet(source.slice(start, end), analysis)}${end < source.length ? '...' : ''}`;
}

function highlightPastChatSnippet(text: string, analysis: TextSearchQueryAnalysis): string {
  let highlighted = text;
  for (const term of [...analysis.terms].sort((left, right) => right.length - left.length)) {
    if (!term) continue;
    highlighted = highlighted.replace(new RegExp(escapeRegExp(term), 'gi'), (match) => `<mark>${match}</mark>`);
  }
  return highlighted;
}

function firstTextSearchMatchIndex(
  normalized: string,
  analysis: TextSearchQueryAnalysis,
  phraseIndex: number,
): number {
  let result = phraseIndex;
  for (const term of analysis.terms) {
    const index = normalized.indexOf(term);
    if (index >= 0 && (result < 0 || index < result)) result = index;
  }
  return result;
}

function stringSet(values: readonly string[] | undefined): Set<string> | null {
  const normalized = values?.map((value) => value.trim()).filter(Boolean) ?? [];
  return normalized.length > 0 ? new Set(normalized) : null;
}

function entryConversationId(entry: ConversationIndexedEntry): string {
  return entry.sessionId;
}

function conversationFieldsForEntry(
  entry: ConversationIndexedEntry,
  conversations: ReadonlyMap<string, AgentConversationIndexEntry>,
): { conversationId: string; conversationTitle: string | null } {
  const conversationId = entryConversationId(entry);
  return {
    conversationId,
    conversationTitle: conversations.get(conversationId)?.title ?? null,
  };
}

function parseDateFilter(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function summarizeJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (!text) return '';
  return text.length > 180 ? `${text.slice(0, 180).trimEnd()}...` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isoTime(value: number): string {
  return new Date(value).toISOString();
}
