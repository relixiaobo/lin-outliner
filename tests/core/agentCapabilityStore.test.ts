import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';

const userData = '/tmp/tenon-agent-capability-store-test';

mock.module('electron', () => ({
  app: { getPath: () => userData },
}));

const {
  applyAgentCapabilitySettingsPatch,
  appendAgentCapabilityBlock,
  readAgentCapabilitySettings,
} = await import('../../src/main/agentCapabilityStore');

describe('agent capability store', () => {
  beforeEach(async () => {
    await fs.rm(userData, { recursive: true, force: true });
  });

  afterEach(async () => {
    await fs.rm(userData, { recursive: true, force: true });
  });

  test('persists only explicit blocks as private JSON', async () => {
    await appendAgentCapabilityBlock('Action(git.publish_remote)');

    const filePath = path.join(userData, 'agent-capabilities.json');
    expect(await readAgentCapabilitySettings()).toEqual({
      blocks: ['Action(git.publish_remote)'],
    });
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual({
      blocks: ['Action(git.publish_remote)'],
    });
    if (process.platform !== 'win32') {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  test('serializes concurrent block updates without dropping either', async () => {
    await Promise.all([
      appendAgentCapabilityBlock('Action(git.publish_remote)'),
      appendAgentCapabilityBlock('Command(git push origin main)'),
    ]);

    expect((await readAgentCapabilitySettings()).blocks.sort()).toEqual([
      'Action(git.publish_remote)',
      'Command(git push origin main)',
    ]);
  });

  test('removes one block without touching concurrent additions', async () => {
    await appendAgentCapabilityBlock('Action(git.publish_remote)');
    await appendAgentCapabilityBlock('Command(npm publish)');

    await Promise.all([
      appendAgentCapabilityBlock('Command(git push origin main)'),
      applyAgentCapabilitySettingsPatch({ removeBlocks: ['Command(npm publish)'] }),
    ]);

    expect((await readAgentCapabilitySettings()).blocks.sort()).toEqual([
      'Action(git.publish_remote)',
      'Command(git push origin main)',
    ]);
  });
});
