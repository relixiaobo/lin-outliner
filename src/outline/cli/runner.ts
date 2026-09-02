import { createHash } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import {
  OUTLINE_APP_VERSION,
  OUTLINE_CAPABILITIES,
  OUTLINE_CLI_VERSION,
  OUTLINE_COMMAND_FAMILIES,
  OUTLINE_EXIT_CODES,
  OUTLINE_GLOBAL_OPTIONS,
  OUTLINE_MAX_COMMAND_TIMEOUT_MS,
  OUTLINE_PROTOCOL_VERSION,
  OUTLINE_PUBLIC_SCHEMAS,
  OUTLINE_STORAGE_VERSION,
  DiffSchema,
  ChangeSetSchema,
  OutlineContractError,
  outlineCapability,
  outlineCapabilityManifest,
  outlineRecipe,
  outlineRecipeVariants,
  compactOutlineSchema,
  checkOutlineSchema,
  outlineSchemaValidationDetails,
  outlineError,
  outlineExitCodeForError,
  porcelainHelpOptions,
  type CommandOptionHelp,
  type OutlineError,
  type OutlineResponse,
} from '../contract';
import { OutlineClientSupervisor, resolveOutlineContentRoot, resolveOutlineRuntimeRoot } from '../client';
import { OUTLINE_AGENT_ATTESTATION_ENV } from '../contract/agentAttestation';
import {
  parseReadCommand,
  parseSelectorToken,
  splitOptionTerminator,
  parseWatchCommand,
} from './arguments';
import { buildPorcelainRequest } from './porcelain';
import { executeImportInvocation } from './import';
import { inspectView, renderFailureSummary, renderSummaryResult } from './presentation';

const MAX_INLINE_DIFF_BYTES = 8 * 1024 * 1024;
const GLOBAL_OPTION_BY_NAME = new Map(OUTLINE_GLOBAL_OPTIONS.map((entry) => [entry.name, entry]));

export interface OutlineCliIo {
  readonly stdout: (value: string) => void | Promise<void>;
  readonly stdoutBytes: (value: Uint8Array) => void | Promise<void>;
  readonly stderr: (value: string) => void | Promise<void>;
  readonly readStdin: (signal?: AbortSignal) => Promise<string>;
  readonly stdinBytes: (signal?: AbortSignal) => AsyncIterable<Uint8Array>;
  readonly interactive: boolean;
  readonly confirm: (prompt: string, signal?: AbortSignal) => Promise<boolean>;
}

export interface OutlineCliRunOptions {
  readonly io?: Partial<OutlineCliIo>;
  readonly runtimeRoot?: string;
  readonly contentRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}

interface HandledExecution {
  readonly handled: true;
  readonly exitCode: number;
}

interface ParsedInvocation {
  readonly output: 'summary' | 'json';
  readonly noStart: boolean;
  readonly startupTimeoutMs: number | undefined;
  readonly timeoutMs: number | undefined;
  readonly command: string;
  readonly args: readonly string[];
}

const defaultIo: OutlineCliIo = {
  stdout: (value) => writeProcessStream(process.stdout, value),
  stdoutBytes: (value) => writeProcessStream(process.stdout, value),
  stderr: (value) => writeProcessStream(process.stderr, value),
  readStdin: async (signal) => {
    const chunks: Buffer[] = [];
    for await (const chunk of signalAwareStdin(signal)) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  },
  stdinBytes: (signal) => signalAwareStdin(signal),
  interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
  confirm: async (prompt, signal) => {
    const readline = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const question = `${prompt} [y/N] `;
      const answer = signal
        ? await readline.question(question, { signal })
        : await readline.question(question);
      return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
    } finally {
      readline.close();
    }
  },
};

export async function runOutlineCli(argv: readonly string[], options: OutlineCliRunOptions = {}): Promise<number> {
  const io = { ...defaultIo, ...options.io };
  try {
    return await runOutlineCliWithIo(argv, options, io);
  } catch (error) {
    if (isBrokenPipe(error)) return OUTLINE_EXIT_CODES.success;
    throw error;
  }
}

async function runOutlineCliWithIo(
  argv: readonly string[],
  options: OutlineCliRunOptions,
  io: OutlineCliIo,
): Promise<number> {
  let invocation: ParsedInvocation | undefined;
  const requestedOutput = requestedOutputMode(argv);
  try {
    if (hasHelpOption(argv)) {
      await io.stdout(renderHelp(argv));
      return OUTLINE_EXIT_CODES.success;
    }
    invocation = parseInvocation(argv);
    const data = await executeInvocation(invocation, options, io);
    if (isHandledExecution(data)) return data.exitCode;
    await writeSuccess(io, invocation, data);
    return OUTLINE_EXIT_CODES.success;
  } catch (error) {
    if (isBrokenPipe(error)) throw error;
    const publicError = withUsageGuidance(toPublicError(error), invocation);
    if (!options.signal?.aborted || publicError.code === 'operation_settlement_unknown') {
      await writeFailure(io, invocation ?? failedInvocation(requestedOutput), publicError);
    }
    return options.signal?.aborted
      ? signalExitCode(options.signal)
      : outlineExitCodeForError(publicError);
  }
}

