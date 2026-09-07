import type { MemoryStatus, ThreadMemoryMode, ThreadMemoryStatus } from './memory';
import type { ObjectJsonSchema } from './tools';

export type MemoryInspectRequest =
  | { readonly operation: 'status'; readonly threadId?: string }
  | { readonly operation: 'reset'; readonly operationId: string };

export type MemoryManageRequest =
  | { readonly operation: 'open' }
  | { readonly operation: 'set_thread_mode'; readonly threadId?: string; readonly mode: ThreadMemoryMode; readonly expectedRevision: number }
  | { readonly operation: 'reset' };

export interface MemoryThreadView extends ThreadMemoryStatus {
  readonly revision: number;
  readonly appliesAt: 'subsequent_admissions';
}

export interface MemoryResetReview {
  readonly resetEpoch: number;
  readonly containerCount: number;
  readonly nodeCount: number;
  readonly ordinaryNodeCount: number;
}

export type MemoryResetView =
  | { readonly operationId: string; readonly state: 'prepared' | 'finalized' | 'conflicted'; readonly admittedAt: number; readonly targetEpoch: number }
  | { readonly operationId: string; readonly state: 'unknown'; readonly admittedAt: number | null; readonly targetEpoch: number | null };

export type MemoryInspectResult =
  | { readonly operation: 'status'; readonly status: MemoryStatus; readonly thread: MemoryThreadView | null }
  | { readonly operation: 'reset'; readonly reset: MemoryResetView };

export type MemoryManageResult =
  | { readonly operation: 'open'; readonly nodeId: string; readonly navigation: 'opened' | 'unavailable' | 'unknown' }
  | { readonly operation: 'set_thread_mode'; readonly thread: MemoryThreadView }
  | { readonly operation: 'reset'; readonly reset: MemoryResetView };

export const MEMORY_CHANGED_CHANNEL = 'lin:memory-changed';
export const MEMORY_ERROR_MAX_CHARS = 512;

const id = { type: 'string', minLength: 1, maxLength: 256 };
const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const mode = { type: 'string', enum: ['enabled', 'disabled'] };
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)): ObjectJsonSchema => ({
  type: 'object', additionalProperties: false, properties, required,
});
function variant(operation: string, properties: Record<string, unknown> = {}, required = Object.keys(properties)) {
  return object({ operation: { type: 'string', const: operation }, ...properties }, ['operation', ...required]);
}

export const MEMORY_INSPECT_SCHEMA = object({ request: { anyOf: [
  variant('status', { threadId: id }, []),
  variant('reset', { operationId: id }),
] } });

export const MEMORY_MANAGE_SCHEMA = object({ request: { anyOf: [
  variant('open'),
  variant('set_thread_mode', { threadId: id, mode, expectedRevision: count }, ['mode', 'expectedRevision']),
  variant('reset'),
] } });

const thread = object({
  threadId: id, mode, revision: count,
  appliesAt: { type: 'string', const: 'subsequent_admissions' },
});
const status = object({
  featureMode: mode, featureModeGeneration: count, resetEpoch: count,
  memoryVisibilityGeneration: count, lastSuccessfulRunAt: nullable(count),
  lastError: nullable({ type: 'string', maxLength: MEMORY_ERROR_MAX_CHARS }),
  pendingJobs: count, strayTaggedNodeCount: count,
});
const epoch = { ...count, minimum: 1 };
const reset = { anyOf: [
  object({
    operationId: id, state: { type: 'string', enum: ['prepared', 'finalized', 'conflicted'] },
    admittedAt: count, targetEpoch: epoch,
  }),
  object({
    operationId: id, state: { type: 'string', const: 'unknown' },
    admittedAt: nullable(count), targetEpoch: nullable(epoch),
  }),
] };

export const MEMORY_INSPECT_OUTPUT_SCHEMA = object({ result: { anyOf: [
  variant('status', { status, thread: nullable(thread) }),
  variant('reset', { reset }),
] } });

export const MEMORY_MANAGE_OUTPUT_SCHEMA = object({ result: { anyOf: [
  variant('open', { nodeId: id, navigation: { type: 'string', enum: ['opened', 'unavailable', 'unknown'] } }),
  variant('set_thread_mode', { thread }),
  variant('reset', { reset }),
] } });
