import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AutomationCreateInput, AutomationRun } from '../../src/core/agent/automation';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';
import { AutomationStore } from '../../src/main/agent/automations/AutomationStore';
import { AutomationScheduler } from '../../src/main/agent/automations/AutomationScheduler';
import { AutomationService } from '../../src/main/agent/automations/AutomationService';
import type { AutomationDispatcher } from '../../src/main/agent/automations/AutomationDispatcher';
import type { ThreadService } from '../../src/main/agent/ThreadService';
import { automationOccurrencesBetween } from '../../src/main/agent/automations/AutomationSchedule';
import { uuidV7 } from '../../src/main/agent/uuid';

const stores = new Set<AutomationStore>();
const roots: string[] = [];
afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const start = Date.parse('2026-09-11T08:00:00Z');
const due = Date.parse('2026-09-11T09:00:00Z');
function definition(repeating = false): AutomationCreateInput {
  return { name: 'Review materials', prompt: 'Review the current materials and report changes.',
    schedule: { rrule: `DTSTART:20260911T090000\nRRULE:FREQ=DAILY${repeating ? '' : ';COUNT=1'}`, timezone: 'UTC' },
    destination: { kind: 'standalone' } };
}
function open(file = ':memory:') {
  const store = new AutomationStore(file, new Database(file) as unknown as SqliteDatabase);
  stores.add(store);
  return store;
}
function host(store: AutomationStore, initialNow: number, validateConfiguration: () => Promise<void> = async () => undefined) {
  let now = initialNow;
  let monotonic = 0;
  let active = true;
  const dispatched: string[] = [];
  const dispatcher = {
    reconcile: async () => undefined,
    recoverPendingRuns: async () => undefined,
    dispatch: async (run: AutomationRun) => { dispatched.push(run.id); return store.markDispatched(run.id, uuidV7(), uuidV7(), now); },
    isRunActive: (run: AutomationRun) => run.state === 'pending' || (active && run.state === 'dispatched'),
    validateConfiguration,
    cleanupRetainedWorktrees: async () => undefined,
  } as unknown as AutomationDispatcher;
  const scheduler = new AutomationScheduler({ store, dispatcher, now: () => now, monotonicNow: () => monotonic,
    setTimer: () => 1, clearTimer: () => undefined });
  const service = new AutomationService({ store, scheduler, dispatcher, threads: {} as ThreadService, now: () => now });
  return { scheduler, service, dispatched, setTime: (wall: number, elapsed = wall - now) => { monotonic += elapsed; now = wall; },
    settle: () => { active = false; } };
}

