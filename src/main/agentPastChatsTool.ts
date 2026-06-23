import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { AgentMemoryStreamSource } from '../core/agentEventLog';
import {
  AgentPastChatsService,
  pastChatsError,
  type PastChatsErrorResult,
  type PastChatsRecentResult,
  type PastChatsReadResult,
  type PastChatsResult,
  type PastChatsSearchResult,
  type PastChatsSourceResult,
  type PastChatsStreamSourceInput,
} from './agentPastChats';
import {
  agentToolResult,
  errorEnvelope,
  successEnvelope,
  type ToolEnvelope,
} from './agentToolEnvelope';

const PAST_CHATS_TOOL = 'past_chats';
const MAX_MARKDOWN_CHARS = 16_000;

const PAST_CHATS_DESCRIPTION = `Read and search prior agent conversations. Call this before saying you do not remember a prior discussion.

Modes:
- recent: pass recent=true to list recent visible user messages when the user asks about previous conversations but gives no concrete keywords.
- search: pass query to search visible prior conversation messages by concrete terms, names, decisions, file paths, or concepts.
- read by message: pass message_id from a recent/search result to read surrounding context.
- read by source: pass source={stream, stream_id, from_seq_exclusive, through_seq?} to read a raw conversation/run span. Runtime-provided sources may also include timestamp clamps; preserve them exactly when present.

Search and recent results are navigation. Read before relying on details. The user does not see tool output; restate recalled facts in your answer.`;

const PAST_CHATS_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    recent: {
      type: 'boolean',
      description: 'Recent overview mode. Set true to list recent visible user messages.',
    },
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'Search query. Use concrete keywords, names, decisions, file paths, or concepts.',
    },
    source: {
      type: 'object',
      additionalProperties: false,
      required: ['stream', 'stream_id', 'from_seq_exclusive'],
      description: 'Read a raw conversation or run stream range returned by past_chats.',
      properties: {
        stream: {
          type: 'string',
          enum: ['conversation', 'run'],
          description: 'Source stream kind.',
        },
        stream_id: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'Conversation id or run id.',
        },
        from_seq_exclusive: {
          type: 'integer',
          minimum: 0,
          description: 'Exclusive lower seq bound in the stream.',
        },
        through_seq: {
          type: 'integer',
          minimum: 1,
          description: 'Inclusive upper seq bound. Omit to read through the current stream tail.',
        },
        through_event_id: {
          type: ['string', 'null'],
          maxLength: 200,
          description: 'Optional tamper-check event id for through_seq.',
        },
        from_created_at_inclusive: {
          type: ['integer', 'null'],
          minimum: 0,
          description: 'Optional inclusive createdAt timestamp clamp for runtime-provided date-window sources.',
        },
        through_created_at_exclusive: {
          type: ['integer', 'null'],
          minimum: 0,
          description: 'Optional exclusive createdAt timestamp clamp for runtime-provided date-window sources.',
        },
      },
    },
    after: {
      type: 'string',
      minLength: 1,
      maxLength: 80,
      description: 'Inclusive ISO 8601 lower bound for message creation time.',
    },
    before: {
      type: 'string',
      minLength: 1,
      maxLength: 80,
      description: 'Inclusive ISO 8601 upper bound for message creation time.',
    },
    conversation_ids: {
      type: 'array',
      maxItems: 20,
      items: { type: 'string', minLength: 1, maxLength: 200 },
      description: 'Optional conversation ids to search within.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'Result limit. Search default 10/max 20; recent default 20/max 50.',
    },
    include_current_conversation: {
      type: 'boolean',
      description: 'Default false. Set true only when recalling compacted current-conversation context.',
    },
    message_id: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'Read mode anchor from a search or recent result.',
    },
    before_context: {
      type: 'integer',
      minimum: 0,
      maximum: 5,
      description: 'Read by message: number of preceding user-message contexts to include. Default 1, max 5.',
    },
    after_context: {
      type: 'integer',
      minimum: 0,
      maximum: 20,
      description: 'Read by message: number of following messages to include. Default 4, max 20.',
    },
    max_chars: {
      type: 'integer',
      minimum: 1,
      maximum: 8000,
      description: 'Read output character budget. Default 2000, max 8000.',
    },
    max_message_chars: {
      type: 'integer',
      minimum: 1,
      maximum: 1200,
      description: 'Recent mode per-user-message character budget. Default 360, max 1200.',
    },
  },
};

