import path from 'node:path';
import { homedir } from 'node:os';
import type { AgentPermissionMode, AgentSafetyMode } from '../core/types';
import {
  ARBITRARY_CODE_SHELL_PREFIXES,
  OUTWARD_FACING_SHELL_PREFIXES,
  alwaysAllowRuleForDescriptor,
  compareToolPermissionResolutionPriority,
  parseGlobalToolPermissionSettings,
  resolveGlobalToolPermissionDecision,
  type AgentToolActionKind,
  type GlobalToolPermissionConfig,
  type GlobalToolPermissionDecision,
  type ToolAccessScope,
  type ToolActionDescriptor,
} from './agentToolPermissionRules';
import { resolveSkillContentTarget } from './agentSkills';

export type { AgentPermissionMode, AgentSafetyMode } from '../core/types';
export type {
  AgentToolActionKind,
  GlobalToolPermissionConfig,
  GlobalToolPermissionDecision,
  ToolAccessScope,
  ToolActionDescriptor,
} from './agentToolPermissionRules';
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
  alwaysAllowRule?: string;
}

export interface AgentPermissionPolicy {
  mode: AgentPermissionMode;
  safetyMode: AgentSafetyMode;
  workspaceRoot: string;
  denyTools: readonly string[];
  preapprovedToolRules: readonly string[];
  allowOutsideWorkspaceRead: boolean;
  allowOutsideWorkspaceWrite: boolean;
  globalPermissions: GlobalToolPermissionConfig;
  // Skill-dir config, so `agent.skill.write` classification uses the same skill-path
  // source of truth as the loader and the file-tool gateway (resolveSkillContentTarget).
  includeUserSkills: boolean;
  additionalSkillDirectories: readonly string[];
}

export interface AgentPermissionPolicyInput {
  mode?: AgentPermissionMode;
  safetyMode?: AgentSafetyMode;
  workspaceRoot?: string;
  denyTools?: readonly string[];
  preapprovedToolRules?: readonly string[];
  allowOutsideWorkspaceRead?: boolean;
  allowOutsideWorkspaceWrite?: boolean;
  globalPermissions?: unknown;
  includeUserSkills?: boolean;
  additionalSkillDirectories?: readonly string[];
}

interface AgentPermissionDecisionBase {
  behavior: AgentPermissionBehavior;
  access: AgentPermissionAccess;
  reason?: string;
  code?: string;
  preapproved: boolean;
  ruleId?: string;
  permissionSource?: 'configured_allow' | 'configured_ask' | 'default' | 'safety_mode_profile' | 'trust_ledger';
  descriptor?: ToolActionDescriptor;
  descriptors?: readonly ToolActionDescriptor[];
}

export interface AgentPermissionAllowDecision extends AgentPermissionDecisionBase {
  behavior: 'allow';
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

export interface AgentPermissionClassifierProjection {
  tool: string;
  input: Record<string, unknown>;
}

interface DerivedToolActionDescriptor extends ToolActionDescriptor {
  requestTitle?: string;
  requestTarget?: string;
  requestDetails?: AgentApprovalDetail[];
  redline?: true;
}

const DEFAULT_DENY_TOOLS: readonly string[] = [];

const RESTRICTED_BASE_ALLOWED_TOOLS = new Set([
  'file_read',
  'file_glob',
  'file_grep',
  'web_search',
  'web_fetch',
  'recall',
  'ask_user_question',
  'runtime_status',
  'config',
  'doctor',
  'dream',
  'skill',
  'task_stop',
  'node_read',
  'node_search',
  'operation_history',
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
  ['recall', 'recall'],
  ['ask_user_question', 'ask_user_question'],
  ['askuserquestion', 'ask_user_question'],
  ['runtime_status', 'runtime_status'],
  ['runtimestatus', 'runtime_status'],
  ['config', 'config'],
  ['doctor', 'doctor'],
  ['dream', 'dream'],
  ['skill', 'skill'],
  ['task_stop', 'task_stop'],
  ['agent', 'agent'],
  ['agentstatus', 'agent_status'],
  ['agent_status', 'agent_status'],
  ['agentsend', 'agent_send'],
  ['agent_send', 'agent_send'],
  ['agentstop', 'agent_stop'],
  ['agent_stop', 'agent_stop'],
  ['node_read', 'node_read'],
  ['node_search', 'node_search'],
  ['node_create', 'node_create'],
  ['node_edit', 'node_edit'],
  ['node_delete', 'node_delete'],
  ['operation_history', 'operation_history'],
]);

interface BashDenyRule {
  code: string;
  reason: string;
  pattern: RegExp;
}

const BASH_HARD_DENY_RULES: readonly BashDenyRule[] = [
  {
    code: 'dangerous_root_delete',
    reason: 'Blocked a command that appears to recursively delete the filesystem root, home directory, or entire allowed file area.',
    pattern: /(?:^|[;&|]\s*|\s-(?:exec|execdir|ok|okdir)\s+)rm\s+(?:-[^\s]*r[^\s]*f[^\s]*|-[^\s]*f[^\s]*r[^\s]*)\s+(?:\/(?:\s|$)|\/\*(?:\s|$)|~(?:\/?(?:\s|$))|\$HOME(?:\/?(?:\s|$))|\$\{HOME\}(?:\/?(?:\s|$))|\.(?:\/?\s|$)|\*(?:\s|$))/i,
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
  /(?:^|[\s=@:])(?:\.env(?:$|[\s./-])|\.npmrc\b|\.pypirc\b|\.netrc\b|id_rsa\b|id_dsa\b|id_ecdsa\b|id_ed25519\b|[^/\s]+\.pem\b|[^/\s]+\.key\b)/i,
];

// Opaque sinks that can ship bytes off the machine without an obvious network
// verb: inline interpreter execution (python -c / node -e / perl -e / ruby -e /
// php -r / osascript -e) and ssh remote-command execution. Used only to widen the
// exfiltration redline, which ALSO requires a sensitive-path mention — so a false
// positive can only force an approval on an already-sensitive command, never relax
// one.
const EXFIL_OPAQUE_SINK_PATTERNS: readonly RegExp[] = [
  /\b(?:python[0-9.]*|node|deno|bun|perl|ruby|php|osascript)\b[^\n|;&]*\s(?:-(?:c|e|r|E)\b|--(?:eval|exec|command|run)\b)/i,
  /\bssh\b\s+(?:-\S+\s+)*[^\s-]\S*\s+\S/i,
];

export function createAgentPermissionPolicy(input: AgentPermissionPolicyInput = {}): AgentPermissionPolicy {
  return {
    mode: input.mode ?? 'trusted',
    safetyMode: input.safetyMode ?? 'balanced',
    workspaceRoot: path.resolve(input.workspaceRoot ?? process.cwd()),
    denyTools: input.denyTools ?? DEFAULT_DENY_TOOLS,
    preapprovedToolRules: input.preapprovedToolRules ?? [],
    allowOutsideWorkspaceRead: input.allowOutsideWorkspaceRead ?? false,
    allowOutsideWorkspaceWrite: input.allowOutsideWorkspaceWrite ?? false,
    globalPermissions: parseGlobalToolPermissionSettings(input.globalPermissions),
    includeUserSkills: input.includeUserSkills ?? true,
    additionalSkillDirectories: input.additionalSkillDirectories ?? [],
  };
}

export function evaluateAgentToolPermission(input: AgentPermissionEvaluationInput): AgentPermissionDecision {
  const policy = createAgentPermissionPolicy(input.policy);
  const toolName = normalizeToolName(input.toolName);
  const access = classifyToolAccess(toolName);
  const preapproved = policy.preapprovedToolRules.some((rule) => matchesAgentToolRule(rule, toolName, input.args));

  if (policy.denyTools.some((rule) => matchesToolNameRule(rule, toolName))) {
    return deny('tool_denied', `Tool ${input.toolName} is not available for this run.`, access, preapproved);
  }

  const descriptors = deriveAgentToolActionDescriptors({
    toolName,
    args: input.args,
    policy,
    access,
  });
  const platformBlock = descriptors.find((descriptor) => descriptor.platformHardBlock);
  if (platformBlock) {
    return deny(
      platformBlock.code ?? 'platform_hard_block',
      platformBlock.consequence,
      access,
      preapproved,
      platformBlock.redline,
      {
        descriptor: platformBlock,
        descriptors,
      },
    );
  }

  const globalResolution = resolveGlobalToolPermissionDecision(descriptors, policy.globalPermissions);
  if (globalResolution?.source === 'configured_deny') {
    return deny(
      'configured_deny',
      `A global permission rule denied ${globalResolution.descriptor.title}.`,
      access,
      preapproved,
      undefined,
      {
        descriptor: globalResolution.descriptor,
        descriptors,
      },
    );
  }

  if (policy.mode === 'restricted' && !preapproved && !isRestrictedBaseAllowed(toolName)) {
    return deny(
      'tool_not_preapproved',
      `Tool ${input.toolName} is not available for this run.`,
      access,
      preapproved,
      undefined,
      {
        descriptors,
      },
    );
  }

  if (globalResolution?.source === 'configured_allow') {
    return allow(
      access,
      preapproved,
      `Allowed by global rule ${globalResolution.rule?.ruleValue ?? globalResolution.descriptor.actionKind}.`,
      {
        descriptor: globalResolution.descriptor,
        descriptors,
        permissionSource: 'configured_allow',
      },
    );
  }

  if (globalResolution?.source === 'configured_ask') {
    return askForDescriptor(
      globalResolution.descriptor as DerivedToolActionDescriptor,
      access,
      preapproved,
      globalResolution.source === 'configured_ask' ? 'configured_ask' : 'default',
      descriptors,
    );
  }

  const profileResolution = resolveSafetyModeProfileDecision(descriptors, policy.safetyMode);
  if (profileResolution.decision === 'deny') {
    return deny(
      profileResolution.descriptor.code ?? profileResolution.descriptor.actionKind,
      profileResolution.descriptor.consequence,
      access,
      preapproved,
      profileResolution.descriptor.redline,
      {
        descriptor: profileResolution.descriptor,
        descriptors,
      },
    );
  }
  if (profileResolution.decision === 'ask') {
    return askForDescriptor(
      profileResolution.descriptor,
      access,
      preapproved,
      profileResolution.source,
      descriptors,
    );
  }
  return allow(
    access,
    preapproved,
    profileResolution.source === 'safety_mode_profile'
      ? `Allowed by ${policy.safetyMode} safety mode.`
      : undefined,
    {
      descriptor: profileResolution.descriptor,
      descriptors,
      permissionSource: profileResolution.source,
    },
  );
}

type SafetyModeProfileSource = 'default' | 'safety_mode_profile';

interface SafetyModeProfileResolution {
  decision: GlobalToolPermissionDecision;
  source: SafetyModeProfileSource;
  descriptor: DerivedToolActionDescriptor;
}

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
  'agent.skill.write',
  'shell.background_process',
]);

