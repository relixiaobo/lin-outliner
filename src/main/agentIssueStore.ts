import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  Activity,
  ActivityContent,
  ActivityTarget,
  AgentIssue,
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
  IssueUpdateInput,
  RecurringIssueCadence,
  RecurringIssueDraftFields,
  RecurringIssueUpdateChange,
  ResolvedIssueInput,
  RelatedTargetRef,
  TenonAgentToolResult,
  ValidationMessage,
} from '../core/agentIssue';
import {
  PRIVATE_JSON_FILE_OPTIONS,
  readJsonOrDefault,
  updateJsonFile,
} from './jsonFileStore';

const STORE_VERSION = 2;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_ACTIVITY_BODY_CHARS = 1_200;
const DEFAULT_ISSUE_STATUS: IssueStatus = { name: 'Triage', category: 'triage' };
const DEFAULT_ACTOR: ActorRef = { type: 'system' };

export const AGENT_ISSUE_STORE_FILE = 'issue-manager.json';

export interface AgentIssueStoreState {
  v: typeof STORE_VERSION;
  issues: Record<string, AgentIssue>;
  recurringIssues: Record<string, AgentRecurringIssue>;
  sessions: Record<string, AgentSession>;
  sessionExecutions: Record<string, AgentSessionExecutionBinding>;
  activity: Record<string, Activity>;
  activityOrder: string[];
}

export interface AgentSessionExecutionBinding {
  engine: 'delegation';
  conversationId: string;
  executionId: string;
  startedAt: number;
  updatedAt: number;
}

export interface AgentSessionExecutionSyncInput {
  engine: AgentSessionExecutionBinding['engine'];
  executionId: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  objectiveStatus?: 'active' | 'verifying' | 'verified' | 'blocked' | 'budget_exhausted' | 'stopped';
  latestOutput?: string;
  errorMessage?: string;
  completedAt?: number;
}

export type IssueInputResolver = (scope: IssueInputScope, issue: AgentIssue, now: number) => ResolvedIssueInput;

export class AgentIssueStore {
  constructor(private readonly filePath: string) {}

  static forAgentDataRoot(agentDataRoot: string): AgentIssueStore {
    return new AgentIssueStore(path.join(agentDataRoot, AGENT_ISSUE_STORE_FILE));
  }

  async state(): Promise<AgentIssueStoreState> {
    return readJsonOrDefault(this.filePath, emptyState(), parseState);
  }

  async search(input: IssueSearchInput = {}): Promise<IssueSearchResult> {
    const state = await this.state();
    const targets = input.targets?.length ? new Set(input.targets) : new Set(['issue', 'recurring-issue']);
    const rows: IssueSearchRow[] = [];
    if (targets.has('issue')) {
      for (const issue of Object.values(state.issues)) {
        if (matchesIssue(issue, state, input)) rows.push(issueRow(issue, state, input));
      }
    }
    if (targets.has('recurring-issue')) {
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

  async create(input: IssueCreateInput, actor: ActorRef = DEFAULT_ACTOR, now = Date.now()): Promise<TenonAgentToolResult> {
    if (input.request.mode === 'preview') {
      const target: RelatedTargetRef = { type: input.issueType, id: `preview:${randomUUID()}` } as RelatedTargetRef;
      return { status: 'preview', targets: [target] };
    }

    return updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      if (input.issueType === 'issue') {
        const issue = buildIssue(input.fields, actor, now);
        state.issues[issue.id] = issue;
        appendActivity(state, {
          target: { type: 'issue', issueId: issue.id },
          actor,
          content: { type: 'field-change', field: 'definition', to: 'created' },
          createdAt: now,
        });
        return state;
      }

      const recurringIssue = buildRecurringIssue(input.fields, actor, now);
      state.recurringIssues[recurringIssue.id] = recurringIssue;
      appendActivity(state, {
        target: { type: 'recurring-issue', recurringIssueId: recurringIssue.id },
        actor,
        content: { type: 'field-change', field: 'definition', to: 'created' },
        createdAt: now,
      });
      return state;
    }, PRIVATE_JSON_FILE_OPTIONS).then((state) => {
      const created = latestActivity(state);
      const target = created?.target ? relatedTargetFromActivityTarget(created.target) : undefined;
      if (!target) return { status: 'blocked', targets: [], validation: [{ code: 'not_found', message: 'Created target was not found.' }] };
      const targetRevision = revisionForTarget(state, target);
      if (!targetRevision) return { status: 'blocked', targets: [target], validation: [{ code: 'not_found', message: 'Created target revision was not found.' }] };
      return {
        status: 'applied',
        targets: [target, { type: 'activity', id: created!.id }],
        revisions: [{ target, revision: targetRevision }],
      };
    });
  }