export interface PastChatsToolRuntime {
  service: AgentPastChatsService;
  currentConversationId: () => string | null;
}

export function createPastChatsTool(runtime: PastChatsToolRuntime): AgentTool<any, ToolEnvelope<PastChatsResult>> {
  return {
    name: PAST_CHATS_TOOL,
    label: 'Past Chats',
    description: PAST_CHATS_DESCRIPTION,
    parameters: PAST_CHATS_PARAMETERS,
    executionMode: 'parallel',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      const params = isRecord(rawParams) ? rawParams : {};
      const hasRecent = params.recent === true;
      const hasQuery = typeof params.query === 'string' && params.query.trim().length > 0;
      const hasMessageId = typeof params.message_id === 'string' && params.message_id.trim().length > 0;
      const source = sourceParam(params.source);
      const modeCount = Number(hasRecent) + Number(hasQuery) + Number(hasMessageId) + Number(Boolean(source));
      const context = { currentConversationId: runtime.currentConversationId() };

      let result: PastChatsResult;
      if (modeCount > 1) {
        result = pastChatsError('AMBIGUOUS_MODE', 'Pass exactly one of recent=true, query, message_id, or source.');
      } else if (modeCount === 0) {
        result = pastChatsError('MISSING_QUERY_OR_MESSAGE_ID', 'Pass recent=true, query, message_id, or source.');
      } else if (hasRecent) {
        result = await runtime.service.recent({
          after: stringParam(params.after),
          before: stringParam(params.before),
          conversationIds: stringArrayParam(params.conversation_ids),
          limit: numberParam(params.limit),
          maxMessageChars: numberParam(params.max_message_chars),
          includeCurrentConversation: booleanParam(params.include_current_conversation),
        }, context);
      } else if (hasQuery) {
        result = await runtime.service.search({
          query: String(params.query),
          after: stringParam(params.after),
          before: stringParam(params.before),
          conversationIds: stringArrayParam(params.conversation_ids),
          limit: numberParam(params.limit),
          includeCurrentConversation: booleanParam(params.include_current_conversation),
        }, context);
      } else if (source) {
        result = await runtime.service.readSource({
          source,
          maxChars: numberParam(params.max_chars),
        });
      } else {
        result = await runtime.service.read({
          messageId: String(params.message_id),
          beforeContext: numberParam(params.before_context),
          afterContext: numberParam(params.after_context),
          maxChars: numberParam(params.max_chars),
          includeCurrentConversation: booleanParam(params.include_current_conversation),
        }, context);
      }

      return pastChatsToolResult(result, elapsed(started));
    },
  };
}

function pastChatsToolResult(
  result: PastChatsResult,
  durationMs: number,
): AgentToolResult<ToolEnvelope<PastChatsResult>> {
  const markdown = truncateMarkdown(formatPastChatsMarkdown(result));
  const envelope: ToolEnvelope<PastChatsResult> = result.mode === 'error'
    ? errorEnvelope<PastChatsResult>(PAST_CHATS_TOOL, result.code, result.message, {
        data: result,
        metrics: { durationMs },
      })
    : successEnvelope<PastChatsResult>(PAST_CHATS_TOOL, result, {
        instructions: pastChatsInstructions(result),
        metrics: {
          durationMs,
          truncated: pastChatsTruncated(result) || markdown.truncated,
          outputBytes: Buffer.byteLength(markdown.text, 'utf8'),
        },
      });

  return agentToolResult(envelope, visiblePastChatsResult(result), [
    { type: 'text', text: markdown.text },
  ]);
}

