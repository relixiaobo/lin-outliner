import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseDelegateCommand,
  parseDelegateLaunchCapability,
  type DelegateStateCommand,
} from '../../src/delegate/contract';
import {
  DelegateCapabilityBroker,
  DelegateRuntimeHost,
  delegateCliProcessEnvironment,
  delegateProcessDigest,
  requestLifetime,
  type DelegateCapabilityAdmission,
  type DelegateCapabilityExecution,
} from '../../src/main/agent/delegation';
import { resolveDelegateCliRuntime } from '../../src/main/delegateRuntime';

const repoRoot = path.resolve(import.meta.dir, '..', '..');
const roots: string[] = [];
const SESSION_ID = '018f0f24-7b2e-7a3f-8a4b-123456789abd';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Delegate capability broker', () => {
  test('builds one source direct process and binds its allocated Tool Task identity', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'delegate-runtime-host-'));
    roots.push(root);
    const executions: DelegateCapabilityExecution[] = [];
    const runtime = new DelegateRuntimeHost({
      cli: resolveDelegateCliRuntime({
        isPackaged: false,
        moduleDir: path.join(repoRoot, 'src', 'main'),
        resourcesPath: '/unused',
        processExecPath: '/unused/Tenon',
      }),
      socketPath: path.join(root, 'broker.sock'),
      currentConfigurationRevision: () => 'revision-1',
      resolveAdmission: async (input) => ({
        rootUserIntentRevision: 3,
        policy: admission(runCommand(), input.stdin, 'revision-1').policy,
        session: { kind: 'run', preallocatedSessionId: SESSION_ID },
      }),
      execute: async (execution) => {
        executions.push(execution);
        return { taskId: execution.admission.toolTaskId };
      },
    });
    await runtime.start();
    try {
      const command = runCommand();
      const rawInput = JSON.stringify({
        version: 1,
        prompt: 'Inspect this process.',
        profile: 'explore',
        access: 'read-only',
      });
      const prepared = await runtime.commandRuntime({
        pool: 'delegate-local',
        configurationRevision: 'revision-1',
        maxConcurrentProducer: 2,
        maxConcurrentPool: 2,
      }).prepare({
        taskId: 'task_550e8400-e29b-41d4-a716-446655440000',
        nonce: '550e8400-e29b-41d4-a716-446655440001',
        cwd: repoRoot,
        stdin: rawInput,
        command,
        ownerThreadId: 'root-thread',
        sourceTurnId: 'source-turn',
        sourceItemId: 'source-item',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          ELECTRON_RUN_AS_NODE: 'must-not-survive',
          OPENAI_API_KEY: 'must-not-reach-cli',
          TENON_MANAGED_SKILL_SECRET: 'must-not-reach-cli',
          NODE_OPTIONS: '--require /must/not/run.js',
        },
      });
      expect(prepared.process).toMatchObject({
        kind: 'exec',
        executable: 'bun',
        args: [
          path.join(repoRoot, 'src', 'delegate', 'cli', 'entry.ts'),
          'run', '--input', '-', '--output', 'json',
        ],
        privateControl: true,
      });
      if (prepared.process.kind !== 'exec') throw new Error('Expected a direct process');
      expect(prepared.process.env).toMatchObject({ PATH: process.env.PATH, HOME: process.env.HOME });
      expect(prepared.process.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
      expect(prepared.process.env).not.toHaveProperty('OPENAI_API_KEY');
      expect(prepared.process.env).not.toHaveProperty('TENON_MANAGED_SKILL_SECRET');
      expect(prepared.process.env).not.toHaveProperty('NODE_OPTIONS');
      expect(executions).toHaveLength(0);
      const result = await runProcess(
        prepared.process.executable,
        prepared.process.args,
        rawInput,
        prepared.privateControlInput!,
        prepared.process.env,
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        data: { taskId: 'task_550e8400-e29b-41d4-a716-446655440000' },
      });
      const executionDigest = executions[0]!.admission.processSha256;
      expect(executionDigest).toBe(delegateProcessDigest({
        executable: prepared.process.executable,
        args: prepared.process.args,
        cwd: repoRoot,
        env: prepared.process.env,
      }));
      expect(executions[0]!.admission).toMatchObject({
        toolTaskId: 'task_550e8400-e29b-41d4-a716-446655440000',
        toolTaskNonce: '550e8400-e29b-41d4-a716-446655440001',
        processSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        source: { rootUserIntentRevision: 3 },
      });
    } finally {
      await runtime.stop();
    }
  });

  test('builds a minimal packaged CLI environment without ambient credentials or runtime injection', () => {
    expect(delegateCliProcessEnvironment({
      PATH: '/usr/bin:/bin',
      HOME: '/tmp/home',
      LANG: 'en_US.UTF-8',
      OPENAI_API_KEY: 'provider-secret',
      TENON_MANAGED_SKILL_SECRET: 'managed-secret',
      NODE_OPTIONS: '--require /tmp/inject.js',
      ELECTRON_RUN_AS_NODE: 'attacker-controlled',
    }, true)).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/tmp/home',
      LANG: 'en_US.UTF-8',
      ELECTRON_RUN_AS_NODE: '1',
    });
  });

  test('admits one exact fd 3 invocation and rejects replay', async () => {
    const executions: DelegateCapabilityExecution[] = [];
    const fixture = await createBroker('revision-1', async (execution) => {
      executions.push(execution);
      return { admitted: true, sessionId: execution.admission.session.kind === 'run'
        ? execution.admission.session.preallocatedSessionId
        : null };
    });
    try {
      const rawInput = '{\n  "version": 1,\n  "prompt": "Inspect this path.",\n  "profile": "explore",\n  "access": "read-only"\n}\n';
      const command = runCommand();
      const capability = fixture.broker.issue(admission(command, rawInput, 'revision-1'));
      const first = await runCliDirect(command, rawInput, capability);

      expect(first.exitCode).toBe(0);
      expect(JSON.parse(first.stdout)).toMatchObject({ ok: true, data: { admitted: true, sessionId: SESSION_ID } });
      expect(executions).toHaveLength(1);
      expect(executions[0]!.admission.stdin).toBe(rawInput);
      expect(JSON.parse(executions[0]!.admission.stdin)).toMatchObject({
        prompt: 'Inspect this path.',
        profile: 'explore',
      });

      const replay = await runCliDirect(command, rawInput, capability);
      expect(replay.exitCode).toBe(6);
      expect(JSON.parse(replay.stdout)).toMatchObject({
        ok: false,
        error: { code: 'unauthorized', message: expect.stringContaining('already consumed') },
      });
      expect(executions).toHaveLength(1);
    } finally {
      await fixture.broker.stop();
    }
  });

  test('rejects mismatched stdin before consumption and stale configuration at Host admission', async () => {
    let revision = 'revision-1';
    const executions: DelegateCapabilityExecution[] = [];
    const fixture = await createBroker(() => revision, async (execution) => {
      executions.push(execution);
      return { admitted: true };
    });
    try {
      const rawInput = JSON.stringify({
        version: 1,
        prompt: 'Inspect this path.',
        profile: 'explore',
        access: 'read-only',
      });
      const command = runCommand();
      const capability = fixture.broker.issue(admission(command, rawInput, revision));

      const mismatch = await runCliDirect(command, `${rawInput}\n`, capability);
      expect(mismatch.exitCode).toBe(6);
      expect(JSON.parse(mismatch.stdout)).toMatchObject({
        ok: false,
        error: { code: 'unauthorized', message: expect.stringContaining('stdin') },
      });
      expect(executions).toHaveLength(0);

      revision = 'revision-2';
      const stale = await runCliDirect(command, rawInput, capability);
      expect(stale.exitCode).toBe(5);
      expect(JSON.parse(stale.stdout)).toMatchObject({
        ok: false,
        error: { code: 'unavailable', message: expect.stringContaining('configuration changed') },
      });
      expect(executions).toHaveLength(0);
    } finally {
      await fixture.broker.stop();
    }
  });

  test('rejects a broker payload that is not part of the issued capability', async () => {
    const executions: DelegateCapabilityExecution[] = [];
    const fixture = await createBroker('revision-1', async (execution) => {
      executions.push(execution);
      return { admitted: true };
    });
    try {
      const rawInput = JSON.stringify({
        version: 1,
        prompt: 'Inspect the admitted path.',
        profile: 'explore',
        access: 'read-only',
      });
      const command = runCommand();
      const capabilityBytes = fixture.broker.issue(admission(command, rawInput, 'revision-1'));
      const capability = parseDelegateLaunchCapability(capabilityBytes);

      const injected = await postBrokerJson(capability.brokerSocketPath, {
        version: 1,
        capability,
        command,
        input: {
          version: 1,
          prompt: 'Replace the admitted prompt.',
          profile: 'explore',
          access: 'read-only',
        },
      });
      expect(injected).toMatchObject({
        statusCode: 403,
        body: { ok: false, error: { code: 'invalid_input' } },
      });
      expect(executions).toHaveLength(0);

      const admitted = await runCliDirect(command, rawInput, capabilityBytes);
      expect(admitted.exitCode).toBe(0);
      expect(executions).toHaveLength(1);
      expect(executions[0]!.admission.stdin).toBe(rawInput);
    } finally {
      await fixture.broker.stop();
    }
  });

  test('aborts a request lifetime when its transport closes before the response completes', () => {
    const socket = new EventEmitter();
    const request = Object.assign(new EventEmitter(), { socket });
    const response = Object.assign(new EventEmitter(), { writableEnded: false });
    const lifetime = requestLifetime(
      request as unknown as http.IncomingMessage,
      response as unknown as http.ServerResponse,
    );

    socket.emit('close');

    expect(lifetime.controller.signal.aborted).toBe(true);
    expect(lifetime.controller.signal.reason).toBe('broker_response_closed');
    lifetime.dispose();
  });

  test('aborts active Host execution when the broker stops', async () => {
    let observedSignal: AbortSignal | null = null;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const fixture = await createBroker('revision-1', async (execution) => {
      observedSignal = execution.signal;
      markStarted?.();
      await new Promise<void>((_resolve, reject) => {
        execution.signal.addEventListener('abort', () => reject(new Error('execution aborted')), { once: true });
      });
      return { unreachable: true };
    });
    try {
      const rawInput = JSON.stringify({
        version: 1,
        prompt: 'Wait for cancellation.',
        profile: 'explore',
        access: 'read-only',
      });
      const command = runCommand();
      const capability = parseDelegateLaunchCapability(
        fixture.broker.issue(admission(command, rawInput, 'revision-1')),
      );
      const pending = postBrokerJson(capability.brokerSocketPath, {
        version: 1,
        capability,
        command,
      });
      await started;

      const stopping = fixture.broker.stop();

      await waitUntil(() => observedSignal?.aborted === true);
      await pending.catch(() => undefined);
      await stopping;
    } finally {
      await fixture.broker.stop();
    }
  });

  test('the public launcher closes an inherited fd 3 capability', async () => {
    const executions: DelegateCapabilityExecution[] = [];
    const fixture = await createBroker('revision-1', async (execution) => {
      executions.push(execution);
      return { admitted: true };
    });
    try {
      const rawInput = JSON.stringify({
        version: 1,
        prompt: 'This wrapper invocation must be refused.',
        profile: 'explore',
        access: 'read-only',
      });
      const command = runCommand();
      const capability = fixture.broker.issue(admission(command, rawInput, 'revision-1'));
      const result = await runProcess(
        path.join(repoRoot, 'src', 'delegate', 'bin', 'delegate'),
        commandArgs(command),
        rawInput,
        capability,
      );

      expect(result.exitCode).toBe(6);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
      expect(executions).toHaveLength(0);
    } finally {
      await fixture.broker.stop();
    }
  });
});

