import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import {
  AgentPastChatsService,
  pastChatsError,
  type PastChatsErrorResult,
  type PastChatsRecentResult,
  type PastChatsReadResult,
  type PastChatsResult,
  type PastChatsSearchResult,
} from './agentPastChats';
import {
  agentToolResult,
  errorEnvelope,
  successEnvelope,
  type ToolEnvelope,
} from './agentToolEnvelope';

const PAST_CHATS_DESCRIPTION = `Recall content from past Lin agent conversations. Call this BEFORE saying you don't remember something.

When to call:
- User says "last time", "before", "previously", "you said", "remember", "we discussed", "I told you" - and the reference is NOT to something earlier in this same conversation.
- User references a prior decision or preference you don't have in current context.
- User asks "have we ever discussed X".

Three modes (chosen by parameters):

RECENT - pass recent: true plus optional after/before/session_ids/limit/max_message_chars.
  Returns recent visible user messages only, with message_id anchors. System reminders are stripped. Use this when the user asks what you discussed before but gives no concrete keywords.

SEARCH - pass query plus optional after/before/session_ids/limit.
  Returns hits across past sessions with [message_id] anchors.
  Search is keyword recall, not a topic inventory. Do not search generic meta phrases like "conversation history topics discussed"; use concrete words, names, decisions, file paths, or concepts from the user's request.

READ - pass message_id from a search hit, plus optional before_context/after_context/max_chars.
  Returns the conversation around that message.

Typical flow: SEARCH to find relevant messages, then READ the most relevant hit for full context. Do NOT summarize from search snippets alone - snippets are for navigation, not citation.

Important: the user does NOT see your tool output. You must restate any recalled facts in your reply. You may use message_id anchors when referring back to specific moments.

After compaction of the current session, pass include_current_session: true to recall earlier turns that are no longer in your working context.`;

const PAST_CHATS_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    recent: {
      type: 'boolean',
      description: 'Recent overview mode. Set true to list recent visible user messages when the user asks what was discussed before but gives no concrete keywords.',
    },
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'Search query. Use concrete keywords, names, file paths, decisions, or concepts. Do not use generic meta queries such as "conversation history topics discussed".',
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
    session_ids: {
      type: 'array',
      maxItems: 20,
      items: { type: 'string', minLength: 1, maxLength: 200 },
      description: 'Optional session ids to search within.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'Result limit. Search default 10/max 20; recent default 20/max 50.',
    },
    include_current_session: {
      type: 'boolean',
      description: 'Default false. Set true only after compaction when earlier current-session turns are no longer in context. Do not use for ordinary current-session lookup.',
    },
    message_id: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'Read mode anchor from a search hit.',
    },
    before_context: {
      type: 'integer',
      minimum: 0,
      maximum: 5,
      description: 'Read mode: number of preceding user-message contexts to include. Default 1, max 5.',
    },
    after_context: {
      type: 'integer',
      minimum: 0,
      maximum: 20,
      description: 'Read mode: number of following messages to include. Default 4, max 20.',
    },
    max_chars: {
      type: 'integer',
      minimum: 1,
      maximum: 8000,
      description: 'Read mode output character budget. Default 2000, max 8000.',
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
  currentSessionId: () => string | null;
}

