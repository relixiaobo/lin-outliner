import { afterAll, describe, expect, test } from 'bun:test';
import { Core, type CoreTransactionPatch } from '../../src/core/core';
import { canonicalSha256 } from '../../src/outline/contract/canonical';
import { outlineCapabilityContractDigest } from '../../src/outline/contract/capabilities';
import { issueOutlineAgentAttestation } from '../../src/outline/contract/agentAttestation';
import type { ChangeSet, Diff, Operation, OutlineEvent, ProjectionResult, RuntimeDescriptor } from '../../src/outline/contract/schemas';
import { OutlineClient, OutlineClientSupervisor, readOutlineRuntimeDescriptor } from '../../src/outline/client';
import { OutlineRuntimeServer, resolveOutlineRuntimePaths } from '../../src/outline/runtime/server';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const roots: string[] = [];
const runtimeEntry = fileURLToPath(new URL('../../src/outline/runtime/server/entry.ts', import.meta.url));
const legacyRuntimeEntry = fileURLToPath(new URL('../fixtures/outlineLegacyRuntime.ts', import.meta.url));

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

  test('serves find, diff, apply, and show through the authenticated process boundary', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const client = new OutlineClient(runtime.descriptor);
    try {
      const beforeRevision = runtime.workspace.revision();
      const found = await client.request('find', {
        target: {
          selector: { by: 'query', query: { kind: 'rule', op: 'STRING_MATCH', text: 'not present' }, limit: 10 },
          cardinality: 'many',
          max: 10,
        },
      });
      expect((found.data as ProjectionResult).nodes).toEqual([]);

      const changeSet: ChangeSet = {
        protocolVersion: 1,
        kind: 'outline.changeset',
        idempotencyKey: `test:${crypto.randomUUID()}`,
        operations: [{
          op: 'create',
          placement: { kind: 'last', parent: {
            target: { selector: { by: 'alias', alias: 'today' }, cardinality: 'one' },
          } },
          nodes: [{ content: { text: 'Created over Runtime socket', marks: [], inlineRefs: [] }, children: [] }],
          bind: 'created',
        }],
      };
      const preview = await client.request('diff', { changeSet });
      const diff = preview.data as Diff;
      expect(diff.kind).toBe('outline.diff');
      expect(runtime.workspace.revision()).toBe(beforeRevision);
      expect(await runtime.workspace.store.operations()).toEqual([]);

      const applied = await client.request('apply', { diff });
      const operation = applied.data as Operation;
      expect(operation.origin).toBe('external-client');
      expect(operation.revisionBefore).toBe(beforeRevision);
      expect(operation.revisionAfter).toBe(beforeRevision + 1);

      const nodeId = diff.bindings.created?.[0];
      expect(nodeId).toBeDefined();
      const shown = await client.request('show', { selector: { by: 'id', id: nodeId } });
      expect((shown.data as ProjectionResult).nodes).toEqual([
        expect.objectContaining({ id: nodeId, content: expect.objectContaining({ text: 'Created over Runtime socket' }) }),
      ]);

      const exported = [];
      for await (const record of client.stream('export', {
        selector: { by: 'alias', alias: 'today' },
        projection: {
          kind: 'export',
          targets: {
            target: { selector: { by: 'alias', alias: 'today' }, cardinality: 'one' },
          },
          depth: 1,
          include: ['children'],
          page: { limit: 100 },
          format: 'jsonl',
        },
      })) exported.push(record);
      expect(exported[0]?.type).toBe('hello');
      expect(exported.at(-1)?.type).toBe('end');
      expect(exported.filter((record) => record.type === 'data').map((record) => (
        record.type === 'data' ? record.data : undefined
      ))).toContainEqual(expect.objectContaining({ id: nodeId }));
    } finally {
      client.close();
      await runtime.stop();
    }
  });

  test('streams verified AssetRecord bytes with browser-compatible range responses', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const bytes = Buffer.from('0123456789');
    const lease = await runtime.workspace.assets.ingestBytes(bytes, 'range.txt');
    try {
      const client = new OutlineClient(runtime.descriptor);
      const partial = await client.serveAsset(lease.assetId, 'bytes=2-5');
      expect(partial.status).toBe(206);
      expect(partial.headers.get('accept-ranges')).toBe('bytes');
      expect(partial.headers.get('content-range')).toBe('bytes 2-5/10');
      expect(Buffer.from(await partial.arrayBuffer())).toEqual(Buffer.from('2345'));

      const invalidClient = new OutlineClient(runtime.descriptor);
      const invalid = await invalidClient.serveAsset(lease.assetId, 'bytes=20-30');
      expect(invalid.status).toBe(416);
      expect(invalid.headers.get('content-range')).toBe('bytes */10');
    } finally {
      await runtime.stop();
    }
  });

  test('records immutable Agent causation and consumes one attestation after a successful mutation', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const causation = { threadId: 'thread:agent', turnId: 'turn:agent', itemId: 'item:agent' };
    const token = issueOutlineAgentAttestation({
      descriptor: runtime.descriptor,
      runtimeRoot: root,
      causation,
    });
    const client = new OutlineClient(runtime.descriptor, {
      origin: 'built-in-agent',
      agentAttestation: token,
    });
    try {
      const firstDiff = (await client.request('diff', {
        changeSet: createTodayChangeSet('Attributed Agent write'),
      })).data as Diff;
      const first = (await client.request('apply', { diff: firstDiff })).data as Operation;
      expect(first).toMatchObject({ origin: 'built-in-agent', causation });

      await expect(client.request('show', { selector: { by: 'alias', alias: 'today' } })).resolves.toMatchObject({ ok: true });
      const replayDiff = (await client.request('diff', {
        changeSet: createTodayChangeSet('Rejected Agent replay'),
      })).data as Diff;
      await expect(client.request('apply', { diff: replayDiff })).rejects.toMatchObject({
        outlineError: { code: 'agent_attestation_required' },
      });
      expect(runtime.workspace.projection().nodes.some((node) => node.content.text === 'Rejected Agent replay')).toBe(false);
    } finally {
      client.close();
      await runtime.stop();
    }
  });

  test('rejects missing and expired Agent attestations but releases a valid claim after a failed mutation', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const local = new OutlineClient(runtime.descriptor, { origin: 'local-user' });
    const causation = { threadId: 'thread:retry', turnId: 'turn:retry', itemId: 'item:retry' };
    const validToken = issueOutlineAgentAttestation({
      descriptor: runtime.descriptor,
      runtimeRoot: root,
      causation,
    });
    const agent = new OutlineClient(runtime.descriptor, {
      origin: 'built-in-agent',
      agentAttestation: validToken,
    });
    try {
      const missing = new OutlineClient(runtime.descriptor, { origin: 'built-in-agent' });
      const missingDiff = (await missing.request('diff', {
        changeSet: createTodayChangeSet('Missing attestation'),
      })).data as Diff;
      await expect(missing.request('apply', { diff: missingDiff })).rejects.toMatchObject({
        outlineError: { code: 'agent_attestation_required' },
      });
      const revisionBeforeHistoryRequests = runtime.workspace.revision();
      for (const [command, input] of [
        ['revert', { operationId: 'operation:missing' }],
        ['undo', {}],
        ['redo', {}],
      ] as const) {
        await expect(missing.request(command, input)).rejects.toMatchObject({
          outlineError: { code: 'agent_attestation_required' },
        });
      }
      expect(runtime.workspace.revision()).toBe(revisionBeforeHistoryRequests);
      missing.close();

      const expired = new OutlineClient(runtime.descriptor, {
        origin: 'built-in-agent',
        agentAttestation: issueOutlineAgentAttestation({
          descriptor: runtime.descriptor,
          runtimeRoot: root,
          causation,
          now: Date.now() - 60_001,
        }),
      });
      await expect(expired.request('apply', { diff: missingDiff })).rejects.toMatchObject({
        outlineError: { code: 'agent_attestation_required' },
      });
      expired.close();

      const stale = (await agent.request('diff', {
        changeSet: createTodayChangeSet('Retry after stale failure'),
      })).data as Diff;
      const concurrent = (await local.request('diff', {
        changeSet: createTodayChangeSet('Concurrent local write'),
      })).data as Diff;
      await local.request('apply', { diff: concurrent });
      await expect(agent.request('apply', { diff: stale })).rejects.toMatchObject({
        outlineError: { code: 'stale_revision' },
      });

      const fresh = (await agent.request('diff', {
        changeSet: createTodayChangeSet('Retry after stale failure'),
      })).data as Diff;
      const applied = (await agent.request('apply', { diff: fresh })).data as Operation;
      expect(applied).toMatchObject({ origin: 'built-in-agent', causation });
    } finally {
      agent.close();
      local.close();
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

  test('replays startup recovery expiry emitted while reconciling Today under the new Runtime identity', async () => {
    const root = await makeRoot();
    let nowMs = Date.parse('2037-01-01T00:00:00.000Z');
    const workspaceOptions = {
      now: () => new Date(nowMs),
      storeOptions: { minimumRetentionDays: 1, minimumRetentionOperations: 0 },
    };
    const first = await OutlineRuntimeServer.start({
      root,
      idleTimeoutMs: 60_000,
      workspaceOptions: { ...workspaceOptions, instanceId: 'runtime:startup-old' },
    });
    expect(first).not.toBeNull();
    if (!first) return;
    let baseline = 0;
    let todayId = '';
    let firstStore: import('../../src/outline/runtime/storage').WorkspaceTransactionLog | undefined;
    try {
      todayId = first.workspace.projection().todayId;
      await first.workspace.mutate(createRequest('Recovery that expires during reconciliation'));
      baseline = (await first.workspace.store.health()).transactionLog.eventSequence;
      firstStore = first.workspace.store;
    } finally {
      await first.stop();
    }

    if (!firstStore) throw new Error('Runtime store was not available');
    const loaded = await firstStore.load();
    if (!loaded.snapshot) throw new Error('Runtime snapshot was not available');
    const core = loaded.replay.length > 0
      ? Core.fromPersistenceState(loaded.snapshot, loaded.replay, {
          installationId: loaded.snapshot.local.installationId,
          revision: loaded.events.at(-1)?.revision ?? 0,
        })
      : Core.fromState(loaded.snapshot, {
          installationId: loaded.snapshot.local.installationId,
          revision: loaded.events.at(-1)?.revision ?? 0,
        });
    const today = core.state().nodes[todayId]!;
    const removalPatch: CoreTransactionPatch = {
      revisionBefore: core.revision(),
      revisionAfter: core.revision() + 1,
      persistenceRevisionBefore: core.persistenceRevision(),
      persistenceRevisionAfter: core.persistenceRevision() + 1,
      systemChanged: false,
      nodes: [{ id: todayId, before: null, after: today }],
    };
    await core.transaction('system', () => core.applyRecoveryPatch(removalPatch));
    await firstStore.compact(core.serializeState(), {
      instanceId: 'runtime:startup-old',
      revision: core.revision(),
    });

    nowMs += 2 * 86_400_000;
    const restarted = await OutlineRuntimeServer.start({
      root,
      idleTimeoutMs: 60_000,
      workspaceOptions: { ...workspaceOptions, instanceId: 'runtime:startup-new' },
    });
    expect(restarted).not.toBeNull();
    if (!restarted) return;
    const client = new OutlineClient(restarted.descriptor);
    const iterator = client.watch()[Symbol.asyncIterator]();
    try {
      expect(restarted.workspace.eventBaselineSequence).toBe(baseline);
      const [persisted] = await restarted.workspace.store.eventsAfter(baseline);
      expect(persisted).toMatchObject({
        type: 'operation.recovery-expired',
        instanceId: 'runtime:startup-new',
        revision: restarted.workspace.revision(),
      });

      expect((await iterator.next()).value?.type).toBe('hello');
      const replayed = (await iterator.next()).value;
      expect(replayed?.type).toBe('event');
      expect(replayed?.type === 'event' ? replayed.event : undefined).toMatchObject({
        type: 'operation.recovery-expired',
        instanceId: 'runtime:startup-new',
        sequence: persisted?.sequence,
      });
    } finally {
      await iterator.return?.();
      client.close();
      await restarted.stop();
    }
  });

  test('requires resync instead of projecting a historical replay from a future revision', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const projection = {
      kind: 'outline' as const,
      targets: {
        target: { selector: { by: 'alias' as const, alias: 'today' as const }, cardinality: 'one' as const },
      },
      depth: 1,
      page: { limit: 100 },
    };
    try {
      const firstClient = new OutlineClient(runtime.descriptor);
      const firstIterator = firstClient.watch({ projection })[Symbol.asyncIterator]();
      const initial = (await firstIterator.next()).value;
      expect(initial?.type).toBe('hello');
      const cursor = initial?.cursor;
      await firstIterator.return?.();
      firstClient.close();

      await runtime.workspace.mutate(createRequest('Historical projection revision one'));
      await runtime.workspace.mutate(createRequest('Historical projection revision two'));

      const replayClient = new OutlineClient(runtime.descriptor);
      const replay = replayClient.watch({ cursor, projection })[Symbol.asyncIterator]();
      expect((await replay.next()).value?.type).toBe('hello');
      const resync = (await replay.next()).value;
      expect(resync?.type === 'event' ? resync.event.type : undefined).toBe('resync.required');
      expect(resync?.type === 'event' ? resync.event.projection : undefined).toBeUndefined();
      expect((await replay.next()).value?.type).toBe('end');
      replayClient.close();
    } finally {
      await runtime.stop();
    }
  });

  test('serves requests while one shared client holds an open watch', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const client = new OutlineClient(runtime.descriptor);
    const iterator = client.watch()[Symbol.asyncIterator]();
    try {
      expect((await iterator.next()).value?.type).toBe('hello');
      const status = await withTimeout(
        client.request('status', {}),
        1_000,
        'A watch blocked a request on the shared OutlineClient',
      );
      expect(status.ok).toBe(true);
    } finally {
      await iterator.return?.();
      client.close();
      await runtime.stop();
    }
  });

  test('keeps a desktop subscription alive beyond the finite command timeout', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const subscriptionClient = new OutlineClient(runtime.descriptor, { requestTimeoutMs: 40 });
    const boundedClient = new OutlineClient(runtime.descriptor, { requestTimeoutMs: 40 });
    const subscription = subscriptionClient.watchSubscription()[Symbol.asyncIterator]();
    const bounded = boundedClient.watch()[Symbol.asyncIterator]();
    try {
      expect((await subscription.next()).value?.type).toBe('hello');
      expect((await bounded.next()).value?.type).toBe('hello');
      await new Promise((resolve) => setTimeout(resolve, 60));

      const operation = await runtime.workspace.mutate(createRequest('After subscription deadline'));
      const live = await subscription.next();
      expect(live.value?.type).toBe('event');
      expect(eventOperationId(live.value)).toBe(operation.operationId);
      await expect(bounded.next()).rejects.toMatchObject({
        outlineError: { code: 'runtime_unavailable', details: { timeoutMs: 40 } },
      });
    } finally {
      await subscription.return?.();
      await bounded.return?.();
      subscriptionClient.close();
      boundedClient.close();
      await runtime.stop();
    }
  });

  test('binds watch cursors to Runtime instance, filter, and Projection', async () => {
    const root = await makeRoot();
    const first = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(first).not.toBeNull();
    if (!first) return;
    const filter = { origin: 'local-user' as const };
    const projection = {
      kind: 'outline' as const,
      targets: {
        target: { selector: { by: 'alias' as const, alias: 'today' as const }, cardinality: 'one' as const },
      },
      depth: 1,
      page: { limit: 100 },
    };
    const firstClient = new OutlineClient(first.descriptor);
    const firstIterator = firstClient.watch({ filter, projection })[Symbol.asyncIterator]();
    const hello = (await firstIterator.next()).value;
    expect(hello?.type).toBe('hello');
    await first.workspace.mutate(createRequest('Projected event'));
    const live = (await firstIterator.next()).value;
    expect(live?.type).toBe('event');
    expect(live?.type === 'event' ? live.event.projection?.nodes : []).toContainEqual(
      expect.objectContaining({ content: expect.objectContaining({ text: 'Projected event' }) }),
    );
    const cursor = live?.cursor;
    await firstIterator.return?.();
    firstClient.close();

    const mismatchClient = new OutlineClient(first.descriptor);
    const mismatch = mismatchClient.watch({ cursor, filter: { origin: 'desktop' }, projection })[Symbol.asyncIterator]();
    expect((await mismatch.next()).value?.type).toBe('hello');
    const filterResync = (await mismatch.next()).value;
    expect(filterResync?.type === 'event' ? filterResync.event.type : undefined).toBe('resync.required');
    expect((await mismatch.next()).value?.type).toBe('end');
    mismatchClient.close();
    await first.stop();

    const restarted = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(restarted).not.toBeNull();
    if (!restarted) return;
    const restartedClient = new OutlineClient(restarted.descriptor);
    try {
      const iterator = restartedClient.watch({ cursor, filter, projection })[Symbol.asyncIterator]();
      expect((await iterator.next()).value?.type).toBe('hello');
      const instanceResync = (await iterator.next()).value;
      expect(instanceResync?.type === 'event' ? instanceResync.event.type : undefined).toBe('resync.required');
      expect((await iterator.next()).value?.type).toBe('end');
    } finally {
      restartedClient.close();
      await restarted.stop();
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

  test('runs private storage maintenance before idle shutdown', async () => {
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
    const orphan = path.join(runtime.workspace.store.recoveryDirectory, `${'f'.repeat(64)}.json`);
    await writeFile(orphan, '{}', { mode: 0o600 });

    await withTimeout(idle, 2_000, 'Runtime did not complete idle maintenance');

    expect(await readdir(runtime.workspace.store.recoveryDirectory)).toEqual([]);
    await waitFor(async () => (await readOutlineRuntimeDescriptor(root)) === null, 2_000);
  });

  test('does not let an old idle drain stop a watch admitted during onIdle', async () => {
    const root = await makeRoot();
    let enterIdle!: () => void;
    let releaseIdle!: () => void;
    const idleEntered = new Promise<void>((resolve) => { enterIdle = resolve; });
    const idleGate = new Promise<void>((resolve) => { releaseIdle = resolve; });
    let idleCalls = 0;
    const runtime = await OutlineRuntimeServer.start({
      root,
      idleTimeoutMs: 10,
      onIdle: async () => {
        idleCalls += 1;
        if (idleCalls !== 1) return;
        enterIdle();
        await idleGate;
      },
    });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const client = new OutlineClient(runtime.descriptor);
    const iterator = client.watch()[Symbol.asyncIterator]();
    try {
      await withTimeout(idleEntered, 2_000, 'Runtime did not enter the gated idle callback');
      expect((await iterator.next()).value?.type).toBe('hello');
      releaseIdle();
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect((await readOutlineRuntimeDescriptor(root))?.instanceId).toBe(runtime.descriptor.instanceId);
      expect((await client.request('status', {})).ok).toBe(true);
    } finally {
      releaseIdle();
      await iterator.return?.();
      client.close();
      await runtime.stop();
    }
  });

  test('stops an idle Runtime after its idle callback rejects', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({
      root,
      idleTimeoutMs: 10,
      onIdle: async () => { throw new Error('injected idle callback failure'); },
    });
    expect(runtime).not.toBeNull();
    if (!runtime) return;

    await waitFor(async () => (await readOutlineRuntimeDescriptor(root)) === null, 2_000);
    await runtime.stop();
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

  test('bounds attach to a live process whose Runtime socket never responds', async () => {
    const root = await makeRoot();
    const paths = resolveOutlineRuntimePaths(root);
    await mkdir(path.dirname(paths.socketPath), { recursive: true, mode: 0o700 });
    const server = http.createServer(() => undefined);
    await listenUnix(server, paths.socketPath);
    await writeFile(paths.descriptorPath, JSON.stringify(runtimeDescriptor(paths.socketPath)), { mode: 0o600 });
    try {
      const supervisor = new OutlineClientSupervisor({ root, noStart: true, startupTimeoutMs: 40 });
      const startedAt = Date.now();
      await expect(supervisor.connect()).rejects.toMatchObject({
        outlineError: { code: 'runtime_unavailable' },
      });
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      await closeServer(server);
    }
  });

  test('fails closed before socket access when a same-major descriptor contract drifts', async () => {
    const root = await makeRoot();
    const paths = resolveOutlineRuntimePaths(root);
    await writeFile(paths.descriptorPath, JSON.stringify({
      ...runtimeDescriptor(paths.socketPath),
      contractDigest: 'f'.repeat(64),
    }), { mode: 0o600 });

    const supervisor = new OutlineClientSupervisor({ root, noStart: true, startupTimeoutMs: 100 });
    await expect(supervisor.connect()).rejects.toMatchObject({
      outlineError: {
        code: 'protocol_incompatible',
        details: {
          expectedDigest: outlineCapabilityContractDigest(),
          actualDigest: 'f'.repeat(64),
        },
      },
    });
  });

  test('retires the current private Runtime through its authenticated lifecycle route', async () => {
    const root = await makeRoot();
    const runtime = await OutlineRuntimeServer.start({ root, idleTimeoutMs: 60_000 });
    expect(runtime).not.toBeNull();
    if (!runtime) return;
    const client = new OutlineClient(runtime.descriptor);
    try {
      expect(await client.requestRuntimeRetirement(
        runtime.descriptor.instanceId,
        'f'.repeat(64),
      )).toBe(true);
      await waitFor(async () => (await readOutlineRuntimeDescriptor(root)) === null, 3_000);
    } finally {
      client.close();
      await runtime.stop();
    }
  });

  test('keeps status and no-start observational when a live Runtime contract differs', async () => {
    const root = await makeRoot();
    const legacy = startLegacyRuntime(root);
    await waitForDescriptor(root);
    const supervisor = new OutlineClientSupervisor({ root, noStart: true, startupTimeoutMs: 500 });
    try {
      await expect(supervisor.status()).rejects.toMatchObject({
        outlineError: { code: 'protocol_incompatible' },
      });
      await expect(supervisor.connect()).rejects.toMatchObject({
        outlineError: { code: 'protocol_incompatible' },
      });
      expect(legacy.exitCode).toBeNull();
      expect(legacy.signalCode).toBeNull();
    } finally {
      await stopChild(legacy);
    }
  });

  test('atomically replaces one authenticated legacy Runtime for simultaneous supervisors', async () => {
    const root = await makeRoot();
    const legacy = startLegacyRuntime(root);
    const oldDescriptor = await waitForDescriptor(root);
    await writeFile(resolveOutlineRuntimePaths(root).retirementPath, JSON.stringify({
      pid: 2_147_483_647,
      claimId: 'retirement:dead-claimant',
      instanceId: oldDescriptor.instanceId,
      createdAt: '2000-01-01T00:00:00.000Z',
    }), { mode: 0o600 });
    const launch = {
      command: process.execPath,
      args: [runtimeEntry, '--root', root],
      env: { TENON_OUTLINE_RUNTIME_IDLE_MS: '60000' },
      detached: false,
    };
    const supervisors = [
      new OutlineClientSupervisor({ root, launch, startupTimeoutMs: 5_000 }),
      new OutlineClientSupervisor({ root, launch, startupTimeoutMs: 5_000 }),
    ];
    const clients: OutlineClient[] = [];
    try {
      clients.push(...await Promise.all(supervisors.map((supervisor) => supervisor.connect())));
      expect(new Set(clients.map((client) => client.descriptor.instanceId)).size).toBe(1);
      expect(clients[0]?.descriptor).toMatchObject({
        contractDigest: outlineCapabilityContractDigest(),
      });
      expect(clients[0]?.descriptor.instanceId).not.toBe(oldDescriptor.instanceId);
      await waitFor(() => legacy.exitCode !== null || legacy.signalCode !== null, 3_000);
    } finally {
      clients.forEach((client) => client.close());
      await stopChild(legacy);
      await stopRuntimeProcess(root);
    }
  });

  test('does not signal a mismatched Runtime whose private lock owner changed', async () => {
    const root = await makeRoot();
    const legacy = startLegacyRuntime(root);
    const descriptor = await waitForDescriptor(root);
    const paths = resolveOutlineRuntimePaths(root);
    const ownerPath = path.join(paths.lockPath, 'owner.json');
    await writeFile(ownerPath, JSON.stringify({
      pid: descriptor.pid,
      instanceId: 'runtime:different-owner',
      createdAt: descriptor.createdAt,
    }), { mode: 0o600 });
    const supervisor = new OutlineClientSupervisor({
      root,
      launch: {
        command: process.execPath,
        args: [runtimeEntry, '--root', root],
        detached: false,
      },
      startupTimeoutMs: 500,
    });
    try {
      await expect(supervisor.connect()).rejects.toMatchObject({
        outlineError: { code: 'protocol_incompatible' },
      });
      expect(legacy.exitCode).toBeNull();
      expect(legacy.signalCode).toBeNull();
    } finally {
      await writeFile(ownerPath, JSON.stringify({
        pid: descriptor.pid,
        instanceId: descriptor.instanceId,
        createdAt: descriptor.createdAt,
      }), { mode: 0o600 });
      await stopChild(legacy);
    }
  });

  test('bounds a command response after a successful attach probe', async () => {
    const root = await makeRoot();
    const paths = resolveOutlineRuntimePaths(root);
    await mkdir(path.dirname(paths.socketPath), { recursive: true, mode: 0o700 });
    const server = http.createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const envelope = JSON.parse(body) as { requestId: string; command: string };
      if (envelope.command !== 'status') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"protocolVersion":1');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        protocolVersion: 1,
        requestId: envelope.requestId,
        ok: true,
        command: 'status',
        data: {
          running: true,
          runtime: { contractDigest: outlineCapabilityContractDigest() },
        },
      }));
    });
    await listenUnix(server, paths.socketPath);
    await writeFile(paths.descriptorPath, JSON.stringify(runtimeDescriptor(paths.socketPath)), { mode: 0o600 });
    const supervisor = new OutlineClientSupervisor({
      root,
      noStart: true,
      startupTimeoutMs: 200,
      requestTimeoutMs: 40,
    });
    const client = await supervisor.connect();
    try {
      await expect(client.request('show', { selector: { by: 'alias', alias: 'today' } })).rejects.toMatchObject({
        outlineError: { code: 'runtime_unavailable', details: { timeoutMs: 40 } },
      });
    } finally {
      client.close();
      await closeServer(server);
    }
  });

  test('bounds a desktop subscription until Runtime sends its hello record', async () => {
    const root = await makeRoot();
    const paths = resolveOutlineRuntimePaths(root);
    await mkdir(path.dirname(paths.socketPath), { recursive: true, mode: 0o700 });
    const server = http.createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Consume the request before holding the response open without a hello.
      }
      response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
      response.flushHeaders();
    });
    await listenUnix(server, paths.socketPath);
    const client = new OutlineClient(runtimeDescriptor(paths.socketPath), { requestTimeoutMs: 40 });
    const subscription = client.watchSubscription()[Symbol.asyncIterator]();
    try {
      await expect(subscription.next()).rejects.toMatchObject({
        outlineError: { code: 'runtime_unavailable', details: { timeoutMs: 40 } },
      });
    } finally {
      await subscription.return?.();
      client.close();
      await closeServer(server);
    }
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

