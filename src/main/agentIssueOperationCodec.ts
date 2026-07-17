import {
  AGENT_ISSUE_OPERATION_VERSION,
  AGENT_ISSUE_RUN_PROFILES,
  type AgentIssueOperationBatch,
} from '../core/agentIssue';

type Check = (value: unknown) => boolean;

interface OptionalField {
  optional: true;
  check: Check;
}

type Field = Check | OptionalField;

const stringValue: Check = (value) => typeof value === 'string';
const nonEmptyString: Check = (value) => typeof value === 'string' && value.length > 0;
const finiteNumber: Check = (value) => typeof value === 'number' && Number.isFinite(value);
const positiveSafeInteger: Check = (value) => (
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
);
const nonNegativeSafeInteger: Check = (value) => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
);
const booleanValue: Check = (value) => typeof value === 'boolean';
const clockTime: Check = (value) => (
  typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
);

const actorRef = union(
  object({ type: literal('system') }),
  object({ type: literal('user'), userId: nonEmptyString }),
  object({ type: literal('agent'), agentId: nonEmptyString }),
);

const agentRef = object({
  type: literal('default-agent'),
  runProfile: optional(literal(...AGENT_ISSUE_RUN_PROFILES)),
});

const issueStatus = object({
  id: optional(nonEmptyString),
  name: nonEmptyString,
  category: literal('triage', 'unstarted', 'started', 'completed', 'canceled'),
});

const issueRelation = object({
  type: literal('blocked-by', 'blocks', 'related', 'duplicate-of'),
  issueId: entityId('issue:'),
});

const issueTrigger = union(
  object({ type: literal('when-ready') }),
  object({
    type: literal('scheduled'),
    startAt: finiteNumber,
    timeZone: nonEmptyString,
  }),
);

const issueDueDate = object({
  targetAt: finiteNumber,
  timeZone: optional(nonEmptyString),
});

const issueRecurrenceContext = object({
  recurringIssueId: entityId('recurring-issue:'),
  windowStartAt: finiteNumber,
  windowEndAt: finiteNumber,
  materializedAt: finiteNumber,
  timeZone: optional(nonEmptyString),
  skippedWindowCount: optional(nonNegativeSafeInteger),
});

const evidenceRef = union(
  object({ type: literal('issue'), issueId: entityId('issue:') }),
  object({ type: literal('agent-session'), agentSessionId: entityId('agent-session:') }),
  object({ type: literal('activity'), activityId: entityId('activity:') }),
  object({ type: literal('node'), nodeId: nonEmptyString }),
  object({ type: literal('file'), path: nonEmptyString }),
  object({ type: literal('url'), url: nonEmptyString, label: optional(nonEmptyString) }),
);

const completionCriterion = object({
  id: nonEmptyString,
  text: nonEmptyString,
  state: literal('open', 'met', 'waived'),
  evidence: optional(arrayOf(evidenceRef)),
});

const verificationPolicy = object({
  mode: literal('none', 'criteria-and-evidence', 'agent-review', 'human-review'),
  verifier: optional(agentRef),
  requiredVerdict: optional(literal('pass', 'pass-or-partial')),
  requiredEvidence: optional(arrayOf(nonEmptyString)),
});

const issueConfirmation = object({
  confirmedBy: actorRef,
  confirmedAt: finiteNumber,
});

const issueInputScope = union(
  object({ type: literal('none') }),
  object({
    type: literal('selected-nodes'),
    nodeIds: nonEmptyArrayOf(nonEmptyString),
  }),
  object({
    type: literal('node-children'),
    nodeId: nonEmptyString,
    depth: optional(nonNegativeSafeInteger),
  }),
  object({
    type: literal('tag-query'),
    tag: nonEmptyString,
    includeArchived: optional(booleanValue),
  }),
  object({ type: literal('saved-query'), queryId: nonEmptyString }),
);

const issueOutputPolicy = union(
  object({ type: literal('activity-only') }),
  object({
    type: literal('daily-note'),
    datePolicy: literal('session-date', 'due-date'),
  }),
  object({ type: literal('append-to-node'), nodeId: nonEmptyString }),
  object({ type: literal('create-child-under-node'), nodeId: nonEmptyString }),
  object({ type: literal('per-input-child'), parentNodeId: nonEmptyString }),
  object({ type: literal('replace-input'), requiresConfirmation: literal(true) }),
);