export function createPastChatsTool(runtime: PastChatsToolRuntime): AgentTool<any, ToolEnvelope<PastChatsResult>> {
  return {
    name: 'past_chats',
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
      const context = { currentSessionId: runtime.currentSessionId() };
      const modeCount = Number(hasRecent) + Number(hasQuery) + Number(hasMessageId);

      let result: PastChatsResult;
      if (modeCount > 1) {
        result = pastChatsError('AMBIGUOUS_MODE', 'Pass exactly one of recent: true, query for search mode, or message_id for read mode.');
      } else if (modeCount === 0) {
        result = pastChatsError('MISSING_QUERY_OR_MESSAGE_ID', 'Pass recent: true, query for search mode, or message_id for read mode.');
      } else if (hasRecent) {
        result = await runtime.service.recent({
          after: stringParam(params.after),
          before: stringParam(params.before),
          sessionIds: stringArrayParam(params.session_ids),
          limit: numberParam(params.limit),
          maxMessageChars: numberParam(params.max_message_chars),
          includeCurrentSession: booleanParam(params.include_current_session),
        }, context);
      } else if (hasQuery) {
        result = await runtime.service.search({
          query: String(params.query),
          after: stringParam(params.after),
          before: stringParam(params.before),
          sessionIds: stringArrayParam(params.session_ids),
          limit: numberParam(params.limit),
          includeCurrentSession: booleanParam(params.include_current_session),
        }, context);
      } else {
        result = await runtime.service.read({
          messageId: String(params.message_id),
          beforeContext: numberParam(params.before_context),
          afterContext: numberParam(params.after_context),
          maxChars: numberParam(params.max_chars),
          includeCurrentSession: booleanParam(params.include_current_session),
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
  const markdown = formatPastChatsMarkdown(result);
  const envelope: ToolEnvelope<PastChatsResult> = result.mode === 'error'
    ? errorEnvelope<PastChatsResult>('past_chats', result.code, result.message, {
        data: result,
        metrics: { durationMs },
      })
    : successEnvelope<PastChatsResult>('past_chats', result, {
        instructions: pastChatsInstructions(result),
        metrics: {
          durationMs,
          truncated: pastChatsTruncated(result),
          outputBytes: Buffer.byteLength(markdown, 'utf8'),
        },
      });

  return agentToolResult(envelope, visiblePastChatsResult(result), [
    { type: 'text', text: markdown },
  ]);
}

export function formatPastChatsMarkdown(result: PastChatsResult): string {
  if (result.mode === 'recent') return formatRecentMarkdown(result);
  if (result.mode === 'search') return formatSearchMarkdown(result);
  if (result.mode === 'read') return formatReadMarkdown(result);
  return formatErrorMarkdown(result);
}

function pastChatsTruncated(result: Exclude<PastChatsResult, PastChatsErrorResult>): boolean {
  if (result.mode === 'read') return result.outputTruncated;
  return result.truncated;
}

function formatRecentMarkdown(result: PastChatsRecentResult): string {
  if (result.items.length === 0) {
    return [
      'No recent visible user messages found.',
      'This does not prove there is no chat history or that history was not saved. Ask the user for a concrete keyword, or retry with include_current_session only if recalling compacted current-session context.',
    ].join('\n');
  }
  const lines = [`Found ${result.totalItems} recent user message${result.totalItems === 1 ? '' : 's'}:`];
  for (const item of result.items) {
    lines.push(
      '',
      `[${item.messageId}] ${item.sessionId} - "${item.sessionTitle ?? 'Untitled'}" - ${formatShortDate(item.createdAt)}`,
      `> ${item.text}`,
      item.textTruncated ? `> [truncated ${item.text.length}/${item.totalChars} chars; call past_chats with message_id for full context]` : '',
      item.hasAttachments ? '> [has attachments]' : '',
    );
  }
  if (result.truncated) {
    lines.push('', `...${result.totalItems - result.items.length} more user messages. Refine with after/before/session_ids or raise limit up to 50.`);
  }
  lines.push('', 'Next: call past_chats with message_id from one item for full context.');
  return lines.filter((line) => line !== '').join('\n');
}

function formatSearchMarkdown(result: PastChatsSearchResult): string {
  if (result.hits.length === 0) {
    return [
      'No matching past chat messages found for this query.',
      'This does not prove there is no chat history or that history was not saved. Retry with concrete names, decisions, file paths, or exact words from the user request. If the user gave no concrete terms, ask for a keyword instead of guessing.',
    ].join('\n');
  }
  const lines = [`Found ${result.totalHits} past chat hit${result.totalHits === 1 ? '' : 's'}:`];
  for (const hit of result.hits) {
    lines.push(
      '',
      `[${hit.messageId}] ${hit.sessionId} - "${hit.sessionTitle ?? 'Untitled'}" - ${formatShortDate(hit.createdAt)} - ${roleLabel(hit.role)}`,
      `> ${hit.snippet}`,
    );
  }
  if (result.truncated) {
    lines.push('', `...${result.totalHits - result.hits.length} more hits. Refine the query or raise limit up to 20.`);
  }
  lines.push('', 'Next: call past_chats with message_id from one hit for full context.');
  return lines.join('\n');
}

function pastChatsInstructions(result: Exclude<PastChatsResult, PastChatsErrorResult>): string | undefined {
  if (result.mode === 'recent') {
    if (result.items.length === 0) {
      return 'No recent user-message entries were available. Do not claim this is the first conversation or that history was not saved. Ask the user for a concrete keyword if they need recall.';
    }
    return 'Use these user messages as navigation only. Call past_chats with message_id from an item to read full context before relying on it.';
  }
  if (result.mode !== 'search') return undefined;
  if (result.hits.length > 0) {
    return 'Call past_chats with message_id from a hit to read full context before relying on it.';
  }
  return 'No hits only means this query matched no visible past messages. Do not claim this is the first conversation or that history was not saved. Retry with concrete keywords, or ask the user for one if none were provided.';
}

function formatReadMarkdown(result: PastChatsReadResult): string {
  const first = result.messages[0]?.createdAt;
  const last = result.messages.at(-1)?.createdAt;
  const lines = [
    `# "${result.session.title ?? 'Untitled'}" - ${result.session.id}`,
    first && last ? `${formatShortDate(first)}-${formatShortTime(last)} - ${result.messages.length} messages` : `${result.messages.length} messages`,
  ];
  for (const message of result.messages) {
    const anchor = message.messageId === result.anchorMessageId ? ' <- anchor' : '';
    lines.push(
      '',
      `[${message.messageId}] ${roleLabel(message.role)} - ${formatShortTime(message.createdAt)}${anchor}`,
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
        session_id: item.sessionId,
        session_title: item.sessionTitle,
        created_at: item.createdAt,
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
      message_ids: result.hits.map((hit) => hit.messageId),
    };
  }
  if (result.mode === 'read') {
    return {
      mode: result.mode,
      session: {
        id: result.session.id,
        title: result.session.title,
        created_at: result.session.createdAt,
        updated_at: result.session.updatedAt,
      },
      anchor_message_id: result.anchorMessageId,
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
