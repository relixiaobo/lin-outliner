import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';
import { parseDateSchedule } from '../../src/core/dateSchedule';
import { COMMAND_SCHEDULE_FIELD } from '../../src/core/types';
import { COMMAND_SCHEDULE_FIELD_ID } from '../../src/core/systemFields';

function mustFocus<T extends { focus?: { nodeId: string } }>(outcome: T) {
  expect(outcome.focus).toBeDefined();
  return outcome.focus!.nodeId;
}

// Resolve a node from the projection, narrowed to the `command` variant so the
// command-only fields (`commandSchedule` / `sysLastRunAt`) typecheck.
function commandNode(core: Core, id: string) {
  const node = core.projection().nodes.find((entry) => entry.id === id);
  if (!node || node.type !== 'command') throw new Error(`not a command node: ${id}`);
  return node;
}

describe('Core.setCommandNode', () => {
  test('converts a plain row into a command node and seeds the protected schedule field', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createNode(libraryId, null, 'Summarize my feeds every morning'));

    core.setCommandNode(id);

    const node = commandNode(core, id);
    expect(node.protectedFields).toContain(COMMAND_SCHEDULE_FIELD);
    // The brief stays in the node's text content — the prose is the program.
    expect(node.content.text).toBe('Summarize my feeds every morning');
  });

  test('is idempotent and never duplicates the protected field', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createNode(libraryId, null, 'cmd'));

    core.setCommandNode(id);
    core.setCommandNode(id);

    const node = commandNode(core, id);
    expect(node.protectedFields?.filter((field) => field === COMMAND_SCHEDULE_FIELD)).toHaveLength(1);
  });

  // The Schedule config row is node-native: a real `fieldEntry` child pointing at
  // the built-in system field, seeded on conversion.
  function commandFieldDefIds(core: Core, nodeId: string): string[] {
    const node = commandNode(core, nodeId);
    const byId = new Map(core.projection().nodes.map((entry) => [entry.id, entry]));
    return node.children
      .map((childId) => byId.get(childId))
      .filter((child) => child?.type === 'fieldEntry')
      .map((child) => (child!.type === 'fieldEntry' ? child!.fieldDefId : ''));
  }

  test('seeds the Schedule config field row', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createNode(libraryId, null, 'cmd'));

    core.setCommandNode(id);

    expect(commandFieldDefIds(core, id)).toEqual([COMMAND_SCHEDULE_FIELD_ID]);
  });

  test('seeding the config row is idempotent across re-conversion', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createNode(libraryId, null, 'cmd'));

    core.setCommandNode(id);
    core.setCommandNode(id);

    // No duplicate Schedule row on a second conversion.
    expect(commandFieldDefIds(core, id)).toEqual([COMMAND_SCHEDULE_FIELD_ID]);
  });

  test('refuses to convert a non-plain node (e.g. a code block)', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createNode(libraryId, null, 'code'));
    core.setCodeBlock(id);
    expect(() => core.setCommandNode(id)).toThrow();
  });
});

