import { isHiddenAgentContextBlock } from '../core/agentAttachments';
import {
  type AgentEvent,
  type AgentEventMessageRecord,
  type AgentEventReplayState,
  type AgentMemoryEntry,
  type AgentMemorySource,
  type AgentPersistedContent,
  getAgentEventRuntimeTranscriptPath,
  replayAgentEvents,
} from '../core/agentEventLog';
import type { AgentMessage, UserMessage } from '../core/agentTypes';
import { MAX_AGENT_MEMORY_FACT_CHARS } from './agentEventStore';
import {
  agentRunMessageId,
  isRecordableRuntimeMessage,
} from './agentSubagentTranscript';

const DREAM_TRANSCRIPT_CHAR_BUDGET = 60_000;
const DREAM_MESSAGE_CONTENT_CHAR_BUDGET = 12_000;
const DREAM_EXISTING_MEMORY_LIMIT = 50;
const DREAM_MAX_ACTIONS = 5;

type DreamMemoryActionType = 'add' | 'update' | 'forget';

export interface DreamMemoryExtractionSourceRange {
  source: AgentMemorySource;
  fromSeqExclusive: number;
  throughSeq: number;
  throughEventId: string | null;
  messageCount: number;
  charCount: number;
}

export interface DreamMemoryExtractionSpan {
  id: string;
  runId: string;
  sources: AgentMemorySource[];
  sourceRanges: DreamMemoryExtractionSourceRange[];
  transcript: string;
  totalMessageCount: number;
  totalCharCount: number;
  consolidateOnly: boolean;
}

export type DreamMemoryAction =
  | { type: 'add'; fact: string }
  | { type: 'update'; memoryId: string; fact: string }
  | { type: 'forget'; memoryId: string; reason?: string };

/**
 * Which pool a Dream consolidates, and therefore who its facts are *about*. One writer
 * per pool ([[agent-data-model]] §4): the agent-Dream models the agent's working self
 * from its run log; the user-Dream models the person from the conversation. The subject
 * is the elided subject of every fact it writes, so it drives both the framing and the
 * "how to write a fact" guidance.
 */
export type AgentDreamSubjectKind = 'agent' | 'user';

export interface DreamMemoryExtractionRequestInput {
  span: DreamMemoryExtractionSpan;
  existingMemories: readonly AgentMemoryEntry[];
  originWorkspace?: string;
  /** Defaults to 'agent' (the agent's own self-model). */
  subject?: AgentDreamSubjectKind;
}

export interface DreamMemoryExtractionConversationInput {
  conversationId: string;
  events: readonly AgentEvent[];
  fromSeqExclusive: number;
}

export interface DreamMemoryExtractionAgentRunInput {
  conversationId: string;
  agentId: string;
  subagentRunId: string;
  parentToolCallId?: string;
  transcriptPayloadId?: string | null;
  originWorkspace?: string;
  transcriptMessages: readonly AgentMessage[];
  fromMessageCountExclusive: number;
}

export function buildDreamMemoryExtractionSpan(
  conversationId: string,
  state: AgentEventReplayState,
  runId: string,
): DreamMemoryExtractionSpan | null {
  const run = state.runs[runId];
  if (run?.status !== 'completed') return null;
  const activePath = getAgentEventRuntimeTranscriptPath(state);
  const lastRunMessageIndex = findLastRunMessageIndex(activePath, runId);
  if (lastRunMessageIndex < 0) return null;
  const firstRunMessageIndex = findFirstRunMessageIndex(activePath, runId);
  const fromIndex = findCurrentTurnStartIndex(activePath, firstRunMessageIndex);
  const slice = activePath.slice(fromIndex, lastRunMessageIndex + 1);
  const from = slice[0];
  const through = slice.at(-1);
  if (!from || !through) return null;
  const transcript = renderDreamTranscript(slice);
  if (!transcript.trim()) return null;
  const source: AgentMemorySource = {
    conversationId,
    messageRange: [from.id, through.id],
    runId,
  };
  if (state.latestEventId) source.eventId = state.latestEventId;
  return {
    id: `run:${runId}`,
    runId,
    sources: [source],
    sourceRanges: [{
      source,
      fromSeqExclusive: 0,
      throughSeq: state.latestSeq,
      throughEventId: state.latestEventId,
      messageCount: slice.length,
      charCount: transcript.length,
    }],
    transcript,
    totalMessageCount: slice.length,
    totalCharCount: transcript.length,
    consolidateOnly: false,
  };
}

