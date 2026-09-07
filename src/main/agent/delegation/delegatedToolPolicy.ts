import type { DelegateAccess, DelegateTaskProfile } from '../../../delegate/contract';
import {
  canonicalModelToolKey,
  isReadOnlyModelToolActionKind,
  type ModelToolActionKind,
  type ModelToolContract,
} from '../../../core/agent/tools';
import type { BashStdinConsumer } from '../capabilities/agentCapabilities';

export interface DelegatedToolPolicy {
  readonly profile: DelegateTaskProfile;
  readonly access: DelegateAccess;
}

const HARD_BLOCKED_ACTIONS = new Set<ModelToolActionKind>([
  'agent.user_input.request',
  'agent.goal.read',
  'agent.goal.create',
  'agent.goal.update',
  'agent.automation.manage',
  'shell.background_process',
  'shell.stop',
  'task.inspect',
  'task.stop',
  'thread.history.search',
  'thread.history.read',
]);

const SESSION_LOCAL_CONTROL_ACTIONS = new Set<ModelToolActionKind>([
  'agent.plan.update',
  'agent.skill.invoke',
]);

export function filterDelegatedToolContracts(
  rootCeiling: readonly ModelToolContract[],
  policy: DelegatedToolPolicy,
): readonly ModelToolContract[] {
  assertDelegatedToolPolicy(policy);
  return rootCeiling.filter((tool) => delegatedToolContractAllowed(tool, policy));
}

export function delegatedToolContractAllowed(
  tool: ModelToolContract,
  policy: DelegatedToolPolicy,
): boolean {
  assertDelegatedToolPolicy(policy);
  if (tool.scope === 'rootThread') return false;
  const key = canonicalModelToolKey(tool.identity);
  // Bash has a broad static contract; every invocation is classified and
  // checked again by delegatedBashExecutionAllowed before execution.
  if (key === 'bash') return true;
  if (tool.actionKinds.some((kind) => HARD_BLOCKED_ACTIONS.has(kind))) return false;
  if (tool.actionKinds.length === 0) return false;
  if (policy.access === 'workspace-write' && policy.profile === 'general') return true;
  return tool.actionKinds.every((kind) => (
    isReadOnlyModelToolActionKind(kind) || SESSION_LOCAL_CONTROL_ACTIONS.has(kind)
  ));
}

export function delegatedToolExecutionAllowed(
  policy: DelegatedToolPolicy,
  actionKinds: readonly ModelToolActionKind[],
): boolean {
  assertDelegatedToolPolicy(policy);
  if (actionKinds.length === 0 || actionKinds.some((kind) => HARD_BLOCKED_ACTIONS.has(kind))) return false;
  if (policy.access === 'workspace-write' && policy.profile === 'general') return true;
  return actionKinds.every((kind) => (
    isReadOnlyModelToolActionKind(kind) || SESSION_LOCAL_CONTROL_ACTIONS.has(kind)
  ));
}

export function delegatedBashExecutionAllowed(
  policy: DelegatedToolPolicy,
  actionKinds: readonly ModelToolActionKind[],
  stdinConsumer: BashStdinConsumer,
  runInBackground: boolean,
): boolean {
  assertDelegatedToolPolicy(policy);
  if (runInBackground || actionKinds.includes('shell.background_process')) return false;
  if (actionKinds.length === 0 || actionKinds.some((kind) => HARD_BLOCKED_ACTIONS.has(kind))) return false;
  if (policy.access === 'workspace-write' && policy.profile === 'general') return true;
  if (stdinConsumer !== 'absent' && stdinConsumer !== 'registered-data') return false;
  return actionKinds.every(isReadOnlyModelToolActionKind);
}

function assertDelegatedToolPolicy(policy: DelegatedToolPolicy): void {
  if ((policy.profile === 'explore' || policy.profile === 'plan') && policy.access !== 'read-only') {
    throw new Error(`${policy.profile} delegation requires read-only access`);
  }
}
