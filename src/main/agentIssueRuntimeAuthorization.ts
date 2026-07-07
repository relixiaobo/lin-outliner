import type {
  AgentOperationScope,
  AgentSessionSendMessageInput,
  AgentSessionStartInput,
  AgentSessionStopInput,
  IssueUpdateInput,
  IssueUpdateChange,
  RecurringIssueUpdateChange,
} from '../core/agentIssue';

export function agentIssueRuntimeAuthorizationScope(toolNameInput: string, input: unknown): AgentOperationScope | null {
  const toolName = toolNameInput.toLowerCase();
  if (!hasRequestMode(input)) return null;

  if (toolName === 'issue_update') {
    const update = input as IssueUpdateInput;
    if (!issueUpdateRequiresRuntimeAuthorization(update.change)) return null;
    if (update.target?.type === 'issue') return { type: 'issue-update', issueId: update.target.id };
    if (update.target?.type === 'recurring-issue') return { type: 'recurring-issue-update', recurringIssueId: update.target.id };
    return null;
  }

  if (toolName === 'agent_session_start') {
    const start = input as AgentSessionStartInput;
    return typeof start.issueId === 'string' ? { type: 'agent-session-start', issueId: start.issueId } : null;
  }

  if (toolName === 'agent_session_send_message') {
    const message = input as AgentSessionSendMessageInput;
    return typeof message.agentSessionId === 'string'
      ? { type: 'agent-session-message', agentSessionId: message.agentSessionId }
      : null;
  }

  if (toolName === 'agent_session_stop') {
    const stop = input as AgentSessionStopInput;
    return typeof stop.agentSessionId === 'string' ? { type: 'agent-session-stop', agentSessionId: stop.agentSessionId } : null;
  }

  return null;
}

export function issueUpdateRequiresRuntimeAuthorization(change: IssueUpdateChange | RecurringIssueUpdateChange | undefined): boolean {
  if (!change) return false;
  if (change.type === 'confirm' || change.type === 'delete' || change.type === 'archive') return true;
  if (change.type === 'pause' || change.type === 'resume' || change.type === 'skip-next') return true;
  if (change.type === 'patch') {
    return 'trigger' in change.patch
      || 'permissionMode' in change.patch
      || 'executionPolicy' in change.patch
      || 'issueTemplate' in change.patch;
  }
  return false;
}

export function agentIssueOperationMatches(allowed: AgentOperationScope, required: AgentOperationScope): boolean {
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

function hasRequestMode(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const request = (input as { request?: unknown }).request;
  return Boolean(request && typeof request === 'object' && (request as { mode?: unknown }).mode === 'request');
}
