import {
  DELEGATE_CLI_VERSION,
  DELEGATE_EXIT_CODES,
  DELEGATE_PROTOCOL_VERSION,
  DelegateMessageInputSchema,
  DelegateResultSchema,
  DelegateRunInputSchema,
  decodeDelegateMessageInput,
  decodeDelegateRunInput,
  delegateHelp,
  isDelegateStateCommand,
  parseDelegateCommand,
  type DelegateCommand,
  type DelegateOutputMode,
  type DelegateStateCommand,
} from '../contract';

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
  ): Promise<unknown>;
}

export interface DelegateCliOptions {
  readonly io?: DelegateCliIo;
  readonly signal?: AbortSignal;
  readonly stateExecutor?: DelegateStateExecutor;
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
      if (!options.stateExecutor) {
        await writeFailure(io, command.output, 'unauthorized', 'Host delegation capability is required.');
        return DELEGATE_EXIT_CODES.unauthorized;
      }
      const input = command.name === 'close'
        ? null
        : parseInput(await io.readStdin(), command.name === 'run' ? 'run' : 'message');
      const result = await options.stateExecutor.execute(command, input, options.signal);
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
    await writeFailure(io, output, 'invalid_input', errorMessage(error));
    return DELEGATE_EXIT_CODES.usage;
  }
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
