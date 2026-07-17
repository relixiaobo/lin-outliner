export const SUPPORTED_AGENT_TOOL_ACTION_KINDS = [
  'file.read.local_path',
  'file.read.sensitive_local_path',
  'file.edit.local_path',
  'file.write.local_path',
  'file.write.sensitive_local_path',
  'file.delete.local_path',
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
  'shell.unknown',
  'git.publish_remote',
  'deploy.publish_remote',
  'external.message.send',
  'shell.stop',
  'agent.memory.recall',
  'agent.user_question.ask',
  'agent.skill.invoke',
  'agent.image.generate',
  'agent.issue.search',
  'agent.issue.read',
  'agent.issue.create',
  'agent.issue.update',
  'agent.session.start',
  'agent.session.read',
  'agent.session.send',
  'agent.session.stop',
  'agent.capability.modify',
] as const;

export type AgentToolActionKind = typeof SUPPORTED_AGENT_TOOL_ACTION_KINDS[number];

const READ_ONLY_ACTION_KIND_FLAGS = {
  'file.read.local_path': true,
  'file.read.sensitive_local_path': true,
  'file.edit.local_path': false,
  'file.write.local_path': false,
  'file.write.sensitive_local_path': false,
  'file.delete.local_path': false,
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
  'shell.unknown': false,
  'git.publish_remote': false,
  'deploy.publish_remote': false,
  'external.message.send': false,
  'shell.stop': false,
  'agent.memory.recall': true,
  'agent.user_question.ask': false,
  'agent.skill.invoke': false,
  'agent.image.generate': false,
  'agent.issue.search': true,
  'agent.issue.read': true,
  'agent.issue.create': false,
  'agent.issue.update': false,
  'agent.session.start': false,
  'agent.session.read': true,
  'agent.session.send': false,
  'agent.session.stop': false,
  'agent.capability.modify': false,
} satisfies Record<AgentToolActionKind, boolean>;

export const AGENT_TOOL_ACTION_KIND_PROFILES = {
  file_read: [
    'file.read.local_path',
    'file.read.sensitive_local_path',
  ],
  file_glob: [
    'file.read.local_path',
    'file.read.sensitive_local_path',
  ],
  file_grep: [
    'file.read.local_path',
    'file.read.sensitive_local_path',
  ],
  file_edit: [
    'file.edit.local_path',
    'file.write.sensitive_local_path',
  ],
  file_write: [
    'file.write.local_path',
    'file.write.sensitive_local_path',
  ],
  file_delete: [
    'file.delete.local_path',
    'file.write.sensitive_local_path',
  ],
  bash: [
    'shell.read_search',
    'file.read.sensitive_local_path',
    'file.edit.local_path',
    'file.delete.local_path',
    'file.write.sensitive_local_path',
    'shell.project_script',
    'shell.local_code_execution',
    'shell.dependency_install',
    'shell.network_write',
    'shell.destructive_cleanup',
    'shell.background_process',
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
  outline_undo_stack: ['outline.read', 'outline.edit'],
  past_chats: ['agent.memory.recall'],
  ask_user_question: ['agent.user_question.ask'],
  bash_stop: ['shell.stop'],
  issue_search: ['agent.issue.search'],
  issue_read: ['agent.issue.read'],
  issue_create: ['agent.issue.create'],
  issue_update: ['agent.issue.update'],
  agent_session_start: ['agent.session.start'],
  agent_session_read: ['agent.session.read'],
  agent_session_send_message: ['agent.session.send'],
  agent_session_stop: ['agent.session.stop'],
  skill: ['agent.skill.invoke'],
  generate_image: ['agent.image.generate'],
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
  if (toolName === 'outline_undo_stack') return outlineUndoStackActionKindProfile(args);
  return AGENT_TOOL_ACTION_KIND_PROFILE_MAP[toolName] ?? null;
}

export function isAgentToolActionKind(value: string): value is AgentToolActionKind {
  return SUPPORTED_ACTION_KIND_SET.has(value);
}

export function normalizeAgentToolActionKinds(values: readonly string[] | undefined): AgentToolActionKind[] | undefined {
  if (!values) return undefined;
  const result: AgentToolActionKind[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (isAgentToolActionKind(trimmed)) {
      result.push(trimmed);
      continue;
    }
    const profile = agentToolActionKindProfile(trimmed);
    if (profile) result.push(...profile);
  }
  return [...new Set(result)];
}

export function agentToolNamesForActionKindScope(
  actionKinds: readonly string[] | undefined,
  candidates?: readonly string[],
): string[] | undefined {
  const normalizedActionKinds = normalizeAgentToolActionKinds(actionKinds);
  if (!normalizedActionKinds || normalizedActionKinds.length === 0) return undefined;
  const allowed = new Set<AgentToolActionKind>(normalizedActionKinds);
  const names = candidates
    ? candidates.flatMap((toolName) => normalizeAgentToolProfileName(toolName) === '*' ? Object.keys(AGENT_TOOL_ACTION_KIND_PROFILES) : [normalizeAgentToolProfileName(toolName)])
    : Object.keys(AGENT_TOOL_ACTION_KIND_PROFILES);
  return [...new Set(names.filter((toolName) => {
    const profile = AGENT_TOOL_ACTION_KIND_PROFILE_MAP[toolName];
    return profile?.some((actionKind) => allowed.has(actionKind)) === true;
  }))];
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
  return normalized;
}

function outlineUndoStackActionKindProfile(args: unknown): readonly AgentToolActionKind[] {
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
