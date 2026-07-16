import path from 'node:path';
import { homedir } from 'node:os';
import type { AgentPermissionMode } from '../core/types';
import {
  agentToolActionKindProfile,
  isReadOnlyActionKind,
  type AgentPermissionFloorKind,
} from '../core/agentPermissionModel';
import {
  capabilityFolderForTarget,
  canonicalPathPreservingSuffix,
  createFolderCapabilitySnapshot,
  isPathInside,
  missingFolderCapabilities,
  normalizeRequiredFolders,
  protectedRootForPath,
} from './agentFolderCapabilities';
import {
  matchingBlockForDescriptor,
  parseGlobalToolPermissionSettings,
  type AgentToolActionKind,
  type GlobalToolPermissionConfig,
  type ToolAccessScope,
  type ToolActionDescriptor,
} from './agentToolPermissionRules';
import { selfDefinitionRootEntries } from './agentAuthoring';
import { isAgentProtectedStorePath } from './agentProtectedPaths';

export type { AgentPermissionMode } from '../core/types';
export type {
  AgentPermissionFloorKind,
  AgentToolActionKind,
  GlobalToolPermissionConfig,
  ToolAccessScope,
  ToolActionDescriptor,
} from './agentToolPermissionRules';

export type AgentPermissionAccess = 'read' | 'write' | 'execute' | 'control' | 'unknown';
export type AgentPermissionBehavior = 'allow' | 'folder_required' | 'blocked';
export type AgentPermissionSource = 'default' | 'folder_capability' | 'user_blocklist';

export interface AgentApprovalDetail {
  label: string;
  value: string;
}

export interface AgentFolderCapabilityRequest {
  title: string;
  target: string;
  details: AgentApprovalDetail[];
  folders: string[];
}

export interface AgentPermissionPolicy {
  mode: AgentPermissionMode;
  workspaceRoot: string;
  scratchRoot?: string;
  protectedStoreRoot?: string;
  trustedReadRoots: readonly string[];
  denyTools: readonly string[];
  preapprovedToolRules: readonly string[];
  globalPermissions: GlobalToolPermissionConfig;
}

export interface AgentPermissionPolicyInput {
  mode?: AgentPermissionMode;
  workspaceRoot?: string;
  scratchRoot?: string;
  protectedStoreRoot?: string;
  trustedReadRoots?: readonly string[];
  denyTools?: readonly string[];
  preapprovedToolRules?: readonly string[];
  globalPermissions?: unknown;
}

interface AgentPermissionDecisionBase {
  behavior: AgentPermissionBehavior;
  access: AgentPermissionAccess;
  reason?: string;
  code?: string;
  preapproved: boolean;
  permissionSource: AgentPermissionSource;
  descriptor?: ToolActionDescriptor;
  descriptors: readonly ToolActionDescriptor[];
}

export interface AgentPermissionAllowDecision extends AgentPermissionDecisionBase {
  behavior: 'allow';
}

export interface AgentPermissionFolderRequiredDecision extends AgentPermissionDecisionBase {
  behavior: 'folder_required';
  code: 'folder_access_required';
  reason: string;
  request: AgentFolderCapabilityRequest;
}

export interface AgentPermissionBlockedDecision extends AgentPermissionDecisionBase {
  behavior: 'blocked';
  code: string;
  reason: string;
  redline?: true;
}

export type AgentPermissionDecision =
  | AgentPermissionAllowDecision
  | AgentPermissionFolderRequiredDecision
  | AgentPermissionBlockedDecision;

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
  'ask_user_question',
  'skill',
  'bash_stop',
  'node_read',
  'node_search',
]);

const TOOL_ALIASES = new Map<string, string>([
  ['shell', 'bash'],
  ['read', 'file_read'],
  ['glob', 'file_glob'],
  ['grep', 'file_grep'],
  ['edit', 'file_edit'],
  ['write', 'file_write'],
  ['delete', 'file_delete'],
  ['webfetch', 'web_fetch'],
  ['websearch', 'web_search'],
  ['generateimage', 'generate_image'],
  ['pastchats', 'past_chats'],
  ['askuserquestion', 'ask_user_question'],
]);

interface BashHardDenyRule {
  code: string;
  reason: string;
  floor: AgentPermissionFloorKind;
  matches: (command: string) => boolean;
}

