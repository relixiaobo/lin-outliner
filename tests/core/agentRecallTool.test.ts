import { describe, expect, test } from 'bun:test';
import type { AgentMemoryEntry, AgentMemorySource } from '../../src/core/agentEventLog';
import { createRecallTool, type AgentRecallToolRuntime } from '../../src/main/agentRecallTool';

function entry(id: string, fact: string, createdAt = 10): AgentMemoryEntry {
  return {
    id,
    principal: { type: 'agent', agentId: 'built-in:tenon:assistant' },
    fact,
    sources: [{
      conversationId: 'conversation-1',
      messageRange: ['user-1', 'assistant-1'],
      runId: 'run-1',
      eventId: 'event-1',
    }],
    status: 'active',
    createdAt,
  };
}

function visibleData(result: Awaited<ReturnType<ReturnType<typeof createRecallTool>['execute']>>) {
  const content = result.content[0];
  if (!content || content.type !== 'text') throw new Error('Expected text content');
  return JSON.parse(content.text) as unknown;
}

describe('agent recall tool', () => {
  test('returns slim active durable memory entries', async () => {
    const runtime: AgentRecallToolRuntime = {
      recall: async () => ({
        entries: [{ entry: entry('memory-1', 'User prefers concise answers.', 20) }],
        totalEntries: 1,
      }),
    };
    const tool = createRecallTool(runtime);

    const result = await tool.execute('tool-1', { query: 'concise', limit: 8 });
    expect(result.details).toMatchObject({
      ok: true,
      data: {
        entries: [{
          memoryId: 'memory-1',
          principal: { type: 'agent', agentId: 'built-in:tenon:assistant' },
          fact: 'User prefers concise answers.',
        }],
      },
    });
    expect(visibleData(result)).toEqual({
      ok: true,
      data: {
        entries: [{
          memory_id: 'memory-1',
          // The fact's pool, model-visible so cross-pool results are distinguishable (D-3).
          principal: 'agent:built-in:tenon:assistant',
          fact: 'User prefers concise answers.',
          status: 'active',
          created_at: 20,
          sources: [{
            conversation_id: 'conversation-1',
            message_range: ['user-1', 'assistant-1'],
            run_id: 'run-1',
            event_id: 'event-1',
          }],
        }],
        total_entries: 1,
      },
    });
  });

  test('distinguishes cross-pool results by principal, not by wording', async () => {
    // The #173 membership read returns entries from more than one pool in one result list;
    // without `principal` they are distinguishable only by accidental verb form (D-3).
    const runtime: AgentRecallToolRuntime = {
      recall: async () => ({
        entries: [
          { entry: entry('memory-1', 'prefers terse code reviews') },
          { entry: { ...entry('memory-2', 'prefers terse code reviews'), principal: { type: 'user', userId: 'lixiaobo' } } },
        ],
        totalEntries: 2,
      }),
    };
    const tool = createRecallTool(runtime);

    expect(visibleData(await tool.execute('tool-1', { query: 'reviews' }))).toMatchObject({
      ok: true,
      data: {
        entries: [
          { memory_id: 'memory-1', principal: 'agent:built-in:tenon:assistant' },
          { memory_id: 'memory-2', principal: 'user:lixiaobo' },
        ],
      },
    });
  });

  test('nests evidence under the matching memory entry', async () => {
    const source: AgentMemorySource = {
      conversationId: 'conversation-1',
      messageRange: ['user-1', 'assistant-1'],
    };
    const runtime: AgentRecallToolRuntime = {
      recall: async () => ({
        entries: [{
          entry: { ...entry('memory-1', 'Cobalt was chosen for focus rings.'), sources: [source] },
          evidence: [{
            source,
            conversationId: 'conversation-1',
            messageId: 'user-1',
            role: 'user',
            createdAt: '2026-06-07T00:00:00.000Z',
            text: 'We chose cobalt for focus rings.',
          }],
        }],
        totalEntries: 1,
      }),
    };
    const tool = createRecallTool(runtime);

    expect(visibleData(await tool.execute('tool-1', { include_evidence: true }))).toMatchObject({
      ok: true,
      data: {
        entries: [{
          memory_id: 'memory-1',
          evidence: [{
            source: {
              conversation_id: 'conversation-1',
              message_range: ['user-1', 'assistant-1'],
            },
            message_id: 'user-1',
            text: 'We chose cobalt for focus rings.',
          }],
        }],
      },
    });
  });

  test('reports empty recall without implying history is absent', async () => {
    const runtime: AgentRecallToolRuntime = {
      recall: async () => ({ entries: [], totalEntries: 0 }),
    };
    const tool = createRecallTool(runtime);

    expect(visibleData(await tool.execute('tool-1', { query: 'missing' }))).toEqual({
      ok: true,
      data: {
        entries: [],
        total_entries: 0,
      },
      instructions: "No active semantic memory entries matched this cue. Do not infer that no prior conversation exists; recall covers only the semantic store's active entries (distilled facts), not invalidated entries or the raw episodic record.",
    });
  });
});
