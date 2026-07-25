import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import {
  decodeAutomationNotification,
  decodeAutomationRequest,
  decodeAutomationResponse,
  EMPTY_AUTOMATION_CONFIGURATION,
  type Automation,
  type AutomationCreateInput,
  type AutomationRun,
} from '../../src/core/agent/automation';
import { defaultEffectiveThreadConfiguration } from '../../src/main/agent/AgentConfigurationLoader';
import { closeAgentServices } from '../../src/main/agent/closeAgentServices';
import { threadFeatureSource, type Thread, type Turn } from '../../src/core/agent/protocol';
import { AutomationDispatcher } from '../../src/main/agent/automations/AutomationDispatcher';
import { validateAutomationDependencies } from '../../src/main/agent/automations/AutomationDependencies';
import {
  automationOccurrencesBetween,
  nextAutomationOccurrence,
  normalizeAutomationSchedule,
} from '../../src/main/agent/automations/AutomationSchedule';
import { AutomationScheduler } from '../../src/main/agent/automations/AutomationScheduler';
import { AutomationService } from '../../src/main/agent/automations/AutomationService';
import { AutomationStore } from '../../src/main/agent/automations/AutomationStore';
import { AutomationWorktree } from '../../src/main/agent/automations/AutomationWorktree';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';
import type { ThreadService } from '../../src/main/agent/ThreadService';
import { uuidV7 } from '../../src/main/agent/uuid';

const execFileAsync = promisify(execFile);
const stores: AutomationStore[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Automation protocol and schedule', () => {
  test('strictly decodes requests, responses, and notifications', () => {
    const input = definition('20260724T090000');
    expect(decodeAutomationRequest('create', input)).toMatchObject({
      name: 'Daily review',
      destination: { kind: 'standalone' },
    });
    expect(() => decodeAutomationRequest('create', { ...input, permissionProfile: 'full' })).toThrow('unknown fields');
    expect(() => decodeAutomationRequest('create', { ...input, name: 'x'.repeat(201) })).toThrow('at most 200');
    expect(() => decodeAutomationRequest('create', {
      ...input,
      projectBindings: [{ id: 'repo', cwd: 'relative/project', executionMode: 'local' }],
    })).toThrow('absolute path');
    expect(() => decodeAutomationRequest('create', {
      ...input,
      projectBindings: [{ id: 'no-project', cwd: '/tmp/project', executionMode: 'local' }],
    })).toThrow('reserved binding ID');
    expect(() => decodeAutomationRequest('create', {
      ...input,
      destination: { kind: 'existingThread', threadId: uuidV7() },
      projectBindings: [{ id: 'repo', cwd: '/tmp/project', executionMode: 'worktree' }],
    })).toThrow('only a local project binding');
    expect(() => decodeAutomationRequest('update', { id: uuidV7(), expectedRevision: 1 })).toThrow('change');
    expect(decodeAutomationRequest('update', {
      id: uuidV7(),
      expectedRevision: 1,
      status: 'paused',
    })).toMatchObject({ status: 'paused' });
    expect(() => decodeAutomationRequest('startNow', { id: 'not-an-id' })).toThrow('UUIDv7');

    const store = automationStore();
    const automation = store.create(input, Date.parse('2026-07-24T08:00:00Z'));
    expect(decodeAutomationResponse('read', { automation }).automation).toEqual(automation);
    expect(decodeAutomationNotification({
      type: 'automation/changed',
      automationId: automation.id,
      automation,
    })).toMatchObject({ automationId: automation.id });
    expect(() => decodeAutomationNotification({
      type: 'automation/changed',
      automationId: uuidV7(),
      automation,
    })).toThrow('identity mismatch');

    const run = store.claimNow(automation, null, Date.parse('2026-07-24T08:30:00Z'));
    expect(decodeAutomationResponse('runs', { data: [run] }).data[0]).toEqual(run);
    expect(() => decodeAutomationResponse('runs', {
      data: [{ ...run, state: 'dispatched', turnId: null }],
    })).toThrow('inconsistent');
    expect(() => decodeAutomationResponse('runs', {
      data: [{ ...run, projectBindingKey: 'other-project' }],
    })).toThrow('does not match its snapshot');
    expect(() => decodeAutomationResponse('runs', {
      data: [{ ...run, threadId: null }],
    })).toThrow('pending state is inconsistent');
    expect(() => decodeAutomationResponse('runs', {
      data: [{ ...run, pinned: true }],
    })).toThrow('retained worktree');
  });

  test('keeps local wall time across DST and skips nonexistent wall times', () => {
    const fall = normalizeAutomationSchedule({
      timezone: 'America/New_York',
      rrule: 'DTSTART:20261031T090000\nRRULE:FREQ=DAILY;COUNT=3',
    });
    expect(automationOccurrencesBetween(
      fall,
      Date.parse('2026-10-30T00:00:00Z'),
      Date.parse('2026-11-03T00:00:00Z'),
    ).occurrences.map((value) => new Date(value).toISOString())).toEqual([
      '2026-10-31T13:00:00.000Z',
      '2026-11-01T14:00:00.000Z',
      '2026-11-02T14:00:00.000Z',
    ]);

    const spring = normalizeAutomationSchedule({
      timezone: 'America/New_York',
      rrule: 'DTSTART:20260307T023000\nRRULE:FREQ=DAILY;COUNT=3',
    });
    expect(automationOccurrencesBetween(
      spring,
      Date.parse('2026-03-06T00:00:00Z'),
      Date.parse('2026-03-11T00:00:00Z'),
    ).occurrences.map((value) => new Date(value).toISOString())).toEqual([
      '2026-03-07T07:30:00.000Z',
      '2026-03-09T06:30:00.000Z',
    ]);
  });

  test('accepts one canonical RRULE form and exhausts finite occurrence math', () => {
    expect(() => normalizeAutomationSchedule({
      timezone: 'UTC',
      rrule: 'DTSTART:20260724T090000Z\nRRULE:FREQ=DAILY',
    })).toThrow('local');
    expect(() => normalizeAutomationSchedule({
      timezone: 'UTC',
      rrule: 'DTSTART:20260724T090000\nRRULE:FREQ=MINUTELY',
    })).toThrow('frequency');
    expect(() => normalizeAutomationSchedule({
      timezone: 'UTC',
      rrule: 'DTSTART:20260724T090000\nRRULE:FREQ=DAILY\nEXDATE:20260725T090000',
    })).toThrow('one DTSTART and one RRULE');

    const once = normalizeAutomationSchedule({
      timezone: 'UTC',
      rrule: 'DTSTART:20260724T090000\nRRULE:FREQ=DAILY;COUNT=1',
    });
    expect(nextAutomationOccurrence(once, Date.parse('2026-07-24T08:59:59Z')))
      .toBe(Date.parse('2026-07-24T09:00:00Z'));
    expect(nextAutomationOccurrence(once, Date.parse('2026-07-24T09:00:00Z'))).toBeNull();
  });

  test('fails closed when any saved capability dependency is unavailable', () => {
    expect(() => validateAutomationDependencies({
      ...defaultEffectiveThreadConfiguration(),
      tools: ['node_read', 'missing_tool'],
      skills: ['review'],
      plugins: ['memory'],
      mcpServers: ['project-mcp'],
    }, {
      tools: new Set(['node_read']),
      skills: new Set(),
      plugins: new Set(['memory']),
      mcpServers: new Set(),
    })).toThrow('Tools: missing_tool; Skills: review; MCP servers: project-mcp');
  });
});

