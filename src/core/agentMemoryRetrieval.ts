import type { AgentMemoryEntry, AgentMemorySource } from './agentEventLog';
import { principalKey } from './agentEventLog';
import {
  computeMemoryStrength,
  rankMemoryEntriesByActivation,
  type AgentMemoryAccessStats,
  type AgentMemoryRankedEntry,
  type AgentMemoryStrength,
} from './agentMemoryActivation';
import {
  analyzeTextSearchQuery,
  isTextSearchGramTerm,
  normalizeSearchText,
  tokenizeSearchText,
  uniqueTextSearchTerms,
} from './textSearchAnalyzer';

const QUERY_TERM_LIMIT = 12;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const EXACT_PHRASE_BOOST = 4;
const ID_TERM_BOOST = 0.35;
const RETRIEVAL_STRENGTH_WEIGHT = 0.12;
const RETRIEVAL_STRENGTH_CAP = 4;
const ASSOCIATION_SEED_LIMIT = 8;
const ASSOCIATION_WEIGHT = 0.38;
const ASSOCIATION_MAX_BOOST = 6;
const BRIEFING_ASSOCIATION_WEIGHT = 0.22;
const BRIEFING_ASSOCIATION_MAX_BOOST = 3;

interface IndexedMemoryEntry {
  entry: AgentMemoryEntry;
  strength: AgentMemoryStrength;
  normalizedFact: string;
  normalizedId: string;
  terms: Map<string, number>;
  length: number;
}

interface SourceAssociationEntry {
  entry: AgentMemoryEntry;
  strength: AgentMemoryStrength;
}

export interface AgentHybridMemoryRankedEntry extends AgentMemoryRankedEntry {
  lexicalScore: number;
  associationScore: number;
  score: number;
}

export function rankMemoryEntriesForRecall(
  entries: readonly AgentMemoryEntry[],
  options: {
    query?: string;
    accessStatsByEntryId?: ReadonlyMap<string, AgentMemoryAccessStats>;
    now?: number;
  } = {},
): AgentHybridMemoryRankedEntry[] {
  const fallback = fallbackSort(entries, options.accessStatsByEntryId, options.now);
  const query = options.query?.trim();
  if (!query || normalizeSearchText(query).length === 0) return fallback;

  const analysis = analyzeTextSearchQuery(query);
  const queryTerms = limitedQueryTerms(query);
  if (analysis.normalized.length === 0 || queryTerms.length === 0) return fallback;

  const indexed = indexEntries(entries, options.accessStatsByEntryId, options.now);
  const documentFrequency = documentFrequencies(indexed, queryTerms);
  const averageLength = averageDocumentLength(indexed);
  const direct = indexed.map((item) => {
    const lexicalScore = bm25Score(item, queryTerms, documentFrequency, indexed.length, averageLength)
      + phraseBoost(item.normalizedFact, analysis.normalized, queryTerms.length)
      + idBoost(item.normalizedId, queryTerms);
    const strengthMultiplier = 1 + Math.min(RETRIEVAL_STRENGTH_CAP, item.strength.retrievalStrength) * RETRIEVAL_STRENGTH_WEIGHT;
    return {
      entry: item.entry,
      strength: item.strength,
      lexicalScore,
      associationScore: 0,
      score: lexicalScore * strengthMultiplier,
    };
  });

  const associations = associationScores(direct, sourceIndex(indexed), {
    weight: ASSOCIATION_WEIGHT,
    maxBoost: ASSOCIATION_MAX_BOOST,
  });
  return direct
    .map((item) => {
      const associationScore = associations.get(entryKey(item.entry)) ?? 0;
      return {
        ...item,
        associationScore,
        score: item.score + associationScore,
      };
    })
    .filter((item) => item.score > 0)
    .sort(compareHybridRankedEntries);
}

export function rankMemoryEntriesForBriefing(
  entries: readonly AgentMemoryEntry[],
  accessStatsByEntryId: ReadonlyMap<string, AgentMemoryAccessStats>,
  now = Date.now(),
): AgentMemoryRankedEntry[] {
  const activated = rankMemoryEntriesByActivation(entries, accessStatsByEntryId, now);
  const direct = activated.map((item) => ({
    entry: item.entry,
    strength: item.strength,
    lexicalScore: 0,
    associationScore: 0,
    score: residentActivationScore(item),
  }));
  const associations = associationScores(direct, sourceIndex(direct), {
    weight: BRIEFING_ASSOCIATION_WEIGHT,
    maxBoost: BRIEFING_ASSOCIATION_MAX_BOOST,
  });
  return direct
    .map((item) => ({
      ...item,
      associationScore: associations.get(entryKey(item.entry)) ?? 0,
    }))
    .map((item) => ({
      ...item,
      score: item.score + item.associationScore,
    }))
    .sort(compareHybridRankedEntries)
    .map((item) => ({ entry: item.entry, strength: item.strength, rankScore: item.score }));
}

function indexEntries(
  entries: readonly AgentMemoryEntry[],
  accessStatsByEntryId: ReadonlyMap<string, AgentMemoryAccessStats> = new Map(),
  now = Date.now(),
): IndexedMemoryEntry[] {
  return entries.map((entry) => {
    const terms = termCounts(entry.fact);
    return {
      entry,
      strength: computeMemoryStrength(entry, accessStatsByEntryId.get(entry.id), now),
      normalizedFact: normalizeSearchText(entry.fact),
      normalizedId: normalizeSearchText(entry.id),
      terms,
      length: Math.max(1, [...terms.values()].reduce((sum, count) => sum + count, 0)),
    };
  });
}

