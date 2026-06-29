import { test, expect, describe } from 'bun:test';
import { getModels, getProviders } from '@earendil-works/pi-ai/compat';
import {
  MODEL_LINES,
  type RankableModel,
  compareModels,
  compareVersionDesc,
  findUnknownLineModels,
  isDatedSnapshot,
  rankModels,
  versionTuple,
} from '../../src/main/modelRanking';

const model = (id: string, reasoning = true): RankableModel => ({ id, reasoning });
const order = (provider: string, ...ids: string[]): string[] =>
  rankModels(provider, ids.map((id) => model(id))).map((m) => m.id);

describe('versionTuple', () => {
  test('parses dash- and dot-separated version numbers', () => {
    expect(versionTuple('claude-opus-4-8')).toEqual([4, 8]);
    expect(versionTuple('gemini-3.5-flash')).toEqual([3, 5]);
    expect(versionTuple('gpt-5.5-pro')).toEqual([5, 5]);
  });

  test('strips date / snapshot noise so a date cannot masquerade as a version', () => {
    // Without stripping, the 2024 date would parse as a huge version component.
    expect(versionTuple('gpt-4o-2024-11-20')).toEqual([4]);
    expect(versionTuple('claude-opus-4-5-20251101')).toEqual([4, 5]);
    expect(versionTuple('claude-opus-4-20250514')).toEqual([4]);
  });
});

describe('compareVersionDesc', () => {
  test('is numeric, not lexical: 4-10 outranks 4-9', () => {
    // A string sort would put "4-9" above "4-10"; the numeric tuple must not.
    expect(compareVersionDesc([4, 10], [4, 9])).toBeLessThan(0);
  });

  test('a present component outranks a missing one', () => {
    expect(compareVersionDesc([4, 5], [4])).toBeLessThan(0);
  });
});

describe('compareModels — recency over tier and price', () => {
  test('a newer cheap model outranks an older premium one (the Gemini case)', () => {
    expect(order('google', 'gemini-2.5-pro', 'gemini-3.5-flash')).toEqual([
      'gemini-3.5-flash',
      'gemini-2.5-pro',
    ]);
  });

  test('newest version leads across Claude tiers (sonnet-4-6 over opus-4-5)', () => {
    expect(order('anthropic', 'claude-opus-4-5', 'claude-sonnet-4-6')).toEqual([
      'claude-sonnet-4-6',
      'claude-opus-4-5',
    ]);
  });

  test('numeric version ordering survives the two-digit rollover', () => {
    expect(order('anthropic', 'claude-opus-4-9', 'claude-opus-4-10')).toEqual([
      'claude-opus-4-10',
      'claude-opus-4-9',
    ]);
  });

  test('a clean alias precedes its dated snapshot at equal version', () => {
    expect(order('anthropic', 'claude-opus-4-5-20251101', 'claude-opus-4-5')).toEqual([
      'claude-opus-4-5',
      'claude-opus-4-5-20251101',
    ]);
  });

  test('at equal version, a modern reasoning model precedes a legacy one', () => {
    const ranked = rankModels('anthropic', [
      model('claude-x-4-0', false),
      model('claude-y-4-0', true),
    ]);
    expect(ranked[0].reasoning).toBe(true);
  });

  test('a high-numbered side line never outranks the flagship line', () => {
    // gemma-4 has a higher raw version than gemini-3.5 but must sort below it.
    expect(order('google', 'gemma-4-31b-it', 'gemini-3.5-flash')).toEqual([
      'gemini-3.5-flash',
      'gemma-4-31b-it',
    ]);
  });
});

describe('isDatedSnapshot', () => {
  test('distinguishes pinned snapshots from rolling aliases', () => {
    expect(isDatedSnapshot('claude-opus-4-5-20251101')).toBe(true);
    expect(isDatedSnapshot('gpt-4o-2024-11-20')).toBe(true);
    expect(isDatedSnapshot('claude-opus-4-8')).toBe(false);
  });
});

// Live-catalog guards: run the policy over pi-ai's real model registry. These are
// the staleness tripwire — when a pi-ai upgrade ships a model the policy cannot
// place, they go red instead of silently burying it.
describe('live pi-ai catalog', () => {
  const highestVersionInLine = (provider: string, linePrefix: string): number[] =>
    getModels(provider)
      .filter((m) => m.id.startsWith(linePrefix))
      .map((m) => versionTuple(m.id))
      .sort(compareVersionDesc)[0] ?? [];

  test('the default (first) model is the newest in the flagship line', () => {
    for (const [provider, line] of [
      ['anthropic', 'claude'],
      ['openai', 'gpt'],
      ['google', 'gemini'],
    ] as const) {
      const ranked = rankModels(provider, getModels(provider));
      expect(ranked[0]?.id.startsWith(line)).toBe(true);
      // Nothing in the flagship line outranks the chosen default by version.
      expect(compareVersionDesc(versionTuple(ranked[0]!.id), highestVersionInLine(provider, line)))
        .toBeLessThanOrEqual(0);
    }
  });

  test('Gemini default is a 3.x model, not the older 2.5 Pro', () => {
    const ranked = rankModels('google', getModels('google'));
    expect(versionTuple(ranked[0]!.id)[0]).toBeGreaterThanOrEqual(3);
  });

  test('every model maps to a known product line for providers that declare lines', () => {
    for (const provider of getProviders()) {
      if (!MODEL_LINES[provider]) continue;
      expect(findUnknownLineModels(provider, getModels(provider))).toEqual([]);
    }
  });
});
