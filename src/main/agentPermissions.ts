import path from 'node:path';
import { homedir } from 'node:os';
import type { AgentPermissionMode } from '../core/types';
import {
  agentToolActionKindProfile,
  isReadOnlyActionKind,
  decideAgentOperationEffect,
  type AgentPermissionScopeAccess,
} from '../core/agentPermissionModel';
import {
  ARBITRARY_CODE_SHELL_PREFIXES,
  OUTWARD_FACING_SHELL_PREFIXES,
  alwaysAllowRuleForDescriptor,
  compareToolPermissionResolutionPriority,
  matchingGrantForEffect,
  parseGlobalToolPermissionSettings,
  type AgentToolActionKind,
  type GlobalToolPermissionConfig,
  type GlobalToolPermissionDecision,
  type AgentOperationEffect,
  type ToolAccessScope,
  type ToolActionDescriptor,
} from './agentToolPermissionRules';

export type { AgentPermissionMode } from '../core/types';
export type {
  AgentToolActionKind,
  AgentOperationEffect,
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
  workspaceRoot: string;
  // App-owned ephemeral scratch root (materialized attachments / web-fetch / tool-outputs),
  // a sibling of the workdir. The app places agent-readable bytes here, so a *read* of a
  // scratch path counts as inside the allowed file area; writes are still treated as outside.
  scratchRoot?: string;
  denyTools: readonly string[];
  preapprovedToolRules: readonly string[];
  allowOutsideWorkspaceRead: boolean;
  allowOutsideWorkspaceWrite: boolean;
  globalPermissions: GlobalToolPermissionConfig;
}

export interface AgentPermissionPolicyInput {
  mode?: AgentPermissionMode;
  workspaceRoot?: string;
  scratchRoot?: string;
  denyTools?: readonly string[];
  preapprovedToolRules?: readonly string[];
  allowOutsideWorkspaceRead?: boolean;
  allowOutsideWorkspaceWrite?: boolean;
  globalPermissions?: unknown;
}

interface AgentPermissionDecisionBase {
  behavior: AgentPermissionBehavior;
  access: AgentPermissionAccess;
  reason?: string;
  code?: string;
  preapproved: boolean;
  ruleId?: string;
  permissionSource?: 'default' | 'trust_ledger';
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

interface DerivedToolActionDescriptor extends ToolActionDescriptor {
  requestTitle?: string;
  requestTarget?: string;
  requestDetails?: AgentApprovalDetail[];
  redline?: true;
}

type DescriptorValues = Omit<DerivedToolActionDescriptor, 'toolName' | 'actionKind' | 'effect'> & {
  effect?: AgentOperationEffect;
  floor?: AgentOperationEffect['floor'];
  grantAccess?: AgentPermissionScopeAccess;
};

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
  ['delete', 'file_delete'],
  ['file_delete', 'file_delete'],
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
  floor: AgentOperationEffect['floor'];
  pattern: RegExp;
}

