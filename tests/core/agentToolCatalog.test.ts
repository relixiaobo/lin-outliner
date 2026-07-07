import { describe, expect, mock, test } from 'bun:test';
import { TOOL_CATALOG } from '../../src/core/agentToolCatalog';
import type { AgentDelegationRuntime } from '../../src/main/agentDelegation';
import type { AgentIssueToolRuntime } from '../../src/main/agentIssueTools';
import type { OutlinerToolHost } from '../../src/main/agentNodeTools';

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
      imageGeneration: {
        listModels: async () => [],
        getActiveProviderId: async () => null,
        readLocalImage: async () => { throw new Error('not used'); },
        writeGeneratedImage: async () => { throw new Error('not used'); },
        generateImages: async () => { throw new Error('not used'); },
      },
      issueRuntime: issueRuntimeStub(),
      allowedTools: [...TOOL_CATALOG],
    })
      .map((tool) => tool.name.toLowerCase())
      .sort();

    expect(filteredNames).toEqual([...TOOL_CATALOG].sort());
  });

  test('Issue runtime suppresses legacy Run tools unless explicitly enabled', async () => {
    const { createAgentTools } = await import('../../src/main/agentTools');
    const currentNames = createAgentTools(undefined, {
      localFileRoot: '/tmp',
      delegationRuntime: {} as AgentDelegationRuntime,
      issueRuntime: issueRuntimeStub(),
    }).map((tool) => tool.name);
    expect(currentNames).toEqual(expect.arrayContaining([
      'issue_search',
      'agent_session_start',
    ]));
    expect(currentNames).not.toContain('spawn_run');
    expect(currentNames).not.toContain('run_status');
    expect(currentNames).not.toContain('run_steer');
    expect(currentNames).not.toContain('run_amend');
    expect(currentNames).not.toContain('run_stop');

    const legacyNames = createAgentTools(undefined, {
      localFileRoot: '/tmp',
      delegationRuntime: {} as AgentDelegationRuntime,
      issueRuntime: issueRuntimeStub(),
      legacyDelegationToolsEnabled: true,
    }).map((tool) => tool.name);
    expect(legacyNames).toEqual(expect.arrayContaining([
      'spawn_run',
      'run_status',
      'run_steer',
      'run_amend',
      'run_stop',
    ]));
  });

  test('default outliner-backed tools do not expose the internal data import adapter', async () => {
    const { createAgentTools } = await import('../../src/main/agentTools');
    const host: OutlinerToolHost = {
      getProjection: () => ({ nodes: [], rootId: 'root', todayId: 'today', trashId: 'trash' } as any),
      handle: async () => ({}),
    };
    const names = createAgentTools(host, { localFileRoot: '/tmp' }).map((tool) => tool.name);

    expect(names).not.toContain('data_import');
    expect(names).toContain('node_create');
  });
});

function issueRuntimeStub(): AgentIssueToolRuntime {
  return {
    search: () => ({ rows: [] }),
    read: (input) => ({ target: input.target }),
    create: () => ({ status: 'preview', targets: [] }),
    update: () => ({ status: 'preview', targets: [] }),
    startSession: () => ({ status: 'preview', targets: [] }),
    readSession: () => null,
    sendSessionMessage: () => ({ status: 'preview', targets: [] }),
    stopSession: () => ({ status: 'preview', targets: [] }),
  };
}
