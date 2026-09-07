import type { TSchema } from 'typebox';
import { modelToolContract } from '../../../core/agent/tools';
import type { MemoryOperationCaller, MemoryOperations } from '../../hostDomain/memoryOperations';
import type { AgentTool } from '../runtime/kernel/types';
import { AgentToolFailure } from '../AgentToolFailure';
import { agentToolResult, errorEnvelope, successEnvelope } from './agentToolEnvelope';

export function createMemoryTools(operations: MemoryOperations, caller: (itemId: string, signal?: AbortSignal) => MemoryOperationCaller): AgentTool[] {
  return (['memory_inspect', 'memory_manage'] as const).map((name): AgentTool => {
    const contract = modelToolContract(name)!;
    return {
      name, label: name === 'memory_inspect' ? 'Inspect Memory' : 'Manage Memory',
      description: contract.description, parameters: contract.inputSchema as TSchema,
      executionMode: 'sequential',
      execute: async (itemId, input, signal) => {
        try {
          const result = await operations[name === 'memory_inspect' ? 'inspect' : 'manage'](input, caller(itemId, signal));
          return agentToolResult(successEnvelope(name, { result }), { result });
        } catch (error) {
          if (error instanceof AgentToolFailure) return agentToolResult(errorEnvelope(name, error.code, error.message, { instructions: error.instructions }));
          signal?.throwIfAborted();
          throw error;
        }
      },
    };
  });
}
