import { afterAll, describe, expect, test } from 'bun:test';
import { canonicalSha256 } from '../../src/outline/contract/canonical';
import type { OutlineEvent, RuntimeDescriptor } from '../../src/outline/contract/schemas';
import { OutlineClient, OutlineClientSupervisor, readOutlineRuntimeDescriptor } from '../../src/outline/client';
import { OutlineRuntimeServer, resolveOutlineRuntimePaths } from '../../src/outline/runtime/server';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const roots: string[] = [];
const runtimeEntry = fileURLToPath(new URL('../../src/outline/runtime/server/entry.ts', import.meta.url));

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('Outline Runtime process boundary', () => {
  test('creates a private descriptor socket root and lock without leaking its bearer token', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;

    try {
      const descriptor = await readOutlineRuntimeDescriptor(root);
      expect(descriptor).toEqual(runtime.descriptor);
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(runtime.paths.descriptorPath)).mode & 0o777).toBe(0o600);
      expect((await stat(runtime.paths.socketPath)).mode & 0o777).toBe(0o600);
      expect((await stat(runtime.paths.lockPath)).mode & 0o777).toBe(0o700);

      const client = new OutlineClient(runtime.descriptor);
      const response = await client.request('status', {});
      client.close();
      expect(JSON.stringify(response)).not.toContain(runtime.descriptor.bearerToken);

      const persistedFiles = await listFiles(root);
      for (const file of persistedFiles.filter((file) => file !== runtime.paths.descriptorPath)) {
        expect(await readFile(file, 'utf8')).not.toContain(runtime.descriptor.bearerToken);
      }
    } finally {
      await runtime.stop();
    }
  });

  test('rejects a second writer while the first Runtime owns the workspace', async () => {
    const root = await makeRoot();
    const first = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(first).not.toBeNull();
    if (!first) return;
    try {
      expect(await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 })).toBeNull();
      expect((await readOutlineRuntimeDescriptor(root))?.instanceId).toBe(first.descriptor.instanceId);
    } finally {
      await first.stop();
    }
  });

  test('recovers an old dead lock and replaces its stale descriptor', async () => {
    const root = await makeRoot();
    const paths = resolveOutlineRuntimePaths(root);
    await mkdir(paths.lockPath, { recursive: true, mode: 0o700 });
    await writeFile(path.join(paths.lockPath, 'owner.json'), JSON.stringify({
      pid: 2_147_483_647,
      instanceId: 'runtime:stale',
      createdAt: '2000-01-01T00:00:00.000Z',
    }), { mode: 0o600 });
    await writeFile(paths.descriptorPath, JSON.stringify(staleDescriptor(paths.socketPath)), { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await utimes(paths.lockPath, old, old);

    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      expect(runtime.descriptor.instanceId).not.toBe('runtime:stale');
      expect((await readOutlineRuntimeDescriptor(root))?.instanceId).toBe(runtime.descriptor.instanceId);
    } finally {
      await runtime.stop();
    }
  });

  test('authenticates before decoding a request and preserves the unauthorized error code', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const raw = await rawRequest(runtime.descriptor, 'Bearer invalid', '{not valid json');
      expect(raw.status).toBe(401);
      expect(raw.body).toContain('"code":"unauthorized"');
      expect(raw.body).not.toContain(runtime.descriptor.bearerToken);

      const invalidClient = new OutlineClient({ ...runtime.descriptor, bearerToken: '0'.repeat(64) });
      await expect(invalidClient.request('status', {})).rejects.toMatchObject({
        outlineError: { code: 'unauthorized', category: 'protocol' },
      });
      invalidClient.close();
    } finally {
      await runtime.stop();
    }
  });

  test('delivers replayed and live Events once across the replay subscription boundary', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const replayed = await runtime.workspace.mutate(createRequest('Replayed event'));
      const originalEventsAfter = runtime.workspace.store.eventsAfter.bind(runtime.workspace.store);
      let releaseReplay: (() => void) | undefined;
      const replayGate = new Promise<void>((resolve) => { releaseReplay = resolve; });
      runtime.workspace.store.eventsAfter = async (sequence: number) => {
        const events = await originalEventsAfter(sequence);
        await replayGate;
        return events;
      };

      const client = new OutlineClient(runtime.descriptor);
      const iterator = client.watch()[Symbol.asyncIterator]();
      expect((await iterator.next()).value?.type).toBe('hello');
      const live = await runtime.workspace.mutate(createRequest('Live during replay'));
      releaseReplay?.();

      const records = [await iterator.next(), await iterator.next()];
      expect(records.map((record) => record.value?.type)).toEqual(['event', 'event']);
      expect(records.map((record) => eventOperationId(record.value))).toEqual([
        replayed.operationId,
        live.operationId,
      ]);
      expect(records.map((record) => record.value?.sequence)).toEqual([1, 2]);
      await iterator.return?.();
      client.close();
    } finally {
      await runtime.stop();
    }
  });

  test('drains after its last client connection closes', async () => {
    const root = await makeRoot();
    let idleResolve: (() => void) | undefined;
    const idle = new Promise<void>((resolve) => { idleResolve = resolve; });
    const runtime = await OutlineRuntimeServer.start({
      root,
      idleTimeoutMs: 25,
      onIdle: () => { idleResolve?.(); },
    });
    expect(runtime).not.toBeNull();
    if (!runtime) return;

    const client = new OutlineClient(runtime.descriptor);
    await client.request('status', {});
    client.close();
    await withTimeout(idle, 2_000, 'Runtime did not enter idle drain');
    await waitFor(async () => (await readOutlineRuntimeDescriptor(root)) === null, 2_000);
  });

  test('honors no-start and does not create Runtime artifacts', async () => {
    const root = await makeRoot();
    const supervisor = new OutlineClientSupervisor({ root, noStart: true });

    await expect(supervisor.connect()).rejects.toMatchObject({
      outlineError: { code: 'runtime_unavailable', category: 'unavailable' },
    });
    expect(await readOutlineRuntimeDescriptor(root)).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  test('lets simultaneous desktop and CLI supervisors attach to one standalone instance', async () => {
    const root = await makeRoot();
    const launch = {
      command: process.execPath,
      args: [runtimeEntry, '--root', root],
      env: { TENON_OUTLINE_RUNTIME_IDLE_MS: '60000' },
      detached: false,
    };
    const desktop = new OutlineClientSupervisor({ root, launch, startupTimeoutMs: 5_000 });
    const cli = new OutlineClientSupervisor({ root, launch, startupTimeoutMs: 5_000 });
    const clients = await Promise.all([desktop.connect(), cli.connect()]);

    try {
      expect(new Set(clients.map((client) => client.descriptor.instanceId)).size).toBe(1);
      const descriptor = await readOutlineRuntimeDescriptor(root);
      expect(descriptor?.instanceId).toBe(clients[0]?.descriptor.instanceId);

      clients[0]?.close();
      const reconnectedDesktop = await desktop.connect();
      expect(reconnectedDesktop.descriptor.instanceId).toBe(clients[1]?.descriptor.instanceId);
      reconnectedDesktop.close();
    } finally {
      clients.forEach((client) => client.close());
      await stopRuntimeProcess(root);
    }
  });

  test('uses a bounded per-user socket path for an unusually long workspace root', async () => {
    const base = await makeRoot();
    const root = path.join(base, 'segment with spaces'.repeat(8), 'nested'.repeat(12));
    roots.push(root);
    const paths = resolveOutlineRuntimePaths(root);
    expect(Buffer.byteLength(paths.socketPath)).toBeLessThanOrEqual(90);
    expect(paths.socketPath).not.toStartWith(root);

    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    try {
      const client = new OutlineClient(runtime.descriptor);
      expect((await client.request('status', {})).ok).toBe(true);
      client.close();
      expect((await stat(path.dirname(paths.socketPath))).mode & 0o777).toBe(0o700);
    } finally {
      await runtime.stop();
    }
  });

  test('keeps Runtime and client import graphs inside their process boundaries', async () => {
    const serverGraph = await importGraph(fileURLToPath(new URL('../../src/outline/runtime/server/entry.ts', import.meta.url)));
    expect([...serverGraph].filter((file) => file.includes('/src/renderer/') || file.includes('/src/main/'))).toEqual([]);
    expect([...serverGraph]
      .filter((file) => file.includes('/src/core/agent/'))
      .map((file) => path.basename(file))
      .sort()).toEqual(['configuration.ts', 'goal.ts', 'protocol.ts']);

    const clientGraph = await importGraph(fileURLToPath(new URL('../../src/outline/client/index.ts', import.meta.url)));
    expect([...clientGraph].filter((file) => (
      file.includes('/src/core/')
      || file.includes('/runtime/storage/')
      || /workspace(Persistence|Saver|TransactionLog)/.test(file)
    ))).toEqual([]);
  });
});

