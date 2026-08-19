import { REASONING_EFFORTS, type ReasoningEffort } from './configuration';
import type { ThreadId, TurnId } from './protocol';

export const AUTOMATION_DESTINATIONS = ['standalone', 'existingThread'] as const;
export type AutomationDestinationKind = typeof AUTOMATION_DESTINATIONS[number];

export const AUTOMATION_STATUSES = ['active', 'paused', 'completed'] as const;
export type AutomationStatus = typeof AUTOMATION_STATUSES[number];

export const AUTOMATION_EXECUTION_MODES = ['local', 'worktree'] as const;
export type AutomationExecutionMode = typeof AUTOMATION_EXECUTION_MODES[number];

export const AUTOMATION_RUN_STATES = ['pending', 'dispatched', 'failed', 'omitted'] as const;
export type AutomationRunState = typeof AUTOMATION_RUN_STATES[number];

export const AUTOMATION_NO_PROJECT_BINDING_KEY = 'no-project';
export const AUTOMATION_NAME_MAX_LENGTH = 200;
export const AUTOMATION_PROMPT_MAX_LENGTH = 120_000;
export const AUTOMATION_RRULE_MAX_LENGTH = 4_096;
export const AUTOMATION_TIMEZONE_MAX_LENGTH = 128;
export const AUTOMATION_IDENTIFIER_MAX_LENGTH = 256;
export const AUTOMATION_PATH_MAX_LENGTH = 4_096;
export const AUTOMATION_PROJECT_BINDINGS_MAX_COUNT = 32;
export const AUTOMATION_ERROR_MAX_LENGTH = 32_768;

export interface AutomationSchedule {
  readonly rrule: string;
  readonly timezone: string;
}

export type AutomationDestination =
  | { readonly kind: 'standalone' }
  | { readonly kind: 'existingThread'; readonly threadId: ThreadId };

export interface AutomationProjectBinding {
  readonly id: string;
  readonly cwd: string;
  readonly executionMode: AutomationExecutionMode;
}

export interface AutomationConfiguration {
  readonly modelProvider: string | null;
  readonly model: string | null;
  readonly reasoningEffort: ReasoningEffort | null;
}