const BASH_HARD_DENY_RULES: readonly BashHardDenyRule[] = [
  {
    code: 'dangerous_root_delete',
    reason: 'Blocked a command that appears to recursively delete the filesystem root or home directory.',
    floor: 'host_destruction',
    matches: (command) => shellInvocations(command).some(isDangerousRecursiveDelete),
  },
  {
    code: 'dangerous_disk_format',
    reason: 'Blocked a command that appears to format or erase a disk.',
    floor: 'host_destruction',
    matches: (command) => shellInvocations(command).some(isDangerousDiskFormat),
  },
  {
    code: 'dangerous_raw_disk_write',
    reason: 'Blocked a command that appears to write directly to a raw disk device.',
    floor: 'host_destruction',
    matches: (command) => shellInvocations(command).some(isDangerousRawDiskWrite),
  },
  {
    code: 'dangerous_power_command',
    reason: 'Blocked a command that appears to shut down or reboot the machine.',
    floor: 'host_destruction',
    matches: (command) => shellInvocations(command).some((invocation) => (
      ['shutdown', 'reboot', 'halt', 'poweroff'].includes(invocation.executable)
    )),
  },
  {
    code: 'dangerous_permission_root',
    reason: 'Blocked a command that appears to recursively change permissions or ownership at filesystem root.',
    floor: 'host_destruction',
    matches: (command) => shellInvocations(command).some(isDangerousRootPermissionChange),
  },
];

export function createAgentPermissionPolicy(input: AgentPermissionPolicyInput = {}): AgentPermissionPolicy {
  const workspaceRoot = canonicalPathPreservingSuffix(input.workspaceRoot ?? process.cwd());
  return {
    mode: input.mode ?? 'trusted',
    workspaceRoot,
    scratchRoot: input.scratchRoot?.trim()
      ? canonicalPathPreservingSuffix(input.scratchRoot)
      : undefined,
    protectedStoreRoot: input.protectedStoreRoot?.trim()
      ? canonicalPathPreservingSuffix(input.protectedStoreRoot)
      : undefined,
    trustedReadRoots: normalizeRoots(input.trustedReadRoots),
    denyTools: input.denyTools ?? DEFAULT_DENY_TOOLS,
    preapprovedToolRules: input.preapprovedToolRules ?? [],
    globalPermissions: parseGlobalToolPermissionSettings(input.globalPermissions),
  };
}

export function evaluateAgentToolPermission(input: AgentPermissionEvaluationInput): AgentPermissionDecision {
  const policy = createAgentPermissionPolicy(input.policy);
  const toolName = normalizeToolName(input.toolName);
  const access = classifyToolAccess(toolName, input.args);
  const preapproved = policy.preapprovedToolRules.some((rule) => matchesAgentToolRule(rule, toolName, input.args));
  const descriptors = deriveAgentToolActionDescriptors({ toolName, args: input.args, policy, access });

  if (policy.denyTools.some((rule) => matchesToolNameRule(rule, toolName))) {
    return block('configured_deny', `Tool ${input.toolName} is blocked for this Run.`, access, preapproved, descriptors);
  }

  const hardBlock = descriptors.find((descriptor) => descriptor.platformHardBlock || descriptor.floor);
  if (hardBlock) {
    return block(
      hardBlock.code ?? hardBlock.floor ?? 'platform_hard_block',
      hardBlock.consequence,
      access,
      preapproved,
      descriptors,
      hardBlock,
      true,
    );
  }

  if (policy.mode === 'restricted' && !preapproved && !isRestrictedBaseAllowed(toolName, input.args)) {
    return block('tool_not_preapproved', `Tool ${input.toolName} is not available for this Run.`, access, preapproved, descriptors);
  }

  const userBlock = descriptors
    .map((descriptor) => ({ descriptor, rule: matchingBlockForDescriptor(descriptor, policy.globalPermissions) }))
    .find((entry) => entry.rule);
  if (userBlock?.rule) {
    return block(
      'configured_deny',
      `Blocked by user rule ${userBlock.rule.ruleValue}.`,
      access,
      preapproved,
      descriptors,
      userBlock.descriptor,
      undefined,
      'user_blocklist',
    );
  }

  const snapshot = createFolderCapabilitySnapshot({
    workspaceRoot: policy.workspaceRoot,
    scratchRoot: policy.scratchRoot,
    activeSkillReadRoots: policy.trustedReadRoots,
    protectedRoots: policy.protectedStoreRoot ? [policy.protectedStoreRoot] : [],
  }, policy.globalPermissions.folders);
  const requiredFolders = requiredFoldersForTool(toolName, input.args, policy.workspaceRoot, snapshot, access);
  const missingFolders = missingFolderCapabilities(requiredFolders, { readRoots: snapshot.writeRoots });
  if (missingFolders.length > 0) {
    const target = missingFolders.join(', ');
    return {
      behavior: 'folder_required',
      access,
      code: 'folder_access_required',
      preapproved,
      permissionSource: 'default',
      reason: `Folder access is required before ${input.toolName} can run: ${target}`,
      request: {
        title: missingFolders.length === 1 ? 'Folder access required' : 'Folder access required',
        target,
        folders: missingFolders,
        details: missingFolders.map((folder) => ({ label: 'Folder', value: folder })),
      },
      descriptor: descriptors[0],
      descriptors,
    };
  }

  const usesRememberedFolder = descriptors.some((descriptorValue) => (
    descriptorValue.targetPath
    && policy.globalPermissions.folders.some((folder) => isPathInside(folder, descriptorValue.targetPath!))
  )) || requiredFolders.some((required) => (
    policy.globalPermissions.folders.some((folder) => isPathInside(folder, required))
  ));
  return {
    behavior: 'allow',
    access,
    preapproved,
    permissionSource: usesRememberedFolder ? 'folder_capability' : 'default',
    descriptor: descriptors[0],
    descriptors,
  };
}

