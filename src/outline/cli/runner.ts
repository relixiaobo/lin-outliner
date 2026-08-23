import { readFile } from 'node:fs/promises';
import { Value } from 'typebox/value';
import {
  OUTLINE_APP_VERSION,
  OUTLINE_CAPABILITIES,
  OUTLINE_CLI_VERSION,
  OUTLINE_EXIT_CODES,
  OUTLINE_PROTOCOL_VERSION,
  OUTLINE_PUBLIC_SCHEMAS,
  OUTLINE_STORAGE_VERSION,
  OutlineContractError,
  outlineCapability,
  outlineCapabilityManifest,
  outlineError,
  outlineExitCodeForError,
  type OutlineError,
  type OutlineResponse,
} from '../contract';
import { canonicalSha256 } from '../contract/canonical';
import { OutlineClientSupervisor, resolveOutlineRuntimeRoot } from '../client';

export interface OutlineCliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly readStdin: () => Promise<string>;
}

export interface OutlineCliRunOptions {
  readonly io?: Partial<OutlineCliIo>;
  readonly runtimeRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface ParsedInvocation {
  readonly json: boolean;
  readonly noStart: boolean;
  readonly startupTimeoutMs: number | undefined;
  readonly command: string;
  readonly args: readonly string[];
}

const defaultIo: OutlineCliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  },
};

export async function runOutlineCli(argv: readonly string[], options: OutlineCliRunOptions = {}): Promise<number> {
  const io = { ...defaultIo, ...options.io };
  let invocation: ParsedInvocation | undefined;
  const jsonRequested = argv.includes('--json');
  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      io.stdout(renderHelp(argv));
      return OUTLINE_EXIT_CODES.success;
    }
    invocation = parseInvocation(argv);
    const data = await executeInvocation(invocation, options, io);
    writeSuccess(io, invocation, data);
    return OUTLINE_EXIT_CODES.success;
  } catch (error) {
    const publicError = toPublicError(error);
    writeFailure(io, invocation ?? (jsonRequested ? failedJsonInvocation() : undefined), publicError);
    return outlineExitCodeForError(publicError);
  }
}

function failedJsonInvocation(): ParsedInvocation {
  return {
    json: true,
    noStart: false,
    startupTimeoutMs: undefined,
    command: 'unknown',
    args: [],
  };
}

async function executeInvocation(
  invocation: ParsedInvocation,
  options: OutlineCliRunOptions,
  io: OutlineCliIo,
): Promise<unknown> {
  if (invocation.command === 'version') {
    assertNoArgs(invocation);
    return {
      cliVersion: OUTLINE_CLI_VERSION,
      appVersion: OUTLINE_APP_VERSION,
      protocolMajors: [OUTLINE_PROTOCOL_VERSION],
      storageVersion: OUTLINE_STORAGE_VERSION,
    };
  }

  const runtimeRoot = options.runtimeRoot ?? resolveOutlineRuntimeRoot({ env: options.env });
  const supervisor = new OutlineClientSupervisor({
    root: runtimeRoot,
    noStart: invocation.noStart,
    startupTimeoutMs: invocation.startupTimeoutMs,
  });
  if (invocation.command === 'status') {
    assertNoArgs(invocation);
    return supervisor.status();
  }
  if (invocation.command === 'schema') {
    return schemaResult(invocation.args);
  }
  if (invocation.command === 'capabilities') {
    const runtime = takeFlag(invocation.args, '--runtime');
    if (runtime.rest.length > 0) throw usageError(`Unexpected capabilities argument: ${runtime.rest[0]}`);
    const bundled = outlineCapabilityManifest();
    if (!runtime.present) return bundled;
    const client = await supervisor.connect();
    try {
      const response = await client.request('capabilities', { runtime: true });
      if (canonicalSha256(response.data) !== canonicalSha256(bundled)) {
        throw new OutlineContractError(outlineError(
          'protocol_incompatible',
          'protocol',
          'Bundled CLI capabilities do not match the connected Outline Runtime.',
        ));
      }
      return bundled;
    } finally {
      client.close();
    }
  }

  const capability = outlineCapability(invocation.command);
  if (!capability) throw usageError(`Unknown outline command: ${invocation.command}`);
  if (!capability.runtimeRequired) throw usageError(`Unsupported local outline command: ${invocation.command}`);
  if (capability.streaming) {
    throw usageError(`Streaming command is not available through the non-stream runner yet: ${invocation.command}`);
  }
  const input = await runtimeInput(invocation, io);
  if (!Value.Check(capability.requestSchema, input)) {
    throw usageError(`Input does not match the public schema for command: ${invocation.command}`);
  }
  const client = await supervisor.connect();
  try {
    return (await client.request(invocation.command, input)).data;
  } finally {
    client.close();
  }
}

