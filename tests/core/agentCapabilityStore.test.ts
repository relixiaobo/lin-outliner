import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';

const userData = '/tmp/tenon-agent-capability-store-test';

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
  applyAgentCapabilitySettingsPatch,
  appendAgentCapabilityBlock,
  grantAgentFolderCapability,
  readAgentCapabilitySettings,
  resetFolderCapabilityServiceForTests,
} = await import('../../src/main/agentCapabilityStore');

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
    await grantAgentFolderCapability(canonicalFolder);
    await appendAgentCapabilityBlock('Action(git.publish_remote)');

    const filePath = path.join(userData, 'agent-capabilities.json');
    expect(await readAgentCapabilitySettings()).toEqual({
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
      appendAgentCapabilityBlock('Command(git push origin main)'),
    ]);

    expect(await readAgentCapabilitySettings()).toEqual({
      folders: [canonicalFolder],
      blocks: ['Command(git push origin main)'],
    });
  });

  test('removes a user block without touching folder capabilities', async () => {
    const folder = path.join(userData, 'project');
    await fs.mkdir(folder, { recursive: true });
    const canonicalFolder = await fs.realpath(folder);
    await grantAgentFolderCapability(canonicalFolder);
    await appendAgentCapabilityBlock('Command(git push origin main)');
    await appendAgentCapabilityBlock('Action(git.publish_remote)');

    await applyAgentCapabilitySettingsPatch({ removeBlocks: ['Command(git push origin main)'] });

    expect(await readAgentCapabilitySettings()).toEqual({
      folders: [canonicalFolder],
      blocks: ['Action(git.publish_remote)'],
    });
  });

  test('applies removal patches without dropping a concurrent folder grant', async () => {
    const first = path.join(userData, 'first');
    const concurrent = path.join(userData, 'concurrent');
    await fs.mkdir(first, { recursive: true });
    await fs.mkdir(concurrent, { recursive: true });
    await grantAgentFolderCapability(first);
    await appendAgentCapabilityBlock('Action(git.publish_remote)');
    await appendAgentCapabilityBlock('Command(npm publish)');

    await Promise.all([
      grantAgentFolderCapability(concurrent),
      applyAgentCapabilitySettingsPatch({
        revokeFolders: [first],
        removeBlocks: ['Command(npm publish)'],
      }),
    ]);

    expect(await readAgentCapabilitySettings()).toEqual({
      folders: [await fs.realpath(concurrent)],
      blocks: ['Action(git.publish_remote)'],
    });
  });
});
