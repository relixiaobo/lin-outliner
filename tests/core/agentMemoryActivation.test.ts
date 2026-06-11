import { describe, expect, test } from 'bun:test';
import type { AgentMemoryEntry } from '../../src/core/agentEventLog';
import {
  buildMemoryOverview,
  mergeMemoryOverviews,
  orderMemoryEntriesForBriefing,
  rankMemoryEntriesByActivation,
  type AgentMemoryOverview,
} from '../../src/core/agentMemoryActivation';

function entry(id: string, fact: string, createdAt = 1): AgentMemoryEntry {
  return {
    id,
    principal: { type: 'agent', agentId: 'built-in:tenon:assistant' },
    fact,
    sources: [{
      stream: 'conversation',
      streamId: 'conversation-1',
      range: {
        fromSeqExclusive: 1,
        throughSeq: 2,
        throughEventId: 'conversation-1-event-2',
      },
    }],
    status: 'active',
    createdAt,
  };
}

function overview(
  label: string,
  input: Partial<AgentMemoryOverview['schema'][number]> = {},
): AgentMemoryOverview {
  const id = input.id ?? `memory-schema:${label}`;
  return {
    generatedAt: 100,
    totalEntries: input.entryCount ?? 1,
    schema: [{
      id,
      label,
      memoryIds: input.memoryIds ?? [`memory-${label}`],
      entryCount: input.entryCount ?? 1,
      storageStrength: input.storageStrength ?? 1,
      retrievalStrength: input.retrievalStrength ?? 1,
    }],
  };
}

describe('agent memory activation', () => {
  test('keeps newest unbriefed facts from being starved by hardened resident entries', () => {
    const now = 1_800_000_000_000;
    const hardened = Array.from({ length: 12 }, (_, index) => (
      entry(`memory-hardened-${index}`, `keeps established resident fact ${index}`, now - 90 * 24 * 60 * 60 * 1000 + index)
    ));
    const newest = entry('memory-new-fact', 'needs a first resident briefing chance', now);
    const accessStats = new Map(hardened.map((item) => [item.id, {
      briefingCount: 50,
      recallCount: 0,
      lastBriefingAt: now,
      lastRecallAt: null,
    }]));

    const ranked = rankMemoryEntriesByActivation([...hardened, newest], accessStats, now);
    expect(ranked.slice(0, 12).map((item) => item.entry.id)).not.toContain(newest.id);

    const resident = orderMemoryEntriesForBriefing(ranked, { now }).slice(0, 12).map((item) => item.entry.id);
    expect(resident).toContain(newest.id);
    expect(resident.indexOf(newest.id)).toBeLessThanOrEqual(4);
  });

  test('builds Unicode schema labels instead of collapsing CJK facts to general', () => {
    const ranked = rankMemoryEntriesByActivation([
      entry('memory-cn-1', '偏好简洁代码评审', 1),
      entry('memory-cn-2', '需要代码审查记录', 2),
    ], new Map(), 100);

    const result = buildMemoryOverview(ranked, { generatedAt: 100 });
    const codeNode = result.schema.find((node) => node.label === '代码');

    expect(codeNode).toMatchObject({
      id: 'memory-schema:代码',
      entryCount: 2,
    });
    expect(codeNode?.memoryIds.sort()).toEqual(['memory-cn-1', 'memory-cn-2']);
    expect(result.schema.map((node) => node.label)).not.toEqual(['general']);
  });

  test('merges full pool overviews independently from capped fact-entry lists', () => {
    const result = mergeMemoryOverviews([
      overview('reviews', {
        memoryIds: ['memory-1', 'memory-2'],
        entryCount: 2,
        storageStrength: 3,
        retrievalStrength: 4,
      }),
      overview('代码', {
        memoryIds: ['memory-3'],
        entryCount: 1,
        storageStrength: 5,
        retrievalStrength: 2,
      }),
      overview('reviews', {
        memoryIds: ['memory-4'],
        entryCount: 1,
        storageStrength: 7,
        retrievalStrength: 8,
      }),
    ], { generatedAt: 200 });

    expect(result.generatedAt).toBe(200);
    expect(result.totalEntries).toBe(4);
    expect(result.schema).toMatchObject([
      {
        id: 'memory-schema:reviews',
        label: 'reviews',
        memoryIds: ['memory-1', 'memory-2', 'memory-4'],
        entryCount: 3,
        storageStrength: 10,
        retrievalStrength: 12,
      },
      {
        id: 'memory-schema:代码',
        label: '代码',
        memoryIds: ['memory-3'],
        entryCount: 1,
        storageStrength: 5,
        retrievalStrength: 2,
      },
    ]);
  });
});