export function matchesAgentToolRule(rule: string, toolNameInput: string, args: unknown): boolean {
  const trimmed = rule.trim();
  if (!trimmed) return false;
  if (trimmed === '*') return true;
  const toolName = normalizeToolName(toolNameInput);
  const match = /^([^()\s]+)(?:\(([\s\S]*)\))?$/.exec(trimmed);
  if (!match) return matchesToolNameRule(trimmed, toolName);
  if (!matchesToolNameRule(match[1] ?? '', toolName)) return false;
  const pattern = match[2];
  if (pattern === undefined || toolName !== 'bash') return true;
  const command = getStringArg(args, 'command');
  return command !== null && wildcardMatches(pattern.trim(), command);
}

export function deriveAgentToolActionDescriptors(input: {
  toolName: string;
  args: unknown;
  policy: AgentPermissionPolicy;
  access: AgentPermissionAccess;
}): ToolActionDescriptor[] {
  const toolName = normalizeToolName(input.toolName);
  if (toolName === 'bash') return deriveBashActionDescriptors(getStringArg(input.args, 'command'), input.args, input.policy);

  const pathArgName = toolPathArgumentName(toolName);
  if (pathArgName) return [derivePathToolActionDescriptor(toolName, input.args, input.policy, input.access, pathArgName)];

  const known = descriptorForKnownTool(toolName, input.args);
  return [known ?? descriptor(toolName, 'shell.unknown', {
    accessScope: 'none',
    title: 'unclassified tool action',
    summary: `Use ${toolName}.`,
    consequence: 'The action is unclassified for audit purposes.',
  })];
}

function descriptorForKnownTool(toolName: string, args: unknown): ToolActionDescriptor | null {
  if (toolName === 'web_search') return simpleDescriptor(toolName, args, 'web.search', 'web search', 'Search public web information.', 'external_system');
  if (toolName === 'web_fetch') return simpleDescriptor(toolName, args, 'web.fetch', 'web fetch', 'Fetch an external web resource.', 'external_system');
  if (toolName === 'generate_image') return simpleDescriptor(toolName, args, 'agent.image.generate', 'image generation', 'Generate an image with an enabled provider.', 'external_system');
  if (toolName === 'past_chats') return simpleDescriptor(toolName, args, 'agent.memory.recall', 'past chat recall', 'Read local conversation history.');
  if (toolName === 'ask_user_question') return simpleDescriptor(toolName, args, 'agent.user_question.ask', 'user question', 'Ask the user for required product input.');
  if (toolName === 'node_read' || toolName === 'node_search') return simpleDescriptor(toolName, args, 'outline.read', 'outline read', 'Read local outline content.', 'allowed_file_area');
  if (toolName === 'node_create' || toolName === 'node_edit' || toolName === 'data_import') return simpleDescriptor(toolName, args, 'outline.edit', 'outline edit', 'Change local outline content.', 'allowed_file_area');
  if (toolName === 'node_delete') return simpleDescriptor(toolName, args, 'outline.delete', 'outline delete', 'Delete local outline content.', 'allowed_file_area');
  if (toolName === 'outline_undo_stack') {
    const actionKind = firstActionKindForTool(toolName, args, 'outline.read') ?? 'outline.read';
    return simpleDescriptor(toolName, args, actionKind, 'outline history', 'Inspect or apply local outline history.', 'allowed_file_area');
  }
  if (toolName === 'bash_stop') return simpleDescriptor(toolName, args, 'shell.stop', 'process stop', 'Stop an agent-launched background process.');
  if (toolName === 'skill') return simpleDescriptor(toolName, args, 'agent.skill.invoke', 'skill invocation', 'Invoke installed skill instructions.');
  const issueAction = firstActionKindForTool(toolName, args, null);
  if (issueAction) return simpleDescriptor(toolName, args, issueAction, issueAction, `Run ${issueAction}.`);
  if (toolName === 'payment' || toolName === 'purchase') {
    return descriptor(toolName, 'payment.purchase', {
      accessScope: 'external_system',
      title: 'payment',
      summary: 'Purchase through an unsupported tool.',
      consequence: 'Payments require a product-owned payment flow.',
      code: 'payment_flow_required',
      floor: 'payment',
      platformHardBlock: true,
    });
  }
  return null;
}

