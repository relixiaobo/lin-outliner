import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Value } from 'typebox/value';
import {
  OUTLINE_APP_VERSION,
  OUTLINE_CAPABILITIES,
  OUTLINE_CLI_VERSION,
  OUTLINE_COMMAND_FAMILIES,
  OUTLINE_EXIT_CODES,
  OUTLINE_GLOBAL_OPTIONS,
  OUTLINE_PROTOCOL_VERSION,
  OUTLINE_PUBLIC_SCHEMAS,
  OUTLINE_STORAGE_VERSION,
  DiffSchema,
  OutlineContractError,
  outlineCapability,
  outlineCapabilityManifest,
  outlineError,
  outlineExitCodeForError,
  porcelainHelpOptions,
  type CommandOptionHelp,
  type OutlineError,
  type OutlineResponse,
} from '../contract';
import { canonicalSha256 } from '../contract/canonical';
import { OutlineClientSupervisor, resolveOutlineRuntimeRoot } from '../client';
import { OUTLINE_AGENT_ATTESTATION_ENV } from '../contract/agentAttestation';
import {
  parseReadCommand,
  parseWatchCommand,
} from './arguments';
import { buildPorcelainRequest } from './porcelain';

const MAX_INLINE_DIFF_BYTES = 8 * 1024 * 1024;

export interface OutlineCliIo {
  readonly stdout: (value: string) => void;
  readonly stdoutBytes: (value: Uint8Array) => void;
  readonly stderr: (value: string) => void;
  readonly readStdin: () => Promise<string>;
  readonly stdinBytes: () => AsyncIterable<Uint8Array>;
  readonly interactive: boolean;
  readonly confirm: (prompt: string) => Promise<boolean>;
}

export interface OutlineCliRunOptions {
  readonly io?: Partial<OutlineCliIo>;
  readonly runtimeRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}