function createTodayChangeSet(text: string): ChangeSet {
  return {
    protocolVersion: 1,
    kind: 'outline.changeset',
    idempotencyKey: `test:${crypto.randomUUID()}`,
    operations: [{
      op: 'create',
      placement: { kind: 'last', parent: {
        target: { selector: { by: 'alias', alias: 'today' }, cardinality: 'one' },
      } },
      nodes: [{ content: { text, marks: [], inlineRefs: [] }, children: [] }],
    }],
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
    contractDigest: '0'.repeat(64),
    runtimeVersion: '1.0.0',
    storageVersion: 1,
    createdAt: '2000-01-01T00:00:00.000Z',
  };
}

function runtimeDescriptor(socketPath: string): RuntimeDescriptor {
  return {
    descriptorVersion: 1,
    transport: 'unix-http',
    socketPath,
    bearerToken: 'a'.repeat(64),
    pid: process.pid,
    instanceId: `runtime:test-${crypto.randomUUID()}`,
    protocolMajors: [1],
    contractDigest: outlineCapabilityContractDigest(),
    runtimeVersion: '1.0.0',
    storageVersion: 1,
    createdAt: new Date().toISOString(),
  };
}

async function listenUnix(server: http.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
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

function startLegacyRuntime(root: string): ChildProcess {
  return spawn(process.execPath, [
    legacyRuntimeEntry,
    '--root', root,
    '--contract-digest', 'f'.repeat(64),
  ], {
    detached: false,
    stdio: 'ignore',
  });
}

async function waitForDescriptor(root: string): Promise<RuntimeDescriptor> {
  let descriptor: RuntimeDescriptor | null = null;
  await waitFor(async () => {
    descriptor = await readOutlineRuntimeDescriptor(root);
    return descriptor !== null;
  }, 3_000);
  if (!descriptor) throw new Error('Legacy Runtime did not publish its descriptor.');
  return descriptor;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 3_000);
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
