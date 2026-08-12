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

export interface PersistedSubagentToolPolicy extends SubagentToolPolicy {
  /** null means the selected Agent type did not declare a Role tool restriction. */
  readonly requestedTools: readonly string[] | null;
}

export interface ResolvedSubagentToolRequest {
  readonly requestedTools: readonly string[] | null;
  readonly recognizedTools: readonly string[];
  readonly unrecognizedTools: readonly string[];
}

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
const SPECIALIZED_REPOSITORY_MUTATION_ACTION_KINDS = new Set<ModelToolActionKind>([
  ...REPOSITORY_MUTATION_ACTION_KINDS,
  'shell.project_script',
  'shell.local_code_execution',
  'shell.dependency_install',
  'shell.destructive_cleanup',
  'shell.unknown',
  'git.publish_remote',
]);
const SPECIALIZED_EXCLUDED_ACTION_KINDS = new Set<ModelToolActionKind>([
  'agent.image.generate',
  'agent.data.import',
]);
const SPECIALIZED_BASH_ACTION_KINDS = new Set<ModelToolActionKind>([
  'shell.read_search',
  'shell.background_process',
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

export function resolveSubagentToolRequest(
  requestedTools: readonly string[] | null,
  registry: readonly ModelToolContract[],
): ResolvedSubagentToolRequest {
  if (requestedTools === null) {
    return {
      requestedTools: null,
      recognizedTools: [],
      unrecognizedTools: [],
    };
  }
  const available = new Set(registry.map((contract) => canonicalModelToolKey(contract.identity)));
  const requested = [...new Set(requestedTools)];
  return {
    requestedTools: requested,
    recognizedTools: requested.filter((key) => available.has(key)),
    unrecognizedTools: requested.filter((key) => !available.has(key)),
  };
}

export function subagentToolAllowed(
  tool: ModelToolContract,
  policy: SubagentToolPolicy,
): boolean {
  const key = canonicalModelToolKey(tool.identity);
  if (
    tool.scope === 'rootThread'
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

/**
 * Explore and Plan retain Bash for captured provider parity, but only commands
 * that the capability classifier can prove are repository inspections may run.
 */
export function subagentBashExecutionAllowed(
  policy: SubagentToolPolicy,
  actionKinds: readonly ModelToolActionKind[],
): boolean {
  if (policy.kind !== 'explore' && policy.kind !== 'plan') return true;
  return actionKinds.length > 0 && actionKinds.every((kind) => SPECIALIZED_BASH_ACTION_KINDS.has(kind));
}

/**
 * Dynamic extension and MCP tools remain provider-visible for parity, but their
 * declared actions must not bypass the specialized repository-write boundary.
 */
export function subagentToolExecutionAllowed(
  policy: SubagentToolPolicy,
  actionKinds: readonly ModelToolActionKind[],
): boolean {
  if (policy.kind !== 'explore' && policy.kind !== 'plan') return true;
  return actionKinds.length > 0
    && actionKinds.every((kind) => !SPECIALIZED_REPOSITORY_MUTATION_ACTION_KINDS.has(kind));
}

function hasActionKind(
  tool: ModelToolContract,
  kinds: ReadonlySet<ModelToolActionKind>,
): boolean {
  return tool.actionKinds.some((kind) => kinds.has(kind));
}
