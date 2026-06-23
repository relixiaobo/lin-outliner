import { isHiddenAgentContextBlock } from '../core/agentAttachments';
import {
  type AgentEvent,
  type AgentEventMessageRecord,
  type AgentDreamWindow,
  type AgentMemoryStreamSource,
  type AgentPersistedContent,
  getAgentEventVisibleTranscript,
  getAgentEventRuntimeTranscriptPath,
  replayAgentEvents,
} from '../core/agentEventLog';
import { compactedSpanEvidenceText } from './agentCompaction';
import { modelFacingContent } from './agentToolOutputSlimming';

const DREAM_TRANSCRIPT_CHAR_BUDGET = 60_000;
const DREAM_MESSAGE_CONTENT_CHAR_BUDGET = 12_000;

export interface DreamMemoryExtractionSourceRange {
  source: AgentMemoryStreamSource;
  conversationId?: string;
  fromSeqExclusive: number;
  throughSeq: number;
  throughEventId: string | null;
  messageCount: number;
  charCount: number;
}

export interface DreamMemoryExtractionSpan {
  id: string;
  runId: string;
  sources: AgentMemoryStreamSource[];
  sourceRanges: DreamMemoryExtractionSourceRange[];
  transcript: string;
  totalMessageCount: number;
  totalCharCount: number;
  consolidateOnly: boolean;
}

export interface DreamMemoryExtractionConversationInput {
  conversationId: string;
  events: readonly AgentEvent[];
  fromSeqExclusive: number;
  createdAtRange?: DreamMemoryExtractionCreatedAtRange;
}

/**
 * A delegated run's own ledger as a Dream evidence stream ([[agent-run-unification]]
 * Design 3): the SAME shape as a conversation stream — events + a `{seq}` frontier —
 * with the run's identity for source construction. `fromSeqExclusive` already folds
 * in the structural fork boundary (the ledger's first `run.started` seq).
 */
export interface DreamMemoryExtractionRunInput {
  conversationId: string;
  agentId: string;
  runId: string;
  originWorkspace?: string;
  events: readonly AgentEvent[];
  fromSeqExclusive: number;
  createdAtRange?: DreamMemoryExtractionCreatedAtRange;
}

export interface DreamMemoryExtractionCreatedAtRange {
  fromInclusive: number;
  throughExclusive: number;
}

export function buildDreamMemoryExtractionSpanFromEvents(
  runId: string,
  inputs: readonly DreamMemoryExtractionConversationInput[],
): DreamMemoryExtractionSpan | null {
  return buildDreamMemoryExtractionSpanFromEvidence(runId, {
    conversations: inputs,
    runs: [],
  });
}

