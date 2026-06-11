export type AgentToolActionKind =
  | 'file.read.allowed_file_area'
  | 'file.read.outside_allowed_file_area'
  | 'file.read.sensitive_local_path'
  | 'file.edit.allowed_file_area'
  | 'file.write.allowed_file_area'
  | 'file.write.outside_allowed_file_area'
  | 'file.write.sensitive_local_path'
  | 'file.delete.allowed_file_area'
  | 'outline.read'
  | 'outline.edit'
  | 'outline.delete'
  | 'web.search'
  | 'web.fetch'
  | 'shell.read_search'
  | 'shell.project_script'
  | 'shell.local_code_execution'
  | 'shell.dependency_install'
  | 'shell.network_write'
  | 'shell.destructive_cleanup'
  | 'shell.background_process'
  | 'shell.sandbox_override'
  | 'shell.unknown'
  | 'git.publish_remote'
  | 'deploy.publish_remote'
  | 'external.message.send'
  | 'task.stop'
  | 'agent.memory.recall'
  | 'agent.memory.dream'
  | 'agent.user_question.ask'
  | 'agent.runtime.status'
  | 'agent.config.read'
  | 'agent.config.write'
  | 'agent.doctor.run'
  | 'agent.skill.invoke'
  | 'agent.skill.write'
  | 'agent.delegate.spawn'
  | 'agent.delegate.status'
  | 'agent.delegate.send'
  | 'agent.delegate.stop'
  | 'agent.permission.modify'
  | 'payment.purchase';

export type AgentToolCapability =
  | 'external_messaging'
  | 'agent_spawn'
  | 'permission_management'
  | 'payments';

export type GlobalToolPermissionDecision = 'allow' | 'ask' | 'deny';
export type ToolPermissionOutcome = 'allow' | 'ask' | 'blocked';
export type AskResolverOutcome = 'allow' | 'block' | 'needs_user';
export type ToolPermissionClassifierOutcome = 'allow' | 'block';
export type ToolAccessScope =
  | 'allowed_file_area'
  | 'outside_allowed_file_area'
  | 'sensitive_local_path'
  | 'external_system'
  | 'none';

export interface ToolActionDescriptor {
  toolName: string;
  actionKind: AgentToolActionKind;
  accessScope: ToolAccessScope;
  title: string;
  summary: string;
  consequence: string;
  defaultDecision: GlobalToolPermissionDecision;
  reversible: boolean;
  externalEffect: boolean;
  highConsequence: boolean;
  classifierAutoAllowEligible: boolean;
  command?: string;
  capabilities?: readonly AgentToolCapability[];
  code?: string;
  platformHardBlock?: boolean;
}

export interface ToolPermissionClassifierResult {
  outcome: ToolPermissionClassifierOutcome;
  reason: string;
  model: string;
  unavailable?: boolean;
}

export interface GlobalToolPermissionRule {
  ruleValue: string;
  decision: GlobalToolPermissionDecision;
  updatedAt?: number;
}

export type ParsedGlobalToolPermissionRuleTarget =
  | { kind: 'action'; value: AgentToolActionKind }
  | { kind: 'tool'; value: string }
  | { kind: 'bash'; value: string }
  | { kind: 'capability'; value: AgentToolCapability };

export interface ParsedGlobalToolPermissionRule extends GlobalToolPermissionRule {
  target: ParsedGlobalToolPermissionRuleTarget;
}

export interface GlobalToolPermissionRuleDiagnostic {
  ruleValue: string;
  decision: GlobalToolPermissionDecision;
  code: 'invalid_rule' | 'unsupported_rule' | 'forbidden_allow_rule' | 'forbidden_capability_rule';
  message: string;
}

export interface GlobalToolPermissionConfig {
  rules: ParsedGlobalToolPermissionRule[];
  diagnostics: GlobalToolPermissionRuleDiagnostic[];
}

