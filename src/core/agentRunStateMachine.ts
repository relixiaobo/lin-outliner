import type { AgentObjectiveStatus, AgentRunStatus } from './agentEventLog';

export const RUN_EXECUTION_STATUS_TRANSITIONS = {
  running: ['running', 'completed', 'failed', 'cancelled'],
  completed: ['completed', 'running'],
  failed: ['failed', 'running'],
  cancelled: ['cancelled', 'running'],
} as const satisfies Record<AgentRunStatus, readonly AgentRunStatus[]>;

export const RUN_OBJECTIVE_STATUS_TRANSITIONS = {
  active: ['active', 'verifying', 'verified', 'blocked', 'budget_exhausted', 'stopped'],
  verifying: ['verifying', 'active', 'verified', 'blocked', 'budget_exhausted', 'stopped'],
  verified: ['verified', 'active', 'stopped'],
  blocked: ['blocked', 'active', 'budget_exhausted', 'stopped'],
  budget_exhausted: ['budget_exhausted', 'active', 'stopped'],
  stopped: ['stopped', 'active'],
} as const satisfies Record<AgentObjectiveStatus, readonly AgentObjectiveStatus[]>;

export function isValidRunExecutionStatusTransition(
  from: AgentRunStatus | undefined,
  to: AgentRunStatus,
): boolean {
  if (!from) return true;
  return (RUN_EXECUTION_STATUS_TRANSITIONS[from] as readonly AgentRunStatus[]).includes(to);
}

export function assertValidRunExecutionStatusTransition(
  from: AgentRunStatus | undefined,
  to: AgentRunStatus,
  context?: string,
): void {
  if (isValidRunExecutionStatusTransition(from, to)) return;
  throw new Error(`Invalid run execution status transition${context ? ` for ${context}` : ''}: ${from} -> ${to}`);
}

export function isValidRunObjectiveStatusTransition(
  from: AgentObjectiveStatus | undefined,
  to: AgentObjectiveStatus,
): boolean {
  if (!from) return true;
  return (RUN_OBJECTIVE_STATUS_TRANSITIONS[from] as readonly AgentObjectiveStatus[]).includes(to);
}

export function assertValidRunObjectiveStatusTransition(
  from: AgentObjectiveStatus | undefined,
  to: AgentObjectiveStatus,
  context?: string,
): void {
  if (isValidRunObjectiveStatusTransition(from, to)) return;
  throw new Error(`Invalid run objective status transition${context ? ` for ${context}` : ''}: ${from} -> ${to}`);
}
