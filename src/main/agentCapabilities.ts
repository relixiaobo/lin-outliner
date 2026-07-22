import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  isReadOnlyModelToolActionKind,
  modelToolActionKinds,
} from '../core/agent/tools';
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

export interface AgentCapabilityPolicy {
  workspaceRoot: string;
  capabilityConfig: AgentCapabilityConfig;
}

export interface AgentCapabilityPolicyInput {
  workspaceRoot?: string;
  capabilityConfig?: unknown;
}

interface AgentCapabilityDecisionBase {
  access: AgentCapabilityAccess;
  descriptor?: ToolActionDescriptor;
  descriptors: readonly ToolActionDescriptor[];
}

export interface AgentCapabilityAllowDecision extends AgentCapabilityDecisionBase {
  behavior: 'allow';
  source: 'default';
}

export interface AgentCapabilityUnavailableDecision extends AgentCapabilityDecisionBase {
  behavior: 'unavailable';
  code: 'user_blocked';
  reason: string;
  source: 'user_blocklist';
}

export type AgentCapabilityDecision =
  | AgentCapabilityAllowDecision
  | AgentCapabilityUnavailableDecision;

export interface AgentCapabilityEvaluationInput {
  toolName: string;
  args: unknown;
  policy: AgentCapabilityPolicyInput;
}

export function createAgentCapabilityPolicy(input: AgentCapabilityPolicyInput = {}): AgentCapabilityPolicy {
  const workspaceRoot = canonicalPathPreservingSuffix(input.workspaceRoot ?? process.cwd());
  return {
    workspaceRoot,
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
      `Blocked by user rule ${userBlock.rule.ruleValue}.`,
      access,
      descriptors,
      userBlock.descriptor,
    );
  }

  return {
    behavior: 'allow',
    access,
    source: 'default',
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
  if (toolName === 'request_user_input') return simpleDescriptor(toolName, args, 'agent.user_input.request', 'user input', 'Request missing product input.');
  if (toolName === 'node_read' || toolName === 'node_search') return simpleDescriptor(toolName, args, 'outline.read', 'outline read', 'Read local outline content.', 'local_system');
  if (toolName === 'node_create' || toolName === 'node_edit') return simpleDescriptor(toolName, args, 'outline.edit', 'outline edit', 'Change local outline content.', 'local_system');
  if (toolName === 'node_delete') return simpleDescriptor(toolName, args, 'outline.delete', 'outline delete', 'Delete local outline content.', 'local_system');
  if (toolName === 'outline_undo_stack') {
    const actionKind = firstActionKindForTool(toolName, args, 'outline.read') ?? 'outline.read';
    return simpleDescriptor(toolName, args, actionKind, 'outline history', 'Inspect or apply local outline history.', 'local_system');
  }
  if (toolName === 'bash_stop') return simpleDescriptor(toolName, args, 'shell.stop', 'process stop', 'Stop an agent-launched background process.');
  if (toolName === 'skill') return simpleDescriptor(toolName, args, 'agent.skill.invoke', 'skill invocation', 'Invoke installed skill instructions.');
  const catalogAction = firstActionKindForTool(toolName, args, null);
  if (catalogAction) return simpleDescriptor(toolName, args, catalogAction, catalogAction, `Execute ${catalogAction}.`);
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
  const fallback = fileActionKind(toolName, write, 'local_path');
  if (!rawPath) {
    return descriptor(toolName, fallback, {
      accessScope: 'local_system',
      title: write ? 'file write' : 'file read',
      summary: write ? 'Write a local file.' : 'Read a local file.',
      consequence: 'No path was provided.',
    });
  }

  const targetPath = canonicalPathPreservingSuffix(resolveCapabilityPath(policy.workspaceRoot, rawPath));
  const sensitive = isSensitivePath(targetPath);
  const scope: ToolAccessScope = 'local_system';
  const actionKind = fileActionKind(toolName, write, sensitive ? 'sensitive_local_path' : 'local_path');
  return descriptor(toolName, actionKind, {
    accessScope: scope,
    title: write ? 'file write' : 'file read',
    summary: `${write ? 'Write' : 'Read'} ${targetPath}.`,
    consequence: 'This path is available through Full Access.',
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
      accessScope: 'local_system',
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
      : 'local_system',
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
    return values('file.edit.local_path', 'shell file edit', segment);
  }
  if (/\b(?:ls|find|fd|rg|grep|cat|head|tail|sed|awk|wc|stat|git\s+(?:status|diff|log|show|branch))\b/i.test(segment)) {
    return values('shell.read_search', 'local inspection', segment);
  }
  return unknownShellDescriptor(fullCommand, 'Unclassified shell syntax.');
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
  return modelToolActionKinds(toolName, args)?.[0] ?? fallback;
}

function fileActionKind(
  toolName: string,
  write: boolean,
  scope: 'local_path' | 'sensitive_local_path',
): AgentToolActionKind {
  if (!write) return `file.read.${scope}`;
  if (scope !== 'local_path') return `file.write.${scope}`;
  if (toolName === 'file_delete') return 'file.delete.local_path';
  if (toolName === 'file_edit') return 'file.edit.local_path';
  return 'file.write.local_path';
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
    accessScope: 'local_system',
    title: 'unclassified shell command',
    summary: command || reason,
    consequence: reason,
    command: command || undefined,
  });
}

function unavailable(
  reason: string,
  access: AgentCapabilityAccess,
  descriptors: readonly ToolActionDescriptor[],
  descriptorValue?: ToolActionDescriptor,
): AgentCapabilityUnavailableDecision {
  return {
    behavior: 'unavailable',
    code: 'user_blocked',
    reason,
    access,
    source: 'user_blocklist',
    descriptor: descriptorValue ?? descriptors[0],
    descriptors,
  };
}

function classifyToolAccess(toolName: string, args?: unknown): AgentCapabilityAccess {
  if (toolName === 'bash') return 'execute';
  const actionKinds = modelToolActionKinds(toolName, args);
  if (!actionKinds || actionKinds.length === 0) return 'unknown';
  if (actionKinds.every(isReadOnlyModelToolActionKind)) return 'read';
  if (actionKinds.some((kind) => kind.startsWith('file.') || kind === 'outline.edit' || kind === 'outline.delete')) return 'write';
  if (actionKinds.some((kind) => kind.startsWith('shell.'))) return 'execute';
  return 'control';
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

function normalizeToolName(value: string): string {
  return value.trim().toLowerCase();
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

function canonicalPathPreservingSuffix(inputPath: string): string {
  const requested = path.resolve(expandHome(inputPath));
  let existing = requested;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  try {
    const canonicalExisting = realpathSync.native(existing);
    const suffix = path.relative(existing, requested);
    return suffix ? path.resolve(canonicalExisting, suffix) : canonicalExisting;
  } catch {
    return requested;
  }
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