function resolveSafetyModeProfileDecision(
  descriptors: readonly DerivedToolActionDescriptor[],
  safetyMode: AgentSafetyMode,
): SafetyModeProfileResolution {
  const resolutions = descriptors.map((descriptor): SafetyModeProfileResolution => {
    const decision = safetyModeDecisionForDescriptor(descriptor, safetyMode);
    return {
      decision,
      source: decision === descriptor.defaultDecision ? 'default' : 'safety_mode_profile',
      descriptor,
    };
  });
  resolutions.sort((left, right) => (
    compareToolPermissionResolutionPriority(left, right, (resolution) => permissionSourceRank(resolution.source))
  ));
  return resolutions[0] ?? {
    decision: 'deny',
    source: 'default',
    descriptor: unknownShellDescriptor('No permission descriptor was derived.'),
  };
}

function safetyModeDecisionForDescriptor(
  descriptor: DerivedToolActionDescriptor,
  safetyMode: AgentSafetyMode,
): GlobalToolPermissionDecision {
  if (descriptor.defaultDecision === 'deny') return 'deny';
  if (safetyMode === 'balanced') return descriptor.defaultDecision;
  if (safetyMode === 'ask_first') {
    return ASK_FIRST_ASK_ACTIONS.has(descriptor.actionKind) ? 'ask' : descriptor.defaultDecision;
  }
  if (FULL_ACCESS_ALLOW_ACTIONS.has(descriptor.actionKind)) return 'allow';
  return descriptor.defaultDecision;
}

