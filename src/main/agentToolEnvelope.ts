import type { AgentToolResult } from '@earendil-works/pi-agent-core';

export type ToolStatus = 'success' | 'partial' | 'unchanged' | 'denied' | 'error';

export interface ToolError {
  code: string;
  message: string;
  recoverable: boolean;
  details?: unknown;
}

export interface ToolMetrics {
  durationMs?: number;
  truncated?: boolean;
  outputBytes?: number;
}

export interface ToolEnvelope<TData = unknown> {
  ok: boolean;
  tool: string;
  version: 1;
  status: ToolStatus;
  data?: TData;
  error?: ToolError;
  nextStep?: string;
  fallback?: string;
  hint?: string;
  warnings?: string[];
  metrics?: ToolMetrics;
}

export const TOOL_RESULT_VERSION = 1;

export function agentToolResult<TData>(envelope: ToolEnvelope<TData>): AgentToolResult<ToolEnvelope<TData>> {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
    details: envelope,
  };
}

export function successEnvelope<TData>(
  tool: string,
  data: TData,
  options: Partial<Pick<ToolEnvelope<TData>, 'status' | 'nextStep' | 'fallback' | 'hint' | 'warnings' | 'metrics'>> = {},
): ToolEnvelope<TData> {
  return {
    ok: true,
    tool,
    version: TOOL_RESULT_VERSION,
    status: options.status ?? 'success',
    data,
    ...compactOptions(options),
  };
}

export function errorEnvelope<TData = unknown>(
  tool: string,
  code: string,
  message: string,
  options: Partial<Pick<ToolEnvelope<TData>, 'data' | 'nextStep' | 'fallback' | 'hint' | 'warnings' | 'metrics'>> = {},
): ToolEnvelope<TData> {
  return {
    ok: false,
    tool,
    version: TOOL_RESULT_VERSION,
    status: 'error',
    error: {
      code,
      message,
      recoverable: true,
    },
    ...compactOptions(options),
  };
}

function compactOptions<T extends Record<string, unknown>>(options: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
