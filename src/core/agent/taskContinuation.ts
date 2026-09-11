/** Compact responsibility and event facts owned by the existing Tool Task record. */
export interface TaskItemReference {
  readonly turnId: string;
  readonly itemId: string;
}

export type TaskCompletionAgreement =
  | { readonly kind: 'result' }
  | { readonly kind: 'service'; readonly watchRequest?: TaskItemReference };

export type TaskLaunchAgreement = TaskCompletionAgreement | { readonly kind: 'service'; readonly watchRequest: 'current_request' };

export function decodeTaskLaunchAgreement(value: unknown): TaskLaunchAgreement {
  const r = record(value, ['kind', 'watchRequest']);
  return r.kind === 'service' && r.watchRequest === 'current_request'
    ? { kind: 'service', watchRequest: 'current_request' } : decodeTaskCompletionAgreement(value);
}

export type TaskEventHandling =
  | { readonly kind: 'turn'; readonly turnId: string; readonly itemId: string }
  | { readonly kind: 'completion'; readonly turnId: string; readonly batchId: string };

export interface TaskTerminalEvent {
  readonly id: string;
  readonly disposition: 'pending' | 'silent' | 'handled' | 'admitted';
  readonly reason: 'handed_off' | 'stopped' | 'watch_revoked' | null;
  readonly handling: TaskEventHandling | null;
}

export interface TaskStopProvenance {
  readonly source: 'user' | 'agent' | 'shutdown' | 'turnCancellation';
  readonly at: number;
  readonly turnId: string | null;
}

export interface TaskContinuation {
  readonly kind: 'result' | 'service';
  readonly revision: number;
  readonly handoff: { readonly by: TaskItemReference; readonly readiness: readonly TaskItemReference[] } | null;
  readonly watch: { readonly id: string; readonly request: TaskItemReference; readonly revokedAt: number | null } | null;
  readonly stop: TaskStopProvenance | null;
  readonly event: TaskTerminalEvent | null;
}

export type TaskControlAction =
  | { readonly action: 'handoff'; readonly expected_revision: number; readonly readiness: readonly TaskItemReference[] }
  | { readonly action: 'acknowledge'; readonly event_id: string }
  | { readonly action: 'start_watch'; readonly expected_revision: number; readonly request: TaskItemReference }
  | { readonly action: 'revoke_watch'; readonly expected_revision: number; readonly watch_id: string };

export type TaskControlInput = TaskControlAction & { readonly task_id: string; readonly operation_id: string };

export interface TaskControlReceipt {
  readonly operationId: string;
  readonly taskId: string;
  readonly action: TaskControlAction['action'];
  readonly status: 'accepted' | 'conflict' | 'already_handled';
  readonly revision: number;
  readonly watchId: string | null;
  readonly event: TaskTerminalEvent | null;
}

export function decodeTaskControlReceipt(value: unknown): TaskControlReceipt {
  const r = record(value, ['operationId', 'taskId', 'action', 'status', 'revision', 'watchId', 'event']);
  if (!['handoff', 'acknowledge', 'start_watch', 'revoke_watch'].includes(String(r.action))
    || !['accepted', 'conflict', 'already_handled'].includes(String(r.status))) throw new Error('Invalid Task operation receipt');
  return { operationId: identifier(r.operationId), taskId: identifier(r.taskId),
    action: r.action as TaskControlAction['action'], status: r.status as TaskControlReceipt['status'],
    revision: integer(r.revision), watchId: r.watchId === null ? null : identifier(r.watchId), event: decodeTaskTerminalEvent(r.event) };
}

export function taskDeliverySettled(state: string): boolean {
  return state === 'delivered' || state === 'silent' || state === 'handled';
}

export function initialTaskContinuation(agreement: TaskCompletionAgreement = { kind: 'result' }, watchId?: string): TaskContinuation {
  if (agreement.kind === 'service' && agreement.watchRequest && !watchId) throw new Error('A service watch requires an identity');
  return { kind: agreement.kind, revision: 0, handoff: null, stop: null, event: null,
    watch: agreement.kind === 'service' && agreement.watchRequest && watchId
      ? { id: watchId, request: agreement.watchRequest, revokedAt: null } : null };
}

