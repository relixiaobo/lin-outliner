import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isActiveAgentSessionState, isUserVisibleIssueActivity } from '../core/agentIssue';
import type {
  Activity,
  ActivityContent,
  ActivityTarget,
  AgentExecutionPolicy,
  AgentIssue,
  AgentIssueOrigin,
  IssueRelation,
  AgentRef,
  AgentRecurringIssue,
  AgentSession,
  AgentSessionId,
  AgentSessionReadInput,
  AgentSessionReadResult,
  AgentSessionSendMessageInput,
  AgentSessionSource,
  AgentSessionStartInput,
  AgentSessionStopInput,
  ActorRef,
  IssueCreateInput,
  IssueDraftFields,
  IssueInputScope,
  IssueUpdateChange,
  IssueReadInput,
  IssueReadResult,
  IssueSearchInput,
  IssueSearchResult,
  IssueSearchRow,
  IssueViewBucket,
  IssueStatus,
  IssueTargetRef,
  IssueTrigger,
  IssueUpdateInput,
  RecurringIssueDraftFields,
  RecurringIssueTemplate,
  RecurringIssueUpdateChange,
  ResolvedIssueInput,
  RelatedTargetRef,
  TenonAgentToolResult,
  ValidationMessage,
} from '../core/agentIssue';
import type { ChildIssueScopeDefinition } from './agentIssueScopeAuthorization';
import { agentSessionRunScope, issueOutputNodeIds, issueWritableNodeIds } from './agentIssueSessionScope';
import {
  PRIVATE_JSON_FILE_OPTIONS,
  readJsonOrDefault,
  updateJsonFile,
} from './jsonFileStore';
import {
  formatRecurringIssueWindowDate,
  mostRecentRecurringIssueDueAtOrBefore,
  nextRecurringIssueDueAfter,
  normalizeRecurringIssueTimeZone,
  recurringIssueMissedWindowMetadata,
  validateRecurringIssueSchedule,
} from './agentIssueSchedule';

const STORE_VERSION = 5;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_ACTIVITY_BODY_CHARS = 1_200;
export const TERMINAL_DELIVERY_CLAIM_LEASE_MS = 30_000;
const DEFAULT_ISSUE_STATUS: IssueStatus = { name: 'Triage', category: 'triage' };
const DEFAULT_ACTOR: ActorRef = { type: 'system' };
const ISSUE_FIELD_KEYS = new Set([
  'title',
  'description',
  'delegate',
  'relations',
  'trigger',
  'dueDate',
  'completionCriteria',
  'verificationPolicy',
  'evidence',
  'noteNodeIds',
  'input',
  'output',
  'permissionMode',
  'executionPolicy',
]);
const RECURRING_ISSUE_FIELD_KEYS = new Set([
  'titleTemplate',
  'descriptionTemplate',
  'cadence',
  'timeZone',
  'missedPolicy',
  'issueTemplate',
]);
const RECURRING_ISSUE_TEMPLATE_FIELD_KEYS = new Set([
  'delegate',
  'relations',
  'trigger',
  'completionCriteria',
  'verificationPolicy',
  'input',
  'output',
  'permissionMode',
]);

export const AGENT_ISSUE_STORE_FILE = 'issue-manager.json';

export interface AgentIssueStoreState {
  v: typeof STORE_VERSION;
  issues: Record<string, AgentIssue>;
  recurringIssues: Record<string, AgentRecurringIssue>;
  sessions: Record<string, AgentSession>;
  sessionExecutions: Record<string, AgentSessionExecutionBinding>;
  sessionStopIntents: Record<string, AgentSessionStopIntent>;
  terminalDeliveries: Record<string, AgentIssueTerminalDelivery>;
  activity: Record<string, Activity>;
  activityOrder: string[];
}

export interface AgentIssueTerminalDelivery {
  id: string;
  issueId: string;
  agentSessionId?: AgentSessionId;
  origin: AgentIssueOrigin;
  state: 'complete' | 'error' | 'canceled';
  title: string;
  body?: string;
  terminalAt: number;
  status: 'pending' | 'dispatching' | 'delivered';
  dispatchOwnerId?: string;
  attemptCount: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
}

export interface AgentSessionExecutionBinding {
  engine: 'delegation';
  conversationId: string;
  executionId: string;
  startedAt: number;
  updatedAt: number;
}

export interface AgentSessionStopIntent {
  token: string;
  createdAt: number;
}

export interface AgentSessionStopReservation {
  result: TenonAgentToolResult;
  token?: string;
}

export interface AgentIssueConversationRoutingReferences {
  issueIds: string[];
  recurringIssueIds: string[];
  agentSessionIds: string[];
  deliveryIds: string[];
}

export interface AgentSessionExecutionSyncInput {
  engine: AgentSessionExecutionBinding['engine'];
  executionId: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  objectiveStatus?: 'active' | 'verifying' | 'verified' | 'blocked' | 'budget_exhausted' | 'stopped';
  latestOutput?: string;
  errorMessage?: string;
  completedAt?: number;
  acknowledgedTerminalDeliveryIds?: readonly string[];
}

export interface AgentSessionExecutionSyncResult {
  session: AgentSession;
  becameTerminal: boolean;
  issueBecameCompleted: boolean;
  acknowledgedTerminalDeliveryIds: string[];
}

export type IssueInputResolver = (scope: IssueInputScope, issue: AgentIssue, now: number) => ResolvedIssueInput;
export type ChildIssueScopeAuthorizer = (
  parentSession: AgentSession,
  definition: ChildIssueScopeDefinition,
) => ValidationMessage[];

export class AgentIssueStore {
  constructor(private readonly filePath: string) {}

  static forAgentDataRoot(agentDataRoot: string): AgentIssueStore {
    return new AgentIssueStore(path.join(agentDataRoot, AGENT_ISSUE_STORE_FILE));
  }

  coordinationKey(): string {
    return path.resolve(this.filePath);
  }

  async state(): Promise<AgentIssueStoreState> {
    return readJsonOrDefault(this.filePath, emptyState(), parseState);
  }

  async conversationRoutingReferences(
    conversationId: string,
  ): Promise<AgentIssueConversationRoutingReferences> {
    const state = await this.state();
    const issueIds = new Set<string>();
    const recurringIssueIds = new Set<string>();
    const agentSessionIds = new Set<string>();
    const deliveryIds = new Set<string>();

    for (const issue of Object.values(state.issues)) {
      if (
        issue.origin?.type === 'conversation'
        && issue.origin.conversationId === conversationId
        && issue.status.category !== 'completed'
        && issue.status.category !== 'canceled'
      ) {
        issueIds.add(issue.id);
      }
    }
    for (const recurringIssue of Object.values(state.recurringIssues)) {
      if (
        recurringIssue.origin?.conversationId === conversationId
        && recurringIssue.status !== 'archived'
      ) {
        recurringIssueIds.add(recurringIssue.id);
      }
    }

    const boundSessionIds = new Set(Object.entries(state.sessionExecutions)
      .filter(([, binding]) => binding.conversationId === conversationId)
      .map(([agentSessionId]) => agentSessionId));
    for (const agentSessionId of boundSessionIds) {
      const session = state.sessions[agentSessionId];
      if (
        session
        && (
          isActiveAgentSessionState(session.state)
          || state.sessionStopIntents[agentSessionId] !== undefined
          || Object.values(state.issues).some((issue) => (
            issue.origin?.type === 'agent-session'
            && issue.origin.agentSessionId === agentSessionId
            && issue.status.category !== 'completed'
            && issue.status.category !== 'canceled'
          ))
        )
      ) {
        agentSessionIds.add(agentSessionId);
      }
    }

    for (const delivery of Object.values(state.terminalDeliveries)) {
      if (delivery.status === 'delivered') continue;
      if (
        delivery.origin.type === 'conversation'
        && delivery.origin.conversationId === conversationId
      ) {
        deliveryIds.add(delivery.id);
        issueIds.add(delivery.issueId);
      } else if (
        delivery.origin.type === 'agent-session'
        && boundSessionIds.has(delivery.origin.agentSessionId)
      ) {
        deliveryIds.add(delivery.id);
        agentSessionIds.add(delivery.origin.agentSessionId);
      }
    }

    return {
      issueIds: [...issueIds].sort(),
      recurringIssueIds: [...recurringIssueIds].sort(),
      agentSessionIds: [...agentSessionIds].sort(),
      deliveryIds: [...deliveryIds].sort(),
    };
  }

  async search(
    input: IssueSearchInput = {},
    options: { allowedIssueIds?: ReadonlySet<string> } = {},
  ): Promise<IssueSearchResult> {
    const state = await this.state();
    const targets = input.targets?.length ? new Set(input.targets) : new Set(['issue', 'recurring-issue']);
    const rows: IssueSearchRow[] = [];
    if (targets.has('issue')) {
      for (const issue of Object.values(state.issues)) {
        if (options.allowedIssueIds && !options.allowedIssueIds.has(issue.id)) continue;
        if (matchesIssue(issue, state, input)) rows.push(issueRow(issue, state, input));
      }
    }
    if (targets.has('recurring-issue') && !options.allowedIssueIds) {
      for (const recurringIssue of Object.values(state.recurringIssues)) {
        if (matchesRecurringIssue(recurringIssue, input, state)) rows.push(recurringIssueRow(recurringIssue, state, input));
      }
    }
    rows.sort((left, right) => compareSearchRows(left, right, input, state));
    const limit = clampLimit(input.limit);
    const offset = cursorOffset(input.cursor);
    const page = rows.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      rows: page,
      ...(nextOffset < rows.length ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  async read(input: IssueReadInput): Promise<IssueReadResult> {
    const state = await this.state();
    return readFromState(state, input);
  }

  async create(
    input: IssueCreateInput,
    actor: ActorRef = DEFAULT_ACTOR,
    now = Date.now(),
    options: {
      origin?: AgentIssueOrigin;
      authorizeChildScope?: ChildIssueScopeAuthorizer;
    } = {},
  ): Promise<TenonAgentToolResult> {
    const validation = validateIssueCreateInput(input);
    if (validation.length > 0) return { status: 'blocked', targets: [], validation };
    if (input.request.mode === 'preview') {
      const preflight = preflightIssueCreate(await this.state(), input, options);
      if (preflight.validation.length > 0) {
        return { status: 'blocked', targets: [], validation: preflight.validation };
      }
      const target: RelatedTargetRef = { type: input.issueType, id: `preview:${randomUUID()}` } as RelatedTargetRef;
      return { status: 'preview', targets: [target] };
    }

    let createdTarget: RelatedTargetRef | null = null;
    let createdActivityId: string | null = null;
    let creationFailure: TenonAgentToolResult | null = null;
    return updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      const preflight = preflightIssueCreate(state, input, options);
      if (preflight.validation.length > 0) {
        creationFailure = { status: 'blocked', targets: [], validation: preflight.validation };
        return state;
      }
      if (input.issueType === 'issue') {
        const parentSession = preflight.parentSession;
        const issue = buildIssue(input.fields, actor, now, options.origin, parentSession?.issueId);
        state.issues[issue.id] = issue;
        const activity = appendActivity(state, {
          target: { type: 'issue', issueId: issue.id },
          actor,
          content: { type: 'created' },
          createdAt: now,
        });
        createdTarget = { type: 'issue', id: issue.id };
        createdActivityId = activity.id;
        if (issue.parentIssueId) {
          appendActivity(state, {
            target: { type: 'issue', issueId: issue.parentIssueId },
            actor,
            content: { type: 'agent-action', action: 'child_issue_created', result: issue.id },
            relatedTargets: [{ type: 'issue', id: issue.id }],
            createdAt: now,
          });
        }
        return state;
      }

      const recurringOrigin = options.origin?.type === 'conversation' ? options.origin : undefined;
      const recurringIssue = buildRecurringIssue(
        input.fields,
        actor,
        now,
        recurringOrigin,
      );
      state.recurringIssues[recurringIssue.id] = recurringIssue;
      const activity = appendActivity(state, {
        target: { type: 'recurring-issue', recurringIssueId: recurringIssue.id },
        actor,
        content: { type: 'created' },
        createdAt: now,
      });
      createdTarget = { type: 'recurring-issue', id: recurringIssue.id };
      createdActivityId = activity.id;
      return state;
    }, PRIVATE_JSON_FILE_OPTIONS).then((state) => {
      if (creationFailure) return creationFailure;
      const target = createdTarget;
      if (!target || !createdActivityId) return { status: 'blocked', targets: [], validation: [{ code: 'not_found', message: 'Created target was not found.' }] };
      const targetRevision = revisionForTarget(state, target);
      if (!targetRevision) return { status: 'blocked', targets: [target], validation: [{ code: 'not_found', message: 'Created target revision was not found.' }] };
      return {
        status: 'applied',
        targets: [target, { type: 'activity', id: createdActivityId }],
        revisions: [{ target, revision: targetRevision }],
      };
    });
  }

