import type { AgentTool, AgentToolResult } from '../runtime/kernel/types';
import type { TSchema } from 'typebox';
import type { JsonValue } from '../../../core/agent/protocol';
import { modelToolContract } from '../../../core/agent/tools';
import { decodeAutomationToolInput } from '../../../core/agent/automation';
import type { AutomationService } from './AutomationService';

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
    },
  };
}

function toolResult(value: unknown): AgentToolResult<JsonValue> {
  const details = JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
  return {
    content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function abortError(): Error {
  const error = new Error('Automation update was interrupted');
  error.name = 'AbortError';
  return error;
}
