import path from 'node:path';
import { homedir } from 'node:os';
import type { AgentPermissionMode } from '../core/types';

export type { AgentPermissionMode } from '../core/types';
export type AgentPermissionAccess = 'read' | 'write' | 'execute' | 'control' | 'unknown';
export type AgentPermissionBehavior = 'allow' | 'ask' | 'deny';

export interface AgentApprovalDetail {
  label: string;
  value: string;
}

export interface AgentApprovalRequest {
  title: string;
  target: string;
  details: AgentApprovalDetail[];
  suggestedSessionRule?: string;
}

export interface AgentPermissionPolicy {
  mode: AgentPermissionMode;
  workspaceRoot: string;
  denyTools: readonly string[];
  preapprovedToolRules: readonly string[];
  sessionAllowRules: readonly string[];
  allowOutsideWorkspaceRead: boolean;
  allowOutsideWorkspaceWrite: boolean;
}

export interface AgentPermissionPolicyInput {
  mode?: AgentPermissionMode;
  workspaceRoot?: string;
  denyTools?: readonly string[];
  preapprovedToolRules?: readonly string[];
  sessionAllowRules?: readonly string[];
  allowOutsideWorkspaceRead?: boolean;
  allowOutsideWorkspaceWrite?: boolean;
}

interface AgentPermissionDecisionBase {
  behavior: AgentPermissionBehavior;
  access: AgentPermissionAccess;
  reason?: string;
  code?: string;
  preapproved: boolean;
  sessionApproved: boolean;
  ruleId?: string;
}

export interface AgentPermissionAllowDecision extends AgentPermissionDecisionBase {
  behavior: 'allow';
  visibility?: 'normal' | 'important';
}

export interface AgentPermissionAskDecision extends AgentPermissionDecisionBase {
  behavior: 'ask';
  code: string;
  reason: string;
  request: AgentApprovalRequest;
}

export interface AgentPermissionDenyDecision extends AgentPermissionDecisionBase {
  behavior: 'deny';
  code: string;
  reason: string;
  redline?: true;
}

export type AgentPermissionDecision =
  | AgentPermissionAllowDecision
  | AgentPermissionAskDecision
  | AgentPermissionDenyDecision;

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
  'past_chats',
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
  ['pastchats', 'past_chats'],
  ['past_chats', 'past_chats'],
  ['skill', 'skill'],
  ['task_stop', 'task_stop'],
]);

interface BashDenyRule {
  code: string;
  reason: string;
  pattern: RegExp;
}

interface BashAskRule {
  code: string;
  reason: string;
  title: string;
  pattern: RegExp;
  sessionRule?: (command: string) => string | undefined;
}