function parseInvocation(argv: readonly string[]): ParsedInvocation {
  let json = false;
  let noStart = false;
  let startupTimeoutMs: number | undefined;
  let protocol: number = OUTLINE_PROTOCOL_VERSION;
  let index = 0;
  while (index < argv.length && argv[index]?.startsWith('-')) {
    const arg = argv[index];
    if (arg === '--json') json = true;
    else if (arg === '--no-start') noStart = true;
    else if (arg === '--protocol') protocol = positiveInteger(argv[++index], '--protocol');
    else if (arg === '--startup-timeout') startupTimeoutMs = positiveInteger(argv[++index], '--startup-timeout');
    else throw usageError(`Unknown global option: ${arg}`);
    index += 1;
  }
  if (protocol !== OUTLINE_PROTOCOL_VERSION) {
    throw new OutlineContractError(outlineError(
      'protocol_incompatible',
      'protocol',
      `Unsupported outline protocol major: ${protocol}`,
    ));
  }
  const remaining = argv.slice(index);
  if (remaining.length === 0) throw usageError('An outline command is required.');
  const command = longestCommandPrefix(remaining);
  if (!command) throw usageError(`Unknown outline command: ${remaining[0]}`);
  return {
    json,
    noStart,
    startupTimeoutMs,
    command,
    args: remaining.slice(command.split(' ').length),
  };
}

async function runtimeInput(invocation: ParsedInvocation, io: OutlineCliIo): Promise<unknown> {
  if (invocation.command === 'log') return parseLogInput(invocation.args);
  if (invocation.command === 'revert') {
    const preview = takeFlag(invocation.args, '--preview');
    if (preview.rest.length !== 1) throw usageError('revert requires exactly one Operation ID.');
    return { operationId: preview.rest[0], ...(preview.present ? { preview: true } : {}) };
  }
  if (invocation.command === 'undo' || invocation.command === 'redo') {
    const preview = takeFlag(invocation.args, '--preview');
    if (preview.rest.length > 0) throw usageError(`${invocation.command} does not accept positional arguments.`);
    return preview.present ? { preview: true } : {};
  }
  const parsed = parseInputOptions(invocation.args);
  if (!parsed.input) throw usageError(`${invocation.command} requires --input FILE|-.`);
  if (parsed.rest.length > 0) throw usageError(`Unexpected ${invocation.command} argument: ${parsed.rest[0]}`);
  const value = parseJsonInput(parsed.input === '-' ? await io.readStdin() : await readFile(parsed.input, 'utf8'));
  if (invocation.command === 'diff') return { changeSet: value };
  if (invocation.command === 'apply') {
    return { diff: value, ...(parsed.yes ? { acknowledgeDestructive: true } : {}) };
  }
  return value;
}

function parseLogInput(args: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--limit') result.limit = positiveInteger(args[++index], '--limit');
    else if (arg === '--cursor') result.cursor = requiredValue(args[++index], '--cursor');
    else if (arg === '--operation') result.operationId = requiredValue(args[++index], '--operation');
    else if (arg === '--node') result.nodeId = requiredValue(args[++index], '--node');
    else if (arg === '--origin') result.origin = requiredValue(args[++index], '--origin');
    else throw usageError(`Unknown log option: ${arg}`);
  }
  return result;
}

function parseInputOptions(args: readonly string[]): { input?: string; yes: boolean; rest: readonly string[] } {
  let input: string | undefined;
  let yes = false;
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--input') input = requiredValue(args[++index], '--input');
    else if (arg === '--input-format') {
      const format = requiredValue(args[++index], '--input-format');
      if (format !== 'json') throw usageError('Only --input-format json is available for this command.');
    } else if (arg === '--yes') yes = true;
    else rest.push(arg ?? '');
  }
  return { input, yes, rest };
}

