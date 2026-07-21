import {
  REQUEST_USER_INPUT_MAX_AUTO_RESOLUTION_MS,
  REQUEST_USER_INPUT_MIN_AUTO_RESOLUTION_MS,
  type CollaborationToolName,
  type RequestUserInputOption,
  type RequestUserInputQuestion,
} from './protocol';
import { decodeRequestUserInputQuestions } from './codec';

export {
  REQUEST_USER_INPUT_MAX_AUTO_RESOLUTION_MS,
  REQUEST_USER_INPUT_MIN_AUTO_RESOLUTION_MS,
} from './protocol';

export interface ModelToolIdentity {
  readonly namespace: string | null;
  readonly name: string;
}

export type JsonSchema = Readonly<Record<string, unknown>>;
export type ModelToolScope = 'rootThread' | 'anyThread';
export type ModelToolSchemaOwner = 'core' | 'capability' | 'configuration' | 'extension';

export interface ModelToolContract {
  readonly identity: ModelToolIdentity;
  readonly description: string;
  readonly scope: ModelToolScope;
  readonly schemaOwner: ModelToolSchemaOwner;
  /**
   * Core-owned tools carry a static schema. A null capability schema means the
   * retained capability must contribute its existing canonical schema when the
   * runtime assembles the registry; it never means an unconstrained schema.
   */
  readonly inputSchema: JsonSchema | null;
  readonly outputSchema?: JsonSchema | null;
  readonly actionKinds: readonly ModelToolActionKind[];
}

export interface ModelToolSchemaContribution {
  readonly identity: ModelToolIdentity;
  readonly owner: 'capability' | 'configuration';
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema | null;
}

export const COLLABORATION_NAMESPACE = 'collaboration';
export const COLLABORATION_TOOL_NAMES = [
  'spawn_agent',
  'send_message',
  'followup_task',
  'wait_agent',
  'list_agents',
  'interrupt_agent',
] as const satisfies readonly CollaborationToolName[];

export const RETAINED_CAPABILITY_TOOL_NAMES = [
  'node_search',
  'node_read',
  'node_create',
  'node_edit',
  'node_delete',
  'outline_undo_stack',
  'file_read',
  'file_glob',
  'file_grep',
  'file_edit',
  'file_write',
  'file_delete',
  'bash',
  'bash_stop',
  'web_search',
  'web_fetch',
  'generate_image',
  'data_import',
] as const;

export const CORE_CONTROL_TOOL_NAMES = [
  'request_user_input',
  'update_plan',
  'get_goal',
  'create_goal',
  'update_goal',
] as const;

export const CONFIGURATION_TOOL_NAMES = ['skill'] as const;

export const MODEL_TOOL_ACTION_KINDS = [
  'file.read.local_path',
  'file.read.sensitive_local_path',
  'file.edit.local_path',
  'file.write.local_path',
  'file.write.sensitive_local_path',
  'file.delete.local_path',
  'outline.read',
  'outline.edit',
  'outline.delete',
  'web.search',
  'web.fetch',
  'shell.read_search',
  'shell.project_script',
  'shell.local_code_execution',
  'shell.dependency_install',
  'shell.network_write',
  'shell.destructive_cleanup',
  'shell.background_process',
  'shell.unknown',
  'shell.stop',
  'git.publish_remote',
  'deploy.publish_remote',
  'external.message.send',
  'agent.user_input.request',
  'agent.plan.update',
  'agent.goal.read',
  'agent.goal.create',
  'agent.goal.update',
  'agent.subagent.spawn',
  'agent.subagent.read',
  'agent.subagent.send',
  'agent.subagent.interrupt',
  'agent.skill.invoke',
  'agent.image.generate',
  'agent.data.import',
] as const;

export type ModelToolActionKind = typeof MODEL_TOOL_ACTION_KINDS[number];

const READ_ONLY_ACTION_KINDS = new Set<ModelToolActionKind>([
  'file.read.local_path',
  'file.read.sensitive_local_path',
  'outline.read',
  'web.search',
  'web.fetch',
  'shell.read_search',
  'agent.goal.read',
  'agent.subagent.read',
]);

export type RequestUserInputToolOption = RequestUserInputOption;
export type RequestUserInputToolQuestion = RequestUserInputQuestion;

export interface RequestUserInputToolInput {
  readonly questions: readonly RequestUserInputToolQuestion[];
  readonly autoResolutionMs?: number;
}

export interface UpdatePlanToolStep {
  readonly step: string;
  readonly status: 'pending' | 'in_progress' | 'completed';
}

export interface UpdatePlanToolInput {
  readonly explanation?: string;
  readonly plan: readonly UpdatePlanToolStep[];
}

