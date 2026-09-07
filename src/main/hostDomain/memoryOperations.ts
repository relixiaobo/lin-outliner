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
import type { DeferredToolAuthority } from '../agent/runtime/ToolRuntime';

export interface MemoryOperationCaller {
  readonly origin: { readonly kind: 'window'; readonly windowId: number } | {
    readonly kind: 'agent'; readonly threadId: string; readonly turnId: string; readonly itemId: string;
  };
  readonly signal?: AbortSignal;
  readonly authorize: DeferredToolAuthority;
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
    if (caller.origin.kind === 'agent') memory.threadView(caller.origin.threadId);
  }
  function targetThread(request: { readonly threadId?: string }, caller: MemoryOperationCaller): string | null {
    return request.threadId ?? (caller.origin.kind === 'agent' ? caller.origin.threadId : null);
  }
  return {
    async inspect(value: unknown, caller: MemoryOperationCaller): Promise<MemoryInspectResult> {
      const request = decode<MemoryInspectRequest>(value, MEMORY_INSPECT_SCHEMA);
      await authorize(caller, 'memory_inspect', request);
      return request.operation === 'status'
        ? { operation: 'status', ...memory.view(targetThread(request, caller)) }
        : { operation: 'reset', reset: memory.inspectReset(request.operationId) };
    },
    async manage(value: unknown, caller: MemoryOperationCaller): Promise<MemoryManageResult> {
      const request = decode<MemoryManageRequest>(value, MEMORY_MANAGE_SCHEMA);
      const recheck = () => authorize(caller, 'memory_manage', request);
      await recheck();
      switch (request.operation) {
        case 'open': return options.open(recheck);
        case 'set_thread_mode': {
          const threadId = targetThread(request, caller);
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
  return new AgentToolFailure(code, message, 'Use memory_inspect for current state. Never edit the private Memory store.');
}
export type MemoryOperations = ReturnType<typeof createMemoryOperations>;
