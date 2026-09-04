import { describe, expect, test } from 'bun:test';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { runDelegateCli, type DelegateCliIo } from '../../src/delegate/cli';
import { resolveDelegateCliRuntime } from '../../src/main/delegateRuntime';

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(import.meta.dir, '..', '..');
const { ensureDelegateExecutable } = require('../../build/afterPack.cjs') as {
  ensureDelegateExecutable(appPath: string): string;
};

describe('delegate CLI', () => {
  test('runs read-only diagnostics from the source launcher', async () => {
    const launcher = path.join(repoRoot, 'src', 'delegate', 'bin', 'delegate');
    const version = JSON.parse((await execFile(launcher, ['version'])).stdout);
    expect(version).toMatchObject({ ok: true, data: { cliVersion: '1.0.0', protocolVersions: [1] } });

    const schema = JSON.parse((await execFile(launcher, ['schema', 'run'])).stdout);
    expect(schema.data).toMatchObject({ type: 'object', additionalProperties: false });

    const doctor = JSON.parse((await execFile(launcher, ['doctor', 'internal', '--output', 'json'])).stdout);
    expect(doctor).toMatchObject({
      ok: true,
      data: { runnerId: 'internal', detected: true, ready: false },
    });
  });

  test('refuses a state-changing direct invocation before reading stdin', async () => {
    let read = false;
    const capture = capturedIo(() => {
      read = true;
      return Promise.resolve('{"version":1}');
    });
    const exitCode = await runDelegateCli(['run', '--input', '-', '--output', 'json'], { io: capture.io });

    expect(exitCode).toBe(6);
    expect(read).toBe(false);
    expect(JSON.parse(capture.stdout.join(''))).toEqual({
      ok: false,
      error: { code: 'unauthorized', message: 'Host delegation capability is required.' },
    });
    expect(capture.stderr).toEqual([]);
  });

  test('validates stdin before passing a state command to the admitted executor', async () => {
    const seen: unknown[] = [];
    const capture = capturedIo(async () => JSON.stringify({
      version: 1,
      prompt: 'Inspect this task.',
      profile: 'explore',
      access: 'read-only',
    }));
    const exitCode = await runDelegateCli(['run', '--input', '-', '--output', 'json'], {
      io: capture.io,
      stateExecutor: {
        execute: async (command, input) => {
          seen.push(command, input);
          return { admitted: true };
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(seen).toEqual([
      { name: 'run', input: '-', output: 'json' },
      { version: 1, prompt: 'Inspect this task.', profile: 'explore', access: 'read-only' },
    ]);
    expect(JSON.parse(capture.stdout.join(''))).toEqual({ ok: true, data: { admitted: true } });
  });

  test('resolves source and packaged runtimes without changing process PATH', () => {
    expect(resolveDelegateCliRuntime({
      isPackaged: false,
      moduleDir: '/repo/src/main',
      resourcesPath: '/unused',
      processExecPath: '/Applications/Tenon.app/Contents/MacOS/Tenon',
    })).toEqual({
      binDir: path.join('/repo', 'src', 'delegate', 'bin'),
      cliEntry: path.join('/repo', 'src', 'delegate', 'cli', 'entry.ts'),
      cliRuntime: 'bun',
      runAsNode: false,
      packaged: false,
    });
    expect(resolveDelegateCliRuntime({
      isPackaged: true,
      moduleDir: '/app/out/main',
      resourcesPath: '/app/Contents/Resources',
      processExecPath: '/app/Contents/MacOS/Tenon',
    })).toEqual({
      binDir: '/app/Contents/Resources/delegate/bin',
      cliEntry: '/app/Contents/Resources/delegate/delegate.mjs',
      cliRuntime: '/app/Contents/MacOS/Tenon',
      runAsNode: true,
      packaged: true,
    });
  });

  test('runs the bundled diagnostics through the packaged launcher', async () => {
    await execFile('bun', ['run', 'delegate:build'], { cwd: repoRoot });
    const root = await mkdtemp(path.join(tmpdir(), 'delegate-packaged-smoke-'));
    try {
      const contents = path.join(root, 'Tenon.app', 'Contents');
      const launcher = path.join(contents, 'Resources', 'delegate', 'bin', 'delegate');
      const bundle = path.join(contents, 'Resources', 'delegate', 'delegate.mjs');
      const executable = path.join(contents, 'MacOS', 'Tenon');
      await Promise.all([
        mkdir(path.dirname(launcher), { recursive: true }),
        mkdir(path.dirname(executable), { recursive: true }),
      ]);
      await Promise.all([
        copyFile(path.join(repoRoot, 'src', 'delegate', 'bin', 'delegate'), launcher),
        copyFile(path.join(repoRoot, 'build', 'generated', 'delegate', 'delegate.mjs'), bundle),
        symlink(process.execPath, executable),
      ]);
      await chmod(launcher, 0o600);
      expect(ensureDelegateExecutable(path.join(root, 'Tenon.app'))).toBe(launcher);

      const env = { ...process.env };
      delete env.TENON_DELEGATE_CLI_ENTRY;
      delete env.TENON_DELEGATE_CLI_RUNTIME;
      delete env.TENON_DELEGATE_RUN_AS_NODE;
      const version = JSON.parse((await execFile(launcher, ['version'], { env })).stdout);
      expect(version).toMatchObject({ ok: true, data: { cliVersion: '1.0.0', protocolVersions: [1] } });

      const direct = await execFile(launcher, ['run', '--input', '-', '--output', 'json'], {
        env,
        input: JSON.stringify({
          version: 1,
          prompt: 'This direct invocation must not start a Runner.',
          profile: 'explore',
          access: 'read-only',
        }),
      }).catch((error: unknown) => error as { stdout: string; code: number });
      expect(direct.code).toBe(6);
      expect(JSON.parse(direct.stdout)).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function capturedIo(readStdin: DelegateCliIo['readStdin']): {
  readonly io: DelegateCliIo;
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      readStdin,
      stdout: async (value) => { stdout.push(value); },
      stderr: async (value) => { stderr.push(value); },
    },
  };
}
