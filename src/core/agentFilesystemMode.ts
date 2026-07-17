export const AGENT_FILESYSTEM_MODES = ['full-access', 'restricted'] as const;

export type AgentFilesystemMode = typeof AGENT_FILESYSTEM_MODES[number];

export const DEFAULT_AGENT_FILESYSTEM_MODE: AgentFilesystemMode = 'full-access';

export function isAgentFilesystemMode(value: unknown): value is AgentFilesystemMode {
  return typeof value === 'string' && AGENT_FILESYSTEM_MODES.includes(value as AgentFilesystemMode);
}

export function normalizeAgentFilesystemMode(
  value: unknown,
  fallback: AgentFilesystemMode = DEFAULT_AGENT_FILESYSTEM_MODE,
): AgentFilesystemMode {
  return isAgentFilesystemMode(value) ? value : fallback;
}
