import type { ProfileFileKind, ProfileFileView, ProfileSourceView } from './profileFiles';
import type { MemoryStatus, ThreadMemoryMode, ThreadMemoryStatus } from './memory';
import type { ObjectJsonSchema } from './tools';

export type MemoryInspectRequest =
  | { readonly operation: 'profile'; readonly profileName?: string }
  | { readonly operation: 'profile_source'; readonly key: string; readonly originItemId: string }
  | { readonly operation: 'status'; readonly threadId?: string }
  | { readonly operation: 'reset'; readonly operationId: string };

export type MemoryManageRequest =
  | { readonly operation: 'edit_profile_file'; readonly kind: ProfileFileKind; readonly profileName: string; readonly expectedDigest: string | null; readonly content: string }
  | { readonly operation: 'open' }
  | { readonly operation: 'set_thread_mode'; readonly threadId?: string; readonly mode: ThreadMemoryMode; readonly expectedRevision: number }
  | { readonly operation: 'reset' };

export type MemoryThreadView = ThreadMemoryStatus;

export interface MemoryResetReview {
  readonly profileEntryCount?: number;
  readonly resetEpoch: number;
  readonly containerCount: number;
  readonly nodeCount: number;
  readonly ordinaryNodeCount: number;
}

export type MemoryResetView = { readonly profileState?: 'removed' | 'pending' } & (
  | { readonly operationId: string; readonly state: 'prepared' | 'finalized' | 'conflicted'; readonly admittedAt: number; readonly targetEpoch: number }
  | { readonly operationId: string; readonly state: 'unknown'; readonly admittedAt: number | null; readonly targetEpoch: number | null });

export type MemoryInspectResult =
  | { readonly operation: 'profile'; readonly files: readonly ProfileFileView[] }
  | { readonly operation: 'profile_source'; readonly source: ProfileSourceView }
  | { readonly operation: 'status'; readonly status: MemoryStatus; readonly thread: MemoryThreadView | null }
  | { readonly operation: 'reset'; readonly reset: MemoryResetView };

export type MemoryManageResult =
  | { readonly operation: 'edit_profile_file'; readonly file: ProfileFileView }
  | { readonly operation: 'open'; readonly nodeId: string; readonly navigation: 'opened' | 'unavailable' | 'unknown' }
  | { readonly operation: 'set_thread_mode'; readonly thread: MemoryThreadView }
  | { readonly operation: 'reset'; readonly reset: MemoryResetView };

export const MEMORY_CHANGED_CHANNEL = 'lin:memory-changed';
export const MEMORY_ERROR_MAX_CHARS = 512;

const id = { type: 'string', minLength: 1, maxLength: 256 };
const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const mode = { type: 'string', enum: ['enabled', 'disabled'] };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)): ObjectJsonSchema => ({
  type: 'object', additionalProperties: false, properties, required,
});
function variant(operation: string, properties: Record<string, unknown> = {}, required = Object.keys(properties)) {
  return object({ operation: { type: 'string', const: operation }, ...properties }, ['operation', ...required]);
}

export const MEMORY_INSPECT_SCHEMA = object({ request: { anyOf: [
  variant('profile', { profileName: id }, []),
  variant('profile_source', { key: id, originItemId: id }),
  variant('status', { threadId: id }, []),
  variant('reset', { operationId: id }),
] } });

export const MEMORY_MANAGE_SCHEMA = object({ request: { anyOf: [
  variant('edit_profile_file', { kind: { enum: ['identity', 'style', 'user'] }, profileName: id, expectedDigest: { type: ['string', 'null'] }, content: { type: 'string', maxLength: 32768 } }),
  variant('open'),
  variant('set_thread_mode', { threadId: id, mode, expectedRevision: count }, ['mode', 'expectedRevision']),
  variant('reset'),
] } });
