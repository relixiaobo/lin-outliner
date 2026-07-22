import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentCoreExtension, TurnAdmissionContext } from '../../src/core/agent/extensions';
import type { AgentCoreNotification, ThreadItem } from '../../src/core/agent/protocol';
import { ExtensionRegistry } from '../../src/main/agent/ExtensionRegistry';
import { ThreadService, type ThreadServiceStores } from '../../src/main/agent/ThreadService';
import { GoalStore } from '../../src/main/agent/extensions/goal/GoalStore';
import { RolloutStore } from '../../src/main/agent/persistence/RolloutStore';
import { ThreadHistoryProjectionStore } from '../../src/main/agent/persistence/ThreadHistoryProjectionStore';
import { ThreadMetadataStore } from '../../src/main/agent/persistence/ThreadMetadataStore';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';
import type { TurnExecutionContext, TurnExecutionResult, TurnExecutor } from '../../src/main/agent/runtime/types';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class ControlledExecutor implements TurnExecutor {
  readonly contexts: TurnExecutionContext[] = [];
  readonly steered: string[] = [];
  private readonly completions: Array<(result: TurnExecutionResult) => void> = [];

  async execute(context: TurnExecutionContext): Promise<TurnExecutionResult> {
    this.contexts.push(context);
    const itemId = context.recorder.createItemId();
    const started: ThreadItem = {
      type: 'agentMessage',
      id: itemId,
      provenance: context.recorder.localProvenance(itemId),
      text: '',
      phase: 'final_answer',
      memoryCitation: null,
    };
    await context.recorder.started(started);
    context.onSteer((input) => {
      this.steered.push(input.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n'));
    });
    const result = await new Promise<TurnExecutionResult>((resolve) => {
      this.completions.push(resolve);
      if (context.signal.aborted) resolve({ status: 'interrupted' });
      else context.signal.addEventListener('abort', () => resolve({ status: 'interrupted' }), { once: true });
    });
    await context.recorder.completed({
      ...started,
      text: result.status === 'interrupted' ? 'Interrupted' : 'Done',
    });
    return result;
  }

  finish(index = 0, result: TurnExecutionResult = { status: 'completed', tokensUsed: 7 }): void {
    const complete = this.completions[index];
    if (!complete) throw new Error(`Executor call ${index} is not waiting`);
    complete(result);
  }

  async waitUntilWaiting(index = 0): Promise<void> {
    while (!this.completions[index]) await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('ThreadService', () => {
  test('enforces one active Turn, deduplicates client input, steers, and persists canonical history', async () => {
    const fixture = await createFixture();
    const notifications: AgentCoreNotification[] = [];
    fixture.service.subscribe((notification) => notifications.push(notification));
    const thread = (await fixture.service.startThread({
      name: 'Canonical runtime',
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;

    const request = {
      threadId: thread.id,
      input: [{ type: 'text' as const, text: 'Implement it' }],
      clientUserMessageId: 'submit-1',
    };
    const accepted = await fixture.service.startRendererTurn(request);
    const retry = await fixture.service.startRendererTurn(request);
    expect(retry).toEqual({ ...accepted, deduplicated: true });
    await expect(fixture.service.startRendererTurn({
      ...request,
      clientUserMessageId: 'submit-2',
    })).rejects.toThrow('active Turn');

    const steered = await fixture.service.steerTurn({
      threadId: thread.id,
      expectedTurnId: accepted.turn.id,
      input: [{ type: 'text', text: 'Also update the tests' }],
      clientUserMessageId: 'steer-1',
    });
    expect(steered.deduplicated).toBe(false);
    expect(fixture.executor.steered).toEqual(['Also update the tests']);

    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish();
    await fixture.service.waitForIdle(thread.id);
    const stored = fixture.service.readThread({ threadId: thread.id, includeTurns: true }).thread;
    expect(stored.status).toEqual({ type: 'idle' });
    expect(stored.turns).toHaveLength(1);
    expect(stored.turns?.[0]).toMatchObject({ status: 'completed', id: accepted.turn.id });
    expect(stored.turns?.[0]?.items.map((item) => item.type)).toEqual([
      'userMessage',
      'agentMessage',
      'userMessage',
    ]);
    expect(notifications.map((notification) => notification.type)).toContain('turn/completed');
    await fixture.service.close();

    const reopened = await openFixture(fixture.root, new ControlledExecutor(), fixture.clock);
    await reopened.service.initialize();
    expect(reopened.service.readThread({ threadId: thread.id, includeTurns: true }).thread.turns).toEqual(stored.turns);
    await reopened.service.close();
  });

  test('interrupts the exact active Turn and records a terminal history fact', async () => {
    const fixture = await createFixture();
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const accepted = await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Long work' }],
    });
    await expect(fixture.service.interruptTurn(thread.id, '018f0f24-7b2e-7a3f-8a4b-123456789abc'))
      .rejects.toThrow('Expected Turn');
    await fixture.service.interruptTurn(thread.id, accepted.turn.id);
    await fixture.service.waitForIdle(thread.id);
    expect(fixture.service.readThread({ threadId: thread.id, includeTurns: true }).thread.turns?.[0]?.status)
      .toBe('interrupted');
    await fixture.service.close();
  });

  test('forks immutable history with local ids and ultimate provenance without reusing client ids', async () => {
    const fixture = await createFixture();
    const source = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const accepted = await fixture.service.startRendererTurn({
      threadId: source.id,
      input: [{ type: 'text', text: 'Original input' }],
      clientUserMessageId: 'original-submit',
    });
    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish();
    await fixture.service.waitForIdle(source.id);
    const sourceTurn = fixture.service.readThread({ threadId: source.id, includeTurns: true }).thread.turns![0]!;

    const fork = (await fixture.service.forkThread({
      threadId: source.id,
      boundary: { kind: 'afterTurn', turnId: accepted.turn.id },
      name: 'Alternative',
    })).thread;
    const copied = fixture.service.readThread({ threadId: fork.id, includeTurns: true }).thread.turns![0]!;
    expect(fork.forkedFromId).toBe(source.id);
    expect(fork.parentThreadId).toBeNull();
    expect(copied.id).not.toBe(sourceTurn.id);
    expect(copied.provenance).toEqual(sourceTurn.provenance);
    expect(copied.items[0]?.id).not.toBe(sourceTurn.items[0]?.id);
    expect(copied.items[0]?.provenance).toEqual(sourceTurn.items[0]?.provenance);
    expect(copied.items[0]).toMatchObject({ type: 'userMessage', clientId: null });
    await fixture.service.close();
  });

  test('captures host and per-Thread admission generations under their barriers', async () => {
    const extension = new AdmissionProbe();
    const registry = new ExtensionRegistry();
    registry.register(extension);
    const fixture = await createFixture(registry);
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.withHostRootTurnAdmissionBarrier(async () => undefined);
    await fixture.service.withThreadAdmissionBarrier(thread.id, async () => undefined);
    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Snapshot barriers' }],
    });
    expect(extension.contexts).toHaveLength(1);
    expect(extension.contexts[0]?.hostBarrier.generation).toBe(1);
    expect(extension.contexts[0]?.threadBarrier.generation).toBe(1);
    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish();
    await fixture.service.waitForIdle(thread.id);
    await fixture.service.close();
  });
});

class AdmissionProbe implements AgentCoreExtension {
  readonly id = 'admission-probe';
  readonly contexts: TurnAdmissionContext[] = [];

  contributeTurnAdmission(context: TurnAdmissionContext) {
    this.contexts.push(context);
    return { extensionId: this.id, snapshotId: `snapshot-${this.contexts.length}` };
  }
}

interface Fixture {
  root: string;
  service: ThreadService;
  executor: ControlledExecutor;
  clock: () => number;
}

async function createFixture(extensions?: ExtensionRegistry): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-thread-service-'));
  roots.push(root);
  let now = 1_720_000_000_000;
  const clock = () => ++now;
  const executor = new ControlledExecutor();
  const opened = await openFixture(root, executor, clock, extensions);
  await opened.service.initialize();
  return { root, executor, clock, service: opened.service };
}

async function openFixture(
  root: string,
  executor: ControlledExecutor,
  clock: () => number,
  extensions?: ExtensionRegistry,
): Promise<{ service: ThreadService }> {
  const stores = createStores(root);
  return {
    service: new ThreadService({ stores, executor, now: clock, extensions }),
  };
}

function createStores(root: string): ThreadServiceStores {
  mkdirSync(join(root, 'agent'), { recursive: true });
  const statePath = join(root, 'agent', 'state.sqlite');
  const historyPath = join(root, 'agent', 'thread_history.sqlite');
  const goalsPath = join(root, 'agent', 'goals.sqlite');
  return {
    metadata: new ThreadMetadataStore(statePath, database(statePath)),
    history: new ThreadHistoryProjectionStore(historyPath, database(historyPath)),
    rollout: new RolloutStore(join(root, 'agent', 'rollouts')),
    goals: new GoalStore(goalsPath, database(goalsPath)),
  };
}

function database(path: string): SqliteDatabase {
  return new Database(path, { create: true }) as unknown as SqliteDatabase;
}