function bm25Score(
  item: IndexedMemoryEntry,
  queryTerms: readonly string[],
  documentFrequency: ReadonlyMap<string, number>,
  totalDocuments: number,
  averageLength: number,
): number {
  if (totalDocuments === 0) return 0;
  let score = 0;
  for (const term of queryTerms) {
    const frequency = item.terms.get(term) ?? 0;
    if (frequency === 0) continue;
    const matchingDocuments = documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (totalDocuments - matchingDocuments + 0.5) / (matchingDocuments + 0.5));
    const denominator = frequency + BM25_K1 * (1 - BM25_B + BM25_B * (item.length / averageLength));
    score += idf * ((frequency * (BM25_K1 + 1)) / denominator);
  }
  return score;
}

function associationScores(
  ranked: readonly AgentHybridMemoryRankedEntry[],
  sourcesByKey: ReadonlyMap<string, readonly SourceAssociationEntry[]>,
  options: { weight: number; maxBoost: number },
): Map<string, number> {
  const boosts = new Map<string, number>();
  const seeds = ranked
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.lexicalScore - left.lexicalScore)
    .slice(0, ASSOCIATION_SEED_LIMIT);

  for (const seed of seeds) {
    for (const sourceKey of sourceAssociationKeys(seed.entry.sources)) {
      const related = sourcesByKey.get(sourceKey);
      if (!related || related.length <= 1) continue;
      const groupPenalty = Math.sqrt(related.length);
      const baseBoost = Math.min(options.maxBoost, seed.score * options.weight / groupPenalty);
      for (const item of related) {
        if (entryKey(item.entry) === entryKey(seed.entry)) continue;
        const strengthMultiplier = 1 + Math.min(RETRIEVAL_STRENGTH_CAP, item.strength.retrievalStrength) * (RETRIEVAL_STRENGTH_WEIGHT / 2);
        const key = entryKey(item.entry);
        boosts.set(key, (boosts.get(key) ?? 0) + baseBoost * strengthMultiplier);
      }
    }
  }

  return boosts;
}

function sourceIndex(entries: readonly SourceAssociationEntry[]): Map<string, SourceAssociationEntry[]> {
  const index = new Map<string, SourceAssociationEntry[]>();
  for (const item of entries) {
    for (const sourceKey of sourceAssociationKeys(item.entry.sources)) {
      const current = index.get(sourceKey);
      if (current) {
        current.push(item);
      } else {
        index.set(sourceKey, [item]);
      }
    }
  }
  return index;
}

function sourceAssociationKeys(sources: readonly AgentMemorySource[]): string[] {
  const keys = new Set<string>();
  for (const source of sources) {
    if ('episodeId' in source) {
      keys.add(`episode:${source.episodeId}`);
      continue;
    }
    keys.add([
      'stream',
      source.stream,
      source.streamId,
      source.range.fromSeqExclusive,
      source.range.throughSeq,
      source.range.throughEventId,
    ].join(':'));
  }
  return [...keys];
}

function documentFrequencies(
  entries: readonly IndexedMemoryEntry[],
  queryTerms: readonly string[],
): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const term of queryTerms) {
    let count = 0;
    for (const entry of entries) {
      if (entry.terms.has(term)) count += 1;
    }
    frequencies.set(term, count);
  }
  return frequencies;
}

function averageDocumentLength(entries: readonly IndexedMemoryEntry[]): number {
  if (entries.length === 0) return 1;
  return Math.max(1, entries.reduce((sum, entry) => sum + entry.length, 0) / entries.length);
}

function termCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of tokenizeSearchText(text).filter((value) => !isTextSearchGramTerm(value))) {
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return counts;
}

function limitedQueryTerms(query: string): string[] {
  return uniqueTextSearchTerms(analyzeTextSearchQuery(query).terms).slice(0, QUERY_TERM_LIMIT);
}

function phraseBoost(normalizedFact: string, normalizedQuery: string, queryTermCount: number): number {
  return normalizedFact.includes(normalizedQuery) ? EXACT_PHRASE_BOOST + queryTermCount : 0;
}

function idBoost(normalizedId: string, queryTerms: readonly string[]): number {
  let score = 0;
  for (const term of queryTerms) {
    if (normalizedId.includes(term)) score += ID_TERM_BOOST;
  }
  return score;
}

function fallbackSort(
  entries: readonly AgentMemoryEntry[],
  accessStatsByEntryId: ReadonlyMap<string, AgentMemoryAccessStats> = new Map(),
  now = Date.now(),
): AgentHybridMemoryRankedEntry[] {
  return entries
    .map((entry) => ({
      entry,
      strength: computeMemoryStrength(entry, accessStatsByEntryId.get(entry.id), now),
      lexicalScore: 0,
      associationScore: 0,
      score: 0,
    }))
    .sort((left, right) => fallbackEntrySort(left.entry, right.entry));
}

function compareHybridRankedEntries(left: AgentHybridMemoryRankedEntry, right: AgentHybridMemoryRankedEntry): number {
  return (
    right.score - left.score
    || right.lexicalScore - left.lexicalScore
    || right.associationScore - left.associationScore
    || right.strength.retrievalStrength - left.strength.retrievalStrength
    || right.strength.storageStrength - left.strength.storageStrength
    || fallbackEntrySort(left.entry, right.entry)
  );
}

function fallbackEntrySort(left: AgentMemoryEntry, right: AgentMemoryEntry): number {
  return right.createdAt - left.createdAt || right.id.localeCompare(left.id);
}

function entryKey(entry: AgentMemoryEntry): string {
  return `${principalKey(entry.principal)}\0${entry.id}`;
}

function residentActivationScore(item: AgentMemoryRankedEntry): number {
  return (
    item.strength.retrievalStrength
    + Math.min(4, item.strength.storageStrength) * 0.05
    + item.entry.createdAt / 1_000_000_000_000_000
  );
}