export function formatPastChatsMarkdown(result: PastChatsResult): string {
  if (result.mode === 'recent') return formatRecentMarkdown(result);
  if (result.mode === 'search') return formatSearchMarkdown(result);
  if (result.mode === 'read') return formatReadMarkdown(result);
  if (result.mode === 'source') return formatSourceMarkdown(result);
  return formatErrorMarkdown(result);
}

function pastChatsTruncated(result: Exclude<PastChatsResult, PastChatsErrorResult>): boolean {
  if (result.mode === 'read' || result.mode === 'source') return result.outputTruncated;
  return result.truncated;
}

function pastChatsInstructions(result: Exclude<PastChatsResult, PastChatsErrorResult>): string | undefined {
  if (result.mode === 'recent') {
    return result.items.length > 0
      ? 'Use these user messages as navigation only. Call past_chats with message_id or source to read full context before relying on it.'
      : 'No recent user-message entries were available. Do not claim this is the first conversation or that history was not saved.';
  }
  if (result.mode === 'search') {
    return result.hits.length > 0
      ? 'Call past_chats with message_id or source from a hit to read full context before relying on it.'
      : 'No hits only means this query matched no visible past messages. Retry with concrete keywords, or ask the user for one.';
  }
  return undefined;
}

function formatRecentMarkdown(result: PastChatsRecentResult): string {
  if (result.items.length === 0) {
    return [
      'No recent visible user messages found.',
      'This does not prove there is no chat history or that history was not saved.',
    ].join('\n');
  }
  const lines = [`Found ${result.totalItems} recent user message${result.totalItems === 1 ? '' : 's'}:`];
  for (const item of result.items) {
    lines.push(
      '',
      `[${item.messageId}] ${item.conversationId} - "${item.conversationTitle ?? 'Untitled'}" - ${formatShortDate(item.createdAt)}`,
      `source: ${formatSource(item.source)}`,
      `> ${item.text}`,
      item.textTruncated ? `> [truncated ${item.text.length}/${item.totalChars} chars; call past_chats with message_id for full context]` : '',
      item.hasAttachments ? '> [has attachments]' : '',
    );
  }
  if (result.truncated) {
    lines.push('', `...${result.totalItems - result.items.length} more user messages. Refine with after/before/conversation_ids or raise limit up to 50.`);
  }
  lines.push('', 'Next: call past_chats with message_id or source from one item for full context.');
  return lines.filter((line) => line !== '').join('\n');
}

function formatSearchMarkdown(result: PastChatsSearchResult): string {
  if (result.hits.length === 0) {
    return [
      'No matching past chat messages found for this query.',
      'This does not prove there is no chat history or that history was not saved. Retry with concrete names, decisions, file paths, or exact words from the user request.',
    ].join('\n');
  }
  const lines = [`Found ${result.totalHits} past chat hit${result.totalHits === 1 ? '' : 's'}:`];
  for (const hit of result.hits) {
    lines.push(
      '',
      `[${hit.messageId}] ${hit.conversationId} - "${hit.conversationTitle ?? 'Untitled'}" - ${formatShortDate(hit.createdAt)} - ${roleLabel(hit.role)}`,
      `source: ${formatSource(hit.source)}`,
      `> ${hit.snippet}`,
    );
  }
  if (result.truncated) {
    lines.push('', `...${result.totalHits - result.hits.length} more hits. Refine the query or raise limit up to 20.`);
  }
  lines.push('', 'Next: call past_chats with message_id or source from one hit for full context.');
  return lines.join('\n');
}