const executionPolicy = object({ deadlineAt: finiteNumber });

const conversationOrigin = object({
  type: literal('conversation'),
  conversationId: nonEmptyString,
});

const issueOrigin = union(
  conversationOrigin,
  object({ type: literal('agent-session'), agentSessionId: entityId('agent-session:') }),
);

const agentIssue = object({
  id: entityId('issue:'),
  parentIssueId: optional(entityId('issue:')),
  title: nonEmptyString,
  description: optional(stringValue),
  status: issueStatus,
  delegate: optional(agentRef),
  relations: arrayOf(issueRelation),
  trigger: issueTrigger,
  dueDate: optional(issueDueDate),
  recurrence: optional(issueRecurrenceContext),
  completionCriteria: optional(arrayOf(completionCriterion)),
  verificationPolicy: optional(verificationPolicy),
  evidence: optional(arrayOf(evidenceRef)),
  noteNodeIds: optional(arrayOf(nonEmptyString)),
  input: optional(issueInputScope),
  output: optional(issueOutputPolicy),
  permissionMode: literal('attended', 'unattended'),
  executionPolicy: optional(executionPolicy),
  confirmation: issueConfirmation,
  origin: optional(issueOrigin),
  revision: nonEmptyString,
  createdAt: finiteNumber,
  updatedAt: finiteNumber,
  terminalAt: optional(finiteNumber),
  archivedAt: optional(finiteNumber),
});

const recurringIssueCadence = union(
  object({ type: literal('daily'), time: clockTime }),
  object({
    type: literal('weekly'),
    weekdays: uniqueWeekdays,
    time: clockTime,
  }),
  object({
    type: literal('monthly'),
    dayOfMonth: integerInRange(1, 31),
    time: clockTime,
  }),
);

const recurringIssueMissedPolicy = object({
  type: literal('coalesce-latest', 'skip-missed'),
});

const recurringIssueTemplate = object({
  delegate: optional(agentRef),
  relations: optional(arrayOf(issueRelation)),
  trigger: optional(issueTrigger),
  completionCriteria: optional(arrayOf(completionCriterion)),
  verificationPolicy: optional(verificationPolicy),
  input: optional(issueInputScope),
  output: optional(issueOutputPolicy),
  permissionMode: literal('attended', 'unattended'),
});

const agentRecurringIssue = object({
  id: entityId('recurring-issue:'),
  origin: optional(conversationOrigin),
  titleTemplate: nonEmptyString,
  descriptionTemplate: optional(stringValue),
  status: literal('active', 'paused', 'archived'),
  cadence: recurringIssueCadence,
  timeZone: nonEmptyString,
  missedPolicy: recurringIssueMissedPolicy,
  issueTemplate: recurringIssueTemplate,
  confirmation: issueConfirmation,
  nextMaterializationAt: optional(finiteNumber),
  skippedMaterializationAts: optional(arrayOf(finiteNumber)),
  revision: nonEmptyString,
  createdAt: finiteNumber,
  updatedAt: finiteNumber,
  archivedAt: optional(finiteNumber),
});

const agentSessionSource = union(
  object({ type: literal('delegation'), actor: actorRef }),
  object({
    type: literal('recurring-issue'),
    recurringIssueId: entityId('recurring-issue:'),
    dueAt: finiteNumber,
  }),
  object({ type: literal('runtime-action'), actor: actorRef }),
  object({
    type: literal('orchestration'),
    coordinatorAgentSessionId: entityId('agent-session:'),
  }),
  object({ type: literal('manual'), actor: actorRef }),
);

const resolvedIssueInput = object({
  scope: issueInputScope,
  resolvedAt: finiteNumber,
  nodeIds: optional(arrayOf(nonEmptyString)),
  preview: optional(stringValue),
});

