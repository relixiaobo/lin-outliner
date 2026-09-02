import { afterEach, describe, expect, test } from 'bun:test';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  configureOutlineCliRuntime,
  resolveOutlineCliRuntime,
  TENON_OUTLINE_CLI_ENTRY_ENV,
  TENON_OUTLINE_IMPORT_ADAPTER_ENTRY_ENV,
  TENON_OUTLINE_CLI_RUNTIME_ENV,
  TENON_OUTLINE_PACKAGED_ENV,
  TENON_OUTLINE_RUN_AS_NODE_ENV,
  TENON_OUTLINE_RUNTIME_ENTRY_ENV,
} from '../../src/main/outlineRuntime';
import { EXTRA_TOOL_PATH_ENV } from '../../src/main/agent/capabilities/agentToolPath';
import { readOutlineRuntimeDescriptor } from '../../src/outline/client';

const savedEnvironment = { ...process.env };
const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(import.meta.dir, '..', '..');
const { ensureOutlineExecutable } = require('../../build/afterPack.cjs') as {
  ensureOutlineExecutable(appPath: string): string;
};

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnvironment);
});

describe('Outline CLI runtime', () => {
  test('resolves the repository launcher and TypeScript entry in development', () => {
    const config = resolveOutlineCliRuntime({
      isPackaged: false,
      moduleDir: '/repo/src/main',
      resourcesPath: '/unused',
      processExecPath: '/Applications/Tenon.app/Contents/MacOS/Tenon',
    });
    expect(config).toEqual({
      binDir: path.join('/repo', 'src', 'outline', 'bin'),
      cliEntry: path.join('/repo', 'src', 'outline', 'cli', 'entry.ts'),
      importAdapterEntry: path.join('/repo', 'src', 'outline', 'import', 'adapters', 'source-adapters.ts'),
      runtimeEntry: path.join('/repo', 'src', 'outline', 'runtime', 'server', 'entry.ts'),
      cliRuntime: 'bun',
      runAsNode: false,
      packaged: false,
    });
  });

  test('configures the packaged launcher for ordinary Agent PATH resolution', () => {
    process.env[EXTRA_TOOL_PATH_ENV] = path.join('/existing', 'bin');
    const config = configureOutlineCliRuntime({
      isPackaged: true,
      moduleDir: '/app/out/main',
      resourcesPath: '/app/Contents/Resources',
      processExecPath: '/app/Contents/MacOS/Tenon',
    });
    expect(process.env[TENON_OUTLINE_CLI_ENTRY_ENV]).toBe('/app/Contents/Resources/outline/outline.mjs');
    expect(process.env[TENON_OUTLINE_IMPORT_ADAPTER_ENTRY_ENV]).toBe(
      '/app/Contents/Resources/outline/import-adapters.mjs',
    );
    expect(process.env[TENON_OUTLINE_RUNTIME_ENTRY_ENV]).toBe(
      '/app/Contents/Resources/outline/outline-runtime.mjs',
    );
    expect(process.env[TENON_OUTLINE_CLI_RUNTIME_ENV]).toBe('/app/Contents/MacOS/Tenon');
    expect(process.env[TENON_OUTLINE_RUN_AS_NODE_ENV]).toBe('1');
    expect(process.env[TENON_OUTLINE_PACKAGED_ENV]).toBe('1');
    expect(process.env[EXTRA_TOOL_PATH_ENV]?.split(path.delimiter)).toEqual([
      config.binDir,
      path.join('/existing', 'bin'),
    ]);
  });

  test('routes public import inspection through the development launcher default adapter', async () => {
    const launcher = path.join(repoRoot, 'src', 'outline', 'bin', 'outline');
    const source = path.join(repoRoot, 'tests', 'fixtures', 'outline', 'tana-minimal.json');
    const { stdout } = await execFile(launcher, ['--json', 'import', 'inspect', source], {
      env: {
        ...process.env,
        [TENON_OUTLINE_CLI_RUNTIME_ENV]: process.execPath,
        [TENON_OUTLINE_CLI_ENTRY_ENV]: path.join(repoRoot, 'src', 'outline', 'cli', 'entry.ts'),
        [TENON_OUTLINE_IMPORT_ADAPTER_ENTRY_ENV]: '',
      },
    });
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, command: 'import inspect', data: { kind: 'tana' } });
  });

  test('runs packaged CLI, Runtime, and source adapter bundles through one launcher', async () => {
    await execFile('bun', ['run', 'skills:sync'], { cwd: repoRoot });
    await execFile('bun', ['run', 'outline:build'], { cwd: repoRoot });
    const sourceLauncher = path.join(repoRoot, 'src', 'outline', 'bin', 'outline');
    const cliBundle = path.join(repoRoot, 'build', 'generated', 'outline', 'outline.mjs');
    const runtimeBundle = path.join(repoRoot, 'build', 'generated', 'outline', 'outline-runtime.mjs');
    const adapterBundle = path.join(repoRoot, 'build', 'generated', 'outline', 'import-adapters.mjs');
    const root = await mkdtemp(path.join(tmpdir(), 'outline-packaged-smoke-'));
    const contents = path.join(root, 'Tenon.app', 'Contents');
    const launcher = path.join(contents, 'Resources', 'outline', 'bin', 'outline');
    const packagedCli = path.join(contents, 'Resources', 'outline', 'outline.mjs');
    const packagedRuntime = path.join(contents, 'Resources', 'outline', 'outline-runtime.mjs');
    const packagedAdapter = path.join(contents, 'Resources', 'outline', 'import-adapters.mjs');
    const packagedExecutable = path.join(contents, 'MacOS', 'Tenon');
    await Promise.all([
      mkdir(path.dirname(launcher), { recursive: true }),
      mkdir(path.dirname(packagedAdapter), { recursive: true }),
      mkdir(path.dirname(packagedExecutable), { recursive: true }),
    ]);
    await Promise.all([
      copyFile(sourceLauncher, launcher),
      copyFile(cliBundle, packagedCli),
      copyFile(runtimeBundle, packagedRuntime),
      copyFile(adapterBundle, packagedAdapter),
      symlink(process.execPath, packagedExecutable),
    ]);
    await chmod(launcher, 0o755);
    const runtimeRoot = path.join(root, 'runtime');
    const contentRoot = path.join(root, 'content');
    const env = {
      ...process.env,
      TENON_OUTLINE_RUNTIME_ROOT: runtimeRoot,
      TENON_CONTENT_ROOT: contentRoot,
      TENON_OUTLINE_RUNTIME_IDLE_MS: '100',
    };
    delete env.TENON_OUTLINE_CLI_RUNTIME;
    delete env.TENON_OUTLINE_CLI_ENTRY;
    delete env.TENON_OUTLINE_IMPORT_ADAPTER_ENTRY;
    delete env.TENON_OUTLINE_RUN_AS_NODE;
    delete env.TENON_OUTLINE_RUNTIME_ENTRY;
    delete env.TENON_OUTLINE_PACKAGED;
    const runLauncher = (args: readonly string[]) => execFile(launcher, [...args], {
      cwd: repoRoot,
      env,
      maxBuffer: 32 * 1024 * 1024,
    });

    try {
      const version = JSON.parse((await runLauncher(['--json', 'version'])).stdout);
      expect(version).toMatchObject({ ok: true, command: 'version' });

      const schema = JSON.parse((await runLauncher(['--json', 'schema', 'Selector'])).stdout);
      expect(schema.data.$defs.Selector.$id).toBe('Selector');

      const capabilities = JSON.parse((await runLauncher(['--json', 'capabilities'])).stdout);
      expect(capabilities.data).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'find' }),
        expect.objectContaining({ name: 'apply' }),
        expect.objectContaining({ name: 'watch' }),
      ]));

      const source = path.join(repoRoot, 'tests', 'fixtures', 'outline', 'tana-minimal.json');
      const inspected = JSON.parse((await runLauncher(['--json', 'import', 'inspect', source])).stdout);
      expect(inspected).toMatchObject({ ok: true, command: 'import inspect', data: { kind: 'tana' } });

      const applied = JSON.parse((await runLauncher([
        '--json', 'add', '--parent', '@today', 'Packaged launcher smoke',
      ])).stdout);
      expect(applied).toMatchObject({
        ok: true,
        command: 'add',
        data: { kind: 'outline.operation', origin: 'local-user' },
      });
      expect((await stat(path.join(contentRoot, 'state.sqlite'))).isFile()).toBe(true);

      const found = JSON.parse((await runLauncher([
        '--json', 'find', 'Packaged launcher smoke', '--limit', '1',
      ])).stdout);
      expect(found.data.nodes).toEqual([
        expect.objectContaining({ text: 'Packaged launcher smoke' }),
      ]);

      const [cliSource, runtimeSource] = await Promise.all([
        readFile(cliBundle, 'utf8'),
        readFile(runtimeBundle, 'utf8'),
      ]);
      for (const source of [cliSource, runtimeSource]) {
        expect(source).not.toMatch(/(?:from\s+|require\()["']electron["']/);
        expect(source).not.toContain('src/renderer/');
      }

      await waitFor(async () => (await readOutlineRuntimeDescriptor(runtimeRoot)) === null, 5_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test('marks the packaged outline launcher executable before signing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'outline-packaged-launcher-'));
    try {
      const launcher = path.join(root, 'Contents', 'Resources', 'outline', 'bin', 'outline');
      await mkdir(path.dirname(launcher), { recursive: true });
      await writeFile(launcher, '#!/bin/sh\n', 'utf8');
      await chmod(launcher, 0o600);
      expect(ensureOutlineExecutable(root)).toBe(launcher);
      expect((await stat(launcher)).mode & 0o777).toBe(0o755);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}