  async update(
    input: IssueUpdateInput,
    actor: ActorRef = DEFAULT_ACTOR,
    now = Date.now(),
    options: {
      authorizeChildScope?: ChildIssueScopeAuthorizer;
      allowHumanReviewTransition?: boolean;
    } = {},
  ): Promise<TenonAgentToolResult> {
    const validation = validateIssueUpdateInput(input);
    if (validation.length > 0) {
      const target = safeTargetFromUpdateInput(input);
      return { status: 'blocked', targets: target ? [target] : [], validation };
    }
    const target = targetFromUpdateInput(input);
    if (input.request.mode === 'preview') {
      const preflight = applyIssueUpdateToState(structuredClone(await this.state()), input, actor, now, options);
      return preflight.status === 'applied'
        ? { status: 'preview', targets: preflight.targets }
        : preflight;
    }

    let outcome: TenonAgentToolResult | null = null;
    await updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      outcome = applyIssueUpdateToState(state, input, actor, now, options);
      return state;
    }, PRIVATE_JSON_FILE_OPTIONS);
    return outcome ?? {
      status: 'blocked',
      targets: [target],
      validation: [{ code: 'not_found', message: 'Target object was not found.' }],
    };
  }

  async startSession(
    input: AgentSessionStartInput,
    source: AgentSessionSource,
    actor: ActorRef = DEFAULT_ACTOR,
    now = Date.now(),
    options: {
      resolveInput?: IssueInputResolver;
      authorizeChildScope?: ChildIssueScopeAuthorizer;
    } = {},
  ): Promise<TenonAgentToolResult> {
    if (input.request.mode === 'preview') {
      const state = await this.state();
      const issueTarget: RelatedTargetRef = { type: 'issue', id: input.issueId };
      const issue = state.issues[input.issueId];
      if (!issue) {
        return {
          status: 'blocked',
          targets: [issueTarget],
          validation: [{ code: 'not_found', message: 'Issue was not found.' }],
        };
      }
      if (input.expectedIssueRevision && input.expectedIssueRevision !== issue.revision) {
        return {
          status: 'conflict',
          targets: [issueTarget],
          validation: [{ code: 'revision_mismatch', message: 'Issue changed since it was read.' }],
          revisions: [{ target: issueTarget, revision: issue.revision }],
        };
      }
      const validation = validateSessionStart(state, issue, input, now);
      if (validation.length === 0) {
        const session = buildSession(issue, input, source, now, options.resolveInput);
        validation.push(...validateChildSessionScope(
          state,
          issue,
          session,
          options.authorizeChildScope,
        ));
      }
      return validation.length > 0
        ? {
            status: 'blocked',
            targets: [issueTarget],
            validation,
            revisions: [{ target: issueTarget, revision: issue.revision }],
          }
        : { status: 'preview', targets: [issueTarget] };
    }

    const issueTarget: RelatedTargetRef = { type: 'issue', id: input.issueId };
    let outcome: TenonAgentToolResult | null = null;
    await updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      const issue = state.issues[input.issueId];
      if (!issue) {
        outcome = {
          status: 'blocked',
          targets: [issueTarget],
          validation: [{ code: 'not_found', message: 'Issue was not found.' }],
        };
        return state;
      }
      if (input.expectedIssueRevision && input.expectedIssueRevision !== issue.revision) {
        outcome = {
          status: 'conflict',
          targets: [issueTarget],
          validation: [{ code: 'revision_mismatch', message: 'Issue changed since it was read.' }],
          revisions: [{ target: issueTarget, revision: issue.revision }],
        };
        return state;
      }
      const validation = validateSessionStart(state, issue, input, now);
      if (validation.length > 0) {
        outcome = {
          status: 'blocked',
          targets: [issueTarget],
          validation,
          revisions: [{ target: issueTarget, revision: issue.revision }],
        };
        return state;
      }
      const session = buildSession(issue, input, source, now, options.resolveInput);
      const scopeValidation = validateChildSessionScope(
        state,
        issue,
        session,
        options.authorizeChildScope,
      );
      if (scopeValidation.length > 0) {
        outcome = {
          status: 'blocked',
          targets: [issueTarget],
          validation: scopeValidation,
          revisions: [{ target: issueTarget, revision: issue.revision }],
        };
        return state;
      }
      state.sessions[session.id] = session;
      appendActivity(state, {
        target: { type: 'agent-session', agentSessionId: session.id },
        actor,
        content: { type: 'agent-progress', body: 'Agent Session created and waiting for runtime execution.' },
        relatedTargets: [{ type: 'issue', id: issue.id }],
        createdAt: now,
      });
      appendActivity(state, {
        target: { type: 'issue', issueId: issue.id },
        actor,
        content: { type: 'agent-action', action: 'agent_session_start', result: session.id },
        relatedTargets: [{ type: 'agent-session', id: session.id }],
        createdAt: now,
      });
      outcome = {
        status: 'applied',
        targets: [issueTarget, { type: 'agent-session', id: session.id }],
        revisions: [{ target: { type: 'agent-session', id: session.id }, revision: session.revision }],
      };
      return state;
    }, PRIVATE_JSON_FILE_OPTIONS);
    return outcome ?? {
      status: 'blocked',
      targets: [issueTarget],
      validation: [{ code: 'not_found_or_conflict', message: 'Issue was not found or revision did not match.' }],
    };
  }

  async readSession(input: AgentSessionReadInput): Promise<AgentSessionReadResult | null> {
    const state = await this.state();
    const agentSession = state.sessions[input.agentSessionId];
    if (!agentSession) return null;
    return {
      agentSession,
      ...(input.include?.includes('activity-summary')
        ? { activity: activityForTarget(state, { type: 'agent-session', agentSessionId: input.agentSessionId }) }
        : {}),
    };
  }

  async executionForSession(agentSessionId: AgentSessionId): Promise<AgentSessionExecutionBinding | undefined> {
    const state = await this.state();
    return state.sessionExecutions[agentSessionId];
  }

  async sessionForExecutionConversation(conversationId: string): Promise<AgentSession | null> {
    const state = await this.state();
    const entry = Object.entries(state.sessionExecutions)
      .filter(([, binding]) => binding.conversationId === conversationId)
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)[0];
    return entry ? state.sessions[entry[0]] ?? null : null;
  }

  async sessionForExecution(
    input: Pick<AgentSessionExecutionBinding, 'engine' | 'executionId'>,
  ): Promise<AgentSession | null> {
    const state = await this.state();
    const entry = Object.entries(state.sessionExecutions).find(([, binding]) => (
      binding.engine === input.engine && binding.executionId === input.executionId
    ));
    return entry ? state.sessions[entry[0]] ?? null : null;
  }

  async bindSessionExecution(
    agentSessionId: AgentSessionId,
    binding: Omit<AgentSessionExecutionBinding, 'updatedAt'>,
    actor: ActorRef = DEFAULT_ACTOR,
    now = Date.now(),
  ): Promise<TenonAgentToolResult> {
    const target: RelatedTargetRef = { type: 'agent-session', id: agentSessionId };
    let outcome: TenonAgentToolResult | null = null;
    await updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      const session = state.sessions[agentSessionId];
      if (!session) {
        outcome = { status: 'blocked', targets: [target], validation: [{ code: 'not_found', message: 'Agent Session was not found.' }] };
        return state;
      }
      if (state.sessionStopIntents[agentSessionId]) {
        outcome = {
          status: 'blocked',
          targets: [target],
          validation: [{ code: 'stop_in_progress', message: 'Agent Session cannot bind an execution while stop is in progress.' }],
          revisions: [{ target, revision: session.revision }],
        };
        return state;
      }
      const duplicateExecution = Object.entries(state.sessionExecutions).find(([candidateSessionId, candidate]) => (
        candidateSessionId !== agentSessionId
        && candidate.engine === binding.engine
        && candidate.executionId === binding.executionId
      ));
      if (duplicateExecution) {
        outcome = {
          status: 'conflict',
          targets: [target],
          validation: [{
            code: 'execution_already_bound',
            message: `Execution is already bound to Agent Session ${duplicateExecution[0]}.`,
          }],
          revisions: [{ target, revision: session.revision }],
        };
        return state;
      }
      const existing = state.sessionExecutions[agentSessionId];
      if (existing) {
        const sameBinding = existing.engine === binding.engine
          && existing.conversationId === binding.conversationId
          && existing.executionId === binding.executionId;
        outcome = sameBinding
          ? { status: 'applied', targets: [target], revisions: [{ target, revision: session.revision }] }
          : {
              status: 'conflict',
              targets: [target],
              validation: [{ code: 'execution_already_bound', message: 'Agent Session is already bound to a different execution.' }],
              revisions: [{ target, revision: session.revision }],
            };
        return state;
      }
      if (isTerminalSessionState(session.state)) {
        outcome = {
          status: 'blocked',
          targets: [target],
          validation: [{ code: 'terminal_session', message: 'A terminal Agent Session cannot be bound to a new execution.' }],
          revisions: [{ target, revision: session.revision }],
        };
        return state;
      }
      state.sessionExecutions[agentSessionId] = { ...binding, updatedAt: now };
      const previousState = session.state;
      session.state = 'active';
      session.startedAt ??= binding.startedAt;
      session.updatedAt = now;
      session.revision = revision(now);
      if (previousState !== 'active') {
        appendActivity(state, {
          target: { type: 'agent-session', agentSessionId },
          actor,
          content: { type: 'agent-progress', body: 'Agent Session execution started.' },
          relatedTargets: [{ type: 'issue', id: session.issueId }],
          createdAt: now,
        });
      }
      markIssueStartedForSession(state, session, actor, now);
      outcome = {
        status: 'applied',
        targets: [target],
        revisions: [{ target, revision: session.revision }],
      };
      return state;
    }, PRIVATE_JSON_FILE_OPTIONS);
    return outcome ?? { status: 'blocked', targets: [target], validation: [{ code: 'not_found', message: 'Agent Session was not found.' }] };
  }

  async failSessionStart(
    agentSessionId: AgentSessionId,
    message: string,
    actor: ActorRef = DEFAULT_ACTOR,
    now = Date.now(),
  ): Promise<TenonAgentToolResult> {
    const target: RelatedTargetRef = { type: 'agent-session', id: agentSessionId };
    return updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      const session = state.sessions[agentSessionId];
      if (!session) return state;
      if (isTerminalSessionState(session.state)) return state;
      // A concurrent stop reservation owns the pending Session. Leave it
      // pending so the stopper can atomically commit cancellation; a bind
      // rejected by that reservation is not an execution failure.
      if (state.sessionStopIntents[agentSessionId]) return state;
      session.state = 'error';
      session.errorMessage = message;
      session.completedAt = now;
      session.updatedAt = now;
      session.revision = revision(now);
      appendActivity(state, {
        target: { type: 'agent-session', agentSessionId },
        actor,
        content: { type: 'agent-error', body: activityBody(message, 'Agent Session failed to start.') },
        relatedTargets: [{ type: 'issue', id: session.issueId }],
        createdAt: now,
      });
      enqueueSessionErrorDelivery(state, session, now);
      return state;
    }, PRIVATE_JSON_FILE_OPTIONS).then((state) => {
      const session = state.sessions[agentSessionId];
      if (!session) {
        return { status: 'blocked', targets: [target], validation: [{ code: 'not_found', message: 'Agent Session was not found.' }] };
      }
      return {
        status: 'applied',
        targets: [target],
        revisions: [{ target, revision: session.revision }],
      };
    });
  }

  async syncSessionExecution(
    input: AgentSessionExecutionSyncInput,
    actor: ActorRef = DEFAULT_ACTOR,
    now = Date.now(),
  ): Promise<AgentSessionExecutionSyncResult | null> {
    let syncedSessionId: string | null = null;
    let becameTerminal = false;
    let issueBecameCompleted = false;
    let acknowledgedTerminalDeliveryIds: string[] = [];
    await updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      const entry = Object.entries(state.sessionExecutions).find(([, binding]) => (
        binding.engine === input.engine && binding.executionId === input.executionId
      ));
      if (!entry) return state;
      const [agentSessionId, binding] = entry;
      const session = state.sessions[agentSessionId];
      if (!session) return state;
      syncedSessionId = agentSessionId;
      const previousState = session.state;
      const requestedNextState = agentSessionStateFromExecution(input.state);
      const nextState = requestedNextState === 'canceled'
        && sessionHasOutstandingChildEdge(state, session)
        ? 'stale'
        : requestedNextState;
      if (now < binding.updatedAt) return state;
      if (previousState === 'canceled') {
        delete state.sessionStopIntents[agentSessionId];
        return state;
      }
      if (
        now === binding.updatedAt
        && isTerminalSessionState(previousState)
        && nextState !== previousState
      ) return state;
      if (nextState === 'complete') {
        acknowledgedTerminalDeliveryIds = acknowledgeTerminalDeliveriesForSession(
          state,
          agentSessionId,
          input.acknowledgedTerminalDeliveryIds ?? [],
          now,
        );
      }
      if (isTerminalSessionState(nextState)) {
        delete state.sessionStopIntents[agentSessionId];
      }
      if (
        now === binding.updatedAt
        && acknowledgedTerminalDeliveryIds.length === 0
        && executionSnapshotMatches(session, nextState, input)
      ) return state;

      const previousOutput = session.latestOutput;
      const wasTerminal = isTerminalSessionState(previousState);
      const isRoutableTerminal = nextState === 'complete' || nextState === 'error' || nextState === 'stale';
      becameTerminal = isRoutableTerminal && previousState !== nextState;
      binding.updatedAt = now;
      session.state = nextState;
      session.latestOutput = input.latestOutput ?? session.latestOutput;
      if (nextState === 'active') {
        session.startedAt ??= binding.startedAt;
        if (wasTerminal) {
          session.completedAt = undefined;
          session.errorMessage = undefined;
          if (input.latestOutput === undefined) session.latestOutput = undefined;
        }
        markIssueStartedForSession(state, session, actor, now);
      } else if (nextState === 'complete') {
        if (previousState === 'error' || previousState === 'stale') session.errorMessage = undefined;
      } else if (input.errorMessage !== undefined) {
        session.errorMessage = input.errorMessage;
      }
      if (isTerminalSessionState(nextState) && previousState !== nextState) {
        session.completedAt = input.completedAt ?? now;
      }
      session.updatedAt = now;
      session.revision = revision(now);
      if (previousState !== nextState) {
        appendActivity(state, {
          target: { type: 'agent-session', agentSessionId },
          actor,
          content: sessionStateActivityContent(nextState, input),
          relatedTargets: [{ type: 'issue', id: session.issueId }],
          createdAt: now,
        });
      }
      if (nextState === 'complete' && session.purpose === 'verify' && (
        previousState !== nextState || previousOutput !== session.latestOutput
      )) {
        const verdict = appendVerifierResultActivity(state, session, input, actor, now);
        if (verdict && verifierVerdictAccepted(
          state.issues[session.issueId]?.verificationPolicy,
          verdict.verdict,
          verdict.evaluationText,
        )) {
          const executionSession = latestCompletedExecutionSession(state, session.issueId);
          const finalized = finalizeIssue(state, session.issueId, {
            actor,
            now,
            evidenceSession: executionSession ?? session,
            allowHumanReview: false,
            verificationSatisfied: true,
          });
          issueBecameCompleted = finalized.completed;
          recordSessionFinalizationBlock(state, session, finalized.validation, actor, now);
        }
      }
      if (nextState === 'complete' && session.purpose !== 'verify') {
        const verificationMode = state.issues[session.issueId]?.verificationPolicy?.mode ?? 'none';
        const verificationSatisfied = verificationMode !== 'agent-review' || input.objectiveStatus === 'verified';
        const finalized = finalizeIssue(state, session.issueId, {
          actor,
          now,
          evidenceSession: session,
          allowHumanReview: false,
          verificationSatisfied,
        });
        issueBecameCompleted = finalized.completed;
        recordSessionFinalizationBlock(state, session, finalized.validation, actor, now);
      }
      if (
        (nextState === 'error' || nextState === 'stale')
        && previousState !== nextState
        && !(previousState === 'stale' && nextState === 'error')
      ) {
        enqueueSessionErrorDelivery(state, session, now);
      }
      return state;
    }, PRIVATE_JSON_FILE_OPTIONS);
    if (!syncedSessionId) return null;
    const session = (await this.readSession({ agentSessionId: syncedSessionId }))?.agentSession;
    return session ? {
      session,
      becameTerminal,
      issueBecameCompleted,
      acknowledgedTerminalDeliveryIds,
    } : null;
  }

  async preflightSessionMessage(
    input: AgentSessionSendMessageInput,
  ): Promise<TenonAgentToolResult> {
    return preflightSessionMessageFromState(await this.state(), input);
  }

  async preflightSessionStop(
    input: AgentSessionStopInput,
  ): Promise<TenonAgentToolResult> {
    return preflightSessionStopFromState(await this.state(), input);
  }

  async reserveSessionStop(
    input: AgentSessionStopInput,
    now = Date.now(),
  ): Promise<AgentSessionStopReservation> {
    const target: RelatedTargetRef = { type: 'agent-session', id: input.agentSessionId };
    let reservation: AgentSessionStopReservation | null = null;
    await updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      const session = state.sessions[input.agentSessionId];
      if (!session) {
        reservation = {
          result: { status: 'blocked', targets: [target], validation: [{ code: 'not_found', message: 'Agent Session was not found.' }] },
        };
        return state;
      }
      if (session.state === 'canceled') {
        reservation = {
          result: { status: 'applied', targets: [target], revisions: [{ target, revision: session.revision }] },
        };
        return state;
      }
      if (state.sessionStopIntents[session.id]) {
        reservation = {
          result: {
            status: 'blocked',
            targets: [target],
            validation: [{ code: 'stop_in_progress', message: 'Agent Session stop is already in progress.' }],
            revisions: [{ target, revision: session.revision }],
          },
        };
        return state;
      }
      const validation = sessionStopValidation(state, session);
      if (validation.length > 0) {
        reservation = {
          result: {
            status: 'blocked',
            targets: [target],
            validation,
            revisions: [{ target, revision: session.revision }],
          },
        };
        return state;
      }
      const token = `session-stop:${randomUUID()}`;
      state.sessionStopIntents[session.id] = { token, createdAt: now };
      reservation = {
        token,
        result: { status: 'applied', targets: [target], revisions: [{ target, revision: session.revision }] },
      };
      return state;
    }, PRIVATE_JSON_FILE_OPTIONS);
    return reservation ?? {
      result: { status: 'blocked', targets: [target], validation: [{ code: 'not_found', message: 'Agent Session was not found.' }] },
    };
  }

  async releaseSessionStop(
    agentSessionId: string,
    token: string,
  ): Promise<void> {
    await updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      if (state.sessionStopIntents[agentSessionId]?.token === token) {
        delete state.sessionStopIntents[agentSessionId];
      }
      return state;
    }, PRIVATE_JSON_FILE_OPTIONS);
  }

  async commitReservedSessionStop(
    input: AgentSessionStopInput,
    token: string,
    actor: ActorRef = DEFAULT_ACTOR,
    now = Date.now(),
  ): Promise<TenonAgentToolResult> {
    const target: RelatedTargetRef = { type: 'agent-session', id: input.agentSessionId };
    let outcome: TenonAgentToolResult | null = null;
    await updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      const session = state.sessions[input.agentSessionId];
      if (!session) {
        outcome = { status: 'blocked', targets: [target], validation: [{ code: 'not_found', message: 'Agent Session was not found.' }] };
        return state;
      }
      if (session.state === 'canceled') {
        delete state.sessionStopIntents[session.id];
        outcome = { status: 'applied', targets: [target], revisions: [{ target, revision: session.revision }] };
        return state;
      }
      if (state.sessionStopIntents[session.id]?.token !== token) {
        outcome = {
          status: 'conflict',
          targets: [target],
          validation: [{ code: 'stop_reservation_lost', message: 'Agent Session stop reservation is no longer current.' }],
          revisions: [{ target, revision: session.revision }],
        };
        return state;
      }
      delete state.sessionStopIntents[session.id];
      const validation = sessionStopValidation(state, session);
      if (validation.length > 0) {
        outcome = {
          status: 'blocked',
          targets: [target],
          validation,
          revisions: [{ target, revision: session.revision }],
        };
        return state;
      }
      cancelSession(state, session, actor, now);
      outcome = {
        status: 'applied',
        targets: [target],
        revisions: [{ target, revision: session.revision }],
      };
      return state;
    }, PRIVATE_JSON_FILE_OPTIONS);
    return outcome ?? {
      status: 'blocked',
      targets: [target],
      validation: [{ code: 'not_found', message: 'Agent Session was not found.' }],
    };
  }

  async sendSessionMessage(input: AgentSessionSendMessageInput, actor: ActorRef = DEFAULT_ACTOR, now = Date.now()): Promise<TenonAgentToolResult> {
    const target: RelatedTargetRef = { type: 'agent-session', id: input.agentSessionId };
    if (input.request.mode === 'preview') {
      const preflight = await this.preflightSessionMessage(input);
      return preflight.status === 'applied'
        ? { status: 'preview', targets: preflight.targets, revisions: preflight.revisions }
        : preflight;
    }

    let outcome: TenonAgentToolResult | null = null;
    await updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      const preflight = preflightSessionMessageFromState(state, input);
      if (preflight.status !== 'applied') {
        outcome = preflight;
        return state;
      }
      const session = state.sessions[input.agentSessionId]!;
      appendActivity(state, {
        target: { type: 'agent-session', agentSessionId: session.id },
        actor,
        content: { type: 'comment', body: activityBody(input.message, 'Session guidance sent.') },
        relatedTargets: [{ type: 'issue', id: session.issueId }],
        createdAt: now,
      });
      session.updatedAt = now;
      session.revision = revision(now);
      outcome = {
        status: 'applied',
        targets: [target],
        revisions: [{ target, revision: session.revision }],
      };
      return state;
    }, PRIVATE_JSON_FILE_OPTIONS);
    return outcome ?? { status: 'blocked', targets: [target], validation: [{ code: 'not_found', message: 'Agent Session was not found.' }] };
  }

  async stopSession(input: AgentSessionStopInput, actor: ActorRef = DEFAULT_ACTOR, now = Date.now()): Promise<TenonAgentToolResult> {
    const target: RelatedTargetRef = { type: 'agent-session', id: input.agentSessionId };
    if (input.request.mode === 'preview') {
      const preflight = await this.preflightSessionStop(input);
      return preflight.status === 'applied'
        ? { status: 'preview', targets: preflight.targets, revisions: preflight.revisions }
        : preflight;
    }

    let outcome: TenonAgentToolResult | null = null;
    await updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      const session = state.sessions[input.agentSessionId];
      const preflight = preflightSessionStopFromState(state, input);
      if (preflight.status !== 'applied') {
        outcome = preflight;
        return state;
      }
      if (session?.state === 'canceled') {
        outcome = {
          status: 'applied',
          targets: [target],
          revisions: [{ target, revision: session.revision }],
        };
        return state;
      }
      cancelSession(state, session!, actor, now);
      outcome = {
        status: 'applied',
        targets: [target],
        revisions: [{ target, revision: session!.revision }],
      };
      return state;
    }, PRIVATE_JSON_FILE_OPTIONS);
    return outcome ?? { status: 'blocked', targets: [target], validation: [{ code: 'not_found', message: 'Agent Session was not found.' }] };
  }

  async claimTerminalDeliveries(
    ownerId: string,
    limit = DEFAULT_LIMIT,
    now = Date.now(),
  ): Promise<AgentIssueTerminalDelivery[]> {
    const snapshot = await this.state();
    if (!Object.values(snapshot.terminalDeliveries).some((delivery) => isTerminalDeliveryClaimable(delivery, now))) {
      return [];
    }
    const claimedIds: string[] = [];
    const claimLimit = clampLimit(limit);
    const state = await updateJsonFile(this.filePath, emptyState(), parseState, (current) => {
      const candidates = Object.values(current.terminalDeliveries)
        .filter((delivery) => isTerminalDeliveryClaimable(delivery, now))
        .sort((left, right) => left.terminalAt - right.terminalAt || left.createdAt - right.createdAt)
        .slice(0, claimLimit);
      for (const delivery of candidates) {
        delivery.status = 'dispatching';
        delivery.dispatchOwnerId = ownerId;
        delivery.attemptCount += 1;
        delivery.updatedAt = now;
        claimedIds.push(delivery.id);
      }
      return current;
    }, PRIVATE_JSON_FILE_OPTIONS);
    return claimedIds
      .map((id) => state.terminalDeliveries[id])
      .filter((delivery): delivery is AgentIssueTerminalDelivery => Boolean(delivery))
      .map(cloneTerminalDelivery);
  }

  async completeTerminalDelivery(deliveryId: string, ownerId: string, now = Date.now()): Promise<boolean> {
    let completed = false;
    await updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      const delivery = state.terminalDeliveries[deliveryId];
      if (!delivery || delivery.status !== 'dispatching' || delivery.dispatchOwnerId !== ownerId) return state;
      delivery.status = 'delivered';
      delivery.dispatchOwnerId = undefined;
      delivery.lastError = undefined;
      delivery.deliveredAt = now;
      delivery.updatedAt = now;
      completed = true;
      return state;
    }, PRIVATE_JSON_FILE_OPTIONS);
    return completed;
  }

  async releaseTerminalDelivery(
    deliveryId: string,
    ownerId: string,
    error?: string,
    now = Date.now(),
  ): Promise<boolean> {
    let released = false;
    await updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      const delivery = state.terminalDeliveries[deliveryId];
      if (!delivery || delivery.status !== 'dispatching' || delivery.dispatchOwnerId !== ownerId) return state;
      delivery.status = 'pending';
      delivery.dispatchOwnerId = undefined;
      delivery.lastError = error;
      delivery.updatedAt = now;
      released = true;
      return state;
    }, PRIVATE_JSON_FILE_OPTIONS);
    return released;
  }

  async materializeDueRecurringIssues(now = Date.now(), actor: ActorRef = DEFAULT_ACTOR): Promise<AgentIssue[]> {
    const materialized: AgentIssue[] = [];
    await updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      for (const recurringIssue of Object.values(state.recurringIssues)) {
        if (recurringIssue.status !== 'active' || recurringIssue.archivedAt !== undefined) continue;
        const scheduleCursor = recurringIssue.nextMaterializationAt;
        if (scheduleCursor !== undefined && now < scheduleCursor) continue;
        const dueAt = mostRecentRecurringIssueDueAtOrBefore(
          recurringIssue.cadence,
          recurringIssue.timeZone,
          now,
          Math.max(recurringIssue.createdAt, scheduleCursor ?? recurringIssue.createdAt),
        );
        if (dueAt === null) {
          const nextMaterializationAt = nextRecurringIssueDueAfter(
            recurringIssue.cadence,
            recurringIssue.timeZone,
            now,
          ) ?? undefined;
          updateNextMaterializationAt(recurringIssue, nextMaterializationAt, now);
          continue;
        }
        if (isSkippedRecurringWindow(recurringIssue, dueAt)) {
          recurringIssue.nextMaterializationAt = nextRecurringIssueDueAfter(
            recurringIssue.cadence,
            recurringIssue.timeZone,
            dueAt,
          ) ?? undefined;
          recurringIssue.updatedAt = now;
          recurringIssue.revision = revision(now);
          continue;
        }
        if (hasGeneratedIssueForWindow(state, recurringIssue.id, dueAt)) {
          const nextMaterializationAt = nextRecurringIssueDueAfter(
            recurringIssue.cadence,
            recurringIssue.timeZone,
            dueAt,
          ) ?? undefined;
          updateNextMaterializationAt(recurringIssue, nextMaterializationAt, now);
          continue;
        }
        const nextDue = nextRecurringIssueDueAfter(recurringIssue.cadence, recurringIssue.timeZone, dueAt);
        const missedWindowMetadata = recurringIssueMissedWindowMetadata({
          cadence: recurringIssue.cadence,
          timeZone: recurringIssue.timeZone,
          missedPolicy: recurringIssue.missedPolicy,
          createdAt: recurringIssue.createdAt,
          dueAt,
          ...(scheduleCursor !== undefined ? { firstEligibleWindowStart: scheduleCursor } : {}),
          generatedWindowStarts: Object.values(state.issues)
            .map((issue) => issue.recurrence?.recurringIssueId === recurringIssue.id
              ? issue.recurrence.windowStartAt
              : undefined)
            .filter((value): value is number => value !== undefined),
          skippedWindowStarts: recurringIssue.skippedMaterializationAts,
        });
        const issue = issueFromRecurringIssue(
          recurringIssue,
          dueAt,
          nextDue ?? dueAt,
          now,
          missedWindowMetadata.skippedWindowCount,
        );
        state.issues[issue.id] = issue;
        recurringIssue.nextMaterializationAt = nextDue ?? undefined;
        recurringIssue.updatedAt = now;
        recurringIssue.revision = revision(now);
        appendActivity(state, {
          target: { type: 'recurring-issue', recurringIssueId: recurringIssue.id },
          actor,
          content: {
            type: 'agent-action',
            action: 'materialize',
            ...(missedWindowMetadata.activityParameter
              ? { parameter: missedWindowMetadata.activityParameter }
              : {}),
            result: issue.id,
          },
          relatedTargets: [{ type: 'issue', id: issue.id }],
          createdAt: now,
        });
        appendActivity(state, {
          target: { type: 'issue', issueId: issue.id },
          actor,
          content: { type: 'field-change', field: 'recurrence', to: recurringIssue.id },
          relatedTargets: [{ type: 'recurring-issue', id: recurringIssue.id }],
          createdAt: now,
        });
        materialized.push(issue);
      }
      return state;
    }, PRIVATE_JSON_FILE_OPTIONS);
    return materialized;
  }

  async listReadyIssuesForExecution(now = Date.now()): Promise<AgentIssue[]> {
    const state = await this.state();
    return Object.values(state.issues)
      .filter((issue) => isIssueReadyForExecution(issue, state, now))
      .sort((left, right) => triggerSortTime(left) - triggerSortTime(right) || left.createdAt - right.createdAt);
  }

  async markInterruptedSessionsStale(
    actor: ActorRef = DEFAULT_ACTOR,
    now = Date.now(),
    sessionIds?: ReadonlySet<string>,
  ): Promise<AgentSession[]> {
    const staleSessions: AgentSession[] = [];
    await updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      const candidateIds = sessionIds ? [...sessionIds] : Object.keys(state.sessions);
      for (const sessionId of candidateIds) {
        delete state.sessionStopIntents[sessionId];
        const session = state.sessions[sessionId];
        if (!session) continue;
        if (!isRecoverableLiveSession(session.state)) continue;
        session.state = 'stale';
        session.errorMessage = 'Agent Session was interrupted before runtime restore.';
        session.completedAt = now;
        session.updatedAt = now;
        session.revision = revision(now);
        appendActivity(state, {
          target: { type: 'agent-session', agentSessionId: session.id },
          actor,
          content: { type: 'agent-error', body: session.errorMessage },
          relatedTargets: [{ type: 'issue', id: session.issueId }],
          createdAt: now,
        });
        enqueueSessionErrorDelivery(state, session, now);
        staleSessions.push(session);
      }
      return state;
    }, PRIVATE_JSON_FILE_OPTIONS);
    return staleSessions;
  }
}