export function buildDreamMemoryExtractionSpanFromEvents(
  runId: string,
  inputs: readonly DreamMemoryExtractionConversationInput[],
): DreamMemoryExtractionSpan | null {
  return buildDreamMemoryExtractionSpanFromEvidence(runId, {
    conversations: inputs,
    agentRuns: [],
  });
}

export function buildDreamMemoryExtractionSpanFromEvidence(
  runId: string,
  inputs: {
    conversations: readonly DreamMemoryExtractionConversationInput[];
    agentRuns: readonly DreamMemoryExtractionAgentRunInput[];
  },
): DreamMemoryExtractionSpan | null {
  const ranges: DreamMemoryExtractionSourceRange[] = [];
  const renderedSections: string[] = [];

  for (const input of inputs.conversations) {
    const sortedEvents = [...input.events].sort((left, right) => left.seq - right.seq);
    const evidenceEvents = sortedEvents.filter((event) => event.seq > input.fromSeqExclusive && isDreamEvidenceEvent(event));
    if (evidenceEvents.length === 0) continue;

    const state = replayAgentEvents(sortedEvents);
    const activePath = getAgentEventRuntimeTranscriptPath(state);
    const evidenceMessageIds = new Set(evidenceEvents.flatMap(messageIdsFromEvidenceEvent));
    const messages = activePath.filter((message) => evidenceMessageIds.has(message.id));
    if (messages.length === 0) continue;

    const transcript = renderDreamTranscript(messages);
    if (!transcript.trim()) continue;

    const throughEvent = evidenceEvents.at(-1)!;
    const from = messages[0]!;
    const through = messages.at(-1)!;
    const source: AgentMemorySource = {
      conversationId: input.conversationId,
      messageRange: [from.id, through.id],
      eventId: throughEvent.eventId,
    };
    const runIds = uniqueStrings(messages.map((message) => message.runId).filter((value): value is string => !!value));
    if (runIds.length === 1) source.runId = runIds[0];

    ranges.push({
      source,
      fromSeqExclusive: input.fromSeqExclusive,
      throughSeq: throughEvent.seq,
      throughEventId: throughEvent.eventId,
      messageCount: messages.length,
      charCount: transcript.length,
    });
    renderedSections.push(`## Conversation ${input.conversationId}\n${transcript}`);
  }

  for (const input of inputs.agentRuns) {
    const messages = input.transcriptMessages
      .filter(isRecordableRuntimeMessage)
      .slice(input.fromMessageCountExclusive);
    if (messages.length === 0) continue;

    const transcript = renderDreamRuntimeTranscript(input.subagentRunId, messages, input.fromMessageCountExclusive);
    if (!transcript.trim()) continue;

    const throughMessageCount = input.fromMessageCountExclusive + messages.length;
    const source: AgentMemorySource = {
      kind: 'agent_run',
      conversationId: input.conversationId,
      runId: input.subagentRunId,
      subagentRunId: input.subagentRunId,
      agentId: input.agentId,
      messageRange: [
        agentRunMessageId(input.subagentRunId, input.fromMessageCountExclusive),
        agentRunMessageId(input.subagentRunId, throughMessageCount - 1),
      ],
      eventId: input.transcriptPayloadId ?? undefined,
      parentToolCallId: input.parentToolCallId,
    };

    ranges.push({
      source,
      fromSeqExclusive: input.fromMessageCountExclusive,
      throughSeq: throughMessageCount,
      throughEventId: input.transcriptPayloadId ?? null,
      messageCount: messages.length,
      charCount: transcript.length,
    });
    renderedSections.push(`## Agent Run ${input.subagentRunId} (${input.agentId}) in Conversation ${input.conversationId}\n${transcript}`);
  }

  if (ranges.length === 0) return null;
  const transcript = truncateDreamTranscript(renderedSections.join('\n\n'));
  return {
    id: `dream:${runId}`,
    runId,
    sources: ranges.map((range) => range.source),
    sourceRanges: ranges,
    transcript,
    totalMessageCount: ranges.reduce((sum, range) => sum + range.messageCount, 0),
    totalCharCount: ranges.reduce((sum, range) => sum + range.charCount, 0),
    consolidateOnly: false,
  };
}

