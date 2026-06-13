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

const READ_ONLY_ACTION_KIND_FLAGS = {
  'file.read.allowed_file_area': true,
  'file.read.outside_allowed_file_area': true,
  'file.read.sensitive_local_path': true,
  'file.edit.allowed_file_area': false,
  'file.write.allowed_file_area': false,
  'file.write.outside_allowed_file_area': false,
  'file.write.sensitive_local_path': false,
  'file.delete.allowed_file_area': false,
  'outline.read': true,
  'outline.edit': false,
  'outline.delete': false,
  'web.search': true,
  'web.fetch': true,
  'shell.read_search': true,
  'shell.project_script': false,
  'shell.local_code_execution': false,
  'shell.dependency_install': false,
  'shell.network_write': false,
  'shell.destructive_cleanup': false,
  'shell.background_process': false,
  'shell.sandbox_override': false,
  'shell.unknown': false,
  'git.publish_remote': false,
  'deploy.publish_remote': false,
  'external.message.send': false,
  'task.stop': false,
  'agent.memory.recall': true,
  'agent.memory.dream': false,
  'agent.user_question.ask': false,
  'agent.runtime.status': true,
  'agent.config.read': true,
  'agent.config.write': false,
  'agent.doctor.run': true,
  'agent.skill.invoke': false,
  'agent.delegate.spawn': false,
  'agent.delegate.status': true,
  'agent.delegate.send': false,
  'agent.delegate.stop': false,
  'agent.permission.modify': false,
  'payment.purchase': false,
} satisfies Record<AgentToolActionKind, boolean>;

export const AGENT_TOOL_ACTION_KIND_PROFILES = {
  file_read: [
    'file.read.allowed_file_area',
    'file.read.outside_allowed_file_area',
    'file.read.sensitive_local_path',
  ],
  file_glob: [
    'file.read.allowed_file_area',
    'file.read.outside_allowed_file_area',
    'file.read.sensitive_local_path',
  ],
  file_grep: [
    'file.read.allowed_file_area',
    'file.read.outside_allowed_file_area',
    'file.read.sensitive_local_path',
  ],
  file_edit: [
    'file.edit.allowed_file_area',
    'file.write.outside_allowed_file_area',
    'file.write.sensitive_local_path',
  ],
  file_write: [
    'file.write.allowed_file_area',
    'file.write.outside_allowed_file_area',
    'file.write.sensitive_local_path',
  ],
  bash: [
    'shell.read_search',
    'file.read.sensitive_local_path',
    'file.edit.allowed_file_area',
    'file.delete.allowed_file_area',
    'file.write.sensitive_local_path',
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
  ],
  web_search: ['web.search'],
  web_fetch: ['web.fetch'],
  node_search: ['outline.read'],
  node_read: ['outline.read'],
  node_create: ['outline.edit'],
  node_edit: ['outline.edit'],
  node_delete: ['outline.delete'],
  operation_history: ['outline.read', 'outline.edit'],
  recall: ['agent.memory.recall'],
  ask_user_question: ['agent.user_question.ask'],
  runtime_status: ['agent.runtime.status'],
  config: ['agent.config.read', 'agent.config.write'],
  doctor: ['agent.doctor.run'],
  dream: ['agent.memory.dream'],
  task_stop: ['task.stop'],
  Agent: ['agent.delegate.spawn'],
  AgentStatus: ['agent.delegate.status'],
  AgentSend: ['agent.delegate.send'],
  AgentStop: ['agent.delegate.stop'],
  skill: ['agent.skill.invoke'],
} satisfies Record<string, readonly AgentToolActionKind[]>;

const READ_ONLY_AGENT_TOOL_NAMES = Object.entries(AGENT_TOOL_ACTION_KIND_PROFILES)
  .filter(([, actionKinds]) => actionKinds.every(isReadOnlyActionKind))
  .map(([toolName]) => toolName);

const ASK_FIRST_ASK_ACTIONS = new Set<AgentToolActionKind>([
  'file.edit.allowed_file_area',
  'file.write.allowed_file_area',
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
const AGENT_TOOL_ACTION_KIND_PROFILE_MAP: Readonly<Record<string, readonly AgentToolActionKind[]>> = AGENT_TOOL_ACTION_KIND_PROFILES;

export function defaultActionDecision(actionKind: AgentToolActionKind): GlobalToolPermissionDecision {
  return DEFAULT_ACTION_DECISIONS[actionKind];
}

export function isReadOnlyActionKind(actionKind: AgentToolActionKind): boolean {
  return READ_ONLY_ACTION_KIND_FLAGS[actionKind];
}

export function agentToolActionKindProfile(toolNameInput: string, args?: unknown): readonly AgentToolActionKind[] | null {
  const toolName = normalizeAgentToolProfileName(toolNameInput);
  if (toolName === 'operation_history') return operationHistoryActionKindProfile(args);
  return AGENT_TOOL_ACTION_KIND_PROFILE_MAP[toolName] ?? null;
}

export function readOnlyAgentToolNames(candidates?: readonly string[]): string[] {
  if (!candidates) return [...READ_ONLY_AGENT_TOOL_NAMES];
  const names = candidates
    .map((toolName) => normalizeAgentToolProfileName(toolName))
    .filter((toolName) => {
      const profile = AGENT_TOOL_ACTION_KIND_PROFILE_MAP[toolName];
      return profile?.every(isReadOnlyActionKind) === true;
    });
  return [...new Set(names)];
}

export function actionKindRuleValue(actionKind: AgentToolActionKind): string {
  return `Action(${actionKind})`;
}

function normalizeAgentToolProfileName(toolNameInput: string): string {
  const normalized = toolNameInput.trim().replace(/^\//, '').replace(/-/g, '_').toLowerCase();
  if (normalized === 'read') return 'file_read';
  if (normalized === 'glob') return 'file_glob';
  if (normalized === 'grep') return 'file_grep';
  if (normalized === 'edit') return 'file_edit';
  if (normalized === 'write') return 'file_write';
  if (normalized === 'agentstatus' || normalized === 'agent_status') return 'AgentStatus';
  if (normalized === 'agentsend' || normalized === 'agent_send') return 'AgentSend';
  if (normalized === 'agentstop' || normalized === 'agent_stop') return 'AgentStop';
  if (normalized === 'agent') return 'Agent';
  return normalized;
}

function operationHistoryActionKindProfile(args: unknown): readonly AgentToolActionKind[] {
  const record = args && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : null;
  const rawAction = record?.action;
  const action = typeof rawAction === 'string' ? rawAction.trim().toLowerCase() : 'list';
  return action === 'undo' || action === 'redo'
    ? ['outline.edit']
    : ['outline.read'];
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
