import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BROWSER_PILOT_BIN_DIR_ENV,
  BROWSER_PILOT_CLIENT_KEY_ENV,
  BROWSER_PILOT_INSTALL_ROOT_ENV,
  BROWSER_PILOT_OUTPUT_DIR_ENV,
  BrowserPilotHost,
  browserPilotClientKey,
  prepareBrowserPilotOutputDirectory,
} from '../../src/main/browserPilotHost';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Browser Pilot host environment', () => {
  test('keeps one client key per Thread and one output directory per Turn', async () => {
    const root = await temporaryRoot();
    const userDataRoot = path.join(root, 'user-data');
    const scratchRoot = path.join(root, 'agent-scratch');
    let installationIdLoads = 0;
    const host = new BrowserPilotHost({
      userDataRoot,
      scratchRoot,
      loadInstallationId: async () => {
        installationIdLoads += 1;
        return '0198-constant-installation-id';
      },
    });

    expect(installationIdLoads).toBe(0);
    const first = await host.processEnvironment('thread-1', 'turn-1');
    const nextTurn = await host.processEnvironment('thread-1', 'turn-2');
    const secondThread = await host.processEnvironment('thread-2', 'turn-3');
    const canonicalScratchRoot = await realpath(scratchRoot);

    expect(installationIdLoads).toBe(1);
    expect(first.env?.[BROWSER_PILOT_CLIENT_KEY_ENV]).toBe(nextTurn.env?.[BROWSER_PILOT_CLIENT_KEY_ENV]);
    expect(first.env?.[BROWSER_PILOT_CLIENT_KEY_ENV]).not.toBe(secondThread.env?.[BROWSER_PILOT_CLIENT_KEY_ENV]);
    expect(first.env?.[BROWSER_PILOT_OUTPUT_DIR_ENV]).not.toBe(nextTurn.env?.[BROWSER_PILOT_OUTPUT_DIR_ENV]);
    expect(first.env).toMatchObject({
      [BROWSER_PILOT_INSTALL_ROOT_ENV]: path.join(userDataRoot, 'browser-pilot'),
      [BROWSER_PILOT_BIN_DIR_ENV]: path.join(userDataRoot, 'browser-pilot', 'bin'),
      [BROWSER_PILOT_OUTPUT_DIR_ENV]: path.join(canonicalScratchRoot, 'browser-pilot', 'thread-1', 'turn-1'),
    });
    expect(first.env?.BROWSER_PILOT_HOME).toBeUndefined();
    expect(first.leadingToolPathSegments).toEqual([path.join(userDataRoot, 'browser-pilot', 'bin')]);
    expect(await realpath(first.env![BROWSER_PILOT_OUTPUT_DIR_ENV]!)).toBe(first.env![BROWSER_PILOT_OUTPUT_DIR_ENV]);
    if (process.platform !== 'win32') {
      expect((await lstat(first.env![BROWSER_PILOT_OUTPUT_DIR_ENV]!)).mode & 0o077).toBe(0);
    }
  });

  test('derives deterministic opaque keys without exposing their inputs', () => {
    const key = browserPilotClientKey('installation-secret', 'thread-1');
    expect(key).toStartWith('tenon.');
    expect(key).not.toContain('installation-secret');
    expect(key).not.toContain('thread-1');
    expect(browserPilotClientKey('installation-secret', 'thread-1')).toBe(key);
    expect(browserPilotClientKey('installation-secret', 'thread-2')).not.toBe(key);
  });

  test('rejects unsafe execution identities before creating output paths', async () => {
    const root = await temporaryRoot();
    await expect(prepareBrowserPilotOutputDirectory(root, '../thread', 'turn-1'))
      .rejects.toThrow('Thread identity is unsafe');
    await expect(prepareBrowserPilotOutputDirectory(root, 'thread-1', '../turn'))
      .rejects.toThrow('Turn identity is unsafe');
  });

  const symlinkTest = process.platform === 'win32' ? test.skip : test;
  symlinkTest('refuses a symlink substituted inside Agent scratch', async () => {
    const root = await temporaryRoot();
    const scratchRoot = path.join(root, 'scratch');
    const outside = path.join(root, 'outside');
    await mkdir(scratchRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(scratchRoot, 'browser-pilot'), 'dir');

    await expect(prepareBrowserPilotOutputDirectory(scratchRoot, 'thread-1', 'turn-1'))
      .rejects.toThrow('not a normal directory');
    expect(await lstat(outside)).toBeDefined();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-browser-pilot-host-'));
  roots.push(root);
  return root;
}
