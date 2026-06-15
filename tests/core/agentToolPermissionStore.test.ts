import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';

const userData = '/tmp/lin-agent-tool-permission-store-test';

mock.module('electron', () => ({
  app: { getPath: () => userData },
}));

const {
  appendAgentToolPermissionGrant,
  readAgentToolPermissionSettings,
  writeAgentToolPermissionSettings,
} = await import('../../src/main/agentToolPermissionStore');

describe('agent tool permission store', () => {
  beforeEach(async () => {
    await fs.rm(userData, { recursive: true, force: true });
  });

  afterEach(async () => {
    await fs.rm(userData, { recursive: true, force: true });
  });

  test('persists narrow grants as private JSON', async () => {
    await writeAgentToolPermissionSettings({
      grants: ['Scope(read:/tmp/project)', 'External(git:origin)'],
    });

    const filePath = path.join(userData, 'agent-tool-permissions.json');
    expect(await readAgentToolPermissionSettings()).toEqual({
      grants: ['Scope(read:/tmp/project)', 'External(git:origin)'],
    });

    if (process.platform !== 'win32') {
      const stat = await fs.stat(filePath);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  test('serializes concurrent grant appends without dropping a grant', async () => {
    await Promise.all([
      appendAgentToolPermissionGrant('Scope(read:/tmp/project)'),
      appendAgentToolPermissionGrant('Command(npm test)'),
      appendAgentToolPermissionGrant('External(git:origin)'),
    ]);

    const settings = await readAgentToolPermissionSettings();
    expect(settings.grants?.sort()).toEqual([
      'Command(npm test)',
      'External(git:origin)',
      'Scope(read:/tmp/project)',
    ]);
  });
});