describe('Automation durable scheduling', () => {
  test('persists one durable claim and reconciles pending work after reopen', async () => {
    const root = await tempRoot('automation-store-');
    const path = join(root, 'automations.sqlite');
    const first = automationStore(path);
    const createdAt = Date.parse('2026-07-24T08:00:00Z');
    const automation = first.create(definition('20260724T090000'), createdAt);
    const cursor = first.bindingCursors(automation)[0]!;
    const occurrence = Date.parse('2026-07-24T09:00:00Z');
    const claimed = first.claimDueBatch({
      automation,
      binding: null,
      expectedEvaluatedThrough: cursor.evaluatedThrough,
      evaluatedThrough: occurrence,
      occurrences: [occurrence],
      truncated: false,
      now: occurrence,
    }).claimed!;
    expect(claimed.state).toBe('pending');
    expect(first.claimDueBatch({
      automation,
      binding: null,
      expectedEvaluatedThrough: cursor.evaluatedThrough,
      evaluatedThrough: occurrence,
      occurrences: [occurrence],
      truncated: false,
      now: occurrence,
    })).toMatchObject({ claimed: null, cursorAdvanced: false });
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = automationStore(path);
    expect(reopened.pendingRuns()).toHaveLength(1);
    expect(reopened.pendingRuns()[0]).toEqual(claimed);

    const dispatched: string[] = [];
    const scheduler = schedulerFor(reopened, occurrence + 1, {
      dispatch: (run) => {
        dispatched.push(run.id);
        return reopened.markDispatched(run.id, uuidV7(), uuidV7(), occurrence + 1);
      },
    });
    await scheduler.start();
    await scheduler.stop();
    expect(dispatched).toEqual([claimed.id]);
    expect(reopened.readRun(claimed.id)?.state).toBe('dispatched');
  });

  test('coalesces offline occurrences to the latest claim and one omission range', async () => {
    const store = automationStore();
    const createdAt = Date.parse('2026-07-20T08:00:00Z');
    const now = Date.parse('2026-07-24T09:30:00Z');
    const automation = store.create(definition('20260720T090000'), createdAt);
    const dispatched: AutomationRun[] = [];
    const scheduler = schedulerFor(store, now, {
      dispatch: (run) => {
        const value = store.markDispatched(run.id, uuidV7(), uuidV7(), now);
        dispatched.push(value);
        return value;
      },
    });
    await scheduler.start();
    await scheduler.stop();

    expect(dispatched.map((run) => run.scheduledFor)).toEqual([Date.parse('2026-07-24T09:00:00Z')]);
    const omission = store.listRuns({ automationId: automation.id }).find((run) => run.state === 'omitted');
    expect(omission?.omission).toEqual({
      from: Date.parse('2026-07-20T09:00:00Z'),
      through: Date.parse('2026-07-23T09:00:00Z'),
      count: 4,
      reason: 'catchUp',
    });
  });

  test('does not merge omission audit ranges across definition revisions', () => {
    const store = automationStore();
    const now = Date.parse('2026-07-20T08:00:00Z');
    const automation = store.create(definition('20260720T090000'), now);
    const firstCursor = store.bindingCursors(automation)[0]!;
    store.claimDueBatch({
      automation,
      binding: null,
      expectedEvaluatedThrough: firstCursor.evaluatedThrough,
      evaluatedThrough: Date.parse('2026-07-22T09:00:00Z'),
      occurrences: [
        Date.parse('2026-07-20T09:00:00Z'),
        Date.parse('2026-07-21T09:00:00Z'),
        Date.parse('2026-07-22T09:00:00Z'),
      ],
      truncated: false,
      now: Date.parse('2026-07-22T09:00:00Z'),
    });
    const updated = store.update({
      id: automation.id,
      expectedRevision: automation.revision,
      prompt: 'Use the revised prompt.',
    }, Date.parse('2026-07-22T10:00:00Z'));
    const secondCursor = store.bindingCursors(updated)[0]!;
    store.claimDueBatch({
      automation: updated,
      binding: null,
      expectedEvaluatedThrough: secondCursor.evaluatedThrough,
      evaluatedThrough: Date.parse('2026-07-24T09:00:00Z'),
      occurrences: [
        Date.parse('2026-07-23T09:00:00Z'),
        Date.parse('2026-07-24T09:00:00Z'),
      ],
      truncated: false,
      now: Date.parse('2026-07-24T09:00:00Z'),
    });

    const omissions = store.listRuns({ automationId: automation.id })
      .filter((run) => run.state === 'omitted');
    expect(omissions).toHaveLength(2);
    expect(new Set(omissions.map((run) => run.automationRevision))).toEqual(new Set([1, 2]));
  });

  test('classifies delayed due work as overlap and keeps successful runs out of omission ranges', async () => {
    const store = automationStore();
    const createdAt = Date.parse('2026-07-20T08:00:00Z');
    const firstDue = Date.parse('2026-07-20T09:00:00Z');
    const through = Date.parse('2026-07-24T09:30:00Z');
    const automation = store.create(definition('20260720T090000'), createdAt);
    const cursor = store.bindingCursors(automation)[0]!;
    const first = store.claimDueBatch({
      automation,
      binding: null,
      expectedEvaluatedThrough: cursor.evaluatedThrough,
      evaluatedThrough: firstDue,
      occurrences: [firstDue],
      truncated: false,
      now: firstDue,
    }).claimed!;
    store.markDispatched(first.id, uuidV7(), uuidV7(), firstDue);

    const whileActive = schedulerFor(store, through, {
      dispatch: async (run) => run,
      isRunActive: (run) => run.id === first.id,
    });
    await whileActive.start();
    await whileActive.stop();
    expect(store.bindingCursors(automation)[0]?.overlapDeferred).toBe(true);

    const afterTerminal = schedulerFor(store, through, {
      dispatch: (run) => store.markDispatched(run.id, uuidV7(), uuidV7(), through),
      isRunActive: () => false,
    });
    await afterTerminal.start();
    await afterTerminal.stop();

    const runs = store.listRuns({ automationId: automation.id });
    const omission = runs.find((run) => run.state === 'omitted');
    expect(omission?.omission).toEqual({
      from: Date.parse('2026-07-21T09:00:00Z'),
      through: Date.parse('2026-07-23T09:00:00Z'),
      count: 3,
      reason: 'overlap',
    });
    expect(runs.filter((run) => run.state === 'dispatched').map((run) => run.scheduledFor).sort())
      .toEqual([firstDue, Date.parse('2026-07-24T09:00:00Z')]);
  });

  test('omits undispatched work on pause and delete and rejects stale revisions', () => {
    const store = automationStore();
    const now = Date.parse('2026-07-24T08:00:00Z');
    const automation = store.create(definition('20260724T090000'), now);
    const pending = store.claimNow(automation, null, now + 1);
    const paused = store.setStatus(automation.id, 'paused', automation.revision, now + 2);
    expect(paused.status).toBe('paused');
    expect(store.readRun(pending.id)).toMatchObject({
      state: 'omitted',
      omission: { reason: 'paused' },
    });
    expect(() => store.update({
      id: automation.id,
      expectedRevision: automation.revision,
      prompt: 'stale',
    }, now + 3)).toThrow('revision conflict');

    const resumed = store.setStatus(automation.id, 'active', paused.revision, now + 4);
    const pendingDelete = store.claimNow(resumed, null, now + 5);
    store.delete(automation.id, resumed.revision, now + 6);
    expect(store.read(automation.id)).toBeNull();
    expect(store.read(automation.id, now + 6, true)).not.toBeNull();
    expect(store.readRun(pendingDelete.id)).toMatchObject({
      state: 'omitted',
      omission: { reason: 'deleted' },
    });
  });

  test('completes a multi-binding one-shot after every durable claim', async () => {
    const store = automationStore();
    const due = Date.parse('2026-07-24T09:00:00Z');
    const automation = store.create({
      ...definition('20260724T090000', 'FREQ=DAILY;COUNT=1'),
      projectBindings: [
        { id: 'project-a', cwd: '/tmp/a', executionMode: 'local' },
        { id: 'project-b', cwd: '/tmp/b', executionMode: 'local' },
      ],
    }, due - 1);
    const scheduler = schedulerFor(store, due, {
      dispatch: (run) => store.markDispatched(run.id, uuidV7(), uuidV7(), due),
    });
    await scheduler.start();
    await scheduler.stop();

    expect(store.listRuns({ automationId: automation.id }).filter((run) => run.state === 'dispatched'))
      .toHaveLength(2);
    expect(store.read(automation.id, due)?.status).toBe('completed');
  });

  test('completes any finite RRULE after its final durable claim', async () => {
    const store = automationStore();
    const finalDue = Date.parse('2026-07-26T09:00:00Z');
    const automation = store.create({
      ...definition('20260724T090000', 'FREQ=DAILY;COUNT=3'),
    }, Date.parse('2026-07-24T08:00:00Z'));
    const scheduler = schedulerFor(store, finalDue, {
      dispatch: (run) => store.markDispatched(run.id, uuidV7(), uuidV7(), finalDue),
    });
    await scheduler.start();
    await scheduler.stop();

    expect(store.listRuns({ automationId: automation.id })).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'omitted', omission: expect.objectContaining({ count: 2 }) }),
      expect.objectContaining({ state: 'dispatched', scheduledFor: finalDue }),
    ]));
    expect(store.read(automation.id, finalDue)?.status).toBe('completed');
  });

  test('reactivates a completed Automation only when its schedule changes', () => {
    const store = automationStore();
    const now = Date.parse('2026-07-24T08:00:00Z');
    const created = store.create(definition('20260724T090000', 'FREQ=DAILY;COUNT=1'), now);
    const cursor = store.bindingCursors(created)[0]!;
    const due = Date.parse('2026-07-24T09:00:00Z');
    store.claimDueBatch({
      automation: created,
      binding: null,
      expectedEvaluatedThrough: cursor.evaluatedThrough,
      evaluatedThrough: due,
      occurrences: [due],
      truncated: false,
      now: due,
    });
    const completed = store.completeIfExhausted(created.id, created.revision, due)!;

    const renamed = store.update({
      id: completed.id,
      expectedRevision: completed.revision,
      name: 'Renamed',
    }, due + 1);
    expect(renamed.status).toBe('completed');
    expect(() => store.setStatus(renamed.id, 'active', renamed.revision, due + 2)).toThrow('changing its schedule');

    const rescheduled = store.update({
      id: renamed.id,
      expectedRevision: renamed.revision,
      schedule: {
        rrule: 'DTSTART:20260725T090000\nRRULE:FREQ=DAILY;COUNT=1',
        timezone: 'UTC',
      },
    }, due + 3);
    expect(rescheduled.status).toBe('active');
    expect(rescheduled.nextOccurrenceAt).toBe(Date.parse('2026-07-25T09:00:00Z'));
  });

  test('does not apply renderer pagination limits to maintenance queries', () => {
    const store = automationStore();
    const now = Date.parse('2026-07-24T08:00:00Z');
    const automation = store.create({
      ...definition('20260724T090000'),
      projectBindings: [{ id: 'repo', cwd: '/tmp/source', executionMode: 'worktree' }],
    }, now);
    let oldestRunId = '';
    for (let index = 0; index < 501; index += 1) {
      const run = store.claimNow(automation, automation.projectBindings[0]!, now + index + 1);
      if (index === 0) {
        oldestRunId = run.id;
        store.setWorktree(run.id, {
          sourceCwd: '/tmp/source',
          path: '/tmp/worktree',
          baseCommit: '0123456789abcdef0123456789abcdef01234567',
          snapshotPath: null,
          removedAt: null,
          managed: true,
        }, now + index + 1);
      }
      store.markDispatched(run.id, run.threadId!, uuidV7(now + index + 1), now + index + 1);
    }

    expect(store.listRuns({ limit: 500 })).toHaveLength(500);
    expect(store.dispatchedRunsForReconciliation()).toHaveLength(501);
    expect(store.retainedWorktreeRunsForCleanup().map((run) => run.id)).toEqual([oldestRunId]);
  });
});