function simpleDescriptor(
  toolName: string,
  args: unknown,
  fallback: AgentToolActionKind,
  title: string,
  summary: string,
  accessScope: ToolAccessScope = 'none',
): ToolActionDescriptor {
  return descriptor(toolName, firstActionKindForTool(toolName, args, fallback) ?? fallback, {
    accessScope,
    title,
    summary,
    consequence: summary,
  });
}

function derivePathToolActionDescriptor(
  toolName: string,
  args: unknown,
  policy: AgentPermissionPolicy,
  access: AgentPermissionAccess,
  pathArgName: string,
): ToolActionDescriptor {
  const rawPath = getStringArg(args, pathArgName);
  const write = access === 'write';
  const fallback = fileActionKind(toolName, write, 'allowed_file_area');
  if (!rawPath) {
    return descriptor(toolName, fallback, {
      accessScope: 'allowed_file_area',
      title: write ? 'file write' : 'file read',
      summary: write ? 'Write a local file.' : 'Read a local file.',
      consequence: 'No path was provided.',
    });
  }

  const targetPath = canonicalPathPreservingSuffix(resolvePermissionPath(policy.workspaceRoot, rawPath));
  const snapshot = createFolderCapabilitySnapshot({
    workspaceRoot: policy.workspaceRoot,
    scratchRoot: policy.scratchRoot,
    activeSkillReadRoots: policy.trustedReadRoots,
    protectedRoots: policy.protectedStoreRoot ? [policy.protectedStoreRoot] : [],
  }, policy.globalPermissions.folders);
  const protectedRoot = protectedRootForPath(snapshot, targetPath, write ? 'write' : 'read');
  if (protectedRoot) {
    return descriptor(toolName, fileActionKind(toolName, write, 'sensitive_local_path'), {
      accessScope: 'outside_allowed_file_area',
      title: 'Tenon control plane access',
      summary: `${write ? 'Write' : 'Read'} private Tenon state at ${targetPath}.`,
      consequence: `Agent file tools cannot access Tenon control state under ${protectedRoot}.`,
      targetPath,
      code: 'control_plane_unavailable',
      floor: 'permission_self_mod',
      platformHardBlock: true,
    });
  }
  const roots = write ? snapshot.writeRoots : snapshot.readRoots;
  const inside = roots.some((root) => isPathInside(root, targetPath));
  const sensitive = isSensitivePath(targetPath);
  const scope: ToolAccessScope = inside ? 'allowed_file_area' : 'outside_allowed_file_area';
  const actionKind = fileActionKind(toolName, write, sensitive ? 'sensitive_local_path' : scope);
  return descriptor(toolName, actionKind, {
    accessScope: scope,
    title: write ? 'file write' : 'file read',
    summary: `${write ? 'Write' : 'Read'} ${targetPath}.`,
    consequence: inside ? 'This path is covered by an existing folder capability.' : 'This path needs a folder capability.',
    targetPath,
  });
}

