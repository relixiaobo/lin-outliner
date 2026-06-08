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
  const runtime = new AgentRuntime(
    () => ({ webContents: { send: () => undefined } }) as never,
    recordingHost(core, calls),
    {
      agentDataRoot: dataRoot,
      // No provider is configured, so an agent run cannot complete.
      providerConfigLoader: async () => null,
      runtimeSettingsLoader: async () => ({
        permissionMode: 'trusted',
        automaticSkillsEnabled: false,
        slashSkillsEnabled: false,
        compactEnabled: true,
        additionalSkillDirectories: [],
        additionalAgentDirectories: [],
      }),
    },
  );
  return runtime;
}

describe('command runtime — failed fires', () => {
  test('a fire that cannot complete does NOT advance the watermark and arms backoff', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-command-runtime-'));
    roots.push(dataRoot);
    const calls: HandleCall[] = [];
    const runtime = await createRuntime(dataRoot, Core.new(), calls);

    const due = {
      nodeId: 'cmd-1',
      brief: 'Summarize my unread feeds',
      schedule: '2026-06-09T09:00 RRULE:FREQ=DAILY',
      dueAt: new Date(2026, 5, 9, 9, 0).getTime(),
      lastSuccessAt: null,
    };
    // fireCommand swallows the failure internally (so the sweep never rejects);
    // assert on its side effects.
    await (runtime as unknown as { fireCommand: (d: typeof due, now: Date) => Promise<void> })
      .fireCommand(due, new Date(2026, 5, 9, 10, 0));

    // The run failed (no provider), so the watermark must NOT have advanced —
    // `mark_command_fired` is never issued, leaving the occurrence due.
    expect(calls.some((call) => call.command === 'mark_command_fired')).toBe(false);
    // …and a backoff is armed so a persistently failing command does not tight-loop.
    const backoff = (runtime as unknown as { commandBackoffUntil: Map<string, number> }).commandBackoffUntil;
    expect(backoff.has('cmd-1')).toBe(true);
    runtime.stopCommandScheduler();
  });

  test('a fire that completes advances the watermark and clears backoff', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-command-runtime-'));
    roots.push(dataRoot);
    const calls: HandleCall[] = [];
    const runtime = await createRuntime(dataRoot, Core.new(), calls);

    const due = {
      nodeId: 'cmd-ok',
      brief: 'Summarize my unread feeds',
      schedule: '2026-06-09T09:00 RRULE:FREQ=DAILY',
      dueAt: new Date(2026, 5, 9, 9, 0).getTime(),
      lastSuccessAt: null,
      commandAgent: undefined,
    };
    // The provider-less env can't truly run a subagent, so stub the execution to a
    // clean completion — this exercises fireCommand's SUCCESS branch (the run is
    // covered end-to-end by the failed-fire test above).
    (runtime as unknown as { runCommandSubagent: () => Promise<void> }).runCommandSubagent = async () => undefined;
    const backoff = (runtime as unknown as { commandBackoffUntil: Map<string, number> }).commandBackoffUntil;
    const failures = (runtime as unknown as { commandFailureCounts: Map<string, number> }).commandFailureCounts;
    backoff.set('cmd-ok', Date.now() + 100_000);
    failures.set('cmd-ok', 2);

    await (runtime as unknown as { fireCommand: (d: typeof due, now: Date) => Promise<void> })
      .fireCommand(due, new Date(2026, 5, 9, 10, 0));

    // A completed run advances the watermark and clears any failure backoff.
    expect(calls.some((call) => call.command === 'mark_command_fired')).toBe(true);
    expect(backoff.has('cmd-ok')).toBe(false);
    expect(failures.has('cmd-ok')).toBe(false);
    runtime.stopCommandScheduler();
  });

  test('ensureCommandConversation persists the delivery conversation without materializing a session', async () => {
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

    // Persist-only: NO in-memory session yet. Restore creates the single session;
    // creating one here too would `abort()` + recreate it mid-run and diverge the
    // event seq ("seq N is not after existing M"). This guards that regression.
    const sessions = (runtime as unknown as { sessions: Map<string, unknown> }).sessions;
    expect(sessions.has(conversationId)).toBe(false);
    runtime.stopCommandScheduler();
  });

  test('Run now is a no-op when a fire for the same node is already in flight', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-command-runtime-'));
    roots.push(dataRoot);
    const calls: HandleCall[] = [];
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const created = core.createNode(libraryId, null, 'Summarize my unread feeds');
    const nodeId = created.focus!.nodeId;
    core.setCommandNode(nodeId);
    const runtime = await createRuntime(dataRoot, core, calls);

    // Simulate a scheduled fire already in flight for this node.
    (runtime as unknown as { firingCommandNodeIds: Set<string> }).firingCommandNodeIds.add(nodeId);

    // Run now must NOT start a colliding second run; it surfaces the existing
    // delivery conversation and resolves cleanly.
    const result = await runtime.runCommandNow(nodeId);
    expect(result.conversationId).toBeTruthy();
    expect(calls.length).toBe(0); // no run started, no node-tool calls
    runtime.stopCommandScheduler();
  });
});