const BASH_HARD_DENY_RULES: readonly BashDenyRule[] = [
  {
    code: 'dangerous_root_delete',
    reason: 'Blocked a command that appears to recursively delete the filesystem root, home directory, or entire allowed file area.',
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
  {
    code: 'remote_code_execution',
    reason: 'Blocked a command that downloads remote code and pipes it directly into a shell.',
    pattern: /\b(?:curl|wget)\b[\s\S]*\|\s*(?:sh|bash|zsh|fish|python|python3|ruby|perl|node)\b/i,
  },
  {
    code: 'known_shell_obfuscation',
    reason: 'Blocked a command that appears to decode or evaluate hidden shell code.',
    pattern: /\b(?:base64\s+(?:--decode|-d)|openssl\s+enc\s+-d)[\s\S]*\|\s*(?:sh|bash|zsh|fish|eval)\b|\beval\s+["'`$]/i,
  },
];

const BASH_ASK_RULES: readonly BashAskRule[] = [
  {
    code: 'external_git_push',
    title: 'Approve GitHub push?',
    reason: 'This changes external state on a git remote.',
    pattern: /(?:^|[;&|]\s*)git\s+push\b/i,
    sessionRule: exactBashSessionRule,
  },
  {
    code: 'external_gh_mutation',
    title: 'Approve GitHub action?',
    reason: 'This changes external state through the GitHub CLI.',
    pattern: /(?:^|[;&|]\s*)gh\s+(?:pr\s+(?:create|edit|merge|close|reopen|ready|review)|issue\s+(?:create|edit|close|reopen|transfer)|release\s+(?:create|delete|edit|upload)|repo\s+(?:create|delete|fork)|workflow\s+run)\b/i,
    sessionRule: exactBashSessionRule,
  },
  {
    code: 'package_install',
    title: 'Approve package change?',
    reason: 'This can change installed dependencies or lockfiles.',
    pattern: /(?:^|[;&|]\s*)(?:(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update|upgrade|link|dlx|create)|brew\s+(?:install|upgrade|uninstall)|pip(?:3)?\s+install|uv\s+(?:add|remove|pip\s+install)|gem\s+install|cargo\s+install)\b/i,
    sessionRule: exactBashSessionRule,
  },
  {
    code: 'deploy_or_publish',
    title: 'Approve deploy or publish?',
    reason: 'This can publish artifacts or update a remote environment.',
    pattern: /(?:^|[;&|]\s*)(?:(?:npm|pnpm|yarn|bun)\s+publish|vercel\s+(?:deploy|--prod)|netlify\s+deploy|fly\s+deploy|wrangler\s+(?:deploy|publish)|firebase\s+deploy|supabase\s+db\s+push|railway\s+up)\b/i,
    sessionRule: exactBashSessionRule,
  },
  {
    code: 'network_write',
    title: 'Approve network write?',
    reason: 'This appears to send data to a network endpoint.',
    pattern: /\b(?:curl|wget)\b[\s\S]*(?:--data(?:-binary|-raw|-urlencode)?|-d\b|--form|-F\b|--upload-file|-T\b|-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s+(?:POST|PUT|PATCH|DELETE))\b|\b(?:scp|sftp|rsync|rclone\s+(?:copy|sync)|aws\s+s3\s+cp|gsutil\s+cp)\b/i,
    sessionRule: exactBashSessionRule,
  },
  {
    code: 'database_migration',
    title: 'Approve database change?',
    reason: 'This appears to run a database migration or push schema changes.',
    pattern: /(?:^|[;&|]\s*)(?:(?:npm|pnpm|yarn|bun)\s+run\s+[^;&|]*(?:migrat|db:push|prisma)|prisma\s+(?:migrate|db\s+push)|drizzle-kit\s+(?:push|migrate)|rails\s+db:migrate|alembic\s+upgrade)\b/i,
    sessionRule: exactBashSessionRule,
  },
];

const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)\.ssh(?:\/|$)/i,
  /(?:^|\/)\.gnupg(?:\/|$)/i,
  /(?:^|\/)\.aws(?:\/|$)/i,
  /(?:^|\/)\.azure(?:\/|$)/i,
  /(?:^|\/)\.config\/gh(?:\/|$)/i,
  /(?:^|\/)\.docker\/config\.json$/i,
  /(?:^|\/)Library\/Keychains(?:\/|$)/i,
  /(?:^|\/)\.npmrc$/i,
  /(?:^|\/)\.pypirc$/i,
  /(?:^|\/)\.netrc$/i,
  /(?:^|\/)\.env(?:$|[./-])/i,
  /(?:^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:$|\.)/i,
  /\.(?:pem|key|p12|pfx)$/i,
];

const SENSITIVE_COMMAND_PATTERNS: readonly RegExp[] = [
  /(?:~|\$HOME|\$\{HOME\})\/(?:\.ssh|\.gnupg|\.aws|\.azure|\.docker|Library\/Keychains)(?:\/|\b)/i,
  /(?:^|[\s=@:])(?:\.env(?:$|[\s./-])|\.npmrc\b|\.pypirc\b|\.netrc\b|id_rsa\b|id_ed25519\b|[^/\s]+\.pem\b|[^/\s]+\.key\b)/i,
];

export function createAgentPermissionPolicy(input: AgentPermissionPolicyInput = {}): AgentPermissionPolicy {
  return {
    mode: input.mode ?? 'trusted',
    workspaceRoot: path.resolve(input.workspaceRoot ?? process.cwd()),
    denyTools: input.denyTools ?? DEFAULT_DENY_TOOLS,
    preapprovedToolRules: input.preapprovedToolRules ?? [],
    sessionAllowRules: input.sessionAllowRules ?? [],
    allowOutsideWorkspaceRead: input.allowOutsideWorkspaceRead ?? false,
    allowOutsideWorkspaceWrite: input.allowOutsideWorkspaceWrite ?? false,
  };
}

