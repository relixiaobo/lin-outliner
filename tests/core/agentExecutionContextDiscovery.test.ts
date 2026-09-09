import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import os from 'node:os';
import path from 'node:path';
import { pendingExecutionContext, resolveExecutionAddress } from '../../src/main/agent/tasks/ExecutionContext';
import { discoverExecutionContext, validateDiscoveredSources } from '../../src/main/agent/tasks/ExecutionContextDiscovery';
import { ToolTaskStore } from '../../src/main/agent/tasks/ToolTaskStore';
import { ToolTaskService, type ToolTaskHost } from '../../src/main/agent/tasks/ToolTaskService';
import { ToolPayloadStore } from '../../src/main/agent/persistence/ToolPayloadStore';
import type { ThreadContextPayload } from '../../src/core/agent/protocol';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';

const sourceTurnId = '00000000-0000-7000-8000-000000000003';

function bindEvidenceHost(service: ToolTaskService, payloads: ToolPayloadStore,
  write: NonNullable<ToolTaskHost['contextEvidence']>['write'] = (owner, payload) => payloads.writeContext(owner, payload),
): void {
  service.bindHost({ ownerExists: () => true, readDeliveryAdmission: async () => null,
    startCompletionTurn: async () => false, taskChanged: () => {}, contextEvidence: {
      write, read: (owner, ref) => payloads.readContext(owner, ref),
      prune: (owner) => payloads.pruneUnreferencedContexts(owner, [], []),
    } });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(predicate()).toBe(true);
}

