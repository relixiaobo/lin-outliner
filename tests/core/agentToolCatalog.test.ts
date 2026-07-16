import { describe, expect, mock, test } from 'bun:test';
import { TOOL_CATALOG } from '../../src/core/agentToolCatalog';
import type { AgentIssueToolRuntime } from '../../src/main/agentIssueTools';
import type { OutlinerToolHost } from '../../src/main/agentNodeTools';

const sessionPartitions: string[] = [];
const sessionFetches: Array<{ input: string; init?: RequestInit }> = [];

mock.module('electron', () => ({
  app: {
    getPath: () => '/tmp',
    getName: () => 'Tenon',
    isPackaged: false,
  },
  BrowserWindow: class BrowserWindow {},
  session: {
    get defaultSession() {
      throw new Error('web_fetch must not use Electron defaultSession');
    },
    fromPartition: (partition: string) => {
      sessionPartitions.push(partition);
      return {
        fetch: async (input: string, init?: RequestInit) => {
          sessionFetches.push({ input, init });
          return new Response('credential-free response '.repeat(80), {
            status: 200,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        },
        clearAuthCache: async () => undefined,
        clearCache: async () => undefined,
        setPermissionCheckHandler: () => undefined,
        setPermissionRequestHandler: () => undefined,
        clearStorageData: async () => undefined,
      };
    },
  },
}));

describe('agent tool catalog', () => {
  test('matches the runtime tool filter names exposed to agent authoring', async () => {
    const { createAgentTools } = await import('../../src/main/agentTools');
    const filteredNames = createAgentTools(undefined, {
      localFileRoot: '/tmp',
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

  test('delegation runtime remains internal and does not expose direct Run tools', async () => {
    const { createAgentTools } = await import('../../src/main/agentTools');
    const names = createAgentTools(undefined, {
      localFileRoot: '/tmp',
      issueRuntime: issueRuntimeStub(),
    }).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'issue_search',
      'agent_session_start',
    ]));
    expect(names).not.toContain('spawn_run');
    expect(names).not.toContain('run_status');
    expect(names).not.toContain('run_steer');
    expect(names).not.toContain('run_amend');
    expect(names).not.toContain('run_stop');
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

  test('web_fetch uses a credential-free session instead of Electron defaultSession', async () => {
    sessionPartitions.length = 0;
    sessionFetches.length = 0;
    const { createAgentTools } = await import('../../src/main/agentTools');
    const tool = createAgentTools(undefined, { localFileRoot: '/tmp', scratchRoot: '/tmp' })
      .find((candidate) => candidate.name === 'web_fetch');
    if (!tool) throw new Error('Expected web_fetch tool.');

    const result = await tool.execute('web-fetch-session-test', { url: 'https://example.test/content' });

    expect(result.details?.ok).toBe(true);
    expect(sessionPartitions).toEqual(['web-fetch-http']);
    expect(sessionFetches).toHaveLength(1);
    expect(sessionFetches[0]).toMatchObject({
      input: 'https://example.test/content',
      init: { credentials: 'omit', redirect: 'manual' },
    });
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
