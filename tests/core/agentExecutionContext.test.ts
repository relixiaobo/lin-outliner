import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeTaskExecutionContext } from '../../src/core/agent/executionContext';
import { pendingExecutionContext, resolveExecutionAddress, revalidateExecutionContext, validateExecutionContext } from '../../src/main/agent/tasks/ExecutionContext';
import { ToolTaskStore } from '../../src/main/agent/tasks/ToolTaskStore';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';
import { ToolTaskService } from '../../src/main/agent/tasks/ToolTaskService';
import { createLocalTools } from '../../src/main/agent/capabilities/agentLocalTools';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tenon-execution-')));
  roots.push(root);
  await mkdir(join(root, 'a'));
  await mkdir(join(root, 'b'));
  return root;
}
const policy = { capability: 'full-access', isolation: 'unsandboxed', writablePaths: [], mutation: true } as const;
const owner = '00000000-0000-7000-8000-000000000001';
const turn = '00000000-0000-7000-8000-000000000002';

describe('task execution context', () => {
  test('canonicalizes per-call addresses without remembering cwd and preserves symlink entry deletion', async () => {
    const root = await fixture();
    await writeFile(join(root, 'b', 'file'), 'keep');
    await symlink(join(root, 'b', 'file'), join(root, 'a', 'link'));
    const first = await resolveExecutionAddress({ defaultCwd: root, cwd: 'a', targets: ['link'] });
    expect(first.targets).toEqual([join(root, 'b', 'file')]);
    expect(first.scopes[0]?.directory).toBe(join(root, 'b'));
    const entry = await resolveExecutionAddress({ defaultCwd: root, cwd: 'a', targets: ['link'], followFinalSymlink: false });
    expect(entry.targets).toEqual([join(root, 'a', 'link')]);
    expect((await resolveExecutionAddress({ defaultCwd: root })).cwd).toBe(root);
    await expect(resolveExecutionAddress({ defaultCwd: root, cwd: 'missing' })).rejects.toMatchObject({ code: 'invalid_cwd' });
    await expect(resolveExecutionAddress({ defaultCwd: root, cwd: '' })).rejects.toMatchObject({ code: 'invalid_cwd' });
  });

  test('retains target applicability within a worktree while claiming its shared identity', async () => {
    const root = await fixture();
    execFileSync('git', ['init', '-q', root]);
    const address = await resolveExecutionAddress({ defaultCwd: root, targets: ['a/file', 'b/file'] });
    expect(address.scopes).toHaveLength(2);
    expect(address.scopes[0]!.key).toBe(address.scopes[1]!.key);
    const context = pendingExecutionContext(address, policy);
    expect(decodeTaskExecutionContext(context)).toEqual(context);
    expect(Object.isFrozen(context.snapshot.facts)).toBe(true);
    expect(context.snapshot.generation).toBe(0);
  });

  test('rejects unavailable cwd, redirected targets, changed Git identity and corrupt references', async () => {
    const root = await fixture();
    const directory = pendingExecutionContext(await resolveExecutionAddress({ defaultCwd: root, cwd: 'a' }), policy);
    expect(() => validateExecutionContext({ ...directory, addressRef: '0'.repeat(64) })).toThrow('digest mismatch');
    await rm(join(root, 'a'), { recursive: true });
    await expect(revalidateExecutionContext(directory)).rejects.toMatchObject({ code: 'invalid_cwd' });
    await symlink(join(root, 'b'), join(root, 'a'));
    await expect(revalidateExecutionContext(directory)).rejects.toMatchObject({ code: 'invalid_cwd' });
    const file = pendingExecutionContext(await resolveExecutionAddress({ defaultCwd: root, targets: ['b/file'] }), policy);
    await symlink(join(root, 'b'), join(root, 'b', 'file'));
    await expect(revalidateExecutionContext(file)).rejects.toMatchObject({ code: 'invalid_target' });
    const entry = pendingExecutionContext(await resolveExecutionAddress({ defaultCwd: root, targets: ['b/file'], followFinalSymlink: false }), policy);
    await expect(revalidateExecutionContext(entry)).resolves.toEqual(entry);
    execFileSync('git', ['init', '-q', root]);
    await expect(revalidateExecutionContext(entry)).rejects.toMatchObject({ code: 'invalid_target' });
  });

  test('stops a Host operation before releasing its inherited owner claim', async () => {
    const root = await fixture();
    const db = new Database(':memory:');
    const store = new ToolTaskStore(db as unknown as SqliteDatabase);
    const service = new ToolTaskService(store, join(root, 'tasks'));
    service.bindHost({ ownerExists: () => true, canInheritClaim: () => true,
      readDeliveryAdmission: async () => null, startCompletionTurn: async () => false, taskChanged: () => {} });
    await service.initialize();
    const executionContext = pendingExecutionContext(await resolveExecutionAddress({ defaultCwd: root }), policy);
    const ready = Promise.withResolvers<string>();
    let childWork: Promise<unknown> | undefined;
    let childStopped = false;
    const work = service.runHostOperation({
      ownerThreadId: owner, sourceTurnId: turn, sourceItemId: 'parent', producer: 'delegate_execution', executionContext,
      onAdmitted: async () => {},
      execute: async (signal) => {
        const parent = store.nonterminal()[0]!;
        childWork = service.runHostOperation({
          ownerThreadId: owner, sourceTurnId: turn, sourceItemId: 'child', producer: 'file_write', executionContext,
          inheritedClaimTaskId: parent.taskId, onAdmitted: async () => {},
          execute: async (childSignal) => {
            ready.resolve(parent.taskId);
            await new Promise<void>((resolve) => childSignal.addEventListener('abort', () => resolve(), { once: true }));
            expect(store.read(parent.taskId)?.state).not.toBe('cancelled');
            childStopped = true;
            childSignal.throwIfAborted();
            return { result: null, success: true };
          },
        });
        void childWork.catch(() => {});
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        signal.throwIfAborted();
        return { result: null, success: true };
      },
    });
    void work.catch(() => {});
    try {
      const taskId = await ready.promise;
      expect(store.nonterminal()).toHaveLength(2);
      expect((await service.stop(taskId, owner))?.state).toBe('cancelled');
      await expect(work).rejects.toThrow();
      await expect(childWork!).rejects.toThrow();
      expect(childStopped).toBe(true);
      expect(store.nonterminal()).toHaveLength(0);
      await expect(service.runHostOperation({ ownerThreadId: owner, sourceTurnId: turn, sourceItemId: 'next',
        producer: 'file_write', executionContext, onAdmitted: async () => {},
        execute: async () => ({ result: 'released', success: true }) })).resolves.toBe('released');
    } finally { await service.close(2_000); db.close(); }
  });

  test('rejects a logical file alias redirected after evidence admission', async () => {
    const root = await fixture();
    await writeFile(join(root, 'a', 'file'), 'alpha');
    await writeFile(join(root, 'b', 'file'), 'beta');
    const alias = join(root, 'link');
    await symlink(join(root, 'a', 'file'), alias);
    const db = new Database(':memory:');
    const store = new ToolTaskStore(db as unknown as SqliteDatabase);
    const service = new ToolTaskService(store, join(root, 'tasks'));
    service.bindHost({ ownerExists: () => true, readDeliveryAdmission: async () => null,
      startCompletionTurn: async () => false, taskChanged: () => {} });
    await service.initialize();
    try {
      const tool = createLocalTools({ workspace: { root, scratchRoot: root, readFileState: new Map(), threadId: owner,
        onTaskAdmitted: async () => { await rm(alias); await symlink(join(root, 'b', 'file'), alias); } },
        toolTaskService: service, turnId: turn }).find((tool) => tool.name === 'file_read')!;
      let started = false;
      const result = await tool.execute('read', { file_path: 'link' }, undefined, undefined, () => { started = true; });
      expect(result.details).toMatchObject({ ok: false, error: { code: 'invalid_target' } });
      expect(started).toBe(false);
      expect(store.nonterminal()).toHaveLength(0);
    } finally { await service.close(2_000); db.close(); }
  });

  test('persists host-operation context before mutation, rolls back multi-scope claims, and releases on settlement', async () => {
    const root = await fixture();
    const db = new Database(':memory:');
    const store = new ToolTaskStore(db as unknown as SqliteDatabase);
    const service = new ToolTaskService(store, join(root, 'tasks'));
    service.bindHost({
      ownerExists: () => true, readDeliveryAdmission: async () => null,
      startCompletionTurn: async () => false, taskChanged: () => {},
    });
    await service.initialize();
    const executionContext = pendingExecutionContext(await resolveExecutionAddress({ defaultCwd: root, targets: ['a/file'] }), policy);
    let release!: () => void;
    const ready = Promise.withResolvers<void>();
    const work = service.runHostOperation({
      ownerThreadId: owner, sourceTurnId: turn, sourceItemId: 'write', producer: 'file_write', executionContext,
      onAdmitted: async (task) => { expect(store.read(task.taskId)?.executionContext).toEqual(executionContext); },
      execute: async () => {
        ready.resolve();
        await new Promise<void>((resolve) => { release = resolve; });
        return { result: 'done', success: true };
      },
    });
    await ready.promise;
    try {
      const other = pendingExecutionContext(await resolveExecutionAddress({ defaultCwd: root, targets: ['b/file', 'a/other'] }), policy);
      await expect(service.runHostOperation({
        ownerThreadId: owner, sourceTurnId: turn, sourceItemId: 'conflict', producer: 'file_write', executionContext: other,
        onAdmitted: async () => { throw new Error('Conflict must fail before evidence publication'); },
        execute: async () => { throw new Error('Conflict must fail before mutation'); },
      })).rejects.toMatchObject({ code: 'worktree_busy' });
      expect(store.nonterminal()).toHaveLength(1);
      const independent = pendingExecutionContext(await resolveExecutionAddress({ defaultCwd: root, targets: ['b/file'] }), policy);
      await expect(service.runHostOperation({
        ownerThreadId: owner, sourceTurnId: turn, sourceItemId: 'independent', producer: 'file_write', executionContext: independent,
        onAdmitted: async () => {}, execute: async () => ({ result: 'independent', success: true }),
      })).resolves.toBe('independent');
    } finally {
      release();
      await work;
      await service.close(2_000);
      db.close();
    }
  });

  test('file calls use canonical typed targets and leave another call default unchanged', async () => {
    const root = await fixture();
    await writeFile(join(root, 'a', 'file'), 'alpha');
    await writeFile(join(root, 'b', 'file'), 'beta');
    const tool = createLocalTools({ localRoot: root }).find((tool) => tool.name === 'file_read')!;
    const a = await tool.execute('a', { cwd: 'a', file_path: 'file' });
    const b = await tool.execute('b', { cwd: 'b', file_path: 'file' });
    expect(a.executionContext?.address.targets).toEqual([join(root, 'a', 'file')]);
    expect(b.executionContext?.address.targets).toEqual([join(root, 'b', 'file')]);
    const invalid = await tool.execute('invalid', { file_path: 'file' });
    expect((invalid.details as { ok: boolean }).ok).toBe(false);
  });
});
