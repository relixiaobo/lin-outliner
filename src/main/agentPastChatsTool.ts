import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import {
  AgentPastChatsService,
  pastChatsError,
  type PastChatsErrorResult,
  type PastChatsResult,
} from './agentPastChats';
import {
  agentToolResult,
  errorEnvelope,
  successEnvelope,
  type ToolEnvelope,
} from './agentToolEnvelope';

const PAST_CHATS_DESCRIPTION = `Recall content from past Tenon agent conversations. Call this BEFORE saying you don't remember something.

When to call:
- User says "last time", "before", "previously", "you said", "remember", "we discussed", "I told you" - and the reference is NOT to something earlier in this same conversation.
- User references a prior decision or preference you don't have in current context.
- User asks "have we ever discussed X".

Three modes (chosen by parameters):

RECENT - pass recent: true plus optional after/before/conversation_ids/limit/max_message_chars.
  Returns recent visible user messages only, with message_id anchors. System reminders are stripped. Use this when the user asks what you discussed before but gives no concrete keywords.

SEARCH - pass query plus optional after/before/conversation_ids/limit.
  Returns hits across past conversations with [message_id] anchors.
  Search is keyword recall, not a topic inventory. Do not search generic meta phrases like "conversation history topics discussed"; use concrete words, names, decisions, file paths, or concepts from the user's request.

READ - pass message_id from a search hit, plus optional before_context/after_context/max_chars.
  Returns the conversation around that message.

Typical flow: SEARCH to find relevant messages, then READ the most relevant hit for full context. Do NOT summarize from search snippets alone - snippets are for navigation, not citation.

Important: the user does NOT see your tool output. You must restate any recalled facts in your reply. You may use message_id anchors when referring back to specific moments.

After compaction of the current conversation, pass include_current_conversation: true to recall earlier turns that are no longer in your working context.`;

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
      description: 'Default false. Set true only after compaction when earlier current-conversation turns are no longer in context. Do not use for ordinary current-conversation lookup.',
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
  currentConversationId: () => string | null;
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
      const context = { currentConversationId: runtime.currentConversationId() };
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
  const visible = visiblePastChatsResult(result);
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
          outputBytes: Buffer.byteLength(JSON.stringify(visible), 'utf8'),
        },
      });

  // The model-visible JSON is the single, self-contained return value: it carries
  // every field the agent needs (search snippets, read message text), so no parallel
  // markdown rendering is emitted. See visiblePastChatsResult for the per-mode shape.
  // An error with no recovery anchors has no visible data — the envelope's error
  // already carries code + message. `visible` is undefined there, which omits the
  // data block (undefined is the safe default; no sentinel needed).
  return agentToolResult(envelope, visible);
}

function pastChatsTruncated(result: Exclude<PastChatsResult, PastChatsErrorResult>): boolean {
  if (result.mode === 'read') return result.outputTruncated;
  return result.truncated;
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

// Model-visible return value. Each mode is self-contained — the agent reads
// everything it needs from this JSON (search snippets, full read message text),
// so no parallel markdown block is emitted. Bulky/rarely-actionable fields
// (conversation_title, total_chars) stay out of the model's view; boolean flags are
// only included when true to keep the payload lean.
function visiblePastChatsResult(result: PastChatsResult): unknown {
  // `mode` echoes the model's own arg; `returned_*`/`message_count` equal the
  // length of the array right beside them; `anchor_message_id` echoes the
  // `message_id` arg. In error mode the envelope already carries `error.code` +
  // `error.message`, so only the recovery anchors remain.
  if (result.mode === 'recent') {
    return {
      total_items: result.totalItems,
      truncated: result.truncated,
      items: result.items.map((item) => ({
        message_id: item.messageId,
        conversation_id: item.conversationId,
        created_at: item.createdAt,
        text: item.text,
        ...(item.textTruncated ? { text_truncated: true } : {}),
        ...(item.hasAttachments ? { has_attachments: true } : {}),
      })),
    };
  }
  if (result.mode === 'search') {
    return {
      total_hits: result.totalHits,
      truncated: result.truncated,
      hits: result.hits.map((hit) => ({
        message_id: hit.messageId,
        conversation_id: hit.conversationId,
        role: hit.role,
        created_at: hit.createdAt,
        snippet: hit.snippet,
      })),
    };
  }
  if (result.mode === 'read') {
    return {
      conversation: {
        id: result.conversation.id,
        title: result.conversation.title,
        created_at: result.conversation.createdAt,
        updated_at: result.conversation.updatedAt,
      },
      total_chars: result.totalChars,
      output_truncated: result.outputTruncated,
      messages: result.messages.map((message) => ({
        message_id: message.messageId,
        role: message.role,
        created_at: message.createdAt,
        text: message.text,
        ...(message.toolName ? { tool_name: message.toolName } : {}),
        ...(message.isError ? { is_error: true } : {}),
        ...(message.messageTruncated ? { message_truncated: true } : {}),
      })),
    };
  }
  return result.nearbyMessageIds?.length
    ? { nearby_message_ids: result.nearbyMessageIds }
    : undefined;
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
