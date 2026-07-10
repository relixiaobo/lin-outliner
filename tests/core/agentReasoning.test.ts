import { describe, expect, test } from 'bun:test';
import { DEFAULT_AGENT_THINKING_LEVEL, defaultThinkingLevelFor, nearestSupportedLevel, reasoningLevelLabelKey } from '../../src/core/agentReasoning';
import { AGENT_REASONING_LADDER } from '../../src/core/types';

describe('agentReasoning', () => {
  test('the default level is medium', () => {
    expect(DEFAULT_AGENT_THINKING_LEVEL).toBe('medium');
  });

  test('nearestSupportedLevel returns the target when supported', () => {
    expect(nearestSupportedLevel('high', ['off', 'low', 'medium', 'high'])).toBe('high');
  });

  test('nearestSupportedLevel coerces to the closest level, ties favouring lower', () => {
    // medium absent → low and high are equidistant; the lower one (low) wins.
    expect(nearestSupportedLevel('medium', ['off', 'low', 'high'])).toBe('low');
    // only off/xhigh → nearest to medium is off (distance 3) vs xhigh (distance 2) → xhigh.
    expect(nearestSupportedLevel('medium', ['off', 'xhigh'])).toBe('xhigh');
  });

  test('defaultThinkingLevelFor resolves medium onto the supported set', () => {
    expect(defaultThinkingLevelFor(['off', 'low', 'medium', 'high'])).toBe('medium');
    // A model that only reasons at low/high → medium coerces to low (tie favours lower).
    expect(defaultThinkingLevelFor(['low', 'high'])).toBe('low');
  });

  test('defaultThinkingLevelFor is off for a non-reasoning model', () => {
    expect(defaultThinkingLevelFor([])).toBe('off');
    expect(defaultThinkingLevelFor(['off'])).toBe('off');
  });

  test('xhigh and max are distinct ordered levels with canonical label keys', () => {
    expect(AGENT_REASONING_LADDER.slice(-2)).toEqual(['xhigh', 'max']);
    expect(reasoningLevelLabelKey('xhigh')).toBe('xhigh');
    expect(reasoningLevelLabelKey('max')).toBe('max');
  });
});
