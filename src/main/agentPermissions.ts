import path from 'node:path';
import { homedir } from 'node:os';
import type { AgentPermissionMode } from '../core/types';

export type { AgentPermissionMode } from '../core/types';
export type AgentPermissionAccess = 'read' | 'write' | 'execute' | 'control' | 'unknown';

export interface AgentPermissionPolicy {
  mode: AgentPermissionMode;
  workspaceRoot: string;
  denyTools: readonly string[];
  preapprovedToolRules: readonly string[];
  allowOutsideWorkspaceRead: boolean;
  allowOutsideWorkspaceWrite: boolean;
}

export interface AgentPermissionPolicyInput {
  mode?: AgentPermissionMode;
  workspaceRoot?: string;
  denyTools?: readonly string[];
  preapprovedToolRules?: readonly string[];
  allowOutsideWorkspaceRead?: boolean;
  allowOutsideWorkspaceWrite?: boolean;
}

export interface AgentPermissionDecision {
  allow: boolean;
  reason?: string;
  code?: string;
  access?: AgentPermissionAccess;
  preapproved?: boolean;
}

export interface AgentPermissionEvaluationInput {
  toolName: string;
  args: unknown;
  policy: AgentPermissionPolicyInput;
}

const DEFAULT_DENY_TOOLS: readonly string[] = [];

const RESTRICTED_BASE_ALLOWED_TOOLS = new Set([
  'file_read',
  'file_glob',
  'file_grep',
  'web_search',
  'web_fetch',
  'skill',
  'task_stop',
]);

const TOOL_ALIASES = new Map<string, string>([
  ['bash', 'bash'],
  ['shell', 'bash'],
  ['read', 'file_read'],
  ['file_read', 'file_read'],
  ['glob', 'file_glob'],
  ['file_glob', 'file_glob'],
  ['grep', 'file_grep'],
  ['file_grep', 'file_grep'],
  ['edit', 'file_edit'],
  ['file_edit', 'file_edit'],
  ['write', 'file_write'],
  ['file_write', 'file_write'],
  ['webfetch', 'web_fetch'],
  ['web_fetch', 'web_fetch'],
  ['websearch', 'web_search'],
  ['web_search', 'web_search'],
  ['skill', 'skill'],
  ['task_stop', 'task_stop'],
]);

interface BashDenyRule {
  code: string;
  reason: string;
  pattern: RegExp;
}

const BASH_HARD_DENY_RULES: readonly BashDenyRule[] = [
  {
    code: 'dangerous_root_delete',
    reason: 'Blocked a command that appears to recursively delete the filesystem root, home directory, or entire workspace.',
    pattern: /(?:^|[;&|]\s*)rm\s+(?:-[^\s]*r[^\s]*f[^\s]*|-[^\s]*f[^\s]*r[^\s]*)\s+(?:\/(?:\s|$)|\/\*(?:\s|$)|~(?:\/?(?:\s|$))|\$HOME(?:\/?(?:\s|$))|\$\{HOME\}(?:\/?(?:\s|$))|\.(?:\/?\s|$)|\*(?:\s|$))/i,
  },
  {
    code: 'dangerous_disk_format',
    reason: 'Blocked a command that appears to format or erase a disk.',
    pattern: /\b(?:mkfs(?:\.[a-z0-9_-]+)?|diskutil\s+(?:erase|partition|apfs\s+delete)|newfs(?:_[a-z0-9_-]+)?)\b/i,
  },
  {
    code: 'dangerous_raw_disk_write',
    reason: 'Blocked a command that appears to write directly to a raw disk device.',
    pattern: /\bdd\s+[^;&|]*\bof=\/dev\/(?:disk|rdisk|sd[a-z]|nvme|xvd)/i,
  },
  {
    code: 'dangerous_power_command',
    reason: 'Blocked a command that appears to shut down or reboot the machine.',
    pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i,
  },
  {
    code: 'dangerous_permission_root',
    reason: 'Blocked a command that appears to recursively change permissions or ownership at filesystem root.',
    pattern: /\b(?:chmod|chown)\s+-R\s+[^;&|]*\s+\/(?:\s|$)/i,
  },
];

export function createAgentPermissionPolicy(input: AgentPermissionPolicyInput = {}): AgentPermissionPolicy {
  return {
    mode: input.mode ?? 'trusted',
    workspaceRoot: path.resolve(input.workspaceRoot ?? process.cwd()),
    denyTools: input.denyTools ?? DEFAULT_DENY_TOOLS,
    preapprovedToolRules: input.preapprovedToolRules ?? [],
    allowOutsideWorkspaceRead: input.allowOutsideWorkspaceRead ?? false,
    allowOutsideWorkspaceWrite: input.allowOutsideWorkspaceWrite ?? false,
  };
}

export function evaluateAgentToolPermission(input: AgentPermissionEvaluationInput): AgentPermissionDecision {
  const policy = createAgentPermissionPolicy(input.policy);
  const toolName = normalizeToolName(input.toolName);
  const access = classifyToolAccess(toolName);
  const preapproved = policy.preapprovedToolRules.some((rule) => matchesAgentToolRule(rule, toolName, input.args));

  if (policy.denyTools.some((rule) => matchesToolNameRule(rule, toolName))) {
    return deny('tool_denied', `Tool ${input.toolName} is denied by the active permission policy.`, access, preapproved);
  }

  const pathDecision = evaluatePathBoundary(toolName, input.args, policy, access, preapproved);
  if (!pathDecision.allow) return pathDecision;

  if (toolName === 'bash') {
    const command = getStringArg(input.args, 'command');
    const bashDecision = evaluateBashCommand(command, policy.workspaceRoot, access, preapproved);
    if (!bashDecision.allow) return bashDecision;
  }

  if (policy.mode === 'restricted' && !preapproved && !isRestrictedBaseAllowed(toolName)) {
    return deny(
      'tool_not_preapproved',
      `Tool ${input.toolName} requires a matching skill allowed-tools rule in restricted permission mode.`,
      access,
      preapproved,
    );
  }

  return { allow: true, access, preapproved };
}