function failedInvocation(output: ParsedInvocation['output']): ParsedInvocation {
  return {
    output,
    noStart: false,
    startupTimeoutMs: undefined,
    timeoutMs: undefined,
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
  const contentRoot = options.contentRoot ?? resolveOutlineContentRoot({ env: options.env });
  const environment = options.env ?? process.env;
  const agentAttestation = environment[OUTLINE_AGENT_ATTESTATION_ENV];
  const supervisor = new OutlineClientSupervisor({
    root: runtimeRoot,
    contentRoot,
    noStart: invocation.noStart,
    startupTimeoutMs: invocation.startupTimeoutMs,
    requestTimeoutMs: invocation.timeoutMs,
    origin: agentAttestation ? 'built-in-agent' : 'local-user',
    ...(agentAttestation ? { agentAttestation } : {}),
  });
  if (invocation.command === 'status') {
    assertNoArgs(invocation);
    return supervisor.status(options.signal);
  }
  if (invocation.command === 'schema') {
    return schemaResult(invocation.args);
  }
  if (invocation.command === 'capabilities') {
    const runtime = takeFlag(invocation.args, '--runtime');
    if (runtime.rest.length > 0) throw usageError(`Unexpected capabilities argument: ${runtime.rest[0]}`);
    const bundled = outlineCapabilityManifest();
    if (!runtime.present) return bundled;
    const client = await supervisor.connect(options.signal);
    client.close();
    return bundled;
  }
  if (invocation.command === 'example') {
    const split = splitOptionTerminator(invocation.args);
    const tokens = [...split.options, ...split.literals];
    if (tokens.length < 2) {
      const available = outlineRecipeVariants().map((recipe) => `${recipe.command} ${recipe.variant}`).join(', ');
      throw usageError(`example requires COMMAND and VARIANT. Available recipes: ${available}.`);
    }
    const variant = tokens.at(-1)!;
    const command = tokens.slice(0, -1).join(' ');
    const recipe = outlineRecipe(command, variant);
    if (!recipe) {
      const available = outlineRecipeVariants(command).map((entry) => entry.variant);
      throw usageError(available.length > 0
        ? `Unknown ${command} recipe variant: ${variant}. Available variants: ${available.join(', ')}.`
        : `No recipes are registered for command: ${command}.`);
    }
    return recipe;
  }
  if (invocation.command.startsWith('import ')) {
    return executeImportInvocation(invocation.command, invocation.args, {
      io,
      supervisor,
      env: environment,
      signal: options.signal,
    });
  }

  if (!capability.runtimeRequired) throw usageError(`Unsupported local outline command: ${invocation.command}`);
  if (invocation.command === 'diff') return executeDiffInvocation(invocation, supervisor, io, options.signal);
  if (invocation.command === 'asset ingest') return executeAssetIngest(invocation, supervisor, io, options.signal);
  if (invocation.command === 'asset export') return executeAssetExport(invocation, supervisor, io, options.signal);
  if (capability.streaming) return executeStreamingInvocation(invocation, supervisor, io, options.signal);
  if (invocation.command === 'view inspect') {
    const split = splitOptionTerminator(invocation.args);
    const targets = [...split.options, ...split.literals];
    if (targets.length !== 1) throw usageError('view inspect requires exactly one TARGET.');
    const target = { target: { selector: parseSelectorToken(targets[0]!), cardinality: 'one' as const } };
    const input = { target };
    if (!checkOutlineSchema(capability.requestSchema, input)) {
      throw schemaUsageError('Input does not match the public schema for command: view inspect', capability.requestSchema, input);
    }
    const client = await supervisor.connect(options.signal);
    try {
      return await inspectView(client, target, options.signal);
    } finally {
      client.close();
    }
  }
  const input = await runtimeInput(invocation, io, supervisor, options.signal);
  if (!checkOutlineSchema(capability.requestSchema, input)) {
    throw schemaUsageError(
      `Input does not match the public schema for command: ${invocation.command}`,
      capability.requestSchema,
      input,
    );
  }
  if (capability.destructive
    && capability.kind === 'mutate'
    && isRecord(input)
    && input.preview !== true
    && input.acknowledgeDestructive !== true
    && (invocation.output === 'json' || !io.interactive)) {
    throw new OutlineContractError(outlineError(
      'confirmation_required',
      'confirmation',
      `Run ${invocation.command} with --preview --idempotency-key KEY, then reuse that key with --expect-diff SHA256 --yes.`,
    ));
  }
  const client = await supervisor.connect(options.signal);
  try {
    if (capability.destructive
      && capability.kind === 'mutate'
      && invocation.output === 'summary'
      && io.interactive
      && isRecord(input)
      && input.preview !== true
      && input.acknowledgeDestructive !== true) {
      return executeInteractiveDestructive(invocation.command, input, client, io, options.signal);
    }
    const data = (await requestWithMutationRecovery(
      client,
      invocation.command,
      input,
      capability.kind === 'mutate' && isRecord(input) && input.preview !== true,
      options.signal,
    )).data;
    const viewedTree = invocation.output === 'summary' && invocation.command === 'add'
      ? viewedTreeReceipt(input, data)
      : undefined;
    return viewedTree ?? data;
  } finally {
    client.close();
  }
}

async function executeInteractiveDestructive(
  command: string,
  input: Record<string, unknown>,
  client: import('../client').OutlineClient,
  io: OutlineCliIo,
  signal?: AbortSignal,
): Promise<unknown> {
  const preview = (await client.request(command, {
    ...input,
    preview: true,
    acknowledgeDestructive: undefined,
  }, signal)).data;
  if (!checkOutlineSchema(DiffSchema, preview)) {
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
  await io.stdout(`Review Diff:\n${JSON.stringify(preview, null, 2)}\n`);
  if (!await io.confirm(`Apply destructive ${command} Diff ${preview.diffHash}?`, signal)) {
    throw new OutlineContractError(outlineError(
      'confirmation_required',
      'confirmation',
      'The destructive Diff was not confirmed.',
    ));
  }
  return (await requestWithMutationRecovery(
    client,
    'apply',
    { diff: preview, acknowledgeDestructive: true },
    true,
    signal,
  )).data;
}

function parseInvocation(argv: readonly string[]): ParsedInvocation {
  let jsonRequested = false;
  let noStart = false;
  let startupTimeoutMs: number | undefined;
  let timeoutMs: number | undefined;
  let protocol: number = OUTLINE_PROTOCOL_VERSION;
  let index = 0;
  while (index < argv.length && argv[index]?.startsWith('-')) {
    const arg = argv[index];
    if (arg === '--') {
      index += 1;
      break;
    }
    if (arg === '--json') jsonRequested = true;
    else if (arg === '--no-start') noStart = true;
    else if (arg === '--protocol') protocol = positiveInteger(argv[++index], '--protocol');
    else if (arg === '--startup-timeout') startupTimeoutMs = positiveInteger(argv[++index], '--startup-timeout');
    else if (arg === '--timeout') {
      timeoutMs = positiveInteger(argv[++index], '--timeout');
      if (timeoutMs > OUTLINE_MAX_COMMAND_TIMEOUT_MS) {
        throw usageError(`--timeout must be at most ${OUTLINE_MAX_COMMAND_TIMEOUT_MS}.`);
      }
    }
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
    output: jsonRequested ? 'json' : 'summary',
    noStart,
    startupTimeoutMs,
    timeoutMs,
    command,
    args: remaining.slice(command.split(' ').length),
  };
}

async function runtimeInput(
  invocation: ParsedInvocation,
  io: OutlineCliIo,
  supervisor: OutlineClientSupervisor,
  signal?: AbortSignal,
): Promise<unknown> {
  if (invocation.command === 'find' || invocation.command === 'show') {
    return (await parseReadCommand(invocation.command, invocation.args, (source) => readStructuredSource(source, io, signal))).input;
  }
  if (invocation.command === 'asset show') {
    const split = splitOptionTerminator(invocation.args);
    const assetIds = [...split.options, ...split.literals];
    if (assetIds.length !== 1) throw usageError('asset show requires exactly one AssetRecord ID.');
    return { assetId: assetIds[0] };
  }
  if (invocation.command === 'log') return parseLogInput(invocation.args);
  if (invocation.command === 'revert' || invocation.command === 'undo' || invocation.command === 'redo') {
    return parseHistoryMutationInput(invocation.command, invocation.args);
  }
  if (invocation.command === 'commit') return commitInput(invocation, io, signal);
  if (invocation.command !== 'apply') {
    return buildPorcelainRequest(invocation.command, invocation.args, {
      read: (source) => readStructuredSource(source, io, signal),
      lookup: async (selector) => {
        const client = await supervisor.connect(signal);
        try {
          const response = await client.request('show', { selector }, signal);
          const data = response.data as { nodes?: unknown[] };
          const node = data.nodes?.[0];
          if (!isRecord(node)) throw usageError('Porcelain target did not resolve to one Node.');
          return node;
        } finally {
          client.close();
        }
      },
      project: async (projection) => {
        const client = await supervisor.connect(signal);
        try {
          const target = 'target' in projection.targets
            ? projection.targets.target
            : undefined;
          if (!target) throw usageError('Porcelain Projection cannot resolve a ChangeSet binding before planning.');
          return (await client.request('find', { target, projection }, signal)).data as import('../contract').ProjectionResult;
        } finally {
          client.close();
        }
      },
      ingestAsset: async (source) => {
        const client = await supervisor.connect(signal);
        try {
          if (source === '-') return client.ingestAsset(io.stdinBytes(signal), { signal });
          return (await client.request('asset ingest', { source: 'path', path: source }, signal)).data as import('../contract').AssetLease;
        } finally {
          client.close();
        }
      },
    });
  }
  const parsed = parseInputOptions(invocation.args);
  if (!parsed.input) throw usageError(`${invocation.command} requires --input FILE|-.`);
  if (parsed.rest.length > 0) throw usageError(`Unexpected ${invocation.command} argument: ${parsed.rest[0]}`);
  const raw = parsed.input === '-' ? await io.readStdin(signal) : await readFile(parsed.input, 'utf8');
  const value = parseJsonInput(raw);
  if (parsed.inputFormat !== 'json') throw usageError('apply accepts only --input-format json.');
  if (parsed.output) throw usageError('--output is only valid for diff.');
  if (parsed.idempotencyKey) throw usageError('apply cannot change the idempotency key bound into its Diff.');
  if (!isRecord(value)
    || !isRecord(value.normalizedChangeSet)
    || typeof value.normalizedChangeSet.idempotencyKey !== 'string') {
    throw usageError('apply requires a Diff with an idempotency key; create it with outline diff.');
  }
  return { diff: value, ...(parsed.yes ? { acknowledgeDestructive: true } : {}) };
}

async function commitInput(
  invocation: ParsedInvocation,
  io: OutlineCliIo,
  signal?: AbortSignal,
): Promise<unknown> {
  const parsed = parseInputOptions(invocation.args);
  if (!parsed.input) throw usageError('commit requires --input FILE|-.');
  if (parsed.inputFormat !== 'json') throw usageError('commit accepts only --input-format json.');
  if (parsed.output) throw usageError('--output is only valid for diff.');
  if (parsed.yes) throw usageError('--yes is only valid for apply.');
  if (parsed.rest.length > 0) throw usageError(`Unexpected commit argument: ${parsed.rest[0]}`);
  const raw = parsed.input === '-' ? await io.readStdin(signal) : await readFile(parsed.input, 'utf8');
  const value = parseJsonInput(raw);
  if (!checkOutlineSchema(ChangeSetSchema, value) || !isRecord(value)) {
    throw schemaUsageError('Input does not match the public ChangeSet schema.', ChangeSetSchema, value);
  }
  const existingKey = typeof value.idempotencyKey === 'string' ? value.idempotencyKey : undefined;
  if (parsed.idempotencyKey && existingKey && parsed.idempotencyKey !== existingKey) {
    throw usageError('--idempotency-key conflicts with the key already present in the ChangeSet.');
  }
  return {
    changeSet: {
      ...value,
      idempotencyKey: existingKey ?? parsed.idempotencyKey ?? newCliIdempotencyKey(),
    },
  };
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
  const inputFile = parsed.input === '-' ? undefined : await open(parsed.input, 'r');
  try {
    const source = inputFile?.createReadStream({ autoClose: false }) ?? io.stdinBytes(signal);
    const client = await supervisor.connect(signal);
    try {
      const idempotencyKey = parsed.idempotencyKey ?? newCliIdempotencyKey();
      const artifact = await client.diffArtifact(source, {
        inputFormat: parsed.inputFormat,
        idempotencyKey,
        idempotencyKeyMode: parsed.idempotencyKey ? 'exact' : 'if-missing',
        signal,
      });
      if (!parsed.output && artifact.byteCount > MAX_INLINE_DIFF_BYTES) {
        throw usageError('Diff exceeds 8 MiB; specify --output DIFF_FILE or --output -.');
      }
      if (parsed.output === '-') {
        for await (const chunk of artifact.chunks) await io.stdoutBytes(chunk);
        return { handled: true, exitCode: OUTLINE_EXIT_CODES.success };
      }
      if (parsed.output) {
        await writeAtomicArtifact(parsed.output, artifact.chunks);
        if (invocation.output === 'json') return { path: parsed.output, byteCount: artifact.byteCount, sha256: artifact.sha256 };
        let value: unknown;
        try {
          value = JSON.parse(await readFile(parsed.output, 'utf8')) as unknown;
        } catch {
          throw artifactProtocolError('Outline Runtime returned an invalid Diff artifact.');
        }
        if (!checkOutlineSchema(DiffSchema, value)) {
          throw artifactProtocolError('Outline Runtime returned a Diff artifact that violates the public schema.');
        }
        return { kind: 'outline.summary-diff-receipt', path: parsed.output, byteCount: artifact.byteCount, sha256: artifact.sha256, diff: value };
      }
      const chunks: Buffer[] = [];
      for await (const chunk of artifact.chunks) chunks.push(Buffer.from(chunk));
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      } catch {
        throw artifactProtocolError('Outline Runtime returned an invalid Diff artifact.');
      }
      if (!checkOutlineSchema(DiffSchema, value)) {
        throw artifactProtocolError('Outline Runtime returned a Diff artifact that violates the public schema.');
      }
      return value;
    } finally {
      client.close();
    }
  } finally {
    await inputFile?.close();
  }
}

function viewedTreeReceipt(input: unknown, settlement: unknown): Record<string, unknown> | undefined {
  if (!isRecord(input) || !isRecord(input.changeSet) || !Array.isArray(input.changeSet.operations)) return undefined;
  const operations = input.changeSet.operations.filter(isRecord);
  const viewChange = [...operations].reverse().find((operation) => operation.op === 'update'
    && Array.isArray(operation.changes)
    && operation.changes.some((change) => isRecord(change)
      && change.kind === 'view' && change.property === 'configuration' && change.action === 'set'));
  if (!viewChange || !isRecord(viewChange.targets) || typeof viewChange.targets.binding !== 'string') return undefined;
  const ownerBinding = viewChange.targets.binding;
  const ownerCreate = operations.find((operation) => operation.op === 'create' && operation.bind === ownerBinding);
  if (!ownerCreate || ownerCreate.resource === 'definition') return undefined;
  const ownerDraft = Array.isArray(ownerCreate.nodes) && isRecord(ownerCreate.nodes[0])
    ? ownerCreate.nodes[0]
    : undefined;
  const itemCount = ownerDraft && Array.isArray(ownerDraft.children) ? ownerDraft.children.length : 0;
  const instruction = (viewChange.changes as unknown[]).find((change) => isRecord(change)
    && change.kind === 'view' && change.property === 'configuration') as Record<string, unknown> | undefined;
  const view = instruction && isRecord(instruction.view) ? instruction.view : {};
  const replace = isRecord(view.replace) ? view.replace : {};
  const displayFieldCount = Array.isArray(replace.display) ? replace.display.length : 0;
  const ownerId = isRecord(settlement) ? returnedRootId(settlement) : undefined;
  return {
    kind: 'outline.summary-viewed-tree-receipt', settlement,
    ownerId, itemCount, displayFieldCount, mode: view.mode,
  };
}

function returnedRootId(settlement: Record<string, unknown>): string | undefined {
  if (!Array.isArray(settlement.result)) return undefined;
  for (const result of settlement.result) {
    if (!isRecord(result) || !Array.isArray(result.nodes)) continue;
    for (const node of result.nodes) if (isRecord(node) && typeof node.id === 'string') return node.id;
  }
  return undefined;
}

async function executeAssetIngest(
  invocation: ParsedInvocation,
  supervisor: OutlineClientSupervisor,
  io: OutlineCliIo,
  signal?: AbortSignal,
): Promise<unknown> {
  const split = splitOptionTerminator(invocation.args);
  const sources = [...split.options, ...split.literals];
  if (sources.length !== 1) throw usageError('asset ingest requires exactly one PATH or -.');
  const source = sources[0]!;
  const client = await supervisor.connect(signal);
  try {
    if (source === '-') return client.ingestAsset(io.stdinBytes(signal), { signal });
    return (await client.request('asset ingest', { source: 'path', path: source }, signal)).data;
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
  const split = splitOptionTerminator(invocation.args);
  let assetId: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < split.options.length; index += 1) {
    const arg = split.options[index]!;
    if (arg === '--output') output = requiredValue(split.options[++index], '--output');
    else if (!assetId) assetId = arg;
    else throw usageError(`Unexpected asset export argument: ${arg}`);
  }
  for (const literal of split.literals) {
    if (!assetId) assetId = literal;
    else throw usageError(`Unexpected asset export argument: ${literal}`);
  }
  if (!assetId) throw usageError('asset export requires exactly one AssetRecord ID.');
  if (!output) throw usageError('asset export requires --output FILE|-.');
  const client = await supervisor.connect(signal);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryPath: string | undefined;
  let bytes = 0;
  try {
    if (output !== '-') {
      temporaryPath = `${output}.outline-${crypto.randomUUID()}.tmp`;
      file = await open(temporaryPath, 'wx', 0o600);
    }
    for await (const chunk of client.exportAsset(assetId, signal)) {
      bytes += chunk.byteLength;
      if (file) await file.write(chunk);
      else await io.stdoutBytes(chunk);
    }
    if (!file) return { handled: true, exitCode: OUTLINE_EXIT_CODES.success };
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath!, output);
    temporaryPath = undefined;
    return { path: output, byteCount: bytes };
  } finally {
    client.close();
    if (file) await file.close().catch(() => undefined);
    if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function parseLogInput(args: readonly string[]): Record<string, unknown> {
  const split = splitOptionTerminator(args);
  if (split.literals.length > 0) throw usageError(`Unexpected log argument: ${split.literals[0]}`);
  const result: Record<string, unknown> = {};
  for (let index = 0; index < split.options.length; index += 1) {
    const arg = split.options[index];
    if (arg === '--limit') result.limit = positiveInteger(split.options[++index], '--limit');
    else if (arg === '--cursor') result.cursor = requiredValue(split.options[++index], '--cursor');
    else if (arg === '--operation') result.operationId = requiredValue(split.options[++index], '--operation');
    else if (arg === '--idempotency-key') result.idempotencyKey = requiredValue(split.options[++index], '--idempotency-key');
    else if (arg === '--node') result.nodeId = requiredValue(split.options[++index], '--node');
    else if (arg === '--origin') result.origin = requiredValue(split.options[++index], '--origin');
    else if (arg === '--thread') result.threadId = requiredValue(split.options[++index], '--thread');
    else if (arg === '--turn') result.turnId = requiredValue(split.options[++index], '--turn');
    else if (arg === '--item') result.itemId = requiredValue(split.options[++index], '--item');
    else throw usageError(`Unknown log option: ${arg}`);
  }
  return result;
}

function parseHistoryMutationInput(
  command: 'revert' | 'undo' | 'redo',
  args: readonly string[],
): Record<string, unknown> {
  const split = splitOptionTerminator(args);
  let operationId: string | undefined;
  let origin: string | undefined;
  let expectOperationId: string | undefined;
  let idempotencyKey: string | undefined;
  for (let index = 0; index < split.options.length; index += 1) {
    const arg = split.options[index];
    if (arg === '--idempotency-key') {
      idempotencyKey = requiredValue(split.options[++index], '--idempotency-key');
    } else if (command !== 'revert' && arg === '--origin') {
      origin = requiredValue(split.options[++index], '--origin');
      if (!['own', 'all', 'desktop', 'local-user', 'built-in-agent', 'external-client'].includes(origin)) {
        throw usageError('--origin must be own, all, desktop, local-user, built-in-agent, or external-client.');
      }
    } else if (command !== 'revert' && arg === '--expect-operation') {
      expectOperationId = requiredValue(split.options[++index], '--expect-operation');
    } else if (command === 'revert' && !operationId && !arg?.startsWith('-')) {
      operationId = arg;
    } else {
      throw usageError(`Unexpected ${command} argument: ${arg}`);
    }
  }
  for (const literal of split.literals) {
    if (command === 'revert' && !operationId) operationId = literal;
    else throw usageError(`Unexpected ${command} argument: ${literal}`);
  }
  if (command === 'revert' && !operationId) throw usageError('revert requires exactly one Operation ID.');
  return {
    ...(operationId ? { operationId } : {}),
    ...(origin ? { origin } : {}),
    ...(expectOperationId ? { expectOperationId } : {}),
    idempotencyKey: idempotencyKey ?? newCliIdempotencyKey(),
  };
}

function parseInputOptions(args: readonly string[]): {
  input?: string;
  inputFormat: 'json' | 'jsonl';
  output?: string;
  idempotencyKey?: string;
  yes: boolean;
  rest: readonly string[];
} {
  const split = splitOptionTerminator(args);
  let input: string | undefined;
  let inputFormat: 'json' | 'jsonl' = 'json';
  let output: string | undefined;
  let idempotencyKey: string | undefined;
  let yes = false;
  const rest: string[] = [];
  for (let index = 0; index < split.options.length; index += 1) {
    const arg = split.options[index];
    if (arg === '--input') input = requiredValue(split.options[++index], '--input');
    else if (arg === '--input-format') {
      const format = requiredValue(split.options[++index], '--input-format');
      if (format !== 'json' && format !== 'jsonl') throw usageError('--input-format must be json or jsonl.');
      inputFormat = format;
    } else if (arg === '--output') output = requiredValue(split.options[++index], '--output');
    else if (arg === '--idempotency-key') idempotencyKey = requiredValue(split.options[++index], '--idempotency-key');
    else if (arg === '--yes') yes = true;
    else rest.push(arg ?? '');
  }
  rest.push(...split.literals);
  return { input, inputFormat, output, idempotencyKey, yes, rest };
}

async function executeStreamingInvocation(
  invocation: ParsedInvocation,
  supervisor: OutlineClientSupervisor,
  io: OutlineCliIo,
  signal?: AbortSignal,
): Promise<unknown | HandledExecution> {
  const parsed = invocation.command === 'watch'
    ? { input: await parseWatchCommand(invocation.args, (source) => readStructuredSource(source, io, signal)) }
    : await parseReadCommand('export', invocation.args, (source) => readStructuredSource(source, io, signal));
  const capability = outlineCapability(invocation.command)!;
  if (!checkOutlineSchema(capability.requestSchema, parsed.input)) {
    throw schemaUsageError(
      `Input does not match the public schema for command: ${invocation.command}`,
      capability.requestSchema,
      parsed.input,
    );
  }
  const client = await supervisor.connect(signal);
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
        if (record.type === 'data') await io.stdout(exportDataChunk(record.data, parsed.input));
      } else if (invocation.output === 'json') {
        await io.stdout(`${JSON.stringify(record)}\n`);
      } else {
        await writeSummaryStreamRecord(io, record);
      }
    }
    if (streamError) {
      if (file) {
        await file.close();
        file = undefined;
        await rm(temporaryPath!, { force: true });
      }
      if (output === '-' || invocation.output === 'summary') {
        await io.stderr(renderFailureSummary(streamError));
      }
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
    if (signal?.aborted) return { handled: true, exitCode: signalExitCode(signal) };
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

async function readStructuredSource(source: string, io: OutlineCliIo, signal?: AbortSignal): Promise<string> {
  if (source === '-') return io.readStdin(signal);
  const trimmed = source.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('@')
    || /^[A-Za-z][A-Za-z0-9_-]*:/.test(trimmed)) {
    return source;
  }
  return readFile(source, 'utf8');
}

async function* signalAwareStdin(signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  const iterator = process.stdin[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await nextWithSignal(iterator, signal);
      if (next.done) return;
      yield Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    }
  } finally {
    if (signal?.aborted) await iterator.return?.();
  }
}

