import path from 'node:path';
import { homedir } from 'node:os';
import {
  agentToolActionKindProfile,
  isReadOnlyActionKind,
} from '../core/agentActionCatalog';
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
  parseAgentCapabilitySettings,
  type AgentToolActionKind,
  type AgentCapabilityConfig,
  type ToolAccessScope,
  type ToolActionDescriptor,
} from './agentCapabilityRules';

export type {
  AgentToolActionKind,
  AgentCapabilityConfig,
  ToolAccessScope,
  ToolActionDescriptor,
} from './agentCapabilityRules';

export type AgentCapabilityAccess = 'read' | 'write' | 'execute' | 'control' | 'unknown';
export type AgentCapabilityBehavior = 'allow' | 'capability_required' | 'unavailable';
export type AgentCapabilitySource = 'default' | 'folder_capability' | 'user_blocklist' | 'control_plane';

export interface AgentCapabilityDetail {
  label: string;
  value: string;
}

export interface AgentFolderCapabilityRequest {
  kind: 'folder';
  title: string;
  target: string;
  details: AgentCapabilityDetail[];
  folders: string[];
}

export interface AgentCapabilityPolicy {
  workspaceRoot: string;
  scratchRoot?: string;
  protectedStoreRoot?: string;
  trustedReadRoots: readonly string[];
  capabilityConfig: AgentCapabilityConfig;
}

export interface AgentCapabilityPolicyInput {
  workspaceRoot?: string;
  scratchRoot?: string;
  protectedStoreRoot?: string;
  trustedReadRoots?: readonly string[];
  capabilityConfig?: unknown;
}

interface AgentCapabilityDecisionBase {
  behavior: AgentCapabilityBehavior;
  access: AgentCapabilityAccess;
  reason?: string;
  code?: string;
  source: AgentCapabilitySource;
  descriptor?: ToolActionDescriptor;
  descriptors: readonly ToolActionDescriptor[];
}

export interface AgentCapabilityAllowDecision extends AgentCapabilityDecisionBase {
  behavior: 'allow';
}

export interface AgentCapabilityRequiredDecision extends AgentCapabilityDecisionBase {
  behavior: 'capability_required';
  code: 'folder_access_required';
  reason: string;
  request: AgentFolderCapabilityRequest;
}

export interface AgentCapabilityUnavailableDecision extends AgentCapabilityDecisionBase {
  behavior: 'unavailable';
  code: string;
  reason: string;
}

export type AgentCapabilityDecision =
  | AgentCapabilityAllowDecision
  | AgentCapabilityRequiredDecision
  | AgentCapabilityUnavailableDecision;

export interface AgentCapabilityEvaluationInput {
  toolName: string;
  args: unknown;
  policy: AgentCapabilityPolicyInput;
}

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

export function createAgentCapabilityPolicy(input: AgentCapabilityPolicyInput = {}): AgentCapabilityPolicy {
  const workspaceRoot = canonicalPathPreservingSuffix(input.workspaceRoot ?? process.cwd());
  return {
    workspaceRoot,
    scratchRoot: input.scratchRoot?.trim()
      ? canonicalPathPreservingSuffix(input.scratchRoot)
      : undefined,
    protectedStoreRoot: input.protectedStoreRoot?.trim()
      ? canonicalPathPreservingSuffix(input.protectedStoreRoot)
      : undefined,
    trustedReadRoots: normalizeRoots(input.trustedReadRoots),
    capabilityConfig: parseAgentCapabilitySettings(input.capabilityConfig),
  };
}

