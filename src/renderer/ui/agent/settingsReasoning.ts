import type { AgentModelOption, AgentReasoningLevel } from '../../api/types';

// Shared reasoning-level helpers used by both the settings view and the provider
// config sheet. Kept in their own module so the sheet does not have to import the
// view (which imports the sheet — a cycle).

export const REASONING_LABELS: Record<AgentReasoningLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
};

export function defaultReasoningLevel(model: AgentModelOption | undefined): AgentReasoningLevel {
  const supportedLevels = model?.supportedThinkingLevels ?? ['off'];
  if (supportedLevels.includes('off')) return 'off';
  return supportedLevels[0] ?? 'off';
}

export function coerceReasoningLevel(
  reasoningLevel: AgentReasoningLevel,
  supportedLevels: AgentReasoningLevel[],
): AgentReasoningLevel {
  if (supportedLevels.includes(reasoningLevel)) return reasoningLevel;
  if (supportedLevels.includes('off')) return 'off';
  return supportedLevels[0] ?? 'off';
}
