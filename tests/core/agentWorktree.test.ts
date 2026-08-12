import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AgentWorktree } from '../../src/main/agent/worktree/AgentWorktree';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Agent worktrees', () => {
  test('creates a branch worktree and removes it after a clean generation', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData, () => 1234);
    const prepared = await worktrees.prepare({ agentId: 'agent-clean', cwd: fixture.source });

    expect(prepared.worktree.sourceCwd).toBe(fixture.source);
    expect(prepared.worktree.path).toBe(prepared.cwd);
    expect(prepared.worktree.branch).toStartWith('tenon-agent-');
    expect(prepared.worktree.removedAt).toBeNull();
    expect(await readFile(join(prepared.cwd, 'tracked.txt'), 'utf8')).toBe('before\n');

    const settled = await worktrees.settle(prepared.worktree);
    expect(settled.retained).toBe(false);
    expect(settled.worktree.removedAt).toBe(1234);
    await expect(realpath(prepared.cwd)).rejects.toThrow();
    await expect(git(fixture.source, ['show-ref', '--verify', `refs/heads/${prepared.worktree.branch}`]))
      .rejects.toThrow();
  });

  test('removes the directory and branch when post-create metadata admission fails', async () => {
    const fixture = await repositoryFixture();
    let createdPath = '';
    const worktrees = new AgentWorktree(fixture.userData, Date.now, (path) => {
      createdPath = path;
      throw new Error('metadata admission failed');
    });

    await expect(worktrees.prepare({ agentId: 'agent-create-failure', cwd: fixture.source }))
      .rejects.toThrow('metadata admission failed');

    await expect(realpath(createdPath)).rejects.toThrow();
    expect(await gitOutput(fixture.source, ['branch', '--list', 'tenon-agent-*'])).toBe('');
    expect(await gitOutput(fixture.source, ['worktree', 'list', '--porcelain'])).not.toContain(createdPath);
  });

  test('retains changes and resumes only the recorded worktree', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData);
    const prepared = await worktrees.prepare({ agentId: 'agent-dirty', cwd: fixture.source });
    await writeFile(join(prepared.cwd, 'tracked.txt'), 'changed\n');

    const settled = await worktrees.settle(prepared.worktree);
    expect(settled.retained).toBe(true);
    expect(settled.worktree).toEqual(prepared.worktree);
    expect(await readFile(join(fixture.source, 'tracked.txt'), 'utf8')).toBe('before\n');

    const resumed = await worktrees.prepare({
      agentId: 'agent-dirty',
      cwd: fixture.source,
      worktree: settled.worktree,
    });
    expect(resumed.worktree).toEqual(prepared.worktree);
    expect(await readFile(join(resumed.cwd, 'tracked.txt'), 'utf8')).toBe('changed\n');

    await rm(resumed.cwd, { recursive: true, force: true });
    await expect(worktrees.prepare({
      agentId: 'agent-dirty',
      cwd: fixture.source,
      worktree: settled.worktree,
    })).rejects.toThrow();
  });

  test('persists clean-removal intent only after proving the worktree is unchanged', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData, () => 1234);
    const clean = await worktrees.prepare({ agentId: 'agent-clean-intent', cwd: fixture.source });
    let cleanIntentObserved = false;

    const cleanSettled = await worktrees.settle(clean.worktree, {
      beforeCleanRemoval: async () => {
        cleanIntentObserved = true;
        expect(await realpath(clean.cwd)).toBe(clean.cwd);
        expect(await gitOutput(fixture.source, [
          'show-ref', '--hash', `refs/heads/${clean.worktree.branch}`,
        ])).toBe(clean.worktree.baseCommit);
      },
    });

    expect(cleanIntentObserved).toBe(true);
    expect(cleanSettled.retained).toBe(false);

    const dirty = await worktrees.prepare({ agentId: 'agent-dirty-intent', cwd: fixture.source });
    await writeFile(join(dirty.cwd, 'tracked.txt'), 'changed\n');
    let dirtyIntentObserved = false;
    const dirtySettled = await worktrees.settle(dirty.worktree, {
      beforeCleanRemoval: () => { dirtyIntentObserved = true; },
    });

    expect(dirtySettled.retained).toBe(true);
    expect(dirtyIntentObserved).toBe(false);
  });

  test('retains a worktree that changed after clean-removal intent was recorded', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData);
    const prepared = await worktrees.prepare({ agentId: 'agent-dirty-after-intent', cwd: fixture.source });
    await writeFile(join(prepared.cwd, 'tracked.txt'), 'changed after intent\n');

    const settled = await worktrees.settle(prepared.worktree, { cleanupStarted: true });

    expect(settled).toEqual({ worktree: prepared.worktree, retained: true });
    expect(await realpath(prepared.cwd)).toBe(prepared.cwd);
    expect(await readFile(join(prepared.cwd, 'tracked.txt'), 'utf8')).toBe('changed after intent\n');
  });

  test('recovers clean removal after the worktree path disappeared but its branch remains', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData, () => 1234);
    const prepared = await worktrees.prepare({ agentId: 'agent-path-gone', cwd: fixture.source });

    await git(fixture.source, ['worktree', 'remove', prepared.cwd]);
    expect(await gitOutput(fixture.source, [
      'show-ref', '--hash', `refs/heads/${prepared.worktree.branch}`,
    ])).toBe(prepared.worktree.baseCommit);

    const settled = await worktrees.settle(prepared.worktree, { cleanupStarted: true });
    expect(settled).toMatchObject({ retained: false, worktree: { removedAt: 1234 } });
    await expect(git(fixture.source, [
      'show-ref', '--verify', `refs/heads/${prepared.worktree.branch}`,
    ])).rejects.toThrow();
  });

  test('recovers clean removal after both the worktree path and branch disappeared', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData, () => 1234);
    const prepared = await worktrees.prepare({ agentId: 'agent-host-cleaned', cwd: fixture.source });

    await git(fixture.source, ['worktree', 'remove', prepared.cwd]);
    await git(fixture.source, ['branch', '-D', prepared.worktree.branch]);

    const settled = await worktrees.settle(prepared.worktree, { cleanupStarted: true });
    expect(settled).toMatchObject({ retained: false, worktree: { removedAt: 1234 } });
  });

  test('recovers a recreated worktree when resume crashes before updating the ledger', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData, () => 1234);
    const initial = await worktrees.prepare({ agentId: 'agent-resume-crash', cwd: fixture.source });
    const removed = await worktrees.settle(initial.worktree);
    expect(removed.worktree.removedAt).toBe(1234);

    const recreated = await worktrees.prepare({
      agentId: 'agent-resume-crash',
      cwd: fixture.source,
      worktree: removed.worktree,
    });
    const recovered = await worktrees.prepare({
      agentId: 'agent-resume-crash',
      cwd: fixture.source,
      worktree: removed.worktree,
    });

    expect(recovered).toEqual(recreated);
    expect(recovered.worktree.removedAt).toBeNull();
    expect(await realpath(recovered.cwd)).toBe(recovered.cwd);
  });

  test('retains an unrecorded worktree that changed before crash recovery', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData, () => 1234);
    const initial = await worktrees.prepare({ agentId: 'agent-recovery-change', cwd: fixture.source });
    const removed = await worktrees.settle(initial.worktree);
    const recreated = await worktrees.prepare({
      agentId: 'agent-recovery-change',
      cwd: fixture.source,
      worktree: removed.worktree,
    });
    await writeFile(join(recreated.cwd, 'tracked.txt'), 'recovered commit\n');
    await git(recreated.cwd, ['add', 'tracked.txt']);
    await git(recreated.cwd, ['commit', '-m', 'Unrecorded Agent work']);

    const recovered = await worktrees.prepare({
      agentId: 'agent-recovery-change',
      cwd: fixture.source,
      worktree: removed.worktree,
    });
    const settled = await worktrees.settle(recovered.worktree);

    expect(recovered.worktree.baseCommit).toBe(initial.worktree.baseCommit);
    expect(settled.retained).toBe(true);
    expect(await realpath(recovered.cwd)).toBe(recovered.cwd);
    expect(await gitOutput(fixture.source, [
      'show-ref', '--hash', `refs/heads/${recovered.worktree.branch}`,
    ])).not.toBe(recovered.worktree.baseCommit);
  });

  test('rejects a missing retained worktree without durable cleanup intent', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData);
    const prepared = await worktrees.prepare({ agentId: 'agent-missing-no-intent', cwd: fixture.source });

    await git(fixture.source, ['worktree', 'remove', prepared.cwd]);

    await expect(worktrees.settle(prepared.worktree)).rejects.toThrow(
      `Retained Agent worktree is missing: ${prepared.cwd}`,
    );
  });

  test('anchors nested Agents at the canonical repository instead of nesting worktrees', async () => {
    const fixture = await repositoryFixture();
    const parent = await gitOutput(fixture.source, ['rev-parse', 'HEAD']);
    const linkedPath = join(fixture.root, 'parent-worktree');
    await git(fixture.source, ['worktree', 'add', '-b', 'parent-agent', linkedPath, parent]);

    const worktrees = new AgentWorktree(fixture.userData);
    const prepared = await worktrees.prepare({ agentId: 'nested-agent', cwd: linkedPath });
    expect(prepared.worktree.sourceCwd).toBe(fixture.source);
    expect(prepared.cwd.startsWith(linkedPath)).toBe(false);
    expect(prepared.worktree.baseCommit).toBe(parent);
  });

  test('rejects a retained worktree whose branch identity changed', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData);
    const prepared = await worktrees.prepare({ agentId: 'agent-branch', cwd: fixture.source });
    const changed = { ...prepared.worktree, branch: 'unexpected-branch' };

    await expect(worktrees.prepare({
      agentId: 'agent-branch',
      cwd: fixture.source,
      worktree: changed,
    })).rejects.toThrow('identity changed');
  });
});

async function repositoryFixture(): Promise<{
  readonly root: string;
  readonly source: string;
  readonly userData: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-agent-worktree-'));
  roots.push(root);
  const source = join(root, 'source');
  const userData = join(root, 'user-data');
  await mkdir(userData);
  await git(root, ['init', source]);
  await git(source, ['config', 'user.name', 'Agent Worktree Test']);
  await git(source, ['config', 'user.email', 'agent-worktree@example.test']);
  await writeFile(join(source, 'tracked.txt'), 'before\n');
  await git(source, ['add', 'tracked.txt']);
  await git(source, ['commit', '-m', 'Initial']);
  return { root, source: await realpath(source), userData };
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args]);
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args]);
  return result.stdout.trim();
}