function deriveBashActionDescriptors(
  command: string | null,
  args: unknown,
  policy: AgentPermissionPolicy,
): ToolActionDescriptor[] {
  if (!command) return [unknownShellDescriptor('', 'Missing shell command.')];
  for (const rule of BASH_HARD_DENY_RULES) {
    if (rule.matches(command)) {
      return [descriptor('bash', 'shell.destructive_cleanup', {
        accessScope: 'allowed_file_area',
        title: 'blocked host operation',
        summary: command,
        consequence: rule.reason,
        command,
        code: rule.code,
        floor: rule.floor,
        platformHardBlock: true,
      })];
    }
  }
  if (looksLikeProtectedStoreWrite(command, policy.workspaceRoot, policy.protectedStoreRoot)) {
    return [descriptor('bash', 'file.write.sensitive_local_path', {
      accessScope: 'outside_allowed_file_area',
      title: 'protected settings write',
      summary: command,
      consequence: 'Agent tools cannot modify Tenon permission or credential stores.',
      command,
      code: 'sensitive_persistence_write',
      floor: 'permission_self_mod',
      platformHardBlock: true,
    })];
  }
  if (looksLikeSelfDefinitionShellWrite(command, policy.workspaceRoot)) {
    return [descriptor('bash', 'file.write.sensitive_local_path', {
      accessScope: 'allowed_file_area',
      title: 'skill definition write',
      summary: command,
      consequence: 'Executable skill definitions must go through the validated skill authoring gateway.',
      command,
      code: 'self_definition_shell_write',
      floor: 'permission_self_mod',
      platformHardBlock: true,
    })];
  }

  const descriptors = splitShellSegments(command).map((segment) => classifyShellSegment(segment, command));
  if (getBooleanArg(args, 'run_in_background')) {
    descriptors.push(descriptor('bash', 'shell.background_process', {
      accessScope: 'allowed_file_area',
      title: 'background process',
      summary: command,
      consequence: 'Run a process in the background.',
      command,
    }));
  }
  return descriptors.length > 0 ? descriptors : [unknownShellDescriptor(command, 'Unclassified shell syntax.')];
}

function classifyShellSegment(segmentInput: string, fullCommand: string): ToolActionDescriptor {
  const segment = segmentInput.trim();
  const head = parseShellWords(segment)[0]?.toLowerCase() ?? '';
  const values = (actionKind: AgentToolActionKind, title: string, summary: string): ToolActionDescriptor => descriptor('bash', actionKind, {
    accessScope: actionKind === 'shell.network_write' || actionKind === 'git.publish_remote' || actionKind === 'deploy.publish_remote'
      ? 'external_system'
      : 'allowed_file_area',
    title,
    summary,
    consequence: summary,
    command: fullCommand,
  });
  if (!head) return unknownShellDescriptor(fullCommand, 'Empty shell segment.');
  if (/\bgit\s+(?:push|send-email)\b/i.test(segment) || /\bgh\s+(?:pr\s+(?:create|merge|close|reopen|comment|review)|release\s+create)\b/i.test(segment)) {
    return values('git.publish_remote', 'remote repository write', segment);
  }
  if (/\b(?:vercel|wrangler|firebase|fly|netlify)\s+(?:deploy|publish)\b|\bkubectl\s+(?:apply|create|delete|patch|replace|rollout)\b/i.test(segment)) {
    return values('deploy.publish_remote', 'deployment', segment);
  }
  if (looksLikeNetworkWrite(segment)) return values('shell.network_write', 'network write', segment);
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:add|install|i|remove|uninstall|update)\b|\b(?:pip|pip3)\s+install\b|\bbrew\s+(?:install|uninstall|upgrade)\b/i.test(segment)) {
    return values('shell.dependency_install', 'dependency change', segment);
  }
  if (/\brm\s+[^;&|]*-[^\s]*r|\bfind\b[^;&|]*(?:-delete|-exec\s+rm)\b/i.test(segment)) {
    return values('shell.destructive_cleanup', 'local cleanup', segment);
  }
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run|test|build|dev|lint|check)\b/i.test(segment)) {
    return values('shell.project_script', 'project script', segment);
  }
  if (/\btenon-import\s+commit\b/i.test(segment)) {
    return values('outline.edit', 'outline import', segment);
  }
  if (/\b(?:python(?:3)?|node|deno|bun|ruby|perl|php|osascript|bash|sh|zsh)\b(?:\s|$)/i.test(segment)) {
    return values('shell.local_code_execution', 'local code execution', segment);
  }
  if (containsShellWriteOperator(segment) || /\b(?:sed|perl|ruby)\s+-[^\s]*i\b/i.test(segment)) {
    return values('file.edit.allowed_file_area', 'shell file edit', segment);
  }
  if (/\b(?:ls|find|fd|rg|grep|cat|head|tail|sed|awk|wc|stat|git\s+(?:status|diff|log|show|branch))\b/i.test(segment)) {
    return values('shell.read_search', 'local inspection', segment);
  }
  return unknownShellDescriptor(fullCommand, 'Unclassified shell syntax.');
}

