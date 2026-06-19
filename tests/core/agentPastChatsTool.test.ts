import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentActor, AgentEvent } from '../../src/core/agentEventLog';
import { AgentEventStore } from '../../src/main/agentEventStore';
import { AgentPastChatsService } from '../../src/main/agentPastChats';
import { createPastChatsTool } from '../../src/main/agentPastChatsTool';

const systemActor: AgentActor = { type: 'system' };
const userActor: AgentActor = { type: 'user', userId: 'user-1' };
const agentActor: AgentActor = { type: 'agent', agentId: 'agent-1' };

async function withTool<T>(fn: (store: AgentEventStore, tool: ReturnType<typeof createPastChatsTool>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'lin-past-chats-tool-'));
  try {
    const store = new AgentEventStore(root);
    const service = new AgentPastChatsService(store);
    const tool = createPastChatsTool({
      service,
      currentConversationId: () => null,
    });
    return await fn(store, tool);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function base(conversationId: string, seq: number, type: AgentEvent['type'], actor: AgentActor = systemActor) {
  return {
    v: 1 as const,
    eventId: `${conversationId}-event-${seq}`,
    seq,
    conversationId,
    type,
    createdAt: 1_800_000_000_000 + seq,
    actor,
  };
}

function visibleJson(result: Awaited<ReturnType<ReturnType<typeof createPastChatsTool>['execute']>>) {
  const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
  return JSON.parse(text);
}

describe('agent past chats tool', () => {
  test('search exposes message anchors and source coordinates', async () => {
    await withTool(async (store, tool) => {
      const conversationId = 'conversation-search-source';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Focus decision' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'user-focus',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Use cobalt blue for focus rings.' }],
        },
      ]);

      const result = await tool.execute('tool-past-chats-search', { query: 'cobalt focus' });
      const visible = visibleJson(result);
      const markdown = result.content[1]?.type === 'text' ? result.content[1].text : '';

      expect(visible).toMatchObject({
        ok: true,
        data: {
          mode: 'search',
          hits: [{
            message_id: 'user-focus',
            conversation_id: conversationId,
            source: {
              stream: 'conversation',
              stream_id: conversationId,
              range: {
                from_seq_exclusive: 1,
                through_seq: 2,
                through_event_id: `${conversationId}-event-2`,
              },
            },
          }],
        },
      });
      expect(markdown).toContain(`source: conversation:${conversationId}@1-2:${conversationId}-event-2`);
    });
  });

  test('reads a source span through the current stream tail', async () => {
    await withTool(async (store, tool) => {
      const conversationId = 'conversation-source-read';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Source read' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'user-source',
          parentMessageId: null,
          content: [{ type: 'text', text: 'The source-read tool should return this raw text.' }],
        },
        {
          ...base(conversationId, 3, 'assistant_message.started', agentActor),
          runId: 'run-source',
          messageId: 'assistant-source',
          parentMessageId: 'user-source',
          providerId: 'test',
          modelId: 'test',
        },
        {
          ...base(conversationId, 4, 'assistant_message.completed', agentActor),
          messageId: 'assistant-source',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Returned raw text confirmed.' }],
        },
      ]);

      const result = await tool.execute('tool-past-chats-source', {
        source: {
          stream: 'conversation',
          stream_id: conversationId,
          from_seq_exclusive: 1,
        },
      });
      const visible = visibleJson(result);
      const markdown = result.content[1]?.type === 'text' ? result.content[1].text : '';

      expect(visible).toMatchObject({
        ok: true,
        data: {
          mode: 'source',
          source: {
            stream: 'conversation',
            stream_id: conversationId,
            range: {
              from_seq_exclusive: 1,
              through_seq: 4,
              through_event_id: `${conversationId}-event-4`,
            },
          },
          message_ids: ['user-source', 'assistant-source'],
        },
      });
      expect(markdown).toContain('The source-read tool should return this raw text.');
      expect(markdown).toContain('Returned raw text confirmed.');
    });
  });

  test('returns structured errors for ambiguous modes', async () => {
    await withTool(async (_store, tool) => {
      const result = await tool.execute('tool-past-chats-error', {
        recent: true,
        query: 'cobalt',
      });
      const visible = visibleJson(result);

      expect(visible).toMatchObject({
        ok: false,
        error: {
          code: 'AMBIGUOUS_MODE',
        },
      });
    });
  });
});
