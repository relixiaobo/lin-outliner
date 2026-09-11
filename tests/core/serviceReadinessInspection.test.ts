import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runOutlineCli } from '../../src/outline/cli';
import { OutlineRuntimeServer } from '../../src/outline/runtime/server';
import { OutlineClientSupervisor, readOutlineRuntimeDescriptor } from '../../src/outline/client';
import { ManagedSkillStore } from '../../src/main/managedSkillStore';
import { validateManagedSkillFiles } from '../../src/main/managedSkillValidation';

const run = promisify(execFile);

test('no-start application inspection rejects a frontend-only target without borrowing a healthy sibling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tenon-readiness-inspection-'));
  const siblingRoot = join(root, 'sibling'), targetRoot = join(root, 'target');
  const sibling = await OutlineRuntimeServer.start({ root: siblingRoot, contentRoot: join(root, 'sibling-content'), idleTimeoutMs: 60_000 });
  expect(sibling).not.toBeNull();
  const server = createServer((_request, response) => response.end('frontend healthy'));
  await new Promise<void>((resolve) => server.listen({ port: 0, host: '::1', ipv6Only: true }, resolve));
  const cli = async (runtimeRoot: string, args: string[]) => {
    let stdout = '', stderr = '';
    const code = await runOutlineCli(['--json', '--no-start', ...args], {
      // Override the inherited Host location explicitly, as the development Skill prescribes.
      env: { ...process.env, TENON_OUTLINE_RUNTIME_ROOT: runtimeRoot, TENON_CONTENT_ROOT: `${runtimeRoot}-content` },
      io: { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
    });
    return { code, response: JSON.parse(stdout || stderr) };
  };
  try {
    await mkdir(targetRoot);
    const siblingBefore = await readOutlineRuntimeDescriptor(siblingRoot);
    const port = (server.address() as AddressInfo).port;
    expect(await (await fetch(`http://[::1]:${port}`)).text()).toBe('frontend healthy');
    await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
    expect(await cli(siblingRoot, ['get', '@library', '--depth', '0'])).toMatchObject({ code: 0, response: { ok: true } });
    expect(await cli(targetRoot, ['status'])).toMatchObject({ code: 0, response: { data: { running: false } } });
    expect(await cli(targetRoot, ['get', '@library', '--depth', '0'])).toMatchObject({ code: 5, response: { ok: false, error: { code: 'runtime_unavailable' } } });
    expect(await readdir(targetRoot)).toEqual([]);
    expect(await readOutlineRuntimeDescriptor(siblingRoot)).toEqual(siblingBefore);
    expect(await cli(siblingRoot, ['get', '@library', '--depth', '0'])).toMatchObject({ code: 0, response: { ok: true } });
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await sibling?.stop(); await rm(root, { recursive: true, force: true });
  }
});

test('startup failure evidence distinguishes an invalid store from a nonpublishing child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tenon-startup-evidence-'));
  const target = join(root, 'broken');
  const snapshot = join(target, 'workspace/outline.snapshot.json');
  await mkdir(join(target, 'workspace'), { recursive: true });
  await writeFile(snapshot, 'not valid snapshot JSON');
  try {
    const supervisor = new OutlineClientSupervisor({ root: target, contentRoot: join(root, 'content'), startupTimeoutMs: 2000,
      launch: { command: process.execPath, args: [fileURLToPath(new URL('../../src/outline/runtime/server/entry.ts', import.meta.url)), '--root', target, '--content-root', join(root, 'content')], detached: false } });
    await expect(supervisor.connect()).rejects.toBeInstanceOf(SyntaxError);
    expect(await readFile(snapshot, 'utf8')).toBe('not valid snapshot JSON');
    expect(await readOutlineRuntimeDescriptor(target)).toBeNull();
    const missing = new OutlineClientSupervisor({ root: join(root, 'nonpublishing'), startupTimeoutMs: 50,
      launch: { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 100)'], detached: false } });
    await expect(missing.connect()).rejects.toMatchObject({ outlineError: { code: 'runtime_unavailable' } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('authorized managed cleanup uses its owner and verifies absence without a false ls failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tenon-readiness-cleanup-'));
  const store = new ManagedSkillStore(root);
  const files = new Map([['SKILL.md', new TextEncoder().encode('---\nname: disposable\ndescription: Disposable cleanup fixture.\n---\n\n# Disposable\n')]]);
  const skill = validateManagedSkillFiles({ files: [...files].map(([relativePath, bytes]) => ({ relativePath, bytes })), selectedDirectoryName: 'disposable', appVersion: '0.8.0' });
  const installed = await store.installValidatedContent(skill.name, skill);
  try {
    expect((await stat(installed)).mode & 0o222).toBe(0);
    expect((await stat(join(installed, 'SKILL.md'))).mode & 0o222).toBe(0);
    await store.removeVersion(skill.name, skill.contentHash);
    // The path is passed as an argv value, never interpolated into shell code.
    expect((await run('/bin/sh', ['-c', 'test ! -e "$1"', 'absence-check', installed])).stderr).toBe('');
  } finally { await store.removeVersion(skill.name, skill.contentHash); await rm(root, { recursive: true, force: true }); }
});