describe('Core.setCommandSchedule (the bright line)', () => {
  test('the user can arm a schedule; it is canonicalized and re-arms the watermark', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createNode(libraryId, null, 'cmd'));
    core.setCommandNode(id);

    const before = Date.now();
    core.setCommandSchedule(id, '2026-06-09T09:00 RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'user');

    const node = commandNode(core, id);
    expect(node.commandSchedule).toBeDefined();
    const parsed = parseDateSchedule(node.commandSchedule!);
    expect(parsed?.recurrence?.frequency).toBe('weekly');
    expect(node.sysLastRunAt ?? 0).toBeGreaterThanOrEqual(before);
  });

  test('the agent / system cannot arm a schedule (rejected at the gateway)', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createNode(libraryId, null, 'cmd'));
    core.setCommandNode(id);

    expect(() => core.setCommandSchedule(id, '2026-06-09T09:00', 'agent')).toThrow();
    expect(() => core.setCommandSchedule(id, '2026-06-09T09:00', 'system')).toThrow();
    expect(commandNode(core, id).commandSchedule).toBeUndefined();
  });

  test('clearing the schedule makes it manual-only and leaves the watermark untouched', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createNode(libraryId, null, 'cmd'));
    core.setCommandNode(id);
    core.setCommandSchedule(id, '2026-06-09T09:00', 'user');
    const armed = commandNode(core, id).sysLastRunAt;
    expect(armed).toBeDefined();

    core.setCommandSchedule(id, '', 'user');

    const node = commandNode(core, id);
    expect(node.commandSchedule).toBeUndefined();
    expect(node.sysLastRunAt).toBe(armed);
  });

  test('rejects an invalid schedule string', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createNode(libraryId, null, 'cmd'));
    core.setCommandNode(id);
    expect(() => core.setCommandSchedule(id, 'not-a-date', 'user')).toThrow();
  });

  test('refuses to arm a node that is not a command node', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createNode(libraryId, null, 'plain'));
    expect(() => core.setCommandSchedule(id, '2026-06-09T09:00', 'user')).toThrow();
  });
});

describe('Core.markCommandFired', () => {
  test('advances the system fire watermark (the system-managed write path)', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createNode(libraryId, null, 'cmd'));
    core.setCommandNode(id);

    core.markCommandFired(id, 1_750_000_000_000, 'system');

    expect(commandNode(core, id).sysLastRunAt).toBe(1_750_000_000_000);
  });

  test('is forward-only — an older fire timestamp never regresses the watermark', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createNode(libraryId, null, 'cmd'));
    core.setCommandNode(id);

    core.markCommandFired(id, 1_750_000_000_000, 'system');
    // A long run that captured an older sweep-start time must not move it back
    // (which would re-expose a covered occurrence / clobber a user re-arm).
    core.markCommandFired(id, 1_740_000_000_000, 'system');

    expect(commandNode(core, id).sysLastRunAt).toBe(1_750_000_000_000);
  });

  test('the agent cannot advance the watermark (symmetric to the schedule bright line)', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createNode(libraryId, null, 'cmd'));
    core.setCommandNode(id);

    // An agent push would let it suppress the user's schedule by jumping the
    // watermark far ahead; the gate rejects it. system/user are accepted.
    expect(() => core.markCommandFired(id, 1_750_000_000_000, 'agent')).toThrow();
    expect(commandNode(core, id).sysLastRunAt ?? 0).toBe(0);
    core.markCommandFired(id, 1_750_000_000_000, 'system');
    expect(commandNode(core, id).sysLastRunAt).toBe(1_750_000_000_000);
  });

  test('refuses to mark a node that is not a command node', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createNode(libraryId, null, 'plain'));
    expect(() => core.markCommandFired(id, 1_750_000_000_000, 'system')).toThrow();
  });
});

describe('Core.markCommandAttempted (at-most-once marker)', () => {
  test('advances the last-attempt marker, forward-only', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createNode(libraryId, null, 'cmd'));
    core.setCommandNode(id);

    core.markCommandAttempted(id, 1_750_000_000_000, 'system');
    expect(commandNode(core, id).sysLastAttemptAt).toBe(1_750_000_000_000);
    // Forward-only — an older attempt never regresses it.
    core.markCommandAttempted(id, 1_740_000_000_000, 'system');
    expect(commandNode(core, id).sysLastAttemptAt).toBe(1_750_000_000_000);
  });

  test('the agent cannot advance the attempt marker', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createNode(libraryId, null, 'cmd'));
    core.setCommandNode(id);

    expect(() => core.markCommandAttempted(id, 1_750_000_000_000, 'agent')).toThrow();
    expect(commandNode(core, id).sysLastAttemptAt ?? 0).toBe(0);
  });

  test('refuses to mark a node that is not a command node', () => {
    const core = Core.new();
    const libraryId = core.projection().libraryId;
    const id = mustFocus(core.createNode(libraryId, null, 'plain'));
    expect(() => core.markCommandAttempted(id, 1_750_000_000_000, 'system')).toThrow();
  });
});