function requiredFoldersForTool(
  toolName: string,
  args: unknown,
  workspaceRoot: string,
  snapshot: ReturnType<typeof createFolderCapabilitySnapshot>,
  access: AgentPermissionAccess,
): string[] {
  if (toolName === 'bash') return normalizeRequiredFolders(getUnknownArg(args, 'required_folders'), workspaceRoot);
  const pathArg = toolPathArgumentName(toolName);
  if (!pathArg) return [];
  const rawPath = getStringArg(args, pathArg);
  if (!rawPath) return [];
  const target = canonicalPathPreservingSuffix(resolvePermissionPath(workspaceRoot, rawPath));
  const allowedRoots = access === 'write' ? snapshot.writeRoots : snapshot.readRoots;
  if (allowedRoots.some((root) => isPathInside(root, target))) return [];
  const folder = capabilityFolderForTarget(target, workspaceRoot);
  return folder ? [folder] : [];
}

export function toolPathArgumentName(toolNameInput: string): string | null {
  const toolName = normalizeToolName(toolNameInput);
  if (toolName === 'file_read' || toolName === 'file_edit' || toolName === 'file_write' || toolName === 'file_delete') return 'file_path';
  if (toolName === 'file_glob' || toolName === 'file_grep') return 'path';
  return null;
}

function firstActionKindForTool(
  toolName: string,
  args: unknown,
  fallback: AgentToolActionKind | null,
): AgentToolActionKind | null {
  return agentToolActionKindProfile(toolName, args)?.[0] ?? fallback;
}

function fileActionKind(
  toolName: string,
  write: boolean,
  scope: 'allowed_file_area' | 'outside_allowed_file_area' | 'sensitive_local_path',
): AgentToolActionKind {
  if (!write) return `file.read.${scope}`;
  if (scope !== 'allowed_file_area') return `file.write.${scope}`;
  if (toolName === 'file_delete') return 'file.delete.allowed_file_area';
  if (toolName === 'file_edit') return 'file.edit.allowed_file_area';
  return 'file.write.allowed_file_area';
}

function descriptor(
  toolName: string,
  actionKind: AgentToolActionKind,
  values: Omit<ToolActionDescriptor, 'toolName' | 'actionKind'>,
): ToolActionDescriptor {
  return { toolName, actionKind, ...values };
}

function unknownShellDescriptor(command: string, reason: string): ToolActionDescriptor {
  return descriptor('bash', 'shell.unknown', {
    accessScope: 'allowed_file_area',
    title: 'unclassified shell command',
    summary: command || reason,
    consequence: reason,
    command: command || undefined,
  });
}

function block(
  code: string,
  reason: string,
  access: AgentPermissionAccess,
  preapproved: boolean,
  descriptors: readonly ToolActionDescriptor[],
  descriptorValue?: ToolActionDescriptor,
  redline?: true,
  permissionSource: AgentPermissionSource = 'default',
): AgentPermissionBlockedDecision {
  return {
    behavior: 'blocked',
    code,
    reason,
    access,
    preapproved,
    permissionSource,
    descriptor: descriptorValue ?? descriptors[0],
    descriptors,
    redline,
  };
}

function classifyToolAccess(toolName: string, args?: unknown): AgentPermissionAccess {
  if (toolName === 'bash') return 'execute';
  if (toolName === 'bash_stop' || toolName === 'skill' || toolName === 'ask_user_question' || toolName === 'generate_image') return 'control';
  if (toolName === 'file_edit' || toolName === 'file_write' || toolName === 'file_delete' || toolName === 'node_create' || toolName === 'node_edit' || toolName === 'node_delete' || toolName === 'data_import') return 'write';
  if (toolName === 'outline_undo_stack') {
    return agentToolActionKindProfile(toolName, args)?.some((actionKind) => !isReadOnlyActionKind(actionKind)) ? 'write' : 'read';
  }
  if (toolName === 'file_read' || toolName === 'file_glob' || toolName === 'file_grep' || toolName === 'web_fetch' || toolName === 'web_search' || toolName === 'past_chats' || toolName === 'node_read' || toolName === 'node_search') return 'read';
  return 'unknown';
}

function isRestrictedBaseAllowed(toolName: string, args: unknown): boolean {
  if (toolName === 'outline_undo_stack') {
    return agentToolActionKindProfile(toolName, args)?.every(isReadOnlyActionKind) === true;
  }
  return RESTRICTED_BASE_ALLOWED_TOOLS.has(toolName);
}

function looksLikeProtectedStoreWrite(
  command: string,
  workspaceRoot: string,
  protectedStoreRoot?: string,
): boolean {
  if (!protectedStoreRoot) return false;
  return shellMutationTargets(command, workspaceRoot)
    .some((target) => isAgentProtectedStorePath(target, protectedStoreRoot));
}

