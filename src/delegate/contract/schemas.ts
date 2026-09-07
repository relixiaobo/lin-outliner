import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import {
  DELEGATE_MAX_MESSAGE_BYTES,
  DELEGATE_MAX_PROMPT_BYTES,
  DELEGATE_PROTOCOL_VERSION,
} from './version';

const closed = { additionalProperties: false } as const;
const UUID_V7_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

export const DelegateTaskProfileSchema = Type.Union([
  Type.Literal('general'),
  Type.Literal('explore'),
  Type.Literal('plan'),
]);

export const DelegateAccessSchema = Type.Union([
  Type.Literal('read-only'),
  Type.Literal('workspace-write'),
]);

export const DelegateRunInputSchema = Type.Object({
  version: Type.Literal(DELEGATE_PROTOCOL_VERSION),
  prompt: Type.String({ minLength: 1, maxLength: DELEGATE_MAX_PROMPT_BYTES }),
  profile: DelegateTaskProfileSchema,
  access: DelegateAccessSchema,
  runner: Type.Optional(Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,63}$' })),
}, closed);

export const DelegateMessageInputSchema = Type.Object({
  version: Type.Literal(DELEGATE_PROTOCOL_VERSION),
  message: Type.String({ minLength: 1, maxLength: DELEGATE_MAX_MESSAGE_BYTES }),
}, closed);

export const DelegateUsageSchema = Type.Union([
  Type.Object({ state: Type.Literal('unknown') }, closed),
  Type.Object({
    state: Type.Literal('known'),
    inputTokens: Type.Integer({ minimum: 0 }),
    outputTokens: Type.Integer({ minimum: 0 }),
    costUsd: Type.Optional(Type.Number({ minimum: 0 })),
  }, closed),
]);

export const DelegateArtifactSchema = Type.Object({
  kind: Type.String({ minLength: 1, maxLength: 64 }),
  ref: Type.String({ minLength: 1, maxLength: 4_096 }),
}, closed);

export const DelegateWorktreeSchema = Type.Union([
  Type.Object({ disposition: Type.Literal('none') }, closed),
  Type.Object({
    disposition: Type.Literal('unchanged'),
    path: Type.String({ minLength: 1, maxLength: 32_768 }),
    baseRevision: Type.String({ minLength: 1, maxLength: 256 }),
  }, closed),
  Type.Object({
    disposition: Type.Union([Type.Literal('changed'), Type.Literal('retained'), Type.Literal('ambiguous')]),
    path: Type.String({ minLength: 1, maxLength: 32_768 }),
    baseRevision: Type.String({ minLength: 1, maxLength: 256 }),
    changedFiles: Type.Array(Type.String({ minLength: 1, maxLength: 32_768 }), { maxItems: 10_000 }),
    patchRef: Type.String({ minLength: 1, maxLength: 4_096 }),
    verification: Type.Array(Type.String({ maxLength: 4_096 }), { maxItems: 100 }),
  }, closed),
]);

export const DelegateExecutionResultSchema = Type.Object({
  version: Type.Literal(DELEGATE_PROTOCOL_VERSION),
  kind: Type.Literal('delegate.execution-result'),
  sessionId: Type.String({ pattern: UUID_V7_PATTERN }),
  turnId: Type.String({ pattern: UUID_V7_PATTERN }),
  outcome: Type.Union([
    Type.Literal('succeeded'),
    Type.Literal('failed'),
    Type.Literal('cancelled'),
    Type.Literal('timed_out'),
    Type.Literal('lost'),
  ]),
  runner: Type.Object({
    id: Type.String({ minLength: 1, maxLength: 64 }),
    version: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  }, closed),
  adapterSessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  model: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
  durationMs: Type.Integer({ minimum: 0 }),
  text: Type.Union([Type.String({ maxLength: 1024 * 1024 }), Type.Null()]),
  error: Type.Union([Type.String({ maxLength: 64 * 1024 }), Type.Null()]),
  partialEvidence: Type.Boolean(),
  committedMessageSequence: Type.Integer({ minimum: 0 }),
  continuation: Type.Union([
    Type.Literal('available'),
    Type.Literal('blocked'),
    Type.Literal('closed'),
  ]),
  usage: DelegateUsageSchema,
  artifacts: Type.Array(DelegateArtifactSchema, { maxItems: 1_000 }),
  worktree: DelegateWorktreeSchema,
}, closed);