describe('Automation service serialization', () => {
  test('serializes pause and delete after in-flight Start now admission', async () => {
    for (const action of ['pause', 'delete'] as const) {
      const store = automationStore();
      const now = Date.parse('2026-07-24T09:00:00Z');
      const automation = store.create(definition('20260724T100000'), now);
      let enterDispatch!: () => void;
      let releaseDispatch!: () => void;
      const entered = new Promise<void>((resolve) => { enterDispatch = resolve; });
      const blocked = new Promise<void>((resolve) => { releaseDispatch = resolve; });
      const service = automationServiceFor(store, now + 1, {
        async dispatch(run) {
          enterDispatch();
          await blocked;
          return store.markDispatched(run.id, uuidV7(), uuidV7(), now + 1);
        },
      });

      const start = service.request('startNow', { id: automation.id });
      await entered;
      let controlSettled = false;
      const control = action === 'pause'
        ? service.request('pause', { id: automation.id, expectedRevision: automation.revision })
        : service.request('delete', { id: automation.id, expectedRevision: automation.revision });
      void control.finally(() => { controlSettled = true; });
      await Promise.resolve();
      expect(controlSettled).toBe(false);

      releaseDispatch();
      const started = await start;
      await control;
      expect(started.runs[0]?.state).toBe('dispatched');
      expect(store.readRun(started.runs[0]!.id)?.state).toBe('dispatched');
      expect(store.read(automation.id)?.status ?? null).toBe(action === 'pause' ? 'paused' : null);
    }
  });

  test('publishes pending omissions and prevents overlapping Start now runs', async () => {
    const store = automationStore();
    const now = Date.parse('2026-07-24T09:00:00Z');
    const automation = store.create(definition('20260724T100000'), now);
    const service = automationServiceFor(store, now + 1);
    const states: string[] = [];
    service.subscribe((notification) => {
      if (notification.type === 'automationRun/changed') states.push(notification.run.state);
    });

    const first = await service.request('startNow', { id: automation.id });
    expect(first.runs[0]?.state).toBe('pending');
    await expect(service.request('startNow', { id: automation.id })).rejects.toThrow('active occurrence');

    await service.request('pause', { id: automation.id, expectedRevision: automation.revision });
    expect(states).toEqual(['pending', 'omitted']);
    expect(store.readRun(first.runs[0]!.id)).toMatchObject({
      state: 'omitted',
      omission: { reason: 'paused' },
    });
  });

  test('serializes worktree pin changes with scheduler cleanup', async () => {
    const store = automationStore();
    const now = Date.parse('2026-07-24T09:00:00Z');
    const automation = store.create(definition('20260724T100000'), now);
    const claimed = store.claimNow(automation, null, now + 1);
    store.setWorktree(claimed.id, {
      sourceCwd: '/tmp/source',
      path: '/tmp/worktree',
      baseCommit: '0123456789abcdef0123456789abcdef01234567',
      snapshotPath: null,
      removedAt: null,
      managed: true,
    }, now + 2);
    const dispatcher = {
      reconcile: async () => undefined,
      dispatch: async (run: AutomationRun) => run,
      isRunActive: () => false,
      cleanupRetainedWorktrees: async () => undefined,
      validateConfiguration: async () => undefined,
    } as unknown as AutomationDispatcher;
    const scheduler = new AutomationScheduler({
      store,
      dispatcher,
      now: () => now + 3,
      setTimer: () => 1,
      clearTimer: () => undefined,
    });
    const service = new AutomationService({
      store,
      scheduler,
      dispatcher,
      threads: {} as ThreadService,
      now: () => now + 3,
    });
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const cleanup = scheduler.runExclusive(async () => {
      enter();
      await blocked;
    });
    await entered;

    let settled = false;
    const pin = service.request('runPin', { id: claimed.id, pinned: true });
    void pin.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await cleanup;
    expect((await pin).run.pinned).toBe(true);

    store.setWorktree(claimed.id, {
      ...store.readRun(claimed.id)!.worktree!,
      removedAt: now + 4,
    }, now + 4);
    await expect(service.request('runPin', { id: claimed.id, pinned: false }))
      .rejects.toThrow('no retained worktree');
  });

  test('rejects Start now while paused and validates dependencies before persistence', async () => {
    const store = automationStore();
    const now = Date.parse('2026-07-24T09:00:00Z');
    const automation = store.create({ ...definition('20260724T100000'), status: 'paused' }, now);
    const service = automationServiceFor(store, now + 1, {
      validateConfiguration: async () => {
        throw new Error('Automation dependencies are unavailable: Skills: missing-skill');
      },
    });

    await expect(service.request('startNow', { id: automation.id })).rejects.toThrow('Only an active Automation');
    await expect(service.create(definition('20260724T110000'))).rejects.toThrow('Skills: missing-skill');
    expect(store.list()).toHaveLength(1);
  });

  test('accepts only a Git repository root for worktree execution', async () => {
    const root = await tempRoot('automation-project-validation-');
    const source = join(root, 'source');
    const nested = join(source, 'nested');
    await initializeGitRepository(source);
    await mkdir(nested);
    const store = automationStore();
    const service = automationServiceFor(store, Date.parse('2026-07-24T09:00:00Z'));

    await expect(service.create({
      ...definition('20260724T100000'),
      projectBindings: [{ id: 'repo', cwd: nested, executionMode: 'worktree' }],
    })).rejects.toThrow('Git repository root');
    expect(store.list()).toHaveLength(0);

    const automation = await service.create({
      ...definition('20260724T100000'),
      projectBindings: [{ id: 'repo', cwd: source, executionMode: 'worktree' }],
    });
    expect(automation.projectBindings[0]?.cwd).toBe(await realpath(source));
  });

  test('persists the canonical real path for a project binding', async () => {
    const root = await tempRoot('automation-project-realpath-');
    const source = join(root, 'source');
    const alias = join(root, 'source-alias');
    await mkdir(source);
    await symlink(source, alias);
    const store = automationStore();
    const service = automationServiceFor(store, Date.parse('2026-07-24T09:00:00Z'));

    const automation = await service.create({
      ...definition('20260724T100000'),
      projectBindings: [{ id: 'repo', cwd: alias, executionMode: 'local' }],
    });
    expect(automation.projectBindings[0]?.cwd).toBe(await realpath(source));
  });

  test('rejects worktree execution for an existing Thread destination', async () => {
    const root = await tempRoot('automation-existing-thread-project-');
    const source = join(root, 'source');
    await initializeGitRepository(source);
    const destination = userThread(uuidV7(), source);
    const store = automationStore();
    const service = automationServiceFor(store, Date.parse('2026-07-24T09:00:00Z'), {
      threads: threadHost(destination) as unknown as ThreadService,
    });

    await expect(service.create({
      ...definition('20260724T100000'),
      destination: { kind: 'existingThread', threadId: destination.id },
      projectBindings: [{ id: 'repo', cwd: source, executionMode: 'worktree' }],
    })).rejects.toThrow('only a local project binding');

    const automation = await service.create({
      ...definition('20260724T100000'),
      destination: { kind: 'existingThread', threadId: destination.id },
      projectBindings: [{ id: 'repo', cwd: source, executionMode: 'local' }],
    });
    expect(automation.destination).toEqual({ kind: 'existingThread', threadId: destination.id });
  });

  test('continues closing every Agent owner after an Automation stop failure', async () => {
    const events: string[] = [];
    const closing = closeAgentServices(
      {
        async stopWorker() { events.push('memory:stop'); },
        closeStore() { events.push('memory:close'); },
      },
      { async close() { events.push('threads:close'); } },
      {
        async stop() {
          events.push('automations:stop');
          throw new Error('stop failed');
        },
        closeStore() { events.push('automations:close'); },
      },
    );
    await expect(closing).rejects.toThrow('failed to close');
    expect(events).toEqual([
      'automations:stop',
      'memory:stop',
      'threads:close',
      'memory:close',
      'automations:close',
    ]);
  });
});

