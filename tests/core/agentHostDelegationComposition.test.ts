import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, mkdir, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AgentRuntimeSettings, DocumentProjection } from '../../src/core/types';
import type { AgentImageGenerationRuntime } from '../../src/main/agent/capabilities/agentImageGenerationTool';
import { resolveDelegateCliRuntime } from '../../src/main/delegateRuntime';

const roots: string[] = [];
let currentUserData = '';

mock.module('electron', () => ({
  app: { getPath: () => currentUserData },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  session: { fromPartition: () => ({ clearStorageData: async () => undefined }) },
  safeStorage: { isEncryptionAvailable: () => false },
}));

mock.module('../../src/main/agent/persistence/sqlite', () => ({
  openSqlite: (databasePath: string) => new Database(databasePath, { create: true }),
}));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Agent Host delegation composition', () => {
  test('starts and stops the production broker with its durable Session store', async () => {
    const root = await mkdtemp('/tmp/tenon-host-');
    roots.push(root);
    const userDataDir = path.join(root, 'user-data');
    currentUserData = userDataDir;
    const scratchRoot = path.join(root, 'scratch');
    const cwd = path.join(root, 'workspace');
    await Promise.all([mkdir(userDataDir), mkdir(scratchRoot), mkdir(cwd)]);
    const projection = emptyProjection();
    const [
      { defaultEffectiveThreadConfiguration },
      { createAgentHost },
    ] = await Promise.all([
      import('../../src/main/agent/AgentConfigurationLoader'),
      import('../../src/main/hostDomain/agentHost'),
    ]);
    const host = createAgentHost({
      userDataDir,
      scratchRoot,
      defaultCwd: cwd,
      appVersion: 'test',
      delegateCliRuntime: resolveDelegateCliRuntime({
        isPackaged: false,
        moduleDir: path.join(process.cwd(), 'src', 'main'),
        resourcesPath: '/unused',
        processExecPath: '/unused/Tenon',
      }),
      loadRuntimeSettings: async () => runtimeSettings(),
      timeline: {
        getProjection: () => projection,
        runChanges: async () => undefined,
        runPlannedChanges: async (build) => { await build(projection); },
        log: async () => [],
      },
      reportError: () => undefined,
      prepareImageArtifact: async () => { throw new Error('Not used by composition smoke'); },
      createTurnExecutorOptions: () => ({}),
      createThreadOptions: () => ({}),
      createToolOptions: () => ({}),
      createLocalWorkspaceOptions: () => ({
        processEnvironment: async () => ({ env: process.env }),
      }),
      createImageGenerationRuntime: () => ({} as AgentImageGenerationRuntime),
      createAdmissionSkillRuntimeOptions: () => ({}),
      createTurnSkillRuntimeOptions: () => ({}),
      resolveAutomationConfiguration: async () => ({
        modelProvider: 'openai',
        configuration: defaultEffectiveThreadConfiguration(),
      }),
      validateAutomationConfiguration: async () => undefined,
    });
    const socketPath = path.join(userDataDir, 'agent', 'delegate-broker.sock');
    const storePath = path.join(userDataDir, 'agent', 'delegation.sqlite');

    try {
      await host.initialize(projection);
      expect((await lstat(socketPath)).isSocket()).toBe(true);
      expect((await lstat(storePath)).isFile()).toBe(true);
    } finally {
      await host.close();
    }
    await expect(lstat(socketPath)).rejects.toThrow();
  });
});

function runtimeSettings(): AgentRuntimeSettings {
  return {
    additionalSkillDirectories: [],
    providerTimeoutMs: null,
    providerMaxRetries: null,
    providerMaxRetryDelayMs: 60_000,
    providerCacheRetention: 'short',
    delegation: {
      enabled: false,
      defaultRunnerId: 'internal',
      maxConcurrentGlobal: 8,
      maxConcurrentThread: 4,
      maxQueuedGlobal: 32,
      maxQueuedThread: 8,
      runners: {
        internal: {
          enabled: true,
          model: null,
          effort: null,
          maximumAccess: 'workspace-write',
          timeoutMs: 60 * 60_000,
          maxConcurrent: 4,
          pool: 'agent-provider',
          maxConcurrentPool: 4,
        },
      },
    },
    disabledSkills: [],
  };
}

function emptyProjection(): DocumentProjection {
  return {
    workspaceId: 'workspace',
    rootId: 'root',
    libraryId: 'library',
    dailyNotesId: 'daily-notes',
    schemaId: 'schema',
    searchesId: 'searches',
    recentsId: 'recents',
    trashId: 'trash',
    todayId: 'today',
    nodes: [],
  };
}
