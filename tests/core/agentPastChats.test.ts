import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentActor, AgentEvent } from '../../src/core/agentEventLog';
import { AgentEventStore } from '../../src/main/agentEventStore';
import { AgentPastChatsService } from '../../src/main/agentPastChats';
import { createPastChatsTool } from '../../src/main/agentPastChatsTool';
import type { ToolEnvelope } from '../../src/main/agentToolEnvelope';

const systemActor: AgentActor = { type: 'system' };
const userActor: AgentActor = { type: 'user', userId: 'user-1' };
const agentActor: AgentActor = { type: 'agent', agentId: 'agent-1' };

async function withStore<T>(fn: (store: AgentEventStore, service: AgentPastChatsService) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'lin-past-chats-'));
  try {
    const store = new AgentEventStore(root);
    return await fn(store, new AgentPastChatsService(store));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function base(sessionId: string, seq: number, type: AgentEvent['type'], actor: AgentActor = systemActor) {
  return {
    v: 1 as const,
    eventId: `${sessionId}-event-${seq}`,
    seq,
    sessionId,
    type,
    createdAt: 1_800_000_000_000 + seq,
    actor,
  };
}

describe('agent past chats', () => {
  test('search returns only visible active-branch messages', async () => {
    await withStore(async (store, service) => {
      const sessionId = 'session-branches';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Branch discussion' },
        {
          ...base(sessionId, 2, 'user_message.created', userActor),
          messageId: 'user-original',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Use OAuth for login' }],
        },
        {
          ...base(sessionId, 3, 'assistant_message.started', agentActor),
          runId: 'run-original',
          messageId: 'assistant-original',
          parentMessageId: 'user-original',
          providerId: 'test',
          modelId: 'test',
        },
        {
          ...base(sessionId, 4, 'assistant_message.completed', agentActor),
          messageId: 'assistant-original',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'OAuth is acceptable here.' }],
        },
        {
          ...base(sessionId, 5, 'user_message.created', userActor),
          messageId: 'user-edited',
          parentMessageId: null,
          replacesMessageId: 'user-original',
          content: [{ type: 'text', text: 'Use API keys for login' }],
        },
        {
          ...base(sessionId, 6, 'assistant_message.started', agentActor),
          runId: 'run-edited',
          messageId: 'assistant-edited',
          parentMessageId: 'user-edited',
          providerId: 'test',
          modelId: 'test',
        },
        {
          ...base(sessionId, 7, 'assistant_message.completed', agentActor),
          messageId: 'assistant-edited',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'API keys are the active decision.' }],
        },
      ]);

      const oauth = await service.search({ query: 'OAuth', includeCurrentSession: true });
      expect(oauth.mode).toBe('search');
      if (oauth.mode !== 'search') throw new Error('Expected search result');
      expect(oauth.hits).toEqual([]);

      const apiKeys = await service.search({ query: 'API keys', includeCurrentSession: true });
      expect(apiKeys.mode).toBe('search');
      if (apiKeys.mode !== 'search') throw new Error('Expected search result');
      expect(apiKeys.hits.map((hit) => hit.messageId)).toEqual(['assistant-edited', 'user-edited']);
    });
  });

  test('search excludes the current session unless explicitly included', async () => {
    await withStore(async (store, service) => {
      const sessionId = 'session-current';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Current' },
        {
          ...base(sessionId, 2, 'user_message.created', userActor),
          messageId: 'user-current',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Remember the graphite palette' }],
        },
      ]);

      const hidden = await service.search({ query: 'graphite' }, { currentSessionId: sessionId });
      expect(hidden.mode).toBe('search');
      if (hidden.mode !== 'search') throw new Error('Expected search result');
      expect(hidden.hits).toEqual([]);

      const shown = await service.search(
        { query: 'graphite', includeCurrentSession: true },
        { currentSessionId: sessionId },
      );
      expect(shown.mode).toBe('search');
      if (shown.mode !== 'search') throw new Error('Expected search result');
      expect(shown.hits.map((hit) => hit.messageId)).toEqual(['user-current']);
    });
  });

  test('read can recover compacted current-session history when opted in', async () => {
    await withStore(async (store, service) => {
      const sessionId = 'session-compact';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Compacted' },
        {
          ...base(sessionId, 2, 'user_message.created', userActor),
          messageId: 'user-before-compact',
          parentMessageId: null,
          content: [{ type: 'text', text: 'We chose cobalt blue for focus rings' }],
        },
        {
          ...base(sessionId, 3, 'assistant_message.started', agentActor),
          runId: 'run-before',
          messageId: 'assistant-before-compact',
          parentMessageId: 'user-before-compact',
          providerId: 'test',
          modelId: 'test',
        },
        {
          ...base(sessionId, 4, 'assistant_message.completed', agentActor),
          messageId: 'assistant-before-compact',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Cobalt blue is the focus-ring choice.' }],
        },
        {
          ...base(sessionId, 5, 'compaction.completed'),
          messageId: 'compact-root',
          summary: 'Focus ring choice was preserved.',
          compactedThroughMessageId: 'assistant-before-compact',
          trigger: 'manual',
        },
        {
          ...base(sessionId, 6, 'user_message.created', systemActor),
          messageId: 'compact-root',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Conversation compacted.' }],
        },
      ]);

      const blocked = await service.read({ messageId: 'user-before-compact' }, { currentSessionId: sessionId });
      expect(blocked).toMatchObject({ mode: 'error', code: 'SESSION_IS_CURRENT' });

      const read = await service.read(
        { messageId: 'user-before-compact', includeCurrentSession: true },
        { currentSessionId: sessionId },
      );
      expect(read.mode).toBe('read');
      if (read.mode !== 'read') throw new Error('Expected read result');
      expect(read.messages.map((message) => message.messageId)).toContain('user-before-compact');
      expect(read.messages.map((message) => message.text).join('\n')).toContain('cobalt blue');
    });
  });

  test('read uses persisted tool result summaries instead of raw payload-sized content', async () => {
    await withStore(async (store, service) => {
      const sessionId = 'session-tool';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Tool output' },
        {
          ...base(sessionId, 2, 'assistant_message.started', agentActor),
          runId: 'run-tool',
          messageId: 'assistant-tool',
          parentMessageId: null,
          providerId: 'test',
          modelId: 'test',
        },
        {
          ...base(sessionId, 3, 'assistant_message.completed', agentActor),
          messageId: 'assistant-tool',
          stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'tool-1', name: 'bash', arguments: {} }],
        },
        {
          ...base(sessionId, 4, 'tool_result.created', { type: 'tool', toolName: 'bash', toolCallId: 'tool-1' }),
          messageId: 'tool-result-1',
          parentMessageId: 'assistant-tool',
          toolCallId: 'tool-1',
          toolName: 'bash',
          isError: false,
          content: [{ type: 'text', text: `raw ${'x'.repeat(1000)}` }],
          outputSummary: 'short bash summary',
        },
      ]);

      const read = await service.read({ messageId: 'tool-result-1', includeCurrentSession: true });
      expect(read.mode).toBe('read');
      if (read.mode !== 'read') throw new Error('Expected read result');
      expect(read.messages.find((message) => message.messageId === 'tool-result-1')).toMatchObject({
        text: 'short bash summary',
        toolName: 'bash',
      });
    });
  });

  test('recent returns visible user message anchors with system reminders stripped', async () => {
    await withStore(async (store, service) => {
      const sessionId = 'session-recent';
      const currentSessionId = 'session-current-recent';
      const longUserText = `Please continue the agent-past-chats API plan. ${'detail '.repeat(80)}`.trim();
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Recent history' },
        {
          ...base(sessionId, 2, 'user_message.created', userActor),
          messageId: 'user-recent',
          parentMessageId: null,
          content: [
            { type: 'text', text: '<system-reminder>hidden runtime context</system-reminder>' },
            { type: 'text', text: longUserText },
          ],
        },
        {
          ...base(sessionId, 3, 'assistant_message.started', agentActor),
          runId: 'run-recent',
          messageId: 'assistant-recent',
          parentMessageId: 'user-recent',
          providerId: 'test',
          modelId: 'test',
        },
        {
          ...base(sessionId, 4, 'assistant_message.completed', agentActor),
          messageId: 'assistant-recent',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Continuing the plan.' }],
        },
      ]);
      await store.appendEvents(currentSessionId, [
        { ...base(currentSessionId, 1, 'session.created'), title: 'Current' },
        {
          ...base(currentSessionId, 2, 'user_message.created', userActor),
          messageId: 'user-current-recent',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Do not show this current-session message' }],
        },
      ]);

      const recent = await service.recent(
        { maxMessageChars: 80 },
        { currentSessionId },
      );
      expect(recent.mode).toBe('recent');
      if (recent.mode !== 'recent') throw new Error('Expected recent result');
      expect(recent.items.map((item) => item.messageId)).toEqual(['user-recent']);
      expect(recent.items[0]?.text).toContain('agent-past-chats API plan');
      expect(recent.items[0]?.text).not.toContain('system-reminder');
      expect(recent.items[0]?.text).not.toContain('hidden runtime context');
      expect(recent.items[0]?.textTruncated).toBe(true);

      const read = await service.read({ messageId: 'user-recent', includeCurrentSession: true });
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
      expect(visibleSearch.hits[0]?.snippet).toContain('agent-past-chats');
      expect(visibleSearch.hits[0]?.snippet).not.toContain('system-reminder');
    });
  });

  test('tool wrapper returns structured recoverable mode errors', async () => {
    await withStore(async (_store, service) => {
      const tool = createPastChatsTool({ service, currentSessionId: () => 'session-current' });
      const result = await (tool.execute as any)('tool-call-1', { query: 'x', message_id: 'm_x' });
      const details = result.details as ToolEnvelope;

      expect(details.ok).toBe(false);
      expect(details.data).toMatchObject({ mode: 'error', code: 'AMBIGUOUS_MODE' });
      expect(result.content[0]?.text).toContain('"tool": "past_chats"');
      const first = result.content[0];
      if (!first || first.type !== 'text') throw new Error('Expected model-visible text envelope');
      expect(JSON.parse(first.text)).toMatchObject({
        ok: false,
        tool: 'past_chats',
        status: 'error',
        data: {
          mode: 'error',
          code: 'AMBIGUOUS_MODE',
        },
      });
      expect(result.content[1]?.text).toContain('Error: AMBIGUOUS_MODE');
    });
  });

  test('tool wrapper returns snake_case model-visible summaries', async () => {
    await withStore(async (store, service) => {
      const sessionId = 'session-api';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'API shape' },
        {
          ...base(sessionId, 2, 'user_message.created', userActor),
          messageId: 'user-api',
          parentMessageId: null,
          content: [{ type: 'text', text: 'We chose sqlite checkpoints for past chats' }],
        },
      ]);

      const tool = createPastChatsTool({ service, currentSessionId: () => 'session-current' });
      const result = await (tool.execute as any)('tool-call-1', { query: 'sqlite' });
      const first = result.content[0];
      if (!first || first.type !== 'text') throw new Error('Expected model-visible text envelope');
      const visible = JSON.parse(first.text);

      expect(visible.data).toMatchObject({
        mode: 'search',
        total_hits: 1,
        returned_hits: 1,
        message_ids: ['user-api'],
      });
      expect(visible.data.totalHits).toBeUndefined();
      expect(visible.data.messageIds).toBeUndefined();
      expect(visible.instructions).toContain('message_id');
      expect(visible.instructions).not.toContain('messageId');
    });
  });

  test('tool wrapper returns recent user messages as navigation items', async () => {
    await withStore(async (store, service) => {
      const sessionId = 'session-recent-wrapper';
      await store.appendEvents(sessionId, [
        { ...base(sessionId, 1, 'session.created'), title: 'Recent wrapper' },
        {
          ...base(sessionId, 2, 'user_message.created', userActor),
          messageId: 'user-wrapper',
          parentMessageId: null,
          content: [{ type: 'text', text: 'Review the unified past_chats API style' }],
        },
      ]);

      const tool = createPastChatsTool({ service, currentSessionId: () => 'session-current' });
      const result = await (tool.execute as any)('tool-call-1', { recent: true, max_message_chars: 20 });
      const first = result.content[0];
      if (!first || first.type !== 'text') throw new Error('Expected model-visible text envelope');
      const visible = JSON.parse(first.text);

      expect(visible.data).toMatchObject({
        mode: 'recent',
        total_items: 1,
        returned_items: 1,
        items: [{
          message_id: 'user-wrapper',
          session_id: sessionId,
          text_truncated: true,
        }],
      });
      expect(visible.data.items[0].text).toContain('Review the');
      expect(visible.instructions).toContain('message_id');
      expect(result.content[1]?.text).toContain('Next: call past_chats with message_id');
    });
  });

  test('tool wrapper guides empty search without claiming missing history', async () => {
    await withStore(async (_store, service) => {
      const tool = createPastChatsTool({ service, currentSessionId: () => 'session-current' });
      const result = await (tool.execute as any)('tool-call-1', {
        query: 'conversation history topics discussed',
      });
      const first = result.content[0];
      if (!first || first.type !== 'text') throw new Error('Expected model-visible text envelope');
      const visible = JSON.parse(first.text);

      expect(visible).toMatchObject({
        ok: true,
        tool: 'past_chats',
        status: 'success',
        data: {
          mode: 'search',
          total_hits: 0,
          returned_hits: 0,
          message_ids: [],
        },
      });
      expect(visible.instructions).toContain('Do not claim this is the first conversation');
      expect(result.content[1]?.text).toContain('does not prove there is no chat history');
      expect(result.content[1]?.text).toContain('ask for a keyword');
    });
  });
});