describe('Automation Thread dispatch', () => {
  test('binds standalone and existing-Thread runs through immutable Turn provenance', async () => {
    const now = Date.parse('2026-07-24T09:00:00Z');
    const store = automationStore();
    const standalone = store.create(definition('20260724T100000'), now);
    const standaloneRun = store.claimNow(standalone, null, now + 1);
    const standaloneHost = threadHost();
    const standaloneDispatcher = dispatcherFor(store, standaloneHost, now + 2);
    const dispatchedStandalone = await standaloneDispatcher.dispatch(standaloneRun);

    expect(dispatchedStandalone.state).toBe('dispatched');
    expect(standaloneHost.ensureCalls).toHaveLength(1);
    expect(standaloneHost.turnCalls[0]).toMatchObject({
      threadId: standaloneRun.threadId,
      clientUserMessageId: standaloneRun.id,
      trigger: { kind: 'feature', feature: 'automation', ref: standaloneRun.id },
    });
    expect(JSON.parse(standaloneHost.turnCalls[0]!.additionalContext.automation_info.value)).toMatchObject({
      automationId: standalone.id,
      automationRunId: standaloneRun.id,
      destination: 'standalone',
    });
    expect(standaloneDispatcher.isRunActive(dispatchedStandalone)).toBe(true);

    const existingThread = userThread(uuidV7(), '/tmp/existing');
    const existing = store.create({
      ...definition('20260724T100000'),
      destination: { kind: 'existingThread', threadId: existingThread.id },
    }, now + 3);
    const existingRun = store.claimNow(existing, null, now + 4);
    const existingHost = threadHost(existingThread);
    const existingDispatcher = dispatcherFor(store, existingHost, now + 5);
    const dispatchedExisting = await existingDispatcher.dispatch(existingRun);

    expect(dispatchedExisting).toMatchObject({
      state: 'dispatched',
      threadId: existingThread.id,
    });
    expect(existingHost.ensureCalls).toHaveLength(0);
    expect(existingHost.turnCalls[0]?.trigger).toEqual({
      kind: 'feature',
      feature: 'automation',
      ref: existingRun.id,
    });
    expect(JSON.parse(existingHost.turnCalls[0]!.additionalContext.automation_info.value)).toMatchObject({
      cwd: '/tmp/existing',
      projectCwd: null,
      worktree: null,
    });
  });

  test('keeps a busy existing-Thread claim pending without overlap', async () => {
    const now = Date.parse('2026-07-24T09:00:00Z');
    const store = automationStore();
    const destination = userThread(uuidV7(), '/tmp/existing');
    const automation = store.create({
      ...definition('20260724T100000'),
      destination: { kind: 'existingThread', threadId: destination.id },
    }, now);
    const run = store.claimNow(automation, null, now + 1);
    const host = threadHost(destination);
    host.busy = true;
    const dispatcher = dispatcherFor(store, host, now + 2);

    expect(await dispatcher.dispatch(run)).toMatchObject({ state: 'pending' });
    expect(dispatcher.isRunActive(store.readRun(run.id)!)).toBe(true);
    expect(store.listRuns({ automationId: automation.id })).toHaveLength(1);
  });

  test('retries idempotently when dispatch persistence fails after Turn admission', async () => {
    const now = Date.parse('2026-07-24T09:00:00Z');
    const store = automationStore();
    const automation = store.create(definition('20260724T100000'), now);
    const run = store.claimNow(automation, null, now + 1);
    const host = threadHost();
    const dispatcher = dispatcherFor(store, host, now + 2);
    const original = store.markDispatched.bind(store);
    let failOnce = true;
    store.markDispatched = ((...args: Parameters<AutomationStore['markDispatched']>) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('simulated durable write failure');
      }
      return original(...args);
    }) as AutomationStore['markDispatched'];

    const retryable = await dispatcher.dispatch(run);
    expect(retryable).toMatchObject({
      state: 'pending',
      error: 'simulated durable write failure',
    });
    const recovered = await dispatcher.dispatch(retryable);
    expect(recovered.state).toBe('dispatched');
    expect(host.turnCalls).toHaveLength(2);
    expect(host.turnCalls.map((call) => call.clientUserMessageId)).toEqual([run.id, run.id]);
    expect(new Set(host.turnCalls.map((call) => call.returnedTurnId))).toHaveLength(1);
  });

  test('fails before model execution when saved configuration cannot resolve', async () => {
    const now = Date.parse('2026-07-24T09:00:00Z');
    const store = automationStore();
    const automation = store.create(definition('20260724T100000'), now);
    const run = store.claimNow(automation, null, now + 1);
    const host = threadHost();
    const dispatcher = dispatcherFor(store, host, now + 2, async () => {
      throw new Error('Automation Skills are unavailable: missing-skill');
    });
    const failed = await dispatcher.dispatch(run);

    expect(failed).toMatchObject({
      state: 'failed',
      threadId: null,
      error: 'Automation Skills are unavailable: missing-skill',
    });
    expect(host.turnCalls).toHaveLength(0);
  });

  test('keeps scheduling healthy after a user deletes historical Thread output', async () => {
    const now = Date.parse('2026-07-24T09:00:00Z');
    const store = automationStore();
    const automation = store.create(definition('20260724T100000'), now);
    const run = store.claimNow(automation, null, now + 1);
    const host = threadHost();
    const dispatcher = dispatcherFor(store, host, now + 2);
    const dispatched = await dispatcher.dispatch(run);

    await host.deleteThread(dispatched.threadId!);
    await dispatcher.reconcile();
    expect(store.readRun(run.id)).toMatchObject({
      state: 'dispatched',
      threadId: dispatched.threadId,
      turnId: dispatched.turnId,
    });
  });
});

