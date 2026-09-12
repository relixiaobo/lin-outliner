import type { TSchema } from 'typebox';
import {
  MEMORY_INSPECT_SCHEMA, MEMORY_MANAGE_SCHEMA,
  type MemoryInspectRequest, type MemoryInspectResult, type MemoryManageRequest,
  type MemoryManageResult, type MemoryResetReview,
} from '../../core/agent/memoryOperations';
import type { MemoryExtension } from '../agent/extensions/memory/MemoryExtension';
import { memoryResetReview } from '../agent/extensions/memory/MemoryResetTarget';
import { AgentToolFailure } from '../agent/AgentToolFailure';
import { compileToolParameters } from '../agent/runtime/kernel/exactToolArguments';

export interface MemoryOperationCaller {
  readonly origin: { readonly kind: 'window'; readonly windowId: number };
  readonly signal?: AbortSignal;
  readonly authorize: (name: string, input: unknown, signal?: AbortSignal) => Promise<void>;
}

export type ReviewMemoryReset = (review: MemoryResetReview, caller: MemoryOperationCaller) => Promise<boolean>;
export type OpenMemory = (authorize: () => Promise<void>) => Promise<Extract<MemoryManageResult, { operation: 'open' }>>;

export function createMemoryOperations(options: {
  readonly memory: MemoryExtension;
  readonly review: ReviewMemoryReset;
  readonly open: OpenMemory;
}) {
  const { memory } = options;
  async function authorize(caller: MemoryOperationCaller, name: string, request: MemoryInspectRequest | MemoryManageRequest) {
    caller.signal?.throwIfAborted();
    await caller.authorize(name, { request }, caller.signal);
  }
  function targetThread(request: { readonly threadId?: string }): string | null {
    return request.threadId ?? null;
  }
  return {
    async inspect(value: unknown, caller: MemoryOperationCaller): Promise<MemoryInspectResult> {
      const request = decode<MemoryInspectRequest>(value, MEMORY_INSPECT_SCHEMA);
      await authorize(caller, 'memory_inspect', request);
      if (request.operation === 'profile') return { operation: 'profile', files: memory.inspectProfileFiles(request.profileName) };
      if (request.operation === 'profile_source') return { operation: 'profile_source', source: memory.inspectProfileSource(request.key, request.originItemId) };
      return request.operation === 'status'
        ? { operation: 'status', ...memory.view(targetThread(request)) }
        : { operation: 'reset', reset: memory.inspectReset(request.operationId) };
    },
    async manage(value: unknown, caller: MemoryOperationCaller): Promise<MemoryManageResult> {
      const request = decode<MemoryManageRequest>(value, MEMORY_MANAGE_SCHEMA);
      const recheck = () => authorize(caller, 'memory_manage', request);
      await recheck();
      switch (request.operation) {
        case 'edit_profile_file': return { operation: request.operation, file: await memory.editProfileFile(request, recheck) };
        case 'open': return options.open(recheck);
        case 'set_thread_mode': {
          const threadId = targetThread(request);
          if (!threadId) throw failure('memory_thread_required', 'Name the Thread whose Memory mode should change.');
          return { operation: request.operation, thread: await memory.setThreadMode(threadId, request.mode, request.expectedRevision, recheck) };
        }
        case 'reset': {
          const target = memory.reviewReset();
          if (!await options.review(memoryResetReview(target), caller)) throw failure('cancelled', 'Memory Reset was cancelled.');
          await recheck();
          return { operation: 'reset', reset: await memory.reset(target, recheck) };
        }
      }
    },
  };
}

function decode<T>(input: unknown, schema: object): T {
  if (!compileToolParameters(schema as TSchema).Check(input)) throw failure('invalid_request', 'The Memory operation does not match its schema.');
  return (input as { request: T }).request;
}
function failure(code: string, message: string): AgentToolFailure {
  return new AgentToolFailure(code, message, 'Refresh Memory settings for current state. Never edit the private Memory store.');
}
export type MemoryOperations = ReturnType<typeof createMemoryOperations>;