export function buildConsolidateOnlyDreamMemoryExtractionSpan(runId: string): DreamMemoryExtractionSpan {
  return {
    id: `dream:${runId}:consolidate`,
    runId,
    sources: [],
    sourceRanges: [],
    transcript: '(no new raw evidence)',
    totalMessageCount: 0,
    totalCharCount: 0,
    consolidateOnly: true,
  };
}

export function buildDreamMemoryExtractionRequest(input: DreamMemoryExtractionRequestInput): UserMessage {
  const existing = input.existingMemories.slice(0, DREAM_EXISTING_MEMORY_LIMIT)
    .map((entry) => `- ${entry.id}: ${entry.fact}`)
    .join('\n') || '(none)';
  const workspace = input.originWorkspace ?? '(none)';
  const evidenceMode = input.span.consolidateOnly
    ? 'There is no new raw evidence. Consolidate existing memory only: update or forget stale/duplicate/conflicting entries, but do not add new memories.'
    : 'Analyze the raw evidence since the last Dream and propose durable memory changes.';
  const framing = dreamSubjectFraming(input.subject ?? 'agent');
  const prompt = `${framing.role}

You do not have tools. You cannot write files. Return JSON only.

${evidenceMode}

Propose at most ${DREAM_MAX_ACTIONS} durable memory changes.

What to save:
${framing.whatToSave}
- Do not save transient task steps, temporary status, command output, secrets, credentials, raw logs, or facts already represented as durable outline content.
- Do not infer beyond the raw evidence. If the evidence is ambiguous, emit no action.
- If there is no new raw evidence, do not add new memory entries.
- Never mention that memory was saved. The foreground assistant did not call a memory write tool.
- Ground every action in the raw evidence below, not in summaries.

How to write a fact (these are read back verbatim into context):
${framing.howToWrite}
- Make authority legible in the wording, not as a flag: a stated preference reads
  "${framing.statedExample}"; an inference reads "${framing.inferenceExample}".
- Keep each fact one self-contained sentence.

How to consolidate (prefer reshaping over piling up):
- update when new evidence corrects, sharpens, or merges a duplicate of an existing memory.
- update to conditionalize a contradiction into one conditional fact rather than keeping two
  that disagree.
- forget (invalidate) a memory that is now stale, wrong, or fully superseded.

Output schema:
{
  "actions": [
    { "type": "add", "fact": "..." },
    { "type": "update", "memory_id": "memory-id", "fact": "..." },
    { "type": "forget", "memory_id": "memory-id", "reason": "..." }
  ]
}

Current origin workspace: ${workspace}

Existing active memory:
${existing}

Raw evidence:
<conversation_run>
${input.span.transcript}
</conversation_run>`;

  return {
    role: 'user',
    timestamp: Date.now(),
    content: [{ type: 'text', text: prompt }],
  };
}

interface DreamSubjectFraming {
  role: string;
  whatToSave: string;
  howToWrite: string;
  /** A stated-authority example predicate, in the subject's render person. */
  statedExample: string;
  /** An inferred-authority example predicate, in the subject's render person. */
  inferenceExample: string;
}

