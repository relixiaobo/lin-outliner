import path from 'node:path';
import { homedir } from 'node:os';
import {
  isReadOnlyModelToolActionKind,
  modelToolActionKinds,
} from '../../../core/agent/tools';
import {
  OUTLINE_CAPABILITIES,
  OUTLINE_GLOBAL_OPTIONS,
  type OutlineCapability,
} from '../../../outline/contract/capabilities';
import {
  matchingBlockForDescriptor,
  parseAgentCapabilitySettings,
  type AgentToolActionKind,
  type AgentCapabilityConfig,
  type ToolAccessScope,
  type ToolActionDescriptor,
} from './agentCapabilityRules';
import { canonicalPathPreservingSuffix } from './agentAttachmentMaterialization';
import { parsePrivilegedDelegateCommand } from '../../../delegate/contract';

export type {
  AgentToolActionKind,
  AgentCapabilityConfig,
  ToolAccessScope,
  ToolActionDescriptor,
} from './agentCapabilityRules';

export type AgentCapabilityAccess = 'read' | 'write' | 'execute' | 'control' | 'unknown';
export type BashStdinConsumer = 'absent' | 'registered-data' | 'executable' | 'unknown';

export interface StdinConsumerContract {
  readonly executable: string;
  readonly command: string;
  readonly classification: 'registered-data';
}

export const BASH_STDIN_CONSUMER_CONTRACTS: readonly StdinConsumerContract[] = Object.freeze([
  Object.freeze({ executable: 'outline', command: 'create', classification: 'registered-data' }),
  Object.freeze({ executable: 'outline', command: 'transact', classification: 'registered-data' }),
  Object.freeze({ executable: 'outline', command: 'preview', classification: 'registered-data' }),
  Object.freeze({ executable: 'delegate', command: 'run', classification: 'registered-data' }),
  Object.freeze({ executable: 'delegate', command: 'send', classification: 'registered-data' }),
]);

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
  bashStdinConsumer?: BashStdinConsumer;
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
  /** Resolved runtime contract actions for extension and MCP tools. */
  actionKinds?: readonly AgentToolActionKind[];
  policy: AgentCapabilityPolicyInput;
}

export function createAgentCapabilityPolicy(input: AgentCapabilityPolicyInput = {}): AgentCapabilityPolicy {
  const workspaceRoot = canonicalPathPreservingSuffix(expandHome(input.workspaceRoot ?? process.cwd()));
  return {
    workspaceRoot,
    capabilityConfig: parseAgentCapabilitySettings(input.capabilityConfig),
  };
}

export function evaluateAgentToolCapability(input: AgentCapabilityEvaluationInput): AgentCapabilityDecision {
  const policy = createAgentCapabilityPolicy(input.policy);
  const toolName = normalizeToolName(input.toolName);
  const access = classifyToolAccess(toolName, input.args, input.actionKinds);
  const descriptorInput = {
    toolName,
    args: input.args,
    ...(input.actionKinds === undefined ? {} : { actionKinds: input.actionKinds }),
    policy,
    access,
  };
  const bash = toolName === 'bash'
    ? deriveBashCapability(getStringArg(input.args, 'command'), input.args)
    : null;
  const descriptors = bash?.descriptors ?? deriveAgentToolActionDescriptors(descriptorInput);

  const userBlock = descriptors
    .map((descriptor) => ({ descriptor, rule: matchingBlockForDescriptor(descriptor, policy.capabilityConfig) }))
    .find((entry) => entry.rule);
  if (userBlock?.rule) {
    return unavailable(
      `Blocked by user rule ${userBlock.rule.ruleValue}.`,
      access,
      descriptors,
      userBlock.descriptor,
      bash?.stdinConsumer,
    );
  }

  return {
    behavior: 'allow',
    access,
    source: 'default',
    descriptor: descriptors[0],
    descriptors,
    ...(bash ? { bashStdinConsumer: bash.stdinConsumer } : {}),
  };
}