function nextWithSignal<T>(iterator: AsyncIterator<T>, signal?: AbortSignal): Promise<IteratorResult<T>> {
  if (!signal) return iterator.next();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      cleanup();
      reject(signal.reason instanceof Error
        ? signal.reason
        : new Error(signal.reason ? String(signal.reason) : 'Outline stdin read was aborted.'));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    void iterator.next().then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function exportDataChunk(data: unknown, input: unknown): string {
  const format = isRecord(input) && isRecord(input.projection) && typeof input.projection.format === 'string'
    ? input.projection.format
    : 'json';
  if ((format === 'markdown' || format === 'opml') && typeof data === 'string') return data;
  return `${JSON.stringify(data)}\n`;
}

async function writeSummaryStreamRecord(
  io: OutlineCliIo,
  record: import('../contract').OutlineStreamRecord,
): Promise<void> {
  if (record.type === 'data') {
    await io.stdout(typeof record.data === 'string' ? record.data : `${JSON.stringify(record.data)}\n`);
  } else if (record.type === 'event') {
    await io.stdout(`${JSON.stringify(record.event)}\n`);
  } else if (record.type === 'error') {
    await io.stderr(renderFailureSummary(record.error));
  }
}

function isHandledExecution(value: unknown): value is HandledExecution {
  return isRecord(value) && value.handled === true && typeof value.exitCode === 'number';
}

async function requestWithMutationRecovery(
  client: import('../client').OutlineClient,
  command: string,
  input: unknown,
  mutation: boolean,
  signal?: AbortSignal,
): Promise<Extract<OutlineResponse, { ok: true }>> {
  if (!mutation) return client.request(command, input, signal);
  const idempotencyKey = mutationIdempotencyKey(command, input);
  if (!idempotencyKey) {
    throw usageError(`Mutation ${command} does not carry a durable idempotency key.`);
  }
  try {
    return await client.request(command, input, signal);
  } catch (error) {
    if (isKnownMutationFailure(error)) throw error;
    const nextCommand = `outline log --idempotency-key ${shellArgument(idempotencyKey)}`;
    throw new OutlineContractError(outlineError(
      'operation_settlement_unknown',
      'durability',
      `The ${command} mutation may have committed, but its response was not received.`,
      {
        retryable: false,
        details: {
          idempotencyKey,
          cause: error instanceof OutlineContractError
            ? error.outlineError.code
            : error instanceof Error ? error.message : String(error),
        },
        next: [nextCommand],
      },
    ));
  }
}

function mutationIdempotencyKey(command: string, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (command === 'apply' && isRecord(input.diff) && isRecord(input.diff.normalizedChangeSet)) {
    const key = input.diff.normalizedChangeSet.idempotencyKey;
    return typeof key === 'string' ? key : undefined;
  }
  if (isRecord(input.changeSet)) {
    const key = input.changeSet.idempotencyKey;
    return typeof key === 'string' ? key : undefined;
  }
  return typeof input.idempotencyKey === 'string' ? input.idempotencyKey : undefined;
}

function isKnownMutationFailure(error: unknown): boolean {
  if (!(error instanceof OutlineContractError)) return false;
  return !['operation_settlement_unknown', 'runtime_unavailable', 'protocol_incompatible']
    .includes(error.outlineError.code);
}

function newCliIdempotencyKey(): string {
  return `cli:${crypto.randomUUID()}`;
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function signalExitCode(signal: AbortSignal): number {
  return signal.reason === 'SIGTERM'
    ? OUTLINE_EXIT_CODES.terminated
    : OUTLINE_EXIT_CODES.interrupted;
}

function schemaResult(args: readonly string[]): unknown {
  const split = splitOptionTerminator(args);
  let part: 'request' | 'result' | 'both' = 'request';
  let partSpecified = false;
  const nameParts: string[] = [];
  for (let index = 0; index < split.options.length; index += 1) {
    const arg = split.options[index]!;
    if (arg !== '--part') {
      nameParts.push(arg);
      continue;
    }
    if (partSpecified) throw usageError('--part may be specified only once.');
    const value = split.options[index + 1];
    if (value !== 'request' && value !== 'result' && value !== 'both') {
      throw usageError('--part requires request, result, or both.');
    }
    part = value;
    partSpecified = true;
    index += 1;
  }
  nameParts.push(...split.literals);
  const name = nameParts.join(' ');
  if (!name) {
    if (partSpecified) throw usageError('--part applies only to command schemas.');
    return Object.fromEntries(Object.entries(OUTLINE_PUBLIC_SCHEMAS).map(([schemaName, schema]) => (
      [schemaName, compactOutlineSchema(schema)]
    )));
  }
  if (Object.hasOwn(OUTLINE_PUBLIC_SCHEMAS, name)) {
    if (partSpecified) throw usageError('--part applies only to command schemas.');
    return compactOutlineSchema(OUTLINE_PUBLIC_SCHEMAS[name as keyof typeof OUTLINE_PUBLIC_SCHEMAS]);
  }
  const capability = outlineCapability(name);
  if (capability) {
    const request = compactOutlineSchema(capability.porcelain?.inputSchema ?? capability.requestSchema);
    const result = compactOutlineSchema(capability.resultSchema);
    if (part === 'request') return request;
    if (part === 'result') return result;
    return { request, result };
  }
  throw usageError(`Unknown public schema or command: ${name}`);
}

function longestCommandPrefix(args: readonly string[]): string | undefined {
  return OUTLINE_CAPABILITIES
    .map((entry) => entry.name)
    .filter((name) => args.slice(0, name.split(' ').length).join(' ') === name)
    .sort((left, right) => right.split(' ').length - left.split(' ').length)[0];
}

async function writeSuccess(io: OutlineCliIo, invocation: ParsedInvocation, data: unknown): Promise<void> {
  if (invocation.output === 'json') {
    const response = {
      protocolVersion: OUTLINE_PROTOCOL_VERSION,
      requestId: `cli:${crypto.randomUUID()}`,
      ok: true,
      command: invocation.command,
      data,
    } as OutlineResponse;
    await io.stdout(`${JSON.stringify(response)}\n`);
    return;
  }
  if (invocation.command === 'schema') {
    await io.stdout(`${JSON.stringify(data)}\n`);
    return;
  }
  if (invocation.command === 'version' && isRecord(data)) {
    await io.stdout(`outline ${String(data.cliVersion)} (Tenon ${String(data.appVersion)}; protocol ${OUTLINE_PROTOCOL_VERSION})\n`);
    return;
  }
  if (invocation.command === 'status' && isRecord(data) && data.running === false) {
    await io.stdout('Outline Runtime: not running\n');
    return;
  }
  let summary: string;
  try {
    summary = renderSummaryResult(invocation.command, data);
  } catch {
    summary = `Command: ${invocation.command}\nStatus: succeeded\nPresentation: unavailable\n`;
  }
  await io.stdout(summary);
}

async function writeFailure(
  io: OutlineCliIo,
  invocation: ParsedInvocation,
  error: OutlineError,
): Promise<void> {
  if (invocation.output === 'json' && !isRawStdoutInvocation(invocation)) {
    const response = {
      protocolVersion: OUTLINE_PROTOCOL_VERSION,
      requestId: `cli:${crypto.randomUUID()}`,
      ok: false,
      command: invocation.command,
      error,
    } as OutlineResponse;
    await io.stdout(`${JSON.stringify(response)}\n`);
    return;
  }
  await io.stderr(renderFailureSummary(error));
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
      '  1. Run the same command with --preview --idempotency-key KEY and inspect the returned Diff.',
      '  2. Re-run it with the same --idempotency-key KEY plus --expect-diff SHA256 --yes.',
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
  const path: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--') {
      if (path.length === 0) continue;
      break;
    }
    if (arg === '--help' || arg === '-h') continue;
    if (arg.startsWith('--')) {
      const metadata = GLOBAL_OPTION_BY_NAME.get(arg.slice(2));
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
    if (arg === '--') break;
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
  const split = splitOptionTerminator(args);
  return {
    present: split.options.includes(flag),
    rest: [
      ...split.options.filter((arg) => arg !== flag),
      ...split.literals,
    ],
  };
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
  const split = splitOptionTerminator(invocation.args);
  const args = [...split.options, ...split.literals];
  if (args.length > 0) throw usageError(`Unexpected ${invocation.command} argument: ${args[0]}`);
}

function usageError(message: string): OutlineContractError {
  return new OutlineContractError(outlineError('invalid_input', 'usage', message));
}

function schemaUsageError(
  message: string,
  schema: Parameters<typeof outlineSchemaValidationDetails>[0],
  value: unknown,
): OutlineContractError {
  return new OutlineContractError(outlineError(
    'invalid_input',
    'usage',
    message,
    { details: { validation: outlineSchemaValidationDetails(schema, value) } },
  ));
}

function toPublicError(error: unknown): OutlineError {
  if (error instanceof OutlineContractError) return error.outlineError;
  const systemError = toPublicSystemError(error);
  if (systemError) return systemError;
  return outlineError(
    'internal_error',
    'internal',
    'The outline command could not be completed.',
    { details: error instanceof Error ? error.message : String(error) },
  );
}

function hasHelpOption(argv: readonly string[]): boolean {
  let index = 0;
  while (index < argv.length && argv[index]?.startsWith('-')) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') return true;
    if (arg === '--') {
      index += 1;
      break;
    }
    if (GLOBAL_OPTION_BY_NAME.get(arg.slice(2))?.value) index += 1;
    index += 1;
  }
  const remaining = argv.slice(index);
  const command = longestCommandPrefix(remaining);
  const pathLength = command?.split(' ').length
    ?? (remaining[0] && isCommandFamily(remaining[0]) ? 1 : undefined);
  if (!pathLength) return false;
  for (const arg of remaining.slice(pathLength)) {
    if (arg === '--') return false;
    if (arg === '--help' || arg === '-h') return true;
  }
  return false;
}

function requestedOutputMode(argv: readonly string[]): ParsedInvocation['output'] {
  const terminator = argv.indexOf('--');
  const optionRegion = terminator < 0 ? argv : argv.slice(0, terminator);
  return optionRegion.includes('--json') ? 'json' : 'summary';
}

function isRawStdoutInvocation(invocation: ParsedInvocation): boolean {
  if (!['diff', 'export', 'asset export'].includes(invocation.command)) return false;
  const split = splitOptionTerminator(invocation.args);
  for (let index = 0; index < split.options.length; index += 1) {
    if (split.options[index] === '--output' && split.options[index + 1] === '-') return true;
  }
  return false;
}

function toPublicSystemError(error: unknown): OutlineError | undefined {
  if (!isRecord(error) || typeof error.code !== 'string') return undefined;
  const code = error.code;
  const target = typeof error.path === 'string' ? error.path : undefined;
  const subject = target ? `: ${target}` : '';
  if (code === 'ENOENT') return outlineError('invalid_input', 'usage', `File not found${subject}.`);
  if (code === 'EEXIST') return outlineError('invalid_input', 'usage', `File already exists${subject}.`);
  if (code === 'EISDIR' || code === 'ENOTDIR') {
    return outlineError('invalid_input', 'usage', `Invalid file path${subject} (${code}).`);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return outlineError('unauthorized', 'unavailable', `Permission denied for file operation${subject}.`);
  }
  if (code === 'ENOSPC' || code === 'EROFS') {
    return outlineError('durability_failed', 'durability', `File write failed${subject} (${code}).`);
  }
  return undefined;
}

function isBrokenPipe(error: unknown): boolean {
  return isRecord(error) && error.code === 'EPIPE';
}

function writeProcessStream(stream: NodeJS.WriteStream, value: string | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      stream.off('error', finish);
      if (error) reject(error);
      else resolve();
    };
    stream.once('error', finish);
    try {
      stream.write(value, finish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
