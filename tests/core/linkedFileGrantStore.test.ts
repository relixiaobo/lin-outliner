import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LinkedFileGrantStore, linkedFilePath } from '../../src/main/linkedFileGrantStore';

describe('linked-file grant store', () => {
  let root: string;
  let storePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tenon-linked-file-grants-'));
    storePath = join(root, 'profile', 'linked-file-grants.json');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('persists one exact regular-file grant across restart and revokes it', async () => {
    const filePath = join(root, 'report.md');
    await writeFile(filePath, '# Report');
    const sourceText = pathToFileURL(filePath).toString();
    const first = new LinkedFileGrantStore(storePath, () => 123);

    expect(await first.resolve(sourceText)).toEqual({ status: 'denied' });
    expect(await first.authorize(sourceText, filePath)).toEqual({ authorized: true });
    await expectReady(first, sourceText);

    const restarted = new LinkedFileGrantStore(storePath);
    await expectReady(restarted, sourceText);
    expect(await restarted.revoke(sourceText)).toBe(true);
    expect(await restarted.resolve(sourceText)).toEqual({ status: 'denied' });

    if (process.platform !== 'win32') {
      expect((await stat(storePath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, 'profile'))).mode & 0o777).toBe(0o700);
    }
  });

  test('rejects a chooser substitution and a directory', async () => {
    const expectedPath = join(root, 'expected.txt');
    const otherPath = join(root, 'other.txt');
    await writeFile(expectedPath, 'expected');
    await writeFile(otherPath, 'other');
    const store = new LinkedFileGrantStore(storePath);

    expect(await store.authorize(pathToFileURL(expectedPath).toString(), otherPath))
      .toEqual({ authorized: false, reason: 'different-file' });
    expect(await store.authorize(pathToFileURL(root).toString(), root))
      .toEqual({ authorized: false, reason: 'unavailable' });
  });

  test('denies a retargeted symlink without widening to the new target', async () => {
    const firstPath = join(root, 'first.txt');
    const secondPath = join(root, 'second.txt');
    const linkPath = join(root, 'linked.txt');
    await writeFile(firstPath, 'first');
    await writeFile(secondPath, 'second');
    await symlink(firstPath, linkPath);
    const sourceText = pathToFileURL(linkPath).toString();
    const store = new LinkedFileGrantStore(storePath);
    expect(await store.authorize(sourceText, firstPath)).toEqual({ authorized: true });

    await rm(linkPath);
    await symlink(secondPath, linkPath);
    expect(await store.resolve(sourceText)).toEqual({ status: 'denied' });
  });

  test('allows ordinary replacement at the same non-symlink path after fresh verification', async () => {
    const filePath = join(root, 'live.txt');
    const replacementPath = join(root, 'replacement.txt');
    await writeFile(filePath, 'first');
    const sourceText = pathToFileURL(filePath).toString();
    const store = new LinkedFileGrantStore(storePath);
    expect(await store.authorize(sourceText, filePath)).toEqual({ authorized: true });

    await writeFile(replacementPath, 'second');
    await rename(replacementPath, filePath);
    await expectReady(store, sourceText);
  });

  test('fails closed on corrupt persisted grants', async () => {
    await writeFile(storePath, '{"schemaVersion":1,"grants":[{"sourceText":7}]}').catch(async () => {
      const profile = join(root, 'profile');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(profile, { recursive: true });
      await writeFile(storePath, '{"schemaVersion":1,"grants":[{"sourceText":7}]}');
    });
    const filePath = join(root, 'notes.txt');
    await writeFile(filePath, 'notes');
    const sourceText = pathToFileURL(filePath).toString();
    const store = new LinkedFileGrantStore(storePath);

    expect(await store.resolve(sourceText)).toEqual({ status: 'denied' });
    await expect(store.authorize(sourceText, filePath)).rejects.toThrow('Invalid linked-file grant');
  });

  test('accepts only local file URIs', () => {
    expect(linkedFilePath('https://example.com/file.txt')).toBeNull();
    expect(linkedFilePath('file://remote-host/file.txt')).toBeNull();
    expect(linkedFilePath('not a uri')).toBeNull();
  });
});

async function expectReady(store: LinkedFileGrantStore, sourceText: string): Promise<void> {
  const resolution = await store.resolve(sourceText);
  expect(resolution.status).toBe('ready');
  if (resolution.status === 'ready') await resolution.file.handle.close();
}