function permissionSourceRank(source: SafetyModeProfileSource): number {
  return source === 'safety_mode_profile' ? 1 : 0;
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

export function deriveAgentToolActionDescriptors(input: {
  toolName: string;
  args: unknown;
  policy: AgentPermissionPolicy;
  access: AgentPermissionAccess;
}): DerivedToolActionDescriptor[] {
  const toolName = normalizeToolName(input.toolName);
  if (toolName === 'bash') {
    return deriveBashActionDescriptors(getStringArg(input.args, 'command'), input.args, input.policy.workspaceRoot);
  }

  const pathArgName = toolPathArgumentName(toolName);
  if (pathArgName) {
    return [derivePathToolActionDescriptor(toolName, input.args, input.policy, input.access, pathArgName)];
  }

  if (toolName === 'web_search') {
    return [descriptor(toolName, 'web.search', {
      accessScope: 'external_system',
      title: 'web search',
      summary: 'Search external information.',
      consequence: 'This reads public web search results.',
      defaultDecision: 'allow',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
      classifierAutoAllowEligible: false,
    })];
  }

  if (toolName === 'web_fetch') {
    const url = getStringArg(input.args, 'url') ?? 'web page';
    return [descriptor(toolName, 'web.fetch', {
      accessScope: 'external_system',
      title: 'web fetch',
      summary: `Fetch external content from ${url}.`,
      consequence: 'This contacts an external website and reads its response.',
      defaultDecision: 'ask',
      reversible: true,
      externalEffect: true,
      highConsequence: false,
      classifierAutoAllowEligible: false,
      requestTitle: 'Approve web fetch?',
      requestTarget: url,
    })];
  }

  if (toolName === 'recall') {
    return [descriptor(toolName, 'agent.memory.recall', {
      accessScope: 'none',
      title: 'agent memory recall',
      summary: "Read the local agent's active distilled memory entries (cued retrieval).",
      consequence: 'This reads local agent memory and optional cited episodic evidence without changing it.',
      defaultDecision: 'allow',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
      classifierAutoAllowEligible: false,
    })];
  }

  if (toolName === 'dream') {
    return [descriptor(toolName, 'agent.memory.dream', {
      accessScope: 'none',
      title: 'agent memory dream',
      summary: 'Request runtime-owned memory consolidation (Dream) for the current agent.',
      consequence: 'This may consolidate recorded episodic evidence into local durable agent memory; the model cannot provide memory facts directly.',
      defaultDecision: 'ask',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
      classifierAutoAllowEligible: false,
      requestTitle: 'Approve Memory Dream?',
      requestTarget: 'current agent memory',
    })];
  }

  if (toolName === 'ask_user_question') {
    return [descriptor(toolName, 'agent.user_question.ask', {
      accessScope: 'none',
      title: 'ask user question',
      summary: 'Pause the run to ask the user for structured input.',
      consequence: 'This waits for explicit user input and does not read or mutate local or external data.',
      defaultDecision: 'allow',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
      classifierAutoAllowEligible: false,
    })];
  }

  if (toolName === 'runtime_status') {
    return [descriptor(toolName, 'agent.runtime.status', {
      accessScope: 'none',
      title: 'runtime status',
      summary: 'Read redacted local agent runtime status.',
      consequence: 'This reads local runtime settings and provider status without secrets.',
      defaultDecision: 'allow',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
      classifierAutoAllowEligible: false,
    })];
  }

  if (toolName === 'doctor') {
    return [descriptor(toolName, 'agent.doctor.run', {
      accessScope: 'none',
      title: 'runtime doctor',
      summary: 'Run read-only local agent diagnostics.',
      consequence: 'This reads local diagnostic state without secrets or mutation.',
      defaultDecision: 'allow',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
      classifierAutoAllowEligible: false,
    })];
  }

  if (toolName === 'config') {
    const argsRecord = input.args && typeof input.args === 'object' && !Array.isArray(input.args)
      ? input.args as Record<string, unknown>
      : null;
    const writes = !!argsRecord && Object.hasOwn(argsRecord, 'value');
    return [descriptor(toolName, writes ? 'agent.config.write' : 'agent.config.read', {
      accessScope: 'none',
      title: writes ? 'agent config write' : 'agent config read',
      summary: writes ? 'Update a whitelisted local agent runtime setting.' : 'Read a whitelisted local agent runtime setting.',
      consequence: writes
        ? 'This changes local agent runtime behavior through a whitelisted settings API.'
        : 'This reads local agent runtime configuration without secrets.',
      defaultDecision: writes ? 'ask' : 'allow',
      reversible: writes,
      externalEffect: false,
      highConsequence: false,
      classifierAutoAllowEligible: false,
      requestTitle: writes ? 'Approve agent config change?' : undefined,
      requestTarget: getStringArg(argsRecord, 'setting') ?? 'agent runtime setting',
    })];
  }

  if (toolName === 'node_read' || toolName === 'node_search' || toolName === 'operation_history') {
    return [descriptor(toolName, 'outline.read', {
      accessScope: 'allowed_file_area',
      title: 'local document read',
      summary: 'Read local outliner or agent history data.',
      consequence: 'This reads local product data without changing it.',
      defaultDecision: 'allow',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
      classifierAutoAllowEligible: false,
    })];
  }

  if (toolName === 'node_create' || toolName === 'node_edit') {
    return [descriptor(toolName, 'outline.edit', {
      accessScope: 'allowed_file_area',
      title: 'local document edit',
      summary: 'Edit local outliner content.',
      consequence: 'This changes local documents inside Lin.',
      defaultDecision: 'allow',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
      classifierAutoAllowEligible: false,
    })];
  }

  if (toolName === 'node_delete') {
    return [descriptor(toolName, 'outline.delete', {
      accessScope: 'allowed_file_area',
      title: 'local document delete',
      summary: 'Delete local outliner content.',
      consequence: 'This can remove local document content.',
      defaultDecision: 'ask',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
      classifierAutoAllowEligible: false,
      requestTitle: 'Approve local delete?',
    })];
  }

  if (toolName === 'task_stop' || toolName === 'agent_stop') {
    return [descriptor(toolName, toolName === 'agent_stop' ? 'agent.delegate.stop' : 'task.stop', {
      accessScope: 'none',
      title: toolName === 'agent_stop' ? 'child run stop' : 'background task stop',
      summary: toolName === 'agent_stop' ? 'Stop a background child run.' : 'Stop a background task launched by the agent.',
      consequence: toolName === 'agent_stop' ? 'This controls a local background child run.' : 'This only controls a local background task.',
      defaultDecision: 'allow',
      reversible: false,
      externalEffect: false,
      highConsequence: false,
      classifierAutoAllowEligible: false,
    })];
  }

  if (toolName === 'agent_status') {
    return [descriptor(toolName, 'agent.delegate.status', {
      accessScope: 'none',
      title: 'child run status',
      summary: 'Read the status of a background child run.',
      consequence: 'This reads local child run state.',
      defaultDecision: 'allow',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
      classifierAutoAllowEligible: false,
    })];
  }

  if (toolName === 'agent_send') {
    return [descriptor(toolName, 'agent.delegate.send', {
      accessScope: 'none',
      title: 'child run message',
      summary: 'Send a follow-up message to an existing child run.',
      consequence: 'This can steer an already-running local child run.',
      defaultDecision: 'allow',
      reversible: false,
      externalEffect: false,
      highConsequence: false,
      classifierAutoAllowEligible: false,
    })];
  }

  if (toolName === 'agent') {
    return [descriptor(toolName, 'agent.delegate.spawn', {
      accessScope: 'none',
      title: 'child run spawn',
      summary: 'Start or message a child run.',
      consequence: 'This can create another agent process that may take further actions.',
      defaultDecision: 'ask',
      reversible: false,
      externalEffect: false,
      highConsequence: true,
      classifierAutoAllowEligible: false,
      capabilities: ['agent_spawn'],
      requestTitle: 'Approve child run action?',
    })];
  }

  if (toolName === 'skill') {
    return [descriptor(toolName, 'agent.skill.invoke', {
      accessScope: 'none',
      title: 'skill invocation',
      summary: 'Invoke an installed agent skill.',
      consequence: 'This can run skill instructions and any narrowed tool permissions attached to that skill.',
      defaultDecision: 'allow',
      reversible: false,
      externalEffect: false,
      highConsequence: false,
      classifierAutoAllowEligible: false,
    })];
  }

  return [descriptor(toolName, 'shell.unknown', {
    accessScope: 'none',
    title: 'unknown tool action',
    summary: `Use unknown tool ${toolName}.`,
    consequence: `Tool ${toolName} is outside the supported permission classification surface.`,
    defaultDecision: 'deny',
    reversible: false,
    externalEffect: false,
    highConsequence: true,
    classifierAutoAllowEligible: false,
    code: 'unknown_tool_action',
    platformHardBlock: true,
    redline: true,
  })];
}

function derivePathToolActionDescriptor(
  toolName: string,
  args: unknown,
  policy: AgentPermissionPolicy,
  access: AgentPermissionAccess,
  pathArgName: string,
): DerivedToolActionDescriptor {
  const rawPath = getStringArg(args, pathArgName);
  const isWrite = access === 'write';
  const baseAction = fileActionKind(toolName, isWrite, 'allowed_file_area');
  if (!rawPath) {
    return descriptor(toolName, baseAction, {
      accessScope: 'allowed_file_area',
      title: isWrite ? 'local file edit' : 'local file read',
      summary: `${isWrite ? 'Edit' : 'Read'} a path in the allowed file area.`,
      consequence: isWrite ? 'This changes local files inside the allowed file area.' : 'This reads local files inside the allowed file area.',
      defaultDecision: 'allow',
      reversible: !isWrite,
      externalEffect: false,
      highConsequence: false,
      classifierAutoAllowEligible: false,
    });
  }

  const resolved = resolvePermissionPath(policy.workspaceRoot, rawPath);
  const isInsideWorkspace = isPathInside(policy.workspaceRoot, resolved);
  const outsideAllowed = isWrite ? policy.allowOutsideWorkspaceWrite : policy.allowOutsideWorkspaceRead;

  if (!isInsideWorkspace && !outsideAllowed) {
    return descriptor(toolName, fileActionKind(toolName, isWrite, 'outside_allowed_file_area'), {
      accessScope: 'outside_allowed_file_area',
      title: isWrite ? 'outside-area file write' : 'outside-area file read',
      summary: `${isWrite ? 'Write' : 'Read'} ${resolved} outside the allowed file area.`,
      consequence: `Tool ${toolName} cannot ${isWrite ? 'write outside' : 'access outside'} the allowed file area: ${resolved}`,
      defaultDecision: 'deny',
      reversible: false,
      externalEffect: false,
      highConsequence: true,
      classifierAutoAllowEligible: false,
      code: 'path_outside_workspace',
      platformHardBlock: true,
    });
  }

  if (isWrite && isHardBlockedSensitiveWritePath(resolved)) {
    return descriptor(toolName, 'file.write.sensitive_local_path', {
      accessScope: 'sensitive_local_path',
      title: 'sensitive file write',
      summary: `Write sensitive local path ${resolved}.`,
      consequence: `Blocked a write to a credential, persistence, git-internal, or permission configuration path: ${resolved}`,
      defaultDecision: 'deny',
      reversible: false,
      externalEffect: false,
      highConsequence: true,
      classifierAutoAllowEligible: false,
      code: 'sensitive_persistence_write',
      platformHardBlock: true,
      redline: true,
    });
  }

  if (isSensitivePath(resolved)) {
    const action = isWrite ? 'write' : 'read';
    return descriptor(toolName, fileActionKind(toolName, isWrite, 'sensitive_local_path'), {
      accessScope: 'sensitive_local_path',
      title: `sensitive file ${action}`,
      summary: `${action === 'write' ? 'Write' : 'Read'} sensitive local path ${resolved}.`,
      consequence: `This would ${action} a sensitive local path: ${resolved}`,
      defaultDecision: 'ask',
      reversible: !isWrite,
      externalEffect: false,
      highConsequence: true,
      classifierAutoAllowEligible: false,
      code: `sensitive_path_${action}`,
      requestTitle: `Approve sensitive file ${action}?`,
      requestTarget: resolved,
      requestDetails: [
        { label: 'Tool', value: toolName },
        { label: 'Path', value: resolved },
        { label: 'Why asking', value: 'This path may contain credentials or local secrets.' },
      ],
    });
  }

  if (!isInsideWorkspace) {
    return descriptor(toolName, fileActionKind(toolName, isWrite, 'outside_allowed_file_area'), {
      accessScope: 'outside_allowed_file_area',
      title: isWrite ? 'outside-area file write' : 'outside-area file read',
      summary: `${isWrite ? 'Write' : 'Read'} ${resolved} outside the allowed file area.`,
      consequence: `This would ${isWrite ? 'write' : 'read'} outside the allowed file area: ${resolved}`,
      defaultDecision: 'ask',
      reversible: !isWrite,
      externalEffect: false,
      highConsequence: true,
      classifierAutoAllowEligible: false,
      code: `outside_workspace_${isWrite ? 'write' : 'read'}`,
      requestTitle: `Approve outside file ${isWrite ? 'write' : 'read'}?`,
      requestTarget: resolved,
    });
  }

  const skillTarget = isWrite
    ? resolveSkillContentTarget(resolved, {
      root: policy.workspaceRoot,
      includeUserSkills: policy.includeUserSkills,
      additionalSkillDirectories: policy.additionalSkillDirectories,
    })
    : null;
  if (skillTarget) {
    return descriptor(toolName, 'agent.skill.write', {
      accessScope: 'allowed_file_area',
      title: 'skill content write',
      summary: `Write ${skillTarget.relativePath} for skill ${skillTarget.skillName}.`,
      consequence: 'This changes local agent skill instructions and can affect future agent behavior.',
      defaultDecision: 'ask',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
      classifierAutoAllowEligible: false,
      code: 'agent.skill.write',
      requestTitle: 'Approve skill content write?',
      requestTarget: `${skillTarget.skillName}/${skillTarget.relativePath}`,
      requestDetails: [
        { label: 'Tool', value: toolName },
        { label: 'Skill', value: skillTarget.skillName },
        { label: 'Path', value: resolved },
        { label: 'Source', value: skillTarget.source },
      ],
    });
  }

  return descriptor(toolName, baseAction, {
    accessScope: 'allowed_file_area',
    title: isWrite ? 'local file edit' : 'local file read',
    summary: `${isWrite ? 'Edit' : 'Read'} ${resolved}.`,
    consequence: isWrite ? 'This changes local files inside the allowed file area.' : 'This reads local files inside the allowed file area.',
    defaultDecision: 'allow',
    reversible: !isWrite,
    externalEffect: false,
    highConsequence: false,
    classifierAutoAllowEligible: false,
  });
}

function deriveBashActionDescriptors(
  command: string | null,
  args: unknown,
  workspaceRoot: string,
): DerivedToolActionDescriptor[] {
  if (!command) {
    return [unknownShellDescriptor('Missing shell command.')];
  }

  for (const rule of BASH_HARD_DENY_RULES) {
    if (rule.pattern.test(command)) {
      return [descriptor('bash', 'shell.destructive_cleanup', {
        accessScope: 'none',
        title: 'blocked shell command',
        summary: command,
        consequence: rule.reason,
        defaultDecision: 'deny',
        reversible: false,
        externalEffect: false,
        highConsequence: true,
        classifierAutoAllowEligible: false,
        command,
        code: rule.code,
        platformHardBlock: true,
        redline: true,
      })];
    }
  }

  if (looksLikeWorkspaceRootDelete(command, workspaceRoot)) {
    return [descriptor('bash', 'shell.destructive_cleanup', {
      accessScope: 'allowed_file_area',
      title: 'blocked workspace delete',
      summary: command,
      consequence: 'Blocked a command that appears to recursively delete the entire allowed file area.',
      defaultDecision: 'deny',
      reversible: false,
      externalEffect: false,
      highConsequence: true,
      classifierAutoAllowEligible: false,
      command,
      code: 'dangerous_workspace_delete',
      platformHardBlock: true,
      redline: true,
    })];
  }

  const mentionsSensitivePath = commandMentionsSensitivePath(command, workspaceRoot);
  if (mentionsSensitivePath && looksLikeExfiltrationSink(command)) {
    return [descriptor('bash', 'shell.network_write', {
      accessScope: 'sensitive_local_path',
      title: 'blocked sensitive data exfiltration',
      summary: command,
      consequence: 'Blocked a command that appears to send sensitive local data to a network endpoint.',
      defaultDecision: 'deny',
      reversible: false,
      externalEffect: true,
      highConsequence: true,
      classifierAutoAllowEligible: false,
      command,
      code: 'sensitive_data_exfiltration',
      platformHardBlock: true,
      redline: true,
    })];
  }

  if (looksLikeSensitivePersistenceWrite(command, workspaceRoot)) {
    return [descriptor('bash', 'file.write.sensitive_local_path', {
      accessScope: 'sensitive_local_path',
      title: 'blocked sensitive persistence write',
      summary: command,
      consequence: 'Blocked a command that appears to write credentials, shell startup files, git hooks, or permission configuration.',
      defaultDecision: 'deny',
      reversible: false,
      externalEffect: false,
      highConsequence: true,
      classifierAutoAllowEligible: false,
      command,
      code: 'sensitive_persistence_write',
      platformHardBlock: true,
      redline: true,
    })];
  }

  const descriptors: DerivedToolActionDescriptor[] = [];
  if (getBooleanArg(args, 'dangerouslyDisableSandbox')) {
    descriptors.push(descriptor('bash', 'shell.sandbox_override', {
      accessScope: 'none',
      title: 'command execution override',
      summary: command,
      consequence: 'The command requested an execution override.',
      defaultDecision: 'ask',
      reversible: false,
      externalEffect: false,
      highConsequence: true,
      classifierAutoAllowEligible: false,
      command,
      code: 'sandbox_override',
      requestTitle: 'Approve command override?',
      requestTarget: command,
    }));
  }

  if (getBooleanArg(args, 'run_in_background')) {
    descriptors.push(descriptor('bash', 'shell.background_process', {
      accessScope: 'none',
      title: 'background command',
      summary: command,
      consequence: 'This starts a process that can keep running after the current turn.',
      defaultDecision: 'ask',
      reversible: false,
      externalEffect: false,
      highConsequence: true,
      classifierAutoAllowEligible: false,
      command,
      code: 'background_process',
      requestTitle: 'Approve background command?',
      requestTarget: command,
    }));
  }

  if (mentionsSensitivePath) {
    descriptors.push(descriptor('bash', 'file.read.sensitive_local_path', {
      accessScope: 'sensitive_local_path',
      title: 'sensitive file access',
      summary: command,
      consequence: 'This command references a path that may contain credentials or local secrets.',
      defaultDecision: 'ask',
      reversible: true,
      externalEffect: false,
      highConsequence: true,
      classifierAutoAllowEligible: false,
      command,
      code: 'sensitive_path_shell',
      requestTitle: 'Approve sensitive file access?',
      requestTarget: command,
    }));
  }

  const segments = parseShellSegments(command);
  if (!segments) return [unknownShellDescriptor('Unknown or ambiguous shell execution.', command)];
  for (const segment of segments) {
    descriptors.push(classifyShellSegment(segment, command, workspaceRoot));
  }

  return descriptors.length > 0 ? descriptors : [unknownShellDescriptor('Unknown shell execution.', command)];
}

function classifyShellSegment(segmentInput: string, fullCommand: string, workspaceRoot: string): DerivedToolActionDescriptor {
  const segment = stripShellEnvPrefix(segmentInput.trim());
  const words = parseShellWords(segment);
  const head = normalizeToolName(words[0] ?? '');
  const second = (words[1] ?? '').toLowerCase();
  const packageManager = ['npm', 'pnpm', 'yarn', 'bun'].includes(head);

  if (!head) return unknownShellDescriptor('Empty shell segment.', fullCommand);

  if (looksLikeUnscopedRecursiveDelete(segment, workspaceRoot)) {
    return descriptor('bash', 'shell.destructive_cleanup', {
      accessScope: 'allowed_file_area',
      title: 'destructive cleanup',
      summary: fullCommand,
      consequence: 'This recursively deletes files outside an obviously scoped project path.',
      defaultDecision: 'ask',
      reversible: false,
      externalEffect: false,
      highConsequence: true,
      classifierAutoAllowEligible: false,
      command: fullCommand,
      code: 'destructive_cleanup',
      requestTitle: 'Approve destructive cleanup?',
      requestTarget: fullCommand,
    });
  }

  if (head === 'rm') {
    return descriptor('bash', 'file.delete.allowed_file_area', {
      accessScope: 'allowed_file_area',
      title: 'local file delete',
      summary: fullCommand,
      consequence: 'This deletes local files in the allowed file area.',
      defaultDecision: 'ask',
      reversible: false,
      externalEffect: false,
      highConsequence: false,
      classifierAutoAllowEligible: false,
      command: fullCommand,
      code: 'local_file_delete',
      requestTitle: 'Approve local delete?',
      requestTarget: fullCommand,
    });
  }

  if (head === 'find' && hasFindExecFlag(words)) {
    return descriptor('bash', 'shell.local_code_execution', {
      accessScope: 'allowed_file_area',
      title: 'local code execution',
      summary: fullCommand,
      consequence: 'This runs commands selected by find for matching local files.',
      defaultDecision: 'ask',
      reversible: false,
      externalEffect: false,
      highConsequence: true,
      classifierAutoAllowEligible: false,
      command: fullCommand,
      code: 'find_exec',
      requestTitle: 'Approve find execution?',
      requestTarget: fullCommand,
    });
  }

  if (head === 'find' && hasFindDeleteFlag(words)) {
    return descriptor('bash', 'file.delete.allowed_file_area', {
      accessScope: 'allowed_file_area',
      title: 'local file delete',
      summary: fullCommand,
      consequence: 'This deletes local files matched by find.',
      defaultDecision: 'ask',
      reversible: false,
      externalEffect: false,
      highConsequence: false,
      classifierAutoAllowEligible: false,
      command: fullCommand,
      code: 'find_delete',
      requestTitle: 'Approve local delete?',
      requestTarget: fullCommand,
    });
  }

  if (head === 'git' && second === 'push') {
    return descriptor('bash', 'git.publish_remote', {
      accessScope: 'external_system',
      title: 'git push',
      summary: fullCommand,
      consequence: 'This changes external state on a git remote.',
      defaultDecision: 'ask',
      reversible: false,
      externalEffect: true,
      highConsequence: true,
      classifierAutoAllowEligible: false,
      command: fullCommand,
      code: 'external_git_push',
      requestTitle: 'Approve GitHub push?',
      requestTarget: fullCommand,
    });
  }

  if (head === 'gh' && isGhMutation(words)) {
    return descriptor('bash', 'git.publish_remote', {
      accessScope: 'external_system',
      title: 'GitHub CLI mutation',
      summary: fullCommand,
      consequence: 'This changes external state through the GitHub CLI.',
      defaultDecision: 'ask',
      reversible: false,
      externalEffect: true,
      highConsequence: true,
      classifierAutoAllowEligible: false,
      command: fullCommand,
      code: 'external_gh_mutation',
      requestTitle: 'Approve GitHub action?',
      requestTarget: fullCommand,
    });
  }

  if (packageManager && isDependencyInstallCommand(head, words)) {
    return descriptor('bash', 'shell.dependency_install', {
      accessScope: 'allowed_file_area',
      title: 'dependency install',
      summary: fullCommand,
      consequence: 'This can change installed dependencies or lockfiles.',
      defaultDecision: 'ask',
      reversible: false,
      externalEffect: true,
      highConsequence: true,
      classifierAutoAllowEligible: false,
      command: fullCommand,
      code: 'package_install',
      requestTitle: 'Approve package change?',
      requestTarget: fullCommand,
    });
  }

  if ((packageManager && second === 'publish') || isDeployCommand(head, words)) {
    return descriptor('bash', 'deploy.publish_remote', {
      accessScope: 'external_system',
      title: 'deploy or publish',
      summary: fullCommand,
      consequence: 'This can publish artifacts or update a remote environment.',
      defaultDecision: 'ask',
      reversible: false,
      externalEffect: true,
      highConsequence: true,
      classifierAutoAllowEligible: false,
      command: fullCommand,
      code: 'deploy_or_publish',
      requestTitle: 'Approve deploy or publish?',
      requestTarget: fullCommand,
    });
  }

  if (looksLikeNetworkWrite(segment) || isOutwardFacingShellCommand(head, words)) {
    return descriptor('bash', 'shell.network_write', {
      accessScope: 'external_system',
      title: 'network write',
      summary: fullCommand,
      consequence: 'This appears to send data to a network endpoint or mutate an external system.',
      defaultDecision: 'ask',
      reversible: false,
      externalEffect: true,
      highConsequence: true,
      classifierAutoAllowEligible: false,
      command: fullCommand,
      code: 'network_write',
      requestTitle: 'Approve network write?',
      requestTarget: fullCommand,
    });
  }

  if (isDatabaseMigrationCommand(head, words) || isProjectScriptCommand(head, words)) {
    return descriptor('bash', 'shell.project_script', {
      accessScope: 'allowed_file_area',
      title: 'local validation or project script',
      summary: fullCommand,
      consequence: 'This executes project code on the local machine.',
      defaultDecision: 'ask',
      reversible: false,
      externalEffect: false,
      highConsequence: false,
      classifierAutoAllowEligible: false,
      command: fullCommand,
      code: isDatabaseMigrationCommand(head, words) ? 'database_migration' : 'project_script',
      requestTitle: isDatabaseMigrationCommand(head, words) ? 'Approve database change?' : 'Approve local code execution?',
      requestTarget: fullCommand,
    });
  }

  if (ARBITRARY_CODE_SHELL_PREFIXES.includes(head)) {
    return descriptor('bash', 'shell.local_code_execution', {
      accessScope: 'allowed_file_area',
      title: 'local code execution',
      summary: fullCommand,
      consequence: 'This executes arbitrary local code.',
      defaultDecision: 'ask',
      reversible: false,
      externalEffect: false,
      highConsequence: true,
      classifierAutoAllowEligible: false,
      command: fullCommand,
      code: 'local_code_execution',
      requestTitle: 'Approve local code execution?',
      requestTarget: fullCommand,
    });
  }

  if (head === 'sed' && hasInlineEditFlag(words)) {
    return descriptor('bash', 'file.edit.allowed_file_area', {
      accessScope: 'allowed_file_area',
      title: 'local file edit',
      summary: fullCommand,
      consequence: 'This edits local files in place.',
      defaultDecision: 'ask',
      reversible: false,
      externalEffect: false,
      highConsequence: false,
      classifierAutoAllowEligible: false,
      command: fullCommand,
      code: 'local_file_edit',
      requestTitle: 'Approve local file edit?',
      requestTarget: fullCommand,
    });
  }

  if (isReadOnlyShellCommand(head, words)) {
    return descriptor('bash', 'shell.read_search', {
      accessScope: 'allowed_file_area',
      title: 'local read/search command',
      summary: fullCommand,
      consequence: 'This reads or searches local project data.',
      defaultDecision: 'allow',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
      classifierAutoAllowEligible: false,
      command: fullCommand,
    });
  }

  return unknownShellDescriptor(`Unknown shell command: ${head}.`, fullCommand);
}

function askForDescriptor(
  descriptor: DerivedToolActionDescriptor,
  access: AgentPermissionAccess,
  preapproved: boolean,
  permissionSource: 'configured_ask' | 'default' | 'safety_mode_profile' | 'trust_ledger',
  descriptors: readonly DerivedToolActionDescriptor[],
): AgentPermissionAskDecision {
  const reason = descriptor.consequence;
  const target = descriptor.requestTarget ?? descriptor.command ?? descriptor.summary;
  return ask(
    descriptor.code ?? descriptor.actionKind,
    reason,
    access,
    preapproved,
    {
      title: descriptor.requestTitle ?? `Approve ${descriptor.title}?`,
      target,
      alwaysAllowRule: alwaysAllowRuleForDescriptor(descriptor),
      details: descriptor.requestDetails ?? [
        { label: 'Action', value: descriptor.title },
        { label: 'Target', value: target },
        { label: 'Why asking', value: reason },
        { label: 'Permission kind', value: descriptor.actionKind },
      ],
    },
    {
      descriptor,
      descriptors,
      permissionSource,
    },
  );
}

export function approvalNoticeForDeniedDecision(
  toolName: string,
  decision: AgentPermissionDenyDecision,
): AgentApprovalRequest {
  const descriptor = decision.descriptor ?? decision.descriptors?.[0];
  const target = descriptor?.command ?? descriptor?.summary ?? toolName;
  const details: AgentApprovalDetail[] = [
    { label: 'Tool', value: toolName },
    { label: 'Target', value: target },
    { label: 'Why blocked', value: decision.reason },
    { label: 'Permission kind', value: descriptor?.actionKind ?? decision.code },
  ];
  if (descriptor?.command && descriptor.command !== target) {
    details.push({ label: 'Command', value: descriptor.command });
  }
  if (decision.redline || descriptor?.platformHardBlock) {
    details.push({ label: 'Safety floor', value: 'This block cannot be bypassed by trust settings.' });
  }
  return {
    title: `Blocked ${descriptor?.title ?? toolName}`,
    target,
    details,
  };
}

export function toPermissionClassifierInput(toolNameInput: string, args: unknown): AgentPermissionClassifierProjection | null {
  const toolName = normalizeToolName(toolNameInput);
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
  switch (toolName) {
    case 'bash':
      return projectClassifierInput(toolName, input, ['command', 'description', 'run_in_background']);
    case 'file_read':
    case 'file_edit':
    case 'file_write':
      return projectClassifierInput(toolName, input, ['file_path', 'old_string', 'new_string', 'replace_all']);
    case 'file_glob':
      return projectClassifierInput(toolName, input, ['pattern', 'path']);
    case 'file_grep':
      return projectClassifierInput(toolName, input, ['pattern', 'path', 'glob', 'output_mode']);
    case 'web_search':
      return projectClassifierInput(toolName, input, ['query', 'site', 'recency_days']);
    case 'web_fetch':
      return projectClassifierInput(toolName, input, ['url', 'format', 'query']);
    case 'node_read':
    case 'node_search':
    case 'node_create':
    case 'node_edit':
    case 'node_delete':
    case 'operation_history':
    case 'recall':
    case 'ask_user_question':
    case 'runtime_status':
    case 'config':
    case 'doctor':
    case 'dream':
    case 'task_stop':
    case 'agent_status':
    case 'agent_send':
    case 'agent_stop':
    case 'skill':
    case 'agent':
      return projectClassifierInput(toolName, input, Object.keys(input).slice(0, 12));
    default:
      return null;
  }
}

function projectClassifierInput(
  toolName: string,
  input: Record<string, unknown>,
  keys: readonly string[],
): AgentPermissionClassifierProjection {
  const projected: Record<string, unknown> = {};
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string') projected[key] = value.slice(0, 2000);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) projected[key] = value;
    else if (Array.isArray(value)) projected[key] = value.slice(0, 20).map((item) => (
      typeof item === 'string' ? item.slice(0, 500) : item
    ));
  }
  return { tool: toolName, input: projected };
}

