import { describe, expect, test } from 'bun:test';
import type {
  Automation,
  AutomationCreateInput,
  AutomationNotification,
  AutomationRun,
} from '../../src/core/agent/automation';
import {
  automationScheduleRrule,
  createAutomationScheduleDraft,
  isAutomationScheduleDraftValid,
  scheduleModeFromRrule,
} from '../../src/renderer/agent/automations/AutomationScheduleDraft';
import { clampAutomationDrawerHeight } from '../../src/renderer/agent/automations/AutomationDrawerResize';
import {
  AutomationRendererStore,
  type AutomationStoreClient,
} from '../../src/renderer/agent/automations/automationStore';

describe('renderer Automation store', () => {
  test('loads the catalog and applies canonical realtime notifications', async () => {
    const first = automation('01920000-0000-7000-8000-000000000001', 10);
    const second = automation('01920000-0000-7000-8000-000000000002', 20);
    const firstRun: AutomationRun = {
      ...run(first, '01920000-0000-7000-8000-000000000101', 30),
      state: 'dispatched',
      turnId: '01920000-0000-7000-8000-000000000301',
    };
    let notify: (notification: AutomationNotification) => void = () => undefined;
    let unsubscribed = false;
    const client = {
      onAutomationNotification(listener: (notification: AutomationNotification) => void) {
        notify = listener;
        return () => { unsubscribed = true; };
      },
      async automationRequest(method: string) {
        if (method === 'list') return { data: [first] };
        if (method === 'runs') return { data: [firstRun] };
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as AutomationStoreClient;
    const store = new AutomationRendererStore(client);
    await store.initialize();

    expect(store.getSnapshot()).toMatchObject({
      automations: [first],
      runs: [],
      unreadAutomationIds: [first.id],
      selectedAutomationId: first.id,
      loading: false,
    });
    await store.loadRunsForAutomation(first.id);
    expect(store.getSnapshot().runs).toEqual([firstRun]);
    notify({ type: 'automationRuns/markedRead', automationId: first.id, readAt: 50 });
    expect(store.getSnapshot().runs[0]?.readAt).toBe(50);
    expect(store.getSnapshot().unreadAutomationIds).not.toContain(first.id);
    notify({ type: 'automationRun/changed', run: firstRun });
    expect(store.getSnapshot().runs[0]?.readAt).toBe(50);
    expect(store.getSnapshot().unreadAutomationIds).not.toContain(first.id);

    notify({ type: 'automation/changed', automationId: second.id, automation: second });
    expect(store.getSnapshot().automations.map((item) => item.id)).toEqual([second.id, first.id]);
    const secondRun = run(second, '01920000-0000-7000-8000-000000000102', 40);
    notify({ type: 'automationRun/changed', run: secondRun });
    expect(store.getSnapshot().runs.map((item) => item.id)).toEqual([secondRun.id, firstRun.id]);
    notify({ type: 'automation/changed', automationId: second.id, automation: null });
    expect(store.getSnapshot().automations.map((item) => item.id)).toEqual([first.id]);

    store.dispose();
    expect(unsubscribed).toBe(true);
  });

  test('loads unread state and recent runs per Automation instead of from a global cap', async () => {
    const first = automation('01920000-0000-7000-8000-000000000001', 10);
    const second = automation('01920000-0000-7000-8000-000000000002', 20);
    const secondRun: AutomationRun = {
      ...run(second, '01920000-0000-7000-8000-000000000102', 30),
      state: 'failed',
      error: 'provider unavailable',
    };
    const runInputs: unknown[] = [];
    const client = {
      onAutomationNotification: () => () => undefined,
      async automationRequest(method: string, input: unknown) {
        if (method === 'list') return { data: [first, second] };
        if (method === 'runs') {
          runInputs.push(input);
          const request = input as { automationId: string; unreadOnly?: boolean };
          return {
            data: request.automationId === second.id ? [secondRun] : [],
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as AutomationStoreClient;
    const store = new AutomationRendererStore(client);

    await store.initialize();
    expect(store.getSnapshot().unreadAutomationIds).toEqual([second.id]);
    await store.loadRunsForAutomation(second.id);
    expect(store.getSnapshot().runs).toEqual([secondRun]);
    expect(runInputs).toEqual([
      { automationId: first.id, unreadOnly: true, limit: 1 },
      { automationId: second.id, unreadOnly: true, limit: 1 },
      { automationId: second.id, limit: 200 },
    ]);
  });

  test('routes CRUD, Start now, read, and pin operations through one transport', async () => {
    const base = automation('01920000-0000-7000-8000-000000000001', 10);
    const calls: Array<{ method: string; input: unknown }> = [];
    const created = { ...base, id: '01920000-0000-7000-8000-000000000002', updatedAt: 20 };
    const started: AutomationRun = {
      ...run(created, '01920000-0000-7000-8000-000000000102', 30),
      state: 'dispatched',
      turnId: '01920000-0000-7000-8000-000000000302',
    };
    const client = {
      onAutomationNotification: () => () => undefined,
      async automationRequest(method: string, input: unknown) {
        calls.push({ method, input });
        if (method === 'list') return { data: [base] };
        if (method === 'runs') return { data: [] };
        if (method === 'create') return { automation: created };
        if (method === 'update') return { automation: { ...created, revision: 2, updatedAt: 21 } };
        if (method === 'pause') return { automation: { ...created, status: 'paused', revision: 2, updatedAt: 22 } };
        if (method === 'resume') return { automation: { ...created, status: 'active', revision: 3, updatedAt: 23 } };
        if (method === 'startNow') return { runs: [started] };
        if (method === 'runMarkRead') return { run: { ...started, readAt: 31 } };
        if (method === 'runsMarkRead') {
          return { automationId: created.id, readAt: 32, updatedCount: 201 };
        }
        if (method === 'runPin') return { run: { ...started, pinned: true } };
        if (method === 'delete') return { deleted: true, id: created.id };
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as AutomationStoreClient;
    const store = new AutomationRendererStore(client);
    await store.initialize();

    await store.create(createInput());
    await store.update({ id: created.id, expectedRevision: 1, prompt: 'Updated prompt' });
    await store.pause(created);
    await store.resume({ ...created, status: 'paused', revision: 2 });
    await store.startNow(created);
    expect(store.getSnapshot().unreadAutomationIds).toContain(created.id);
    await store.markRunRead(started);
    expect(store.getSnapshot().unreadAutomationIds).not.toContain(created.id);
    await store.startNow(created);
    expect(store.getSnapshot().unreadAutomationIds).toContain(created.id);
    await store.markAutomationRunsRead(created.id);
    expect(store.getSnapshot().unreadAutomationIds).not.toContain(created.id);
    expect(store.getSnapshot().runs.find((item) => item.id === started.id)?.readAt).toBe(32);
    await store.pinRun(started, true);
    await store.delete(created);

    expect(calls.map((call) => call.method)).toEqual([
      'list', 'runs', 'create', 'update', 'pause', 'resume', 'startNow',
      'runMarkRead', 'runs', 'startNow', 'runsMarkRead', 'runPin', 'delete',
    ]);
    expect(calls.find((call) => call.method === 'pause')?.input).toEqual({
      id: created.id,
      expectedRevision: created.revision,
    });
    expect(calls.find((call) => call.method === 'runPin')?.input).toEqual({
      id: started.id,
      pinned: true,
    });
    expect(store.getSnapshot().automations.some((item) => item.id === created.id)).toBe(false);
  });

  test('does not let stale initial responses overwrite realtime changes', async () => {
    const first = automation('01920000-0000-7000-8000-000000000001', 10);
    const deleted = automation('01920000-0000-7000-8000-000000000002', 11);
    const initialRun = run(first, '01920000-0000-7000-8000-000000000101', 20);
    const updated = { ...first, revision: 2, updatedAt: 30 };
    const completedRun: AutomationRun = {
      ...initialRun,
      state: 'dispatched',
      turnId: '01920000-0000-7000-8000-000000000301',
      updatedAt: 31,
    };
    const deletedRun: AutomationRun = {
      ...run(deleted, '01920000-0000-7000-8000-000000000102', 21),
      state: 'failed',
      error: 'unavailable',
    };
    let notify: (notification: AutomationNotification) => void = () => undefined;
    let resolveList!: (value: { data: readonly Automation[] }) => void;
    const runResolvers: Array<(value: { data: readonly AutomationRun[] }) => void> = [];
    const list = new Promise<{ data: readonly Automation[] }>((resolve) => { resolveList = resolve; });
    const client = {
      onAutomationNotification(listener: (notification: AutomationNotification) => void) {
        notify = listener;
        return () => undefined;
      },
      automationRequest(method: string) {
        if (method === 'list') return list;
        if (method === 'runs') {
          return new Promise((resolve) => {
            runResolvers.push(resolve as (value: { data: readonly AutomationRun[] }) => void);
          });
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as AutomationStoreClient;
    const store = new AutomationRendererStore(client);
    const initializing = store.initialize();

    notify({ type: 'automation/changed', automationId: first.id, automation: updated });
    notify({ type: 'automation/changed', automationId: deleted.id, automation: null });
    notify({ type: 'automationRun/changed', run: completedRun });
    resolveList({ data: [first, deleted] });
    await Promise.resolve();
    runResolvers[0]!({ data: [] });
    runResolvers[1]!({ data: [deletedRun] });
    await initializing;

    expect(store.getSnapshot().automations).toEqual([updated]);
    expect(store.getSnapshot().runs).toEqual([completedRun]);
    expect(store.getSnapshot().unreadAutomationIds).toEqual([first.id]);
  });

  test('ignores a prior mount reload that resolves after a reopened surface', async () => {
    const oldAutomation = automation('01920000-0000-7000-8000-000000000001', 10);
    const currentAutomation = automation('01920000-0000-7000-8000-000000000002', 20);
    const listResolvers: Array<(value: { data: readonly Automation[] }) => void> = [];
    const runResolvers: Array<(value: { data: readonly AutomationRun[] }) => void> = [];
    const client = {
      onAutomationNotification: () => () => undefined,
      automationRequest(method: string) {
        return new Promise((resolve) => {
          if (method === 'list') listResolvers.push(resolve as (value: { data: readonly Automation[] }) => void);
          else if (method === 'runs') runResolvers.push(resolve as (value: { data: readonly AutomationRun[] }) => void);
          else throw new Error(`Unexpected method: ${method}`);
        });
      },
    } as unknown as AutomationStoreClient;
    const store = new AutomationRendererStore(client);
    const first = store.initialize();
    store.dispose();
    const second = store.initialize();

    listResolvers[1]!({ data: [currentAutomation] });
    await Promise.resolve();
    runResolvers[0]!({ data: [] });
    await second;
    listResolvers[0]!({ data: [oldAutomation] });
    await first;

    expect(store.getSnapshot().automations).toEqual([currentAutomation]);
  });

  test('round-trips every structured Automation schedule mode', () => {
    const sources = [
      'DTSTART:20260724T090500\nRRULE:FREQ=DAILY;COUNT=1',
      'DTSTART:20260724T090000\nRRULE:FREQ=HOURLY',
      'DTSTART:20260724T090500\nRRULE:FREQ=DAILY',
      'DTSTART:20260727T090500\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
      'DTSTART:20260727T090500\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR',
      'DTSTART:20260724T090500\nRRULE:FREQ=HOURLY;INTERVAL=2;BYMINUTE=5',
      'DTSTART:20260724T090500\nRRULE:FREQ=DAILY;INTERVAL=3;BYHOUR=9;BYMINUTE=5',
      'DTSTART:20260727T090500\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;BYHOUR=9;BYMINUTE=5',
      'DTSTART:20260724T090500\nRRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1,15;BYHOUR=9;BYMINUTE=5',
      'DTSTART:20260724T090500\nRRULE:FREQ=YEARLY;INTERVAL=1;BYMONTH=7;BYMONTHDAY=24;BYHOUR=9;BYMINUTE=5',
    ];
    for (const source of sources) {
      expect(automationScheduleRrule(createAutomationScheduleDraft(source))).toBe(source);
    }
    expect(scheduleModeFromRrule(sources[0]!)).toBe('once');
    expect(scheduleModeFromRrule(sources[1]!)).toBe('hourly');
    expect(scheduleModeFromRrule(sources[2]!)).toBe('daily');
    expect(scheduleModeFromRrule(sources[3]!)).toBe('weekdays');
    expect(scheduleModeFromRrule(sources[4]!)).toBe('weekly');
    expect(scheduleModeFromRrule(sources[5]!)).toBe('custom');
  });

  test('requires at least one weekday or month day for structured schedules', () => {
    const draft = createAutomationScheduleDraft(
      'DTSTART:20260727T090500\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE',
    );
    expect(isAutomationScheduleDraftValid({ ...draft, weekdays: [] })).toBe(false);
    expect(isAutomationScheduleDraftValid({ ...draft, weekdays: ['MO', 'MO'] })).toBe(false);
    expect(isAutomationScheduleDraftValid({
      ...draft,
      mode: 'custom',
      customFrequency: 'monthly',
      monthDays: [],
    })).toBe(false);
    expect(isAutomationScheduleDraftValid({
      ...draft,
      mode: 'custom',
      customFrequency: 'monthly',
      monthDays: [1, 1],
    })).toBe(false);
  });

  test('preserves an untouched advanced RRULE until a structured field changes', () => {
    const source = 'DTSTART:20260724T090530\nRRULE:FREQ=DAILY;COUNT=3';
    const draft = createAutomationScheduleDraft(source);
    expect(draft.sourceRrule).toBe(source);
    expect(automationScheduleRrule(draft)).toBe(source);
    expect(automationScheduleRrule({ ...draft, sourceRrule: null })).toBe(
      'DTSTART:20260724T090500\nRRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=5',
    );
  });

  test('preserves RRULE values outside the structured scalar and list subset', () => {
    const sources = [
      'DTSTART:20260724T090000\nRRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=9,10;BYMINUTE=0',
      'DTSTART:20260724T090000\nRRULE:FREQ=HOURLY;INTERVAL=1;BYMINUTE=0,30',
      'DTSTART:20260727T090000\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,MO;BYHOUR=9;BYMINUTE=0',
      'DTSTART:20260724T090000\nRRULE:FREQ=YEARLY;INTERVAL=1;BYMONTH=7,8;BYMONTHDAY=24;BYHOUR=9;BYMINUTE=0',
    ];
    for (const source of sources) {
      expect(automationScheduleRrule(createAutomationScheduleDraft(source))).toBe(source);
    }
  });

  test('clamps the Automation drawer to its available height', () => {
    expect(clampAutomationDrawerHeight(200, 800)).toBe(360);
    expect(clampAutomationDrawerHeight(900, 800)).toBe(800);
    expect(clampAutomationDrawerHeight(300, 280)).toBe(280);
  });
});

function createInput(): AutomationCreateInput {
  return {
    name: 'Daily review',
    prompt: 'Review the project.',
    schedule: { rrule: 'DTSTART:20260724T090000\nRRULE:FREQ=DAILY', timezone: 'UTC' },
    destination: { kind: 'standalone' },
    projectBindings: [],
  };
}

function automation(id: string, updatedAt: number): Automation {
  return {
    id,
    name: `Automation ${updatedAt}`,
    prompt: 'Review the project.',
    schedule: { rrule: 'DTSTART:20260724T090000\nRRULE:FREQ=DAILY', timezone: 'UTC' },
    destination: { kind: 'standalone' },
    projectBindings: [],
    configuration: {
      modelProvider: null,
      model: null,
      reasoningEffort: null,
    },
    status: 'active',
    revision: 1,
    nextOccurrenceAt: updatedAt + 1_000,
    createdAt: updatedAt,
    updatedAt,
  };
}

function run(owner: Automation, id: string, scheduledFor: number): AutomationRun {
  return {
    id,
    automationId: owner.id,
    automationRevision: owner.revision,
    scheduledFor,
    projectBindingKey: 'no-project',
    snapshot: {
      automationName: owner.name,
      prompt: owner.prompt,
      schedule: owner.schedule,
      destination: owner.destination,
      projectBinding: null,
      configuration: owner.configuration,
    },
    state: 'pending',
    threadId: '01920000-0000-7000-8000-000000000201',
    turnId: null,
    worktree: null,
    omission: null,
    error: null,
    readAt: null,
    pinned: false,
    createdAt: scheduledFor,
    updatedAt: scheduledFor,
  };
}
