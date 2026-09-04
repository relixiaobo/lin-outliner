import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readSync, statSync, writeSync } from 'node:fs';
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ToolTaskFinalReceipt,
  ToolTaskSupervisorConfig,
  ToolTaskSupervisorIdentity,
} from './toolTaskTypes';

const STOP_POLL_MS = 100;
const HEARTBEAT_INTERVAL_MS = 500;
const QUIESCENCE_GRACE_MS = 500;
const TERMINATION_GRACE_MS = 1_000;
const PRIVATE_CONTROL_MAX_BYTES = 64 * 1024;
const SUPERVISOR_ONLY_ENV_KEYS = ['ELECTRON_RUN_AS_NODE'] as const;
let activeConfig: ToolTaskSupervisorConfig | null = null;
let activeChildPid: number | null = null;

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new Error('Tool Task supervisor requires a config path');
  const config = decodeConfig(JSON.parse(await readFile(configPath, 'utf8')));
  activeConfig = config;
  const startedAt = config.startedAt;
  const timeoutStartedAt = Date.now();
  const stdin = openSync(config.stdinPath, 'r');
  const stdout = openSync(config.stdoutPath, 'a');
  const stderr = openSync(config.stderrPath, 'a');
  const privateControl = config.process.kind === 'exec' && config.process.privateControl
    ? readPrivateControl(3)
    : null;
  const target = resolveProcess(config);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(target.executable, [...target.args], {
      cwd: config.cwd,
      env: target.env,
      shell: false,
      stdio: privateControl ? [stdin, 'pipe', 'pipe', 'pipe'] : [stdin, 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    if (child.pid) activeChildPid = child.pid;
    if (privateControl) await writePrivateControl(child, privateControl);
  } catch (error) {
    closeSync(stdin);
    closeSync(stdout);
    closeSync(stderr);
    throw error;
  }
  const resultPromise = waitForChild(child);
  closeSync(stdin);
  if (!child.pid) {
    closeSync(stdout);
    closeSync(stderr);
    const result = await resultPromise;
    throw result.error ?? new Error('Tool Task command did not receive a process identity');
  }
  activeChildPid = child.pid;
  const identity: ToolTaskSupervisorIdentity = {
    version: 1,
    taskId: config.taskId,
    nonce: config.nonce,
    supervisorPid: process.pid,
    childPid: child.pid,
    startedAt,
  };
  await atomicJsonWrite(config.identityPath, identity);

  let stopReason: 'requested' | 'timed_out' | 'output_limit' | 'capture_error' | null = null;
  let stopSentAt: number | null = null;
  const captureState: { error: Error | null } = { error: null };
  const requestStop = (reason: NonNullable<typeof stopReason>) => {
    if (stopReason !== null) return;
    stopReason = reason;
    stopSentAt = Date.now();
    terminateGroup(child.pid!, 'SIGTERM');
  };
  let capturedBytes = 0;
  const capture = (fd: number, value: unknown) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    const remaining = Math.max(0, config.maxOutputBytes - capturedBytes);
    if (remaining > 0) {
      const admitted = bytes.subarray(0, remaining);
      try {
        writeSync(fd, admitted);
        capturedBytes += admitted.byteLength;
      } catch (error) {
        captureState.error = error instanceof Error ? error : new Error(String(error));
        requestStop('capture_error');
        return;
      }
    }
    if (bytes.byteLength > remaining) requestStop('output_limit');
  };
  child.stdout?.on('data', (value) => capture(stdout, value));
  child.stderr?.on('data', (value) => capture(stderr, value));
  const writeHeartbeat = () => atomicJsonWrite(config.heartbeatPath, {
    version: 1,
    taskId: config.taskId,
    nonce: config.nonce,
    supervisorPid: process.pid,
    updatedAt: Date.now(),
  });
  await writeHeartbeat();
  const heartbeat = setInterval(() => {
    void writeHeartbeat().catch(() => undefined);
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
  const monitor = setInterval(() => {
    if (stopReason === null) {
      if (Date.now() - timeoutStartedAt >= config.timeoutMs) requestStop('timed_out');
      else void access(config.stopRequestPath).then(() => requestStop('requested'), () => undefined);
      return;
    }
    if (stopSentAt !== null && Date.now() - stopSentAt >= TERMINATION_GRACE_MS) {
      terminateGroup(child.pid!, 'SIGKILL');
    }
  }, STOP_POLL_MS);
  monitor.unref?.();

  const result = await resultPromise;
  clearInterval(monitor);
  clearInterval(heartbeat);
  closeSync(stdout);
  closeSync(stderr);

  let forcedDescendantTeardown = false;
  if (process.platform !== 'win32' && await groupExists(child.pid)) {
    await delay(QUIESCENCE_GRACE_MS);
    if (await groupExists(child.pid)) {
      forcedDescendantTeardown = true;
      terminateGroup(child.pid, 'SIGTERM');
      await delay(TERMINATION_GRACE_MS);
      if (await groupExists(child.pid)) {
        terminateGroup(child.pid, 'SIGKILL');
        await waitForGroupExit(child.pid, TERMINATION_GRACE_MS);
      }
    }
  }
  if (process.platform !== 'win32' && await groupExists(child.pid)) {
    throw new Error(`Tool Task process group did not become quiescent: ${child.pid}`);
  }

  const quiescedAt = Date.now();
  const sizes = outputSizes(config);
  const outcome = stopReason === 'requested'
    ? { state: 'cancelled' as const, reason: 'stop_requested' }
    : stopReason === 'timed_out'
      ? { state: 'timed_out' as const, reason: 'timeout' }
      : stopReason === 'output_limit'
        ? { state: 'failed' as const, reason: 'output_limit' }
        : stopReason === 'capture_error'
          ? { state: 'failed' as const, reason: 'output_capture_error' }
        : forcedDescendantTeardown
          ? { state: 'failed' as const, reason: 'descendant_leak' }
          : result.error
            ? { state: 'failed' as const, reason: 'spawn_error' }
            : result.code === 0
              ? { state: 'succeeded' as const, reason: 'exit_zero' }
              : { state: 'failed' as const, reason: result.signal ? 'signal' : 'exit_nonzero' };
  const unsigned = {
    version: 1 as const,
    taskId: config.taskId,
    nonce: config.nonce,
    state: outcome.state,
    exitCode: result.code,
    signal: result.signal,
    reason: outcome.reason,
    error: boundedError(captureState.error?.message ?? result.error?.message ?? null),
    supervisorPid: process.pid,
    childPid: child.pid,
    startedAt,
    quiescedAt,
    stdoutBytes: sizes.stdout,
    stderrBytes: sizes.stderr,
    preparedResultDigest: null,
  };
  const receipt: ToolTaskFinalReceipt = {
    ...unsigned,
    receiptDigest: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex'),
  };
  await atomicJsonWrite(config.finalReceiptPath, receipt);
}

function commandEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of SUPERVISOR_ONLY_ENV_KEYS) delete env[key];
  return env;
}