function descriptor(
  toolName: string,
  actionKind: AgentToolActionKind,
  values: Omit<DerivedToolActionDescriptor, 'toolName' | 'actionKind'>,
): DerivedToolActionDescriptor {
  return { toolName, actionKind, ...values };
}

function unknownShellDescriptor(reason: string, command = ''): DerivedToolActionDescriptor {
  return descriptor('bash', 'shell.unknown', {
    accessScope: 'none',
    title: 'unknown shell execution',
    summary: command,
    consequence: reason,
    defaultDecision: 'deny',
    reversible: false,
    externalEffect: false,
    highConsequence: true,
    classifierAutoAllowEligible: false,
    command,
    code: 'unknown_shell',
    platformHardBlock: true,
    redline: true,
  });
}

function fileActionKind(
  toolName: string,
  isWrite: boolean,
  scope: 'allowed_file_area' | 'outside_allowed_file_area' | 'sensitive_local_path',
): AgentToolActionKind {
  if (isWrite) return scope === 'allowed_file_area' ? 'file.edit.allowed_file_area' : `file.write.${scope}` as AgentToolActionKind;
  return `file.read.${scope}` as AgentToolActionKind;
}

function parseShellSegments(command: string): string[] | null {
  if (hasDynamicShellConstruction(command)) return null;
  const expanded = expandStaticShellCommand(command);
  if (expanded === null) return null;
  const segments = splitShellByOperators(expanded)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.length > 0 ? segments : null;
}

