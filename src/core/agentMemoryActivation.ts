import type { AgentMemoryEntry } from './agentEventLog';
import {
  isTextSearchGramTerm,
  normalizeSearchText,
  textSearchTextHasCjk,
  tokenizeSearchText,
  uniqueTextSearchTerms,
} from './textSearchAnalyzer';

const DAY_MS = 24 * 60 * 60 * 1000;
const INITIAL_RETRIEVAL_HALF_LIFE_DAYS = 14;
const BRIEFING_RETRIEVAL_HALF_LIFE_DAYS = 10;
const RECALL_RETRIEVAL_HALF_LIFE_DAYS = 45;
const MAX_SCHEMA_NODES = 8;

const MEMORY_SCHEMA_STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'also',
  'answers',
  'before',
  'being',
  'build',
  'builds',
  'cannot',
  'code',
  'doing',
  'done',
  'every',
  'facts',
  'from',
  'have',
  'keep',
  'keeps',
  'less',
  'like',
  'make',
  'makes',
  'memory',
  'must',
  'needs',
  'only',
  'prefers',
  'preferred',
  'project',
  'should',
  'stay',
  'stays',
  'than',
  'that',
  'their',
  'them',
  'then',
  'there',
  'this',
  'through',
  'uses',
  'using',
  'wants',
  'when',
  'where',
  'with',
  'work',
]);

export interface AgentMemoryAccessStats {
  briefingCount: number;
  recallCount: number;
  lastBriefingAt: number | null;
  lastRecallAt: number | null;
}

export interface AgentMemoryStrength {
  entryId: string;
  storageStrength: number;
  retrievalStrength: number;
  briefingCount: number;
  recallCount: number;
  lastAccessedAt: number | null;
}

export interface AgentMemoryRankedEntry {
  entry: AgentMemoryEntry;
  strength: AgentMemoryStrength;
}

export interface AgentMemorySchemaNode {
  id: string;
  label: string;
  memoryIds: string[];
  entryCount: number;
  storageStrength: number;
  retrievalStrength: number;
}

export interface AgentMemoryOverview {
  generatedAt: number;
  totalEntries: number;
  schema: AgentMemorySchemaNode[];
}

export function emptyMemoryAccessStats(): AgentMemoryAccessStats {
  return {
    briefingCount: 0,
    recallCount: 0,
    lastBriefingAt: null,
    lastRecallAt: null,
  };
}

export function cloneMemoryAccessStats(stats: AgentMemoryAccessStats): AgentMemoryAccessStats {
  return { ...stats };
}

export function computeMemoryStrength(
  entry: AgentMemoryEntry,
  stats: AgentMemoryAccessStats | undefined,
  now = Date.now(),
): AgentMemoryStrength {
  const access = stats ?? emptyMemoryAccessStats();
  const ageDays = daysBetween(entry.createdAt, now);
  const weightedAccessCount = access.briefingCount * 0.3 + access.recallCount * 1.5;
  const storageStrength = roundStrength(1 + Math.log1p(ageDays) * 0.35 + Math.log1p(weightedAccessCount));
  const initialActivation = decay(entry.createdAt, now, INITIAL_RETRIEVAL_HALF_LIFE_DAYS);
  const briefingActivation = access.lastBriefingAt === null
    ? 0
    : decay(access.lastBriefingAt, now, BRIEFING_RETRIEVAL_HALF_LIFE_DAYS) * (0.45 + Math.log1p(access.briefingCount) * 0.15);
  const recallActivation = access.lastRecallAt === null
    ? 0
    : decay(access.lastRecallAt, now, RECALL_RETRIEVAL_HALF_LIFE_DAYS) * (2.5 + Math.log1p(access.recallCount) * 0.75);
  return {
    entryId: entry.id,
    storageStrength,
    retrievalStrength: roundStrength(initialActivation + briefingActivation + recallActivation),
    briefingCount: access.briefingCount,
    recallCount: access.recallCount,
    lastAccessedAt: latestTimestamp(access.lastBriefingAt, access.lastRecallAt),
  };
}

export function rankMemoryEntriesByActivation(
  entries: readonly AgentMemoryEntry[],
  accessStats: ReadonlyMap<string, AgentMemoryAccessStats>,
  now = Date.now(),
): AgentMemoryRankedEntry[] {
  return entries
    .map((entry) => ({ entry, strength: computeMemoryStrength(entry, accessStats.get(entry.id), now) }))
    .sort(compareRankedMemoryEntries);
}