export function deriveAgentToolActionDescriptors(input: {
  toolName: string;
  args: unknown;
  actionKinds?: readonly AgentToolActionKind[];
  policy: AgentCapabilityPolicy;
  access: AgentCapabilityAccess;
}): ToolActionDescriptor[] {
  const toolName = normalizeToolName(input.toolName);
  if (toolName === 'bash') return deriveBashCapability(getStringArg(input.args, 'command'), input.args).descriptors;
  if (toolName === 'task_stop') {
    return [
      descriptor(toolName, 'task.stop', {
        accessScope: 'none',
        title: 'Tool Task stop',
        summary: 'Stop a background Tool Task owned by this Thread.',
        consequence: 'Request process-group termination for a background Tool Task.',
      }),
    ];
  }

  const pathArgName = toolPathArgumentName(toolName);
  if (pathArgName) return [derivePathToolActionDescriptor(toolName, input.args, input.policy, input.access, pathArgName)];

  if (toolName === 'thread_read' && Array.isArray(getUnknownArg(input.args, 'citations'))
    && (getUnknownArg(input.args, 'citations') as unknown[]).length > 0) {
    return [
      simpleDescriptor(
        toolName,
        input.args,
        'thread.history.read',
        'Thread history read',
        'Read bounded visible same-profile Thread history.',
        'local_system',
      ),
      descriptor(toolName, 'file.read.local_path', {
        accessScope: 'local_system',
        title: 'historical file citation read',
        summary: 'Read a selected canonical file citation from bounded Thread history.',
        consequence: 'Link only the selected historical resource into the current Thread working set.',
      }),
    ];
  }

  const known = descriptorForKnownTool(toolName, input.args);
  if (known) return [known];
  if (input.actionKinds && input.actionKinds.length > 0) {
    return input.actionKinds.map((actionKind) => descriptor(toolName, actionKind, {
      accessScope: actionKind.startsWith('web.') ? 'external_system' : 'none',
      title: actionKind,
      summary: `Execute ${actionKind}.`,
      consequence: `Execute ${actionKind}.`,
    }));
  }
  return [descriptor(toolName, 'shell.unknown', {
    accessScope: 'none',
    title: 'unclassified tool action',
    summary: `Use ${toolName}.`,
    consequence: 'The action is unclassified for audit purposes.',
  })];
}

function descriptorForKnownTool(toolName: string, args: unknown): ToolActionDescriptor | null {
  if (toolName === 'thread_search') {
    return simpleDescriptor(
      toolName,
      args,
      'thread.history.search',
      'Thread history search',
      'Search visible same-profile Thread history.',
      'local_system',
    );
  }
  if (toolName === 'thread_read') {
    return simpleDescriptor(
      toolName,
      args,
      'thread.history.read',
      'Thread history read',
      'Read bounded visible same-profile Thread history.',
      'local_system',
    );
  }
  if (toolName === 'web_search') return simpleDescriptor(toolName, args, 'web.search', 'web search', 'Search public web information.', 'external_system');
  if (toolName === 'web_fetch') return simpleDescriptor(toolName, args, 'web.fetch', 'web fetch', 'Fetch an external web resource.', 'external_system');
  if (toolName === 'generate_image') return simpleDescriptor(toolName, args, 'agent.image.generate', 'image generation', 'Generate an image with an enabled provider.', 'external_system');
  if (toolName === 'request_user_input') return simpleDescriptor(toolName, args, 'agent.user_input.request', 'user input', 'Request missing product input.');
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

function deriveBashCapability(
  command: string | null,
  args: unknown,
): { readonly descriptors: ToolActionDescriptor[]; readonly stdinConsumer: BashStdinConsumer } {
  if (!command) {
    return {
      descriptors: [unknownShellDescriptor('', 'Missing shell command.')],
      stdinConsumer: hasOwnArg(args, 'stdin') ? 'unknown' : 'absent',
    };
  }
  const segments = splitShellSegments(command).map((segment) => ({
    segment,
    words: parseShellWords(segment),
  }));
  const descriptors = segments.flatMap(({ segment, words }) => classifyShellSegment(segment, command, words));
  const stdinConsumer = classifyParsedBashStdinConsumer(
    command,
    hasOwnArg(args, 'stdin'),
    segments.map(({ words }) => words),
  );
  if (stdinConsumer === 'executable' && !descriptors.some((entry) => entry.actionKind === 'shell.local_code_execution')) {
    descriptors.push(shellConsumerDescriptor(command, 'shell.local_code_execution', stdinConsumer));
  } else if (stdinConsumer === 'unknown' && !descriptors.some((entry) => entry.actionKind === 'shell.unknown')) {
    descriptors.push(shellConsumerDescriptor(command, 'shell.unknown', stdinConsumer));
  }
  if (getBooleanArg(args, 'run_in_background')) {
    descriptors.push(descriptor('bash', 'shell.background_process', {
      accessScope: 'local_system',
      title: 'background process',
      summary: command,
      consequence: 'Run a process in the background.',
      command,
    }));
  }
  return {
    descriptors: descriptors.length > 0 ? descriptors : [unknownShellDescriptor(command, 'Unclassified shell syntax.')],
    stdinConsumer,
  };
}

export function classifyBashStdinConsumer(
  command: string,
  stdinPresent: boolean,
  registry: readonly StdinConsumerContract[] = BASH_STDIN_CONSUMER_CONTRACTS,
): BashStdinConsumer {
  const segments = splitShellSegments(command).map((segment) => parseShellWords(segment));
  return classifyParsedBashStdinConsumer(command, stdinPresent, segments, registry);
}

function classifyParsedBashStdinConsumer(
  command: string,
  stdinPresent: boolean,
  segments: readonly (readonly string[])[],
  registry: readonly StdinConsumerContract[] = BASH_STDIN_CONSUMER_CONTRACTS,
): BashStdinConsumer {
  if (!stdinPresent) return 'absent';
  if (segments.length !== 1 || containsShellComposition(command)) return 'unknown';
  const words = segments[0]!;
  const delegate = parsePrivilegedDelegateCommand(command);
  if (delegate && delegate.name !== 'close'
    && registry.some((entry) => entry.executable === 'delegate' && entry.command === delegate.name)) {
    return 'registered-data';
  }
  const outline = outlineShellInvocation(words);
  if (outline && registeredOutlineStdinConsumer(outline, registry)) return 'registered-data';
  return interpreterConsumesStdin(words) ? 'executable' : 'unknown';
}

function registeredOutlineStdinConsumer(
  invocation: DirectOutlineShellInvocation,
  registry: readonly StdinConsumerContract[],
): boolean {
  const contract = registry.find((entry) => entry.executable === 'outline' && entry.command === invocation.command);
  if (!contract) return false;
  const inputIndexes = invocation.args.flatMap((entry, index) => entry === '--input' ? [index] : []);
  if (inputIndexes.length !== 1 || invocation.args[inputIndexes[0]! + 1] !== '-') return false;
  return !invocation.args.some((entry) => (
    entry === '--file' || entry.startsWith('--file=') || entry.startsWith('--input=')
  ));
}

function interpreterConsumesStdin(words: readonly string[]): boolean {
  const executableIndex = shellExecutableIndex(words);
  const executable = path.basename(words[executableIndex] ?? '').toLowerCase();
  const args = words.slice(executableIndex + 1);
  if (['bash', 'sh', 'zsh'].includes(executable)) return args.some((arg) => arg === '-s' || /^-[^-]*s/.test(arg));
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(executable)) return noScriptOrDash(args, new Set(['-c', '-m']));
  if (executable === 'node') return noScriptOrDash(args, new Set(['-e', '--eval', '-p', '--print']));
  if (executable === 'deno') return args[0] === '-' || (args[0] === 'run' && args[1] === '-');
  if (executable === 'bun') return args[0] === '-' || (args[0] === 'run' && args[1] === '-');
  if (['ruby', 'perl', 'php'].includes(executable)) return noScriptOrDash(args, new Set(['-e', '-r']));
  if (executable === 'osascript') return args.length === 0 || args.at(-1) === '-';
  return false;
}