function looksLikeSelfDefinitionShellWrite(command: string, workspaceRoot: string): boolean {
  return shellMutationTargets(command, workspaceRoot).some((target) => (
    selfDefinitionRootEntries(workspaceRoot).some((entry) => isPathInside(entry.dir, target))
  ));
}

function looksLikeNetworkWrite(command: string): boolean {
  return /\b(?:curl|wget)\b[\s\S]*(?:--data(?:-binary|-raw|-urlencode)?|-d\b|--form|-F\b|--upload-file|-T\b|-X\s*(?:POST|PUT|PATCH|DELETE)|--request\s+(?:POST|PUT|PATCH|DELETE))\b|\b(?:scp|sftp|rsync|rclone\s+(?:copy|sync)|aws\s+s3\s+cp|gsutil\s+cp|nc|netcat)\b/i.test(command);
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

function splitShellSegments(command: string): string[] {
  const lines = command.split(/\r?\n/);
  const segments: string[] = [];
  let heredocEnd: string | null = null;
  for (const line of lines) {
    if (heredocEnd) {
      if (line.trim() === heredocEnd) heredocEnd = null;
      continue;
    }
    const heredoc = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line);
    if (heredoc?.[1]) heredocEnd = heredoc[1];
    segments.push(...line.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean));
  }
  return segments;
}

interface ShellInvocation {
  executable: string;
  args: string[];
  segment: string;
}

function shellInvocations(command: string, depth = 0): ShellInvocation[] {
  if (depth > 2) return [];
  const invocations: ShellInvocation[] = [];
  for (const segment of splitShellSegments(command)) {
    const words = unwrapShellWords(parseShellWords(segment));
    const executable = path.basename(words[0] ?? '').toLowerCase();
    if (!executable) continue;
    const invocation = { executable, args: words.slice(1), segment };
    invocations.push(invocation);
    if (['bash', 'sh', 'zsh'].includes(executable)) {
      const commandIndex = invocation.args.findIndex((arg) => arg === '-c' || arg === '--command');
      const nested = commandIndex >= 0 ? invocation.args[commandIndex + 1] : undefined;
      if (nested) invocations.push(...shellInvocations(nested, depth + 1));
    }
  }
  return invocations;
}

function unwrapShellWords(wordsInput: readonly string[]): string[] {
  let words = [...wordsInput];
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
  while (words.length > 1) {
    const wrapper = path.basename(words[0]!).toLowerCase();
    if (wrapper === 'command' || wrapper === 'nohup') {
      words = words.slice(1);
      continue;
    }
    if (wrapper === 'env') {
      words = words.slice(1);
      while (words.length > 0 && (words[0]!.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!))) {
        words.shift();
      }
      continue;
    }
    if (wrapper === 'sudo') {
      words = words.slice(1);
      while (words.length > 0 && words[0]!.startsWith('-')) words.shift();
      continue;
    }
    break;
  }
  return words;
}

function isDangerousRecursiveDelete(invocation: ShellInvocation): boolean {
  if (invocation.executable === 'rm') {
    const flags = invocation.args.filter((arg) => arg.startsWith('-')).join('');
    const recursive = /r/i.test(flags) || invocation.args.includes('--recursive');
    const force = /f/i.test(flags) || invocation.args.includes('--force');
    return recursive && force && shellPathOperands(invocation.args).some(isHostRootTarget);
  }
  if (invocation.executable !== 'find') return false;
  const operands = shellPathOperands(invocation.args);
  const destructive = invocation.args.includes('-delete')
    || invocation.args.some((arg, index) => arg === '-exec' && path.basename(invocation.args[index + 1] ?? '') === 'rm');
  return destructive && operands.slice(0, 1).some(isHostRootTarget);
}

function isDangerousDiskFormat(invocation: ShellInvocation): boolean {
  if (/^(?:mkfs(?:\..+)?|newfs(?:_.+)?)$/i.test(invocation.executable)) return true;
  if (invocation.executable !== 'diskutil') return false;
  const operation = invocation.args[0]?.toLowerCase() ?? '';
  return /^(?:erase|partition)/.test(operation)
    || (operation === 'apfs' && /^delete/.test(invocation.args[1]?.toLowerCase() ?? ''));
}

function isDangerousRawDiskWrite(invocation: ShellInvocation): boolean {
  return invocation.executable === 'dd'
    && invocation.args.some((arg) => /^of=\/dev\/(?:disk|rdisk|sd[a-z]|nvme|xvd)/i.test(arg));
}