async function createBroker(
  revision: string | (() => string),
  execute: (execution: DelegateCapabilityExecution) => Promise<unknown>,
): Promise<{ readonly broker: DelegateCapabilityBroker }> {
  const root = await mkdtemp(path.join(tmpdir(), 'delegate-broker-'));
  roots.push(root);
  const broker = new DelegateCapabilityBroker({
    socketPath: path.join(root, 'broker.sock'),
    currentConfigurationRevision: typeof revision === 'string' ? () => revision : revision,
    execute,
  });
  await broker.start();
  return { broker };
}

function admission(
  command: DelegateStateCommand,
  stdin: string,
  configurationRevision: string,
): DelegateCapabilityAdmission {
  return {
    toolTaskId: 'task_550e8400-e29b-41d4-a716-446655440000',
    toolTaskNonce: '550e8400-e29b-41d4-a716-446655440001',
    command,
    stdin,
    cwd: repoRoot,
    processSha256: 'a'.repeat(64),
    source: {
      rootThreadId: 'root-thread',
      sourceTurnId: 'source-turn',
      sourceItemId: 'source-item',
      rootUserIntentRevision: 7,
    },
    policy: {
      configurationRevision,
      capabilityCeilingDigest: 'b'.repeat(64),
      runnerId: 'internal',
      runnerVersion: '1',
      modelProvider: 'provider',
      modelId: 'provider/model',
      effort: 'medium',
      profile: 'explore',
      access: 'read-only',
      timeoutMs: 60_000,
      schedulingPolicyDigest: 'c'.repeat(64),
    },
    session: { kind: 'run', preallocatedSessionId: SESSION_ID },
  };
}

function runCommand(): DelegateStateCommand {
  return parseDelegateCommand(['run', '--input', '-', '--output', 'json']) as DelegateStateCommand;
}

function commandArgs(command: DelegateStateCommand): string[] {
  if (command.name !== 'run') throw new Error('Test requires a run command');
  return ['run', '--input', '-', '--output', command.output];
}

async function runCliDirect(
  command: DelegateStateCommand,
  stdin: string,
  capability: Uint8Array,
): Promise<ProcessResult> {
  return runProcess('bun', [
    path.join(repoRoot, 'src', 'delegate', 'cli', 'entry.ts'),
    ...commandArgs(command),
  ], stdin, capability);
}

interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function postBrokerJson(
  socketPath: string,
  value: unknown,
): Promise<{ readonly statusCode: number | undefined; readonly body: unknown }> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    const request = http.request({
      socketPath,
      path: '/v1/execute',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': body.byteLength,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.once('error', reject);
      response.once('end', () => {
        resolve({
          statusCode: response.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
        });
      });
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Delegate broker state');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function runProcess(
  executable: string,
  args: readonly string[],
  stdin: string,
  capability: Uint8Array,
  env?: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: repoRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(stdin);
    child.stdio[3]!.end(Buffer.from(capability));
  });
}
