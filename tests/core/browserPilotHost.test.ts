import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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
  test('keeps one client key per Thread and one output directory per command execution', async () => {
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
    const first = await host.processEnvironment('thread-1', 'turn-1', 'call-1');
    const repeated = await host.processEnvironment('thread-1', 'turn-1', 'call-1');
    const sameTurn = await host.processEnvironment('thread-1', 'turn-1', 'call-2');
    const nextTurn = await host.processEnvironment('thread-1', 'turn-2', 'call-3');
    const secondThread = await host.processEnvironment('thread-2', 'turn-3', 'call-4');
    const canonicalScratchRoot = await realpath(scratchRoot);
    const firstExecutionKey = createHash('sha256').update('call-1').digest('base64url');

    expect(installationIdLoads).toBe(1);
    expect(first.env?.[BROWSER_PILOT_CLIENT_KEY_ENV]).toBe(nextTurn.env?.[BROWSER_PILOT_CLIENT_KEY_ENV]);
    expect(first.env?.[BROWSER_PILOT_CLIENT_KEY_ENV]).not.toBe(secondThread.env?.[BROWSER_PILOT_CLIENT_KEY_ENV]);
    expect(first.env?.[BROWSER_PILOT_OUTPUT_DIR_ENV]).toBe(repeated.env?.[BROWSER_PILOT_OUTPUT_DIR_ENV]);
    expect(first.env?.[BROWSER_PILOT_OUTPUT_DIR_ENV]).not.toBe(sameTurn.env?.[BROWSER_PILOT_OUTPUT_DIR_ENV]);
    expect(first.env?.[BROWSER_PILOT_OUTPUT_DIR_ENV]).not.toBe(nextTurn.env?.[BROWSER_PILOT_OUTPUT_DIR_ENV]);
    expect(first.env).toMatchObject({
      [BROWSER_PILOT_INSTALL_ROOT_ENV]: path.join(userDataRoot, 'browser-pilot'),
      [BROWSER_PILOT_BIN_DIR_ENV]: path.join(userDataRoot, 'browser-pilot', 'bin'),
      [BROWSER_PILOT_OUTPUT_DIR_ENV]: path.join(
        canonicalScratchRoot,
        'browser-pilot',
        'thread-1',
        'turn-1',
        firstExecutionKey,
      ),
    });
    expect(first.env?.BROWSER_PILOT_HOME).toBeUndefined();
    expect(first.leadingToolPathSegments).toEqual([path.join(userDataRoot, 'browser-pilot', 'bin')]);
    expect(first.declaredOutputRoots).toEqual([{
      id: 'browser-pilot-output',
      skillId: 'browser-pilot',
      path: first.env![BROWSER_PILOT_OUTPUT_DIR_ENV]!,
      label: 'Browser Pilot output',
    }]);
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

  test('retries installation identity loading after a transient failure', async () => {
    const root = await temporaryRoot();
    let attempts = 0;
    const host = new BrowserPilotHost({
      userDataRoot: path.join(root, 'user-data'),
      scratchRoot: path.join(root, 'scratch'),
      loadInstallationId: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary read failure');
        return 'recovered-installation-id';
      },
    });

    await expect(host.processEnvironment('thread-1', 'turn-1', 'call-1')).rejects.toThrow('temporary read failure');
    const recovered = await host.processEnvironment('thread-1', 'turn-2', 'call-2');
    await host.processEnvironment('thread-1', 'turn-3', 'call-3');
    expect(recovered.env?.[BROWSER_PILOT_CLIENT_KEY_ENV]).toBeDefined();
    expect(attempts).toBe(2);
  });

  test('rejects unsafe Thread and Turn identities while hashing raw tool-call identities', async () => {
    const root = await temporaryRoot();
    await expect(prepareBrowserPilotOutputDirectory(root, '../thread', 'turn-1', 'call-1'))
      .rejects.toThrow('Thread identity is unsafe');
    await expect(prepareBrowserPilotOutputDirectory(root, 'thread-1', '../turn', 'call-1'))
      .rejects.toThrow('Turn identity is unsafe');

    const rawExecutionId = '../untrusted/tool-call?request=1';
    const output = await prepareBrowserPilotOutputDirectory(root, 'thread-1', 'turn-1', rawExecutionId);
    const executionKey = createHash('sha256').update(rawExecutionId).digest('base64url');
    expect(output).toBe(path.join(
      await realpath(root),
      'browser-pilot',
      'thread-1',
      'turn-1',
      executionKey,
    ));
    expect(output).not.toContain(rawExecutionId);
  });

  const symlinkTest = process.platform === 'win32' ? test.skip : test;
  symlinkTest('refuses a symlink substituted inside Agent scratch', async () => {
    const root = await temporaryRoot();
    const scratchRoot = path.join(root, 'scratch');
    const outside = path.join(root, 'outside');
    await mkdir(scratchRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(scratchRoot, 'browser-pilot'), 'dir');

    await expect(prepareBrowserPilotOutputDirectory(scratchRoot, 'thread-1', 'turn-1', 'call-1'))
      .rejects.toThrow('not a normal directory');
    expect(await lstat(outside)).toBeDefined();
  });

  symlinkTest('refuses unmanaged entries in the host-managed command directory', async () => {
    const root = await temporaryRoot();
    const userDataRoot = path.join(root, 'user-data');
    const binDirectory = path.join(userDataRoot, 'browser-pilot', 'bin');
    await mkdir(binDirectory, { recursive: true });
    await writeFile(path.join(binDirectory, 'node'), '#!/bin/sh\n', 'utf8');
    const host = new BrowserPilotHost({
      userDataRoot,
      scratchRoot: path.join(root, 'scratch'),
      loadInstallationId: async () => 'installation-id',
    });

    await expect(host.processEnvironment('thread-1', 'turn-1', 'call-1'))
      .rejects.toThrow('contains an unmanaged entry');
  });

  symlinkTest('accepts command links into the host-managed versions directory', async () => {
    const root = await temporaryRoot();
    const userDataRoot = path.join(root, 'user-data');
    const installRoot = path.join(userDataRoot, 'browser-pilot');
    const executable = path.join(installRoot, 'versions', '0.6.1-darwin-arm64', 'browser-pilot');
    const binDirectory = path.join(installRoot, 'bin');
    await mkdir(path.dirname(executable), { recursive: true });
    await mkdir(binDirectory, { recursive: true });
    await writeFile(executable, '#!/bin/sh\n', 'utf8');
    await symlink(executable, path.join(binDirectory, 'bp'));
    const host = new BrowserPilotHost({
      userDataRoot,
      scratchRoot: path.join(root, 'scratch'),
      loadInstallationId: async () => 'installation-id',
    });

    const environment = await host.processEnvironment('thread-1', 'turn-1', 'call-1');
    expect(environment.leadingToolPathSegments).toEqual([binDirectory]);
  });

  symlinkTest('refuses command links through a substituted versions directory', async () => {
    const root = await temporaryRoot();
    const userDataRoot = path.join(root, 'user-data');
    const installRoot = path.join(userDataRoot, 'browser-pilot');
    const outsideVersions = path.join(root, 'outside-versions');
    const executable = path.join(outsideVersions, '0.6.1-darwin-arm64', 'browser-pilot');
    const binDirectory = path.join(installRoot, 'bin');
    await mkdir(path.dirname(executable), { recursive: true });
    await mkdir(binDirectory, { recursive: true });
    await writeFile(executable, '#!/bin/sh\n', 'utf8');
    await symlink(outsideVersions, path.join(installRoot, 'versions'), 'dir');
    await symlink(executable, path.join(binDirectory, 'bp'));
    const host = new BrowserPilotHost({
      userDataRoot,
      scratchRoot: path.join(root, 'scratch'),
      loadInstallationId: async () => 'installation-id',
    });

    await expect(host.processEnvironment('thread-1', 'turn-1', 'call-1'))
      .rejects.toThrow('versions path is not a normal directory');
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-browser-pilot-host-'));
  roots.push(root);
  return root;
}
