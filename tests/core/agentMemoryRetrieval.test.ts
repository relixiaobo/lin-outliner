import { describe, expect, test } from 'bun:test';
import type { AgentMemoryEntry, AgentMemorySource } from '../../src/core/agentEventLog';
import {
  rankMemoryEntriesByLexicalBaseline,
  rankMemoryEntriesForBriefing,
  rankMemoryEntriesForRecall,
} from '../../src/core/agentMemoryRetrieval';

const principal = { type: 'agent', agentId: 'built-in:tenon:assistant' } as const;

function memory(id: string, fact: string, sources: AgentMemorySource[], createdAt = 100): AgentMemoryEntry {
  return {
    id,
    principal,
    fact,
    sources,
    status: 'active',
    createdAt,
  };
}

function episode(episodeId: string): AgentMemorySource {
  return { episodeId };
}

function hitRate(rankedIds: readonly string[], relevantIds: readonly string[], limit: number): number {
  const top = new Set(rankedIds.slice(0, limit));
  return relevantIds.filter((id) => top.has(id)).length / relevantIds.length;
}

describe('agent memory retrieval', () => {
  test('hybrid fixture improves hit-rate over the lexical baseline with co-cited paraphrases', () => {
    const now = 1_800_000_000_000;
    const fixtures = [
      {
        query: 'compact status updates',
        relevantIds: ['memory-status-seed', 'memory-status-paraphrase'],
        entries: [
          memory('memory-status-seed', 'prefers compact status updates', [episode('episode-status')], now - 10),
          memory('memory-status-paraphrase', 'keeps progress notes short', [episode('episode-status')], now - 9),
          memory('memory-status-distractor', 'uses amber focus rings', [episode('episode-focus')], now - 8),
        ],
      },
      {
        query: 'keyboard focus ring',
        relevantIds: ['memory-focus-seed', 'memory-focus-paraphrase'],
        entries: [
          memory('memory-focus-seed', 'uses keyboard focus rings for navigation checks', [episode('episode-focus')], now - 7),
          memory('memory-focus-paraphrase', 'prefers visible tab outlines in accessibility reviews', [episode('episode-focus')], now - 6),
          memory('memory-focus-distractor', 'keeps project plans concise', [episode('episode-plans')], now - 5),
        ],
      },
    ];

    let lexicalTotal = 0;
    let hybridTotal = 0;
    for (const fixture of fixtures) {
      const lexical = rankMemoryEntriesByLexicalBaseline(fixture.entries, fixture.query, new Map(), now)
        .map((item) => item.entry.id);
      const hybrid = rankMemoryEntriesForRecall(fixture.entries, { query: fixture.query, now })
        .map((item) => item.entry.id);

      lexicalTotal += hitRate(lexical, fixture.relevantIds, 2);
      hybridTotal += hitRate(hybrid, fixture.relevantIds, 2);
      expect(hybrid.slice(0, 2).sort()).toEqual([...fixture.relevantIds].sort());
    }

    expect(hybridTotal).toBeGreaterThan(lexicalTotal);
  });

  test('uses BM25-style lexical scoring before association expansion', () => {
    const entries = [
      memory('memory-single-term', 'retrieval appears once here', [episode('episode-a')], 1),
      memory('memory-full-match', 'memory retrieval ranking uses lexical relevance', [episode('episode-b')], 2),
    ];

    const ranked = rankMemoryEntriesForRecall(entries, { query: 'memory retrieval ranking', now: 100 });

    expect(ranked.map((item) => item.entry.id)).toEqual([
      'memory-full-match',
      'memory-single-term',
    ]);
    expect(ranked[0]?.lexicalScore).toBeGreaterThan(ranked[1]?.lexicalScore ?? 0);
  });

  test('keeps briefing on the chronic activation path without a query cue', () => {
    const now = 1_800_000_000_000;
    const fresh = memory('memory-fresh', 'new fact needs a first briefing chance', [episode('episode-fresh')], now);
    const practiced = memory('memory-practiced', 'retrieved fact should be accessible', [episode('episode-practiced')], now - 90 * 24 * 60 * 60 * 1000);
    const ranked = rankMemoryEntriesForBriefing([fresh, practiced], new Map([[
      practiced.id,
      {
        briefingCount: 0,
        recallCount: 3,
        lastBriefingAt: null,
        lastRecallAt: now,
      },
    ]]), now);

    expect(ranked[0]?.entry.id).toBe(practiced.id);
    expect(ranked[0]?.strength.recallCount).toBe(3);
  });
});
