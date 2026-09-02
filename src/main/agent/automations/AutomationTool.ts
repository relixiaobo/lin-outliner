import type { AgentTool, AgentToolResult } from '../runtime/kernel/types';
import type { TSchema } from 'typebox';
import type { JsonValue } from '../../../core/agent/protocol';
import { modelToolContract } from '../../../core/agent/tools';
import { decodeAutomationToolInput } from '../../../core/agent/automation';
import type { AutomationService } from './AutomationService';
import { agentToolResult, errorEnvelope, successEnvelope } from '../capabilities/agentToolEnvelope';
import { AgentToolFailure } from '../AgentToolFailure';

export function createAutomationTool(service: AutomationService): AgentTool {
  const contract = modelToolContract('automation_update');
  if (!contract?.inputSchema) throw new Error('Missing automation_update contract');
  return {
    name: 'automation_update',
    label: 'Update Automation',
    description: contract.description,
    parameters: contract.inputSchema as TSchema,
    executionMode: 'sequential',
    execute: async (_itemId, value, signal) => {
      if (signal?.aborted) throw abortError();
      try {
        const command = decodeAutomationToolInput(value);
        switch (command.mode) {
          case 'create':
            return toolResult({ automation: await service.create(command.create) });
          case 'update':
            return toolResult({ automation: await service.update(command.update) });
          case 'view':
            return toolResult(command.id === null
              ? await service.request('list', {})
              : await service.request('read', { id: command.id }));
          case 'delete':
            return toolResult(await service.request('delete', {
              id: command.id,
              expectedRevision: command.expectedRevision,
            }));
        }
      } catch (error) {
        if (!(error instanceof AgentToolFailure)) throw error;
        return agentToolResult(errorEnvelope('automation_update', error.code, error.message, {
          instructions: error.instructions,
        }));
      }
    },
  };
}

function toolResult(value: unknown): AgentToolResult<unknown> {
  const details = JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
  return agentToolResult(successEnvelope('automation_update', details), details);
}

function abortError(): Error {
  const error = new Error('Automation update was interrupted');
  error.name = 'AbortError';
  return error;
}