interface HandledExecution {
  readonly handled: true;
  readonly exitCode: number;
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
  stdoutBytes: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  },
  stdinBytes: () => process.stdin,
  interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
  confirm: async (prompt) => {
    const readline = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await readline.question(`${prompt} [y/N] `);
      return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
    } finally {
      readline.close();
    }
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
    if (isHandledExecution(data)) return data.exitCode;
    writeSuccess(io, invocation, data);
    return OUTLINE_EXIT_CODES.success;
  } catch (error) {
    const publicError = withUsageGuidance(toPublicError(error), invocation);
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
): Promise<unknown | HandledExecution> {
  const capability = outlineCapability(invocation.command);
  if (!capability) throw usageError(unknownCommandMessage([invocation.command]));
  validateRegisteredOptions(invocation, capability.help.options, capability.porcelain);
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
  const environment = options.env ?? process.env;
  const agentAttestation = environment[OUTLINE_AGENT_ATTESTATION_ENV];
  const supervisor = new OutlineClientSupervisor({
    root: runtimeRoot,
    noStart: invocation.noStart,
    startupTimeoutMs: invocation.startupTimeoutMs,
    origin: agentAttestation ? 'built-in-agent' : 'local-user',
    ...(agentAttestation ? { agentAttestation } : {}),
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

  if (!capability.runtimeRequired) throw usageError(`Unsupported local outline command: ${invocation.command}`);
  if (invocation.command === 'diff') return executeDiffInvocation(invocation, supervisor, io, options.signal);
  if (invocation.command === 'asset ingest') return executeAssetIngest(invocation, supervisor, io, options.signal);
  if (invocation.command === 'asset export') return executeAssetExport(invocation, supervisor, io, options.signal);
  if (capability.streaming) return executeStreamingInvocation(invocation, supervisor, io, options.signal);
  const input = await runtimeInput(invocation, io, supervisor);
  if (!Value.Check(capability.requestSchema, input)) {
    throw usageError(`Input does not match the public schema for command: ${invocation.command}`);
  }
  const client = await supervisor.connect();
  try {
    if (capability.destructive
      && capability.kind === 'mutate'
      && !invocation.json
      && io.interactive
      && isRecord(input)
      && input.preview !== true
      && input.acknowledgeDestructive !== true) {
      return executeInteractiveDestructive(invocation.command, input, client, io);
    }
    const data = (await client.request(invocation.command, input)).data;
    return data;
  } finally {
    client.close();
  }
}

async function executeInteractiveDestructive(
  command: string,
  input: Record<string, unknown>,
  client: import('../client').OutlineClient,
  io: OutlineCliIo,
): Promise<unknown> {
  const preview = (await client.request(command, {
    ...input,
    preview: true,
    acknowledgeDestructive: undefined,
  })).data;
  if (!Value.Check(DiffSchema, preview)) {
    throw artifactProtocolError('Outline Runtime returned an invalid destructive Diff preview.');
  }
  if (typeof input.expectDiff === 'string' && input.expectDiff !== preview.diffHash) {
    throw new OutlineContractError(outlineError(
      'diff_mismatch',
      'conflict',
      'The current normalized Diff does not match --expect-diff.',
      { details: { expected: input.expectDiff, actual: preview.diffHash } },
    ));
  }
  io.stdout(`Review Diff:\n${JSON.stringify(preview, null, 2)}\n`);
  if (!await io.confirm(`Apply destructive ${command} Diff ${preview.diffHash}?`)) {
    throw new OutlineContractError(outlineError(
      'confirmation_required',
      'confirmation',
      'The destructive Diff was not confirmed.',
    ));
  }
  return (await client.request('apply', { diff: preview, acknowledgeDestructive: true })).data;
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
  if (!command) throw usageError(unknownCommandMessage(remaining));
  return {
    json,
    noStart,
    startupTimeoutMs,
    command,
    args: remaining.slice(command.split(' ').length),
  };
}

async function runtimeInput(
  invocation: ParsedInvocation,
  io: OutlineCliIo,
  supervisor: OutlineClientSupervisor,
): Promise<unknown> {
  if (invocation.command === 'find' || invocation.command === 'show') {
    return (await parseReadCommand(invocation.command, invocation.args, (source) => readStructuredSource(source, io))).input;
  }
  if (invocation.command === 'asset show') {
    if (invocation.args.length !== 1) throw usageError('asset show requires exactly one AssetRecord ID.');
    return { assetId: invocation.args[0] };
  }
  if (invocation.command === 'log') return parseLogInput(invocation.args);
  if (invocation.command === 'revert') {
    if (invocation.args.length !== 1) throw usageError('revert requires exactly one Operation ID.');
    return { operationId: invocation.args[0] };
  }
  if (invocation.command === 'undo' || invocation.command === 'redo') {
    if (invocation.args.length > 0) throw usageError(`${invocation.command} does not accept arguments.`);
    return {};
  }
  if (invocation.command !== 'apply') {
    return buildPorcelainRequest(invocation.command, invocation.args, {
      read: (source) => readStructuredSource(source, io),
      lookup: async (selector) => {
        const client = await supervisor.connect();
        try {
          const response = await client.request('show', { selector });
          const data = response.data as { nodes?: unknown[] };
          const node = data.nodes?.[0];
          if (!isRecord(node)) throw usageError('Porcelain target did not resolve to one Node.');
          return node;
        } finally {
          client.close();
        }
      },
      ingestAsset: async (source) => {
        const client = await supervisor.connect();
        try {
          if (source === '-') return client.ingestAsset(io.stdinBytes());
          return (await client.request('asset ingest', { source: 'path', path: source })).data as import('../contract').AssetLease;
        } finally {
          client.close();
        }
      },
    });
  }
  const parsed = parseInputOptions(invocation.args);
  if (!parsed.input) throw usageError(`${invocation.command} requires --input FILE|-.`);
  if (parsed.rest.length > 0) throw usageError(`Unexpected ${invocation.command} argument: ${parsed.rest[0]}`);
  const raw = parsed.input === '-' ? await io.readStdin() : await readFile(parsed.input, 'utf8');
  const value = parseJsonInput(raw);
  if (parsed.inputFormat !== 'json') throw usageError('apply accepts only --input-format json.');
  if (parsed.output) throw usageError('--output is only valid for diff.');
  if (parsed.idempotencyKey) throw usageError('apply cannot change the idempotency key bound into its Diff.');
  return { diff: value, ...(parsed.yes ? { acknowledgeDestructive: true } : {}) };
}

async function executeDiffInvocation(
  invocation: ParsedInvocation,
  supervisor: OutlineClientSupervisor,
  io: OutlineCliIo,
  signal?: AbortSignal,
): Promise<unknown | HandledExecution> {
  const parsed = parseInputOptions(invocation.args);
  if (!parsed.input) throw usageError('diff requires --input FILE|-.');
  if (parsed.yes) throw usageError('--yes is not valid for diff.');
  if (parsed.rest.length > 0) throw usageError(`Unexpected diff argument: ${parsed.rest[0]}`);
  const source = parsed.input === '-' ? io.stdinBytes() : createReadStream(parsed.input);
  const client = await supervisor.connect();
  try {
    const artifact = await client.diffArtifact(source, {
      inputFormat: parsed.inputFormat,
      ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
      signal,
    });
    if (!parsed.output && artifact.byteCount > MAX_INLINE_DIFF_BYTES) {
      throw usageError('Diff exceeds 8 MiB; specify --output DIFF_FILE or --output -.');
    }
    if (parsed.output === '-') {
      for await (const chunk of artifact.chunks) io.stdoutBytes(chunk);
      io.stdoutBytes(Buffer.from('\n'));
      return { handled: true, exitCode: OUTLINE_EXIT_CODES.success };
    }
    if (parsed.output) {
      await writeAtomicArtifact(parsed.output, artifact.chunks);
      return { path: parsed.output, byteCount: artifact.byteCount, sha256: artifact.sha256 };
    }
    const chunks: Buffer[] = [];
    for await (const chunk of artifact.chunks) chunks.push(Buffer.from(chunk));
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw artifactProtocolError('Outline Runtime returned an invalid Diff artifact.');
    }
    if (!Value.Check(DiffSchema, value)) {
      throw artifactProtocolError('Outline Runtime returned a Diff artifact that violates the public schema.');
    }
    return value;
  } finally {
    client.close();
  }
}

async function executeAssetIngest(
  invocation: ParsedInvocation,
  supervisor: OutlineClientSupervisor,
  io: OutlineCliIo,
  signal?: AbortSignal,
): Promise<unknown> {
  if (invocation.args.length !== 1) throw usageError('asset ingest requires exactly one PATH or -.');
  const source = invocation.args[0]!;
  const client = await supervisor.connect();
  try {
    if (source === '-') return client.ingestAsset(io.stdinBytes(), { signal });
    return (await client.request('asset ingest', { source: 'path', path: source })).data;
  } finally {
    client.close();
  }
}

async function executeAssetExport(
  invocation: ParsedInvocation,
  supervisor: OutlineClientSupervisor,
  io: OutlineCliIo,
  signal?: AbortSignal,
): Promise<unknown | HandledExecution> {
  let assetId: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < invocation.args.length; index += 1) {
    const arg = invocation.args[index]!;
    if (arg === '--output') output = requiredValue(invocation.args[++index], '--output');
    else if (!assetId) assetId = arg;
    else throw usageError(`Unexpected asset export argument: ${arg}`);
  }
  if (!assetId) throw usageError('asset export requires exactly one AssetRecord ID.');
  if (!output) throw usageError('asset export requires --output FILE|-.');
  const client = await supervisor.connect();
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryPath: string | undefined;
  let bytes = 0;
  const digest = createHash('sha256');
  try {
    if (output !== '-') {
      temporaryPath = `${output}.outline-${crypto.randomUUID()}.tmp`;
      file = await open(temporaryPath, 'wx', 0o600);
    }
    for await (const chunk of client.exportAsset(assetId, signal)) {
      bytes += chunk.byteLength;
      digest.update(chunk);
      if (file) await file.write(chunk);
      else io.stdoutBytes(chunk);
    }
    if (!file) return { handled: true, exitCode: OUTLINE_EXIT_CODES.success };
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath!, output);
    temporaryPath = undefined;
    return { path: output, byteCount: bytes, sha256: digest.digest('hex') };
  } finally {
    client.close();
    if (file) await file.close().catch(() => undefined);
    if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function parseLogInput(args: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--limit') result.limit = positiveInteger(args[++index], '--limit');
    else if (arg === '--cursor') result.cursor = requiredValue(args[++index], '--cursor');
    else if (arg === '--operation') result.operationId = requiredValue(args[++index], '--operation');
    else if (arg === '--idempotency-key') result.idempotencyKey = requiredValue(args[++index], '--idempotency-key');
    else if (arg === '--node') result.nodeId = requiredValue(args[++index], '--node');
    else if (arg === '--origin') result.origin = requiredValue(args[++index], '--origin');
    else if (arg === '--thread') result.threadId = requiredValue(args[++index], '--thread');
    else if (arg === '--turn') result.turnId = requiredValue(args[++index], '--turn');
    else if (arg === '--item') result.itemId = requiredValue(args[++index], '--item');
    else throw usageError(`Unknown log option: ${arg}`);
  }
  return result;
}

