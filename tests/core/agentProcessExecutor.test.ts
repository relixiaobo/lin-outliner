import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createFolderCapabilitySnapshot } from '../../src/main/agentFolderCapabilities';
import { sanitizeAgentProcessEnv } from '../../src/main/agentProcessExecutor';
import { runAgentToolProcess } from '../../src/main/agentToolProcess';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('agent process executor', () => {
  test('allows the workdir while denying an ungranted user folder', async () => {
    const root = await mkdtemp(path.join(homedir(), '.tenon-process-sandbox-'));
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    roots.push(root);
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(path.join(workspace, 'inside.txt'), 'inside');
    await writeFile(path.join(outside, 'outside.txt'), 'outside');
    const capabilities = createFolderCapabilitySnapshot({
      workspaceRoot: workspace,
      includeSystemRoots: true,
    }, []);

    const inside = await runAgentToolProcess('/bin/cat', [path.join(workspace, 'inside.txt')], workspace, 10_000, { capabilities });
    const denied = await runAgentToolProcess('/bin/cat', [path.join(outside, 'outside.txt')], workspace, 10_000, { capabilities });

    expect(inside).toMatchObject({ exitCode: 0, stdout: 'inside' });
    if (process.platform === 'darwin') {
      expect(denied.exitCode).not.toBe(0);
      expect(denied.stderr).toMatch(/operation not permitted/i);
    }
  });

  test('a remembered folder enables both reads and writes for descendants', async () => {
    const root = await mkdtemp(path.join(homedir(), '.tenon-process-grant-'));
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    roots.push(root);
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(path.join(outside, 'source.txt'), 'source');
    const capabilities = createFolderCapabilitySnapshot({
      workspaceRoot: workspace,
      includeSystemRoots: true,
    }, [outside]);

    const read = await runAgentToolProcess('/bin/cat', [path.join(outside, 'source.txt')], workspace, 10_000, { capabilities });
    const target = path.join(outside, 'written.txt');
    const write = await runAgentToolProcess('/usr/bin/touch', [target], workspace, 10_000, { capabilities });

    expect(read).toMatchObject({ exitCode: 0, stdout: 'source' });
    expect(write.exitCode).toBe(0);
    expect(await readFile(target, 'utf8')).toBe('');
  });

  test('does not inherit provider credentials into child processes', () => {
    const env = sanitizeAgentProcessEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      OPENAI_API_KEY: 'secret',
      GITHUB_TOKEN: 'secret',
      SAFE_VALUE: 'visible',
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/tmp/home', SAFE_VALUE: 'visible' });
  });

  test('applies explicit environment overrides after removing credentials', async () => {
    const root = await mkdtemp(path.join(homedir(), '.tenon-process-env-'));
    roots.push(root);

    const result = await runAgentToolProcess('/usr/bin/env', [], root, 10_000, {
      env: {
        TENON_PROCESS_TEST: 'visible',
        OPENAI_API_KEY: 'secret',
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('TENON_PROCESS_TEST=visible');
    expect(result.stdout).not.toContain('OPENAI_API_KEY=');
  });

  test('keeps explicit write denials inside an otherwise writable capability root', async () => {
    if (process.platform !== 'darwin') return;
    const root = await mkdtemp(path.join(homedir(), '.tenon-process-deny-'));
    roots.push(root);
    const protectedDir = path.join(root, '.agents', 'skills');
    await mkdir(protectedDir, { recursive: true });
    const capabilities = createFolderCapabilitySnapshot({
      workspaceRoot: root,
      includeSystemRoots: true,
      deniedWrites: [{ path: protectedDir, recursive: true }],
    }, []);

    const allowed = await runAgentToolProcess('/bin/zsh', ['-c', 'printf ok > ordinary.txt'], root, 10_000, { capabilities });
    expect(allowed.exitCode).toBe(0);
    const denied = await runAgentToolProcess('/bin/zsh', ['-c', 'printf blocked > .agents/skills/SKILL.md'], root, 10_000, { capabilities });
    expect(denied.exitCode).not.toBe(0);
  });
});
