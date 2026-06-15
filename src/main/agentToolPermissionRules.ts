import {
  SUPPORTED_AGENT_TOOL_ACTION_KINDS,
  type AgentOperationEffect,
  type AgentPermissionGrant,
  type AgentPermissionScopeAccess,
  type AgentToolActionKind,
  type GlobalToolPermissionDecision,
} from '../core/agentPermissionModel';
import path from 'node:path';

export {
  SUPPORTED_AGENT_TOOL_ACTION_KINDS,
  type AgentOperationEffect,
  type AgentPermissionGrant,
  type AgentToolActionKind,
  type GlobalToolPermissionDecision,
} from '../core/agentPermissionModel';

export type AgentToolCapability =
  | 'external_messaging'
  | 'agent_spawn'
  | 'permission_management'
  | 'payments';

export type ToolPermissionOutcome = 'allow' | 'ask' | 'blocked';
export type AskResolverOutcome = 'allow' | 'block' | 'needs_user';
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
  reversible: boolean;
  externalEffect: boolean;
  highConsequence: boolean;
  effect: AgentOperationEffect;
  command?: string;
  capabilities?: readonly AgentToolCapability[];
  code?: string;
  platformHardBlock?: boolean;
}

export interface GlobalToolPermissionRule {
  ruleValue: string;
  grant: AgentPermissionGrant;
  updatedAt?: number;
}

export interface GlobalToolPermissionRuleDiagnostic {
  ruleValue: string;
  code: 'invalid_grant' | 'unsupported_grant';
  message: string;
}

export interface GlobalToolPermissionConfig {
  grants: GlobalToolPermissionRule[];
  diagnostics: GlobalToolPermissionRuleDiagnostic[];
}

export interface GlobalToolPermissionSettings {
  grants?: unknown;
  /** Legacy pre-redesign setting. Ignored and normalized away on the next write. */
  permissions?: unknown;
}

export interface ToolPermissionResolutionPriorityInput {
  decision: GlobalToolPermissionDecision;
  descriptor: ToolActionDescriptor;
  sourceRank?: number;
}

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

const GRANT_KINDS = new Set(['scope', 'external', 'command']);

export function parseGlobalToolPermissionSettings(input: unknown): GlobalToolPermissionConfig {
  if (isParsedGlobalToolPermissionConfig(input)) return input;
  const settings = isRecord(input) ? input as GlobalToolPermissionSettings : {};
  const entries = Array.isArray(settings.grants) ? settings.grants : [];
  const grants: GlobalToolPermissionRule[] = [];
  const diagnostics: GlobalToolPermissionRuleDiagnostic[] = [];

  for (const entry of entries) {
    if (typeof entry !== 'string') {
      diagnostics.push({
        ruleValue: String(entry),
        code: 'invalid_grant',
        message: 'Permission grants must be strings.',
      });
      continue;
    }
    const parsed = parseGlobalToolPermissionGrant(entry);
    if ('diagnostic' in parsed) diagnostics.push(parsed.diagnostic);
    else grants.push(parsed.rule);
  }

  return { grants, diagnostics };
}

export function globalToolPermissionConfigToSettings(config: GlobalToolPermissionConfig): Required<Pick<GlobalToolPermissionSettings, 'grants'>> {
  return { grants: config.grants.map((grant) => grant.ruleValue) };
}

export function grantRuleValue(grant: AgentPermissionGrant): string {
  if (grant.kind === 'scope') return `Scope(${grant.access}:${grant.root})`;
  if (grant.kind === 'external') return `External(${grant.target})`;
  return `Command(${grant.form})`;
}

export function matchingGrantForEffect(
  effect: AgentOperationEffect,
  configInput?: unknown,
): GlobalToolPermissionRule | null {
  if (!effect.grant || effect.floor) return null;
  const grant = effect.grant;
  const config = isParsedGlobalToolPermissionConfig(configInput)
    ? configInput
    : parseGlobalToolPermissionSettings(configInput);
  return config.grants.find((rule) => grantsEqual(rule.grant, grant)) ?? null;
}

export function compareToolPermissionResolutionPriority<T extends ToolPermissionResolutionPriorityInput>(
  left: T,
  right: T,
  resolveSourceRank: (source: T) => number = (source) => source.sourceRank ?? 0,
): number {
  return decisionRank(right.decision) - decisionRank(left.decision)
    || resolveSourceRank(right) - resolveSourceRank(left)
    || descriptorRiskRank(right.descriptor) - descriptorRiskRank(left.descriptor);
}