export function evaluateAgentToolPermission(input: AgentPermissionEvaluationInput): AgentPermissionDecision {
  const policy = createAgentPermissionPolicy(input.policy);
  const toolName = normalizeToolName(input.toolName);
  const access = classifyToolAccess(toolName);
  const preapproved = policy.preapprovedToolRules.some((rule) => matchesAgentToolRule(rule, toolName, input.args));
  const sessionApproved = policy.sessionAllowRules.some((rule) => matchesAgentToolRule(rule, toolName, input.args));

  if (policy.denyTools.some((rule) => matchesToolNameRule(rule, toolName))) {
    return deny('tool_denied', `Tool ${input.toolName} is not available for this run.`, access, preapproved, sessionApproved);
  }

  const pathDecision = evaluatePathBoundary(toolName, input.args, policy, access, preapproved, sessionApproved);
  if (pathDecision.behavior !== 'allow') return pathDecision;

  if (toolName === 'bash') {
    const command = getStringArg(input.args, 'command');
    const bashDecision = evaluateBashCommand(command, input.args, policy.workspaceRoot, access, preapproved, sessionApproved);
    if (bashDecision.behavior === 'deny') return bashDecision;
    if (policy.mode === 'restricted' && !preapproved && !sessionApproved && !isRestrictedBaseAllowed(toolName)) {
      return deny(
        'tool_not_preapproved',
        `Tool ${input.toolName} is not available for this run.`,
        access,
        preapproved,
        sessionApproved,
      );
    }
    if (bashDecision.behavior === 'ask') return bashDecision;
  }

  if (policy.mode === 'restricted' && !preapproved && !sessionApproved && !isRestrictedBaseAllowed(toolName)) {
    return deny(
      'tool_not_preapproved',
      `Tool ${input.toolName} is not available for this run.`,
      access,
      preapproved,
      sessionApproved,
    );
  }

  return allow(access, preapproved, sessionApproved, sessionApproved ? 'Allowed by a session permission rule.' : undefined, sessionApproved ? 'important' : undefined);
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
  sessionApproved: boolean,
): AgentPermissionDecision {
  const pathArgName = toolPathArgumentName(toolName);
  if (!pathArgName) return allow(access, preapproved, sessionApproved);

  const rawPath = getStringArg(args, pathArgName);
  if (!rawPath) return allow(access, preapproved, sessionApproved);

  const resolved = resolvePermissionPath(policy.workspaceRoot, rawPath);
  const isInsideWorkspace = isPathInside(policy.workspaceRoot, resolved);
  const isWrite = access === 'write';

  if (!isInsideWorkspace && !(isWrite ? policy.allowOutsideWorkspaceWrite : policy.allowOutsideWorkspaceRead)) {
    return deny(
      'path_outside_workspace',
      `Tool ${toolName} cannot ${isWrite ? 'write outside' : 'access outside'} the allowed file area: ${resolved}`,
      access,
      preapproved,
      sessionApproved,
    );
  }

  if (isSensitivePath(resolved) && !sessionApproved) {
    const action = isWrite ? 'write' : 'read';
    return ask(
      `sensitive_path_${action}`,
      `This would ${action} a sensitive local path: ${resolved}`,
      access,
      preapproved,
      sessionApproved,
      {
        title: `Approve sensitive file ${action}?`,
        target: resolved,
        details: [
          { label: 'Tool', value: toolName },
          { label: 'Path', value: resolved },
          { label: 'Why asking', value: `This path may contain credentials or local secrets.` },
        ],
      },
    );
  }

  return allow(access, preapproved, sessionApproved, sessionApproved ? 'Allowed by a session permission rule.' : undefined, sessionApproved ? 'important' : undefined);
}