export const DelegateMessageReceiptSchema = Type.Object({
  version: Type.Literal(DELEGATE_PROTOCOL_VERSION),
  kind: Type.Literal('delegate.message-receipt'),
  sessionId: Type.String({ pattern: UUID_V7_PATTERN }),
  sequence: Type.Integer({ minimum: 1 }),
  state: Type.Union([
    Type.Literal('queued'),
    Type.Literal('committed'),
    Type.Literal('blocked'),
  ]),
  taskId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
}, closed);

export const DelegateCloseReceiptSchema = Type.Object({
  version: Type.Literal(DELEGATE_PROTOCOL_VERSION),
  kind: Type.Literal('delegate.close-receipt'),
  sessionId: Type.String({ pattern: UUID_V7_PATTERN }),
  closed: Type.Literal(true),
}, closed);

export const DelegateResultSchema = Type.Union([
  DelegateExecutionResultSchema,
  DelegateMessageReceiptSchema,
  DelegateCloseReceiptSchema,
]);

export type DelegateTaskProfile = Static<typeof DelegateTaskProfileSchema>;
export type DelegateAccess = Static<typeof DelegateAccessSchema>;
export type DelegateUsage = Static<typeof DelegateUsageSchema>;
export type DelegateRunInput = Static<typeof DelegateRunInputSchema>;
export type DelegateMessageInput = Static<typeof DelegateMessageInputSchema>;
export type DelegateExecutionResult = Static<typeof DelegateExecutionResultSchema>;
export type DelegateMessageReceipt = Static<typeof DelegateMessageReceiptSchema>;
export type DelegateCloseReceipt = Static<typeof DelegateCloseReceiptSchema>;
export type DelegateResult = Static<typeof DelegateResultSchema>;

const runInputValidator = Compile(DelegateRunInputSchema);
const messageInputValidator = Compile(DelegateMessageInputSchema);
const executionResultValidator = Compile(DelegateExecutionResultSchema);

export function decodeDelegateRunInput(value: unknown): DelegateRunInput {
  if (!runInputValidator.Check(value)) {
    throw new Error(validationMessage('delegation run input', runInputValidator.Errors(value)));
  }
  const input = value as DelegateRunInput;
  assertUtf8Bound(input.prompt, DELEGATE_MAX_PROMPT_BYTES, 'prompt');
  if ((input.profile === 'explore' || input.profile === 'plan') && input.access !== 'read-only') {
    throw new Error(`${input.profile} delegation requires read-only access.`);
  }
  return Object.freeze({ ...input });
}

export function decodeDelegateMessageInput(value: unknown): DelegateMessageInput {
  if (!messageInputValidator.Check(value)) {
    throw new Error(validationMessage('delegation message input', messageInputValidator.Errors(value)));
  }
  const input = value as DelegateMessageInput;
  assertUtf8Bound(input.message, DELEGATE_MAX_MESSAGE_BYTES, 'message');
  return Object.freeze({ ...input });
}

export function decodeDelegateExecutionResult(value: unknown): DelegateExecutionResult {
  if (!executionResultValidator.Check(value)) {
    throw new Error(validationMessage('delegation execution result', executionResultValidator.Errors(value)));
  }
  return structuredClone(value) as DelegateExecutionResult;
}

function assertUtf8Bound(value: string, maxBytes: number, field: string): void {
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`${field} exceeds the ${maxBytes}-byte UTF-8 limit.`);
  }
}

function validationMessage(label: string, errors: Iterable<{ readonly instancePath: string; readonly message: string }>): string {
  const detail = [...errors]
    .slice(0, 5)
    .map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
  return `Invalid ${label}: ${detail || 'value does not match the schema'}.`;
}