function hasDynamicShellConstruction(command: string): boolean {
  return /`|\$\(|\beval\b|base64\s+(?:--decode|-d)[\s\S]*\|/i.test(command);
}

function expandStaticShellCommand(command: string): string | null {
  const words = parseShellWords(command);
  const head = normalizeToolName(words[0] ?? '');
  if ((head === 'bash' || head === 'sh' || head === 'zsh') && words[1] === '-c') {
    const inner = words[2];
    return inner && !hasDynamicShellConstruction(inner) ? inner : null;
  }
  return command;
}

function splitShellByOperators(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      if (char === '\\' && quote === '"' && next) {
        index += 1;
        current += next;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ';' || char === '|') {
      segments.push(current);
      current = '';
      if (next === char) index += 1;
      continue;
    }
    if (char === '&' && next === '&') {
      segments.push(current);
      current = '';
      index += 1;
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

function stripShellEnvPrefix(segment: string): string {
  let words = parseShellWords(segment);
  if (words[0] === 'env') {
    words = words.slice(1);
    while (words[0]?.startsWith('-')) words = words.slice(1);
  }
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) {
    words = words.slice(1);
  }
  return words.join(' ');
}

function isReadOnlyShellCommand(head: string, words: readonly string[]): boolean {
  if (['cat', 'date', 'du', 'echo', 'grep', 'head', 'ls', 'pwd', 'rg', 'tail', 'wc'].includes(head)) {
    return true;
  }
  if (head === 'find') {
    return !hasFindExecFlag(words) && !hasFindDeleteFlag(words);
  }
  if (head === 'sed') {
    return !hasInlineEditFlag(words);
  }
  if (head === 'git') {
    const sub = words[1]?.toLowerCase();
    return ['branch', 'diff', 'log', 'show', 'status'].includes(sub ?? '');
  }
  return false;
}

function isDependencyInstallCommand(head: string, words: readonly string[]): boolean {
  const sub = words[1]?.toLowerCase();
  if (head === 'bun') return ['add', 'install', 'remove', 'update', 'upgrade'].includes(sub ?? '');
  if (head === 'npm') return ['install', 'i', 'add', 'remove', 'update', 'upgrade'].includes(sub ?? '');
  if (head === 'pnpm' || head === 'yarn') return ['add', 'install', 'remove', 'update', 'upgrade'].includes(sub ?? '');
  return false;
}

function isProjectScriptCommand(head: string, words: readonly string[]): boolean {
  const sub = words[1]?.toLowerCase();
  if (head === 'bun') return ['test', 'run', 'build'].includes(sub ?? '');
  if (head === 'npm' || head === 'pnpm' || head === 'yarn') return ['test', 'run', 'exec', 'build'].includes(sub ?? '');
  if (['make', 'pytest', 'vitest', 'jest', 'tsx', 'ts-node', 'node-gyp'].includes(head)) return true;
  return false;
}

function isDatabaseMigrationCommand(head: string, words: readonly string[]): boolean {
  const joined = words.join(' ').toLowerCase();
  if (head === 'prisma') return /(?:^|\s)(?:migrate|db\s+push)(?:\s|$)/.test(joined);
  if (head === 'drizzle-kit') return /(?:^|\s)(?:push|migrate)(?:\s|$)/.test(joined);
  if (head === 'rails') return joined.includes('db:migrate');
  if (head === 'alembic') return words[1]?.toLowerCase() === 'upgrade';
  return /(?:migrat|db:push|db\s+push|schema\s+push)/.test(joined);
}

function isGhMutation(words: readonly string[]): boolean {
  const area = words[1]?.toLowerCase();
  const action = words[2]?.toLowerCase();
  if (area === 'api') return true;
  if (area === 'pr') return ['create', 'edit', 'merge', 'close', 'reopen', 'ready', 'review'].includes(action ?? '');
  if (area === 'issue') return ['create', 'edit', 'close', 'reopen', 'transfer'].includes(action ?? '');
  if (area === 'release') return ['create', 'delete', 'edit', 'upload'].includes(action ?? '');
  if (area === 'repo') return ['create', 'delete', 'fork'].includes(action ?? '');
  if (area === 'workflow') return action === 'run';
  return false;
}

function isDeployCommand(head: string, words: readonly string[]): boolean {
  const joined = words.join(' ').toLowerCase();
  if (head === 'vercel') return words.includes('--prod') || words[1]?.toLowerCase() === 'deploy';
  if (head === 'netlify') return words[1]?.toLowerCase() === 'deploy';
  if (head === 'fly') return words[1]?.toLowerCase() === 'deploy';
  if (head === 'wrangler') return ['deploy', 'publish'].includes(words[1]?.toLowerCase() ?? '');
  if (head === 'firebase') return words[1]?.toLowerCase() === 'deploy';
  if (head === 'supabase') return joined.includes('db push');
  if (head === 'railway') return words[1]?.toLowerCase() === 'up';
  if (head === 'docker') return words[1]?.toLowerCase() === 'push';
  return false;
}

function isOutwardFacingShellCommand(head: string, words: readonly string[]): boolean {
  if (!OUTWARD_FACING_SHELL_PREFIXES.includes(head)) return false;
  if (head === 'curl' || head === 'wget') return looksLikeNetworkWrite(words.join(' '));
  if (head === 'git') return words[1]?.toLowerCase() === 'push';
  if (head === 'npm' || head === 'pnpm' || head === 'yarn' || head === 'bun') return words[1]?.toLowerCase() === 'publish';
  return ['aws', 'docker', 'firebase', 'fly', 'gcloud', 'gsutil', 'kubectl', 'netlify', 'rclone', 'rsync', 'scp', 'sftp', 'ssh', 'supabase', 'vercel', 'wrangler'].includes(head);
}

function isHardBlockedSensitiveWritePath(filePath: string): boolean {
  return isSensitivePath(filePath) || isPersistencePath(filePath) || isGitInternalWritePath(filePath) || isAgentPermissionConfigPath(filePath);
}

function isPersistencePath(filePath: string): boolean {
  return /(?:^|\/)(?:\.bashrc|\.bash_profile|\.zshrc|\.zprofile|\.profile|crontab|cron\.d)(?:\/|$)/i.test(filePath)
    || /(?:^|\/)Library\/LaunchAgents(?:\/|$)/i.test(filePath)
    || /(?:^|\/)\.config\/systemd\/user(?:\/|$)/i.test(filePath);
}

function isGitInternalWritePath(filePath: string): boolean {
  return /(?:^|\/)\.git\/(?:hooks|config|refs|objects)(?:\/|$)/i.test(filePath);
}

function isAgentPermissionConfigPath(filePath: string): boolean {
  return /(?:^|\/)(?:agent-tool-permissions|agent-permissions|agent-providers|agent-secrets)\.json$/i.test(filePath);
}

function looksLikeSensitivePersistenceWrite(command: string, workspaceRoot: string): boolean {
  const words = parseShellWords(command);
  if (!hasSensitivePersistenceWriteTrigger(command, words)) return false;
  return words.some((word) => {
    const cleaned = stripShellPathDecoration(word);
    if (!looksLikePath(cleaned)) return false;
    const resolved = resolvePermissionPath(workspaceRoot, cleaned);
    return isHardBlockedSensitiveWritePath(resolved);
  });
}

function hasSensitivePersistenceWriteTrigger(command: string, words: readonly string[]): boolean {
  if (containsShellWriteOperator(command)) return true;
  for (let index = 0; index < words.length; index += 1) {
    const word = normalizeToolName(words[index] ?? '');
    if (SENSITIVE_PERSISTENCE_WRITE_COMMANDS.has(word)) return true;
    if (word === 'find' && (hasFindDeleteFlag(words.slice(index)) || hasFindExecFlag(words.slice(index)))) return true;
    if ((word === 'sed' || word === 'perl' || word === 'ruby') && hasInlineEditFlag(words.slice(index))) return true;
  }
  return false;
}

function containsShellWriteOperator(command: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];
    if (quote) {
      if (char === quote) quote = null;
      if (char === '\\' && quote === '"' && next) index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return true;
  }
  return false;
}

const SENSITIVE_PERSISTENCE_WRITE_COMMANDS = new Set([
  'chmod',
  'chown',
  'chgrp',
  'cp',
  'install',
  'mkdir',
  'mv',
  'rm',
  'rmdir',
  'tee',
  'touch',
  'truncate',
]);

const FIND_EXEC_FLAGS = new Set(['-exec', '-execdir', '-ok', '-okdir']);

function hasFindExecFlag(words: readonly string[]): boolean {
  return words.some((word) => FIND_EXEC_FLAGS.has(word.toLowerCase()));
}

function hasFindDeleteFlag(words: readonly string[]): boolean {
  return words.some((word) => word.toLowerCase() === '-delete');
}

function hasInlineEditFlag(words: readonly string[]): boolean {
  return words.slice(1).some((word) => (
    word === '-i'
    || word.startsWith('-i.')
    || word.startsWith('-i')
    || /^-[A-Za-z]*i(?:[A-Za-z.]*)?$/.test(word)
    || word === '--in-place'
    || word.startsWith('--in-place=')
  ));
}

function looksLikeWorkspaceRootDelete(command: string, workspaceRoot: string): boolean {
  return recursiveRmTargetGroups(command).some((targets) => targets.some((word) => (
    resolvePermissionPath(workspaceRoot, stripShellPathDecoration(word)) === workspaceRoot
  )));
}

function looksLikeUnscopedRecursiveDelete(command: string, workspaceRoot: string): boolean {
  for (const targets of recursiveRmTargetGroups(command)) {
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

function recursiveRmTargetGroups(command: string): string[][] {
  const deletePattern = /(?:^|[;&|]\s*|\s-(?:exec|execdir|ok|okdir)\s+)rm\s+([^;&|]*)/gi;
  const groups: string[][] = [];
  let match: RegExpExecArray | null;
  while ((match = deletePattern.exec(command)) !== null) {
    const part = match[0].replace(/^(?:[;&|]\s*|\s-(?:exec|execdir|ok|okdir)\s+)/i, '');
    if (!/^rm\s+(?:-[^\s]*r[^\s]*f[^\s]*|-[^\s]*f[^\s]*r[^\s]*)/i.test(part)) continue;
    const targets = parseShellWords(part)
      .slice(1)
      .filter((word) => !word.startsWith('-') && word !== '{}');
    groups.push(targets);
  }
  return groups;
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

// Broader sink check used only by the exfiltration redline (gated behind a
// sensitive-path mention): an explicit network write OR an opaque sink (inline
// interpreter / ssh remote exec) that could carry the data out unseen.
function looksLikeExfiltrationSink(command: string): boolean {
  return looksLikeNetworkWrite(command) || EXFIL_OPAQUE_SINK_PATTERNS.some((pattern) => pattern.test(command));
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
  if (toolName === 'task_stop' || toolName === 'agent' || toolName === 'agent_status' || toolName === 'agent_send' || toolName === 'agent_stop' || toolName === 'skill' || toolName === 'ask_user_question' || toolName === 'runtime_status' || toolName === 'config' || toolName === 'doctor' || toolName === 'dream') return 'control';
  if (toolName === 'file_edit' || toolName === 'file_write' || toolName === 'node_create' || toolName === 'node_edit' || toolName === 'node_delete') return 'write';
  if (toolName === 'file_read' || toolName === 'file_glob' || toolName === 'file_grep' || toolName === 'web_fetch' || toolName === 'web_search' || toolName === 'recall' || toolName === 'node_read' || toolName === 'node_search' || toolName === 'operation_history') return 'read';
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
    || value.startsWith('.git/')
    || value.startsWith('.env')
    || value.startsWith('.npmrc')
    || value.startsWith('.pypirc')
    || value.startsWith('.netrc');
}

function allow(
  access: AgentPermissionAccess,
  preapproved: boolean,
  reason?: string,
  options: Pick<AgentPermissionAllowDecision, 'descriptor' | 'descriptors' | 'permissionSource'> = {},
): AgentPermissionAllowDecision {
  return { behavior: 'allow', access, preapproved, reason, ...options };
}

function ask(
  code: string,
  reason: string,
  access: AgentPermissionAccess,
  preapproved: boolean,
  request: AgentApprovalRequest,
  options: Pick<AgentPermissionAskDecision, 'descriptor' | 'descriptors' | 'permissionSource'>,
): AgentPermissionAskDecision {
  return { behavior: 'ask', code, reason, access, preapproved, request, ...options };
}

function deny(
  code: string,
  reason: string,
  access: AgentPermissionAccess,
  preapproved: boolean,
  redline?: true,
  options: Pick<AgentPermissionDenyDecision, 'descriptor' | 'descriptors'> = {},
): AgentPermissionDenyDecision {
  return { behavior: 'deny', code, reason, access, preapproved, redline, ...options };
}
