import { AGENT_REASONING_LADDER, type AgentReasoningLevel } from './types';

// Shared reasoning-effort math, used by both the runtime (resolving the level an
// agent actually runs at) and the renderer (marking the "Default" level in the
// composer's quick picker). Single source so the two never disagree about which
// level inherit resolves to.

// The default effort an agent runs at when its profile sets none. `medium` keeps a
// reasoning-capable model actually reasoning by default (a provider connection no
// longer carries a global reasoning level), coerced to the model's nearest level.
export const DEFAULT_AGENT_THINKING_LEVEL: AgentReasoningLevel = 'medium';

/**
 * The supported level closest to `target` on the shared ladder; ties resolve to the
 * lower level. Used to coerce a desired effort onto a model that does not support it.
 */
export function nearestSupportedLevel(
  target: AgentReasoningLevel,
  supported: readonly AgentReasoningLevel[],
): AgentReasoningLevel {
  if (supported.includes(target)) return target;
  const targetIndex = AGENT_REASONING_LADDER.indexOf(target);
  let best = supported[0];
  let bestDistance = Infinity;
  for (const level of supported) {
    const distance = Math.abs(AGENT_REASONING_LADDER.indexOf(level) - targetIndex);
    if (distance < bestDistance
      || (distance === bestDistance && AGENT_REASONING_LADDER.indexOf(level) < AGENT_REASONING_LADDER.indexOf(best))) {
      best = level;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The default thinking level for a model's supported levels: `medium` coerced to the
 * nearest supported level (a non-reasoning model supporting only `off` stays `off`).
 */
export function defaultThinkingLevelFor(supported: readonly AgentReasoningLevel[]): AgentReasoningLevel {
  if (!supported.length) return 'off';
  return nearestSupportedLevel(DEFAULT_AGENT_THINKING_LEVEL, supported);
}

/** The i18n label key for a canonical level. Model-specific provider labels are
 *  carried on `AgentModelOption` without changing the saved effort value. */
export type ReasoningLabelKey = AgentReasoningLevel;
export function reasoningLevelLabelKey(level: AgentReasoningLevel): ReasoningLabelKey {
  return level;
}