describe('Automation worktrees', () => {
  test('creates only contained worktrees and snapshots changes before removal', async () => {
    const root = await tempRoot('automation-worktree-');
    const source = join(root, 'source');
    await execFileAsync('git', ['init', source]);
    await execFileAsync('git', ['-C', source, 'config', 'user.name', 'Automation Test']);
    await execFileAsync('git', ['-C', source, 'config', 'user.email', 'automation@example.test']);
    await writeFile(join(source, 'tracked.txt'), 'before\n');
    await execFileAsync('git', ['-C', source, 'add', 'tracked.txt']);
    await execFileAsync('git', ['-C', source, 'commit', '-m', 'Initial']);

    const store = automationStore();
    const automation = store.create({
      ...definition('20260724T100000'),
      projectBindings: [{ id: 'repo', cwd: source, executionMode: 'worktree' }],
    }, Date.parse('2026-07-24T09:00:00Z'));
    const run = store.claimNow(automation, automation.projectBindings[0]!, Date.parse('2026-07-24T09:01:00Z'));
    const worktrees = new AutomationWorktree(root);
    const prepared = await worktrees.prepare(run);
    const rel = relative(await realpath(join(root, 'agent', 'automation-worktrees')), prepared.cwd);
    expect(rel.startsWith('..')).toBe(false);
    expect(isAbsolute(rel)).toBe(false);
    expect(prepared.worktree?.managed).toBe(true);

    await writeFile(join(source, 'source-only.txt'), 'source advanced\n');
    await execFileAsync('git', ['-C', source, 'add', 'source-only.txt']);
    await execFileAsync('git', ['-C', source, 'commit', '-m', 'Advance source']);
    const recovered = await worktrees.prepare(run);
    expect(recovered.worktree).toEqual(prepared.worktree);
    const persisted = store.setWorktree(run.id, recovered.worktree!);
    const resumed = await worktrees.prepare(persisted);
    expect(resumed.worktree).toEqual(prepared.worktree);

    await writeFile(join(prepared.cwd, 'tracked.txt'), 'after\n');
    await execFileAsync('git', ['-C', prepared.cwd, 'add', 'tracked.txt']);
    await execFileAsync('git', ['-C', prepared.cwd, 'commit', '-m', 'Automation change']);
    await writeFile(join(prepared.cwd, 'new.txt'), 'new\n');
    const removed = await worktrees.snapshotAndRemove(prepared.worktree!);
    expect(removed.snapshotPath).not.toBeNull();
    expect(removed.removedAt).not.toBeNull();
    const patch = await readFile(removed.snapshotPath!, 'utf8');
    expect(patch).toContain('tracked.txt');
    expect(patch).toContain('new.txt');
    await expect(readFile(join(prepared.cwd, 'tracked.txt'), 'utf8')).rejects.toThrow();
    expect(await readFile(join(source, 'tracked.txt'), 'utf8')).toBe('before\n');
  });

  test('rejects unregistered managed paths and retains a worktree when snapshotting fails', async () => {
    const root = await tempRoot('automation-worktree-guard-');
    const source = join(root, 'source');
    await initializeGitRepository(source);
    const store = automationStore();
    const automation = store.create({
      ...definition('20260724T100000'),
      projectBindings: [{ id: 'repo', cwd: source, executionMode: 'worktree' }],
    }, Date.parse('2026-07-24T09:00:00Z'));
    const run = store.claimNow(automation, automation.projectBindings[0]!, Date.parse('2026-07-24T09:01:00Z'));
    const managedPath = join(root, 'agent', 'automation-worktrees', automation.id, run.id);
    await mkdir(managedPath, { recursive: true });
    await execFileAsync('git', ['init', managedPath]);
    const worktrees = new AutomationWorktree(root);

    await expect(worktrees.prepare(run)).rejects.toThrow('not registered');
    await rm(managedPath, { recursive: true, force: true });
    const prepared = await worktrees.prepare(run);
    await rm(join(prepared.cwd, '.git'));
    const persisted = store.setWorktree(run.id, prepared.worktree!);
    await expect(worktrees.prepare(persisted)).rejects.toThrow();
    await expect(worktrees.snapshotAndRemove(prepared.worktree!)).rejects.toThrow();
    expect(await readFile(join(prepared.cwd, 'tracked.txt'), 'utf8')).toBe('before\n');
  });

  test('cleans an unpinned worktree after its pending run is omitted', async () => {
    const root = await tempRoot('automation-worktree-omitted-');
    const source = join(root, 'source');
    await initializeGitRepository(source);
    const store = automationStore();
    const automation = store.create({
      ...definition('20260724T100000'),
      projectBindings: [{ id: 'repo', cwd: source, executionMode: 'worktree' }],
    }, Date.parse('2026-07-24T09:00:00Z'));
    const claimed = store.claimNow(
      automation,
      automation.projectBindings[0]!,
      Date.parse('2026-07-24T09:01:00Z'),
    );
    const worktrees = new AutomationWorktree(root);
    const prepared = await worktrees.prepare(claimed);
    store.setWorktree(claimed.id, prepared.worktree!);
    store.setStatus(automation.id, 'paused', automation.revision, Date.parse('2026-07-24T09:02:00Z'));
    expect(store.readRun(claimed.id)?.state).toBe('omitted');

    const dispatcher = new AutomationDispatcher({
      store,
      threads: threadHost() as unknown as ThreadService,
      worktrees,
      defaultCwd: root,
      resolveConfiguration: async () => ({
        modelProvider: 'openai',
        configuration: defaultEffectiveThreadConfiguration(),
      }),
    });
    await dispatcher.cleanupRetainedWorktrees(0);

    expect(store.readRun(claimed.id)?.worktree?.removedAt).not.toBeNull();
    await expect(readFile(join(prepared.cwd, 'tracked.txt'), 'utf8')).rejects.toThrow();
  });
});

