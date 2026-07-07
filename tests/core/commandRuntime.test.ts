import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core } from '../../src/core/core';
import type { OutlinerToolHost } from '../../src/main/agentNodeTools';

const electronUserDataRoot = path.join(tmpdir(), 'lin-agent-command-runtime-test-user-data');

mock.module('electron', () => ({
  app: { getPath: () => electronUserDataRoot, getVersion: () => 'test' },
  BrowserWindow: class { static getAllWindows() { return []; } },
  session: { fromPartition: () => ({ clearStorageData: async () => undefined }) },
}));

type RuntimeModule = typeof import('../../src/main/agentRuntime');
let runtimeModulePromise: Promise<RuntimeModule> | null = null;
async function loadRuntimeModule() {
  runtimeModulePromise ??= import('../../src/main/agentRuntime');
  return runtimeModulePromise;
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface HandleCall { command: string; args: Record<string, unknown> }

function recordingHost(core: Core, calls: HandleCall[]): OutlinerToolHost {
  return {
    getProjection: () => core.projection(),
    transaction: async (_meta, fn) => fn(),
    operationHistory: async () => ({ entries: [], count: 0 }),
    handle: async (command, args) => {
      calls.push({ command, args: args as Record<string, unknown> });
      return {} as never;
    },
  };
}

async function createRuntime(dataRoot: string, core: Core, calls: HandleCall[]) {
  const { AgentRuntime } = await loadRuntimeModule();
  return new AgentRuntime(
    () => ({ webContents: { send: () => undefined } }) as never,
    recordingHost(core, calls),
    {
      agentDataRoot: dataRoot,
      providerConfigLoader: async () => null,
      runtimeSettingsLoader: async () => ({
        permissionMode: 'trusted',
        automaticSkillsEnabled: false,
        slashSkillsEnabled: false,
        compactEnabled: true,
        additionalSkillDirectories: [],
      }),
    },
  );
}

describe('command runtime', () => {
  test('ensureCommandConversation persists the delivery conversation without materializing a conversation', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-command-runtime-'));
    roots.push(dataRoot);
    const calls: HandleCall[] = [];
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const created = core.createNode(libraryId, null, 'Summarize my unread feeds');
    const nodeId = created.focus!.nodeId;
    core.setCommandNode(nodeId);
    const runtime = await createRuntime(dataRoot, core, calls);

    const { conversationId } = await runtime.ensureCommandConversation(nodeId);
    expect(conversationId).toBeTruthy();

    const conversations = (runtime as unknown as { conversations: Map<string, unknown> }).conversations;
    expect(conversations.has(conversationId)).toBe(false);
  });

  test('Run now is a no-op when a run for the same command node is already in flight', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-command-runtime-'));
    roots.push(dataRoot);
    const calls: HandleCall[] = [];
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const nodeId = core.createNode(libraryId, null, 'Summarize my unread feeds').focus!.nodeId;
    core.setCommandNode(nodeId);
    const runtime = await createRuntime(dataRoot, core, calls);

    (runtime as unknown as { firingCommandNodeIds: Set<string> }).firingCommandNodeIds.add(nodeId);

    const result = await runtime.runCommandNow(nodeId);
    expect(result.conversationId).toBeTruthy();
    expect(calls).toEqual([]);
  });

  test('Run now sends the command title and non-field child outline as the brief', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-command-runtime-'));
    roots.push(dataRoot);
    const calls: HandleCall[] = [];
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const nodeId = core.createNode(libraryId, null, 'Summarize my unread feeds').focus!.nodeId;
    core.setCommandNode(nodeId);
    core.createNode(nodeId, null, 'Include starred items');
    const runtime = await createRuntime(dataRoot, core, calls);

    let capturedBrief = '';
    (runtime as unknown as { runCommandChildAgent: (conversationId: string, brief: string) => Promise<void> }).runCommandChildAgent =
      async (_conversationId, brief) => {
        capturedBrief = brief;
      };

    await runtime.runCommandNow(nodeId);

    expect(capturedBrief).toBe('Summarize my unread feeds\n- Include starred items');
  });
});