function parseInputOptions(args: readonly string[]): {
  input?: string;
  inputFormat: 'json' | 'jsonl';
  output?: string;
  idempotencyKey?: string;
  yes: boolean;
  rest: readonly string[];
} {
  let input: string | undefined;
  let inputFormat: 'json' | 'jsonl' = 'json';
  let output: string | undefined;
  let idempotencyKey: string | undefined;
  let yes = false;
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--input') input = requiredValue(args[++index], '--input');
    else if (arg === '--input-format') {
      const format = requiredValue(args[++index], '--input-format');
      if (format !== 'json' && format !== 'jsonl') throw usageError('--input-format must be json or jsonl.');
      inputFormat = format;
    } else if (arg === '--output') output = requiredValue(args[++index], '--output');
    else if (arg === '--idempotency-key') idempotencyKey = requiredValue(args[++index], '--idempotency-key');
    else if (arg === '--yes') yes = true;
    else rest.push(arg ?? '');
  }
  return { input, inputFormat, output, idempotencyKey, yes, rest };
}

async function executeStreamingInvocation(
  invocation: ParsedInvocation,
  supervisor: OutlineClientSupervisor,
  io: OutlineCliIo,
  signal?: AbortSignal,
): Promise<unknown | HandledExecution> {
  const parsed = invocation.command === 'watch'
    ? { input: await parseWatchCommand(invocation.args, (source) => readStructuredSource(source, io)) }
    : await parseReadCommand('export', invocation.args, (source) => readStructuredSource(source, io));
  const capability = outlineCapability(invocation.command)!;
  if (!Value.Check(capability.requestSchema, parsed.input)) {
    throw usageError(`Input does not match the public schema for command: ${invocation.command}`);
  }
  const client = await supervisor.connect();
  const output = 'output' in parsed ? parsed.output : undefined;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryPath: string | undefined;
  let bytes = 0;
  const digest = createHash('sha256');
  try {
    if (output && output !== '-') {
      temporaryPath = `${output}.outline-${crypto.randomUUID()}.tmp`;
      file = await open(temporaryPath, 'wx', 0o600);
    }
    let streamError: OutlineError | undefined;
    for await (const record of client.stream(invocation.command, parsed.input, signal)) {
      if (record.type === 'error') streamError = record.error;
      if (file) {
        if (record.type !== 'data') continue;
        const chunk = exportDataChunk(record.data, parsed.input);
        await file.write(chunk);
        digest.update(chunk);
        bytes += Buffer.byteLength(chunk);
      } else if (output === '-') {
        if (record.type === 'data') io.stdout(exportDataChunk(record.data, parsed.input));
      } else if (invocation.json) {
        io.stdout(`${JSON.stringify(record)}\n`);
      } else {
        writeHumanStreamRecord(io, record);
      }
    }
    if (streamError) {
      if (file) {
        await file.close();
        file = undefined;
        await rm(temporaryPath!, { force: true });
      }
      if (!invocation.json && output !== '-') io.stderr(`outline: ${streamError.message}\n`);
      return { handled: true, exitCode: outlineExitCodeForError(streamError) };
    }
    if (file && temporaryPath && output) {
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporaryPath, output);
      return { path: output, byteCount: bytes, sha256: digest.digest('hex') };
    }
    return { handled: true, exitCode: OUTLINE_EXIT_CODES.success };
  } catch (error) {
    if (signal?.aborted) return { handled: true, exitCode: OUTLINE_EXIT_CODES.interrupted };
    throw error;
  } finally {
    client.close();
    if (file) await file.close().catch(() => undefined);
    if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function writeAtomicArtifact(target: string, chunks: AsyncIterable<Uint8Array>): Promise<void> {
  const temporary = `${target}.outline-${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    for await (const chunk of chunks) await handle.write(chunk);
    await handle.write(Buffer.from('\n'));
    await handle.sync();
    await handle.close();
    await rename(temporary, target);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function artifactProtocolError(message: string): OutlineContractError {
  return new OutlineContractError(outlineError('protocol_incompatible', 'protocol', message));
}

async function readStructuredSource(source: string, io: OutlineCliIo): Promise<string> {
  if (source === '-') return io.readStdin();
  const trimmed = source.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('@')
    || /^[A-Za-z][A-Za-z0-9_-]*:/.test(trimmed)) {
    return source;
  }
  return readFile(source, 'utf8');
}

function exportDataChunk(data: unknown, input: unknown): string {
  const format = isRecord(input) && isRecord(input.projection) && typeof input.projection.format === 'string'
    ? input.projection.format
    : 'json';
  if ((format === 'markdown' || format === 'opml') && typeof data === 'string') return data;
  return `${JSON.stringify(data)}\n`;
}

function writeHumanStreamRecord(
  io: OutlineCliIo,
  record: import('../contract').OutlineStreamRecord,
): void {
  if (record.type === 'data') {
    io.stdout(typeof record.data === 'string' ? record.data : `${JSON.stringify(record.data)}\n`);
  } else if (record.type === 'event') {
    io.stdout(`${JSON.stringify(record.event)}\n`);
  } else if (record.type === 'error') {
    io.stderr(`outline: ${record.error.message}\n`);
  }
}

function isHandledExecution(value: unknown): value is HandledExecution {
  return isRecord(value) && value.handled === true && typeof value.exitCode === 'number';
}

function schemaResult(args: readonly string[]): unknown {
  const name = args.join(' ');
  if (!name) return OUTLINE_PUBLIC_SCHEMAS;
  if (Object.hasOwn(OUTLINE_PUBLIC_SCHEMAS, name)) {
    return OUTLINE_PUBLIC_SCHEMAS[name as keyof typeof OUTLINE_PUBLIC_SCHEMAS];
  }
  const capability = outlineCapability(name);
  if (capability) return {
    request: capability.porcelain?.inputSchema ?? capability.requestSchema,
    result: capability.resultSchema,
  };
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
  for (const next of error.next ?? []) io.stderr(`  ${next}\n`);
}

function renderHelp(argv: readonly string[]): string {
  const path = helpCommandPath(argv);
  if (path.length > 0) {
    const command = longestCommandPrefix(path);
    if (command) return renderCommandHelp(outlineCapability(command)!);
    const family = path.join(' ');
    if (isCommandFamily(family)) return renderFamilyHelp(family);
    throw usageError(unknownCommandMessage(path));
  }
  const topLevelFamilies = OUTLINE_COMMAND_FAMILIES.filter((family) => !family.name.includes(' '));
  const direct = OUTLINE_CAPABILITIES.filter((entry) => !entry.name.includes(' '));
  return [
    'Usage: outline [GLOBAL OPTIONS] COMMAND [ARGS]',
    '',
    'Operate the Tenon document through one stable, schema-discoverable CLI.',
    '',
    'Global options:',
    ...OUTLINE_GLOBAL_OPTIONS.map(renderOption),
    '  -h, --help\n      Show root, family, or exact command help without starting Runtime.',
    '',
    'Command families:',
    ...topLevelFamilies.map((family) => `  ${family.name.padEnd(14)} ${family.summary}`),
    '',
    'Direct commands:',
    ...direct.map((entry) => `  ${entry.name.padEnd(14)} ${entry.summary}`),
    '',
    'Run "outline FAMILY --help" for subcommands or "outline COMMAND --help" for the exact contract.',
    '',
  ].join('\n');
}

function renderFamilyHelp(family: string): string {
  const metadata = OUTLINE_COMMAND_FAMILIES.find((entry) => entry.name === family)!;
  const prefix = `${family} `;
  const commands = OUTLINE_CAPABILITIES
    .filter((entry) => entry.name.startsWith(prefix))
    .sort((left, right) => left.name.localeCompare(right.name));
  return [
    `Usage: outline [GLOBAL OPTIONS] ${family} SUBCOMMAND [ARGS]`,
    '',
    metadata.summary,
    '',
    'Subcommands:',
    ...commands.map((entry) => `  ${entry.name.slice(prefix.length).padEnd(18)} ${entry.summary}`),
    '',
    `Run "outline ${family} SUBCOMMAND --help" for exact syntax, options, schemas, and examples.`,
    '',
  ].join('\n');
}

function renderCommandHelp(capability: import('../contract').OutlineCapability): string {
  const help = capability.help;
  const options = capability.porcelain ? porcelainHelpOptions(capability.porcelain) : help.options;
  return [
    `Usage: outline [GLOBAL OPTIONS] ${help.usage}`,
    '',
    help.summary,
    '',
    `Behavior: ${help.behavior}; ${help.idempotent ? 'idempotent (repeated settled execution converges or is a semantic no-op)' : 'not idempotent (repeated execution may create or change additional state)'}.`,
    '',
    'Positionals:',
    ...(help.positionals.length > 0 ? help.positionals.map((entry) => `  ${entry}`) : ['  None.']),
    '',
    'Options:',
    ...(options.length > 0 ? options.map(renderOption) : ['  None.']),
    '',
    'Selectors:',
    `  ${help.selectors}`,
    'Cardinality:',
    `  ${help.cardinality}`,
    '',
    'Input:',
    `  ${help.input}`,
    'Output:',
    `  ${help.output}`,
    '',
    'Defaults:',
    ...(help.defaults.length > 0 ? help.defaults.map((entry) => `  ${entry}`) : ['  No command-specific defaults.']),
    ...(help.destructive ? [
      '',
      'Destructive review:',
      '  1. Run the same command with --preview and inspect the returned Diff.',
      '  2. Re-run it with --expect-diff SHA256 --yes to apply only that exact Diff.',
      '  --yes alone is rejected and never substitutes for preview/review.',
    ] : []),
    '',
    'Structured schema:',
    `  outline schema ${capability.name}`,
    '',
    'Examples:',
    ...help.examples.map((example) => `  ${example}`),
    '',
  ].join('\n');
}

function renderOption(entry: CommandOptionHelp): string {
  const suffix = [
    entry.default ? `default: ${entry.default}` : undefined,
    entry.repeatable ? 'repeatable' : undefined,
  ].filter(Boolean).join('; ');
  return `  --${entry.name}${entry.value ? ` ${entry.value}` : ''}\n      ${entry.description}${suffix ? ` (${suffix})` : ''}`;
}

function helpCommandPath(argv: readonly string[]): string[] {
  const global = new Map(OUTLINE_GLOBAL_OPTIONS.map((entry) => [entry.name, entry]));
  const path: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') continue;
    if (arg.startsWith('--')) {
      const metadata = global.get(arg.slice(2));
      if (metadata) {
        if (metadata.value) index += 1;
        continue;
      }
      break;
    }
    path.push(arg);
  }
  return path;
}

function isCommandFamily(value: string): boolean {
  return OUTLINE_COMMAND_FAMILIES.some((entry) => entry.name === value);
}

function validateRegisteredOptions(
  invocation: ParsedInvocation,
  fixedOptions: readonly CommandOptionHelp[],
  porcelain: import('../contract').PorcelainContract | undefined,
): void {
  const options = porcelain ? porcelainHelpOptions(porcelain) : fixedOptions;
  const names = new Set(options.map((entry) => entry.name));
  for (const arg of invocation.args) {
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    if (names.has(name)) continue;
    const nearest = nearestValue(name, [...names]);
    throw usageError([
      `Unknown option for ${invocation.command}: --${name}.`,
      ...(nearest ? [`Did you mean --${nearest}?`] : []),
    ].join(' '));
  }
}

function unknownCommandMessage(args: readonly string[]): string {
  const attempted = args.filter((arg) => !arg.startsWith('-')).join(' ') || String(args[0] ?? '');
  const candidates = [
    ...OUTLINE_CAPABILITIES.map((entry) => entry.name),
    ...OUTLINE_COMMAND_FAMILIES.map((entry) => entry.name),
  ];
  const nearest = nearestValue(attempted, candidates);
  return [
    `Unknown outline command or family: ${attempted || '(missing)'}.`,
    ...(nearest ? [`Did you mean "${nearest}"? Run "outline ${nearest} --help".`] : ['Run "outline --help" for valid commands.']),
  ].join(' ');
}

function nearestValue(value: string, candidates: readonly string[]): string | undefined {
  if (!value || candidates.length === 0) return undefined;
  return [...candidates].sort((left, right) => {
    const distance = editDistance(value, left) - editDistance(value, right);
    return distance === 0 ? left.localeCompare(right) : distance;
  })[0];
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function withUsageGuidance(error: OutlineError, invocation: ParsedInvocation | undefined): OutlineError {
  if (error.category !== 'usage') return error;
  const next = invocation
    ? `Run "outline ${invocation.command} --help" for the exact syntax and examples.`
    : 'Run "outline --help" for valid command families and commands.';
  if (error.next?.includes(next)) return error;
  return { ...error, next: [...(error.next ?? []), next] };
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