const stringSchema = (description?: string): JsonSchema => ({
  type: 'string',
  ...(description ? { description } : {}),
});

const numberSchema = (description?: string): JsonSchema => ({
  type: 'number',
  ...(description ? { description } : {}),
});

const objectSchema = (
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[] = [],
): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const arraySchema = (items: JsonSchema, description?: string): JsonSchema => ({
  type: 'array',
  items,
  ...(description ? { description } : {}),
});

const enumSchema = (values: readonly string[], description?: string): JsonSchema => ({
  type: 'string',
  enum: values,
  ...(description ? { description } : {}),
});

const requestUserInputSchema = objectSchema({
  questions: arraySchema(objectSchema({
    id: stringSchema('Stable snake-case identifier used to map the answer.'),
    header: stringSchema('Short UI header, at most 12 characters.'),
    question: stringSchema('One sentence shown to the user.'),
    options: arraySchema(objectSchema({
      label: stringSchema('User-facing label of one to five words.'),
      description: stringSchema('One sentence explaining the trade-off.'),
    }, ['label', 'description'])),
  }, ['id', 'header', 'question', 'options'])),
  autoResolutionMs: numberSchema(
    `Optional non-blocking timeout from ${REQUEST_USER_INPUT_MIN_AUTO_RESOLUTION_MS} to ${REQUEST_USER_INPUT_MAX_AUTO_RESOLUTION_MS} milliseconds.`,
  ),
}, ['questions']);

const updatePlanSchema = objectSchema({
  explanation: stringSchema('Optional explanation for the plan update.'),
  plan: arraySchema(objectSchema({
    step: stringSchema('Task step text.'),
    status: enumSchema(['pending', 'in_progress', 'completed']),
  }, ['step', 'status'])),
}, ['plan']);

const spawnAgentSchema = objectSchema({
  task_name: stringSchema('Lowercase task name using letters, digits, and underscores.'),
  message: stringSchema('Initial plain-text task for the new Subagent.'),
  fork_turns: stringSchema('Use none, all, or a positive integer string. Defaults to all.'),
  agent_type: stringSchema('Agent Role override. Omit unless explicitly requested.'),
  model: stringSchema('Model override. Omit unless an explicit override is needed.'),
  reasoning_effort: stringSchema('Reasoning effort override. Omit to inherit the parent effort.'),
}, ['task_name', 'message']);

const collaborationMessageSchema = objectSchema({
  target: stringSchema('Relative or canonical task path returned by spawn_agent.'),
  message: stringSchema('Message text for the target Subagent.'),
}, ['target', 'message']);

const collaborationTargetSchema = objectSchema({
  target: stringSchema('Relative or canonical task path returned by spawn_agent.'),
}, ['target']);

const collaborationToolContracts: readonly ModelToolContract[] = [
  {
    identity: { namespace: COLLABORATION_NAMESPACE, name: 'spawn_agent' },
    description: 'Create a child Thread, resolve its Agent Role, and start its first Turn.',
    scope: 'anyThread',
    schemaOwner: 'core',
    inputSchema: spawnAgentSchema,
    outputSchema: objectSchema({
      task_name: stringSchema('Canonical child task path.'),
      thread_id: stringSchema('Child Thread identifier.'),
      nickname: { type: ['string', 'null'] },
    }, ['task_name', 'thread_id', 'nickname']),
    actionKinds: ['agent.subagent.spawn'],
  },
  {
    identity: { namespace: COLLABORATION_NAMESPACE, name: 'send_message' },
    description: 'Queue a message for an existing child Thread without starting a Turn.',
    scope: 'anyThread',
    schemaOwner: 'core',
    inputSchema: collaborationMessageSchema,
    actionKinds: ['agent.subagent.send'],
  },
  {
    identity: { namespace: COLLABORATION_NAMESPACE, name: 'followup_task' },
    description: 'Start a child Turn when idle or deliver the task at a safe active-Turn boundary.',
    scope: 'anyThread',
    schemaOwner: 'core',
    inputSchema: collaborationMessageSchema,
    actionKinds: ['agent.subagent.send'],
  },
  {
    identity: { namespace: COLLABORATION_NAMESPACE, name: 'wait_agent' },
    description: 'Wait for child mailbox activity, completion, steered root input, or a bounded timeout.',
    scope: 'anyThread',
    schemaOwner: 'core',
    inputSchema: objectSchema({
      timeout_ms: numberSchema('Bounded wait timeout in milliseconds.'),
    }),
    actionKinds: ['agent.subagent.read'],
  },
  {
    identity: { namespace: COLLABORATION_NAMESPACE, name: 'list_agents' },
    description: 'List the live child-Thread tree, optionally below a task-path prefix.',
    scope: 'anyThread',
    schemaOwner: 'core',
    inputSchema: objectSchema({
      path_prefix: stringSchema('Task-path prefix without a trailing slash.'),
    }),
    actionKinds: ['agent.subagent.read'],
  },
  {
    identity: { namespace: COLLABORATION_NAMESPACE, name: 'interrupt_agent' },
    description: 'Interrupt a child current Turn while retaining its Thread for later work.',
    scope: 'anyThread',
    schemaOwner: 'core',
    inputSchema: collaborationTargetSchema,
    actionKinds: ['agent.subagent.interrupt'],
  },
];