function dreamSubjectFraming(subject: AgentDreamSubjectKind): DreamSubjectFraming {
  if (subject === 'user') {
    return {
      role: "You are Tenon's private Dream profile-builder: the assistant's durable model of the person it works with (the user).",
      whatToSave: [
        "- The user's stable preferences, working style, recurring goals, decisions, and relationship context that should help future turns serve this person.",
        '- Do NOT save the assistant\'s own working habits or conventions — those belong to the agent\'s separate self-model, not the user profile.',
      ].join('\n'),
      howToWrite: [
        '- Write a subject-elided predicate in THIRD-PERSON SINGULAR present about the user — no',
        '  leading subject. The implied subject is the user, so it renders as "The user <fact>".',
        '  Good: "prefers terse code reviews"',
        '  Good: "wants everything in the repo written in English"',
        '  Bad:  "The user prefers terse reviews"  (leading subject)',
        '  Bad:  "prefer terse reviews"            (base form; renders "The user prefer…")',
        '  Bad:  "verify a worktree\'s HEAD…"       (that is the agent\'s habit, wrong pool)',
        '- Name third parties other than the user explicitly; never bake in a pronoun for the subject.',
      ].join('\n'),
      statedExample: 'has said they want…',
      inferenceExample: 'has noticed that…',
    };
  }
  return {
    role: "You are Tenon's private Dream memory extractor: the agent's durable self-model.",
    whatToSave: [
      '- Stable facts, durable decisions, project conventions, or working habits the agent should carry forward.',
      '- Relationship context the agent needs (e.g. how to work with a named person).',
    ].join('\n'),
    howToWrite: [
      '- Write a person-neutral, subject-elided predicate in BASE form — no leading subject. The',
      '  implied subject is the agent itself, so it renders as "You <fact>".',
      '  Good: "verify a worktree\'s HEAD before trusting a gate run"',
      '  Good: "work with lixiaobo, who wants everything in the repo written in English"',
      '  Bad:  "You verify a worktree\'s HEAD…"   (leading subject)',
      '  Bad:  "The user prefers terse reviews"  (leading subject; name the third party instead)',
      '- Name third parties explicitly (e.g. the user by name); never bake in a pronoun for the subject.',
    ].join('\n'),
    statedExample: 'work with lixiaobo, who has said he wants…',
    inferenceExample: 'have noticed that…',
  };
}

export function parseDreamMemoryActions(responseText: string): DreamMemoryAction[] {
  const parsed = parseJsonObject(responseText);
  if (!parsed || !Array.isArray(parsed.actions)) return [];
  const actions: DreamMemoryAction[] = [];
  for (const raw of parsed.actions) {
    if (actions.length >= DREAM_MAX_ACTIONS) break;
    const action = normalizeDreamMemoryAction(raw);
    if (action) actions.push(action);
  }
  return actions;
}

export function mergeMemorySources(
  existing: readonly AgentMemorySource[],
  next: AgentMemorySource | readonly AgentMemorySource[],
): AgentMemorySource[] {
  const merged: AgentMemorySource[] = [];
  const seen = new Set<string>();
  const nextSources = Array.isArray(next) ? next : [next];
  for (const source of [...existing, ...nextSources]) {
    const key = JSON.stringify(source);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(source);
  }
  return merged;
}

export function memoryFactKey(fact: string): string {
  return fact.trim().replace(/\s+/g, ' ').toLowerCase();
}

function renderDreamTranscript(messages: readonly AgentEventMessageRecord[]): string {
  const rendered = messages
    .map((message, index) => renderDreamMessage(message, index + 1))
    .filter(Boolean)
    .join('\n\n');
  return truncateDreamTranscript(rendered);
}

function renderDreamRuntimeTranscript(runId: string, messages: readonly AgentMessage[], startIndex: number): string {
  const rendered = messages
    .map((message, index) => renderDreamRuntimeMessage(runId, message, startIndex + index))
    .filter(Boolean)
    .join('\n\n');
  return truncateDreamTranscript(rendered);
}

function renderDreamMessage(message: AgentEventMessageRecord, index: number): string {
  const header = `### ${index}. ${message.role} message ${message.id}${message.runId ? ` (run ${message.runId})` : ''}`;
  const content = renderPersistedContent(message.content);
  const details: string[] = [];
  if (message.role === 'toolResult' && message.toolName) details.push(`tool: ${message.toolName}`);
  if (message.outputSummary) details.push(`summary: ${message.outputSummary}`);
  if (message.errorMessage) details.push(`error: ${message.errorMessage}`);
  const body = [...details, content].filter(Boolean).join('\n');
  return body ? `${header}\n${body}` : '';
}

function renderDreamRuntimeMessage(runId: string, message: AgentMessage, index: number): string {
  const header = `### ${index + 1}. ${message.role} message ${agentRunMessageId(runId, index)} (agent run ${runId})`;
  const details: string[] = [];
  if (message.role === 'toolResult' && message.toolName) details.push(`tool: ${message.toolName}`);
  if (message.role === 'toolResult' && message.isError) details.push('error: true');
  const content = renderRuntimeContent(message.content);
  const body = [...details, content].filter(Boolean).join('\n');
  return body ? `${header}\n${body}` : '';
}

