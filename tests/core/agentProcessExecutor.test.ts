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

  test('preserves user-owned ambient credentials in child environments', () => {
    const env = sanitizeAgentProcessEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      OPENAI_API_KEY: 'secret',
      GITHUB_TOKEN: 'secret',
      SAFE_VALUE: 'visible',
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      OPENAI_API_KEY: 'secret',
      GITHUB_TOKEN: 'secret',
      SAFE_VALUE: 'visible',
    });
  });

  test('removes only explicitly private injected environment values', async () => {
    const root = await mkdtemp(path.join(homedir(), '.tenon-process-env-'));
    roots.push(root);

    const result = await runAgentToolProcess('/usr/bin/env', [], root, 10_000, {
      env: {
        TENON_PROCESS_TEST: 'visible',
        GITHUB_TOKEN: 'user-owned',
        TENON_PRIVATE_PROVIDER_KEY: 'private',
      },
      privateEnvKeys: ['tenon_private_provider_key'],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('TENON_PROCESS_TEST=visible');
    expect(result.stdout).toContain('GITHUB_TOKEN=user-owned');
    expect(result.stdout).not.toContain('TENON_PRIVATE_PROVIDER_KEY=');
  });

  test('keeps explicit write denials inside an otherwise writable capability root', async () => {
    if (process.platform !== 'darwin') return;
    const root = await mkdtemp(path.join(homedir(), '.tenon-process-deny-'));
    roots.push(root);
    const protectedDir = path.join(root, 'protected');
    await mkdir(protectedDir, { recursive: true });
    const capabilities = createFolderCapabilitySnapshot({
      workspaceRoot: root,
      includeSystemRoots: true,
      deniedWrites: [{ path: protectedDir, recursive: true }],
    }, []);

    const allowed = await runAgentToolProcess('/bin/zsh', ['-c', 'printf ok > ordinary.txt'], root, 10_000, { capabilities });
    expect(allowed.exitCode).toBe(0);
    const denied = await runAgentToolProcess('/bin/zsh', ['-c', 'printf blocked > protected/state.json'], root, 10_000, { capabilities });
    expect(denied.exitCode).not.toBe(0);
  });

  test('allows shell writes under user-owned skill directories', async () => {
    const root = await mkdtemp(path.join(homedir(), '.tenon-process-skill-write-'));
    roots.push(root);
    const skillDir = path.join(root, '.agents', 'skills', 'generated');
    await mkdir(skillDir, { recursive: true });
    const capabilities = createFolderCapabilitySnapshot({
      workspaceRoot: root,
      includeSystemRoots: true,
    }, []);

    const target = path.join(skillDir, 'SKILL.md');
    const result = await runAgentToolProcess('/bin/zsh', ['-c', `printf '# Generated' > ${JSON.stringify(target)}`], root, 10_000, { capabilities });
    expect(result.exitCode).toBe(0);
    expect(await readFile(target, 'utf8')).toBe('# Generated');
  });

  test('protects control state from a process with a broader user folder', async () => {
    if (process.platform !== 'darwin') return;
    const root = await mkdtemp(path.join(homedir(), '.tenon-process-control-'));
    roots.push(root);
    const control = path.join(root, 'control');
    const workspace = path.join(control, 'agent-workdir');
    const scratch = path.join(control, 'agent-scratch');
    const output = path.join(scratch, 'data-cleanup');
    const outside = path.join(root, 'outside');
    await mkdir(workspace, { recursive: true });
    await mkdir(output, { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(control, 'agent-secrets.json'), 'private');
    await writeFile(path.join(workspace, 'inside.txt'), 'inside');
    await writeFile(path.join(scratch, 'attachment.txt'), 'attachment');
    await writeFile(path.join(outside, 'user.txt'), 'user');
    const capabilities = createFolderCapabilitySnapshot({
      workspaceRoot: workspace,
      scratchRoot: scratch,
      includeSystemRoots: true,
      protectedRoots: [control],
    }, [path.parse(root).root]);

    expect((await runAgentToolProcess('/bin/cat', [path.join(outside, 'user.txt')], workspace, 10_000, { capabilities })).exitCode).toBe(0);
    expect((await runAgentToolProcess('/bin/cat', [path.join(workspace, 'inside.txt')], workspace, 10_000, { capabilities })).exitCode).toBe(0);
    expect((await runAgentToolProcess('/bin/cat', [path.join(scratch, 'attachment.txt')], workspace, 10_000, { capabilities })).exitCode).toBe(0);
    expect((await runAgentToolProcess('/usr/bin/touch', [path.join(workspace, 'written.txt')], workspace, 10_000, { capabilities })).exitCode).toBe(0);
    expect((await runAgentToolProcess('/usr/bin/touch', [path.join(output, 'pack.json')], workspace, 10_000, { capabilities })).exitCode).toBe(0);

    const readSecret = await runAgentToolProcess('/bin/cat', [path.join(control, 'agent-secrets.json')], workspace, 10_000, { capabilities });
    const writeControl = await runAgentToolProcess('/usr/bin/touch', [path.join(control, 'workspace.json')], workspace, 10_000, { capabilities });
    const writeAttachment = await runAgentToolProcess('/usr/bin/touch', [path.join(scratch, 'mutated.txt')], workspace, 10_000, { capabilities });
    expect(readSecret.exitCode).not.toBe(0);
    expect(writeControl.exitCode).not.toBe(0);
    expect(writeAttachment.exitCode).not.toBe(0);
  });
});
