import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { readOutlineRuntimeDescriptor } from '../../src/outline/client/descriptor';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DataLifecycleCoordinator } from '../../src/main/dataLifecycle/DataLifecycleCoordinator';
import { DataStoreRegistry } from '../../src/main/dataLifecycle/storeRegistry';
import { DataWriterBarrier } from '../../src/main/dataLifecycle/WriterBarrier';
import { RestoredExecutionFence } from '../../src/main/dataLifecycle/ExecutionFence';
import { OutlineRuntimeServer } from '../../src/outline/runtime/server/runtimeServer';
import { OutlineClientSupervisor } from '../../src/outline/client';
import { openLifecycleDatabase } from '../../src/main/dataLifecycle/sqlite';
import { WorkspaceTransactionLog } from '../../src/outline/runtime/storage';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), 'tenon-data-coordinator-')); roots.push(value); return value; }
function create(userData: string, checkpoint?: (name: string) => void | Promise<void>) {
  const registry = new DataStoreRegistry();
  const execution = new RestoredExecutionFence(userData, registry);
  const launch = { command: process.execPath, args: [resolve('src/outline/runtime/server/entry.ts'), '--root', join(userData, 'outline-runtime'), '--content-root', join(userData, 'content')] };
  const supervisor = new OutlineClientSupervisor({ root: join(userData, 'outline-runtime'), contentRoot: join(userData, 'content'), launch, origin: 'desktop' });
  const barrier = new DataWriterBarrier(userData, {
    launch,
    runtime: { quiesce: () => supervisor.quiesceForMaintenance(), initialize: async (token) => { (await supervisor.connect(undefined, token)).close(); await supervisor.shutdown(); } },
    assertNoLiveProducers: () => execution.assertNoLiveProducers(),
  });
  const coordinator = new DataLifecycleCoordinator({ userData, registry, barrier, applicationVersion: '0.8.0',
    checkpoint,
    prepareRestoredExecution: (generation) => execution.retain(generation),
    resumeAutomaticExecution: (generation) => execution.resumeFutureWork(generation) });
  return { coordinator, execution, registry, barrier, supervisor };
}

