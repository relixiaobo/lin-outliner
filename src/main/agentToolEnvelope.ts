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

const MODEL_DATA_UNSET = Symbol('model-data-unset');

/**
 * Pass as `modelData` to omit the `data` block from the model-visible envelope
 * entirely. Needed because an explicit `undefined` argument triggers the
 * `MODEL_DATA_UNSET` default (JS default-parameter semantics) and would fall
 * back to `envelope.data`. Use when the runtime `details` keep a payload but the
 * model needs nothing beyond `ok` / `error` / `instructions`.
 */
export const NO_MODEL_DATA = Symbol('no-model-data');

export function agentToolResult<TData>(
  envelope: ToolEnvelope<TData>,
  modelData: unknown = MODEL_DATA_UNSET,
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

function compactOptions<T extends Record<string, unknown>>(options: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function modelVisibleEnvelope<TData>(
  envelope: ToolEnvelope<TData>,
  modelData: unknown,
): ModelVisibleToolEnvelope<unknown> {
  const data = modelData === MODEL_DATA_UNSET ? envelope.data
    : modelData === NO_MODEL_DATA ? undefined
    : modelData;
  return {
    ok: envelope.ok,
    ...(isInformativeStatus(envelope.status) ? { status: envelope.status } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(envelope.error ? { error: visibleToolError(envelope.error) } : {}),
    ...(envelope.instructions ? { instructions: envelope.instructions } : {}),
    ...(envelope.warnings?.length ? { warnings: envelope.warnings } : {}),
  };
}
