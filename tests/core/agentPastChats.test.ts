import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentActor, AgentEvent, AgentMemorySource, AgentPrincipal } from '../../src/core/agentEventLog';
import { AgentEventStore } from '../../src/main/agentEventStore';
import { AgentPastChatsService } from '../../src/main/agentPastChats';

const systemActor: AgentActor = { type: 'system' };
const userActor: AgentActor = { type: 'user', userId: 'user-1' };
const agentActor: AgentActor = { type: 'agent', agentId: 'agent-1' };
const memoryPrincipal: AgentPrincipal = { type: 'agent', agentId: 'agent-1' };

async function withStore<T>(fn: (store: AgentEventStore, service: AgentPastChatsService) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'lin-past-chats-'));
  try {
    const store = new AgentEventStore(root);
    return await fn(store, new AgentPastChatsService(store));
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

describe('agent past chats', () => {
  test('search returns only visible active-branch messages', async () => {
    await withStore(async (store, service) => {
      const conversationId = 'conversation-branches';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Branch discussion' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'user-original',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Use OAuth for login' }],
        },
        {
          ...base(conversationId, 3, 'assistant_message.started', agentActor),
          runId: 'run-original',
          messageId: 'assistant-original',
          parentMessageId: 'user-original',
          providerId: 'test',
          modelId: 'test',
        },
        {
          ...base(conversationId, 4, 'assistant_message.completed', agentActor),
          messageId: 'assistant-original',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'OAuth is acceptable here.' }],
        },
        {
          ...base(conversationId, 5, 'user_message.created', userActor),
          messageId: 'user-edited',
          parentMessageId: null,
          replacesMessageId: 'user-original',
          content: [{ type: 'text', text: 'Use API keys for login' }],
        },
        {
          ...base(conversationId, 6, 'assistant_message.started', agentActor),
          runId: 'run-edited',
          messageId: 'assistant-edited',
          parentMessageId: 'user-edited',
          providerId: 'test',
          modelId: 'test',
        },
        {
          ...base(conversationId, 7, 'assistant_message.completed', agentActor),
          messageId: 'assistant-edited',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'API keys are the active decision.' }],
        },
      ]);

      const oauth = await service.search({ query: 'OAuth', includeCurrentConversation: true });
      expect(oauth.mode).toBe('search');
      if (oauth.mode !== 'search') throw new Error('Expected search result');
      expect(oauth.hits).toEqual([]);

      const apiKeys = await service.search({ query: 'API keys', includeCurrentConversation: true });
      expect(apiKeys.mode).toBe('search');
      if (apiKeys.mode !== 'search') throw new Error('Expected search result');
      expect(apiKeys.hits.map((hit) => hit.messageId)).toEqual(['assistant-edited', 'user-edited']);
    });
  });

  test('search excludes the current conversation unless explicitly included', async () => {
    await withStore(async (store, service) => {
      const conversationId = 'conversation-current';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Current' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'user-current',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Remember the graphite palette' }],
        },
      ]);

      const hidden = await service.search({ query: 'graphite' }, { currentConversationId: conversationId });
      expect(hidden.mode).toBe('search');
      if (hidden.mode !== 'search') throw new Error('Expected search result');
      expect(hidden.hits).toEqual([]);

      const shown = await service.search(
        { query: 'graphite', includeCurrentConversation: true },
        { currentConversationId: conversationId },
      );
      expect(shown.mode).toBe('search');
      if (shown.mode !== 'search') throw new Error('Expected search result');
      expect(shown.hits.map((hit) => hit.messageId)).toEqual(['user-current']);
    });
  });

  test('search sorts by relevance before recency', async () => {
    await withStore(async (store, service) => {
      const olderConversationId = 'conversation-relevance-old';
      const newerConversationId = 'conversation-relevance-new';
      await store.appendEvents(olderConversationId, [
        { ...base(olderConversationId, 1, 'conversation.created'), title: 'Older exact' },
        {
          ...base(olderConversationId, 2, 'user_message.created', userActor),
          messageId: 'older-phrase',
          parentMessageId: null,
          content: [{ type: 'text', text: 'sqlite checkpoint strategy' }],
        },
      ]);
      await store.appendEvents(newerConversationId, [
        { ...base(newerConversationId, 10, 'conversation.created'), title: 'Newer loose' },
        {
          ...base(newerConversationId, 11, 'user_message.created', userActor),
          messageId: 'newer-loose',
          parentMessageId: null,
          content: [{ type: 'text', text: 'checkpoint details for sqlite migration' }],
        },
      ]);

      const result = await service.search({ query: 'sqlite checkpoint', includeCurrentConversation: true });
      expect(result.mode).toBe('search');
      if (result.mode !== 'search') throw new Error('Expected search result');
      expect(result.hits.map((hit) => hit.messageId)).toEqual(['older-phrase', 'newer-loose']);
    });
  });

  test('search matches spaced CJK terms across visible message text', async () => {
    await withStore(async (store, service) => {
      const conversationId = 'conversation-cjk-spaced';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'CJK spaced terms' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'user-cjk-spaced',
          parentMessageId: null,
          content: [{ type: 'text', text: '成都项目 今天 天气归档' }],
        },
      ]);

      const result = await service.search({ query: '成都 天气', includeCurrentConversation: true });
      expect(result.mode).toBe('search');
      if (result.mode !== 'search') throw new Error('Expected search result');
      expect(result.hits.map((hit) => hit.messageId)).toEqual(['user-cjk-spaced']);
    });
  });

  test('read can recover compacted current-conversation history when opted in', async () => {
    await withStore(async (store, service) => {
      const conversationId = 'conversation-compact';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Compacted' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'user-before-compact',
          parentMessageId: null,
          content: [{ type: 'text', text: 'We chose cobalt blue for focus rings' }],
        },
        {
          ...base(conversationId, 3, 'assistant_message.started', agentActor),
          runId: 'run-before',
          messageId: 'assistant-before-compact',
          parentMessageId: 'user-before-compact',
          providerId: 'test',
          modelId: 'test',
        },
        {
          ...base(conversationId, 4, 'assistant_message.completed', agentActor),
          messageId: 'assistant-before-compact',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Cobalt blue is the focus-ring choice.' }],
        },
        {
          ...base(conversationId, 5, 'compaction.completed'),
          messageId: 'compact-root',
          summary: 'Focus ring choice was preserved.',
          source: { fromMessageId: 'user-before-compact', throughMessageId: 'assistant-before-compact' },
          trigger: 'manual',
        },
        {
          ...base(conversationId, 6, 'user_message.created', systemActor),
          messageId: 'compact-root',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Conversation compacted.' }],
        },
      ]);

      const blocked = await service.read({ messageId: 'user-before-compact' }, { currentConversationId: conversationId });
      expect(blocked).toMatchObject({ mode: 'error', code: 'CONVERSATION_IS_CURRENT' });

      const read = await service.read(
        { messageId: 'user-before-compact', includeCurrentConversation: true },
        { currentConversationId: conversationId },
      );
      expect(read.mode).toBe('read');
      if (read.mode !== 'read') throw new Error('Expected read result');
      expect(read.messages.map((message) => message.messageId)).toContain('user-before-compact');
      expect(read.messages.map((message) => message.text).join('\n')).toContain('cobalt blue');
    });
  });

  test('read uses persisted tool result summaries instead of raw payload-sized content', async () => {
    await withStore(async (store, service) => {
      const conversationId = 'conversation-tool';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Tool output' },
        {
          ...base(conversationId, 2, 'assistant_message.started', agentActor),
          runId: 'run-tool',
          messageId: 'assistant-tool',
          parentMessageId: null,
          providerId: 'test',
          modelId: 'test',
        },
        {
          ...base(conversationId, 3, 'assistant_message.completed', agentActor),
          messageId: 'assistant-tool',
          stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'tool-1', name: 'bash', arguments: {} }],
        },
        {
          ...base(conversationId, 4, 'tool_result.created', { type: 'tool', toolName: 'bash', toolCallId: 'tool-1' }),
          messageId: 'tool-result-1',
          parentMessageId: 'assistant-tool',
          toolCallId: 'tool-1',
          toolName: 'bash',
          isError: false,
          content: [{ type: 'text', text: `raw ${'x'.repeat(1000)}` }],
          outputSummary: 'short bash summary',
        },
      ]);

      const read = await service.read({ messageId: 'tool-result-1', includeCurrentConversation: true });
      expect(read.mode).toBe('read');
      if (read.mode !== 'read') throw new Error('Expected read result');
      expect(read.messages.find((message) => message.messageId === 'tool-result-1')).toMatchObject({
        text: 'short bash summary',
        toolName: 'bash',
      });
    });
  });

  test('reads bounded evidence from memory source ranges', async () => {
    await withStore(async (store, service) => {
      const conversationId = 'conversation-memory-evidence';
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Memory evidence' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'user-evidence',
          parentMessageId: null,
          content: [{ type: 'text', text: 'The durable preference is terse direct answers.' }],
        },
        {
          ...base(conversationId, 3, 'assistant_message.started', agentActor),
          runId: 'run-evidence',
          messageId: 'assistant-evidence',
          parentMessageId: 'user-evidence',
          providerId: 'test',
          modelId: 'test',
        },
        {
          ...base(conversationId, 4, 'assistant_message.completed', agentActor),
          messageId: 'assistant-evidence',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'I will keep answers terse and direct.' }],
        },
      ]);

      const source: AgentMemorySource = {
        stream: 'conversation',
        streamId: conversationId,
        range: {
          fromSeqExclusive: 1,
          throughSeq: 4,
          throughEventId: `${conversationId}-event-4`,
        },
      };
      const evidence = await service.readMemorySourceEvidence({ source, maxChars: 120 });

      expect(evidence.mode).toBe('evidence');
      if (evidence.mode !== 'evidence') throw new Error('Expected evidence result');
      expect(evidence.conversation).toMatchObject({ id: conversationId, title: 'Memory evidence' });
      expect(evidence.source).toEqual(source);
      expect(evidence.messages.map((message) => message.messageId)).toEqual(['user-evidence', 'assistant-evidence']);
      expect(evidence.messages.map((message) => message.text).join('\n')).toContain('terse direct answers');
    });
  });

  test('episode evidence keeps the durable gist when raw sources are gone', async () => {
    await withStore(async (store, service) => {
      const episode = await store.recordMemoryEpisode(memoryPrincipal, {
        id: 'episode-missing-raw',
        gist: 'Durable gist: the user prefers recall to survive raw transcript loss.',
        sources: [{
          stream: 'conversation',
          streamId: 'missing-conversation',
          range: {
            fromSeqExclusive: 1,
            throughSeq: 2,
            throughEventId: 'missing-event-2',
          },
        }],
        createdAt: 20,
      });

      const evidence = await service.readMemorySourceEvidence({
        principal: memoryPrincipal,
        source: { episodeId: episode.id },
        maxChars: 200,
      });

      expect(evidence.mode).toBe('evidence');
      if (evidence.mode !== 'evidence') throw new Error('Expected evidence result');
      expect(evidence.episode?.gist).toBe('Durable gist: the user prefers recall to survive raw transcript loss.');
      expect(evidence.messages).toEqual([]);
      expect(evidence.outputTruncated).toBe(false);
    });
  });

  test('episode evidence reserves character budget for the durable gist before raw spans', async () => {
    await withStore(async (store, service) => {
      const conversationId = 'conversation-episode-budget';
      const gist = 'G'.repeat(40);
      const rawText = 'R'.repeat(100);
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Episode budget' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'user-raw-budget',
          parentMessageId: null,
          content: [{ type: 'text', text: rawText }],
        },
      ]);
      const episode = await store.recordMemoryEpisode(memoryPrincipal, {
        id: 'episode-budget',
        gist,
        sources: [{
          stream: 'conversation',
          streamId: conversationId,
          range: {
            fromSeqExclusive: 1,
            throughSeq: 2,
            throughEventId: `${conversationId}-event-2`,
          },
        }],
        createdAt: 21,
      });

      const evidence = await service.readMemorySourceEvidence({
        principal: memoryPrincipal,
        source: { episodeId: episode.id },
        maxChars: 70,
      });

      expect(evidence.mode).toBe('evidence');
      if (evidence.mode !== 'evidence') throw new Error('Expected evidence result');
      expect(evidence.episode?.gist).toBe(gist);
      expect(evidence.messages.map((message) => message.text)).toEqual(['R'.repeat(30)]);
      expect(evidence.outputTruncated).toBe(true);
    });
  });

  test('recent returns visible user message anchors with system reminders stripped', async () => {
    await withStore(async (store, service) => {
      const conversationId = 'conversation-recent';
      const currentConversationId = 'conversation-current-recent';
      const longUserText = `Please continue the agent-past-chats API plan. ${'detail '.repeat(80)}`.trim();
      await store.appendEvents(conversationId, [
        { ...base(conversationId, 1, 'conversation.created'), title: 'Recent history' },
        {
          ...base(conversationId, 2, 'user_message.created', userActor),
          messageId: 'user-recent',
          parentMessageId: null,
          content: [
            { type: 'text', text: '<system-reminder>hidden runtime context</system-reminder>' },
            { type: 'text', text: longUserText },
          ],
        },
        {
          ...base(conversationId, 3, 'assistant_message.started', agentActor),
          runId: 'run-recent',
          messageId: 'assistant-recent',
          parentMessageId: 'user-recent',
          providerId: 'test',
          modelId: 'test',
        },
        {
          ...base(conversationId, 4, 'assistant_message.completed', agentActor),
          messageId: 'assistant-recent',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Continuing the plan.' }],
        },
      ]);
      await store.appendEvents(currentConversationId, [
        { ...base(currentConversationId, 1, 'conversation.created'), title: 'Current' },
        {
          ...base(currentConversationId, 2, 'user_message.created', userActor),
          messageId: 'user-current-recent',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Do not show this current-conversation message' }],
        },
      ]);

      const recent = await service.recent(
        { maxMessageChars: 80 },
        { currentConversationId },
      );
      expect(recent.mode).toBe('recent');
      if (recent.mode !== 'recent') throw new Error('Expected recent result');
      expect(recent.items.map((item) => item.messageId)).toEqual(['user-recent']);
      expect(recent.items[0]?.text).toContain('agent-past-chats API plan');
      expect(recent.items[0]?.text).not.toContain('system-reminder');
      expect(recent.items[0]?.text).not.toContain('hidden runtime context');
      expect(recent.items[0]?.textTruncated).toBe(true);

      const read = await service.read({ messageId: 'user-recent', includeCurrentConversation: true });
      expect(read.mode).toBe('read');
      if (read.mode !== 'read') throw new Error('Expected read result');
      const readText = read.messages.map((message) => message.text).join('\n');
      expect(readText).toContain('agent-past-chats API plan');
      expect(readText).not.toContain('system-reminder');
      expect(readText).not.toContain('hidden runtime context');

      const hiddenSearch = await service.search({ query: 'hidden runtime context' });
      expect(hiddenSearch.mode).toBe('search');
      if (hiddenSearch.mode !== 'search') throw new Error('Expected search result');
      expect(hiddenSearch.hits).toEqual([]);

      const visibleSearch = await service.search({ query: 'agent-past-chats API' });
      expect(visibleSearch.mode).toBe('search');
      if (visibleSearch.mode !== 'search') throw new Error('Expected search result');
      expect(visibleSearch.hits[0]?.snippet).toContain('<mark>agent</mark>-<mark>past</mark>-<mark>chats</mark>');
      expect(visibleSearch.hits[0]?.snippet).not.toContain('system-reminder');
    });
  });

});