const coreControlToolContracts: readonly ModelToolContract[] = [
  {
    identity: { namespace: null, name: 'request_user_input' },
    description: 'Request one to three short product questions from the user. This never requests authorization.',
    scope: 'rootThread',
    schemaOwner: 'core',
    inputSchema: requestUserInputSchema,
    actionKinds: ['agent.user_input.request'],
  },
  {
    identity: { namespace: null, name: 'update_plan' },
    description: 'Update the Turn-local execution checklist and record a plan ThreadItem.',
    scope: 'anyThread',
    schemaOwner: 'core',
    inputSchema: updatePlanSchema,
    actionKinds: ['agent.plan.update'],
  },
  {
    identity: { namespace: null, name: 'get_goal' },
    description: 'Get the Goal attached one-to-one to the current Thread.',
    scope: 'anyThread',
    schemaOwner: 'core',
    inputSchema: objectSchema({}),
    actionKinds: ['agent.goal.read'],
  },
  {
    identity: { namespace: null, name: 'create_goal' },
    description: 'Create a Goal only when explicitly requested and no unfinished Goal exists.',
    scope: 'anyThread',
    schemaOwner: 'core',
    inputSchema: objectSchema({
      objective: stringSchema('Concrete objective to pursue.'),
      token_budget: { type: 'integer', minimum: 1 },
    }, ['objective']),
    actionKinds: ['agent.goal.create'],
  },
  {
    identity: { namespace: null, name: 'update_goal' },
    description: 'Mark the current Goal complete or genuinely blocked.',
    scope: 'anyThread',
    schemaOwner: 'core',
    inputSchema: objectSchema({
      status: enumSchema(['complete', 'blocked']),
    }, ['status']),
    actionKinds: ['agent.goal.update'],
  },
];

const CAPABILITY_ACTION_KINDS = {
  node_search: ['outline.read'],
  node_read: ['outline.read'],
  node_create: ['outline.edit'],
  node_edit: ['outline.edit'],
  node_delete: ['outline.delete'],
  outline_undo_stack: ['outline.read', 'outline.edit'],
  file_read: ['file.read.local_path', 'file.read.sensitive_local_path'],
  file_glob: ['file.read.local_path', 'file.read.sensitive_local_path'],
  file_grep: ['file.read.local_path', 'file.read.sensitive_local_path'],
  file_edit: ['file.edit.local_path', 'file.write.sensitive_local_path'],
  file_write: ['file.write.local_path', 'file.write.sensitive_local_path'],
  file_delete: ['file.delete.local_path', 'file.write.sensitive_local_path'],
  bash: [
    'shell.read_search',
    'file.read.sensitive_local_path',
    'file.edit.local_path',
    'file.delete.local_path',
    'file.write.sensitive_local_path',
    'shell.project_script',
    'shell.local_code_execution',
    'shell.dependency_install',
    'shell.network_write',
    'shell.destructive_cleanup',
    'shell.background_process',
    'shell.unknown',
    'git.publish_remote',
    'deploy.publish_remote',
  ],
  bash_stop: ['shell.stop'],
  web_search: ['web.search'],
  web_fetch: ['web.fetch'],
  generate_image: ['agent.image.generate'],
  data_import: ['agent.data.import'],
} as const satisfies Record<typeof RETAINED_CAPABILITY_TOOL_NAMES[number], readonly ModelToolActionKind[]>;

const retainedCapabilityToolContracts: readonly ModelToolContract[] = RETAINED_CAPABILITY_TOOL_NAMES.map((name) => ({
  identity: { namespace: null, name },
  description: `Provider-neutral ${name} capability.`,
  scope: 'anyThread',
  schemaOwner: 'capability',
  inputSchema: null,
  actionKinds: CAPABILITY_ACTION_KINDS[name],
}));