function renderPersistedContent(content: readonly AgentPersistedContent[]): string {
  return content
    .flatMap((part) => {
      if (part.type === 'text') {
        if (isHiddenAgentContextBlock(part.text)) return [];
        return [part.text.trim()];
      }
      if (part.type === 'thinking') return ['[thinking omitted]'];
      if (part.type === 'toolCall') return [`tool call: ${part.name} ${JSON.stringify(part.arguments)}`];
      if (part.type === 'image') return [part.alt || part.imageRef.summary || `[image:${part.imageRef.id}]`];
      return [part.label || part.payload.summary || `[payload:${part.payload.id}]`];
    })
    .filter(Boolean)
    .join('\n\n')
    .slice(0, DREAM_MESSAGE_CONTENT_CHAR_BUDGET);
}

function renderRuntimeContent(content: AgentMessage['content']): string {
  if (typeof content === 'string') return content.trim().slice(0, DREAM_MESSAGE_CONTENT_CHAR_BUDGET);
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part) => {
      if (!isRecord(part)) return [];
      if (part.type === 'text' && typeof part.text === 'string') {
        if (isHiddenAgentContextBlock(part.text)) return [];
        return [part.text.trim()];
      }
      if (part.type === 'thinking') return ['[thinking omitted]'];
      if (part.type === 'toolCall') return [`tool call: ${String(part.name ?? 'unknown')} ${JSON.stringify(part.arguments ?? {})}`];
      if (part.type === 'image') return ['[image]'];
      return [];
    })
    .filter(Boolean)
    .join('\n\n')
    .slice(0, DREAM_MESSAGE_CONTENT_CHAR_BUDGET);
}

function findFirstRunMessageIndex(messages: readonly AgentEventMessageRecord[], runId: string): number {
  return messages.findIndex((message) => message.runId === runId);
}

function findLastRunMessageIndex(messages: readonly AgentEventMessageRecord[], runId: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.runId === runId) return index;
  }
  return -1;
}

function findCurrentTurnStartIndex(messages: readonly AgentEventMessageRecord[], firstRunMessageIndex: number): number {
  const previous = messages[firstRunMessageIndex - 1];
  if (previous?.role === 'user') return firstRunMessageIndex - 1;
  return firstRunMessageIndex;
}

function truncateDreamTranscript(rendered: string): string {
  if (rendered.length <= DREAM_TRANSCRIPT_CHAR_BUDGET) return rendered;
  return `[older raw evidence truncated]\n${rendered.slice(rendered.length - DREAM_TRANSCRIPT_CHAR_BUDGET)}`;
}

function isDreamEvidenceEvent(event: AgentEvent): boolean {
  return event.type === 'user_message.created'
    || event.type === 'user_message.edited'
    || event.type === 'assistant_message.completed'
    || event.type === 'assistant_message.failed'
    || event.type === 'tool_result.created'
    || event.type === 'tool_result.replaced';
}

function messageIdsFromEvidenceEvent(event: AgentEvent): string[] {
  return typeof event.messageId === 'string' ? [event.messageId] : [];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizeDreamMemoryAction(value: unknown): DreamMemoryAction | null {
  if (!isRecord(value)) return null;
  const type = normalizeActionType(value.type);
  if (!type) return null;
  if (type === 'add') {
    const fact = normalizeFact(value.fact);
    return fact ? { type, fact } : null;
  }
  const memoryId = normalizeString(value.memory_id) ?? normalizeString(value.memoryId);
  if (!memoryId) return null;
  if (type === 'update') {
    const fact = normalizeFact(value.fact);
    return fact ? { type, memoryId, fact } : null;
  }
  return {
    type,
    memoryId,
    reason: normalizeString(value.reason) ?? undefined,
  };
}

function normalizeActionType(value: unknown): DreamMemoryActionType | null {
  return value === 'add' || value === 'update' || value === 'forget' ? value : null;
}

function normalizeFact(value: unknown): string | null {
  const text = normalizeString(value);
  if (!text) return null;
  if (text.length <= MAX_AGENT_MEMORY_FACT_CHARS) return text;
  return `${text.slice(0, MAX_AGENT_MEMORY_FACT_CHARS - 3).trimEnd()}...`;
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') || null : null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = stripCodeFence(text.trim());
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(first, last + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stripCodeFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return match?.[1] ?? text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