  async update(input: IssueUpdateInput, actor: ActorRef = DEFAULT_ACTOR, now = Date.now()): Promise<TenonAgentToolResult> {
    if (input.request.mode === 'preview') {
      return { status: 'preview', targets: [targetFromUpdateInput(input)] };
    }

    const target = targetFromUpdateInput(input);
    const current = await this.state();
    const currentRevision = revisionForTarget(current, target);
    if (!currentRevision) {
      return { status: 'blocked', targets: [target], validation: [{ code: 'not_found', message: 'Target object was not found.' }] };
    }
    if (input.target.expectedRevision && input.target.expectedRevision !== currentRevision) {
      return {
        status: 'conflict',
        targets: [target],
        validation: [{ code: 'revision_mismatch', message: 'Target object changed since it was read.' }],
        revisions: [{ target, revision: currentRevision }],
      };
    }

    return updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      if (input.target.type === 'issue') {
        const issue = state.issues[input.target.id];
        if (!issue) return state;
        applyIssueChange(state, issue, input.change as IssueUpdateChange, actor, now);
        return state;
      }

      const recurringIssue = state.recurringIssues[input.target.id];
      if (!recurringIssue) return state;
      applyRecurringIssueChange(state, recurringIssue, input.change as RecurringIssueUpdateChange, actor, now);
      return state;
    }, PRIVATE_JSON_FILE_OPTIONS).then((state) => {
      const target = targetFromUpdateInput(input);
      const revision = revisionForTarget(state, target);
      if (!revision) {
        if (input.change.type === 'delete') {
          return { status: 'applied', targets: [target] };
        }
        return { status: 'blocked', targets: [target], validation: [{ code: 'not_found', message: 'Target object was not found.' }] };
      }
      return {
        status: 'applied',
        targets: [target],
        revisions: [{ target, revision }],
      };
    });
  }

  async startSession(
    input: AgentSessionStartInput,
    source: AgentSessionSource,
    actor: ActorRef = DEFAULT_ACTOR,
    now = Date.now(),
    options: { resolveInput?: IssueInputResolver } = {},
  ): Promise<TenonAgentToolResult> {
    if (input.request.mode === 'preview') {
      return { status: 'preview', targets: [{ type: 'issue', id: input.issueId }] };
    }

    const current = await this.state();
    const issue = current.issues[input.issueId];
    if (!issue) {
      return {
        status: 'blocked',
        targets: [{ type: 'issue', id: input.issueId }],
        validation: [{ code: 'not_found', message: 'Issue was not found.' }],
      };
    }
    if (input.expectedIssueRevision && input.expectedIssueRevision !== issue.revision) {
      return {
        status: 'conflict',
        targets: [{ type: 'issue', id: input.issueId }],
        validation: [{ code: 'revision_mismatch', message: 'Issue changed since it was read.' }],
        revisions: [{ target: { type: 'issue', id: issue.id }, revision: issue.revision }],
      };
    }
    const validation = validateSessionStart(current, issue, input);
    if (validation.length > 0) {
      return {
        status: 'blocked',
        targets: [{ type: 'issue', id: input.issueId }],
        validation,
        revisions: [{ target: { type: 'issue', id: issue.id }, revision: issue.revision }],
      };
    }

    return updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      const issue = state.issues[input.issueId];
      if (!issue) return state;
      const session = buildSession(issue, input, source, now, options.resolveInput);
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
      return state;
    }, PRIVATE_JSON_FILE_OPTIONS).then((state) => {
      const session = Object.values(state.sessions).sort((left, right) => right.createdAt - left.createdAt)[0];
      if (!session) {
        return {
          status: 'blocked',
          targets: [{ type: 'issue', id: input.issueId }],
          validation: [{ code: 'not_found_or_conflict', message: 'Issue was not found or revision did not match.' }],
        };
      }
      return {
        status: 'applied',
        targets: [{ type: 'issue', id: input.issueId }, { type: 'agent-session', id: session.id }],
        revisions: [{ target: { type: 'agent-session', id: session.id }, revision: session.revision }],
      };
    });
  }

  async readSession(input: AgentSessionReadInput): Promise<AgentSessionReadResult | null> {
    const state = await this.state();
    const agentSession = state.sessions[input.agentSessionId];
    if (!agentSession) return null;
    return {
      agentSession,
      ...(input.include?.includes('activity-summary') ? { activity: activityForTarget(state, { type: 'agent-session', agentSessionId: input.agentSessionId }) } : {}),
    };
  }

  async executionForSession(agentSessionId: AgentSessionId): Promise<AgentSessionExecutionBinding | undefined> {
    const state = await this.state();
    return state.sessionExecutions[agentSessionId];
  }

  async bindSessionExecution(
    agentSessionId: AgentSessionId,
    binding: Omit<AgentSessionExecutionBinding, 'updatedAt'>,
    actor: ActorRef = DEFAULT_ACTOR,
    now = Date.now(),
  ): Promise<TenonAgentToolResult> {
    const target: RelatedTargetRef = { type: 'agent-session', id: agentSessionId };
    return updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      const session = state.sessions[agentSessionId];
      if (!session) return state;
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
      if (session.state === 'complete' || session.state === 'canceled') return state;
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
  ): Promise<AgentSession | null> {
    let syncedSessionId: string | null = null;
    await updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      const entry = Object.entries(state.sessionExecutions).find(([, binding]) => (
        binding.engine === input.engine && binding.executionId === input.executionId
      ));
      if (!entry) return state;
      const [agentSessionId, binding] = entry;
      const session = state.sessions[agentSessionId];
      if (!session) return state;
      syncedSessionId = agentSessionId;
      binding.updatedAt = now;
      const previousState = session.state;
      const nextState = agentSessionStateFromExecution(input.state);
      session.state = nextState;
      session.latestOutput = input.latestOutput ?? session.latestOutput;
      session.errorMessage = input.errorMessage ?? session.errorMessage;
      if (nextState === 'active') session.startedAt ??= binding.startedAt;
      if (nextState !== 'active' && nextState !== 'pending') session.completedAt = input.completedAt ?? now;
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
        if (nextState === 'complete' && session.purpose === 'verify') {
          appendVerifierResultActivity(state, session, input, actor, now);
        }
      }
      if (nextState === 'complete' && session.purpose !== 'verify') {
        completeIssueFromSessionIfAllowed(state, session, input, actor, now);
      }
      return state;
    }, PRIVATE_JSON_FILE_OPTIONS);
    if (!syncedSessionId) return null;
    return (await this.readSession({ agentSessionId: syncedSessionId }))?.agentSession ?? null;
  }

  async sendSessionMessage(input: AgentSessionSendMessageInput, actor: ActorRef = DEFAULT_ACTOR, now = Date.now()): Promise<TenonAgentToolResult> {
    const target: RelatedTargetRef = { type: 'agent-session', id: input.agentSessionId };
    if (input.request.mode === 'preview') return { status: 'preview', targets: [target] };

    return updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      const session = state.sessions[input.agentSessionId];
      if (!session) return state;
      if (!canMessageSession(session.state)) return state;
      appendActivity(state, {
        target: { type: 'agent-session', agentSessionId: session.id },
        actor,
        content: input.kind === 'answer'
          ? { type: 'agent-response', body: activityBody(input.message, 'Session answer sent.') }
          : { type: 'comment', body: activityBody(input.message, 'Session guidance sent.') },
        relatedTargets: [{ type: 'issue', id: session.issueId }],
        createdAt: now,
      });
      if (session.state === 'awaitingInput') session.state = 'active';
      session.updatedAt = now;
      session.revision = revision(now);
      return state;
    }, PRIVATE_JSON_FILE_OPTIONS).then((state) => {
      const session = state.sessions[input.agentSessionId];
      if (!session) {
        return { status: 'blocked', targets: [target], validation: [{ code: 'not_found', message: 'Agent Session was not found.' }] };
      }
      if (!canMessageSession(session.state) && session.updatedAt !== now) {
        return { status: 'blocked', targets: [target], validation: [{ code: 'invalid_state', message: 'Agent Session cannot receive messages in its current state.' }] };
      }
      return {
        status: 'applied',
        targets: [target],
        revisions: [{ target, revision: session.revision }],
      };
    });
  }

  async stopSession(input: AgentSessionStopInput, actor: ActorRef = DEFAULT_ACTOR, now = Date.now()): Promise<TenonAgentToolResult> {
    const target: RelatedTargetRef = { type: 'agent-session', id: input.agentSessionId };
    if (input.request.mode === 'preview') return { status: 'preview', targets: [target] };

    return updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      const session = state.sessions[input.agentSessionId];
      if (!session || !canStopSession(session.state)) return state;
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
      return state;
    }, PRIVATE_JSON_FILE_OPTIONS).then((state) => {
      const session = state.sessions[input.agentSessionId];
      if (!session) {
        return { status: 'blocked', targets: [target], validation: [{ code: 'not_found', message: 'Agent Session was not found.' }] };
      }
      if (session.state !== 'canceled') {
        return { status: 'blocked', targets: [target], validation: [{ code: 'invalid_state', message: 'Only pending, active, or awaitingInput Sessions can be stopped.' }] };
      }
      return {
        status: 'applied',
        targets: [target],
        revisions: [{ target, revision: session.revision }],
      };
    });
  }

  async materializeDueRecurringIssues(now = Date.now(), actor: ActorRef = DEFAULT_ACTOR): Promise<AgentIssue[]> {
    const materialized: AgentIssue[] = [];
    await updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      for (const recurringIssue of Object.values(state.recurringIssues)) {
        if (recurringIssue.status !== 'active') continue;
        const dueAt = mostRecentDueAtOrBefore(recurringIssue.cadence, now, recurringIssue.createdAt);
        if (dueAt === null) {
          recurringIssue.nextMaterializationAt = nextDueAfter(recurringIssue.cadence, now) ?? undefined;
          continue;
        }
        if (isSkippedRecurringWindow(recurringIssue, dueAt)) {
          recurringIssue.nextMaterializationAt = nextDueAfter(recurringIssue.cadence, dueAt + 1) ?? undefined;
          recurringIssue.updatedAt = now;
          recurringIssue.revision = revision(now);
          continue;
        }
        if (hasGeneratedIssueForWindow(state, recurringIssue.id, dueAt)) {
          recurringIssue.nextMaterializationAt = nextDueAfter(recurringIssue.cadence, dueAt + 1) ?? undefined;
          continue;
        }
        const nextDue = nextDueAfter(recurringIssue.cadence, dueAt + 1);
        const skippedWindowCount = countSkippedWindows(state, recurringIssue, dueAt);
        const issue = issueFromRecurringIssue(recurringIssue, dueAt, nextDue ?? dueAt, now, skippedWindowCount);
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
            ...(skippedWindowCount > 0 ? { parameter: `coalesced:${skippedWindowCount}` } : {}),
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

  async markInterruptedSessionsStale(actor: ActorRef = DEFAULT_ACTOR, now = Date.now()): Promise<AgentSession[]> {
    const staleSessions: AgentSession[] = [];
    await updateJsonFile(this.filePath, emptyState(), parseState, (state) => {
      for (const session of Object.values(state.sessions)) {
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
    activity: isRecord(value.activity) ? value.activity as Record<string, Activity> : {},
    activityOrder: Array.isArray(value.activityOrder) ? value.activityOrder.filter((id): id is string => typeof id === 'string') : [],
  };
}

function buildIssue(fields: IssueDraftFields, actor: ActorRef, now: number): AgentIssue {
  return {
    id: `issue:${randomUUID()}`,
    title: fields.title.trim(),
    ...(fields.description !== undefined ? { description: fields.description } : {}),
    status: DEFAULT_ISSUE_STATUS,
    ...(fields.delegate ? { delegate: fields.delegate } : {}),
    relations: fields.relations ?? [],
    trigger: fields.trigger ?? { type: 'when-ready' },
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
    revision: revision(now),
    createdAt: now,
    updatedAt: now,
  };
}

function buildRecurringIssue(fields: RecurringIssueDraftFields, actor: ActorRef, now: number): AgentRecurringIssue {
  return {
    id: `recurring-issue:${randomUUID()}`,
    titleTemplate: fields.titleTemplate.trim(),
    ...(fields.descriptionTemplate !== undefined ? { descriptionTemplate: fields.descriptionTemplate } : {}),
    status: 'active',
    cadence: fields.cadence,
    timeZone: fields.timeZone,
    missedPolicy: fields.missedPolicy ?? { type: 'coalesce-latest' },
    issueTemplate: fields.issueTemplate,
    confirmation: { confirmedBy: actor, confirmedAt: now },
    nextMaterializationAt: nextDueAfter(fields.cadence, now) ?? undefined,
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
  const date = formatIssueWindowDate(windowStartAt);
  return {
    id: `issue:${randomUUID()}`,
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
    ...(template.executionPolicy ? { executionPolicy: template.executionPolicy } : {}),
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
      ...(issue.executionPolicy ?? { deadlineAt: now + 60 * 60 * 1000, retryPolicy: 'manual' as const }),
      ...(input.executionPolicyOverride ?? {}),
    },
    ...(input.continuation ? { continuationOfAgentSessionId: input.continuation.previousAgentSessionId } : {}),
    plan: [],
    revision: revision(now),
    createdAt: now,
    updatedAt: now,
  };
}

function applyIssueChange(
  state: AgentIssueStoreState,
  issue: AgentIssue,
  change: IssueUpdateChange,
  actor: ActorRef,
  now: number,
) {
  switch (change.type) {
    case 'patch':
      Object.assign(issue, change.patch);
      appendActivity(state, activityInput({ type: 'issue', issueId: issue.id }, actor, { type: 'field-change', field: 'patch', to: change.patch }, now));
      break;
    case 'transition':
      appendActivity(state, activityInput({ type: 'issue', issueId: issue.id }, actor, { type: 'status-change', from: issue.status.name, to: change.status.name }, now));
      issue.status = change.status;
      break;
    case 'archive':
      issue.archivedAt = now;
      appendActivity(state, activityInput({ type: 'issue', issueId: issue.id }, actor, { type: 'field-change', field: 'archivedAt', to: now }, now));
      break;
    case 'delete':
      delete state.issues[issue.id];
      appendActivity(state, activityInput({ type: 'issue', issueId: issue.id }, actor, { type: 'field-change', field: 'definition', to: 'deleted' }, now));
      return;
  }
  issue.updatedAt = now;
  issue.revision = revision(now);
}

function applyRecurringIssueChange(
  state: AgentIssueStoreState,
  recurringIssue: AgentRecurringIssue,
  change: RecurringIssueUpdateChange,
  actor: ActorRef,
  now: number,
) {
  switch (change.type) {
    case 'patch':
      Object.assign(recurringIssue, change.patch);
      appendActivity(state, activityInput({ type: 'recurring-issue', recurringIssueId: recurringIssue.id }, actor, { type: 'field-change', field: 'patch', to: change.patch }, now));
      break;
    case 'pause':
      recurringIssue.status = 'paused';
      appendActivity(state, activityInput({ type: 'recurring-issue', recurringIssueId: recurringIssue.id }, actor, { type: 'status-change', to: 'paused' }, now));
      break;
    case 'resume':
      recurringIssue.status = 'active';
      appendActivity(state, activityInput({ type: 'recurring-issue', recurringIssueId: recurringIssue.id }, actor, { type: 'status-change', to: 'active' }, now));
      break;
    case 'skip-next':
      {
        const skippedAt = recurringIssue.nextMaterializationAt ?? nextDueAfter(recurringIssue.cadence, now);
        if (skippedAt !== null && skippedAt !== undefined) {
          recurringIssue.skippedMaterializationAts = uniqueNumbers([...(recurringIssue.skippedMaterializationAts ?? []), skippedAt]);
          recurringIssue.nextMaterializationAt = nextDueAfter(recurringIssue.cadence, skippedAt + 1) ?? undefined;
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
      recurringIssue.status = 'archived';
      recurringIssue.archivedAt = now;
      appendActivity(state, activityInput({ type: 'recurring-issue', recurringIssueId: recurringIssue.id }, actor, { type: 'status-change', to: 'archived' }, now));
      break;
    case 'delete':
      delete state.recurringIssues[recurringIssue.id];
      appendActivity(state, activityInput({ type: 'recurring-issue', recurringIssueId: recurringIssue.id }, actor, { type: 'field-change', field: 'definition', to: 'deleted' }, now));
      return;
  }
  recurringIssue.updatedAt = now;
  recurringIssue.revision = revision(now);
}

function readFromState(state: AgentIssueStoreState, input: IssueReadInput): IssueReadResult {
  if (input.target.type === 'issue') {
    const issue = state.issues[input.target.id];
    return {
      target: input.target,
      ...(issue ? { issue } : {}),
      ...(issue && input.include?.includes('activity') ? { activity: activityForTarget(state, { type: 'issue', issueId: issue.id }) } : {}),
      ...(issue && input.include?.includes('sessions') ? { sessions: Object.values(state.sessions).filter((session) => session.issueId === issue.id) } : {}),
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
  if (input.text && !textMatches([issue.title, issue.description], input.text)) return false;
  if (filter?.ids && !filter.ids.includes(issue.id)) return false;
  if (filter?.issueIds && !filter.issueIds.includes(issue.id)) return false;
  if (filter?.delegateIds && !agentRefMatches(issue.delegate, filter.delegateIds)) return false;
  if (filter?.statusCategories && !filter.statusCategories.includes(issue.status.category) && !derivedIssueBuckets(issue, state).some((bucket) => filter.statusCategories!.includes(bucket))) return false;
  if (filter?.triggerTypes && !filter.triggerTypes.includes(issue.trigger.type)) return false;
  if (filter?.archived !== undefined && Boolean(issue.archivedAt) !== filter.archived) return false;
  if (filter?.hasActiveSession !== undefined && issueHasActiveSession(issue, state) !== filter.hasActiveSession) return false;
  if (filter?.needsAttention !== undefined && issueNeedsAttention(issue, state) !== filter.needsAttention) return false;
  if (filter?.dueDate && !timeInRange(issue.dueDate?.targetAt, filter.dueDate)) return false;
  if (filter?.createdAt && !timeInRange(issue.createdAt, filter.createdAt)) return false;
  if (filter?.updatedAt && !timeInRange(issue.updatedAt, filter.updatedAt)) return false;
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
  if (input.text && !textMatches([recurringIssue.titleTemplate, recurringIssue.descriptionTemplate], input.text)) return false;
  if (filter?.ids && !filter.ids.includes(recurringIssue.id)) return false;
  if (filter?.recurringIssueIds && !filter.recurringIssueIds.includes(recurringIssue.id)) return false;
  if (filter?.delegateIds && !agentRefMatches(recurringIssue.issueTemplate.delegate, filter.delegateIds)) return false;
  if (filter?.statusCategories && !derivedRecurringIssueBuckets(recurringIssue).some((bucket) => filter.statusCategories!.includes(bucket))) return false;
  if (filter?.triggerTypes && !filter.triggerTypes.includes((recurringIssue.issueTemplate.trigger ?? { type: 'when-ready' }).type)) return false;
  if (filter?.cadence && !filter.cadence.includes(recurringIssue.cadence.type)) return false;
  if (filter?.archived !== undefined && Boolean(recurringIssue.archivedAt || recurringIssue.status === 'archived') !== filter.archived) return false;
  if (filter?.nextMaterializationAt && !timeInRange(recurringIssue.nextMaterializationAt, filter.nextMaterializationAt)) return false;
  if (filter?.inputNodeIds && !inputScopeMatchesNodeIds(recurringIssue.issueTemplate.input, filter.inputNodeIds)) return false;
  if (filter?.inputTags && !inputScopeMatchesTags(recurringIssue.issueTemplate.input, filter.inputTags)) return false;
  if (filter?.activityTypes && state && !recurringIssueActivity(state, recurringIssue).some((activity) => filter.activityTypes!.includes(activity.content.type))) return false;
  if (filter?.activityTarget && !sameActivityTarget(filter.activityTarget, { type: 'recurring-issue', recurringIssueId: recurringIssue.id })) return false;
  return true;
}

function derivedIssueBuckets(issue: AgentIssue, state: AgentIssueStoreState): IssueViewBucket[] {
  const buckets: IssueViewBucket[] = [];
  if (issue.archivedAt) buckets.push('archived');
  if (issue.trigger.type === 'scheduled') buckets.push('scheduled');
  if (issue.relations.some((relation) => relation.type === 'blocked-by')) buckets.push('blocked');
  const sessions = Object.values(state.sessions).filter((session) => session.issueId === issue.id);
  if (sessions.some((session) => session.state === 'error' || session.state === 'awaitingInput' || session.state === 'stale')) buckets.push('attention-needed');
  return buckets;
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
  if (issueHasAnySession(issue, state)) return false;
  if (issue.relations.some((relation) => relation.type === 'blocked-by' && !isBlockingIssueCompleted(state.issues[relation.issueId]))) return false;
  if (issue.trigger.type === 'when-ready') return true;
  return issue.trigger.startAt <= now;
}

function validateSessionStart(
  state: AgentIssueStoreState,
  issue: AgentIssue,
  input: AgentSessionStartInput,
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
  if (issueHasActiveSession(issue, state)) {
    messages.push({ code: 'active_session_exists', message: 'Issue already has a pending, active, or waiting Agent Session.' });
  }
  for (const relation of issue.relations) {
    if (relation.type !== 'blocked-by') continue;
    if (!isBlockingIssueCompleted(state.issues[relation.issueId])) {
      messages.push({ code: 'blocked_by_issue', message: `Issue is blocked by ${relation.issueId}.` });
    }
  }
  const continuation = input.continuation;
  if (continuation) {
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

function issueHasActiveSession(issue: AgentIssue, state: AgentIssueStoreState): boolean {
  return Object.values(state.sessions).some((session) => (
    session.issueId === issue.id
    && (session.state === 'pending' || session.state === 'active' || session.state === 'awaitingInput')
  ));
}

function issueHasAnySession(issue: AgentIssue, state: AgentIssueStoreState): boolean {
  return Object.values(state.sessions).some((session) => session.issueId === issue.id);
}

function isBlockingIssueCompleted(issue: AgentIssue | undefined): boolean {
  return Boolean(issue && issue.status.category === 'completed');
}

function issueNeedsAttention(issue: AgentIssue, state: AgentIssueStoreState): boolean {
  return derivedIssueBuckets(issue, state).includes('attention-needed')
    || issue.relations.some((relation) => relation.type === 'blocked-by' && !isBlockingIssueCompleted(state.issues[relation.issueId]));
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
    ? sortActivityDescending(issueActivity(state, issue))
    : undefined;
  const latestSession = latestSessionForIssue(issue, state);
  return {
    target: { type: 'issue', id: issue.id },
    title: issue.title,
    status: issue.status.name,
    statusCategory: issue.status.category,
    viewBuckets: issueViewBuckets(issue, state),
    trigger: issue.trigger,
    ...(issue.dueDate ? { dueDate: issue.dueDate } : {}),
    hasActiveSession: issueHasActiveSession(issue, state),
    needsAttention: issueNeedsAttention(issue, state),
    ...(latestSession ? {
      latestSessionState: latestSession.state,
      latestSessionUpdatedAt: latestSession.updatedAt,
    } : {}),
    revision: issue.revision,
    updatedAt: issue.updatedAt,
    ...(activity ? { latestActivity: activity[0], activityCount: activity.length } : {}),
  };
}

function recurringIssueRow(
  recurringIssue: AgentRecurringIssue,
  state: AgentIssueStoreState,
  input: IssueSearchInput,
): IssueSearchRow {
  const activity = input.include?.includes('activity-summary')
    ? sortActivityDescending(recurringIssueActivity(state, recurringIssue))
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
  return [...activity].sort((left, right) => right.createdAt - left.createdAt);
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
) {
  const issue = state.issues[session.issueId];
  if (!issue || issue.verificationPolicy?.mode !== 'agent-review') return;
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
}

function verifierVerdictFromText(text: string): 'pass' | 'fail' | 'partial' {
  const normalized = text.trim().toLocaleLowerCase();
  if (/^(verdict:\s*)?pass\b/u.test(normalized)) return 'pass';
  if (/^(verdict:\s*)?fail\b/u.test(normalized)) return 'fail';
  if (/^(verdict:\s*)?(partial|pass-or-partial)\b/u.test(normalized)) return 'partial';
  return 'partial';
}

function completeIssueFromSessionIfAllowed(
  state: AgentIssueStoreState,
  session: AgentSession,
  input: AgentSessionExecutionSyncInput,
  actor: ActorRef,
  now: number,
) {
  const issue = state.issues[session.issueId];
  if (!issue || issue.status.category === 'completed' || issue.status.category === 'canceled') return;
  const verificationMode = issue.verificationPolicy?.mode ?? 'none';
  if (verificationMode === 'human-review') return;
  if (verificationMode === 'agent-review' && input.objectiveStatus !== 'verified') return;

  issue.evidence = [
    ...(issue.evidence ?? []).filter((entry) => !(entry.type === 'agent-session' && entry.agentSessionId === session.id)),
    { type: 'agent-session', agentSessionId: session.id },
  ];
  if (issue.completionCriteria) {
    issue.completionCriteria = issue.completionCriteria.map((criterion) => (
      criterion.state === 'open'
        ? {
            ...criterion,
            state: 'met',
            evidence: [
              ...(criterion.evidence ?? []).filter((entry) => !(entry.type === 'agent-session' && entry.agentSessionId === session.id)),
              { type: 'agent-session', agentSessionId: session.id },
            ],
          }
        : criterion
    ));
  }
  appendActivity(state, activityInput(
    { type: 'issue', issueId: issue.id },
    actor,
    { type: 'status-change', from: issue.status.name, to: 'Completed' },
    now,
  ));
  issue.status = { name: 'Completed', category: 'completed' };
  issue.updatedAt = now;
  issue.revision = revision(now);
}

function canMessageSession(state: AgentSession['state']): boolean {
  return state === 'pending' || state === 'active' || state === 'awaitingInput';
}

function canStopSession(state: AgentSession['state']): boolean {
  return state === 'pending' || state === 'active' || state === 'awaitingInput';
}

function isRecoverableLiveSession(state: AgentSession['state']): boolean {
  return state === 'pending' || state === 'active' || state === 'awaitingInput';
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
    case 'awaitingInput':
      return { type: 'agent-question', body: activityBody(input.errorMessage, 'Agent Session needs input.') };
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

function latestActivity(state: AgentIssueStoreState): Activity | null {
  const id = state.activityOrder.at(-1);
  return id ? state.activity[id] ?? null : null;
}

function relatedTargetFromActivityTarget(target: ActivityTarget): RelatedTargetRef {
  if (target.type === 'issue') return { type: 'issue', id: target.issueId };
  if (target.type === 'recurring-issue') return { type: 'recurring-issue', id: target.recurringIssueId };
  return { type: 'agent-session', id: target.agentSessionId };
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

function countSkippedWindows(
  state: AgentIssueStoreState,
  recurringIssue: AgentRecurringIssue,
  dueAt: number,
): number {
  const generatedWindowStarts = Object.values(state.issues)
    .map((issue) => issue.recurrence?.recurringIssueId === recurringIssue.id ? issue.recurrence.windowStartAt : undefined)
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => right - left);
  const boundary = generatedWindowStarts[0] ?? recurringIssue.createdAt;
  let cursor = nextDueAfter(recurringIssue.cadence, boundary);
  let skipped = 0;
  let guard = 0;
  while (cursor !== null && cursor < dueAt && guard < 10_000) {
    if (!hasGeneratedIssueForWindow(state, recurringIssue.id, cursor) && !isSkippedRecurringWindow(recurringIssue, cursor)) skipped += 1;
    cursor = nextDueAfter(recurringIssue.cadence, cursor + 1);
    guard += 1;
  }
  return skipped;
}

function mostRecentDueAtOrBefore(cadence: RecurringIssueCadence, now: number, notBefore: number): number | null {
  switch (cadence.type) {
    case 'daily': {
      const candidate = localDateWithTime(now, cadence.time);
      const due = candidate <= now ? candidate : addLocalDaysMs(candidate, -1);
      return due >= notBefore ? due : null;
    }
    case 'weekly': {
      for (let offset = 0; offset >= -14; offset -= 1) {
        const day = addLocalDaysMs(startOfLocalDay(now), offset);
        const weekday = new Date(day).getDay();
        if (!cadence.weekdays.includes(weekday)) continue;
        const due = localDateWithTime(day, cadence.time);
        if (due <= now && due >= notBefore) return due;
      }
      return null;
    }
    case 'monthly': {
      for (let offset = 0; offset >= -2; offset -= 1) {
        const base = new Date(now);
        const due = localMonthDateWithTime(base.getFullYear(), base.getMonth() + offset, cadence.dayOfMonth, cadence.time);
        if (due !== null && due <= now && due >= notBefore) return due;
      }
      return null;
    }
  }
}

function nextDueAfter(cadence: RecurringIssueCadence, after: number): number | null {
  switch (cadence.type) {
    case 'daily': {
      const candidate = localDateWithTime(after, cadence.time);
      return candidate > after ? candidate : addLocalDaysMs(candidate, 1);
    }
    case 'weekly': {
      for (let offset = 0; offset <= 14; offset += 1) {
        const day = addLocalDaysMs(startOfLocalDay(after), offset);
        const weekday = new Date(day).getDay();
        if (!cadence.weekdays.includes(weekday)) continue;
        const due = localDateWithTime(day, cadence.time);
        if (due > after) return due;
      }
      return null;
    }
    case 'monthly': {
      const base = new Date(after);
      for (let offset = 0; offset <= 13; offset += 1) {
        const due = localMonthDateWithTime(base.getFullYear(), base.getMonth() + offset, cadence.dayOfMonth, cadence.time);
        if (due !== null && due > after) return due;
      }
      return null;
    }
  }
}

function localDateWithTime(baseMs: number, time: string): number {
  const [hour, minute] = parseLocalTime(time);
  const base = new Date(baseMs);
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0).getTime();
}

function localMonthDateWithTime(year: number, month: number, dayOfMonth: number, time: string): number | null {
  const [hour, minute] = parseLocalTime(time);
  const date = new Date(year, month, dayOfMonth, hour, minute, 0, 0);
  return date.getMonth() === ((month % 12) + 12) % 12 ? date.getTime() : null;
}

function parseLocalTime(time: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return [0, 0];
  return [
    Math.max(0, Math.min(23, Number(match[1]))),
    Math.max(0, Math.min(59, Number(match[2]))),
  ];
}

function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function addLocalDaysMs(ms: number, days: number): number {
  const date = new Date(ms);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + days,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  ).getTime();
}

function renderRecurringTemplate(template: string, date: string): string {
  const rendered = template
    .replaceAll('{{date}}', date)
    .replaceAll('{date}', date)
    .trim();
  return rendered.includes(date) ? rendered : `${rendered} - ${date}`;
}

function formatIssueWindowDate(ms: number): string {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
