export type GlobalToolPermissionDecision = 'allow' | 'soft_block' | 'deny';

export type AgentPermissionEffectReach =
  | 'local'
  | 'outside_scope'
  | 'network_read'
  | 'network_write'
  | 'external_system';

export type AgentPermissionFloorKind =
  | 'exfiltration'
  | 'host_destruction'
  | 'persistence'
  | 'hidden_exec'
  | 'permission_self_mod'
  | 'payment';

export type AgentPermissionScopeAccess = 'read' | 'write';

export type AgentPermissionGrant =
  | { kind: 'scope'; access: AgentPermissionScopeAccess; root: string }
  | { kind: 'external'; target: string }
  | { kind: 'command'; form: string };

export type AgentPermissionBlock =
  | AgentPermissionGrant
  | { kind: 'action'; actionKind: AgentToolActionKind };

export interface AgentOperationEffect {
  reach: AgentPermissionEffectReach;
  reversible: boolean;
  touchesCredentials: boolean;
  floor?: AgentPermissionFloorKind;
  label: string;
  grant?: AgentPermissionGrant;
}

export function decideAgentOperationEffect(effect: AgentOperationEffect): GlobalToolPermissionDecision {
  if (effect.floor) return 'deny';
  return 'allow';
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
  'file.convert.allowed_file_area',
  'file.convert.outside_allowed_file_area',
  'file.convert.sensitive_local_path',
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
  'agent.channel.create',
  'agent.channel.update',
  'agent.permission.modify',
  'payment.purchase',
] as const;

export type AgentToolActionKind = typeof SUPPORTED_AGENT_TOOL_ACTION_KINDS[number];

const READ_ONLY_ACTION_KIND_FLAGS = {
  'file.read.allowed_file_area': true,
  'file.read.outside_allowed_file_area': true,
  'file.read.sensitive_local_path': true,
  'file.edit.allowed_file_area': false,
  'file.write.allowed_file_area': false,
  'file.write.outside_allowed_file_area': false,
  'file.write.sensitive_local_path': false,
  'file.delete.allowed_file_area': false,
  'file.convert.allowed_file_area': false,
  'file.convert.outside_allowed_file_area': false,
  'file.convert.sensitive_local_path': false,
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
  'agent.channel.create': false,
  'agent.channel.update': false,
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
  file_delete: [
    'file.delete.allowed_file_area',
    'file.write.outside_allowed_file_area',
    'file.write.sensitive_local_path',
  ],
  file_convert: [
    'file.convert.allowed_file_area',
    'file.convert.outside_allowed_file_area',
    'file.convert.sensitive_local_path',
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
  channel_create: ['agent.channel.create'],
  channel_update: ['agent.channel.update'],
  skill: ['agent.skill.invoke'],
} satisfies Record<string, readonly AgentToolActionKind[]>;

const READ_ONLY_AGENT_TOOL_NAMES = Object.entries(AGENT_TOOL_ACTION_KIND_PROFILES)
  .filter(([, actionKinds]) => actionKinds.every(isReadOnlyActionKind))
  .map(([toolName]) => toolName);

const SUPPORTED_ACTION_KIND_SET = new Set<string>(SUPPORTED_AGENT_TOOL_ACTION_KINDS);
const AGENT_TOOL_ACTION_KIND_PROFILE_MAP: Readonly<Record<string, readonly AgentToolActionKind[]>> = AGENT_TOOL_ACTION_KIND_PROFILES;

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
  if (normalized === 'delete') return 'file_delete';
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