function isDangerousRootPermissionChange(invocation: ShellInvocation): boolean {
  if (invocation.executable !== 'chmod' && invocation.executable !== 'chown') return false;
  const recursive = invocation.args.some((arg) => arg === '--recursive' || /^-[^-]*R/.test(arg));
  return recursive && shellPathOperands(invocation.args).some((operand) => path.resolve(expandHome(operand)) === path.parse(path.resolve(operand)).root);
}

function isHostRootTarget(valueInput: string): boolean {
  const value = valueInput.replace(/\/\*$/, '').replace(/\/$/, '') || '/';
  const resolved = path.resolve(expandHome(value));
  return resolved === path.parse(resolved).root || resolved === path.resolve(homedir());
}

function shellPathOperands(args: readonly string[]): string[] {
  return args
    .filter((arg) => arg !== '--' && !arg.startsWith('-'))
    .map((arg) => arg.replace(/[),]+$/, ''));
}

function shellMutationTargets(command: string, workspaceRoot: string): string[] {
  const targets: string[] = [];
  for (const invocation of shellInvocations(command)) {
    targets.push(...redirectionTargets(invocation.segment));
    const operands = shellPathOperands(invocation.args);
    switch (invocation.executable) {
      case 'rm':
      case 'unlink':
      case 'rmdir':
      case 'mkdir':
      case 'touch':
      case 'truncate':
      case 'tee':
      case 'mv':
        targets.push(...operands);
        break;
      case 'cp':
      case 'install':
      case 'ln':
        if (operands.length > 0) targets.push(operands[operands.length - 1]!);
        break;
      case 'chmod':
      case 'chown':
        if (operands.length > 1) targets.push(...operands.slice(1));
        break;
      case 'sed':
      case 'perl':
      case 'ruby':
        if (invocation.args.some((arg) => /^-[^-]*i/.test(arg)) && operands.length > 0) {
          targets.push(operands[operands.length - 1]!);
        }
        break;
    }
  }
  return [...new Set(targets
    .map((target) => target.trim())
    .filter(Boolean)
    .map((target) => resolvePermissionPath(workspaceRoot, target)))];
}

function redirectionTargets(segment: string): string[] {
  const targets: string[] = [];
  const pattern = /(?:^|\s)(?:\d*|&)>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(segment)) !== null) {
    const target = match[1] ?? match[2] ?? match[3];
    if (target) targets.push(target);
  }
  return targets;
}

function isSensitivePath(filePath: string): boolean {
  return /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|\.azure|Library\/Keychains)(?:\/|$)|(?:^|\/)\.env(?:$|[./-])|\.(?:pem|key|p12|pfx)$/i.test(filePath);
}

function normalizeRoots(roots: readonly string[] | undefined): string[] {
  const normalized: string[] = [];
  for (const root of roots ?? []) {
    if (!root.trim()) continue;
    const canonical = canonicalPathPreservingSuffix(root);
    if (!normalized.some((existing) => isPathInside(existing, canonical))) normalized.push(canonical);
  }
  return normalized;
}

function matchesToolNameRule(rule: string, toolNameInput: string): boolean {
  const normalizedRule = normalizeToolName(rule);
  const toolName = normalizeToolName(toolNameInput);
  return normalizedRule === toolName || normalizedRule === '*';
}

function normalizeToolName(value: string): string {
  const normalized = value.trim().replace(/^\//, '').replace(/-/g, '_').toLowerCase();
  return TOOL_ALIASES.get(normalized) ?? normalized;
}

function getUnknownArg(args: unknown, name: string): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  return (args as Record<string, unknown>)[name];
}

function getStringArg(args: unknown, name: string): string | null {
  const value = getUnknownArg(args, name);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getBooleanArg(args: unknown, name: string): boolean {
  return getUnknownArg(args, name) === true;
}

function resolvePermissionPath(root: string, inputPath: string): string {
  const expanded = expandHome(inputPath);
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(root, expanded));
}

function expandHome(inputPath: string): string {
  if (inputPath === '~' || inputPath === '$HOME' || inputPath === '${HOME}') return homedir();
  if (inputPath.startsWith('~/')) return path.join(homedir(), inputPath.slice(2));
  if (inputPath.startsWith('$HOME/')) return path.join(homedir(), inputPath.slice(6));
  if (inputPath.startsWith('${HOME}/')) return path.join(homedir(), inputPath.slice(8));
  return inputPath;
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