export interface GlobalToolPermissionSettings {
  permissions?: {
    allow?: unknown;
    ask?: unknown;
    deny?: unknown;
  };
}

export interface GlobalToolPermissionResolution {
  decision: GlobalToolPermissionDecision;
  source: 'configured_deny' | 'configured_ask' | 'configured_allow' | 'default';
  descriptor: ToolActionDescriptor;
  rule?: ParsedGlobalToolPermissionRule;
}

export const SUPPORTED_AGENT_TOOL_ACTION_KINDS: readonly AgentToolActionKind[] = [
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
  'agent.skill.write',
  'agent.delegate.spawn',
  'agent.delegate.status',
  'agent.delegate.send',
  'agent.delegate.stop',
  'agent.permission.modify',
  'payment.purchase',
];

export const SUPPORTED_AGENT_TOOL_CAPABILITIES: readonly AgentToolCapability[] = [
  'agent_spawn',
];

export const ARBITRARY_CODE_SHELL_PREFIXES: readonly string[] = [
  'bash',
  'cmd',
  'cscript',
  'deno',
  'eval',
  'exec',
  'fish',
  'iex',
  'node',
  'osascript',
  'perl',
  'php',
  'pwsh',
  'powershell',
  'python',
  'python3',
  'ruby',
  'sh',
  'sudo',
  'wscript',
  'xargs',
  'zsh',
];

export const OUTWARD_FACING_SHELL_PREFIXES: readonly string[] = [
  'aws',
  'curl',
  'docker',
  'firebase',
  'fly',
  'gcloud',
  'gh',
  'git',
  'gsutil',
  'kubectl',
  'netlify',
  'npm',
  'pnpm',
  'rclone',
  'rsync',
  'scp',
  'sftp',
  'ssh',
  'supabase',
  'vercel',
  'wget',
  'wrangler',
];

export const SAFE_AUTO_ALLOW_TOOL_NAMES: readonly string[] = [
  'file_read',
  'file_glob',
  'file_grep',
  'node_read',
  'node_search',
  'operation_history',
  'recall',
  'task_stop',
  'web_search',
];

const SUPPORTED_ACTION_KIND_SET = new Set<string>(SUPPORTED_AGENT_TOOL_ACTION_KINDS);
const SUPPORTED_CAPABILITY_SET = new Set<string>(SUPPORTED_AGENT_TOOL_CAPABILITIES);
const BASH_ALLOW_FORBIDDEN_PREFIX_SET = new Set<string>([
  ...ARBITRARY_CODE_SHELL_PREFIXES,
  'bun',
  'bunx',
  'npm',
  'npx',
  'pnpm',
  'ssh',
  'tsx',
  'yarn',
]);
const SAFE_TOOL_SET = new Set<string>(SAFE_AUTO_ALLOW_TOOL_NAMES);
const KNOWN_TOOL_NAMES = new Set<string>([
  ...SAFE_AUTO_ALLOW_TOOL_NAMES,
  'agent',
  'agent_send',
  'agent_status',
  'agent_stop',
  'ask_user_question',
  'bash',
  'config',
  'doctor',
  'dream',
  'file_edit',
  'file_write',
  'recall',
  'runtime_status',
  'node_create',
  'node_delete',
  'node_edit',
  'skill',
  'web_fetch',
]);

const PLATFORM_HARD_BLOCK_ACTIONS = new Set<AgentToolActionKind>([
  'agent.permission.modify',
  'payment.purchase',
]);

const ALLOW_FORBIDDEN_ACTIONS = new Set<AgentToolActionKind>([
  ...PLATFORM_HARD_BLOCK_ACTIONS,
  'agent.config.write',
  'agent.memory.dream',
  'agent.skill.write',
  'agent.delegate.spawn',
  'shell.unknown',
]);

const BEHAVIOR_ORDER: readonly GlobalToolPermissionDecision[] = ['deny', 'ask', 'allow'];

