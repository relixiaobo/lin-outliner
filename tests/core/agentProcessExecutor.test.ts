import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  AgentProcessExecutor,
  sanitizeAgentProcessEnv,
} from '../../src/main/agent/capabilities/agentProcessExecutor';
import { runAgentToolProcess } from '../../src/main/agent/capabilities/agentToolProcess';
import { AgentWorktree } from '../../src/main/agent/worktree/AgentWorktree';

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('agent process executor', () => {
  test('reads and writes outside the workdir under the host account', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-process-full-access-'));
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    roots.push(root);
    await mkdir(workspace);
    await mkdir(outside);
    const source = path.join(outside, 'source.txt');
    const target = path.join(outside, 'written.txt');
    await writeFile(source, 'full-access');

    const read = await runAgentToolProcess('/bin/cat', [source], workspace, 10_000);
    const write = await runAgentToolProcess('/usr/bin/touch', [target], workspace, 10_000);

    expect(read).toMatchObject({ exitCode: 0, stdout: 'full-access' });
    expect(write.exitCode).toBe(0);
    expect(await readFile(target, 'utf8')).toBe('');
  });

  test('runs shell commands directly without a sandbox adapter', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-process-shell-'));
    roots.push(root);
    const executor = new AgentProcessExecutor();
    const child = await executor.spawnShell({ command: 'printf shell-ok', cwd: root });
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });

    expect(exitCode).toBe(0);
    expect(stdout).toBe('shell-ok');
  });

  test('isolated shell permits worktree writes and blocks writes elsewhere', async () => {
    if (process.platform !== 'darwin') return;
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-process-sandbox-'));
    roots.push(root);
    const worktree = path.join(root, 'worktree');
    const outside = path.join(root, 'outside.txt');
    await mkdir(worktree);
    const executor = new AgentProcessExecutor();
    const child = await executor.spawnShell({
      command: `printf inside > ${JSON.stringify(path.join(worktree, 'inside.txt'))}; printf outside > ${JSON.stringify(outside)}`,
      cwd: worktree,
      sandbox: { writablePaths: [worktree] },
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });

    expect(code).not.toBe(0);
    expect(await readFile(path.join(worktree, 'inside.txt'), 'utf8')).toBe('inside');
    await expect(readFile(outside, 'utf8')).rejects.toThrow();
  });

  test('isolated shell can commit through linked-worktree lock paths', async () => {
    if (process.platform !== 'darwin') return;
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-process-git-sandbox-'));
    roots.push(root);
    const source = path.join(root, 'source');
    const userData = path.join(root, 'user-data');
    await mkdir(userData);
    await git(root, ['init', source]);
    await git(source, ['config', 'user.name', 'Agent Process Test']);
    await git(source, ['config', 'user.email', 'agent-process@example.test']);
    await writeFile(path.join(source, 'tracked.txt'), 'before\n');
    await git(source, ['add', 'tracked.txt']);
    await git(source, ['commit', '-m', 'Initial']);
    const canonicalSource = await realpath(source);
    const worktrees = new AgentWorktree(userData);
    const intent = await worktrees.plan({
      agentId: 'commit-agent',
      cwd: canonicalSource,
      previous: null,
    });
    const prepared = await worktrees.prepare({
      agentId: 'commit-agent',
      intent,
      worktree: null,
    });
    await writeFile(path.join(prepared.cwd, 'tracked.txt'), 'after\n');

    const executor = new AgentProcessExecutor();
    const child = await executor.spawnShell({
      command: 'git add tracked.txt && git commit -m Isolated-change',
      cwd: prepared.cwd,
      sandbox: worktrees.sandboxPaths(prepared.worktree),
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });

    expect(code, stderr).toBe(0);
    expect(await gitOutput(prepared.cwd, ['log', '-1', '--format=%s'])).toBe('Isolated-change');
    expect(await readFile(canonicalSource + '/tracked.txt', 'utf8')).toBe('before\n');
  });

  test('isolated shell cannot mutate the shared Git object database', async () => {
    if (process.platform !== 'darwin') return;
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-process-object-sandbox-'));
    roots.push(root);
    const source = path.join(root, 'source');
    const userData = path.join(root, 'user-data');
    await mkdir(userData);
    await git(root, ['init', source]);
    await git(source, ['config', 'user.name', 'Agent Process Test']);
    await git(source, ['config', 'user.email', 'agent-process@example.test']);
    await writeFile(path.join(source, 'tracked.txt'), 'before\n');
    await git(source, ['add', 'tracked.txt']);
    await git(source, ['commit', '-m', 'Initial']);
    const canonicalSource = await realpath(source);
    const worktrees = new AgentWorktree(userData);
    const intent = await worktrees.plan({
      agentId: 'object-agent',
      cwd: canonicalSource,
      previous: null,
    });
    const prepared = await worktrees.prepare({
      agentId: 'object-agent',
      intent,
      worktree: null,
    });
    const sandbox = worktrees.sandboxPaths(prepared.worktree);
    const objectStore = sandbox.protectedGitObjectStores[0]!;
    const head = await gitOutput(source, ['rev-parse', 'HEAD']);
    const objectPath = path.join(objectStore, head.slice(0, 2), head.slice(2));
    const before = await readFile(objectPath);
    const beforeMode = (await stat(objectPath)).mode;
    const attack = [
      `printf corrupt > ${JSON.stringify(objectPath)}`,
      `unlink ${JSON.stringify(objectPath)}`,
      `chmod 000 ${JSON.stringify(objectPath)}`,
      `touch ${JSON.stringify(path.join(objectStore, 'pack', 'evil.pack'))}`,
      `touch ${JSON.stringify(path.join(objectStore, 'info', 'alternates'))}`,
    ].join('; ');

    const executor = new AgentProcessExecutor();
    const child = await executor.spawnShell({ command: attack, cwd: prepared.cwd, sandbox });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });

    expect(code).not.toBe(0);
    expect(await readFile(objectPath)).toEqual(before);
    expect((await stat(objectPath)).mode).toBe(beforeMode);
    await expect(stat(path.join(objectStore, 'pack', 'evil.pack'))).rejects.toThrow();
    await expect(stat(path.join(objectStore, 'info', 'alternates'))).rejects.toThrow();
    await expect(git(source, ['fsck', '--no-dangling'])).resolves.toBeUndefined();
  });

  test('preserves ambient credentials and removes only explicitly private values', () => {
    expect(sanitizeAgentProcessEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      OPENAI_API_KEY: 'user-owned',
      GITHUB_TOKEN: 'user-owned',
      TENON_PRIVATE_PROVIDER_KEY: 'private',
    }, ['tenon_private_provider_key'])).toEqual({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      OPENAI_API_KEY: 'user-owned',
      GITHUB_TOKEN: 'user-owned',
    });
  });

  test('terminates a detached process group', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-process-terminate-'));
    roots.push(root);
    const executor = new AgentProcessExecutor();
    const child = await executor.spawn({
      command: '/bin/sh',
      args: ['-c', 'sleep 30'],
      cwd: root,
      detached: true,
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });

    executor.terminate(child, 'SIGTERM');
    const result = await closed;
    expect(result.code === null || result.code !== 0).toBe(true);
  });
});

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args]);
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args]);
  return result.stdout.trim();
}