export function taskOwesContinuation(task: TaskContinuation): boolean {
  return task.stop === null && (task.kind === 'result' || task.handoff === null || task.watch?.revokedAt === null);
}

export function settleTaskEvent(task: TaskContinuation, id: string): TaskTerminalEvent {
  return taskOwesContinuation(task)
    ? { id, disposition: 'pending', reason: null, handling: null }
    : { id, disposition: 'silent', reason: task.stop ? 'stopped' : task.watch ? 'watch_revoked' : 'handed_off', handling: null };
}

export function decodeTaskItemReference(value: unknown): TaskItemReference {
  const r = record(value, ['turnId', 'itemId']);
  return { turnId: identifier(r.turnId), itemId: identifier(r.itemId) };
}

export function decodeTaskCompletionAgreement(value: unknown): TaskCompletionAgreement {
  const r = record(value, ['kind', 'watchRequest']);
  if (r.kind === 'result' && r.watchRequest === undefined) return { kind: 'result' };
  if (r.kind !== 'service') throw new Error('Invalid Task completion agreement');
  return { kind: 'service', ...(r.watchRequest === undefined ? {} : { watchRequest: decodeTaskItemReference(r.watchRequest) }) };
}

export function decodeTaskControlInput(value: unknown): TaskControlInput {
  return decodeActionRequest(value, 'request') as TaskControlInput;
}

export function decodeTaskContinuation(value: unknown): TaskContinuation {
  const r = record(value, ['kind', 'revision', 'handoff', 'watch', 'stop', 'event']);
  if (r.kind !== 'result' && r.kind !== 'service') throw new Error('Invalid Task responsibility kind');
  let handoff: TaskContinuation['handoff'] = null;
  if (r.handoff !== null) {
    const h = record(r.handoff, ['by', 'readiness']);
    handoff = { by: decodeTaskItemReference(h.by), readiness: references(h.readiness) };
  }
  let watch: TaskContinuation['watch'] = null;
  if (r.watch !== null) {
    const w = record(r.watch, ['id', 'request', 'revokedAt']);
    watch = { id: identifier(w.id), request: decodeTaskItemReference(w.request), revokedAt: w.revokedAt === null ? null : integer(w.revokedAt) };
  }
  let stop: TaskStopProvenance | null = null;
  if (r.stop !== null) {
    const s = record(r.stop, ['source', 'at', 'turnId']);
    if (!['user', 'agent', 'shutdown', 'turnCancellation'].includes(String(s.source))) throw new Error('Invalid Task Stop source');
    stop = { source: s.source as TaskStopProvenance['source'], at: integer(s.at), turnId: s.turnId === null ? null : identifier(s.turnId) };
  }
  if (r.kind === 'result' && (handoff || watch)) throw new Error('Finite Task cannot have a service handoff or watch');
  return { kind: r.kind, revision: integer(r.revision), handoff, watch, stop, event: decodeTaskTerminalEvent(r.event) };
}

export function decodeTaskTerminalEvent(value: unknown): TaskTerminalEvent | null {
  if (value === null) return null;
  const e = record(value, ['id', 'disposition', 'reason', 'handling']);
  if (!['pending', 'silent', 'handled', 'admitted'].includes(String(e.disposition))) throw new Error('Invalid Task event disposition');
  if (e.reason !== null && !['handed_off', 'stopped', 'watch_revoked'].includes(String(e.reason))) throw new Error('Invalid Task silent reason');
  let handling: TaskEventHandling | null = null;
  if (e.handling !== null) {
    const h = record(e.handling, ['kind', 'turnId', 'itemId', 'batchId']);
    if (h.kind === 'turn') {
      record(h, ['kind', 'turnId', 'itemId']);
      handling = { kind: 'turn', turnId: identifier(h.turnId), itemId: identifier(h.itemId) };
    } else if (h.kind === 'completion') {
      record(h, ['kind', 'turnId', 'batchId']);
      handling = { kind: 'completion', turnId: identifier(h.turnId), batchId: identifier(h.batchId) };
    } else throw new Error('Invalid Task event handler');
  }
  if ((e.disposition === 'silent') !== (e.reason !== null)
    || (e.disposition === 'handled') !== (handling?.kind === 'turn')
    || (e.disposition === 'admitted') !== (handling?.kind === 'completion')) throw new Error('Inconsistent Task event disposition');
  return { id: identifier(e.id), disposition: e.disposition as TaskTerminalEvent['disposition'], reason: e.reason as TaskTerminalEvent['reason'], handling };
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !fields.includes(key))) throw new Error('Invalid Task responsibility fields');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('Invalid Task reference');
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('Invalid Task responsibility revision or timestamp');
  return value as number;
}
function references(value: unknown): readonly TaskItemReference[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new Error('Handoff requires one to eight completed readiness references');
  return value.map(decodeTaskItemReference);
}