describe('data lifecycle startup integration', () => {
  test('configuration-only initialization evidence cannot be selected for restoration', async () => {
    const userData = await root();
    await writeFile(join(userData, 'app-preferences.json'), '{}');
    const { coordinator } = create(userData);
    try {
      await coordinator.prepare();
      const checkpoint = (await coordinator.journal.read())!.backupId;
      expect((await coordinator.backups.read(checkpoint))!.files.length).toBeGreaterThan(0);
      expect((await coordinator.inspectBackups()).backups).toEqual([]);
      await expect(coordinator.validateRestoreSource(checkpoint)).rejects.toThrow('complete canonical workspace');
      await expect(coordinator.request({ action: 'restore', backupId: checkpoint, revision: coordinator.state().revision })).rejects.toThrow('complete canonical workspace');
      expect(coordinator.state().phase).toBe('ready');
    } finally { await coordinator.close(); }
  }, 20_000);

  test('a missing established Store blocks both history repair admission and interrupted repair completion', async () => {
    const userData = await root(); let current = create(userData);
    await current.coordinator.prepare();
    const originalManifest = await readFile(join(userData, 'data-manifest.json'), 'utf8');
    await current.coordinator.request({ action: 'repair-history', revision: current.coordinator.state().revision });
    await current.coordinator.close();
    current = create(userData, async (name) => {
      if (name === 'history-projection-installed') {
        await rename(join(userData, 'agent/goals.sqlite'), join(userData, 'retained-goals.sqlite'));
        throw new Error('interrupted repair');
      }
    });
    await current.coordinator.prepare(); await current.coordinator.close();
    current = create(userData);
    try {
      await current.coordinator.prepare();
      expect(current.coordinator.state().phase).toBe('recoveryRequired');
      expect(current.coordinator.state().issues[0]?.message).toContain('agent-goals');
      expect(await readFile(join(userData, 'data-manifest.json'), 'utf8')).toBe(originalManifest);
      expect((await current.registry.inspect(userData)).find((entry) => entry.store.id === 'agent-goals')?.exists).toBe(false);
    } finally { await current.coordinator.close(); }
  }, 20_000);

  test('maintenance reclaims a killed same-contract Runtime without starting a replacement writer', async () => {
    const userData = await root(); const current = create(userData);
    try {
      await current.coordinator.prepare();
      const client = await current.supervisor.connect(); client.close();
      const descriptor = (await readOutlineRuntimeDescriptor(join(userData, 'outline-runtime')))!;
      process.kill(descriptor.pid, 'SIGKILL');
      for (let attempt = 0; attempt < 150; attempt++) {
        try { process.kill(descriptor.pid, 0); } catch { break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      for (let attempt = 0; attempt < 2; attempt++) { await current.barrier.acquire(); await current.barrier.release(); }
      expect((await readOutlineRuntimeDescriptor(join(userData, 'outline-runtime')))?.instanceId).toBe(descriptor.instanceId);
    } finally { await current.coordinator.close(); }
  }, 20_000);
  test('initializes an empty dataset through a fenced real Runtime before committing its baseline', async () => {
    const userData = await root();
    const { coordinator } = create(userData);
    try {
      await coordinator.prepare();
      expect(coordinator.state()).toMatchObject({ phase: 'ready', issues: [] });
      const manifest = JSON.parse(await readFile(join(userData, 'data-manifest.json'), 'utf8'));
      expect(manifest.identityReferences.workspaceId).toBeString();
      const workspace = await new WorkspaceTransactionLog(join(userData, 'outline-runtime/workspace')).load();
      expect(workspace.snapshot?.shared.workspaceId).toBe(manifest.identityReferences.workspaceId);
      expect((await coordinator.journal.read())?.phase).toBe('complete');
    } finally { await coordinator.close(); }
  }, 20_000);

  test('a queued backup prevents a racing Runtime start and resumes at the next startup', async () => {
    const userData = await root();
    const first = create(userData);
    await first.coordinator.prepare();
    expect(first.coordinator.state().phase).toBe('ready');
    await first.coordinator.request({ action: 'backup' });
    await expect(OutlineRuntimeServer.start({ root: join(userData, 'outline-runtime'), contentRoot: join(userData, 'content') })).rejects.toThrow('maintenance is pending');
    await first.coordinator.close();
    const next = create(userData);
    try {
      await next.coordinator.prepare();
      expect(next.coordinator.state().phase).toBe('ready');
      expect((await next.coordinator.inspectBackups()).backups.length).toBeGreaterThanOrEqual(1);
    } finally { await next.coordinator.close(); }
  }, 20_000);

  test('isolates an incompatible Agent database from compatible Outline storage', async () => {
    const userData = await root(); const first = create(userData);
    await first.coordinator.prepare(); await first.coordinator.close();
    const database = openLifecycleDatabase(join(userData, 'agent/goals.sqlite'), false);
    database.exec('PRAGMA user_version=999'); database.close();
    const next = create(userData);
    try {
      await next.coordinator.prepare();
      expect(next.coordinator.state().phase).toBe('recoveryRequired');
      expect(() => next.coordinator.assertDomain('outline')).not.toThrow();
      expect(() => next.coordinator.assertDomain('agent')).toThrow('newer');
    } finally { await next.coordinator.close(); }
  }, 20_000);

  test('a missing established database is a recovery issue rather than a new empty Store', async () => {
    const userData = await root(); const first = create(userData);
    await first.coordinator.prepare(); await first.coordinator.close();
    await rm(join(userData, 'agent/goals.sqlite'));
    const next = create(userData);
    try {
      await next.coordinator.prepare();
      expect(next.coordinator.state().issues).toContainEqual(expect.objectContaining({ storeId: 'agent-goals', reason: 'invalid-data' }));
      expect(() => next.coordinator.assertDomain('outline')).not.toThrow();
      await expect(readFile(join(userData, 'agent/goals.sqlite'))).rejects.toThrow();
    } finally { await next.coordinator.close(); }
  }, 30_000);

  test('restores a good backup over a damaged Task ledger while retaining its exact damaged bytes', async () => {
    const userData = await root(); let current = create(userData);
    await current.coordinator.prepare();
    await current.coordinator.request({ action: 'backup' }); await current.coordinator.close();
    current = create(userData); await current.coordinator.prepare();
    const available = await current.coordinator.inspectBackups();
    const backup = available.backups.find((entry) => entry.fileCount > 0 && entry.purpose === 'backup')!;
    expect(backup).toBeDefined();
    await current.coordinator.request({ action: 'restore', backupId: backup.id, revision: available.revision });
    await current.coordinator.close();
    await writeFile(join(userData, 'agent/goals.sqlite'), 'retained damaged ledger');
    const restored = create(userData);
    try {
      await restored.coordinator.prepare();
      expect(restored.coordinator.state()).toMatchObject({ phase: 'ready', automaticExecutionPaused: true });
      const operation = (await restored.coordinator.journal.read())!;
      const original = await restored.coordinator.backups.read(operation.backupId);
      expect(original?.purpose).toBe('retention');
      expect(await readFile(join(restored.coordinator.backups.path(operation.backupId), 'files/agent/goals.sqlite'), 'utf8')).toBe('retained damaged ledger');
      expect((await restored.registry.inspect(userData, true)).every((entry) => !entry.issue)).toBe(true);
    } finally { await restored.coordinator.close(); }
  }, 40_000);

  test('resumes a journal-proven empty database created before the first transaction started', async () => {
    const userData = await root();
    let interrupted = false;
    const first = create(userData, (name) => {
      if (!interrupted && name === 'before-database-transaction') { interrupted = true; throw new Error('interrupted initialization'); }
    });
    await first.coordinator.prepare();
    expect(first.coordinator.state().phase).toBe('recoveryRequired');
    await first.coordinator.close();
    const next = create(userData);
    try {
      await next.coordinator.prepare();
      expect(next.coordinator.state()).toMatchObject({ phase: 'ready', issues: [] });
      expect((await next.registry.inspect(userData, true)).every((entry) => entry.exists && !entry.issue)).toBe(true);
    } finally { await next.coordinator.close(); }
  }, 30_000);

  test('an explicit verified restore can replace a failed installation without discarding its journal', async () => {
    const userData = await root(); let current = create(userData);
    await current.coordinator.prepare();
    await current.coordinator.request({ action: 'backup' }); await current.coordinator.close();
    current = create(userData); await current.coordinator.prepare();
    const state = await current.coordinator.inspectBackups();
    const source = state.backups.find((entry) => entry.verified && entry.purpose === 'backup')!;
    await current.coordinator.request({ action: 'restore', backupId: source.id, revision: state.revision });
    await current.coordinator.close();
    const failed = create(userData, (name) => { if (name === 'installed-root:agent') throw new Error('interrupted installation'); });
    await failed.coordinator.prepare();
    const previous = (await failed.coordinator.journal.read())!;
    expect(failed.coordinator.state().phase).toBe('recoveryRequired');
    await failed.coordinator.validateRestoreSource(source.id);
    await failed.coordinator.request({ action: 'restore', backupId: source.id, revision: failed.coordinator.state().revision });
    const replacement = (await failed.coordinator.journal.read())!;
    expect(replacement.supersedes).toBe(previous.id);
    expect(await failed.coordinator.journal.hasQuiescedPredecessor(replacement)).toBe(true);
    await expect(failed.coordinator.cancelQueuedRequest(replacement.id)).rejects.toThrow('can no longer be cancelled');
    await failed.coordinator.close();
    const final = create(userData);
    try {
      await final.coordinator.prepare();
      expect(final.coordinator.state()).toMatchObject({ phase: 'ready', automaticExecutionPaused: true });
      const retained = JSON.parse(await readFile(join(userData, 'data-lifecycle/operations', previous.id, 'superseded.json'), 'utf8'));
      expect(retained.operation.id).toBe(previous.id);
      expect(retained.supersededBy).toBe(replacement.id);
    } finally { await final.coordinator.close(); }
  }, 40_000);
});