function schemaResult(args: readonly string[]): unknown {
  const name = args.join(' ');
  if (!name) return OUTLINE_PUBLIC_SCHEMAS;
  if (Object.hasOwn(OUTLINE_PUBLIC_SCHEMAS, name)) {
    return OUTLINE_PUBLIC_SCHEMAS[name as keyof typeof OUTLINE_PUBLIC_SCHEMAS];
  }
  const capability = outlineCapability(name);
  if (capability) return { request: capability.requestSchema, result: capability.resultSchema };
  throw usageError(`Unknown public schema or command: ${name}`);
}

function longestCommandPrefix(args: readonly string[]): string | undefined {
  return OUTLINE_CAPABILITIES
    .map((entry) => entry.name)
    .filter((name) => args.slice(0, name.split(' ').length).join(' ') === name)
    .sort((left, right) => right.split(' ').length - left.split(' ').length)[0];
}

function writeSuccess(io: OutlineCliIo, invocation: ParsedInvocation, data: unknown): void {
  if (invocation.json) {
    const response = {
      protocolVersion: OUTLINE_PROTOCOL_VERSION,
      requestId: `cli:${crypto.randomUUID()}`,
      ok: true,
      command: invocation.command,
      data,
    } as OutlineResponse;
    io.stdout(`${JSON.stringify(response)}\n`);
    return;
  }
  if (invocation.command === 'version' && isRecord(data)) {
    io.stdout(`outline ${String(data.cliVersion)} (Tenon ${String(data.appVersion)}; protocol ${OUTLINE_PROTOCOL_VERSION})\n`);
    return;
  }
  if (invocation.command === 'status' && isRecord(data) && data.running === false) {
    io.stdout('Outline Runtime: not running\n');
    return;
  }
  if (invocation.command === 'capabilities' && Array.isArray(data)) {
    io.stdout(`${data.map((entry) => isRecord(entry) ? `${String(entry.name)}\t${String(entry.summary)}` : String(entry)).join('\n')}\n`);
    return;
  }
  io.stdout(`${JSON.stringify(data, null, 2)}\n`);
}

function writeFailure(io: OutlineCliIo, invocation: ParsedInvocation | undefined, error: OutlineError): void {
  if (invocation?.json) {
    const response = {
      protocolVersion: OUTLINE_PROTOCOL_VERSION,
      requestId: `cli:${crypto.randomUUID()}`,
      ok: false,
      command: invocation.command,
      error,
    } as OutlineResponse;
    io.stdout(`${JSON.stringify(response)}\n`);
    return;
  }
  io.stderr(`outline: ${error.message}\n`);
}

function renderHelp(argv: readonly string[]): string {
  const nonOption = argv.filter((arg) => !arg.startsWith('-'));
  if (nonOption.length > 0) {
    const command = longestCommandPrefix(nonOption);
    const capability = command ? outlineCapability(command) : undefined;
    if (!capability) return 'Usage: outline [GLOBAL OPTIONS] COMMAND [ARGS]\n';
    return `Usage: outline [GLOBAL OPTIONS] ${capability.name} [ARGS]\n\n${capability.summary}\n`;
  }
  return [
    'Usage: outline [--json] [--protocol 1] [--no-start] [--startup-timeout MS] COMMAND [ARGS]',
    '',
    'Commands:',
    ...OUTLINE_CAPABILITIES.map((entry) => `  ${entry.name.padEnd(22)} ${entry.summary}`),
    '',
  ].join('\n');
}

function parseJsonInput(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw usageError(`Input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function takeFlag(args: readonly string[], flag: string): { present: boolean; rest: readonly string[] } {
  return { present: args.includes(flag), rest: args.filter((arg) => arg !== flag) };
}

function positiveInteger(value: string | undefined, option: string): number {
  if (!value || !/^\d+$/.test(value)) throw usageError(`${option} requires a positive integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw usageError(`${option} requires a positive integer.`);
  return number;
}

function requiredValue(value: string | undefined, option: string): string {
  if (!value || value.startsWith('--')) throw usageError(`${option} requires a value.`);
  return value;
}

function assertNoArgs(invocation: ParsedInvocation): void {
  if (invocation.args.length > 0) throw usageError(`Unexpected ${invocation.command} argument: ${invocation.args[0]}`);
}

function usageError(message: string): OutlineContractError {
  return new OutlineContractError(outlineError('invalid_input', 'usage', message));
}

function toPublicError(error: unknown): OutlineError {
  if (error instanceof OutlineContractError) return error.outlineError;
  return outlineError(
    'internal_error',
    'internal',
    'The outline command could not be completed.',
    { details: error instanceof Error ? error.message : String(error) },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
