import type { TSchema } from 'typebox';
import type { ApplicationOperation } from '../../hostDomain/applicationOperations';
import { modelToolContract } from '../../../core/agent/tools';
import type { ApplicationManageResult, DiagnosticsManageResult } from '../../../core/applicationOperations';
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
          const failure = semanticFailure(name, result);
          if (failure) {
            const data = { result };
            return agentToolResult(errorEnvelope(name, failure.code, failure.message, {
              data,
              instructions: failure.instructions,
            }), data);
          }
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

function semanticFailure(
  name: string,
  result: unknown,
): { code: string; message: string; instructions: string } | null {
  if (name === 'application_manage') {
    const application = result as ApplicationManageResult;
    if (application.operation === 'check_updates' && application.updates.manualError) {
      const code = application.updates.manualError.replace('-', '_');
      return {
        code: `update_check_${code}`,
        message: application.updates.manualError === 'timeout'
          ? 'The fresh update check timed out.'
          : application.updates.manualError === 'invalid-response'
            ? 'The fresh update check returned an invalid response.'
            : 'The fresh update check could not reach the update service.',
        instructions: 'Cached update state remains observational data only. Retry a fresh check later before claiming the check succeeded.',
      };
    }
    if (
      (application.operation === 'open_update'
        || (application.operation === 'open_destination' && 'result' in application))
      && !application.result.ok
    ) {
      return application.result.error === 'unavailable'
        ? {
            code: 'update_unavailable',
            message: 'No validated update destination is currently available.',
            instructions: 'Inspect update state or run a fresh update check before trying to open an update destination.',
          }
        : {
            code: 'update_open_failed',
            message: 'The validated update destination could not be opened.',
            instructions: 'Keep the cached update state separate from this failed open and retry only if the user still wants it opened.',
          };
    }
  }
  if (name === 'diagnostics_manage') {
    const diagnostics = result as DiagnosticsManageResult;
    if (diagnostics.ok) return null;
    if ('canceled' in diagnostics) {
      return {
        code: 'cancelled',
        message: 'The diagnostics export was cancelled.',
        instructions: 'Do not retry the export unless the user asks for another save interaction.',
      };
    }
    return {
      code: `diagnostics_${diagnostics.operation}_failed`,
      message: `The diagnostics ${diagnostics.operation} operation failed.`,
      instructions: diagnostics.operation === 'export'
        ? 'Keep diagnostics local and retry through a new native save interaction.'
        : 'Inspect diagnostics status before retrying the reveal operation.',
    };
  }
  return null;
}