export function alwaysAllowRuleForDescriptor(descriptor: ToolActionDescriptor): string | undefined {
  return descriptor.effect.floor || !descriptor.effect.grant
    ? undefined
    : grantRuleValue(descriptor.effect.grant);
}

export function normalizePermissionToolName(value: string): string {
  return value.trim().replace(/-/g, '_').toLowerCase();
}

function parseGlobalToolPermissionGrant(
  ruleValueInput: string,
): { rule: GlobalToolPermissionRule } | { diagnostic: GlobalToolPermissionRuleDiagnostic } {
  const ruleValue = ruleValueInput.trim();
  const match = /^([A-Za-z][A-Za-z0-9_-]*)\(([\s\S]*)\)$/.exec(ruleValue);
  if (!match) {
    return diagnostic(ruleValue, 'invalid_grant', 'Permission grants must use Kind(value) syntax.');
  }

  const kind = normalizePermissionToolName(match[1] ?? '');
  const rawValue = (match[2] ?? '').trim();
  if (!rawValue || rawValue === '*') {
    return diagnostic(ruleValue, 'unsupported_grant', 'Broad or empty permission grants are not supported.');
  }
  if (!GRANT_KINDS.has(kind)) {
    return diagnostic(ruleValue, 'unsupported_grant', `Unsupported permission grant kind: ${kind}.`);
  }

  if (kind === 'scope') {
    const scope = parseScopeGrantValue(rawValue);
    if (!scope) {
      return diagnostic(ruleValue, 'unsupported_grant', 'Scope grants must be explicit read: or write: boundaries.');
    }
    return { rule: { ruleValue, grant: { kind: 'scope', ...scope } } };
  }
  if (kind === 'external') return { rule: { ruleValue, grant: { kind: 'external', target: rawValue } } };
  return { rule: { ruleValue, grant: { kind: 'command', form: rawValue } } };
}

function grantsEqual(left: AgentPermissionGrant, right: AgentPermissionGrant): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'scope' && right.kind === 'scope') {
    return scopeAccessCovers(left.access, right.access) && isPathInside(left.root, right.root);
  }
  if (left.kind === 'external' && right.kind === 'external') return left.target === right.target;
  return left.kind === 'command' && right.kind === 'command' && left.form === right.form;
}

function parseScopeGrantValue(value: string): { access: AgentPermissionScopeAccess; root: string } | null {
  const match = /^(read|write):([\s\S]+)$/i.exec(value);
  if (!match) return null;
  const access = (match[1] ?? '').toLowerCase() as AgentPermissionScopeAccess;
  const root = (match[2] ?? '').trim();
  return root ? { access, root } : null;
}

function scopeAccessCovers(granted: AgentPermissionScopeAccess, requested: AgentPermissionScopeAccess): boolean {
  return granted === requested || granted === 'write';
}

function isPathInside(rootInput: string, filePathInput: string): boolean {
  const root = path.resolve(rootInput);
  const filePath = path.resolve(filePathInput);
  const relative = path.relative(root, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function diagnostic(
  ruleValue: string,
  code: GlobalToolPermissionRuleDiagnostic['code'],
  message: string,
): { diagnostic: GlobalToolPermissionRuleDiagnostic } {
  return { diagnostic: { ruleValue, code, message } };
}

function decisionRank(decision: GlobalToolPermissionDecision): number {
  if (decision === 'deny') return 2;
  if (decision === 'ask') return 1;
  return 0;
}

function descriptorRiskRank(descriptor: ToolActionDescriptor): number {
  let rank = 0;
  if (descriptor.effect.floor) rank += 10;
  if (descriptor.externalEffect) rank += 4;
  if (descriptor.highConsequence) rank += 2;
  if (descriptor.effect.touchesCredentials) rank += 2;
  if (descriptor.accessScope === 'outside_allowed_file_area') rank += 1;
  if (!descriptor.reversible) rank += 1;
  if (descriptor.actionKind.includes('unknown')) rank += 5;
  return rank;
}

function isParsedGlobalToolPermissionConfig(value: unknown): value is GlobalToolPermissionConfig {
  return isRecord(value)
    && Array.isArray(value.grants)
    && Array.isArray(value.diagnostics)
    && value.grants.every((grant) => (
      isRecord(grant)
      && typeof grant.ruleValue === 'string'
      && isRecord(grant.grant)
      && typeof grant.grant.kind === 'string'
    ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
