import {
  canonicalDelegateCommand,
  delegateBytesDigest,
  DELEGATE_CAPABILITY_FD,
  DELEGATE_CLI_VERSION,
  DELEGATE_EXIT_CODES,
  DELEGATE_MAX_CAPABILITY_BYTES,
  DELEGATE_PROTOCOL_VERSION,
  DelegateMessageInputSchema,
  DelegateResultSchema,
  DelegateRunInputSchema,
  decodeDelegateMessageInput,
  decodeDelegateRunInput,
  delegateHelp,
  isDelegateStateCommand,
  parseDelegateCommand,
  parseDelegateLaunchCapability,
  type DelegateCommand,
  type DelegateOutputMode,
  type DelegateStateCommand,
} from '../contract';
import { closeSync, readSync } from 'node:fs';
import { DelegateBrokerClient, DelegateBrokerError } from './brokerClient';

export interface DelegateCliIo {
  readonly readStdin: () => Promise<string>;
  readonly stdout: (value: string) => Promise<void>;
  readonly stderr: (value: string) => Promise<void>;
}

export interface DelegateStateExecutor {
  execute(
    command: DelegateStateCommand,
    input: unknown,
    signal?: AbortSignal,
    rawInput?: string,
  ): Promise<unknown>;
}

export interface DelegateCliOptions {
  readonly io?: DelegateCliIo;
  readonly signal?: AbortSignal;
  readonly stateExecutor?: DelegateStateExecutor;
  readonly readCapability?: () => Uint8Array | null;
}

interface DelegateCliFailure {
  readonly ok: false;
  readonly error: {
    readonly code: 'invalid_input' | 'unauthorized' | 'unavailable' | 'internal_error';
    readonly message: string;
  };
}

export async function runDelegateCli(
  argv: readonly string[],
  options: DelegateCliOptions = {},
): Promise<number> {
  const io = options.io ?? processIo();
  let command: DelegateCommand | undefined;
  try {
    command = parseDelegateCommand(argv);
    if (isDelegateStateCommand(command)) {
      const executor = options.stateExecutor ?? defaultStateExecutor(command, options.readCapability);
      if (!executor) {
        await writeFailure(io, command.output, 'unauthorized', 'Host delegation capability is required.');
        return DELEGATE_EXIT_CODES.unauthorized;
      }
      const rawInput = command.name === 'close' ? '' : await io.readStdin();
      const input = command.name === 'close'
        ? null
        : parseInput(rawInput, command.name === 'run' ? 'run' : 'message');
      const result = await executor.execute(command, input, options.signal, rawInput);
      await writeSuccess(io, command.output, result);
      return DELEGATE_EXIT_CODES.success;
    }
    const result = executeDiagnostic(command);
    const output = command.name === 'doctor' ? command.output : 'json';
    await writeSuccess(io, output, result);
    return DELEGATE_EXIT_CODES.success;
  } catch (error) {
    if (options.signal?.aborted) return signalExitCode(options.signal);
    const output = requestedOutput(argv);
    const code = error instanceof DelegateBrokerError ? error.code : 'invalid_input';
    await writeFailure(io, output, code, errorMessage(error));
    return failureExitCode(code);
  }
}

function defaultStateExecutor(
  command: DelegateStateCommand,
  readCapability: DelegateCliOptions['readCapability'],
): DelegateStateExecutor | null {
  const bytes = readCapability ? readCapability() : readCapabilityFd(DELEGATE_CAPABILITY_FD);
  if (!bytes) return null;
  let capability: ReturnType<typeof parseDelegateLaunchCapability>;
  try {
    capability = parseDelegateLaunchCapability(bytes);
  } catch {
    throw new DelegateBrokerError('unauthorized', 'Host delegation capability is invalid.');
  }
  if (canonicalDelegateCommand(capability.command) !== canonicalDelegateCommand(command)) {
    throw new DelegateBrokerError('unauthorized', 'Delegate launch capability does not match the command.');
  }
  return new CapabilityBoundExecutor(capability);
}

class CapabilityBoundExecutor implements DelegateStateExecutor {
  private readonly client: DelegateBrokerClient;

  constructor(private readonly capability: ReturnType<typeof parseDelegateLaunchCapability>) {
    this.client = new DelegateBrokerClient(capability);
  }

  async execute(
    command: DelegateStateCommand,
    input: unknown,
    signal?: AbortSignal,
    rawInput = '',
  ): Promise<unknown> {
    const actual = delegateBytesDigest(rawInput);
    if (actual.byteLength !== this.capability.stdin.byteLength
      || actual.sha256 !== this.capability.stdin.sha256) {
      throw new DelegateBrokerError('unauthorized', 'Delegate launch capability does not match stdin.');
    }
    return this.client.execute(command, input, signal);
  }
}

