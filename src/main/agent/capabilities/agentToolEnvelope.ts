import type { AgentToolResult } from '../runtime/kernel/types';
import type { JsonValue } from '../../../core/agent/protocol';

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
  instructions?: string;
  warnings?: string[];
  metrics?: ToolMetrics;
}

export const TOOL_RESULT_VERSION = 1;
export const MAX_TENON_RESULT_DATA_BYTES = 256 * 1024;

/**
 * The model-visible error carries only what the model can act on. `recoverable`
 * is dropped (it is a constant `true`); the runtime `details` envelope keeps it.
 */
export type VisibleToolError = Pick<ToolError, 'code' | 'message'>;

export function visibleToolError(error: ToolError): VisibleToolError {
  return { code: error.code, message: error.message };
}

/**
 * Builds a model-facing tool result. `modelData` is what the model sees under
 * `data`: omitted entirely when `undefined` (the default), so the safe path is
 * also the natural one — there is no sentinel and no accidental fallback to the
 * full runtime payload. To show the model a slim projection, pass it; to echo
 * the runtime `envelope.data` in full, pass `envelope.data` explicitly. The
 * complete envelope always stays on `details`.
 */
export function agentToolResult<TData>(
  envelope: ToolEnvelope<TData>,
  modelData?: unknown,
  extraContent: AgentToolResult<TData>['content'] = [],
): AgentToolResult<ToolEnvelope<TData>> {
  return {
    kind: 'tenon',
    outcome: envelope.ok
      ? {
          ok: true,
          ...(envelope.status === 'unchanged' || envelope.status === 'partial'
            ? { status: envelope.status }
            : {}),
        }
      : {
          ok: false,
          ...(envelope.status === 'denied' ? { status: 'denied' as const } : {}),
          error: visibleToolError(envelope.error ?? {
            code: 'tool_failed',
            message: 'The operation failed.',
            recoverable: true,
          }),
        },
    ...(modelData === undefined ? {} : { data: modelData as JsonValue }),
    ...(envelope.instructions === undefined ? {} : { instructions: envelope.instructions }),
    ...(envelope.warnings === undefined ? {} : { warnings: envelope.warnings }),
    content: [...extraContent],
    details: envelope,
  };
}

export function successEnvelope<TData>(
  tool: string,
  data: TData,
  options: Partial<Pick<ToolEnvelope<TData>, 'status' | 'instructions' | 'warnings' | 'metrics'>> = {},
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
  options: Partial<Pick<ToolEnvelope<TData>, 'data' | 'instructions' | 'warnings' | 'metrics'>> = {},
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

export function isToolEnvelope(value: unknown): value is ToolEnvelope {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { version?: unknown; ok?: unknown; tool?: unknown; status?: unknown };
  return candidate.version === TOOL_RESULT_VERSION
    && typeof candidate.ok === 'boolean'
    && typeof candidate.tool === 'string'
    && typeof candidate.status === 'string';
}

/** Drop keys whose value is `undefined` (the single shared compaction helper). */
export function dropUndefinedFields<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined),
  ) as T;
}

function compactOptions<T extends Record<string, unknown>>(options: T): Partial<T> {
  return dropUndefinedFields(options);
}
