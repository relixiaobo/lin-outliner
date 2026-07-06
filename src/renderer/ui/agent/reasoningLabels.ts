import { reasoningLevelLabelKey, type ReasoningLabelKey } from '../../../core/agentReasoning';
import type { AgentModelOption, AgentReasoningLevel } from '../../api/types';

type ReasoningLevelCopy = Record<ReasoningLabelKey, string>;

export function reasoningLevelDisplayLabel(
  level: AgentReasoningLevel,
  model: AgentModelOption | undefined,
  copy: ReasoningLevelCopy,
): string {
  const providerLabel = model?.thinkingLevelLabels?.[level]?.trim();
  if (providerLabel) return formatProviderEffortLabel(providerLabel);
  return copy[reasoningLevelLabelKey(level)];
}

function formatProviderEffortLabel(value: string): string {
  const normalized = value.trim();
  const lower = normalized.toLowerCase();
  if (lower === 'off') return 'Off';
  if (lower === 'none') return 'None';
  if (lower === 'minimal') return 'Minimal';
  if (lower === 'low') return 'Low';
  if (lower === 'medium') return 'Medium';
  if (lower === 'high') return 'High';
  if (lower === 'xhigh') return 'XHigh';
  if (lower === 'max') return 'Max';
  if (lower === 'default') return 'Default';
  return normalized;
}