describe('Scheduled work timing and operation boundaries', () => {
  test('startup after a missed one-off records a decision without fabricating an execution', async () => {
    const store = open();
    const task = store.create(definition(), start);
    const runtime = host(store, due + 60_000);
    await runtime.scheduler.start();
    await runtime.scheduler.stop();
    expect(runtime.dispatched).toEqual([]);
    expect(store.listRuns({ automationId: task.id })).toEqual([]);
    expect(store.missedOccurrences(task.id)).toEqual([{ contextHintId: 'default', scheduledFor: due }]);
  });

  test('healthy timer delay dispatches a one-off while a clock jump requires a decision', async () => {
    for (const jump of [false, true]) {
      const store = open();
      const task = store.create(definition(), start);
      const runtime = host(store, start);
      await runtime.scheduler.start();
      runtime.setTime(due + 100, jump ? 100 : due + 100 - start);
      await runtime.scheduler.wake();
      await runtime.scheduler.stop();
      expect(runtime.dispatched.length).toBe(jump ? 0 : 1);
      expect(store.missedOccurrences(task.id).length).toBe(jump ? 1 : 0);
    }
  });

  test('one-off deferred by active foreground work queues normally', async () => {
    const store = open();
    const task = store.create(definition(), start);
    const runtime = host(store, start);
    await runtime.service.request('startNow', { id: task.id, requestId: 'manual', expectedRevision: 1 });
    await runtime.scheduler.start();
    runtime.setTime(due + 100);
    await runtime.scheduler.wake();
    runtime.settle();
    runtime.setTime(due + 200);
    await runtime.scheduler.wake();
    await runtime.scheduler.stop();
    expect(store.missedOccurrences(task.id)).toEqual([]);
    expect(store.listRuns({ automationId: task.id }).map((run) => run.occurrenceKey).sort())
      .toEqual(['manual:manual', `scheduled:${due}`].sort());
  });

  test('resume ignores the intentionally paused interval and manual execution leaves timing alone', async () => {
    const store = open();
    const task = store.create({ ...definition(true), status: 'paused' }, start);
    const runtime = host(store, due + 3 * 86_400_000);
    const manual = await runtime.service.request('startNow', { id: task.id, requestId: 'paused-manual', expectedRevision: 1 });
    expect(manual.runs).toHaveLength(1);
    expect(store.read(task.id)?.status).toBe('paused');
    await runtime.service.request('resume', { id: task.id, expectedRevision: 1 });
    runtime.settle();
    await runtime.scheduler.start();
    await runtime.scheduler.stop();
    expect(store.listRuns({ automationId: task.id })).toHaveLength(1);
    expect(store.missedOccurrences(task.id)).toEqual([]);
  });

  test('a new manual request during a run remains associated with that run after settlement and restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scheduled-receipt-'));
    roots.push(root);
    const file = join(root, 'store.sqlite');
    const store = open(file);
    const task = store.create(definition(), start);
    const runtime = host(store, start);
    const first = await runtime.service.request('startNow', { id: task.id, requestId: 'first', expectedRevision: 1 });
    const duplicate = await runtime.service.request('startNow', { id: task.id, requestId: 'duplicate', expectedRevision: 1 });
    expect(duplicate.runs[0]?.id).toBe(first.runs[0]?.id);
    store.update({ id: task.id, expectedRevision: 1, prompt: 'A revised brief' }, start + 1);
    store.close(); stores.delete(store);
    const reopened = open(file);
    const resumed = host(reopened, due);
    resumed.settle();
    const replay = await resumed.service.request('startNow', { id: task.id, requestId: 'duplicate', expectedRevision: 1 });
    expect(replay.runs[0]?.id).toBe(first.runs[0]?.id);
    expect(resumed.dispatched).toEqual([]);
    await expect(resumed.service.request('startNow', { id: task.id, requestId: 'duplicate', expectedRevision: 2 }))
      .rejects.toThrow('different input');
    await expect(resumed.service.request('startNow', { id: task.id, requestId: 'new', expectedRevision: 1 }))
      .rejects.toThrow('current revision is 2');
  });

  test('skip resolves exactly one missed occurrence and its receipt survives repeat invocation', async () => {
    const store = open();
    const task = store.create(definition(), start);
    const runtime = host(store, due + 1);
    await runtime.scheduler.start();
    const current = store.read(task.id)!;
    const input = { id: task.id, expectedRevision: current.revision, contextHintId: 'default', scheduledFor: due,
      resolution: 'skipped' as const, requestId: 'skip' };
    expect(await runtime.service.request('resolveMissed', input)).toEqual({ run: null });
    expect(await runtime.service.request('resolveMissed', input)).toEqual({ run: null });
    expect(store.missedOccurrences(task.id)).toEqual([]);
    await expect(runtime.service.request('resolveMissed', { ...input, requestId: 'new-skip' })).rejects.toThrow('resolved');
    await runtime.scheduler.wake();
    await runtime.scheduler.stop();
    expect(runtime.dispatched).toEqual([]);
  });

  test('delete replays its committed receipt after a lost reply and restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scheduled-delete-receipt-'));
    roots.push(root);
    const file = join(root, 'store.sqlite');
    const store = open(file);
    const task = store.create(definition(), start);
    const pending = store.claimNow(task, null, start, 'queued');
    const input = { id: task.id, expectedRevision: task.revision, requestId: 'delete-task' };
    // Discard the reply as a disconnected caller would.
    await host(store, start).service.request('delete', input);
    const deleted = store.read(task.id, start, true);
    const omitted = store.readRun(pending.id);
    expect(omitted?.omission?.reason).toBe('deleted');
    store.close(); stores.delete(store);

    const reopened = open(file);
    const runtime = host(reopened, due);
    expect(await runtime.service.request('delete', input)).toEqual({ deleted: true, id: task.id });
    expect(reopened.read(task.id, due, true)).toEqual(deleted);
    expect(reopened.readRun(pending.id)).toEqual(omitted);
    await expect(runtime.service.request('delete', { ...input, expectedRevision: 2 })).rejects.toThrow('different input');
    await expect(runtime.service.request('delete', input, async () => { throw new Error('Caller revoked'); }))
      .rejects.toThrow('Caller revoked');
  });

  test('delete rolls back the tombstone and pending omissions when receipt persistence fails', async () => {
    const database = new Database(':memory:');
    const store = new AutomationStore(':memory:', database as unknown as SqliteDatabase);
    stores.add(store);
    const task = store.create(definition(), start);
    const pending = store.claimNow(task, null, start, 'queued');
    database.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON automation_operation_receipts
      BEGIN SELECT RAISE(ABORT, 'Receipt unavailable'); END`);
    const runtime = host(store, start);
    const input = { id: task.id, expectedRevision: task.revision, requestId: 'delete-task' };
    await expect(runtime.service.request('delete', input)).rejects.toThrow('Receipt unavailable');
    expect(store.read(task.id, start)).toEqual(task);
    expect(store.readRun(pending.id)).toEqual(pending);
    database.exec('DROP TRIGGER reject_receipt');
    expect(await runtime.service.request('delete', input)).toEqual({ deleted: true, id: task.id });
  });

  test('receipt failure rolls back both the domain mutation and its nested transaction', () => {
    const store = open();
    expect(() => store.withOperationReceipt('request', { action: 'create' }, () => {
      store.create(definition(), start);
      throw new Error('Simulated receipt failure');
    })).toThrow('Simulated');
    expect(store.list()).toEqual([]);
    expect(store.operationReceipt('request', { action: 'create' })).toBeNull();
    const saved = store.withOperationReceipt('request', { action: 'create' }, () => store.create(definition(), start));
    expect(store.withOperationReceipt('request', { action: 'create' }, () => { throw new Error('Must not execute twice'); })).toEqual(saved);
  });

  test('fulfilling a missed time consumes it only at canonical Turn acceptance', () => {
    const store = open();
    const task = store.create(definition(), start);
    store.recordMissedOccurrence(task, null, due, start - 1);
    const prepared = store.resolveMissedOccurrence(task, 'default', due, 'fulfilled', due + 1)!;
    expect(store.missedOccurrences(task.id)).toHaveLength(1);
    store.markDispatched(prepared.id, uuidV7(), uuidV7(), due + 2);
    expect(store.missedOccurrences(task.id)).toEqual([]);
    expect(() => store.resolveMissedOccurrence(task, 'default', due, 'fulfilled', due + 3)).toThrow('resolved');
  });

  test('content and location changes refresh unaccepted inputs without losing the occurrence identity', () => {
    const store = open();
    const task = store.create(definition(), start);
    const prepared = store.claimNow(task, null, start + 1, 'manual-brief');
    const edited = store.update({ id: task.id, expectedRevision: 1, prompt: 'Revised instructions',
      materials: [{ kind: 'url', reference: 'https://example.com/new', required: true }],
      contextHints: [{ source: { kind: 'directory', rootHint: '/tmp/new-location' }, executionMode: 'local' }],
    }, start + 2);
    expect(store.readRun(prepared.id)?.state).toBe('pending');
    const refreshed = store.refreshPendingBrief(prepared.id, start + 3);
    expect(refreshed.id).toBe(prepared.id);
    expect(refreshed.occurrenceKey).toBe(prepared.occurrenceKey);
    expect(refreshed.snapshot).toMatchObject({ prompt: 'Revised instructions', materials: edited.materials, contextHint: edited.contextHints[0] });
    store.markDispatched(refreshed.id, uuidV7(), uuidV7(), start + 4);
    store.update({ id: task.id, expectedRevision: 2, prompt: 'Future brief only' }, start + 5);
    expect(store.refreshPendingBrief(prepared.id).snapshot.prompt).toBe('Revised instructions');
  });

  test('CLI authority revoked during validation cannot commit a queued mutation', async () => {
    const store = open();
    let allowed = true;
    const runtime = host(store, start, async () => { allowed = false; });
    const authorize = async () => { if (!allowed) throw new Error('Caller revoked'); };
    await expect(runtime.service.request('create', { ...definition(), requestId: 'revoked-create' }, authorize)).rejects.toThrow('Caller revoked');
    expect(store.list()).toEqual([]);
  });

  test('a late continuation waits for a newer foreground run and keeps the original occurrence', async () => {
    const store = open();
    const task = store.create(definition(true), start);
    const first = store.claimNow(task, null, start + 1, 'first');
    const second = store.claimNow(task, null, start + 2, 'second');
    store.markDispatched(first.id, uuidV7(), uuidV7(), start + 3);
    store.markDispatched(second.id, uuidV7(), uuidV7(), start + 4);
    let active = true;
    const scheduler = new AutomationScheduler({ store, dispatcher: { isRunActive: (run: AutomationRun) => run.id === second.id && active } as AutomationDispatcher });
    let continuations = 0;
    const execute = async () => { continuations++; return true; };
    expect(await scheduler.admitContinuation(first.id, execute)).toBe(false);
    expect(continuations).toBe(0);
    active = false;
    expect(await scheduler.admitContinuation(first.id, execute)).toBe(true);
    expect(store.allRunsForAutomation(task.id)).toHaveLength(2);
    expect(store.readRun(first.id)?.occurrenceKey).toBe('manual:first');
    expect(store.readRun(second.id)?.occurrenceKey).toBe('manual:second');
  });

  test('history pagination follows durable admission order after the wall clock moves backward', () => {
    const store = open();
    const task = store.create(definition(true), start);
    const first = store.claimNow(task, null, due, 'first-clock');
    const second = store.claimNow(task, null, start, 'second-clock');
    expect(store.listRuns({ automationId: task.id, limit: 1 }).map((run) => run.id)).toEqual([second.id]);
    store.markRunRead(first.id, due + 10);
    expect(store.listRuns({ automationId: task.id, before: second.id }).map((run) => run.id)).toEqual([first.id]);
  });

  test('a corrupt operation association blocks replay instead of repeating its domain write', () => {
    const database = new Database(':memory:');
    const store = new AutomationStore(':memory:', database as unknown as SqliteDatabase);
    stores.add(store);
    store.withOperationReceipt('damaged', { action: 'create' }, () => store.create(definition(), start));
    database.exec("UPDATE automation_operation_receipts SET receipt_json = 'null' WHERE request_id = 'damaged'");
    expect(() => store.withOperationReceipt('damaged', { action: 'create' }, () => store.create(definition(), start)))
      .toThrow('association is unreadable');
    expect(store.list()).toHaveLength(1);
  });

  test('backward clock movement leaves the durable cursor monotonic', () => {
    expect(automationOccurrencesBetween(definition(true).schedule, due, start))
      .toEqual({ occurrences: [], truncated: false, evaluatedThrough: due });
  });
});
