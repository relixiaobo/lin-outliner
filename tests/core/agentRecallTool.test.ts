import { describe, expect, test } from 'bun:test';
import type { AgentMemoryEntry, AgentMemorySource } from '../../src/core/agentEventLog';
import { createRecallTool, type AgentRecallToolRuntime } from '../../src/main/agentRecallTool';

function entry(id: string, fact: string, createdAt = 10): AgentMemoryEntry {
  return {
    id,
    principal: { type: 'agent', agentId: 'built-in:tenon:assistant' },
    fact,
    sources: [{
      stream: 'conversation',
      streamId: 'conversation-1',
      range: {
        fromSeqExclusive: 1,
        throughSeq: 4,
        throughEventId: 'event-4',
      },
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

const READER = { type: 'agent', agentId: 'built-in:tenon:assistant' } as const;

describe('agent recall tool', () => {
  test('returns slim active durable memory entries', async () => {
    const runtime: AgentRecallToolRuntime = {
      reader: READER,
      recall: async () => ({
        entries: [{ entry: entry('memory-1', 'prefers concise answers', 20) }],
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
          fact: 'prefers concise answers',
        }],
      },
    });
    expect(visibleData(result)).toEqual({
      ok: true,
      data: {
        entries: [{
          memory_id: 'memory-1',
          // The fact's pool named reader-relatively, so cross-pool results are
          // distinguishable in the briefing's own vocabulary (D-3 + #183 gate round).
          subject: 'self',
          fact: 'prefers concise answers',
          status: 'active',
          created_at: 20,
          sources: [{
            stream: 'conversation',
            stream_id: 'conversation-1',
            range: {
              from_seq_exclusive: 1,
              through_seq: 4,
              through_event_id: 'event-4',
            },
          }],
        }],
        total_entries: 1,
      },
    });
  });

  test('distinguishes cross-pool results by reader-relative subject, not by wording', async () => {
    // The #173 membership read returns entries from more than one pool in one result list;
    // without `subject` they are distinguishable only by accidental verb form (D-3). The
    // subject speaks the briefing's zone vocabulary — never a raw internal principal key.
    const runtime: AgentRecallToolRuntime = {
      reader: READER,
      recall: async () => ({
        entries: [
          { entry: entry('memory-1', 'prefers terse code reviews') },
          { entry: { ...entry('memory-2', 'prefers terse code reviews'), principal: { type: 'user', userId: 'lixiaobo' } } },
        ],
        totalEntries: 2,
      }),
    };
    const tool = createRecallTool(runtime);

    const visible = visibleData(await tool.execute('tool-1', { query: 'reviews' }));
    expect(visible).toMatchObject({
      ok: true,
      data: {
        entries: [
          { memory_id: 'memory-1', subject: 'self' },
          { memory_id: 'memory-2', subject: 'The user' },
        ],
      },
    });
    // No internal principal keys reach the model.
    expect(JSON.stringify(visible)).not.toContain('agent:built-in');
    expect(JSON.stringify(visible)).not.toContain('user:lixiaobo');
  });

  test('nests evidence under the matching memory entry', async () => {
    const source: AgentMemorySource = {
      stream: 'conversation',
      streamId: 'conversation-1',
      range: {
        fromSeqExclusive: 1,
        throughSeq: 4,
        throughEventId: 'event-4',
      },
    };
    const runtime: AgentRecallToolRuntime = {
      reader: READER,
      recall: async () => ({
        entries: [{
          entry: { ...entry('memory-1', 'uses cobalt for focus rings'), sources: [source] },
          evidence: [{
            kind: 'raw_span',
            source,
            rawSource: source,
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
            kind: 'raw_span',
            source: {
              stream: 'conversation',
              stream_id: 'conversation-1',
              range: {
                from_seq_exclusive: 1,
                through_seq: 4,
                through_event_id: 'event-4',
              },
            },
            raw_source: {
              stream: 'conversation',
              stream_id: 'conversation-1',
              range: {
                from_seq_exclusive: 1,
                through_seq: 4,
                through_event_id: 'event-4',
              },
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
      reader: READER,
      recall: async () => ({ entries: [], totalEntries: 0 }),
    };
    const tool = createRecallTool(runtime);

    expect(visibleData(await tool.execute('tool-1', { query: 'missing' }))).toEqual({
      ok: true,
      data: {
        entries: [],
        total_entries: 0,
      },
      instructions: "No active semantic memory entries matched this cue. Do not infer that no prior conversation exists; recall covers only the semantic store's active entries (distilled facts), not invalidated entries or the raw record.",
    });
  });
});
