import { describe, expect, test } from 'bun:test';
import { Core, type CorePersistenceCapture } from '../../src/core/core';
import { WorkspaceSaver } from '../../src/main/workspaceSaver';

interface ScheduledTask {
  callback: () => void;
  due: number;
  canceled: boolean;
}

class TestClock {
  nowValue = 0;
  private nextId = 1;
  private tasks = new Map<number, ScheduledTask>();

  now = (): number => this.nowValue;

  schedule = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId++;
    this.tasks.set(id, { callback, due: this.nowValue + delayMs, canceled: false });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  clear(id: ReturnType<typeof setTimeout>): void {
    const task = this.tasks.get(id as unknown as number);
    if (task) task.canceled = true;
  }

  async advance(ms: number): Promise<void> {
    this.nowValue += ms;
    while (true) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => !task.canceled && task.due <= this.nowValue)
        .sort(([, left], [, right]) => left.due - right.due)[0];
      if (!due) break;
      this.tasks.delete(due[0]);
      due[1].callback();
      await settle();
    }
  }
}

class FakeStore {
  appends: CorePersistenceCapture[] = [];
  compactions: string[] = [];
  failAppend = false;
  failCompact = false;
  reportedLogBytes = 1;
  appendGate: Promise<void> | undefined;
  releaseAppend: (() => void) | undefined;
  compactGate: Promise<void> | undefined;
  releaseCompact: (() => void) | undefined;

  async append(capture: CorePersistenceCapture): Promise<number> {
    if (this.failAppend) return Promise.reject(new Error('append failed'));
    this.appends.push(capture);
    await this.appendGate;
    return this.reportedLogBytes;
  }

  compact(snapshot: string): Promise<void> {
    this.compactions.push(snapshot);
    if (this.failCompact) return Promise.reject(new Error('compact failed'));
    return this.compactGate ?? Promise.resolve();
  }

  blockAppend(): void {
    this.appendGate = new Promise<void>((resolve) => { this.releaseAppend = resolve; });
  }

  blockCompact(): void {
    this.compactGate = new Promise<void>((resolve) => { this.releaseCompact = resolve; });
  }
}

function fixture(options: ConstructorParameters<typeof WorkspaceSaver>[2] = {}) {
  const core = Core.new({ installationId: crypto.randomUUID() });
  core.markPersistenceBaseline();
  const store = new FakeStore();
  const clock = new TestClock();
  const saver = new WorkspaceSaver(core, store as never, {
    idleDelayMs: 700,
    maxWaitMs: 5_000,
    retryDelayMs: 50,
    schedule: clock.schedule,
    cancel: (timer) => clock.clear(timer),
    now: clock.now,
    ...options,
  });
  return { core, store, clock, saver };
}