export function parseGlobalToolPermissionSettings(input: unknown): GlobalToolPermissionConfig {
  if (isGlobalToolPermissionConfig(input)) return parsePrevalidatedGlobalToolPermissionConfig(input);
  const settings = isRecord(input) ? input as GlobalToolPermissionSettings : {};
  const permissions = isRecord(settings.permissions) ? settings.permissions : {};
  const rules: ParsedGlobalToolPermissionRule[] = [];
  const diagnostics: GlobalToolPermissionRuleDiagnostic[] = [];

  for (const decision of BEHAVIOR_ORDER) {
    const entries = Array.isArray(permissions[decision]) ? permissions[decision] : [];
    for (const entry of entries) {
      if (typeof entry !== 'string') {
        diagnostics.push({
          ruleValue: String(entry),
          decision,
          code: 'invalid_rule',
          message: 'Permission rule entries must be strings.',
        });
        continue;
      }
      const parsed = parseGlobalToolPermissionRule(entry, decision);
      if ('diagnostic' in parsed) diagnostics.push(parsed.diagnostic);
      else rules.push(parsed.rule);
    }
  }

  return { rules, diagnostics };
}

function parsePrevalidatedGlobalToolPermissionConfig(input: GlobalToolPermissionConfig): GlobalToolPermissionConfig {
  const rules: ParsedGlobalToolPermissionRule[] = [];
  const diagnostics: GlobalToolPermissionRuleDiagnostic[] = [];
  for (const candidate of input.rules) {
    if (!isRecord(candidate) || typeof candidate.ruleValue !== 'string' || !isGlobalToolPermissionDecision(candidate.decision)) {
      diagnostics.push({
        ruleValue: isRecord(candidate) && 'ruleValue' in candidate ? String(candidate.ruleValue) : String(candidate),
        decision: isRecord(candidate) && 'decision' in candidate && isGlobalToolPermissionDecision(candidate.decision)
          ? candidate.decision
          : 'ask',
        code: 'invalid_rule',
        message: 'Permission rule entries must be parsed from a valid rule string.',
      });
      continue;
    }
    const parsed = parseGlobalToolPermissionRule(candidate.ruleValue, candidate.decision);
    if ('diagnostic' in parsed) {
      diagnostics.push(parsed.diagnostic);
    } else {
      rules.push({
        ...parsed.rule,
        updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : undefined,
      });
    }
  }
  return { rules, diagnostics };
}

export function globalToolPermissionConfigToSettings(config: GlobalToolPermissionConfig): Required<GlobalToolPermissionSettings> {
  const permissions: { allow: string[]; ask: string[]; deny: string[] } = {
    allow: [],
    ask: [],
    deny: [],
  };
  for (const rule of config.rules) {
    permissions[rule.decision].push(rule.ruleValue);
  }
  return { permissions };
}

export function resolveGlobalToolPermissionDecision(
  descriptors: readonly ToolActionDescriptor[],
  configInput?: unknown,
): GlobalToolPermissionResolution | null {
  const config = parseGlobalToolPermissionSettings(configInput);
  const descriptorResolutions = descriptors.map((descriptor) => resolveDescriptorDecision(descriptor, config.rules));
  descriptorResolutions.sort((left, right) => (
    decisionRank(right.decision) - decisionRank(left.decision)
    || descriptorRiskRank(right.descriptor) - descriptorRiskRank(left.descriptor)
    || sourceRank(right.source) - sourceRank(left.source)
  ));
  return descriptorResolutions[0] ?? null;
}

export function isSafeAutoAllowToolName(toolName: string): boolean {
  return SAFE_TOOL_SET.has(normalizePermissionToolName(toolName));
}

export function alwaysAllowRuleForDescriptor(descriptor: ToolActionDescriptor): string | undefined {
  const ruleValue = `Action(${descriptor.actionKind})`;
  const config = parseGlobalToolPermissionSettings({ permissions: { allow: [ruleValue] } });
  return config.rules.length === 1 && config.rules[0]?.decision === 'allow' ? ruleValue : undefined;
}

