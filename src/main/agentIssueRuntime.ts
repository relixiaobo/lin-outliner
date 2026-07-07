import type {
  AgentOperationScope,
  AgentSessionStartInput,
  ActorRef,
  IssueCreateInput,
  IssueUpdateInput,
  RuntimeAuthorizationCapability,
  TenonAgentToolResult,
} from '../core/agentIssue';
import type { AgentIssueToolRuntime } from './agentIssueTools';
import type { AgentIssueStore } from './agentIssueStore';

export interface AgentIssueToolRuntimeOptions {
  store: AgentIssueStore;
  actor: ActorRef;
  authorization?: RuntimeAuthorizationCapability;
  now?: () => number;
}

export function createAgentIssueToolRuntime(options: AgentIssueToolRuntimeOptions): AgentIssueToolRuntime {
  const now = () => options.now?.() ?? Date.now();
  return {
    search: (input) => options.store.search(input),
    read: (input) => options.store.read(input),
    create: (input) => createIssue(options, input, now()),
    update: (input) => updateIssue(options, input, now()),
    startSession: (input) => startSession(options, input, now()),
    readSession: (input) => options.store.readSession(input),
    sendSessionMessage: (input) => (
      hasAuthorization(options.authorization, { type: 'agent-session-message', agentSessionId: input.agentSessionId }, now())
        ? options.store.sendSessionMessage(input, options.actor, now())
        : needsConfirmation('Message Agent Session', 'Send this message to the running Agent Session.', { type: 'agent-session-message', agentSessionId: input.agentSessionId }, [{ type: 'agent-session', id: input.agentSessionId }])
    ),
    stopSession: (input) => (
      hasAuthorization(options.authorization, { type: 'agent-session-stop', agentSessionId: input.agentSessionId }, now())
        ? options.store.stopSession(input, options.actor, now())
        : needsConfirmation('Stop Agent Session', 'Stop this Agent Session and mark it canceled.', { type: 'agent-session-stop', agentSessionId: input.agentSessionId }, [{ type: 'agent-session', id: input.agentSessionId }])
    ),
  };
}

async function createIssue(
  options: AgentIssueToolRuntimeOptions,
  input: IssueCreateInput,
  now: number,
): Promise<TenonAgentToolResult> {
  return options.store.create(input, options.actor, now);
}

async function updateIssue(
  options: AgentIssueToolRuntimeOptions,
  input: IssueUpdateInput,
  now: number,
): Promise<TenonAgentToolResult> {
  if (input.request.mode === 'preview') return options.store.update(input, options.actor, now);
  const scope: AgentOperationScope = input.target.type === 'issue'
    ? { type: 'issue-update', issueId: input.target.id }
    : { type: 'recurring-issue-update', recurringIssueId: input.target.id };
  if (requiresIssueUpdateAuthorization(input) && !hasAuthorization(options.authorization, scope, now)) {
    return needsConfirmation(
      'Confirm Issue change',
      'Apply this execution-enabling or lifecycle Issue change.',
      scope,
      [input.target.type === 'issue' ? { type: 'issue', id: input.target.id } : { type: 'recurring-issue', id: input.target.id }],
    );
  }
  return options.store.update(input, options.actor, now);
}

async function startSession(
  options: AgentIssueToolRuntimeOptions,
  input: AgentSessionStartInput,
  now: number,
): Promise<TenonAgentToolResult> {
  if (input.request.mode === 'preview') {
    return options.store.startSession(input, { type: 'runtime-authorized-action', actor: options.actor }, options.actor, now);
  }
  const scope: AgentOperationScope = { type: 'agent-session-start', issueId: input.issueId };
  if (!hasAuthorization(options.authorization, scope, now)) {
    return needsConfirmation(
      'Start Agent Session',
      'Start one Agent Session for this Issue.',
      scope,
      [{ type: 'issue', id: input.issueId }],
    );
  }
  return options.store.startSession(input, { type: 'runtime-authorized-action', actor: options.actor }, options.actor, now);
}

function requiresIssueUpdateAuthorization(input: IssueUpdateInput): boolean {
  if (input.change.type === 'confirm' || input.change.type === 'delete' || input.change.type === 'archive') return true;
  if (input.change.type === 'pause' || input.change.type === 'resume' || input.change.type === 'skip-next') return true;
  if (input.change.type === 'patch') {
    return 'trigger' in input.change.patch
      || 'permissionMode' in input.change.patch
      || 'executionPolicy' in input.change.patch
      || 'issueTemplate' in input.change.patch;
  }
  return false;
}

function hasAuthorization(
  authorization: RuntimeAuthorizationCapability | undefined,
  required: AgentOperationScope,
  now: number,
): boolean {
  if (!authorization || authorization.expiresAt < now) return false;
  return authorization.allowedOperations.some((operation) => operationMatches(operation, required));
}

function operationMatches(allowed: AgentOperationScope, required: AgentOperationScope): boolean {
  if (allowed.type !== required.type) return false;
  switch (required.type) {
    case 'issue-create':
      return true;
    case 'issue-update':
      return allowed.type === 'issue-update' && (!allowed.issueId || allowed.issueId === required.issueId);
    case 'recurring-issue-update':
      return allowed.type === 'recurring-issue-update' && (!allowed.recurringIssueId || allowed.recurringIssueId === required.recurringIssueId);
    case 'agent-session-start':
      return allowed.type === 'agent-session-start' && (!allowed.issueId || allowed.issueId === required.issueId);
    case 'agent-session-message':
      return allowed.type === 'agent-session-message' && (!allowed.agentSessionId || allowed.agentSessionId === required.agentSessionId);
    case 'agent-session-stop':
      return allowed.type === 'agent-session-stop' && (!allowed.agentSessionId || allowed.agentSessionId === required.agentSessionId);
  }
}

function needsConfirmation(
  title: string,
  body: string,
  operation: AgentOperationScope,
  targets: TenonAgentToolResult['targets'],
): TenonAgentToolResult {
  return {
    status: 'needs-confirmation',
    targets,
    confirmation: {
      title,
      body,
      operation,
      targets,
    },
  };
}
