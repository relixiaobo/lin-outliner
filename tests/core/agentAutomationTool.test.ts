import { describe, expect, test } from 'bun:test';
import { decodeAutomationToolInput } from '../../src/core/agent/automation';
import type { AutomationCreateInput, AutomationUpdateInput } from '../../src/core/agent/automation';
import { createAutomationTool } from '../../src/main/agent/automations/AutomationTool';
import type { AutomationService } from '../../src/main/agent/automations/AutomationService';
import { validateExactToolArguments } from '../../src/main/agent/runtime/kernel/exactToolArguments';

const AUTOMATION_ID = '01930000-0000-7000-8000-000000000001';
const OTHER_ID = '01930000-0000-7000-8000-000000000002';

const DEFINITION = {
  name: 'Morning digest',
  prompt: 'Summarize what landed overnight.',
  schedule: { rrule: 'DTSTART:20260818T090000\nRRULE:FREQ=DAILY', timezone: 'Asia/Shanghai' },
  destination: { kind: 'standalone' },
};

describe('automation_update model tool', () => {
  test('accepts exactly the fields each mode takes at the provider boundary', () => {
    const accepted: Array<readonly [string, unknown]> = [
      ['create', { mode: 'create', definition: DEFINITION }],
      ['update', { mode: 'update', automation_id: AUTOMATION_ID, expected_revision: 1, patch: { name: 'Renamed' } }],
      ['view all', { mode: 'view' }],
      ['view one', { mode: 'view', automation_id: AUTOMATION_ID }],
      ['delete', { mode: 'delete', automation_id: AUTOMATION_ID, expected_revision: 2 }],
    ];
    for (const [label, value] of accepted) {
      expect(() => validateExactToolArguments(tool(), value), label).not.toThrow();
    }

    const rejected: Array<readonly [string, unknown]> = [
      ['an empty patch', { mode: 'update', automation_id: AUTOMATION_ID, expected_revision: 1, patch: {} }],
      ['an unknown field', { mode: 'view', automation: AUTOMATION_ID }],
      ['an unknown mode', { mode: 'pause', automation_id: AUTOMATION_ID }],
      ['no mode at all', {}],
    ];
    for (const [label, value] of rejected) {
      expect(() => validateExactToolArguments(tool(), value), label).toThrow('Invalid arguments for tool');
    }
  });

  test('refuses a wrong-shaped mode at the write boundary the schema cannot express', () => {
    // The root carries no union keyword — OpenAI refuses one — so the schema
    // cannot say "create takes definition and nothing else". These calls are
    // schema-valid and cost a round trip; the decoder is what keeps them from
    // reaching the service.
    const perMode: Array<readonly [string, unknown, string]> = [
      ['create without a definition', { mode: 'create' }, 'automation create must be an object'],
      ['update without a patch',
        { mode: 'update', automation_id: AUTOMATION_ID, expected_revision: 1 },
        'automation_update.patch must be an object'],
      ['delete without a revision',
        { mode: 'delete', automation_id: AUTOMATION_ID },
        'automation_update.expected_revision must be an integer'],
      ['view carrying a revision',
        { mode: 'view', expected_revision: 2 },
        'automation_update contains unknown fields: expected_revision'],
      ['create carrying an id',
        { mode: 'create', definition: DEFINITION, automation_id: AUTOMATION_ID },
        'automation_update contains unknown fields: automation_id'],
      ['delete carrying a patch',
        { mode: 'delete', automation_id: AUTOMATION_ID, expected_revision: 1, patch: { name: 'x' } },
        'automation_update contains unknown fields: patch'],
    ];
    for (const [label, value, message] of perMode) {
      expect(() => validateExactToolArguments(tool(), value), `${label} passes the schema`).not.toThrow();
      expect(() => decodeAutomationToolInput(value), label).toThrow(message);
    }
  });

  test('decodes each mode into one canonical service command', () => {
    expect(decodeAutomationToolInput({ mode: 'create', definition: DEFINITION }))
      .toMatchObject({ mode: 'create', create: { name: 'Morning digest' } });
    expect(decodeAutomationToolInput({
      mode: 'update',
      automation_id: AUTOMATION_ID,
      expected_revision: 4,
      patch: { status: 'paused' },
    })).toEqual({
      mode: 'update',
      update: { id: AUTOMATION_ID, expectedRevision: 4, status: 'paused' },
    });
    expect(decodeAutomationToolInput({ mode: 'view' })).toEqual({ mode: 'view', id: null });
    expect(decodeAutomationToolInput({ mode: 'view', automation_id: AUTOMATION_ID }))
      .toEqual({ mode: 'view', id: AUTOMATION_ID });
    expect(decodeAutomationToolInput({ mode: 'delete', automation_id: AUTOMATION_ID, expected_revision: 9 }))
      .toEqual({ mode: 'delete', id: AUTOMATION_ID, expectedRevision: 9 });
  });

  test('never lets a patch displace the Automation the revision guards', () => {
    // `patch.id` is refused by the schema, and the decoder applies the addressed
    // id after the patch, so neither layer alone can be talked into updating
    // Automation B under A's optimistic-concurrency check.
    expect(() => validateExactToolArguments(tool(), {
      mode: 'update',
      automation_id: AUTOMATION_ID,
      expected_revision: 1,
      patch: { id: OTHER_ID, name: 'Hijack' },
    })).toThrow('Invalid arguments for tool');
    expect(() => decodeAutomationToolInput({
      mode: 'update',
      automation_id: AUTOMATION_ID,
      expected_revision: 1,
      patch: { id: OTHER_ID, name: 'Hijack' },
    })).toThrow('automation_update.patch contains unknown fields: id');
    expect(() => decodeAutomationToolInput({
      mode: 'update',
      automation_id: AUTOMATION_ID,
      expected_revision: 1,
      patch: { expectedRevision: 99, name: 'Hijack' },
    })).toThrow('automation_update.patch contains unknown fields: expectedRevision');
  });

  test('rejects malformed identities and unknown fields before the service sees them', () => {
    expect(() => decodeAutomationToolInput({ mode: 'view', automation_id: 'not-a-uuid' }))
      .toThrow('automation_update.automation_id must be a UUIDv7');
    expect(() => decodeAutomationToolInput({ mode: 'delete', automation_id: AUTOMATION_ID, expected_revision: 0 }))
      .toThrow('automation_update.expected_revision');
    expect(() => decodeAutomationToolInput({ mode: 'view', nope: 1 }))
      .toThrow('automation_update contains unknown fields: nope');
    expect(() => decodeAutomationToolInput({ mode: 'sleep' }))
      .toThrow('automation_update.mode must be one of: create, update, view, delete');
    expect(() => decodeAutomationToolInput('view')).toThrow('automation_update must be an object');
  });

  test('dispatches every mode to the revisioned host service', async () => {
    const calls: string[] = [];
    const automation = { id: AUTOMATION_ID, revision: 1 };
    const service = {
      create: async (input: AutomationCreateInput) => {
        calls.push(`create:${input.name}`);
        return automation;
      },
      update: async (input: AutomationUpdateInput) => {
        calls.push(`update:${input.id}:${input.expectedRevision}:${JSON.stringify(input.name ?? null)}`);
        return automation;
      },
      request: async (method: string, input: unknown) => {
        calls.push(`${method}:${JSON.stringify(input)}`);
        return { data: [] };
      },
    } as unknown as AutomationService;
    const automationTool = createAutomationTool(service);

    const created = await automationTool.execute('item-1', { mode: 'create', definition: DEFINITION });
    expect(created.details).toMatchObject({ data: { automation: { id: AUTOMATION_ID } } });
    await automationTool.execute('item-2', {
      mode: 'update',
      automation_id: AUTOMATION_ID,
      expected_revision: 3,
      patch: { name: 'Renamed' },
    });
    await automationTool.execute('item-3', { mode: 'view' });
    await automationTool.execute('item-4', { mode: 'view', automation_id: AUTOMATION_ID });
    await automationTool.execute('item-5', {
      mode: 'delete',
      automation_id: AUTOMATION_ID,
      expected_revision: 5,
    });

    expect(calls).toEqual([
      'create:Morning digest',
      `update:${AUTOMATION_ID}:3:"Renamed"`,
      'list:{}',
      `read:{"id":"${AUTOMATION_ID}"}`,
      `delete:{"id":"${AUTOMATION_ID}","expectedRevision":5}`,
    ]);
  });

  test('refuses to run once the Turn is aborted', async () => {
    const automationTool = createAutomationTool({
      create: async () => { throw new Error('An aborted Turn must not reach the service.'); },
    } as unknown as AutomationService);
    await expect(automationTool.execute(
      'item-6',
      { mode: 'create', definition: DEFINITION },
      AbortSignal.abort(),
    )).rejects.toThrow('Automation update was interrupted');
  });
});

function tool() {
  return createAutomationTool({} as unknown as AutomationService);
}