export function normalizePermissionToolName(value: string): string {
  return value.trim().replace(/-/g, '_').toLowerCase();
}

function resolveDescriptorDecision(
  descriptor: ToolActionDescriptor,
  rules: readonly ParsedGlobalToolPermissionRule[],
): GlobalToolPermissionResolution {
  const denyRule = rules.find((rule) => rule.decision === 'deny' && ruleMatchesDescriptor(rule, descriptor));
  if (denyRule) return { decision: 'deny', source: 'configured_deny', descriptor, rule: denyRule };

  const askRule = rules.find((rule) => rule.decision === 'ask' && ruleMatchesDescriptor(rule, descriptor));
  if (askRule) return { decision: 'ask', source: 'configured_ask', descriptor, rule: askRule };

  const allowRule = rules.find((rule) => rule.decision === 'allow' && ruleMatchesDescriptor(rule, descriptor));
  if (allowRule) return { decision: 'allow', source: 'configured_allow', descriptor, rule: allowRule };

  return { decision: descriptor.defaultDecision, source: 'default', descriptor };
}

function ruleMatchesDescriptor(rule: ParsedGlobalToolPermissionRule, descriptor: ToolActionDescriptor): boolean {
  switch (rule.target.kind) {
    case 'action':
      return descriptor.actionKind === rule.target.value;
    case 'tool':
      return normalizePermissionToolName(descriptor.toolName) === rule.target.value;
    case 'bash':
      return descriptor.toolName === 'bash'
        && typeof descriptor.command === 'string'
        && wildcardMatches(rule.target.value, descriptor.command);
    case 'capability':
      return descriptor.capabilities?.includes(rule.target.value) ?? false;
  }
}

function parseGlobalToolPermissionRule(
  ruleValueInput: string,
  decision: GlobalToolPermissionDecision,
): { rule: ParsedGlobalToolPermissionRule } | { diagnostic: GlobalToolPermissionRuleDiagnostic } {
  const ruleValue = ruleValueInput.trim();
  const match = /^([A-Za-z][A-Za-z0-9_-]*)\(([\s\S]*)\)$/.exec(ruleValue);
  if (!match) {
    return diagnostic(ruleValue, decision, 'invalid_rule', 'Permission rules must use Kind(value) syntax.');
  }

  const kind = normalizePermissionToolName(match[1] ?? '');
  const rawValue = (match[2] ?? '').trim();
  if (!rawValue || rawValue === '*') {
    return diagnostic(ruleValue, decision, decision === 'allow' ? 'forbidden_allow_rule' : 'unsupported_rule', 'Broad or empty permission rules are not supported.');
  }

  if (kind === 'action') {
    if (!SUPPORTED_ACTION_KIND_SET.has(rawValue)) {
      return diagnostic(ruleValue, decision, 'unsupported_rule', `Unsupported action kind: ${rawValue}.`);
    }
    const actionKind = rawValue as AgentToolActionKind;
    if (decision === 'allow' && ALLOW_FORBIDDEN_ACTIONS.has(actionKind)) {
      return diagnostic(ruleValue, decision, 'forbidden_allow_rule', `Action ${actionKind} cannot be globally allowed.`);
    }
    return { rule: { ruleValue, decision, target: { kind: 'action', value: actionKind } } };
  }

  if (kind === 'capability') {
    const capability = normalizePermissionToolName(rawValue);
    if (!SUPPORTED_CAPABILITY_SET.has(capability)) {
      return diagnostic(ruleValue, decision, 'unsupported_rule', `Unsupported capability: ${rawValue}.`);
    }
    if (decision !== 'deny') {
      return diagnostic(ruleValue, decision, 'forbidden_capability_rule', 'Capability rules are deny-only.');
    }
    return { rule: { ruleValue, decision, target: { kind: 'capability', value: capability as AgentToolCapability } } };
  }

  if (kind === 'tool') {
    const toolName = normalizePermissionToolName(rawValue);
    if (!KNOWN_TOOL_NAMES.has(toolName)) {
      return diagnostic(ruleValue, decision, 'unsupported_rule', `Unsupported tool name: ${rawValue}.`);
    }
    if (decision === 'allow' && !SAFE_TOOL_SET.has(toolName)) {
      return diagnostic(ruleValue, decision, 'forbidden_allow_rule', `Tool ${toolName} cannot be broadly allowed; use an Action(...) rule.`);
    }
    return { rule: { ruleValue, decision, target: { kind: 'tool', value: toolName } } };
  }

  if (kind === 'bash') {
    const value = rawValue.trim();
    const prefix = bashRulePrefix(value);
    if (!prefix) {
      return diagnostic(ruleValue, decision, 'unsupported_rule', 'Bash rules must be exact commands or safe command-prefix patterns.');
    }
    if (decision === 'allow' && BASH_ALLOW_FORBIDDEN_PREFIX_SET.has(prefix)) {
      return diagnostic(ruleValue, decision, 'forbidden_allow_rule', `Bash ${prefix} rules cannot be globally allowed.`);
    }
    if (decision === 'allow' && (prefix === 'agent' || prefix === 'child-run')) {
      return diagnostic(ruleValue, decision, 'forbidden_allow_rule', 'Agent spawn rules cannot be globally allowed.');
    }
    return { rule: { ruleValue, decision, target: { kind: 'bash', value } } };
  }

  return diagnostic(ruleValue, decision, 'unsupported_rule', `Unsupported permission rule kind: ${kind}.`);
}

