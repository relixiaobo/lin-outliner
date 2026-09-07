export type DelegateOutputMode = 'text' | 'json';

export type DelegateStateCommand =
  | { readonly name: 'run'; readonly input: '-'; readonly output: DelegateOutputMode }
  | {
    readonly name: 'send';
    readonly target: { readonly kind: 'task'; readonly id: string } | { readonly kind: 'session'; readonly id: string };
    readonly input: '-';
    readonly output: DelegateOutputMode;
  }
  | { readonly name: 'close'; readonly sessionId: string; readonly output: DelegateOutputMode };

export type DelegateDiagnosticCommand =
  | { readonly name: 'doctor'; readonly runnerId?: string; readonly output: DelegateOutputMode }
  | { readonly name: 'schema'; readonly schema?: 'run' | 'message' | 'result' }
  | { readonly name: 'version' };

export type DelegateCommand = DelegateStateCommand | DelegateDiagnosticCommand;

export interface DelegateCommandDefinition {
  readonly name: DelegateCommand['name'];
  readonly usage: string;
  readonly stateChanging: boolean;
  readonly summary: string;
}

export const DELEGATE_COMMANDS: readonly DelegateCommandDefinition[] = Object.freeze([
  command('run', 'delegate run --input - [--output text|json]', true, 'Start one Agent Session and its first Turn.'),
  command('send', 'delegate send (--task TASK_ID | --session SESSION_ID) --input - [--output text|json]', true, 'Queue context or continue an owned Agent Session.'),
  command('close', 'delegate close --session SESSION_ID [--output text|json]', true, 'Close one idle owned Agent Session.'),
  command('doctor', 'delegate doctor [RUNNER_ID] [--output text|json]', false, 'Inspect Runner availability without changing policy.'),
  command('schema', 'delegate schema [run|message|result]', false, 'Print the public delegation schemas.'),
  command('version', 'delegate version', false, 'Print the delegation CLI and protocol versions.'),
]);

const TASK_ID_PATTERN = /^task_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUNNER_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export function parseDelegateCommand(args: readonly string[]): DelegateCommand {
  const name = args[0];
  if (name === 'run') return parseRun(args.slice(1));
  if (name === 'send') return parseSend(args.slice(1));
  if (name === 'close') return parseClose(args.slice(1));
  if (name === 'doctor') return parseDoctor(args.slice(1));
  if (name === 'schema') return parseSchema(args.slice(1));
  if (name === 'version') {
    if (args.length !== 1) throw usageError('delegate version accepts no arguments.');
    return { name: 'version' };
  }
  throw usageError(name ? `Unknown delegate command: ${name}` : delegateHelp());
}

export function parsePrivilegedDelegateCommand(commandSource: string): DelegateStateCommand | null {
  if (commandSource.length === 0 || commandSource.trim() !== commandSource) return null;
  const args = commandSource.split(' ');
  if (args.some((arg) => arg.length === 0) || args[0] !== 'delegate') return null;
  try {
    const parsed = parseDelegateCommand(args.slice(1));
    if (!isDelegateStateCommand(parsed)) return null;
    return canonicalDelegateCommand(parsed) === commandSource ? parsed : null;
  } catch {
    return null;
  }
}

export function canonicalDelegateArgv(command: DelegateStateCommand): readonly string[] {
  if (command.name === 'run') {
    return ['run', '--input', '-', '--output', command.output];
  }
  if (command.name === 'send') {
    return [
      'send',
      command.target.kind === 'task' ? '--task' : '--session',
      command.target.id,
      '--input',
      '-',
      '--output',
      command.output,
    ];
  }
  return ['close', '--session', command.sessionId, '--output', command.output];
}

export function canonicalDelegateCommand(command: DelegateStateCommand): string {
  return ['delegate', ...canonicalDelegateArgv(command)].join(' ');
}

export function isDelegateStateCommand(command: DelegateCommand): command is DelegateStateCommand {
  return command.name === 'run' || command.name === 'send' || command.name === 'close';
}

export function delegateHelp(): string {
  return DELEGATE_COMMANDS.map((entry) => `${entry.usage}\n  ${entry.summary}`).join('\n');
}

function parseRun(args: readonly string[]): DelegateStateCommand {
  const output = parseOptionalOutput(args, ['--input', '-']);
  return { name: 'run', input: '-', output };
}

function parseSend(args: readonly string[]): DelegateStateCommand {
  if (args.length < 4) throw usageError('delegate send requires one target and --input -.');
  const targetOption = args[0];
  const targetId = args[1];
  const target = targetOption === '--task' && isTaskId(targetId)
    ? { kind: 'task' as const, id: targetId }
    : targetOption === '--session' && isSessionId(targetId)
      ? { kind: 'session' as const, id: targetId }
      : null;
  if (!target) throw usageError('delegate send requires one canonical --task TASK_ID or --session SESSION_ID target.');
  const output = parseOptionalOutput(args.slice(2), ['--input', '-']);
  return { name: 'send', target, input: '-', output };
}

function parseClose(args: readonly string[]): DelegateStateCommand {
  if (args[0] !== '--session' || !isSessionId(args[1])) {
    throw usageError('delegate close requires one canonical --session SESSION_ID target.');
  }
  const output = parseOptionalOutput(args.slice(2), []);
  return { name: 'close', sessionId: args[1]!, output };
}

function parseDoctor(args: readonly string[]): DelegateDiagnosticCommand {
  let runnerId: string | undefined;
  let remainder = args;
  if (args[0] && !args[0].startsWith('-')) {
    if (!RUNNER_ID_PATTERN.test(args[0])) throw usageError(`Invalid Runner ID: ${args[0]}`);
    runnerId = args[0];
    remainder = args.slice(1);
  }
  const output = parseOptionalOutput(remainder, []);
  return { name: 'doctor', ...(runnerId ? { runnerId } : {}), output };
}

function parseSchema(args: readonly string[]): DelegateDiagnosticCommand {
  if (args.length === 0) return { name: 'schema' };
  const schema = args[0];
  if (args.length !== 1 || (schema !== 'run' && schema !== 'message' && schema !== 'result')) {
    throw usageError('delegate schema accepts only run, message, or result.');
  }
  return { name: 'schema', schema };
}

function parseOptionalOutput(args: readonly string[], requiredPrefix: readonly string[]): DelegateOutputMode {
  if (!requiredPrefix.every((value, index) => args[index] === value)) {
    throw usageError(`Expected ${requiredPrefix.join(' ') || 'no positional arguments'}.`);
  }
  const remainder = args.slice(requiredPrefix.length);
  if (remainder.length === 0) return 'text';
  if (remainder.length !== 2 || remainder[0] !== '--output'
    || (remainder[1] !== 'text' && remainder[1] !== 'json')) {
    throw usageError('Optional output must be --output text or --output json in canonical position.');
  }
  return remainder[1];
}

function isTaskId(value: string | undefined): value is string {
  return typeof value === 'string' && TASK_ID_PATTERN.test(value);
}

function isSessionId(value: string | undefined): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

function command(
  name: DelegateCommand['name'],
  usage: string,
  stateChanging: boolean,
  summary: string,
): DelegateCommandDefinition {
  return Object.freeze({ name, usage, stateChanging, summary });
}

function usageError(message: string): Error {
  return new Error(message);
}
