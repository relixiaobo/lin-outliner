import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  FolderCapabilityService,
  createFolderCapabilitySnapshot,
  snapshotFromRoots,
} from '../../src/main/agentFolderCapabilities';
import {
  AgentProcessExecutor,
  bindAgentProcessCapabilities,
  resetAgentProcessExecutorForTests,
  sanitizeAgentProcessEnv,
} from '../../src/main/agentProcessExecutor';
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

  test('denies shared user data outside the current Home without a folder capability', async () => {
    if (process.platform !== 'darwin') return;
    const root = await mkdtemp(path.join(homedir(), '.tenon-process-shared-user-data-'));
    roots.push(root);
    const capabilities = createFolderCapabilitySnapshot({
      workspaceRoot: root,
      includeSystemRoots: true,
    }, []);

    const result = await runAgentToolProcess('/usr/bin/stat', ['-f', '%HT', '/Users/Shared'], root, 10_000, { capabilities });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/operation not permitted/i);
  });

  test('rejects a process that starts with a snapshot captured before revocation', async () => {
    if (process.platform !== 'darwin') return;
    const root = await mkdtemp(path.join(homedir(), '.tenon-process-stale-snapshot-'));
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    const granted = path.join(root, 'granted');
    await mkdir(workspace);
    await mkdir(granted);
    const target = path.join(granted, 'value.txt');
    await writeFile(target, 'revoked');
    const service = new FolderCapabilityService(path.join(root, 'capabilities.json'));
    await service.grant(granted);
    const snapshot = await service.snapshot({ workspaceRoot: workspace, includeSystemRoots: true });
    resetAgentProcessExecutorForTests();
    const unbind = bindAgentProcessCapabilities(service, []);

    try {
      await service.revoke(granted);
      const result = await runAgentToolProcess('/bin/cat', [target], workspace, 10_000, { capabilities: snapshot });

      expect(result.exitCode).toBeNull();
      expect(result.error).toMatchObject({ code: 'stale_folder_capability_snapshot' });
    } finally {
      unbind();
      resetAgentProcessExecutorForTests();
    }
  });

  test('rejects a snapshot revoked while the process sandbox is being prepared', async () => {
    const root = await mkdtemp(path.join(homedir(), '.tenon-process-revoke-during-prepare-'));
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    const granted = path.join(root, 'granted');
    const marker = path.join(workspace, 'started.txt');
    await mkdir(workspace);
    await mkdir(granted);
    const service = new FolderCapabilityService(path.join(root, 'capabilities.json'));
    await service.grant(granted);
    const snapshot = await service.snapshot({ workspaceRoot: workspace, includeSystemRoots: true });
    let preparationStarted!: () => void;
    let finishPreparation!: () => void;
    const started = new Promise<void>((resolve) => { preparationStarted = resolve; });
    const preparationGate = new Promise<void>((resolve) => { finishPreparation = resolve; });
    const executor = new AgentProcessExecutor({
      prepare: async (input) => {
        preparationStarted();
        await preparationGate;
        return { command: input.command, args: [...input.args] };
      },
    });
    const unbind = executor.bindRevocationGeneration(() => service.currentRevocationGeneration());

    try {
      const spawnResult = executor.spawn({
        command: '/usr/bin/touch',
        args: [marker],
        cwd: workspace,
        capabilities: snapshot,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      await started;
      await service.revoke(granted);
      finishPreparation();

      expect(await spawnResult).toMatchObject({ code: 'stale_folder_capability_snapshot' });
      await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      finishPreparation();
      unbind();
    }
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
    const capabilities = createFolderCapabilitySnapshot({
      workspaceRoot: root,
      includeSystemRoots: true,
    }, []);

    const result = await runAgentToolProcess('/usr/bin/env', [], root, 10_000, {
      capabilities,
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

  test('enforces the bound control-plane root when a broad caller omits or overrides it', async () => {
    if (process.platform !== 'darwin') return;
    const root = await mkdtemp(path.join(homedir(), '.tenon-process-global-control-'));
    roots.push(root);
    const control = path.join(root, 'control');
    const workspace = path.join(control, 'agent-workdir');
    await mkdir(workspace, { recursive: true });
    const secret = path.join(control, 'agent-secrets.json');
    const workspaceFile = path.join(workspace, 'inside.txt');
    await writeFile(secret, 'private');
    await writeFile(workspaceFile, 'inside');
    const service = new FolderCapabilityService(path.join(root, 'capabilities.json'));
    const broad = createFolderCapabilitySnapshot({
      workspaceRoot: path.parse(root).root,
      includeSystemRoots: true,
    }, []);
    const callerOverride = snapshotFromRoots(broad.roots, broad.deniedWrites, [{
      root: control,
      readExceptions: [control],
      writeExceptions: [control],
    }]);
    const callerNarrowing = snapshotFromRoots(broad.roots, broad.deniedWrites, [{
      root: control,
      readExceptions: [],
      writeExceptions: [],
    }]);
    const controlPlaneProtections = createFolderCapabilitySnapshot({
      workspaceRoot: workspace,
      protectedRoots: [control],
    }, []).protectedRoots;
    resetAgentProcessExecutorForTests();
    const unbind = bindAgentProcessCapabilities(service, controlPlaneProtections);

    try {
      const allowed = await runAgentToolProcess('/bin/cat', [workspaceFile], workspace, 10_000, { capabilities: broad });
      const denied = await runAgentToolProcess('/bin/cat', [secret], workspace, 10_000, { capabilities: broad });
      const overrideDenied = await runAgentToolProcess('/bin/cat', [secret], workspace, 10_000, { capabilities: callerOverride });
      const narrowed = await runAgentToolProcess('/bin/cat', [workspaceFile], workspace, 10_000, { capabilities: callerNarrowing });

      expect(allowed).toMatchObject({ exitCode: 0, stdout: 'inside' });
      expect(denied.exitCode).not.toBe(0);
      expect(denied.stdout).not.toContain('private');
      expect(overrideDenied.exitCode).not.toBe(0);
      expect(overrideDenied.stdout).not.toContain('private');
      expect(narrowed.exitCode).not.toBe(0);
    } finally {
      unbind();
      resetAgentProcessExecutorForTests();
    }
  });

  test('intersects the managed content upper bound with one exact read-only version', async () => {
    if (process.platform !== 'darwin') return;
    const root = await mkdtemp(path.join(homedir(), '.tenon-process-managed-skill-'));
    roots.push(root);
    const control = path.join(root, 'control');
    const workspace = path.join(control, 'agent-workdir');
    const contentRoot = path.join(control, 'managed-skill-content');
    const activeVersion = path.join(contentRoot, 'demo', 'a'.repeat(64));
    const siblingVersion = path.join(contentRoot, 'demo', 'b'.repeat(64));
    const activeFile = path.join(activeVersion, 'script.py');
    const siblingFile = path.join(siblingVersion, 'script.py');
    await mkdir(workspace, { recursive: true });
    await mkdir(activeVersion, { recursive: true });
    await mkdir(siblingVersion, { recursive: true });
    await writeFile(activeFile, 'active');
    await writeFile(siblingFile, 'sibling');
    const service = new FolderCapabilityService(path.join(root, 'capabilities.json'));
    const upperBound = createFolderCapabilitySnapshot({
      workspaceRoot: workspace,
      activeSkillReadRoots: [contentRoot],
      protectedRoots: [control],
    }, []).protectedRoots;
    const invocation = createFolderCapabilitySnapshot({
      workspaceRoot: workspace,
      activeSkillReadRoots: [activeVersion],
      includeSystemRoots: true,
      protectedRoots: [control],
    }, [path.parse(root).root]);
    resetAgentProcessExecutorForTests();
    const unbind = bindAgentProcessCapabilities(service, upperBound);

    try {
      const activeRead = await runAgentToolProcess('/bin/cat', [activeFile], workspace, 10_000, { capabilities: invocation });
      const siblingRead = await runAgentToolProcess('/bin/cat', [siblingFile], workspace, 10_000, { capabilities: invocation });
      const activeWrite = await runAgentToolProcess('/bin/zsh', [
        '-c',
        `printf changed > ${JSON.stringify(activeFile)}`,
      ], workspace, 10_000, { capabilities: invocation });

      expect(activeRead).toMatchObject({ exitCode: 0, stdout: 'active' });
      expect(siblingRead.exitCode).not.toBe(0);
      expect(siblingRead.stdout).not.toContain('sibling');
      expect(activeWrite.exitCode).not.toBe(0);
      expect(await readFile(activeFile, 'utf8')).toBe('active');
    } finally {
      unbind();
      resetAgentProcessExecutorForTests();
    }
  });
});
