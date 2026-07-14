import type { AgentToolResult, AfterToolCallResult } from '@earendil-works/pi-agent-core';

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

/**
 * The model-visible error carries only what the model can act on. `recoverable`
 * is dropped (it is a constant `true`); the runtime `details` envelope keeps it.
 */
export type VisibleToolError = Pick<ToolError, 'code' | 'message'>;

export type ModelVisibleToolEnvelope<TData = unknown> =
  Pick<ToolEnvelope<TData>, 'ok'>
  & Partial<Pick<ToolEnvelope<TData>, 'status' | 'data' | 'instructions' | 'warnings'>>
  & { error?: VisibleToolError };

/**
 * `status` is only worth showing the model when it adds something beyond `ok` +
 * `error`. `success` merely restates `ok:true`; `error` merely restates
 * `ok:false` + the `error` object. The informative states are `unchanged`,
 * `partial`, and `denied`.
 */
export function isInformativeStatus(status: ToolStatus): boolean {
  return status !== 'success' && status !== 'error';
}

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
  const visibleEnvelope = modelVisibleEnvelope(envelope, modelData);
  return {
    content: [{ type: 'text', text: JSON.stringify(visibleEnvelope, null, 2) }, ...extraContent],
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

export function toolEnvelopeAfterToolCall(details: unknown, isError: boolean): AfterToolCallResult | undefined {
  if (isError || !isToolEnvelope(details)) return undefined;
  if (details.ok) return undefined;
  return { isError: true };
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

/**
 * Projects the runtime envelope down to what the model sees. Shared by every
 * tool; `data` is shown only when `modelData` is defined.
 */
export function modelVisibleEnvelope<TData>(
  envelope: ToolEnvelope<TData>,
  modelData?: unknown,
): ModelVisibleToolEnvelope<unknown> {
  return {
    ok: envelope.ok,
    ...(isInformativeStatus(envelope.status) ? { status: envelope.status } : {}),
    ...(modelData !== undefined ? { data: modelData } : {}),
    ...(envelope.error ? { error: visibleToolError(envelope.error) } : {}),
    ...(envelope.instructions ? { instructions: envelope.instructions } : {}),
    ...(envelope.warnings?.length ? { warnings: envelope.warnings } : {}),
  };
}