function resolveProcess(config: ToolTaskSupervisorConfig): {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
} {
  const environment = commandEnvironment(process.env);
  if (config.process.kind === 'exec') {
    return {
      executable: config.process.executable,
      args: config.process.args,
      env: { ...environment, ...config.process.env },
    };
  }
  const shell = process.platform === 'win32'
    ? process.env.ComSpec ?? 'cmd.exe'
    : process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
  return {
    executable: shell,
    args: process.platform === 'win32'
      ? ['/d', '/s', '/c', config.process.command]
      : ['-c', config.process.command],
    env: environment,
  };
}

function readPrivateControl(fd: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(8 * 1024, PRIVATE_CONTROL_MAX_BYTES + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      total += count;
      if (total > PRIVATE_CONTROL_MAX_BYTES) throw new Error('Tool Task private control input exceeds its limit');
      chunks.push(chunk.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  if (total === 0) throw new Error('Tool Task private control input is empty');
  return Buffer.concat(chunks, total);
}

async function writePrivateControl(child: ReturnType<typeof spawn>, value: Buffer): Promise<void> {
  const stream = child.stdio[3];
  if (!stream || typeof (stream as NodeJS.WritableStream).write !== 'function') {
    throw new Error('Tool Task child private control pipe is unavailable');
  }
  const writable = stream as NodeJS.WritableStream;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    writable.once('error', onError);
    writable.end(value, () => {
      writable.removeListener('error', onError);
      resolve();
    });
  });
}

