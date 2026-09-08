import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath, chmod, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureSourceManifest, resolveVerificationChecks } from '../../src/main/agent/verification/SourceManifest';
import type { VerificationCheckDefinition } from '../../src/core/agent/verification';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))); });
async function root() { const value = await mkdtemp(path.join(tmpdir(), 'tenon-verify-')); roots.push(value); return realpath(value); }
function definitions(directory: string, exclude: string[] = []): VerificationCheckDefinition[] {
  return [{ id: 'test', key: 'test', command: 'bun test', required: true, inputs: ['.'], exclude,
    source: path.join(directory, '.tenon/checks.json'), scope: directory }];
}
describe('verification source manifests', () => {
  test('captures binary and untracked content, then retains explicit deletion evidence', async () => {
    const directory = await root();
    const file = path.join(directory, 'source.bin');
    await writeFile(file, Buffer.from([0, 1, 255]));
    const first = await captureSourceManifest([directory], definitions(directory));
    expect(first.entries.find((entry) => entry.path === 'source.bin')?.bytes).toBe(3);
    await writeFile(file, Buffer.from([0, 2, 255]));
    const changed = await captureSourceManifest([directory], definitions(directory), first);
    expect(changed.digest).not.toBe(first.digest);
    await rm(file);
    const deleted = await captureSourceManifest([directory], definitions(directory), changed);
    expect(deleted.entries.find((entry) => entry.path === 'source.bin')?.kind).toBe('missing');
    expect((await captureSourceManifest([directory], definitions(directory), deleted)).digest).toBe(deleted.digest);
  });
  test('includes ignored files unless an exclusion is recorded', async () => {
    const directory = await root();
    await writeFile(path.join(directory, '.gitignore'), 'cache/\n');
    await mkdir(path.join(directory, 'cache'));
    await writeFile(path.join(directory, 'cache/result'), 'first');
    const all = await captureSourceManifest([directory], definitions(directory));
    const scoped = await captureSourceManifest([directory], definitions(directory, ['cache/**']));
    await writeFile(path.join(directory, 'cache/result'), 'second');
    expect((await captureSourceManifest([directory], definitions(directory))).digest).not.toBe(all.digest);
    expect((await captureSourceManifest([directory], definitions(directory, ['cache/**']))).digest).toBe(scoped.digest);
    expect(scoped.limitations.some((entry) => entry.includes('cache/**'))).toBe(true);
  });
  test('fails on unmeasured external links and cycles', async () => {
    const directory = await root(), external = await root();
    await writeFile(path.join(external, 'file'), 'outside');
    await symlink(path.join(external, 'file'), path.join(directory, 'linked'));
    await expect(captureSourceManifest([directory], definitions(directory))).rejects.toThrow('External symlink');
    const measured = await captureSourceManifest([directory, external], definitions(directory));
    expect(measured.entries.some((entry) => entry.path === 'linked/@target')).toBe(true);
    await symlink(directory, path.join(directory, 'cycle'));
    await expect(captureSourceManifest([directory, external], definitions(directory))).rejects.toThrow('cycle');
  });
  test('capture limits and missing required definitions never produce empty success', async () => {
    const directory = await root();
    await expect(resolveVerificationChecks([directory])).rejects.toThrow('No required checks');
    await writeFile(path.join(directory, 'file'), 'bytes');
    await expect(captureSourceManifest([directory], definitions(directory), null, { maxBytes: 1 })).rejects.toThrow('limit');
    await expect(captureSourceManifest([directory], definitions(directory), null, { maxEntries: 1 })).rejects.toThrow('limit');
  });
  test('binds Git HEAD, branch, and staged content independently from working bytes', async () => {
    const directory = await root();
    const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], { stdio: 'pipe' });
    git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Verification Test');
    await writeFile(path.join(directory, 'file'), 'first');
    git('add', 'file'); git('commit', '-qm', 'Initial');
    const first = await captureSourceManifest([directory], definitions(directory));
    expect(first.entries.some((entry) => entry.path.startsWith('.git'))).toBe(false);
    git('checkout', '-qb', 'another');
    const branch = await captureSourceManifest([directory], definitions(directory));
    expect(branch.digest).not.toBe(first.digest);
    await writeFile(path.join(directory, 'file'), 'staged'); git('add', 'file');
    await writeFile(path.join(directory, 'file'), 'first');
    const staged = await captureSourceManifest([directory], definitions(directory));
    expect(staged.digest).not.toBe(branch.digest);
    expect(staged.entries).toEqual(branch.entries);
    git('commit', '-qm', 'Staged');
    expect((await captureSourceManifest([directory], definitions(directory))).roots[0]?.head).not.toBe(branch.roots[0]?.head);
  });
  test('captures absolute file inputs and refuses ambiguous command bindings', async () => {
    const directory = await root(), external = await root();
    const file = path.join(external, 'input');
    await writeFile(file, 'external input');
    const checks = definitions(directory).map((check) => ({ ...check, inputs: ['.', file] }));
    const first = await captureSourceManifest([directory], checks);
    await writeFile(file, 'changed input');
    expect((await captureSourceManifest([directory], checks)).digest).not.toBe(first.digest);
    await mkdir(path.join(directory, '.tenon'));
    await writeFile(path.join(directory, '.tenon/checks.json'), JSON.stringify({ schemaVersion: 1, checks: [
      { id: 'a', command: 'echo same', required: true, inputs: ['.'], exclude: [] },
      { id: 'b', command: 'echo same', required: false, inputs: ['.'], exclude: [] },
    ] }));
    await expect(resolveVerificationChecks([directory])).rejects.toThrow('distinct command and cwd');
  });

  test('Git index inspection cannot execute a repository fsmonitor command', async () => {
    const directory = await root(), external = await root();
    const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], { stdio: 'pipe' });
    git('init', '-q');
    await writeFile(path.join(directory, 'source'), 'input');
    git('add', 'source');
    const script = path.join(external, 'monitor');
    const marker = path.join(external, 'executed');
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\nprintf 'token\\0'\n`);
    await chmod(script, 0o700);
    git('config', 'core.fsmonitor', script);
    await captureSourceManifest([directory], definitions(directory));
    await expect(access(marker)).rejects.toThrow();
    git('ls-files', '--stage');
    await access(marker);
  });

  test('reads declared checks through scoped discovery and hashes command/scope changes', async () => {
    const directory = await root();
    await mkdir(path.join(directory, '.tenon'));
    const profile = { schemaVersion: 1, checks: [{ id: 'test', command: 'bun test', required: true, inputs: ['.'], exclude: [] }] };
    await writeFile(path.join(directory, '.tenon/checks.json'), JSON.stringify(profile));
    const checks = await resolveVerificationChecks([directory]);
    expect(checks).toHaveLength(1);
    const first = await captureSourceManifest([directory], checks);
    expect((await captureSourceManifest([directory], checks.map((check) => ({ ...check, command: 'bun run test:core' })))).definitionDigest).not.toBe(first.definitionDigest);
  });
});