function mutate(core: Core, text: string): void {
  core.createNode(core.projection().todayId, null, text);
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('WorkspaceSaver', () => {
  test('schedules capture after the idle window without capturing synchronously', async () => {
    const { core, store, clock, saver } = fixture();
    mutate(core, 'first');
    saver.scheduleSave();

    expect(store.appends).toHaveLength(0);
    await clock.advance(699);
    expect(store.appends).toHaveLength(0);
    await clock.advance(1);

    expect(store.appends).toHaveLength(1);
    saver.dispose();
  });

  test('keeps the first-dirty max-wait checkpoint during sustained typing', async () => {
    const { core, store, clock, saver } = fixture();
    for (let index = 0; index < 20; index += 1) {
      mutate(core, `row-${index}`);
      saver.scheduleSave();
      await clock.advance(200);
    }

    expect(store.appends).toHaveLength(0);
    await clock.advance(1_000);
    expect(store.appends).toHaveLength(1);
    saver.dispose();
  });

  test('defers threshold compaction until typing reaches an idle window', async () => {
    const { core, store, clock, saver } = fixture({
      idleDelayMs: 700,
      maxWaitMs: 1_000,
      compactAfterUpdates: 1,
    });
    for (let index = 0; index < 5; index += 1) {
      mutate(core, `sustained-${index}`);
      saver.scheduleSave();
      await clock.advance(250);
    }

    expect(store.appends).toHaveLength(1);
    expect(store.compactions).toHaveLength(0);
    await clock.advance(449);
    expect(store.compactions).toHaveLength(0);
    await clock.advance(1);
    expect(store.compactions).toHaveLength(1);
    saver.dispose();
  });

  test('includes replayed update count when deciding the next compaction', async () => {
    const { core, store, clock, saver } = fixture({
      compactAfterUpdates: 3,
      initialUpdateCount: 2,
    });
    mutate(core, 'third update across launches');
    saver.scheduleSave();
    await clock.advance(700);

    expect(store.appends).toHaveLength(1);
    expect(store.compactions).toHaveLength(1);
    saver.dispose();
  });

  test('uses the durable JSONL size rather than raw update bytes for compaction', async () => {
    const { core, store, clock, saver } = fixture({
      compactAfterUpdates: 100,
      compactAfterBytes: 10_000,
    });
    store.reportedLogBytes = 10_001;
    mutate(core, 'metadata and base64 count toward the log size');
    saver.scheduleSave();
    await clock.advance(700);

    expect(store.appends).toHaveLength(1);
    expect(store.appends[0]!.update.byteLength).toBeLessThan(10_000);
    expect(store.compactions).toHaveLength(1);
    saver.dispose();
  });

  test('does not serialize a new mutation behind an in-flight append', async () => {
    const { core, store, clock, saver } = fixture();
    store.blockAppend();
    mutate(core, 'first');
    saver.scheduleSave();
    await clock.advance(700);
    expect(store.appends).toHaveLength(1);

    mutate(core, 'second');
    saver.scheduleSave();
    expect(core.projection().nodes.some((node) => node.content.text === 'second')).toBe(true);
    expect(saver.durableRevision()).toBe(1);

    store.releaseAppend!();
    await settle();
    await clock.advance(700);
    expect(store.appends).toHaveLength(2);
    expect(store.appends[1]!.persistenceRevision).toBeGreaterThan(store.appends[0]!.persistenceRevision);
    saver.dispose();
  });

  test('defers capture while a yielding transaction is still rollback-capable', async () => {
    const failures: unknown[] = [];
    const { core, store, clock, saver } = fixture({ onFailure: (error) => failures.push(error) });
    let releaseTransaction!: () => void;
    let signalYield!: () => void;
    const yielded = new Promise<void>((resolve) => { signalYield = resolve; });
    const transaction = core.transaction('user', async () => {
      mutate(core, 'yielding transaction');
      saver.scheduleSave();
      signalYield();
      await new Promise<void>((resolve) => { releaseTransaction = resolve; });
    });
    await yielded;

    await clock.advance(700);
    expect(store.appends).toHaveLength(0);
    expect(failures).toEqual([]);

    releaseTransaction();
    await transaction;
    saver.scheduleSave();
    await clock.advance(700);
    expect(store.appends).toHaveLength(1);
    expect(failures).toEqual([]);
    saver.dispose();
  });

  test('keeps an explicit durable waiter alive while capture is temporarily unavailable', async () => {
    const { core, store, clock, saver } = fixture();
    mutate(core, 'accepted before transaction');
    saver.scheduleSave();
    let releaseTransaction!: () => void;
    let signalYield!: () => void;
    const yielded = new Promise<void>((resolve) => { signalYield = resolve; });
    const transaction = core.transaction('user', async () => {
      signalYield();
      await new Promise<void>((resolve) => { releaseTransaction = resolve; });
    });
    await yielded;
    const accepted = saver.acceptedRevision();
    const durable = saver.waitForDurable(accepted);
    expect(saver.durableRevision()).toBeLessThan(accepted);

    await clock.advance(700);
    await settle();
    expect(store.appends).toHaveLength(0);
    releaseTransaction();
    await transaction;
    await settle();
    await clock.advance(700);
    await settle();
    await durable;
    expect(store.appends).toHaveLength(1);
    saver.dispose();
  });

  test('rejects an explicit waiter on append failure, then retries the dirty revision', async () => {
    const failures: number[] = [];
    const { core, store, clock, saver } = fixture({ onFailure: (_error, revision) => failures.push(revision) });
    mutate(core, 'retry me');
    saver.scheduleSave();
    store.failAppend = true;
    const failed = saver.waitForDurable();
    await expect(failed).rejects.toThrow('append failed');
    expect(saver.status().dirty).toBe(true);
    expect(failures).toHaveLength(1);

    store.failAppend = false;
    const recovered = saver.waitForDurable();
    await settle();
    await clock.advance(50);
    await recovered;
    expect(saver.durableRevision()).toBe(saver.acceptedRevision());
    saver.dispose();
  });

  test('backs off repeated automatic retries up to the configured cap', async () => {
    const failures: number[] = [];
    const { core, store, clock, saver } = fixture({
      retryDelayMs: 50,
      retryMaxDelayMs: 120,
      onFailure: () => failures.push(clock.nowValue),
    });
    mutate(core, 'back off retries');
    saver.scheduleSave();
    store.failAppend = true;
    await expect(saver.waitForDurable()).rejects.toThrow('append failed');
    expect(failures).toEqual([0]);

    await clock.advance(49);
    expect(failures).toEqual([0]);
    await clock.advance(1);
    expect(failures).toEqual([0, 50]);
    await clock.advance(99);
    expect(failures).toEqual([0, 50]);
    await clock.advance(1);
    expect(failures).toEqual([0, 50, 150]);
    await clock.advance(119);
    expect(failures).toEqual([0, 50, 150]);

    store.failAppend = false;
    await clock.advance(1);
    expect(saver.durableRevision()).toBe(saver.acceptedRevision());
    saver.dispose();
  });

  test('does not ack a mutation that arrives while compaction is running', async () => {
    const { core, store, clock, saver } = fixture({ compactAfterUpdates: 1 });
    store.blockCompact();
    mutate(core, 'first');
    saver.scheduleSave();
    await clock.advance(700);
    await settle();
    expect(store.appends).toHaveLength(1);
    expect(store.compactions).toHaveLength(1);
    const firstDurable = saver.durableRevision();

    mutate(core, 'second');
    saver.scheduleSave();
    expect(saver.durableRevision()).toBe(firstDurable);
    store.releaseCompact!();
    await settle();
    await clock.advance(700);
    expect(store.appends).toHaveLength(2);
    expect(saver.durableRevision()).toBe(saver.acceptedRevision());
    saver.dispose();
  });

  test('preserves metadata captured after append while compaction is running', async () => {
    const { core, store, clock, saver } = fixture({ compactAfterUpdates: 1 });
    store.blockCompact();
    mutate(core, 'first');
    saver.scheduleSave();
    await clock.advance(700);
    await settle();

    mutate(core, 'second');
    saver.scheduleSave();
    store.releaseCompact!();
    await settle();
    await clock.advance(700);

    expect(store.appends).toHaveLength(2);
    expect(store.appends[1]!.local.operationHistoryUpserts).toHaveLength(1);
    expect(store.appends[1]!.local.operationHistoryUpserts[0]?.summary).toContain('document');
    saver.dispose();
  });

  test('retries a failed compaction without appending the durable revision again', async () => {
    const { core, store, clock, saver } = fixture({ compactAfterUpdates: 1 });
    store.failCompact = true;
    mutate(core, 'already durable before compaction fails');
    saver.scheduleSave();
    await clock.advance(700);
    await settle();

    expect(store.appends).toHaveLength(1);
    expect(store.compactions).toHaveLength(1);
    expect(saver.durableRevision()).toBe(saver.acceptedRevision());

    store.failCompact = false;
    await clock.advance(50);
    await settle();

    expect(store.appends).toHaveLength(1);
    expect(store.compactions).toHaveLength(2);
    saver.dispose();
  });

  test('requires a fresh idle window before retrying compaction after new input', async () => {
    const { core, store, clock, saver } = fixture({ compactAfterUpdates: 1 });
    store.failCompact = true;
    mutate(core, 'durable before compaction failure');
    saver.scheduleSave();
    await clock.advance(700);
    await settle();
    expect(store.compactions).toHaveLength(1);

    store.failCompact = false;
    mutate(core, 'new input after failure');
    saver.scheduleSave();
    await clock.advance(50);
    await settle();
    expect(store.appends).toHaveLength(2);
    expect(store.compactions).toHaveLength(1);

    await clock.advance(699);
    expect(store.compactions).toHaveLength(1);
    await clock.advance(1);
    expect(store.compactions).toHaveLength(2);
    saver.dispose();
  });
});
