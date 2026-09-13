import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RestoredExecutionFence } from '../../src/main/dataLifecycle/ExecutionFence';
import { DataStoreRegistry } from '../../src/main/dataLifecycle/storeRegistry';
import { MemoryControlStore } from '../../src/main/agent/extensions/memory/MemoryControlStore';
import { openLifecycleDatabase } from '../../src/main/dataLifecycle/sqlite';

const roots: string[] = [];
async function root() { const path = await mkdtemp(join(tmpdir(), 'tenon-producer-fence-')); roots.push(path); return path; }
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('restored producer admission', () => {
  test('a damaged ledger and missing startup config cannot hide a surviving Task child', async () => {
    const userData = await root(); const id = `task_${randomUUID()}`;
    const directory = join(userData, 'agent/tool-tasks', id); await mkdir(directory, { recursive: true });
    await writeFile(join(userData, 'agent/goals.sqlite'), 'damaged Task ledger');
    const supervisor = spawn('/usr/bin/true', [], { stdio: 'ignore' }); await once(supervisor, 'exit');
    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore', detached: true }); await once(child, 'spawn');
    const exit = once(child, 'exit');
    try {
      await writeFile(join(directory, 'identity.json'), JSON.stringify({ version: 2, taskId: id, nonce: randomUUID(),
        supervisorPid: supervisor.pid, childPid: child.pid }));
      const fence = new RestoredExecutionFence(userData, new DataStoreRegistry());
      await expect(fence.assertNoLiveProducers()).rejects.toThrow('still active');
      child.kill('SIGKILL'); await exit;
      await expect(fence.assertNoLiveProducers()).resolves.toBeUndefined();
      await rm(join(directory, 'identity.json'));
      await expect(fence.assertNoLiveProducers()).rejects.toThrow('no verifiable process identity');
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; } }
  });

  test('prepared Memory publication identities remain fenced when future execution is enabled and reloaded', async () => {
    const userData = await root(); const registry = new DataStoreRegistry();
    await registry.establishVersions(userData, await registry.inspect(userData));
    const path = join(userData, 'agent/memories.sqlite');
    const memory = new MemoryControlStore(path, openLifecycleDatabase(path, false));
    for (const kind of ['stage1', 'stage2', 'reset'] as const) memory.preparePublication({ id: `old:${kind}`, kind,
      status: 'prepared', generation: 1, featureGeneration: 0, resetEpoch: 0, digest: 'fixture', payload: {}, createdAt: 1 });
    memory.close();
    const generation = randomUUID(); await mkdir(join(userData, 'data-lifecycle'), { recursive: true });
    await writeFile(join(userData, 'data-lifecycle/execution-fence.json'), JSON.stringify({ version: 1, generation, paused: true }));
    const fence = new RestoredExecutionFence(userData, registry); await fence.retain(generation); await fence.resumeFutureWork(generation);
    const reloaded = new RestoredExecutionFence(userData, registry); await reloaded.load();
    expect(reloaded.automaticSchedulingAllowed()).toBe(true);
    for (const kind of ['stage1', 'stage2', 'reset']) expect(reloaded.allows('memory-publication', `old:${kind}`)).toBe(false);
    expect(reloaded.allows('memory-publication', 'fresh')).toBe(true);
  });
});