export interface Automation {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly schedule: AutomationSchedule;
  readonly destination: AutomationDestination;
  readonly projectBindings: readonly AutomationProjectBinding[];
  readonly configuration: AutomationConfiguration;
  readonly status: AutomationStatus;
  readonly revision: number;
  readonly nextOccurrenceAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AutomationRunConfigurationSnapshot {
  readonly automationName: string;
  readonly prompt: string;
  readonly schedule: AutomationSchedule;
  readonly destination: AutomationDestination;
  readonly projectBinding: AutomationProjectBinding | null;
  readonly configuration: AutomationConfiguration;
}

export interface AutomationRunOmission {
  readonly from: number;
  readonly through: number;
  readonly count: number;
  readonly reason: 'catchUp' | 'overlap' | 'paused' | 'deleted';
}

export interface AutomationWorktreeMetadata {
  readonly sourceCwd: string;
  readonly path: string;
  readonly baseCommit: string;
  readonly snapshotPath: string | null;
  readonly removedAt: number | null;
  readonly managed: true;
}

export interface AutomationRun {
  readonly id: string;
  readonly automationId: string;
  readonly automationRevision: number;
  readonly eventSequence: number;
  readonly scheduledFor: number;
  readonly projectBindingKey: string;
  readonly snapshot: AutomationRunConfigurationSnapshot;
  readonly state: AutomationRunState;
  readonly threadId: ThreadId | null;
  readonly turnId: TurnId | null;
  readonly worktree: AutomationWorktreeMetadata | null;
  readonly omission: AutomationRunOmission | null;
  readonly error: string | null;
  readonly readAt: number | null;
  readonly pinned: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AutomationCreateInput {
  readonly name: string;
  readonly prompt: string;
  readonly schedule: AutomationSchedule;
  readonly destination: AutomationDestination;
  readonly projectBindings?: readonly AutomationProjectBinding[];
  readonly configuration?: Partial<AutomationConfiguration>;
  readonly status?: Extract<AutomationStatus, 'active' | 'paused'>;
}

export interface AutomationUpdateInput {
  readonly id: string;
  readonly expectedRevision: number;
  readonly name?: string;
  readonly prompt?: string;
  readonly schedule?: AutomationSchedule;
  readonly destination?: AutomationDestination;
  readonly projectBindings?: readonly AutomationProjectBinding[];
  readonly configuration?: Partial<AutomationConfiguration>;
  readonly status?: Extract<AutomationStatus, 'active' | 'paused'>;
}

export interface AutomationListInput {
  readonly statuses?: readonly AutomationStatus[];
  readonly includeDeleted?: boolean;
}

export interface AutomationRunListInput {
  readonly automationId?: string;
  readonly unreadOnly?: boolean;
  readonly limit?: number;
}

export type AutomationNotification =
  | { readonly type: 'automation/changed'; readonly automation: Automation | null; readonly automationId: string }
  | { readonly type: 'automationRun/changed'; readonly run: AutomationRun }
  | {
      readonly type: 'automationRuns/markedRead';
      readonly automationId: string;
      readonly eventSequence: number;
      readonly readAt: number;
    };

export const AUTOMATION_REQUEST_CHANNEL = 'lin:automation:request';
export const AUTOMATION_NOTIFICATION_CHANNEL = 'lin:automation:notification';

export interface AutomationRequestByMethod {
  readonly list: AutomationListInput;
  readonly read: { readonly id: string };
  readonly create: AutomationCreateInput;
  readonly update: AutomationUpdateInput;
  readonly pause: { readonly id: string; readonly expectedRevision?: number };
  readonly resume: { readonly id: string; readonly expectedRevision?: number };
  readonly delete: { readonly id: string; readonly expectedRevision?: number };
  readonly startNow: { readonly id: string };
  readonly runs: AutomationRunListInput;
  readonly runRead: { readonly id: string };
  readonly runMarkRead: { readonly id: string };
  readonly runsMarkRead: { readonly automationId: string };
  readonly runPin: { readonly id: string; readonly pinned: boolean };
}

export type AutomationResponseByMethod = {
  readonly list: { readonly data: readonly Automation[] };
  readonly read: { readonly automation: Automation | null };
  readonly create: { readonly automation: Automation };
  readonly update: { readonly automation: Automation };
  readonly pause: { readonly automation: Automation };
  readonly resume: { readonly automation: Automation };
  readonly delete: { readonly deleted: true; readonly id: string };
  readonly startNow: { readonly runs: readonly AutomationRun[] };
  readonly runs: { readonly data: readonly AutomationRun[] };
  readonly runRead: { readonly run: AutomationRun | null };
  readonly runMarkRead: { readonly run: AutomationRun };
  readonly runsMarkRead: {
    readonly automationId: string;
    readonly eventSequence: number;
    readonly readAt: number;
    readonly updatedCount: number;
  };
  readonly runPin: { readonly run: AutomationRun };
};

export type AutomationMethod = keyof AutomationResponseByMethod;
export const AUTOMATION_METHODS = [
  'list', 'read', 'create', 'update', 'pause', 'resume', 'delete',
  'startNow', 'runs', 'runRead', 'runMarkRead', 'runsMarkRead', 'runPin',
] as const satisfies readonly AutomationMethod[];

export function decodeAutomationRequest<Method extends AutomationMethod>(
  method: Method,
  value: unknown,
): AutomationRequestByMethod[Method] {
  switch (method) {
    case 'list':
      return decodeAutomationListInput(value) as AutomationRequestByMethod[Method];
    case 'create':
      return decodeAutomationCreateInput(value) as AutomationRequestByMethod[Method];
    case 'update':
      return decodeAutomationUpdateInput(value) as AutomationRequestByMethod[Method];
    case 'runs':
      return decodeAutomationRunListInput(value) as AutomationRequestByMethod[Method];
    case 'read':
    case 'startNow':
    case 'runRead':
    case 'runMarkRead':
      return decodeIdRequest(value, `automation ${method}`) as AutomationRequestByMethod[Method];
    case 'runsMarkRead': {
      const record = objectValue(value, 'automation runsMarkRead');
      exactKeys(record, ['automationId'], 'automation runsMarkRead');
      return Object.freeze({
        automationId: uuid(record.automationId, 'automation runsMarkRead.automationId'),
      }) as AutomationRequestByMethod[Method];
    }
    case 'pause':
    case 'resume':
    case 'delete':
      return decodeRevisionedIdRequest(value, `automation ${method}`) as AutomationRequestByMethod[Method];
    case 'runPin': {
      const record = objectValue(value, 'automation runPin');
      exactKeys(record, ['id', 'pinned'], 'automation runPin');
      return Object.freeze({
        id: uuid(record.id, 'automation runPin.id'),
        pinned: booleanValue(record.pinned, 'automation runPin.pinned'),
      }) as AutomationRequestByMethod[Method];
    }
  }
}

export function decodeAutomationResponse<Method extends AutomationMethod>(
  method: Method,
  value: unknown,
): AutomationResponseByMethod[Method] {
  const path = `automation response ${method}`;
  const record = objectValue(value, path);
  switch (method) {
    case 'list':
      exactKeys(record, ['data'], path);
      return Object.freeze({ data: decodeArray(record.data, `${path}.data`, decodeAutomation) }) as AutomationResponseByMethod[Method];
    case 'read':
      exactKeys(record, ['automation'], path);
      return Object.freeze({
        automation: record.automation === null ? null : decodeAutomation(record.automation, `${path}.automation`),
      }) as AutomationResponseByMethod[Method];
    case 'create':
    case 'update':
    case 'pause':
    case 'resume':
      exactKeys(record, ['automation'], path);
      return Object.freeze({
        automation: decodeAutomation(record.automation, `${path}.automation`),
      }) as AutomationResponseByMethod[Method];
    case 'delete':
      exactKeys(record, ['deleted', 'id'], path);
      if (record.deleted !== true) throw new Error(`${path}.deleted must be true`);
      return Object.freeze({
        deleted: true,
        id: uuid(record.id, `${path}.id`),
      }) as AutomationResponseByMethod[Method];
    case 'startNow':
      exactKeys(record, ['runs'], path);
      return Object.freeze({
        runs: decodeArray(record.runs, `${path}.runs`, decodeAutomationRun),
      }) as AutomationResponseByMethod[Method];
    case 'runs':
      exactKeys(record, ['data'], path);
      return Object.freeze({
        data: decodeArray(record.data, `${path}.data`, decodeAutomationRun),
      }) as AutomationResponseByMethod[Method];
    case 'runRead':
      exactKeys(record, ['run'], path);
      return Object.freeze({
        run: record.run === null ? null : decodeAutomationRun(record.run, `${path}.run`),
      }) as AutomationResponseByMethod[Method];
    case 'runMarkRead':
    case 'runPin':
      exactKeys(record, ['run'], path);
      return Object.freeze({
        run: decodeAutomationRun(record.run, `${path}.run`),
      }) as AutomationResponseByMethod[Method];
    case 'runsMarkRead':
      exactKeys(record, ['automationId', 'eventSequence', 'readAt', 'updatedCount'], path);
      return Object.freeze({
        automationId: uuid(record.automationId, `${path}.automationId`),
        eventSequence: positiveInteger(record.eventSequence, `${path}.eventSequence`),
        readAt: timestamp(record.readAt, `${path}.readAt`),
        updatedCount: nonNegativeInteger(record.updatedCount, `${path}.updatedCount`),
      }) as AutomationResponseByMethod[Method];
  }
}

export function decodeAutomationNotification(value: unknown): AutomationNotification {
  const path = 'automation notification';
  const record = objectValue(value, path);
  if (record.type === 'automation/changed') {
    exactKeys(record, ['type', 'automation', 'automationId'], path);
    const automationId = uuid(record.automationId, `${path}.automationId`);
    const automation = record.automation === null
      ? null
      : decodeAutomation(record.automation, `${path}.automation`);
    if (automation && automation.id !== automationId) {
      throw new Error(`${path} Automation identity mismatch`);
    }
    return Object.freeze({ type: record.type, automation, automationId });
  }
  if (record.type === 'automationRun/changed') {
    exactKeys(record, ['type', 'run'], path);
    return Object.freeze({
      type: record.type,
      run: decodeAutomationRun(record.run, `${path}.run`),
    });
  }
  if (record.type === 'automationRuns/markedRead') {
    exactKeys(record, ['type', 'automationId', 'eventSequence', 'readAt'], path);
    return Object.freeze({
      type: record.type,
      automationId: uuid(record.automationId, `${path}.automationId`),
      eventSequence: positiveInteger(record.eventSequence, `${path}.eventSequence`),
      readAt: timestamp(record.readAt, `${path}.readAt`),
    });
  }
  throw new Error(`${path}.type is invalid`);
}

export function decodeAutomation(value: unknown, path = 'automation'): Automation {
  const record = objectValue(value, path);
  exactKeys(record, [
    'id', 'name', 'prompt', 'schedule', 'destination', 'projectBindings', 'configuration',
    'status', 'revision', 'nextOccurrenceAt', 'createdAt', 'updatedAt',
  ], path);
  const destination = decodeAutomationDestination(record.destination, `${path}.destination`);
  const projectBindings = decodeProjectBindings(record.projectBindings, `${path}.projectBindings`);
  assertDestinationBindings(destination, projectBindings, path);
  const createdAt = timestamp(record.createdAt, `${path}.createdAt`);
  const updatedAt = timestamp(record.updatedAt, `${path}.updatedAt`);
  return Object.freeze({
    id: uuid(record.id, `${path}.id`),
    name: boundedString(record.name, `${path}.name`, AUTOMATION_NAME_MAX_LENGTH),
    prompt: boundedString(record.prompt, `${path}.prompt`, AUTOMATION_PROMPT_MAX_LENGTH),
    schedule: decodeAutomationSchedule(record.schedule, `${path}.schedule`),
    destination,
    projectBindings,
    configuration: decodeAutomationConfiguration(record.configuration, `${path}.configuration`),
    status: enumValue(record.status, AUTOMATION_STATUSES, `${path}.status`),
    revision: positiveInteger(record.revision, `${path}.revision`),
    nextOccurrenceAt: nullableTimestamp(record.nextOccurrenceAt, `${path}.nextOccurrenceAt`),
    createdAt,
    updatedAt,
  });
}

export function decodeAutomationRun(value: unknown, path = 'automationRun'): AutomationRun {
  const record = objectValue(value, path);
  exactKeys(record, [
    'id', 'automationId', 'automationRevision', 'eventSequence', 'scheduledFor', 'projectBindingKey',
    'snapshot', 'state', 'threadId', 'turnId', 'worktree', 'omission', 'error',
    'readAt', 'pinned', 'createdAt', 'updatedAt',
  ], path);
  const state = enumValue(record.state, AUTOMATION_RUN_STATES, `${path}.state`);
  const threadId = nullableUuid(record.threadId, `${path}.threadId`);
  const turnId = nullableUuid(record.turnId, `${path}.turnId`);
  const worktree = record.worktree === null ? null : decodeWorktree(record.worktree, `${path}.worktree`);
  const omission = record.omission === null ? null : decodeOmission(record.omission, `${path}.omission`);
  const error = nullableBoundedString(record.error, `${path}.error`, AUTOMATION_ERROR_MAX_LENGTH);
  const snapshot = decodeRunSnapshot(record.snapshot, `${path}.snapshot`);
  const projectBindingKey = boundedString(
    record.projectBindingKey,
    `${path}.projectBindingKey`,
    AUTOMATION_IDENTIFIER_MAX_LENGTH,
  );
  const expectedBindingKey = snapshot.projectBinding?.id ?? AUTOMATION_NO_PROJECT_BINDING_KEY;
  if (projectBindingKey !== expectedBindingKey) {
    throw new Error(`${path}.projectBindingKey does not match its snapshot`);
  }
  if (worktree && snapshot.projectBinding?.executionMode !== 'worktree') {
    throw new Error(`${path}.worktree requires a worktree project binding`);
  }
  const pinned = booleanValue(record.pinned, `${path}.pinned`);
  if (pinned && (!worktree || worktree.removedAt !== null)) {
    throw new Error(`${path}.pinned requires a retained worktree`);
  }
  if (state === 'dispatched' && (!threadId || !turnId || omission || error)) {
    throw new Error(`${path} dispatched state is inconsistent`);
  }
  if (state === 'omitted' && (threadId || turnId || !omission || error)) {
    throw new Error(`${path} omitted state is inconsistent`);
  }
  if (state === 'failed' && (threadId || turnId || omission || !error)) {
    throw new Error(`${path} failed state is inconsistent`);
  }
  if (state === 'pending' && (!threadId || turnId || omission)) {
    throw new Error(`${path} pending state is inconsistent`);
  }
  if (
    (state === 'pending' || state === 'dispatched')
    && snapshot.destination.kind === 'existingThread'
    && threadId !== snapshot.destination.threadId
  ) {
    throw new Error(`${path}.threadId does not match its existing-Thread destination`);
  }
  const createdAt = timestamp(record.createdAt, `${path}.createdAt`);
  const updatedAt = timestamp(record.updatedAt, `${path}.updatedAt`);
  const readAt = nullableTimestamp(record.readAt, `${path}.readAt`);
  return Object.freeze({
    id: uuid(record.id, `${path}.id`),
    automationId: uuid(record.automationId, `${path}.automationId`),
    automationRevision: positiveInteger(record.automationRevision, `${path}.automationRevision`),
    eventSequence: positiveInteger(record.eventSequence, `${path}.eventSequence`),
    scheduledFor: timestamp(record.scheduledFor, `${path}.scheduledFor`),
    projectBindingKey,
    snapshot,
    state,
    threadId,
    turnId,
    worktree,
    omission,
    error,
    readAt,
    pinned,
    createdAt,
    updatedAt,
  });
}

export const EMPTY_AUTOMATION_CONFIGURATION: AutomationConfiguration = Object.freeze({
  modelProvider: null,
  model: null,
  reasoningEffort: null,
});

export function decodeAutomationCreateInput(value: unknown): AutomationCreateInput {
  const record = objectValue(value, 'automation create');
  exactKeys(record, [
    'name', 'prompt', 'schedule', 'destination', 'projectBindings', 'configuration', 'status',
  ], 'automation create');
  const status = record.status === undefined
    ? undefined
    : enumValue(record.status, ['active', 'paused'] as const, 'automation create.status');
  const destination = decodeAutomationDestination(record.destination, 'automation create.destination');
  const projectBindings = record.projectBindings === undefined
    ? undefined
    : decodeProjectBindings(record.projectBindings, 'automation create.projectBindings');
  assertDestinationBindings(destination, projectBindings ?? [], 'automation create');
  return Object.freeze({
    name: boundedString(record.name, 'automation create.name', AUTOMATION_NAME_MAX_LENGTH),
    prompt: boundedString(record.prompt, 'automation create.prompt', AUTOMATION_PROMPT_MAX_LENGTH),
    schedule: decodeAutomationSchedule(record.schedule, 'automation create.schedule'),
    destination,
    ...(projectBindings === undefined ? {} : { projectBindings }),
    ...(record.configuration === undefined
      ? {}
      : { configuration: decodeConfigurationPatch(record.configuration, 'automation create.configuration') }),
    ...(status === undefined ? {} : { status }),
  });
}

export function decodeAutomationUpdateInput(value: unknown): AutomationUpdateInput {
  const record = objectValue(value, 'automation update');
  exactKeys(record, [
    'id', 'expectedRevision', 'name', 'prompt', 'schedule', 'destination', 'projectBindings', 'configuration', 'status',
  ], 'automation update');
  const result: AutomationUpdateInput = {
    id: uuid(record.id, 'automation update.id'),
    expectedRevision: positiveInteger(record.expectedRevision, 'automation update.expectedRevision'),
    ...(record.name === undefined
      ? {}
      : { name: boundedString(record.name, 'automation update.name', AUTOMATION_NAME_MAX_LENGTH) }),
    ...(record.prompt === undefined
      ? {}
      : { prompt: boundedString(record.prompt, 'automation update.prompt', AUTOMATION_PROMPT_MAX_LENGTH) }),
    ...(record.schedule === undefined
      ? {}
      : { schedule: decodeAutomationSchedule(record.schedule, 'automation update.schedule') }),
    ...(record.destination === undefined
      ? {}
      : { destination: decodeAutomationDestination(record.destination, 'automation update.destination') }),
    ...(record.projectBindings === undefined
      ? {}
      : { projectBindings: decodeProjectBindings(record.projectBindings, 'automation update.projectBindings') }),
    ...(record.configuration === undefined
      ? {}
      : { configuration: decodeConfigurationPatch(record.configuration, 'automation update.configuration') }),
    ...(record.status === undefined
      ? {}
      : { status: enumValue(record.status, ['active', 'paused'] as const, 'automation update.status') }),
  };
  if (Object.keys(result).length === 2) throw new Error('automation update must change at least one field');
  return Object.freeze(result);
}

/**
 * Model-facing `automation_update` input. The provider schema states the same
 * per-mode field sets, but a Turn's arguments are model output: the write
 * boundary decodes them here, beside the decoders the renderer path uses, so
 * one rejection message and one set of bounds serve both callers.
 */
export type AutomationToolCommand =
  | { readonly mode: 'create'; readonly create: AutomationCreateInput }
  | { readonly mode: 'update'; readonly update: AutomationUpdateInput }
  | { readonly mode: 'view'; readonly id: string | null }
  | { readonly mode: 'delete'; readonly id: string; readonly expectedRevision: number };

const AUTOMATION_PATCH_FIELDS = [
  'name', 'prompt', 'schedule', 'destination', 'projectBindings', 'configuration', 'status',
] as const;

export function decodeAutomationToolInput(value: unknown): AutomationToolCommand {
  const path = 'automation_update';
  const record = objectValue(value, path);
  const mode = enumValue(record.mode, ['create', 'update', 'view', 'delete'] as const, `${path}.mode`);
  switch (mode) {
    case 'create':
      exactKeys(record, ['mode', 'definition'], path);
      return Object.freeze({ mode, create: decodeAutomationCreateInput(record.definition) });
    case 'update': {
      exactKeys(record, ['mode', 'automation_id', 'expected_revision', 'patch'], path);
      // A patch carries changes, never identity: it may not name the Automation
      // it addresses or the revision it is checked against, and the addressed id
      // is applied after it, so neither layer can be talked into updating one
      // Automation under another's optimistic-concurrency check.
      const patch = objectValue(record.patch, `${path}.patch`);
      exactKeys(patch, AUTOMATION_PATCH_FIELDS, `${path}.patch`);
      return Object.freeze({
        mode,
        update: decodeAutomationUpdateInput({
          ...patch,
          id: uuid(record.automation_id, `${path}.automation_id`),
          expectedRevision: positiveInteger(record.expected_revision, `${path}.expected_revision`),
        }),
      });
    }
    case 'view':
      exactKeys(record, ['mode', 'automation_id'], path);
      return Object.freeze({
        mode,
        id: record.automation_id === undefined ? null : uuid(record.automation_id, `${path}.automation_id`),
      });
    case 'delete':
      exactKeys(record, ['mode', 'automation_id', 'expected_revision'], path);
      return Object.freeze({
        mode,
        id: uuid(record.automation_id, `${path}.automation_id`),
        expectedRevision: positiveInteger(record.expected_revision, `${path}.expected_revision`),
      });
  }
}

export function decodeAutomationSchedule(value: unknown, path = 'schedule'): AutomationSchedule {
  const record = objectValue(value, path);
  exactKeys(record, ['rrule', 'timezone'], path);
  return Object.freeze({
    rrule: boundedString(record.rrule, `${path}.rrule`, AUTOMATION_RRULE_MAX_LENGTH).replace(/\r\n/g, '\n'),
    timezone: boundedString(record.timezone, `${path}.timezone`, AUTOMATION_TIMEZONE_MAX_LENGTH),
  });
}

export function decodeAutomationDestination(value: unknown, path = 'destination'): AutomationDestination {
  const record = objectValue(value, path);
  const kind = enumValue(record.kind, AUTOMATION_DESTINATIONS, `${path}.kind`);
  if (kind === 'standalone') {
    exactKeys(record, ['kind'], path);
    return Object.freeze({ kind });
  }
  exactKeys(record, ['kind', 'threadId'], path);
  return Object.freeze({ kind, threadId: uuid(record.threadId, `${path}.threadId`) });
}

export function decodeAutomationConfiguration(value: unknown, path = 'configuration'): AutomationConfiguration {
  return Object.freeze({ ...EMPTY_AUTOMATION_CONFIGURATION, ...decodeConfigurationPatch(value, path) });
}

export function decodeAutomationListInput(value: unknown): AutomationListInput {
  if (value === undefined) return Object.freeze({});
  const record = objectValue(value, 'automation list');
  exactKeys(record, ['statuses', 'includeDeleted'], 'automation list');
  return Object.freeze({
    ...(record.statuses === undefined
      ? {}
      : { statuses: uniqueEnumArray(record.statuses, AUTOMATION_STATUSES, 'automation list.statuses') }),
    ...(record.includeDeleted === undefined
      ? {}
      : { includeDeleted: booleanValue(record.includeDeleted, 'automation list.includeDeleted') }),
  });
}

export function decodeAutomationRunListInput(value: unknown): AutomationRunListInput {
  if (value === undefined) return Object.freeze({});
  const record = objectValue(value, 'automation run list');
  exactKeys(record, ['automationId', 'unreadOnly', 'limit'], 'automation run list');
  return Object.freeze({
    ...(record.automationId === undefined
      ? {}
      : { automationId: uuid(record.automationId, 'automation run list.automationId') }),
    ...(record.unreadOnly === undefined
      ? {}
      : { unreadOnly: booleanValue(record.unreadOnly, 'automation run list.unreadOnly') }),
    ...(record.limit === undefined
      ? {}
      : { limit: boundedInteger(record.limit, 1, 500, 'automation run list.limit') }),
  });
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function decodeProjectBindings(value: unknown, path: string): readonly AutomationProjectBinding[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  if (value.length > AUTOMATION_PROJECT_BINDINGS_MAX_COUNT) {
    throw new Error(`${path} must contain at most ${AUTOMATION_PROJECT_BINDINGS_MAX_COUNT} entries`);
  }
  const bindings = value.map((entry, index): AutomationProjectBinding => {
    const itemPath = `${path}[${index}]`;
    const record = objectValue(entry, itemPath);
    exactKeys(record, ['id', 'cwd', 'executionMode'], itemPath);
    return Object.freeze({
      id: boundedString(record.id, `${itemPath}.id`, AUTOMATION_IDENTIFIER_MAX_LENGTH),
      cwd: absolutePath(record.cwd, `${itemPath}.cwd`),
      executionMode: enumValue(record.executionMode, AUTOMATION_EXECUTION_MODES, `${itemPath}.executionMode`),
    });
  });
  if (new Set(bindings.map((binding) => binding.id)).size !== bindings.length) {
    throw new Error(`${path} contains duplicate binding IDs`);
  }
  if (bindings.some((binding) => binding.id === AUTOMATION_NO_PROJECT_BINDING_KEY)) {
    throw new Error(`${path} uses the reserved binding ID ${AUTOMATION_NO_PROJECT_BINDING_KEY}`);
  }
  return Object.freeze(bindings);
}

function decodeRunSnapshot(value: unknown, path: string): AutomationRunConfigurationSnapshot {
  const record = objectValue(value, path);
  exactKeys(record, [
    'automationName', 'prompt', 'schedule', 'destination', 'projectBinding', 'configuration',
  ], path);
  const destination = decodeAutomationDestination(record.destination, `${path}.destination`);
  const projectBinding = record.projectBinding === null
    ? null
    : decodeProjectBindings([record.projectBinding], `${path}.projectBinding`)[0]!;
  assertDestinationBindings(destination, projectBinding ? [projectBinding] : [], path);
  return Object.freeze({
    automationName: boundedString(record.automationName, `${path}.automationName`, AUTOMATION_NAME_MAX_LENGTH),
    prompt: boundedString(record.prompt, `${path}.prompt`, AUTOMATION_PROMPT_MAX_LENGTH),
    schedule: decodeAutomationSchedule(record.schedule, `${path}.schedule`),
    destination,
    projectBinding,
    configuration: decodeAutomationConfiguration(record.configuration, `${path}.configuration`),
  });
}

function decodeWorktree(value: unknown, path: string): AutomationWorktreeMetadata {
  const record = objectValue(value, path);
  exactKeys(record, ['sourceCwd', 'path', 'baseCommit', 'snapshotPath', 'removedAt', 'managed'], path);
  if (record.managed !== true) throw new Error(`${path}.managed must be true`);
  const baseCommit = boundedString(record.baseCommit, `${path}.baseCommit`, AUTOMATION_IDENTIFIER_MAX_LENGTH);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(baseCommit)) {
    throw new Error(`${path}.baseCommit must be a Git object ID`);
  }
  const snapshotPath = record.snapshotPath === null ? null : absolutePath(record.snapshotPath, `${path}.snapshotPath`);
  const removedAt = nullableTimestamp(record.removedAt, `${path}.removedAt`);
  if (removedAt !== null && snapshotPath === null) {
    throw new Error(`${path}.removedAt requires a durable snapshot`);
  }
  return Object.freeze({
    sourceCwd: absolutePath(record.sourceCwd, `${path}.sourceCwd`),
    path: absolutePath(record.path, `${path}.path`),
    baseCommit,
    snapshotPath,
    removedAt,
    managed: true,
  });
}

function decodeOmission(value: unknown, path: string): AutomationRunOmission {
  const record = objectValue(value, path);
  exactKeys(record, ['from', 'through', 'count', 'reason'], path);
  const from = timestamp(record.from, `${path}.from`);
  const through = timestamp(record.through, `${path}.through`);
  if (through < from) throw new Error(`${path}.through must not precede from`);
  return Object.freeze({
    from,
    through,
    count: positiveInteger(record.count, `${path}.count`),
    reason: enumValue(record.reason, ['catchUp', 'overlap', 'paused', 'deleted'] as const, `${path}.reason`),
  });
}

function decodeArray<T>(
  value: unknown,
  path: string,
  decoder: (entry: unknown, entryPath: string) => T,
): readonly T[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return Object.freeze(value.map((entry, index) => decoder(entry, `${path}[${index}]`)));
}

function decodeIdRequest(value: unknown, path: string): { readonly id: string } {
  const record = objectValue(value, path);
  exactKeys(record, ['id'], path);
  return Object.freeze({ id: uuid(record.id, `${path}.id`) });
}

function decodeRevisionedIdRequest(
  value: unknown,
  path: string,
): { readonly id: string; readonly expectedRevision?: number } {
  const record = objectValue(value, path);
  exactKeys(record, ['id', 'expectedRevision'], path);
  return Object.freeze({
    id: uuid(record.id, `${path}.id`),
    ...(record.expectedRevision === undefined
      ? {}
      : { expectedRevision: positiveInteger(record.expectedRevision, `${path}.expectedRevision`) }),
  });
}

function decodeConfigurationPatch(value: unknown, path: string): Partial<AutomationConfiguration> {
  const record = objectValue(value, path);
  exactKeys(record, ['modelProvider', 'model', 'reasoningEffort'], path);
  return Object.freeze({
    ...nullableStringProperty(record, 'modelProvider', path),
    ...nullableStringProperty(record, 'model', path),
    ...(record.reasoningEffort === undefined
      ? {}
      : {
          reasoningEffort: record.reasoningEffort === null
            ? null
            : enumValue(record.reasoningEffort, REASONING_EFFORTS, `${path}.reasoningEffort`),
        }),
  });
}

function nullableStringProperty<K extends keyof AutomationConfiguration>(
  record: Record<string, unknown>,
  key: K,
  path: string,
): Partial<Record<K, string | null>> {
  if (record[key] === undefined) return {};
  return {
    [key]: record[key] === null
      ? null
      : boundedString(record[key], `${path}.${key}`, AUTOMATION_IDENTIFIER_MAX_LENGTH),
  } as Partial<Record<K, string | null>>;
}

function uniqueEnumArray<T extends string>(value: unknown, allowed: readonly T[], path: string): readonly T[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  const result = value.map((entry, index) => enumValue(entry, allowed, `${path}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${path} must not contain duplicates`);
  return Object.freeze(result);
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const keys = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !keys.has(key));
  if (unknown.length > 0) throw new Error(`${path} contains unknown fields: ${unknown.join(', ')}`);
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value.trim();
}

function boundedString(value: unknown, path: string, maximum: number): string {
  const result = nonEmptyString(value, path);
  if (result.length > maximum) throw new Error(`${path} must be at most ${maximum} characters`);
  return result;
}

function absolutePath(value: unknown, path: string): string {
  const result = boundedString(value, path, AUTOMATION_PATH_MAX_LENGTH);
  if (!result.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(result) && !/^\\\\/.test(result)) {
    throw new Error(`${path} must be an absolute path`);
  }
  return result;
}

function assertDestinationBindings(
  destination: AutomationDestination,
  bindings: readonly AutomationProjectBinding[],
  path: string,
): void {
  if (destination.kind !== 'existingThread') return;
  if (bindings.length > 1) throw new Error(`${path} existing-Thread destination accepts at most one project binding`);
  if (bindings[0]?.executionMode === 'worktree') {
    throw new Error(`${path} existing-Thread destination accepts only a local project binding`);
  }
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
  return value;
}

function nullableBoundedString(value: unknown, path: string, maximum: number): string | null {
  return value === null ? null : boundedString(value, path, maximum);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${path} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function positiveInteger(value: unknown, path: string): number {
  return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, path);
}

function nonNegativeInteger(value: unknown, path: string): number {
  return boundedInteger(value, 0, Number.MAX_SAFE_INTEGER, path);
}

function boundedInteger(value: unknown, minimum: number, maximum: number, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${path} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function timestamp(value: unknown, path: string): number {
  return boundedInteger(value, 0, Number.MAX_SAFE_INTEGER, path);
}

function nullableTimestamp(value: unknown, path: string): number | null {
  return value === null ? null : timestamp(value, path);
}

function uuid(value: unknown, path: string): string {
  const result = nonEmptyString(value, path);
  if (!isUuid(result)) throw new Error(`${path} must be a UUIDv7`);
  return result;
}

function nullableUuid(value: unknown, path: string): string | null {
  return value === null ? null : uuid(value, path);
}
