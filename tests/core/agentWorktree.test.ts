import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  AgentWorktree,
  type AgentWorktreeMetadata,
  type PreparedAgentWorktree,
} from '../../src/main/agent/worktree/AgentWorktree';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Agent worktrees', () => {
  test('creates a branch worktree and removes it after a clean generation', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData, () => 1234);
    const prepared = await planAndPrepare(worktrees, {
      agentId: 'agent-clean',
      cwd: fixture.source,
    });

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

    const intent = await worktrees.plan({
      agentId: 'agent-create-failure',
      cwd: fixture.source,
      previous: null,
    });
    await expect(worktrees.prepare({
      agentId: 'agent-create-failure',
      intent,
      worktree: null,
    }))
      .rejects.toThrow('metadata admission failed');

    await expect(realpath(createdPath)).rejects.toThrow();
    expect(await gitOutput(fixture.source, ['branch', '--list', 'tenon-agent-*'])).toBe('');
    expect(await gitOutput(fixture.source, ['worktree', 'list', '--porcelain'])).not.toContain(createdPath);
  });

  test('retains changes and resumes only the recorded worktree', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData);
    const prepared = await planAndPrepare(worktrees, {
      agentId: 'agent-dirty',
      cwd: fixture.source,
    });
    await writeFile(join(prepared.cwd, 'tracked.txt'), 'changed\n');

    const settled = await worktrees.settle(prepared.worktree);
    expect(settled.retained).toBe(true);
    expect(settled.worktree).toEqual(prepared.worktree);
    expect(await readFile(join(fixture.source, 'tracked.txt'), 'utf8')).toBe('before\n');

    const resumed = await planAndPrepare(worktrees, {
      agentId: 'agent-dirty',
      cwd: fixture.source,
      previous: settled.worktree,
    });
    expect(resumed.worktree).toEqual(prepared.worktree);
    expect(await readFile(join(resumed.cwd, 'tracked.txt'), 'utf8')).toBe('changed\n');

    await rm(resumed.cwd, { recursive: true, force: true });
    await expect(planAndPrepare(worktrees, {
      agentId: 'agent-dirty',
      cwd: fixture.source,
      previous: settled.worktree,
    })).rejects.toThrow();
  });

  test('persists clean-removal intent only after proving the worktree is unchanged', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData, () => 1234);
    const clean = await planAndPrepare(worktrees, {
      agentId: 'agent-clean-intent',
      cwd: fixture.source,
    });
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

    const dirty = await planAndPrepare(worktrees, {
      agentId: 'agent-dirty-intent',
      cwd: fixture.source,
    });
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
    const prepared = await planAndPrepare(worktrees, {
      agentId: 'agent-dirty-after-intent',
      cwd: fixture.source,
    });
    await writeFile(join(prepared.cwd, 'tracked.txt'), 'changed after intent\n');

    const settled = await worktrees.settle(prepared.worktree, { cleanupStarted: true });

    expect(settled).toEqual({ worktree: prepared.worktree, retained: true });
    expect(await realpath(prepared.cwd)).toBe(prepared.cwd);
    expect(await readFile(join(prepared.cwd, 'tracked.txt'), 'utf8')).toBe('changed after intent\n');
  });

  test('recovers clean removal after the worktree path disappeared but its branch remains', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData, () => 1234);
    const prepared = await planAndPrepare(worktrees, {
      agentId: 'agent-path-gone',
      cwd: fixture.source,
    });

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
    const prepared = await planAndPrepare(worktrees, {
      agentId: 'agent-host-cleaned',
      cwd: fixture.source,
    });

    await git(fixture.source, ['worktree', 'remove', prepared.cwd]);
    await git(fixture.source, ['branch', '-D', prepared.worktree.branch]);

    const settled = await worktrees.settle(prepared.worktree, { cleanupStarted: true });
    expect(settled).toMatchObject({ retained: false, worktree: { removedAt: 1234 } });
  });

  test('recovers a recreated worktree when resume crashes before updating the ledger', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData, () => 1234);
    const initial = await planAndPrepare(worktrees, {
      agentId: 'agent-resume-crash',
      cwd: fixture.source,
    });
    const removed = await worktrees.settle(initial.worktree);
    expect(removed.worktree.removedAt).toBe(1234);

    const recreated = await planAndPrepare(worktrees, {
      agentId: 'agent-resume-crash',
      cwd: fixture.source,
      previous: removed.worktree,
    });
    const recovered = await planAndPrepare(worktrees, {
      agentId: 'agent-resume-crash',
      cwd: fixture.source,
      previous: removed.worktree,
    });

    expect(recovered).toEqual(recreated);
    expect(recovered.worktree.removedAt).toBeNull();
    expect(await realpath(recovered.cwd)).toBe(recovered.cwd);
  });

  test('plans and reports an absent worktree without creating managed state', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData);
    const intent = await worktrees.plan({
      agentId: 'agent-recover-absent',
      cwd: fixture.source,
      previous: null,
    });

    await expect(realpath(intent.path)).rejects.toThrow();
    await expect(realpath(join(fixture.userData, 'agent', 'subagent-worktrees'))).rejects.toThrow();
    expect(await gitOutput(fixture.source, ['branch', '--list', intent.branch])).toBe('');
    expect(await gitOutput(fixture.source, ['worktree', 'list', '--porcelain']))
      .not.toContain(intent.path);

    const recovered = await worktrees.recover({
      agentId: 'agent-recover-absent',
      intent,
      previous: null,
    });

    expect(recovered.status).toBe('absent');
    if (recovered.status !== 'absent') throw new Error('Expected an absent recovery result');
    expect(recovered.intent).toEqual(intent);
    await expect(realpath(recovered.intent.path)).rejects.toThrow();
    await expect(realpath(join(fixture.userData, 'agent', 'subagent-worktrees'))).rejects.toThrow();
    expect(await gitOutput(fixture.source, ['branch', '--list', recovered.intent.branch])).toBe('');
    expect(await gitOutput(fixture.source, ['worktree', 'list', '--porcelain']))
      .not.toContain(recovered.intent.path);
  });

  test('recovers complete metadata only from an existing registered worktree', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData);
    const intent = await worktrees.plan({
      agentId: 'agent-recover-existing',
      cwd: fixture.source,
      previous: null,
    });
    const prepared = await worktrees.prepare({
      agentId: 'agent-recover-existing',
      intent,
      worktree: null,
    });

    const recovered = await worktrees.recover({
      agentId: 'agent-recover-existing',
      intent,
      previous: null,
    });

    expect(recovered).toEqual({ status: 'recovered', prepared });
  });

  test('recovers the persisted clean base after the source checkout advances', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData, () => 1234);
    const intent = await worktrees.plan({
      agentId: 'agent-recover-clean-base',
      cwd: fixture.source,
      previous: null,
    });
    await worktrees.prepare({
      agentId: 'agent-recover-clean-base',
      intent,
      worktree: null,
    });

    await advanceSource(fixture.source, 'source advanced\n');
    const advancedHead = await gitOutput(fixture.source, ['rev-parse', 'HEAD']);
    expect(advancedHead).not.toBe(intent.baseCommit);

    const recovered = await worktrees.recover({
      agentId: 'agent-recover-clean-base',
      intent,
      previous: null,
    });
    expect(recovered.status).toBe('recovered');
    if (recovered.status !== 'recovered') throw new Error('Expected a recovered worktree');
    expect(recovered.prepared.worktree.baseCommit).toBe(intent.baseCommit);
    expect(await gitOutput(recovered.prepared.cwd, ['rev-parse', 'HEAD']))
      .toBe(intent.baseCommit);

    const settled = await worktrees.settle(recovered.prepared.worktree);
    expect(settled).toMatchObject({ retained: false, worktree: { removedAt: 1234 } });
    await expect(realpath(intent.path)).rejects.toThrow();
  });

  test('retains recovered worktree changes against the persisted base after source advances', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData);
    const intent = await worktrees.plan({
      agentId: 'agent-recover-changed-base',
      cwd: fixture.source,
      previous: null,
    });
    const prepared = await worktrees.prepare({
      agentId: 'agent-recover-changed-base',
      intent,
      worktree: null,
    });
    await writeFile(join(prepared.cwd, 'tracked.txt'), 'agent changed\n');

    await advanceSource(fixture.source, 'source advanced\n');
    expect(await gitOutput(fixture.source, ['rev-parse', 'HEAD'])).not.toBe(intent.baseCommit);

    const recovered = await worktrees.recover({
      agentId: 'agent-recover-changed-base',
      intent,
      previous: null,
    });
    expect(recovered.status).toBe('recovered');
    if (recovered.status !== 'recovered') throw new Error('Expected a recovered worktree');
    expect(recovered.prepared.worktree.baseCommit).toBe(intent.baseCommit);

    const settled = await worktrees.settle(recovered.prepared.worktree);
    expect(settled).toEqual({ worktree: recovered.prepared.worktree, retained: true });
    expect(await readFile(join(recovered.prepared.cwd, 'tracked.txt'), 'utf8'))
      .toBe('agent changed\n');
  });

  test('rejects a persisted recovery intent owned by another Agent', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData);
    const intent = await worktrees.plan({
      agentId: 'agent-intent-owner',
      cwd: fixture.source,
      previous: null,
    });

    await expect(worktrees.prepare({
      agentId: 'agent-intent-other',
      intent,
      worktree: null,
    })).rejects.toThrow('Managed Agent worktree intent is invalid');
    await expect(worktrees.recover({
      agentId: 'agent-intent-other',
      intent,
      previous: null,
    })).rejects.toThrow('Managed Agent worktree intent is invalid');
    await expect(worktrees.cleanupResidual({
      agentId: 'agent-intent-other',
      intent,
      previous: null,
    })).rejects.toThrow('Managed Agent worktree intent is invalid');

    await expect(realpath(intent.path)).rejects.toThrow();
    expect(await gitOutput(fixture.source, ['branch', '--list', intent.branch])).toBe('');
  });

  test('reports and safely cleans a pathless worktree registration and branch', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData);
    const intent = await worktrees.plan({
      agentId: 'agent-recover-residual',
      cwd: fixture.source,
      previous: null,
    });
    const prepared = await worktrees.prepare({
      agentId: 'agent-recover-residual',
      intent,
      worktree: null,
    });
    await rm(prepared.cwd, { recursive: true, force: true });

    const recovered = await worktrees.recover({
      agentId: 'agent-recover-residual',
      intent,
      previous: null,
    });

    expect(recovered).toMatchObject({
      status: 'residual',
      registrationPresent: true,
      branchHead: prepared.worktree.baseCommit,
    });
    if (recovered.status !== 'residual') throw new Error('Expected a residual recovery result');

    const cleaned = await worktrees.cleanupResidual({
      agentId: 'agent-recover-residual',
      intent,
      previous: null,
    });
    expect(cleaned.status).toBe('absent');
    expect(await gitOutput(fixture.source, ['branch', '--list', recovered.intent.branch])).toBe('');
    expect(await gitOutput(fixture.source, ['worktree', 'list', '--porcelain']))
      .not.toContain(recovered.intent.path);
  });

  test('preserves a pathless residual branch that contains Agent changes', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData);
    const intent = await worktrees.plan({
      agentId: 'agent-recover-changed',
      cwd: fixture.source,
      previous: null,
    });
    const prepared = await worktrees.prepare({
      agentId: 'agent-recover-changed',
      intent,
      worktree: null,
    });
    await writeFile(join(prepared.cwd, 'tracked.txt'), 'agent change\n');
    await git(prepared.cwd, ['add', 'tracked.txt']);
    await git(prepared.cwd, ['commit', '-m', 'Agent change']);
    const changedHead = await gitOutput(prepared.cwd, ['rev-parse', 'HEAD']);
    await rm(prepared.cwd, { recursive: true, force: true });

    const recovered = await worktrees.recover({
      agentId: 'agent-recover-changed',
      intent,
      previous: null,
    });
    if (recovered.status !== 'residual') throw new Error('Expected a residual recovery result');

    await expect(worktrees.cleanupResidual({
      agentId: 'agent-recover-changed',
      intent,
      previous: null,
    })).rejects.toThrow(
      'Residual Agent worktree branch contains changes',
    );
    expect(await gitOutput(fixture.source, [
      'show-ref', '--hash', `refs/heads/${recovered.intent.branch}`,
    ])).toBe(changedHead);
    expect(await gitOutput(fixture.source, ['worktree', 'list', '--porcelain']))
      .toContain(recovered.intent.path);
  });

  test('recreates a removed feature worktree from its persisted base after primary advances', async () => {
    const fixture = await repositoryFixture();
    const featurePath = join(fixture.root, 'feature-worktree');
    await git(fixture.source, ['worktree', 'add', '-b', 'feature', featurePath]);
    await writeFile(join(featurePath, 'tracked.txt'), 'feature\n');
    await git(featurePath, ['add', 'tracked.txt']);
    await git(featurePath, ['commit', '-m', 'Feature base']);
    const featureCommit = await gitOutput(featurePath, ['rev-parse', 'HEAD']);

    const worktrees = new AgentWorktree(fixture.userData, () => 1234);
    const initial = await planAndPrepare(worktrees, {
      agentId: 'agent-feature-resume',
      cwd: featurePath,
    });
    expect(initial.worktree.baseCommit).toBe(featureCommit);
    expect(await readFile(join(initial.cwd, 'tracked.txt'), 'utf8')).toBe('feature\n');
    const removed = await worktrees.settle(initial.worktree);

    await writeFile(join(fixture.source, 'tracked.txt'), 'primary advanced\n');
    await git(fixture.source, ['add', 'tracked.txt']);
    await git(fixture.source, ['commit', '-m', 'Advance primary']);
    const primaryCommit = await gitOutput(fixture.source, ['rev-parse', 'HEAD']);
    expect(primaryCommit).not.toBe(featureCommit);

    const resumed = await planAndPrepare(worktrees, {
      agentId: 'agent-feature-resume',
      cwd: removed.worktree.sourceCwd,
      previous: removed.worktree,
    });

    expect(resumed.worktree.baseCommit).toBe(featureCommit);
    expect(await gitOutput(resumed.cwd, ['rev-parse', 'HEAD'])).toBe(featureCommit);
    expect(await readFile(join(resumed.cwd, 'tracked.txt'), 'utf8')).toBe('feature\n');
  });

  test('keeps a removed worktree sandbox closed until resume recreates it', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData, () => 1234);
    const prepared = await planAndPrepare(worktrees, {
      agentId: 'agent-closed-window',
      cwd: fixture.source,
    });
    const removed = await worktrees.settle(prepared.worktree);

    expect(worktrees.sandboxPaths(removed.worktree)).toEqual({
      writablePaths: [],
      protectedGitObjectStores: [],
    });
  });

  test('retains an unrecorded worktree that changed before crash recovery', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData, () => 1234);
    const initial = await planAndPrepare(worktrees, {
      agentId: 'agent-recovery-change',
      cwd: fixture.source,
    });
    const removed = await worktrees.settle(initial.worktree);
    const recreated = await planAndPrepare(worktrees, {
      agentId: 'agent-recovery-change',
      cwd: fixture.source,
      previous: removed.worktree,
    });
    await writeFile(join(recreated.cwd, 'tracked.txt'), 'recovered commit\n');
    await git(recreated.cwd, ['add', 'tracked.txt']);
    await git(recreated.cwd, ['commit', '-m', 'Unrecorded Agent work']);

    const recovered = await planAndPrepare(worktrees, {
      agentId: 'agent-recovery-change',
      cwd: fixture.source,
      previous: removed.worktree,
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
    const prepared = await planAndPrepare(worktrees, {
      agentId: 'agent-missing-no-intent',
      cwd: fixture.source,
    });

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
    const prepared = await planAndPrepare(worktrees, {
      agentId: 'nested-agent',
      cwd: linkedPath,
    });
    expect(prepared.worktree.sourceCwd).toBe(fixture.source);
    expect(prepared.cwd.startsWith(linkedPath)).toBe(false);
    expect(prepared.worktree.baseCommit).toBe(parent);
  });

  test('rejects a retained worktree whose branch identity changed', async () => {
    const fixture = await repositoryFixture();
    const worktrees = new AgentWorktree(fixture.userData);
    const prepared = await planAndPrepare(worktrees, {
      agentId: 'agent-branch',
      cwd: fixture.source,
    });
    const changed = { ...prepared.worktree, branch: 'unexpected-branch' };
    const intent = await worktrees.plan({
      agentId: 'agent-branch',
      cwd: fixture.source,
      previous: prepared.worktree,
    });

    await expect(worktrees.prepare({
      agentId: 'agent-branch',
      intent,
      worktree: changed,
    })).rejects.toThrow('identity changed');
  });
});

async function planAndPrepare(
  worktrees: AgentWorktree,
  input: {
    readonly agentId: string;
    readonly cwd: string;
    readonly previous?: AgentWorktreeMetadata | null;
  },
): Promise<PreparedAgentWorktree> {
  const previous = input.previous ?? null;
  const intent = await worktrees.plan({
    agentId: input.agentId,
    cwd: input.cwd,
    previous,
  });
  return worktrees.prepare({
    agentId: input.agentId,
    intent,
    worktree: previous,
  });
}

async function advanceSource(source: string, contents: string): Promise<void> {
  await writeFile(join(source, 'tracked.txt'), contents);
  await git(source, ['add', 'tracked.txt']);
  await git(source, ['commit', '-m', 'Advance source']);
}

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