const BASH_HARD_DENY_RULES: readonly BashDenyRule[] = [
  {
    code: 'dangerous_root_delete',
    reason: 'Blocked a command that appears to recursively delete the filesystem root, home directory, or entire allowed file area.',
    floor: 'host_destruction',
    pattern: /(?:^|[;&|\n]\s*|\s-(?:exec|execdir|ok|okdir)\s+)rm\s+(?:-[^\s]*r[^\s]*f[^\s]*|-[^\s]*f[^\s]*r[^\s]*)\s+(?:\/(?:\s|$)|\/\*(?:\s|$)|~(?:\/?(?:\s|$))|\$HOME(?:\/?(?:\s|$))|\$\{HOME\}(?:\/?(?:\s|$))|\.(?:\/?\s|$)|\*(?:\s|$))/i,
  },
  {
    code: 'dangerous_disk_format',
    reason: 'Blocked a command that appears to format or erase a disk.',
    floor: 'host_destruction',
    pattern: /\b(?:mkfs(?:\.[a-z0-9_-]+)?|diskutil\s+(?:erase[a-z]*|partition[a-z]*|apfs\s+delete[a-z]*)|newfs(?:_[a-z0-9_-]+)?)\b/i,
  },
  {
    code: 'dangerous_raw_disk_write',
    reason: 'Blocked a command that appears to write directly to a raw disk device.',
    floor: 'host_destruction',
    pattern: /\bdd\s+[^;&|]*\bof=\/dev\/(?:disk|rdisk|sd[a-z]|nvme|xvd)/i,
  },
  {
    code: 'dangerous_power_command',
    reason: 'Blocked a command that appears to shut down or reboot the machine.',
    floor: 'host_destruction',
    pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i,
  },
  {
    code: 'dangerous_permission_root',
    reason: 'Blocked a command that appears to recursively change permissions or ownership at filesystem root.',
    floor: 'host_destruction',
    pattern: /\b(?:chmod|chown)\s+-R\s+[^;&|]*\s+\/(?:\s|$)/i,
  },
  {
    code: 'remote_code_execution',
    reason: 'Blocked a command that downloads remote code and pipes it directly into a shell.',
    floor: 'hidden_exec',
    pattern: /\b(?:curl|wget)\b[\s\S]*\|\s*(?:(?:xargs|env|sudo)\s+)*(?:sh|bash|zsh|fish|python|python3|ruby|perl|node)\b/i,
  },
  {
    code: 'known_shell_obfuscation',
    reason: 'Blocked a command that appears to decode or evaluate hidden shell code.',
    floor: 'hidden_exec',
    pattern: /\b(?:base64\s+(?:--decode|-d)|openssl\s+enc\s+-d)[\s\S]*\|\s*(?:sh|bash|zsh|fish|eval)\b|\beval\s+["'`$]/i,
  },
  {
    code: 'persistence_crontab',
    reason: 'Blocked a command that changes scheduled persistent jobs.',
    floor: 'persistence',
    pattern: /(?:^|[;&|\n]\s*)crontab\b(?!\s+-l(?:\s|$))/i,
  },
  {
    code: 'persistence_login_item',
    reason: 'Blocked a command that changes login, service, or defaults persistence.',
    floor: 'persistence',
    pattern: /\bdefaults\s+write\b|\bsystemctl\b(?=[\s\S]*(?:^|\s)--user(?:\s|$))(?=[\s\S]*\benable\b)|\blaunchctl\s+(?:load|bootstrap|enable)\b/i,
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
    workspaceRoot: path.resolve(input.workspaceRoot ?? process.cwd()),
    // A blank scratch root is "unset", not the cwd (`path.resolve('')` === cwd).
    scratchRoot: input.scratchRoot && input.scratchRoot.trim() ? path.resolve(input.scratchRoot) : undefined,
    denyTools: input.denyTools ?? DEFAULT_DENY_TOOLS,
    preapprovedToolRules: input.preapprovedToolRules ?? [],
    allowOutsideWorkspaceRead: input.allowOutsideWorkspaceRead ?? false,
    allowOutsideWorkspaceWrite: input.allowOutsideWorkspaceWrite ?? false,
    globalPermissions: parseGlobalToolPermissionSettings(input.globalPermissions),
  };
}

export function evaluateAgentToolPermission(input: AgentPermissionEvaluationInput): AgentPermissionDecision {
  const policy = createAgentPermissionPolicy(input.policy);
  const toolName = normalizeToolName(input.toolName);
  const access = classifyToolAccess(toolName, input.args);
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

  if (policy.mode === 'restricted' && !preapproved && !isRestrictedBaseAllowed(toolName, input.args)) {
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

  const effectResolution = resolveEffectDecision(descriptors, policy.globalPermissions);
  if (effectResolution.decision === 'deny') {
    return deny(
      effectResolution.descriptor.code ?? effectResolution.descriptor.effect.floor ?? effectResolution.descriptor.actionKind,
      effectResolution.descriptor.consequence,
      access,
      preapproved,
      effectResolution.descriptor.redline,
      {
        descriptor: effectResolution.descriptor,
        descriptors,
      },
    );
  }
  if (effectResolution.decision === 'ask') {
    return askForDescriptor(
      effectResolution.descriptor,
      access,
      preapproved,
      effectResolution.source,
      descriptors,
    );
  }
  return allow(
    access,
    preapproved,
    effectResolution.source === 'trust_ledger'
      ? `Allowed by permission grant ${effectResolution.grantRuleValue}.`
      : undefined,
    {
      descriptor: effectResolution.descriptor,
      descriptors,
      permissionSource: effectResolution.source,
    },
  );
}

type EffectDecisionSource = 'default' | 'trust_ledger';

interface EffectDecisionResolution {
  decision: GlobalToolPermissionDecision;
  source: EffectDecisionSource;
  descriptor: DerivedToolActionDescriptor;
  grantRuleValue?: string;
}

function resolveEffectDecision(
  descriptors: readonly DerivedToolActionDescriptor[],
  globalPermissions: GlobalToolPermissionConfig,
): EffectDecisionResolution {
  const resolutions = descriptors.map((descriptor): EffectDecisionResolution => {
    const baseDecision = decideAgentOperationEffect(descriptor.effect);
    const grant = baseDecision === 'ask'
      ? matchingGrantForEffect(descriptor.effect, globalPermissions)
      : null;
    const decision = grant ? 'allow' : baseDecision;
    return {
      decision,
      source: grant ? 'trust_ledger' : 'default',
      descriptor,
      grantRuleValue: grant?.ruleValue,
    };
  });
  resolutions.sort((left, right) => (
    compareToolPermissionResolutionPriority(left, right, (resolution) => permissionSourceRank(resolution.source))
  ));
  return resolutions[0] ?? {
    decision: 'deny',
    source: 'default',
    descriptor: hiddenShellDescriptor('No permission descriptor was derived.'),
  };
}

function permissionSourceRank(source: EffectDecisionSource): number {
  return source === 'trust_ledger' ? 1 : 0;
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
    return deriveBashActionDescriptors(getStringArg(input.args, 'command'), input.args, input.policy);
  }

  if (toolName === 'file_convert') {
    return deriveFileConvertActionDescriptors(input.args, input.policy);
  }

  const pathArgName = toolPathArgumentName(toolName);
  if (pathArgName) {
    return [derivePathToolActionDescriptor(toolName, input.args, input.policy, input.access, pathArgName)];
  }

  if (toolName === 'web_search') {
    return [descriptor(toolName, firstActionKindForTool(toolName, input.args, 'web.search'), {
      accessScope: 'external_system',
      title: 'web search',
      summary: 'Search external information.',
      consequence: 'This reads public web search results.',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
    })];
  }

  if (toolName === 'web_fetch') {
    const url = getStringArg(input.args, 'url') ?? 'web page';
    return [descriptor(toolName, firstActionKindForTool(toolName, input.args, 'web.fetch'), {
      accessScope: 'external_system',
      title: 'web fetch',
      summary: `Fetch external content from ${url}.`,
      consequence: 'This contacts an external website and reads its response.',
      reversible: true,
      externalEffect: true,
      highConsequence: false,
    })];
  }

  if (toolName === 'recall') {
    return [descriptor(toolName, firstActionKindForTool(toolName, input.args, 'agent.memory.recall'), {
      accessScope: 'none',
      title: 'agent memory recall',
      summary: "Read the local agent's active distilled memory entries (cued retrieval).",
      consequence: 'This reads local agent memory and optional cited episodic evidence without changing it.',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
    })];
  }

  if (toolName === 'dream') {
    return [descriptor(toolName, firstActionKindForTool(toolName, input.args, 'agent.memory.dream'), {
      accessScope: 'none',
      title: 'agent memory dream',
      summary: 'Request runtime-owned memory consolidation (Dream) for the current agent.',
      consequence: 'This may consolidate recorded episodic evidence into local durable agent memory; the model cannot provide memory facts directly.',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
      requestTitle: 'Approve Memory Dream?',
      requestTarget: 'current agent memory',
    })];
  }

  if (toolName === 'ask_user_question') {
    return [descriptor(toolName, firstActionKindForTool(toolName, input.args, 'agent.user_question.ask'), {
      accessScope: 'none',
      title: 'ask user question',
      summary: 'Pause the run to ask the user for structured input.',
      consequence: 'This waits for explicit user input and does not read or mutate local or external data.',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
    })];
  }

  if (toolName === 'runtime_status') {
    return [descriptor(toolName, firstActionKindForTool(toolName, input.args, 'agent.runtime.status'), {
      accessScope: 'none',
      title: 'runtime status',
      summary: 'Read redacted local agent runtime status.',
      consequence: 'This reads local runtime settings and provider status without secrets.',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
    })];
  }

  if (toolName === 'doctor') {
    return [descriptor(toolName, firstActionKindForTool(toolName, input.args, 'agent.doctor.run'), {
      accessScope: 'none',
      title: 'runtime doctor',
      summary: 'Run read-only local agent diagnostics.',
      consequence: 'This reads local diagnostic state without secrets or mutation.',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
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
      reversible: writes,
      externalEffect: false,
      highConsequence: false,
      requestTitle: writes ? 'Approve agent config change?' : undefined,
      requestTarget: getStringArg(argsRecord, 'setting') ?? 'agent runtime setting',
    })];
  }

  if (toolName === 'node_read' || toolName === 'node_search' || toolName === 'operation_history') {
    const actionKind = firstActionKindForTool(toolName, input.args, 'outline.read');
    const writes = actionKind === 'outline.edit';
    return [descriptor(toolName, actionKind, {
      accessScope: 'allowed_file_area',
      title: writes ? 'local document edit' : 'local document read',
      summary: writes ? 'Undo or redo local outliner operations.' : 'Read local outliner or agent history data.',
      consequence: writes ? 'This changes local documents inside Lin.' : 'This reads local product data without changing it.',
      reversible: !writes,
      externalEffect: false,
      highConsequence: false,
    })];
  }

  if (toolName === 'node_create' || toolName === 'node_edit') {
    return [descriptor(toolName, firstActionKindForTool(toolName, input.args, 'outline.edit'), {
      accessScope: 'allowed_file_area',
      title: 'local document edit',
      summary: 'Edit local outliner content.',
      consequence: 'This changes local documents inside Lin.',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
    })];
  }

  if (toolName === 'node_delete') {
    return [descriptor(toolName, firstActionKindForTool(toolName, input.args, 'outline.delete'), {
      accessScope: 'allowed_file_area',
      title: 'local document delete',
      summary: 'Delete local outliner content.',
      consequence: 'This can remove local document content.',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
      requestTitle: 'Approve local delete?',
    })];
  }

  if (toolName === 'task_stop' || toolName === 'agent_stop') {
    return [descriptor(toolName, firstActionKindForTool(toolName, input.args, toolName === 'agent_stop' ? 'agent.delegate.stop' : 'task.stop'), {
      accessScope: 'none',
      title: toolName === 'agent_stop' ? 'child run stop' : 'background task stop',
      summary: toolName === 'agent_stop' ? 'Stop a background child run.' : 'Stop a background task launched by the agent.',
      consequence: toolName === 'agent_stop'
        ? 'This controls a local background child run; downstream child actions keep their own permission gates.'
        : 'This only controls a local background task.',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
    })];
  }

  if (toolName === 'agent_status') {
    return [descriptor(toolName, firstActionKindForTool(toolName, input.args, 'agent.delegate.status'), {
      accessScope: 'none',
      title: 'child run status',
      summary: 'Read the status of a background child run.',
      consequence: 'This reads local child run state.',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
    })];
  }

  if (toolName === 'agent_send') {
    return [descriptor(toolName, firstActionKindForTool(toolName, input.args, 'agent.delegate.send'), {
      accessScope: 'none',
      title: 'child run message',
      summary: 'Send a follow-up message to an existing child run.',
      consequence: 'This can steer an already-running local child run; downstream child actions keep their own permission gates.',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
    })];
  }

  if (toolName === 'agent') {
    return [descriptor(toolName, firstActionKindForTool(toolName, input.args, 'agent.delegate.spawn'), {
      accessScope: 'none',
      title: 'child run spawn',
      summary: 'Start or message a child run.',
      consequence: 'This creates a local child run; downstream child actions keep their own permission gates.',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
      capabilities: ['agent_spawn'],
    })];
  }

  if (toolName === 'skill') {
    return [descriptor(toolName, firstActionKindForTool(toolName, input.args, 'agent.skill.invoke'), {
      accessScope: 'none',
      title: 'skill invocation',
      summary: 'Invoke an installed agent skill.',
      consequence: 'This runs local skill instructions; downstream tool calls keep their own permission gates.',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
    })];
  }

  return [descriptor(toolName, 'shell.unknown', {
    accessScope: 'none',
    title: 'unknown tool action',
    summary: `Use unknown tool ${toolName}.`,
    consequence: `Tool ${toolName} is outside the supported permission classification surface.`,
    reversible: false,
    externalEffect: false,
    highConsequence: true,
    code: 'unknown_tool_action',
    platformHardBlock: true,
    redline: true,
  })];
}

function deriveFileConvertActionDescriptors(
  args: unknown,
  policy: AgentPermissionPolicy,
): DerivedToolActionDescriptor[] {
  const descriptors: DerivedToolActionDescriptor[] = [];
  descriptors.push(deriveFileConvertPathDescriptor({
    rawPath: getStringArg(args, 'input_path'),
    policy,
    access: 'read',
    role: 'input',
  }));

  const outputPath = getStringArg(args, 'output_path');
  const outputDir = getStringArg(args, 'output_dir');
  if (outputPath) {
    descriptors.push(deriveFileConvertPathDescriptor({
      rawPath: outputPath,
      policy,
      access: 'write',
      role: 'output',
    }));
  } else if (outputDir) {
    descriptors.push(deriveFileConvertPathDescriptor({
      rawPath: outputDir,
      policy,
      access: 'write',
      role: 'output directory',
    }));
  } else {
    descriptors.push(deriveFileConvertPathDescriptor({
      rawPath: null,
      policy,
      access: 'write',
      role: 'output',
    }));
  }
  return descriptors;
}

function deriveFileConvertPathDescriptor(input: {
  rawPath: string | null;
  policy: AgentPermissionPolicy;
  access: 'read' | 'write';
  role: string;
}): DerivedToolActionDescriptor {
  return derivePathDescriptor({
    toolName: 'file_convert',
    rawPath: input.rawPath,
    policy: input.policy,
    access: input.access,
    copy: fileConvertPathDescriptorCopy(input.access, input.role),
  });
}

function derivePathToolActionDescriptor(
  toolName: string,
  args: unknown,
  policy: AgentPermissionPolicy,
  access: AgentPermissionAccess,
  pathArgName: string,
): DerivedToolActionDescriptor {
  const pathAccess = access === 'write' ? 'write' : 'read';
  return derivePathDescriptor({
    toolName,
    rawPath: getStringArg(args, pathArgName),
    policy,
    access: pathAccess,
    copy: defaultPathDescriptorCopy(pathAccess),
  });
}

type PathDescriptorAccess = 'read' | 'write';

interface PathDescriptorCopy {
  localTitle: string;
  missingSummary: string;
  localSummary: (resolved: string) => string;
  localConsequence: string;
  hardBlockTitle: string;
  hardBlockSummary: (resolved: string) => string;
  hardBlockConsequence: (resolved: string) => string;
  sensitiveTitle: string;
  sensitiveSummary: (resolved: string) => string;
  sensitiveConsequence: (resolved: string) => string;
  outsideTitle: string;
  outsideSummary: (resolved: string) => string;
  outsideConsequence: (resolved: string) => string;
}

function derivePathDescriptor(input: {
  toolName: string;
  rawPath: string | null;
  policy: AgentPermissionPolicy;
  access: PathDescriptorAccess;
  copy: PathDescriptorCopy;
}): DerivedToolActionDescriptor {
  const isWrite = input.access === 'write';
  const action = isWrite ? 'write' : 'read';
  const baseAction = fileActionKind(input.toolName, isWrite, 'allowed_file_area');
  if (!input.rawPath) {
    return descriptor(input.toolName, baseAction, {
      accessScope: 'allowed_file_area',
      title: input.copy.localTitle,
      summary: input.copy.missingSummary,
      consequence: input.copy.localConsequence,
      reversible: true,
      externalEffect: false,
      highConsequence: false,
    });
  }

  const resolved = resolvePermissionPath(input.policy.workspaceRoot, input.rawPath);
  // Scratch is app-owned: a read of a path the app placed there (a materialized attachment,
  // a fetched binary, an overflow log) is inside the allowed file area. Writes to scratch stay
  // outside — the agent writes its own outputs to the workdir, never to scratch.
  const isInsideWorkspace = isPathInside(input.policy.workspaceRoot, resolved)
    || (!isWrite && input.policy.scratchRoot != null && isPathInside(input.policy.scratchRoot, resolved));

  if (isWrite && isHardBlockedSensitiveWritePath(resolved)) {
    return descriptor(input.toolName, fileActionKind(input.toolName, true, 'sensitive_local_path'), {
      accessScope: 'sensitive_local_path',
      title: input.copy.hardBlockTitle,
      summary: input.copy.hardBlockSummary(resolved),
      consequence: input.copy.hardBlockConsequence(resolved),
      reversible: false,
      externalEffect: false,
      highConsequence: true,
      code: 'sensitive_persistence_write',
      platformHardBlock: true,
      redline: true,
    });
  }

  if (isSensitivePath(resolved)) {
    return descriptor(input.toolName, fileActionKind(input.toolName, isWrite, 'sensitive_local_path'), {
      accessScope: 'sensitive_local_path',
      title: input.copy.sensitiveTitle,
      summary: input.copy.sensitiveSummary(resolved),
      consequence: input.copy.sensitiveConsequence(resolved),
      reversible: !isWrite,
      externalEffect: false,
      highConsequence: true,
      code: `sensitive_path_${action}`,
      requestTitle: `Approve sensitive file ${action}?`,
      requestTarget: resolved,
      requestDetails: [
        { label: 'Tool', value: input.toolName },
        { label: 'Path', value: resolved },
        { label: 'Why asking', value: 'This path may contain credentials or local secrets.' },
      ],
      grantAccess: input.access,
    });
  }

  if (!isInsideWorkspace) {
    return descriptor(input.toolName, fileActionKind(input.toolName, isWrite, 'outside_allowed_file_area'), {
      accessScope: 'outside_allowed_file_area',
      title: input.copy.outsideTitle,
      summary: input.copy.outsideSummary(resolved),
      consequence: input.copy.outsideConsequence(resolved),
      reversible: false,
      externalEffect: false,
      highConsequence: true,
      code: `outside_workspace_${action}`,
      requestTitle: `Approve outside file ${action}?`,
      requestTarget: resolved,
      grantAccess: input.access,
    });
  }

  return descriptor(input.toolName, baseAction, {
    accessScope: 'allowed_file_area',
    title: input.copy.localTitle,
    summary: input.copy.localSummary(resolved),
    consequence: input.copy.localConsequence,
    reversible: true,
    externalEffect: false,
    highConsequence: false,
  });
}

function defaultPathDescriptorCopy(access: PathDescriptorAccess): PathDescriptorCopy {
  const isWrite = access === 'write';
  const action = isWrite ? 'write' : 'read';
  return {
    localTitle: isWrite ? 'local file edit' : 'local file read',
    missingSummary: `${isWrite ? 'Edit' : 'Read'} a path in the allowed file area.`,
    localSummary: (resolved) => `${isWrite ? 'Edit' : 'Read'} ${resolved}.`,
    localConsequence: isWrite ? 'This changes local files inside the allowed file area.' : 'This reads local files inside the allowed file area.',
    hardBlockTitle: 'sensitive file write',
    hardBlockSummary: (resolved) => `Write sensitive local path ${resolved}.`,
    hardBlockConsequence: (resolved) => `Blocked a write to a credential, persistence, git-internal, or permission configuration path: ${resolved}`,
    sensitiveTitle: `sensitive file ${action}`,
    sensitiveSummary: (resolved) => `${isWrite ? 'Write' : 'Read'} sensitive local path ${resolved}.`,
    sensitiveConsequence: (resolved) => `This would ${action} a sensitive local path: ${resolved}`,
    outsideTitle: isWrite ? 'outside-area file write' : 'outside-area file read',
    outsideSummary: (resolved) => `${isWrite ? 'Write' : 'Read'} ${resolved} outside the allowed file area.`,
    outsideConsequence: (resolved) => `This would ${action} outside the allowed file area: ${resolved}`,
  };
}

function fileConvertPathDescriptorCopy(access: PathDescriptorAccess, role: string): PathDescriptorCopy {
  const isWrite = access === 'write';
  const action = isWrite ? 'write' : 'read';
  const pathAction = isWrite ? 'Write converted output to' : 'Read conversion input from';
  return {
    localTitle: `local file conversion ${role}`,
    missingSummary: `${isWrite ? 'Write' : 'Read'} conversion ${role} in the allowed file area.`,
    localSummary: (resolved) => `${pathAction} ${resolved}.`,
    localConsequence: isWrite ? 'This creates converted output inside the allowed file area.' : 'This reads a local source file for conversion.',
    hardBlockTitle: 'sensitive conversion output',
    hardBlockSummary: (resolved) => `Write converted output to sensitive local path ${resolved}.`,
    hardBlockConsequence: (resolved) => `Blocked converted output to a credential, persistence, git-internal, or permission configuration path: ${resolved}`,
    sensitiveTitle: `sensitive conversion ${role}`,
    sensitiveSummary: (resolved) => `${pathAction} sensitive local path ${resolved}.`,
    sensitiveConsequence: (resolved) => `This would ${action} a sensitive local path: ${resolved}`,
    outsideTitle: `outside-area conversion ${role}`,
    outsideSummary: (resolved) => `${pathAction} ${resolved} outside the allowed file area.`,
    outsideConsequence: (resolved) => `This would ${action} outside the allowed file area: ${resolved}`,
  };
}

function deriveBashActionDescriptors(
  command: string | null,
  args: unknown,
  policy: AgentPermissionPolicy,
): DerivedToolActionDescriptor[] {
  if (!command) {
    return [hiddenShellDescriptor('Missing shell command.')];
  }
  const { workspaceRoot } = policy;
  const floorCommands = shellFloorScanCommands(command);

  for (const floorCommand of floorCommands) {
    for (const rule of BASH_HARD_DENY_RULES) {
      if (rule.pattern.test(floorCommand)) {
        return [descriptor('bash', 'shell.destructive_cleanup', {
          accessScope: 'none',
          title: 'blocked shell command',
          summary: command,
          consequence: rule.reason,
          reversible: false,
          externalEffect: false,
          highConsequence: true,
          command,
          code: rule.code,
          floor: rule.floor,
          platformHardBlock: true,
          redline: true,
        })];
      }
    }

    if (looksLikeHostRootOrHomeDelete(floorCommand, workspaceRoot)) {
      return [descriptor('bash', 'shell.destructive_cleanup', {
        accessScope: 'none',
        title: 'blocked host delete',
        summary: command,
        consequence: 'Blocked a command that appears to recursively delete the filesystem root or home directory.',
        reversible: false,
        externalEffect: false,
        highConsequence: true,
        command,
        code: 'dangerous_root_delete',
        floor: 'host_destruction',
        platformHardBlock: true,
        redline: true,
      })];
    }

    if (looksLikeWorkspaceRootDelete(floorCommand, workspaceRoot)) {
      return [descriptor('bash', 'shell.destructive_cleanup', {
        accessScope: 'allowed_file_area',
        title: 'blocked workspace delete',
        summary: command,
        consequence: 'Blocked a command that appears to recursively delete the entire allowed file area.',
        reversible: false,
        externalEffect: false,
        highConsequence: true,
        command,
        code: 'dangerous_workspace_delete',
        floor: 'host_destruction',
        platformHardBlock: true,
        redline: true,
      })];
    }
  }

  const mentionsSensitivePath = floorCommands.some((floorCommand) => commandMentionsSensitivePath(floorCommand, workspaceRoot));
  if (floorCommands.some((floorCommand) => commandMentionsSensitivePath(floorCommand, workspaceRoot) && looksLikeExfiltrationSink(floorCommand))) {
    return [descriptor('bash', 'shell.network_write', {
      accessScope: 'sensitive_local_path',
      title: 'blocked sensitive data exfiltration',
      summary: command,
      consequence: 'Blocked a command that appears to send sensitive local data to a network endpoint.',
      reversible: false,
      externalEffect: true,
      highConsequence: true,
      command,
      code: 'sensitive_data_exfiltration',
      floor: 'exfiltration',
      platformHardBlock: true,
      redline: true,
    })];
  }

  if (floorCommands.some((floorCommand) => looksLikeSensitivePersistenceWrite(floorCommand, workspaceRoot))) {
    return [descriptor('bash', 'file.write.sensitive_local_path', {
      accessScope: 'sensitive_local_path',
      title: 'blocked sensitive persistence write',
      summary: command,
      consequence: 'Blocked a command that appears to write credentials, shell startup files, git hooks, or permission configuration.',
      reversible: false,
      externalEffect: false,
      highConsequence: true,
      command,
      code: 'sensitive_persistence_write',
      floor: 'persistence',
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
      reversible: false,
      externalEffect: false,
      highConsequence: true,
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
      reversible: false,
      externalEffect: false,
      highConsequence: true,
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
      reversible: true,
      externalEffect: false,
      highConsequence: true,
      command,
      code: 'sensitive_path_shell',
      requestTitle: 'Approve sensitive file access?',
      requestTarget: command,
    }));
  }

  descriptors.push(...deriveBashScopeDescriptors(command, workspaceRoot));

  const segments = parseShellSegments(command);
  if (!segments) return [hiddenShellDescriptor('Dynamic or ambiguous shell execution.', command)];
  for (const segment of segments) {
    descriptors.push(classifyShellSegment(segment, command, workspaceRoot));
  }

  return descriptors.length > 0 ? descriptors : [hiddenShellDescriptor('Unknown shell execution.', command)];
}

function classifyShellSegment(segmentInput: string, fullCommand: string, workspaceRoot: string): DerivedToolActionDescriptor {
  const segment = stripShellEnvPrefix(segmentInput.trim());
  const words = parseShellWords(segment);
  const head = normalizeToolName(words[0] ?? '');
  const second = (words[1] ?? '').toLowerCase();
  const packageManager = ['npm', 'pnpm', 'yarn', 'bun'].includes(head);

  if (!head) return hiddenShellDescriptor('Empty shell segment.', fullCommand);

  if (looksLikeUnscopedRecursiveDelete(segment, workspaceRoot)) {
    return descriptor('bash', 'shell.destructive_cleanup', {
      accessScope: 'allowed_file_area',
      title: 'destructive cleanup',
      summary: fullCommand,
      consequence: 'This recursively deletes files outside an obviously scoped project path.',
      reversible: false,
      externalEffect: false,
      highConsequence: true,
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
      reversible: false,
      externalEffect: false,
      highConsequence: false,
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
      reversible: false,
      externalEffect: false,
      highConsequence: true,
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
      reversible: false,
      externalEffect: false,
      highConsequence: false,
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
      reversible: false,
      externalEffect: true,
      highConsequence: true,
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
      reversible: false,
      externalEffect: true,
      highConsequence: true,
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
      reversible: false,
      externalEffect: true,
      highConsequence: true,
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
      reversible: false,
      externalEffect: true,
      highConsequence: true,
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
      reversible: false,
      externalEffect: true,
      highConsequence: true,
      command: fullCommand,
      code: 'network_write',
      requestTitle: 'Approve network write?',
      requestTarget: fullCommand,
    });
  }

  if (isDatabaseMigrationCommand(head, words)) {
    return descriptor('bash', 'shell.project_script', {
      accessScope: 'allowed_file_area',
      title: 'database migration',
      summary: fullCommand,
      consequence: 'This can mutate a local or remote database.',
      reversible: false,
      externalEffect: false,
      highConsequence: true,
      command: fullCommand,
      code: 'database_migration',
      requestTitle: 'Approve database change?',
      requestTarget: fullCommand,
    });
  }

  if (isProjectScriptCommand(head, words)) {
    return descriptor('bash', 'shell.project_script', {
      accessScope: 'allowed_file_area',
      title: 'local validation or project script',
      summary: fullCommand,
      consequence: 'This runs local build, test, validation, or project tooling.',
      reversible: true,
      externalEffect: false,
      highConsequence: false,
      command: fullCommand,
      code: 'project_script',
      requestTarget: fullCommand,
    });
  }

  if (ARBITRARY_CODE_SHELL_PREFIXES.includes(head)) {
    return descriptor('bash', 'shell.local_code_execution', {
      accessScope: 'allowed_file_area',
      title: 'local code execution',
      summary: fullCommand,
      consequence: 'This executes arbitrary local code.',
      reversible: false,
      externalEffect: false,
      highConsequence: true,
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
      reversible: false,
      externalEffect: false,
      highConsequence: false,
      command: fullCommand,
      code: 'local_file_edit',
      requestTitle: 'Approve local file edit?',
      requestTarget: fullCommand,
    });
  }

  return staticShellDescriptor(fullCommand, head);
}

function deriveBashScopeDescriptors(command: string, workspaceRoot: string): DerivedToolActionDescriptor[] {
  const seen = new Set<string>();
  const descriptors: DerivedToolActionDescriptor[] = [];
  for (const word of parseShellWords(command)) {
    const cleaned = stripShellPathDecoration(word);
    if (!looksLikeShellPathToken(cleaned)) continue;
    const resolved = resolvePermissionPath(workspaceRoot, cleaned);
    if (isPathInside(workspaceRoot, resolved)) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    descriptors.push(descriptor('bash', 'file.read.outside_allowed_file_area', {
      accessScope: 'outside_allowed_file_area',
      title: 'outside-scope shell path',
      summary: command,
      consequence: `This command reaches outside the handed file scope: ${resolved}`,
      reversible: false,
      externalEffect: false,
      highConsequence: true,
      command,
      code: 'outside_scope_shell_path',
      requestTitle: 'Approve outside-scope shell access?',
      requestTarget: resolved,
    }));
  }
  return descriptors;
}

function askForDescriptor(
  descriptor: DerivedToolActionDescriptor,
  access: AgentPermissionAccess,
  preapproved: boolean,
  permissionSource: 'default' | 'trust_ledger',
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

function descriptor(
  toolName: string,
  actionKind: AgentToolActionKind,
  values: DescriptorValues,
): DerivedToolActionDescriptor {
  const {
    effect,
    floor,
    grantAccess,
    ...descriptorValues
  } = values;
  const effectValues = floor === undefined
    ? { ...descriptorValues, grantAccess }
    : { ...descriptorValues, grantAccess, floor };
  return {
    toolName,
    actionKind,
    effect: effect ?? inferEffect(actionKind, effectValues),
    ...descriptorValues,
  };
}

function hiddenShellDescriptor(reason: string, command = ''): DerivedToolActionDescriptor {
  return descriptor('bash', 'shell.unknown', {
    accessScope: 'none',
    title: 'unknown shell execution',
    summary: command,
    consequence: reason,
    reversible: false,
    externalEffect: false,
    highConsequence: true,
    command,
    code: 'hidden_exec',
    platformHardBlock: true,
    redline: true,
    effect: {
      reach: 'local',
      reversible: false,
      touchesCredentials: false,
      floor: 'hidden_exec',
      label: command || 'hidden shell execution',
    },
  });
}

function staticShellDescriptor(command: string, head: string): DerivedToolActionDescriptor {
  return descriptor('bash', 'shell.unknown', {
    accessScope: 'allowed_file_area',
    title: 'local shell command',
    summary: command,
    consequence: `This runs a static local command: ${head}.`,
    reversible: true,
    externalEffect: false,
    highConsequence: false,
    command,
    code: 'local_static_command',
    effect: {
      reach: 'local',
      reversible: true,
      touchesCredentials: false,
      label: `run ${head}`,
      grant: { kind: 'command', form: command },
    },
  });
}

function inferEffect(
  actionKind: AgentToolActionKind,
  values: Omit<DescriptorValues, 'effect'>,
): AgentOperationEffect {
  const floor = floorForDescriptor(actionKind, values);
  const touchesCredentials = values.accessScope === 'sensitive_local_path';
  const grant = grantForDescriptor(actionKind, values);
  return {
    reach: reachForDescriptor(actionKind, values),
    reversible: values.reversible,
    touchesCredentials,
    ...(floor ? { floor } : {}),
    label: values.title,
    ...(grant ? { grant } : {}),
  };
}

function floorForDescriptor(
  actionKind: AgentToolActionKind,
  values: Omit<DescriptorValues, 'effect'>,
): AgentOperationEffect['floor'] {
  if (values.floor) return values.floor;
  if (actionKind === 'agent.permission.modify') return 'permission_self_mod';
  if (actionKind === 'payment.purchase') return 'payment';
  if (!values.platformHardBlock) return undefined;
  const code = values.code ?? '';
  if (code.includes('exfiltration')) return 'exfiltration';
  if (code.includes('persistence') || code.includes('sensitive_persistence')) return 'persistence';
  if (code.includes('hidden') || code.includes('remote_code') || code.includes('obfuscation')) return 'hidden_exec';
  return 'host_destruction';
}

function reachForDescriptor(
  actionKind: AgentToolActionKind,
  values: Omit<DescriptorValues, 'effect'>,
): AgentOperationEffect['reach'] {
  if (values.accessScope === 'outside_allowed_file_area') return 'outside_scope';
  if (actionKind === 'web.search' || actionKind === 'web.fetch') return 'network_read';
  if (actionKind === 'shell.network_write' || actionKind === 'git.publish_remote' || actionKind === 'deploy.publish_remote') return 'network_write';
  if (values.accessScope === 'external_system') return values.externalEffect ? 'external_system' : 'network_read';
  return 'local';
}

function grantForDescriptor(
  actionKind: AgentToolActionKind,
  values: Omit<DescriptorValues, 'effect'>,
): AgentOperationEffect['grant'] {
  const target = values.requestTarget ?? values.command ?? values.summary;
  if (values.accessScope === 'outside_allowed_file_area') {
    return {
      kind: 'scope',
      access: values.grantAccess ?? (actionKind === 'file.read.outside_allowed_file_area' ? 'read' : 'write'),
      root: target,
    };
  }
  if (actionKind === 'shell.network_write' || actionKind === 'git.publish_remote' || actionKind === 'deploy.publish_remote') {
    return { kind: 'external', target };
  }
  if (
    actionKind === 'shell.sandbox_override'
    || actionKind === 'shell.background_process'
    || actionKind === 'shell.local_code_execution'
    || actionKind === 'shell.project_script'
    || actionKind === 'shell.dependency_install'
    || actionKind === 'file.delete.allowed_file_area'
    || actionKind === 'file.edit.allowed_file_area'
  ) {
    return { kind: 'command', form: target };
  }
  if (values.accessScope === 'sensitive_local_path') {
    return {
      kind: 'scope',
      access: values.grantAccess ?? (actionKind === 'file.read.sensitive_local_path' ? 'read' : 'write'),
      root: target,
    };
  }
  return undefined;
}

function fileActionKind(
  toolName: string,
  isWrite: boolean,
  scope: 'allowed_file_area' | 'outside_allowed_file_area' | 'sensitive_local_path',
): AgentToolActionKind {
  if (toolName === 'file_convert') {
    return `file.convert.${scope}` as AgentToolActionKind;
  }
  if (isWrite) {
    if (scope === 'allowed_file_area') {
      if (toolName === 'file_delete') return 'file.delete.allowed_file_area';
      return toolName === 'file_write' ? 'file.write.allowed_file_area' : 'file.edit.allowed_file_area';
    }
    return `file.write.${scope}` as AgentToolActionKind;
  }
  return `file.read.${scope}` as AgentToolActionKind;
}

function firstActionKindForTool(
  toolName: string,
  args: unknown,
  fallback: AgentToolActionKind,
): AgentToolActionKind {
  return agentToolActionKindProfile(toolName, args)?.[0] ?? fallback;
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

function shellFloorScanCommands(command: string): string[] {
  const expanded = expandStaticShellCommand(command);
  return expanded && expanded !== command ? [command, expanded] : [command];
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
    if (char === '\n' || char === ';' || char === '|') {
      segments.push(current);
      current = '';
      if (next === char) index += 1;
      continue;
    }
    if (char === '&' && command[index - 1] !== '>' && next !== '>') {
      segments.push(current);
      current = '';
      if (next === '&') index += 1;
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
  const sub = words[1]?.toLowerCase();
  if (head === 'vercel') return words.includes('--prod') || words[1]?.toLowerCase() === 'deploy';
  if (head === 'netlify') return words[1]?.toLowerCase() === 'deploy';
  if (head === 'fly') return words[1]?.toLowerCase() === 'deploy';
  if (head === 'wrangler') return ['deploy', 'publish'].includes(words[1]?.toLowerCase() ?? '');
  if (head === 'firebase') return words[1]?.toLowerCase() === 'deploy';
  if (head === 'supabase') return joined.includes('db push');
  if (head === 'railway') return words[1]?.toLowerCase() === 'up';
  if (head === 'docker') return words[1]?.toLowerCase() === 'push';
  if (head === 'terraform') return ['apply', 'destroy'].includes(sub ?? '');
  if (head === 'pulumi') return ['up', 'destroy'].includes(sub ?? '');
  if (head === 'render') return sub === 'deploy';
  return false;
}

function isOutwardFacingShellCommand(head: string, words: readonly string[]): boolean {
  if (!OUTWARD_FACING_SHELL_PREFIXES.includes(head)) return false;
  if (head === 'curl' || head === 'wget') return true;
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

function looksLikeHostRootOrHomeDelete(command: string, workspaceRoot: string): boolean {
  const home = homedir();
  return recursiveRmTargetGroups(command).some((targets) => targets.some((word) => {
    const resolved = resolvePermissionPath(workspaceRoot, stripShellPathDecoration(word));
    return resolved === path.parse(resolved).root || resolved === home;
  }));
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
  const deletePattern = /(?:^|[;&|\n]\s*|\s-(?:exec|execdir|ok|okdir)\s+)rm\s+([^;&|\n]*)/gi;
  const groups: string[][] = [];
  let match: RegExpExecArray | null;
  while ((match = deletePattern.exec(command)) !== null) {
    const part = match[0].replace(/^(?:[;&|\n]\s*|\s-(?:exec|execdir|ok|okdir)\s+)/i, '');
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
  if (toolName === 'file_read' || toolName === 'file_edit' || toolName === 'file_write' || toolName === 'file_delete') return 'file_path';
  if (toolName === 'file_glob' || toolName === 'file_grep') return 'path';
  return null;
}

function classifyToolAccess(toolName: string, args?: unknown): AgentPermissionAccess {
  if (toolName === 'bash') return 'execute';
  if (toolName === 'task_stop' || toolName === 'agent' || toolName === 'agent_status' || toolName === 'agent_send' || toolName === 'agent_stop' || toolName === 'skill' || toolName === 'ask_user_question' || toolName === 'runtime_status' || toolName === 'config' || toolName === 'doctor' || toolName === 'dream') return 'control';
  if (toolName === 'file_edit' || toolName === 'file_write' || toolName === 'file_delete' || toolName === 'file_convert' || toolName === 'node_create' || toolName === 'node_edit' || toolName === 'node_delete') return 'write';
  if (toolName === 'operation_history') {
    return agentToolActionKindProfile(toolName, args)?.some((actionKind) => !isReadOnlyActionKind(actionKind)) ? 'write' : 'read';
  }
  if (toolName === 'file_read' || toolName === 'file_glob' || toolName === 'file_grep' || toolName === 'web_fetch' || toolName === 'web_search' || toolName === 'recall' || toolName === 'node_read' || toolName === 'node_search') return 'read';
  return 'unknown';
}

function isRestrictedBaseAllowed(toolName: string, args: unknown): boolean {
  if (toolName === 'operation_history') {
    return agentToolActionKindProfile(toolName, args)?.every(isReadOnlyActionKind) === true;
  }
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
  if (inputPath === '$HOME' || inputPath === '${HOME}') return homedir();
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
    .replace(/^[^=\s]+=@(?=~|\/|\$HOME|\$\{HOME\})/, '')
    .replace(/^[@<>=:]+/, '')
    .replace(/[),]+$/, '');
}

function looksLikePath(value: string): boolean {
  return value === '~'
    || value === '$HOME'
    || value === '${HOME}'
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

function looksLikeShellPathToken(value: string): boolean {
  if (!value || value.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  return looksLikePath(value);
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