export function evaluateAgentToolCapability(input: AgentCapabilityEvaluationInput): AgentCapabilityDecision {
  const policy = createAgentCapabilityPolicy(input.policy);
  const toolName = normalizeToolName(input.toolName);
  const access = classifyToolAccess(toolName, input.args);
  const descriptors = deriveAgentToolActionDescriptors({ toolName, args: input.args, policy, access });

  const userBlock = descriptors
    .map((descriptor) => ({ descriptor, rule: matchingBlockForDescriptor(descriptor, policy.capabilityConfig) }))
    .find((entry) => entry.rule);
  if (userBlock?.rule) {
    return unavailable(
      'user_blocked',
      `Blocked by user rule ${userBlock.rule.ruleValue}.`,
      access,
      descriptors,
      userBlock.descriptor,
      'user_blocklist',
    );
  }

  if (policy.capabilityConfig.filesystemMode === 'full-access') {
    return {
      behavior: 'allow',
      access,
      source: 'default',
      descriptor: descriptors[0],
      descriptors,
    };
  }

  const unavailableDescriptor = descriptors.find((descriptor) => descriptor.code === 'control_plane_unavailable');
  if (unavailableDescriptor) {
    return unavailable(
      'control_plane_unavailable',
      unavailableDescriptor.consequence,
      access,
      descriptors,
      unavailableDescriptor,
      'control_plane',
    );
  }

  const snapshot = createFolderCapabilitySnapshot({
    filesystemMode: policy.capabilityConfig.filesystemMode,
    workspaceRoot: policy.workspaceRoot,
    scratchRoot: policy.scratchRoot,
    activeSkillReadRoots: policy.trustedReadRoots,
    protectedRoots: policy.protectedStoreRoot ? [policy.protectedStoreRoot] : [],
  }, policy.capabilityConfig.folders);
  const requiredFolders = requiredFoldersForTool(toolName, input.args, policy.workspaceRoot, snapshot, access);
  const requiredFolderAccess = access === 'read' ? 'read' : 'write';
  const protectedRequiredRoot = requiredFolders
    .map((folder) => protectedRootForPath(snapshot, folder, requiredFolderAccess))
    .find((root): root is string => Boolean(root));
  if (protectedRequiredRoot) {
    return unavailable(
      'control_plane_unavailable',
      `Agent processes cannot access Tenon control state under ${protectedRequiredRoot}.`,
      access,
      descriptors,
      descriptors[0],
      'control_plane',
    );
  }
  const missingFolders = missingFolderCapabilities(requiredFolders, { readRoots: snapshot.writeRoots });
  if (missingFolders.length > 0) {
    const target = missingFolders.join(', ');
    return {
      behavior: 'capability_required',
      access,
      code: 'folder_access_required',
      source: 'default',
      reason: `Folder access is required before ${input.toolName} can run: ${target}`,
      request: {
        kind: 'folder',
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
    && policy.capabilityConfig.folders.some((folder) => isPathInside(folder, descriptorValue.targetPath!))
  )) || requiredFolders.some((required) => (
    policy.capabilityConfig.folders.some((folder) => isPathInside(folder, required))
  ));
  return {
    behavior: 'allow',
    access,
    source: usesRememberedFolder ? 'folder_capability' : 'default',
    descriptor: descriptors[0],
    descriptors,
  };
}

export function deriveAgentToolActionDescriptors(input: {
  toolName: string;
  args: unknown;
  policy: AgentCapabilityPolicy;
  access: AgentCapabilityAccess;
}): ToolActionDescriptor[] {
  const toolName = normalizeToolName(input.toolName);
  if (toolName === 'bash') return deriveBashActionDescriptors(getStringArg(input.args, 'command'), input.args);

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
  policy: AgentCapabilityPolicy,
  access: AgentCapabilityAccess,
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

  const targetPath = canonicalPathPreservingSuffix(resolveCapabilityPath(policy.workspaceRoot, rawPath));
  const snapshot = createFolderCapabilitySnapshot({
    filesystemMode: policy.capabilityConfig.filesystemMode,
    workspaceRoot: policy.workspaceRoot,
    scratchRoot: policy.scratchRoot,
    activeSkillReadRoots: policy.trustedReadRoots,
    protectedRoots: policy.protectedStoreRoot ? [policy.protectedStoreRoot] : [],
  }, policy.capabilityConfig.folders);
  const protectedRoot = protectedRootForPath(snapshot, targetPath, write ? 'write' : 'read');
  if (protectedRoot) {
    return descriptor(toolName, fileActionKind(toolName, write, 'sensitive_local_path'), {
      accessScope: 'outside_allowed_file_area',
      title: 'Tenon control plane access',
      summary: `${write ? 'Write' : 'Read'} private Tenon state at ${targetPath}.`,
      consequence: `Agent file tools cannot access Tenon control state under ${protectedRoot}.`,
      targetPath,
      code: 'control_plane_unavailable',
    });
  }
  const roots = write ? snapshot.writeRoots : snapshot.readRoots;
  const inside = policy.capabilityConfig.filesystemMode === 'full-access'
    || roots.some((root) => isPathInside(root, targetPath));
  const sensitive = isSensitivePath(targetPath);
  const scope: ToolAccessScope = inside ? 'allowed_file_area' : 'outside_allowed_file_area';
  const actionKind = fileActionKind(toolName, write, sensitive ? 'sensitive_local_path' : scope);
  return descriptor(toolName, actionKind, {
    accessScope: scope,
    title: write ? 'file write' : 'file read',
    summary: `${write ? 'Write' : 'Read'} ${targetPath}.`,
    consequence: policy.capabilityConfig.filesystemMode === 'full-access'
      ? 'This path is available through Full Access.'
      : inside
        ? 'This path is covered by an existing folder capability.'
        : 'This path needs a folder capability.',
    targetPath,
  });
}

function deriveBashActionDescriptors(
  command: string | null,
  args: unknown,
): ToolActionDescriptor[] {
  if (!command) return [unknownShellDescriptor('', 'Missing shell command.')];
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
    // electron-vite 5's ESM shim scanner misreads this title as a static import
    // when the words are one literal, corrupting the packaged main-process chunk.
    return values('outline.edit', ['outline', 'import'].join(' '), segment);
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
  access: AgentCapabilityAccess,
): string[] {
  if (toolName === 'bash') return normalizeRequiredFolders(getUnknownArg(args, 'required_folders'), workspaceRoot);
  const pathArg = toolPathArgumentName(toolName);
  if (!pathArg) return [];
  const rawPath = getStringArg(args, pathArg);
  if (!rawPath) return [];
  const target = canonicalPathPreservingSuffix(resolveCapabilityPath(workspaceRoot, rawPath));
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

function unavailable(
  code: string,
  reason: string,
  access: AgentCapabilityAccess,
  descriptors: readonly ToolActionDescriptor[],
  descriptorValue?: ToolActionDescriptor,
  source: AgentCapabilitySource = 'default',
): AgentCapabilityUnavailableDecision {
  return {
    behavior: 'unavailable',
    code,
    reason,
    access,
    source,
    descriptor: descriptorValue ?? descriptors[0],
    descriptors,
  };
}

function classifyToolAccess(toolName: string, args?: unknown): AgentCapabilityAccess {
  if (toolName === 'bash') return 'execute';
  if (toolName === 'bash_stop' || toolName === 'skill' || toolName === 'ask_user_question' || toolName === 'generate_image') return 'control';
  if (toolName === 'file_edit' || toolName === 'file_write' || toolName === 'file_delete' || toolName === 'node_create' || toolName === 'node_edit' || toolName === 'node_delete' || toolName === 'data_import') return 'write';
  if (toolName === 'outline_undo_stack') {
    return agentToolActionKindProfile(toolName, args)?.some((actionKind) => !isReadOnlyActionKind(actionKind)) ? 'write' : 'read';
  }
  if (toolName === 'file_read' || toolName === 'file_glob' || toolName === 'file_grep' || toolName === 'web_fetch' || toolName === 'web_search' || toolName === 'past_chats' || toolName === 'node_read' || toolName === 'node_search') return 'read';
  return 'unknown';
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

function resolveCapabilityPath(root: string, inputPath: string): string {
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

function parseShellWords(command: string): string[] {
  const words: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s;&|]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    words.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\\(["\\])/g, '$1'));
  }
  return words;
}
