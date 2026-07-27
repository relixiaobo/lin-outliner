import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AgentProcessExecutor,
  sanitizeAgentProcessEnv,
} from '../../src/main/agent/capabilities/agentProcessExecutor';
import { runAgentToolProcess } from '../../src/main/agent/capabilities/agentToolProcess';

const roots: string[] = [];

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