function definition(
  dtstart: string,
  rule = 'FREQ=DAILY',
): AutomationCreateInput {
  return {
    name: 'Daily review',
    prompt: 'Review the project and report the important changes.',
    schedule: { rrule: `DTSTART:${dtstart}\nRRULE:${rule}`, timezone: 'UTC' },
    destination: { kind: 'standalone' },
    projectBindings: [],
    configuration: EMPTY_AUTOMATION_CONFIGURATION,
  };
}

function automationStore(path = ':memory:'): AutomationStore {
  return tracked(new AutomationStore(path, new Database(path, { create: true }) as unknown as SqliteDatabase));
}

function tracked(store: AutomationStore): AutomationStore {
  stores.push(store);
  return store;
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function initializeGitRepository(path: string): Promise<void> {
  await execFileAsync('git', ['init', path]);
  await execFileAsync('git', ['-C', path, 'config', 'user.name', 'Automation Test']);
  await execFileAsync('git', ['-C', path, 'config', 'user.email', 'automation@example.test']);
  await writeFile(join(path, 'tracked.txt'), 'before\n');
  await execFileAsync('git', ['-C', path, 'add', 'tracked.txt']);
  await execFileAsync('git', ['-C', path, 'commit', '-m', 'Initial']);
}

function schedulerFor(
  store: AutomationStore,
  now: number,
  overrides: {
    readonly dispatch: (run: AutomationRun) => AutomationRun | Promise<AutomationRun>;
    readonly isRunActive?: (run: AutomationRun) => boolean;
  },
): AutomationScheduler {
  const dispatcher = {
    reconcile: async () => {
      for (const run of store.pendingRuns()) await overrides.dispatch(run);
    },
    dispatch: overrides.dispatch,
    isRunActive: overrides.isRunActive ?? (() => false),
    cleanupRetainedWorktrees: async () => undefined,
  } as unknown as AutomationDispatcher;
  return new AutomationScheduler({
    store,
    dispatcher,
    now: () => now,
    setTimer: () => 1,
    clearTimer: () => undefined,
  });
}

function automationServiceFor(
  store: AutomationStore,
  now: number,
  overrides: {
    readonly dispatch?: (run: AutomationRun) => AutomationRun | Promise<AutomationRun>;
    readonly isRunActive?: (run: AutomationRun) => boolean;
    readonly validateConfiguration?: () => Promise<unknown>;
    readonly threads?: ThreadService;
  } = {},
): AutomationService {
  const dispatcher = {
    reconcile: async () => undefined,
    dispatch: overrides.dispatch ?? (async (run: AutomationRun) => run),
    isRunActive: overrides.isRunActive ?? ((run: AutomationRun) => run.state === 'pending'),
    cleanupRetainedWorktrees: async () => undefined,
    validateConfiguration: overrides.validateConfiguration ?? (async () => undefined),
  } as unknown as AutomationDispatcher;
  const scheduler = new AutomationScheduler({
    store,
    dispatcher,
    now: () => now,
    setTimer: () => 1,
    clearTimer: () => undefined,
  });
  return new AutomationService({
    store,
    scheduler,
    dispatcher,
    threads: overrides.threads ?? {} as ThreadService,
    now: () => now,
  });
}

interface TurnCall {
  readonly threadId: string;
  readonly clientUserMessageId: string;
  readonly trigger: { readonly kind: 'feature'; readonly feature: string; readonly ref: string };
  readonly additionalContext: { readonly automation_info: { readonly kind: 'application'; readonly value: string } };
  readonly returnedTurnId: string;
}

interface ThreadHostProbe {
  busy: boolean;
  readonly ensureCalls: unknown[];
  readonly turnCalls: TurnCall[];
  readonly deleted: string[];
  persistentThreadExecutionContext(threadId: string): {
    thread: Thread;
    configuration: ReturnType<typeof defaultEffectiveThreadConfiguration>;
  };
  ensureFeatureRootThread(input: {
    id: string;
    name: string;
    modelProvider: string;
    cwd: string;
  }): Promise<Thread>;
  tryStartTurnIfIdle(input: Omit<TurnCall, 'returnedTurnId'>): Promise<Turn | null>;
  readTurnForHost(threadId: string, turnId: string): Turn | null;
  deleteThread(threadId: string): Promise<void>;
}

function threadHost(existing?: Thread): ThreadHostProbe {
  const threads = new Map<string, Thread>(existing ? [[existing.id, existing]] : []);
  const turns = new Map<string, Turn>();
  const ensureCalls: unknown[] = [];
  const turnCalls: TurnCall[] = [];
  const deleted: string[] = [];
  return {
    busy: false,
    ensureCalls,
    turnCalls,
    deleted,
    persistentThreadExecutionContext(threadId) {
      const thread = threads.get(threadId);
      if (!thread) throw new Error(`Thread not found: ${threadId}`);
      return { thread, configuration: defaultEffectiveThreadConfiguration() };
    },
    async ensureFeatureRootThread(input) {
      ensureCalls.push(input);
      const current = threads.get(input.id);
      if (current) return current;
      const thread = userThread(input.id, input.cwd, {
        name: input.name,
        source: 'agent.automation',
        threadSource: threadFeatureSource('automation'),
        modelProvider: input.modelProvider,
      });
      threads.set(thread.id, thread);
      return thread;
    },
    async tryStartTurnIfIdle(input) {
      if (this.busy) return null;
      const existingTurn = [...turns.values()].find((turn) => (
        turn.provenance.trigger.kind === 'feature'
        && turn.provenance.trigger.ref === input.clientUserMessageId
      ));
      const turn = existingTurn ?? automationTurn(input.threadId, input.trigger);
      turns.set(turn.id, turn);
      turnCalls.push({ ...input, returnedTurnId: turn.id });
      return turn;
    },
    readTurnForHost(_threadId, turnId) {
      return turns.get(turnId) ?? null;
    },
    async deleteThread(threadId) {
      deleted.push(threadId);
      threads.delete(threadId);
      for (const [turnId, turn] of turns) {
        if (turn.provenance.originThreadId === threadId) turns.delete(turnId);
      }
    },
  };
}

function dispatcherFor(
  store: AutomationStore,
  host: ThreadHostProbe,
  now: number,
  resolveConfiguration: () => Promise<{
    modelProvider: string;
    configuration: ReturnType<typeof defaultEffectiveThreadConfiguration>;
  }> = async () => ({
    modelProvider: 'openai',
    configuration: defaultEffectiveThreadConfiguration(),
  }),
): AutomationDispatcher {
  return new AutomationDispatcher({
    store,
    threads: host as unknown as ThreadService,
    worktrees: { prepare: async () => ({ cwd: '', worktree: null }) } as unknown as AutomationWorktree,
    defaultCwd: '/tmp/default',
    resolveConfiguration,
    now: () => now,
  });
}

function userThread(id: string, cwd: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    sessionId: id,
    parentThreadId: null,
    forkedFromId: null,
    agentNickname: null,
    agentRole: null,
    name: 'Destination',
    preview: '',
    ephemeral: false,
    source: 'app',
    threadSource: 'user',
    modelProvider: 'openai',
    cwd,
    createdAt: 1,
    updatedAt: 1,
    status: { type: 'idle' },
    historyMode: 'paginated',
    ...overrides,
  };
}

function automationTurn(
  threadId: string,
  trigger: { readonly kind: 'feature'; readonly feature: string; readonly ref: string },
): Turn {
  const id = uuidV7();
  return {
    id,
    items: [],
    itemsView: 'full',
    provenance: { originThreadId: threadId, originTurnId: id, trigger },
    status: 'inProgress',
    error: null,
    execution: {
      modelProvider: 'openai',
      model: 'inherit',
      reasoningEffort: 'medium',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
    },
    startedAt: Date.now(),
    completedAt: null,
    durationMs: null,
  };
}
