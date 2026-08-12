import {
  MODEL_TOOL_CATALOG,
  canonicalModelToolKey,
  type ModelToolActionKind,
  type ModelToolContract,
} from '../../../core/agent/tools';

export type SubagentPolicyKind = 'general-purpose' | 'explore' | 'plan' | 'role';

export interface SubagentToolPolicy {
  readonly kind: SubagentPolicyKind;
  readonly runInBackground: boolean;
  readonly worktree: boolean;
  readonly allowNesting: boolean;
}

const RETIRED_TOOL_KEYS = new Set([
  'collaboration.spawn_agent',
  'collaboration.send_message',
  'collaboration.followup_task',
  'collaboration.wait_agent',
  'collaboration.list_agents',
  'collaboration.interrupt_agent',
  'bash_stop',
]);

const ROOT_ONLY_ACTION_KINDS = new Set<ModelToolActionKind>([
  'agent.user_input.request',
  'agent.automation.manage',
]);
const OUTLINE_MUTATION_ACTION_KINDS = new Set<ModelToolActionKind>([
  'outline.edit',
  'outline.delete',
]);
const REPOSITORY_MUTATION_ACTION_KINDS = new Set<ModelToolActionKind>([
  ...OUTLINE_MUTATION_ACTION_KINDS,
  'file.edit.local_path',
  'file.write.local_path',
  'file.write.sensitive_local_path',
  'file.delete.local_path',
]);
const SPECIALIZED_EXCLUDED_ACTION_KINDS = new Set<ModelToolActionKind>([
  'agent.image.generate',
  'agent.data.import',
]);
const BACKGROUND_TOOL_KEYS = new Set([
  'node_search',
  'node_read',
  'node_create',
  'node_edit',
  'node_delete',
  'file_read',
  'file_glob',
  'file_grep',
  'file_edit',
  'file_write',
  'file_delete',
  'bash',
  'web_search',
  'web_fetch',
  'skill',
  'agent',
  'agent_message',
  'task_stop',
]);

export function filterSubagentToolContracts(
  tools: readonly ModelToolContract[],
  policy: SubagentToolPolicy,
): readonly ModelToolContract[] {
  return tools.filter((tool) => subagentToolAllowed(tool, policy));
}

export function filterSubagentToolKeys(
  toolKeys: readonly string[],
  policy: SubagentToolPolicy,
  registry: readonly ModelToolContract[] = MODEL_TOOL_CATALOG,
): readonly string[] {
  const contracts = new Map(registry.map((contract) => [canonicalModelToolKey(contract.identity), contract]));
  return toolKeys.filter((key) => {
    const contract = contracts.get(key);
    return contract ? subagentToolAllowed(contract, policy) : false;
  });
}

export function subagentToolAllowed(
  tool: ModelToolContract,
  policy: SubagentToolPolicy,
): boolean {
  const key = canonicalModelToolKey(tool.identity);
  if (
    RETIRED_TOOL_KEYS.has(key)
    || tool.scope === 'rootThread'
    || hasActionKind(tool, ROOT_ONLY_ACTION_KINDS)
    || key === 'outline_undo_stack'
  ) return false;
  if (policy.worktree && hasActionKind(tool, OUTLINE_MUTATION_ACTION_KINDS)) return false;
  if (!policy.allowNesting && tool.actionKinds.includes('agent.subagent.spawn')) return false;

  const specialized = policy.kind === 'explore' || policy.kind === 'plan';
  const extensionTool = tool.identity.namespace !== null;
  if (specialized && !extensionTool && key !== 'bash') {
    if (hasActionKind(tool, REPOSITORY_MUTATION_ACTION_KINDS)) return false;
    if (hasActionKind(tool, SPECIALIZED_EXCLUDED_ACTION_KINDS)) return false;
  }
  if (specialized && tool.actionKinds.includes('agent.subagent.spawn')) return false;

  if (!policy.runInBackground) return true;
  if (extensionTool) return true;
  return BACKGROUND_TOOL_KEYS.has(key);
}

function hasActionKind(
  tool: ModelToolContract,
  kinds: ReadonlySet<ModelToolActionKind>,
): boolean {
  return tool.actionKinds.some((kind) => kinds.has(kind));
}