describe('execution context discovery', () => {
  test.each(['fsmonitor', 'clean', 'process'])(
    'automatic discovery does not execute the configured %s extension', async (extension) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'tenon-context-'));
      const git = (...args: string[]) => execFileSync('git', ['-C', root,
        '-c', 'user.name=Context Test', '-c', 'user.email=context@example.test',
        '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' });
      try {
        git('init'); await writeFile(path.join(root, 'tracked.txt'), 'original');
        git('add', 'tracked.txt'); git('commit', '-m', 'Initial fixture');
        await writeFile(path.join(root, 'tracked.txt'), 'modified');
        if (extension === 'fsmonitor') {
          const script = path.join(root, 'monitor.sh');
          await writeFile(script, '#!/bin/sh\nprintf ran > extension-ran\nprintf "token\\0"\n', { mode: 0o700 });
          git('config', 'core.fsmonitor', script);
        } else {
          await writeFile(path.join(root, '.gitattributes'), '*.txt filter=probe\n');
          git('config', `filter.probe.${extension}`, 'printf ran > extension-ran; cat');
        }
        const result = await discoverExecutionContext(pendingExecutionContext(
          await resolveExecutionAddress({ defaultCwd: root }), {
            capability: 'read-only', isolation: 'unsandboxed', writablePaths: [],
          }));
        expect(await stat(path.join(root, 'extension-ran')).then(() => true, () => false)).toBe(false);
        expect(result.context.snapshot.discovery).toBe(extension === 'fsmonitor' ? 'complete' : 'unavailable');
      } finally { await rm(root, { recursive: true, force: true }); }
    },
  );

  test.each(['tracked edit', 'HEAD change', 'branch change', 'unavailable worktree'])(
    'rejects snapshot reuse after a Git %s within the freshness window', async (change) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'tenon-context-'));
      const git = (...args: string[]) => execFileSync('git', ['-C', root,
        '-c', 'user.name=Context Test', '-c', 'user.email=context@example.test',
        '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' });
      try {
        git('init');
        await writeFile(path.join(root, 'tracked.txt'), 'original');
        git('add', 'tracked.txt');
        git('commit', '-m', 'Initial fixture');
        const result = await discoverExecutionContext(pendingExecutionContext(
          await resolveExecutionAddress({ defaultCwd: root }), {
            capability: 'full-access', isolation: 'unsandboxed', writablePaths: [],
          }));
        expect(result.context.snapshot.discovery).toBe('complete');
        expect(result.context.snapshot.facts.find((fact) => fact.kind === 'git')?.text).toContain('(clean)');
        expect(await validateDiscoveredSources(result)).toBe(true);
        if (change === 'tracked edit') await writeFile(path.join(root, 'tracked.txt'), 'modified');
        else if (change === 'HEAD change') git('commit', '--allow-empty', '-m', 'Next fixture');
        else if (change === 'branch change') git('checkout', '-b', 'next-fixture');
        else await rm(path.join(root, '.git'), { recursive: true, force: true });
        expect(Date.now() - result.context.snapshot.capturedAt).toBeLessThan(5_000);
        expect(await validateDiscoveredSources(result)).toBe(false);
      } finally { await rm(root, { recursive: true, force: true }); }
    },
  );

  test.each(['committed', 'taskExecutionContext', 'executionContextObservation'])(
    'retains foreground discovery through output consumption when %s', async (pauseAt) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'tenon-context-'));
      const database = new Database(':memory:');
      const store = new ToolTaskStore(database as unknown as SqliteDatabase);
      const payloads = new ToolPayloadStore(path.join(root, 'payloads'));
      const service = new ToolTaskService(store, path.join(root, 'tasks'));
      const gate = Promise.withResolvers<void>();
      let paused = false;
      bindEvidenceHost(service, payloads, async (owner, payload) => {
        if (payload.kind === pauseAt) { paused = true; await gate.promise; }
        return payloads.writeContext(owner, payload);
      });
      try {
        await service.initialize();
        const task = await service.start({ ownerThreadId: 'thread', sourceTurnId, sourceItemId: 'bash',
          producer: 'bash', description: 'Foreground fixture', command: 'printf foreground', cwd: root,
          env: process.env, backgroundEnabled: false, timeoutMs: 5_000 });
        expect((await service.waitForTerminal(task.taskId, 'thread', 5_000))?.state).toBe('succeeded');
        expect((await service.output(task.taskId, 'thread'))?.stdout).toBe('foreground');
        await waitUntil(() => pauseAt === 'committed' ? !!store.contextSuccessor(task.taskId) : paused);
        await service.consumeForeground(task.taskId, 'thread');
        expect(store.read(task.taskId)).toMatchObject({ detailState: 'cleared',
          executionContext: task.executionContext });
        expect(await stat(task.detailPath).catch(() => null)).toBeNull();
        expect(service.list('thread')).toHaveLength(0);
        gate.resolve();
        await waitUntil(() => !!store.contextSuccessor(task.taskId));
        const successor = store.contextSuccessor(task.taskId)!;
        expect(store.pendingContextObservations('thread')).toEqual([successor]);
        const observation = await service.readContextObservation(task.taskId, successor.ref);
        expect(observation).not.toBeNull();
        expect(await payloads.copyContextToThread(task.taskId, 'thread', observation!.admissionRef)).toBe(true);
        expect(await payloads.copyContextToThread(task.taskId, 'thread', successor.ref)).toBe(true);
        store.settleContextObservation(task.taskId, 'delivered');
        await service.pruneContextOwner(task.taskId);
        expect(await payloads.readContext(task.taskId, successor.ref)).toBeNull();
        expect((await payloads.readContext('thread', successor.ref))?.kind).toBe('executionContextObservation');
        expect((await payloads.readContext('thread', observation!.admissionRef))?.kind).toBe('taskExecutionContext');
        expect(store.pendingContextObservations('thread')).toHaveLength(0);
        expect(store.missingContextSuccessors('thread', '', 4)).toHaveLength(0);
      } finally {
        gate.resolve();
        await service.close(2_000);
        database.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test('drains delayed discovery writes before deleting a consumed foreground owner', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tenon-context-'));
    const database = new Database(':memory:');
    const store = new ToolTaskStore(database as unknown as SqliteDatabase);
    const payloads = new ToolPayloadStore(path.join(root, 'payloads'));
    const service = new ToolTaskService(store, path.join(root, 'tasks'));
    const gate = Promise.withResolvers<void>();
    let paused = false;
    let taskId = '';
    let deleted = false;
    const refs: Awaited<ReturnType<ToolPayloadStore['writeContext']>>[] = [];
    bindEvidenceHost(service, payloads, async (owner, payload) => {
      if (payload.kind === 'executionContextObservation') { paused = true; await gate.promise; }
      const ref = await payloads.writeContext(owner, payload);
      refs.push(ref);
      return ref;
    });
    try {
      await service.initialize();
      await service.runHostOperation({ ownerThreadId: 'thread', sourceTurnId, sourceItemId: 'fixture', producer: 'test',
        executionContext: pendingExecutionContext(await resolveExecutionAddress({ defaultCwd: root }), {
          capability: 'full-access', isolation: 'unsandboxed', writablePaths: [],
        }), onAdmitted: async (task) => { taskId = task.taskId; },
        execute: async () => ({ result: null, success: true }) });
      await waitUntil(() => paused);
      await service.consumeForeground(taskId, 'thread');
      const deletion = service.deleteOwner('thread').then(() => { deleted = true; });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(deleted).toBe(false);
      gate.resolve();
      await deletion;
      expect(store.read(taskId)).toBeNull();
      expect(store.pendingContextObservations('thread')).toHaveLength(0);
      expect(refs).toHaveLength(2);
      for (const ref of refs) expect(await payloads.readContext(taskId, ref)).toBeNull();
    } finally {
      gate.resolve();
      await service.close(2_000);
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('recovers every missing successor across pages and retries a persisted gap on restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tenon-context-'));
    const databasePath = path.join(root, 'tasks.sqlite');
    let database = new Database(databasePath);
    let store = new ToolTaskStore(database as unknown as SqliteDatabase);
    let service = new ToolTaskService(store, path.join(root, 'tasks'));
    const payloads = new ToolPayloadStore(path.join(root, 'payloads'));
    const taskIds: string[] = [];
    let operations = 0;
    try {
      service.bindHost({ ownerExists: () => true, readDeliveryAdmission: async () => null,
        startCompletionTurn: async () => false, taskChanged: () => {} });
      await service.initialize();
      const address = await resolveExecutionAddress({ defaultCwd: root });
      for (let index = 0; index < 33; index += 1) {
        await service.runHostOperation({ ownerThreadId: 'thread', sourceTurnId,
          sourceItemId: `fixture-${index}`, producer: 'test',
          executionContext: pendingExecutionContext(address, {
            capability: 'full-access', isolation: 'unsandboxed', writablePaths: [],
          }), onAdmitted: async (task) => { taskIds.push(task.taskId); },
          execute: async () => { operations += 1; return { result: null, success: true }; } });
        await service.consumeForeground(taskIds[index]!, 'thread');
      }
      await service.close(2_000);
      database.close();
      database = new Database(databasePath);
      store = new ToolTaskStore(database as unknown as SqliteDatabase);
      service = new ToolTaskService(store, path.join(root, 'tasks'));
      const failedTaskId = [...taskIds].sort()[0]!;
      const writes = new Set<string>();
      let activeWrites = 0;
      let maxActiveWrites = 0;
      bindEvidenceHost(service, payloads, async (owner, payload) => {
        writes.add(owner);
        if (owner === failedTaskId) throw new Error('Fixture payload storage unavailable');
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        try { return await payloads.writeContext(owner, payload); }
        finally { activeWrites -= 1; }
      });
      await service.initialize();
      await waitUntil(() => taskIds.filter((taskId) => store.contextSuccessor(taskId)).length === 32);
      expect(writes.size).toBe(33);
      expect(maxActiveWrites).toBeLessThanOrEqual(4);
      expect(store.missingContextSuccessors('thread', '', 4).map((task) => task.taskId)).toEqual([failedTaskId]);
      const committed = taskIds.filter((taskId) => taskId !== failedTaskId)
        .map((taskId) => store.contextSuccessor(taskId));
      await service.close(2_000);
      database.close();
      database = new Database(databasePath);
      store = new ToolTaskStore(database as unknown as SqliteDatabase);
      service = new ToolTaskService(store, path.join(root, 'tasks'));
      writes.clear();
      bindEvidenceHost(service, payloads, async (owner, payload) => {
        writes.add(owner);
        return payloads.writeContext(owner, payload);
      });
      await service.initialize();
      await waitUntil(() => store.missingContextSuccessors('thread', '', 4).length === 0);
      expect(taskIds.every((taskId) => store.contextSuccessor(taskId))).toBe(true);
      expect(writes).toEqual(new Set([failedTaskId]));
      expect(taskIds.filter((taskId) => taskId !== failedTaskId)
        .map((taskId) => store.contextSuccessor(taskId))).toEqual(committed);
      expect(operations).toBe(33);
    } finally {
      await service.close(2_000);
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('walks ancestor scopes and preserves nested instruction applicability', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tenon-context-'));
    try {
      const nested = path.join(root, 'src');
      await mkdir(nested, { recursive: true });
      await writeFile(path.join(root, 'AGENTS.md'), 'Use the project test command.');
      await writeFile(path.join(nested, 'AGENTS.md'), 'Keep source changes typed.');
      const address = await resolveExecutionAddress({ defaultCwd: nested });
      const admitted = pendingExecutionContext(address, {
        capability: 'full-access', isolation: 'unsandboxed', writablePaths: [],
      });
      const result = await discoverExecutionContext(admitted);

      expect(result.context.snapshot.generation).toBe(1);
      expect(result.context.snapshot.predecessorRef).toBe(admitted.snapshotRef);
      expect(result.context.snapshot.discovery).toBe('complete');
      expect(result.context.snapshot.facts.filter((fact) => fact.kind === 'instruction').map((fact) => fact.scope))
        .toEqual([await realpath(root), await realpath(nested)]);
      expect(result.context.snapshot.facts.some((fact) => fact.text.includes('Keep source changes typed.'))).toBe(true);
      expect(await validateDiscoveredSources(result)).toBe(true);
      await writeFile(path.join(root, 'AGENTS.md'), 'The source changed after discovery.');
      expect(await validateDiscoveredSources(result)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('records bounded source degradation without failing the admitted task', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tenon-context-'));
    try {
      await writeFile(path.join(root, 'AGENTS.md'), 'x'.repeat(100));
      const address = await resolveExecutionAddress({ defaultCwd: root });
      const result = await discoverExecutionContext(pendingExecutionContext(address, {
        capability: 'full-access', isolation: 'unsandboxed', writablePaths: [],
      }), { maxSourceBytes: 12 });

      expect(result.context.snapshot.discovery).toBe('unavailable');
      expect(result.context.snapshot.degradation).toContain('exceeded the discovery byte limit');
      expect(result.context.snapshot.facts.find((fact) => fact.kind === 'instruction')).toBeUndefined();
      expect(result.sources.some((source) => source.path.endsWith('AGENTS.md') && source.state === 'unavailable')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('persists one immutable successor for a host operation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tenon-context-'));
    const database = new Database(':memory:');
    const store = new ToolTaskStore(database as unknown as SqliteDatabase);
    const service = new ToolTaskService(store, path.join(root, 'tasks'));
    const payloads = new ToolPayloadStore(path.join(root, 'payloads'));
    let taskId: string | null = null;
    service.bindHost({
      ownerExists: () => true,
      readDeliveryAdmission: async () => null,
      startCompletionTurn: async () => false,
      taskChanged: () => {},
      contextEvidence: {
        write: (owner: string, payload: ThreadContextPayload) => payloads.writeContext(owner, payload),
        read: (owner: string, ref) => payloads.readContext(owner, ref),
      },
    });
    try {
      await service.initialize();
      await service.runHostOperation({
        ownerThreadId: 'thread', sourceTurnId: '00000000-0000-7000-8000-000000000002', sourceItemId: 'item', producer: 'test',
        executionContext: pendingExecutionContext(await resolveExecutionAddress({ defaultCwd: root }), {
          capability: 'full-access', isolation: 'unsandboxed', writablePaths: [],
        }),
        onAdmitted: async (task) => { taskId = task.taskId; },
        execute: async () => ({ result: null, success: true }),
      });
      for (let attempt = 0; attempt < 50 && !store.contextSuccessor(taskId!); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const successor = store.contextSuccessor(taskId!);
      expect(successor?.ref.kind).toBe('executionContextObservation');
      const observation = await payloads.readContext(taskId!, successor!.ref);
      expect(observation?.kind).toBe('executionContextObservation');
      if (observation?.kind !== 'executionContextObservation') throw new Error('Missing discovery observation');
      expect(observation.executionContext.snapshot.generation).toBe(1);
      expect(observation.executionContext.snapshot.predecessorRef).toBe(
        store.read(taskId!)!.executionContext.snapshotRef,
      );
      expect((await payloads.readContext(taskId!, observation.admissionRef))?.kind).toBe('taskExecutionContext');
      expect(await payloads.copyContextToThread(taskId!, 'thread', observation.admissionRef)).toBe(true);
      expect(await payloads.copyContextToThread(taskId!, 'thread', successor!.ref)).toBe(true);
      expect((await payloads.readContext('thread', observation.admissionRef))?.kind).toBe('taskExecutionContext');
      expect((await payloads.readContext('thread', successor!.ref))?.kind).toBe('executionContextObservation');
      await payloads.pruneUnreferencedContexts(taskId!, [], []);
      expect(await payloads.readContext(taskId!, successor!.ref)).toBeNull();
      expect((await payloads.readContext('thread', successor!.ref))?.kind).toBe('executionContextObservation');
      store.publishContextSuccessor(taskId!, successor.ref, Date.now());
      expect(store.contextSuccessor(taskId!)).toEqual(successor);
    } finally {
      await service.close(2_000);
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('restores a committed successor after Tool Task service restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tenon-context-'));
    const databasePath = path.join(root, 'tasks.sqlite');
    const payloadPath = path.join(root, 'payloads');
    const sourceTurnId = '00000000-0000-7000-8000-000000000003';
    let taskId: string | null = null;
    try {
      const firstDatabase = new Database(databasePath);
      const firstStore = new ToolTaskStore(firstDatabase as unknown as SqliteDatabase);
      const firstPayloads = new ToolPayloadStore(payloadPath);
      const first = new ToolTaskService(firstStore, path.join(root, 'tasks'));
      first.bindHost({ ownerExists: () => true, readDeliveryAdmission: async () => null,
        startCompletionTurn: async () => false, taskChanged: () => {}, contextEvidence: {
          write: (owner: string, payload: ThreadContextPayload) => firstPayloads.writeContext(owner, payload),
          read: (owner: string, ref) => firstPayloads.readContext(owner, ref),
        } });
      await first.initialize();
      await first.runHostOperation({ ownerThreadId: 'thread', sourceTurnId, sourceItemId: 'restart', producer: 'test',
        executionContext: pendingExecutionContext(await resolveExecutionAddress({ defaultCwd: root }), {
          capability: 'full-access', isolation: 'unsandboxed', writablePaths: [],
        }), onAdmitted: async (task) => { taskId = task.taskId; }, execute: async () => ({ result: null, success: true }) });
      for (let attempt = 0; attempt < 50 && !firstStore.contextSuccessor(taskId!); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      const before = firstStore.contextSuccessor(taskId!);
      expect(before).not.toBeNull();
      await first.close(2_000);
      firstDatabase.close();

      const secondDatabase = new Database(databasePath);
      const secondStore = new ToolTaskStore(secondDatabase as unknown as SqliteDatabase);
      const second = new ToolTaskService(secondStore, path.join(root, 'tasks'));
      second.bindHost({ ownerExists: () => true, readDeliveryAdmission: async () => null,
        startCompletionTurn: async () => false, taskChanged: () => {}, contextEvidence: {
          write: (owner: string, payload: ThreadContextPayload) => firstPayloads.writeContext(owner, payload),
          read: (owner: string, ref) => firstPayloads.readContext(owner, ref),
        } });
      await second.initialize();
      expect(secondStore.contextSuccessor(taskId!)).toEqual(before);
      await second.close(2_000);
      secondDatabase.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