function diagnostic(
  ruleValue: string,
  decision: GlobalToolPermissionDecision,
  code: GlobalToolPermissionRuleDiagnostic['code'],
  message: string,
): { diagnostic: GlobalToolPermissionRuleDiagnostic } {
  return { diagnostic: { ruleValue, decision, code, message } };
}

function bashRulePrefix(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '*') return null;
  const source = trimmed.endsWith(':*') ? trimmed.slice(0, -2).trim() : trimmed;
  const head = /^([A-Za-z0-9_.-]+)/.exec(source)?.[1];
  return head ? normalizePermissionToolName(head) : null;
}

function decisionRank(decision: GlobalToolPermissionDecision): number {
  if (decision === 'deny') return 2;
  if (decision === 'ask') return 1;
  return 0;
}

function descriptorRiskRank(descriptor: ToolActionDescriptor): number {
  let rank = 0;
  if (descriptor.externalEffect) rank += 4;
  if (descriptor.highConsequence) rank += 2;
  if (descriptor.accessScope === 'sensitive_local_path') rank += 2;
  if (descriptor.accessScope === 'outside_allowed_file_area') rank += 1;
  if (!descriptor.reversible) rank += 1;
  if (descriptor.actionKind.includes('unknown')) rank += 5;
  return rank;
}

function sourceRank(source: GlobalToolPermissionResolution['source']): number {
  return source === 'default' ? 0 : 1;
}

function isGlobalToolPermissionConfig(value: unknown): value is GlobalToolPermissionConfig {
  return isRecord(value) && Array.isArray(value.rules) && Array.isArray(value.diagnostics);
}

function isGlobalToolPermissionDecision(value: unknown): value is GlobalToolPermissionDecision {
  return value === 'allow' || value === 'ask' || value === 'deny';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function wildcardMatches(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith(':*')) {
    const commandPrefix = pattern.slice(0, -2).trim().toLowerCase();
    const command = value.trim().toLowerCase();
    return commandPrefix.length > 0 && (command === commandPrefix || command.startsWith(`${commandPrefix} `));
  }
  const regex = new RegExp(`^${escapeRegExp(pattern).replace(/\\\*/g, '.*')}$`, 'i');
  return regex.test(value.trim());
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.*]/g, '\\$&');
}
