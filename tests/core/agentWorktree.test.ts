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
