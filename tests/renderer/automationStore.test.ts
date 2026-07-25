import { describe, expect, test } from 'bun:test';
import type {
  Automation,
  AutomationCreateInput,
  AutomationNotification,
  AutomationRun,
} from '../../src/core/agent/automation';
import {
  frequencyFromRrule,
  scheduleRrule,
} from '../../src/renderer/agent/automations/AutomationEditor';
import {
  AutomationRendererStore,
  type AutomationStoreClient,
} from '../../src/renderer/agent/automations/automationStore';

describe('renderer Automation store', () => {
  test('loads the catalog and applies canonical realtime notifications', async () => {
    const first = automation('01920000-0000-7000-8000-000000000001', 10);
    const second = automation('01920000-0000-7000-8000-000000000002', 20);
    const firstRun = run(first, '01920000-0000-7000-8000-000000000101', 30);
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
      runs: [firstRun],
      selectedAutomationId: first.id,
      loading: false,
    });

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

  test('routes CRUD, Start now, read, and pin operations through one transport', async () => {
    const base = automation('01920000-0000-7000-8000-000000000001', 10);
    const calls: Array<{ method: string; input: unknown }> = [];
    const created = { ...base, id: '01920000-0000-7000-8000-000000000002', updatedAt: 20 };
    const started = run(created, '01920000-0000-7000-8000-000000000102', 30);
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
    await store.markRunRead(started);
    await store.pinRun(started, true);
    await store.delete(created);

    expect(calls.map((call) => call.method)).toEqual([
      'list', 'runs', 'create', 'update', 'pause', 'resume', 'startNow',
      'runMarkRead', 'runPin', 'delete',
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
    let notify: (notification: AutomationNotification) => void = () => undefined;
    let resolveList!: (value: { data: readonly Automation[] }) => void;
    let resolveRuns!: (value: { data: readonly AutomationRun[] }) => void;
    const list = new Promise<{ data: readonly Automation[] }>((resolve) => { resolveList = resolve; });
    const runs = new Promise<{ data: readonly AutomationRun[] }>((resolve) => { resolveRuns = resolve; });
    const client = {
      onAutomationNotification(listener: (notification: AutomationNotification) => void) {
        notify = listener;
        return () => undefined;
      },
      automationRequest(method: string) {
        if (method === 'list') return list;
        if (method === 'runs') return runs;
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as AutomationStoreClient;
    const store = new AutomationRendererStore(client);
    const initializing = store.initialize();

    notify({ type: 'automation/changed', automationId: first.id, automation: updated });
    notify({ type: 'automation/changed', automationId: deleted.id, automation: null });
    notify({ type: 'automationRun/changed', run: completedRun });
    resolveList({ data: [first, deleted] });
    resolveRuns({ data: [initialRun] });
    await initializing;

    expect(store.getSnapshot().automations).toEqual([updated]);
    expect(store.getSnapshot().runs).toEqual([completedRun]);
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
    runResolvers[1]!({ data: [] });
    await second;
    listResolvers[0]!({ data: [oldAutomation] });
    runResolvers[0]!({ data: [] });
    await first;

    expect(store.getSnapshot().automations).toEqual([currentAutomation]);
  });

  test('generates six-digit floating DTSTART values for editor presets', () => {
    expect(scheduleRrule('2026-07-24T09:05', 'once')).toBe(
      'DTSTART:20260724T090500\nRRULE:FREQ=DAILY;COUNT=1',
    );
    expect(scheduleRrule('2026-07-24T09:05', 'weekly')).toBe(
      'DTSTART:20260724T090500\nRRULE:FREQ=WEEKLY;BYDAY=FR',
    );
    expect(frequencyFromRrule('DTSTART:20260724T090500\nRRULE:FREQ=DAILY')).toBe('daily');
    expect(frequencyFromRrule('DTSTART:20260724T090530\nRRULE:FREQ=DAILY')).toBe('custom');
    expect(frequencyFromRrule('DTSTART:20260724T090500\nRRULE:FREQ=DAILY;COUNT=3')).toBe('custom');
    expect(frequencyFromRrule('DTSTART:20260724T090500\nRRULE:FREQ=HOURLY;INTERVAL=2')).toBe('custom');
    expect(frequencyFromRrule('DTSTART:20260724T090500\nRRULE:FREQ=WEEKLY;BYDAY=MO')).toBe('custom');
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
      profileName: null,
      modelProvider: null,
      model: null,
      reasoningEffort: null,
      tools: null,
      skills: null,
      plugins: null,
      mcpServers: null,
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