const configurationToolContracts: readonly ModelToolContract[] = [{
  identity: { namespace: null, name: 'skill' },
  description: 'Invoke a configuration-selected Skill by canonical identity.',
  scope: 'anyThread',
  schemaOwner: 'configuration',
  inputSchema: null,
  actionKinds: ['agent.skill.invoke'],
}];

export const MODEL_TOOL_CATALOG: readonly ModelToolContract[] = Object.freeze([
  ...collaborationToolContracts,
  ...coreControlToolContracts,
  ...retainedCapabilityToolContracts,
  ...configurationToolContracts,
]);

const CONTRACTS_BY_KEY = new Map(MODEL_TOOL_CATALOG.map((contract) => [
  canonicalModelToolKey(contract.identity),
  contract,
]));

export function canonicalModelToolKey(identity: ModelToolIdentity): string {
  validateToolName(identity.name, 'tool name');
  if (identity.namespace === null) return identity.name;
  validateToolName(identity.namespace, 'tool namespace');
  return `${identity.namespace}.${identity.name}`;
}

export function modelToolContract(identity: ModelToolIdentity | string): ModelToolContract | null {
  const key = typeof identity === 'string' ? identity : canonicalModelToolKey(identity);
  return CONTRACTS_BY_KEY.get(key) ?? null;
}

export function assembleModelToolRegistry(
  schemaContributions: readonly ModelToolSchemaContribution[],
  extensionTools: readonly ModelToolContract[] = [],
): readonly ModelToolContract[] {
  const resolved = new Map(MODEL_TOOL_CATALOG.map((contract) => [
    canonicalModelToolKey(contract.identity),
    contract,
  ]));

  for (const contribution of schemaContributions) {
    const key = canonicalModelToolKey(contribution.identity);
    const contract = resolved.get(key);
    if (!contract || contract.inputSchema !== null || contract.schemaOwner !== contribution.owner) {
      throw new Error(`Unexpected model-tool schema contribution: ${key}`);
    }
    resolved.set(key, Object.freeze({
      ...contract,
      inputSchema: contribution.inputSchema,
      outputSchema: contribution.outputSchema ?? contract.outputSchema,
    }));
  }

  const missing = [...resolved.values()]
    .filter((contract) => contract.inputSchema === null)
    .map((contract) => canonicalModelToolKey(contract.identity));
  if (missing.length > 0) throw new Error(`Missing model-tool schemas: ${missing.join(', ')}`);

  for (const contract of extensionTools) {
    const key = canonicalModelToolKey(contract.identity);
    if (contract.schemaOwner !== 'extension') {
      throw new Error(`Extension model tool must be owned by extension: ${key}`);
    }
    if (contract.identity.namespace === COLLABORATION_NAMESPACE) {
      throw new Error(`The ${COLLABORATION_NAMESPACE} namespace is reserved by Core`);
    }
    if (contract.inputSchema === null) throw new Error(`Extension model tool requires a concrete schema: ${key}`);
    if (resolved.has(key)) throw new Error(`Duplicate canonical model tool: ${key}`);
    for (const kind of contract.actionKinds) {
      if (!(MODEL_TOOL_ACTION_KINDS as readonly string[]).includes(kind)) {
        throw new Error(`Unsupported action kind for ${key}: ${kind}`);
      }
    }
    resolved.set(key, Object.freeze({ ...contract }));
  }

  const registry = [...resolved.values()];
  assertProviderToolNamesUnique(registry);
  return Object.freeze(registry);
}

export type ProviderToolNameEncoding = 'canonical' | 'flat';

export function encodeProviderToolName(
  identity: ModelToolIdentity,
  encoding: ProviderToolNameEncoding,
  registry: readonly ModelToolContract[] = MODEL_TOOL_CATALOG,
): string {
  const key = canonicalModelToolKey(identity);
  if (!registry.some((contract) => canonicalModelToolKey(contract.identity) === key)) {
    throw new Error(`Unknown canonical model tool: ${key}`);
  }
  if (encoding === 'canonical' || identity.namespace === null) return key;
  return `${identity.namespace}__${identity.name}`;
}

export function decodeProviderToolName(
  providerName: string,
  encoding: ProviderToolNameEncoding,
  registry: readonly ModelToolContract[] = MODEL_TOOL_CATALOG,
): ModelToolIdentity | null {
  const contract = registry.find((candidate) =>
    encodeProviderToolName(candidate.identity, encoding, registry) === providerName);
  return contract?.identity ?? null;
}

