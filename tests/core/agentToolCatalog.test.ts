import { describe, expect, mock, test } from 'bun:test';
import { TOOL_CATALOG } from '../../src/core/agentToolCatalog';
import type { AgentChannelToolRuntime } from '../../src/main/agentChannelTools';
import type { AgentDelegationRuntime } from '../../src/main/agentDelegation';

mock.module('electron', () => ({
  app: {
    getPath: () => '/tmp',
    getName: () => 'Tenon',
    isPackaged: false,
  },
  BrowserWindow: class BrowserWindow {},
  session: {
    fromPartition: () => ({
      clearStorageData: async () => undefined,
    }),
  },
}));

describe('agent tool catalog', () => {
  test('matches the runtime tool filter names exposed to agent authoring', async () => {
    const { createAgentTools } = await import('../../src/main/agentTools');
    const filteredNames = createAgentTools(undefined, {
      localFileRoot: '/tmp',
      delegationRuntime: {} as AgentDelegationRuntime,
      allowedTools: [...TOOL_CATALOG],
    })
      .map((tool) => tool.name.toLowerCase())
      .sort();

    expect(filteredNames).toEqual([...TOOL_CATALOG].sort());
  });

  test('keeps channel organization tools out of ordinary child-run catalogs', async () => {
    const { createAgentTools } = await import('../../src/main/agentTools');
    const ordinaryNames = createAgentTools(undefined, { localFileRoot: '/tmp' }).map((tool) => tool.name);
    const coordinatorNames = createAgentTools(undefined, {
      localFileRoot: '/tmp',
      channelOrg: {} as AgentChannelToolRuntime,
    }).map((tool) => tool.name);

    expect(ordinaryNames).not.toContain('channel_create');
    expect(ordinaryNames).not.toContain('channel_update');
    expect(coordinatorNames).toEqual(expect.arrayContaining(['channel_create', 'channel_update']));
  });
});
