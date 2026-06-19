import type { NodeId } from './types';

export type NodeAccessSource = 'human' | 'agentRecall';

export interface NodeAccessStats {
  s: number;
  tUpdate: number | null;
}

export const NODE_ACCESS_HALF_LIFE_MS = 45 * 24 * 60 * 60 * 1000;
export const NODE_ACCESS_SOURCE_WEIGHTS: Record<NodeAccessSource, number> = {
  human: 1,
  agentRecall: 0.15,
};

const MAX_RANKING_BOOST = 1.5;
const RANKING_BOOST_PER_STRENGTH = 0.15;

export function normalizeNodeAccessStats(value: unknown): NodeAccessStats | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<NodeAccessStats>;
  const s = typeof candidate.s === 'number' && Number.isFinite(candidate.s) ? candidate.s : 0;
  const tUpdate =
    typeof candidate.tUpdate === 'number' && Number.isFinite(candidate.tUpdate)
      ? candidate.tUpdate
      : null;
  if (s <= 0 || tUpdate === null) return { s: 0, tUpdate: null };
  return { s, tUpdate: Math.max(0, tUpdate) };
}

export function computeNodeAccessStrength(
  stats: NodeAccessStats | null | undefined,
  now = Date.now(),
  halfLifeMs = NODE_ACCESS_HALF_LIFE_MS,
): number {
  const normalized = normalizeNodeAccessStats(stats);
  if (!normalized || normalized.s <= 0 || normalized.tUpdate === null) return 0;
  if (!Number.isFinite(now) || !Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return 0;
  const elapsed = Math.max(0, now - normalized.tUpdate);
  return normalized.s * 2 ** (-(elapsed / halfLifeMs));
}

export function applyNodeAccess(
  stats: NodeAccessStats | null | undefined,
  source: NodeAccessSource,
  now = Date.now(),
): NodeAccessStats {
  const previous = computeNodeAccessStrength(stats, now);
  const weight = NODE_ACCESS_SOURCE_WEIGHTS[source];
  return {
    s: previous + weight,
    tUpdate: Number.isFinite(now) ? Math.max(0, now) : Date.now(),
  };
}

export function nodeAccessRankingMultiplier(
  stats: NodeAccessStats | null | undefined,
  now = Date.now(),
): number {
  const strength = computeNodeAccessStrength(stats, now);
  const boost = Math.min(MAX_RANKING_BOOST, strength * RANKING_BOOST_PER_STRENGTH);
  return 1 + boost;
}

export type NodeAccessStatsById = ReadonlyMap<NodeId, NodeAccessStats>;
