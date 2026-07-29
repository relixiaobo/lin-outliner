import type { AgentTool, AgentToolResult } from '../runtime/kernel/types';
import type { TSchema } from 'typebox';
import type { JsonValue } from '../../../core/agent/protocol';
import { modelToolContract } from '../../../core/agent/tools';
import type { AutomationCreateInput, AutomationUpdateInput } from '../../../core/agent/automation';
import type { AutomationService } from './AutomationService';

export function createAutomationTool(service: AutomationService): AgentTool {
  const contract = modelToolContract('codex_app.automation_update');
  if (!contract?.inputSchema) throw new Error('Missing codex_app.automation_update contract');
  return {
    name: 'codex_app__automation_update',
    label: 'Update Automation',
    description: contract.description,
    parameters: contract.inputSchema as TSchema,
    executionMode: 'sequential',
    execute: async (_itemId, value, signal) => {
      if (signal?.aborted) throw abortError();
      const input = objectValue(value, 'codex_app.automation_update');
      const mode = requiredString(input.mode, 'mode');
      let result: unknown;
      switch (mode) {
        case 'create':
          exactKeys(input, ['mode', 'definition']);
          result = { automation: await service.create(input.definition as AutomationCreateInput) };
          break;
        case 'update': {
          exactKeys(input, ['mode', 'automation_id', 'expected_revision', 'patch']);
          const patch = objectValue(input.patch, 'patch');
          result = {
            automation: await service.update({
              id: requiredString(input.automation_id, 'automation_id'),
              expectedRevision: positiveInteger(input.expected_revision, 'expected_revision'),
              ...patch,
            } as AutomationUpdateInput),
          };
          break;
        }
        case 'view':
          exactKeys(input, ['mode', 'automation_id']);
          result = input.automation_id === undefined
            ? await service.request('list', {})
            : await service.request('read', { id: requiredString(input.automation_id, 'automation_id') });
          break;
        case 'delete':
          exactKeys(input, ['mode', 'automation_id', 'expected_revision']);
          result = await service.request('delete', {
            id: requiredString(input.automation_id, 'automation_id'),
            expectedRevision: positiveInteger(input.expected_revision, 'expected_revision'),
          });
          break;
        default:
          throw new Error(`Unknown codex_app.automation_update mode: ${mode}`);
      }
      return toolResult(result);
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

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const expected = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !expected.has(key));
  if (unknown.length > 0) throw new Error(`codex_app.automation_update contains unknown fields: ${unknown.join(', ')}`);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value.trim();
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${path} must be a positive integer`);
  return value as number;
}

function abortError(): Error {
  const error = new Error('Automation update was interrupted');
  error.name = 'AbortError';
  return error;
}