export function matchesAgentToolRule(rule: string, toolNameInput: string, args: unknown): boolean {
  const trimmed = rule.trim();
  if (!trimmed) return false;
  if (trimmed === '*') return true;

  const toolName = normalizeToolName(toolNameInput);
  const match = /^([^()\s]+)(?:\(([\s\S]*)\))?$/.exec(trimmed);
  if (!match) return matchesToolNameRule(trimmed, toolName);

  const ruleTool = normalizeToolName(match[1] ?? '');
  if (!matchesToolNameRule(ruleTool, toolName)) return false;

  const pattern = match[2];
  if (pattern === undefined) return true;
  if (toolName !== 'bash') return true;

  const command = getStringArg(args, 'command');
  return command !== null && wildcardMatches(pattern.trim(), command);
}

function evaluatePathBoundary(
  toolName: string,
  args: unknown,
  policy: AgentPermissionPolicy,
  access: AgentPermissionAccess,
  preapproved: boolean,
): AgentPermissionDecision {
  const pathArgName = toolPathArgumentName(toolName);
  if (!pathArgName) return { allow: true, access, preapproved };

  const rawPath = getStringArg(args, pathArgName);
  if (!rawPath) return { allow: true, access, preapproved };

  const resolved = resolvePermissionPath(policy.workspaceRoot, rawPath);
  if (isPathInside(policy.workspaceRoot, resolved)) return { allow: true, access, preapproved };

  const isWrite = access === 'write';
  if (isWrite ? policy.allowOutsideWorkspaceWrite : policy.allowOutsideWorkspaceRead) {
    return { allow: true, access, preapproved };
  }

  return deny(
    'path_outside_workspace',
    `Tool ${toolName} cannot ${isWrite ? 'write outside' : 'access outside'} the local workspace: ${resolved}`,
    access,
    preapproved,
  );
}

function evaluateBashCommand(
  command: string | null,
  workspaceRoot: string,
  access: AgentPermissionAccess,
  preapproved: boolean,
): AgentPermissionDecision {
  if (!command) return { allow: true, access, preapproved };

  for (const rule of BASH_HARD_DENY_RULES) {
    if (rule.pattern.test(command)) {
      return deny(rule.code, rule.reason, access, preapproved);
    }
  }

  if (looksLikeWorkspaceRootDelete(command, workspaceRoot)) {
    return deny(
      'dangerous_workspace_delete',
      'Blocked a command that appears to recursively delete the entire workspace root.',
      access,
      preapproved,
    );
  }

  return { allow: true, access, preapproved };
}

function looksLikeWorkspaceRootDelete(command: string, workspaceRoot: string): boolean {
  if (!/(?:^|[;&|]\s*)rm\s+(?:-[^\s]*r[^\s]*f[^\s]*|-[^\s]*f[^\s]*r[^\s]*)/i.test(command)) {
    return false;
  }
  const words = parseShellWords(command).map((word) => resolvePermissionPath(workspaceRoot, word));
  return words.some((word) => word === workspaceRoot);
}

function toolPathArgumentName(toolName: string): string | null {
  if (toolName === 'file_read' || toolName === 'file_edit' || toolName === 'file_write') return 'file_path';
  if (toolName === 'file_glob' || toolName === 'file_grep') return 'path';
  return null;
}

function classifyToolAccess(toolName: string): AgentPermissionAccess {
  if (toolName === 'bash') return 'execute';
  if (toolName === 'task_stop') return 'control';
  if (toolName === 'file_edit' || toolName === 'file_write') return 'write';
  if (toolName === 'file_read' || toolName === 'file_glob' || toolName === 'file_grep' || toolName === 'web_fetch' || toolName === 'web_search') return 'read';
  return 'unknown';
}

function isRestrictedBaseAllowed(toolName: string): boolean {
  return RESTRICTED_BASE_ALLOWED_TOOLS.has(toolName) || toolName.startsWith('node_');
}

function matchesToolNameRule(rule: string, toolNameInput: string): boolean {
  const normalizedRule = normalizeToolName(rule);
  const toolName = normalizeToolName(toolNameInput);
  return normalizedRule === toolName || normalizedRule === '*';
}

function normalizeToolName(value: string): string {
  const normalized = value.trim().replace(/-/g, '_').toLowerCase();
  return TOOL_ALIASES.get(normalized) ?? normalized;
}

function getStringArg(args: unknown, name: string): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const value = (args as Record<string, unknown>)[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function resolvePermissionPath(root: string, inputPath: string): string {
  const expanded = expandHome(inputPath);
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(root, expanded));
}

function expandHome(inputPath: string): string {
  if (inputPath === '~') return homedir();
  if (inputPath.startsWith('~/')) return path.join(homedir(), inputPath.slice(2));
  return inputPath;
}

function isPathInside(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

function parseShellWords(command: string): string[] {
  const words: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s;&|]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    words.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\\(["\\])/g, '$1'));
  }
  return words;
}

function deny(
  code: string,
  reason: string,
  access: AgentPermissionAccess,
  preapproved: boolean,
): AgentPermissionDecision {
  return { allow: false, code, reason, access, preapproved };
}