function formatReadMarkdown(result: PastChatsReadResult): string {
  const first = result.messages[0]?.createdAt;
  const last = result.messages.at(-1)?.createdAt;
  const lines = [
    `# "${result.conversation.title ?? 'Untitled'}" - ${result.conversation.id}`,
    first && last ? `${formatShortDate(first)}-${formatShortTime(last)} - ${result.messages.length} messages` : `${result.messages.length} messages`,
  ];
  for (const message of result.messages) {
    const anchor = message.messageId === result.anchorMessageId ? ' <- anchor' : '';
    lines.push(
      '',
      `[${message.messageId}] ${roleLabel(message.role)} - ${formatShortTime(message.createdAt)}${anchor}`,
      message.source ? `source: ${formatSource(message.source)}` : '',
      message.toolName ? `[tool: ${message.toolName}${message.isError ? ' error' : ''}]` : '',
      blockquote(message.text || '[empty]'),
      message.messageTruncated ? '[message truncated]' : '',
    );
  }
  if (result.outputTruncated) {
    lines.push('', `Truncated at ${result.messages.reduce((sum, item) => sum + item.text.length, 0)}/${result.totalChars} chars. Call again with a larger max_chars if needed.`);
  }
  return lines.filter((line) => line !== '').join('\n');
}

function formatSourceMarkdown(result: PastChatsSourceResult): string {
  const lines = [
    `# Source ${formatSource(result.source)}`,
    result.conversation ? `"${result.conversation.title ?? 'Untitled'}" - ${result.conversation.id}` : '',
  ].filter(Boolean);
  for (const message of result.messages) {
    lines.push(
      '',
      `[${message.messageId}] ${roleLabel(message.role)} - ${formatShortTime(message.createdAt)}`,
      message.toolName ? `[tool: ${message.toolName}${message.isError ? ' error' : ''}]` : '',
      blockquote(message.text || '[empty]'),
      message.messageTruncated ? '[message truncated]' : '',
    );
  }
  if (result.outputTruncated) {
    lines.push('', `Truncated at ${result.messages.reduce((sum, item) => sum + item.text.length, 0)}/${result.totalChars} chars. Call again with a larger max_chars if needed.`);
  }
  return lines.filter((line) => line !== '').join('\n');
}

function visiblePastChatsResult(result: PastChatsResult): unknown {
  if (result.mode === 'recent') {
    return {
      mode: result.mode,
      total_items: result.totalItems,
      returned_items: result.items.length,
      truncated: result.truncated,
      items: result.items.map((item) => ({
        message_id: item.messageId,
        conversation_id: item.conversationId,
        conversation_title: item.conversationTitle,
        created_at: item.createdAt,
        source: visibleSource(item.source),
        text: item.text,
        total_chars: item.totalChars,
        text_truncated: item.textTruncated,
        has_attachments: item.hasAttachments,
      })),
    };
  }
  if (result.mode === 'search') {
    return {
      mode: result.mode,
      total_hits: result.totalHits,
      returned_hits: result.hits.length,
      truncated: result.truncated,
      hits: result.hits.map((hit) => ({
        message_id: hit.messageId,
        conversation_id: hit.conversationId,
        conversation_title: hit.conversationTitle,
        role: hit.role,
        created_at: hit.createdAt,
        source: visibleSource(hit.source),
        snippet: hit.snippet,
      })),
    };
  }
  if (result.mode === 'read') {
    return {
      mode: result.mode,
      conversation: {
        id: result.conversation.id,
        title: result.conversation.title,
        created_at: result.conversation.createdAt,
        updated_at: result.conversation.updatedAt,
      },
      anchor_message_id: result.anchorMessageId,
      messages: result.messages.map((message) => ({
        message_id: message.messageId,
        role: message.role,
        created_at: message.createdAt,
        ...(message.source ? { source: visibleSource(message.source) } : {}),
      })),
      total_chars: result.totalChars,
      output_truncated: result.outputTruncated,
    };
  }
  if (result.mode === 'source') {
    return {
      mode: result.mode,
      source: visibleSource(result.source),
      conversation: result.conversation ? {
        id: result.conversation.id,
        title: result.conversation.title,
        created_at: result.conversation.createdAt,
        updated_at: result.conversation.updatedAt,
      } : undefined,
      message_count: result.messages.length,
      message_ids: result.messages.map((message) => message.messageId),
      total_chars: result.totalChars,
      output_truncated: result.outputTruncated,
    };
  }
  return {
    mode: result.mode,
    code: result.code,
    message: result.message,
    ...(result.nearbyMessageIds?.length ? { nearby_message_ids: result.nearbyMessageIds } : {}),
  };
}

