import type { AgentSafetyMode } from './types';

export type GlobalToolPermissionDecision = 'allow' | 'ask' | 'deny';

export interface AgentPermissionDecisionOverrides {
  allow: readonly string[];
  ask?: readonly string[];
  deny: readonly string[];
}

export const SUPPORTED_AGENT_TOOL_ACTION_KINDS = [
  'file.read.allowed_file_area',
  'file.read.outside_allowed_file_area',
  'file.read.sensitive_local_path',
  'file.edit.allowed_file_area',
  'file.write.allowed_file_area',
  'file.write.outside_allowed_file_area',
  'file.write.sensitive_local_path',
  'file.delete.allowed_file_area',
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
  'shell.sandbox_override',
  'shell.unknown',
  'git.publish_remote',
  'deploy.publish_remote',
  'external.message.send',
  'task.stop',
  'agent.memory.recall',
  'agent.memory.dream',
  'agent.user_question.ask',
  'agent.runtime.status',
  'agent.config.read',
  'agent.config.write',
  'agent.doctor.run',
  'agent.skill.invoke',
  'agent.delegate.spawn',
  'agent.delegate.status',
  'agent.delegate.send',
  'agent.delegate.stop',
  'agent.permission.modify',
  'payment.purchase',
] as const;

export type AgentToolActionKind = typeof SUPPORTED_AGENT_TOOL_ACTION_KINDS[number];

const DEFAULT_ACTION_DECISIONS = {
  'file.read.allowed_file_area': 'allow',
  'file.read.outside_allowed_file_area': 'ask',
  'file.read.sensitive_local_path': 'ask',
  'file.edit.allowed_file_area': 'allow',
  'file.write.allowed_file_area': 'allow',
  'file.write.outside_allowed_file_area': 'ask',
  'file.write.sensitive_local_path': 'ask',
  'file.delete.allowed_file_area': 'ask',
  'outline.read': 'allow',
  'outline.edit': 'allow',
  'outline.delete': 'ask',
  'web.search': 'allow',
  'web.fetch': 'ask',
  'shell.read_search': 'allow',
  'shell.project_script': 'ask',
  'shell.local_code_execution': 'ask',
  'shell.dependency_install': 'ask',
  'shell.network_write': 'ask',
  'shell.destructive_cleanup': 'ask',
  'shell.background_process': 'ask',
  'shell.sandbox_override': 'ask',
  'shell.unknown': 'deny',
  'git.publish_remote': 'ask',
  'deploy.publish_remote': 'ask',
  'external.message.send': 'ask',
  'task.stop': 'allow',
  'agent.memory.recall': 'allow',
  'agent.memory.dream': 'ask',
  'agent.user_question.ask': 'allow',
  'agent.runtime.status': 'allow',
  'agent.config.read': 'allow',
  'agent.config.write': 'ask',
  'agent.doctor.run': 'allow',
  'agent.skill.invoke': 'allow',
  'agent.delegate.spawn': 'ask',
  'agent.delegate.status': 'allow',
  'agent.delegate.send': 'allow',
  'agent.delegate.stop': 'allow',
  'agent.permission.modify': 'deny',
  'payment.purchase': 'deny',
} satisfies Record<AgentToolActionKind, GlobalToolPermissionDecision>;

const ASK_FIRST_ASK_ACTIONS = new Set<AgentToolActionKind>([
  'file.edit.allowed_file_area',
  'outline.edit',
  'agent.skill.invoke',
]);

const FULL_ACCESS_ALLOW_ACTIONS = new Set<AgentToolActionKind>([
  'file.edit.allowed_file_area',
  'file.delete.allowed_file_area',
  'outline.edit',
  'outline.delete',
  'web.fetch',
  'shell.local_code_execution',
  'shell.project_script',
  'shell.dependency_install',
  'shell.network_write',
  'git.publish_remote',
  'agent.delegate.spawn',
  'agent.memory.dream',
  'shell.background_process',
]);

const SUPPORTED_ACTION_KIND_SET = new Set<string>(SUPPORTED_AGENT_TOOL_ACTION_KINDS);

export function defaultActionDecision(actionKind: AgentToolActionKind): GlobalToolPermissionDecision {
  return DEFAULT_ACTION_DECISIONS[actionKind];
}

export function actionKindRuleValue(actionKind: AgentToolActionKind): string {
  return `Action(${actionKind})`;
}

export function actionKindFromRuleValue(ruleValueInput: string): AgentToolActionKind | null {
  const ruleValue = ruleValueInput.trim();
  const match = /^Action\(([^)]+)\)$/.exec(ruleValue);
  const actionKind = match?.[1];
  return actionKind && SUPPORTED_ACTION_KIND_SET.has(actionKind)
    ? actionKind as AgentToolActionKind
    : null;
}

export function explicitActionDecision(
  actionKind: AgentToolActionKind,
  overrides: AgentPermissionDecisionOverrides,
): GlobalToolPermissionDecision | null {
  const ruleValue = actionKindRuleValue(actionKind);
  if (overrides.deny.includes(ruleValue)) return 'deny';
  if (overrides.ask?.includes(ruleValue)) return 'ask';
  if (overrides.allow.includes(ruleValue)) return 'allow';
  return null;
}

export function safetyModeDefaultActionDecision(
  actionKind: AgentToolActionKind,
  safetyMode: AgentSafetyMode,
  actionDefault: GlobalToolPermissionDecision = defaultActionDecision(actionKind),
): GlobalToolPermissionDecision {
  if (actionDefault === 'deny') return 'deny';
  if (safetyMode === 'balanced') return actionDefault;
  if (safetyMode === 'ask_first') {
    return ASK_FIRST_ASK_ACTIONS.has(actionKind) ? 'ask' : actionDefault;
  }
  if (FULL_ACCESS_ALLOW_ACTIONS.has(actionKind)) return 'allow';
  return actionDefault;
}

export function effectiveActionDecision(
  actionKind: AgentToolActionKind,
  safetyMode: AgentSafetyMode,
  overrides: AgentPermissionDecisionOverrides,
  actionDefault?: GlobalToolPermissionDecision,
): GlobalToolPermissionDecision {
  return explicitActionDecision(actionKind, overrides)
    ?? safetyModeDefaultActionDecision(actionKind, safetyMode, actionDefault);
}
