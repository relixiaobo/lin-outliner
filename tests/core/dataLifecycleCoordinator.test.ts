import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  return { coordinator, execution, registry, barrier };
}

describe('data lifecycle startup integration', () => {
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
});
