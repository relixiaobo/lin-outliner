import { describe, expect, test } from 'bun:test';
import type { AgentMemoryEntry } from '../../src/core/agentEventLog';
import { createMemoryTool, type AgentMemoryToolRuntime } from '../../src/main/agentMemoryTool';

function entry(id: string, fact: string, createdAt = 10): AgentMemoryEntry {
  return {
    id,
    agentId: 'built-in:tenon:assistant',
    fact,
    sources: [{ conversationId: 'conversation-1' }],
    status: 'active',
    createdAt,
  };
}

function visibleData(result: Awaited<ReturnType<ReturnType<typeof createMemoryTool>['execute']>>) {
  const content = result.content[0];
  if (!content || content.type !== 'text') throw new Error('Expected text content');
  return JSON.parse(content.text) as unknown;
}

describe('agent memory tool', () => {
  test('remembers and lists slim model-visible entries', async () => {
    const entries: AgentMemoryEntry[] = [];
    const runtime: AgentMemoryToolRuntime = {
      list: async ({ limit }) => entries.slice(0, limit),
      remember: async (fact) => {
        const next = entry('memory-1', fact, 20);
        entries.push(next);
        return next;
      },
      update: async () => null,
      forget: async () => null,
    };
    const tool = createMemoryTool(runtime);

    const remembered = await tool.execute('tool-1', { action: 'remember', fact: 'User prefers concise answers.' });
    expect(remembered.details).toMatchObject({
      ok: true,
      data: { action: 'remember', entry: { memoryId: 'memory-1', fact: 'User prefers concise answers.' } },
    });
    expect(visibleData(remembered)).toEqual({
      ok: true,
      data: {
        entry: {
          memory_id: 'memory-1',
          fact: 'User prefers concise answers.',
          status: 'active',
          created_at: 20,
        },
      },
      instructions: 'The fact is now available in future conversation memory reminders.',
    });

    const listed = await tool.execute('tool-2', { action: 'list', limit: 10 });
    expect(visibleData(listed)).toEqual({
      ok: true,
      data: {
        entries: [{
          memory_id: 'memory-1',
          fact: 'User prefers concise answers.',
          status: 'active',
          created_at: 20,
        }],
        total_entries: 1,
      },
    });
  });

  test('updates, forgets, and reports missing parameters', async () => {
    let current = entry('memory-1', 'Original fact.');
    const runtime: AgentMemoryToolRuntime = {
      list: async () => [current],
      remember: async () => current,
      update: async (memoryId, fact) => {
        if (memoryId !== current.id) return null;
        current = { ...current, fact };
        return current;
      },
      forget: async (memoryId) => {
        if (memoryId !== current.id) return null;
        current = { ...current, status: 'invalidated' };
        return current;
      },
    };
    const tool = createMemoryTool(runtime);

    const updated = await tool.execute('tool-1', {
      action: 'update',
      memory_id: 'memory-1',
      fact: 'Updated fact.',
    });
    expect(updated.details).toMatchObject({
      ok: true,
      data: { action: 'update', entry: { memoryId: 'memory-1', fact: 'Updated fact.' } },
    });

    const forgotten = await tool.execute('tool-2', { action: 'forget', memory_id: 'memory-1' });
    expect(forgotten.details).toMatchObject({
      ok: true,
      data: { action: 'forget', memoryId: 'memory-1', invalidated: true },
    });

    const invalid = await tool.execute('tool-3', { action: 'remember' });
    expect(visibleData(invalid)).toEqual({
      ok: false,
      error: { code: 'MISSING_FACT', message: 'Pass fact for remember.' },
    });
  });
});
