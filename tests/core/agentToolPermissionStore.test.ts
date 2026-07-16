import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';

const userData = '/tmp/lin-agent-tool-permission-store-test';

mock.module('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  session: {
    fromPartition: () => ({ clearStorageData: async () => undefined }),
  },
}));

const {
  appendAgentToolPermissionBlock,
  grantAgentFolderCapability,
  readAgentToolPermissionSettings,
  removeAgentToolPermissionBlock,
  resetFolderCapabilityServiceForTests,
  writeAgentToolPermissionSettings,
} = await import('../../src/main/agentToolPermissionStore');

describe('agent folder capability store', () => {
  beforeEach(async () => {
    resetFolderCapabilityServiceForTests();
    await fs.rm(userData, { recursive: true, force: true });
  });

  afterEach(async () => {
    resetFolderCapabilityServiceForTests();
    await fs.rm(userData, { recursive: true, force: true });
  });

  test('persists only canonical folders and explicit blocks as private JSON', async () => {
    const folder = path.join(userData, 'project');
    await fs.mkdir(folder, { recursive: true });
    const canonicalFolder = await fs.realpath(folder);
    await writeAgentToolPermissionSettings({
      folders: [canonicalFolder],
      blocks: ['Action(git.publish_remote)'],
    });

    const filePath = path.join(userData, 'agent-tool-permissions.json');
    expect(await readAgentToolPermissionSettings()).toEqual({
      folders: [canonicalFolder],
      blocks: ['Action(git.publish_remote)'],
    });
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual({
      folders: [canonicalFolder],
      blocks: ['Action(git.publish_remote)'],
    });
    if (process.platform !== 'win32') {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  test('serializes concurrent folder and block updates without dropping either', async () => {
    const folder = path.join(userData, 'project');
    await fs.mkdir(folder, { recursive: true });
    const canonicalFolder = await fs.realpath(folder);
    await Promise.all([
      grantAgentFolderCapability(folder),
      appendAgentToolPermissionBlock('Command(git push origin main)'),
    ]);

    expect(await readAgentToolPermissionSettings()).toEqual({
      folders: [canonicalFolder],
      blocks: ['Command(git push origin main)'],
    });
  });

  test('removes a user block without touching folder capabilities', async () => {
    const folder = path.join(userData, 'project');
    await fs.mkdir(folder, { recursive: true });
    const canonicalFolder = await fs.realpath(folder);
    await writeAgentToolPermissionSettings({
      folders: [canonicalFolder],
      blocks: ['Command(git push origin main)', 'Action(git.publish_remote)'],
    });

    await removeAgentToolPermissionBlock('Command(git push origin main)');

    expect(await readAgentToolPermissionSettings()).toEqual({
      folders: [canonicalFolder],
      blocks: ['Action(git.publish_remote)'],
    });
  });
});