export function buildMemoryOverview(
  entries: readonly AgentMemoryRankedEntry[],
  options: { generatedAt?: number; maxSchemaNodes?: number; totalEntries?: number } = {},
): AgentMemoryOverview {
  const generatedAt = options.generatedAt ?? Date.now();
  const active = entries.filter((item) => item.entry.status === 'active');
  const nodes = new Map<string, AgentMemorySchemaNode>();
  const globalTerms = rankGlobalSchemaTerms(active.map((item) => item.entry));

  for (const item of active) {
    const labels = schemaLabelsForEntry(item.entry, globalTerms);
    for (const label of labels) {
      const id = schemaNodeId(label);
      const current = nodes.get(id);
      if (!current) {
        nodes.set(id, {
          id,
          label,
          memoryIds: [item.entry.id],
          entryCount: 1,
          storageStrength: item.strength.storageStrength,
          retrievalStrength: item.strength.retrievalStrength,
        });
        continue;
      }
      if (!current.memoryIds.includes(item.entry.id)) {
        current.memoryIds.push(item.entry.id);
        current.entryCount += 1;
      }
      current.storageStrength = roundStrength(current.storageStrength + item.strength.storageStrength);
      current.retrievalStrength = roundStrength(current.retrievalStrength + item.strength.retrievalStrength);
    }
  }

  const schema = [...nodes.values()]
    .sort(compareSchemaNodes)
    .slice(0, options.maxSchemaNodes ?? MAX_SCHEMA_NODES);

  return {
    generatedAt,
    totalEntries: options.totalEntries ?? active.length,
    schema,
  };
}

export function mergeMemoryOverviews(
  overviews: readonly (AgentMemoryOverview | null | undefined)[],
  options: { generatedAt?: number; maxSchemaNodes?: number; totalEntries?: number } = {},
): AgentMemoryOverview {
  const nodes = new Map<string, AgentMemorySchemaNode>();
  let generatedAt = 0;
  let totalEntries = 0;

  for (const overview of overviews) {
    if (!overview) continue;
    generatedAt = Math.max(generatedAt, overview.generatedAt);
    totalEntries += overview.totalEntries;
    for (const node of overview.schema) {
      const current = nodes.get(node.id);
      if (!current) {
        nodes.set(node.id, {
          ...node,
          memoryIds: [...node.memoryIds],
        });
        continue;
      }
      for (const memoryId of node.memoryIds) {
        if (!current.memoryIds.includes(memoryId)) current.memoryIds.push(memoryId);
      }
      current.entryCount += node.entryCount;
      current.storageStrength = roundStrength(current.storageStrength + node.storageStrength);
      current.retrievalStrength = roundStrength(current.retrievalStrength + node.retrievalStrength);
    }
  }

  return {
    generatedAt: options.generatedAt ?? generatedAt,
    totalEntries: options.totalEntries ?? totalEntries,
    schema: [...nodes.values()]
      .sort(compareSchemaNodes)
      .slice(0, options.maxSchemaNodes ?? MAX_SCHEMA_NODES),
  };
}

function compareRankedMemoryEntries(left: AgentMemoryRankedEntry, right: AgentMemoryRankedEntry): number {
  return (
    right.strength.retrievalStrength - left.strength.retrievalStrength
    || right.strength.storageStrength - left.strength.storageStrength
    || right.entry.createdAt - left.entry.createdAt
    || right.entry.id.localeCompare(left.entry.id)
  );
}

function compareSchemaNodes(left: AgentMemorySchemaNode, right: AgentMemorySchemaNode): number {
  return (
    right.retrievalStrength - left.retrievalStrength
    || right.entryCount - left.entryCount
    || right.storageStrength - left.storageStrength
    || left.label.localeCompare(right.label)
  );
}

function rankGlobalSchemaTerms(entries: readonly AgentMemoryEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const uniqueTerms = new Set(schemaTerms(entry.fact));
    for (const term of uniqueTerms) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([term]) => term);
}

function schemaLabelsForEntry(entry: AgentMemoryEntry, globalTerms: readonly string[]): string[] {
  const terms = schemaTerms(entry.fact);
  if (terms.length === 0) return ['general'];
  const termSet = new Set(terms);
  const labels = globalTerms.filter((term) => termSet.has(term)).slice(0, 2);
  return labels.length > 0 ? labels : [terms[0] ?? 'general'];
}

function schemaTerms(text: string): string[] {
  return uniqueTextSearchTerms(tokenizeSearchText(text)
    .filter((term) => !isTextSearchGramTerm(term))
    .map((term) => term.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(isSchemaTerm));
}

function isSchemaTerm(term: string): boolean {
  if (!term || MEMORY_SCHEMA_STOP_WORDS.has(term)) return false;
  if (textSearchTextHasCjk(term)) return true;
  return [...term].length >= 3;
}

function schemaNodeId(label: string): string {
  const slug = normalizeSearchText(label).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return `memory-schema:${slug || 'general'}`;
}

function daysBetween(then: number, now: number): number {
  return Math.max(0, (now - then) / DAY_MS);
}

function decay(then: number, now: number, halfLifeDays: number): number {
  return Math.pow(0.5, daysBetween(then, now) / halfLifeDays);
}

function latestTimestamp(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function roundStrength(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}
