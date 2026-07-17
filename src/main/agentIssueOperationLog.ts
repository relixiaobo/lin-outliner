import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  AGENT_ISSUE_OPERATION_VERSION,
  type Activity,
  type ActorRef,
  type AgentIssue,
  type AgentIssueDeletionTombstone,
  type AgentIssueOperation,
  type AgentIssueOperationBatch,
  type AgentIssueTerminalDelivery,
  type AgentRecurringIssue,
  type AgentSession,
  type AgentSessionExecutionBinding,
  type AgentSessionStopIntent,
} from '../core/agentIssue';

const AGENT_ISSUE_PROJECTION_VERSION = 1;

export interface AgentIssueStoreState {
  v: typeof AGENT_ISSUE_PROJECTION_VERSION;
  issues: Record<string, AgentIssue>;
  recurringIssues: Record<string, AgentRecurringIssue>;
  sessions: Record<string, AgentSession>;
  sessionExecutions: Record<string, AgentSessionExecutionBinding>;
  sessionStopIntents: Record<string, AgentSessionStopIntent>;
  terminalDeliveries: Record<string, AgentIssueTerminalDelivery>;
  activity: Record<string, Activity>;
  activityOrder: string[];
}

export interface AgentIssueOperationProjection {
  state: AgentIssueStoreState;
  issueTombstones: Record<string, AgentIssueDeletionTombstone>;
  recurringIssueTombstones: Record<string, AgentIssueDeletionTombstone>;
  lastSeq: number;
  operationSignatures: Map<string, string>;
}

interface AgentIssueOperationContext {
  actor: ActorRef;
  committedAt: number;
}

function emptyAgentIssueStoreState(): AgentIssueStoreState {
  return {
    v: AGENT_ISSUE_PROJECTION_VERSION,
    issues: {},
    recurringIssues: {},
    sessions: {},
    sessionExecutions: {},
    sessionStopIntents: {},
    terminalDeliveries: {},
    activity: {},
    activityOrder: [],
  };
}

function emptyAgentIssueOperationProjection(): AgentIssueOperationProjection {
  return {
    state: emptyAgentIssueStoreState(),
    issueTombstones: {},
    recurringIssueTombstones: {},
    lastSeq: 0,
    operationSignatures: new Map(),
  };
}

export function buildAgentIssueOperationBatch(
  previous: AgentIssueStoreState,
  next: AgentIssueStoreState,
  context: AgentIssueOperationContext,
  seq: number,
): AgentIssueOperationBatch | null {
  if (previous.v !== AGENT_ISSUE_PROJECTION_VERSION || next.v !== AGENT_ISSUE_PROJECTION_VERSION) {
    throw new Error('Agent Issue projection version cannot change inside a mutation.');
  }
  if (!Number.isSafeInteger(seq) || seq <= 0) {
    throw new Error(`Agent Issue operation seq must be a positive safe integer, received ${seq}.`);
  }
  if (!Number.isFinite(context.committedAt)) {
    throw new Error('Agent Issue operation time must be finite.');
  }

  const operations: AgentIssueOperation[] = [];
  appendIssueOperations(operations, previous.issues, next.issues, context);
  appendRecurringIssueOperations(operations, previous.recurringIssues, next.recurringIssues, context);
  appendUpserts(operations, previous.sessions, next.sessions, (agentSession, id) => {
    if (agentSession.id !== id) throw new Error(`Agent Session key ${id} does not match ${agentSession.id}.`);
    return { type: 'agent-session.upserted', agentSession };
  }, 'Agent Session');
  appendUpserts(operations, previous.sessionExecutions, next.sessionExecutions, (binding, agentSessionId) => ({
    type: 'session-execution.upserted',
    agentSessionId,
    binding,
  }), 'Agent Session execution binding');
  appendStopIntentOperations(operations, previous.sessionStopIntents, next.sessionStopIntents);
  appendUpserts(operations, previous.terminalDeliveries, next.terminalDeliveries, (delivery, id) => {
    if (delivery.id !== id) throw new Error(`Terminal delivery key ${id} does not match ${delivery.id}.`);
    return { type: 'terminal-delivery.upserted', delivery };
  }, 'terminal delivery');
  appendActivityOperations(operations, previous, next);

  if (operations.length === 0) return null;
  return canonicalJsonValue({
    v: AGENT_ISSUE_OPERATION_VERSION,
    seq,
    operationId: randomUUID(),
    actor: context.actor,
    committedAt: context.committedAt,
    operations,
  });
}