function noScriptOrDash(args: readonly string[], sourceOptions: ReadonlySet<string>): boolean {
  if (args.includes('-')) return true;
  if (args.some((arg) => sourceOptions.has(arg))) return false;
  return !args.some((arg) => !arg.startsWith('-'));
}

function containsShellComposition(command: string): boolean {
  return /(?:&&|\|\||[;|<>]|`|\$\()/.test(command);
}

function shellConsumerDescriptor(
  command: string,
  actionKind: AgentToolActionKind,
  consumer: BashStdinConsumer,
): ToolActionDescriptor {
  return descriptor('bash', actionKind, {
    accessScope: 'local_system',
    title: consumer === 'executable' ? 'executable stdin' : 'unknown stdin consumer',
    summary: `${command} (${consumer} stdin consumer)`,
    consequence: consumer === 'executable'
      ? 'Execute program source supplied through standard input.'
      : 'Deliver input to an unregistered standard-input consumer.',
    command,
  });
}

function classifyShellSegment(
  segmentInput: string,
  fullCommand: string,
  parsedWords?: readonly string[],
): ToolActionDescriptor[] {
  const segment = segmentInput.trim();
  const words = parsedWords ?? parseShellWords(segment);
  const head = words[0]?.toLowerCase() ?? '';
  const findAction = classifyFindAction(words);
  const values = (actionKind: AgentToolActionKind, title: string, summary: string): ToolActionDescriptor => descriptor('bash', actionKind, {
    accessScope: actionKind === 'shell.network_write' || actionKind === 'git.publish_remote' || actionKind === 'deploy.publish_remote'
      ? 'external_system'
      : 'local_system',
    title,
    summary,
    consequence: summary,
    command: fullCommand,
  });
  if (!head) return [unknownShellDescriptor(fullCommand, 'Empty shell segment.')];
  const outlineActions = classifyOutlineActions(words);
  if (outlineActions) {
    return outlineActions.map((actionKind) => values(
      actionKind,
      actionKind === 'outline.read' ? 'outline read' : actionKind === 'outline.delete' ? 'outline delete' : 'outline edit',
      segment,
    ));
  }
  if (/\bgit\s+(?:push|send-email)\b/i.test(segment) || /\bgh\s+(?:pr\s+(?:create|merge|close|reopen|comment|review)|release\s+create)\b/i.test(segment)) {
    return [values('git.publish_remote', 'remote repository write', segment)];
  }
  if (/\b(?:vercel|wrangler|firebase|fly|netlify)\s+(?:deploy|publish)\b|\bkubectl\s+(?:apply|create|delete|patch|replace|rollout)\b/i.test(segment)) {
    return [values('deploy.publish_remote', 'deployment', segment)];
  }
  if (looksLikeNetworkWrite(segment)) return [values('shell.network_write', 'network write', segment)];
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:add|install|i|remove|uninstall|update)\b|\b(?:pip|pip3)\s+install\b|\bbrew\s+(?:install|uninstall|upgrade)\b/i.test(segment)) {
    return [values('shell.dependency_install', 'dependency change', segment)];
  }
  if (/\brm\s+[^;&|]*-[^\s]*r/i.test(segment) || findAction === 'destructive') {
    return [values('shell.destructive_cleanup', 'local cleanup', segment)];
  }
  if (findAction === 'execute') {
    return [values('shell.local_code_execution', 'local code execution', segment)];
  }
  if (findAction === 'write') {
    return [values('file.edit.local_path', 'shell file edit', segment)];
  }
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run|test|build|dev|lint|check)\b/i.test(segment)) {
    return [values('shell.project_script', 'project script', segment)];
  }
  if (/\b(?:python(?:3)?|node|deno|bun|ruby|perl|php|osascript|bash|sh|zsh)\b(?:\s|$)/i.test(segment)) {
    return [values('shell.local_code_execution', 'local code execution', segment)];
  }
  if (containsShellWriteOperator(segment) || /\b(?:sed|perl|ruby)\s+-[^\s]*i\b/i.test(segment)) {
    return [values('file.edit.local_path', 'shell file edit', segment)];
  }
  if (/\b(?:ls|find|fd|rg|grep|cat|head|tail|sed|awk|wc|stat|git\s+(?:status|diff|log|show|branch))\b/i.test(segment)) {
    return [values('shell.read_search', 'local inspection', segment)];
  }
  return [unknownShellDescriptor(fullCommand, 'Unclassified shell syntax.')];
}

const OUTLINE_GLOBAL_OPTIONS_WITH_VALUE = new Set(
  OUTLINE_GLOBAL_OPTIONS.filter((option) => option.value).map((option) => `--${option.name}`),
);
const OUTLINE_GLOBAL_FLAGS = new Set(
  OUTLINE_GLOBAL_OPTIONS.filter((option) => !option.value).map((option) => `--${option.name}`),
);

export interface DirectOutlineShellInvocation {
  readonly command: OutlineCapability['name'];
  readonly args: readonly string[];
  readonly output: 'summary' | 'json';
}

export function directOutlineShellInvocation(command: string): DirectOutlineShellInvocation | null {
  const segments = splitShellSegments(command);
  if (segments.length !== 1) return null;
  return outlineShellInvocation(parseShellWords(segments[0]!));
}

function classifyOutlineActions(words: readonly string[]): readonly AgentToolActionKind[] | null {
  const invocation = outlineShellInvocation(words);
  if (!invocation) return null;
  const capability = OUTLINE_CAPABILITIES.find((entry) => entry.name === invocation.command);
  if (!capability) return null;
  if (capability.name === 'preview' || capability.kind === 'local' || capability.kind === 'read' || capability.kind === 'observe') {
    return ['outline.read'];
  }
  if (capability.name === 'apply' || capability.name === 'revert' || capability.destructive) {
    return ['outline.edit', 'outline.delete'];
  }
  return ['outline.edit'];
}

function outlineShellInvocation(words: readonly string[]): DirectOutlineShellInvocation | null {
  let index = shellExecutableIndex(words);
  const executable = words[index];
  if (!executable || path.basename(executable).toLowerCase() !== 'outline') return null;
  index += 1;
  let output: DirectOutlineShellInvocation['output'] = 'summary';
  while (index < words.length && words[index]?.startsWith('-')) {
    const option = words[index]!;
    if (option === '--') {
      index += 1;
      break;
    }
    if (OUTLINE_GLOBAL_OPTIONS_WITH_VALUE.has(option)) {
      if (words[index + 1] === undefined) return null;
      index += 2;
      continue;
    }
    if (!OUTLINE_GLOBAL_FLAGS.has(option)) return null;
    if (option === '--json') output = 'json';
    index += 1;
  }
  const capability = longestOutlineCapability(words.slice(index));
  if (!capability) return null;
  return {
    command: capability.name,
    args: words.slice(index + capability.name.split(' ').length),
    output,
  };
}

function shellExecutableIndex(words: readonly string[]): number {
  let index = 0;
  while (isShellAssignment(words[index])) index += 1;
  if (words[index]?.toLowerCase() === 'env') {
    index += 1;
    while (words[index]?.startsWith('-') || isShellAssignment(words[index])) index += 1;
  }
  if (words[index]?.toLowerCase() === 'command') {
    index += 1;
    while (words[index]?.startsWith('-')) index += 1;
  }
  return index;
}

function isShellAssignment(word: string | undefined): boolean {
  return Boolean(word && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
}

function longestOutlineCapability(words: readonly string[]): OutlineCapability | undefined {
  return OUTLINE_CAPABILITIES
    .filter((entry) => words.slice(0, entry.name.split(' ').length).join(' ') === entry.name)
    .sort((left, right) => right.name.split(' ').length - left.name.split(' ').length)[0];
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
  bashStdinConsumer?: BashStdinConsumer,
): AgentCapabilityUnavailableDecision {
  return {
    behavior: 'unavailable',
    code: 'user_blocked',
    reason,
    access,
    source: 'user_blocklist',
    descriptor: descriptorValue ?? descriptors[0],
    descriptors,
    ...(bashStdinConsumer ? { bashStdinConsumer } : {}),
  };
}

function classifyToolAccess(
  toolName: string,
  args?: unknown,
  resolvedActionKinds?: readonly AgentToolActionKind[],
): AgentCapabilityAccess {
  if (toolName === 'bash') return 'execute';
  const actionKinds = resolvedActionKinds ?? modelToolActionKinds(toolName, args);
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
  const segments: string[] = [];
  let heredocEnd: string | null = null;
  for (const line of command.split(/\r?\n/)) {
    if (heredocEnd) {
      if (line.trim() === heredocEnd) heredocEnd = null;
      continue;
    }
    const heredoc = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line);
    if (heredoc?.[1]) heredocEnd = heredoc[1];
    segments.push(...splitShellLine(line));
  }
  return segments;
}

function splitShellLine(line: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    const next = line[index + 1];
    if (quote) {
      current += char;
      if (char === '\\' && quote === '"' && next) {
        current += next;
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '#' && (index === 0 || /\s|[;&|]/.test(line[index - 1]!))) break;
    if (char === ';' || char === '|' || char === '&') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      if (next === char) index += 1;
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

const FIND_SINGLE_ARGUMENT_PREDICATES = new Set([
  '-amin', '-anewer', '-atime', '-cmin', '-cnewer', '-context', '-ctime', '-fstype',
  '-gid', '-group', '-ilname', '-iname', '-inum', '-ipath', '-iregex', '-iwholename',
  '-links', '-lname', '-maxdepth', '-mindepth', '-mmin', '-mtime', '-name', '-newer',
  '-newerat', '-newerct', '-newermt', '-path', '-perm', '-printf', '-regex', '-size',
  '-type', '-uid', '-used', '-user', '-wholename', '-xtype',
]);

function classifyFindAction(words: readonly string[]): 'destructive' | 'execute' | 'write' | null {
  const findIndex = words.findIndex((word) => /(?:^|\/)find$/i.test(word));
  if (findIndex < 0) return null;
  for (let index = findIndex + 1; index < words.length; index += 1) {
    const word = words[index]!.toLowerCase();
    if (FIND_SINGLE_ARGUMENT_PREDICATES.has(word) || /^-newer[a-z]{2}$/i.test(word)) {
      index += 1;
      continue;
    }
    if (word === '-delete') return 'destructive';
    if (word === '-exec' || word === '-execdir' || word === '-ok' || word === '-okdir') {
      return /(?:^|\/)rm$/i.test(words[index + 1] ?? '') ? 'destructive' : 'execute';
    }
    if (word === '-fls' || word === '-fprint' || word === '-fprint0' || word === '-fprintf') {
      return 'write';
    }
  }
  return null;
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

function hasOwnArg(args: unknown, name: string): boolean {
  return Boolean(args && typeof args === 'object' && !Array.isArray(args) && Object.hasOwn(args, name));
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