function formatErrorMarkdown(result: PastChatsErrorResult): string {
  const lines = [`Error: ${result.code}`, '', result.message];
  if (result.nearbyMessageIds?.length) {
    lines.push('', 'Nearby visible messages:', ...result.nearbyMessageIds.map((id) => `- ${id}`));
  }
  return lines.join('\n');
}

function visibleSource(source: AgentMemoryStreamSource) {
  return {
    stream: source.stream,
    stream_id: source.streamId,
    range: {
      from_seq_exclusive: source.range.fromSeqExclusive,
      through_seq: source.range.throughSeq,
      through_event_id: source.range.throughEventId,
      from_created_at_inclusive: source.range.fromCreatedAtInclusive ?? null,
      through_created_at_exclusive: source.range.throughCreatedAtExclusive ?? null,
    },
  };
}

function formatSource(source: AgentMemoryStreamSource): string {
  const event = source.range.throughEventId ? `:${source.range.throughEventId}` : '';
  return `${source.stream}:${source.streamId}@${source.range.fromSeqExclusive}-${source.range.throughSeq}${event}`;
}

function truncateMarkdown(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_MARKDOWN_CHARS) return { text, truncated: false };
  return {
    text: `${text.slice(0, MAX_MARKDOWN_CHARS).trimEnd()}\n\n[tool output truncated]`,
    truncated: true,
  };
}

function sourceParam(value: unknown): PastChatsStreamSourceInput | null {
  if (!isRecord(value)) return null;
  const stream = value.stream;
  const streamId = value.stream_id;
  const fromSeqExclusive = value.from_seq_exclusive;
  const throughSeq = value.through_seq;
  const throughEventId = value.through_event_id;
  const fromCreatedAtInclusive = value.from_created_at_inclusive;
  const throughCreatedAtExclusive = value.through_created_at_exclusive;
  if ((stream !== 'conversation' && stream !== 'run') || typeof streamId !== 'string' || !streamId.trim()) {
    return null;
  }
  if (typeof fromSeqExclusive !== 'number' || !Number.isSafeInteger(fromSeqExclusive) || fromSeqExclusive < 0) {
    return null;
  }
  if (throughSeq !== undefined && (typeof throughSeq !== 'number' || !Number.isSafeInteger(throughSeq) || throughSeq < 1)) {
    return null;
  }
  if (throughEventId !== undefined && throughEventId !== null && typeof throughEventId !== 'string') {
    return null;
  }
  if (
    fromCreatedAtInclusive !== undefined
    && fromCreatedAtInclusive !== null
    && (typeof fromCreatedAtInclusive !== 'number' || !Number.isSafeInteger(fromCreatedAtInclusive) || fromCreatedAtInclusive < 0)
  ) {
    return null;
  }
  if (
    throughCreatedAtExclusive !== undefined
    && throughCreatedAtExclusive !== null
    && (typeof throughCreatedAtExclusive !== 'number' || !Number.isSafeInteger(throughCreatedAtExclusive) || throughCreatedAtExclusive < 0)
  ) {
    return null;
  }
  return {
    stream,
    streamId: streamId.trim(),
    range: {
      fromSeqExclusive,
      throughSeq,
      throughEventId: throughEventId ?? null,
      ...(typeof fromCreatedAtInclusive === 'number' ? { fromCreatedAtInclusive } : {}),
      ...(typeof throughCreatedAtExclusive === 'number' ? { throughCreatedAtExclusive } : {}),
    },
  };
}

function blockquote(text: string): string {
  return text.split('\n').map((line) => `> ${line}`).join('\n');
}

function roleLabel(role: string): string {
  if (role === 'toolResult') return 'Tool result';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}`;
}

function formatShortTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return date.toISOString().slice(11, 16);
}

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringArrayParam(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function numberParam(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function booleanParam(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function elapsed(started: number): number {
  return Date.now() - started;
}