const agentSession = object({
  id: entityId('agent-session:'),
  issueId: entityId('issue:'),
  delegate: agentRef,
  purpose: optional(literal('execute', 'verify')),
  state: literal('pending', 'active', 'error', 'complete', 'stale', 'canceled'),
  source: agentSessionSource,
  issueSnapshot: agentIssue,
  inputSnapshot: optional(resolvedIssueInput),
  outputSnapshot: optional(issueOutputPolicy),
  executionPolicy: optional(executionPolicy),
  continuationOfAgentSessionId: optional(entityId('agent-session:')),
  latestOutput: optional(stringValue),
  errorMessage: optional(stringValue),
  startedAt: optional(finiteNumber),
  completedAt: optional(finiteNumber),
  revision: nonEmptyString,
  createdAt: finiteNumber,
  updatedAt: finiteNumber,
});

const activityTarget = union(
  object({ type: literal('issue'), issueId: entityId('issue:') }),
  object({ type: literal('recurring-issue'), recurringIssueId: entityId('recurring-issue:') }),
  object({ type: literal('agent-session'), agentSessionId: entityId('agent-session:') }),
);

const activityContent = union(
  object({ type: literal('created') }),
  object({ type: literal('updated'), fields: optional(arrayOf(nonEmptyString)) }),
  object({ type: literal('archived') }),
  object({ type: literal('deleted') }),
  object({ type: literal('comment'), body: stringValue }),
  object({
    type: literal('field-change'),
    field: nonEmptyString,
    from: optional(jsonValue),
    to: optional(jsonValue),
  }),
  object({
    type: literal('status-change'),
    from: optional(stringValue),
    to: nonEmptyString,
  }),
  object({ type: literal('agent-progress'), body: stringValue }),
  object({ type: literal('agent-question'), body: stringValue }),
  object({
    type: literal('agent-action'),
    action: nonEmptyString,
    parameter: optional(stringValue),
    result: optional(stringValue),
  }),
  object({ type: literal('agent-response'), body: stringValue }),
  object({ type: literal('agent-error'), body: stringValue }),
  object({
    type: literal('verification-result'),
    verdict: literal('pass', 'fail', 'partial'),
    body: stringValue,
    agentSessionId: optional(entityId('agent-session:')),
  }),
  object({
    type: literal('output-link'),
    nodeId: optional(nonEmptyString),
    url: optional(nonEmptyString),
    label: nonEmptyString,
  }),
);

const activitySignal = object({
  type: nonEmptyString,
  value: optional(union(stringValue, finiteNumber, booleanValue)),
});

const relatedTargetRef = union(
  object({ type: literal('issue'), id: entityId('issue:') }),
  object({ type: literal('recurring-issue'), id: entityId('recurring-issue:') }),
  object({ type: literal('agent-session'), id: entityId('agent-session:') }),
  object({ type: literal('activity'), id: entityId('activity:') }),
);

const activity = object({
  id: entityId('activity:'),
  target: activityTarget,
  actor: actorRef,
  content: activityContent,
  signals: optional(arrayOf(activitySignal)),
  relatedTargets: optional(arrayOf(relatedTargetRef)),
  createdAt: finiteNumber,
});

const sessionExecutionBinding = object({
  engine: literal('delegation'),
  conversationId: nonEmptyString,
  executionId: nonEmptyString,
  startedAt: finiteNumber,
  updatedAt: finiteNumber,
});

const sessionStopIntent = object({
  token: nonEmptyString,
  createdAt: finiteNumber,
});

const terminalDeliveryShape = object({
  id: entityId('issue-delivery:'),
  issueId: entityId('issue:'),
  agentSessionId: optional(entityId('agent-session:')),
  origin: issueOrigin,
  state: literal('complete', 'error', 'canceled'),
  title: nonEmptyString,
  body: optional(stringValue),
  terminalAt: finiteNumber,
  status: literal('pending', 'dispatching', 'delivered'),
  dispatchOwnerId: optional(nonEmptyString),
  attemptCount: nonNegativeSafeInteger,
  lastError: optional(stringValue),
  createdAt: finiteNumber,
  updatedAt: finiteNumber,
  deliveredAt: optional(finiteNumber),
});

const terminalDelivery = refine(terminalDeliveryShape, (value) => {
  if (!isRecord(value)) return false;
  if (value.status === 'dispatching') {
    return nonEmptyString(value.dispatchOwnerId) && value.deliveredAt === undefined;
  }
  if (value.dispatchOwnerId !== undefined) return false;
  return value.status === 'delivered'
    ? finiteNumber(value.deliveredAt)
    : value.deliveredAt === undefined;
});

