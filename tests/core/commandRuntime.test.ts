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
      }),
    },
  );
  return runtime;
}

describe('command runtime — failed fires', () => {
  test('scheduled command catch-up is retired and does not auto-fire command nodes', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-command-runtime-'));
    roots.push(dataRoot);
    const calls: HandleCall[] = [];
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const nodeId = core.createNode(libraryId, null, 'Summarize my unread feeds').focus!.nodeId;
    core.setCommandNode(nodeId);
    core.setCommandSchedule(nodeId, '2026-06-09T09:00 RRULE:FREQ=DAILY', 'user');
    const runtime = await createRuntime(dataRoot, core, calls);

    runtime.runCommandCatchUp();
    await Promise.resolve();

    expect(calls.some((call) => call.command === 'mark_command_attempted')).toBe(false);
    expect(calls.some((call) => call.command === 'mark_command_fired')).toBe(false);
    runtime.stopCommandScheduler();
  });

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
    };
    // The provider-less env can't truly run a child run, so stub the execution to a
    // clean completion — this exercises fireCommand's SUCCESS branch (the run is
    // covered end-to-end by the failed-fire test above).
    (runtime as unknown as { runCommandChildAgent: () => Promise<void> }).runCommandChildAgent = async () => undefined;
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

    // Persist-only: NO in-memory conversation yet. Restore creates the single conversation;
    // creating one here too would `abort()` + recreate it mid-run and diverge the
    // event seq ("seq N is not after existing M"). This guards that regression.
    const conversations = (runtime as unknown as { conversations: Map<string, unknown> }).conversations;
    expect(conversations.has(conversationId)).toBe(false);
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

describe('command runtime — at-most-once', () => {
  const due = {
    nodeId: 'cmd-1',
    brief: 'Summarize my unread feeds',
    schedule: '2026-06-09T09:00 RRULE:FREQ=DAILY',
    dueAt: new Date(2026, 5, 9, 9, 0).getTime(),
    lastSuccessAt: null,
  };

  test('a successful fire records the attempt BEFORE advancing the watermark', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-command-runtime-'));
    roots.push(dataRoot);
    const calls: HandleCall[] = [];
    const runtime = await createRuntime(dataRoot, Core.new(), calls);
    (runtime as unknown as { runCommandChildAgent: () => Promise<void> }).runCommandChildAgent = async () => undefined;

    await (runtime as unknown as { fireCommand: (d: typeof due, now: Date) => Promise<void> })
      .fireCommand(due, new Date(2026, 5, 9, 10, 0));

    const attemptIdx = calls.findIndex((c) => c.command === 'mark_command_attempted');
    const firedIdx = calls.findIndex((c) => c.command === 'mark_command_fired');
    // The attempt is persisted (with the occurrence's dueAt) before the run, and
    // strictly before the success watermark — so a crash in between is recoverable.
    expect(attemptIdx).toBeGreaterThanOrEqual(0);
    expect(firedIdx).toBeGreaterThan(attemptIdx);
    expect(calls[attemptIdx]!.args.attemptedAt).toBe(due.dueAt);
    runtime.stopCommandScheduler();
  });

  test('a failed fire still records the attempt (so a crash mid-run is reconciled, not re-run)', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-command-runtime-'));
    roots.push(dataRoot);
    const calls: HandleCall[] = [];
    // No provider → the run cannot complete (failure branch).
    const runtime = await createRuntime(dataRoot, Core.new(), calls);

    await (runtime as unknown as { fireCommand: (d: typeof due, now: Date) => Promise<void> })
      .fireCommand(due, new Date(2026, 5, 9, 10, 0));

    // The attempt was recorded before the (failing) run; the watermark was NOT
    // advanced (the occurrence stays due for the in-memory backoff retry).
    expect(calls.some((c) => c.command === 'mark_command_attempted')).toBe(true);
    expect(calls.some((c) => c.command === 'mark_command_fired')).toBe(false);
    runtime.stopCommandScheduler();
  });

  test('startup reconciliation skips an interrupted occurrence (advances watermark, no re-fire)', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-command-runtime-'));
    roots.push(dataRoot);
    const calls: HandleCall[] = [];
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const nodeId = core.createNode(libraryId, null, 'Summarize my unread feeds').focus!.nodeId;
    core.setCommandNode(nodeId);
    // A prior occurrence was attempted (T2) but never recorded success (T1 < T2):
    // the app crashed mid-run.
    core.markCommandFired(nodeId, 1_000, 'system');
    core.markCommandAttempted(nodeId, 2_000, 'system');
    const runtime = await createRuntime(dataRoot, core, calls);

    await (runtime as unknown as { reconcileCommandAttempts: () => Promise<void> }).reconcileCommandAttempts();

    // At-most-once: the watermark is advanced past the attempted occurrence rather
    // than re-firing it — no run is started.
    const fired = calls.filter((c) => c.command === 'mark_command_fired');
    expect(fired).toHaveLength(1);
    expect(fired[0]!.args.nodeId).toBe(nodeId);
    expect(fired[0]!.args.firedAt).toBe(2_000);
    runtime.stopCommandScheduler();
  });

  test('reconciliation leaves a cleanly-fired command alone', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-command-runtime-'));
    roots.push(dataRoot);
    const calls: HandleCall[] = [];
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const nodeId = core.createNode(libraryId, null, 'Summarize my unread feeds').focus!.nodeId;
    core.setCommandNode(nodeId);
    // Last run completed cleanly: success (T2) is at/after the attempt (T1).
    core.markCommandAttempted(nodeId, 1_000, 'system');
    core.markCommandFired(nodeId, 2_000, 'system');
    const runtime = await createRuntime(dataRoot, core, calls);

    await (runtime as unknown as { reconcileCommandAttempts: () => Promise<void> }).reconcileCommandAttempts();

    expect(calls.some((c) => c.command === 'mark_command_fired')).toBe(false);
    runtime.stopCommandScheduler();
  });
});