export function buildDreamMemoryExtractionSpanFromEvidence(
  runId: string,
  inputs: {
    conversations: readonly DreamMemoryExtractionConversationInput[];
    runs: readonly DreamMemoryExtractionRunInput[];
  },
): DreamMemoryExtractionSpan | null {
  const ranges: DreamMemoryExtractionSourceRange[] = [];
  const renderedSections: string[] = [];

  for (const input of inputs.conversations) {
    const range = evidenceRangeFromEvents(input.events, input.fromSeqExclusive, (evidence) => ({
      stream: 'conversation',
      streamId: input.conversationId,
      range: {
        fromSeqExclusive: input.fromSeqExclusive,
        throughSeq: evidence.throughSeq,
        throughEventId: evidence.throughEventId,
        ...(input.createdAtRange ? {
          fromCreatedAtInclusive: input.createdAtRange.fromInclusive,
          throughCreatedAtExclusive: input.createdAtRange.throughExclusive,
        } : {}),
      },
    }), input.createdAtRange);
    if (!range) continue;
    ranges.push(range.range);
    renderedSections.push(`## Conversation ${input.conversationId}\n${range.transcript}`);
  }

  // A delegated run's ledger digests EXACTLY like a conversation stream — the
  // unification's point: one evidence scheme, one watermark shape, one replay.
  for (const input of inputs.runs) {
    const range = evidenceRangeFromEvents(input.events, input.fromSeqExclusive, (evidence) => ({
      stream: 'run',
      streamId: input.runId,
      range: {
        fromSeqExclusive: input.fromSeqExclusive,
        throughSeq: evidence.throughSeq,
        throughEventId: evidence.throughEventId,
        ...(input.createdAtRange ? {
          fromCreatedAtInclusive: input.createdAtRange.fromInclusive,
          throughCreatedAtExclusive: input.createdAtRange.throughExclusive,
        } : {}),
      },
    }), input.createdAtRange);
    if (!range) continue;
    range.range.conversationId = input.conversationId;
    ranges.push(range.range);
    renderedSections.push(`## Agent Run ${input.runId} (${input.agentId}) in Conversation ${input.conversationId}\n${range.transcript}`);
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

export function dreamWindowSummary(window: AgentDreamWindow): string {
  return window.start === window.end ? window.start : `${window.start} -> ${window.end}`;
}

/**
 * Codex / OpenAI providers reject a `prompt_cache_key` longer than 64 chars (HTTP 400). The
 * provider derives that key from the request's `session-id` header, which pi-ai writes verbatim
 * from the stream `sessionId` — so a Dream batch's session id must stay within the cap. A Dream
 * `runId` is `dream-run-<uuid>` (46 chars), so `dream:<runId>:<n>` is 54 chars for a single-digit
 * batch, well under the limit. No principal prefix: `runId` is already globally unique, and the
 * prefix bought no provider cache affinity — it only overflowed the cap.
 */
/**
 * The one extraction path for an event stream (conversation or run ledger):
 * filter evidence events past the frontier, replay, window the active path,
 * render the raw transcript, and build the source via the caller's shape.
 */
function evidenceRangeFromEvents(
  events: readonly AgentEvent[],
  fromSeqExclusive: number,
  makeSource: (evidence: AgentMemoryStreamEvidence) => AgentMemoryStreamSource,
  createdAtRange?: DreamMemoryExtractionCreatedAtRange,
): { range: DreamMemoryExtractionSourceRange; messages: AgentEventMessageRecord[]; transcript: string } | null {
  const evidence = extractMemoryStreamEvidence(events, { fromSeqExclusive, createdAtRange });
  if (!evidence) return null;
  return {
    messages: evidence.messages,
    transcript: evidence.transcript,
    range: {
      source: makeSource(evidence),
      fromSeqExclusive,
      throughSeq: evidence.throughSeq,
      throughEventId: evidence.throughEventId,
      messageCount: evidence.messages.length,
      charCount: evidence.transcript.length,
    },
  };
}

export interface AgentMemoryStreamEvidence {
  messages: AgentEventMessageRecord[];
  transcript: string;
  throughSeq: number;
  throughEventId: string | null;
}

export function extractMemoryStreamEvidence(
  events: readonly AgentEvent[],
  range: { fromSeqExclusive: number; throughSeq?: number; createdAtRange?: DreamMemoryExtractionCreatedAtRange },
): AgentMemoryStreamEvidence | null {
  const sortedEvents = [...events].sort((left, right) => left.seq - right.seq);
  const evidenceEvents = sortedEvents.filter((event) => (
    event.seq > range.fromSeqExclusive
    && (range.throughSeq === undefined || event.seq <= range.throughSeq)
    && (!range.createdAtRange || (
      event.createdAt >= range.createdAtRange.fromInclusive
      && event.createdAt < range.createdAtRange.throughExclusive
    ))
    && isDreamEvidenceEvent(event)
  ));
  if (evidenceEvents.length === 0) return null;

  const state = replayAgentEvents(sortedEvents);
  const visiblePath = getAgentEventVisibleTranscript(state).map((entry) => entry.message);
  // A `tool_result.replaced` is a lossy slimming artifact of an EXISTING
  // message, never new content: it must not pull a message created at-or-before
  // the frontier back into the window. On a fork-child ledger that frontier is
  // the structural boundary — an inherited fork-prefix tool result slimmed
  // during the child's own turns would otherwise leak parent-context content
  // into the child's Dream evidence. (A `user_message.edited` stays included:
  // an edit IS new content.)
  const createdSeqByMessageId = new Map<string, number>();
  for (const event of sortedEvents) {
    if (
      (event.type === 'user_message.created'
        || event.type === 'assistant_message.started'
        || event.type === 'tool_result.created')
      && typeof event.messageId === 'string'
      && !createdSeqByMessageId.has(event.messageId)
    ) {
      createdSeqByMessageId.set(event.messageId, event.seq);
    }
  }
  const evidenceMessageIds = new Set(
    evidenceEvents
      .filter((event) => (
        event.type !== 'tool_result.replaced'
        || (createdSeqByMessageId.get(event.messageId) ?? 0) > range.fromSeqExclusive
      ))
      .flatMap(messageIdsFromEvidenceEvent),
  );
  const messagesFromVisiblePath = visiblePath.filter((message) => evidenceMessageIds.has(message.id));
  const messages = messagesFromVisiblePath.length > 0
    ? messagesFromVisiblePath
    : getAgentEventRuntimeTranscriptPath(state).filter((message) => evidenceMessageIds.has(message.id));
  if (messages.length === 0) return null;

  const transcript = renderDreamTranscript(messages);
  if (!transcript.trim()) return null;

  // Provenance points at the last EVIDENCE event; the CURSOR records the
  // scanned tail. They differ on purpose: a terminal run's ledger ends with a
  // non-evidence `run.completed`, and a last-evidence cursor would sit forever
  // below the tail — the already-digested skip would never fire and every
  // Dream pass would re-read every historical run ledger.
  const throughSeq = range.throughSeq;
  const scanTail = throughSeq === undefined
    ? (range.createdAtRange
      ? sortedEvents.filter((event) => event.createdAt < range.createdAtRange!.throughExclusive).at(-1) ?? evidenceEvents.at(-1)!
      : sortedEvents.at(-1)!)
    : sortedEvents.filter((event) => event.seq <= throughSeq).at(-1) ?? evidenceEvents.at(-1)!;
  return {
    messages,
    transcript,
    throughSeq: scanTail.seq,
    throughEventId: scanTail.eventId,
  };
}

function renderDreamTranscript(messages: readonly AgentEventMessageRecord[]): string {
  const rendered = messages
    .map((message, index) => renderDreamMessage(message, index + 1))
    .filter(Boolean)
    .join('\n\n');
  return truncateDreamTranscript(rendered);
}

function renderDreamMessage(message: AgentEventMessageRecord, index: number): string {
  const header = `### ${index}. ${message.role} message ${message.id}${message.runId ? ` (run ${message.runId})` : ''}`;
  // Dream digests what the agent actually saw, so a slimmed tool result feeds its
  // model-facing copy (modelSlimmedContent), not the full canonical bytes. Before
  // #313's decouple `tool_result.replaced` overwrote `content`, so Dream already
  // saw the slim copy; reading modelFacingContent preserves that behavior.
  const content = renderPersistedContent(modelFacingContent(message));
  const details: string[] = [];
  if (message.role === 'toolResult' && message.toolName) details.push(`tool: ${message.toolName}`);
  if (message.outputSummary) details.push(`summary: ${message.outputSummary}`);
  if (message.errorMessage) details.push(`error: ${message.errorMessage}`);
  const body = [...details, content].filter(Boolean).join('\n');
  return body ? `${header}\n${body}` : '';
}

/**
 * Hidden boilerplate stays out of Dream evidence, with one exception: a compaction
 * reminder. A compaction re-anchors a stream's active path at the post-compact root
 * (conversation and delegated-run ledgers alike, post run-unification), so the
 * reminder's summary is the only surviving carrier of the compacted-away content —
 * dropping it would leave that content un-Dreamed and unreachable (the
 * evidence-preserving compaction invariant, [[agent-data-model]] §13.17).
 */
function renderHiddenBlockEvidence(text: string): string[] {
  const evidence = compactedSpanEvidenceText(text);
  return evidence ? [evidence] : [];
}

function renderPersistedContent(content: readonly AgentPersistedContent[]): string {
  return content
    .flatMap((part) => {
      if (part.type === 'text') {
        if (isHiddenAgentContextBlock(part.text)) return renderHiddenBlockEvidence(part.text);
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
