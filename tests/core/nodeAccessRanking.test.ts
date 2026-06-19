import { describe, expect, test } from 'bun:test';
import {
  applyNodeAccess,
  computeNodeAccessStrength,
  NODE_ACCESS_HALF_LIFE_MS,
  nodeAccessRankingMultiplier,
} from '../../src/core/nodeAccessRanking';

describe('node access ranking', () => {
  test('applies source weights to the decayed accumulator', () => {
    const first = applyNodeAccess(null, 'human', 1_000);
    expect(first).toEqual({ s: 1, tUpdate: 1_000 });

    const second = applyNodeAccess(first, 'agentRecall', 1_000 + NODE_ACCESS_HALF_LIFE_MS);
    expect(second.tUpdate).toBe(1_000 + NODE_ACCESS_HALF_LIFE_MS);
    expect(second.s).toBeCloseTo(0.65);
  });

  test('decays strength and converts it into a bounded multiplier', () => {
    const stats = { s: 2, tUpdate: 5_000 };

    expect(computeNodeAccessStrength(stats, 5_000)).toBeCloseTo(2);
    expect(computeNodeAccessStrength(stats, 5_000 + NODE_ACCESS_HALF_LIFE_MS)).toBeCloseTo(1);
    expect(nodeAccessRankingMultiplier(stats, 5_000)).toBeCloseTo(1.3);
    expect(nodeAccessRankingMultiplier({ s: 100, tUpdate: 5_000 }, 5_000)).toBe(2.5);
  });
});
