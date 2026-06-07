import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';
import { parseDateSchedule } from '../../src/core/dateSchedule';
import { COMMAND_SCHEDULE_FIELD } from '../../src/core/types';

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