function evaluateBashCommand(
  command: string | null,
  args: unknown,
  workspaceRoot: string,
  access: AgentPermissionAccess,
  preapproved: boolean,
  sessionApproved: boolean,
): AgentPermissionDecision {
  if (!command) return allow(access, preapproved, sessionApproved);

  for (const rule of BASH_HARD_DENY_RULES) {
    if (rule.pattern.test(command)) {
      return deny(rule.code, rule.reason, access, preapproved, sessionApproved, true);
    }
  }

  if (looksLikeWorkspaceRootDelete(command, workspaceRoot)) {
    return deny(
      'dangerous_workspace_delete',
      'Blocked a command that appears to recursively delete the entire allowed file area.',
      access,
      preapproved,
      sessionApproved,
      true,
    );
  }

  const mentionsSensitivePath = commandMentionsSensitivePath(command, workspaceRoot);
  if (mentionsSensitivePath && looksLikeNetworkWrite(command)) {
    return deny(
      'sensitive_data_exfiltration',
      'Blocked a command that appears to send sensitive local data to a network endpoint.',
      access,
      preapproved,
      sessionApproved,
      true,
    );
  }

  if (getBooleanArg(args, 'dangerouslyDisableSandbox')) {
    return askBash(
      'sandbox_override',
      'Approve command override?',
      'The command requested an execution override.',
      command,
      workspaceRoot,
      access,
      preapproved,
      sessionApproved,
    );
  }

  if (getBooleanArg(args, 'run_in_background')) {
    return askBash(
      'background_process',
      'Approve background command?',
      'This starts a process that can keep running after the current turn.',
      command,
      workspaceRoot,
      access,
      preapproved,
      sessionApproved,
    );
  }

  if (sessionApproved) {
    return allow(access, preapproved, sessionApproved, 'Allowed by a session permission rule.', 'important');
  }

  if (looksLikeUnscopedRecursiveDelete(command, workspaceRoot)) {
    return askBash(
      'destructive_cleanup',
      'Approve destructive cleanup?',
      'This recursively deletes files outside an obviously scoped project path.',
      command,
      workspaceRoot,
      access,
      preapproved,
      sessionApproved,
      exactBashSessionRule(command),
    );
  }

  if (mentionsSensitivePath) {
    return askBash(
      'sensitive_path_shell',
      'Approve sensitive file access?',
      'This command references a path that may contain credentials or local secrets.',
      command,
      workspaceRoot,
      access,
      preapproved,
      sessionApproved,
      exactBashSessionRule(command),
    );
  }

  for (const rule of BASH_ASK_RULES) {
    if (rule.pattern.test(command)) {
      return askBash(
        rule.code,
        rule.title,
        rule.reason,
        command,
        workspaceRoot,
        access,
        preapproved,
        sessionApproved,
        rule.sessionRule?.(command),
      );
    }
  }

  return allow(access, preapproved, sessionApproved);
}

function askBash(
  code: string,
  title: string,
  reason: string,
  command: string,
  workspaceRoot: string,
  access: AgentPermissionAccess,
  preapproved: boolean,
  sessionApproved: boolean,
  suggestedSessionRule?: string,
): AgentPermissionAskDecision {
  return ask(code, reason, access, preapproved, sessionApproved, {
    title,
    target: command,
    suggestedSessionRule,
    details: [
      { label: 'Command', value: command },
      { label: 'Cwd', value: workspaceRoot },
      { label: 'Why asking', value: reason },
      { label: 'Matched rule', value: code },
    ],
  });
}

function looksLikeWorkspaceRootDelete(command: string, workspaceRoot: string): boolean {
  if (!/(?:^|[;&|]\s*)rm\s+(?:-[^\s]*r[^\s]*f[^\s]*|-[^\s]*f[^\s]*r[^\s]*)/i.test(command)) {
    return false;
  }
  const words = parseShellWords(command).map((word) => resolvePermissionPath(workspaceRoot, stripShellPathDecoration(word)));
  return words.some((word) => word === workspaceRoot);
}