export function modelToolActionKinds(
  identity: ModelToolIdentity | string,
  args?: unknown,
): readonly ModelToolActionKind[] | null {
  const contract = modelToolContract(identity);
  if (!contract) return null;
  if (canonicalModelToolKey(contract.identity) !== 'outline_undo_stack') return contract.actionKinds;
  const action = isRecord(args) && typeof args.action === 'string' ? args.action.trim().toLowerCase() : 'list';
  return action === 'undo' || action === 'redo' ? ['outline.edit'] : ['outline.read'];
}

export function isReadOnlyModelToolActionKind(kind: ModelToolActionKind): boolean {
  return READ_ONLY_ACTION_KINDS.has(kind);
}

export function modelToolActionRule(kind: ModelToolActionKind): string {
  return `Action(${kind})`;
}

export function modelToolActionKindFromRule(value: string): ModelToolActionKind | null {
  const match = /^Action\(([^)]+)\)$/.exec(value.trim());
  const kind = match?.[1];
  return kind && (MODEL_TOOL_ACTION_KINDS as readonly string[]).includes(kind)
    ? kind as ModelToolActionKind
    : null;
}

export function normalizeModelToolCommandForBlockMatch(command: string): string {
  const trimmed = command.trim();
  let normalized = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let pendingSpace = false;
  for (const char of trimmed) {
    if (escaped) {
      normalized += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      if (pendingSpace && normalized) normalized += ' ';
      pendingSpace = false;
      normalized += char;
      escaped = true;
      continue;
    }
    if (quote) {
      normalized += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      if (pendingSpace && normalized) normalized += ' ';
      pendingSpace = false;
      quote = char;
      normalized += char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (normalized) pendingSpace = true;
      continue;
    }
    if (pendingSpace && normalized) normalized += ' ';
    pendingSpace = false;
    normalized += char;
  }
  return normalized;
}

export function modelToolCommandsMatch(left: string, right: string): boolean {
  return normalizeModelToolCommandForBlockMatch(left) === normalizeModelToolCommandForBlockMatch(right);
}

export function normalizeRequestUserInputToolInput(value: unknown): RequestUserInputToolInput {
  if (!isRecord(value)) throw new Error('request_user_input input must be an object');
  exactInputKeys(value, ['questions', 'autoResolutionMs'], 'request_user_input');
  const questions = decodeRequestUserInputQuestions(value.questions);

  const autoResolutionMs = value.autoResolutionMs === undefined
    ? undefined
    : Math.round(Math.min(
      REQUEST_USER_INPUT_MAX_AUTO_RESOLUTION_MS,
      Math.max(REQUEST_USER_INPUT_MIN_AUTO_RESOLUTION_MS, finiteNumber(value.autoResolutionMs, 'autoResolutionMs')),
    ));
  return Object.freeze({
    questions: Object.freeze(questions),
    ...(autoResolutionMs === undefined ? {} : { autoResolutionMs }),
  });
}

export function normalizeUpdatePlanToolInput(value: unknown): UpdatePlanToolInput {
  if (!isRecord(value)) throw new Error('update_plan input must be an object');
  exactInputKeys(value, ['explanation', 'plan'], 'update_plan');
  if (!Array.isArray(value.plan)) throw new Error('update_plan.plan must be an array');
  let inProgress = 0;
  const plan = value.plan.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`update_plan.plan[${index}] must be an object`);
    exactInputKeys(entry, ['step', 'status'], `update_plan.plan[${index}]`);
    const status = entry.status;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
      throw new Error(`update_plan.plan[${index}].status is invalid`);
    }
    if (status === 'in_progress') inProgress += 1;
    return Object.freeze({ step: requiredString(entry.step, `update_plan.plan[${index}].step`), status });
  });
  if (inProgress > 1) throw new Error('update_plan allows at most one in_progress step');
  return Object.freeze({
    ...(value.explanation === undefined
      ? {}
      : { explanation: requiredString(value.explanation, 'update_plan.explanation') }),
    plan: Object.freeze(plan),
  });
}

function validateToolName(value: string, field: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`${field} must be lowercase snake_case`);
  if (value.includes('__')) throw new Error(`${field} must not contain the reserved flat-provider separator "__"`);
}

function assertProviderToolNamesUnique(registry: readonly ModelToolContract[]): void {
  const seen = new Map<string, string>();
  for (const contract of registry) {
    const canonical = canonicalModelToolKey(contract.identity);
    const flat = contract.identity.namespace === null
      ? contract.identity.name
      : `${contract.identity.namespace}__${contract.identity.name}`;
    const existing = seen.get(flat);
    if (existing) throw new Error(`Duplicate flat provider model tool: ${flat} (${existing}, ${canonical})`);
    seen.set(flat, canonical);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactInputKeys(record: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${path} contains unknown fields: ${unknown.join(', ')}`);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
  return value;
}