const idSchema = { type: 'string', minLength: 1, maxLength: 256 } as const;
const revisionSchema = { type: 'integer', minimum: 0 } as const;
export const TASK_ITEM_REFERENCE_SCHEMA = { type: 'object', properties: { turnId: idSchema, itemId: idSchema }, required: ['turnId', 'itemId'], additionalProperties: false } as const;
export const TASK_COMPLETION_AGREEMENT_SCHEMA = {
  type: 'object', properties: { kind: { enum: ['result', 'service'] }, watchRequest: { anyOf: [TASK_ITEM_REFERENCE_SCHEMA, { const: 'current_request' }], description: 'Only for an explicitly requested watch. current_request binds the latest reader request in the authorized Turn lineage.' } },
  required: ['kind'], additionalProperties: false,
  description: 'Default result: a finite job owes its result. Service: a user-requested application must be verified and explicitly handed off. watchRequest references an explicit reader request to monitor that exact service; background execution alone never grants monitoring.',
} as const;
const eventSchema = { type: ['object', 'null'], properties: {
  id: idSchema, disposition: { enum: ['pending', 'silent', 'handled', 'admitted'] },
  reason: { enum: ['handed_off', 'stopped', 'watch_revoked', null] },
  handling: { type: ['object', 'null'], properties: { kind: { enum: ['turn', 'completion'] }, turnId: idSchema, itemId: idSchema, batchId: idSchema }, required: ['kind', 'turnId'], additionalProperties: false },
}, required: ['id', 'disposition', 'reason', 'handling'], additionalProperties: false } as const;
export const TASK_CONTINUATION_SCHEMA = { type: 'object', properties: {
  kind: { enum: ['result', 'service'] }, revision: revisionSchema,
  handoff: { type: ['object', 'null'], properties: { by: TASK_ITEM_REFERENCE_SCHEMA, readiness: { type: 'array', items: TASK_ITEM_REFERENCE_SCHEMA, minItems: 1, maxItems: 8 } }, required: ['by', 'readiness'], additionalProperties: false },
  watch: { type: ['object', 'null'], properties: { id: idSchema, request: TASK_ITEM_REFERENCE_SCHEMA, revokedAt: { type: ['integer', 'null'] } }, required: ['id', 'request', 'revokedAt'], additionalProperties: false },
  stop: { type: ['object', 'null'], properties: { source: { enum: ['user', 'agent', 'shutdown', 'turnCancellation'] }, at: revisionSchema, turnId: { type: ['string', 'null'] } }, required: ['source', 'at', 'turnId'], additionalProperties: false },
  event: eventSchema,
}, required: ['kind', 'revision', 'handoff', 'watch', 'stop', 'event'], additionalProperties: false } as const;
export const TASK_CONTROL_RECEIPT_SCHEMA = { type: ['object', 'null'], properties: {
  operationId: idSchema, taskId: idSchema, action: { enum: ['handoff', 'acknowledge', 'start_watch', 'revoke_watch'] },
  status: { enum: ['accepted', 'conflict', 'already_handled'] }, revision: revisionSchema,
  watchId: { type: ['string', 'null'] }, event: eventSchema,
}, required: ['operationId', 'taskId', 'action', 'status', 'revision', 'watchId', 'event'], additionalProperties: false } as const;
// One action definition feeds model schemas and exact action admission.
// Field order (including reference properties) preserves stored operation digests.
const actionFields = {
  handoff: ['expected_revision', 'readiness'],
  acknowledge: ['event_id'],
  start_watch: ['expected_revision', 'request'],
  revoke_watch: ['expected_revision', 'watch_id'],
} as const;
const inputIdSchema = { ...idSchema, pattern: '\\S' } as const;
const inputReferenceSchema = { ...TASK_ITEM_REFERENCE_SCHEMA,
  properties: { turnId: inputIdSchema, itemId: inputIdSchema } };
