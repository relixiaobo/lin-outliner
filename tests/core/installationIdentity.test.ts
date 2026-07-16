import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  INSTALLATION_IDENTITY_FILE,
  loadOrCreateInstallationId,
} from '../../src/main/installationIdentity';

let root = '';

describe('installation identity', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'tenon-installation-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('creates one stable identity under concurrent startup', async () => {
    const ids = await Promise.all(
      Array.from({ length: 24 }, () => loadOrCreateInstallationId(root)),
    );
    expect(new Set(ids).size).toBe(1);
    expect(await loadOrCreateInstallationId(root)).toBe(ids[0]);

    const stored = JSON.parse(await readFile(path.join(root, INSTALLATION_IDENTITY_FILE), 'utf8'));
    expect(stored).toEqual({
      kind: 'tenon-installation',
      schemaVersion: 1,
      installationId: ids[0],
    });
  });

  test('mints distinct identities for isolated userData roots', async () => {
    const otherRoot = await mkdtemp(path.join(tmpdir(), 'tenon-installation-other-'));
    try {
      expect(await loadOrCreateInstallationId(root)).not.toBe(await loadOrCreateInstallationId(otherRoot));
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  test('rejects a malformed persisted identity instead of silently replacing it', async () => {
    const identityPath = path.join(root, INSTALLATION_IDENTITY_FILE);
    await writeFile(identityPath, JSON.stringify({
      kind: 'tenon-installation',
      schemaVersion: 1,
      installationId: 'not-a-uuid',
    }));

    await expect(loadOrCreateInstallationId(root)).rejects.toThrow('Invalid Tenon installation identity');
    expect(JSON.parse(await readFile(identityPath, 'utf8')).installationId).toBe('not-a-uuid');
  });
});
