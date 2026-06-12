import { describe, expect, mock, test } from 'bun:test';
import { TOOL_CATALOG } from '../../src/core/agentToolCatalog';
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
});
