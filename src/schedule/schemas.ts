import { Compile, type Validator } from 'typebox/compile';
import type { TSchema } from 'typebox';
import { REASONING_EFFORTS } from '../core/agent/configuration';
import type { ScheduleOperation } from './contract';

type Schema = Record<string, unknown>;
const string = (maximum: number): Schema => ({ type: 'string', minLength: 1, maxLength: maximum, pattern: '\\S' });
const object = (properties: Record<string, Schema>, required: readonly string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const uuid = { ...string(36), pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' };
const revision = { type: 'integer', minimum: 1 };
const requestId = string(256);
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });
const schedule = object({ rrule: string(4096), timezone: string(128) }, ['rrule', 'timezone']);
const location = object({ contextHintId: uuid, executionMode: { enum: ['local', 'worktree'] }, source: { anyOf: [
  object({ kind: { const: 'directory' }, rootHint: string(4096) }, ['kind', 'rootHint']),
  object({ kind: { const: 'project' }, projectId: uuid }, ['kind', 'projectId']),
] } }, ['source', 'executionMode']);
const definition = {
  name: string(200), prompt: string(120_000), schedule,
  materials: { type: 'array', maxItems: 32, items: object({ kind: { enum: ['file', 'note', 'url'] }, reference: string(4096), required: { type: 'boolean', default: true } }, ['kind', 'reference']) },
  contextHints: { type: 'array', maxItems: 1, items: location },
  configuration: object({ modelProvider: nullable(string(256)), model: nullable(string(256)), reasoningEffort: nullable({ enum: [...REASONING_EFFORTS] }) }),
};
const missed = { contextHintId: { anyOf: [uuid, { const: 'default' }] }, scheduledFor: { type: 'integer', minimum: 0 } };
const cache = new Map<ScheduleOperation, Validator>();

export function scheduleInputSchema(operation: ScheduleOperation): Schema {
  const base = { requestId, expectedRevision: revision };
  switch (operation) {
    case 'create': return object({ requestId, ...definition, status: { enum: ['active', 'paused'] } }, ['requestId', 'name', 'prompt', 'schedule']);
    case 'update': return { ...object({ ...base, ...definition }, ['requestId', 'expectedRevision']), anyOf: Object.keys(definition).map((key) => ({ required: [key] })) };
    case 'run': return { oneOf: [object(base, ['requestId', 'expectedRevision']), object({ ...base, ...missed }, ['requestId', 'expectedRevision', 'contextHintId', 'scheduledFor'])] };
    case 'skip': return object({ ...base, ...missed }, ['requestId', 'expectedRevision', 'contextHintId', 'scheduledFor']);
    case 'stop': return object({ requestId, taskId: string(256) }, ['requestId']);
    case 'acknowledge': return object({ requestId, issueKey: { ...string(64), pattern: '^[a-f0-9]{64}$' } }, ['requestId', 'issueKey']);
    case 'pause': case 'resume': case 'archive': case 'restore': return object(base, ['requestId', 'expectedRevision']);
    default: return object({});
  }
}

export function decodeScheduleInput(operation: ScheduleOperation, value: unknown): Record<string, unknown> {
  let validator = cache.get(operation);
  if (!validator) { validator = Compile(scheduleInputSchema(operation) as TSchema); cache.set(operation, validator); }
  if (!validator.Check(value)) {
    const errors = validator.Errors(value).slice(0, 4).map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ');
    throw new Error(`Invalid schedule ${operation} input: ${errors}. Use schedule schema for the exact contract.`);
  }
  return value as Record<string, unknown>;
}