export function replayAgentIssueOperationBatches(
  batches: readonly AgentIssueOperationBatch[],
): AgentIssueOperationProjection {
  const projection = emptyAgentIssueOperationProjection();
  for (const batch of batches) applyAgentIssueOperationBatch(projection, batch);
  return projection;
}

export function applyAgentIssueOperationBatch(
  projection: AgentIssueOperationProjection,
  batch: AgentIssueOperationBatch,
): void {
  if (batch.seq <= projection.lastSeq) {
    throw new Error(`Agent Issue operation seq ${batch.seq} is not after ${projection.lastSeq}.`);
  }
  const signature = operationBatchSignature(batch);
  const existingSignature = projection.operationSignatures.get(batch.operationId);
  if (existingSignature !== undefined) {
    if (existingSignature !== signature) {
      throw new Error(`Conflicting Agent Issue operation id ${batch.operationId}.`);
    }
    projection.lastSeq = batch.seq;
    return;
  }

  for (const operation of batch.operations) applyAgentIssueOperation(projection, operation);
  projection.operationSignatures.set(batch.operationId, signature);
  projection.lastSeq = batch.seq;
}

export function parseAgentIssueOperationBatchesJsonl(
  raw: string,
  source: string,
): AgentIssueOperationBatch[] {
  const batches: AgentIssueOperationBatch[] = [];
  const signatures = new Map<string, string>();
  const lines = raw.split(/\r?\n/);
  let lastContentIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]!.trim()) {
      lastContentIndex = index;
      break;
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      if (index === lastContentIndex) {
        console.warn(`Dropping torn trailing Agent Issue operation at ${source}:${index + 1}`);
        break;
      }
      throw new Error(
        `Invalid Agent Issue operation JSON at ${source}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const batch = normalizeAgentIssueOperationBatch(parsed);
    if (!batch) throw new Error(`Invalid Agent Issue operation at ${source}:${index + 1}.`);
    if (batch.seq <= (batches.at(-1)?.seq ?? 0)) {
      throw new Error(`Agent Issue operations are not strictly ordered at ${source}:${index + 1}.`);
    }
    const signature = operationBatchSignature(batch);
    const existingSignature = signatures.get(batch.operationId);
    if (existingSignature !== undefined && existingSignature !== signature) {
      throw new Error(`Conflicting Agent Issue operation id at ${source}:${index + 1}.`);
    }
    signatures.set(batch.operationId, signature);
    batches.push(batch);
  }
  return batches;
}

function appendIssueOperations(
  operations: AgentIssueOperation[],
  previous: Record<string, AgentIssue>,
  next: Record<string, AgentIssue>,
  context: AgentIssueOperationContext,
): void {
  for (const id of sortedUnionKeys(previous, next)) {
    const before = previous[id];
    const after = next[id];
    if (after && after.id !== id) throw new Error(`Issue key ${id} does not match ${after.id}.`);
    if (before && !after) {
      operations.push({
        type: 'issue.deleted',
        tombstone: {
          deletionId: randomUUID(),
          entity: { type: 'issue', issueId: id },
          actor: context.actor,
          deletedAt: context.committedAt,
          lastKnownRevision: before.revision,
        },
      });
    } else if (after && !isDeepStrictEqual(before, after)) {
      operations.push({ type: 'issue.upserted', issue: after });
    }
  }
}

function appendRecurringIssueOperations(
  operations: AgentIssueOperation[],
  previous: Record<string, AgentRecurringIssue>,
  next: Record<string, AgentRecurringIssue>,
  context: AgentIssueOperationContext,
): void {
  for (const id of sortedUnionKeys(previous, next)) {
    const before = previous[id];
    const after = next[id];
    if (after && after.id !== id) throw new Error(`Recurring Issue key ${id} does not match ${after.id}.`);
    if (before && !after) {
      operations.push({
        type: 'recurring-issue.deleted',
        tombstone: {
          deletionId: randomUUID(),
          entity: { type: 'recurring-issue', recurringIssueId: id },
          actor: context.actor,
          deletedAt: context.committedAt,
          lastKnownRevision: before.revision,
        },
      });
    } else if (after && !isDeepStrictEqual(before, after)) {
      operations.push({ type: 'recurring-issue.upserted', recurringIssue: after });
    }
  }
}

function appendUpserts<TValue, TOperation extends AgentIssueOperation>(
  operations: AgentIssueOperation[],
  previous: Record<string, TValue>,
  next: Record<string, TValue>,
  createOperation: (value: TValue, id: string) => TOperation,
  label: string,
): void {
  for (const id of sortedUnionKeys(previous, next)) {
    const before = previous[id];
    const after = next[id];
    if (before !== undefined && after === undefined) {
      throw new Error(`${label} ${id} cannot be removed from the append-only Issue projection.`);
    }
    if (after !== undefined && !isDeepStrictEqual(before, after)) {
      operations.push(createOperation(after, id));
    }
  }
}

function appendStopIntentOperations(
  operations: AgentIssueOperation[],
  previous: Record<string, AgentSessionStopIntent>,
  next: Record<string, AgentSessionStopIntent>,
): void {
  for (const agentSessionId of sortedUnionKeys(previous, next)) {
    const before = previous[agentSessionId];
    const after = next[agentSessionId];
    if (after === undefined) {
      operations.push({ type: 'session-stop-intent.cleared', agentSessionId });
    } else if (!isDeepStrictEqual(before, after)) {
      operations.push({ type: 'session-stop-intent.upserted', agentSessionId, intent: after });
    }
  }
}

function appendActivityOperations(
  operations: AgentIssueOperation[],
  previous: AgentIssueStoreState,
  next: AgentIssueStoreState,
): void {
  if (next.activityOrder.length < previous.activityOrder.length) {
    throw new Error('Issue Activity order cannot shrink.');
  }
  for (let index = 0; index < previous.activityOrder.length; index += 1) {
    const activityId = previous.activityOrder[index]!;
    if (next.activityOrder[index] !== activityId) {
      throw new Error('Issue Activity order is append-only.');
    }
    if (!isDeepStrictEqual(previous.activity[activityId], next.activity[activityId])) {
      throw new Error(`Issue Activity ${activityId} cannot be changed after append.`);
    }
  }

  const appendedIds = next.activityOrder.slice(previous.activityOrder.length);
  const appendedIdSet = new Set(appendedIds);
  for (const activityId of appendedIds) {
    if (previous.activity[activityId] !== undefined) {
      throw new Error(`Issue Activity ${activityId} cannot be appended twice.`);
    }
    const activity = next.activity[activityId];
    if (!activity || activity.id !== activityId) {
      throw new Error(`Issue Activity ${activityId} is missing from the projection.`);
    }
    operations.push({ type: 'activity.appended', activity });
  }
  for (const activityId of Object.keys(next.activity)) {
    if (previous.activity[activityId] === undefined && !appendedIdSet.has(activityId)) {
      throw new Error(`Issue Activity ${activityId} is not present in append order.`);
    }
  }
}

function applyAgentIssueOperation(
  projection: AgentIssueOperationProjection,
  operation: AgentIssueOperation,
): void {
  const state = projection.state;
  switch (operation.type) {
    case 'issue.upserted':
      if (!projection.issueTombstones[operation.issue.id]) {
        state.issues[operation.issue.id] = structuredClone(operation.issue);
      }
      return;
    case 'issue.deleted': {
      const issueId = operation.tombstone.entity.issueId;
      projection.issueTombstones[issueId] ??= structuredClone(operation.tombstone);
      delete state.issues[issueId];
      return;
    }
    case 'recurring-issue.upserted':
      if (!projection.recurringIssueTombstones[operation.recurringIssue.id]) {
        state.recurringIssues[operation.recurringIssue.id] = structuredClone(operation.recurringIssue);
      }
      return;
    case 'recurring-issue.deleted': {
      const recurringIssueId = operation.tombstone.entity.recurringIssueId;
      projection.recurringIssueTombstones[recurringIssueId] ??= structuredClone(operation.tombstone);
      delete state.recurringIssues[recurringIssueId];
      return;
    }
    case 'agent-session.upserted':
      state.sessions[operation.agentSession.id] = structuredClone(operation.agentSession);
      return;
    case 'session-execution.upserted':
      state.sessionExecutions[operation.agentSessionId] = structuredClone(operation.binding);
      return;
    case 'session-stop-intent.upserted':
      state.sessionStopIntents[operation.agentSessionId] = structuredClone(operation.intent);
      return;
    case 'session-stop-intent.cleared':
      delete state.sessionStopIntents[operation.agentSessionId];
      return;
    case 'terminal-delivery.upserted':
      state.terminalDeliveries[operation.delivery.id] = structuredClone(operation.delivery);
      return;
    case 'activity.appended': {
      const existing = state.activity[operation.activity.id];
      if (existing) {
        if (!isDeepStrictEqual(existing, operation.activity)) {
          throw new Error(`Conflicting Issue Activity id ${operation.activity.id}.`);
        }
        return;
      }
      state.activity[operation.activity.id] = structuredClone(operation.activity);
      state.activityOrder.push(operation.activity.id);
      return;
    }
  }
}

function normalizeAgentIssueOperationBatch(value: unknown): AgentIssueOperationBatch | null {
  if (!isRecord(value) || value.v !== AGENT_ISSUE_OPERATION_VERSION) return null;
  if (!isPositiveSafeInteger(value.seq) || !isNonEmptyString(value.operationId)) return null;
  const actor = normalizeActorRef(value.actor);
  if (!actor || !isFiniteNumber(value.committedAt)) return null;
  if (!Array.isArray(value.operations) || value.operations.length === 0) return null;
  const operations: AgentIssueOperation[] = [];
  for (const operation of value.operations) {
    const normalized = normalizeAgentIssueOperation(operation);
    if (!normalized) return null;
    operations.push(normalized);
  }
  return {
    v: AGENT_ISSUE_OPERATION_VERSION,
    seq: value.seq,
    operationId: value.operationId,
    actor,
    committedAt: value.committedAt,
    operations,
  };
}

function normalizeAgentIssueOperation(value: unknown): AgentIssueOperation | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'issue.upserted':
      return isEntity(value.issue, 'id')
        ? { type: value.type, issue: value.issue as unknown as AgentIssue }
        : null;
    case 'issue.deleted': {
      const tombstone = normalizeDeletionTombstone(value.tombstone, 'issue');
      return tombstone?.entity.type === 'issue'
        ? {
            type: value.type,
            tombstone: tombstone as AgentIssueDeletionTombstone<{
              type: 'issue';
              issueId: string;
            }>,
          }
        : null;
    }
    case 'recurring-issue.upserted':
      return isEntity(value.recurringIssue, 'id')
        ? { type: value.type, recurringIssue: value.recurringIssue as unknown as AgentRecurringIssue }
        : null;
    case 'recurring-issue.deleted': {
      const tombstone = normalizeDeletionTombstone(value.tombstone, 'recurring-issue');
      return tombstone?.entity.type === 'recurring-issue'
        ? {
            type: value.type,
            tombstone: tombstone as AgentIssueDeletionTombstone<{
              type: 'recurring-issue';
              recurringIssueId: string;
            }>,
          }
        : null;
    }
    case 'agent-session.upserted':
      return isEntity(value.agentSession, 'id')
        ? { type: value.type, agentSession: value.agentSession as unknown as AgentSession }
        : null;
    case 'session-execution.upserted':
      return isNonEmptyString(value.agentSessionId) && isExecutionBinding(value.binding)
        ? { type: value.type, agentSessionId: value.agentSessionId, binding: value.binding }
        : null;
    case 'session-stop-intent.upserted':
      return isNonEmptyString(value.agentSessionId) && isStopIntent(value.intent)
        ? { type: value.type, agentSessionId: value.agentSessionId, intent: value.intent }
        : null;
    case 'session-stop-intent.cleared':
      return isNonEmptyString(value.agentSessionId)
        ? { type: value.type, agentSessionId: value.agentSessionId }
        : null;
    case 'terminal-delivery.upserted':
      return isTerminalDelivery(value.delivery)
        ? { type: value.type, delivery: value.delivery }
        : null;
    case 'activity.appended':
      return isEntity(value.activity, 'id')
        ? { type: value.type, activity: value.activity as unknown as Activity }
        : null;
    default:
      return null;
  }
}

function normalizeDeletionTombstone(
  value: unknown,
  expectedType: 'issue' | 'recurring-issue',
): AgentIssueDeletionTombstone | null {
  if (!isRecord(value) || !isNonEmptyString(value.deletionId)) return null;
  const actor = normalizeActorRef(value.actor);
  if (!actor || !isFiniteNumber(value.deletedAt) || !isNonEmptyString(value.lastKnownRevision)) {
    return null;
  }
  if (!isRecord(value.entity) || value.entity.type !== expectedType) return null;
  if (expectedType === 'issue' && isNonEmptyString(value.entity.issueId)) {
    return {
      deletionId: value.deletionId,
      entity: { type: 'issue', issueId: value.entity.issueId },
      actor,
      deletedAt: value.deletedAt,
      lastKnownRevision: value.lastKnownRevision,
    };
  }
  if (expectedType === 'recurring-issue' && isNonEmptyString(value.entity.recurringIssueId)) {
    return {
      deletionId: value.deletionId,
      entity: { type: 'recurring-issue', recurringIssueId: value.entity.recurringIssueId },
      actor,
      deletedAt: value.deletedAt,
      lastKnownRevision: value.lastKnownRevision,
    };
  }
  return null;
}

function isExecutionBinding(value: unknown): value is AgentSessionExecutionBinding {
  return isRecord(value)
    && value.engine === 'delegation'
    && isNonEmptyString(value.conversationId)
    && isNonEmptyString(value.executionId)
    && isFiniteNumber(value.startedAt)
    && isFiniteNumber(value.updatedAt);
}

function isStopIntent(value: unknown): value is AgentSessionStopIntent {
  return isRecord(value) && isNonEmptyString(value.token) && isFiniteNumber(value.createdAt);
}

function isTerminalDelivery(value: unknown): value is AgentIssueTerminalDelivery {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.issueId)
    && isFiniteNumber(value.terminalAt)
    && (value.status === 'pending' || value.status === 'dispatching' || value.status === 'delivered')
    && isFiniteNumber(value.attemptCount)
    && isFiniteNumber(value.createdAt)
    && isFiniteNumber(value.updatedAt)
    && isRecord(value.origin);
}

function normalizeActorRef(value: unknown): ActorRef | null {
  if (!isRecord(value)) return null;
  if (value.type === 'system') return { type: 'system' };
  if (value.type === 'user' && isNonEmptyString(value.userId)) {
    return { type: 'user', userId: value.userId };
  }
  if (value.type === 'agent' && isNonEmptyString(value.agentId)) {
    return { type: 'agent', agentId: value.agentId };
  }
  return null;
}

function isEntity(value: unknown, idKey: string): value is Record<string, unknown> {
  return isRecord(value) && isNonEmptyString(value[idKey]);
}

function sortedUnionKeys<TValue>(
  left: Record<string, TValue>,
  right: Record<string, TValue>,
): string[] {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(compareCodeUnits);
}

function operationBatchSignature(batch: AgentIssueOperationBatch): string {
  // seq is local placement; the stable operation identity survives re-sequencing.
  return JSON.stringify(sortJsonValue({
    v: batch.v,
    operationId: batch.operationId,
    actor: batch.actor,
    committedAt: batch.committedAt,
    operations: batch.operations,
  }));
}

function canonicalJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareCodeUnits)
      .map((key) => [key, sortJsonValue(value[key])]),
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