function createRequest(text: string) {
  const payload = { kind: 'create', text };
  return {
    origin: 'local-user' as const,
    changeSetHash: canonicalSha256(payload),
    diffHash: canonicalSha256({ ...payload, kind: 'diff' }),
    summary: `Created ${text}.`,
    execute: (core: Parameters<Parameters<
      typeof import('../../src/outline/runtime/runtimeWorkspace').OutlineRuntimeWorkspace.prototype.mutate
    >[0]['execute']>[0]) => {
      core.createNode(core.projection().todayId, null, text);
    },
  };
}

function staleDescriptor(socketPath: string): RuntimeDescriptor {
  return {
    descriptorVersion: 1,
    transport: 'unix-http',
    socketPath,
    bearerToken: '0'.repeat(64),
    pid: 2_147_483_647,
    instanceId: 'runtime:stale',
    protocolMajors: [1],
    runtimeVersion: '1.0.0',
    storageVersion: 1,
    createdAt: '2000-01-01T00:00:00.000Z',
  };
}

function eventOperationId(record: Awaited<ReturnType<AsyncIterator<unknown>['next']>>['value']): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const event = (record as { event?: OutlineEvent }).event;
  return event?.operation?.operationId;
}

async function rawRequest(
  descriptor: RuntimeDescriptor,
  authorization: string,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: descriptor.socketPath,
      method: 'POST',
      path: '/v1/request',
      headers: { authorization, 'content-length': Buffer.byteLength(body) },
    }, async (response) => {
      let output = '';
      for await (const chunk of response) output += String(chunk);
      resolve({ status: response.statusCode ?? 0, body: output });
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

async function importGraph(entry: string): Promise<Set<string>> {
  const visited = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (!specifier?.startsWith('.')) continue;
      const candidate = path.resolve(path.dirname(file), specifier);
      const resolved = await resolveTypeScriptModule(candidate);
      if (resolved) queue.push(resolved);
    }
  }
  return visited;
}

async function resolveTypeScriptModule(candidate: string): Promise<string | null> {
  for (const file of [candidate, `${candidate}.ts`, `${candidate}.tsx`, path.join(candidate, 'index.ts')]) {
    if ((await stat(file).catch(() => undefined))?.isFile()) return file;
  }
  return null;
}

async function stopRuntimeProcess(root: string): Promise<void> {
  const descriptor = await readOutlineRuntimeDescriptor(root);
  if (!descriptor) return;
  try {
    process.kill(descriptor.pid, 'SIGTERM');
  } catch {
    return;
  }
  await waitFor(async () => (await readOutlineRuntimeDescriptor(root)) === null, 3_000);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-outline-runtime-process-'));
  roots.push(root);
  return root;
}