function readCapabilityFd(fd: number): Buffer | null {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(8 * 1024, DELEGATE_MAX_CAPABILITY_BYTES + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      total += count;
      if (total > DELEGATE_MAX_CAPABILITY_BYTES) {
        throw new DelegateBrokerError('unauthorized', 'Delegate launch capability exceeds its byte limit.');
      }
      chunks.push(chunk.subarray(0, count));
    }
  } catch (error) {
    if (error instanceof DelegateBrokerError) throw error;
    return null;
  } finally {
    try { closeSync(fd); } catch { /* An absent capability descriptor is an ordinary refusal. */ }
  }
  return total === 0 ? null : Buffer.concat(chunks, total);
}

function executeDiagnostic(command: Exclude<DelegateCommand, DelegateStateCommand>): unknown {
  if (command.name === 'version') {
    return {
      cliVersion: DELEGATE_CLI_VERSION,
      protocolVersions: [DELEGATE_PROTOCOL_VERSION],
    };
  }
  if (command.name === 'schema') {
    if (command.schema === 'run') return DelegateRunInputSchema;
    if (command.schema === 'message') return DelegateMessageInputSchema;
    if (command.schema === 'result') return DelegateResultSchema;
    return {
      run: DelegateRunInputSchema,
      message: DelegateMessageInputSchema,
      result: DelegateResultSchema,
    };
  }
  const runnerId = command.runnerId ?? 'internal';
  return {
    runnerId,
    detected: runnerId === 'internal',
    ready: false,
    reason: 'Host delegation broker is unavailable to this diagnostic process.',
  };
}

function parseInput(raw: string, kind: 'run' | 'message'): unknown {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid delegation ${kind} input: stdin must contain one JSON value.`);
  }
  return kind === 'run' ? decodeDelegateRunInput(value) : decodeDelegateMessageInput(value);
}

async function writeSuccess(io: DelegateCliIo, output: DelegateOutputMode, data: unknown): Promise<void> {
  if (output === 'json') {
    await io.stdout(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }
  await io.stdout(`${renderText(data)}\n`);
}

async function writeFailure(
  io: DelegateCliIo,
  output: DelegateOutputMode,
  code: DelegateCliFailure['error']['code'],
  message: string,
): Promise<void> {
  const failure: DelegateCliFailure = { ok: false, error: { code, message } };
  if (output === 'json') {
    await io.stdout(`${JSON.stringify(failure)}\n`);
    return;
  }
  await io.stderr(`delegate: ${message}\n`);
}

function requestedOutput(argv: readonly string[]): DelegateOutputMode {
  const index = argv.indexOf('--output');
  return index >= 0 && argv[index + 1] === 'json' ? 'json' : 'text';
}

function renderText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.cliVersion === 'string') {
      return `delegate ${record.cliVersion} (protocol ${String((record.protocolVersions as unknown[])[0])})`;
    }
    if (typeof record.runnerId === 'string') {
      return [
        `Runner: ${record.runnerId}`,
        `Detected: ${record.detected === true ? 'yes' : 'no'}`,
        `Ready: ${record.ready === true ? 'yes' : 'no'}`,
        `Reason: ${String(record.reason)}`,
      ].join('\n');
    }
  }
  return JSON.stringify(value, null, 2);
}

function signalExitCode(signal: AbortSignal): number {
  return signal.reason === 'SIGTERM' ? DELEGATE_EXIT_CODES.terminated : DELEGATE_EXIT_CODES.interrupted;
}

function failureExitCode(code: DelegateCliFailure['error']['code']): number {
  if (code === 'unauthorized') return DELEGATE_EXIT_CODES.unauthorized;
  if (code === 'unavailable') return DELEGATE_EXIT_CODES.unavailable;
  if (code === 'internal_error') return DELEGATE_EXIT_CODES.failed;
  return DELEGATE_EXIT_CODES.usage;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || delegateHelp());
}

function processIo(): DelegateCliIo {
  return {
    readStdin: readProcessStdin,
    stdout: async (value) => writeStream(process.stdout, value),
    stderr: async (value) => writeStream(process.stderr, value),
  };
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function writeStream(stream: NodeJS.WriteStream, value: string): Promise<void> {
  if (stream.write(value)) return;
  await new Promise<void>((resolve, reject) => {
    stream.once('drain', resolve);
    stream.once('error', reject);
  });
}