function decodeConfig(value: unknown): ToolTaskSupervisorConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Tool Task config');
  const record = value as Record<string, unknown>;
  const strings = [
    'taskId', 'nonce', 'cwd', 'stdinPath', 'stdoutPath', 'stderrPath', 'progressPath',
    'identityPath', 'heartbeatPath', 'stopRequestPath', 'finalReceiptPath',
  ] as const;
  if (record.version !== 2 || strings.some((key) => typeof record[key] !== 'string' || !record[key])
    || !validProcessSpec(record.process)) {
    throw new Error('Invalid Tool Task config identity');
  }
  if (!Number.isFinite(record.startedAt)
    || !Number.isSafeInteger(record.timeoutMs) || Number(record.timeoutMs) < 1
    || !Number.isSafeInteger(record.maxOutputBytes) || Number(record.maxOutputBytes) < 1) {
    throw new Error('Invalid Tool Task config limits');
  }
  return record as unknown as ToolTaskSupervisorConfig;
}

function validProcessSpec(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const processSpec = value as Record<string, unknown>;
  if (processSpec.kind === 'shell') {
    return typeof processSpec.command === 'string'
      && processSpec.command.length > 0
      && !processSpec.command.includes('\0');
  }
  if (processSpec.kind !== 'exec'
    || typeof processSpec.executable !== 'string' || processSpec.executable.length === 0
    || processSpec.executable.includes('\0')
    || !Array.isArray(processSpec.args) || processSpec.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
    || typeof processSpec.privateControl !== 'boolean'
    || !processSpec.env || typeof processSpec.env !== 'object' || Array.isArray(processSpec.env)) {
    return false;
  }
  return Object.entries(processSpec.env).every(([key, entry]) => (
    key.length > 0 && !key.includes('=') && !key.includes('\0')
    && typeof entry === 'string' && !entry.includes('\0')
  ));
}

function outputSizes(config: ToolTaskSupervisorConfig): { stdout: number; stderr: number } {
  const size = (candidate: string) => {
    try { return statSync(candidate).size; } catch { return 0; }
  };
  return { stdout: size(config.stdoutPath), stderr: size(config.stderrPath) };
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
}> {
  return new Promise((resolve) => {
    let spawnError: Error | null = null;
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => resolve({ code, signal, error: spawnError }));
  });
}

async function groupExists(pid: number): Promise<boolean> {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function terminateGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // Exit and stop naturally race. Quiescence is checked before the receipt.
  }
}

async function waitForGroupExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await executionExists(pid)) return;
    await delay(25);
  }
}

async function atomicJsonWrite(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function boundedError(value: string | null): string | null {
  return value === null ? null : value.slice(0, 4_096);
}

void main().catch(async (error) => {
  const configPath = process.argv[2];
  if (configPath) {
    try {
      const config = activeConfig ?? decodeConfig(JSON.parse(await readFile(configPath, 'utf8')));
      const message = boundedError(error instanceof Error ? error.message : String(error))
        ?? 'Unknown supervisor failure';
      await writeFile(config.stderrPath, `Tool Task supervisor failed: ${message}\n`, {
        encoding: 'utf8', flag: 'a', mode: 0o600,
      });
      if (activeChildPid) {
        terminateGroup(activeChildPid, 'SIGTERM');
        await waitForGroupExit(activeChildPid, TERMINATION_GRACE_MS);
        if (await executionExists(activeChildPid)) {
          terminateGroup(activeChildPid, 'SIGKILL');
          await waitForGroupExit(activeChildPid, TERMINATION_GRACE_MS);
        }
      }
      if (!activeChildPid || !await executionExists(activeChildPid)) {
        const sizes = outputSizes(config);
        const unsigned = {
          version: 1 as const,
          taskId: config.taskId,
          nonce: config.nonce,
          state: 'failed' as const,
          exitCode: null,
          signal: null,
          reason: 'supervisor_error',
          error: message,
          supervisorPid: process.pid,
          childPid: activeChildPid,
          startedAt: config.startedAt,
          quiescedAt: Date.now(),
          stdoutBytes: sizes.stdout,
          stderrBytes: sizes.stderr,
          preparedResultDigest: null,
        };
        const receipt: ToolTaskFinalReceipt = {
          ...unsigned,
          receiptDigest: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex'),
        };
        await atomicJsonWrite(config.finalReceiptPath, receipt);
      }
    } catch {
      // The Host will reconcile a missing final receipt as lost.
    }
  }
  process.exitCode = 1;
});

async function executionExists(pid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error instanceof Error && 'code' in error && error.code === 'EPERM';
    }
  }
  return groupExists(pid);
}