const fieldSchemas: Record<string, Record<string, unknown>> = {
  task_id: inputIdSchema,
  operation_id: { ...inputIdSchema, description: 'Stable exact-input identity. Reconcile lost replies with task_status; never reuse it for different input.' },
  expected_revision: { ...revisionSchema, maximum: Number.MAX_SAFE_INTEGER },
  readiness: { type: 'array', items: inputReferenceSchema, minItems: 1, maxItems: 8 },
  request: inputReferenceSchema, event_id: inputIdSchema, watch_id: inputIdSchema,
};
const commonFields = ['task_id', 'operation_id', 'action'];
export const TASK_CONTROL_INPUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['request'],
  properties: { request: { anyOf: Object.entries(actionFields).map(([action, fields]) => ({
    type: 'object', additionalProperties: false,
    properties: { ...Object.fromEntries([...commonFields, ...fields]
      .filter((field) => field !== 'action').map((field) => [field, fieldSchemas[field]])),
      action: { type: 'string', const: action } },
    required: [...commonFields, ...fields],
  })) } },
} as const;

export function decodeTaskControlToolInput(value: unknown): { request: TaskControlInput } {
  const outer = inputRecord(value, '', ['request']);
  return { request: decodeTaskControlInput(outer.request) };
}

function inputError(path: string, reason: string, fields?: readonly string[]): never {
  // Paths contain only contract field names or bounded array indices, never
  // arbitrary rejected keys/values (which can contain credentials).
  throw new Error(`Invalid Task control input at ${path || '/'}: ${reason}.`
    + (fields ? ` Required and allowed fields: ${fields.join(', ')}.` : '')
    + ' Correct the input before retrying; changing operation_id alone does not repair it.');
}
function inputRecord(value: unknown, path: string, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) inputError(path, 'expected an object', fields);
  const r = value as Record<string, unknown>;
  const missing = fields.find((field) => !Object.hasOwn(r, field));
  if (missing) inputError(`${path}/${missing}`, 'required field is missing', fields);
  const extra = Object.keys(r).find((field) => !fields.includes(field));
  if (extra) inputError(Object.hasOwn(fieldSchemas, extra) ? `${path}/${extra}` : path,
    'field is not allowed for this action', fields);
  return r;
}
function decodeActionRequest(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) inputError(path, 'expected an action object');
  const action = (value as Record<string, unknown>).action;
  if (typeof action !== 'string' || !Object.hasOwn(actionFields, action)) {
    inputError(`${path}/action`, `expected one of ${Object.keys(actionFields).join(', ')}`);
  }
  const fields = [...commonFields, ...actionFields[action as keyof typeof actionFields]];
  const r = inputRecord(value, path, fields);
  return Object.fromEntries(fields.map((field) => [field, field === 'action' ? action
    : decodeInputField(r[field], fieldSchemas[field]!, `${path}/${field}`)]));
}
function decodeInputField(value: unknown, schema: Record<string, unknown>, path: string): unknown {
  if (schema.type === 'string') {
    if (typeof value !== 'string' || !value.trim() || value.length > Number(schema.maxLength)) {
      inputError(path, `expected a nonblank string of at most ${schema.maxLength} characters`);
    }
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || Number(value) < Number(schema.minimum)) inputError(path, 'expected a nonnegative safe integer');
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < Number(schema.minItems) || value.length > Number(schema.maxItems)) {
      inputError(path, `expected ${schema.minItems} to ${schema.maxItems} references`);
    }
    return (value as unknown[]).map((entry, index) => decodeInputField(entry, schema.items as Record<string, unknown>, `${path}/${index}`));
  } else if (schema.type === 'object') {
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const r = inputRecord(value, path, Object.keys(properties));
    return Object.fromEntries(Object.entries(properties)
      .map(([field, child]) => [field, decodeInputField(r[field], child, `${path}/${field}`)]));
  }
  return value;
}