const issueDeletionTombstone = object({
  deletionId: nonEmptyString,
  entity: object({ type: literal('issue'), issueId: entityId('issue:') }),
  actor: actorRef,
  deletedAt: finiteNumber,
  lastKnownRevision: nonEmptyString,
});

const recurringIssueDeletionTombstone = object({
  deletionId: nonEmptyString,
  entity: object({
    type: literal('recurring-issue'),
    recurringIssueId: entityId('recurring-issue:'),
  }),
  actor: actorRef,
  deletedAt: finiteNumber,
  lastKnownRevision: nonEmptyString,
});

const agentIssueOperation = union(
  object({ type: literal('issue.upserted'), issue: agentIssue }),
  object({ type: literal('issue.deleted'), tombstone: issueDeletionTombstone }),
  object({ type: literal('recurring-issue.upserted'), recurringIssue: agentRecurringIssue }),
  object({ type: literal('recurring-issue.deleted'), tombstone: recurringIssueDeletionTombstone }),
  object({ type: literal('agent-session.upserted'), agentSession }),
  object({
    type: literal('session-execution.upserted'),
    agentSessionId: entityId('agent-session:'),
    binding: sessionExecutionBinding,
  }),
  object({
    type: literal('session-stop-intent.upserted'),
    agentSessionId: entityId('agent-session:'),
    intent: sessionStopIntent,
  }),
  object({
    type: literal('session-stop-intent.cleared'),
    agentSessionId: entityId('agent-session:'),
  }),
  object({ type: literal('terminal-delivery.upserted'), delivery: terminalDelivery }),
  object({ type: literal('activity.appended'), activity }),
);

const agentIssueOperationBatch = object({
  v: literal(AGENT_ISSUE_OPERATION_VERSION),
  seq: positiveSafeInteger,
  operationId: nonEmptyString,
  actor: actorRef,
  committedAt: finiteNumber,
  operations: nonEmptyArrayOf(agentIssueOperation),
});

export function normalizeAgentIssueOperationBatch(value: unknown): AgentIssueOperationBatch | null {
  return agentIssueOperationBatch(value) ? value as AgentIssueOperationBatch : null;
}

export function isValidIssueEvidenceRef(value: unknown): boolean {
  return evidenceRef(value);
}

export function isValidIssueCompletionCriterion(value: unknown): boolean {
  return completionCriterion(value);
}

function object(fields: Readonly<Record<string, Field>>): Check {
  const entries = Object.entries(fields);
  const allowedKeys = new Set(Object.keys(fields));
  return (value) => {
    if (!isRecord(value) || !Object.keys(value).every((key) => allowedKeys.has(key))) return false;
    return entries.every(([key, field]) => {
      const present = Object.prototype.hasOwnProperty.call(value, key);
      if (isOptionalField(field)) return !present || field.check(value[key]);
      return present && field(value[key]);
    });
  };
}

function optional(check: Check): OptionalField {
  return { optional: true, check };
}

function isOptionalField(field: Field): field is OptionalField {
  return typeof field !== 'function';
}

function union(...checks: readonly Check[]): Check {
  return (value) => checks.some((check) => check(value));
}

function refine(base: Check, refinement: Check): Check {
  return (value) => base(value) && refinement(value);
}

function literal<TValue extends string | number | boolean>(
  ...allowed: readonly TValue[]
): Check {
  return (value) => allowed.includes(value as TValue);
}

function arrayOf(item: Check): Check {
  return (value) => Array.isArray(value) && value.every(item);
}

function nonEmptyArrayOf(item: Check): Check {
  return (value) => Array.isArray(value) && value.length > 0 && value.every(item);
}

function entityId(prefix: string): Check {
  return (value) => typeof value === 'string' && value.startsWith(prefix) && value.length > prefix.length;
}

function integerInRange(minimum: number, maximum: number): Check {
  return (value) => (
    typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum
  );
}

function uniqueWeekdays(value: unknown): boolean {
  return Array.isArray(value)
    && value.length > 0
    && value.every(integerInRange(0, 6))
    && new Set(value).size === value.length;
}

function jsonValue(value: unknown): boolean {
  if (value === null || stringValue(value) || booleanValue(value) || finiteNumber(value)) return true;
  if (Array.isArray(value)) return value.every(jsonValue);
  return isRecord(value) && Object.values(value).every(jsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
