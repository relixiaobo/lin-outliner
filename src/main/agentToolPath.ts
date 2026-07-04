import path from 'node:path';

export const EXTRA_TOOL_PATH_ENV = 'LIN_AGENT_EXTRA_TOOL_PATH';

export const DEFAULT_AGENT_TOOL_PATH_SEGMENTS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

export interface AgentToolPathOptions {
  extraToolPath?: string;
  processPath?: string;
  defaultToolPathSegments?: string[];
  trailingSegments?: string[];
}

export function buildAgentToolPathValue(options: AgentToolPathOptions = {}): string {
  const segments = [
    ...pathSegments(options.extraToolPath ?? process.env[EXTRA_TOOL_PATH_ENV]),
    ...pathSegments(options.processPath ?? process.env.PATH),
    ...(options.defaultToolPathSegments ?? DEFAULT_AGENT_TOOL_PATH_SEGMENTS),
    ...(options.trailingSegments ?? []),
  ];
  const seen = new Set<string>();
  return segments.filter((segment) => {
    const normalized = segment.trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).join(path.delimiter);
}

export function pathSegments(value: string | undefined): string[] {
  return (value ?? '')
    .split(path.delimiter)
    .map((segment) => segment.trim())
    .filter(Boolean);
}
