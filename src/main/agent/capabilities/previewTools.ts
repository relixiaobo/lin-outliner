import type { TSchema } from 'typebox';
import { modelToolContract } from '../../../core/agent/tools';
import type { PreviewOperationCaller, PreviewOperations } from '../../hostDomain/previewOperations';
import type { AgentTool } from '../runtime/kernel/types';
import { AgentToolFailure } from '../AgentToolFailure';
import { agentToolResult, errorEnvelope, successEnvelope } from './agentToolEnvelope';

export function createPreviewTools(
  operations: PreviewOperations,
  caller: (itemId: string, signal?: AbortSignal) => PreviewOperationCaller,
): AgentTool[] {
  return (['preview_inspect', 'preview_manage', 'data_inspect', 'data_manage'] as const).map(
    (name): AgentTool => {
      const contract = modelToolContract(name)!;
      return {
        name,
        label: name,
        description: contract.description,
        parameters: contract.inputSchema as TSchema,
        executionMode: 'sequential',
        execute: async (itemId, input, signal) => {
          try {
            const result = await operations.handle(name, input, caller(itemId, signal));
            return agentToolResult(successEnvelope(name, { result }), { result });
          } catch (error) {
            if (error instanceof AgentToolFailure)
              return agentToolResult(
                errorEnvelope(name, error.code, error.message, {
                  instructions: error.instructions,
                }),
              );
            signal?.throwIfAborted();
            throw error;
          }
        },
      };
    },
  );
}
