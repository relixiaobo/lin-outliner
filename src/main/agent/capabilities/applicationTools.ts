import type { TSchema } from 'typebox';
import type { ApplicationOperation } from '../../hostDomain/applicationOperations';
import { modelToolContract } from '../../../core/agent/tools';
import type { AgentTool } from '../runtime/kernel/types';
import { AgentToolFailure } from '../AgentToolFailure';
import { agentToolResult, errorEnvelope, successEnvelope } from './agentToolEnvelope';

export function createApplicationTools(
  operations: ApplicationOperation,
  caller: (itemId: string, signal?: AbortSignal) => Parameters<ApplicationOperation['inspect']>[1],
): AgentTool[] {
  return (['application_inspect', 'application_manage', 'diagnostics_inspect', 'diagnostics_manage'] as const).map((name): AgentTool => {
    const contract = modelToolContract(name)!;
    return {
      name,
      label: name,
      description: contract.description,
      parameters: contract.inputSchema as TSchema,
      executionMode: 'sequential',
      execute: async (itemId, input, signal) => {
        try {
          const operation = caller(itemId, signal);
          const result = name === 'application_inspect'
            ? await operations.inspect(input, operation)
            : name === 'application_manage'
              ? await operations.manage(input, operation)
              : name === 'diagnostics_inspect'
                ? await operations.diagnosticsInspect(input, operation)
                : await operations.diagnosticsManage(input, operation);
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
