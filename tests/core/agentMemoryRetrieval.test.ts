import { describe, expect, test } from 'bun:test';
import type { AgentMemoryEntry, AgentMemorySource } from '../../src/core/agentEventLog';
import { computeMemoryStrength, orderMemoryEntriesForBriefing } from '../../src/core/agentMemoryActivation';
import {
  rankMemoryEntriesForBriefing,
  rankMemoryEntriesForRecall,
} from '../../src/core/agentMemoryRetrieval';
import {
  analyzeTextSearchQuery,
  normalizeSearchText,
} from '../../src/core/textSearchAnalyzer';

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

function rankLexicalBaselineIds(entries: readonly AgentMemoryEntry[], query: string, now: number): string[] {
  const analysis = analyzeTextSearchQuery(query);
  const terms = analysis.terms.slice(0, 12);
  return entries
    .map((entry) => {
      const score = lexicalBaselineScore(entry, analysis.normalized, terms);
      const strength = computeMemoryStrength(entry, undefined, now);
      return {
        entry,
        score: score * (1 + Math.min(4, strength.retrievalStrength) * 0.12),
        strength,
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => (
      right.score - left.score
      || right.strength.storageStrength - left.strength.storageStrength
      || right.entry.createdAt - left.entry.createdAt
      || right.entry.id.localeCompare(left.entry.id)
    ))
    .map((item) => item.entry.id);
}

function lexicalBaselineScore(entry: AgentMemoryEntry, normalizedQuery: string, terms: readonly string[]): number {
  const fact = normalizeSearchText(entry.fact);
  const id = normalizeSearchText(entry.id);
  let score = 0;
  if (fact.includes(normalizedQuery)) score += 100;
  for (const term of terms) {
    if (fact.includes(term)) score += 10;
    if (id.includes(term)) score += 4;
  }
  return score;
}

describe('agent memory retrieval', () => {
  test('hybrid fixture improves hit-rate over the lexical baseline with co-cited paraphrases', () => {
    const now = 1_800_000_000_000;
    const fixtures = [
      {
        query: 'compact status updates',
        relevantIds: ['m1', 'm2'],
        paraphraseId: 'm2',
        entries: [
          memory('m1', 'prefers compact status updates', [episode('episode-status')], now - 10),
          memory('m2', 'keeps progress notes short', [episode('episode-status')], now - 9),
          memory('m3', 'uses amber focus rings', [episode('episode-focus')], now - 8),
        ],
      },
      {
        query: 'keyboard focus ring',
        relevantIds: ['m4', 'm5'],
        paraphraseId: 'm5',
        entries: [
          memory('m4', 'uses keyboard focus rings for navigation checks', [episode('episode-focus')], now - 7),
          memory('m5', 'prefers visible tab outlines in accessibility reviews', [episode('episode-focus')], now - 6),
          memory('m6', 'keeps project plans concise', [episode('episode-plans')], now - 5),
        ],
      },
    ];

    let lexicalTotal = 0;
    let hybridTotal = 0;
    for (const fixture of fixtures) {
      const lexical = rankLexicalBaselineIds(fixture.entries, fixture.query, now);
      const hybrid = rankMemoryEntriesForRecall(fixture.entries, { query: fixture.query, now })
        .map((item) => item.entry.id);

      lexicalTotal += hitRate(lexical, fixture.relevantIds, 2);
      hybridTotal += hitRate(hybrid, fixture.relevantIds, 2);
      expect(lexical.slice(0, 2)).not.toContain(fixture.paraphraseId);
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

  test('keeps briefing on the chronic activation path and boosts co-cited facts without a query cue', () => {
    const now = 1_800_000_000_000;
    const practiced = memory('memory-practiced', 'retrieved fact should be accessible', [episode('episode-practiced')], now - 90 * 24 * 60 * 60 * 1000);
    const coCited = memory('memory-co-cited', 'same episode detail should travel with the accessible fact', [episode('episode-practiced')], now - 89 * 24 * 60 * 60 * 1000);
    const unrelated = memory('memory-unrelated', 'unrelated newer fact has no source association', [episode('episode-other')], now - 88 * 24 * 60 * 60 * 1000);
    const ranked = rankMemoryEntriesForBriefing([unrelated, coCited, practiced], new Map([[
      practiced.id,
      {
        briefingCount: 0,
        recallCount: 3,
        lastBriefingAt: null,
        lastRecallAt: now,
      },
    ]]), now);
    const rankedIds = ranked.map((item) => item.entry.id);
    const residentIds = orderMemoryEntriesForBriefing(ranked, { now }).map((item) => item.entry.id);

    expect(ranked[0]?.entry.id).toBe(practiced.id);
    expect(ranked[0]?.strength.recallCount).toBe(3);
    expect(rankedIds.indexOf(coCited.id)).toBeLessThan(rankedIds.indexOf(unrelated.id));
    expect(residentIds.indexOf(coCited.id)).toBeLessThan(residentIds.indexOf(unrelated.id));
  });
});