function emptyState(): AgentIssueStoreState {
  return {
    v: STORE_VERSION,
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

function parseState(value: unknown): AgentIssueStoreState {
  if (!isRecord(value) || value.v !== STORE_VERSION) return emptyState();
  return {
    v: STORE_VERSION,
    issues: isRecord(value.issues) ? value.issues as Record<string, AgentIssue> : {},
    recurringIssues: isRecord(value.recurringIssues) ? value.recurringIssues as Record<string, AgentRecurringIssue> : {},
    sessions: isRecord(value.sessions) ? value.sessions as Record<string, AgentSession> : {},
    sessionExecutions: isRecord(value.sessionExecutions) ? value.sessionExecutions as Record<string, AgentSessionExecutionBinding> : {},
    sessionStopIntents: isRecord(value.sessionStopIntents)
      ? value.sessionStopIntents as Record<string, AgentSessionStopIntent>
      : {},
    terminalDeliveries: isRecord(value.terminalDeliveries)
      ? value.terminalDeliveries as Record<string, AgentIssueTerminalDelivery>
      : {},
    activity: isRecord(value.activity) ? value.activity as Record<string, Activity> : {},
    activityOrder: Array.isArray(value.activityOrder) ? value.activityOrder.filter((id): id is string => typeof id === 'string') : [],
  };
}

function buildIssue(
  fields: IssueDraftFields,
  actor: ActorRef,
  now: number,
  origin?: AgentIssueOrigin,
  parentIssueId?: string,
): AgentIssue {
  return {
    id: `issue:${randomUUID()}`,
    ...(parentIssueId ? { parentIssueId } : {}),
    title: fields.title.trim(),
    ...(fields.description !== undefined ? { description: fields.description } : {}),
    status: DEFAULT_ISSUE_STATUS,
    ...(fields.delegate ? { delegate: fields.delegate } : {}),
    relations: fields.relations ?? [],
    trigger: fields.trigger ? normalizeIssueTrigger(fields.trigger) : { type: 'when-ready' },
    ...(fields.dueDate ? { dueDate: fields.dueDate } : {}),
    ...(fields.completionCriteria ? { completionCriteria: fields.completionCriteria } : {}),
    ...(fields.verificationPolicy ? { verificationPolicy: fields.verificationPolicy } : {}),
    ...(fields.evidence ? { evidence: fields.evidence } : {}),
    ...(fields.noteNodeIds ? { noteNodeIds: fields.noteNodeIds } : {}),
    ...(fields.input ? { input: fields.input } : {}),
    ...(fields.output ? { output: fields.output } : {}),
    permissionMode: fields.permissionMode ?? 'unattended',
    ...(fields.executionPolicy ? { executionPolicy: fields.executionPolicy } : {}),
    confirmation: { confirmedBy: actor, confirmedAt: now },
    ...(origin ? { origin } : {}),
    revision: revision(now),
    createdAt: now,
    updatedAt: now,
  };
}

function buildRecurringIssue(
  fields: RecurringIssueDraftFields,
  actor: ActorRef,
  now: number,
  origin?: Extract<AgentIssueOrigin, { type: 'conversation' }>,
): AgentRecurringIssue {
  const timeZone = normalizeRecurringIssueTimeZone(fields.timeZone) ?? fields.timeZone;
  return {
    id: `recurring-issue:${randomUUID()}`,
    ...(origin ? { origin } : {}),
    titleTemplate: fields.titleTemplate.trim(),
    ...(fields.descriptionTemplate !== undefined ? { descriptionTemplate: fields.descriptionTemplate } : {}),
    status: 'active',
    cadence: fields.cadence,
    timeZone,
    missedPolicy: fields.missedPolicy ?? { type: 'coalesce-latest' },
    issueTemplate: normalizeRecurringIssueTemplate(fields.issueTemplate),
    confirmation: { confirmedBy: actor, confirmedAt: now },
    nextMaterializationAt: nextRecurringIssueDueAfter(fields.cadence, timeZone, now) ?? undefined,
    revision: revision(now),
    createdAt: now,
    updatedAt: now,
  };
}

function issueFromRecurringIssue(
  recurringIssue: AgentRecurringIssue,
  windowStartAt: number,
  windowEndAt: number,
  now: number,
  skippedWindowCount = 0,
): AgentIssue {
  const template = recurringIssue.issueTemplate;
  const date = formatRecurringIssueWindowDate(windowStartAt, recurringIssue.timeZone);
  return {
    id: `issue:${randomUUID()}`,
    ...(recurringIssue.origin ? { origin: recurringIssue.origin } : {}),
    title: renderRecurringTemplate(recurringIssue.titleTemplate, date),
    ...(recurringIssue.descriptionTemplate !== undefined ? { description: renderRecurringTemplate(recurringIssue.descriptionTemplate, date) } : {}),
    status: DEFAULT_ISSUE_STATUS,
    ...(template.delegate ? { delegate: template.delegate } : {}),
    relations: template.relations ?? [],
    trigger: template.trigger ?? { type: 'when-ready' },
    recurrence: {
      recurringIssueId: recurringIssue.id,
      windowStartAt,
      windowEndAt,
      materializedAt: now,
      ...(skippedWindowCount > 0 ? { skippedWindowCount } : {}),
    },
    ...(template.completionCriteria ? { completionCriteria: template.completionCriteria } : {}),
    ...(template.verificationPolicy ? { verificationPolicy: template.verificationPolicy } : {}),
    ...(template.input ? { input: template.input } : {}),
    ...(template.output ? { output: template.output } : {}),
    permissionMode: template.permissionMode,
    confirmation: recurringIssue.confirmation,
    revision: revision(now),
    createdAt: now,
    updatedAt: now,
  };
}

function buildSession(
  issue: AgentIssue,
  input: AgentSessionStartInput,
  source: AgentSessionSource,
  now: number,
  resolveInput?: IssueInputResolver,
): AgentSession {
  const inputSnapshot = issue.input
    ? resolveInput?.(issue.input, issue, now) ?? { scope: issue.input, resolvedAt: now }
    : undefined;
  const purpose = input.purpose ?? 'execute';
  return {
    id: `agent-session:${randomUUID()}`,
    issueId: issue.id,
    delegate: purpose === 'verify'
      ? issue.verificationPolicy?.verifier ?? { type: 'default-agent', runProfile: 'verifier' }
      : issue.delegate ?? { type: 'default-agent' },
    purpose,
    state: 'pending',
    source,
    issueSnapshot: issue,
    ...(inputSnapshot ? { inputSnapshot } : {}),
    ...(issue.output ? { outputSnapshot: issue.output } : {}),
    executionPolicy: {
      ...baseSessionExecutionPolicy(issue, now),
      ...(input.executionPolicyOverride ?? {}),
    },
    ...(input.continuation ? { continuationOfAgentSessionId: input.continuation.previousAgentSessionId } : {}),
    revision: revision(now),
    createdAt: now,
    updatedAt: now,
  };
}

function preflightIssueCreate(
  state: AgentIssueStoreState,
  input: IssueCreateInput,
  options: {
    origin?: AgentIssueOrigin;
    authorizeChildScope?: ChildIssueScopeAuthorizer;
  },
): { validation: ValidationMessage[]; parentSession?: AgentSession } {
  if (input.issueType === 'issue') {
    const parentSession = options.origin?.type === 'agent-session'
      ? state.sessions[options.origin.agentSessionId]
      : undefined;
    if (options.origin?.type === 'agent-session' && (
      !parentSession
      || !state.issues[parentSession.issueId]
      || parentSession.state !== 'active'
      || !state.sessionExecutions[parentSession.id]
      || state.sessionStopIntents[parentSession.id] !== undefined
    )) {
      return {
        validation: [{
          path: 'origin',
          code: 'invalid_origin',
          message: 'An Agent Session origin must resolve to an active, execution-bound parent Session and Issue.',
        }],
      };
    }
    if (parentSession) {
      const scopeValidation = validateChildIssueScope(
        parentSession,
        {
          input: input.fields.input,
          output: input.fields.output,
          noteNodeIds: input.fields.noteNodeIds,
        },
        options.authorizeChildScope,
      );
      if (scopeValidation.length > 0) return { validation: scopeValidation };
    }
    return {
      validation: validateStoredRelations(
        state,
        input.fields.relations ?? [],
        undefined,
        'fields.relations',
      ),
      ...(parentSession ? { parentSession } : {}),
    };
  }

  if (options.origin && options.origin.type !== 'conversation') {
    return {
      validation: [{
        path: 'origin',
        code: 'invalid_origin',
        message: 'Recurring Issues can be created only from a visible conversation, not from an Agent Session.',
      }],
    };
  }
  return {
    validation: validateStoredRelations(
      state,
      input.fields.issueTemplate.relations ?? [],
      undefined,
      'fields.issueTemplate.relations',
    ),
  };
}

function validateChildSessionScope(
  state: AgentIssueStoreState,
  issue: AgentIssue,
  session: AgentSession,
  authorizeChildScope: ChildIssueScopeAuthorizer | undefined,
): ValidationMessage[] {
  if (issue.origin?.type !== 'agent-session') return [];
  const parentSession = state.sessions[issue.origin.agentSessionId];
  if (
    !parentSession
    || !parentSessionCanRouteChild(parentSession)
    || !state.sessionExecutions[parentSession.id]
    || state.sessionStopIntents[parentSession.id] !== undefined
  ) {
    return [{
      path: 'origin',
      code: 'invalid_origin',
      message: 'A child Issue requires a non-canceled, execution-bound parent Agent Session for routing and scope authority.',
    }];
  }
  return validateChildIssueScope(parentSession, {
    input: issue.input,
    resolvedInput: session.inputSnapshot,
    output: session.outputSnapshot ?? issue.output,
    noteNodeIds: issue.noteNodeIds,
  }, authorizeChildScope);
}

function parentSessionCanRouteChild(session: AgentSession): boolean {
  return session.state !== 'canceled';
}

function validateChildIssueScope(
  parentSession: AgentSession,
  definition: ChildIssueScopeDefinition,
  authorizeChildScope: ChildIssueScopeAuthorizer | undefined,
): ValidationMessage[] {
  if (authorizeChildScope) return authorizeChildScope(parentSession, definition);
  if (definition.input?.type === 'tag-query' || definition.input?.type === 'saved-query') {
    return [{
      path: 'input',
      code: 'child_scope_unverifiable',
      message: 'Dynamic child Issue input requires runtime scope authorization.',
    }];
  }
  const inputNodeIds = uniqueStrings([
    ...(definition.resolvedInput?.nodeIds ?? []),
    ...inputScopeAnchorNodeIds(definition.input),
  ]);
  const requestedReadNodeIds = uniqueStrings([
    ...(definition.noteNodeIds ?? []),
    ...inputNodeIds,
    ...issueOutputNodeIds(definition.output, inputNodeIds),
  ]);
  const requestedWriteNodeIds = uniqueStrings(issueWritableNodeIds(definition.output, inputNodeIds));
  const parentScope = agentSessionRunScope(parentSession).resources;
  const parentReadNodeIds = new Set(parentScope?.nodes ?? []);
  const parentWriteNodeIds = new Set(parentScope?.writableNodes ?? parentScope?.nodes ?? []);
  const outsideRead = requestedReadNodeIds.filter((nodeId) => !parentReadNodeIds.has(nodeId));
  const outsideWrite = requestedWriteNodeIds.filter((nodeId) => !parentWriteNodeIds.has(nodeId));
  return [
    ...(outsideRead.length > 0 ? [{
        path: 'input',
        code: 'child_scope_broadened',
        message: `Child Issue readable node scope cannot exceed parent Agent Session resources: ${outsideRead.join(', ')}.`,
      }] : []),
    ...(outsideWrite.length > 0 ? [{
        path: 'output',
        code: 'child_scope_broadened',
        message: `Child Issue writable node scope cannot exceed parent Agent Session output resources: ${outsideWrite.join(', ')}.`,
      }] : []),
  ];
}

function inputScopeAnchorNodeIds(input: IssueInputScope | undefined): string[] {
  if (!input) return [];
  switch (input.type) {
    case 'selected-nodes':
      return input.nodeIds;
    case 'node-children':
      return [input.nodeId];
    case 'none':
    case 'tag-query':
    case 'saved-query':
      return [];
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function applyIssueUpdateToState(
  state: AgentIssueStoreState,
  input: IssueUpdateInput,
  actor: ActorRef,
  now: number,
  options: {
    authorizeChildScope?: ChildIssueScopeAuthorizer;
    allowHumanReviewTransition?: boolean;
  },
): TenonAgentToolResult {
  const target = targetFromUpdateInput(input);
  const currentRevision = revisionForTarget(state, target);
  if (!currentRevision) {
    return {
      status: 'blocked',
      targets: [target],
      validation: [{ code: 'not_found', message: 'Target object was not found.' }],
    };
  }
  if (input.target.expectedRevision && input.target.expectedRevision !== currentRevision) {
    return {
      status: 'conflict',
      targets: [target],
      validation: [{ code: 'revision_mismatch', message: 'Target object changed since it was read.' }],
      revisions: [{ target, revision: currentRevision }],
    };
  }

  if (input.target.type === 'issue') {
    const issue = state.issues[input.target.id]!;
    const issueChange = input.change as IssueUpdateChange;
    if (
      issueChange.type === 'patch'
      && issueChange.patch.verificationPolicy !== undefined
      && reviewPolicyWasWeakened(issue.verificationPolicy, issueChange.patch.verificationPolicy)
      && actor.type !== 'user'
    ) {
      return {
        status: 'blocked',
        targets: [target],
        validation: [{
          path: 'change.patch.verificationPolicy',
          code: 'review_policy_downgrade_requires_user',
          message: 'Only a trusted user action can weaken an Issue review policy.',
        }],
        revisions: [{ target, revision: issue.revision }],
      };
    }
    if (
      issueChange.type === 'patch'
      && issueChange.patch.completionCriteria !== undefined
      && completionCriteriaWereWeakened(issue.completionCriteria, issueChange.patch.completionCriteria)
      && actor.type !== 'user'
    ) {
      return {
        status: 'blocked',
        targets: [target],
        validation: [{
          path: 'change.patch.completionCriteria',
          code: 'completion_criteria_downgrade_requires_user',
          message: 'Only a trusted user action can remove or waive an existing Issue completion criterion.',
        }],
        revisions: [{ target, revision: issue.revision }],
      };
    }
    if (issueChange.type === 'patch' && issueChange.patch.relations !== undefined) {
      const relationValidation = validateStoredRelations(
        state,
        issueChange.patch.relations,
        issue.id,
        'change.patch.relations',
      );
      if (relationValidation.length > 0) {
        return {
          status: 'blocked',
          targets: [target],
          validation: relationValidation,
          revisions: [{ target, revision: issue.revision }],
        };
      }
    }
    if (
      issueChange.type === 'patch'
      && issue.origin?.type === 'agent-session'
      && (
        issueChange.patch.input !== undefined
        || issueChange.patch.output !== undefined
        || issueChange.patch.noteNodeIds !== undefined
      )
    ) {
      const parentSession = state.sessions[issue.origin.agentSessionId];
      const parentAvailable = parentSession
        && parentSessionCanRouteChild(parentSession)
        && state.sessionExecutions[parentSession.id]
        && state.sessionStopIntents[parentSession.id] === undefined;
      const scopeValidation = parentAvailable
        ? validateChildIssueScope(parentSession, {
            input: issueChange.patch.input ?? issue.input,
            output: issueChange.patch.output ?? issue.output,
            noteNodeIds: issueChange.patch.noteNodeIds ?? issue.noteNodeIds,
          }, options.authorizeChildScope)
        : [{
            path: 'origin',
            code: 'invalid_origin',
            message: 'Child Issue scope cannot change after its parent Agent Session is unavailable.',
          }];
      if (scopeValidation.length > 0) {
        return {
          status: 'blocked',
          targets: [target],
          validation: scopeValidation,
          revisions: [{ target, revision: issue.revision }],
        };
      }
    }
    const validation = applyIssueChange(
      state,
      issue,
      issueChange,
      actor,
      now,
      options.allowHumanReviewTransition === true,
    );
    return validation.length > 0
      ? {
          status: 'blocked',
          targets: [target],
          validation,
          revisions: [{ target, revision: issue.revision }],
        }
      : state.issues[input.target.id]?.revision
        ? { status: 'applied', targets: [target], revisions: [{ target, revision: state.issues[input.target.id]!.revision }] }
        : { status: 'applied', targets: [target] };
  }

  const recurringIssue = state.recurringIssues[input.target.id]!;
  const recurringChange = input.change as RecurringIssueUpdateChange;
  if (
    recurringChange.type === 'patch'
    && recurringChange.patch.issueTemplate !== undefined
    && reviewPolicyWasWeakened(
      recurringIssue.issueTemplate.verificationPolicy,
      recurringChange.patch.issueTemplate.verificationPolicy,
    )
    && actor.type !== 'user'
  ) {
    return {
      status: 'blocked',
      targets: [target],
      validation: [{
        path: 'change.patch.issueTemplate.verificationPolicy',
        code: 'review_policy_downgrade_requires_user',
        message: 'Only a trusted user action can weaken a Recurring Issue review policy.',
      }],
      revisions: [{ target, revision: recurringIssue.revision }],
    };
  }
  if (
    recurringChange.type === 'patch'
    && recurringChange.patch.issueTemplate !== undefined
    && completionCriteriaWereWeakened(
      recurringIssue.issueTemplate.completionCriteria,
      recurringChange.patch.issueTemplate.completionCriteria,
    )
    && actor.type !== 'user'
  ) {
    return {
      status: 'blocked',
      targets: [target],
      validation: [{
        path: 'change.patch.issueTemplate.completionCriteria',
        code: 'completion_criteria_downgrade_requires_user',
        message: 'Only a trusted user action can remove or waive an existing recurring Issue completion criterion.',
      }],
      revisions: [{ target, revision: recurringIssue.revision }],
    };
  }
  if (
    recurringChange.type === 'patch'
    && recurringChange.patch.issueTemplate?.relations !== undefined
  ) {
    const relationValidation = validateStoredRelations(
      state,
      recurringChange.patch.issueTemplate.relations,
      undefined,
      'change.patch.issueTemplate.relations',
    );
    if (relationValidation.length > 0) {
      return {
        status: 'blocked',
        targets: [target],
        validation: relationValidation,
        revisions: [{ target, revision: recurringIssue.revision }],
      };
    }
  }
  const validation = applyRecurringIssueChange(
    state,
    recurringIssue,
    recurringChange,
    actor,
    now,
  );
  return validation.length > 0
    ? {
        status: 'blocked',
        targets: [target],
        validation,
        revisions: [{ target, revision: recurringIssue.revision }],
      }
    : state.recurringIssues[input.target.id]?.revision
      ? { status: 'applied', targets: [target], revisions: [{ target, revision: state.recurringIssues[input.target.id]!.revision }] }
      : { status: 'applied', targets: [target] };
}

function applyIssueChange(
  state: AgentIssueStoreState,
  issue: AgentIssue,
  change: IssueUpdateChange,
  actor: ActorRef,
  now: number,
  allowHumanReviewTransition: boolean,
): ValidationMessage[] {
  switch (change.type) {
    case 'patch': {
      if ('status' in change.patch) {
        return [{
          path: 'change.patch.status',
          code: 'status_patch_not_allowed',
          message: 'Issue status changes must use an explicit lifecycle transition.',
        }];
      }
      const { dueDate, trigger, ...patch } = change.patch;
      Object.assign(issue, patch);
      if (dueDate === null) delete issue.dueDate;
      else if (dueDate !== undefined) issue.dueDate = dueDate;
      if (trigger !== undefined) issue.trigger = normalizeIssueTrigger(trigger);
      appendActivity(state, activityInput({ type: 'issue', issueId: issue.id }, actor, { type: 'updated', fields: Object.keys(change.patch) }, now));
      break;
    }
    case 'transition': {
      if (issue.status.category === 'completed' || issue.status.category === 'canceled') {
        if (change.status.category === issue.status.category) return [];
        return [{
          code: 'terminal_issue',
          message: 'Completed or canceled Issues cannot transition back into an active lifecycle state.',
        }];
      }
      if (change.status.category === 'completed') {
        const verificationMode = issue.verificationPolicy?.mode ?? 'none';
        if (
          verificationMode === 'human-review'
          && (!allowHumanReviewTransition || actor.type !== 'user')
        ) {
          return [{
            code: 'human_review_confirmation_required',
            message: 'A human-review Issue can be completed only from an authorized visible-conversation transition.',
          }];
        }
        const verificationSatisfied = verificationMode !== 'agent-review'
          || issueHasAcceptedVerification(issue, state);
        if (!verificationSatisfied) {
          return [{
            code: 'verification_required',
            message: 'An agent-review Issue requires an accepted verifier result before completion.',
          }];
        }
        const evidenceSession = latestCompletedExecutionSession(state, issue.id);
        if (verificationMode === 'human-review' && !evidenceSession) {
          return [{
            code: 'human_review_execution_required',
            message: 'Human review can complete an Issue only after an execution Agent Session has completed.',
          }];
        }
        const finalized = finalizeIssue(state, issue.id, {
          actor,
          now,
          evidenceSession,
          allowHumanReview: allowHumanReviewTransition,
          verificationSatisfied,
        });
        return finalized.validation;
      }
      if (change.status.category === 'canceled' && issueHasActiveSession(issue, state)) {
        return [{
          code: 'active_session_exists',
          message: 'An Issue with an active Agent Session cannot be canceled. Stop the Agent Session first.',
        }];
      }
      if (change.status.category === 'canceled') {
        const childValidation = issueOutstandingChildValidation(issue, state);
        if (childValidation.length > 0) return childValidation;
      }
      appendActivity(state, activityInput({ type: 'issue', issueId: issue.id }, actor, { type: 'status-change', from: issue.status.name, to: change.status.name }, now));
      issue.status = change.status;
      if (change.status.category === 'canceled') issue.terminalAt = now;
      if (change.status.category === 'canceled' && issue.origin?.type === 'agent-session') {
        enqueueIssueCancellationDelivery(state, issue, now);
      }
      break;
    }
    case 'archive':
      issue.archivedAt = now;
      appendActivity(state, activityInput({ type: 'issue', issueId: issue.id }, actor, { type: 'archived' }, now));
      break;
    case 'delete': {
      if (Object.values(state.issues).some((candidate) => candidate.parentIssueId === issue.id)) {
        return [{ code: 'child_issues_exist', message: 'An Issue with child Issues cannot be deleted.' }];
      }
      if (Object.values(state.issues).some((candidate) => (
        candidate.id !== issue.id
        && candidate.relations.some((relation) => relation.issueId === issue.id)
      )) || Object.values(state.recurringIssues).some((candidate) => (
        candidate.issueTemplate.relations?.some((relation) => relation.issueId === issue.id) ?? false
      ))) {
        return [{
          code: 'issue_is_referenced',
          message: 'An Issue referenced by another Issue relation or Recurring Issue template cannot be deleted.',
        }];
      }
      if (issueHasActiveSession(issue, state)) {
        return [{ code: 'active_session_exists', message: 'An Issue with an active Agent Session cannot be deleted.' }];
      }
      if (
        issue.origin?.type === 'agent-session'
        && issue.status.category !== 'completed'
        && issue.status.category !== 'canceled'
      ) {
        return [{
          code: 'child_issue_not_terminal',
          message: 'A child Issue must complete or be canceled and notify its parent Agent Session before deletion.',
        }];
      }
      if (Object.values(state.terminalDeliveries).some((delivery) => (
        delivery.issueId === issue.id && delivery.status !== 'delivered'
      ))) {
        return [{
          code: 'pending_terminal_delivery',
          message: 'An Issue cannot be deleted while its terminal result is still pending delivery.',
        }];
      }
      delete state.issues[issue.id];
      appendActivity(state, activityInput({ type: 'issue', issueId: issue.id }, actor, { type: 'deleted' }, now));
      return [];
    }
  }
  issue.updatedAt = now;
  issue.revision = revision(now);
  return [];
}

function applyRecurringIssueChange(
  state: AgentIssueStoreState,
  recurringIssue: AgentRecurringIssue,
  change: RecurringIssueUpdateChange,
  actor: ActorRef,
  now: number,
): ValidationMessage[] {
  switch (change.type) {
    case 'patch': {
      const scheduleChanged = change.patch.cadence !== undefined || change.patch.timeZone !== undefined;
      const nextTimeZone = normalizeRecurringIssueTimeZone(change.patch.timeZone ?? recurringIssue.timeZone);
      const validation = validateRecurringIssueSchedule(
        change.patch.cadence ?? recurringIssue.cadence,
        change.patch.timeZone ?? recurringIssue.timeZone,
      );
      if (validation.length > 0) return validation;
      const patch = change.patch.issueTemplate
        ? { ...change.patch, issueTemplate: normalizeRecurringIssueTemplate(change.patch.issueTemplate) }
        : change.patch;
      Object.assign(recurringIssue, patch, scheduleChanged ? { timeZone: nextTimeZone! } : {});
      if (scheduleChanged) {
        recurringIssue.nextMaterializationAt = recurringIssue.status === 'archived'
          ? undefined
          : nextRecurringIssueDueAfter(recurringIssue.cadence, recurringIssue.timeZone, now) ?? undefined;
      }
      appendActivity(state, activityInput({ type: 'recurring-issue', recurringIssueId: recurringIssue.id }, actor, { type: 'updated', fields: Object.keys(change.patch) }, now));
      break;
    }
    case 'pause':
      if (recurringIssue.status !== 'active' || recurringIssue.archivedAt !== undefined) {
        return [{ code: 'invalid_state', message: 'Only an active Recurring Issue can be paused.' }];
      }
      recurringIssue.status = 'paused';
      appendActivity(state, activityInput({ type: 'recurring-issue', recurringIssueId: recurringIssue.id }, actor, { type: 'status-change', to: 'paused' }, now));
      break;
    case 'resume':
      if (recurringIssue.status !== 'paused' || recurringIssue.archivedAt !== undefined) {
        return [{ code: 'invalid_state', message: 'Only a paused Recurring Issue can be resumed.' }];
      }
      recurringIssue.status = 'active';
      recurringIssue.nextMaterializationAt = nextRecurringIssueDueAfter(
        recurringIssue.cadence,
        recurringIssue.timeZone,
        now,
      ) ?? undefined;
      appendActivity(state, activityInput({ type: 'recurring-issue', recurringIssueId: recurringIssue.id }, actor, { type: 'status-change', to: 'active' }, now));
      break;
    case 'skip-next':
      {
        if (recurringIssue.status !== 'active' || recurringIssue.archivedAt !== undefined) {
          return [{ code: 'invalid_state', message: 'Only an active Recurring Issue can skip its next window.' }];
        }
        const skippedAt = recurringIssue.nextMaterializationAt ?? nextRecurringIssueDueAfter(
          recurringIssue.cadence,
          recurringIssue.timeZone,
          now,
        );
        if (skippedAt !== null && skippedAt !== undefined) {
          recurringIssue.skippedMaterializationAts = uniqueNumbers([...(recurringIssue.skippedMaterializationAts ?? []), skippedAt]);
          recurringIssue.nextMaterializationAt = nextRecurringIssueDueAfter(
            recurringIssue.cadence,
            recurringIssue.timeZone,
            skippedAt,
          ) ?? undefined;
        }
        appendActivity(state, activityInput(
          { type: 'recurring-issue', recurringIssueId: recurringIssue.id },
          actor,
          { type: 'agent-action', action: 'skip-next', parameter: skippedAt !== null && skippedAt !== undefined ? String(skippedAt) : undefined, result: 'recorded' },
          now,
        ));
      }
      break;
    case 'archive':
      if (recurringIssue.status === 'archived' || recurringIssue.archivedAt !== undefined) {
        return [{ code: 'invalid_state', message: 'Recurring Issue is already archived.' }];
      }
      recurringIssue.status = 'archived';
      recurringIssue.archivedAt = now;
      recurringIssue.nextMaterializationAt = undefined;
      appendActivity(state, activityInput({ type: 'recurring-issue', recurringIssueId: recurringIssue.id }, actor, { type: 'status-change', to: 'archived' }, now));
      break;
    case 'delete':
      delete state.recurringIssues[recurringIssue.id];
      appendActivity(state, activityInput({ type: 'recurring-issue', recurringIssueId: recurringIssue.id }, actor, { type: 'deleted' }, now));
      return [];
  }
  recurringIssue.updatedAt = now;
  recurringIssue.revision = revision(now);
  return [];
}

function updateNextMaterializationAt(
  recurringIssue: AgentRecurringIssue,
  nextMaterializationAt: number | undefined,
  now: number,
): void {
  if (recurringIssue.nextMaterializationAt === nextMaterializationAt) return;
  recurringIssue.nextMaterializationAt = nextMaterializationAt;
  recurringIssue.updatedAt = now;
  recurringIssue.revision = revision(now);
}

function readFromState(state: AgentIssueStoreState, input: IssueReadInput): IssueReadResult {
  if (input.target.type === 'issue') {
    const issue = state.issues[input.target.id];
    return {
      target: input.target,
      ...(issue ? { issue } : {}),
      ...(issue && input.include?.includes('activity') ? { activity: issueActivity(state, issue) } : {}),
      ...(issue && input.include?.includes('sessions') ? { sessions: Object.values(state.sessions).filter((session) => session.issueId === issue.id) } : {}),
      ...(issue && input.include?.includes('child-issues') ? {
        childIssues: Object.values(state.issues).filter((candidate) => candidate.parentIssueId === issue.id),
      } : {}),
    };
  }

  const recurringIssue = state.recurringIssues[input.target.id];
  return {
    target: input.target,
    ...(recurringIssue ? { recurringIssue } : {}),
    ...(recurringIssue && input.include?.includes('activity') ? { activity: activityForTarget(state, { type: 'recurring-issue', recurringIssueId: recurringIssue.id }) } : {}),
    ...(recurringIssue && input.include?.includes('generated-issues') ? {
      generatedIssues: Object.values(state.issues).filter((issue) => issue.recurrence?.recurringIssueId === recurringIssue.id),
    } : {}),
  };
}

function matchesIssue(issue: AgentIssue, state: AgentIssueStoreState, input: IssueSearchInput): boolean {
  const filter = input.filter;
  if (input.text && !textMatches(issueSearchTextValues(issue, state), input.text)) return false;
  if (filter?.recurringIssueIds !== undefined) return false;
  if (filter?.cadence !== undefined) return false;
  if (filter?.nextMaterializationAt !== undefined) return false;
  if (filter?.ids && !filter.ids.includes(issue.id)) return false;
  if (filter?.issueIds && !filter.issueIds.includes(issue.id)) return false;
  if (filter?.parentIssueIds && (!issue.parentIssueId || !filter.parentIssueIds.includes(issue.parentIssueId))) return false;
  if (filter?.hasParentIssue !== undefined && Boolean(issue.parentIssueId) !== filter.hasParentIssue) return false;
  if (filter?.delegateIds && !agentRefMatches(issue.delegate, filter.delegateIds)) return false;
  if (filter?.statusCategories && !filter.statusCategories.includes(issue.status.category) && !derivedIssueBuckets(issue, state).some((bucket) => filter.statusCategories!.includes(bucket))) return false;
  if (filter?.triggerTypes && !filter.triggerTypes.includes(issue.trigger.type)) return false;
  if (filter?.relation && !issue.relations.some((relation) => (
    relation.type === filter.relation!.type
    && (filter.relation!.issueId === undefined || relation.issueId === filter.relation!.issueId)
  ))) return false;
  if (filter?.archived !== undefined && Boolean(issue.archivedAt) !== filter.archived) return false;
  if (filter?.hasActiveSession !== undefined && issueHasActiveSession(issue, state) !== filter.hasActiveSession) return false;
  if (filter?.needsAttention !== undefined && issueNeedsAttention(issue, state) !== filter.needsAttention) return false;
  if (filter?.dueDate && !timeInRange(issue.dueDate?.targetAt, filter.dueDate)) return false;
  if (filter?.createdAt && !timeInRange(issue.createdAt, filter.createdAt)) return false;
  if (filter?.updatedAt && !timeInRange(issue.updatedAt, filter.updatedAt)) return false;
  if (filter?.terminalAt && !timeInRange(issue.terminalAt, filter.terminalAt)) return false;
  if (filter?.inputNodeIds && !inputScopeMatchesNodeIds(issue.input, filter.inputNodeIds)) return false;
  if (filter?.inputTags && !inputScopeMatchesTags(issue.input, filter.inputTags)) return false;
  if (filter?.sessionState) {
    const sessions = Object.values(state.sessions).filter((session) => session.issueId === issue.id);
    if (!sessions.some((session) => filter.sessionState!.includes(session.state))) return false;
  }
  if (filter?.activityTypes && !issueActivity(state, issue).some((activity) => filter.activityTypes!.includes(activity.content.type))) return false;
  if (filter?.activityTarget && !issueMatchesActivityTarget(state, issue, filter.activityTarget)) return false;
  return true;
}

function matchesRecurringIssue(recurringIssue: AgentRecurringIssue, input: IssueSearchInput, state?: AgentIssueStoreState): boolean {
  const filter = input.filter;
  if (input.text && !textMatches(recurringIssueSearchTextValues(recurringIssue, state), input.text)) return false;
  if (filter?.issueIds !== undefined) return false;
  if (filter?.parentIssueIds !== undefined) return false;
  if (filter?.hasParentIssue !== undefined) return false;
  if (filter?.dueDate !== undefined) return false;
  if (filter?.relation !== undefined) return false;
  if (filter?.hasActiveSession !== undefined) return false;
  if (filter?.needsAttention !== undefined) return false;
  if (filter?.sessionState !== undefined) return false;
  if (filter?.ids && !filter.ids.includes(recurringIssue.id)) return false;
  if (filter?.recurringIssueIds && !filter.recurringIssueIds.includes(recurringIssue.id)) return false;
  if (filter?.delegateIds && !agentRefMatches(recurringIssue.issueTemplate.delegate, filter.delegateIds)) return false;
  if (filter?.statusCategories && !derivedRecurringIssueBuckets(recurringIssue).some((bucket) => filter.statusCategories!.includes(bucket))) return false;
  if (filter?.triggerTypes && !filter.triggerTypes.includes((recurringIssue.issueTemplate.trigger ?? { type: 'when-ready' }).type)) return false;
  if (filter?.cadence && !filter.cadence.includes(recurringIssue.cadence.type)) return false;
  if (filter?.archived !== undefined && Boolean(recurringIssue.archivedAt || recurringIssue.status === 'archived') !== filter.archived) return false;
  if (filter?.nextMaterializationAt && !timeInRange(recurringIssue.nextMaterializationAt, filter.nextMaterializationAt)) return false;
  if (filter?.createdAt && !timeInRange(recurringIssue.createdAt, filter.createdAt)) return false;
  if (filter?.updatedAt && !timeInRange(recurringIssue.updatedAt, filter.updatedAt)) return false;
  if (filter?.terminalAt !== undefined) return false;
  if (filter?.inputNodeIds && !inputScopeMatchesNodeIds(recurringIssue.issueTemplate.input, filter.inputNodeIds)) return false;
  if (filter?.inputTags && !inputScopeMatchesTags(recurringIssue.issueTemplate.input, filter.inputTags)) return false;
  if (filter?.activityTypes && state && !recurringIssueActivity(state, recurringIssue).some((activity) => filter.activityTypes!.includes(activity.content.type))) return false;
  if (filter?.activityTarget && !sameActivityTarget(filter.activityTarget, { type: 'recurring-issue', recurringIssueId: recurringIssue.id })) return false;
  return true;
}

function derivedIssueBuckets(issue: AgentIssue, state: AgentIssueStoreState): IssueViewBucket[] {
  const buckets: IssueViewBucket[] = [];
  if (issue.archivedAt) buckets.push('archived');
  const terminal = issue.status.category === 'completed' || issue.status.category === 'canceled';
  if (!terminal && !issue.archivedAt && issue.trigger.type === 'scheduled') buckets.push('scheduled');
  if (terminal || issue.archivedAt) return buckets;
  if (unresolvedBlockingIssueIds(issue, state).length > 0) buckets.push('blocked');
  const latestSession = latestSessionForIssue(issue, state);
  if (
    latestSession && (
      latestSession.state === 'error'
      || latestSession.state === 'stale'
      || Boolean(latestSession.errorMessage)
    )
    || issueHasRejectedVerification(issue, state)
    || issueAwaitsHumanReview(issue, state)
    || (issue.executionPolicy !== undefined && issue.executionPolicy.deadlineAt <= Date.now())
  ) buckets.push('attention-needed');
  return buckets;
}

function issueHasRejectedVerification(issue: AgentIssue, state: AgentIssueStoreState): boolean {
  if (issue.status.category === 'completed' || issue.status.category === 'canceled') return false;
  const latestResult = latestIssueVerificationResult(issue, state);
  if (!latestResult || latestResult.content.type !== 'verification-result') return false;
  return !verifierVerdictAccepted(
    issue.verificationPolicy,
    latestResult.content.verdict,
    verificationResultEvaluationText(state, latestResult),
  );
}

function issueHasAcceptedVerification(issue: AgentIssue, state: AgentIssueStoreState): boolean {
  const latestResult = latestIssueVerificationResult(issue, state);
  return Boolean(
    latestResult
    && latestResult.content.type === 'verification-result'
    && verifierVerdictAccepted(
      issue.verificationPolicy,
      latestResult.content.verdict,
      verificationResultEvaluationText(state, latestResult),
    )
  );
}

function verificationResultEvaluationText(
  state: AgentIssueStoreState,
  activity: Activity,
): string {
  if (activity.content.type !== 'verification-result') return '';
  const verifierSessionId = activity.content.agentSessionId;
  return (verifierSessionId ? state.sessions[verifierSessionId]?.latestOutput : undefined)
    ?? activity.content.body;
}

function issueAwaitsHumanReview(issue: AgentIssue, state: AgentIssueStoreState): boolean {
  return issue.verificationPolicy?.mode === 'human-review'
    && Boolean(latestCompletedExecutionSession(state, issue.id));
}

function latestIssueVerificationResult(issue: AgentIssue, state: AgentIssueStoreState): Activity | undefined {
  return sortActivityDescending(issueActivity(state, issue))
    .find((activity) => activity.content.type === 'verification-result');
}

function derivedRecurringIssueBuckets(recurringIssue: AgentRecurringIssue): IssueViewBucket[] {
  const buckets: IssueViewBucket[] = [];
  if (recurringIssue.archivedAt || recurringIssue.status === 'archived') buckets.push('archived');
  if (recurringIssue.nextMaterializationAt !== undefined) buckets.push('scheduled');
  return buckets;
}

function isIssueReadyForExecution(issue: AgentIssue, state: AgentIssueStoreState, now: number): boolean {
  if (issue.archivedAt) return false;
  if (issue.status.category === 'completed' || issue.status.category === 'canceled') return false;
  if (issue.input?.type === 'saved-query') return false;
  if (issue.output?.type === 'daily-note') return false;
  if (issue.executionPolicy && issue.executionPolicy.deadlineAt <= now) return false;
  if (issueHasAnySession(issue, state)) return false;
  if (unresolvedBlockingIssueIds(issue, state).length > 0) return false;
  if (issue.trigger.type === 'when-ready') return true;
  return issue.trigger.startAt <= now;
}

function validateSessionStart(
  state: AgentIssueStoreState,
  issue: AgentIssue,
  input: AgentSessionStartInput,
  now: number,
): ValidationMessage[] {
  const messages: ValidationMessage[] = [];
  if (issue.archivedAt) {
    messages.push({ code: 'archived_issue', message: 'Archived Issues cannot start Agent Sessions.' });
  }
  if (issue.status.category === 'completed' || issue.status.category === 'canceled') {
    messages.push({ code: 'terminal_issue', message: 'Completed or canceled Issues cannot start new Agent Sessions.' });
  }
  if (input.purpose === 'verify' && issue.verificationPolicy?.mode !== 'agent-review') {
    messages.push({ code: 'missing_agent_review_policy', message: 'Verifier Agent Sessions require an agent-review verification policy.' });
  }
  if (issue.input?.type === 'saved-query') {
    messages.push({
      path: 'input',
      code: 'saved_query_not_supported',
      message: 'Saved-query Issue inputs cannot start an Agent Session until saved-query resolution is implemented.',
    });
  }
  if (issue.output?.type === 'daily-note') {
    messages.push({
      path: 'output',
      code: 'daily_note_output_not_supported',
      message: 'Daily-note output cannot start an Agent Session until its concrete destination is resolved into the Session scope.',
    });
  }
  messages.push(...validateSessionExecutionPolicyOverride(issue, input, now));
  if (issueHasActiveSession(issue, state)) {
    messages.push({ code: 'active_session_exists', message: 'Issue already has a pending or active Agent Session.' });
  }
  for (const blockerId of unresolvedBlockingIssueIds(issue, state)) {
    messages.push({ code: 'blocked_by_issue', message: `Issue is blocked by ${blockerId}.` });
  }
  messages.push(...issueOutstandingChildValidation(issue, state));
  const continuation = input.continuation;
  if (continuation) {
    if (typeof continuation.previousAgentSessionId !== 'string' || !continuation.previousAgentSessionId.trim()) {
      messages.push({
        path: 'continuation.previousAgentSessionId',
        code: 'required_field',
        message: 'Continuation previousAgentSessionId is required.',
      });
    }
    if (!['continue', 'retry', 'revise'].includes(continuation.intent)) {
      messages.push({
        path: 'continuation.intent',
        code: 'required_field',
        message: 'Continuation intent must be continue, retry, or revise.',
      });
    }
    if (messages.some((entry) => entry.path?.startsWith('continuation.'))) return messages;
    const previous = state.sessions[continuation.previousAgentSessionId];
    if (!previous) {
      messages.push({ code: 'previous_session_not_found', message: 'Previous Agent Session was not found for continuation.' });
    } else {
      if (previous.issueId !== issue.id) {
        messages.push({ code: 'previous_session_issue_mismatch', message: 'Continuation Agent Session must belong to the same Issue.' });
      }
      if (!isTerminalSessionState(previous.state)) {
        messages.push({ code: 'previous_session_not_terminal', message: 'Only terminal Agent Sessions can be continued with a new Agent Session.' });
      }
    }
  }
  return messages;
}

function baseSessionExecutionPolicy(issue: AgentIssue, now: number): AgentExecutionPolicy {
  return issue.executionPolicy ?? {
    deadlineAt: now + 60 * 60 * 1000,
  };
}

function validateSessionExecutionPolicyOverride(
  issue: AgentIssue,
  input: AgentSessionStartInput,
  now: number,
): ValidationMessage[] {
  const override = input.executionPolicyOverride;
  const base = baseSessionExecutionPolicy(issue, now);
  const messages: ValidationMessage[] = [];
  if (base.deadlineAt <= now) {
    messages.push({
      code: 'execution_deadline_elapsed',
      path: 'executionPolicy.deadlineAt',
      message: 'Agent Session cannot start after the Issue execution deadline.',
    });
  }
  if (!override) return messages;
  if (
    override.deadlineAt !== undefined
    && (!Number.isFinite(override.deadlineAt) || override.deadlineAt <= now)
  ) {
    messages.push({
      code: 'execution_deadline_elapsed',
      path: 'executionPolicyOverride.deadlineAt',
      message: 'Agent Session deadline overrides must be finite and later than the start time.',
    });
  }
  if (override.deadlineAt !== undefined && override.deadlineAt > base.deadlineAt) {
    messages.push({
      code: 'execution_policy_broadened',
      path: 'executionPolicyOverride.deadlineAt',
      message: 'Agent Session deadline overrides may only keep or shorten the Issue execution deadline.',
    });
  }
  return messages;
}

function issueHasActiveSession(issue: AgentIssue, state: AgentIssueStoreState): boolean {
  return Object.values(state.sessions).some((session) => (
    session.issueId === issue.id
    && isActiveAgentSessionState(session.state)
  ));
}

function issueHasAnySession(issue: AgentIssue, state: AgentIssueStoreState): boolean {
  return Object.values(state.sessions).some((session) => session.issueId === issue.id);
}

function isBlockingIssueResolved(issue: AgentIssue | undefined): boolean {
  return Boolean(issue && (issue.status.category === 'completed' || issue.status.category === 'canceled'));
}

function unresolvedBlockingIssueIds(
  issue: AgentIssue,
  state: AgentIssueStoreState,
): string[] {
  const blockerIds = new Set<string>();
  for (const relation of issue.relations) {
    if (relation.type === 'blocked-by' && !isBlockingIssueResolved(state.issues[relation.issueId])) {
      blockerIds.add(relation.issueId);
    }
  }
  for (const candidate of Object.values(state.issues)) {
    if (candidate.id === issue.id || isBlockingIssueResolved(candidate)) continue;
    if (candidate.relations.some((relation) => relation.type === 'blocks' && relation.issueId === issue.id)) {
      blockerIds.add(candidate.id);
    }
  }
  return [...blockerIds];
}

function issueOutstandingChildValidation(
  issue: AgentIssue,
  state: AgentIssueStoreState,
): ValidationMessage[] {
  const incompleteChildren = Object.values(state.issues).filter((candidate) => (
    candidate.parentIssueId === issue.id
    && candidate.status.category !== 'completed'
    && candidate.status.category !== 'canceled'
  ));
  if (incompleteChildren.length > 0) {
    return [{
      code: 'incomplete_child_issues',
      message: `Issue still has ${incompleteChildren.length} incomplete child Issue${incompleteChildren.length === 1 ? '' : 's'}.`,
    }];
  }
  const pendingChildDeliveries = Object.values(state.terminalDeliveries).filter((delivery) => {
    if (delivery.status === 'delivered' || delivery.origin.type !== 'agent-session') return false;
    return state.sessions[delivery.origin.agentSessionId]?.issueId === issue.id;
  });
  if (pendingChildDeliveries.length > 0) {
    return [{
      code: 'pending_child_deliveries',
      message: `Issue still has ${pendingChildDeliveries.length} child result${pendingChildDeliveries.length === 1 ? '' : 's'} awaiting parent-session delivery.`,
    }];
  }
  return [];
}

function issueNeedsAttention(issue: AgentIssue, state: AgentIssueStoreState): boolean {
  if (
    issue.archivedAt
    || issue.status.category === 'completed'
    || issue.status.category === 'canceled'
  ) return false;
  return derivedIssueBuckets(issue, state).includes('attention-needed')
    || unresolvedBlockingIssueIds(issue, state).length > 0;
}

function latestSessionForIssue(issue: AgentIssue, state: AgentIssueStoreState): AgentSession | undefined {
  return Object.values(state.sessions)
    .filter((session) => session.issueId === issue.id)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

function issueViewBuckets(issue: AgentIssue, state: AgentIssueStoreState): IssueViewBucket[] {
  return [...new Set([issue.status.category, ...derivedIssueBuckets(issue, state)])];
}

function triggerSortTime(issue: AgentIssue): number {
  return issue.trigger.type === 'scheduled' ? issue.trigger.startAt : issue.createdAt;
}

function issueRow(issue: AgentIssue, state: AgentIssueStoreState, input: IssueSearchInput): IssueSearchRow {
  const activity = input.include?.includes('activity-summary')
    ? sortActivityDescending(issueActivity(state, issue).filter(isUserVisibleIssueActivity))
    : undefined;
  const latestSession = latestSessionForIssue(issue, state);
  const includeSessionSummary = input.include?.includes('session-summary') === true;
  return {
    target: { type: 'issue', id: issue.id },
    ...(issue.parentIssueId ? { parentIssueId: issue.parentIssueId } : {}),
    title: issue.title,
    status: issue.status.name,
    statusCategory: issue.status.category,
    viewBuckets: issueViewBuckets(issue, state),
    trigger: issue.trigger,
    ...(issue.dueDate ? { dueDate: issue.dueDate } : {}),
    ...(includeSessionSummary ? {
      hasActiveSession: issueHasActiveSession(issue, state),
      needsAttention: issueNeedsAttention(issue, state),
    } : {}),
    ...(includeSessionSummary && latestSession ? {
      latestSessionState: latestSession.state,
      latestSessionUpdatedAt: latestSession.updatedAt,
    } : {}),
    revision: issue.revision,
    updatedAt: issue.updatedAt,
    ...(issue.terminalAt !== undefined ? { terminalAt: issue.terminalAt } : {}),
    ...(activity ? { latestActivity: activity[0], activityCount: activity.length } : {}),
  };
}

function recurringIssueRow(
  recurringIssue: AgentRecurringIssue,
  state: AgentIssueStoreState,
  input: IssueSearchInput,
): IssueSearchRow {
  const activity = input.include?.includes('activity-summary')
    ? sortActivityDescending(recurringIssueActivity(state, recurringIssue).filter(isUserVisibleIssueActivity))
    : undefined;
  return {
    target: { type: 'recurring-issue', id: recurringIssue.id },
    title: recurringIssue.titleTemplate,
    status: recurringIssue.status,
    viewBuckets: derivedRecurringIssueBuckets(recurringIssue),
    cadence: recurringIssue.cadence,
    ...(recurringIssue.nextMaterializationAt !== undefined ? { nextMaterializationAt: recurringIssue.nextMaterializationAt } : {}),
    revision: recurringIssue.revision,
    updatedAt: recurringIssue.updatedAt,
    ...(activity ? { latestActivity: activity[0], activityCount: activity.length } : {}),
  };
}

function searchRowSortTime(row: IssueSearchRow, input: IssueSearchInput): number {
  return input.include?.includes('activity-summary')
    ? row.latestActivity?.createdAt ?? row.updatedAt
    : row.updatedAt;
}

function compareSearchRows(
  left: IssueSearchRow,
  right: IssueSearchRow,
  input: IssueSearchInput,
  state: AgentIssueStoreState,
): number {
  for (const order of input.orderBy ?? []) {
    const diff = compareSearchRowField(left, right, order.field, order.direction ?? 'desc', state);
    if (diff !== 0) return diff;
  }
  return searchRowSortTime(right, input) - searchRowSortTime(left, input)
    || left.title.localeCompare(right.title);
}

function compareSearchRowField(
  left: IssueSearchRow,
  right: IssueSearchRow,
  field: NonNullable<IssueSearchInput['orderBy']>[number]['field'],
  direction: NonNullable<NonNullable<IssueSearchInput['orderBy']>[number]['direction']>,
  state: AgentIssueStoreState,
): number {
  const leftValue = searchRowFieldValue(left, field, state);
  const rightValue = searchRowFieldValue(right, field, state);
  if (leftValue === undefined && rightValue === undefined) return 0;
  if (leftValue === undefined) return 1;
  if (rightValue === undefined) return -1;
  const diff = compareValues(leftValue, rightValue);
  return direction === 'asc' ? diff : -diff;
}

function searchRowFieldValue(
  row: IssueSearchRow,
  field: NonNullable<IssueSearchInput['orderBy']>[number]['field'],
  state: AgentIssueStoreState,
): number | string | undefined {
  const object = row.target.type === 'issue'
    ? state.issues[row.target.id]
    : state.recurringIssues[row.target.id];
  switch (field) {
    case 'createdAt':
      return object?.createdAt;
    case 'updatedAt':
      return object?.updatedAt;
    case 'dueDate':
      return row.target.type === 'issue'
        ? state.issues[row.target.id]?.dueDate?.targetAt
        : undefined;
    case 'nextMaterializationAt':
      return row.target.type === 'recurring-issue'
        ? state.recurringIssues[row.target.id]?.nextMaterializationAt
        : undefined;
    case 'status':
      return row.status;
  }
}

function compareValues(
  left: number | string,
  right: number | string,
): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
}

function agentRefMatches(ref: AgentRef | undefined, delegateIds: readonly string[]): boolean {
  const normalized = new Set(delegateIds.map((id) => id.trim()).filter(Boolean));
  if (normalized.size === 0) return true;
  const effective = ref ?? { type: 'default-agent' as const };
  const profile = effective.runProfile ?? 'default';
  return normalized.has(effective.type)
    || normalized.has(profile)
    || normalized.has(`${effective.type}:${profile}`);
}

function inputScopeMatchesNodeIds(
  scope: IssueInputScope | undefined,
  nodeIds: readonly string[],
): boolean {
  if (!scope || nodeIds.length === 0) return false;
  if (scope.type === 'selected-nodes') return nodeIds.some((nodeId) => scope.nodeIds.includes(nodeId));
  if (scope.type === 'node-children') return nodeIds.includes(scope.nodeId);
  return false;
}

function inputScopeMatchesTags(
  scope: IssueInputScope | undefined,
  tags: readonly string[],
): boolean {
  if (!scope || scope.type !== 'tag-query' || tags.length === 0) return false;
  return tags.some((tag) => normalizeTagForSearch(tag) === normalizeTagForSearch(scope.tag));
}

function normalizeTagForSearch(tag: string): string {
  return tag.trim().replace(/^#+/u, '').toLocaleLowerCase();
}

function appendActivity(
  state: AgentIssueStoreState,
  input: Omit<Activity, 'id'>,
): Activity {
  const activity: Activity = { ...input, id: `activity:${randomUUID()}` };
  state.activity[activity.id] = activity;
  state.activityOrder.push(activity.id);
  return activity;
}

function activityInput(target: ActivityTarget, actor: ActorRef, content: ActivityContent, createdAt: number): Omit<Activity, 'id'> {
  return { target, actor, content, createdAt };
}

function activityForTarget(state: AgentIssueStoreState, target: ActivityTarget): Activity[] {
  return state.activityOrder
    .map((id) => state.activity[id])
    .filter((activity): activity is Activity => Boolean(activity) && sameActivityTarget(activity.target, target));
}

function issueActivity(state: AgentIssueStoreState, issue: AgentIssue): Activity[] {
  const sessionIds = new Set(Object.values(state.sessions)
    .filter((session) => session.issueId === issue.id)
    .map((session) => session.id));
  return state.activityOrder
    .map((id) => state.activity[id])
    .filter((activity): activity is Activity => {
      if (!activity) return false;
      if (activity.target.type === 'issue' && activity.target.issueId === issue.id) return true;
      if (activity.target.type === 'agent-session' && sessionIds.has(activity.target.agentSessionId)) return true;
      return activity.relatedTargets?.some((target) => (
        (target.type === 'issue' && target.id === issue.id)
        || (target.type === 'agent-session' && sessionIds.has(target.id))
      )) ?? false;
    });
}

function recurringIssueActivity(state: AgentIssueStoreState, recurringIssue: AgentRecurringIssue): Activity[] {
  return state.activityOrder
    .map((id) => state.activity[id])
    .filter((activity): activity is Activity => Boolean(activity) && (
      (activity.target.type === 'recurring-issue' && activity.target.recurringIssueId === recurringIssue.id)
      || (activity.relatedTargets?.some((target) => target.type === 'recurring-issue' && target.id === recurringIssue.id) ?? false)
    ));
}

function sortActivityDescending(activity: Activity[]): Activity[] {
  return activity
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => (
      right.entry.createdAt - left.entry.createdAt
      || right.index - left.index
    ))
    .map(({ entry }) => entry);
}

function issueMatchesActivityTarget(state: AgentIssueStoreState, issue: AgentIssue, target: ActivityTarget): boolean {
  if (target.type === 'issue') return target.issueId === issue.id;
  if (target.type === 'agent-session') return state.sessions[target.agentSessionId]?.issueId === issue.id;
  return false;
}

function sameActivityTarget(left: ActivityTarget, right: ActivityTarget): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'issue' && right.type === 'issue') return left.issueId === right.issueId;
  if (left.type === 'recurring-issue' && right.type === 'recurring-issue') return left.recurringIssueId === right.recurringIssueId;
  return left.type === 'agent-session' && right.type === 'agent-session' && left.agentSessionId === right.agentSessionId;
}

function appendVerifierResultActivity(
  state: AgentIssueStoreState,
  session: AgentSession,
  input: AgentSessionExecutionSyncInput,
  actor: ActorRef,
  now: number,
): { verdict: 'pass' | 'fail' | 'partial'; body: string; evaluationText: string } | null {
  const issue = state.issues[session.issueId];
  if (!issue || issue.verificationPolicy?.mode !== 'agent-review') return null;
  const rawBody = (input.latestOutput ?? session.latestOutput ?? '').trim() || 'Verifier completed without a written verdict.';
  const body = activityBody(rawBody, 'Verifier completed without a written verdict.');
  const verdict = verifierVerdictFromText(body);
  issue.evidence = [
    ...(issue.evidence ?? []).filter((entry) => !(entry.type === 'agent-session' && entry.agentSessionId === session.id)),
    { type: 'agent-session', agentSessionId: session.id },
  ];
  issue.updatedAt = now;
  issue.revision = revision(now);
  appendActivity(state, {
    target: { type: 'issue', issueId: issue.id },
    actor,
    content: { type: 'verification-result', verdict, body, agentSessionId: session.id },
    relatedTargets: [{ type: 'agent-session', id: session.id }],
    createdAt: now,
  });
  return { verdict, body, evaluationText: rawBody };
}

function verifierVerdictFromText(text: string): 'pass' | 'fail' | 'partial' {
  const normalized = text.trim().toLocaleLowerCase();
  if (/^(verdict:\s*)?fail\b/u.test(normalized)) return 'fail';
  if (/^(verdict:\s*)?(partial|pass-or-partial)\b/u.test(normalized)) return 'partial';
  if (/^(verdict:\s*)?pass\b/u.test(normalized)) return 'pass';
  return 'fail';
}

function verifierVerdictAccepted(
  policy: AgentIssue['verificationPolicy'] | undefined,
  verdict: 'pass' | 'fail' | 'partial',
  body: string,
): boolean {
  if (policy?.mode !== 'agent-review') return false;
  const acceptedVerdict = policy.requiredVerdict === 'pass-or-partial'
    ? verdict === 'pass' || verdict === 'partial'
    : verdict === 'pass';
  if (!acceptedVerdict) return false;
  const normalizedBody = body.toLocaleLowerCase();
  return (policy.requiredEvidence ?? [])
    .map((requirement) => requirement.trim().toLocaleLowerCase())
    .filter(Boolean)
    .every((requirement) => normalizedBody.includes(requirement));
}

interface FinalizeIssueOptions {
  actor: ActorRef;
  now: number;
  evidenceSession?: AgentSession;
  allowHumanReview: boolean;
  verificationSatisfied: boolean;
}

interface FinalizeIssueResult {
  completed: boolean;
  validation: ValidationMessage[];
}

function recordSessionFinalizationBlock(
  state: AgentIssueStoreState,
  session: AgentSession,
  validation: readonly ValidationMessage[],
  actor: ActorRef,
  now: number,
): void {
  const actionable = validation.filter((entry) => (
    entry.code === 'criteria_changed_since_session'
    || entry.code === 'issue_definition_changed_since_session'
  ));
  if (actionable.length === 0) return;
  const message = `Issue completion blocked: ${actionable.map((entry) => entry.message).join(' ')}`;
  if (session.errorMessage === message) return;
  session.errorMessage = message;
  session.updatedAt = now;
  session.revision = revision(now);
  appendActivity(state, {
    target: { type: 'agent-session', agentSessionId: session.id },
    actor,
    content: { type: 'agent-error', body: activityBody(message, 'Issue completion was blocked.') },
    relatedTargets: [{ type: 'issue', id: session.issueId }],
    createdAt: now,
  });
  enqueueSessionErrorDelivery(state, session, now);
}

function finalizeIssue(
  state: AgentIssueStoreState,
  issueId: string,
  options: FinalizeIssueOptions,
): FinalizeIssueResult {
  const issue = state.issues[issueId];
  if (!issue) {
    return { completed: false, validation: [{ code: 'not_found', message: 'Issue was not found.' }] };
  }
  if (issue.status.category === 'completed') return { completed: false, validation: [] };
  if (issue.status.category === 'canceled') {
    return {
      completed: false,
      validation: [{ code: 'terminal_issue', message: 'A canceled Issue cannot be completed.' }],
    };
  }
  if (issueHasActiveSession(issue, state)) {
    return {
      completed: false,
      validation: [{ code: 'active_session_exists', message: 'An Issue with an active Agent Session cannot be completed.' }],
    };
  }
  const blockerIds = unresolvedBlockingIssueIds(issue, state);
  if (blockerIds.length > 0) {
    return {
      completed: false,
      validation: [{
        code: 'blocked_by_issue',
        message: `Issue is blocked by ${blockerIds.join(', ')}.`,
      }],
    };
  }
  const childValidation = issueOutstandingChildValidation(issue, state);
  if (childValidation.length > 0) return { completed: false, validation: childValidation };
  const evidenceSession = options.evidenceSession;
  const changedDefinitionFields = evidenceSession
    ? issueDefinitionChangesSinceSession(issue, evidenceSession.issueSnapshot)
    : [];
  if (changedDefinitionFields.length > 0) {
    return {
      completed: false,
      validation: [{
        code: 'issue_definition_changed_since_session',
        path: changedDefinitionFields[0],
        message: `Issue execution-relevant fields changed after the evidence Session started: ${changedDefinitionFields.join(', ')}. Start a new Agent Session against the current Issue definition.`,
      }],
    };
  }
  const verificationMode = issue.verificationPolicy?.mode ?? 'none';
  if (verificationMode === 'human-review' && !options.allowHumanReview) {
    return { completed: false, validation: [] };
  }
  if (verificationMode === 'agent-review' && !options.verificationSatisfied) {
    return { completed: false, validation: [] };
  }
  const snapshotCriteria = evidenceSession?.issueSnapshot.completionCriteria ?? [];
  const currentCriteria = issue.completionCriteria ?? [];
  const snapshotCriteriaById = new Map(snapshotCriteria.map((criterion) => [criterion.id, criterion]));
  const currentCriteriaById = new Map(currentCriteria.map((criterion) => [criterion.id, criterion]));
  const criteriaChangedSinceSession = evidenceSession
    ? uniqueStrings([
        ...snapshotCriteria.flatMap((snapshot) => {
          if (snapshot.state === 'waived') return [];
          const current = currentCriteriaById.get(snapshot.id);
          if (!current) return [snapshot.id];
          if (current.state === 'waived') return [];
          return current.text === snapshot.text ? [] : [snapshot.id];
        }),
        ...currentCriteria.flatMap((current) => (
          current.state !== 'waived' && !snapshotCriteriaById.has(current.id) ? [current.id] : []
        )),
      ])
    : [];
  if (criteriaChangedSinceSession.length > 0) {
    return {
      completed: false,
      validation: [{
        code: 'criteria_changed_since_session',
        path: 'completionCriteria',
        message: `Issue completion criteria changed after the evidence Session started: ${criteriaChangedSinceSession.join(', ')}. Start a new Agent Session against the current Issue definition.`,
      }],
    };
  }
  if (evidenceSession) {
    issue.evidence = [
      ...(issue.evidence ?? []).filter((entry) => !(
        entry.type === 'agent-session' && entry.agentSessionId === evidenceSession.id
      )),
      { type: 'agent-session', agentSessionId: evidenceSession.id },
    ];
  }
  if (issue.completionCriteria) {
    issue.completionCriteria = issue.completionCriteria.map((criterion) => (
      criterion.state === 'open'
        ? {
            ...criterion,
            state: 'met',
            ...(evidenceSession ? {
              evidence: [
                ...(criterion.evidence ?? []).filter((entry) => !(
                  entry.type === 'agent-session' && entry.agentSessionId === evidenceSession.id
                )),
                { type: 'agent-session', agentSessionId: evidenceSession.id },
              ],
            } : {}),
          }
        : criterion
    ));
  }
  appendActivity(state, activityInput(
    { type: 'issue', issueId: issue.id },
    options.actor,
    { type: 'status-change', from: issue.status.name, to: 'Completed' },
    options.now,
  ));
  issue.status = { name: 'Completed', category: 'completed' };
  issue.terminalAt = options.now;
  issue.updatedAt = options.now;
  issue.revision = revision(options.now);
  if (issue.parentIssueId && state.issues[issue.parentIssueId]) {
    appendActivity(state, activityInput(
      { type: 'issue', issueId: issue.parentIssueId },
      options.actor,
      { type: 'agent-action', action: 'child_issue_completed', result: issue.id },
      options.now,
    ));
  }
  const deliverySession = evidenceSession?.purpose === 'verify'
    ? latestCompletedExecutionSession(state, issue.id)
    : evidenceSession ?? latestCompletedExecutionSession(state, issue.id);
  enqueueIssueCompletionDelivery(state, issue, deliverySession, options.now);
  return { completed: true, validation: [] };
}

function issueDefinitionChangesSinceSession(
  issue: AgentIssue,
  snapshot: AgentIssue,
): string[] {
  const fields: Array<keyof AgentIssue> = [
    'description',
    'delegate',
    'verificationPolicy',
    'noteNodeIds',
    'input',
    'output',
    'permissionMode',
    'executionPolicy',
  ];
  return fields.filter((field) => JSON.stringify(issue[field] ?? null) !== JSON.stringify(snapshot[field] ?? null));
}

function reviewPolicyWasWeakened(
  previous: AgentIssue['verificationPolicy'],
  next: AgentIssue['verificationPolicy'],
): boolean {
  const previousMode = previous?.mode ?? 'none';
  const nextMode = next?.mode ?? 'none';
  if (previousMode === 'human-review' && nextMode !== 'human-review') return true;
  if (previousMode === 'agent-review' && nextMode !== 'agent-review' && nextMode !== 'human-review') return true;
  if (previousMode !== 'agent-review' || nextMode !== 'agent-review') return false;
  const previousVerdict = previous?.requiredVerdict ?? 'pass';
  const nextVerdict = next?.requiredVerdict ?? 'pass';
  if (previousVerdict === 'pass' && nextVerdict === 'pass-or-partial') return true;
  const nextEvidence = new Set(next?.requiredEvidence ?? []);
  return (previous?.requiredEvidence ?? []).some((requirement) => !nextEvidence.has(requirement));
}

function completionCriteriaWereWeakened(
  previous: AgentIssue['completionCriteria'],
  next: AgentIssue['completionCriteria'],
): boolean {
  const nextById = new Map((next ?? []).map((criterion) => [criterion.id, criterion]));
  return (previous ?? []).some((criterion) => {
    if (criterion.state === 'waived') return false;
    const replacement = nextById.get(criterion.id);
    return !replacement || replacement.state === 'waived';
  });
}

function latestCompletedExecutionSession(
  state: AgentIssueStoreState,
  issueId: string,
): AgentSession | undefined {
  return Object.values(state.sessions)
    .filter((session) => (
      session.issueId === issueId
      && session.purpose !== 'verify'
      && session.state === 'complete'
    ))
    .sort((left, right) => (
      (right.completedAt ?? right.updatedAt) - (left.completedAt ?? left.updatedAt)
      || right.createdAt - left.createdAt
    ))[0];
}

function latestTerminalExecutionSession(
  state: AgentIssueStoreState,
  issueId: string,
): AgentSession | undefined {
  return Object.values(state.sessions)
    .filter((session) => (
      session.issueId === issueId
      && session.purpose !== 'verify'
      && isTerminalSessionState(session.state)
    ))
    .sort((left, right) => (
      (right.completedAt ?? right.updatedAt) - (left.completedAt ?? left.updatedAt)
      || right.createdAt - left.createdAt
    ))[0];
}

function enqueueIssueCompletionDelivery(
  state: AgentIssueStoreState,
  issue: AgentIssue,
  session: AgentSession | undefined,
  now: number,
): void {
  if (!issue.origin) return;
  const body = terminalDeliveryBody(session?.latestOutput);
  enqueueTerminalDelivery(state, {
    issueId: issue.id,
    ...(session ? { agentSessionId: session.id } : {}),
    origin: issue.origin,
    state: 'complete',
    title: `Issue "${issue.title}" completed.`,
    ...(body ? { body } : {}),
    terminalAt: now,
  }, now);
}

function enqueueIssueCancellationDelivery(
  state: AgentIssueStoreState,
  issue: AgentIssue,
  now: number,
): void {
  if (issue.origin?.type !== 'agent-session') return;
  const executionSession = latestTerminalExecutionSession(state, issue.id);
  enqueueTerminalDelivery(state, {
    issueId: issue.id,
    ...(executionSession ? { agentSessionId: executionSession.id } : {}),
    origin: issue.origin,
    state: 'canceled',
    title: `Issue "${issue.title}" was canceled.`,
    terminalAt: now,
  }, now);
}

function enqueueSessionErrorDelivery(
  state: AgentIssueStoreState,
  session: AgentSession,
  now: number,
): void {
  const issue = state.issues[session.issueId];
  const origin = issue?.origin ?? session.issueSnapshot.origin;
  if (!origin) return;
  const body = terminalDeliveryBody(session.errorMessage);
  enqueueTerminalDelivery(state, {
    issueId: session.issueId,
    agentSessionId: session.id,
    origin,
    state: 'error',
    title: `Agent Session for Issue "${issue?.title ?? session.issueSnapshot.title}" failed; the Issue remains open.`,
    ...(body ? { body } : {}),
    terminalAt: session.completedAt ?? now,
  }, now);
}

function enqueueTerminalDelivery(
  state: AgentIssueStoreState,
  input: Pick<
    AgentIssueTerminalDelivery,
    'issueId' | 'agentSessionId' | 'origin' | 'state' | 'title' | 'body' | 'terminalAt'
  >,
  now: number,
): void {
  const existing = Object.values(state.terminalDeliveries).find((delivery) => (
    delivery.issueId === input.issueId
    && delivery.agentSessionId === input.agentSessionId
    && delivery.state === input.state
    && delivery.terminalAt === input.terminalAt
  ));
  if (existing) {
    if (existing.status !== 'delivered') {
      existing.title = input.title;
      existing.body = input.body;
      existing.updatedAt = now;
    }
    return;
  }
  const delivery: AgentIssueTerminalDelivery = {
    id: `issue-delivery:${randomUUID()}`,
    ...input,
    status: 'pending',
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  state.terminalDeliveries[delivery.id] = delivery;
}

function acknowledgeTerminalDeliveriesForSession(
  state: AgentIssueStoreState,
  agentSessionId: AgentSessionId,
  deliveryIds: readonly string[],
  now: number,
): string[] {
  const acknowledged: string[] = [];
  for (const deliveryId of new Set(deliveryIds)) {
    const delivery = state.terminalDeliveries[deliveryId];
    if (
      !delivery
      || delivery.status === 'delivered'
      || delivery.origin.type !== 'agent-session'
      || delivery.origin.agentSessionId !== agentSessionId
    ) continue;
    delivery.status = 'delivered';
    delivery.dispatchOwnerId = undefined;
    delivery.lastError = undefined;
    delivery.deliveredAt = now;
    delivery.updatedAt = now;
    acknowledged.push(deliveryId);
  }
  return acknowledged;
}

function executionSnapshotMatches(
  session: AgentSession,
  nextState: AgentSession['state'],
  input: AgentSessionExecutionSyncInput,
): boolean {
  if (input.objectiveStatus !== undefined) return false;
  return session.state === nextState
    && (input.latestOutput === undefined || session.latestOutput === input.latestOutput)
    && (input.errorMessage === undefined || session.errorMessage === input.errorMessage)
    && (input.completedAt === undefined || session.completedAt === input.completedAt);
}

function cloneTerminalDelivery(delivery: AgentIssueTerminalDelivery): AgentIssueTerminalDelivery {
  return {
    ...delivery,
    origin: { ...delivery.origin },
  };
}

function isTerminalDeliveryClaimable(delivery: AgentIssueTerminalDelivery, now: number): boolean {
  return delivery.status === 'pending'
    || (
      delivery.status === 'dispatching'
      && delivery.updatedAt <= now - TERMINAL_DELIVERY_CLAIM_LEASE_MS
    );
}

function terminalDeliveryBody(value: string | undefined): string | undefined {
  const sanitized = stripReasoningBlocks(value ?? '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  return sanitized || undefined;
}

function markIssueStartedForSession(
  state: AgentIssueStoreState,
  session: AgentSession,
  actor: ActorRef,
  now: number,
) {
  const issue = state.issues[session.issueId];
  if (!issue || issue.status.category === 'completed' || issue.status.category === 'canceled') return;
  if (issue.status.category === 'started') return;
  appendActivity(state, activityInput(
    { type: 'issue', issueId: issue.id },
    actor,
    { type: 'status-change', from: issue.status.name, to: 'Started' },
    now,
  ));
  issue.status = { name: 'Started', category: 'started' };
  issue.updatedAt = now;
  issue.revision = revision(now);
}

function canMessageSession(state: AgentSession['state']): boolean {
  return isActiveAgentSessionState(state);
}

function preflightSessionMessageFromState(
  state: AgentIssueStoreState,
  input: AgentSessionSendMessageInput,
): TenonAgentToolResult {
  const target: RelatedTargetRef = { type: 'agent-session', id: input.agentSessionId };
  const session = state.sessions[input.agentSessionId];
  if (!session) {
    return { status: 'blocked', targets: [target], validation: [{ code: 'not_found', message: 'Agent Session was not found.' }] };
  }
  if (!canMessageSession(session.state)) {
    return {
      status: 'blocked',
      targets: [target],
      validation: [{ code: 'invalid_state', message: 'Agent Session cannot receive messages in its current state.' }],
      revisions: [{ target, revision: session.revision }],
    };
  }
  if (state.sessionStopIntents[session.id]) {
    return {
      status: 'blocked',
      targets: [target],
      validation: [{ code: 'stop_in_progress', message: 'Agent Session cannot receive messages while stop is in progress.' }],
      revisions: [{ target, revision: session.revision }],
    };
  }
  return { status: 'applied', targets: [target], revisions: [{ target, revision: session.revision }] };
}

function canStopSession(state: AgentSession['state']): boolean {
  return isActiveAgentSessionState(state);
}

function preflightSessionStopFromState(
  state: AgentIssueStoreState,
  input: AgentSessionStopInput,
): TenonAgentToolResult {
  const target: RelatedTargetRef = { type: 'agent-session', id: input.agentSessionId };
  const session = state.sessions[input.agentSessionId];
  if (!session) {
    return { status: 'blocked', targets: [target], validation: [{ code: 'not_found', message: 'Agent Session was not found.' }] };
  }
  if (session.state === 'canceled') {
    return { status: 'applied', targets: [target], revisions: [{ target, revision: session.revision }] };
  }
  if (state.sessionStopIntents[session.id]) {
    return {
      status: 'blocked',
      targets: [target],
      validation: [{ code: 'stop_in_progress', message: 'Agent Session stop is already in progress.' }],
      revisions: [{ target, revision: session.revision }],
    };
  }
  const validation = sessionStopValidation(state, session);
  if (validation.length > 0) {
    return {
      status: 'blocked',
      targets: [target],
      validation,
      revisions: [{ target, revision: session.revision }],
    };
  }
  return { status: 'applied', targets: [target], revisions: [{ target, revision: session.revision }] };
}

function cancelSession(
  state: AgentIssueStoreState,
  session: AgentSession,
  actor: ActorRef,
  now: number,
): void {
  session.state = 'canceled';
  session.completedAt = now;
  session.updatedAt = now;
  session.revision = revision(now);
  appendActivity(state, {
    target: { type: 'agent-session', agentSessionId: session.id },
    actor,
    content: { type: 'agent-action', action: 'agent_session_stop', result: 'canceled' },
    relatedTargets: [{ type: 'issue', id: session.issueId }],
    createdAt: now,
  });
}

function sessionStopValidation(
  state: AgentIssueStoreState,
  session: AgentSession,
): ValidationMessage[] {
  if (!canStopSession(session.state)) {
    return [{
      code: 'invalid_state',
      message: 'Only pending or active Sessions can be stopped.',
    }];
  }
  if (sessionHasOutstandingChildEdge(state, session)) {
    return [{
      code: 'incomplete_child_issues',
      message: 'Agent Session cannot be stopped while child Issues are unresolved or their terminal results are still pending delivery.',
    }];
  }
  return [];
}

function sessionHasOutstandingChildEdge(
  state: AgentIssueStoreState,
  session: AgentSession,
): boolean {
  const unresolvedChildren = Object.values(state.issues).filter((issue) => (
    issue.origin?.type === 'agent-session'
    && issue.origin.agentSessionId === session.id
    && issue.status.category !== 'completed'
    && issue.status.category !== 'canceled'
  ));
  const undeliveredChildResults = Object.values(state.terminalDeliveries).filter((delivery) => (
    delivery.origin.type === 'agent-session'
    && delivery.origin.agentSessionId === session.id
    && delivery.status !== 'delivered'
  ));
  return unresolvedChildren.length > 0 || undeliveredChildResults.length > 0;
}

function isRecoverableLiveSession(state: AgentSession['state']): boolean {
  return isActiveAgentSessionState(state);
}

function isTerminalSessionState(state: AgentSession['state']): boolean {
  return state === 'complete' || state === 'error' || state === 'stale' || state === 'canceled';
}

function agentSessionStateFromExecution(state: AgentSessionExecutionSyncInput['state']): AgentSession['state'] {
  switch (state) {
    case 'running':
      return 'active';
    case 'completed':
      return 'complete';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'canceled';
  }
}

function sessionStateActivityContent(
  state: AgentSession['state'],
  input: AgentSessionExecutionSyncInput,
): ActivityContent {
  switch (state) {
    case 'complete':
      return input.latestOutput
        ? { type: 'agent-response', body: activityBody(input.latestOutput, 'Agent Session completed.') }
        : { type: 'agent-progress', body: 'Agent Session completed.' };
    case 'error':
      return { type: 'agent-error', body: activityBody(input.errorMessage, 'Agent Session failed.') };
    case 'canceled':
      return { type: 'agent-action', action: 'agent_session_stop', result: 'canceled' };
    case 'active':
      return { type: 'agent-progress', body: 'Agent Session is active.' };
    case 'stale':
      return { type: 'agent-error', body: activityBody(input.errorMessage, 'Agent Session became stale.') };
    case 'pending':
      return { type: 'agent-progress', body: 'Agent Session is pending.' };
  }
}

function activityBody(input: string | undefined, fallback: string): string {
  const sanitized = stripReasoningBlocks(input ?? '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  const body = sanitized || fallback;
  if (body.length <= MAX_ACTIVITY_BODY_CHARS) return body;
  return `${body.slice(0, MAX_ACTIVITY_BODY_CHARS - 1).trimEnd()}…`;
}

function stripReasoningBlocks(input: string): string {
  return input
    .replace(/<analysis>[\s\S]*?<\/analysis>/giu, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/giu, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/giu, '');
}

function validateIssueCreateInput(value: unknown): ValidationMessage[] {
  if (!isRecord(value)) return [{ code: 'invalid_request', message: 'Issue create input must be an object.' }];
  const validation = validateChangeEnvelope(value);
  const fields = isRecord(value.fields) ? value.fields : null;
  if (!fields) {
    validation.push({ path: 'fields', code: 'required_field', message: 'Issue fields are required.' });
    return validation;
  }
  if (value.issueType === 'issue') {
    validation.push(...unsupportedFieldMessages(fields, ISSUE_FIELD_KEYS, 'fields'));
    if (typeof fields.title !== 'string' || !fields.title.trim()) {
      validation.push({ path: 'fields.title', code: 'required_field', message: 'Issue title is required.' });
    }
    validation.push(...validateIssueRelationsInput(fields.relations, 'fields.relations'));
    validation.push(...validateIssueTriggerInput(fields.trigger, 'fields.trigger'));
    validation.push(...validateIssueInputScope(fields.input, 'fields.input'));
    validation.push(...validateIssueOutputPolicy(fields.output, 'fields.output'));
    validation.push(...validateIssueExecutionPolicy(fields.executionPolicy, 'fields.executionPolicy'));
    return validation;
  }
  if (value.issueType === 'recurring-issue') {
    validation.push(...unsupportedFieldMessages(fields, RECURRING_ISSUE_FIELD_KEYS, 'fields'));
    if (typeof fields.titleTemplate !== 'string' || !fields.titleTemplate.trim()) {
      validation.push({ path: 'fields.titleTemplate', code: 'required_field', message: 'Recurring Issue titleTemplate is required.' });
    }
    if (fields.descriptionTemplate !== undefined && typeof fields.descriptionTemplate !== 'string') {
      validation.push({ path: 'fields.descriptionTemplate', code: 'invalid_field', message: 'Recurring Issue descriptionTemplate must be a string.' });
    }
    if (!isRecord(fields.issueTemplate)) {
      validation.push({ path: 'fields.issueTemplate', code: 'required_field', message: 'Recurring Issue issueTemplate is required.' });
    } else if (fields.issueTemplate.permissionMode !== 'attended' && fields.issueTemplate.permissionMode !== 'unattended') {
      validation.push({ path: 'fields.issueTemplate.permissionMode', code: 'required_field', message: 'Recurring Issue issueTemplate.permissionMode is required.' });
    } else {
      validation.push(...validateIssueRelationsInput(
        fields.issueTemplate.relations,
        'fields.issueTemplate.relations',
      ));
      validation.push(...unsupportedFieldMessages(
        fields.issueTemplate,
        RECURRING_ISSUE_TEMPLATE_FIELD_KEYS,
        'fields.issueTemplate',
      ));
      validation.push(...validateIssueTriggerInput(fields.issueTemplate.trigger, 'fields.issueTemplate.trigger'));
      validation.push(...validateIssueInputScope(fields.issueTemplate.input, 'fields.issueTemplate.input'));
      validation.push(...validateIssueOutputPolicy(fields.issueTemplate.output, 'fields.issueTemplate.output'));
    }
    validation.push(...validateRecurringIssueSchedule(
      fields.cadence as RecurringIssueDraftFields['cadence'],
      typeof fields.timeZone === 'string' ? fields.timeZone : '',
    ));
    return validation;
  }
  validation.push({ path: 'issueType', code: 'invalid_issue_type', message: 'issueType must be issue or recurring-issue.' });
  return validation;
}

function validateIssueUpdateInput(value: unknown): ValidationMessage[] {
  if (!isRecord(value)) return [{ code: 'invalid_request', message: 'Issue update input must be an object.' }];
  const validation = validateChangeEnvelope(value);
  const target = isRecord(value.target) ? value.target : null;
  if (
    !target
    || (target.type !== 'issue' && target.type !== 'recurring-issue')
    || typeof target.id !== 'string'
    || !target.id.trim()
  ) {
    validation.push({ path: 'target', code: 'invalid_target', message: 'A concrete Issue or Recurring Issue target is required.' });
    return validation;
  }
  const change = isRecord(value.change) ? value.change : null;
  if (!change || typeof change.type !== 'string') {
    validation.push({ path: 'change', code: 'invalid_change', message: 'An explicit Issue change is required.' });
    return validation;
  }
  const allowedOperations = target.type === 'issue'
    ? new Set(['patch', 'transition', 'archive', 'delete'])
    : new Set(['patch', 'pause', 'resume', 'skip-next', 'archive', 'delete']);
  if (!allowedOperations.has(change.type)) {
    validation.push({
      path: 'change.type',
      code: 'invalid_change',
      message: `${change.type} is not valid for a ${target.type} target.`,
    });
    return validation;
  }
  const allowedChangeFields = change.type === 'patch'
    ? new Set(['type', 'patch'])
    : change.type === 'transition'
      ? new Set(['type', 'status'])
      : new Set(['type']);
  validation.push(...unsupportedFieldMessages(change, allowedChangeFields, 'change'));
  if (change.type === 'patch') {
    const patch = isRecord(change.patch) ? change.patch : null;
    if (!patch) {
      validation.push({ path: 'change.patch', code: 'required_field', message: 'A patch object is required for a patch change.' });
      return validation;
    }
    if (Object.keys(patch).length === 0) {
      validation.push({ path: 'change.patch', code: 'empty_patch', message: 'A patch change must include at least one field.' });
      return validation;
    }
    const allowedFields = target.type === 'issue' ? ISSUE_FIELD_KEYS : RECURRING_ISSUE_FIELD_KEYS;
    if (target.type === 'issue' && 'status' in patch) {
      validation.push({
        path: 'change.patch.status',
        code: 'status_patch_not_allowed',
        message: 'Issue status changes must use an explicit lifecycle transition.',
      });
    }
    validation.push(...unsupportedFieldMessages(patch, allowedFields, 'change.patch')
      .filter((message) => message.path !== 'change.patch.status'));
    if (target.type === 'issue' && patch.title !== undefined && (
      typeof patch.title !== 'string' || !patch.title.trim()
    )) {
      validation.push({ path: 'change.patch.title', code: 'invalid_field', message: 'Issue title must be a non-empty string.' });
    }
    if (target.type === 'issue') {
      validation.push(...validateIssueRelationsInput(patch.relations, 'change.patch.relations'));
      validation.push(...validateIssueTriggerInput(patch.trigger, 'change.patch.trigger'));
      validation.push(...validateIssueInputScope(patch.input, 'change.patch.input'));
      validation.push(...validateIssueOutputPolicy(patch.output, 'change.patch.output'));
      validation.push(...validateIssueExecutionPolicy(patch.executionPolicy, 'change.patch.executionPolicy'));
    }
    if (target.type === 'recurring-issue') {
      if (patch.titleTemplate !== undefined && (
        typeof patch.titleTemplate !== 'string' || !patch.titleTemplate.trim()
      )) {
        validation.push({ path: 'change.patch.titleTemplate', code: 'invalid_field', message: 'Recurring Issue titleTemplate must be a non-empty string.' });
      }
      if (patch.descriptionTemplate !== undefined && typeof patch.descriptionTemplate !== 'string') {
        validation.push({ path: 'change.patch.descriptionTemplate', code: 'invalid_field', message: 'Recurring Issue descriptionTemplate must be a string.' });
      }
      if (patch.issueTemplate !== undefined && (
        !isRecord(patch.issueTemplate)
        || (patch.issueTemplate.permissionMode !== 'attended' && patch.issueTemplate.permissionMode !== 'unattended')
      )) {
        validation.push({ path: 'change.patch.issueTemplate', code: 'invalid_field', message: 'Recurring Issue issueTemplate must include permissionMode.' });
      } else if (isRecord(patch.issueTemplate)) {
        validation.push(...unsupportedFieldMessages(
          patch.issueTemplate,
          RECURRING_ISSUE_TEMPLATE_FIELD_KEYS,
          'change.patch.issueTemplate',
        ));
        validation.push(...validateIssueRelationsInput(
          patch.issueTemplate.relations,
          'change.patch.issueTemplate.relations',
        ));
        validation.push(...validateIssueTriggerInput(
          patch.issueTemplate.trigger,
          'change.patch.issueTemplate.trigger',
        ));
        validation.push(...validateIssueInputScope(
          patch.issueTemplate.input,
          'change.patch.issueTemplate.input',
        ));
        validation.push(...validateIssueOutputPolicy(
          patch.issueTemplate.output,
          'change.patch.issueTemplate.output',
        ));
      }
    }
  }
  if (change.type === 'transition') {
    const status = isRecord(change.status) ? change.status : null;
    const validCategories = new Set(['triage', 'unstarted', 'started', 'completed', 'canceled']);
    if (
      !status
      || typeof status.name !== 'string'
      || !status.name.trim()
      || typeof status.category !== 'string'
      || !validCategories.has(status.category)
    ) {
      validation.push({ path: 'change.status', code: 'invalid_status', message: 'A valid Issue status is required for a transition.' });
    }
  }
  return validation;
}

function validateIssueTriggerInput(value: unknown, path: string): ValidationMessage[] {
  if (value === undefined) return [];
  if (!isRecord(value) || (value.type !== 'when-ready' && value.type !== 'scheduled')) {
    return [{ path, code: 'invalid_trigger', message: 'Issue trigger must be when-ready or scheduled.' }];
  }
  if (value.type === 'when-ready') {
    return unsupportedFieldMessages(value, new Set(['type']), path).map((message) => ({
      ...message,
      code: 'invalid_trigger',
      message: 'A when-ready trigger cannot include scheduled trigger fields.',
    }));
  }

  const validation = unsupportedFieldMessages(value, new Set(['type', 'startAt', 'timeZone']), path)
    .map((message) => ({ ...message, code: 'invalid_trigger' }));
  if (typeof value.startAt !== 'number' || !Number.isFinite(value.startAt)) {
    validation.push({
      path: `${path}.startAt`,
      code: 'invalid_trigger_start',
      message: 'A scheduled trigger requires a finite startAt timestamp.',
    });
  }
  if (
    typeof value.timeZone !== 'string'
    || !value.timeZone.trim()
    || !normalizeRecurringIssueTimeZone(value.timeZone)
  ) {
    validation.push({
      path: `${path}.timeZone`,
      code: 'invalid_trigger_time_zone',
      message: 'A scheduled trigger requires a valid IANA time zone.',
    });
  }
  return validation;
}

function validateIssueInputScope(value: unknown, path: string): ValidationMessage[] {
  if (value === undefined) return [];
  if (!isRecord(value)) {
    return [{ path, code: 'invalid_input_scope', message: 'Issue input scope must be an object.' }];
  }
  switch (value.type) {
    case 'none':
      return branchValidation(value, new Set(['type']), path, 'invalid_input_scope');
    case 'selected-nodes': {
      const validation = branchValidation(value, new Set(['type', 'nodeIds']), path, 'invalid_input_scope');
      if (
        !Array.isArray(value.nodeIds)
        || value.nodeIds.length === 0
        || value.nodeIds.some((nodeId) => typeof nodeId !== 'string' || !nodeId.trim())
      ) {
        validation.push({
          path: `${path}.nodeIds`,
          code: 'invalid_input_scope',
          message: 'selected-nodes input requires at least one non-empty node id.',
        });
      } else if (new Set(value.nodeIds).size !== value.nodeIds.length) {
        validation.push({
          path: `${path}.nodeIds`,
          code: 'invalid_input_scope',
          message: 'selected-nodes input cannot contain duplicate node ids.',
        });
      }
      return validation;
    }
    case 'node-children': {
      const validation = branchValidation(value, new Set(['type', 'nodeId', 'depth']), path, 'invalid_input_scope');
      if (typeof value.nodeId !== 'string' || !value.nodeId.trim()) {
        validation.push({
          path: `${path}.nodeId`,
          code: 'invalid_input_scope',
          message: 'node-children input requires a non-empty nodeId.',
        });
      }
      if (value.depth !== undefined && (!Number.isInteger(value.depth) || Number(value.depth) < 0)) {
        validation.push({
          path: `${path}.depth`,
          code: 'invalid_input_scope',
          message: 'node-children depth must be a non-negative integer.',
        });
      }
      return validation;
    }
    case 'tag-query': {
      const validation = branchValidation(value, new Set(['type', 'tag', 'includeArchived']), path, 'invalid_input_scope');
      if (typeof value.tag !== 'string' || !value.tag.trim()) {
        validation.push({
          path: `${path}.tag`,
          code: 'invalid_input_scope',
          message: 'tag-query input requires a non-empty tag.',
        });
      }
      if (value.includeArchived !== undefined && typeof value.includeArchived !== 'boolean') {
        validation.push({
          path: `${path}.includeArchived`,
          code: 'invalid_input_scope',
          message: 'tag-query includeArchived must be a boolean.',
        });
      }
      return validation;
    }
    case 'saved-query': {
      const validation = branchValidation(value, new Set(['type', 'queryId']), path, 'invalid_input_scope');
      if (typeof value.queryId !== 'string' || !value.queryId.trim()) {
        validation.push({
          path: `${path}.queryId`,
          code: 'invalid_input_scope',
          message: 'saved-query input requires a non-empty queryId.',
        });
      }
      return validation;
    }
    default:
      return [{
        path: `${path}.type`,
        code: 'invalid_input_scope',
        message: 'Issue input type must be none, selected-nodes, node-children, tag-query, or saved-query.',
      }];
  }
}

function validateIssueOutputPolicy(value: unknown, path: string): ValidationMessage[] {
  if (value === undefined) return [];
  if (!isRecord(value)) {
    return [{ path, code: 'invalid_output_policy', message: 'Issue output policy must be an object.' }];
  }
  switch (value.type) {
    case 'activity-only':
      return branchValidation(value, new Set(['type']), path, 'invalid_output_policy');
    case 'daily-note': {
      const validation = branchValidation(value, new Set(['type', 'datePolicy']), path, 'invalid_output_policy');
      if (value.datePolicy !== 'session-date' && value.datePolicy !== 'due-date') {
        validation.push({
          path: `${path}.datePolicy`,
          code: 'invalid_output_policy',
          message: 'daily-note output requires datePolicy session-date or due-date.',
        });
      }
      return validation;
    }
    case 'append-to-node':
    case 'create-child-under-node': {
      const validation = branchValidation(value, new Set(['type', 'nodeId']), path, 'invalid_output_policy');
      if (typeof value.nodeId !== 'string' || !value.nodeId.trim()) {
        validation.push({
          path: `${path}.nodeId`,
          code: 'invalid_output_policy',
          message: `${value.type} output requires a non-empty nodeId.`,
        });
      }
      return validation;
    }
    case 'per-input-child': {
      const validation = branchValidation(value, new Set(['type', 'parentNodeId']), path, 'invalid_output_policy');
      if (typeof value.parentNodeId !== 'string' || !value.parentNodeId.trim()) {
        validation.push({
          path: `${path}.parentNodeId`,
          code: 'invalid_output_policy',
          message: 'per-input-child output requires a non-empty parentNodeId.',
        });
      }
      return validation;
    }
    case 'replace-input': {
      const validation = branchValidation(value, new Set(['type', 'requiresConfirmation']), path, 'invalid_output_policy');
      if (value.requiresConfirmation !== true) {
        validation.push({
          path: `${path}.requiresConfirmation`,
          code: 'invalid_output_policy',
          message: 'replace-input output requires requiresConfirmation: true.',
        });
      }
      return validation;
    }
    default:
      return [{
        path: `${path}.type`,
        code: 'invalid_output_policy',
        message: 'Issue output type is not supported.',
      }];
  }
}

function validateIssueExecutionPolicy(value: unknown, path: string): ValidationMessage[] {
  if (value === undefined) return [];
  if (!isRecord(value)) {
    return [{ path, code: 'invalid_execution_policy', message: 'Issue execution policy must be an object.' }];
  }
  const validation = branchValidation(value, new Set(['deadlineAt']), path, 'invalid_execution_policy');
  if (typeof value.deadlineAt !== 'number' || !Number.isFinite(value.deadlineAt)) {
    validation.push({
      path: `${path}.deadlineAt`,
      code: 'invalid_execution_policy',
      message: 'Issue execution policy requires a finite deadlineAt timestamp.',
    });
  }
  return validation;
}

function branchValidation(
  value: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
  path: string,
  code: string,
): ValidationMessage[] {
  return unsupportedFieldMessages(value, allowedFields, path).map((message) => ({ ...message, code }));
}

function validateIssueRelationsInput(value: unknown, path: string): ValidationMessage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return [{ path, code: 'invalid_relations', message: 'Issue relations must be an array.' }];
  }
  const validation: ValidationMessage[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const candidatePath = `${path}.${index}`;
    if (
      !isRecord(candidate)
      || !['blocked-by', 'blocks', 'related', 'duplicate-of'].includes(String(candidate.type))
      || typeof candidate.issueId !== 'string'
      || !candidate.issueId.trim()
    ) {
      validation.push({
        path: candidatePath,
        code: 'invalid_relation',
        message: 'Each relation requires a supported type and a concrete Issue id.',
      });
      continue;
    }
    const unsupported = unsupportedFieldMessages(candidate, new Set(['type', 'issueId']), candidatePath);
    validation.push(...unsupported);
    const key = `${candidate.type}:${candidate.issueId}`;
    if (seen.has(key)) {
      validation.push({
        path: candidatePath,
        code: 'duplicate_relation',
        message: 'Duplicate Issue relations are not allowed.',
      });
    }
    seen.add(key);
  }
  return validation;
}

function validateStoredRelations(
  state: AgentIssueStoreState,
  relations: readonly IssueRelation[],
  ownerIssueId: string | undefined,
  path: string,
): ValidationMessage[] {
  const validation: ValidationMessage[] = [];
  const seen = new Set<string>();
  for (const [index, relation] of relations.entries()) {
    const relationPath = `${path}.${index}`;
    const key = `${relation.type}:${relation.issueId}`;
    if (seen.has(key)) {
      validation.push({
        path: relationPath,
        code: 'duplicate_relation',
        message: 'Duplicate Issue relations are not allowed.',
      });
    }
    seen.add(key);
    if (ownerIssueId && relation.issueId === ownerIssueId) {
      validation.push({
        path: relationPath,
        code: 'self_relation',
        message: 'An Issue cannot relate to itself.',
      });
      continue;
    }
    if (!state.issues[relation.issueId]) {
      validation.push({
        path: relationPath,
        code: 'relation_target_not_found',
        message: `Related Issue ${relation.issueId} was not found.`,
      });
    }
  }
  return validation;
}

function normalizeIssueTrigger(trigger: IssueTrigger): IssueTrigger {
  if (trigger.type === 'when-ready') return { type: 'when-ready' };
  return {
    type: 'scheduled',
    startAt: trigger.startAt,
    timeZone: normalizeRecurringIssueTimeZone(trigger.timeZone) ?? trigger.timeZone,
  };
}

function normalizeRecurringIssueTemplate(template: RecurringIssueTemplate): RecurringIssueTemplate {
  return template.trigger
    ? { ...template, trigger: normalizeIssueTrigger(template.trigger) }
    : { ...template };
}

function validateChangeEnvelope(value: Record<string, unknown>): ValidationMessage[] {
  const validation: ValidationMessage[] = [];
  const request = isRecord(value.request) ? value.request : null;
  if (!request || (request.mode !== 'preview' && request.mode !== 'request')) {
    validation.push({ path: 'request', code: 'invalid_request', message: 'request.mode must be preview or request.' });
  }
  if (typeof value.reason !== 'string' || !value.reason.trim()) {
    validation.push({ path: 'reason', code: 'required_field', message: 'A non-empty audit reason is required.' });
  }
  return validation;
}

function unsupportedFieldMessages(
  value: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
  pathPrefix: string,
): ValidationMessage[] {
  return Object.keys(value)
    .filter((key) => !allowedFields.has(key))
    .map((key) => ({
      path: `${pathPrefix}.${key}`,
      code: 'unsupported_field',
      message: `${key} is not valid for this target family.`,
    }));
}

function safeTargetFromUpdateInput(value: unknown): RelatedTargetRef | null {
  if (!isRecord(value) || !isRecord(value.target) || typeof value.target.id !== 'string') return null;
  if (value.target.type === 'issue') return { type: 'issue', id: value.target.id };
  if (value.target.type === 'recurring-issue') return { type: 'recurring-issue', id: value.target.id };
  return null;
}

function targetFromUpdateInput(input: IssueUpdateInput): RelatedTargetRef {
  return input.target.type === 'issue'
    ? { type: 'issue', id: input.target.id }
    : { type: 'recurring-issue', id: input.target.id };
}

function revisionForTarget(state: AgentIssueStoreState, target: RelatedTargetRef): string | undefined {
  if (target.type === 'issue') return state.issues[target.id]?.revision;
  if (target.type === 'recurring-issue') return state.recurringIssues[target.id]?.revision;
  if (target.type === 'agent-session') return state.sessions[target.id]?.revision;
  return undefined;
}

function issueSearchTextValues(
  issue: AgentIssue,
  state: AgentIssueStoreState,
): Array<string | undefined> {
  const sessions = Object.values(state.sessions).filter((session) => session.issueId === issue.id);
  return [
    issue.title,
    issue.description,
    ...issueActivity(state, issue).flatMap(activitySearchTextValues),
    ...sessions.flatMap((session) => [
      session.latestOutput,
      session.errorMessage,
    ]),
  ];
}

function recurringIssueSearchTextValues(
  recurringIssue: AgentRecurringIssue,
  state: AgentIssueStoreState | undefined,
): Array<string | undefined> {
  return [
    recurringIssue.titleTemplate,
    recurringIssue.descriptionTemplate,
    ...(state ? recurringIssueActivity(state, recurringIssue).flatMap(activitySearchTextValues) : []),
  ];
}

function activitySearchTextValues(activity: Activity): Array<string | undefined> {
  const content = activity.content;
  switch (content.type) {
    case 'comment':
    case 'agent-progress':
    case 'agent-question':
    case 'agent-response':
    case 'agent-error':
      return [content.body];
    case 'agent-action':
      return [content.action, content.parameter, content.result];
    case 'verification-result':
      return [content.verdict, content.body];
    case 'output-link':
      return [content.label, content.url, content.nodeId];
    case 'status-change':
      return [content.from, content.to];
    case 'field-change':
      return [content.field, stringSearchValue(content.from), stringSearchValue(content.to)];
    case 'updated':
      return content.fields ?? [];
    case 'created':
    case 'archived':
    case 'deleted':
      return [];
  }
}

function stringSearchValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function textMatches(values: Array<string | undefined>, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return values.some((value) => value?.toLowerCase().includes(needle));
}

function timeInRange(value: number | undefined, range: { from?: number; to?: number }): boolean {
  if (value === undefined) return false;
  if (range.from !== undefined && value < range.from) return false;
  if (range.to !== undefined && value > range.to) return false;
  return true;
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function hasGeneratedIssueForWindow(state: AgentIssueStoreState, recurringIssueId: string, windowStartAt: number): boolean {
  return Object.values(state.issues).some((issue) => (
    issue.recurrence?.recurringIssueId === recurringIssueId
    && issue.recurrence.windowStartAt === windowStartAt
  ));
}

function isSkippedRecurringWindow(recurringIssue: AgentRecurringIssue, windowStartAt: number): boolean {
  return recurringIssue.skippedMaterializationAts?.includes(windowStartAt) ?? false;
}

function renderRecurringTemplate(template: string, date: string): string {
  const rendered = template
    .replaceAll('{{date}}', date)
    .replaceAll('{date}', date)
    .trim();
  return rendered.includes(date) ? rendered : `${rendered} - ${date}`;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function cursorOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function revision(now: number): string {
  return `rev:${now}:${randomUUID().slice(0, 8)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