function looksLikeUnscopedRecursiveDelete(command: string, workspaceRoot: string): boolean {
  const deletePattern = /(?:^|[;&|]\s*)rm\s+([^;&|]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = deletePattern.exec(command)) !== null) {
    const part = match[0].replace(/^[;&|]\s*/, '');
    if (!/^rm\s+(?:-[^\s]*r[^\s]*f[^\s]*|-[^\s]*f[^\s]*r[^\s]*)/i.test(part)) continue;
    const targets = parseShellWords(part)
      .slice(1)
      .filter((word) => !word.startsWith('-'));
    if (targets.length === 0) return true;
    if (targets.some((word) => {
      const resolved = resolvePermissionPath(workspaceRoot, stripShellPathDecoration(word));
      return !isPathInside(workspaceRoot, resolved) || resolved === workspaceRoot || isSensitivePath(resolved);
    })) {
      return true;
    }
  }
  return false;
}

function commandMentionsSensitivePath(command: string, workspaceRoot: string): boolean {
  if (SENSITIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) return true;
  return parseShellWords(command).some((word) => {
    const cleaned = stripShellPathDecoration(word);
    if (!looksLikePath(cleaned)) return false;
    return isSensitivePath(resolvePermissionPath(workspaceRoot, cleaned));
  });
}

function looksLikeNetworkWrite(command: string): boolean {
  return /\b(?:curl|wget)\b[\s\S]*(?:--data(?:-binary|-raw|-urlencode)?|-d\b|--form|-F\b|--upload-file|-T\b|-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s+(?:POST|PUT|PATCH|DELETE))\b|\b(?:scp|sftp|rsync|rclone\s+(?:copy|sync)|aws\s+s3\s+cp|gsutil\s+cp|nc|netcat)\b/i.test(command);
}

function isSensitivePath(filePath: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(filePath));
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
  if (toolName === 'file_read' || toolName === 'file_glob' || toolName === 'file_grep' || toolName === 'web_fetch' || toolName === 'web_search' || toolName === 'past_chats') return 'read';
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

function getBooleanArg(args: unknown, name: string): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  return (args as Record<string, unknown>)[name] === true;
}

function resolvePermissionPath(root: string, inputPath: string): string {
  const expanded = expandHome(inputPath);
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(root, expanded));
}

function expandHome(inputPath: string): string {
  if (inputPath === '~') return homedir();
  if (inputPath.startsWith('~/')) return path.join(homedir(), inputPath.slice(2));
  if (inputPath.startsWith('$HOME/')) return path.join(homedir(), inputPath.slice(6));
  if (inputPath.startsWith('${HOME}/')) return path.join(homedir(), inputPath.slice(8));
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

function stripShellPathDecoration(value: string): string {
  return value
    .replace(/^[@<>=:]+/, '')
    .replace(/[),]+$/, '');
}

function looksLikePath(value: string): boolean {
  return value === '~'
    || value.startsWith('~/')
    || value.startsWith('/')
    || value.startsWith('./')
    || value.startsWith('../')
    || value.startsWith('$HOME/')
    || value.startsWith('${HOME}/')
    || value.startsWith('.env')
    || value.startsWith('.npmrc')
    || value.startsWith('.pypirc')
    || value.startsWith('.netrc');
}

function exactBashSessionRule(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 240 || /[()]/.test(trimmed)) return undefined;
  return `Bash(${trimmed})`;
}

function allow(
  access: AgentPermissionAccess,
  preapproved: boolean,
  sessionApproved: boolean,
  reason?: string,
  visibility?: 'normal' | 'important',
): AgentPermissionAllowDecision {
  return { behavior: 'allow', access, preapproved, sessionApproved, reason, visibility };
}

function ask(
  code: string,
  reason: string,
  access: AgentPermissionAccess,
  preapproved: boolean,
  sessionApproved: boolean,
  request: AgentApprovalRequest,
): AgentPermissionAskDecision {
  return { behavior: 'ask', code, reason, access, preapproved, sessionApproved, request };
}

function deny(
  code: string,
  reason: string,
  access: AgentPermissionAccess,
  preapproved: boolean,
  sessionApproved: boolean,
  redline?: true,
): AgentPermissionDenyDecision {
  return { behavior: 'deny', code, reason, access, preapproved, sessionApproved, redline };
}
